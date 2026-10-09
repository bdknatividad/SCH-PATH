/**
 * Education Progress Monitoring.
 *
 * Replaces the Pass / Fail subject results. For every subject (module,
 * activity) on the learner's level list the Educator records a progress status
 * and the outputs submitted against the outputs expected; and for every learner
 * one monitoring record — modules / activities completed and pending, outputs
 * submitted and not submitted, progress / participation notes, the date of
 * monitoring and any education-related concerns.
 *
 * Reading follows the Education module's existing permissions (the routes are
 * behind `requireModule('Education')`); the Child Record → Education tab reads
 * the same rows through `childController.educationForResident`.
 *
 * Writing is the Educator's alone: `Education: edit` and the Educator role. A
 * Center Head or Administrator holds Education: edit too, but progress is the
 * Educator's monitoring, so they read it and do not change it.
 *
 * @module controllers/educationProgressController
 */

const { pool } = require('../config/database');
const { ApiError } = require('../middleware/errorHandler');
const { snapshotFor } = require('../middleware/rbac');
const { hasPermission } = require('../config/rbac');
const { normalizeRole } = require('../utils/authorization');
const { generateId, runInTransactionWithIdRetry, mapRow } = require('../utils/helpers');
const { RESOURCES } = require('../utils/constants');
const { isClosedResidentStatus } = require('../utils/residentStatus');
const { resolveEducationResident } = require('../utils/educationResident');
const { activeAdmissionIdFor } = require('../services/admissionLink');
const {
  PROGRESS_STATUSES,
  MONITORING_FIELDS,
  subjectLevelFor,
  completionOf,
  progressSummaries,
} = require('../utils/educationSubjects');

const TEXT_LIMIT = 5000;
const MAX_OUTPUTS = 999;

/** Only the Educator updates a learner's progress. */
function mayEditProgress(req) {
  if (normalizeRole(req.user?.role) !== 'educator') return false;
  return hasPermission(snapshotFor(req), 'Education', 'edit');
}

async function loadRecord(id) {
  const [rows] = await pool.query(
    'SELECT id, name, residentId, educationLevel, archivedAt FROM education_records WHERE id = ?',
    [id],
  );
  if (!rows.length) throw new ApiError(404, 'Education record not found');
  return rows[0];
}

/** GET /education-progress/summary — every learner, for the cards and tiles. */
async function summary(req, res, next) {
  try {
    res.json({ success: true, data: await progressSummaries(pool), canEdit: mayEditProgress(req) });
  } catch (error) {
    next(error);
  }
}

/** GET /education-progress/:educationRecordId — one learner. */
async function getOne(req, res, next) {
  try {
    const record = await loadRecord(req.params.educationRecordId);
    const [progress] = await progressSummaries(pool, { recordIds: [record.id] });
    // An archived learner's progress is history: readable, never edited.
    res.json({ success: true, data: progress, canEdit: mayEditProgress(req) && !record.archivedAt });
  } catch (error) {
    next(error);
  }
}

function countOrNull(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > MAX_OUTPUTS) {
    throw new ApiError(400, `${label} must be a whole number from 0 to ${MAX_OUTPUTS}.`);
  }
  return number;
}

function cleanText(value, label) {
  const text = String(value ?? '').trim();
  if (text.length > TEXT_LIMIT) throw new ApiError(400, `${label} is too long (${TEXT_LIMIT} characters at most).`);
  return text || null;
}

/**
 * PUT /education-progress/:educationRecordId
 *
 * Body: `{ subjects?: [{ subjectId, status, outputsSubmitted?, outputsTotal? }],
 *          monitoring?: { monitoringDate, modulesCompleted, modulesPending,
 *                         outputsSubmitted, outputsNotSubmitted,
 *                         participationNotes, concerns } }`
 *
 * Saved in one transaction: a learner's subject row is updated when it exists
 * (one per learner per subject — the unique key) and created otherwise, and the
 * learner's single monitoring record likewise. Nothing is ever duplicated.
 */
