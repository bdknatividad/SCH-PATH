/**
 * Physical Examination — the digital version of the facility's paper form
 * (Name, Date, Date of Admission, Age, and a front/back body diagram on which
 * tattoos and piercings are marked).
 *
 * Each saved examination is two linked records:
 *
 *  - a `physical_examinations` row, holding the structured exam (the markers,
 *    with where they were placed on the diagram) so it can be re-opened; and
 *  - a `documents` row titled "Physical Examination" carrying the generated
 *    PDF, which is what the resident's Documents folder and the Admission
 *    Phase checklist already understand.
 *
 * The document is filed through the Documents module's own create handler —
 * not a copy of it — so it gets the same folder, admission, approval workflow,
 * revision history and notifications as any other upload. If the exam row
 * cannot be written afterwards the document is removed again, so a save never
 * leaves half of itself behind.
 *
 * The resident and the admission are never taken from the request: the
 * admission is the resident's open one (`activeAdmissionIdFor`), the same rule
 * the Documents module applies.
 *
 * @module controllers/physicalExaminationController
 */

const { pool } = require('../config/database');
const { ApiError } = require('../middleware/errorHandler');
const { insertWithGeneratedId } = require('../utils/helpers');
const { activeAdmissionIdFor } = require('../services/admissionLink');
const { canAccessResident } = require('./assignmentController');
const documentController = require('./documentController');

const MARKING_TYPES = ['Tattoo', 'Piercing'];

/** Mirrored in frontend/src/app/components/PhysicalExamination.tsx. */
const BODY_PARTS = [
  'Head', 'Face', 'Left Ear', 'Right Ear', 'Eyebrow', 'Nose', 'Lip', 'Tongue', 'Neck',
  'Chest', 'Abdomen', 'Navel', 'Back', 'Upper Back', 'Lower Back',
  'Left Shoulder', 'Right Shoulder', 'Left Arm', 'Right Arm', 'Left Elbow', 'Right Elbow',
  'Left Forearm', 'Right Forearm', 'Left Hand', 'Right Hand', 'Left Finger', 'Right Finger',
  'Hip', 'Buttocks', 'Left Thigh', 'Right Thigh', 'Left Leg', 'Right Leg',
  'Left Knee', 'Right Knee', 'Left Foot', 'Right Foot', 'Other',
];

const MAX_MARKINGS = 60;
const MAX_LABEL = 200;
const MAX_NOTES = 1000;

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapExam(row) {
  if (!row) return null;
  return {
    ...row,
    markings: parseJson(row.markings, []),
  };
}

/**
 * The markers, checked one by one. A marker is a point on the front or back
 * figure — `x`/`y` as fractions of the figure's width and height, so it stays
 * on the spot it was placed at whatever size the diagram is drawn — plus what
 * was found there.
 */
function normalizeMarkings(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new ApiError(400, 'Markings must be a list.');
  if (input.length > MAX_MARKINGS) throw new ApiError(400, `At most ${MAX_MARKINGS} markers can be recorded on one examination.`);
  return input.map((m, index) => {
    const n = index + 1;
    const view = m?.view === 'back' ? 'back' : m?.view === 'front' ? 'front' : null;
    if (!view) throw new ApiError(400, `Marker ${n}: it must be on the front or the back figure.`);
    const x = Number(m?.x); const y = Number(m?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      throw new ApiError(400, `Marker ${n}: its position on the diagram is invalid.`);
    }
    if (!MARKING_TYPES.includes(m?.type)) throw new ApiError(400, `Marker ${n}: the type must be Tattoo or Piercing.`);
    if (!BODY_PARTS.includes(m?.bodyPart)) throw new ApiError(400, `Marker ${n}: choose the body part from the list.`);
    const label = String(m?.label ?? '').trim();
    const notes = String(m?.notes ?? '').trim();
    if (label.length > MAX_LABEL) throw new ApiError(400, `Marker ${n}: the label is longer than ${MAX_LABEL} characters.`);
    if (notes.length > MAX_NOTES) throw new ApiError(400, `Marker ${n}: the notes are longer than ${MAX_NOTES} characters.`);
    return {
      id: String(m?.id || `M${n}`).slice(0, 40),
      view, x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000,
      type: m.type, bodyPart: m.bodyPart, label, notes,
    };
  });
}

/** Run an Express handler in-process and resolve with what it sent. */
function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      setHeader() { return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler(req, res, (error) => (error ? reject(error) : resolve({ status: res.statusCode, body: null }))))
      .catch(reject);
  });
}

async function assertCanRead(user, residentId) {
  if (!await canAccessResident(user, residentId, { area: 'child-records' })) {
    throw new ApiError(403, 'You are not assigned to this resident');
  }
}

/** GET /api/physical-examinations/resident/:residentId — newest first. */
async function listForResident(req, res, next) {
  try {
    const { residentId } = req.params;
    await assertCanRead(req.user, residentId);
    const [rows] = await pool.query(
      `SELECT pe.*, d.status AS documentStatus
         FROM physical_examinations pe
         LEFT JOIN documents d ON d.id = pe.documentId
        WHERE pe.residentId = ?
        ORDER BY pe.examDate DESC, pe.createdAt DESC`,
      [residentId],
    );
    res.json({ success: true, data: rows.map(mapExam), count: rows.length });
  } catch (error) {
    next(error);
  }
}

