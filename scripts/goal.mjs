#!/usr/bin/env node
// The mechanical half of a /to-auto run: everything that is a rule over files, so
// no agent re-derives it from prose.
//
//   node scripts/goal.mjs control                         create the control plane in the state folder if missing
//   node scripts/goal.mjs slug <objective> [--new]        the run slug; --new picks a free -2, -3 … for a deliberate re-run
//   node scripts/goal.mjs init <slug> <objective> [--agent <id>] [--harness <name>]
//                                                          register the run and create runs/<slug>/ that next can parse; commit
//   node scripts/goal.mjs next <slug>                     where the run resumes (JSON); blocked when NOW is ahead of the registry
//   node scripts/goal.mjs check <slug> | check --all [--state-root <dir>] [--stale-hours <n>]
//                                                          read-only: NOW ahead of the registry, malformed NOW, registry stale (exit 1 on any)
//   node scripts/goal.mjs worktree get|return <slug> [NN] | worktree status <slug>
//                                                          the run's (or ticket NN's) worktree: treehouse lease (cut under <state>/worktrees/pool) when on PATH, else git under <state>/worktrees;
//                                                          refused under any ancestor .gitignore/.ignore with a `*` line (gitignore-aware linters scan nothing there)
//   node scripts/goal.mjs stop <slug> <reason>            halt the run: write runs/<slug>/STOP and set the registry status
//   node scripts/goal.mjs resume <slug>                   undo a stop once its cause is fixed
//   node scripts/goal.mjs event <slug> <stage> <text>     append `- HH:MM [stage] text` (local clock) to the ledger and commit
//   node scripts/goal.mjs registry <slug> <status>        move the run one step along RUN_ORDER (or to stopped / dry-run) and commit
//   node scripts/goal.mjs frontier <feature>              ticket grammar, frontier, claim overlaps (JSON)
//   node scripts/goal.mjs take <feature> <n>              atomically flip up to <n> frontier tickets (n = free slots) to in-flight (JSON ids)
//   node scripts/goal.mjs status <feature> <id> <status> [--landed <sha>] [-- <reason>]
//                                                          move one ticket along TICKET_MOVES and commit; done needs --landed, stuck and needs-human a reason
//   node scripts/goal.mjs claims <ticket.md> <path>...    touched paths outside the ticket's claims (JSON)
//   node scripts/goal.mjs claim <feature> <id> <exclusive|shared-regenerate> <path>... -- <why>
//                                                          widen a ticket's claims after a claims breach: ticket, contract, ledger, one commit (JSON)
//   node scripts/goal.mjs contract <NN.goal.md> --worktree <wt> --ticket <ticket.md>
//                                                          check a contract before every dispatch: base = where the ticket branch left the run branch, Claims and criteria verbatim (JSON)
//   node scripts/goal.mjs dispatch <feature> <id> --worktree <wt> -- <orc-dispatch args...>
//                                                          check the contract, then run to-orc's dispatcher in the ticket's own run directory
//   node scripts/goal.mjs waive <feature> <id> <criterion number> [--carried-to <id>] -- <why>
//                                                          release a criterion the committed receipt shows unmet and proven wrong: ticket, ledger, one commit (JSON)
//   node scripts/goal.mjs run -- <command>                run a validation command in cwd and keep its output as a hashed log a receipt cites
//   node scripts/goal.mjs receipt <file> --worktree <wt> --base <sha> --ticket <ticket.md>
//                                                          check an implementer's receipt against git and the ticket (JSON)
//   node scripts/goal.mjs with-lock <name> -- <cmd...>    run one command holding a control-plane lock
//   node scripts/goal.mjs commit -m <msg> <file>...       stage exactly <file>s in the control plane and commit, under the control lock
//   node scripts/goal.mjs preflight | prepare | supervise | land [slug] | cleanup
//   node scripts/goal.mjs check-command [--objective <text>] | compact <slug> | model <slug> <role> <model> | root
//
// Global flags, before the command: --repo, --state-dir, --allow (repeatable), --base, --target-branch, --status-file, --no-remote, --worker-model.
// Every command takes --repo <path> (default: cwd); any worktree of the repo works.
// Exit 0 = ok, 1 = the answer is "no" (claims breach, malformed tickets, a refused take, claim, contract, a refused receipt, stopped), 2 = usage, 3 = runtime error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Stage order is the pipeline. `artifact` is a file in runs/<slug>/ that must exist
// for a ticked stage to count as done: the files outrank the checkbox.
export const STAGES = [
  { id: '00', name: 'wiring and ask-matt', phase: 'BOOTSTRAP.md' },
  { id: '0', name: 'register', phase: 'BOOTSTRAP.md', artifact: 'ledger.md' },
  { id: '0a', name: 'cache kun', phase: 'BOOTSTRAP.md' },
  { id: '0b', name: 'setup', phase: 'BOOTSTRAP.md' },
  { id: '0c', name: 'isolate', phase: 'BOOTSTRAP.md' },
  { id: '0d', name: 'environment contract', phase: 'BOOTSTRAP.md' },
  { id: '1', name: 'route', phase: 'PLAN.md', artifact: 'findings.md' },
  { id: '2', name: 'on-ramp', phase: 'PLAN.md' },
  { id: '3', name: 'research', phase: 'PLAN.md' },
  { id: '4', name: 'grill', phase: 'PLAN.md' },
  { id: '4b', name: 'challenge', phase: 'PLAN.md' },
  { id: '5', name: 'spec', phase: 'PLAN.md', artifact: 'spec.md' },
  { id: '5b', name: 'reconcile', phase: 'PLAN.md' },
  { id: '6', name: 'tickets', phase: 'PLAN.md' },
  { id: '6b', name: 'claims gate', phase: 'PLAN.md' },
  { id: '7', name: 'build', phase: 'BUILD.md' },
  { id: '8', name: 'review', phase: 'CLOSE.md', artifact: 'final-verdict.json' },
  { id: '9', name: 'hand back', phase: 'CLOSE.md' },
  { id: '10', name: 'retro', phase: 'CLOSE.md', artifact: 'retro.md' },
];

// The only ticket moves. `goal.mjs status` is the one writer of a Status line, so this table is the whole lifecycle:
// a dispatched ticket leaves in-flight only done (receipt and landing proven), stuck or needs-human (with a reason),
// and a stuck ticket re-enters as ready-for-agent after its re-plan, which makes the next dispatch a fresh baseline.
export const TICKET_MOVES = {
  blocked: ['ready-for-agent', 'stuck'],
  'ready-for-agent': ['in-flight', 'blocked', 'stuck'],
  'in-flight': ['done', 'stuck', 'needs-human'],
  'needs-human': ['in-flight', 'stuck'],
  stuck: ['ready-for-agent', 'blocked'],
  done: [],
};
const STATUSES = new Set(Object.keys(TICKET_MOVES));
const NEEDS_REASON = new Set(['stuck', 'needs-human']);
const MAY_HAVE_REASON = new Set(['stuck', 'needs-human', 'blocked']);
// A dispatched ticket never gains, loses or rewords a criterion; new work goes to a new ticket or NOW leads:.
const FROZEN = new Set(['in-flight', 'needs-human', 'done']);
// A fix ticket of a fix ticket is the last generation (BUILD.md step 6): no review→fix chain runs deeper than three tickets.
export const MAX_REVIEW_DEPTH = 2;
// Runs move one step forward along this order; `stopped` and `dry-run` are reachable from anywhere, and only `resume` leaves `stopped`.
export const RUN_ORDER = ['bootstrapping', 'planning', 'specced', 'ticketed', 'building', 'reviewing', 'done'];
// `**Capability:** <tier>/<intensity>`: what the implementer needs, not a model name. Absent = the default.
const CAPABILITY = /^(lightweight|standard|advanced)\/(low|medium|high)$/;
const DEFAULT_CAPABILITY = 'standard/medium';
const STATUS_LINE = /^\*\*Status:\*\* ([a-z-]+)(?::[ \t]*([^\n]*?))?[ \t]*$/m;
const FROM_REVIEW_LINE = /^\*\*From review:\*\* (.+)$/m;

/** Ticket numbers compare by value: `1`, `01`, and `001` are one ticket. */
function ticketId(raw) {
  return /^\d+$/.test(raw) ? String(Number(raw)).padStart(2, '0') : null;
}

function ticketFiles(issues) {
  const files = new Map();
  const duplicates = [];
  for (const file of fs.readdirSync(issues).filter((f) => f.endsWith('.md')).sort()) {
    const id = ticketId(file.match(/^(\d+)/)?.[1] ?? '');
    if (!id) continue;
    if (files.has(id)) duplicates.push({ id, file: path.join(issues, file), problems: [`ticket number ${id} is also used by ${path.basename(files.get(id))}`] });
    else files.set(id, path.join(issues, file));
  }
  return { files, duplicates };
}
const STALE_LOCK_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 120 * 1000;
const GUARD_STALE_MS = 60 * 1000;

class UsageError extends Error {}
/** The answer is "no" (a gate refused): exit 1, like a claims breach. */
class Refusal extends Error {}

// Flags for this process. `--state-dir` wins over `TO_AUTO_HOME`, which wins over the default.
const runtimeDefault = () => ({ stateDir: null, allow: [], noRemote: false, base: null, targetBranch: null, statusFile: null });
let runtime = runtimeDefault();

export function configure(opts = {}) {
  runtime = { ...runtimeDefault(), ...opts, allow: opts.allow ?? [] };
  return runtime;
}

