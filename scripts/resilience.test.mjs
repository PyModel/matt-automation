import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  configure, controlDir, repoId, ensureControl, prepare, land, cleanup, preflight, discoverCheck,
  init, recordModel, compact, supervise, remoteGuard, isLinkedWorktree, ROOT,
} from './goal.mjs';

const GOAL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'goal.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function bareRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-layout-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  return repo;
}

function useState() {
  configure();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-state-'));
  process.env.TO_AUTO_HOME = state;
  return state;
}

function fileList(dir) {
  return execFileSync('find', [dir, '-print'], { encoding: 'utf8' });
}

test('state dir precedence is --state-dir, then TO_AUTO_HOME, then ~/.local/state/to-auto/<repo-id>', () => {
  const repo = bareRepo();
  const flag = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-flag-'));
  const env = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-env-'));
  process.env.TO_AUTO_HOME = env;
  configure({ stateDir: flag });
  assert.equal(controlDir(repo), path.resolve(flag));
  configure();
  assert.equal(controlDir(repo), path.resolve(env));
  delete process.env.TO_AUTO_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(controlDir(repo), path.join(home, '.local', 'state', 'to-auto', repoId(repo)));
  } finally {
    process.env.HOME = prev;
  }
});

test('worktrees of one clone share the default state dir; another clone does not', () => {
  delete process.env.TO_AUTO_HOME;
  configure();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const repo = bareRepo();
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-wt-'));
    git(repo, 'worktree', 'add', '-q', wt, 'HEAD');
    assert.equal(controlDir(repo), controlDir(wt));
    assert.notEqual(controlDir(repo), controlDir(bareRepo()));
  } finally {
    process.env.HOME = prev;
  }
});

test('a state dir inside the repo is refused', () => {
  const repo = bareRepo();
  configure({ stateDir: path.join(repo, 'state') });
  assert.throws(() => ensureControl(repo), /inside the repo/);
});

test('main checkout: private history, no goal/control branch, no exclude edit', () => {
  const repo = bareRepo();
  const state = useState();
  const exclude = path.join(repo, '.git/info/exclude');
  const before = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : null;
  const control = ensureControl(repo);
  assert.equal(fs.realpathSync(control), fs.realpathSync(state));
  assert.equal(git(repo, 'branch', '--list', 'goal/control'), '');
  assert.equal(fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : null, before);
  assert.equal(git(control, 'log', '-1', '--format=%s'), 'Init to-auto control plane');
  assert.notEqual(git(control, 'rev-parse', '--path-format=absolute', '--git-common-dir'), git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
});

test('linked worktree with a read-only common dir is cloned into the state folder and brought back', () => {
  const repo = bareRepo();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-wt-'));
  git(repo, 'worktree', 'add', '-q', '-b', 'caller', wt, 'main');
  const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const before = fileList(common);
  useState();
  fs.chmodSync(common, 0o555);
  try {
    assert.equal(isLinkedWorktree(wt), true);
    const info = prepare(wt);
    assert.equal(info.cloned, true);
    assert.equal(fileList(common), before);
    fs.writeFileSync(path.join(info.workspace, 'a.txt'), 'a\n');
    git(info.workspace, 'add', 'a.txt');
    git(info.workspace, 'commit', '-q', '-m', 't01 add a');
    const pending = land(wt, 'add-a');
    assert.match(pending.returned, /return\.bundle$/);
    assert.equal(git(wt, 'log', '-1', '--format=%s'), 'init');
    fs.chmodSync(common, 0o755);
    const brought = land(wt, 'add-a');
    assert.equal(git(wt, 'rev-parse', 'HEAD'), brought.returned);
    assert.equal(git(wt, 'log', '-1', '--format=%s'), 't01 add a');
    assert.match(brought.summary, /t01 /);
  } finally {
    fs.chmodSync(common, 0o755);
  }
});

test('a writable linked worktree is not cloned', () => {
  const repo = bareRepo();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-wt-'));
  git(repo, 'worktree', 'add', '-q', '-b', 'caller', wt, 'main');
  useState();
  const info = prepare(wt);
  assert.equal(info.cloned, false);
  assert.equal(fs.realpathSync(info.workspace), fs.realpathSync(wt));
});

test('a repo with no remote still starts, and --no-remote forbids a remote but not a local fetch', () => {
  const repo = bareRepo();
  useState();
  assert.equal(git(repo, 'remote'), '');
  configure({ noRemote: true, base: 'HEAD', targetBranch: 'main', stateDir: process.env.TO_AUTO_HOME });
  const result = supervise(repo);
  assert.equal(result.supervisor.noRemote, true);
  assert.equal(result.cloned, false);
  assert.throws(() => remoteGuard(['push', 'origin', 'main']), /--no-remote forbids git push/);
  assert.throws(() => remoteGuard(['fetch']), /--no-remote forbids git fetch/);
  remoteGuard(['fetch', result.workspace, 'HEAD']);
  remoteGuard(['status']);
});

test('a shared clone keeps its own state and does not write the source git dir', () => {
  const repo = bareRepo();
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-shared-'));
  fs.rmSync(shared, { recursive: true });
  execFileSync('git', ['clone', '--shared', '--quiet', repo, shared], { stdio: 'ignore' });
  const before = fileList(path.join(repo, '.git'));
  delete process.env.TO_AUTO_HOME;
  configure();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.notEqual(controlDir(repo), controlDir(shared));
    ensureControl(shared);
    prepare(shared);
    assert.equal(fileList(path.join(repo, '.git')), before);
    assert.equal(git(repo, 'branch', '--list', 'goal/control'), '');
  } finally {
    process.env.HOME = prev;
  }
});

