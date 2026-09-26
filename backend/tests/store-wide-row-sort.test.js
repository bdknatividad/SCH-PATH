/**
 * `/store` must not sort a wide-row resource in MySQL either.
 *
 * ## The bug this exists for
 *
 * `GET /api/education-records` was fixed by moving its ordering out of SQL
 * (`sortInApplication` in constants.js) — see `education-list-wide-rows.test.js`
 * for the 277 KB row and the `sort_buffer_size` measurement behind that.
 *
 * `/store` did not get the same treatment. It builds its own per-table read —
 * `SELECT * FROM \`t\` ORDER BY ${RESOURCES[t].orderBy}` — so it never consulted
 * `sortInApplication` and kept handing the sort to MySQL. The statement failed,
 * the loop's per-table `catch` turned the error into `data[t] = []`, and the
 * table read as empty. Observed live on 2026-09-26: `/store` answered
 * `educationRecords: []` while `GET /api/education-records` returned its row.
 *
 * Nothing errored and no screen broke, because the Education screens read
 * `/education-records` rather than the store payload — which is exactly why this
 * needs a test rather than a smoke check. The failure mode is a silently empty
 * list with no message.
 *
 * ## What is asserted
 *
 * The stub reproduces the live failure: it throws ER_OUT_OF_SORTMEMORY for
 * `education_records` if the statement carries an ORDER BY. So the rows coming
 * back is the behaviour, and the absence of ORDER BY is the mechanism. The
 * control keeps a non-opted-in resource sorting in SQL, so a blanket "remove
 * every ORDER BY" change cannot pass this file.
 *
 * Run: node --test tests/store-wide-row-sort.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const TEST_SECRET = 'store-wide-row-test-secret-value-long-enough';
process.env.JWT_SECRET = TEST_SECRET;

const DB_MODULE_PATH = require.resolve('../src/config/database');
const ROUTES_MODULE_PATH = require.resolve('../src/routes');
const SRC_ROOT = path.resolve(__dirname, '..', 'src');

/** Drop every cached module under src/ so the router rebinds to the next stub. */
function purgeSrcModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_ROOT) && !key.includes('node_modules')) {
      delete require.cache[key];
    }
  }
}

// ── THE ROWS ────────────────────────────────────────────────────────────────
//
// Deliberately out of order, which is what an unordered SELECT gives.
// `createdAt` is an audit column and is NOT in `RESOURCES.education_records
// .columns`, so `mapRow` drops it from the response — the order has to be read
// off `id`, and the ids are chosen so the two orderings disagree.

const EDU_ROWS = [
  { id: 'EDU-A', name: 'oldest', residentId: 'CH001', createdAt: '2026-01-01 00:00:00' },
  { id: 'EDU-B', name: 'newest', residentId: 'CH001', createdAt: '2026-03-01 00:00:00' },
  { id: 'EDU-C', name: 'middle', residentId: 'CH001', createdAt: '2026-02-01 00:00:00' },
  { id: 'EDU-D', name: 'undated', residentId: 'CH001', createdAt: null },
];

const VISIT_ROWS = [
  { id: 'ESV-A', visitDate: '2026-05-01' },
  { id: 'ESV-B', visitDate: '2026-07-01' },
];

/** Every statement the store issued, so the SQL itself can be asserted. */
let statements = [];

