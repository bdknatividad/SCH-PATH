/**
 * Scheduling an intervention, and the free-identifier class that broke it.
 *
 * `PUT /api/violation-guide/intervention-tracker/:id` calls `normalizeRole` in
 * its scheduling guard — the check that keeps a Houseparent out of a
 * manager/staff workflow — and the controller never imported it. Every request
 * carrying `scheduledAt` therefore threw
 * `ReferenceError: normalizeRole is not defined`, which surfaced as a bare 500
 * because a ReferenceError is not an `ApiError` and `errorHandler` has nothing
 * to map it to. Only requests carrying `scheduledAt` failed, because the guard
 * is the first thing that touches the name, so `status` updates and the empty
 * body kept working and nothing looked wrong from the outside.
 *
 * Two things are pinned here:
 *
 *  1. The behaviour — a schedule is saved, and the two guards around it still
 *     refuse what they should. Driven through the controller with a pool stub,
 *     so the `ReferenceError` cannot come back unnoticed.
 *  2. The class — any helper exported by `utils/authorization.js` that a file
 *     calls must also be imported or defined in that file. A `ReferenceError`
 *     is invisible until the exact branch runs, and this is the second time
 *     this codebase has been bitten by one (see the `rbac.` prefix note on
 *     `config/accessDefaults.js`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../src');
const read = (file) => fs.readFileSync(file, 'utf8');

// ── A pool that answers only what the assertions need ───────────────────────

const queries = [];
let trackerRow = {
  id: 'IT1',
  residentId: 'R-1',
  interventionType: 'Psychosocial Activity',
  duration: null,
  startDate: null,
};

async function query(sql, params) {
  const text = String(sql);
  queries.push({ sql: text, params });

  // The `SELECT * FROM intervention_tracker WHERE id = ?` lookup, and the
  // re-read the controller does before responding.
  if (/FROM\s+`?intervention_tracker`?\s+WHERE\s+id\s*=\s*\?/i.test(text)) {
    return [[{ ...trackerRow, scheduledAt: params?.[0] ?? trackerRow.scheduledAt }]];
  }
  // canAccessResident() short-circuits for a manager, so nothing else is needed
  // for the Center Head. The Houseparent path asks for its caseload.
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

const { updateInterventionStatus } = require('../src/controllers/violationGuideController');

/** Drive the controller and resolve with what it answered. */
function call(body, user = { id: 'U1', role: 'centerhead' }) {
  return new Promise((resolve, reject) => {
    const req = { params: { id: 'IT1' }, body, user };
    let status = 200;
    const res = {
      status(code) { status = code; return this; },
      json(payload) { resolve({ status, payload }); return this; },
    };
    updateInterventionStatus(req, res, (error) => {
      if (error) resolve({ status: error.statusCode || 500, error });
      else reject(new Error('the controller called next() with no error'));
    });
  });
}

test.beforeEach(() => {
  queries.length = 0;
  trackerRow = {
    id: 'IT1',
    residentId: 'R-1',
    interventionType: 'Psychosocial Activity',
    duration: null,
    startDate: null,
  };
});

// ── the behaviour ──────────────────────────────────────────────────────────

test('a schedule is saved and the stored row comes back', async () => {
  const result = await call({ scheduledAt: '2026-09-30T14:32' });

  assert.equal(result.status, 200, JSON.stringify(result.error?.message || result.payload));
  const update = queries.find((q) => /UPDATE intervention_tracker SET/i.test(q.sql));
  assert.ok(update, 'no UPDATE was issued');
  assert.match(update.sql, /scheduledAt = \?/);
  assert.equal(update.params[0], '2026-09-30T14:32');
});

test('the scheduling guard does not throw for a manager', async () => {
  // The regression itself: this resolved as a 500 with
  // "normalizeRole is not defined" rather than reaching the database.
  const result = await call({ scheduledAt: '2026-09-30T14:32' });
  assert.notEqual(result.status, 500, 'the schedule path still 500s');
});

test('a Houseparent cannot schedule, and is refused as a client error', async () => {
  const result = await call({ scheduledAt: '2026-09-30T14:32' }, { id: 'U2', role: 'houseparent' });
  assert.equal(result.status, 403);
  assert.match(result.error.message, /cannot schedule/i);
});

test('a role alias is normalised before the guard reads it', async () => {
  // `normalizeRole` exists precisely so `House Parent` and `house_parent` reach
  // the same branch as `houseparent`. Reading the raw role would let an alias
  // through the guard.
  for (const alias of ['House Parent', 'house_parent', 'HOUSEPARENT']) {
    const result = await call({ scheduledAt: '2026-09-30T14:32' }, { id: 'U3', role: alias });
    assert.equal(result.status, 403, `${alias} was not treated as a Houseparent`);
  }
});

test('a type that is not schedulable is a 400, not a 500', async () => {
  trackerRow.interventionType = 'Individual Counseling';
  const result = await call({ scheduledAt: '2026-09-30T14:32' });
  assert.equal(result.status, 400);
  assert.match(result.error.message, /does not require scheduling/i);
});

test('a schedule in the past is refused', async () => {
  const result = await call({ scheduledAt: '2020-01-01T09:00' });
  assert.equal(result.status, 400);
  assert.match(result.error.message, /must be in the future/i);
});

test('clearing a schedule is allowed', async () => {
  // `scheduledAt: null` still enters the guard, which is why clearing a
  // schedule failed too.
  const result = await call({ scheduledAt: null });
  assert.equal(result.status, 200, JSON.stringify(result.error?.message || result.payload));
});

// ── the class ──────────────────────────────────────────────────────────────

test('every authorization helper a file calls is in scope there', () => {
  const helpers = Object.keys(require('../src/utils/authorization'))
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

  const offenders = [];
  for (const file of walk(SRC)) {
    const source = read(file);
    for (const helper of helpers) {
      if (!new RegExp(`\\b${helper}\\s*\\(`).test(source)) continue;

      const defined =
        new RegExp(`function\\s+${helper}\\s*\\(`).test(source) ||
        new RegExp(`(?:const|let|var)\\s+${helper}\\s*=`).test(source) ||
        new RegExp(`class\\s+${helper}\\b`).test(source);
      // `const { normalizeRole } = require(…)` — the destructuring must name it.
      const imported = new RegExp(`\\{[^}]*\\b${helper}\\b[^}]*\\}\\s*=\\s*require\\(`).test(source);

      if (!defined && !imported) {
        offenders.push(`${path.relative(SRC, file)} calls ${helper}() without defining or importing it`);
      }
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
});