test('no helper agents are recorded, and a named worker model is logged per role', () => {
  const repo = bareRepo();
  const state = useState();
  ensureControl(repo);
  init(repo, 'solo', 'Solo', { noHelpers: true });
  const none = JSON.parse(fs.readFileSync(path.join(state, 'runs/solo/models.json'), 'utf8'));
  assert.equal(none.helpers, 'none');
  assert.deepEqual(none.roles, {});
  init(repo, 'helped', 'Helped', { workerModel: 'provider/model' });
  recordModel(repo, 'helped', 'implementer', 'provider/model-used');
  const used = JSON.parse(fs.readFileSync(path.join(state, 'runs/helped/models.json'), 'utf8'));
  assert.equal(used.workerModel, 'provider/model');
  assert.equal(used.roles.implementer, 'provider/model-used');
  assert.match(fs.readFileSync(path.join(state, 'runs/helped/ledger.md'), 'utf8'), /implementer used provider\/model-used/);
});

test('--allow fails at startup when a planned write is outside the list', () => {
  const repo = bareRepo();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-state-'));
  configure({ stateDir: state, allow: [state] });
  assert.throws(() => preflight(repo), /refusing to start: writes outside the allow list/);
  configure({ stateDir: state, allow: [state, repo] });
  assert.equal(preflight(repo).ok, true);
});

test('preflight does not require git 2.42 and names an unwritable state dir', () => {
  const repo = bareRepo();
  useState();
  assert.equal(fs.readFileSync(GOAL, 'utf8').includes('2.42'), false);
  assert.equal(fs.readFileSync(GOAL, 'utf8').includes('worktree add --orphan'), false);
  const report = preflight(repo);
  assert.match(report.gitRequirement, /no minimum version/);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-ro-'));
  fs.chmodSync(parent, 0o555);
  try {
    configure();
    process.env.TO_AUTO_HOME = path.join(parent, 'state');
    assert.throws(() => preflight(repo), /to-auto cannot start:[\s\S]*not writable/);
  } finally {
    fs.chmodSync(parent, 0o755);
  }
});

test('check-command: objective overrides AGENTS.md, which overrides Makefile and package.json', () => {
  const repo = bareRepo();
  fs.writeFileSync(path.join(repo, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  assert.deepEqual(discoverCheck(repo), { command: 'npm test', source: 'package.json' });
  fs.writeFileSync(path.join(repo, 'Makefile'), 'test:\n\ttrue\n');
  assert.deepEqual(discoverCheck(repo), { command: 'make test', source: 'Makefile' });
  fs.writeFileSync(path.join(repo, 'Makefile'), 'check:\n\ttrue\n');
  assert.deepEqual(discoverCheck(repo), { command: 'make check', source: 'Makefile' });
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'check: npm run ci\n');
  assert.deepEqual(discoverCheck(repo), { command: 'npm run ci', source: 'AGENTS.md' });
  assert.deepEqual(discoverCheck(repo, 'ship check: make verify'), { command: 'make verify', source: 'objective' });
});

test('supervisor land maps items to commits on the caller branch and does not create goal/control', () => {
  const repo = bareRepo();
  const state = useState();
  const base = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 't01 add a');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const status = path.join(state, 'status');
  configure({ base, targetBranch: 'main', statusFile: status, noRemote: true, stateDir: state });
  const run = supervise(repo);
  assert.equal(run.supervisor.targetBranch, 'main');
  assert.equal(run.supervisor.noRemote, true);
  const landed = land(repo, 'add-a');
  assert.match(landed.summary, new RegExp(`t01 ${sha}`));
  assert.match(fs.readFileSync(status, 'utf8'), new RegExp(`t01 ${sha}`));
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(repo, 'branch', '--list', 'goal/control'), '');
});

test('compact saves NOW before memory is compressed and refuses an empty NOW', () => {
  const repo = bareRepo();
  useState();
  ensureControl(repo);
  init(repo, 'x', 'X');
  const saved = compact(repo, 'x');
  assert.match(saved.resume, /ledger\.md$/);
  assert.match(fs.readFileSync(saved.resume, 'utf8'), /\[compact\] NOW saved/);
  fs.writeFileSync(saved.resume, '# to-auto\n\n## NOW\n\n## Events\n');
  assert.throws(() => compact(repo, 'x'), /NOW is empty/);
});

test('cleanup deletes the state folder and leaves branches and exclude untouched', () => {
  const repo = bareRepo();
  const state = useState();
  ensureControl(repo);
  const exclude = path.join(repo, '.git/info/exclude');
  const beforeExclude = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : null;
  const beforeBranches = git(repo, 'branch', '--list');
  assert.match(cleanup(repo), /^removed /);
  assert.equal(fs.existsSync(state), false);
  assert.equal(git(repo, 'branch', '--list'), beforeBranches);
  assert.equal(fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : null, beforeExclude);
  assert.equal(git(repo, 'branch', '--list', 'goal/control'), '');
});

test('always-on text is SKILL.md plus CORE.md and is no larger than the previous always-on set', () => {
  const root = ROOT;
  const skill = fs.readFileSync(path.join(root, 'to-auto/SKILL.md'), 'utf8');
  const core = fs.readFileSync(path.join(root, 'to-auto/CORE.md'), 'utf8');
  // SKILL.md + CONTRACT + CONTROL + KUN + LEDGER + PIPELINE + FLOWS + PITFALLS + INTEGRATION at cleanup@cd0b403.
  const before = 72802;
  assert.ok(Buffer.byteLength(skill) + Buffer.byteLength(core) <= before, 'always-on text grew');
  assert.match(skill, /CORE\.md/);
  assert.doesNotMatch(skill, /Always-on references/);
});

test('scripts resolve their own root from any cwd', () => {
  const r = spawnSync(process.execPath, [GOAL, 'root'], { cwd: '/tmp', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), ROOT);
});