export function repoId(repo) {
  const common = fs.realpathSync(execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  return createHash('sha256').update(common).digest('hex').slice(0, 16);
}

function hasMarker(dir) {
  return fs.existsSync(path.join(dir, '.to-auto'));
}

/** The state folder: `--state-dir`, else `TO_AUTO_HOME`, else `~/.local/state/to-auto/<repo-id>`. */
export function stateDir(repo) {
  const resolved = path.resolve(repo);
  if (hasMarker(resolved)) return fs.realpathSync(resolved);
  if (runtime.stateDir) return path.resolve(runtime.stateDir);
  if (process.env.TO_AUTO_HOME) return path.resolve(process.env.TO_AUTO_HOME);
  return path.join(os.homedir(), '.local', 'state', 'to-auto', repoId(repo));
}

export function controlDir(repo) {
  return stateDir(repo);
}

function assertStateOutside(repo, dir) {
  if (hasMarker(path.resolve(repo))) return;
  let top;
  try {
    top = fs.realpathSync(git(repo, ['rev-parse', '--show-toplevel']));
  } catch {
    return;
  }
  const real = canon(dir);
  if (real === top || real.startsWith(top + path.sep)) {
    throw new Error(`state directory ${dir} is inside the repo ${top}; pass --state-dir or set TO_AUTO_HOME to a path outside it`);
  }
}

/** The control plane, a private git repo in the state folder, never a branch of the user repo. */
function requireControl(repo) {
  const control = controlDir(repo);
  if (!hasMarker(control)) throw new Error(`no control plane at ${control}; run \`goal.mjs control\` first`);
  let controlCommon;
  try {
    controlCommon = fs.realpathSync(git(control, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  } catch {
    throw new Error(`no control plane at ${control}; run \`goal.mjs control\` first`);
  }
  const controlReal = fs.realpathSync(control);
  if (controlCommon !== path.join(controlReal, '.git') && !controlCommon.startsWith(controlReal + path.sep)) {
    throw new Error(`control plane at ${control} is not its own git repo`);
  }
  try {
    const userCommon = fs.realpathSync(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    if (userCommon === controlCommon && fs.realpathSync(repo) !== controlReal) {
      throw new Error('control plane must not share the user repo\'s git dir');
    }
  } catch (error) {
    if (error.message.includes('must not share') || error.message.includes('not its own')) throw error;
  }
  return control;
}

function gitIdentity(repo) {
  const read = (key) => spawnSync('git', ['-C', repo, 'config', key], { encoding: 'utf8' }).stdout.trim();
  return { name: read('user.name') || 'to-auto', email: read('user.email') || 'to-auto@localhost' };
}

export function ensureControl(repo) {
  const control = controlDir(repo);
  assertStateOutside(repo, control);
  return withLock(repo, 'control', () => {
    if (hasMarker(control)) return requireControl(repo);
    fs.mkdirSync(control, { recursive: true });
    execFileSync('git', ['init', '-q', control], { stdio: ['ignore', 'pipe', 'pipe'] });
    const id = gitIdentity(repo);
    git(control, ['config', 'user.name', id.name]);
    git(control, ['config', 'user.email', id.email]);
    fs.writeFileSync(path.join(control, '.gitignore'), 'locks/\nclone/\nworktrees/\nreturn.bundle\n');
    fs.writeFileSync(path.join(control, '.to-auto'), `to-auto control plane\nrepo-id: ${repoId(repo)}\n`);
    git(control, ['add', '--', '.gitignore', '.to-auto']);
    git(control, ['commit', '-q', '-m', 'Init to-auto control plane']);
    return control;
  });
}

/** Lower-case, non-alphanumerics to `-`, collapsed, at most 40 chars. `fresh` skips slugs already used. */
export function slugFor(repo, objective, { fresh = false } = {}) {
  const base = objective.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  if (!base) throw new Error('objective has no letters or digits to make a slug from');
  if (!fresh) return base;
  const used = new Set(readRegistry(controlDir(repo)).map((r) => r.slug));
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base.slice(0, 37)}-${n}`)) return `${base.slice(0, 37)}-${n}`;
}

function readRegistry(control) {
  const file = path.join(control, 'runs.json');
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON; repair it from \`git -C ${control} log -p -- runs.json\``);
  }
}

export function setRegistry(repo, slug, status, { restoring = false } = {}) {
  if (![...RUN_ORDER, 'stopped', 'dry-run'].includes(status)) throw new UsageError(`unknown run status ${status} (${RUN_ORDER.join(' → ')}, or stopped, or dry-run)`);
  const control = requireControl(repo);
  return withLock(repo, 'registry', () => {
    const runs = readRegistry(control);
    const entry = runs.find((r) => r.slug === slug);
    if (!entry) throw new Error(`no run ${slug} in runs.json`);
    if (entry.status === status) return 'nothing to commit';
    const step = RUN_ORDER.indexOf(status) === RUN_ORDER.indexOf(entry.status) + 1 && RUN_ORDER.includes(entry.status);
    if (entry.status === 'stopped' && !restoring) throw new Refusal(`${slug} is stopped; \`goal.mjs resume ${slug}\` restores the status the stop replaced`);
    if (!restoring && !['stopped', 'dry-run'].includes(status) && !step) {
      throw new Refusal(`${slug} cannot go from ${entry.status} to ${status}: a run moves one step along ${RUN_ORDER.join(' → ')}`);
    }
    const missing = !restoring && stepEvidence(control, slug, status);
    if (missing) throw new Refusal(`${slug} cannot be ${status} yet: ${missing}`);
    // Stage 7 is complete only when every ticket is done or stuck with its reason (PIPELINE.md § Completion criteria).
    const issues = path.join(control, 'tracker', slug, 'issues');
    if (status === 'reviewing' && fs.existsSync(issues)) {
      const open = [...ticketFiles(issues).files].map(([id, file]) => [id, parseTicket(fs.readFileSync(file, 'utf8')).status]).filter(([, s]) => !['done', 'stuck'].includes(s));
      if (open.length) throw new Refusal(`build is not complete: ${open.map(([id, s]) => `${id} (${s})`).join(', ')}; each ticket is done or marked stuck with its reason first`);
    }
    if (status === 'done') {
      const problems = finalVerdictProblems(repo, control, slug);
      if (problems.length) throw new Refusal(`${slug} is not done: ${problems.join('; ')}`);
    }
    if (status === 'stopped') entry.stoppedFrom = entry.status;
    if (status !== 'stopped') delete entry.stoppedFrom;
    entry.status = status;
    fs.writeFileSync(path.join(control, 'runs.json'), `${JSON.stringify(runs, null, 2)}\n`);
    return commit(repo, `[${slug}] status ${status}`, ['runs.json']);
  });
}

/**
 * The artifact each middle registry step stands on (PIPELINE.md § Completion criteria), so the registry cannot be
 * walked forward with nothing behind it just to silence `check`. Returns what is missing, or null.
 */
function stepEvidence(control, slug, status) {
  const run = path.join(control, 'runs', slug);
  if (status === 'planning' && readJson(path.join(run, 'worktrees.json'))?.run?.state !== 'active') {
    return `no active run worktree; \`goal.mjs worktree get ${slug}\` it at stage 0c`;
  }
  if (status === 'specced' && !fs.existsSync(path.join(run, 'spec.md'))) return `runs/${slug}/spec.md is missing; stage 5 writes it`;
  if (status === 'ticketed') {
    const issues = path.join(control, 'tracker', slug, 'issues');
    const local = fs.existsSync(issues) && ticketFiles(issues).files.size > 0;
    const todo = path.join(run, 'todo.md');
    const table = fs.existsSync(todo) && /^## Tickets[^\n]*\n\s*[|-]/m.test(fs.readFileSync(todo, 'utf8'));
    if (!local && !table) return `no tickets in tracker/${slug}/issues and no ticket table in todo.md; stage 6 writes them`;
  }
  return null;
}

// An open-ended backlog ("fix all 422 open Linear issues", "every open bug") is batched, never admitted as one run (BOOTSTRAP.md step 5).
const BACKLOG = /\b(all|every)(\s+(the|open|remaining|outstanding|current|\d+|linear|github|jira|[a-z]+'s))*\s+(issue|ticket|bug|todo|pr|pull request)s?\b|\b\d{2,}\s+(open\s+)?(\w+\s+)?(issues|tickets|bugs|prs)\b/i;

/**
 * A run is done only on a committed stage 8 verdict that reviewed what the target branch holds now
 * (CLOSE.md step 8): `{ "verdict": "ship", "target": "<branch>", "review_head": "<sha>" }`, target's tip = review_head.
 */
function finalVerdictProblems(repo, control, slug) {
  const rel = path.join('runs', slug, 'final-verdict.json');
  const file = path.join(control, rel);
  if (!fs.existsSync(file)) return [`${rel} is missing; stage 8 writes it`];
  const committed = spawnSync('git', ['-C', control, 'show', `HEAD:${rel}`], { encoding: 'utf8' });
  if (committed.status !== 0 || committed.stdout !== fs.readFileSync(file, 'utf8')) return [`${rel} has uncommitted edits`];
  let v;
  try { v = JSON.parse(committed.stdout); } catch { return [`${rel} is not JSON`]; }
  const problems = [];
  if (v?.verdict !== 'ship') problems.push(`${rel} verdict is ${JSON.stringify(v?.verdict)}, not "ship"`);
  if (typeof v?.target !== 'string' || typeof v?.review_head !== 'string') return [...problems, `${rel} needs "target" (the branch reviewed) and "review_head" (the sha it pointed at)`];
  const tip = commitOf(repo, v.target);
  const reviewed = commitOf(repo, v.review_head);
  if (!tip || !reviewed) problems.push(`${rel} names ${!tip ? `target ${v.target}` : `review_head ${v.review_head}`}, which is not in this repository`);
  else if (tip !== reviewed) problems.push(`${v.target} is at ${tip.slice(0, 12)} but the final review saw ${reviewed.slice(0, 12)}; review what landed since, then rewrite the verdict`);
  return problems;
}

export function stop(repo, slug, reason) {
  const control = requireControl(repo);
  const file = path.join(control, 'runs', slug, 'STOP');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${reason}\n`);
  commit(repo, `[${slug}] stop: ${reason}`, [path.relative(control, file)]);
  if (readRegistry(control).some((r) => r.slug === slug)) setRegistry(repo, slug, 'stopped');
  return `stopped ${slug}`;
}

/** Append one Events line stamped with the real local clock, so no agent writes a time it guessed. */
export function event(repo, slug, stage, text) {
  if (/[\r\n]/.test(stage + text)) throw new Error('an event is one line');
  const control = requireControl(repo);
  const rel = path.join('runs', slug, 'ledger.md');
  if (!fs.existsSync(path.join(control, rel))) throw new Error(`${slug} has no ledger at ${rel}`);
  return withLock(repo, 'control', () => {
    appendEvent(path.join(control, rel), stage, text);
    return commit(repo, `[${slug}] [${stage}] ${text}`, [rel]);
  });
}

function appendEvent(file, stage, text) {
  const now = new Date();
  const hhmm = [now.getHours(), now.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
  const body = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, `${body}${body.endsWith('\n') ? '' : '\n'}- ${hhmm} [${stage}] ${text}\n`);
}

/** Undo a stop once its cause is fixed: remove STOP and put back the registry status it replaced. */
export function resume(repo, slug) {
  const control = requireControl(repo);
  const rel = path.join('runs', slug, 'STOP');
  if (!fs.existsSync(path.join(control, rel))) throw new Error(`${slug} is not stopped`);
  fs.rmSync(path.join(control, rel));
  commit(repo, `[${slug}] resume`, [rel]);
  const entry = readRegistry(control).find((r) => r.slug === slug);
  if (entry?.status === 'stopped') setRegistry(repo, slug, entry.stoppedFrom ?? 'bootstrapping', { restoring: true });
  return `resumed ${slug}`;
}

// ---------------------------------------------------------------- next

/** The todo.md stage lines: `- [x] 0b setup` or `- [ ] 7 build`, one per line. Maps stage id → ticked. */
export function parseTodo(text) {
  const tickedById = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^- \[( |x)\] (\S+)\b/);
    if (m && STAGES.some((s) => s.id === m[2])) tickedById.set(m[2], m[1] === 'x');
  }
  return tickedById;
}

const resumeAt = (slug, stage, reason) => ({ slug, stage: stage.id, name: stage.name, phase: stage.phase, reason });

export function init(repo, slug, objective, { agent = null, harness = null, workerModel = null, noHelpers = false } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new Error(`bad slug: ${slug} (kebab-case, at most 40 chars)`);
  if (BACKLOG.test(objective)) throw new Refusal(`"${objective}" is a backlog, not one run: snapshot the issue ids and split them into bounded batches, each its own /to-auto run, or hand the backlog to to-orc (BOOTSTRAP.md step 5)`);
  const control = requireControl(repo);
  const runDir = path.join(control, 'runs', slug);
  if (fs.existsSync(path.join(runDir, 'STOP'))) throw new Error(`${slug} is stopped; fix the cause, then \`goal.mjs resume ${slug}\``);
  if (fs.existsSync(path.join(runDir, 'todo.md'))) throw new Error(`runs/${slug}/ already exists; resume it with \`goal.mjs next ${slug}\``);
  withLock(repo, 'registry', () => {
    const runs = readRegistry(control);
    if (runs.some((r) => r.slug === slug)) throw new Error(`${slug} is already registered in runs.json`);
    const runId = runs.reduce((max, r) => Math.max(max, r.run_id ?? 0), 0) + 1;
    runs.push({ slug, objective, run_id: runId, started: new Date().toISOString(), status: 'bootstrapping', agent, harness, workerModel: workerModel ?? null, helpers: noHelpers ? 'none' : (workerModel ? 'named' : null) });
    fs.writeFileSync(path.join(control, 'runs.json'), `${JSON.stringify(runs, null, 2)}\n`);
    commit(repo, `[${slug}] register run ${runId}`, ['runs.json']);
  });
  const files = {
    'todo.md': `# to-auto todo: ${objective}\n\n## Stages\n${STAGES.map((s) => `- [ ] ${s.id} ${s.name}`).join('\n')}\n\n## Tickets (stage 7)\n`,
    'ledger.md': `# to-auto: ${objective}\n\n## NOW\n- stage: 0 register\n- next: finish BOOTSTRAP.md stage 0\n\n## Events\n`,
    'log.md': `# Decisions: ${objective}\n\n`,
    'bugs.md': `# Bugs noticed in flight: ${objective}\n\n`,
  };
  if (noHelpers) files['models.json'] = `${JSON.stringify({ workerModel: null, helpers: 'none', roles: {} }, null, 2)}\n`;
  else if (workerModel) files['models.json'] = `${JSON.stringify({ workerModel, helpers: 'named', roles: {} }, null, 2)}\n`;
  fs.mkdirSync(runDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(runDir, name), text);
  return commit(repo, `[${slug}] start`, Object.keys(files).map((name) => path.join('runs', slug, name)));
}

/** Record the model a role actually used. The requested model is `workerModel` from init. */
export function recordModel(repo, slug, role, model) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new Error(`bad slug: ${slug}`);
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(role)) throw new Error(`bad role: ${role}`);
  if (!model || /[\r\n]/.test(model)) throw new Error('model is one line');
  const control = requireControl(repo);
  const rel = path.join('runs', slug, 'models.json');
  const file = path.join(control, rel);
  const entry = readRegistry(control).find((r) => r.slug === slug);
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { workerModel: entry?.workerModel ?? null, helpers: entry?.helpers ?? 'named', roles: {} };
  data.roles[role] = model;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  commit(repo, `[${slug}] model ${role}`, [rel]);
  return event(repo, slug, 'model', `${role} used ${model}`);
}

export function next(control, slug) {
  const runDir = path.join(control, 'runs', slug);
  if (fs.existsSync(path.join(runDir, 'STOP'))) {
    return { slug, stop: true, reason: `runs/${slug}/STOP: ${fs.readFileSync(path.join(runDir, 'STOP'), 'utf8').trim() || 'no reason given'}` };
  }
  const ahead = stageProblems(control, slug).filter((p) => p.code === 'NOW_AHEAD');
  if (ahead.length) return { slug, blocked: true, problems: ahead, reason: `${ahead[0].message}; set NOW back to the stage the run really reached, or stop the run` };
  if (!fs.existsSync(runDir)) return resumeAt(slug, STAGES[0], 'no run directory yet: start BOOTSTRAP.md at 00 and touch nothing in the repo (no worktree, branch, PR, tracker write or helper agent) until init registers the run');
  const todoFile = path.join(runDir, 'todo.md');
  if (!fs.existsSync(todoFile)) return resumeAt(slug, STAGES[0], 'todo.md missing; stage 00 is idempotent');
  const tickedById = parseTodo(fs.readFileSync(todoFile, 'utf8'));
  const missingLines = STAGES.filter((s) => !tickedById.has(s.id)).map((s) => s.id);
  if (missingLines.length) return { slug, malformed: true, reason: `todo.md has no line for stage(s) ${missingLines.join(', ')}; restore the lines \`goal.mjs init\` writes` };
  for (const s of STAGES) {
    if (!tickedById.get(s.id)) return resumeAt(slug, s, 'first unticked stage');
    if (s.artifact && !fs.existsSync(path.join(runDir, s.artifact))) return resumeAt(slug, s, `ticked, but runs/${slug}/${s.artifact} is missing`);
  }
  return { slug, done: true, reason: 'every stage ticked and every stage artifact present' };
}

// --------------------------------------------------------------- check

// The registry status a run must have reached before NOW may name a stage: the NOW line is prose an agent
// rewrites by hand, the registry only moves through `goal.mjs registry`, so NOW running ahead means the run
// left the pipeline (the stage-7-at-bootstrapping incident).
const STAGE_FLOOR = {
  bootstrapping: ['00', '0', '0a', '0b', '0c'],
  planning: ['0d', '1', '2', '3', '4', '4b', '5', '5b'],
  specced: ['6', '6b'],
  building: ['7'],
  reviewing: ['8', '9', '10'],
  done: ['done'],
};
const FLOOR_OF = new Map(Object.entries(STAGE_FLOOR).flatMap(([status, ids]) => ids.map((id) => [id, status])));
const TERMINAL = new Set(['done', 'dry-run']);

