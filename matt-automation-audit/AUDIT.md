# matt-automation: comprehensive critique and regression audit

**Repository:** PyModel/matt-automation  
**Audited commit:** `fe49e377695de0081f7951f81a513417a481dff0`  
**Audit date:** September 8, 2026  
**Verdict:** Not ready for unattended autonomous operation. Retain the architecture, but repair its evidence, permission, lifecycle and cleanup guarantees before relying on automated approval.

## What was actually inspected and executed

All 26 tracked files at the pinned commit were read: 18 Markdown documents, three YAML metadata files, three JavaScript scripts and two ignore files. No repository changes, pushes, merges or issue mutations were made. The three executed JavaScript files were copied from authenticated connector responses and each matched GitHub's exact Git blob hash; see `source-manifest.json`.

Execution used Linux, Node 22.16.0 and Git 2.47.3. The real pi CLI, model API and external pi-delegate implementation were not exercised. The offline run used a test-only `pi --version` shim and synthetic relay responses. Git fixtures were disposable and did not contain user work. Only the bundled dispatcher, validator and selftest were executed; the Markdown orchestration skills were not run end to end.

| Check | Observed result |
|---|---|
| Syntax checks | All three JavaScript files passed `node --check` |
| Original selftest without pi | Exit 0 after SKIP; zero assertions ran |
| Original selftest with version shim and its own stub relay | 38 passed; 2 lifecycle/polling assertions failed |
| Additional adversarial checks | 34 selected checks: 30 unmet safety properties, 3 passing controls, 1 advisory |

The adversarial cases deliberately target weaknesses found during reading. Their result is **not** a statistical defect rate, a benchmark score or 30 independent bugs. Related failures are grouped into the findings below. Cases A19-A20 inject contradictory relay evidence; A23 is a proposed stricter policy rather than a confirmed contract violation; A26-A31 reproduce documented Git commands/order in fixtures; A32 uses a controlled slow-terminating relay. These distinctions are recorded in `adversarial-results.json`.

## Priority and evidence conventions

P1 means fix before unattended writes, cleanup or approval. P2 means a material correctness, recovery, portability or maintainability issue. No P0 remote compromise is asserted. Each finding distinguishes executed reproduction from a verified textual/control gap whose operational consequence is inferred. A static control gap is not a claim that a live incident already occurred.

## Most important invariants currently broken

A rejected invocation must not mutate earlier evidence. An accepted result must belong to the current attempt. A verification result must target the exact final deliverable. A settled terminal state must exclude surviving writers. A persona must not create user authorization. A stale run must not be assumed disposable. A successful final verdict must not coexist with an explicitly incomplete plan.

## Findings index

| ID | Priority | Finding |
|---|---|---|
| R01 | P1 | A rejected duplicate destroys the original dispatch status |
| R02 | P1 | Forced retries can accept stale successful relay output |
| R03 | P1 | The recorded diff identifier does not identify the deliverable |
| R04 | P1 | Read-only phases can modify files and still report workspace unchanged |
| R05 | P1 | Inherited object properties bypass the phase enum and all phase policy |
| R06 | P1 | Path validation is inconsistent and permits writes outside the intended boundary |
| R07 | P1 | ABORTED does not mean the worker has stopped writing |
| R08 | P2 | Acceptance and re-entry are not tied to a specific execution generation |
| R09 | P2 | Session and cycle accounting enforce the wrong boundary |
| R10 | P2 | Corrupt accounting silently resets the spend budget |
| R11 | P2 | Malformed evidence can crash the supervisor or contradict COMPLIANT |
| R12 | P1 | The verdict validator approves an explicitly incomplete plan |
| R13 | P2 | Evidence has no atomic publication or enforced writer ownership |
| R14 | P2 | The test suite can be green with zero assertions, and lifecycle tests currently fail |
| S01 | P1 | The bug fast path can review an empty diff after delivering a real fix |
| S02 | P1 | Automatic GC can destroy uncommitted or not-yet-delivered work |
| S03 | P1 | An existing bootstrap branch freezes the base of future runs |
| S04 | P1 | Persona answers and tracker configuration are confused with user authorization |
| S05 | P1 | Shared control-state mutations and worktree paths are not safe under the promised concurrency |
| S06 | P2 | Completion and recovery criteria can be impossible or deadlock the graph |
| S07 | P2 | Several quality gates create false positives or rewrite valid requirements |
| S08 | P2 | Quarantine can hide a newly worsened regression |
| S09 | P2 | Final fixes are not independently re-verified against the review findings |
| S10 | P2 | Greenfield setup does not handle its own unborn-repository case |
| S11 | P2 | Clean-install dependencies and harness capabilities are not reproducible |
| S12 | P1 | Stuck detection can redispatch while the previous writer is still active |

## Detailed findings

### R01 [P1] A rejected duplicate destroys the original dispatch status

**Evidence level:** Reproduced against the hash-verified dispatcher.

**Source:** [`to-orc/scripts/orc-dispatch.mjs:174-198,478-482`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/orc-dispatch.mjs)

**Regression cases:** A01 in `adversarial-results.json`.

**Defect.** The existing-task guard calls finish(ctx, PRECONDITION_FAILED). finish writes to the same task/orc-status.json it is supposed to preserve. The test first completed a dispatch successfully, retried without --force, and observed its COMPLIANT evidence replaced with PRECONDITION_FAILED.

**Consequence.** A harmless retry can erase completed evidence; retrying an active task can replace its RUNNING record while its worker continues. Subsequent polling and re-entry no longer describe the original execution.

