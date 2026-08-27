/**
 * Phase Progress Controller
 * @module controllers/phaseController
 * @description Phase progression tracking with strict validation
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { generateId, mapRow } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');
const { PHASE_REQUIREMENTS, CASE_PHASES, RESOURCES } = require('../utils/constants');

const baseController = createController('phaseProgress');

/**
 * Check if a phase's requirements are met for a resident
 * Returns { valid, missing: { documents[], tasks[] } }
 * Supports conditional documents (e.g. Psychological Assessment only if child is flagged)
 */
async function checkPhaseRequirements(residentId, phaseName, phaseProgressId) {
  const req = PHASE_REQUIREMENTS[phaseName];
  if (!req) return { valid: true, missing: { documents: [], tasks: [] } };

  const missing = { documents: [], tasks: [] };

  // Build the effective required documents list (base + conditional)
  let effectiveDocuments = [...req.requiredDocuments];

  // Handle conditional/optional documents based on child flags
  if (req.optionalDocuments && req.optionalDocuments.length > 0) {
    const [childRows] = await pool.query(
      'SELECT needsPsychAssessment FROM children WHERE id = ?',
      [residentId]
    );
    const child = childRows[0] || {};

    // If child is flagged for psych assessment, add it to required docs
    if (child.needsPsychAssessment && req.optionalDocuments.includes('Psychological Assessment')) {
      effectiveDocuments.push('Psychological Assessment');
    }
  }

  // Check required documents (must be Approved in documents table)
  if (effectiveDocuments.length > 0) {
    const [docs] = await pool.query(
      `SELECT title, status FROM documents WHERE residentId = ? AND phase = ?`,
      [residentId, phaseName]
    );
    const approvedTitles = docs.filter(d => d.status === 'Approved').map(d => d.title);
    for (const required of effectiveDocuments) {
      if (!approvedTitles.includes(required)) {
        missing.documents.push(required);
      }
    }
  }

  // Check required tasks (from phaseProgress.tasksCompleted)
  if (phaseProgressId && req.requiredTasks.length > 0) {
    const [rows] = await pool.query(
      'SELECT tasksCompleted FROM phaseProgress WHERE id = ?',
      [phaseProgressId]
    );
    let completed = [];
    if (rows.length > 0 && rows[0].tasksCompleted) {
      try {
        completed = JSON.parse(rows[0].tasksCompleted);
      } catch { completed = []; }
    }
    for (const task of req.requiredTasks) {
      if (!completed.includes(task)) {
        missing.tasks.push(task);
      }
    }
  } else if (req.requiredTasks.length > 0) {
    missing.tasks = [...req.requiredTasks];
  }

  // Check for unresolved violations that block advancement
  const [currentPhase] = await pool.query(
    'SELECT advancementBlocked, violationCount, demotionRecommended FROM phaseProgress WHERE id = ?',
    [phaseProgressId]
  );
  
  const hasViolationBlock = currentPhase.length > 0 && currentPhase[0].advancementBlocked;
  
  return {
    valid: missing.documents.length === 0 && missing.tasks.length === 0 && !hasViolationBlock,
    missing,
    violationBlock: hasViolationBlock ? {
      violationCount: currentPhase[0].violationCount,
      demotionRecommended: currentPhase[0].demotionRecommended,
    } : null,
  };
}

/**
 * GET /api/phases/requirements
 * Return all phase requirements (for frontend to display)
 */
