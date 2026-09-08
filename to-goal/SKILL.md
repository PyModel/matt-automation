---
name: to-goal
description: "Autonomous software-factory pipeline over the mattpocock/skills flow map plus research-stack, defensive-design, and zero-tech-debt: route, on-ramp, conditional research, self-answered grilling, to-spec, to-tickets, implement-spec task-graph build in parallel worktrees, code-review, retro, with no pauses. Use on /to-goal <objective> or $to-goal, when the user wants a feature or skill delivered fully autonomously, or under a loop."
user-invocable: true
argument-hint: "<objective> [--force] [budget: …]   |   --gc   |   --stop [slug]   |   --dry-run <objective>"
metadata:
  short-description: "route → on-ramp → research (if needed) → grill → to-spec → to-tickets → build → review → retro, autonomously, on any harness."
---

# to-goal

Drive one **objective** from question to reviewed commits in a single run, on any harness that speaks Agent Skills. The objective is the argument; if empty, take it from the last user message. `--gc` and `--stop <slug>` are maintenance verbs (BOOTSTRAP.md § Kill switch and GC).

This file is an index. Each phase has one file; load a phase file **only when entering that phase**, and nothing else from this folder until then:

| Phase | Stages | File | Load when |
|---|---|---|---|
| Bootstrap | 0 control plane + registry, 0a cache kun, 0b setup, 0c isolate, 0d environment contract + baseline + capability probe | [BOOTSTRAP.md](BOOTSTRAP.md) | at run start, or on re-entry when stage 0 is unmet |
| Plan | 1 route, 2 on-ramp, 3 research (conditional), 4 grill, 4b challenge, 5 spec, 5b reconcile, 6 tickets, 6b claims | [PLAN.md](PLAN.md) | after bootstrap |
| Build | 7 task graph with budgets, heartbeats, claims | [BUILD.md](BUILD.md) | after stage 6b |
| Close | 8 fresh-context review, 9 hand back, 10 retro | [CLOSE.md](CLOSE.md) | after stage 7 |

Always-on references, pointed at from the phase files: [CONTROL.md](CONTROL.md) (the shared committed control plane, locks, run registry, tracker grammar), [KUN.md](KUN.md) (how every question is answered), [LEDGER.md](LEDGER.md) (flight records and re-entry), [PIPELINE.md](PIPELINE.md) (completion criteria, defaults, isolation, budgets), [FLOWS.md](FLOWS.md) (skill map and routing tree), [PITFALLS.md](PITFALLS.md) (known sub-skill bugs and guards), [INTEGRATION.md](INTEGRATION.md) (all skills and their touchpoint substitutions).

## Rules that hold in every phase

- **Autonomous.** The user is not in the loop from invocation to final report. Never call an ask-the-user tool, never end a turn with a question, never wait. Every question any sub-skill would put to a human goes to `/kun` per KUN.md. Actions that cannot be undone and were not named in the objective (force-push, deleting data, pushing to a remote, spending money) and hard blockers (missing credentials, a tool failing twice) are recorded as **blockers**, not asked; independent work continues.
- **Ledger.** All run state lives in the control plane (CONTROL.md), committed after every write. Read `ledger.md` NOW before every stage; write NOW, an event, and `todo.md` after it; log every decision in `log.md`; commit on the run branch. On any entry that is not the first, run the LEDGER.md re-entry protocol and resume at the first unmet criterion in PIPELINE.md.
- **Budgets.** PIPELINE.md § Budgets caps concurrent subagents, total agents, tokens per ticket, and wall-clock. Exceeding one is a blocker: write the ledger and halt cleanly at the next boundary. Every subagent brief carries "spawn no agents" unless it is the orchestrator, `code-review`, or `research`'s single background agent.
- **Kill switch.** `runs/<slug>/STOP` in the control plane halts dispatch at the next boundary; the orchestrator checks it before every stage and dispatch, every implementer before every slice.
- **Redaction.** Every command output written to a ledger, status, bug, or notes file has secrets replaced with `<REDACTED>` first (tokens, keys, passwords, auth headers, connection strings with credentials); loops are built against env vars so the value never appears.
- **No deferred actions.** Any bug noticed in any file is recorded in `bugs.md` and fixed or ticketed now (BUILD.md § Bugs found in flight). `TODO`, `FIXME`, `HACK`, swallowed exceptions, and disabled tests are prohibited in the diff and are cited review findings.
- **Sub-skill invocation.** Let `SKILLS` be the directory containing this folder. Model-invoked skills are fired with the harness skill tool, one per call: `research`, `kun`, `grilling`, `domain-modeling`, `codebase-design`, `tdd`, `code-review`, `diagnosing-bugs`, `wizard`, `writing-for-agents`, `improve-codebase-architecture`, `resolving-merge-conflicts`, `research-stack`, `defensive-design`, `zero-tech-debt`. User-invoked skills cannot be fired by any tool: read `SKILLS/<name>/SKILL.md` and follow it verbatim: `ask-matt`, `grill-with-docs`, `to-spec`, `to-tickets`, `implement`, `implement-spec`, `triage`, `wayfinder`, `handoff`, `to-questionnaire`, `retro`, `setup-matt-pocock-skills`. If a file is missing, say which and stop. If the harness has a same-named built-in (Claude Code's `code-review`), qualify it (`mattpocock-skills:code-review`) or load by path. `prototype`, `grill-me`, `teach`, `wait-what` are never used: they exist for a human to react to.
- **External lookups** go through `research-stack` (loaded on first need, PLAN.md stage 3), never a raw web search. Research is conditional: a bug, refactor, or upkeep objective usually needs none; only an open external question (FLOWS.md § Research need) fires `research`.
- **Phase boundaries.** Continue through stage 6 when the window allows; subagent per ticket in stage 7; compact only at a stage boundary after NOW is rewritten and committed, seeding the summary with "resume from `.worktrees/control/runs/<slug>/ledger.md`".

The user's shorthand maps as: `/ask matt` → ask-matt, `/to spec` → to-spec, `/to ticket` → to-tickets, `/implement` → implement, `/kun` → kun.

## Daily use

- `/to-goal <objective>` from the repo root, then walk away. One run = one branch `goal/<slug>` to merge when you are back.
- `/to-bug <symptom | failing command | issue>` is this pipeline with the route pinned to `diagnosing-bugs` and the bug fast path armed (PLAN.md § Bug fast path). `/to-new <thing to create>` is this pipeline for a greenfield project, package, service, or skill, with the repo and scaffold created first. Both live in sibling folders and override only what their SKILL.md lists.
- `/loop /to-goal <objective>` re-enters each tick via the re-entry protocol and stops itself when the final report exists.
- Several objectives at once: one session per objective; worktrees and the per-feature local tracker keep them apart.
- `/to-goal --stop [slug]` writes `STOP`; `/to-goal --gc` removes abandoned worktrees; `/to-goal --dry-run <objective>` runs stages 0–0d and the 6b gates on a fixture without dispatching implementers.
- Factory history: `git log goal/control`; live board: `cat .worktrees/control/runs/<slug>/todo.md`.
- To overturn a decision: edit it in `log.md`, delete the stage artifacts after it, re-run.

## Final report

One message, outcome first: what shipped, the run branch and worktree path (or PR URL), commit hashes, branch point, where the spec and tickets live, the ledger path, budget used, blockers in one sentence each, review leads left unacted, any `wizard` script awaiting the user, and the retro path.
