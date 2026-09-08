# Remediation plan

Baseline: `PyModel/matt-automation@fe49e377695de0081f7951f81a513417a481dff0`.
This is a proposed implementation plan. No production patch or repository write was performed by this audit.

## Objective and acceptance boundary

Keep the four skills and their intended workflows. Move permissions, state transitions, file ownership, snapshot identity, budget accounting and cleanup decisions into a small tested local runtime. Leave investigation, design trade-offs and review judgment with the agents. More prose and more subagents are not substitutes for these runtime guarantees.

Release acceptance: all P1 findings in `AUDIT.md` are addressed; every relevant adversarial case passes its repaired contract; the original offline test suite executes without pi and is green on Linux and macOS; a separately authorized end-to-end smoke run verifies the pinned real relay and model configuration. Do not interpret successful script tests as proof that agent judgment catches every defect.

## Dependencies and proposed module boundaries

Retain the existing Node CLI interface where practical. No database service is needed for the current local-worktree design. A single authoritative writer plus a small transactional file store is adequate if it serializes the complete transaction and is crash-tested. Cross-host operation would require a separately designed coordination backend, not PID-file assumptions.

Proposed, not currently existing, internal modules:

| Module | Responsibility | Depends on |
|---|---|---|
| `contracts` | Closed enums; versioned result/status/acceptance/spend schemas; verdict invariants | Node standard library or one explicitly pinned schema dependency |
| `run-store` | Immutable run/attempt IDs; ownership; atomic records; idempotent event ingestion; acceptance generations | contracts |
| `snapshot` | Canonical workspace root; maintained-file manifest; semantic index state; content/type/mode/link identity | contracts; Git capability probe |
| `supervisor` | Process ownership; readiness handshake; cancellation settlement; terminal results | run-store; contracts |
| `factory-state` | Bootstrap, frontier claims, merge serialization, terminal graph states, safe GC proposals | run-store; snapshot; supervisor |

The executable dependency manifest should pin compatible Node/Git ranges, pi and relay revisions, skill revisions and content hashes. The existing SHA references in prose are not a substitute for verifying the bytes actually loaded. Missing capabilities must fail before project mutation. Runtime model/provider/thinking fields need observed attestation or an explicit unverified result, not inference from response length.

## Phase 0: containment and regression baseline

**Dependencies:** none beyond the existing scripts and disposable fixture tooling.

Make GC report-only. Disable implicit pushes, publishing, destructive operations and persona-granted capability changes. Until lifecycle recovery is fixed, do not automatically redispatch an uncertain live writer. Preserve old run directories instead of using --force to overwrite evidence.

Commit the audit regression harness as a failing characterization suite, with each case mapped to its finding. Move the pi version shim into the original offline selftest so pi installation and credentials are unnecessary. Keep the pure verdict tests independent of runtime discovery. Retain the 38/2 baseline and the no-pi zero-test log as historical evidence, not passing results.

**Acceptance:** a fresh environment runs a nonzero known test count. No external API calls occur in offline tests. All original failures and current counterexamples have named tests. CI reports skipped integration tests separately from unit tests.

**Tests:** no-pi environment, normal mutation detection, invalid enum inputs, valid PASS/REVISE/FAIL fixtures, failing and skipped test-count enforcement. Repeat process tests on Linux and macOS with reliable process cleanup.

## Phase 1: evidence and approval correctness

**Dependencies:** Phase 0; contracts, run-store and snapshot modules.

Repair R01-R06 and R10-R13. Allocate immutable attempt directories and correlate every result with its dispatch ID, input brief hash, plan generation and workspace. Reject duplicate attempts without touching their artifacts. Apply path validation before both poll and dispatch I/O. Use an own-property enum check. Parse and validate schemas before accessing fields or updating accounting.

