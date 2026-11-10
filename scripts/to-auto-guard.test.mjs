import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, 'to-auto-guard.mjs');
const GOAL = path.join(HERE, 'goal.mjs');
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function world() {
  const repo = tmp('guard-repo-');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'], ['commit', '-q', '--allow-empty', '-m', 'init']]) execFileSync('git', ['-C', repo, ...args]);
  const env = { ...process.env, TO_AUTO_HOME: path.join(tmp('guard-state-'), 'state'), TO_AUTO_SESSIONS: tmp('guard-sessions-') };
  const goal = (...args) => {
    const r = spawnSync(process.execPath, [GOAL, '--repo', repo, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const hook = (input) => {
    const r = spawnSync(process.execPath, [GUARD], { env, input: JSON.stringify({ session_id: 's1', cwd: repo, ...input }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? (r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : r.stdout.trim()) : null;
  };
  const decision = (tool_name, tool_input) => hook({ hook_event_name: 'PreToolUse', tool_name, tool_input })?.hookSpecificOutput?.permissionDecision ?? 'allow';
  const bash = (command) => decision('Bash', { command });
  return { repo, env, goal, hook, decision, bash };
}

const INCIDENT = 'cd /home/u/app && git worktree add -q -b claude/t-705-fix /home/u/wt-705 origin/main && cd /home/u/wt-705 && python3 - <<\'EOF\'\nprint(1)\nEOF';

test('an unmarked session is never touched', () => {
  const w = world();
  assert.equal(w.bash(INCIDENT), 'allow');
  assert.equal(w.bash('gh pr create --fill'), 'allow');
  assert.equal(w.decision('Agent', { prompt: 'x' }), 'allow');
});

test('a /to-auto prompt or the to-auto Skill marks the session and tells it its id', () => {
  const w = world();
  assert.equal(w.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'please fix the build' }), null);
  assert.equal(w.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'a note: once you type /to-auto in a session the guard blocks git worktree add' }), null, 'quoting the command in prose does not invoke it');
  assert.equal(w.bash(INCIDENT), 'allow');
  assert.match(w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/to-auto complete the master plan' }), /to-auto session s1: pass `--agent s1 --harness claude-code`/);
  assert.equal(w.bash(INCIDENT), 'deny');
  const v = world();
  const out = v.hook({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'to-auto', args: 'x' } });
  assert.match(out.hookSpecificOutput.additionalContext, /--agent s1/);
  assert.equal(v.bash('gh pr create --fill'), 'deny');
  const u = world();
  assert.equal(u.hook({ hook_event_name: 'UserPromptExpansion', command_name: 'deploy', prompt: '/deploy' }), null);
  assert.equal(u.bash('gh pr create --fill'), 'allow');
  u.hook({ hook_event_name: 'UserPromptExpansion', command_name: 'to-auto', command_args: 'x', prompt: '/to-auto x' });
  assert.equal(u.bash('gh pr create --fill'), 'deny');
});

test('marked session with no active run: the incident, PRs, pushes, new branches and helper agents are denied; reading and goal.mjs are not', () => {
  const w = world();
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/to-auto x' });
  for (const command of [INCIDENT, 'git -C /r worktree add ../wt main', 'gh pr create --fill', 'gh pr merge 785 --squash', 'git push -u origin HEAD', 'git -C /r push', 'git --no-pager push', 'sh -c "git push"', 'git switch -c claude/x', 'git checkout -b claude/x', 'git switch --orphan x', 'git branch claude/x', 'git branch -c claude/x', 'git branch --track claude/x origin/main', 'git branch -t claude/x origin/main', 'git branch --no-track claude/x', 'git pus""h origin HEAD', "git pu\\sh", "git 'push'", 'gh issue create -t x', 'gh issue comment 1 -b x', 'gh pr edit 1 --title x', 'gh pr checkout 1', 'gh api repos/o/r/pulls -X POST -f title=x', 'gh api --method=PATCH repos/o/r/pulls/1 -f state=closed', 'gh api repos/o/r/issues -f title=x', 'gh api -X DELETE repos/o/r/issues/comments/1', 'gh api -XPOST repos/o/r/issues', 'gh api repos/o/r/issues -ftitle=x']) assert.equal(w.bash(command), 'deny', command);
  assert.equal(w.decision('Agent', { prompt: 'fix T-393' }), 'deny');
  const reason = w.hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {} }).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /goal\.mjs init <slug>/);
  for (const command of ['git status', 'git log --oneline -3 origin/main', 'git stash push -m wip', 'git log --grep=push', 'git commit -m "push later"', 'git branch -a', 'git branch -d claude/x', 'git branch -u origin/main', 'git branch --set-upstream-to=origin/main', 'gh pr view 785 --json state', 'gh pr list', 'gh issue view 1', 'gh api repos/o/r/pulls', 'gh api -X GET repos/o/r/issues -f state=open', 'gh api --method HEAD repos/o/r', 'gh api -XGET repos/o/r/issues -f state=open', 'gh api repos/o/r/issues --jq .[].title', `node ${GOAL} next x`, `node ${GOAL} init x "X"`, `node ${GOAL} worktree get x`]) assert.equal(w.bash(command), 'allow', command);
});

