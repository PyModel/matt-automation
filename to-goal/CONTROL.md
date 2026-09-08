# Control plane: shared, committed, never merged

Every run on a repo shares one **control plane**: the branch `goal/control`, checked out as the worktree `<repo>/.worktrees/control/`. It holds the tracker, every run's ledger, the kun cache, the run registry, and the quarantine list. It is **committed after every write** (history is kept), and it is **never merged into the default branch**: run branches carry only code.

```
.worktrees/control/               # branch goal/control (orphan: `git checkout --orphan`)
  runs.json                       # run registry: slug, objective, RUN_ID, started, status, pid/agent-id, harness
  tracker/<feature-slug>/spec.md
  tracker/<feature-slug>/issues/NN-<slug>.md
  runs/<slug>/ledger.md  todo.md  log.md  bugs.md  findings.md  spec.md  notes/  tickets/NN.status.md  retro.md
  runs/<slug>/STOP                # kill switch (committed so it survives everything)
  kun/<sha>/ENTRY.md TOOLS.md OPINIONS.md VOICE.md
  quarantine.json                 # flaky tests at base, per base commit
  gc.log
```

Locks are the one thing not committed: `$(git rev-parse --git-common-dir)/goal-locks/<name>/` created with `mkdir` (atomic on every filesystem, resolving to the shared common Git directory even inside linked worktrees). Hold a lock over the **entire transaction** (read, validate, write, stage, and commit); write a `pid` file inside it; a lock older than 10 minutes whose pid is dead is stale and may be removed.

| Lock | Guards |
|---|---|
| `control` | creating `goal/control` and its worktree; every transactional write and commit to it. Always stage only the targeted files modified by this transaction (`git -C .worktrees/control add <file-paths> && commit`); never use `git add -A` which sweeps up concurrent agents' incomplete files. |
| `integration` | merging ticket branches into run branch head (rebasing, fast-forwarding, removing ticket worktrees) |
| `bootstrap` | creating `goal/bootstrap` |
| `exclude` | editing `.git/info/exclude` |
| `frontier-<feature>` | reading the frontier and flipping a ticket to `in-flight` |
| `registry` | reading and editing `runs.json` |

Rules:

- Create the control plane once (stage 0, under the `control` lock): `git worktree add --orphan -b goal/control .worktrees/control` (git ≥ 2.42), first commit `Init to-goal control plane`. If it exists, `git -C .worktrees/control pull --ff-only` when a remote tracks it, else nothing.
- Every transactional write to the control plane is wrapped inside the `control` lock from before the write begins through the commit whose subject is `[<slug>] <what>`; the user can read the whole factory's history with `git log goal/control`. Stage only the specific written files.
- The control worktree is shared by every run and every subagent; it is the only path that crosses run boundaries. Nothing under `.scratch/` is created in run worktrees any more.
- `.worktrees/` stays in `.git/info/exclude`; `goal/control` is a normal branch and may be pushed if the user wants the factory history on the remote (report says how; never pushed by a run).
- Paths in every other file of this skill that read `.scratch/goal/<slug>/…` mean `.worktrees/control/runs/<slug>/…`; `.scratch/<feature-slug>/…` means `.worktrees/control/tracker/<feature-slug>/…`.

## Run registry (`runs.json`)

```json
[{"slug":"add-login","objective":"…","run_id":3,"started":"2026-09-07T13:40Z","status":"building","harness":"claude-code","agent":"<id or pid>","base":"9f8e7d6","review_base":"9f8e7d6","run_branch":"goal/add-login"}]
```

`run_id` is the next unused integer; it scopes ports and database names (BOOTSTRAP.md § 0c). Slug derivation: lower-case, non-alphanumerics to `-`, collapse, trim to 40 chars; if a **running** entry has the same slug or an objective with ≥ 80 % token overlap, the new run refuses to start and reports the existing slug (duplicate objective) unless the objective says `--force`. A finished entry with the same slug gets `-2`. `--stop` without a slug stops the single running entry, or reports the list when there are several.

## Tracker grammar (local tracker)

The only status line the frontier parser accepts, exactly:

```
**Status:** ready-for-agent | in-flight | done | stuck | blocked | needs-human
```

plus `**Blocked by:** 01, 03` or `None` and `**Claims:** exclusive: a/b.ts, c/ ; shared-regenerate: pnpm-lock.yaml ; guarded: .github/**`. A ticket file without these three lines is malformed and is fixed before dispatch. Frontier = `ready-for-agent` tickets whose every blocker is `done`.
