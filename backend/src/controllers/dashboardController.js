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
// The facility's "today" comes from the one shared helper. A local copy of the
// `Intl.DateTimeFormat` call was here and was removed: two copies of the
// timezone rule is how the reporting calendar drifts, and this file already
// exports `manilaToday` so the duplicate was invisible from the outside.
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

// ── CENTER HEAD COMMAND CENTRE ──────────────────────────────────────────────

/**
 * Whole days between two `YYYY-MM-DD` strings, signed. `b - a`.
 *
 * Both sides are calendar days in the facility's timezone, so the arithmetic is
 * done on the date parts rather than on instants: `new Date('2026-09-27')` is
 * parsed as UTC midnight, and subtracting two of those is safe, but mixing one
 * with a `Date.now()` would put the boundary in the wrong place for eight hours
 * every night. Parsing both as UTC midnight and dividing keeps it exact.
 */
function daysBetween(a, b) {
  const parse = (value) => {
    const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  };
  const from = parse(a);
  const to = parse(b);
  if (from === null || to === null) return null;
  return Math.round((to - from) / 86400000);
}

/** `YYYY-MM-DD` of the first day of `date`'s month. */
function monthStartOf(date) {
  return `${String(date).slice(0, 7)}-01`;
}

/** A `COUNT(*)` result as a number. MySQL hands back a string for `BIGINT`. */
function countOf(rows) {
  return Number(rows?.[0]?.n ?? 0) || 0;
}

/**
 * `{ key: count }` from a `GROUP BY` of `(<column>, COUNT(*) AS n)`.
 *
 * `key` is required, and deliberately has no default. It used to default to
 * `'label'`, and three callers handed it a query that selected `status` or
 * `severity` — so every lookup missed, `byStatus.Active` was `undefined`, and
 * the residents tiles read **0** while the database held eight, with the
 * violations tiles showing whichever status MySQL happened to return last. The
 * helper is now the one place that can notice the mismatch, so it does: a
 * missing key throws, and the section degrades loudly instead of reporting an
 * empty facility.
 */
function tallyBy(rows, key) {
  if (!key) throw new Error('tallyBy requires the column name to group by');
  const out = {};
  for (const row of rows || []) out[String(row[key] ?? '')] = Number(row.n) || 0;
  return out;
}

/**
 * The Child Records module's own definition of an active resident — the exact
 * predicate behind its **Active** filter (`ChildRecords.tsx`, `matchesStatus`):
 * everything that is not Discharged and not Absconded.
 *
 * Written once and used by every resident breakdown on this page, so the tile,
 * the rehabilitation-phase mix, the behavioural mix and the case-type mix are
 * all counting the same population. Note this is deliberately *not*
 * `status = 'Active'`: the two agree today because the column is an ENUM of
 * exactly three values, but the module's rule is the one the Center Head can
 * check by clicking through, so that is the one implemented here.
 */
const ACTIVE_RESIDENT_WHERE = "status NOT IN ('Discharged', 'Absconded')";

/**
 * The rating bands the Child Detail's Behavioral tab prints, in the order that
 * tab ranks them. `Still Monitoring` is the tab's own word for a resident with
 * no Finalized TRI yet; `Not Rated` is a Finalized TRI whose rating is blank.
 * Anything else the TRI can hold is appended after these rather than dropped.
 */
const BEHAVIORAL_ORDER = [
  'Very Good',
  'Good',
  'Fair',
  'Needs Improvement',
  'Not Rated',
  'Still Monitoring',
];

/**
 * Every kind of dated commitment that reaches the schedule feed, named once.
 * The per-kind counts, the section's own fallback and the client's icon map all
 * read from this list, so a new kind cannot be counted in one place and missing
 * in another.
 */
const SCHEDULE_KINDS = [
  'activity',
  'assessment',
  'hearing',
  'intervention',
  'schoolVisit',
  'triDeadline',
];

/** The all-zero shape of `today` / `upcomingCounts` / `overdueCounts`. */
const ZERO_SCHEDULE_COUNTS = Object.fromEntries([...SCHEDULE_KINDS, 'total'].map((kind) => [kind, 0]));

/**
 * The phase names the rest of the system prints, and the short forms the
 * Dashboard's bar chart uses. Kept here rather than derived, because the
 * database stores the long label and the chart has to agree with the Child
 * Records screen for the same resident.
 */
