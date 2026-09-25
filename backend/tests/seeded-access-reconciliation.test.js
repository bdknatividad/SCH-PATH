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

test('seedDatabase() actually reaches the reconciliation', async () => {
  // The test above calls the reconciler directly, which leaves the wiring
  // untested: if seedDatabase() never reached it, that test would still pass
  // while production stayed stale forever. This drives the real boot chain
  // against a stub pool that looks like production.
  const realQuery = pool.query;
  const realGetConnection = pool.getConnection;

  const USERS = {
    centerhead: [],
    socialworker: [],
    psychologist: [],
    nurse: ['Dashboard', 'Activities', 'Documents', 'Health', 'Reports'],
    educator: ['Dashboard', 'Documents', 'Activities', 'Education'],
  };
  let cleared = null;

  pool.query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/^SELECT id FROM users WHERE username = \?/i.test(s)) return [[{ id: 'U' }], []];
    if (/^SELECT password FROM users WHERE username = \?/i.test(s)) return [[{ password: '$2b$10$alreadyhashed' }], []];
    if (/role = 'houseparent' AND status = 'Active'/i.test(s)) return [[], []];
    if (/SELECT username, accessibleModules FROM users WHERE username IN/i.test(s)) {
      return [(params || []).filter((u) => u in USERS).map((u) => ({ username: u, accessibleModules: USERS[u] })), []];
    }
    if (/UPDATE users SET accessibleModules = JSON_ARRAY\(\)/i.test(s)) { cleared = params; return [{ affectedRows: 1 }, []]; }
    return [[], []];
  };
  pool.getConnection = async () => ({
    query: async () => [[], []],
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  });

  const { seedDatabase } = require('../src/scripts/seedDatabase');
  try {
    await seedDatabase();
  } finally {
    pool.query = realQuery;
    pool.getConnection = realGetConnection;
  }

  assert.ok(cleared, 'seedDatabase() never issued the reconciliation UPDATE');
  assert.ok(cleared.includes('nurse'), 'the drifted nurse account must be cleared');
  assert.ok(cleared.includes('educator'), 'the drifted educator account must be cleared');
});

/**
 * Drive the real seedDatabase() against a stub pool, recording what it issued.
 *
 * `overrides` lets a test shape the users table and force failures.
 */
async function driveSeed({ users = {}, missingUsernames = new Set(), idHolders = {}, throwOnInsert = false }) {
  const realQuery = pool.query;
  const realGetConnection = pool.getConnection;
  const log = { cleared: null, insertAttempts: [], consoleErrors: [], consoleLogs: [] };

  pool.query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();

    if (/^SELECT id FROM users WHERE username = \?/i.test(s)) {
      return [missingUsernames.has(params[0]) ? [] : [{ id: 'U' }], []];
    }
    if (/^SELECT password FROM users WHERE username = \?/i.test(s)) {
      return [[{ password: '$2b$10$alreadyhashed' }], []];
    }
    if (/^SELECT username FROM users WHERE id = \?/i.test(s)) {
      return [params[0] in idHolders ? [{ username: idHolders[params[0]] }] : [], []];
    }
    if (/^INSERT INTO users/i.test(s)) {
      log.insertAttempts.push(params[0]);
      if (throwOnInsert) {
        const error = new Error("Duplicate entry 'UHP01' for key 'users.PRIMARY'");
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }
      return [{ affectedRows: 1 }, []];
    }
    if (/SELECT username, accessibleModules FROM users WHERE username IN/i.test(s)) {
      return [(params || []).filter((u) => u in users).map((u) => ({ username: u, accessibleModules: users[u] })), []];
    }
    if (/UPDATE users SET accessibleModules = JSON_ARRAY\(\)/i.test(s)) {
      log.cleared = params;
      return [{ affectedRows: 1 }, []];
    }
    return [[], []];
  };
  pool.getConnection = async () => ({
    query: async () => [[], []],
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  });

  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => { log.consoleErrors.push(args.map(String).join(' ')); };
  console.log = (...args) => { log.consoleLogs.push(args.map(String).join(' ')); };

  const { seedDatabase } = require('../src/scripts/seedDatabase');
  try {
    await seedDatabase();
  } finally {
    pool.query = realQuery;
    pool.getConnection = realGetConnection;
    console.error = originalError;
    console.log = originalLog;
  }
  return log;
}

