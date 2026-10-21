#!/usr/bin/env node
/**
 * Generate random device IDs for Copilot API headers.
 * Prints env vars to stdout — paste them into your .env file.
 *
 * VSCODE_MACHINE_ID mirrors VS Code's machineId (sha256 hex of a MAC address);
 * EDITOR_DEVICE_ID mirrors devDeviceId (a UUID v4 from @vscode/deviceid).
 *
 * Usage: npm run setup-device
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Locally administered, unicast MAC so it can never collide with a real NIC.
const mac = randomBytes(6);
mac[0] = (mac[0] & 0xfc) | 0x02;
const macAddress = [...mac].map((b) => b.toString(16).padStart(2, '0')).join(':');

console.log('# Copilot device IDs (paste into .env)');
console.log(`VSCODE_MACHINE_ID=${createHash('sha256').update(macAddress, 'utf8').digest('hex')}`);
console.log(`EDITOR_DEVICE_ID=${randomUUID()}`);
