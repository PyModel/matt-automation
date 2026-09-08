# Bootstrap: stages 0 to 0d

Read CONTROL.md, then PIPELINE.md § Isolation and § Setup defaults.

## 0. Control plane and registry

1. Under the `exclude` lock add `.worktrees/` to `.git/info/exclude` if absent.
2. Under the `control` lock: if `.worktrees/control/` is missing, create it (CONTROL.md § Rules). If a remote tracks `goal/control`, fast-forward it.
3. Under the `registry` lock: derive the slug, check `runs.json` for a duplicate or overlapping running objective (refuse and report unless `--force`), append this run with the next `run_id`, `status: bootstrapping`, the harness name and this agent's id or pid; commit.
4. Create `runs/<slug>/` with `ledger.md` (NOW: stage 0, run_id), `todo.md` (all stages unchecked), `log.md`, `bugs.md`; commit `[<slug>] start`.
5. If the user's checkout has uncommitted changes (`git status --porcelain` non-empty), write `dirty-checkout: yes (N files)` into NOW: the run builds from the base commit and will not see them; the report repeats it.
6. `--gc` sweep for worktrees whose ledger is older than 7 days (CONTROL.md; § Kill switch and GC below).

Done when the registry entry exists and `runs/<slug>/` is committed on `goal/control`.

## 0a. Cache kun

KUN.md § Cache once, into `kun/<sha>/` in the control plane (shared by all runs; reuse an existing `<sha>` dir when the upstream SHA is unchanged). Fetch failure with no cached SHA at all: set the registry entry to `aborted: kun unreachable`, commit, and end before any other mutation. Fetch failure with a cached SHA: use the newest cache and log `kun: cached <sha>, upstream unreachable`.

## 0b. Setup on the bootstrap branch

The engineering skills need `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, `docs/agents/triage-labels.md`, and an `## Agent skills` block in `CLAUDE.md`/`AGENTS.md`.

- Present on the base commit: log "setup present", skip.
- Otherwise, under the `bootstrap` lock: if `goal/bootstrap` exists, nothing to do; if not, create it from base in a temporary worktree, load `setup-matt-pocock-skills` by path and run it non-interactively with PIPELINE.md § Setup defaults (local tracker whose files live in the control plane: the tracker doc says so explicitly), commit `Add agent-skills config`, remove the temporary worktree. Release the lock. The report tells the user to fast-forward the default branch to `goal/bootstrap` once.

Done when the three files and the block exist on `goal/bootstrap` (or base).

## 0c. Isolate

1. Base = `goal/bootstrap` if it exists, else `origin/HEAD` if a remote exists, else the local default branch.
2. `git worktree add -b goal/<slug> .worktrees/goal-<slug> <base>` (slug from the registry; `-2` suffix only for a finished prior run of the same slug).
3. Every later action happens inside the run worktree or the control worktree. Never `cd` back into the user's checkout.
4. Registry `status: planning`; NOW records base, run branch.

Done when `git worktree list` shows the run worktree on its own branch.

## 0d. Environment contract, baseline, capability probe

1. **Commands.** Detect install, typecheck, lint, single-test, full-suite, and (if any) regenerate commands for shared files (lockfile, codegen, snapshots) from the environment. Monorepo signals (`pnpm-workspace.yaml`, `workspaces`, `packages/*` with own `src/`) → detect per package and record a `packages:` map; claims and baselines are then per package.
2. **Per-worktree recipe, run-scoped.** Ports = `3000 + 100 * run_id + NN`; database/schema suffix `_<slug>_t<NN>`; compose project name `<slug>-t<NN>`; temp dirs under the worktree; `.env` copied with the substitutions applied. Any resource with no override → `max_concurrent_tickets: 1`, logged why.
3. **Baseline, three runs.** Install, then run the full suite 3× at base in the run worktree; record the per-test result set. Tests failing all 3× are pre-existing bugs (BUILD.md § Bugs found in flight); tests failing 1–2× are **flaky** and go into `quarantine.json` keyed by base commit, excluded from stuck counts and from "no worse than baseline" comparisons, and listed in the report. Baseline = the per-test set, not a count.
4. **Capability probe.** Determine whether a subagent on this harness can spawn subagents (dispatch a trivial subagent that tries to spawn one and reports). `nested: yes` → implementers run `code-review` themselves. `nested: no` → **flat mode**: implementers do a single-agent review inline (both axes, in one pass) and the orchestrator runs `code-review` per ticket after merge; log `degraded: flat spawn`. Record `nested:` in NOW.
5. Registry `status: planning`; NOW carries `commands:`, `packages:`, `per-worktree:`, `max_concurrent_tickets`, `baseline:`, `quarantine:`, `nested:`.

Done when NOW carries all of those and the control plane is committed.

## Kill switch and GC

- **`STOP`**: `runs/<slug>/STOP` in the control plane (committed). The orchestrator checks it before every stage and every dispatch; every implementer checks it before every slice and returns after the current slice when present. `/to-goal --stop [slug]` creates it (CONTROL.md § Run registry for slug resolution). On stop: registry `status: stopped`, ledger written, report.
- **`--gc`**: for every `.worktrees/goal-*` whose run's ledger has no heartbeat or event newer than 24 hours and whose registry `agent` pid/id is not alive, `git worktree remove --force` it and delete its branches; registry `status: gc`; log to `gc.log`; commit. Never removes a fresh run, `goal/control`, or `goal/bootstrap`. Also runs at stage 0 for runs older than 7 days.
- **`--dry-run <objective>`**: stages 0–0d, then a synthetic 3-ticket graph through the 6b gates (claims intersection, criteria-red-at-base check on the baseline), no implementers; leaves the run registered as `status: dry-run` and reports every command it ran. Use it on a fixture repo after editing this skill.
