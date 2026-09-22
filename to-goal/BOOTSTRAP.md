# Bootstrap: stages 0 to 0d

Read CONTROL.md, then PIPELINE.md § Isolation and § Setup defaults.

## 0. Control plane and registry

00. **Skill wiring.** Run `node ROOT/scripts/matt.mjs check` (SKILL.md § Loading skills). Nonzero exit: report the printed errors and end; nothing has been written yet. Otherwise carry the printed `pin:` into NOW at step 4.
0. **Repo state classification.** Classify repository state before proceeding: absent (fail or initialize if authorized), unborn (git init with no commits: create an initial empty commit `git commit --allow-empty -m "Initial commit"` before worktree creation), empty-but-committed, or established.
1. With `goal.mjs with-lock exclude --` add `.worktrees/` to `.git/info/exclude` if absent.
2. With `goal.mjs with-lock control --`: if `.worktrees/control/` is missing, create it (CONTROL.md § Rules). If a remote tracks `goal/control`, fast-forward it.
3. Inside one `goal.mjs with-lock registry --` transaction: derive the slug, check `runs.json` for a duplicate or overlapping running objective (refuse and report unless `--force`), append this run with the next `run_id`, `status: bootstrapping`, the harness name and this agent's id or pid; commit.
4. `node ROOT/scripts/goal.mjs init <slug> "<objective>"` creates and commits `runs/<slug>/` with `ledger.md`, `todo.md` (every stage line, unticked, in the grammar `goal.mjs next` parses), `log.md`, and `bugs.md`. Then write `run_id` into NOW and tick `00`.
5. If the user's checkout has uncommitted changes (`git status --porcelain` non-empty), write `dirty-checkout: yes (N files)` into NOW: the run builds from the base commit and will not see them; the report repeats it.
6. `--gc` candidate sweep (report-only by default; § Kill switch and GC below).

Done when the registry entry exists and `runs/<slug>/` is committed on `goal/control`.

## 0a. Cache kun

KUN.md § Cache once, into `kun/<sha>/` in the control plane (shared by all runs; reuse an existing `<sha>` dir when the upstream SHA is unchanged). Fetch failure with no cached SHA at all: set the registry entry to `aborted: kun unreachable`, commit, and end before any other mutation. Fetch failure with a cached SHA: use the newest cache and log `kun: cached <sha>, upstream unreachable`.

## 0b. Setup on the bootstrap branch

The engineering skills need `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, `docs/agents/triage-labels.md`, and an `## Agent skills` block in `CLAUDE.md`/`AGENTS.md`.

- Present on the base commit: log "setup present", skip.
- Otherwise, inside one `goal.mjs with-lock bootstrap --` transaction: resolve the current intended source ref (default branch head `main` / remote default head). If `goal/bootstrap` exists, rebase/refresh it onto the current source ref so it does not freeze on an outdated base commit; if not, create it from base in a temporary worktree, load `setup-matt-pocock-skills` by path and run it non-interactively with PIPELINE.md § Setup defaults (local tracker whose files live in the control plane: the tracker doc says so explicitly), commit `Add agent-skills config`, remove the temporary worktree. Release the lock. The report tells the user to fast-forward the default branch to `goal/bootstrap` once.

Done when the three files and the block exist on `goal/bootstrap` (or base).

## 0c. Isolate

1. Resolve current default branch head (`main` or remote default branch). If `goal/bootstrap` exists, verify it incorporates the current default branch (rebase if stale) and use it as `<base>`; otherwise `<base>` = default branch head (`origin/HEAD` if a remote exists, else local default branch).
2. `git worktree add -b goal/<slug> .worktrees/goal-<slug> <base>` (slug from the registry; `-2` suffix only for a finished prior run of the same slug).
3. Record immutable `review_base = $(git rev-parse HEAD)` in NOW immediately upon worktree creation: all subsequent diagnosis, planning, scaffold, and ticket diffs will be reviewed against this immutable base.
4. Every later action happens inside the run worktree or the control worktree. Never `cd` back into the user's checkout.
5. Registry `status: planning`; NOW records `base`, `review_base`, `run_branch`.

Done when `git worktree list` shows the run worktree on its own branch and `review_base` is recorded.

## 0d. Environment contract, baseline, capability probe

1. **Commands.** Detect install, typecheck, lint, single-test, full-suite, and (if any) regenerate commands for shared files (lockfile, codegen, snapshots) from the environment. Monorepo signals (`pnpm-workspace.yaml`, `workspaces`, `packages/*` with own `src/`) → detect per package and record a `packages:` map; claims and baselines are then per package.
2. **Per-worktree recipe, run-scoped.** Ports = `3000 + 100 * run_id + NN`; database/schema suffix `_<slug>_t<NN>`; compose project name `<slug>-t<NN>`; temp dirs under the worktree; `.env` copied with the substitutions applied. Any resource with no override → `max_concurrent_tickets: 1`, logged why.
3. **Baseline, three runs.** Install, then run the full suite 3× at base in the run worktree; record the per-test result set. Tests failing all 3× are pre-existing bugs (BUILD.md § Bugs found in flight); tests failing 1–2× are **flaky** and go into `quarantine.json` with an explicit owner, reason, and expiry, keyed by base commit. Quarantined tests continue to be executed and reported; an intermittent failure turning into a persistent failure blocks approval. Baseline = the per-test set, not a count.
4. **Capability probe.** Preflight runtime tools, Node/Git versions, and subagent spawn capability. Determine whether a subagent on this harness can spawn subagents (dispatch a trivial subagent that tries to spawn one and reports). `nested: yes` → implementers run `code-review` themselves. `nested: no` → **flat mode**: implementers do a single-agent review inline (both axes, in one pass) and the orchestrator runs `code-review` per ticket after merge; log `degraded: flat spawn`. Record `nested:` in NOW.
5. Registry `status: planning`; NOW carries `commands:`, `packages:`, `per-worktree:`, `max_concurrent_tickets`, `baseline:`, `quarantine:`, `nested:`, `review_base:`.

Done when NOW carries all of those and the control plane is committed.

## Kill switch and GC

- **`STOP`**: `runs/<slug>/STOP` in the control plane (committed). The orchestrator checks it before every stage and every dispatch; every implementer checks it before every slice and returns after the current slice when present. `/to-goal --stop [slug]` creates it (CONTROL.md § Run registry for slug resolution). On stop: registry `status: stopped`, ledger written, report.
- **`--gc`**: Report-only by default: scans `.worktrees/goal-*` for runs older than 24 hours whose agent is inactive, auditing whether each is clean and reachable. Worktree deletion requires explicit `--gc --delete-clean`, and MUST only collect terminal runs where `git status --porcelain` is completely clean and all commits are reachable from a retained branch. If uncommitted changes exist, deletion is refused unless a verified archive/backup is saved first. Never run `git worktree remove --force` on dirty or unbacked-up worktrees. Never touches `goal/control`, active runs, or `goal/bootstrap`.
- **`--dry-run <objective>`**: stages 0–0d, then a synthetic 3-ticket graph through the 6b gates (claims intersection, criteria-red-at-base check on the baseline), no implementers; leaves the run registered as `status: dry-run` and reports every command it ran. Use it on a fixture repo after editing this skill.
