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
- Stage 0a caches kun with upstream `pull-kun.mjs`: `kun/<sha>/` now holds `content/` (kun's own words) beside the four root docs. A cache without `content/MANIFEST.json` is incomplete and is pulled again, seeded from the newest complete cache.
