import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanVendor, link, resolve, check } from './matt.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function skill(dir, name, body = '') {
  write(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n${body}\n`);
}

// A consistent fixture: vendored skills in three buckets plus the excluded ones,
// an ask-matt that routes to two of them, an INTEGRATION.md covering all of them
// plus one external skill installed under a fake home.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matt-test-'));
  const vendor = path.join(root, 'vendor/mattpocock-skills/skills');
  skill(path.join(vendor, 'engineering'), 'ask-matt', 'Start with `/tdd`, then `/to-spec`, then `/clear`.');
  skill(path.join(vendor, 'engineering'), 'tdd');
  skill(path.join(vendor, 'engineering'), 'to-spec');
  skill(path.join(vendor, 'in-progress'), 'retro');
  skill(path.join(vendor, 'misc'), 'scaffold-exercises');
  skill(path.join(vendor, 'deprecated'), 'old-thing');
  const home = path.join(root, 'home-skills');
  skill(home, 'research-stack');
  write(path.join(root, 'to-auto/INTEGRATION.md'), [
    '| Skill | Stage |', '|---|---|',
    '| ask-matt | 1 |', '| tdd | 7 |', '| `to-spec` | 5 |', '| retro (in-progress) | 10 |',
    '', '| Skill | Source |', '|---|---|', '| research-stack | external |', '',
  ].join('\n'));
  return { root, homes: [home] };
}

test('scanVendor finds promoted buckets and skips misc and deprecated', () => {
  const { root } = fixture();
  assert.deepEqual([...scanVendor(root).keys()].sort(), ['ask-matt', 'retro', 'tdd', 'to-spec']);
});

test('link creates relative symlinks and prunes stale ones', () => {
  const { root } = fixture();
  fs.mkdirSync(path.join(root, 'matt'));
  fs.symlinkSync('../vendor/gone', path.join(root, 'matt/gone'));
  const result = link(root);
  assert.deepEqual(result.removed, ['gone']);
  const target = fs.readlinkSync(path.join(root, 'matt/tdd'));
  assert.equal(target, '../vendor/mattpocock-skills/skills/engineering/tdd');
  assert.ok(fs.existsSync(path.join(root, 'matt/tdd/SKILL.md')));
});

test('resolve prefers the pinned vendor copy, then installed homes, else throws', () => {
  const { root, homes } = fixture();
  link(root);
  skill(homes[0], 'tdd', 'a drifted local copy');
  assert.equal(resolve(root, 'tdd', { homes }), fs.realpathSync(path.join(root, 'vendor/mattpocock-skills/skills/engineering/tdd/SKILL.md')));
  assert.equal(resolve(root, 'research-stack', { homes }), path.join(homes[0], 'research-stack/SKILL.md'));
  assert.throws(() => resolve(root, 'nope', { homes }), /nope/);
});

test('check passes on a consistent fixture and reports drift as info only', () => {
  const { root, homes } = fixture();
  link(root);
  skill(homes[0], 'tdd', 'a drifted local copy');
  const { errors, info } = check(root, { homes });
  assert.deepEqual(errors, []);
  assert.ok(info.some((line) => line.includes('drift') && line.includes('tdd')));
});

test('check fails on a missing link and a dangling link', () => {
  const { root, homes } = fixture();
  link(root);
  fs.unlinkSync(path.join(root, 'matt/retro'));
  fs.symlinkSync('../vendor/nowhere', path.join(root, 'matt/ghost'));
  const { errors } = check(root, { homes });
  assert.ok(errors.some((e) => e.includes('retro')), errors.join('\n'));
  assert.ok(errors.some((e) => e.includes('ghost')), errors.join('\n'));
});

test('check fails when a vendored skill has no INTEGRATION.md row', () => {
  const { root, homes } = fixture();
  skill(path.join(root, 'vendor/mattpocock-skills/skills/in-progress'), 'pr');
  link(root);
  const { errors } = check(root, { homes });
  assert.ok(errors.some((e) => e.includes('pr') && e.includes('INTEGRATION')), errors.join('\n'));
});

test('check fails when ask-matt routes to a skill that is not linked', () => {
  const { root, homes } = fixture();
  const askMatt = path.join(root, 'vendor/mattpocock-skills/skills/engineering/ask-matt/SKILL.md');
  fs.appendFileSync(askMatt, 'Then `/scaffold-exercises`.\n');
  link(root);
  const { errors } = check(root, { homes });
  assert.ok(errors.some((e) => e.includes('ask-matt') && e.includes('scaffold-exercises')), errors.join('\n'));
});

test('check reports a row that is neither vendored nor installed as missing, not as a wiring error', () => {
  const { root, homes } = fixture();
  fs.appendFileSync(path.join(root, 'to-auto/INTEGRATION.md'), '| Skill | x |\n|---|---|\n| phantom | y |\n');
  link(root);
  const { errors, missing } = check(root, { homes });
  assert.deepEqual(errors, []);
  assert.ok(missing.some((m) => m.includes('phantom')), missing.join('\n'));
  assert.equal(check(root, { homes: [] }).missing.length, 2); // research-stack is gone too
});

test('this repo: matt/ is in sync with the pin and every vendored skill is integrated', () => {
  // No skill homes: the repo's own wiring must hold on a machine with nothing installed (CI).
  const { errors } = check(REPO, { homes: [] });
  assert.deepEqual(errors, []);
});

test('check and link ignore dotfiles such as .DS_Store in matt/', () => {
  const { root, homes } = fixture();
  link(root);
  fs.writeFileSync(path.join(root, 'matt/.DS_Store'), '');
  assert.deepEqual(check(root, { homes }).errors, []);
  assert.deepEqual(link(root).removed, []);
});
