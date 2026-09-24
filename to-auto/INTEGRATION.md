# How every skill is integrated into /to-auto

One row per skill, grouped the way `ask-matt` groups them. **Touchpoint** is where the skill expects a human; **Autonomous substitute** is what `/to-auto` does instead. Every skill is loaded the same way: `node ROOT/scripts/matt.mjs resolve <name>`, then read the file (SKILL.md § Loading skills).

This table is checked: `node ROOT/scripts/matt.mjs check` fails when a vendored Matt skill has no row here, when a row names a skill that resolves nowhere, or when `ask-matt` routes to a skill that is not linked. Bumping the submodule pin is therefore a forced review of this file.

## Main flow (ask-matt § The main flow)

| Skill | Stage in /to-auto | Touchpoint(s) the skill has | Autonomous substitute |
|---|---|---|---|
| ask-matt | 1 | Recommends and stops; user types the next skill | The router. Stage 00 reads it; stage 1 takes the route it names (FLOWS.md § Routing tree). Any load-bearing claim about a skill is checked against that skill's file. |
| grill-with-docs | 4 | Delegates to grilling + domain-modeling | Both loaded; `/to-auto` answers the rounds (see grilling). Verify `CONTEXT.md` changed on disk. |
| to-spec | 5 | "Check with the user that these seams match" | Seams were fixed in stage 4; carried into Testing Decisions; logged `(source: findings)`. Publish to the local tracker, `ready-for-agent`. |
| to-tickets | 6 | "Quiz the user … iterate until the user approves" | Self-quiz (granularity, edges, merge/split) answered per KUN.md; PLAN.md stage 6 and the 6b gate. |
| implement | 7 | None by design; but never closes the ticket | The implementer brief inside implement-spec (BUILD.md): a compiled contract in, a receipt out (CONTRACT.md); the merger checks the receipt against git with `goal.mjs receipt`, then merges; the orchestrator closes the ticket and ticks boxes. |
| tdd | 7 (every slice, in the ticket subagent) | "Confirm seams with the user" | Seams agreed in PLAN.md stage 4 and passed in the brief; BUILD.md implementer brief, rule 2. |
| code-review | 7 (per ticket), 8 (final) | "If they didn't specify a fixed point, ask"; "ask the user where the spec is" | Fixed point always passed (`<ticket-base>` or `review_base`); spec path always passed. Brief guards per PITFALLS.md (code-review rows). |
| handoff | phase boundary only | Writes a portable doc | Only when the run must move harness or directory (e.g. a ticket needs a tool this harness lacks). Otherwise subagents carry context pointers. |
| prototype | skipped | Produces an artifact for a human to react to; HITL by definition | A question that "needs runnable code" is answered by a red test at the seam (tdd) or a research call; if neither settles it, log the default and continue. |

## On-ramps (ask-matt § On-ramps)

| Skill | Stage in /to-auto | Touchpoint(s) the skill has | Autonomous substitute |
|---|---|---|---|
| triage | 2 (raw issues) | "Wait for direction" after recommending; "ask the maintainer" on conflicting states | Apply own recommendation; on conflicting state labels pick `needs-triage` and log. Verify the claim (reproduce) before grilling; outcome `ready-for-agent` gets an agent brief; the issue becomes the objective's parent. Only for issues `/to-auto` did not create. |
| diagnosing-bugs | 2 (broken objectives; arms PLAN.md § Bug fast path); 7 (a red test that will not go green for a reason the ticket did not predict) | "Show the ranked list to the user before testing. Don't block on it" | Already AFK-safe: proceed with own ranking; HITL bash loop becomes a blocker. Regression test at the correct seam; "no correct seam" is logged as a lead for improve-codebase-architecture. |
| wayfinder | 2 (fog) | HITL ticket types (grilling, prototype, task); "never resolve more than one ticket per session"; "stop and ask the user how they'd like to proceed" when no fog | Grilling tickets are self-answered, prototype tickets are re-typed as grilling or research, task tickets that need a human become a `wizard` script and a blocker. Resolves every frontier ticket in the run, one fresh subagent per ticket, research tickets in parallel. Merges at stage 5 via `to-spec #<map>`. |

## Codebase health and vocabulary (ask-matt § Codebase health, § Vocabulary underneath)

| Skill | Stage in /to-auto | Touchpoint(s) the skill has | Autonomous substitute |
|---|---|---|---|
| improve-codebase-architecture | 2 (upkeep objectives) | Opens an HTML report and asks "Which of these would you like to explore?" | Write the report to the temp dir but do not open it; take the report's **Top recommendation** as the idea; then grilling self-answered. User-invoked upstream (`disable-model-invocation: true`), so it can only ever be loaded by path. |
| codebase-design | 4 (seam placement, new module shape); 7 via tdd | None (reference); `DESIGN-IT-TWICE.md` spawns parallel sub-agents | Loaded in stage 4 whenever a new module or seam is proposed; run design-it-twice for any new external seam and pick by depth/locality, logged. |
| domain-modeling | 4; 2 (triage, wayfinder, improve-codebase-architecture) | "Offer to create an ADR" | Create the ADR when all three gates pass; otherwise skip; both logged. `CONTEXT.md` updated inline. |

