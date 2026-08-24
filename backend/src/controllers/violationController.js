/**
 * Violation Controller
 * @module controllers/violationController
 * @description Violation logging with rule-based automated assessment scheduling,
 *              structured intervention recommendations, and alert generation.
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { generateId, mapRow } = require('../utils/helpers');
const { RESOURCES, ASSESSMENT_TYPES, VIOLATION_SEVERITY, VIOLATION_MATRIX } = require('../utils/constants');
const { ApiError } = require('../middleware/errorHandler');

const baseController = createController('violations');

// ─── RULE-BASED ASSESSMENT DECISION ENGINE ───────────────────────────────────

/**
 * Match violation type against the VIOLATION_MATRIX to get structured rules.
 * Falls back to severity-based defaults when no keyword matches.
 */
function matchViolationRule(violationType, severity) {
  const lower = (violationType || '').toLowerCase();

  // Primary: keyword match against matrix
  for (const rule of VIOLATION_MATRIX) {
    if (rule.keywords.some(kw => lower.includes(kw))) {
      if (!rule.severity || rule.severity.includes(severity)) {
        return rule;
      }
    }
  }

  // Secondary: severity-only fallback
  if (severity === 'Critical') {
    return {
      autoAssessment: ASSESSMENT_TYPES.GENERAL,
      intervention: 'Immediate multi-disciplinary review required. Notify Center Head, Psychologist, and Social Worker.',
      escalate: true,
      alertPriority: 'Urgent',
    };
  }
  if (severity === 'Major') {
    return {
      autoAssessment: ASSESSMENT_TYPES.BEHAVIORAL,
      intervention: 'Behavioral assessment required within 48 hours. Counseling session to be scheduled.',
      escalate: false,
      alertPriority: 'High',
    };
  }
  // Minor — still gets a Behavioral Coaching assessment
  return {
    autoAssessment: ASSESSMENT_TYPES.BEHAVIORAL,
    intervention: 'Document incident. Verbal reminder and behavioral coaching by assigned Social Worker.',
    escalate: false,
    alertPriority: 'Medium',
  };
}

/**
 * Generate structured intervention recommendation based on rule + case context.
 */
function buildInterventionPlan(violation, rule, residentName, totalPoints) {
  const deadline = violation.severity === 'Critical' ? '24 hours'
    : violation.severity === 'Major' ? '48 hours'
    : '72 hours';

  const phaseContext = violation.casePhase
    ? `Child is currently in the ${violation.casePhase} phase.`
    : '';

  const pointsContext = totalPoints >= 10
    ? `⚠️ Cumulative points (${totalPoints}) exceed threshold — escalation and case review required.`
    : `Cumulative violation points: ${totalPoints}.`;

  return {
    summary: `[AUTO-INTERVENTION] ${violation.severity} violation by ${residentName}: "${violation.type}"`,
    deadline,
    immediateAction: rule.intervention || 'Review and document. Assign counseling session.',
    assessmentRequired: !!(rule.autoAssessment),
    assessmentType: rule.autoAssessment?.type || null,
    assessor: rule.autoAssessment?.assessor || null,
    escalate: rule.escalate || false,
    phaseNote: phaseContext,
    pointsNote: pointsContext,
    fullDescription: [
      `Violation: ${violation.type} (${violation.severity}, ${violation.points} pt${violation.points !== 1 ? 's' : ''})`,
      `Date: ${violation.date} | Reported by: ${violation.reportedBy || 'Staff'}`,
      phaseContext,
      pointsContext,
      `Required action: ${rule.intervention || 'Counseling and documentation'}`,
      `Action deadline: within ${deadline}`,
    ].filter(Boolean).join('\n'),
  };
}

/**
 * Auto-create a scheduled assessment from the rule engine.
 */
