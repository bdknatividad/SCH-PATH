/**
 * The seeded accounts must inherit their role's matrix, not carry a copy of it.
 *
 * `buildAccessSnapshot()` prefers a non-empty stored `accessibleModules` over the
 * role definition, so a hand-written grant in the seed silently overrides the
 * matrix. That is exactly what happened: the Social Worker lost Activities and
 * Assessments, the Nurse gained Reports (which its specification forbids) and
 * both the Nurse and the Educator lost Child Records.
 *
 * These tests make the definition the single source of truth and fail if the
 * seed starts carrying a grant of its own again.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_USERS } = require('../src/scripts/seedDatabase');
const rbac = require('../src/config/rbac');

const definition = require('../src/config/rbac.definition.json');

const declaredModules = (role) => {
  const entry = definition.roles[role];
  if (!entry) return null;
  if (entry.modules === '*') return definition.modules.map((module) => module.key);
  return entry.modules;
};

test('no seeded account pins its own module grant', () => {
  for (const user of DEFAULT_USERS) {
    const grant = user.accessibleModules;
    const empty = grant === undefined || (Array.isArray(grant) && grant.length === 0);
    assert.ok(
      empty,
      `seed user ${user.id} (${user.username}) pins accessibleModules=${JSON.stringify(grant)}. ` +
        'Drop it and let the account inherit the role matrix — a stored copy drifts silently, ' +
        'because buildAccessSnapshot() prefers it over the definition.',
    );
  }
});

test('every seeded role exists in the RBAC definition', () => {
  for (const user of DEFAULT_USERS) {
    assert.ok(
      definition.roles[user.role],
      `seed user ${user.id} has role "${user.role}" which the RBAC definition does not declare`,
    );
  }
});

test('an empty grant resolves to exactly the role matrix, for every seeded role', () => {
  for (const user of DEFAULT_USERS) {
    const expected = declaredModules(user.role);
    const snapshot = rbac.buildAccessSnapshot({
      role: user.role,
      accessibleModules: [],
      childRecordTabs: [],
      subModules: {},
    });

    if (definition.roles[user.role].fullAccess) {
      // A full-access role is handed every module *plus* the legacy alias keys
      // (`TRI`, `Intervention Tracker`) so older stored grants still resolve.
      // Assert the superset, not equality.
      for (const module of expected) {
        assert.ok(
          snapshot.modules.includes(module),
          `seeded ${user.username} (${user.role}) is missing declared module "${module}"`,
        );
      }
      continue;
    }

    assert.deepEqual(
      [...snapshot.modules].sort(),
      [...expected].sort(),
      `seeded ${user.username} (${user.role}) would not receive its declared modules`,
    );
  }
});

test('the Nurse role does not reach Reports, per its specification', () => {
  // The specific regression the seed caused: U004 was seeded with Reports.
  const nurse = DEFAULT_USERS.find((user) => user.username === 'nurse');
  assert.ok(nurse, 'the seeded nurse account is gone');

  const snapshot = rbac.buildAccessSnapshot({
    role: nurse.role,
    accessibleModules: nurse.accessibleModules || [],
    childRecordTabs: [],
    subModules: {},
  });
  assert.ok(
    !snapshot.modules.includes('Reports'),
    'the Nurse must not hold Reports — see the role boundary in DEPLOY-CHECKLIST §9.7',
  );
});

test('the Social Worker reaches the Houseparent/TRI workflow through the definition', () => {
  // The seed used to hard-code the pre-rename `TRI` key for this role. The module
  // is now `Houseparent` with `TRI` as a legacy alias, so inheriting must still
  // expose it — otherwise the TRI review workflow becomes unreachable.
  const socialWorker = DEFAULT_USERS.find((user) => user.username === 'socialworker');
  assert.ok(socialWorker, 'the seeded social worker account is gone');

  const snapshot = rbac.buildAccessSnapshot({
    role: socialWorker.role,
    accessibleModules: socialWorker.accessibleModules || [],
    childRecordTabs: [],
    subModules: {},
  });
  assert.ok(
    snapshot.modules.includes('Houseparent'),
    'the Social Worker must hold Houseparent (the module TRI was renamed to)',
  );
  assert.ok(
    snapshot.modules.includes('Activities') && snapshot.modules.includes('Assessments'),
    'the Social Worker must hold Activities and Assessments — the seed previously withheld both',
  );
});

test('the seed module names are all real module keys', () => {
  const keys = new Set(definition.modules.map((module) => module.key));
  for (const user of DEFAULT_USERS) {
    for (const module of user.accessibleModules || []) {
      assert.ok(keys.has(module), `seed user ${user.id} names unknown module "${module}"`);
    }
  }
});
