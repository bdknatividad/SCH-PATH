/**
 * Regression guard for the Assigned Houseparent list on Admission Slip Part 2.
 *
 * Reported bug: a Houseparent account created through Account Management did
 * not appear in the "Assigned Houseparent" dropdown during Children Intake →
 * Admission Slip Part 2, so a newly created Houseparent could never be
 * assigned to a resident.
 *
 * There were two hardcoded mechanisms, and both had to go:
 *
 *   1. GET /resident-assignments/caseload filtered the user table through
 *      `/^HP\s*(?:[1-9]|10)$/i`, so only accounts literally named "HP 1"…"HP 10"
 *      ever became a card. A Houseparent called "maria.santos" was invisible.
 *   2. seedDatabase() forced every houseparent-role account outside that same
 *      ten-name list to status = 'Inactive', so even a correctly configured
 *      Houseparent disappeared on the next seed.
 *
 * The rule is now: an account is a Houseparent because `role` says so and it is
 * Active. Nothing about the username matters.
 *
 * The database is a small in-memory store rather than a stub returning empty
 * sets, because a stub that always answers `[]` cannot tell the difference
 * between "the list works" and "the list is empty for the wrong reason" — which
 * is precisely the reported symptom.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DB_MODULE_PATH = require.resolve('../src/config/database');
const NOTIFY_MODULE_PATH = require.resolve('../src/services/notificationService');

// ── THE PEOPLE ──────────────────────────────────────────────────────────────

/** The account the operator just created through Account Management. */
const NEW_HP = { id: 'U-NEW', username: 'maria.santos', role: 'houseparent', status: 'Active', displayName: 'Maria Santos' };
/** A Houseparent whose role was stored with a legacy spelling. */
const LEGACY_HP = { id: 'U-LEG', username: 'jose.reyes', role: 'house_parent', status: 'Active', displayName: 'Jose Reyes' };
/** One of the ten seeded starter accounts. */
const SEEDED_HP = { id: 'UHP01', username: 'HP 1', role: 'houseparent', status: 'Active', displayName: null };
/** Deactivated on purpose — must not be assignable. */
const INACTIVE_HP = { id: 'U-OFF', username: 'ana.cruz', role: 'houseparent', status: 'Inactive', displayName: 'Ana Cruz' };
/** Right status, wrong role. */
const NURSE = { id: 'U-NUR', username: 'nurse.one', role: 'nurse', status: 'Active', displayName: 'Nurse One' };
const CENTER_HEAD = { id: 'U-CH', username: 'centerhead', role: 'centerhead', status: 'Active', displayName: 'Center Head' };

const USERS = [NEW_HP, LEGACY_HP, SEEDED_HP, INACTIVE_HP, NURSE, CENTER_HEAD];

/**
 * One existing assignment, written before any of this changed. It must survive
 * untouched: the fix may not rewrite or drop existing assignments.
 */
const RESIDENTS = [
  { id: 'CH001', name: 'Juan Dela Cruz' },
  { id: 'CH002', name: 'Pedro Reyes' },
];
const ASSIGNMENTS = [
  { userId: 'UHP01', residentId: 'CH001', residentName: 'Juan Dela Cruz' },
];

// ── THE STORE ───────────────────────────────────────────────────────────────

const store = {
  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    const args = Array.isArray(params) ? params : [];
    const unhandled = () => { throw new Error(`UNHANDLED SQL: ${text}`); };

    // getUserLabelColumn()
    if (/^SELECT COLUMN_NAME FROM INFORMATION_SCHEMA\.COLUMNS/i.test(text)) {
      return [[
        { COLUMN_NAME: 'id' },
        { COLUMN_NAME: 'username' },
        { COLUMN_NAME: 'displayName' },
      ], []];
    }

    // activeHouseparents()
    if (/^SELECT u\.id, u\.username, u\.role, u\.status, u\.displayName AS displayLabel FROM users u WHERE u\.status = 'Active'/i.test(text)) {
      const active = USERS
        .filter((u) => u.status === 'Active')
        .map((u) => ({ id: u.id, username: u.username, role: u.role, status: u.status, displayLabel: u.displayName }));
      return [active, []];
    }

    // getCaseload() — explicit assignment rows
    if (/^SELECT COALESCE\(ra\.userId, s\.userId\)/i.test(text)) {
      return [ASSIGNMENTS.map((a) => ({
        userId: a.userId,
        residentId: a.residentId,
        residentName: RESIDENTS.find((r) => r.id === a.residentId)?.name || a.residentName,
      })), []];
    }

    // getCaseload() — legacy admissions.houseparentOnDuty fallback
    if (/^SELECT u\.id AS userId, c\.id AS residentId, c\.name AS residentName FROM users u/i.test(text)) {
      return [[], []];
    }

    void args;
    return unhandled();
  },
};

require.cache[DB_MODULE_PATH] = {
  id: DB_MODULE_PATH,
  filename: DB_MODULE_PATH,
  loaded: true,
  exports: { pool: store, dbConfig: {}, testConnection: async () => true },
};
require.cache[NOTIFY_MODULE_PATH] = {
  id: NOTIFY_MODULE_PATH,
  filename: NOTIFY_MODULE_PATH,
  loaded: true,
  exports: { notify: async () => ({}), notifyUsers: async () => ([]) },
};