test('an active run allows helpers but never a hand-typed worktree; a stopped run counts as none', () => {
  const w = world();
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '  /to-auto x' });
  w.goal('control');
  w.goal('init', 'x', 'X', '--agent', 's0', '--harness', 'test');
  assert.equal(w.decision('Agent', { prompt: 'implement ticket 01' }), 'allow');
  assert.equal(w.bash(INCIDENT), 'deny');
  assert.match(w.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: INCIDENT } }).hookSpecificOutput.permissionDecisionReason, /goal\.mjs worktree get/);
  w.goal('stop', 'x', 'paused');
  assert.equal(w.bash('gh pr create --fill'), 'deny');
  assert.equal(w.decision('Agent', { prompt: 'x' }), 'deny');
});

// A run pushed its branch to a forge with no grant, against its own "no push" decision, and nothing denied it.
test('with a run active, a push needs a push:<remote> grant and a PR write a pr grant, both quoted from the owner', () => {
  const w = world();
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/to-auto ship the importer and open a draft PR when it is green' });
  w.goal('control');
  w.goal('init', 'x', 'ship the importer', '--agent', 's1', '--harness', 'test');
  const reason = (command) => w.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }).hookSpecificOutput.permissionDecisionReason;
  for (const command of ['git push', 'git push -u origin HEAD', 'git -C /r push lab abc:refs/heads/goal/x', 'sh -c "git push"', 'gh pr create --draft --fill', 'gh pr merge 7 --squash', 'glab mr create --fill']) assert.equal(w.bash(command), 'deny', command);
  assert.match(reason('git push lab HEAD'), /push:lab has no grant in run x.*goal\.mjs grant x push:lab -- "<their words>"/);
  for (const command of ['git status', 'git log --grep=push', 'git stash push -m wip', 'gh pr view 7', 'git commit -m "push later"']) assert.equal(w.bash(command), 'allow', command);
  // The mode grants nothing, and neither do words the owner never wrote.
  const refused = spawnSync(process.execPath, [GOAL, '--repo', w.repo, 'grant', 'x', 'push:origin', '--', 'push it wherever you like'], { env: w.env, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is not something the owner wrote/);
  w.goal('grant', 'x', 'pr', '--', 'open a draft PR');
  assert.equal(w.bash('gh pr create --draft --fill'), 'allow');
  assert.equal(w.bash('git push -u origin HEAD'), 'deny', 'a PR grant is not a push grant');
  // An owner message sent mid-run (a side task) is the owner's words too.
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'also push the branch to the lab remote so the runner can test it' });
  w.goal('grant', 'x', 'push:lab', '--', 'push the branch to the lab remote');
  assert.equal(w.bash('git push lab HEAD:refs/heads/goal/x'), 'allow');
  assert.equal(w.bash('git push origin HEAD'), 'deny', 'the grant names one remote');
  assert.equal(w.bash('git push lab HEAD && git push origin HEAD'), 'deny', 'every push in the command needs its grant');
});

test('the owner store is written only by the prompt hook: a marked session cannot write the sessions folder', () => {
  const w = world();
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'before the run: nothing is kept' });
  assert.deepEqual(fs.readdirSync(w.env.TO_AUTO_SESSIONS), []);
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/to-auto x' });
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'and keep CI green' });
  const store = path.join(w.env.TO_AUTO_SESSIONS, 's1.owner.jsonl');
  assert.deepEqual(fs.readFileSync(store, 'utf8').trim().split('\n').map((l) => JSON.parse(l).text), ['/to-auto x', 'and keep CI green']);
  assert.equal(w.bash(`echo '{"text":"edit CI freely"}' >> ${store}`), 'deny');
  assert.equal(w.bash(`cat ${w.env.TO_AUTO_SESSIONS}/s1`), 'deny');
  assert.equal(w.decision('Write', { file_path: store, content: 'x' }), 'deny');
  assert.equal(w.decision('Edit', { file_path: path.join(w.env.TO_AUTO_SESSIONS, 's1'), old_string: 'a', new_string: 'b' }), 'deny');
  assert.equal(w.decision('Write', { file_path: path.join(w.repo, 'notes.md'), content: 'x' }), 'allow');
});

