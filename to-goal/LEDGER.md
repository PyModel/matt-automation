# Flight ledger

A `/to-goal` run outlives any single context window: compaction, a loop tick, a crashed session, a subagent that finishes hours later. The **ledger** is the run's memory on disk. Every stage reads it before acting and writes it before moving on, so any fresh context can pick the run up from the files alone.

## Layout

All under `.worktrees/control/runs/<objective-slug>/` in the control plane (CONTROL.md), committed after every write, created in stage 0:

| File | What it holds | Written by | When |
|---|---|---|---|
| `ledger.md` | **NOW** block (current stage, next action, active subagents and their worktrees, blockers) followed by an append-only event stream | orchestrator | before and after every stage; on every subagent dispatch and return |
| `todo.md` | The stage checklist and, from stage 6, one line per ticket with status | orchestrator | whenever a box changes |
| `log.md` | Decisions: `- [stage] Q: … → A: … (source: …)` | orchestrator and subagents | at the moment a decision is made |
| `findings.md` | Stage 1 repo facts, requirements R1…, open questions Q1…; stage 3 sourced answers | orchestrator / research agent | stages 1 to 3 |
| `spec.md` | Local copy of the spec (canonical when the tracker is local) | orchestrator | stage 5 |
| `notes/` | Exploration notes for implementers (implement-spec step 2) | exploration subagent | stage 7 |
| `tickets/<NN>.status.md` | Per-ticket flight record: `heartbeat`, `agent: <id/pid>`, `slice: n/m`, worktree, branch, merged range, last commit, suite result, same-test-failure count, review findings, evidence states, claims touched, blockers | the ticket's implementer subagent | after every slice and at exit |
| `kun/` | Cached kun instruction files and `SHA` | orchestrator | stage 0a |
| `STOP` | Kill switch; presence halts dispatch and ends implementers after their current slice | user or `--stop` | any time |
| `bugs.md` | Every bug noticed in flight: file, symptom, introduced-by-run?, action taken (fixed @ commit / ticket NN / blocker) | whoever noticed it | the moment it is noticed |
| `retro.md` | Stage 10 output | orchestrator | stage 10 |

The tracker's ticket files under `.worktrees/control/tracker/<feature-slug>/issues/` stay the source of truth for *what to build*; `tickets/<NN>.status.md` is the source of truth for *how far it got*.

## ledger.md format

```markdown
# to-goal: <objective>

## NOW
- stage: 7 build
- next: dispatch t04 (unblocked by t02 @ a1b2c3d)
- base: <base commit>   review_base: <immutable sha>   bootstrap: <sha or none>   run-branch: goal/<slug>
- kun: <upstream sha> (cached)   matt-pin: <vendor sha from matt.mjs check>   run_id: 3   nested: yes   dirty-checkout: no
- quarantine: 2 tests (see quarantine.json)
- commands: install=`pnpm i` typecheck=`pnpm tsc` lint=`pnpm lint` test1=`pnpm vitest run <file>` suite=`pnpm test`
- per-worktree: PORT=3000+NN, DATABASE_URL suffix _tNN, copy .env with suffix
- budgets: concurrent 3/3 used 2, agents 40 used 9, wall-clock 8h used 1h07, bug-tickets 3 used 0
- baseline: suite green @ base (412 tests)
- active: t03 → .worktrees/goal-<slug>-t03 (started 14:02, slice 2/4) ; t05 → … 
- blockers: wizard script .worktrees/control/runs/<slug>/wizard-stripe.sh (t06 waits)
- leads: [review] possible Feature Envy in OrderIntake (uncited, not acted)

## Events
- 13:40 [0] worktree .worktrees/goal-<slug> on goal/<slug> from 9f8e7d6
- 13:41 [0b] setup: local tracker, labels default, single-context (source: default)
- 13:55 [1] findings.md written, R1–R7, 11 sources
- …
- 14:20 [7] t03 dispatched → worktree …, brief: ticket 03, spec.md, CONTEXT.md, tier 2
- 14:47 [7] t03 back from its implementer: suite green, review 0 cited / 1 lead, commit c0ffee1
- 14:48 [7] t03 merged ff into goal/<slug>; worktree removed; ticket closed
```