async function autoCreateAssessment(violation, residentName, rule, sessionType = 'group') {
  if (!rule?.autoAssessment) return null;

  const asmConfig = rule.autoAssessment;
  const asmTitle = asmConfig.title || `Behavioral Assessment — ${violation.type}`;

  // Tomorrow Manila time (GMT+8)
  const _manilaMs = new Date().getTime() + (8 * 60 * 60 * 1000) + (24 * 60 * 60 * 1000);
  const _d = new Date(_manilaMs);
  const _pad = (n) => String(n).padStart(2, '0');
  const scheduleDate = `${_d.getUTCFullYear()}-${_pad(_d.getUTCMonth()+1)}-${_pad(_d.getUTCDate())}`;

  const plan = buildInterventionPlan(
    violation, rule, residentName,
    await getResidentViolationPoints(violation.residentId)
  );

  // ── GROUP MERGING: only if sessionType is 'group' (not 'individual') ──
  const [existingGroup] = sessionType === 'group' ? await pool.query(
    'SELECT * FROM assessments WHERE title = ? AND date = ? AND type = ? AND status = ?',
    [asmTitle, scheduleDate, asmConfig.type, 'Scheduled']
  ) : [[]];

  if (sessionType === 'group' && existingGroup.length > 0) {
    // Merge this child into the existing group assessment
    const existing = existingGroup[0];
    let currentResidents = [];
    try {
      currentResidents = JSON.parse(existing.forResidents || '[]');
      if (!Array.isArray(currentResidents)) currentResidents = [];
    } catch { currentResidents = []; }

    if (!currentResidents.includes(violation.residentId)) {
      currentResidents.push(violation.residentId);
      await pool.query(
        'UPDATE assessments SET forResidents = ?, description = ? WHERE id = ?',
        [
          JSON.stringify(currentResidents),
          (existing.description || '') + `
Grouped: ${residentName} — ${violation.severity} violation: "${violation.type}"`,
          existing.id,
        ]
      );
    }

    await pool.query('UPDATE violations SET assessmentTriggered = ? WHERE id = ?', [true, violation.id]);
    return { ...existing, forResidents: currentResidents, merged: true, interventionPlan: plan };
  }

  // ── CREATE NEW assessment (no existing group found) ──────────────────
  const [allAsms] = await pool.query('SELECT id FROM assessments');
  const newId = generateId('ASM', allAsms.map(r => ({ id: r.id })));

  // Pick a unique time slot for tomorrow
  const TIME_SLOTS = ['8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM'];
  const [usedOnDate] = await pool.query(
    'SELECT time FROM assessments WHERE date = ? AND status = ?',
    [scheduleDate, 'Scheduled']
  );
  const usedTimes = usedOnDate.map(r => r.time);
  const availableTime = TIME_SLOTS.find(t => !usedTimes.includes(t)) || '9:00 AM';

  const finalTitle = sessionType === 'individual'
    ? asmTitle.replace('[AUTO]', '[INDIVIDUAL]')
    : asmTitle;

  const assessmentData = {
    id: newId,
    title: finalTitle,
    date: scheduleDate,
    time: availableTime,
    type: asmConfig.type,
    assessor: asmConfig.assessor,
    status: 'Scheduled',
    forResidents: JSON.stringify([violation.residentId]),
    description: plan.fullDescription,
    triggeredBy: `Violation: ${violation.type} (${violation.severity})`,
  };

  const columns = Object.keys(assessmentData);
  const placeholders = columns.map(() => '?').join(', ');
  await pool.query(
    `INSERT INTO assessments (${columns.join(', ')}) VALUES (${placeholders})`,
    Object.values(assessmentData)
  );

  await pool.query('UPDATE violations SET assessmentTriggered = ? WHERE id = ?', [true, violation.id]);
  return { ...assessmentData, interventionPlan: plan };
}

/**
 * Activity matrix — maps violation keywords to restorative activities
 */
