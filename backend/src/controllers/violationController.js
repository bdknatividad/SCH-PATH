/**
 * Violation Controller
 * @module controllers/violationController
 * @description SCH violation logging driven by the configured Violation & Intervention Guide.
 *              TRI is the source of behavioral standing; this controller never calculates
 *              behavioral standing from violations and never uses SCH violation points.
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { mapRow } = require('../utils/helpers');
const { RESOURCES } = require('../utils/constants');
const { ApiError } = require('../middleware/errorHandler');
const { snapshotFor } = require('../middleware/rbac');
const { hasPermission } = require('../config/rbac');
const {
  findGuideByViolationType,
  determineOffenseLevel,
} = require('../utils/violationGuideHelper');
const notifications = require('../services/notificationService');
const { assertResidentActive } = require('../utils/residentStatus');
const { canAccessResident } = require('./assignmentController');
const { pointsForSeverity } = require('../utils/violationPoints');
const { notifyScheduleCreated } = require('../utils/scheduledWork');

const baseController = createController('violations');

/**
 * Whether the caller may read the verification queue.
 *
 * Verification is a capability, not a role: the Social Worker, the Psychological
 * Staff and the Center Head hold `Violations:verify`, and everybody else with the
 * module (currently the Houseparent, which holds `view` and `create`) does not.
 * Reading it off the access snapshot keeps the answer identical to the one the
 * SPA gets from `usePermissions()`, so the tab and the API cannot disagree.
 */
function canVerify(req) {
  return hasPermission(snapshotFor(req), 'Violations', 'verify');
}

/**
 * Get all violations.
 *
 * Facility-wide for every role that holds the module, Houseparents included. The
 * Center Head opened the Violation List and the Intervention Tracker to every
 * active resident on 2026-10-01: a Houseparent on duty has to be able to log an
 * incident against whichever resident is in front of them, not only the ones on
 * their case load. This used to INNER JOIN `residentAssignments` on the caller's
 * own rows, which is the boundary that was lifted. TRI Records and Anecdotal
 * Reports keep theirs.
 *
 * Columns are prefixed with v. throughout (rather than reusing the shared
 * buildWhereClause helper) because that helper emits unprefixed column names.
 *
 * The `Pending Review` rows are the verification queue, and they are withheld
 * from any caller who does not hold `Violations:verify` — which is the rule that
 * keeps the queue away from a Houseparent now that the caseload join is gone.
 * Hiding the "For Verification" tab and its tile in the SPA is not enough on its
 * own: without this filter a Houseparent could read the same queue straight off
 * `GET /api/violations`, because the route is gated on the module, which the role
 * legitimately holds. The filter is applied here, in the query, so the withheld
 * rows never leave the database rather than being trimmed out of the response.
 */
