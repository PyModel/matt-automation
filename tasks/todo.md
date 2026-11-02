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
