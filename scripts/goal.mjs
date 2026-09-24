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
//   node scripts/goal.mjs registry <slug> <status>        set the run's status in runs.json and commit
//   node scripts/goal.mjs frontier <feature>              ticket grammar, frontier, claim overlaps (JSON)
//   node scripts/goal.mjs take <feature> <n>              atomically flip up to <n> frontier tickets (n = free slots) to in-flight (JSON ids)
//   node scripts/goal.mjs status <feature> <id> <status>  set one ticket's **Status:** and commit
//   node scripts/goal.mjs claims <ticket.md> <path>...    touched paths outside the ticket's claims (JSON)
//   node scripts/goal.mjs receipt <file> --worktree <wt> --base <sha> --ticket <ticket.md>
//                                                          check an implementer's receipt against git and the ticket (JSON)
//   node scripts/goal.mjs with-lock <name> -- <cmd...>    run one command holding a control-plane lock
//   node scripts/goal.mjs commit -m <msg> <file>...       stage exactly <file>s in the control plane and commit, under the control lock
//
// Every command takes --repo <path> (default: cwd); any worktree of the repo works.
// Exit 0 = ok, 1 = the answer is "no" (claims breach, malformed tickets, a refused take, a refused receipt, stopped), 2 = usage, 3 = runtime error.

import fs from 'node:fs';
import path from 'node:path';
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

const STATUSES = new Set(['ready-for-agent', 'in-flight', 'done', 'stuck', 'blocked', 'needs-human']);
// `**Capability:** <tier>/<intensity>`: what the implementer needs, not a model name. Absent = the default.
const CAPABILITY = /^(lightweight|standard|advanced)\/(low|medium|high)$/;
const DEFAULT_CAPABILITY = 'standard/medium';
const STATUS_LINE = /^\*\*Status:\*\* ([a-z-]+)(?::[^\n]*)?[ \t]*$/m;

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

