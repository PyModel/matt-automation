import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, SKILLS, VERIFIED_HOMES, UNVERIFIED_HOMES, install } from './install.mjs';

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
