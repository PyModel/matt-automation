#!/usr/bin/env node
/**
 * to-orc dispatch — the only command the orchestrator runs.
 *
 * One verb, one required policy input: --phase. The phase decides the write
 * policy, the default timeout, the session policy, the ordering precondition
 * and the cycle accounting, so an invalid flag combination cannot be assembled.
 *
 * Every dispatch writes <run-dir>/<task>/orc-status.json. That file — not the
 * exit code, not the worker's prose — is what the orchestrator reads.
 *
 * Writes are detected by fingerprinting the workspace before and after the run
 * (HEAD + per-path content digests + index/worktree diff digests), so content
 * edits to already-dirty files, staging, renames and worker commits are all
 * caught, and the change set carries a dispatcher-produced diff identifier.
 *
 * A no-write phase runs against a pinned snapshot of the workspace. If it writes
 * anyway, its writes are pinned too and the workspace is put back, verified by
 * the fingerprint, so a read-only phase never leaves the user's tree changed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCHEMA = "delegate-relay.result.v1";
const KNOWN_PI = ["0.85."]; // prefix match; only versions whose thinking suffixes were re-probed (SKILL.md § Maintaining)
// pi --help: "Set thinking level: off, minimal, low, medium, high, xhigh, max"
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const STATUS_SCHEMA = "to-orc.status.v1";

/** Split a pi model pattern `provider/id:thinking` into proven pieces. */
function parseWorkerSpec(providerFlag, modelFlag) {
  const model = String(modelFlag || "").trim();
  if (!model) usageError("--model needs a pi model pattern: <provider>/<model id>[:<thinking>]");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/.test(model)) {
    usageError("--model may only contain letters, digits, and . _ : / -");
  }
  // Only a known thinking level is a suffix; any other tag (ollama/qwen3:32b) is part of the model id.
  const colon = model.lastIndexOf(":");
  const suffix = colon > 0 ? model.slice(colon + 1) : "";
  const thinking = THINKING_LEVELS.has(suffix) ? suffix : null;
  const bare = thinking ? model.slice(0, colon) : model;
  const slash = bare.indexOf("/");
  const fromModelProvider = slash === -1 ? null : bare.slice(0, slash);
  const requestedModelId = slash === -1 ? bare : bare.slice(slash + 1);
  if (!requestedModelId) usageError("--model must include a model id");
  if (providerFlag && fromModelProvider && providerFlag !== fromModelProvider) {
    usageError(`--provider ${providerFlag} contradicts the --model prefix ${fromModelProvider}/; pass one provider`);
  }
  const provider = String(providerFlag || fromModelProvider || "").trim();
  if (!provider) usageError("--model has no <provider>/ prefix; add one or pass --provider");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider)) {
    usageError("--provider may only contain letters, digits, and . _ -");
  }
  return {
    runtime: "pi",
    provider,
    model,
    requestedModelId,
    thinking: thinking || "default",
  };
}

/** orcStatus → exit code. 70+ so it can never collide with pi's or the relay's own codes. */
const EXIT = {
  COMPLIANT: 0,
  CONFIG_NON_COMPLIANT: 70,
  RUNTIME_UNAVAILABLE: 71,
  NO_WRITES_VIOLATED: 72,
  EVIDENCE_UNREADABLE: 73,
  SCHEMA_DRIFT: 74,
  TIMEOUT: 75,
  ABORTED: 76,
  PRECONDITION_FAILED: 77,
  WORKER_FAILED: 78,
  RUNNING: 79,
};

/**
 * The single source of truth the docs used to duplicate as a flag table.
 *   writes:  "none"    → the workspace must be byte-identical afterwards
 *            "allowed" → changes are the deliverable; recorded, never gated
 *   after:   which phase must be accepted before this one may run
 *   session: "fresh" rejects --session; "resume" requires it
 */
const PHASES = {
  scout:     { writes: "none",    after: null,        timeout: "45m", session: "fresh"  },
  research:  { writes: "none",    after: "scout",     timeout: "45m", session: "fresh"  },
  implement: { writes: "allowed", after: "research",  timeout: "2h",  session: "fresh"  },
  verify:    { writes: "none",    after: "implement", timeout: "1h",  session: "fresh"  },
  repair:    { writes: "allowed", after: "verify",    timeout: "2h",  session: "resume" },
};