**Remedy.** Acquire task ownership before dispatch. Reject duplicate task IDs without writing into the existing task directory. Use immutable attempt directories and a separate invocation-error record; do not reuse result paths.

**Acceptance and tests.** A duplicate invocation leaves every existing artifact byte-identical. Repeat for successful, failed, and RUNNING tasks, and for two simultaneous invocations.

### R02 [P1] Forced retries can accept stale successful relay output

**Evidence level:** Reproduced with a relay that exits zero without writing a new result.

**Source:** [`to-orc/scripts/orc-dispatch.mjs:478-482,555-576`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/orc-dispatch.mjs)

**Regression cases:** A02 in `adversarial-results.json`.

**Defect.** --force permits reuse of a task directory but does not clear or version result.json. The next dispatch reads whichever result.json exists. A successful first dispatch followed by a no-result retry returned COMPLIANT using the old result.

**Consequence.** The controller can report successful execution that did not occur in this attempt, reuse an old session and report, and double-record old usage.

**Remedy.** Give every attempt an unguessable dispatch ID and exclusive directory. Bind relay results to that ID, the brief digest, workspace identity, configuration and attempt start. Reject absent, stale, mismatched or duplicated results. Merely checking mtime is insufficient.

**Acceptance and tests.** A retry with no fresh result must fail. Old final.txt, result.json and session IDs must never satisfy a new attempt. Preserve old attempts for auditability.

### R03 [P1] The recorded diff identifier does not identify the deliverable

**Evidence level:** Reproduced for both untracked and staged changes.

**Source:** [`to-orc/DELEGATION.md: The change set is produced by the dispatcher`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/DELEGATION.md); [`to-orc/PHASES.md: Diff identifier and Phase 4`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/PHASES.md); [`to-orc/scripts/orc-dispatch.mjs:543-552`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/orc-dispatch.mjs)

**Regression cases:** A06, A07 in `adversarial-results.json`.

**Defect.** The documented comparison uses HEAD plus worktreeDiffSha, which is the digest of plain git diff. That excludes untracked files and staged content. The tests changed a new file between implement and verify, once untracked and once staged; both phases returned COMPLIANT with the same documented identity.

**Consequence.** The controller can believe verification covered the accepted implementation when a materially different staged or untracked deliverable was examined.

**Remedy.** Create one canonical snapshot ID containing HEAD, index state, maintained tracked content, untracked deliverables, path/type/mode metadata and symlink targets. Persist beforeSnapshotId and afterSnapshotId. Bind verification to the latest accepted implement or repair snapshot, not just a worktree diff.

**Acceptance and tests.** Any relevant staged, unstaged, untracked, renamed, deleted, mode or symlink change changes the snapshot ID. Verification refuses mismatches before starting and proves its before/after snapshot is unchanged.

### R04 [P1] Read-only phases can modify files and still report workspace unchanged

**Evidence level:** Three distinct cases reproduced.

**Source:** [`to-orc/scripts/orc-dispatch.mjs:217-278,606-620`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/orc-dispatch.mjs)

**Regression cases:** A03, A04, A05 in `adversarial-results.json`.

**Defect.** Files larger than 8 MiB are fingerprinted only by size. diffFingerprints never compares worktreeDiffSha. A same-size edit of an already-dirty tracked large file therefore passes even though git diff changes. With --repo set to a Git subdirectory, porcelain paths are incorrectly joined to that subdirectory; failed stat calls become absent and hide edits. statSync follows untracked symlinks, so retargeting a link between equal-content targets also passes.

**Consequence.** The advertised read-only gate can produce a false clean result on ordinary supported inputs. This is separate from the explicitly documented ignored-file limitation.

**Remedy.** Resolve the true Git worktree root. Stream content hashing rather than switching to size-only hashes. Use lstat/readlink and explicit file types. Treat I/O and Git failures as unverifiable errors, not absent files. Compare all relevant snapshot components. Use deterministic Git flags and avoid optional index locks during observation.

**Acceptance and tests.** The three fixtures must report NO_WRITES_VIOLATED. Add tracked binary files, permissions, submodules, unreadable paths, deleted links, large diffs, unusual path names, and ignored-file policy tests.

### R05 [P1] Inherited object properties bypass the phase enum and all phase policy

**Evidence level:** Reproduced: --phase constructor --timeout 1s returned COMPLIANT.

**Source:** [`to-orc/scripts/orc-dispatch.mjs:48-56,398-410,433-447,606-620`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/orc-dispatch.mjs)

**Regression cases:** A18 in `adversarial-results.json`.

**Defect.** PHASES is a normal object and validation checks only whether PHASES[opts.phase] is truthy. constructor resolves to an inherited function. Providing a valid explicit timeout avoids the incidental undefined-timeout rejection. The inherited value has no writes, after or session policy, so the safety gates do not apply.

**Consequence.** An undeclared phase can execute without the required ordering, session or no-write restrictions. The ordinary invalid-name test does not cover this JavaScript-specific edge case.

**Remedy.** Validate with Object.hasOwn(PHASES, phase) or a Map before deriving any policy. Validate the policy object against a closed schema. Add constructor, __proto__, toString and other inherited names to negative tests.

**Acceptance and tests.** Every undeclared name fails before creating artifacts or running the relay, regardless of timeout, session or other flags.

### R06 [P1] Path validation is inconsistent and permits writes outside the intended boundary

**Evidence level:** Reproduced with four disposable path fixtures.

**Source:** [`to-orc/scripts/orc-dispatch.mjs:355-395,398-430`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/orc-dispatch.mjs)

**Regression cases:** A08, A09, A10, A11 in `adversarial-results.json`.

