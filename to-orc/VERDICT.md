# Verdict and final response contract

## Verdict rules

- **PASS** — all four phases complete, all required acceptance criteria and checks pass, the final change set is verified against the recorded diff identifier, and no unresolved issue requires changes.
- **REVISE** — corrections are needed, required verification is incomplete, or approval evidence is insufficient. Progress is possible but the result cannot be approved.
- **FAIL** — compliant execution is impossible, a mandatory orchestration constraint was violated (`CONFIG_NON_COMPLIANT`, `RUNTIME_UNAVAILABLE`, `SCHEMA_DRIFT`, a skipped phase, a resumed verifier session), or an unrecoverable blocker prevents completion.

A phase being *completed* does not mean it *passed*: a verifier can finish its work and report failing tests. `orcStatus: COMPLIANT` says the dispatch was compliant, never that the phase passed.

`all_steps_completed` is `true` only when every required plan step is completed with supporting evidence. Record every material deviation, including authorized ones and every `NO_WRITES_VIOLATED`.

`next_action` is `APPROVE` only for `PASS`; otherwise `REQUEST_CHANGES`.

`correctness_score` is an integer 0–10, or `null` when evidence is insufficient. Reserve 10 for fully satisfied acceptance criteria with passing required checks. Explain anything lower in `findings`. The score is an assessment, never proof, and never overrides a failed approval condition.

## What `findings` must contain

The actual changes (from `changeSet`, not prose), the delegated verification results, the diff identifier the verification targeted, the run's total cost, every unknown the evidence could not close — including `changeSet.verified: false` workspaces and ignored files the fingerprint cannot see — and the reason for the verdict. Cite artifact paths; never paste artifact contents (DELEGATION.md § Redaction).

## Emission rules — the commonest way this skill fails

- The final message is **exactly one raw JSON object**. Nothing before it, nothing after it.
- **No Markdown fences.** No comments, no trailing commas.
- Roadmap, progress notes, ledger paths, and commentary belong in **earlier** messages.
- Real JSON `true` / `false` / `null`, never the strings.
- `deviations` is an array of strings.
- Keep the top-level structure and field names below; replace every example value.
- Include discovered issues **even when later resolved** (`status: "RESOLVED"`).
- `evidence` entries point at delegated evidence — status files (`<run-dir>/P4-verify/orc-status.json`), report sections, commands with exit codes. Never credentials.
- If no worker was successfully dispatched: all `phase_audit` flags `false`, `findings` says so, `correctness_score` `null`, `status` `FAIL`.

Each `issues_detected` entry: `id` (string), `severity` (`CRITICAL` | `HIGH` | `MEDIUM` | `LOW` | `INFO`), `status` (`OPEN` | `RESOLVED`), `description` (string), `location` (string or `null`), `evidence` (array of strings), `required_action` (string, or `null` only when nothing remains).

## Validate before sending

Write the draft to a file and run it through the contract checker until it passes:

```bash
node <skill-dir>/scripts/validate-verdict.mjs <run-dir>/verdict.json --run-dir <run-dir>
```

It rejects a `dispatched_to` that differs from the worker in `run.json`, unfilled `<placeholders>`, fences, wrapping prose, stringified booleans, malformed issues, `APPROVE` without `PASS`, `PASS` carrying an OPEN issue, and an all-false phase audit that is not `FAIL`. Send the validated file's contents verbatim.

## Template

{
  "orchestration_summary": {
    "task_id": "<actual-task-id>",
    "dispatched_to": "pi / <run.json worker.provider>/<run.json worker.requestedModelId>",
    "flags": "--model <run.json worker.model>",
    "status": "FAIL"
  },
  "phase_audit": {
    "scouting_completed": false,
    "researching_completed": false,
    "implementing_completed": false,
    "verification_completed": false
  },
  "plan_compliance": {
    "all_steps_completed": false,
    "deviations": []
  },
  "implementation_review": {
    "correctness_score": null,
    "issues_detected": [],
    "findings": "<Actual changes, delegated verification results, diff identifier, cost, limitations, and the reason for the verdict.>"
  },
  "next_action": "REQUEST_CHANGES"
}

The routing fields identify the worker `run.json` fixed for this run; they are not proof that execution occurred.
