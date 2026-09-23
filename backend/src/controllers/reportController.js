/**
 * Report Controller
 * @module controllers/reportController
 * @description Report generation with DSWD-compliant quarterly reports
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { mapRow, insertWithGeneratedId } = require('../utils/helpers');
const { RESOURCES } = require('../utils/constants');
const { ApiError } = require('../middleware/errorHandler');
const notifications = require('../services/notificationService');

const baseController = createController('reports');

/**
 * Generate daily report
 * @async
 * @returns {Promise<Object>} Daily report data
 */
/**
 * Build the daily summary.
 *
 * @param {Object} [user] the caller. The alert figures are scoped to them —
 *   they previously counted and listed every alert in the database, so the
 *   dashboard showed one user a count that included other roles' and other
 *   children's notifications.
 */
async function generateDailyReport(user = null) {
  const today = new Date().toISOString().split('T')[0];
  
  // Get statistics
  const [[residentCount]] = await pool.query('SELECT COUNT(*) as count FROM children WHERE status = ?', ['Active']);
  const [[newAdmissions]] = await pool.query('SELECT COUNT(*) as count FROM children WHERE DATE(createdAt) = ?', [today]);
  const [[totalViolations]] = await pool.query('SELECT COUNT(*) as count FROM violations WHERE DATE(date) = ?', [today]);
  const [[pendingAssessments]] = await pool.query('SELECT COUNT(*) as count FROM assessments WHERE status = ?', ['Scheduled']);
  const [[upcomingHearings]] = await pool.query('SELECT COUNT(*) as count FROM courtRecords WHERE hearingDate >= ? AND status = ?', [today, 'Scheduled']);

  let unreadAlertCount = 0;
  let criticalAlerts = [];
  if (user) {
    const visible = await notifications.listFor(user, { unreadOnly: true });
    unreadAlertCount = visible.length;
    criticalAlerts = visible.filter((row) => row.priority === 'Urgent').slice(0, 5);
  }

  const reportData = {
    date: today,
    summary: {
      activeResidents: residentCount.count,
      newAdmissionsToday: newAdmissions.count,
      violationsToday: totalViolations.count,
      pendingAssessments: pendingAssessments.count,
      upcomingHearings: upcomingHearings.count,
      unreadAlerts: unreadAlertCount,
    },
    criticalAlerts: criticalAlerts.map(alert => mapRow('alerts', alert)),
  };

  return reportData;
}

/**
 * Generate quarterly DSWD report
 * @async
 * @param {number} year - Year
 * @param {number} quarter - Quarter (1-4)
 * @returns {Promise<Object>} DSWD report data
 */
async function generateQuarterlyReport(year, quarter) {
  // Calculate quarter date range
  const startMonth = (quarter - 1) * 3;
  const endMonth = startMonth + 2;
  const startDate = `${year}-${String(startMonth + 1).padStart(2, '0')}-01`;
  // Day 0 of the following month is the last day of the quarter's final month.
  // Hardcoding "-31" produced invalid dates such as 2025-06-31 / 2025-09-31,
  // which MySQL coerced to NULL and made Q2/Q3 counts return zero.
  const endDate = new Date(Date.UTC(year, endMonth + 1, 0)).toISOString().split('T')[0];

  // Admissions during quarter
  const [[admissions]] = await pool.query(
    'SELECT COUNT(*) as count FROM children WHERE admissionDate BETWEEN ? AND ?',
    [startDate, endDate]
  );

  // Discharges during quarter
  const [[discharges]] = await pool.query(
    'SELECT COUNT(*) as count FROM children WHERE status = ? AND updatedAt BETWEEN ? AND ?',
    ['Discharged', startDate, endDate]
  );

  // Current active residents
  const [[activeResidents]] = await pool.query(
    'SELECT COUNT(*) as count FROM children WHERE status = ?',
    ['Active']
  );

  // Interventions/activities conducted
  const [[activities]] = await pool.query(
    'SELECT COUNT(*) as count FROM activities WHERE date BETWEEN ? AND ? AND status = ?',
    [startDate, endDate, 'Completed']
  );

  // Assessments completed
  const [[assessments]] = await pool.query(
    'SELECT COUNT(*) as count FROM assessments WHERE status = ? AND date BETWEEN ? AND ?',
    ['Completed', startDate, endDate]
  );

  // Violations recorded
  const [[violations]] = await pool.query(
    'SELECT COUNT(*) as count FROM violations WHERE date BETWEEN ? AND ?',
    [startDate, endDate]
  );

  // Court hearings
  const [[hearings]] = await pool.query(
    'SELECT COUNT(*) as count FROM courtRecords WHERE hearingDate BETWEEN ? AND ?',
    [startDate, endDate]
  );

  const dswdReport = {
    year,
    quarter,
    period: `Q${quarter} ${year}`,
    generatedAt: new Date().toISOString(),
    statistics: {
      admissions: admissions.count,
      discharges: discharges.count,
      activeResidents: activeResidents.count,
      interventionsConducted: activities.count,
      assessmentsCompleted: assessments.count,
      violationsRecorded: violations.count,
      courtHearings: hearings.count,
    },
  };

  return dswdReport;
}