/** GET /api/physical-examinations/:id */
async function getById(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT pe.*, d.status AS documentStatus
         FROM physical_examinations pe
         LEFT JOIN documents d ON d.id = pe.documentId
        WHERE pe.id = ?`,
      [req.params.id],
    );
    if (!rows.length) throw new ApiError(404, 'Physical examination not found');
    await assertCanRead(req.user, rows[0].residentId);
    res.json({ success: true, data: mapExam(rows[0]) });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/physical-examinations
 *
 * Body: { residentId, examDate, markings, pdf: { fileName, fileData, fileSize } }
 */
async function create(req, res, next) {
  try {
    const body = req.body || {};
    const residentId = String(body.residentId || '').trim();
    if (!residentId) throw new ApiError(400, 'residentId is required');

    const examDate = String(body.examDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(examDate)) throw new ApiError(400, 'Enter the date of the examination.');

    const markings = normalizeMarkings(body.markings);

    const pdf = body.pdf || {};
    const fileData = String(pdf.fileData || '');
    if (!/^data:application\/pdf;base64,[A-Za-z0-9+/=]{100,}$/.test(fileData)) {
      throw new ApiError(400, 'The examination PDF is missing.');
    }

    const [children] = await pool.query('SELECT id, name FROM children WHERE id = ?', [residentId]);
    if (!children.length) throw new ApiError(404, 'Resident not found');
    const resident = children[0];

    // The resident's open admission — the same one the document is filed under.
    const admissionId = await activeAdmissionIdFor(pool, residentId);
    let admissionDate = null;
    if (admissionId) {
      const [admRows] = await pool.query(
        "SELECT DATE_FORMAT(admissionDate, '%Y-%m-%d') AS admissionDate FROM admissions WHERE id = ?",
        [admissionId],
      );
      admissionDate = admRows[0]?.admissionDate || null;
    }
    const residentAge = Number.isFinite(Number(body.residentAge)) && body.residentAge !== '' && body.residentAge !== null
      ? Math.max(0, Math.min(130, Math.round(Number(body.residentAge)))) : null;

    // 1. File the PDF through the Documents module itself.
    const tattoos = markings.filter((m) => m.type === 'Tattoo').length;
    const piercings = markings.filter((m) => m.type === 'Piercing').length;
    // The database's own clock, as the rest of the server stamps NOW().
    const [[clock]] = await pool.query("SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS now");
    const now = clock?.now || null;
    const documentRequest = {
      ...req,
      body: {
        residentId,
        residentName: resident.name,
        title: 'Physical Examination',
        type: 'PDF',
        category: 'Medical',
        phase: '',
        description: `Physical Examination of ${resident.name} on ${examDate} — ${tattoos} tattoo(s), ${piercings} piercing(s) marked on the body diagram.`,
        fileName: String(pdf.fileName || `Physical_Examination_${examDate}.pdf`).slice(0, 200),
        fileType: 'application/pdf',
        fileSize: Number(pdf.fileSize) || Math.round((fileData.length * 3) / 4),
        fileData,
        uploaderRole: req.user?.role,
        uploadedBy: req.user?.username,
        uploadedAt: now,
        status: 'Submitted',
        submittedBy: req.user?.username,
        submittedAt: now,
        requiresAssessment: false,
        assessmentTriggered: false,
      },
    };
    const filed = await invoke(documentController.create, documentRequest);
    const documentId = filed?.body?.data?.id;
    if (!documentId) throw new ApiError(500, 'The examination could not be filed in Documents.');

    // 2. Record the examination, linked to that document.
    try {
      const newId = await insertWithGeneratedId(pool, {
        table: 'physical_examinations',
        prefix: 'PEX',
        insert: (id) => pool.query(
          `INSERT INTO physical_examinations
             (id, residentId, admissionId, examDate, residentAge, admissionDate, markings, documentId, examinedBy, createdBy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, residentId, admissionId, examDate, residentAge, admissionDate, JSON.stringify(markings),
            documentId, req.user?.username || null, req.user?.username || null],
        ),
      });
      const [rows] = await pool.query(
        `SELECT pe.*, d.status AS documentStatus FROM physical_examinations pe
           LEFT JOIN documents d ON d.id = pe.documentId WHERE pe.id = ?`,
        [newId],
      );
      res.status(201).json({
        success: true,
        data: mapExam(rows[0]),
        message: 'Physical Examination saved and filed in the resident\'s Documents.',
      });
    } catch (error) {
      // Do not leave a document behind for an examination that was not saved.
      try {
        await pool.query('DELETE FROM documentRevisions WHERE documentId = ?', [documentId]);
      } catch { /* the table may not exist on an older database */ }
      await pool.query('DELETE FROM documents WHERE id = ?', [documentId]).catch(() => {});
      throw error;
    }
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listForResident,
  getById,
  create,
  normalizeMarkings,
  BODY_PARTS,
  MARKING_TYPES,
};
