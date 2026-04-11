/**
 * Generate .device file with random device IDs for Copilot API headers.
 *
 * Usage: bun run scripts/setup-device.js
 */

import { dirname, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEVICE_FILE = resolve(SCRIPT_DIR, '../.device');

const device = {
  vscodeSessionId: randomUUID(),
  vscodeMachineId: randomUUID(),
  editorDeviceId: randomUUID(),
};

await writeFile(DEVICE_FILE, JSON.stringify(device, null, 2) + '\n');

console.log('✓ Device info saved to .device');
console.log(JSON.stringify(device, null, 2));
