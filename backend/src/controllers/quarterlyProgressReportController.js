/**
 * Quarterly Progress Report controller.
 *
 * @module controllers/quarterlyProgressReportController
 * @description The facility's Quarterly Progress Report — the six-Developmental-
 * Aspect document the reference form (`sample-pr.docx`) describes.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM A BLANK FORM ──────────────────────────────
 * The report is NOT written from scratch. Everything the form asks for already
 * exists somewhere in the system, entered by staff during the period:
 *
 *   - `anecdotalReports`  the Houseparent's monthly narrative, already split into
 *                         the same six aspects this report uses
 *   - `healthRecords`     Form 11-A, whose `details.monthlyMeasurements` holds a
 *                         height and weight per month
 *   - `incidentReports`   dated behavioural events
 *   - `activities`        the programmes the child actually joined, by category
 *   - `education_records` / `education_progress_reports` / `education_school_visits`
 *   - `intervention_tracker`  the formal interventions recorded against violations
 *
 * `triRecords` is deliberately NOT a source. The TRI carries one whole-resident
 * rating per month, while this form's "Present level of Functioning" is a rating
 * per aspect, so the TRI cannot fill it — and presenting its rating as evidence
 * would invite staff to copy one instrument's score into another's. Wire it in
 * only if the facility asks for it.
 *
 * So `assembleAspects()` reads those tables for the period and produces a
 * starting draft per aspect. The assigned staff member then curates it: they
 * accept, reword or drop each line, and set the one thing no query can produce —
 * the "Present level of Functioning" rating, which is a professional judgement.
 *
 * ── ONE PREPARER, NO PER-ASPECT SIGN-OFF ────────────────────────────────────
 * The report is prepared by one person — the Social Worker (the Center Head has
 * the same capability and occasionally files one). There is no assignment of
 * aspects to different staff members, no per-aspect submission and no
 * per-aspect signature: the six aspects are six fields of one document, and the
 * single "Prepared by" signature at the foot covers all of them. The Center Head
 * approves the TRI, not this report, so there is no second signature either.
 *
 * The only identifying information is auto-filled from the resident's records
 * (`buildIdentifyingInformation`). The aspect narratives stay manual: the
 * evidence queries exist and are tested, but the facility asked for the Social
 * Worker to write the six aspects rather than curate a machine draft.
 *
 * ── SNAPSHOT, NOT LIVE ───────────────────────────────────────────────────────
 * The assembled text is stored in the section's `assembled*` columns at the
 * moment the report is opened, and never recomputed. If it were recomputed, a
 * violation recorded in week 6 would silently rewrite an aspect somebody had
 * already written and submitted in week 5. Storing both the assembled and the
 * curated text also lets a reviewer see what the system proposed against what
 * was actually submitted.
 *
 * ── THE PERIOD IS A CALENDAR QUARTER ───────────────────────────────────────
 * Reports are keyed to the calendar quarter and year: Q1 Jan-Mar, Q2 Apr-Jun,
 * Q3 Jul-Sep, and Q4 Oct-Dec. The canonical quarter start date is retained in
 * `periodStart`, which also provides the database uniqueness key.
 */

const { pool } = require('../config/database');
const { activeAdmissionIdFor } = require('../services/admissionLink');
const { ApiError } = require('../middleware/errorHandler');
const { insertWithGeneratedId, runInTransactionWithIdRetry } = require('../utils/helpers');
const { hasRole } = require('../utils/authorization');
const {
  ASPECTS,
  buildQuarterlyReportDocument,
  buildQuarterlyReportTemplatePdf,
  periodRangeLabel,
  periodHeaderLabel,
} = require('../utils/quarterlyReportPdf');
// Finalized reports are filed in the Quarterly Reports folder; the folder comes
// from the routing rules so it cannot drift from the rest of the module.
const { folderForType } = require('../utils/documentCategory');

const QUARTERLY_FOLDER = folderForType('Quarterly Progress Report');

/** Report-level lifecycle. */
const REPORT_STATUSES = new Set(['Draft', 'Submitted', 'Under Review', 'Returned', 'Finalized']);
/** Per-aspect lifecycle. */
const SECTION_STATUSES = new Set(['Not Started', 'In Progress', 'Submitted', 'Returned']);
/** Statuses a reviewer may act on. */
const REVIEWABLE_STATUSES = ['Submitted', 'Under Review'];

/** The facility's own address — the form's "Present Address" for a resident. */
const FACILITY_ADDRESS = 'SCH Jenel Subd., Brgy. San Jose, Calamba City';

/** Calendar-quarter start months: Q1 Jan-Mar, Q2 Apr-Jun, Q3 Jul-Sep, Q4 Oct-Dec. */
const PERIOD_START_MONTHS = [1, 4, 7, 10];

/**
 * How each of the report's six aspects maps onto the vocabulary used by the
 * tables it draws from.
 *
 * `anecdotalKey` is essential: the Anecdotal Report names its two odd aspects
 * `education` and `productivity`, while this report calls them `educational` and
 * `economicProductivity`. Without this map those two aspects would silently
 * assemble nothing.
 *
 * `activityCategories` matches the `activities.category` values the Activities
 * module writes (see `activityCategories` in Activities.tsx). Every category it
 * offers is claimed by exactly one aspect — a category claimed by two aspects
 * would print the same activity twice in the combined PDF and hand it to two
 * different staff members, and a category claimed by none would mean activities
 * that are recorded and then never appear in any draft.
 *
 * `Psychosocial` therefore belongs to Emotional and Behavioral only. A group
 * session is evidence of how a child manages feelings and conduct; it is not
 * evidence of spiritual practice, and the facility has no spiritual activity
 * category. The Spiritual aspect's rendered interventions come from the
 * Houseparent's narrative. Add a category here if one is ever introduced.
 */
