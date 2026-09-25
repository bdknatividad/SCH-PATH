/**
 * The timezone the database's wall-clock strings are in, and how to say so on
 * the wire.
 *
 * @module utils/serverTime
 * @description Turns the timezone-less datetime strings MySQL hands back into
 * unambiguous ISO 8601 instants.
 *
 * ## The bug this exists to fix
 *
 * `dateStrings: true` is set on the pool (see `config/database.js`), so a
 * DATETIME column is returned to the application as the exact string that was
 * stored:
 *
 *   2026-09-25 06:32:02
 *
 * That string carries **no zone**, and the database holds **UTC** — the
 * container is UTC (`node:22-alpine` ships no local timezone) and the managed
 * MySQL is UTC. So the value is a UTC wall-clock with nothing saying so.
 *
 * JavaScript then resolves that ambiguity the wrong way. A date-time with no
 * offset is parsed as **local** time, per spec, so `new Date('2026-09-25
 * 06:32:02')` in a Manila browser means 06:32 +08:00 — eight hours away from the
 * real instant. The user saw exactly that: a report submitted at 2:32 PM Manila
 * displayed as "9/25/2026, 6:32:02 AM".
 *
 * ## Why the offset is added here, and not in the frontend
 *
 * The frontend already has a correct Manila formatter
 * (`frontend/src/utils/dateFormatter.ts`), and it could not have helped: by the
 * time any formatter runs, `new Date()` has already committed to the wrong
 * instant. A formatter can only render the instant it is handed.
 *
 * Fixing it at the response boundary also fixes every consumer at once. There
 * are 80 `new Date(...)` sites and 47 `toLocale*` display calls across the
 * frontend, and the print views and generated PDFs share the same values.
 * Making the instant unambiguous is one change; correcting 47 call sites is 47
 * chances to miss one, and a missed one stays invisible until somebody reads
 * that particular screen at the wrong time of day.
 *
 * ## Only DATETIME, never DATE
 *
 * A `DATE` column returns `2026-09-25` — a calendar day, not an instant — and
 * must stay that way. `new Date('2026-09-25')` is UTC midnight, which is the
 * *previous* day in any zone west of UTC, and the frontend depends on the bare
 * form in places that feed `<input type="date">` (`formatDateInput`). The
 * pattern below requires a time component, so a bare date never matches and is
 * passed through untouched.
 */

/**
 * MySQL's `NOW()` offset from UTC, in minutes.
 *
 * Starts at UTC and is replaced at boot by the probe in
 * `config/database.js`, which asks MySQL rather than assuming. Keeping the
 * assumption in a variable — instead of hardcoding `Z` in the formatter — is
 * what makes it *visible*: if the database is ever moved off UTC, the boot log
 * says so, rather than every timestamp in the system shifting by the difference
 * with nothing to point at.
 */
let databaseOffsetMinutes = 0;

/** How the database's zone is named in logs. `UTC` until the probe says otherwise. */
let databaseZoneLabel = 'UTC';

/**
 * A MySQL datetime: `YYYY-MM-DD HH:MM:SS`, optionally with a `T` separator and
 * optionally with fractional seconds. Deliberately **not** matching a trailing
 * `Z` or `±HH:MM`, because a value that already carries an offset is already
 * unambiguous and must not be given a second one.
 */
const MYSQL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

/** Records what the boot probe found. */
function setDatabaseZone({ offsetMinutes = 0, label = 'UTC' } = {}) {
  databaseOffsetMinutes = Number.isFinite(offsetMinutes) ? Math.trunc(offsetMinutes) : 0;
  databaseZoneLabel = label || 'UTC';
}

function getDatabaseOffsetMinutes() { return databaseOffsetMinutes; }
function getDatabaseZoneLabel() { return databaseZoneLabel; }

/** The zone the *process* runs in. Used only to report a mismatch at boot. */
function processZoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The process's offset from UTC, in minutes. `-getTimezoneOffset()` inverts JS's sign. */
function processOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

/** `+08:00` / `-04:30` / `Z`. */
function offsetSuffix(minutes) {
  if (!minutes) return 'Z';
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const mins = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${mins}`;
}

/**
 * `TIMEDIFF(NOW(), UTC_TIMESTAMP())` — `HH:MM:SS`, possibly negative — as minutes.
 *
 * MySQL caps a TIME at 838:59:59, so a three-digit hour field is real and not a
 * typo to reject. Anything that does not parse is treated as UTC, because the
 * alternative — refusing to answer — would leave the response serialiser with no
 * offset at all.
 *
 * @param {*} value
 * @returns {number} minutes east of UTC
 */
function parseTimeDiff(value) {
  const match = /^(-)?(\d{1,3}):(\d{2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return 0;
  const [, sign, hours, minutes, seconds] = match;
  const total = Number(hours) * 60 + Number(minutes) + Number(seconds) / 60;
  return sign === '-' ? -total : total;
}

/** Is this the exact shape MySQL returns for a DATETIME with `dateStrings: true`? */
function isMysqlDatetime(value) {
  return typeof value === 'string' && MYSQL_DATETIME.test(value);
}

/**
 * `2026-09-25 06:32:02` -> `2026-09-25T06:32:02.000Z`
 *
 * Anything that is not a timezone-less MySQL datetime is returned unchanged,
 * including a value that already carries an offset.
 *
 * @param {*} value
 * @returns {*} the value, or its ISO 8601 equivalent
 */
function toIsoInstant(value) {
  if (typeof value !== 'string') return value;

  // A cheap guard before the regex. Responses carry multi-megabyte base64
  // document bodies, and a length check rejects every one of them without
  // running a pattern against megabytes of base64.
  if (value.length < 19 || value.length > 32) return value;

  const match = MYSQL_DATETIME.exec(value);
  if (!match) return value;

  const [, year, month, day, hour, minute, second, fraction] = match;
  const millis = `.${(fraction || '0').slice(0, 3).padEnd(3, '0')}`;

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${millis}${offsetSuffix(databaseOffsetMinutes)}`;
}

/**
 * The same conversion, applied through a response body.
 *
 * Returns a **copy** rather than mutating, so a controller that still holds the
 * row it returned sees exactly what it produced. Strings are immutable and
 * shared by reference, so copying a body full of base64 blobs is cheap.
 *
 * Objects that are not plain (a `Buffer`, a `Date`, a class instance) are passed
 * through untouched: a `Buffer`'s bytes are not strings, and a `Date` is already
 * an instant that `JSON.stringify` renders with its own `Z`.
 *
 * @param {*} payload
 * @returns {*} a copy with every timezone-less datetime string made explicit
 */
function withIsoInstants(payload) {
  if (typeof payload === 'string') return toIsoInstant(payload);

  if (Array.isArray(payload)) return payload.map(withIsoInstants);

  if (payload && typeof payload === 'object') {
    if (Buffer.isBuffer(payload) || payload instanceof Date) return payload;

    const prototype = Object.getPrototypeOf(payload);
    if (prototype !== Object.prototype && prototype !== null) return payload;

    const out = {};
    for (const [key, value] of Object.entries(payload)) {
      out[key] = withIsoInstants(value);
    }
    return out;
  }

  return payload;
}

module.exports = {
  MYSQL_DATETIME,
  setDatabaseZone,
  getDatabaseOffsetMinutes,
  getDatabaseZoneLabel,
  processZoneName,
  processOffsetMinutes,
  offsetSuffix,
  parseTimeDiff,
  isMysqlDatetime,
  toIsoInstant,
  withIsoInstants,
};
