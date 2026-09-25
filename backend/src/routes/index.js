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
const { hasModuleAccess } = require('../config/rbac');

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
      // Same rule for every resource whose module the caller does not hold.
      const owningModule = STORE_MODULE_BY_RESOURCE[resourceName];
      if (owningModule && !hasModuleAccess(snapshotFor(req), owningModule)) {
        data[resourceName] = [];
        continue;
      }
      try {
        let rows;
        if (tableName === 'documents') {
          // Exclude fileData from store load — it's base64 and can be huge (MB per file).
          // fileData is fetched individually via GET /documents/:id when viewing/downloading.
          [rows] = await pool.query(
            `SELECT id, residentId, residentName, staffId, assessmentId, title, type, category, documentCategory, description,
                    fileName, fileSize, filePath, fileType, uploaderRole, status, revision, phase, requiredFor,
                    submittedBy, submittedAt, uploadedBy, uploadedAt, reviewedBy, reviewedAt,
                    approvedBy, approvedAt, rejectedBy, rejectedAt, rejectionReason, notes, createdBy, modifiedBy,
                    createdAt, updatedAt
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
          [rows] = await pool.query(`SELECT * FROM \`${tableName}\` ORDER BY ${RESOURCES[tableName]?.orderBy || 'createdAt DESC'}`);
        }

        // Houseparents have a strict resident caseload boundary. The store
        // endpoint must enforce the same boundary as the individual controllers
        // so a direct store request cannot expose another resident's records.
        if (String(req.user?.role || '').toLowerCase() === 'houseparent') {
          const assignedIds = new Set((await assignedResidentIds(req.user)).map(String));
          const residentScopedResources = new Set([
            'children', 'admissions', 'activities', 'assessments', 'healthRecords',
            'activityEvaluations', 'violations', 'phaseProgress', 'courtRecords'
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
};

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
const educationModule = requireModule('Education');

router.use('/education-records', authenticate, educationModule);
router.get('/education-records', educationResources.educationRecords.getAll);
router.get('/education-records/:id', educationResources.educationRecords.getById);
router.post('/education-records', requirePermission('Education', 'create'), educationResources.educationRecords.create);
router.put('/education-records/:id', requirePermission('Education', 'edit'), educationResources.educationRecords.update);
router.delete('/education-records/:id', requirePermission('Education', 'delete'), educationResources.educationRecords.delete);

router.use('/education-progress-reports', authenticate, educationModule);
router.get('/education-progress-reports', educationResources.educationProgressReports.getAll);
router.get('/education-progress-reports/:id', educationResources.educationProgressReports.getById);
router.post('/education-progress-reports', requirePermission('Education', 'create'), educationResources.educationProgressReports.create);
router.put('/education-progress-reports/:id', requirePermission('Education', 'edit'), educationResources.educationProgressReports.update);
router.delete('/education-progress-reports/:id', requirePermission('Education', 'delete'), educationResources.educationProgressReports.delete);

router.use('/education-school-visits', authenticate, educationModule);
router.get('/education-school-visits', educationResources.educationSchoolVisits.getAll);
router.get('/education-school-visits/:id', educationResources.educationSchoolVisits.getById);
router.post('/education-school-visits', requirePermission('Education', 'create'), educationResources.educationSchoolVisits.create);
router.put('/education-school-visits/:id', requirePermission('Education', 'edit'), educationResources.educationSchoolVisits.update);
router.delete('/education-school-visits/:id', requirePermission('Education', 'delete'), educationResources.educationSchoolVisits.delete);

router.use('/education-monthly-reports', authenticate, educationModule);
router.get('/education-monthly-reports', educationResources.educationMonthlyReports.getAll);
router.get('/education-monthly-reports/:id', educationResources.educationMonthlyReports.getById);
router.post('/education-monthly-reports', requirePermission('Education', 'create'), educationResources.educationMonthlyReports.create);
router.put('/education-monthly-reports/:id', requirePermission('Education', 'edit'), educationResources.educationMonthlyReports.update);
router.delete('/education-monthly-reports/:id', requirePermission('Education', 'delete'), educationResources.educationMonthlyReports.delete);

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
