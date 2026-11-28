# Bootstrap: stages 00 to 0d

Read CONTROL.md, then PIPELINE.md § Isolation and § Setup defaults. Each stage is done per PIPELINE.md § Completion criteria per stage.

## 00. Repo, control plane, wiring, map

In order:

1. Classify the repository: not a git repository (greenfield: apply `ROOT/to-new/SKILL.md` § Overrides, stage 0 precondition, and continue under the to-new overrides), unborn (a git repo with no commits: `git commit --allow-empty -m "Initial commit"`), empty-but-committed, or established.
2. `node ROOT/scripts/goal.mjs preflight`, then `node ROOT/scripts/goal.mjs prepare`. prepare creates the control plane if missing (CONTROL.md § Rules) and prints the workspace. When this checkout is a linked worktree whose shared git dir is not writable, that workspace is a clone under the state folder; every later git command uses it. Nonzero exit: stop with the printed reason. In supervisor mode, run `goal.mjs supervise` instead: it records `--base`, `--target-branch`, `--status-file`, and `--no-remote`.
3. `node ROOT/scripts/matt.mjs check`. Nonzero exit: `node ROOT/scripts/goal.mjs stop <slug> "<the printed errors>"` and end.
4. Read ask-matt (`node ROOT/scripts/matt.mjs resolve ask-matt`): it is the map every later stage follows, and stage 1 routes by it.
5. **Admission, before `init`.** A backlog is not one run: "fix all N issues", "every open issue", or any open-ended or moving list. Snapshot the issue ids, split them into bounded batches (dependency-aware, each with its own acceptance scope), and start each batch as its own `/to-auto` run with its own objective, or hand the inventory and batching to to-orc. Report the batches and end; this invocation registers nothing. `goal.mjs init` refuses an objective worded as a backlog; rewording it to slip past is the same violation. A bounded feature that needs several tickets is not a backlog, and FLOWS.md's ready-source and bug routes stay as they are.

## 0. Register

If `next` reports `registered: true`, adopt as needed per LEDGER.md and skip
registration. At `00`, recheck wiring before recording its pin. For a new
run, first check `runs.json` for ≥ 80% token overlap with an active objective;
refuse unless `--force` was requested. Register before any dispatch:

```sh
node ROOT/scripts/goal.mjs init <slug> "<objective>" --agent <session-id> --harness <name> [--mode branch|supervisor|pr] [--worker-model <model>] [--no-helpers]
```

Pass `$CLAUDE_CODE_SESSION_ID` on Claude Code, the UUID of pi's current session
file under `~/.pi/agent/sessions/`, or the host's session/thread id. Default
mode is `branch` (or `supervisor` with a saved target); use `pr` only when the
owner asked for a pull request, and pushing and the PR still need their grants
(CORE.md). Apply CORE.md § Helpers when choosing flags.

For either path, record `run_id` and `vendored:` in NOW. Run
`goal.mjs tick <slug> 00`, then `goal.mjs tick <slug> 0`, for unticked stages only.

1. If the user's checkout has uncommitted changes (`git status --porcelain` non-empty), write `dirty-checkout: yes (N files)` into NOW: the run builds from the base commit and will not see them; the report repeats it.
2. `--gc` candidate sweep (report-only by default; § Kill switch and GC below).

## 0a. Cache kun

KUN.md § Cache once, into `kun/<sha>/` in the control plane.

## 0b. Setup on the bootstrap branch

The engineering skills need `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, `docs/agents/triage-labels.md`, and an `## Agent skills` block in `CLAUDE.md`/`AGENTS.md`.

- Present on the base commit: log "setup present", skip.
- Otherwise resolve the default branch head (`main` / the remote default head).
  Create or rebase `goal/bootstrap` there in a temporary worktree. Wrap branch
  changes in `goal.mjs with-lock bootstrap -- sh -c '<git commands>'`.
  Outside the lock, use `setup-matt-pocock-skills` templates and PIPELINE.md
  defaults to fill **missing** files and sections only. Preserve any existing
  tracker doc; do not run setup's remote label creation without a grant.
  Commit `Add agent-skills config`, return the worktree, and report the pending
  fast-forward to `goal/bootstrap`.

Either way, record the effective write tracker under PIPELINE.md § Tracker rules.

## 0c. Isolate

1. `node ROOT/scripts/goal.mjs worktree get <slug>` creates the run worktree (PIPELINE.md § Isolation) and prints its path; write it into NOW.
2. Record `review_base = $(git rev-parse HEAD)` in the new worktree, in NOW, immediately. It is immutable: every later diff (diagnosis, fast-path fix, glossary, scaffold, tickets, final review) is reviewed against it.
3. Every later action happens inside the run worktree or the control worktree. Never `cd` back into the user's checkout.
4. NOW records `base`, `review_base`, `run_branch`; then `node ROOT/scripts/goal.mjs tick <slug> 0c`, which moves the registry to `planning` and refuses without an active run worktree or without `review_base` in NOW.