const PHASE_SHORT = {
  'Admission Phase': 'Admission',
  'Orientation Phase': 'Orientation',
  'Enculturation/Observation Phase': 'Observation',
  'Caring & Rehabilitation Phase / DP or IPP Implementation': 'Rehabilitation',
  'Pre-integration Phase': 'Pre-integration',
  'Reintegration/Aftercare Program': 'Reintegration',
};

/**
 * GET /api/dashboard/center-head
 *
 * One answer for the Center Head's command centre. Every number here is a
 * `COUNT` over the live tables and every list is the rows behind one of those
 * counts, so a tile can never disagree with the screen it opens. Nothing on this
 * page is computed from the browser's cached store — the point of the endpoint
 * is that a record filed by any other member of staff shows up without a
 * re-login.
 *
 * ## Why one endpoint instead of a dozen calls
 *
 * The Dashboard used to assemble its numbers in the browser from the bulk store
 * snapshot plus a handful of module endpoints. That produced two classes of
 * bug: a count that lagged the database, and a count that used a different
 * definition from the list it opened (the "Docs Pending" tile and the Documents
 * module's badge disagreed twice over). Both come from having the rule in two
 * places. Here the rule is one SQL predicate, and the count and the list are
 * built from the same one.
 *
 * ## Section isolation
 *
 * Several of the tables read here are created lazily by the controller that owns
 * them — `anecdotalReports` is only created the first time an Anecdotal Report
 * is opened, and there is no boot-time migration for it. On a database where the
 * module has never been used, the query fails with `ER_NO_SUCH_TABLE`. That is
 * not an error worth failing the whole page for: no such table means no such
 * rows, so the correct answer is zero. Each section is therefore wrapped
 * separately and falls back to an empty result, and the failure is logged rather
 * than swallowed. The alternative — one unguarded query — is a Dashboard that
 * goes blank because a module nobody has opened yet has no table.
 *
 * ## Scope
 *
 * Management reporting, gated to the Center Head at the route. There is no
 * per-caller narrowing here (no Houseparent case load), because no other role
 * reaches the endpoint.
 */
