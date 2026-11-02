# To-auto run budget and stop conditions

Commit each budget change with its stop conditions before any ticket runs under it. Never cut a registered item to fit; stop conditions decide what stays open.

## Recording a change
1. Append `budget: <old> -> <new> (source: <who>)` to the run log. A decision-subagent budget is `not owner-approved`, unless the owner's message delegated it: then `<persona> under owner delegation <date>`, citing the message.
2. Take "now" from `date`, never the ledger. Update the ledger's wall-clock line; grep the new end time for exactly one match.
3. Commit both: `goal.mjs commit -m "[<slug>] budget ..." <log> <ledger>`; read the sha back.
4. On a cap raise, return tickets stuck only for the old cap to `ready-for-agent`, in priority order, in the same commit.
5. Name the budget, its source and owner approval in the hand-back.

## Stop conditions
- Two failed fixes with one root cause: leave the ticket open with a one-line blocker; keep running.
- Start review, hand-back and retro by the wrap-up time, sized from prior runs' measured stage-8 wall clock plus a re-verify slot for late fixes.
- Hard stop at the ceiling: open work stays open, blocker named.
- Timed benchmarks run only in an idle window (`timed-benchmark-hygiene`), ending before wrap-up; none → `blocked: no idle window`.
- Past `goal.mjs claim`'s two amendments or `waive`'s one waiver, mark the ticket `stuck` and move unmet criteria to a new ticket. Count both in the retro budget line.
- Enforce a quota stop only if quota reads unattended; read it at 0d. If the quota reader needs a credential prompt, log `quota stop: not enforceable (credentials = blocker)`.
- A stage 8 shorter than CLOSE.md: log `deviation: <step> → <instead>, <why>` with the budget line; name the one re-verify at the merged head.

## Before choosing a budget
- Sum serial GPU work (prior receipts' per-ticket estimates, measured stage 8, non-overlapping planning) against hours left; log both with the budget line.
- Over the ceiling: split into a second run registered up front, each item owned by one run. Still short: say so in the report.
- Never pre-cut: no dropped benchmark or doc, trimmed ticket scope, or tickets held against a self-chosen review time. Run in priority order.
- A worker that stops a validation tier for wrap-up reports it not run, never `completed`; rerun it at the receipt head before landing.
