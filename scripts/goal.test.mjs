import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STAGES, init, next, stop, setRegistry, slugFor, ensureControl, frontier, take, setStatus, claimsBreach, withLock, commit, controlDir } from './goal.mjs';

const GOAL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'goal.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A repo with the control plane as a linked orphan worktree, as BOOTSTRAP.md creates it.
function bareRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-test-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  return repo;
}

function repoWithControl() {
  const repo = bareRepo();
  return { repo, control: ensureControl(repo) };
}

function todo(ticked) {
  return STAGES.map((s) => `- [${ticked.includes(s.id) ? 'x' : ' '}] ${s.id} ${s.name}`).join('\n');
}

function ticket(status, blockedBy, claims) {
  return `# t\n\n**Status:** ${status}\n**Blocked by:** ${blockedBy}\n**Claims:** ${claims}\n`;
}

test('controlDir resolves the same control plane from any worktree', () => {
  const { repo, control } = repoWithControl();
  assert.equal(fs.realpathSync(controlDir(repo)), fs.realpathSync(control));
  assert.equal(fs.realpathSync(controlDir(control)), fs.realpathSync(control));
});

test('next starts at stage 00 when the run does not exist', () => {
  const { control } = repoWithControl();
  assert.equal(next(control, 'x').stage, '00');
});

test('next resumes at the first unticked stage', () => {
  const { control } = repoWithControl();
  write(path.join(control, 'runs/x/todo.md'), todo(['00', '0', '0a', '0b', '0c', '0d']));
  write(path.join(control, 'runs/x/ledger.md'), 'NOW');
  const result = next(control, 'x');
  assert.equal(result.stage, '1');
  assert.equal(result.phase, 'PLAN.md');
});

test('next distrusts a ticked stage whose artifact is missing', () => {
  const { control } = repoWithControl();
  write(path.join(control, 'runs/x/todo.md'), todo(STAGES.slice(0, 12).map((s) => s.id)));
  write(path.join(control, 'runs/x/ledger.md'), 'NOW');
  write(path.join(control, 'runs/x/findings.md'), 'R1');
  const result = next(control, 'x');
  assert.equal(result.stage, '5');
  assert.match(result.reason, /spec\.md is missing/);
});

test('next reports done only when every stage and artifact is present', () => {
  const { control } = repoWithControl();
  write(path.join(control, 'runs/x/todo.md'), todo(STAGES.map((s) => s.id)));
  for (const f of ['ledger.md', 'findings.md', 'spec.md', 'final-verdict.json', 'retro.md']) write(path.join(control, 'runs/x', f), 'x');
  assert.equal(next(control, 'x').done, true);
});

test('next honours STOP and rejects a todo.md missing stage lines', () => {
  const { control } = repoWithControl();
  write(path.join(control, 'runs/x/todo.md'), '- [x] 00 wiring and ask-matt - [x] 0 register');
  assert.equal(next(control, 'x').malformed, true);
  write(path.join(control, 'runs/x/STOP'), '');
  assert.equal(next(control, 'x').stop, true);
});

test('frontier: ready tickets whose blockers are done, malformed tickets, claim overlaps', () => {
  const { control } = repoWithControl();
  const issues = path.join(control, 'tracker/f/issues');
  write(path.join(issues, '01-a.md'), ticket('done', 'None', 'exclusive: src/a.ts'));
  write(path.join(issues, '02-b.md'), ticket('ready-for-agent', '01', 'exclusive: src/b/ ; shared-regenerate: package-lock.json'));
  write(path.join(issues, '03-c.md'), ticket('ready-for-agent', 'None', 'exclusive: src/b/c.ts'));
  write(path.join(issues, '04-d.md'), ticket('blocked', '02', 'exclusive: src/b/d.ts'));
  let result = frontier(control, 'f');
  assert.deepEqual(result.malformed, []);
  assert.deepEqual(result.frontier, ['02', '03']);
  // 02 and 03 overlap and neither depends on the other; 04 depends on 02, so it is ordered.
  assert.deepEqual(result.conflicts, [{ tickets: ['02', '03'], claims: ['src/b/', 'src/b/c.ts'] }]);

  write(path.join(issues, '05-e.md'), '# no grammar\n');
  result = frontier(control, 'f');
  assert.equal(result.malformed[0].id, '05');
  assert.deepEqual(result.frontier, []);
});

test('claims: unclaimed and guarded touches are breaches, shared-regenerate is not', () => {
  const text = ticket('in-flight', 'None', 'exclusive: src/a.ts, lib/ ; shared-regenerate: package-lock.json ; guarded: .github/**');
  assert.deepEqual(claimsBreach(text, ['src/a.ts', 'lib/x/y.ts', 'package-lock.json']), { unclaimed: [], guarded: [] });
  assert.deepEqual(claimsBreach(text, ['src/other.ts', '.github/workflows/ci.yml']), { unclaimed: ['src/other.ts'], guarded: ['.github/workflows/ci.yml'] });
});

