// The mechanics that replaced prose rules: hand-back mode and scripts pin at init, target drift, orphaned tickets, the
// review→fix budget, open decisions, contract drafting and probing, the merger, the verdict writer, sole-writer files,
// registered run logs, and gc of stale runs. Each test builds real git state in temp dirs; nothing touches ~/.local/state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  init, next, tick, pin, take, frontier, prepareTicket, brief, mergeTicket, verdict, setRegistry, checkRun, checkContract,
  checkReceipt, commit, configure, prepare, worktreeGet, runLogged, scriptsPin, ownerDecisions, gc, MAX_BRIEF_BYTES,
  adopt, controlDir, firstStageArgv, gcAll, stateDir, setStatus, amendClaims, discoverCheck, land, preflight,
  ensureControl, cleanup, worktreeReturn, grant, flightRows,
} from './goal.mjs';

const GOAL = path.join(import.meta.dirname, 'goal.mjs');

process.env.TO_AUTO_TREEHOUSE = ''; // plain git worktrees: a treehouse on PATH must not lease real pool slots
const WHO = { agent: 'test-session', harness: 'test' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A repo with a.txt on main and a prepared control plane (workspace.json recorded), as stage 00 leaves it. */
function setup() {
  const repo = tmp('hard-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  write(path.join(repo, 'a.txt'), 'a\nb\nc\nd\ne\nhello\n');
  write(path.join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  configure();
  process.env.TO_AUTO_HOME = tmp('hard-state-');
  const { workspace } = prepare(repo);
  const control = process.env.TO_AUTO_HOME;
  const read = (rel) => fs.readFileSync(path.join(control, rel), 'utf8');
  return { repo, control, workspace, read };
}

/** Fixture state committed past every guard, as an older goal.mjs or another tool left it. */
function rawCommit(control, message = 'fixture') {
  git(control, 'add', '-A');
  execFileSync('git', ['-C', control, 'commit', '-qm', message], { env: { ...process.env, TO_AUTO_WRITER: '1' } });
}

const registry = (control) => JSON.parse(fs.readFileSync(path.join(control, 'runs.json'), 'utf8'));
function editRegistry(control, fn) {
  const runs = registry(control);
  fn(runs[0]);
  write(path.join(control, 'runs.json'), `${JSON.stringify(runs, null, 2)}\n`);
  rawCommit(control, '[x] fixture: registry');
}
const codes = (control, opts) => checkRun(control, 'x', opts).problems.map((p) => p.code);
const ticketText = (status, claims, extra = '') => `# t\n\n**Status:** ${status}\n**Blocked by:** None\n**Claims:** ${claims}\n${extra}`;
function seedTicket(repo, control, file, text) {
  write(path.join(control, 'tracker/x/issues', file), text);
  commit(repo, `[x] seed ${file}`, [`tracker/x/issues/${file}`]);
}
function setReviewBase(repo, control, sha) {
  const ledger = path.join(control, 'runs/x/ledger.md');
  fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').replace('## NOW\n', `## NOW\n- review_base: ${sha}\n`));
  commit(repo, '[x] review_base', ['runs/x/ledger.md']);
}

test('a run registered before pins, modes and the verdict writer still checks, resumes and gc-s cleanly', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  editRegistry(control, (e) => { delete e.mode; delete e.target; delete e.scripts; });
  assert.deepEqual(codes(control), []);
  const at = next(control, 'x');
  assert.equal(at.mode, 'branch', 'no supervisor.json target: the documented default');
  assert.equal(at.warnings, undefined);
  assert.doesNotThrow(() => gc(repo));
});

test('init records the hand-back mode, the target branch and the scripts pin, and next reports them', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  const [entry] = registry(control);
  assert.deepEqual([entry.mode, entry.target], ['branch', 'main']);
  assert.deepEqual(entry.scripts, scriptsPin());
  assert.deepEqual([next(control, 'x').mode, next(control, 'x').target], ['branch', 'main']);
  assert.throws(() => init(repo, 'y', 'Y', { ...WHO, mode: 'supervisor' }), /needs --target-branch/);
  assert.throws(() => init(repo, 'z', 'Z', { ...WHO, mode: 'nope' }), /--mode is one of branch, supervisor, pr/);
  init(repo, 'p', 'P', { ...WHO, mode: 'pr' });
  assert.equal(next(control, 'p').mode, 'pr');
});

test('SCRIPTS_MOVED: scripts that changed under a run are flagged by check and next until pin accepts them', () => {
  const { repo, control, read } = setup();
  init(repo, 'x', 'X', WHO);
  editRegistry(control, (e) => { e.scripts = { sha256: '0'.repeat(64), commit: 'a'.repeat(40) }; });
  assert.deepEqual(codes(control), ['SCRIPTS_MOVED']);
  assert.match(next(control, 'x').warnings[0].message, /changed under this run.*goal\.mjs pin x/);
  assert.match(pin(repo, 'x'), /now runs scripts/);
  assert.deepEqual(codes(control), []);
  assert.deepEqual(registry(control)[0].scripts, scriptsPin());
  assert.match(read('runs/x/ledger.md'), /\[pin\] scripts aaaaaaaaaaaa → /);
  assert.match(pin(repo, 'x'), /already runs the current scripts/);
});

test('TARGET_DIVERGED: the target moving under files the run changed or claims is flagged, take refuses, merging it in clears it', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  const wt = worktreeGet(repo, 'x');
  write(path.join(wt, 'a.txt'), 'A\nb\nc\nd\ne\nhello\n');
  git(wt, 'commit', '-qam', 'run changes a');
  write(path.join(repo, 'c.txt'), 'c\n');
  git(repo, 'add', 'c.txt');
  git(repo, 'commit', '-qm', 'main adds an unrelated file');
  assert.deepEqual(codes(control), [], 'a target change the run does not touch is not drift');
  write(path.join(repo, 'a.txt'), 'a\nb\nc\nd\nE\nhello\n');
  git(repo, 'commit', '-qam', 'main redesigns a');
  const problem = checkRun(control, 'x').problems.find((p) => p.code === 'TARGET_DIVERGED');
  assert.match(problem.message, /main took 2 commit\(s\) since goal\/x left it .* changing 1 file\(s\) this run changed or claims \(a\.txt\)/);
  seedTicket(repo, control, '01-b.md', ticketText('ready-for-agent', 'exclusive: b.txt'));
  assert.throws(() => take(repo, 'x', 1), /main took 2 commit\(s\)/);
  assert.throws(() => setStatus(repo, 'x', '01', 'in-flight'), /main took 2 commit\(s\)/, 'taking one chosen ticket meets the same refusal');
  git(wt, 'merge', '-q', '--no-edit', 'main');
  assert.deepEqual(codes(control), []);
  write(path.join(repo, 'b.txt'), 'B\n');
  git(repo, 'commit', '-qam', 'main changes a file an open ticket claims');
  assert.match(checkRun(control, 'x').problems.find((p) => p.code === 'TARGET_DIVERGED').message, /\(b\.txt\)/);
  git(wt, 'merge', '-q', '--no-edit', 'main');
  assert.deepEqual(take(repo, 'x', 1), ['01']);
});

test('TICKET_IDLE: an in-flight ticket nothing has touched is flagged without waiting for STALE; a worker sign clears it', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  seedTicket(repo, control, '01-a.md', ticketText('ready-for-agent', 'exclusive: a.txt'));
  take(repo, 'x', 1);
  assert.deepEqual(codes(control), []);
  const later = Date.now() + 45 * 60 * 1000;
  assert.deepEqual(codes(control, { now: later, staleHours: 24 }), ['TICKET_IDLE']);
  assert.match(checkRun(control, 'x', { now: later, staleHours: 24 }).problems[0].message, /ticket 01 is in flight but nothing shows a worker on it for 45m/);
  const flight = path.join(control, 'runs/x/tickets/01.status.md');
  write(flight, 'heartbeat: now\nslice: 1/3\n');
  const beat = (later - 60 * 1000) / 1000;
  fs.utimesSync(flight, beat, beat);
  assert.deepEqual(codes(control, { now: later, staleHours: 24 }), [], 'a heartbeat a minute old is a live worker');
  write(flight, '**Status:** in-flight\nheartbeat: now\n');
  assert.deepEqual(codes(control), ['STATUS_COPY'], 'the flight record never carries a second ticket state');
});

test('the review→fix budget: a run makes at most one fix ticket per planned ticket, and take refuses the rest', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  // Landed tickets, as goal.mjs status would have left them: a new ticket file enters only as ready or blocked.
  write(path.join(control, 'tracker/x/issues/01-a.md'), ticketText('done', 'exclusive: a.txt'));
  write(path.join(control, 'tracker/x/issues/02-f.md'), ticketText('done', 'exclusive: a.txt', '**From review:** 01\n'));
  write(path.join(control, 'tracker/x/issues/03-f.md'), ticketText('done', 'exclusive: a.txt', '**From review:** 01\n'));
  rawCommit(control, '[x] fixture: three tickets landed');
  assert.deepEqual(frontier(control, 'x').malformed, [], 'the floor is two fix tickets');
  seedTicket(repo, control, '04-f.md', ticketText('ready-for-agent', 'exclusive: b.txt', '**From review:** 03\n'));
  const [bad] = frontier(control, 'x').malformed;
  assert.equal(bad.id, '04');
  assert.match(bad.problems[0], /past the run's review→fix budget of 2 .* fix budget spent/);
  assert.throws(() => take(repo, 'x', 1), /fails the claims gate/);
});

