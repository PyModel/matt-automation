# Control plane: shared, committed, never merged

Every run on a repo shares one **control plane**: the branch `goal/control`, checked out as the worktree `<repo>/.worktrees/control/`. It holds the tracker, every run's ledger, the kun cache, the run registry, and the quarantine list. It is **committed after every write** (history is kept), and it is **never merged into the default branch**: run branches carry only code.

```
.worktrees/control/               # branch goal/control (orphan: `git checkout --orphan`)
  runs.json                       # run registry: slug, objective, run_id, started, status, agent, harness (goal.mjs owns it)
  tracker/<feature-slug>/spec.md
  tracker/<feature-slug>/issues/NN-<slug>.md
  runs/<slug>/ledger.md  todo.md  log.md  bugs.md  findings.md  spec.md  notes/  tickets/NN.status.md  final-verdict.json  retro.md
  runs/<slug>/STOP                # kill switch (committed so it survives everything)
  kun/<sha>/ENTRY.md TOOLS.md OPINIONS.md VOICE.md
  quarantine.json                 # flaky tests at base, per base commit
  gc.log
```

## Locks

Locks are the one thing not committed: `mkdir` directories under `$(git rev-parse --git-common-dir)/goal-locks/`, shared by every worktree. Take them only through `ROOT/scripts/goal.mjs`, which holds the lock for the whole transaction, writes the holder's pid, waits up to 2 minutes for a live holder, and breaks a lock older than 10 minutes whose holder is dead:

- `goal.mjs commit -m "[<slug>] <what>" <file>...` stages exactly those control-plane files and commits them under the `control` lock. This is the only way to commit to the control plane.
- `goal.mjs take <feature> <n>` flips up to `n` frontier tickets to `in-flight` under `frontier-<feature>` and commits them; `goal.mjs status <feature> <id> <status>` sets one ticket's status and commits it.
- `goal.mjs with-lock <name> -- <cmd...>` runs one command under any lock (`integration`, `bootstrap`, `registry`, or `frontier-<feature>` on a GitHub tracker). Locks are re-entrant for that command, so it may call `goal.mjs commit` itself.
- File arguments are paths inside the control worktree (`runs/<slug>/ledger.md`); a path from the current directory that lands inside it (`.worktrees/control/runs/…`) works too.

| Lock | Guards |
|---|---|
| `control` | creating `goal/control`, its worktree, and the `.worktrees/` exclude (`goal.mjs control`); every commit to it (`goal.mjs commit` stages only the named files, so concurrent agents' half-written files stay out). |
| `integration` | merging ticket branches into run branch head (rebasing, fast-forwarding, removing ticket worktrees) |
| `bootstrap` | creating `goal/bootstrap` |
| `frontier-<feature>` | reading the frontier and flipping a ticket to `in-flight` |
| `registry` | reading and editing `runs.json` |

## Rules

- `goal.mjs control` creates the control plane once, under the `control` lock: `.worktrees/` into `.git/info/exclude` (not `.gitignore`, which would be a tracked change), then `git worktree add --orphan -b goal/control .worktrees/control` (git ≥ 2.42), first commit `Init to-auto control plane`. It is idempotent. When a remote tracks `goal/control`, follow it with `git -C .worktrees/control pull --ff-only`.
- Every control-plane write is committed with `goal.mjs commit`, subject `[<slug>] <what>`; the user reads the whole factory's history with `git log goal/control`. A file only one agent writes (its own `runs/<slug>/` files, its ticket status file) needs no lock for the write itself; a file several agents write is written only by the command that owns it: `runs.json` by `init`, `registry`, and `stop`; tracker tickets by `take` and `status`, which read, write, and commit under the ticket lock.
- The control worktree is shared by every run and every subagent; it is the only path that crosses run boundaries.
- `goal/control` is a normal branch and may be pushed if the user wants the factory history on the remote (report says how; never pushed by a run).

## Run registry (`runs.json`)

```json
[{"slug":"add-login","objective":"…","run_id":3,"started":"2026-09-07T13:40:00.000Z","status":"building","agent":"<session id>","harness":"<harness name>"}]
```

`run_id` is the next unused integer; it scopes ports and database names (BOOTSTRAP.md § 0d). `goal.mjs` owns the file: `slug` derives the slug (lower-case, non-alphanumerics to `-`, collapsed, at most 40 chars; `--new` picks the next free `-2`, `-3` for a deliberate re-run), `init` appends the entry, `registry <slug> <status>` moves it (`bootstrapping` → `planning` → `specced` → `ticketed` → `building` → `reviewing` → `done`, or `stopped`, or `dry-run`), `stop` writes `STOP` and sets `stopped`, and `resume` removes `STOP` and restores the status the stop replaced. The entry records the `agent` and `harness` that `init` was given; `--gc` judges liveness by them. The duplicate-run check is BOOTSTRAP.md § 0. `--stop` without a slug stops the single running entry, or reports the list when there are several.

## Tracker grammar (local tracker)

The only status line the frontier parser accepts, exactly:

```
**Status:** ready-for-agent | in-flight | done | stuck | blocked | needs-human
```

plus `**Blocked by:** 01, 03` or `None` and `**Claims:** exclusive: a/b.ts, c/ ; shared-regenerate: pnpm-lock.yaml ; guarded: .github/**`, and optionally `**Capability:** advanced/high` (tier `lightweight | standard | advanced` / intensity `low | medium | high`; absent means `standard/medium`; any other value makes the ticket malformed). Every checkbox line in a ticket is one acceptance criterion, which `goal.mjs receipt` matches by text. A claim is a file, a directory ending in `/`, or a directory ending in `/**`. Frontier = `ready-for-agent` tickets whose every blocker is `done`. `goal.mjs frontier <feature>` computes it, reports each ticket's resolved `capability`, and reports every malformed ticket and every pair of unordered open tickets whose `exclusive` claims overlap; it returns an empty frontier while any ticket is malformed.
