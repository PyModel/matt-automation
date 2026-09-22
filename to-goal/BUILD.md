# Build: stage 7, the task graph

Load implement-spec by path and run it as the orchestrator with the bindings below. Read PIPELINE.md § Isolation and § Budgets first. The overall deliverable is diffed against the immutable `review_base` captured at stage 0c in NOW (ensuring diagnosis, fast-path, and planning mutations are all in scope). For per-ticket ranges, record each ticket's starting point `<ticket-base>` upon dispatch; registry `status: building`.

## Bindings to implement-spec

- **Step 2, exploration subagent:** one, writing notes for the whole graph into `.worktrees/control/runs/<slug>/notes/`, external lookups via `research-stack`, spawns nothing.
- **Step 3, branch and PR:** local tracker (default): no PR, the run branch is the integration point. GitHub tracker only: one draft PR closing the spec and every ticket.
- **Step 4, implementers:** one per frontier ticket, each in its own worktree and branch (PIPELINE.md § Isolation), dispatched only while the concurrency cap allows and `STOP` is absent. Take tickets with `node ROOT/scripts/goal.mjs take <feature> <free slots>`: it reads the frontier and flips the tickets to `in-flight` in one locked transaction, so two orchestrators never take one ticket. Parallel only when claims are disjoint (stage 6b guarantees this for `ready` tickets). Record each dispatch in NOW and Events.
- **Step 5, merger subagent:** per returned ticket, as one `goal.mjs with-lock integration -- <merge script>` transaction: rebase the ticket branch onto the run head; for `shared-regenerate` conflicts run the regenerate command and take the result; other conflicts → `resolving-merge-conflicts`, and when any conflict was resolved re-run the suite and a single-agent review of the resolved hunks before merging. Then `merge --ff-only`, record the ticket as the range `<before>..<after>` on the run branch (pre-rebase SHAs in status files are historical only), remove the worktree and branch. Before merging, run `node ROOT/scripts/goal.mjs claims <ticket path> $(git diff --name-only <ticket-base>...HEAD)`: a nonzero exit (an `unclaimed` path, or a `guarded` path without an explicit grant) is a **claims breach**: the merger rejects the ticket, the orchestrator logs it, and either re-dispatches with the claim added (if no other ticket claims that path) or splits the offending change into a new ticket.
- **Step 6, frontier:** after every merge the orchestrator ticks the ticket, runs `goal.mjs status <feature> <id> done`, updates `todo.md` and the ledger and commits them with `goal.mjs commit`, and in flat mode runs `code-review` for that ticket's range `<ticket-base>...HEAD` itself; then `goal.mjs take` again for the freed slots and dispatches what it returns.
- **Step 7, single fix subagent:** used in CLOSE.md stage 8, not here.
- **Step 9, cleanup:** every ticket worktree is removed at merge; a sweep at the end of stage 7 confirms only the run worktree remains.

## The implementer brief

