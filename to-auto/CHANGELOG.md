# Changelog

Behavior that moved. The phase files are the spec; this list is the delta.

- State lives in `--state-dir`, else `TO_AUTO_HOME`, else `~/.local/state/to-auto/<repo-id>`. It is a private git repo. `goal/control` is no longer created in the user repo, and `.git/info/exclude` is no longer edited.
- A linked worktree whose shared git dir is not writable is cloned into the state folder at `goal.mjs prepare`. `goal.mjs land` brings the new commits back, or writes `return.bundle` while the git dir stays read-only.
- `--allow` lists the only folders a run may write. A write outside that list fails at preflight, before any run write.
- `--worker-model` records the requested helper model. `goal.mjs model` records the model each role used. `--no-helpers` records that none ran.
- `scripts/install.mjs` links `to-auto`, `to-bug`, `to-new`, and `to-orc` into skill folders. Scripts resolve their own location from their file path.
- Supervisor mode: `--base`, `--target-branch`, `--status-file`, `--no-remote`. Land writes an item-to-commit summary and does not contact a remote.
- `goal.mjs check-command` reads `check:` from the objective, else AGENTS.md or CLAUDE.md, else a Makefile `check`/`test` target, else package.json `check`/`test`.
- Git 2.42 is not required. `goal.mjs preflight` checks that git is on PATH and the state folder is writable.
- Always-on text is SKILL.md plus CORE.md. Before compacting, rewrite NOW and run `goal.mjs compact`.
- `goal.mjs cleanup` deletes the state folder only.
- Run and ticket worktrees come from `goal.mjs worktree get|return|status`: a treehouse lease when `treehouse` is on PATH, else a git worktree under `<state>/worktrees/`, recorded in `runs/<slug>/worktrees.json`. Docs no longer name a `.worktrees/` layout.
- `goal.mjs check <slug>` / `check --all` report NOW ahead of the registry, a malformed NOW, and a stale registry; `next` reports `blocked` and `compact` refuses when NOW is ahead. Stage 9 moves the registry to done before NOW says done.
- `goal.mjs cleanup` refuses while a run worktree is active or the clone holds unlanded commits.
- Backlog objectives are split into bounded batch runs at admission (BOOTSTRAP.md § 00 step 5); repository rules never skip a stage.
- Stage 0a caches kun with upstream `pull-kun.mjs`: `kun/<sha>/` now holds `content/` (kun's own words) beside the four root docs. A cache without `content/MANIFEST.json` is incomplete and is pulled again, seeded from the newest complete cache.
- `goal.mjs registry` refuses `planning` without an active run worktree, `specced` without `spec.md`, and `ticketed` without tickets, so the registry cannot be walked forward empty to silence `check`. `init` refuses backlog objectives ("fix all N issues"). `check` STALE counts any `[<slug>]` control-plane commit as activity, and stopped runs report nothing until `resume`.
- SKILL.md: the stage `next` names is binding; no repo work before `init`, in-flight work from before the invocation is not resumed outside a run, and a refused objective is never worked around.
