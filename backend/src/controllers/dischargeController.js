const { pool } = require('../config/database');
const { ApiError } = require('../middleware/errorHandler');
const { canAccessResident } = require('./assignmentController');
const { generateId, mapRow } = require('../utils/helpers');

const EXTENSION_ROLES = new Set(['centerhead', 'admin', 'socialworker']);
const MAJOR_THRESHOLD = 3;
const MINOR_THRESHOLD = 5;

function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

function requireExtensionRole(req) {
  if (!EXTENSION_ROLES.has(normalizeRole(req.user?.role))) {
    throw new ApiError(403, 'Only authorized case-management staff can decide discharge extensions.');
  }
}

function toDateOnly(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : s;
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T00:00:00`);
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

async function getActiveAdmission(residentId) {
  const [rows] = await pool.query(
    `SELECT * FROM admissions
     WHERE residentId = ?
     ORDER BY (status = 'Active') DESC, admissionNumber DESC
     LIMIT 1`,
    [residentId]
  );
  return rows[0] || null;
}

async function getMonthlyCounts(residentId, year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(Date.UTC(Number(year), Number(month), 0));
  const end = endDate.toISOString().slice(0, 10);
  const [rows] = await pool.query(
    `SELECT
       SUM(CASE WHEN severity = 'Major' THEN 1 ELSE 0 END) AS majorCount,
       SUM(CASE WHEN severity = 'Minor' THEN 1 ELSE 0 END) AS minorCount
     FROM violations
     WHERE residentId = ?
       AND date >= ?
       AND date <= ?
       AND COALESCE(status, '') <> 'Rejected'`,
    [residentId, start, end]
  );
  return {
    majorCount: Number(rows[0]?.majorCount || 0),
    minorCount: Number(rows[0]?.minorCount || 0),
  };
}

function buildRecommendation({ majorCount, minorCount, year, month, residentName }) {
  const majorHit = majorCount >= MAJOR_THRESHOLD;
  const minorHit = minorCount >= MINOR_THRESHOLD;
  const thresholdType = majorHit && minorHit
    ? '3+ Major and 5+ Minor'
    : majorHit
      ? '3+ Major'
      : '5+ Minor';

  const parts = [];
  if (majorHit) parts.push(`${majorCount} major violation${majorCount === 1 ? '' : 's'}`);
  if (minorHit) parts.push(`${minorCount} minor violation${minorCount === 1 ? '' : 's'}`);

  const note = [
    `Behavioral review recommended for ${residentName || 'this resident'} for ${String(month).padStart(2, '0')}/${year}.`,
    `The resident reached the monthly review threshold with ${parts.join(' and ')}.`,
    'Review the recorded incidents, current case progress, and existing discharge plan before deciding whether an extension of stay is appropriate.',
    'This recommendation does not automatically add days to the resident\'s stay; an authorized staff member must make and record the final decision.'
  ].join(' ');

  return { thresholdType, note };
}

async function buildRecommendationForTri(triRecord) {
  const year = Number(triRecord.reportingYear);
  const month = Number(triRecord.reportingMonth);
  const counts = await getMonthlyCounts(triRecord.residentId, year, month);
  const thresholdReached = counts.majorCount >= MAJOR_THRESHOLD || counts.minorCount >= MINOR_THRESHOLD;
  if (!thresholdReached) return { thresholdReached: false, ...counts, recommendation: null };

  const [[resident]] = await pool.query('SELECT name FROM children WHERE id = ?', [triRecord.residentId]);
  const admission = await getActiveAdmission(triRecord.residentId);
  const recommendation = buildRecommendation({ ...counts, year, month, residentName: resident?.name });
  const existing = await pool.query('SELECT id FROM dischargeRecommendations WHERE triRecordId = ? LIMIT 1', [triRecord.id]);
  let recommendationId = existing[0][0]?.id || null;
  if (!recommendationId) {
    const [rows] = await pool.query('SELECT id FROM dischargeRecommendations');
    recommendationId = generateId('DR', rows);
    await pool.query(
      `INSERT INTO dischargeRecommendations
       (id, residentId, admissionId, triRecordId, reportingYear, reportingMonth, majorCount, minorCount, thresholdType, recommendationNote)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [recommendationId, triRecord.residentId, admission?.id || null, triRecord.id, year, month, counts.majorCount, counts.minorCount, recommendation.thresholdType, recommendation.note]
    );
  } else {
    await pool.query(
      `UPDATE dischargeRecommendations
       SET admissionId = ?, majorCount = ?, minorCount = ?, thresholdType = ?, recommendationNote = ?
       WHERE id = ?`,
      [admission?.id || null, counts.majorCount, counts.minorCount, recommendation.thresholdType, recommendation.note, recommendationId]
    );
  }

  const [recRows] = await pool.query('SELECT * FROM dischargeRecommendations WHERE id = ?', [recommendationId]);
  return {
    thresholdReached: true,
    ...counts,
    recommendation: mapRow('dischargeRecommendations', recRows[0]),
  };
}