function createPoolStub({ userId = 'U-CH', role = 'centerhead' } = {}) {
  async function query(sql) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    statements.push(text);

    // authenticate() account lookup.
    if (/FROM users WHERE id = \?/i.test(text)) {
      return [[{ id: userId, username: 'ch-tester', role, status: 'Active' }]];
    }
    // assignedResidentIds() — only reached for a Houseparent.
    if (/FROM residentAssignments ra/i.test(text)) return [[]];
    if (/FROM admissions a\s+JOIN users u ON u\.id = \?/i.test(text)) return [[]];

    const tableMatch = text.match(/^SELECT \* FROM `(\w+)`/);
    if (tableMatch) {
      const table = tableMatch[1];

      // Reproduce the live failure instead of pretending it cannot happen: the
      // deployed MySQL refuses this filesort, and the store swallowed it.
      if (table === 'education_records') {
        if (/ORDER BY/i.test(text)) {
          const error = new Error('Out of sort memory, consider increasing server sort buffer size');
          error.code = 'ER_OUT_OF_SORTMEMORY';
          error.sqlMessage = 'Out of sort memory, consider increasing server sort buffer size';
          throw error;
        }
        return [EDU_ROWS];
      }
      if (table === 'education_school_visits') return [VISIT_ROWS];
      return [[]];
    }
    return [[]];
  }

  return {
    query,
    async getConnection() {
      return {
        query,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      };
    },
  };
}

function loadApp(poolStub) {
  purgeSrcModules();
  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH,
    filename: DB_MODULE_PATH,
    loaded: true,
    exports: { pool: poolStub, dbConfig: {}, testConnection: async () => true },
  };

  const express = require('express');
  const routes = require(ROUTES_MODULE_PATH);
  const { errorHandler, notFoundHandler } = require('../src/middleware/errorHandler');

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', routes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const originalError = console.error;
  console.error = () => {};
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
  }
}

async function getStore(base, role) {
  const token = jwt.sign({ id: 'U-CH', username: 'ch-tester', role }, TEST_SECRET, { expiresIn: '1h' });
  const response = await fetch(`${base}/api/store`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}

test('the fixture is genuinely out of order, so the ordering assertion means something', () => {
  const asGiven = EDU_ROWS.map((row) => row.id);
  const byCreatedAtDesc = [...EDU_ROWS]
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .map((row) => row.id);
  assert.notDeepEqual(asGiven, byCreatedAtDesc, 'EDU_ROWS is already in order — the test would be vacuous');
});

test('/store returns the Education rows instead of an empty list', async () => {
  statements = [];
  const app = loadApp(createPoolStub());

  await withServer(app, async (base) => {
    const { status, body } = await getStore(base, 'centerhead');

    assert.equal(status, 200, 'the store should answer 200');
    const records = body?.data?.educationRecords;
    assert.ok(Array.isArray(records), 'the store payload must carry an educationRecords array');

    // The regression: this came back as [] while the dedicated endpoint
    // returned the same table's rows.
    assert.deepEqual(
      records.map((row) => row.id),
      ['EDU-B', 'EDU-C', 'EDU-A', 'EDU-D'],
      'the store returned an empty or wrongly ordered Education list',
    );
  });
});

test('/store issues no ORDER BY for education_records, so MySQL never filesorts it', async () => {
  statements = [];
  const app = loadApp(createPoolStub());

  await withServer(app, async (base) => {
    await getStore(base, 'centerhead');
  });

  const educationStatements = statements.filter((sql) => /^SELECT \* FROM `education_records`/i.test(sql));
  assert.equal(educationStatements.length, 1, `expected one education_records statement, got ${educationStatements.length}`);
  assert.ok(
    !/ORDER BY/i.test(educationStatements[0]),
    `the store still sorts the Education table in SQL — a 277 KB row overflows sort_buffer_size: ${educationStatements[0]}`,
  );
});

test('/store still sorts a resource that did not opt in, in SQL', async () => {
  // The control. Without this, a blanket "drop every ORDER BY from the store"
  // change would pass the tests above while silently unordering every other
  // module's list.
  statements = [];
  const app = loadApp(createPoolStub());

  await withServer(app, async (base) => {
    await getStore(base, 'centerhead');
  });

  const visitStatements = statements.filter((sql) => /^SELECT \* FROM `education_school_visits`/i.test(sql));
  assert.equal(visitStatements.length, 1);
  assert.match(
    visitStatements[0],
    /ORDER BY visitDate DESC/i,
    'a resource that did not opt into sortInApplication lost its SQL ordering in the store',
  );
});