Define a canonical `snapshotId`. It must include maintained content, relevant untracked files, staged state, file types/modes and symlink targets, with an explicit exclusion policy. Hash large files incrementally. Use semantic index entries rather than incidental index-file cache bytes. Git/read failures must not silently become a clean or absent path. Persist before and after snapshot IDs and require final approval to reference an accepted implementation snapshot and a successful matching verification snapshot.

Use atomic publication and one writer for state. Never reset corrupt spend to zero. Record unknown cost distinctly from a known zero; validate finite nonnegative amounts, preferably with explicit fixed units/decimal handling. Make result ingestion idempotent by attempt ID. Make PASS require all required plan steps complete and evidence sufficient for approval. Fix invalid template examples and validator error handling.

**Acceptance:** R01-R06, R10-R13 regression cases pass; duplicate attempts preserve all prior bytes; no stale result can satisfy a fresh attempt; snapshot identity changes for every relevant mutation; invalid schemas and failed evidence persistence cannot produce approval.

**Tests:** A01-A11, A15-A20, A22, A24-A25; staged/untracked/binary/large/symlink/mode changes; denied reads; broken Git commands; unknown JSON keys/enums/types; partial writes; disk-full/permission failures; concurrent readers; double result ingestion; corrupted spend. A23 remains a policy decision unless the schema adds explicit execution evidence.

## Phase 2: lifecycle and scheduling correctness

**Dependencies:** Phase 1; supervisor and acceptance-generation support.

Repair R07-R09 and S12. Distinguish RUNNING, ABORTING and settled terminal states. Track owned process identity and current run/attempt generation. Request cancellation and wait for owned writers to stop; use bounded escalation appropriate to the platform. An unresolved writer blocks reuse of its worktree. Do not substitute a PID-exists check for proof that the same process owns the run.

Bind acceptance to the exact accepted dispatch, plan version and snapshot. Invalidate downstream acceptance when research, implementation or repair changes its input. Re-entry chooses the first unmet accepted deliverable, not the first phase without a COMPLIANT exit. Update the target snapshot after repair. Define which successful, partial and rejected attempts count toward the cycle budget; rejected invocations consume no execution cycle. Only known compatible implement/repair sessions may be resumed.

Separate heartbeat liveness, active command and completed-slice progress. Redispatch requires old-writer settlement and a new lease generation. Late results from older generations are rejected or archived, never applied to current state.

**Acceptance:** no two active writers own the same ticket/worktree. No worker mutation occurs after a settled terminal status. Crashes and context re-entry cannot skip required acceptance or reuse stale verification. Cycle and spend counters survive retry and recovery without going backward.

**Tests:** A12-A14 and A32; TERM-resistant worker, descendants, killed supervisor, slow startup, delayed result, PID reuse, active long install/test, completed failing verification, rejected COMPLIANT report, repair followed by verify, revised research, and crashes before/after each state transition. Test the Linux and macOS process strategies independently.

## Phase 3: factory and instruction consistency

**Dependencies:** Phases 1-2; factory-state helper and canonical root resolution.

Repair S01-S11. Capture `review_base` before diagnosis, scaffold, glossary or implementation mutations. Resolve the current intended source ref separately from bootstrap configuration. Initialize absent and unborn repositories before worktree setup. Give scaffold a valid execution contract before requiring it to implement; do not overwrite an existing repository's baseline with scaffold-introduced failures.

Use immutable run identity and absolute shared-root paths. Serialize control-plane read/write/commit transactions and integration-head updates. Every shared write must be inside its transaction; staging everything after an unlocked write is not safe. Keep actual user capabilities separate from persona recommendations. A GitHub tracker does not authorize publishing.

Unify tracker, ticket and run status enums. Propagate blocked dependencies into explicit terminal outcomes. Preserve the shared control worktree, unrelated runs and recoverable stuck work. Persist a final verdict artifact for loop termination. Replace destructive GC with a candidate report, and permit collection only after clean/reachability/ownership or verified-archive checks.

