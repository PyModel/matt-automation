# Flow map and routing tree

The mattpocock/skills set (25 skills), grouped as aihero.dev/skills groups them ("by when you reach for them") and routed as `ask-matt` maps it (upstream commit 3cca18b, 2026-09-04). Sources: https://www.aihero.dev/skills and https://github.com/mattpocock/skills. Each skill's own page is `https://aihero.dev/skills-<name>`. Invocation kind decides how a skill is reached (see SKILL.md).

The six groups, in the order the site presents them: **Getting Started** (set up once, then find your way around), **The Main Flow** (the idea→ship spine, in order), **Shaping** (explore an open question and produce a decision that feeds the flow), **Upkeep** (keep codebase and issue list healthy; generates work for the flow), **Productivity** (human-facing workflows, not about code), **Reference** (the reusable layer other skills invoke or cite).

## The skills

| Skill | Group | Kind | Role in the map |
|---|---|---|---|
| ask-matt | 01 Getting started | user | Router. Names the route; never fires it. |
| grill-with-docs | 02 Main flow | user | Head of the main flow. One line: calls `grilling` + `domain-modeling`. Stateful: `CONTEXT.md`, ADRs. |
| grill-me | 05 Productivity | user | Same interview, stateless; only when there is no working directory. |
| grilling | 06 Reference | model | The interview primitive: rounds, frontier, a recommended answer per question. |
| domain-modeling | 06 Reference | model | Glossary and ADR discipline underneath grilling. |
| codebase-design | 06 Reference | model | Deep-module vocabulary (module, interface, depth, seam, adapter). `tdd` and improve-codebase-architecture speak it. |
| prototype | 03 Shaping | model | Throwaway artifact for a human to react to. **Not used by /to-goal** (HITL by definition). |
| research | 03 Shaping | model | Background agent, primary sources only, one cited Markdown file. Feeds the grilling. |
| to-spec | 02 Main flow | user | Conversation → spec issue. Sketches seams first. Multi-session branch only. |
| to-tickets | 02 Main flow | user | Spec → tracer-bullet tickets with blocking edges. Expand–contract for wide refactors. |
| implement | 02 Main flow | user | Build a finished spec or ticket into code, test-first: tdd at seams → suite → code-review → commit. Never closes the ticket. The per-ticket brief inside implement-spec. |
| implement-spec | in-progress | user | Task-graph runner: exploration subagent, implementer per worktree, merger, frontier re-kick, draft PR, single fix subagent. **The stage-7 driver.** |
| retro | in-progress | user | Session retrospective: environment improvements by category. Stage 10, report only. |
| research-stack | external (PyModel) | model | Routed, cost-bounded external lookup over context7 / tavily / firecrawl. Wraps every `research` call. |
| defensive-design | external (PyModel) | model | Consequence tiers and proportional controls; Design / Implement / Review modes. Stages 4, 5, 7, 8. |
| zero-tech-debt | external (PyModel) | model | Refactor toward intended shape; pre-flight, 7-step workflow, scope discipline. On-ramp for refactor objectives; prefactoring tickets. |
| tdd | 06 Reference | model | Red-green at pre-agreed seams; no refactor phase; mocks at boundaries only. |
| code-review | 02 Main flow | model | Two axes, Standards and Spec, in separate subagents; never merged. |
| triage | 04 Upkeep | user | On-ramp: raw incoming issues → agent-ready issues via the five labels. Not for tickets you generated. |
| diagnosing-bugs | 04 Upkeep | model | On-ramp: tight red feedback loop before any theory; regression test; post-mortem. |
| wayfinder | 03 Shaping | user | On-ramp: too foggy for one session → map of decision tickets; hands off at `to-spec #<map>`. Spawns `research` per research ticket. |
| improve-codebase-architecture | 04 Upkeep | model | Upkeep: surveys deepening opportunities; each candidate is an idea for the main flow. |
| handoff | 05 Productivity | user | Portable Markdown to a new harness, directory, or colleague. Narrow. |
| to-questionnaire | 05 Productivity | user | Questions for the one person who holds the missing knowledge. |
| resolving-merge-conflicts | 04 Upkeep | model | Finish an in-progress merge or rebase hunk by hunk, by intent; never aborts. Off every flow. |
| wizard | 04 Upkeep | model | Bash wizard for human-only steps (credentials, dashboards, cutovers). |
| wait-what | 05 Productivity | user | Re-explain the last message in `CONTEXT.md` vocabulary. |
| teach | 05 Productivity | user | Multi-session learning workspace. Off every flow. |
| writing-for-agents | 05 Productivity | model | Reference for writing skills, `AGENTS.md`, `CLAUDE.md`. |
| setup-matt-pocock-skills | 01 Getting started | user | Precondition: tracker, labels, doc layout. `/to-goal` runs it in stage 0 with pre-filled answers (local markdown by default). |

## Chosen pathway

Candidates considered, from the upstream map and the in-progress bucket:

| Pathway | Friction with the user | Robustness | Verdict |
|---|---|---|---|
| A. `implement` per ticket, `/clear` between (the documented rhythm) | High: one session per ticket, human closes tickets and advances the frontier | Good per ticket; frontier stalls without a human | Rejected as the driver; kept as the per-ticket brief |
| B. `implement-spec` task graph (in-progress): exploration subagent, implementer per worktree, merger, frontier re-kick, single fix subagent (draft PR only on a GitHub tracker) | Lowest: one invocation, one run branch to merge | Highest: isolation per ticket, concurrency bounded by the blocking edges, one integration point | **Chosen** as the stage-7 driver |
| C. `wayfinder` map worked to completion, then `implement` | Medium: built for HITL decision tickets | Strong for foggy efforts only | Kept as the on-ramp for fog, merging at `to-spec #<map>` |
| D. grilling → `implement` directly (small-build branch) | Low, but the run then has no spec for `code-review`'s Spec axis and no tickets for concurrency | Weak: nothing fresh-context sized | Rejected |