const { activeHouseparents, getCaseload } = require('../src/controllers/assignmentController');

// ── HELPERS ─────────────────────────────────────────────────────────────────

/** Drive getCaseload() the way the route does, and return what it answered. */
async function caseloadAs(user) {
  let payload = null;
  let failure = null;
  await getCaseload(
    { user },
    { json: (body) => { payload = body; } },
    (error) => { failure = error; }
  );
  return { payload, failure };
}

const labelsOf = (payload) => (payload?.data || []).map((card) => card.username);

// ── THE ROSTER RULE ─────────────────────────────────────────────────────────

test('a Houseparent created through Account Management is listed, whatever its username', async () => {
  const names = (await activeHouseparents()).map((u) => u.username);
  assert.ok(
    names.includes('maria.santos'),
    `the newly created Houseparent is missing from the roster — got [${names.join(', ')}]. `
    + 'This is the reported bug: the Assigned Houseparent dropdown is populated from this list.'
  );
});

test('the roster is every Active Houseparent-role account, and nothing else', async () => {
  const names = (await activeHouseparents()).map((u) => u.username);
  assert.deepEqual(
    names.slice().sort(),
    ['HP 1', 'jose.reyes', 'maria.santos'],
    'the roster must be exactly the active Houseparent-role accounts'
  );
});

test('an inactive Houseparent cannot be assigned', async () => {
  const names = (await activeHouseparents()).map((u) => u.username);
  assert.ok(!names.includes('ana.cruz'), 'a deactivated Houseparent must not be offered in the dropdown');
});

test('a non-Houseparent role is never offered as a Houseparent', async () => {
  const names = (await activeHouseparents()).map((u) => u.username);
  assert.ok(!names.includes('nurse.one'), 'a Nurse must not appear in the Houseparent roster');
  assert.ok(!names.includes('centerhead'), 'a Center Head must not appear in the Houseparent roster');
});

test('a legacy role spelling still counts as a Houseparent', async () => {
  const names = (await activeHouseparents()).map((u) => u.username);
  assert.ok(names.includes('jose.reyes'), 'role "house_parent" must still be recognised as a Houseparent');
});

test('the roster is sorted naturally, so HP 2 precedes HP 10', async () => {
  const source = require('node:fs').readFileSync(
    path.resolve(__dirname, '../src/controllers/assignmentController.js'),
    'utf8'
  );
  const from = source.indexOf('async function activeHouseparents');
  const body = source.slice(from, source.indexOf('async function getCaseload', from));
  assert.ok(/numeric: true/.test(body), 'the roster sort must be numeric, or "HP 10" sorts before "HP 2"');
});

// ── WHAT THE DROPDOWN ACTUALLY RECEIVES ─────────────────────────────────────

test('a manager receives one card per active Houseparent, including the new account', async () => {
  const { payload, failure } = await caseloadAs(CENTER_HEAD);
  assert.equal(failure, null, `getCaseload failed: ${failure?.message}`);
  assert.deepEqual(labelsOf(payload).slice().sort(), ['HP 1', 'jose.reyes', 'maria.santos']);
});

test('the new Houseparent arrives with an empty caseload and room to take a resident', async () => {
  const { payload } = await caseloadAs(CENTER_HEAD);
  const card = (payload.data || []).find((entry) => entry.username === 'maria.santos');
  assert.ok(card, 'the newly created Houseparent has no card');
  assert.equal(card.assignedCount, 0, 'a brand new Houseparent starts with no residents');
  assert.ok(card.availableSlots > 0, 'a brand new Houseparent must not be shown as full');
  assert.ok(card.userId, 'the card must carry the id the admission form writes as assignedHouseparentId');
  assert.equal(card.label, 'Maria Santos', 'the dropdown label comes from the display name');
});

test('existing assignments still resolve, and only against their own Houseparent', async () => {
  const { payload } = await caseloadAs(CENTER_HEAD);
  const seeded = (payload.data || []).find((entry) => entry.username === 'HP 1');
  const fresh = (payload.data || []).find((entry) => entry.username === 'maria.santos');

  assert.deepEqual(seeded.residents, [{ id: 'CH001', name: 'Juan Dela Cruz' }],
    'the pre-existing assignment must be untouched');
  assert.deepEqual(fresh.residents, [], 'assignments must not be copied onto the new Houseparent');
});

test('a Houseparent sees the same roster, including their own card', async () => {
  // TRI's "My Caseload" and the TRI/Anecdotal resident pickers look the caller's
  // own card up by id or username in this response. If the roster were filtered
  // by a username pattern, a Houseparent called "maria.santos" would find
  // nothing and every one of those pickers would silently render empty.
  const { payload } = await caseloadAs(NEW_HP);
  const card = (payload.data || []).find((entry) => entry.userId === NEW_HP.id);
  assert.ok(card, 'a Houseparent must always find their own card in their own caseload response');
  assert.equal(card.username, 'maria.santos');
});

test('a role that cannot manage assignments is still refused', async () => {
  const { payload, failure } = await caseloadAs(NURSE);
  assert.equal(payload, null, 'a Nurse must not receive the caseload roster');
  assert.equal(failure?.statusCode ?? failure?.status, 403, 'a Nurse must be refused with 403');
});
