/**
 * Phase Progress Controller
 * @module controllers/phaseController
 * @description Phase progression tracking with strict validation
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { generateId, insertWithGeneratedId, runInTransactionWithIdRetry, mapRow } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');
const { PHASE_REQUIREMENTS, LEGACY_DOCUMENT_ALIASES, LEGACY_TASK_ALIASES, CASE_PHASES, RESOURCES } = require('../utils/constants');
const notifications = require('../services/notificationService');
const { canAccessResident } = require('./assignmentController');

const baseController = createController('phaseProgress');

function parseJsonValue(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

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
      `SELECT title, status FROM documents WHERE residentId = ? AND phase = ? ORDER BY createdAt DESC, id DESC`,
      [residentId, phaseName]
    );
    const normalizedTitle = (value) => String(value || '').trim().toLowerCase();
    const hasApprovedDocument = (canonicalTitle) => {
      const acceptedTitles = [canonicalTitle, ...(LEGACY_DOCUMENT_ALIASES[canonicalTitle] || [])]
        .map(normalizedTitle);
      return docs.some(d => d.status === 'Approved' && acceptedTitles.includes(normalizedTitle(d.title)));
    };
    for (const required of effectiveDocuments) {
      // Existing uploads under a legacy title continue to satisfy the same
      // requirement. This does not rename or delete any stored document.
      if (!hasApprovedDocument(required)) {
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
    if (rows.length > 0) completed = parseJsonValue(rows[0].tasksCompleted, []);

    // Older clients stored checklist state on children.phaseTasksCompleted.
    // Include it so existing completed work remains valid for advancement.
    const [childRows] = await pool.query(
      'SELECT phaseTasksCompleted FROM children WHERE id = ?',
      [residentId]
    );
    if (childRows[0]?.phaseTasksCompleted) {
      const childTasks = parseJsonValue(childRows[0].phaseTasksCompleted, {});
      const legacyCompleted = childTasks?.[phaseName];
      if (Array.isArray(legacyCompleted)) {
        completed = [...new Set([...completed, ...legacyCompleted])];
      }
    }
    const normalizedCompleted = new Set(completed.map(item => String(item || '').trim().toLowerCase()));
    for (const task of req.requiredTasks) {
      const accepted = [task, ...(LEGACY_TASK_ALIASES[task] || [])]
        .map(item => String(item || '').trim().toLowerCase());
      if (!accepted.some(item => normalizedCompleted.has(item))) {
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
    if (!await canAccessResident(req.user, residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }
    const [rows] = await pool.query(
      'SELECT * FROM phaseProgress WHERE residentId = ? ORDER BY enteredAt ASC, id ASC',
      [residentId]
    );
    const currentRows = rows.filter(row => row.isCurrent);
    if (currentRows.length > 1) {
      const keep = currentRows[currentRows.length - 1];
      await pool.query(
        'UPDATE phaseProgress SET isCurrent = 0, completedAt = COALESCE(completedAt, CURDATE()) WHERE residentId = ? AND isCurrent = 1 AND id <> ?',
        [residentId, keep.id]
      );
      for (const row of rows) {
        if (row.id !== keep.id && currentRows.some(current => current.id === row.id)) {
          row.isCurrent = 0;
          row.completedAt = row.completedAt || new Date().toISOString().split('T')[0];
        }
      }
    }
    const data = await Promise.all(rows.map(async row => {
      const phase = mapRow('phaseProgress', row);
      const result = await checkPhaseRequirements(residentId, phase.phaseName, phase.id);
      return { ...phase, requirementsMet: result.valid, missingRequirements: result.missing, violationBlock: result.violationBlock };
    }));
    res.json({ success: true, data, count: data.length });
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
    if (!await canAccessResident(req.user, residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }
    const [rows] = await pool.query(
      'SELECT * FROM phaseProgress WHERE residentId = ? AND isCurrent = 1 ORDER BY enteredAt DESC, id DESC',
      [residentId]
    );

    if (rows.length > 1 && String(req.user?.role || '').toLowerCase() !== 'houseparent') {
      await pool.query(
        'UPDATE phaseProgress SET isCurrent = 0, completedAt = COALESCE(completedAt, CURDATE()) WHERE residentId = ? AND isCurrent = 1 AND id <> ?',
        [residentId, rows[0].id]
      );
    }

    let phase;
    if (rows.length === 0) {
      // Houseparents are strictly view-only in Phase Timeline. Never create or
      // mutate a phase record as a side effect of a read request.
      if (String(req.user?.role || '').toLowerCase() === 'houseparent') {
        return res.json({ success: true, data: null });
      }

      // Auto-create a phase record using the child's current casePhase
      const [childRows] = await pool.query('SELECT casePhase FROM children WHERE id = ?', [residentId]);
      const phaseName = childRows[0]?.casePhase || CASE_PHASES[0];
      const nextReq = PHASE_REQUIREMENTS[phaseName] || {};
      const today = new Date().toISOString().split('T')[0];

      // Two concurrent requests can derive the same id; retry instead of 500.
      const newId = await insertWithGeneratedId(pool, {
        table: 'phaseProgress',
        prefix: 'PHS',
        insert: (generatedId) => pool.query(
          `INSERT INTO phaseProgress (id, residentId, phaseName, enteredAt, isCurrent, tasksRequired, tasksCompleted, enteredBy, createdBy) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          [generatedId, residentId, phaseName, today,
            JSON.stringify(nextReq.requiredTasks || []),
            JSON.stringify([]),
            'System', 'System']
        ),
      });
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
async function getById(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT residentId FROM phaseProgress WHERE id = ?', [req.params.id]);
    if (!rows.length) throw new ApiError(404, 'Phase record not found');
    if (!await canAccessResident(req.user, rows[0].residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }
    return baseController.getById(req, res, next);
  } catch (error) {
    next(error);
  }
}

async function validate(req, res, next) {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM phaseProgress WHERE id = ?', [id]);
    if (rows.length === 0) throw new ApiError(404, 'Phase record not found');
    if (!await canAccessResident(req.user, rows[0].residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }

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
    if (!await canAccessResident(req.user, residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }
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
    const { completedBy, notes, force } = req.body || {};

    const [rows] = await pool.query('SELECT * FROM phaseProgress WHERE id = ?', [id]);
    if (rows.length === 0) throw new ApiError(404, 'Phase record not found');

    const phase = mapRow('phaseProgress', rows[0]);

    const { valid, missing } = await checkPhaseRequirements(phase.residentId, phase.phaseName, id);
    const normalizedRole = String(req.user?.role || '').toLowerCase().replace(/[\s_-]+/g, '');
    const canForceAdvance = Boolean(force) && normalizedRole === 'centerhead';
    if (!valid && !canForceAdvance) {
      return res.status(422).json({
        success: false,
        canAdvance: false,
        missingRequirements: missing,
        message: `Cannot advance: ${missing.documents.length} document(s) pending approval and ${missing.tasks.length} task(s) incomplete.`,
      });
    }

    const completedAt = new Date().toISOString().split('T')[0];
    const completedByUser = completedBy || req.user?.username || 'System';

    // Determine next phase
    const currentIndex = CASE_PHASES.indexOf(phase.phaseName);
    let nextPhase = null;
    let readyForDischarge = false;

    if (currentIndex >= 0 && currentIndex < CASE_PHASES.length - 1) {
      nextPhase = CASE_PHASES[currentIndex + 1];
    } else if (currentIndex === CASE_PHASES.length - 1) {
      // Last phase completed — child is ready for discharge
      readyForDischarge = true;
    }

    // Completing a phase writes to phaseProgress (twice) and children. Those
    // writes describe a single state transition, so they must commit or roll
    // back together — otherwise a failure halfway leaves a resident with no
    // current phase, or with two current phases.
    //
    // Retried as a whole on a primary-key collision: the new id is derived from
    // the current maximum, so two simultaneous completions can compute the same
    // one. A locking read cannot fix that here — this transaction already holds
    // a phaseProgress row lock, so locking the whole id range would deadlock
    // against a concurrent completion (see runInTransactionWithIdRetry).
    await runInTransactionWithIdRetry(pool, async (connection) => {
      // Mark current phase complete
      await connection.query(
        `UPDATE phaseProgress SET completedAt = ?, completedBy = ?, isCurrent = 0, notes = COALESCE(?, notes) WHERE id = ?`,
        [completedAt, completedByUser, notes, id]
      );

      if (nextPhase) {
        // Create new phaseProgress record for next phase
        const [existing] = await connection.query('SELECT id FROM phaseProgress');
        const newId = generateId('PHS', existing.map(r => ({ id: r.id })));
        const nextReq = PHASE_REQUIREMENTS[nextPhase] || {};

        await connection.query(
          `INSERT INTO phaseProgress (id, residentId, phaseName, enteredAt, isCurrent, tasksRequired, tasksCompleted, enteredBy, createdBy) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          [newId, phase.residentId, nextPhase, completedAt,
            JSON.stringify(nextReq.requiredTasks || []),
            JSON.stringify([]),
            completedByUser, completedByUser]
        );

        // Update child's casePhase
        await connection.query(
          'UPDATE children SET casePhase = ? WHERE id = ?',
          [nextPhase, phase.residentId]
        );
      } else if (readyForDischarge) {
        await connection.query(
          "UPDATE children SET status = 'Discharged' WHERE id = ?",
          [phase.residentId]
        );
      }
    });

    // Tell the people whose work changes. Deliberately after commit, and
    // non-fatal, for the same reason as the demotion alert below: a phase that
    // has already advanced must not be rolled back because a notification
    // could not be written.
    try {
      const childName = (await notifications.residentName(phase.residentId)) || 'Child';
      const headline = readyForDischarge
        ? `${childName} completed "${phase.phaseName}" and is now ready for discharge.`
        : nextPhase
          ? `${childName} completed "${phase.phaseName}" and advanced to "${nextPhase}".`
          : `${childName} completed "${phase.phaseName}". The program has concluded.`;

      const base = {
        type: 'Phase Progress',
        residentId: phase.residentId,
        title: readyForDischarge
          ? `Ready for Discharge - ${childName}`
          : `Phase Completed - ${childName}`,
        message: headline,
        priority: readyForDischarge ? 'High' : 'Medium',
        actionRequired: readyForDischarge ? 'Prepare the discharge requirements.' : null,
        relatedRecordType: 'phaseProgress',
        relatedRecordId: id,
        actorUsername: completedByUser,
      };

      // The case owner, addressed by role: any Social Worker may pick this up.
      await notifications.notify({
        ...base,
        targetRole: 'socialworker',
        dedupeKey: `phase-progress:${id}:completed`,
      });

      // A resident becoming discharge-ready is a supervisory event, so the
      // Center Head is included for that transition only — not for every phase.
      if (readyForDischarge) {
        await notifications.notify({
          ...base,
          targetRole: 'centerhead',
          dedupeKey: `phase-progress:${id}:discharge-ready`,
        });
      }

      // The Houseparents who run this resident's daily program need to know
      // their task list changed. Addressed by id, so the caseload rule applies
      // and a Houseparent assigned to another child never sees it.
      const houseparents = await notifications.houseparentsOf(phase.residentId);
      await notifications.notifyUsers(
        houseparents.map((hp) => hp.id),
        { ...base, dedupeKey: `phase-progress:${id}:completed-houseparent` }
      );
    } catch (alertErr) {
      console.error('[PhaseController] Phase completion alert failed (non-fatal):', alertErr.message);
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

    let newId = null;

    // Closing the current phase, opening the previous one, and re-pointing the
    // resident's casePhase describe one transition — it must not half-apply.
    // Retried as a whole on an id collision, for the same reason as `complete`.
    newId = await runInTransactionWithIdRetry(pool, async (connection) => {
      // Mark current phase as terminated
      await connection.query(
        'UPDATE phaseProgress SET isCurrent = 0, completedAt = ?, completedBy = ?, notes = COALESCE(?, notes) WHERE id = ?',
        [today, demotedBy, `DEMOTED: ${reason || 'Violation pattern detected'}`, id]
      );

      // Create new phase record for previous phase
      const [existing] = await connection.query('SELECT id FROM phaseProgress');
      const generatedId = generateId('PHS', existing.map(r => ({ id: r.id })));
      const nextReq = PHASE_REQUIREMENTS[prevPhase] || {};

      await connection.query(
        `INSERT INTO phaseProgress (id, residentId, phaseName, enteredAt, isCurrent, tasksRequired, tasksCompleted, enteredBy, createdBy, demotionCount, violationCount, advancementBlocked) 
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, FALSE)`,
        [
          generatedId,
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
      await connection.query(
        'UPDATE children SET casePhase = ? WHERE id = ?',
        [prevPhase, phase.residentId]
      );

      return generatedId;
    });

    // Create notification for Case Worker. Deliberately after commit: a failed
    // notification must not undo a demotion that already took effect.
    try {
      const childName = (await notifications.residentName(phase.residentId)) || 'Child';

      await notifications.notify({
        type: 'Phase Demotion',
        residentId: phase.residentId,
        title: `Child Demoted - ${childName}`,
        message: `${childName} has been demoted from ${phase.phaseName} to ${prevPhase}. Reason: ${reason || 'Violation pattern detected'}`,
        priority: 'High',
        actionRequired: 'Review demoted child and create remediation plan',
        relatedRecordType: 'phaseProgress',
        relatedRecordId: newId,
        targetRole: 'socialworker',
        actorUsername: demotedBy,
        // One demotion is one phaseProgress row, so the row id is the natural
        // dedupe key — a retried request cannot produce a second notification.
        dedupeKey: `phase-progress:${newId}:demoted`,
      });
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
 * Return a resident to an earlier phase so missing required documents can be
 * completed without deleting the phase history.
 */