const USAGE = `to-orc dispatch — run one delegated phase and classify its evidence.

Usage:
  orc-dispatch.mjs --phase <name> --task <id> --brief <file> --run-dir <dir> [options]

Required:
  --phase <name>     scout | research | implement | verify | repair
  --task <id>        artifact directory name; [A-Za-z0-9][A-Za-z0-9._-]{0,63}
  --brief <file>     the brief piped to the worker (must be non-empty)
  --run-dir <dir>    run directory; artifacts land in <run-dir>/<task>/

Options:
  --repo <path>      worker workspace (default: current directory)
  --model <pattern>  pi model pattern <provider>/<model id>[:<thinking>]
                     (off|minimal|low|medium|high|xhigh|max; any other tag
                     stays in the model id). Omit it on the run's first
                     dispatch to use pi's configured default. Either way
                     run.json fixes the model that ran; later dispatches
                     may omit --model and must not change it.
  --provider <name>  only when --model has no <provider>/ prefix
  --session <id>     pi session to resume; required by repair, rejected elsewhere
  --timeout <dur>    watchdog override, e.g. 90m / 2h / 1h30m (default: per phase)
  --cycles <n>       compliant implement→verify cycles allowed (default 2;
                     fixed for the run, like --max-cost and --model)
  --max-cost <usd>   refuse to start when the run has already spent this much
  --background       detach and return immediately; poll orc-status.json
  --poll             report on an existing dispatch: needs only --task and
                     --run-dir; reclassifies a dispatch whose process died as
                     ABORTED, exits 79 while it is still running
  --force            overwrite an existing dispatch under the same --task
  --dry-run          validate everything and print the plan; dispatch nothing
  -h, --help         this text

Phase policy (writes / must follow / default timeout / session):
  scout      none    / —         / 45m / fresh
  research   none    / scout     / 45m / fresh
  implement  allowed / research  / 2h  / fresh
  verify     none    / implement / 1h  / fresh
  repair     allowed / verify    / 2h  / resume

Ordering gate: a phase with a predecessor runs only when
<run-dir>/accepted/<predecessor>.md exists and is non-empty. The orchestrator
writes that file when it accepts the phase, and only then.

Evidence: <run-dir>/<task>/orc-status.json — always present once a dispatch
starts, carrying orcStatus RUNNING until the run lands on one of
  COMPLIANT · WORKER_FAILED · TIMEOUT · ABORTED · NO_WRITES_VIOLATED ·
  CONFIG_NON_COMPLIANT · RUNTIME_UNAVAILABLE · SCHEMA_DRIFT ·
  EVIDENCE_UNREADABLE · PRECONDITION_FAILED
Exit codes mirror it: 0 COMPLIANT, 70 CONFIG_NON_COMPLIANT, 71 RUNTIME_UNAVAILABLE,
72 NO_WRITES_VIOLATED, 73 EVIDENCE_UNREADABLE, 74 SCHEMA_DRIFT, 75 TIMEOUT,
76 ABORTED, 77 PRECONDITION_FAILED, 78 WORKER_FAILED, 79 RUNNING (--poll only).

Env: TO_ORC_RELAY overrides the pi-delegate relay path (used by the selftest).`;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const o = {
    phase: "", task: "", brief: "", runDir: "", repo: process.cwd(),
    provider: "", model: "",
    session: "", timeout: "", cycles: null, maxCost: undefined, // unset = inherit from run.json
    background: false, force: false, dryRun: false, poll: false, childOfBackground: false,
  };
  const need = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) usageError(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--phase":      o.phase = need(i, a); i += 1; break;
      case "--task":       o.task = need(i, a); i += 1; break;
      case "--brief":      o.brief = need(i, a); i += 1; break;
      case "--run-dir":    o.runDir = need(i, a); i += 1; break;
      case "--repo":       o.repo = need(i, a); i += 1; break;
      case "--provider":   o.provider = need(i, a); i += 1; break;
      case "--model":      o.model = need(i, a); i += 1; break;
      case "--session":    o.session = need(i, a); i += 1; break;
      case "--timeout":    o.timeout = need(i, a); i += 1; break;
      case "--cycles":     o.cycles = Number(need(i, a)); i += 1; break;
      case "--max-cost":   o.maxCost = Number(need(i, a)); i += 1; break;
      case "--background": o.background = true; break;
      case "--poll":       o.poll = true; break;
      case "--child-of-background": o.childOfBackground = true; break; // internal
      case "--force":      o.force = true; break;
      case "--dry-run":    o.dryRun = true; break;
      case "-h": case "--help": process.stdout.write(`${USAGE}\n`); process.exit(0);
      default: usageError(`unknown option: ${a}`);
    }
  }
  return o;
}

function usageError(msg) {
  process.stderr.write(`orc-dispatch: ${msg}\n\n${USAGE}\n`);
  process.exit(EXIT.PRECONDITION_FAILED);
}

let finalWritten = false;
let relayChild = null;
const say = (m) => process.stdout.write(`orc-dispatch: ${m}\n`);
const warn = (m) => process.stderr.write(`orc-dispatch: WARNING — ${m}\n`);

// ------------------------------------------------------------------- status

function buildStatus(ctx, orcStatus, reason, extra) {
  const w = ctx.worker || {};
  return {
    schema: STATUS_SCHEMA,
    orcStatus,
    reason,
    phase: ctx.phase || null,
    task: ctx.task || null,
    dispatchedAt: ctx.startedAt || null,
    finishedAt: new Date().toISOString(),
    config: {
      runtime: w.runtime || "pi",
      provider: w.provider || null,
      model: w.model || null,
      requestedModelId: w.requestedModelId || null,
      thinking: w.thinking || null,
    },
    relayPath: ctx.relay || null,
    workspace: ctx.repo || null,
    pid: process.pid,
    warnings: ctx.warnings || [],
    ...extra,
  };
}

