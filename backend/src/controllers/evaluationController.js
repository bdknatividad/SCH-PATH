/**
 * Activity Evaluation Controller
 * @module controllers/evaluationController
 * @description Activity/resident evaluation management
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { ApiError } = require('../middleware/errorHandler');

const baseController = createController('activityEvaluations');

/**
 * Get evaluations by activity
 * @async
 */
async function getByActivity(req, res, next) {
  try {
    const { activityId } = req.params;
    
    const [rows] = await pool.query(
      'SELECT * FROM activityEvaluations WHERE activityId = ? ORDER BY dateEvaluated DESC',
      [activityId]
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
 * Get evaluations by resident
 * @async
 */
async function getByResident(req, res, next) {
  try {
    const { residentId } = req.params;
    
    const [rows] = await pool.query(
      'SELECT * FROM activityEvaluations WHERE residentId = ? ORDER BY dateEvaluated DESC',
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
 * Get average rating by activity
 * @async
 */
async function getAverageByActivity(req, res, next) {
  try {
    const { activityId } = req.params;
    
    const [rows] = await pool.query(
      `SELECT 
        AVG(rating) as averageRating,
        COUNT(*) as totalEvaluations,
        MIN(rating) as minRating,
        MAX(rating) as maxRating
      FROM activityEvaluations 
      WHERE activityId = ?`,
      [activityId]
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
  getByActivity,
  getByResident,
  getAverageByActivity,
};