test('withLock serializes holders and releases on throw', () => {
  const { repo } = repoWithControl();
  assert.throws(() => withLock(repo, 'control', () => { throw new Error('boom'); }), /boom/);
  assert.equal(withLock(repo, 'control', () => 42), 42);
});

test('withLock waits for a live holder in another process', async () => {
  const { repo } = repoWithControl();
  const holder = spawn(process.execPath, [GOAL, '--repo', repo, 'with-lock', 'frontier-f', '--', process.execPath, '-e', 'setTimeout(()=>{}, 600)']);
  await new Promise((r) => setTimeout(r, 200));
  const start = Date.now();
  withLock(repo, 'frontier-f', () => {});
  assert.ok(Date.now() - start >= 250, 'second holder did not wait');
  await new Promise((r) => holder.on('exit', r));
});

test('withLock breaks a stale lock whose holder is dead', () => {
  const { repo } = repoWithControl();
  const lock = path.join(repo, '.git/goal-locks/control');
  fs.mkdirSync(lock, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(lock, 'pid'), dead);
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  assert.equal(withLock(repo, 'control', () => 'got it'), 'got it');
});

test('commit stages only the named files', () => {
  const { repo, control } = repoWithControl();
  write(path.join(control, 'runs/x/ledger.md'), 'mine');
  write(path.join(control, 'runs/y/ledger.md'), 'another agent, half written');
  commit(repo, '[x] ledger', ['runs/x/ledger.md']);
  assert.equal(git(control, 'show', '--name-only', '--format=', 'HEAD'), 'runs/x/ledger.md');
  assert.match(git(control, 'status', '--porcelain'), /runs\/y/);
});

test('CLI: next exits 1 on STOP, claims exits 1 on a breach', () => {
  const { repo, control } = repoWithControl();
  write(path.join(control, 'runs/x/STOP'), '');
  assert.equal(spawnSync(process.execPath, [GOAL, '--repo', repo, 'next', 'x']).status, 1);
  const t = path.join(control, 't.md');
  write(t, ticket('in-flight', 'None', 'exclusive: a.ts'));
  assert.equal(spawnSync(process.execPath, [GOAL, 'claims', t, 'a.ts']).status, 0);
  assert.equal(spawnSync(process.execPath, [GOAL, 'claims', t, 'b.ts']).status, 1);
});

test('take flips frontier tickets to in-flight once, and status commits the change', () => {
  const { repo, control } = repoWithControl();
  const issues = path.join(control, 'tracker/f/issues');
  write(path.join(issues, '01-a.md'), ticket('ready-for-agent', 'None', 'exclusive: a.ts'));
  write(path.join(issues, '02-b.md'), ticket('ready-for-agent', 'None', 'exclusive: b.ts'));
  write(path.join(issues, '03-c.md'), ticket('blocked', '01', 'exclusive: c.ts'));
  git(control, 'add', '-A'); git(control, 'commit', '-qm', 'tickets');
  assert.deepEqual(take(repo, 'f', 1), ['01']);
  assert.deepEqual(take(repo, 'f', 3), ['02']);
  assert.deepEqual(frontier(control, 'f').frontier, []);
  setStatus(repo, 'f', '01', 'done');
  assert.deepEqual(frontier(control, 'f').frontier, []);
  setStatus(repo, 'f', '03', 'ready-for-agent');
  assert.deepEqual(frontier(control, 'f').frontier, ['03']);
  assert.equal(git(control, 'status', '--porcelain'), '');
  assert.match(git(control, 'log', '-1', '--format=%s'), /ticket 03 → ready-for-agent/);
});

test('take refuses a tracker that fails the claims gate', () => {
  const { repo, control } = repoWithControl();
  const issues = path.join(control, 'tracker/f/issues');
  write(path.join(issues, '01-a.md'), ticket('ready-for-agent', 'None', 'exclusive: src/'));
  write(path.join(issues, '02-b.md'), ticket('ready-for-agent', 'None', 'exclusive: src/b.ts'));
  assert.throws(() => take(repo, 'f', 2), /claims gate/);
});

test('init writes a run that next can resume, commits it, and refuses to overwrite', () => {
  const { repo, control } = repoWithControl();
  init(repo, 'add-login', 'Add login');
  const result = next(control, 'add-login');
  assert.equal(result.malformed, undefined);
  assert.equal(result.stage, '00');
  assert.equal(git(control, 'status', '--porcelain'), '');
  assert.throws(() => init(repo, 'add-login', 'again'), /already exists/);
  assert.throws(() => init(repo, 'Bad Slug', 'x'), /bad slug/);
});

test('commit ignores files another agent staged', () => {
  const { repo, control } = repoWithControl();
  write(path.join(control, 'other.md'), 'staged by someone else');
  git(control, 'add', 'other.md');
  write(path.join(control, 'mine.md'), 'mine');
  commit(repo, 'mine', ['mine.md']);
  assert.equal(git(control, 'show', '--name-only', '--format=', 'HEAD'), 'mine.md');
  assert.equal(commit(repo, 'nothing new', ['mine.md']), 'nothing to commit');
});