test('an open decision in log.md blocks every tick until it is answered; owner answers are collected', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  const log = path.join(control, 'runs/x/log.md');
  fs.appendFileSync(log, '- D1 (open) [grill] Q: hold background sends too?\n');
  commit(repo, '[x] D1 asked', ['runs/x/log.md']);
  assert.throws(() => tick(repo, 'x', '00'), /open decision\(s\) D1 \[grill\] Q: hold background sends too\?/);
  const answered = '- D1 [grill] Q: hold background sends too? → A: yes, as drafts (source: owner 2026-11-02)';
  fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace(/^- D1 \(open\).*$/m, answered));
  commit(repo, '[x] D1 answered', ['runs/x/log.md']);
  assert.equal(tick(repo, 'x', '00').ticked, '00');
  assert.deepEqual(ownerDecisions(fs.readFileSync(log, 'utf8')), [answered]);
});

/** A run worktree plus ticket 01 (claims a.txt) and 02 (claims b.txt) in flight, with contracts drafted. */
function dispatched({ one, two, claims = 'exclusive: a.txt', objective = 'X', before = () => {} }) {
  const ctx = setup();
  const { repo, control } = ctx;
  init(repo, 'x', objective, WHO);
  before(repo, control);
  fs.appendFileSync(path.join(control, 'runs/x/log.md'), '- D1 [grill] Q: q? → A: a (source: owner)\n');
  commit(repo, '[x] D1', ['runs/x/log.md']);
  const run = worktreeGet(repo, 'x');
  seedTicket(repo, control, '01-a.md', ticketText('ready-for-agent', claims, `\n${one}`));
  seedTicket(repo, control, '02-b.md', ticketText('ready-for-agent', 'exclusive: b.txt', `\n${two}`));
  assert.deepEqual(take(repo, 'x', 2), ['01', '02']);
  const drafted = prepareTicket(repo, 'x', '01');
  prepareTicket(repo, 'x', '02');
  return { ...ctx, run, drafted };
}
const fillIn = (repo, control, id) => {
  const rel = `runs/x/tickets/${id}.goal.md`;
  write(path.join(control, rel), fs.readFileSync(path.join(control, rel), 'utf8').replace(/<fill: [^>]*>/g, 'none'));
  commit(repo, `[x] ticket ${id} contract`, [rel]);
  return fs.readFileSync(path.join(control, rel), 'utf8');
};

test('prepare-ticket drafts every file-decided field verbatim, contract refuses <fill:> and probes grep criteria at the base', () => {
  const { repo, control, drafted } = dispatched({
    one: '- [ ] `grep -n hello a.txt` still matches (Invariant: present at base)\n- [ ] a.txt says bye (Red at base: it says hello)\n',
    two: '- [ ] `grep -n nosuchline b.txt` shows the new line\n- [ ] `grep -n x missing.txt` stays empty\n',
  });
  assert.equal(drafted.drafted, true);
  const text = fs.readFileSync(drafted.contract, 'utf8');
  const wt = drafted.worktree;
  assert.match(text, new RegExp(`^- Ticket base: ${git(wt, 'rev-parse', 'HEAD')}$`, 'm'));
  assert.match(text, /^- Worktree \/ branch: .* on goal\/x-t01$/m);
  assert.match(text, /^- Claims: exclusive: a\.txt; a needed path outside them/m);
  const statusFile = path.join(control, 'runs/x/tickets/01.status.md');
  assert.ok(text.includes(`- State folder: ${control} (every runs/… path here is under it, not in your worktree)`), 'the implementer is told where runs/ is');
  assert.ok(text.includes(`node ${GOAL} commit -m "[x] t01 status" ${statusFile}`), 'and the exact command that commits its heartbeat');
  assert.match(text, /^- \[ \] `grep -n hello a\.txt` still matches \(Invariant: present at base\)$/m, 'criteria byte for byte, backticks and all');
  assert.match(text, /^ {2}- D1 \[grill\] Q: q\? → A: a \(source: owner\)$/m, 'owner decisions ride in every contract');
  assert.equal(prepareTicket(repo, 'x', '01').drafted, false, 'a re-dispatch keeps the contract');
  const ticket = (id) => fs.readFileSync(path.join(control, `tracker/x/issues/${id}`), 'utf8');
  assert.match(checkContract({ text, ticketText: ticket('01-a.md'), worktree: wt }).problems.join('\n'), /still has <fill: …> fields/);
  const ok = checkContract({ text: fillIn(repo, control, '01'), ticketText: ticket('01-a.md'), worktree: wt });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.probes.map((p) => [p.exit, p.lines]), [[0, 1]]);
  const bad = checkContract({ text: fillIn(repo, control, '02'), ticketText: ticket('02-b.md'), worktree: worktreeGet(repo, 'x', '02') }).problems.join('\n');
  assert.match(bad, /`grep -n nosuchline b\.txt` matches nothing at the ticket base/);
  assert.match(bad, /`grep -n x missing\.txt` fails at the ticket base \(exit 2/);
});

test('brief assembles the committed contract and the docs, refusing a contract that does not pass', () => {
  const { repo, control } = dispatched({ one: '- [ ] a.txt says bye (Red at base)\n', two: '- [ ] b.txt says B (Red at base)\n' });
  assert.throws(() => brief(repo, 'x', '01'), /<fill: …> fields/);
  const contract = fillIn(repo, control, '01');
  const out = brief(repo, 'x', '01');
  const text = fs.readFileSync(out.brief, 'utf8');
  assert.ok(out.bytes < MAX_BRIEF_BYTES, `${out.bytes} bytes`);
  assert.ok(text.startsWith(contract.trim()));
  for (const heading of ['# The implement skill', '## The implementer brief', '## The receipt', '## Subagent contract']) assert.ok(text.includes(heading), heading);
});

test('merge lands a ticket: receipt and claims checked, suite run on the result, a red suite lands nothing', () => {
  const { repo, control, run } = dispatched({ one: '- [ ] a.txt says bye (Red at base)\n', two: '- [ ] b.txt says B (Red at base)\n' });
  fillIn(repo, control, '01');
  const wt = worktreeGet(repo, 'x', '01');
  const base = git(wt, 'rev-parse', 'HEAD');
  write(path.join(wt, 'a.txt'), 'bye\n');
  git(wt, 'commit', '-qam', 'Refs 01');
  const head = git(wt, 'rev-parse', 'HEAD');
  const { log } = runLogged(wt, 'grep -c bye a.txt');
  const receiptRel = 'runs/x/tickets/01.receipt.md';
  write(path.join(control, receiptRel), JSON.stringify({
    ticket: '01', conclusion: 'completed', ticket_base: base, head, changed_files: ['a.txt'],
    criteria: [{ criterion: 'a.txt says bye (Red at base)', result: 'pass', evidence: 'grep -c bye a.txt exit 0' }],
    validation: [{ command: 'grep -c bye a.txt', exit: 0, summary: '1', log }],
    review: { cited_fixed: 0, leads: [] }, not_validated: [], blockers: [], external_effects: [], worktree_clean: true,
  }));
  assert.throws(() => mergeTicket(repo, 'x', '01', { check: 'true' }), /receipt is not committed/);
  commit(repo, '[x] 01 receipt', [receiptRel]);
  assert.throws(() => brief(repo, 'x', '01'), /has a committed receipt that passes: land it with `goal\.mjs merge x 01`/, 'finished work is landed, never dispatched again');
  const before = git(run, 'rev-parse', 'HEAD');
  assert.throws(() => mergeTicket(repo, 'x', '01', { check: 'false' }), /suite failed on the merged run branch .* stays in flight/);
  assert.equal(git(run, 'rev-parse', 'HEAD'), before, 'a red suite resets the run branch');
  // A run names its own locks for its suites (`with-lock integration -- make test-integration`): a landing must not queue behind one.
  const locks = path.join(control, 'locks');
  const landed = mergeTicket(repo, 'x', '01', { check: `test -d ${locks}/merge && test ! -e ${locks}/integration` });
  assert.equal(landed.landed, `${before}..${head}`);
  assert.equal(git(run, 'rev-parse', 'HEAD'), head);
  assert.match(fs.readFileSync(path.join(control, 'tracker/x/issues/01-a.md'), 'utf8'), /^\*\*Status:\*\* done$/m);
  assert.match(landed.worktree, /^returned /);
  assert.equal(git(repo, 'branch', '--list', 'goal/x-t01'), '', 'the ticket branch is deleted');
  assert.match(fs.readFileSync(path.join(control, 'runs/x/ledger.md'), 'utf8'), /\[merge\] t01 landed/);
});

/** A run in reviewing on goal/x, with review_base the branch's fork point. */
function reviewing() {
  const ctx = setup();
  const { repo, control } = ctx;
  init(repo, 'x', 'X', WHO);
  const run = worktreeGet(repo, 'x');
  setReviewBase(repo, control, git(run, 'rev-parse', 'HEAD'));
  editRegistry(control, (e) => { e.status = 'reviewing'; });
  const review = (name, body) => {
    write(path.join(control, `runs/x/${name}`), `report\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`);
    commit(repo, `[x] ${name}`, [`runs/x/${name}`]);
  };
  return { ...ctx, run, review };
}