async function getAll(req, res, next) {
  try {
    const mayVerify = canVerify(req);

    const allowedFilters = new Set(RESOURCES.violations.columns);
    const conditions = [];
    const values = [];

    for (const [key, value] of Object.entries(req.query || {})) {
      if (allowedFilters.has(key) && value !== undefined && value !== null && value !== '') {
        conditions.push(`v.${key} = ?`);
        values.push(value);
      }
    }

    if (!mayVerify) {
      conditions.push('v.status <> ?');
      values.push('Pending Review');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT v.* FROM violations v
      ${where}
      ORDER BY v.${RESOURCES.violations.orderBy}`;

    const [rows] = await pool.query(query, values);
    return res.json({
      success: true,
      data: rows.map(row => mapRow('violations', row)),
      count: rows.length,
    });
  } catch (error) {
    next(error);
  }
}

async function getById(req, res, next) {
  try {
    const { id } = req.params;
    const isHouseparent = String(req.user?.role || '').toLowerCase() === 'houseparent';

    if (isHouseparent || !canVerify(req)) {
      const [rows] = await pool.query('SELECT residentId, status FROM violations WHERE id = ?', [id]);
      if (rows.length === 0) throw new ApiError(404, 'Violation not found');
      if (isHouseparent && !await canAccessResident(req.user, rows[0].residentId, { area: 'violations' })) {
        throw new ApiError(403, 'You are not assigned to this resident');
      }
      // Fetching one record by id is the other way round the list filter: the
      // id is guessable from a notification or a shared link, so the same
      // capability check has to stand in front of the single-record read.
      if (!canVerify(req) && rows[0].status === 'Pending Review') {
        throw new ApiError(403, 'This incident is awaiting verification and is not available to your account.');
      }
    }

    return baseController.getById(req, res, next);
  } catch (error) {
    next(error);
  }
}

const VALID_SEVERITIES = ['Minor', 'Major'];
const VALID_STATUS = [
  'Pending Review',
  'Under Investigation',
  'Reviewed',
  'Resolved',
  'Escalated',
  'Rejected',
];

function normalizeOffenseLabel(offenseLevel) {
  if (offenseLevel === '4th+' || offenseLevel === '4th Offense+') {
    return '4th Offense+';
  }
  return `${offenseLevel} Offense`;
}

function isSchedulingInterventionType(value) {
  const type = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return type === 'psychosocial activity' || type === 'dialogue / counseling' || type === 'dialogue/counseling';
}

/**
 * Whether an intervention has to be scheduled before its incident can be
 * verified.
 *
 * The configured answer is `metadata.schedulable`, which the guide's own editor
 * and the official seed both write per intervention. It is deliberately a
 * different question from the type name: `Dialogue/Counseling` is stored
 * **non-schedulable** on "Kawalang respeto sa kapwa residente/staff/bisita" and
 * "Pagsira ng anumang uri ng gamit sa shelter". Judging by the type name alone
 * demanded a schedule for those, while the verification screen offered no way
 * to set one — so the logged incident could never be verified.
 *
 * Falls back to the type name only when the flag is absent, so a row written
 * before the flag existed keeps behaving as it did. Accepts a row or a bare
 * type string.
 */
function interventionNeedsSchedule(row) {
  const source = row && typeof row === 'object' ? row : { interventionType: row };
  let metadata = source.metadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = null;
    }
  }
  if (metadata && typeof metadata.schedulable === 'boolean') return metadata.schedulable;
  return isSchedulingInterventionType(source.interventionType);
}

function interventionOfficialText(row) {
  if (!row) return '';

  let metadata = row.metadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = null;
    }
  }

  return (
    metadata?.officialText ||
    metadata?.rawText ||
    row.interventionType ||
    'Other'
  );
}

function normalizeInterventionRow(row) {
  let metadata = row?.metadata ?? null;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = null;
    }
  }

  return {
    id: row.id,
    guideId: row.guideId,
    offenseLevel: row.offenseLevel,
    interventionType: row.interventionType,
    duration: row.duration ?? null,
    unit: row.unit ?? null,
    metadata,
    officialText: interventionOfficialText(row),
  };
}

async function getGuideWithInterventionsByName(name) {
  const [rows] = await pool.query(
    `SELECT *
     FROM violation_guide
     WHERE status = 'Active'
       AND category IN ('Minor', 'Major')
       AND LOWER(TRIM(name)) = LOWER(TRIM(?))
     ORDER BY updatedAt DESC
     LIMIT 1`,
    [name]
  );

  if (!rows.length) return null;

  const guide = rows[0];
  const [interventions] = await pool.query(
    `SELECT *
     FROM guide_interventions
     WHERE guideId = ?
       AND status = 'Active'
     ORDER BY FIELD(offenseLevel, '1st', '2nd', '3rd'), createdAt ASC`,
    [guide.id]
  );

  return {
    ...guide,
    interventions: interventions.map(normalizeInterventionRow),
  };
}

async function getGuideForViolation(connection, violation) {
  // The violation's guideId is the authoritative relationship. Do not re-match
  // by display text when a relationship exists; names can be edited in the
  // management screen and text matching can become ambiguous.
  if (violation.guideId) {
    const [rows] = await connection.query(
      `SELECT *
       FROM violation_guide
       WHERE id = ?
         AND status = 'Active'
         AND category IN ('Minor', 'Major')
       LIMIT 1`,
      [violation.guideId]
    );
    if (rows.length) {
      const [interventions] = await connection.query(
        `SELECT *
         FROM guide_interventions
         WHERE guideId = ?
       AND status = 'Active'
         ORDER BY FIELD(offenseLevel, '1st', '2nd', '3rd'), createdAt ASC`,
        [rows[0].id]
      );
      return {
        ...rows[0],
        interventions: interventions.map(normalizeInterventionRow),
      };
    }
  }

  // Legacy violations may predate guideId. Resolve once, persist the link, and
  // use that same guide relationship for the rest of the verification flow.
  const [matches] = await connection.query(
    `SELECT *
     FROM violation_guide
     WHERE status = 'Active'
       AND category IN ('Minor', 'Major')
       AND LOWER(TRIM(name)) = LOWER(TRIM(?))
     ORDER BY updatedAt DESC
     LIMIT 1`,
    [violation.type]
  );
  if (!matches.length) return null;

  const guide = matches[0];
  const [interventions] = await connection.query(
    `SELECT *
     FROM guide_interventions
     WHERE guideId = ?
       AND status = 'Active'
     ORDER BY FIELD(offenseLevel, '1st', '2nd', '3rd'), createdAt ASC`,
    [guide.id]
  );
  return {
    ...guide,
    interventions: interventions.map(normalizeInterventionRow),
  };
}

function getInterventionsForLevel(guide, offenseLevel) {
  // The official guide uses "3rd Offense and Beyond". Therefore every 4th+
  // occurrence uses the 3rd-level requirements.
  const guideLevel = offenseLevel === '4th+' ? '3rd' : offenseLevel;
  return (guide?.interventions || []).filter(
    (row) => row.offenseLevel === guideLevel
  );
}

function hasPsychosocialRequirement(interventions) {
  return interventions.some((item) => {
    let metadata = item.metadata;
    if (typeof metadata === 'string') {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = null;
      }
    }
    const text = String(
      metadata?.officialText ||
        metadata?.rawText ||
        item.interventionType ||
        ''
    ).toLowerCase();
    return (
      metadata?.requiresPsychosocial === true ||
      text.includes('psychosocial activity') ||
      text.includes('psychosocial activities')
    );
  });
}

function hasPsychologicalRequirement(interventions) {
  return interventions.some((item) => {
    const text = String(item.officialText || '').toLowerCase();
    return (
      text.includes('psychological') ||
      text.includes('psychologist')
    );
  });
}

function hasCaseConferenceRequirement(interventions) {
  return interventions.some((item) =>
    String(item.officialText || '').toLowerCase().includes('case conference')
  );
}

function buildInterventionPlan(violation, guide, offenseLevel, residentName) {
  const requirements = getInterventionsForLevel(guide, offenseLevel);
  const psychosocialRequired = hasPsychosocialRequirement(requirements);
  const psychologicalRequired = hasPsychologicalRequirement(requirements);
  const caseConferenceRequired = hasCaseConferenceRequirement(requirements);

  return {
    summary: `${violation.severity} violation recorded for ${residentName}: ${violation.type}`,
    offenseLevel,
    requirements: requirements.map((item) => ({
      id: item.id,
      interventionType: item.interventionType,
      duration: item.duration,
      unit: item.unit,
      officialText: item.officialText,
      metadata: item.metadata,
    })),
    psychosocialActivityRequired: psychosocialRequired,
    psychologicalReferralRequired: psychologicalRequired,
    caseConferenceRequired,
    schedulingRequired: requirements.some(interventionNeedsSchedule),
  };
}

/**
 * One intervention alert, written through the notification service.
 *
 * The hand-rolled INSERT that used to live here is why these alerts were
 * visible to every user in the target role regardless of caseload, and why a
 * repeated verification produced a second identical row.
 *
 * `actor` is the person who verified the violation; passing it means the
 * service drops the alert from their own list — the person who assigned the
 * intervention does not need to be told they assigned it.
 */
async function createStaffAlert({
  residentId,
  title,
  message,
  priority = 'Medium',
  actionRequired,
  targetRole,
  relatedRecordId,
  dedupeKey = null,
  actor = null,
}) {
  try {
    return await notifications.notify({
      type: 'Violation Intervention',
      residentId,
      title,
      message,
      priority,
      actionRequired: actionRequired || 'Review intervention requirements',
      relatedRecordType: 'violation',
      relatedRecordId: relatedRecordId || null,
      targetRole: targetRole || null,
      actorUsername: actor,
      dedupeKey,
    });
  } catch (error) {
    // Unchanged behaviour: a notification failure must not fail verification.
    console.error('[ViolationController] Alert creation failed:', error.message);
    return null;
  }
}

/**
 * Turn a verified violation's intervention plan into staff notifications.
 *
 * Recipients follow who can actually discharge the requirement:
 *   - psychosocial activity / psychological checkup → Psychological Staff
 *   - case conference                               → Social Worker
 *
 * The case conference used to be addressed to `psychologist`, which told that
 * role to produce a Case Conference Form that its own role permissions do not
 * allow it to upload. It is now addressed to the role that owns the form.
 */
async function notifyRequiredInterventions(
  violation,
  residentName,
  interventionPlan,
  actor = null
) {
  const createdAlerts = [];
  const officialList = interventionPlan.requirements
    .map((item) => `• ${item.officialText}`)
    .join('\n');
  const link = (suffix) => `violation:${violation.id}:${suffix}`;

  if (interventionPlan.psychosocialActivityRequired) {
    const alert = await createStaffAlert({
      residentId: violation.residentId,
      title: `Psychosocial Activity Required — ${residentName}`,
      message:
        `The selected SCH violation requires a psychosocial activity.\n\n` +
        officialList,
      priority: 'High',
      actionRequired: 'Schedule the required psychosocial activity.',
      targetRole: 'psychologist',
      relatedRecordId: violation.id,
      dedupeKey: link('psychosocial'),
      actor,
    });
    if (alert) createdAlerts.push(alert);
  }

  if (interventionPlan.psychologicalReferralRequired) {
    const alert = await createStaffAlert({
      residentId: violation.residentId,
      title: `Psychological / Medical Referral Required — ${residentName}`,
      message: officialList,
      priority: 'High',
      actionRequired: 'Arrange the required psychological/medical checkup or referral.',
      targetRole: 'psychologist',
      relatedRecordId: violation.id,
      dedupeKey: link('referral'),
      actor,
    });
    if (alert) createdAlerts.push(alert);
  }

  if (interventionPlan.caseConferenceRequired) {
    const alert = await createStaffAlert({
      residentId: violation.residentId,
      title: `Case Conference Required — ${residentName}`,
      message: officialList,
      priority: 'High',
      actionRequired: 'Arrange the required case conference.',
      targetRole: 'socialworker',
      relatedRecordId: violation.id,
      dedupeKey: link('case-conference'),
      actor,
    });
    if (alert) createdAlerts.push(alert);
  }

  return createdAlerts;
}

function buildInsertPayload(body, canonicalSeverity, offenseNumber, guideId) {
  const config = RESOURCES.violations;
  const columns = ['id'];
  const values = [];
  const placeholders = ['?'];

  for (const col of config.columns) {
    if (
      col === 'id' ||
      col === 'createdAt' ||
      col === 'updatedAt'
    ) {
      continue;
    }

    // `points` is derived from the severity, never taken from the request: it is
    // what the dashboard's urgency rating and the monthly performance ratings
    // SUM, so a client must not be able to set it independently of the severity
    // that justifies it.
    if (col === 'points') {
      columns.push(col);
      values.push(pointsForSeverity(canonicalSeverity));
      placeholders.push('?');
      continue;
    }

    if (col === 'severity') {
      columns.push(col);
      values.push(canonicalSeverity);
      placeholders.push('?');
      continue;
    }

    if (col === 'offenseNumber') {
      columns.push(col);
      values.push(offenseNumber);
      placeholders.push('?');
      continue;
    }

    if (body[col] !== undefined) {
      columns.push(col);
      values.push(body[col]);
      placeholders.push('?');
    }
  }

  // Ensure the guide identity is persisted when the resource configuration
  // supports it. This is intentionally skipped when no such DB column exists.
  if (columns.includes('guideId')) {
    values[columns.indexOf('guideId') - 1] = guideId;
  }

  return { columns, values, placeholders };
}

async function create(req, res, next) {
  try {
    const residentId = String(req.body?.residentId || '').trim();
    const violationType = String(req.body?.type || '').trim();
    // An absconded resident's record is view-only.
    await assertResidentActive(residentId, 'given a new incident');

    if (!residentId) {
      throw new ApiError(400, 'Resident is required.');
    }

    if (!violationType) {
      throw new ApiError(400, 'Violation type is required.');
    }

    // A Houseparent logs an incident against any active resident — the Violations
    // module is facility-wide for them (2026-10-01), so the caseload check is
    // made in the open `violations` area and lets them through. It still refuses
    // a resident that is not active, and still bounds every other area.
    if (!await canAccessResident(req.user, residentId, { area: 'violations' })) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }

    const guide = await getGuideWithInterventionsByName(violationType);
    if (!guide) {
      throw new ApiError(
        400,
        'Violation type must exist as an Active entry in Manage Violations & Interventions.'
      );
    }

    if (!VALID_SEVERITIES.includes(guide.category)) {
      throw new ApiError(400, 'Configured violation must be Minor or Major.');
    }

    const residentName = await getResidentName(residentId);
    const offenseLevel = await determineOffenseLevel(
      residentId,
      guide.name,
      null,
      req.body?.date || null
    );
    const offenseNumber = normalizeOffenseLabel(offenseLevel);

    // generateId() reads the current max ID then adds 1 — under concurrent
    // requests (a double-click, two staff logging incidents at once) two
    // requests can read the same max and collide on insert. That's a real,
    // intermittent cause of "sometimes the incident can't be saved." Use a
    // collision-resistant id instead, same fix already applied to
    // intervention_tracker ids.
    const newId = `VIO${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    const body = {
      ...req.body,
      // A new incident starts unverified by either side.
      psychVerifiedBy: undefined, psychVerifiedAt: undefined, psychVerification: undefined,
      swVerifiedBy: undefined, swVerifiedAt: undefined,
      // The account that logged the incident, taken from the session — never
      // from the request — because it decides who may not verify it.
      createdBy: req.user?.username || null,
      residentId,
      type: guide.name,
      severity: guide.category,
      status: VALID_STATUS.includes(req.body?.status)
        ? req.body.status
        : 'Pending Review',
      offenseNumber,
      requiresAssessment: true,
      assessmentTriggered: false,
    };

    const { columns, values, placeholders } = buildInsertPayload(
      { ...body, id: newId, guideId: guide.id },
      guide.category,
      offenseNumber,
      guide.id
    );

    const actualValues = [newId, ...values];

    await pool.query(
      `INSERT INTO violations (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      actualValues
    );

    const [rows] = await pool.query(
      'SELECT * FROM violations WHERE id = ?',
      [newId]
    );
    const violation = mapRow('violations', rows[0]);

    // A logged violation remains pending until an authorized reviewer verifies it.
    // Do not create tracker rows or intervention alerts at logging time.
    const plan = buildInterventionPlan(violation, guide, offenseLevel, residentName);

    // A logged incident is waiting on other people, so tell them.
    //
    // Nothing did this before: `create` sent no notification at all. The only
    // violation alerts fired *after* someone had already verified one side
    // (which then tells the other side), so a new incident could sit in
    // "For Verification" with nobody aware of it — the reporter had to go and
    // tell the Psychologist and the Social Worker by hand.
    //
    // Addressed one row per user against the three roles the facility names, not
    // `targetRole`: a role-addressed row reaches exactly one role, and the Center
    // Head is not a verifier here — they are informed. The service skips the
    // actor, so a Social Worker logging their own incident is not told about it.
    try {
      const reviewers = await notifications.usersWithAnyRole(['centerhead', 'psychologist', 'socialworker']);
      if (reviewers.length) {
        await notifications.notifyUsers(
          reviewers.map((reviewer) => reviewer.id),
          {
            type: 'Violation For Verification',
            residentId: violation.residentId,
            title: `Incident for verification — ${residentName}`,
            message: `${req.user?.username || 'A staff member'} logged a ${guide.category} violation for ${residentName}: ${guide.name}. It needs the Psychological Staff's and the Social Worker's verification before the intervention can be assigned.`,
            priority: 'High',
            actionRequired: 'Review and verify the logged incident.',
            relatedRecordType: 'violation',
            relatedRecordId: newId,
            actorUsername: req.user?.username || null,
            dedupeKey: `violation:${newId}:logged-for-verification`,
          },
        );
      }
    } catch (notifyErr) {
      // The incident is already saved; a failed alert must not undo it.
      console.error('[ViolationController] Incident-logged notification failed (non-fatal):', notifyErr.message);
    }

    res.status(201).json({
      success: true,
      data: {
        ...violation,
        severity: guide.category,
        offenseNumber,
        guideId: guide.id,
        guideName: guide.name,
        interventionPlan: plan,
        assignedInterventions: [],
        autoCreatedAlerts: [],
      },
      message: 'Violation logged for verification. Guide-defined interventions will be assigned only after verification.',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/violations/:id/resubmit — the reporter corrects a rejected report.
 *
 * A verification rejection used to be terminal. The violation sat at `Rejected`,
 * the reporter got a red banner on the Violation List with no action on it, and
 * the only way forward was to log the whole incident again. This is the missing
 * half, and it mirrors what the Incident Report already has:
 * `POST /incident-reports/:id/resubmit` and the Intervention Tracker's
 * "Fill Out Again".
 *
 * The correction is re-resolved the same way `create` resolves a new incident —
 * guide, severity, points and offense number — so a reclassified offense cannot
 * end up half-updated. Nothing downstream needs preserving: the intervention plan
 * is only assigned *after* verification, which by definition never happened for a
 * rejected report.
 *
 * The record returns to `Pending Review`, which is the For Verification queue, and
 * the three reviewing roles are told — the same alert a freshly logged incident
 * sends, so a resubmission cannot land in that queue quietly.
 *
 * @returns the updated violation, so the caller can drop the banner without a reload.
 */
async function resubmit(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT * FROM violations WHERE id = ?', [req.params.id]);
    if (!rows.length) throw new ApiError(404, 'Violation not found');
    const violation = rows[0];

    if (violation.status !== 'Rejected') {
      throw new ApiError(409, 'Only a rejected violation report can be corrected and resubmitted.');
    }

    // The reporter owns the correction; a verifier may act for them (the Center
    // Head usually does, since they are the one who rejected it).
    const username = String(req.user?.username || '').toLowerCase();
    const isReporter = String(violation.reportedBy || '').toLowerCase() === username;
    if (!isReporter && !canVerify(req)) {
      throw new ApiError(403, 'Only the staff member who reported this incident can correct and resubmit it.');
    }

    await assertResidentActive(violation.residentId, 'corrected');

    const violationType = String(req.body?.type || violation.type || '').trim();
    const guide = await getGuideWithInterventionsByName(violationType);
    if (!guide) {
      throw new ApiError(400, 'Violation type must exist as an Active entry in Manage Violations & Interventions.');
    }
    if (!VALID_SEVERITIES.includes(guide.category)) {
      throw new ApiError(400, 'Configured violation must be Minor or Major.');
    }

    const date = String(req.body?.date || violation.date || '').slice(0, 10) || null;
    const offenseNumber = normalizeOffenseLabel(
      await determineOffenseLevel(violation.residentId, guide.name, null, date)
    );

    await pool.query(
      `UPDATE violations
          SET type = ?, guideId = ?, severity = ?, points = ?, offenseNumber = ?,
              date = ?, description = ?, location = ?, witnesses = ?,
              status = 'Pending Review',
              reviewedBy = NULL, actionTaken = NULL, modifiedBy = ?
        WHERE id = ?`,
      [
        guide.name,
        guide.id,
        guide.category,
        pointsForSeverity(guide.category),
        offenseNumber,
        date,
        req.body?.description ?? violation.description ?? null,
        req.body?.location ?? violation.location ?? null,
        req.body?.witnesses ?? violation.witnesses ?? null,
        req.user?.username || null,
        req.params.id,
      ],
    );

    const [updated] = await pool.query('SELECT * FROM violations WHERE id = ?', [req.params.id]);
    const residentName = await getResidentName(violation.residentId);

    // The same alert a freshly logged incident sends. A resubmission that arrived
    // in the For Verification queue silently would be the bug this replaces.
    try {
      const reviewers = await notifications.usersWithAnyRole(['centerhead', 'psychologist', 'socialworker']);
      if (reviewers.length) {
        await notifications.notifyUsers(
          reviewers.map((reviewer) => reviewer.id),
          {
            type: 'Violation For Verification',
            residentId: violation.residentId,
            title: `Incident resubmitted for verification — ${residentName}`,
            message: `${req.user?.username || 'The reporter'} corrected and resubmitted the ${guide.category} violation report for ${residentName}: ${guide.name}. It needs verification again.`,
            priority: 'High',
            actionRequired: 'Review and verify the resubmitted incident.',
            relatedRecordType: 'violation',
            relatedRecordId: req.params.id,
            actorUsername: req.user?.username || null,
            dedupeKey: `violation:${req.params.id}:resubmitted:${Date.now()}`,
          },
        );
      }
    } catch (notifyErr) {
      console.error('[ViolationController] Resubmit notification failed (non-fatal):', notifyErr.message);
    }

    res.json({
      success: true,
      data: mapRow('violations', updated[0]),
      message: 'Violation report corrected and resubmitted for verification.',
    });
  } catch (error) {
    next(error);
  }
}

async function getReviewPreview(req, res, next) {  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const [rows] = await connection.query(
      `SELECT id, residentId, type, severity, status, offenseNumber, guideId, date, description, reportedBy
       FROM violations WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!rows.length) throw new ApiError(404, 'Violation not found.');

    const violation = rows[0];
    const guide = await getGuideForViolation(connection, violation);
    if (!guide || guide.status !== 'Active') {
      throw new ApiError(409, 'This violation is not linked to an active entry in Manage Violations & Interventions.');
    }

    const offenseLevel =
      String(violation.offenseNumber || '').startsWith('1st') ? '1st' :
      String(violation.offenseNumber || '').startsWith('2nd') ? '2nd' : '3rd';

    const requirements = getInterventionsForLevel(guide, offenseLevel);
    if (!requirements.length) {
      throw new ApiError(
        409,
        `No prescribed intervention is configured for "${guide.name}" at ${offenseLevel} offense. Configure it in Manage Violations & Interventions before verification.`
      );
    }

    // Return the actual guide_interventions IDs. The frontend only displays
    // these values; it never constructs or edits an intervention.
    res.json({
      success: true,
      data: {
        violation,
        guide: {
          id: guide.id,
          name: guide.name,
          category: guide.category,
          status: guide.status,
        },
        offenseLevel,
        interventions: requirements,
      },
    });
  } catch (error) {
    next(error);
  } finally {
    connection.release();
  }
}

/**
 * The verification side a role is *bound* to, or `null` for an account that may
 * sign as either.
 *
 * The Psychological Support Staff and the Social Worker each hold exactly one
 * side. Every other account that can reach this endpoint is a full-access one
 * (the Center Head), which holds both roles and therefore has to say which side
 * it is signing.
 */
function boundVerificationSide(user) {
  const role = String(user?.role || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (role === 'psychologist') return 'psych';
  if (role === 'socialworker') return 'sw';
  return null;
}

/**
 * Which verification a reviewer is giving: 'psych' (Psychological Support
 * Staff) or 'sw' (Social Worker). A full-access account (Center Head / Admin)
 * holds both roles, so it must say which side it signs.
 *
 * Note this deliberately does *not* stop that account from signing the other
 * side afterwards — see the dual-verification block in `review`.
 */
function resolveViolationVerificationSide(user, requested) {
  const bound = boundVerificationSide(user);
  if (bound) return bound;
  const side = String(requested || '').toLowerCase();
  if (side === 'psych' || side === 'sw') return side;
  throw new ApiError(400, 'verificationSide must be "psych" or "sw" for this account.');
}

/**
 * The dual-verification columns, added on demand if the database is missing
 * them (the boot migration normally adds them; this covers a database whose
 * migration did not run, so Verify never fails with "Unknown column").
 * Runs once per process.
 */
let verificationColumnsReady = null;
function ensureViolationVerificationColumns() {
  if (!verificationColumnsReady) {
    verificationColumnsReady = (async () => {
      const [rows] = await pool.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = 'violations'`
      );
      const existing = new Set(rows.map((row) => String(row.COLUMN_NAME).toLowerCase()));
      for (const [column, definition] of [
        ['psychVerifiedBy', 'VARCHAR(100) NULL'],
        ['psychVerifiedAt', 'DATETIME NULL'],
        ['psychVerification', 'LONGTEXT NULL'],
        ['psychReviewNotes', 'TEXT NULL'],
        ['swVerifiedBy', 'VARCHAR(100) NULL'],
        ['swVerifiedAt', 'DATETIME NULL'],
        ['swReviewNotes', 'TEXT NULL'],
      ]) {
        if (!existing.has(column.toLowerCase())) {
          await pool.query(`ALTER TABLE violations ADD COLUMN \`${column}\` ${definition}`);
          console.log(`Migration (on demand): violations.${column} added.`);
        }
      }
    })().catch((error) => {
      verificationColumnsReady = null; // try again on the next review
      throw error;
    });
  }
  return verificationColumnsReady;
}