**Defect.** The containment test uses startsWith(".."), so a child directory named ..artifacts passes. Lexical path.resolve does not resolve an outside symlink pointing inside the workspace. Missing-brief validation calls finish before containment and writes a status into an explicitly forbidden workspace directory. Poll mode runs before normal task validation; --task ../outside read and rewrote a neighboring status file.

**Consequence.** Artifacts can contaminate the worktree, and a malformed task can read or mutate another run record. These are local path-boundary defects, not a claim of a remotely exploitable service.

**Remedy.** Use shared argument validation for dispatch and poll. Resolve/validate canonical roots and path segments before any read or write. Refuse symlink escapes and reserved directory collisions. Validate the closest existing ancestor for a not-yet-created output path, then create it with exclusive ownership.

**Acceptance and tests.** All four fixtures refuse safely and leave both the workspace and unrelated run directories unchanged. Include symlinked task directories and nested Git-worktree roots.

### R07 [P1] ABORTED does not mean the worker has stopped writing

**Evidence level:** Reproduced with a controlled slow-terminating relay.

**Source:** [`to-orc/scripts/orc-dispatch.mjs:375-388,492-518`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/orc-dispatch.mjs)

**Regression cases:** A32 in `adversarial-results.json`.

**Defect.** The signal handler sends SIGTERM only to the immediate relay child and immediately writes ABORTED and exits. It does not wait for termination or settle descendants. In the test, the supervisor exited 76 with ABORTED; the relay then wrote a new workspace file. The terminal record also loses the live relay PID.

**Consequence.** Following the documented fresh-implement recovery can race with the previous worker. Polling a terminal record does not check whether a writer still survives.

**Remedy.** Introduce an ABORTING state. Supervise an owned process group or equivalent containment, request cancellation, wait for a bounded grace period, escalate where appropriate, and verify settlement before declaring ABORTED. Preserve process identity and unresolved-child evidence. Prevent a new writer from acquiring the workspace until settlement is proven.

**Acceptance and tests.** The controlled delayed writer cannot mutate after a settled terminal state. Exercise descendants, ignored TERM, supervisor kill, PID reuse and cancellation on both Linux and macOS. An unresolved live writer must remain a blocker, never be treated as safely stopped.

### R08 [P2] Acceptance and re-entry are not tied to a specific execution generation

**Evidence level:** Verified instruction/code mismatch; end-to-end agent manifestation not executed.

**Source:** [`to-orc/PHASES.md: Accepting a phase, Re-entry, Repair and termination`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/PHASES.md); [`to-orc/DELEGATION.md: Incomplete reports`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/DELEGATION.md); [`to-orc/scripts/orc-dispatch.mjs:440-447`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/orc-dispatch.mjs)

**Defect.** The only ordering key is a nonempty accepted/<phase>.md file. It is not bound to a dispatch, plan version, workspace or snapshot and is not invalidated after revised research or repair. Re-entry looks for a phase with no COMPLIANT dispatch even though the docs explicitly say COMPLIANT is not acceptance. It also refers to a RUNNING sentinel with no status file that the dispatcher never creates. Fresh-session follow-ups conflict with repair requiring resume.

**Consequence.** A resumed run can become stranded after an incomplete COMPLIANT report or reuse stale acceptance after the plan or implementation changed. Repair can leave verification compared with the original implementation identity.

**Remedy.** Separate execution outcome, deliverable acceptance and terminal run verdict. Store typed acceptance records linked to exact dispatch IDs, plan generations and snapshots. Invalidate dependent acceptances on upstream changes. Re-enter from the first unmet acceptance condition, with explicit repair/research transitions.

**Acceptance and tests.** Resume fixtures cover COMPLIANT-but-rejected reports, completed failing verification, revised research, repair, crashes at every transition, and stale acceptance files. Each resumes exactly once at the correct phase.

### R09 [P2] Session and cycle accounting enforce the wrong boundary

**Evidence level:** Reproduced for unknown repair sessions, refused repairs and repeated implementations.

**Source:** [`to-orc/scripts/orc-dispatch.mjs:306-317,451-461`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/orc-dispatch.mjs); [`to-orc/PHASES.md: Repair and termination`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/PHASES.md)

**Regression cases:** A12, A13, A14 in `adversarial-results.json`.

**Defect.** Unknown repair sessions are accepted because the source check only rejects a found TIMEOUT/ABORTED session. All records whose phase is repair count against the cap, including precondition refusals that spawned no worker. Conversely, unlimited fresh implement phases are not counted toward the documented total implementation/verification cycle cap.

**Consequence.** An invalid invocation can consume the only repair allowance, while a fresh implement loop bypasses the intended limit. A repair can resume a session unrelated to this run or phase.

**Remedy.** Require the repair source to be an accepted, successful implement/repair dispatch in the same run and workspace. Count explicitly started cycles from an append-only execution ledger. Define retries, partial attempts and repair rounds separately and apply the cap consistently.

**Acceptance and tests.** The three regression cases meet the intended policy. A rejected invocation changes no counters; unknown/wrong-workspace/wrong-phase sessions fail; completed cycles cannot be bypassed by choosing a different phase name.

### R10 [P2] Corrupt accounting silently resets the spend budget

**Evidence level:** Reproduced for truncated spend.json; concurrency risks verified statically.

**Source:** [`to-orc/scripts/orc-dispatch.mjs:284-304,464-468,576-581`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/orc-dispatch.mjs)

**Regression cases:** A15, A17 in `adversarial-results.json`.

