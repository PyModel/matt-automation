import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STAGES, nowStage } from './goal.mjs';

const GOAL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'goal.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function bareRepo() {
  const repo = tmp('guards-repo-');
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

function run(slug = 'x') {
  const ctx = { repo: bareRepo(), state: path.join(tmp('guards-state-'), 'state') };
  for (const args of [['control'], ['init', slug, 'X']]) {
    const r = goal(ctx, args);
    assert.equal(r.status, 0, r.stderr);
  }
  return ctx;
}

const head = (ctx) => git(ctx.state, 'rev-parse', 'HEAD');
const setNow = (ctx, slug, stage) => {
  const file = path.join(ctx.state, 'runs', slug, 'ledger.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^- stage: .*$/m, `- stage: ${stage}`));
  git(ctx.state, 'commit', '-q', '-am', `[${slug}] now`);
};

// A stand-in for treehouse: logs argv, `get` makes a detached worktree in a pool dir and prints its path.
function fakeTreehouse({ fail = false } = {}) {
  const dir = tmp('guards-th-');
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'treehouse');
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
  assert.equal(th.calls()[0], `${ctx.repo}|get --lease --no-fetch --lease-holder x`);
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
      setNow(ctx, 'x', `${id} stage`);
      setStatus(floor);
      assert.equal(JSON.parse(goal(ctx, ['check', 'x']).stdout).ok, true, `${id} at ${floor}`);
      const below = order[order.indexOf(floor) - 1];
      if (!below) continue;
      setStatus(below);
      assert.deepEqual(JSON.parse(goal(ctx, ['check', 'x']).stdout).problems.map((p) => p.code), ['NOW_AHEAD'], `${id} at ${below}`);
    }
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
  assert.equal(goal(ctx, ['init', 'old', 'Old'], { env: old }).status, 0);
  assert.equal(goal(ctx, ['init', 'new', 'New']).status, 0);
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
    goal(ctx, ['init', 'x', 'X']);
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

test('nowStage reads the first token of the NOW stage line only', () => {
  assert.equal(nowStage('# t\n\n## NOW\n- stage: 4b challenge\n\n## Events\n- stage: 9\n'), '4b');
  assert.equal(nowStage('# t\n\n## NOW\n- next: x\n'), null);
});
