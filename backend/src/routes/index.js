/**
 * API Routes Index
 * @module routes/index
 * @description Main route aggregator for all API endpoints
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { RESOURCES } = require('../utils/constants');
const { mapRow, generateId } = require('../utils/helpers');
const { authenticate, authorize } = require('../middleware/auth');
const { snapshotFor, requireModule, requirePermission } = require('../middleware/rbac');
const { requireEducationPlacement, requireValidLrn } = require('../middleware/validation');
const { ApiError } = require('../middleware/errorHandler');
const { hasModuleAccess } = require('../config/rbac');
// `sortRows` is shared so `/store` orders wide-row resources the same way
// `baseController.getAll` does instead of asking MySQL to filesort them.
const { sortRows } = require('../controllers/baseController');
const documentController = require('../controllers/documentController');
const educationProgress = require('../controllers/educationProgressController');
const { resolveEducationResident } = require('../utils/educationResident');
const { invokeHandler } = require('../utils/invokeHandler');

const userRoutes = require('./userRoutes');
const childRoutes = require('./childRoutes');
const staffRoutes = require('./staffRoutes');
const activityRoutes = require('./activityRoutes');
const assessmentRoutes = require('./assessmentRoutes');
const reportRoutes = require('./reportRoutes');
const healthRoutes = require('./healthRoutes');
const evaluationRoutes = require('./evaluationRoutes');
const violationRoutes = require('./violationRoutes');
const violationGuideRoutes = require('./violationGuideRoutes');
const incidentReportRoutes = require('./incidentReportRoutes');
const alertRoutes = require('./alertRoutes');
const courtRoutes = require('./courtRoutes');
const phaseRoutes = require('./phaseRoutes');
const documentRoutes = require('./documentRoutes');
const accessRequestRoutes = require('./accessRequestRoutes');
const assignmentRoutes = require('./assignmentRoutes');
const triRoutes = require('./triRoutes');
const anecdotalReportRoutes = require('./anecdotalReportRoutes');
const admissionRoutes = require('./admissionRoutes');
const dischargeRoutes = require('./dischargeRoutes');
const quarterlyProgressReportRoutes = require('./quarterlyProgressReportRoutes');
const rbacRoutes = require('./rbacRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const { loadDocumentScope, documentVisibleTo } = require('../controllers/documentController');
const { residentRowFor } = require('../controllers/childController');
const notifications = require('../services/notificationService');
const { createController } = require('../controllers/baseController');
const { assignedResidentIds } = require('../utils/residentScope');
const { isClosedResidentStatus } = require('../utils/residentStatus');

// Public health check endpoint (must be before mounting routes)
/**
 * GET /api/health/schema — Center Head / Admin only.
 * Lists anything the database is still missing compared with what the code
 * expects (tables, columns, ENUM values), and `?fix=1` applies the additive
 * fixes now instead of waiting for the next restart. Column names only; no data.
 */
router.get('/health/schema', authenticate, authorize('centerhead', 'admin'), async (req, res, next) => {
  try {
    const { pool } = require('../config/database');
    const { diffSchema, syncSchema } = require('../utils/schemaSync');
    if (String(req.query.fix || '') === '1') {
      const result = await syncSchema(pool);
      return res.json({ success: true, fixed: true, ...result });
    }
    const diff = await diffSchema(pool);
    res.json({
      success: true,
      ok: !diff.missingTables.length && !diff.missingColumns.length && !diff.narrowEnums.length,
      missingTables: diff.missingTables,
      missingColumns: diff.missingColumns.map((m) => `${m.table}.${m.column.name}`),
      enumsMissingValues: diff.narrowEnums.map((m) => `${m.table}.${m.column.name}`),
    });
  } catch (error) { next(error); }
});

router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'API is running',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Readiness — is there a working database behind this process?
 *
 * `/health` above is a *liveness* check: it answers "is this process up?" and
 * deliberately touches nothing, so Railway's healthcheck stays cheap and a
 * database blip cannot send the service into a restart loop. The cost of that
 * choice is a real blind spot — a dead MySQL still reported the service as
 * healthy, and the only way to find out otherwise was to log in and read a
 * screen. This closes it with the cheapest possible round-trip.
 *
 * Unauthenticated, because a monitor has no account. That is also why it says
 * nothing beyond reachability: no table names, no row counts, and no driver
 * error text (which can carry the host and user). The detail goes to the log.
 *
 *   200  database connected
 *   503  database unreachable
 *
 * Point a monitor — or Railway's healthcheck, if you would rather the service
 * restart when the database is gone — at this path.
 */
