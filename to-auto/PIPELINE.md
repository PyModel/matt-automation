# /to-auto pipeline reference

Read once at the start of a run. Consulted per stage.

## Budgets

Set in NOW `budgets:` at stage 0d and enforced in BUILD.md. Defaults, overridable by the objective ("budget: …") or `/kun`; `/kun` may raise any budget by at most 2× and never past the objective's explicit value. Briefs and stuck detection read the values in NOW, never the defaults below. The orchestrator never raises a budget on its own judgment: a raise is logged `(source: kun)` or `(source: objective)`. A ticket that looks too big for the per-ticket cap is split at 6b, not given a bigger cap.

| Budget | Default | On breach |
|---|---|---|
| `max_concurrent_tickets` | 3 (1 if stage 0d finds the project cannot run two copies) | wait for a return before dispatch |
| `max_agents` (total subagents spawned in the run, all kinds) | 40 | finish running slices; write the ledger; `goal.mjs stop <slug> "budget: max_agents"`; report |
| per-ticket slices / wall-clock | 12 slices / 90 min | ticket `stuck: too big`; report says to split it |
| wall-clock | 8 h | finish running slices; write the ledger; `goal.mjs stop <slug> "budget: wall-clock"`; report |
| re-dispatches per ticket | 1 stuck re-dispatch, plus up to 2 claims-amendment dispatches (BUILD.md § Claims amendment) | ticket `stuck` |
| bug tickets added to the frontier by this run (pre-existing bugs only; findings in this run's own diff never count) | 3 | further bugs stay ticketed for the next run |

## Isolation (stage 0c and stage 7)

Several agents may run `/to-auto` against one repo at once, so each run owns a branch and a worktree, and each ticket owns a branch and a worktree under it. Nothing shares a working directory, index, or HEAD.

| Level | Branch | Worktree | Cut from | Lifetime |
|---|---|---|---|---|
| Control | none in the user repo (private history) | the path `goal.mjs control` prints | none | until `goal.mjs cleanup`; committed after every write; never merged |
| Bootstrap | `goal/bootstrap` | `<state>/worktrees/bootstrap`, removed after commit | default branch head, or `--base` in supervisor mode | until the user fast-forwards default to it |
| Run | `goal/<slug>`, or `--target-branch` in supervisor mode | the path `goal.mjs worktree get <slug>` prints | `goal/bootstrap` if it exists, else `--base`, else the default branch head (not `origin/HEAD` when `--no-remote` or the repo has no remote) | survives the run; the user merges or deletes. Supervisor mode commits on the target branch and `goal.mjs land` maps items to commits |
| Ticket | `goal/<slug>-t<NN>` | the path `goal.mjs worktree get <slug> <NN>` prints | run branch head at dispatch | returned after merge into the run branch |

Run and ticket worktrees come only from `goal.mjs worktree`, never from a hand-typed `git worktree add`: it records each one in `runs/<slug>/worktrees.json`, so `goal.mjs cleanup` and the GC know what the run owns. With `treehouse` on PATH it leases a pooled worktree (dependencies and build caches kept between tickets); otherwise it makes a plain git worktree under `<state>/worktrees/`. A branch already checked out (supervisor mode's target branch) is borrowed as-is and never removed. Use the path it prints; never infer a layout. Commands (skip `git fetch` when `--no-remote` or there is no remote):

```
git fetch --prune 2>/dev/null || true
RUN=$(node ROOT/scripts/goal.mjs worktree get <slug>)            # base per the Run row
WT=$(node ROOT/scripts/goal.mjs worktree get <slug> <NN>)        # cut from the run branch head
# after a ticket's review (from inside the run worktree, so "fully merged" is judged against the run branch):
git -C "$WT" rebase goal/<slug>
git -C "$RUN" merge --ff-only goal/<slug>-t<NN>
node ROOT/scripts/goal.mjs worktree return <slug> <NN>           # refuses a dirty worktree; never forced
git -C "$RUN" branch -d goal/<slug>-t<NN>
```

`goal.mjs worktree status <slug>` prints every worktree the run owns.

Rules:

- Ticket branches are `goal/<slug>-t<NN>`, never `goal/<slug>/t<NN>`: git refuses a ref nested under an existing branch name (verified: `cannot lock ref`).
- Run `branch -d` from the run worktree: from the user's checkout git judges "fully merged" against the user's HEAD and refuses (verified).
- One worktree and branch per ticket; every commit lands on its ticket branch; the user's checkout is never touched.
- `git stash` is shared across worktrees: never stash; commit WIP on the ticket branch instead.
- Run state and the tracker live in the control plane (CONTROL.md), never in run worktrees, so run branches carry only code.
- Dependency installs, build caches, and `.env` files are per worktree: the ticket's implementer runs the project's install step in its own worktree before the first test.
- A worktree never sits under a directory whose `.gitignore` or `.ignore` has a `*` or `**` line (treehouse stamps `*` into its pool root). Gitignore-aware tools (oxlint, anything on the `ignore` crate) read ancestor ignore files there, lint nothing, and exit 0, so a green gate proves nothing. `goal.mjs worktree get` cuts treehouse slots under `<state>/worktrees/pool/` and refuses any worktree with such an ancestor (a treehouse slot goes back to the pool first; the message names the `treehouse destroy` that retires it), and `goal.mjs run` refuses to log a command run under one. Running the gate in the user's checkout instead is not a workaround: that checkout is never touched.
- Git hooks are shared: `core.hooksPath` and `<git-common-dir>/hooks` serve every worktree, and a dependency install's `prepare` step (husky, lefthook, simple-git-hooks) can rewrite or redirect them for all of them, the user's checkout included. No gate relies on a hook firing: every check a hook runs is its own `commands:` entry run through `goal.mjs run` (BOOTSTRAP.md § 0d), and the implementer re-runs `commands: hooks` after every install (BUILD.md § The implementer brief, rule 1).
- Parallel tickets need disjoint claims (PLAN.md 6b); take tickets only with `goal.mjs take` (CONTROL.md § Locks).

## Setup defaults (stage 0b)

`setup-matt-pocock-skills` is interactive upstream; `/to-auto` runs it with every answer pre-filled and logs each as `(source: default)`:

| Setup question | Answer |
|---|---|
| Section A: issue tracker | **Local markdown** in the control plane, `<state>/tracker/<feature>/` (default; the written tracker doc names that path and the CONTROL.md status grammar). GitHub only when the objective or the repo's existing `docs/agents/issue-tracker.md` says GitHub. |
| PRs as a request surface | no |
| Section B: triage labels | Keep the five defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. Create any missing label with `gh label create <name>` before first use. |
| Section C: domain docs | single-context (`CONTEXT.md` + `docs/adr/` at the root) unless monorepo signals exist, then multi-context. |
| Which file gets `## Agent skills`? | `CLAUDE.md` if it exists, else `AGENTS.md`, else create `AGENTS.md`. |
| "Let them edit before writing" | Skip; write directly. |

## Tracker rules

`to-spec`, `to-tickets`, `implement`, and `code-review` read `docs/agents/issue-tracker.md` written in stage 0b.

- **Local markdown** (the canonical spec is `<state>/tracker/<feature-slug>/spec.md`): one ticket per file at `…/issues/<NN>-<slug>.md` numbered blockers-first, with the exact `**Status:**`, `**Blocked by:**`, `**Claims:**` lines from CONTROL.md; `done` after merge.
- **GitHub**: the spec is one issue labelled `ready-for-agent`; tickets are sub-issues published blockers-first with `gh issue create --parent <spec> --blocked-by <n,m>` (gh ≥ 2.94); body-text "Blocked by" only if the flags are unavailable. Close each ticket after its merge.

Either way `runs/<slug>/spec.md` is a working copy (PLAN.md stage 5). Point every downstream step at a **full path or full reference** (`<state>/tracker/x/issues/03-foo.md`, `owner/repo#42`), never a bare `#3`: bare numbers resolve against whatever list the agent can see.

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
- **0a Cache kun**: `kun/<sha>/` in the control plane holds the four root docs and `content/MANIFEST.json`; SHA in NOW.
- **0b Setup**: `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, `docs/agents/triage-labels.md` and the `## Agent skills` block exist on `goal/bootstrap` (or were already on base).
- **0c Isolate**: `goal.mjs worktree status <slug>` shows the run worktree active on `goal/<slug>`; `base`, `review_base`, `run_branch` in NOW.
- **0d Environment contract**: NOW carries `commands:`, `packages:` (if monorepo), `per-worktree:` (run-scoped), `budgets:`, `baseline:` (per-test set from 3 runs, committed as `runs/<slug>/baseline.txt`), `quarantine:`, `nested:`, `worker:` (`subagent`, or `pi[/<provider>/<model>]`, BUILD.md § Implementer backend), `tiers:` (capability → model map, or `none`).
- **1 Route**: classification logged (`bug | issue | ready | refactor | upkeep | fog | greenfield | feature`); flow named; adopted-patterns list, each line `pattern, from /<skill>`; research need logged (`none | targeted | up-front`); `findings.md` exists with repo facts, requirements R1…, open questions Q1….
- **2 On-ramp**: the chosen on-ramp's criteria in FLOWS.md § On-ramp completion criteria, or `skipped: plain feature` / `skipped: ready source <ref>` logged; for route `bug`, the fast-path decision logged with its reason.
- **3 Research**: every Q in `findings.md` closed with a sourced fact, or `research: skipped (no external unknown)` logged; no "TBD".
- **4/4b Grill + challenge**: frontier empty; every answer logged `(source: kun)` or `(source: default, contested)`; seams named; `CONTEXT.md` changed on disk (or an evidence-backed no-change log; no manufactured no-op edits); ADRs only where all three gates pass.
- **5/5b Spec + reconcile**: every to-spec template section filled; user stories scaled to actual decisions; no file paths or code in Implementation Decisions; the reconciliation gate's list is empty; `runs/<slug>/spec.md` present.
- **6/6b Tickets + claims**: one file per ticket; each has a demo path, tier, capability, claims, "Blocked by", and passes CONTRACT.md § Readiness; new-behaviour criteria red at base and preserved invariants green; no cycles; no two unordered open tickets share an `exclusive` claim; `ready-for-agent` stripped from the parent spec; ticket table in `todo.md`.
- **7 Build**: every ticket `done` (a `completed` receipt that passed `goal.mjs receipt`, merged fast-forward as a recorded range, boxes ticked, ticket closed) or `stuck` with its reason; every dispatched ticket has `tickets/<NN>.goal.md` and `tickets/<NN>.receipt.md`; per-test comparison against baseline passes; the debt grep (BUILD.md § Bugs found in flight) is empty; per ticket a defensive-design evidence state per control, a red test before code per slice (visible `tdd` calls), and typecheck, lint, and suite output captured; only the run worktree remains; (GitHub, push authorized) draft PR open closing spec and tickets.
- **8 Final review**: ran in a fresh review subagent against `review_base`; cited findings fixed by one fix subagent, independently re-verified against the resulting snapshot, and committed; suite no worse than baseline; `final-verdict.json` written; uncited leads listed.
- **9 Hand back**: `goal.mjs worktree status <slug>` shows no ticket worktree `active` (idle treehouse pool slots in `git worktree list` are not the run's); an authorized PR is marked ready for review. In supervisor mode, `goal.mjs land` has already put the commits on `--target-branch` and written the item map to `--status-file`.
- **10 Retro**: `retro.md` written with candidates ordered by severity.
- **Every stage**: `bugs.md` has no entry without an action (commit, ticket id, or blocker); NOW rewritten, an event appended, `todo.md` box ticked, all committed before the next stage starts.

## Under a loop

Any recurring runner works: Claude Code's `/loop /to-auto <objective>`, a cron or CI job, or a script that re-invokes the agent. Each tick runs the LEDGER.md re-entry protocol, which starts with `goal.mjs next <slug>`: a deterministic answer from the files, so every tick resumes at the same place whatever model or harness runs it. `done` or `stop` ends the loop.
