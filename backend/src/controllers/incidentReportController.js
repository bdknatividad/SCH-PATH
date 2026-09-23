/**
 * Incident Report Controller
 * @module controllers/incidentReportController
 * @description Digital version of Form 08 (Second Chance Home Incident Report).
 *              A Social Worker fills this out and saves it against a violation
 *              record; a Psychologist then reviews and verifies it, at which
 *              point they can attach a Psycho-Social Activity intervention and
 *              a schedule date.
 */

const { pool } = require('../config/database');
const { activeAdmissionIdFor } = require('../services/admissionLink');
const { generateId, runInTransactionWithIdRetry } = require('../utils/helpers');
const notifications = require('../services/notificationService');
const { canAccessResident } = require('./assignmentController');
const { ApiError } = require('../middleware/errorHandler');
// An Incident Report is a violation record, so it is filed in the Violation
// Records folder. Resolved from the routing rules rather than written as a
// literal so renaming a folder in the JSON cannot strand these documents.
const { folderForType } = require('../utils/documentCategory');
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const VIOLATION_FOLDER = folderForType('Violation Report');

/**
 * Map a raw DB row to the API shape, parsing the reportTypes JSON column.
 */
function mapIncidentReport(row) {
  if (!row) return null;
  let reportTypes = [];
  try {
    reportTypes = typeof row.reportTypes === 'string' ? JSON.parse(row.reportTypes) : (row.reportTypes || []);
  } catch {
    reportTypes = [];
  }
  return { ...row, reportTypes, statusLabel: row.status === 'Failed' ? 'Failed' : row.status === 'Reassessment' ? 'For Reassessment' : row.status };
}

function escapePdfText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ');
}

function formatIncidentDateTime(value) {
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours() % 12 || 12)}:${pad(d.getMinutes())} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
}

function wrapText(text, maxChars) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function findIncidentReportTemplate() {
  const candidates = [
    path.resolve(__dirname, '../../../frontend/public/forms/incident-report.pdf'),
    path.resolve(process.cwd(), '../frontend/public/forms/incident-report.pdf'),
    path.resolve(process.cwd(), 'frontend/public/forms/incident-report.pdf'),
  ];
  const hit = candidates.find((candidate) => fs.existsSync(candidate));
  if (!hit) throw new Error('Official incident-report.pdf was not found in frontend/public/forms.');
  return hit;
}

/**
 * Where each of Form 08's four sign-offs is stamped, in the template's
 * top-left coordinate space.
 *
 * Measured against frontend/public/forms/incident-report.pdf: the printed name
 * for each sign-off already sits on its own blank rule, and every box below is
 * the blank band directly above that rule's label. The signature therefore
 * lands on the line as "Signature over Printed Name" intends, and never covers
 * the divider rule above it.
 */
const FORM08_SIGNATURE_BOXES = {
  reportedBy: { x: 98, top: 654, width: 152, height: 32 },
  endorsedTo: { x: 387, top: 654, width: 158, height: 32 },
  checkedBy: { x: 36, top: 722, width: 138, height: 32 },
  notedBy: { x: 360, top: 722, width: 167, height: 32 },
};

const FORM08_CHECKED_BY_NAME = 'Francis C. Patricio, RSW';
const FORM08_CHECKED_BY_ROLE = 'SWO I - Case Manager';
const FORM08_NOTED_BY_NAME = 'Maricor C. Navarro, RSW';
const FORM08_NOTED_BY_ROLE = 'SWO II - Center Head';

/**
 * Fills the exact official incident-report.pdf template. The source page is
 * loaded unchanged; only text/checkmark/signature overlays are added on top.
 */
