#!/usr/bin/env node
// The mechanical half of a /to-auto run: everything that is a rule over files, so
// no agent re-derives it from prose.
//
//   node scripts/goal.mjs control                         create the control plane (orphan goal/control worktree) if missing
//   node scripts/goal.mjs slug <objective> [--new]        the run slug; --new picks a free -2, -3 … for a deliberate re-run
//   node scripts/goal.mjs init <slug> <objective> [--agent <id>] [--harness <name>]
//                                                          register the run and create runs/<slug>/ that next can parse; commit
//   node scripts/goal.mjs next <slug>                     where the run resumes (JSON)
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
//
// Every command takes --repo <path> (default: cwd); any worktree of the repo works.
// Exit 0 = ok, 1 = the answer is "no" (claims breach, malformed tickets, a refused take, claim, contract, a refused receipt, stopped), 2 = usage, 3 = runtime error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

const CONTROL_BRANCH = 'goal/control';

class UsageError extends Error {}
/** The answer is "no" (a gate refused): exit 1, like a claims breach. */
class Refusal extends Error {}

export function controlDir(repo) {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return path.join(path.dirname(common), '.worktrees', 'control');
}

/** The control worktree, proven to be on goal/control, so a write can never land on a user branch. */
function requireControl(repo) {
  const control = controlDir(repo);
  let top = null;
  let branch = null;
  try {
    top = fs.realpathSync(git(control, ['rev-parse', '--show-toplevel']));
    branch = git(control, ['symbolic-ref', '--short', 'HEAD']);
  } catch { /* not a worktree */ }
  if (top !== (fs.existsSync(control) ? fs.realpathSync(control) : null) || branch !== CONTROL_BRANCH) {
    throw new Error(`no control plane at ${control} on ${CONTROL_BRANCH}; run \`goal.mjs control\` first`);
  }
  return control;
}

