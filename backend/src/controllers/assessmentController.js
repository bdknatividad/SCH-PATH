/**
 * Assessment Controller
 * @module controllers/assessmentController
 * @description Assessment scheduling and management
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { ApiError } = require('../middleware/errorHandler');
const { canAccessResident } = require('./assignmentController');

const baseController = createController('assessments');

function isHouseparent(user) {
  return String(user?.role || '').toLowerCase() === 'houseparent';
}

/**
 * A Houseparent's assigned resident ids, for scoping assessment queries.
 * forResidents is stored as a JSON array string, so scoping is done with
 * OR'd LIKE conditions against each assigned id — the same substring-match
 * approach getByResident already used, just extended to a list of ids
 * instead of one.
 */
async function getAssignedResidentIds(userId) {
  const [rows] = await pool.query(
    `SELECT residentId FROM residentAssignments WHERE userId = ? AND status = 'Active'`,
    [userId]
  );
  return rows.map(r => r.residentId);
}

/**
 * Get all assessments, scoped for Houseparents to only assessments that
 * include at least one of their assigned residents. Previously fully
 * unscoped — any role could see every assessment for every resident.
 */
async function getAll(req, res, next) {
  try {
    if (isHouseparent(req.user)) {
      const residentIds = await getAssignedResidentIds(req.user.id);
      if (residentIds.length === 0) {
        return res.json({ success: true, data: [], count: 0 });
      }
      const conditions = residentIds.map(() => 'forResidents LIKE ?').join(' OR ');
      const values = residentIds.map(id => `%${id}%`);
      const [rows] = await pool.query(
        `SELECT * FROM assessments WHERE (${conditions}) ORDER BY date DESC, time DESC`,
        values
      );
      return res.json({ success: true, data: rows, count: rows.length });
    }
    return baseController.getAll(req, res, next);
  } catch (error) {
    next(error);
  }
}

async function getById(req, res, next) {
  try {
    if (isHouseparent(req.user)) {
      const { id } = req.params;
      const [rows] = await pool.query('SELECT forResidents FROM assessments WHERE id = ?', [id]);
      if (rows.length === 0) throw new ApiError(404, 'Assessment not found');
      let forResidents = [];
      try {
        forResidents = Array.isArray(rows[0].forResidents) ? rows[0].forResidents : JSON.parse(rows[0].forResidents || '[]');
      } catch {
        forResidents = [];
      }
      const allowed = await Promise.all(forResidents.map(rid => canAccessResident(req.user, rid)));
      if (!allowed.some(Boolean)) {
        throw new ApiError(403, 'You are not assigned to any resident on this assessment');
      }
    }
    return baseController.getById(req, res, next);
  } catch (error) {
    next(error);
  }
}

/**
 * Get assessments by resident
 * @async
 */
