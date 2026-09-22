---
name: to-bug
description: "Autonomous bug route of /to-goal: same control plane, worktree isolation, ledger, budgets, and review, with the route pinned to diagnosing-bugs and the bug fast path armed, so a reproducible bug goes red → regression test → fix → review → hand back without research, grilling, spec, or tickets unless the diagnosis proves it needs them. Use on /to-bug <symptom | failing command | issue ref> or $to-bug."
user-invocable: true
argument-hint: "<symptom | failing command | issue ref> [--force] [budget: …]   |   --stop [slug]"
metadata:
  short-description: "diagnose → regression test → fix → review, autonomously; escalates to the full to-goal flow only when the post-mortem says so."
---

# to-bug

`/to-bug` is `/to-goal` with one route. Let `ROOT` be the parent of this folder's real path (`realpath`, as in to-goal SKILL.md § Loading skills). Read `ROOT/to-goal/SKILL.md` and follow it verbatim, phase files included, with the overrides below. Nothing else changes: control plane, locks, registry, ledger, budgets, kill switch, redaction, no deferred actions, review, retro, final report all apply.

## Overrides

- **Argument.** The bug: a symptom, a failing command, a test name, a stack trace, a log excerpt, or an issue path or number. If empty, take it from the last user message. Slug prefix `bug-`; registry `kind: bug`.
- **Stage 1 route is pinned.** Skip classification and ask-matt. Log `classification: bug (pinned by /to-bug)`, route `diagnosing-bugs`, research need `none`. Still do the repo exploration (the failing thing, its seam, test conventions, tracker overlap) and write `findings.md`. If the checkout is mid-merge or mid-rebase, `resolving-merge-conflicts` first, as the tree says.
- **Stage 2 on-ramp is `diagnosing-bugs`,** run in the run worktree by the orchestrator, self-answered per KUN.md. Order is fixed: one command red on the bug before any theory; hypotheses ranked; regression test at the highest existing seam, red then green; smallest fix; post-mortem. Every hypothesis that names third-party behaviour or an unpinned library contract becomes a Q in `findings.md` and raises the research need to `targeted`; nothing else does.
- **Stage 3 research** runs only for those Qs (`research-stack` then one `research` per Q). A bug with none is logged `research: skipped (no external unknown)`.
- **Fast path decision** is PLAN.md § Bug fast path, verbatim. When it holds, stages 4 to 6 are skipped and stage 7 has nothing to dispatch. Review base is immutable `review_base` recorded in stage 0c before diagnosis. When it fails (no seam, several claim sets, Tier 2 or 3, a `guarded` path, a missing fixture, a design cause), continue at stage 4 with the post-mortem as the first finding and log why; the run is then a normal `/to-goal` run and its budgets apply.
- **Not reproducible.** If no command goes red after the loop tries the reported path, the nearest test, and a scripted repro (three attempts, each logged), the run stops: `spec.md` holds the attempts and the best hypothesis, the report names it as a blocker, nothing is "fixed" speculatively. A flaky reproduction is quarantined per BOOTSTRAP.md with owner, reason, and expiry; it is treated as resolved only when a causal red assertion is established and the fix demonstrates passing across repeated runs (at least 3 consecutive clean runs), not an accidental single pass.
- **Budgets** (override PIPELINE.md § Budgets on the fast path only): total agents 12, wall-clock 2 h, concurrent 2 (review's two axes). Off the fast path the to-goal budgets apply.
- **Stage 8 review** always runs, even on a one-line fix: diff is evaluated from immutable `review_base...HEAD` (ensuring the stage-2 fix and test are fully included); `code-review` Standards axis plus `defensive-design` Review mode over the diff; the Spec axis reads `spec.md` (the post-mortem). Findings fixed by the single fix subagent and independently re-verified against the final deliverable snapshot.
- **Final report** adds: the red command and its output before and after (redacted), the regression test path, the root cause in one sentence, the seam, and whether the fast path held. Leads from the post-mortem (design causes, `improve-codebase-architecture` candidates, sibling bugs noticed in flight per `bugs.md`) are listed, never acted on beyond scope.

## Daily use

- `/to-bug <symptom>` from the repo root, then walk away. One run = one branch `goal/bug-<slug>`.
- `/to-bug --stop [slug]` writes `STOP`. `/to-goal --gc` cleans up abandoned bug runs too.
- A bug that the objective describes as "and while you are there, add …" is not a bug run: use `/to-goal`.