Rules:

- **NOW is rewritten, Events are appended.** NOW is what a fresh context reads first; Events are how it verifies NOW.
- One event per stage transition, subagent dispatch, subagent return, merge, blocker, bug noticed (`[bug]`), and compaction. Time-stamped, stage-tagged, one line.
- Never paste artifacts into the ledger: point at files, commits, ticket ids.
- The ledger is committed with `goal.mjs commit` after every write, so every run's history is one `git log goal/control`.

## todo.md format

```markdown
# to-goal todo: <objective>

## Stages
- [x] 00 wiring and ask-matt
- [x] 0 register
…
- [x] 2 on-ramp (skipped: plain feature)
…
- [ ] 7 build
…

## Tickets (stage 7)
| NN | title | blocked by | status | worktree | last commit |
|---|---|---|---|---|---|
| 01 | prefactor: extract OrderIntake seam | none | done | removed | 1a2b3c4 |
| 02 | … | 01 | done | removed | … |
| 03 | … | 01 | in-flight (slice 2/4) | .worktrees/goal-<slug>-t03 | c0ffee1 |
| 04 | … | 02 | ready-for-agent | | |
| 05 | … | 02, 03 | blocked | | |
```

The Stages section is exactly what `goal.mjs init` writes: one `- [ ] <id> <name>` line per stage, in order. Tick a stage `[x]` when its criterion holds; a skipped stage is ticked with `(skipped: <reason>)`. `goal.mjs next` reads this grammar and reports a todo.md missing any stage line as malformed.

The Tickets table mirrors the tracker's statuses (CONTROL.md § Tracker grammar): `blocked` → `ready-for-agent` → `in-flight` → `done`, or `stuck` with its reason (heartbeat / no progress / failing test ×5 / too big / claims breach ×2, named in NOW). When a prerequisite is stuck, its dependents become `blocked: prerequisite <id> stuck`.

## Re-entry protocol

On every entry into the run that is not the first (a loop tick, a resumed or compacted session, a subagent that must orient):

1. Run `node ROOT/scripts/goal.mjs next <slug>`. `stop` → end with the report; `done` → reply "done" and end (under a loop, stop the loop); `malformed` → rewrite `todo.md` from the events, then run it again. Otherwise it names the stage and the one phase file to load. It trusts the files over the checkboxes: a ticked stage whose artifact is missing comes back as the stage to redo.
2. Read `ledger.md` NOW and the last 20 events.
3. Verify NOW against the world: `git worktree list`, `git log -1` on the run branch, each `tickets/<NN>.status.md` for in-flight tickets, the tracker's ticket statuses. A ticket NOW calls active is **stuck** per BUILD.md § Stuck detection (stale heartbeat with dead agent, frozen slice counter without active command, repeated non-quarantined failing test, slice or time cap, agent gone): confirm process termination/revoke lease and re-dispatch once from its status file; never twice.
4. Resume at the stage `next` named, checking its completion criterion (PIPELINE.md). Never redo a stage whose artifacts exist and verify; never trust NOW over the artifacts.
5. Append a `[re-entry]` event saying what was verified and where the run resumed.

## Compaction and context pressure

- Before any compaction (harness-triggered or chosen at a phase boundary), rewrite NOW so it is sufficient on its own, append a `[compact]` event, commit. The compaction summary is seeded with: "resume from `.worktrees/control/runs/<slug>/ledger.md`".
- Subagent briefs never carry state that the ledger holds; they carry the path to it.
- Stages 1 to 6 stay in one window when they can; if the window nears the smart zone, compact **only** at a stage boundary after the ledger is written.

## Subagent contract

Every subagent brief ends with: "Spawn no agents; load only the skills named in your brief, by path (SKILL.md § Loading skills). Before you start, read `ledger.md` NOW and your `tickets/<NN>.status.md` if it exists. After every slice and before you return, update `tickets/<NN>.status.md` (slice, commit, suite, evidence states, blockers). Append decisions you make to `log.md`. Any bug you notice in any file goes into `bugs.md` and is fixed or ticketed now, never deferred (BUILD.md § Bugs found in flight). Return only: commit hash, suite result, cited review findings, blockers."
