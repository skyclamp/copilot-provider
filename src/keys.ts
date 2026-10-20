import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type KeysFile = { claude: string[]; openai: string[] };

const KEYS_PATH = resolve(process.env.KEYS_FILE || 'keys.json');

function loadKeys(): Map<string, string> {
  const keyToId = new Map<string, string>();
  if (process.env.DISABLE_CLIENT_AUTH === 'true') return keyToId;
  let keys: KeysFile;
  try {
    keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8')) as KeysFile;
  } catch (error) {
    throw new Error(`Cannot read client API keys from ${KEYS_PATH}. Run: npm run gen-keys`, { cause: error });
  }
  for (const [i, key] of keys.claude.entries()) {
    keyToId.set(key, `claude-${String(i + 1).padStart(2, '0')}`);
  }
  for (const [i, key] of keys.openai.entries()) {
    keyToId.set(key, `openai-${String(i + 1).padStart(2, '0')}`);
  }
  return keyToId;
}

const KEY_TO_ID = loadKeys();

export function resolveKeyId(key: string | null | undefined): string | null {
  if (!key) return null;
  return KEY_TO_ID.get(key) ?? null;
}
