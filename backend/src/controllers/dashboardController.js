/**
 * Dashboard Controller
 * @module controllers/dashboardController
 * @description The Dashboard's schedule counts, answered from the database.
 *
 * "Scheduled Today" used to be worked out in the browser from the bulk store
 * snapshot, so it could lag behind the database (a schedule created elsewhere,
 * a cached copy after a refresh or a new login) and the hearings and assigned
 * intervention sessions were counted from different sources than the list the
 * Dashboard showed. This endpoint returns, for one calendar day in the
 * facility's timezone, the actual rows of each kind of schedule the caller may
 * see — the counts are the lengths of those same lists, so they cannot disagree.
 *
 * Role-based access is the same as everywhere else:
 *   - each kind is returned only when the caller holds its module
 *     (Activities, Assessments, Court Records, Violations for interventions);
 *   - a Houseparent only sees rows for residents on their Case Load
 *     (`loadResidentScope`), exactly as the store and the module endpoints do.
 */

const { pool } = require('../config/database');
const { ApiError } = require('../middleware/errorHandler');
const { snapshotFor } = require('../middleware/rbac');
const { hasModuleAccess } = require('../config/rbac');
const { loadResidentScope } = require('../utils/residentScope');
// The facility's today. Shared with every other endpoint that filters on a
// calendar day — a second copy here would drift, and `manila-today-in-queries`
// fails on a controller that uses it without importing it.
const { manilaToday } = require('../utils/triPeriod');

