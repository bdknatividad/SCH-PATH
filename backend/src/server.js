/**
 * SCH-PATH Backend Server
 * @description Main entry point for the SCH-PATH API server
 * @author Your Name
 * @version 1.0.0
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
require('dotenv').config();

const { testConnection } = require('./config/database');
const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { seedDatabase } = require('./scripts/seedDatabase');

const app = express();
const PORT = Number(process.env.PORT || 5000);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API Routes
app.use('/api', routes);

// Serve the production frontend from the same service when it has been built.
const frontendDist = path.resolve(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }

  res.sendFile(path.join(frontendDist, 'index.html'), (error) => {
    if (error) next();
  });
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Scheduled tasks - these run internally, not through HTTP
cron.schedule('59 23 * * *', async () => {
  console.log('Running scheduled daily report generation...');
  try {
    const { pool } = require('./config/database');
    const today = new Date().toISOString().split('T')[0];
    const reportId = `REP-DAILY-${Date.now()}`;
    
    // Get daily statistics
    const [[residentCount]] = await pool.query('SELECT COUNT(*) as count FROM children WHERE status = ?', ['Active']);
    const [[newAdmissions]] = await pool.query('SELECT COUNT(*) as count FROM children WHERE DATE(createdAt) = ?', [today]);
    const [[totalViolations]] = await pool.query('SELECT COUNT(*) as count FROM violations WHERE DATE(date) = ?', [today]);
    const [[pendingAssessments]] = await pool.query('SELECT COUNT(*) as count FROM assessments WHERE status = ?', ['Scheduled']);
    const [[upcomingHearings]] = await pool.query('SELECT COUNT(*) as count FROM courtRecords WHERE hearingDate >= ? AND status = ?', [today, 'Scheduled']);
    
    const summary = {
      activeResidents: residentCount.count,
      newAdmissionsToday: newAdmissions.count,
      violationsToday: totalViolations.count,
      pendingAssessments: pendingAssessments.count,
      upcomingHearings: upcomingHearings.count,
    };
    
    await pool.query(
      'INSERT INTO reports (id, title, type, date, generatedBy, status, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [reportId, `Daily Facility Report - ${today}`, 'daily', today, 'System', 'Generated', 'System']
    );
    
    console.log(`✅ Daily Facility Report generated: ${reportId}`, summary);
  } catch (error) {
    console.error('Daily report generation failed:', error.message);
  }
}, {
  scheduled: true,
  timezone: 'Asia/Manila',
});

cron.schedule('55 23 31 3,6,9,12 *', async () => {
  console.log('Running scheduled quarterly DSWD report generation...');
  try {
    const { pool } = require('./config/database');
    const now = new Date();
    const quarter = Math.ceil((now.getMonth() + 1) / 3);
    const year = now.getFullYear();
    const reportId = `REP-Q${quarter}-${year}-${Date.now()}`;
    
    // Calculate quarter date range
    const startMonth = (quarter - 1) * 3;
    const quarterStart = `${year}-${String(startMonth + 1).padStart(2, '0')}-01`;
    const quarterEnd = `${year}-${String(startMonth + 3).padStart(2, '0')}-31`;
    
    // Get comprehensive statistics for DSWD
    const [[totalResidents]] = await pool.query('SELECT COUNT(*) as count FROM children');
    const [[activeResidents]] = await pool.query('SELECT COUNT(*) as count FROM children WHERE status = ?', ['Active']);
    const [[newAdmissions]] = await pool.query('SELECT COUNT(*) as count FROM children WHERE admissionDate >= ? AND admissionDate <= ?', [quarterStart, quarterEnd]);
    const [[totalViolations]] = await pool.query('SELECT COUNT(*) as count FROM violations WHERE date >= ? AND date <= ?', [quarterStart, quarterEnd]);
    const [[totalAssessments]] = await pool.query('SELECT COUNT(*) as count FROM assessments WHERE date >= ? AND date <= ?', [quarterStart, quarterEnd]);
    const [[totalCourtRecords]] = await pool.query('SELECT COUNT(*) as count FROM courtRecords WHERE hearingDate >= ? AND hearingDate <= ?', [quarterStart, quarterEnd]);
    
    const summary = {
      totalResidents: totalResidents.count,
      activeResidents: activeResidents.count,
      newAdmissions: newAdmissions.count,
      violations: totalViolations.count,
      assessments: totalAssessments.count,
      courtRecords: totalCourtRecords.count,
    };
    
    await pool.query(
      'INSERT INTO reports (id, title, type, date, generatedBy, status, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [reportId, `DSWD Quarterly Report Q${quarter} ${year}`, 'quarterly', now.toISOString().split('T')[0], 'System', 'Generated', 'System']
    );
    
    console.log(`✅ DSWD Quarterly Report generated: ${reportId}`, summary);
  } catch (error) {
    console.error('Quarterly report generation failed:', error.message);
  }
}, {
  scheduled: true,
  timezone: 'Asia/Manila',
});

// Auto-migration: add childRecordTabs column if missing
async function runMigrations() {
  const { pool } = require('./config/database');
  try {
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'childRecordTabs'`
    );
    if (cols.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN childRecordTabs JSON NULL AFTER accessibleModules`);
      const allTabs = JSON.stringify(['Personal Info', 'Phase Timeline', 'Case Progress', 'Medical', 'Behavioral']);
      await pool.query(`UPDATE users SET childRecordTabs = ? WHERE childRecordTabs IS NULL`, [allTabs]);
      console.log('Migration: added childRecordTabs column and back-filled existing users.');
    } else {
      console.log('Migration: childRecordTabs column already exists - OK.');
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS phaseProgress (
        id VARCHAR(40) PRIMARY KEY,
        residentId VARCHAR(40) NOT NULL,
        phaseName VARCHAR(100) NOT NULL,
        enteredAt DATE NOT NULL,
        completedAt DATE NULL,
        tasksRequired JSON NULL,
        tasksCompleted JSON NULL,
        notes TEXT NULL,
        enteredBy VARCHAR(100) NULL,
        completedBy VARCHAR(100) NULL,
        createdBy VARCHAR(100) NULL,
        isCurrent BOOLEAN NOT NULL DEFAULT FALSE,
        violationCount INT NOT NULL DEFAULT 0,
        advancementBlocked BOOLEAN NOT NULL DEFAULT FALSE,
        demotionRecommended BOOLEAN NOT NULL DEFAULT FALSE,
        demotionCount INT NOT NULL DEFAULT 0,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_phaseProgress_residentId (residentId),
        INDEX idx_phaseProgress_isCurrent (isCurrent)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Keep existing deployments compatible with the current child resource
    // contract without replacing or modifying existing records.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS children (
        id VARCHAR(40) PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        age INT NOT NULL DEFAULT 0,
        gender ENUM('Male', 'Female') NOT NULL DEFAULT 'Male',
        admissionDate DATE NULL,
        legalCategory VARCHAR(150) NULL,
        caseType VARCHAR(150) NULL,
        status ENUM('Active', 'Discharged') NOT NULL DEFAULT 'Active',
        casePhase VARCHAR(150) NULL,
        isRepeatOffender BOOLEAN NOT NULL DEFAULT FALSE,
        previousCaseDetails TEXT NULL,
        previousCases JSON NULL,
        birthDate DATE NULL,
        address TEXT NULL,
        documentsComplete BOOLEAN NOT NULL DEFAULT FALSE,
        documents JSON NULL,
        medicalRecords JSON NULL,
        lastCheckup DATE NULL,
        notes TEXT NULL,
        behaviorNotes TEXT NULL,
        guardianName VARCHAR(150) NULL,
        guardianContact VARCHAR(100) NULL,
        behavioralLogs JSON NULL,
        assessments JSON NULL,
        phaseTasksCompleted JSON NULL,
        needsPsychAssessment BOOLEAN NOT NULL DEFAULT FALSE,
        readmissionDate DATE NULL,
        readmissionDatetime DATETIME NULL,
        createdBy VARCHAR(100) NULL,
        modifiedBy VARCHAR(100) NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [childColumns] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'children'`
    );
    if (childColumns.length > 0) {
      const existingChildColumns = new Set(childColumns.map(column => column.COLUMN_NAME));
      const childColumnDefinitions = {
        age: 'INT NOT NULL DEFAULT 0',
        gender: "ENUM('Male', 'Female') NOT NULL DEFAULT 'Male'",
        admissionDate: 'DATE NULL',
        legalCategory: 'VARCHAR(150) NULL',
        caseType: 'VARCHAR(150) NULL',
        status: "ENUM('Active', 'Discharged') NOT NULL DEFAULT 'Active'",
        casePhase: 'VARCHAR(150) NULL',
        isRepeatOffender: 'BOOLEAN NOT NULL DEFAULT FALSE',
        previousCaseDetails: 'TEXT NULL',
        previousCases: 'JSON NULL',
        birthDate: 'DATE NULL',
        address: 'TEXT NULL',
        documentsComplete: 'BOOLEAN NOT NULL DEFAULT FALSE',
        documents: 'JSON NULL',
        medicalRecords: 'JSON NULL',
        lastCheckup: 'DATE NULL',
        notes: 'TEXT NULL',
        behaviorNotes: 'TEXT NULL',
        guardianName: 'VARCHAR(150) NULL',
        guardianContact: 'VARCHAR(100) NULL',
        behavioralLogs: 'JSON NULL',
        assessments: 'JSON NULL',
        phaseTasksCompleted: 'JSON NULL',
        needsPsychAssessment: 'BOOLEAN NOT NULL DEFAULT FALSE',
        readmissionDate: 'DATE NULL',
        readmissionDatetime: 'DATETIME NULL',
        createdBy: 'VARCHAR(100) NULL',
        modifiedBy: 'VARCHAR(100) NULL',
        createdAt: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
        updatedAt: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
      };
      for (const [column, definition] of Object.entries(childColumnDefinitions)) {
        if (!existingChildColumns.has(column)) {
          await pool.query(`ALTER TABLE children ADD COLUMN ${column} ${definition}`);
          console.log(`Migration: added children.${column}.`);
        }
      }
    }
  } catch (err) {
    console.warn('Migration warning (childRecordTabs):', err.message);
  }
}

// Start server
async function startServer() {
  try {
    // Test database connection
    await testConnection();

    // Run schema migrations
    await runMigrations();

    // Seed default users
    await seedDatabase();
    
    app.listen(PORT, () => {
      console.log(`SCH-PATH Backend Server`);
      console.log(`=======================`);
      console.log(`API URL: http://localhost:${PORT}`);
      console.log(`Health Check: http://localhost:${PORT}/api/health`);
      console.log(`Scheduled Reports: Daily (23:59), Quarterly (Last day of quarter 23:55)`);
      console.log(`=======================`);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();

module.exports = app;
