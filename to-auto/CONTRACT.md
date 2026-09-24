# Ticket contract and receipt

Every implementer gets one **contract** and returns one **receipt**. The contract is compiled by the orchestrator from files; the receipt is a claim the merger checks against git before anything merges. Neither depends on who implements: a harness subagent and a pi worker (BUILD.md § Implementer backend) get the same contract and owe the same receipt.

## Readiness

A source is **agent-ready** when every box holds. The orchestrator ticks them from files, never from a sub-skill's word; any unchecked box means the source is not ready and nothing is dispatched from it.

- [ ] Every product decision and completion condition the work needs is in the source (spec, ticket, post-mortem, or the objective's own approved source).
- [ ] Exactly one bounded unit: it fits one fresh context window and pulls in no downstream work.
- [ ] Unblocked: every blocker is `done`.
- [ ] Every acceptance criterion is decidable from observable evidence: a command, a test id, a file on disk. No "looks good", "reasonable", or "clean".
- [ ] Validation commands are known (NOW `commands:`, or the repo's own scripts, CI, and tests).
- [ ] The starting point is recorded: `<ticket-base>` for a ticket, `review_base` for the run.
- [ ] Authority is explicit: which paths it may touch (claims) and which external effects the objective grants (SKILL.md § Rules, Autonomous).

Used at three points: stage 1 decides the `ready` route with it (PLAN.md § Ready source), stage 6b gates every ticket with it, and stage 7 re-checks it at dispatch, when `<ticket-base>` exists. A ticket that fails at 6b or dispatch is this run's own ticket: fix it and re-run 6b on it; failing twice makes it `stuck`.

## Capability

Each ticket names what its implementer needs, never a model: `**Capability:** <tier>/<intensity>` (CONTROL.md § Tracker grammar). Absent means `standard/medium`. Pick the lowest pair that can reliably finish the ticket; a large ticket is split at stage 6, not upgraded.

| Tier | For |
|---|---|
| `lightweight` | bounded search, inventory, formatting, mechanical edits, a small change along an established pattern, cheap to get wrong |
| `standard` | normal feature work, focused bug fixes, tests, moderate multi-file changes with clear repo patterns |
| `advanced` | hard root-cause analysis, cross-module design, security or authorization, schema or data migrations, concurrency, long-context synthesis, expensive mistakes |

| Intensity | For |
|---|---|
| `low` | deterministic, little ambiguity, cheap verification |
| `medium` | some design judgment, several files, non-trivial tests |
| `high` | ambiguous behaviour, interacting invariants, risky migrations, concurrency, security boundaries |

Tier 2 or 3 in `defensive-design` implies at least `advanced` or `high`. NOW `tiers:` (BOOTSTRAP.md § 0d) maps a pair to a concrete worker model when the harness offers a choice; with no mapping, every ticket runs on the run's `worker:`.

## The contract

Written at dispatch to `runs/<slug>/tickets/<NN>.goal.md` and committed with `goal.mjs commit`. Fill every field from files; a field with nothing to say says `none`. Criteria are copied from the ticket verbatim, one checkbox each, because the receipt check matches them by text.

```markdown
# Goal: <NN> <ticket title>

## Outcome
<one bounded outcome, from the ticket's "What to build">

## Current state
- Ticket: <full tracker path or reference>
- Worktree / branch: .worktrees/goal-<slug>-t<NN> on goal/<slug>-t<NN>
- Ticket base: <full sha of the run branch head at dispatch>
- Evidenced complete: <what already holds at the base, with the command that shows it, or none>
- Known gaps: <what is red at the base (the 6b gate's observations)>
- Existing failures: <quarantined and pre-existing failing tests from NOW, by id>

## Execution order
<the shortest seam-first path: which seam's test goes red first, then what>

## Completion criteria
- [ ] <each ticket criterion, verbatim>

## Constraints
- Claims: <the ticket's Claims line, verbatim>; a needed path outside them → stop, return `claims-breach`
- Capability: <tier/intensity>; defensive tier: <0–3>
- Seams: <agreed seams from the spec's Testing Decisions>; no test at an unagreed seam
- Commit on the ticket branch only; no push, PR, merge, tracker edit, or other external effect unless listed here: <grants from the objective, or none>
- Leave the worktree clean at return: every change committed, nothing stray
- Rules: BUILD.md § The implementer brief, rules 1–8

## Context
- Spec: runs/<slug>/spec.md   Notes: runs/<slug>/notes/   Glossary: CONTEXT.md
- Commands: <NOW commands:>   Per-worktree: <NOW per-worktree: with NN and run_id substituted>
- Budget: <per-ticket slices / minutes from NOW budgets:>
- Status file: runs/<slug>/tickets/<NN>.status.md   Ledger: runs/<slug>/ledger.md
```

## The receipt

The implementer's final message ends with exactly one fenced `json` block, the receipt. The orchestrator saves the message (for a pi worker, the `finalMessage` artifact named in `$d/impl/orc-status.json`, normally `$d/impl/final.txt`) to `runs/<slug>/tickets/<NN>.receipt.md` unchanged; `goal.mjs receipt` reads the last `json` fence of a message or a bare JSON file alike.

```json
{
  "ticket": "03",
  "conclusion": "completed",
  "ticket_base": "<full sha from the contract>",
  "head": "<git rev-parse HEAD in the ticket worktree>",
  "changed_files": ["<git diff --name-only ticket_base...HEAD>"],
  "criteria": [{ "criterion": "<ticket checkbox text, verbatim>", "result": "pass", "evidence": "<command, exit code, test id>" }],
  "validation": [{ "command": "<command>", "exit": 0, "summary": "<one line>" }],
  "review": { "cited_fixed": 0, "leads": [] },
  "not_validated": [],
  "blockers": [],
  "external_effects": [],
  "worktree_clean": true,
  "contract_quality": null
}
```

- `conclusion`: `completed` | `partial` | `blocked` | `stuck` | `claims-breach` | `stopped`. `blocked`, `stuck`, and `claims-breach` name their reason in `blockers`.
- `result`: `pass` | `fail` | `not-run`; `pass` and `fail` carry evidence.
- `external_effects`: every push, deploy, tracker edit, real-service call, or message the implementer caused. The orchestrator checks each against the objective's grants; an ungranted one is a blocker.
- `contract_quality` (optional, never a completion condition): `accurate` | `criteria-too-vague` | `criteria-wrong` | `missing-constraint` | `over-scoped`. The retro reads it.
- Secrets in any field are `<REDACTED>` (SKILL.md § Rules, Redaction).

## The receipt check

The merger runs it first, before the claims check:

```
node ROOT/scripts/goal.mjs receipt .worktrees/control/runs/<slug>/tickets/<NN>.receipt.md \
  --worktree .worktrees/goal-<slug>-t<NN> --base <ticket-base> --ticket <ticket file>
```

On a GitHub tracker the ticket file is the issue body, saved as BUILD.md § Bindings step 5 saves it for the claims check.

Exit 1 refuses the receipt: `head` is not the worktree HEAD, `ticket_base` is not the dispatch base, `changed_files` differs from git's diff, `worktree_clean` disagrees with `git status`, a ticket criterion has no entry, appears twice, or an invented one appears, or a `completed` receipt has a non-passing criterion, a blocker, no validation, a dirty tree, or a ticket with no checkbox criteria at all. A refused receipt is a stuck signal (BUILD.md § Stuck detection) with the check's `problems` appended to the re-dispatch brief. Only a `completed` receipt that passes goes on to merge; any other conclusion goes to BUILD.md § Stuck detection or § Bugs found in flight as its `blockers` say.