export function ensureControl(repo) {
  const control = controlDir(repo);
  return withLock(repo, 'control', () => {
    if (fs.existsSync(control)) return requireControl(repo);
    const root = path.dirname(path.dirname(control));
    const exclude = path.join(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const excluded = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!excluded.split('\n').includes('.worktrees/')) fs.appendFileSync(exclude, `${excluded && !excluded.endsWith('\n') ? '\n' : ''}.worktrees/\n`);
    const exists = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${CONTROL_BRANCH}`]).status === 0;
    if (exists) git(root, ['worktree', 'add', '-q', control, CONTROL_BRANCH]);
    else {
      git(root, ['worktree', 'add', '-q', '--orphan', '-b', CONTROL_BRANCH, control]);
      git(control, ['commit', '-q', '--allow-empty', '-m', 'Init to-auto control plane']);
    }
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
    throw new Error(`${file} is not valid JSON; repair it from \`git log -p goal/control -- runs.json\``);
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
    // Stage 7 is complete only when every ticket is done or stuck with its reason (PIPELINE.md § Completion criteria).
    const issues = path.join(control, 'tracker', slug, 'issues');
    if (status === 'reviewing' && fs.existsSync(issues)) {
      const open = [...ticketFiles(issues).files].map(([id, file]) => [id, parseTicket(fs.readFileSync(file, 'utf8')).status]).filter(([, s]) => !['done', 'stuck'].includes(s));
      if (open.length) throw new Refusal(`build is not complete: ${open.map(([id, s]) => `${id} (${s})`).join(', ')}; each ticket is done or marked stuck with its reason first`);
    }
    if (status === 'done') {
      const problems = finalVerdictProblems(control, slug);
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
 * A run is done only on a committed stage 8 verdict that reviewed what the target branch holds now
 * (CLOSE.md step 8): `{ "verdict": "ship", "target": "<branch>", "review_head": "<sha>" }`, target's tip = review_head.
 */
function finalVerdictProblems(control, slug) {
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
  const tip = commitOf(control, v.target);
  const reviewed = commitOf(control, v.review_head);
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

export function init(repo, slug, objective, { agent = null, harness = null } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new Error(`bad slug: ${slug} (kebab-case, at most 40 chars)`);
  const control = requireControl(repo);
  const runDir = path.join(control, 'runs', slug);
  if (fs.existsSync(path.join(runDir, 'STOP'))) throw new Error(`${slug} is stopped; fix the cause, then \`goal.mjs resume ${slug}\``);
  if (fs.existsSync(path.join(runDir, 'todo.md'))) throw new Error(`runs/${slug}/ already exists; resume it with \`goal.mjs next ${slug}\``);
  withLock(repo, 'registry', () => {
    const runs = readRegistry(control);
    if (runs.some((r) => r.slug === slug)) throw new Error(`${slug} is already registered in runs.json`);
    const runId = runs.reduce((max, r) => Math.max(max, r.run_id ?? 0), 0) + 1;
    runs.push({ slug, objective, run_id: runId, started: new Date().toISOString(), status: 'bootstrapping', agent, harness });
    fs.writeFileSync(path.join(control, 'runs.json'), `${JSON.stringify(runs, null, 2)}\n`);
    commit(repo, `[${slug}] register run ${runId}`, ['runs.json']);
  });
  const files = {
    'todo.md': `# to-auto todo: ${objective}\n\n## Stages\n${STAGES.map((s) => `- [ ] ${s.id} ${s.name}`).join('\n')}\n\n## Tickets (stage 7)\n`,
    'ledger.md': `# to-auto: ${objective}\n\n## NOW\n- stage: 0 register\n- next: finish BOOTSTRAP.md stage 0\n\n## Events\n`,
    'log.md': `# Decisions: ${objective}\n\n`,
    'bugs.md': `# Bugs noticed in flight: ${objective}\n\n`,
  };
  fs.mkdirSync(runDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(runDir, name), text);
  return commit(repo, `[${slug}] start`, Object.keys(files).map((name) => path.join('runs', slug, name)));
}

export function next(control, slug) {
  const runDir = path.join(control, 'runs', slug);
  if (fs.existsSync(path.join(runDir, 'STOP'))) {
    return { slug, stop: true, reason: `runs/${slug}/STOP: ${fs.readFileSync(path.join(runDir, 'STOP'), 'utf8').trim() || 'no reason given'}` };
  }
  if (!fs.existsSync(runDir)) return resumeAt(slug, STAGES[0], 'no run directory yet');
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
      const sha = doneGate(control, feature, want, file, text, landed);
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
function doneGate(control, feature, want, file, ticketText, landed) {
  const problems = sinceDispatch(file);
  const tickets = path.join(control, 'runs', feature, 'tickets');
  const receiptFile = path.join(tickets, `${want}.receipt.md`);
  if (!fs.existsSync(receiptFile)) throw new Refusal(`ticket ${want} has no receipt at ${path.relative(control, receiptFile)}`);
  requireCommitted(control, receiptFile);
  const text = fs.readFileSync(receiptFile, 'utf8');
  const r = receiptJson(text) ?? {};
  const head = typeof r.head === 'string' ? commitOf(control, r.head) : null;
  const base = typeof r.ticket_base === 'string' ? commitOf(control, r.ticket_base) : null;
  const landedSha = commitOf(control, landed);
  if (!head || !base) throw new Refusal(`ticket ${want}'s receipt names head ${r.head} and ticket_base ${r.ticket_base}; both must be commits in this repository (fetch first)`);
  if (!landedSha) throw new Refusal(`landed ${landed} is not a commit in this repository (fetch first)`);
  const contract = path.join(tickets, `${want}.goal.md`);
  const contractBase = fs.existsSync(contract) ? fs.readFileSync(contract, 'utf8').match(/^- Ticket base: (\S+)/m)?.[1] : null;
  if (contractBase && commitOf(control, contractBase) !== base) problems.push(`receipt ticket_base ${base.slice(0, 12)} is not the contract's Ticket base ${contractBase}`);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-receipt-'));
  try {
    git(control, ['worktree', 'add', '-q', '--detach', wt, head]);
    const checked = checkReceipt({ text, worktree: wt, base, ticketText });
    problems.push(...checked.problems);
    if (checked.conclusion !== 'completed') problems.push(`conclusion is ${JSON.stringify(checked.conclusion)}, not completed`);
  } finally {
    spawnSync('git', ['-C', control, 'worktree', 'remove', '--force', wt]);
    fs.rmSync(wt, { recursive: true, force: true });
  }
  const contains = spawnSync('git', ['-C', control, 'merge-base', '--is-ancestor', head, landedSha]).status === 0;
  if (!contains) {
    const landedId = patchId(control, `${landedSha}^`, landedSha);
    if (!landedId || landedId !== patchId(control, base, head)) problems.push(`landed ${landedSha.slice(0, 12)} neither contains receipt head ${head.slice(0, 12)} nor carries the same change (patch-id); get a receipt for what actually landed`);
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
  const locks = path.join(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'goal-locks');
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

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main(argv) {
  let repo = process.cwd();
  const args = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') {
      repo = argv[++i];
      if (!repo) throw new UsageError('--repo needs a path');
    }
    else if (argv[i] === '--') { args.push(...argv.slice(i)); break; }
    else args.push(argv[i]);
  }
  const [command, ...rest] = args;
  const print = (value) => console.log(JSON.stringify(value, null, 2));
  if (command === 'control' && rest.length === 0) {
    console.log(ensureControl(repo));
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
    const options = {};
    for (let i = 2; i < rest.length; i += 2) {
      if (!['--agent', '--harness'].includes(rest[i]) || !rest[i + 1]) throw new UsageError(`init takes --agent <id> and --harness <name>, got ${rest[i]}`);
      options[rest[i].slice(2)] = rest[i + 1];
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
    return result.stop || result.malformed ? 1 : 0;
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
  console.error('usage: goal.mjs [--repo <path>] control | slug <objective> [--new] | init <slug> <objective> [--agent <id>] [--harness <name>] | next <slug> | stop <slug> <reason> | resume <slug> | event <slug> <stage> <text> | registry <slug> <status> | frontier <feature> | take <feature> <n> | status <feature> <id> <status> [--landed <sha>] [-- <reason>] | claims <ticket.md> <path>... | claim <feature> <id> <kind> <path>... -- <why> | waive <feature> <id> <criterion number> [--carried-to <id>] -- <why> | contract <NN.goal.md> --worktree <wt> --ticket <ticket.md> | dispatch <feature> <id> --worktree <wt> -- <orc-dispatch args...> | run -- <command> | receipt <file> --worktree <wt> --base <sha> --ticket <ticket.md> | with-lock <name> -- <cmd...> | commit -m <msg> <file>...');
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
