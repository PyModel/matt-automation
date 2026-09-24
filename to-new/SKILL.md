---
name: to-new
description: "Greenfield route of /to-auto: create a new project, package, service, or agent skill from nothing, autonomously. Creates the directory and repository when none exists, researches stack and versions up front through research-stack, maps the effort with wayfinder, scaffolds a runnable baseline as ticket 01, then runs the same grill → spec → tickets → build → review → retro pipeline on the same control plane. Use on /to-new <thing to create> or $to-new."
user-invocable: true
argument-hint: "<what to create> [at <path>] [--force] [budget: …]   |   --stop [slug]"
metadata:
  short-description: "research the stack → wayfinder map → grill → spec → scaffold ticket → build → review, for a thing that does not exist yet."
---

# to-new

`/to-new` is `/to-auto` for a target that does not exist yet. Let `ROOT` be the parent of this folder's real path (`realpath`, as in to-auto SKILL.md § Loading skills). Read `ROOT/to-auto/SKILL.md` and follow it verbatim, phase files included, with the overrides below. `/to-auto` itself switches to these overrides when stage 00 finds no repository or stage 1 classifies an objective `greenfield`.

## What counts as greenfield

- The current directory is not inside a git repository, or the repository has no commits, or it has no source tree yet.
- The objective says to create, start, bootstrap, or scaffold a new project, package, service, app, library, CLI, or agent skill, even inside an existing repository (a new package in a monorepo, a new skill folder in a skills hub).

Anything else is a `/to-auto` or `/to-bug` run.

## Overrides

- **Argument.** What to create. `at <path>` names the location; otherwise: an objective inside an existing repository creates the package or skill folder there; a new project goes where the user's agent instructions (`CLAUDE.md`, `AGENTS.md`, or the harness equivalent) say projects live, else next to the current repository, unless the current directory is empty, in which case it is created in place. The location is logged as the first decision with the rule that chose it. The objective is `new: <what>`, so `goal.mjs slug` yields `new-…` and the run branch is `goal/new-…`.
- **Stage 0 precondition, replacing BOOTSTRAP.md § 00 step 1.** No repository at the location → create the directory, `git init -b main`. No repository or no commits → write a one-line `README.md` and a `.gitignore` for the chosen stack, then `git add -A && git commit -m 'Initialize <slug>'`, logged as an event. Then BOOTSTRAP.md continues as written. No remote is created and nothing is pushed unless the objective names a remote.
- **Stage 0d environment contract** may be empty at first entry (`commands:` all `none`, baseline `empty`, NOW `contract: pending scaffold`). It is re-run after the scaffold ticket merges, and only then are the per-test baseline, quarantine, and capability probe recorded.
- **Stage 1 route is pinned.** ask-matt's on-ramp for a greenfield project too big for one session is `/wayfinder`, which is this route. Log `route: On-ramps → wayfinder (greenfield, pinned by /to-new)`, research need `up-front`. Repo exploration covers only what exists (a monorepo's conventions, an existing skills hub's layout, the harness's installed-skills directory for a skill).
- **Stage 3 research runs first and fully.** One `research` call per stack choice and per dependency: the runtime and its current LTS, the framework or library and its current major, the test runner, the lint and format tools, the package manager. Every dependency in the scaffold is pinned to a version that a source in `findings.md` names; no version comes from memory. For an agent skill: the Agent Skills format and the harnesses it must load on come from `writing-for-agents` and the local hub, not the web.
- **Stage 2 on-ramp is `wayfinder`,** run after research so the map's decision tickets have facts to settle them. `/kun` decides taste (naming, layout, strictness); the objective decides scope; the research decides versions.
- **Stage 6 tickets: ticket `01` is always the scaffold.** Claims `exclusive` on the whole new tree; acceptance criteria: install, typecheck, lint, an empty test suite, and a smoke command all exit 0 from a clean clone of the run branch; a `CONTEXT.md` and `docs/agents/` layout from stage 0b in place; the `commands:` block of the environment contract filled from the scaffold's real scripts. Its capability is `standard/medium` unless the stack research says otherwise. Every other ticket is blocked by `01`. There are no prefactoring tickets; `zero-tech-debt` is not on this route.
- **Skill deliverables** (the objective creates a skill): the ticket set is `SKILL.md` under the frontmatter rules in `writing-for-agents`, `agents/openai.yaml`, reference files by progressive disclosure, and a symlink from each harness's skills directory the hub serves (for example `~/.agents/skills/<name>` and `~/.claude/skills/<name>`) into the hub. The regression test for a skill is a dry run of its own instructions on a fixture repo, recorded in `spec.md` § Testing Decisions.
- **Defensive-design tiers**: a brand new tree defaults every module to Tier 1 until a boundary (auth, money, data deletion, external input) raises it.
- **Budgets** are to-auto's, plus one extra re-run of stage 0d after the scaffold merge.
- **Final report** adds: the location, the stack table (component, version, source line in `findings.md`), the scaffold commands, and how to open the result (`cd <path>` and the smoke command). For a project it reminds the user that no remote exists.

## Daily use

- `/to-new <what to create>` from anywhere, then walk away. One run = one repository or one new folder, control plane inside that repository.
- `/to-new --stop [slug]` writes `STOP`; `/to-auto --gc` cleans abandoned runs.
- Follow-on work in the new tree is ordinary: `/to-auto <feature>` and `/to-bug <symptom>` from its root.
