# Self-answering: `/kun` is the user

`/kun` (the `kun` skill) is the user's distilled self: how they think, build, and decide. A kun answer is the user's answer, not a second opinion. No question in a run ever reaches the human.

## Cache once, pin the version (stage 0a)

The `kun` skill pulls `kunchenguid/kun` (https://github.com/kunchenguid/kun) on every load with the upstream `scripts/pull-kun.mjs`: the four root docs (`ENTRY.md`, `TOOLS.md`, `OPINIONS.md`, `VOICE.md`) plus `content/` (kun's own words, indexed by `content/MANIFEST.json`). A run pulls once, in stage 0a:

1. Read the upstream SHA: `git ls-remote https://github.com/kunchenguid/kun.git refs/heads/main` (fallback `https://api.github.com/repos/kunchenguid/kun/commits/main`). `kun/<sha>/` in the control plane (shared by all runs) is complete when it holds the four root docs and `content/MANIFEST.json`; complete → reuse it.
2. Otherwise, if an older `kun/<old>/` is complete, copy it to `kun/<sha>/` first so the pull is incremental. Download `pull-kun.mjs` from `https://raw.githubusercontent.com/kunchenguid/kun/<sha>/scripts/pull-kun.mjs` (fallback `https://cdn.jsdelivr.net/gh/kunchenguid/kun@<sha>/scripts/pull-kun.mjs`), run `node pull-kun.mjs --dir <control>/kun/<sha>`, and commit the folder. The script pulls `main`, so re-read the SHA; if `main` moved during the pull, rename the folder to the new SHA. Write the SHA into NOW.
3. Every later `/kun` call skips the kun skill's pull step and reads from `<control>/kun/<sha>/` instead: frame it as "instructions already pulled to `<control>/kun/<sha>/`; do not pull, read the four root docs in full and open matching `content/` files when a question needs kun's actual words". No network is touched mid-run.
4. **Pull fails and no complete cache exists → hard stop**: `node ROOT/scripts/goal.mjs stop <slug> "kun unreachable: <url>"` before any other mutation, one-line report. Pull fails but a complete cache exists → use the newest complete one and log `kun: cached <sha>, upstream unreachable`. A run without kun is not autonomous, it is guessing.
5. On re-entry, use the SHA in NOW; do not refetch. A later run may refresh; a running run never drifts.

## Answering a question

Whenever a sub-skill says *ask*, *confirm*, *quiz*, *check with the user*, *wait for direction*, *present and let them pick*, or *iterate until the user approves*:

1. **Facts are never questions.** If the findings, the codebase, or `log.md` settle it, take that answer; log `(source: findings)` or `(source: codebase)`.
2. Otherwise invoke `/kun`, framed as "the user is asked the following; answer as the user": the exact question, the candidate answers, the sub-skill's recommended answer if any, and pointers (objective, spec path, `CONTEXT.md`, the module's defensive tier). Kun's answer is the user's final word, overriding sub-skill recommendations and PIPELINE.md § Defaults (budgets only within PIPELINE.md § Budgets); log `(source: kun)`.
3. Kun answers with a question of its own → the PIPELINE.md default; log `(source: default)`. Never re-ask; never escalate.
4. Kun advises on reversible technical and architectural choices. It never grants authority (SKILL.md § Rules, Autonomous); those actions stay blockers.

Every answer is one line in `log.md` (LEDGER.md § Layout).

## Grilling rounds: answer, then challenge (stages 4 and 4b)

The same context posing and answering a frontier re-creates the alignment gap grilling exists to close. So each round runs as two subagents, neither of which is the orchestrator, both working in the run worktree:

- **Answerer** (kun persona): receives the numbered frontier with the skill's recommended answers, the findings, `CONTEXT.md`, and the kun cache; answers every question as the user.
- **Challenger**: receives the same frontier, the answers, the findings, and read access to the run worktree; for each answer it either confirms with evidence or objects with a concrete contradiction (a file, a requirement Rn, a prior log line). It may not add questions.

Objections go back to the answerer once, with the evidence. Still disagreeing → PIPELINE.md default, logged `(source: default, contested)`. Confirmed answers are logged `(source: kun)`. The orchestrator only recomputes the frontier and logs; a round is done when the frontier is empty.
