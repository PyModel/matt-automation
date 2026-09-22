#!/usr/bin/env node
// The mechanical half of a /to-goal run: everything that is a rule over files, so
// no agent re-derives it from prose.
//
//   node scripts/goal.mjs init <slug> <objective>         create runs/<slug>/ with a todo.md that next can parse, and commit it
//   node scripts/goal.mjs next <slug>                     where the run resumes (JSON)
//   node scripts/goal.mjs frontier <feature>              ticket grammar, frontier, claim overlaps (JSON)
//   node scripts/goal.mjs take <feature> <n>              atomically flip up to <n> frontier tickets (n = free slots) to in-flight (JSON ids)
//   node scripts/goal.mjs status <feature> <id> <status>  set one ticket's **Status:** and commit
//   node scripts/goal.mjs claims <ticket.md> <path>...    touched paths outside the ticket's claims (JSON)
//   node scripts/goal.mjs with-lock <name> -- <cmd...>    run one command holding a control-plane lock
//   node scripts/goal.mjs commit -m <msg> <file>...       stage exactly <file>s in the control plane and commit, under the control lock
//
// Every command takes --repo <path> (default: cwd); any worktree of the repo works.
// Exit 0 = ok, 1 = the answer is "no" (claims breach, malformed tickets, stopped), 2 = usage.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Stage order is the pipeline. `artifact` is a file in runs/<slug>/ that must exist
// for a ticked stage to count as done: the files outrank the checkbox.
export const STAGES = [
  { id: '00', name: 'skill wiring', phase: 'BOOTSTRAP.md' },
  { id: '0', name: 'control plane', phase: 'BOOTSTRAP.md', artifact: 'ledger.md' },
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
const STALE_LOCK_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 120 * 1000;

export function controlDir(repo) {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return path.join(path.dirname(common), '.worktrees', 'control');
}

// ---------------------------------------------------------------- next

/** The todo.md stage lines: `- [x] 0b setup` or `- [ ] 7 build`, one per line. */
export function parseTodo(text) {
  const ticked = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^- \[( |x)\] (\S+)\b/);
    if (m && STAGES.some((s) => s.id === m[2])) ticked.set(m[2], m[1] === 'x');
  }
  return ticked;
}

export function init(repo, slug, objective) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new Error(`bad slug: ${slug} (kebab-case, at most 40 chars)`);
  const control = controlDir(repo);
  const runDir = path.join(control, 'runs', slug);
  if (fs.existsSync(runDir)) throw new Error(`runs/${slug}/ already exists; resume it with \`goal.mjs next ${slug}\``);
  const files = {
    'todo.md': `# to-goal todo: ${objective}\n\n## Stages\n${STAGES.map((s) => `- [ ] ${s.id} ${s.name}`).join('\n')}\n\n## Tickets (stage 7)\n`,
    'ledger.md': `# to-goal: ${objective}\n\n## NOW\n- stage: 0 control plane\n- next: finish BOOTSTRAP.md stage 0\n\n## Events\n`,
    'log.md': `# Decisions: ${objective}\n\n`,
    'bugs.md': `# Bugs noticed in flight: ${objective}\n\n`,
  };
  fs.mkdirSync(runDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(runDir, name), text);
  return commit(repo, `[${slug}] start`, Object.keys(files).map((name) => path.join('runs', slug, name)));
}

export function next(control, slug) {
  const runDir = path.join(control, 'runs', slug);
  const first = STAGES[0];
  if (!fs.existsSync(runDir)) return { slug, stage: first.id, name: first.name, phase: first.phase, reason: 'no run directory yet' };
  if (fs.existsSync(path.join(runDir, 'STOP'))) return { slug, stop: true, reason: `runs/${slug}/STOP is present` };
  const todoFile = path.join(runDir, 'todo.md');
  if (!fs.existsSync(todoFile)) return { slug, stage: '0', name: 'control plane', phase: 'BOOTSTRAP.md', reason: 'todo.md missing' };
  const ticked = parseTodo(fs.readFileSync(todoFile, 'utf8'));
  const missingLines = STAGES.filter((s) => !ticked.has(s.id)).map((s) => s.id);
  if (missingLines.length) return { slug, malformed: true, reason: `todo.md has no line for stage(s) ${missingLines.join(', ')}; rewrite it per LEDGER.md § todo.md format` };
  for (const s of STAGES) {
    if (!ticked.get(s.id)) return { slug, stage: s.id, name: s.name, phase: s.phase, reason: 'first unticked stage' };
    if (s.artifact && !fs.existsSync(path.join(runDir, s.artifact))) {
      return { slug, stage: s.id, name: s.name, phase: s.phase, reason: `ticked, but runs/${slug}/${s.artifact} is missing` };
    }
  }
  return { slug, done: true, reason: 'every stage ticked and every stage artifact present' };
}

