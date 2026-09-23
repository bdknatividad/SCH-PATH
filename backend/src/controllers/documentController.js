/**
 * Document Controller
 * @module controllers/documentController
 * @description Document management with approval workflow
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { insertWithGeneratedId, mapRow } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');
const { canAccessResident } = require('./assignmentController');
const { DOCUMENT_ROLE_PERMISSIONS, PHASE_REQUIREMENTS, CASE_PHASES, RESOURCES } = require('../utils/constants');
const { normalizeRole } = require('../utils/authorization');
const { contentDisposition } = require('../utils/contentDisposition');
const { buildAnecdotalReportDocument, isOfficialAnecdotalPdf } = require('../utils/anecdotalReportPdf');
const { categoryForDocument, folderForDocument, DOCUMENT_FOLDERS } = require('../utils/documentCategory');
const notifications = require('../services/notificationService');
const { activeAdmissionIdFor } = require('../services/admissionLink');

const baseController = createController('documents');

/**
 * Append a row to the document's audit trail.
 *
 * Every workflow transition goes through here, so the trail is complete by
 * construction rather than by remembering to log at each call site. It is
 * deliberately non-fatal: the transition has already been committed, and losing
 * a history row must not turn a successful approval into a 500. The failure is
 * logged loudly instead.
 *
 * @param {Object} document - The document row, at least `{ id, revision }`.
 * @param {Object} entry
 * @param {string} entry.action - One of the `documentRevisions.action` values.
 * @param {Object} [entry.actor] - The authenticated user performing the action.
 * @param {string} [entry.actorName] - Overrides `actor.username` (e.g. a body field).
 * @param {string} [entry.status] - The document's status after the transition.
 * @param {string} [entry.reason] - Reviewer note. This is what keeps a rejection permanent.
 * @param {string} [entry.notes]
 * @param {Object} [entry.snapshot] - The document's fields at this moment.
 */
