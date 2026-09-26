const { pool } = require('../config/database');
const { activeAdmissionIdFor } = require('../services/admissionLink');
const { insertWithGeneratedId, toMysqlDateTime } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');
const { canAccessResident } = require('./assignmentController');
const { normalizeRole } = require('../utils/authorization');
const notifications = require('../services/notificationService');
// Official TRI scoring thresholds, shared with the PDF writer so the summary block
// cannot be labelled with a different band than the one stored on the record.
const { TRI_SCORING, MAX_TRI_PART_ONE_POINTS, ratingForPoints } = require('../utils/triScoring');
const { buildTriReportDocument, TRI_SIGNATORY_SLOTS, signedLineCount } = require('../utils/triReportPdf');
const { contentDisposition } = require('../utils/contentDisposition');
const { buildRecommendationForTri } = require('./dischargeController');
// Published TRI reports are filed in the TRI Records folder like any other
// document; the folder comes from the routing rules so it cannot drift.
const { folderForType } = require('../utils/documentCategory');

const TRI_TEMPLATE_VERSION = 'TRI-2025-PDF';
const TRI_FOLDER = folderForType('TRI');
const VALID_STATUSES = new Set(['Draft', 'Submitted', 'Under Review', 'Returned', 'For Reassessment', 'Finalized']);

// ─── Page-8 signature storage ────────────────────────────────────────────────
// The page-8 block is stored in `triRecords.signatories` — one JSON entry per slot
// — AND mirrored into the per-line columns the app shipped with. Both stores are
// kept in step: the JSON is what the PDF renderer reads for the four reviewer
// lines, and the columns hold what older records and readers already contain, so
// neither store can go stale and no signature can be lost.
//
// The Houseparent line is the exception, by design: its E-Signature lives in the
// `houseparent*` columns (see `signatorySignatureOf` in utils/triReportPdf.js) and
// the JSON holds only the typed name.
const SIGNATORY_COLUMNS = {
  houseparent: ['houseparentSignature', 'houseparentSignedBy', 'houseparentSignedAt'],
  administrativeOfficer: ['adminOfficerSignature', 'adminOfficerSignedBy', 'adminOfficerSignedAt'],
  caseManager: ['swo1Signature', 'swo1SignedBy', 'swo1SignedAt'],
  centerHead: ['centerheadSignature', 'centerheadSignedBy', 'centerheadSignedAt'],
  sectionChief: ['sectionchiefSignature', 'sectionchiefSignedBy', 'sectionchiefSignedAt'],
};

// The `signatories` slot a signed line writes to, found from the line's own column
// names (the table below is the single source of truth for those, so the two
// cannot drift). Returns null if a line has no mapped slot.
function slotForSignatureLine(line) {
  return Object.keys(SIGNATORY_COLUMNS)
    .find((slot) => SIGNATORY_COLUMNS[slot][0] === line.signature) || null;
}

/**
 * Copy one slot's E-Signature into that line's columns, so the JSON and the
 * columns never drift apart.
 *
 * Only mirrors fields the entry actually carries: an entry that says nothing
 * about `signature` must not blank a column that holds one. A database that
 * predates a column (1054 unknown column / 1060 duplicate column) is tolerated —
 * the JSON is authoritative and the boot migration adds the columns next start.
 */
async function mirrorSignatoryToColumns(recordId, slot, entry, updatedBy) {
  const columns = SIGNATORY_COLUMNS[slot];
  if (!columns || !entry || !('signature' in entry)) return;
  const [signatureColumn, signedByColumn, signedAtColumn] = columns;
  const signed = entry.signature || null;
  try {
    await pool.query(
      `UPDATE triRecords
          SET ${signatureColumn} = ?, ${signedByColumn} = ?, ${signedAtColumn} = ?, updatedBy = ?
        WHERE id = ?`,
      [
        signed,
        signed ? entry.signedBy || null : null,
        // `toMysqlDateTime`, not a bare `Date`. The driver would otherwise send
        // the object and rely on its own locale-dependent conversion — the
        // hazard `helpers.toMysqlDateTime` exists to remove.
        signed ? toMysqlDateTime(entry.signedAt || new Date()) : null,
        updatedBy,
        recordId,
      ]
    );
  } catch (error) {
    if (error && (error.errno === 1054 || error.errno === 1060)) return;
    throw error;
  }
}

// ─── TRI Part II: Official offense-deduction table (Pages 6–7)
// Keyword → deduct-points per the PDF "Homelife Discipline" table.
const TRI_OFFENSE_DEDUCTIONS = [
  { points: 30, keywords: ['away','escape','absent without leave','awol'], note: 'Escape / Absence' },
  { points: 30, keywords: ['fight','assault','aggress','violence','attack','pamanik','pakikipag-away','pananakit'], note: 'Physical assault' },
  { points: 30, keywords: ['tattoo','tattat','bulitas','piercing','hikaw'], note: 'Tattoo / body piercing' },
  { points: 30, keywords: ['drugs','drug','substance','alcohol','inom','bilyo','inumin','nakakalasing','droga'], note: 'Drugs / alcohol' },
  { points: 30, keywords: ['property damage','paninira','vandalism','bintana','pintuan','kisame','padlock','room'], note: 'Property destruction' },
  { points: 30, keywords: ['cellphone','cell phone','gumagamit ng cell'], note: 'Cellphone' },
  { points: 30, keywords: ['money','pera','wallet','ipinagbabawal na bagay'], note: 'Money / valuables' },
  { points: 30, keywords: ['noise','ingay','pagkadistorbo','tulugan','pamamahinga'], note: 'Noise / disturbance' },
  { points: 30, keywords: ['gang','riot','grupo'], note: 'Gang / riot' },
  { points: 20, keywords: ['tablet','walang pahintulot','unauthorized'], note: 'Tablet without permission' },
  { points: 20, keywords: ['steal','pagnanakaw','nana','pag-akit'], note: 'Theft' },
  { points: 20, keywords: ['isolation','isolasyon'], note: 'Talking to isolated resident' },
  { points: 20, keywords: ['wire','kuryente','dagliang paglalagay'], note: 'Unauthorized wiring' },
  { points: 20, keywords: ['threat','banta','grave threat','nagbabanta'], note: 'Threat to life' },
  { points: 20, keywords: ['walang galang','disrespect','insult','sipol','di magandang salita'], note: 'Disrespect to staff' },
  { points: 20, keywords: ['food waste','aksaya','pag-aaksaya','mumo','kalat'], note: 'Food waste' },
  { points: 20, keywords: ['sexual','paninilip','deviant','pang-aabuso','pagpapamasahe','pagpapalaba'], note: 'Sexual misconduct' },
  { points: 20, keywords: ['bolitas','tenga'], note: 'Bolitas in ear' },
  { points: 20, keywords: ['bansag','masama','baston','pangalan'], note: 'Bad nicknames' },
  { points: 15, keywords: ['joke','biro','panayog'], note: 'Improper jokes' },
  { points: 15, keywords: ['sigarilyo','paninigarilyo','smoke','smoking'], note: 'Smoking' },
  { points: 15, keywords: ['labas','walang paalam','paglabas'], note: 'Leaving without leave' },
  { points: 15, keywords: ['attempt','tinangkang','failed','pagkabigong pagtakas'], note: 'Attempted / failed escape' },
  { points: 15, keywords: ['sugal','pagsusugal','juetale'], note: 'Gambling' },
  { points: 15, keywords: ['pambabastos','bastos','pambastos','kaway'], note: 'Verbal abuse to staff' },
  { points: 10, keywords: ['kuwarto','staff room','pasok'], note: 'Entering staff room' },
  { points: 10, keywords: ['receiving','receiving area'], note: 'Unauthorized receiving area' },
  { points: 10, keywords: ['pagkain','tago','akyat','tago-ng-tago','pag-akyat'], note: 'Stealing food' },
  { points: 10, keywords: ['benta','palitan','papapalit','magbebenta'], note: 'Selling / trading' },
  { points: 10, keywords: ['gupit','haircut','hindi pagsunod'], note: 'Wrong haircut defiance' },
  { points: 10, keywords: ['kulay','hair dye','pagkukulay'], note: 'Hair dye' },
  { points: 10, keywords: ['vandal'], note: 'Vandalism' },
  { points: 10, keywords: ['panghihingi','pera','bisita','taga-kalsada'], note: 'Begging from visitors' },
  { points: 10, keywords: ['tulog','hindi tulugan'], note: 'Not sleeping at proper time' },
  { points: 10, keywords: ['mura','mahahalay','pagmumura'], note: 'Cursing / profanity' },
  { points: 5,  keywords: ['tv','dvd','fan','electric','nagbubukas'], note: 'Using electronics without permission' },
  { points: 5,  keywords: ['headband','pony'], note: 'Headband / pony' },
];

