#!/usr/bin/env node
// The one owner of "where is a skill, and is the Matt skill set wired correctly".
//
//   node scripts/matt.mjs resolve <name>   absolute SKILL.md path the automations must load
//   node scripts/matt.mjs link             regenerate matt/<name> symlinks from the pinned submodule
//   node scripts/matt.mjs check            fail on any wiring drift or missing installed skill; print pin and drift
//   node scripts/matt.mjs check --vendored fail only on the repo's own wiring (CI: no skills are installed there)
//
// Matt skills come from vendor/mattpocock-skills (a pinned git submodule) through
// the committed symlinks in matt/. Skills outside the set (research-stack,
// defensive-design, kun, ...) come from the installed-skill directories: AGENT_SKILL_HOMES
// (path-delimited) when set, else ~/.claude/skills and ~/.agents/skills.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VENDOR = 'vendor/mattpocock-skills';
const LINKS = 'matt';
// Same rule as upstream's scripts/link-skills.sh: retired and unpromoted buckets stay out.
const EXCLUDED_BUCKETS = new Set(['deprecated', 'misc']);
// Harness commands ask-matt names that are not skills.
const HARNESS_COMMANDS = new Set(['clear', 'compact']);
const INTEGRATION = 'to-auto/INTEGRATION.md';
const DEFAULT_HOMES = process.env.AGENT_SKILL_HOMES
  ? process.env.AGENT_SKILL_HOMES.split(path.delimiter).filter(Boolean)
  : [path.join(os.homedir(), '.claude/skills'), path.join(os.homedir(), '.agents/skills')];

export function scanVendor(root) {
  const skillsDir = path.join(root, VENDOR, 'skills');
  const found = new Map();
  for (const bucket of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!bucket.isDirectory() || EXCLUDED_BUCKETS.has(bucket.name)) continue;
    for (const entry of fs.readdirSync(path.join(skillsDir, bucket.name), { withFileTypes: true })) {
      const dir = path.join(skillsDir, bucket.name, entry.name);
      if (!entry.isDirectory() || !fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
      if (found.has(entry.name)) throw new Error(`duplicate vendored skill name: ${entry.name}`);
      found.set(entry.name, dir);
    }
  }
  return found;
}

// Finder and editor droppings (.DS_Store) are not skills; only non-dot entries of matt/ count.
const linkNames = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => !name.startsWith('.')) : []);

export function link(root) {
  const linksDir = path.join(root, LINKS);
  fs.mkdirSync(linksDir, { recursive: true });
  const vendored = scanVendor(root);
  const removed = [];
  for (const name of linkNames(linksDir)) {
    const entry = path.join(linksDir, name);
    if (!fs.lstatSync(entry).isSymbolicLink()) throw new Error(`${LINKS}/${name} is not a symlink; refusing to touch it`);
    if (!vendored.has(name)) {
      fs.unlinkSync(entry);
      removed.push(name);
    }
  }
  for (const [name, dir] of vendored) {
    const entry = path.join(linksDir, name);
    const target = path.relative(linksDir, dir);
    if (fs.existsSync(entry) || isSymlink(entry)) {
      if (fs.readlinkSync(entry) === target) continue;
      fs.unlinkSync(entry);
    }
    fs.symlinkSync(target, entry);
  }
  return { linked: [...vendored.keys()].sort(), removed: removed.sort() };
}

export function resolve(root, name, { homes = DEFAULT_HOMES } = {}) {
  const pinned = path.join(root, LINKS, name, 'SKILL.md');
  if (fs.existsSync(pinned)) return fs.realpathSync(pinned);
  for (const home of homes) {
    const installed = path.join(home, name, 'SKILL.md');
    if (fs.existsSync(installed)) return installed;
  }
  throw new Error(`skill not found: ${name} (looked in ${LINKS}/ and ${homes.join(', ')})`);
}

