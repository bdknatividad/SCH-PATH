/**
 * `education_records` must be able to satisfy its own ORDER BY on a database
 * that already existed.
 *
 * ## The bug this exists for
 *
 * The generic controller builds `SELECT * FROM t ORDER BY ${config.orderBy}`
 * (`controllers/baseController.js`), and `RESOURCES.education_records.orderBy`
 * is `createdAt DESC`. The table is created with `CREATE TABLE IF NOT EXISTS`
 * — which is a **no-op on a table that already exists**. So any column that was
 * added to that CREATE TABLE body *after* the table was first provisioned is
 * simply absent from the deployed database, and nothing adds it.
 *
 * Measured on the live database 2026-09-26:
 *
 *   GET /api/education-records       -> 400 "Database error occurred"
 *   GET /api/education-records/NOPE  -> 404 "education_records not found"
 *
 * The second call proves the table exists: it runs `SELECT * ... WHERE id = ?`
 * with no ORDER BY. The first differs only by adding `ORDER BY createdAt DESC`,
 * which names the missing column. Every role's Education list was broken, and
 * the failure was **silent in the UI**: `Education.tsx` catches the error and
 * renders "No students found." with every counter at 0, so the screen looked
 * like an empty module rather than a failing one.
 *
 * ## Why this is pinned rather than left to the generic contract test
 *
 * `schema-contract.test.js` asserts the opposite direction — that every column
 * `RESOURCES` *declares* is creatable by some migration. `createdAt` is not a
 * declared column (it is an audit column, and `RESOURCES` is an exposure
 * allowlist), so that test is blind to this. And a general rule ("every ORDER BY
 * column must be ensureColumn'd") would be wrong: 22 of the 23 resources were
 * created *with* their ordering column, and flagging those would be noise that
 * trains a reader to ignore the test.
 *
 * This repo has a track record of a merge dropping exactly this kind of boot
 * migration — the `violations.type` widening went missing the same way — so the
 * pair of columns this module depends on is asserted directly.
 *
 * Run: node --test tests/education-records-audit-columns.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { RESOURCES } = require('../src/utils/constants');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, relative), 'utf8');
}

const SERVER = read('../src/server.js');

/** The body of `CREATE TABLE IF NOT EXISTS education_records ( ... )`. */
function educationCreateBody(source) {
  const match = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+education_records\s*\(([\s\S]*?)\)\s*`?\s*;/i.exec(source);
  return match ? match[1] : null;
}

test('the education_records CREATE TABLE is where this module thinks it is', () => {
  // Anti-vacuity: if the table is renamed or the statement is restructured, the
  // assertions below would silently stop checking anything.
  const body = educationCreateBody(SERVER);
  assert.ok(body, 'education_records is no longer created in server.js — this test would be vacuous');
  const columns = [...body.matchAll(/^\s*`?(\w+)`?\s+(?:VARCHAR|INT|ENUM|DATE|TIMESTAMP|TEXT|JSON|LONGTEXT|BOOLEAN|DATETIME|CHAR)/gim)]
    .map((m) => m[1]);
  assert.ok(columns.length >= 10, `parsed only ${columns.length} columns from the education_records body`);
  assert.ok(columns.includes('createdAt'), 'createdAt is no longer in the CREATE TABLE body');
  assert.ok(columns.includes('updatedAt'), 'updatedAt is no longer in the CREATE TABLE body');
});

test('the Education list orders by a column the table is created with', () => {
  const orderBy = String(RESOURCES.education_records?.orderBy || '');
  assert.equal(
    orderBy.split(',')[0].trim(),
    'createdAt DESC',
    'the Education list ordering changed — re-check that the column is migrated',
  );
  const body = educationCreateBody(SERVER);
  assert.ok(body && body.includes('createdAt'), 'the ordering column is not in the CREATE TABLE body');
});

test('both audit columns are added to an existing database at boot', () => {
  // The CREATE TABLE above cannot help a database that already has the table,
  // which is every deployed one. `ensureColumn` introspects first, so this is a
  // no-op on a fresh database and an ALTER on an old one.
  for (const column of ['createdAt', 'updatedAt']) {
    assert.match(
      SERVER,
      new RegExp(`ensureColumn\\(\\s*'education_records'\\s*,\\s*'${column}'`),
      `server.js no longer ensures education_records.${column}; a deployed database keeps 400ing on GET /api/education-records`,
    );
  }
});

test('the migration sits inside runMigrations, where ensureColumn is in scope', () => {
  // `ensureColumn` is a nested helper. A call placed outside `runMigrations()`
  // would be a ReferenceError at boot, not a syntax error, so `node --check`
  // cannot see it.
  const start = SERVER.indexOf('async function runMigrations(');
  assert.ok(start > -1, 'runMigrations() is gone');
  const helperAt = SERVER.indexOf('async function ensureColumn(', start);
  assert.ok(helperAt > start, 'ensureColumn is no longer declared inside runMigrations()');

  const callAt = SERVER.search(/ensureColumn\(\s*'education_records'\s*,\s*'createdAt'/);
  assert.ok(callAt > helperAt, 'the education_records migration is declared before ensureColumn is defined');
});
