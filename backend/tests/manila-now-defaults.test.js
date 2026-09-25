/**
 * Guards for "the current moment" in the facility's timezone.
 *
 * The response-boundary fix (`middleware/isoTimestamps`) settled what a stored
 * instant means on the wire. This file covers the other half: the values the
 * browser *invents* — the today/now defaults seeded into a form before the user
 * has typed anything.
 *
 * Those were derived from `new Date().toISOString()`, which is UTC. Manila is
 * UTC+8, so:
 *
 *   - `toISOString().slice(0, 10)` is the UTC *day*. Between 00:00 and 07:59
 *     Manila it is still yesterday, so an Anecdotal Report opened during the
 *     first hour of the working day was dated the day before.
 *   - `toISOString().slice(0, 16)` is the UTC *wall-clock*. A `datetime-local`
 *     reads its value as wall-clock, so Form 08 offered 06:40 AM as the incident
 *     time on a form opened at 2:40 PM.
 *
 * The backend already had this rule — `tri-deadline-reminder.test.js` asserts
 * the reminder service computes today in Manila — but the frontend did not, so
 * the same defect kept reappearing one component at a time.
 *
 * `dateFormatter.ts` is TypeScript with no imports, so it is loaded here with
 * the frontend's own compiler. A source-level assertion could not tell a Manila
 * hour from a UTC one; running the shipped function can.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND = path.join(REPO_ROOT, 'frontend');
const FORMATTER = path.join(FRONTEND, 'src', 'utils', 'dateFormatter.ts');
const COMPONENTS = path.join(FRONTEND, 'src', 'app', 'components');

const read = (file) => fs.readFileSync(file, 'utf8');

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

// ── Loading the TypeScript formatter ───────────────────────────────────────
//
// `ts.transpileModule` is the same compiler the build uses, so the loaded module
// is the shipped logic rather than a re-implementation of it.

function loadFormatter() {
  const tsPath = path.join(FRONTEND, 'node_modules', 'typescript');
  let ts;
  try {
    ts = require(tsPath);
  } catch (error) {
    throw new Error(
      `the frontend's TypeScript is required to load ${path.relative(REPO_ROOT, FORMATTER)}: ${error.message}`
    );
  }

  const { outputText } = ts.transpileModule(read(FORMATTER), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: FORMATTER,
  });

  const loaded = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(loaded, loaded.exports, require);
  return loaded.exports;
}

const { getCurrentPHDate, getCurrentPHDateTime } = loadFormatter();

/** The instant a `YYYY-MM-DDTHH:MM` wall-clock names, read as if it were UTC. */
function wallClockAsUtcMs(stamp) {
  const [day, time] = stamp.split('T');
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm);
}

// ── getCurrentPHDate ───────────────────────────────────────────────────────

test('getCurrentPHDate returns a bare calendar day', () => {
  const value = getCurrentPHDate();
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/, `${value} is not a YYYY-MM-DD day`);
});

test('getCurrentPHDate is Manila\'s day, computed independently', () => {
  // Built from `Intl` here rather than from the function under test, so a
  // timezone that drifts shows up as a disagreement instead of agreeing with
  // itself.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const pick = (type) => parts.find((p) => p.type === type).value;
  const expected = `${pick('year')}-${pick('month')}-${pick('day')}`;

  assert.equal(getCurrentPHDate(), expected);
});

test('getCurrentPHDate does not fall back to the UTC day', () => {
  // The two differ for the last eight hours of every UTC day, so this only
  // bites in that window — but the source check below covers the rest of the
  // clock, and together they cannot both pass on a UTC implementation.
  const utcDay = new Date().toISOString().slice(0, 10);
  const manilaDay = getCurrentPHDate();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const pick = (type) => parts.find((p) => p.type === type).value;
  const expectedManila = `${pick('year')}-${pick('month')}-${pick('day')}`;

  if (utcDay !== expectedManila) {
    assert.notEqual(manilaDay, utcDay, 'the UTC day leaked into the Manila day');
  }
  assert.equal(manilaDay, expectedManila);
});

test('the formatter names the facility timezone rather than the machine\'s', () => {
  const source = read(FORMATTER);
  assert.match(source, /timeZone:\s*'Asia\/Manila'/, 'the formatter no longer pins Asia/Manila');
});

// ── getCurrentPHDateTime ───────────────────────────────────────────────────

test('getCurrentPHDateTime is shaped for a datetime-local input', () => {
  const value = getCurrentPHDateTime();
  // The shape is the assertion that matters: `en-CA` without `hour12: false`
  // renders "02:40 p.m.", which a `datetime-local` rejects as an empty value.
  assert.match(
    value,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    `${value} is not the YYYY-MM-DDTHH:MM a datetime-local requires`
  );
});

