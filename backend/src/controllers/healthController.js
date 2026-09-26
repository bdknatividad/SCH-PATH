/**
 * Health Record Controller
 * @module controllers/healthController
 * @description Health record management with vital signs and medications
 *
 * Every save also files a PDF of the record into the resident's Documents
 * folder — see `publishDocumentForHealthRecord`. The Health module and the
 * Documents module used to disagree about what a nurse had recorded: the record
 * was saved and shown here, but the child's file in the Documents module never
 * received it, which is where the Center Head and the Social Worker look.
 */

const { pool } = require('../config/database');
const { activeAdmissionIdFor } = require('../services/admissionLink');
const { createController } = require('./baseController');
const { ApiError } = require('../middleware/errorHandler');
const { insertWithGeneratedId, mapRow, toMysqlDateTime } = require('../utils/helpers');
const { canAccessResident } = require('./assignmentController');
const { RESOURCES } = require('../utils/constants');
const { normalizeRole } = require('../utils/authorization');
const { categoryForDocument } = require('../utils/documentCategory');
const { buildHealthRecordDocument } = require('../utils/healthRecordPdf');

const baseController = createController('healthRecords');

// The resource contract drives the INSERT/UPDATE column lists, exactly as
// `baseController` builds them, so a column added to `RESOURCES.healthRecords`
// is written here too without a second edit.
const HEALTH_RECORD_COLUMNS = RESOURCES.healthRecords.columns;
const HEALTH_RECORD_JSON_FIELDS = RESOURCES.healthRecords.jsonFields;
const HEALTH_RECORD_PREFIX = RESOURCES.healthRecords.prefix;

/**
 * The Documents category stamped on a published health record.
 *
 * `medical` is the key `documentController.DOCUMENT_READ_ROLES_BY_CATEGORY`
 * resolves to the Nurse, the Center Head and the Admin, so this is what makes a
 * published record readable by the people who are supposed to read it — and by
 * nobody else.
 */
const HEALTH_DOCUMENT_CATEGORY = 'Medical';

/**
 * The folder every health record is filed in, resolved from the routing rules
 * rather than written as a literal, so renaming the folder in
 * `config/documentCategories.json` cannot strand these documents in the old one.
 *
 * It is resolved from the *category*, not from the record type, on purpose. The
 * rules match a type by exact name, and the record types are not folder names —
 * "Height & Weight Monitoring" shares no keyword with any rule and would fall
 * through to "Other Documents". Routing on the category the record is stamped
 * with makes the folder deterministic for all six types.
 */
const HEALTH_DOCUMENT_FOLDER = categoryForDocument({ category: HEALTH_DOCUMENT_CATEGORY });

/**
 * Build the column list a write uses, skipping the columns the caller did not
 * send and the two the database maintains itself.
 */
function writeColumns(data) {
  const columns = [];
  const values = [];
  for (const column of HEALTH_RECORD_COLUMNS) {
    if (column === 'id' || column === 'createdAt' || column === 'updatedAt') continue;
    if (data[column] === undefined) continue;
    columns.push(column);
    values.push(
      HEALTH_RECORD_JSON_FIELDS.includes(column) && typeof data[column] === 'object'
        ? JSON.stringify(data[column])
        : data[column]
    );
  }
  return { columns, values };
}

/**
 * Publish a health record into the resident's Documents folder.
 *
 * The entry is filed Child → Medical Records and is Approved from the moment it
 * is written, with the record's author as the approver. That is the Documents
 * module's own convention for medical documents — `documentController.create`
 * deliberately preserves an already-approved Medical upload for exactly this
 * reason ("Medical documents are auto-approved by design") — and it keeps these
 * out of Pending Review, which lists only what a reviewer still has to decide.
 *
 * Idempotent by link: `documents.healthRecordId` carries a unique index, so
 * editing a record rewrites the entry already on file instead of adding a second
 * copy of the same record to the child's folder.
 *
 * @param {Object} record A `healthRecords` row, already mapped.
 * @param {Object} [actor] The authenticated user performing the save.
 * @returns {Promise<string>} the document id.
 */
