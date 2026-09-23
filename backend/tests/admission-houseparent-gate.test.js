/**
 * Regression guard for the admission form's Houseparent dropdown.
 *
 * Reported bug: a Social Worker adding a resident reached Admission Part 2,
 * opened the "Houseparent on Duty" dropdown, and got
 * "No active Houseparent accounts found."
 *
 * Root cause was not permissions and not data: GET /resident-assignments/caseload
 * already answers 200 with the full list for a Social Worker (the controller uses
 * authorization.isManager, which accepts centerhead/admin/socialworker). The
 * frontend simply never called it, because the loading effect was gated on
 * `isCenterHead = ['centerhead','admin']`. With no fetch, `houseparents` stayed
 * empty and the empty-state text rendered.
 *
 * These tests read the source rather than run it, because the regression is a
 * one-word change that type-checks, builds, and is invisible without a browser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isManager } = require('../src/utils/authorization');

const COMPONENTS = path.resolve(__dirname, '../../frontend/src/app/components');
const CHILD_RECORDS = path.join(COMPONENTS, 'ChildRecords.tsx');
const HOUSEPARENT_ASSIGNMENT = path.join(COMPONENTS, 'HouseparentAssignment.tsx');
const CASELOAD_URL = '/resident-assignments/caseload';

/** Every role the app can authenticate as, including the long spelling. */
const KNOWN_ROLES = [
  'centerhead',
  'admin',
  'administrator',
  'socialworker',
  'houseparent',
  'nurse',
  'psychologist',
  'educator',
];

/**
 * Pull the role list out of `const canAssignHouseparent = [...].includes(`.
 * Handles both the one-line and the wrapped formatting used in this repo.
 */
function gateRoles(file) {
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/const\s+canAssignHouseparent\s*=\s*\[([\s\S]*?)\]\s*\.includes\(/);
  assert.ok(match, `canAssignHouseparent gate not found in ${path.basename(file)}`);
  return match[1]
    .split(',')
    .map((role) => role.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/** The roles the backend actually authorises for assignment management. */
function backendManagerRoles() {
  return KNOWN_ROLES.filter((role) => isManager({ role }));
}

test('the backend really does authorise a Social Worker to manage assignments', () => {
  // If this ever fails, the frontend fix is wrong and must be reverted instead.
  assert.equal(isManager({ role: 'socialworker' }), true,
    'isManager must accept socialworker — the admission dropdown fix depends on it');
  assert.equal(isManager({ role: 'centerhead' }), true);
  assert.equal(isManager({ role: 'admin' }), true);
  assert.equal(isManager({ role: 'houseparent' }), false);
});

test('a Social Worker can load the Houseparent list in the admission form', () => {
  const roles = gateRoles(CHILD_RECORDS);
  assert.ok(roles.includes('socialworker'),
    `the admission form gate is [${roles.join(', ')}] — a Social Worker is excluded, `
    + 'so the dropdown falls through to "No active Houseparent accounts found."');
  assert.ok(roles.includes('centerhead') && roles.includes('admin'),
    'the fix must not remove the roles that already worked');
});

test('the admission gate matches the backend authorisation exactly', () => {
  // The frontend must not offer what the backend refuses (403 on submit), and
  // must not hide what the backend allows (the reported bug). Keep them equal:
  // if a role is added to isManager, add it here too, and vice versa.
  const frontend = [...new Set(gateRoles(CHILD_RECORDS))].sort();
  const backend = [...new Set(backendManagerRoles())].sort();
  assert.deepEqual(frontend, backend,
    'the frontend Houseparent-assignment gate and authorization.isManager have drifted apart');
});

test('the admission form actually gates its caseload fetch on that gate', () => {
  const source = fs.readFileSync(CHILD_RECORDS, 'utf8');

  const at = source.indexOf(`'${CASELOAD_URL}'`);
  assert.ok(at > 0, 'ChildRecords.tsx no longer fetches the caseload list');

  // Walk back to the effect that owns this request and inspect the guard.
  const effect = source.slice(source.lastIndexOf('useEffect(', at), at);
  assert.match(effect, /if\s*\(\s*!isFormOpen\s*\|\|\s*!canAssignHouseparent\s*\)\s*\{\s*return;/,
    'the caseload fetch must be skipped only when the form is closed or the role cannot assign');
  assert.ok(!/isCenterHead/.test(effect),
    'the caseload fetch is still gated on a Center-Head-only check');

  // A stale dependency array would keep the old closure and never re-run.
  const tail = source.slice(at, at + 900);
  assert.match(tail, /\},\s*\[\s*isFormOpen\s*,\s*canAssignHouseparent\s*,?\s*\]\s*\)/,
    'the caseload effect must depend on canAssignHouseparent, not on the removed flag');
});

test('no caseload consumer hides the Houseparent list from a Social Worker', () => {
  const consumers = ['ChildRecords.tsx', 'HouseparentAssignment.tsx', 'CaseLoad.tsx', 'Tri.tsx'];

  for (const name of consumers) {
    const file = path.join(COMPONENTS, name);
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes(CASELOAD_URL), `${name} is no longer a caseload consumer`);

    // Either the file has no role gate at all (CaseLoad, Tri) or it must use the
    // shared gate. A bare two-role Center-Head check is the original defect.
    const hasBareGate = /\[\s*'centerhead'\s*,\s*'admin'\s*\]/.test(source);
    assert.ok(!hasBareGate,
      `${name} still gates on ['centerhead', 'admin'], which excludes Social Workers`);

    if (source.includes('canAssignHouseparent')) {
      const roles = gateRoles(file);
      assert.ok(roles.includes('socialworker'), `${name}: gate is [${roles.join(', ')}]`);
    }
  }
});

test('the dead HouseparentAssignment component was corrected too', () => {
  // This component is currently not imported anywhere. It is fixed so that
  // wiring it up later cannot resurrect the same empty-dropdown bug.
  const source = fs.readFileSync(HOUSEPARENT_ASSIGNMENT, 'utf8');
  assert.ok(!/isCenterHead/.test(source),
    'HouseparentAssignment.tsx still uses the Center-Head-only flag');
  assert.ok(gateRoles(HOUSEPARENT_ASSIGNMENT).includes('socialworker'));
});

test('the login endpoint normalises the role, so no alias spelling can leak through', () => {
  // userController.login returns normalizeRole(user.role), which is why the
  // bare 'socialworker' comparison is sufficient and 'social_worker' is not needed.
  const controller = fs.readFileSync(
    path.resolve(__dirname, '../src/controllers/userController.js'),
    'utf8'
  );
  assert.match(controller, /role:\s*normalizeRole\(\s*user\.role\s*\)/,
    'the login response must return a normalised role for the frontend gate to be reliable');
});
