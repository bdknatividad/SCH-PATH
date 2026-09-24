/**
 * "Upcoming" is a calendar day, not an instant.
 *
 * `hearingDate` comes from an `<input type="date">`, is stored in a MySQL DATE
 * column, and reaches the SPA as `YYYY-MM-DD` (the pool runs with
 * `dateStrings: true` and `mapRow` strips any time half). So it is a calendar
 * day with no timezone at all.
 *
 * Both "upcoming hearings" lists compared it against the current instant:
 *
 *     new Date(r.hearingDate) >= new Date()
 *
 * `new Date('2026-09-24')` parses as **UTC** midnight, which in Manila is 08:00
 * on the 24th. So a hearing scheduled for today stopped counting as upcoming the
 * moment the clock passed 8am — the statistic read 0 for the entire working day,
 * which is exactly when it is looked at. The Court Records card under-counted and
 * the Social Worker's hearing list lost today's hearings outright.
 *
 * The comparison has to be on the day. `YYYY-MM-DD` is zero-padded and
 * big-endian, so a plain string comparison against today's date in Manila is
 * both correct and timezone-proof — nothing is parsed as a `Date`, so there is
 * no offset to get wrong.
 *
 * The predicate below is the shipped one, extracted from `dateFormatter.ts` and
 * run for real rather than matched with a regex, because the whole defect is a
 * behaviour that a shape assertion cannot see.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const DATE_FORMATTER = read('frontend/src/utils/dateFormatter.ts');
const COURT_RECORDS = read('frontend/src/app/components/CourtRecords.tsx');
const SOCIAL_WORKER = read('frontend/src/app/components/SocialWorker.tsx');

/**
 * Strip comments before asserting on code.
 *
 * This matters here: the fix's own comment quotes the expression it replaced, so
 * a naive "the old comparison is gone" check would fail against the explanation
 * of why it is gone.
 */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ── Run the shipped predicate ───────────────────────────────────────────────

/**
 * Extract `isTodayOrLater` from the TypeScript source and run it with a stubbed
 * clock. The signature annotations are the only TypeScript in the function, so
 * removing them is enough to make it valid JavaScript.
 */
function loadPredicate(today) {
  const start = DATE_FORMATTER.indexOf('export function isTodayOrLater(');
  assert.ok(start >= 0, 'isTodayOrLater is not defined in dateFormatter.ts');
  const end = DATE_FORMATTER.indexOf('\n}', start);
  assert.ok(end > start, 'the end of isTodayOrLater was not found');

  const body = DATE_FORMATTER
    .slice(start, end + 2)
    .replace('export function isTodayOrLater(', 'function isTodayOrLater(')
    .replace('value?: string | null', 'value')
    .replace('): boolean {', ') {');

  assert.doesNotMatch(body, /:\s*(string|boolean|number)\b/, 'a type annotation survived extraction');
  return new Function('getCurrentPHDate', `${body}\nreturn isTodayOrLater;`)(() => today);
}

const TODAY = '2026-09-24';

test('a hearing scheduled for today counts as upcoming', () => {
  // The regression, exactly: this returned false for every hour after 8am Manila.
  const isTodayOrLater = loadPredicate(TODAY);
  assert.equal(isTodayOrLater(TODAY), true, "today's hearing is missing from the upcoming list");
});

test('a later hearing counts, an earlier one does not', () => {
  const isTodayOrLater = loadPredicate(TODAY);
  assert.equal(isTodayOrLater('2026-09-25'), true);
  assert.equal(isTodayOrLater('2026-12-31'), true);
  assert.equal(isTodayOrLater('2026-09-23'), false);
  assert.equal(isTodayOrLater('2025-09-24'), false);
});

test('the comparison is a calendar-day one, so month and year boundaries hold', () => {
  // A lexicographic comparison only works because the format is zero-padded and
  // big-endian. `9` vs `10` is where a naive implementation goes wrong.
  const isTodayOrLater = loadPredicate('2026-09-09');
  assert.equal(isTodayOrLater('2026-09-10'), true, 'the 10th was ordered before the 9th');
  assert.equal(isTodayOrLater('2026-10-01'), true, 'a later month was ordered first');
  assert.equal(isTodayOrLater('2026-09-08'), false, 'an earlier day was ordered last');
  assert.equal(isTodayOrLater('2025-12-31'), false, 'a year boundary was mishandled');
});