async function recommendationForTri(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT * FROM triRecords WHERE id = ?', [req.params.triId]);
    if (!rows.length) throw new ApiError(404, 'TRI record not found.');
    const record = rows[0];
    if (!await canAccessResident(req.user, record.residentId)) throw new ApiError(403, 'You are not assigned to this resident.');
    res.json({ success: true, data: await buildRecommendationForTri(record) });
  } catch (error) { next(error); }
}

async function getResidentPlan(req, res, next) {
  try {
    const residentId = req.params.residentId;
    if (!await canAccessResident(req.user, residentId)) throw new ApiError(403, 'You are not assigned to this resident.');
    const admission = await getActiveAdmission(residentId);
    const [history] = await pool.query(
      `SELECT de.*, dr.recommendationNote, dr.majorCount, dr.minorCount, dr.thresholdType
       FROM dischargeExtensions de
       LEFT JOIN dischargeRecommendations dr ON dr.id = de.recommendationId
       WHERE de.residentId = ?
       ORDER BY de.decidedAt DESC, de.createdAt DESC`,
      [residentId]
    );
    const [recommendations] = await pool.query(
      `SELECT * FROM dischargeRecommendations WHERE residentId = ? ORDER BY createdAt DESC`,
      [residentId]
    );
    res.json({
      success: true,
      data: {
        admission: admission ? mapRow('admissions', admission) : null,
        history: history.map(row => mapRow('dischargeExtensions', row)),
        recommendations: recommendations.map(row => mapRow('dischargeRecommendations', row)),
      },
    });
  } catch (error) { next(error); }
}

async function setExpectedDate(req, res, next) {
  try {
    requireExtensionRole(req);
    const residentId = req.params.residentId;
    if (!await canAccessResident(req.user, residentId) && normalizeRole(req.user.role) !== 'centerhead' && normalizeRole(req.user.role) !== 'admin') {
      throw new ApiError(403, 'You are not assigned to this resident.');
    }
    const expectedDischargeDate = toDateOnly(req.body?.expectedDischargeDate);
    if (!expectedDischargeDate) throw new ApiError(400, 'A valid expected discharge date is required.');
    const admission = await getActiveAdmission(residentId);
    if (!admission) throw new ApiError(404, 'No admission found for this resident.');
    await pool.query('UPDATE admissions SET expectedDischargeDate = ?, modifiedBy = ? WHERE id = ?', [expectedDischargeDate, req.user.username, admission.id]);
    const [rows] = await pool.query('SELECT * FROM admissions WHERE id = ?', [admission.id]);
    res.json({ success: true, data: mapRow('admissions', rows[0]) });
  } catch (error) { next(error); }
}