test('verdict: written only from a committed ship review of the branch tip, within the round budget; a typed verdict never marks a run done', () => {
  const { repo, control, run, review } = reviewing();
  const tip = git(run, 'rev-parse', 'HEAD');
  review('review.md', { verdict: 'no-ship', head: tip, open: ['F1 unchecked input'] });
  assert.throws(() => verdict(repo, 'x'), /says no-ship with 1 finding\(s\) open \(F1 unchecked input\)/);
  review('verify.md', { verdict: 'ship', head: 'f'.repeat(40), open: [] });
  assert.throws(() => verdict(repo, 'x'), /verify\.md read f{40}, but goal\/x is at/);
  review('verify.md', { verdict: 'ship', head: tip, open: [] });
  const v = verdict(repo, 'x');
  assert.deepEqual([v.target, v.review_head, v.written_by], ['goal/x', tip, 'goal.mjs verdict']);
  review('verify.md', { verdict: 'ship', head: tip, open: [], again: true });
  assert.throws(() => verdict(repo, 'x'), /verify\.md was rewritten 3 times; stage 8 is one review and one re-verification/);
  // A verdict typed past the guards (TO_AUTO_WRITER skips the hook) still never stands.
  write(path.join(control, 'runs/x/final-verdict.json'), JSON.stringify({ verdict: 'ship', target: 'goal/x', review_head: tip, review_base: tip }));
  rawCommit(control, '[x] typed verdict');
  assert.throws(() => setRegistry(repo, 'x', 'done'), /was not written by `goal\.mjs verdict x`/);
});

test('sole writers: runs.json and final-verdict.json refuse any other commit, whatever path spelling names them', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  const headBefore = git(control, 'rev-parse', 'HEAD');
  const cwd = process.cwd();
  try {
    process.chdir(repo); // `./runs.json` from outside the control plane is the spelling the old path check let through
    for (const edit of [(e) => { e.status = 'done'; }, (e) => { e.agent = 'someone-else'; }]) {
      const runs = registry(control);
      edit(runs[0]);
      write(path.join(control, 'runs.json'), JSON.stringify(runs));
      assert.throws(() => commit(repo, '[x] hand', ['./runs.json']), /runs\.json is written only by goal\.mjs init, tick/);
      git(control, 'checkout', '--', 'runs.json');
    }
    const todo = path.join(control, 'runs/x/todo.md');
    fs.writeFileSync(todo, fs.readFileSync(todo, 'utf8').replace('- [ ] 00', '- [x] 00'));
    assert.throws(() => commit(repo, '[x] hand tick', [':(glob)runs/*/todo.md']), /stage 00 is ticked only by/);
  } finally {
    process.chdir(cwd);
  }
  assert.equal(git(control, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(control, 'diff', '--cached', '--name-only'), '', 'a refused commit leaves nothing staged');
});

test('a validation log counts only if goal.mjs run recorded it: a hand-made log with a valid footer is refused', () => {
  const { repo } = setup();
  const base = git(repo, 'rev-parse', 'HEAD');
  write(path.join(repo, 'a.txt'), 'bye\n');
  git(repo, 'commit', '-qam', 'Refs 01');
  const head = git(repo, 'rev-parse', 'HEAD');
  const { log } = runLogged(repo, 'echo ok');
  const forged = path.join(path.dirname(log.path), 'forged.log');
  fs.copyFileSync(log.path, forged);
  const receipt = (cited) => JSON.stringify({
    ticket: '01', conclusion: 'completed', ticket_base: base, head, changed_files: ['a.txt'],
    criteria: [{ criterion: 'works', result: 'pass', evidence: 'echo ok' }],
    validation: [{ command: 'echo ok', exit: 0, summary: 'ok', log: cited }],
    review: { cited_fixed: 0, leads: [] }, not_validated: [], blockers: [], external_effects: [], worktree_clean: true,
  });
  const ticket = ticketText('in-flight', 'exclusive: a.txt', '\n- [ ] works\n');
  assert.deepEqual(checkReceipt({ text: receipt(log), worktree: repo, base, ticketText: ticket }).problems, []);
  assert.match(checkReceipt({ text: receipt({ ...log, path: forged }), worktree: repo, base, ticketText: ticket }).problems.join('\n'), /is not one `goal\.mjs run` recorded/);
});

test('gc returns the clean worktrees of a run no commit has moved for the stale window, and keeps a live run\'s', () => {
  const { repo } = setup();
  init(repo, 'x', 'X', WHO);
  const wt = worktreeGet(repo, 'x');
  assert.equal(gc(repo).items.find((i) => i.what === 'worktree'), undefined, 'a live run keeps its worktree');
  const stale = gc(repo, { now: Date.now() + 100 * 3600 * 1000 }).items.find((i) => i.what === 'worktree');
  assert.deepEqual([stale.run, stale.action, stale.path], ['x', 'return', wt]);
  gc(repo, { apply: true, now: Date.now() + 100 * 3600 * 1000 });
  assert.equal(fs.existsSync(wt), false);
  assert.equal(git(repo, 'branch', '--list', 'goal/x'), 'goal/x', 'the branch keeps every commit');
});

/** dispatched(), with ticket 01's change committed on its branch and its receipt committed: ready for `merge`. */
function readyToMerge() {
  const ctx = dispatched({ one: '- [ ] a.txt says bye (Red at base)\n', two: '- [ ] b.txt says B (Red at base)\n' });
  const { repo, control } = ctx;
  fillIn(repo, control, '01');
  const wt = worktreeGet(repo, 'x', '01');
  const base = git(wt, 'rev-parse', 'HEAD');
  write(path.join(wt, 'a.txt'), 'bye\n');
  git(wt, 'commit', '-qam', 'Refs 01');
  const head = git(wt, 'rev-parse', 'HEAD');
  const { log } = runLogged(wt, 'grep -c bye a.txt');
  write(path.join(control, 'runs/x/tickets/01.receipt.md'), JSON.stringify({
    ticket: '01', conclusion: 'completed', ticket_base: base, head, changed_files: ['a.txt'],
    criteria: [{ criterion: 'a.txt says bye (Red at base)', result: 'pass', evidence: 'grep -c bye a.txt exit 0' }],
    validation: [{ command: 'grep -c bye a.txt', exit: 0, summary: '1', log }],
    review: { cited_fixed: 0, leads: [] }, not_validated: [], blockers: [], external_effects: [], worktree_clean: true,
  }));
  commit(repo, '[x] 01 receipt', ['runs/x/tickets/01.receipt.md']);
  return { ...ctx, head, before: git(ctx.run, 'rev-parse', 'HEAD') };
}

test('merge undoes a landing it cannot finish, and its reset never overwrites an edit made in the run worktree', () => {
  const { repo, control, run, before, head } = readyToMerge();
  // A red suite resets with --keep: an edit to a file the merge did not change survives it.
  assert.throws(() => mergeTicket(repo, 'x', '01', { check: 'echo mine > b.txt; false' }), /suite failed .* goal\/x is back at/);
  assert.deepEqual([git(run, 'rev-parse', 'HEAD'), fs.readFileSync(path.join(run, 'b.txt'), 'utf8')], [before, 'mine\n']);
  git(run, 'checkout', '--', 'b.txt');
  // An edit to a file the merge changed: the reset refuses rather than lose it, and says how to finish by hand.
  assert.throws(() => mergeTicket(repo, 'x', '01', { check: 'echo mine >> a.txt; false' }), /would overwrite uncommitted edits in .* still at the merged head/);
  assert.deepEqual([git(run, 'rev-parse', 'HEAD'), fs.readFileSync(path.join(run, 'a.txt'), 'utf8')], [head, 'bye\nmine\n']);
  git(run, 'checkout', '--', 'a.txt');
  git(run, 'reset', '-q', '--keep', before);
  // Green suite, but the ticket cannot go done (here: an uncommitted tracker edit): the run branch goes back, nothing lands.
  const ticket = path.join(control, 'tracker/x/issues/01-a.md');
  fs.appendFileSync(ticket, 'note\n');
  assert.throws(() => mergeTicket(repo, 'x', '01', { check: 'true' }), /could not be marked done: .*uncommitted edits.*goal\/x is back at/);
  assert.equal(git(run, 'rev-parse', 'HEAD'), before);
  git(control, 'checkout', '--', 'tracker/x/issues/01-a.md');
  // The suite cannot even be logged (a hand edit under logs.txt): undone the same way.
  fs.appendFileSync(path.join(control, 'logs.txt'), 'junk\n');
  assert.throws(() => mergeTicket(repo, 'x', '01', { check: 'true' }), /suite could not run .*logs\.txt has an uncommitted edit.*goal\/x is back at/);
  assert.equal(git(run, 'rev-parse', 'HEAD'), before);
  git(control, 'checkout', '--', 'logs.txt');
  assert.equal(mergeTicket(repo, 'x', '01', { check: 'true' }).landed, `${before}..${head}`);
});

