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

test('stage progress moves only through goal.mjs tick: no phase doc hand-ticks a stage or moves the registry forward', () => {
  for (const name of PHASE_DOCS) {
    const text = doc(name);
    assert.doesNotMatch(text, /goal\.mjs registry <slug> (planning|specced|ticketed|building|reviewing|done)\b/, `${name} moves the registry by hand`);
    assert.doesNotMatch(text, /\btick `\d/, `${name} hand-ticks a stage`);
  }
  assert.match(doc('CLOSE.md'), /goal\.mjs tick <slug> 10`: one commit ticks 10, sets NOW to `stage: done` and moves the registry to `done`/);
  assert.match(doc('CORE.md'), /a stage is finished only by `goal\.mjs tick <slug> <id>`/);
});

test('SKILL.md makes the stage next names binding and forbids repo work before init', () => {
  const skill = doc('SKILL.md');
  assert.match(skill, /The stage `next` names is the only work this invocation may do\. Until `init` has registered the run, touch nothing in the repo/);
  assert.match(skill, /never worked around/);
});

test('CONTROL.md documents the harness guard and SKILL.md forbids routing around it', () => {
  assert.match(doc('CONTROL.md'), /`scripts\/to-auto-guard\.mjs` \(hooks `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`/);
  assert.match(doc('SKILL.md'), /denied by `to-auto-guard` is this rule enforced/);
});

// Rules belong in goal.mjs refusals and one-line prose; a doc past its cap is an incident diary again (tasks/design-flaws.md DF3).
const CAPS = {
  'to-auto/SKILL.md': 9_000,
  'to-auto/references/build-dispatch.md': 6_000,
  'to-auto/references/run-budget.md': 3_500,
  'to-auto/references/grilling-rounds.md': 3_000,
};
const PER_DOC = 25_000;
const ALL_DOCS = 165_000;

test('every rule doc stays under its size cap, and the to-auto docs together under theirs', () => {
  const size = (rel) => fs.statSync(path.join(ROOT, rel)).size;
  for (const [rel, cap] of Object.entries(CAPS)) assert.ok(size(rel) <= cap, `${rel} is ${size(rel)} bytes, cap ${cap}`);
  const docs = [...PHASE_DOCS.map((f) => `to-auto/${f}`), ...fs.readdirSync(path.join(ROOT, 'to-auto', 'references')).map((f) => `to-auto/references/${f}`)];
  for (const rel of docs) assert.ok(size(rel) <= PER_DOC, `${rel} is ${size(rel)} bytes, cap ${PER_DOC}`);
  const total = docs.reduce((sum, rel) => sum + size(rel), 0);
  assert.ok(total <= ALL_DOCS, `the to-auto docs are ${total} bytes, cap ${ALL_DOCS}`);
});

test('no doc tells the orchestrator to write the verdict or a landing script by hand', () => {
  assert.match(doc('CLOSE.md'), /`node ROOT\/scripts\/goal\.mjs verdict <slug>` writes `final-verdict\.json`/);
  assert.match(doc('BUILD.md'), /`node ROOT\/scripts\/goal\.mjs merge <feature> <NN>/);
  for (const name of PHASE_DOCS) {
    assert.doesNotMatch(doc(name), /Write the verdict to/, `${name} has the orchestrator type the verdict`);
    assert.doesNotMatch(doc(name), /with-lock integration -- <merge script>/, `${name} has the orchestrator write a merge script`);
  }
});

// A run read the owner's "merge all to main" as lifting the owner's separate review of two
// changes "unless the owner objects"; only the project's own merge rule stopped it.
test('CORE.md says owner words grant only what they name, and every citation of a core rule names CORE.md', () => {
  assert.ok(doc('CORE.md').includes('Either grants only what it names: a blanket instruction ("merge all") lifts no hold the owner set (an owner-only merge, a separate review), and silence grants nothing, so no plan reads "unless the owner objects".'));
  const dangling = PHASE_DOCS.filter((f) => doc(f).includes('SKILL.md § Rules,'));
  assert.deepEqual(dangling, [], 'SKILL.md § Rules only points at CORE.md; it holds no Autonomous or Redaction rule');
});
