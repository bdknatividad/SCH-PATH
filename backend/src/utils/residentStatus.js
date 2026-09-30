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
 */

const CLOSED_RESIDENT_STATUSES = ['Discharged', 'Transferred'];

/** The two ways a case closes. */
const CLOSED_BY_CHOICE_STATUSES = CLOSED_RESIDENT_STATUSES;

function isClosedResidentStatus(status) {
  return CLOSED_RESIDENT_STATUSES.includes(String(status || '').trim());
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
  isClosedResidentStatus,
  NOT_CLOSED_SQL,
};
