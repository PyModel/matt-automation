# Phases, gates, re-entry, and termination

Five dispatch phases, strictly sequential: `scout` → `research` → `implement` → `verify`, with `repair` looping back to `verify`. The dispatcher refuses a phase whose predecessor has not been accepted, so the order is enforced, not remembered.

## Ledger

Create `<run-dir>/ledger.md` before the first dispatch and update it after every dispatch and every acceptance decision:

```markdown
# to-orc ledger — <task-id>
task: <one-line objective>
repo: <path>   baseline: <sha from the scout dispatch>
config: pi · <worker.model from run.json>
budget: <--max-cost, or "none"> · spent: see spend.json

| phase | flag | task id | orcStatus | session | accepted |
|---|---|---|---|---|---|
| scout      | false | | | | |
| research   | false | | | | |
| implement  | false | | | | |
| verify     | false | | | | |

## Assumptions
## Deviations
## Issues
## Diff identifier
implement: head=<sha> worktreeDiffSha=<sha>
verify:    head=<sha> worktreeDiffSha=<sha>   ← must match the line above
```

A flag flips to `true` when the phase's exit gate is met — *completed*, not necessarily *passed* (VERDICT.md § Verdict rules).

## Accepting a phase

Acceptance is your judgment and your only gate key. When a phase's exit gate is met, write `<run-dir>/accepted/<phase>.md` containing what you accepted and why — the deliverables, the evidence you relied on, and any assumption you are carrying forward. The next phase cannot be dispatched until that file exists and is non-empty.

Never write an acceptance file to unblock yourself. If the gate is not met, send a targeted follow-up instead.

## Re-entry

The run directory is the state. On any entry that is not the first — a resumed session, a compacted context, a crashed run — reconstruct before dispatching anything:

1. Read `ledger.md`, then every `<task>/orc-status.json`, then `accepted/*.md`, then `spend.json`.
2. If any `orc-status.json` still says `RUNNING`, that dispatch is either still running or died. Poll it (`--poll`); do not re-dispatch the same task id.
3. Resume at the first phase whose predecessor is accepted and which has no `COMPLIANT` dispatch of its own.
4. Rewrite the ledger to match what the status files actually say before continuing. Where they disagree, the status files win.

## Phase 1 — `scout` (no writes)

Delegate: repository discovery, architecture map, dependency inspection, project-instruction discovery (`CLAUDE.md`/`AGENTS.md`/contributing docs), and the locations of relevant code, tests, build commands, and CI checks.

Require: baseline revision, existing uncommitted changes, the likely change boundary, and — where evidence permits — which failures are pre-existing rather than task-related. Require a proposed validation strategy naming the repo's real commands.

**Exit gate:** an evidence-backed repository map with concrete paths, baseline state, dependencies, and a validation strategy. Reject vague inventories with no file references. Record the baseline revision from `changeSet.headBefore`, not from the worker's prose.

If `changeSet.verified` is `false` (DELEGATION.md § The change set), there is no baseline, diff identifier, or write gate for the whole run. Decide explicitly — proceed in a documented degraded mode where every "nothing else changed" claim is an unknown, or stop and report `FAIL` if the task needs a verifiable change set.

## Phase 2 — `research` (no writes)

Delegate: root-cause analysis, reproduction where practical, architecture trade-offs, and an implementation plan grounded in the inspected code. External technical claims need primary sources; do not require external research when repository evidence suffices.

The plan must define:

- exact intended behavior, affected components, dependencies;
- acceptance criteria and the relevant unit, integration, regression, and security checks;
- observability requirements for changed behavior;
- migration, compatibility, rollout, and rollback requirements — or an explicit reason each does not apply;
- risks, assumptions, unresolved questions.

**Exit gate:** a bounded, testable plan whose evidence supports implementation. Do not proceed while a material root cause, permission requirement, or acceptance criterion is unresolved — send a targeted follow-up instead.

## Phase 3 — `implement` (writes allowed, background it)

Delegate **only the accepted plan**. Require minimal, reviewable changes; tests and documentation appropriate to the change; preservation of unrelated work; no commits; and explicit reporting of any newly discovered defect.

Workers must report a required scope change before making it. A material design change sends the work back to `research` for a revised plan before implementation continues.

**Exit gate:** a report identifying the actual changes, plan steps completed, and checks performed, reconciled against the dispatcher's `changeSet`. If the worker's account and the fingerprint disagree, the fingerprint wins and the discrepancy is a deviation. Record `changeSet.headAfter` + `changeSet.worktreeDiffSha` in the ledger as the diff identifier.

`TIMEOUT` or `ABORTED` here: a partial change set, handled per DELEGATION.md § The evidence contract; never repaired by resuming that session.

## Phase 4 — `verify` (fresh worker, no writes)

Give the verifier the task requirements and the accepted plan. Give the implementation report as **claims to verify**, explicitly labeled as unverified. Never let the verifier resume the implementer's session; the dispatcher enforces this by rejecting `--session` outside `repair`.

Require the verifier to independently inspect the final diff and run the relevant tests, lint, type checks, builds, and regression checks; and where applicable to examine security, dependency, migration, compatibility, and rollback implications.

Verification targets the exact final change set: the dispatcher refuses `verify` unless the workspace snapshot equals the one the last compliant `implement` or `repair` produced. On that refusal, something changed in between: re-establish the change set with a fresh `implement`, then verify.

The verifier must classify every result as: passing · failing and attributable to the change · demonstrably pre-existing · skipped/blocked/unavailable · untested behavior and residual risk.

**Exit gate:** an evidence-backed verification report mapping results to the acceptance criteria. A `NO_WRITES_VIOLATED` status here means the verifier touched the implementation — that is a deviation; once `changeSet.restore.verified` confirms the change set is back, it must be re-verified by another fresh worker.

## Repair and termination

Repairable defects → a bounded `repair` dispatch resuming the implement session (`--session <sessionId from the implement status file>`), then a fresh `verify`. The dispatcher caps this at `--cycles` (default 2) total implementation→verification rounds and refuses to resume a session that ended in `TIMEOUT` or `ABORTED`. A repair that changes the accepted design goes back to `research` first.

Never silently defer a discovered bug and never mark one resolved on the implementer's claim alone — resolution requires a delegated verification that says so.

Stop when: all approval conditions are satisfied · the cycle limit is reached · the budget is exhausted · a hard blocker prevents compliant execution. At termination, report unresolved defects, missing evidence, and incomplete work accurately.
