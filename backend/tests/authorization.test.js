const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRole,
  hasRole,
  isManager,
  isHouseparent,
  isSupportedRole,
} = require('../src/utils/authorization');
const { USER_ROLES } = require('../src/utils/constants');

test('role aliases normalize to canonical backend roles', () => {
  assert.equal(normalizeRole(' Center Head '), 'centerhead');
  assert.equal(normalizeRole('SOCIAL WORKER'), 'socialworker');
  assert.equal(normalizeRole('house_parent'), 'houseparent');
});

test('role predicates are case and whitespace insensitive', () => {
  assert.equal(hasRole({ role: ' CENTER HEAD ' }, 'centerhead'), true);
  assert.equal(isManager({ role: 'social worker' }), true);
  assert.equal(isHouseparent({ role: 'HOUSEPARENT' }), true);
  assert.equal(isManager({ role: 'educator' }), false);
});

test('supported roles include explicitly elevated admin and houseparent roles', () => {
  assert.equal(isSupportedRole(' admin ', USER_ROLES), true);
  assert.equal(isSupportedRole('center head', USER_ROLES), true);
  assert.equal(isSupportedRole('unknown-role', USER_ROLES), false);
});
