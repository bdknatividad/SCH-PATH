/**
 * The shape of a datetime value on its way into MySQL.
 *
 * ## Why this file exists
 *
 * Every write from the browser sends timestamps as `new Date().toISOString()`:
 *
 *   2026-09-23T07:04:36.462Z
 *
 * That is valid ISO 8601 and it is not a value MySQL accepts for a DATETIME,
 * TIMESTAMP or DATE column. MySQL 8+ runs a strict `sql_mode` by default, so
 * the statement is rejected and the whole write fails:
 *
 *   Error: Incorrect datetime value: '2026-09-23T07:04:36.462Z'
 *          for column 'uploadedAt' at row 1
 *
 * Both the `T` separator and the trailing `Z` are refused; a datetime column
 * wants `YYYY-MM-DD HH:MM:SS`.
 *
 * This was found in a live deploy log, not by reading code — two separate
 * writes failed on two different columns in the same request, which is the
 * signature of a class of bug rather than one mistake:
 *
 *   /api/documents              -> uploadedAt
 *   /api/resident-assignments   -> startAt
 *
 * So the tests below are about the *class*: the helper must coerce anything a
 * browser can produce, and every controller that binds a request body must
 * actually run it through that helper.
 *
 * Run: node --test tests/datetime-normalization.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { toMysqlDateTime, normalizeDatetimes } = require('../src/utils/helpers');

const SRC = path.resolve(__dirname, '..', 'src');
const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

/** Strip comments so prose about a hazard is never mistaken for the hazard. */
function withoutComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── The helper ────────────────────────────────────────────────────────────

test('an ISO 8601 instant is converted to MySQL datetime format', () => {
  // The exact value from the production error.
  const result = toMysqlDateTime('2026-09-23T07:04:36.462Z');

  assert.match(
    result,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    'must be YYYY-MM-DD HH:MM:SS — no T, no Z, no milliseconds',
  );
  assert.ok(!result.includes('T'), 'the T separator must be gone');
  assert.ok(!result.includes('Z'), 'the Z suffix must be gone');
  assert.ok(!result.includes('.'), 'fractional seconds must be gone');
});

test('the conversion preserves the instant, it does not merely reformat', () => {
  // A helper that dropped the zone would silently shift every timestamp. Parse
  // both sides as instants and compare: 07:04:36Z is 15:04:36 in UTC+8, and
  // the stored string is read back as local time, so the two must agree.
  const iso = '2026-09-23T07:04:36.462Z';
  const [datePart, timePart] = toMysqlDateTime(iso).split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);

  const roundTripped = new Date(y, mo - 1, d, h, mi, s);
  const original = new Date(iso);

  assert.equal(
    roundTripped.getTime(),
    new Date(original.getFullYear(), original.getMonth(), original.getDate(),
      original.getHours(), original.getMinutes(), original.getSeconds()).getTime(),
    'the local wall-clock of the result must match the local wall-clock of the input',
  );
});

test('a value already in MySQL format passes through untouched', () => {
  // Idempotence matters: these strings are also read back from the database and
  // re-sent by the client on the next save. A second pass must not alter them.
  for (const value of [
    '2026-09-23 07:04:36',
    '2026-09-23 07:04',
    '2026-09-23',
    '2026-09-23 07:04:36.462',
  ]) {
    assert.equal(toMysqlDateTime(value), value, `${value} must be unchanged`);
  }
});

test('the result of a conversion is itself stable', () => {
  // Feeding the output back in must be a no-op, or every subsequent save of the
  // same record would drift.
  const once = toMysqlDateTime('2026-09-23T07:04:36.462Z');
  assert.equal(toMysqlDateTime(once), once);
});

test('null and undefined survive, because the columns are nullable', () => {
  // A nullable DATETIME must stay NULL rather than becoming the epoch or the
  // string "Invalid Date".
  assert.equal(toMysqlDateTime(null), null);
  assert.equal(toMysqlDateTime(undefined), undefined);
});

test('an unparseable value is passed through so MySQL reports the real error', () => {
  // Deliberately not coerced to null. Substituting NULL would store a wrong
  // value and hide the caller's bug; letting MySQL reject it surfaces the
  // offending column and value in the log.
  assert.equal(toMysqlDateTime('not a date'), 'not a date');
  assert.equal(toMysqlDateTime(''), '');
});

test('a Date object is converted rather than left to the driver', () => {
  const d = new Date(2026, 8, 23, 15, 4, 36); // 2026-09-23 15:04:36 local
  assert.equal(toMysqlDateTime(d), '2026-09-23 15:04:36');
});

test('normalizeDatetimes rewrites only the datetime-looking keys', () => {
  const input = {
    uploadedAt: '2026-09-23T07:04:36.462Z',
    startAt: '2026-09-23T07:04:37.531Z',
    admissionDate: '2026-09-23',
    expiryDate: '2026-09-23',
    title: 'Admission Slip',
    createdAt: '2026-09-23T07:04:36.462Z',
    count: 3,
  };

  const out = normalizeDatetimes(input);

  assert.ok(!out.uploadedAt.includes('T'), 'uploadedAt must be coerced');
  assert.ok(!out.startAt.includes('T'), 'startAt must be coerced');
  assert.ok(!out.createdAt.includes('T'), 'createdAt must be coerced');
  // DATE columns, not datetimes. Coercing these would be harmless today but
  // wrong in principle, and the pattern excludes them on purpose.
  assert.equal(out.admissionDate, '2026-09-23');
  assert.equal(out.expiryDate, '2026-09-23');
  assert.equal(out.title, 'Admission Slip');
  assert.equal(out.count, 3);
});