test('getCurrentPHDateTime never emits an hour outside 00-23', () => {
  // `hour12: false` reports midnight as "24" on some engines, and a
  // `datetime-local` silently blanks on 24:05.
  const hour = Number(getCurrentPHDateTime().slice(11, 13));
  assert.ok(hour >= 0 && hour <= 23, `hour ${hour} is outside the accepted range`);
});

test('getCurrentPHDateTime is now in Manila, not now in UTC', () => {
  const before = Date.now();
  const value = getCurrentPHDateTime();
  const after = Date.now();

  const got = wallClockAsUtcMs(value);
  // Reading the wall-clock as UTC gives the instant that wears it. For a Manila
  // wall-clock that instant is now + 8h, so the offset is the assertion. A UTC
  // implementation lands ~28,800,000 ms away — far outside the tolerance, which
  // only has to absorb the minute truncation and the two clock reads.
  const drift = got - (before + MANILA_OFFSET_MS);
  assert.ok(
    Math.abs(drift) < 120000,
    `${value} is ${(drift / 3600000).toFixed(2)}h from now+8h, so it is not Manila wall-clock`
  );
  assert.ok(got >= before + MANILA_OFFSET_MS - 120000 && got <= after + MANILA_OFFSET_MS + 120000);
});

test('getCurrentPHDateTime is not the UTC truncation it replaced', () => {
  // The exact expression that shipped the bug.
  const utc = new Date().toISOString().slice(0, 16);
  assert.notEqual(
    getCurrentPHDateTime(),
    utc,
    'the default is back to the UTC wall-clock, which is eight hours early in Manila'
  );
});

test('getCurrentPHDateTime and getCurrentPHDate agree on the day', () => {
  assert.equal(getCurrentPHDateTime().slice(0, 10), getCurrentPHDate());
});

// ── the call sites ─────────────────────────────────────────────────────────

test('the Anecdotal Report editor dates a new report with the facility\'s today', () => {
  const source = read(path.join(COMPONENTS, 'AnecdotalReport.tsx'));

  assert.doesNotMatch(
    source,
    /reportDate\s*[^;]*toISOString\(\)/,
    'reportDate is derived from an ISO instant again, which is the previous day in Manila ' +
      'for the first eight hours of every day'
  );
  assert.match(
    source,
    /reportDate\s*\|\|\s*getCurrentPHDate\(\)/,
    'the report date default no longer uses the Manila day helper'
  );
  assert.match(
    source,
    /getCurrentPHDate\(\)\.slice\(5, 7\)/,
    'the reporting month is no longer taken from the Manila day'
  );
  assert.match(
    source,
    /getCurrentPHDate\(\)\.slice\(0, 4\)/,
    'the reporting year is no longer taken from the Manila day'
  );
});

test('Form 08 seeds its incident time from the Manila wall-clock', () => {
  const source = read(path.join(COMPONENTS, 'IncidentReportModal.tsx'));

  assert.doesNotMatch(
    source,
    /incidentDateTime:\s*new Date\(\)\.toISOString\(\)/,
    'the incident time default is the UTC wall-clock again, so the form opens eight hours early'
  );
  assert.match(
    source,
    /incidentDateTime:\s*getCurrentPHDateTime\(\)/,
    'the incident time default no longer uses the Manila wall-clock helper'
  );
});

test('the intervention scheduler bounds its input with the Manila wall-clock', () => {
  const source = read(path.join(COMPONENTS, 'InterventionTracker.tsx'));

  assert.match(
    source,
    /type="datetime-local"[^>]*min=\{getCurrentPHDateTime\(\)\}/,
    'the schedule picker is bounded by the UTC wall-clock again, which is eight hours in the past'
  );
});

test('no component seeds a datetime-local from toISOString', () => {
  // The general form of the Form 08 bug: `toISOString()` carries a zone, a
  // `datetime-local` does not, and the eight-hour gap lands on the user.
  const offenders = [];
  for (const entry of fs.readdirSync(COMPONENTS)) {
    if (!entry.endsWith('.tsx')) continue;
    const source = read(path.join(COMPONENTS, entry));
    // A truncation used as the *value* of a datetime-local, or as a
    // `min`/`max` bound on one.
    if (/type="datetime-local"[\s\S]{0,200}?toISOString\(\)\.slice\(0,\s*16\)/.test(source)) {
      offenders.push(entry);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these components bound a datetime-local with a UTC instant: ${offenders.join(', ')}`
  );
});
