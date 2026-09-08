#!/usr/bin/env node
/**
 * to-orc selftest — exercises every classification orc-dispatch.mjs can emit,
 * against a stub relay, in a throwaway git repository. No API calls, no spend.
 *
 *   node scripts/selftest.mjs
 *
 * Each case asserts the orcStatus in orc-status.json and the process exit code,
 * because those two are the contract the orchestrator depends on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DISPATCH = path.join(here, "orc-dispatch.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "to-orc-selftest-"));
const STUB = path.join(root, "stub.mjs");

let pass = 0;
const failures = [];

const binDir = path.join(root, "bin");
fs.mkdirSync(binDir, { recursive: true });
const piShim = path.join(binDir, "pi");
fs.writeFileSync(piShim, '#!/bin/sh\n[ "$1" = "--version" ] && { echo "0.85.1"; exit 0; }\necho "pi test shim" >&2\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ""}`;

// --- the stub relay: STUB_MODE decides what evidence it leaves behind --------
fs.writeFileSync(STUB, `
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };
const out = arg("--out-dir");
const repo = arg("--cd");
const mode = process.env.STUB_MODE || "ok";
fs.mkdirSync(out, { recursive: true });
const base = {
  schema: "delegate-relay.result.v1", tool: "pi", provider: "zai",
  model: "zai/glm-5.3-flash:max", actualProvider: "zai", actualModel: "glm-5.3-flash",
  status: "completed", exitCode: 0, piVersion: "0.85.1", sessionId: "sess-" + mode,
  usage: { reasoning: 12, cost: { total: 0.01 } }, touchedFiles: [], stopReason: "stop",
  finalMessage: "stub report",
};
const write = (o) => fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(o));
const git = (...a) => spawnSync("git", ["-C", repo, ...a], { stdio: "ignore" });
switch (mode) {
  case "ok": write(base); break;
  case "write-new": fs.writeFileSync(path.join(repo, "new.txt"), "x"); write(base); break;
  case "edit-dirty": fs.writeFileSync(path.join(repo, "dirty.txt"), "MUTATED"); write(base); break;
  case "stage": git("add", "-A"); write(base); break;
  case "commit":
    fs.writeFileSync(path.join(repo, "c.txt"), "c"); git("add", "-A");
    git("-c", "user.email=s@s", "-c", "user.name=s", "commit", "-m", "worker commit");
    write(base); break;
  case "corrupt": fs.writeFileSync(path.join(out, "result.json"), "{ truncated"); break;
  case "schema-drift": write({ ...base, schema: "delegate-relay.result.v2" }); break;
  case "pi-unavailable": write({ ...base, status: "pi_unavailable", exitCode: 127 }); process.exit(127);
  case "timeout": write({ ...base, status: "timeout", exitCode: 1 }); process.exit(1);
  case "aborted": write({ ...base, status: "aborted", exitCode: 1 }); process.exit(1);
  case "wrong-model": write({ ...base, actualModel: "glm-5.3" }); break;
  case "worker-failed": write({ ...base, status: "failed", exitCode: 5 }); process.exit(5);
  case "no-result": process.stderr.write("relay: bad flag\\n"); process.exit(2);
  case "old-pi": write({ ...base, piVersion: "0.99.0" }); break;
  case "error-stop": write({ ...base, stopReason: "error", exitCode: 0 }); process.exit(1);
  case "slow": spawnSync(process.execPath, ["-e", "setTimeout(()=>{},60000)"]); write(base); break;
  default: throw new Error("unknown STUB_MODE " + mode);
}
`);

// --- helpers ----------------------------------------------------------------
function newRepo(name, { git: withGit = true } = {}) {
  const repo = path.join(root, "repos", name);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  if (withGit) {
    const g = (...a) => spawnSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    g("init", "-q");
    g("add", "-A");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    // one pre-existing dirty file, so baseline noise is part of every case
    fs.writeFileSync(path.join(repo, "dirty.txt"), "original");
  }
  return repo;
}

function newRun(name, { accept = [] } = {}) {
  const runDir = path.join(root, "runs", name);
  fs.mkdirSync(path.join(runDir, "accepted"), { recursive: true });
  for (const phase of accept) fs.writeFileSync(path.join(runDir, "accepted", `${phase}.md`), "accepted by selftest\n");
  const brief = path.join(runDir, "brief.txt");
  fs.writeFileSync(brief, "do the thing\n");
  return { runDir, brief };
}

function dispatch({ mode = "ok", phase, task, runDir, brief, repo, extra = [] }) {
  const r = spawnSync(process.execPath, [
    DISPATCH, "--phase", phase, "--task", task, "--brief", brief,
    "--run-dir", runDir, "--repo", repo, ...extra,
  ], {
    encoding: "utf8",
    env: { ...process.env, TO_ORC_RELAY: STUB, STUB_MODE: mode },
  });
  let status = null;
  const f = path.join(runDir, task, "orc-status.json");
  if (fs.existsSync(f)) { try { status = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* leave null */ } }
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr, status };
}

