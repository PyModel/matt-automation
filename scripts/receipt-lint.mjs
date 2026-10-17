#!/usr/bin/env node
// usage: receipt-lint.mjs <receipt file>
// Run before returning a ticket receipt: it must parse as JSON, and every { path, sha256 } log entry must name a file
// whose sha256 is the one cited (a truncated, stale or hand-typed hash is a refused receipt and a wasted round trip).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { receiptJson } from './goal.mjs';

/** Problems found in a receipt's text; [] when it is clean. */
export function lintReceipt(text) {
  const receipt = receiptJson(text);
  if (receipt === null || typeof receipt !== 'object') return ['receipt is not valid JSON (unclosed object, trailing text or a stray fence?)'];
  const problems = [];
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (node === null || typeof node !== 'object') return;
    if (typeof node.path === 'string' && 'sha256' in node) {
      if (typeof node.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(node.sha256)) problems.push(`${where}: sha256 is not 64 hex characters (truncated?): ${JSON.stringify(node.sha256)}`);
      else if (!fs.existsSync(node.path)) problems.push(`${where}: ${node.path} does not exist`);
      else if (createHash('sha256').update(fs.readFileSync(node.path)).digest('hex') !== node.sha256) problems.push(`${where}: ${node.path} does not match its sha256 (changed after the run, or copied wrong)`);
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
  };
  walk(receipt, 'receipt');
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) { console.error('usage: receipt-lint.mjs <receipt file>'); process.exit(2); }
  const problems = lintReceipt(fs.readFileSync(process.argv[2], 'utf8'));
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log('receipt ok');
}
