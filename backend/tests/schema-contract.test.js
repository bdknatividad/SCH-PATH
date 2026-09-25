/**
 * Schema/contract regression tests.
 *
 * The most damaging bug class found in this codebase was a drift between
 * RESOURCES[*].columns (the contract the generic controllers write against)
 * and the actual MySQL tables. Whenever they diverged, every write to that
 * resource failed at runtime with:
 *     ER_BAD_FIELD_ERROR: Unknown column 'x' in 'field list'
 * e.g. staff.createdBy, phaseProgress.modifiedBy, healthRecords.bloodPressure.
 *
 * These tests compare the contract against the real schema so the drift cannot
 * come back silently. They are pure static analysis — no database required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { RESOURCES } = require('../src/utils/constants');

const SCHEMA_PATH = path.resolve(__dirname, '../src/database/schema.sql');
const SERVER_PATH = path.resolve(__dirname, '../src/server.js');

/**
 * Extract column names from every `CREATE TABLE <name> (...)` body.
 * @param {string} sql
 * @returns {Map<string, Set<string>>}
 */
function parseCreateTables(sql) {
  const tables = new Map();
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(([\s\S]*?)\)\s*ENGINE/gi;
  let match;
  while ((match = createRe.exec(sql)) !== null) {
    const [, table, body] = match;
    const columns = new Set(tables.get(table) || []);
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('--')) continue;
      // Table-level constraints are not columns.
      if (/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|FULLTEXT|SPATIAL|CHECK)\b/i.test(line)) continue;
      const col = line.match(/^`?(\w+)`?\s+[A-Za-z]/);
      if (col) columns.add(col[1]);
    }
    tables.set(table, columns);
  }
  return tables;
}

/**
 * Collect columns added later via `ALTER TABLE x ADD COLUMN y`.
 * @param {string} sql
 * @returns {Map<string, Set<string>>}
 */
function parseAlters(sql) {
  const added = new Map();
  const addRe = /ALTER\s+TABLE\s+`?(\w+)`?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi;
  let match;
  while ((match = addRe.exec(sql)) !== null) {
    const [, table, column] = match;
    if (!added.has(table)) added.set(table, new Set());
    added.get(table).add(column);
  }
  return added;
}

/**
 * Columns declared in the `auditColumns` map inside server.js.
 * @param {string} serverSrc
 * @returns {Map<string, Set<string>>}
 */
function parseAuditColumns(serverSrc) {
  const added = new Map();
  const block = serverSrc.match(/const auditColumns = \{([\s\S]*?)\n\s*\};/);
  if (!block) return added;

  const entryRe = /(\w+):\s*\{([^}]*)\}/g;
  let match;
  while ((match = entryRe.exec(block[1])) !== null) {
    const [, table, body] = match;
    const columns = new Set();
    const colRe = /(\w+):\s*'/g;
    let col;
    while ((col = colRe.exec(body)) !== null) columns.add(col[1]);
    added.set(table, columns);
  }
  return added;
}

/**
 * Columns added via the `ensureColumn('table', 'column', ...)` helper in
 * server.js. That helper is the preferred idiom for new columns because it
 * checks INFORMATION_SCHEMA first, only anchors with `AFTER` when the anchor
 * column actually exists, and never fails silently — so the contract check has
 * to understand it, otherwise it reports phantom drift.
 * @param {string} serverSrc
 * @returns {Map<string, Set<string>>}
 */