async function getRequirements(req, res, next) {
  try {
    res.json({ success: true, data: PHASE_REQUIREMENTS });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/phases/resident/:residentId
 */
async function getByResident(req, res, next) {
  try {
    const { residentId } = req.params;
    const [rows] = await pool.query(
      'SELECT * FROM phaseProgress WHERE residentId = ? ORDER BY enteredAt ASC',
      [residentId]
    );
    res.json({ success: true, data: rows.map(r => mapRow('phaseProgress', r)), count: rows.length });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/phases/resident/:residentId/current
 */
async function getCurrent(req, res, next) {
  try {
    const { residentId } = req.params;
    const [rows] = await pool.query(
      'SELECT * FROM phaseProgress WHERE residentId = ? AND isCurrent = 1 ORDER BY enteredAt DESC LIMIT 1',
      [residentId]
    );

    let phase;
    if (rows.length === 0) {
      // Auto-create a phase record using the child's current casePhase
      const [childRows] = await pool.query('SELECT casePhase FROM children WHERE id = ?', [residentId]);
      const phaseName = childRows[0]?.casePhase || CASE_PHASES[0];
      const nextReq = PHASE_REQUIREMENTS[phaseName] || {};
      const [existing] = await pool.query('SELECT id FROM phaseProgress');
      const newId = generateId('PHS', existing.map(r => ({ id: r.id })));
      const today = new Date().toISOString().split('T')[0];

      await pool.query(
        `INSERT INTO phaseProgress (id, residentId, phaseName, enteredAt, isCurrent, tasksRequired, tasksCompleted, enteredBy, createdBy) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [newId, residentId, phaseName, today,
          JSON.stringify(nextReq.requiredTasks || []),
          JSON.stringify([]),
          'System', 'System']
      );
      const [newRows] = await pool.query('SELECT * FROM phaseProgress WHERE id = ?', [newId]);
      phase = mapRow('phaseProgress', newRows[0]);
    } else {
      phase = mapRow('phaseProgress', rows[0]);
    }

    const { valid, missing, violationBlock } = await checkPhaseRequirements(residentId, phase.phaseName, phase.id);
    res.json({ success: true, data: { ...phase, requirementsMet: valid, missingRequirements: missing, violationBlock } });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/phases/:id/validate
 * Validate if a phase can be completed (dry-run check)
 */
async function validate(req, res, next) {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM phaseProgress WHERE id = ?', [id]);
    if (rows.length === 0) throw new ApiError(404, 'Phase record not found');

    const phase = mapRow('phaseProgress', rows[0]);
    const { valid, missing } = await checkPhaseRequirements(phase.residentId, phase.phaseName, id);

    res.json({
      success: true,
      canAdvance: valid,
      phaseName: phase.phaseName,
      missingRequirements: missing,
      message: valid
        ? `All requirements for ${phase.phaseName} are met. Phase can be advanced.`
        : `Cannot advance: ${missing.documents.length} document(s) and ${missing.tasks.length} task(s) are incomplete.`,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/phases/validate/:residentId
 * Validate the current phase for a resident.
 */
async function validateByResident(req, res, next) {
  try {
    const { residentId } = req.params;
    const [rows] = await pool.query(
      'SELECT * FROM phaseProgress WHERE residentId = ? AND isCurrent = 1 ORDER BY enteredAt DESC LIMIT 1',
      [residentId]
    );
    if (rows.length === 0) throw new ApiError(404, 'Current phase record not found');

    const phase = mapRow('phaseProgress', rows[0]);
    const { valid, missing, violationBlock } = await checkPhaseRequirements(residentId, phase.phaseName, phase.id);
    res.json({
      success: true,
      data: {
        canProgress: valid,
        canAdvance: valid,
        currentPhase: phase.phaseName,
        missingRequirements: missing,
        violationBlock,
        message: valid
          ? `All requirements for ${phase.phaseName} are met.`
          : `Cannot advance: ${missing.documents.length} document(s) and ${missing.tasks.length} task(s) are incomplete.`,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/phases/:id/complete
 * Complete current phase and start next one (BLOCKED if requirements not met)
 */
async function complete(req, res, next) {
  try {
    const { id } = req.params;
    const { completedBy, notes } = req.body || {};

    const [rows] = await pool.query('SELECT * FROM phaseProgress WHERE id = ?', [id]);
    if (rows.length === 0) throw new ApiError(404, 'Phase record not found');

    const phase = mapRow('phaseProgress', rows[0]);

    const { valid, missing } = await checkPhaseRequirements(phase.residentId, phase.phaseName, id);
    if (!valid) {
      return res.status(422).json({
        success: false,
        canAdvance: false,
        missingRequirements: missing,
        message: `Cannot advance: ${missing.documents.length} document(s) pending approval and ${missing.tasks.length} task(s) incomplete.`,
      });
    }

    const completedAt = new Date().toISOString().split('T')[0];
    const completedByUser = completedBy || req.user?.username || 'System';

    // Mark current phase complete
    await pool.query(
      `UPDATE phaseProgress SET completedAt = ?, completedBy = ?, isCurrent = 0, notes = COALESCE(?, notes) WHERE id = ?`,
      [completedAt, completedByUser, notes, id]
    );

    // Determine next phase
    const currentIndex = CASE_PHASES.indexOf(phase.phaseName);
    let nextPhase = null;
    let readyForDischarge = false;

    if (currentIndex >= 0 && currentIndex < CASE_PHASES.length - 1) {
      nextPhase = CASE_PHASES[currentIndex + 1];

      // Create new phaseProgress record for next phase
      const [existing] = await pool.query('SELECT id FROM phaseProgress');
      const newId = generateId('PHS', existing.map(r => ({ id: r.id })));
      const nextReq = PHASE_REQUIREMENTS[nextPhase] || {};

      await pool.query(
        `INSERT INTO phaseProgress (id, residentId, phaseName, enteredAt, isCurrent, tasksRequired, tasksCompleted, enteredBy, createdBy) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [newId, phase.residentId, nextPhase, completedAt,
          JSON.stringify(nextReq.requiredTasks || []),
          JSON.stringify([]),
          completedByUser, completedByUser]
      );

      // Update child's casePhase
      await pool.query(
        'UPDATE children SET casePhase = ? WHERE id = ?',
        [nextPhase, phase.residentId]
      );
    } else if (currentIndex === CASE_PHASES.length - 1) {
      // Last phase completed — child is ready for discharge
      readyForDischarge = true;
      await pool.query(
        "UPDATE children SET status = 'Discharged' WHERE id = ?",
        [phase.residentId]
      );
    }

    res.json({
      success: true,
      message: readyForDischarge
        ? `Phase "${phase.phaseName}" completed. Resident is now ready for discharge.`
        : nextPhase
          ? `Phase "${phase.phaseName}" completed. Resident advanced to "${nextPhase}".`
          : `Phase "${phase.phaseName}" completed. Program concluded.`,
      nextPhase,
      readyForDischarge,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/phases/:id/demote
 * Demote child to previous phase due to violations
 * @async
 */
async function demote(req, res, next) {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const demotedBy = req.user?.username || 'Center Head';

    // Get current phase
    const [currentPhase] = await pool.query('SELECT * FROM phaseProgress WHERE id = ?', [id]);
    if (currentPhase.length === 0) {
      throw new ApiError(404, 'Phase record not found');
    }

    const phase = currentPhase[0];
    const currentIndex = CASE_PHASES.indexOf(phase.phaseName);
    
    // Cannot demote if already at first phase
    if (currentIndex <= 0) {
      throw new ApiError(400, 'Cannot demote - child is already in the first phase');
    }

    const prevPhase = CASE_PHASES[currentIndex - 1];
    const today = new Date().toISOString().split('T')[0];

    // Mark current phase as terminated
    await pool.query(
      'UPDATE phaseProgress SET isCurrent = 0, completedAt = ?, completedBy = ?, notes = COALESCE(?, notes) WHERE id = ?',
      [today, demotedBy, `DEMOTED: ${reason || 'Violation pattern detected'}`, id]
    );

    // Create new phase record for previous phase
    const [existing] = await pool.query('SELECT id FROM phaseProgress');
    const newId = generateId('PHS', existing.map(r => ({ id: r.id })));
    const nextReq = PHASE_REQUIREMENTS[prevPhase] || {};

    await pool.query(
      `INSERT INTO phaseProgress (id, residentId, phaseName, enteredAt, isCurrent, tasksRequired, tasksCompleted, enteredBy, createdBy, demotionCount, violationCount, advancementBlocked) 
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, FALSE)`,
      [
        newId,
        phase.residentId,
        prevPhase,
        today,
        JSON.stringify(nextReq.requiredTasks || []),
        JSON.stringify([]),
        demotedBy,
        demotedBy,
        (phase.demotionCount || 0) + 1,
      ]
    );

    // Update child's casePhase
    await pool.query(
      'UPDATE children SET casePhase = ? WHERE id = ?',
      [prevPhase, phase.residentId]
    );

    // Create notification for Case Worker
    try {
      const [childRows] = await pool.query('SELECT name FROM children WHERE id = ?', [phase.residentId]);
      const childName = childRows[0]?.name || 'Child';
      
      const [existingAlerts] = await pool.query('SELECT id FROM alerts');
      const alertId = generateId('ALR', existingAlerts.map(r => ({ id: r.id })));
      
      await pool.query(
        `INSERT INTO alerts (id, residentId, type, title, message, priority, actionRequired, relatedRecordType, relatedRecordId, targetRole)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          alertId,
          phase.residentId,
          'Phase Demotion',
          `Child Demoted - ${childName}`,
          `${childName} has been demoted from ${phase.phaseName} to ${prevPhase}. Reason: ${reason || 'Violation pattern detected'}`,
          'High',
          'Review demoted child and create remediation plan',
          'phaseProgress',
          newId,
          'socialworker',
        ]
      );
    } catch (alertErr) {
      console.error('[PhaseController] Demotion alert failed (non-fatal):', alertErr.message);
    }

    res.json({
      success: true,
      message: `Child demoted from "${phase.phaseName}" to "${prevPhase}"`,
      previousPhase: phase.phaseName,
      newPhase: prevPhase,
      demotionReason: reason,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/phases/:id/task
 * Toggle a task as complete/incomplete on a phase
 */
async function toggleTask(req, res, next) {
  try {
    const { id } = req.params;
    const { task, completed } = req.body || {};

    const [rows] = await pool.query('SELECT tasksCompleted, tasksRequired FROM phaseProgress WHERE id = ?', [id]);
    if (rows.length === 0) {
      // Return empty success so frontend doesn't crash
      return res.json({ success: true, tasksCompleted: [task].filter(() => completed), allTasksDone: false });
    }

    let tasksCompleted = [];
    try { tasksCompleted = JSON.parse(rows[0].tasksCompleted || '[]'); } catch { tasksCompleted = []; }

    if (completed && !tasksCompleted.includes(task)) {
      tasksCompleted.push(task);
    } else if (!completed) {
      tasksCompleted = tasksCompleted.filter(t => t !== task);
    }

    await pool.query(
      'UPDATE phaseProgress SET tasksCompleted = ? WHERE id = ?',
      [JSON.stringify(tasksCompleted), id]
    );

    // Check if all tasks done
    let tasksRequired = [];
    try { tasksRequired = JSON.parse(rows[0].tasksRequired || '[]'); } catch { tasksRequired = []; }
    const allTasksDone = tasksRequired.every(t => tasksCompleted.includes(t));

    res.json({ success: true, tasksCompleted, allTasksDone });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAll: baseController.getAll,
  getById: baseController.getById,
  create: baseController.create,
  update: baseController.update,
  delete: baseController.delete,
  getRequirements,
  getByResident,
  getCurrent,
  complete,
  demote,
  validate,
  validateByResident,
  toggleTask,
};