/**
 * The account that logged this incident: `createdBy`, which the server stamps
 * from the session on create. An incident logged before that was stamped falls
 * back to `reportedBy`, which the log form fills with the logger's username.
 */
function loggedByOf(violation) {
  return String(violation?.createdBy || violation?.reportedBy || '').trim().toLowerCase();
}

/**
 * A Social Worker may not approve or reject an incident they logged themselves.
 * It is verified by the Psychological Support Staff and the Center Head (or a
 * different Social Worker) instead. Other roles and other loggers are unaffected.
 */
function isSocialWorkerOwnIncident(user, violation) {
  const role = String(user?.role || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (role !== 'socialworker') return false;
  const me = String(user?.username || '').trim().toLowerCase();
  return Boolean(me) && loggedByOf(violation) === me;
}

async function review(req, res, next) {
  try {
    await ensureViolationVerificationColumns();
  } catch (error) {
    return next(error);
  }
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const { status, reviewedBy } = req.body || {};
    let { actionTaken, scheduleDateTime, psychosocialActivities } = req.body || {};
    if (!['Reviewed', 'Rejected'].includes(status)) throw new ApiError(400, 'Review decision must be Reviewed or Rejected.');
    const [rows] = await connection.query('SELECT * FROM violations WHERE id = ? FOR UPDATE', [id]);
    if (!rows.length) throw new ApiError(404, 'Violation not found');
    const violation = rows[0];
    if (violation.status !== 'Pending Review') throw new ApiError(400, 'This violation has already been reviewed.');

    // Both decisions — Reviewed and Rejected — are refused on the Social
    // Worker's own incident.
    if (isSocialWorkerOwnIncident(req.user, violation)) {
      throw new ApiError(403, 'You logged this incident, so you cannot approve or reject it. It is verified by the Psychological Support Staff and the Center Head.');
    }

    /**
     * What this reviewer typed in the dialog's Review Notes field.
     *
     * Captured here, before anything reassigns `actionTaken`, because the two
     * are not the same fact and used to share one column. `actionTaken` is the
     * log form's "Immediate action taken" and the Intervention Tracker prints it
     * under that heading — so a review note landed on the tracker as an action
     * taken, and whichever reviewer wrote second overwrote the first's notes.
     * Each side now keeps its own, in `psychReviewNotes` / `swReviewNotes`.
     */
    const typedReviewNotes = String(actionTaken || '').trim() || null;

    // ── Dual verification ────────────────────────────────────────────────
    // A logged incident is verified by BOTH the Psychological Support Staff and
    // the Social Worker, and proceeds (interventions assigned) only when both
    // have. The Psychological Staff's verification carries the clinical
    // decision — action taken, schedule, psychosocial activities — exactly as
    // before; the Social Worker's is their own verification of the incident.
    // Whichever comes second completes the review with the Psychological
    // Staff's recorded decision. Either side may reject.
    let verificationSide = null;
    let completesDualVerification = false;
    if (status === 'Reviewed') {
      verificationSide = resolveViolationVerificationSide(req.user, req.body?.verificationSide);
      const otherBy = verificationSide === 'psych' ? violation.swVerifiedBy : violation.psychVerifiedBy;
      const ownBy = verificationSide === 'psych' ? violation.psychVerifiedBy : violation.swVerifiedBy;
      if (ownBy) {
        throw new ApiError(409, `This incident is already verified by the ${verificationSide === 'psych' ? 'Psychological Support Staff' : 'Social Worker'} (${ownBy}).`);
      }
      /**
       * One person cannot supply both verifications — that rule is the whole
       * point of the pair, which exists so two people look at an incident.
       *
       * The exception is an account not bound to a single side by its role. The
       * Center Head holds both, signs as either (see
       * `resolveViolationVerificationSide`), and is offered that choice by the
       * review dialog's "Verify as:" control. Without this exemption the control
       * promised a second verification the API always refused with a 409 — the
       * Center Head could sign one side and never the other, which is the report
       * this fixes.
       */
      const maySignBothSides = boundVerificationSide(req.user) === null;
      if (otherBy && String(otherBy) === String(req.user?.username || '') && !maySignBothSides) {
        throw new ApiError(409, 'The second verification must come from a different person.');
      }
      completesDualVerification = Boolean(otherBy);
      if (verificationSide === 'sw' && completesDualVerification) {
        // The Psychological Staff verified first: complete with their decision.
        let stored = {};
        try { stored = JSON.parse(violation.psychVerification || '{}') || {}; } catch { stored = {}; }
        actionTaken = stored.actionTaken ?? null;
        scheduleDateTime = stored.scheduleDateTime ?? null;
        psychosocialActivities = Array.isArray(stored.psychosocialActivities) ? stored.psychosocialActivities : [];
      }
    }
    const guide = await getGuideForViolation(connection, violation);
    if (!guide || guide.status !== 'Active') {
      throw new ApiError(400, 'The violation is not linked to an active entry in Manage Violations & Interventions.');
    }
    // If this was a legacy violation, persist the recovered relationship before
    // creating any tracker rows. From this point forward guideId is authoritative.
    if (!violation.guideId) {
      await connection.query('UPDATE violations SET guideId = ? WHERE id = ?', [guide.id, id]);
      violation.guideId = guide.id;
    }
    const offenseLevel = String(violation.offenseNumber || '').startsWith('1st') ? '1st' : String(violation.offenseNumber || '').startsWith('2nd') ? '2nd' : '3rd';
    const [requirementRows] = await connection.query(
      `SELECT * FROM guide_interventions
       WHERE guideId = ? AND offenseLevel = ? AND status = 'Active'
       ORDER BY createdAt ASC`,
      [guide.id, offenseLevel]
    );
    const requirements = requirementRows.map(normalizeInterventionRow);
    if (status === 'Reviewed' && !requirements.length) {
      throw new ApiError(
        409,
        `No prescribed intervention is configured for "${guide.name}" at ${offenseLevel} offense. Configure it in Manage Violations & Interventions before verification.`
      );
    }
    const needsSchedule = requirements.some(interventionNeedsSchedule);
    const isPsychosocial = requirements.some((item) => String(item.interventionType || '').trim().toLowerCase().replace(/\s+/g, ' ') === 'psychosocial activity');
    // The clinical inputs are checked when the Psychological Staff submits
    // them. A Social Worker's verification that completes the pair re-uses the
    // recorded decision as it was accepted, so it is not re-checked against the
    // clock (the schedule may be closer by then, not invalid).
    const clinicalInputsFromRequest = verificationSide === 'psych';
    if (status === 'Reviewed' && clinicalInputsFromRequest && needsSchedule && !scheduleDateTime) throw new ApiError(400, 'A schedule date and time is required for this intervention.');
    if (status === 'Reviewed' && clinicalInputsFromRequest && scheduleDateTime && new Date(scheduleDateTime).getTime() <= Date.now()) throw new ApiError(400, 'The intervention schedule must be in the future.');
    await connection.beginTransaction();
    const reviewer = reviewedBy || req.user?.username || null;

    if (status === 'Reviewed') {
      if (verificationSide === 'psych') {
        await connection.query(
          'UPDATE violations SET psychVerifiedBy = ?, psychVerifiedAt = NOW(), psychVerification = ?, psychReviewNotes = ? WHERE id = ?',
          [req.user?.username || reviewer, JSON.stringify({
            actionTaken: actionTaken || null,
            scheduleDateTime: scheduleDateTime || null,
            psychosocialActivities: Array.isArray(psychosocialActivities) ? psychosocialActivities : [],
          }), typedReviewNotes, id]
        );
      } else {
        await connection.query(
          'UPDATE violations SET swVerifiedBy = ?, swVerifiedAt = NOW(), swReviewNotes = ? WHERE id = ?',
          [req.user?.username || reviewer, typedReviewNotes, id]
        );
      }
      if (!completesDualVerification) {
        // First of the two verifications: recorded, and the incident waits.
        await notifications.markRelatedRead(req.user, 'violation', id, connection);
        await connection.commit();
        try {
          const otherRole = verificationSide === 'psych' ? 'socialworker' : 'psychologist';
          const others = await notifications.usersWithAnyRole([otherRole]);
          if (others.length) {
            const residentName = await getResidentName(violation.residentId);
            await notifications.notifyUsers(others.map((u) => u.id), {
              type: 'Violation Verification',
              title: `Incident awaiting your verification${residentName ? ` — ${residentName}` : ''}`,
              message: `${req.user?.username || 'A reviewer'} verified the logged incident. It proceeds once you verify it too.`,
              priority: 'High',
              actionRequired: 'Verify the logged incident.',
              residentId: violation.residentId,
              relatedRecordType: 'violation',
              relatedRecordId: id,
              actorUsername: req.user?.username || null,
            });
          }
        } catch (notifyErr) {
          console.error('[ViolationController] Second-verification notice failed (non-fatal):', notifyErr.message);
        }
        const [pending] = await pool.query('SELECT * FROM violations WHERE id = ?', [id]);
        const waitingFor = verificationSide === 'psych' ? 'the Social Worker' : 'the Psychological Support Staff';
        return res.json({
          success: true,
          data: mapRow('violations', pending[0]),
          pendingSecondVerification: true,
          message: `Verification recorded. The incident proceeds once ${waitingFor} also verifies it.`,
        });
      }
    }
    // `actionTaken` is written only on a rejection, where the typed note *is*
    // the reason and the Violation List reads it back as one. On a verification
    // the notes go to the reviewer's own column above and `actionTaken` is left
    // alone, so the tracker's "Action Taken" keeps meaning what the log form put
    // there rather than repeating a reviewer's note.
    if (status === 'Rejected') {
      await connection.query(
        'UPDATE violations SET status = ?, actionTaken = ?, reviewedBy = ?, severity = ?, points = ?, guideId = ? WHERE id = ?',
        [status, typedReviewNotes, reviewer, guide.category, pointsForSeverity(guide.category), guide.id, id]
      );
    } else {
      await connection.query(
        'UPDATE violations SET status = ?, reviewedBy = ?, severity = ?, points = ?, guideId = ? WHERE id = ?',
        [status, reviewer, guide.category, pointsForSeverity(guide.category), guide.id, id]
      );
    }
    // Assessments raised by this verification are announced **after** the
    // commit, not during it: a rollback would otherwise leave an alert pointing
    // at a row that was never written.
    const scheduledAssessments = [];
    if (status === 'Reviewed') {
      const residentName = await getResidentName(violation.residentId);
      const [existing] = await connection.query('SELECT id FROM intervention_tracker WHERE violationId = ?', [id]);
      if (!existing.length) {
        if (requirements.length === 0) {
          // Never create a placeholder or manually invented intervention.
          // Verification must use a real guide_interventions row from the
          // configured guide.
          throw new ApiError(
            409,
            `No prescribed intervention is configured for "${guide.name}" at ${offenseLevel} offense. Configure it in Manage Violations & Interventions before verification.`
          );
        } else {
          for (const [idx, requirement] of requirements.entries()) {
            const trackerId = `IT${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}${String(idx + 1).padStart(2, '0')}`;

            // Each requirement is judged individually — a violation can mix a
            // scheduled Psychosocial Activity with a plain Household Chores
            // requirement, and only the former should get scheduling/an
            // actual Assessment record.
            const reqIsPsychosocial = String(requirement.interventionType || '').trim().toLowerCase().replace(/\s+/g, ' ') === 'psychosocial activity';
            // Read the configured flag rather than the type name — see
            // `interventionNeedsSchedule`. A Dialogue/Counseling requirement the
            // guide stores as non-schedulable must not collect a schedule it
            // cannot be given.
            const reqNeedsSchedule = interventionNeedsSchedule(requirement);

            // A configured duration never starts an intervention. Start/end dates are
            // written only by explicit staff actions through the tracker UI, so both
            // inserts below write NULL for them.

            // MariaDB enforces JSON validity on JSON columns. The guide
            // metadata is an object in JavaScript, so serialize it explicitly
            // before inserting. Passing the object directly can be converted
            // into an invalid SQL/JSON value and triggers the generated
            // `intervention_tracker_metadata` constraint.
            const trackerMetadata = requirement.metadata == null
              ? null
              : JSON.stringify(requirement.metadata);

            const trackerActivities = reqIsPsychosocial
              ? JSON.stringify(Array.isArray(psychosocialActivities) ? psychosocialActivities : [])
              : null;

            await connection.query(
              `INSERT INTO intervention_tracker
                (id, residentId, violationId, guideId, guideInterventionId, offenseLevel, interventionType, duration, unit, metadata, status, scheduledAt, psychosocialActivities, startDate, endDate)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'In Progress', ?, ?, NULL, NULL)`,
              [trackerId, violation.residentId, id, guide.id, requirement.id, offenseLevel, requirement.interventionType, requirement.duration || null, requirement.unit || null, trackerMetadata,
                reqNeedsSchedule ? scheduleDateTime : null,
                trackerActivities]
            );

            // Keep the requirement-level table in sync with the tracker row.
            // One configured guide intervention is one independently tracked
            // requirement. This is deliberately scoped to THIS violation, so
            // another unresolved intervention for the same resident never blocks
            // or changes this intervention.
            const requirementId = `IR${trackerId}`;
            await connection.query(
              `INSERT INTO intervention_requirements
               (id, interventionId, residentId, title, status, startedAt, dueDate)
               VALUES (?, ?, ?, ?, 'In Progress', NULL, NULL)`,
              [
                requirementId,
                trackerId,
                violation.residentId,
                interventionOfficialText(requirement),
              ]
            );

            // Scheduling a Psychosocial Activity or Dialogue during
            // verification creates a REAL, linked Assessment record — not a
            // separate unrelated one — so it shows up in Scheduled
            // Assessments, and completing it can automatically check off
            // this exact requirement.
            if (reqNeedsSchedule && scheduleDateTime) {
              const [datePart, timePart] = String(scheduleDateTime).split('T');
              const assessmentId = `ASM${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
              const selectedPsych = Array.isArray(psychosocialActivities)
                ? psychosocialActivities.filter(Boolean)
                : [];
              const linkedActivityTypes = reqIsPsychosocial
                ? selectedPsych
                : ['Dialogue/Counseling Form'];
              const assessmentType = linkedActivityTypes.length === 1
                ? linkedActivityTypes[0]
                : linkedActivityTypes.length > 1
                  ? linkedActivityTypes.join(', ')
                  : 'Other';
              await connection.query(
                `INSERT INTO assessments (id, title, date, time, type, psychosocialActivities, assessor, status, forResidents, description, triggeredBy, violationIds, interventionTrackerId, interventionRequirementId, schedulingMode, createdBy)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  assessmentId,
                  `${linkedActivityTypes.length ? linkedActivityTypes.join(', ') : assessmentType} — ${residentName}`,
                  datePart || null, timePart || null,
                  assessmentType,
                  JSON.stringify(linkedActivityTypes),
                  reviewer,
                  JSON.stringify([violation.residentId]),
                  'Scheduled from a verified intervention.',
                  `Violation: ${guide.name} (${offenseLevel} offense)`,
                  JSON.stringify([id]),
                  trackerId,
                  requirementId,
                  'violation-scheduled',
                  reviewer,
                ]
              );

              // A real assessment now exists on the schedule, so the same people
              // a hand-scheduled one reaches are told about it. Before this the
              // row appeared silently: the Center Head, the Social Worker, the
              // Psychological Staff and the resident's Houseparents only found it
              // by opening the Assessments module.
              scheduledAssessments.push({
                id: assessmentId,
                title: `${linkedActivityTypes.length ? linkedActivityTypes.join(', ') : assessmentType} — ${residentName}`,
                date: datePart || null,
                forResidents: JSON.stringify([violation.residentId]),
              });
            }
          }
        }
      }
      await notifyRequiredInterventions(violation, residentName, buildInterventionPlan(violation, guide, offenseLevel, residentName), reviewer);
    }
    // The alert that asked the reviewer to act on this violation is done. Clear
    // it for *this* reviewer only — the old shared-flag UPDATE also cleared it
    // out of every other reviewer's list.
    await notifications.markRelatedRead(req.user, 'violation', id, connection);
    await connection.commit();

    // The verification is durable, so the assessments it raised can be announced.
    for (const assessment of scheduledAssessments) {
      void notifyScheduleCreated({ resource: 'assessments', row: assessment, actor: req.user });
    }

    const [updated] = await pool.query('SELECT * FROM violations WHERE id = ?', [id]);
    res.json({ success: true, data: mapRow('violations', updated[0]), message: status === 'Reviewed' ? 'Violation verified and interventions assigned.' : 'Violation rejected.' });
  } catch (error) { try { await connection.rollback(); } catch {} next(error); }
  finally { connection.release(); }
}

