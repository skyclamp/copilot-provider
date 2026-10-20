type OutputItem = { id?: string };
type ResponseEvent = {
  type: string;
  output_index?: number;
  item_id?: string;
  item?: OutputItem;
  response?: { output?: OutputItem[] };
};

// A line plus its original terminator ('' for an unterminated tail at EOF).
// `continuation` marks an LF that completes a CR already emitted as a line.
type Line = { text: string; eol: string; continuation?: true };

type ServerSentEvent = { event: string | null; data: string; raw: string[] };

const LIFECYCLE_EVENTS = new Set([
  'response.created',
  'response.queued',
  'response.in_progress',
  'response.completed',
  'response.failed',
  'response.incomplete',
]);

// Port of openai-node's LineDecoder (src/internal/decoders/line.ts) over text,
// keeping each terminator so untouched events are forwarded byte-for-byte.
// Like the SDK, a trailing CR completes its line immediately and a following
// LF in the next chunk is consumed as its continuation.
class LineDecoder {
  #buffer = '';
  #skipLeadingLF = false;

  decode(text: string): Line[] {
    if (!text) return [];
    const lines: Line[] = [];
    if (this.#skipLeadingLF) {
      this.#skipLeadingLF = false;
      if (text.startsWith('\n')) {
        lines.push({ text: '', eol: '\n', continuation: true });
        text = text.slice(1);
      }
    }
    const endings = /\r\n|[\r\n]/g;
    const buffer = this.#buffer + text;
    let start = 0;
    for (let match; (match = endings.exec(buffer));) {
      lines.push({ text: buffer.slice(start, match.index), eol: match[0] });
      start = endings.lastIndex;
    }
    this.#buffer = buffer.slice(start);
    this.#skipLeadingLF = buffer.endsWith('\r') && start === buffer.length;
    return lines;
  }

  flush(): Line[] {
    this.#skipLeadingLF = false;
    if (!this.#buffer) return [];
    const line = { text: this.#buffer, eol: '' };
    this.#buffer = '';
    return [line];
  }
}

// Port of openai-node's SSEDecoder (src/core/streaming.ts). Unlike the SDK it
// also returns blocks without fields (comments, stray blank lines) so the
// proxy can forward them unchanged.
class SSEDecoder {
  #event: string | null = null;
  #data: string[] = [];
  #raw: string[] = [];

  decode(line: Line): { sse: ServerSentEvent | null; raw: string[] } | null {
    this.#raw.push(line.text + line.eol);
    if (line.text) {
      if (!line.text.startsWith(':')) {
        const colon = line.text.indexOf(':');
        const field = colon === -1 ? line.text : line.text.slice(0, colon);
        let value = colon === -1 ? '' : line.text.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') this.#event = value;
        else if (field === 'data') this.#data.push(value);
      }
      return null;
    }

    const sse = this.#event !== null || this.#data.length
      ? { event: this.#event, data: this.#data.join('\n'), raw: this.#raw }
      : null;
    const raw = this.#raw;
    this.#event = null;
    this.#data = [];
    this.#raw = [];
    return { sse, raw };
  }

  // Appends the LF of a CRLF split across chunks to the pending raw lines;
  // returns false when no event is pending and the LF should pass through.
  continueLine(): boolean {
    if (!this.#raw.length) return false;
    this.#raw[this.#raw.length - 1] += '\n';
    return true;
  }

  // Servers may omit the blank line ending the last event; like the SDK,
  // dispatch it at EOF, but without inventing a terminator.
  flush(): { sse: ServerSentEvent | null; raw: string[] } | null {
    return this.#raw.length ? this.decode({ text: '', eol: '' }) : null;
  }
}

export function stabilizeResponseStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const itemIds = new Map<number, string>();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const lineDecoder = new LineDecoder();
  const sseDecoder = new SSEDecoder();

  function normalize(index: number | undefined, id: string | undefined): string | undefined {
    if (index === undefined || id === undefined) return id;
    if (!itemIds.has(index)) itemIds.set(index, id);
    return itemIds.get(index)!;
  }

  function rewrite(sse: ServerSentEvent | null, raw: string[]): string {
    const original = raw.join('');
    if (!sse || !sse.data || sse.data === '[DONE]') return original;
    let event: ResponseEvent;
    try {
      event = JSON.parse(sse.data);
    } catch {
      return original;
    }
    if (typeof event?.type !== 'string' || !event.type.startsWith('response.')) return original;
    let changed = false;

    function normalizeItem(index: number | undefined, item: OutputItem) {
      const id = normalize(index, item.id);
      if (id !== item.id) {
        item.id = id;
        changed = true;
      }
    }

    // Same identity rules the SDK accumulator enforces: item-scoped events
    // must reference output[output_index].id, and lifecycle snapshots must
    // repeat the IDs of the items streamed at those indexes.
    if (LIFECYCLE_EVENTS.has(event.type)) {
      event.response?.output?.forEach((item, index) => normalizeItem(index, item));
    } else {
      if (event.item) normalizeItem(event.output_index, event.item);
      const id = normalize(event.output_index, event.item_id);
      if (id !== event.item_id) {
        event.item_id = id;
        changed = true;
      }
    }
    if (!changed) return original;

    // Keep SSE metadata and comments; replace the data field only once.
    let emittedData = false;
    return raw.map(line => {
      const text = line.replace(/(?:\r\n|\r|\n)$/, '');
      if (text !== 'data' && !text.startsWith('data:')) return line;
      if (emittedData) return '';
      emittedData = true;
      return `data: ${JSON.stringify(event)}${line.slice(text.length)}`;
    }).join('');
  }

  function feed(lines: Line[], controller: TransformStreamDefaultController<Uint8Array>) {
    for (const line of lines) {
      if (line.continuation) {
        if (!sseDecoder.continueLine()) controller.enqueue(encoder.encode(line.eol));
        continue;
      }
      const block = sseDecoder.decode(line);
      if (block) controller.enqueue(encoder.encode(rewrite(block.sse, block.raw)));
    }
  }

  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      feed(lineDecoder.decode(decoder.decode(chunk, { stream: true })), controller);
    },
    flush(controller) {
      feed(lineDecoder.decode(decoder.decode()), controller);
      feed(lineDecoder.flush(), controller);
      const pending = sseDecoder.flush();
      if (pending) controller.enqueue(encoder.encode(rewrite(pending.sse, pending.raw)));
    },
  }));
}
