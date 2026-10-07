import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STAGES, nowStage, ignoreAllAncestors, unresolvedBugs } from './goal.mjs';

const GOAL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'goal.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const WHO_ARGS = ['--agent', 'test-session', '--harness', 'test'];
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function bareRepo(repo = tmp('guards-repo-')) {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  return repo;
}

/** Run goal.mjs as the CLI; treehouse is off unless `treehouse` names a binary. */
function goal(ctx, args, { treehouse = '', env = {}, flags = [] } = {}) {
  const { TO_AUTO_HOME, ...rest } = process.env;
  return spawnSync(process.execPath, [GOAL, '--repo', ctx.repo, '--state-dir', ctx.state, ...flags, ...args], {
    encoding: 'utf8',
    env: { ...rest, TO_AUTO_TREEHOUSE: treehouse, ...env },
  });
}

function run(slug = 'x', repo = bareRepo()) {
  const ctx = { repo, state: path.join(tmp('guards-state-'), 'state') };
  for (const args of [['control'], ['init', slug, 'X', ...WHO_ARGS]]) {
    const r = goal(ctx, args);
    assert.equal(r.status, 0, r.stderr);
  }
  return ctx;
}

/** A hand edit committed past the control plane's pre-commit hook, as goal.mjs's writers do, for check to catch. */
const handCommit = (ctx, msg) => execFileSync('git', ['-C', ctx.state, 'commit', '-q', '-am', msg], { env: { ...process.env, TO_AUTO_WRITER: '1' } });
const head = (ctx) => git(ctx.state, 'rev-parse', 'HEAD');
const setNow = (ctx, slug, stage) => {
  const file = path.join(ctx.state, 'runs', slug, 'ledger.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^- stage: .*$/m, `- stage: ${stage}`));
  handCommit(ctx, `[${slug}] now`);
};

/** Tick every todo.md stage before `id`, as a run that reached it would have. */
const tickBefore = (ctx, slug, id) => {
  const file = path.join(ctx.state, 'runs', slug, 'todo.md');
  const done = new Set(STAGES.slice(0, STAGES.findIndex((s) => s.id === id)).map((s) => s.id));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^- \[ \] (\S+)/gm, (line, stage) => (done.has(stage) ? `- [x] ${stage}` : line)));
};

