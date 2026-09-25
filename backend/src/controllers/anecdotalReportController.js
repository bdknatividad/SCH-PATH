const { pool } = require('../config/database');
const { activeAdmissionIdFor } = require('../services/admissionLink');
const { insertWithGeneratedId, runInTransactionWithIdRetry } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');
const { canAccessResident } = require('./assignmentController');
const { normalizeRole } = require('../utils/authorization');
const { contentDisposition } = require('../utils/contentDisposition');
const { buildAnecdotalReportDocument } = require('../utils/anecdotalReportPdf');
// Accepted reports are filed in the Anecdotal Reports folder; the folder comes
// from the routing rules so it cannot drift from the rest of the module.
const { folderForType } = require('../utils/documentCategory');
const notifications = require('../services/notificationService');

const ANECDOTAL_FOLDER = folderForType('Anecdotal Report');

const VALID_STATUSES = new Set(['Draft', 'Submitted', 'Under Review', 'Returned', 'Finalized']);

/**
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
 * table, so the Houseparent's signature column — added after the table first
 * shipped — has to be applied separately. Without it, the first save on an
 * existing database fails with "Unknown column 'houseparentSignature'".
 * Checked once per process rather than on every request.
 */
let houseparentSignatureEnsured = false;

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anecdotalReports (
      id VARCHAR(40) PRIMARY KEY,
      residentId VARCHAR(40) NOT NULL,
      reportDate DATE NOT NULL,
      reportYear INT NOT NULL,
      reportMonth INT NOT NULL,
      room VARCHAR(100) NULL,
      houseparentName VARCHAR(150) NULL,
      houseparentSignature LONGTEXT NULL,
      content LONGTEXT NOT NULL,
      status ENUM('Draft','Submitted','Under Review','Returned','Finalized') NOT NULL DEFAULT 'Draft',
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
      UNIQUE KEY uq_anecdotal_resident_period (residentId, reportYear, reportMonth),
      INDEX idx_anecdotal_resident (residentId),
      INDEX idx_anecdotal_period (reportYear, reportMonth),
      CONSTRAINT fk_anecdotal_resident FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  if (houseparentSignatureEnsured) return;
  try {
    await pool.query('ALTER TABLE anecdotalReports ADD COLUMN houseparentSignature LONGTEXT NULL AFTER houseparentName');
    console.log('Migration: anecdotalReports.houseparentSignature added.');
  } catch (err) {
    // Already present — either this database was created with the column, or a
    // previous call added it. Anything else is a real problem and must surface.
    if (!/duplicate column|duplicate field/i.test(err.message)) throw err;
  }
  houseparentSignatureEnsured = true;
}

function role(req) { return normalizeRole(req.user?.role); }
/**
 * Who may review and approve an Anecdotal Report.
 *
 * One definition, used both to gate the reviewer actions and to decide who is
 * told a report is waiting. Those two must not disagree: when the notification
 * named only the Social Worker role, a Center Head could approve a report they
 * were never told about.
 */
const REVIEWER_ROLES = ['socialworker', 'centerhead', 'admin'];
function isReviewer(req) { return REVIEWER_ROLES.includes(role(req)); }
// Roles the UI treats as able to author and submit a report (AnecdotalReports.tsx
// `isReportAuthor`). The backend used to allow only 'houseparent', so a
// centerhead or social worker could fill the form in, see an enabled Submit
// button, and then get a 403 — leaving the report stuck in Draft forever.
const AUTHOR_ROLES = ['houseparent','socialworker','centerhead','admin'];
function isAuthor(req) { return AUTHOR_ROLES.includes(role(req)); }
function asObject(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } }
function map(row) { return row ? { ...row, content: asObject(row.content) } : null; }
async function getOne(id) { const [rows] = await pool.query('SELECT * FROM anecdotalReports WHERE id = ?', [id]); if (!rows[0]) throw new ApiError(404, 'Anecdotal Report not found'); return rows[0]; }

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
// Field order/labels mirror the official form (see `textFields` in the frontend).
const CONTENT_LABELS = [
  ['physical', 'Physical'], ['emotional', 'Emotional'], ['behavioral', 'Behavioral'],
  ['education', 'Education'], ['spiritual', 'Spiritual'], ['productivity', 'Productivity'],
  ['coPeers', 'Relationship with co-peers'], ['staff', 'Relationship with staff'],
  ['groupLiving', 'Group living activities'], ['recommendations', 'Recommendation/s'],
];