function getTriOffenseDeduction(violationType) {
  const lower = (violationType || '').toLowerCase();
  for (const row of TRI_OFFENSE_DEDUCTIONS) {
    if (row.keywords.some(kw => lower.includes(kw))) return row.points;
  }
  return 0;
}

/**
 * Compute TRI Part II deductions from actual violations during the reporting
 * period, using the OFFICIAL offense table (Pages 6-7).
 */
async function computeTriDeductions(residentId, year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const [rows] = await pool.query(
    `SELECT id, type, date FROM violations
     WHERE residentId = ? AND date >= ? AND date < ?
       AND status NOT IN ('Dismissed', 'Rejected', 'Pending Review')
     ORDER BY date DESC`,
    [residentId, start, end]
  );
  const details = rows.map(v => ({
    id: v.id, type: v.type, date: v.date,
    deduction: getTriOffenseDeduction(v.type),
  }));
  const total = details.reduce((sum, d) => sum + d.deduction, 0);
  return { total, details };
}

function roleOf(user) {
  return normalizeRole(user?.role);
}

function canReview(user) {
  return ['socialworker', 'centerhead', 'admin'].includes(roleOf(user));
}

/**
 * The four official signature lines on the TRI's "Assessed by" block, and where
 * each one's drawing is stored.
 *
 * The block has five lines. The fifth is the Houseparent's own, which is a
 * separate route over separate columns because it is gated to `houseparent` alone:
 * a reviewer who could write it would be signing the document they are reviewing.
 * Here the reviewing roles *are* the signers — the facility has no separate account
 * for each office — so the gate is `canReview`, and these four lines are a separate
 * route rather than a wider one.
 *
 * The keys name the LINE, not the office-holder, because the people on them change:
 * the printed names live in `frontend/src/shared/triLayout.json` under
 * `designatedPersonnel`, shared with the PDF writers, and are not repeated here.
 *
 * `swo2` and `swo3` keep the column names they shipped with (`centerhead*`,
 * `sectionchief*`) so the signatures already stored on live records are not moved.
 * A later migration may rename them; until then the mapping is this table, and the
 * column names are read from here and never from the request, so a caller cannot
 * name a column to write.
 */
const OFFICIAL_SIGNATURE_LINES = {
  adminofficer: {
    label: 'Administrative Officer',
    signature: 'adminOfficerSignature',
    signedBy: 'adminOfficerSignedBy',
    signedAt: 'adminOfficerSignedAt',
  },
  swo1: {
    label: 'SWO I / Case Manager',
    signature: 'swo1Signature',
    signedBy: 'swo1SignedBy',
    signedAt: 'swo1SignedAt',
  },
  swo2: {
    label: 'SWO II / Center Head',
    signature: 'centerheadSignature',
    signedBy: 'centerheadSignedBy',
    signedAt: 'centerheadSignedAt',
  },
  swo3: {
    label: 'SWO III / Section Chief',
    signature: 'sectionchiefSignature',
    signedBy: 'sectionchiefSignedBy',
    signedAt: 'sectionchiefSignedAt',
  },
};

function manilaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday: parts.weekday };
}

// Reporting-period maths lives in utils/triPeriod.js so the deadline reminder can
// use the same calendar without a second copy of `lastMonday` drifting from this one.
const { lastMonday, effectiveDate, periodLabel } = require('../utils/triPeriod');

/**
 * Tell the Houseparent who prepared a TRI what the reviewer decided.
 *
 * `submittedBy` holds a *username*, but a notification must be addressed to a
 * user id to reach exactly one person, so it is resolved through the service.
 * Addressed by id rather than by role because this has to reach the preparer
 * specifically — the row this replaces was written with `targetRole = null` and
 * therefore reached nobody at all.
 *
 * Non-fatal: the review decision is already committed by the time this runs, so
 * a notification failure must not turn a successful review into a 500.
 */