**Defect.** spentSoFar returns zero on any parse/read error. recordSpend starts a new ledger on malformed JSON, accepts unvalidated entry shapes and writes the entire ledger without a transaction. The capped test dispatched and replaced corrupted accounting with a new $0.01 total instead of refusing.

**Consequence.** A damaged ledger can permit more spending. Concurrent read-modify-write operations can lose entries. Missing or malformed cost values are not distinguished from known zero cost.

**Remedy.** Validate versioned accounting records and finite nonnegative values. Unknown or corrupt accounting fails closed. Serialize append operations, assign idempotent dispatch IDs, and reconstruct totals from valid immutable entries. Preserve corrupt records for diagnosis rather than silently resetting them.

**Acceptance and tests.** Corruption, negative/NaN/infinite/string costs, interrupted writes, duplicate result ingestion and concurrent updates cannot lower recorded spend. The current --max-cost is documented as a pre-dispatch threshold, not a hard in-flight cap; a hard cap needs a separate reservation/streaming mechanism.

### R11 [P2] Malformed evidence can crash the supervisor or contradict COMPLIANT

**Evidence level:** Reproduced with valid JSON of the wrong shape and contradictory test relay fields.

**Source:** [`to-orc/scripts/orc-dispatch.mjs:332-351,510-620`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/orc-dispatch.mjs)

**Regression cases:** A16, A17, A19, A20 in `adversarial-results.json`.

**Defect.** JSON parsing is mistaken for schema validation. result.json containing null causes a TypeError and leaves RUNNING behind; entries:null in spend.json does the same. A relay process exiting zero with result.exitCode=5, or stopReason=error, is accepted as COMPLIANT. The real external relay was unavailable, so the contradictory result cases are injected contract tests, not reported real-provider incidents.

**Consequence.** Malformed-but-parseable evidence can lose the failure reason, leave a false in-flight record, or be treated as successful despite contradictory fields.

**Remedy.** Validate complete result, status and spend schemas before dereferencing or accounting. Reconcile process exit, worker exit and stop reason. Add a top-level error boundary that preserves the original error and writes a typed terminal failure when safe. If terminal persistence fails, exit nonzero and preserve recoverable evidence.

**Acceptance and tests.** Wrong JSON shapes, missing keys and contradictory fields produce deterministic typed failures, never COMPLIANT or stale RUNNING. Fault-inject read/write failures and truncated final writes.

### R12 [P1] The verdict validator approves an explicitly incomplete plan

**Evidence level:** Reproduced, with additional structural defects.

**Source:** [`to-orc/scripts/validate-verdict.mjs:24-40,55-60,86-97`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/validate-verdict.mjs); [`to-orc/VERDICT.md: Verdict rules and Template`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/VERDICT.md)

**Regression cases:** A22, A24, A25 in `adversarial-results.json`.

**Defect.** A PASS/APPROVE verdict with every phase true but plan_compliance.all_steps_completed=false passes validation. The checker only verifies that field is boolean. It also throws on top-level null and rejects backticks inside a valid JSON string as if they were wrapping Markdown. The shipped template itself uses REVISE with all phase flags false, which its checker rejects.

**Consequence.** The final safety check can bless a verdict that explicitly admits incomplete work. Other valid data produces misleading failures or uncaught exceptions.

**Remedy.** Make PASS require all_steps_completed=true in addition to the existing rules. Return immediately after invalid top-level shape. Let JSON parsing reject actual wrapping prose/fences rather than substring-matching string contents. Validate the shipped template in tests. Represent actual execution count/evidence explicitly rather than trying to infer it from prose.

**Acceptance and tests.** A22, A24 and A25 meet their expected outcomes. Validate PASS, REVISE and FAIL fixtures and every shipped example. A23 is deliberately classified as advisory: all-false flags alone do not prove no worker was dispatched, so forcing a null score solely from those flags needs an explicit policy decision.

### R13 [P2] Evidence has no atomic publication or enforced writer ownership

**Evidence level:** Verified static control gap; exact concurrent interleavings were not exhaustively exercised.

**Source:** [`to-orc/scripts/orc-dispatch.mjs:174-188,284-304,478-507`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/orc-dispatch.mjs); [`to-orc/DELEGATION.md: Worker reports are untrusted input`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/DELEGATION.md)

**Defect.** Status and spend writes truncate their destination directly. Background parent and child both publish to the same status path after the child is spawned; no handshake or compare-and-swap prevents an older RUNNING publication from replacing a newer state. There is no per-task lock. The controller and relay share filesystem privileges, while the docs treat worker reports as untrusted. Artifact file permissions depend on ambient umask.

**Consequence.** Polling can observe partial JSON; concurrent attempts can interleave evidence; same-privilege worker access is not a security boundary around control records. These are reliability/threat-model gaps, not evidence of a successful prompt-injection attack.

**Remedy.** Use one authoritative writer, exclusive attempt ownership, generation-checked state transitions and atomic temp-write/rename publication. Keep artifacts private by default. Put controller state outside worker write permissions when untrusted repositories are in scope; otherwise explicitly document that limitation.

**Acceptance and tests.** Stress readers during writes, race duplicate task creation, delay the background parent and simulate disk-full/permission errors. No older state may replace a newer generation and a failed evidence write may never end in successful approval.

### R14 [P2] The test suite can be green with zero assertions, and lifecycle tests currently fail

**Evidence level:** Executed the unchanged hash-verified selftest in Linux/Node 22.16.0/Git 2.47.3.

**Source:** [`to-orc/scripts/selftest.mjs:125-128,329-367,401-421`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/scripts/selftest.mjs); [`to-orc/SKILL.md: Maintaining this skill`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/SKILL.md)

