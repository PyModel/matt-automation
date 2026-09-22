---
name: to-new
description: "Greenfield route of /to-goal: create a new project, package, service, or agent skill from nothing, autonomously. Creates the directory and repository when none exists, scaffolds a runnable baseline so the environment contract holds, researches stack and versions up front through research-stack, maps the effort with wayfinder, then runs the same grill → spec → tickets → build → review → retro pipeline on the same control plane. Use on /to-new <thing to create> or $to-new."
user-invocable: true
argument-hint: "<what to create> [at <path>] [--force] [budget: …]   |   --stop [slug]"
metadata:
  short-description: "scaffold → research the stack → wayfinder map → grill → spec → tickets → build → review, for a thing that does not exist yet."
---

# to-new

`/to-new` is `/to-goal` for a target that does not exist yet. Let `ROOT` be the parent of this folder's real path (`realpath`, as in to-goal SKILL.md § Loading skills). Read `ROOT/to-goal/SKILL.md` and follow it verbatim, phase files included, with the overrides below. `/to-goal` itself switches to these overrides when stage 1 classifies an objective `greenfield`.

## What counts as greenfield

- The current directory is not inside a git repository, or the repository has no commits, or it has no source tree yet.
- The objective says to create, start, bootstrap, or scaffold a new project, package, service, app, library, CLI, or agent skill, even inside an existing repository (a new package in a monorepo, a new skill folder in a skills hub).

Anything else is a `/to-goal` or `/to-bug` run.

## Overrides

- **Argument.** What to create. `at <path>` names the location; otherwise: an objective inside an existing repository creates the package or skill folder there; a new project defaults to `~/Projects/active/<slug>` (the user's `mkproj` convention) unless the current directory is empty, in which case it is created in place. Slug prefix `new-`; registry `kind: new`. The location is logged as decision D1 with the rule that chose it.
- **Stage 0 precondition, before BOOTSTRAP.md.** Classify the repository state: absent, unborn (git repo with no commits), empty-but-committed, or established. If absent: create the directory, `git init -b main`. If absent or unborn: write a one-line `README.md` and a `.gitignore` for the chosen stack, and make the first commit `git add -A && git commit -m 'Initialize <slug>'`. This ensures a valid base commit exists before worktree setup; it is logged as an event. Then BOOTSTRAP.md runs as written (control plane, kun cache, setup on `goal/bootstrap`, run worktree, environment contract). No remote is created and nothing is pushed unless the objective names a remote.
- **Stage 0d environment contract** is allowed to be empty at first entry (`commands:` all `none`, baseline `empty`). It is re-run after the scaffold ticket merges, and only then are the per-test baseline, quarantine, and capability probe recorded. Until then the ledger NOW carries `contract: pending scaffold`.
- **Stage 1 route is pinned.** Log `classification: greenfield (pinned by /to-new)`, route `wayfinder`, research need `up-front`. Repo exploration covers only what exists (a monorepo's conventions, an existing skills hub's layout, `~/.agents/skills` for a skill).
- **Stage 3 research runs first and fully.** Load `research-stack`; one `research` call per stack choice and per dependency: the runtime and its current LTS, the framework or library and its current major, the test runner, the lint and format tools, the package manager. Every dependency in the scaffold is pinned to a version that a source in `findings.md` names; no version comes from memory. For an agent skill: the Agent Skills format and the harnesses it must load on (Claude Code, Codex) come from `writing-for-agents` and the local hub, not the web.
- **Stage 2 on-ramp is `wayfinder`,** run after research so the map's decision tickets have facts to settle them. Its decision tickets are self-answered per KUN.md; `/kun` decides taste (naming, layout, strictness); the objective decides scope; the research decides versions. The map merges at stage 5 as `to-spec <map path>`.
- **Stage 6 tickets: ticket `01` is always the scaffold.** Claims `exclusive` on the whole new tree; acceptance criteria: install, typecheck, lint, an empty test suite, and a smoke command all exit 0 from a clean clone of the run branch; a `CONTEXT.md` and `docs/agents/` layout from stage 0b in place; the `commands:` block of the environment contract filled from the scaffold's real scripts. Every other ticket is blocked by `01`. Prefactoring tickets do not exist here; `zero-tech-debt` is not on this route.
- **Skill deliverables** (objective creates a skill): the ticket set is `SKILL.md` under the frontmatter rules in `writing-for-agents`, `agents/openai.yaml`, reference files by progressive disclosure, and a symlink into `~/.claude/skills/<name>` when the hub is `~/.agents/skills`. The regression test for a skill is a dry run of its own instructions on a fixture repo, recorded in `spec.md` § Testing Decisions.
- **Defensive-design tiers** are set per module in stage 4 as usual; a brand new tree defaults every module to Tier 1 until a boundary (auth, money, data deletion, external input) raises it.
- **Budgets** are to-goal's, plus one extra re-run of stage 0d after the scaffold merge.
- **Final report** adds: the location, the stack table (component, version, source line in `findings.md`), the scaffold commands, and how to open the result (`cd <path>` and the smoke command). For a project it reminds the user that no remote exists.

## Daily use

- `/to-new <what to create>` from anywhere, then walk away. One run = one repository or one new folder, on branch `goal/new-<slug>`, control plane inside that repository.
- `/to-new --stop [slug]` writes `STOP`; `/to-goal --gc` cleans abandoned runs.
- Follow-on work in the new tree is ordinary: `/to-goal <feature>` and `/to-bug <symptom>` from its root.