function writeStatus(out, status) {
  fs.mkdirSync(out, { recursive: true });
  const target = path.join(out, "orc-status.json");
  const tmp = path.join(out, `.orc-status.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** Writes the one file the orchestrator reads, then exits with the matching code. */
function finish(ctx, orcStatus, reason, extra = {}) {
  const status = buildStatus(ctx, orcStatus, reason, extra);
  finalWritten = true;
  if (ctx.out) {
    try {
      writeStatus(ctx.out, status);
    } catch (e) {
      process.stderr.write(`orc-dispatch: could not write orc-status.json — ${e.message}\n`);
    }
  }
  const line = [
    `orcStatus=${orcStatus}`, `phase=${ctx.phase || "-"}`, `task=${ctx.task || "-"}`,
    extra.relay ? `relayStatus=${extra.relay.status} exit=${extra.relay.exitCode}` : null,
    extra.changeSet ? `writes=${extra.changeSet.pathsChanged.length}` : null,
    extra.cost ? `cost=$${extra.cost.dispatchUsd.toFixed(4)} run=$${extra.cost.runTotalUsd.toFixed(4)}` : null,
  ].filter(Boolean).join(" · ");
  (orcStatus === "COMPLIANT" ? say : (m) => process.stderr.write(`orc-dispatch: ${m}\n`))(`${line} — ${reason}`);
  if (ctx.out) say(`evidence · ${path.join(ctx.out, "orc-status.json")}`);
  process.exit(EXIT[orcStatus]);
}

// -------------------------------------------------------------- fingerprint

function git(repo, args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "buffer", maxBuffer });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function hashFileSync(abs) {
  const hash = crypto.createHash("sha256");
  let fd;
  try {
    fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(64 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } catch {
    return "absent";
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/**
 * A workspace fingerprint: HEAD, the digests of the index and worktree diffs,
 * and a content digest per dirty path (tracked-modified and untracked alike).
 * Returns null when the workspace is not a git repository — the caller then
 * records writes as UNVERIFIED rather than pretending the tree was clean.
 */
function fingerprint(repo) {
  const inside = git(repo, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside || inside.toString().trim() !== "true") return null;

  const rootBuf = git(repo, ["rev-parse", "--show-toplevel"]);
  const worktreeRoot = rootBuf ? rootBuf.toString().trim() : repo;

  const headBuf = git(repo, ["rev-parse", "HEAD"]);
  const head = headBuf ? headBuf.toString().trim() : "unborn";
  const porcelain = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (porcelain === null) return null;

  const entries = {};
  // -z records are NUL-separated; a rename record is followed by its origin path.
  const records = porcelain.toString("utf8").split("\0").filter(Boolean);
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    const code = rec.slice(0, 2);
    const p = rec.slice(3);
    if (code[0] === "R" || code[0] === "C") i += 1; // consume the origin path record
    if (!p) continue;
    const abs = path.join(worktreeRoot, p);
    let digest = "absent";
    try {
      const lst = fs.lstatSync(abs);
      if (lst.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(abs);
        digest = `symlink:${sha(Buffer.from(linkTarget))}`;
      } else if (lst.isDirectory()) {
        digest = "dir";
      } else {
        digest = hashFileSync(abs);
      }
    } catch { /* deleted paths keep "absent" */ }
    entries[p] = `${code}:${digest}`;
  }
  const idx = git(repo, ["diff", "--cached"]);
  const wt = git(repo, ["diff"]);

  const combined = crypto.createHash("sha256");
  if (wt) combined.update(wt);
  if (idx) combined.update(idx);
  for (const [k, v] of Object.entries(entries).sort()) {
    combined.update(`${k}:${v}`);
  }
  const worktreeDiffSha = combined.digest("hex");
  const snapshotId = sha(Buffer.from(`${head}:${worktreeDiffSha}`));

  return {
    head,
    snapshotId,
    indexDiffSha: idx ? sha(idx) : null,
    worktreeDiffSha,
    rawWorktreeDiffSha: wt ? sha(wt) : null,
    entries,
    pathCount: Object.keys(entries).length,
  };
}

/** What changed between two fingerprints, in orchestrator-readable terms. */
function diffFingerprints(before, after) {
  if (!before || !after) {
    return { verified: false, headChanged: null, pathsChanged: [], detail: [] };
  }
  const detail = [];
  const paths = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  for (const p of [...paths].sort()) {
    const b = before.entries[p];
    const a = after.entries[p];
    if (b === a) continue;
    detail.push(b === undefined ? `added   ${p}` : a === undefined ? `cleaned ${p}` : `changed ${p}`);
  }
  const headChanged = before.head !== after.head;
  if (headChanged) detail.unshift(`HEAD ${before.head} -> ${after.head}`);
  if (before.indexDiffSha !== after.indexDiffSha) detail.unshift("index diff changed (files staged or unstaged)");
  if (before.worktreeDiffSha !== after.worktreeDiffSha && !detail.some((d) => d.includes("diff changed") || d.startsWith("added ") || d.startsWith("changed ") || d.startsWith("cleaned "))) {
    detail.unshift("worktree diff changed");
  }
  return {
    verified: true,
    headChanged,
    pathsChanged: detail.filter((d) => !d.startsWith("HEAD ") && !d.startsWith("index diff") && !d.startsWith("worktree diff")),
    detail,
  };
}

// ----------------------------------------------------------------- restore

const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: "to-orc", GIT_AUTHOR_EMAIL: "to-orc@localhost",
  GIT_COMMITTER_NAME: "to-orc", GIT_COMMITTER_EMAIL: "to-orc@localhost",
  GIT_LITERAL_PATHSPECS: "1",
};

function gitRun(repo, args, { env = {}, input } = {}) {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...SNAPSHOT_ENV, ...env },
  });
  if (r.error || r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout.trim();
}

/** A commit of every non-ignored file as it is on disk right now, pinned under `ref`. */
function snapshotTree(repo, ref) {
  const tmpIndex = path.join(os.tmpdir(), `to-orc-index-${process.pid}-${crypto.randomUUID()}`);
  try {
    const env = { GIT_INDEX_FILE: tmpIndex };
    const head = headState(repo).sha;
    gitRun(repo, head ? ["read-tree", head] : ["read-tree", "--empty"], { env });
    gitRun(repo, ["add", "-A"], { env });
    const tree = gitRun(repo, ["write-tree"], { env });
    const commit = gitRun(repo, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `to-orc snapshot ${ref}`]);
    gitRun(repo, ["update-ref", ref, commit]);
    return commit;
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

function headState(repo) {
  const r = spawnSync("git", ["-C", repo, "symbolic-ref", "-q", "HEAD"], { encoding: "utf8" });
  const symbolic = r.status === 0 ? r.stdout.trim() : null;
  const s = spawnSync("git", ["-C", repo, "rev-parse", "-q", "--verify", "HEAD^{commit}"], { encoding: "utf8" });
  return { symbolic, sha: s.status === 0 ? s.stdout.trim() : null };
}

/** Everything needed to put a workspace back: the file tree, the index file, and HEAD. */
function pinWorkspace(repo, refBase, out) {
  const indexFile = gitRun(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const indexCopy = path.join(out, "index.before");
  fs.mkdirSync(out, { recursive: true });
  const hadIndex = fs.existsSync(indexFile);
  if (hadIndex) fs.copyFileSync(indexFile, indexCopy);
  return { refBase, head: headState(repo), indexFile, indexCopy: hadIndex ? indexCopy : null, tree: snapshotTree(repo, `${refBase}/before`) };
}

/** Pins the worker's writes under <refBase>/after, then puts HEAD, the tree and the index back. */
function restoreWorkspace(repo, pin, before) {
  const out = { before: `${pin.refBase}/before`, after: `${pin.refBase}/after`, verified: false, error: null };
  try {
    // Paths below are toplevel-relative, so every command runs at the toplevel, whatever --repo is.
    const root = gitRun(repo, ["rev-parse", "--show-toplevel"]);
    const after = snapshotTree(root, out.after);
    // HEAD first: the branch the worker committed to (or switched to) goes back where it was.
    if (pin.head.symbolic) {
      gitRun(root, ["symbolic-ref", "HEAD", pin.head.symbolic]);
      if (pin.head.sha) gitRun(root, ["update-ref", pin.head.symbolic, pin.head.sha]);
      else gitRun(root, ["update-ref", "-d", pin.head.symbolic]);
    } else if (pin.head.sha) {
      gitRun(root, ["update-ref", "--no-deref", "HEAD", pin.head.sha]);
    }
    const changed = gitRun(root, ["diff", "--name-only", "--no-renames", "-z", pin.tree, after]).split("\0").filter(Boolean);
    const inBefore = new Set(changed.length
      ? gitRun(root, ["ls-tree", "-r", "-z", "--name-only", pin.tree, "--", ...changed]).split("\0").filter(Boolean)
      : []);
    const back = changed.filter((p) => inBefore.has(p));
    if (back.length) gitRun(root, ["restore", `--source=${pin.tree}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul", "--"], { input: `${back.join("\0")}\0` });
    for (const p of changed.filter((p) => !inBefore.has(p))) {
      fs.rmSync(path.join(root, p), { force: true });
      for (let dir = path.dirname(path.join(root, p)); dir.startsWith(`${root}${path.sep}`); dir = path.dirname(dir)) {
        try { fs.rmdirSync(dir); } catch { break; }
      }
    }
    // The index last, byte for byte, so staged state and flags come back exactly.
    if (pin.indexCopy) fs.copyFileSync(pin.indexCopy, pin.indexFile);
    else fs.rmSync(pin.indexFile, { force: true });
    spawnSync("git", ["-C", root, "update-index", "-q", "--refresh"], { stdio: "ignore" });
    const now = fingerprint(repo);
    out.verified = Boolean(now && now.snapshotId === before.snapshotId);
    if (!out.verified) out.error = "the restored workspace does not match the pre-dispatch fingerprint";
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// ------------------------------------------------------------------ spend

function recordSpend(runDir, entry) {
  const file = path.join(runDir, "spend.json");
  let ledger = { schema: "to-orc.spend.v1", totalUsd: 0, entries: [] };
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
        ledger = parsed;
      } else {
        warn(`spend ledger invalid shape, resetting: ${file}`);
      }
    }
  } catch { warn(`spend ledger unreadable, starting a new one: ${file}`); }
  if (!Array.isArray(ledger.entries)) ledger.entries = [];
  ledger.entries.push(entry);
  ledger.totalUsd = Number(ledger.entries.reduce((s, e) => s + (typeof e.costUsd === "number" && Number.isFinite(e.costUsd) ? e.costUsd : 0), 0).toFixed(6));
  try {
    const tmp = path.join(runDir, `.spend.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { warn(`could not write spend ledger — ${e.message}`); }
  return ledger.totalUsd;
}

function spentSoFar(runDir) {
  const f = path.join(runDir, "spend.json");
  if (!fs.existsSync(f)) return 0;
  try {
    const raw = fs.readFileSync(f, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries) || typeof parsed.totalUsd !== "number" || !Number.isFinite(parsed.totalUsd) || parsed.totalUsd < 0) {
      return NaN;
    }
    return parsed.totalUsd;
  } catch {
    return NaN;
  }
}

/** Every other dispatch's status file in this run, newest last. `ownTask` is excluded: a
 *  background child would otherwise count its own provisional RUNNING status. */
function priorDispatches(runDir, ownTask) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(runDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    if (d.name === ownTask) continue;
    const f = path.join(runDir, d.name, "orc-status.json");
    try {
      if (fs.existsSync(f)) out.push(JSON.parse(fs.readFileSync(f, "utf8")));
    } catch { warn(`unreadable status file ignored: ${f}`); }
  }
  return out.sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
}

// ------------------------------------------------------------------- relay

function resolveRelay(selfDir) {
  // The relay is the pi-delegate skill: a sibling of this skill, or in any skill home
  // (AGENT_SKILL_HOMES, path-delimited; else ~/.claude/skills and ~/.agents/skills, as matt.mjs).
  const homes = process.env.AGENT_SKILL_HOMES
    ? process.env.AGENT_SKILL_HOMES.split(path.delimiter).filter(Boolean)
    : [path.join(os.homedir(), ".claude/skills"), path.join(os.homedir(), ".agents/skills")];
  const candidates = [
    process.env.TO_ORC_RELAY,
    path.resolve(selfDir, "../../pi-delegate/scripts/relay.mjs"),
    ...homes.map((home) => path.join(home, "pi-delegate/scripts/relay.mjs")),
  ].filter(Boolean);
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}

/** Config facts the run must prove against the *requested* worker, not a hardcoded pin. */
function classifyResult(result, relayExit, worker) {
  if (result.schema !== SCHEMA) {
    return ["SCHEMA_DRIFT", `relay result schema is ${result.schema || "absent"}, this skill reads ${SCHEMA} — update to-orc, do not blame the worker`];
  }
  if (result.status === "pi_unavailable") return ["RUNTIME_UNAVAILABLE", "relay reports the pi CLI is unavailable"];
  if (result.status === "timeout") return ["TIMEOUT", "the watchdog fired — any change set is PARTIAL and must not be verified as final"];
  if (result.status === "aborted") return ["ABORTED", "the relay was killed — any change set is PARTIAL and must not be verified as final"];

  const bad = [];
  if (result.tool !== "pi") bad.push(`tool=${result.tool}`);
  if (worker.piDefault) {
    if (!result.actualProvider || !result.actualModel) bad.push("pi did not report which provider and model ran");
  } else {
    if (result.provider !== worker.provider || result.actualProvider !== worker.provider) {
      bad.push(`provider=${result.provider}/${result.actualProvider} (wanted ${worker.provider})`);
    }
    if (result.model !== worker.model) bad.push(`requested model=${result.model} (wanted ${worker.model})`);
    if (result.actualModel !== worker.requestedModelId) {
      bad.push(`actual model=${result.actualModel} (wanted ${worker.requestedModelId})`);
    }
  }
  if (bad.length) return ["CONFIG_NON_COMPLIANT", `requested worker configuration not proven: ${bad.join(", ")}`];

  if (result.status !== "completed" || relayExit !== 0 || (typeof result.exitCode === "number" && result.exitCode !== 0) || result.stopReason === "error") {
    return ["WORKER_FAILED", `worker did not succeed (status=${result.status}, exit=${result.exitCode ?? relayExit}, relayExit=${relayExit}, stopReason=${result.stopReason ?? "n/a"})`];
  }
  return [null, null];
}

// -------------------------------------------------------------------- main

function canonicalPath(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    let curr = resolved;
    const parts = [];
    while (curr && !fs.existsSync(curr)) {
      parts.unshift(path.basename(curr));
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }
    if (fs.existsSync(curr)) {
      return path.join(fs.realpathSync(curr), ...parts);
    }
    return resolved;
  }
}

const selfPath = fileURLToPath(import.meta.url);
const opts = parseArgs(process.argv.slice(2));
const ctx = { warnings: [], startedAt: new Date().toISOString() };

// --- poll mode: answer "what happened to that dispatch?" without dispatching
if (opts.poll) {
  if (!opts.task || !opts.runDir) usageError("--poll needs --task and --run-dir");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(opts.task)) {
    usageError("--task must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} (it names a directory)");
  }
  const canonRunDir = canonicalPath(opts.runDir);
  const targetTaskDir = path.resolve(canonRunDir, opts.task);
  const rel = path.relative(canonRunDir, targetTaskDir);
  if (rel.startsWith(".." + path.sep) || rel === "..") {
    usageError("--task must not traverse outside --run-dir");
  }
  const file = path.join(targetTaskDir, "orc-status.json");
  if (!fs.existsSync(file)) {
    process.stderr.write(`orc-dispatch: no dispatch found at ${file}\n`);
    process.exit(EXIT.PRECONDITION_FAILED);
  }
  let st;
  try { st = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    process.stderr.write(`orc-dispatch: orcStatus=EVIDENCE_UNREADABLE — ${file} is not readable JSON (${e.message})\n`);
    process.exit(EXIT.EVIDENCE_UNREADABLE);
  }
  if (st.orcStatus !== "RUNNING") {
    say(`orcStatus=${st.orcStatus} · ${st.reason}`);
    process.exit(EXIT[st.orcStatus] ?? EXIT.EVIDENCE_UNREADABLE);
  }
  const lives = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  if (lives(st.pid)) {
    say(`orcStatus=RUNNING · pid ${st.pid} is still working (started ${st.dispatchedAt})`);
    process.exit(EXIT.RUNNING);
  }
  if (lives(st.relayPid)) {
    // The supervisor died but the worker did not: the workspace is still moving.
    warn(`the dispatch supervisor (pid ${st.pid}) is gone but the worker (pid ${st.relayPid}) is still running — the workspace is still being modified`);
    say(`orcStatus=RUNNING · worker pid ${st.relayPid} survives without its supervisor; no evidence will be written for this dispatch — treat the change set as unverifiable once it stops`);
    process.exit(EXIT.RUNNING);
  }
  // The process is gone and never wrote a terminal status: it was killed.
  const died = { ...st, orcStatus: "ABORTED", finishedAt: new Date().toISOString(),
    reason: `the dispatch process (pid ${st.pid}) died before writing a result — any change set is PARTIAL and must not be verified as final` };
  try { writeStatus(path.dirname(file), died); } catch { /* report anyway */ }
  process.stderr.write(`orc-dispatch: orcStatus=ABORTED — ${died.reason}\n`);
  process.exit(EXIT.ABORTED);
}

// --- argument validation (every one of these used to be a silent misbehaviour)
const policy = Object.hasOwn(PHASES, opts.phase) ? PHASES[opts.phase] : null;
if (!policy) usageError(`--phase must be one of ${Object.keys(PHASES).join(", ")}`);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(opts.task)) {
  usageError("--task must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} (it names a directory)");
}
if (!opts.brief) usageError("--brief is required");
if (!opts.runDir) usageError("--run-dir is required");
if (opts.cycles !== null && (!Number.isInteger(opts.cycles) || opts.cycles < 1)) usageError("--cycles must be a positive integer");
if (opts.maxCost !== undefined && !(opts.maxCost > 0)) usageError("--max-cost must be a positive number");

const timeout = opts.timeout || policy.timeout;
// The relay's grammar (pi-delegate relay.mjs parseDuration): integer h/m/s parts, in that order.
if (!/^(?=\d)(\d+h)?(\d+m)?(\d+s)?$/.test(timeout)) usageError(`--timeout must look like 45m, 2h, 90s or 1h30m (got ${timeout})`);

ctx.phase = opts.phase;
ctx.task = opts.task;
const repo = path.resolve(opts.repo);
const runDir = path.resolve(opts.runDir);
const runLockFile = path.join(runDir, "run.json");
let locked = null;
if (fs.existsSync(runLockFile)) {
  try { locked = JSON.parse(fs.readFileSync(runLockFile, "utf8")); } catch {
    finish({ ...ctx, out: null }, "EVIDENCE_UNREADABLE", `${runLockFile} is corrupt — the run's settings cannot be proven`);
  }
}
// No hardcoded worker. The run's first dispatch either names a model or uses pi's own
// configured default; run.json then fixes the model that actually ran for every later dispatch.
// --cycles and --max-cost left unset inherit the run's settings; only an explicit different value is a change.
if (opts.cycles === null) opts.cycles = locked?.cycles ?? 2;
if (opts.maxCost === undefined) opts.maxCost = locked ? locked.maxCost : null;
const PI_DEFAULT = { runtime: "pi", provider: null, model: null, requestedModelId: null, thinking: "pi default", piDefault: true };
const worker = opts.model || opts.provider
  ? parseWorkerSpec(opts.provider || undefined, opts.model)
  : locked?.worker?.model ? parseWorkerSpec(locked.worker.provider, locked.worker.model) : PI_DEFAULT;
