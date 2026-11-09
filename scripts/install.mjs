#!/usr/bin/env node
// Link this repo's skills into agent skill folders. The script finds its own
// location; it does not depend on the current directory.
//
// Homes are a path list, not a branch on a tool name. Verified from each tool's
// own docs or source on 2026-09-25:
// - ~/.agents/skills — Pi docs/skills.md: "Pi also supports the Agent Skills locations ~/.agents/skills/"
// - ~/.pi/agent/skills — Pi dist/config.js ("User Config Paths (~/.pi/agent/*)") and
//   dist/core/package-manager.js ("User skills from ~/.pi/agent/"), joined as agentDir/skills
// - ~/.claude/skills — Claude Code's personal skills. Observed 2026-11-09: /to-auto left the slash menu when this
//   link was removed while ~/.agents/skills kept its copy, so Claude Code reads here and not ~/.agents/skills
// Unverified, so not linked unless --home names them or --include-unverified is set:
// - ~/.codex/skills — not printed by `codex --help`
// - ~/.cursor/skills — not verified from Cursor's docs or --help
//
//   node scripts/install.mjs [--home <dir>]... [--include-unverified] [--dry-run]
//   node scripts/install.mjs --check [--home <dir>]...   one line per broken install, exit 1 when any (to-auto-watch.sh runs it)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// to-auto-ticket-lifecycle is autoharness's (gitignored here), so a clone has none to link.
export const SKILLS = ['to-auto', 'to-bug', 'to-new', 'to-orc'];

export const VERIFIED_HOMES = [
  { path: path.join(os.homedir(), '.agents', 'skills'), source: 'Pi docs/skills.md', verified: true },
  { path: path.join(os.homedir(), '.pi', 'agent', 'skills'), source: 'Pi dist/config.js and package-manager.js', verified: true },
  { path: path.join(os.homedir(), '.claude', 'skills'), source: 'observed 2026-11-09: Claude Code lists a skill only while it is linked here', verified: true },
];

export const UNVERIFIED_HOMES = [
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
      // Only a link is ours to replace: a real folder there is someone's copy, and its edits are not in this repo.
      if (!isLink(dest) && fs.existsSync(dest)) throw new Error(`${dest} is a real ${fs.statSync(dest).isDirectory() ? 'folder' : 'file'}, not a link: move it away, then install again`);
      if (!dryRun) {
        fs.rmSync(dest, { force: true });
        fs.symlinkSync(source, dest);
      }
      linked.push({ home: dir, name, source, verified: home.verified !== false });
    }
  }
  return linked;
}

/**
 * What stops a harness from offering a skill, as `<home> <skill> <CODE> <message>` rows (the shape to-auto-watch.sh keys on).
 * A home counts once it links any of SKILLS here, so a home this repo was never installed into stays quiet.
 * AGENT_OWNED: a skill manager (autoharness) left its `.sidecar.json` in the skill's folder through the link, claims the
 * skill as its own, and archives the link when its own counters read unused (2026-11-09) or rewrites SKILL.md (2026-10-19).
 */
export function check({ homes, root = ROOT } = {}) {
  const problems = [];
  for (const name of SKILLS) {
    if (agentOwned(path.join(root, name, '.sidecar.json'))) problems.push({ home: root, name, code: 'AGENT_OWNED', message: `${path.join(name, '.sidecar.json')} makes a skill manager treat this skill as its own (it archives or rewrites it): delete that file` });
  }
  for (const home of homes) {
    const dir = path.resolve(home.path ?? home);
    const state = (name) => {
      const dest = path.join(dir, name);
      if (!isLink(dest)) return fs.existsSync(dest) ? 'copy' : 'absent';
      if (!fs.existsSync(dest)) return 'dangling';
      return fs.realpathSync(dest) === fs.realpathSync(path.join(root, name)) ? 'ok' : 'elsewhere';
    };
    const states = SKILLS.map((name) => [name, state(name)]);
    if (!states.some(([, s]) => s === 'ok')) continue;
    for (const [name, s] of states) {
      const archived = isLink(path.join(dir, '.archive', name)) ? ` (a skill manager moved it to ${path.join(dir, '.archive', name)})` : '';
      if (s === 'absent' || s === 'dangling') problems.push({ home: dir, name, code: 'NOT_INSTALLED', message: `${s === 'dangling' ? 'the link is broken' : 'no link'}${archived}: \`node ${path.join(root, 'scripts', 'install.mjs')} --home ${dir}\`` });
    }
  }
  return problems;
}

/** autoharness's membership key: a sidecar that says `created_by: agent`. */
function agentOwned(sidecar) {
  try {
    return JSON.parse(fs.readFileSync(sidecar, 'utf8')).created_by === 'agent';
  } catch {
    return false;
  }
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
  let checking = false;
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
    else if (argv[i] === '--check') checking = true;
    else {
      console.error('usage: install.mjs [--home <dir>]... [--include-unverified] [--dry-run] | --check [--home <dir>]...');
      return 2;
    }
  }
  if (checking) {
    const problems = check({ homes: homes.length ? homes : [...VERIFIED_HOMES, ...UNVERIFIED_HOMES] });
    for (const row of problems) console.log(`${row.home} ${row.name} ${row.code} ${row.message}`);
    return problems.length ? 1 : 0;
  }
  const targets = homes.length ? homes : [...VERIFIED_HOMES, ...(includeUnverified ? UNVERIFIED_HOMES : [])];
  let linked;
  try {
    linked = install({ homes: targets, dryRun });
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 1;
  }
  for (const row of linked) console.log(`${dryRun ? 'would link' : 'linked'} ${row.name} -> ${row.home} (${row.verified ? 'verified' : 'unverified'})`);
  if (!homes.length && !includeUnverified) {
    for (const row of UNVERIFIED_HOMES) console.log(`skipped ${row.path} (unverified: ${row.source})`);
  }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