const ASPECT_SOURCES = {
  physical: { anecdotalKey: 'physical', activityCategories: ['Physical'], health: true, incidents: false, education: false },
  emotional: { anecdotalKey: 'emotional', activityCategories: ['Psychosocial'], health: false, incidents: false, education: false },
  behavioral: { anecdotalKey: 'behavioral', activityCategories: ['Psychosocial'], health: false, incidents: true, education: false },
  spiritual: { anecdotalKey: 'spiritual', activityCategories: [], health: false, incidents: false, education: false },
  educational: { anecdotalKey: 'education', activityCategories: ['Educational'], health: false, incidents: false, education: true },
  economicProductivity: { anecdotalKey: 'productivity', activityCategories: ['Livelihood', 'Recreational'], health: false, incidents: false, education: false },
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = MONTH_NAMES.map((name) => name.slice(0, 3));

let tablesEnsured = false;

/**
 * Creates this module's tables if they are missing.
 *
 * `server.js` runs the same migrations at boot, but a database provisioned
 * before this module existed would otherwise fail on the first request with
 * "Table doesn't exist". Checked once per process rather than per request.
 */
async function ensureTables() {
  if (tablesEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quarterlyProgressReports (
      id VARCHAR(40) PRIMARY KEY,
      residentId VARCHAR(40) NOT NULL,
      periodStart DATE NOT NULL,
      periodEnd DATE NOT NULL,
      periodLabel VARCHAR(60) NULL,
      identifyingInformation JSON NULL,
      status ENUM('Draft','Submitted','Under Review','Returned','Finalized') NOT NULL DEFAULT 'Draft',
      preparedByName VARCHAR(150) NULL,
      preparedBySignature LONGTEXT NULL,
      attestedByName VARCHAR(150) NULL,
      attestedBySignature LONGTEXT NULL,
      notedByName VARCHAR(150) NULL,
      notedBySignature LONGTEXT NULL,
      createdBy VARCHAR(100) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedBy VARCHAR(100) NULL,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      submittedBy VARCHAR(100) NULL,
      submittedAt DATETIME NULL,
      reviewedBy VARCHAR(100) NULL,
      reviewedAt DATETIME NULL,
      finalizedBy VARCHAR(100) NULL,
      finalizedAt DATETIME NULL,
      reviewNotes TEXT NULL,
      UNIQUE KEY uq_quarterly_progress_period (residentId, periodStart),
      INDEX idx_quarterly_progress_resident (residentId),
      INDEX idx_quarterly_progress_period (periodStart, periodEnd),
      INDEX idx_quarterly_progress_status (status),
      CONSTRAINT fk_quarterly_progress_resident FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quarterlyProgressReportSections (
      id VARCHAR(40) PRIMARY KEY,
      reportId VARCHAR(40) NOT NULL,
      aspectKey VARCHAR(40) NOT NULL,
      aspectLabel VARCHAR(100) NOT NULL,
      sortOrder TINYINT NOT NULL DEFAULT 0,
      assignedTo VARCHAR(40) NULL,
      assignedToName VARCHAR(150) NULL,
      assignedToRole VARCHAR(50) NULL,
      assembledPresentLevel TEXT NULL,
      assembledObservations TEXT NULL,
      assembledInterventions TEXT NULL,
      presentLevel TEXT NULL,
      observations TEXT NULL,
      interventions TEXT NULL,
      status ENUM('Not Started','In Progress','Submitted','Returned') NOT NULL DEFAULT 'Not Started',
      signedByName VARCHAR(150) NULL,
      signature LONGTEXT NULL,
      returnedReason TEXT NULL,
      submittedBy VARCHAR(100) NULL,
      submittedAt DATETIME NULL,
      createdBy VARCHAR(100) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedBy VARCHAR(100) NULL,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_quarterly_progress_section (reportId, aspectKey),
      INDEX idx_quarterly_progress_section_report (reportId),
      INDEX idx_quarterly_progress_section_assignee (assignedTo),
      CONSTRAINT fk_quarterly_progress_section_report FOREIGN KEY (reportId) REFERENCES quarterlyProgressReports(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  tablesEnsured = true;
}

// ── SMALL HELPERS ───────────────────────────────────────────────────────────

function actor(req) {
  return req.user?.username || req.user?.name || 'System';
}

/**
 * The name that goes on the report's signature line.
 *
 * This is the account's **display name** — whatever Account Management holds,
 * e.g. "Social Worker" — falling back to the username when no display name was
 * configured. It is deliberately not `actor()`, which is the bare login name.
 *
 * It has to be looked up rather than read off the request: `authenticate` builds
 * `req.user` from the JWT, and the token carries only id/username/role. A missing
 * `displayName` column (an older database) degrades to the username rather than
 * failing the request — the report must still be openable.
 */
async function actorDisplayName(req) {
  const username = actor(req);
  if (!req.user?.id) return username;
  try {
    const [rows] = await pool.query('SELECT displayName FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    return text(rows[0]?.displayName) || username;
  } catch {
    return username;
  }
}

/**
 * Center Head, Admin and Social Worker may prepare a Quarterly Progress Report.
 *
 * Named for what it decides rather than for a role: the check is "may prepare
 * this report", and the Social Worker is the one who normally does. The name is
 * kept because the whole controller reads in terms of it.
 */
function isReviewer(req) {
  return hasRole(req.user, 'centerhead', 'admin', 'socialworker');
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * True for a JSON object, and false for `null`, an array and every scalar.
 *
 * `JSON.stringify` accepts anything, so a caller sending a string where an
 * object is expected used to store a JSON scalar that `asObject` then read back
 * as `{}` — silently wiping every field of the identifying block.
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return String(value ?? '').trim();
}

/** `2026-06-01` from either a string or a Date. */
function isoDate(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

/** Age on a given date, in whole years. `calculateAge` only handles "today". */
function ageAt(birthDate, atDate) {
  const birth = isoDate(birthDate);
  const at = isoDate(atDate);
  if (!birth || !at) return null;
  const [by, bm, bd] = birth.split('-').map(Number);
  const [ay, am, ad] = at.split('-').map(Number);
  if (!by || !bm || !bd || !ay || !am || !ad) return null;
  let age = ay - by;
  if (am < bm || (am === bm && ad < bd)) age -= 1;
  return age >= 0 ? age : null;
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Builds one calendar-quarter window that begins in `startMonth`. */
function periodFor(year, startMonth) {
  const endMonth = startMonth + 2;
  const periodStart = `${year}-${pad2(startMonth)}-01`;
  const periodEnd = `${year}-${pad2(endMonth)}-${pad2(lastDayOfMonth(year, endMonth))}`;
  const quarter = Math.floor((startMonth - 1) / 3) + 1;
  const quarterLabel = `Q${quarter} ${year}`;
  return {
    periodStart,
    periodEnd,
    quarter,
    year,
    label: quarterLabel,
    headerLabel: quarterLabel,
  };
}

/** Every selectable period for a year, in the facility's own order. */
function periodsForYear(year) {
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear) || numericYear < 2000 || numericYear > 2100) {
    throw new ApiError(400, 'A valid year is required.');
  }
  return PERIOD_START_MONTHS.map((month) => periodFor(numericYear, month));
}

/** The calendar quarter containing `date`. */
function periodForDate(date = new Date()) {
  const at = isoDate(date) || isoDate(new Date());
  const year = Number(at.slice(0, 4));
  const candidates = [];
  for (const candidateYear of [year - 1, year, year + 1]) {
    for (const month of PERIOD_START_MONTHS) candidates.push(periodFor(candidateYear, month));
  }
  candidates.sort((a, b) => a.periodStart.localeCompare(b.periodStart));

  const containing = candidates.find((p) => at >= p.periodStart && at <= p.periodEnd);
  if (containing) return containing;

  // Unreachable while the periods tile the calendar, but never return a period
  // that has not begun: the caller uses this as the "current period" default.
  const started = candidates.filter((p) => p.periodStart <= at);
  return started.length ? started[started.length - 1] : periodFor(year, 1);
}

function monthLabel(isoValue) {
  const value = isoDate(isoValue);
  const month = Number(value.slice(5, 7));
  const year = value.slice(0, 4);
  const name = MONTH_NAMES[month - 1];
  return name && year ? `${name} ${year}` : value;
}

/**
 * Turns a block of free text into bullet lines.
 *
 * The Anecdotal Report's aspect fields are multi-line prose. Splitting them keeps
 * the assembled draft in the same shape the official form uses (a list of
 * dashes), and makes each line individually droppable in the editor.
 */
function toBulletLines(value) {
  return text(value)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
}

/**
 * De-duplicates bullet lines case-insensitively, keeping the first occurrence.
 *
 * A Houseparent who writes the same sentence in June, July and August should not
 * see it three times in the quarterly roll-up. Only exact repeats are dropped —
 * near-duplicates are left for the staff member to merge, because deciding that
 * two differently-worded observations mean the same thing is a judgement call.
 */
function dedupeLines(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const key = line.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/** Formats the assembled draft as the `- ` list the form uses. */
function bullets(lines) {
  return dedupeLines(lines).map((line) => `- ${line}`).join('\n');
}

// ── IDENTIFYING INFORMATION ─────────────────────────────────────────────────

/**
 * Resolves every field the form's IDENTIFYING INFORMATION block asks for.
 *
 * Each value carries its origin in a sibling `_sources` map. That is what lets
 * the UI distinguish "the record genuinely says nothing here" from "we never
 * found a source for this field" — the two need different follow-up from staff,
 * and the user asked for missing fields to be flagged rather than filled with an
 * invented default.
 *
 * `children.age` is deliberately not used: it is written once at admission and
 * goes stale, so the age is computed from `birthDate` as at the end of the
 * period instead.
 *
 * @param {string} residentId
 * @param {string} periodEnd the date to compute age as at.
 * @returns {Promise<Object>} flat field map plus `_sources`.
 */
async function buildIdentifyingInformation(residentId, periodEnd) {
  const [[child]] = await pool.query('SELECT * FROM children WHERE id = ?', [residentId]);
  if (!child) throw new ApiError(404, 'Resident not found');

  // The most recent admission is the authority for sex, religion and the
  // addresses — `children` does not carry sex or religion at all.
  const [admissions] = await pool.query(
    'SELECT * FROM admissions WHERE residentId = ? ORDER BY admissionDate DESC, createdAt DESC LIMIT 1',
    [residentId]
  );
  const admission = admissions[0] || null;

  // Education is optional; a resident who is not enrolled has no row, and the
  // form's fields stay blank rather than being guessed.
  let education = null;
  try {
    const [rows] = await pool.query(
      "SELECT * FROM education_records WHERE residentId = ? ORDER BY (status = 'Active') DESC, createdAt DESC LIMIT 1",
      [residentId]
    );
    education = rows[0] || null;
  } catch {
    education = null;
  }

  const sources = {};
  const field = (key, value, source) => {
    sources[key] = source;
    return text(value);
  };

  const age = ageAt(child.birthDate, periodEnd);

  const info = {
    childName: field('childName', child.name, 'children.name'),
    sex: admission
      ? field('sex', admission.sex, 'admissions.sex')
      : field('sex', child.gender, 'children.gender'),
    age: age === null ? field('age', '', 'computed from children.birthDate') : field('age', String(age), `computed from children.birthDate at ${periodEnd}`),
    birthDate: field('birthDate', isoDate(child.birthDate), 'children.birthDate'),
    religion: field('religion', admission?.religion, 'admissions.religion'),
    educationalAttainment: education
      ? field('educationalAttainment', education.educationLevel, 'education_records.educationLevel')
      : field('educationalAttainment', '', 'not on file'),
    schoolAttended: education
      ? field('schoolAttended', education.school, 'education_records.school')
      : field('schoolAttended', '', 'not on file'),
    schoolAddress: education
      ? field('schoolAddress', education.address, 'education_records.address')
      : field('schoolAddress', '', 'not on file'),
    permanentAddress: admission?.address
      ? field('permanentAddress', admission.address, 'admissions.address')
      : field('permanentAddress', child.address, 'children.address'),
    // The resident lives at the facility, so the form's "Present Address" is the
    // facility's own address. The reference document shows exactly this.
    presentAddress: field('presentAddress', FACILITY_ADDRESS, 'facility address'),
    dateOfAdmission: field('dateOfAdmission', isoDate(child.admissionDate || admission?.admissionDate), 'children.admissionDate'),
    ageUponAdmission: field('ageUponAdmission', admission?.age, 'admissions.age'),
    guardian: child.guardianName
      ? field('guardian', child.guardianName, 'children.guardianName')
      : field('guardian', admission?.guardianName, 'admissions.guardianName'),
    contactNumber: child.guardianContact
      ? field('contactNumber', child.guardianContact, 'children.guardianContact')
      : field('contactNumber', admission?.guardianContact, 'admissions.guardianContact'),
    caseType: field('caseType', child.caseType, 'children.caseType'),
    caseStatus: field('caseStatus', child.status, 'children.status'),
  };

  info._sources = sources;
  return info;
}

// ── ASSEMBLY ────────────────────────────────────────────────────────────────

/**
 * Reads everything the period holds for one resident.
 *
 * Fetched in one pass and grouped afterwards rather than issuing a query per
 * aspect: six aspects times six sources would be 36 round trips for one report,
 * and the tables involved are small per resident.
 */
async function loadPeriodRecords(residentId, periodStart, periodEnd) {
  const [anecdotal] = await pool.query(
    'SELECT * FROM anecdotalReports WHERE residentId = ? AND reportDate BETWEEN ? AND ? ORDER BY reportDate ASC',
    [residentId, periodStart, periodEnd]
  );
  const [activities] = await pool.query(
    'SELECT * FROM activities WHERE date BETWEEN ? AND ? ORDER BY date ASC',
    [periodStart, periodEnd]
  );
  const [incidents] = await pool.query(
    'SELECT * FROM incidentReports WHERE residentId = ? AND DATE(incidentDateTime) BETWEEN ? AND ? ORDER BY incidentDateTime ASC',
    [residentId, periodStart, periodEnd]
  );
  const [health] = await pool.query(
    "SELECT * FROM healthRecords WHERE residentId = ? AND recordType = 'Height & Weight Monitoring' ORDER BY date ASC",
    [residentId]
  );
  const [educationReports] = await pool.query(
    'SELECT * FROM education_progress_reports WHERE residentId = ? ORDER BY month ASC',
    [residentId]
  ).catch(() => [[]]);
  const [schoolVisits] = await pool.query(
    'SELECT * FROM education_school_visits WHERE residentId = ? AND visitDate BETWEEN ? AND ? ORDER BY visitDate ASC',
    [residentId, periodStart, periodEnd]
  ).catch(() => [[]]);
  const [interventions] = await pool.query(
    'SELECT * FROM intervention_tracker WHERE residentId = ? ORDER BY startDate ASC',
    [residentId]
  );

  return {
    anecdotal,
    // `selectedResidentIds` is a JSON column, so membership is tested in JS
    // rather than in SQL. The period's activity list is small.
    activities: activities.filter((a) => asArray(a.selectedResidentIds).map(String).includes(String(residentId))),
    incidents,
    health,
    educationReports: educationReports.filter((r) => {
      const month = text(r.month);
      return month >= periodStart.slice(0, 7) && month <= periodEnd.slice(0, 7);
    }),
    schoolVisits,
    interventions: interventions.filter((row) => {
      const start = isoDate(row.startDate);
      if (!start) return false;
      const end = isoDate(row.completionDate) || periodEnd;
      return start <= periodEnd && end >= periodStart;
    }),
  };
}

/**
 * Builds the Physical aspect's measurement bullets from Form 11-A.
 *
 * The reference form shows the shape this reproduces:
 *   "-Improvement in weight: from 42.75 kg. (admission) to 45.35 kg. as per update"
 *
 * "Admission" is the earliest measurement on record across every Form 11-A the
 * resident has, and "as per update" is the last measurement inside the period.
 * Where no measurement exists inside the period, the latest on record is used so
 * the line is still true, and where there is only one measurement in total the
 * delta line is skipped rather than printing a comparison of a value with
 * itself.
 */
function healthMeasurementLines(healthRecords, periodStart, periodEnd) {
  const points = [];
  for (const record of healthRecords || []) {
    const details = asObject(record.details);
    const year = Number(details.monitoringYear) || Number(isoDate(record.date).slice(0, 4));
    for (const entry of asArray(details.monthlyMeasurements)) {
      const month = Number(entry?.month);
      if (!year || !month || month < 1 || month > 12) continue;

      // Form 11-A is a twelve-row grid and Health.tsx stores every row, filling
      // the untouched ones with empty strings. `Number('')` is 0 — which is
      // finite, so a naive check treats an empty month as a real measurement of
      // zero. An untouched row is not a measurement and must not be pushed: if
      // it is, January becomes the baseline, `baseline.weight` is null, and the
      // weight and height lines are skipped for every resident who has one.
      const rawHeight = Number(entry.height);
      const rawWeight = Number(entry.weight);
      const height = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : null;
      const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : null;
      if (height === null && weight === null) continue;

      points.push({ iso: `${year}-${pad2(month)}-01`, height, weight });
    }
  }
  if (!points.length) return [];

  points.sort((a, b) => a.iso.localeCompare(b.iso));
  const inPeriod = points.filter((p) => p.iso >= periodStart && p.iso <= periodEnd);
  const baseline = points[0];
  const latest = inPeriod.length ? inPeriod[inPeriod.length - 1] : points[points.length - 1];

  const lines = [];
  const round = (value) => Number(value.toFixed(2));
  const bmi = (point) => (point.height && point.weight
    ? round(point.weight / ((point.height / 100) ** 2))
    : null);

  if (baseline.weight && latest.weight && baseline !== latest && baseline.weight !== latest.weight) {
    lines.push(`Improvement in weight: from ${round(baseline.weight)} kg. (admission) to ${round(latest.weight)} kg. as per update`);
  }
  if (baseline.height && latest.height && baseline !== latest && baseline.height !== latest.height) {
    lines.push(`Improvement in height: from ${round(baseline.height)} cm (admission) to ${round(latest.height)} cm as per update`);
  }
  const bmiBaseline = bmi(baseline);
  const bmiLatest = bmi(latest);
  // Same rule as the two lines above: a comparison of a value with itself is not
  // progress. Without this guard a resident with a single measurement on file was
  // told "Normal BMI from admission (20) up to present (20)."
  if (bmiBaseline !== null && bmiLatest !== null && bmiBaseline !== bmiLatest) {
    const descriptor = bmiLatest >= 18.5 && bmiLatest < 25 ? 'Normal' : bmiLatest < 18.5 ? 'Below normal' : 'Above normal';
    lines.push(`${descriptor} BMI from admission (${bmiBaseline}) up to present (${bmiLatest}).`);
  }
  return lines;
}

/** One bullet per incident report, naming the subject and its month. */
function incidentLines(incidents) {
  return (incidents || []).map((row) => {
    const types = asArray(row.reportTypes).map(text).filter(Boolean);
    const subject = types.length ? types.join(', ') : text(row.summary).slice(0, 80) || 'an incident';
    return `Had an Incident Report regarding involvement in ${subject} - ${monthLabel(row.incidentDateTime)}`;
  });
}

/** One bullet per activity the child joined, in the aspect's own categories. */
function activityLines(activities, categories) {
  return (activities || [])
    .filter((row) => categories.includes(text(row.category)))
    .map((row) => `Involvement in ${text(row.title)} - ${monthLabel(row.date)}`);
}

/**
 * Assembles the draft for one aspect.
 *
 * The `observations` column collects what was seen; the `interventions` column
 * collects what was done about it. Activities appear in the interventions column
 * because a programme the child attended *is* the intervention — the same
 * activity also carries evidence of participation, which is why the reference
 * form's productivity row names its activities under observations.
 */
function assembleAspect(aspect, records) {
  const config = ASPECT_SOURCES[aspect.key] || {};
  const observations = [];
  const interventions = [];

  // 1. The Houseparent's monthly narrative for this aspect, already written.
  for (const report of records.anecdotal) {
    const content = asObject(report.content);
    observations.push(...toBulletLines(content[config.anecdotalKey]));
  }

  // 2. Physical measurement deltas, from Form 11-A.
  if (config.health) {
    observations.push(...healthMeasurementLines(records.health, records.periodStart, records.periodEnd));
  }

  // 3. Behavioural evidence, dated.
  if (config.incidents) {
    observations.push(...incidentLines(records.incidents));
  }

  // 4. Educational evidence, from the Education module's own records.
  if (config.education) {
    for (const row of records.educationReports) {
      observations.push(...toBulletLines([row.academicProgress, row.participation, row.strengths].filter(Boolean).join('\n')));
    }
    for (const visit of records.schoolVisits) {
      const findings = toBulletLines(visit.findings);
      observations.push(...findings.map((line) => `${line} (school visit, ${monthLabel(visit.visitDate)})`));
    }
  }

  // 5. Programmes attended become the rendered interventions.
  const joined = activityLines(records.activities, config.activityCategories || []);
  interventions.push(...joined);

  // 6. Formal interventions recorded against violations, where they touch this
  //    aspect. Behavioural and emotional work is where these land in practice.
  if (config.incidents || aspect.key === 'emotional') {
    for (const row of records.interventions) {
      const label = text(row.interventionType);
      if (label) interventions.push(label);
    }
  }

  // The productivity aspect also shows what the child actually did, not only
  // what was arranged for them.
  if (aspect.key === 'economicProductivity') {
    observations.push(...joined);
  }

  return {
    assembledPresentLevel: '',
    assembledObservations: bullets(observations),
    assembledInterventions: bullets(interventions),
  };
}

/**
 * Produces the six assembled sections for a period.
 * Exported so the assembly rules can be unit-tested without HTTP.
 */
async function assembleSections(residentId, periodStart, periodEnd) {
  const records = await loadPeriodRecords(residentId, periodStart, periodEnd);
  records.periodStart = periodStart;
  records.periodEnd = periodEnd;
  return ASPECTS.map((aspect, index) => {
    const assembled = assembleAspect(aspect, records);
    return {
      aspectKey: aspect.key,
      aspectLabel: aspect.label,
      sortOrder: index,
      ...assembled,
      // The curated text starts as the assembled draft. The staff member edits
      // from there, so "accept everything" is the default and every change is a
      // deliberate act rather than a retyping exercise.
      presentLevel: '',
      observations: assembled.assembledObservations,
      interventions: assembled.assembledInterventions,
      status: 'Not Started',
    };
  });
}

// ── MAPPERS ─────────────────────────────────────────────────────────────────

function mapSection(row) {
  return row ? { ...row } : null;
}

/**
 * Whether an aspect holds anything the report can print.
 *
 * This replaced the per-aspect "submitted" flag. There is no per-aspect sign-off
 * any more — one Social Worker owns the whole report — so an aspect is either
 * written or it is not, and that is all the completeness gate needs to know.
 */
function sectionHasContent(section) {
  return Boolean(
    text(section?.presentLevel) || text(section?.observations) || text(section?.interventions)
  );
}

/**
 * Ships the caller's capabilities for one aspect, so the UI renders exactly what
 * the server will allow.
 *
 * Computing this on the server is deliberate: the equivalent client-side rule
 * would be a fourth copy of the permission model to keep in step with the
 * backend, and the three-copy document permission map in this codebase has
 * already drifted once.
 *
 * There is no owner any more. Every aspect is editable by anyone who may prepare
 * the report, which is the point of the change: the Social Worker completes all
 * six instead of each one being locked to whoever it was assigned to.
 */
function decorateSection(req, section, report) {
  if (!section) return null;
  const finalized = report?.status === 'Finalized';
  const mayPrepare = isReviewer(req);
  return {
    ...mapSection(section),
    canEdit: mayPrepare && !finalized,
    hasContent: sectionHasContent(section),
  };
}

function summarizeSections(sections) {
  const list = sections || [];
  return { sectionsTotal: list.length, sectionsComplete: list.filter(sectionHasContent).length };
}

/** Aspects with nothing written in them at all. */
function incompleteSections(sections) {
  return (sections || []).filter((s) => !sectionHasContent(s));
}

function mapReport(req, row, sections) {
  if (!row) return null;
  const mayPrepare = isReviewer(req);
  const list = sections || [];
  return {
    ...row,
    isReviewer: mayPrepare,
    canEditReport: mayPrepare && row.status !== 'Finalized',
    // Nothing to approve: whoever prepares the report completes it. The only
    // precondition is that no aspect was left blank.
    canFinalize: mayPrepare && row.status !== 'Finalized' && incompleteSections(list).length === 0,
    canDelete: mayPrepare && row.status !== 'Finalized',
    ...summarizeSections(list),
  };
}

// ── PUBLISHING ──────────────────────────────────────────────────────────────

/**
 * Publishes the combined PDF into the resident's Documents folder.
 *
 * Mirrors the Anecdotal Report's pattern: linked by a dedicated nullable column
 * with a unique index, so re-publishing updates the same entry instead of
 * leaving two copies of one period. Publishing happens *before* the report's
 * status flips to Finalized, so a failure leaves the report still open rather
 * than finalized with no document.
 */
async function syncDocumentForReport(report, sections, actorName, { create = true } = {}) {
  const [[child]] = await pool.query('SELECT name FROM children WHERE id = ?', [report.residentId]);
  const period = text(report.periodLabel) || periodRangeLabel(report.periodStart, report.periodEnd);
  const title = `Quarterly Progress Report - ${period || 'Period not set'}`;
  const description = (sections || [])
    .filter((s) => text(s.presentLevel) || text(s.observations) || text(s.interventions))
    .map((s) => `${s.aspectLabel}: ${text(s.presentLevel) || 'no rating'}`)
    .join('\n');

  const { buffer, fileName, fileSize } = await buildQuarterlyReportDocument(report, sections, child?.name);
  const fileData = buffer.toString('base64');

  const [existing] = await pool.query('SELECT id FROM documents WHERE quarterlyReportId = ? LIMIT 1', [report.id]);
  // Who submitted the report, not who finalized it: the Documents module shows
  // "Submitted By" per file. Falls back to the preparer, then to the actor.
  const submittedBy = text(report.submittedBy) || text(report.preparedByName) || actorName;
  // Published as Approved, so it carries its own approval: `approvedBy` /
  // `approvedAt` are what the Documents module prints under "Approved By" and
  // "Approval Date". The report is finalized *after* this runs, so the actor is
  // the reviewer finalizing it.
  const approver = text(report.finalizedBy) || actorName;
  const reviewer = text(report.reviewedBy) || approver;
  if (existing.length) {
    await pool.query(
      `UPDATE documents SET title = ?, description = ?, residentName = ?, fileName = ?, fileSize = ?, fileType = ?, fileData = ?, documentCategory = ?,
       approvedBy = ?, approvedAt = NOW(), reviewedBy = ?, reviewedAt = NOW(),
       submittedBy = ?, modifiedBy = ? WHERE id = ?`,
      [title, description, child?.name || null, fileName, fileSize, 'application/pdf', fileData, QUARTERLY_FOLDER,
        approver, reviewer, submittedBy, actorName, existing[0].id]
    );
    return existing[0].id;
  }
  if (!create) return null;
  // Filed under the admission the resident is currently in, so a QPR written
  // after a re-intake never lands in an earlier admission's folder.
  const admissionId = await activeAdmissionIdFor(pool, report.residentId);
  return insertWithGeneratedId(pool, {
    table: 'documents',
    prefix: 'DOC',
    insert: (id) => pool.query(
      `INSERT INTO documents (id, residentId, admissionId, residentName, title, type, category, documentCategory, description, fileName, fileSize, fileType, fileData, status, submittedBy, uploadedBy, uploadedAt, approvedBy, approvedAt, reviewedBy, reviewedAt, quarterlyReportId, createdBy, modifiedBy)
       VALUES (?, ?, ?, ?, ?, 'Quarterly Progress Report', 'Progress Report', ?, ?, ?, ?, 'application/pdf', ?, 'Approved', ?, ?, NOW(), ?, NOW(), ?, NOW(), ?, ?, ?)`,
      [id, report.residentId, admissionId, child?.name || null, title, QUARTERLY_FOLDER, description, fileName, fileSize, fileData,
        submittedBy, actorName, approver, reviewer, report.id, actorName, actorName]
    ),
  });
}

async function unpublishDocumentForReport(reportId) {
  const [existing] = await pool.query('SELECT id FROM documents WHERE quarterlyReportId = ?', [reportId]);
  if (!existing.length) return 0;
  await pool.query('DELETE FROM documents WHERE quarterlyReportId = ?', [reportId]);
  return existing.length;
}

// ── LOADERS ─────────────────────────────────────────────────────────────────

async function getSections(reportId) {
  const [rows] = await pool.query(
    'SELECT * FROM quarterlyProgressReportSections WHERE reportId = ? ORDER BY sortOrder ASC, aspectKey ASC',
    [reportId]
  );
  return rows;
}

async function getReport(reportId) {
  // Every report-scoped endpoint starts here, so this is the one place the
  // tables have to be guaranteed. `ensureTables` is idempotent (it checks a
  // process-level flag), so calling it per request costs nothing.
  await ensureTables();
  const [rows] = await pool.query('SELECT * FROM quarterlyProgressReports WHERE id = ?', [reportId]);
  if (!rows[0]) throw new ApiError(404, 'Quarterly Progress Report not found');
  return rows[0];
}

/**
 * Who may open a report at all.
 *
 * Reports used to be shared out aspect by aspect, so a non-reviewer reached one
 * through the section assigned to them. Assignment is gone: the Social Worker
 * prepares the whole report, so preparing one *is* the permission, and anyone
 * else is refused rather than shown a filtered view of somebody else's work.
 */
function assertResidentAccess(req, report, sections) {
  if (isReviewer(req)) return;
  throw new ApiError(403, 'Only the Social Worker or Center Head can open a Quarterly Progress Report.');
}

// ── ENDPOINTS ───────────────────────────────────────────────────────────────

/** GET /quarterly-progress-reports — the reports the caller may see. */
async function list(req, res, next) {
  try {
    await ensureTables();
    const reviewer = isReviewer(req);

    // A non-reviewer has no reports to see. There is no per-aspect assignment to
    // match on any more, so the old "reports where a section is assigned to me"
    // query has nothing left to look for and would only ever return an empty set
    // at the cost of a correlated subquery.
    const [rows] = reviewer
      ? await pool.query('SELECT * FROM quarterlyProgressReports ORDER BY periodStart DESC, updatedAt DESC LIMIT 300')
      : [[]];

    let sections = [];
    if (rows.length) {
      [sections] = await pool.query(
        `SELECT * FROM quarterlyProgressReportSections WHERE reportId IN (${rows.map(() => '?').join(', ')}) ORDER BY sortOrder ASC`,
        rows.map((r) => r.id)
      );
    }
    const byReport = new Map();
    for (const section of sections) {
      if (!byReport.has(section.reportId)) byReport.set(section.reportId, []);
      byReport.get(section.reportId).push(section);
    }

    res.json({
      success: true,
      // `canOpenReport` is the caller's capability, shipped alongside the list so
      // the UI does not render an "Open a Progress Report" button whose only
      // outcome would be a 403.
      canOpenReport: reviewer,
      data: rows.map((row) => mapReport(req, row, byReport.get(row.id) || [])),
    });
  } catch (error) {
    next(error);
  }
}

/** GET /quarterly-progress-reports/periods?year= — the picker's options. */
async function listPeriods(req, res, next) {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    res.json({ success: true, data: periodsForYear(year), current: periodForDate() });
  } catch (error) {
    next(error);
  }
}

/** GET /quarterly-progress-reports/:id — one report, in full. */
async function getById(req, res, next) {
  try {
    await ensureTables();
    const report = await getReport(req.params.id);
    const all = await getSections(report.id);
    assertResidentAccess(req, report, all);

    // Every aspect, always. `assertResidentAccess` has already refused anyone who
    // may not prepare the report, so there is no longer a per-caller subset to
    // compute — the Social Worker needs all six to write the report.
    res.json({
      success: true,
      data: {
        ...mapReport(req, report, all),
        sections: all.map((section) => decorateSection(req, section, report)),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /quarterly-progress-reports/identifying/:residentId?periodStart=&periodEnd=
 *
 * The live identifying block, for previewing before a report exists. The report
 * itself stores its own snapshot, so this is a preview and not the source of
 * truth once a report has been opened.
 */
async function identifyingFor(req, res, next) {
  try {
    const { residentId } = req.params;
    const periodEnd = isoDate(req.query.periodEnd) || new Date().toISOString().slice(0, 10);
    res.json({ success: true, data: await buildIdentifyingInformation(residentId, periodEnd) });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /quarterly-progress-reports — open a report for a resident and period.
 *
 * This is where the assembly happens. Opening the same resident and period twice
 * returns the existing report untouched rather than re-assembling: that is what
 * makes the draft a snapshot, and it is why an aspect someone has already edited
 * cannot be overwritten by a record added later.
 */
async function create(req, res, next) {
  try {
    await ensureTables();
    const { residentId, periodStart, periodEnd } = req.body || {};
    if (!residentId) throw new ApiError(400, 'residentId is required');

    const start = isoDate(periodStart);
    const end = isoDate(periodEnd);
    if (!start || !end) throw new ApiError(400, 'periodStart and periodEnd are required.');
    if (start > end) throw new ApiError(400, 'periodStart must not be after periodEnd.');

    // A QPR is uniquely identified by resident + calendar quarter + year.
    // Require the canonical quarter boundaries so an arbitrary three-month
    // window cannot create a second report for the same quarter.
    const requestedYear = Number(start.slice(0, 4));
    const requestedMonth = Number(start.slice(5, 7));
    if (![1, 4, 7, 10].includes(requestedMonth)) {
      throw new ApiError(400, 'Quarterly Progress Report must start on the first month of Q1, Q2, Q3, or Q4.');
    }
    const canonicalPeriod = periodFor(requestedYear, requestedMonth);
    if (canonicalPeriod.periodStart !== start || canonicalPeriod.periodEnd !== end) {
      throw new ApiError(400, 'Quarterly Progress Report period must match a complete calendar quarter.');
    }

    const [existing] = await pool.query(
      'SELECT id FROM quarterlyProgressReports WHERE residentId = ? AND periodStart = ? LIMIT 1',
      [residentId, start]
    );
    if (existing.length) {
      const report = await getReport(existing[0].id);
      const all = await getSections(report.id);
      assertResidentAccess(req, report, all);
      return res.json({
        success: true,
        created: false,
        data: { ...mapReport(req, report, all), sections: all.map((s) => decorateSection(req, s, report)) },
        message: 'A report for this resident and period is already open.',
      });
    }

    // Reviewers open reports for anyone; an assignee cannot create one.
    if (!isReviewer(req)) {
      throw new ApiError(403, 'Only a Social Worker or Center Head can open a Quarterly Progress Report.');
    }

    const [[child]] = await pool.query('SELECT id, name FROM children WHERE id = ?', [residentId]);
    if (!child) throw new ApiError(404, 'Resident not found');

    const identifying = await buildIdentifyingInformation(residentId, end);
    // The identifying block above is auto-filled from the resident's records.
    // The six aspect narratives start empty on purpose: the facility asked for
    // the Social Worker to write them rather than curate a machine draft, so the
    // evidence queries in `assembleSections` are kept and tested but not called
    // here. The `assembled*` columns stay blank alongside them.
    const blankSections = ASPECTS.map((aspect, index) => ({
      aspectKey: aspect.key,
      aspectLabel: aspect.label,
      sortOrder: index,
      assembledPresentLevel: '',
      assembledObservations: '',
      assembledInterventions: '',
      presentLevel: '',
      observations: '',
      interventions: '',
      status: 'Not Started',
    }));
    const quarter = Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1;
    const label = `Q${quarter} ${requestedYear}`;
    const actorName = actor(req);
    // Whoever opens the report is its preparer until somebody else signs it, so
    // the signature line starts out holding their name rather than blank. The
    // PDF would otherwise print an empty "Prepared by:" rule even though the
    // system knows exactly who opened it.
    const preparedByName = await actorDisplayName(req);

    const reportId = await runInTransactionWithIdRetry(pool, async (connection) => {
      const newId = await insertWithGeneratedId(connection, {
        table: 'quarterlyProgressReports',
        prefix: 'QPR',
        insert: (id) => connection.query(
          `INSERT INTO quarterlyProgressReports
             (id, residentId, periodStart, periodEnd, periodLabel, identifyingInformation, preparedByName, status, createdBy, updatedBy)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?)`,
          [id, residentId, start, end, label, JSON.stringify(identifying), preparedByName, actorName, actorName]
        ),
      });
      for (const section of blankSections) {
        await insertWithGeneratedId(connection, {
          table: 'quarterlyProgressReportSections',
          prefix: 'QRS',
          insert: (id) => connection.query(
            `INSERT INTO quarterlyProgressReportSections
               (id, reportId, aspectKey, aspectLabel, sortOrder, assembledPresentLevel, assembledObservations, assembledInterventions,
                presentLevel, observations, interventions, status, createdBy, updatedBy)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id, newId, section.aspectKey, section.aspectLabel, section.sortOrder,
              section.assembledPresentLevel, section.assembledObservations, section.assembledInterventions,
              section.presentLevel, section.observations, section.interventions, section.status,
              actorName, actorName,
            ]
          ),
        });
      }
      return newId;
    });

    const report = await getReport(reportId);
    const sections = await getSections(reportId);
    res.status(201).json({
      success: true,
      created: true,
      data: { ...mapReport(req, report, sections), sections: sections.map((s) => decorateSection(req, s, report)) },
      message: 'Report opened. Identifying information was filled in from the resident\u2019s records; write the six aspects and finalize.',
    });
  } catch (error) {
    next(error);
  }
}

/** PUT /quarterly-progress-reports/:id — edit the header. Reviewers only. */
async function update(req, res, next) {
  try {
    const report = await getReport(req.params.id);
    if (!isReviewer(req)) throw new ApiError(403, 'Only a reviewer can edit the report header.');
    if (report.status === 'Finalized') throw new ApiError(409, 'A finalized report cannot be edited.');

    const { periodLabel, identifyingInformation } = req.body || {};
    if (identifyingInformation !== undefined && !isPlainObject(identifyingInformation)) {
      throw new ApiError(400, 'identifyingInformation must be an object.');
    }
    await pool.query(
      'UPDATE quarterlyProgressReports SET periodLabel = ?, identifyingInformation = ?, updatedBy = ? WHERE id = ?',
      [
        periodLabel === undefined ? report.periodLabel : text(periodLabel),
        identifyingInformation === undefined ? JSON.stringify(asObject(report.identifyingInformation)) : JSON.stringify(identifyingInformation),
        actor(req),
        report.id,
      ]
    );
    const updated = await getReport(report.id);
    const sections = await getSections(report.id);
    res.json({ success: true, data: { ...mapReport(req, updated, sections), sections: sections.map((s) => decorateSection(req, s, updated)) } });
  } catch (error) {
    next(error);
  }
}

/** DELETE /quarterly-progress-reports/:id — reviewers only, never if finalized. */
async function remove(req, res, next) {
  try {
    const report = await getReport(req.params.id);
    if (!isReviewer(req)) throw new ApiError(403, 'Only a reviewer can delete a report.');
    if (report.status === 'Finalized') throw new ApiError(409, 'A finalized report cannot be deleted.');
    await unpublishDocumentForReport(report.id);
    await pool.query('DELETE FROM quarterlyProgressReports WHERE id = ?', [report.id]);
    res.json({ success: true, message: 'Report deleted.' });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /quarterly-progress-reports/:id/sections/:sectionId — save an aspect.
 *
 * One rule, and it is the whole feature: whoever prepares the report may write
 * any aspect of it, and only while the report is not finalized.
 *
 * This used to be narrower — a non-reviewer could write only their own aspect,
 * and only before submitting it, so a submitted aspect needed a reviewer to
 * return it before a typo could be fixed. With one Social Worker preparing all
 * six aspects that ceremony bought nothing: the person who would return the
 * aspect was the person who wrote it.
 */
async function updateSection(req, res, next) {
  try {
    const report = await getReport(req.params.id);
    if (!isReviewer(req)) throw new ApiError(403, 'Only the Social Worker or Center Head can edit a Quarterly Progress Report.');
    if (report.status === 'Finalized') throw new ApiError(409, 'A finalized report cannot be edited.');

    const [rows] = await pool.query(
      'SELECT * FROM quarterlyProgressReportSections WHERE id = ? AND reportId = ? LIMIT 1',
      [req.params.sectionId, report.id]
    );
    const section = rows[0];
    if (!section) throw new ApiError(404, 'That aspect is not part of this report.');

    const { presentLevel, observations, interventions, signature, signedByName } = req.body || {};
    const nextPresentLevel = presentLevel === undefined ? section.presentLevel : text(presentLevel);
    const nextObservations = observations === undefined ? section.observations : String(observations ?? '');
    const nextInterventions = interventions === undefined ? section.interventions : String(interventions ?? '');

    // Any first write takes the aspect out of "Not Started". Without this the
    // badge kept saying "Not Started" for an aspect that already held a full
    // draft, so a reader could not tell it from a blank one.
    const touched = text(nextPresentLevel) || text(nextObservations) || text(nextInterventions);
    const nextStatus = touched && section.status === 'Not Started' ? 'In Progress' : section.status;

    await pool.query(
      `UPDATE quarterlyProgressReportSections
          SET presentLevel = ?, observations = ?, interventions = ?,
              signature = COALESCE(?, signature), signedByName = COALESCE(?, signedByName),
              status = ?, updatedBy = ?
        WHERE id = ?`,
      [
        nextPresentLevel, nextObservations, nextInterventions,
        signature === undefined ? null : signature,
        signedByName === undefined ? null : text(signedByName),
        nextStatus,
        actor(req),
        section.id,
      ]
    );

    const updated = await getReport(report.id);
    const fresh = await getSections(report.id);
    res.json({ success: true, data: { ...mapReport(req, updated, fresh), sections: fresh.map((s) => decorateSection(req, s, updated)) } });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /quarterly-progress-reports/:id/signatures
 *
 * Body: `{ preparedBy: { name, signature } }`.
 *
 * One electronic signature remains — the person who prepared the report. The
 * section sign-off block and the Attested by / Noted by slots were removed, so
 * older multi-slot payloads are accepted but only `preparedBy` is stored: a
 * stale client cannot resurrect the removed blocks.
 *
 * The name defaults to the caller's account display name — what Account
 * Management holds, e.g. "Social Worker" — and only falls back to their login
 * name if no display name was configured. That is what "whoever prepares it
 * signs it" means in practice: a Social Worker and a Center Head both prepare
 * reports here, and each signs their own.
 */
async function signReport(req, res, next) {
  try {
    const report = await getReport(req.params.id);
    if (!isReviewer(req)) throw new ApiError(403, 'Only the Social Worker or Center Head can sign the report.');
    if (report.status === 'Finalized') throw new ApiError(409, 'A finalized report cannot be changed.');

    const preparedBy = req.body?.preparedBy;
    if (preparedBy) {
      // An explicit name wins (the client shows the field, so the user can
      // correct a misspelt display name); otherwise the account's own name.
      const name = text(preparedBy.name) || await actorDisplayName(req);
      await pool.query(
        `UPDATE quarterlyProgressReports
            SET preparedByName = ?, preparedBySignature = ?
          WHERE id = ?`,
        [
          name,
          preparedBy.signature ?? report.preparedBySignature ?? null,
          report.id,
        ]
      );
    }

    const updated = await getReport(report.id);
    const sections = await getSections(report.id);
    res.json({ success: true, data: { ...mapReport(req, updated, sections), sections: sections.map((s) => decorateSection(req, s, updated)) } });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /quarterly-progress-reports/:id/finalize
 *
 * Publishes the combined PDF and only then flips the status. Publishing first
 * means a generation failure leaves the report open for another attempt instead
 * of finalized with no document in the resident's folder.
 *
 * This is the only transition out of Draft. There used to be a separate
 * "submit for review" step and a reviewer's "return", but the Social Worker
 * finalizes their own report — the Center Head approves the TRI, not this
 * document — so an intermediate review state had nobody to occupy it.
 */
async function finalize(req, res, next) {
  try {
    const report = await getReport(req.params.id);
    if (!isReviewer(req)) throw new ApiError(403, 'Only the Social Worker or Center Head can finalize a report.');
    if (report.status === 'Finalized') throw new ApiError(409, 'This report is already finalized.');

    const sections = await getSections(report.id);
    const incomplete = incompleteSections(sections);
    if (incomplete.length) {
      throw new ApiError(409, `${incomplete.map((s) => s.aspectLabel).join(', ')} ${incomplete.length === 1 ? 'is' : 'are'} still empty. Fill in every aspect before finalizing.`);
    }

    // The published PDF must name a preparer. A report opened before this was
    // seeded — or one whose signature was never saved — would otherwise print an
    // empty rule under "Prepared by:", so the name is backfilled from the account
    // of whoever is finalizing it.
    let preparedBy = text(report.preparedByName);
    if (!preparedBy) {
      preparedBy = await actorDisplayName(req);
      await pool.query('UPDATE quarterlyProgressReports SET preparedByName = ? WHERE id = ?', [preparedBy, report.id]);
      report.preparedByName = preparedBy;
    }

    await syncDocumentForReport(report, sections, actor(req), { create: true });
    await pool.query(
      "UPDATE quarterlyProgressReports SET status = 'Finalized', finalizedBy = ?, finalizedAt = NOW(), reviewedBy = ?, reviewedAt = NOW(), updatedBy = ? WHERE id = ?",
      [actor(req), actor(req), actor(req), report.id]
    );

    const updated = await getReport(report.id);
    res.json({
      success: true,
      data: { ...mapReport(req, updated, sections), sections: sections.map((s) => decorateSection(req, s, updated)) },
      message: 'Report finalized and published to the resident\u2019s Documents.',
    });
  } catch (error) {
    next(error);
  }
}

/** GET /quarterly-progress-reports/:id/pdf — the combined PDF on demand. */
async function getPdf(req, res, next) {
  try {
    const report = await getReport(req.params.id);
    const all = await getSections(report.id);
    assertResidentAccess(req, report, all);

    const [[child]] = await pool.query('SELECT name FROM children WHERE id = ?', [report.residentId]);
    const { buffer, fileName } = await buildQuarterlyReportDocument(report, all, child?.name);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName.replace(/"/g, '')}"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /quarterly-progress-reports/:id/template — the fill-in form.
 *
 * The report laid out as it will print, with the resident's identifying
 * information already filled in from their records and the six aspect cells left
 * blank. The client renders this and overlays the only fields a person writes:
 * the three narrative columns of each aspect and the signature.
 *
 * `no-store` because the client re-requests it whenever the report is reopened,
 * and a cached form would show the previous resident's details.
 */
async function getTemplate(req, res, next) {
  try {
    const report = await getReport(req.params.id);
    const all = await getSections(report.id);
    assertResidentAccess(req, report, all);

    const [[child]] = await pool.query('SELECT name FROM children WHERE id = ?', [report.residentId]);
    // The signature slot prints the preparer's name. A report opened before the
    // name was seeded would otherwise preview as a blank rule.
    const preparedByName = text(report.preparedByName) || await actorDisplayName(req);
    const buffer = await buildQuarterlyReportTemplatePdf({ ...report, preparedByName }, child?.name);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Quarterly Progress Report (form).pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  // endpoints
  list,
  listPeriods,
  getById,
  identifyingFor,
  create,
  update,
  remove,
  updateSection,
  signReport,
  finalize,
  getPdf,
  getTemplate,
  // exported for tests
  ASPECTS,
  ASPECT_SOURCES,
  REPORT_STATUSES,
  SECTION_STATUSES,
  REVIEWABLE_STATUSES,
  PERIOD_START_MONTHS,
  periodsForYear,
  periodFor,
  periodForDate,
  periodRangeLabel,
  periodHeaderLabel,
  buildIdentifyingInformation,
  assembleSections,
  assembleAspect,
  loadPeriodRecords,
  healthMeasurementLines,
  incidentLines,
  activityLines,
  toBulletLines,
  dedupeLines,
  sectionHasContent,
  incompleteSections,
  decorateSection,
  mapReport,
  ageAt,
  isoDate,
};