async function centerHeadOverview(req, res, next) {
  try {
    const today = String(req.query.date || manilaToday()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new ApiError(400, 'date must be YYYY-MM-DD');
    const monthStart = monthStartOf(today);

    /** Run one section; a failure degrades that section instead of the page. */
    const safe = async (label, run, fallback) => {
      try {
        return await run();
      } catch (error) {
        console.error(`Center Head dashboard — ${label} failed:`, error.message);
        return fallback;
      }
    };

    const emptyPage = { count: 0, items: [] };

    // ── Residents ──────────────────────────────────────────────────────────
    const residents = await safe('residents', async () => {
      const [[statusRows], [activeRows], [phaseRows], [caseTypeRows]] = await Promise.all([
        pool.query('SELECT status, COUNT(*) AS n FROM children GROUP BY status'),
        pool.query(`SELECT COUNT(*) AS n FROM children WHERE ${ACTIVE_RESIDENT_WHERE}`),
        pool.query(
          `SELECT COALESCE(casePhase, '') AS label, COUNT(*) AS n
             FROM children WHERE ${ACTIVE_RESIDENT_WHERE} GROUP BY label`
        ),
        pool.query(
          `SELECT COALESCE(caseType, '') AS label, COUNT(*) AS n
             FROM children WHERE ${ACTIVE_RESIDENT_WHERE} GROUP BY label`
        ),
      ]);
      const byStatus = tallyBy(statusRows, 'status');
      const byPhase = Object.entries(tallyBy(phaseRows, 'label'))
        .map(([phase, count]) => ({ phase, short: PHASE_SHORT[phase] || phase || 'Unassigned', count }))
        .filter((row) => row.count > 0)
        .sort((a, b) => b.count - a.count);
      const byCaseType = Object.entries(tallyBy(caseTypeRows, 'label'))
        .map(([label, count]) => ({ label: label || 'Unspecified', count }))
        .filter((row) => row.count > 0)
        .sort((a, b) => b.count - a.count);

      // ── Behavioural status ───────────────────────────────────────────────
      // The Behavioral tab on a resident's page prints `behaviorSummary.status`
      // (ChildDetail.tsx): the rating on their newest **Finalized** TRI, or
      // "Still Monitoring" when they have none, with a Finalized TRI whose
      // rating is blank reading "Not Rated". Same rule here, so this breakdown
      // and the resident's own page cannot disagree about a rating.
      //
      // Guarded on its own: `triRecords` has a boot migration, but a missing
      // table would otherwise take the resident counts down with it, and a
      // behavioural split is not worth a blank KPI row.
      let behavioral = [];
      try {
        const [rows] = await pool.query(
          `SELECT CASE WHEN t.id IS NULL THEN 'Still Monitoring'
                       ELSE COALESCE(NULLIF(t.rating, ''), 'Not Rated') END AS label,
                  COUNT(*) AS n
             FROM children c
             LEFT JOIN triRecords t
               ON t.id = (
                    SELECT t2.id FROM triRecords t2
                     WHERE t2.residentId = c.id AND t2.status = 'Finalized'
                     ORDER BY t2.reportingYear DESC, t2.reportingMonth DESC,
                              t2.finalizedAt DESC, t2.id DESC
                     LIMIT 1)
            WHERE c.${ACTIVE_RESIDENT_WHERE}
            GROUP BY label`
        );
        const tally = tallyBy(rows, 'label');
        behavioral = BEHAVIORAL_ORDER.filter((label) => (tally[label] || 0) > 0)
          .map((label) => ({ label, count: tally[label] }));
        // A band the order does not name is still a real rating — count it.
        for (const [label, count] of Object.entries(tally)) {
          if (!BEHAVIORAL_ORDER.includes(label) && count > 0) behavioral.push({ label, count });
        }
      } catch (error) {
        console.error('Center Head dashboard — behavioral status failed:', error.message);
      }

      return {
        active: countOf(activeRows),
        discharged: byStatus.Discharged || 0,
        absconded: byStatus.Absconded || 0,
        total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
        byPhase,
        byCaseType,
        behavioral,
      };
    }, {
      active: 0, discharged: 0, absconded: 0, total: 0, byPhase: [], byCaseType: [], behavioral: [],
    });

    // ── Admissions ─────────────────────────────────────────────────────────
    // `admissions.status` is per admission period, not per resident: a returning
    // resident has one Closed row and one Active row. "Current admissions" is
    // therefore the count of Active periods, which is the number of residents
    // actually in the facility right now, and it can legitimately differ from
    // `children.status = 'Active'` when a resident's record was closed without
    // its admission being closed (or the reverse).
    const admissions = await safe('admissions', async () => {
      const [[current], [thisMonth], [recent], [expected]] = await Promise.all([
        pool.query("SELECT COUNT(*) AS n FROM admissions WHERE status = 'Active'"),
        pool.query('SELECT COUNT(*) AS n FROM admissions WHERE admissionDate >= ?', [monthStart]),
        pool.query(
          `SELECT a.id, a.residentId, a.admissionNumber, a.admissionDate, a.name AS admissionName,
                  c.name AS residentName
             FROM admissions a
             LEFT JOIN children c ON c.id = a.residentId
            ORDER BY a.admissionDate DESC, a.id DESC
            LIMIT 6`
        ),
        pool.query(
          `SELECT a.residentId, a.expectedDischargeDate, c.name AS residentName, c.casePhase
             FROM admissions a
             JOIN children c ON c.id = a.residentId
            WHERE a.status = 'Active' AND a.expectedDischargeDate IS NOT NULL
            ORDER BY a.expectedDischargeDate ASC`
        ),
      ]);
      const upcoming = [];
      const overdue = [];
      for (const row of expected) {
        const days = daysBetween(today, row.expectedDischargeDate);
        const entry = {
          residentId: row.residentId,
          residentName: row.residentName,
          expectedDate: row.expectedDischargeDate,
          days,
        };
        if (days !== null && days < 0) overdue.push({ ...entry, daysOverdue: Math.abs(days) });
        else upcoming.push(entry);
      }
      return {
        current: countOf(current),
        thisMonth: countOf(thisMonth),
        recent,
        expectedUpcoming: upcoming,
        expectedOverdue: overdue,
      };
    }, { current: 0, thisMonth: 0, recent: [], expectedUpcoming: [], expectedOverdue: [] });

    // ── Discharges ─────────────────────────────────────────────────────────
    const discharges = await safe('discharges', async () => {
      const [[closed], [closedThisMonth], [recommendations]] = await Promise.all([
        pool.query("SELECT COUNT(*) AS n FROM children WHERE status = 'Discharged'"),
        pool.query(
          "SELECT COUNT(*) AS n FROM admissions WHERE status = 'Closed' AND closedDate >= ?",
          [monthStart]
        ),
        pool.query(
          `SELECT dr.id, dr.residentId, dr.triRecordId, dr.thresholdType, dr.recommendationNote,
                  dr.reportingYear, dr.reportingMonth, dr.createdAt, c.name AS residentName
             FROM dischargeRecommendations dr
             LEFT JOIN children c ON c.id = dr.residentId
            WHERE dr.status = 'Pending'
            ORDER BY dr.createdAt ASC`
        ),
      ]);
      return {
        total: countOf(closed),
        thisMonth: countOf(closedThisMonth),
        pendingRecommendations: recommendations,
      };
    }, { total: 0, thisMonth: 0, pendingRecommendations: [] });

    // ── Pending cases: court hearings ──────────────────────────────────────
    // A hearing still marked Scheduled whose date has passed is the definition of
    // overdue here: nobody recorded an outcome, so the case is sitting on the
    // Center Head's desk whether or not anyone noticed.
    const hearings = await safe('hearings', async () => {
      const [[upcomingCount], [overdueCount], [upcomingRows], [overdueRows]] = await Promise.all([
        pool.query(
          "SELECT COUNT(*) AS n FROM courtRecords WHERE status = 'Scheduled' AND hearingDate >= ?",
          [today]
        ),
        pool.query(
          "SELECT COUNT(*) AS n FROM courtRecords WHERE status = 'Scheduled' AND hearingDate < ?",
          [today]
        ),
        pool.query(
          `SELECT cr.id, cr.residentId, cr.caseNumber, cr.courtName, cr.hearingType,
                  cr.hearingDate, cr.hearingTime, c.name AS residentName
             FROM courtRecords cr
             LEFT JOIN children c ON c.id = cr.residentId
            WHERE cr.status = 'Scheduled' AND cr.hearingDate >= ?
            ORDER BY cr.hearingDate ASC, cr.hearingTime ASC
            LIMIT 6`,
          [today]
        ),
        pool.query(
          `SELECT cr.id, cr.residentId, cr.caseNumber, cr.courtName, cr.hearingType,
                  cr.hearingDate, cr.hearingTime, c.name AS residentName
             FROM courtRecords cr
             LEFT JOIN children c ON c.id = cr.residentId
            WHERE cr.status = 'Scheduled' AND cr.hearingDate < ?
            ORDER BY cr.hearingDate ASC
            LIMIT 6`,
          [today]
        ),
      ]);
      return {
        upcoming: countOf(upcomingCount),
        overdue: countOf(overdueCount),
        upcomingRows,
        overdueRows: overdueRows.map((row) => ({
          ...row,
          daysOverdue: Math.abs(daysBetween(today, row.hearingDate) ?? 0),
        })),
      };
    }, { upcoming: 0, overdue: 0, upcomingRows: [], overdueRows: [] });

    // ── Violations ─────────────────────────────────────────────────────────
    // Two different questions, and the module answers both:
    //
    //   The **Violation List** (`filteredViolations` in Violations.tsx) is every
    //   violation that is not `Pending Review` and not `Rejected` — the ones
    //   that actually exist as cases. Within it the status filter offers
    //   Reviewed / Overdue / Resolved, and `getDisplayStatus` decides which a row
    //   is:
    //     Resolved   `status = 'Resolved'`
    //     Overdue    `Escalated`, or the intervention month has passed with
    //                nobody having decided it
    //     Reviewed   `Reviewed` or `Under Investigation`, and not yet overdue
    //
    //   **Open** is the wider set: everything not Resolved and not Rejected,
    //   which additionally includes `Pending Review` — reports nobody has looked
    //   at yet. Those are deliberately *not* in the Violation List, so they are
    //   reported separately rather than folded into it.
    //
    // `active` is the Reviewed bucket, which is the number the Center Head sees
    // after opening Violations and picking Reviewed from the status filter.
    //
    // The month comparison uses the facility's calendar month, which `today`
    // already is. The module does the same comparison in the browser against
    // `new Date().toISOString()`, so on the last eight hours of a month the two
    // can differ by one month; the facility's own calendar is the right one to
    // report from here.
    const violations = await safe('violations', async () => {
      const month = today.slice(0, 7);
      const [[statusRows], [displayRows], [severityRows], [resolvedThisMonth], [listRows]] =
        await Promise.all([
          pool.query('SELECT status, COUNT(*) AS n FROM violations GROUP BY status'),
          pool.query(
            `SELECT CASE
                      WHEN status = 'Resolved' THEN 'Resolved'
                      WHEN status = 'Escalated' THEN 'Overdue'
                      WHEN COALESCE(NULLIF(interventionMonth, ''), DATE_FORMAT(date, '%Y-%m')) < ?
                           AND status NOT IN ('Pending Review', 'Rejected') THEN 'Overdue'
                      WHEN status IN ('Reviewed', 'Under Investigation') THEN 'Reviewed'
                      ELSE status
                    END AS label,
                    COUNT(*) AS n
               FROM violations
              GROUP BY label`,
            [month]
          ),
          pool.query(
            `SELECT severity, COUNT(*) AS n FROM violations
              WHERE status NOT IN ('Resolved', 'Rejected') GROUP BY severity`
          ),
          pool.query("SELECT COUNT(*) AS n FROM violations WHERE status = 'Resolved' AND date >= ?", [
            monthStart,
          ]),
          pool.query(
            "SELECT COUNT(*) AS n FROM violations WHERE status NOT IN ('Pending Review', 'Rejected')"
          ),
        ]);
      const byStatus = tallyBy(statusRows, 'status');
      const display = tallyBy(displayRows, 'label');
      const bySeverity = tallyBy(severityRows, 'severity');
      return {
        active: display.Reviewed || 0,
        list: countOf(listRows),
        reviewed: display.Reviewed || 0,
        overdue: display.Overdue || 0,
        resolved: display.Resolved || 0,
        open: Object.entries(byStatus)
          .filter(([status]) => status !== 'Resolved' && status !== 'Rejected')
          .reduce((sum, [, count]) => sum + count, 0),
        pendingReview: byStatus['Pending Review'] || 0,
        underInvestigation: byStatus['Under Investigation'] || 0,
        escalated: byStatus.Escalated || 0,
        rejected: byStatus.Rejected || 0,
        resolvedThisMonth: countOf(resolvedThisMonth),
        bySeverity: {
          Minor: bySeverity.Minor || 0,
          Major: bySeverity.Major || 0,
          Critical: bySeverity.Critical || 0,
        },
      };
    }, {
      active: 0, list: 0, reviewed: 0, overdue: 0, resolved: 0, open: 0,
      pendingReview: 0, underInvestigation: 0, escalated: 0, rejected: 0, resolvedThisMonth: 0,
      bySeverity: { Minor: 0, Major: 0, Critical: 0 },
    });

    // ── Documents needing review ───────────────────────────────────────────
    // `Submitted` and `Under Review` are the two pre-decision statuses, and the
    // resident filter is the Documents module's default view (active residents),
    // so this tile and the module's own "For Review" badge read the same number.
    // Both rules are copied from `frontend/src/utils/pendingDocuments.ts` — if
    // either changes, that file and this query have to move together.
    const documents = await safe('documents', async () => {
      const where = `d.status IN ('Submitted', 'Under Review')
                       AND (c.id IS NULL OR c.status <> 'Discharged')`;
      const [[total], [rows]] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) AS n FROM documents d
             LEFT JOIN children c ON c.id = d.residentId
            WHERE ${where}`
        ),
        pool.query(
          `SELECT d.id, d.residentId, d.residentName, d.title, d.type, d.documentCategory,
                  d.status, d.uploaderRole, d.submittedAt, d.phase,
                  c.name AS residentNameLive
             FROM documents d
             LEFT JOIN children c ON c.id = d.residentId
            WHERE ${where}
            ORDER BY d.submittedAt ASC, d.id ASC
            LIMIT 8`
        ),
      ]);
      return { count: countOf(total), items: rows };
    }, emptyPage);

    // ── Reports needing review ─────────────────────────────────────────────
    // Four review queues, each read from the table that owns it:
    //   Anecdotal   — `Submitted` / `Under Review`, the Reports module's queue
    //   Quarterly   — `Submitted` / `Under Review`, a card inside Reports
    //   TRI         — `Submitted` / `Under Review`, approved from the TRI screen
    //   Education   — monthly reports `Submitted` for approval
    const reports = await safe('reports', async () => {
      const [anecdotal, quarterly, tri, education, incident] = await Promise.all([
        (async () => {
          const [rows] = await pool.query(
            `SELECT a.id, a.residentId, a.reportYear, a.reportMonth, a.status,
                    a.submittedBy, a.submittedAt, c.name AS residentName
               FROM anecdotalReports a
               LEFT JOIN children c ON c.id = a.residentId
              WHERE a.status IN ('Submitted', 'Under Review')
              ORDER BY a.reportYear ASC, a.reportMonth ASC, a.id ASC`
          );
          return { count: rows.length, items: rows.slice(0, 6) };
        })(),
        (async () => {
          const [rows] = await pool.query(
            `SELECT q.id, q.residentId, q.periodLabel, q.periodStart, q.periodEnd, q.status,
                    q.submittedBy, q.submittedAt, c.name AS residentName
               FROM quarterlyProgressReports q
               LEFT JOIN children c ON c.id = q.residentId
              WHERE q.status IN ('Submitted', 'Under Review')
              ORDER BY q.periodStart ASC, q.id ASC`
          );
          return { count: rows.length, items: rows.slice(0, 6) };
        })(),
        (async () => {
          const [rows] = await pool.query(
            `SELECT t.id, t.residentId, t.reportingYear, t.reportingMonth, t.status,
                    t.submittedBy, t.submittedAt, t.submissionDeadline, t.finalPoints, t.rating,
                    c.name AS residentName
               FROM triRecords t
               LEFT JOIN children c ON c.id = t.residentId
              WHERE t.status IN ('Submitted', 'Under Review')
              ORDER BY t.reportingYear ASC, t.reportingMonth ASC, t.id ASC`
          );
          return { count: rows.length, items: rows.slice(0, 6) };
        })(),
        (async () => {
          // Aliased: an Education monthly report's period is a `YYYY-MM` string
          // while an Anecdotal report's is a year + month pair, and both land in
          // the same client-side row shape. Two different meanings for
          // `reportMonth` in one payload is how a formatter silently prints
          // "Sep 2026" for the value `2026-09`.
          const [rows] = await pool.query(
            `SELECT m.id, m.residentId, m.reportMonth AS reportMonthKey, m.status,
                    m.submittedBy, m.submittedAt, c.name AS residentName
               FROM education_monthly_reports m
               LEFT JOIN children c ON c.id = m.residentId
              WHERE m.status = 'Submitted'
              ORDER BY m.reportMonth ASC, m.id ASC`
          );
          return { count: rows.length, items: rows.slice(0, 6) };
        })(),
        // Incident Reports are verified by the Psychological Staff and the Social
        // Worker, not the Center Head — counted so the workload is visible, and
        // reported separately so it is not mistaken for the Center Head's queue.
        (async () => {
          const [rows] = await pool.query(
            "SELECT COUNT(*) AS n FROM incidentReports WHERE status IN ('Submitted', 'Pending Review')"
          );
          return { count: countOf(rows) };
        })(),
      ]);
      return {
        anecdotal,
        quarterly,
        tri,
        education,
        incidentPending: incident.count,
        total: anecdotal.count + quarterly.count + tri.count + education.count,
      };
    }, {
      anecdotal: emptyPage, quarterly: emptyPage, tri: emptyPage, education: emptyPage,
      incidentPending: 0, total: 0,
    });

    // ── Access requests awaiting a decision ────────────────────────────────
    const accessRequests = await safe('accessRequests', async () => {
      const [[total], [rows]] = await Promise.all([
        pool.query("SELECT COUNT(*) AS n FROM accessRequests WHERE status = 'Pending'"),
        pool.query(
          `SELECT ar.id, ar.requesterUsername, ar.requesterRole, ar.moduleName, ar.recordTab,
                  ar.residentId, ar.reason, ar.createdAt, c.name AS residentName
             FROM accessRequests ar
             LEFT JOIN children c ON c.id = ar.residentId
            WHERE ar.status = 'Pending'
            ORDER BY ar.createdAt ASC
            LIMIT 6`
        ),
      ]);
      return { count: countOf(total), items: rows };
    }, emptyPage);

    // ── Upcoming and overdue schedules ─────────────────────────────────────
    // Every kind of dated commitment in the system, in one feed. Each source
    // uses the rule its own module uses for "still open":
    //   activities    not Cancelled / Completed
    //   assessments   Scheduled
    //   hearings      Scheduled
    //   interventions In Progress with a schedule
    //   school visits Scheduled
    //   TRI deadlines not yet Finalized, with a submission deadline
    // The counts are the lengths of the same arrays the feed is drawn from, so
    // the number on a tile and the rows behind it cannot disagree.
    const schedules = await safe('schedules', async () => {
      // Each element of `Promise.all` is `pool.query`'s `[rows, fields]` pair,
      // so every binding below needs the inner destructure. Without it
      // `activityRows` was `[rowsArray, fieldsArray]`, the loop read `.date` off
      // two arrays, every entry was skipped for a null day, and four of the five
      // kinds silently never reached the feed — while hearings, which come from
      // an already-destructured section, kept working.
      const [[activityRows], [assessmentRows], [interventionRows], [visitRows]] = await Promise.all([
        pool.query(
          `SELECT a.id, a.title, a.date, a.time, a.location, a.type, a.status
             FROM activities a
            WHERE a.date IS NOT NULL AND (a.status IS NULL OR a.status NOT IN ('Cancelled', 'Completed'))
            ORDER BY a.date ASC, a.time ASC`
        ),
        pool.query(
          `SELECT s.id, s.title, s.date, s.time, s.type, s.assessor, s.status
             FROM assessments s
            WHERE s.date IS NOT NULL AND s.status = 'Scheduled'
            ORDER BY s.date ASC, s.time ASC`
        ),
        pool.query(
          `SELECT it.id, it.residentId, it.interventionType, it.scheduledAt, it.status,
                  c.name AS residentName
             FROM intervention_tracker it
             LEFT JOIN children c ON c.id = it.residentId
            WHERE it.scheduledAt IS NOT NULL AND it.status = 'In Progress'
            ORDER BY it.scheduledAt ASC`
        ),
        pool.query(
          `SELECT v.id, v.residentId, v.school, v.visitDate, v.purpose, v.status,
                  c.name AS residentName
             FROM education_school_visits v
             LEFT JOIN children c ON c.id = v.residentId
            WHERE v.status = 'Scheduled'
            ORDER BY v.visitDate ASC`
        ),
      ]);

      // TRI submission deadlines. A TRI that is still owed has a deadline; one
      // that is already Finalized does not, so the Finalized rows are excluded
      // rather than reported as work outstanding. Guarded on its own — a
      // deadline is a useful extra on this feed and must not be able to empty it.
      let deadlineRows = [];
      try {
        const [rows] = await pool.query(
          `SELECT t.id, t.residentId, t.status, t.submissionDeadline, c.name AS residentName
             FROM triRecords t
             LEFT JOIN children c ON c.id = t.residentId
            WHERE t.submissionDeadline IS NOT NULL AND t.status <> 'Finalized'
            ORDER BY t.submissionDeadline ASC`
        );
        deadlineRows = rows;
      } catch (error) {
        console.error('Center Head dashboard — TRI deadlines failed:', error.message);
      }

      /** One feed entry. `kind` is what the client maps to a route. */
      const entry = (kind, row) => ({ kind, ...row });

      const upcoming = [];
      const overdue = [];

      for (const row of activityRows) {
        const days = daysBetween(today, row.date);
        if (days === null) continue;
        const item = entry('activity', { id: row.id, title: row.title, date: row.date, time: row.time, location: row.location, type: row.type, status: row.status || 'Upcoming', days });
        (days < 0 ? overdue : upcoming).push(item);
      }
      for (const row of assessmentRows) {
        const days = daysBetween(today, row.date);
        if (days === null) continue;
        const item = entry('assessment', { id: row.id, title: row.title, date: row.date, time: row.time, type: row.type, assessor: row.assessor, status: row.status, days });
        (days < 0 ? overdue : upcoming).push(item);
      }
      for (const row of hearings.upcomingRows) {
        upcoming.push(entry('hearing', {
          id: row.id, residentId: row.residentId, residentName: row.residentName,
          title: row.hearingType || 'Court hearing', date: row.hearingDate, time: row.hearingTime,
          location: row.courtName, caseNumber: row.caseNumber, status: 'Scheduled',
          days: daysBetween(today, row.hearingDate) ?? 0,
        }));
      }
      for (const row of hearings.overdueRows) {
        overdue.push(entry('hearing', {
          id: row.id, residentId: row.residentId, residentName: row.residentName,
          title: row.hearingType || 'Court hearing', date: row.hearingDate, time: row.hearingTime,
          location: row.courtName, caseNumber: row.caseNumber, status: 'Scheduled',
          days: -(row.daysOverdue || 0),
        }));
      }
      for (const row of interventionRows) {
        // `scheduledAt` is a DATETIME the pool returns as a zone-less literal in
        // UTC, so the calendar day is read off its first ten characters rather
        // than through `new Date()`, which would shift it by the browser's zone.
        const day = String(row.scheduledAt || '').slice(0, 10);
        const days = daysBetween(today, day);
        if (days === null) continue;
        const item = entry('intervention', {
          id: row.id, residentId: row.residentId, residentName: row.residentName,
          title: row.interventionType || 'Intervention session', date: day,
          time: String(row.scheduledAt || '').slice(11, 16) || null, status: row.status, days,
        });
        (days < 0 ? overdue : upcoming).push(item);
      }
      for (const row of visitRows) {
        const days = daysBetween(today, row.visitDate);
        if (days === null) continue;
        const item = entry('schoolVisit', {
          id: row.id, residentId: row.residentId, residentName: row.residentName,
          title: row.school ? `School visit — ${row.school}` : 'School visit',
          date: row.visitDate, location: row.school, purpose: row.purpose,
          status: row.status, days,
        });
        (days < 0 ? overdue : upcoming).push(item);
      }
      for (const row of deadlineRows) {
        const days = daysBetween(today, row.submissionDeadline);
        if (days === null) continue;
        const item = entry('triDeadline', {
          id: row.id, residentId: row.residentId, residentName: row.residentName,
          title: row.residentName ? `TRI submission — ${row.residentName}` : 'TRI submission',
          date: row.submissionDeadline, status: row.status, days,
        });
        (days < 0 ? overdue : upcoming).push(item);
      }

      const byDate = (a, b) =>
        String(a.date || '').localeCompare(String(b.date || '')) ||
        String(a.time || '').localeCompare(String(b.time || ''));
      upcoming.sort(byDate);
      overdue.sort(byDate);

      const todays = upcoming.filter((item) => item.days === 0);

      // One list of kinds, counted three times. Naming them once is what keeps
      // `today`, `upcomingCounts` and `overdueCounts` from drifting apart — a
      // kind added to one object and forgotten in another is a tile that
      // disagrees with the feed printed underneath it.
      const countsOf = (list) => {
        const out = {};
        for (const kind of SCHEDULE_KINDS) out[kind] = list.filter((item) => item.kind === kind).length;
        out.total = list.length;
        return out;
      };

      return {
        today: { date: today, ...countsOf(todays) },
        upcomingCounts: countsOf(upcoming),
        overdueCounts: countsOf(overdue),
        upcoming: upcoming.slice(0, 14),
        overdue: overdue.slice(0, 10),
      };
    }, {
      today: { date: today, ...ZERO_SCHEDULE_COUNTS },
      upcomingCounts: { ...ZERO_SCHEDULE_COUNTS },
      overdueCounts: { ...ZERO_SCHEDULE_COUNTS },
      upcoming: [],
      overdue: [],
    });

    res.json({
      success: true,
      data: {
        today,
        generatedAt: new Date().toISOString(),
        residents,
        admissions,
        discharges,
        hearings,
        violations,
        documents,
        reports,
        accessRequests,
        schedules,
      },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { scheduleSummary, centerHeadOverview, manilaToday };
