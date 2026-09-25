/**
 * Guards for the DATETIME columns that hold the facility's wall-clock.
 *
 * `utils/serverTime.js` labels a timezone-less MySQL datetime with the
 * *database's* offset, on the premise that the database holds UTC. That premise
 * is true for every timestamp the server writes. It is false for a column the
 * user fills from a `datetime-local` control: the control has no zone, its
 * value goes to MySQL as a naive string, and `toMysqlDateTime` passes a naive
 * string through — so the column holds the wall-clock the user typed.
 *
 * Reading such a column as UTC moves it eight hours, which is the same defect
 * the module was written to remove. These tests pin the distinction, and pin
 * the consumer that would show it: the Intervention Tracker renders
 * `new Date(step.scheduledAt).toLocaleString()`, so `scheduledAt` has to name
 * the instant the user picked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  withIsoInstants,
  toIsoInstant,
  offsetForColumn,
  isMysqlDatetime,
  MYSQL_DATETIME,
  WALL_CLOCK_DATETIME_COLUMNS,
  setFacilityZone,
  getFacilityOffsetMinutes,
} = require('../src/utils/serverTime');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COMPONENTS = path.join(REPO_ROOT, 'frontend', 'src', 'app', 'components');
const read = (file) => fs.readFileSync(file, 'utf8');

/** `2026-09-25T14:32:00.000+08:00` rendered on a Manila clock. */
function manilaClock(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(iso));
}

// ── the two classes ────────────────────────────────────────────────────────

test('a server-produced instant is labelled with the database zone', () => {
  // `submittedAt` is `NOW()` — UTC wall-clock, so `Z` is the honest label.
  assert.equal(toIsoInstant('2026-09-25 06:32:02'), '2026-09-25T06:32:02.000Z');
});

test('a wall-clock column is labelled with the facility offset', () => {
  assert.equal(
    toIsoInstant('2026-09-25 14:32:00', offsetForColumn('scheduledAt')),
    '2026-09-25T14:32:00.000+08:00'
  );
});

test('the wall-clock label keeps the clock the user typed', () => {
  // The whole point: 14:32 stays 14:32 on a Manila clock. Read as UTC it would
  // come back as 22:32.
  const emitted = withIsoInstants({ scheduledAt: '2026-09-25 14:32:00' }).scheduledAt;
  assert.match(manilaClock(emitted), /^25\/09\/2026, 14:32:00$/);
  assert.notEqual(
    manilaClock(emitted),
    '25/09/2026, 22:32:00',
    'the wall-clock was labelled UTC, which moves it eight hours'
  );
});

test('the wall-clock label is not a lie about the instant', () => {
  // `+08:00` is only correct if it resolves to the same instant Manila means.
  assert.equal(
    new Date('2026-09-25T14:32:00.000+08:00').toISOString(),
    '2026-09-25T06:32:00.000Z'
  );
});

test('both wall-clock columns are covered', () => {
  const row = withIsoInstants({
    incidentDateTime: '2026-09-25 14:32:00',
    scheduledAt: '2026-09-25 09:05:00',
  });
  assert.equal(row.incidentDateTime, '2026-09-25T14:32:00.000+08:00');
  assert.equal(row.scheduledAt, '2026-09-25T09:05:00.000+08:00');
});

test('the list holds exactly the columns the browser types into', () => {
  // Asserted as a whole so that adding one is a deliberate, reviewed act rather
  // than a quiet edit — a column wrongly left out is read as UTC and lands
  // eight hours out with nothing to point at.
  assert.deepEqual(
    [...WALL_CLOCK_DATETIME_COLUMNS].sort(),
    ['incidentDateTime', 'scheduledAt']
  );
});

// ── the walk ───────────────────────────────────────────────────────────────

test('a column is recognised at its own level, not by a parent key', () => {
  // Rows arrive nested (`{ data: [ { … } ] }`) and the column name is the
  // property that holds the value.
  const body = { data: [{ id: 'TRI001', scheduledAt: '2026-09-25 14:32:00', submittedAt: '2026-09-25 06:32:02' }] };
  const row = withIsoInstants(body).data[0];

  assert.equal(row.scheduledAt, '2026-09-25T14:32:00.000+08:00');
  assert.equal(row.submittedAt, '2026-09-25T06:32:02.000Z');
});

test('a nested object is walked with its own keys', () => {
  const out = withIsoInstants({ record: { incidentDateTime: '2026-09-25 14:32:00' } });
  assert.equal(out.record.incidentDateTime, '2026-09-25T14:32:00.000+08:00');
});

test('a key that merely looks similar is not converted', () => {
  // `scheduledAtDate` is a different column; the set matches exactly.
  assert.equal(offsetForColumn('scheduledAtDate'), 0);
  assert.equal(offsetForColumn('incidentDateTimeUtc'), 0);
  assert.equal(offsetForColumn(undefined), 0);
});

