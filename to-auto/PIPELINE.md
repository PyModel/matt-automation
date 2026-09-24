# /to-auto pipeline reference

Read once at the start of a run. Consulted per stage.

## Budgets

Set in NOW `budgets:` at stage 0d and enforced in BUILD.md. Defaults, overridable by the objective ("budget: …") or `/kun`; `/kun` may raise any budget by at most 2× and never past the objective's explicit value. Briefs and stuck detection read the values in NOW, never the defaults below.

| Budget | Default | On breach |
|---|---|---|
| `max_concurrent_tickets` | 3 (1 if stage 0d finds the project cannot run two copies) | wait for a return before dispatch |
| `max_agents` (total subagents spawned in the run, all kinds) | 40 | finish running slices; write the ledger; `goal.mjs stop <slug> "budget: max_agents"`; report |
| per-ticket slices / wall-clock | 12 slices / 90 min | ticket `stuck: too big`; report says to split it |
| wall-clock | 8 h | finish running slices; write the ledger; `goal.mjs stop <slug> "budget: wall-clock"`; report |
| re-dispatches per ticket | 1 | ticket `stuck` |
| bug tickets added to the frontier by this run | 3 | further bugs stay ticketed for the next run |

## Isolation (stage 0c and stage 7)

Several agents may run `/to-auto` against one repo at once, so each run owns a branch and a worktree, and each ticket owns a branch and a worktree under it. Nothing shares a working directory, index, or HEAD.

| Level | Branch | Worktree | Cut from | Lifetime |
|---|---|---|---|---|
| Control | `goal/control` (orphan) | `<repo>/.worktrees/control/` | none | forever; committed after every write; never merged |
| Bootstrap | `goal/bootstrap` | temporary, removed after commit | default branch head | until the user fast-forwards default to it |
| Run | `goal/<slug>` | `<repo>/.worktrees/goal-<slug>/` | `goal/bootstrap` if it exists (refreshed onto the default branch head at 0b), else the default branch head (`origin/HEAD` if a remote exists) | survives the run; the user merges or deletes |
| Ticket | `goal/<slug>-t<NN>` | `<repo>/.worktrees/goal-<slug>-t<NN>/` | run branch head at dispatch | removed after merge into the run branch |

Commands:

```
git fetch --prune 2>/dev/null || true
git worktree add -b goal/<slug> .worktrees/goal-<slug> <base>          # <base> per the Run row
git -C .worktrees/goal-<slug> worktree add -b goal/<slug>-t<NN> ../goal-<slug>-t<NN> goal/<slug>
# after a ticket's review (all from inside the run worktree, so "fully merged" is judged against the run branch):
git -C .worktrees/goal-<slug>-t<NN> rebase goal/<slug>
git -C .worktrees/goal-<slug> merge --ff-only goal/<slug>-t<NN>
git -C .worktrees/goal-<slug> worktree remove ../goal-<slug>-t<NN>
git -C .worktrees/goal-<slug> branch -d goal/<slug>-t<NN>
```

Rules:

- Ticket branches are `goal/<slug>-t<NN>`, never `goal/<slug>/t<NN>`: git refuses a ref nested under an existing branch name (verified: `cannot lock ref`).
- Run `branch -d` from the run worktree: from the user's checkout git judges "fully merged" against the user's HEAD and refuses (verified).
- One worktree and branch per ticket; every commit lands on its ticket branch; the user's checkout is never touched.
- `git stash` is shared across worktrees: never stash; commit WIP on the ticket branch instead.
- Run state and the tracker live in the control plane (CONTROL.md), never in run worktrees, so run branches carry only code.
- Dependency installs, build caches, and `.env` files are per worktree: the ticket's implementer runs the project's install step in its own worktree before the first test.
- Parallel tickets need disjoint claims (PLAN.md 6b); take tickets only with `goal.mjs take` (CONTROL.md § Locks).

## Setup defaults (stage 0b)

