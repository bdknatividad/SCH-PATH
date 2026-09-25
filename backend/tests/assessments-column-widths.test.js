/**
 * Column-width contract for the values the violation flow writes.
 *
 * A `VARCHAR` that is too small does not fail at the call site: MySQL raises
 * ER_DATA_TOO_LONG ("Data too long for column 'x' at row 1") and `errorHandler`
 * masks that to the generic "Database error occurred", so the user is never told
 * which column overflowed. That is how verifying a violation died in production
 * while every other column in the same INSERT was fine — twice, on two different
 * columns, because each retry got one step further.
 *
 * The rule these tests enforce: **a column that copies another column must be at
 * least as wide as the column it copies.** `violations.type` copies
 * `violation_guide.name`; `assessments.triggeredBy` frames it; `assessments.title`
 * frames the joined psychosocial activities with the resident's name. Every bound
 * is read from the declaration of the *source* column, so widening a source
 * without widening its copy fails here rather than in production.
 *
 * A sample row cannot reveal this — the row that breaks it is the one nobody has
 * created yet. Hence the bound is computed over the whole official guide.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { OFFICIAL_VIOLATION_GUIDE } = require('../src/scripts/seedDatabase');

const SERVER_PATH = path.resolve(__dirname, '../src/server.js');
const SCHEMA_PATH = path.resolve(__dirname, '../src/database/schema.sql');
const VIOLATIONS_TSX = path.resolve(__dirname, '../../frontend/src/app/components/Violations.tsx');

const serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');
const schemaSrc = fs.readFileSync(SCHEMA_PATH, 'utf8');

/** Both files declare the same tables; a bound is only real if both agree. */
const SOURCES = [['schema.sql', schemaSrc], ['server.js', serverSrc]];

/** The offense levels `review()` maps an offenseNumber onto. */
const OFFENSE_LEVELS = ['1st', '2nd', '3rd'];

/**
 * The declared width of `<table>.<column>` in a CREATE TABLE block, or null.
 *
 * The column match is anchored on leading whitespace: every column line in both
 * files is indented, so a bare `^` with the `m` flag silently returns null and
 * every `width >= required` assertion then fails for the wrong reason.
 *
 * @param {string} src
 * @param {string} table
 * @param {string} column
 * @returns {number|null}
 */
function declaredWidth(src, table, column) {
  const tableRe = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\`?${table}\`?\\s*\\(([\\s\\S]*?)\\)\\s*ENGINE`,
    'i'
  );
  const body = src.match(tableRe);
  if (!body) return null;
  const colRe = new RegExp(`^\\s*\`?${column}\`?\\s+VARCHAR\\((\\d+)\\)`, 'im');
  const col = body[1].match(colRe);
  return col ? Number(col[1]) : null;
}

/** The declared width in every source, asserting they agree. */
function widthEverywhere(table, column) {
  const widths = [];
  for (const [label, src] of SOURCES) {
    const width = declaredWidth(src, table, column);
    assert.notEqual(width, null, `${label}: could not read ${table}.${column}`);
    widths.push([label, width]);
  }
  const [firstLabel, first] = widths[0];
  for (const [label, width] of widths.slice(1)) {
    assert.equal(
      width,
      first,
      `${table}.${column} is VARCHAR(${first}) in ${firstLabel} but VARCHAR(${width}) in ${label} — ` +
        'schema.sql and server.js must agree, and only server.js reaches a deployed database'
    );
  }
  return first;
}

/**
 * The psychosocial activities the Verify Violation modal lets a reviewer tick.
 * Read from the component so the test follows the UI rather than a copy of it.
 * @returns {string[]}
 */