**Defect.** Without pi installed, the entire selftest exits zero after SKIP, including validator tests that do not need pi. With a test-only pi --version shim and the suite's own stub relay, 38 tests passed and two immediate post-kill/orphan polling tests failed. The tests assume process disappearance immediately after signaling and do not reliably clean up all owned children on failure.

**Consequence.** CI or a fresh developer environment can report success without checking anything. The existing suite does not prove the lifecycle guarantees it advertises.

**Remedy.** Stub runtime availability inside the test suite and keep pure validator tests independent. Split offline unit tests from opt-in real-relay integration tests. Wait for process-state transitions rather than asserting synchronous death; clean up process groups in finally blocks. Add CI with a minimum executed-test count.

**Acceptance and tests.** Offline tests execute without pi credentials or installation and pass on Linux and macOS. Integration skips are explicit and cannot masquerade as executed tests. Treat the two observed failures as environment-specific results until reproduced on other platforms.

### S01 [P1] The bug fast path can review an empty diff after delivering a real fix

**Evidence level:** Verified stage-order defect, with a disposable Git reproduction.

**Source:** [`to-bug/SKILL.md: Overrides, Stage 2 and fast path`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-bug/SKILL.md); [`to-goal/PLAN.md: Bug fast path`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/PLAN.md); [`to-goal/BUILD.md: opening paragraph`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/BUILD.md); [`to-goal/CLOSE.md: stage 8`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/CLOSE.md)

**Regression cases:** A29 in `adversarial-results.json`.

**Defect.** Diagnosis makes and commits the fix in stage 2. BUILD.md records branch-point by reading the current run HEAD at stage 7. Final review diffs from that branch point. On the fast path there may be no later implementation at all, so the reviewed range is empty; if stage 7's normal entry is skipped entirely, the required branch point can be missing instead. Stage-4 glossary/design mutations similarly precede the normal build branch point.

**Consequence.** The mandatory final review can omit the actual bug fix or earlier mutations while the report says review ran.

**Remedy.** Capture immutable review_base before any mutation in bootstrap. Keep source base, review base and per-ticket bases distinct. Persist a change manifest across diagnosis, planning, scaffold and build phases. All final review and test evidence must target the entire resulting deliverable.

**Acceptance and tests.** A committed stage-2 fix produces a nonempty reviewed range including the regression test. Re-entry preserves the same review base. Test both successful and escalated bug routes and changes made during planning.

### S02 [P1] Automatic GC can destroy uncommitted or not-yet-delivered work

**Evidence level:** Documented destructive policy; the force-removal primitive was reproduced safely on a disposable worktree.

**Source:** [`to-goal/BOOTSTRAP.md: Kill switch and GC`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/BOOTSTRAP.md); [`to-goal/CONTROL.md: Run registry`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/CONTROL.md); [`to-goal/PIPELINE.md: Isolation lifetimes`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/PIPELINE.md)

**Regression cases:** A30 in `adversarial-results.json`.

**Defect.** GC uses old heartbeat/dead agent as the decision to git worktree remove --force and delete branches. There is no clean-tree, merged/reachable, archive, recovery-verification or user-confirmation guard. Bootstrap also triggers cleanup of older runs. Run worktrees are explicitly retained for the user to merge later, so inactivity is not proof they are disposable.

**Consequence.** Uncommitted work can disappear, and retained branches can be removed before the user has consumed the deliverable. The fixture confirmed the only copy of an uncommitted file was deleted by the documented primitive.

**Remedy.** Make GC report-only by default. Collect only explicitly owned terminal worktrees that are clean and whose commits are reachable from an approved retained ref. Archive uncommitted/index/untracked data and branch tips with verified recovery before optional deletion. A dead PID alone is never deletion authority.

**Acceptance and tests.** Dirty, unmerged, stopped, ambiguous-ownership and user-retained runs survive GC unchanged. Test expired runs with unique untracked files and commits. Default bootstrap must never force-delete work.

### S03 [P1] An existing bootstrap branch freezes the base of future runs

**Evidence level:** Verified rule and disposable Git reproduction.

**Source:** [`to-goal/BOOTSTRAP.md: stages 0b-0c`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/BOOTSTRAP.md); [`to-goal/PIPELINE.md: Isolation`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/PIPELINE.md)

**Regression cases:** A27 in `adversarial-results.json`.

**Defect.** Setup does nothing when goal/bootstrap already exists, and base selection always prefers it. Nothing refreshes or retires that branch after main advances. The fixture advanced main with a new file; the documented selection chose the older bootstrap SHA without that file. The remote fallback also assumes origin/HEAD and suppresses fetch errors.

**Consequence.** A future task can silently build against obsolete source, tests and configuration instead of the current default branch.

**Remedy.** Resolve and record the intended source ref first. Treat setup as a versioned, idempotent configuration change layered onto that source, not a permanent source branch. Retire or explicitly refresh bootstrap after integration; fail clearly on unresolved or stale remote refs.

**Acceptance and tests.** Second and third runs after default-branch advancement start from the intended new SHA. Cover absent origin, renamed default branch, missing remote HEAD, offline fetch and a partially configured existing bootstrap branch.

### S04 [P1] Persona answers and tracker configuration are confused with user authorization

**Evidence level:** Verified conflicting authorization instructions; no remote mutation was performed in this audit.

**Source:** [`to-goal/KUN.md: Self-answering and Answering a question`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/KUN.md); [`to-goal/SKILL.md: Rules that hold in every phase`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/SKILL.md); [`to-goal/PLAN.md: stage 6 guarded claims`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/PLAN.md); [`to-goal/PIPELINE.md: Sensible defaults`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/PIPELINE.md); [`to-goal/CLOSE.md: stage 9`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/CLOSE.md)

