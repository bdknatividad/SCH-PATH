/**
 * Resident (caseload) scope — the one place that answers "which children is this
 * user responsible for?".
 *
 * This lives in `utils/` rather than in a controller because more than one
 * subsystem needs it: document access filters by it, and notifications filter
 * by it. Importing it from `documentController` would make
 * `documentController → notificationService → documentController` a cycle, and
 * copying the query into each caller is how this codebase ended up with three
 * disagreeing copies of its document permission map.
 */

const { pool } = require('../config/database');
const { normalizeRole } = require('./authorization');

/**
 * Roles whose access is additionally limited to the residents they are actually
 * assigned to.
 *
 * Only Houseparents qualify, and that is a fact about the data rather than a
 * policy choice: `residentAssignments.assignmentType` holds `houseparent` — the
 * only value any writer produces, now that the seed's old `household` typo is
 * gone — and `children` has no per-staff column, so Houseparent is the only role
 * for which "my assigned child" is expressible. Psychological Staffs, Educators
 * and Nurses have no per-child assignment anywhere in the schema — their scope
 * is expressed by document type/category and by responsibility instead.
 * Applying a caseload filter to them would lock them out of everything.
 */
const CASELOAD_SCOPED_ROLES = new Set(['houseparent']);

/** Active residents assigned to a user, or [] when they have none. */
async function assignedResidentIds(user, executor = pool) {
  if (!user?.id) return [];

  // The explicit assignment table is the primary source of truth. Normalize
  // assignmentType so legacy rows such as `Houseparent` or ` HOUSEPARENT `
  // are treated exactly like the current `houseparent` value.
  const [rows] = await executor.query(
    `SELECT DISTINCT ra.residentId
       FROM residentAssignments ra
       LEFT JOIN staff s ON s.id = ra.staffId
      WHERE ra.status = 'Active'
        AND LOWER(TRIM(ra.assignmentType)) = 'houseparent'
        AND (ra.userId = ? OR s.userId = ?)`,
    [user.id, user.id]
  );
  const ids = new Set(rows.map((row) => String(row.residentId)).filter(Boolean));

  // The Houseparent on Duty recorded on the Admission Slip
  // (admissions.houseparentOnDuty / houseparentUserId) is deliberately NOT read
  // here. It is a separate field from the Case Load Manager: only an explicit
  // residentAssignments row, created by the Center Head, puts a resident on a
  // Houseparent's case load.

  return [...ids];
}

/**
 * The resident scope for a user, loaded once per request.
 * `null` means "not scoped" — the role has no caseload concept.
 * @returns {Promise<string[]|null>}
 */
async function loadResidentScope(user, executor = pool) {
  const role = normalizeRole(user?.role);
  if (!CASELOAD_SCOPED_ROLES.has(role)) return null;
  return assignedResidentIds(user, executor);
}

/**
 * Does this row fall inside the user's resident scope?
 *
 * A row with no residentId is facility-wide and is never caseload-filtered.
 * Roles without a caseload concept (`allowedResidentIds === null`) are never
 * restricted here.
 *
 * @param {{ residentId?: string|null }} row
 * @param {string[]|null} allowedResidentIds from loadResidentScope
 */
function residentInScope(row, allowedResidentIds) {
  if (allowedResidentIds === null || allowedResidentIds === undefined) return true;
  if (!row?.residentId) return true;
  return allowedResidentIds.includes(row.residentId);
}

module.exports = {
  CASELOAD_SCOPED_ROLES,
  assignedResidentIds,
  loadResidentScope,
  residentInScope,
};
