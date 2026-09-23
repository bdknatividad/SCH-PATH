/**
 * Regression tests for query construction and error responses.
 *
 * `buildWhereClause` interpolates column names straight into the SQL string
 * (only the values are parameterised), so an unvalidated query key was a
 * SQL-injection vector. The generic controllers now pass an allow-list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildWhereClause, generateId, calculateAge } = require('../src/utils/helpers');
const { notFoundHandler } = require('../src/middleware/errorHandler');

test('buildWhereClause ignores filters whose column is not allowed', () => {
  const { clause, values } = buildWhereClause(
    { status: 'Active', 'id = 1 OR 1=1 --': 'x' },
    ['id', 'status', 'residentId']
  );

  assert.equal(clause, 'WHERE status = ?');
  assert.deepEqual(values, ['Active']);
  assert.ok(!clause.includes('1=1'), 'injected column name must not reach the SQL string');
});

test('buildWhereClause still parameterises values', () => {
  const { clause, values } = buildWhereClause({ residentId: "CH001' OR '1'='1" }, ['residentId']);

  assert.equal(clause, 'WHERE residentId = ?');
  assert.deepEqual(values, ["CH001' OR '1'='1"]);
});

test('buildWhereClause with no allow-list keeps the previous behaviour', () => {
  const { clause, values } = buildWhereClause({ status: 'Active', empty: '', missing: null });

  assert.equal(clause, 'WHERE status = ?');
  assert.deepEqual(values, ['Active']);
});

test('buildWhereClause returns no clause when nothing is filtered', () => {
  assert.equal(buildWhereClause({}, ['id']).clause, '');
});

test('generateId continues the highest existing sequence for its prefix', () => {
  assert.equal(generateId('CH', [{ id: 'CH001' }, { id: 'CH010' }, { id: 'CH003' }]), 'CH011');
  assert.equal(generateId('CH', []), 'CH001');
  // Ids in other formats must not break the scan.
  assert.equal(generateId('CH', [{ id: 'CH-2024-01-15-001' }]), 'CH001');
});

test('generateId issues a distinct id for each item when used in a batch loop', () => {
  // assignInterventions() called generateId('IT') with no existing rows inside
  // its loop, so every iteration produced 'IT001'; the second INSERT then hit a
  // duplicate primary key and the whole assignment transaction rolled back.
  // The fix seeds the sequence once and grows it as ids are handed out.
  //
  // Note: generateId reads `item.id`, so the running list must hold objects —
  // passing raw strings silently yields the same id every time.
  const issued = [];
  for (let i = 0; i < 3; i += 1) {
    const next = generateId('IT', issued);
    issued.push({ id: next });
  }

  assert.deepEqual(issued.map(item => item.id), ['IT001', 'IT002', 'IT003']);
  assert.equal(new Set(issued.map(item => item.id)).size, 3, 'batch-generated ids must be unique');
});

test('generateId ignores list entries that are not { id } objects', () => {
  // Guards against the exact mistake the batch loop above is written to avoid.
  assert.equal(generateId('IT', ['IT001', 'IT002']), 'IT001');
});

test('calculateAge handles birthdays that have not happened yet this year', () => {
  const today = new Date();
  const lastYear = today.getFullYear() - 20;
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

  const pad = (n) => String(n).padStart(2, '0');
  const justHadBirthday = `${lastYear}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
  const notYetThisYear = `${lastYear}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;

  assert.equal(calculateAge(justHadBirthday), 20);
  assert.equal(calculateAge(notYetThisYear), 19);
  assert.equal(calculateAge(null), 0);
});

test('the 404 handler reports the real HTTP method', () => {
  let body;
  const res = {
    status() { return this; },
    json(payload) { body = payload; return this; },
  };

  notFoundHandler({ method: 'GET', originalUrl: '/api/does-not-exist' }, res);

  assert.equal(body.message, 'Route GET /api/does-not-exist not found');
  assert.ok(!body.message.includes('undefined'), 'the method must not render as undefined');
});
