# Untangle decision log (2026-11-09)

**Status 2026-11-28:** not merged. Main fixed D1 and D5 its own way (verified Claude home, no deleting real folders, `ROOT/` substituted in briefs), and D2 to D4 are refactors of a CLI that main has since grown well past; porting them means redoing them. The branch tip survives as the local tag `archive/untangle` (b10f30f), which stays unpushed: its history predates the 2026-11-10 rewrite.

Branch `untangle` in worktree `../.matt-untangle`. Extras chosen by the owner: Comments, Tests.
Baseline: 219 node tests + to-orc selftest + 36 audit checks green at 82133d5.

## Fixes, each above the problems it solves

- [x] D1 One canonical install: `install.mjs` links every repo and Matt skill as `~/.agents/skills/<name>`, then each agent folder relatively; kept entries reported, never deleted; `check` prints `not linked:` (8027058).
  - `~/.claude/skills` was "unverified" and skipped, so `/to-auto` was never linked for Claude ("to-auto not installed").
  - The old installer `rmSync`'d whatever sat at the target, user folders included.
  - Matt skills reached only `~/.agents/skills`; ~70 agent folders had none.
- [x] D2 `runs.mjs` owns the registry read side: state root, sessions dir, run statuses (`ended`, `active`), `readRegistry`, `controlPlanes`, `liveRuns` (06fddab).
  - `matt.mjs` (8 commits) and the guard imported `goal.mjs` (67 commits) for a path and a status list.
  - Run-status sets spelled six ways (`TERMINAL`, `FINISHED_RUNS`, `INACTIVE`, three inline lists).
  - The control-plane scan copied in `liveRuns`, `checkAll`, `keepGoing`.
  - `~/.local/state/to-auto` and the sessions dir built by hand in goal.mjs and the guard.
  - Guard and keep-going had different session-id rules; the guard parsed runs.json raw.
  - `PINNED` missed `install.mjs` and `runs.mjs`, which a run loads.
- [x] D3 One `COMMANDS` table drives the CLI and `--help` (b10f30f).
  - 40 `if` arms with their own arity checks and flag loops; usage in header, USAGE and inline errors.
  - Dead second `root` arm; `USAGE` built by a regex hack.
  - `targetSaved`/`workerModel` set on `runtime` but absent from its defaults.
  - `contract` CLI mutated the result `checkContract` returned.
  - `worktreeStatus` pass-through wrapper.
- [x] D4 `goal.mjs receipt <file>` (worktree defaults to cwd) replaces `receipt-lint.mjs` (b10f30f).
  - receipt-lint was a 5-line wrapper over `checkReceipt` loading all of goal.mjs.
- [x] D5 The implementer brief substitutes `ROOT/` with the checkout path (b10f30f). Bug: pi workers got literal `ROOT/scripts/...`.
- [ ] D6 One on-disk layout in goal.mjs: `issuesDir`, `runPath`, ticket artifact paths, ticket branch name, `orcRunDir` reused.
- [ ] D7 Ticket-field writes go through `writeAndCommit` (amendClaims/waive left files edited on a refused commit); `sinceDispatch` bails on a non-ticket path; `dispatch` refuses a named brief that does not exist; a lock held by an EPERM pid stays held.
- [ ] D8 STAGES carries each stage's registry floor; `STAGE_FLOOR` table goes.
- [ ] D9 Unexport names nothing imports; delete comments that restate code.
- [ ] D10 to-orc: one pid-alive helper (ESRCH only), spend.json read fails closed in both readers, no spawn-per-10ms sleep, dead poll traversal check, atomic run.json writes.
- [ ] D11 Docs: stale `SKILL.md § Rules` pointers → CORE.md, submodule/pin wording, `--gc` wording, to-new install instructions, CHANGELOG false entries, README setup.
- [ ] D12 Tests: one `test-helpers.mjs` (hermetic git env: no global signing/hooks; tmp cleanup), tautologies deleted, weak negatives tightened.
- [ ] D13 install.mjs: a missing SKILL.md is a `broken` row, not a throw mid-install.

## Kept on purpose

- `'nothing to commit'` as a command result: agents and docs read it.
- to-orc duplicates small helpers from goal.mjs: it ships as a standalone skill.
- Shell-level nvm resolution in `node-env.sh`: launchd has no shell profile.
