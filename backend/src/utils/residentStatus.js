/**
 * A resident's case status.
 *
 * `children.status` holds four values:
 *
 *   - `Active`      — in care
 *   - `Discharged`  — completed the programme and left
 *   - `Transferred` — left **without** completing it, because a phase was
 *                     force-advanced past its requirements
 *   - `Absconded`   — left without notice
 *
 * `Discharged` and `Transferred` are both **closed**: the case is over and the
 * resident is out of the active population. Every list, count and filter that
 * used to test `status === 'Discharged'` was really asking "is this case
 * closed?", so they all read through here now. Adding the second value without
 * a shared predicate is exactly how a transferred resident ends up back in an
 * active list, or missing from the archive.
 *
 * `Absconded` is deliberately **not** in the closed set. It has its own helper
 * (`utils/abscond.js`) and its own rules, and folding the two together would
 * change behaviour that is not part of this.
 *
 * `isActiveResidentStatus` / `assertResidentActive` are the *combined* predicate
 * — "is this resident still in care?" — for the writes that must be refused for
 * every way a stay can end. A violation, for instance, is not logged against
 * somebody who has left, whether they were discharged, transferred or absconded.
 */

const { pool } = require('../config/database');
const { ApiError } = require('../middleware/errorHandler');

const CLOSED_RESIDENT_STATUSES = ['Discharged', 'Transferred'];

/** The two ways a case closes. */
const CLOSED_BY_CHOICE_STATUSES = CLOSED_RESIDENT_STATUSES;

/** The third way a stay ends: without notice. */
const ABSCONDED_STATUS = 'Absconded';

function isClosedResidentStatus(status) {
  return CLOSED_RESIDENT_STATUSES.includes(String(status || '').trim());
}

/**
 * Is this resident still in care? An absconded resident is not, and neither is a
 * closed case — the three ways a stay ends are all "no".
 */
function isActiveResidentStatus(status) {
  const value = String(status || '').trim();
  return value !== ABSCONDED_STATUS && !isClosedResidentStatus(value);
}

/**
 * Throws 409 when the resident is not active, naming the status that stopped it.
 *
 * Distinct from `assertResidentNotAbsconded`, which refuses only an absconded
 * resident and leaves a closed case writable. Use this one for a *new* record
 * about the resident; the abscond-only guard is for writes that are about
 * freezing a record that already exists.
 *
 * @param {string} residentId
 * @param {string} action  Completes "…cannot be <action>".
 */
async function assertResidentActive(residentId, action = 'changed', executor = pool) {
  if (!residentId) return;
  const [rows] = await executor.query('SELECT status FROM children WHERE id = ? LIMIT 1', [residentId]);
  const status = String(rows[0]?.status || '').trim();
  if (status === ABSCONDED_STATUS) {
    throw new ApiError(409, `This resident has absconded. Their record is view-only and cannot be ${action}.`);
  }
  if (isClosedResidentStatus(status)) {
    throw new ApiError(409, `This resident is ${status}. Their case is closed, so it cannot be ${action}.`);
  }
}

/**
 * SQL fragment for "this case is still open", for the queries that filter in the
 * database rather than in JavaScript. Unqualified — a caller joining `children`
 * should write its own `c.` prefix.
 */
const NOT_CLOSED_SQL = "status NOT IN ('Discharged', 'Transferred')";

module.exports = {
  CLOSED_RESIDENT_STATUSES,
  CLOSED_BY_CHOICE_STATUSES,
  ABSCONDED_STATUS,
  isClosedResidentStatus,
  isActiveResidentStatus,
  assertResidentActive,
  NOT_CLOSED_SQL,
};
