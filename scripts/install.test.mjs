import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, SKILLS, VERIFIED_HOMES, UNVERIFIED_HOMES, install, check } from './install.mjs';

const INSTALL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install.mjs');

test('install links each skill into the given home and marks unverified homes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-home-'));
  const linked = install({ homes: [{ path: home, verified: true }] });
  assert.equal(linked.length, SKILLS.length);
  for (const name of SKILLS) {
    const dest = path.join(home, name);
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(dest), path.join(ROOT, name));
    assert.equal(fs.existsSync(path.join(dest, 'SKILL.md')), true);
  }
  assert.ok(VERIFIED_HOMES.every((row) => row.verified && row.source));
  assert.ok(UNVERIFIED_HOMES.every((row) => row.verified === false && row.source));
  const dry = spawnSync(process.execPath, [INSTALL, '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /unverified/);
  assert.match(dry.stdout, /skipped /);
});

test('install replaces its own link and refuses a real folder, whose edits live nowhere else', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-home-'));
  install({ homes: [home] });
  install({ homes: [home] });
  fs.rmSync(path.join(home, 'to-bug'));
  fs.mkdirSync(path.join(home, 'to-bug'));
  fs.writeFileSync(path.join(home, 'to-bug', 'SKILL.md'), 'my copy');
  assert.throws(() => install({ homes: [home] }), /to-bug is a real folder, not a link/);
  assert.equal(fs.readFileSync(path.join(home, 'to-bug', 'SKILL.md'), 'utf8'), 'my copy');
  const cli = spawnSync(process.execPath, [INSTALL, '--home', home], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^error: .*not a link/);
});

test('check names a skill a home lost and a skill manager sidecar, and stays quiet about a home it was never installed in', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-home-'));
  const never = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-home-'));
  install({ homes: [home] });
  assert.deepEqual(check({ homes: [home, never] }), []);
  // 2026-11-09: autoharness moved ~/.claude/skills/to-auto into .archive, where its relative link dangles.
  fs.mkdirSync(path.join(home, '.archive'));
  fs.renameSync(path.join(home, 'to-auto'), path.join(home, '.archive', 'to-auto'));
  fs.rmSync(path.join(home, 'to-orc'));
  fs.symlinkSync(path.join(home, 'gone'), path.join(home, 'to-orc'));
  const rows = check({ homes: [home, never] });
  assert.deepEqual(rows.map((row) => [row.home, row.name, row.code]), [[home, 'to-auto', 'NOT_INSTALLED'], [home, 'to-orc', 'NOT_INSTALLED']]);
  assert.match(rows[0].message, /moved it to .*\.archive/);
  assert.match(rows[1].message, /the link is broken/);
  const cli = spawnSync(process.execPath, [INSTALL, '--check', '--home', home], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, new RegExp(`^${home} to-auto NOT_INSTALLED `, 'm'));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-root-'));
  for (const name of SKILLS) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, 'to-auto', '.sidecar.json'), '{"created_by":"agent","use":0}');
  assert.deepEqual(check({ homes: [], root }).map((row) => [row.name, row.code]), [['to-auto', 'AGENT_OWNED']]);
});

test('skill-create-guard denies a create over a skill autoharness did not make, and nothing else', async () => {
  const { refusal } = await import('./skill-create-guard.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-guard-'));
  const skill = (name, sidecar) => {
    fs.mkdirSync(path.join(home, '.claude', 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', name, 'SKILL.md'), 'x');
    if (sidecar) fs.writeFileSync(path.join(home, '.claude', 'skills', name, '.sidecar.json'), JSON.stringify(sidecar));
  };
  skill('to-auto');
  skill('its-own', { created_by: 'agent' });
  const call = (tool_input, cwd = home) => refusal({ tool_name: 'mcp__plugin_autoharness_stage_skill__stage_skill', tool_input, cwd }, { home });
  assert.match(call({ action: 'create', name: 'to-auto', level: 'global' }), /already exists .* did not create it/);
  assert.match(call({ action: 'create', name: 'to-auto' }), /already exists/, 'the default level is the project, whose skills folder is under cwd');
  assert.equal(call({ action: 'create', name: 'brand-new', level: 'global' }), null);
  assert.equal(call({ action: 'create', name: 'its-own', level: 'global' }), null, "a replay of autoharness's own create");
  assert.equal(call({ action: 'patch', name: 'to-auto' }), null, 'autoharness already refuses these itself');
  assert.equal(refusal({ tool_name: 'Bash', tool_input: { action: 'create', name: 'to-auto', level: 'global' } }, { home }), null);
  const GUARD = path.join(path.dirname(INSTALL), 'skill-create-guard.mjs');
  const run = (stdin) => spawnSync(process.execPath, [GUARD], { input: stdin, encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.match(run(JSON.stringify({ tool_name: 'mcp__plugin_autoharness_stage_skill__stage_skill', tool_input: { action: 'create', name: 'to-auto', level: 'global' }, cwd: home })).stdout, /"permissionDecision":"deny"/);
  assert.deepEqual([run('not json').status, run('not json').stdout], [0, ''], 'fails open');
});
