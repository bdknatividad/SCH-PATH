/**
 * "Today" in a query is the facility's day, not UTC's.
 *
 * ## Why this file exists
 *
 * `new Date().toISOString()` is the UTC day. Manila is UTC+8, so between 00:00
 * and 07:59 Manila it is still *yesterday* — and after 16:00 Manila the UTC day
 * has already rolled over to tomorrow. A query whose window is "today" is
 * therefore a day out for eight hours of every day, in one direction or the
 * other, and the symptom is a count that is wrong at the hours people look at
 * it.
 *
 * Two of these were reported as the Dashboard's "Scheduled Today" statistics:
 *
 *   - `GET /violation-guide/interventions/scheduled` defaults its window to
 *     "today", and feeds the tile's **Assigned Schedules** section.
 *   - `GET /assessments/upcoming` feeds the **Nurse dashboard's** Upcoming
 *     Assessments tile, and reached a day too far back.
 *
 * The same expression sat in the "upcoming" endpoints for activities and
 * hearings, which are the same words the requirement names.
 *
 * `manilaToday()` in `utils/triPeriod.js` is the backend's one helper for this,
 * and `tri-deadline-reminder.test.js` already pins the helper itself. What was
 * missing was the call sites — so this file guards the call sites, the way
 * `manila-now-defaults.test.js` guards the frontend's form defaults.
 *
 * Run: node --test tests/manila-today-in-queries.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src');
const REPO = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

/**
 * Strip comments before asserting.
 *
 * The fixes carry comments that quote `new Date().toISOString()` to explain why
 * it is wrong, so a naive "the old expression is gone" check would fail against
 * its own explanation.
 */
function withoutComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The source of one top-level function, bounded so a later query cannot leak in. */
function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/\nasync function |\nfunction /);
  return next === -1 ? tail : tail.slice(0, next + 1);
}

// ── The window this is about ──────────────────────────────────────────────

test('the UTC day and the Manila day disagree for eight hours of every day', () => {
  // 2026-09-25T00:30 Manila is 2026-09-24T16:30 UTC. So an instant inside the
  // working day names two different dates depending on which one you ask for.
  const manilaEarly = new Date('2026-09-24T16:30:00Z');
  const utcDay = manilaEarly.toISOString().slice(0, 10);
  const manilaDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(manilaEarly);

  assert.equal(utcDay, '2026-09-24');
  assert.equal(manilaDay, '2026-09-25');
  assert.notEqual(utcDay, manilaDay, 'this is the window the fix closes');
});

test('manilaToday returns the Manila day for that same instant', () => {
  const { manilaToday } = require('../src/utils/triPeriod');
  assert.equal(manilaToday(new Date('2026-09-24T16:30:00Z')), '2026-09-25');
  assert.equal(manilaToday(new Date('2026-09-24T15:59:00Z')), '2026-09-24');
});

// ── The call sites that answer a dashboard ────────────────────────────────
//
// Each of these four endpoints is an "upcoming"/"scheduled" window that starts
// at today. They are asserted by function, not by a file-wide sweep, because the
// remaining `toISOString()` dates in the controllers belong to other flows and
// changing them is a separate decision — see the note at the end of this file.

const DASHBOARD_WINDOWS = [
  // file, function, what it feeds
  ['violationGuideController.js', 'getScheduledInterventions', "the tile's Assigned Schedules"],
  ['assessmentController.js', 'getUpcoming', "the Nurse dashboard's Upcoming Assessments"],
  ['activityController.js', 'getUpcoming', 'the upcoming-activities list'],
  ['courtController.js', 'getUpcoming', 'the upcoming-hearings list'],
];

for (const [file, fn, feeds] of DASHBOARD_WINDOWS) {
  test(`${file} ${fn} starts its window at the facility's today (${feeds})`, () => {
    const body = functionBody(withoutComments(read('controllers', file)), fn);

    assert.match(
      body,
      /const today = manilaToday\(\)/,
      'the window must start at the Manila day — `toISOString()` is a day out for eight hours of every day',
    );
    assert.doesNotMatch(
      body,
      /toISOString/,
      'the window is derived from an ISO instant again, which is the UTC day',
    );
  });
}

