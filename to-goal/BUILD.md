# Build: stage 7, the task graph

Load implement-spec by path and run it as the orchestrator with the bindings below. Read PIPELINE.md § Isolation and § Budgets first. `node ROOT/scripts/goal.mjs registry <slug> building`. Record each ticket's starting point `<ticket-base>` on dispatch; the whole deliverable is diffed against `review_base` (BOOTSTRAP.md § 0c). Done per PIPELINE.md § Completion criteria per stage (7).

## Bindings to implement-spec

- **Step 2, exploration subagent:** one, writing notes for the whole graph into `.worktrees/control/runs/<slug>/notes/`, external lookups via `research-stack`.
- **Step 3, branch and PR:** local tracker (default): no PR, the run branch is the integration point. GitHub tracker, push authorized: one draft PR closing the spec and every ticket.
- **Step 4, implementers:** one per frontier ticket, each in its own worktree and branch (PIPELINE.md § Isolation), dispatched only while the budgets allow (PIPELINE.md § Budgets) and `STOP` is absent. Local tracker: take tickets with `node ROOT/scripts/goal.mjs take <feature> <free slots>`, which reads the frontier and flips the tickets to `in-flight` in one locked transaction, so two orchestrators never take one ticket. GitHub tracker: read the frontier and set the issue's status inside `goal.mjs with-lock frontier-<feature> -- <gh commands>`. Parallel only when claims are disjoint (stage 6b guarantees this for `ready-for-agent` tickets). Record each dispatch in NOW and Events.
- **Step 5, merger subagent:** per ticket back from its implementer, as one `goal.mjs with-lock integration -- <merge script>` transaction:
  1. `node ROOT/scripts/goal.mjs claims <ticket file> $(git diff --name-only <ticket-base>...HEAD)` (on a GitHub tracker, the ticket file is the issue body saved with `gh issue view <n> --json body -q .body`). A nonzero exit (an `unclaimed` path, or a `guarded` path without an explicit grant) is a **claims breach**: the merger rejects the ticket, the orchestrator logs it, and either re-dispatches with the claim added (if no other ticket claims that path) or splits the offending change into a new ticket.
  2. Rebase the ticket branch onto the run head; for `shared-regenerate` conflicts run the regenerate command and take the result; other conflicts → `resolving-merge-conflicts` (never `--abort`), then re-run the suite and a single-agent review of the resolved hunks.
  3. `merge --ff-only`, record the ticket as the range `<before>..<after>` on the run branch (pre-rebase SHAs in status files are historical only), remove the worktree and branch.
- **Step 6, frontier:** after every merge the orchestrator ticks the ticket's acceptance boxes, sets it done (`goal.mjs status <feature> <id> done` on the local tracker; the issue's status on GitHub), updates `todo.md` and the ledger and commits them with `goal.mjs commit`, and in flat mode runs `code-review` for that ticket's range `<ticket-base>...HEAD` itself; then takes tickets again for the freed slots.
- **Step 7, single fix subagent:** used in CLOSE.md stage 8, not here.
- **Step 9, cleanup:** every ticket worktree is removed at merge; a sweep at the end of stage 7 confirms only the run worktree remains.

## The implementer brief