async function returnToPhase(req, res, next) {
  try {
    const { id } = req.params;
    const { targetPhase, reason } = req.body || {};
    const [rows] = await pool.query('SELECT * FROM phaseProgress WHERE id = ?', [id]);
    if (rows.length === 0) throw new ApiError(404, 'Phase record not found');

    const current = mapRow('phaseProgress', rows[0]);
    const currentIndex = CASE_PHASES.indexOf(current.phaseName);
    const targetIndex = CASE_PHASES.indexOf(targetPhase);
    if (targetIndex < 0 || targetIndex >= currentIndex) {
      throw new ApiError(400, 'Return target must be an earlier phase');
    }

    const returnedBy = req.user?.username || 'Center Head';
    const today = new Date().toISOString().split('T')[0];

    // Same three-table transition as complete()/demote(): all or nothing, and
    // retried as a whole on an id collision.
    const newId = await runInTransactionWithIdRetry(pool, async (connection) => {
      await connection.query(
        'UPDATE phaseProgress SET isCurrent = 0, completedAt = COALESCE(completedAt, ?), completedBy = COALESCE(completedBy, ?), notes = COALESCE(?, notes) WHERE id = ?',
        [today, returnedBy, `RETURNED: ${reason || 'Required documents incomplete'}`, id]
      );

      const [existing] = await connection.query('SELECT id FROM phaseProgress');
      const generatedId = generateId('PHS', existing.map(row => ({ id: row.id })));
      const nextReq = PHASE_REQUIREMENTS[targetPhase] || {};
      await connection.query(
        `INSERT INTO phaseProgress (id, residentId, phaseName, enteredAt, isCurrent, tasksRequired, tasksCompleted, enteredBy, createdBy)
         VALUES (?, ?, ?, ?, 1, ?, '[]', ?, ?)`,
        [generatedId, current.residentId, targetPhase, today, JSON.stringify(nextReq.requiredTasks || []), returnedBy, returnedBy]
      );
      await connection.query('UPDATE children SET casePhase = ? WHERE id = ?', [targetPhase, current.residentId]);

      return generatedId;
    });

    res.json({ success: true, newPhase: targetPhase, phaseId: newId });
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

    const [rows] = await pool.query('SELECT residentId, phaseName, tasksCompleted, tasksRequired FROM phaseProgress WHERE id = ?', [id]);
    if (rows.length === 0) {
      // Return empty success so frontend doesn't crash
      return res.json({ success: true, tasksCompleted: [task].filter(() => completed), allTasksDone: false });
    }
    if (!await canAccessResident(req.user, rows[0].residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }

    // Houseparents may complete only the Orientation Phase checklist.
    // They cannot toggle requirements in any other phase, even if the
    // resident is in their assigned caseload.
    const normalizedRole = String(req.user?.role || '').toLowerCase().replace(/[\s_-]+/g, '');
    if (normalizedRole === 'houseparent') {
      if (rows[0].phaseName !== 'Orientation Phase') {
        throw new ApiError(403, 'Houseparents may only complete Orientation Phase checklist items.');
      }
      const orientationConfig = PHASE_REQUIREMENTS['Orientation Phase'] || {};
      const requiredTasks = Array.isArray(orientationConfig.requiredTasks) ? orientationConfig.requiredTasks : [];
      const optionalTasks = Array.isArray(orientationConfig.optionalTasks) ? orientationConfig.optionalTasks : [];
      const allowedOrientationTasks = [...new Set([...requiredTasks, ...optionalTasks])];
      if (!allowedOrientationTasks.includes(task)) {
        throw new ApiError(403, 'This checklist item is not part of the Orientation Phase checklist.');
      }
    }

    let tasksCompleted = parseJsonValue(rows[0].tasksCompleted, []);

    if (completed && !tasksCompleted.includes(task)) {
      tasksCompleted.push(task);
    } else if (!completed) {
      const aliases = new Set([task, ...(LEGACY_TASK_ALIASES[task] || [])].map(item => String(item)));
      tasksCompleted = tasksCompleted.filter(t => !aliases.has(String(t)));
    }

    await pool.query(
      'UPDATE phaseProgress SET tasksCompleted = ? WHERE id = ?',
      [JSON.stringify(tasksCompleted), id]
    );

    const [phaseRows] = await pool.query('SELECT residentId, phaseName FROM phaseProgress WHERE id = ?', [id]);
    if (phaseRows.length > 0) {
      const [childRows] = await pool.query('SELECT phaseTasksCompleted FROM children WHERE id = ?', [phaseRows[0].residentId]);
      let childTasks = {};
      try { childTasks = JSON.parse(childRows[0]?.phaseTasksCompleted || '{}'); } catch { childTasks = {}; }
      childTasks[phaseRows[0].phaseName] = tasksCompleted;
      // Checklist completion is the one resident-level write Houseparents are
      // allowed to make. It is written here (rather than through PUT /children,
      // which correctly remains forbidden to Houseparents) so the persisted
      // checklist state is also available to the SPA/store after a reload.
      await pool.query('UPDATE children SET phaseTasksCompleted = ? WHERE id = ?', [JSON.stringify(childTasks), phaseRows[0].residentId]);
    }

    // Check if all tasks done
    const tasksRequired = parseJsonValue(rows[0].tasksRequired, []);
    const allTasksDone = tasksRequired.every(t => tasksCompleted.includes(t));

    res.json({ success: true, tasksCompleted, allTasksDone });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAll: baseController.getAll,
  getById,
  create: baseController.create,
  update: baseController.update,
  delete: baseController.delete,
  getRequirements,
  getByResident,
  getCurrent,
  complete,
  demote,
  returnToPhase,
  validate,
  validateByResident,
  toggleTask,
};
