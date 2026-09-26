/**
 * The verification queue is a capability, not a screen.
 *
 * The requirement is explicit for the Houseparent — the role may read the
 * Violation List and the Intervention Tracker, and must not see the Incident
 * Report Verification — and the rule behind it is the `Violations:verify`
 * capability, which the Social Worker, the Psychological Staff and the Center
 * Head hold and nobody else does.
 *
 * Hiding the tab and its tile in the SPA satisfies the UI half and nothing else.
 * `GET /api/violations` is gated on the *module*, which the Houseparent
 * legitimately holds, so before this the whole `Pending Review` queue — every
 * resident's, not just the caller's caseload — was one authenticated request
 * away. The same held for `GET /api/violations/:id`, where the id is guessable
 * from a notification or a shared link.
 *
 * Both halves are pinned here: the API behaviour is exercised against a pool
 * stub, and the two SPA surfaces are read as source.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../src');
const FRONTEND = path.resolve(__dirname, '../../frontend/src/app');
const read = (file) => fs.readFileSync(file, 'utf8');

const CONTROLLER = path.join(SRC, 'controllers/violationController.js');
const VIOLATIONS_UI = path.join(FRONTEND, 'components/Violations.tsx');

// ── A pool that answers only what the assertions need ───────────────────────

const queries = [];

async function query(sql, params) {
  const text = String(sql);
  queries.push({ sql: text, params });

  // The single-record read in getById() — both the controller's own status
  // lookup and the base controller's backticked `SELECT *`.
  if (/FROM\s+`?violations`?\s+WHERE\s+id\s*=\s*\?/i.test(text)) {
    return [[{ id: 'V1', residentId: 'R-1', status: 'Pending Review' }]];
  }
  // canAccessResident(): grant the Houseparent its caseload.
  if (/FROM residentAssignments ra/i.test(text)) {
    return [[{ id: 'RA-1' }]];
  }
  return [[], []];
}

const poolStub = {
  queries,
  query,
  async getConnection() {
    return {
      query,
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: async () => {},
    };
  },
};

const DB_MODULE_PATH = require.resolve('../src/config/database');
require.cache[DB_MODULE_PATH] = {
  id: DB_MODULE_PATH,
  filename: DB_MODULE_PATH,
  loaded: true,
  exports: { pool: poolStub, dbConfig: {}, testConnection: async () => true },
};

const violationController = require('../src/controllers/violationController');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function makeReq(role, { query: queryParams = {}, params = {} } = {}) {
  return { user: { id: 'U-TEST', username: 'tester', role }, query: queryParams, params };
}

/** Run a handler, resolving with the error `next()` captured (or null). */
async function drive(handler, req, res) {
  let captured = null;
  await handler(req, res, (error) => {
    captured = error;
  });
  return captured;
}

const listQueries = () => queries.filter((entry) => /FROM violations v/i.test(entry.sql));
const lastListQuery = () => listQueries()[listQueries().length - 1];

// ── The API withholds the queue ─────────────────────────────────────────────

test('the verification queue is filtered out of the list for a caller without Violations:verify', async () => {
  queries.length = 0;
  const res = makeRes();
  await drive(violationController.getAll, makeReq('houseparent'), res);

  const call = lastListQuery();
  assert.ok(call, 'getAll() must query the violations table');
  assert.match(
    call.sql,
    /v\.status <>\s*\?/,
    'the Houseparent list must exclude the rows awaiting verification',
  );
  assert.ok(
    call.params.includes('Pending Review'),
    'the withheld status must be bound as a parameter, not interpolated',
  );
});

test('the list filter cannot be widened by asking for the withheld status', async () => {
  queries.length = 0;
  const res = makeRes();
  await drive(
    violationController.getAll,
    makeReq('houseparent', { query: { status: 'Pending Review' } }),
    res,
  );

  const call = lastListQuery();
  // The client's own filter is kept *and* the withheld status is excluded, so
  // the two contradict each other and the query returns nothing rather than
  // handing back the queue through a query-string override.
  assert.match(call.sql, /v\.status = \?/);
  assert.match(call.sql, /v\.status <>\s*\?/);
  assert.ok(call.sql.indexOf('v.status = ?') < call.sql.indexOf('v.status <>'), 'both conditions are ANDed');
});

