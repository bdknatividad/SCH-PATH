/**
 * Reconcile the seeded accounts' stored module grants.
 *
 * Background, because the failure is invisible without it: `buildAccessSnapshot()`
 * prefers a non-empty stored `accessibleModules` array over the role matrix. The
 * seeded accounts were originally given a hand-written array that duplicated
 * `rbac.definition.json`; the definition then moved on and the copy did not. The
 * seed now writes `[]` for accounts it creates, but that never reached the rows
 * already in the database.
 *
 * Measured on production 2026-09-24: the `nurse` account carried Activities and
 * Reports it should not have had, and **could not reach Child Records at all** --
 * a functional break, not just an over-grant.
 *
 * The fix clears the stored array on the seeded accounts so the matrix decides.
 * The risk to guard is over-reach: an account an administrator created or
 * customised must keep its grant, which is why the UPDATE is scoped to the
 * `DEFAULT_USERS` names and nothing else.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pool } = require('../src/config/database');
const {
  reconcileSeededAccessGrants,
  DEFAULT_USERS,
} = require('../src/scripts/seedDatabase');

const REAL_QUERY = pool.query;

/** Run the reconciler against a stub pool and capture every statement issued. */
async function runWith(rows) {
  const issued = [];
  pool.query = async (sql, params) => {
    issued.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    if (/SELECT username, accessibleModules/i.test(sql)) return [rows, []];
    return [[], []];
  };
  try {
    await reconcileSeededAccessGrants();
  } finally {
    pool.query = REAL_QUERY;
  }
  return issued;
}

const SEEDED_USERNAMES = DEFAULT_USERS.map((u) => u.username);

test('a stale grant on a seeded account is cleared so the matrix decides', async () => {
  const issued = await runWith([
    // The production shape: nurse has the old hand-written array.
    { username: 'nurse', accessibleModules: ['Dashboard', 'Activities', 'Documents', 'Health', 'Reports'] },
    { username: 'educator', accessibleModules: ['Dashboard', 'Documents', 'Activities', 'Education'] },
  ]);

  const update = issued.find((i) => /UPDATE users SET accessibleModules/i.test(i.sql));
  assert.ok(update, 'a non-empty stored grant must be cleared');
  assert.match(
    update.sql,
    /JSON_ARRAY\(\)/,
    'the stored array must be emptied, not rewritten with a new copy of the matrix',
  );
});

test('the UPDATE is scoped to the seeded accounts and cannot reach anyone else', async () => {
  const issued = await runWith([
    { username: 'nurse', accessibleModules: ['Dashboard', 'Activities'] },
  ]);

  const update = issued.find((i) => /UPDATE users SET accessibleModules/i.test(i.sql));
  assert.ok(update, 'expected the UPDATE');

  // This is the assertion that matters. An administrator's own account must not
  // be caught by the sweep -- SW-Aldrin and badek123 are real accounts on the
  // live deployment that hold arrays too, and they are not the seed's to touch.
  assert.deepEqual(
    update.params,
    SEEDED_USERNAMES,
    'the reconciliation must only ever name the seeded accounts',
  );
  assert.ok(!update.params.includes('SW-Aldrin'), 'must not touch an admin-created account');
  assert.ok(!update.params.includes('badek123'), 'must not touch an admin-created account');
});

test('nothing is written when the seeded accounts already inherit the matrix', async () => {
  const issued = await runWith([
    { username: 'nurse', accessibleModules: [] },
    { username: 'educator', accessibleModules: [] },
    { username: 'centerhead', accessibleModules: null },
    // A legacy TEXT column can still carry the JSON as a string.
    { username: 'HP 1', accessibleModules: '[]' },
  ]);

  const update = issued.find((i) => /UPDATE users SET accessibleModules/i.test(i.sql));
  assert.equal(update, undefined, 'an already-correct database must not be rewritten on every boot');
});

test('a legacy string-encoded array is treated as stale, not as empty', async () => {
  // mysql2 parses JSON columns, but an older deployment stored the value as
  // TEXT. Treating '["Dashboard"]' as empty would leave that drift in place.
  const issued = await runWith([
    { username: 'nurse', accessibleModules: '["Dashboard","Activities"]' },
  ]);
  const update = issued.find((i) => /UPDATE users SET accessibleModules/i.test(i.sql));
  assert.ok(update, 'a non-empty string-encoded array is stale and must be cleared');
});

test('the seed actually calls the reconciliation', async () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'scripts', 'seedDatabase.js'),
    'utf8',
  );
  assert.match(
    src,
    /await reconcileSeededAccessGrants\(\)/,
    'seedDatabase must reconcile the seeded grants, or existing rows keep the drift forever',
  );
});
