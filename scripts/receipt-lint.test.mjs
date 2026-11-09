import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintReceipt } from './receipt-lint.mjs';
import { runLogged } from './goal.mjs';

const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-lint-')));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@t');
git('config', 'user.name', 't');
fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
git('add', '-A');
git('commit', '-qm', 'init');
const head = git('rev-parse', 'HEAD');
const { log } = runLogged(dir, 'echo ok');
const receipt = (validation) => `done\n\`\`\`json\n${JSON.stringify({
  ticket: '01', conclusion: 'completed', ticket_base: head, head, changed_files: [],
  criteria: [{ criterion: 'works', result: 'pass', evidence: 'echo ok' }], validation,
  review: { cited_fixed: 0, leads: [] }, not_validated: [], blockers: [], external_effects: [], worktree_clean: true,
})}\n\`\`\``;
const ok = (entry) => receipt([{ command: 'echo ok', exit: 0, summary: 'ok', log: entry }]);

test('a receipt the gate would pass is clean', () => {
  assert.deepEqual(lintReceipt(ok(log), dir), []);
});

test('everything the gate refuses is reported: truncated, stale or missing logs, no log at all, bad JSON', () => {
  assert.match(lintReceipt(ok({ ...log, sha256: log.sha256.slice(0, 40) }), dir).join(), /not a sha256/);
  assert.match(lintReceipt(ok({ ...log, sha256: '0'.repeat(64) }), dir).join(), /does not match its sha256/);
  assert.match(lintReceipt(ok({ ...log, path: path.join(path.dirname(log.path), 'gone.log') }), dir).join(), /does not exist/);
  assert.match(lintReceipt(receipt([{ command: 'echo ok', exit: 0, summary: 'ok' }]), dir).join(), /has no log/, 'a validation with no log');
  assert.match(lintReceipt(ok({ ...log, path: path.join(dir, 'a.txt') }), dir).join(), /not a goal\.mjs run log of this repository/);
  assert.match(lintReceipt('{"validation": [', dir).join(), /not valid JSON/);
});

test('the CLI checks against the worktree it runs in, exiting 1 on a bad receipt and 0 on a clean one', () => {
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'receipt-lint.mjs');
  const file = path.join(os.tmpdir(), `receipt-lint-${process.pid}.md`);
  try {
    fs.writeFileSync(file, ok(log));
    assert.equal(spawnSync(process.execPath, [bin, file], { cwd: dir }).status, 0);
    fs.writeFileSync(file, ok({ ...log, sha256: log.sha256.slice(1) }));
    assert.equal(spawnSync(process.execPath, [bin, file], { cwd: dir }).status, 1);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('run through a linked path it still lints: silence with exit 0 read as a pass', () => {
  const link = path.join(dir, 'lint-link.mjs');
  fs.symlinkSync(fileURLToPath(new URL('./receipt-lint.mjs', import.meta.url)), link);
  const bad = path.join(dir, 'empty-receipt.json');
  fs.writeFileSync(bad, '{}');
  const r = spawnSync(process.execPath, [link, bad], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.notEqual(r.stderr, '');
});
