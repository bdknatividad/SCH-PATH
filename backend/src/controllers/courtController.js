/**
 * Court Record Controller
 * @module controllers/courtController
 * @description Court hearing and legal case management
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { ApiError } = require('../middleware/errorHandler');
const { canAccessResident } = require('./assignmentController');
// The one Manila-date helper. Every "today" in a query has to be the facility's
// today; `toISOString()` gives UTC's, which is a different day for eight hours
// of every day here.
const { manilaToday } = require('../utils/triPeriod');

const baseController = createController('courtRecords');

/**
 * Get court records by resident
 * @async
 */
async function getByResident(req, res, next) {
  try {
    const { residentId } = req.params;
    if (!await canAccessResident(req.user, residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }
    
    const [rows] = await pool.query(
      'SELECT * FROM courtRecords WHERE residentId = ? ORDER BY hearingDate ASC',
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
 * Get upcoming hearings
 * @async
 */
async function getUpcoming(req, res, next) {
  try {
    // The facility's today, not UTC's — `toISOString()` is still yesterday in
    // GMT+8 until 08:00, so "upcoming" used to include the previous day's
    // hearings for the first eight hours of every day.
    const today = manilaToday();
    
    const [rows] = await pool.query(
      `SELECT c.*, ch.name as residentName 
       FROM courtRecords c 
       LEFT JOIN children ch ON c.residentId = ch.id 
       WHERE c.hearingDate >= ? AND c.status = ? 
       ORDER BY c.hearingDate ASC 
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
 * Get hearings by date range
 * @async
 */
async function getByDateRange(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    
    const [rows] = await pool.query(
      `SELECT * FROM courtRecords 
       WHERE hearingDate BETWEEN ? AND ? 
       ORDER BY hearingDate ASC`,
      [startDate, endDate]
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
  getByResident,
  getUpcoming,
  getByDateRange,
};
