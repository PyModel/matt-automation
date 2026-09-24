# Routing: ask-matt first, then the autonomy overlay

`ask-matt` is the map. Stage 00 reads it (`node ROOT/scripts/matt.mjs resolve ask-matt`) at the pinned commit, and stage 1 takes the route it names for the objective. This file does not restate that map. It says what an autonomous run does at each point where ask-matt expects a human, and it adds the one situation ask-matt does not route: a refactor of a named area.

If ask-matt at the pin contradicts this file, follow ask-matt. Record the contradiction in `bugs.md` and the retro proposes the fix to this file. Per-skill stages and substitutes are in [INTEGRATION.md](INTEGRATION.md).

## Routing tree (stage 1)

Test the rows in order; the first match sets the on-ramp. Every route then merges onto ask-matt's main flow. Log `route: <ask-matt section> → <skill> (<classification>)`.

| # | Situation | ask-matt section | Classification | Autonomous route |
|---|---|---|---|---|
| 0 | The checkout is mid-merge or mid-rebase | Standalone: `/resolving-merge-conflicts` | (none) | Resolve first (never `--abort`), then re-enter this table. |
| 1 | The objective is a raw issue someone else filed | On-ramps: `/triage` | `issue` | Triage self-answered; main flow from the agent-ready issue. Never for tickets `/to-auto` created. |
| 2 | Something is broken, flaky, or regressed | On-ramps: `/diagnosing-bugs` | `bug` | Loop goes red first, then fix with a regression test; PLAN.md § Bug fast path decides whether stages 4 to 6 run. A post-mortem with no seam queues `improve-codebase-architecture` as a lead. `/to-bug` enters here directly. |
| 3 | The objective names an approved spec, ticket, or issue in this repo that passes CONTRACT.md § Readiness | The main flow, entered at `/to-spec` or `/implement` | `ready` | PLAN.md § Ready source: stages 2 to 4b skipped; the source becomes `spec.md` or ticket `01`. A failing readiness box falls through to the rows below. |
| 4 | A refactor, cleanup, rewrite, or modernization of a named area | not routed by ask-matt | `refactor` | `zero-tech-debt` pre-flight; its one-paragraph end state is the idea for the main flow. Hotfix shapes go to row 2. |
| 5 | Upkeep with no target named | Codebase health: `/improve-codebase-architecture` | `upkeep` | Report written to the temp dir, not opened; its Top recommendation is the idea for the main flow. |
| 6 | The objective creates a new project, package, service, or skill | On-ramps: `/wayfinder` (a greenfield project) | `greenfield` | The `to-new` overrides (`ROOT/to-new/SKILL.md`): repo initialized at stage 0, research up-front, then the wayfinder map; the scaffold is ticket 01. |
| 7 | Too foggy or large for one session | On-ramps: `/wayfinder` | `fog` | Decision tickets self-answered; merge at stage 5 with `to-spec <map>`. Never loop the map straight into implement. |
| 8 | Otherwise | The main flow | `feature` | grill-with-docs → to-spec → to-tickets → implement-spec (implement per ticket) → code-review. |

Main-flow branch points, answered the same way every run:

- **"Can you settle every question in conversation?"** A question that needs runnable code gets no prototype. It is settled by a red test at the seam (`tdd`) or a `research` call, else the logged default.
- **"Is this a multi-session build?"** Always yes: the run is autonomous and multi-context by construction (one fresh context per ticket), so the spec and tickets are always kept. That is the condition under which `to-spec` earns its step.
- **Knowledge only a specific person has** → `to-questionnaire`; the questionnaire is a blocker in the report; continue with defaults.
- **A step only a human can perform** → `wizard` where it bites (stage 7); its script is a blocker in the report.

## Why implement-spec drives stage 7

ask-matt's documented rhythm is one `/implement` per ticket with `/clear` between, and a human closing tickets and advancing the frontier. Autonomously the frontier would stall. `implement-spec` (in-progress upstream) runs the same `implement` brief per ticket, in its own worktree, with a merger, frontier re-kick, and a single fix subagent. Every stage after the grilling then produces an artifact the next stage consumes without a human (spec → tickets → graph → merged run branch). Its gaps (seams, tiers, tracker closing, worktree layout) are filled by BUILD.md § Bindings.

Three installed skills outside the Matt set deepen the pathway: `research-stack` (every external lookup), `defensive-design` (consequence tiers: Design in stage 4, Implement in stage 7, Review in stage 8), and `zero-tech-debt` (row 4 and prefactoring tickets; its approval gates are self-approved and logged).

## Research need (stage 1 output)

Research is a cost, not a stage every run pays. Stage 1 logs `research: none | targeted: Q1… | up-front`; stage 3 and every later subagent obey it. Any external unknown met later (an on-ramp hypothesis, a grilling round, an implementer, the review) becomes a Q in `findings.md` and fires one `research` call only when its row below says so.

| Classification | Default need | Fires `research` when |
|---|---|---|
| bug | none | a hypothesis names third-party behaviour or an unpinned library contract |
| ready (approved source) | none | the source leaves an external unknown open (an open Q in `findings.md`) |
| issue (triage) | none | verification needs a doc the repo lacks |
| refactor (zero-tech-debt) | none | the intended shape depends on a library feature or version |
| upkeep (improve-codebase-architecture) | none | never by default |
| feature inside the repo's existing stack | none | a grilling round meets an external unknown |
| feature touching an external API, SDK, protocol, or new dependency | up-front | always, one question per API, behaviour, or version claim |
| fog (wayfinder) | targeted | per research ticket, spawned by wayfinder |
| greenfield (to-new) | up-front | stack and version choices; every dependency pinned from a source |

Every external lookup, in every stage and subagent, goes through `research-stack`, loaded the first time one fires and kept as the router for the rest of the run; a raw web search is never used.

## On-ramp completion criteria (stage 2)

- **triage**: the issue carries one of the five labels; if `ready-for-agent`, it has acceptance criteria.
- **diagnosing-bugs**: one command goes red on the bug before any theory; a regression test is red then green; post-mortem written.
- **wayfinder**: every decision ticket on the map is resolved with a logged answer; research tickets burned down via `research`; map issue identified for `to-spec`.
- **improve-codebase-architecture**: candidate list produced; one chosen and logged as the idea.
- **zero-tech-debt**: every pre-flight box checked from repo evidence; end-state paragraph written; external callers of the changed surface enumerated.
