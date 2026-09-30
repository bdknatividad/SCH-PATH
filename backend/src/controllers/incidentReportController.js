/**
 * Incident Report Controller
 * @module controllers/incidentReportController
 * @description Digital version of Form 08 (Second Chance Home Incident Report).
 *
 * A Houseparent — or a Social Worker, the Psychological Support Staff or the
 * Center Head — fills the form out against a violation record. It is then signed
 * by three people, each on their own printed line, in two stages: the Social
 * Worker ("Checked by") and the Psychological Support Staff (the clinical line,
 * with the intervention and its schedule) first, in either order, and the Center
 * Head ("Noted by") last. The form is approved only when all three signatures are
 * on it, and the approval is what the Intervention Tracker's `Mark Done` waits
 * for.
 *
 * A Stage-1 reviewer who finds something wrong corrects the report in place
 * rather than sending it back; every signature is cleared by such an edit,
 * because a signature belongs to the text its signer read.
 */

const { pool } = require('../config/database');
const { activeAdmissionIdFor } = require('../services/admissionLink');
const { generateId, runInTransactionWithIdRetry } = require('../utils/helpers');
const notifications = require('../services/notificationService');
const { canAccessResident } = require('./assignmentController');
const { ApiError } = require('../middleware/errorHandler');
const { normalizeRole } = require('../utils/authorization');
const { isFullAccessRole } = require('../config/rbac');
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
  return {
    ...row,
    reportTypes,
    statusLabel: row.status === 'Failed' ? 'Failed' : row.status === 'Reassessment' ? 'For Reassessment' : row.status,
    signatures: signatureState(row),
  };
}

/**
 * Which of Form 08's three signature lines are filled, and whose turn it is.
 *
 * Derived here rather than in the browser so no screen has to name
 * `swVerifiedBy` / `psychVerifiedBy` / `chVerifiedBy`. The Form 08 modal is
 * pinned by a test that forbids those names outright — they used to be read as
 * if the *report* carried a verification surface of its own, which is how three
 * separate approvals grew onto one incident.
 *
 * `nextSide` is the signer the form is waiting on: both Stage-1 sides first, in
 * any order, then the Center Head. `null` once all three have signed.
 */
function signatureState(row) {
  const sides = Object.entries(VERIFICATION_SIDES).map(([side, columns]) => ({
    side,
    label: columns.label,
    line: columns.line,
    signed: Boolean(row[columns.by]),
    by: row[columns.by] || null,
    at: row[columns.at] || null,
  }));
  const signedCount = sides.filter((entry) => entry.signed).length;
  const complete = signedCount === sides.length;
  return {
    sides,
    signedCount,
    total: sides.length,
    complete,
    nextSide: complete
      ? null
      : STAGE_ONE_SIDES.find((side) => !row[VERIFICATION_SIDES[side].by]) || FINAL_SIDE,
  };
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
  // Psychological Support Staff — below "SWO I - Case Manager" in the blank
  // part of the page: signature, then the printed name, a rule, and the role.
  psychStaff: { x: 36, top: 804, width: 140, height: 30 },
};

/**
 * The four sign-off lines' printed names.
 *
 * "Checked by" and "Noted by" are the same two people on every Form 08, so they
 * are pre-printed rather than typed: leaving them to the filer meant they could
 * be filled in differently — or left blank — on every report.
 *
 * "Reported by" and "Endorsed to" stay typed, because those are the two lines
 * that genuinely change from one report to the next. `FORM08_ENDORSED_TO_NAME`
 * is therefore empty and no longer drawn — it is kept only as the value older
 * records were saved with when nothing was typed, so an old record re-saved
 * without a name is not blanked, and it remains part of this module's exports.
 */
const FORM08_ENDORSED_TO_NAME = '';
const FORM08_CHECKED_BY_NAME = 'Francis C. Patricio, RSW';
const FORM08_CHECKED_BY_ROLE = 'SWO I - Case Manager';
const FORM08_NOTED_BY_NAME = 'MARICOR C. NAVARRO, RSW';
const FORM08_NOTED_BY_ROLE = 'SWO II - Center Head';
const FORM08_PSYCH_STAFF_NAME = 'Joyce Anne D.C. Tenorio';
const FORM08_PSYCH_STAFF_ROLE = 'Psychological Support Staff';