const workerLabel = worker.piDefault ? "pi's configured default model" : `${worker.provider}/${worker.requestedModelId}`;
ctx.worker = worker;
const briefPath = path.resolve(opts.brief);
ctx.repo = repo;
ctx.out = path.join(runDir, opts.task);

// The run directory must sit outside the workspace, or its own artifacts show up
// as writes and every no-write phase fails forever. Validate BEFORE checking brief or writing status!
const canonRepo = canonicalPath(repo);
const canonRunDir = canonicalPath(runDir);
const rel = path.relative(canonRepo, canonRunDir);
const isInside = rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
if (isInside) {
  finish({ ...ctx, out: null }, "PRECONDITION_FAILED", `--run-dir is inside the workspace (${runDir}); artifacts would register as writes — put it outside the repo`);
}

if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) finish({ ...ctx, out: null }, "PRECONDITION_FAILED", `workspace not found: ${repo}`);
if (!fs.existsSync(briefPath) || !fs.statSync(briefPath).isFile()) finish({ ...ctx, out: null }, "PRECONDITION_FAILED", `brief not found: ${briefPath}`);
if (fs.readFileSync(briefPath, "utf8").trim() === "") finish({ ...ctx, out: null }, "PRECONDITION_FAILED", `brief is empty: ${briefPath}`);

