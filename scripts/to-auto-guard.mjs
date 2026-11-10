#!/usr/bin/env node
// Claude Code hook that holds a /to-auto session to the pipeline. It catches the honest-mistake paths (a hand-typed
// worktree, a push, branch, PR or tracker write before init, a helper agent); it is not a sandbox, so a command that
// hides its words from a regex (`$(echo push)`, a script written then run, a git alias) gets through.
//   UserPromptSubmit with /to-auto, UserPromptExpansion of /to-auto, or PreToolUse on Skill to-auto: mark the session.
//   PreToolUse on Bash or Agent in a marked session: deny branch, worktree, push, PR, tracker-write and helper-agent
//   work while the repo has no active run (registered, not done, dry-run or stopped), and deny a hand-typed
//   `git worktree add` always: run worktrees come from `goal.mjs worktree get`. Unmarked sessions are never touched.
//   The mark is dropped once a run this session registered is done (or a dry run) with no run active; a stopped run
//   keeps the session marked. In a marked session a guard failure denies the call it was judging (fails closed) and
//   no other: goal.mjs is loaded only for a call a rule names, so a broken goal.mjs never stalls `ls` or `git status`.
//   A session that cannot be marked has its /to-auto prompt blocked (exit 2).
//   UserPromptSubmit in a marked session: append the prompt to <sessions>/<session_id>.owner.jsonl. That file is the only
//   text goal.mjs accepts as the owner's words (`goal.mjs grant`, `(source: owner)` decisions), and no goal.mjs command
//   writes it. PreToolUse in a marked session denies any write that names the sessions folder.
//   With a run active, `git push` needs a recorded `push:<remote>` grant and a PR or merge-request write a `pr` grant
//   (`goal.mjs grant <slug> push:<remote> -- "<the owner's words>"`), whatever the run's mode.
//   Stop: in a marked session, while a run it registered (runs.json `agent`) is active and has committed since the last
//   block, block the end of the turn with `goal.mjs keep-going`'s reason. It fails open: any error lets the turn end.
// Markers live in `$TO_AUTO_SESSIONS`, else ~/.local/state/to-auto-sessions/<session_id>, outside every state dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only a prompt that starts with the command invokes it; quoting `/to-auto` in prose does not.
// (?![\w-]), never \b: `/to-auto-ticket-lifecycle` is another skill and must not mark the session.
const INVOKED = /^\s*[/$]to-auto(?![\w-])/;
// Claude Code session ids are UUIDs; anything else is ignored rather than joined into a path.
const SESSION_ID = /^[\w-]+$/;
// ponytail: marks older than this are swept on the next mark; a session resumed after 30 idle days is unguarded until it says /to-auto again.
const MARK_TTL_MS = 30 * 864e5;
const INACTIVE = new Set(['done', 'dry-run', 'stopped']);