async function save(req, res, next) {
  try {
    if (!mayEditProgress(req)) {
      throw new ApiError(403, 'Only the Educator can update a student\'s education progress.');
    }
    const record = await loadRecord(req.params.educationRecordId);
    if (record.archivedAt) {
      throw new ApiError(409, 'This student is archived. Their education progress is kept as history and can no longer be edited.');
    }
    const body = req.body || {};

    // The learner's resident (linked when the record never was) and the
    // admission the resident is in now — the same ids every other education
    // row and document carries.
    const owner = await resolveEducationResident(pool, record);
    const residentId = owner?.residentId || null;
    if (residentId) {
      const [[child]] = await pool.query('SELECT status FROM children WHERE id = ?', [residentId]);
      const status = child?.status;
      if (isClosedResidentStatus(status) || status === 'Absconded') {
        throw new ApiError(409, `This resident is ${String(status).toLowerCase()}, so they are no longer on the Education roll. Their progress is kept for history.`);
      }
    }
    const admissionId = residentId ? await activeAdmissionIdFor(pool, residentId) : null;

    // Subjects: each must be on the learner's level list.
    const [levelSubjects] = await pool.query(
      'SELECT id, name FROM education_subjects WHERE educationLevel = ?',
      [subjectLevelFor(record.educationLevel)],
    );
    const subjectNames = new Map(levelSubjects.map((s) => [s.id, s.name]));
    const subjects = [];
    if (body.subjects !== undefined) {
      if (!Array.isArray(body.subjects)) throw new ApiError(400, 'subjects must be a list.');
      const seen = new Set();
      for (const entry of body.subjects) {
        const subjectId = String(entry?.subjectId || '').trim();
        const name = subjectNames.get(subjectId);
        if (!name) throw new ApiError(400, 'A subject is not on this learner\'s subject list.');
        if (seen.has(subjectId)) throw new ApiError(400, `${name} is listed twice.`);
        seen.add(subjectId);
        const status = String(entry?.status || '').trim();
        if (!PROGRESS_STATUSES.includes(status)) {
          throw new ApiError(400, `The status of ${name} must be one of: ${PROGRESS_STATUSES.join(', ')}.`);
        }
        const outputsSubmitted = countOrNull(entry?.outputsSubmitted, `${name}: outputs submitted`);
        const outputsTotal = countOrNull(entry?.outputsTotal, `${name}: total outputs`);
        if (outputsSubmitted !== null && outputsTotal !== null && outputsSubmitted > outputsTotal) {
          throw new ApiError(400, `${name}: outputs submitted cannot be more than the total outputs.`);
        }
        subjects.push({ subjectId, status, outputsSubmitted, outputsTotal });
      }
    }

    // The monitoring record.
    let monitoring = null;
    if (body.monitoring !== undefined && body.monitoring !== null) {
      if (typeof body.monitoring !== 'object') throw new ApiError(400, 'monitoring must be an object.');
      const date = String(body.monitoring.monitoringDate || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
        throw new ApiError(400, 'Enter the Date of Monitoring.');
      }
      monitoring = {
        monitoringDate: date,
        modulesCompleted: cleanText(body.monitoring.modulesCompleted, 'Modules/Activities Completed'),
        modulesPending: cleanText(body.monitoring.modulesPending, 'Modules/Activities Pending'),
        outputsSubmitted: cleanText(body.monitoring.outputsSubmitted, 'Outputs Submitted'),
        outputsNotSubmitted: cleanText(body.monitoring.outputsNotSubmitted, 'Outputs Not Submitted'),
        participationNotes: cleanText(body.monitoring.participationNotes, 'Progress/Participation Notes'),
        concerns: cleanText(body.monitoring.concerns, 'Education-Related Concerns'),
      };
    }

    const actor = req.user?.username || null;

    await runInTransactionWithIdRetry(pool, async (connection) => {
      for (const entry of subjects) {
        const [existing] = await connection.query(
          'SELECT id FROM education_subject_results WHERE educationRecordId = ? AND subjectId = ? FOR UPDATE',
          [record.id, entry.subjectId],
        );
        if (existing.length) {
          await connection.query(
            `UPDATE education_subject_results
                SET progressStatus = ?, outputsSubmitted = ?, outputsTotal = ?, residentId = ?, modifiedBy = ?
              WHERE id = ?`,
            [entry.status, entry.outputsSubmitted, entry.outputsTotal, residentId, actor, existing[0].id],
          );
        } else {
          const [ids] = await connection.query('SELECT id FROM education_subject_results');
          const id = generateId(RESOURCES.education_subject_results.prefix, ids);
          await connection.query(
            `INSERT INTO education_subject_results
               (id, educationRecordId, residentId, subjectId, progressStatus, outputsSubmitted, outputsTotal, createdBy, modifiedBy)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, record.id, residentId, entry.subjectId, entry.status, entry.outputsSubmitted, entry.outputsTotal, actor, actor],
          );
        }
      }

      if (monitoring) {
        const [existing] = await connection.query(
          'SELECT id FROM education_progress_monitoring WHERE educationRecordId = ? FOR UPDATE',
          [record.id],
        );
        const values = MONITORING_FIELDS.map((field) => monitoring[field]);
        if (existing.length) {
          await connection.query(
            `UPDATE education_progress_monitoring
                SET ${MONITORING_FIELDS.map((field) => `${field} = ?`).join(', ')},
                    residentId = ?, admissionId = ?, modifiedBy = ?
              WHERE id = ?`,
            [...values, residentId, admissionId, actor, existing[0].id],
          );
        } else {
          const [ids] = await connection.query('SELECT id FROM education_progress_monitoring');
          const id = generateId(RESOURCES.education_progress_monitoring.prefix, ids);
          await connection.query(
            `INSERT INTO education_progress_monitoring
               (id, educationRecordId, residentId, admissionId, monitoringDate, modulesCompleted, modulesPending,
                outputsSubmitted, outputsNotSubmitted, participationNotes, concerns, createdBy, modifiedBy)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id, record.id, residentId, admissionId,
              monitoring.monitoringDate, monitoring.modulesCompleted, monitoring.modulesPending,
              monitoring.outputsSubmitted, monitoring.outputsNotSubmitted, monitoring.participationNotes, monitoring.concerns,
              actor, actor,
            ],
          );
        }
      }
    });

    const [progress] = await progressSummaries(pool, { recordIds: [record.id] });
    res.json({ success: true, data: progress, canEdit: true, message: 'Education progress saved.' });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      return next(new ApiError(409, 'This progress was just saved by someone else. Reload it and try again.'));
    }
    return next(error);
  }
}

