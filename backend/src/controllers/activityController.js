/**
 * Activity Controller
 * @module controllers/activityController
 * @description Activity and event management
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { ApiError } = require('../middleware/errorHandler');
const { assignedResidentIds } = require('../utils/residentScope');

const baseController = createController('activities');


function isHouseparent(user) {
  return String(user?.role || '').toLowerCase() === 'houseparent';
}

function parseResidentValues(row) {
  const values = [];
  for (const field of ['selectedResidentIds', 'recommendedResidentIds', 'notRecommendedResidentIds', 'participants']) {
    let value = row?.[field];
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { value = []; }
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === 'string') values.push(String(item));
      else if (item && typeof item === 'object' && item.id) values.push(String(item.id));
    }
  }
  return values;
}

async function scopeForHouseparent(req, rows) {
  if (!isHouseparent(req.user)) return rows;
  const assigned = new Set((await assignedResidentIds(req.user)).map(String));
  return rows.filter(row => parseResidentValues(row).some(id => assigned.has(id)));
}

async function getAll(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT * FROM activities ORDER BY createdAt ASC');
    const scoped = await scopeForHouseparent(req, rows);
    res.json({ success: true, data: scoped, count: scoped.length });
  } catch (error) { next(error); }
}

async function getById(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT * FROM activities WHERE id = ?', [req.params.id]);
    if (!rows.length) throw new ApiError(404, 'Activity not found');
    const scoped = await scopeForHouseparent(req, rows);
    if (!scoped.length) throw new ApiError(403, 'You are not assigned to any resident on this activity');
    res.json({ success: true, data: scoped[0] });
  } catch (error) { next(error); }
}

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
    const scoped = await scopeForHouseparent(req, rows);

    res.json({
      success: true,
      data: scoped,
      count: scoped.length,
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
      [today, 'Upcoming']
    );
    const scoped = await scopeForHouseparent(req, rows);

    res.json({
      success: true,
      data: scoped,
      count: scoped.length,
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
    const scoped = await scopeForHouseparent(req, rows);

    res.json({
      success: true,
      data: scoped,
      count: scoped.length,
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
  getAll,
  getById,
  create: baseController.create,
  update: baseController.update,
  delete: baseController.delete,
  getByDateRange,
  getUpcoming,
  getByType,
  complete,
};