// Shell quoting that splits a word (`pus""h`, `pu\sh`, `'push'`) is removed first, so the rules see the plain spelling.
// A quoted commit message is prose, dropped before that: `commit -m "never git push from CI"` is no push. A double-quoted
// one holding `$` or a backtick stays: the shell runs `-m "$(git push)"`.
const plain = (command) => command.replace(/(\s(?:-m|--message)[=\s]\s*)(?:"(?:[^"\\$`]|\\.)*"|'[^']*')/g, '$1MSG').replace(/["'\\]/g, '');
// `git [global options] <subcommand>`: the subcommand is the first non-option word, so `git stash push` and `git log --grep=push` pass.
const GIT = String.raw`\bgit\s+(?:(?:-[Cc]|--(?:git-dir|work-tree|namespace))\s+\S+\s+|--?\S+\s+)*`;
const RAW_WORKTREE = new RegExp(GIT + String.raw`worktree\s+add\b`);
const PUSH = new RegExp(GIT + String.raw`push\b([^;&|\n]*)`, 'g');
const PR_WRITE = /\b(?:gh\s+pr\s+(?:create|merge|ready)|glab\s+mr\s+(?:create|merge))\b/;
const BRANCH_OR_PUSH = new RegExp(GIT + String.raw`(?:push\b|switch\s+(?:-c|-C|--create|--orphan)\b|checkout\s+(?:-[bBt]|--orphan|--track)\b|branch\s+(?:-[cCt]\s+|--(?:copy|track|no-track)\s+)?(?![|&;<>]|\d*[<>])[^-\s])`);
const GH_WRITE = /\bgh\s+(?:pr\s+(?:create|merge|ready|edit|close|reopen|comment|review|checkout|update-branch)|issue\s+(?:create|edit|comment|close|reopen|delete|transfer|pin|unpin|lock|unlock|develop))\b/;
const GH_API = /\bgh\s+api\b([^;&|\n]*)/g;
// pflag also takes attached values (`-XPOST`, `-fkey=v`); `-f`/`-F` are gh api's only short flags on those letters.
const GH_API_METHOD = /(?:^|\s)(?:-X|--method)[=\s]*(\w+)/;
const GH_API_PARAMS = /(?:^|\s)(?:-[fF]|--(?:field|raw-field|input)\b)/;

/** `gh api` writes with an explicit non-GET method, or implicitly (POST) when it carries parameters. */
function ghApiWrites(command) {
  for (const [, args] of command.matchAll(GH_API)) {
    const method = GH_API_METHOD.exec(args)?.[1]?.toUpperCase();
    if (method ? method !== 'GET' && method !== 'HEAD' : GH_API_PARAMS.test(args)) return true;
  }
  return false;
}

const sessions = () => process.env.TO_AUTO_SESSIONS || path.join(os.homedir(), '.local', 'state', 'to-auto-sessions');

/** The remotes a command pushes to: the first word after `push` that is no option, `origin` when there is none. */
// ponytail: an option that takes its value as the next word (`-o ci.skip`) reads that value as the remote, which no grant names, so it is denied.
export const pushRemotes = (command) => [...plain(command).matchAll(PUSH)].map(([, rest]) => rest.trim().split(/\s+/).find((w) => w && !w.startsWith('-')) ?? 'origin');

/** Keep what the owner typed, for goal.mjs to check quotations against. Appended only here, by the harness's own hook. */
function recordOwner(id, prompt) {
  if (!prompt.trim()) return;
  fs.appendFileSync(path.join(sessions(), `${id}.owner.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), text: prompt })}\n`);
}

/** A write aimed at the sessions folder: the marks and the owner's words are the harness's and the owner's, never a run's. */
function touchesSessions(input) {
  const dir = sessions();
  const { tool_name: tool, tool_input: args = {} } = input;
  if (tool === 'Bash') return [dir, path.basename(dir), '.owner.jsonl'].some((needle) => String(args.command ?? '').includes(needle));
  const target = String(args.file_path ?? args.notebook_path ?? '');
  return ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && target !== '' && !path.relative(dir, path.resolve(target)).startsWith('..');
}
const skillName = (name) => String(name ?? '').replace(/^.*:/, '');

function mark(id) {
  const dir = sessions();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    // Best-effort sweep: a mark that vanished or cannot be read must not stop this session from being marked.
    try { if (Date.now() - fs.statSync(file).mtimeMs > MARK_TTL_MS) fs.rmSync(file); } catch {}
  }
  // A second /to-auto, or the skill re-invoked after compaction, keeps the first mark time: the run it registered still releases it.
  try { fs.writeFileSync(path.join(dir, id), `${new Date().toISOString()}\n`, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  return `to-auto session ${id}: pass \`--agent ${id} --harness claude-code\` to \`goal.mjs init\`. Work already in this session (earlier PRs, worktrees, plans) is not part of the run; follow the stage \`goal.mjs next\` names. Until \`init\` registers the run, branch, worktree, push, PR, tracker-write and helper-agent calls are denied by this guard.`;
}

/** True once a run this session registered after it was marked (`init --agent <session_id>`) is done and no run is active. */
function finished(runs, id, markedAt) {
  // Only a finished run releases the session: stopping one ("objective does not fit") must not open a way around it.
  const mine = (r) => r.agent === id && Date.parse(r.started) >= markedAt && (r.status === 'done' || r.status === 'dry-run');
  return runs.some(mine) && !runs.some((r) => !INACTIVE.has(r.status));
}

/** What the pipeline says about this call: 'worktree' (always denied), 'helper agent', 'command' or 'tracker write'
 *  (denied while no run is active), or null. Pure: it never needs the run registry. */
function classify(input) {
  const { tool_name: tool, tool_input: args = {} } = input;
  const command = tool === 'Bash' ? plain(String(args.command ?? '')) : '';
  if (RAW_WORKTREE.test(command)) return 'worktree';
  if (tool === 'Agent' || tool === 'Task') return 'helper agent';
  if (BRANCH_OR_PUSH.test(command)) return 'command';
  if (GH_WRITE.test(command) || PR_WRITE.test(command) || ghApiWrites(command)) return 'tracker write';
  return null;
}

const out = (hookSpecificOutput) => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...hookSpecificOutput } }));

