/**
 * Child/Resident Controller
 * @module controllers/childController
 * @description Resident management with age calculation and document tracking
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { calculateAge, generateId, insertWithGeneratedId, mapRow } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');
const { PHASE_REQUIREMENTS, RESOURCES } = require('../utils/constants');
const { canAccessResident } = require('./assignmentController');
const { assignedResidentIds } = require('../utils/residentScope');
const { loadDocumentScope, documentVisibleTo } = require('./documentController');
const { isManager } = require('../utils/authorization');
const notifications = require('../services/notificationService');
const { buildAccessSnapshot, hasModuleAccess, hasSubModuleAccess, can } = require('../config/rbac');
const { activeAdmissionIdFor } = require('../services/admissionLink');

const baseController = createController('children');

/**
 * May this caller receive a resident's medical summary?
 *
 * `children.medicalRecords` and `children.lastCheckup` predate the Documents
 * module's Medical category and the Health module, but they are still what the
 * Child Records Medical tab and the Reports medical section render. Because
 * they ride along on the resident row instead of behind a route of their own,
 * no route gate can cover them — so the row is redacted per caller here.
 *
 * The rule is the *Medical tab of Child Records*, not the module. Holding Child
 * Records is not enough: the Educator holds the module read-only for Personal
 * Info and Education, and its specification says it must never reach medical
 * records. Every role that legitimately reads the summary — Nurse, Psychological Staff,
 * Social Worker, Center Head — also holds the Medical tab, so keying on the tab
 * narrows the rule to exactly the callers who need narrowing.
 *
 * `children.notes` is deliberately left alone: it is a mixed field that also
 * carries the `[ENDORSEMENTS]` block the Behavioral tab and the nurse dashboard
 * read, so redacting it would remove non-medical data.
 *
 * The rule fails *closed*. A role whose matrix declares no Medical tab can never
 * acquire one through a stored grant, so it is refused even before the snapshot
 * is consulted. That matters because `buildAccessSnapshot` treats an empty
 * `accessibleModules` list as "fall back to the role's full matrix" (see
 * `rbac.js`): a Houseparent row with `[]` stored — which is how the role is
 * seeded, and what every existing row looks like — would otherwise resolve to
 * the whole matrix and be handed the medical summary the role is defined never
 * to see.
 */
function mayReadResidentMedicalSummary(user) {
  if (!user) return false;
  if (!roleCanReachMedicalTab(user.role)) return false;
  const snapshot = user.access && typeof user.access === 'object'
    ? user.access
    : buildAccessSnapshot(user);
  return hasSubModuleAccess(snapshot, 'Child Records', 'Medical');
}

/**
 * Does this role's declared matrix include the Child Records Medical tab?
 *
 * Reads the matrix, never the stored grant, so it is an upper bound the account
 * cannot exceed. An unknown role is refused rather than allowed.
 */
function roleCanReachMedicalTab(role) {
  try {
    const { getRoleDefinition } = require('../config/rbac');
    const definition = getRoleDefinition(role);
    if (!definition) return false;
    if (definition.fullAccess) return true;
    const modules = Array.isArray(definition.modules) ? definition.modules : [];
    if (!modules.includes('Child Records')) return false;
    const tabs = (definition.subModules || {})['Child Records'];
    // No declared tab list means the resolver opens every tab for the module.
    if (tabs === undefined) return true;
    return Array.isArray(tabs) && tabs.includes('Medical');
  } catch {
    return false;
  }
}

/** The resident row as this caller is allowed to see it. */
function residentRowFor(user, row) {
  if (!row || mayReadResidentMedicalSummary(user)) return row;
  return { ...row, medicalRecords: [], lastCheckup: null };
}

/**
 * May this caller receive structured health records?
 *
 * `GET /children/:id` embeds the resident's `healthRecords` rows. The mount
 * that owns those rows (`/health-records`) is gated by the Health module, so
 * this embedding would otherwise be a second, ungated door to the same data.
 *
 * Fails closed on the role matrix for the same reason as
 * `mayReadResidentMedicalSummary`: an empty stored grant list falls back to the
 * whole matrix, which would hand the Health module's rows to a role that does
 * not hold it.
 */