async function recordRevision(document, { action, actor, actorName, status, reason, notes, snapshot } = {}) {
  if (!document?.id) return;
  const actorUsername = actorName || actor?.username || 'System';
  try {
    await insertWithGeneratedId(pool, {
      table: 'documentRevisions',
      prefix: 'DOCREV',
      insert: (revisionId) => pool.query(
        `INSERT INTO documentRevisions
           (id, documentId, revision, action, status, actor, actorRole, reason, notes, snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          revisionId,
          document.id,
          Number(document.revision) || 1,
          action,
          status || document.status || null,
          actorUsername,
          normalizeRole(actor?.role) || null,
          reason || null,
          notes || null,
          snapshot ? JSON.stringify(snapshot) : null,
        ]
      ),
    });
  } catch (error) {
    console.error('[DocumentController] Audit trail write failed (non-fatal):', error.message);
  }
}

/**
 * The fields kept in a revision snapshot, so an earlier version of a corrected
 * document can be read back. `fileData` is deliberately excluded — it is base64
 * and can be megabytes per revision.
 */
function revisionSnapshot(document) {
  if (!document) return null;
  const { fileData, ...rest } = document;
  void fileData;
  return rest;
}

/**
 * Who may author a medical record. The specification is explicit — "Nurse and
 * Center Head only can create/manage medical records and documents" — so this is
 * enforced on the *derived folder* rather than on the document type alone: a
 * generic title posted with `category: 'Medical'` still lands in Medical Records
 * and must not slip past the type rule.
 */
const MEDICAL_RECORD_ROLES = new Set(['nurse', 'centerhead', 'admin']);

const DOCUMENT_READ_ROLES_BY_CATEGORY = {
  medical: ['nurse', 'centerhead', 'admin'],
  health: ['nurse', 'centerhead', 'admin'],
  psychological: ['psychologist', 'centerhead', 'admin'],
  behavioral: ['psychologist', 'socialworker', 'centerhead', 'admin'],
  assessment: ['psychologist', 'socialworker', 'centerhead', 'admin'],
  education: ['educator', 'centerhead', 'admin'],
  educational: ['educator', 'centerhead', 'admin'],
  case: ['socialworker', 'psychologist', 'centerhead', 'admin'],
  legal: ['socialworker', 'centerhead', 'admin'],
  // Anecdotal Reports are published here on submit, but the category had no
  // entry, so nobody except the uploader (via the owner match) or a Center
  // Head/Admin could open one — View returned 403 for the Social Worker who
  // reviews it and for the Houseparent team. This map is role-based like every
  // other category; the stricter per-caseload rule stays in the Anecdotal
  // Reports module, which is where reports are authored and edited.
  anecdotal: ['houseparent', 'socialworker', 'centerhead', 'admin'],
  'incident reports': ['socialworker', 'psychologist', 'centerhead', 'admin'],
  // Quarterly Progress Reports are published here when a reviewer finalizes one.
  // Without this entry only the account that approved it (via the owner match)
  // and a Center Head/Admin could open the finished report — which defeats the
  // module: the six aspects can be written by six different people, and every
  // one of them needs to be able to read the document they contributed to.
  'progress report': ['houseparent', 'nurse', 'psychologist', 'educator', 'socialworker', 'centerhead', 'admin'],
};

const DOCUMENT_READ_ROLE_KEYWORDS = [
  { roles: ['nurse'], keywords: ['medical', 'health', 'nursing', 'medication', 'checkup', 'laboratory'] },
  { roles: ['psychologist'], keywords: ['psychological', 'psychosocial', 'behavioral', 'discernment', 'mental health'] },
  { roles: ['educator'], keywords: ['education', 'educational', 'school', 'academic', 'learning'] },
  { roles: ['socialworker'], keywords: ['case', 'court', 'legal', 'ocp', 'diversion', 'discharge', 'social work', 'home visit', 'monitoring'] },
];

function normalizedRole(user) {
  return normalizeRole(user?.role);
}

function documentOwnerMatchesUser(document, user) {
  const username = String(user?.username || '').toLowerCase();
  const userId = String(user?.id || '').toLowerCase();
  return [document.createdBy, document.modifiedBy, document.uploadedBy, document.submittedBy]
    .some(owner => {
      const normalizedOwner = String(owner || '').toLowerCase();
      return normalizedOwner && (normalizedOwner === username || normalizedOwner === userId);
    });
}

/**
 * Caseload scoping lives in `utils/residentScope` because notifications need the
 * same rule and importing it from here would create a dependency cycle. It is
 * re-exported below so existing callers (routes/index.js, childController,
 * accessRequestController) keep working unchanged.
 */
const {
  CASELOAD_SCOPED_ROLES,
  assignedResidentIds,
  residentInScope: rowInResidentScope,
} = require('../utils/residentScope');

/**
 * The resident scope for a user, loaded once per request.
 * `null` means "not scoped" — the role has no caseload concept.
 * @returns {Promise<{ approvedDocumentIds: string[], allowedResidentIds: string[]|null }>}
 */
async function loadDocumentScope(user) {
  const role = normalizedRole(user);
  return {
    approvedDocumentIds: await getApprovedDocumentIds(user),
    allowedResidentIds: CASELOAD_SCOPED_ROLES.has(role) ? await assignedResidentIds(user) : null,
  };
}

/**
 * Does this document fall inside the user's resident scope?
 *
 * Facility-wide documents (no residentId) are not scoped, an uploader keeps
 * access to their own upload even after a reassignment, and roles without a
 * caseload concept are never restricted here.
 *
 * @param {Object} document
 * @param {Object} user
 * @param {string[]|null} allowedResidentIds from loadDocumentScope, or null for unscoped
 */
function residentInScope(document, user, allowedResidentIds) {
  if (documentOwnerMatchesUser(document, user)) return true;
  return rowInResidentScope(document, allowedResidentIds);
}

/**
 * The full read rule: an explicit approval wins, then the existing role/type
 * rules, then the resident scope.
 *
 * @param {Object} document
 * @param {Object} user
 * @param {{ approvedDocumentIds: string[], allowedResidentIds: string[]|null }} scope
 */
function documentVisibleTo(document, user, scope) {
  if (scope.approvedDocumentIds.includes(document.id)) return true;
  if (!canReadDocument(document, user)) return false;
  return residentInScope(document, user, scope.allowedResidentIds);
}

function canReadDocument(document, user) {
  const role = normalizedRole(user);
  if (role === 'centerhead' || role === 'admin') return true;
  if (documentOwnerMatchesUser(document, user)) return true;

  const titleRoles = DOCUMENT_ROLE_PERMISSIONS[document.title];
  if (titleRoles?.includes(role)) return true;

  const category = String(document.category || '').trim().toLowerCase();
  if (DOCUMENT_READ_ROLES_BY_CATEGORY[category]?.includes(role)) return true;

  const searchableText = `${document.title || ''} ${document.category || ''} ${document.type || ''}`.toLowerCase();
  const keywordRoles = DOCUMENT_READ_ROLE_KEYWORDS
    .filter(group => group.keywords.some(keyword => searchableText.includes(keyword)))
    .flatMap(group => group.roles);

  return keywordRoles.includes(role) ||
    String(document.uploaderRole || '').trim().toLowerCase() === role;
}

function filterReadableDocuments(documents, user) {
  return documents.filter(document => canReadDocument(document, user));
}

/**
 * Anecdotal Report documents are published only when a reviewer *accepts* the
 * report (see `anecdotalReportController.finalize`). Rows written by the earlier
 * publish-on-submit behaviour would otherwise keep a not-yet-accepted — or
 * outright rejected — report visible in the child's official folder.
 *
 * These are hidden from the listings rather than deleted: the row is removed
 * only when a reviewer explicitly rejects the report. The `anecdotalReports`
 * table is created lazily, so a missing table simply means nothing to hide.
 *
 * @returns {Promise<Set<string>>} ids of Anecdotal Reports that are not Finalized.
 */
async function unacceptedAnecdotalReportIds() {
  try {
    const [rows] = await pool.query("SELECT id FROM anecdotalReports WHERE status <> 'Finalized'");
    return new Set(rows.map(row => row.id));
  } catch {
    return new Set();
  }
}

function isUnacceptedAnecdotal(document, unacceptedIds) {
  return Boolean(document.anecdotalReportId) && unacceptedIds.has(document.anecdotalReportId);
}

/**
 * The documents a user may see in a listing: readable by them (or explicitly
 * approved to them) and not an Anecdotal Report that has yet to be accepted.
 * @param {Object[]} documents
 * @param {Object} user
 * @returns {Promise<Object[]>}
 */
async function visibleDocuments(documents, user) {
  const unacceptedIds = await unacceptedAnecdotalReportIds();
  const scope = await loadDocumentScope(user);
  return documents.filter(document =>
    !isUnacceptedAnecdotal(document, unacceptedIds) &&
    documentVisibleTo(document, user, scope)
  );
}

async function getApprovedDocumentIds(user) {
  if (!user?.id) return [];
  const [rows] = await pool.query(
    `SELECT documentId FROM accessRequests
     WHERE requesterId = ? AND status = 'Approved' AND documentId IS NOT NULL`,
    [user.id]
  );
  return rows.map(row => row.documentId);
}

async function canReadDocumentAsync(document, user, approvedDocumentIds = null) {
  if (approvedDocumentIds) {
    // Caller already loaded the grants; the resident scope still has to be checked.
    if (approvedDocumentIds.includes(document.id)) return true;
    if (!canReadDocument(document, user)) return false;
    const allowed = CASELOAD_SCOPED_ROLES.has(normalizedRole(user))
      ? await assignedResidentIds(user)
      : null;
    return residentInScope(document, user, allowed);
  }
  return documentVisibleTo(document, user, await loadDocumentScope(user));
}

/**
 * Documents the user cannot currently read but may ask for access to.
 *
 * Scoped to the caller's residents for caseload-scoped roles: a Houseparent must
 * not be shown — even as metadata — the existence of documents belonging to
 * children they are not assigned to. Unscoped roles keep the previous behaviour.
 */
async function getRequestableDocuments(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT * FROM documents ORDER BY createdAt DESC');
    const unacceptedIds = await unacceptedAnecdotalReportIds();
    const scope = await loadDocumentScope(req.user);
    const requestable = rows
      .filter(document => !isUnacceptedAnecdotal(document, unacceptedIds))
      .filter(document => !documentVisibleTo(document, req.user, scope))
      .filter(document => residentInScope(document, req.user, scope.allowedResidentIds))
      .map(withoutFileData);
    res.json({ success: true, data: requestable, count: requestable.length });
  } catch (error) {
    next(error);
  }
}

function withoutFileData(document) {
  const { fileData, ...metadata } = document;
  return metadata;
}

async function getReadableDocument(id, user) {
  const [rows] = await pool.query('SELECT * FROM documents WHERE id = ?', [id]);
  if (rows.length === 0) throw new ApiError(404, 'Document not found');
  if (!await canReadDocumentAsync(rows[0], user)) throw new ApiError(403, 'You are not authorized to access this document');
  return rows[0];
}

async function getAll(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT * FROM documents ORDER BY createdAt DESC');
    const readable = (await visibleDocuments(rows, req.user)).map(withoutFileData);
    res.json({ success: true, data: readable, count: readable.length });
  } catch (error) {
    next(error);
  }
}

/**
 * Decodes the two shapes `documents.fileData` is stored in: a `data:` URL
 * (written by the browser uploader) or bare base64 (written by the server).
 * @param {string} raw
 * @returns {Buffer}
 */
function decodeFileData(raw) {
  const dataUrlMatch = String(raw || '').match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (dataUrlMatch) {
    return dataUrlMatch[2]
      ? Buffer.from(dataUrlMatch[3].replace(/\s/g, ''), 'base64')
      : Buffer.from(decodeURIComponent(dataUrlMatch[3]), 'utf8');
  }
  return Buffer.from(String(raw || '').replace(/\s/g, ''), 'base64');
}

/**
 * Rebuilds the PDF for an Anecdotal Report document whose stored payload is
 * missing, is not a real PDF, or is not the official form, then persists the
 * result.
 *
 * Three cases reach here: entries published before the report carried a file at
 * all (`fileData` is NULL, so View/Download used to 404); payloads that were
 * truncated or stored as something other than the report; and entries published
 * by the generator that drew a look-alike page instead of overlaying the real
 * form. The `anecdotalReports` row is authoritative, so the file is regenerated
 * from it rather than trusted from the column.
 *
 * @param {Object} document Row from `documents`.
 * @param {Buffer} buffer   Already-decoded payload (may be empty).
 * @returns {Promise<{buffer: Buffer, fileName: string}|null>} `null` when the
 *          stored payload was already the official form.
 */
async function rebuildAnecdotalFile(document, buffer) {
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-'
      && await isOfficialAnecdotalPdf(buffer)) {
    return null;
  }
  const [rows] = await pool.query(
    `SELECT ar.*, c.name AS childName
     FROM anecdotalReports ar
     LEFT JOIN children c ON c.id = ar.residentId
     WHERE ar.id = ? LIMIT 1`,
    [document.anecdotalReportId]
  );
  if (!rows.length) return null;
  const { buffer: rebuilt, fileName, fileSize } = await buildAnecdotalReportDocument(rows[0], rows[0].childName);
  await pool.query(
    `UPDATE documents SET fileData = ?, fileName = ?, fileSize = ?, fileType = 'application/pdf' WHERE id = ?`,
    [rebuilt.toString('base64'), fileName, fileSize, document.id]
  );
  console.log(`Rebuilt Anecdotal Report PDF for document ${document.id} from the official form.`);
  return { buffer: rebuilt, fileName };
}

async function getFile(req, res, next) {
  try {
    const document = await getReadableDocument(req.params.id, req.user);
    const raw = String(document.fileData || '').trim();
    let buffer = raw ? decodeFileData(raw) : Buffer.alloc(0);
    // The in-memory row keeps the pre-repair values, which are NULL on entries
    // published before the file existed — track what we are about to serve.
    let fileType = document.fileType || 'application/octet-stream';
    let fileName = document.fileName;

    // Self-heal Anecdotal Report entries so View/Download always returns the
    // actual filled-up PDF, even for reports published before it existed.
    if (document.anecdotalReportId) {
      const rebuilt = await rebuildAnecdotalFile(document, buffer);
      if (rebuilt) {
        buffer = rebuilt.buffer;
        fileName = rebuilt.fileName;
        fileType = 'application/pdf';
      }
    }

    if (!buffer.length) throw new ApiError(404, 'Document file is not available');

    // Repair older Form 08 document rows whose stored payload is not a real PDF
    // (for example, an accidentally stored application/login HTML payload).
    // Rebuild it from the authoritative incidentReports record so View/Download
    // always returns the actual Form 08 PDF contents.
    if (String(document.title || '').trim().toLowerCase() === 'form 08 - incident report' &&
        String(document.fileType || '').toLowerCase() === 'application/pdf' &&
        buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      const [reportRows] = await pool.query(
        `SELECT ir.*, c.name AS childName
         FROM incidentReports ir
         LEFT JOIN children c ON c.id = ir.residentId
         WHERE ir.pdfDocumentId = ? OR ir.violationId = ?
         ORDER BY ir.createdAt DESC LIMIT 1`,
        [document.id, document.description?.match(/violation\s+([^\s]+)/i)?.[1] || '']
      );
      if (reportRows.length) {
        const report = reportRows[0];
        let types = [];
        try { types = typeof report.reportTypes === 'string' ? JSON.parse(report.reportTypes) : (report.reportTypes || []); } catch {}
        buffer = buildForm08Pdf({
          childName: report.childName || document.residentName || '—',
          incidentDateTime: report.incidentDateTime,
          reportTypes: types,
          othersSpecify: report.othersSpecify,
          summary: report.summary,
          actionTaken: report.actionTaken,
          result: report.result,
          reportedBy: report.reportedBy,
          endorsedTo: report.endorsedTo,
          checkedBy: report.checkedBy,
          notedBy: report.notedBy,
        });
        await pool.query(
          "UPDATE documents SET fileData = ?, fileSize = ?, fileType = 'application/pdf' WHERE id = ?",
          [buffer.toString('base64'), buffer.length, document.id]
        );
        fileType = 'application/pdf';
      }
    }

    if (fileType.toLowerCase() === 'application/pdf' && buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new ApiError(422, 'Stored document is not a valid PDF file. Please save the Form 08 again.');
    }
    res.setHeader('Content-Type', fileType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', contentDisposition(fileName || document.title));
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(buffer);
  } catch (error) {
    next(error);
  }
}

async function getById(req, res, next) {
  try {
    const document = await getReadableDocument(req.params.id, req.user);
    res.json({ success: true, data: document });
  } catch (error) {
    next(error);
  }
}

/**
 * Create a document with phase & role restrictions enforced
 * @async
 */
async function create(req, res, next) {
  try {
    const data = req.body || {};
    const uploaderRole = normalizeRole(req.user?.role || data.uploaderRole);
    const docTitle = data.title || '';
    const docPhase = data.phase || '';
    const docType = String(data.type || '').trim();
    if (docType === 'Other' && (!String(docTitle).trim() || String(docTitle).trim().toLowerCase() === 'other')) {
      throw new ApiError(422, 'Please specify the exact document type when Document Type is Other.');
    }

    // Quarterly Education Reports are unique per resident, calendar quarter, and year.
    // The Education module writes explicit quarter/year markers into the report
    // description; the filename is retained as a fallback for older submissions.
    if (docTitle === 'Quarterly Education Report' && data.residentId) {
      const sourceText = `${String(data.description || '')} ${String(data.fileName || '')}`;
      const explicitMatch = sourceText.match(/REPORT\s+QUARTER\s*:\s*(Q[1-4])\s+REPORT\s+YEAR\s*:\s*(\d{4})/i);
      const fileMatch = String(data.fileName || '').match(/Quarterly_Report_(Q[1-4])_(\d{4})_/i);
      const quarter = (explicitMatch?.[1] || fileMatch?.[1] || '').toUpperCase();
      const year = explicitMatch?.[2] || fileMatch?.[2] || '';
      if (!/^Q[1-4]$/.test(quarter) || !/^\d{4}$/.test(year)) {
        throw new ApiError(422, 'Quarterly Progress Report must include a valid report quarter and year.');
      }

      const [existingQuarterly] = await pool.query(
        `SELECT id, status FROM documents
         WHERE residentId = ? AND title = ?
           AND (
             description REGEXP ? OR
             fileName REGEXP ?
           )
         LIMIT 1`,
        [
          data.residentId,
          'Quarterly Education Report',
          `REPORT QUARTER:[[:space:]]*${quarter}[[:space:]]+REPORT YEAR:[[:space:]]*${year}([^0-9]|$)`,
          `Quarterly_Report_${quarter}_${year}_`,
        ]
      );
      if (existingQuarterly.length > 0) {
        throw new ApiError(409, `A Quarterly Progress Report has already been submitted for this resident for ${quarter} ${year}.`);
      }
    }

    // Assessment supporting documents must belong to a resident who is actually
    // attached to the assessment. This keeps the Documents child folder and the
    // assessment relationship consistent even if someone calls the API directly.
    if (data.assessmentId) {
      if (!data.residentId) {
        throw new ApiError(422, 'An assessment supporting document must be linked to a resident.');
      }
      const [assessmentRows] = await pool.query(
        'SELECT forResidents FROM assessments WHERE id = ? LIMIT 1',
        [data.assessmentId]
      );
      if (!assessmentRows.length) {
        throw new ApiError(404, 'The linked assessment was not found.');
      }
      let linkedResidents = [];
      try {
        const rawResidents = assessmentRows[0].forResidents;
        linkedResidents = Array.isArray(rawResidents)
          ? rawResidents
          : JSON.parse(rawResidents || '[]');
      } catch {
        linkedResidents = [];
      }
      const linkedResidentIds = linkedResidents.map(entry =>
        typeof entry === 'object' && entry !== null ? String(entry.id || '') : String(entry || '')
      ).filter(Boolean);
      if (!linkedResidentIds.includes(String(data.residentId))) {
        throw new ApiError(422, 'The document resident is not one of the residents linked to this assessment.');
      }
    }

    // Role restriction check — enforced for all upload sources
    const permissionKey = docType === 'Other' ? 'Other' : docTitle;
    const allowedRoles = DOCUMENT_ROLE_PERMISSIONS[permissionKey];
    if (allowedRoles && uploaderRole && !allowedRoles.includes(uploaderRole) && uploaderRole !== 'centerhead') {
      throw new ApiError(403, `Your role (${uploaderRole}) is not permitted to upload "${docTitle}". Allowed roles: ${allowedRoles.join(', ')}.`);
    }

    // Phase restriction: cannot upload docs for a future phase
    // Medical/non-phase-specific uploads are exempt from this check
    if (docPhase && data.residentId && data.category !== 'Medical') {
      const [children] = await pool.query('SELECT casePhase FROM children WHERE id = ?', [data.residentId]);
      if (children.length > 0) {
        const residentPhase = children[0].casePhase;
        const residentPhaseIndex = CASE_PHASES.indexOf(residentPhase);
        const docPhaseIndex = CASE_PHASES.indexOf(docPhase);
        if (docPhaseIndex > residentPhaseIndex) {
          throw new ApiError(422, `Cannot upload documents for a future phase (${docPhase}). Resident is currently in "${residentPhase}".`);
        }
      }
    }

    // Proceed with insert
    const config = RESOURCES['documents'];

    // A client must not be able to self-approve a document. Uploads enter the
    // workflow as Draft or Submitted; every later transition must go through
    // the dedicated submit/approve/reject endpoints.
    //
    // Exception: Medical documents are auto-approved by design — the Child
    // Record medical uploader posts them already approved with an approval
    // trail. That path is preserved; everything else is normalised to Draft.
    const UPLOAD_STATUSES = ['Draft', 'Submitted'];
    let uploadStatus = UPLOAD_STATUSES.includes(data.status) ? data.status : 'Draft';
    if (data.status === 'Approved' && data.category === 'Medical' && data.approvedBy) {
      uploadStatus = 'Approved';
    }

    const columns = ['id'];
    const values = [];
    const placeholders = ['?'];

    for (const col of config.columns) {
      // `documentCategory` is deliberately not taken from the request: the
      // folder is the system's to decide, so a client cannot file a Medical
      // Record under Admission Files. It is added below from the router.
      // `admissionId` is derived below for the same reason — see there.
      if (
        col !== 'id' &&
        col !== 'createdAt' &&
        col !== 'updatedAt' &&
        col !== 'documentCategory' &&
        col !== 'admissionId'
      ) {
        if (col === 'status') {
          columns.push(col);
          values.push(uploadStatus);
          placeholders.push('?');
          continue;
        }
        if (data[col] !== undefined) {
          columns.push(col);
          values.push(config.jsonFields.includes(col) && typeof data[col] === 'object' ? JSON.stringify(data[col]) : data[col]);
          placeholders.push('?');
        }
      }
    }

    // File the document by Child → Category → File. The folder is derived from
    // the document's own title/type/category, so a TRI lands in TRI Records and
    // an admission slip in Admission Files without the uploader choosing.
    const documentFolder = categoryForDocument(data);
    columns.push('documentCategory');
    values.push(documentFolder);
    placeholders.push('?');

    // File the document by Resident → Admission → Category → File.
    //
    // The admission is derived, never taken from the request. A client that
    // could name it could file a new document into a closed admission, or
    // scatter one resident's files across admissions — exactly the mixing this
    // column exists to prevent. A document written while a resident is in care
    // belongs to the admission that is open.
    const admissionId = await activeAdmissionIdFor(pool, data.residentId);
    if (admissionId) {
      columns.push('admissionId');
      values.push(admissionId);
      placeholders.push('?');
    }

    // The folder is derived, so the type rule above cannot cover a document
    // whose title is generic but whose category is medical: a "Medical Note"
    // posted as `Other` would pass that check and still be filed under Medical
    // Records. The derived folder is the authority, so it is enforced too.
    if (documentFolder === 'Medical Records' && uploaderRole && !MEDICAL_RECORD_ROLES.has(uploaderRole)) {
      throw new ApiError(
        403,
        `Your role (${uploaderRole}) is not permitted to create a medical record. Allowed roles: ${[...MEDICAL_RECORD_ROLES].join(', ')}.`,
      );
    }

    // Auto-set submittedBy and uploadedBy
    if (!data.submittedBy && req.user?.username) {
      columns.push('submittedBy'); values.push(req.user.username); placeholders.push('?');
    }
    if (!data.createdBy && req.user?.username) {
      columns.push('createdBy'); values.push(req.user.username); placeholders.push('?');
    }

    // Concurrent uploads can compute the same id from the same maximum, so the
    // insert retries with a fresh one instead of failing the whole upload.
    const newId = await insertWithGeneratedId(pool, {
      table: 'documents',
      prefix: config.prefix,
      insert: (id) => pool.query(
        `INSERT INTO documents (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
        [id, ...values]
      ),
    });

    const [rows] = await pool.query('SELECT * FROM documents WHERE id = ?', [newId]);

    // Start the audit trail. An upload that enters the workflow already
    // submitted records both facts, so the trail always begins with how the
    // document arrived rather than with its first review.
    await recordRevision(rows[0], {
      action: 'Uploaded',
      actor: req.user,
      status: uploadStatus,
      snapshot: revisionSnapshot(rows[0]),
    });
    if (uploadStatus === 'Submitted') {
      await recordRevision(rows[0], { action: 'Submitted', actor: req.user, status: uploadStatus });
    }

    // Auto-notify Social Workers when Psychologist uploads a Psychological Assessment
    if (docTitle === 'Psychological Assessment' && uploaderRole === 'psychologist' && data.residentId) {
      try {
        const [childRows] = await pool.query('SELECT name FROM children WHERE id = ?', [data.residentId]);
        const childName = childRows[0]?.name || data.residentId;
        await notifications.notify({
          type: 'Assessment Completed',
          residentId: data.residentId,
          title: `Psychological Assessment Uploaded - ${childName}`,
          message: `Psychologist has uploaded the Psychological Assessment for ${childName}. The document is pending review and approval.`,
          priority: 'Medium',
          actionRequired: 'Review and approve Psychological Assessment document',
          relatedRecordType: 'documents',
          relatedRecordId: newId,
          targetRole: 'socialworker',
          actorUsername: req.user?.username,
          dedupeKey: `document:${newId}:psych-assessment-uploaded`,
        });
      } catch (alertErr) {
        console.error('Failed to create psych assessment completion alert:', alertErr);
      }
    }

    res.status(201).json({ success: true, data: mapRow('documents', rows[0]) });
  } catch (error) {
    next(error);
  }
}

/**
 * Submit document for review
 * @async
 */
async function submit(req, res, next) {
  try {
    const { id } = req.params;
    const { submittedBy } = req.body || {};
    const [rows] = await pool.query('SELECT * FROM documents WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) throw new ApiError(404, 'Document not found');
    const existing = rows[0];
    const actor = submittedBy || req.user?.username || existing.submittedBy || existing.createdBy || 'System';

    // A resubmission starts a fresh review cycle: the status goes back to Under
    // Review and the submission round advances.
    const allowed = ['Draft', 'Submitted', 'Rejected', 'Reassessment', 'Under Review'];
    if (!allowed.includes(existing.status)) {
      throw new ApiError(409, `Document cannot be submitted from its current status (${existing.status}).`);
    }

    // A rejection is not an erasure. The previous cycle's rejection reason, the
    // reviewer and the date are all KEPT on the row — they are the document's
    // most recent review outcome and the folder view shows them — while the
    // status alone says whether the document is currently rejected. The audit
    // trail below holds every rejection, so nothing is lost either way.
    const isResubmission = ['Rejected', 'Reassessment'].includes(existing.status);
    const revision = isResubmission ? (Number(existing.revision) || 1) + 1 : (Number(existing.revision) || 1);

    await pool.query(
      `UPDATE documents
          SET status = 'Under Review', submittedBy = ?, submittedAt = NOW(),
              revision = ?, approvedBy = NULL, approvedAt = NULL,
              modifiedBy = ?, updatedAt = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [actor, revision, req.user?.username || actor, id]
    );

    const [updatedRows] = await pool.query('SELECT * FROM documents WHERE id = ? LIMIT 1', [id]);
    const updated = updatedRows[0];

    await recordRevision(updated, {
      action: isResubmission ? 'Resubmitted' : 'Submitted',
      actor: req.user,
      actorName: actor,
      status: 'Under Review',
      reason: isResubmission ? (existing.rejectionReason || null) : null,
      snapshot: revisionSnapshot(updated),
    });
    const isIncidentReport = String(existing.title || '').trim().toLowerCase() === 'incident report';
    if (isIncidentReport) {
      await pool.query(
        `UPDATE incidentReports
            SET status = 'Submitted', verifiedBy = NULL, verifiedAt = NULL,
                interventionType = NULL, interventionScheduleDate = NULL, updatedAt = CURRENT_TIMESTAMP
          WHERE pdfDocumentId = ?`,
        [id]
      );
    }

    // Put the resubmission back in the same reviewer queue as a new submission.
    try {
      const reviewerUsers = await notifications.usersWithAnyRole(['centerhead', 'socialworker']);
      if (reviewerUsers.length) {
        const residentName = existing.residentId ? await notifications.residentName(existing.residentId) : null;
        await notifications.notifyUsers(reviewerUsers.map(u => u.id), {
          type: isIncidentReport ? 'Incident Report Resubmitted' : 'Document Resubmitted',
          title: `${isIncidentReport ? 'Incident Report' : 'Document'} Resubmitted${residentName ? ` — ${residentName}` : ''}`,
          message: `${actor} resubmitted ${existing.title || 'the document'}${residentName ? ` for ${residentName}` : ''}. It is waiting for review again.`,
          priority: 'High',
          actionRequired: 'Review the resubmitted item.',
          residentId: existing.residentId || null,
          relatedRecordType: isIncidentReport ? 'incidentReports' : 'documents',
          relatedRecordId: isIncidentReport ? ((await pool.query('SELECT id FROM incidentReports WHERE pdfDocumentId = ? LIMIT 1', [id]))[0][0]?.id || null) : id,
          actorUsername: actor,
        });
      }
    } catch (notifyErr) {
      console.error('[DocumentController] Resubmission notification failed (non-fatal):', notifyErr.message);
    }

    res.json({ success: true, data: mapRow('documents', updated), message: 'Document submitted for review' });
  } catch (error) {
    next(error);
  }
}

/**
 * Tell the uploader what a reviewer decided about their document.
 *
 * Nothing did this before: a psychologist who uploaded an assessment, or a
 * houseparent who submitted an OCP resolution, only found out it was approved
 * or rejected by reopening the Documents page and reading the status.
 *
 * Addressed by id, not by role — the uploader is a person, and several accounts
 * share each role.
 */
async function notifyUploaderOfDecision(doc, { decision, reviewer, reason }) {
  const uploader = doc?.uploadedBy || doc?.submittedBy || doc?.createdBy;
  if (!uploader) return;

  // Do not tell people about their own action.
  if (reviewer && String(uploader).toLowerCase() === String(reviewer).toLowerCase()) return;

  const userId = await notifications.userIdForUsername(uploader);
  if (!userId) return;

  const childName = doc.residentId ? await notifications.residentName(doc.residentId) : null;
  const label = childName ? `${doc.title || doc.documentType || 'Document'} — ${childName}` : (doc.title || 'Document');
  const rejected = decision === 'Rejected';
  const reassessment = decision === 'Reassessment';
  const type = reassessment ? 'Document For Reassessment' : rejected ? 'Document Rejected' : 'Document Approved';

  await notifications.notify({
    type,
    residentId: doc.residentId || null,
    title: reassessment
      ? `Document For Reassessment — ${doc.title || 'Document'}`
      : rejected ? `Document Rejected — ${doc.title || 'Document'}` : `Document Approved — ${doc.title || 'Document'}`,
    message: reassessment
      ? `${reviewer} sent "${label}" for reassessment. Reason: ${reason || 'Please review and resubmit the requested corrections.'}`
      : rejected
        ? `${reviewer} rejected "${label}". Reason: ${reason}`
        : `${reviewer} approved "${label}".`,
    priority: (rejected || reassessment) ? 'High' : 'Medium',
    actionRequired: reassessment ? 'Review the requested corrections and resubmit the document.' : rejected ? 'Re-upload the document with the requested changes.' : null,
    relatedRecordType: 'documents',
    relatedRecordId: doc.id,
    targetUserId: userId,
    actorUsername: reviewer,
    dedupeKey: `document:${doc.id}:${reassessment ? 'reassessment' : rejected ? 'rejected' : 'approved'}:${doc.reviewedAt || doc.updatedAt || Date.now()}`,
  });
}

/**
 * Approve document
 * @async
 */
async function approve(req, res, next) {
  try {
    const { id } = req.params;
    const { approvedBy } = req.body || {};

    const [existing] = await pool.query('SELECT * FROM documents WHERE id = ?', [id]);
    if (existing.length === 0) {
      throw new ApiError(404, 'Document not found');
    }

    await pool.query(
      `UPDATE documents 
       SET status = ?, approvedBy = ?, approvedAt = NOW(), modifiedBy = ? 
       WHERE id = ?`,
      ['Approved', approvedBy || req.user?.username, req.user?.username || 'System', id]
    );

    // The "pending review" alert is finished for the person who reviewed it.
    // Scoped to this reviewer: the old shared-flag UPDATE cleared it out of
    // every other reviewer's list as well.
    await notifications.markRelatedRead(req.user, 'documents', id);

    const approved = { ...existing[0], status: 'Approved', approvedBy: approvedBy || req.user?.username };
    await recordRevision(approved, {
      action: 'Approved',
      actor: req.user,
      actorName: approvedBy || req.user?.username,
      status: 'Approved',
      snapshot: revisionSnapshot(approved),
    });

    try {
      await notifyUploaderOfDecision(
        approved,
        { decision: 'Approved', reviewer: approvedBy || req.user?.username }
      );
    } catch (notifyErr) {
      console.error('[DocumentController] Approval notification failed (non-fatal):', notifyErr.message);
    }

    res.json({
      success: true,
      message: 'Document approved',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Reject document
 * @async
 */
async function reject(req, res, next) {
  try {
    const { id } = req.params;
    const { rejectionReason, reviewedBy } = req.body || {};

    // A rejection without a reason is not actionable: the submitter is told to
    // correct the document and would have nothing to act on.
    if (!String(rejectionReason || '').trim()) {
      throw new ApiError(400, 'Rejection reason is required');
    }
    const reason = String(rejectionReason).trim();

    const [existing] = await pool.query('SELECT * FROM documents WHERE id = ?', [id]);
    if (existing.length === 0) {
      throw new ApiError(404, 'Document not found');
    }

    // `rejectedBy`/`rejectedAt` are the explicit decision fields the folder view
    // reads; `reviewedBy`/`reviewedAt` are kept in step for the older readers.
    const reviewer = reviewedBy || req.user?.username;
    await pool.query(
      `UPDATE documents 
       SET status = ?, rejectionReason = ?, rejectedBy = ?, rejectedAt = NOW(),
           reviewedBy = ?, reviewedAt = NOW(), modifiedBy = ? 
       WHERE id = ?`,
      ['Rejected', reason, reviewer, reviewer, req.user?.username || 'System', id]
    );

    await notifications.markRelatedRead(req.user, 'documents', id);

    const rejected = {
      ...existing[0],
      status: 'Rejected',
      rejectionReason: reason,
      rejectedBy: reviewer,
      rejectedAt: new Date(),
    };

    // The reason is written to the audit trail as well as to the row, so it
    // survives the next resubmission — which is what makes the note permanent.
    await recordRevision(rejected, {
      action: 'Rejected',
      actor: req.user,
      actorName: reviewer,
      status: 'Rejected',
      reason,
      snapshot: revisionSnapshot(rejected),
    });

    try {
      await notifyUploaderOfDecision(
        rejected,
        { decision: 'Rejected', reviewer, reason }
      );
    } catch (notifyErr) {
      console.error('[DocumentController] Rejection notification failed (non-fatal):', notifyErr.message);
    }

    res.json({
      success: true,
      message: 'Document rejected',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get documents by resident
 * @async
 */
async function getByResident(req, res, next) {
  try {
    const { residentId } = req.params;
    if (!await canAccessResident(req.user, residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }
    
    const [rows] = await pool.query(
      'SELECT * FROM documents WHERE residentId = ? ORDER BY createdAt DESC',
      [residentId]
    );
    const readable = (await visibleDocuments(rows, req.user)).map(withoutFileData);

    res.json({
      success: true,
      data: readable,
      count: readable.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get pending documents
 * @async
 */
async function getPending(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT d.*, c.name as residentName 
       FROM documents d 
       LEFT JOIN children c ON d.residentId = c.id 
       WHERE d.status IN (?, ?) 
       ORDER BY d.submittedAt ASC`,
      ['Under Review', 'Submitted']
    );
    const readable = (await visibleDocuments(rows, req.user)).map(withoutFileData);

    res.json({
      success: true,
      data: readable,
      count: readable.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get allowed document types for a given phase + role
 * @async
 */
async function getAllowedForRole(req, res, next) {
  try {
    const role = (req.query.role || req.user?.role || '').toLowerCase();
    const phase = req.query.phase || '';

    const phaseReq = PHASE_REQUIREMENTS[phase] || {};
    const phaseDocs = [...(phaseReq.requiredDocuments || []), ...(phaseReq.optionalDocuments || [])];

    // Filter to docs this role can upload
    const allowed = phaseDocs.filter(doc => {
      const roles = DOCUMENT_ROLE_PERMISSIONS[doc];
      return !roles || roles.includes(role) || role === 'centerhead';
    });

    res.json({
      success: true,
      phase,
      role,
      allowedDocuments: allowed,
      allPhaseDocuments: phaseDocs,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Documents are updated through the generic controller, which means the role
 * guards declared on POST /documents/:id/approve and /documents/:id/reject were
 * not actually enforced — the UI performs approvals via PUT /documents/:id.
 * Apply the same rule here: only approver roles may move a document into an
 * approved / rejected / reassessment / under-review state.
 */
const APPROVER_ROLES = ['centerhead', 'socialworker', 'admin'];
const APPROVAL_STATUSES = ['Approved', 'Rejected', 'Reassessment', 'Under Review'];

async function update(req, res, next) {
  try {
    const status = req.body?.status;
    if (status && APPROVAL_STATUSES.includes(status)) {
      const role = normalizeRole(req.user?.role);
      if (!APPROVER_ROLES.includes(role)) {
        throw new ApiError(403, `Your role (${role}) is not permitted to set a document status of "${status}".`);
      }
    }

    const [beforeRows] = await pool.query('SELECT * FROM documents WHERE id = ? LIMIT 1', [req.params.id]);
    if (!beforeRows.length) throw new ApiError(404, 'Document not found');
    const before = beforeRows[0];

    // A document's admission is permanent. It records where the file was produced,
    // and a file produced during an earlier admission has to stay in that
    // admission's folder — so the field is dropped rather than written, whether a
    // client sends it by accident or on purpose.
    if (req.body && 'admissionId' in req.body) {
      delete req.body.admissionId;
    }

    // "Nurse and Center Head only can create/manage medical records and
    // documents." The create path is gated on the derived folder above; this
    // closes the manage path. Without it a PUT with a medical id would let a
    // role rewrite a record it cannot even read — a social worker holds no
    // medical read, so it must hold no medical write either.
    if (before.documentCategory === 'Medical Records') {
      const editorRole = normalizeRole(req.user?.role);
      if (editorRole && !MEDICAL_RECORD_ROLES.has(editorRole)) {
        throw new ApiError(
          403,
          `Your role (${editorRole}) is not permitted to manage a medical record. Allowed roles: ${[...MEDICAL_RECORD_ROLES].join(', ')}.`,
        );
      }
    }
    const isResubmission = status === 'Submitted' && ['Rejected', 'Reassessment'].includes(before.status);

    // MySQL takes `YYYY-MM-DD HH:MM:SS`, not an ISO string with a `T` and `Z`.
    const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

    // A previously rejected/reassessment document that is submitted again starts
    // a fresh review cycle: it keeps its file, goes back into the same Pending
    // Review queue, and advances the submission round. The rejection reason and
    // reviewer are KEPT — they are the document's last review outcome, they are
    // what the folder view shows, and the audit trail below keeps every one.
    if (isResubmission) {
      req.body = {
        ...req.body,
        status: 'Under Review',
        revision: (Number(before.revision) || 1) + 1,
        approvedBy: null,
        approvedAt: null,
        submittedBy: req.body?.submittedBy || req.user?.username || before.submittedBy || before.createdBy || 'System',
        submittedAt: nowSql(),
        modifiedBy: req.user?.username || req.body?.submittedBy || 'System',
      };
    }

    // A rejection needs a reason here too — this is the path the UI actually
    // performs approvals and rejections through, so the guard on POST /reject
    // would otherwise be trivially bypassable with a PUT.
    if (status === 'Rejected' && !String(req.body?.rejectionReason || '').trim()) {
      throw new ApiError(400, 'Rejection reason is required');
    }
    if (status === 'Rejected') {
      req.body = {
        ...req.body,
        rejectionReason: String(req.body.rejectionReason).trim(),
        rejectedBy: req.body?.reviewedBy || req.user?.username || 'System',
        rejectedAt: nowSql(),
        reviewedBy: req.body?.reviewedBy || req.user?.username || 'System',
        reviewedAt: nowSql(),
      };
    }
    if (status === 'Approved') {
      req.body = {
        ...req.body,
        approvedBy: req.body?.approvedBy || req.user?.username || 'System',
        approvedAt: nowSql(),
      };
    }

    // The folder follows the document's own fields, so a title/type/category
    // edit that changes where the document belongs re-files it instead of
    // leaving it in the folder it used to match.
    if (req.body && (req.body.title !== undefined || req.body.type !== undefined || req.body.category !== undefined)) {
      req.body.documentCategory = categoryForDocument({ ...before, ...req.body });
    }

    // Let the generic controller perform the normal document update, but keep the
    // response payload until the Incident Report workflow has been synchronized.
    const originalJson = res.json.bind(res);
    let responsePayload = null;
    res.json = (payload) => { responsePayload = payload; return res; };
    try {
      await baseController.update(req, res, next);
    } finally {
      res.json = originalJson;
    }
    if (!responsePayload) return;

    const [afterRows] = await pool.query('SELECT * FROM documents WHERE id = ? LIMIT 1', [req.params.id]);
    const document = afterRows[0] || before;
    const isIncidentReport = String(document.title || '').trim().toLowerCase() === 'incident report';

    // Every transition this endpoint performs lands in the audit trail, the same
    // as the dedicated approve/reject/submit routes. The UI approves through
    // here, so without this the trail would have holes exactly where the real
    // decisions happen.
    if (isResubmission) {
      await recordRevision(document, {
        action: 'Resubmitted',
        actor: req.user,
        actorName: document.submittedBy,
        status: document.status,
        reason: before.rejectionReason || null,
        snapshot: revisionSnapshot(document),
      });
    } else if (status === 'Rejected') {
      await recordRevision(document, {
        action: 'Rejected',
        actor: req.user,
        actorName: document.rejectedBy,
        status: 'Rejected',
        reason: document.rejectionReason,
        snapshot: revisionSnapshot(document),
      });
    } else if (status === 'Reassessment') {
      await recordRevision(document, {
        action: 'Reassessment',
        actor: req.user,
        status: 'Reassessment',
        reason: document.rejectionReason,
        snapshot: revisionSnapshot(document),
      });
    } else if (status === 'Approved') {
      await recordRevision(document, {
        action: 'Approved',
        actor: req.user,
        actorName: document.approvedBy,
        status: 'Approved',
        snapshot: revisionSnapshot(document),
      });
    } else if (document.documentCategory !== before.documentCategory) {
      await recordRevision(document, {
        action: 'Updated',
        actor: req.user,
        status: document.status,
        notes: `Filed under ${document.documentCategory} (was ${before.documentCategory || 'unfiled'}).`,
      });
    }

    if (isResubmission) {
      if (isIncidentReport) {
        await pool.query(
          `UPDATE incidentReports
              SET status = 'Submitted', verifiedBy = NULL, verifiedAt = NULL,
                  interventionType = NULL, interventionScheduleDate = NULL, updatedAt = CURRENT_TIMESTAMP
            WHERE pdfDocumentId = ?`,
          [document.id]
        );
      }
      try {
        const reviewerUsers = await notifications.usersWithAnyRole(['centerhead', 'socialworker']);
        if (reviewerUsers.length) {
          const residentName = document.residentId ? await notifications.residentName(document.residentId) : null;
          await notifications.notifyUsers(reviewerUsers.map(u => u.id), {
            type: isIncidentReport ? 'Incident Report Resubmitted' : 'Document Resubmitted',
            title: `${isIncidentReport ? 'Incident Report' : 'Document'} Resubmitted${residentName ? ` — ${residentName}` : ''}`,
            message: `${document.submittedBy || req.user?.username || 'User'} resubmitted ${document.title || 'the document'}${residentName ? ` for ${residentName}` : ''}. It is waiting for review again.`,
            priority: 'High',
            actionRequired: 'Review the resubmitted item.',
            residentId: document.residentId || null,
            relatedRecordType: isIncidentReport ? 'incidentReports' : 'documents',
            relatedRecordId: isIncidentReport
              ? ((await pool.query('SELECT id FROM incidentReports WHERE pdfDocumentId = ? LIMIT 1', [document.id]))[0][0]?.id || null)
              : document.id,
            actorUsername: req.user?.username || null,
          });
        }
      } catch (notifyErr) {
        console.error('[DocumentController] Resubmission notification failed (non-fatal):', notifyErr.message);
      }
    }

    if (!isIncidentReport && ['Rejected', 'Reassessment'].includes(status)) {
      try {
        await notifyUploaderOfDecision(
          document,
          { decision: status, reviewer: req.user?.username, reason: String(req.body?.rejectionReason || '').trim() }
        );
      } catch (notifyErr) {
        console.error('[DocumentController] Workflow decision notification failed (non-fatal):', notifyErr.message);
      }
    }

    if (isIncidentReport && ['Rejected', 'Reassessment'].includes(status)) {
      const incidentStatus = status === 'Reassessment' ? 'Reassessment' : 'Failed';
      const reason = String(req.body?.rejectionReason || '').trim();
      await pool.query(
        `UPDATE incidentReports
         SET status = ?, updatedAt = CURRENT_TIMESTAMP
         WHERE pdfDocumentId = ?`,
        [incidentStatus, document.id]
      );

      try {
        const uploader = document.uploadedBy || document.submittedBy || document.createdBy;
        const targetUserId = uploader ? await notifications.userIdForUsername(uploader) : null;
        const residentName = document.residentId ? await notifications.residentName(document.residentId) : null;
        if (targetUserId) {
          const failed = incidentStatus === 'Failed';
          await notifications.notify({
            type: failed ? 'Incident Report Failed' : 'Incident Report For Reassessment',
            title: failed ? `Incident Report Failed — ${residentName || 'Resident'}` : `Incident Report For Reassessment — ${residentName || 'Resident'}`,
            message: failed
              ? `${residentName || 'Resident'}'s Incident Report was marked Failed. ${reason ? `Reason: ${reason}` : 'Please correct it and fill it out again.'}`
              : `${residentName || 'Resident'}'s Incident Report was sent for reassessment. ${reason ? `Reason: ${reason}` : 'Please review and resubmit the corrections.'}`,
            priority: 'High',
            actionRequired: failed ? 'Fill out the Incident Report again and resubmit it for review.' : 'Review the requested corrections and resubmit the Incident Report.',
            residentId: document.residentId || null,
            relatedRecordType: 'incidentReports',
            relatedRecordId: (await pool.query('SELECT id FROM incidentReports WHERE pdfDocumentId = ? LIMIT 1', [document.id]))[0][0]?.id || null,
            targetUserId,
            actorUsername: req.user?.username || null,
          });
        }
      } catch (notifyErr) {
        console.error('[DocumentController] Incident Report decision notification failed (non-fatal):', notifyErr.message);
      }
    }

    return originalJson(responsePayload);
  } catch (error) {
    next(error);
  }
}

/**
 * Deleting a document is destructive and irreversible (the stored fileData is
 * the only copy). Until now DELETE /documents/:id went straight to the generic
 * controller, so any authenticated user could remove any document by id.
 *
 * Policy: the uploader may remove their own document while it is still in
 * progress; Center Heads and Administrators may remove anything. An *approved*
 * document is part of the resident's official record, so only a Center Head or
 * Administrator may remove it even when the requester uploaded it.
 */
const DOCUMENT_DELETE_ROLES = ['centerhead', 'admin'];

/**
 * The document's audit trail.
 *
 * Everything that ever happened to a document, oldest first: who uploaded it,
 * every submission and resubmission, and every review decision with the
 * reviewer's note. This is where a rejection reason stays readable after the
 * document has been corrected and resubmitted — `documents` only ever holds the
 * most recent decision.
 *
 * Readable by anyone who can read the document, so the submitter can always go
 * back and read what a reviewer asked for.
 */
async function getHistory(req, res, next) {
  try {
    const { id } = req.params;
    const document = await getReadableDocument(id, req.user);
    if (!document) throw new ApiError(404, 'Document not found');

    const [rows] = await pool.query(
      `SELECT id, documentId, revision, action, status, actor, actorRole, reason, notes, createdAt
         FROM documentRevisions
        WHERE documentId = ?
        ORDER BY revision ASC, createdAt ASC, id ASC`,
      [id]
    );

    res.json({
      success: true,
      data: rows,
      count: rows.length,
      // The current decision, for a caller that wants the trail and the state
      // together. `rejectionReason` here is the LAST rejection, which the trail
      // above may hold several of.
      document: mapRow('documents', withoutFileData(document)),
    });
  } catch (error) {
    next(error);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM documents WHERE id = ?', [id]);
    if (rows.length === 0) throw new ApiError(404, 'Document not found');

    const document = rows[0];
    const role = normalizeRole(req.user?.role);
    const isPrivileged = DOCUMENT_DELETE_ROLES.includes(role);

    // A rejected document is the evidence for the correction it asks for: the
    // reviewer's note, the version that was rejected, and the resubmission that
    // followed. Deleting it would destroy the audit trail the module exists to
    // keep, so it is archived instead of removed — nobody may delete it.
    if (document.status === 'Rejected') {
      throw new ApiError(
        409,
        'A rejected document cannot be deleted. It is kept as the record of the review — archive it instead.'
      );
    }

    if (!isPrivileged && !documentOwnerMatchesUser(document, req.user)) {
      throw new ApiError(403, 'You are not permitted to delete this document.');
    }

    if (document.status === 'Approved' && !isPrivileged) {
      throw new ApiError(
        403,
        'Approved documents can only be deleted by a Center Head or an Administrator.'
      );
    }

    await baseController.delete(req, res, next);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAll,
  getFile,
  getById,
  getRequestableDocuments,
  create,
  update,
  delete: remove,
  submit,
  approve,
  reject,
  getByResident,
  getPending,
  getHistory,
  getAllowedForRole,
  canReadDocument,
  filterReadableDocuments,
  getApprovedDocumentIds,
  canReadDocumentAsync,
  // Resident-scope helpers. Exported so the access-request reviewer rule and the
  // bulk store load apply the same rule as the single-document read path.
  CASELOAD_SCOPED_ROLES,
  assignedResidentIds,
  loadDocumentScope,
  residentInScope,
  documentVisibleTo,
};
