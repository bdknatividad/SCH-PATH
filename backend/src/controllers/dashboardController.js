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

/**
 * `YYYY-MM-DD` of the last day of a `YYYY-MM` month.
 *
 * Computed from the numbers alone — `Date.UTC(year, month, 0)` is "day 0 of the
 * next month", which is the last day of this one — so no zone-less string is
 * ever handed to `new Date()` and read back in the server's own zone. The old
 * `setMonth(+1); setDate(0)` shape would do the same arithmetic, but it does it
 * through a local `Date`, which is exactly the conversion that has silently
 * moved a boundary by a day elsewhere in this codebase.
 */
function monthEndOf(period) {
  const [year, month] = String(period).split('-').map(Number);
  if (!year || !month) return `${period}-28`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, '0')}`;
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
 * `{ label: [{ id, name }] }` from rows of `(id, name, label)`.
 *
 * The breakdown counterpart of `tallyBy`. A bar that prints only a number invites
 * the question "which residents?", so the query that produces the count also
 * produces the names and this groups them — counting and listing from the same
 * rows is what stops a bar and the list behind it from disagreeing.
 */
function groupResidentsByLabel(rows) {
  const out = {};
  for (const row of rows || []) {
    const label = String(row.label ?? '');
    if (!out[label]) out[label] = [];
    out[label].push({ id: String(row.id), name: row.name ?? '' });
  }
  return out;
}

/**
 * How "active" is decided, once, for the whole page.
 *
 * The Child Records module's **Active** filter is `status NOT IN ('Discharged',
 * 'Absconded')` — everything not Discharged and not Absconded. That is the rule
 * for *now*, and it is the one the Center Head can check by clicking through to
 * the module, so it is the notion of "active" this page implements.
 *
 * It is not restated here as a constant, because with a period selector the
 * question is no longer "is this resident active" but "was this resident here
 * during September". `activeInPeriodWhere` below is that rule: the same
 * notion of a placement, evaluated at a date instead of at `now`.
 *
 * One deliberate difference, and it is the honest reading of "here during
 * September": a resident discharged *earlier in the selected month* is present
 * for that month and is counted, though the module's filter — which asks about
 * now — would not list them. Every other resident agrees, and the rule is the
 * same for every period, so a month's figure never changes as time passes.
 */

/**
 * The behavioural bands the Center Head's dashboard draws, in the order the
 * approved template lists them — weakest first, with the residents who have no
 * finalised TRI for the period last.
 *
 * `Unscored` is the TRI module's own word (`TriStatistics.tsx`) for a resident
 * with no finalised TRI, and it is also where a finalised TRI with a blank
 * rating lands: both mean "no score for this period", and giving them two rows
 * would split one population across two bars.
 *
 * Every band is emitted whether or not it holds anyone, so the five bars keep
 * their places as the period changes.
 */
const BEHAVIORAL_BANDS = [
  'Needs Improvement',
  'Fair',
  'Good',
  'Very Good',
  'Unscored',
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

    /**
     * The statistics period — the month the dashboard is *about*.
     *
     * `?period=YYYY-MM` scopes the resident counts, the rehabilitation-phase
     * mix, the behavioural mix and the violations to one calendar month. It
     * deliberately does **not** move `today`: the schedule feed answers "what is
     * coming up next", which is a question about now, and re-basing it on a past
     * month would hide commitments that are still ahead of the facility.
     *
     * The two were one parameter before, which is the trap this separates: a
     * caller asking for September would have moved "today" to September and
     * turned the Upcoming/Overdue counts into nonsense.
     *
     * The boundaries are inclusive calendar days in the facility's own
     * convention, and they are plain `YYYY-MM-DD` strings compared against
     * `DATE` columns — no timestamp conversion, so no record is pushed out of
     * its month by a timezone.
     */
    const requestedPeriod = String(req.query.period || '').trim();
    // Months 01–12 only. `\d{2}` would accept `2026-13`, and the month-end
    // arithmetic would then quietly answer with `2026-13-31` — a period that
    // matches no row, so the whole dashboard would read zero rather than fail.
    if (requestedPeriod && !/^\d{4}-(0[1-9]|1[0-2])$/.test(requestedPeriod)) {
      throw new ApiError(400, 'period must be YYYY-MM');
    }
    const period = requestedPeriod || today.slice(0, 7);
    const periodStart = `${period}-01`;
    const periodEnd = monthEndOf(period);
    const periodYear = Number(period.slice(0, 4));
    const periodMonth = Number(period.slice(5, 7));

    /**
     * Is the selected period still in the future?
     *
     * A month that has not happened yet has no statistics, and the period
     * predicate cannot tell: it asks whether a placement was open at the period's
     * end, and **every currently-open placement is open at any future date**. So
     * December reported today's population as though it were December's — a
     * projection presented as a fact, and one discharge in October makes it wrong.
     *
     * Decided here rather than in the browser because "which month is it" is a
     * fact about the facility's own calendar (`today` is already Manila), and a
     * client re-deriving it from its own clock can be a day out.
     *
     * The schedule feed and the two review queues are deliberately **not** part of
     * this: they answer "what is coming up" and "what is waiting now", which are
     * questions about the present and stay correct whatever period is selected.
     */
    const periodIsFuture = period > today.slice(0, 7);

    /**
     * "Was this resident still in the facility at the end of the period?"
     *
     * Presence is recorded as admission *periods* — `admissions.admissionDate`
     * through `admissions.closedDate` — so the test is: admitted on or before the
     * period ended, and not closed before it did. A resident still in the
     * facility has a NULL `closedDate` and qualifies from their admission onward.
     *
     * **"At the end of" is the whole point.** The first version of this asked
     * whether the placement merely *overlapped* the month, which counted a
     * resident discharged earlier in the same month as active: eight residents on
     * a database holding seven, with the eighth plainly marked Discharged on the
     * Child Records page the tile opens. The tile has to agree with that page.
     *
     * Asking about the period's end is also what keeps a month's figure stable —
     * a resident discharged in September drops out of September and stays out.
     */
    const activeInPeriodWhere = `
      EXISTS (SELECT 1 FROM admissions a
               WHERE a.residentId = c.id
                 AND a.admissionDate <= ?
                 AND (a.closedDate IS NULL OR a.closedDate >= ?))`;
    /** Params for `activeInPeriodWhere`, in the order that predicate reads them. */
    const activeInPeriodParams = [periodEnd, periodEnd];

    /**
     * The period as a date range, **start first** — the order a
     * `col >= ? AND col <= ?` predicate reads.
     *
     * Deliberately a second, separately named array rather than a reuse of
     * `activeInPeriodParams` above: the two orders are not interchangeable.
     * Handed the wrong one, MySQL cheerfully compares
     * `date >= '2026-09-30' AND date <= '2026-09-01'`, matches nothing, and the
     * whole section reads **zero** instead of failing — which is exactly what
     * happened to the violations figures when one array served both.
     */
    const periodRange = [periodStart, periodEnd];

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
      const [[statusRows], [activeRows], [phaseRows], [caseTypeRows], [dischargedRows]] =
        await Promise.all([
          pool.query('SELECT status, COUNT(*) AS n FROM children GROUP BY status'),
          pool.query(`SELECT COUNT(*) AS n FROM children c WHERE ${activeInPeriodWhere}`, activeInPeriodParams),
          // Rows, not a GROUP BY. The residents behind each bar are the point of
          // the bar, so the query that counts them also names them, and the
          // grouping happens in JS — one query rather than a count and a list
          // that can drift apart.
          pool.query(
            `SELECT c.id, c.name, COALESCE(c.casePhase, '') AS label
               FROM children c WHERE ${activeInPeriodWhere}
              ORDER BY c.name ASC`,
            activeInPeriodParams
          ),
          pool.query(
            `SELECT COALESCE(c.caseType, '') AS label, COUNT(*) AS n
               FROM children c WHERE ${activeInPeriodWhere} GROUP BY label`,
            activeInPeriodParams
          ),
          // Discharged *in the period* — the Child Records **Discharged** filter
          // cut to the month the case actually closed. The child row carries no
          // discharge date; the system records it as the close of the admission
          // period, so that is where the month is read from.
          pool.query(
            `SELECT COUNT(*) AS n FROM children c
              WHERE c.status IN ('Discharged', 'Transferred')
                AND EXISTS (SELECT 1 FROM admissions a
                             WHERE a.residentId = c.id
                               AND a.closedDate >= ? AND a.closedDate <= ?)`,
            [periodStart, periodEnd]
          ),
        ]);
      const byStatus = tallyBy(statusRows, 'status');
      const phaseGroups = groupResidentsByLabel(phaseRows);
      const byPhase = Object.entries(phaseGroups)
        .map(([phase, group]) => ({
          phase,
          short: PHASE_SHORT[phase] || phase || 'Unassigned',
          count: group.length,
          residents: group,
        }))
        .sort((a, b) => b.count - a.count);
      const byCaseType = Object.entries(tallyBy(caseTypeRows, 'label'))
        .map(([label, count]) => ({ label: label || 'Unspecified', count }))
        .filter((row) => row.count > 0)
        .sort((a, b) => b.count - a.count);

      // ── Behavioural status ───────────────────────────────────────────────
      // The rating bands the Behavioral tab ranks residents by, read from the
      // **Finalized TRI for the selected period**. The TRI is a monthly
      // instrument (`reportingYear` / `reportingMonth`), so "September 2026"
      // asks for September's finalised TRI and nothing else — the newest
      // Finalized TRI of *any* month would answer a different question and would
      // not move when the period changed. A resident with no finalised TRI that
      // month is **Unscored**, the same word the TRI Statistics card uses.
      //
      // All five bands are returned whether or not anyone is in them, so the
      // bars keep their places month to month instead of the chart reflowing on
      // every period change.
      //
      // Guarded on its own: `triRecords` has a boot migration, but a missing
      // table would otherwise take the resident counts down with it, and a
      // behavioural split is not worth a blank KPI row.
      let behavioral = [];
      try {
        // One row per resident, so the same query answers "how many" and "who".
        const [rows] = await pool.query(
          `SELECT c.id, c.name,
                  CASE WHEN t.id IS NULL THEN 'Unscored'
                       ELSE COALESCE(NULLIF(t.rating, ''), 'Unscored') END AS label
             FROM children c
             LEFT JOIN triRecords t
               ON t.id = (
                    SELECT t2.id FROM triRecords t2
                     WHERE t2.residentId = c.id
                       AND t2.status = 'Finalized'
                       AND t2.reportingYear = ? AND t2.reportingMonth = ?
                     ORDER BY t2.finalizedAt DESC, t2.id DESC
                     LIMIT 1)
            WHERE ${activeInPeriodWhere}
            ORDER BY c.name ASC`,
          [periodYear, periodMonth, ...activeInPeriodParams]
        );
        const groups = groupResidentsByLabel(rows);
        behavioral = BEHAVIORAL_BANDS.map((label) => {
          const group = groups[label] || [];
          return { label, count: group.length, residents: group };
        });
        // A band the list does not name is still a real rating — count it.
        for (const [label, group] of Object.entries(groups)) {
          if (!BEHAVIORAL_BANDS.includes(label) && group.length > 0) {
            behavioral.push({ label, count: group.length, residents: group });
          }
        }
      } catch (error) {
        console.error('Center Head dashboard — behavioral status failed:', error.message);
      }

      return {
        active: countOf(activeRows),
        // Discharged *in the period* — "how many residents left this month",
        // which is the question the period selector asks. `total` and
        // `absconded` stay all-time: neither is drawn on the dashboard, and a
        // period-scoped version of them would be a number nothing reads.
        discharged: countOf(dischargedRows),
        absconded: byStatus.Absconded || 0,
        total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
        byPhase,
        byCaseType,
        behavioral,
      };
    }, {
      active: 0, discharged: 0, absconded: 0, total: 0, byPhase: [], byCaseType: [], behavioral: [],
    });

    // A future period reports nothing rather than a projection. `total` and
    // `absconded` are all-time figures the page does not draw, so they are left
    // as they are; everything the dashboard does draw from this section is
    // emptied, and the client explains why with `periodIsFuture`.
    if (periodIsFuture) {
      residents.active = 0;
      residents.discharged = 0;
      residents.byPhase = [];
      residents.behavioral = BEHAVIORAL_BANDS.map((label) => ({ label, count: 0, residents: [] }));
    }

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
        pool.query("SELECT COUNT(*) AS n FROM children WHERE status IN ('Discharged', 'Transferred')"),
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
      // The period, not "now". Every figure in this section is scoped to
      // violations *dated* inside the selected month, and `month` is the period
      // itself — so the Overdue rule (an intervention month that has passed with
      // nobody deciding) is judged against the month being viewed rather than
      // against today. Using today would call a July case overdue in a July
      // view, which is the opposite of what the reader asked for.
      const month = period;
      const inPeriod = 'date >= ? AND date <= ?';
      const [[statusRows], [displayRows], [severityRows], [resolvedInPeriod], [listRows]] =
        await Promise.all([
          pool.query(
            `SELECT status, COUNT(*) AS n FROM violations WHERE ${inPeriod} GROUP BY status`,
            periodRange
          ),
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
              WHERE ${inPeriod}
              GROUP BY label`,
            [month, ...periodRange]
          ),
          pool.query(
            `SELECT severity, COUNT(*) AS n FROM violations
              WHERE status NOT IN ('Resolved', 'Rejected') AND ${inPeriod} GROUP BY severity`,
            periodRange
          ),
          pool.query(
            `SELECT COUNT(*) AS n FROM violations WHERE status = 'Resolved' AND ${inPeriod}`,
            periodRange
          ),
          pool.query(
            `SELECT COUNT(*) AS n FROM violations
              WHERE status NOT IN ('Pending Review', 'Rejected') AND ${inPeriod}`,
            periodRange
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
        resolvedInPeriod: countOf(resolvedInPeriod),
        bySeverity: {
          Minor: bySeverity.Minor || 0,
          Major: bySeverity.Major || 0,
          Critical: bySeverity.Critical || 0,
        },
      };
    }, {
      active: 0, list: 0, reviewed: 0, overdue: 0, resolved: 0, open: 0,
      pendingReview: 0, underInvestigation: 0, escalated: 0, rejected: 0, resolvedInPeriod: 0,
      bySeverity: { Minor: 0, Major: 0, Critical: 0 },
    });

    // ── Documents needing review ───────────────────────────────────────────
    // `Submitted` and `Under Review` are the two pre-decision statuses, and the
    // resident filter is the Documents module's default view (active residents),
    // so this tile and the module's own "For Review" badge read the same number.
    // Both rules are copied from `frontend/src/utils/pendingDocuments.ts` — if
    // either changes, that file and this query have to move together.
    //
    // `submittedAt` is only written by an explicit submit transition, so a
    // document uploaded straight into `Submitted` carries `uploadedAt` and a
    // NULL `submittedAt` — measured on the live database, 11 of the 12 pending
    // documents were in that state. Reading `submittedAt` alone therefore left
    // the "waiting since" column blank for almost every row, and made the
    // oldest-first ordering meaningless (MySQL sorts NULLs together at the
    // front). The Documents module already reads these two as one field —
    // `doc.submittedAt || doc.uploadedAt` in `DocumentUpload.tsx` — so this
    // query adopts the same rule rather than inventing a second one.
    const documents = await safe('documents', async () => {
      const where = `d.status IN ('Submitted', 'Under Review')
                       AND (c.id IS NULL OR c.status NOT IN ('Discharged', 'Transferred'))`;
      const queuedAt = 'COALESCE(d.submittedAt, d.uploadedAt)';
      const [[total], [rows]] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) AS n FROM documents d
             LEFT JOIN children c ON c.id = d.residentId
            WHERE ${where}`
        ),
        pool.query(
          `SELECT d.id, d.residentId, d.residentName, d.title, d.type, d.documentCategory,
                  d.status, d.uploaderRole, ${queuedAt} AS submittedAt, d.phase,
                  c.name AS residentNameLive
             FROM documents d
             LEFT JOIN children c ON c.id = d.residentId
            WHERE ${where}
            ORDER BY ${queuedAt} ASC, d.id ASC
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
        // The statistics period, resolved — echoed back so the header can label
        // exactly what it is showing without the client re-deriving it (and
        // getting the month wrong across a timezone).
        period,
        periodStart,
        periodEnd,
        // True when the period has not happened yet, so the client can explain
        // why the statistics are empty instead of showing zeros unexplained.
        periodIsFuture,
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
