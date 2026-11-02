---
name: to-auto-ticket-lifecycle
description: Use when to-auto goal.mjs refuses a move; before `take` or `status … in-flight` (take's n is a count); on claims-breach, STALE, SCRIPTS_MOVED, TARGET_DIVERGED or TICKET_IDLE; when a Stop hook or keep-going (to-auto or done-means-done, "authorized work remains") blocks ending a turn on a running worker or wait; when resuming or adopting a run after a dead session or re-dispatching after a worker died; when merging/landing a ticket or a test flakes during landing; when contract or worktree calls fail; when a run budget changes; or when a grilling round uses kun answerers or challengers.
category: agent-orchestration
---

# to-auto goal.mjs: ticket state rules

goal.mjs enforces the file rules; this covers order, judgment and each refusal's fix. Run `goal.mjs` alone first; use only the subcommands it lists.

## Calling goal.mjs

- Define `g(){ node <ROOT>/scripts/goal.mjs "$@"; }`; zsh does not word-split `$G` or `$LIST` (use arrays: `P=(a b); g claim … "${P[@]}"`).
- Run goal.mjs from the project checkout, one state change per tool call; never after a `cd` into the state dir, never piped (`tail`/`grep` hide refusals).
- After a refusal mid-chain, check what already applied; rerun only the refused step.
- Every control-plane write goes through `goal.mjs commit -m "[<slug>] <why>" <files>`; uncommitted run files block `status`, `claim`, `waive`, `tick`. Commit them first.
- Write files with a quoted heredoc (`<<'EOF'`), values via env/argv; `grep -F` backslash escapes after.
- `runs.json` is written only by goal.mjs; `tick` is the only writer of stage ticks and NOW's stage line; the tracker `**Status:**` only by `take`/`status`. Never hand-edit or `sed` them.
- On `NOW_AHEAD`/`TODO_BEHIND`/`TODO_AHEAD`, trust the registry stage `next` reports and `tick` each finished stage in order.

## Drafting and claims (before `take`)

- Split a unit that mixes owner-gated and fork-free work: the free part is `ready-for-agent`, the gated part `blocked: owner Q<n>`.
- Claim every file the change can make false: conformers, fakes and mocks of changed methods (grep `def <method>(`), tests pinning old values/markup/labels, snapshots and manifests (`shared-regenerate`), barrels, composition roots, the owning file archlint allows.
- `test -e` every claimed path; `ls` numbered dirs (ADR, migration) for the next free number.
- Overlapping exclusive claims need a `**Blocked by:**` edge; `frontier` must show `malformed: []` and `conflicts: []` before `take`.
- Criteria are `- [ ]` lines, one per fact, no case-only twins. Write measurable facts or exact values, not floors that a system style overshoots.
- Write "0 matches" as `test "$(grep -c PAT f)" = 0`; code patterns as `git grep -nF`; `-nP` for `\b`; `-e` for patterns starting with `-`; scope greps to claimed files.
- `contract` probes simple grep/rg criteria at base (erroring → refused; 0 match → refused unless "(Red at base…)" or about absence). It skips commands with `; & < > $(` or backticks: check those by hand. A needle already matching at base proves nothing.
- Runtime/UI criteria: probe at base with throwaway tests, then revert to a clean worktree.
- Criteria the host cannot run (device, live system) are `blocked: host`, never a waiver.
- Before `take`, check for a parallel copy: `git worktree list`, `git branch --list '*<id>*'`, open PRs.

## Ticket moves

- Moves: `blocked`→`ready-for-agent|stuck`; `ready-for-agent`→`in-flight|blocked|stuck`; `in-flight`→`done|stuck|needs-human`; `needs-human`→`in-flight|stuck`; `stuck`→`ready-for-agent|blocked`.
- New tickets enter only as `ready-for-agent` or `blocked`. Only `stuck`, `needs-human`, `blocked` take `-- <reason>`.
- `take <slug> <n>` takes n frontier tickets, lowest id first; read the ids it prints. For one chosen ticket use `status <slug> <NN> in-flight`.
- In-flight means taken, not dispatched: report it queued until it has a worker and a `goal/<slug>-tNN` branch.
- After each landing, flip every dependent whose blockers are all `done` with `status … ready-for-agent` at once; a `stuck` id on a blocker line never unblocks: swap in its finished deps.
- Implementer back `blocked` on an owner: commit its message as the receipt, then `needs-human -- <what passed, what the owner must do, link>`.
- Park a superseded ticket `blocked -- "parked by <decision>"`; before `tick 7`, move it `stuck` with that reason.
- `log.md` `- D<n> (open) [stage] Q: …` blocks every tick until rewritten `- D<n> [stage] Q: … → A: … (source: owner|kun)`. Put owner questions to the named stand-in (kun) first, from files.

## Dispatch

- Owner order: no pi or Grok worker unless the owner names one in the objective.

- For an in-flight ticket, `goal.mjs prepare-ticket <slug> <NN>` gets the worktree and drafts `tickets/<NN>.goal.md`. Write only its `<fill: …>` fields, then `goal.mjs commit` it; never hand-type a base sha, claims or criteria.
- `contract` must print `ok: true` before every dispatch. On "criteria changed since dispatch", `git checkout --` the ticket file.
- `goal.mjs brief <slug> <NN>` builds the implementer brief; never hand-assemble one. Add only a re-dispatch section (dead pid, finished work, failure).
- TaskStop superseded agents before a wave; never retry a refused subagent spawn unchanged.
- SCRIPTS_MOVED: read the scripts' log and CHANGELOG, then `goal.mjs pin <slug>` or `stop`.
- TARGET_DIVERGED: merge the target into the run branch in the run worktree; `take` refuses until then.
- A timed GPU ticket holds the machine: no compiles or suites elsewhere until its marker clears.
- Owner adds a rule or changes a gate mid-run: commit it (project instructions, `notes/brief-common.md`, undispatched tickets), then SendMessage every live implementer.

## Waiting and Stop hooks

- Nothing resumes a turn by itself. While a run is `planning` or `building`, a turn ending on a status line, a Monitor, or a background launch is refused.
- Hold the turn with a foreground poll that exits only when `RUNNING` clears (never on a slice change), each call under ~540 s; reissue it, then `goal.mjs next`.
- `test -f` the status file before polling it; if absent, read `git -C <wt> log <base>..HEAD` and `ps`.
- Progress goes to a Monitor on the status file's mtime; re-arm it at each dispatch and on expiry; stop it when the ticket is terminal.
- A loop cap hit while RUNNING is not a result; stalled means terminal status or a dead pid.
- Background agents (kun answerers, challengers, reviewers) finish only via task-notification; prep meanwhile.
- A notification whose result is a "waiting" line with no json block is interim: do not save or land it.
- Answer stop-point questions, then keep building; `goal.mjs stop` only after the owner confirms a named boundary.
- Owner "pause" is not a stop: no new dispatch/landing/gate, tell workers to write state and end, log it.
- Done-means-done asks: keep state-dir writes, `goal.mjs run` and settings reads in separate calls. Rerun stale dmd checks once their candidate is stable.
- A peer hold ends on the peer's answer or low `uptime`, not a clock: ask.
- After a dispatch, landing or wake-up, reply in one line: ticket, slice, next wait.

## Receipts, waivers, claims-breach

- Only the implementer writes a receipt. Save its final message by script from the output JSONL (never the HTML-escaped notification, never cat the transcript), commit it, never edit it.
- Any receipt refusal (shape, sha, log pairing, criterion text) goes back to the same worker: "resend with only <fields> fixed; no other work", quoting every problem.
- Validation logs count only if `goal.mjs run` recorded them; pass the command as one quoted string. Never run a worker's validation and splice it in.
- Builder stopped, killed or crashed with no receipt: resume it, or dispatch a finish worker into its worktree. Never write the receipt yourself.
- An API error (529) is not a failure: SendMessage the same agent to continue.
- `partial` does not land. Waive (once per ticket, in-flight, after the receipt is committed) only with proof the intent holds at the receipt head, or `--carried-to` an open ticket holding the criterion verbatim. Two unmeetable criteria → re-plan, not waive.
- Report every waived criterion first at landing: not proven here, carried to tNN.
- Claims-breach: save the receipt, grep every consumer of the touched symbol, one `goal.mjs claim … exclusive <all paths>` (two amendments max; a third → `stuck`, split). Confirm `claims <ticket> <paths>` prints `"unclaimed": []` before the resume message.
- A claim overlap refusal: add a blocking edge (or split), then rerun `claim`.
- Fix-ticket budget: one per planned ticket (min 2); `frontier` marks excess malformed. Close it `status … stuck -- fix budget spent`, findings to NOW `leads:`.
- Review findings never enter a dispatched ticket: fold into an undispatched one or file a fix ticket with `**From review:** NN` (an existing ticket).

## Landing

- Land only with `goal.mjs merge <slug> <NN> [--check <cmd>]`; never write land.sh or merge scripts. It checks the committed receipt and claims, rebases, ff-merges, runs the suite, sets done, returns the worktree, deletes the branch.
- Refusals: rebase conflict → resolve per BUILD.md § Merge conflicts, fresh receipt, merge again; rebase changed the change → fresh receipt; red suite → run branch reset, ticket stays in flight.
- Never `worktree return` or delete a branch while a `goal.mjs run` is live in it.
- Flake at landing: introduced by this run until it fails at the run base under the same full-suite load and run count. Never quarantine, skip, or lengthen a sleep: fix it now per BUILD.md § Bugs found in flight (deterministic red test, N clean full-suite runs).
- After landing: close each routed `bugs.md` entry `fixed in tNN @ <sha>` (every entry needs a Status line before any tick), SendMessage siblings any shared shape change, re-check the frontier.
- If the owner wants local main to follow, ff-only it to the run head after each landing; report the range.
- Set a tracker issue Done only if the merged diff covers its whole fix list; the rest gets a ticket.

## Recovery after a dead session

- After compaction, reboot or session death, the first call is `goal.mjs next <slug>`; act on its `warnings`. Summaries are leads, never status. Read each live ticket's status file and branch log before any claim or dispatch.
- STALE: the owner session resumes, else `goal.mjs adopt`, else `stop`. Adopt and log an `event` before any dispatch.
- TICKET_IDLE: kill the recorded pid, re-dispatch per BUILD.md § Stuck detection, or mark `stuck`. Never a third stuck dispatch.
- A dead worker's branch is the truth: read it before re-dispatch; reconcile its untracked files via tdd.
- A dispatch whose result was lost may not have launched: check `orc-status.json`.
- STATUS_COPY: remove the status line from `tickets/NN.status.md`; the tracker is the only state.
- Idle time counts against the budget: check the clock before dispatch; never raise it yourself.
- A `stopped` run is paused: gc and cleanup skip it; resume with `goal.mjs resume`. Never run `goal.mjs cleanup` unasked.

## Stage 8

- One review subagent with a shell; commit its message as `runs/<slug>/review.md`; one fix pass, one re-verify to `verify.md`, both ending `{ "verdict", "head", "open" }`.
- `goal.mjs verdict <slug>` writes `final-verdict.json`; a hand-written one is refused. A third rewrite of `verify.md` is refused: `goal.mjs stop` and carry findings to a follow-up run.
- Stage 9 hand-back follows the `mode` from `next` (set by `init --mode`), never the objective's prose.

## Delegated rules

- Build dispatch and claims: [build-dispatch.md](../to-auto/references/build-dispatch.md)
- Run budget and stop conditions: [run-budget.md](../to-auto/references/run-budget.md)
- Grilling rounds: [grilling-rounds.md](../to-auto/references/grilling-rounds.md)