`setup-matt-pocock-skills` is interactive upstream; `/to-auto` runs it with every answer pre-filled and logs each as `(source: default)`:

| Setup question | Answer |
|---|---|
| Section A: issue tracker | **Local markdown** in the control plane, `.worktrees/control/tracker/<feature>/` (default; the written tracker doc names that path and the CONTROL.md status grammar). GitHub only when the objective or the repo's existing `docs/agents/issue-tracker.md` says GitHub. |
| PRs as a request surface | no |
| Section B: triage labels | Keep the five defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. Create any missing label with `gh label create <name>` before first use. |
| Section C: domain docs | single-context (`CONTEXT.md` + `docs/adr/` at the root) unless monorepo signals exist, then multi-context. |
| Which file gets `## Agent skills`? | `CLAUDE.md` if it exists, else `AGENTS.md`, else create `AGENTS.md`. |
| "Let them edit before writing" | Skip; write directly. |

## Tracker rules

`to-spec`, `to-tickets`, `implement`, and `code-review` read `docs/agents/issue-tracker.md` written in stage 0b.

- **Local markdown** (the canonical spec is `.worktrees/control/tracker/<feature-slug>/spec.md`): one ticket per file at `…/issues/<NN>-<slug>.md` numbered blockers-first, with the exact `**Status:**`, `**Blocked by:**`, `**Claims:**` lines from CONTROL.md; `done` after merge.
- **GitHub**: the spec is one issue labelled `ready-for-agent`; tickets are sub-issues published blockers-first with `gh issue create --parent <spec> --blocked-by <n,m>` (gh ≥ 2.94); body-text "Blocked by" only if the flags are unavailable. Close each ticket after its merge.

Either way `runs/<slug>/spec.md` is a working copy (PLAN.md stage 5). Point every downstream step at a **full path or full reference** (`.worktrees/control/tracker/x/issues/03-foo.md`, `owner/repo#42`), never a bare `#3`: bare numbers resolve against whatever list the agent can see.

## Defaults (when neither evidence nor kun settles a question)

KUN.md decides when these apply: kun answers with a question of its own, or answerer and challenger still disagree. They never grant authority (SKILL.md § Rules, Autonomous).

| Question a sub-skill asks | Default |
|---|---|
| Which flow? (ask-matt) | Main flow (FLOWS.md § Routing tree, main-flow branch points). |
| Do these test seams match your expectations? | Yes: highest existing seam; new seams only where none exists; aim for one. |
| Grilling question with no evidence either way | Pick the answer that keeps scope smallest and is easiest to reverse; log it as a default. |
| Granularity right / merge or split? | 3–7 tickets; merge any ticket with no demo path; split any that would not fit one fresh window. |
| Blocking edges correct? | A ticket blocks only what cannot compile or run without it. |
| Which capability does this ticket need? | The lowest pair that can reliably finish it (CONTRACT.md § Capability); split rather than upgrade a large ticket. |
| Browser or end-to-end tests first? | No: behaviour first at the seam, browser tests after it works. |
| Which file to edit, CLAUDE.md or AGENTS.md? | Whichever exists; create neither. |
| Commit or open a PR? | Commit on the ticket branch; merge into the run branch. |
| defensive-design tier when consequence is unclear? | One tier higher than the module's inputs suggest; log it. |
| zero-tech-debt "approve this deletion"? | Approve when pre-flight passed and no external caller remains; otherwise keep and log. |
| Does this run build a pre-existing out-of-scope bug? | Yes while the bug-ticket budget allows and it passes the 6b gate; otherwise ticket only. |
| Challenger and answerer still disagree after one exchange? | As the grilling row; log `contested`. |

## Completion criteria per stage

A stage is done exactly when its line holds. Phase files point here.