## 0d. Environment contract, baseline, capability probe

1. **Commands.** Discover install, typecheck, lint, single-test, suite,
   and shared-file regeneration. Inspect `core.hooksPath` or the Git hooks
   directory and repo hook config. Record every hook check as a separate
   `commands:` entry and any hook installer as `hooks=` (PIPELINE.md §
   Isolation). Run lint and typecheck; confirm they checked files. In a
   monorepo, record commands, claims and baselines per package (`packages:`).
2. **Per-worktree recipe, run-scoped.** Ports = `3000 + 100 * run_id + NN`; database/schema suffix `_<slug>_t<NN>`; compose project name `<slug>-t<NN>`; temp dirs under `<state>/tmp/<slug>/`, not the user repo. `.env` copied with the substitutions applied. Do not edit `.git/info/exclude` or `.gitignore`. A path the repo does not already ignore is created under `<state>/`, so the worktree stays clean (CONTRACT.md § The receipt check). Any resource with no override → `max_concurrent_tickets: 1`, logged why.
3. **Baseline, three runs.** Install, then run the full suite 3× at base in the run worktree; record the per-test result set. Tests failing all 3× are pre-existing bugs (BUILD.md § Bugs found in flight); tests failing 1–2× are **flaky** and go into `quarantine.json` with an explicit owner, reason, and expiry, keyed by base commit. Quarantined tests keep running and being reported; an intermittent failure that turns persistent blocks approval. Baseline = the per-test set, not a count. Commit only that set, as `runs/<slug>/baseline.txt` (one `<test id> pass|fail|flaky|skip` line each); raw suite output goes to `<state>/logs/<slug>/`, which is outside the user repo and is never staged. The suite command is `goal.mjs check-command --objective "<objective>"` unless this step found a more specific one; the objective's `check:` wins.
4. **Capability probe.** Check runtime tools and Node/Git versions. If `next` reports `helpers: none` or the harness disallows delegation, skip the spawn probe and take the `nested: none` path below. Otherwise, dispatch a trivial subagent that tries to spawn one and reports.
   - `nested: yes` → implementers run `code-review` themselves.
   - `nested: no` → **flat mode**: implementers do a single-agent review inline (both axes, one pass) and the orchestrator runs `code-review` per ticket after merge; log `degraded: flat spawn`.
   - No subagents → `nested: none`, `max_concurrent_tickets: 1`. Use the brief and ledger for each inline role (CORE.md § Helpers). Log `degraded: no subagents`.
5. **Worker.** With `nested: none`, record `worker: inline` and `tiers: none`. Otherwise use `worker: subagent` unless the objective or `/kun` names `pi[/<provider>/<model>]` (BUILD.md § Implementer backend). `tiers:` maps capability pairs to models (CONTRACT.md § Capability) only when the objective names models or the probe shows the worker takes a model choice; else `tiers: none`.
6. Write the environment contract and `budgets:` into NOW (fields: PIPELINE.md § Completion criteria per stage, 0d).

## Kill switch and GC

- **`STOP`**: `runs/<slug>/STOP` in the control plane, written only by `goal.mjs stop <slug> "<reason>"` (which also sets the registry to `stopped`; `/to-auto --stop [slug]` calls it, CONTROL.md § Run registry). The orchestrator checks it before every stage and every dispatch; every implementer checks it before every slice and returns `stopped` after the current slice. `goal.mjs next` then reports `stop`, which ends a loop; `goal.mjs resume <slug>` lifts it.
- **`--gc`**: `node ROOT/scripts/goal.mjs gc` reports, without changing anything, what finished runs (`done`, `stopped`, `dry-run`) still hold on disk: active worktrees, pool leases, git worktrees no record names, `tmp/<slug>`; free pool slots stay for the next run's caches unless `--slots` is passed. `gc --delete-clean` removes only what loses nothing (a clean tree whose HEAD is on a local branch; `tmp/` of a run that is not `stopped`) and reports the rest as `keep` with the reason; `--all` sweeps every control plane (CONTROL.md § Locks). It collects through `goal.mjs worktree return`, `treehouse return` and (with `--slots`) `treehouse destroy`, never `git worktree remove --force`: a worktree with uncommitted changes stays until it is committed or a verified backup is saved. Never touches a running run, the state folder's private history, `logs/`, branches, or `goal/bootstrap`. Deleting run state itself is `goal.mjs cleanup`, which removes the state folder and leaves no branch or ignore-file edit in the user repo.
- **`--dry-run <objective>`**: stages 0–0d, then a synthetic 3-ticket graph through the 6b gates (claims intersection, criteria-red-at-base check on the baseline), no implementers; leaves the run registered as `dry-run` and reports every command it ran. Use it on a fixture repo after editing this skill.
