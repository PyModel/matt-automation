# to-auto / matt-automations design flaws (2026-11-02)

Evidence comes from this session: the P1 pythinker-bot run (state `6e023dd72797368c`), archived run 2 (`goal/refine-the-to-auto-skill-and-scripts-goa-final`), and measurements of the repo and the state dir.

| # | Sev | Flaw | Evidence | Fix direction |
|---|---|---|---|---|
| DF1 | H | Nothing detects that the target branch has moved to a different design, so a run can keep building on a base the target has abandoned | Run 2 forked at 9ebd12f on 09-25 while main took e32b905/2268f29 the same day; it built 140 commits on the old `goal/control` design; 16 files conflicted; archived unmerged | `next`/`check` compare the run base with the target and refuse or flag once the target touches the run's claimed paths |
| DF2 | H | The orchestrator is a single point of failure with no liveness check. A ticket can stay `in-flight` with no worker and nobody is told | P1 t13: contract and brief committed, branch with 0 commits, no status file, owner session silent since 11:50. Found by a human. STALE keys on goal.mjs commits, and the brief commit reset the clock | Owner lease with a heartbeat. Flag an `in-flight` ticket with no status file or commit after N minutes |
| DF3 | H | Rules live in prose that is too large to load. Skills read like incident diaries rather than rules | The lifecycle skill is 260 KB with 62 numbered rules full of "on 2026-10-10 … recurred …". The to-auto docs are 187 KB. One ticket brief is 22 KB | Turn rules into goal.mjs refusals. Keep each rule to 1–2 lines and move incident history to CHANGELOG. Hard-cap skill size |
| DF4 | H | Scripts run live from the repo checkout with no pin per run, so editing main changes runs already in flight in other repos | ROOT is resolved from the script path. `check --all` across repos uses the current main | At `init`, record the scripts' sha and refuse or warn on a mismatch, or snapshot the scripts into the state dir |
| DF5 | M | No first-class dispatch or land for subagent workers, so each run hand-writes orchestration scripts | P1 `notes/scripts/{brief.mjs,contract.mjs,dispatch-prep.sh,land.sh}`. land.sh tries `merge --ff-only`, falls back to `--no-ff`, takes no lock and runs no post-merge suite | `goal.mjs prepare-ticket` / `land <NN>` with a lock, a receipt/claims check and a post-merge suite |
| DF6 | M | The stage 8 fix loop has no enforced bound | P1 planned 4 tickets and ended with 13 (05–13 came from review rounds). Run 2 needed fixes A–E plus 2 re-verifies. The cycle cap exists only in prose (run 2's A8 named the PIPELINE contradiction) | Hard cap on review→fix rounds. Remaining findings go to a follow-up run, with the owner told |
| DF7 | M | Orchestrator-written criteria are not checked at freeze | P1 has 5 waivers, e.g. a heredoc decoded the criterion's escapes, and a criterion targeted a seam that stubs the turn owner | `contract --compile` runs each grep/test criterion at the ticket base and refuses on 0 matches or an impossible seam |
| DF8 | M | Owner decisions are scattered and restated by hand in every brief | D1, D3, G1, H1, I1–I3, J1, K1, L1 are spread over ledger.md, bugs.md, the dispatch extras and a Claude memory file. "No-card runs" is still open only in memory | One `decisions.md` per run with ids. The brief generator includes it, and goal.mjs refuses a stage tick while a decision is open |
| DF9 | M | Ticket state has two sources | `tickets/NN.status.md` has no parseable status for 01–12. The real state is `**Status:**` in tracker issues | One state source, with derived views |
| DF10 | M | The integration mode (branch / supervisor / PR) is objective prose, not config | Earlier P1-repo objectives say "committed on main (supervisor mode, --target-branch main)", but P1's objective doesn't, so stage 9 behavior is a guess | Record it at `init` (run 2's B-F7). `next` reads it |
| DF11 | M | Disk and gc: stale runs keep their worktrees forever, and returned pool slots linger | `du` reports 96 GB under `~/.local/state/to-auto`, 73 GB of it in one 37.5 h STALE run. P1 pool/8 is detached and returned but still present. (cp -c clones share blocks, so real usage is lower; unmeasured) | `gc` covers STALE/stopped runs after a grace period. Return a slot means remove it |
| DF12 | M | `final-verdict.json` is hand-written by the orchestrator, and a hand file marks a run done | CLOSE.md stage 8: "Write the verdict … and commit it". Run 2 review B-F2 flagged this. Its fix was lost with the archive | `goal.mjs verdict` writes it from the reviewer's output and re-checks review_head |
| DF13 | M | Verified hardening from run 2 was lost, and several items probably still apply to main | Run 2 review A/B: forgeable grants/control files, forged stage attestations, a forgeable dispatch token, audit reading the working tree (`review-A.md`/`review-B.md` under tag `goal/control-final`) | Re-check each A/B finding against main. Port the ones that still apply as tickets |
| DF14 | L | Control-plane records live only on this Mac | `~/.local/state/to-auto/<hash>`: opaque names, no backup, not in git. Deleting the dir loses every ledger, verdict and retro | Optional export or mirror of finished runs into the repo or a backup. Name dirs `<repo>-<hash>` |
| DF15 | L | Harness coupling: Stop hooks, keep-going marks and to-auto-guard are Claude Code features. pi/opencode get weaker guarantees | Runs 8–9 ran on opencode. The pi default provider is dead. pi needs a separate keep-going extension | One harness-neutral liveness/guard contract. Document what each harness lacks |
| DF16 | L | Skill fragmentation and duplicate copies | 6 to-auto skills archived. Rule sets ship "verbatim beside this file and also installed as standalone skills", so the two copies drift | One copy. Install by link only |
| DF17 | L | Submodule worktrees can't be removed by `git worktree remove` | Hit while archiving run 2. Main dropped the submodule in 226379e, so it only affects old branches | None needed on main. Keep a PITFALLS row |

## Code review of recent main (7dfc2e0..094df6b, 2026-10-17..11-01)

The reviewer ran 157/157 tests green on an isolated copy. Findings by severity (codes R1..R29 are the reviewer's F1..F29):

**P1**
- R1 `goal.mjs:2392`: the gc `tmp/<slug>` delete has no inside-check. A `runs.json` slug of `../..` with status done makes `gc --delete-clean` delete `~/.local/state/to-auto`. The SLUG regex is never applied in `readRegistry`.
- R2 `goal.mjs:2314/2347/2385`: gc reads the registry once and never again. A run that runs `init` + `worktree get`, or `resume`s, during the multi-minute pool sizing has its clean worktree removed. This breaks CONTROL.md's "running run's worktrees never touched".
- R3 `goal.mjs:2282`: "clean" means `git status --porcelain`, which hides ignored files. gc deletes `.env`, local DBs and builds (probed). It also passes `--include-unlanded`, which turns off treehouse's dirty check.
- R4 `goal.mjs:2104-2116`: the HEAD guard watches only the first `worktree list` entry. When the workspace is itself a linked worktree, a rogue slot equal to `$PWD` passes, and `git switch` runs in the user's checkout.

**P2**
- R5 `:2172`: `keepRootHead` throws before the try that returns the lease, so the treehouse slot leaks (probed).
- R6 `:608`: `tick 10` commits done, then `worktreeReturn` can throw. Exit is 3 with no JSON, and a retry gets "already done".
- R7 `:333`: the done gate's dirty check ignores a slot re-leased to another run, so `tick 10` is refused forever.
- R8 `:2380-2390`: the bootstrap temp worktree is in no record, so another run's gc can remove it mid-stage.
- R9 `:2394`: a stopped run keeps `tmp/` but loses its worktrees, so resume points at dead slot paths.
- R10 `matt.mjs:184` + `pull-matt.plist`: an hourly fast-forward of upstream skills, which agents follow as instructions, with no review or pin. This is supply-chain risk, a new upstream skill breaks stage 00 everywhere, and CI clones live main.
- R11 SKILL.md:44 "one version per run" is false now that pulls happen mid-run. `pullVendor` fast-forwards whatever branch is checked out.
- R12 README:37-38: the quick start symlinks the untracked `vendor/`, so it fails. The plists hard-code paths that differ from the README's clone name.

**P3**
- R13 Plain `realpathSync` doesn't normalize case. `worktreeReturn`'s lent lookup misses a slot whose path differs only in case.
- R14 `:2121`: the switch-back result is unchecked, and a HEAD that was already detached is unguarded.
- R15 `gc.log` is uncommitted, not ignored and unbounded.
- R16 A plane without `workspace.json` gets a misleading "repository no longer exists" message.
- R17 `:2372`: a canonical vs non-canonical compare could `rmdir` the pool dir.
- R18 One bad item (git error, bad worktrees.json, broken pool entry, treehouse status failure) aborts the whole gc.
- R19 CLOSE.md stage 10 runs `gc --delete-clean` after every run and destroys free slots, against PIPELINE's "keep build caches". Stage 00 runs `du` over the whole pool.
- R20 `:787`: a run with no `started` gives NaN, so it is never STALE.
- R21 `:1332`: `targetBranch` is ignored when a leftover `goal/<slug>` exists, giving the wrong fork point.
- R22 receipt-lint passes receipts the gate refuses (a validation with no log, a log outside logsDir). Its header misdescribes the cwd. Its test leaks a tmp dir.
- R23 `to-auto-watch.sh:9-13`: nvm resolution mishandles `node`/`stable`/`system` aliases, a partial `24.1`, and a bare `2`.
- R24 `to-auto-watch.sh:34`: trims only after 2000 lines, though the docs say 1000. stderr goes to a replaced file. Node warnings count as new problems.
- R25 `pull-matt.plist` has no StandardErrorPath, so failed pulls are invisible.
- R26 `guards.test.mjs:118`: an assertion that pins nothing.
- R27 Leftover "pin" wording in matt.mjs/matt.test. BOOTSTRAP says `--gc`; the command is `gc`.
- R28 build-dispatch.md and run-budget.md carry run-specific details (Gradle, quota-axi, M4 tickets) in generic docs.
- R29 `ticketsByStatus` silently drops tickets with duplicate numbers.

**Test gaps:** gc races (R2, R8), ignored files (R3), slug traversal (R1), a linked-worktree workspace (R4), a HEAD-moving get (R5), tick 10 with a treehouse slot (R6, R7), pullVendor, gc argument errors.
**Not checked:** to-orc selftest, audit_regressions.py, install/resilience/guard tests, real `treehouse destroy`, plists under launchd.