async function buildForm08Pdf({
  childName, incidentDateTime, reportTypes, othersSpecify, summary, actionTaken, result,
  reportedBy, endorsedTo, checkedBy, notedBy,
  reportedBySignature, endorsedToSignature, checkedBySignature, notedBySignature,
}) {
  const template = await fs.promises.readFile(findIncidentReportTemplate());
  const pdfDoc = await PDFDocument.load(template);
  const page = pdfDoc.getPage(0);
  const { width, height } = page.getSize();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const drawTextTop = (value, x, top, size = 9, bold = false, opts = {}) => {
    const text = String(value ?? '').trim();
    if (!text) return;
    page.drawText(text, {
      x,
      y: height - top - size,
      size,
      font: bold ? helveticaBold : helvetica,
      color: opts.color || rgb(0, 0, 0),
      maxWidth: opts.maxWidth,
      lineHeight: opts.lineHeight || size + 2,
    });
  };

  /**
   * Stamps a drawn signature into `box`, scaled to fit and centred. A missing
   * or unusable value is skipped rather than thrown, so one unsigned line can
   * never stop the form being filed.
   */
  const drawSignatureTop = async (dataUrl, box) => {
    const value = String(dataUrl || '');
    const match = value.match(/^data:image\/(png|jpeg|jpg);base64,/i);
    if (!match || !box) return false;
    try {
      const image = match[1].toLowerCase() === 'png'
        ? await pdfDoc.embedPng(value)
        : await pdfDoc.embedJpg(value);
      const fit = Math.min(box.width / image.width, box.height / image.height);
      const drawWidth = image.width * fit;
      const drawHeight = image.height * fit;
      page.drawImage(image, {
        x: box.x + (box.width - drawWidth) / 2,
        y: height - box.top - drawHeight - (box.height - drawHeight) / 2,
        width: drawWidth,
        height: drawHeight,
      });
      return true;
    } catch {
      return false;
    }
  };

  const drawMultilineTop = (value, x, firstTop, size, maxWidth, lineHeight, maxLines) => {
    const lines = wrapText(value, Math.max(10, Math.floor(maxWidth / (size * 0.52)))).slice(0, maxLines);
    lines.forEach((line, idx) => drawTextTop(line, x, firstTop + idx * lineHeight, size, false));
  };

  const check = (x, top) => {
    const y = height - top - 9;
    page.drawLine({ start: { x, y: y + 3 }, end: { x: x + 3, y: y }, thickness: 1.1, color: rgb(0,0,0) });
    page.drawLine({ start: { x: x + 3, y: y }, end: { x: x + 8, y: y + 7 }, thickness: 1.1, color: rgb(0,0,0) });
  };

  // Name / datetime lines from the official PDF's actual coordinates.
  drawTextTop(childName, 118, 140.7, 9, false, { maxWidth: 235 });
  drawTextTop(formatIncidentDateTime(incidentDateTime), 448, 140.7, 9, false, { maxWidth: 112 });

  const typePositions = {
    'Quarrelling': [74, 179.8],
    'Stealing': [349, 179.8],
    'Threatening Others': [74, 193.2],
    'Runaway': [349, 193.2],
    'Accident': [74, 206.5],
    'Serious Illness': [349, 206.5],
    'Discovery of substance used': [74, 219.7],
    'Unusual Sexual Behavior': [349, 219.7],
  };
  for (const type of reportTypes || []) {
    const pos = typePositions[type];
    if (pos) check(pos[0], pos[1]);
  }
  if ((reportTypes || []).includes('Other')) {
    check(34, 231.8);
    drawTextTop(othersSpecify, 121, 232, 8.5, false, { maxWidth: 315 });
  }

  drawMultilineTop(summary, 38, 282.0, 8.5, 537, 16.8, 8);
  drawMultilineTop(actionTaken, 38, 450.0, 8.5, 537, 16.8, 5);
  drawMultilineTop(result, 38, 573.2, 8.5, 537, 16.8, 5);

  drawTextTop(reportedBy, 99, 687.6, 8.5, false, { maxWidth: 150 });
  drawTextTop(endorsedTo, 388, 687.6, 8.5, false, { maxWidth: 155 });
  drawTextTop(FORM08_CHECKED_BY_NAME, 37, 776.4, 8.5, true, { maxWidth: 180 });
  drawTextTop(FORM08_CHECKED_BY_ROLE, 37, 789.0, 8.5, false, { maxWidth: 180 });
  drawTextTop(FORM08_NOTED_BY_NAME, 361, 776.4, 8.5, true, { maxWidth: 180 });
  drawTextTop(FORM08_NOTED_BY_ROLE, 361, 789.0, 8.5, false, { maxWidth: 180 });

  // The four sign-offs, each stamped above its own printed name. A line with no
  // signature drawn simply keeps the printed name, exactly as before.
  await drawSignatureTop(reportedBySignature, FORM08_SIGNATURE_BOXES.reportedBy);
  await drawSignatureTop(endorsedToSignature, FORM08_SIGNATURE_BOXES.endorsedTo);
  await drawSignatureTop(checkedBySignature, FORM08_SIGNATURE_BOXES.checkedBy);
  await drawSignatureTop(notedBySignature, FORM08_SIGNATURE_BOXES.notedBy);

  return Buffer.from(await pdfDoc.save());
}