test('the walk still copies rather than mutates', () => {
  const original = { scheduledAt: '2026-09-25 14:32:00' };
  const out = withIsoInstants(original);
  assert.equal(original.scheduledAt, '2026-09-25 14:32:00');
  assert.notEqual(out, original);
});

test('a DATE is still untouched whatever the column', () => {
  const out = withIsoInstants({ reportDate: '2026-09-25', date: '2026-09-25' });
  assert.equal(out.reportDate, '2026-09-25');
  assert.equal(out.date, '2026-09-25');
});

test('the datetime pattern itself rejects a bare DATE', () => {
  // Asserted against the pattern, not only through `withIsoInstants`. A DATE is
  // ten characters and `toIsoInstant` returns early below nineteen, so the walk
  // never reaches the regex — a pattern that wrongly accepted `2026-09-25`
  // would leave the walk-level test above passing for the wrong reason.
  assert.equal(isMysqlDatetime('2026-09-25'), false);
  assert.equal(MYSQL_DATETIME.test('2026-09-25'), false);
  assert.equal(MYSQL_DATETIME.test('2026-09-25 14:32'), false, 'a time needs seconds');
  assert.equal(MYSQL_DATETIME.test('2026-09-25T14:32:00'), true);
  assert.equal(MYSQL_DATETIME.test('2026-09-25 14:32:00'), true);
  assert.equal(MYSQL_DATETIME.test('2026-09-25 14:32:00.123456'), true);
  // Already unambiguous — must not be given a second offset.
  assert.equal(MYSQL_DATETIME.test('2026-09-25T14:32:00.000Z'), false);
  assert.equal(MYSQL_DATETIME.test('2026-09-25T14:32:00.000+08:00'), false);
});

test('a value that already carries an offset is left alone', () => {
  const already = '2026-09-25T14:32:00.000+08:00';
  assert.equal(withIsoInstants({ scheduledAt: already }).scheduledAt, already);
});

test('the facility zone is state, not a literal in the formatter', () => {
  assert.equal(getFacilityOffsetMinutes(), 480);
  try {
    setFacilityZone({ offsetMinutes: 540, label: 'Asia/Tokyo' });
    assert.equal(
      withIsoInstants({ scheduledAt: '2026-09-25 14:32:00' }).scheduledAt,
      '2026-09-25T14:32:00.000+09:00'
    );
    // The instant columns are unaffected — they follow the database, not the facility.
    assert.equal(
      withIsoInstants({ submittedAt: '2026-09-25 14:32:00' }).submittedAt,
      '2026-09-25T14:32:00.000Z'
    );
  } finally {
    setFacilityZone();
  }
  assert.equal(getFacilityOffsetMinutes(), 480);
});

// ── the consumers ──────────────────────────────────────────────────────────

test('the Intervention Tracker reads the schedule with new Date', () => {
  // The consumer that made this necessary. If it ever stops parsing the value,
  // the label stops mattering — so it is pinned alongside.
  const source = read(path.join(COMPONENTS, 'InterventionTracker.tsx'));
  assert.match(
    source,
    /Scheduled:\s*\{new Date\(step\.scheduledAt\)\.toLocaleString\(\)\}/,
    'the tracker no longer parses the schedule, so this file may be pinning nothing'
  );
});

test('the schedule picker still sends the raw control value', () => {
  // `datetime-local` has no zone. Sending `toISOString()` here instead would
  // make the column a real UTC instant and invalidate the wall-clock label.
  const tracker = read(path.join(COMPONENTS, 'InterventionTracker.tsx'));
  assert.match(
    tracker,
    /body:\s*JSON\.stringify\(\{\s*scheduledAt:\s*scheduleValue\s*\}\)/,
    'the tracker no longer sends the raw datetime-local value'
  );

  const violations = read(path.join(COMPONENTS, 'Violations.tsx'));
  assert.match(
    violations,
    /scheduleDateTime:\s*requirementNeedsSchedule\s*\?\s*reviewForm\.scheduleDateTime\s*:\s*null/,
    'the verification dialog no longer sends the raw datetime-local value'
  );
});

test('Form 08 still sends the control value, not an instant', () => {
  const source = read(path.join(COMPONENTS, 'IncidentReportModal.tsx'));
  assert.match(
    source,
    /form\.incidentDateTime\.replace\('T', ' '\)/,
    'Form 08 no longer sends the naive control value, so incidentDateTime is no longer wall-clock'
  );
  // And it must still read back with a plain slice — the day and clock are at
  // the front of the string either way.
  assert.match(
    source,
    /incidentDateTime:\s*String\(r\.incidentDateTime \|\| ''\)\.replace\(' ', 'T'\)\.slice\(0, 16\)/,
    'Form 08 no longer loads the stored value into the control'
  );
});
