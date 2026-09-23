/**
 * Guards the boot-time migration path in `server.js`.
 *
 * ## Why this file exists
 *
 * `runMigrations()` and its helpers are the only code that puts an
 * `admissionId` on documents and phase rows that predate the column. Nothing
 * else backfills them. But nothing loaded `server.js` either — every test
 * imports the controllers and helpers the routes use, so the boot path was
 * untested and a `ReferenceError` inside it was invisible.
 *
 * That is not hypothetical: both `backfillDocumentAdmissions` and
 * `backfillPhaseProgressAdmissions` called `pool.query(...)` while `pool` was
 * only ever imported *inside* the cron callbacks further down the file. Every
 * boot logged
 *
 *   Migration warning (documents admission backfill): pool is not defined
 *
 * and carried on. The `catch` that turns the failure into a warning is correct
 * — a migration problem should not stop the server from starting — but it also
 * meant a fresh production database would keep every legacy document at
 * `admissionId = NULL`, which is the exact condition the returning-resident fix
 * exists to prevent: the folder resolver has nothing to group on and documents
 * merge across admissions again.
 *
 * So this test asserts the shape that was broken, statically: any identifier a
 * migration helper calls a method on must be in scope at module level. It does
 * not need a database, which is what lets it run in the normal suite.
 *
 * Run: node --test tests/boot-migrations.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..', 'src', 'server.js');
const source = fs.readFileSync(SERVER, 'utf8');

/** The body of a top-level `async function name()`, by brace balancing. */
function functionBody(code, name) {
  const start = code.indexOf(`async function ${name}(`);
  if (start === -1) return null;
  const open = code.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return null;
}

test('every migration helper can reach the database pool', () => {
  // The helpers that write a link onto existing rows. Each is called from
  // `runMigrations()` at boot and none of them takes `pool` as a parameter.
  const helpers = [
    'backfillDocumentAdmissions',
    'backfillPhaseProgressAdmissions',
  ];

  for (const name of helpers) {
    const body = functionBody(source, name);
    assert.ok(body, `expected ${name} in server.js`);

    for (const handle of ['pool', 'connection']) {
      if (!new RegExp(`\\b${handle}\\.(query|execute)\\(`).test(body)) continue;

      // It calls `handle.query(...)`, so `handle` has to resolve. A top-level
      // `const { pool } = require('./config/database')` is what makes it work;
      // a `require` inside a later cron callback does not.
      const importedAtTopLevel = new RegExp(
        `^const \\{[^}]*\\b${handle}\\b[^}]*\\} = require\\(`, 'm',
      ).test(source);

      assert.ok(
        importedAtTopLevel,
        `${name}() calls ${handle}.query(...) but ${handle} is not imported at ` +
          'module level — the call throws, the catch turns it into a warning, ' +
          'and the backfill silently never runs. Import it at the top of ' +
          'server.js, not inside a function.',
      );
    }
  }
});

test('the admission backfills are actually invoked during boot', () => {
  // A helper that is defined but never called is the same outcome as one that
  // throws: rows keep their NULL link.
  const migrations = functionBody(source, 'runMigrations');
  assert.ok(migrations, 'expected runMigrations');

  for (const call of [
    'backfillDocumentAdmissions()',
    'backfillPhaseProgressAdmissions()',
  ]) {
    assert.ok(
      migrations.includes(call),
      `runMigrations() must call ${call}, or legacy rows never get an admission ` +
        'link and the folder resolver merges them across admissions',
    );
  }
});

test('a migration failure is a warning, not a crash', () => {
  // Both helpers swallow their errors on purpose: a schema problem in one
  // backfill must not stop the API from serving. If somebody changes this to a
  // rethrow, a boot on an unusual database becomes a total outage.
  for (const name of ['backfillDocumentAdmissions', 'backfillPhaseProgressAdmissions']) {
    const body = functionBody(source, name);
    assert.ok(body, `expected ${name}`);
    assert.match(
      body,
      /catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?console\.warn\(/,
      `${name}() must catch and warn rather than throw, so a migration problem ` +
        'degrades one feature instead of preventing the server from starting',
    );
  }
});

test('the migrations that add the admission column run before the backfill', () => {
  // Ordering matters: backfilling into a column that does not exist yet fails,
  // and the failure is only a warning, so it would be easy to miss.
  const migrations = functionBody(source, 'runMigrations');
  assert.ok(migrations, 'expected runMigrations');

  const columnAt = migrations.indexOf("'admissionId'");
  const backfillAt = migrations.indexOf('backfillDocumentAdmissions()');

  assert.ok(columnAt !== -1, 'expected runMigrations to ensure the admissionId column');
  assert.ok(backfillAt !== -1, 'expected runMigrations to call the documents backfill');
  assert.ok(
    columnAt < backfillAt,
    'the admissionId column must be added before the backfill writes to it',
  );
});