const ACTIVITY_MATRIX = [
  { keywords: ['fight','assault','violence','attack','harm','aggress','weapon'],
    activity: 'Conflict Resolution Group Session', type: 'Behavioral Activity',
    location: 'Multi-Purpose Hall', facilitator: 'Social Worker',
    description: 'Group conflict resolution workshop. Children who committed violence-related violations are grouped to promote accountability, empathy, and peaceful communication.' },
  { keywords: ['theft','steal','stolen','robbery'],
    activity: 'Livelihood Skills Training', type: 'Livelihood Activity',
    location: 'Skills Training Room', facilitator: 'Educator',
    description: 'Livelihood activity to redirect focus to productive skills. Children with theft-related violations learn income-generating skills and develop responsibility.' },
  { keywords: ['bully','harass','intimidate','threaten'],
    activity: 'Team Building — Basketball', type: 'Sports & Recreation',
    location: 'Basketball Court', facilitator: 'Social Worker',
    description: 'Supervised basketball session to promote teamwork and sportsmanship. Children with bullying violations build positive peer relationships through structured play.' },
  { keywords: ['property','damage','destroy','vandal'],
    activity: 'Clean-Up Drive & Facility Maintenance', type: 'Community Service',
    location: 'Facility Grounds', facilitator: 'Educator',
    description: 'Restorative clean-up activity. Children who damaged property take responsibility by cleaning and maintaining the facility.' },
  { keywords: ['disrespect','defiance','insubordination','attitude','conduct'],
    activity: 'Values Formation Session', type: 'Behavioral Activity',
    location: 'Counseling Room', facilitator: 'Social Worker',
    description: 'Structured values formation and reflection. Children with conduct violations discuss respect, discipline, and positive behavior.' },
  { keywords: ['escape','runaway','awol','absent without leave'],
    activity: 'Gardening & Nature Care', type: 'Therapeutic Activity',
    location: 'Facility Garden', facilitator: 'Educator',
    description: 'Therapeutic gardening to build routine, responsibility, and connection to the facility.' },
  { keywords: ['drug','substance','alcohol','inhale','sniff'],
    activity: 'Health & Wellness Workshop', type: 'Health Activity',
    location: 'Health Room', facilitator: 'Nurse',
    description: 'Health education on substance awareness and wellness.' },
];

/**
 * Auto-schedule a restorative activity based on violation type + severity.
 * Groups children with the same violation type and severity into one activity.
 */
async function autoScheduleActivity(violation, residentName) {
  const lower = (violation.type || '').toLowerCase();
  const matchedRule = ACTIVITY_MATRIX.find(r => r.keywords.some(kw => lower.includes(kw)));
  if (!matchedRule) return null;

  const activityTitle = `[AUTO] ${matchedRule.activity} (${violation.severity})`;

  // Tomorrow Manila time
  const _ms = new Date().getTime() + (8 * 60 * 60 * 1000) + (24 * 60 * 60 * 1000);
  const _d = new Date(_ms);
  const _p = (n) => String(n).padStart(2, '0');
  const scheduleDate = `${_d.getUTCFullYear()}-${_p(_d.getUTCMonth()+1)}-${_p(_d.getUTCDate())}`;

  // Check if same activity already scheduled for tomorrow (group merging)
  const [existingGroup] = await pool.query(
    'SELECT * FROM activities WHERE title = ? AND date = ? AND status = ?',
    [activityTitle, scheduleDate, 'Upcoming']
  );

  if (existingGroup.length > 0) {
    const existing = existingGroup[0];
    let currentIds = [];
    try {
      currentIds = JSON.parse(existing.selectedResidentIds || '[]');
      if (!Array.isArray(currentIds)) currentIds = [];
    } catch { currentIds = []; }

    if (!currentIds.includes(violation.residentId)) {
      currentIds.push(violation.residentId);
      await pool.query(
        'UPDATE activities SET selectedResidentIds = ?, notes = ? WHERE id = ?',
        [
          JSON.stringify(currentIds),
          (existing.notes || '') + `\nGrouped: ${residentName} — ${violation.type} (${violation.severity})`,
          existing.id,
        ]
      );
    }
    return { ...existing, selectedResidentIds: currentIds, merged: true };
  }

  // Create new activity
  const [allActs] = await pool.query('SELECT id FROM activities');
  const newId = generateId('ACT', allActs.map(r => ({ id: r.id })));

  const TIME_SLOTS = ['8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM'];
  const [usedOnDate] = await pool.query(
    'SELECT time FROM activities WHERE date = ? AND status = ?',
    [scheduleDate, 'Upcoming']
  );
  const usedTimes = usedOnDate.map(r => r.time);
  const availableTime = TIME_SLOTS.find(t => !usedTimes.includes(t)) || '1:00 PM';

  const activityData = {
    id: newId,
    title: activityTitle,
    date: scheduleDate,
    time: availableTime,
    type: matchedRule.type,
    category: 'Auto-Scheduled',
    location: matchedRule.location,
    status: 'Upcoming',
    description: matchedRule.description,
    notes: `Auto-scheduled for ${violation.severity} violation: "${violation.type}" by ${residentName}. Children with the same violation type and severity are grouped into this session.`,
    personInCharge: JSON.stringify([matchedRule.facilitator]),
    facilitators: JSON.stringify([matchedRule.facilitator]),
    selectedResidentIds: JSON.stringify([violation.residentId]),
  };

  const columns = Object.keys(activityData);
  const placeholders = columns.map(() => '?').join(', ');
  await pool.query(
    `INSERT INTO activities (${columns.join(', ')}) VALUES (${placeholders})`,
    Object.values(activityData)
  );

  return activityData;
}