async function getStats(req, res, next) {
  try {
    const { residentId } = req.params;
    const [rows] = await pool.query(
      `SELECT
        COUNT(*) AS totalViolations,
        COUNT(CASE WHEN severity = 'Major' THEN 1 END) AS majorCount,
        COUNT(CASE WHEN severity = 'Minor' THEN 1 END) AS minorCount
       FROM violations
       WHERE residentId = ?`,
      [residentId]
    );

    res.json({
      success: true,
      data: rows[0],
    });
  } catch (error) {
    next(error);
  }
}

async function getMatrix(req, res, next) {
  try {
    const guide = await getAllActiveGuides();

    res.json({
      success: true,
      data: {
        matrix: guide,
        severityLevels: [
          { value: 'Minor', label: 'Minor', color: 'yellow' },
          { value: 'Major', label: 'Major', color: 'orange' },
        ],
      },
    });
  } catch (error) {
    next(error);
  }
}

async function getAllActiveGuides() {
  const [rows] = await pool.query(
    `SELECT *
     FROM violation_guide
     WHERE status = 'Active'
       AND category IN ('Minor', 'Major')
     ORDER BY category DESC, id ASC`
  );

  const result = [];
  for (const guide of rows) {
    const [interventions] = await pool.query(
      `SELECT *
       FROM guide_interventions
       WHERE guideId = ?
       AND status = 'Active'
       ORDER BY FIELD(offenseLevel, '1st', '2nd', '3rd'), createdAt ASC`,
      [guide.id]
    );

    result.push({
      ...guide,
      interventions: interventions.map(normalizeInterventionRow),
    });
  }

  return result;
}