function psychosocialOptions() {
  const src = fs.readFileSync(VIOLATIONS_TSX, 'utf8');
  const block = src.match(/PSYCHOSOCIAL_OPTIONS\s*=\s*\[([^\]]*)\]/);
  assert.ok(block, 'expected to find PSYCHOSOCIAL_OPTIONS in Violations.tsx');
  return block[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/** Every activity joined with ', ', which is what `type` and the head of `title` become. */
function joinedActivities() {
  return psychosocialOptions().join(', ');
}

/** The exact shape `review()` builds for `assessments.triggeredBy`. */
function triggeredBy(name, level) {
  return `Violation: ${name} (${level} offense)`;
}

/** The longest such value over a guide name of `nameLength` characters. */
function longestTriggeredBy(nameLength) {
  return Math.max(...OFFENSE_LEVELS.map((level) => triggeredBy('x'.repeat(nameLength), level).length));
}

/** The longest official guide name, i.e. the worst case that exists today. */
function longestOfficialGuideName() {
  return OFFICIAL_VIOLATION_GUIDE.reduce((max, guide) => Math.max(max, String(guide.name || '').length), 0);
}

test('the guide data and the activity list are parseable', () => {
  // Anti-vacuity: if either parse yields nothing, the width assertions below would
  // pass against any number.
  assert.ok(OFFICIAL_VIOLATION_GUIDE.length > 20, `expected the full guide, parsed ${OFFICIAL_VIOLATION_GUIDE.length}`);
  assert.equal(psychosocialOptions().length, 6, 'expected six configured psychosocial activities');
  assert.ok(
    longestOfficialGuideName() > 100,
    `expected an official guide name long enough to overflow VARCHAR(100), got ${longestOfficialGuideName()}`
  );
  assert.ok(joinedActivities().length > 100, `expected the joined activities to overflow VARCHAR(100), got ${joinedActivities().length}`);
});

test('violations.type is as wide as the guide name it copies', () => {
  // create() writes `type: guide.name` straight through buildInsertPayload.
  const nameBound = widthEverywhere('violation_guide', 'name');
  const declared = widthEverywhere('violations', 'type');
  const official = longestOfficialGuideName();

  assert.ok(
    declared >= official,
    `violations.type is VARCHAR(${declared}) but the longest official guide name is ${official} characters, so ` +
      'logging that violation fails with ER_DATA_TOO_LONG — "Database error occurred" in the UI'
  );
  assert.ok(
    declared >= nameBound,
    `violations.type is VARCHAR(${declared}) but violation_guide.name is VARCHAR(${nameBound}); the copy must be ` +
      'at least as wide as its source, or a name that the guide accepts is rejected on the violation'
  );
});

test('assessments.triggeredBy can hold the framed guide name', () => {
  const nameBound = widthEverywhere('violation_guide', 'name');
  const declared = widthEverywhere('assessments', 'triggeredBy');

  assert.ok(
    declared >= longestTriggeredBy(longestOfficialGuideName()),
    `assessments.triggeredBy is VARCHAR(${declared}) but review() writes ${longestTriggeredBy(longestOfficialGuideName())} ` +
      'characters on the official guide data alone ("Violation: <guide name> (<n>th offense)")'
  );
  assert.ok(
    declared >= longestTriggeredBy(nameBound),
    `assessments.triggeredBy is VARCHAR(${declared}) but the widest guide name the guide table accepts needs ` +
      `${longestTriggeredBy(nameBound)} characters once framed`
  );
});

test('assessments.type can hold every psychosocial activity joined', () => {
  const required = joinedActivities().length;
  const declared = widthEverywhere('assessments', 'type');
  assert.ok(
    declared >= required,
    `assessments.type is VARCHAR(${declared}) but the joined activity list is ${required} characters`
  );
});

test('assessments.title can hold the joined activities plus a resident name', () => {
  const residentBound = widthEverywhere('children', 'name');
  const required = joinedActivities().length + ' — '.length + residentBound;
  const declared = widthEverywhere('assessments', 'title');
  assert.ok(
    declared >= required,
    `assessments.title is VARCHAR(${declared}) but review() writes the joined activities, " — " and the resident's ` +
      `name (children.name is VARCHAR(${residentBound})), needing ${required} characters`
  );
});

test('the boot migration widens these columns, so a deployed database is repaired', () => {
  // schema.sql is never executed, so widening it alone fixes nothing in production.
  for (const [table, column] of [
    ['violations', 'type'],
    ['assessments', 'type'],
    ['assessments', 'title'],
    ['assessments', 'triggeredBy'],
  ]) {
    assert.ok(
      new RegExp(`ensureColumnLength\\(\\s*'${table}'\\s*,\\s*'${column}'`).test(serverSrc),
      `expected ensureColumnLength('${table}', '${column}', ...) in server.js`
    );
  }
});
