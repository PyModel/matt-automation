---
name: watch-live-agent-run
description: Use when monitoring or live-fixing a running to-auto run, or when a TICKET_IDLE, STALE or `goal.mjs check` alert fires on one.
category: agent-orchestration
---

# Watch a live run: scan transcripts by offset, emit on change only

Watch only the run the user named; never start a watch on another project's run unasked.

- One Monitor runs a script that scans the driver transcript and its `subagents/agent-*.jsonl` files from saved byte offsets. It emits one line per failed script call, one line per change in `goal.mjs check --all`, and one line when the run reaches a finished state.
- Keep offsets and the last check output in a state file beside the script, so a re-arm resumes instead of replaying.
- Read only complete lines. A half-written last line waits for the next poll.
- Monitor expires after 30 min: re-arm at expiry and tell the user the watch lapsed.
- Name the run in the Monitor description. Finished means `done`, `stopped` or `dry-run`, not only success.
- Never `cat` or `tail` a transcript into context; the script reports lines.
- A failed-call line is a failure only when the call exited non-zero. A mistyped `goal.mjs` subcommand that prints its usage is a worker slip: report it once, do not alarm on it.
- A TICKET_IDLE line is a lead, not a verdict. Before any kill or re-dispatch, check for a live `goal.mjs run` or `with-lock` in that worktree (`pgrep -f 'goal.mjs (run|with-lock)'`, then `lsof -a -p <pid> -d cwd -Fn`). A long suite in a worker's worktree reads as idle to `check`; act only when none is live.
- Run that live-process check inside the watch script before it emits TICKET_IDLE. A relayed bare `check` line sent the owner an alert for a ticket whose `make test-integration` had run 28 minutes under a live `goal.mjs run`.

- Branch-mode runs: also emit a line for every `git push` and `gh pr create|merge` in the driver's or a worker's transcript (`DELIVERY`). Delivery to main is an owner decision, so the watch must surface it before it runs: emit `DELIVERY-PLAN` when the driver's transcript says it will push or merge to main, and `DELIVERY` when the command runs. A line only after the merge gives the owner no time to say hold.

Details, status set and trouble patterns: [watch-pattern](references/watch-pattern.md).