async function publishDocumentForHealthRecord(record, actor) {
  const [childRows] = await pool.query(
    'SELECT name, age, gender, birthDate, admissionDate, casePhase FROM children WHERE id = ?',
    [record.residentId]
  );
  const resident = childRows[0] || {};
  const residentName = resident.name || record.residentName || null;

  const { buffer, fileName, fileSize, title } = await buildHealthRecordDocument(record, {
    name: residentName,
    age: resident.age,
    gender: resident.gender,
    birthDate: resident.birthDate,
    admissionDate: resident.admissionDate,
    casePhase: resident.casePhase,
  });

  const author = record.recordedBy || actor?.username || null;
  const uploaderRole = normalizeRole(actor?.role) || 'nurse';
  const description = `System-generated copy of the resident's ${record.recordType}`
    + (record.date ? ` dated ${record.date}` : '')
    + '. Filed automatically by the Health module.';
  const fileData = buffer.toString('base64');

  /*
   * Re-publish in place, preserving the admission the document was filed under.
   *
   * `residentId` is rewritten because an edit can move the record to a different
   * resident, and the document has to follow it into that child's folder.
   *
   * The admission link is a different matter, and getting it wrong is what mixed
   * a returning resident's records together. It used to be re-resolved from the
   * resident's *current* admission on every save — so once a resident had been
   * discharged and re-admitted, the next unrelated edit to an older health
   * record silently dragged that record's document out of its own admission
   * folder and into the newest one. The original value was overwritten in place,
   * so nothing could put it back.
   *
   * A document belongs to the admission it was created under, permanently. The
   * only circumstance that justifies re-filing it is the record itself moving to
   * another resident — in which case the old link points at an admission that
   * belongs to a different child and must be replaced. When the resident is
   * unchanged, the existing link is left exactly as it is, which is also what
   * keeps two same-day admissions separable.
   */
  const [existing] = await pool.query(
    'SELECT id, residentId, admissionId FROM documents WHERE healthRecordId = ? LIMIT 1',
    [record.id]
  );
  if (existing.length) {
    const previous = existing[0];
    const residentChanged = String(previous.residentId || '') !== String(record.residentId || '');

    // Only a genuine move re-resolves the admission; otherwise it is carried
    // through untouched.
    const admissionId = residentChanged
      ? await activeAdmissionIdFor(pool, record.residentId)
      : previous.admissionId;

    await pool.query(
      `UPDATE documents SET residentId = ?, admissionId = ?, residentName = ?, title = ?, type = ?, description = ?,
       fileName = ?, fileSize = ?, fileType = 'application/pdf', fileData = ?,
       category = ?, documentCategory = ?, uploaderRole = ?,
       approvedBy = ?, approvedAt = NOW(), submittedBy = ?, modifiedBy = ? WHERE id = ?`,
      [record.residentId, admissionId, residentName, title, record.recordType, description, fileName, fileSize, fileData,
        HEALTH_DOCUMENT_CATEGORY, HEALTH_DOCUMENT_FOLDER, uploaderRole,
        author, author, actor?.username || author, previous.id]
    );
    return previous.id;
  }

  // `submittedBy` is the nurse who recorded the health data, not the account that
  // happened to trigger the write — the folder view shows who submitted a
  // document, and `uploadedBy` already carries the publisher.
  // Filed under the admission the resident is currently in, so a health record
  // written after a re-intake never lands in an earlier admission's folder.
  const admissionId = await activeAdmissionIdFor(pool, record.residentId);
  return insertWithGeneratedId(pool, {
    table: 'documents',
    prefix: 'DOC',
    insert: (id) => pool.query(
      `INSERT INTO documents (id, residentId, admissionId, residentName, title, type, category, documentCategory, description,
         fileName, fileSize, fileType, fileData, uploaderRole, status, submittedBy, submittedAt,
         uploadedBy, uploadedAt, approvedBy, approvedAt, healthRecordId, createdBy, modifiedBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?, 'Approved', ?, NOW(), ?, NOW(), ?, NOW(), ?, ?, ?)`,
      [id, record.residentId, admissionId, residentName, title, record.recordType, HEALTH_DOCUMENT_CATEGORY,
        HEALTH_DOCUMENT_FOLDER, description, fileName, fileSize, fileData, uploaderRole,
        author, author, author, record.id, actor?.username || author, actor?.username || author]
    ),
  });
}

