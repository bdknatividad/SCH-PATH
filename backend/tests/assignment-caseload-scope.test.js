/**
 * Case Load access-scope tests.
 *
 * Houseparents receive only their own Case Load card and assigned residents.
 * Managers keep the facility-wide Houseparent overview. Resident-level access
 * is independently enforced by canAccessResident(), including direct API calls.
 *
 * The roster itself is derived from the `role` column — see
 * admission-houseparent-list.test.js for the behavioural half of that rule.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { caseloadScope, canManage } = require('../src/controllers/assignmentController');

test('every Houseparent account receives only its own Case Load scope', () => {
  for (let n = 1; n <= 10; n += 1) {
    const userId = `UHP${String(n).padStart(2, '0')}`;
    const username = `HP ${n}`;
    const scope = caseloadScope({ id: userId, username, role: 'houseparent' });
    assert.deepEqual(scope, { kind: 'self', userId }, `${username} must see only its own roster`);
  }
});

test('Houseparent role spelling variants all receive a self scope', () => {
  for (const role of ['houseparent', 'Houseparent', 'HOUSEPARENT', 'house_parent', 'house parent', ' House Parent ']) {
    const scope = caseloadScope({ id: 'UHP02', username: 'HP 2', role });
    assert.deepEqual(scope, { kind: 'self', userId: 'UHP02' }, `role ${JSON.stringify(role)} must be self-scoped`);
  }
});

test('managers keep the facility-wide view', () => {
  for (const role of ['centerhead', 'center_head', 'center head', 'socialworker', 'social_worker', 'admin']) {
    assert.deepEqual(caseloadScope({ id: 'U001', role }), { kind: 'all', userId: null }, `role ${role} should see everyone`);
    assert.equal(canManage({ role }), true, `${role} should be a manager`);
  }
});

test('administrator is not a manager on the backend', () => {
  assert.equal(canManage({ role: 'administrator' }), false);
  assert.equal(caseloadScope({ role: 'administrator' }).kind, 'denied');
});

test('every other role is refused', () => {
  for (const role of ['nurse', 'psychologist', 'educator', 'staff', '', undefined, 'user']) {
    assert.equal(caseloadScope({ id: 'U004', role }).kind, 'denied', `role ${JSON.stringify(role)} should be denied`);
  }
  assert.equal(caseloadScope(null).kind, 'denied');
  assert.equal(caseloadScope(undefined).kind, 'denied');
  assert.equal(caseloadScope({}).kind, 'denied');
});

test('a Houseparent without an id receives a self scope with a null userId', () => {
  const scope = caseloadScope({ role: 'houseparent' });
  assert.deepEqual(scope, { kind: 'self', userId: null });
});

test('getCaseload uses the overview scope and derives its cards from the Houseparent role', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/assignmentController.js'), 'utf8');
  // The roster rule lives in activeHouseparents(), which getCaseload() calls.
  // Slice both so the assertions cover the whole rule, not just its call site.
  const from = source.indexOf('async function activeHouseparents');
  assert.ok(from >= 0, 'activeHouseparents() is missing');
  const body = source.slice(from, source.indexOf('module.exports', from));

  assert.ok(/caseloadScope\(req\.user\)/.test(body), 'getCaseload must derive its scope from caseloadScope()');
  assert.ok(/scope\.kind === 'denied'/.test(body), 'getCaseload must refuse a denied scope');
  assert.ok(/u\.status = 'Active'/.test(body), 'inactive accounts must be filtered out of the roster');
  assert.ok(
    /normalizeRole\(u\.role\) === 'houseparent'/.test(body),
    'the roster must be selected by role, not by the account name'
  );
  assert.ok(
    !/\^HP/.test(body),
    'the roster must not be filtered by a hardcoded "HP 1"–"HP 10" username pattern — that is what hid '
    + 'newly created Houseparent accounts from the Assigned Houseparent dropdown'
  );
  assert.ok(
    /LOWER\(TRIM\(ra\.assignmentType\)\) = 'houseparent'/.test(body),
    'resident names must come from active Houseparent assignments'
  );
});

test('the Houseparent roster no longer depends on a username pattern', () => {
  // Guards the reported defect directly: any `HP <n>` regex anywhere in the
  // controller means an account created through Account Management can be
  // filtered out of the assignment dropdown again.
  const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/assignmentController.js'), 'utf8');
  assert.ok(
    !/\[\s*1-9\s*\]\s*\|\s*10/.test(source),
    'a "HP 1–HP 10" style username pattern is back in assignmentController.js'
  );
  assert.ok(
    !/isCanonicalHP/.test(source),
    'the isCanonicalHP username filter is back in assignmentController.js'
  );
});

test('the seed script no longer deactivates Houseparents outside a fixed username list', () => {
  // The second half of the same defect: seeding forced every houseparent-role
  // account whose username was not "HP 1"…"HP 10" to Inactive, so a Houseparent
  // created through Account Management disappeared on the next seed even though
  // the operator had set it Active.
  const source = fs.readFileSync(path.resolve(__dirname, '../src/scripts/seedDatabase.js'), 'utf8');
  assert.ok(
    !/ALLOWED_HOUSEPARENT_USERNAMES/.test(source),
    'the Houseparent username whitelist is back in seedDatabase.js'
  );
  assert.ok(
    !/UPDATE users SET status = 'Inactive' WHERE role = 'houseparent'/.test(source),
    'seeding must not deactivate Houseparent accounts by username'
  );
});
