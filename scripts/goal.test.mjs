import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STAGES, init, next, stop, resume, setRegistry, slugFor, ensureControl, frontier, take, setStatus, claimsBreach, checkReceipt, checkContract, amendClaims, event, withLock, breakStale, commit, controlDir } from './goal.mjs';

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

test('a breaker never deletes a lock that was re-taken after it judged the old one stale', () => {
  const { repo } = repoWithControl();
  const lock = path.join(repo, '.git/goal-locks/control');
  // Breaker B judged an old pid-less lock stale (pid -1); before it acts, A breaks that lock and
  // re-takes the name. B must leave A's fresh lock alone, pid-less mid-acquire or complete.
  fs.mkdirSync(lock, { recursive: true });
  breakStale(lock);
  assert.ok(fs.existsSync(lock), 'fresh pid-less lock was deleted');
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  breakStale(lock);
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid));
});

test('racing processes that all find one stale lock still hold it one at a time', async () => {
  const { repo } = repoWithControl();
  const lock = path.join(repo, '.git/goal-locks/race');
  fs.mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lock, old, old); // stale and pid-less
  const counter = path.join(repo, 'counter');
  fs.writeFileSync(counter, '0');
  const bump = `const fs=require('fs');const n=+fs.readFileSync(${JSON.stringify(counter)},'utf8');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);fs.writeFileSync(${JSON.stringify(counter)},String(n+1))`;
  const racers = Array.from({ length: 8 }, () => spawn(process.execPath, [GOAL, '--repo', repo, 'with-lock', 'race', '--', process.execPath, '-e', bump]));
  const codes = await Promise.all(racers.map((child) => new Promise((r) => child.on('exit', r))));
  assert.deepEqual(codes, Array(8).fill(0));
  assert.equal(fs.readFileSync(counter, 'utf8'), '8');
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

test('status and claim refuse a ticket with uncommitted hand edits, so no edit rides in under their message', () => {
  const { repo, control, read } = runWithTickets();
  const head = git(control, 'rev-parse', 'HEAD');
  const t02 = 'tracker/f/issues/02-b.md';
  const edited = `${read(t02)}- [ ] a criterion swapped in by hand\n`;
  fs.writeFileSync(path.join(control, t02), edited);
  assert.throws(() => setStatus(repo, 'f', '02', 'in-flight'), /uncommitted edits.*goal\.mjs commit/);
  assert.equal(read(t02), edited, 'the hand edit is left for its own commit');
  commit(repo, '[f] 02: swap criterion (why)', [t02]);
  setStatus(repo, 'f', '02', 'in-flight');
  assert.match(git(control, 'log', '-1', '--format=%s'), /ticket 02 → in-flight/);
  assert.equal(git(control, 'show', '--format=', '--numstat', 'HEAD').trim().split('\n').length, 1);

  const t03 = 'tracker/f/issues/03-c.md';
  write(path.join(control, t03), ticket('ready-for-agent', 'None', 'exclusive: src/c.ts'));
  assert.throws(() => setStatus(repo, 'f', '03', 'in-flight'), /uncommitted edits/, 'a never-committed ticket is refused too');

  fs.appendFileSync(path.join(control, 'runs/f/tickets/01.goal.md'), '- extra scope\n');
  const mid = git(control, 'rev-parse', 'HEAD');
  assert.throws(() => amendClaims(repo, 'f', '01', 'exclusive', ['src/z.ts'], 'forced'), /01\.goal\.md has uncommitted edits/);
  assert.equal(git(control, 'rev-parse', 'HEAD'), mid);
  assert.doesNotMatch(read('tracker/f/issues/01-a.md'), /src\/z\.ts/);
  assert.notEqual(head, mid);
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

test('event appends a clock-stamped, stage-tagged line to the ledger and commits it', () => {
  const { repo, control } = repoWithControl();
  init(repo, 'add-login', 'Add login');
  const before = new Date();
  event(repo, 'add-login', '0c', 'worktree ready');
  const lines = fs.readFileSync(path.join(control, 'runs/add-login/ledger.md'), 'utf8').trimEnd().split('\n');
  const m = lines.at(-1).match(/^- (\d\d):(\d\d) \[0c\] worktree ready$/);
  assert.ok(m, lines.at(-1));
  const stamped = Number(m[1]) * 60 + Number(m[2]);
  const now = new Date();
  assert.ok([before, now].some((d) => d.getHours() * 60 + d.getMinutes() === stamped));
  assert.equal(git(control, 'status', '--porcelain'), '');
  assert.match(git(control, 'log', '-1', '--format=%s'), /^\[add-login\] \[0c\] worktree ready$/);
  assert.throws(() => event(repo, 'nope', '1', 'x'), /no ledger/);
  assert.throws(() => event(repo, 'add-login', '1', 'two\nlines'), /one line/);
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
  const r = spawnSync(process.execPath, [GOAL, '--repo', repo, 'with-lock', 'control', '--', process.execPath, GOAL, '--repo', repo, 'commit', '-m', '[x] k', 'k.md'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(control, 'log', '-1', '--format=%s'), '[x] k');
});

test('commit accepts a path relative to cwd that lands in the control worktree', () => {
  const { repo, control } = repoWithControl();
  write(path.join(control, 'from-cwd.md'), 'x');
  const r = spawnSync(process.execPath, [GOAL, 'commit', '-m', '[x] cwd path', '.worktrees/control/from-cwd.md'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(control, 'show', '--name-only', '--format=', 'HEAD'), 'from-cwd.md');
});

test('commit from a run directory takes a control-relative path as control-relative', () => {
  const { repo, control } = repoWithControl();
  const run = path.join(control, 'runs/x');
  write(path.join(run, 'ledger.md'), 'x');
  const r = spawnSync(process.execPath, [GOAL, '--repo', repo, 'commit', '-m', '[x] from run dir', 'runs/x/ledger.md'], { cwd: run, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(control, 'show', '--name-only', '--format=', 'HEAD'), 'runs/x/ledger.md');
});

test('take on a tracker that fails the claims gate exits 1', () => {
  const { repo, control } = repoWithControl();
  const issues = path.join(control, 'tracker/f/issues');
  write(path.join(issues, '01-a.md'), ticket('ready-for-agent', 'None', 'exclusive: src/'));
  write(path.join(issues, '02-b.md'), ticket('ready-for-agent', 'None', 'exclusive: src/b.ts'));
  assert.equal(spawnSync(process.execPath, [GOAL, '--repo', repo, 'take', 'f', '2']).status, 1);
});

test('a stop before init can be resumed: resume → init → next starts at 00', () => {
  const { repo, control } = repoWithControl();
  stop(repo, 'x', 'defensive-design not installed');
  assert.equal(next(control, 'x').stop, true);
  resume(repo, 'x');
  assert.equal(next(control, 'x').stage, '00');
  init(repo, 'x', 'X');
  assert.equal(next(control, 'x').stage, '00');
  assert.equal(git(control, 'status', '--porcelain'), '');
});

test('resume after init restores the registry status the stop replaced', () => {
  const { repo, control } = repoWithControl();
  init(repo, 'x', 'X');
  setRegistry(repo, 'x', 'building');
  stop(repo, 'x', 'budget: wall-clock');
  resume(repo, 'x');
  assert.equal(JSON.parse(fs.readFileSync(path.join(control, 'runs.json'), 'utf8'))[0].status, 'building');
  assert.throws(() => resume(repo, 'x'), /not stopped/);
});

test('an unreadable blocker makes the ticket malformed instead of dropping the edge', () => {
  const { control } = repoWithControl();
  const issues = path.join(control, 'tracker/f/issues');
  write(path.join(issues, '01-a.md'), ticket('ready-for-agent', 't03', 'exclusive: a.ts'));
  const result = frontier(control, 'f');
  assert.match(result.malformed[0].problems.join(' '), /t03/);
  assert.deepEqual(result.frontier, []);
});

test('blockers in the to-tickets template form parse: None (…) and NN (reason)', () => {
  const { control } = repoWithControl();
  const issues = path.join(control, 'tracker/f/issues');
  write(path.join(issues, '01-a.md'), ticket('ready-for-agent', 'None (can start immediately)', 'exclusive: a.ts'));
  write(path.join(issues, '02-b.md'), ticket('ready-for-agent', '01 (logout helper, and resolver seam)', 'exclusive: b.ts'));
  write(path.join(issues, '03-c.md'), ticket('ready-for-agent', '01-a, 02 - shared handler', 'exclusive: c.ts'));
  const result = frontier(control, 'f');
  assert.deepEqual(result.malformed, []);
  assert.deepEqual(result.frontier, ['01']);
});

test('a claims path after ; says how to fix it', () => {
  const { control } = repoWithControl();
  write(path.join(control, 'tracker/f/issues/01-a.md'), ticket('ready-for-agent', 'None', 'exclusive: a.ts ; b/'));
  assert.match(frontier(control, 'f').malformed[0].problems.join(' '), /"b\/".*paths inside a part are comma-separated/);
});

test('frontier reports exclusive-claim overlaps with other active runs, ignoring finished ones', () => {
  const { repo, control } = repoWithControl();
  for (const slug of ['a', 'b', 'old']) init(repo, slug, slug);
  setRegistry(repo, 'old', 'done');
  write(path.join(control, 'tracker/a/issues/01-x.md'), ticket('ready-for-agent', 'None', 'exclusive: app/View.swift, lib/'));
  write(path.join(control, 'tracker/b/issues/03-y.md'), ticket('in-flight', 'None', 'exclusive: app/View.swift'));
  write(path.join(control, 'tracker/b/issues/04-z.md'), ticket('done', 'None', 'exclusive: lib/'));
  write(path.join(control, 'tracker/old/issues/01-w.md'), ticket('ready-for-agent', 'None', 'exclusive: lib/'));
  const result = frontier(control, 'a');
  assert.deepEqual(result.cross_run, [{ run: 'b', tickets: ['01', '03'], claims: ['app/View.swift', 'app/View.swift'] }]);
  assert.deepEqual(result.frontier, ['01']);
});

test('CLI commit refuses a subject without the [<slug>] prefix', () => {
  const { repo, control } = repoWithControl();
  write(path.join(control, 'runs/x/tickets/01.status.md'), 'x');
  const r = spawnSync(process.execPath, [GOAL, '--repo', repo, 'commit', '-m', 't01: status', 'runs/x/tickets/01.status.md'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\[<slug>\]/);
});

test('init records the agent and harness it is given', () => {
  const { repo, control } = repoWithControl();
  init(repo, 'x', 'X', { agent: 'session-42', harness: 'codex' });
  const [entry] = JSON.parse(fs.readFileSync(path.join(control, 'runs.json'), 'utf8'));
  assert.equal(entry.agent, 'session-42');
  assert.equal(entry.harness, 'codex');
});

test('frontier resolves each ticket\'s capability: absent is standard/medium, invalid is malformed', () => {
  const { control } = repoWithControl();
  const issues = path.join(control, 'tracker/f/issues');
  write(path.join(issues, '01-a.md'), ticket('ready-for-agent', 'None', 'exclusive: a.ts'));
  write(path.join(issues, '02-b.md'), `${ticket('ready-for-agent', 'None', 'exclusive: b.ts')}**Capability:** advanced/high\n`);
  let result = frontier(control, 'f');
  assert.deepEqual(result.malformed, []);
  assert.deepEqual(result.capability, { '01': 'standard/medium', '02': 'advanced/high' });
  write(path.join(issues, '03-c.md'), `${ticket('ready-for-agent', 'None', 'exclusive: c.ts')}**Capability:** huge\n`);
  result = frontier(control, 'f');
  assert.equal(result.malformed[0].id, '03');
  assert.match(result.malformed[0].problems.join(' '), /capability/);
});

// A run `f` with ticket 01 in flight (contract written) and ticket 02 open beside it.
function runWithTickets(second = 'exclusive: src/b.ts') {
  const { repo, control } = repoWithControl();
  init(repo, 'f', 'F');
  const one = 'exclusive: a.ts ; shared-regenerate: gen/ ; guarded: none';
  write(path.join(control, 'tracker/f/issues/01-a.md'), ticket('in-flight', 'None', one));
  write(path.join(control, 'tracker/f/issues/02-b.md'), ticket('ready-for-agent', 'None', second));
  write(path.join(control, 'runs/f/tickets/01.goal.md'), `# 01\n\n- Claims: ${one}; a needed path outside them → stop, return \`claims-breach\`\n`);
  commit(repo, '[f] seed', ['tracker/f/issues/01-a.md', 'tracker/f/issues/02-b.md', 'runs/f/tickets/01.goal.md']);
  return { repo, control, read: (rel) => fs.readFileSync(path.join(control, rel), 'utf8') };
}

test('claim: adds the path to the ticket and its contract, logs it, and commits all three at once', () => {
  const { repo, control, read } = runWithTickets();
  const head = git(control, 'rev-parse', 'HEAD');
  const result = amendClaims(repo, 'f', '1', 'exclusive', ['tests/a.fake.swift'], 'protocol conformer must gain the new method');
  const want = 'exclusive: a.ts, tests/a.fake.swift ; shared-regenerate: gen/ ; guarded: none';
  assert.match(read('tracker/f/issues/01-a.md'), new RegExp(`^\\*\\*Claims:\\*\\* ${want.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'));
  assert.match(read('tracker/f/issues/01-a.md'), /^\*\*Claims amended:\*\* \+tests\/a\.fake\.swift \(exclusive\): protocol conformer/m);
  assert.ok(read('runs/f/tickets/01.goal.md').includes(`- Claims: ${want}; a needed path`));
  assert.match(read('runs/f/ledger.md').trimEnd().split('\n').at(-1), /^- \d\d:\d\d \[claims\] 01 \+tests\/a\.fake\.swift \(exclusive\): protocol conformer/);
  assert.equal(git(control, 'rev-list', '--count', `${head}..HEAD`), '1');
  assert.equal(git(control, 'status', '--porcelain'), '');
  assert.deepEqual(result.cross_run, []);
  assert.equal(amendClaims(repo, 'f', '01', 'exclusive', ['a.ts'], 'again').commit, 'already claimed');
  assert.equal(amendClaims(repo, 'f', '01', 'exclusive', ['./tests/a.fake.swift'], 'again').commit, 'already claimed');
});

test('claim: refuses a guarded path, a new in-run overlap, and a third amendment, leaving every file as it was', () => {
  const { repo, control, read } = runWithTickets('exclusive: src/b.ts ; guarded: .github/**');
  const before = read('tracker/f/issues/01-a.md');
  assert.throws(() => amendClaims(repo, 'f', '01', 'guarded', ['x.ts'], 'why'), /guarded/);
  assert.throws(() => amendClaims(repo, 'f', '01', 'exclusive', ['.github/workflows/ci.yml'], 'why'), /guarded/);
  assert.throws(() => amendClaims(repo, 'f', '01', 'exclusive', ['src/b.ts'], 'why'), /ticket 02.*b\.ts/);
  for (const p of ['/abs/x.ts', '../x.ts', 'src/../x.ts']) assert.throws(() => amendClaims(repo, 'f', '01', 'exclusive', [p], 'why'), /repo-relative/, p);
  for (const p of ['.github/workflows/ci.yml', 'db/migrations/002.sql', 'package.json']) assert.throws(() => amendClaims(repo, 'f', '01', 'exclusive', [p], 'why'), /guarded/, p);
  assert.equal(read('tracker/f/issues/01-a.md'), before);
  assert.equal(git(control, 'status', '--porcelain'), '');
  amendClaims(repo, 'f', '01', 'exclusive', ['c/c.ts'], 'one');
  amendClaims(repo, 'f', '01', 'shared-regenerate', ['snap/'], 'two');
  assert.throws(() => amendClaims(repo, 'f', '01', 'exclusive', ['d/d.ts'], 'three'), /mis-scoped.*6b/);
});

test('claim: an overlap with another unfinished run is reported, never refused', () => {
  const { repo, control } = runWithTickets();
  write(path.join(control, 'tracker/g/issues/01-x.md'), ticket('in-flight', 'None', 'exclusive: shared/view.swift'));
  const runs = JSON.parse(fs.readFileSync(path.join(control, 'runs.json'), 'utf8'));
  runs.push({ slug: 'g', status: 'building' });
  fs.writeFileSync(path.join(control, 'runs.json'), JSON.stringify(runs));
  const result = amendClaims(repo, 'f', '01', 'exclusive', ['shared/view.swift'], 'needed');
  assert.deepEqual(result.cross_run.map((c) => c.run), ['g']);
});

test('CLI claim takes the reason after --', () => {
  const { repo, read } = runWithTickets();
  const out = execFileSync('node', [GOAL, '--repo', repo, 'claim', 'f', '01', 'exclusive', 'src/c.ts', 'src/d.ts', '--', 'mapper drops the field'], { encoding: 'utf8' });
  assert.match(out, /"commit"/);
  assert.match(read('tracker/f/issues/01-a.md'), /exclusive: a\.ts, src\/c\.ts, src\/d\.ts ;/);
  const bad = spawnSync('node', [GOAL, '--repo', repo, 'claim', 'f', '01', 'exclusive', 'src/e.ts'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});

test('contract: base, claims and criteria must match the worktree and the ticket', () => {
  const repo = bareRepo();
  const stale = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'ticket 00');
  git(repo, 'branch', 'goal/f');
  git(repo, 'checkout', '-q', '-b', 'goal/f-t01');
  const head = git(repo, 'rev-parse', 'HEAD');
  const claims = 'exclusive: src/a.ts ; guarded: none';
  const tk = `${ticket('in-flight', 'None', claims)}\n- [ ] a is exported (Red at base: P1.)\n- [ ] suite green\n`;
  const contract = (base, line, crit) => `# Goal: 01\n\n## Current state\n- Ticket base: ${base} (after 00)\n\n## Completion criteria\n${crit.map((c) => `- [ ] ${c}`).join('\n')}\n\n## Constraints\n- Claims: ${line}; a needed path outside them → stop\n`;
  const good = ['a is exported (Red at base: P1.)', 'suite green'];
  assert.deepEqual(checkContract({ text: contract(head, claims, good), ticketText: tk, worktree: repo }).problems, []);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'Refs 01');
  git(repo, 'checkout', '-q', 'goal/f'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'ticket 02 merged'); git(repo, 'checkout', '-q', 'goal/f-t01');
  assert.deepEqual(checkContract({ text: contract(head, claims, good), ticketText: tk, worktree: repo }).problems, [], 'a re-dispatch keeps the original base');
  assert.match(checkContract({ text: contract(stale, claims, good), ticketText: tk, worktree: repo }).problems.join(' | '), /Ticket base/, 'an older ancestor is not the base');
  const invented = `${head.slice(0, 8)}${'0'.repeat(32)}`;
  assert.match(checkContract({ text: contract(invented, claims, good), ticketText: tk, worktree: repo }).problems.join(' | '), /Ticket base/);
  assert.match(checkContract({ text: contract(head.slice(0, 8), claims, good), ticketText: tk, worktree: repo }).problems.join(' | '), /Ticket base/);
  assert.match(checkContract({ text: contract(head, 'exclusive: src/a.ts', good), ticketText: tk, worktree: repo }).problems.join(' | '), /Claims/);
  const problems = checkContract({ text: contract(head, claims, ['a is exported', 'suite green', 'extra']), ticketText: tk, worktree: repo }).problems.join(' | ');
  assert.match(problems, /missing.*a is exported \(Red/);
  assert.match(problems, /not in the ticket.*extra/);
  const cli = spawnSync('node', [GOAL, 'contract', '/dev/null', '--worktree', repo, '--ticket', '/dev/null'], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
});

// A ticket branch with one commit on top of its base, as an implementer leaves it.
function ticketWorktree() {
  const repo = bareRepo();
  const base = git(repo, 'rev-parse', 'HEAD');
  write(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'Refs 01');
  return { repo, base, head: git(repo, 'rev-parse', 'HEAD') };
}

const TICKET = `${ticket('in-flight', 'None', 'exclusive: src/a.ts')}\n- [ ] a is exported\n- [ ] suite green\n`;

function receipt(over = {}) {
  return {
    ticket: '01', conclusion: 'completed', ticket_base: '', head: '', changed_files: ['src/a.ts'],
    criteria: [
      { criterion: 'a is exported', result: 'pass', evidence: 'npm test -- a.test.ts exit 0' },
      { criterion: 'suite green', result: 'pass', evidence: 'npm test exit 0 (41 passed)' },
    ],
    validation: [{ command: 'npm test', exit: 0, summary: '41 passed' }],
    review: { cited_fixed: 0, leads: [] }, not_validated: [], blockers: [], external_effects: [], worktree_clean: true,
    ...over,
  };
}

test('receipt: a completed receipt that matches git and the ticket passes', () => {
  const { repo, base, head } = ticketWorktree();
  const r = checkReceipt({ text: JSON.stringify(receipt({ ticket_base: base, head })), worktree: repo, base, ticketText: TICKET });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test('receipt and contract: a path that is not a worktree root is refused, never read as the enclosing repo', () => {
  const { repo, base, head } = ticketWorktree();
  const inner = path.join(repo, 'src');
  fs.mkdirSync(inner, { recursive: true });
  const text = JSON.stringify(receipt({ ticket_base: base, head }));
  for (const wt of [inner, path.join(repo, 'gone')]) {
    const r = checkReceipt({ text, worktree: wt, base, ticketText: TICKET });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' | '), /not a worktree root/);
    assert.match(checkContract({ text: `- Ticket base: ${base}\n`, ticketText: TICKET, worktree: wt }).problems.join(' | '), /not a worktree root/);
  }
});

test('receipt: the last json fence of a final message is the receipt', () => {
  const { repo, base, head } = ticketWorktree();
  const text = `Done.\n\n\`\`\`json\n{"ignored": true}\n\`\`\`\n\nRECEIPT\n\`\`\`json\n${JSON.stringify(receipt({ ticket_base: base, head }))}\n\`\`\`\n`;
  assert.equal(checkReceipt({ text, worktree: repo, base, ticketText: TICKET }).ok, true);
});

test('receipt: claims git does not back are refused', () => {
  const { repo, base, head } = ticketWorktree();
  const problems = (over) => checkReceipt({ text: JSON.stringify(receipt({ ticket_base: base, head, ...over })), worktree: repo, base, ticketText: TICKET }).problems.join(' | ');
  assert.match(problems({ head: base }), /head/);
  assert.match(problems({ ticket_base: head }), /ticket_base/);
  assert.match(problems({ changed_files: ['src/a.ts', 'src/b.ts'] }), /changed_files/);
  write(path.join(repo, 'stray.txt'), 'x');
  assert.match(problems({}), /worktree/);
});

test('receipt: every ticket criterion needs a passing, evidenced entry before completed', () => {
  const { repo, base, head } = ticketWorktree();
  const problems = (over) => checkReceipt({ text: JSON.stringify(receipt({ ticket_base: base, head, ...over })), worktree: repo, base, ticketText: TICKET }).problems.join(' | ');
  const [first, second] = receipt().criteria;
  assert.match(problems({ criteria: [first] }), /suite green/);
  assert.match(problems({ criteria: [first, { ...second, result: 'fail' }] }), /suite green/);
  assert.match(problems({ criteria: [first, { ...second, evidence: '' }] }), /evidence/);
  assert.match(problems({ criteria: [first, second, { criterion: 'invented', result: 'pass', evidence: 'x' }] }), /invented/);
  assert.match(problems({ criteria: [first, second, { ...second, result: 'fail' }] }), /more than once/);
  assert.match(problems({ blockers: ['needs a key'] }), /blockers/);
  assert.match(problems({ validation: [] }), /validation/);
  const bare = checkReceipt({ text: JSON.stringify(receipt({ ticket_base: base, head, criteria: [] })), worktree: repo, base, ticketText: ticket('in-flight', 'None', 'exclusive: src/a.ts') });
  assert.match(bare.problems.join(' | '), /no acceptance criteria/);
});

test('receipt: a criterion quoted without its trailing parenthetical note still matches', () => {
  const { repo, base, head } = ticketWorktree();
  const noted = `${ticket('in-flight', 'None', 'exclusive: src/a.ts')}\n- [ ] a is exported (on disk). (Red at base: a is missing; P2.)\n- [ ] suite green (Invariant, green at base.)\n`;
  const check = (criteria) => checkReceipt({ text: JSON.stringify(receipt({ ticket_base: base, head, criteria })), worktree: repo, base, ticketText: noted }).problems;
  const [first, second] = receipt().criteria;
  assert.deepEqual(check([{ ...first, criterion: 'a is exported (on disk).' }, second]), []);
  assert.deepEqual(check([{ ...first, criterion: 'a is exported (on disk). (Red at base: a is missing; P2.)' }, { ...second, criterion: 'suite green (Invariant, green at base.)' }]), []);
  assert.match(check([first, second]).join(' | '), /a is exported \(on disk\)/);
});

test('receipt: malformed shapes and unknown conclusions are refused', () => {
  assert.match(checkReceipt({ text: 'no receipt here' }).problems.join(' '), /JSON/);
  assert.match(checkReceipt({ text: JSON.stringify(receipt({ conclusion: 'done' })) }).problems.join(' '), /conclusion/);
  assert.match(checkReceipt({ text: JSON.stringify(receipt({ worktree_clean: 'yes' })) }).problems.join(' '), /worktree_clean/);
  assert.match(checkReceipt({ text: JSON.stringify(receipt({ contract_quality: 'great' })) }).problems.join(' '), /contract_quality/);
  assert.match(checkReceipt({ text: JSON.stringify(receipt({ conclusion: 'stuck', blockers: [] })) }).problems.join(' '), /blockers/);
});

test('receipt: a stuck receipt with its reason is well-formed, and the CLI exits 1 on a bad one', () => {
  const { repo, base } = ticketWorktree();
  const stuck = receipt({ conclusion: 'stuck', ticket_base: base, head: git(repo, 'rev-parse', 'HEAD'), blockers: ['same test failed 5 times'],
    criteria: [{ criterion: 'a is exported', result: 'pass', evidence: 'x' }, { criterion: 'suite green', result: 'fail', evidence: 'npm test exit 1' }] });
  assert.equal(checkReceipt({ text: JSON.stringify(stuck), worktree: repo, base, ticketText: TICKET }).ok, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-'));
  write(path.join(dir, 't.md'), TICKET);
  write(path.join(dir, 'good.json'), JSON.stringify(stuck));
  write(path.join(dir, 'bad.json'), JSON.stringify({ ...stuck, head: base }));
  const cli = (file) => spawnSync(process.execPath, [GOAL, 'receipt', path.join(dir, file), '--worktree', repo, '--base', base, '--ticket', path.join(dir, 't.md')]).status;
  assert.equal(cli('good.json'), 0);
  assert.equal(cli('bad.json'), 1);
  assert.equal(spawnSync(process.execPath, [GOAL, 'receipt', path.join(dir, 'good.json'), '--worktree', repo]).status, 2);
  assert.equal(spawnSync(process.execPath, [GOAL, 'receipt', path.join(dir, 'good.json'), '--worktree', repo, '--base', base, '--tick', 'x']).status, 2);
});
