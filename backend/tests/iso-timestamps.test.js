/**
 * The shape of a datetime value on its way *out* of MySQL.
 *
 * ## Why this file exists
 *
 * The pool sets `dateStrings: true`, so a DATETIME column comes back as the
 * literal string stored, with no zone on it:
 *
 *   2026-09-25 06:32:02
 *
 * The database holds **UTC**, so that is a UTC wall-clock with nothing saying so.
 * JavaScript parses a date-time with no offset as *local* time, so a Manila
 * browser read it as 06:32 +08:00 — eight hours from the real instant. Reported
 * live: a report submitted at 2:32 PM Manila displayed as
 * "9/25/2026, 6:32:02 AM".
 *
 * The fix is `middleware/isoTimestamps`, which gives every datetime on the wire
 * an explicit offset. These tests are about the *class* of value it must and must
 * not touch, because getting that wrong is silent in both directions: a DATE
 * given a time, or an already-correct instant given a second offset, both
 * produce a plausible-looking string that is wrong.
 *
 * Run: node --test tests/iso-timestamps.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  toIsoInstant,
  withIsoInstants,
  setDatabaseZone,
  getDatabaseOffsetMinutes,
  offsetSuffix,
  parseTimeDiff,
  isMysqlDatetime,
} = require('../src/utils/serverTime');
const { isoResponseTimestamps } = require('../src/middleware/isoTimestamps');

const SRC = path.resolve(__dirname, '..', 'src');
const REPO = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

/** The zone the database reports. Restored after every test that changes it. */
const UTC = { offsetMinutes: 0, label: 'UTC' };
test.afterEach(() => setDatabaseZone(UTC));