Replace universal red-at-base with typed criteria: changed behavior needs a causal red, preserved invariants stay green, documentation/state changes have appropriate observations. A new test must be made available at base without bringing its implementation; test-not-found is not a valid red. Replace whole-diff grep with added-line/semantic checks and allow evidence-backed no-change documentation. Keep quarantine visible and require specific proof for the bug under repair.

Bound review iterations, but add independent targeted resolution verification after fixes. Review whole per-ticket ranges, not just the previous commit. Implement flat review directly at the controller's supported spawn level rather than using a nested wrapper. Preflight every required skill/relay capability before mutation.

**Acceptance:** A26-A31 meet their intended workflow contracts. All textual instructions, help output, templates and executable state transitions agree. End-to-end fixtures terminate accurately without unauthorized side effects, stale bases, empty review ranges or data loss.

**Tests:** feature, fast bug, escalated bug, flaky bug, absent repo, unborn repo, existing monorepo, skill-only output, dirty checkout, missing dependencies, flat-spawn harness, mid-run resume, stopped worker, blocked DAG, multiple concurrent goals, stale bootstrap, disconnected/renamed remote, dirty/unmerged GC candidate and an unauthorized remote-write request.

## Observability

Emit structured events with run ID, attempt ID, phase, generation, previous/next state, source/ref and plan hashes, before/after snapshot IDs, accepted evidence IDs, process ownership, cancellation state, cycle counts and cost-known/unknown status. Record wall-clock timestamps for correlation and monotonic durations for timeouts. Redact command arguments and outputs before persistence; default artifacts to private permissions. Do not store raw credentials in committed control history.

Monitor these invariants: approvals without matching verified snapshots = 0; duplicate active write leases = 0; writes after settled terminal state = 0; stale result acceptances = 0; silently reset spend = 0; GC of dirty/unretained work = 0. Record explicit reasons for unverifiable snapshots, blocked capability checks, quarantine changes, stale leases and refused GC candidates. These can be local JSON reports; no monitoring service is required for the initial repair.

## Migration

Freeze active runs before changing state formats. Inventory processes, run directories, worktrees, branch tips and dirty/index/untracked changes. Preserve a verified recovery bundle for any work that might be removed. Do not delete or rewrite existing v1 evidence.

Write new runs using a v2 schema. Keep v1 runs readable but do not treat their old HEAD-plus-worktree-diff identities as v2 verification. A resumed v1 run must resolve its true base and current snapshot, re-establish acceptance and run fresh targeted verification. Existing acceptance markdown remains historical, not automatically trusted. Do not re-execute irreversible external actions just to reconstruct a missing event.

Retire stale goal/bootstrap refs only after their configuration and unmerged work have been accounted for. Keep GC report-only through migration. Move one fixture and then one authorized low-risk real run to v2 before enabling autonomous mode broadly.

## Rollback

Keep the previous code revision and all evidence readable. Roll back executable changes independently of application branches; never use a hard reset, forced worktree deletion or ledger purge as rollback. A failed rollout returns to supervised/report-only operation, not the known unsafe autonomous behavior. Cancel and settle owned workers before changing the runtime. Restore work only from verified archived refs/diffs, then inspect and test it before resuming.

## Suggested reviewable commit sequence

1. Add offline test isolation, failing regression cases and CI test-count enforcement.
2. Fix closed phase/path validation and verdict structural/cross-field checks.
3. Add immutable attempts, atomic evidence persistence and strict result/accounting schemas.
4. Replace the incomplete diff identity with canonical snapshots and fail-closed read-only checks.
5. Add supervised cancellation, acceptance generations, resume/session validation and cycle accounting.
6. Correct factory roots, source/review bases, permissions and report-only GC.
7. Unify graph completion, scaffold contracts, quarantine and targeted post-fix verification.
8. Add dependency/harness preflight, migration tooling and platform integration fixtures.

Each commit should include its own regression tests and an updated source-to-contract mapping. Enable the final autonomous release gate only after the complete dependent sequence passes.