test('a value that carries a time still compares on its day', () => {
  // hearingDate is normalised to the date half, but a DATETIME column read
  // through a different path must not silently become "not upcoming".
  const isTodayOrLater = loadPredicate(TODAY);
  assert.equal(isTodayOrLater('2026-09-24T09:30:00'), true);
  assert.equal(isTodayOrLater('2026-09-24 09:30:00'), true);
});

test('a missing or malformed date is not upcoming', () => {
  // Counting these would overstate the list — the opposite of the bug, but the
  // same class of wrong number.
  const isTodayOrLater = loadPredicate(TODAY);
  for (const value of [null, undefined, '', '   ', 'not a date', '24/09/2026', '2026-9-24']) {
    assert.equal(isTodayOrLater(value), false, `${JSON.stringify(value)} was counted as an upcoming hearing`);
  }
});

// ── Both lists use it ───────────────────────────────────────────────────────

test('both upcoming-hearing lists use the shared predicate', () => {
  const courtPredicate = COURT_RECORDS.slice(
    COURT_RECORDS.indexOf('const upcomingHearings = courtRecords.filter('),
    COURT_RECORDS.indexOf('.length;', COURT_RECORDS.indexOf('const upcomingHearings = courtRecords.filter(')),
  );
  assert.match(courtPredicate, /isTodayOrLater\(r\.hearingDate\)/, 'the Court Records card still compares an instant');

  const socialWorkerList = SOCIAL_WORKER.slice(
    SOCIAL_WORKER.indexOf('const upcomingHearings = useMemo('),
    SOCIAL_WORKER.indexOf('}, [courtRecords]);', SOCIAL_WORKER.indexOf('const upcomingHearings = useMemo(')),
  );
  assert.match(
    socialWorkerList,
    /isTodayOrLater\(record\.hearingDate\)/,
    'the Social Worker hearing list still compares an instant',
  );
});

test('no date-only value is compared against the current instant', () => {
  // The defect is a comparison, so this is written as one: a `Date` built from a
  // date-only field, compared with `new Date()`. Comments are stripped because
  // the fix quotes the old expression.
  for (const [label, source] of [
    ['CourtRecords.tsx', code(COURT_RECORDS)],
    ['SocialWorker.tsx', code(SOCIAL_WORKER)],
  ]) {
    assert.doesNotMatch(
      source,
      /new Date\(\s*[a-zA-Z_$][\w.$]*hearingDate[\s\S]{0,40}?[<>]=?\s*new Date\(\)/i,
      `${label} compares a calendar day against the current instant`,
    );
    assert.doesNotMatch(
      source,
      /new Date\(\s*record\.hearingDate\s*\)\s*[<>]=?\s*now/,
      `${label} compares a calendar day against a captured instant`,
    );
  }
});

test('the hearing reminders use the Manila day, not the UTC one', () => {
  // `new Date().toISOString().split('T')[0]` is the UTC day. After 16:00 Manila
  // it already reads as tomorrow, so today's 1-hour-before reminders were never
  // scheduled — the same defect, on the write side.
  // Comments are stripped here too, for the same reason: the fix's comment names
  // the `toISOString()` call it removed.
  const reminders = code(COURT_RECORDS.slice(
    COURT_RECORDS.indexOf('On mount, schedule 1-hour-before reminders'),
    COURT_RECORDS.indexOf('if (todayHearings.length > 0'),
  ));
  assert.ok(reminders.length > 100, 'the reminder block was not located');
  assert.match(reminders, /getCurrentPHDate\(\)/, 'the reminder day is still the UTC day');
  assert.doesNotMatch(reminders, /toISOString\(\)/, 'the reminder day is still derived from an ISO instant');
});
