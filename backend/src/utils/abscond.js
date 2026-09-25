/**
 * Absconded residents.
 *
 * A resident marked Absconded keeps every record they have — phase progress,
 * documents, violations, health, admissions — but the record is frozen: the
 * Phase Timeline stops (no phase can be advanced, returned, completed or
 * changed) and no new document can be filed for them. Everything stays
 * readable.
 *
 * The one record that does change is the admission itself: marking a resident
 * Absconded closes their current admission (`admissions.status` goes from
 * 'Active' to 'Closed'), the same way a discharge closes one — see
 * `childController.abscond`. Nothing on the admission is deleted or
 * rewritten, so it remains fully intact as history; only its status and
 * closedDate move, which is also what lets the resident be admitted again
 * later without reopening or overwriting it.
 */
const { pool } = require('../config/database');
const { ApiError } = require('../middleware/errorHandler');

const ABSCONDED_STATUS = 'Absconded';

async function isResidentAbsconded(residentId, executor = pool) {
  if (!residentId) return false;
  const [rows] = await executor.query('SELECT status FROM children WHERE id = ? LIMIT 1', [residentId]);
  return rows[0]?.status === ABSCONDED_STATUS;
}

/** Throws 409 when the resident is absconded. */
async function assertResidentNotAbsconded(residentId, action = 'changed', executor = pool) {
  if (await isResidentAbsconded(residentId, executor)) {
    throw new ApiError(409, `This resident has absconded. Their record is view-only and cannot be ${action}.`);
  }
}

/**
 * Route guard for the Phase Timeline's writes. The resident comes from the
 * body (create) or from the phaseProgress row named in the URL.
 */
function blockAbscondedPhaseWrites(req, res, next) {
  (async () => {
    let residentId = req.body?.residentId || null;
    if (!residentId && req.params?.id) {
      const [rows] = await pool.query('SELECT residentId FROM phaseProgress WHERE id = ? LIMIT 1', [req.params.id]);
      residentId = rows[0]?.residentId || null;
    }
    await assertResidentNotAbsconded(residentId, 'moved through the Phase Timeline');
  })().then(() => next(), next);
}

module.exports = { ABSCONDED_STATUS, isResidentAbsconded, assertResidentNotAbsconded, blockAbscondedPhaseWrites };
