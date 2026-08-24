/**
 * Health Record Controller
 * @module controllers/healthController
 * @description Health record management with vital signs and medications
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { ApiError } = require('../middleware/errorHandler');

const baseController = createController('healthRecords');

/**
 * Get health records by resident
 * @async
 */
async function getByResident(req, res, next) {
  try {
    const { residentId } = req.params;
    
    const [rows] = await pool.query(
      'SELECT * FROM healthRecords WHERE residentId = ? ORDER BY date DESC, createdAt DESC',
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
 * Get latest health record for resident
 * @async
 */
async function getLatest(req, res, next) {
  try {
    const { residentId } = req.params;
    
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
      data: rows[0],
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get health statistics for resident
 * @async
 */
async function getStats(req, res, next) {
  try {
    const { residentId } = req.params;
    
    const [rows] = await pool.query(
      `SELECT 
        COUNT(*) as totalRecords,
        AVG(temperature) as avgTemperature,
        AVG(weight) as avgWeight,
        AVG(height) as avgHeight,
        AVG(pulse) as avgPulse,
        MAX(date) as lastCheckup
      FROM healthRecords 
      WHERE residentId = ?`,
      [residentId]
    );

    res.json({
      success: true,
      data: rows[0],
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
  getLatest,
  getStats,
};
