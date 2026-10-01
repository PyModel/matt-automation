# Core rules

Read this at the start of every phase. It is the only file, besides SKILL.md, that stays loaded. Load a phase file only when entering that phase, and a reference only when the phase file you are in cites it.

- **Autonomous.** Never ask the user, never end a turn with a question, never wait. Questions a sub-skill would ask go to `/kun`. Force-push, deleting data, pushing, spending money, credentials, production, and `guarded` paths are blockers unless the objective names them. A tool failing twice is a blocker. Record blockers; continue independent work.
- **State.** Run state is the folder `goal.mjs control` prints: `--state-dir`, else `TO_AUTO_HOME`, else `~/.local/state/to-auto/<repo-id>`. It is a private git repo. It is not a branch of the user repo. Do not create `goal/control`. Do not edit `.git/info/exclude` or `.gitignore` to hide state.
- **Startup.** `goal.mjs preflight` checks requirements and fails with a clear message. `goal.mjs prepare` clones into the state folder when this checkout is a linked worktree whose shared git dir is not writable. Later git commands run in the workspace it prints. `goal.mjs land` brings those commits back.
- **Writes.** With `--allow`, every planned write must sit inside that list or preflight refuses to start. Do not write anywhere else.
- **Supervisor.** `--base`, `--target-branch`, `--status-file`, `--no-remote`. Commit on the target branch. `--no-remote` forbids `git push`, `pull`, and fetch of a remote; a local path is not a remote. `goal.mjs land` appends a summary that maps each item to its commit.
- **Models.** Pass `--worker-model` when one is named. After a helper returns, `goal.mjs model <slug> <role> <model-used>`. No helpers: `init --no-helpers`, and spawn none.
- **Check.** The suite is `goal.mjs check-command --objective "<objective>"`. A `check:` in the objective wins over the repo.
- **Compact.** Before the harness compacts or clears memory, rewrite NOW so it stands alone, then `goal.mjs compact <slug>`. Never compact between stages 5 and 6b. After any compaction or re-entry, `goal.mjs check <slug>` must exit 0 before the next action.
- **Pipeline.** Repository rules may change how a stage runs, never whether it runs; an objective that does not fit → `goal.mjs stop <slug> "objective does not fit: …"`. Worktrees come only from `goal.mjs worktree get`; the registry moves only through `goal.mjs registry`, before NOW names the new stage.
- **Kill switch.** `goal.mjs stop <slug> "<reason>"`.
- **Redaction.** Replace secrets with `<REDACTED>` before writing a ledger, status, bug, or notes file.
- **Cleanup.** `goal.mjs cleanup` deletes the state folder, and refuses while a run worktree is active or the clone holds unlanded commits. It does not leave a branch or an ignore-file edit in the user repo.
