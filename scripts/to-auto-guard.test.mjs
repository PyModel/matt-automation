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

const INCIDENT = 'cd /Users/panda/Projects/mad-seafood-main && git worktree add -q -b claude/tmx-705-plate-make-time /Users/panda/Projects/wt-tmx-705 origin/main && cd /Users/panda/Projects/wt-tmx-705 && python3 - <<\'EOF\'\nprint(1)\nEOF';

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
  assert.match(w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/to-auto complete the master plan' }), /to-auto session s1: pass `--agent s1`/);
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
  for (const command of [INCIDENT, 'git -C /r worktree add ../wt main', 'gh pr create --fill', 'gh pr merge 785 --squash', 'git push -u origin HEAD', 'git switch -c claude/x', 'git checkout -b claude/x']) assert.equal(w.bash(command), 'deny', command);
  assert.equal(w.decision('Agent', { prompt: 'fix TMX-393' }), 'deny');
  const reason = w.hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {} }).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /goal\.mjs init <slug>/);
  for (const command of ['git status', 'git log --oneline -3 origin/main', 'gh pr view 785 --json state', `node ${GOAL} next x`, `node ${GOAL} init x "X"`, `node ${GOAL} worktree get x`]) assert.equal(w.bash(command), 'allow', command);
});

test('an active run allows PRs and helpers but never a hand-typed worktree; a stopped run counts as none', () => {
  const w = world();
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '  /to-auto x' });
  w.goal('control');
  w.goal('init', 'x', 'X');
  assert.equal(w.bash('gh pr create --draft --fill'), 'allow');
  assert.equal(w.decision('Agent', { prompt: 'implement ticket 01' }), 'allow');
  assert.equal(w.bash(INCIDENT), 'deny');
  assert.match(w.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: INCIDENT } }).hookSpecificOutput.permissionDecisionReason, /goal\.mjs worktree get/);
  w.goal('stop', 'x', 'paused');
  assert.equal(w.bash('gh pr create --fill'), 'deny');
  assert.equal(w.decision('Agent', { prompt: 'x' }), 'deny');
});

test('the mark is dropped once the run this session registered is done or stopped and nothing is active', () => {
  const w = world();
  w.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/to-auto x' });
  w.goal('control');
  w.goal('init', 'x', 'X', '--agent', 's1');
  assert.equal(w.bash(INCIDENT), 'deny');
  w.goal('init', 'y', 'Y', '--agent', 'someone-else');
  w.goal('stop', 'x', 'done for now');
  assert.equal(w.bash(INCIDENT), 'deny', 'another run is still active in the repo');
  w.goal('stop', 'y', 'paused');
  assert.equal(w.bash(INCIDENT), 'allow');
  assert.deepEqual(fs.readdirSync(w.env.TO_AUTO_SESSIONS), []);
});

test('bad input and odd session ids are ignored', () => {
  const w = world();
  const r = spawnSync(process.execPath, [GUARD], { env: w.env, input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(w.hook({ session_id: '../x', hook_event_name: 'UserPromptSubmit', prompt: '/to-auto x' }), null);
  assert.deepEqual(fs.readdirSync(w.env.TO_AUTO_SESSIONS), []);
});