**Defect.** KUN.md calls remotely sourced persona answers the user's final word, and guarded paths are approved through /kun. Separately, the top-level rule blocks pushes not named in the objective, while GitHub-tracker mode tells the agent to push and open/ready a PR regardless of an explicit push grant. Reading a persona or discovering an existing tracker does not establish permission for a consequential action.

**Consequence.** An autonomous run can expand permissions or publish work based on inferred preferences rather than the actual user request.

**Remedy.** Separate recommendation from authorization. Derive a scoped capability record only from the real user request and trusted policy. Persona answers may choose reversible implementation details but cannot grant remote writes, spending, production access or destructive actions. Guarded paths and remote operations need explicit capabilities; unresolved authority remains a blocker.

**Acceptance and tests.** A malicious or merely overconfident persona cannot grant capabilities. Existing GitHub tracker configuration alone never causes a push. Test denied destructive, remote-write, credential, migration and budget-escalation requests without touching real services.

### S05 [P1] Shared control-state mutations and worktree paths are not safe under the promised concurrency

**Evidence level:** Verified control-plane design gaps; real multi-agent concurrency was not executed.

**Source:** [`to-goal/CONTROL.md: Locks and Rules`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/CONTROL.md); [`to-goal/BOOTSTRAP.md: stages 0-0c`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/BOOTSTRAP.md); [`to-goal/LEDGER.md: Layout and Subagent contract`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/LEDGER.md); [`to-goal/BUILD.md: merger and heartbeat bindings`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/BUILD.md)

**Defect.** Subagents share log.md, bugs.md and the control worktree. The control lock surrounds commits, but writes may occur first; git add -A can capture another writer's half-finished state and overlapping read-modify-write updates can be lost. Run mergers have no explicit integration-head lock. After entering a run worktree, relative .worktrees/control paths and .git/goal-locks no longer necessarily name the shared control plane; .git may be a file. --force duplicate objectives also lack a clear immutable run-directory identity.

**Consequence.** Parallel work can corrupt or misattribute state, commit incomplete records, use the wrong path, or contend over one integration branch. These are risks derived from the documented transaction boundaries, not a claim that corruption was observed in Mo's repository.

**Remedy.** Establish canonical absolute roots and immutable run IDs before mutation. Use one control-state writer or one lock over the complete read/validate/write/commit transaction, with a defined lock order and targeted staging. Serialize integration-head changes and fence duplicate controllers. Keep all agents on the same resolved run context.

**Acceptance and tests.** Interleave two objectives and three workers with fault injection between write and commit. No lost record, cross-run artifact, wrong attribution or wrong-root write occurs. Test normal, linked and relocated worktrees.

### S06 [P2] Completion and recovery criteria can be impossible or deadlock the graph

**Evidence level:** Verified inconsistent criteria; worktree-count contradiction reproduced.

**Source:** [`to-goal/CLOSE.md: stages 9-10`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/CLOSE.md); [`to-goal/PIPELINE.md: Completion criteria and Under /loop`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/PIPELINE.md); [`to-goal/BUILD.md: Stuck detection and Done when`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/BUILD.md); [`to-goal/LEDGER.md: Re-entry`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/LEDGER.md)

**Regression cases:** A31 in `adversarial-results.json`.

**Defect.** Hand-back requires only the user checkout and run worktree, but the mandatory persistent control worktree makes at least three; concurrent objectives add more. BUILD allows stuck tickets, while other completion rules demand every ticket merged/closed. Descendants of a stuck prerequisite have no explicit terminal blocked state. Fast-path skipped stages are not consistently reconciled with generic stage-completion gates. Final-report existence is used for loop termination without a clearly defined persisted final-report artifact.

**Consequence.** An agent can loop forever trying to satisfy mutually incompatible criteria or wrongly delete useful worktrees to satisfy the count. Partial runs can be labeled done without a coherent terminal state.

**Remedy.** Define one state machine with explicit succeeded, partial, blocked, stopped and failed outcomes. Propagate blocked-by-terminal-failure through the graph. Scope cleanup to worktrees owned by completed tickets, preserve the shared control plane and unrelated runs, and persist a terminal verdict at a canonical path.

**Acceptance and tests.** A blocked DAG terminates with an accurate partial report and preserved work. Fast-path resume never redoes skipped stages. Hand-back accepts the required control worktree and unrelated concurrent runs.

### S07 [P2] Several quality gates create false positives or rewrite valid requirements

**Evidence level:** The no-debt grep false positive was reproduced; other gates verified statically.

**Source:** [`to-goal/PLAN.md: stages 4b and 6b`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/PLAN.md); [`to-goal/PIPELINE.md: Completion criteria`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/PIPELINE.md); [`to-goal/PITFALLS.md: to-tickets and code-review guards`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/PITFALLS.md)

**Regression cases:** A26 in `adversarial-results.json`.

**Defect.** The no-debt command greps the entire diff, including removed lines and context: removing an old TODO is rejected. Every acceptance criterion is required to fail at base, which is wrong for compatibility, preservation and security invariants that should already pass. A new regression test may not exist at base, so test-not-found is not proof of a behavioral red. Mandatory eight user stories and a changed CONTEXT.md can create unnecessary scope and no-op documentation edits.

**Consequence.** The pipeline can reject correct cleanup, weaken or rewrite valid requirements to force a red result, and manufacture work for small tasks.