/**
 * Publish without letting a failure lose the record.
 *
 * The record has already been committed by the time this runs. A record that has
 * been saved must stay saved even if the PDF cannot be written, so the failure is
 * reported and swallowed — re-saving the record regenerates the document, whereas
 * a 500 on a successful save would leave the caller believing nothing was stored.
 */
async function publishSafely(record, actor) {
  try {
    return await publishDocumentForHealthRecord(record, actor);
  } catch (error) {
    console.error(`[Health Controller] Publishing the PDF for ${record?.id} failed (non-fatal):`, error.message);
    return null;
  }
}

function validateHealthRecord(data, partial = false) {
  const recordType = data.recordType;
  if (!partial || data.residentId !== undefined) {
    if (!String(data.residentId || '').trim()) throw new ApiError(400, 'residentId is required');
  }
  if (!partial || data.residentName !== undefined) {
    if (!String(data.residentName || '').trim()) throw new ApiError(400, 'residentName is required');
  }
  if (!partial || data.recordType !== undefined) {
    if (!['Medical Record', 'Dental Services', 'Height & Weight Monitoring', 'Health Assessment', 'Medication Log', 'Medical Treatment'].includes(recordType)) {
      throw new ApiError(400, 'A valid health record type is required');
    }
  }

  const details = data.details || {};
  if (recordType === 'Medical Record') {
    const rows = Array.isArray(details.medicalRows) ? details.medicalRows : [];
    const hasRow = rows.some(row => Object.values(row || {}).some(value => String(value || '').trim()));
    if (!hasRow && (!String(details.medicalFindings || '').trim() || !String(details.careProvider || '').trim())) {
      throw new ApiError(400, 'At least one medical record row is required');
    }
  }
  if (recordType === 'Dental Services' && (!String(details.chiefComplaints || '').trim() || !String(details.dentalService || '').trim())) {
    throw new ApiError(400, 'chiefComplaints and dentalService are required for dental records');
  }
  if (recordType === 'Height & Weight Monitoring' && !String(details.monitoringYear || '').trim()) {
    throw new ApiError(400, 'monitoringYear is required for height and weight monitoring');
  }
  if (!partial || data.date !== undefined) {
    if (!String(data.date || '').trim()) throw new ApiError(400, 'date is required');
  }

  if (recordType === 'Health Assessment' && (!String(data.assessmentType || '').trim() || !String(data.findings || '').trim())) {
    throw new ApiError(400, 'assessmentType and findings are required for health assessments');
  }
  if (recordType === 'Medication Log' && (!String(data.medicationName || '').trim() || !String(data.dosage || '').trim() || !String(data.frequency || '').trim())) {
    throw new ApiError(400, 'medicationName, dosage, and frequency are required for medication logs');
  }
  if (recordType === 'Medical Treatment' && (!String(data.treatmentType || '').trim() || !String(data.procedure_ || '').trim())) {
    throw new ApiError(400, 'treatmentType and procedure_ are required for medical treatments');
  }
}

/**
 * POST / — save a health record and file its PDF in the resident's folder.
 *
 * The write is done here rather than through `baseController.create` because the
 * document has to exist *before* the response is sent: the Health module calls
 * `refreshData()` as soon as this request resolves, and a document written after
 * the response would not be in that reload — which is the whole bug.
 */