async function getByResident(req, res, next) {
  try {
    const { residentId } = req.params;
    if (!await canAccessResident(req.user, residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }
    
    const [rows] = await pool.query(
      `SELECT * FROM assessments 
       WHERE forResidents LIKE ? 
       ORDER BY date DESC, time DESC`,
      [`%${residentId}%`]
    );

    res.json({
      success: true,
      data: rows,
      count: rows.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get upcoming assessments
 * @async
 */
async function getUpcoming(req, res, next) {
  try {
    const today = new Date().toISOString().split('T')[0];

    if (isHouseparent(req.user)) {
      const residentIds = await getAssignedResidentIds(req.user.id);
      if (residentIds.length === 0) {
        return res.json({ success: true, data: [], count: 0 });
      }
      const conditions = residentIds.map(() => 'forResidents LIKE ?').join(' OR ');
      const values = residentIds.map(id => `%${id}%`);
      const [rows] = await pool.query(
        `SELECT * FROM assessments
         WHERE date >= ? AND status = ? AND (${conditions})
         ORDER BY date ASC, time ASC
         LIMIT 20`,
        [today, 'Scheduled', ...values]
      );
      return res.json({ success: true, data: rows, count: rows.length });
    }
    
    const [rows] = await pool.query(
      `SELECT * FROM assessments 
       WHERE date >= ? AND status = ? 
       ORDER BY date ASC, time ASC 
       LIMIT 20`,
      [today, 'Scheduled']
    );

    res.json({
      success: true,
      data: rows,
      count: rows.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get pending assessments count
 * @async
 */
async function getPendingCount(req, res, next) {
  try {
    if (isHouseparent(req.user)) {
      const residentIds = await getAssignedResidentIds(req.user.id);
      if (residentIds.length === 0) return res.json({ success: true, count: 0 });
      const conditions = residentIds.map(() => 'forResidents LIKE ?').join(' OR ');
      const [rows] = await pool.query(
        `SELECT COUNT(*) AS count FROM assessments
         WHERE status = 'Scheduled' AND (${conditions})`,
        residentIds.map(id => `%${id}%`)
      );
      return res.json({ success: true, count: rows[0].count });
    }

    const [rows] = await pool.query(
      'SELECT COUNT(*) as count FROM assessments WHERE status = ?',
      ['Scheduled']
    );

    res.json({
      success: true,
      count: rows[0].count,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Complete assessment
 * @async
 */
async function complete(req, res, next) {
  try {
    const { id } = req.params;
    const { results, findings } = req.body || {};

    // Sync completion back to the exact violation/intervention that created
    // this assessment. The assessment UPDATE and the downstream sync MUST live
    // in the same transaction: otherwise a failure while syncing leaves the
    // assessment marked "Completed" while its intervention requirement stays
    // open — a permanently half-applied state that no retry can repair.
    let syncedViolationIds = [];
    let syncedInterventionTrackerId = null;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [rows] = await connection.query(
        'SELECT violationIds, interventionTrackerId, interventionRequirementId FROM assessments WHERE id = ? FOR UPDATE',
        [id]
      );

      // Every assessment must have supporting documentation before it can be
      // completed. Documents uploaded from the Assessment module are linked
      // directly by assessmentId, so this gate cannot be bypassed by the UI.
      const [assessmentDocs] = await connection.query(
        `SELECT id FROM documents WHERE assessmentId = ? AND status <> 'Archived' LIMIT 1`,
        [id]
      );
      if (!assessmentDocs.length) {
        throw new ApiError(422, 'Upload at least one supporting document before marking this assessment complete.');
      }

      await connection.query(
        `UPDATE assessments
         SET status = ?, results = ?, description = COALESCE(?, description), modifiedBy = ?
         WHERE id = ?`,
        ['Completed', JSON.stringify(results || {}), findings, req.user?.username || 'System', id]
      );

      const raw = rows[0]?.violationIds;
      let violationIds = [];
      try {
        violationIds = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
      } catch {
        violationIds = [];
      }

      if (Array.isArray(violationIds) && violationIds.length > 0) {
        const placeholders = violationIds.map(() => '?').join(', ');
        await connection.query(
          `UPDATE violations
           SET assessmentCompleted = TRUE
           WHERE id IN (${placeholders})`,
          violationIds
        );
        syncedViolationIds = violationIds;
      }

      if (rows[0]?.interventionTrackerId) {
        const trackerId = rows[0].interventionTrackerId;
        const [tracker] = await connection.query(
          `SELECT id, residentId, violationId
           FROM intervention_tracker
           WHERE id = ? FOR UPDATE`,
          [trackerId]
        );
        if (!tracker.length) {
          throw new ApiError(409, 'The linked intervention requirement no longer exists.');
        }

        const actor = req.user?.username || 'System';

        if (rows[0]?.interventionRequirementId) {
          const [requirement] = await connection.query(
            `SELECT id, interventionId, status
             FROM intervention_requirements
             WHERE id = ? AND interventionId = ?
             FOR UPDATE`,
            [rows[0].interventionRequirementId, trackerId]
          );
          if (!requirement.length) {
            throw new ApiError(409, 'The linked intervention requirement no longer exists.');
          }

          await connection.query(
            `UPDATE intervention_requirements
             SET status = 'Done', completedAt = COALESCE(completedAt, NOW()),
                 completedBy = COALESCE(completedBy, ?)
             WHERE id = ?`,
            [actor, rows[0].interventionRequirementId]
          );

          // The tracker/intervention itself becomes completed only when all
          // requirements underneath it are Done.
          const [remaining] = await connection.query(
            `SELECT COUNT(*) AS incomplete
             FROM intervention_requirements
             WHERE interventionId = ? AND status <> 'Done'`,
            [trackerId]
          );
          if (Number(remaining[0]?.incomplete || 0) === 0) {
            await connection.query(
              `UPDATE intervention_tracker
               SET status = 'Completed', completionDate = CURDATE(), completedBy = ?
               WHERE id = ?`,
              [actor, trackerId]
            );
          }
        } else {
          // Backward compatibility for assessments created before the
          // requirement-level link existed.
          await connection.query(
            `UPDATE intervention_tracker
             SET status = 'Completed', completionDate = CURDATE(), completedBy = ?
             WHERE id = ?`,
            [actor, trackerId]
          );
          await connection.query(
            `UPDATE intervention_requirements
             SET status = 'Done', completedAt = COALESCE(completedAt, NOW()),
                 completedBy = COALESCE(completedBy, ?)
             WHERE interventionId = ?`,
            [actor, trackerId]
          );
        }
        syncedInterventionTrackerId = trackerId;
      }

      await connection.commit();
    } catch (syncErr) {
      try { await connection.rollback(); } catch {}
      throw syncErr;
    } finally {
      connection.release();
    }

    res.json({
      success: true,
      message: 'Assessment marked as completed',
      syncedViolationIds,
      syncedInterventionTrackerId,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAll,
  getById,
  create: baseController.create,
  update: baseController.update,
  delete: baseController.delete,
  getByResident,
  getUpcoming,
  getPendingCount,
  complete,
};
