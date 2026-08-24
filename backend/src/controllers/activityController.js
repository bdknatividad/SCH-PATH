/**
 * Activity Controller
 * @module controllers/activityController
 * @description Activity and event management
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { ApiError } = require('../middleware/errorHandler');

const baseController = createController('activities');

/**
 * Get activities by date range
 * @async
 */
async function getByDateRange(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    
    let query = 'SELECT * FROM activities WHERE 1=1';
    const params = [];

    if (startDate) {
      query += ' AND date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND date <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY date ASC, time ASC';

    const [rows] = await pool.query(query, params);

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
 * Get upcoming activities
 * @async
 */
async function getUpcoming(req, res, next) {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const [rows] = await pool.query(
      `SELECT * FROM activities 
       WHERE date >= ? AND status = ? 
       ORDER BY date ASC, time ASC 
       LIMIT 20`,
      [today, 'Active']
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
 * Get activities by type
 * @async
 */
async function getByType(req, res, next) {
  try {
    const { type } = req.params;
    
    const [rows] = await pool.query(
      'SELECT * FROM activities WHERE type = ? ORDER BY date DESC',
      [type]
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
 * Mark activity as completed
 * @async
 */
async function complete(req, res, next) {
  try {
    const { id } = req.params;

    await pool.query(
      `UPDATE activities 
       SET status = ?, modifiedBy = ? 
       WHERE id = ?`,
      ['Completed', req.user?.username || 'System', id]
    );

    res.json({
      success: true,
      message: 'Activity marked as completed',
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
  getByDateRange,
  getUpcoming,
  getByType,
  complete,
};