test('normalizeDatetimes does not mutate the body it was given', () => {
  // Request bodies are logged on error. A mutated one would not show what the
  // client actually sent, which is exactly what you need when diagnosing a 500.
  const input = { uploadedAt: '2026-09-23T07:04:36.462Z' };
  const out = normalizeDatetimes(input);

  assert.notEqual(out, input, 'must return a copy');
  assert.equal(input.uploadedAt, '2026-09-23T07:04:36.462Z', 'the original must be untouched');
});

test('normalizeDatetimes leaves non-objects alone', () => {
  assert.equal(normalizeDatetimes(null), null);
  assert.equal(normalizeDatetimes(undefined), undefined);
  assert.equal(normalizeDatetimes('a string'), 'a string');
});

// ── The call sites ────────────────────────────────────────────────────────
//
// The helper being correct is not enough. A controller that binds `req.body`
// without calling it reproduces the original failure exactly, and nothing about
// the helper's own tests would catch that.

test('the generic controller normalizes before binding on create and update', () => {
  const source = withoutComments(read('controllers', 'baseController.js'));

  const createAt = source.search(/async create\s*\(/);
  const updateAt = source.search(/async update\s*\(/);
  assert.ok(createAt !== -1, 'expected baseController.create');
  assert.ok(updateAt !== -1, 'expected baseController.update');

  // Both must assign `data` from normalizeDatetimes rather than from req.body.
  const createBody = source.slice(createAt, updateAt);
  assert.match(
    createBody,
    /const data = normalizeDatetimes\(req\.body/,
    'create() must normalize the body — RESOURCES resources bind it directly',
  );
  assert.match(
    source.slice(updateAt),
    /const data = normalizeDatetimes\(req\.body/,
    'update() must normalize the body, or a partial save fails on any *At column',
  );
});

test('the document controller normalizes, because it binds the body itself', () => {
  const source = withoutComments(read('controllers', 'documentController.js'));

  assert.match(
    source,
    /function create\(req, res, next\)[\s\S]{0,900}const data = normalizeDatetimes\(req\.body/,
    'documentController.create must normalize — it does not delegate to the generic controller',
  );
});

test('the assignment controller coerces startAt and endAt', () => {
  // It destructures the two fields by name instead of normalizing the whole
  // body, so this asserts those two names specifically. `startAt` is used in
  // the endAt ordering check as well as the INSERT, and both must see the
  // coerced value or the comparison and the stored value disagree.
  const source = withoutComments(read('controllers', 'assignmentController.js'));

  assert.match(
    source,
    /startAt:\s*rawStartAt[\s\S]{0,300}const startAt = toMysqlDateTime\(rawStartAt\)/,
    'create() must coerce startAt before validating or inserting it',
  );
  assert.match(
    source,
    /endAt:\s*rawEndAt[\s\S]{0,400}const endAt = toMysqlDateTime\(rawEndAt\)/,
    'create() must coerce endAt',
  );
});

// ── The scoping bug found in the same log ─────────────────────────────────

test('the admission notification can see the admission number it reports', () => {
  // Alongside the datetime failures the same request logged:
  //
  //   [AdmissionController] Admission notification failed (non-fatal):
  //   admissionNumber is not defined
  //
  // `admissionNumber` was declared inside the transaction callback and read
  // after it, so every admission notification threw a ReferenceError. The
  // surrounding try/catch turned it into a warning, so admissions appeared to
  // succeed while no Center Head was ever told a resident had arrived.
  const source = withoutComments(read('controllers', 'admissionController.js'));

  // It must be destructured from the transaction's return value...
  assert.match(
    source,
    /const \{[^}]*\badmissionNumber\b[^}]*\}\s*=\s*await runInTransactionWithIdRetry/,
    'admissionNumber must come out of the transaction, not be referenced from inside it',
  );

  // ...and the transaction must actually return it.
  assert.match(
    source,
    /return \{[^}]*\badmissionNumber\b[^}]*\}/,
    'the transaction callback must return admissionNumber',
  );
});

test('every variable destructured from a transaction is declared there', () => {
  // Guards the general shape of the bug above, in every controller, rather
  // than only the one instance that was reported.
  const files = fs.readdirSync(path.join(SRC, 'controllers')).filter((f) => f.endsWith('.js'));
  const problems = [];

  for (const file of files) {
    const source = withoutComments(fs.readFileSync(path.join(SRC, 'controllers', file), 'utf8'));

    // const { a, b } = await runInTransactionWithIdRetry(pool, async (connection) => {
    const re = /const\s*\{([^}]*)\}\s*=\s*await runInTransactionWithIdRetry\([^,]+,\s*async\s*\([^)]*\)\s*=>\s*\{/g;
    let match;
    while ((match = re.exec(source)) !== null) {
      const names = match[1]
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (names.length === 0) continue;

      // Take the callback body by brace balancing, then check each name appears
      // in a `return { ... }` inside it.
      const open = source.indexOf('{', match.index + match[0].length - 1);
      let depth = 0;
      let end = -1;
      for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
          depth -= 1;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end === -1) continue;
      const body = source.slice(open, end);

      const returned = new Set();
      const retRe = /return\s*\{([^}]*)\}/g;
      let retMatch;
      while ((retMatch = retRe.exec(body)) !== null) {
        retMatch[1].split(',').forEach((p) => {
          const name = p.split(':')[0].trim();
          if (name) returned.add(name);
        });
      }

      for (const name of names) {
        if (!returned.has(name)) {
          problems.push(`${file}: "${name}" is destructured but the transaction never returns it`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});