export function setRegistry(repo, slug, status) {
  const control = requireControl(repo);
  return withLock(repo, 'registry', () => {
    const runs = readRegistry(control);
    const entry = runs.find((r) => r.slug === slug);
    if (!entry) throw new Error(`no run ${slug} in runs.json`);
    if (status === 'stopped' && entry.status !== 'stopped') entry.stoppedFrom = entry.status;
    if (status !== 'stopped') delete entry.stoppedFrom;
    entry.status = status;
    fs.writeFileSync(path.join(control, 'runs.json'), `${JSON.stringify(runs, null, 2)}\n`);
    return commit(repo, `[${slug}] status ${status}`, ['runs.json']);
  });
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

/** Undo a stop once its cause is fixed: remove STOP and put back the registry status it replaced. */
export function resume(repo, slug) {
  const control = requireControl(repo);
  const rel = path.join('runs', slug, 'STOP');
  if (!fs.existsSync(path.join(control, rel))) throw new Error(`${slug} is not stopped`);
  fs.rmSync(path.join(control, rel));
  commit(repo, `[${slug}] resume`, [rel]);
  const entry = readRegistry(control).find((r) => r.slug === slug);
  if (entry?.status === 'stopped') setRegistry(repo, slug, entry.stoppedFrom ?? 'bootstrapping');
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
  const status = text.match(STATUS_LINE)?.[1];
  const blocked = text.match(/^\*\*Blocked by:\*\* (.+)$/m)?.[1]?.trim();
  const claims = text.match(/^\*\*Claims:\*\* (.+)$/m)?.[1];
  const capability = text.match(/^\*\*Capability:\*\* (.+)$/m)?.[1]?.trim() ?? DEFAULT_CAPABILITY;
  const problems = [];
  if (!CAPABILITY.test(capability)) problems.push(`unknown capability ${capability} (lightweight|standard|advanced / low|medium|high)`);
  if (!status) problems.push('no **Status:** line');
  else if (!STATUSES.has(status)) problems.push(`unknown status ${status}`);
  if (!blocked) problems.push('no **Blocked by:** line');
  if (!claims) problems.push('no **Claims:** line');
  const blockers = [];
  if (blocked && blocked !== 'None') {
    for (const token of blocked.split(',').map((b) => b.trim()).filter(Boolean)) {
      const id = ticketId(token);
      if (id) blockers.push(id);
      else problems.push(`unreadable blocker "${token}" (use ticket numbers, e.g. 03)`);
    }
  }
  const parsed = { exclusive: [], 'shared-regenerate': [], guarded: [] };
  for (const part of (claims ?? '').split(';')) {
    const m = part.trim().match(/^(exclusive|shared-regenerate|guarded):\s*(.*)$/);
    if (!m) {
      if (part.trim()) problems.push(`unreadable claims part "${part.trim()}"`);
      continue;
    }
    parsed[m[1]].push(...m[2].split(',').map((c) => c.trim()).filter(Boolean));
  }
  return { status, blockers, claims: parsed, capability, problems };
}

export function frontier(control, feature) {
  const issues = path.join(control, 'tracker', feature, 'issues');
  const { files, duplicates } = ticketFiles(issues);
  const tickets = new Map([...files].map(([id, file]) => [id, { file, ...parseTicket(fs.readFileSync(file, 'utf8')) }]));
  const malformed = [...duplicates];
  for (const [id, t] of tickets) {
    for (const b of t.blockers) if (!tickets.has(b)) t.problems.push(`blocked by unknown ticket ${b}`);
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
  return { feature, frontier: malformed.length ? [] : ready, malformed, conflicts, capability };
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

export function setStatus(repo, feature, id, status) {
  if (!STATUSES.has(status)) throw new Error(`unknown status ${status}`);
  const control = requireControl(repo);
  const issues = path.join(control, 'tracker', feature, 'issues');
  const want = ticketId(String(id));
  // Read-modify-write under the same lock take uses, so no status flip is lost.
  return withLock(repo, `frontier-${feature}`, () => {
    const { files, duplicates } = ticketFiles(issues);
    if (duplicates.some((d) => d.id === want)) throw new Error(`ticket number ${want} is used by more than one file in tracker/${feature}/issues`);
    const full = files.get(want);
    if (!full) throw new Error(`no ticket ${id} in tracker/${feature}/issues`);
    const text = fs.readFileSync(full, 'utf8');
    if (!STATUS_LINE.test(text)) throw new Error(`${path.basename(full)} has no **Status:** line`);
    fs.writeFileSync(full, text.replace(STATUS_LINE, `**Status:** ${status}`));
    return commit(repo, `[${feature}] ticket ${want} → ${status}`, [path.relative(control, full)]);
  });
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
const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Every checkbox line in a ticket is one acceptance criterion (local and GitHub templates alike). */
export function ticketCriteria(text) {
  return [...text.matchAll(/^\s*- \[[ xX]\] (.+)$/gm)].map((m) => m[1].trim());
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
  if (!Array.isArray(r.validation) || validation.some((v) => typeof v?.command !== 'string' || !Number.isInteger(v?.exit))) problems.push('validation must be an array of { command, exit: <integer>, summary }');
  const criteria = Array.isArray(r.criteria) ? r.criteria : [];
  if (!Array.isArray(r.criteria)) problems.push('criteria must be an array');
  for (const c of criteria) {
    if (typeof c?.criterion !== 'string' || !RESULTS.has(c?.result)) problems.push(`criterion ${JSON.stringify(c?.criterion)} needs a result of pass | fail | not-run`);
    else if (c.result !== 'not-run' && (typeof c.evidence !== 'string' || !c.evidence.trim())) problems.push(`criterion "${c.criterion}" has a ${c.result} result with no evidence`);
  }
  const completed = r.conclusion === 'completed';
  if (['blocked', 'stuck', 'claims-breach'].includes(r.conclusion) && strings(r.blockers) && !r.blockers.length) problems.push(`a ${r.conclusion} receipt must name its reason in blockers`);
  if (completed) {
    if (strings(r.blockers) && r.blockers.length) problems.push('a completed receipt cannot carry blockers');
    if (!validation.length) problems.push('a completed receipt needs at least one validation command');
    if (r.worktree_clean === false) problems.push('a completed receipt needs a clean worktree');
  }

  if (ticketText !== null) {
    const byText = new Map();
    for (const c of criteria.filter((x) => typeof x?.criterion === 'string')) {
      if (byText.has(norm(c.criterion))) problems.push(`receipt criterion "${c.criterion}" appears more than once`);
      byText.set(norm(c.criterion), c);
    }
    const wanted = ticketCriteria(ticketText);
    if (completed && !wanted.length) problems.push('the ticket has no acceptance criteria (checkbox lines), so nothing can show it completed');
    for (const want of wanted) {
      const got = byText.get(norm(want));
      if (!got) problems.push(`ticket criterion "${want}" has no entry in the receipt`);
      else if (completed && got.result !== 'pass') problems.push(`ticket criterion "${want}" is ${got.result}, so the receipt cannot be completed`);
    }
    const known = new Set(wanted.map(norm));
    for (const c of byText.values()) if (!known.has(norm(c.criterion))) problems.push(`receipt criterion "${c.criterion}" is not in the ticket`);
  }

  if (worktree !== null) {
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
  }
  return { ok: problems.length === 0, conclusion: r.conclusion ?? null, problems };
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

export function commit(repo, message, files) {
  if (!files.length) throw new Error('commit needs at least one file');
  const control = requireControl(repo);
  // Paths are relative to the control worktree; a path that resolves inside it from cwd also works.
  files = files.map((f) => {
    const fromCwd = path.relative(control, path.resolve(f));
    return fromCwd && !fromCwd.startsWith('..') && !path.isAbsolute(fromCwd) ? fromCwd : f;
  });
  return withLock(repo, 'control', () => {
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
  if (command === 'status' && rest.length === 3) {
    console.log(setStatus(repo, rest[0], rest[1], rest[2]));
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
  if (command === 'with-lock' && rest.length >= 3 && rest[1] === '--') {
    return withLock(repo, rest[0], () => {
      const env = { ...process.env, GOAL_LOCKS_HELD: [...held].join(',') };
      const run = spawnSync(rest[2], rest.slice(3), { stdio: 'inherit', env });
      if (run.error) throw run.error;
      return run.status ?? 1;
    });
  }
  if (command === 'commit' && rest[0] === '-m' && rest.length >= 3) {
    console.log(commit(repo, rest[1], rest.slice(2)));
    return 0;
  }
  console.error('usage: goal.mjs [--repo <path>] control | slug <objective> [--new] | init <slug> <objective> [--agent <id>] [--harness <name>] | next <slug> | stop <slug> <reason> | resume <slug> | registry <slug> <status> | frontier <feature> | take <feature> <n> | status <feature> <id> <status> | claims <ticket.md> <path>... | receipt <file> --worktree <wt> --base <sha> --ticket <ticket.md> | with-lock <name> -- <cmd...> | commit -m <msg> <file>...');
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