test('sole-writer files: a writer refuses an uncommitted hand edit under it, and a deletion never commits past it', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  const runs = registry(control);
  runs[0].status = 'done';
  runs[0].scripts = { sha256: '0'.repeat(64) }; // so pin has something to write
  write(path.join(control, 'runs.json'), `${JSON.stringify(runs, null, 2)}\n`);
  for (const call of [() => init(repo, 'y', 'Y', WHO), () => pin(repo, 'x'), () => adopt(repo, 'x', { agent: 'other', harness: 'test' })]) {
    assert.throws(call, /runs\.json has an uncommitted edit, and it is written only by goal\.mjs init/);
  }
  assert.equal(JSON.parse(git(control, 'show', 'HEAD:runs.json'))[0].status, 'bootstrapping');
  git(control, 'checkout', '--', 'runs.json');
  fs.rmSync(path.join(control, 'runs.json'));
  assert.throws(() => commit(repo, '[x] drop the registry', ['runs.json']), /runs\.json is written only by/);
  git(control, 'checkout', '--', 'runs.json');
  runLogged(repo, 'echo ok');
  fs.appendFileSync(path.join(control, 'logs.txt'), `${'0'.repeat(64)}  /forged.log\n`);
  assert.throws(() => runLogged(repo, 'touch ran'), /logs\.txt has an uncommitted edit/);
  assert.equal(fs.existsSync(path.join(repo, 'ran')), false, 'refused before the command runs');
  assert.doesNotMatch(git(control, 'show', 'HEAD:logs.txt'), /forged/);
});

test('contract probes run the search alone as argv: no shell, no pipeline tail, no flag that runs a program', () => {
  assert.deepEqual(firstStageArgv(`grep -n 'a b' x.txt | wc -l`), ['grep', '-n', 'a b', 'x.txt']);
  assert.deepEqual(firstStageArgv('git grep -nF "foo(" -- src'), ['git', 'grep', '-nF', 'foo(', '--', 'src']);
  for (const shellOnly of ['grep -rn foo src/*.ts', 'grep "$(id)" f', 'grep x f > out', 'grep x ~/f', "grep 'open"]) assert.equal(firstStageArgv(shellOnly), null, shellOnly);
  const victim = path.join(tmp('hard-victim-'), 'victim');
  const { control, drafted } = dispatched({
    one: `- [ ] \`grep -n hello a.txt | sort -o ${victim}\` still matches\n- [ ] \`rg --pre ./x hello a.txt\` matches\n- [ ] \`git grep -nO'touch ${victim}' hello\` matches\n- [ ] \`git grep --open='touch ${victim}' hello\` matches\n- [ ] \`grep -c nosuch a.txt\` counts the new lines\n`,
    two: '- [ ] b.txt says B (Red at base)\n',
  });
  const text = fs.readFileSync(drafted.contract, 'utf8').replace(/<fill: [^>]*>/g, 'none');
  const checked = checkContract({ text, ticketText: fs.readFileSync(path.join(control, 'tracker/x/issues/01-a.md'), 'utf8'), worktree: drafted.worktree });
  assert.equal(fs.existsSync(victim), false, 'a pipeline tail is never run');
  assert.deepEqual(checked.probes.map((p) => [p.command.split(' ')[0], p.exit]), [['grep', 0], ['grep', 1]], 'rg --pre and git grep -O, bundled or abbreviated, are not probed');
  assert.match(checked.problems.join('\n'), /`grep -c nosuch a\.txt` matches nothing at the ticket base/, 'a count of 0 is no match');
});

test('TARGET_DIVERGED: a supervisor run registered before init recorded its target is not diffed against main', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  const wt = worktreeGet(repo, 'x');
  write(path.join(wt, 'a.txt'), 'A\n');
  git(wt, 'commit', '-qam', 'run changes a');
  write(path.join(repo, 'a.txt'), 'E\n');
  git(repo, 'commit', '-qam', 'main changes a');
  assert.deepEqual(codes(control), ['TARGET_DIVERGED']);
  editRegistry(control, (e) => { delete e.target; e.mode = 'supervisor'; });
  assert.deepEqual(codes(control), [], 'its run branch is its target');
});

test('TICKET_IDLE: a goal.mjs run or with-lock in the ticket worktree is a worker sign, while it runs and when it ends', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  seedTicket(repo, control, '01-a.md', ticketText('ready-for-agent', 'exclusive: a.txt'));
  take(repo, 'x', 1);
  const runWt = worktreeGet(repo, 'x');
  const wt = worktreeGet(repo, 'x', '01');
  const later = Date.now() + 45 * 60 * 1000;
  const idle = () => codes(control, { now: later, staleHours: 24 });
  const liveOf = (cwd) => path.join(git(cwd, 'rev-parse', '--absolute-git-dir'), 'goal-live');
  const cli = (cwd, ...args) => spawnSync(process.execPath, [GOAL, ...args], { cwd, encoding: 'utf8' });
  const aged = (dir, at) => fs.utimesSync(dir, at / 1000, at / 1000);
  assert.deepEqual(idle(), ['TICKET_IDLE']);

  // The run that tripped the alert on 2026-11-09: 19 minutes of integration tests, no commit, no heartbeat.
  const during = cli(wt, 'run', '--', 'ls "$(git rev-parse --absolute-git-dir)/goal-live"');
  assert.equal(during.status, 0, during.stderr);
  assert.match(during.stdout, /^\d+$/m, 'a run marks its pid in the worktree git dir while the command runs');
  const whole = cli(wt, 'run', '--', 'cd "$(git rev-parse --absolute-git-dir)/goal-live" && ls -a && cat [0-9]*');
  assert.match(whole.stdout, /\d{2}:\d{2}:\d{2} \d{4}/, 'the mark appears whole, start time inside: a concurrent start that read it empty would clear it as dead');
  assert.doesNotMatch(whole.stdout, /\.tmp/);
  assert.deepEqual(fs.readdirSync(liveOf(wt)), [], 'and takes the mark away when it ends');
  assert.equal(git(wt, 'status', '--porcelain'), '', 'the mark never dirties the worktree');
  assert.deepEqual(idle(), ['TICKET_IDLE'], 'a run that ended 45 minutes ago is no worker');
  aged(liveOf(wt), later - 60 * 1000);
  assert.deepEqual(idle(), [], 'a run that ended a minute ago is a worker');
  aged(liveOf(wt), later - 45 * 60 * 1000);

  const waiting = cli(wt, 'with-lock', 'integration', '--', 'ls', liveOf(wt));
  assert.match(waiting.stdout, /^\d+$/m, 'a command waiting on or holding a lock is marked too');

  // Alive: this test process, marked as a run in the ticket worktree would mark itself.
  write(path.join(liveOf(wt), String(process.pid)), started(process.pid));
  aged(liveOf(wt), later - 45 * 60 * 1000);
  assert.deepEqual(idle(), [], 'a run still going counts as now, however long it has run');
  write(path.join(liveOf(wt), String(process.pid)), 'Thu Jan  1 00:00:00 1970');
  assert.deepEqual(idle(), ['TICKET_IDLE'], 'a killed run whose pid another process took is no worker');
  cli(wt, 'run', '--', 'true');
  assert.deepEqual(fs.readdirSync(liveOf(wt)), [], 'the next run clears a dead mark');

  // Attribution: activity in another worktree (the run worktree shares the ticket base) says nothing about this ticket.
  cli(runWt, 'run', '--', 'true');
  aged(liveOf(runWt), later - 60 * 1000);
  aged(liveOf(wt), later - 45 * 60 * 1000);
  assert.deepEqual(idle(), ['TICKET_IDLE']);
});