- **00 Wiring**: `matt.mjs check` exited 0; the control worktree exists; ask-matt read.
- **0 Register**: registry entry with `run_id`; no overlapping running objective (or `--force`); `runs/<slug>/` with `ledger.md`, `todo.md`, `log.md`, `bugs.md` committed; `run_id` and the check's pin in NOW.
- **0a Cache kun**: `kun/<sha>/` present in the control plane; SHA in NOW.
- **0b Setup**: `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, `docs/agents/triage-labels.md` and the `## Agent skills` block exist on `goal/bootstrap` (or were already on base).
- **0c Isolate**: `git worktree list` shows the run worktree on `goal/<slug>`; `base`, `review_base`, `run_branch` in NOW.
- **0d Environment contract**: NOW carries `commands:`, `packages:` (if monorepo), `per-worktree:` (run-scoped), `budgets:`, `baseline:` (per-test set, 3 runs), `quarantine:`, `nested:`, `worker:` (`subagent`, or `pi[/<provider>/<model>]`, BUILD.md § Implementer backend), `tiers:` (capability → model map, or `none`).
- **1 Route**: classification logged (`bug | issue | ready | refactor | upkeep | fog | greenfield | feature`); flow named; adopted-patterns list, each line `pattern, from /<skill>`; research need logged (`none | targeted | up-front`); `findings.md` exists with repo facts, requirements R1…, open questions Q1….
- **2 On-ramp**: the chosen on-ramp's criteria in FLOWS.md § On-ramp completion criteria, or `skipped: plain feature` / `skipped: ready source <ref>` logged; for route `bug`, the fast-path decision logged with its reason.
- **3 Research**: every Q in `findings.md` closed with a sourced fact, or `research: skipped (no external unknown)` logged; no "TBD".
- **4/4b Grill + challenge**: frontier empty; every answer logged `(source: kun)` or `(source: default, contested)`; seams named; `CONTEXT.md` changed on disk (or an evidence-backed no-change log; no manufactured no-op edits); ADRs only where all three gates pass.
- **5/5b Spec + reconcile**: every to-spec template section filled; user stories scaled to actual decisions; no file paths or code in Implementation Decisions; the reconciliation gate's list is empty; `runs/<slug>/spec.md` present.
- **6/6b Tickets + claims**: one file per ticket; each has a demo path, tier, capability, claims, "Blocked by", and passes CONTRACT.md § Readiness; new-behaviour criteria red at base and preserved invariants green; no cycles; no two unordered open tickets share an `exclusive` claim; `ready-for-agent` stripped from the parent spec; ticket table in `todo.md`.
- **7 Build**: every ticket `done` (a `completed` receipt that passed `goal.mjs receipt`, merged fast-forward as a recorded range, boxes ticked, ticket closed) or `stuck` with its reason; every dispatched ticket has `tickets/<NN>.goal.md` and `tickets/<NN>.receipt.md`; per-test comparison against baseline passes; the debt grep (BUILD.md § Bugs found in flight) is empty; per ticket a defensive-design evidence state per control, a red test before code per slice (visible `tdd` calls), and typecheck, lint, and suite output captured; only the run worktree remains; (GitHub, push authorized) draft PR open closing spec and tickets.
- **8 Final review**: ran in a fresh review subagent against `review_base`; cited findings fixed by one fix subagent, independently re-verified against the resulting snapshot, and committed; suite no worse than baseline; `final-verdict.json` written; uncited leads listed.
- **9 Hand back**: only the user's checkout, `.worktrees/control`, the run worktree, and active peer run worktrees remain in `git worktree list`; an authorized PR is marked ready for review.
- **10 Retro**: `retro.md` written with candidates ordered by severity.
- **Every stage**: `bugs.md` has no entry without an action (commit, ticket id, or blocker); NOW rewritten, an event appended, `todo.md` box ticked, all committed before the next stage starts.

## Under a loop

Any recurring runner works: Claude Code's `/loop /to-auto <objective>`, a cron or CI job, or a script that re-invokes the agent. Each tick runs the LEDGER.md re-entry protocol, which starts with `goal.mjs next <slug>`: a deterministic answer from the files, so every tick resumes at the same place whatever model or harness runs it. `done` or `stop` ends the loop.
