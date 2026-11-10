# Reconcile brief (PLAN.md 5b)

Each round, send a fresh subagent this file, `log.md`, `findings.md` and `spec.md`, nothing else. It writes nothing. Save its final message verbatim as `runs/<slug>/notes/reconcile-<n>.md` and commit it.

## Round 1
- List every logged answer (`D<n>`) and requirement (`R<n>`) the spec omits or softens: a number became "reasonable", a negative requirement became silence, an ordering guarantee became prose.
- One line per item: `- X<n>: <D or R id>: <what is missing or softened>; spec says <quote, or "nothing">`. Number from X1.
- Nothing to list: the single line `none`.
- File paths and line numbers belong in tickets, not the spec: their absence is never an item.

## Round n > 1
It also gets the prior note and `git diff` of `spec.md` since that round.
- For each X id in the prior note: drop it if the diff fixes it, else repeat its line unchanged.
- Add an item (the next free X number) only for something the diff broke or introduced.
- Do not re-review text the diff did not touch.

## Closing the gate
The orchestrator fixes the spec for each item and runs the next round; it never judges its own fix. The tick of 5b reads the newest note: it lists no item, or (past the round budget, PIPELINE.md § Budgets) every item has a `log.md` line that names its X id with `(source: kun)`.
