# Fix the to-auto design flaws (tasks/design-flaws.md)

Branch `df-fixes`, built in a separate worktree so the live P1 run (pythinker-bot, `reviewing`) kept running main's scripts.

- [x] DF1 target drift: `check` TARGET_DIVERGED (target changed files the run changed or an open ticket claims, since the merge base); `take` refuses; merging the target in clears it. `init` records `target`.
- [x] DF2 orphaned tickets: `check` TICKET_IDLE when an in-flight ticket has no branch commit, heartbeat, to-orc status or ticket commit for 30 min (`--idle-minutes`). Independent of the run-level STALE clock.
- [x] DF3 rule size: lifecycle skill distilled into `to-auto-ticket-lifecycle/SKILL.md` (≤ 12 KB, in-repo, linked by install.mjs); build-dispatch.md and run-budget.md rewritten as rules; size caps in goal-docs.test.mjs; brief size capped in goal.mjs.
- [x] DF4 scripts pin: `init` records `scripts` (hash over the pinned scripts' bytes + ROOT HEAD); `check`/`next` SCRIPTS_MOVED; `goal.mjs pin <slug>` accepts.
- [x] DF5 first-class dispatch and land: `prepare-ticket`, `brief`, `merge` (receipt + claims + rebase + ff + suite + done + return, under `integration`).
- [x] DF6 fix-loop bound: fix tickets ≤ one per planned ticket (min 2), enforced in `frontier`/`take`; stage 8 bounded by `verdict` (≤ 2 verify rounds).
- [x] DF7 criteria checked at freeze: `contract` refuses `<fill:>` and probes backticked grep criteria at the base.
- [x] DF8 decisions: log.md `D<n>` ids; `(open)` blocks every tick; owner decisions copied into each drafted contract.
- [x] DF9 one state source: STATUS_COPY flags a status line in an open ticket's flight record; LEDGER.md says the tracker owns status.
- [x] DF10 mode is config: `init --mode branch|supervisor|pr`; `next` returns `mode`/`target`; CLOSE.md stage 9 reads it.
- [x] DF11 gc: runs with no commit for 72 h (`--stale-hours`) give back clean worktrees and slots.
- [x] DF12 verdict: `goal.mjs verdict` is the sole writer of final-verdict.json, from committed review.md / verify.md; done needs `written_by`.
- [x] DF13 run 2 hardening re-checked on main; still-live items fixed: commit path-spelling bypass, runs.json field forgery, working-tree gate read, hand-written verdict, forgeable run logs (logs.txt), to-orc `--force` cycle reset, recordModel race, stale audit hashes, duplicate helpers.
- [ ] DF14 backup: dropped (owner: "no backup needed").
- [x] DF15 harness matrix in PIPELINE.md § Under a loop.
- [x] DF16 one copy per rule set: SKILL.md § Rule skills links the repo files; lifecycle skill lives in the repo.
- [x] DF17 PITFALLS row for submodule worktrees.

## Review

- Merge to main is held until P1 no longer depends on the old rules (see final report).
- Install step after merge: link `~/.agents/skills/to-auto-ticket-lifecycle` and the `~/.claude` copy's SKILL.md to the repo file (the `~/.claude` folder keeps autoharness's metadata).
- Blind review of the goal.mjs/orc-dispatch diff found 8 defects plus 4 lower ones; fixed with a red-then-green test each (hardening.test.mjs, to-orc selftest): forced to-orc re-dispatch still reset the cap (evidence now kept under superseded/), `run` committed forged logs.txt lines, `merge` left a landed ticket in flight when done failed and reset with --hard over owner edits, init/pin/adopt committed hand edits to runs.json, the contract probe ran criteria through a shell, older supervisor runs got a false TARGET_DIVERGED, sole-writer deletions committed, clone worktrees missed their state, TICKET_IDLE missed to-orc in cloned mode. Not fixed (design limit): an orchestrator can still write review.md itself before `verdict`.
- Main review R1–R29 (added to design-flaws.md 12:22): fixed R1, R2, R4–R8, R12–R18, R20–R29 with tests where logic changed (R21 and R7 covered by the shared code path, no dedicated test). Not code defects: R3 (ignored files in a run worktree are the run's own; documented in CONTROL.md), R9 (by design; remedies added to the refusals), R10 (owner direction 2026-10-20: track upstream main), R11 (doc made truthful: the hourly pull can move skills mid-run), R19 (destroying free slots after a run is a disk-vs-cache tradeoff; gc now sizes only what it removes).
- Owner order made mechanical: to-orc refuses a first dispatch that names no worker; a reviewer's repro had run one real pi worker on pi's default (xai/grok-4.7).
- Owner decisions 2026-11-02: D1 lifecycle skill linked (both installs → repo folder; old copies in ~/.local/state/skill-backups/2026-11-02/), D2 pulls hold while a run is live (goal.mjs liveRuns, matt.mjs pull, pull-matt.sh), D3 gc keeps free pool slots (`--slots` to destroy).
- 2026-11-02 follow-up: lifecycle skill untracked and gitignored (autoharness owns it; its 100 KB limit vs the 12 KB cap would have turned npm test red). The installs still link the local folder.
