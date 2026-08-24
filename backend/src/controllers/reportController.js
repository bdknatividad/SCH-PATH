/**
 * Report Controller
 * @module controllers/reportController
 * @description Report generation with DSWD-compliant quarterly reports
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { generateId, mapRow } = require('../utils/helpers');
const { RESOURCES } = require('../utils/constants');
const { ApiError } = require('../middleware/errorHandler');

const baseController = createController('reports');

/**
 * Generate daily report
 * @async
 * @returns {Promise<Object>} Daily report data
 */
async function generateDailyReport() {
  const today = new Date().toISOString().split('T')[0];
  
  // Get statistics
  const [[residentCount]] = await pool.query('SELECT COUNT(*) as count FROM children WHERE status = ?', ['Active']);
  const [[newAdmissions]] = await pool.query('SELECT COUNT(*) as count FROM children WHERE DATE(createdAt) = ?', [today]);
  const [[totalViolations]] = await pool.query('SELECT COUNT(*) as count FROM violations WHERE DATE(date) = ?', [today]);
  const [[pendingAssessments]] = await pool.query('SELECT COUNT(*) as count FROM assessments WHERE status = ?', ['Scheduled']);
  const [[upcomingHearings]] = await pool.query('SELECT COUNT(*) as count FROM courtRecords WHERE hearingDate >= ? AND status = ?', [today, 'Scheduled']);
  const [[unreadAlerts]] = await pool.query('SELECT COUNT(*) as count FROM alerts WHERE isRead = ?', [false]);

  // Get critical alerts
  const [criticalAlerts] = await pool.query(
    'SELECT * FROM alerts WHERE priority = ? AND isRead = ? ORDER BY createdAt DESC LIMIT 5',
    ['Urgent', false]
  );

  const reportData = {
    date: today,
    summary: {
      activeResidents: residentCount.count,
      newAdmissionsToday: newAdmissions.count,
      violationsToday: totalViolations.count,
      pendingAssessments: pendingAssessments.count,
      upcomingHearings: upcomingHearings.count,
      unreadAlerts: unreadAlerts.count,
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
  const endDate = `${year}-${String(endMonth + 1).padStart(2, '0')}-31`;

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
    const reportData = await generateDailyReport();
    
    const [existing] = await pool.query('SELECT id FROM reports');
    const newId = generateId('REP', existing.map(r => ({ id: r.id })));

    const title = `Daily Report - ${reportData.date}`;
    
    const summaryJson = JSON.stringify(reportData.summary || {});

    await pool.query(
      `INSERT INTO reports (id, title, type, date, generatedBy, status, summary, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId, title, 'daily', reportData.date, req.user?.username || 'System', 'Completed', summaryJson, req.user?.username || 'System']
    );

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
    
    const [existing] = await pool.query('SELECT id FROM reports');
    const newId = generateId('REP', existing.map(r => ({ id: r.id })));

    const title = `DSWD Quarterly Report - Q${quarter} ${year}`;
    
    const summaryJson = JSON.stringify(dswdReport.statistics || {});

    await pool.query(
      `INSERT INTO reports (id, title, type, date, generatedBy, status, summary, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId, title, 'quarterly', new Date().toISOString().split('T')[0], req.user?.username || 'System', 'Completed', summaryJson, req.user?.username || 'System']
    );

    const report = {
      id: newId,
      title,
      type: 'quarterly',
      date: new Date().toISOString().split('T')[0],
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
    const reportData = await generateDailyReport();
    
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