/** The stage id NOW names (`- stage: 7 build …` → `7`), null when there is no stage line. */
export function nowStage(ledgerText) {
  const block = ledgerText.split(/^## /m).find((s) => s.startsWith('NOW'));
  return block?.match(/^- stage:\s*(\S+)/m)?.[1] ?? null;
}

/** NOW_AHEAD / NOW_MALFORMED for a registered run that is neither terminal nor stopped (`resume` brings it back under check); [] otherwise. Read-only. */
function stageProblems(control, slug) {
  const entry = readRegistry(control).find((r) => r.slug === slug);
  if (!entry || TERMINAL.has(entry.status) || entry.status === 'stopped') return [];
  const ledger = path.join(control, 'runs', slug, 'ledger.md');
  const stage = fs.existsSync(ledger) ? nowStage(fs.readFileSync(ledger, 'utf8')) : null;
  if (!stage || !FLOOR_OF.has(stage)) return [{ code: 'NOW_MALFORMED', message: `NOW names ${stage ? `unknown stage ${stage}` : 'no stage'}; write \`- stage: <id> <name>\` with a stage id from todo.md` }];
  const floor = FLOOR_OF.get(stage);
  if (RUN_ORDER.indexOf(entry.status) < RUN_ORDER.indexOf(floor)) {
    return [{ code: 'NOW_AHEAD', message: `NOW stage ${stage} needs registry ${floor}, but the registry is ${entry.status}` }];
  }
  return [];
}

/** Seconds since the run's last control-plane commit (`[<slug>] …`: status, event, ticket, receipt), null when unknown. */
function runAge(control, slug, now) {
  const log = spawnSync('git', ['-C', control, 'log', '-1', '--format=%ct', '-F', `--grep=[${slug}] `], { encoding: 'utf8' });
  return log.status === 0 && log.stdout.trim() ? now / 1000 - Number(log.stdout.trim()) : null;
}

/**
 * One run's health, read-only: NOW ahead of the registry, a malformed NOW, or no goal.mjs commit for
 * `staleHours` while the run is still active. Stopped runs are parked on purpose, so they report nothing until `resume`.
 */
export function checkRun(control, slug, { staleHours = 2, now = Date.now() } = {}) {
  const entry = readRegistry(control).find((r) => r.slug === slug);
  if (!entry) throw new Error(`no run ${slug} in runs.json`);
  const ledger = path.join(control, 'runs', slug, 'ledger.md');
  const problems = stageProblems(control, slug);
  if (!TERMINAL.has(entry.status) && entry.status !== 'stopped') {
    const age = runAge(control, slug, now);
    if (age !== null && age > staleHours * 3600) {
      problems.push({ code: 'STALE', message: `no goal.mjs commit for ${(age / 3600).toFixed(1)}h while ${entry.status} (limit ${staleHours}h); is the run still following the pipeline?` });
    }
  }
  return { slug, ok: !problems.length, registry: entry.status, nowStage: fs.existsSync(ledger) ? nowStage(fs.readFileSync(ledger, 'utf8')) : null, problems };
}

/** Every registered run under every control plane in `root` (plus TO_AUTO_HOME when it is one): one line per problem. */
export function checkAll(root, opts = {}) {
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).map((d) => path.join(root, d)) : [];
  if (process.env.TO_AUTO_HOME) dirs.push(path.resolve(process.env.TO_AUTO_HOME));
  const lines = [];
  for (const dir of [...new Set(dirs)].filter(hasMarker).sort()) {
    let runs;
    try {
      runs = readRegistry(dir);
    } catch (error) {
      lines.push(`${dir} - RUNS_UNREADABLE ${error.message}`);
      continue;
    }
    for (const run of runs) {
      for (const p of checkRun(dir, run.slug, opts).problems) lines.push(`${dir} ${run.slug} ${p.code} ${p.message}`);
    }
  }
  return lines;
}

// ------------------------------------------------------------- tickets

/** A local-tracker ticket: the three lines CONTROL.md § Tracker grammar requires. */
export function parseTicket(text) {
  // `**Status:** <status>` or `**Status:** <status>: <reason>` (e.g. `blocked: prerequisite 03 stuck`).
  const [, status, reason = ''] = text.match(STATUS_LINE) ?? [];
  const blocked = text.match(/^\*\*Blocked by:\*\* (.+)$/m)?.[1]?.trim();
  const claims = text.match(/^\*\*Claims:\*\* (.+)$/m)?.[1];
  const capability = text.match(/^\*\*Capability:\*\* (.+)$/m)?.[1]?.trim() ?? DEFAULT_CAPABILITY;
  // `**From review:** NN` marks a fix ticket born from ticket NN's review; the chain bounds review→fix depth.
  const fromLine = text.match(FROM_REVIEW_LINE)?.[1]?.trim();
  const fromReview = fromLine === undefined ? null : ticketId(fromLine.match(/^(\d+)\b/)?.[1] ?? '');
  const problems = [];
  if (!CAPABILITY.test(capability)) problems.push(`unknown capability ${capability} (lightweight|standard|advanced / low|medium|high)`);
  if (!status) problems.push('no **Status:** line');
  else if (!STATUSES.has(status)) problems.push(`unknown status ${status} (${[...STATUSES].join(' | ')})`);
  if (fromLine !== undefined && !fromReview) problems.push(`unreadable **From review:** "${fromLine}" (the number of the ticket whose review found it, e.g. 04)`);
  if (!blocked) problems.push('no **Blocked by:** line');
  if (!claims) problems.push('no **Claims:** line');
  const blockers = [];
  // to-tickets writes `None (can start immediately)` and `01 (why)`; a parenthetical or a trailing title is prose.
  const edges = (blocked ?? '').replace(/\([^)]*\)/g, '').trim();
  if (blocked && !/^None\b/i.test(edges)) {
    for (const token of edges.split(',').map((b) => b.trim()).filter(Boolean)) {
      const id = ticketId(token.match(/^(\d+)(?:$|[\s:\u2013-])/)?.[1] ?? '');
      if (id) blockers.push(id);
      else problems.push(`unreadable blocker "${token}" (use ticket numbers, e.g. 03)`);
    }
  }
  const parsed = { exclusive: [], 'shared-regenerate': [], guarded: [] };
  for (const part of (claims ?? '').split(';')) {
    const m = part.trim().match(/^(exclusive|shared-regenerate|guarded):\s*(.*)$/);
    if (!m) {
      if (part.trim()) problems.push(`unreadable claims part "${part.trim()}" (each ;-part starts with exclusive:, shared-regenerate: or guarded:; paths inside a part are comma-separated)`);
      continue;
    }
    parsed[m[1]].push(...m[2].split(',').map((c) => c.trim()).filter(Boolean));
  }
  return { status, reason, blockers, claims: parsed, capability, fromReview, problems };
}

/** How many review→fix generations separate a ticket from original work: 0 for a planned ticket. */
function reviewDepth(tickets, id, seen = new Set()) {
  const from = tickets.get(id)?.fromReview;
  if (!from || seen.has(id)) return 0;
  seen.add(id);
  return 1 + reviewDepth(tickets, from, seen);
}

function readTickets(issues) {
  const { files, duplicates } = ticketFiles(issues);
  return { duplicates, tickets: new Map([...files].map(([id, file]) => [id, { file, ...parseTicket(fs.readFileSync(file, 'utf8')) }])) };
}

export function frontier(control, feature) {
  const { tickets, duplicates } = readTickets(path.join(control, 'tracker', feature, 'issues'));
  const malformed = [...duplicates];
  for (const [id, t] of tickets) {
    for (const b of t.blockers) if (!tickets.has(b)) t.problems.push(`blocked by unknown ticket ${b}`);
    if (t.fromReview && !tickets.has(t.fromReview)) t.problems.push(`from the review of unknown ticket ${t.fromReview}`);
    if (t.problems.length) malformed.push({ id, file: t.file, problems: t.problems });
  }
  const ready = [...tickets].filter(([, t]) => t.status === 'ready-for-agent' && t.blockers.every((b) => tickets.get(b)?.status === 'done')).map(([id]) => id);
  const open = [...tickets].filter(([, t]) => !['done', 'stuck'].includes(t.status));
  const conflicts = [];
  for (let i = 0; i < open.length; i += 1) {
    for (let j = i + 1; j < open.length; j += 1) {
      const [a, ta] = open[i];
      const [b, tb] = open[j];
      if (dependsOn(tickets, a, b) || dependsOn(tickets, b, a)) continue;
      for (const ca of ta.claims.exclusive) {
        for (const cb of tb.claims.exclusive) if (claimsOverlap(ca, cb)) conflicts.push({ tickets: [a, b], claims: [ca, cb] });
      }
    }
  }
  const capability = Object.fromEntries([...tickets].map(([id, t]) => [id, t.capability]));
  for (const [id, t] of open) {
    const depth = reviewDepth(tickets, id);
    if (depth > MAX_REVIEW_DEPTH) malformed.push({ id, file: t.file, problems: [`review→fix depth ${depth} exceeds ${MAX_REVIEW_DEPTH}: a fix ticket of a fix ticket is the last generation, so these findings go to NOW leads: (BUILD.md step 6)`] });
  }
  return { feature, frontier: malformed.length ? [] : ready, malformed, conflicts, capability, cross_run: crossRun(control, feature, open) };
}

const FINISHED_RUNS = new Set(['done', 'stopped', 'dry-run']);

/** Exclusive-claim overlaps with open tickets of other unfinished runs: separate branches, so the second merge conflicts. */
function crossRun(control, feature, open) {
  const found = [];
  for (const run of readRegistry(control)) {
    if (run.slug === feature || FINISHED_RUNS.has(run.status)) continue;
    const issues = path.join(control, 'tracker', run.slug, 'issues');
    if (!fs.existsSync(issues)) continue;
    for (const [b, file] of ticketFiles(issues).files) {
      const tb = parseTicket(fs.readFileSync(file, 'utf8'));
      if (['done', 'stuck'].includes(tb.status)) continue;
      for (const [a, ta] of open) {
        for (const ca of ta.claims.exclusive) {
          for (const cb of tb.claims.exclusive) if (claimsOverlap(ca, cb)) found.push({ run: run.slug, tickets: [a, b], claims: [ca, cb] });
        }
      }
    }
  }
  return found;
}

/** Under the frontier lock, so two orchestrators never take the same ticket. */
export function take(repo, feature, max) {
  const control = requireControl(repo);
  return withLock(repo, `frontier-${feature}`, () => {
    const { frontier: ready, malformed, conflicts } = frontier(control, feature);
    if (malformed.length || conflicts.length) throw new Refusal(`tracker ${feature} fails the claims gate; run \`goal.mjs frontier ${feature}\``);
    const taken = ready.slice(0, Math.max(0, max));
    for (const id of taken) setStatus(repo, feature, id, 'in-flight');
    return taken;
  });
}

/**
 * A ticket-file write commits only its own change, so a hand edit never rides in under a status or claims
 * message. Ticked acceptance boxes are the one edit allowed through: BUILD.md step 6 ticks them before `done`.
 */
function requireCommitted(control, file) {
  const rel = path.relative(control, file);
  const committed = spawnSync('git', ['-C', control, 'show', `HEAD:${rel}`], { encoding: 'utf8' });
  const untick = (t) => t.replace(/^(\s*- )\[[xX]\]/gm, '$1[ ]');
  if (committed.status !== 0 || untick(committed.stdout) !== untick(fs.readFileSync(file, 'utf8'))) {
    throw new Refusal(`${rel} has uncommitted edits; commit them first with their own reason: \`goal.mjs commit -m "<why>" ${rel}\``);
  }
}

/** The one tracker file for a ticket number, refusing a number two files share. */
function ticketFile(issues, feature, id) {
  const want = ticketId(String(id));
  const { files, duplicates } = ticketFiles(issues);
  if (duplicates.some((d) => d.id === want)) throw new Error(`ticket number ${want} is used by more than one file in tracker/${feature}/issues`);
  const file = files.get(want);
  if (!file) throw new Error(`no ticket ${id} in tracker/${feature}/issues`);
  return { want, file };
}

/**
 * Move one ticket along TICKET_MOVES. Leaving ready-for-agent for in-flight is a dispatch and passes the gate `take` does;
 * needs-human back to in-flight is a resume. Done needs `landed`, the commit that carries the ticket on the integration branch.
 */
export function setStatus(repo, feature, id, status, { reason = '', landed = null } = {}) {
  if (!STATUSES.has(status)) throw new UsageError(`unknown status ${status} (${[...STATUSES].join(' | ')})`);
  reason = reason.trim();
  if (/[\r\n]/.test(reason)) throw new UsageError('a status reason is one line');
  if (reason && !MAY_HAVE_REASON.has(status)) throw new UsageError(`only ${[...MAY_HAVE_REASON].join(', ')} carry a reason`);
  if (NEEDS_REASON.has(status) && !reason) throw new UsageError(`${status} needs its reason: \`goal.mjs status ${feature} ${id} ${status} -- <why>\``);
  if (landed !== null && status !== 'done') throw new UsageError('--landed goes with done');
  const control = requireControl(repo);
  const issues = path.join(control, 'tracker', feature, 'issues');
  // Read-modify-write under the same lock take uses, so no status flip is lost.
  return withLock(repo, `frontier-${feature}`, () => {
    const { want, file } = ticketFile(issues, feature, id);
    requireCommitted(control, file);
    const text = fs.readFileSync(file, 'utf8');
    const from = parseTicket(text).status;
    if (!from) throw new Error(`${path.basename(file)} has no **Status:** line`);
    if (from === status && parseTicket(text).reason === reason) return 'nothing to commit';
    if (from !== status && !TICKET_MOVES[from]?.includes(status)) {
      throw new Refusal(`ticket ${want} cannot go from ${from} to ${status} (from ${from}: ${TICKET_MOVES[from]?.join(', ') || 'nothing, it is final'})`);
    }
    let subject = `→ ${status}`;
    if (status === 'in-flight' && from === 'ready-for-agent') {
      const { frontier: ready, malformed, conflicts } = frontier(control, feature);
      if (malformed.length || conflicts.length) throw new Refusal(`tracker ${feature} fails the claims gate; run \`goal.mjs frontier ${feature}\``);
      if (!ready.includes(want)) throw new Refusal(`ticket ${want} is not on the frontier (ready-for-agent with every blocker done); dispatch it with \`goal.mjs take\``);
    }
    if (status === 'in-flight' && from === 'needs-human') subject = '→ in-flight (resumed)';
    if (status === 'done') {
      if (landed === null) throw new UsageError(`done needs --landed <sha>: the commit that carries ticket ${want} on the integration branch`);
      const sha = doneGate(repo, control, feature, want, file, text, landed);
      subject = `→ done (landed ${sha.slice(0, 12)})`;
    }
    if (reason) subject += `: ${reason}`;
    const waived = new Set(waivedCriteria(text));
    const ticked = status === 'done' ? text.replace(/^(\s*- )\[ \] (.+)$/gm, (line, lead, c) => (waived.has(c.trim()) ? line : `${lead}[x] ${c}`)) : text;
    fs.writeFileSync(file, ticked.replace(STATUS_LINE, `**Status:** ${status}${reason ? `: ${reason}` : ''}`));
    return commit(repo, `[${feature}] ticket ${want} ${subject}`, [path.relative(control, file)], { owner: 'status' });
  });
}

/**
 * A dispatched ticket is done only when what landed is what its receipt proves (BUILD.md step 5.0): the committed receipt
 * passes the check against git at its own head, the ticket's claims and criteria are the dispatched ones, and `landed`
 * either contains that head or carries the same change (equal `git patch-id`, so a squash merge counts). Returns landed's sha.
 */
