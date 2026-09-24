/**
 * The boot migration that repairs empty access rows must not carry its own copy
 * of the role matrix.
 *
 * It used to. `roleModuleDefaults` in `server.js` was a third hand-written copy
 * of `rbac.definition.json`, and it drifted exactly as the other copies did:
 *
 *   nurse     written  Dashboard, Activities, Documents, Health, Reports
 *             actual   Dashboard, Child Records, Health, Documents
 *   educator  written  Dashboard, Documents, Activities, Education
 *             actual   Dashboard, Child Records, Education, Documents
 *
 * So the migration granted a Nurse Activities and Reports it should not have, and
 * omitted Child Records — which meant a Nurse could not open a resident's record
 * at all. It also runs on every boot and repairs *empty* rows, so it kept
 * re-injecting the drift after anything cleared it. That is why the drift was
 * still live in production long after the seed was fixed.
 *
 * The migration now reads the modules from `getRoleDefinition`, so the two cannot
 * disagree. These tests pin that, because re-hardcoding the list is an easy and
 * entirely invisible mistake: nothing fails, some staff just quietly gain and
 * lose modules.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const definition = require('../src/config/rbac.definition.json');
const { getRoleDefinition } = require('../src/config/rbac');

const REPAIRED_ROLES = ['nurse', 'educator', 'houseparent'];

test('the boot migration derives its module list from the role definition', () => {
  assert.match(
    SERVER,
    /require\('\.\/config\/rbac'\)/,
    'server.js must import from config/rbac',
  );
  assert.match(
    SERVER,
    /getRoleDefinition/,
    'the migration must read the modules from getRoleDefinition',
  );
  assert.match(
    SERVER,
    /roleDefinition\?\.modules|roleDefinition\.modules/,
    'the modules must come off the role definition object',
  );
});

test('no hardcoded copy of the drifted matrix survives in server.js', () => {
  // The exact stale literals. If either comes back, the drift comes back with it.
  assert.doesNotMatch(
    SERVER,
    /nurse:\s*\[[^\]]*'Activities'[^\]]*'Reports'/,
    "the Nurse module list is hardcoded again — it must be derived from the definition",
  );
  assert.doesNotMatch(
    SERVER,
    /educator:\s*\[[^\]]*'Activities'/,
    "the Educator module list is hardcoded again — it must be derived from the definition",
  );
  assert.doesNotMatch(
    SERVER,
    /houseparent:\s*\[[^\]]*'Violations'/,
    "the Houseparent module list is hardcoded again — it must be derived from the definition",
  );
});

test('the definition still disagrees with the values that were hardcoded', () => {
  // Guards the premise. If someone ever *legitimately* grants the Nurse Activities
  // and Reports, this test should be revisited rather than silently deleted —
  // because at that point the old hardcoded list was right and the definition is
  // what changed.
  for (const role of REPAIRED_ROLES) {
    const modules = getRoleDefinition(role)?.modules || [];
    assert.ok(modules.length > 0, `${role} must declare modules`);
    assert.deepEqual(
      [...modules].sort(),
      [...(definition.roles[role].modules || [])].sort(),
      `${role} must read its modules from the definition`,
    );
  }

  assert.ok(
    !getRoleDefinition('nurse').modules.includes('Activities'),
    'the Nurse is not granted Activities by the definition',
  );
  assert.ok(
    getRoleDefinition('nurse').modules.includes('Child Records'),
    'the Nurse IS granted Child Records by the definition — losing it broke the role',
  );
  assert.ok(
    !getRoleDefinition('educator').modules.includes('Activities'),
    'the Educator is not granted Activities by the definition',
  );
  assert.ok(
    getRoleDefinition('educator').modules.includes('Child Records'),
    'the Educator IS granted Child Records by the definition',
  );
});