// ------------------------------------------------------------- tickets

/** A local-tracker ticket: the three lines CONTROL.md § Tracker grammar requires. */
export function parseTicket(text) {
  const status = text.match(/^\*\*Status:\*\* (\S+)\s*$/m)?.[1];
  const blocked = text.match(/^\*\*Blocked by:\*\* (.+)$/m)?.[1]?.trim();
  const claims = text.match(/^\*\*Claims:\*\* (.+)$/m)?.[1];
  const problems = [];
  if (!status) problems.push('no **Status:** line');
  else if (!STATUSES.has(status)) problems.push(`unknown status ${status}`);
  if (!blocked) problems.push('no **Blocked by:** line');
  if (!claims) problems.push('no **Claims:** line');
  const blockers = !blocked || blocked === 'None' ? [] : blocked.split(',').map((b) => b.trim()).filter(Boolean);
  const parsed = { exclusive: [], 'shared-regenerate': [], guarded: [] };
  for (const part of (claims ?? '').split(';')) {
    const m = part.trim().match(/^(exclusive|shared-regenerate|guarded):\s*(.*)$/);
    if (!m) {
      if (part.trim()) problems.push(`unreadable claims part "${part.trim()}"`);
      continue;
    }
    parsed[m[1]].push(...m[2].split(',').map((c) => c.trim()).filter(Boolean));
  }
  return { status, blockers, claims: parsed, problems };
}

export function frontier(control, feature) {
  const issues = path.join(control, 'tracker', feature, 'issues');
  const tickets = new Map();
  for (const file of fs.readdirSync(issues).filter((f) => f.endsWith('.md')).sort()) {
    const id = file.match(/^(\d+)/)?.[1];
    if (!id) continue;
    tickets.set(id, { file: path.join(issues, file), ...parseTicket(fs.readFileSync(path.join(issues, file), 'utf8')) });
  }
  const malformed = [];
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
  return { feature, frontier: malformed.length ? [] : ready, malformed, conflicts };
}

/** Under the frontier lock, so two orchestrators never take the same ticket. */
export function take(repo, feature, max) {
  const control = controlDir(repo);
  return withLock(repo, `frontier-${feature}`, () => {
    const { frontier: ready, malformed, conflicts } = frontier(control, feature);
    if (malformed.length || conflicts.length) throw new Error(`tracker ${feature} fails the claims gate; run \`goal.mjs frontier ${feature}\``);
    const taken = ready.slice(0, Math.max(0, max));
    for (const id of taken) setStatus(repo, feature, id, 'in-flight');
    return taken;
  });
}

export function setStatus(repo, feature, id, status) {
  if (!STATUSES.has(status)) throw new Error(`unknown status ${status}`);
  const control = controlDir(repo);
  const issues = path.join(control, 'tracker', feature, 'issues');
  const file = fs.readdirSync(issues).find((f) => f.startsWith(`${id}-`) || f === `${id}.md`);
  if (!file) throw new Error(`no ticket ${id} in tracker/${feature}/issues`);
  const full = path.join(issues, file);
  const text = fs.readFileSync(full, 'utf8');
  if (!/^\*\*Status:\*\* \S+\s*$/m.test(text)) throw new Error(`${file} has no **Status:** line`);
  fs.writeFileSync(full, text.replace(/^\*\*Status:\*\* \S+\s*$/m, `**Status:** ${status}`));
  return commit(repo, `[${feature}] ticket ${id} → ${status}`, [path.relative(control, full)]);
}

