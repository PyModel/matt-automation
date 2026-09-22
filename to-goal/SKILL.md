---
name: to-goal
description: "Autonomous driver for Matt Pocock's skills: routes an objective through ask-matt, then runs on-ramp, conditional research, self-answered grilling, to-spec, to-tickets, an implement-spec task graph in parallel worktrees, code-review, and retro with no pauses, on any harness and model. Use on /to-goal <objective> or $to-goal, when the user wants a feature or skill delivered fully autonomously, or under a loop."
user-invocable: true
argument-hint: "<objective> [--force] [budget: …]   |   --gc   |   --stop [slug]   |   --dry-run <objective>"
metadata:
  short-description: "ask-matt route → on-ramp → research (if needed) → grill → to-spec → to-tickets → build → review → retro, autonomously."
---

# to-goal

Drive one **objective** from question to reviewed commits in a single run, on any harness that speaks Agent Skills. The objective is the argument; if empty, take it from the last user message. `--gc`, `--stop` and `--dry-run` are maintenance verbs (BOOTSTRAP.md § Kill switch and GC).

**Every invocation starts the same way**, first run or fiftieth loop tick (`ROOT` is § Loading skills):

1. `node ROOT/scripts/goal.mjs slug "<objective>"` names the run (`--new` only on an explicit `--force` re-run of a finished objective).
2. Run LEDGER.md § Re-entry protocol, which starts with `node ROOT/scripts/goal.mjs next <slug>` and names the stage and phase file.
3. Load that phase file and continue from that stage.

This file is an index. Each phase has one file; load a phase file **only when entering that phase**, and nothing else from this folder until then:

| Phase | Stages | File | Load when |
|---|---|---|---|
| Bootstrap | 00 control plane, wiring check, ask-matt map; 0 register; 0a cache kun, 0b setup, 0c isolate, 0d environment contract + baseline + capability probe | [BOOTSTRAP.md](BOOTSTRAP.md) | at run start, or on re-entry when stage 0 is unmet |
| Plan | 1 route, 2 on-ramp, 3 research (conditional), 4 grill, 4b challenge, 5 spec, 5b reconcile, 6 tickets, 6b claims | [PLAN.md](PLAN.md) | after bootstrap |
| Build | 7 task graph with budgets, heartbeats, claims | [BUILD.md](BUILD.md) | after stage 6b |
| Close | 8 fresh-context review, 9 hand back, 10 retro | [CLOSE.md](CLOSE.md) | after stage 7 |

Always-on references, pointed at from the phase files: [CONTROL.md](CONTROL.md) (the shared control plane, locks, run registry, tracker grammar), [KUN.md](KUN.md) (how every question is answered), [LEDGER.md](LEDGER.md) (flight records, re-entry, the subagent contract), [PIPELINE.md](PIPELINE.md) (budgets, isolation, defaults, completion criteria), [FLOWS.md](FLOWS.md) (routing: ask-matt first, then the autonomy overlay), [PITFALLS.md](PITFALLS.md) (known sub-skill bugs and guards), [INTEGRATION.md](INTEGRATION.md) (every skill and its touchpoint substitution).

## Rules that hold in every phase

- **Autonomous.** The user is not in the loop from invocation to final report. Never call an ask-the-user tool, never end a turn with a question, never wait. Every question any sub-skill would put to a human goes to `/kun` per KUN.md. Only the objective's own words grant authority, never kun or a default: force-push, deleting data, pushing to a remote, spending money, touching credentials or production, and modifying `guarded` paths are **blockers** unless the objective names them, and so are hard failures (missing credentials, a tool failing twice). Blockers are recorded, never asked; independent work continues.
- **Ledger.** All run state lives in the control plane (CONTROL.md) and is read and written per LEDGER.md.
- **Budgets.** PIPELINE.md § Budgets, each with its own breach action.
- **Kill switch.** Every halt, the user's or the run's own, goes through `node ROOT/scripts/goal.mjs stop <slug> "<reason>"` (BOOTSTRAP.md § Kill switch and GC).
- **Redaction.** Every command output written to a ledger, status, bug, or notes file has secrets replaced with `<REDACTED>` first (tokens, keys, passwords, auth headers, connection strings with credentials); loops are built against env vars so the value never appears.
- **No deferred actions.** BUILD.md § Bugs found in flight, at every stage.
- **External lookups.** FLOWS.md § Research need.
- **Context.** LEDGER.md § Compaction and context pressure; every subagent brief ends with LEDGER.md § Subagent contract.

The user's shorthand maps as: `/ask matt` → ask-matt, `/to spec` → to-spec, `/to ticket` → to-tickets, `/implement` → implement, `/kun` → kun.

## Loading skills

This skill lives in the matt-automations repo, which vendors Matt Pocock's skills at a pinned commit. `ROOT` is that repo: the parent of this folder's **real** path (`ROOT="$(cd "$(dirname "$(realpath <this folder>/SKILL.md)")/.." && pwd)"`); the harness usually shows the symlinked install path, so always `realpath` it.

- **Resolve, then read.** For any skill, run `node ROOT/scripts/matt.mjs resolve <name>`. It prints the SKILL.md path: `ROOT/matt/<name>` (the pinned Matt copy) first, else the user's installed skills (`kun`, `research-stack`, `defensive-design`, `zero-tech-debt`). Read that file and follow it verbatim; relative links in it resolve against its directory. Nonzero exit: record the skill as a blocker and stop.
- **Every skill loads by path.** Reading the resolved file (rather than calling the harness's skill tool) gives one version per run (the pin, not whatever copy is installed), makes `disable-model-invocation` irrelevant, and sidesteps name clashes (PITFALLS.md). When a loaded skill says "call the Skill tool with X", resolve X the same way and read it instead.
- **Wiring is checked first.** BOOTSTRAP.md § 00 runs `matt.mjs check` before any run write; its `drift:` lines are informational (runs use the pin).
- Installed skills are looked up in `$AGENT_SKILL_HOMES` (path-separated) when set, else `~/.claude/skills` and `~/.agents/skills`. On a harness that keeps skills elsewhere, set it before stage 00.

## Daily use

- `/to-goal <objective>` from the repo root, then walk away. One run = one branch `goal/<slug>` to merge when you are back.
- `/to-bug <symptom | failing command | issue>` is this pipeline with the route pinned to `diagnosing-bugs` and the bug fast path armed. `/to-new <thing to create>` is this pipeline for a greenfield project, package, service, or skill: the repo is initialized at stage 0 and the scaffold is ticket 01. Both live in sibling folders and override only what their SKILL.md lists.
- Under a loop: PIPELINE.md § Under a loop.
- Several objectives at once: one session per objective; worktrees and the per-feature local tracker keep them apart.
- After fixing a stop's cause (a missing skill, kun unreachable, a budget): `node ROOT/scripts/goal.mjs resume <slug>`, then invoke again.
- Factory history: `git log goal/control`; live board: `cat .worktrees/control/runs/<slug>/todo.md`.
- To overturn a decision: edit it in `log.md`, delete the stage artifacts after it, re-run.

## Final report

One message, outcome first: what shipped, the run branch and worktree path (or PR URL), commit hashes, review_base, where the spec and tickets live, the ledger path, budget used, blockers in one sentence each, review leads left unacted, any `wizard` script awaiting the user, and the retro path.