router.get('/health/db', async (req, res) => {
  const startedAt = Date.now();
  try {
    await pool.query('SELECT 1');
    res.json({
      success: true,
      database: 'connected',
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Database readiness check failed:', error.message);
    res.status(503).json({
      success: false,
      database: 'unreachable',
      timestamp: new Date().toISOString(),
    });
  }
});

// Store endpoint - get all data (used by frontend DataContext)
// Requires authentication; returns only the rows the caller's role may read.
const EDUCATION_TABLES = new Set([
  'education_records',
  'education_progress_reports',
  'education_school_visits',
  'education_monthly_reports',
]);
const EDUCATION_ROLES = ['educator', 'centerhead', 'admin'];

/**
 * The RBAC module that owns each bulk-loaded resource.
 *
 * The store is one request that returns every table at once, so it was handing
 * every authenticated account the data behind modules it cannot open — a
 * Psychological Staff could read Court Records and Health straight out of the payload.
 * A resource listed here is emptied when the caller does not hold its module,
 * which is what the sidebar and the routes already enforce.
 *
 * Deliberately NOT listed, because they are read across module boundaries:
 *  - `children` and `phaseProgress` — a Houseparent has no Child Records module
 *    but needs both to run their caseload.
 *  - `documents` — already scoped per row by `documentVisibleTo()`.
 *  - `staff` — reference data for pickers in several modules.
 *  - `alerts` — notifications are already filtered per recipient.
 *  - `education_*` — has its own guard above.
 */
const STORE_MODULE_BY_RESOURCE = {
  assessments: 'Assessments',
  activities: 'Activities',
  activityEvaluations: 'Activities',
  violations: 'Violations',
  // These two are keyed by the *frontend resource name*, not the table name:
  // `resourceMapping` below renames `violation_guide` to `violationGuide` and
  // `intervention_types` to `interventionTypes` before this lookup runs, so the
  // snake_case keys that used to sit here never matched and both resources were
  // served to every role — including roles that hold no Violations module.
  violationGuide: 'Violations',
  interventionTypes: 'Violations',
  courtRecords: 'Court Records',
  healthRecords: 'Health',
  reports: 'Reports',
  users: 'Account Management',
};


function rowResidentIds(resourceName, row) {
  if (row?.residentId) return [String(row.residentId)];

  // A `children` row IS the resident, so it is keyed by `id` and carries no
  // `residentId`. Falling through to the JSON-field scan below therefore
  // returned `[]` for every resident, and the Houseparent caseload filter in
  // /store matched nothing — a Houseparent's store payload came back with
  // `children: []` while `GET /children` returned their real caseload. The
  // store has to apply the same boundary, not a stricter one.
  if (resourceName === 'children') {
    return row?.id ? [String(row.id)] : [];
  }

  const candidates = [];
  const jsonFields = {
    activities: ['selectedResidentIds', 'recommendedResidentIds', 'notRecommendedResidentIds', 'participants'],
    assessments: ['forResidents'],
  }[resourceName] || [];

  for (const field of jsonFields) {
    let value = row?.[field];
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { value = []; }
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === 'string') candidates.push(item);
      else if (item && typeof item === 'object' && item.id) candidates.push(item.id);
    }
  }
  return candidates.map(String).filter(Boolean);
}

/**
 * Resources the caseload-scoped role may read for its own residents without
 * holding the module that owns them.
 *
 * The Houseparent holds no Health module, so the gate below emptied
 * `healthRecords` for them — and the Medical tab of a resident on their case
 * load showed no health records at all, including the one a Nurse had just
 * filed and told them to review. The caseload filter further down narrows these
 * to the Houseparent's own residents, which is the boundary that actually
 * matters here; the module gate withheld only their own residents' rows.
 *
 * Deliberately a short, explicit list, and keyed by the one caseload-scoped
 * role. A role with no caseload concept would be handed every resident's rows
 * by the same exemption, which is why it is not a general "skip the gate when
 * scoped" rule.
 */
const CASELOAD_READABLE_WITHOUT_MODULE = {
  houseparent: new Set(['healthRecords']),
};

