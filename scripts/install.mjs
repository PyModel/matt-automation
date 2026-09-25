#!/usr/bin/env node
// Link this repo's skills into agent skill folders. The script finds its own
// location; it does not depend on the current directory.
//
// Homes are a path list, not a branch on a tool name. Verified from each tool's
// own docs or source on 2026-09-25:
// - ~/.agents/skills — Pi docs/skills.md: "Pi also supports the Agent Skills locations ~/.agents/skills/"
// - ~/.pi/agent/skills — Pi dist/config.js ("User Config Paths (~/.pi/agent/*)") and
//   dist/core/package-manager.js ("User skills from ~/.pi/agent/"), joined as agentDir/skills
// Unverified, so not linked unless --home names them or --include-unverified is set:
// - ~/.claude/skills — not printed by `claude --help`; matt.mjs already looks there
// - ~/.codex/skills — not printed by `codex --help`
// - ~/.cursor/skills — not verified from Cursor's docs or --help
//
//   node scripts/install.mjs [--home <dir>]... [--include-unverified] [--dry-run]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS = ['to-auto', 'to-bug', 'to-new', 'to-orc'];

export const VERIFIED_HOMES = [
  { path: path.join(os.homedir(), '.agents', 'skills'), source: 'Pi docs/skills.md', verified: true },
  { path: path.join(os.homedir(), '.pi', 'agent', 'skills'), source: 'Pi dist/config.js and package-manager.js', verified: true },
];

export const UNVERIFIED_HOMES = [
  { path: path.join(os.homedir(), '.claude', 'skills'), source: 'not in claude --help; matt.mjs looks here', verified: false },
  { path: path.join(os.homedir(), '.codex', 'skills'), source: 'not in codex --help', verified: false },
  { path: path.join(os.homedir(), '.cursor', 'skills'), source: 'not verified from Cursor docs or --help', verified: false },
];

export function install({ homes, dryRun = false } = {}) {
  const linked = [];
  for (const home of homes) {
    const dir = path.resolve(home.path ?? home);
    if (!dryRun) fs.mkdirSync(dir, { recursive: true });
    for (const name of SKILLS) {
      const source = path.join(ROOT, name);
      if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error(`missing skill: ${source}`);
      const dest = path.join(dir, name);
      if (!dryRun) {
        if (fs.existsSync(dest) || isLink(dest)) fs.rmSync(dest, { recursive: true, force: true });
        fs.symlinkSync(source, dest);
      }
      linked.push({ home: dir, name, source, verified: home.verified !== false });
    }
  }
  return linked;
}

function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function main(argv) {
  const homes = [];
  let includeUnverified = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home') {
      const dir = argv[++i];
      if (!dir) {
        console.error('error: --home needs a path');
        return 2;
      }
      homes.push({ path: dir, verified: true, source: '--home' });
    } else if (argv[i] === '--include-unverified') includeUnverified = true;
    else if (argv[i] === '--dry-run') dryRun = true;
    else {
      console.error('usage: install.mjs [--home <dir>]... [--include-unverified] [--dry-run]');
      return 2;
    }
  }
  const targets = homes.length ? homes : [...VERIFIED_HOMES, ...(includeUnverified ? UNVERIFIED_HOMES : [])];
  const linked = install({ homes: targets, dryRun });
  for (const row of linked) console.log(`${dryRun ? 'would link' : 'linked'} ${row.name} -> ${row.home} (${row.verified ? 'verified' : 'unverified'})`);
  if (!homes.length && !includeUnverified) {
    for (const row of UNVERIFIED_HOMES) console.log(`skipped ${row.path} (unverified: ${row.source})`);
  }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