// A stand-in for treehouse: logs argv, `get` makes a detached worktree in a pool dir and prints its path.
function fakeTreehouse({ fail = false, blind = false } = {}) {
  const dir = tmp('guards-th-');
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'treehouse');
  if (blind) { // the real pool root: treehouse stamps `*` into it
    fs.mkdirSync(path.join(dir, 'pool'));
    fs.writeFileSync(path.join(dir, 'pool', '.gitignore'), '*\n');
  }
  fs.writeFileSync(bin, `#!/bin/sh
echo "$PWD|$*" >> "${log}"
${fail ? 'echo "pool exhausted" >&2; exit 3' : ''}
if [ "$1" = get ]; then
  slot="${dir}/pool/$(date +%s%N)"
  git worktree add -q --detach "$slot" HEAD >/dev/null 2>&1 || exit 4
  echo "treehouse: leased" >&2
  echo "$slot"
fi
exit 0
`);
  fs.chmodSync(bin, 0o755);
  return { bin, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

// ---------------------------------------------------------------- worktree

test('worktree get without treehouse makes git worktrees under the state dir, run first, tickets from the run branch', () => {
  const ctx = run();
  const r = goal(ctx, ['worktree', 'get', 'x']);
  assert.equal(r.status, 0, r.stderr);
  const wt = r.stdout.trim();
  assert.equal(wt, path.join(ctx.state, 'worktrees', 'goal-x'));
  assert.equal(git(wt, 'symbolic-ref', '--short', 'HEAD'), 'goal/x');
  git(wt, 'commit', '-q', '--allow-empty', '-m', 'run work');
  const t = goal(ctx, ['worktree', 'get', 'x', '1']);
  assert.equal(t.status, 0, t.stderr);
  const twt = t.stdout.trim();
  assert.equal(twt, path.join(ctx.state, 'worktrees', 'goal-x-t01'));
  assert.equal(git(twt, 'symbolic-ref', '--short', 'HEAD'), 'goal/x-t01');
  assert.equal(git(twt, 'rev-parse', 'HEAD'), git(wt, 'rev-parse', 'HEAD'), 'ticket branch starts at the run branch head');
  const status = JSON.parse(goal(ctx, ['worktree', 'status', 'x']).stdout);
  assert.deepEqual(Object.keys(status).sort(), ['run', 't01']);
  assert.equal(status.t01.backend, 'git');
  assert.equal(status.t01.state, 'active');
  assert.match(fs.readFileSync(path.join(ctx.state, '.gitignore'), 'utf8'), /^worktrees\/$/m);
});

test('the run base is goal/bootstrap only while it carries setup main lacks; merged it is skipped, diverged it is refused', () => {
  const cut = (setup) => {
    const repo = bareRepo();
    setup(repo);
    const ctx = run('x', repo);
    return { repo, r: goal(ctx, ['worktree', 'get', 'x']) };
  };
  // Merged and left behind: main moved on, so the run starts at main, not the stale branch.
  let { repo, r } = cut((repo) => { git(repo, 'branch', 'goal/bootstrap'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'later on main'); });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(r.stdout.trim(), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
  // Setup on top of main: the run starts there.
  ({ repo, r } = cut((repo) => { git(repo, 'switch', '-q', '-c', 'goal/bootstrap'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'setup'); git(repo, 'switch', '-q', 'main'); }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(r.stdout.trim(), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'goal/bootstrap'));
  // Setup on an outdated main: refused until rebased.
  ({ repo, r } = cut((repo) => {
    git(repo, 'switch', '-q', '-c', 'goal/bootstrap'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'setup');
    git(repo, 'switch', '-q', 'main'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'later on main');
  }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /goal\/bootstrap does not contain main; rebase it onto main/);
});

test('worktree get is idempotent: a second get prints the same path and commits nothing', () => {
  const ctx = run();
  goal(ctx, ['worktree', 'get', 'x']);
  const first = goal(ctx, ['worktree', 'get', 'x', '01']).stdout.trim();
  const before = head(ctx);
  const again = goal(ctx, ['worktree', 'get', 'x', '1']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout.trim(), first);
  assert.equal(head(ctx), before);
});

test('worktree return refuses a dirty worktree, removes a clean one, and is safe to repeat', () => {
  const ctx = run();
  goal(ctx, ['worktree', 'get', 'x']);
  const wt = goal(ctx, ['worktree', 'get', 'x', '2']).stdout.trim();
  assert.ok(path.isAbsolute(wt) && wt.startsWith(ctx.state), wt);
  fs.writeFileSync(path.join(wt, 'wip.txt'), 'unsaved');
  const dirty = goal(ctx, ['worktree', 'return', 'x', '2']);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /uncommitted changes/);
  assert.ok(fs.existsSync(path.join(wt, 'wip.txt')), 'dirty work is kept');
  fs.rmSync(path.join(wt, 'wip.txt'));
  const ok = goal(ctx, ['worktree', 'return', 'x', '2']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), `returned ${wt}`);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(git(ctx.repo, 'branch', '--list', 'goal/x-t02'), 'goal/x-t02', 'the branch outlives its worktree');
  assert.equal(goal(ctx, ['worktree', 'return', 'x', '2']).stdout.trim(), `already returned ${wt}`);
});

test('worktree get uses a treehouse lease when treehouse is installed, and return hands the slot back detached', () => {
  const ctx = run();
  const th = fakeTreehouse();
  const r = goal(ctx, ['worktree', 'get', 'x'], { treehouse: th.bin });
  assert.equal(r.status, 0, r.stderr);
  const wt = r.stdout.trim();
  assert.ok(wt.startsWith(path.dirname(th.bin)), 'the path treehouse printed, not a state-dir path');
  assert.equal(th.calls()[0], `${ctx.repo}|get --lease --no-fetch --lease-holder x --worktree-path ${path.join(ctx.state, 'worktrees', 'pool', '{slot}', '{repo}')}`);
  assert.equal(git(wt, 'symbolic-ref', '--short', 'HEAD'), 'goal/x');
  assert.equal(JSON.parse(goal(ctx, ['worktree', 'status', 'x']).stdout).run.backend, 'treehouse');
  const back = goal(ctx, ['worktree', 'return', 'x'], { treehouse: th.bin });
  assert.equal(back.status, 0, back.stderr);
  assert.equal(th.calls()[1].split('|')[1], `return ${wt}`);
  assert.notEqual(spawnSync('git', ['-C', wt, 'symbolic-ref', 'HEAD']).status, 0, 'slot is detached before it goes back to the pool');
});

test('an installed treehouse that fails is an error, never a silent fallback to git', () => {
  const ctx = run();
  const th = fakeTreehouse({ fail: true });
  const before = head(ctx);
  const r = goal(ctx, ['worktree', 'get', 'x'], { treehouse: th.bin });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /treehouse get --lease .* failed \(exit 3\): pool exhausted/);
  assert.equal(fs.existsSync(path.join(ctx.state, 'worktrees')), false);
  assert.equal(head(ctx), before, 'nothing recorded');
});

test('a treehouse slot under an ignore-all .gitignore is returned to the pool and refused, nothing recorded', () => {
  const ctx = run();
  const th = fakeTreehouse({ blind: true });
  const before = head(ctx);
  const r = goal(ctx, ['worktree', 'get', 'x'], { treehouse: th.bin });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /sits under .*pool\/\.gitignore, which ignores everything below it/);
  assert.match(r.stderr, /treehouse destroy /);
  const calls = th.calls();
  assert.equal(calls.length, 2, calls.join('\n'));
  assert.match(calls[1], /\|return .*\/pool\//);
  assert.equal(head(ctx), before, 'nothing recorded');
  assert.equal(JSON.parse(goal(ctx, ['worktree', 'status', 'x']).stdout).run, undefined);
});

test('a git worktree is refused before creation when the state dir sits under an ignore-all .gitignore', () => {
  const ctx = run();
  fs.writeFileSync(path.join(path.dirname(ctx.state), '.gitignore'), '**\n');
  const before = head(ctx);
  const r = goal(ctx, ['worktree', 'get', 'x']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ignores everything below it.*Move the control plane/);
  assert.equal(fs.existsSync(path.join(ctx.state, 'worktrees')), false);
  assert.equal(git(ctx.repo, 'branch', '--list', 'goal/x'), '', 'no branch either');
  assert.equal(head(ctx), before);
});

test('ignoreAllAncestors flags only the patterns that blind an ignore-crate walker from above a root', () => {
  const root = tmp('guards-ign-');
  const wt = path.join(root, 'a', 'b', 'repo');
  fs.mkdirSync(wt, { recursive: true });
  assert.deepEqual(ignoreAllAncestors(wt), [], 'no ignore files: nothing flagged');
  // what the control plane and ordinary parents carry: never flagged (verified against rg --no-require-git)
  fs.writeFileSync(path.join(root, '.gitignore'), 'worktrees/\n/*\nnode_modules\n# *\n!*\n');
  fs.writeFileSync(path.join(root, 'a', '.ignore'), 'worktrees\n*.log\n');
  assert.deepEqual(ignoreAllAncestors(wt), []);
  // what treehouse stamps into its pool root, in any of the three spellings, in .gitignore or .ignore
  fs.writeFileSync(path.join(root, 'a', 'b', '.gitignore'), '  **/*  \n');
  fs.writeFileSync(path.join(root, 'a', '.ignore'), '**\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '# pool\n*\n');
  assert.deepEqual(ignoreAllAncestors(wt), [path.join(root, 'a', 'b', '.gitignore'), path.join(root, 'a', '.ignore'), path.join(root, '.gitignore')]);
  assert.deepEqual(ignoreAllAncestors(path.join(root, 'a', 'b', 'not-yet-created')), [path.join(root, 'a', 'b', '.gitignore'), path.join(root, 'a', '.ignore'), path.join(root, '.gitignore')], 'a path that does not exist yet is judged by its parents');
  assert.deepEqual(ignoreAllAncestors(root), [], 'a directory is not below its own ignore file');
});

test('a borrowed worktree (supervisor target) under an ignore-all .gitignore is refused, nothing recorded', () => {
  const parent = tmp('guards-blind-'); // the repo's own parent, never the shared tmpdir
  const ctx = run('x', bareRepo(path.join(parent, 'repo')));
  fs.writeFileSync(path.join(parent, '.gitignore'), '*\n');
  const before = head(ctx);
  const r = goal(ctx, ['worktree', 'get', 'x'], { flags: ['--target-branch', 'main'] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ignores everything below it.*main is checked out there/);
  assert.equal(head(ctx), before);
});

test('a branch already checked out (supervisor target) is borrowed, and return never removes it', () => {
  const ctx = run();
  const r = goal(ctx, ['worktree', 'get', 'x'], { flags: ['--target-branch', 'main'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), ctx.repo);
  assert.equal(JSON.parse(goal(ctx, ['worktree', 'status', 'x']).stdout).run.backend, 'borrowed');
  assert.equal(goal(ctx, ['worktree', 'return', 'x']).status, 0);
  assert.ok(fs.existsSync(path.join(ctx.repo, '.git')));
});

test('worktree commands refuse an unknown run and a non-numeric ticket', () => {
  const ctx = run();
  assert.match(goal(ctx, ['worktree', 'get', 'nope']).stderr, /no run nope/);
  assert.equal(goal(ctx, ['worktree', 'get', 'x', 'abc']).status, 2);
  const early = goal(ctx, ['worktree', 'get', 'x', '1']);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /run branch goal\/x does not exist yet/);
});

// ----------------------------------------------------------------- cleanup

test('cleanup refuses while a run worktree is active, then removes the state once it is returned', () => {
  const ctx = run();
  goal(ctx, ['worktree', 'get', 'x']);
  goal(ctx, ['worktree', 'get', 'x', '3']);
  const refused = goal(ctx, ['cleanup']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /x t03 worktree .* is active; `goal\.mjs worktree return x 03`/);
  assert.ok(fs.existsSync(ctx.state));
  goal(ctx, ['worktree', 'return', 'x', '3']);
  assert.equal(goal(ctx, ['cleanup']).status, 1, 'the run worktree is still active');
  goal(ctx, ['worktree', 'return', 'x']);
  const ok = goal(ctx, ['cleanup']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.existsSync(ctx.state), false);
});

test('cleanup refuses while the clone holds commits the repo does not have', () => {
  const ctx = run();
  const clone = path.join(ctx.state, 'clone');
  execFileSync('git', ['clone', '-q', ctx.repo, clone]);
  git(clone, 'config', 'user.email', 't@t');
  git(clone, 'config', 'user.name', 't');
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'unlanded');
  const refused = goal(ctx, ['cleanup']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /clone branch main at [0-9a-f]{12} is not in .*`goal\.mjs land` it first/);
  assert.ok(fs.existsSync(clone));
});

// ------------------------------------------------------------------- check

const INCIDENT = '7 build (adapted; see log.md D1-D5)';

test('the incident: NOW at stage 7 while the registry is bootstrapping is NOW_AHEAD for check, next and compact', () => {
  const ctx = run();
  setNow(ctx, 'x', INCIDENT);
  const before = head(ctx);
  const c = goal(ctx, ['check', 'x']);
  assert.equal(c.status, 1);
  const result = JSON.parse(c.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.nowStage, '7');
  assert.equal(result.registry, 'bootstrapping');
  assert.deepEqual(result.problems.map((p) => p.code), ['NOW_AHEAD']);
  assert.match(result.problems[0].message, /stage 7 needs registry building, but the registry is bootstrapping/);
  const n = goal(ctx, ['next', 'x']);
  assert.equal(n.status, 1);
  assert.equal(JSON.parse(n.stdout).blocked, true);
  const k = goal(ctx, ['compact', 'x']);
  assert.equal(k.status, 1);
  assert.match(k.stderr, /before compacting/);
  assert.equal(head(ctx), before, 'check, next and a refused compact write nothing');
  assert.equal(git(ctx.state, 'status', '--porcelain'), '');
});

test('every stage needs exactly its registry floor: one status below is NOW_AHEAD, the floor itself is fine', () => {
  const floors = { bootstrapping: ['00', '0', '0a', '0b', '0c'], planning: ['0d', '1', '2', '3', '4', '4b', '5', '5b'], specced: ['6', '6b'], building: ['7'], reviewing: ['8', '9', '10'] };
  assert.deepEqual(Object.values(floors).flat().sort(), STAGES.map((s) => s.id).sort(), 'every STAGES id has a floor');
  const order = ['bootstrapping', 'planning', 'specced', 'ticketed', 'building', 'reviewing'];
  const ctx = run();
  const runs = path.join(ctx.state, 'runs.json');
  const setStatus = (status) => {
    const data = JSON.parse(fs.readFileSync(runs, 'utf8'));
    data[0].status = status;
    fs.writeFileSync(runs, JSON.stringify(data));
  };
  for (const [floor, ids] of Object.entries(floors)) {
    for (const id of ids) {
      tickBefore(ctx, 'x', id);
      setNow(ctx, 'x', `${id} stage`);
      setStatus(floor);
      assert.equal(JSON.parse(goal(ctx, ['check', 'x']).stdout).ok, true, `${id} at ${floor}`);
      const below = order[order.indexOf(floor) - 1];
      if (!below) continue;
      setStatus(below);
      assert.deepEqual(JSON.parse(goal(ctx, ['check', 'x']).stdout).problems.map((p) => p.code), ['NOW_AHEAD', 'TODO_AHEAD'], `${id} at ${below}`);
    }
  }
});

test('todo.md behind the registry is TODO_BEHIND, and next resumes at the stage the registry reached', () => {
  const ctx = run();
  const runs = path.join(ctx.state, 'runs.json');
  const data = JSON.parse(fs.readFileSync(runs, 'utf8'));
  data[0].status = 'building';
  fs.writeFileSync(runs, JSON.stringify(data));
  tickBefore(ctx, 'x', '5b'); // the niblet run: nine tickets built, todo.md still at 5b
  setNow(ctx, 'x', '5b reconcile');
  const c = goal(ctx, ['check', 'x']);
  assert.equal(c.status, 1);
  assert.deepEqual(JSON.parse(c.stdout).problems.map((p) => p.code), ['TODO_BEHIND']);
  const n = goal(ctx, ['next', 'x']);
  assert.equal(n.status, 0, 'a stale todo.md redirects the resume, it does not block it');
  assert.equal(JSON.parse(n.stdout).stage, '7');
  assert.match(JSON.parse(n.stdout).reason, /registry is building.*unticked from stage 5b/);
  tickBefore(ctx, 'x', '7');
  assert.equal(goal(ctx, ['check', 'x']).status, 0);
  assert.doesNotMatch(JSON.parse(goal(ctx, ['next', 'x']).stdout).reason, /registry is/, 'todo.md in step: next reads it as before');
  // Every status resumes at the stage its registry step opens; a status with nothing behind it, or a terminal one, reads todo.md alone.
  const fresh = run();
  const expected = { bootstrapping: '00', planning: '0d', specced: '6', ticketed: '7', building: '7', reviewing: '8', done: '00', 'dry-run': '00' };
  for (const [status, stage] of Object.entries(expected)) {
    const file = path.join(fresh.state, 'runs.json');
    const all = JSON.parse(fs.readFileSync(file, 'utf8'));
    all[0].status = status;
    fs.writeFileSync(file, JSON.stringify(all));
    assert.equal(JSON.parse(goal(fresh, ['next', 'x']).stdout).stage, stage, status);
  }
});

test('a missing or unknown NOW stage is NOW_MALFORMED; done and dry-run runs are not checked', () => {
  const ctx = run();
  setNow(ctx, 'x', 'twelve');
  assert.deepEqual(JSON.parse(goal(ctx, ['check', 'x']).stdout).problems.map((p) => p.code), ['NOW_MALFORMED']);
  const runs = path.join(ctx.state, 'runs.json');
  for (const status of ['done', 'dry-run']) {
    const data = JSON.parse(fs.readFileSync(runs, 'utf8'));
    data[0].status = status;
    fs.writeFileSync(runs, JSON.stringify(data));
    assert.equal(goal(ctx, ['check', 'x']).status, 0, status);
  }
});

test('a stopped run reports nothing; resume brings its NOW_AHEAD back', () => {
  const ctx = run();
  setNow(ctx, 'x', INCIDENT);
  assert.equal(goal(ctx, ['stop', 'x', 'paused']).status, 0);
  assert.equal(goal(ctx, ['check', 'x', '--stale-hours', '0']).status, 0);
  assert.equal(goal(ctx, ['resume', 'x']).status, 0);
  const result = JSON.parse(goal(ctx, ['check', 'x']).stdout);
  assert.deepEqual(result.problems.map((p) => p.code), ['NOW_AHEAD']);
  assert.equal(goal(ctx, ['next', 'x']).status, 1);
});

test('STALE when the run has no goal.mjs commit for longer than --stale-hours; any run commit counts as activity', () => {
  const ctx = { repo: bareRepo(), state: path.join(tmp('guards-state-'), 'state') };
  goal(ctx, ['control']);
  const old = { GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z' };
  assert.equal(goal(ctx, ['init', 'old', 'Old', ...WHO_ARGS], { env: old }).status, 0);
  assert.equal(goal(ctx, ['init', 'new', 'New', ...WHO_ARGS]).status, 0);
  const stale = JSON.parse(goal(ctx, ['check', 'old']).stdout);
  assert.deepEqual(stale.problems.map((p) => p.code), ['STALE']);
  assert.match(stale.problems[0].message, /no goal\.mjs commit for \d+\.\dh while bootstrapping \(limit 2h\)/);
  assert.equal(goal(ctx, ['check', 'new']).status, 0);
  assert.equal(goal(ctx, ['check', 'new', '--stale-hours', '0']).status, 1);
  assert.equal(goal(ctx, ['event', 'old', '0', 'still working']).status, 0);
  assert.equal(goal(ctx, ['check', 'old']).status, 0, 'a fresh event is activity');
});

test('check --all walks every control plane under the root: one line per problem, silent and exit 0 when clean', () => {
  const root = tmp('guards-root-');
  const a = { repo: bareRepo(), state: path.join(root, 'aaa') };
  const b = { repo: bareRepo(), state: path.join(root, 'bbb') };
  for (const ctx of [a, b]) {
    goal(ctx, ['control']);
    goal(ctx, ['init', 'x', 'X', ...WHO_ARGS]);
  }
  fs.mkdirSync(path.join(root, 'not-a-control-plane'));
  const all = (args = []) => spawnSync(process.execPath, [GOAL, 'check', '--all', '--state-root', root, ...args], { encoding: 'utf8', env: { ...process.env, TO_AUTO_HOME: '' } });
  const clean = all();
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout, '');
  setNow(b, 'x', INCIDENT);
  const dirty = all();
  assert.equal(dirty.status, 1);
  assert.deepEqual(dirty.stdout.trim().split('\n'), [`${b.state} x NOW_AHEAD NOW stage 7 needs registry building, but the registry is bootstrapping`]);
  assert.equal(all(['--stale-hours', '0']).stdout.trim().split('\n').length, 3, 'both runs stale plus b ahead');
});

test('to-auto-watch.sh notify fires once per problem set: a STALE age that only moves is not a new problem', () => {
  const home = tmp('guards-home-');
  const ctx = { repo: bareRepo(), state: path.join(home, '.local', 'state', 'to-auto', 'aaa') };
  const at = (hour) => ({ GIT_COMMITTER_DATE: `2026-01-01T0${hour}:00:00Z`, GIT_AUTHOR_DATE: `2026-01-01T0${hour}:00:00Z` });
  assert.equal(goal(ctx, ['control']).status, 0);
  assert.equal(goal(ctx, ['init', 'old', 'Old', ...WHO_ARGS], { env: at(0) }).status, 0);
  const calls = path.join(home, 'osascript.log');
  fs.writeFileSync(path.join(home, 'osascript'), `#!/bin/sh\necho "$*" >> "${calls}"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: '', TO_AUTO_HOME: '', PATH: `${home}${path.delimiter}${process.env.PATH}` };
  const notify = () => assert.equal(spawnSync('sh', [path.join(path.dirname(GOAL), 'to-auto-watch.sh'), 'notify'], { encoding: 'utf8', env }).status, 0);
  const fired = () => fs.readFileSync(calls, 'utf8').trim().split('\n');
  notify();
  assert.equal(fired().length, 1);
  assert.match(fired()[0], /STALE no goal\.mjs commit for \d+\.\dh/);
  assert.equal(goal(ctx, ['event', 'old', '0', 'late'], { env: at(5) }).status, 0);
  notify();
  assert.equal(fired().length, 1, 'same run, same code, different age');
  setNow(ctx, 'old', INCIDENT);
  notify();
  assert.equal(fired().length, 2, 'STALE became NOW_AHEAD');
  notify();
  assert.equal(fired().length, 2);
});

test('nowStage reads the first token of the NOW stage line only', () => {
  assert.equal(nowStage('# t\n\n## NOW\n- stage: 4b challenge\n\n## Events\n- stage: 9\n'), '4b');
  assert.equal(nowStage('# t\n\n## NOW\n- next: x\n'), null);
});

// ------------------------------------------------------------------ tick

const registryOf = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx.state, 'runs.json'), 'utf8'))[0].status;
const nowOf = (ctx) => nowStage(fs.readFileSync(path.join(ctx.state, 'runs', 'x', 'ledger.md'), 'utf8'));
const todoOf = (ctx) => fs.readFileSync(path.join(ctx.state, 'runs', 'x', 'todo.md'), 'utf8');
const forceStatus = (ctx, status) => {
  const file = path.join(ctx.state, 'runs.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data[0].status = status;
  fs.writeFileSync(file, JSON.stringify(data));
};
const put = (ctx, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(ctx.state, rel)), { recursive: true });
  fs.writeFileSync(path.join(ctx.state, rel), text);
};
const reviewBase = (ctx) => {
  const ledger = path.join(ctx.state, 'runs/x/ledger.md');
  fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').replace('## NOW\n', '## NOW\n- review_base: 1234567\n'));
};
const tick = (ctx, ...args) => goal(ctx, ['tick', 'x', ...args]);
const ticked = (ctx, ...args) => {
  const r = tick(ctx, ...args);
  assert.equal(r.status, 0, `tick ${args.join(' ')}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};
/** A refused tick names `pattern` and writes nothing: no commit, todo.md, NOW and the registry unchanged. */
const refused = (ctx, pattern, ...args) => {
  const before = [head(ctx), todoOf(ctx), nowOf(ctx), registryOf(ctx)];
  const r = tick(ctx, ...args);
  assert.equal(r.status, 1, `tick ${args.join(' ')} should be refused`);
  assert.match(r.stderr, pattern);
  assert.deepEqual([head(ctx), todoOf(ctx), nowOf(ctx), registryOf(ctx)], before, `refused tick ${args.join(' ')} wrote nothing`);
};

test('tick walks a run end to end: todo.md, NOW and the registry move together, each registry step on its own gate', () => {
  const ctx = run();
  for (const id of ['00', '0', '0a', '0b']) assert.equal(ticked(ctx, id).registry, 'bootstrapping');
  assert.equal(nowOf(ctx), '0c');
  refused(ctx, /stage 5 is not next: 0c isolate is the first unticked stage/, '5');
  refused(ctx, /stage 0c cannot be ticked: x cannot be planning yet: no active run worktree/, '0c');
  put(ctx, 'runs/x/worktrees.json', JSON.stringify({ run: { backend: 'git', state: 'active' } }));
  refused(ctx, /stage 0c cannot be ticked: x cannot be planning yet: NOW records no review_base/, '0c');
  reviewBase(ctx);
  const planned = ticked(ctx, '0c');
  assert.deepEqual([planned.registry, planned.next], ['planning', '0d']);
  assert.equal(nowOf(ctx), '0d');
  assert.equal(git(ctx.state, 'log', '-1', '--format=%s'), '[x] tick 0c: done; status planning');
  ticked(ctx, '0d');
  refused(ctx, /runs\/x\/findings\.md is missing/, '1');
  put(ctx, 'runs/x/findings.md', '# f\n');
  ticked(ctx, '1');
  for (const id of ['2', '3', '4', '4b']) ticked(ctx, id, '--skipped', 'ready source');
  assert.match(todoOf(ctx), /^- \[x\] 4b challenge \(skipped: ready source\)$/m);
  refused(ctx, /runs\/x\/spec\.md is missing/, '5');
  put(ctx, 'runs/x/spec.md', '# s\n');
  assert.equal(ticked(ctx, '5').registry, 'planning');
  assert.equal(ticked(ctx, '5b').registry, 'specced');
  ticked(ctx, '6');
  refused(ctx, /no tickets in tracker\/x\/issues/, '6b');
  const ticket = (status) => put(ctx, 'tracker/x/issues/01-a.md', `# a\n\n**Status:** ${status}\n**Blocked by:** none\n**Claims:** a.txt (exclusive)\n\n- [ ] works\n`);
  ticket('in-flight');
  assert.equal(ticked(ctx, '6b').registry, 'building');
  assert.match(git(ctx.state, 'log', '-1', '--format=%s'), /status ticketed → building$/);
  assert.equal(goal(ctx, ['check', 'x']).status, 0, 'a ticked run is in step with its registry');
  refused(ctx, /build is not complete: 01 \(in-flight\)/, '7');
  ticket('done');
  assert.equal(ticked(ctx, '7').registry, 'reviewing');
  put(ctx, 'runs/x/final-verdict.json', JSON.stringify({ verdict: 'ship', target: 'main', review_head: git(ctx.repo, 'rev-parse', 'main') }));
  git(ctx.state, 'add', '-A');
  execFileSync('git', ['-C', ctx.state, 'commit', '-qm', '[x] fixtures'], { env: { ...process.env, TO_AUTO_WRITER: '1' } });
  ticked(ctx, '8');
  ticked(ctx, '9');
  refused(ctx, /runs\/x\/retro\.md is missing/, '10');
  put(ctx, 'runs/x/retro.md', '# r\n');
  git(ctx.repo, 'commit', '-q', '--allow-empty', '-m', 'landed after the review');
  refused(ctx, /main is at .* but the final review saw/, '10');
  git(ctx.repo, 'reset', '-q', '--hard', 'HEAD~1');
  assert.equal(ticked(ctx, '10').registry, 'done');
  assert.equal(nowOf(ctx), 'done');
  assert.equal(JSON.parse(goal(ctx, ['next', 'x']).stdout).done, true);
  refused(ctx, /x is done/, '10');
});

test('re-ticking a ticked stage commits nothing; bad input is a usage error', () => {
  const ctx = run();
  ticked(ctx, '00');
  const before = head(ctx);
  assert.equal(ticked(ctx, '00').commit, 'nothing to commit');
  assert.equal(head(ctx), before);
  assert.equal(tick(ctx, '12').status, 2);
  assert.equal(tick(ctx, '0', '--skipped', ' ').status, 2);
  assert.equal(tick(ctx, '0', '--bogus', 'x').status, 2);
});

test('registry moves forward only through tick; stop and dry-run keep their own routes', () => {
  const ctx = run();
  const r = goal(ctx, ['registry', 'x', 'planning']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only through `goal\.mjs tick x <stage>`: planning follows the tick of stage 0c/);
  for (const [status, stage] of [['specced', '5b'], ['ticketed', '6b'], ['building', '6b'], ['reviewing', '7'], ['done', '10']]) {
    assert.match(goal(ctx, ['registry', 'x', status]).stderr, new RegExp(`follows the tick of stage ${stage}$`, 'm'), status);
  }
  assert.match(goal(ctx, ['registry', 'x', 'stopped']).stderr, /goal\.mjs stop x <reason>/);
  assert.equal(registryOf(ctx), 'bootstrapping');
  assert.equal(goal(ctx, ['registry', 'x', 'dry-run']).status, 0);
  ticked(ctx, '00');
  assert.equal(registryOf(ctx), 'dry-run', 'a dry-run ticks without leaving dry-run');
});

test('a stopped run cannot tick until resumed', () => {
  const ctx = run();
  assert.equal(goal(ctx, ['stop', 'x', 'why']).status, 0);
  refused(ctx, /x is stopped; `goal\.mjs resume x` first/, '00');
  assert.equal(goal(ctx, ['resume', 'x']).status, 0);
  ticked(ctx, '00');
});

test('the drifted live runs repair through tick: the registry stays, todo.md and NOW catch up, check goes clean', () => {
  // niblet workstream-b: building with nine tickets dispatched, todo.md and NOW still at 5b.
  const ctx = run();
  forceStatus(ctx, 'building');
  tickBefore(ctx, 'x', '5b');
  setNow(ctx, 'x', '5b reconcile');
  assert.deepEqual(JSON.parse(goal(ctx, ['check', 'x']).stdout).problems.map((p) => p.code), ['TODO_BEHIND']);
  for (const id of ['5b', '6', '6b']) assert.equal(ticked(ctx, id).registry, 'building');
  assert.equal(nowOf(ctx), '7');
  assert.equal(goal(ctx, ['check', 'x']).status, 0);
  // t8.1 clean renderer: reviewing, stage 7 unticked, NOW still at 6b.
  const t8 = run();
  forceStatus(t8, 'reviewing');
  tickBefore(t8, 'x', '7');
  setNow(t8, 'x', '6b claims gate');
  assert.equal(goal(t8, ['check', 'x']).status, 1);
  assert.equal(ticked(t8, '7').registry, 'reviewing');
  assert.equal(nowOf(t8), '8');
  assert.equal(goal(t8, ['check', 'x']).status, 0);
});

test('a hand tick that skipped the registry move is TODO_AHEAD: next blocks, and re-ticking the stage makes the move on its evidence', () => {
  // An agent on the old docs ticked 5b by hand, then `registry specced` was refused.
  const ctx = run();
  forceStatus(ctx, 'planning');
  tickBefore(ctx, 'x', '6');
  setNow(ctx, 'x', '5b reconcile');
  const c = JSON.parse(goal(ctx, ['check', 'x']).stdout);
  assert.deepEqual(c.problems.map((p) => p.code), ['TODO_AHEAD']);
  assert.match(c.problems[0].message, /ticked through stage 5b, which needs registry specced, but the registry is planning; `goal\.mjs tick x 5b`/);
  const n = goal(ctx, ['next', 'x']);
  assert.equal(n.status, 1);
  assert.equal(JSON.parse(n.stdout).blocked, true, 'next never resumes past a registry step that did not happen');
  refused(ctx, /runs\/x\/spec\.md is missing/, '5b');
  put(ctx, 'runs/x/spec.md', '# s\n');
  put(ctx, 'runs/x/findings.md', '# f\n');
  assert.match(tick(ctx, '5b', '--skipped', 'x').stderr, /stage 5b is already ticked; --skipped records only a first tick/);
  const r = ticked(ctx, '5b');
  assert.deepEqual([r.registry, r.next], ['specced', '6']);
  assert.equal(nowOf(ctx), '6');
  assert.match(git(ctx.state, 'log', '-1', '--format=%s'), /^\[x\] tick 5b: re-ticked; status specced$/);
  assert.equal(goal(ctx, ['check', 'x']).status, 0);
  assert.equal(ticked(ctx, '5b').commit, 'nothing to commit', 'a second re-tick has nothing to finish');
  assert.equal(ticked(ctx, '0').commit, 'nothing to commit', 'an older ticked stage leaves NOW alone');
  assert.equal(nowOf(ctx), '6');
});

test('catch-up ticks on an abandoned run never hide it from STALE; a tick that moves the run forward is activity', () => {
  const ctx = run();
  forceStatus(ctx, 'building');
  tickBefore(ctx, 'x', '5b');
  setNow(ctx, 'x', '5b reconcile');
  const old = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  const amend = spawnSync('git', ['-C', ctx.state, 'commit', '-q', '--amend', '--no-edit', `--date=${old}`], { env: { ...process.env, GIT_COMMITTER_DATE: old } });
  assert.equal(amend.status, 0, String(amend.stderr));
  for (const id of ['5b', '6', '6b']) ticked(ctx, id);
  assert.match(git(ctx.state, 'log', '-1', '--format=%s'), /^\[x\] tick 6b: catch-up done$/);
  const codes = () => JSON.parse(goal(ctx, ['check', 'x']).stdout).problems.map((p) => p.code);
  assert.deepEqual(codes(), ['STALE'], 'todo.md caught up, but nobody has worked on the run for 5h');
  put(ctx, 'tracker/x/issues/01-a.md', '# a\n\n**Status:** done\n**Blocked by:** none\n**Claims:** a.txt (exclusive)\n\n- [x] works\n');
  assert.equal(ticked(ctx, '7').registry, 'reviewing');
  assert.deepEqual(codes(), [], 'finishing stage 7 is real progress');
});

test('goal.mjs commit and event refuse a hand edit of any stage copy; NOW may be set back to the first unticked stage', () => {
  const ctx = run();
  ticked(ctx, '00');
  const commitCli = (...files) => goal(ctx, ['commit', '-m', '[x] hand edit', ...files]);
  const todo = path.join(ctx.state, 'runs', 'x', 'todo.md');
  const ledger = path.join(ctx.state, 'runs', 'x', 'ledger.md');
  const runsFile = path.join(ctx.state, 'runs.json');
  const original = fs.readFileSync(todo, 'utf8');
  fs.writeFileSync(todo, original.replace('- [ ] 0 register', '- [x] 0 register'));
  let r = commitCli('runs/x/todo.md');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stage 0 is ticked only by `goal\.mjs tick x 0`/);
  fs.writeFileSync(todo, original.replace('- [x] 00 wiring and ask-matt', '- [ ] 00 wiring and ask-matt'));
  assert.match(commitCli('runs/x/todo.md').stderr, /stage 00 is ticked only by/, 'unticking is a hand edit too');
  fs.writeFileSync(todo, `${original}| 01 | t |\n`);
  assert.equal(commitCli('runs/x/todo.md').status, 0, 'the ticket table is not a stage copy');
  const now = fs.readFileSync(ledger, 'utf8');
  fs.writeFileSync(ledger, now.replace(/^- stage: .*$/m, '- stage: 7 build'));
  assert.match(commitCli('runs/x/ledger.md').stderr, /by hand it may only name 0, the first unticked stage/);
  r = goal(ctx, ['event', 'x', '0', 'note']);
  assert.equal(r.status, 1, 'an event commit does not carry a hand-edited stage line in');
  fs.writeFileSync(ledger, now.replace(/^- next: .*$/m, '- next: something else'));
  assert.equal(commitCli('runs/x/ledger.md').status, 0, 'the rest of NOW stays prose');
  const data = JSON.parse(fs.readFileSync(runsFile, 'utf8'));
  data[0].status = 'building';
  fs.writeFileSync(runsFile, JSON.stringify(data));
  assert.match(commitCli('runs.json').stderr, /x's status is written only by goal\.mjs tick, stop, resume and registry dry-run/);
  git(ctx.state, 'checkout', '--', 'runs.json');
  // NOW_AHEAD put back by hand, as LEDGER.md says: allowed, because it names the stage todo.md says is next.
  setNow(ctx, 'x', '7 build');
  assert.deepEqual(JSON.parse(goal(ctx, ['check', 'x']).stdout).problems.map((p) => p.code), ['NOW_AHEAD']);
  fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').replace(/^- stage: .*$/m, '- stage: 0 register'));
  assert.equal(commitCli('runs/x/ledger.md').status, 0);
  assert.equal(goal(ctx, ['check', 'x']).status, 0);
});

test('a tick whose commit fails leaves every file and the index as they were', () => {
  const ctx = run();
  const before = [todoOf(ctx), fs.readFileSync(path.join(ctx.state, 'runs', 'x', 'ledger.md'), 'utf8'), head(ctx)];
  const hook = path.join(ctx.state, '.git', 'hooks', 'commit-msg'); // runs after staging; goal.mjs's commits skip pre-commit
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const r = tick(ctx, '00');
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual([todoOf(ctx), fs.readFileSync(path.join(ctx.state, 'runs', 'x', 'ledger.md'), 'utf8'), head(ctx)], before);
  assert.equal(git(ctx.state, 'status', '--porcelain'), '');
  fs.rmSync(hook);
  for (const id of ['00', '0', '0a', '0b']) ticked(ctx, id);
  // A tick that also moves the registry: runs.json is rolled back with the rest.
  put(ctx, 'runs/x/worktrees.json', JSON.stringify({ run: { backend: 'git', state: 'active' } }));
  reviewBase(ctx);
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const files = () => ['runs.json', 'runs/x/todo.md', 'runs/x/ledger.md'].map((f) => fs.readFileSync(path.join(ctx.state, f), 'utf8'));
  const beforeMove = [...files(), head(ctx)];
  assert.equal(tick(ctx, '0c').status, 3);
  assert.deepEqual([...files(), head(ctx)], beforeMove);
  assert.equal(registryOf(ctx), 'bootstrapping');
  assert.equal(git(ctx.state, 'diff', '--cached', '--name-only'), '', 'nothing left staged');
  fs.rmSync(hook);
  assert.equal(ticked(ctx, '0c').registry, 'planning');
});

test('compact refuses while todo.md is ticked past a registry move', () => {
  const ctx = run();
  tickBefore(ctx, 'x', '0d');
  setNow(ctx, 'x', '0c isolate');
  const r = goal(ctx, ['compact', 'x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ticked through stage 0c, which needs registry planning.*before compacting/);
});

test('tick and status moves refuse to carry an uncommitted hand edit of a stage copy into their own commit', () => {
  const ctx = run();
  const todo = path.join(ctx.state, 'runs', 'x', 'todo.md');
  fs.writeFileSync(todo, todoOf(ctx).replace('- [ ] 0 register', '- [x] 0 register'));
  refused(ctx, /stage 0 is ticked only by .*that edit is uncommitted, so undo it/, '00');
  git(ctx.state, 'checkout', '--', 'runs/x/todo.md');
  forceStatus(ctx, 'building');
  refused(ctx, /x's status is written only by .*that edit is uncommitted/, '00');
  assert.match(goal(ctx, ['stop', 'x', 'why']).stderr, /that edit is uncommitted/);
  assert.equal(fs.existsSync(path.join(ctx.state, 'runs', 'x', 'STOP')), false, 'a refused stop writes no STOP');
  git(ctx.state, 'checkout', '--', 'runs.json');
  ticked(ctx, '00');
  assert.equal(goal(ctx, ['stop', 'x', 'why']).status, 0);
  forceStatus(ctx, 'stopped');
  const data = JSON.parse(fs.readFileSync(path.join(ctx.state, 'runs.json'), 'utf8'));
  data[0].stoppedFrom = 'building';
  fs.writeFileSync(path.join(ctx.state, 'runs.json'), JSON.stringify(data));
  assert.match(goal(ctx, ['resume', 'x']).stderr, /that edit is uncommitted/);
  assert.equal(fs.existsSync(path.join(ctx.state, 'runs', 'x', 'STOP')), true, 'a refused resume leaves the run stopped');
});

test('a raw git commit in the control plane meets the same guards: the pre-commit hook refuses stage and ticket hand edits', () => {
  const ctx = run();
  const hook = path.join(ctx.state, '.git', 'hooks', 'pre-commit');
  assert.match(fs.readFileSync(hook, 'utf8'), /guard-staged/, 'control installs the hook');
  const raw = (...files) => spawnSync('git', ['-C', ctx.state, 'commit', '-qm', '[x] raw', '--', ...files], { encoding: 'utf8', env: { ...process.env, TO_AUTO_WRITER: '' } });
  const todo = path.join(ctx.state, 'runs', 'x', 'todo.md');
  const original = todoOf(ctx);
  fs.writeFileSync(todo, original.replace('- [ ] 00 ', '- [x] 00 '));
  git(ctx.state, 'add', 'runs/x/todo.md');
  let r = raw('runs/x/todo.md');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /stage 00 is ticked only by `goal\.mjs tick x 00`/);
  git(ctx.state, 'reset', '-q');
  git(ctx.state, 'checkout', '--', 'runs/x/todo.md');
  forceStatus(ctx, 'building');
  git(ctx.state, 'add', 'runs.json');
  assert.match(raw('runs.json').stderr, /x's status is written only by goal\.mjs tick/);
  git(ctx.state, 'reset', '-q');
  git(ctx.state, 'checkout', '--', 'runs.json');
  put(ctx, 'runs/x/notes.md', 'free prose\n');
  git(ctx.state, 'add', 'runs/x/notes.md');
  assert.equal(raw('runs/x/notes.md').status, 0, 'files no guard owns commit as before');
  fs.writeFileSync(path.join(ctx.state, 'runs', 'x', 'notes.md'), 'staged\n');
  git(ctx.state, 'add', 'runs/x/notes.md');
  fs.writeFileSync(path.join(ctx.state, 'runs', 'x', 'notes.md'), 'staged, then edited\n');
  assert.match(spawnSync('git', ['-C', ctx.state, 'commit', '-qm', '[x] raw'], { encoding: 'utf8' }).stderr, /staged in part/);
  git(ctx.state, 'checkout', '--', 'runs/x/notes.md');
  git(ctx.state, 'reset', '-q');
  fs.rmSync(hook);
  assert.equal(ticked(ctx, '00').ticked, '00', "goal.mjs's own commits pass, and reinstall a removed hook");
  assert.match(fs.readFileSync(hook, 'utf8'), /guard-staged/);
});

test('a lock taken where no control plane exists leaves no empty state folder behind', () => {
  const repo = bareRepo();
  const state = path.join(tmp('guards-orphan-'), 'state');
  const r = spawnSync(process.execPath, [GOAL, '--repo', repo, '--state-dir', state, 'with-lock', 'registry', '--', 'true'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(state), false);
  const ctx = run('x', repo);
  assert.equal(fs.existsSync(path.join(ctx.state, '.to-auto')), true, 'a real control plane keeps its folder');
});

/** Fixture state committed past every guard, as an older run or another tool left it. */
const fixtureCommit = (ctx, msg) => {
  git(ctx.state, 'add', '-A');
  execFileSync('git', ['-C', ctx.state, 'commit', '-qm', msg], { env: { ...process.env, TO_AUTO_WRITER: '1' } });
};
const ticketText = (status) => `# t\n\n**Status:** ${status}\n**Blocked by:** None\n**Claims:** exclusive: a.ts\n`;
const statusOf = (ctx, slug = 'x') => JSON.parse(fs.readFileSync(path.join(ctx.state, 'runs.json'), 'utf8')).find((r) => r.slug === slug);

test('stop and resume are one commit each; a resume its gate refuses leaves the run stopped, STOP and all', () => {
  const ctx = run();
  forceStatus(ctx, 'reviewing');
  put(ctx, 'tracker/x/issues/01-a.md', ticketText('done'));
  fixtureCommit(ctx, '[x] fixture: reviewing');
  let before = head(ctx);
  assert.equal(goal(ctx, ['stop', 'x', 'owner paused']).status, 0);
  assert.equal(git(ctx.state, 'rev-parse', 'HEAD~1'), before, 'one commit');
  assert.deepEqual([statusOf(ctx).status, statusOf(ctx).stoppedFrom], ['stopped', 'reviewing']);
  // A review-fix ticket dispatched while parked: restoring reviewing is refused, and nothing is written.
  put(ctx, 'tracker/x/issues/01-a.md', ticketText('in-flight'));
  fixtureCommit(ctx, '[x] fixture: review fix in flight');
  before = head(ctx);
  const r = goal(ctx, ['resume', 'x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /build is not complete: 01 \(in-flight\).*the run stays stopped/);
  assert.equal(head(ctx), before);
  assert.equal(fs.existsSync(path.join(ctx.state, 'runs', 'x', 'STOP')), true);
  assert.equal(statusOf(ctx).status, 'stopped');
  put(ctx, 'tracker/x/issues/01-a.md', ticketText('done'));
  fixtureCommit(ctx, '[x] fixture: review fix done');
  before = head(ctx);
  assert.equal(goal(ctx, ['resume', 'x']).status, 0);
  assert.equal(git(ctx.state, 'rev-parse', 'HEAD~1'), before, 'one commit');
  assert.deepEqual([statusOf(ctx).status, statusOf(ctx).stoppedFrom, fs.existsSync(path.join(ctx.state, 'runs', 'x', 'STOP'))], ['reviewing', undefined, false]);
});

test('init is one commit: a failed commit leaves no registration, and a registration left without todo.md is finished', () => {
  const ctx = run();
  const hook = path.join(ctx.state, '.git', 'hooks', 'commit-msg');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const runsBefore = fs.readFileSync(path.join(ctx.state, 'runs.json'), 'utf8');
  assert.equal(goal(ctx, ['init', 'y', 'Y', ...WHO_ARGS]).status, 3);
  assert.equal(fs.readFileSync(path.join(ctx.state, 'runs.json'), 'utf8'), runsBefore, 'no registration');
  assert.equal(fs.existsSync(path.join(ctx.state, 'runs', 'y', 'todo.md')), false);
  fs.rmSync(hook);
  assert.equal(goal(ctx, ['init', 'y', 'Y', ...WHO_ARGS]).status, 0, 'the retry succeeds');
  // The old two-commit init, cut off after registering.
  const data = JSON.parse(fs.readFileSync(path.join(ctx.state, 'runs.json'), 'utf8'));
  data.push({ slug: 'z', objective: 'Z', run_id: 9, status: 'bootstrapping' });
  fs.writeFileSync(path.join(ctx.state, 'runs.json'), JSON.stringify(data));
  fixtureCommit(ctx, '[z] register run 9');
  const r = goal(ctx, ['init', 'z', 'Z', ...WHO_ARGS]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(git(ctx.state, 'log', '-1', '--format=%s'), /\[z\] start run 9 \(registered earlier\)/);
  assert.equal(statusOf(ctx, 'z').run_id, 9, 'not registered twice');
  assert.equal(goal(ctx, ['next', 'z']).status, 0);
});

test('a tick waits for an event that holds the control lock, so neither loses the other\'s ledger write', async () => {
  const ctx = run();
  ticked(ctx, '00');
  const ledger = path.join(ctx.state, 'runs', 'x', 'ledger.md');
  const dir = tmp('guards-race-');
  const barrier = path.join(dir, 'holding');
  // An event that read ledger.md before the tick and writes it back after a pause, all under the control lock.
  const script = `cp ${ledger} ${dir}/snap; touch ${barrier}; sleep 1; cat ${dir}/snap > ${ledger}; echo '- 00:00 [0] concurrent' >> ${ledger}; ${process.execPath} ${GOAL} --repo ${ctx.repo} --state-dir ${ctx.state} commit -m '[x] concurrent' runs/x/ledger.md`;
  const { spawn } = await import('node:child_process');
  const { TO_AUTO_HOME, ...env } = process.env;
  const child = spawn(process.execPath, [GOAL, '--repo', ctx.repo, '--state-dir', ctx.state, 'with-lock', 'control', '--', 'sh', '-c', script], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  while (!fs.existsSync(barrier)) await new Promise((r) => setTimeout(r, 20));
  ticked(ctx, '0');
  assert.equal(await exited, 0);
  const text = fs.readFileSync(ledger, 'utf8');
  assert.match(text, /concurrent/, 'the event line survives');
  assert.equal(nowStage(text), '0a', 'the tick\'s NOW survives');
  assert.equal(git(ctx.state, 'status', '--porcelain'), '');
});

test('stop, resume and event refuse a slug that is not a run folder name before building any path', () => {
  const ctx = run();
  const outside = path.join(path.dirname(ctx.state), 'STOP');
  for (const args of [['stop', '../../x', 'r'], ['resume', '../..'], ['event', '../x', '0', 'e']]) {
    const r = goal(ctx, args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /bad slug/);
  }
  assert.equal(fs.existsSync(outside), false);
});

test('the empty-folder cleanup never removes a state folder that existed before the lock', () => {
  const repo = bareRepo();
  const state = tmp('guards-given-');
  assert.equal(spawnSync(process.execPath, [GOAL, '--repo', repo, '--state-dir', state, 'with-lock', 'registry', '--', 'true']).status, 0);
  assert.equal(fs.existsSync(state), true);
  assert.deepEqual(fs.readdirSync(state), []);
});

test('check --all reports a runs.json of the wrong shape and keeps checking the other control planes', () => {
  const root = tmp('guards-root-');
  const good = run();
  const bad = run();
  fs.renameSync(good.state, path.join(root, 'good'));
  fs.renameSync(bad.state, path.join(root, 'bad'));
  fs.writeFileSync(path.join(root, 'bad', 'runs.json'), '{"slug": "x"}');
  setNow({ state: path.join(root, 'good') }, 'x', '7 build');
  const { TO_AUTO_HOME, ...env } = process.env;
  const r = spawnSync(process.execPath, [GOAL, 'check', '--all', '--state-root', root], { encoding: 'utf8', env });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /bad - RUNS_UNREADABLE .*not a list of runs/);
  assert.match(r.stdout, /good x NOW_AHEAD/);
});

test('the pre-commit hook names a goal.mjs that has moved instead of failing obscurely', () => {
  const copy = path.join(tmp('guards-moved-'), 'goal.mjs');
  fs.copyFileSync(GOAL, copy);
  const ctx = { repo: bareRepo(), state: path.join(tmp('guards-state-'), 'state') };
  const { TO_AUTO_HOME, ...env } = process.env;
  for (const args of [['control'], ['init', 'x', 'X', ...WHO_ARGS]]) assert.equal(spawnSync(process.execPath, [copy, '--repo', ctx.repo, '--state-dir', ctx.state, ...args], { env }).status, 0);
  fs.rmSync(copy);
  put(ctx, 'notes.md', 'n\n');
  git(ctx.state, 'add', 'notes.md');
  const r = spawnSync('git', ['-C', ctx.state, 'commit', '-qm', 'raw'], { encoding: 'utf8', env: { ...env, TO_AUTO_WRITER: '' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /goal\.mjs is gone; any goal\.mjs command reinstalls this hook/);
});

test('two inits of one slug at once: the second is refused under the lock and never overwrites the first run', async () => {
  const ctx = run();
  const dir = tmp('guards-init-race-');
  const barrier = path.join(dir, 'holding');
  const { spawn } = await import('node:child_process');
  const { TO_AUTO_HOME, ...env } = process.env;
  // A holds the registry lock, then inits s inside it (reentrant), after B has passed every check made before the lock.
  const script = `touch ${barrier}; sleep 1; ${process.execPath} ${GOAL} --repo ${ctx.repo} --state-dir ${ctx.state} init s 'objective A' --agent test-session --harness test`;
  const a = spawn(process.execPath, [GOAL, '--repo', ctx.repo, '--state-dir', ctx.state, 'with-lock', 'registry', '--', 'sh', '-c', script], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => a.on('exit', resolve));
  while (!fs.existsSync(barrier)) await new Promise((r) => setTimeout(r, 20));
  const b = goal(ctx, ['init', 's', 'objective B', ...WHO_ARGS]);
  assert.equal(await exited, 0);
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /already exists/);
  assert.match(fs.readFileSync(path.join(ctx.state, 'runs', 's', 'ledger.md'), 'utf8'), /objective A/);
});

test('a resume clears a STOP that git never tracked, and a half-registered run is finished by the session that inits it', () => {
  const ctx = run();
  forceStatus(ctx, 'stopped');
  fixtureCommit(ctx, '[x] fixture: stopped');
  fs.writeFileSync(path.join(ctx.state, 'runs', 'x', 'STOP'), 'by hand\n');
  assert.equal(goal(ctx, ['resume', 'x']).status, 0);
  assert.equal(fs.existsSync(path.join(ctx.state, 'runs', 'x', 'STOP')), false);
  assert.equal(statusOf(ctx).status, 'bootstrapping');
  const data = JSON.parse(fs.readFileSync(path.join(ctx.state, 'runs.json'), 'utf8'));
  data.push({ slug: 'z', objective: 'old', status: 'bootstrapping', agent: 'gone', started: '2020-01-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(ctx.state, 'runs.json'), JSON.stringify(data));
  fixtureCommit(ctx, '[z] register run');
  assert.equal(goal(ctx, ['init', 'z', 'Z', '--agent', 'me', '--harness', 'test']).status, 0);
  const z = statusOf(ctx, 'z');
  assert.deepEqual([z.agent, z.objective, z.run_id, z.started > '2020'], ['me', 'Z', 2, true]);
  assert.match(git(ctx.state, 'log', '-1', '--format=%s'), /\[z\] start run 2 \(registered earlier\)/);
});

test('a helper inside the control plane commits its ticket status from runs/<slug>, with --state-dir and no --repo', () => {
  const ctx = run();
  const dir = path.join(ctx.state, 'runs', 'x');
  fs.mkdirSync(path.join(dir, 'tickets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tickets', '01.status.md'), 'slice 1\n');
  fs.appendFileSync(path.join(dir, 'log.md'), '- note\n');
  const { TO_AUTO_HOME, ...env } = process.env;
  const r = spawnSync(process.execPath, [GOAL, '--state-dir', ctx.state, 'commit', '-m', '[x] t01 status', 'tickets/01.status.md', 'log.md'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(execFileSync('git', ['-C', ctx.state, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});

test('--help after any command prints usage and exits 0; after `run --` it belongs to the command', () => {
  for (const args of [['slug', '--help'], ['init', 'x', '-h'], ['--help']]) {
    const r = spawnSync(process.execPath, [GOAL, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, args.join(' '));
    assert.match(r.stdout, /^usage: goal\.mjs/, args.join(' '));
  }
  const ctx = { repo: bareRepo(), state: path.join(tmp('guards-state-'), 'state') };
  const r = spawnSync(process.execPath, [GOAL, 'run', '--', 'echo', '--help'], { cwd: ctx.repo, encoding: 'utf8' });
  assert.doesNotMatch(r.stdout, /usage: goal\.mjs/);
});

test('tick refuses while a bugs.md entry names no action, and passes once it is ticketed', () => {
  const ctx = run('b');
  const bugs = path.join(ctx.state, 'runs', 'b', 'bugs.md');
  fs.appendFileSync(bugs, '## o-1 a test fails at base\n- pre-existing; leave as a known baseline failure\n\n## t01-1 typo\n- fixed @ 1234567\n');
  handCommit(ctx, '[b] bug');
  const refused = goal(ctx, ['tick', 'b', '00']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /bugs\.md has entries with no action.*## o-1 a test fails at base/);
  assert.doesNotMatch(refused.stderr, /t01-1/);
  fs.writeFileSync(bugs, fs.readFileSync(bugs, 'utf8').replace('known baseline failure', 'known baseline failure → ticket 07'));
  handCommit(ctx, '[b] ticket');
  const ok = goal(ctx, ['tick', 'b', '00']);
  assert.equal(ok.status, 0, ok.stderr);
});

test('a bugs.md entry routed to a ticket reopens once that ticket is done without the entry saying fixed', () => {
  const text = '## t08-a flag misread\n- Status: fix in ticket 08\n\n## t03-a wrong thread\n- Status: fix in ticket 03; fixed @ abc1234\n';
  assert.deepEqual(unresolvedBugs(text), []);
  assert.deepEqual(unresolvedBugs(text, new Set(['03'])), []);
  assert.deepEqual(unresolvedBugs(text, new Set(['08'])), ['## t08-a flag misread']);
});

test('keep-going continues an active run only while its control plane moves, and never a stopped or foreign one', () => {
  const ctx = run('k');
  const home = tmp('guards-home-');
  const keep = (agent) => {
    const r = goal(ctx, ['keep-going', '--agent', agent], { env: { HOME: home, TO_AUTO_HOME: ctx.state, TO_AUTO_SESSIONS: path.join(home, 'sessions') } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const first = keep('test-session');
  assert.equal(first.continue, true);
  assert.match(first.reason, /to-auto run k is .*goal\.mjs next k/);
  assert.equal(keep('test-session').continue, false, 'no commit since the nudge lets the turn end');
  fs.appendFileSync(path.join(ctx.state, 'runs', 'k', 'log.md'), '- progress\n');
  handCommit(ctx, '[k] progress');
  assert.equal(keep('test-session').continue, true, 'a new control-plane commit earns another nudge');
  assert.equal(keep('someone-else').continue, false);
  assert.equal(keep('../etc').continue, false);
  assert.equal(goal(ctx, ['adopt', 'k', '--agent', 'someone-else']).status, 2, 'adopt needs --harness too');
  const adopted = goal(ctx, ['adopt', 'k', '--agent', 'someone-else', '--harness', 'pi']);
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.equal(keep('someone-else').continue, true, 'a session that adopts the run is nudged');
  assert.equal(keep('test-session').continue, false, 'and the session it replaced is not');
  assert.equal(goal(ctx, ['stop', 'k', 'done here']).status, 0);
  assert.equal(keep('test-session').continue, false, 'a stopped run lets the session end');
});
