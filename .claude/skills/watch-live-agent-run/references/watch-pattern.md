# Watch pattern for to-auto runs

- Run state: `runs.json` under the to-auto state dir; finished statuses are `done`, `stopped`, `dry-run` (goal.mjs `FINISHED_RUNS`). `done` and `dry-run` are the terminal set in `TERMINAL`.
- Transcripts: driver `<session>.jsonl`; subagents `<session>/subagents/agent-<id>.jsonl`, each with a `.meta.json`.
- Failure scan: a Bash tool_use whose command matches goal.mjs, orc-dispatch, receipt-lint, matt.mjs or to-auto-guard; pair it with its tool_result by tool_use_id; emit when `is_error` is set or the output matches refus|usage: goal.mjs|not allowed|cannot|SyntaxError|TypeError|ReferenceError|ENOENT|still held after.
- Check diff: run `node scripts/goal.mjs check --all`, sort lines, emit NEW and CLEARED against the last run.
- Poll interval: local file and CLI checks every 30-60 s; keep the loop `try`-wrapped so one failed read does not kill the watch.