// --- session policy
if (policy.session === "fresh" && opts.session) {
  finish(ctx, "PRECONDITION_FAILED", `phase ${opts.phase} must run in a fresh session; --session is only for repair`);
}
if (policy.session === "resume" && !opts.session) {
  finish(ctx, "PRECONDITION_FAILED", "phase repair requires --session <id from the implement dispatch>");
}

// --- ordering gate
if (policy.after) {
  const accepted = path.join(runDir, "accepted", `${policy.after}.md`);
  const ok = fs.existsSync(accepted) && fs.readFileSync(accepted, "utf8").trim() !== "";
  if (!ok) {
    finish(ctx, "PRECONDITION_FAILED", `phase ${opts.phase} may not start until ${policy.after} is accepted — write your acceptance to ${accepted}`);
  }
}

const prior = priorDispatches(runDir, opts.task);
const priorExecuted = prior.filter((p) => p.orcStatus !== "PRECONDITION_FAILED");
// A cycle is an implement or repair that ran to an end. TIMEOUT and ABORTED leave a partial tree that
// DELEGATION.md says to re-run fresh, so they spend budget (--max-cost) but not a cycle.
const PARTIAL = new Set(["TIMEOUT", "ABORTED"]);
const implementations = priorExecuted.filter((p) => p.phase === "implement" && !PARTIAL.has(p.orcStatus)).length;
const repairs = priorExecuted.filter((p) => p.phase === "repair" && !PARTIAL.has(p.orcStatus)).length;
const totalCycles = implementations + repairs;