B wins because every stage after the grilling produces an artifact the next stage consumes without a human (spec → tickets → graph → PR), and every seam of failure (a stuck ticket, a merge conflict, a review finding) is handled by a dedicated subagent type rather than a pause. Its known gaps (it is in-progress upstream, and says nothing about seams, tiers, or tracker closing) are filled by the bindings in SKILL.md stage 7.

Three skills outside the Matt set deepen the pathway:

- **research-stack** (model): the routed, cost-bounded way to reach outside the repo (context7 → tavily → firecrawl). Every external lookup in every stage and subagent goes through it.
- **defensive-design** (model): consequence tiers 0–3 and proportional controls per module. Design mode in stage 4, tier and controls into the spec in stage 5, Implement mode per ticket in stage 7, Review mode over Tier 2/3 diffs in stage 8. This is what makes the build "deep architecture" rather than happy-path code.
- **zero-tech-debt** (model): the on-ramp for refactor-shaped objectives and the discipline for prefactoring tickets. Its "approved" gates are self-approved and logged; its scope rule (one coherent end state) is kept verbatim.

## Routing tree (stage 1)

Walk top to bottom; the first match sets the on-ramp, then everything continues onto the main flow.

1. **Is the objective a raw incoming issue someone else filed?** → on-ramp `triage`, then main flow from the agent-ready issue.
2. **Is the checkout mid-merge or mid-rebase?** → `resolving-merge-conflicts` first; then re-enter this tree.
2b. **Is something broken, flaky, or regressed?** → classification `bug`: on-ramp `diagnosing-bugs` (loop goes red first, then fix with a regression test), then PLAN.md § Bug fast path decides whether stages 4 to 6 run. If its post-mortem finds no seam to lock the bug down, queue `improve-codebase-architecture` as a lead in the report. `/to-bug` enters here directly.
3. **Is the objective a refactor, cleanup, rewrite, or modernization of a named area?** → `zero-tech-debt` on-ramp: run its pre-flight and write the one-paragraph end state; that paragraph is the idea; continue. Hotfix-shaped objectives go to branch 2b instead.
3b. **Is the objective upkeep with no target named?** → `improve-codebase-architecture`; take the report's top recommendation as the idea; continue.
4. **Is there no repo, an empty repo, or is the objective to create a new project, package, service, or skill?** → classification `greenfield`: switch to the `to-new` overrides (`SKILLS/to-new/SKILL.md`), which scaffold first and then run the `wayfinder` on-ramp.
4b. **Is the effort too foggy or large for one session (huge feature)?** → on-ramp `wayfinder`; resolve its decision tickets self-answered; merge at stage 5 with `to-spec #<map>`. Never loop the map straight into implement.
5. **Does a question need runnable code to settle?** → no prototype in autonomous mode: a red test at the seam (`tdd`) or a `research` call, else the logged default.
6. **Is knowledge missing that only a specific person has?** → `to-questionnaire`; the questionnaire is a blocker in the report; continue with defaults.
7. **Is there a step only a human can perform?** → `wizard` at the point it bites (stage 7); its script is a blocker in the report.
8. **Otherwise** → plain main flow: grill-with-docs → to-spec → to-tickets → implement → code-review.

## Research need (stage 1 output)

Research is a cost, not a stage every run pays. Stage 1 sets one of three values; stage 3 and every later subagent obey it.

| Classification | Default need | Fires `research` when |
|---|---|---|
| bug | none | a hypothesis names third-party behaviour or an unpinned library contract |
| issue (triage) | none | verification needs a doc the repo lacks |
| refactor (zero-tech-debt) | none | the intended shape depends on a library feature or version |
| upkeep (improve-codebase-architecture) | none | never by default |
| feature inside the repo's existing stack | none | a grilling round meets an external unknown |
| feature touching an external API, SDK, protocol, or new dependency | up-front | always, one question per API, behaviour, or version claim |
| fog (wayfinder) | targeted | per research ticket, spawned by wayfinder |
| greenfield (to-new) | up-front | stack and version choices; every dependency pinned from a source |

`research-stack` is loaded the first time any of these fires and stays the router for the rest of the run; a raw web search is never used.

Per-skill integration and touchpoint substitutions: [INTEGRATION.md](INTEGRATION.md). Stage text lives in BOOTSTRAP.md, PLAN.md, BUILD.md, CLOSE.md; shared state in CONTROL.md.

`/to-goal` always keeps the spec and tickets even when the build would fit one window: the run is autonomous and multi-context by construction (one fresh context per ticket), which is the condition under which `to-spec` earns its step.

## On-ramp completion criteria (stage 2)

- **triage**: the issue carries one of the five labels; if `ready-for-agent`, it has acceptance criteria.
- **diagnosing-bugs**: one command goes red on the bug before any theory; a regression test is red then green; post-mortem written.
- **wayfinder**: every decision ticket on the map is resolved with a logged answer; research tickets burned down via `research`; map issue identified for `to-spec`.
- **improve-codebase-architecture**: candidate list produced; one chosen and logged as the idea.
- **zero-tech-debt**: every pre-flight box checked from repo evidence; end-state paragraph written; external callers of the changed surface enumerated.

## Context hygiene

Stages 1 to 6 in one window. Stage 7 fresh context per ticket (subagent). `/compact` only at a stage boundary and only before stage 6, seeded with the decision log. `/clear` never mid-run.