async function create(req, res, next) {
  try {
    const data = req.body || {};
    validateHealthRecord(data);

    const { columns, values } = writeColumns(data);
    const allColumns = ['id', ...columns];
    const placeholders = ['?', ...columns.map(() => '?')];
    const allValues = [...values];

    if (req.user && !allColumns.includes('createdBy')) {
      allColumns.push('createdBy');
      placeholders.push('?');
      allValues.push(req.user.username);
    }

    const newId = await insertWithGeneratedId(pool, {
      table: 'healthRecords',
      prefix: HEALTH_RECORD_PREFIX,
      insert: (id) => pool.query(
        `INSERT INTO healthRecords (${allColumns.join(', ')}) VALUES (${placeholders.join(', ')})`,
        [id, ...allValues]
      ),
    });

    const [rows] = await pool.query('SELECT * FROM healthRecords WHERE id = ?', [newId]);
    const record = mapRow('healthRecords', rows[0]);
    const documentId = await publishSafely(record, req.user);

    res.status(201).json({
      success: true,
      data: record,
      documentId,
      message: 'healthRecords created successfully',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /:id — update a health record and re-file its PDF.
 *
 * The published document is rewritten rather than re-created, so an edited record
 * updates the copy already in the child's folder.
 */
async function update(req, res, next) {
  try {
    const { id } = req.params;
    const data = req.body || {};
    validateHealthRecord(data);

    const [existing] = await pool.query('SELECT * FROM healthRecords WHERE id = ?', [id]);
    if (existing.length === 0) {
      throw new ApiError(404, 'healthRecords not found');
    }

    const { columns, values } = writeColumns(data);
    const updates = columns.map((column) => `${column} = ?`);
    const updateValues = [...values];

    if (req.user && HEALTH_RECORD_COLUMNS.includes('modifiedBy')) {
      updates.push('modifiedBy = ?');
      updateValues.push(req.user.username);
    }
    if (updates.length === 0) {
      throw new ApiError(400, 'No fields to update');
    }

    updateValues.push(id);
    await pool.query(`UPDATE healthRecords SET ${updates.join(', ')} WHERE id = ?`, updateValues);

    const [rows] = await pool.query('SELECT * FROM healthRecords WHERE id = ?', [id]);
    const record = mapRow('healthRecords', rows[0]);
    const documentId = await publishSafely(record, req.user);

    res.json({
      success: true,
      data: record,
      documentId,
      message: 'healthRecords updated successfully',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /:id/prescription-given — record that a prescription has been given.
 *
 * Deliberately not `PUT /:id`. That route re-publishes the record's document
 * (`publishSafely`), so toggling one checkbox would rewrite the child's filed
 * copy of the record — and it validates the whole record, so a Medication Log
 * saved before a field became required could not be marked given at all.
 *
 * Both surfaces call this one route: the Medication Log row in the Health module
 * and the prescription list in Child Records → Medical. There is one column pair
 * behind it, so "done in either place is done in both" is a property of the data
 * rather than two states the UI has to keep in step.
 *
 * Toggleable — `given: false` clears it, for one marked by mistake. Gated on
 * `Health:edit` at the route, which is the Nurse and the Center Head, the same
 * rule the module already applies to its other writes.
 */
async function markPrescriptionGiven(req, res, next) {
  try {
    const { id } = req.params;
    const given = req.body?.given !== false;

    const [existing] = await pool.query('SELECT id, recordType FROM healthRecords WHERE id = ?', [id]);
    if (existing.length === 0) throw new ApiError(404, 'healthRecords not found');
    if (String(existing[0].recordType || '') !== 'Medication Log') {
      throw new ApiError(400, 'Only a Medication Log entry is a prescription that can be marked as given.');
    }

    await pool.query(
      'UPDATE healthRecords SET givenAt = ?, givenBy = ?, modifiedBy = ? WHERE id = ?',
      [
        given ? toMysqlDateTime(new Date()) : null,
        given ? (req.user?.username || null) : null,
        req.user?.username || null,
        id,
      ],
    );

    const [rows] = await pool.query('SELECT * FROM healthRecords WHERE id = ?', [id]);
    res.json({
      success: true,
      data: mapRow('healthRecords', rows[0]),
      message: given ? 'Prescription marked as given.' : 'Prescription marked as not yet given.',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /:id — delete a health record and the copy filed in Documents.
 *
 * The published document exists only because the record does. Leaving it behind
 * would keep a deleted record visible in the child's folder with nothing left to
 * link it back to, so it goes with the record — the same rule the Anecdotal
 * Report publisher applies. The document removal is non-fatal: the record is
 * already deleted, and a stale document can be cleaned up later where a 500 on a
 * successful delete cannot be undone by the caller.
 */
async function remove(req, res, next) {
  try {
    const { id } = req.params;

    const [existing] = await pool.query('SELECT * FROM healthRecords WHERE id = ?', [id]);
    if (existing.length === 0) {
      throw new ApiError(404, 'healthRecords not found');
    }

    await pool.query('DELETE FROM healthRecords WHERE id = ?', [id]);

    try {
      await pool.query('DELETE FROM documents WHERE healthRecordId = ?', [id]);
    } catch (error) {
      console.error(`[Health Controller] Removing the published document for ${id} failed (non-fatal):`, error.message);
    }

    res.json({ success: true, message: 'healthRecords deleted successfully' });
  } catch (error) {
    next(error);
  }
}

/**
 * Get health records by resident
 * @async
 */
async function getByResident(req, res, next) {
  try {
    const { residentId } = req.params;
    if (!await canAccessResident(req.user, residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }
    
    const [rows] = await pool.query(
      'SELECT * FROM healthRecords WHERE residentId = ? ORDER BY date DESC, createdAt DESC',
      [residentId]
    );

    res.json({
      success: true,
      data: rows.map(row => mapRow('healthRecords', row)),
      count: rows.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get latest health record for resident
 * @async
 */
async function getLatest(req, res, next) {
  try {
    const { residentId } = req.params;
    if (!await canAccessResident(req.user, residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }
    
    const [rows] = await pool.query(
      'SELECT * FROM healthRecords WHERE residentId = ? ORDER BY date DESC LIMIT 1',
      [residentId]
    );

    if (rows.length === 0) {
      return res.json({
        success: true,
        data: null,
      });
    }

    res.json({
      success: true,
      data: mapRow('healthRecords', rows[0]),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get health statistics for resident
 *
 * NOTE: healthRecords has no vitals columns (temperature/weight/height/pulse);
 * height & weight live inside the `details` JSON. Querying those columns made
 * this endpoint fail with "Unknown column 'temperature' in 'field list'".
 * @async
 */
async function getStats(req, res, next) {
  try {
    const { residentId } = req.params;
    
    const [rows] = await pool.query(
      `SELECT 
        COUNT(*) as totalRecords,
        MAX(date) as lastCheckup,
        MAX(details) as latestDetails
      FROM healthRecords 
      WHERE residentId = ?`,
      [residentId]
    );

    const stats = rows[0] || {};
    let latestDetails = null;
    if (stats.latestDetails) {
      try {
        latestDetails = typeof stats.latestDetails === 'string'
          ? JSON.parse(stats.latestDetails)
          : stats.latestDetails;
      } catch {
        latestDetails = null;
      }
    }
    delete stats.latestDetails;

    res.json({
      success: true,
      data: { ...stats, latestDetails },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAll: baseController.getAll,
  getById: baseController.getById,
  create,
  update,
  delete: remove,
  markPrescriptionGiven,
  getByResident,
  getLatest,
  getStats,
  // Exported for the test suite: the folder and category a published record is
  // filed under are load-bearing (they decide who can read it), so they are
  // asserted rather than left implicit.
  HEALTH_DOCUMENT_CATEGORY,
  HEALTH_DOCUMENT_FOLDER,
  publishDocumentForHealthRecord,
};
