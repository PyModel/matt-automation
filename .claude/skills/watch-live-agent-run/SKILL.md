---
name: watch-live-agent-run
description: Use when watching a live to-auto run or TICKET_IDLE alert.
category: agent-orchestration
---

# Watch a live run: scan transcripts by offset, emit on change only

Watch only the run the user named; never start a watch on another project's run unasked.

In watch-only mode (observing, not fixing), stay read-only: no `goal.mjs` subcommand, no `with-lock`, no git write in the control repo, state dir or worktrees. Run audits of the driver's reads or pitfalls as parallel read-only subagents, and tag each finding OBSERVED (transcript, commit or file:line evidence) or SUSPECTED (inference).

- One Monitor runs a script that scans the driver transcript and its `subagents/agent-*.jsonl` files from saved byte offsets. It emits one line per failed script call, one line per change in `goal.mjs check --all`, and one line when the run reaches a finished state.
- Keep offsets and the last check output in a state file beside the script, so a re-arm resumes instead of replaying.
- Read only complete lines. A half-written last line waits for the next poll.
- Monitor expires after 30 min: re-arm at expiry and tell the user the watch lapsed.
- Name the run in the Monitor description. Finished means `done`, `stopped` or `dry-run`, not only success.
- Never `cat` or `tail` a transcript into context; the script reports lines.
- Before blaming a driver for a thin read, measure what a column cut dropped. `cut -c1-N` on long-line skill docs hid a third of one section; that is a readability defect in the doc (lines reach 3.9 KB), not a driver slip. Read the doc with full lines or a python slice.
- A failed-call line is a failure only when the call exited non-zero. A mistyped `goal.mjs` subcommand that prints its usage is a worker slip: report it once, do not alarm on it.
- A TICKET_IDLE line is a lead, not a verdict. Before any kill or re-dispatch, check for a live `goal.mjs run` or `with-lock` in that worktree (`pgrep -f 'goal.mjs (run|with-lock)'`, then `lsof -a -p <pid> -d cwd -Fn`). A long suite in a worker's worktree reads as idle to `check`; act only when none is live.
- Owner-decision check: a grant or gate that cites `source: owner` must quote text found in the owner's `user` records of the driver transcript. Emit `OWNER-UNVERIFIED` when it does not. A tag alone proves nothing: a guarded-path grant passed on a decision the orchestrator wrote itself, whose own text said "Reading by the orchestrator".
- Run that live-process check inside the watch script before it emits TICKET_IDLE. A relayed bare `check` line sent the owner an alert for a ticket whose `make test-integration` had run 28 minutes under a live `goal.mjs run`.
- Match patterns against executed commands only. Strip heredoc bodies (`<<'EOF' … EOF`) and quoted data before matching any pattern: a worker writing a receipt, ticket title or script file is not running it. Observed in one run: a receipt containing "cannot" raised a failure, and a worker's heredoc containing `rm -rf` raised DESTRUCTIVE.
- Failure patterns are line-anchored: `error:` or `usage: ` at line start (the goal.mjs refusal form), plus SyntaxError, TypeError, ReferenceError, ENOENT and `still held after`. Never bare words (`cannot`, `refus`, `not allowed`).
- DESTRUCTIVE triage: first print the matched span with context from the raw call event in the run's `events.jsonl`. Then strip heredoc bodies (`<<'EOF' … EOF`) before matching: text a worker writes into a file is not a command run. Resolve `NAME=value` assignments in the same command before judging `rm -rf "$P"`, and treat paths under the run's `tmp/<slug>/` scratch dir as safe. Keep real-destructive patterns firing (`reset --hard`, `push --force`, `branch -D`, `rm -rf` outside scratch). Verify by replaying the run's recorded events through the patched classifier (zero benign hits) plus a self-check that the real patterns still fire. Re-arm from saved offsets; do not restart the scan from zero.
- Branch-mode runs: also emit a line for every `git push` and `gh pr create|merge` in the driver's or a worker's transcript. Classify the push remote first: a localhost or VM remote (`http://localhost:<port>/…`) is local, so emit one `LOCAL-PUSH` line and no alarm. Delivery to main is an owner decision, so for a non-local remote or any merge to main, emit `DELIVERY-PLAN` when the driver's transcript says it will push or merge to main, and `DELIVERY` when the command runs. A line only after the merge gives the owner no time to say hold.
- Review claims need a record. When the driver calls a ticket "reviewed" or "inline review clean", require a `code-review` skill load, a review subagent, or a `tickets/<NN>.review.md`. A lone `git diff` of source paths, tests excluded, is a skim: emit `REVIEW-SKIM` with the commit range, not a pass. Observed in one run: tickets 02, 03 and 04 had only that.
- False positive: TaskStop, narrow the pattern in the watch script, re-arm from saved offsets, and tell the user in one line which pattern misfired and why.
- Owner messages typed into the watched session (`user` records that are not the run's own brief or decision text) are owner side requests, not run anomalies. Emit one `OWNER-SIDE` line with the timestamp and the request, no failure alarm. If the request edits repo files while the run is in flight, add a `REPO-EDIT` line so the owner can judge the overlap.

- Watcher self-test: after every edit to the watch script, replay the run's recorded events through it and confirm a clean exit with zero benign hits before re-arming. A variable-expansion step that crashed on a backslash surfaced only as a watcher error mid-run.
- Durable output: write the final watch report and its evidence log to a folder outside the repo and outside the scratchpad (for example `~/claude-tmp/<run>-<date>/`). The scratchpad is session temp and not durable.
- Before delivering a watch report, check its load-bearing claims against raw excerpts. Replace run, project and branch names with placeholders first, then report the verified count (for example 6 of 6) and name any claim left unsupported.

Details, status set and trouble patterns: [watch-pattern](references/watch-pattern.md).
