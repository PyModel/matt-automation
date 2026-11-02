// The mechanics that replaced prose rules: hand-back mode and scripts pin at init, target drift, orphaned tickets, the
// review→fix budget, open decisions, contract drafting and probing, the merger, the verdict writer, sole-writer files,
// registered run logs, and gc of stale runs. Each test builds real git state in temp dirs; nothing touches ~/.local/state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  init, next, tick, pin, take, frontier, prepareTicket, brief, mergeTicket, verdict, setRegistry, checkRun, checkContract,
  checkReceipt, commit, configure, prepare, worktreeGet, runLogged, scriptsPin, ownerDecisions, gc, MAX_BRIEF_BYTES,
  adopt, controlDir, firstStageArgv, gcAll, stateDir,
} from './goal.mjs';

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
function dispatched({ one, two }) {
  const ctx = setup();
  const { repo, control } = ctx;
  init(repo, 'x', 'X', WHO);
  fs.appendFileSync(path.join(control, 'runs/x/log.md'), '- D1 [grill] Q: q? → A: a (source: owner)\n');
  commit(repo, '[x] D1', ['runs/x/log.md']);
  const run = worktreeGet(repo, 'x');
  seedTicket(repo, control, '01-a.md', ticketText('ready-for-agent', 'exclusive: a.txt', `\n${one}`));
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
  const before = git(run, 'rev-parse', 'HEAD');
  assert.throws(() => mergeTicket(repo, 'x', '01', { check: 'false' }), /suite failed on the merged run branch .* stays in flight/);
  assert.equal(git(run, 'rev-parse', 'HEAD'), before, 'a red suite resets the run branch');
  const landed = mergeTicket(repo, 'x', '01', { check: 'true' });
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

test('a registry slug that is not a slug (../..) is never read, so gc cannot delete outside its state folder', () => {
  const { repo, control } = setup();
  init(repo, 'x', 'X', WHO);
  editRegistry(control, (e) => { e.slug = '../..'; e.status = 'done'; });
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

test('paths resolve to their on-disk case, so a state or slot spelled in another case is the same one', () => {
  const plane = path.join(tmp('hard-case-'), 'Plane');
  write(path.join(plane, '.to-auto'), 'to-auto control plane\n');
  assert.equal(stateDir(plane.replace(/Plane$/, 'plane')), plane);
});
