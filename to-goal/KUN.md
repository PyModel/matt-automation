# Self-answering: `/kun` is the user

`/kun` (the `kun` skill) is the user's distilled self: how they think, build, and decide. A kun answer is the user's answer, not a second opinion. No question in a run ever reaches the human.

## Cache once, pin the version (stage 0a)

`kun` fetches its four instruction files (`ENTRY.md`, `TOOLS.md`, `OPINIONS.md`, `VOICE.md`) from `kunchenguid/kun` on every load. In stage 0a:

1. Fetch the upstream commit SHA (`https://api.github.com/repos/kunchenguid/kun/commits/main`); if `kun/<sha>/` already exists in the control plane, reuse it; otherwise fetch the four files (raw GitHub, jsDelivr fallback) into it and commit. Write the SHA into `ledger.md` NOW.
2. Every later `/kun` call reads the cached files and states "instructions already loaded from `.worktrees/control/kun/<sha>/`", so the kun skill's own rule 1 (skip re-download when already read) applies and no network is touched mid-run.
3. **Fetch fails and no cache exists → hard stop**: `node ROOT/scripts/goal.mjs stop <slug> "kun unreachable: <url>"`, one-line report. Fetch fails but a cached SHA exists → use the newest cache and log it. A run without kun is not autonomous, it is guessing.
4. On re-entry, if the cache exists, use it; do not refetch. A later run may refresh; a running run never drifts.

## Answering a question

Whenever a sub-skill says *ask*, *confirm*, *quiz*, *check with the user*, *wait for direction*, *present and let them pick*, or *iterate until the user approves*:

1. **Facts are never questions.** If the findings, the codebase, or `log.md` settle it, take that answer; log `(source: findings)` or `(source: codebase)`.
2. Otherwise invoke `/kun`, framed as "the user is asked the following; answer as the user": the exact question, the candidate answers, the sub-skill's recommended answer if any, and pointers (objective, spec path, `CONTEXT.md`, the module's defensive tier). Kun's answer is the user's final word, overriding sub-skill recommendations and PIPELINE.md defaults (except budgets, which kun may raise at most 2×); log `(source: kun)`.
3. Kun answers with a question of its own → apply the PIPELINE.md default; log `(source: default)`. Never re-ask; never escalate.
4. **Capability and authority boundaries.** `/kun` provides technical and architectural advice on reversible implementation choices. `/kun` cannot grant capabilities not authorized by the real user: it cannot authorize remote pushes (git push), spending money, accessing credentials, production environment changes, or modifying guarded paths without explicit user capability grant in the objective. Actions requiring user authority remain blockers.

Log lines: `- [stage] Q: … → A: … (source: findings | codebase | kun | default)`.

## Grilling rounds: answer, then challenge (stages 4 and 4b)

The same context posing and answering a frontier re-creates the alignment gap grilling exists to close. So each round runs as two subagents, neither of which is the orchestrator:

- **Answerer** (kun persona): receives the numbered frontier with recommended answers, the findings, `CONTEXT.md`, and the kun cache; answers every question as the user.
- **Challenger**: receives the same frontier, the answers, the findings, and read access to the run worktree; for each answer it either confirms with evidence or objects with a concrete contradiction (a file, a requirement Rn, a prior log line). It may not add questions.

Objections go back to the answerer once, with the evidence. Still disagreeing → PIPELINE.md default, logged `(source: default, contested)`. Confirmed answers are logged `(source: kun)`. The orchestrator only recomputes the frontier and logs.