/**
 * Generate and save daily report
 * @async
 */
async function createDaily(req, res, next) {
  try {
    const reportData = await generateDailyReport(req.user);

    const title = `Daily Report - ${reportData.date}`;

    const summaryJson = JSON.stringify(reportData.summary || {});

    // Two concurrent generations can derive the same id; retry instead of 500.
    const newId = await insertWithGeneratedId(pool, {
      table: 'reports',
      prefix: 'REP',
      insert: (generatedId) => pool.query(
        `INSERT INTO reports (id, title, type, date, generatedBy, status, summary, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [generatedId, title, 'daily', reportData.date, req.user?.username || 'System', 'Completed', summaryJson, req.user?.username || 'System']
      ),
    });

    const report = {
      id: newId,
      title,
      type: 'daily',
      date: reportData.date,
      generatedBy: req.user?.username || 'System',
      status: 'Completed',
      summary: reportData.summary,
    };

    res.status(201).json({
      success: true,
      report,
      message: 'Daily report generated successfully',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Generate and save quarterly DSWD report
 * @async
 */
async function createQuarterly(req, res, next) {
  try {
    let { year, quarter } = req.body || {};
    
    // Auto-detect current quarter if not provided
    if (!year || !quarter) {
      const now = new Date();
      year = now.getFullYear();
      quarter = Math.ceil((now.getMonth() + 1) / 3);
    }
    
    if (quarter < 1 || quarter > 4) {
      throw new ApiError(400, 'Quarter must be between 1 and 4');
    }

    const dswdReport = await generateQuarterlyReport(year, quarter);

    const title = `DSWD Quarterly Report - Q${quarter} ${year}`;

    const summaryJson = JSON.stringify(dswdReport.statistics || {});
    const reportDate = new Date().toISOString().split('T')[0];

    // Two concurrent generations can derive the same id; retry instead of 500.
    const newId = await insertWithGeneratedId(pool, {
      table: 'reports',
      prefix: 'REP',
      insert: (generatedId) => pool.query(
        `INSERT INTO reports (id, title, type, date, generatedBy, status, summary, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [generatedId, title, 'quarterly', reportDate, req.user?.username || 'System', 'Completed', summaryJson, req.user?.username || 'System']
      ),
    });

    const report = {
      id: newId,
      title,
      type: 'quarterly',
      date: reportDate,
      generatedBy: req.user?.username || 'System',
      status: 'Completed',
      summary: dswdReport.statistics,
    };

    res.status(201).json({
      success: true,
      report,
      message: 'Quarterly DSWD report generated successfully',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get daily report (manual trigger)
 * @async
 */
async function getDaily(req, res, next) {
  try {
    const reportData = await generateDailyReport(req.user);
    
    res.json({
      success: true,
      data: reportData,
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
  createDaily,
  createQuarterly,
  getDaily,
};