test('TICKET_IDLE names the newest sign, and a ticket whose completed receipt is waiting is told to land it', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  seedTicket(repo, control, '01-a.md', ticketText('ready-for-agent', 'exclusive: a.txt'));
  take(repo, 'x', 1);
  const later = Date.now() + 45 * 60 * 1000;
  const message = () => checkRun(control, 'x', { now: later, staleHours: 24 }).problems.find((p) => p.code === 'TICKET_IDLE').message;
  assert.match(message(), /for 45m \(last sign: a ticket commit;/);
  assert.match(message(), /if no worker owns it, kill any recorded pid and re-dispatch it/);
  const flight = path.join(control, 'runs/x/tickets/01.status.md');
  write(flight, 'heartbeat: then\n');
  fs.utimesSync(flight, (later - 40 * 60 * 1000) / 1000, (later - 40 * 60 * 1000) / 1000);
  assert.match(message(), /for 40m \(last sign: a heartbeat in tickets\/01\.status\.md;/);
  write(path.join(control, 'runs/x/tickets/01.receipt.md'), `done\n\n${JSON.stringify({ ticket: '01', conclusion: 'completed' })}\n`);
  commit(repo, '[x] 01 receipt', ['runs/x/tickets/01.receipt.md']);
  assert.match(message(), /its committed receipt says completed: land it with `goal\.mjs merge x 01`/);
  assert.doesNotMatch(message(), /kill any recorded pid/, 'a finished worker is not a dead one');
});

test('guarded: a criterion that needs a path its own ticket lists as guarded is refused before dispatch, and merge says what guarded means', () => {
  const needs = '- [ ] `git grep -c CHECK -- db/migrations/001.sql` counts 3 (Red at base: no such file)\n';
  const { repo, control } = setup();
  init(repo, 'x', 'X; migrations under db/migrations are in scope here', WHO);
  seedTicket(repo, control, '01-a.md', ticketText('ready-for-agent', 'exclusive: a.txt ; guarded: db/migrations/', `\n${needs}`));
  const gate = frontier(control, 'x');
  assert.deepEqual(gate.frontier, []);
  assert.match(gate.malformed[0].problems[0], /needs db\/migrations\/001\.sql, which its Claims line lists as guarded \(off limits.*claimed exclusive/);
  assert.throws(() => take(repo, 'x', 1), /claims gate/);
  seedTicket(repo, control, '01-a.md', ticketText('ready-for-agent', 'exclusive: a.txt, db/migrations/001.sql ; guarded: .github/', `\n${needs}`));
  assert.match(frontier(control, 'x').malformed[0].problems[0], /holds no grant for/, 'relabelling the path exclusive is not a grant');
  grant(repo, 'x', ['db/migrations/'], 'migrations under db/migrations are in scope here');
  assert.deepEqual(frontier(control, 'x').malformed, [], 'the granted path is an exclusive claim');
  const untouched = '- [ ] `git diff --name-only main...HEAD -- db/migrations/` prints nothing: no migration is written\n';
  seedTicket(repo, control, '01-a.md', ticketText('ready-for-agent', 'exclusive: a.txt ; guarded: db/migrations/', `\n${untouched}`));
  assert.deepEqual(frontier(control, 'x').malformed, [], 'a criterion that the guarded path stays untouched needs no edit there');
  // A ticket already dispatched is past this gate: one such ticket must not close the tracker for the rest of a live run.
  write(path.join(control, 'tracker/x/issues/02-b.md'), ticketText('in-flight', 'exclusive: b.txt ; guarded: db/migrations/', `\n${needs}`));
  rawCommit(control, '[x] fixture: a ticket dispatched by an older goal.mjs');
  assert.deepEqual(frontier(control, 'x').malformed, []);

  const m = dispatched({ one: '- [ ] a.txt says bye (Red at base)\n', two: '- [ ] b.txt says B (Red at base)\n', claims: 'exclusive: a.txt ; guarded: b.txt' });
  fillIn(m.repo, m.control, '01');
  const wt = worktreeGet(m.repo, 'x', '01');
  const base = git(wt, 'rev-parse', 'HEAD');
  write(path.join(wt, 'a.txt'), 'bye\n');
  write(path.join(wt, 'b.txt'), 'B\n');
  git(wt, 'commit', '-qam', 'Refs 01');
  const { log } = runLogged(wt, 'grep -c bye a.txt');
  write(path.join(m.control, 'runs/x/tickets/01.receipt.md'), JSON.stringify({
    ticket: '01', conclusion: 'completed', ticket_base: base, head: git(wt, 'rev-parse', 'HEAD'), changed_files: ['a.txt', 'b.txt'],
    criteria: [{ criterion: 'a.txt says bye (Red at base)', result: 'pass', evidence: 'grep -c bye a.txt exit 0' }],
    validation: [{ command: 'grep -c bye a.txt', exit: 0, summary: '1', log }],
    review: { cited_fixed: 0, leads: [] }, not_validated: [], blockers: [], external_effects: [], worktree_clean: true,
  }));
  commit(m.repo, '[x] 01 receipt', ['runs/x/tickets/01.receipt.md']);
  assert.throws(() => mergeTicket(m.repo, 'x', '01', { check: 'true' }), /touched b\.txt \(guarded\): an unclaimed edit.*`guarded` in a Claims line means off limits.*goal\.mjs grant x b\.txt -- .*goal\.mjs claim x 01 exclusive b\.txt/);
});

test('a call goal.mjs cannot read prints the usage of that command, not of all forty', () => {
  const { repo } = setup();
  const bad = spawnSync(process.execPath, [GOAL, 'commit', 'x', 'a message with no -m'], { cwd: repo, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^usage: goal\.mjs commit -m <msg> <file>\.\.\.$/m);
  assert.doesNotMatch(bad.stderr, /preflight|worktree get/);
  const unknown = spawnSync(process.execPath, [GOAL, 'no-such-command'], { cwd: repo, encoding: 'utf8' });
  assert.match(unknown.stderr, /preflight/, 'an unknown command still gets the whole list');
  assert.notEqual(fs.statSync(GOAL).mode & 0o111, 0, 'goal.mjs runs as a command: `$G check` word-splits in no shell');
});

test('grant: a CI or migrations path is claimed, amended and landed only under the owner\'s recorded words', () => {
  const said = 'the run may add migrations under db/migrations for the jobs table';
  const { repo, control, read } = setup();
  init(repo, 'x', `Build the jobs table; ${said}`, WHO);
  seedTicket(repo, control, '01-a.md', ticketText('ready-for-agent', 'exclusive: a.txt, db/migrations/001.sql'));
  seedTicket(repo, control, '02-b.md', ticketText('ready-for-agent', 'exclusive: b.txt'));
  const gate = frontier(control, 'x');
  assert.deepEqual(gate.frontier, []);
  assert.match(gate.malformed[0].problems[0], /claims db\/migrations\/001\.sql, a guarded-class path \(CI, migrations\) the run holds no grant for.*goal\.mjs grant x db\/migrations\/001\.sql -- /);
  assert.throws(() => grant(repo, 'x', ['db/migrations/'], 'the owner said anything goes here'), /neither the registered objective nor an owner decision/);
  assert.throws(() => grant(repo, 'x', ['db/migrations/'], 'Build'), /at least 20 characters/);
  assert.throws(() => grant(repo, 'x', ['../etc'], said), /repo-relative/);
  assert.match(grant(repo, 'x', ['db/migrations/'], said), /granted db\/migrations\//);
  assert.deepEqual(registry(control)[0].grants.map((g) => [g.paths, g.quote]), [[['db/migrations/'], said]]);
  assert.match(read('runs/x/ledger.md'), /\[grant\] db\/migrations\/: "the run may add migrations/);
  assert.deepEqual(next(control, 'x').grants.map((g) => g.paths), [['db/migrations/']], 'the hand-back reads every grant from next');
  assert.deepEqual(frontier(control, 'x').malformed, []);
  assert.deepEqual(take(repo, 'x', 2), ['01', '02']);

  // An amendment may add a granted path, and still no other guarded one.
  assert.match(amendClaims(repo, 'x', '02', 'exclusive', ['db/migrations/002.sql'], 'a second table').claims, /db\/migrations\/002\.sql/);
  assert.throws(() => amendClaims(repo, 'x', '02', 'exclusive', ['.github/workflows/ci.yml'], 'ci'), /is guarded.*goal\.mjs grant x/);
  // The owner's words may also be a decision in log.md, never the orchestrator's own line.
  fs.appendFileSync(path.join(control, 'runs/x/log.md'), '- D1 [0] Q: CI? → A: yes, edit .github/workflows for the new job (source: owner)\n- D2 [0] Q: deploy? → A: change deploy/migrations freely (source: default)\n');
  commit(repo, '[x] decisions', ['runs/x/log.md']);
  assert.match(grant(repo, 'x', ['.github/'], 'edit .github/workflows for the new job'), /granted \.github\//);
  assert.throws(() => grant(repo, 'x', ['deploy/migrations/'], 'change deploy/migrations freely'), /neither the registered objective nor an owner decision/);
});

test('merge lands an edit to a migrations path only while the run holds a grant for it', () => {
  const said = 'migrations under db/migrations are part of this work';
  const m = dispatched({
    one: '- [ ] a.txt says bye (Red at base)\n', two: '- [ ] b.txt says B (Red at base)\n', claims: 'exclusive: a.txt, db/migrations/001.sql',
    objective: `X; ${said}`, before: (repo) => grant(repo, 'x', ['db/migrations/'], said),
  });
  fillIn(m.repo, m.control, '01');
  const wt = worktreeGet(m.repo, 'x', '01');
  const base = git(wt, 'rev-parse', 'HEAD');
  write(path.join(wt, 'a.txt'), 'bye\n');
  write(path.join(wt, 'db/migrations/001.sql'), 'create table jobs ();\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'Refs 01');
  const { log } = runLogged(wt, 'grep -c bye a.txt');
  write(path.join(m.control, 'runs/x/tickets/01.receipt.md'), JSON.stringify({
    ticket: '01', conclusion: 'completed', ticket_base: base, head: git(wt, 'rev-parse', 'HEAD'), changed_files: ['a.txt', 'db/migrations/001.sql'],
    criteria: [{ criterion: 'a.txt says bye (Red at base)', result: 'pass', evidence: 'grep -c bye a.txt exit 0' }],
    validation: [{ command: 'grep -c bye a.txt', exit: 0, summary: '1', log }],
    review: { cited_fixed: 0, leads: [] }, not_validated: [], blockers: [], external_effects: [], worktree_clean: true,
  }));
  commit(m.repo, '[x] 01 receipt', ['runs/x/tickets/01.receipt.md']);
  // A ticket dispatched before grants were recorded (or whose claim was relabelled by hand) meets the gate at the landing.
  const grants = registry(m.control)[0].grants;
  editRegistry(m.control, (run) => { delete run.grants; });
  assert.throws(() => mergeTicket(m.repo, 'x', '01', { check: 'true' }), /touched db\/migrations\/001\.sql, a guarded-class path \(CI, migrations\) the run holds no grant for.*goal\.mjs grant x db\/migrations\/001\.sql -- /);
  editRegistry(m.control, (run) => { run.grants = grants; });
  assert.match(mergeTicket(m.repo, 'x', '01', { check: 'true' }).landed, /\.\./);
});

const started = (pid) => spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.trim();
function setBudgets(repo, control, budgets) {
  const ledger = path.join(control, 'runs/x/ledger.md');
  fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').replace('## NOW\n', `## NOW\n- budgets: ${budgets}\n`));
  commit(repo, '[x] budgets', ['runs/x/ledger.md']);
}

test('commit takes a file whose deletion is already staged, and names a path that is no file', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  write(path.join(control, 'runs/x/notes/a.md'), 'a\n');
  commit(repo, '[x] note', ['runs/x/notes/a.md']);
  git(control, 'rm', '-q', 'runs/x/notes/a.md');
  write(path.join(control, 'runs/x/notes/b.md'), 'b\n');
  assert.match(commit(repo, '[x] replace the note', ['runs/x/notes/a.md', 'runs/x/notes/b.md']), /^[0-9a-f]{7,}$/);
  assert.equal(git(control, 'status', '--porcelain'), '');
  assert.equal(git(control, 'ls-files', 'runs/x/notes'), 'runs/x/notes/b.md');
  assert.throws(() => commit(repo, '[x] typo', ['runs/x/notes/c.md']), /runs\/x\/notes\/c\.md is no file in the state folder/);
});

test('a ticket worktree with a live goal.mjs run in it is not returned, landed or briefed for a second worker', async () => {
  const { repo, control } = dispatched({ one: '- [ ] a.txt says bye (Red at base)\n', two: '- [ ] b.txt says B (Red at base)\n' });
  fillIn(repo, control, '01');
  const wt = worktreeGet(repo, 'x', '01');
  const live = path.join(git(wt, 'rev-parse', '--absolute-git-dir'), 'goal-live');
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    write(path.join(live, String(sleeper.pid)), started(sleeper.pid));
    assert.throws(() => worktreeReturn(repo, 'x', '01'), /has a live goal\.mjs run or with-lock in it \(pid \d+\)/);
    assert.throws(() => brief(repo, 'x', '01'), /live goal\.mjs run or with-lock in it.*a second worker/);
    assert.throws(() => mergeTicket(repo, 'x', '01', { check: 'true' }), /live goal\.mjs run or with-lock in it/);
    // The process asking is never its own obstacle: `with-lock x -- goal.mjs worktree return` marks the worktree it runs in.
    const self = spawnSync(process.execPath, [GOAL, 'with-lock', 'probe', '--', process.execPath, GOAL, 'worktree', 'return', 'x', '02'], { cwd: worktreeGet(repo, 'x', '02'), encoding: 'utf8' });
    assert.equal(self.status, 0, self.stderr);
  } finally {
    sleeper.kill();
  }
  fs.rmSync(live, { recursive: true, force: true });
  assert.match(worktreeReturn(repo, 'x', '01'), /returned|removed/);
});

test('take and status keep in-flight tickets within NOW budgets, and frontier names tickets whose blockers have landed', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  for (const [n, f] of [['01', 'a'], ['02', 'b'], ['03', 'c'], ['04', 'd']]) seedTicket(repo, control, `${n}-${f}.md`, ticketText('ready-for-agent', `exclusive: ${f}.txt`));
  assert.deepEqual(take(repo, 'x', 0), [], 'no budgets line: nothing is clamped, and 0 still takes nothing');
  setBudgets(repo, control, 'concurrent 2, agents 40, wall-clock 8h');
  assert.deepEqual(take(repo, 'x', 22), ['01', '02'], 'a count past the free slots takes only what the budget allows (22 was once meant as a ticket id)');
  assert.throws(() => setStatus(repo, 'x', '03', 'in-flight'), /no free slot: 2 of concurrent 2 in flight \(01, 02\)/);
  assert.deepEqual(take(repo, 'x', 1), []);
  setStatus(repo, 'x', '01', 'stuck', { reason: 'too big' });
  assert.deepEqual(take(repo, 'x', 5), ['03']);

  const edge = (status, blockedBy, claims) => `# t\n\n**Status:** ${status}\n**Blocked by:** ${blockedBy}\n**Claims:** ${claims}\n`;
  write(path.join(control, 'tracker/x/issues/05-e.md'), edge('done', 'None', 'exclusive: e.txt'));
  write(path.join(control, 'tracker/x/issues/06-f.md'), edge('blocked: owner Q3', '05', 'exclusive: f.txt'));
  write(path.join(control, 'tracker/x/issues/07-g.md'), edge('blocked', '05, 01', 'exclusive: g.txt'));
  rawCommit(control, '[x] fixture: a landed blocker');
  const gate = frontier(control, 'x');
  assert.deepEqual(gate.releasable, [{ id: '06', reason: 'owner Q3' }], 'every blocker done: flip it, or see why it waits');
  assert.deepEqual(gate.unreachable, [{ id: '07', behind: ['01'] }], 'a stuck blocker never unblocks');
});

test('next lists each in-flight ticket with its last sign, and check warns when the wall-clock budget is spent', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  seedTicket(repo, control, '01-a.md', ticketText('ready-for-agent', 'exclusive: a.txt'));
  take(repo, 'x', 1);
  const later = Date.now() + 20 * 60 * 1000;
  const [row] = flightRows(control, 'x', later);
  assert.deepEqual([row.id, row.last_sign, row.idle_min, row.receipt, row.live], ['01', 'a ticket commit', 20, null, false]);
  write(path.join(control, 'runs/x/tickets/01.receipt.md'), `r\n\n${JSON.stringify({ ticket: '01', conclusion: 'partial' })}\n`);
  commit(repo, '[x] 01 receipt', ['runs/x/tickets/01.receipt.md']);
  assert.equal(flightRows(control, 'x', later)[0].receipt, 'partial');

  assert.deepEqual(codes(control, { now: Date.now() + 9 * 3600 * 1000, staleHours: 24, idleMinutes: 9999 }), [], 'no budget, no clock');
  setBudgets(repo, control, 'concurrent 3, wall-clock 8h');
  assert.deepEqual(codes(control, { now: Date.now() + 7 * 3600 * 1000, staleHours: 24, idleMinutes: 9999 }), []);
  const spent = checkRun(control, 'x', { now: Date.now() + 9 * 3600 * 1000, staleHours: 24, idleMinutes: 9999 }).problems;
  assert.deepEqual(spent.map((p) => p.code), ['BUDGET_SPENT']);
  assert.match(spent[0].message, /9\.0h since the run started, past its wall-clock budget of 8h/);
});

test('a worktree of the clone prepare made resolves to that state, and its to-orc runs count as a ticket worker', () => {
  const { repo, control } = setup();
  const clone = path.join(control, 'clone');
  git(control, 'clone', '-q', repo, clone);
  const wt = path.join(tmp('hard-clone-wt-'), 'wt');
  git(clone, 'worktree', 'add', '-q', '-b', 'side', wt);
  process.env.TO_AUTO_HOME = tmp('hard-other-state-');
  assert.equal(controlDir(wt), control, 'the clone belongs to the state that holds it, whatever TO_AUTO_HOME says');
  process.env.TO_AUTO_HOME = control;
  init(repo, 'x', 'X', WHO);
  seedTicket(repo, control, '01-a.md', ticketText('ready-for-agent', 'exclusive: a.txt'));
  take(repo, 'x', 1);
  const info = JSON.parse(fs.readFileSync(path.join(control, 'workspace.json'), 'utf8'));
  write(path.join(control, 'workspace.json'), JSON.stringify({ ...info, cloned: true, workspace: clone }));
  commit(repo, '[state] workspace', ['workspace.json']);
  const later = Date.now() + 45 * 60 * 1000;
  assert.deepEqual(codes(control, { now: later, staleHours: 24 }), ['TICKET_IDLE']);
  const orc = path.join(repo, '.git', 'to-orc', 'x', 't01');
  fs.mkdirSync(orc, { recursive: true });
  const beat = (later - 60 * 1000) / 1000;
  fs.utimesSync(orc, beat, beat);
  assert.deepEqual(codes(control, { now: later, staleHours: 24 }), [], 'to-orc writes under the repo dispatch was given, not the clone');
});

test('a registry slug that is not a slug (..) is never read, so gc cannot delete outside tmp/', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  // `..` aims tmp/<slug> at the state folder itself, so even code without this check deletes only this test's sandbox.
  editRegistry(control, (e) => { e.slug = '..'; e.status = 'done'; });
  assert.throws(() => gc(repo, { apply: true }), /not a list of runs with a kebab-case slug/);
  assert.ok(fs.existsSync(control));
});

test('gc re-reads the registry before each removal: a run that started again while gc sized the pool keeps its worktree', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  const wt = worktreeGet(repo, 'x');
  editRegistry(control, (e) => { e.status = 'done'; });
  // treehouse status is gc's first slow call; this one resumes the run meanwhile, as a live session would.
  const fake = path.join(tmp('hard-th-'), 'treehouse');
  write(fake, `#!${process.execPath}
const fs = require('node:fs'); const { execFileSync } = require('node:child_process');
const file = ${JSON.stringify(path.join(control, 'runs.json'))};
const was = fs.readFileSync(file, 'utf8');
if (was.includes('"status": "done"')) {
  fs.writeFileSync(file, was.replace('"status": "done"', '"status": "building"'));
  execFileSync('git', ['-C', ${JSON.stringify(control)}, 'commit', '-qam', 'resumed'], { env: { ...process.env, TO_AUTO_WRITER: '1' } });
}
process.stdout.write('[]\\n');
`);
  fs.chmodSync(fake, 0o755);
  process.env.TO_AUTO_TREEHOUSE = fake;
  try {
    const item = gc(repo, { apply: true }).items.find((i) => i.what === 'worktree');
    assert.deepEqual([item.action, item.why], ['keep', 'x is running again']);
  } finally {
    process.env.TO_AUTO_TREEHOUSE = '';
  }
  assert.ok(fs.existsSync(wt), 'the running run keeps its worktree');
});

test('a treehouse slot that is the workspace itself is refused when the workspace is a linked worktree', () => {
  const { repo } = setup();
  const linked = path.join(tmp('hard-linked-'), 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', linked);
  process.env.TO_AUTO_HOME = tmp('hard-state-');
  assert.equal(prepare(linked).workspace, linked);
  init(linked, 'x', 'X', WHO);
  const fake = path.join(tmp('hard-th-'), 'treehouse');
  write(fake, '#!/bin/sh\n[ "$1" = get ] && echo "$PWD"\nexit 0\n');
  fs.chmodSync(fake, 0o755);
  process.env.TO_AUTO_TREEHOUSE = fake;
  try {
    assert.throws(() => worktreeGet(linked, 'x'), /is an owner checkout/);
  } finally {
    process.env.TO_AUTO_TREEHOUSE = '';
  }
  assert.equal(git(linked, 'rev-parse', '--abbrev-ref', 'HEAD'), 'side');
});

test('a duplicate ticket number shows in next and blocks the move to reviewing; a run with no age is uncheckable, never fresh', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  write(path.join(control, 'tracker/x/issues/01-a.md'), ticketText('done', 'exclusive: a.txt'));
  write(path.join(control, 'tracker/x/issues/01-b.md'), ticketText('done', 'exclusive: b.txt'));
  rawCommit(control, '[x] fixture: two tickets numbered 01');
  editRegistry(control, (e) => { e.status = 'building'; });
  assert.match(JSON.stringify(next(control, 'x')), /01 \(01-b\.md: ticket number 01 is also used by 01-a\.md\)/);
  assert.throws(() => setRegistry(repo, 'x', 'reviewing'), /build is not complete: 01-b\.md: ticket number 01 is also used by 01-a\.md; renumber it/);
  const bare = path.join(tmp('hard-bare-'), 'c');
  fs.mkdirSync(bare);
  const runs = registry(control);
  runs.push({ slug: 'y', status: 'building' });
  write(path.join(control, 'runs.json'), `${JSON.stringify(runs, null, 2)}\n`);
  rawCommit(control, 'fixture: a run with no start time');
  assert.throws(() => checkRun(control, 'y'), /y has no start time and no commit of its own/);
});

test('gc keeps the bootstrap worktree and a run whose worktrees.json is unreadable, ignores and bounds gc.log, and names a plane with no workspace.json', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  editRegistry(control, (e) => { e.status = 'done'; });
  const boot = path.join(control, 'worktrees', 'bootstrap');
  git(repo, 'worktree', 'add', '-q', '--detach', boot);
  write(path.join(control, 'runs/x/worktrees.json'), '{ not json');
  rawCommit(control, 'fixture: broken records');
  const { items } = gc(repo, { apply: true });
  assert.equal(items.find((i) => i.path === boot)?.why, 'the bootstrap stage removes it');
  assert.ok(fs.existsSync(boot));
  assert.match(items.find((i) => i.what === 'worktrees.json').why, /unreadable/);
  write(path.join(control, 'gc.log'), `${'old line\n'.repeat(1500)}`);
  write(path.join(control, 'tmp/x/f'), 'x');
  gc(repo, { apply: true });
  assert.equal(fs.readFileSync(path.join(control, 'gc.log'), 'utf8').trim().split('\n').length, 1000);
  assert.equal(git(control, 'status', '--porcelain', '--', 'gc.log', '.gitignore'), '', 'gc.log is ignored, the ignore committed');
  const lone = tmp('hard-lone-');
  write(path.join(lone, 'x', '.to-auto'), 'to-auto control plane\n');
  assert.match(gcAll(lone)[0].error, /no workspace\.json/);
});