// --- cycle cap: `cycles` implement→verify rounds means cycles-1 repairs
if (opts.phase === "implement") {
  if (implementations >= opts.cycles) {
    finish(ctx, "PRECONDITION_FAILED", `cycle limit reached: ${implementations} implementation(s) already ran and --cycles is ${opts.cycles} — a second implementation requires a new run or higher budget`);
  }
}

if (opts.phase === "repair") {
  if (totalCycles >= opts.cycles || repairs >= opts.cycles - 1) {
    finish(ctx, "PRECONDITION_FAILED", `cycle limit reached: ${repairs} repair(s) already ran and --cycles is ${opts.cycles} — stop and report the unresolved defects`);
  }
  const source = prior.filter((p) => p.relay?.sessionId === opts.session).pop();
  if (source && ["TIMEOUT", "ABORTED"].includes(source.orcStatus)) {
    finish(ctx, "PRECONDITION_FAILED", `session ${opts.session} ended as ${source.orcStatus}; its state is undefined — run a fresh implement phase instead of resuming it`);
  }
  if (!source || !["implement", "repair"].includes(source.phase) || source.orcStatus !== "COMPLIANT") {
    finish(ctx, "PRECONDITION_FAILED", `session ${opts.session} is not a known successful implement/repair session in this run`);
  }
}

// --- verify targets the exact change set the last implement/repair produced
if (opts.phase === "verify") {
  const built = priorExecuted.filter((p) => ["implement", "repair"].includes(p.phase) && p.orcStatus === "COMPLIANT").pop();
  const expected = built?.changeSet?.snapshotIdAfter;
  const now = fingerprint(repo);
  if (!built) {
    finish(ctx, "PRECONDITION_FAILED", "no compliant implement or repair in this run — nothing to verify");
  } else if (expected && now && now.snapshotId !== expected) {
    finish(ctx, "PRECONDITION_FAILED", `the workspace changed after ${built.task} (snapshot ${now.snapshotId.slice(0, 12)} ≠ ${expected.slice(0, 12)}); re-establish the change set, then verify`);
  } else if (!expected || !now) {
    ctx.warnings.push("workspace is not a git repository — verify cannot prove it targets the implemented change set");
  }
}

// --- budget
const alreadySpent = spentSoFar(runDir);
if (Number.isNaN(alreadySpent)) {
  finish(ctx, "EVIDENCE_UNREADABLE", `spend ledger is corrupt or invalid JSON — fails closed to prevent unbudgeted spending`);
}
if (opts.maxCost !== null && alreadySpent >= opts.maxCost) {
  finish(ctx, "PRECONDITION_FAILED", `run has spent $${alreadySpent.toFixed(4)} of its $${opts.maxCost.toFixed(2)} budget — raise --max-cost or stop`);
}

// --- runtime availability
const relay = resolveRelay(path.dirname(selfPath));
if (!relay) finish(ctx, "RUNTIME_UNAVAILABLE", "pi-delegate relay.mjs not found in any known skill root");
ctx.relay = relay;
if (spawnSync("pi", ["--version"], { stdio: "ignore" }).status !== 0) {
  finish(ctx, "RUNTIME_UNAVAILABLE", "the pi CLI is not installed or not runnable");
}

// --- existing dispatch under this task id
const statusFile = path.join(ctx.out, "orc-status.json");
if (fs.existsSync(statusFile) && !opts.force && !opts.childOfBackground) {
  finish({ ...ctx, out: null }, "PRECONDITION_FAILED", `${statusFile} already exists — pick a new --task or pass --force to overwrite the evidence`);
}