function check(name, fn) {
  try {
    fn();
    pass += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    process.stdout.write(`  FAIL ${name} — ${e.message}\n`);
  }
}

const eq = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
};

// --- cases ------------------------------------------------------------------
process.stdout.write("to-orc selftest\n");

if (spawnSync("pi", ["--version"], { stdio: "ignore" }).status !== 0) {
  process.stdout.write("  SKIP — the pi CLI is not installed; the dispatcher refuses to run without it\n");
  process.exit(0);
}

check("scout on a clean-enough tree is COMPLIANT", () => {
  const repo = newRepo("r1"); const { runDir, brief } = newRun("run1");
  const r = dispatch({ phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 0, "exit"); eq(r.status.orcStatus, "COMPLIANT", "orcStatus");
  eq(r.status.changeSet.verified, true, "changeSet.verified");
});

check("a no-write phase that creates a file is NO_WRITES_VIOLATED", () => {
  const repo = newRepo("r2"); const { runDir, brief } = newRun("run2");
  const r = dispatch({ mode: "write-new", phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 72, "exit"); eq(r.status.orcStatus, "NO_WRITES_VIOLATED", "orcStatus");
});

check("editing an ALREADY-dirty file is caught (content digest, not path set)", () => {
  const repo = newRepo("r3"); const { runDir, brief } = newRun("run3");
  const r = dispatch({ mode: "edit-dirty", phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 72, "exit"); eq(r.status.orcStatus, "NO_WRITES_VIOLATED", "orcStatus");
});

check("staging files is caught", () => {
  const repo = newRepo("r4"); const { runDir, brief } = newRun("run4");
  const r = dispatch({ mode: "stage", phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 72, "exit"); eq(r.status.orcStatus, "NO_WRITES_VIOLATED", "orcStatus");
});

check("a worker commit is caught (HEAD moved)", () => {
  const repo = newRepo("r5"); const { runDir, brief } = newRun("run5");
  const r = dispatch({ mode: "commit", phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 72, "exit"); eq(r.status.orcStatus, "NO_WRITES_VIOLATED", "orcStatus");
  eq(r.status.changeSet.headChanged, true, "headChanged");
});

check("implement records the change set and its diff identifier", () => {
  const repo = newRepo("r6"); const { runDir, brief } = newRun("run6", { accept: ["scout", "research"] });
  const r = dispatch({ mode: "write-new", phase: "implement", task: "P3", runDir, brief, repo });
  eq(r.exit, 0, "exit"); eq(r.status.orcStatus, "COMPLIANT", "orcStatus");
  eq(r.status.changeSet.pathsChanged.length, 1, "pathsChanged");
  if (!r.status.changeSet.worktreeDiffSha) throw new Error("no worktreeDiffSha recorded");
});

check("corrupt result.json is EVIDENCE_UNREADABLE, not a worker failure", () => {
  const repo = newRepo("r7"); const { runDir, brief } = newRun("run7");
  const r = dispatch({ mode: "corrupt", phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 73, "exit"); eq(r.status.orcStatus, "EVIDENCE_UNREADABLE", "orcStatus");
});

check("relay schema drift is SCHEMA_DRIFT, not CONFIG_NON_COMPLIANT", () => {
  const repo = newRepo("r8"); const { runDir, brief } = newRun("run8");
  const r = dispatch({ mode: "schema-drift", phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 74, "exit"); eq(r.status.orcStatus, "SCHEMA_DRIFT", "orcStatus");
});

check("pi_unavailable is RUNTIME_UNAVAILABLE, not a model mismatch", () => {
  const repo = newRepo("r9"); const { runDir, brief } = newRun("run9");
  const r = dispatch({ mode: "pi-unavailable", phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 71, "exit"); eq(r.status.orcStatus, "RUNTIME_UNAVAILABLE", "orcStatus");
});

check("a watchdog timeout is its own status and says the tree may be partial", () => {
  const repo = newRepo("r10"); const { runDir, brief } = newRun("run10", { accept: ["scout", "research"] });
  const r = dispatch({ mode: "timeout", phase: "implement", task: "P3", runDir, brief, repo });
  eq(r.exit, 75, "exit"); eq(r.status.orcStatus, "TIMEOUT", "orcStatus");
  if (!/PARTIAL/.test(r.status.reason)) throw new Error("reason does not warn about a partial change set");
});

check("an aborted relay is ABORTED", () => {
  const repo = newRepo("r11"); const { runDir, brief } = newRun("run11");
  const r = dispatch({ mode: "aborted", phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 76, "exit"); eq(r.status.orcStatus, "ABORTED", "orcStatus");
});

check("a substituted model is CONFIG_NON_COMPLIANT", () => {
  const repo = newRepo("r12"); const { runDir, brief } = newRun("run12");
  const r = dispatch({ mode: "wrong-model", phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 70, "exit"); eq(r.status.orcStatus, "CONFIG_NON_COMPLIANT", "orcStatus");
});

check("a worker exiting 5 is WORKER_FAILED — no collision with the no-writes verdict", () => {
  const repo = newRepo("r13"); const { runDir, brief } = newRun("run13");
  const r = dispatch({ mode: "worker-failed", phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 78, "exit"); eq(r.status.orcStatus, "WORKER_FAILED", "orcStatus");
});

check("a relay that writes no result.json is a to-orc bug, not a dead runtime", () => {
  const repo = newRepo("r14"); const { runDir, brief } = newRun("run14");
  const r = dispatch({ mode: "no-result", phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 77, "exit"); eq(r.status.orcStatus, "PRECONDITION_FAILED", "orcStatus");
});

check("an unverified pi version warns but still completes", () => {
  const repo = newRepo("r15"); const { runDir, brief } = newRun("run15");
  const r = dispatch({ mode: "old-pi", phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 0, "exit");
  if (!r.status.warnings.some((w) => /outside the verified range/.test(w))) throw new Error("no version warning recorded");
});

check("a non-git workspace completes with writes UNVERIFIED", () => {
  const repo = newRepo("r16", { git: false }); const { runDir, brief } = newRun("run16");
  const r = dispatch({ phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 0, "exit"); eq(r.status.changeSet.verified, false, "changeSet.verified");
  if (!r.status.warnings.some((w) => /not a git repository/.test(w))) throw new Error("no unverifiable-writes warning");
});

check("a traversing --task is refused", () => {
  const repo = newRepo("r17"); const { runDir, brief } = newRun("run17");
  const r = dispatch({ phase: "scout", task: "../escaped", runDir, brief, repo });
  eq(r.exit, 77, "exit");
  if (fs.existsSync(path.join(root, "runs", "escaped"))) throw new Error("artifacts escaped the run directory");
});

check("a phase may not start before its predecessor is accepted", () => {
  const repo = newRepo("r18"); const { runDir, brief } = newRun("run18");
  const r = dispatch({ phase: "research", task: "P2", runDir, brief, repo });
  eq(r.exit, 77, "exit"); eq(r.status.orcStatus, "PRECONDITION_FAILED", "orcStatus");
  if (!/accepted/.test(r.status.reason)) throw new Error("reason does not name the acceptance file");
});

check("--session is refused outside repair, and required by it", () => {
  const repo = newRepo("r19"); const { runDir, brief } = newRun("run19", { accept: ["scout", "research", "implement", "verify"] });
  eq(dispatch({ phase: "scout", task: "P1", runDir, brief, repo, extra: ["--session", "abc"] }).exit, 77, "scout+session exit");
  eq(dispatch({ phase: "repair", task: "P3r", runDir, brief, repo }).exit, 77, "repair without session exit");
});

check("a run directory inside the workspace is refused", () => {
  const repo = newRepo("r20");
  const runDir = path.join(repo, "run"); fs.mkdirSync(path.join(runDir, "accepted"), { recursive: true });
  const brief = path.join(root, "b.txt"); fs.writeFileSync(brief, "x\n");
  const r = dispatch({ phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 77, "exit");
});

check("re-using a task id needs --force", () => {
  const repo = newRepo("r21"); const { runDir, brief } = newRun("run21");
  eq(dispatch({ phase: "scout", task: "P1", runDir, brief, repo }).exit, 0, "first exit");
  eq(dispatch({ phase: "scout", task: "P1", runDir, brief, repo }).exit, 77, "second exit");
  eq(dispatch({ phase: "scout", task: "P1", runDir, brief, repo, extra: ["--force"] }).exit, 0, "forced exit");
});

check("the cycle cap stops a second repair", () => {
  const repo = newRepo("r22");
  const { runDir, brief } = newRun("run22", { accept: ["scout", "research", "implement", "verify"] });
  dispatch({ phase: "implement", task: "P3", runDir, brief, repo });
  eq(dispatch({ phase: "repair", task: "R1", runDir, brief, repo, extra: ["--session", "sess-ok"] }).exit, 0, "first repair");
  const r = dispatch({ phase: "repair", task: "R2", runDir, brief, repo, extra: ["--session", "sess-ok"] });
  eq(r.exit, 77, "second repair exit");
  if (!/cycle limit/.test(r.status.reason)) throw new Error("reason does not name the cycle limit");
});

check("repair refuses to resume a timed-out session", () => {
  const repo = newRepo("r23");
  const { runDir, brief } = newRun("run23", { accept: ["scout", "research", "implement", "verify"] });
  dispatch({ mode: "timeout", phase: "implement", task: "P3", runDir, brief, repo });
  const r = dispatch({ phase: "repair", task: "R1", runDir, brief, repo, extra: ["--session", "sess-timeout"] });
  eq(r.exit, 77, "exit");
  if (!/undefined/.test(r.status.reason)) throw new Error("reason does not explain the undefined session state");
});

check("the budget stops a dispatch once the run has spent its cap", () => {
  const repo = newRepo("r24"); const { runDir, brief } = newRun("run24");
  eq(dispatch({ phase: "scout", task: "P1", runDir, brief, repo }).exit, 0, "first exit");
  const r = dispatch({ phase: "scout", task: "P1b", runDir, brief, repo, extra: ["--max-cost", "0.005"] });
  eq(r.exit, 77, "capped exit");
  if (!/budget/.test(r.status.reason)) throw new Error("reason does not name the budget");
});

check("spend is accumulated across dispatches", () => {
  const repo = newRepo("r25"); const { runDir, brief } = newRun("run25");
  dispatch({ phase: "scout", task: "P1", runDir, brief, repo });
  dispatch({ phase: "scout", task: "P1b", runDir, brief, repo });
  const ledger = JSON.parse(fs.readFileSync(path.join(runDir, "spend.json"), "utf8"));
  eq(ledger.entries.length, 2, "entries");
  eq(Number(ledger.totalUsd.toFixed(2)), 0.02, "totalUsd");
});

check("--dry-run validates without dispatching", () => {
  const repo = newRepo("r26"); const { runDir, brief } = newRun("run26");
  const r = dispatch({ phase: "scout", task: "P1", runDir, brief, repo, extra: ["--dry-run"] });
  eq(r.exit, 0, "exit");
  if (fs.existsSync(path.join(runDir, "P1", "result.json"))) throw new Error("dry run dispatched a worker");
});

check("an empty brief is refused before any spend", () => {
  const repo = newRepo("r27"); const { runDir } = newRun("run27");
  const brief = path.join(runDir, "empty.txt"); fs.writeFileSync(brief, "   \n");
  eq(dispatch({ phase: "scout", task: "P1", runDir, brief, repo }).exit, 77, "exit");
});

check("a malformed --timeout is refused before any spend", () => {
  const repo = newRepo("r28"); const { runDir, brief } = newRun("run28");
  eq(dispatch({ phase: "scout", task: "P1", runDir, brief, repo, extra: ["--timeout", "2hours"] }).exit, 77, "exit");
});

check("a worker error with a zero pi exit is WORKER_FAILED and keeps stopReason", () => {
  const repo = newRepo("r29"); const { runDir, brief } = newRun("run29");
  const r = dispatch({ mode: "error-stop", phase: "scout", task: "P1", runDir, brief, repo });
  eq(r.exit, 78, "exit"); eq(r.status.orcStatus, "WORKER_FAILED", "orcStatus");
  eq(r.status.relay.stopReason, "error", "stopReason");
});

check("a dispatch in flight publishes orcStatus RUNNING, and --poll says so", () => {
  const repo = newRepo("r30"); const { runDir, brief } = newRun("run30");
  const r = dispatch({ mode: "slow", phase: "scout", task: "P1", runDir, brief, repo, extra: ["--background"] });
  eq(r.exit, 0, "background exit");
  const st = JSON.parse(fs.readFileSync(path.join(runDir, "P1", "orc-status.json"), "utf8"));
  eq(st.orcStatus, "RUNNING", "orcStatus while in flight");
  const poll = spawnSync(process.execPath, [DISPATCH, "--poll", "--task", "P1", "--run-dir", runDir], { encoding: "utf8" });
  eq(poll.status, 79, "poll exit while running");
  // now kill it and confirm the poller can tell "died" from "still working"
  process.kill(st.pid, "SIGKILL");
  const after = spawnSync(process.execPath, [DISPATCH, "--poll", "--task", "P1", "--run-dir", runDir], { encoding: "utf8" });
  eq(after.status, 76, "poll exit after the process died");
  const final = JSON.parse(fs.readFileSync(path.join(runDir, "P1", "orc-status.json"), "utf8"));
  eq(final.orcStatus, "ABORTED", "orcStatus after death");
  if (!/PARTIAL/.test(final.reason)) throw new Error("reason does not warn about a partial change set");
});

check("a worker orphaned by a dead supervisor still reads as RUNNING", () => {
  const repo = newRepo("r33"); const { runDir, brief } = newRun("run33");
  dispatch({ mode: "slow", phase: "scout", task: "P1", runDir, brief, repo, extra: ["--background"] });
  // wait for the supervisor to publish the worker pid
  const f = path.join(runDir, "P1", "orc-status.json");
  let st = JSON.parse(fs.readFileSync(f, "utf8"));
  for (let i = 0; i < 200 && !st.relayPid; i += 1) {
    spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)"]);
    st = JSON.parse(fs.readFileSync(f, "utf8"));
  }
  if (!st.relayPid) throw new Error("supervisor never published the worker pid");
  process.kill(st.pid, "SIGKILL"); // kill the supervisor only
  const poll = spawnSync(process.execPath, [DISPATCH, "--poll", "--task", "P1", "--run-dir", runDir], { encoding: "utf8" });
  eq(poll.status, 79, "poll exit with an orphaned worker");
  if (!/still being modified/.test(poll.stderr)) throw new Error("poll did not warn that the workspace is still moving");
  try { process.kill(st.relayPid, "SIGKILL"); } catch { /* already gone */ }
});

check("--poll on a finished dispatch replays its verdict", () => {
  const repo = newRepo("r31"); const { runDir, brief } = newRun("run31");
  dispatch({ mode: "wrong-model", phase: "scout", task: "P1", runDir, brief, repo });
  const poll = spawnSync(process.execPath, [DISPATCH, "--poll", "--task", "P1", "--run-dir", runDir], { encoding: "utf8" });
  eq(poll.status, 70, "poll exit");
});

check("--poll on an unknown task is refused", () => {
  const { runDir } = newRun("run32");
  eq(spawnSync(process.execPath, [DISPATCH, "--poll", "--task", "nope", "--run-dir", runDir]).status, 77, "exit");
});

// --- verdict validator ------------------------------------------------------
const VALIDATOR = path.join(here, "validate-verdict.mjs");
const verdict = (o) => {
  const f = path.join(root, `verdict-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, typeof o === "string" ? o : JSON.stringify(o, null, 2));
  return spawnSync(process.execPath, [VALIDATOR, f], { encoding: "utf8" });
};
const validRevise = {
  orchestration_summary: { task_id: "t", dispatched_to: "pi / zai:glm-5.3-flash", flags: "--thinking max", status: "REVISE" },
  phase_audit: { scouting_completed: true, researching_completed: true, implementing_completed: true, verification_completed: true },
  plan_compliance: { all_steps_completed: false, deviations: ["one"] },
  implementation_review: { correctness_score: 6, issues_detected: [], findings: "why" },
  next_action: "REQUEST_CHANGES",
};

check("validator accepts a well-formed REVISE verdict", () => eq(verdict(validRevise).status, 0, "exit"));
check("validator rejects Markdown fences", () => eq(verdict("```json\\n" + JSON.stringify(validRevise) + "\\n```").status, 1, "exit"));
check("validator rejects prose around the JSON", () => eq(verdict("Here is my verdict:\\n" + JSON.stringify(validRevise)).status, 1, "exit"));
check("validator rejects stringified booleans", () => {
  const v = structuredClone(validRevise); v.phase_audit.scouting_completed = "true";
  eq(verdict(v).status, 1, "exit");
});
check("validator rejects APPROVE without PASS", () => {
  const v = structuredClone(validRevise); v.next_action = "APPROVE";
  eq(verdict(v).status, 1, "exit");
});
check("validator rejects PASS with an OPEN issue", () => {
  const v = structuredClone(validRevise);
  v.orchestration_summary.status = "PASS"; v.next_action = "APPROVE";
  v.plan_compliance.all_steps_completed = true;
  v.implementation_review.issues_detected = [{ id: "I1", severity: "LOW", status: "OPEN", description: "d", location: null, evidence: ["e"], required_action: "fix" }];
  eq(verdict(v).status, 1, "exit");
});
check("validator rejects an all-false phase audit that is not FAIL", () => {
  const v = structuredClone(validRevise);
  v.phase_audit = { scouting_completed: false, researching_completed: false, implementing_completed: false, verification_completed: false };
  eq(verdict(v).status, 1, "exit");
});

// --- report -----------------------------------------------------------------
process.stdout.write(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