/**
 * POST /education-progress/:educationRecordId/complete
 *
 * Moves a learner from the active Student Master List to the Archive. Allowed
 * only when every subject is Completed with all of its outputs submitted —
 * checked here, on the stored rows, whatever the screen showed. Nothing is
 * deleted: the learner record, its progress, monitoring record and files stay;
 * the record is stamped `archivedAt` / `archivedBy` and its status becomes
 * Completed.
 */
async function complete(req, res, next) {
  try {
    if (!mayEditProgress(req)) {
      throw new ApiError(403, 'Only the Educator can complete a student.');
    }
    const record = await loadRecord(req.params.educationRecordId);
    if (record.archivedAt) throw new ApiError(409, 'This student is already in the Archive.');

    const [progress] = await progressSummaries(pool, { recordIds: [record.id] });
    const { complete: done, incomplete } = completionOf(progress?.subjects || []);
    if (!done) {
      throw new ApiError(409, (progress?.subjects || []).length === 0
        ? 'This student has no subjects/modules yet, so their education progress cannot be complete.'
        : `Education progress is not complete yet: ${incomplete.join(', ')} still ${incomplete.length === 1 ? 'needs' : 'need'} to be Completed with all outputs submitted.`);
    }

    const [result] = await pool.query(
      `UPDATE education_records
          SET archivedAt = NOW(), archivedBy = ?, status = 'Completed', modifiedBy = ?
        WHERE id = ? AND archivedAt IS NULL`,
      [req.user?.username || null, req.user?.username || null, record.id],
    );
    if (!result.affectedRows) throw new ApiError(409, 'This student is already in the Archive.');

    const [rows] = await pool.query('SELECT * FROM education_records WHERE id = ?', [record.id]);
    res.json({
      success: true,
      data: mapRow('education_records', rows[0]),
      message: `${record.name} was completed and moved to the Archive.`,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { summary, getOne, save, complete, mayEditProgress };
