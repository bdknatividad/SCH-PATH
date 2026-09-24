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
 * policy choice: `residentAssignments.assignmentType` only ever holds
 * `houseparent` and `household`, and `children` has no per-staff column, so
 * Houseparent is the only role for which "my assigned child" is expressible.
 * Psychological Staffs, Educators and Nurses have no per-child assignment anywhere in
 * the schema — their scope is expressed by document type/category and by
 * responsibility instead. Applying a caseload filter to them would lock them out
 * of everything.
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

  // Backward compatibility for admissions created before the explicit
  // residentAssignments table was used. Those admissions carry the assigned
  // Houseparent, so they must continue to appear in every HP-scoped resident
  // list without changing the database schema.
  //
  // The link is the stored user id. The name is only consulted for rows that
  // predate `admissions.houseparentUserId` and have not been backfilled, because
  // matching on a name is not a relationship: renaming a Houseparent used to
  // move their caseload, and two people sharing a display name used to see each
  // other's residents. Both were silent — nothing errored, the wrong list was
  // simply returned.
  try {
    const [legacyRows] = await executor.query(
      `SELECT DISTINCT a.residentId
         FROM admissions a
         JOIN users u ON u.id = ?
        WHERE a.status = 'Active'
          AND (
            a.houseparentUserId = u.id
            OR (
              a.houseparentUserId IS NULL
              AND (
                LOWER(TRIM(a.houseparentOnDuty)) = LOWER(TRIM(u.username))
                OR (u.displayName IS NOT NULL AND LOWER(TRIM(a.houseparentOnDuty)) = LOWER(TRIM(u.displayName)))
                OR (u.fullName IS NOT NULL AND LOWER(TRIM(a.houseparentOnDuty)) = LOWER(TRIM(u.fullName)))
                OR EXISTS (
                  SELECT 1 FROM staff s
                   WHERE s.userId = u.id
                     AND s.name IS NOT NULL
                     AND LOWER(TRIM(a.houseparentOnDuty)) = LOWER(TRIM(s.name))
                )
              )
            )
          )`,
      [user.id]
    );
    for (const row of legacyRows) {
      if (row.residentId) ids.add(String(row.residentId));
    }
  } catch (error) {
    // Some older deployments do not have users.fullName, and some predate
    // admissions.houseparentUserId entirely. The explicit assignment rows above
    // remain authoritative if this compatibility query cannot run.
    if (!/fullName|houseparentUserId/i.test(String(error?.message || ''))) throw error;
    try {
      const [legacyRows] = await executor.query(
        `SELECT DISTINCT a.residentId
           FROM admissions a
           JOIN users u ON u.id = ?
          WHERE a.status = 'Active'
            AND (
              LOWER(TRIM(a.houseparentOnDuty)) = LOWER(TRIM(u.username))
              OR (u.displayName IS NOT NULL AND LOWER(TRIM(a.houseparentOnDuty)) = LOWER(TRIM(u.displayName)))
            )`,
        [user.id]
      );
      for (const row of legacyRows) {
        if (row.residentId) ids.add(String(row.residentId));
      }
    } catch {
      // Keep explicit assignment results if legacy compatibility is unavailable.
    }
  }

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
