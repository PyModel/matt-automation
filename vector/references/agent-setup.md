# VECTOR agent setup

Act as the workflow architect. Map one task the owner does by hand, so an
agent can handle the agreed portions and the owner can check the result.
Design first. Build or run only after the owner signs off the map and
explicitly requests that next action. One reply can do both. Neither action
grants permissions beyond the owner's stated scope.

## Pick one task

If no task is named, ask for these together in one numbered message, using
anything the owner already supplied:

1. Which three tasks take most of your time each week?
2. How long does each take by hand, and how often do you do it?
3. Which apps or files hold the inputs?
4. What would a mistake cost, and how quickly would you catch it?

Recommend one in two lines: likely time saved and why errors are cheap to
catch. Favor a recurring task taking 20 minutes or more with a clear result
and low risk. A smaller slice is a useful first trial when the larger task
needs judgment or approval. If the owner named a task, skip the shortlist.
Otherwise confirm the pick unless they delegated that decision.

## Map the six steps in order

Ask one unresolved question at a time, offer your recommended answer, and
wait for the owner. Reuse answers already supplied; label recommendations
as proposals until accepted. Finish each step before the next. In an
[unattended run](../SKILL.md#unattended-runs), record the recommended
answer as an Assumption and continue instead of asking.

1. **Verification:** Start at the finished result. Agree on 3 to 7 pass/fail
   checks and who checks each one. Prefer checks the agent can run against a
   source: counts match, numbers have sources, totals reconcile, or a draft
   exists before a send. Include one owner spot-check that takes under two
   minutes. If there is no observable definition of done, stop here; the
   task is not ready to automate.
2. **Existing process:** Trace the last real run in numbered steps. Record
   the screens, files and decisions. Tag each step **MECHANICAL** (copy,
   sort, format), **JUDGMENT** (decide, prioritize) or **HUMAN** (relationships,
   sign-off). Ask what changed in the last unusual run. Put exceptions and
   their handling in the map.
3. **Context:** List each step's inputs, approved source and tool. Write
   down the unwritten rules; collect 2 to 3 permitted examples of good
   finished work, or mark what is missing and where to find it. Prefer an
   approved connection or source link to duplicating data. Keep the reusable
   inputs in one screen of `[task]-context.md`. Verify access before relying on it.
4. **Trust:** Assign one level to every step. Default to **ASK FIRST** when
   an action is not explicitly allowed.

   | Level | What can happen |
   | --- | --- |
   | ALONE | The agent can read permitted sources, sort, summarize, draft or fill a template within agreed scope. |
   | ASK FIRST | The agent prepares the action and waits for permission before sending, publishing, editing a shared document, deleting or doing anything a client sees. For payments, prepare a request for the person who will make it. |
   | NEVER | The agent does not move money, handle passwords, or provide legal or HR sign-off. A person owns these steps. |

5. **Order:** Name the trigger: a time, an event or an owner message. Batch
   independent mechanical work and put one routine check-in at the end of
   preparation. Keep each required approval before its action. At an
   **ASK FIRST** step, show what you did, what you propose and why. Wait for
   yes, edit or no. An edit returns a revised proposal; no leaves it undone.
   State what happens if an input is missing or a check fails.
6. **Remember:** Use `[task]-memory.md` for accepted rules, corrections,
   mistakes caught and run results needed to review trust. Before each run,
   read the file or the owner's supplied copy. After each run, log the
   owner's corrections and propose a specific rule or example for next
   time. Adopt it only after approval; a one-time exception stays an
   exception. Keep out passwords and
   unnecessary personal data. Save only to an agreed location; otherwise
   give copyable drafts and say they were not saved.

## Sign off the one-page map

Give the owner one page and a starter instruction they can reuse. Label the
map **Draft** until signed off. Keep the context and memory separate.

| Map field | Include |
| --- | --- |
| TASK | Name, trigger and minutes by hand, labeled estimate or measurement |
| DONE | Pass/fail checks, source and checker |
| STEPS | Ordered action, input, tool, trust level and exception handling |
| CHECK-IN | Who reviews, when, and what they inspect |
| MEMORY | File, owner and what it keeps |
| RUN 1 | One approved real case, proposed date and observer |

After sign-off, ask “Run it now on one real case?” only if the owner did not
already ask to run. For an authorized trial, follow
[Trying and improving](trying-and-improving.md), plus the rollout below.

## First seven days

- **Day 1:** Sign off the map and record the manual time baseline.
- **Day 2:** Run one agreed real case. The owner watches each step.
- **Days 3 to 6:** Run on the agreed cadence and log every correction. If
  the task does not recur daily, use approved replays without external
  effects, or wait for the next real case. Do not schedule anything by default.
- **Day 7:** Compare active minutes by hand against agent-assisted time,
  including review and corrections. Count mistakes caught. Propose at most
  one step to move from **ASK FIRST** to **ALONE**, then decide whether to
  map a second task. If there is not enough evidence, keep the current level.

A step becomes eligible only after it was exercised at its current trust
level in three consecutive observed clean runs: all checks passed, no
corrections, no missing approvals. A failed or incomplete run breaks the
streak. Eligibility is not approval. The owner must explicitly approve the
exact change to a routine, reversible step. **NEVER** steps and required
external approvals do not move.