function doneGate(repo, control, feature, want, file, ticketText, landed) {
  const problems = sinceDispatch(file);
  const tickets = path.join(control, 'runs', feature, 'tickets');
  const receiptFile = path.join(tickets, `${want}.receipt.md`);
  if (!fs.existsSync(receiptFile)) throw new Refusal(`ticket ${want} has no receipt at ${path.relative(control, receiptFile)}`);
  requireCommitted(control, receiptFile);
  const text = fs.readFileSync(receiptFile, 'utf8');
  const r = receiptJson(text) ?? {};
  const head = typeof r.head === 'string' ? commitOf(repo, r.head) : null;
  const base = typeof r.ticket_base === 'string' ? commitOf(repo, r.ticket_base) : null;
  const landedSha = commitOf(repo, landed);
  if (!head || !base) throw new Refusal(`ticket ${want}'s receipt names head ${r.head} and ticket_base ${r.ticket_base}; both must be commits in this repository (fetch first)`);
  if (!landedSha) throw new Refusal(`landed ${landed} is not a commit in this repository (fetch first)`);
  const contract = path.join(tickets, `${want}.goal.md`);
  const contractBase = fs.existsSync(contract) ? fs.readFileSync(contract, 'utf8').match(/^- Ticket base: (\S+)/m)?.[1] : null;
  if (contractBase && commitOf(repo, contractBase) !== base) problems.push(`receipt ticket_base ${base.slice(0, 12)} is not the contract's Ticket base ${contractBase}`);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-receipt-'));
  try {
    git(repo, ['worktree', 'add', '-q', '--detach', wt, head]);
    const checked = checkReceipt({ text, worktree: wt, base, ticketText });
    problems.push(...checked.problems);
    if (checked.conclusion !== 'completed') problems.push(`conclusion is ${JSON.stringify(checked.conclusion)}, not completed`);
  } finally {
    spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt]);
    fs.rmSync(wt, { recursive: true, force: true });
  }
  const contains = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', head, landedSha]).status === 0;
  if (!contains) {
    const landedId = patchId(repo, `${landedSha}^`, landedSha);
    if (!landedId || landedId !== patchId(repo, base, head)) problems.push(`landed ${landedSha.slice(0, 12)} neither contains receipt head ${head.slice(0, 12)} nor carries the same change (patch-id); get a receipt for what actually landed`);
  }
  if (problems.length) throw new Refusal(`ticket ${want} is not done: ${problems.join('; ')}`);
  return landedSha;
}