test('the Houseparent list stays scoped to its own caseload', async () => {
  queries.length = 0;
  const res = makeRes();
  await drive(violationController.getAll, makeReq('houseparent'), res);

  const call = lastListQuery();
  assert.match(call.sql, /INNER JOIN residentAssignments ra ON ra\.residentId = v\.residentId/);
  assert.match(call.sql, /ra\.userId = \? AND ra\.status = 'Active'/);
  assert.equal(call.params[0], 'U-TEST', 'the caseload owner must be the authenticated user');
});

test('a role that holds Violations:verify still reads the whole queue', async () => {
  for (const role of ['psychologist', 'socialworker', 'centerhead']) {
    queries.length = 0;
    const res = makeRes();
    await drive(violationController.getAll, makeReq(role), res);

    const call = lastListQuery();
    assert.ok(call, `${role} must reach the violations list`);
    assert.doesNotMatch(
      call.sql,
      /v\.status <>\s*\?/,
      `${role} holds verify and must not have the queue filtered out`,
    );
    assert.doesNotMatch(
      call.sql,
      /residentAssignments/,
      `${role} is not caseload-scoped`,
    );
  }
});

test('fetching a pending incident by id is refused without Violations:verify', async () => {
  queries.length = 0;
  const res = makeRes();
  const error = await drive(
    violationController.getById,
    makeReq('houseparent', { params: { id: 'V1' } }),
    res,
  );

  assert.ok(error, 'the read must be refused rather than answered');
  assert.equal(error.statusCode, 403);
  assert.match(error.message, /awaiting verification/i);
  assert.equal(res.body, null, 'no payload may be written for a refused read');
});

test('a verifier can still fetch the same pending incident by id', async () => {
  queries.length = 0;
  const res = makeRes();
  const error = await drive(
    violationController.getById,
    makeReq('psychologist', { params: { id: 'V1' } }),
    res,
  );

  assert.equal(error, null, 'the Psychological Staff must reach the record');
});

// ── The capability is read, not the role ────────────────────────────────────

test('the controller asks the capability, not the role, for the verification right', () => {
  const source = read(CONTROLLER);

  assert.match(
    source,
    /hasPermission\([\s\S]{0,80}'Violations',\s*'verify'\)/,
    'the guard must read Violations:verify off the access snapshot',
  );
  assert.doesNotMatch(
    source,
    /role\s*===?\s*'psychologist'[\s\S]{0,120}verify/,
    'verification must not be decided by naming a role',
  );
});

test('the SPA gates both verification surfaces on the same capability', () => {
  const source = read(VIOLATIONS_UI);

  assert.match(
    source,
    /can\('Violations',\s*'verify'\)/,
    'the SPA must ask the capability, not test the role name',
  );
  // The tile and the tab body are the two places the queue can be opened from.
  const gates = source.match(/can\('Violations',\s*'verify'\)/g) || [];
  assert.ok(
    gates.length >= 3,
    `expected the tab strip, the "For Verification" tile and the tab body to be gated (found ${gates.length})`,
  );
});

test('the Houseparent matrix grants the Violation List and the ability to log, and nothing more', () => {
  const definition = JSON.parse(read(path.join(SRC, 'config/rbac.definition.json')));
  const houseparent = definition.roles.houseparent;

  // Item 37: the Houseparent who witnessed the incident files it, so `create` is
  // granted alongside the list. Everything past that — editing, deleting and the
  // two reviewer sign-offs — is other roles' work.
  assert.deepEqual(
    houseparent.permissions.Violations,
    ['view', 'create'],
    'the Houseparent lost the Violation List or the ability to log a violation',
  );
  for (const withheld of ['edit', 'delete', 'verify', 'approve']) {
    assert.ok(
      !houseparent.permissions.Violations.includes(withheld),
      `the Houseparent must not hold Violations:${withheld}`,
    );
  }
});