## Standalone (ask-matt § Standalone)

| Skill | Stage in /to-auto | Touchpoint(s) the skill has | Autonomous substitute |
|---|---|---|---|
| grilling | 4; 3 | Rounds wait for the user's answers; "do not act until the user confirms" | Rounds run in full, answered per KUN.md § Grilling rounds (the skill's recommended answer goes to kun as input); facts are found by sub-agents as the skill says. |
| research | 3 (conditional, per open Q); 2 (wayfinder research tickets); 4, 7, 8 on demand | None (AFK) | Fires only per FLOWS.md § Research need; briefed per PITFALLS.md (research rows); findings kept in `runs/<slug>/findings.md`. |
| resolving-merge-conflicts | 7 (ticket-branch rebase onto run branch); 0 (checkout already mid-merge) | None | As-is. Never `--abort`. |
| to-questionnaire | 4 (a question only a named person can answer) | Two interview exchanges about the send | Answer the two exchanges from the decision log (recipient = repo owner unless the objective names someone); write `to-questionnaire-<slug>.md` in `.worktrees/control/runs/<slug>/`; continue with the default and list the file as a blocker. |
| wizard | 7 (human-only step), 2 (wayfinder task ticket) | "Show the user the ordered list of stages and confirm" | Skip confirmation; author from repo evidence only, never invent UI steps; `bash -n` + shellcheck; script path is a named blocker in the report. |
| writing-for-agents | 4 and 7 when the deliverable is a skill, `AGENTS.md`/`CLAUDE.md`, or agent-facing doc | None (reference) | Loaded as the standards source for those files; `code-review`'s Standards axis cites it. |
| grill-me | not used | Stateless interview | Superseded by grill-with-docs; a run always has a working directory (the run worktree). |
| teach | not used | Multi-session learning workspace | Off every flow. |
| wait-what | not used | Re-explains to a human | Nothing to re-explain autonomously. The final report uses `CONTEXT.md` vocabulary instead. |

## Precondition (ask-matt § Precondition)

| Skill | Stage in /to-auto | Touchpoint(s) the skill has | Autonomous substitute |
|---|---|---|---|
| setup-matt-pocock-skills | 0b | "Present findings and ask" per section; "let them edit before writing" | Answers pre-filled from PIPELINE.md § Setup defaults (local markdown by default); write directly. |

## In-progress upstream, not routed by ask-matt

| Skill | Stage in /to-auto | Touchpoint(s) the skill has | Autonomous substitute |
|---|---|---|---|
| implement-spec | 7 | "The goal is a PR"; nothing else human | Run as written; bindings in BUILD.md add seams, tiers, tracker closing, and the worktree layout from PIPELINE.md. Draft PR only on a GitHub tracker with push authorized. |
| retro | 10 | "Present these candidates to the user" | Written to `.worktrees/control/runs/<slug>/retro.md`; nothing applied. |
| pr | 9 (GitHub tracker with push explicitly authorized only) | None; a PR-body template | The draft PR body from implement-spec step 3 and the ready-for-review body in stage 9 follow its template. Never used on the local tracker. |
| claude-handoff | not used | Hands the conversation to a fresh background agent | The ledger plus the re-entry protocol already make any fresh context resumable; a handoff agent would be a second orchestrator on the same run. |
| loop-me | not used | Grills the user to specify their own recurring workflows | It designs loops with a human; a recurring `/to-auto` driven by `goal.mjs next` is the loop. |
| setup-ts-deep-modules | not used by default | User-invoked TypeScript setup (dependency-cruiser) | Only when the objective names it; then it is the objective, loaded by path, with its questions answered by kun. |
| writing-beats | not used | Prose-writing workflow | Not software delivery. |
| writing-fragments | not used | Prose-writing workflow | Not software delivery. |
| writing-shape | not used | Prose-writing workflow | Not software delivery. |

## Outside the Matt set (installed skills)

| Skill | Stage in /to-auto | Touchpoint(s) | Autonomous substitute |
|---|---|---|---|
| kun | every question (KUN.md) | It is the user's voice | Cached per KUN.md § Cache once; never asked twice. |
| research-stack | 3 (first external need) and inside every subagent that looks outside the repo | None | Loaded per FLOWS.md § Research need; bounds and refunds applied per call. |
| defensive-design | 4 (Design), 7 (Implement), 8 (Review) | Mode must be stated; "do not edit unless authorized" in Review | Mode passed explicitly per call; Implement authority comes from the ticket; evidence state recorded per control. Tier 3 findings that need authority the run lacks are blockers. |
| zero-tech-debt | 2 (refactor on-ramp), 6 (prefactoring tickets) | "once a deletion is approved"; "stop and recommend a targeted change" for hotfix shapes | Self-approve after the pre-flight passes, log each deletion; hotfix shapes are re-routed to diagnosing-bugs. |
