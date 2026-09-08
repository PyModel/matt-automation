# matt-automation audit packet

Audited revision: `fe49e377695de0081f7951f81a513417a481dff0`, September 8, 2026.

Start with `AUDIT.md`. `REMEDIATION.md` is the proposed repair sequence, not an implemented patch. The repository was not changed.

## Reproduce selected regression checks

Prerequisites: Python 3.10+, Node and Git. The executed baseline was Linux, Node 22.16.0 and Git 2.47.3. The harness uses POSIX process groups and shell shims; macOS remains a required validation target, and Windows is not claimed supported by this harness.

```sh
python3 audit_regressions.py \
  --repo /absolute/path/to/matt-automation \
  --output ./adversarial-results.json
```

Run only against source you trust. At the audited revision, the harness substitutes a local relay and a `pi --version` shim, does not contact a model API, and creates disposable Git repositories rather than changing your project. It cleans its temporary directory and its owned signal-test process group. The source hashes in the results identify the exact dispatcher and validator tested.

Exit 1 is expected at the audited revision: it means safety properties were violated. It is not a successful test run. The recorded 34 cases have 30 violations, three passing controls, and one advisory. Related failures are grouped into 26 audit findings; the case count is not a count of independent bugs or a representative failure percentage.

A19-A20 are injected contradictory relay-result cases; they do not prove the unavailable real relay emits those shapes. A23 deliberately records a stronger suggested rule as advisory, not a confirmed violation. A26-A31 are documented-workflow Git simulations, not end-to-end skill executions. A32 uses a controlled slow-terminating relay.

## Original suite results

`selftest-no-pi.log`: the unchanged original suite exited zero after skipping every assertion.

`selftest-with-shim.log`: the unchanged original suite, with a test-only executable answering `pi --version` and its own stub relay, ran 40 assertions: 38 passed and two immediate post-kill/orphan-poll tests failed. No provider credentials or real model were used. These failures were observed on Linux; do not assume identical timing on macOS.

The exact three executed script hashes and all 26 source locations are in `source-manifest.json`. The source copies themselves are not included in the packet; the audited GitHub repository is the source of truth.

## Contents

- `AUDIT.md`: full findings and coverage limits.
- `REMEDIATION.md`: priorities, dependencies, acceptance, tests, observability, migration and rollback.
- `findings.json`: structured finding records.
- `audit_regressions.py`: selected reproducible tests.
- `adversarial-results.json` and `adversarial-tests.log`: observed outcomes.
- `selftest-no-pi.log`, `selftest-with-shim.log`: original suite evidence.
- `selftest-process-diagnostics.txt`: later process inspection; this is not a claim about process state at the exact failed assertion instant.
- `source-manifest.json`: immutable source references and executable integrity hashes.