Context pointers only: ticket path, spec path, `CONTEXT.md`, notes dir, worktree path, run branch, `ledger.md`, its `tickets/<NN>.status.md` if it exists, the `commands:`, `per-worktree:` (with this ticket's NN and the run_id substituted), `quarantine:` and `nested:` values from NOW. Plus, verbatim: the implement file's contents, the ticket's seams and defensive tier, the ticket's claims, the guards from PITFALLS.md, the subagent contract from LEDGER.md, and this list of rules:

1. Apply the per-worktree recipe (ports, `.env`, data dir), run the install command, run the single test file for the seam before touching code.
2. For every slice call `tdd`: one failing test at a pre-agreed seam, watch it fail, minimal code, watch it pass; typecheck and run the single test file after each slice; browser tests after behaviour works. No test at an unagreed seam.
3. Call `defensive-design` in Implement mode for the ticket's tier: its required tests and an evidence state per control (verified / reasoned_not_run / blocked / not_applicable) written into the status file.
4. A red test that will not go green for a reason the ticket did not predict → `diagnosing-bugs` before changing course. The same non-quarantined test failing 5 times, or slice 12 reached, or 90 minutes elapsed → stop, mark the ticket `stuck` in the status file with the reason and the loop output, return. Check `runs/<slug>/STOP` before every slice; present → finish the slice, commit, return `stopped`.
5. Touch only claimed paths. A needed change outside the claims → stop the slice, record the path and why in the status file, return `claims breach`.
6. Run the full suite once at the end; compare per test id against the baseline set (quarantined tests ignored): no test that passed at base may fail now. Commit with `Refs <ticket id>`. In `nested: yes` mode call `code-review` against `<ticket-base>...HEAD` (the whole ticket range, not just the last commit) with the ticket path as spec; in flat mode do one inline pass over the full ticket diff on both axes yourself. Fix cited findings; verify each fix against the ticket seam before merge; uncited leads go in the status file.
7. Human-only step → `wizard`, script path returned as a blocker. Bug noticed anywhere → § Bugs found in flight.
8. Heartbeat: update `tickets/<NN>.status.md` before and after every slice and before any command expected to run longer than a minute (install, suite) with `heartbeat: <time>`, `agent: <id or pid>`, `active_cmd: <name if active>`, `slice: n/m`, last commit, suite result; commit the status file with `goal.mjs commit`. Redact secrets first. Spawn no agents; load only `tdd`, `defensive-design`, `diagnosing-bugs`, `code-review`, `wizard`, by path (SKILL.md § Loading skills).
9. Return only: commit hash, suite result, cited review findings fixed, leads, blockers, or `stuck` / `claims breach` with the reason.

## Stuck detection

Separate heartbeat liveness, active command execution, and completed-slice progress. A dispatched ticket is **stuck** when any of: its `heartbeat` is older than 30 minutes and its `agent` is not alive; its `slice` counter is unchanged across 3 heartbeats while NO command is actively running; its status file reports the same non-quarantined test failing 5 times; slice 12 or 90 minutes reached; or the harness reports the agent gone. Before any re-dispatch: explicitly revoke the old lease, send cancellation (SIGTERM, then SIGKILL if needed), and wait for confirmed process termination so two writers never share a worktree. Stuck once → record, re-dispatch from the status file with the failure appended to the brief. Stuck twice → mark `stuck` in `todo.md` with the reason, do not re-dispatch; mark dependent tickets `blocked: prerequisite <id> stuck`; continue the rest of the graph; it is a blocker in the report. Never a third dispatch.

## Budgets in this stage

From PIPELINE.md § Budgets: dispatch only while `active < max_concurrent_tickets` and `agents_spawned < max_agents`; a ticket that hits the slice or per-ticket wall-clock cap is `stuck: too big` (the lever is upstream: it should have been split). Wall-clock exceeded → finish running slices, write the ledger, end with the report.

## Bugs found in flight

No deferred actions. Any bug, error, or anomaly noticed in any file, by any agent, at any stage:

1. **Record now:** `bugs.md` and a `[bug]` event: file, symptom, how noticed, introduced by this run or pre-existing.
2. **In scope or introduced by this run** (touches a claimed path, or was not present at the branch point): fix now, red regression test first, same ticket branch; `diagnosing-bugs` if the cause is not obvious.
3. **Pre-existing and out of scope:** open a ticket now (`bug`, `ready-for-agent`, repro, claims). Ask `/kun` whether this run builds it; yes and the ticket budget allows → it passes the PLAN.md 6b gate (claims intersected against every open and in-flight ticket) and then joins the frontier; otherwise it stays ticketed for the next run with its id in the report. Either way it is never a comment, TODO, or "known issue".
4. **Cannot be fixed by this run** (authority, credentials, human-only): blocker in NOW and the report, with the ticket id.

`TODO`, `FIXME`, `HACK`, "temporary", swallowed exceptions, and disabled tests are prohibited in the diff; `code-review` cites them and the Build criterion greps for them.

Done when every ticket is `merged` or `stuck` (with reason), the suite on the run branch is no worse than baseline, and only the run worktree remains.