const DRIFTED = {
  nurse: ['Dashboard', 'Activities', 'Documents', 'Health', 'Reports'],
  educator: ['Dashboard', 'Documents', 'Activities', 'Education'],
};

test('a renamed seeded account does not abort the seed', async () => {
  // The production failure, reproduced exactly.
  //
  // `HP 1` was renamed to `HP1` in Account Management. That freed the username
  // while the row kept the id `UHP01`, and the seed looks users up *by username*
  // before inserting *by id* — so it tried to INSERT and collided on the primary
  // key. Because every step shared one try/catch, the whole function unwound
  // above the reconciliation.
  //
  // Verified against the live runtime log for deployment a01294bb:
  //   [error] Seeding failed: Duplicate entry 'UHP01' for key 'users.PRIMARY'
  //   [info]  SCH-PATH Backend Server          <- boot carried on regardless
  const log = await driveSeed({
    users: DRIFTED,
    missingUsernames: new Set(['HP 1']),
    idHolders: { UHP01: 'HP1' },
  });

  assert.deepEqual(
    log.insertAttempts,
    [],
    'the id is taken by the renamed account, so no INSERT should be attempted',
  );
  assert.ok(
    log.consoleLogs.some((m) => /Skipped seed user "HP 1"/.test(m)),
    'the rename should be reported rather than passing silently',
  );
  assert.ok(log.cleared, 'the reconciliation must still run');
  assert.ok(log.cleared.includes('nurse'), 'the drifted nurse account must be cleared');
  assert.ok(log.cleared.includes('educator'), 'the drifted educator account must be cleared');
});

test('any other user-seeding failure cannot skip the reconciliation either', async () => {
  // Belt and braces: even an unexpected throw must not take the reconciliation
  // down with it. This is what the shared try/catch allowed, whatever the cause.
  const log = await driveSeed({
    users: DRIFTED,
    missingUsernames: new Set(['HP 1']),
    idHolders: {},
    throwOnInsert: true,
  });

  assert.ok(log.insertAttempts.length > 0, 'the INSERT should have been attempted and thrown');
  assert.ok(
    log.consoleErrors.some((m) => /Seeding user "HP 1" failed/.test(m)),
    'the failure should be reported against the user it happened on',
  );
  assert.ok(log.cleared, 'the reconciliation must run regardless of the user-seeding failure');
  assert.ok(log.cleared.includes('nurse'));
});

test('the reconciliation runs before user seeding, so nothing downstream can skip it', async () => {
  // Ordering is the durable part of the fix. Asserting it directly means a
  // future refactor that moves the call back below a throwing step fails here
  // rather than silently in production.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '../src/scripts/seedDatabase.js'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  const body = source.slice(source.indexOf('async function seedDatabase() {'));
  const reconcileAt = body.indexOf('reconcileSeededAccessGrants');
  const usersAt = body.indexOf('seedDefaultUsers');

  assert.ok(reconcileAt !== -1, 'seedDatabase() must still call reconcileSeededAccessGrants');
  assert.ok(usersAt !== -1, 'seedDatabase() must still call seedDefaultUsers');
  assert.ok(
    reconcileAt < usersAt,
    'the reconciliation must run before user seeding, which is the step that used to throw',
  );
});

test('an empty stored grant means "inherit the matrix"', () => {
  // The premise the reconciliation rests on. If `[]` ever stopped meaning
  // "fall back to the role matrix", clearing a stale array would strip the
  // account of everything instead of restoring it -- and the fix would become
  // the bug. rbac.js decides this with `requested.length > 0 ? requested : ...`.
  const { buildAccessSnapshot } = require('../src/config/rbac');
  const snapshot = buildAccessSnapshot({ role: 'nurse', accessibleModules: [] });

  assert.ok(
    snapshot.modules.includes('Child Records'),
    'an empty grant must inherit the role matrix, including Child Records',
  );
  assert.ok(
    !snapshot.modules.includes('Activities'),
    'an empty grant must not carry modules the matrix does not declare',
  );
});
