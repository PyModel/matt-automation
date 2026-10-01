import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './goal.mjs';

const doc = (name) => fs.readFileSync(path.join(ROOT, 'to-auto', name), 'utf8');
const PHASE_DOCS = fs.readdirSync(path.join(ROOT, 'to-auto')).filter((f) => f.endsWith('.md') && f !== 'CHANGELOG.md');

test('CORE.md says repo rules change how a stage runs, never whether it runs', () => {
  assert.ok(doc('CORE.md').includes('Repository rules may change how a stage runs, never whether it runs; an objective that does not fit → `goal.mjs stop <slug> "objective does not fit: …"`.'));
});

test('the backlog admission rule comes before init in BOOTSTRAP.md and before routing in FLOWS.md', () => {
  const boot = doc('BOOTSTRAP.md');
  const admission = boot.indexOf('**Admission, before `init`.**');
  assert.ok(admission > 0, 'BOOTSTRAP.md has the admission step');
  assert.ok(admission < boot.indexOf('goal.mjs init <slug>'), 'admission precedes init');
  assert.match(boot.slice(admission, boot.indexOf('\n', admission)), /fix all N issues.*bounded batches.*to-orc/);
  const flows = doc('FLOWS.md');
  assert.ok(flows.indexOf('## Admission') < flows.indexOf('## Routing tree'));
});

test('no phase doc tells a run to hand-type a run/ticket worktree or names a .worktrees/goal- layout', () => {
  for (const name of PHASE_DOCS) {
    const text = doc(name);
    assert.doesNotMatch(text, /\.worktrees\/goal-/, `${name} names a .worktrees/goal- path`);
    assert.doesNotMatch(text, /git worktree add -b goal\//, `${name} hand-types a run or ticket worktree`);
  }
  assert.match(doc('PIPELINE.md'), /goal\.mjs worktree get <slug> <NN>/);
});

test('stage 9 moves the registry to done before NOW says done', () => {
  const close = doc('CLOSE.md');
  assert.ok(close.indexOf('registry <slug> done`, rewrite NOW to `stage: done`') > 0);
});