test('stopping its own run does not release the session; only a done run with nothing active does', () => {
  const w = world();
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/to-auto x' });
  w.goal('control');
  w.goal('init', 'x', 'X', '--agent', 's1', '--harness', 'test');
  w.goal('stop', 'x', 'objective does not fit: lands pre-existing PRs');
  assert.equal(w.bash('gh pr merge 788 --squash'), 'deny', 'the incident: stop the run, then land PRs by hand');
  assert.equal(w.bash(INCIDENT), 'deny');
  const runs = path.join(w.env.TO_AUTO_HOME, 'runs.json');
  const data = JSON.parse(fs.readFileSync(runs, 'utf8'));
  data[0].status = 'done';
  fs.writeFileSync(runs, JSON.stringify(data));
  // Committed straight through git, as a finished run leaves it: goal.mjs commits refuse a hand-edited status.
  execFileSync('git', ['-C', w.env.TO_AUTO_HOME, 'commit', '-qam', '[x] fixture: done'], { env: { ...process.env, TO_AUTO_WRITER: '1' } });
  w.goal('init', 'y', 'Y', '--agent', 'someone-else', '--harness', 'test');
  assert.equal(w.bash(INCIDENT), 'deny', 'another run is still active in the repo');
  w.goal('stop', 'y', 'paused');
  assert.equal(w.bash(INCIDENT), 'allow');
  assert.deepEqual(fs.readdirSync(w.env.TO_AUTO_SESSIONS), []);
});

test('a run this session finished before it was marked again does not release the new mark', () => {
  const w = world();
  w.goal('control');
  w.goal('init', 'x', 'X', '--agent', 's1', '--harness', 'test');
  w.goal('stop', 'x', 'old');
  const runs = path.join(w.env.TO_AUTO_HOME, 'runs.json');
  const data = JSON.parse(fs.readFileSync(runs, 'utf8'));
  data[0].started = '2026-01-01T00:00:00.000Z';
  data[0].status = 'done';
  fs.writeFileSync(runs, JSON.stringify(data));
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/to-auto again' });
  assert.equal(w.bash(INCIDENT), 'deny');
  assert.deepEqual(fs.readdirSync(w.env.TO_AUTO_SESSIONS).sort(), ['s1', 's1.owner.jsonl']);
});