// --- run lock: worker, cycles and budget are fixed by the run's first dispatch
const runLock = {
  schema: "to-orc.run.v1",
  worker: { runtime: worker.runtime, provider: worker.provider, model: worker.model, requestedModelId: worker.requestedModelId },
  cycles: opts.cycles,
  maxCost: opts.maxCost,
};
if (locked) {
  const drift = [];
  if (locked.worker?.provider !== runLock.worker.provider || locked.worker?.model !== runLock.worker.model) {
    drift.push(`worker ${locked.worker?.provider}/${locked.worker?.model} → ${runLock.worker.provider}/${runLock.worker.model}`);
  }
  if (locked.cycles !== runLock.cycles) drift.push(`--cycles ${locked.cycles} → ${runLock.cycles}`);
  if (locked.maxCost !== runLock.maxCost) drift.push(`--max-cost ${locked.maxCost} → ${runLock.maxCost}`);
  if (drift.length) {
    finish(ctx, "PRECONDITION_FAILED", `this dispatch changes settings fixed in ${runLockFile}: ${drift.join("; ")} — pass the run's settings, or start a new run directory`);
  }
} else if (!opts.dryRun) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(runLockFile, `${JSON.stringify(runLock, null, 2)}\n`);
}

if (opts.dryRun) {
  say(`dry run · phase=${opts.phase} task=${opts.task} writes=${policy.writes} timeout=${timeout} session=${policy.session}`);
  say(`dry run · worker=pi · ${workerLabel} · thinking=${worker.thinking}`);
  say(`dry run · relay=${relay} repo=${repo} out=${ctx.out}`);
  say(`dry run · spent=$${alreadySpent.toFixed(4)}${opts.maxCost !== null ? ` of $${opts.maxCost.toFixed(2)}` : ""}`);
  say("dry run · all preconditions satisfied; nothing dispatched");
  process.exit(0);
}

// Clean any old artifacts in ctx.out before execution so stale results are never read
if (fs.existsSync(ctx.out)) {
  for (const f of ["result.json", "final.txt", "events.jsonl", "stderr.txt", "brief.txt", "relay-ready"]) {
    try { fs.unlinkSync(path.join(ctx.out, f)); } catch {}
  }
}

// --- detach when asked, so no harness command timeout can kill a long phase
if (opts.background) {
  fs.mkdirSync(ctx.out, { recursive: true });
  const log = fs.openSync(path.join(ctx.out, "dispatch.log"), "a");
  const args = [...process.argv.slice(2).filter((a) => a !== "--background"), "--child-of-background"];
  const child = spawn(process.execPath, [selfPath, ...args], {
    detached: true, stdio: ["ignore", log, log],
  });
  child.unref();
  const provisional = buildStatus(ctx, "RUNNING", `detached dispatch started; poll this file`, {});
  provisional.pid = child.pid;
  writeStatus(ctx.out, provisional);
  say(`backgrounded · pid=${child.pid} · poll ${statusFile}`);
  say(`recheck · node ${selfPath} --poll --task ${opts.task} --run-dir ${runDir}`);
  say(`log · ${path.join(ctx.out, "dispatch.log")}`);
  process.exit(0);
}

// The pre-dispatch fingerprint and, for a no-write phase, the pinned workspace (§ restore).
let before = null;
let pin = null;

// A terminal status must exist however this process ends.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    if (relayChild) {
      try {
        writeStatus(ctx.out, { ...buildStatus(ctx, "ABORTED", `the dispatch received ${sig} — cancelling worker`), relayPid: relayChild.pid });
      } catch {}
      try { relayChild.kill("SIGTERM"); } catch {}
      try { process.kill(-relayChild.pid, "SIGTERM"); } catch {}
      const t0 = Date.now();
      while (Date.now() - t0 < 50) {
        try { process.kill(relayChild.pid, 0); } catch { break; }
      }
      try { relayChild.kill("SIGKILL"); } catch {}
      try { process.kill(-relayChild.pid, "SIGKILL"); } catch {}
      const t1 = Date.now();
      while (Date.now() - t1 < 1000) {
        try { process.kill(relayChild.pid, 0); } catch { break; }
        spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)"]);
      }
    }
    if (finalWritten) process.exit(EXIT.ABORTED);
    const partial = diffFingerprints(before, fingerprint(repo));
    const changeSetOut = { verified: partial.verified, pathsChanged: partial.pathsChanged, detail: partial.detail };
    undoWrites(changeSetOut);
    finish(ctx, "ABORTED", `the dispatch received ${sig} — any change set is PARTIAL and must not be verified as final`, { changeSet: changeSetOut });
    process.exit(EXIT.ABORTED);
  });
}
writeStatus(ctx.out, buildStatus(ctx, "RUNNING", "dispatch in flight", {}));

before = fingerprint(repo);
if (!before) ctx.warnings.push("workspace is not a git repository — writes cannot be verified and no diff identifier exists");
// A no-write phase gets its workspace pinned first, so any write can be undone (§ restore).
if (policy.writes === "none" && before) {
  try {
    pin = pinWorkspace(repo, `refs/to-orc/${sha(Buffer.from(`${canonRunDir}\0${opts.task}`)).slice(0, 16)}`, ctx.out);
  } catch (e) {
    ctx.warnings.push(`could not pin the workspace (${e.message}) — a write by this phase would not be undone`);
  }
}
/** Undo a no-write phase's writes; the restore record joins the change set. */
function undoWrites(changeSetOut) {
  if (!pin) return;
  if (changeSetOut.detail.length) {
    changeSetOut.restore = restoreWorkspace(repo, pin, before);
    if (changeSetOut.restore.verified) spawnSync("git", ["-C", repo, "update-ref", "-d", changeSetOut.restore.before], { stdio: "ignore" });
  } else {
    spawnSync("git", ["-C", repo, "update-ref", "-d", `${pin.refBase}/before`], { stdio: "ignore" });
  }
  try { fs.rmSync(pin.indexCopy ?? "", { force: true }); } catch {}
  pin = null;
}

const relayArgs = [relay, "--brief", briefPath, "--cd", repo, "--out-dir", ctx.out, "--timeout", timeout];
if (!worker.piDefault) relayArgs.push("--provider", worker.provider, "--model", worker.model);
if (opts.session) relayArgs.push("--session", opts.session);