export function check(root, { homes = DEFAULT_HOMES } = {}) {
  const errors = [];
  const missing = [];
  const info = [];
  const vendored = scanVendor(root);
  const linksDir = path.join(root, LINKS);
  const linked = new Set(linkNames(linksDir));

  for (const name of linked) {
    if (!vendored.has(name)) errors.push(`${LINKS}/${name}: stale or dangling link (not in the pinned submodule); run \`node scripts/matt.mjs link\``);
    else if (!fs.existsSync(path.join(linksDir, name, 'SKILL.md'))) errors.push(`${LINKS}/${name}: dangling link`);
    else if (fs.realpathSync(path.join(linksDir, name)) !== fs.realpathSync(vendored.get(name))) errors.push(`${LINKS}/${name}: points away from the pinned submodule`);
  }
  for (const name of vendored.keys()) {
    if (!linked.has(name)) errors.push(`${LINKS}/${name}: missing link to a vendored skill; run \`node scripts/matt.mjs link\``);
  }

  const integrated = integrationSkills(path.join(root, INTEGRATION));
  for (const name of vendored.keys()) {
    if (!integrated.has(name)) errors.push(`${name}: vendored skill has no row in ${INTEGRATION} (integrate it or list it as not used)`);
  }
  // A row that is not vendored must be an installed skill; its absence is an install problem, not wiring.
  for (const name of integrated) {
    if (vendored.has(name)) continue;
    try {
      resolve(root, name, { homes });
    } catch {
      missing.push(`${name}: named in ${INTEGRATION}, not vendored, and not installed in ${homes.join(', ') || '(no skill homes)'}`);
    }
  }

  if (vendored.has('ask-matt')) {
    const router = fs.readFileSync(path.join(vendored.get('ask-matt'), 'SKILL.md'), 'utf8');
    for (const [, name] of router.matchAll(/`\/([a-z][a-z0-9-]*)`/g)) {
      if (!HARNESS_COMMANDS.has(name) && !vendored.has(name)) errors.push(`ask-matt routes to /${name}, which is not a linked Matt skill`);
    }
  } else {
    errors.push('ask-matt is missing from the pinned submodule; the automations cannot route');
  }

  info.push(`pin: ${VENDOR} @ ${pinnedSha(root)}`);
  for (const [name, dir] of vendored) {
    for (const home of homes) {
      const installed = path.join(home, name);
      if (fs.existsSync(installed) && !sameTree(installed, dir)) info.push(`drift: ${name} installed at ${installed} differs from the pin`);
    }
  }
  return { errors, missing, info };
}

// Every table in INTEGRATION.md that has a "Skill" header column contributes its first token per row.
function integrationSkills(file) {
  const names = new Set();
  let column = -1;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('|')) {
      column = -1;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (column === -1) {
      column = cells.indexOf('Skill');
      continue;
    }
    const match = cells[column]?.replaceAll('`', '').match(/^[a-z][a-z0-9-]*/);
    if (match) names.add(match[0]);
  }
  return names;
}

function sameTree(a, b) {
  const realA = fs.realpathSync(a);
  const realB = fs.realpathSync(b);
  if (realA === realB) return true;
  const filesA = listFiles(realA);
  const filesB = listFiles(realB);
  if (filesA.join('\n') !== filesB.join('\n')) return false;
  return filesA.every((rel) => fs.readFileSync(path.join(realA, rel)).equals(fs.readFileSync(path.join(realB, rel))));
}

function listFiles(dir, prefix = '') {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = path.join(prefix, entry.name);
      return entry.isDirectory() ? listFiles(dir, rel) : [rel];
    })
    .sort();
}

function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function pinnedSha(root) {
  try {
    return execFileSync('git', ['-C', path.join(root, VENDOR), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown (not a git checkout)';
  }
}

function main([command, ...args]) {
  const root = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), '..');
  if (command === 'resolve' && args.length === 1) {
    try {
      console.log(resolve(root, args[0]));
    } catch (error) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
  } else if (command === 'link' && args.length === 0) {
    const { linked, removed } = link(root);
    console.log(`linked ${linked.length} skills into ${LINKS}/${removed.length ? `; removed ${removed.join(', ')}` : ''}`);
  } else if (command === 'check' && (args.length === 0 || (args.length === 1 && args[0] === '--vendored'))) {
    const { errors, missing, info } = check(root);
    const failures = args[0] === '--vendored' ? errors : [...errors, ...missing];
    for (const line of info) console.log(line);
    if (args[0] === '--vendored') for (const line of missing) console.log(`not installed: ${line}`);
    for (const line of failures) console.error(`error: ${line}`);
    if (failures.length) process.exit(1);
    console.log('ok');
  } else {
    console.error('usage: matt.mjs resolve <name> | link | check [--vendored]');
    process.exit(2);
  }
  // Exit 0 = ok, 1 = check found problems or a skill does not resolve, 2 = usage, 3 = runtime error.
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(3);
  }
}
