/**
 * TRI deadline reminder tests.
 *
 * Before this, the deadline was stored on every record and printed on the form but
 * nothing ever told anyone about it — a month could pass with no TRI and no prompt.
 *
 * The date arithmetic is exercised directly because it is pure and because the two
 * mistakes that matter here are silent: computing "today" in UTC instead of Manila
 * shifts the answer by a day for eight hours of every day, and an off-by-one in the
 * reminder window either nags early or fires too late to be useful.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { lastMonday, effectiveDate, daysBetween, manilaToday } = require('../src/utils/triPeriod');
const { deadlineState, REMINDER_WINDOW_DAYS } = require('../src/services/triDeadlineService');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const SERVICE = read('src/services/triDeadlineService.js');
const SERVER = read('src/server.js');
const CONTROLLER = read('src/controllers/triController.js');

// ── the reporting calendar ─────────────────────────────────────────────────────

test('the deadline is always a Monday', () => {
  for (let year = 2025; year <= 2027; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      const iso = lastMonday(year, month);
      assert.match(iso, /^\d{4}-\d{2}-\d{2}$/, `${year}-${month} produced ${iso}`);
      const weekday = new Date(`${iso}T00:00:00Z`).getUTCDay();
      assert.equal(weekday, 1, `${year}-${String(month).padStart(2, '0')} deadline ${iso} is not a Monday`);
      // And it must be the *last* one: adding a week would leave the month.
      const monthOf = (d) => Number(d.slice(5, 7));
      const plusWeek = new Date(`${iso}T00:00:00Z`);
      plusWeek.setUTCDate(plusWeek.getUTCDate() + 7);
      assert.notEqual(monthOf(plusWeek.toISOString().slice(0, 10)), month, `${iso} is not the last Monday`);
    }
  }
});

test('known deadlines are what the facility expects', () => {
  assert.equal(lastMonday(2026, 9), '2026-09-28');
  assert.equal(lastMonday(2026, 8), '2026-08-31');
  assert.equal(lastMonday(2026, 2), '2026-02-23');
  assert.equal(lastMonday(2026, 11), '2026-11-30');
});

test('the effective date rolls December into the next January', () => {
  assert.equal(effectiveDate(2026, 9), '2026-10-01');
  assert.equal(effectiveDate(2025, 12), '2026-01-01');
});

// ── "today" must be the facility's today ───────────────────────────────────────

test('today is computed in Manila, not UTC', () => {
  // 20:00 UTC on the 16th is already 04:00 on the 17th in Manila.
  assert.equal(manilaToday(new Date('2026-09-16T20:00:00Z')), '2026-09-17');
  // 15:00 UTC is 23:00 the same day in Manila.
  assert.equal(manilaToday(new Date('2026-09-16T15:00:00Z')), '2026-09-16');
});

test('the service does not derive today from toISOString', () => {
  assert.doesNotMatch(
    SERVICE,
    /toISOString\(\)\.split\('T'\)\[0\]/,
    'the reminder is back to using the UTC date, which is the previous day in Manila ' +
      'for the first eight hours of every day'
  );
  assert.match(SERVICE, /manilaToday/, 'the service no longer uses the Manila date helper');
});

// ── the reminder window ────────────────────────────────────────────────────────

test('nothing is sent before the reminder window opens', () => {
  // September 2026 is due on the 28th.
  assert.equal(deadlineState('2026-09-17', '2026-09-28'), null);
  assert.equal(deadlineState('2026-09-24', '2026-09-28'), null, '4 days out is still too early');
});

test('the reminder fires inside the window and on the day', () => {
  for (const [day, left] of [['2026-09-25', 3], ['2026-09-26', 2], ['2026-09-27', 1], ['2026-09-28', 0]]) {
    const verdict = deadlineState(day, '2026-09-28');
    assert.ok(verdict, `${day} should produce a reminder`);
    assert.equal(verdict.state, 'due', `${day} should be "due", not overdue`);
    assert.equal(verdict.daysLeft, left);
  }
});

test('the day after the deadline is overdue, not due', () => {
  const verdict = deadlineState('2026-09-29', '2026-09-28');
  assert.equal(verdict.state, 'overdue');
  assert.equal(verdict.daysLeft, -1);
});

test('the window is three days', () => {
  assert.equal(REMINDER_WINDOW_DAYS, 3);
});

test('daysBetween is symmetric and timezone-safe', () => {
  assert.equal(daysBetween('2026-09-17', '2026-09-28'), 11);
  assert.equal(daysBetween('2026-09-28', '2026-09-17'), -11);
  assert.equal(daysBetween('2026-09-17', '2026-09-17'), 0);
  assert.equal(daysBetween('nonsense', '2026-09-17'), null);
});

// ── who gets told, and only once ───────────────────────────────────────────────

test('the reminder goes to the assigned Houseparent, not to a role', () => {
  assert.match(
    SERVICE,
    /notifications\.houseparentsOf\(/,
    'the reminder no longer resolves the responsible Houseparent from the assignment'
  );
  assert.match(SERVICE, /notifyUsers\(/, 'the reminder no longer addresses each recipient individually');
  assert.doesNotMatch(
    SERVICE,
    /targetRole\s*:/,
    'the reminder addresses a role again — a role-addressed row carries one targetRole and ' +
      'reaches nobody in particular'
  );
});

test('the dedupe key includes the state so a period sends due then overdue, but never twice', () => {
  assert.match(
    SERVICE,
    /dedupeKey: `tri:\$\{resident\.residentId\}:\$\{reportYear\}-\$\{reportMonth\}:\$\{verdict\.state\}`/,
    'the dedupe key changed shape — without the state in it, the overdue notice would be ' +
      'swallowed by the earlier due notice, or the daily run would nag'
  );
});

test('a submitted or finalized TRI clears the obligation', () => {
  const start = SERVICE.indexOf('async function outstandingForPeriod');
  assert.ok(start > 0, 'outstandingForPeriod is gone');
  const body = SERVICE.slice(start, SERVICE.indexOf('\n}', start));
  assert.match(body, /c\.status = 'Active'/, 'the check no longer limits itself to active residents');
  assert.match(
    body,
    /t\.status IN \('Submitted', 'Finalized'\)/,
    "the check no longer excludes Submitted/Finalized. A record sitting with a reviewer is " +
      "not the Houseparent's outstanding work, so this would chase the wrong person."
  );
  assert.match(body, /NOT EXISTS/, 'the check no longer asks whether a record exists at all');
});

test('a resident with no assigned Houseparent is reported, not silently skipped', () => {
  assert.match(
    SERVICE,
    /result\.unassigned\.push\(resident\.residentId\)/,
    'an unassigned resident is dropped without a trace, so nobody learns the reminder could not be sent'
  );
});

// ── the schedule ───────────────────────────────────────────────────────────────

test('the reminder is scheduled daily in the facility timezone', () => {
  const index = SERVER.indexOf('runTriDeadlineReminders');
  assert.ok(index > 0, 'the reminder is no longer registered in server.js');
  const block = SERVER.slice(SERVER.lastIndexOf('cron.schedule', index), SERVER.indexOf('timezone', index) + 40);
  assert.match(block, /cron\.schedule\('0 7 \* \* \*'/, `unexpected schedule: ${block.split('\n')[0]}`);
  assert.match(block, /timezone: 'Asia\/Manila'/, 'the schedule no longer pins the facility timezone');
});

// ── one copy of the calendar ───────────────────────────────────────────────────

test('the controller reuses the shared period helpers instead of its own copies', () => {
  assert.match(
    CONTROLLER,
    /require\('\.\.\/utils\/triPeriod'\)/,
    'the controller no longer imports the shared period helpers'
  );
  for (const name of ['lastMonday', 'effectiveDate', 'periodLabel']) {
    assert.doesNotMatch(
      CONTROLLER,
      new RegExp(`function ${name}\\(`),
      `${name} is defined in the controller again — the reporting calendar now exists in two places`
    );
  }
});