function parseEnsureColumns(serverSrc) {
  const added = new Map();
  const add = (table, column) => {
    if (!added.has(table)) added.set(table, new Set());
    added.get(table).add(column);
  };

  const re = /ensureColumn\(\s*'([^']+)'\s*,\s*'([^']+)'/g;
  let match;
  while ((match = re.exec(serverSrc)) !== null) add(match[1], match[2]);

  // The same helper called in a loop over a literal list, which the pattern above
  // cannot see because its second argument is an identifier:
  //   for (const column of ['a', 'b']) { await ensureColumn('t', column, ...) }
  // Form 08's four signature columns are added exactly this way, so without this
  // the runtime check below would report them as drift that does not exist.
  const loopRe = /for\s*\(\s*const\s+(\w+)\s+of\s+\[([^\]]*)\]\s*\)\s*\{([\s\S]*?)\n\s*\}/g;
  let loop;
  while ((loop = loopRe.exec(serverSrc)) !== null) {
    const [, name, list, body] = loop;
    const call = body.match(new RegExp(`ensureColumn\\(\\s*'([^']+)'\\s*,\\s*${name}\\s*,`));
    if (!call) continue;
    for (const raw of list.split(',')) {
      const value = raw.trim().replace(/^['"]|['"]$/g, '');
      if (value) add(call[1], value);
    }
  }
  return added;
}

function mergeInto(target, source) {
  for (const [table, columns] of source) {
    if (!target.has(table)) target.set(table, new Set());
    for (const column of columns) target.get(table).add(column);
  }
  return target;
}

const schemaSrc = fs.readFileSync(SCHEMA_PATH, 'utf8');
const serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');

const knownColumns = mergeInto(
  mergeInto(
    mergeInto(
      mergeInto(parseCreateTables(schemaSrc), parseCreateTables(serverSrc)),
      parseAlters(serverSrc)
    ),
    parseEnsureColumns(serverSrc)
  ),
  parseAuditColumns(serverSrc)
);

/**
 * Columns an *already-provisioned* database actually ends up with.
 *
 * This deliberately omits `schema.sql`. Nothing executes it — server.js says so
 * itself — so a column declared only there reaches a fresh install and never a
 * deployed one. Merging it into `knownColumns` above is exactly what let
 * `assessments.psychosocialActivities` pass this suite while every live
 * verification of a violation with a Psychosocial Activity failed with
 *     ER_BAD_FIELD_ERROR: Unknown column 'psychosocialActivities' in 'field list'
 * `knownColumns` answers "is this column in the project's schema somewhere";
 * `runtimeColumns` answers "will this column exist on the deployed database".
 * Only the second question can fail in production.
 */
const SRC_DIR = path.resolve(__dirname, '../src');

/**
 * Every JavaScript source under `src/`. Not every table is created in server.js —
 * a controller may lazily `CREATE TABLE IF NOT EXISTS` its own (childController
 * creates childIdSequence, the Anecdotal Report controller creates
 * anecdotalReports), and those are just as much a runtime migration as a boot one.
 * Treating only server.js as the runtime would report both as drift.
 */
function readSrcSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(SRC_DIR);
  return out;
}

const runtimeColumns = (() => {
  const merged = new Map();
  for (const src of readSrcSources()) {
    mergeInto(merged, parseCreateTables(src));
    mergeInto(merged, parseAlters(src));
    mergeInto(merged, parseEnsureColumns(src));
  }
  return mergeInto(merged, parseAuditColumns(serverSrc));
})();

const schemaColumns = parseCreateTables(schemaSrc);

test('schema parser found the expected tables', () => {
  for (const table of ['children', 'staff', 'violations', 'healthRecords', 'documents', 'phaseProgress']) {
    assert.ok(knownColumns.has(table), `expected to parse table "${table}"`);
  }
  // Anti-vacuity guard. If the ensureColumn regex silently stops matching (a
  // rename, a reformat), the contract test below would start reporting phantom
  // drift instead of failing for a real reason — so assert it parses here.
  assert.ok(
    knownColumns.get('assessments')?.has('interventionTrackerId'),
    'expected to parse ensureColumn("assessments", "interventionTrackerId", ...)'
  );
  // The loop form has to parse too, or the runtime check below reports drift for
  // Form 08's signature columns, which are added that way.
  assert.ok(
    knownColumns.get('incidentReports')?.has('reportedBySignature'),
    'expected to parse ensureColumn("incidentReports", <loop variable>, ...)'
  );
});

test('every column the app writes is created by a RUNTIME migration', () => {
  // The failure this catches: a column added to schema.sql and to the code that
  // writes it, but never to a boot migration. schema.sql is not executed, so a
  // fresh database works and every deployed one throws ER_BAD_FIELD_ERROR the
  // moment that code path runs — which is how `assessments.psychosocialActivities`
  // broke violation verification in production.
  const problems = [];

  for (const [resource, config] of Object.entries(RESOURCES)) {
    const live = runtimeColumns.get(resource);
    // A table the runtime migration never creates is a different problem; skip it
    // here rather than reporting every one of its columns.
    if (!live) continue;

    for (const column of config.columns) {
      if (live.has(column)) continue;
      const onlyInSchema = (schemaColumns.get(resource) || new Set()).has(column);
      problems.push(
        `${resource}.${column}${onlyInSchema ? '  (declared in schema.sql, which nothing executes)' : ''}`
      );
    }
  }

  assert.deepEqual(
    problems,
    [],
    `These columns are written by the app but no runtime migration creates them,\n` +
      `so every deployed database is missing them:\n  ${problems.join('\n  ')}`
  );
});

test('assessments.psychosocialActivities is added by a runtime migration', () => {
  // Pinned by name because this one shipped: verification of a violation with a
  // Psychosocial Activity failed with
  //   Unknown column 'psychosocialActivities' in 'field list'
  assert.ok(
    runtimeColumns.get('assessments')?.has('psychosocialActivities'),
    'server.js must ensureColumn("assessments", "psychosocialActivities", ...) at boot'
  );
  assert.ok(
    /ensureColumn\(\s*'assessments'\s*,\s*'psychosocialActivities'/.test(serverSrc),
    'expected the ensureColumn call itself, not just a parsed column name'
  );
});

test('every declared resource column exists on its table', () => {
  const problems = [];

  for (const [resource, config] of Object.entries(RESOURCES)) {
    const columns = knownColumns.get(resource);
    // Resources without a table definition (e.g. computed/virtual resources)
    // are out of scope for this check.
    if (!columns) continue;

    for (const column of config.columns) {
      if (!columns.has(column)) {
        problems.push(`${resource}.${column}`);
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    `RESOURCES declares columns that do not exist in the database:\n  ${problems.join('\n  ')}`
  );
});

test('healthRecords no longer declares phantom vitals columns', () => {
  const declared = RESOURCES.healthRecords.columns;
  for (const phantom of ['bloodPressure', 'temperature', 'weight', 'height', 'pulse']) {
    assert.ok(!declared.includes(phantom), `healthRecords must not declare non-existent column "${phantom}"`);
  }
  // Columns the Medical Treatment / monitoring workflows actually persist.
  for (const required of ['treatmentType', 'procedure_', 'outcome', 'followUpDate', 'duration']) {
    assert.ok(declared.includes(required), `healthRecords must declare "${required}"`);
  }
});

test('audit columns written by baseController exist on every resource that declares them', () => {
  const problems = [];

  for (const [resource, config] of Object.entries(RESOURCES)) {
    const columns = knownColumns.get(resource);
    if (!columns) continue;
    for (const auditColumn of ['createdBy', 'modifiedBy']) {
      if (config.columns.includes(auditColumn) && !columns.has(auditColumn)) {
        problems.push(`${resource}.${auditColumn}`);
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    `baseController writes these audit columns but the tables lack them:\n  ${problems.join('\n  ')}`
  );
});