/** Renders an instant as Manila wall-clock, independent of the test process's zone. */
function manilaClock(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

// ── The reported symptom ──────────────────────────────────────────────────

test('a stored UTC time now renders as Philippine time, not as the UTC wall-clock', () => {
  // The exact value from the report: submitted 2026-09-25 14:32 Manila, stored
  // as 06:32 UTC.
  const stored = '2026-09-25 06:32:02';
  const fixed = new Date(toIsoInstant(stored));

  assert.equal(fixed.toISOString(), '2026-09-25T06:32:02.000Z',
    'the instant must be the real one, in UTC');
  assert.equal(manilaClock(fixed), '14:32:02',
    'and it must read 2:32 PM in the Philippines — not 6:32 AM');
});

test('the old value was ambiguous, which is what made it display wrong', () => {
  // Without an offset, the string is read as *local* time. On the machine that
  // produced it that looked correct; in the browser it did not. The assertion
  // here is deliberately about ambiguity rather than about a specific offset,
  // because the old behaviour depended on where the code happened to run — which
  // is precisely the defect.
  const stored = '2026-09-25 06:32:02';
  assert.equal(Number.isNaN(new Date(stored).getTime()), false);
  assert.equal(
    new Date(stored).getTime(),
    new Date(2026, 8, 25, 6, 32, 2).getTime(),
    'a timezone-less string is parsed as local time, so its meaning depends on the host',
  );
  assert.notEqual(
    new Date(toIsoInstant(stored)).getTime(),
    new Date(2026, 8, 25, 6, 32, 2).getTime() - 8 * 3600 * 1000,
    'the fixed value must not be another local-time reading of the same digits',
  );
});

// ── The conversion ────────────────────────────────────────────────────────

test('a MySQL datetime becomes an ISO 8601 instant', () => {
  assert.equal(toIsoInstant('2026-09-25 06:32:02'), '2026-09-25T06:32:02.000Z');
});

test('fractional seconds are preserved, padded to milliseconds', () => {
  assert.equal(toIsoInstant('2026-09-25 06:32:02.5'), '2026-09-25T06:32:02.500Z');
  assert.equal(toIsoInstant('2026-09-25 06:32:02.123456'), '2026-09-25T06:32:02.123Z');
});

test('a bare DATE is left alone, because it is a calendar day and not an instant', () => {
  // Giving this a time would be worse than the original bug: `2026-09-25` as an
  // instant is UTC midnight, which is the *previous* day in any zone west of
  // UTC, and the frontend feeds these straight into <input type="date">.
  for (const value of ['2026-09-25', '2026-01-01', '2026-12-31']) {
    assert.equal(toIsoInstant(value), value, `${value} must be untouched`);
    // Assert the *pattern* rejects it, not just the length guard. Without this
    // the loop above passes for the wrong reason: every bare date is under the
    // 19-character minimum, so a pattern that wrongly accepted dates would
    // still leave these untouched and the test would be vacuous.
    assert.equal(isMysqlDatetime(value), false, `${value} must not be read as a datetime`);
  }
});

test('a value that already carries an offset is never given a second one', () => {
  // Idempotence. These values are read back from the API and re-sent by the
  // client on the next save, so a second pass must be a no-op.
  for (const value of [
    '2026-09-25T06:32:02.000Z',
    '2026-09-25T06:32:02Z',
    '2026-09-25T14:32:02+08:00',
    '2026-09-25T02:32:02-04:00',
    '2026-09-25T06:32:02.000+00:00',
  ]) {
    assert.equal(toIsoInstant(value), value, `${value} must be untouched`);
  }
});

test('the output of the conversion is itself stable', () => {
  const once = toIsoInstant('2026-09-25 06:32:02');
  assert.equal(toIsoInstant(once), once);
});

test('a non-datetime string is passed through untouched', () => {
  for (const value of [
    'not a date',
    'Admission Slip',
    '2026-09-25T',           // truncated
    '25/09/2026',            // not the stored shape
    '2026-9-25 06:32:02',    // unpadded, so not what MySQL returns
    '006:32:02',
  ]) {
    assert.equal(toIsoInstant(value), value, `${value} must be untouched`);
  }
});

test('non-strings pass through, because the walk reaches every value in a body', () => {
  for (const value of [null, undefined, 42, true, {}, []]) {
    assert.equal(toIsoInstant(value), value);
  }
});

test('a base64 document body is not mistaken for a datetime', () => {
  // The largest values in the system by far. They are rejected on length alone,
  // before the pattern runs — which is what keeps the walk cheap on responses
  // that carry a multi-megabyte attachment.
  const base64 = 'iVBORw0KGgoAAAANSUhEUg'.repeat(500);
  assert.equal(toIsoInstant(base64), base64);
  assert.equal(isMysqlDatetime(base64), false);
});

test('the database offset is honoured, not hardcoded to UTC', () => {
  // The offset comes from the boot probe. If the database is ever moved to a
  // non-UTC zone, the serialiser must follow it rather than keep stamping Z.
  setDatabaseZone({ offsetMinutes: 480, label: 'Asia/Manila' });
  assert.equal(toIsoInstant('2026-09-25 06:32:02'), '2026-09-25T06:32:02.000+08:00');

  setDatabaseZone({ offsetMinutes: -330, label: 'America/St_Johns' });
  assert.equal(toIsoInstant('2026-09-25 06:32:02'), '2026-09-25T06:32:02.000-05:30');
});

test('offsetSuffix renders the forms ISO 8601 allows', () => {
  assert.equal(offsetSuffix(0), 'Z');
  assert.equal(offsetSuffix(480), '+08:00');
  assert.equal(offsetSuffix(-480), '-08:00');
  assert.equal(offsetSuffix(330), '+05:30');
  assert.equal(offsetSuffix(-1), '-00:01');
});

test('parseTimeDiff reads what MySQL actually returns', () => {
  assert.equal(parseTimeDiff('00:00:00'), 0);
  assert.equal(parseTimeDiff('-08:00:00'), -480);
  assert.equal(parseTimeDiff('05:30:00'), 330);
  // MySQL's TIME ceiling, with a seconds remainder. Real offsets are always
  // whole minutes, so the remainder is carried as a fraction and truncated
  // before use rather than rounded into the emitted offset.
  assert.equal(Math.trunc(parseTimeDiff('838:59:59')), 838 * 60 + 59);
  // Anything unparseable means "no answer", and the serialiser still needs an
  // offset — so it falls back to UTC rather than leaving timestamps ambiguous.
  assert.equal(parseTimeDiff('SYSTEM'), 0);
  assert.equal(parseTimeDiff(null), 0);
  assert.equal(parseTimeDiff(undefined), 0);
});

test('a fractional minute cannot leak into the emitted offset', () => {
  // `+05:30.5` is not a thing. The offset is truncated when it is recorded, so
  // the suffix always renders a whole minute.
  setDatabaseZone({ offsetMinutes: 330.5, label: 'Asia/Kolkata' });

  assert.equal(getDatabaseOffsetMinutes(), 330);
  assert.equal(offsetSuffix(getDatabaseOffsetMinutes()), '+05:30');
  assert.equal(toIsoInstant('2026-09-25 06:32:02'), '2026-09-25T06:32:02.000+05:30');
});

// ── Walking a response body ───────────────────────────────────────────────

test('a nested response body has every datetime converted and nothing else', () => {
  const body = {
    success: true,
    data: [
      {
        id: 'ANR004',
        residentId: 'CH002',
        status: 'Submitted',
        submittedAt: '2026-09-25 06:32:02',
        reportDate: '2026-09-25',
        title: 'Anecdotal Report',
        count: 3,
        meta: { createdAt: '2026-09-25 06:32:01', nested: { finalizedAt: '2026-09-25 06:32:02' } },
      },
    ],
  };

  const out = withIsoInstants(body);

  assert.equal(out.data[0].submittedAt, '2026-09-25T06:32:02.000Z');
  assert.equal(out.data[0].meta.createdAt, '2026-09-25T06:32:01.000Z');
  assert.equal(out.data[0].meta.nested.finalizedAt, '2026-09-25T06:32:02.000Z');
  // A DATE column must survive the walk unchanged, or every form that reads it
  // back loses a day.
  assert.equal(out.data[0].reportDate, '2026-09-25');
  assert.equal(out.data[0].title, 'Anecdotal Report');
  assert.equal(out.data[0].count, 3);
  assert.equal(out.success, true);
});

test('the walk does not mutate the body it was given', () => {
  // A controller may still hold the row it returned, and the alert publisher
  // reads `submittedAt` back after responding. Mutating in place would change
  // what those see.
  const body = { submittedAt: '2026-09-25 06:32:02' };
  const out = withIsoInstants(body);

  assert.notEqual(out, body, 'must return a copy');
  assert.equal(body.submittedAt, '2026-09-25 06:32:02', 'the original must be untouched');
});

test('values that are not plain data are passed through by reference', () => {
  // A Buffer's bytes are not strings, and a Date is already an instant that
  // JSON.stringify renders with its own Z — converting either would be wrong.
  const when = new Date('2026-09-25T06:32:02.000Z');
  const buffer = Buffer.from('hello');
  class Row { constructor() { this.submittedAt = '2026-09-25 06:32:02'; } }

  const body = { when, buffer, row: new Row(), list: [when] };
  const out = withIsoInstants(body);

  assert.equal(out.when, when, 'a Date must survive as-is');
  assert.equal(out.buffer, buffer, 'a Buffer must survive as-is');
  assert.ok(out.row instanceof Row, 'a class instance must not be flattened to a plain object');
  assert.equal(out.row.submittedAt, '2026-09-25 06:32:02', 'and must not be rewritten');
  assert.equal(out.list[0], when);
});

test('null and undefined survive the walk', () => {
  assert.equal(withIsoInstants(null), null);
  assert.equal(withIsoInstants(undefined), undefined);
  assert.equal(withIsoInstants('2026-09-25 06:32:02'), '2026-09-25T06:32:02.000Z');
});

test('the pattern is not run against values that cannot possibly match', () => {
  // Responses carry multi-megabyte base64 document bodies. The length check is
  // what keeps the walk cheap on them. Pinned as a *source* assertion because
  // deleting it changes no behaviour any other test can see — every test still
  // passes, only the response time moves.
  const source = read('utils', 'serverTime.js');
  const guard = source.indexOf('value.length < 19');
  const pattern = source.indexOf('MYSQL_DATETIME.exec(value)');

  assert.ok(guard > 0, 'the length guard is missing from toIsoInstant');
  assert.ok(pattern > guard, 'the length guard must run before the pattern');
});

test('the boot probe is actually called when the connection is tested', () => {
  // `detectDatabaseZone` being correct is not the same as it being called.
  // Removing the call is a one-line change that leaves every test above — and
  // every assertion about the helper — perfectly intact, while the serialiser
  // silently falls back to assuming UTC.
  const source = read('config', 'database.js');
  const from = source.indexOf('async function testConnection');
  assert.ok(from > 0, 'expected testConnection');

  assert.match(
    source.slice(from),
    /await detectDatabaseZone\(connection\)/,
    'testConnection must run the zone probe while it holds a connection',
  );
});

// ── The middleware ────────────────────────────────────────────────────────

/** A response double that records what `res.json` was handed. */
function fakeRes() {
  return {
    payload: Symbol('untouched'),
    json(body) { this.payload = body; return this; },
  };
}

test('the middleware converts the body and returns the response', () => {
  const res = fakeRes();
  let nextCalled = false;
  isoResponseTimestamps({}, res, () => { nextCalled = true; });

  assert.ok(nextCalled, 'must always call next()');

  const returned = res.json({ data: { submittedAt: '2026-09-25 06:32:02' } });

  assert.equal(returned, res, 'res.json must still return the response, or `res.json(...)` chains break');
  assert.equal(res.payload.data.submittedAt, '2026-09-25T06:32:02.000Z');
});

test('the middleware tolerates every body shape a handler can pass', () => {
  const res = fakeRes();
  isoResponseTimestamps({}, res, () => {});
  for (const body of [null, undefined, [], 'text', 0, false]) {
    assert.doesNotThrow(() => res.json(body), `body=${JSON.stringify(body)}`);
  }
});

test('the middleware wraps res.json only, never res.send', () => {
  // `res.send` carries HTML, plain text and binary bodies — document downloads
  // among them. Wrapping it would run a deep walk over the largest responses in
  // the system for no benefit.
  const res = fakeRes();
  res.send = function send() { return this; };
  const originalSend = res.send;

  isoResponseTimestamps({}, res, () => {});

  assert.equal(res.send, originalSend, 'res.send must be left exactly as it was');
});

test('the middleware is mounted, and above the routes', () => {
  // Mounted below `app.use('/api', routes)` it would never run at all: a route
  // answers before the middleware is reached. Anchored to the start of a line
  // and stripped of comments first, because a commented-out mount
  // (`// app.use(isoResponseTimestamps);`) is exactly how this gets disabled in a
  // hurry and a naive substring search would accept it.
  const source = read('server.js')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');

  const mounted = source.search(/^\s*app\.use\(\s*isoResponseTimestamps\s*\)\s*;/m);
  const routes = source.search(/^\s*app\.use\(\s*'\/api'\s*,\s*routes\s*\)\s*;/m);

  assert.ok(mounted > 0, 'isoResponseTimestamps must be mounted as live code in server.js');
  assert.ok(routes > 0, 'expected the API routes mount');
  assert.ok(mounted < routes, 'the mount must come before app.use(\'/api\', routes) or it never runs');
});

test('the boot probe measures the database zone rather than assuming it', async () => {
  const { detectDatabaseZone } = require('../src/config/database');
  const { getDatabaseZoneLabel } = require('../src/utils/serverTime');

  const seen = [];
  const connection = {
    query: async (sql) => {
      seen.push(sql);
      return [[{ zone: 'SYSTEM', diff: '-08:00:00' }]];
    },
  };

  await detectDatabaseZone(connection);

  assert.match(seen.join(' '), /TIMEDIFF\(NOW\(\), UTC_TIMESTAMP\(\)\)/,
    'the zone must be asked for, not assumed');
  assert.equal(getDatabaseOffsetMinutes(), -480, 'and recorded for the serialiser');
  assert.equal(getDatabaseZoneLabel(), 'SYSTEM');
});

test('the boot probe survives a database that will not answer', async () => {
  // A probe that throws at boot would take the whole process down over a
  // diagnostic. It is best-effort, and falling back to UTC keeps the wire format
  // consistent with the data actually stored.
  const { detectDatabaseZone } = require('../src/config/database');

  const connection = { query: async () => { throw new Error('ER_NO_SUCH_TABLE'); } };

  await assert.doesNotReject(() => detectDatabaseZone(connection));
  assert.equal(getDatabaseOffsetMinutes(), 0);
});

test('the container timezone is pinned, so the two clocks cannot drift apart', () => {
  // `helpers.toMysqlDateTime` converts a client-supplied value with the
  // *process's* zone while `NOW()` uses the *database's*. The image was UTC only
  // because node:22-alpine happens to ship no local timezone — an accident, and
  // one that a `TZ` variable in the service's environment would silently
  // overturn, storing client-supplied datetimes eight hours from every
  // NOW()-filled column on the same row.
  const dockerfile = fs.readFileSync(path.join(REPO, 'backend', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^ENV TZ=UTC$/m, 'the runtime stage must pin TZ to UTC');
});