/**
 * POST /api/incident-reports
 * Create the digital incident report for an already-created violation.
 * Body: { violationId, residentId, reportTypes, othersSpecify, incidentDateTime,
 *         summary, actionTaken, result, reportedBy, endorsedTo, checkedBy, notedBy }
 */
async function create(req, res, next) {
  try {
    const {
      violationId, residentId, reportTypes, othersSpecify, incidentDateTime,
      summary, actionTaken, result, reportedBy, endorsedTo, checkedBy, notedBy,
      reportedBySignature, endorsedToSignature, checkedBySignature, notedBySignature,
    } = req.body || {};

    if (!violationId) throw new ApiError(400, 'violationId is required');
    if (!residentId) throw new ApiError(400, 'residentId is required');
    if (!incidentDateTime) throw new ApiError(400, 'incidentDateTime is required');
    if (!Array.isArray(reportTypes) || reportTypes.length === 0) throw new ApiError(400, 'At least one report type is required');
    if (reportTypes.includes('Other') && !String(othersSpecify || '').trim()) {
      throw new ApiError(400, 'Please specify the "Other" type of report.');
    }
    if (!String(summary || '').trim()) throw new ApiError(400, 'Incident summary is required');

    const [violations] = await pool.query(
      'SELECT id, residentId, status FROM violations WHERE id = ? LIMIT 1',
      [violationId]
    );
    if (violations.length === 0) throw new ApiError(404, 'Violation not found');
    if (String(violations[0].residentId) !== String(residentId)) {
      throw new ApiError(422, 'Incident resident does not match the violation resident');
    }

    // Form 08 becomes available after ALL requirements are completed, but
    // BEFORE Mark Done. The violation's actual workflow status is preserved.
    const [trackerRows] = await pool.query(
      `SELECT id, status
       FROM intervention_tracker
       WHERE violationId = ?
       ORDER BY createdAt ASC`,
      [violationId]
    );
    if (!trackerRows.length || trackerRows.some((row) => row.status !== 'Completed')) {
      throw new ApiError(409, 'Complete all intervention requirements before filling out Incident Report (Form 08).');
    }

    const completedInterventionId = trackerRows[trackerRows.length - 1].id;
    const [duplicate] = await pool.query('SELECT id FROM incidentReports WHERE violationId = ? LIMIT 1', [violationId]);
    if (duplicate.length > 0) throw new ApiError(409, 'An incident report already exists for this violation');

    const [childRows] = await pool.query('SELECT name FROM children WHERE id = ?', [residentId]);
    if (!childRows.length) throw new ApiError(404, 'Resident not found');
    const childName = childRows[0].name;
    const [admissionRows] = await pool.query(
      'SELECT admissionNumber, admissionDate, status FROM admissions WHERE residentId = ? ORDER BY admissionNumber DESC LIMIT 1',
      [residentId]
    );
    const admissionNumber = admissionRows[0]?.admissionNumber || null;
    const uploader = req.user?.username || reportedBy || 'Staff';

    // The Form 08 record and the PDF it generates live in two different tables.
    // They must be created together: an orphan PDF in the resident's document
    // folder, or an incidentReports row pointing at a document that was never
    // written, cannot be repaired through the UI.
    //
    // Both ids are derived from the current maximum, so two simultaneous Form 08
    // saves can compute the same one and the loser's INSERT fails on a duplicate
    // primary key. The ids are therefore allocated *inside* the retried unit —
    // allocating them before the transaction, as this used to, would make the
    // retry reuse the colliding id forever. The id reads deliberately run on the
    // pool rather than on the transaction connection: an autocommit read always
    // sees the latest committed row, so the retry picks up the id the winner
    // took. (A locking read would deadlock here — see runInTransactionWithIdRetry.)
    const { newId, documentId } = await runInTransactionWithIdRetry(pool, async (connection) => {
      const [existing] = await pool.query('SELECT id FROM incidentReports');
      const incidentId = generateId('INC', existing.map(r => ({ id: r.id })));

      const pdfBuffer = await buildForm08Pdf({
        childName, incidentDateTime, reportTypes, othersSpecify, summary, actionTaken, result,
        reportedBy, endorsedTo, checkedBy, notedBy,
        reportedBySignature, endorsedToSignature, checkedBySignature, notedBySignature,
      });
      const pdfFileName = `Incident-Report-${incidentId}.pdf`;
      const [docRows] = await pool.query('SELECT id FROM documents');
      const docId = generateId('DOC', docRows.map(r => ({ id: r.id })));

      // Filed under the admission the resident is currently in, so a Form 08
      // raised after a re-intake never lands in an earlier admission's folder.
      const admissionId = await activeAdmissionIdFor(connection, residentId);

      await connection.query(
        `INSERT INTO documents
          (id, residentId, admissionId, residentName, title, type, category, documentCategory, description, fileName, fileSize, fileData, fileType, uploaderRole, status, phase, submittedBy, submittedAt, uploadedBy, uploadedAt, createdBy, modifiedBy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?, NOW(), ?, NOW(), ?, ?)`,
        [docId, residentId, admissionId, childName, 'Incident Report', 'PDF', 'Incident Reports', VIOLATION_FOLDER,
         `Admission #${admissionNumber || '—'} — Incident Reports — Official Incident Report (Form 08) for ${childName} — violation ${violationId}`, pdfFileName, pdfBuffer.length, pdfBuffer.toString('base64'), 'application/pdf',
         req.user?.role || 'socialworker', admissionNumber ? `Admission #${admissionNumber}` : null, uploader, uploader, uploader, uploader]
      );

      await connection.query(
        `INSERT INTO incidentReports
          (id, violationId, residentId, interventionTrackerId, reportTypes, othersSpecify, incidentDateTime,
           summary, actionTaken, result, reportedBy, endorsedTo, checkedBy, notedBy,
           reportedBySignature, endorsedToSignature, checkedBySignature, notedBySignature,
           status, pdfDocumentId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?)`,
        [
          incidentId, violationId, residentId, completedInterventionId, JSON.stringify(reportTypes || []), othersSpecify || null,
          incidentDateTime, summary || null, actionTaken || null, result || null,
          reportedBy || null, endorsedTo || null, FORM08_CHECKED_BY_NAME, FORM08_NOTED_BY_NAME,
          reportedBySignature || null, endorsedToSignature || null, checkedBySignature || null, notedBySignature || null,
          docId,
        ]
      );

      return { newId: incidentId, documentId: docId };
    });

    const [rows] = await pool.query('SELECT * FROM incidentReports WHERE id = ?', [newId]);

    // Form 08 is filed by a Social Worker and verified by a Psychologist, so
    // the verifier is the one who needs to be told it is waiting. Until now the
    // only signal was a status column on a page nobody had a reason to open.
    try {
      await notifications.notify({
        type: 'Incident Report',
        residentId,
        title: `Incident Report (Form 08) to Verify - ${childName}`,
        message: `${uploader} filed the Form 08 Incident Report for ${childName}. It is waiting for verification.`,
        priority: 'High',
        actionRequired: 'Verify the incident report and set the intervention schedule.',
        relatedRecordType: 'incidentReports',
        relatedRecordId: newId,
        targetRole: 'psychologist',
        actorUsername: uploader,
        dedupeKey: `incident-report:${newId}:submitted`,
      });
    } catch (notifyErr) {
      console.error('[IncidentReportController] Submission notification failed (non-fatal):', notifyErr.message);
    }

    res.status(201).json({ success: true, data: mapIncidentReport(rows[0]), documentId, message: 'Incident Report saved as PDF in the resident Documents folder.' });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/incident-reports/:id/resubmit
 * Re-submit a failed/reassessment Form 08 after the preparer makes corrections.
 * The same Incident Report and linked document are updated so the intervention
 * never becomes complete merely because a failed report was edited.
 */
async function resubmit(req, res, next) {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM incidentReports WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) throw new ApiError(404, 'Incident report not found');
    const existing = rows[0];
    if (!['Failed', 'Reassessment'].includes(existing.status)) {
      throw new ApiError(409, 'Only failed or reassessment Incident Reports can be resubmitted.');
    }
    if (!await canEditIncidentReport(req.user, existing)) {
      throw new ApiError(403, 'You are not assigned to this resident.');
    }

    const {
      reportTypes, othersSpecify, incidentDateTime, summary, actionTaken, result,
      reportedBy, endorsedTo, checkedBy, notedBy,
      reportedBySignature, endorsedToSignature, checkedBySignature, notedBySignature,
    } = req.body || {};
    if (!Array.isArray(reportTypes) || reportTypes.length === 0) throw new ApiError(400, 'At least one report type is required');
    if (reportTypes.includes('Other') && !String(othersSpecify || '').trim()) throw new ApiError(400, 'Please specify the "Other" type of report.');
    if (!incidentDateTime) throw new ApiError(400, 'incidentDateTime is required');
    if (!String(summary || '').trim()) throw new ApiError(400, 'Incident summary is required');

    const [childRows] = await pool.query('SELECT name FROM children WHERE id = ?', [existing.residentId]);
    if (!childRows.length) throw new ApiError(404, 'Resident not found');
    const childName = childRows[0].name;
    const [admissionRows] = await pool.query(
      'SELECT admissionNumber FROM admissions WHERE residentId = ? ORDER BY admissionNumber DESC LIMIT 1',
      [existing.residentId]
    );
    const admissionNumber = admissionRows[0]?.admissionNumber || null;
    const actor = req.user?.username || reportedBy || 'Staff';
    const pdfBuffer = await buildForm08Pdf({
      childName, incidentDateTime, reportTypes, othersSpecify, summary, actionTaken, result,
      reportedBy, endorsedTo, checkedBy, notedBy,
      reportedBySignature, endorsedToSignature, checkedBySignature, notedBySignature,
    });
    const pdfFileName = `Incident-Report-${existing.id}.pdf`;

    await pool.query(
      `UPDATE incidentReports
       SET reportTypes = ?, othersSpecify = ?, incidentDateTime = ?, summary = ?, actionTaken = ?, result = ?,
           reportedBy = ?, endorsedTo = ?, checkedBy = ?, notedBy = ?,
           reportedBySignature = ?, endorsedToSignature = ?, checkedBySignature = ?, notedBySignature = ?,
           status = 'Submitted', interventionType = NULL, interventionScheduleDate = NULL,
           verifiedBy = NULL, verifiedAt = NULL, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [JSON.stringify(reportTypes), othersSpecify || null, String(incidentDateTime).replace('T', ' '), summary || null,
       actionTaken || null, result || null, reportedBy || null, endorsedTo || null,
       checkedBy || FORM08_CHECKED_BY_NAME, notedBy || FORM08_NOTED_BY_NAME,
       reportedBySignature || null, endorsedToSignature || null, checkedBySignature || null, notedBySignature || null, id]
    );

    if (existing.pdfDocumentId) {
      // The previous rejection is deliberately kept: it is the document's most
      // recent review outcome, the Documents folder view shows the rejected-by
      // and rejection date, and the audit trail holds every rejection. Only the
      // decision fields for the *current* cycle are cleared.
      await pool.query(
        `UPDATE documents SET title = 'Incident Report', status = 'Submitted',
         reviewedBy = NULL, reviewedAt = NULL, approvedBy = NULL, approvedAt = NULL,
         fileName = ?, fileSize = ?, fileData = ?, fileType = 'application/pdf', modifiedBy = ?,
         documentCategory = ?, submittedBy = ?, submittedAt = NOW(), uploadedBy = ?, uploadedAt = NOW()
         WHERE id = ?`,
        [pdfFileName, pdfBuffer.length, pdfBuffer.toString('base64'), actor, VIOLATION_FOLDER, actor, actor, actor, existing.pdfDocumentId]
      );
    }

    const [updatedRows] = await pool.query('SELECT * FROM incidentReports WHERE id = ?', [id]);
    const updated = updatedRows[0];
    try {
      const reviewer = await notifications.usersWithAnyRole(['psychologist', 'centerhead']);
      await notifications.notifyUsers(reviewer.map((u) => u.id), {
        type: 'Incident Report Resubmitted',
        title: `Incident Report Resubmitted - ${childName}`,
        message: `${actor} corrected and resubmitted the Incident Report for ${childName}. It is waiting for review again.`,
        priority: 'High',
        actionRequired: 'Review the resubmitted Incident Report.',
        residentId: existing.residentId,
        relatedRecordType: 'incidentReports',
        relatedRecordId: id,
        actorUsername: actor,
      });
    } catch (notifyErr) {
      console.error('[IncidentReportController] Resubmission notification failed (non-fatal):', notifyErr.message);
    }

    res.json({ success: true, data: mapIncidentReport(updated), documentId: updated.pdfDocumentId, message: 'Incident Report resubmitted for review.' });
  } catch (error) {
    next(error);
  }
}

async function canEditIncidentReport(user, report) {
  const role = String(user?.role || '').toLowerCase();
  if (!['socialworker', 'centerhead', 'houseparent', 'admin'].includes(role)) return false;
  return await canAccessResident(user, report.residentId);
}

/**
 * GET /api/incident-reports/violation/:violationId
 * Fetch the incident report tied to a specific violation.
 */
async function getByViolationId(req, res, next) {
  try {
    const { violationId } = req.params;
    const [rows] = await pool.query(
      `SELECT ir.*, d.status AS documentStatus
       FROM incidentReports ir
       LEFT JOIN documents d ON d.id = ir.pdfDocumentId
       WHERE ir.violationId = ?
       LIMIT 1`,
      [violationId]
    );
    if (rows.length === 0) {
      return res.json({ success: true, data: null });
    }
    res.json({ success: true, data: mapIncidentReport(rows[0]) });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/incident-reports/resident/:residentId
 * List all incident reports for a resident, most recent first.
 */
async function getByResidentId(req, res, next) {
  try {
    const { residentId } = req.params;
    const [rows] = await pool.query(
      'SELECT * FROM incidentReports WHERE residentId = ? ORDER BY incidentDateTime DESC',
      [residentId]
    );
    res.json({ success: true, data: rows.map(mapIncidentReport) });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/incident-reports/:id/verify
 * Psychologist verifies the report and (optionally) selects the intervention.
 * Body: { interventionType, interventionScheduleDate, verifiedBy }
 */
async function verify(req, res, next) {
  try {
    const { id } = req.params;
    const { interventionType, interventionScheduleDate, verifiedBy } = req.body || {};

    const [rows] = await pool.query('SELECT * FROM incidentReports WHERE id = ?', [id]);
    if (rows.length === 0) throw new ApiError(404, 'Incident report not found');
    if (rows[0].status === 'Verified') {
      return res.json({ success: true, data: mapIncidentReport(rows[0]), message: 'Incident report was already verified.' });
    }
    if (!['Submitted', 'Pending Review'].includes(rows[0].status)) {
      throw new ApiError(409, 'This Incident Report must be corrected and resubmitted before it can be approved.');
    }

    await pool.query(
      `UPDATE incidentReports
       SET status = 'Verified', interventionType = ?, interventionScheduleDate = ?,
           verifiedBy = ?, verifiedAt = NOW()
       WHERE id = ?`,
      [interventionType || null, interventionScheduleDate ? String(interventionScheduleDate).replace('T', ' ') : null, verifiedBy || req.user?.username || null, id]
    );

    const [updated] = await pool.query('SELECT * FROM incidentReports WHERE id = ?', [id]);

    // Verification schedules the intervention, so the people who carry it out
    // (the case owner and the resident's Houseparents) need to be told.
    try {
      const verifier = verifiedBy || req.user?.username || 'Psychologist';
      const childName = (await notifications.residentName(rows[0].residentId)) || rows[0].residentId;
      const schedule = interventionScheduleDate
        ? ` Scheduled for ${String(interventionScheduleDate).replace('T', ' ')}.`
        : '';
      const base = {
        type: 'Incident Report',
        residentId: rows[0].residentId,
        title: `Incident Report Verified - ${childName}`,
        message: `${verifier} verified the Form 08 Incident Report for ${childName}.${interventionType ? ` Intervention: ${interventionType}.` : ''}${schedule}`,
        priority: 'Medium',
        actionRequired: 'Carry out the scheduled intervention.',
        relatedRecordType: 'incidentReports',
        relatedRecordId: id,
        actorUsername: verifier,
      };

      await notifications.notify({
        ...base,
        targetRole: 'socialworker',
        dedupeKey: `incident-report:${id}:verified`,
      });

      const houseparents = await notifications.houseparentsOf(rows[0].residentId);
      await notifications.notifyUsers(
        houseparents.map((hp) => hp.id),
        { ...base, dedupeKey: `incident-report:${id}:verified-houseparent` }
      );

      // The alert asking the verifier to verify this report is now finished.
      await notifications.markRelatedRead(req.user, 'incidentReports', id);
    } catch (notifyErr) {
      console.error('[IncidentReportController] Verification notification failed (non-fatal):', notifyErr.message);
    }

    res.json({ success: true, data: mapIncidentReport(updated[0]), message: 'Incident report verified.' });
  } catch (error) {
    next(error);
  }
}

module.exports = { create, getByViolationId, getByResidentId, verify, resubmit };