test('ensureControl creates the orphan control worktree once and excludes .worktrees/', () => {
  const repo = bareRepo();
  const control = ensureControl(repo);
  assert.equal(git(control, 'symbolic-ref', '--short', 'HEAD'), 'goal/control');
  assert.equal(ensureControl(repo), control);
  assert.match(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8'), /^\.worktrees\/$/m);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('control-plane writes refuse to run without the control worktree', () => {
  const repo = bareRepo();
  const head = git(repo, 'rev-parse', 'HEAD');
  assert.throws(() => init(repo, 'x', 'X'), /no control plane/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('init registers the run with the next run_id; slug is stable and --new skips used slugs', () => {
  const { repo, control } = repoWithControl();
  assert.equal(slugFor(repo, 'Add login!  Now'), 'add-login-now');
  init(repo, 'add-login', 'Add login');
  init(repo, 'other', 'Other');
  const runs = JSON.parse(fs.readFileSync(path.join(control, 'runs.json'), 'utf8'));
  assert.deepEqual(runs.map((r) => [r.slug, r.run_id, r.status]), [['add-login', 1, 'bootstrapping'], ['other', 2, 'bootstrapping']]);
  assert.equal(slugFor(repo, 'Add login'), 'add-login');
  assert.equal(slugFor(repo, 'Add login', { fresh: true }), 'add-login-2');
  setRegistry(repo, 'add-login', 'done');
  assert.equal(JSON.parse(fs.readFileSync(path.join(control, 'runs.json'), 'utf8'))[0].status, 'done');
});

test('stop halts the loop and records why', () => {
  const { repo, control } = repoWithControl();
  init(repo, 'x', 'X');
  stop(repo, 'x', 'kun unreachable');
  assert.equal(next(control, 'x').stop, true);
  assert.match(fs.readFileSync(path.join(control, 'runs/x/STOP'), 'utf8'), /kun unreachable/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(control, 'runs.json'), 'utf8'))[0].status, 'stopped');
  assert.equal(git(control, 'status', '--porcelain'), '');
});

test('CLI exit codes: 2 for usage, 3 for runtime errors', () => {
  const { repo } = repoWithControl();
  assert.equal(spawnSync(process.execPath, [GOAL, '--repo', repo, 'take', 'f', 'x']).status, 2);
  assert.equal(spawnSync(process.execPath, [GOAL, '--repo', repo, 'nonsense']).status, 2);
  assert.equal(spawnSync(process.execPath, [GOAL, '--repo', repo, 'frontier', 'no-such-feature']).status, 3);
});

test('duplicate ticket numbers are malformed and status refuses to guess', () => {
  const { repo, control } = repoWithControl();
  const issues = path.join(control, 'tracker/f/issues');
  write(path.join(issues, '01-a.md'), ticket('ready-for-agent', 'None', 'exclusive: a.ts'));
  write(path.join(issues, '1-b.md'), ticket('ready-for-agent', 'None', 'exclusive: b.ts'));
  const result = frontier(control, 'f');
  assert.equal(result.malformed[0].id, '01');
  assert.deepEqual(result.frontier, []);
  assert.throws(() => setStatus(repo, 'f', '1', 'done'), /more than one file/);
});

test('a status line may carry a reason, and blockers match by number', () => {
  const { control } = repoWithControl();
  const issues = path.join(control, 'tracker/f/issues');
  write(path.join(issues, '03-a.md'), ticket('stuck', 'None', 'exclusive: a.ts'));
  write(path.join(issues, '04-b.md'), ticket('blocked: prerequisite 03 stuck', '3', 'exclusive: b.ts'));
  assert.deepEqual(frontier(control, 'f').malformed, []);
});

test('with-lock children can take the same lock without deadlocking', () => {
  const { repo, control } = repoWithControl();
  write(path.join(control, 'k.md'), 'k');
  const r = spawnSync(process.execPath, [GOAL, '--repo', repo, 'with-lock', 'control', '--', process.execPath, GOAL, '--repo', repo, 'commit', '-m', 'k', 'k.md'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(control, 'log', '-1', '--format=%s'), 'k');
});

test('commit accepts a path relative to cwd that lands in the control worktree', () => {
  const { repo, control } = repoWithControl();
  write(path.join(control, 'from-cwd.md'), 'x');
  const r = spawnSync(process.execPath, [GOAL, 'commit', '-m', 'cwd path', '.worktrees/control/from-cwd.md'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(control, 'show', '--name-only', '--format=', 'HEAD'), 'from-cwd.md');
});

test('take on a tracker that fails the claims gate exits 1', () => {
  const { repo, control } = repoWithControl();
  const issues = path.join(control, 'tracker/f/issues');
  write(path.join(issues, '01-a.md'), ticket('ready-for-agent', 'None', 'exclusive: src/'));
  write(path.join(issues, '02-b.md'), ticket('ready-for-agent', 'None', 'exclusive: src/b.ts'));
  assert.equal(spawnSync(process.execPath, [GOAL, '--repo', repo, 'take', 'f', '2']).status, 1);
});