test('paths resolve to their on-disk case, so a state or slot spelled in another case is the same one', (t) => {
  const plane = path.join(tmp('hard-case-'), 'Plane');
  write(path.join(plane, '.to-auto'), 'to-auto control plane\n');
  const other = plane.replace(/Plane$/, 'plane');
  if (!fs.existsSync(other)) return t.skip('case-sensitive filesystem: another case is another path'); // CI's Linux runner
  assert.equal(stateDir(other), plane);
});

test('a branch-mode run keeps goal/<slug> as its run branch after a later supervise saved a target for the repo', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  const run = worktreeGet(repo, 'x');
  write(path.join(run, 'r.txt'), 'run work\n');
  git(run, 'add', 'r.txt');
  git(run, 'commit', '-qm', 'run moves past main'); // so goal/x and main give different fork points
  seedTicket(repo, control, '01-a.md', ticketText('ready-for-agent', 'exclusive: a.txt', '\n- [ ] a.txt says bye (Red at base)\n'));
  take(repo, 'x', 1);
  const { contract, worktree } = prepareTicket(repo, 'x', '01');
  const text = fs.readFileSync(contract, 'utf8').replace(/<fill: [^>]*>/g, 'none');
  const ticket = fs.readFileSync(path.join(control, 'tracker/x/issues/01-a.md'), 'utf8');
  configure({ targetBranch: 'main', targetSaved: true }); // as the CLI loads supervisor.json
  try {
    assert.deepEqual(checkContract({ text, ticketText: ticket, worktree }).problems, []);
    init(repo, 'y', 'Y', { ...WHO, mode: 'branch' });
    assert.deepEqual([registry(control).at(-1).mode, registry(control).at(-1).target], ['branch', 'main'], '--mode branch overrides the saved target');
    assert.throws(() => { configure({ targetBranch: 'main' }); init(repo, 'z', 'Z', { ...WHO, mode: 'branch' }); }, /--target-branch main is supervisor mode, not branch/);
  } finally {
    configure();
  }
});