/** `git patch-id --stable` of a diff: equal ids mean the same change, whatever line numbers or merge base it moved to. */
function patchId(cwd, from, to) {
  const diff = spawnSync('git', ['-C', cwd, 'diff', from, to], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (diff.status !== 0 || !diff.stdout) return null;
  return spawnSync('git', ['-C', cwd, 'patch-id', '--stable'], { input: diff.stdout, encoding: 'utf8' }).stdout.split(' ')[0] || null;
}

const CLAIMS_LINE = /^\*\*Claims:\*\* (.+)$/m;
const AMENDED = /^\*\*Claims amended:\*\* /gm;
export const MAX_AMENDMENTS = 2;
// PLAN.md stage 6's guarded classes, which no amendment may add undeclared: CI workflows, migrations, top-level files.
const GUARDED_CLASS = /^(?:\.github\/|\.gitlab-ci|\.circleci\/|[^/]+$)|(?:^|\/)migrations\//;

/**
 * Widen an in-flight ticket's claims after its implementer reported a claims breach. Tracker issue,
 * contract and ledger change in one commit; a guarded path, a new overlap inside the run, or a third
 * amendment (the ticket is mis-scoped) is refused and nothing changes. Other runs' overlaps are reported.
 */
export function amendClaims(repo, feature, id, kind, paths, why) {
  if (kind === 'guarded') throw new Refusal('a guarded path needs the objective\'s grant, never an amendment');
  if (!['exclusive', 'shared-regenerate'].includes(kind)) throw new UsageError(`claim kind must be exclusive or shared-regenerate, got ${kind}`);
  if (!paths.length || !why.trim()) throw new UsageError('claim needs at least one path and a reason');
  if (/[\r\n,;]/.test(paths.join('')) || /[\r\n]/.test(why)) throw new UsageError('paths hold no , ; or newline, and the reason is one line');
  paths = paths.map((p) => p.replace(/^(?:\.\/)+/, ''));
  const outside = paths.filter((p) => !p || path.isAbsolute(p) || p.split('/').includes('..'));
  if (outside.length) throw new UsageError(`claims are repo-relative paths inside the repo, got ${outside.join(', ')}`);
  const control = requireControl(repo);
  const issues = path.join(control, 'tracker', feature, 'issues');
  return withLock(repo, `frontier-${feature}`, () => {
    const { want, file } = ticketFile(issues, feature, id);
    const { files } = ticketFiles(issues);
    requireCommitted(control, file);
    const before = fs.readFileSync(file, 'utf8');
    const ticket = parseTicket(before);
    if (ticket.problems.length) throw new Refusal(`ticket ${want} is malformed: ${ticket.problems.join('; ')}`);
    const fresh = paths.filter((p) => !ticket.claims[kind].some((c) => claimCovers(c, claimRoot(p))));
    if (!fresh.length) return { commit: 'already claimed', claims: before.match(CLAIMS_LINE)[1], cross_run: [] };
    const declared = [...files.values()].flatMap((f) => parseTicket(fs.readFileSync(f, 'utf8')).claims.guarded);
    const guarded = fresh.filter((p) => GUARDED_CLASS.test(p) || declared.some((g) => claimsOverlap(g, p)));
    if (guarded.length) throw new Refusal(`${guarded.join(', ')} is guarded; only the objective's grant authorizes it, so it becomes a blocker, never an amendment`);
    const amended = (before.match(AMENDED) ?? []).length;
    if (amended >= MAX_AMENDMENTS) throw new Refusal(`ticket ${want} already had ${amended} claims amendments, so it is mis-scoped: stop it and split it at PLAN.md 6b`);

    const oldLine = before.match(CLAIMS_LINE)[1];
    const newLine = withClaims(oldLine, kind, fresh);
    const note = `+${fresh.join(', ')} (${kind}): ${why.trim()}`;
    const contractRel = path.join('runs', feature, 'tickets', `${want}.goal.md`);
    const contractFile = path.join(control, contractRel);
    if (fs.existsSync(contractFile)) requireCommitted(control, contractFile);
    const contract = fs.existsSync(contractFile) ? fs.readFileSync(contractFile, 'utf8') : null;
    if (contract !== null && !contract.includes(oldLine)) throw new Refusal(`${contractRel} does not carry the ticket's Claims line verbatim; resync the contract first`);

    const known = new Set(frontier(control, feature).conflicts.map((c) => JSON.stringify(c)));
    fs.writeFileSync(file, before.replace(CLAIMS_LINE, () => `**Claims:** ${newLine}\n**Claims amended:** ${note}`));
    const after = frontier(control, feature);
    const added = after.conflicts.filter((c) => c.tickets.includes(want) && !known.has(JSON.stringify(c)));
    if (added.length) {
      fs.writeFileSync(file, before);
      const [c] = added;
      throw new Refusal(`the new claim overlaps ticket ${c.tickets.find((t) => t !== want)}'s ${c.claims.join(' / ')}; add a blocking edge or split the change into its own ticket`);
    }
    const changed = [path.relative(control, file)];
    if (contract !== null) {
      fs.writeFileSync(contractFile, contract.split(oldLine).join(newLine));
      changed.push(contractRel);
    }
    const cross = after.cross_run.filter((c) => c.tickets[0] === want && fresh.some((p) => claimsOverlap(p, c.claims[0])));
    const ledger = path.join('runs', feature, 'ledger.md');
    // The ledger is shared with `event`, so its read-modify-write holds the control lock like every other ledger write.
    const sha = withLock(repo, 'control', () => {
      if (fs.existsSync(path.join(control, ledger))) {
        appendEvent(path.join(control, ledger), 'claims', `${want} ${note}`);
        changed.push(ledger);
      }
      return commit(repo, `[${feature}] [claims] ${want} ${note}`, changed, { owner: 'claim' });
    });
    return { commit: sha, claims: newLine, cross_run: cross };
  });
}

export const MAX_WAIVERS = 1;

/**
 * Waive one acceptance criterion of an in-flight ticket that its committed receipt shows unmet and that is proven wrong or
 * unmeetable here (an equivalent mutant, files another in-flight ticket owns): a `**Waived:**` line plus a ledger event, one
 * commit. `carriedTo` names the ticket that now holds the criterion verbatim. One waiver per ticket; more means re-plan it.
 */
export function waive(repo, feature, id, index, why, { carriedTo = null } = {}) {
  if (!why.trim() || /[\r\n]/.test(why)) throw new UsageError('waive needs a one-line reason');
  const control = requireControl(repo);
  const issues = path.join(control, 'tracker', feature, 'issues');
  return withLock(repo, `frontier-${feature}`, () => {
    const { want, file } = ticketFile(issues, feature, id);
    requireCommitted(control, file);
    const before = fs.readFileSync(file, 'utf8');
    const criteria = ticketCriteria(before);
    const criterion = criteria[Number(index) - 1];
    if (!criterion) throw new UsageError(`ticket ${want} has no criterion ${index} (it has ${criteria.length}, numbered from 1)`);
    const waived = new Set(waivedCriteria(before));
    if (waived.has(criterion)) return { commit: 'already waived', criterion };
    const status = parseTicket(before).status;
    if (status !== 'in-flight') throw new Refusal(`ticket ${want} is ${status}; only an in-flight ticket's criterion is waived, against its receipt`);
    if (waived.size >= MAX_WAIVERS) throw new Refusal(`ticket ${want} already has ${waived.size} waiver; a second unmeetable criterion means the ticket is wrong, so stop it and re-plan`);
    if (criteria.every((c) => c === criterion || waived.has(c))) throw new Refusal(`waiving it would leave no criterion left in force for ticket ${want}; the ticket is wrong, so stop it and re-plan`);
    const receiptRel = path.join('runs', feature, 'tickets', `${want}.receipt.md`);
    if (!fs.existsSync(path.join(control, receiptRel))) throw new Refusal(`a waiver answers a receipt: commit ticket ${want}'s receipt at ${receiptRel} first`);
    requireCommitted(control, path.join(control, receiptRel));
    const entry = (receiptJson(fs.readFileSync(path.join(control, receiptRel), 'utf8'))?.criteria ?? [])
      .find((c) => typeof c?.criterion === 'string' && [norm(criterion), norm(withoutNote(criterion))].includes(norm(c.criterion)));
    if (!['fail', 'not-run'].includes(entry?.result)) throw new Refusal(`the committed receipt shows "${criterion}" as ${entry?.result ?? 'absent'}; only a criterion the receipt shows fail or not-run is waived`);
    let carried = '';
    if (carriedTo !== null) {
      const { want: to, file: toFile } = ticketFile(issues, feature, carriedTo);
      const target = fs.readFileSync(toFile, 'utf8');
      if (to === want || parseTicket(target).status === 'done' || !ticketCriteria(target).some((c) => norm(c) === norm(criterion))) {
        throw new Refusal(`ticket ${to} must be another open ticket that already holds "${criterion}" verbatim`);
      }
      carried = ` (carried to ${to})`;
    }
    const note = `${criterion} — ${why.trim()}${carried}`;
    fs.writeFileSync(file, `${before.replace(/\n*$/, '\n')}**Waived:** ${note}\n`);
    const changed = [path.relative(control, file)];
    const ledger = path.join('runs', feature, 'ledger.md');
    const sha = withLock(repo, 'control', () => {
      if (fs.existsSync(path.join(control, ledger))) {
        appendEvent(path.join(control, ledger), 'waive', `${want} ${note}`);
        changed.push(ledger);
      }
      return commit(repo, `[${feature}] [waive] ${want} ${note}`, changed, { owner: 'waive' });
    });
    return { commit: sha, criterion };
  });
}

/** Add paths to one class of a Claims line, creating the class part if the line has none. */
function withClaims(line, kind, add) {
  const parts = line.split(';').map((p) => p.trim()).filter(Boolean);
  const at = parts.findIndex((p) => p.startsWith(`${kind}:`));
  if (at < 0) return [...parts, `${kind}: ${add.join(', ')}`].join(' ; ');
  const have = parts[at].slice(kind.length + 1).split(',').map((c) => c.trim()).filter((c) => c && c !== 'none');
  parts[at] = `${kind}: ${[...have, ...add].join(', ')}`;
  return parts.join(' ; ');
}

function dependsOn(tickets, from, to, seen = new Set()) {
  if (seen.has(from)) return false;
  seen.add(from);
  return (tickets.get(from)?.blockers ?? []).some((b) => b === to || dependsOn(tickets, b, to, seen));
}

/** A claim is a file path, a directory ending in `/`, or a directory ending in `/**`. */
export function claimCovers(claim, file) {
  const root = claimRoot(claim);
  const dir = root.endsWith('/') ? root : null;
  return dir ? file.startsWith(dir) : file === claim;
}

const claimRoot = (claim) => (claim.endsWith('/**') ? claim.slice(0, -2) : claim);

function claimsOverlap(a, b) {
  return claimCovers(a, claimRoot(b)) || claimCovers(b, claimRoot(a));
}

export function claimsBreach(ticketText, touched) {
  const { claims } = parseTicket(ticketText);
  const covered = (list, file) => list.some((c) => claimCovers(c, file));
  return {
    unclaimed: touched.filter((f) => !covered(claims.exclusive, f) && !covered(claims['shared-regenerate'], f) && !covered(claims.guarded, f)),
    guarded: touched.filter((f) => covered(claims.guarded, f)),
  };
}

// ------------------------------------------------------------- receipts

const CONCLUSIONS = new Set(['completed', 'partial', 'blocked', 'stuck', 'claims-breach', 'stopped']);
const RESULTS = new Set(['pass', 'fail', 'not-run']);
const QUALITY = new Set(['accurate', 'criteria-too-vague', 'criteria-wrong', 'missing-constraint', 'over-scoped']);

/** The receipt in a file: the whole file as JSON, else the last ```json fence (a worker's final message). */
function receiptJson(text) {
  try {
    return JSON.parse(text);
  } catch { /* a final message, not a bare receipt */ }
  const fences = [...text.matchAll(/```json[ \t]*\n([\s\S]*?)\n```/g)];
  if (!fences.length) return null;
  try {
    return JSON.parse(fences.at(-1)[1]);
  } catch {
    return null;
  }
}

/** The full SHA a revision names, or null when it names no commit. */
function commitOf(cwd, rev) {
  const run = spawnSync('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
// Implementers quote a criterion without its trailing "(Red at base: …)" or "(Invariant …)" note; one such group may be dropped.
const withoutNote = (s) => s.replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, '');
/** Criteria a `**Waived:** <criterion verbatim> — <why>` line (written only by `goal.mjs waive`) releases from the receipt. */
const waivedCriteria = (text) => ticketCriteria(text).filter((c) => text.split('\n').some((l) => l.startsWith(`**Waived:** ${c} — `)));
const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Every checkbox line in a ticket is one acceptance criterion (local and GitHub templates alike). */
export function ticketCriteria(text) {
  return [...text.matchAll(/^\s*- \[[ xX]\] (.+)$/gm)].map((m) => m[1].trim());
}

/**
 * A worktree whose .git file is gone (removed mid-check) or a path inside one would make git
 * answer for the enclosing repo, so every git check first proves the path is its own worktree root.
 */
function notWorktreeRoot(worktree) {
  const r = spawnSync('git', ['-C', worktree, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  return r.status === 0 && real(r.stdout.trim()) === real(worktree) ? null : `${worktree} is not a worktree root (removed, or a path inside one), so git cannot check it`;
}

/**
 * A contract is compiled by hand at dispatch; this checks it against the worktree and the ticket
 * before the implementer sees it, so a guessed base SHA or a drifted Claims or criterion line never ships.
 */
export function checkContract({ text, ticketText, worktree }) {
  const bad = notWorktreeRoot(worktree);
  if (bad) return { ok: false, problems: [bad] };
  const problems = [];
  const base = text.match(/^- Ticket base: (\S+)/m)?.[1];
  // The base is where goal/<slug>-t<NN> left goal/<slug>: HEAD at dispatch, still the fork point at a re-dispatch.
  const out = (args) => { const r = spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
  const run = out(['rev-parse', '--abbrev-ref', 'HEAD'])?.match(/^(goal\/.+)-t\d+$/)?.[1];
  const fork = run ? out(['merge-base', 'HEAD', run]) : out(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(base ?? '') || base !== fork) problems.push(`Ticket base ${base ?? '(missing)'} is not ${fork ?? 'the fork point'} (where the ticket branch left ${run ?? 'the run branch'}); paste \`git rev-parse HEAD\` output at dispatch, never type a sha`);
  const claims = ticketText.match(CLAIMS_LINE)?.[1];
  if (!claims) problems.push('the ticket has no **Claims:** line');
  else if (!text.includes(`- Claims: ${claims}`)) problems.push(`the contract's Claims line is not the ticket's verbatim: "${claims}"`);
  const have = new Set(ticketCriteria(text).map(norm));
  const want = ticketCriteria(ticketText);
  for (const c of want) if (!have.has(norm(c))) problems.push(`criterion missing or not verbatim: "${c}"`);
  const known = new Set(want.map(norm));
  for (const c of ticketCriteria(text)) if (!known.has(norm(c))) problems.push(`criterion not in the ticket: "${c}"`);
  return { ok: !problems.length, problems };
}

/**
 * What a ticket may have become since its dispatch, read from history so a raw `git commit` cannot slip past it:
 * a dispatched status has a dispatch commit (`[<feature>] ticket NN → in-flight`, written only by take/status), the
 * criteria are the dispatched ones, and the Claims line is the dispatched one plus its `**Claims amended:**` lines.
 */
export function sinceDispatch(ticketPath) {
  const file = fs.realpathSync(ticketPath);
  const top = spawnSync('git', ['-C', path.dirname(file), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) return [];
  const root = fs.realpathSync(top.stdout.trim());
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, 'utf8');
  const status = parseTicket(text).status;
  const [, feature, raw] = rel.split(path.sep).join('/').match(/^tracker\/([^/]+)\/issues\/(\d+)/) ?? [];
  const id = ticketId(raw ?? '');
  const dispatched = `[${feature}] ticket ${id} → in-flight`;
  const sha = spawnSync('git', ['-C', root, 'log', '--format=%H %s', '--', rel], { encoding: 'utf8' }).stdout
    .split('\n').find((line) => line.slice(41) === dispatched)?.slice(0, 40);
  if (!sha) return FROZEN.has(status) ? [`ticket ${id} is ${status} but has no "${dispatched}" commit; a ticket enters in-flight only through goal.mjs take or status`] : [];
  const was = git(root, ['show', `${sha}:${rel}`]);
  const problems = [];
  const before = ticketCriteria(was).map(norm);
  const after = ticketCriteria(text).map(norm);
  const criteriaDrift = [...after.filter((c) => !before.includes(c)).map((c) => `+"${c}"`), ...before.filter((c) => !after.includes(c)).map((c) => `-"${c}"`)];
  if (criteriaDrift.length) problems.push(`criteria changed since dispatch (${sha.slice(0, 8)}): ${criteriaDrift.join(', ')}; a dispatched ticket never gains or loses one: restore them, put new work in a new ticket, and waive a proven-wrong one with \`goal.mjs waive\``);
  const then = parseTicket(was).claims;
  const now = parseTicket(text).claims;
  for (const [, paths, kind] of text.matchAll(/^\*\*Claims amended:\*\* \+(.+?) \((exclusive|shared-regenerate)\): /gm)) then[kind].push(...paths.split(', '));
  for (const kind of Object.keys(now)) {
    const want = new Set(then[kind].filter((c) => c !== 'none'));
    const have = new Set(now[kind].filter((c) => c !== 'none'));
    const drift = [...[...have].filter((c) => !want.has(c)).map((c) => `+${c}`), ...[...want].filter((c) => !have.has(c)).map((c) => `-${c}`)];
    if (drift.length) problems.push(`${kind} claims changed since dispatch (${sha.slice(0, 8)}) other than by goal.mjs claim: ${drift.join(', ')}; restore the line, then add paths with \`goal.mjs claim\` (BUILD.md § Claims amendment)`);
  }
  return problems;
}

const ORC_DISPATCH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'to-orc', 'scripts', 'orc-dispatch.mjs');

/** A ticket's to-orc run directory, one per ticket: its worker, cycles and budget live there and nowhere else. */
export const orcRunDir = (repo, feature, id) => path.join(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'to-orc', feature, `t${ticketId(String(id))}`);

/**
 * The only way a pi worker gets a ticket (BUILD.md § Worker): the ticket is in flight through take/status, its committed
 * contract passes the contract check and the since-dispatch check, and to-orc runs in the ticket's own run directory,
 * so its cycle cap is the ticket's repair budget. `--poll` only reads, so it skips the checks.
 */
export function dispatch(repo, feature, id, worktree, orcArgs) {
  if (orcArgs.some((a) => a === '--run-dir' || a === '--repo')) throw new UsageError('dispatch sets --run-dir and --repo itself');
  const control = requireControl(repo);
  const runDir = orcRunDir(repo, feature, id);
  const poll = orcArgs.includes('--poll');
  if (!poll) {
    const { want, file } = ticketFile(path.join(control, 'tracker', feature, 'issues'), feature, id);
    const ticketText = fs.readFileSync(file, 'utf8');
    if (parseTicket(ticketText).status !== 'in-flight') throw new Refusal(`ticket ${want} is ${parseTicket(ticketText).status}; \`goal.mjs take\` puts it in flight first`);
    const contract = path.join(control, 'runs', feature, 'tickets', `${want}.goal.md`);
    if (!fs.existsSync(contract)) throw new Refusal(`ticket ${want} has no contract at ${path.relative(control, contract)}`);
    requireCommitted(control, contract);
    const problems = [...checkContract({ text: fs.readFileSync(contract, 'utf8'), ticketText, worktree }).problems, ...sinceDispatch(file)];
    if (problems.length) throw new Refusal(`ticket ${want} is not dispatchable: ${problems.join('; ')}`);
  }
  const run = spawnSync(process.execPath, [ORC_DISPATCH, ...orcArgs, '--run-dir', runDir, ...(poll ? [] : ['--repo', worktree])], { stdio: 'inherit' });
  if (run.error) throw run.error;
  return run.status ?? 1;
}

/**
 * An implementer's receipt is a claim; this checks it against what git and the ticket say.
 * Git is consulted only when `worktree` is given, the ticket only when `ticketText` is.
 */
export function checkReceipt({ text, worktree = null, base = null, ticketText = null }) {
  const r = receiptJson(text);
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, problems: ['no receipt: neither the file nor a ```json fence in it is a JSON object'] };
  const problems = [];
  for (const field of ['ticket', 'ticket_base', 'head']) if (typeof r[field] !== 'string' || !r[field]) problems.push(`${field} must be a non-empty string`);
  if (!CONCLUSIONS.has(r.conclusion)) problems.push(`conclusion must be one of ${[...CONCLUSIONS].join(' | ')}, got ${JSON.stringify(r.conclusion)}`);
  for (const field of ['changed_files', 'not_validated', 'blockers', 'external_effects']) if (!strings(r[field])) problems.push(`${field} must be an array of strings`);
  if (typeof r.worktree_clean !== 'boolean') problems.push('worktree_clean must be true or false');
  if (!r.review || !Number.isInteger(r.review.cited_fixed) || !strings(r.review.leads)) problems.push('review must be { cited_fixed: <integer>, leads: [<string>] }');
  if (r.contract_quality !== undefined && r.contract_quality !== null && !QUALITY.has(r.contract_quality)) problems.push(`contract_quality must be one of ${[...QUALITY].join(' | ')}`);
  const validation = Array.isArray(r.validation) ? r.validation : [];
  if (!Array.isArray(r.validation) || validation.some((v) => typeof v?.command !== 'string' || !Number.isInteger(v?.exit))) problems.push('validation must be an array of { command, exit: <integer>, summary, log: { path, sha256 } }');
  // A repair round answers review findings beside the ticket's own criteria, never instead of them (CONTRACT.md § The receipt).
  const repairs = r.repairs === undefined ? [] : r.repairs;
  if (!Array.isArray(repairs) || repairs.some((x) => typeof x?.finding !== 'string' || !RESULTS.has(x?.result) || (x.result !== 'not-run' && !(typeof x.evidence === 'string' && x.evidence.trim())))) {
    problems.push('repairs must be an array of { finding, result: pass | fail | not-run, evidence }');
  }
  const criteria = Array.isArray(r.criteria) ? r.criteria : [];
  if (!Array.isArray(r.criteria)) problems.push('criteria must be an array');
  for (const c of criteria) {
    if (typeof c?.criterion !== 'string' || !RESULTS.has(c?.result)) problems.push(`criterion ${JSON.stringify(c?.criterion)} needs a result of pass | fail | not-run`);
    else if (c.result !== 'not-run' && (typeof c.evidence !== 'string' || !c.evidence.trim())) problems.push(`criterion "${c.criterion}" has a ${c.result} result with no evidence`);
  }
  // A partial receipt whose every miss is a criterion the ticket waived (`goal.mjs waive`) counts as completed.
  const waived = ticketText === null ? new Set() : new Set(waivedCriteria(ticketText));
  const entry = (want) => criteria.find((c) => typeof c?.criterion === 'string' && [norm(want), norm(withoutNote(want))].includes(norm(c.criterion)));
  const byWaiver = r.conclusion === 'partial' && waived.size > 0 && ticketCriteria(ticketText).every((w) => waived.has(w) || entry(w)?.result === 'pass');
  const completed = r.conclusion === 'completed' || byWaiver;
  if (['blocked', 'stuck', 'claims-breach'].includes(r.conclusion) && strings(r.blockers) && !r.blockers.length) problems.push(`a ${r.conclusion} receipt must name its reason in blockers`);
  if (completed) {
    if (!byWaiver && strings(r.blockers) && r.blockers.length) problems.push('a completed receipt cannot carry blockers');
    if (!validation.length) problems.push('a completed receipt needs at least one validation command');
    if (r.worktree_clean === false) problems.push('a completed receipt needs a clean worktree');
    if (Array.isArray(repairs)) for (const x of repairs) if (x?.result !== 'pass') problems.push(`repair "${x?.finding}" is ${x?.result}, so the receipt cannot be completed`);
  }

  if (ticketText !== null) {
    const byText = new Map();
    for (const c of criteria.filter((x) => typeof x?.criterion === 'string')) {
      if (byText.has(norm(c.criterion))) problems.push(`receipt criterion "${c.criterion}" appears more than once`);
      byText.set(norm(c.criterion), c);
    }
    const wanted = ticketCriteria(ticketText);
    if (completed && !wanted.length) problems.push('the ticket has no acceptance criteria (checkbox lines), so nothing can show it completed');
    else if (completed && wanted.every((w) => waived.has(w))) problems.push('every ticket criterion is waived, so nothing shows it completed');
    for (const want of wanted) {
      const got = byText.get(norm(want)) ?? byText.get(norm(withoutNote(want)));
      if (waived.has(want)) continue;
      if (!got) problems.push(`ticket criterion "${want}" has no entry in the receipt`);
      else if (completed && got.result !== 'pass') problems.push(`ticket criterion "${want}" is ${got.result}, so the receipt cannot be completed`);
    }
    const known = new Set(wanted.flatMap((w) => [norm(w), norm(withoutNote(w))]));
    for (const c of byText.values()) if (!known.has(norm(c.criterion))) problems.push(`receipt criterion "${c.criterion}" is not in the ticket`);
  }

  const bad = worktree !== null && notWorktreeRoot(worktree);
  if (bad) problems.push(bad);
  else if (worktree !== null) {
    const head = git(worktree, ['rev-parse', 'HEAD']);
    if (r.head !== head) problems.push(`head ${r.head} is not the worktree HEAD ${head}`);
    if (base !== null && (!r.ticket_base || commitOf(worktree, r.ticket_base) !== commitOf(worktree, base))) {
      problems.push(`ticket_base ${r.ticket_base} is not the dispatch base ${base}`);
    }
    if (base !== null && strings(r.changed_files)) {
      const actual = git(worktree, ['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean).sort();
      const claimed = [...new Set(r.changed_files)].sort();
      if (actual.join('\n') !== claimed.join('\n')) problems.push(`changed_files [${claimed.join(', ')}] differ from git diff ${base}...HEAD [${actual.join(', ')}]`);
    }
    const dirty = git(worktree, ['status', '--porcelain']) !== '';
    if (typeof r.worktree_clean === 'boolean' && r.worktree_clean === dirty) problems.push(`worktree_clean is ${r.worktree_clean} but git status says the worktree is ${dirty ? 'dirty' : 'clean'}`);
    if (completed) for (const v of validation) problems.push(...runLogProblems(worktree, v, head));
  }
  return { ok: problems.length === 0, conclusion: byWaiver ? 'completed' : r.conclusion ?? null, waived: [...waived], problems };
}

// ------------------------------------------------------ validation logs

const RUN_FOOTER = 'goal.mjs run: ';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const logsDir = (cwd) => path.join(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'goal-logs');

/**
 * Run one validation command through the shell in `cwd` and keep its output under the repo's git-common-dir (outside every
 * worktree, so none gets dirty), ending in a footer that records the command, its exit code and the HEAD it ran at.
 * The receipt cites `{ path, sha256 }`; the receipt check re-reads the log, so a validation line is evidence, not prose.
 */
export function runLogged(cwd, command) {
  if (!command.trim()) throw new UsageError('run needs a command after --');
  refuseBlinded(cwd, 'Commit, `goal.mjs worktree return` this worktree, then `worktree get` it again: treehouse slots are then cut under the control plane.');
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const dirty = git(cwd, ['status', '--porcelain']) !== '';
  const run = spawnSync(command, { cwd, shell: true, encoding: 'utf8', maxBuffer: 1 << 30 });
  const exit = run.status ?? 1;
  const body = `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? `${run.error.message}\n` : ''}\n${RUN_FOOTER}${JSON.stringify({ command, exit, head, dirty })}\n`;
  const dir = logsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${head.slice(0, 12)}-${Date.now()}-${process.pid}.log`);
  fs.writeFileSync(file, body);
  return { exit, output: `${run.stdout ?? ''}${run.stderr ?? ''}`, log: { path: file, sha256: sha256(body) } };
}

/** A completed receipt's validation line stands only on its log: unchanged, from this repo, same command and exit, at the receipt head, clean. */
function runLogProblems(worktree, v, head) {
  const what = `validation "${v?.command}"`;
  if (typeof v?.log?.path !== 'string' || typeof v?.log?.sha256 !== 'string') return [`${what} has no log; run it as \`goal.mjs run -- ${v?.command}\` and cite the { path, sha256 } it prints`];
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const file = real(v.log.path);
  const inside = path.relative(real(logsDir(worktree)), file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return [`${what} cites ${v.log.path}, which is not a goal.mjs run log of this repository`];
  if (!fs.existsSync(file)) return [`${what} cites a log that does not exist: ${v.log.path}`];
  const body = fs.readFileSync(file, 'utf8');
  if (sha256(body) !== v.log.sha256) return [`${what} log ${v.log.path} does not match its sha256; it changed after the run`];
  let footer = null;
  try { footer = JSON.parse(body.trimEnd().split('\n').at(-1).slice(RUN_FOOTER.length)); } catch { /* reported below */ }
  if (!footer || !body.trimEnd().split('\n').at(-1).startsWith(RUN_FOOTER)) return [`${what} log ${v.log.path} has no goal.mjs run footer`];
  const problems = [];
  if (footer.command !== v.command) problems.push(`${what} log ran "${footer.command}"`);
  if (footer.exit !== v.exit) problems.push(`${what} claims exit ${v.exit} but its log ended ${footer.exit}`);
  if (footer.head !== head) problems.push(`${what} ran at ${String(footer.head).slice(0, 12)}, not the receipt head ${head.slice(0, 12)}`);
  if (footer.dirty) problems.push(`${what} ran on a dirty worktree, so it proves no commit`);
  return problems;
}

// --------------------------------------------------------------- locks

// Locks this process (or the with-lock that spawned it) already holds; taking one again is a
// no-op, so `with-lock control -- goal.mjs commit …` cannot deadlock on itself.
const held = new Set((process.env.GOAL_LOCKS_HELD ?? '').split(',').filter(Boolean));

export function withLock(repo, name, fn) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error(`bad lock name: ${name}`); // no dots: .new-* and .break are reserved
  if (held.has(name)) return fn();
  const locks = path.join(controlDir(repo), 'locks');
  fs.mkdirSync(locks, { recursive: true });
  const lock = path.join(locks, name);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (tryAcquire(lock)) break;
    if (stalePidOf(lock) !== null) {
      breakStale(lock);
      continue;
    }
    if (Date.now() > deadline) throw new Error(`lock ${name} still held after ${LOCK_WAIT_MS / 1000}s (${lock})`);
    sleep(100);
  }
  held.add(name);
  try {
    return fn();
  } finally {
    held.delete(name);
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** The dead holder's pid when the lock is stale (older than 10 minutes, holder gone), else null. */
function stalePidOf(lock) {
  let stat;
  try {
    stat = fs.statSync(lock);
  } catch {
    return null;
  }
  if (Date.now() - stat.mtimeMs < STALE_LOCK_MS) return null;
  let pid;
  try {
    pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
  } catch {
    return -1; // no pid file: left by an older goal.mjs that wrote it after mkdir
  }
  try {
    process.kill(pid, 0);
    return null;
  } catch (error) {
    return error.code === 'ESRCH' ? pid : null;
  }
}

// The lock directory appears with its pid already inside (built aside, then renamed into
// place), so no lock is ever observed half-made.
function tryAcquire(lock) {
  const draft = `${lock}.new-${process.pid}-${Date.now()}`;
  fs.mkdirSync(draft);
  fs.writeFileSync(path.join(draft, 'pid'), String(process.pid));
  try {
    fs.renameSync(draft, lock);
    return true;
  } catch (error) {
    fs.rmSync(draft, { recursive: true, force: true });
    if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error.code)) return false;
    throw error;
  }
}

// Breaks are serialized by a guard directory, and the lock is re-judged stale while the guard
// is held: a breaker that judged an old lock stale never removes a lock someone re-took since,
// because only a guard holder removes one and a fresh lock is never stale.
// A guard outlives its holder only if that holder dies inside the millisecond break window;
// it is cleared after GUARD_STALE_MS.
export function breakStale(lock) {
  const guard = `${lock}.break`;
  try {
    fs.mkdirSync(guard);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) fs.rmdirSync(guard);
    } catch { /* another breaker cleared it */ }
    return;
  }
  try {
    if (stalePidOf(lock) !== null) fs.rmSync(lock, { recursive: true, force: true });
  } finally {
    fs.rmdirSync(guard);
  }
}

// Each ticket header field has one writer. A field outside the committing owner's set must come through unchanged.
const OWNERS = { status: ['status'], claim: ['claims', 'amended'], waive: ['waived'] };
const WRITERS = { status: 'goal.mjs take/status', claims: 'goal.mjs claim', amended: 'goal.mjs claim', waived: 'goal.mjs waive', fromReview: 'nobody after the ticket is created' };
const ownedFields = (text) => ({
  status: text.match(STATUS_LINE)?.[0] ?? '',
  claims: text.match(CLAIMS_LINE)?.[0] ?? '',
  amended: text.split('\n').filter((l) => l.startsWith('**Claims amended:** ')).join('\n'),
  waived: text.split('\n').filter((l) => l.startsWith('**Waived:** ')).join('\n'),
  fromReview: text.match(FROM_REVIEW_LINE)?.[0] ?? '',
});

/**
 * A tracker ticket changes only through its fields' owners: a new ticket enters well-formed as blocked or ready-for-agent,
 * Status moves only through `status`, amended claims and waivers only through `claim` and `waive`, the Claims line is edited
 * by hand only before dispatch, and a dispatched ticket (in-flight, needs-human, done) never changes a criterion.
 */
function ticketGuard(control, rel, owner) {
  const file = path.join(control, rel);
  if (!/^tracker\/[^/]+\/issues\/[^/]+\.md$/.test(rel) || !fs.existsSync(file)) return;
  const name = path.basename(rel);
  const after = fs.readFileSync(file, 'utf8');
  const parsed = parseTicket(after);
  if (parsed.problems.length) throw new Refusal(`${name} is malformed: ${parsed.problems.join('; ')}`);
  const committed = spawnSync('git', ['-C', control, 'show', `HEAD:${rel}`], { encoding: 'utf8' });
  if (committed.status !== 0) {
    if (!['blocked', 'ready-for-agent'].includes(parsed.status)) throw new Refusal(`${name} is new, so it starts blocked or ready-for-agent; \`goal.mjs take\` dispatches it`);
    const { amended, waived } = ownedFields(after);
    if (amended || waived) throw new Refusal(`${name} is new; **Claims amended:** and **Waived:** lines are written only by goal.mjs claim and waive`);
    return;
  }
  const was = parseTicket(committed.stdout);
  const allowed = new Set(OWNERS[owner] ?? []);
  if (!FROZEN.has(was.status)) allowed.add('claims');
  const before = ownedFields(committed.stdout);
  const now = ownedFields(after);
  for (const field of Object.keys(now)) {
    if (now[field] !== before[field] && !allowed.has(field)) throw new Refusal(`${name}: ${field === 'fromReview' ? '**From review:**' : field} is written only by ${WRITERS[field]}${field === 'claims' ? ' once the ticket is dispatched' : ''}`);
  }
  if (FROZEN.has(was.status) && JSON.stringify(ticketCriteria(committed.stdout)) !== JSON.stringify(ticketCriteria(after))) {
    throw new Refusal(`${name} is ${was.status}, so its criteria are frozen; put new work in a new ticket or NOW leads:, and waive a criterion proven wrong with \`goal.mjs waive\``);
  }
}

export function commit(repo, message, files, { owner = null } = {}) {
  if (!files.length) throw new Error('commit needs at least one file');
  const control = requireControl(repo);
  // Paths are relative to the control worktree; a path that resolves inside it from cwd also works,
  // unless only the control-relative reading names a file (commit run from inside runs/<slug>/).
  files = files.map((f) => {
    const fromCwd = path.relative(control, path.resolve(f));
    const inside = fromCwd && !fromCwd.startsWith('..') && !path.isAbsolute(fromCwd);
    if (!inside) return f;
    if (fromCwd !== f && !fs.existsSync(path.resolve(f)) && fs.existsSync(path.join(control, f))) return f;
    return fromCwd;
  });
  return withLock(repo, 'control', () => {
    for (const f of files) ticketGuard(control, f, owner);
    git(control, ['add', '--', ...files]);
    const staged = git(control, ['diff', '--cached', '--name-only', '--', ...files]);
    if (!staged) return 'nothing to commit';
    git(control, ['commit', '-q', '-m', message, '--', ...files]);
    return git(control, ['rev-parse', '--short', 'HEAD']);
  });
}

// ------------------------------------------------------------- plumbing

function isLocalPath(value) {
  return value.startsWith('/') || value.startsWith('.') || value.startsWith('file://');
}

function isRemoteOp(args) {
  const cmd = args.find((a) => !a.startsWith('-'));
  if (['push', 'pull', 'ls-remote'].includes(cmd)) return true;
  if (cmd === 'fetch' || cmd === 'clone') {
    const rest = args.slice(args.indexOf(cmd) + 1).filter((a) => !a.startsWith('-'));
    return !rest.length || !isLocalPath(rest[0]);
  }
  return false;
}

/** Refuse push/fetch/pull against a remote when this run was started with --no-remote. A local path is not a remote. */
export function remoteGuard(args) {
  if (!runtime.noRemote || !isRemoteOp(args)) return;
  throw new Refusal(`--no-remote forbids git ${args.find((a) => !a.startsWith('-'))}`);
}

function git(cwd, args) {
  remoteGuard(args);
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function isLinkedWorktree(repo) {
  const gitDir = fs.realpathSync(git(repo, ['rev-parse', '--path-format=absolute', '--git-dir']));
  const common = fs.realpathSync(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  return gitDir !== common;
}

export function commonDirWritable(repo) {
  try {
    fs.accessSync(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function canon(p) {
  const resolved = path.resolve(p);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  const parent = path.dirname(resolved);
  if (fs.existsSync(parent)) return path.join(fs.realpathSync(parent), path.basename(resolved));
  return resolved;
}

function inside(root, target) {
  const r = canon(root);
  const t = canon(target);
  return t === r || t.startsWith(r + path.sep);
}

export function plannedWrites(repo) {
  const writes = [controlDir(repo)];
  if (isLinkedWorktree(repo) && !commonDirWritable(repo)) writes.push(path.join(controlDir(repo), 'clone'));
  writes.push(path.resolve(repo));
  if (runtime.statusFile) writes.push(path.dirname(path.resolve(runtime.statusFile)));
  return [...new Set(writes)];
}

export function checkAllow(repo) {
  const planned = plannedWrites(repo);
  if (!runtime.allow.length) return { ok: true, planned };
  const outside = planned.filter((p) => !runtime.allow.some((a) => inside(a, p)));
  if (outside.length) throw new Refusal(`refusing to start: writes outside the allow list: ${outside.join(', ')}. Allowed: ${runtime.allow.join(', ')}`);
  return { ok: true, planned };
}

export function preflight(repo) {
  const problems = [];
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    problems.push('git is not on PATH');
  }
  try {
    git(repo, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    problems.push(`${repo} is not a git repository`);
  }
  let state;
  try {
    state = controlDir(repo);
    assertStateOutside(repo, state);
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.accessSync(path.dirname(state), fs.constants.W_OK);
  } catch (error) {
    problems.push(error.message.includes('inside the repo') ? error.message : `state directory is not writable: ${state ?? controlDir(repo)}`);
  }
  if (problems.length) throw new Error(`to-auto cannot start:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  const allow = checkAllow(repo);
  return { ok: true, stateDir: state, linked: isLinkedWorktree(repo), commonDirWritable: commonDirWritable(repo), allow, gitRequirement: 'git on PATH (no minimum version)' };
}

export function prepare(repo) {
  preflight(repo);
  const control = ensureControl(repo);
  const linked = isLinkedWorktree(repo);
  const writable = commonDirWritable(repo);
  const base = git(repo, ['rev-parse', 'HEAD']);
  let workspace = fs.realpathSync(repo);
  let cloned = false;
  if (linked && !writable) {
    const dest = path.join(control, 'clone');
    if (!fs.existsSync(path.join(dest, '.git'))) {
      fs.rmSync(dest, { recursive: true, force: true });
      remoteGuard(['clone', fs.realpathSync(repo), dest]);
      execFileSync('git', ['clone', '--no-local', '--quiet', fs.realpathSync(repo), dest], { stdio: ['ignore', 'pipe', 'pipe'] });
      const id = gitIdentity(repo);
      execFileSync('git', ['-C', dest, 'config', 'user.name', id.name], { stdio: 'ignore' });
      execFileSync('git', ['-C', dest, 'config', 'user.email', id.email], { stdio: 'ignore' });
    }
    workspace = dest;
    cloned = true;
  }
  const info = { cloned, workspace, returnTo: fs.realpathSync(repo), base, linked, commonDirWritable: writable };
  fs.writeFileSync(path.join(control, 'workspace.json'), `${JSON.stringify(info, null, 2)}\n`);
  commit(repo, '[state] workspace', ['workspace.json']);
  return info;
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

export function supervise(repo) {
  const report = preflight(repo);
  const prepared = prepare(repo);
  const saved = {
    base: runtime.base ? git(prepared.workspace, ['rev-parse', runtime.base]) : prepared.base,
    targetBranch: runtime.targetBranch,
    statusFile: runtime.statusFile,
    noRemote: runtime.noRemote,
    workerModel: runtime.workerModel ?? null,
  };
  fs.writeFileSync(path.join(controlDir(repo), 'supervisor.json'), `${JSON.stringify(saved, null, 2)}\n`);
  commit(repo, '[state] supervisor', ['supervisor.json']);
  return { ...report, ...prepared, supervisor: saved };
}

export function land(repo, slug = null) {
  const control = requireControl(repo);
  const ws = readJson(path.join(control, 'workspace.json'));
  const saved = readJson(path.join(control, 'supervisor.json'));
  const workspace = ws.workspace || fs.realpathSync(repo);
  const base = runtime.base || saved.base || ws.base;
  if (!base) throw new Error('land needs a base; pass --base or run prepare');
  const target = runtime.targetBranch || saved.targetBranch || null;
  const statusFile = runtime.statusFile || saved.statusFile || null;
  const range = git(workspace, ['log', '--reverse', '--format=%H %s', `${base}..HEAD`]);
  const commits = range.split('\n').filter(Boolean).map((line) => {
    const sp = line.indexOf(' ');
    return { sha: line.slice(0, sp), subject: line.slice(sp + 1) };
  });
  const items = commits.map((c) => ({ item: c.subject.match(/\bt\d{2}\b/)?.[0] || slug || 'run', sha: c.sha, subject: c.subject }));
  let returned = commits.at(-1)?.sha ?? null;
  if (ws.cloned && commits.length) {
    const returnTo = ws.returnTo;
    if (!commonDirWritable(returnTo)) {
      returned = path.join(control, 'return.bundle');
      git(workspace, ['bundle', 'create', returned, `${base}..HEAD`]);
    } else {
      let current;
      try {
        current = git(returnTo, ['symbolic-ref', '--short', 'HEAD']);
      } catch {
        throw new Refusal('caller HEAD is detached; land refuses to switch branches');
      }
      if (target && current !== target) throw new Refusal(`caller is on ${current}, not ${target}; land refuses to switch branches`);
      git(returnTo, ['fetch', workspace, 'HEAD']);
      git(returnTo, ['merge', '--ff-only', 'FETCH_HEAD']);
      returned = git(returnTo, ['rev-parse', 'HEAD']);
    }
  } else if (target && commits.length) {
    const current = git(workspace, ['symbolic-ref', '--short', 'HEAD']);
    if (current !== target) throw new Refusal(`caller is on ${current}, not ${target}; land refuses to switch branches`);
  }
  const summary = [`landed ${items.length} commit(s)${target ? ` on ${target}` : ''}`, ...items.map((i) => `${i.item} ${i.sha}`)].join('\n') + '\n';
  if (statusFile) {
    const dest = path.resolve(statusFile);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.appendFileSync(dest, summary);
  }
  if (slug) {
    const rel = path.join('runs', slug, 'landed.txt');
    fs.mkdirSync(path.dirname(path.join(control, rel)), { recursive: true });
    fs.writeFileSync(path.join(control, rel), summary);
    commit(repo, `[${slug}] land`, [rel]);
  }
  return { items, summary, returned };
}

// ------------------------------------------------------------ worktrees

/** The treehouse binary: TO_AUTO_TREEHOUSE when set ('' = none), else `treehouse` on PATH, else null. */
function treehouseBin() {
  if (process.env.TO_AUTO_TREEHOUSE !== undefined) return process.env.TO_AUTO_TREEHOUSE || null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const bin = path.join(dir, 'treehouse');
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      if (fs.statSync(bin).isFile()) return bin;
    } catch { /* not here */ }
  }
  return null;
}

/**
 * Ancestor `.gitignore`/`.ignore` files above `dir` that ignore everything below them. treehouse stamps `*` into its pool
 * root, and gitignore-aware tools (oxlint, anything on the ignore crate) read ancestor ignore files: a lint there scans no
 * files and exits 0, so nothing run in such a worktree is evidence.
 */
export function ignoreAllAncestors(dir) {
  // ponytail: literal lines only. `*`, `**` and `**/*` blind the ignore crate from above a root; `/*` and `name/` do not
  // (verified with rg --no-require-git). Add a glob matcher when a real pattern escapes this.
  const ALL = new Set(['*', '**', '**/*']);
  const hits = [];
  let child;
  try { child = fs.realpathSync(dir); } catch { child = path.resolve(dir); }
  for (let parent = path.dirname(child); parent !== child; child = parent, parent = path.dirname(parent)) {
    for (const name of ['.gitignore', '.ignore']) {
      let lines;
      try { lines = fs.readFileSync(path.join(parent, name), 'utf8').split('\n').map((l) => l.trim()); } catch { continue; }
      if (lines.some((l) => ALL.has(l))) hits.push(path.join(parent, name));
    }
  }
  return hits;
}

/** Refuse a directory that ignoreAllAncestors flags; `remedy` says what to do instead. */
function refuseBlinded(dir, remedy) {
  const files = ignoreAllAncestors(dir);
  if (!files.length) return;
  throw new Refusal(`${dir} sits under ${files.join(' and ')}, which ignores everything below it: gitignore-aware linters (oxlint, anything on the ignore crate) scan no files there and exit 0, so nothing run in it is evidence. ${remedy}`);
}

/** Where runs commit: the clone `prepare` made when the shared git dir is read-only, else the repo. */
function workspaceOf(repo, control) {
  const ws = readJson(path.join(control, 'workspace.json')).workspace;
  return ws && fs.existsSync(ws) ? ws : fs.realpathSync(repo);
}

/** The run's base: goal/bootstrap if it exists, else --base (or the saved supervisor base), else the default branch head. */
function runBase(workspace) {
  const has = (ref) => spawnSync('git', ['-C', workspace, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;
  if (has('refs/heads/goal/bootstrap')) return 'goal/bootstrap';
  if (runtime.base) return runtime.base;
  if (!runtime.noRemote) {
    const head = spawnSync('git', ['-C', workspace, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' });
    if (head.status === 0 && head.stdout.trim()) return head.stdout.trim();
  }
  for (const name of ['main', 'master']) if (has(`refs/heads/${name}`)) return name;
  return 'HEAD';
}

/** The path a branch is checked out at in `workspace`'s worktrees, or null. */
function checkedOutAt(workspace, branch) {
  let wt = null;
  for (const line of git(workspace, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) wt = line.slice(9);
    if (line === `branch refs/heads/${branch}`) return wt;
  }
  return null;
}

function worktreeKey(id) {
  if (id === undefined || id === null) return { key: 'run', ticket: null };
  const nn = ticketId(String(id));
  if (!nn) throw new UsageError(`ticket number must be digits, got ${id}`);
  return { key: `t${nn}`, ticket: nn };
}

function worktreeRecords(control, slug) {
  if (!fs.existsSync(path.join(control, 'runs', slug))) throw new Error(`no run ${slug}; \`goal.mjs init\` it first`);
  const rel = path.join('runs', slug, 'worktrees.json');
  return { rel, file: path.join(control, rel), records: readJson(path.join(control, rel)) };
}

/**
 * The run's (no id) or a ticket's worktree, created once and recorded in runs/<slug>/worktrees.json.
 * treehouse on PATH leases a pooled worktree (deps and build caches kept); otherwise a plain git worktree under
 * <state>/worktrees. A branch already checked out (supervisor mode's target) is borrowed and never removed.
 */
export function worktreeGet(repo, slug, id) {
  const control = requireControl(repo);
  const { key, ticket } = worktreeKey(id);
  return withLock(repo, 'worktrees', () => {
    const { rel, file, records } = worktreeRecords(control, slug);
    const prior = records[key];
    if (prior?.state === 'active' && fs.existsSync(prior.path)) return prior.path;
    const workspace = workspaceOf(repo, control);
    const runBranch = runtime.targetBranch || `goal/${slug}`;
    const branch = ticket ? `goal/${slug}-t${ticket}` : runBranch;
    const base = ticket ? runBranch : runBase(workspace);
    if (ticket && spawnSync('git', ['-C', workspace, 'rev-parse', '--verify', '--quiet', `refs/heads/${runBranch}`]).status !== 0) {
      throw new Refusal(`run branch ${runBranch} does not exist yet; \`goal.mjs worktree get ${slug}\` first`);
    }
    const exists = spawnSync('git', ['-C', workspace, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
    const at = exists ? checkedOutAt(workspace, branch) : null;
    let record;
    if (at) {
      refuseBlinded(at, `${branch} is checked out there; check it out somewhere else, or drop --target-branch.`);
      record = { backend: 'borrowed', path: at, branch, base: null };
    } else {
      const bin = treehouseBin();
      let wt;
      if (bin) {
        // New slots are cut under the control plane: the default pool root carries that `*` .gitignore.
        const pool = path.join(control, 'worktrees', 'pool');
        const args = ['get', '--lease', '--no-fetch', '--lease-holder', slug, '--worktree-path', path.join(pool, '{slot}', '{repo}')];
        const run = spawnSync(bin, args, { cwd: workspace, encoding: 'utf8' });
        wt = run.stdout?.trim().split('\n').at(-1);
        if (run.status !== 0 || !wt || !path.isAbsolute(wt)) throw new Error(`treehouse ${args.join(' ')} failed (exit ${run.status}): ${(run.stderr || run.error?.message || '').trim()}`);
        try {
          // treehouse re-hands any free slot at its recorded path, so an old slot comes back from under the pool root.
          refuseBlinded(wt, `The slot was returned. \`treehouse destroy --yes ${wt}\` (and every other slot of this repository that \`treehouse status\` lists under that root), so the next lease is cut under ${pool}; or set TO_AUTO_TREEHOUSE= to use plain git worktrees.`);
        } catch (error) {
          spawnSync(bin, ['return', wt], { cwd: workspace });
          throw error;
        }
        git(wt, exists ? ['switch', '--quiet', branch] : ['switch', '--quiet', '-c', branch, base]);
      } else {
        wt = path.join(control, 'worktrees', `goal-${slug}${ticket ? `-t${ticket}` : ''}`);
        refuseBlinded(wt, 'Move the control plane (--state-dir or TO_AUTO_HOME) out from under it.');
        git(workspace, exists ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '-b', branch, wt, base]);
      }
      record = { backend: bin ? 'treehouse' : 'git', path: fs.realpathSync(wt), branch, base: exists ? null : git(workspace, ['rev-parse', base]) };
    }
    records[key] = { ...record, state: 'active' };
    fs.writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`);
    commit(repo, `[${slug}] worktree ${key} ${record.backend}`, [rel]);
    return record.path;
  });
}

/** Give a worktree back: treehouse returns it to the pool, git removes it; a dirty worktree is refused, never forced. */
export function worktreeReturn(repo, slug, id) {
  const control = requireControl(repo);
  const { key } = worktreeKey(id);
  return withLock(repo, 'worktrees', () => {
    const { rel, file, records } = worktreeRecords(control, slug);
    const r = records[key];
    if (!r) throw new Error(`${slug} has no ${key} worktree`);
    if (r.state === 'returned') return `already returned ${r.path}`;
    if (r.backend !== 'borrowed' && fs.existsSync(r.path)) {
      const dirty = git(r.path, ['status', '--porcelain']);
      if (dirty) throw new Refusal(`${r.path} has uncommitted changes; commit them on ${r.branch} first:\n${dirty}`);
      if (r.backend === 'treehouse') {
        // Detach first: a pool slot that still holds the branch would block the next checkout of it anywhere else.
        git(r.path, ['switch', '--quiet', '--detach']);
        const run = spawnSync(treehouseBin() ?? 'treehouse', ['return', r.path], { encoding: 'utf8' });
        if (run.status !== 0) throw new Error(`treehouse return ${r.path} failed (exit ${run.status}): ${(run.stderr || run.error?.message || '').trim()}`);
      } else {
        git(workspaceOf(repo, control), ['worktree', 'remove', r.path]);
      }
    }
    records[key] = { ...r, state: 'returned' };
    fs.writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`);
    commit(repo, `[${slug}] worktree ${key} returned`, [rel]);
    return `returned ${r.path}`;
  });
}

export function worktreeStatus(repo, slug) {
  return worktreeRecords(requireControl(repo), slug).records;
}

/** What `cleanup` would destroy that is not safe elsewhere: active run/ticket worktrees and clone commits the repo lacks. */
function unsafeToClean(repo, dir) {
  const items = [];
  const runs = path.join(dir, 'runs');
  for (const slug of fs.existsSync(runs) ? fs.readdirSync(runs) : []) {
    for (const [key, r] of Object.entries(readJson(path.join(runs, slug, 'worktrees.json')))) {
      if (r.state === 'active') items.push(`${slug} ${key} worktree ${r.path} is active; \`goal.mjs worktree return ${slug}${key === 'run' ? '' : ` ${key.slice(1)}`}\` first`);
    }
  }
  const clone = path.join(dir, 'clone');
  if (fs.existsSync(path.join(clone, '.git'))) {
    for (const line of git(clone, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads']).split('\n').filter(Boolean)) {
      const [sha, branch] = line.split(' ');
      if (spawnSync('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`]).status !== 0) items.push(`clone branch ${branch} at ${sha.slice(0, 12)} is not in ${repo}; \`goal.mjs land\` it first`);
    }
  }
  return items;
}

export function cleanup(repo) {
  const dir = controlDir(repo);
  assertStateOutside(repo, dir);
  if (!fs.existsSync(dir)) return `absent ${path.resolve(dir)}`;
  const unsafe = unsafeToClean(repo, dir);
  if (unsafe.length) throw new Refusal(`cleanup would destroy work:\n${unsafe.map((i) => `- ${i}`).join('\n')}`);
  const resolved = fs.realpathSync(dir);
  let list = '';
  try {
    list = git(repo, ['worktree', 'list', '--porcelain']);
  } catch { /* the user repo may not be listable */ }
  for (const wt of [...list.matchAll(/^worktree (.*)$/gm)].map((m) => m[1]).slice(1)) {
    const real = fs.existsSync(wt) ? fs.realpathSync(wt) : path.resolve(wt);
    if (real === resolved || real.startsWith(resolved + path.sep)) git(repo, ['worktree', 'remove', wt]);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  return `removed ${resolved}`;
}

function checkLine(text) {
  const quoted = text.match(/(?:^|\s)check:\s+"([^"]+)"/);
  if (quoted) return quoted[1];
  const line = text.match(/(?:^|\s)check:\s+(\S.*)$/m);
  return line ? line[1].trim() : null;
}

/** Objective `check:` wins, then AGENTS.md / CLAUDE.md, then a Makefile target, then package.json scripts. */
export function discoverCheck(repo, objective = '') {
  const fromObjective = checkLine(objective);
  if (fromObjective) return { command: fromObjective, source: 'objective' };
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(repo, name);
    if (!fs.existsSync(file)) continue;
    const found = checkLine(fs.readFileSync(file, 'utf8'));
    if (found) return { command: found, source: name };
  }
  const makefile = path.join(repo, 'Makefile');
  if (fs.existsSync(makefile)) {
    const text = fs.readFileSync(makefile, 'utf8');
    if (/^check:/m.test(text)) return { command: 'make check', source: 'Makefile' };
    if (/^test:/m.test(text)) return { command: 'make test', source: 'Makefile' };
  }
  const pkgPath = path.join(repo, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts ?? {};
    if (scripts.check) return { command: 'npm run check', source: 'package.json' };
    if (scripts.test) return { command: 'npm test', source: 'package.json' };
  }
  return { command: null, source: null };
}

export function compact(repo, slug) {
  const control = requireControl(repo);
  const ledger = path.join(control, 'runs', slug, 'ledger.md');
  if (!fs.existsSync(ledger)) throw new Error(`${slug} has no ledger`);
  const now = fs.readFileSync(ledger, 'utf8').split(/^## /m).find((s) => s.startsWith('NOW'));
  if (!now || !/^- /m.test(now)) throw new Refusal(`${slug} NOW is empty; rewrite it so it stands alone before compacting`);
  const ahead = stageProblems(control, slug).find((p) => p.code === 'NOW_AHEAD');
  if (ahead) throw new Refusal(`${slug}: ${ahead.message}; set NOW back to the stage the run really reached, or stop the run, before compacting`);
  const recorded = event(repo, slug, 'compact', 'NOW saved');
  return { ok: true, resume: ledger, event: recorded };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const TAKES_VALUE = new Set(['--repo', '--state-dir', '--allow', '--base', '--target-branch', '--status-file', '--worker-model']);

function main(argv) {
  configure();
  let repo = process.cwd();
  const args = [];
  const allow = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--') { args.push(...argv.slice(i)); break; }
    if (TAKES_VALUE.has(flag)) {
      const value = argv[++i];
      if (!value) throw new UsageError(`${flag} needs a value`);
      if (flag === '--repo') repo = value;
      else if (flag === '--state-dir') runtime.stateDir = value;
      else if (flag === '--allow') allow.push(value);
      else if (flag === '--base') runtime.base = value;
      else if (flag === '--target-branch') runtime.targetBranch = value;
      else if (flag === '--status-file') runtime.statusFile = value;
      else if (flag === '--worker-model') runtime.workerModel = value;
      continue;
    }
    if (flag === '--no-remote') { runtime.noRemote = true; continue; }
    args.push(...argv.slice(i));
    break;
  }
  runtime.allow = allow;
  if (args[0] === 'root') {
    console.log(ROOT);
    return 0;
  }
  let saved = null;
  try {
    saved = path.join(stateDir(repo), 'supervisor.json');
  } catch { /* not a git repo yet; preflight reports that */ }
  if (saved && fs.existsSync(saved)) {
    const prior = JSON.parse(fs.readFileSync(saved, 'utf8'));
    if (prior.noRemote) runtime.noRemote = true;
    if (!runtime.base && prior.base) runtime.base = prior.base;
    if (!runtime.targetBranch && prior.targetBranch) runtime.targetBranch = prior.targetBranch;
    if (!runtime.statusFile && prior.statusFile) runtime.statusFile = prior.statusFile;
  }
  const [command, ...rest] = args;
  const print = (value) => console.log(JSON.stringify(value, null, 2));
  if (command === 'root' && rest.length === 0) {
    console.log(ROOT);
    return 0;
  }
  if (command === 'preflight' && rest.length === 0) {
    print(preflight(repo));
    return 0;
  }
  if (command === 'control' && rest.length === 0) {
    preflight(repo);
    console.log(ensureControl(repo));
    return 0;
  }
  if (command === 'prepare' && rest.length === 0) {
    print(prepare(repo));
    return 0;
  }
  if (command === 'supervise' && rest.length === 0) {
    print(supervise(repo));
    return 0;
  }
  if (command === 'land' && rest.length <= 1) {
    print(land(repo, rest[0] ?? null));
    return 0;
  }
  if (command === 'cleanup' && rest.length === 0) {
    console.log(cleanup(repo));
    return 0;
  }
  if (command === 'check-command' && rest.length <= 2) {
    const objective = rest[0] === '--objective' ? rest[1] : '';
    if (rest[0] && rest[0] !== '--objective') throw new UsageError('check-command takes --objective <text>');
    print(discoverCheck(repo, objective ?? ''));
    return 0;
  }
  if (command === 'compact' && rest.length === 1) {
    print(compact(repo, rest[0]));
    return 0;
  }
  if (command === 'model' && rest.length === 3) {
    console.log(recordModel(repo, rest[0], rest[1], rest[2]));
    return 0;
  }
  if (command === 'slug' && (rest.length === 1 || (rest.length === 2 && rest[1] === '--new'))) {
    console.log(slugFor(repo, rest[0], { fresh: rest[1] === '--new' }));
    return 0;
  }
  if (command === 'stop' && rest.length === 2) {
    console.log(stop(repo, rest[0], rest[1]));
    return 0;
  }
  if (command === 'registry' && rest.length === 2) {
    console.log(setRegistry(repo, rest[0], rest[1]));
    return 0;
  }
  if (command === 'init' && rest.length >= 2) {
    const options = { workerModel: runtime.workerModel };
    for (let i = 2; i < rest.length; i += 1) {
      if (rest[i] === '--no-helpers') { options.noHelpers = true; continue; }
      const names = { '--agent': 'agent', '--harness': 'harness', '--worker-model': 'workerModel' };
      if (!names[rest[i]] || !rest[i + 1]) throw new UsageError(`init takes --agent <id>, --harness <name>, --worker-model <model>, and --no-helpers, got ${rest[i]}`);
      options[names[rest[i]]] = rest[++i];
    }
    console.log(init(repo, rest[0], rest[1], options));
    return 0;
  }
  if (command === 'event' && rest.length === 3) {
    console.log(event(repo, rest[0], rest[1], rest[2]));
    return 0;
  }
  if (command === 'claim' && rest.indexOf('--') >= 4) {
    const cut = rest.indexOf('--');
    print(amendClaims(repo, rest[0], rest[1], rest[2], rest.slice(3, cut), rest.slice(cut + 1).join(' ')));
    return 0;
  }
  if (command === 'waive' && rest.includes('--')) {
    const cut = rest.indexOf('--');
    const head = rest.slice(0, cut);
    const carried = head.length === 5 && head[3] === '--carried-to' ? head[4] : null;
    if (head.length !== 3 && carried === null) throw new UsageError('waive <feature> <id> <criterion number> [--carried-to <id>] -- <why>');
    print(waive(repo, head[0], head[1], head[2], rest.slice(cut + 1).join(' '), { carriedTo: carried }));
    return 0;
  }
  if (command === 'run' && rest[0] === '--') {
    const { exit, output, log } = runLogged(process.cwd(), rest.slice(1).join(' '));
    process.stdout.write(output);
    console.log(`log: ${JSON.stringify(log)}`);
    return exit;
  }
  if (command === 'dispatch' && rest.length >= 5 && rest[2] === '--worktree' && rest[4] === '--') {
    return dispatch(repo, rest[0], rest[1], rest[3], rest.slice(5));
  }
  if (command === 'resume' && rest.length === 1) {
    console.log(resume(repo, rest[0]));
    return 0;
  }
  if (command === 'next' && rest.length === 1) {
    const result = next(controlDir(repo), rest[0]);
    print(result);
    return result.stop || result.malformed || result.blocked ? 1 : 0;
  }
  if (command === 'worktree' && ['get', 'return'].includes(rest[0]) && (rest.length === 2 || rest.length === 3)) {
    console.log(rest[0] === 'get' ? worktreeGet(repo, rest[1], rest[2]) : worktreeReturn(repo, rest[1], rest[2]));
    return 0;
  }
  if (command === 'worktree' && rest[0] === 'status' && rest.length === 2) {
    print(worktreeStatus(repo, rest[1]));
    return 0;
  }
  if (command === 'check' && rest.length >= 1) {
    const opts = {};
    let root = path.join(os.homedir(), '.local', 'state', 'to-auto');
    let all = false;
    let slug = null;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--all') all = true;
      else if (rest[i] === '--state-root' && rest[i + 1]) root = rest[++i];
      else if (rest[i] === '--stale-hours' && /^\d+(\.\d+)?$/.test(rest[i + 1] ?? '')) opts.staleHours = Number(rest[++i]);
      else if (!slug && !rest[i].startsWith('-')) slug = rest[i];
      else throw new UsageError('check <slug> | check --all [--state-root <dir>] [--stale-hours <n>]');
    }
    if (all === Boolean(slug)) throw new UsageError('check takes a slug or --all');
    if (all) {
      const lines = checkAll(root, opts);
      if (lines.length) console.log(lines.join('\n'));
      return lines.length ? 1 : 0;
    }
    const result = checkRun(controlDir(repo), slug, opts);
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === 'frontier' && rest.length === 1) {
    const result = frontier(controlDir(repo), rest[0]);
    print(result);
    return result.malformed.length || result.conflicts.length ? 1 : 0;
  }
  if (command === 'take' && rest.length === 2) {
    if (!/^\d+$/.test(rest[1])) throw new UsageError(`take needs a whole number of free slots, got ${rest[1]}`);
    print(take(repo, rest[0], Number(rest[1])));
    return 0;
  }
  if (command === 'status' && rest.length >= 3) {
    const cut = rest.includes('--') ? rest.indexOf('--') : rest.length;
    const flags = rest.slice(3, cut);
    if (!(flags.length === 0 || (flags.length === 2 && flags[0] === '--landed'))) throw new UsageError('status <feature> <id> <status> [--landed <sha>] [-- <reason>]');
    console.log(setStatus(repo, rest[0], rest[1], rest[2], { landed: flags[1] ?? null, reason: rest.slice(cut + 1).join(' ') }));
    return 0;
  }
  if (command === 'claims' && rest.length >= 1) {
    const result = claimsBreach(fs.readFileSync(rest[0], 'utf8'), rest.slice(1));
    print(result);
    return result.unclaimed.length || result.guarded.length ? 1 : 0;
  }
  if (command === 'receipt' && rest.length === 7) {
    const flags = Object.fromEntries([1, 3, 5].map((i) => [rest[i], rest[i + 1]]));
    if (!flags['--worktree'] || !flags['--base'] || !flags['--ticket']) throw new UsageError('receipt needs --worktree <wt> --base <sha> --ticket <ticket.md>');
    const result = checkReceipt({ text: fs.readFileSync(rest[0], 'utf8'), worktree: flags['--worktree'], base: flags['--base'], ticketText: fs.readFileSync(flags['--ticket'], 'utf8') });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === 'contract' && rest.length === 5 && rest[1] === '--worktree' && rest[3] === '--ticket') {
    const result = checkContract({ text: fs.readFileSync(rest[0], 'utf8'), ticketText: fs.readFileSync(rest[4], 'utf8'), worktree: rest[2] });
    result.problems.push(...sinceDispatch(rest[4]));
    result.ok = !result.problems.length;
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === 'with-lock' && rest.length >= 3 && rest[1] === '--') {
    return withLock(repo, rest[0], () => {
      const env = { ...process.env, GOAL_LOCKS_HELD: [...held].join(',') };
      const run = spawnSync(rest[2], rest.slice(3), { stdio: 'inherit', env });
      if (run.error) throw run.error;
      return run.status ?? 1;
    });
  }
  if (command === 'commit' && rest[0] === '-m' && rest.length >= 3) {
    if (!/^\[[a-z0-9][a-z0-9-]*\] \S/.test(rest[1])) throw new UsageError(`commit subject must start with [<slug>] (e.g. "[${'my-run'}] t01 status"), got "${rest[1]}"`);
    console.log(commit(repo, rest[1], rest.slice(2)));
    return 0;
  }
  console.error('usage: goal.mjs [--repo <path>] [--state-dir <path>] [--allow <path>]... [--base <commit>] [--target-branch <name>] [--status-file <path>] [--no-remote] [--worker-model <model>] root | preflight | control | prepare | supervise | land [slug] | cleanup | check-command [--objective <text>] | compact <slug> | model <slug> <role> <model> | slug <objective> [--new] | init <slug> <objective> [--agent <id>] [--harness <name>] [--worker-model <model>] [--no-helpers] | next <slug> | check <slug> | check --all [--state-root <dir>] [--stale-hours <n>] | worktree get|return <slug> [NN] | worktree status <slug> | stop <slug> <reason> | resume <slug> | event <slug> <stage> <text> | registry <slug> <status> | frontier <feature> | take <feature> <n> | status <feature> <id> <status> [--landed <sha>] [-- <reason>] | claims <ticket.md> <path>... | claim <feature> <id> <kind> <path>... -- <why> | waive <feature> <id> <criterion number> [--carried-to <id>] -- <why> | contract <NN.goal.md> --worktree <wt> --ticket <ticket.md> | dispatch <feature> <id> --worktree <wt> -- <orc-dispatch args...> | run -- <command> | receipt <file> --worktree <wt> --base <sha> --ticket <ticket.md> | with-lock <name> -- <cmd...> | commit -m <msg> <file>...');
  return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(error instanceof UsageError ? 2 : error instanceof Refusal ? 1 : 3);
  }
}