test('every endpoint that uses manilaToday actually imports it', () => {
  // The import is easy to drop when a file is edited in pieces, and the failure
  // is a ReferenceError at request time rather than at load — so it would reach
  // the user as a 500 rather than failing a build.
  const offenders = [];

  for (const file of fs.readdirSync(path.join(SRC, 'controllers')).filter((f) => f.endsWith('.js'))) {
    const source = withoutComments(fs.readFileSync(path.join(SRC, 'controllers', file), 'utf8'));
    const uses = /\bmanilaToday\s*\(/.test(source);
    const imports = /require\(['"][^'"]*triPeriod['"]\)/.test(source) && /manilaToday/.test(source);
    if (uses && !imports) offenders.push(file);
  }

  assert.deepEqual(offenders, [], `these use manilaToday without importing it: ${offenders.join(', ')}`);
});

// ── The Nurse dashboard's reminder count ──────────────────────────────────
//
// Not a timezone bug, but the same complaint: a number on a dashboard that is
// not the number it claims to be. The follow-up list was sliced to six before
// the tile, the card badge and the overdue count were derived from it, so all
// three were capped at six.

const DASHBOARD_TSX = fs.readFileSync(
  path.join(REPO, 'frontend', 'src', 'app', 'components', 'Dashboard.tsx'),
  'utf8',
);

test('the Medical Reminders count is the whole set, not the first page of it', () => {
  assert.match(
    DASHBOARD_TSX,
    /const allReminders = useMemo\(\(\) => healthRecords[\s\S]{0,400}?\[healthRecords, horizonIso\]\)/,
    'the full reminder set is no longer computed under its own name',
  );
  assert.match(
    DASHBOARD_TSX,
    /const reminders = allReminders\.slice\(0, 6\)/,
    'the six shown must be a slice of the full set, not the set itself',
  );

  // The count, the caption and the badge must all read the full set.
  assert.match(DASHBOARD_TSX, /const overdueCount = allReminders\.filter\(/);
  assert.match(DASHBOARD_TSX, /title: 'Medical Reminders',\s*value: allReminders\.length/);
  assert.match(DASHBOARD_TSX, /Medical Reminders\s*<Badge[^>]*>\{allReminders\.length\}<\/Badge>/);
});

test('no dashboard count is derived from a list that was already truncated', () => {
  // The general shape: a `reminders`-style local that has been sliced must not
  // be what a tile value or a badge is measured from. Asserted for the one
  // place it happened, so the guard cannot pass on a re-introduced slice.
  assert.doesNotMatch(
    DASHBOARD_TSX,
    /title: 'Medical Reminders',\s*value: reminders\.length/,
    'the tile is counting the truncated list again',
  );
  assert.doesNotMatch(
    DASHBOARD_TSX,
    /Medical Reminders\s*<Badge[^>]*>\{reminders\.length\}<\/Badge>/,
    'the card badge is counting the truncated list again',
  );
});

/*
 * Deliberately not covered here.
 *
 * These controllers still take a date from `new Date().toISOString()`, and each
 * one is the same defect on a different flow — a discharge stamped the previous
 * day, a phase entered on the wrong day, a daily report counting yesterday's
 * admissions. They are outside the "dashboard statistics" this file was written
 * for, so they are left as they are rather than changed silently:
 *
 *   childController.js                     the discharge and re-admission dates
 *   phaseController.js                     completedAt / enteredAt, five sites
 *   reportController.js                    the daily report's date and its "today" counts
 *   quarterlyProgressReportController.js   the default period end
 *
 * When they are fixed, the per-function assertions above can become one sweep
 * over `src/controllers` with no exceptions, which is the shape this class
 * deserves.
 */