/**
 * Get total active violation points for a resident.
 */
async function getResidentViolationPoints(residentId) {
  const [rows] = await pool.query(
    "SELECT COALESCE(SUM(points), 0) as total FROM violations WHERE residentId = ? AND status != 'Dismissed'",
    [residentId]
  );
  return rows[0]?.total || 0;
}

/**
 * Get resident name from DB.
 */
async function getResidentName(residentId) {
  if (!residentId) return 'Unknown';
  try {
    const [rows] = await pool.query('SELECT name FROM children WHERE id = ?', [residentId]);
    return rows[0]?.name || 'Unknown';
  } catch { return 'Unknown'; }
}

/**
 * Auto-create alert for the violation with structured intervention text.
 */
async function autoCreateAlert(violation, residentName, plan) {
  const priority = violation.severity === 'Critical' ? 'Urgent'
    : violation.severity === 'Major' ? 'High' : 'Medium';

  const [existing] = await pool.query('SELECT id FROM alerts');
  const newId = generateId('ALT', existing.map(r => ({ id: r.id })));

  const alertData = {
    id: newId,
    residentId: violation.residentId,
    type: 'Violation',
    title: `${violation.severity} Violation: ${violation.type}`,
    message: plan
      ? `${plan.summary}\n\nRequired Action: ${plan.immediateAction}\nDeadline: ${plan.deadline}\n${plan.pointsNote}`
      : `${violation.severity} violation recorded for ${residentName}: ${violation.type}`,
    priority,
    isRead: false,
    actionRequired: plan?.immediateAction || 'Review violation and take appropriate action',
    relatedRecordType: 'violation',
    relatedRecordId: violation.id,
  };

  const columns = Object.keys(alertData);
  const placeholders = columns.map(() => '?').join(', ');

  try {
    await pool.query(
      `INSERT INTO alerts (${columns.join(', ')}) VALUES (${placeholders})`,
      Object.values(alertData)
    );
    return alertData;
  } catch { return null; }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Create new violation — runs rule engine, creates assessment + alert automatically.
 */
async function create(req, res, next) {
  try {
    const residentName = await getResidentName(req.body.residentId);

    if (!req.body.status) req.body.status = 'Pending Review';

    // Always determine requiresAssessment via rule engine (override frontend value)
    const rule = matchViolationRule(req.body.type || '', req.body.severity || 'Minor');
    req.body.requiresAssessment = true; // All violations require assessment

    // Insert violation
    const [existingVio] = await pool.query('SELECT id FROM violations');
    const newId = generateId('VIO', existingVio.map(r => ({ id: r.id })));

    const config = RESOURCES.violations;
    const columns = ['id'];
    const values = [newId];
    const placeholders = ['?'];

    for (const col of config.columns) {
      if (col !== 'id' && col !== 'createdAt' && col !== 'updatedAt') {
        if (req.body[col] !== undefined) {
          columns.push(col);
          values.push(req.body[col]);
          placeholders.push('?');
        }
      }
    }
    await pool.query(
      `INSERT INTO violations (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    );

    const [rows] = await pool.query('SELECT * FROM violations WHERE id = ?', [newId]);
    const violation = mapRow('violations', rows[0]);

    // Run rule engine
    const totalPoints = await getResidentViolationPoints(req.body.residentId);
    const plan = buildInterventionPlan(violation, rule, residentName, totalPoints);

    // Auto-schedule assessment — wrapped so failure never blocks violation save
    let assessment = null;
    try {
      // Always auto-create assessment — rule engine determines type
      if (!violation.assessmentTriggered) {
        assessment = await autoCreateAssessment(violation, residentName, rule, req.body.sessionType || 'group');
      }
    } catch (asmErr) {
      console.error('[ViolationController] Assessment auto-create failed (non-fatal):', asmErr.message);
    }

    // Auto-schedule restorative activity — wrapped so failure never blocks violation save
    let activity = null;
    try {
      activity = await handleActivityRecommendation(violation, residentName);
    } catch (actErr) {
      console.error('[ViolationController] Activity recommendation failed (non-fatal):', actErr.message);
    }

    // Auto-create alert — wrapped so failure never blocks violation save
    let alert = null;
    try {
      alert = await autoCreateAlert(violation, residentName, plan);
    } catch (altErr) {
      console.error('[ViolationController] Alert auto-create failed (non-fatal):', altErr.message);
    }

    // Track violation in current phase and block advancement
    try {
      // Get current phase for this resident
      const [currentPhase] = await pool.query(
        'SELECT id, violationCount, phaseName FROM phaseProgress WHERE residentId = ? AND isCurrent = 1 LIMIT 1',
        [req.body.residentId]
      );

      if (currentPhase.length > 0) {
        const phaseId = currentPhase[0].id;
        const newViolationCount = (currentPhase[0].violationCount || 0) + 1;
        
        // Update phase progress: increment violation count and block advancement
        await pool.query(
          'UPDATE phaseProgress SET violationCount = ?, advancementBlocked = TRUE WHERE id = ?',
          [newViolationCount, phaseId]
        );

        // If 2nd+ violation, create demotion recommendation alert for Center Head
        if (newViolationCount >= 2) {
          await pool.query(
            'UPDATE phaseProgress SET demotionRecommended = TRUE WHERE id = ?',
            [phaseId]
          );
          
          // Create alert for Center Head about demotion recommendation
          try {
            const [existingAlerts] = await pool.query('SELECT id FROM alerts');
            const alertId = generateId('ALR', existingAlerts.map(r => ({ id: r.id })));
            
            await pool.query(
              `INSERT INTO alerts (id, residentId, type, title, message, priority, actionRequired, relatedRecordType, relatedRecordId, targetRole)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                alertId,
                req.body.residentId,
                'Demotion Recommended',
                `Demotion Review Required - ${residentName}`,
                `${residentName} has ${newViolationCount} violations in ${currentPhase[0].phaseName}. Demotion to previous phase is recommended.`,
                'High',
                'Review for phase demotion',
                'phaseProgress',
                phaseId,
                'centerhead',
              ]
            );
          } catch (demoteAlertErr) {
            console.error('[ViolationController] Demotion alert failed (non-fatal):', demoteAlertErr.message);
          }
        }
      }
    } catch (phaseTrackErr) {
      console.error('[ViolationController] Phase tracking failed (non-fatal):', phaseTrackErr.message);
    }

    // Always return success — violation is saved regardless of assessment/alert outcome
    res.status(201).json({
      success: true,
      data: {
        ...violation,
        autoCreatedAssessment: assessment,
        autoCreatedActivity: activity,
        autoCreatedAlerts: alert ? [alert] : [],
        interventionPlan: plan,
      },
      message: assessment
        ? 'Violation logged. Assessment auto-scheduled.'
        : 'Violation logged. Manual assessment scheduling required.',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Review / update a violation.
 */
async function review(req, res, next) {
  try {
    const { id } = req.params;
    const { status, actionTaken, reviewedBy } = req.body || {};

    if (!status) throw new ApiError(400, 'Status is required');

    // Get the violation before updating to know the residentId
    const [violationRows] = await pool.query('SELECT * FROM violations WHERE id = ?', [id]);
    if (violationRows.length === 0) {
      throw new ApiError(404, 'Violation not found');
    }
    const violation = violationRows[0];

    await pool.query(
      `UPDATE violations SET status = ?, actionTaken = ?, reviewedBy = ? WHERE id = ?`,
      [status, actionTaken || null, reviewedBy || req.user?.username, id]
    );

    await pool.query(
      `UPDATE alerts SET isRead = TRUE, readBy = ?, readAt = NOW() WHERE relatedRecordType = 'violation' AND relatedRecordId = ?`,
      [reviewedBy || req.user?.username || 'System', id]
    );

    // If violation is resolved, check if there are any other pending violations
    if (status === 'Resolved' || status === 'Closed') {
      const [pendingViolations] = await pool.query(
        `SELECT COUNT(*) as count FROM violations 
         WHERE residentId = ? AND status IN ('Pending', 'Under Review')`,
        [violation.residentId]
      );

      // If no more pending violations, unblock advancement
      if (pendingViolations[0].count === 0) {
        await pool.query(
          'UPDATE phaseProgress SET advancementBlocked = FALSE WHERE residentId = ? AND isCurrent = 1',
          [violation.residentId]
        );
      }
    }

    const [rows] = await pool.query('SELECT * FROM violations WHERE id = ?', [id]);
    res.json({ success: true, data: mapRow('violations', rows[0]), message: 'Violation reviewed.' });
  } catch (error) {
    next(error);
  }
}

async function getStats(req, res, next) {
  try {
    const { residentId } = req.params;
    const [rows] = await pool.query(
      `SELECT
        COUNT(*) as totalViolations,
        COALESCE(SUM(points), 0) as totalPoints,
        COUNT(CASE WHEN severity = 'Critical' THEN 1 END) as criticalCount,
        COUNT(CASE WHEN severity = 'Major' THEN 1 END) as majorCount,
        COUNT(CASE WHEN severity = 'Minor' THEN 1 END) as minorCount
      FROM violations WHERE residentId = ?`,
      [residentId]
    );
    res.json({ success: true, data: rows[0] });
  } catch (error) {
    next(error);
  }
}

/**
 * Get the violation decision matrix (for frontend reference)
 */
async function getMatrix(req, res, next) {
  try {
    res.json({
      success: true,
      data: {
        matrix: VIOLATION_MATRIX,
        severityLevels: [
          { value: 'Minor', points: 1, label: 'Minor (1 point)', color: 'yellow' },
          { value: 'Major', points: 3, label: 'Major (3 points)', color: 'orange' },
          { value: 'Critical', points: 5, label: 'Critical (5 points)', color: 'red' },
        ],
        assessmentTypes: ASSESSMENT_TYPES,
        thresholds: { monitoring: 5, critical: 10 },
      },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAll: baseController.getAll,
  getById: baseController.getById,
  create,
  update: baseController.update,
  delete: baseController.delete,
  review,
  getStats,
  getMatrix,
};