router.get('/store', authenticate, async (req, res, next) => {
  try {
    const data = {};
    
    // Map table names to frontend resource names
    const resourceMapping = {
      'users': 'users',
      'children': 'children',
      'staff': 'staff',
      'activities': 'activities',
      'assessments': 'assessments',
      'reports': 'reports',
      'healthRecords': 'healthRecords',
      'activityEvaluations': 'activityEvaluations',
      'violations': 'violations',
      'violation_guide': 'violationGuide',
      'intervention_types': 'interventionTypes',
      'alerts': 'alerts',
      'courtRecords': 'courtRecords',
      'phaseProgress': 'phaseProgress',
      'documents': 'documents',
      'education_records': 'educationRecords',
      'education_progress_reports': 'educationProgressReports',
      'education_school_visits': 'educationSchoolVisits',
      'education_monthly_reports': 'educationMonthlyReports',
    };
    
    for (const [tableName, resourceName] of Object.entries(resourceMapping)) {
      // The Education module has its own role guard on /education-* routes.
      // The bulk store load must apply the same rule, otherwise every
      // authenticated account could read all Education data.
      if (EDUCATION_TABLES.has(tableName) && !EDUCATION_ROLES.includes(String(req.user?.role || '').toLowerCase())) {
        data[resourceName] = [];
        continue;
      }
      // Same rule for every resource whose module the caller does not hold —
      // except the short caseload-readable list above, where the caseload filter
      // below is the boundary instead of the module gate.
      const owningModule = STORE_MODULE_BY_RESOURCE[resourceName];
      const caseloadReadable = CASELOAD_READABLE_WITHOUT_MODULE[
        String(req.user?.role || '').toLowerCase().replace(/[\s_-]+/g, '')
      ]?.has(resourceName);
      if (owningModule && !caseloadReadable && !hasModuleAccess(snapshotFor(req), owningModule)) {
        data[resourceName] = [];
        continue;
      }
      try {
        let rows;
        if (tableName === 'documents') {
          // Exclude fileData from store load — it's base64 and can be huge (MB per file).
          // fileData is fetched individually via GET /documents/:id when viewing/downloading.
          //
          // `admissionId` is listed explicitly because this is the only query in
          // the whole read path that names columns instead of using `SELECT *`,
          // and the Documents module cannot group a returning resident's files
          // without it. It was added to the table, to `constants.js` and to every
          // writer, but not here — so every document reached the browser with no
          // link at all and the folder view fell back to comparing timestamps.
          // That fallback cannot separate two admissions on the same day, so the
          // admission slip a re-intake creates was filed under the admission that
          // had just closed and the current admission read as empty.
          // `backend/tests/admission-period-folders.test.js` now asserts this list
          // covers the declared schema, so the next column cannot be dropped in
          // silence. `reportData` is small JSON (the Progress Report's answers),
          // not a blob, so unlike `fileData` it belongs here — the reviewer's
          // approval dialog renders the filled-in form from it.
          [rows] = await pool.query(
            `SELECT id, residentId, admissionId, residentName, staffId, assessmentId, title, type, category, documentCategory, description,
                    fileName, fileSize, filePath, fileType, uploaderRole, status, revision, phase, requiredFor,
                    submittedBy, submittedAt, uploadedBy, uploadedAt, reviewedBy, reviewedAt,
                    approvedBy, approvedAt, rejectedBy, rejectedAt, rejectionReason, notes, reportData,
                    healthRecordId, triRecordId, quarterlyReportId, anecdotalReportId, educationRecordId,
                    createdBy, modifiedBy, createdAt, updatedAt
             FROM documents ORDER BY createdAt DESC`
          );
          const scope = await loadDocumentScope(req.user);
          rows = rows.filter(document => documentVisibleTo(document, req.user, scope));
        } else if (tableName === 'alerts') {
          // Notifications are per-recipient. This loop previously handed the
          // entire `alerts` table to every authenticated account and left the
          // filtering to the browser, which meant any user could read any
          // other user's notifications straight out of the store payload.
          rows = await notifications.listFor(req.user, { limit: 200 });
        } else {
          // A resource whose rows are too wide to filesort has to be ordered in
          // the application — that is what `sortInApplication` in constants.js
          // means, and `baseController.getAll` honours it. This loop did not, so
          // it kept handing the ORDER BY to MySQL: `education_records` carries a
          // 277 KB `files` blob per row, the filesort exhausted
          // `sort_buffer_size`, and the per-table catch below turned the error
          // into `[]`. The table therefore read as empty here while
          // `GET /api/education-records` returned its rows.
          const config = RESOURCES[tableName] || {};
          const orderBy = config.orderBy || 'createdAt DESC';
          [rows] = await pool.query(
            config.sortInApplication
              ? `SELECT * FROM \`${tableName}\``
              : `SELECT * FROM \`${tableName}\` ORDER BY ${orderBy}`
          );
          if (config.sortInApplication) rows = sortRows(rows, orderBy);
        }

        // Houseparents have a strict resident caseload boundary — in the areas
        // that still have one. Child Records and the Violations module were
        // opened to every active resident on 2026-10-01, so `children`,
        // `admissions`, `healthRecords`, `phaseProgress` and `violations` are no
        // longer filtered here. What is left is the list of resources the Center
        // Head chose to keep caseload-bound: the Dashboard's Activities and
        // Assessments, their evaluations, and the Court records. TRI and
        // Anecdotal Reports never came through this endpoint.
        if (String(req.user?.role || '').toLowerCase() === 'houseparent') {
          const assignedIds = new Set((await assignedResidentIds(req.user)).map(String));
          const residentScopedResources = new Set([
            'activities', 'assessments', 'activityEvaluations', 'courtRecords'
          ]);
          if (residentScopedResources.has(resourceName)) {
            rows = rows.filter(row => rowResidentIds(resourceName, row).some(id => assignedIds.has(String(id))));
          }
          // Education data is already role-gated below; HP has no Education module.
          if (resourceName === 'documents') {
            // documentVisibleTo() above is the authoritative document scope.
          }
        }

        data[resourceName] = rows.map((row) => {
          const mapped = mapRow(tableName, row);
          if (tableName === 'users' && mapped) delete mapped.password;
          // The resident row carries the medical summary the Child Records
          // Medical tab renders. The store is the SPA's main read path, so it
          // has to apply the same per-caller redaction `GET /children` does.
          if (tableName === 'children' && mapped) {
            return residentRowFor(req.user, mapped);
          }
          return mapped;
        });
      } catch (resourceError) {
        // Keep healthy modules available while an older deployment is migrated.
        console.error(`Store load failed for ${tableName}:`, resourceError.message);
        data[resourceName] = [];
      }
    }
    
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// Mount all routes
//
// Every mount whose data belongs to one module carries that module's gate, so a
// role that does not hold the module cannot read its tables by calling the API
// directly. This is the same rule `/store` already applies per resource — the
// two used to disagree, which is how a Nurse could read every court record,
// activity, report and staff row while the sidebar showed none of it.
//
// Deliberately *not* gated, with the reason:
//   · `/children`, `/phases` — read by every role that can reach the app; the
//     controllers apply the caseload rules themselves. The resident's medical
//     summary is redacted per caller inside `childController`.
//   · `/documents`, `/access-requests` — a document's visibility is per row
//     (`documentVisibleTo`), and a Houseparent uploads documents without holding
//     the Documents module.
//   · `/alerts` — notifications are per recipient.
//   · `/violation-guide` — a reference table (violation type → prescribed
//     intervention) that the Child Records page reads to render a resident's
//     record, so gating it by Violations would break that page for the roles
//     the Violations module is withheld from.
//   · `/anecdotal-reports` — authored in Violations but also read by the Reports
//     module's review tab, which the Educator holds without Violations.
//   · `/discharge-plans` — read by both Child Records and Reports.
//   · `/tri`, `/resident-assignments`, `/admissions`, `/education-*` — each
//     applies its own role guard in its own router.
//   · `/dashboard` — the schedule summary gates each kind of schedule by its own
//     module (and a Houseparent's case load) inside the controller.
router.use('/auth', userRoutes);
router.use('/users', userRoutes); // Add /users endpoint for frontend compatibility
router.use('/children', authenticate, childRoutes);
router.use('/staff', authenticate, requireModule('Account Management'), staffRoutes);
router.use('/activities', authenticate, requireModule('Activities'), activityRoutes);
router.use('/assessments', authenticate, assessmentRoutes);
router.use('/reports', authenticate, requireModule('Reports'), reportRoutes);
// Structured health records belong to the Health module. This mount used to be
// ungated on the reasoning that every role could reach the app — which stopped
// being true when the Houseparent specification withheld Health. The SPA reads
// these rows from the store (already module-gated) and only the Health page
// writes them, so the gate closes the direct-API path without changing any
// screen.
router.use('/health-records', authenticate, requireModule('Health'), healthRoutes);
router.use('/healthRecords', authenticate, requireModule('Health'), healthRoutes); // backward compatible
router.use('/evaluations', authenticate, requireModule('Activities'), evaluationRoutes);
router.use('/activityEvaluations', authenticate, requireModule('Activities'), evaluationRoutes); // backward compatible
router.use('/violations', authenticate, violationRoutes);
router.use('/violation-guide', authenticate, violationGuideRoutes);
router.use('/incident-reports', authenticate, incidentReportRoutes);
router.use('/alerts', authenticate, alertRoutes);
router.use('/court', authenticate, requireModule('Court Records'), courtRoutes);
router.use('/courtRecords', authenticate, requireModule('Court Records'), courtRoutes); // backward compatible
router.use('/phases', authenticate, phaseRoutes);
router.use('/phaseProgress', authenticate, phaseRoutes); // backward compatible
router.use('/documents', authenticate, documentRoutes);
router.use('/access-requests', authenticate, accessRequestRoutes);
router.use('/resident-assignments', authenticate, assignmentRoutes);
router.use('/tri', authenticate, triRoutes);
router.use('/anecdotal-reports', authenticate, anecdotalReportRoutes);
router.use('/admissions', authenticate, admissionRoutes);
// Physical Examination (Child Record → Medical). Its PDF is filed in Documents.
router.use('/physical-examinations', authenticate, require('./physicalExaminationRoutes'));
router.use('/discharge-plans', authenticate, dischargeRoutes);
router.use('/quarterly-progress-reports', authenticate, requireModule('Reports'), quarterlyProgressReportRoutes);
// Permission model. `/rbac/me` tells the client what it may see; the UI renders
// that instead of re-deriving the rules, so a role change cannot leave the
// sidebar and the API disagreeing.
router.use('/rbac', authenticate, rbacRoutes);
router.use('/dashboard', authenticate, dashboardRoutes);

// Education module CRUD endpoints. These use the same authenticated CRUD
// contract as the other modules, but are explicitly allow-listed here so the
// Education module is persisted in MySQL instead of browser localStorage.
const educationResources = {
  educationRecords: createController('education_records'),
  educationProgressReports: createController('education_progress_reports'),
  educationSchoolVisits: createController('education_school_visits'),
  educationMonthlyReports: createController('education_monthly_reports'),
  educationSubjects: createController('education_subjects'),
  educationSubjectResults: createController('education_subject_results'),
};

/**
 * Turn a create into an update when the row it would create already exists.
 *
 * `keyColumns` name what makes a row unique for its purpose — a learner per
 * resident, a result per learner per subject. When the body carries all of them
 * and a row already matches, the request is served as an update of that row, so
 * a second "add" can never produce a duplicate. Without every key in the body
 * the create proceeds unchanged.
 *
 * `prepare` may strip fields an update of an existing row must not overwrite.
 */
function updateWhenExists(table, keyColumns, controller, { orderBy = 'createdAt DESC', prepare } = {}) {
  return async (req, res, next) => {
    try {
      const body = req.body || {};
      const keys = keyColumns.map((column) => body[column]);
      if (keys.some((value) => value === undefined || value === null || String(value).trim() === '')) return next();
      const [rows] = await pool.query(
        `SELECT id FROM \`${table}\` WHERE ${keyColumns.map((column) => `${column} = ?`).join(' AND ')} ORDER BY ${orderBy} LIMIT 1`,
        keys,
      );
      if (rows.length === 0) return next();
      req.params.id = rows[0].id;
      if (prepare) prepare(req);
      return controller.update(req, res, next);
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * An Education subject needs a level and a name, and a name may appear once per
 * level. Checked here because a duplicate would otherwise reach the INSERT as
 * ER_DUP_ENTRY, which the id generator reads as an id collision and retries.
 * Comparison is case-insensitive, matching the table's collation.
 */
async function validateEducationSubject(req, res, next) {
  try {
    const body = req.body || {};
    if (body.name !== undefined) body.name = String(body.name).trim();
    if (body.educationLevel !== undefined) body.educationLevel = String(body.educationLevel).trim();

    const isCreate = req.method === 'POST';
    if (isCreate && (!body.name || !body.educationLevel)) {
      throw new ApiError(400, 'A subject needs a name and an education level.');
    }
    if (body.name === '') throw new ApiError(400, 'A subject name cannot be blank.');

    let level = body.educationLevel;
    if (!isCreate && body.name && !level) {
      const [current] = await pool.query('SELECT educationLevel FROM education_subjects WHERE id = ?', [req.params.id]);
      level = current?.[0]?.educationLevel;
    }
    if (body.name && level) {
      const [clash] = await pool.query(
        'SELECT id FROM education_subjects WHERE educationLevel = ? AND LOWER(name) = LOWER(?) AND id <> ?',
        [level, body.name, req.params.id || ''],
      );
      if (clash.length > 0) {
        throw new ApiError(409, `"${body.name}" is already a subject for ${level}.`);
      }
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

const EDUCATION_FILE_CATEGORIES = ['Performance', 'Evaluation', 'Certificate', 'Monthly Report', 'Progress Report', 'Other'];

/**
 * POST /api/education-records/:id/files
 *
 * Upload a file from the Education module. The file is filed ONCE, as a
 * document in the resident's admission folder (Education Files/Records), through
 * the Documents module's own create handler — so admission, approval, history
 * and notifications are those of any other upload. The learner record keeps a
 * reference to that document (`documentId`), not a second copy of the file, and
 * the document carries `educationRecordId` back to the learner.
 */
async function uploadEducationFile(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT id, residentId, name, files FROM education_records WHERE id = ?', [req.params.id]);
    if (!rows.length) throw new ApiError(404, 'Education record not found');
    const record = rows[0];

    // The learner's resident, decided on the server (see resolveEducationResident):
    // the linked resident — or, for a learner added before the link existed, the
    // resident of the same name, which is then linked — preferring the row
    // that is in care now, so a returning resident's file lands under the
    // current admission.
    const owner = await resolveEducationResident(pool, record);
    const residentId = owner?.residentId || null;
    if (!residentId) {
      throw new ApiError(422, `"${record.name}" is not linked to a resident record, so the file cannot be filed in Documents. Edit the student and choose the resident first.`);
    }

    const body = req.body || {};
    const category = String(body.category || '').trim();
    if (!EDUCATION_FILE_CATEGORIES.includes(category)) throw new ApiError(400, 'Choose the document category.');
    const otherLabel = String(body.otherLabel || '').trim();
    if (category === 'Other' && !otherLabel) throw new ApiError(400, 'Please specify what this document is.');
    const fileData = String(body.fileData || '');
    if (!/^data:[^;,]*;base64,/.test(fileData)) throw new ApiError(400, 'Select a file to upload.');
    const fileName = String(body.fileName || '').trim().slice(0, 200) || 'Education file';
    const label = category === 'Other' ? otherLabel : category;

    const [[child]] = await pool.query('SELECT name FROM children WHERE id = ?', [residentId]);
    const [[clock]] = await pool.query("SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS now");
    const now = clock?.now || null;

    const filed = await invokeHandler(documentController.create, {
      ...req,
      body: {
        residentId,
        residentName: child?.name || record.name,
        title: `Education — ${label}`,
        category: 'Education',
        phase: '',
        description: `${label} uploaded via Education Module for ${record.name} (education record ${record.id}).`,
        fileName,
        fileType: String(body.fileType || '').slice(0, 100) || null,
        fileSize: Number(body.fileSize) || Math.round((fileData.length * 3) / 4),
        fileData,
        educationRecordId: record.id,
        uploaderRole: req.user?.role,
        uploadedBy: req.user?.username,
        uploadedAt: now,
        status: 'Submitted',
        submittedBy: req.user?.username,
        submittedAt: now,
        requiresAssessment: false,
        assessmentTriggered: false,
      },
    });
    const documentId = filed?.body?.data?.id;
    if (!documentId) throw new ApiError(500, 'The file could not be filed in Documents.');

    try {
      let files = record.files;
      if (typeof files === 'string') { try { files = JSON.parse(files); } catch { files = []; } }
      if (!Array.isArray(files)) files = [];
      files.push({
        id: `EF${Date.now()}`,
        documentId,
        name: fileName,
        type: String(body.fileType || ''),
        size: Number(body.fileSize) || 0,
        uploadDate: String(now || '').slice(0, 10),
        category,
        ...(category === 'Other' ? { otherLabel } : {}),
      });
      await pool.query('UPDATE education_records SET files = ?, modifiedBy = ? WHERE id = ?', [
        JSON.stringify(files), req.user?.username || null, record.id,
      ]);
    } catch (error) {
      // Never leave a filed document the learner record does not know about.
      await pool.query('DELETE FROM documentRevisions WHERE documentId = ?', [documentId]).catch(() => {});
      await pool.query('DELETE FROM documents WHERE id = ?', [documentId]).catch(() => {});
      throw error;
    }

    const [updated] = await pool.query('SELECT * FROM education_records WHERE id = ?', [record.id]);
    res.status(201).json({
      success: true,
      data: mapRow('education_records', updated[0]),
      documentId,
      message: 'File saved and filed in the resident\'s Documents (Education Files/Records).',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * The Education module's own surface.
 *
 * The guard used to be a role-name allow-list (`['educator','centerhead',
 * 'admin']`), which is the one shape the RBAC work is supposed to remove: it
 * named roles instead of the capability, so it could not follow a matrix change.
 * It is now the Education module itself — which resolves to exactly the same
 * three roles, because those are the only ones whose matrix declares it.
 *
 * The writes carry their own capability so that a role which holds Education
 * read/create/edit but not delete (the Educator's specification: "view, create
 * and edit Education Records") cannot delete a record through the API.
 */
/**
 * Education progress may only be filed for a resident who is still in care.
 *
 * The Educator's specification is explicit that the role stops handling a
 * child's educational progress once the child is out: at discharge the learner is
 * endorsed back to their school, and the record becomes history the module no
 * longer works. The Education page's pickers already hide a discharged resident —
 * this is the same rule where it can actually be enforced, because hiding a
 * control is not a boundary.
 *
 * Keyed on the resident the write names, so it follows the record rather than the
 * screen. A write that names no resident passes: there is nothing to check, and
 * refusing it would break a caller that files a record before linking it.
 *
 * Create only. Correcting a value on an existing record is maintenance of
 * history rather than new progress, and the role keeps its Education:edit for it.
 */
async function requireResidentInCare(req, res, next) {
  try {
    const residentId = req.body?.residentId;
    if (!residentId) return next();
    const [rows] = await pool.query('SELECT status FROM children WHERE id = ?', [residentId]);
    const status = rows?.[0]?.status;
    // `Transferred` is a closed case too — a resident released without
    // completing the programme. They are off the Education roll just the same.
    if (isClosedResidentStatus(status) || status === 'Absconded') {
      throw new ApiError(
        409,
        `This resident is ${String(status).toLowerCase()}, so they are no longer on the Education roll. Their record is kept for history.`,
      );
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Tell the Center Head about an Education write — and, when a learner is added,
 * the Houseparent assigned to that resident.
 *
 * Observed on `res.on('finish')` rather than wrapped around the handler: the four
 * education resources are served by the generic CRUD controller, which writes its
 * own response, so a wrapper would have to re-implement it to know the write
 * succeeded. Waiting for the response also means a refused write notifies nobody —
 * including the 409 `requireResidentInCare` raises, which is why this sits after
 * it in the chain.
 *
 * Fire-and-forget, and it never fails the request: a notification that cannot be
 * written is not a reason to lose the learner.
 */
/**
 * What the caller actually did, where the route alone cannot say.
 *
 * The Education module's "Passed / Failed" buttons file a row into
 * `education-progress-reports` with the subject "General Evaluation". Labelling
 * that "filed a progress report" named the table rather than the action, so the
 * Center Head was told about paperwork when what had happened was an evaluation.
 *
 * Keyed on the subject the module writes, which is the only marker the payload
 * carries. If that string ever changes, this returns `null` and the notification
 * falls back to the route's own label rather than saying something wrong.
 */
function educationActionLabel(req) {
  const body = req.body || {};
  if (String(body.subject || '').trim().toLowerCase() !== 'general evaluation') return null;
  const result = String(body.result || '').trim();
  return result === 'Passed' || result === 'Failed'
    ? `evaluated a learner as ${result}`
    : 'recorded an education evaluation';
}

/**
 * Tell everyone the matrix lets read a resident's Education record about an
 * Education write — plus the Houseparents assigned to that resident.
 *
 * The audience is derived, so the Center Head, the Social Worker and the Educator
 * all hear about it, and the Houseparents are added **by id** from the resident's
 * assignments: one person, not the whole role.
 *
 * Two things this gets right that the first version did not:
 *
 *  - **Every write, not just the create.** The Houseparent was originally notified
 *    only when a learner was added, so an evaluation, a progress report and a
 *    school visit — the three things a Houseparent most needs to see — told them
 *    nothing.
 *  - **The resident is resolved before the handler runs.** An update usually omits
 *    `residentId` from the body and a delete never carries one, so the record is
 *    read here rather than at `finish`, where a deleted row no longer exists. With
 *    no resident there is no caseload to look up, which is why an update used to
 *    notify nobody but the Center Head.
 */
function notifyEducationWrite(resource, fallbackLabel) {
  return async (req, res, next) => {
    const recordId = req.params?.id || null;
    let residentId = req.body?.residentId || null;

    if (!residentId && recordId && req.method !== 'POST') {
      try {
        const [rows] = await pool.query(`SELECT residentId FROM ${resource} WHERE id = ?`, [recordId]);
        residentId = rows?.[0]?.residentId || null;
      } catch (error) {
        // A missing row is not a reason to fail the write; the notification simply
        // goes out without a resident, as it did before.
        console.warn(`[Education] could not resolve the resident for ${resource}/${recordId}:`, error.message);
      }
    }

    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const actor = req.user?.username || null;
      const label = educationActionLabel(req) || fallbackLabel;
      void (async () => {
        try {
          const name = residentId ? await notifications.residentName(residentId) : null;
          await notifications.notifyResidentEvent(
            {
              type: 'Education',
              priority: 'Medium',
              residentId,
              relatedRecordType: 'educationrecords',
              relatedRecordId: recordId,
              actorUsername: actor,
              title: `Education — ${label}${name ? `: ${name}` : ''}`,
              message: `${actor || 'An Educator'} ${label}${name ? ` for ${name}` : ''} in the Education module.`,
            },
            { subModule: 'Education' },
          );
        } catch (error) {
          console.error(`[Education] "${label}" notification failed (non-fatal):`, error.message);
        }
      })();
    });
    next();
  };
}

const educationModule = requireModule('Education');

// Education Progress Monitoring (replaces Pass / Fail): every learner's
// progress for the cards and tiles, one learner's for View → Education
// Progress, and the Educator's save. The summary is declared ahead of the
// learner route so `:educationRecordId` can never claim "summary". Reading
// follows the Education module; saving is the Educator's alone (checked in the
// controller as well as by Education: edit here).
router.get('/education-progress/summary', authenticate, educationModule, educationProgress.summary);
router.get('/education-progress/:educationRecordId', authenticate, educationModule, educationProgress.getOne);
router.put('/education-progress/:educationRecordId', authenticate, educationModule, requirePermission('Education', 'edit'), educationProgress.save);
// Complete: archive a learner whose every subject is Completed with all its
// outputs submitted. The Educator's alone, checked again on the server.
router.post('/education-progress/:educationRecordId/complete', authenticate, educationModule, requirePermission('Education', 'edit'), educationProgress.complete);

router.use('/education-records', authenticate, educationModule);
router.get('/education-records', educationResources.educationRecords.getAll);
router.get('/education-records/:id', educationResources.educationRecords.getById);
// A resident already on the Student Master List can still be picked when adding
// a student; the add then updates their existing learner record rather than
// creating a second one for the same resident. Uploaded files and the original
// author are never overwritten by that update.
/**
 * A learner reaches the Archive only through Complete (POST
 * /education-progress/:id/complete), which checks that their Education Progress
 * is complete. Every other write has the archive fields removed, so neither the
 * Add / Edit Student form nor a direct API call can archive — or un-archive —
 * a learner.
 */
function stripArchiveFields(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    delete req.body.archivedAt;
    delete req.body.archivedBy;
  }
  next();
}

router.post(
  '/education-records',
  requirePermission('Education', 'create'),
  stripArchiveFields,
  requireResidentInCare,
  requireEducationPlacement,
  requireValidLrn,
  notifyEducationWrite('education_records', 'added a learner'),
  updateWhenExists('education_records', ['residentId'], educationResources.educationRecords, {
    orderBy: "(status = 'Active') DESC, createdAt DESC",
    prepare: (req) => { delete req.body.files; delete req.body.createdBy; },
  }),
  educationResources.educationRecords.create,
);
router.post('/education-records/:id/files', requirePermission('Education', 'edit'), uploadEducationFile);
router.put('/education-records/:id', requirePermission('Education', 'edit'), stripArchiveFields, requireEducationPlacement, requireValidLrn, notifyEducationWrite('education_records', 'updated a learner'), educationResources.educationRecords.update);
router.delete('/education-records/:id', requirePermission('Education', 'delete'), notifyEducationWrite('education_records', 'removed a learner'), educationResources.educationRecords.delete);

router.use('/education-progress-reports', authenticate, educationModule);
router.get('/education-progress-reports', educationResources.educationProgressReports.getAll);
router.get('/education-progress-reports/:id', educationResources.educationProgressReports.getById);
router.post('/education-progress-reports', requirePermission('Education', 'create'), requireResidentInCare, notifyEducationWrite('education_progress_reports', 'filed a progress report'), educationResources.educationProgressReports.create);
router.put('/education-progress-reports/:id', requirePermission('Education', 'edit'), notifyEducationWrite('education_progress_reports', 'updated a progress report'), educationResources.educationProgressReports.update);
router.delete('/education-progress-reports/:id', requirePermission('Education', 'delete'), notifyEducationWrite('education_progress_reports', 'removed a progress report'), educationResources.educationProgressReports.delete);

router.use('/education-school-visits', authenticate, educationModule);
router.get('/education-school-visits', educationResources.educationSchoolVisits.getAll);
router.get('/education-school-visits/:id', educationResources.educationSchoolVisits.getById);
router.post('/education-school-visits', requirePermission('Education', 'create'), requireResidentInCare, notifyEducationWrite('education_school_visits', 'scheduled a school visit'), educationResources.educationSchoolVisits.create);
router.put('/education-school-visits/:id', requirePermission('Education', 'edit'), notifyEducationWrite('education_school_visits', 'updated a school visit'), educationResources.educationSchoolVisits.update);
router.delete('/education-school-visits/:id', requirePermission('Education', 'delete'), notifyEducationWrite('education_school_visits', 'removed a school visit'), educationResources.educationSchoolVisits.delete);

// Subjects: defined by the Educator per education level, shared by every
// learner at that level. Deleting one removes its results with it (FK cascade).
router.use('/education-subjects', authenticate, educationModule);
router.get('/education-subjects', educationResources.educationSubjects.getAll);
router.get('/education-subjects/:id', educationResources.educationSubjects.getById);
router.post('/education-subjects', requirePermission('Education', 'create'), validateEducationSubject, educationResources.educationSubjects.create);
router.put('/education-subjects/:id', requirePermission('Education', 'edit'), validateEducationSubject, educationResources.educationSubjects.update);
router.delete('/education-subjects/:id', requirePermission('Education', 'delete'), educationResources.educationSubjects.delete);

// Subject rows: one per learner per subject, now holding the progress status.
// They are read here and written only through PUT /education-progress/:id —
// the Pass / Fail writes (POST / PUT / DELETE) were removed with Pass / Fail.
router.use('/education-subject-results', authenticate, educationModule);
router.get('/education-subject-results', educationResources.educationSubjectResults.getAll);
router.get('/education-subject-results/:id', educationResources.educationSubjectResults.getById);

router.use('/education-monthly-reports', authenticate, educationModule);
router.get('/education-monthly-reports', educationResources.educationMonthlyReports.getAll);
router.get('/education-monthly-reports/:id', educationResources.educationMonthlyReports.getById);
router.post('/education-monthly-reports', requirePermission('Education', 'create'), requireResidentInCare, notifyEducationWrite('education_monthly_reports', 'filed a monthly report'), educationResources.educationMonthlyReports.create);
router.put('/education-monthly-reports/:id', requirePermission('Education', 'edit'), notifyEducationWrite('education_monthly_reports', 'updated a monthly report'), educationResources.educationMonthlyReports.update);
router.delete('/education-monthly-reports/:id', requirePermission('Education', 'delete'), notifyEducationWrite('education_monthly_reports', 'removed a monthly report'), educationResources.educationMonthlyReports.delete);

// Legacy generic resource endpoints.
//
// There used to be a `router.get('/:resource', ...)` here that returned every
// row of a table with no role, ownership or resident-assignment filtering. It
// was removed after tests/routes.integration.test.js proved it could never run:
// every resource in its allow-list is mounted above at a more specific path,
// and Express matches the earlier mount first. Leaving it in place was a latent
// hazard — deleting one `router.use(...)` line above would have silently turned
// it into an unfiltered data endpoint for any authenticated account.
//
// The write verbs below are kept deliberately. They forward straight to the 404
// handler so that a legacy write cannot accidentally reach a mounted router.
router.post('/:resource', authenticate, (req, res, next) => next());
router.put('/:resource/:id', authenticate, (req, res, next) => next());
router.delete('/:resource/:id', authenticate, (req, res, next) => next());

module.exports = router;