function mayReadHealthRecords(user) {
  if (!user) return false;
  if (!roleCanReachHealth(user.role)) return false;
  const snapshot = user.access && typeof user.access === 'object'
    ? user.access
    : buildAccessSnapshot(user);
  return hasModuleAccess(snapshot, 'Health')
    || hasSubModuleAccess(snapshot, 'Child Records', 'Medical');
}

/** Does this role's declared matrix reach the Health module or the Medical tab? */
function roleCanReachHealth(role) {
  try {
    const { getRoleDefinition } = require('../config/rbac');
    const definition = getRoleDefinition(role);
    if (!definition) return false;
    if (definition.fullAccess) return true;
    const modules = Array.isArray(definition.modules) ? definition.modules : [];
    return modules.includes('Health') || roleCanReachMedicalTab(role);
  } catch {
    return false;
  }
}

/**
 * Modules that legitimately grant a non-manager the ability to edit a resident
 * record. Mirrors the module list the UI uses to expose the edit controls, so
 * access is not narrowed for existing users while unrelated accounts are kept
 * out (previously any authenticated user could update/delete any resident).
 */
const RESIDENT_EDIT_MODULES = ['Child Records', 'Case Progress', 'Phase Progress'];

async function canModifyResident(user, residentId) {
  if (isManager(user)) return true;
  if (String(user?.role || '').toLowerCase() === 'houseparent') return false;

  // Writing a resident record is the Child Records `edit` capability, not mere
  // reachability. The Educator holds the module read-only (Personal Info is a
  // "view" tab in its specification) and would otherwise be able to PUT a
  // resident record straight through the API. Callers that do not hold the
  // module at all fall through to the legacy module-name check below.
  const snapshot = user?.access && typeof user.access === 'object'
    ? user.access
    : buildAccessSnapshot(user);
  if (hasModuleAccess(snapshot, 'Child Records') && !can(snapshot, 'Child Records', 'edit')) {
    return false;
  }

  if (await canAccessResident(user, residentId)) return true;

  const [rows] = await pool.query('SELECT accessibleModules FROM users WHERE id = ?', [user?.id]);
  if (rows.length === 0) return false;
  let modules = rows[0].accessibleModules;
  if (typeof modules === 'string') {
    try { modules = JSON.parse(modules); } catch { modules = []; }
  }
  return Array.isArray(modules) && modules.some(module => RESIDENT_EDIT_MODULES.includes(module));
}

/**
 * Create new child/resident record
 * @async
 */
