#!/usr/bin/env node
// usage: receipt-lint.mjs <receipt file>   (run from the ticket worktree)
// Run before returning a ticket receipt: it runs the receipt gate's own check (goal.mjs checkReceipt) against the worktree
// this process runs in, so a receipt it passes is one the gate's shape, git and log checks pass too. Only what the gate
// learns at landing (the dispatch base, the ticket's criteria) is not checked here.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { receiptJson, checkReceipt } from './goal.mjs';

/** Problems the receipt gate would find in a receipt's text, checked against `worktree`; [] when it is clean. */
export function lintReceipt(text, worktree = process.cwd()) {
  const receipt = receiptJson(text);
  if (receipt === null || typeof receipt !== 'object') return ['receipt is not valid JSON (unclosed object, trailing text or a stray fence?)'];
  return checkReceipt({ text, worktree }).problems;
}

// realpath: run through a linked path, the plain comparison never matched and the lint printed nothing and exited 0.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  if (process.argv.length !== 3 || !fs.existsSync(process.argv[2])) { console.error('usage: receipt-lint.mjs <receipt file>   (from the ticket worktree)'); process.exit(2); }
  const problems = lintReceipt(fs.readFileSync(process.argv[2], 'utf8'));
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log('receipt ok');
}