async function addExtension(req, res, next) {
  let connection;
  try {
    requireExtensionRole(req);
    const residentId = req.params.residentId;
    if (!await canAccessResident(req.user, residentId) && !['centerhead', 'admin'].includes(normalizeRole(req.user.role))) {
      throw new ApiError(403, 'You are not assigned to this resident.');
    }
    const days = Number(req.body?.extensionDays);
    const reason = String(req.body?.reason || '').trim();
    if (!Number.isInteger(days) || days <= 0 || days > 3650) throw new ApiError(400, 'Extension days must be a whole number greater than 0.');
    if (!reason) throw new ApiError(400, 'A reason for the extension is required.');
    const admission = await getActiveAdmission(residentId);
    if (!admission) throw new ApiError(404, 'No active admission found for this resident.');
    const previousDate = toDateOnly(admission.expectedDischargeDate);
    if (!previousDate) throw new ApiError(409, 'Set an expected discharge date before adding an extension.');
    const newDate = addDays(previousDate, days);
    const recommendationId = req.body?.recommendationId || null;
    const triRecordId = req.body?.triRecordId || null;
    const relatedViolationId = req.body?.relatedViolationId || null;

    if (relatedViolationId) {
      const [violationRows] = await pool.query('SELECT id FROM violations WHERE id = ? AND residentId = ?', [relatedViolationId, residentId]);
      if (!violationRows.length) throw new ApiError(400, 'The selected violation does not belong to this resident.');
    }
    if (triRecordId) {
      const [triRows] = await pool.query('SELECT id, residentId FROM triRecords WHERE id = ?', [triRecordId]);
      if (!triRows.length || String(triRows[0].residentId) !== String(residentId)) throw new ApiError(400, 'The selected TRI record does not belong to this resident.');
    }
    if (recommendationId) {
      const [recommendationRows] = await pool.query('SELECT id, residentId, status FROM dischargeRecommendations WHERE id = ?', [recommendationId]);
      if (!recommendationRows.length || String(recommendationRows[0].residentId) !== String(residentId)) throw new ApiError(400, 'The selected recommendation does not belong to this resident.');
      if (recommendationRows[0].status === 'Dismissed') throw new ApiError(409, 'The selected recommendation has already been dismissed.');
    }

    const [existingIds] = await pool.query('SELECT id FROM dischargeExtensions');
    const id = generateId('DEX', existingIds);

    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.query('UPDATE admissions SET expectedDischargeDate = ?, modifiedBy = ? WHERE id = ?', [newDate, req.user.username, admission.id]);
    await connection.query(
      `INSERT INTO dischargeExtensions
       (id, residentId, admissionId, triRecordId, recommendationId, previousDischargeDate, newDischargeDate, extensionDays, reason, relatedViolationId, decidedBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, residentId, admission.id, triRecordId, recommendationId, previousDate, newDate, days, reason, relatedViolationId, req.user.username]
    );
    if (recommendationId) {
      await connection.query(
        `UPDATE dischargeRecommendations SET status = 'Decision Made', reviewedBy = ?, reviewedAt = NOW() WHERE id = ?`,
        [req.user.username, recommendationId]
      );
    }
    await connection.commit();
    const [rows] = await pool.query('SELECT * FROM dischargeExtensions WHERE id = ?', [id]);
    const [admissionRows] = await pool.query('SELECT * FROM admissions WHERE id = ?', [admission.id]);
    res.status(201).json({ success: true, data: { extension: mapRow('dischargeExtensions', rows[0]), admission: mapRow('admissions', admissionRows[0]) } });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch {} }
    next(error);
  } finally {
    if (connection) connection.release();
  }
}

async function dismissRecommendation(req, res, next) {
  try {
    requireExtensionRole(req);
    const [rows] = await pool.query('SELECT * FROM dischargeRecommendations WHERE id = ?', [req.params.id]);
    if (!rows.length) throw new ApiError(404, 'Recommendation not found.');
    await pool.query(`UPDATE dischargeRecommendations SET status = 'Dismissed', reviewedBy = ?, reviewedAt = NOW() WHERE id = ?`, [req.user.username, req.params.id]);
    const [updated] = await pool.query('SELECT * FROM dischargeRecommendations WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: mapRow('dischargeRecommendations', updated[0]) });
  } catch (error) { next(error); }
}

module.exports = {
  buildRecommendationForTri,
  recommendationForTri,
  getResidentPlan,
  setExpectedDate,
  addExtension,
  dismissRecommendation,
};