Context pointers only: ticket path, spec path, `CONTEXT.md`, notes dir, worktree path, run branch, `ledger.md`, its `tickets/<NN>.status.md` if it exists, and from NOW the `commands:`, `per-worktree:` (with this ticket's NN and the run_id substituted), `quarantine:`, `nested:` values and the per-ticket caps from `budgets:`. Plus, verbatim: the implement file's contents, the ticket's title (restate it before building), seams, defensive tier and claims, the guards from PITFALLS.md, this list of rules, and LEDGER.md § Subagent contract last.

1. Apply the per-worktree recipe (ports, `.env`, data dir), run the install command, run the single test file for the seam before touching code.
2. For every slice call `tdd`: one failing test at a pre-agreed seam, watch it fail, minimal code, watch it pass; typecheck and run the single test file after each slice; browser tests only after the behaviour works. No test at an unagreed seam.
3. Call `defensive-design` in Implement mode for the ticket's tier: its required tests and an evidence state per control (verified / reasoned_not_run / blocked / not_applicable) written into the status file.
4. A red test that will not go green for a reason the ticket did not predict → `diagnosing-bugs` before changing course. The same non-quarantined test failing 5 times, or the per-ticket slice or time cap reached → stop, mark the ticket `stuck` in the status file with the reason and the loop output, return. Check `runs/<slug>/STOP` before every slice; present → finish the slice, commit, return `stopped`.
5. Touch only claimed paths. A needed change outside the claims → stop the slice, record the path and why in the status file, return `claims breach`.
6. Run the full suite once at the end; compare per test id against the baseline set (quarantined tests ignored): no test that passed at base may fail now. Commit with `Refs <ticket id>`, then review: in `nested: yes` mode call `code-review` against `<ticket-base>...HEAD` (the whole ticket range) with the ticket path as spec; in flat mode do one inline pass over the full ticket diff on both axes yourself. Fix cited findings; verify each fix against the ticket seam; uncited leads go in the status file.
7. Human-only step → `wizard`, script path returned as a blocker.
8. Heartbeat: update `tickets/<NN>.status.md` before and after every slice and before any command expected to run longer than a minute (install, suite) with `heartbeat: <time>`, `agent: <id or pid>`, `active_cmd: <name if active>`, `slice: n/m`, last commit, suite result; commit it with `goal.mjs commit`. Skills you may load: `tdd`, `defensive-design`, `diagnosing-bugs`, `code-review` (nested mode only), `wizard`.

## Implementer backend

NOW's `worker:` picks who runs the implementer brief. Default `subagent`: the harness's own subagent, as above. `pi[/<provider>/<model>]` (named in the objective or answered by `/kun`): each ticket's brief goes to a pi worker through to-orc's dispatcher, which proves the model that ran and bounds the ticket by its cycle and cost caps:

```
d=$(git rev-parse --path-format=absolute --git-common-dir)/to-orc/<slug>/t<NN>   # outside every worktree
node ROOT/to-orc/scripts/orc-dispatch.mjs --phase implement --task impl --background \
  --brief <brief file> --run-dir "$d" --repo .worktrees/goal-<slug>-t<NN> [--model <provider>/<model>]
```

Before the first dispatch write `$d/accepted/scout.md` and `$d/accepted/research.md` citing `findings.md`, `spec.md` and the notes dir: stages 1–5 did that work. Poll with `--poll --task impl --run-dir "$d"`. `COMPLIANT` hands the ticket branch to the merger as usual; any other `orcStatus` is a stuck signal for § Stuck detection, with the status file's `reason` appended to the re-dispatch brief. One run directory per ticket, so the worker, cycles and budget are per ticket.

## Stuck detection

Separate heartbeat liveness, active command execution, and completed-slice progress. A dispatched ticket is **stuck** when any of: its `heartbeat` is older than 30 minutes and its `agent` is not alive; its `slice` counter is unchanged across 3 heartbeats while no command is running; its status file reports the same non-quarantined test failing 5 times; the per-ticket slice or wall-clock cap in NOW `budgets:` is reached (`stuck: too big`, the lever is upstream: it should have been split); or the harness reports the agent gone.

Before any re-dispatch: revoke the old lease, send cancellation (SIGTERM, then SIGKILL if needed), and wait for confirmed process termination so two writers never share a worktree. Stuck once → record, re-dispatch from the status file with the failure appended to the brief. Stuck twice (the re-dispatch budget) → mark `stuck` in `todo.md` with the reason; mark dependent tickets `blocked: prerequisite <id> stuck`; continue the rest of the graph; it is a blocker in the report. Never a third dispatch.

## Bugs found in flight

No deferred actions. Any bug, error, or anomaly noticed in any file, by any agent, at any stage:

1. **Record now:** `bugs.md` and a `[bug]` event: file, symptom, how noticed, introduced by this run or pre-existing.
2. **In scope or introduced by this run** (touches a claimed path, or was not present at the branch point): fix now, red regression test first, same ticket branch; `diagnosing-bugs` if the cause is not obvious.
3. **Pre-existing and out of scope:** open a ticket now (`bug`, `ready-for-agent`, repro, claims). Ask `/kun` whether this run builds it; yes and the bug-ticket budget allows → it passes the PLAN.md 6b gate and then joins the frontier; otherwise it stays ticketed for the next run with its id in the report. Either way it is never a comment, TODO, or "known issue".
4. **Cannot be fixed by this run** (authority, credentials, human-only): blocker in NOW and the report, with the ticket id.

Debt markers, temporary workarounds, swallowed exceptions, and disabled or focused tests are prohibited in the diff; `code-review` cites them. The mechanical part is this grep, over added lines only so that deleting old markers succeeds; it must be empty:

```
git diff -U0 <review_base>...HEAD | grep '^+' | grep -v '^+++' | grep -nE 'TODO|FIXME|HACK|XXX|\.skip\(|\.only\(|\bxit\(|\bxdescribe\('
```
