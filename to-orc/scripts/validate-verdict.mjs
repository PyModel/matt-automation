#!/usr/bin/env node
/**
 * Validate the final to-orc assessment against the response contract before it
 * is sent. The commonest real failure of this skill is a fenced or prose-wrapped
 * JSON object; this catches that and every structural slip with it.
 *
 *   node validate-verdict.mjs <file>       # file holding the exact final message
 *   ... | node validate-verdict.mjs        # or on stdin
 *
 * Exit 0 = the text is a valid final message. Exit 1 = it is not; every problem
 * is printed, one per line. Nothing is rewritten — fixing it is the author's job.
 */
import fs from "node:fs";

const STATUSES = ["PASS", "REVISE", "FAIL"];
const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
const ISSUE_STATUSES = ["OPEN", "RESOLVED"];
const PHASE_FLAGS = ["scouting_completed", "researching_completed", "implementing_completed", "verification_completed"];

const problems = [];
const bad = (m) => problems.push(m);
const isStr = (v) => typeof v === "string" && v.trim() !== "";

const raw = process.argv[2]
  ? fs.readFileSync(process.argv[2], "utf8")
  : fs.readFileSync(0, "utf8");

const trimmed = raw.trim();
if (trimmed.startsWith("```") || trimmed.endsWith("```")) bad("contains a Markdown fence — the final message must be raw JSON with no fences");
if (trimmed === "") bad("empty input");

let v;
try {
  v = JSON.parse(raw);
} catch (e) {
  bad(`not parseable as a single JSON object (${e.message}) — no prose may precede or follow it`);
  report();
}
if (v === null || typeof v !== "object" || Array.isArray(v)) {
  bad("top level must be a JSON object");
  report();
}

const os = v.orchestration_summary;
if (!os || typeof os !== "object") bad("orchestration_summary missing");
else {
  if (!isStr(os.task_id)) bad("orchestration_summary.task_id must be a non-empty string");
  if (os.dispatched_to !== "pi / zai:glm-5.3-flash") bad(`orchestration_summary.dispatched_to must be "pi / zai:glm-5.3-flash"`);
  if (os.flags !== "--thinking max") bad(`orchestration_summary.flags must be "--thinking max"`);
  if (!STATUSES.includes(os.status)) bad(`orchestration_summary.status must be one of ${STATUSES.join(", ")}`);
}

const pa = v.phase_audit;
if (!pa || typeof pa !== "object") bad("phase_audit missing");
else for (const f of PHASE_FLAGS) {
  if (typeof pa[f] !== "boolean") bad(`phase_audit.${f} must be a real boolean, not a string`);
}

const pc = v.plan_compliance;
if (!pc || typeof pc !== "object") bad("plan_compliance missing");
else {
  if (typeof pc.all_steps_completed !== "boolean") bad("plan_compliance.all_steps_completed must be a real boolean");
  if (!Array.isArray(pc.deviations)) bad("plan_compliance.deviations must be an array");
  else pc.deviations.forEach((d, i) => { if (typeof d !== "string") bad(`plan_compliance.deviations[${i}] must be a string`); });
}

const ir = v.implementation_review;
if (!ir || typeof ir !== "object") bad("implementation_review missing");
else {
  const s = ir.correctness_score;
  if (!(s === null || (Number.isInteger(s) && s >= 0 && s <= 10))) bad("implementation_review.correctness_score must be an integer 0-10 or null");
  if (!isStr(ir.findings)) bad("implementation_review.findings must be a non-empty string");
  if (!Array.isArray(ir.issues_detected)) bad("implementation_review.issues_detected must be an array");
  else ir.issues_detected.forEach((it, i) => {
    const at = `issues_detected[${i}]`;
    if (!it || typeof it !== "object") return bad(`${at} must be an object`);
    if (!isStr(it.id)) bad(`${at}.id must be a non-empty string`);
    if (!SEVERITIES.includes(it.severity)) bad(`${at}.severity must be one of ${SEVERITIES.join(", ")}`);
    if (!ISSUE_STATUSES.includes(it.status)) bad(`${at}.status must be OPEN or RESOLVED`);
    if (!isStr(it.description)) bad(`${at}.description must be a non-empty string`);
    if (!(it.location === null || isStr(it.location))) bad(`${at}.location must be a string or null`);
    if (!Array.isArray(it.evidence) || it.evidence.some((e) => typeof e !== "string")) bad(`${at}.evidence must be an array of strings`);
    if (!(it.required_action === null || isStr(it.required_action))) bad(`${at}.required_action must be a string or null`);
    if (it.status === "OPEN" && it.required_action === null) bad(`${at} is OPEN but names no required_action`);
  });
}

if (!["APPROVE", "REQUEST_CHANGES"].includes(v.next_action)) bad("next_action must be APPROVE or REQUEST_CHANGES");

// Cross-field rules the contract turns on.
const status = os?.status;
if (status === "PASS" && v.next_action !== "APPROVE") bad("status PASS requires next_action APPROVE");
if (status !== "PASS" && v.next_action === "APPROVE") bad("next_action APPROVE is only valid for status PASS");
if (status === "PASS" && pa && !PHASE_FLAGS.every((f) => pa[f] === true)) bad("status PASS requires every phase_audit flag to be true");
if (status === "PASS" && pc && pc.all_steps_completed !== true) bad("status PASS requires plan_compliance.all_steps_completed to be true");
if (status === "PASS" && ir && Array.isArray(ir.issues_detected) && ir.issues_detected.some((i) => i?.status === "OPEN")) {
  bad("status PASS cannot carry an OPEN issue");
}
if (status === "PASS" && ir && ir.correctness_score === null) bad("status PASS requires a correctness_score, not null");
if (pa && PHASE_FLAGS.every((f) => pa[f] === false)) {
  if (status !== "FAIL") bad("no phase completed, so status must be FAIL");
  if (ir && ir.correctness_score !== null) bad("no phase completed, so correctness_score must be null");
}

report();

function report() {
  if (problems.length === 0) {
    process.stdout.write("validate-verdict: OK — valid final message\n");
    process.exit(0);
  }
  process.stderr.write(`validate-verdict: ${problems.length} problem(s)\n`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}