**Remedy.** Separate new behavior from preserved invariants. New behavior needs a causally relevant red assertion with its test-only patch available at base; invariants must remain green. Inspect relevant added lines or parsed constructs instead of raw diff text. Scale documentation to actual decisions and allow an evidence-backed no-change result.

**Acceptance and tests.** Deleting a TODO, quoting TODO in a test fixture and preserving an already-working security invariant all pass appropriately. A missing test file never qualifies as a behavioral reproduction.

### S08 [P2] Quarantine can hide a newly worsened regression

**Evidence level:** Verified documented comparison policy; no application test suite was executed.

**Source:** [`to-goal/BOOTSTRAP.md: stage 0d baseline`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/BOOTSTRAP.md); [`to-goal/BUILD.md: implementer rules 4 and 6`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/BUILD.md); [`to-bug/SKILL.md: Not reproducible`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-bug/SKILL.md)

**Defect.** Tests failing one or two of three baseline runs are excluded from later no-worse-than-baseline comparisons and stuck counts. A formerly intermittent failure that becomes deterministic can therefore be ignored. A reported flaky bug is considered reproduced after one red but lacks a required deterministic post-fix proof or bounded repeated-run acceptance.

**Consequence.** The suite can be described as no worse than baseline while a quarantined behavior became materially worse or the reported flaky bug remains.

**Remedy.** Preserve baseline observations without treating three samples as a diagnosis. Give quarantine an owner, reason and expiry; continue executing and reporting it. Define targeted regression acceptance, controlled seeds or repeated reproduction appropriate to the failure. Do not exclude the bug under repair from its own success gate.

**Acceptance and tests.** A quarantined test changing from intermittent failure to persistent failure blocks or explicitly degrades approval. A repaired flaky behavior must meet its targeted evidence criterion, not just happen to pass once.

### S09 [P2] Final fixes are not independently re-verified against the review findings

**Evidence level:** Verified stage-8 workflow gap.

**Source:** [`to-goal/CLOSE.md: stage 8`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/CLOSE.md); [`to-goal/BUILD.md: implementer rule 6`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/BUILD.md); [`to-goal/PITFALLS.md: code-review convergence guards`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/PITFALLS.md)

**Defect.** The final workflow is one fresh review, one fix pass, then the suite. There is no independent targeted verification that each finding was actually resolved or that the fix introduced no new issue. Per-ticket review against the previous commit also covers only the final commit when a ticket used several commits. Cited-finding rules differ between references and can overemphasize written standards over reproducible correctness evidence.

**Consequence.** A reported resolution can rest on the fixer's claim, especially for security, migration or specification issues not covered by the existing suite.

**Remedy.** Capture a per-ticket base at dispatch. Review the full ticket range and final run range. Keep the review loop bounded, but require a fresh targeted resolution check of every fixed finding plus tests on the resulting snapshot. A reproducible bug does not need a pre-existing written standards paragraph to be actionable.

**Acceptance and tests.** Every resolved finding links to a verifying result against the final snapshot. Unverified fixes remain unresolved/blocked. Multi-commit tickets cannot hide early changes from review.

### S10 [P2] Greenfield setup does not handle its own unborn-repository case

**Evidence level:** Unborn worktree failure reproduced; bootstrap ordering gaps verified statically.

**Source:** [`to-new/SKILL.md: What counts as greenfield and Overrides`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-new/SKILL.md); [`to-goal/SKILL.md: phase ordering`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/SKILL.md); [`to-goal/BOOTSTRAP.md: stages 0b-0d`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/BOOTSTRAP.md); [`to-goal/BUILD.md: implementer rules`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/BUILD.md)

**Regression cases:** A28 in `adversarial-results.json`.

**Defect.** to-new says a repository with no commits qualifies, but its initial-commit precondition only handles no repository. A Git-initialized empty repository therefore reaches worktree creation without a base commit. Automatic to-goal greenfield routing occurs at stage 1, after bootstrap already needs a repository/base. Scaffold implementation inherits required install/test commands while the contract is explicitly pending until after the scaffold merges.

**Consequence.** Documented from-anywhere entry can fail before routing, and the first scaffold has no complete execution recipe. Re-baselining an existing monorepo after scaffold changes can also mislabel newly introduced failures as baseline problems.

**Remedy.** Classify repository state before bootstrap: absent, unborn, empty-but-committed and established. Initialize only where authorized. Give scaffold its own minimal command contract before execution, then validate and freeze the full environment contract. Preserve an existing repository's pre-change baseline.

**Acceptance and tests.** Cover all four initial states, a new package in a monorepo, skill-only output, absent Git identity and an explicitly chosen destination. A scaffold cannot normalize its own regressions into baseline.

### S11 [P2] Clean-install dependencies and harness capabilities are not reproducible

**Evidence level:** Verified repository packaging and instruction gaps; Mo's installed sibling skills were not inspected.

**Source:** [`to-goal/SKILL.md: Sub-skill invocation`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/SKILL.md); [`to-goal/BOOTSTRAP.md: capability probe`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/BOOTSTRAP.md); [`to-goal/CLOSE.md: review subagent`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/CLOSE.md); [`to-goal/KUN.md: Cache once`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/KUN.md); [`to-orc/SKILL.md: Mandatory worker configuration`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-orc/SKILL.md)

**Defect.** The repository depends on numerous sibling skills and an external pi-delegate relay but has no install/dependency manifest, compatibility lock, CI, or top-level usage guide. Some missing dependencies are discovered only after control-plane mutations. Flat-spawn mode changes ticket review, but final review still asks a review subagent to invoke a skill that spawns more agents. The kun cache records a SHA without explicitly requiring all fetch URLs and file hashes to be bound to it. Requested :max and model-name evidence does not directly attest actual thinking settings; unknown pi versions only warn.

