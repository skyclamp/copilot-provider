/**
 * Generate .device file with random device IDs for Copilot API headers.
 *
 * Usage: bun run scripts/setup-device.ts
 */

import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEVICE_FILE = resolve(import.meta.dir, '../.device');

const device = {
  vscodeSessionId: randomUUID(),
  vscodeMachineId: randomUUID(),
  editorDeviceId: randomUUID(),
};

await Bun.write(DEVICE_FILE, JSON.stringify(device, null, 2) + '\n');

console.log('✓ Device info saved to .device');
console.log(JSON.stringify(device, null, 2));