async function notifyPreparer(record, actor, { type, title, message, dedupeKey }) {
  try {
    const preparerId = await notifications.userIdForUsername(record.submittedBy);
    if (!preparerId) return;
    await notifications.notify({
      type,
      title,
      message,
      priority: 'Medium',
      residentId: record.residentId,
      relatedRecordType: 'tri',
      relatedRecordId: record.id,
      targetUserId: preparerId,
      actorUsername: actor?.username || null,
      dedupeKey,
    });
  } catch (nerr) {
    console.error(`[TRI Controller] "${type}" notification failed (non-fatal):`, nerr.message);
  }
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function scoreTri(responses, requireComplete = true) {
  const data = asObject(responses);
  const scores = Array.isArray(data.items) ? data.items : [];
  // Deductions may be a number (auto-computed) or an array of {points}
  const deductionPoints = Array.isArray(data.deductions)
    ? data.deductions.reduce((sum, item) => sum + Math.max(0, Number(item?.points) || 0), 0)
    : Math.max(0, Number(data.deductions) || 0);
  const partOnePoints = scores.reduce((sum, item) => {
    const score = Number(item?.score);
    if (!Number.isInteger(score) || score < 1 || score > 4) {
      if (!requireComplete) return sum;
      throw new ApiError(400, 'Every TRI item score must be an integer from 1 to 4 (Per-item Legend: 1=Needs Improvement, 2=Fair, 3=Good, 4=Very Good)');
    }
    return sum + score;
  }, 0);
  if (partOnePoints > MAX_TRI_PART_ONE_POINTS) {
    throw new ApiError(400, `TRI Part I cannot exceed ${MAX_TRI_PART_ONE_POINTS} points`);
  }
  const finalPoints = Math.max(0, partOnePoints - deductionPoints);
  // Official scheme from the TRI PDF (Page 8); bands live in utils/triScoring.js.
  const rating = ratingForPoints(finalPoints);
  return { partOnePoints, deductions: deductionPoints, finalPoints, rating };
}

async function getRecord(id) {
  const [rows] = await pool.query('SELECT * FROM triRecords WHERE id = ?', [id]);
  if (!rows[0]) throw new ApiError(404, 'TRI record not found');
  return rows[0];
}

async function previousFinalized(residentId, year, month) {
  const [rows] = await pool.query(
    `SELECT finalPoints, rating FROM triRecords
     WHERE residentId = ? AND status = 'Finalized'
       AND (reportingYear < ? OR (reportingYear = ? AND reportingMonth < ?))
     ORDER BY reportingYear DESC, reportingMonth DESC, finalizedAt DESC LIMIT 1`,
    [residentId, year, year, month]
  );
  return rows[0] || null;
}

function mapRecord(row) {
  return { ...row, responses: asObject(row.responses), signatories: asObject(row.signatories) };
}

async function list(req, res, next) {
  try {
    const { residentId, status, year, month, from, to } = req.query;
    const clauses = [];
    const values = [];
    if (residentId) {
      if (!await canAccessResident(req.user, residentId)) throw new ApiError(403, 'You are not assigned to this resident');
      clauses.push('residentId = ?'); values.push(residentId);
    } else if (roleOf(req.user) === 'houseparent') {
      clauses.push(`residentId IN (SELECT residentId FROM residentAssignments WHERE userId = ? AND status = 'Active')`);
      values.push(req.user.id);
    }
    if (status && VALID_STATUSES.has(status)) { clauses.push('status = ?'); values.push(status); }
    if (year) { clauses.push('reportingYear = ?'); values.push(Number(year)); }
    if (month) { clauses.push('reportingMonth = ?'); values.push(Number(month)); }
    if (from) { clauses.push(`CONCAT(reportingYear, '-', LPAD(reportingMonth, 2, '0')) >= ?`); values.push(from); }
    if (to) { clauses.push(`CONCAT(reportingYear, '-', LPAD(reportingMonth, 2, '0')) <= ?`); values.push(to); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await pool.query(`SELECT * FROM triRecords ${where} ORDER BY reportingYear DESC, reportingMonth DESC, createdAt DESC`, values);
    res.json({ success: true, data: rows.map(mapRecord), count: rows.length });
  } catch (error) { next(error); }
}

async function getById(req, res, next) {
  try {
    const record = await getRecord(req.params.id);
    if (!await canAccessResident(req.user, record.residentId)) throw new ApiError(403, 'You are not assigned to this resident');
    res.json({ success: true, data: mapRecord(record) });
  } catch (error) { next(error); }
}

/**
 * GET /api/tri/:id/pdf — the filled official TRI as a PDF, on demand.
 *
 * The form used to be drawn only in the browser: `Tri.tsx` fetches the blank
 * `/forms/tri.pdf` and paints the record onto it, so a TRI could be downloaded
 * only from a machine that had the editor open, one record at a time. Approval
 * already builds the identical document server-side (`publishDocumentForTri`),
 * so this exposes that generator rather than adding a second renderer — and it
 * is what a bulk ZIP needs, because N records cannot each open a tab.
 *
 * The same two gates as `getById`: the record must exist, and the caller must be
 * able to reach its resident (`canAccessResident`, which is what bounds a
 * Houseparent to their own case load).
 */
async function getPdf(req, res, next) {
  try {
    const record = await getRecord(req.params.id);
    if (!await canAccessResident(req.user, record.residentId)) throw new ApiError(403, 'You are not assigned to this resident');
    const [[child]] = await pool.query('SELECT name FROM children WHERE id = ?', [record.residentId]);
    const { buffer, fileName } = await buildTriReportDocument(record, child?.name);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buffer.length);
    // `inline` so the browser can preview it; the client saves it from the blob.
    res.setHeader('Content-Disposition', contentDisposition(fileName, 'inline'));
    // A TRI is a resident's record: never let a proxy or the browser cache it.
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(buffer);
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    if (roleOf(req.user) === 'socialworker') throw new ApiError(403, 'Social Workers cannot create a new TRI from the Houseparent module.');
    const { residentId, reportingYear, reportingMonth, responses: responsesInput = {}, caseCycleKey } = req.body || {};
    const current = manilaDateParts();
    const year = Number(reportingYear || current.year);
    const month = Number(reportingMonth || current.month);
    if (!residentId || !Number.isInteger(year) || month < 1 || month > 12) throw new ApiError(400, 'residentId, reportingYear, and reportingMonth are required');
    if (!await canAccessResident(req.user, residentId)) throw new ApiError(403, 'You are not assigned to this resident');
    const [resident] = await pool.query('SELECT id FROM children WHERE id = ?', [residentId]);
    if (!resident[0]) throw new ApiError(404, 'Resident not found');
    const [existingForPeriod] = await pool.query(
      `SELECT id, status FROM triRecords WHERE residentId = ? AND reportingYear = ? AND reportingMonth = ? ORDER BY createdAt DESC LIMIT 1`,
      [residentId, year, month]
    );
    if (existingForPeriod[0]) {
      const status = existingForPeriod[0].status;
      if (status === 'Returned' || status === 'Draft') {
        throw new ApiError(409, 'A TRI already exists for this resident and reporting month. The existing Draft/Returned TRI must be edited and resubmitted.');
      }
      throw new ApiError(409, 'A TRI already exists for this resident and reporting month. Another TRI cannot be created unless the existing report is returned for revision.');
    }

    // Auto-compute official offense deductions from actual violations this period.
    // The frontend may override by sending responses.deductions explicitly.
    const responses = asObject(responsesInput);
    if (responses.deductions === undefined) {
      const computed = await computeTriDeductions(residentId, year, month);
      responses.deductions = computed.total;
      responses.deductionDetails = computed.details;
    }
    const scores = scoreTri(responses, false);
    const previous = await previousFinalized(residentId, year, month);
    // Two concurrent submissions can derive the same id; retry instead of 500.
    const id = await insertWithGeneratedId(pool, {
      table: 'triRecords',
      prefix: 'TRI',
      insert: (generatedId) => pool.query(
        `INSERT INTO triRecords
         (id, residentId, caseCycleKey, formVersion, reportingYear, reportingMonth, status, responses,
          partOnePoints, deductions, finalPoints, rating, previousPoints, previousRating,
          submissionDeadline, effectiveDate, createdBy, updatedBy)
         VALUES (?, ?, ?, ?, ?, ?, 'Draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [generatedId, residentId, caseCycleKey || null, TRI_TEMPLATE_VERSION, year, month, JSON.stringify(responses),
          scores.partOnePoints, scores.deductions, scores.finalPoints, scores.rating,
          previous?.finalPoints || null, previous?.rating || null, lastMonday(year, month), effectiveDate(year, month), req.user.username, req.user.username]
      ),
    });
    const record = await getRecord(id);
    res.status(201).json({ success: true, data: mapRecord(record) });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  try {
    const record = await getRecord(req.params.id);
    // Reviewers are not co-authors. A submitted TRI is read-only to them: they
    // either approve it or return it for revision. Letting a reviewer edit a
    // submitted record destroyed the audit trail of who scored what, and the
    // person who observed the child should be the one to correct a score anyway.
    //
    // Deliberately not widened by role: `Draft` and `Returned` stay editable for
    // anyone with access to the resident (so a rotating shift of Houseparents can
    // pick up an unfinished draft), and every status from `Submitted` onwards is
    // editable by nobody.
    const editableStatuses = ['Draft', 'Returned', 'For Reassessment'];

    if (!editableStatuses.includes(record.status)) {
      throw new ApiError(
        409,
        'This TRI record can no longer be edited because it has been finalized.'
      );
    }

    if (!await canAccessResident(req.user, record.residentId)) {
      throw new ApiError(
        403,
        'You are not assigned to this resident'
      );
    }

    const responses =
      req.body?.responses === undefined
        ? asObject(record.responses)
        : req.body.responses;

    const scores = scoreTri(responses, false);

    await pool.query(
      `UPDATE triRecords
       SET responses = ?,
           partOnePoints = ?,
           deductions = ?,
           finalPoints = ?,
           rating = ?,
           updatedBy = ?
       WHERE id = ?`,
      [
        JSON.stringify(responses),
        scores.partOnePoints,
        scores.deductions,
        scores.finalPoints,
        scores.rating,
        req.user.username,
        record.id,
      ]
    );

    res.json({
      success: true,
      data: mapRecord(await getRecord(record.id)),
    });
  } catch (error) {
    next(error);
  }
}

async function submit(req, res, next) {
  try {
    const record = await getRecord(req.params.id);
    if (!['Draft', 'Returned', 'For Reassessment'].includes(record.status)) throw new ApiError(409, 'Only draft or TRI records for reassessment can be submitted');
    if (!await canAccessResident(req.user, record.residentId)) throw new ApiError(403, 'You are not assigned to this resident');
    const triResponses = asObject(record.responses);
    const selectedOffenses = Array.isArray(triResponses.offenses) ? triResponses.offenses : [];
    const offenseDates = triResponses.offenseDates && typeof triResponses.offenseDates === 'object' ? triResponses.offenseDates : {};
    const missingOffenseDates = selectedOffenses.filter(index => !String(offenseDates[String(index)] || '').trim());
    if (missingOffenseDates.length > 0) {
      throw new ApiError(400, 'Date Committed is required for every TRI Part II offense marked with an X.');
    }
    const scores = scoreTri(record.responses);
    // Refresh the previous-period snapshot here, not only at create. A draft is
    // routinely started before the prior month has been finalized, and `create` is
    // the only other place that fills these in — so a record created early would
    // otherwise be frozen at "nothing to compare against" for good, even once the
    // earlier TRI was approved. Submit is where the record's numbers are settled.
    const previous = await previousFinalized(record.residentId, record.reportingYear, record.reportingMonth);
    // Atomic transition guard, not a read-then-write check. Two concurrent
    // submissions can both pass the status test above; only one of them can win
    // this UPDATE, so the loser is refused instead of writing a second record.
    // This guard is what makes the notification below idempotent.
    const [updateResult] = await pool.query(
      `UPDATE triRecords SET status = 'Submitted', submittedBy = ?, submittedAt = NOW(),
       partOnePoints = ?, deductions = ?, finalPoints = ?, rating = ?,
       previousPoints = ?, previousRating = ?, updatedBy = ?
       WHERE id = ? AND status IN ('Draft', 'Returned', 'For Reassessment')`,
      [
        req.user.username, scores.partOnePoints, scores.deductions, scores.finalPoints, scores.rating,
        previous ? previous.finalPoints : null, previous ? previous.rating : null,
        req.user.username, record.id,
      ]
    );
    if (Number(updateResult?.affectedRows || 0) === 0) {
      throw new ApiError(409, 'Only draft or returned TRI records can be submitted');
    }
    // Notify every reviewer — Social Workers, Center Heads and Administrators.
    // Addressed one row per user rather than by role, because a single alert row
    // carries only one targetRole: a role-addressed row can never reach two roles,
    // which is why a Center Head was previously never told a TRI was waiting.
    //
    // Deliberately no dedupe key. A repeat here is a *new* event: a TRI that was
    // returned and then resubmitted must notify reviewers again, so a fixed
    // `tri:<id>:submitted` key would suppress that second notification forever.
    // A timestamp key is no safer — `submittedAt` has second precision, so a fast
    // return-and-resubmit lands on the same key and the resubmission is swallowed
    // silently. Idempotence comes from the atomic status transition above instead,
    // the same pattern the psych-assessment flag uses.
    //
    // Non-fatal: a notification failure must not roll back a valid submission.
    const submitted = await getRecord(record.id);
    try {
      const reviewers = await notifications.usersWithAnyRole(['socialworker', 'centerhead', 'admin']);
      const name = await notifications.residentName(record.residentId);
      await notifications.notifyUsers(reviewers.map((reviewer) => reviewer.id), {
        type: 'TRI Submitted',
        title: 'TRI submitted for review',
        message: `${name} — TRI for ${periodLabel(record.reportingYear, record.reportingMonth)} is ready for review.`,
        priority: 'Medium',
        residentId: record.residentId,
        relatedRecordType: 'tri',
        relatedRecordId: record.id,
        actorUsername: req.user.username,
      });
    } catch (nerr) {
      console.error('[TRI Controller] Submit notification failed (non-fatal):', nerr.message);
    }
    // A reassessed TRI is a new review event. Notify the responsible reviewers
    // again so a correction does not sit silently after the Houseparent resubmits.
    if (record.status === 'For Reassessment') {
      try {
        const reviewers = await notifications.usersWithAnyRole(['socialworker', 'centerhead', 'admin']);
        const name = await notifications.residentName(record.residentId);
        await notifications.notifyUsers(reviewers.map((reviewer) => reviewer.id), {
          type: 'TRI Resubmitted',
          title: 'TRI resubmitted for review',
          message: `${name} — TRI for ${periodLabel(record.reportingYear, record.reportingMonth)} was corrected and resubmitted after reassessment.`,
          priority: 'High',
          residentId: record.residentId,
          relatedRecordType: 'tri',
          relatedRecordId: record.id,
          actorUsername: req.user.username,
        });
      } catch (nerr) {
        console.error('[TRI Controller] Reassessment resubmission notification failed (non-fatal):', nerr.message);
      }
    }
    const dischargeRecommendation = await buildRecommendationForTri(submitted);
    res.json({ success: true, data: { ...mapRecord(submitted), dischargeRecommendation } });
  } catch (error) { next(error); }
}

async function review(req, res, next) {
  try {
    if (!canReview(req.user)) throw new ApiError(403, 'Only Social Worker or Center Head can review TRI records');
    const record = await getRecord(req.params.id);
    if (record.status !== 'Submitted') throw new ApiError(409, 'Only submitted TRI records can enter review');
    await pool.query(`UPDATE triRecords SET status = 'Under Review', reviewedBy = ?, reviewedAt = NOW(), updatedBy = ? WHERE id = ?`, [req.user.username, req.user.username, record.id]);
    res.json({ success: true, data: mapRecord(await getRecord(record.id)) });
  } catch (error) { next(error); }
}

async function returnForRevision(req, res, next) {
  try {
    if (!canReview(req.user)) throw new ApiError(403, 'Only Social Worker or Center Head can return TRI records');
    const record = await getRecord(req.params.id);
    if (!['Submitted', 'Under Review'].includes(record.status)) throw new ApiError(409, 'Only submitted TRI records can be returned');
    const reviewNotes = String(req.body?.reviewNotes || '').trim();
    if (!reviewNotes) throw new ApiError(400, 'Review notes are required when returning a TRI record');
    await pool.query(`UPDATE triRecords SET status = 'For Reassessment', reviewedBy = ?, reviewedAt = NOW(), reviewNotes = ?, updatedBy = ? WHERE id = ?`, [req.user.username, reviewNotes, req.user.username, record.id]);
    // Tell the preparer what to fix. Without this a returned TRI shows them a bare
    // "Returned" status with no explanation, and they resubmit blind.
    const returned = await getRecord(record.id);
    await notifyPreparer(returned, req.user, {
      type: 'TRI For Reassessment',
      title: 'TRI for reassessment',
      message: `${await notifications.residentName(record.residentId)} — your TRI for ${periodLabel(record.reportingYear, record.reportingMonth)} is for reassessment. Please review the corrections requested: ${reviewNotes}`,
      dedupeKey: `tri:${record.id}:reassessment:${returned.reviewedAt}`,

    });
    res.json({ success: true, data: mapRecord(returned) });
  } catch (error) { next(error); }
}

/**
 * Publishes the filled official TRI into the resident's Documents folder.
 *
 * Called when a TRI is approved. The record is the official monthly result, so the
 * resident's file should hold the document — until now the filled form existed only
 * as a download from whoever happened to have the editor open.
 *
 * Idempotent by link, not by hope: `documents.triRecordId` carries a unique index,
 * so an approve that runs twice updates the same entry rather than leaving two
 * copies of the same month. The row is a derived artifact — it can always be
 * rebuilt from `triRecords` — so this destroys nothing.
 *
 * Non-fatal on failure. A record that has been approved must stay approved even if
 * the PDF cannot be written; the missing document is reported and can be
 * regenerated, whereas a rolled-back approval would lose the reviewer's decision.
 *
 * @returns {Promise<string|null>} the document id, or null if nothing was written.
 */
async function publishDocumentForTri(record, actor) {
  // `children` has no room column — the room is carried on the record's own
  // responses (the form reads `responses.room`, and its `child?.room` fallback
  // never resolves). So only the name is joined here.
  const [[child]] = await pool.query('SELECT name FROM children WHERE id = ?', [record.residentId]);
  const { buffer, fileName, fileSize, title } = await buildTriReportDocument(record, child?.name);
  // The published entry is Approved from the moment it is written, so it has to
  // carry the approval itself: `approvedBy`/`approvedAt` are what the Documents
  // module prints under "Approved By" / "Approval Date". Without them the row
  // showed a submitter and an empty approver.
  const approver = record.finalizedBy || actor || null;
  const reviewer = record.reviewedBy || approver;
  const description = `Official Treatment and Rehabilitation Indicator for ${periodLabel(record.reportingYear, record.reportingMonth)}. `
    + `Rating: ${record.rating || 'Not rated'} (${record.finalPoints ?? 0} points). System-generated copy — `
    + (() => {
      const signed = signedLineCount(record);
      const total = TRI_SIGNATORY_SLOTS.length;
      if (!signed) return 'signature lines are blank.';
      return signed === total
        ? 'all five signature lines are signed.'
        : `${signed} of ${total} signature lines are signed; the remaining signature lines are blank.`;
    })();
  const fileData = buffer.toString('base64');

  const [existing] = await pool.query('SELECT id FROM documents WHERE triRecordId = ? LIMIT 1', [record.id]);
  if (existing.length) {
    await pool.query(
      `UPDATE documents SET title = ?, description = ?, residentName = ?, fileName = ?, fileSize = ?,
       fileType = 'application/pdf', fileData = ?, documentCategory = ?,
       approvedBy = ?, approvedAt = NOW(), reviewedBy = ?, reviewedAt = NOW(),
       submittedBy = ?, modifiedBy = ? WHERE id = ?`,
      [title, description, child?.name || null, fileName, fileSize, fileData, TRI_FOLDER,
        approver, reviewer, record.submittedBy || null, actor, existing[0].id]
    );
    return existing[0].id;
  }
  // `submittedBy` is the Houseparent who prepared the TRI, NOT the reviewer
  // publishing it — the folder view shows who submitted a document, and
  // `uploadedBy` already carries the publisher.
  // Filed under the admission the resident is currently in, so a TRI prepared
  // after a re-intake never lands in an earlier admission's folder.
  const admissionId = await activeAdmissionIdFor(pool, record.residentId);
  return insertWithGeneratedId(pool, {
    table: 'documents',
    prefix: 'DOC',
    insert: (id) => pool.query(
      `INSERT INTO documents (id, residentId, admissionId, residentName, title, type, category, documentCategory, description, fileName, fileSize, fileType, fileData, status, submittedBy, uploadedBy, uploadedAt, approvedBy, approvedAt, reviewedBy, reviewedAt, triRecordId, createdBy, modifiedBy)
       VALUES (?, ?, ?, ?, ?, 'TRI', 'Assessment', ?, ?, ?, ?, 'application/pdf', ?, 'Approved', ?, ?, NOW(), ?, NOW(), ?, NOW(), ?, ?, ?)`,
      [id, record.residentId, admissionId, child?.name || null, title, TRI_FOLDER, description, fileName, fileSize, fileData,
        record.submittedBy || null, actor, approver, reviewer, record.id, actor, actor]
    ),
  });
}

async function finalize(req, res, next) {
  try {
    if (!canReview(req.user)) throw new ApiError(403, 'Only Social Worker or Center Head can finalize TRI records');
    const record = await getRecord(req.params.id);
    if (!['Submitted', 'Under Review'].includes(record.status)) throw new ApiError(409, 'Only submitted TRI records can be finalized');
    const scores = scoreTri(record.responses);
    await pool.query(
      `UPDATE triRecords SET status = 'Finalized', finalizedBy = ?, finalizedAt = NOW(),
       reviewedBy = COALESCE(reviewedBy, ?), reviewedAt = COALESCE(reviewedAt, NOW()),
       partOnePoints = ?, deductions = ?, finalPoints = ?, rating = ?, updatedBy = ? WHERE id = ?`,
      [req.user.username, req.user.username, scores.partOnePoints, scores.deductions, scores.finalPoints, scores.rating, req.user.username, record.id]
    );
    const finalized = await getRecord(record.id);

    // Publish the official form into the resident's Documents folder. Done before
    // the notification so the alert can say whether the file actually landed.
    //
    // The failure is reported rather than only logged. Swallowing it silently is
    // what let a missing Docker asset go unnoticed for a week: every approval
    // answered 200 with `documentId: null`, and both the reviewer and the client
    // treated that as success. The reviewer is told the TRI was approved and has no
    // reason to look for the file — so the caller gets `documentError` to show.
    let documentId = null;
    let documentError = null;
    try {
      documentId = await publishDocumentForTri(finalized, req.user.username);
    } catch (perr) {
      documentError = perr.message;
      console.error(`[TRI Controller] Publishing the TRI PDF for ${record.id} failed (non-fatal):`, perr.message);
    }

    // Tell the preparer their TRI was approved. This replaces an alert written
    // with `targetRole = null`, which the visibility rule treats as addressed to
    // nobody — the row existed but no user could ever read it.
    await notifyPreparer(finalized, req.user, {
      type: 'TRI Finalized',
      title: 'TRI approved',
      message: `${await notifications.residentName(record.residentId)} — your TRI for ${periodLabel(record.reportingYear, record.reportingMonth)} was approved. Rating: ${scores.rating || 'Not rated'} (${scores.finalPoints} points).`
        + (documentId ? ' The official form is now in the resident\u2019s Documents.' : ''),
      dedupeKey: `tri:${record.id}:approved:${finalized.finalizedAt}`,
    });
    res.json({ success: true, data: mapRecord(finalized), documentId, documentError });
  } catch (error) { next(error); }
}

/**
 * POST /:id/signature — attach the Houseparent's drawn signature to a TRI.
 *
 * The official TRI ends with an "Assessed by" block whose first line is captioned
 * "Houseparent". The preparer signs it after filling the form in; this stores the
 * drawing so the exported PDF can print it on that line. Until now the line was
 * always blank because nothing captured a signature at all.
 *
 * A PNG data URL is the only accepted shape — the same contract the shared
 * `SignaturePad` emits everywhere else. An empty string clears the signature.
 *
 * Allowed on any record that is not Finalized: a preparer routinely signs a draft
 * they are still filling in, and refusing that would force a submit-then-sign
 * round trip. A finalized record is the published instrument, so it is frozen.
 */
async function sign(req, res, next) {
  try {
    // The page-8 "Houseparent" line is the Houseparent's own signature. Enforced
    // here as well as on the route so the rule still holds if this handler is ever
    // mounted without its `authorize('houseparent')` gate. Center Head and Social
    // Worker approve or return the TRI instead — they never sign it.
    if (String(req.user?.role || '').toLowerCase() !== 'houseparent') throw new ApiError(403, 'Only the Houseparent who prepared this TRI can sign it.');
    const record = await getRecord(req.params.id);
    if (!await canAccessResident(req.user, record.residentId)) throw new ApiError(403, 'You are not assigned to this resident');
    if (record.status === 'Finalized') throw new ApiError(409, 'A finalized TRI cannot be changed.');

    const raw = req.body ? req.body.signature : undefined;
    if (raw === undefined) throw new ApiError(400, 'signature is required');
    const signature = raw === null ? '' : String(raw);

    // Either a PNG/JPEG data URL, or an explicit clear.
    if (signature && !/^data:image\/(png|jpeg|jpg);base64,/i.test(signature)) {
      throw new ApiError(400, 'signature must be a PNG or JPEG data URL');
    }
    // LONGTEXT holds 4 GB, but a runaway payload is still a bug, not a signature.
    if (signature.length > 2_000_000) throw new ApiError(413, 'signature image is too large');

    await pool.query(
      `UPDATE triRecords
         SET houseparentSignature = ?, houseparentSignedBy = ?, houseparentSignedAt = ?,
             updatedBy = ?
       WHERE id = ?`,
      [
        signature || null,
        signature ? req.user.username : null,
        signature ? new Date() : null,
        req.user.username,
        record.id,
      ]
    );

    res.json({
      success: true,
      data: mapRecord(await getRecord(record.id)),
      message: signature ? 'Houseparent signature saved.' : 'Houseparent signature removed.',
    });
  } catch (error) { next(error); }
}

/**
 * PUT /:id/signatories — the typed names and E-Signatures of the page-8 block.
 *
 * Body: `{ slot, name?, signature? }`. A field that is left out is unchanged; an
 * empty string clears it.
 *
 *   - `houseparent`            name only (the Houseparent's E-Signature keeps its
 *                              own endpoint, POST /:id/signature). Houseparent only.
 *   - `administrativeOfficer`, `caseManager`
 *                              name + E-Signature.
 *   - `centerHead` (MARICOR C. NAVARRO), `sectionChief` (NICOLAS Q. REGALARIO)
 *                              E-Signature only; the name is pre-printed.
 *
 * Every line except the Houseparent's is filled in by a reviewer (Social Worker,
 * Center Head, Admin). A finalized TRI is the published instrument, so it is frozen.
 */
async function updateSignatories(req, res, next) {
  try {
    const slot = String(req.body?.slot || '');
    const definition = TRI_SIGNATORY_SLOTS.find((entry) => entry.slot === slot);
    if (!definition) throw new ApiError(400, `slot must be one of: ${TRI_SIGNATORY_SLOTS.map((entry) => entry.slot).join(', ')}`);

    if (slot === 'houseparent') {
      // The Houseparent's typed name may be entered by the Houseparent or by a
      // reviewer. (Name only — the Houseparent's E-Signature is refused below and
      // stays on POST /:id/signature, which only a Houseparent may call.)
      if (roleOf(req.user) !== 'houseparent' && !canReview(req.user)) {
        throw new ApiError(403, 'Only the Houseparent, a Social Worker or the Center Head can enter the Houseparent name.');
      }
    } else if (!canReview(req.user)) {
      throw new ApiError(403, 'Only a Social Worker or the Center Head can fill in this signature line.');
    }

    const record = await getRecord(req.params.id);
    if (!await canAccessResident(req.user, record.residentId)) throw new ApiError(403, 'You are not assigned to this resident');
    if (record.status === 'Finalized') throw new ApiError(409, 'A finalized TRI cannot be changed.');

    const { name, signature } = req.body || {};
    if (name === undefined && signature === undefined) throw new ApiError(400, 'name or signature is required');
    if (name !== undefined && !definition.hasName) throw new ApiError(400, 'This signature line has a pre-printed name.');
    if (signature !== undefined && slot === 'houseparent') {
      throw new ApiError(400, 'The Houseparent signature is saved through POST /tri/:id/signature.');
    }

    const current = asObject(record.signatories);
    const entry = { ...(current[slot] || {}) };

    if (name !== undefined) {
      const text = name === null ? '' : String(name).trim();
      if (text.length > 150) throw new ApiError(400, 'name must be 150 characters or fewer');
      entry.name = text || null;
    }
    if (signature !== undefined) {
      const value = signature === null ? '' : String(signature);
      if (value && !/^data:image\/(png|jpeg|jpg);base64,/i.test(value)) {
        throw new ApiError(400, 'signature must be a PNG or JPEG data URL');
      }
      if (value.length > 2_000_000) throw new ApiError(413, 'signature image is too large');
      entry.signature = value || null;
      entry.signedBy = value ? req.user.username : null;
      // The same shape the mirrored column holds, so the JSON and the column
      // cannot disagree — and no raw ISO instant is left where a query could
      // pick it up. The response boundary labels it on the way out.
      entry.signedAt = value ? toMysqlDateTime(new Date()) : null;
    }

    const next = { ...current, [slot]: entry };
    await pool.query(
      'UPDATE triRecords SET signatories = ?, updatedBy = ? WHERE id = ?',
      [JSON.stringify(next), req.user.username, record.id]
    );
    // Keep the line's own columns in step with the JSON, so nothing that reads
    // the columns (older records, the reports, the guard tests) goes stale.
    await mirrorSignatoryToColumns(record.id, slot, entry, req.user.username);

    res.json({
      success: true,
      data: mapRecord(await getRecord(record.id)),
      message: `${definition.title} line saved.`,
    });
  } catch (error) { next(error); }
}

/**
 * POST /:id/signature/:line — the original per-line signing route, kept so its
 * callers keep working.
 *
 * It writes through the same storage as `PUT /:id/signatories`: the slot's entry
 * in `signatories` is updated and then mirrored into that line's columns, so the
 * two stores cannot disagree. `line` is one of `adminofficer`, `swo1`, `swo2`,
 * `swo3` — the Houseparent line keeps its own route (`POST /:id/signature`).
 *
 * Same contract as the Houseparent's line otherwise: a PNG/JPEG data URL or an
 * explicit clear, capped at 2,000,000 characters, refused on a Finalized record.
 * Signing never submits or advances the record — the officials sign a TRI that is
 * already in front of them.
 */
async function signOfficialLine(req, res, next) {
  try {
    const key = String(req.params.line || '').toLowerCase();
    const line = OFFICIAL_SIGNATURE_LINES[key];
    if (!line) {
      throw new ApiError(400, `line must be one of ${Object.keys(OFFICIAL_SIGNATURE_LINES).join(', ')}`);
    }
    const slot = slotForSignatureLine(line);
    if (!slot) throw new ApiError(500, `No storage slot is mapped for the ${line.label} line.`);
    if (!canReview(req.user)) {
      throw new ApiError(403, `Only a Social Worker or Center Head can sign the ${line.label} line.`);
    }

    const record = await getRecord(req.params.id);
    if (!await canAccessResident(req.user, record.residentId)) throw new ApiError(403, 'You are not assigned to this resident');
    if (record.status === 'Finalized') throw new ApiError(409, 'A finalized TRI cannot be changed.');

    const raw = req.body ? req.body.signature : undefined;
    if (raw === undefined) throw new ApiError(400, 'signature is required');
    const signature = raw === null ? '' : String(raw);

    if (signature && !/^data:image\/(png|jpeg|jpg);base64,/i.test(signature)) {
      throw new ApiError(400, 'signature must be a PNG or JPEG data URL');
    }
    if (signature.length > 2_000_000) throw new ApiError(413, 'signature image is too large');

    const current = asObject(record.signatories);
    const entry = { ...(current[slot] || {}) };
    entry.signature = signature || null;
    entry.signedBy = signature ? req.user.username : null;
    entry.signedAt = signature ? toMysqlDateTime(new Date()) : null;

    await pool.query(
      'UPDATE triRecords SET signatories = ?, updatedBy = ? WHERE id = ?',
      [JSON.stringify({ ...current, [slot]: entry }), req.user.username, record.id]
    );
    await mirrorSignatoryToColumns(record.id, slot, entry, req.user.username);

    res.json({
      success: true,
      data: mapRecord(await getRecord(record.id)),
      message: signature ? `${line.label} signature saved.` : `${line.label} signature removed.`,
    });
  } catch (error) { next(error); }
}

async function referenceViolations(req, res, next) {
  try {
    const { residentId } = req.params;
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!Number.isInteger(year) || month < 1 || month > 12) throw new ApiError(400, 'year and month are required');
    if (!await canAccessResident(req.user, residentId)) throw new ApiError(403, 'You are not assigned to this resident');
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const end = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const [rows] = await pool.query(
      `SELECT * FROM violations WHERE residentId = ? AND date >= ? AND date < ? ORDER BY date DESC, createdAt DESC`,
      [residentId, start, end]
    );
    res.json({ success: true, data: rows, count: rows.length });
  } catch (error) { next(error); }
}

/**
 * Resident TRI history — every monthly record kept (never overwritten).
 */
async function residentHistory(req, res, next) {
  try {
    const { residentId } = req.params;
    if (!await canAccessResident(req.user, residentId)) throw new ApiError(403, 'You are not assigned to this resident');
    const { status } = req.query;
    const clauses = ['residentId = ?'];
    const values = [residentId];
    if (status) { clauses.push('status = ?'); values.push(status); }
    const [rows] = await pool.query(
      `SELECT * FROM triRecords WHERE ${clauses.join(' AND ')} ORDER BY reportingYear DESC, reportingMonth DESC, createdAt DESC`,
      values
    );
    res.json({ success: true, data: rows.map(mapRecord), count: rows.length });
  } catch (error) { next(error); }
}

/**
 * Compute official Part II offense deductions for a resident + period.
 */
async function offenseDeductions(req, res, next) {
  try {
    const { residentId } = req.params;
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!Number.isInteger(year) || month < 1 || month > 12) throw new ApiError(400, 'year and month are required');
    if (!await canAccessResident(req.user, residentId)) throw new ApiError(403, 'You are not assigned to this resident');
    const { total, details } = await computeTriDeductions(residentId, year, month);
    res.json({ success: true, data: { total, details, max: MAX_TRI_PART_ONE_POINTS }, count: details.length });
  } catch (error) { next(error); }
}

async function summary(req, res, next) {
  try {
    const { from, to } = req.query;
    const clauses = [`status = 'Finalized'`];
    const values = [];
    if (from) { clauses.push(`CONCAT(reportingYear, '-', LPAD(reportingMonth, 2, '0')) >= ?`); values.push(from); }
    if (to) { clauses.push(`CONCAT(reportingYear, '-', LPAD(reportingMonth, 2, '0')) <= ?`); values.push(to); }
    const [rows] = await pool.query(
      `SELECT rating, COUNT(*) AS count FROM triRecords WHERE ${clauses.join(' AND ')} GROUP BY rating`, values
    );
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
}

/**
 * TRI-authoritative monitoring: one row per active resident with their most
 * recent Finalized TRI rating. Residents without a finalized TRI are returned
 * with rating=null so TRI remains the authoritative source (the old violation-
 * point urgency is no longer used as the authoritative rating).
 */
async function monitor(req, res, next) {
  try {
    // Single set-based query instead of one SELECT per active resident. The
    // correlated subquery resolves "most recent Finalized TRI" with exactly the
    // same ordering/tie-break the previous per-resident query used.
    const [rows] = await pool.query(
      `SELECT c.id AS residentId, c.name, c.caseType, c.casePhase,
              t.rating, t.finalPoints AS points, t.reportingYear, t.reportingMonth
       FROM children c
       LEFT JOIN triRecords t
         ON t.id = (
           SELECT t2.id FROM triRecords t2
           WHERE t2.residentId = c.id AND t2.status = 'Finalized'
           ORDER BY t2.reportingYear DESC, t2.reportingMonth DESC, t2.finalizedAt DESC
           LIMIT 1
         )
       WHERE c.status = ?`,
      ['Active']
    );
    const out = rows.map((row) => ({
      residentId: row.residentId,
      name: row.name,
      caseType: row.caseType,
      casePhase: row.casePhase,
      rating: row.rating || null,
      points: row.points || null,
      period: row.reportingYear ? { year: row.reportingYear, month: row.reportingMonth } : null,
    }));
    res.json({ success: true, data: out, count: out.length });
  } catch (error) { next(error); }
}

/**
 * Files the published document for every Finalized TRI that does not have one.
 *
 * `finalize` publishes inside a non-fatal `catch`, so that a render failure can
 * never roll back a reviewer's approval. The price of that choice is that the
 * failure is invisible: the record ends up Finalized, no document is written, and
 * the reviewer is told the TRI was approved. Nothing retries it.
 *
 * That is not hypothetical. `backend/Dockerfile` did not copy
 * `frontend/src/shared/triLayout.json`, which `loadLayout()` reads
 * unconditionally, so every approval on the deployed backend threw `ENOENT` and
 * filed nothing — TRI001, TRI002 and TRI003 were all in that state when it was
 * found on 2026-09-25. The Anecdotal Report's `finalize` avoids the trap by
 * publishing *before* it flips the status; the TRI deliberately does not, because
 * an approval must not be lost to a rendering fault. This is the retry path that
 * decision requires.
 *
 * Idempotent, so it is safe on every boot: a TRI that already has a document is
 * never selected, and `documents.triRecordId` carries a unique index as well. Once
 * the backlog is clear it is a no-op. A per-record failure is logged and skipped —
 * one unrenderable record must not strand the rest.
 *
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ missing: number, filed: number }>}
 */
async function publishMissingTriDocuments({ limit = 50 } = {}) {
  // Inlined rather than bound: MySQL does not accept a placeholder for LIMIT in
  // every form, and this value is never caller-supplied.
  const capped = Math.max(1, Math.min(Number(limit) || 50, 500));

  let rows;
  try {
    [rows] = await pool.query(
      `SELECT t.* FROM triRecords t
         LEFT JOIN documents d ON d.triRecordId = t.id
        WHERE t.status = 'Finalized' AND d.id IS NULL
        ORDER BY t.finalizedAt ASC
        LIMIT ${capped}`
    );
  } catch {
    // `triRecords` is created lazily by `ensureTable()`; a database that has never
    // used the module has nothing to repair, and that is not an error.
    return { missing: 0, filed: 0 };
  }
  if (!rows.length) return { missing: 0, filed: 0 };

  let filed = 0;
  for (const row of rows) {
    try {
      await publishDocumentForTri(mapRecord(row), row.finalizedBy || row.reviewedBy || 'system');
      filed += 1;
    } catch (error) {
      console.error(`[TRI Controller] Backfill: could not file the document for ${row.id}: ${error.message}`);
    }
  }
  return { missing: rows.length, filed };
}

// `publishDocumentForTri` is exported for the idempotency test: approving the same
// record twice must update one Documents entry, and finalize() refuses the second
// attempt before it can be observed over HTTP.
module.exports = { list, getById, getPdf, create, update, submit, review, returnForRevision, finalize, sign, updateSignatories, signOfficialLine, referenceViolations, summary, residentHistory, offenseDeductions, monitor, publishDocumentForTri, publishMissingTriDocuments, OFFICIAL_SIGNATURE_LINES };
