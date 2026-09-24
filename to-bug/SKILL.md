---
name: to-bug
description: "Autonomous bug route of /to-auto: same control plane, worktree isolation, ledger, budgets, and review, with the route pinned to diagnosing-bugs and the bug fast path armed, so a reproducible bug goes red → regression test → fix → review → hand back without research, grilling, spec, or tickets unless the diagnosis proves it needs them. Use on /to-bug <symptom | failing command | issue ref> or $to-bug."
user-invocable: true
argument-hint: "<symptom | failing command | issue ref> [--force] [budget: …]   |   --stop [slug]"
metadata:
  short-description: "diagnose → regression test → fix → review, autonomously; escalates to the full to-auto flow only when the post-mortem says so."
---

# to-bug

`/to-bug` is `/to-auto` with one route. Let `ROOT` be the parent of this folder's real path (`realpath`, as in to-auto SKILL.md § Loading skills). Read `ROOT/to-auto/SKILL.md` and follow it verbatim, phase files included, with the overrides below. Everything else applies unchanged.

## Overrides

- **Argument.** The bug: a symptom, a failing command, a test name, a stack trace, a log excerpt, or an issue path or number. If empty, take it from the last user message. The objective is `bug: <argument>`, so `goal.mjs slug` yields `bug-…` and the run branch is `goal/bug-…`.
- **Stage 1 route is pinned.** ask-matt's on-ramp for something broken is `/diagnosing-bugs`, which is this route. Skip classification. Log `route: On-ramps → diagnosing-bugs (bug, pinned by /to-bug)`, research need `none` (FLOWS.md § Research need, bug row, decides what raises it). Still do the repo exploration (the failing thing, its seam, test conventions, tracker overlap) and write `findings.md`. If the checkout is mid-merge or mid-rebase, `resolving-merge-conflicts` first, as the routing tree says.
- **Stage 2 on-ramp is `diagnosing-bugs`,** run by the orchestrator in the run worktree, self-answered per KUN.md; done per FLOWS.md § On-ramp completion criteria.
- **Fast path:** PLAN.md § Bug fast path, verbatim. When it fails, log why; the run is then a normal `/to-auto` run with its budgets.
- **Not reproducible.** If no command goes red after the loop tries the reported path, the nearest test, and a scripted repro (three attempts, each logged), the run stops with `node ROOT/scripts/goal.mjs stop <slug> "not reproducible"`: `spec.md` holds the attempts and the best hypothesis, the report names it as a blocker, nothing is "fixed" speculatively. A flaky reproduction is quarantined per BOOTSTRAP.md § 0d with owner, reason, and expiry; it counts as resolved only when a causal red assertion is established and the fix passes at least 3 consecutive clean runs.
- **Budgets on the fast path** (override PIPELINE.md § Budgets): total agents 12, wall-clock 2 h. Off the fast path the to-auto budgets apply.
- **Stage 8 review always runs,** even on a one-line fix, per CLOSE.md stage 8; its Spec axis reads `spec.md` (the post-mortem).
- **Final report** adds: the red command and its output before and after (redacted), the regression test path, the root cause in one sentence, the seam, and whether the fast path held. Leads from the post-mortem (design causes, `improve-codebase-architecture` candidates, sibling bugs in `bugs.md`) are listed, never acted on beyond scope.

## Daily use

- `/to-bug <symptom>` from the repo root, then walk away.
- `/to-bug --stop [slug]` writes `STOP`. `/to-auto --gc` cleans up abandoned bug runs too.
- A bug that the objective describes as "and while you are there, add …" is not a bug run: use `/to-auto`.
