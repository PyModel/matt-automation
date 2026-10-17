import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintReceipt } from './receipt-lint.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-lint-'));
const log = path.join(dir, 'a.log');
fs.writeFileSync(log, 'output\n');
const sha = createHash('sha256').update('output\n').digest('hex');
const receipt = (entry) => `done\n\`\`\`json\n${JSON.stringify({ validation: [{ command: 'x', exit: 0, log: entry }] })}\n\`\`\``;

test('a receipt whose log hashes match is clean', () => {
  assert.deepEqual(lintReceipt(receipt({ path: log, sha256: sha })), []);
});

test('truncated, stale, missing and malformed receipts are reported', () => {
  assert.match(lintReceipt(receipt({ path: log, sha256: sha.slice(0, 40) }))[0], /64 hex/);
  assert.match(lintReceipt(receipt({ path: log, sha256: '0'.repeat(64) }))[0], /does not match/);
  assert.match(lintReceipt(receipt({ path: path.join(dir, 'gone.log'), sha256: sha }))[0], /does not exist/);
  assert.match(lintReceipt('{"validation": [').join(), /not valid JSON/);
});

test('the CLI exits 1 on a bad receipt and 0 on a clean one', () => {
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'receipt-lint.mjs');
  const file = path.join(dir, 'r.md');
  fs.writeFileSync(file, receipt({ path: log, sha256: sha }));
  assert.equal(spawnSync(process.execPath, [bin, file]).status, 0);
  fs.writeFileSync(file, receipt({ path: log, sha256: sha.slice(1) }));
  assert.equal(spawnSync(process.execPath, [bin, file]).status, 1);
});
