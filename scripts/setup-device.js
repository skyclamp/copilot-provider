/**
 * Generate random device IDs for Copilot API headers.
 * Prints env vars to stdout — paste them into your .env file.
 *
 * Usage: bun run scripts/setup-device.js
 */

import { randomUUID } from 'node:crypto';

console.log('# Copilot device IDs (paste into .env)');
console.log(`VSCODE_SESSION_ID=${randomUUID()}`);
console.log(`VSCODE_MACHINE_ID=${randomUUID()}`);
console.log(`EDITOR_DEVICE_ID=${randomUUID()}`);