say(`dispatch · phase=${opts.phase} task=${opts.task} writes=${policy.writes} timeout=${timeout}`);
say(`worker · pi · ${workerLabel} · thinking=${worker.thinking}`);
say(`relay · ${relay}`);
// detached: the relay leads its own process group, so the group kills below also reach pi.
const child = spawn(process.execPath, relayArgs, { stdio: "inherit", detached: true });
relayChild = child;
// Publish the worker's pid while it runs: if this supervisor is killed, --poll
// must be able to tell that the worker itself is still editing the workspace.
writeStatus(ctx.out, { ...buildStatus(ctx, "RUNNING", "dispatch in flight", {}), relayPid: child.pid });
const relayExit = await new Promise((resolve) => {
  child.on("error", () => resolve(127));
  child.on("close", (code, signal) => resolve(code === null ? 128 + (signal ? 1 : 0) : code));
});
relayChild = null;

const after = fingerprint(repo);
const changeSet = diffFingerprints(before, after);
const changeSetOut = {
  verified: changeSet.verified,
  headBefore: before?.head ?? null,
  headAfter: after?.head ?? null,
  headChanged: changeSet.headChanged,
  worktreeDiffSha: after?.worktreeDiffSha ?? null,
  indexDiffSha: after?.indexDiffSha ?? null,
  snapshotIdBefore: before?.snapshotId ?? null,
  snapshotIdAfter: after?.snapshotId ?? null,
  pathsChanged: changeSet.pathsChanged,
  detail: changeSet.detail,
};
undoWrites(changeSetOut);

// The relay writes result.json on every outcome once the brief validates. Its
// absence means the relay rejected our invocation or never started.
const resultFile = path.join(ctx.out, "result.json");
if (!fs.existsSync(resultFile)) {
  const reason = relayExit === 127
    ? "the relay could not find the pi CLI"
    : `the relay exited ${relayExit} without writing result.json — it rejected this invocation (a to-orc bug, not a worker failure)`;
  finish(ctx, relayExit === 127 ? "RUNTIME_UNAVAILABLE" : "PRECONDITION_FAILED", reason, { changeSet: changeSetOut });
}

let result;
try {
  result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
} catch (e) {
  finish(ctx, "EVIDENCE_UNREADABLE", `result.json is not readable JSON (${e.message}) — the dispatch produced no usable evidence`, { changeSet: changeSetOut });
}
if (!result || typeof result !== "object" || Array.isArray(result)) {
  finish(ctx, "EVIDENCE_UNREADABLE", `result.json is not a JSON object — the dispatch produced no usable evidence`, { changeSet: changeSetOut });
}

const cost = typeof result.usage?.cost?.total === "number" && Number.isFinite(result.usage.cost.total) && result.usage.cost.total >= 0 ? result.usage.cost.total : 0;
const runTotalUsd = recordSpend(runDir, {
  task: opts.task, phase: opts.phase, costUsd: cost,
  at: new Date().toISOString(), sessionId: result.sessionId ?? null,
});
const costOut = { dispatchUsd: cost, runTotalUsd };

if (result.piVersion && !KNOWN_PI.some((p) => String(result.piVersion).startsWith(p))) {
  ctx.warnings.push(`pi ${result.piVersion} is outside the known range (${KNOWN_PI.join(", ")}*) — re-verify that --model "${worker.model}" still means thinking=${worker.thinking}`);
}

const relayOut = {
  status: result.status ?? null,
  exitCode: result.exitCode ?? relayExit,
  relayExitCode: relayExit,
  piVersion: result.piVersion ?? null,
  sessionId: result.sessionId ?? null,
  provider: result.actualProvider ?? null,
  model: result.actualModel ?? null,
  requestedModel: result.model ?? null,
  reasoningTokens: result.usage?.reasoning ?? null,
  stopReason: result.stopReason ?? null,
  artifacts: {
    result: resultFile,
    finalMessage: result.finalPath ?? path.join(ctx.out, "final.txt"),
    events: result.eventsPath ?? path.join(ctx.out, "events.jsonl"),
    stderr: result.stderrPath ?? path.join(ctx.out, "stderr.txt"),
    brief: result.briefPath ?? path.join(ctx.out, "brief.txt"),
  },
};
const extra = { relay: relayOut, changeSet: changeSetOut, cost: costOut };

const [failStatus, failReason] = classifyResult(result, relayExit, worker);
if (failStatus && failStatus !== "WORKER_FAILED") finish(ctx, failStatus, failReason, extra);

// The first proven run on pi's default fixes that model for the rest of the run.
if (worker.piDefault) {
  const current = JSON.parse(fs.readFileSync(runLockFile, "utf8"));
  if (!current.worker?.model) {
    current.worker = {
      runtime: "pi",
      provider: result.actualProvider,
      model: `${result.actualProvider}/${result.actualModel}`,
      requestedModelId: result.actualModel,
    };
    fs.writeFileSync(runLockFile, `${JSON.stringify(current, null, 2)}\n`);
  }
}
if (failStatus) finish(ctx, failStatus, failReason, extra);

if (policy.writes === "none") {
  if (!changeSet.verified) {
    ctx.warnings.push("no-write compliance is UNVERIFIED — record it as an unknown, never as a clean tree");
  } else if (changeSet.detail.length) {
    const r = changeSetOut.restore;
    const undone = !r ? "the workspace could not be pinned, so the writes remain"
      : r.verified ? `the workspace was restored and verified; the writes are kept at ${r.after}`
      : `RESTORE FAILED (${r.error}); the pre-dispatch state is at ${r.before}, the writes at ${r.after}`;
    finish(ctx, "NO_WRITES_VIOLATED", `phase ${opts.phase} must not modify the workspace but ${changeSet.detail.length} change(s) were fingerprinted: ${changeSet.detail.slice(0, 10).join("; ")} — ${undone}`, extra);
  }
}

for (const w of ctx.warnings) warn(w);
const ranOn = worker.piDefault ? `pi's default (${result.actualProvider}/${result.actualModel})` : `requested config (${workerLabel})`;
finish(ctx, "COMPLIANT", policy.writes === "none"
  ? `worker completed on ${ranOn}; ${changeSet.verified ? "workspace unchanged" : "writes unverifiable"}`
  : `worker completed on ${ranOn}; ${changeSetOut.pathsChanged.length} path(s) changed`, extra);