function parseJson(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/** Resident ids a schedule row concerns, for the Houseparent case-load filter. */
function residentIdsOf(row, fields) {
  const ids = [];
  if (row?.residentId) ids.push(String(row.residentId));
  for (const field of fields) {
    for (const item of parseJson(row?.[field])) {
      if (typeof item === 'string') ids.push(item);
      else if (item && typeof item === 'object' && item.id) ids.push(String(item.id));
    }
  }
  return ids;
}

function inScope(row, scope, fields) {
  if (scope === null) return true;
  return residentIdsOf(row, fields).some((id) => scope.includes(id));
}

const ACTIVITY_RESIDENT_FIELDS = ['selectedResidentIds', 'recommendedResidentIds', 'notRecommendedResidentIds', 'participants'];
const ASSESSMENT_RESIDENT_FIELDS = ['forResidents'];

/**
 * GET /api/dashboard/schedule-summary?date=YYYY-MM-DD
 *
 * `date` defaults to today in Asia/Manila. What counts as "scheduled" on the day:
 *   - activities   dated that day, except Cancelled
 *   - assessments  dated that day (Scheduled or already Completed)
 *   - hearings     court hearings on that day, except Cancelled / Postponed
 *   - assigned     intervention sessions scheduled that day (the tracker's
 *                  `scheduledAt`), whether still In Progress or Completed
 */
async function scheduleSummary(req, res, next) {
  try {
    const date = String(req.query.date || manilaToday()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'date must be YYYY-MM-DD');

    const snapshot = snapshotFor(req);
    const can = (module) => hasModuleAccess(snapshot, module);
    const scope = await loadResidentScope(req.user);
    const emptyScope = Array.isArray(scope) && scope.length === 0;

    const result = {
      date,
      access: {
        activities: can('Activities'),
        assessments: can('Assessments'),
        hearings: can('Court Records'),
        assigned: can('Violations'),
      },
      activities: [],
      assessments: [],
      hearings: [],
      assigned: [],
    };

    if (result.access.activities && !emptyScope) {
      const [rows] = await pool.query(
        `SELECT id, title, date, time, type, category, location, status,
                selectedResidentIds, recommendedResidentIds, notRecommendedResidentIds, participants
           FROM activities
          WHERE date = ? AND (status IS NULL OR status <> 'Cancelled')
          ORDER BY time ASC, createdAt ASC`,
        [date]
      );
      result.activities = rows
        .filter((row) => inScope(row, scope, ACTIVITY_RESIDENT_FIELDS))
        .map(({ selectedResidentIds, recommendedResidentIds, notRecommendedResidentIds, participants, ...row }) => row);
    }

    if (result.access.assessments && !emptyScope) {
      const [rows] = await pool.query(
        `SELECT id, title, date, time, type, assessor, status, forResidents
           FROM assessments
          WHERE date = ?
          ORDER BY time ASC, createdAt ASC`,
        [date]
      );
      result.assessments = rows
        .filter((row) => inScope(row, scope, ASSESSMENT_RESIDENT_FIELDS))
        .map(({ forResidents, ...row }) => row);
    }

    if (result.access.hearings && !emptyScope) {
      const [rows] = await pool.query(
        `SELECT cr.id, cr.residentId, cr.hearingDate, cr.hearingTime, cr.hearingType, cr.status,
                c.name AS residentName
           FROM courtRecords cr
           LEFT JOIN children c ON c.id = cr.residentId
          WHERE cr.hearingDate = ? AND cr.status NOT IN ('Cancelled', 'Postponed')
          ORDER BY cr.hearingTime ASC`,
        [date]
      );
      result.hearings = rows.filter((row) => inScope(row, scope, []));
    }

    if (result.access.assigned && !emptyScope) {
      const [rows] = await pool.query(
        `SELECT it.id, it.residentId, it.violationId, it.interventionType, it.status, it.scheduledAt,
                c.name AS residentName
           FROM intervention_tracker it
           INNER JOIN children c ON c.id = it.residentId
          WHERE it.scheduledAt IS NOT NULL
            AND DATE(it.scheduledAt) = ?
            AND it.status IN ('In Progress', 'Completed')
          ORDER BY it.scheduledAt ASC`,
        [date]
      );
      result.assigned = rows.filter((row) => inScope(row, scope, []));
    }

    // The Schedules card: every schedule that is still ahead (today or later)
    // and still pending, per category, counted in the database. Each category
    // uses the same rule as the module it opens:
    //   activities   date >= today, not Cancelled / Completed (Activities)
    //   assessments  date >= today, status Scheduled (Assessments)
    //   hearings     hearingDate >= today, status Scheduled (Court Records'
    //                upcoming hearings)
    //   assigned     intervention sessions scheduled today or later that are
    //                still In Progress (Intervention Tracker)
    // `counts` stays the count for the requested day only.
    const scheduledCounts = { activities: 0, assessments: 0, hearings: 0, assigned: 0 };
    if (result.access.activities && !emptyScope) {
      const [rows] = await pool.query(
        `SELECT id, selectedResidentIds, recommendedResidentIds, notRecommendedResidentIds, participants
           FROM activities
          WHERE date >= ? AND (status IS NULL OR status NOT IN ('Cancelled', 'Completed'))`,
        [date]
      );
      scheduledCounts.activities = rows.filter((row) => inScope(row, scope, ACTIVITY_RESIDENT_FIELDS)).length;
    }
    if (result.access.assessments && !emptyScope) {
      const [rows] = await pool.query(
        `SELECT id, forResidents
           FROM assessments
          WHERE date >= ? AND status = 'Scheduled'`,
        [date]
      );
      scheduledCounts.assessments = rows.filter((row) => inScope(row, scope, ASSESSMENT_RESIDENT_FIELDS)).length;
    }
    if (result.access.hearings && !emptyScope) {
      const [rows] = await pool.query(
        `SELECT id, residentId
           FROM courtRecords
          WHERE hearingDate >= ? AND status = 'Scheduled'`,
        [date]
      );
      scheduledCounts.hearings = rows.filter((row) => inScope(row, scope, [])).length;
    }
    if (result.access.assigned && !emptyScope) {
      const [rows] = await pool.query(
        `SELECT id, residentId
           FROM intervention_tracker
          WHERE scheduledAt IS NOT NULL
            AND DATE(scheduledAt) >= ?
            AND status = 'In Progress'`,
        [date]
      );
      scheduledCounts.assigned = rows.filter((row) => inScope(row, scope, [])).length;
    }

    result.counts = {
      activities: result.activities.length,
      assessments: result.assessments.length,
      hearings: result.hearings.length,
      assigned: result.assigned.length,
    };
    result.counts.total = result.counts.activities + result.counts.assessments + result.counts.hearings + result.counts.assigned;
    result.scheduledCounts = scheduledCounts;
    result.scheduledCounts.total = scheduledCounts.activities + scheduledCounts.assessments + scheduledCounts.hearings + scheduledCounts.assigned;
    result.scheduledToday = {
      activities: result.activities.length,
      assessments: result.assessments.length,
      count: result.activities.length + result.assessments.length,
    };

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

module.exports = { scheduleSummary, manilaToday };
