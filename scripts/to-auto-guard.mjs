#!/usr/bin/env node
// Claude Code hook that holds a /to-auto session to the pipeline, whether or not the agent cooperates.
//   UserPromptSubmit with /to-auto, UserPromptExpansion of /to-auto, or PreToolUse on Skill to-auto: mark the session.
//   PreToolUse on Bash or Agent in a marked session: deny branch, worktree, push, PR and helper-agent work while the
//   repo has no active run (registered, not done, dry-run or stopped), and deny a hand-typed `git worktree add` always:
//   run worktrees come from `goal.mjs worktree get`. Unmarked sessions are never touched, and the mark is dropped once a
//   run this session registered is done or stopped with no run active.
// Markers live in `$TO_AUTO_SESSIONS`, else ~/.local/state/to-auto-sessions/<session_id>, outside every state dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './goal.mjs';

// Only a prompt that starts with the command invokes it; quoting `/to-auto` in prose does not.
const INVOKED = /^\s*[/$]to-auto\b/;
const RAW_WORKTREE = /\bgit\b[^;&|\n]*\bworktree\s+add\b/;
const BEFORE_INIT = /\bgit\b[^;&|\n]*\b(push|switch\s+(-c|-C|--create)|checkout\s+-[bB])\b|\bgh\s+pr\s+(create|merge|ready)\b/;
const INACTIVE = new Set(['done', 'dry-run', 'stopped']);

const sessions = () => process.env.TO_AUTO_SESSIONS || path.join(os.homedir(), '.local', 'state', 'to-auto-sessions');

function mark(id) {
  fs.mkdirSync(sessions(), { recursive: true });
  fs.writeFileSync(path.join(sessions(), id), `${new Date().toISOString()}\n`);
  return `to-auto session ${id}: pass \`--agent ${id}\` to \`goal.mjs init\`. Work already in this session (earlier PRs, worktrees, plans) is not part of the run; follow the stage \`goal.mjs next\` names. Until \`init\` registers the run, branch, worktree, push, PR and helper-agent calls are denied by this guard.`;
}

/** The active runs registered for the repo at `cwd`; null when `cwd` is not a git repo. */
function activeRuns(cwd) {
  let dir;
  try { dir = stateDir(cwd); } catch { return null; }
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'runs.json'), 'utf8')).filter((r) => !INACTIVE.has(r.status));
  } catch {
    return [];
  }
}

/** True once a run this session registered after it was marked (`init --agent <session_id>`) is over and no run is active. */
function finished(cwd, id, markedAt) {
  let runs;
  try { runs = JSON.parse(fs.readFileSync(path.join(stateDir(cwd), 'runs.json'), 'utf8')); } catch { return false; }
  const mine = (r) => r.agent === id && Date.parse(r.started) >= markedAt && INACTIVE.has(r.status);
  return runs.some(mine) && !runs.some((r) => !INACTIVE.has(r.status));
}

/** Why this tool call breaks the pipeline, or null. */
export function verdict(input) {
  // ponytail: the repo is the hook's cwd; a command that cd's into another repo is judged by the session's repo.
  const { tool_name: tool, tool_input: args = {}, cwd = process.cwd() } = input;
  const command = tool === 'Bash' ? String(args.command ?? '') : '';
  const helper = tool === 'Agent' || tool === 'Task';
  if (RAW_WORKTREE.test(command)) return 'to-auto: run and ticket worktrees come only from `goal.mjs worktree get <slug> [NN]`, never a hand-typed `git worktree add` (PIPELINE.md § Isolation).';
  if (!helper && !BEFORE_INIT.test(command)) return null;
  const runs = activeRuns(cwd);
  if (runs === null || runs.length) return null;
  return `to-auto: no active run is registered for this repo, so this ${helper ? 'helper agent' : 'command'} is outside the pipeline. Follow the stage \`goal.mjs next <slug>\` names; at stage 0 register the run with \`goal.mjs init <slug> "<objective>"\`. A refused objective ends the invocation, it is never worked around.`;
}

function main() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  const id = String(input.session_id ?? '');
  if (!id || /[/\\]/.test(id)) return;
  const event = input.hook_event_name;
  if (event === 'UserPromptSubmit') {
    if (INVOKED.test(String(input.prompt ?? ''))) console.log(mark(id));
    return;
  }
  if (event === 'UserPromptExpansion') {
    if (String(input.command_name ?? '').replace(/^.*:/, '') === 'to-auto') mark(id);
    return;
  }
  if (event !== 'PreToolUse') return;
  if (input.tool_name === 'Skill' && String(input.tool_input?.skill ?? '').replace(/^.*:/, '') === 'to-auto') {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: mark(id) } }));
    return;
  }
  const marker = path.join(sessions(), id);
  if (!fs.existsSync(marker)) return;
  if (finished(input.cwd ?? process.cwd(), id, Date.parse(fs.readFileSync(marker, 'utf8').trim()) - 1000)) {
    fs.rmSync(marker, { force: true });
    return;
  }
  const reason = verdict(input);
  if (!reason) return;
  const why = `${reason} (Guard: scripts/to-auto-guard.mjs. To end to-auto mode for this session, the user removes ${path.join(sessions(), id)}.)`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
