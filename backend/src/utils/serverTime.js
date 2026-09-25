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
 *
 * ## Not every DATETIME is a UTC instant
 *
 * The rule above assumes the database holds UTC, which it does for every
 * timestamp the *server* produces — `NOW()`, or a client `toISOString()`
 * normalised by `toMysqlDateTime`. It is false for a column the *user* fills in
 * from a `datetime-local` control.
 *
 * That control has no zone. Its value (`2026-09-25T14:32`) is sent as a naive
 * string, and `toMysqlDateTime` passes a naive string through as the wall-clock
 * it already is — so the column holds **14:32 Manila**, not 14:32 UTC. Treating
 * it as UTC would render it 22:32, eight hours late, which is the same class of
 * error this module exists to remove, just pointing the other way.
 *
 * So those columns are named in `WALL_CLOCK_DATETIME_COLUMNS` and given the
 * facility's own offset instead of the database's. The value still comes out
 * carrying an explicit offset — the invariant that matters — it is just the
 * honest one for what the column means. `+08:00` on `2026-09-25T14:32:00` names
 * the same instant the user typed, and every consumer of the string keeps
 * working: `new Date(...)` resolves it correctly, and the plain-text readers
 * (`slice(0, 16)`, `formatShortDate`) still find the day and the clock where
 * they expect them.
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
 * The facility's own zone — what a `datetime-local` control means.
 *
 * `Asia/Manila` is the system's display convention already: the frontend pins
 * it in `utils/dateFormatter.ts` (`formatPHDate`, `formatPHDateTime`,
 * `getCurrentPHDate`) and the backend has a `manilaToday` helper for it. The
 * offset is state rather than a literal so it can be changed in one place.
 */
let facilityOffsetMinutes = 480;
let facilityZoneLabel = 'Asia/Manila';

/**
 * DATETIME columns that hold the facility's wall-clock rather than a UTC instant.
 *
 * These are exactly the columns the browser fills from a `datetime-local`
 * control — see the module note. Two rules keep this list honest:
 *
 *   - it holds only columns whose *only* writer is that control. A column the
 *     server also writes (`uploadedAt`, `reviewedAt`, `readmittedAt`) holds UTC
 *     and must not be listed, or the two writers would disagree.
 *   - `intervention_tracker.scheduledAt` is reached by two paths
 *     (`violationController` during verification, `violationGuideController`
 *     from the tracker) and both send the naive control value, so it belongs
 *     here once.
 *
 * Pinned by `backend/tests/wall-clock-columns.test.js`, which also asserts that
 * no other column is fed a naive value — a new one would otherwise be silently
 * read as UTC and land eight hours out.
 */
const WALL_CLOCK_DATETIME_COLUMNS = new Set([
  // incidentReports — Form 08's "Date and Time of Incident".
  'incidentDateTime',
  // intervention_tracker — the schedule picker for a linked intervention.
  'scheduledAt',
]);

/** Records the facility's zone. Mirrors `setDatabaseZone`. */
function setFacilityZone({ offsetMinutes = 480, label = 'Asia/Manila' } = {}) {
  facilityOffsetMinutes = Number.isFinite(offsetMinutes) ? Math.trunc(offsetMinutes) : 480;
  facilityZoneLabel = label || 'Asia/Manila';
}

function getFacilityOffsetMinutes() { return facilityOffsetMinutes; }
function getFacilityZoneLabel() { return facilityZoneLabel; }

/** The offset a value in this column should be labelled with. */
function offsetForColumn(key) {
  return WALL_CLOCK_DATETIME_COLUMNS.has(key) ? facilityOffsetMinutes : databaseOffsetMinutes;
}

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
 * @param {number} [offsetMinutes] the zone to label the value with. Defaults to
 *   the database's, which is right for every server-produced instant. A
 *   wall-clock column passes the facility's instead.
 * @returns {*} the value, or its ISO 8601 equivalent
 */
function toIsoInstant(value, offsetMinutes = databaseOffsetMinutes) {
  if (typeof value !== 'string') return value;

  // A cheap guard before the regex. Responses carry multi-megabyte base64
  // document bodies, and a length check rejects every one of them without
  // running a pattern against megabytes of base64.
  if (value.length < 19 || value.length > 32) return value;

  const match = MYSQL_DATETIME.exec(value);
  if (!match) return value;

  const [, year, month, day, hour, minute, second, fraction] = match;
  const millis = `.${(fraction || '0').slice(0, 3).padEnd(3, '0')}`;

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${millis}${offsetSuffix(offsetMinutes)}`;
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
 * `key` is the property this value was reached through, and is how a
 * wall-clock column is recognised. It is only ever the *immediate* key: a
 * nested object is walked with its own keys, so `{ a: { b: … } }` labels `b` by
 * `b`. That is what a row looks like — the column name is the property name.
 *
 * @param {*} payload
 * @param {string} [key] the property name `payload` was reached through
 * @returns {*} a copy with every timezone-less datetime string made explicit
 */
function withIsoInstants(payload, key) {
  if (typeof payload === 'string') return toIsoInstant(payload, offsetForColumn(key));

  if (Array.isArray(payload)) return payload.map((item) => withIsoInstants(item));

  if (payload && typeof payload === 'object') {
    if (Buffer.isBuffer(payload) || payload instanceof Date) return payload;

    const prototype = Object.getPrototypeOf(payload);
    if (prototype !== Object.prototype && prototype !== null) return payload;

    const out = {};
    for (const [entryKey, value] of Object.entries(payload)) {
      out[entryKey] = withIsoInstants(value, entryKey);
    }
    return out;
  }

  return payload;
}

module.exports = {
  MYSQL_DATETIME,
  WALL_CLOCK_DATETIME_COLUMNS,
  setDatabaseZone,
  setFacilityZone,
  getFacilityOffsetMinutes,
  getFacilityZoneLabel,
  offsetForColumn,
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
