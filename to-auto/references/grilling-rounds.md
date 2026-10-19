# To-auto grilling rounds: answer blind, then challenge

A self-answered grilling round must not let the answerer confirm the skill's own recommendations. Give the kun answerer the frontier as bare questions with their options. Show recommendations only to the challenger, or to the answerer after it has answered blind, as a contrast to check against.

- **Accept-all is a failure signal.** If the answerer accepts every recommendation, the round tested nothing. Re-ask the accepted questions blind, once. The re-ask covers every accepted question, not only the ones a challenger objected to.
- **Objections go back as evidence, not as answers.** Re-send a challenger objection to the answerer with its `file:line` evidence and the bare options only. Never attach the orchestrator's "Proposed:" answer; that turns the re-ask into a confirmation.
- **Each answer cites evidence.** Accept it only with a kun `content/` excerpt or a repo `file:line`. A bare "follows the same pattern" or a doc name with no quoted line is `no-answer`.
- **Answerer reads before it answers.** Zero repo reads on a round about repo code is a defect. Require a grep of each touched symbol before answering.
- **Challenger checks code, not the answerer's reasons.** Grep every reader or caller the answer touches before confirming. Contradictions are objections with `file:line`.
- **One recommendation per question.** A hedged recommendation becomes a separate question in a later round.
- **Money-path answers name the stored state.** For a question on a charge, refund, or order, the answer says what happens to the stored intent and its idempotency key, and never adds a second send or a new key for an unresolved charge. The challenger checks the answer against the key-reuse path the code already ships; a rule that contradicts shipped reuse is an OBJECT, not a confirmation.
- **Contested after one exchange** → PIPELINE default, logged `(source: default, contested)`, as KUN.md already says.
- **Challenger reply format.** One line per question: `Q<n>: CONFIRM — <evidence>` or `Q<n>: OBJECT — <file:line> — <bare options>`, with no proposed answer. A challenger on a re-ask subset still greps every caller of each touched symbol. A blind re-ask whose answers all match the settled log is a confirmation: record the ids in the round's notes and the event log.