/** Flattens the report's JSON content into readable text for the document entry. */
function summarizeContent(content) {
  return CONTENT_LABELS
    .map(([key, label]) => {
      const value = String(asObject(content)[key] || '').trim();
      return value ? `${label}: ${value}` : null;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Every section of the official form must be answered before a report can be
 * submitted. The Houseparent may save an incomplete report as a Draft at any
 * time — this only gates submission.
 *
 * The frontend disables the Submit button on the same rule
 * (`requiredSectionsComplete` in AnecdotalReports.tsx); this is the enforcement,
 * because a disabled button is not an access control.
 */
const REQUIRED_CONTENT_KEYS = CONTENT_LABELS.map(([key]) => key);

/**
 * @param {Object} report A row from `anecdotalReports`.
 * @returns {string[]} human-readable labels of what is still blank, `[]` if complete.
 */
function missingRequiredFields(report) {
  const content = asObject(report?.content);
  const missing = [];
  if (!String(report?.reportDate || '').trim()) missing.push('Report date');
  for (const [key, label] of CONTENT_LABELS) {
    if (!String(content[key] || '').trim()) missing.push(label);
  }
  return missing;
}

/**
 * Notifies every reviewer that a Houseparent's report is waiting for review.
 *
 * **Addressed one row per user, not by role.** A single alert row carries one
 * `targetRole`, so a role-addressed row can only ever reach one role — which is
 * how a Center Head was never told an Anecdotal Report was waiting, even though
 * `isReviewer` lets them approve one. `triController.submit` carries the same fix
 * with the same reviewer set; this was the remaining half of it.
 *
 * The dedupe key is per user as well (`notifyUsers` appends the user id), so a
 * retried submission cannot double-notify anyone, and one reviewer having already
 * seen it does not suppress another's copy.
 *
 * Runs on the caller's executor so the status flip and the notifications commit
 * together. `relatedRecordType`/`relatedRecordId` are what let the notification's
 * View action open the exact report (see Notifications.tsx `getNavigationPath`).
 */
async function notifyReviewersForReview(executor, report, actor) {
  const childName = (await notifications.residentName(report.residentId, executor)) || report.residentId;
  const period = `${MONTH_NAMES[Number(report.reportMonth) - 1] || report.reportMonth} ${report.reportYear}`;
  const reviewers = await notifications.usersWithAnyRole(REVIEWER_ROLES, executor);
  return notifications.notifyUsers(
    reviewers.map((reviewer) => reviewer.id),
    {
      type: 'Anecdotal Report',
      title: 'Anecdotal Report needs review',
      message: `${childName} — ${period} Anecdotal Report was submitted by ${actor} and is waiting for review.`,
      priority: 'High',
      actionRequired: 'Review the Anecdotal Report',
      residentId: report.residentId,
      relatedRecordType: 'Anecdotal Report',
      relatedRecordId: report.id,
      actorUsername: actor,
      dedupeKey: `anecdotal:${report.id}:submitted`,
    },
    executor
  );
}

/**
 * Tells the author what a reviewer decided.
 *
 * Nothing did this before: a Houseparent whose report was returned for revision
 * or finalized was never notified, so the only way to find out was to reopen
 * the Reports page and look.
 *
 * The recipient is the account that submitted the report, addressed by id —
 * not by role, because "the author" is a person and the facility has more than
 * one Houseparent.
 */
async function notifyAuthor(executor, report, { decision, reviewer, note }) {
  const authorId = report.submittedBy || report.createdBy || report.updatedBy;
  if (!authorId) return null;

  const [authors] = await executor.query(
    'SELECT id, username FROM users WHERE username = ? OR id = ? LIMIT 1',
    [authorId, authorId]
  );
  if (authors.length === 0) return null;

  const childName = (await notifications.residentName(report.residentId, executor)) || report.residentId;
  const period = `${MONTH_NAMES[Number(report.reportMonth) - 1] || report.reportMonth} ${report.reportYear}`;

  const copy = {
    Returned: {
      title: 'Anecdotal Report returned for revision',
      message: `${childName} — ${period} Anecdotal Report was returned by ${reviewer}.${note ? ` Note: ${note}` : ''}`,
      actionRequired: 'Revise the report and submit it again',
      priority: 'High',
    },
    Finalized: {
      title: 'Anecdotal Report approved',
      message: `${childName} — ${period} Anecdotal Report was approved by ${reviewer} and published to the resident's Documents.`,
      actionRequired: null,
      priority: 'Medium',
    },
  }[decision];

  return notifications.notify({
    type: 'Anecdotal Report',
    title: copy.title,
    message: copy.message,
    priority: copy.priority,
    actionRequired: copy.actionRequired,
    residentId: report.residentId,
    relatedRecordType: 'Anecdotal Report',
    relatedRecordId: report.id,
    targetUserId: authors[0].id,
    actorUsername: reviewer,
    dedupeKey: `anecdotal:${report.id}:${decision.toLowerCase()}`,
  }, executor);
}

/**
 * Keeps a `documents` row in sync with an Anecdotal Report so an *accepted*
 * report shows up in its resident's Documents module. The report itself lives
 * in `anecdotalReports`, which the Documents module never reads, so without this
 * link the two modules are simply unaware of each other.
 *
 * The entry carries the official form with the filled-up entries overlaid on it
 * (see `utils/anecdotalReportPdf`). Publishing only the flattened text meant the
 * Documents module had no file to preview or download — it could only print the
 * raw text under "Description".
 *
 * Only `finalize` (a reviewer's Accept) publishes. `create: false` refreshes an
 * existing entry without publishing a new one.
 */
async function syncDocumentForReport(report, actor, { create = true } = {}) {
  const [[child]] = await pool.query('SELECT name FROM children WHERE id = ?', [report.residentId]);
  const title = `Anecdotal Report — ${MONTH_NAMES[Number(report.reportMonth) - 1] || report.reportMonth} ${report.reportYear}`;
  // Kept as well: the Documents module shows it in the list and the view dialog,
  // and it is what makes the entry searchable by its contents.
  const description = summarizeContent(report.content);
  const { buffer, fileName, fileSize } = await buildAnecdotalReportDocument(report, child?.name);
  const fileData = buffer.toString('base64');
  const [existing] = await pool.query('SELECT id FROM documents WHERE anecdotalReportId = ? LIMIT 1', [report.id]);
  // Who submitted the report, not who accepted it: the Documents module shows
  // "Submitted By" per file, and the reviewer is recorded separately as the
  // approver. Falls back to the creator for reports that never went through
  // the submit step.
  const submittedBy = report.submittedBy || report.createdBy || actor;
  // The entry is published as Approved, so it carries the approval with it:
  // `approvedBy`/`approvedAt` are what the Documents module prints under
  // "Approved By" / "Approval Date". The report is finalized *after* this runs,
  // so the actor is the reviewer accepting it; `finalizedBy` is honoured when a
  // re-publish happens on an already-finalized report.
  const approver = report.finalizedBy || actor;
  const reviewer = report.reviewedBy || approver;
  if (existing.length) {
    await pool.query(
      `UPDATE documents SET title = ?, description = ?, residentName = ?, fileName = ?, fileSize = ?, fileType = ?, fileData = ?, documentCategory = ?,
       approvedBy = ?, approvedAt = NOW(), reviewedBy = ?, reviewedAt = NOW(),
       submittedBy = ?, modifiedBy = ? WHERE id = ?`,
      [title, description, child?.name || null, fileName, fileSize, 'application/pdf', fileData, ANECDOTAL_FOLDER,
        approver, reviewer, submittedBy, actor, existing[0].id]
    );
    return existing[0].id;
  }
  if (!create) return null;
  // Filed under the admission the resident is currently in, so a report written
  // after a re-intake never lands in an earlier admission's folder.
  const admissionId = await activeAdmissionIdFor(pool, report.residentId);
  return insertWithGeneratedId(pool, {
    table: 'documents',
    prefix: 'DOC',
    insert: (id) => pool.query(
      `INSERT INTO documents (id, residentId, admissionId, residentName, title, type, category, documentCategory, description, fileName, fileSize, fileType, fileData, status, submittedBy, uploadedBy, uploadedAt, approvedBy, approvedAt, reviewedBy, reviewedAt, anecdotalReportId, createdBy, modifiedBy)
       VALUES (?, ?, ?, ?, ?, 'Anecdotal Report', 'Anecdotal', ?, ?, ?, ?, 'application/pdf', ?, 'Approved', ?, ?, NOW(), ?, NOW(), ?, NOW(), ?, ?, ?)`,
      [id, report.residentId, admissionId, child?.name || null, title, ANECDOTAL_FOLDER, description, fileName, fileSize, fileData,
        submittedBy, actor, approver, reviewer, report.id, actor, actor]
    ),
  });
}

/**
 * Removes the Documents-module entry that mirrors an Anecdotal Report.
 *
 * Called when a reviewer rejects a report: a rejected report is not part of the
 * resident's official record, so it must not be left sitting in their Documents
 * folder. The row is a derived artifact — regenerated from `anecdotalReports` on
 * the next accept — so removing it destroys nothing that cannot be rebuilt.
 *
 * @param {string} reportId
 * @param {string} actor
 * @returns {Promise<number>} how many entries were removed.
 */
async function unpublishDocumentForReport(reportId, actor) {
  const [existing] = await pool.query('SELECT id FROM documents WHERE anecdotalReportId = ?', [reportId]);
  if (!existing.length) return 0;
  await pool.query('DELETE FROM documents WHERE anecdotalReportId = ?', [reportId]);
  console.log(`Anecdotal Report ${reportId}: removed ${existing.length} published document(s) after rejection by ${actor}.`);
  return existing.length;
}

async function assertResidentAccess(req, residentId, write = false) {
  if (isReviewer(req)) return true;
  if (role(req) !== 'houseparent') throw new ApiError(403, 'Only Houseparents can create or edit Anecdotal Reports.');
  const allowed = await canAccessResident(req.user, residentId, { write });
  if (!allowed) throw new ApiError(403, 'You can only access residents assigned to your Houseparent caseload.');
  return true;
}

async function list(req, res, next) {
  try {
    await ensureTable();
    const { year, month, status, residentId } = req.query;
    const where = [];
    const params = [];
    if (year) { where.push('reportYear = ?'); params.push(Number(year)); }
    if (month) { where.push('reportMonth = ?'); params.push(Number(month)); }
    if (status) { where.push('status = ?'); params.push(status); }
    if (residentId) { where.push('residentId = ?'); params.push(residentId); }
    const [rows] = await pool.query(`SELECT * FROM anecdotalReports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY reportYear DESC, reportMonth DESC, updatedAt DESC`, params);
    const filtered = [];
    for (const row of rows) {
      if (isReviewer(req)) filtered.push(map(row));
      else if (role(req) === 'houseparent' && await canAccessResident(req.user, row.residentId, { write: false })) filtered.push(map(row));
    }
    res.json({ success: true, data: filtered });
  } catch (error) { next(error); }
}

async function getById(req, res, next) {
  try {
    await ensureTable();
    const row = await getOne(req.params.id);
    await assertResidentAccess(req, row.residentId, false);
    res.json({ success: true, data: map(row) });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    if (role(req) === 'socialworker') throw new ApiError(403, 'Social Workers cannot create a new Anecdotal Report from the Houseparent module.');
    await ensureTable();
    const { residentId, reportDate, room, houseparentName, houseparentSignature, content } = req.body || {};
    if (!residentId || !reportDate) throw new ApiError(400, 'Resident and report date are required.');
    await assertResidentAccess(req, residentId, true);
    const d = new Date(`${String(reportDate).slice(0,10)}T00:00:00`);
    if (Number.isNaN(d.getTime())) throw new ApiError(400, 'Invalid report date.');
    const year = d.getFullYear(); const month = d.getMonth() + 1;
    const [existing] = await pool.query('SELECT id, status FROM anecdotalReports WHERE residentId = ? AND reportYear = ? AND reportMonth = ? ORDER BY createdAt DESC LIMIT 1', [residentId, year, month]);
    if (existing.length) {
      const status = existing[0].status;
      if (status === 'Returned' || status === 'Draft') {
        throw new ApiError(409, 'An Anecdotal Report already exists for this resident and month. The existing Draft/Returned report must be edited and resubmitted.');
      }
      throw new ApiError(409, 'An Anecdotal Report already exists for this resident and month. Another report cannot be created unless the existing report is returned for revision.');
    }
    const actor = req.user?.username || req.user?.name || 'System';
    // Two concurrent creates can derive the same id; retry instead of 500.
    const id = await insertWithGeneratedId(pool, {
      table: 'anecdotalReports',
      prefix: 'ANR',
      insert: (generatedId) => pool.query(
        `INSERT INTO anecdotalReports (id,residentId,reportDate,reportYear,reportMonth,room,houseparentName,houseparentSignature,content,status,createdBy,updatedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [generatedId, residentId, String(reportDate).slice(0, 10), year, month, room || null, houseparentName || actor, houseparentSignature || null, JSON.stringify(content || {}), 'Draft', actor, actor]
      ),
    });
    res.status(201).json({ success: true, data: map(await getOne(id)) });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  try {
    await ensureTable();
    const row = await getOne(req.params.id);
    // Reviewers (social worker / center head / admin) may edit anything not yet
    // finalized; a Houseparent may edit their own Draft or a report returned to
    // them. The previous rule allowed a reviewer to edit only
    // Submitted/Under Review/Returned, so a center head or social worker who had
    // just created a Draft could not save it at all — and because the client
    // PUTs before it submits, that 409 is what made Submit appear to do nothing.
    const EDITABLE_BY_AUTHOR = ['Draft', 'Returned'];
    const EDITABLE_BY_REVIEWER = ['Draft', 'Returned', 'Submitted', 'Under Review'];
    const currentEditable = isReviewer(req)
      ? EDITABLE_BY_REVIEWER.includes(row.status)
      : isAuthor(req) && EDITABLE_BY_AUTHOR.includes(row.status);
    if (!currentEditable) throw new ApiError(409, 'This Anecdotal Report is no longer editable.');
    await assertResidentAccess(req, row.residentId, true);
    const { reportDate, room, houseparentName, houseparentSignature, content } = req.body || {};
    const d = reportDate ? new Date(`${String(reportDate).slice(0,10)}T00:00:00`) : new Date(row.reportDate);
    if (Number.isNaN(d.getTime())) throw new ApiError(400, 'Invalid report date.');
    const actor = req.user?.username || req.user?.name || 'System';
    await pool.query(`UPDATE anecdotalReports SET reportDate=?, reportYear=?, reportMonth=?, room=?, houseparentName=?, houseparentSignature=?, content=?, updatedBy=? WHERE id=?`, [String(reportDate || row.reportDate).slice(0,10),d.getFullYear(),d.getMonth()+1,room ?? row.room,houseparentName ?? row.houseparentName,houseparentSignature ?? row.houseparentSignature,JSON.stringify(content || row.content || {}),actor,row.id]);
    // Deliberately no Documents sync here. An accepted (Finalized) report is not
    // editable, so nothing that can be edited has a published document to
    // refresh — and the previous "refresh if one exists" call would have kept a
    // not-yet-accepted report visible in the child's folder.
    res.json({ success: true, data: map(await getOne(row.id)) });
  } catch (error) { next(error); }
}

/**
 * Author submits a Draft or a Returned report for review.
 *
 * Submitting deliberately does NOT publish anything to the resident's Documents
 * folder — it only puts the report in the reviewer's "Needs Review" queue. The
 * PDF is written when a reviewer approves it (see `finalize`), so a report that
 * is rejected never reaches the child's official record.
 *
 * Three things happen here that did not before:
 *
 * 1. The report must be complete. A Houseparent can save a half-finished report
 *    as a Draft freely, but submission requires every section of the official
 *    form, so the reviewer never receives a blank one.
 * 2. The status flip is a *conditional* UPDATE. Two concurrent submissions (a
 *    double-click, or a retried request) used to both succeed, because the
 *    status was read and then written without a guard — the second write
 *    re-stamped `submittedAt` and produced a second notification. Now the second
 *    one matches no row and is rejected with 409.
 * 3. The status flip and its notification commit together. A submission that
 *    silently failed to notify would leave the reviewer with nothing to review
 *    and no way to know.
 */
async function submit(req, res, next) {
  try {
    await ensureTable();
    const row = await getOne(req.params.id);
    if (!isAuthor(req)) throw new ApiError(403, 'Only report authors can submit Anecdotal Reports.');
    await assertResidentAccess(req, row.residentId, true);
    if (!['Draft', 'Returned'].includes(row.status)) throw new ApiError(409, 'Only Draft or Returned Anecdotal Reports can be submitted.');

    const missing = missingRequiredFields(row);
    if (missing.length) {
      throw new ApiError(400, `Complete every section of the report before submitting. Still blank: ${missing.join(', ')}.`);
    }

    const actor = req.user?.username || req.user?.name || 'Houseparent';

    await runInTransactionWithIdRetry(pool, async (connection) => {
      const [result] = await connection.query(
        `UPDATE anecdotalReports SET status='Submitted', submittedBy=?, submittedAt=NOW(), updatedBy=?
         WHERE id=? AND status IN ('Draft','Returned')`,
        [actor, actor, row.id]
      );
      // Lost the race with another submission of the same report.
      if (result.affectedRows === 0) {
        throw new ApiError(409, 'This Anecdotal Report has already been submitted.');
      }
      await notifyReviewersForReview(connection, row, actor);
    });

    res.json({ success: true, data: map(await getOne(row.id)) });
  } catch (error) { next(error); }
}
async function review(req,res,next){ try{await ensureTable();const row=await getOne(req.params.id);if(!isReviewer(req))throw new ApiError(403,'Only Social Worker reviewers can review Anecdotal Reports.');if(row.status!=='Submitted')throw new ApiError(409,'Only submitted Anecdotal Reports can enter review.');const actor=req.user?.username||req.user?.name||'Reviewer';await pool.query(`UPDATE anecdotalReports SET status='Under Review',reviewedBy=?,reviewedAt=NOW(),updatedBy=? WHERE id=?`,[actor,actor,row.id]);res.json({success:true,data:map(await getOne(row.id))});}catch(error){next(error);} }

/**
 * Statuses a reviewer may act on directly.
 *
 * `Under Review` used to be mandatory, which forced the reviewer through a
 * separate "Start Review" step before Accept/Reject appeared — and an
 * "Approve" that is not offered on the report the reviewer is looking at is not
 * really an approval action. Approving straight from `Submitted` records the
 * reviewer on the report, so nothing is lost by skipping the intermediate state.
 * `Under Review` is still accepted for reports already sitting in it.
 */
const REVIEWABLE_STATUSES = ['Submitted', 'Under Review'];

/**
 * Reviewer rejects the report: it goes back to its author and is NOT published.
 *
 * The status becomes `Returned` so the author can revise and resubmit; what
 * matters here is that the resident's Documents folder is left untouched — any
 * entry published earlier for this report is removed.
 */
async function returnForRevision(req, res, next) {
  try {
    await ensureTable();
    const row = await getOne(req.params.id);
    if (!isReviewer(req)) throw new ApiError(403, 'Only Social Worker reviewers can return Anecdotal Reports.');
    if (!REVIEWABLE_STATUSES.includes(row.status)) throw new ApiError(409, 'Only submitted reports can be rejected.');
    const notes = String(req.body?.reviewNotes || '').trim();
    if (!notes) throw new ApiError(400, 'Review notes are required.');
    const actor = req.user?.username || req.user?.name || 'Reviewer';
    await unpublishDocumentForReport(row.id, actor);
    await pool.query(`UPDATE anecdotalReports SET status='Returned',reviewNotes=?,updatedBy=? WHERE id=?`, [notes, actor, row.id]);

    // Best-effort: a failed notification must not undo a decision that has
    // already taken effect, so this never throws into the response path.
    try {
      await notifyAuthor(pool, { ...row, reviewNotes: notes }, { decision: 'Returned', reviewer: actor, note: notes });
    } catch (notifyError) {
      console.error('[Anecdotal] return notification failed (non-fatal):', notifyError.message);
    }

    res.json({ success: true, data: map(await getOne(row.id)) });
  } catch (error) { next(error); }
}

/**
 * Reviewer approves the report. This is the only place a report is published to
 * the resident's Documents folder, and the file is the official form with the
 * filled-up entries overlaid on it.
 *
 * Publishing first and flipping the status second keeps the pair recoverable:
 * if the PDF cannot be built, the report stays reviewable and Approve can
 * simply be retried — rather than ending up `Finalized` with no document and no
 * way to re-run the publish.
 */
async function finalize(req, res, next) {
  try {
    await ensureTable();
    const row = await getOne(req.params.id);
    if (!isReviewer(req)) throw new ApiError(403, 'Only Social Worker reviewers can finalize Anecdotal Reports.');
    if (!REVIEWABLE_STATUSES.includes(row.status)) throw new ApiError(409, 'Only submitted reports can be approved.');
    const actor = req.user?.username || req.user?.name || 'Reviewer';
    const documentId = await syncDocumentForReport(row, actor);
    // COALESCE keeps the original reviewer when the report already passed
    // through `review`; approving straight from Submitted fills both in.
    await pool.query(
      `UPDATE anecdotalReports
         SET status='Finalized', finalizedBy=?, finalizedAt=NOW(),
             reviewedBy=COALESCE(reviewedBy, ?), reviewedAt=COALESCE(reviewedAt, NOW()),
             updatedBy=?
       WHERE id=?`,
      [actor, actor, actor, row.id]
    );

    // Best-effort, and deliberately after the status write: a notification
    // failure must not leave the report reviewable when it has been approved.
    try {
      await notifyAuthor(pool, row, { decision: 'Finalized', reviewer: actor });
    } catch (notifyError) {
      console.error('[Anecdotal] approval notification failed (non-fatal):', notifyError.message);
    }

    res.json({ success: true, data: map(await getOne(row.id)), documentId });
  } catch (error) { next(error); }
}

/**
 * Streams the official Anecdotal Report PDF for a report — byte-for-byte the
 * same document that is stored on the resident's Documents entry once the
 * report is accepted.
 *
 * Exists so the reviewer can Download from the Needs Review queue, and the
 * author can Download from the editor, without either client rebuilding the
 * overlay itself: one generator, one output.
 */
async function getPdf(req, res, next) {
  try {
    await ensureTable();
    const row = await getOne(req.params.id);
    await assertResidentAccess(req, row.residentId, false);
    const [[child]] = await pool.query('SELECT name FROM children WHERE id = ?', [row.residentId]);
    const { buffer, fileName } = await buildAnecdotalReportDocument(row, child?.name);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', contentDisposition(fileName, 'attachment'));
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(buffer);
  } catch (error) { next(error); }
}

module.exports = {
  list, getById, create, update, submit, review, returnForRevision, finalize, getPdf,
  // Exported for tests: the submission completeness rule is enforced in the API
  // and mirrored in the UI, and the two must not drift.
  REQUIRED_CONTENT_KEYS, missingRequiredFields, REVIEWABLE_STATUSES,
};