// Review of 2026-11-09: each case below failed on the scripts as they were.
test('ticket writes: a $ in a reason stays text, a refused commit leaves no edit behind, `none` is no path, a bare migrations folder is guarded', () => {
  const { repo, control, read } = setup();
  init(repo, 'x', 'X', WHO);
  seedTicket(repo, control, '01-a.md', ticketText('blocked', 'exclusive: none'));
  seedTicket(repo, control, '02-b.md', ticketText('ready-for-agent', 'exclusive: none'));
  assert.deepEqual(frontier(control, 'x').conflicts, [], 'two tickets that claim nothing do not overlap');
  setStatus(repo, 'x', '01', 'stuck', { reason: "cost $& and $' more" });
  assert.match(read('tracker/x/issues/01-a.md'), /^\*\*Status:\*\* stuck: cost \$& and \$' more\n\*\*Blocked by:\*\* None$/m);
  for (const dir of ['db/migrations', 'db/migrations/']) assert.throws(() => amendClaims(repo, 'x', '02', 'exclusive', [dir], 'schema'), /is guarded/, dir);
  write(path.join(control, 'tracker/x/issues/03-c.md'), ticketText('blocked', 'exclusive: c/').replace('None', 'banana'));
  rawCommit(control, '[x] fixture: a malformed ticket');
  assert.throws(() => setStatus(repo, 'x', '03', 'stuck', { reason: 'x' }), /malformed/);
  assert.equal(git(control, 'status', '--porcelain'), '', 'the refused status edit is not left for the next call to trip on');
});

test('merge reads the diff without rename folding: moving an unclaimed file into a claimed folder does not land', () => {
  const { repo, control } = dispatched({ one: '- [ ] ok/b.txt exists\n', two: '- [ ] b.txt says B (Red at base)\n' });
  fillIn(repo, control, '01');
  amendClaims(repo, 'x', '01', 'exclusive', ['ok/'], 'the file moves here');
  const wt = worktreeGet(repo, 'x', '01');
  const base = git(wt, 'rev-parse', 'HEAD');
  fs.mkdirSync(path.join(wt, 'ok'));
  git(wt, 'mv', 'b.txt', 'ok/b.txt');
  git(wt, 'commit', '-qm', 'Refs 01');
  assert.equal(git(wt, 'diff', '--name-only', `${base}...HEAD`), 'ok/b.txt', 'git folds the rename, hiding the deleted b.txt');
  const { log } = runLogged(wt, 'test -f ok/b.txt');
  const receiptRel = 'runs/x/tickets/01.receipt.md';
  write(path.join(control, receiptRel), JSON.stringify({
    ticket: '01', conclusion: 'completed', ticket_base: base, head: git(wt, 'rev-parse', 'HEAD'), changed_files: ['b.txt', 'ok/b.txt'],
    criteria: [{ criterion: 'ok/b.txt exists', result: 'pass', evidence: 'test -f ok/b.txt exit 0' }],
    validation: [{ command: 'test -f ok/b.txt', exit: 0, summary: '', log }],
    review: { cited_fixed: 0, leads: [] }, not_validated: [], blockers: [], external_effects: [], worktree_clean: true,
  }));
  commit(repo, '[x] 01 receipt', [receiptRel]);
  assert.throws(() => mergeTicket(repo, 'x', '01', { check: 'true' }), /touched b\.txt \(unclaimed\)/);
});

test('merge refuses a run worktree on another branch, and a missing suite before it rebases the ticket', () => {
  const { repo, control, run } = dispatched({ one: '- [ ] a.txt says bye (Red at base)\n', two: '- [ ] b.txt says B (Red at base)\n' });
  fillIn(repo, control, '01');
  const wt = worktreeGet(repo, 'x', '01');
  const base = git(wt, 'rev-parse', 'HEAD');
  write(path.join(wt, 'a.txt'), 'bye\n');
  git(wt, 'commit', '-qam', 'Refs 01');
  const head = git(wt, 'rev-parse', 'HEAD');
  const { log } = runLogged(wt, 'grep -c bye a.txt');
  const receiptRel = 'runs/x/tickets/01.receipt.md';
  write(path.join(control, receiptRel), JSON.stringify({
    ticket: '01', conclusion: 'completed', ticket_base: base, head, changed_files: ['a.txt'],
    criteria: [{ criterion: 'a.txt says bye (Red at base)', result: 'pass', evidence: 'grep -c bye a.txt exit 0' }],
    validation: [{ command: 'grep -c bye a.txt', exit: 0, summary: '1', log }],
    review: { cited_fixed: 0, leads: [] }, not_validated: [], blockers: [], external_effects: [], worktree_clean: true,
  }));
  commit(repo, '[x] 01 receipt', [receiptRel]);
  // The run branch moves, so a merge would rebase the ticket; with no suite to run it must refuse before that.
  write(path.join(run, 'c.txt'), 'c\n');
  git(run, 'add', 'c.txt');
  git(run, 'commit', '-qm', 'another ticket landed');
  assert.throws(() => mergeTicket(repo, 'x', '01'), /no suite to run/);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), head, 'the receipt still names the ticket head');
  git(run, 'switch', '-q', '-c', 'elsewhere');
  assert.throws(() => mergeTicket(repo, 'x', '01', { check: 'true' }), /is on elsewhere, not goal\/x/);
});

