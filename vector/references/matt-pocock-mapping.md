# Optional mapping to Matt Pocock's skills

Read this reference when the user wants to connect a VECTOR workflow to Matt Pocock's skill collection. Complete the workflow map without requiring any of these skills to be installed.

## Provenance and interpretation

- **VECTOR source:** the user's supplied image, titled "VECTOR: mapping a workflow onto an agent." Its six stages are Verification, Existing process, Context, Trust, Order, and Remember.
- **Upstream inspected:** [mattpocock/skills], commit [`abeeaf95660ba9e8b7c753eb38f441ca707a8823`][snapshot], authored 2026-11-19; inspected 2026-11-20.
- **Attribution boundary:** the inspected tree contains no VECTOR-named skill, and repository code search returned no VECTOR matches. Do not attribute the acronym to Matt Pocock. The phase-to-skill associations below are an original proposed mapping; the descriptions of upstream behavior are verified facts about that snapshot.
- **Invocation legend:** **M** means model-invoked and also available to the user; **U** means user-invoked (`disable-model-invocation: true`). These are upstream invocation choices, not grants of permission to act.

## Phase routing

| VECTOR phase | Optional supporting skills | Proposed application based on verified behavior |
| --- | --- | --- |
| Verification | [tdd] **M**; [code-review] **M**; [pr] **M** | Define observable acceptance evidence. TDD tests public behavior; code review evaluates Standards and Spec separately; PR guidance presents before/after evidence and change risk. |
| Existing process | [grilling] **M**; [grill-with-docs] **U** | Discover current steps, decisions, exceptions, and unstated dependencies. Grilling resolves a decision tree; grill-with-docs combines that interview with domain modeling. |
| Context | [research] **M**; [domain-modeling] **M**; [writing-for-agents] **M** | Identify authoritative sources, define terminology, and supply conditional references. Research delegates primary-source reading; domain modeling maintains vocabulary and selected decisions. |
| Trust | [pr] **M**; [wizard] **M** | Use reversibility and blast radius to inform action boundaries; prepare human-only procedures when needed. VECTOR must define the actual authorization, review, and escalation rules. |
| Order | [to-spec] **U**; [to-tickets] **U**; [implement] **U**; [implement-spec] **U** | Recommend an appropriate later engineering flow. Specifications capture decisions; tickets declare blocking relationships; implementation can work the ready frontier of that graph. |
| Remember | [domain-modeling] **M**; [writing-for-agents] **M**; [handoff] **U**; [retro] **U** | Keep durable vocabulary and selected decisions, create portable context, and improve future runs. VECTOR separately specifies durable storage, provenance, freshness, and restart state. |

## Invocation and authorization

1. Inspect the actual installed skill's `SKILL.md` before invoking it or making a behavior claim. The dated mapping is a navigation aid; installed instructions may differ. The upstream [ask-matt] router itself requires this verification.
2. Follow the host's skill-loading mechanism. Recommend **U** workflows as user-selected next steps; the inspected upstream [invocation mechanics] says routers can suggest these workflows but cannot invoke them automatically. Load **M** skills only when their task fits and their effects are within the user's authorized scope.
3. When a supporting skill is unavailable, continue with VECTOR's own procedure and describe the optional association. Do not auto-install the collection or claim it was run.
4. Keep mapping distinct from executing the mapped work. Describing a tracker, credential, merge, deployment, or messaging step does not authorize that operation. Preserve current user instructions, established authorization, and higher-priority constraints when adopting a supporting workflow.

## Specific caveats

### Verification

The inspected [tdd] body uses a **red-to-green** loop: one failing behavior test followed by its minimal implementation. It places refactoring in review, even though other upstream summaries still mention red-green-refactor. It asks the user to agree test seams before tests are written. Carry forward already-established agreement; resolve only a missing material decision, within the host's instruction hierarchy.

[code-review] requires a resolvable fixed point, a nonempty diff, and a specification source when available. It reports Standards and Spec separately. It is a review of changes, not a substitute for the workflow's own acceptance evidence.

### Trust

[pr] defines a PR body with evidence, reversibility, and blast radius. It provides **no merge or deployment authority** and does not itself merge a PR.

[wizard] generates a human-operated Bash procedure for steps the agent cannot perform. The source requires concrete, verified instructions and static checks, and says not to run the interactive procedure end to end on the human's behalf. A wizard is not needed for work the agent can already perform under existing authorization.

### Order and external effects

[to-spec] can publish a specification to the configured tracker. [to-tickets] can publish approved tickets and blocking relationships. [implement] commits code. [implement-spec] creates an integration branch, orchestrates workers, and may create or advance a draft PR or resolve tickets. Treat those as execution workflows with real effects, not passive map generators.

In matt-automations, `/to-auto` runs a software objective end to end and reads a supplied card through its built-in VECTOR intake. Offer it as the owner's next step for a signed-off software card; only the owner's request starts it.

### Remember and durability

[handoff] saves its portable document in the operating system's **temporary directory**. Its source references existing artifacts and redacts sensitive information. It does not guarantee durable retention. A workflow that must survive cleanup needs a separately identified, authorized durable destination and references that the next run can access.

[domain-modeling] reserves `GLOSSARY.md` for domain definitions and uses ADRs selectively for significant decisions. Keep execution checkpoints and completed-action identifiers in the workflow's run-state record. [retro] proposes improvements to the agent's environment; it is not an automatic memory-write or code-fix authorization.

## Current names and maintenance

Use the verified names `to-spec`, `to-tickets`, and `writing-for-agents`. Older references to `to-prd`, `to-plan`, `to-issues`, `write-a-skill`, or `writing-great-skills` do not identify the current paths in this snapshot. Re-check names before suggesting an installed invocation. Experimental skills under `skills/in-progress/` are not dependencies of this map.

This reference is independently written and links to upstream behavior without reproducing skill bodies. Upstream is [MIT-licensed][license], copyright 2026 Matt Pocock; preserve its required notice if later copying substantial upstream material.

## Immutable source links

[mattpocock/skills]: https://github.com/mattpocock/skills
[snapshot]: https://github.com/mattpocock/skills/commit/abeeaf95660ba9e8b7c753eb38f441ca707a8823
[tdd]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/tdd/SKILL.md
[code-review]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/code-review/SKILL.md
[pr]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/pr/SKILL.md
[grilling]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/productivity/grilling/SKILL.md
[grill-with-docs]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/grill-with-docs/SKILL.md
[research]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/research/SKILL.md
[domain-modeling]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/domain-modeling/SKILL.md
[writing-for-agents]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/productivity/writing-for-agents/SKILL.md
[wizard]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/wizard/SKILL.md
[to-spec]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/to-spec/SKILL.md
[to-tickets]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/to-tickets/SKILL.md
[implement]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/implement/SKILL.md
[implement-spec]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/implement-spec/SKILL.md
[handoff]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/productivity/handoff/SKILL.md
[retro]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/retro/SKILL.md
[ask-matt]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/ask-matt/SKILL.md
[invocation mechanics]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/productivity/writing-for-agents/SKILL-MECHANICS.md
[license]: https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/LICENSE