async function main() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  const id = String(input.session_id ?? '');
  if (!SESSION_ID.test(id)) return;
  const event = input.hook_event_name;
  try {
    if (event === 'UserPromptSubmit') {
      if (INVOKED.test(String(input.prompt ?? ''))) console.log(mark(id));
      if (fs.existsSync(path.join(sessions(), id))) recordOwner(id, String(input.prompt ?? ''));
      return;
    }
    if (event === 'UserPromptExpansion') {
      if (skillName(input.command_name) === 'to-auto') mark(id);
      return;
    }
    if (event === 'Stop') {
      // Fails open: any error lets the turn end, or a broken goal.mjs would trap every session in a loop.
      // Unmarked means the user ended to-auto mode (or never started it here): never held, whatever runs.json says.
      try {
        if (!fs.existsSync(path.join(sessions(), id))) return;
        const { keepGoing } = await import('./goal.mjs');
        const verdict = keepGoing(path.join(os.homedir(), '.local', 'state', 'to-auto'), id, sessions());
        if (verdict.continue) console.log(JSON.stringify({ decision: 'block', reason: verdict.reason }));
      } catch {}
      return;
    }
    if (event !== 'PreToolUse') return;
    if (input.tool_name === 'Skill' && skillName(input.tool_input?.skill) === 'to-auto') {
      out({ additionalContext: mark(id) });
      return;
    }
  } catch (e) {
    // Exit 2 blocks the prompt or tool call and shows the message, so a session that cannot be marked cannot start to-auto unguarded.
    console.error(`to-auto-guard: cannot mark session ${id}: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  const marker = path.join(sessions(), id);
  if (!fs.existsSync(marker)) return;
  const deny = (reason) => out({ permissionDecision: 'deny', permissionDecisionReason: `${reason} (Guard: scripts/to-auto-guard.mjs. To end to-auto mode for this session, the user removes ${marker}.)` });
  if (touchesSessions(input)) {
    deny(`to-auto: ${sessions()} holds this session's mark and the owner's own words; a run never writes there. Authority comes from what the owner typed: quote it with \`goal.mjs grant <slug> <path>... -- "<their words>"\`.`);
    return;
  }
  const what = classify(input);
  if (!what) return;
  const WORKTREE = 'to-auto: run and ticket worktrees come only from `goal.mjs worktree get <slug> [NN]`, never a hand-typed `git worktree add` (PIPELINE.md § Isolation).';
  let runs;
  try {
    // Loaded only here, for a call a rule names: unmarked sessions and other calls never pay for it, and a broken goal.mjs fails closed below.
    const { stateDir } = await import('./goal.mjs');
    try { runs = JSON.parse(fs.readFileSync(path.join(stateDir(input.cwd ?? process.cwd()), 'runs.json'), 'utf8')); } catch { runs = []; }
    const markedAt = Date.parse(fs.readFileSync(marker, 'utf8').trim()) - 1000; // a hand-touched (empty) mark: any done run of this session releases it
    if (finished(runs, id, Number.isNaN(markedAt) ? 0 : markedAt)) {
      fs.rmSync(marker, { force: true });
      // The words go with the mark: what the owner said for a finished run grants nothing to the next one.
      fs.rmSync(`${marker}.owner.jsonl`, { force: true });
      fs.rmSync(`${marker}.effects.jsonl`, { force: true });
      return;
    }
  } catch (e) {
    deny(what === 'worktree' ? WORKTREE : `to-auto-guard could not read the run registry (${e.message}), so this ${what} is denied: a /to-auto session fails closed.`);
    return;
  }
  if (what === 'worktree') {
    deny(WORKTREE);
    return;
  }
  const active = runs.filter((r) => !INACTIVE.has(r.status));
  if (active.length) {
    // Push and PR authority is the owner's words, recorded as a grant: the run's mode and the tracker's configuration grant neither.
    const mine = active.some((r) => r.agent === id) ? active.filter((r) => r.agent === id) : active;
    const granted = (target) => mine.some((r) => (r.grants ?? []).some((g) => g.paths.includes(target)));
    const command = input.tool_name === 'Bash' ? String(input.tool_input?.command ?? '') : '';
    const wanted = [...pushRemotes(command).map((remote) => `push:${remote}`), ...(PR_WRITE.test(plain(command)) ? ['pr'] : [])];
    const missing = wanted.filter((target) => !granted(target) && !(target.startsWith('push:') && granted('push:*')));
    // What the guard let through goes on record for the hand-back (`goal.mjs handback`).
    if (wanted.length && !missing.length) fs.appendFileSync(`${marker}.effects.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), targets: wanted, command: command.replace(/\s+/g, ' ').slice(0, 200) })}\n`);
    if (missing.length) deny(`to-auto: ${missing.join(', ')} has no grant in run ${mine[0].slug}. Pushing and opening or merging a PR need the owner's own words, whatever the run's mode: \`goal.mjs grant ${mine[0].slug} ${missing.join(' ')} -- "<their words>"\` records them (an owner side task is granted from the message that asked for it); without them it is a blocker for the hand-back (CORE.md, Autonomous).`);
    return;
  }
  deny(`to-auto: no active run is registered for this repo, so this ${what} is outside the pipeline. Follow the stage \`goal.mjs next <slug>\` names; at stage 0 register the run with \`goal.mjs init <slug> "<objective>"\`. A refused objective ends the invocation, it is never worked around.`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