async function markDone(req, res, next) {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const doneBy = req.user?.username || 'Staff';

    await connection.beginTransaction();

    const [rows] = await connection.query(
      'SELECT * FROM violations WHERE id = ? FOR UPDATE',
      [id]
    );
    if (!rows.length) throw new ApiError(404, 'Violation not found');

    // Marking an intervention done lives in the Violations module, which is
    // facility-wide for a Houseparent (2026-10-01) — the intervention they were
    // notified about may belong to a resident who is not on their case load.
    // Other authorized roles keep the existing workflow.
    if (!await canAccessResident(req.user, rows[0].residentId, { area: 'violations' })) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }

    // Mark Done is scoped to the selected violation only. Other active
    // interventions for the same resident are completely independent.
    const [reqRows] = await connection.query(
      `SELECT id, status
       FROM intervention_tracker
       WHERE violationId = ?
       ORDER BY createdAt ASC
       FOR UPDATE`,
      [id]
    );

    // A verified violation must have assigned interventions. Never allow an
    // empty/missing requirement set to bypass the completion gate.
    if (reqRows.length === 0) {
      throw new ApiError(400, 'Cannot mark this intervention Done because no intervention requirements have been assigned.');
    }

    const incomplete = reqRows.filter((r) => r.status !== 'Completed');
    const [detailRows] = await connection.query(
      `SELECT ir.id, ir.status
       FROM intervention_requirements ir
       JOIN intervention_tracker it ON it.id = ir.interventionId
       WHERE it.violationId = ?`,
      [id]
    );
    const detailIncomplete = detailRows.filter((r) => r.status !== 'Done');
    if (incomplete.length > 0 || detailRows.length === 0 || detailIncomplete.length > 0) {
      const completedCount = reqRows.filter((r) => r.status === 'Completed').length;
      throw new ApiError(
        400,
        `Cannot mark this intervention Done — ${completedCount}/${reqRows.length} requirement(s) are complete. Complete all requirements first.`
      );
    }

    // Form 08 must be completed before the intervention can be finalized.
    const [incidentRows] = await connection.query(
      `SELECT ir.id, ir.status, ir.pdfDocumentId, d.status AS documentStatus
       FROM incidentReports ir
       LEFT JOIN documents d ON d.id = ir.pdfDocumentId
       WHERE ir.violationId = ?
       LIMIT 1`,
      [id]
    );
    if (!incidentRows.length) {
      throw new ApiError(400, 'Complete Incident Report (Form 08) before marking this intervention Done.');
    }
    const incident = incidentRows[0];
    const incidentApproved = incident.pdfDocumentId
      ? incident.documentStatus === 'Approved'
      : incident.status === 'Verified';
    if (!incidentApproved) {
      throw new ApiError(400, 'The Incident Report (Form 08) must be approved before marking this intervention Done.');
    }

    await connection.query(
      `UPDATE violations
       SET status = 'Resolved',
           reviewedBy = ?,
           actionTaken = ?
       WHERE id = ?`,
      [doneBy, 'All intervention requirements completed and intervention marked as done.', id]
    );

    // Keep the legacy tracker state and requirement-level state synchronized.
    await connection.query(
      `UPDATE intervention_tracker
       SET status = 'Completed', completionDate = CURDATE(), completedBy = ?
       WHERE violationId = ?`,
      [doneBy, id]
    );
    await connection.query(
      `UPDATE intervention_requirements
       SET status = 'Done', completedAt = COALESCE(completedAt, NOW()),
           completedBy = COALESCE(completedBy, ?)
       WHERE interventionId IN (
         SELECT id FROM intervention_tracker WHERE violationId = ?
       )`,
      [doneBy, id]
    );

    // The intervention alerts that asked for this work are finished — clear
    // them for the person who completed it, inside the same transaction.
    await notifications.markRelatedRead(req.user, 'violation', id, connection);

    await connection.commit();

    const [updated] = await pool.query(
      'SELECT * FROM violations WHERE id = ?',
      [id]
    );

    // Closing a violation is the end of the case for everyone who was asked to
    // act on it. Non-fatal: the intervention is already done.
    try {
      const childName = (await notifications.residentName(rows[0].residentId)) || rows[0].residentId;
      const base = {
        type: 'Violation Intervention',
        residentId: rows[0].residentId,
        title: `Intervention Completed - ${childName}`,
        message: `All intervention requirements for ${childName}'s "${rows[0].type}" violation are complete. ${doneBy} marked the intervention as done.`,
        priority: 'Medium',
        relatedRecordType: 'violation',
        relatedRecordId: id,
        actorUsername: doneBy,
      };

      await notifications.notify({
        ...base,
        targetRole: 'socialworker',
        dedupeKey: `violation:${id}:intervention-done`,
      });

      const houseparents = await notifications.houseparentsOf(rows[0].residentId);
      await notifications.notifyUsers(
        houseparents.map((hp) => hp.id),
        { ...base, dedupeKey: `violation:${id}:intervention-done-houseparent` }
      );
    } catch (notifyErr) {
      console.error('[ViolationController] Completion notification failed (non-fatal):', notifyErr.message);
    }

    res.json({
      success: true,
      data: mapRow('violations', updated[0]),
      message: 'Intervention marked as done.',
    });
  } catch (error) {
    try { await connection.rollback(); } catch {}
    next(error);
  } finally {
    connection.release();
  }
}