async function create(req, res, next) {
  let connection;
  try {
    if (!isManager(req.user)) {
      throw new ApiError(403, 'Only Center Head, Admin or Social Worker can create a resident record');
    }
    req.body = req.body || {};
    // Calculate age from birthDate if provided
    if (req.body.birthDate && !req.body.age) {
      req.body.age = calculateAge(req.body.birthDate);
    }

    // Set default values
    if (!req.body.status) req.body.status = 'Active';
    // Every new admission must start in the first canonical phase. The client
    // cannot skip phases by sending a different casePhase value.
    req.body.casePhase = 'Admission Phase';
    if (!req.body.documentsComplete) req.body.documentsComplete = false;

    const data = req.body || {};
    const config = RESOURCES.children;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS childIdSequence (
        id TINYINT PRIMARY KEY,
        nextNumber INT NOT NULL
      ) ENGINE=InnoDB
    `);
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // A new database row always represents a first-time resident. Existing
    // residents must use the re-admission path so their ID and case history
    // are preserved instead of creating a duplicate row.
    const normalizedName = String(data.name || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (normalizedName) {
      const [matchingChildren] = await connection.query(
        `SELECT * FROM children
         WHERE LOWER(TRIM(REGEXP_REPLACE(name, '[[:space:]]+', ' '))) = ?
         ORDER BY createdAt ASC
         LIMIT 1`,
        [normalizedName]
      );
      if (matchingChildren.length > 0) {
        throw new ApiError(409, 'A resident with this name already exists. Select the existing resident to create a repeat case.', {
          existingResident: mapRow('children', matchingChildren[0]),
        });
      }
    }
    data.isRepeatOffender = false;
    data.previousCases = data.previousCases || [];
    data.previousCaseDetails = data.previousCaseDetails || '';

    // Keep child IDs short and readable while preserving a server-side sequence
    // so deleted IDs are never reused.
    const [sequenceRows] = await connection.query('SELECT nextNumber FROM childIdSequence WHERE id = 1 FOR UPDATE');
    let nextNumber = sequenceRows[0]?.nextNumber || 1;
    let childId = `CH${String(nextNumber).padStart(2, '0')}`;
    let [existingChildId] = await connection.query('SELECT id FROM children WHERE id = ?', [childId]);
    while (existingChildId.length > 0) {
      nextNumber += 1;
      childId = `CH${String(nextNumber).padStart(2, '0')}`;
      [existingChildId] = await connection.query('SELECT id FROM children WHERE id = ?', [childId]);
    }
    if (sequenceRows.length === 0) {
      await connection.query('INSERT INTO childIdSequence (id, nextNumber) VALUES (1, ?)', [nextNumber + 1]);
    } else {
      await connection.query('UPDATE childIdSequence SET nextNumber = ? WHERE id = 1', [nextNumber + 1]);
    }
    const columns = ['id'];
    const values = [childId];
    const placeholders = ['?'];

    for (const column of config.columns) {
      if (column === 'id' || column === 'createdAt' || column === 'updatedAt' || data[column] === undefined) continue;
      columns.push(column);
      values.push(config.jsonFields.includes(column) && typeof data[column] === 'object'
        ? JSON.stringify(data[column])
        : data[column]);
      placeholders.push('?');
    }

    if (req.user && !columns.includes('createdBy')) {
      columns.push('createdBy');
      values.push(req.user.fullName || req.user.username || 'System');
      placeholders.push('?');
    }

    await connection.query(
      `INSERT INTO children (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    );

    const phase = 'Admission Phase';
    const phaseRequirements = PHASE_REQUIREMENTS[phase] || PHASE_REQUIREMENTS['Admission Phase'];
    const [existingPhases] = await connection.query('SELECT id FROM phaseProgress FOR UPDATE');
    const phaseId = generateId('PHS', existingPhases.map(row => ({ id: row.id })));

    // A resident created here has no `admissions` row (this is the plain CRUD
    // create, not the admission intake form), so there is usually nothing to
    // link yet. Read it anyway: when the intake form lives on this path the row
    // exists, and a NULL link is what a later re-admission's archival sweep
    // would treat as its own.
    const admissionId = await activeAdmissionIdFor(connection, childId);

    await connection.query(
      `INSERT INTO phaseProgress (id, residentId, admissionId, phaseName, enteredAt, isCurrent, tasksRequired, tasksCompleted, enteredBy, createdBy)
       VALUES (?, ?, ?, ?, CURDATE(), 1, ?, '[]', ?, ?)`,
      [phaseId, childId, admissionId, phase, JSON.stringify(phaseRequirements.requiredTasks || []), req.user?.username || 'System', req.user?.username || 'System']
    );

    const [rows] = await connection.query('SELECT * FROM children WHERE id = ?', [childId]);
    await connection.commit();
    res.status(201).json({
      success: true,
      data: mapRow('children', rows[0]),
      message: 'children created successfully',
    });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Get child by ID with full details
 * @async
 */
async function getById(req, res, next) {
  try {
    const { id } = req.params;
    
    if (!await canAccessResident(req.user, id)) throw new ApiError(403, 'You are not assigned to this resident');

    // Get child data
    const [rows] = await pool.query(
      'SELECT * FROM children WHERE id = ?',
      [id]
    );

    if (rows.length === 0) {
      throw new ApiError(404, 'Child not found');
    }

    const child = rows[0];
    
    // Recalculate age
    if (child.birthDate) {
      child.age = calculateAge(child.birthDate);
    }

    // Get related records
    const [violations] = await pool.query(
      'SELECT * FROM violations WHERE residentId = ? ORDER BY date DESC',
      [id]
    );

    const [healthRecords] = await pool.query(
      'SELECT * FROM healthRecords WHERE residentId = ? ORDER BY date DESC',
      [id]
    );

    const [documents] = await pool.query(
      'SELECT * FROM documents WHERE residentId = ? ORDER BY createdAt DESC',
      [id]
    );

    const [phaseProgress] = await pool.query(
      'SELECT * FROM phaseProgress WHERE residentId = ? ORDER BY enteredAt ASC',
      [id]
    );

    // Same read rule as the Documents module, resident scope included.
    const scope = await loadDocumentScope(req.user);
    const readableDocuments = documents.filter(document => documentVisibleTo(document, req.user, scope));

    res.json({
      success: true,
      data: {
        ...residentRowFor(req.user, child),
        violations,
        healthRecords: mayReadHealthRecords(req.user) ? healthRecords : [],
        documents: readableDocuments,
        phaseProgress,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get all children with document status
 * @async
 */
async function getAll(req, res, next) {
  try {
    const { status, casePhase, documentsComplete } = req.query;
    let query = 'SELECT * FROM children WHERE 1=1';
    const params = [];
    if (String(req.user?.role || '').toLowerCase() === 'houseparent') {
      // Use the same assignment resolver as the store endpoint and individual
      // resident access checks. This keeps Child Records aligned with TRI,
      // Anecdotal Reports, and the Houseparent Case Load, including legacy
      // admissions whose assignment predates residentAssignments.
      const ids = await assignedResidentIds(req.user);
      if (ids.length === 0) {
        return res.json({ success: true, data: [], count: 0 });
      }
      query += ` AND id IN (${ids.map(() => '?').join(', ')})`;
      params.push(...ids);
    }

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    if (casePhase) {
      query += ' AND casePhase = ?';
      params.push(casePhase);
    }

    if (documentsComplete !== undefined) {
      query += ' AND documentsComplete = ?';
      params.push(documentsComplete === 'true');
    }

    query += ' ORDER BY createdAt ASC';

    const [rows] = await pool.query(query, params);

    // Calculate age for each child
    const children = rows.map(child => residentRowFor(req.user, {
      ...child,
      age: child.birthDate ? calculateAge(child.birthDate) : child.age,
    }));

    res.json({
      success: true,
      data: children,
      count: children.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get the previous completed month's resident performance ratings.
 * Missing records are materialized once; existing months are never replaced.
 */
async function getMonthlyPerformanceRatings(req, res, next) {
  try {
    const [periodRows] = await pool.query(
      `SELECT YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AS ratingYear,
              MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AS ratingMonth,
              LAST_DAY(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AS periodEnd`
    );
    const { ratingYear, ratingMonth, periodEnd } = periodRows[0];

    let [residents] = await pool.query(
      'SELECT id, admissionDate FROM children WHERE admissionDate IS NULL OR admissionDate <= ?',
      [periodEnd]
    );
    if (String(req.user?.role || '').toLowerCase() === 'houseparent') {
      [residents] = await pool.query(
        `SELECT c.id, c.admissionDate
         FROM children c
         INNER JOIN residentAssignments ra ON ra.residentId = c.id
         WHERE ra.userId = ? AND ra.status = 'Active'
           AND (c.admissionDate IS NULL OR c.admissionDate <= ?)`,
        [req.user.id, periodEnd]
      );
    }
    const [monthlyScores] = await pool.query(
      `SELECT residentId, YEAR(date) AS ratingYear, MONTH(date) AS ratingMonth,
              COALESCE(SUM(CASE WHEN status <> 'Resolved' THEN points ELSE 0 END), 0) AS points
       FROM violations
       WHERE date < DATE_FORMAT(CURDATE(), '%Y-%m-01')
       GROUP BY residentId, YEAR(date), MONTH(date)`
    );

    const ratingForPoints = (points) => {
      if (points >= 10) return 'Need Improvement';
      if (points >= 6) return 'Fair';
      if (points >= 3) return 'Good';
      return 'Very Good';
    };

    const scoresByPeriod = new Map(monthlyScores.map(score => [
      `${score.residentId}:${score.ratingYear}:${score.ratingMonth}`,
      Number(score.points),
    ]));
    const previousMonthStart = new Date(Number(ratingYear), Number(ratingMonth) - 1, 1);

    for (const resident of residents) {
      const admissionDate = resident.admissionDate ? new Date(resident.admissionDate) : previousMonthStart;
      let monthStart = new Date(admissionDate.getFullYear(), admissionDate.getMonth(), 1);
      while (monthStart <= previousMonthStart) {
        const residentYear = monthStart.getFullYear();
        const residentMonth = monthStart.getMonth() + 1;
        const points = scoresByPeriod.get(`${resident.id}:${residentYear}:${residentMonth}`) || 0;
        await pool.query(
          `INSERT IGNORE INTO residentPerformanceRatings
           (residentId, ratingYear, ratingMonth, rating, points)
           VALUES (?, ?, ?, ?, ?)`,
          [resident.id, residentYear, residentMonth, ratingForPoints(Number(points)), Number(points)]
        );
        monthStart = new Date(residentYear, residentMonth, 1);
      }
    }

    let [ratings] = await pool.query(
      `SELECT residentId, ratingYear, ratingMonth, rating, points
       FROM residentPerformanceRatings
       WHERE ratingYear = ? AND ratingMonth = ?`,
      [ratingYear, ratingMonth]
    );
    if (String(req.user?.role || '').toLowerCase() === 'houseparent') {
      const [assigned] = await pool.query(
        `SELECT DISTINCT residentId
         FROM residentAssignments
         WHERE userId = ? AND status = 'Active'`,
        [req.user.id]
      );
      const allowed = new Set(assigned.map(row => String(row.residentId)));
      ratings = ratings.filter(row => allowed.has(String(row.residentId)));
    }

    res.json({
      success: true,
      data: ratings,
      period: { year: ratingYear, month: ratingMonth },
      count: ratings.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Update child record with age recalculation
 * @async
 */
async function update(req, res, next) {
  try {
    if (!await canModifyResident(req.user, req.params.id)) {
      throw new ApiError(403, 'You are not authorized to update this resident record');
    }

    // Recalculate age if birthDate changed
    if (req.body.birthDate) {
      req.body.age = calculateAge(req.body.birthDate);
    }

    // The Medical Notes on the resident's Medical tab are `children.notes`. The
    // Nurse and the Center Head own that field, and the Houseparent running the
    // resident's daily program is the one who has to act on what it says, so a
    // change has to reach them. The previous value is read before the write
    // because an edit that changes nothing is not news — the form re-saves the
    // same text whenever an unrelated field is touched.
    const medicalNotes = typeof req.body.notes === 'string' ? req.body.notes : null;
    let previousMedicalNotes = null;
    if (medicalNotes !== null) {
      const [before] = await pool.query('SELECT notes FROM children WHERE id = ?', [req.params.id]);
      previousMedicalNotes = before[0]?.notes ?? null;
    }

    await baseController.update(req, res, next);

    // When a child is discharged, close their active admission so a returning
    // resident can be admitted again without the "already has an active
    // admission" block.
    if (req.body.status === 'Discharged') {
      const today = new Date().toISOString().split('T')[0];
      await pool.query(
        `UPDATE admissions
            SET status = 'Closed',
                closedDate = ?,
                modifiedBy = ?
          WHERE residentId = ?
            AND status = 'Active'`,
        [today, req.user?.username || 'System', req.params.id]
      );
    }

    if (medicalNotes !== null && (previousMedicalNotes ?? '') !== medicalNotes) {
      try {
        // Addressed by user id, not by name: the caseload rule is what decides
        // who is told, so a Houseparent assigned to another resident never sees
        // this, and the actor is not on the list because the list holds
        // Houseparents only.
        const houseparents = await notifications.houseparentsOf(req.params.id);
        if (houseparents.length > 0) {
          const name = await notifications.residentName(req.params.id);
          await notifications.notifyUsers(
            houseparents.map((hp) => hp.id),
            {
              type: 'medical-notes-updated',
              title: 'Medical notes updated',
              message: `The medical notes for ${name} were updated by ${req.user?.fullName || req.user?.username || 'staff'}. Please review them.`,
              priority: 'Medium',
              residentId: req.params.id,
              relatedRecordType: 'children',
              relatedRecordId: req.params.id,
              actorUsername: req.user?.username || null,
              dedupeKey: `medical-notes:${req.params.id}:${Date.now()}`,
            }
          );
        }
      } catch (alertError) {
        // A failed alert must not fail the save the caller already has.
        console.error('[ChildController] Medical notes alert failed (non-fatal):', alertError.message);
      }
    }
  } catch (error) {
    next(error);
  }
}

/**
 * Delete a resident record. Destructive and irreversible (cascades to the
 * resident's interventions), so it is restricted to case managers.
 * @async
 */
async function deleteChild(req, res, next) {
  try {
    if (!isManager(req.user)) {
      throw new ApiError(403, 'Only Center Head, Admin or Social Worker can delete a resident record');
    }
    await baseController.delete(req, res, next);
  } catch (error) {
    next(error);
  }
}

/**
 * Get children with incomplete documents
 * @async
 */
async function getIncompleteDocuments(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, 
        (SELECT COUNT(*) FROM documents d WHERE d.residentId = c.id AND d.status = 'Approved') as approvedDocs
      FROM children c 
      WHERE c.documentsComplete = false OR c.documentsComplete IS NULL
      ORDER BY c.createdAt ASC`
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
 * Re-admit a discharged child with a new case
 * This creates a new admission cycle with fresh phase progress
 * @async
 */
async function readmit(req, res, next) {
  try {
    const { id } = req.params;
    const { newAdmissionDate, newCaseType, newLegalCategory } = req.body || {};

    // Check if child exists
    const [childRows] = await pool.query('SELECT * FROM children WHERE id = ?', [id]);
    if (childRows.length === 0) {
      throw new ApiError(404, 'Child not found');
    }

    const child = childRows[0];

    /*
     * This is the legacy re-admission path, kept for API compatibility. The UI
     * admits a returning resident through the admissions controller, which files
     * documents as Resident -> Admission -> Category -> File.
     *
     * Everything below therefore has to leave the database in the same shape the
     * admissions controller would, or the resident's history splits two ways:
     * the folder view splits on `documents.admissionId`, which is only ever set
     * from an `admissions` row, and it numbers folders from
     * `children.previousCases[].admissionNumber`. A re-admission that recorded no
     * admission row and no admission number would leave the new cycle's
     * documents unlinked, so they would fall to the timestamp path and merge
     * into whichever admission happened to sort last.
     */
    const today = new Date().toISOString().split('T')[0];
    const completedBy = req.user?.username || 'System';
    const reAdmissionDate = newAdmissionDate || today;

    // The admission this one supersedes. Closed below, then snapshotted so the
    // previous admission keeps its own documents and phase history.
    const [previousAdmissionRows] = await pool.query(
      `SELECT *
         FROM admissions
        WHERE residentId = ?
        ORDER BY admissionNumber DESC
        LIMIT 1`,
      [id]
    );
    const previousAdmission = previousAdmissionRows[0] || null;

    // Store previous case info for history, in the same shape the admissions
    // controller writes — including the admission id and number the folder view
    // needs to keep this cycle's documents separate from the new one's.
    const previousCaseInfo = {
      admissionId: previousAdmission?.id || null,
      admissionNumber: previousAdmission?.admissionNumber
        || (Array.isArray(child.previousCases) ? 1 : 1),
      offense: previousAdmission?.specificOffense || child.caseType,
      legalCategory: previousAdmission?.legalCategory || child.legalCategory || null,
      date: previousAdmission?.admissionDate || child.admissionDate,
      admissionDate: previousAdmission?.admissionDate || child.admissionDate,
      dischargeDate: previousAdmission?.closedDate
        || (child.status === 'Discharged' ? today : null),
      closedDate: previousAdmission?.closedDate
        || (child.status === 'Discharged' ? today : null),
    };

    // Build updated previousCases array
    let previousCases = [];
    try {
      if (child.previousCases) {
        previousCases = JSON.parse(child.previousCases);
        if (!Array.isArray(previousCases)) previousCases = [];
      }
    } catch { previousCases = []; }

    previousCases.push(previousCaseInfo);

    // 1. Retire the phases of the admission being closed.
    //
    // Scoped to that admission. The phase table now carries `admissionId`; rows
    // written before the column existed are NULL and are still swept by the
    // per-resident fallback, so a legacy upgrade is not stranded. Without the
    // scope this closed every phase the resident had ever had, including ones
    // already retired.
    await pool.query(
      `UPDATE phaseProgress
          SET isCurrent = 0,
              completedAt = COALESCE(completedAt, ?),
              completedBy = COALESCE(completedBy, ?)
        WHERE residentId = ?
          AND (admissionId = ? OR admissionId IS NULL)
          AND isCurrent = 1`,
      [today, completedBy, id, previousAdmission?.id || null]
    );

    // 1b. Close the previous active admission so the admission controller's
    // "latest admission Active" check does not block the new admission.
    await pool.query(
      `UPDATE admissions
          SET status = 'Closed',
              closedDate = ?,
              modifiedBy = ?
        WHERE residentId = ?
          AND status = 'Active'`,
      [today, completedBy, id]
    );

    // 1c. Create the immutable snapshot for the new admission, so this cycle can
    // own documents the same way an admission created through the admissions
    // controller does.
    const admissionNumber = previousAdmission
      ? Number(previousAdmission.admissionNumber || 0) + 1
      : 1;

    const admissionId = await insertWithGeneratedId(pool, {
      table: 'admissions',
      prefix: 'ADM',
      insert: (generatedId) => pool.query(
        `INSERT INTO admissions (
           id, residentId, admissionNumber, admissionDate, name, age, sex, birthDate,
           religion, address, guardianName, guardianContact, guardianAddress,
           referringParty, referringPartyContact, houseparentOnDuty,
           legalCategory, specificOffense, caseHistory, status, createdBy
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)`,
        [
          generatedId,
          id,
          admissionNumber,
          reAdmissionDate,
          child.name,
          child.age ?? 0,
          child.gender === 'Female' ? 'Female' : 'Male',
          child.birthDate ?? reAdmissionDate,
          child.religion || 'Unspecified',
          child.address || 'Unspecified',
          child.guardianName || 'Unspecified',
          child.guardianContact || 'Unspecified',
          child.guardianAddress || 'Unspecified',
          'Re-admission',
          'Unspecified',
          child.houseparentOnDuty || 'Unspecified',
          newLegalCategory || child.legalCategory || 'Unspecified',
          newCaseType || child.caseType || 'Unspecified',
          `Previous: ${child.caseType} (${child.admissionDate})`,
          completedBy,
        ]
      ),
    });

    // 2. Get required tasks for Admission Phase
    const { PHASE_REQUIREMENTS } = require('../utils/constants');
    const admissionReq = PHASE_REQUIREMENTS['Admission Phase'] || {};
    const tasksRequired = JSON.stringify(admissionReq.requiredTasks || []);

    // 3. Create new phaseProgress record for new Admission Phase, anchored to
    // the admission it belongs to. Two concurrent re-admissions can derive the
    // same id; retry instead of 500.
    const phaseId = await insertWithGeneratedId(pool, {
      table: 'phaseProgress',
      prefix: 'PHS',
      insert: (generatedId) => pool.query(
        `INSERT INTO phaseProgress (id, residentId, admissionId, phaseName, enteredAt, isCurrent, tasksRequired, tasksCompleted, enteredBy, createdBy)
         VALUES (?, ?, ?, ?, ?, 1, ?, '[]', ?, ?)`,
        [generatedId, id, admissionId, 'Admission Phase', reAdmissionDate, tasksRequired, completedBy, completedBy]
      ),
    });

    // 5. Update child record for re-admission
    // Format date properly (ensure YYYY-MM-DD format)
    const formatDate = (dateStr) => {
      if (!dateStr) return '';
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return dateStr;
      return date.toISOString().split('T')[0];
    };
    const formattedPrevDate = formatDate(child.admissionDate);
    const prevDetailsText = child.previousCaseDetails
      ? ` | ${child.previousCaseDetails.replace(/Previous:\s*[^|]+\(\s*[^)]+\s*\)\s*\|?\s*/g, '').trim()}`
      : '';

    const updateFields = {
      status: 'Active',
      casePhase: 'Admission Phase',
      isRepeatOffender: true,
      previousCases: previousCases,
      previousCaseDetails: `Previous: ${child.caseType} (${formattedPrevDate})${prevDetailsText}`,
      admissionDate: reAdmissionDate,
      readmissionDate: reAdmissionDate,
      readmissionDatetime: new Date().toISOString(), // Full datetime cutoff for precise doc splitting
      documentsComplete: false,
      phaseTasksCompleted: {}, // Reset all task checkboxes for new admission cycle
    };

    // Only update case type if new one provided
    if (newCaseType) {
      updateFields.caseType = newCaseType;
    }
    if (newLegalCategory) {
      updateFields.legalCategory = newLegalCategory;
    }

    const columns = Object.keys(updateFields);
    const values = columns.map(col => {
      const val = updateFields[col];
      if (col === 'previousCases' && Array.isArray(val)) {
        return JSON.stringify(val);
      }
      if (col === 'phaseTasksCompleted' && typeof val === 'object') {
        return JSON.stringify(val);
      }
      return val;
    });
    values.push(id);

    const setClause = columns.map(col => `${col} = ?`).join(', ');
    await pool.query(`UPDATE children SET ${setClause} WHERE id = ?`, values);

    // Fetch updated child
    const [updatedRows] = await pool.query('SELECT * FROM children WHERE id = ?', [id]);
    const updatedChild = mapRow('children', updatedRows[0]);

    // Get new phase progress
    const [newPhaseProgress] = await pool.query(
      'SELECT * FROM phaseProgress WHERE residentId = ? ORDER BY enteredAt ASC',
      [id]
    );

    res.json({
      success: true,
      message: `Child ${child.name} successfully re-admitted. New admission cycle started.`,
      data: {
        ...updatedChild,
        phaseProgress: newPhaseProgress.map(r => mapRow('phaseProgress', r)),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/children/:id/toggle-psych-assessment
 * Toggle the needsPsychAssessment flag and auto-create alert for Psychological Staff
 * @async
 */
async function togglePsychAssessment(req, res, next) {
  try {
    const { id } = req.params;
    const { needsPsychAssessment } = req.body;

    const [childRows] = await pool.query('SELECT * FROM children WHERE id = ?', [id]);
    if (childRows.length === 0) {
      throw new ApiError(404, 'Child not found');
    }

    const child = childRows[0];
    const turningOn = Boolean(needsPsychAssessment);
    const flagValue = turningOn ? 1 : 0;

    // The "is this a real transition?" test lives in the WHERE clause rather
    // than in a prior SELECT, so two concurrent flaggings cannot both conclude
    // that they were the one that turned the flag on and notify twice.
    // This is also why the alert carries no dedupe key: un-flagging and
    // re-flagging a child is a genuinely new request for an assessment, and a
    // permanent dedupe key would silently swallow it.
    const [updateResult] = await pool.query(
      'UPDATE children SET needsPsychAssessment = ? WHERE id = ? AND COALESCE(needsPsychAssessment, 0) <> ?',
      [flagValue, id, flagValue]
    );
    const flagChanged = Number(updateResult?.affectedRows || 0) > 0;

    if (turningOn && flagChanged) {
      const flaggedBy = req.body.flaggedBy || req.user?.username || 'Case Worker';

      try {
        await notifications.notify({
          type: 'Assessment Required',
          residentId: id,
          title: `Psychological Assessment Required - ${child.name}`,
          message: `Case Worker (${flaggedBy}) has flagged that ${child.name} requires a Psychological Assessment during the Admission Phase. Please conduct and upload the assessment.`,
          priority: 'High',
          actionRequired: 'Upload Psychological Assessment document',
          relatedRecordType: 'children',
          relatedRecordId: id,
          targetRole: 'psychologist',
          actorUsername: flaggedBy,
        });
      } catch (alertErr) {
        // Unchanged behaviour: the flag is already saved, so a notification
        // failure must not turn a successful flagging into an error response.
        console.error('Failed to create psych assessment alert:', alertErr.message);
      }
    }

    res.json({
      success: true,
      message: needsPsychAssessment
        ? `Psychological Assessment flagged as required for ${child.name}. Psychological Staff has been notified.`
        : `Psychological Assessment requirement removed for ${child.name}.`,
      needsPsychAssessment: !!needsPsychAssessment,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  create,
  getById,
  getAll,
  getMonthlyPerformanceRatings,
  update,
  delete: deleteChild,
  getIncompleteDocuments,
  readmit,
  togglePsychAssessment,
  mayReadResidentMedicalSummary,
  residentRowFor,
  mayReadHealthRecords,
};
