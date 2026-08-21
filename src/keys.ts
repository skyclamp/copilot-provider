import keys from './keys.json' with { type: 'json' };

type KeysFile = { claude: string[]; openai: string[] };
const keysTyped = keys as KeysFile;

const KEY_TO_ID = new Map<string, string>();
for (const [i, key] of keysTyped.claude.entries()) {
  KEY_TO_ID.set(key, `claude-${String(i + 1).padStart(2, '0')}`);
}
for (const [i, key] of keysTyped.openai.entries()) {
  KEY_TO_ID.set(key, `openai-${String(i + 1).padStart(2, '0')}`);
}

export function resolveKeyId(key: string | null | undefined): string | null {
  if (!key) return null;
  return KEY_TO_ID.get(key) ?? null;
}