test('bad input and odd session ids are ignored', () => {
  const w = world();
  const r = spawnSync(process.execPath, [GUARD], { env: w.env, input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(w.hook({ session_id: '../x', hook_event_name: 'UserPromptSubmit', prompt: '/to-auto x' }), null);
  assert.deepEqual(fs.readdirSync(w.env.TO_AUTO_SESSIONS), []);
});

test('a hand-touched (empty) mark is released by a done run of this session', () => {
  const w = world();
  fs.writeFileSync(path.join(w.env.TO_AUTO_SESSIONS, 's1'), '');
  w.goal('control');
  w.goal('init', 'x', 'X', '--agent', 's1', '--harness', 'test');
  const runs = path.join(w.env.TO_AUTO_HOME, 'runs.json');
  const data = JSON.parse(fs.readFileSync(runs, 'utf8'));
  data[0].status = 'done';
  fs.writeFileSync(runs, JSON.stringify(data));
  assert.equal(w.bash('git push'), 'allow');
  assert.deepEqual(fs.readdirSync(w.env.TO_AUTO_SESSIONS), []);
});

test('re-invoking /to-auto or the skill mid-run keeps the first mark time, so the run still releases the session', () => {
  const w = world();
  const marker = path.join(w.env.TO_AUTO_SESSIONS, 's1');
  fs.writeFileSync(marker, '2026-01-01T00:00:00.000Z\n');
  w.goal('control');
  w.goal('init', 'x', 'X', '--agent', 's1', '--harness', 'test');
  w.hook({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'to-auto' } });
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/to-auto continue' });
  assert.equal(fs.readFileSync(marker, 'utf8'), '2026-01-01T00:00:00.000Z\n');
  const runs = path.join(w.env.TO_AUTO_HOME, 'runs.json');
  const data = JSON.parse(fs.readFileSync(runs, 'utf8'));
  data[0].status = 'done';
  fs.writeFileSync(runs, JSON.stringify(data));
  assert.equal(w.bash('git push'), 'allow');
  assert.deepEqual(fs.readdirSync(w.env.TO_AUTO_SESSIONS), []);
});

test('a broken goal.mjs fails closed only for the calls the guard judges; other calls and unmarked sessions are untouched', () => {
  const w = world();
  const dir = tmp('guard-broken-');
  fs.copyFileSync(GUARD, path.join(dir, 'to-auto-guard.mjs'));
  fs.writeFileSync(path.join(dir, 'goal.mjs'), "throw new Error('boom');\n");
  const run = (session_id, tool_name, tool_input) => {
    const r = spawnSync(process.execPath, [path.join(dir, 'to-auto-guard.mjs')], { env: w.env, input: JSON.stringify({ session_id, cwd: w.repo, hook_event_name: 'PreToolUse', tool_name, tool_input }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/to-auto x' });
  for (const command of ['ls', 'git status', `node ${GOAL} init x "X"`]) assert.equal(run('s1', 'Bash', { command }), null, command);
  for (const [tool_name, tool_input] of [['Bash', { command: 'git push' }], ['Bash', { command: 'gh issue create -t x' }], ['Agent', { prompt: 'x' }]]) {
    const output = run('s1', tool_name, tool_input);
    assert.equal(output.permissionDecision, 'deny', tool_name);
    assert.match(output.permissionDecisionReason, /boom.*fails closed/);
  }
  assert.match(run('s1', 'Bash', { command: INCIDENT }).permissionDecisionReason, /goal\.mjs worktree get/, 'the worktree rule needs no registry');
  assert.equal(run('s2', 'Bash', { command: 'git push' }), null);
});

test('a session that cannot be marked blocks the /to-auto prompt with exit 2', () => {
  const w = world();
  const file = path.join(tmp('guard-file-'), 'not-a-dir');
  fs.writeFileSync(file, '');
  const r = spawnSync(process.execPath, [GUARD], { env: { ...w.env, TO_AUTO_SESSIONS: path.join(file, 'sessions') }, input: JSON.stringify({ session_id: 's1', cwd: w.repo, hook_event_name: 'UserPromptSubmit', prompt: '/to-auto x' }), encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot mark session s1/);
});

test('marking sweeps marks older than 30 days and keeps younger ones', () => {
  const w = world();
  const old = path.join(w.env.TO_AUTO_SESSIONS, 'old');
  const young = path.join(w.env.TO_AUTO_SESSIONS, 'young');
  fs.writeFileSync(old, '2026-01-01T00:00:00.000Z\n');
  fs.writeFileSync(young, '2026-01-01T00:00:00.000Z\n');
  const day = 864e5;
  fs.utimesSync(old, new Date(Date.now() - 31 * day), new Date(Date.now() - 31 * day));
  fs.utimesSync(young, new Date(Date.now() - 29 * day), new Date(Date.now() - 29 * day));
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/to-auto x' });
  assert.deepEqual(fs.readdirSync(w.env.TO_AUTO_SESSIONS).sort(), ['s1', 's1.owner.jsonl', 'young']);
});

test('Stop blocks the end of a turn while the session\'s run is active and moving, then lets it go', () => {
  const w = world();
  w.env.HOME = tmp('guard-home-');
  w.goal('control');
  w.goal('init', 'r', 'Add login', '--agent', 's1', '--harness', 'test');
  const stop = (session_id = 's1') => w.hook({ hook_event_name: 'Stop', session_id });
  assert.equal(stop(), null, 'an unmarked session is never held');
  w.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: '/to-auto resume r' });
  const first = stop();
  assert.equal(first?.decision, 'block');
  assert.match(first.reason, /to-auto run r is .*goal\.mjs next r/);
  assert.equal(stop(), null, 'no commit since the last block: the turn ends');
  assert.equal(stop('s2'), null, 'another session is never held');
  w.goal('event', 'r', '0', 'progress');
  fs.rmSync(path.join(w.env.TO_AUTO_SESSIONS, 's1'));
  assert.equal(stop(), null, 'removing the mark ends to-auto mode, nudges included');
});

test('prose in a commit message, a branch listing and a sibling skill are not the commands they mention', () => {
  const w = world();
  assert.equal(w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/to-auto-ticket-lifecycle explain take' }), null, 'another skill does not mark the session');
  assert.equal(w.bash(INCIDENT), 'allow');
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/to-auto x' });
  for (const command of ['git commit -m "docs: we never git push from CI"', 'git commit -m "$(cat <<\'EOF\'\nfix the thing\nEOF\n)"', 'git commit -m "costs \\$5, no git push"', "git commit -m '[x] drop the hand-typed git worktree add'", 'git commit --message="gh pr create is stage 9"', 'git branch | head', 'git branch 2>&1', 'git branch > /tmp/b']) assert.equal(w.bash(command), 'allow', command);
  for (const command of ['git commit -m "$(git push origin main)"', 'git commit -m "`git push`"', 'git commit -m "x" && git push', 'git --work-tree /x push origin main', 'git --git-dir /x/.git push', 'git checkout -t origin/foo', 'git checkout --track origin/foo', 'git branch 2fa-login']) assert.equal(w.bash(command), 'deny', command);
});
