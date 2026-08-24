/**
 * Alert Controller
 * @module controllers/alertController
 * @description Alert management and notifications
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { ApiError } = require('../middleware/errorHandler');

const baseController = createController('alerts');

/**
 * Mark alert as read
 * @async
 */
async function markAsRead(req, res, next) {
  try {
    const { id } = req.params;
    const { readBy } = req.body || {};
    const reader = readBy || req.user?.username || 'System';

    const [existing] = await pool.query('SELECT * FROM alerts WHERE id = ?', [id]);
    if (existing.length === 0) {
      throw new ApiError(404, 'Alert not found');
    }

    await pool.query(
      'UPDATE alerts SET isRead = ?, readBy = ?, readAt = NOW(), modifiedBy = ? WHERE id = ?',
      [true, reader, reader, id]
    );

    const [rows] = await pool.query('SELECT * FROM alerts WHERE id = ?', [id]);
    res.json({
      success: true,
      message: 'Alert marked as read',
      data: rows[0],
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get unread alerts count
 * @async
 */
async function getUnreadCount(req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT COUNT(*) as count FROM alerts WHERE isRead = ?',
      [false]
    );

    res.json({
      success: true,
      count: rows[0].count,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get alerts by resident
 * @async
 */
async function getByResident(req, res, next) {
  try {
    const { residentId } = req.params;
    
    const [rows] = await pool.query(
      'SELECT * FROM alerts WHERE residentId = ? ORDER BY createdAt DESC',
      [residentId]
    );

    res.json({
      success: true,
      data: rows,
      count: rows.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get urgent alerts
 * @async
 */
async function getUrgent(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM alerts 
       WHERE priority IN (?, ?) AND isRead = ? 
       ORDER BY createdAt DESC 
       LIMIT 10`,
      ['Urgent', 'High', false]
    );

    res.json({
      success: true,
      data: rows,
      count: rows.length,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAll: baseController.getAll,
  getById: baseController.getById,
  create: baseController.create,
  update: baseController.update,
  delete: baseController.delete,
  markAsRead,
  getUnreadCount,
  getByResident,
  getUrgent,
};
