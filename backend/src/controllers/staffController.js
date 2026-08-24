/**
 * Staff Controller
 * @module controllers/staffController
 * @description Staff/personnel management
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { ApiError } = require('../middleware/errorHandler');

const baseController = createController('staff');

/**
 * Get active staff
 * @async
 */
async function getActive(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM staff 
       WHERE status = ? 
       ORDER BY name ASC`,
      ['Active']
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
 * Get staff by department
 * @async
 */
async function getByDepartment(req, res, next) {
  try {
    const { department } = req.params;
    
    const [rows] = await pool.query(
      'SELECT * FROM staff WHERE department = ? ORDER BY name ASC',
      [department]
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
 * Get staff by position
 * @async
 */
async function getByPosition(req, res, next) {
  try {
    const { position } = req.params;
    
    const [rows] = await pool.query(
      'SELECT * FROM staff WHERE position = ? ORDER BY name ASC',
      [position]
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
  getActive,
  getByDepartment,
  getByPosition,
};
