'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareSharedSkills, skillLocations } = require('../../src/lib/shared-skills');

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-shared-skills-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('creates one shared library and links it into Claude and Kiro skill roots', (t) => {
  const home = tempHome(t);
  const roots = prepareSharedSkills({ fs, home, platform: process.platform });
  fs.mkdirSync(path.join(roots.shared, 'husk-release'));
  fs.writeFileSync(path.join(roots.shared, 'husk-release', 'SKILL.md'), 'release steps');
  prepareSharedSkills({ fs, home, platform: process.platform });

  for (const nativeRoot of [roots.claude, roots.kiro]) {
    const linkedSkill = path.join(nativeRoot, 'husk-release');
    assert.equal(fs.realpathSync(linkedSkill), fs.realpathSync(path.join(roots.shared, 'husk-release')));
    assert.equal(fs.readFileSync(path.join(linkedSkill, 'SKILL.md'), 'utf8'), 'release steps');
  }
});

test('moves an existing Claude skills directory into the shared library without losing files', (t) => {
  const home = tempHome(t);
  const roots = skillLocations(home);
  fs.mkdirSync(path.join(roots.claude, 'security'), { recursive: true });
  fs.writeFileSync(path.join(roots.claude, 'security', 'SKILL.md'), 'security review');

  prepareSharedSkills({ fs, home, platform: process.platform });

  assert.equal(fs.readFileSync(path.join(roots.shared, 'security', 'SKILL.md'), 'utf8'), 'security review');
  assert.equal(fs.realpathSync(path.join(roots.claude, 'security')), fs.realpathSync(path.join(roots.shared, 'security')));
  assert.equal(fs.realpathSync(path.join(roots.kiro, 'security')), fs.realpathSync(path.join(roots.shared, 'security')));
});

test('keeps existing skills intact and links non-conflicting legacy Claude skills', (t) => {
  const home = tempHome(t);
  const roots = skillLocations(home);
  fs.mkdirSync(path.join(roots.shared, 'same-name'), { recursive: true });
  fs.writeFileSync(path.join(roots.shared, 'same-name', 'SKILL.md'), 'shared copy');
  fs.mkdirSync(path.join(roots.claude, 'same-name'), { recursive: true });
  fs.writeFileSync(path.join(roots.claude, 'same-name', 'SKILL.md'), 'Claude copy');
  fs.mkdirSync(path.join(roots.claude, 'old-skill'), { recursive: true });
  fs.writeFileSync(path.join(roots.claude, 'old-skill', 'SKILL.md'), 'legacy copy');

  prepareSharedSkills({ fs, home, platform: process.platform });

  assert.equal(fs.readFileSync(path.join(roots.shared, 'same-name', 'SKILL.md'), 'utf8'), 'shared copy');
  assert.equal(fs.readFileSync(path.join(roots.shared, 'old-skill', 'SKILL.md'), 'utf8'), 'legacy copy');
  assert.equal(fs.realpathSync(path.join(roots.kiro, 'old-skill')), fs.realpathSync(path.join(roots.claude, 'old-skill')));
});

test('moves disabled skills outside native discovery roots', (t) => {
  const home = tempHome(t);
  const roots = skillLocations(home);
  fs.mkdirSync(path.join(roots.claude, '_disabled_old-skill'), { recursive: true });
  fs.writeFileSync(path.join(roots.claude, '_disabled_old-skill', 'SKILL.md'), 'disabled');

  prepareSharedSkills({ fs, home, platform: process.platform });

  const parked = path.join(home, '.config', 'husk', 'skills-disabled', '_disabled_old-skill', 'SKILL.md');
  assert.equal(fs.readFileSync(parked, 'utf8'), 'disabled');
  assert.equal(fs.existsSync(path.join(roots.claude, '_disabled_old-skill')), false);
  assert.equal(fs.existsSync(path.join(roots.shared, '_disabled_old-skill')), false);
});
