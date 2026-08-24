/**
 * Assessment Controller
 * @module controllers/assessmentController
 * @description Assessment scheduling and management
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { ApiError } = require('../middleware/errorHandler');

const baseController = createController('assessments');

/**
 * Get assessments by resident
 * @async
 */
async function getByResident(req, res, next) {
  try {
    const { residentId } = req.params;
    
    const [rows] = await pool.query(
      `SELECT * FROM assessments 
       WHERE forResidents LIKE ? 
       ORDER BY date DESC, time DESC`,
      [`%${residentId}%`]
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
 * Get upcoming assessments
 * @async
 */
async function getUpcoming(req, res, next) {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const [rows] = await pool.query(
      `SELECT * FROM assessments 
       WHERE date >= ? AND status = ? 
       ORDER BY date ASC, time ASC 
       LIMIT 20`,
      [today, 'Scheduled']
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
 * Get pending assessments count
 * @async
 */
async function getPendingCount(req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT COUNT(*) as count FROM assessments WHERE status = ?',
      ['Scheduled']
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
 * Complete assessment
 * @async
 */
async function complete(req, res, next) {
  try {
    const { id } = req.params;
    const { results, findings } = req.body || {};

    await pool.query(
      `UPDATE assessments 
       SET status = ?, results = ?, description = COALESCE(?, description), modifiedBy = ? 
       WHERE id = ?`,
      ['Completed', JSON.stringify(results || {}), findings, req.user?.username || 'System', id]
    );

    res.json({
      success: true,
      message: 'Assessment marked as completed',
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
  getByResident,
  getUpcoming,
  getPendingCount,
  complete,
};
