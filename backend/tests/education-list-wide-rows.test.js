/**
 * The Education list must not sort wide rows in MySQL.
 *
 * ## The bug this exists for
 *
 * `GET /api/education-records` answered 400 on the live database — twice, for two
 * different reasons stacked on the same statement.
 *
 * The statement is built by `baseController.getAll` as
 * `SELECT * FROM t ORDER BY ${config.orderBy}`, and this resource orders by
 * `createdAt DESC`.
 *
 *   1. `createdAt` did not exist on the deployed table. `CREATE TABLE IF NOT
 *      EXISTS` is a no-op on a table that already exists, so a column added to
 *      that body later is never added to a database that predates it. The error
 *      was ER_BAD_FIELD_ERROR, masked to "Database error occurred".
 *
 *   2. Once the column existed, the same statement failed again with
 *      ER_OUT_OF_SORTMEMORY. `files` holds the learner's uploads as JSON, and one
 *      live row measured **277 KB** of it (EDU001, two images). MySQL filesorts a
 *      row together with the columns it carries along, inside
 *      `sort_buffer_size` — 256 KB by default. Reason 2 was invisible until
 *      reason 1 was fixed, because an unknown column is rejected while the
 *      statement is prepared and the sort is never reached.
 *
 * An index on the sort column is not sufficient on its own: with this few rows
 * the optimiser still prefers a full scan plus a filesort, which is why the sort
 * moved out of SQL entirely (`sortInApplication` in constants.js) rather than
 * relying on a plan the optimiser is free to decline.
 *
 * ## What is asserted
 *
 * Both halves matter. That the rows come back in the declared order is the
 * behaviour; that the statement carries no ORDER BY at all is the mechanism, and
 * it is the half that would silently regress if someone "tidied up" the query.
 *
 * Run: node --test tests/education-list-wide-rows.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const DB_MODULE_PATH = require.resolve('../src/config/database');

// ── THE ROWS ────────────────────────────────────────────────────────────────
//
// Returned deliberately out of order, which is what an unordered SELECT gives.
// `createdAt` is an audit column and is NOT in `RESOURCES.education_records
// .columns`, so `mapRow` drops it from the response — the order therefore has to
// be read off `id`, and the ids are chosen so the two orderings disagree.

const ROWS = [
  { id: 'EDU-A', name: 'oldest', residentId: 'CH001', createdAt: '2026-01-01 00:00:00' },
  { id: 'EDU-B', name: 'newest', residentId: 'CH001', createdAt: '2026-03-01 00:00:00' },
  { id: 'EDU-C', name: 'middle', residentId: 'CH001', createdAt: '2026-02-01 00:00:00' },
  { id: 'EDU-D', name: 'undated', residentId: 'CH001', createdAt: null },
];

/** Every statement the controller issued, so the SQL itself can be asserted. */
const statements = [];

const store = {
  async query(sql) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    statements.push(text);
    if (/^SELECT \* FROM `education_records`/i.test(text)) return [ROWS, []];
    if (/^SELECT \* FROM `education_school_visits`/i.test(text)) {
      return [[{ id: 'ESV-1', visitDate: '2026-05-01' }], []];
    }
    throw new Error(`UNHANDLED SQL: ${text}`);
  },
};

require.cache[DB_MODULE_PATH] = {
  id: DB_MODULE_PATH,
  filename: DB_MODULE_PATH,
  loaded: true,
  exports: { pool: store, dbConfig: {}, testConnection: async () => true },
};

const { createController } = require('../src/controllers/baseController');

/** Drive getAll() the way the route does and return the payload it answered. */
async function list(resource) {
  const controller = createController(resource);
  let payload = null;
  let failure = null;
  await controller.getAll(
    { query: {} },
    { json: (body) => { payload = body; } },
    (err) => { failure = err; },
  );
  if (failure) throw failure;
  return payload;
}

test('the fixture is genuinely out of order, so the assertions below mean something', () => {
  // Anti-vacuity: if ROWS ever arrives already sorted, a controller that did
  // nothing at all would pass the ordering test.
  const asGiven = ROWS.map((r) => r.id);
  const byCreatedAtDesc = [...ROWS]
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .map((r) => r.id);
  assert.notDeepEqual(asGiven, byCreatedAtDesc, 'ROWS is already in order — the test would be vacuous');
});

test('the Education list is ordered newest first, with undated rows last', async () => {
  statements.length = 0;
  const payload = await list('education_records');

  assert.equal(payload.success, true);
  assert.equal(payload.count, 4);
  assert.deepEqual(
    payload.data.map((row) => row.id),
    ['EDU-B', 'EDU-C', 'EDU-A', 'EDU-D'],
    'the Education list is no longer newest-first',
  );
});

test('the Education list issues no ORDER BY, so MySQL never filesorts the payload', async () => {
  statements.length = 0;
  await list('education_records');

  assert.equal(statements.length, 1, `expected one statement, got ${statements.length}`);
  assert.ok(
    /^SELECT \* FROM `education_records`/i.test(statements[0]),
    `unexpected statement: ${statements[0]}`,
  );
  assert.ok(
    !/ORDER BY/i.test(statements[0]),
    `the Education list still sorts in SQL — a 277 KB row overflows sort_buffer_size: ${statements[0]}`,
  );
});

test('a resource that did not opt in still sorts in SQL', async () => {
  // The control. Without this, a blanket "remove ORDER BY everywhere" change
  // would pass the two tests above while breaking ordering for every other
  // module.
  statements.length = 0;
  await list('education_school_visits');

  assert.equal(statements.length, 1);
  assert.match(
    statements[0],
    /ORDER BY visitDate DESC/i,
    'a resource that did not opt into sortInApplication lost its SQL ordering',
  );
});

test('only education_records has opted into an application-side sort', async () => {
  // The flag is the mechanism, so pin who holds it. A second resource acquiring
  // it silently would move that module's ordering out of the database.
  const { RESOURCES } = require('../src/utils/constants');
  const optedIn = Object.entries(RESOURCES)
    .filter(([, config]) => config.sortInApplication)
    .map(([key]) => key);

  assert.deepEqual(optedIn, ['education_records']);
});