function dependsOn(tickets, from, to, seen = new Set()) {
  if (seen.has(from)) return false;
  seen.add(from);
  return (tickets.get(from)?.blockers ?? []).some((b) => b === to || dependsOn(tickets, b, to, seen));
}

/** A claim is a file path, a directory ending in `/`, or a directory ending in `/**`. */
export function claimCovers(claim, file) {
  const dir = claim.endsWith('/**') ? claim.slice(0, -2) : claim.endsWith('/') ? claim : null;
  return dir ? file.startsWith(dir) : file === claim;
}

function claimsOverlap(a, b) {
  const root = (c) => (c.endsWith('/**') ? c.slice(0, -2) : c);
  return claimCovers(a, root(b)) || claimCovers(b, root(a));
}

export function claimsBreach(ticketText, touched) {
  const { claims } = parseTicket(ticketText);
  const covered = (list, file) => list.some((c) => claimCovers(c, file));
  return {
    unclaimed: touched.filter((f) => !covered(claims.exclusive, f) && !covered(claims['shared-regenerate'], f) && !covered(claims.guarded, f)),
    guarded: touched.filter((f) => covered(claims.guarded, f)),
  };
}

// --------------------------------------------------------------- locks

export function withLock(repo, name, fn) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`bad lock name: ${name}`);
  const locks = path.join(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'goal-locks');
  fs.mkdirSync(locks, { recursive: true });
  const lock = path.join(locks, name);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stalePid = stalePidOf(lock);
      if (stalePid !== null) {
        breakStale(lock, stalePid);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`lock ${name} still held after ${LOCK_WAIT_MS / 1000}s (${lock})`);
      sleep(100);
    }
  }
  try {
    return fn();
  } finally {
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
    return -1; // an old lock that never got its pid file: its creator died mid-mkdir
  }
  try {
    process.kill(pid, 0);
    return null;
  } catch (error) {
    return error.code === 'ESRCH' ? pid : null;
  }
}

// Two agents can find the same stale lock. Renaming is atomic, so only one moves it;
// if what it moved is not the stale lock it inspected (another agent broke it and
// re-took it in between), it puts that live lock back.
function breakStale(lock, stalePid) {
  const tomb = `${lock}.stale-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(lock, tomb);
  } catch {
    return; // someone else moved it first
  }
  let movedPid = -1;
  try { movedPid = Number(fs.readFileSync(path.join(tomb, 'pid'), 'utf8')); } catch { /* no pid file */ }
  if (movedPid !== stalePid) {
    try { fs.renameSync(tomb, lock); return; } catch { /* the lock was re-taken meanwhile; the moved one is spent */ }
  }
  fs.rmSync(tomb, { recursive: true, force: true });
}

export function commit(repo, message, files) {
  if (!files.length) throw new Error('commit needs at least one file');
  const control = controlDir(repo);
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
      if (!repo) throw new Error('--repo needs a path');
    }
    else if (argv[i] === '--') { args.push(...argv.slice(i)); break; }
    else args.push(argv[i]);
  }
  const [command, ...rest] = args;
  const print = (value) => console.log(JSON.stringify(value, null, 2));
  if (command === 'init' && rest.length === 2) {
    console.log(init(repo, rest[0], rest[1]));
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
    if (!/^\d+$/.test(rest[1])) throw new Error(`take needs a whole number of free slots, got ${rest[1]}`);
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
  if (command === 'with-lock' && rest.length >= 3 && rest[1] === '--') {
    return withLock(repo, rest[0], () => {
      const run = spawnSync(rest[2], rest.slice(3), { stdio: 'inherit' });
      if (run.error) throw run.error;
      return run.status ?? 1;
    });
  }
  if (command === 'commit' && rest[0] === '-m' && rest.length >= 3) {
    console.log(commit(repo, rest[1], rest.slice(2)));
    return 0;
  }
  console.error('usage: goal.mjs [--repo <path>] init <slug> <objective> | next <slug> | frontier <feature> | take <feature> <n> | status <feature> <id> <status> | claims <ticket.md> <path>... | with-lock <name> -- <cmd...> | commit -m <msg> <file>...');
  return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }
}