async function getResidentName(residentId) {
  const [rows] = await pool.query(
    'SELECT name FROM children WHERE id = ?',
    [residentId]
  );
  return rows[0]?.name || 'Unknown';
}

/**
 * Update a violation, keeping `points` in step with `severity`.
 *
 * The generic controller writes whatever columns the payload names, so a
 * severity change through `PUT /api/violations/:id` would otherwise leave the
 * old points behind — and `points` is exactly what the urgency rating and the
 * monthly performance ratings SUM. Deriving it here means every write path
 * agrees, whichever one the caller used.
 */
async function update(req, res, next) {
  // The two verifications are written only by POST /:id/review — never by a
  // plain edit, or a verification could be recorded without being given.
  if (req.body) {
    for (const field of ['psychVerifiedBy', 'psychVerifiedAt', 'psychVerification', 'swVerifiedBy', 'swVerifiedAt']) delete req.body[field];
    // Who logged the incident is fixed at creation; an edit cannot change it.
    delete req.body.createdBy;
  }
  if (req.body && req.body.severity !== undefined) {
    req.body.points = pointsForSeverity(req.body.severity);
  }
  return baseController.update(req, res, next);
}

module.exports = {
  resolveViolationVerificationSide,
  isSocialWorkerOwnIncident,
  getAll,
  getById,
  create,
  update,
  delete: baseController.delete,
  review,
  resubmit,
  getReviewPreview,
  markDone,
  getStats,
  getMatrix,
};
