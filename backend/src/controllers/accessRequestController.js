const { pool } = require('../config/database');
const { generateId, mapRow } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');

const REQUEST_COLUMNS = [
  'id', 'requesterId', 'requesterUsername', 'targetUserId', 'targetRole',
  'residentId', 'moduleName', 'recordTab', 'reason', 'status', 'reviewedBy',
  'reviewedAt', 'reviewerNote', 'createdAt', 'updatedAt',
];

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accessRequests (
      id VARCHAR(40) PRIMARY KEY,
      requesterId VARCHAR(40) NOT NULL,
      requesterUsername VARCHAR(100) NOT NULL,
      targetUserId VARCHAR(40) NULL,
      targetRole VARCHAR(50) NULL,
      residentId VARCHAR(40) NULL,
      moduleName VARCHAR(100) NULL,
      recordTab VARCHAR(100) NULL,
      reason TEXT NOT NULL,
      status ENUM('Pending', 'Approved', 'Rejected') NOT NULL DEFAULT 'Pending',
      reviewedBy VARCHAR(100) NULL,
      reviewedAt TIMESTAMP NULL,
      reviewerNote TEXT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_access_requesterId (requesterId),
      INDEX idx_access_status (status),
      INDEX idx_access_targetRole (targetRole)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function getAll(req, res, next) {
  try {
    await ensureTable();
    const isAdmin = ['centerhead', 'admin'].includes(String(req.user.role).toLowerCase());
    const isPsychologist = String(req.user.role).toLowerCase() === 'psychologist';
    const [rows] = await pool.query(
      `SELECT ${REQUEST_COLUMNS.join(', ')} FROM accessRequests
       WHERE requesterId = ? OR (? = 1 AND status = 'Pending') OR (? = 1 AND targetRole = 'psychologist' AND status = 'Pending')
       ORDER BY createdAt DESC`,
      [req.user.id, isAdmin ? 1 : 0, isPsychologist ? 1 : 0]
    );
    res.json({ success: true, data: rows.map(row => mapRow('accessRequests', row)), count: rows.length });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    await ensureTable();
    const { targetUserId, targetRole, residentId, moduleName, recordTab, reason } = req.body || {};
    if (!targetUserId && !targetRole) throw new ApiError(400, 'A target user or role is required');
    if (!moduleName && !recordTab) throw new ApiError(400, 'A module or record tab is required');
    if (!reason || !String(reason).trim()) throw new ApiError(400, 'A reason is required');

    const [existing] = await pool.query(
      `SELECT id FROM accessRequests WHERE requesterId = ? AND targetUserId <=> ? AND targetRole <=> ?
       AND residentId <=> ? AND moduleName <=> ? AND recordTab <=> ? AND status = 'Pending'`,
      [req.user.id, targetUserId || null, targetRole || null, residentId || null, moduleName || null, recordTab || null]
    );
    if (existing.length > 0) throw new ApiError(409, 'A matching access request is already pending');

    const [all] = await pool.query('SELECT id FROM accessRequests');
    const id = generateId('ACC', all.map(row => ({ id: row.id })));
    await pool.query(
      `INSERT INTO accessRequests
       (id, requesterId, requesterUsername, targetUserId, targetRole, residentId, moduleName, recordTab, reason, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`,
      [id, req.user.id, req.user.username, targetUserId || null, targetRole || null, residentId || null, moduleName || null, recordTab || null, String(reason).trim()]
    );

    const [alerts] = await pool.query('SELECT id FROM alerts');
    const alertId = generateId('ALR', alerts.map(row => ({ id: row.id })));
    await pool.query(
      `INSERT INTO alerts (id, type, title, message, priority, targetRole, relatedRecordType, relatedRecordId)
       VALUES (?, 'Access Request', ?, ?, 'Medium', ?, 'accessRequests', ?)`,
      [alertId, `Access request from ${req.user.username}`, `${req.user.username} requested access to ${moduleName || recordTab}.`, targetRole || 'centerhead', id]
    );

    const [rows] = await pool.query(`SELECT ${REQUEST_COLUMNS.join(', ')} FROM accessRequests WHERE id = ?`, [id]);
    res.status(201).json({ success: true, data: mapRow('accessRequests', rows[0]) });
  } catch (error) { next(error); }
}

async function review(req, res, next) {
  try {
    await ensureTable();
    const { id } = req.params;
    const { decision, reviewerNote } = req.body || {};
    if (!['Approved', 'Rejected'].includes(decision)) throw new ApiError(400, 'Decision must be Approved or Rejected');

    const [requests] = await pool.query('SELECT * FROM accessRequests WHERE id = ?', [id]);
    if (requests.length === 0) throw new ApiError(404, 'Access request not found');
    const request = requests[0];
    const role = String(req.user.role).toLowerCase();
    const authorized = role === 'centerhead' || role === 'admin' || (role === 'psychologist' && request.targetRole === 'psychologist');
    if (!authorized) throw new ApiError(403, 'You are not authorized to review this access request');
    if (request.status !== 'Pending') throw new ApiError(409, 'Access request has already been reviewed');

    await pool.query(
      `UPDATE accessRequests SET status = ?, reviewedBy = ?, reviewedAt = NOW(), reviewerNote = ? WHERE id = ?`,
      [decision, req.user.username, reviewerNote || null, id]
    );

    if (decision === 'Approved') {
      if (request.moduleName) {
        await pool.query(
          `UPDATE users SET accessibleModules = JSON_ARRAY_APPEND(COALESCE(accessibleModules, JSON_ARRAY()), '$', ?), modifiedBy = ?
           WHERE id = ? AND JSON_CONTAINS(COALESCE(accessibleModules, JSON_ARRAY()), JSON_QUOTE(?)) = 0`,
          [request.moduleName, req.user.username, request.requesterId, request.moduleName]
        );
      }
      if (request.recordTab) {
        await pool.query(
          `UPDATE users SET childRecordTabs = JSON_ARRAY_APPEND(COALESCE(childRecordTabs, JSON_ARRAY()), '$', ?), modifiedBy = ?
           WHERE id = ? AND JSON_CONTAINS(COALESCE(childRecordTabs, JSON_ARRAY()), JSON_QUOTE(?)) = 0`,
          [request.recordTab, req.user.username, request.requesterId, request.recordTab]
        );
      }
    }

    const [alerts] = await pool.query('SELECT id FROM alerts');
    const alertId = generateId('ALR', alerts.map(row => ({ id: row.id })));
    await pool.query(
      `INSERT INTO alerts (id, type, title, message, priority, relatedRecordType, relatedRecordId, targetRole)
       VALUES (?, 'Access Request Decision', ?, ?, 'Medium', 'accessRequests', ?, ?)`,
      [alertId, `Access request ${decision.toLowerCase()}`, `Your access request was ${decision.toLowerCase()}.`, id, request.requesterId ? null : request.targetRole]
    );

    res.json({ success: true, message: `Access request ${decision.toLowerCase()}` });
  } catch (error) { next(error); }
}

module.exports = { getAll, create, review };
