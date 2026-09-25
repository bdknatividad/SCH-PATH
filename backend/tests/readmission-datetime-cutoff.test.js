/**
 * The `readmissionDatetime` cutoff must be written in MySQL's own shape.
 *
 * ## Why this file exists
 *
 * Re-intaking a force-discharged resident through the Admissions form failed
 * with a masked `{"message":"Database error occurred"}`. The UI cannot say more
 * than that: `middleware/errorHandler` maps every `ER_*` code to that one
 * sentence and drops the driver's message in production. The Railway runtime
 * log held the real error:
 *
 *   Incorrect datetime value: '2026-09-25T09:24:06.144Z'
 *   for column 'readmissionDatetime' at row 1
 *   path: '/api/admissions', method: 'POST'
 *
 * `new Date().toISOString()` is ISO 8601. The `T` separator, the trailing `Z`
 * and the fractional seconds are all things MySQL refuses for a DATETIME column
 * under its default strict sql_mode. The class had already been fixed for
 * `uploadedAt` and `startAt` — see tests/datetime-normalization.test.js, whose
 * opening comment describes this exact hazard — and these two writes were
 * missed. So this file guards the two sites *and* the class they belong to: a
 * third one would otherwise slip through the way these two did.
 *
 * Run: node --test tests/readmission-datetime-cutoff.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { toMysqlDateTime } = require('../src/utils/helpers');

const SRC = path.resolve(__dirname, '..', 'src');
const CONTROLLERS = path.join(SRC, 'controllers');
const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

/** Strip comments so prose about a hazard is never mistaken for the hazard. */
function withoutComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The `[ ... ]` parameter array of the statement containing `marker`.
 *
 * Found by bracket balancing rather than by slicing to the next `);`, so a
 * nested call — `JSON.stringify(previousCases)` sits in this very array — cannot
 * end the slice early and hide the value being asserted.
 */
function paramArrayAfter(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const open = source.indexOf('[', start);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

// ── The value ─────────────────────────────────────────────────────────────

test('the current instant is rendered in the shape MySQL accepts', () => {
  const value = toMysqlDateTime(new Date());

  assert.match(value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.ok(!value.includes('T'), 'the T separator must be gone');
  assert.ok(!value.includes('Z'), 'the Z suffix must be gone');
  assert.ok(!value.includes('.'), 'fractional seconds must be gone');
});

test('the raw ISO form it replaced is not that shape', () => {
  // The exact value from the production error. Asserted as an inequality with
  // the helper rather than as a property of the string, so this stays a test of
  // the fix and not of `Date`.
  const iso = '2026-09-25T09:24:06.144Z';
  assert.notEqual(toMysqlDateTime(iso), iso);
  assert.ok(!toMysqlDateTime(iso).includes('T'));
});

// ── The two write sites ───────────────────────────────────────────────────

test('the re-intake admission binds the cutoff through the helper', () => {
  // `POST /api/admissions` is the path the user actually hit. It re-intakes a
  // resident by updating the single `children` row they keep across admissions.
  const source = withoutComments(read('controllers', 'admissionController.js'));
  const params = paramArrayAfter(source, 'readmissionDatetime = ?');

  assert.ok(params, 'expected the UPDATE statement that sets readmissionDatetime');

  assert.match(
    params,
    /toMysqlDateTime\(/,
    'the cutoff must be bound through toMysqlDateTime, which renders the local '
      + 'wall-clock MySQL accepts',
  );
  assert.ok(
    !params.includes('toISOString'),
    'a raw ISO 8601 string is what MySQL rejects for this column',
  );
});

test('the legacy re-admission binds the cutoff through the helper', () => {
  // `POST /api/children/:id/readmit` is the older route to the same write. It
  // builds an `updateFields` map instead of a parameter array, so it needs its
  // own assertion — fixing only the newer route leaves it broken.
  const source = withoutComments(read('controllers', 'childController.js'));

  assert.match(
    source,
    /readmissionDatetime:\s*toMysqlDateTime\(/,
    'the cutoff must be bound through toMysqlDateTime',
  );
  assert.doesNotMatch(
    source,
    /readmissionDatetime:\s*new Date\(\)\.toISOString\(\)/,
    'the raw ISO form is what MySQL rejects for this column',
  );
});

// ── The class ─────────────────────────────────────────────────────────────
//
// The helper was introduced for `uploadedAt` and `startAt`, and these two sites
// were missed. A per-site pin alone would let the next one through, so the rule
// is asserted across every controller: a `toISOString()` result must never be
// left in a form that can reach a query.

/**
 * Values that are legitimately a raw ISO instant rather than a column value,
 * keyed `file:property`. Every entry needs a reason — this is the only place the
 * rule can be waived, so it has to stay short.
 */
const RAW_ISO_ALLOWED = new Set([
  // A field of the DSWD report payload handed to the client as JSON. Only
  // `dswdReport.statistics` is persisted (`JSON.stringify(...)` into the
  // `summary` column) and `generatedAt` sits beside it, not inside it, so there
  // is no query this value can reach.
  'reportController.js:generatedAt',
]);

/** A `toISOString()` result reduced to a DATE, or to MySQL's datetime shape. */
const REDUCED = /^\.(?:split\('T'\)\[0\]|slice\(0,\s*(?:10|19)\)(?:\.replace\('T',\s*' '\))?)/;

test('no controller produces an ISO instant that could reach a query', () => {
  const offenders = [];
  const seen = new Set();

  for (const file of fs.readdirSync(CONTROLLERS).filter((f) => f.endsWith('.js')).sort()) {
    const source = withoutComments(fs.readFileSync(path.join(CONTROLLERS, file), 'utf8'));
    const re = /toISOString\(\)/g;
    let match;

    while ((match = re.exec(source)) !== null) {
      const after = source.slice(match.index + match[0].length);
      if (REDUCED.test(after)) continue;

      // Name the offender by the property it is assigned to when there is one,
      // so the allowlist key does not depend on a line number.
      const lineStart = source.lastIndexOf('\n', match.index) + 1;
      const named = /(\w+)\s*:\s*[^;]*$/.exec(source.slice(lineStart, match.index));

      const id = `${file}:${named ? named[1] : '(bare)'}`;
      seen.add(id);
      if (!RAW_ISO_ALLOWED.has(id)) offenders.push(id);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these build an ISO 8601 instant that MySQL rejects for a DATETIME column — '
      + 'wrap it in toMysqlDateTime() or reduce it to a date:\n'
      + offenders.join('\n'),
  );

  // A waiver that no longer matches anything is a leftover for a value that has
  // moved or gone, and keeping it would let a real offender reuse the name
  // unnoticed. This also proves the sweep actually reached the file it names,
  // so an empty offender list cannot be vacuous.
  const stale = [...RAW_ISO_ALLOWED].filter((id) => !seen.has(id));
  assert.deepEqual(
    stale,
    [],
    'these allowlist entries no longer match anything and must be removed:\n'
      + stale.join('\n'),
  );
});