test('gc keeps every unrecorded worktree while a run\'s worktrees.json is unreadable: one of them may be that run\'s live one', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  const live = worktreeGet(repo, 'x');
  write(path.join(control, 'runs/x/worktrees.json'), '{ not json');
  rawCommit(control, 'fixture: broken records');
  const { items } = gc(repo, { apply: true });
  assert.ok(fs.existsSync(live), 'the live run worktree survives the sweep');
  assert.match(items.find((i) => i.path === live)?.why ?? '', /worktrees\.json is unreadable/);
});

test('worktree get cuts the worktree again after its folder was deleted by hand', () => {
  const { repo } = setup();
  init(repo, 'x', 'X', WHO);
  const first = worktreeGet(repo, 'x');
  fs.rmSync(first, { recursive: true, force: true });
  assert.ok(fs.existsSync(worktreeGet(repo, 'x')), 'never a record that points at a missing folder');
});

test('entry checks: a multi-line objective, an agent id keep-going would ignore, a slug that leaves runs/, a named verdict head, a prose check: line', () => {
  const { repo, control } = setup();
  assert.throws(() => init(repo, 'x', 'X', { agent: 'sess 1', harness: 'h' }), /--agent is a session id/);
  init(repo, 'x', 'X\n\n## NOW\n- stage: 7 build', WHO);
  assert.equal(registry(control)[0].objective, 'X ## NOW - stage: 7 build', 'a multi-paragraph objective is folded to one line');
  assert.equal(next(control, 'x').blocked, undefined, 'and plants no NOW section the run would read as its state');
  assert.throws(() => adopt(repo, 'x', { agent: 'sess 1', harness: 'h' }), /--agent is a session id/);
  assert.throws(() => land(repo, '../../outside'), /bad slug/);
  assert.equal(fs.existsSync(path.join(control, '..', 'outside')), false);
  write(path.join(repo, 'AGENTS.md'), 'Before a commit run the following check:\n- `npm test`\n');
  assert.notEqual(discoverCheck(repo, '').command, '- `npm test`');
  const plain = tmp('hard-plain-');
  assert.throws(() => preflight(plain), /to-auto cannot start:\n- .* is not a git repository/);
});

test('verdict refuses a review whose head is a branch name: it resolves to the tip whatever the reviewer read', () => {
  const { repo, review } = reviewing();
  review('review.md', { verdict: 'ship', head: 'goal/x', open: [] });
  assert.throws(() => verdict(repo, 'x'), /review\.md read goal\/x, but goal\/x is at/);
});

test('run -- keeps a later argument one word: the first is the shell command as written', () => {
  const { repo } = setup();
  const run = (...words) => spawnSync(process.execPath, [GOAL, 'run', '--', ...words], { cwd: repo, encoding: 'utf8' });
  assert.match(run('printf', '%s|', 'a b', "it's", 'c').stdout, /^a b\|it's\|c\|log:/m);
  assert.match(run('printf "%s|" x y').stdout, /^x\|y\|log:/m, 'one argument is still a whole shell command');
  assert.match(run('printf "%s|"', 'x', 'y').stdout, /^x\|y\|log:/m, 'a quoted command followed by plain words runs as before');
});

test('a treehouse return that fails puts the slot back on its branch, since its record stays active', () => {
  const { repo } = setup();
  init(repo, 'x', 'X', WHO);
  const slot = path.join(tmp('hard-slot-'), 'wt');
  const fake = path.join(tmp('hard-th-'), 'treehouse');
  write(fake, `#!/bin/sh\ncase "$1" in\n  get) git worktree add -q --detach '${slot}' HEAD >&2 && echo '${slot}' ;;\n  status) echo '[]' ;;\n  *) echo 'pool is locked' >&2; exit 1 ;;\nesac\n`);
  fs.chmodSync(fake, 0o755);
  process.env.TO_AUTO_TREEHOUSE = fake;
  try {
    worktreeGet(repo, 'x');
    const branch = git(slot, 'rev-parse', '--abbrev-ref', 'HEAD');
    assert.notEqual(branch, 'HEAD');
    assert.throws(() => worktreeReturn(repo, 'x'), /treehouse return .* failed \(exit 1\): pool is locked/);
    assert.equal(git(slot, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
  } finally {
    process.env.TO_AUTO_TREEHOUSE = '';
  }
});

test('the pre-commit hook is written under a temp name of its own: a pre-commit.new another copy left never blocks it', () => {
  const { repo, control } = setup();
  const hooks = path.join(control, '.git', 'hooks');
  fs.rmSync(path.join(hooks, 'pre-commit'));
  fs.mkdirSync(path.join(hooks, 'pre-commit.new'));
  init(repo, 'x', 'X', WHO);
  assert.match(fs.readFileSync(path.join(hooks, 'pre-commit'), 'utf8'), /guard-staged/);
  assert.deepEqual(fs.readdirSync(hooks).filter((f) => /^pre-commit\.\d+\.new$/.test(f)), []);
});

test('a control plane whose first commit fails is not marked initialized: the next call makes that commit', () => {
  const repo = tmp('hard-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  write(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  configure();
  const control = process.env.TO_AUTO_HOME = tmp('hard-state-');
  const hooks = tmp('hard-hooks-');
  write(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
  fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755);
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks });
  try {
    assert.throws(() => ensureControl(repo), /hook says no/);
  } finally {
    for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete process.env[k];
  }
  assert.equal(fs.existsSync(path.join(control, '.to-auto')), false, 'no marker without the commit');
  ensureControl(repo);
  assert.equal(git(control, 'log', '--format=%s'), 'Init to-auto control plane');
});

test('cleanup removes a control plane that holds a read-only folder', () => {
  const { repo, control } = setup();
  const venv = path.join(control, 'cache', 'venv');
  write(path.join(venv, 'lib', 'x.py'), 'x\n');
  fs.chmodSync(path.join(venv, 'lib'), 0o500);
  fs.chmodSync(venv, 0o500);
  try {
    assert.match(cleanup(repo), /^removed /);
  } finally {
    if (fs.existsSync(venv)) for (const d of [venv, path.join(venv, 'lib')]) fs.chmodSync(d, 0o700);
  }
  assert.equal(fs.existsSync(control), false);
});

test('a receipt lists a renamed file under both names: the checker reads the diff without rename folding', () => {
  const { repo } = setup();
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'mv', 'b.txt', 'c.txt');
  git(repo, 'commit', '-qm', 'rename');
  const head = git(repo, 'rev-parse', 'HEAD');
  const about = (changed_files) => checkReceipt({ text: JSON.stringify({ ticket: '01', conclusion: 'partial', ticket_base: base, head, changed_files }), worktree: repo, base }).problems.filter((p) => /changed_files/.test(p));
  assert.match(String(about(['c.txt'])[0]), /differ from git diff --name-only --no-renames/);
  assert.deepEqual(about(['b.txt', 'c.txt']), []);
});
