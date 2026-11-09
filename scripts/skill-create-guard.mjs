#!/usr/bin/env node
// Claude Code PreToolUse hook for autoharness's `stage_skill` tool: deny a `create` whose name is already a skill that
// autoharness did not make. autoharness 0.5.3 checks ownership for update, patch and delete, never for create, so on
// 2026-10-19 a create named `to-auto` wrote SKILL.md and its `.sidecar.json` through the installed link into this repo;
// the sidecar then got the link archived as "unused" on 2026-11-09. Fails open: any error lets the call through.
//   settings.json: PreToolUse, matcher `mcp__plugin_autoharness_stage_skill__stage_skill`
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Why this tool call must not run, or null. `home` and `cwd` locate the global and the project skills folder. */
export function refusal(input, { home = os.homedir() } = {}) {
  const { tool_name: tool = '', tool_input: args = {}, cwd = process.cwd() } = input ?? {};
  if (!String(tool).endsWith('stage_skill') || args.action !== 'create' || typeof args.name !== 'string') return null;
  const dir = path.join(args.level === 'global' ? home : cwd, '.claude', 'skills', path.basename(args.name));
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return null;
  let own = false;
  try {
    own = JSON.parse(fs.readFileSync(path.join(dir, '.sidecar.json'), 'utf8')).created_by === 'agent';
  } catch { /* no sidecar: not autoharness's */ }
  return own ? null : `a skill named ${args.name} already exists at ${dir} and autoharness did not create it, so create would overwrite it: pick another name (Guard: scripts/skill-create-guard.mjs)`;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const reason = refusal(JSON.parse(fs.readFileSync(0, 'utf8')));
    if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  } catch { /* fail open */ }
}