/**
 * Fills the exact official incident-report.pdf template. The source page is
 * loaded unchanged; only text/checkmark/signature overlays are added on top.
 */
async function buildForm08Pdf({
  childName, incidentDateTime, reportTypes, othersSpecify, summary, actionTaken, result,
  reportedBy, endorsedTo, checkedBy, notedBy,
  reportedBySignature, endorsedToSignature, checkedBySignature, notedBySignature,
  psychStaffSignature,
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
  // "Endorsed to" is filled in on each report.
  drawTextTop(endorsedTo, 388, 687.6, 8.5, true, { maxWidth: 155 });
  drawTextTop(FORM08_CHECKED_BY_NAME, 37, 776.4, 8.5, true, { maxWidth: 180 });
  drawTextTop(FORM08_CHECKED_BY_ROLE, 37, 789.0, 8.5, false, { maxWidth: 180 });
  drawTextTop(FORM08_NOTED_BY_NAME, 361, 776.4, 8.5, true, { maxWidth: 180 });
  drawTextTop(FORM08_NOTED_BY_ROLE, 361, 789.0, 8.5, false, { maxWidth: 180 });

  // Psychological Support Staff sign-off, below "SWO I - Case Manager":
  // printed name, a signature line under it, and the role under the line.
  drawTextTop(FORM08_PSYCH_STAFF_NAME, 37, 836.0, 8.5, true, { maxWidth: 180 });
  page.drawLine({
    start: { x: 36, y: height - 848.5 },
    end: { x: 176, y: height - 848.5 },
    thickness: 0.8,
    color: rgb(0, 0, 0),
  });
  drawTextTop(FORM08_PSYCH_STAFF_ROLE, 37, 851.5, 8.5, false, { maxWidth: 180 });

  // The four sign-offs, each stamped above its own printed name. A line with no
  // signature drawn simply keeps the printed name, exactly as before.
  await drawSignatureTop(reportedBySignature, FORM08_SIGNATURE_BOXES.reportedBy);
  await drawSignatureTop(endorsedToSignature, FORM08_SIGNATURE_BOXES.endorsedTo);
  await drawSignatureTop(checkedBySignature, FORM08_SIGNATURE_BOXES.checkedBy);
  await drawSignatureTop(notedBySignature, FORM08_SIGNATURE_BOXES.notedBy);
  await drawSignatureTop(psychStaffSignature, FORM08_SIGNATURE_BOXES.psychStaff);

  return Buffer.from(await pdfDoc.save());
}

/**
 * Draw Form 08 again from the values stored on the report, with `overrides`
 * applied.
 *
 * Used whenever a signature is added: the filed PDF has to carry every signature
 * the report holds, and the report is the only place those drawings live. A form
 * redrawn from a stale copy would print a signature over a line the signer never
 * read — and the file the resident's folder serves is this drawing.
 *
 * `childName` is not a column on `incidentReports` — the report stores the
 * resident id — so the name is read back the same way `create` first read it.
 */
async function renderForm08Pdf(report, overrides = {}) {
  const [childRows] = await pool.query('SELECT name FROM children WHERE id = ?', [report.residentId]);
  let reportTypes = [];
  try {
    reportTypes = typeof report.reportTypes === 'string' ? JSON.parse(report.reportTypes) : (report.reportTypes || []);
  } catch {
    reportTypes = [];
  }
  return buildForm08Pdf({
    childName: childRows[0]?.name || report.residentId,
    incidentDateTime: report.incidentDateTime,
    reportTypes,
    othersSpecify: report.othersSpecify,
    summary: report.summary,
    actionTaken: report.actionTaken,
    result: report.result,
    reportedBy: report.reportedBy,
    endorsedTo: report.endorsedTo,
    checkedBy: report.checkedBy,
    notedBy: report.notedBy,
    reportedBySignature: report.reportedBySignature,
    endorsedToSignature: report.endorsedToSignature,
    checkedBySignature: report.checkedBySignature,
    notedBySignature: report.notedBySignature,
    psychStaffSignature: report.psychStaffSignature,
    ...overrides,
  });
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
      reportedBySignature, endorsedToSignature,
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
        reportedBySignature, endorsedToSignature,
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

      // The filer signs "Reported by" and may sign "Endorsed to". The three
      // signer lines are deliberately left empty: they belong to the people who
      // sign them, and a form filed with those already filled in is the bug this
      // flow removes.
      await connection.query(
        `INSERT INTO incidentReports
          (id, violationId, residentId, interventionTrackerId, reportTypes, othersSpecify, incidentDateTime,
           summary, actionTaken, result, reportedBy, endorsedTo, checkedBy, notedBy,
           reportedBySignature, endorsedToSignature, checkedBySignature, notedBySignature, psychStaffSignature,
           status, pdfDocumentId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?)`,
        [
          incidentId, violationId, residentId, completedInterventionId, JSON.stringify(reportTypes || []), othersSpecify || null,
          incidentDateTime, summary || null, actionTaken || null, result || null,
          reportedBy || null, endorsedTo || null, FORM08_CHECKED_BY_NAME, FORM08_NOTED_BY_NAME,
          reportedBySignature || null, endorsedToSignature || null, null, null,
          null,
          docId,
        ]
      );

      return { newId: incidentId, documentId: docId };
    });

    const [rows] = await pool.query('SELECT * FROM incidentReports WHERE id = ?', [newId]);

    /*
     * Form 08 starts at Stage 1: the Social Worker and the Psychological Support
     * Staff read it and sign their own lines, and only then does it reach the
     * Center Head. All three are told — a signer who is not told the form exists
     * cannot sign it — but they are told different things, so this is two sends
     * rather than one: `notifyUsers` delivers a single payload to everyone on its
     * list, and the Center Head's notice has to say that his turn comes last.
     *
     * The filer is left out of both. `notifyUsers` does not skip the actor, and a
     * Houseparent who filed the report should not be asked to sign it.
     */
    try {
      const base = {
        type: 'Incident Report',
        residentId,
        priority: 'High',
        relatedRecordType: 'incidentReports',
        relatedRecordId: newId,
        actorUsername: uploader,
      };
      const accountsFor = async (roles) => (await notifications.usersWithAnyRole(roles))
        .filter((account) => String(account.username) !== String(uploader))
        .map((account) => account.id);

      await notifications.notifyUsers(
        await accountsFor(STAGE_ONE_SIDES.map((side) => VERIFICATION_SIDES[side].role)),
        {
          ...base,
          title: `Incident Report (Form 08) to sign - ${childName}`,
          message: `${uploader} filed the Form 08 Incident Report for ${childName}. It needs the Social Worker's and the Psychological Support Staff's signatures.`,
          actionRequired: 'Open the report, correct it if it needs correcting, and sign your line.',
          dedupeKey: `incident-report:${newId}:submitted`,
        },
      );

      await notifications.notifyUsers(await accountsFor([VERIFICATION_SIDES[FINAL_SIDE].role]), {
        ...base,
        title: `Incident Report (Form 08) filed - ${childName}`,
        message: `${uploader} filed the Form 08 Incident Report for ${childName}. It reaches you once the Social Worker and the Psychological Support Staff have signed it — your signature is the approval.`,
        actionRequired: 'Read the report. You sign it last, after the Social Worker and the Psychological Support Staff.',
        dedupeKey: `incident-report:${newId}:submitted-ch`,
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
    // The linked document's decision counts too: a report marked Failed before
    // the reject route synchronised the incident still reads 'Submitted' here
    // while its document is 'Rejected', and it must still be possible to fill it
    // out again rather than leaving it stuck.
    let documentStatus = null;
    if (existing.pdfDocumentId) {
      const [docRows] = await pool.query('SELECT status FROM documents WHERE id = ? LIMIT 1', [existing.pdfDocumentId]);
      documentStatus = docRows[0]?.status || null;
    }
    /*
     * Two ways to save a correction, and the difference is who is correcting.
     *
     * A returned form (Failed / Reassessment / Rejected) is the filer's to fix. A
     * form still in review is the Stage-1 reviewers' to fix: the flow is that the
     * Social Worker and the Psychological Support Staff correct the report
     * themselves rather than sending it back, so a Submitted report stays editable
     * to them. Every signature is cleared below either way — a signature belongs
     * to the text its signer read, and an edit changes that text.
     */
    const returned = ['Failed', 'Reassessment', 'Rejected', 'For Reassessment'].includes(existing.status)
      || ['Rejected', 'Reassessment'].includes(documentStatus);
    const editorRole = normalizeRole(req.user?.role);
    const nothingSigned = !existing.swVerifiedBy && !existing.psychVerifiedBy && !existing.chVerifiedBy;
    const reviewing = ['Submitted', 'Pending Review'].includes(existing.status)
      && (STAGE_ONE_SIDES.some((side) => VERIFICATION_SIDES[side].role === editorRole) || nothingSigned);

    if (!returned && !reviewing) {
      throw new ApiError(409, 'Only a returned Incident Report, or one still under review, can be corrected.');
    }
    if (!await canEditIncidentReport(req.user, existing)) {
      throw new ApiError(403, 'You are not assigned to this resident.');
    }

    const {
      reportTypes, othersSpecify, incidentDateTime, summary, actionTaken, result,
      reportedBy, endorsedTo, checkedBy, notedBy,
      reportedBySignature, endorsedToSignature,
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
      reportedBySignature, endorsedToSignature,
    });
    const pdfFileName = `Incident-Report-${existing.id}.pdf`;

    /*
     * Every signature is cleared, because every signature belongs to the text its
     * signer read and this statement replaces that text. That includes the three
     * signer lines themselves: `checkedBySignature` / `notedBySignature` /
     * `psychStaffSignature` are set to NULL rather than taken from the body, so a
     * client cannot carry a signature over from the version that was corrected —
     * and the filer's own two lines are the only ones this endpoint accepts.
     */
    await pool.query(
      `UPDATE incidentReports
       SET reportTypes = ?, othersSpecify = ?, incidentDateTime = ?, summary = ?, actionTaken = ?, result = ?,
           reportedBy = ?, endorsedTo = ?, checkedBy = ?, notedBy = ?,
           reportedBySignature = ?, endorsedToSignature = ?,
           checkedBySignature = NULL, notedBySignature = NULL, psychStaffSignature = NULL,
           status = 'Submitted',
           verifiedBy = NULL, verifiedAt = NULL,
           psychVerifiedBy = NULL, psychVerifiedAt = NULL,
           swVerifiedBy = NULL, swVerifiedAt = NULL,
           chVerifiedBy = NULL, chVerifiedAt = NULL,
           updatedAt = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [JSON.stringify(reportTypes), othersSpecify || null, String(incidentDateTime).replace('T', ' '), summary || null,
       actionTaken || null, result || null, reportedBy || null, endorsedTo || null,
       FORM08_CHECKED_BY_NAME, FORM08_NOTED_BY_NAME,
       reportedBySignature || null, endorsedToSignature || null, id]
    );

    if (existing.pdfDocumentId) {
      // The previous rejection is deliberately kept: it is the document's most
      // recent review outcome, the Documents folder view shows the rejected-by
      // and rejection date, and the audit trail holds every rejection. Only the
      // decision fields for the *current* cycle are cleared.
      //
      // **Eight placeholders, eight values — the `id` last.** There was a ninth
      // (`actor` repeated) here, and `pool.query` does not reject a surplus
      // parameter: it binds the values to the placeholders in order and ignores
      // what is left over, so the `WHERE id = ?` took the *actor* and the
      // statement matched no row. The resubmit therefore returned 200 with the
      // report back on 'Submitted' while its document kept the 'Reassessment'
      // the Center Head had given it — and the document is what the Intervention
      // Tracker's Form 08 row reads, so "Fill Out Again & Resubmit" looked like
      // it did nothing at all.
      await pool.query(
        `UPDATE documents SET title = 'Incident Report', status = 'Submitted',
         reviewedBy = NULL, reviewedAt = NULL, approvedBy = NULL, approvedAt = NULL,
         fileName = ?, fileSize = ?, fileData = ?, fileType = 'application/pdf', modifiedBy = ?,
         documentCategory = ?, submittedBy = ?, submittedAt = NOW(), uploadedBy = ?, uploadedAt = NOW()
         WHERE id = ?`,
        [pdfFileName, pdfBuffer.length, pdfBuffer.toString('base64'), actor, VIOLATION_FOLDER, actor, actor, existing.pdfDocumentId]
      );
    }

    const [updatedRows] = await pool.query('SELECT * FROM incidentReports WHERE id = ?', [id]);
    const updated = updatedRows[0];
    // A correction restarts Stage 1, so the people asked to sign are the two
    // Stage-1 signers — the Center Head is not pulled in until both have signed.
    // The person who made the correction is left out of their own notice.
    try {
      const reviewer = await notifications.usersWithAnyRole(
        STAGE_ONE_SIDES.map((side) => VERIFICATION_SIDES[side].role),
      );
      await notifications.notifyUsers(
        reviewer.filter((account) => String(account.username) !== String(actor)).map((account) => account.id),
        {
          type: 'Incident Report Resubmitted',
          title: `Incident Report ${returned ? 'Resubmitted' : 'Corrected'} - ${childName}`,
          message: `${actor} ${returned ? 'corrected and resubmitted' : 'corrected'} the Incident Report for ${childName}. Every signature was cleared, so it needs the Social Worker's and the Psychological Support Staff's signatures again.`,
          priority: 'High',
          actionRequired: 'Read the corrected report and sign your line.',
          residentId: existing.residentId,
          relatedRecordType: 'incidentReports',
          relatedRecordId: id,
          actorUsername: actor,
        },
      );
    } catch (notifyErr) {
      console.error('[IncidentReportController] Resubmission notification failed (non-fatal):', notifyErr.message);
    }

    res.json({
      success: true,
      data: mapIncidentReport(updated),
      documentId: updated.pdfDocumentId,
      message: returned
        ? 'Incident Report resubmitted for review.'
        : 'Incident Report corrected. Every signature was cleared, so it goes back for signing.',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Who may fill Form 08 in. The specification names four roles: the Houseparent
 * (who files most of them), the Social Worker, the Psychological Support Staff
 * and the Center Head.
 *
 * The Psychological Staff used to be absent from this list and from the create
 * route, on the reading that the specification forbade the role from creating an
 * incident. The role does file the form — and signs it — so it is here now.
 */
async function canEditIncidentReport(user, report) {
  const role = normalizeRole(user?.role);
  if (!['socialworker', 'centerhead', 'houseparent', 'admin', 'psychologist'].includes(role)) return false;
  return await canAccessResident(user, report.residentId);
}

/**
 * GET /api/incident-reports/violation/:violationId
 * Fetch the incident report tied to a specific violation.
 */
async function getByViolationId(req, res, next) {
  try {
    const { violationId } = req.params;
    /*
     * The linked document's decision travels with the report.
     *
     * A Form 08 is approved by the Center Head through the Documents module, so
     * the *reason* it came back lives on the document (`rejectionReason`, with
     * who returned it and when) and not on `incidentReports`. The tracker could
     * only say "Returned by the Center Head — correct it and resubmit" with no
     * indication of what to correct, which is useless to the person who has to
     * fix it. Selecting these three here is what lets that row quote the note.
     */
    const [rows] = await pool.query(
      `SELECT ir.*,
              d.status AS documentStatus,
              d.rejectionReason AS documentRejectionReason,
              d.reviewedBy AS documentReviewedBy,
              d.reviewedAt AS documentReviewedAt
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
 * Psychological Staff verifies the report and (optionally) selects the intervention.
 * Body: { interventionType, interventionScheduleDate, verifiedBy }
 */
/**
 * The three signatures a Form 08 needs, and the columns each one writes.
 *
 * The specification requires all three: the Social Worker signs "Checked by"
 * (Francis C. Patricio, RSW), the Psychological Support Staff signs the clinical
 * line (Joyce Anne D.C. Tenorio) — and with it the intervention and its
 * schedule — and the Center Head signs "Noted by" (MARICOR C. NAVARRO, RSW)
 * last. The three printed names are already on the template; what each side adds
 * here is the drawn signature that goes above its own name.
 *
 * `status` only reaches 'Verified' when all three stamp pairs are present, and
 * the document is only approved then. `verifiedBy`/`verifiedAt` keep their
 * existing meaning for the rest of the system — "who signed this off" — and
 * record whichever signature completed the set.
 */
const VERIFICATION_SIDES = {
  sw: {
    by: 'swVerifiedBy', at: 'swVerifiedAt', signature: 'checkedBySignature',
    role: 'socialworker', label: 'Social Worker', line: 'Checked by',
  },
  psych: {
    by: 'psychVerifiedBy', at: 'psychVerifiedAt', signature: 'psychStaffSignature',
    role: 'psychologist', label: 'Psychological Support Staff', line: 'Psychological Support Staff',
  },
  ch: {
    by: 'chVerifiedBy', at: 'chVerifiedAt', signature: 'notedBySignature',
    role: 'centerhead', label: 'Center Head', line: 'Noted by',
  },
};

/**
 * The order the form is routed in.
 *
 * Stage 1 is the Social Worker and the Psychological Support Staff, in either
 * order — they read the report, correct it if it needs correcting, and sign
 * their own line. Only when *both* have signed does it reach the Center Head,
 * whose signature is the approval. Enforced here rather than in the UI, so a
 * direct call cannot sign the form out of turn.
 */
const STAGE_ONE_SIDES = ['sw', 'psych'];
const FINAL_SIDE = 'ch';
const SIGNING_ORDER = [...STAGE_ONE_SIDES, FINAL_SIDE];

/** The sides whose stamp pairs are present on this row. */
function signedSides(row) {
  return SIGNING_ORDER.filter((side) => Boolean(row[VERIFICATION_SIDES[side].by]));
}

/**
 * Which line is this caller signing?
 *
 * Each of the three roles owns exactly one line and signs only that one — a
 * Social Worker cannot sign on the Psychological Support Staff's behalf, or
 * "three signatures" would be fewer than three people. The side is derived from
 * the caller's role and cannot be chosen: there is no `verificationSide` to send,
 * so no account can fill a line it does not own.
 *
 * A full-access role with no line of its own (the Administrator) is refused. It
 * used to be allowed to *name* a side, which made an administrator able to
 * complete a form the specification says three named people sign.
 *
 * @param {Object} user - The authenticated user.
 * @returns {'sw'|'psych'|'ch'}
 */
function resolveVerificationSide(user) {
  const role = normalizeRole(user?.role);
  const ownSide = SIGNING_ORDER.find((side) => VERIFICATION_SIDES[side].role === role);
  if (ownSide) return ownSide;

  if (isFullAccessRole(role)) {
    throw new ApiError(
      403,
      'Form 08 is signed by the Social Worker, the Psychological Support Staff and the Center Head, each on their own line — an administrator has no line to sign.',
    );
  }

  throw new ApiError(403, `Your role (${role || 'unknown'}) is not permitted to sign an Incident Report.`);
}

async function verify(req, res, next) {
  try {
    const { id } = req.params;
    const { interventionType, interventionScheduleDate, verifiedBy, signature } = req.body || {};

    const side = resolveVerificationSide(req.user);
    const columns = VERIFICATION_SIDES[side];

    const [rows] = await pool.query('SELECT * FROM incidentReports WHERE id = ?', [id]);
    if (rows.length === 0) throw new ApiError(404, 'Incident report not found');
    const report = rows[0];

    if (report.status === 'Verified') {
      return res.json({ success: true, data: mapIncidentReport(report), message: 'Incident report was already signed off.' });
    }
    if (!['Submitted', 'Pending Review'].includes(report.status)) {
      throw new ApiError(409, 'This Incident Report must be corrected and resubmitted before it can be signed.');
    }

    // A line signs once. Re-sending the same side would otherwise let one account
    // fill a line it had already filled.
    if (report[columns.by]) {
      throw new ApiError(409, `This Incident Report already carries the ${columns.label} signature (${report[columns.by]}).`);
    }

    /*
     * Form 08 routes bottom-up: the Social Worker and the Psychological Support
     * Staff sign first, in either order, and only then does it reach the Center
     * Head. Enforced here rather than in the UI, because his signature *is* the
     * approval — a Center Head signing a report the two people who were supposed
     * to have read it never saw would approve it with nothing downstream to
     * catch it.
     */
    if (side === FINAL_SIDE) {
      const missing = STAGE_ONE_SIDES.filter((other) => !report[VERIFICATION_SIDES[other].by]);
      if (missing.length) {
        throw new ApiError(
          409,
          `The ${missing.map((other) => VERIFICATION_SIDES[other].label).join(' and ')} must sign this Incident Report before the Center Head does.`,
        );
      }
    }

    // The drawn signature is the point of the endpoint — a line that records only
    // a name is what this replaces. An unusable value is refused rather than
    // skipped: `buildForm08Pdf` draws nothing for an image it cannot decode, so a
    // header with no image behind it would be recorded as a signature and leave
    // the line blank on the page. The 32-character floor is what separates a
    // drawing from a bare `data:image/png;base64,` — the smallest real signature
    // is an order of magnitude longer.
    const drawn = String(signature || '').trim();
    const decoded = drawn.match(/^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/i);
    if (!decoded || decoded[2].length < 32) {
      throw new ApiError(400, 'Draw your signature before signing the Incident Report.');
    }

    const signer = verifiedBy || req.user?.username || null;
    if (!signer) throw new ApiError(400, 'A signing user is required.');

    // The intervention and its schedule belong to the clinical decision, so only
    // the Psychological Support Staff's signature carries them. Neither of the
    // other two lines may silently overwrite what was prescribed.
    const nextInterventionType = side === 'psych' ? (interventionType || null) : (report.interventionType || null);
    const nextSchedule = side === 'psych'
      ? (interventionScheduleDate ? String(interventionScheduleDate).replace('T', ' ') : null)
      : (report.interventionScheduleDate || null);

    const signedAfterThis = [...signedSides(report), side];
    const complete = STAGE_ONE_SIDES.every((other) => signedAfterThis.includes(other))
      && signedAfterThis.includes(FINAL_SIDE);
    const stillWaiting = STAGE_ONE_SIDES.find((other) => !signedAfterThis.includes(other)) || null;

    /*
     * The signed PDF is rebuilt before anything is written, and carries every
     * signature the report holds at this moment. The order matters: a drawing
     * that cannot be produced must leave the report exactly as it was, rather
     * than record a signature that never reached the page.
     */
    const signedPdf = report.pdfDocumentId
      ? await renderForm08Pdf(report, { [columns.signature]: drawn })
      : null;

    const assignments = [
      `${columns.by} = ?`, `${columns.at} = NOW()`,
      `${columns.signature} = ?`,
      'interventionType = ?', 'interventionScheduleDate = ?',
    ];
    const values = [signer, drawn, nextInterventionType, nextSchedule];

    if (complete) {
      // `verifiedBy`/`verifiedAt` mean "who signed this off" for the rest of the
      // system, so they are stamped by whichever signature completed the set —
      // here, the Center Head's.
      assignments.push('status = ?', 'verifiedBy = ?', 'verifiedAt = NOW()');
      values.push('Verified', signer);
    }

    await pool.query(
      `UPDATE incidentReports SET ${assignments.join(', ')}, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
      [...values, id],
    );

    if (signedPdf && report.pdfDocumentId) {
      // The linked document is the copy the resident's folder serves and the copy
      // `Mark Done` reads, so it has to carry the signature just added. It only
      // becomes 'Approved' on the third signature: approving it earlier would
      // unlock the intervention while the form was still unsigned.
      const docAssignments = ['fileData = ?', 'fileSize = ?', 'modifiedBy = ?'];
      const docValues = [signedPdf.toString('base64'), signedPdf.length, signer];
      if (complete) {
        docAssignments.push("status = 'Approved'", 'approvedBy = ?', 'approvedAt = NOW()');
        docValues.push(signer);
      }
      await pool.query(
        `UPDATE documents SET ${docAssignments.join(', ')} WHERE id = ?`,
        [...docValues, report.pdfDocumentId],
      );
    }

    const [updated] = await pool.query('SELECT * FROM incidentReports WHERE id = ?', [id]);

    /*
     * Who has to act next. A Stage-1 signature hands the form to the other
     * Stage-1 signer; once both are in it goes to the Center Head; and only the
     * signature that completes the set tells the people who carry the
     * intervention out. Anything earlier would be asking someone to act on a form
     * that is not approved yet.
     */
    try {
      const childName = (await notifications.residentName(report.residentId)) || report.residentId;
      const schedule = nextSchedule ? ` Scheduled for ${nextSchedule}.` : '';
      const base = {
        type: 'Incident Report',
        residentId: report.residentId,
        relatedRecordType: 'incidentReports',
        relatedRecordId: id,
        actorUsername: signer,
      };

      if (!complete) {
        // The next signer: the other Stage-1 line, or the Center Head once both
        // Stage-1 lines are in.
        const waitingSide = stillWaiting || FINAL_SIDE;
        const waitingOn = VERIFICATION_SIDES[waitingSide];
        await notifications.notify({
          ...base,
          title: stillWaiting
            ? `Incident Report (Form 08) needs your verification - ${childName}`
            : `Incident Report (Form 08) is ready for your signature - ${childName}`,
          message: `${signer} signed the ${columns.label} line for ${childName}. The form is waiting for the ${waitingOn.label} signature.`,
          priority: 'High',
          actionRequired: `Sign the ${waitingOn.label} line ("${waitingOn.line}") on the Form 08.`,
          targetRole: waitingOn.role,
          dedupeKey: `incident-report:${id}:awaiting-${waitingSide}`,
        });
      } else {
        const verified = {
          ...base,
          title: `Incident Report Verified - ${childName}`,
          message: `${signer} completed the signatures on the Form 08 Incident Report for ${childName}.${nextInterventionType ? ` Intervention: ${nextInterventionType}.` : ''}${schedule}`,
          priority: 'Medium',
          actionRequired: 'Carry out the scheduled intervention.',
        };

        // The case owner, the resident's Houseparents, and whoever filed the
        // form — the three sets of people who act on the outcome.
        await notifications.notify({
          ...verified,
          targetRole: 'socialworker',
          dedupeKey: `incident-report:${id}:verified`,
        });

        const houseparents = await notifications.houseparentsOf(report.residentId);
        await notifications.notifyUsers(
          houseparents.map((hp) => hp.id),
          { ...verified, dedupeKey: `incident-report:${id}:verified-houseparent` },
        );

        if (report.pdfDocumentId) {
          const [docRows] = await pool.query('SELECT submittedBy FROM documents WHERE id = ? LIMIT 1', [report.pdfDocumentId]);
          const filerId = await notifications.userIdForUsername(docRows[0]?.submittedBy);
          if (filerId) {
            await notifications.notifyUsers([filerId], {
              ...verified,
              dedupeKey: `incident-report:${id}:verified-filer`,
            });
          }
        }
      }

      // The alert that asked this person to sign is finished either way.
      await notifications.markRelatedRead(req.user, 'incidentReports', id);
    } catch (notifyErr) {
      console.error('[IncidentReportController] Signing notification failed (non-fatal):', notifyErr.message);
    }

    const nextLabel = complete ? null : VERIFICATION_SIDES[stillWaiting || FINAL_SIDE].label;
    res.json({
      success: true,
      data: mapIncidentReport(updated[0]),
      message: complete
        ? 'Incident report signed off by all three signatories.'
        : `Your ${columns.label} signature was recorded. The form goes to the ${nextLabel} next.`,
    });
  } catch (error) {
    next(error);
  }
}

// `buildForm08Pdf` is exported so the form's layout can be asserted from the
// drawn content streams in a test, and rendered for a visual check. Geometry
// that reads correctly in code is regularly wrong on the page, and this is an
// official form that gets printed and signed.
module.exports = {
  create, getByViolationId, getByResidentId, verify, resubmit, buildForm08Pdf,
  FORM08_ENDORSED_TO_NAME, FORM08_CHECKED_BY_NAME, FORM08_CHECKED_BY_ROLE,
  FORM08_NOTED_BY_NAME, FORM08_NOTED_BY_ROLE,
  FORM08_PSYCH_STAFF_NAME, FORM08_PSYCH_STAFF_ROLE, FORM08_SIGNATURE_BOXES,
  // Exported so the signing rule can be asserted directly: which line a caller
  // signs, which columns each line writes, and which lines come before which.
  VERIFICATION_SIDES, resolveVerificationSide, STAGE_ONE_SIDES, FINAL_SIDE, SIGNING_ORDER,
  signatureState,
};