**Consequence.** A clean clone is not a reproducible executable system, and the advertised any-harness fallback can reach an unsupported nested-spawn path. Current live pi/relay compatibility remains unverified, not proven broken.

**Remedy.** Add a dependency/compatibility manifest and a read-only preflight before any mutation. Resolve immutable skill and relay revisions with integrity hashes. Probe invocation, spawn depth, cancellation, filesystem and background capabilities. Implement a truly flat final review. Attest resolved runtime settings rather than inferring thinking from output volume.

**Acceptance and tests.** A documented clean install passes offline tests; a missing dependency aborts without project mutation. Flat mode never requires nested agents. Cache bytes match recorded revisions. Live runtime attestation has a separately recorded opt-in integration result.

### S12 [P1] Stuck detection can redispatch while the previous writer is still active

**Evidence level:** Verified unsafe recovery rule; concurrent live-agent reproduction was not executed.

**Source:** [`to-goal/BUILD.md: implementer rule 8, Stuck detection`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/BUILD.md); [`to-goal/LEDGER.md: Re-entry protocol`](https://github.com/PyModel/matt-automation/blob/fe49e377695de0081f7951f81a513417a481dff0/to-goal/LEDGER.md)

**Defect.** Three heartbeats with an unchanged slice counter are enough to declare stuck, even if the worker is alive and legitimately installing, compiling or running a long test. The brief explicitly emits multiple heartbeats within a slice. Recovery redispatches from its status file without requiring cancellation and confirmed termination of the previous agent or revocation of its write authority.

**Consequence.** A healthy slow worker can be replaced, leaving two writers acting on the same ticket branch or worktree. A time cap alone is not an exclusive-write guarantee.

**Remedy.** Separate liveness, activity and completed-slice progress. Require a meaningful elapsed no-progress interval and command-aware diagnostics. Before redispatch, revoke the old lease, cancel and confirm termination; otherwise retain a blocker or recover in a separate branch with explicit reconciliation.

**Acceptance and tests.** Long install/test fixtures do not trigger duplicate workers. At most one live writer owns a ticket lease. Late results from an older generation cannot update the new task or mark it complete.

## Additional observations that should not be inflated into confirmed defects

The ignored-file fingerprint limitation is explicitly documented. It still needs a narrow statement of what is protected, but it is not a newly discovered hidden behavior. Non-Git workspaces are explicitly allowed in a degraded mode; the problem is presenting unverifiable evidence as clean or approving without a verified deliverable, not simply accepting such a directory.

The current --max-cost description is a pre-dispatch stop threshold, not an in-flight hard cap. An overshoot by one legitimate dispatch is therefore not, by itself, the corrupt-accounting bug in R10.

The Git command `worktree add --orphan -b ...` is valid in the tested Git version. It is not a syntax defect. The control-plane contradiction is retaining that worktree while demanding that only two worktrees exist.

The role separation, minimal per-ticket worktrees, dedicated spec and standards review, explicit blocker reporting, original small-file mutation detection and source-hash verification are useful foundations. The original offline tests demonstrate several controls really do work. The appropriate remedy is not to discard those controls or add more prompt rules; it is to make their state transitions and evidence boundaries explicit and testable.

Other worthwhile hardening work includes finite bounds for timeout/cost/cycle inputs, collision-safe resource allocation instead of unbounded port arithmetic, one immutable run ID rather than slug identity, explicit output ownership/modes, a consistent local tracker status enum, and a bounded one-call runtime capability probe. Port arithmetic eventually exceeds 65535 as the monotonically increasing run ID grows; no run at that limit was executed here.

## Coverage gaps and residual uncertainty

Live pi/provider behavior, actual thinking-level attestation, the external relay's cancellation and result guarantees, installed sibling skills, Claude/Codex invocation semantics, real agent completion quality, a full multi-agent factory run, macOS process behavior, and application-level test suites were not verified. There are no benchmark claims about review recall or precision. The two original process tests failed in this Linux environment; the exact failure timing must be checked on macOS rather than assumed identical.

The three baseline runs prescribed by the skill do not establish statistical certainty about flaky tests. The repository contains no end-to-end agent evaluation corpus, so one cannot infer dependable autonomous quality from script unit tests alone. Suggested negative cases and the remediation release gates are in `REMEDIATION.md`.

This audit does not certify absence of additional bugs. It provides a complete tracked-file inspection of this snapshot, reproducible counterexamples for the key executable failures, and explicit untested boundaries.

## Public technical cross-checks

Git's official `git-status` documentation confirms that porcelain v1 paths are always relative to the repository root and explains the scope of tracked, staged and untracked status. This directly supports R03 and R04. Git's `git-worktree` documentation explains common versus per-worktree Git state and the force-removal semantics used in the fixture checks. These are primary technical references; repository-specific claims remain grounded in the pinned source.

- Git status: https://git-scm.com/docs/git-status
- Git worktree: https://git-scm.com/docs/git-worktree

## Files in this audit packet

`AUDIT.md` is the complete critique. `REMEDIATION.md` specifies a staged repair plan, dependencies, tests, observability, migration and rollback. `findings.json` holds the same findings for tooling. `audit_regressions.py` and `adversarial-results.json` provide the selected negative cases and observed results. The original selftest logs preserve both the zero-test skip and the 38/2 run. `source-manifest.json` records immutable source locations and exact executable hashes. `README.md` explains reproduction and interpretation.
