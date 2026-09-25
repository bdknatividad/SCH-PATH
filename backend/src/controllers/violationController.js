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
const { assertResidentNotAbsconded } = require('../utils/abscond');
const { canAccessResident } = require('./assignmentController');
const { pointsForSeverity } = require('../utils/violationPoints');

const baseController = createController('violations');

/**
 * Whether the caller may read the verification queue.
 *
 * Verification is a capability, not a role: the Social Worker, the Psychological
 * Staff and the Center Head hold `Violations:verify`, and everybody else with the
 * module (currently the Houseparent) holds `view` alone. Reading it off the
 * access snapshot keeps the answer identical to the one the SPA gets from
 * `usePermissions()`, so the tab and the API cannot disagree.
 */
function canVerify(req) {
  return hasPermission(snapshotFor(req), 'Violations', 'verify');
}

/**
 * Get all violations, scoped for Houseparents to only their assigned
 * residents. The generic base controller has no concept of req.user, so
 * violations were previously visible across a Houseparent's whole facility
 * rather than just their own caseload — this mirrors the same scoping
 * childController.getAll already applies for the Child Records list.
 *
 * Columns are prefixed with v. throughout (rather than reusing the shared
 * buildWhereClause helper) because that helper emits unprefixed column
 * names, which would be ambiguous here: residentAssignments also has its
 * own status column, and an unprefixed "status = ?" against this two-table
 * join would fail or silently filter on the wrong table's column.
 *
 * The `Pending Review` rows are the verification queue, and they are withheld
 * from any caller who does not hold `Violations:verify`. Hiding the "For
 * Verification" tab and its tile in the SPA is not enough on its own: without
 * this, a Houseparent could read the same queue straight off `GET /api/violations`
 * — the route is gated on the module, which the role legitimately holds. The
 * filter is applied here, in the query, so the withheld rows never leave the
 * database rather than being trimmed out of the response afterwards.
 */
async function getAll(req, res, next) {
  try {
    const isHouseparent = String(req.user?.role || '').toLowerCase() === 'houseparent';
    const mayVerify = canVerify(req);

    const allowedFilters = new Set(RESOURCES.violations.columns);
    const conditions = [];
    const values = isHouseparent ? [req.user.id] : [];

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

    // The Houseparent is scoped to its caseload; every other role reads the
    // whole table, exactly as the base controller did.
    const scope = isHouseparent
      ? "INNER JOIN residentAssignments ra ON ra.residentId = v.residentId WHERE ra.userId = ? AND ra.status = 'Active'"
      : '';
    const where = conditions.length
      ? `${isHouseparent ? 'AND' : 'WHERE'} ${conditions.join(' AND ')}`
      : '';

    const query = `
      SELECT v.* FROM violations v
      ${scope}
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
      if (isHouseparent && !await canAccessResident(req.user, rows[0].residentId)) {
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
    schedulingRequired: requirements.some((item) => isSchedulingInterventionType(item.interventionType)),
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
    await assertResidentNotAbsconded(residentId, 'given a new incident');

    if (!residentId) {
      throw new ApiError(400, 'Resident is required.');
    }

    if (!violationType) {
      throw new ApiError(400, 'Violation type is required.');
    }

    if (!await canAccessResident(req.user, residentId)) {
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

async function getReviewPreview(req, res, next) {
  const connection = await pool.getConnection();
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
 * Which verification a reviewer is giving: 'psych' (Psychological Support
 * Staff) or 'sw' (Social Worker). A full-access account (Center Head / Admin)
 * holds both roles, so it must say which side it signs — otherwise one account
 * could complete the pair alone.
 */
function resolveViolationVerificationSide(user, requested) {
  const role = String(user?.role || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (role === 'psychologist') return 'psych';
  if (role === 'socialworker') return 'sw';
  const side = String(requested || '').toLowerCase();
  if (side === 'psych' || side === 'sw') return side;
  throw new ApiError(400, 'verificationSide must be "psych" or "sw" for this account.');
}

async function review(req, res, next) {
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
      // One person cannot supply both verifications.
      if (otherBy && String(otherBy) === String(req.user?.username || '')) {
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
    const needsSchedule = requirements.some((item) => isSchedulingInterventionType(item.interventionType));
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
          'UPDATE violations SET psychVerifiedBy = ?, psychVerifiedAt = NOW(), psychVerification = ? WHERE id = ?',
          [req.user?.username || reviewer, JSON.stringify({
            actionTaken: actionTaken || null,
            scheduleDateTime: scheduleDateTime || null,
            psychosocialActivities: Array.isArray(psychosocialActivities) ? psychosocialActivities : [],
          }), id]
        );
      } else {
        await connection.query(
          'UPDATE violations SET swVerifiedBy = ?, swVerifiedAt = NOW() WHERE id = ?',
          [req.user?.username || reviewer, id]
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
    await connection.query('UPDATE violations SET status = ?, actionTaken = ?, reviewedBy = ?, severity = ?, points = ?, guideId = ? WHERE id = ?', [status, actionTaken || null, reviewer, guide.category, pointsForSeverity(guide.category), guide.id, id]);
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
            const reqIsDialogue = isSchedulingInterventionType(requirement.interventionType) && !reqIsPsychosocial;
            const reqNeedsSchedule = reqIsPsychosocial || reqIsDialogue;

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

    // Houseparents may complete only interventions belonging to their own
    // assigned residents. Other authorized roles keep the existing workflow.
    if (!await canAccessResident(req.user, rows[0].residentId)) {
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
  }
  if (req.body && req.body.severity !== undefined) {
    req.body.points = pointsForSeverity(req.body.severity);
  }
  return baseController.update(req, res, next);
}

module.exports = {
  resolveViolationVerificationSide,
  getAll,
  getById,
  create,
  update,
  delete: baseController.delete,
  review,
  getReviewPreview,
  markDone,
  getStats,
  getMatrix,
};
