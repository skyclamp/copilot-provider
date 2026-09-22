type OutputItem = { id?: string };
type ResponseEvent = {
  type: string;
  output_index?: number;
  item_id?: string;
  item?: OutputItem;
  response?: { output?: OutputItem[] };
};

export function stabilizeResponseStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const itemIds = new Map<number, string>();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineParts: string[] = [];
  let eventLines: string[] = [];
  let data: string[] = [];
  let pendingCR = false;

  function normalize(index: number | undefined, id: string | undefined): string | undefined {
    if (index === undefined || id === undefined) return id;
    if (!itemIds.has(index)) itemIds.set(index, id);
    return itemIds.get(index)!;
  }

  function rewriteEvent(): string {
    const raw = eventLines.join('');
    const payload = data.join('\n');
    if (!payload || payload === '[DONE]') return raw;
    const event: ResponseEvent = JSON.parse(payload);
    let changed = false;

    function normalizeItem(index: number | undefined, item: OutputItem) {
      const id = normalize(index, item.id);
      if (id !== item.id) {
        item.id = id;
        changed = true;
      }
    }

    if (event.type.startsWith('response.')) {
      if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
        if (event.item) normalizeItem(event.output_index, event.item);
      }
      const id = normalize(event.output_index, event.item_id);
      if (id !== event.item_id) {
        event.item_id = id;
        changed = true;
      }
    }
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
      event.response?.output?.forEach((item, index) => normalizeItem(index, item));
    }
    if (!changed) return raw;

    // Keep SSE metadata and comments; replace the data field only once.
    let emittedData = false;
    return eventLines.map(line => {
      if (!line.startsWith('data:') && !/^data(?:\r\n|\r|\n)$/.test(line)) return line;
      if (emittedData) return '';
      emittedData = true;
      const newline = line.endsWith('\r\n') ? '\r\n' : line.slice(-1);
      return `data: ${JSON.stringify(event)}${newline}`;
    }).join('');
  }

  function finishLine(newline: string, controller: TransformStreamDefaultController<Uint8Array>) {
    const line = lineParts.join('');
    lineParts = [];
    eventLines.push(line + newline);
    if (!line) {
      controller.enqueue(encoder.encode(rewriteEvent()));
      eventLines = [];
      data = [];
    } else if (line === 'data' || line.startsWith('data:')) {
      const value = line.slice(5);
      data.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }

  // Adapted from openai-python's _SSELineDecoder / SSEDecoder: handle
  // CR, LF and CRLF across chunks, then join data lines at an empty line.
  function feed(text: string, controller: TransformStreamDefaultController<Uint8Array>) {
    if (!text) return;
    let start = 0;
    if (pendingCR) {
      const hasLF = text.startsWith('\n');
      finishLine(hasLF ? '\r\n' : '\r', controller);
      start = hasLF ? 1 : 0;
      pendingCR = false;
    }
    const endings = /\r\n|[\r\n]/g;
    endings.lastIndex = start;
    for (let match; (match = endings.exec(text));) {
      lineParts.push(text.slice(start, match.index));
      start = endings.lastIndex;
      if (match[0] === '\r' && start === text.length) {
        pendingCR = true;
      } else {
        finishLine(match[0], controller);
      }
    }
    if (start < text.length) lineParts.push(text.slice(start));
  }

  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      feed(decoder.decode(chunk, { stream: true }), controller);
    },
    flush(controller) {
      feed(decoder.decode(), controller);
      if (pendingCR) finishLine('\r', controller);
      // Preserve an unterminated upstream tail without inventing an SSE event.
      const tail = eventLines.join('') + lineParts.join('');
      if (tail) controller.enqueue(encoder.encode(tail));
    },
  }));
}
