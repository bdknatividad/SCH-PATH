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
const {
  defaultsForRole,
  canonicalizeModules,
  canonicalizeSubModules,
  CHILD_RECORD_TAB_ORDER,
} = require('./utils/accessDefaults');
const { asStringArray } = require('./config/rbac');

const app = express();
const PORT = Number(process.env.PORT || 5000);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API Routes
app.use('/api', routes);
console.log('✅ API routes mounted');

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

// TRI deadline reminders. A TRI is due on the last Monday of its reporting month;
// this checks each morning and tells the responsible Houseparent when one is
// coming up or already late. Deduped per resident+period+state, so the daily run
// cannot nag — the same period sends at most one "due" and one "overdue" notice.
cron.schedule('0 7 * * *', async () => {
  console.log('Running TRI deadline reminders...');
  try {
    const { runTriDeadlineReminders } = require('./services/triDeadlineService');
    const result = await runTriDeadlineReminders();
    if (!result.state) {
      console.log(`TRI deadlines: nothing due (period ${result.period}, deadline ${result.deadline}).`);
    } else {
      console.log(
        `TRI deadlines (${result.state}, ${result.period}): ${result.outstanding} outstanding, ` +
        `${result.notified} notified, ${result.skipped} already reminded` +
        (result.unassigned.length ? `, unassigned: ${result.unassigned.join(', ')}` : '')
      );
    }
  } catch (error) {
    console.error('TRI deadline reminders failed:', error.message);
  }
}, {
  scheduled: true,
  timezone: 'Asia/Manila',
});

// Auto-migration: add childRecordTabs column if missing
async function runMigrations() {
  const { pool } = require('./config/database');

  /**
   * Adds a column only when it is genuinely absent, and only anchors it with
   * `AFTER <col>` when that anchor column really exists.
   *
   * Why this exists: `ALTER TABLE t ADD COLUMN x ... AFTER y` fails with
   * ER_BAD_FIELD_ERROR when `y` is missing. These migrations run in file order,
   * so a column anchored to another column must be added *after* the migration
   * that guarantees the anchor. When that ordering was wrong and the error was
   * swallowed by an empty `catch`, the server still booted and printed its
   * "table ensured" line — leaving the column permanently missing and turning
   * into a runtime 400 ("Unknown column 'x' in 'field list'") on the first user
   * action that touched it, with nothing in the logs to explain it.
   */
  async function ensureColumn(table, column, definition, after) {
    // LOWER() on both sides: this instance runs with lower_case_table_names=1,
    // so the physical tables are lowercase (courtrecords) while the code refers
    // to them in camelCase (courtRecords). A case-sensitive comparison here
    // would silently report "already exists" and skip the migration.
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?)`,
      [table]
    );
    const existing = new Set(rows.map((row) => row.COLUMN_NAME.toLowerCase()));
    if (existing.has(column.toLowerCase())) return false;
    const anchor = after && existing.has(after.toLowerCase()) ? ` AFTER \`${after}\`` : '';
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}${anchor}`);
    console.log(`Migration: ${table}.${column} added.`);
    return true;
  }

  /**
   * Adds a unique index only when it is absent AND no duplicate values exist.
   *
   * Makes "at most one row per <column>" a database guarantee instead of
   * something the application has to remember. If duplicates are already
   * present the index is skipped with a warning rather than failing the boot.
   */
  async function ensureUniqueIndex(table, indexName, column) {
    const [existing] = await pool.query(
      `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?) AND LOWER(INDEX_NAME) = LOWER(?)`,
      [table, indexName]
    );
    if (existing.length) return false;
    const [duplicates] = await pool.query(
      `SELECT \`${column}\` AS value, COUNT(*) AS n FROM \`${table}\`
       WHERE \`${column}\` IS NOT NULL GROUP BY \`${column}\` HAVING n > 1 LIMIT 1`
    );
    if (duplicates.length) {
      console.warn(
        `Migration skipped: ${table}.${column} already holds duplicates (e.g. ${duplicates[0].value}), ` +
        `so the unique index ${indexName} was not created.`
      );
      return false;
    }
    await pool.query(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${indexName}\` (\`${column}\`)`);
    console.log(`Migration: unique index ${indexName} on ${table}.${column} added.`);
    return true;
  }

  // ── Ensure foundational entity tables exist (schema.sql definitions) ──
  await pool.query(`CREATE TABLE IF NOT EXISTS staff (
      id VARCHAR(40) PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      position VARCHAR(100) NULL,
      department VARCHAR(100) NULL,
      email VARCHAR(150) NULL,
      phone VARCHAR(50) NULL,
      status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
      joinDate DATE NULL,
      endDate DATE NULL,
      documents JSON NULL,
      userId VARCHAR(40) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('Migration: staff table ensured.');

    await pool.query(`CREATE TABLE IF NOT EXISTS activities (
      id VARCHAR(40) PRIMARY KEY,
      title VARCHAR(150) NOT NULL,
      date DATE NULL,
      time VARCHAR(50) NULL,
      type VARCHAR(100) NULL,
      category VARCHAR(100) NULL,
      location VARCHAR(150) NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'Upcoming',
      description TEXT NULL,
      notes TEXT NULL,
      personInCharge JSON NULL,
      facilitators JSON NULL,
      participants JSON NULL,
      selectedResidentIds JSON NULL,
      recommendedResidentIds JSON NULL,
      notRecommendedResidentIds JSON NULL,
      notRecommendedReasons JSON NULL,
      violationIds JSON NULL,
      createdBy VARCHAR(100) NULL,
      modifiedBy VARCHAR(100) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('Migration: activities table ensured.');

    await pool.query(`CREATE TABLE IF NOT EXISTS assessments (
      id VARCHAR(40) PRIMARY KEY,
      title VARCHAR(150) NOT NULL,
      date DATE NULL,
      time VARCHAR(50) NULL,
      type VARCHAR(100) NULL,
      assessor VARCHAR(150) NULL,
      status ENUM('Scheduled', 'Completed') NOT NULL DEFAULT 'Scheduled',
      forResidents JSON NULL,
      description TEXT NULL,
      results TEXT NULL,
      triggeredBy VARCHAR(100) NULL,
      violationIds JSON NULL,
      createdBy VARCHAR(100) NULL,
      modifiedBy VARCHAR(100) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('Migration: assessments table ensured.');
    // NOTE: assessments.interventionTrackerId / interventionRequirementId are
    // added further down, immediately after `violationIds` is guaranteed to
    // exist — they are anchored `AFTER violationIds`, so adding them here (as
    // this used to) fails on any database whose `assessments` table predates
    // that column. See the "assessment linkage" migration below.

    await pool.query(`CREATE TABLE IF NOT EXISTS reports (
      id VARCHAR(40) PRIMARY KEY,
      title VARCHAR(150) NOT NULL,
      type VARCHAR(50) NOT NULL DEFAULT 'daily',
      date DATE NULL,
      generatedBy VARCHAR(150) NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'Completed',
      summary JSON NULL,
      createdBy VARCHAR(150) NULL,
      modifiedBy VARCHAR(150) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('Migration: reports table ensured.');

    await pool.query(`CREATE TABLE IF NOT EXISTS healthRecords (
      id VARCHAR(40) PRIMARY KEY,
      residentId VARCHAR(40) NULL,
      residentName VARCHAR(150) NOT NULL,
      recordType VARCHAR(100) NOT NULL,
      date DATE NULL,
      assessmentType VARCHAR(150) NULL,
      findings TEXT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'Completed',
      recordedBy VARCHAR(150) NULL,
      allergies VARCHAR(200) DEFAULT 'None',
      conditions VARCHAR(200) DEFAULT 'None',
      medicationName VARCHAR(150) NULL,
      dosage VARCHAR(100) NULL,
      frequency VARCHAR(100) NULL,
      duration VARCHAR(100) NULL,
      prescribedBy VARCHAR(150) NULL,
      treatmentType VARCHAR(150) NULL,
      procedure_ TEXT NULL,
      outcome TEXT NULL,
      followUpDate DATE NULL,
      details JSON NULL,
      createdBy VARCHAR(100) NULL,
      modifiedBy VARCHAR(100) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('Migration: healthRecords table ensured.');

    await pool.query(`CREATE TABLE IF NOT EXISTS activityEvaluations (
      id VARCHAR(80) PRIMARY KEY,
      activityId VARCHAR(40) NULL,
      residentId VARCHAR(40) NULL,
      residentName VARCHAR(150) NULL,
      rating INT NOT NULL,
      remarks TEXT NULL,
      dateEvaluated DATETIME NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('Migration: activityEvaluations table ensured.');

    await pool.query(`CREATE TABLE IF NOT EXISTS alerts (
      id VARCHAR(40) PRIMARY KEY,
      residentId VARCHAR(40) NULL,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(150) NOT NULL,
      message TEXT NOT NULL,
      priority ENUM('Low', 'Medium', 'High', 'Urgent') NOT NULL DEFAULT 'Medium',
      isRead BOOLEAN NOT NULL DEFAULT FALSE,
      readBy VARCHAR(100) NULL,
      readAt TIMESTAMP NULL,
      actionRequired VARCHAR(255) NULL,
      actionTaken TEXT NULL,
      relatedRecordType VARCHAR(50) NULL,
      relatedRecordId VARCHAR(40) NULL,
      targetRole VARCHAR(50) NULL,
      targetUserId VARCHAR(40) NULL,
      actorUsername VARCHAR(100) NULL,
      dedupeKey VARCHAR(191) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_alerts_dedupeKey (dedupeKey),
      INDEX idx_residentId (residentId),
      INDEX idx_isRead (isRead),
      INDEX idx_priority (priority),
      INDEX idx_type (type),
      INDEX idx_targetRole (targetRole),
      INDEX idx_targetUserId (targetUserId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('Migration: alerts table ensured.');

    // Per-user read state. See schema.sql for why the row-level flag is not
    // enough once an alert is addressed to a role rather than a person.
    await pool.query(`CREATE TABLE IF NOT EXISTS alertReads (
      alertId VARCHAR(40) NOT NULL,
      userId VARCHAR(40) NOT NULL,
      readAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (alertId, userId),
      INDEX idx_alertReads_userId (userId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('Migration: alertReads table ensured.');

    // Columns added to `alerts` after it first shipped. Each ALTER is separate
    // so one already-applied column cannot mask the others.
    for (const [column, ddl] of [
      ['targetUserId', 'ALTER TABLE alerts ADD COLUMN targetUserId VARCHAR(40) NULL AFTER targetRole'],
      ['actorUsername', 'ALTER TABLE alerts ADD COLUMN actorUsername VARCHAR(100) NULL AFTER targetUserId'],
      ['dedupeKey', 'ALTER TABLE alerts ADD COLUMN dedupeKey VARCHAR(191) NULL AFTER actorUsername'],
      ['idx_targetUserId', 'ALTER TABLE alerts ADD INDEX idx_targetUserId (targetUserId)'],
      ['uq_alerts_dedupeKey', 'ALTER TABLE alerts ADD UNIQUE INDEX uq_alerts_dedupeKey (dedupeKey)'],
    ]) {
      try {
        await pool.query(ddl);
        console.log(`Migration: alerts.${column} added.`);
      } catch (err) {
        if (!['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(err.code)) {
          console.warn(`Migration warning (alerts.${column}):`, err.message);
        }
      }
    }

    await pool.query(`CREATE TABLE IF NOT EXISTS courtRecords (
      id VARCHAR(40) PRIMARY KEY,
      residentId VARCHAR(40) NOT NULL,
      caseNumber VARCHAR(100) NULL,
      courtName VARCHAR(150) NULL,
      judge VARCHAR(150) NULL,
      prosecutor VARCHAR(150) NULL,
      publicAttorney VARCHAR(150) NULL,
      hearingType VARCHAR(100) NULL,
      hearingDate DATE NULL,
      hearingTime VARCHAR(50) NULL,
      courtOrder TEXT NULL,
      nextHearingDate DATE NULL,
      status ENUM('Scheduled', 'Completed', 'Postponed', 'Cancelled') NOT NULL DEFAULT 'Scheduled',
      notes TEXT NULL,
      createdBy VARCHAR(100) NULL,
      modifiedBy VARCHAR(100) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_residentId (residentId),
      INDEX idx_hearingDate (hearingDate),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('Migration: courtRecords table ensured.');
    // The generic CRUD controller builds its INSERT/UPDATE field list from
    // RESOURCES.courtRecords.columns, which declares `modifiedBy`. Any
    // database whose `courtrecords` table predates that column therefore
    // rejects every create/update with ER_BAD_FIELD_ERROR, because
    // `CREATE TABLE IF NOT EXISTS` above is a no-op on an existing table.
    await ensureColumn('courtRecords', 'modifiedBy', 'VARCHAR(100) NULL', 'createdBy');

    await pool.query(`CREATE TABLE IF NOT EXISTS documents (
      id VARCHAR(40) PRIMARY KEY,
      residentId VARCHAR(40) NULL,
      residentName VARCHAR(150) NULL,
      staffId VARCHAR(40) NULL,
      assessmentId VARCHAR(40) NULL,
      title VARCHAR(150) NOT NULL,
      type VARCHAR(100) NULL,
      category VARCHAR(100) NULL,
      documentCategory VARCHAR(100) NULL,
      description TEXT NULL,
      fileName VARCHAR(255) NULL,
      fileSize INT NULL,
      filePath VARCHAR(500) NULL,
      fileData LONGTEXT NULL,
      fileType VARCHAR(100) NULL,
      uploaderRole VARCHAR(100) NULL,
      status ENUM('Draft', 'Submitted', 'Under Review', 'Approved', 'Rejected', 'Archived', 'Reassessment') NOT NULL DEFAULT 'Draft',
      revision INT NOT NULL DEFAULT 1,
      submittedBy VARCHAR(100) NULL,
      submittedAt TIMESTAMP NULL,
      uploadedBy VARCHAR(100) NULL,
      uploadedAt TIMESTAMP NULL,
      reviewedBy VARCHAR(100) NULL,
      reviewedAt TIMESTAMP NULL,
      approvedBy VARCHAR(100) NULL,
      approvedAt TIMESTAMP NULL,
      rejectedBy VARCHAR(100) NULL,
      rejectedAt TIMESTAMP NULL,
      phase VARCHAR(100) NULL,
      requiredFor VARCHAR(100) NULL,
      rejectionReason TEXT NULL,
      notes TEXT NULL,
      createdBy VARCHAR(100) NULL,
      modifiedBy VARCHAR(100) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_residentId (residentId),
      INDEX idx_staffId (staffId),
      INDEX idx_status (status),
      INDEX idx_category (category),
      INDEX idx_uploaderRole (uploaderRole)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('Migration: documents table ensured.');
    // Links a Documents-module entry back to the Anecdotal Report it mirrors, so
    // submitting a report publishes it into its resident's folder exactly once
    // (a Returned report can be resubmitted, which must update the same entry
    // rather than create a second one).
    await ensureColumn('documents', 'assessmentId', 'VARCHAR(40) NULL', 'residentId');
    await ensureColumn('documents', 'anecdotalReportId', 'VARCHAR(40) NULL', 'residentId');
    // At most one published document per Anecdotal Report, guaranteed by the
    // database. The publisher already looks the entry up before inserting, but
    // that is a read-then-write race; this closes it. NULLs are unaffected —
    // MariaDB allows any number of them in a unique index — so every ordinary
    // upload is untouched.
    await ensureUniqueIndex('documents', 'uq_documents_anecdotal_report', 'anecdotalReportId');

    // Links a Documents-module entry back to the TRI record it mirrors. Approving a
    // TRI publishes the filled official form into the resident's folder; the link is
    // what makes that idempotent, so a re-approve updates the same entry instead of
    // leaving two copies of the same month's assessment.
    await ensureColumn('documents', 'triRecordId', 'VARCHAR(40) NULL', 'residentId');
    await ensureUniqueIndex('documents', 'uq_documents_tri_record', 'triRecordId');
    try { await pool.query('CREATE INDEX idx_documents_assessmentId ON documents (assessmentId)'); } catch (err) { if (err.code !== 'ER_DUP_KEYNAME') console.warn('Migration warning (documents assessment index):', err.message); }

    // ── Documents module: category folders + permanent audit trail ──────────
    //
    // `documentCategory` is the folder a document is filed in (Child → Category
    // → File). It is derived from the document's own title/type/category by
    // `utils/documentCategory.js`, so existing rows are backfilled below rather
    // than being left unfiled — nothing is moved or deleted.
    await ensureColumn('documents', 'documentCategory', 'VARCHAR(100) NULL', 'category');
    // The current decision's actor and date. `reviewedBy`/`reviewedAt` were
    // doing double duty for rejections; the list view has to show "Rejected By"
    // and the rejection date explicitly.
    await ensureColumn('documents', 'rejectedBy', 'VARCHAR(100) NULL', 'approvedAt');
    await ensureColumn('documents', 'rejectedAt', 'TIMESTAMP NULL', 'rejectedBy');
    // The submission round. Upload and first submission are 1; every
    // resubmission increments it, so the audit trail can group transitions.
    await ensureColumn('documents', 'revision', 'INT NOT NULL DEFAULT 1', 'status');
    try { await pool.query('CREATE INDEX idx_documents_documentCategory ON documents (documentCategory)'); } catch (err) { if (err.code !== 'ER_DUP_KEYNAME') console.warn('Migration warning (documents category index):', err.message); }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS documentRevisions (
        id VARCHAR(40) PRIMARY KEY,
        documentId VARCHAR(40) NOT NULL,
        revision INT NOT NULL DEFAULT 1,
        action ENUM('Uploaded', 'Submitted', 'Resubmitted', 'Approved', 'Rejected', 'Reassessment', 'Updated', 'Archived') NOT NULL,
        status VARCHAR(40) NULL,
        actor VARCHAR(100) NULL,
        actorRole VARCHAR(100) NULL,
        reason TEXT NULL,
        notes TEXT NULL,
        snapshot JSON NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_document_revisions (documentId, revision, createdAt)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('Migration: documentRevisions table ensured.');

    // Backfill: file every existing document. The folder is computed in JS from
    // the same rules the API uses, so a row is filed exactly as a new upload
    // would be. Only rows with no folder yet are touched, so this is idempotent
    // and can never move a document an operator has already seen in place.
    try {
      const { categoryForDocument } = require('./utils/documentCategory');
      const [unfiled] = await pool.query(
        'SELECT id, title, type, category, fileName FROM documents WHERE documentCategory IS NULL OR documentCategory = \'\''
      );
      let filed = 0;
      for (const document of unfiled) {
        await pool.query('UPDATE documents SET documentCategory = ? WHERE id = ?', [
          categoryForDocument(document),
          document.id,
        ]);
        filed += 1;
      }
      if (filed > 0) console.log(`Migration: filed ${filed} existing document(s) into category folders.`);
    } catch (err) {
      console.warn('Migration warning (documents category backfill):', err.message);
    }

    // Backfill: name the approver on documents that were published as Approved
    // before the publishers recorded one.
    //
    // The TRI, Anecdotal Report and QPR publishers wrote `status = 'Approved'` as
    // a literal and never set `approvedBy`/`approvedAt`, so those entries showed a
    // submitter and an empty approver. New publishes carry the decision now; this
    // fills in the ones already on file, from the record that approved them.
    //
    // Only rows that are Approved with no approver are touched, so it is
    // idempotent and can never overwrite a decision a reviewer actually made. Each
    // publisher's own table is created lazily by its controller, so a missing one
    // is expected on a fresh database rather than an error.
    const approverBackfills = [
      ['TRI', 'triRecords', 'triRecordId'],
      ['Anecdotal Report', 'anecdotalReports', 'anecdotalReportId'],
      ['Quarterly Progress Report', 'quarterlyProgressReports', 'quarterlyReportId'],
    ];
    for (const [label, sourceTable, linkColumn] of approverBackfills) {
      try {
        const [result] = await pool.query(
          `UPDATE documents d
             JOIN ${sourceTable} s ON s.id = d.${linkColumn}
              SET d.approvedBy = COALESCE(s.finalizedBy, s.reviewedBy),
                  d.approvedAt = COALESCE(s.finalizedAt, s.reviewedAt),
                  d.reviewedBy = COALESCE(d.reviewedBy, s.reviewedBy),
                  d.reviewedAt = COALESCE(d.reviewedAt, s.reviewedAt)
            WHERE d.status = 'Approved' AND d.approvedBy IS NULL
              AND COALESCE(s.finalizedBy, s.reviewedBy) IS NOT NULL`
        );
        if (result?.affectedRows > 0) {
          console.log(`Migration: recorded the approver on ${result.affectedRows} ${label} document(s).`);
        }
      } catch (err) {
        // 1146 = ER_NO_SUCH_TABLE, 1054 = ER_BAD_FIELD_ERROR (a source table that
        // predates its own reviewer columns). Neither is fatal to the boot.
        if (!['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(err.code)) {
          console.warn(`Migration warning (${label} approver backfill):`, err.message);
        }
      }
    }

    // Ensure staff.userId column exists (idempotent — safe to re-run)
    try {
      await pool.query('ALTER TABLE staff ADD COLUMN userId VARCHAR(40) NULL');
      console.log('Migration: staff.userId added.');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') console.warn('Migration warning (staff userId):', err.message);
    }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS residentAssignments (
        id VARCHAR(40) PRIMARY KEY,
        residentId VARCHAR(40) NOT NULL,
        staffId VARCHAR(40) NULL,
        userId VARCHAR(40) NULL,
        assignmentType VARCHAR(50) NOT NULL,
        status ENUM('Active', 'Ended') NOT NULL DEFAULT 'Active',
        startAt DATETIME NOT NULL,
        endAt DATETIME NULL,
        source VARCHAR(50) NOT NULL DEFAULT 'manual',
        notes TEXT NULL,
        createdBy VARCHAR(100) NULL,
        updatedBy VARCHAR(100) NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_assignment_resident_status (residentId, status),
        INDEX idx_assignment_staff_status (staffId, status),
        INDEX idx_assignment_user_status (userId, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Migration: residentAssignments table ensured.');
  } catch (err) {
    console.warn('Migration warning (residentAssignments):', err.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS triRecords (
        id VARCHAR(40) PRIMARY KEY,
        residentId VARCHAR(40) NOT NULL,
        caseCycleKey VARCHAR(100) NULL,
        formVersion VARCHAR(30) NOT NULL DEFAULT 'TRI-2025-PDF',
        reportingYear SMALLINT NOT NULL,
        reportingMonth TINYINT NOT NULL,
        status ENUM('Draft', 'Submitted', 'Under Review', 'Returned', 'For Reassessment', 'Finalized') NOT NULL DEFAULT 'Draft',
        responses JSON NOT NULL,
        partOnePoints INT NULL,
        deductions INT NULL,
        finalPoints INT NULL,
        rating VARCHAR(30) NULL,
        previousPoints INT NULL,
        previousRating VARCHAR(30) NULL,
        submissionDeadline DATE NULL,
        effectiveDate DATE NULL,
        submittedBy VARCHAR(100) NULL,
        submittedAt DATETIME NULL,
        reviewedBy VARCHAR(100) NULL,
        reviewedAt DATETIME NULL,
        finalizedBy VARCHAR(100) NULL,
        finalizedAt DATETIME NULL,
        reviewNotes TEXT NULL,
        houseparentSignature LONGTEXT NULL,
        houseparentSignedBy VARCHAR(100) NULL,
        houseparentSignedAt DATETIME NULL,
        createdBy VARCHAR(100) NULL,
        updatedBy VARCHAR(100) NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_tri_resident_period (residentId, reportingYear, reportingMonth),
        INDEX idx_tri_period_status (reportingYear, reportingMonth, status),
        INDEX idx_tri_rating (rating),
        INDEX idx_tri_effectiveDate (effectiveDate)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Migration: triRecords table ensured.');
  } catch (err) {
    console.warn('Migration warning (triRecords):', err.message);
  }

  try {
    // Discharge planning: keep the current expected discharge date on the active
    // admission, and preserve every extension decision in a separate immutable
    // history table. Existing deployments are upgraded in place.
    await ensureColumn('admissions', 'expectedDischargeDate', 'DATE NULL', 'status');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS dischargeExtensions (
        id VARCHAR(40) PRIMARY KEY,
        residentId VARCHAR(40) NOT NULL,
        admissionId VARCHAR(40) NOT NULL,
        triRecordId VARCHAR(40) NULL,
        recommendationId VARCHAR(40) NULL,
        previousDischargeDate DATE NOT NULL,
        newDischargeDate DATE NOT NULL,
        extensionDays INT NOT NULL,
        reason TEXT NOT NULL,
        relatedViolationId VARCHAR(40) NULL,
        decidedBy VARCHAR(100) NOT NULL,
        decidedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE CASCADE,
        FOREIGN KEY (admissionId) REFERENCES admissions(id) ON DELETE CASCADE,
        INDEX idx_dischargeExtensions_resident (residentId),
        INDEX idx_dischargeExtensions_admission (admissionId),
        INDEX idx_dischargeExtensions_tri (triRecordId)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS dischargeRecommendations (
        id VARCHAR(40) PRIMARY KEY,
        residentId VARCHAR(40) NOT NULL,
        admissionId VARCHAR(40) NULL,
        triRecordId VARCHAR(40) NOT NULL,
        reportingYear SMALLINT NOT NULL,
        reportingMonth TINYINT NOT NULL,
        majorCount INT NOT NULL DEFAULT 0,
        minorCount INT NOT NULL DEFAULT 0,
        thresholdType VARCHAR(50) NOT NULL,
        recommendationNote TEXT NOT NULL,
        status ENUM('Pending','Reviewed','Dismissed','Decision Made') NOT NULL DEFAULT 'Pending',
        reviewedBy VARCHAR(100) NULL,
        reviewedAt DATETIME NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_dischargeRecommendation_tri (triRecordId),
        INDEX idx_dischargeRecommendation_resident (residentId),
        INDEX idx_dischargeRecommendation_period (reportingYear, reportingMonth),
        FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE CASCADE,
        FOREIGN KEY (triRecordId) REFERENCES triRecords(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Migration: discharge planning tables and expected date ensured.');
  } catch (err) {
    console.warn('Migration warning (discharge planning):', err.message);
  }

  try {
    // Order matters here. interventionTrackerId is anchored AFTER violationIds,
    // and interventionRequirementId AFTER interventionTrackerId, so each column
    // must be ensured before the one that depends on it. Running these out of
    // order (or swallowing the resulting ER_BAD_FIELD_ERROR) is what produced
    // "Unknown column 'interventionTrackerId' in 'field list'" when a
    // Psychologist verified a violation — violationController.review INSERTs
    // into assessments with exactly that column.
    await ensureColumn('assessments', 'violationIds', 'JSON NULL', 'triggeredBy');
    await ensureColumn('assessments', 'interventionTrackerId', 'VARCHAR(40) NULL', 'violationIds');
    await ensureColumn('assessments', 'interventionRequirementId', 'VARCHAR(40) NULL', 'interventionTrackerId');
    await ensureColumn('assessments', 'schedulingMode', "VARCHAR(30) NULL", 'interventionRequirementId');
    const [violationColumns] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'violations'`
    );
    const existingViolationColumns = new Set(violationColumns.map(column => column.COLUMN_NAME));
    if (!existingViolationColumns.has('assessmentCompleted')) {
      await pool.query('ALTER TABLE violations ADD COLUMN assessmentCompleted BOOLEAN NOT NULL DEFAULT FALSE AFTER assessmentTriggered');
      console.log('Migration: violations.assessmentCompleted added.');
    }
  } catch (err) {
    console.warn('Migration warning (assessment linkage):', err.message);
  }

  try {
    const [activityColumns] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activities'`
    );
    const existingActivityColumns = new Set(activityColumns.map(column => column.COLUMN_NAME));
    for (const [column, definition] of Object.entries({ createdBy: 'VARCHAR(100) NULL', modifiedBy: 'VARCHAR(100) NULL' })) {
      if (!existingActivityColumns.has(column)) {
        await pool.query(`ALTER TABLE activities ADD COLUMN ${column} ${definition}`);
        console.log(`Migration: activities.${column} added.`);
      }
    }
  } catch (err) {
    console.warn('Migration warning (activity audit fields):', err.message);
  }

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

    // Hierarchy-aware grants. `childRecordTabs` only ever covered Child
    // Records; `subModules` generalises the same idea to every module that has
    // submenus (Violations, Houseparent, Documents). Nullable and
    // back-filled from each account's role, so an existing row keeps exactly
    // the access it had.
    await ensureColumn('users', 'subModules', 'JSON NULL', 'childRecordTabs');
    try {
      const [needingSubModules] = await pool.query(
        `SELECT id, role, accessibleModules, childRecordTabs FROM users WHERE subModules IS NULL`
      );
      for (const row of needingSubModules) {
        const defaults = defaultsForRole(row.role);
        // mysql2 may hand back a JSON column either parsed or as text,
        // depending on the driver version — normalise before reading it.
        const grantedModules = canonicalizeModules(
          asStringArray(row.accessibleModules),
          defaults.modules,
        );
        const subModules = {};
        for (const moduleName of grantedModules) {
          subModules[moduleName] = defaults.subModules[moduleName] || [];
        }
        // Preserve the account's existing per-tab grant for Child Records.
        if (grantedModules.includes('Child Records')) {
          subModules['Child Records'] = canonicalizeSubModules(
            'Child Records',
            asStringArray(row.childRecordTabs),
            CHILD_RECORD_TAB_ORDER,
          );
        }
        await pool.query('UPDATE users SET subModules = ? WHERE id = ?', [
          JSON.stringify(subModules),
          row.id,
        ]);
      }
      if (needingSubModules.length > 0) {
        console.log(`Migration: back-filled subModules for ${needingSubModules.length} user(s).`);
      }
    } catch (backfillError) {
      console.warn('Migration warning (subModules back-fill):', backfillError.message);
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS residentPerformanceRatings (
        residentId VARCHAR(40) NOT NULL,
        ratingYear SMALLINT NOT NULL,
        ratingMonth TINYINT NOT NULL,
        rating VARCHAR(30) NOT NULL,
        points INT NOT NULL DEFAULT 0,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (residentId, ratingYear, ratingMonth),
        INDEX idx_performance_period (ratingYear, ratingMonth)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [phaseColumns] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'phaseProgress'`
    );
    const existingPhaseColumns = new Set(phaseColumns.map(column => column.COLUMN_NAME));
    const phaseColumnDefinitions = {
      completedAt: 'DATE NULL',
      tasksRequired: 'JSON NULL',
      tasksCompleted: 'JSON NULL',
      notes: 'TEXT NULL',
      enteredBy: 'VARCHAR(100) NULL',
      completedBy: 'VARCHAR(100) NULL',
      createdBy: 'VARCHAR(100) NULL',
      isCurrent: 'BOOLEAN NOT NULL DEFAULT FALSE',
      violationCount: 'INT NOT NULL DEFAULT 0',
      advancementBlocked: 'BOOLEAN NOT NULL DEFAULT FALSE',
      demotionRecommended: 'BOOLEAN NOT NULL DEFAULT FALSE',
      demotionCount: 'INT NOT NULL DEFAULT 0',
      createdAt: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
      updatedAt: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
    };
    for (const [column, definition] of Object.entries(phaseColumnDefinitions)) {
      if (!existingPhaseColumns.has(column)) {
        await pool.query(`ALTER TABLE phaseProgress ADD COLUMN ${column} ${definition}`);
        console.log(`Migration: added phaseProgress.${column}.`);
      }
    }

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

  // Auto-migrate violations table: add offense/intervention columns
  try {
    const [vioCols] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'violations'`
    );
    const vioColSet = new Set(vioCols.map(r => r.COLUMN_NAME));
    const vioMigrations = {
      offenseNumber:        "VARCHAR(20) NULL",
      interventionStartDate:"DATE NULL",
      interventionMonth:    "VARCHAR(7) NULL",
      clearedBy:            "VARCHAR(100) NULL",
      clearedAt:            "DATETIME NULL",
      incidentGroupId:      "VARCHAR(60) NULL",
      guideId:              "VARCHAR(40) NULL",
    };
    for (const [col, def] of Object.entries(vioMigrations)) {
      if (!vioColSet.has(col)) {
        await pool.query(`ALTER TABLE violations ADD COLUMN ${col} ${def}`);
        console.log(`Migration: added violations.${col}`);
      }
    }
  } catch (err) {
    console.warn('Migration warning (violations):', err.message);
  }

  // Backfill: `violations.points` was declared in the schema and skipped by every
  // writer, so every existing row carries the default 0. The dashboard's urgency
  // rating and the monthly performance ratings both SUM this column, which meant
  // every resident read as "Very Good" no matter how many unresolved violations
  // they carried. The CASE is generated from `VIOLATION_SEVERITY`, the same map
  // `utils/violationPoints.js` reads, so this backfill and every future write
  // apply one rule. Idempotent — a second run matches nothing.
  try {
    const { VIOLATION_SEVERITY } = require('./utils/constants');
    const branches = Object.entries(VIOLATION_SEVERITY)
      .map(([severity, entry]) => `WHEN '${severity}' THEN ${Number(entry.points) || 0}`)
      .join(' ');
    const pointsCase = `CASE severity ${branches} ELSE 0 END`;
    const [result] = await pool.query(
      `UPDATE violations SET points = ${pointsCase} WHERE points <> ${pointsCase}`
    );
    if (result.affectedRows) {
      console.log(`Migration: backfilled violations.points on ${result.affectedRows} row(s).`);
    }
  } catch (err) {
    console.warn('Migration warning (violations points backfill):', err.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS violation_guide (
        id VARCHAR(40) PRIMARY KEY,
        name VARCHAR(500) NOT NULL,
        metadata JSON NULL,
        category ENUM('Minor', 'Major') NOT NULL DEFAULT 'Minor',
        description TEXT NULL,
        status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
        createdBy VARCHAR(100) NOT NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        updatedBy VARCHAR(100) NULL,
        INDEX idx_status (status),
        INDEX idx_category (category)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Migration: violation_guide table ensured.');
  } catch (err) {
    console.warn('Migration warning (violation_guide):', err.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS intervention_types (
        id VARCHAR(40) PRIMARY KEY,
        type VARCHAR(100) NOT NULL UNIQUE,
        description TEXT NULL,
        requiresDuration BOOLEAN NOT NULL DEFAULT TRUE,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Migration: intervention_types table ensured.');

    await pool.query(`
      INSERT INTO intervention_types (id, type, description, requiresDuration)
      VALUES
        ('IT001', 'Privilege Suspension', 'Suspension of privileges such as tablet, TV, or music', TRUE),
        ('IT002', 'Psychosocial Activity', 'Psychosocial intervention and counseling sessions', FALSE),
        ('IT003', 'Household Chores', 'Assignment of household chores', TRUE),
        ('IT004', 'Cleaning', 'Cleaning assignment for specific areas', TRUE),
        ('IT005', 'Confiscation', 'Confiscation of items with return/safekeeping options', FALSE),
        ('IT006', 'Dialogue/Counseling', 'Dialogue or counseling session', FALSE),
        ('IT007', 'Referral', 'Referral to specialist or staff member', FALSE),
        ('IT008', 'Other', 'Other interventions', FALSE)
      ON DUPLICATE KEY UPDATE
        description = VALUES(description),
        requiresDuration = VALUES(requiresDuration)
    `);
    console.log('Migration: default intervention types ensured.');
  } catch (err) {
    console.warn('Migration warning (intervention_types):', err.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS guide_interventions (
        id VARCHAR(40) PRIMARY KEY,
        guideId VARCHAR(40) NOT NULL,
        offenseLevel VARCHAR(50) NOT NULL,
        interventionType VARCHAR(100) NOT NULL,
        duration INT NULL,
        unit VARCHAR(50) NULL,
        metadata JSON NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (guideId) REFERENCES violation_guide(id) ON DELETE CASCADE,
        INDEX idx_guideId (guideId),
        INDEX idx_offenseLevel (offenseLevel)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query(`ALTER TABLE guide_interventions MODIFY COLUMN offenseLevel VARCHAR(50) NOT NULL`);
    await ensureColumn('guide_interventions', 'status', "ENUM('Active','Inactive') NOT NULL DEFAULT 'Active'", 'metadata');
    console.log('Migration: guide_interventions table ensured.');
  } catch (err) {
    console.warn('Migration warning (guide_interventions):', err.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS intervention_tracker (
        id VARCHAR(40) PRIMARY KEY,
        residentId VARCHAR(40) NOT NULL,
        violationId VARCHAR(40) NOT NULL,
        guideId VARCHAR(40) NOT NULL,
        offenseLevel VARCHAR(50) NOT NULL,
        interventionType VARCHAR(100) NOT NULL,
        duration INT NULL,
        unit VARCHAR(50) NULL,
        status ENUM('In Progress', 'Completed') NOT NULL DEFAULT 'In Progress',
        scheduledAt DATETIME NULL,
        psychosocialActivities JSON NULL,
        startDate DATE NULL,
        completionDate DATE NULL,
        notes TEXT NULL,
        completedBy VARCHAR(100) NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE CASCADE,
        FOREIGN KEY (violationId) REFERENCES violations(id) ON DELETE CASCADE,
        FOREIGN KEY (guideId) REFERENCES violation_guide(id) ON DELETE CASCADE,
        INDEX idx_residentId (residentId),
        INDEX idx_status (status),
        INDEX idx_violationId (violationId)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    try { await pool.query(`UPDATE intervention_tracker SET status = 'In Progress' WHERE status = 'Pending'`); } catch (err) { console.warn('Migration warning (intervention_tracker status backfill):', err.message); }
    try { await pool.query(`ALTER TABLE intervention_tracker MODIFY COLUMN status ENUM('In Progress','Completed') NOT NULL DEFAULT 'In Progress'`); } catch (err) { console.warn('Migration warning (intervention_tracker status enum):', err.message); }
    // Every one of these columns is written by violationController.review when a
    // Psychologist verifies a violation, so a missing one breaks verification
    // outright. psychosocialActivities is anchored AFTER scheduledAt, and
    // endDate AFTER startDate — each dependency is therefore ensured first.
    // These used to be plain ALTERs with an empty `catch`, which is how the
    // identical "Unknown column 'metadata' in 'field list'" failure went
    // unnoticed on every verification that had configured interventions.
    await ensureColumn('intervention_tracker', 'scheduledAt', 'DATETIME NULL', 'status');
    await ensureColumn('intervention_tracker', 'psychosocialActivities', 'JSON NULL', 'scheduledAt');
    await ensureColumn('intervention_tracker', 'metadata', 'JSON NULL', 'unit');
    await ensureColumn('intervention_tracker', 'guideInterventionId', 'VARCHAR(40) NULL', 'guideId');
    await ensureColumn('intervention_tracker', 'endDate', 'DATE NULL', 'startDate');

    // Make the configuration relationship explicit. New verification records
    // store the exact guide_interventions.id they came from. Legacy records are
    // backfilled only when the match is unambiguous; no placeholder is invented.
    try {
      // Remove stale guide references before adding the FK. We only keep links
      // that point to a real guide; unresolved rows are re-matched below.
      await pool.query(`
        UPDATE violations v
        LEFT JOIN violation_guide g ON g.id = v.guideId
        SET v.guideId = NULL
        WHERE v.guideId IS NOT NULL AND g.id IS NULL
      `);
      await pool.query(`
        UPDATE intervention_tracker it
        LEFT JOIN guide_interventions gi ON gi.id = it.guideInterventionId
        SET it.guideInterventionId = NULL
        WHERE it.guideInterventionId IS NOT NULL AND gi.id IS NULL
      `);

      await pool.query(`
        UPDATE violations v
        JOIN (
          SELECT LOWER(TRIM(name)) AS normalizedName, MIN(id) AS guideId
          FROM violation_guide
          WHERE status = 'Active' AND category IN ('Minor', 'Major')
          GROUP BY LOWER(TRIM(name))
          HAVING COUNT(*) = 1
        ) g ON LOWER(TRIM(v.type)) = g.normalizedName
        SET v.guideId = g.guideId
        WHERE v.guideId IS NULL
      `);
      await pool.query(`
        UPDATE intervention_tracker it
        JOIN (
          SELECT guideId, offenseLevel, LOWER(TRIM(interventionType)) AS normalizedType,
                 MIN(id) AS guideInterventionId
          FROM guide_interventions
          GROUP BY guideId, offenseLevel, LOWER(TRIM(interventionType))
          HAVING COUNT(*) = 1
        ) gi ON gi.guideId = it.guideId
            AND gi.offenseLevel = it.offenseLevel
            AND gi.normalizedType = LOWER(TRIM(it.interventionType))
        SET it.guideInterventionId = gi.guideInterventionId
        WHERE it.guideInterventionId IS NULL
      `);

      const [fkRows] = await pool.query(`
        SELECT CONSTRAINT_NAME
        FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = 'violations'
          AND CONSTRAINT_NAME = 'fk_violations_guide'
      `);
      if (!fkRows.length) {
        await pool.query(`
          ALTER TABLE violations
          ADD CONSTRAINT fk_violations_guide
          FOREIGN KEY (guideId) REFERENCES violation_guide(id) ON DELETE RESTRICT
        `);
      }

      const [trackerFkRows] = await pool.query(`
        SELECT CONSTRAINT_NAME
        FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = 'intervention_tracker'
          AND CONSTRAINT_NAME = 'fk_tracker_guide_intervention'
      `);
      if (!trackerFkRows.length) {
        // Nullable for legacy tracker rows that could not be matched
        // unambiguously. Every new row created by verification is non-null.
        await pool.query(`
          ALTER TABLE intervention_tracker
          ADD CONSTRAINT fk_tracker_guide_intervention
          FOREIGN KEY (guideInterventionId) REFERENCES guide_interventions(id) ON DELETE RESTRICT
        `);
      }
      console.log('Migration: violation -> guide -> exact guide intervention relationships ensured.');
    } catch (relationshipErr) {
      console.warn('Migration warning (violation/intervention relationships):', relationshipErr.message);
    }
    await pool.query(`ALTER TABLE intervention_tracker MODIFY COLUMN offenseLevel VARCHAR(50) NOT NULL`);
    // Prevent duplicate tracker rows for the same violation + exact configured
    // intervention. Legacy rows with NULL guideInterventionId remain allowed;
    // every new verification row has a non-null exact source ID.
    try {
      const [uniqueRows] = await pool.query(`
        SELECT CONSTRAINT_NAME
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = 'intervention_tracker'
          AND CONSTRAINT_TYPE = 'UNIQUE'
          AND CONSTRAINT_NAME = 'uq_tracker_violation_guide_intervention'
      `);
      if (!uniqueRows.length) {
        // Only add the constraint when there are no duplicate non-null legacy
        // mappings. The relationship backfill above intentionally leaves
        // ambiguous legacy rows NULL.
        const [dupes] = await pool.query(`
          SELECT violationId, guideInterventionId, COUNT(*) AS c
          FROM intervention_tracker
          WHERE guideInterventionId IS NOT NULL
          GROUP BY violationId, guideInterventionId
          HAVING COUNT(*) > 1
          LIMIT 1
        `);
        if (!dupes.length) {
          await pool.query(`
            ALTER TABLE intervention_tracker
            ADD CONSTRAINT uq_tracker_violation_guide_intervention
            UNIQUE (violationId, guideInterventionId)
          `);
        } else {
          console.warn('Migration warning: duplicate tracker mappings exist; unique tracker constraint was not added.');
        }
      }
    } catch (uniqueErr) {
      console.warn('Migration warning (tracker uniqueness):', uniqueErr.message);
    }

    // Houseparent accounts keep a fixed username (HP 1..HP 10) for ordering
    // and login, but Account Management can set a separate display name
    // (e.g. an actual staff name) that's shown everywhere instead.
    const [userCols] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
    );
    if (!userCols.some(c => c.COLUMN_NAME === 'displayName')) {
      await pool.query(`ALTER TABLE users ADD COLUMN displayName VARCHAR(150) NULL AFTER username`);
      console.log('Migration: users.displayName added.');
    }

    // Backward-compatibility shim for older Account Management builds that
    // still reference users.fullName while the current application uses
    // displayName.  Keeping this nullable column prevents old saved routes,
    // migrations, or database-side objects from breaking module-access edits.
    const [userColsAfterDisplayName] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
    );
    if (!userColsAfterDisplayName.some(c => c.COLUMN_NAME === 'fullName')) {
      await pool.query(`ALTER TABLE users ADD COLUMN fullName VARCHAR(150) NULL AFTER displayName`);
      console.log('Migration: users.fullName compatibility column added.');
    }
    await pool.query(`
      UPDATE users
      SET fullName = COALESCE(NULLIF(TRIM(fullName), ''), displayName, username)
      WHERE fullName IS NULL OR TRIM(fullName) = ''
    `);

    // Repair only genuinely empty legacy access rows at startup. Do not reset
    // Nurse, Educator, or Houseparent permissions here: Account Management is
    // allowed to customize those rows, and overwriting them on every backend
    // restart would make saved module selections disappear.
    const roleModuleDefaults = {
      nurse: ['Dashboard', 'Activities', 'Documents', 'Health', 'Reports'],
      educator: ['Dashboard', 'Documents', 'Activities', 'Education'],
      houseparent: ['Dashboard', 'Violations', 'Activities', 'Assessments', 'Houseparent'],
    };
    const roleTabDefaults = {
      nurse: ['Personal Info', 'Phase Timeline', 'Medical', 'Behavioral'],
      educator: ['Personal Info', 'Education'],
      houseparent: ['Personal Info', 'Phase Timeline', 'Education', 'Medical', 'Behavioral'],
    };
    for (const [role, modules] of Object.entries(roleModuleDefaults)) {
      await pool.query(
        `UPDATE users
         SET accessibleModules = ?, childRecordTabs = ?
         WHERE LOWER(role) = ? AND status = 'Active'
           AND (accessibleModules IS NULL OR JSON_LENGTH(accessibleModules) = 0)`,
        [JSON.stringify(modules), JSON.stringify(roleTabDefaults[role]), role]
      );
    }
    console.log('Migration: empty nurse, educator, and houseparent access rows repaired without overwriting custom permissions.');

    // Student identification for the Education module — LRN for registered
    // students, Trainee Number for CMDC trainees.
    const [childCols] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'children'`
    );
    if (!childCols.some(c => c.COLUMN_NAME === 'lrn')) {
      await pool.query(`ALTER TABLE children ADD COLUMN lrn VARCHAR(50) NULL`);
      console.log('Migration: children.lrn added.');
    }
    if (!childCols.some(c => c.COLUMN_NAME === 'traineeNumber')) {
      await pool.query(`ALTER TABLE children ADD COLUMN traineeNumber VARCHAR(50) NULL`);
      console.log('Migration: children.traineeNumber added.');
    }

    console.log('Migration: intervention_tracker table ensured.');
  } catch (err) {
    console.warn('Migration warning (intervention_tracker):', err.message);
  }

  // ── Intervention Requirements (requirement-level tracking per intervention)
  // Each tracker row represents one intervention; its requirements are in this table.
  // Existing tracker rows are migrated to have one requirement each so no data is lost.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS intervention_requirements (
        id VARCHAR(40) PRIMARY KEY,
        interventionId VARCHAR(40) NOT NULL,
        residentId VARCHAR(40) NOT NULL,
        title VARCHAR(150) NOT NULL DEFAULT 'Intervention Requirement',
        status ENUM('Pending', 'In Progress', 'Done', 'Overdue') NOT NULL DEFAULT 'Pending',
        startedAt DATE NULL,
        dueDate DATE NULL,
        completedAt DATETIME NULL,
        completedBy VARCHAR(100) NULL,
        notes TEXT NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (interventionId) REFERENCES intervention_tracker(id) ON DELETE CASCADE,
        INDEX idx_interventionId (interventionId),
        INDEX idx_residentId (residentId),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    // Migrate existing tracker rows → one requirement each (backward-compatible).
    const [existing] = await pool.query(
      `SELECT id, residentId, status, startDate, completionDate, notes, completedBy FROM intervention_tracker`
    );
    for (const row of existing) {
      const rid = `IR${row.id}`;
      try {
        await pool.query(
          `INSERT IGNORE INTO intervention_requirements
           (id, interventionId, residentId, status, startedAt, completedAt, notes, completedBy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [rid, row.id, row.residentId,
            row.status === 'Completed' ? 'Done' : row.status,
            row.startDate, row.completionDate, row.notes, row.completedBy]
        );
      } catch (merr) { /* skip duplicates / schema issues */ }
    }
    console.log('Migration: intervention_requirements table ensured and populated.');
  } catch (err) {
    console.warn('Migration warning (intervention_requirements):', err.message);
  }

  // TRI reassessment workflow: preserve existing records while allowing a reviewer
  // to return a TRI as 'For Reassessment' and the preparer to edit/resubmit it.
  try {
    await pool.query(`ALTER TABLE triRecords MODIFY COLUMN status ENUM('Draft','Submitted','Under Review','Returned','For Reassessment','Finalized') NOT NULL DEFAULT 'Draft'`);
    console.log('Migration: triRecords.status ENUM updated with For Reassessment');
  } catch (err) {
    console.warn('Migration warning (triRecords.status):', err.message);
  }

  // The Houseparent's drawn signature on the TRI. Added so an existing database
  // gets the columns on boot instead of failing the first signature save with
  // ER_BAD_FIELD_ERROR.
  for (const [column, definition] of [
    ['houseparentSignature', 'LONGTEXT NULL'],
    ['houseparentSignedBy', 'VARCHAR(100) NULL'],
    ['houseparentSignedAt', 'DATETIME NULL'],
  ]) {
    try {
      await pool.query(`ALTER TABLE triRecords ADD COLUMN ${column} ${definition}`);
      console.log(`Migration: triRecords.${column} added`);
    } catch (err) {
      // 1060 = duplicate column, which is the normal case on a second boot.
      if (err && err.errno === 1060) continue;
      console.warn(`Migration warning (triRecords.${column}):`, err.message);
    }
  }

  // Add Reassessment to documents status ENUM
  try {
    await pool.query(
      `ALTER TABLE documents MODIFY COLUMN status ENUM('Draft','Submitted','Under Review','Approved','Rejected','Archived','Reassessment') NOT NULL DEFAULT 'Draft'`
    );
    console.log('Migration: documents.status ENUM updated with Reassessment');
  } catch (err) {
    console.warn('Migration warning (documents status):', err.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS incidentReports (
        id VARCHAR(40) PRIMARY KEY,
        violationId VARCHAR(40) NOT NULL,
        residentId VARCHAR(40) NOT NULL,
        interventionTrackerId VARCHAR(40) NULL,
        pdfDocumentId VARCHAR(40) NULL,
        reportTypes JSON NOT NULL,
        othersSpecify VARCHAR(255) NULL,
        incidentDateTime DATETIME NOT NULL,
        summary TEXT NULL,
        actionTaken TEXT NULL,
        result TEXT NULL,
        reportedBy VARCHAR(100) NULL,
        endorsedTo VARCHAR(100) NULL,
        checkedBy VARCHAR(100) NULL,
        notedBy VARCHAR(100) NULL,
        status ENUM('Submitted', 'Pending Review', 'Verified', 'Failed', 'Reassessment') NOT NULL DEFAULT 'Submitted',
        interventionType VARCHAR(100) NULL,
        interventionScheduleDate DATE NULL,
        verifiedBy VARCHAR(100) NULL,
        verifiedAt DATETIME NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (violationId) REFERENCES violations(id) ON DELETE CASCADE,
        INDEX idx_incidentReports_residentId (residentId),
        INDEX idx_incidentReports_violationId (violationId),
        INDEX idx_incidentReports_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Migration: incidentReports table ensured.');
  } catch (err) {
    console.warn('Migration warning (incidentReports):', err.message);
  }
  // Form 08 is unlocked by a completed intervention and must retain that
  // exact tracker relationship for resident/violation isolation.
  try {
    await pool.query(`ALTER TABLE incidentReports MODIFY COLUMN status ENUM('Submitted','Pending Review','Verified','Failed','Reassessment') NOT NULL DEFAULT 'Submitted'`);
  } catch (err) {
    console.warn('Migration warning (incidentReports.status):', err.message);
  }
  try {
    await pool.query(`ALTER TABLE incidentReports ADD COLUMN interventionTrackerId VARCHAR(40) NULL AFTER residentId`);
  } catch (err) {
    if (!/duplicate column|duplicate field/i.test(err.message)) {
      console.warn('Migration warning (incidentReports.interventionTrackerId):', err.message);
    }
  }
  try {
    await pool.query(`ALTER TABLE incidentReports ADD COLUMN pdfDocumentId VARCHAR(40) NULL AFTER interventionTrackerId`);
  } catch (err) {
    if (!/duplicate column|duplicate field/i.test(err.message)) {
      console.warn('Migration warning (incidentReports.pdfDocumentId):', err.message);
    }
  }
  // Form 08's four sign-offs used to be printed names only. Each now also keeps
  // the signature that was drawn for it, stored beside the name it belongs to.
  for (const column of ['reportedBySignature', 'endorsedToSignature', 'checkedBySignature', 'notedBySignature']) {
    try {
      await ensureColumn('incidentReports', column, 'LONGTEXT NULL', 'notedBy');
    } catch (err) {
      console.warn(`Migration warning (incidentReports.${column}):`, err.message);
    }
  }


  try {
    await pool.query('ALTER TABLE accessRequests ADD COLUMN documentId VARCHAR(40) NULL AFTER targetRole');
    await pool.query('ALTER TABLE accessRequests ADD INDEX idx_access_documentId (documentId)');
    console.log('Migration: accessRequests.documentId added.');
  } catch (err) {
    if (!['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(err.code)) {
      console.warn('Migration warning (accessRequests documentId):', err.message);
    }
  }

  // The role the requester held when they asked. Stored rather than joined so
  // the request stays an accurate record if the account's role later changes,
  // and so the reviewer queue can label who asked. accessRequestController's
  // ensureTable() adds it too, for databases that predate this migration.
  try {
    await pool.query('ALTER TABLE accessRequests ADD COLUMN requesterRole VARCHAR(50) NULL AFTER requesterUsername');
    console.log('Migration: accessRequests.requesterRole added.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') {
      console.warn('Migration warning (accessRequests requesterRole):', err.message);
    }
  }

  try {
    await pool.query('ALTER TABLE healthRecords ADD COLUMN createdBy VARCHAR(100) NULL AFTER followUpDate');
    console.log('Migration: healthRecords.createdBy added.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') {
      console.warn('Migration warning (healthRecords.createdBy):', err.message);
    }
  }

  try {
    await pool.query('ALTER TABLE healthRecords ADD COLUMN details JSON NULL AFTER followUpDate');
    console.log('Migration: healthRecords.details added.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') {
      console.warn('Migration warning (healthRecords.details):', err.message);
    }
  }

  // ── Audit columns required by the generic resource controllers ──
  // RESOURCES.* declares createdBy/modifiedBy for these resources and
  // baseController writes them on create/update, but the columns were never
  // added to the tables. Every staff / activityEvaluations / phaseProgress /
  // violations write therefore failed with "Unknown column 'modifiedBy'".
  try {
    const auditColumns = {
      staff: { createdBy: 'VARCHAR(100) NULL', modifiedBy: 'VARCHAR(100) NULL' },
      activityEvaluations: { createdBy: 'VARCHAR(100) NULL', modifiedBy: 'VARCHAR(100) NULL' },
      phaseProgress: { modifiedBy: 'VARCHAR(100) NULL' },
      violations: { createdBy: 'VARCHAR(100) NULL', modifiedBy: 'VARCHAR(100) NULL' },
    };
    for (const [table, columns] of Object.entries(auditColumns)) {
      const [existing] = await pool.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
      );
      if (existing.length === 0) continue;
      const present = new Set(existing.map(column => column.COLUMN_NAME));
      for (const [column, definition] of Object.entries(columns)) {
        if (!present.has(column)) {
          await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${column} ${definition}`);
          console.log(`Migration: added ${table}.${column}.`);
        }
      }
    }
  } catch (err) {
    console.warn('Migration warning (audit columns):', err.message);
  }

  // Education module persistence tables. These are idempotent so existing
  // installations receive the tables automatically on the next server start.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS education_records (
        id VARCHAR(40) PRIMARY KEY,
        residentId VARCHAR(40) NULL,
        name VARCHAR(150) NOT NULL,
        age INT NOT NULL DEFAULT 0,
        gender ENUM('Male','Female') NOT NULL DEFAULT 'Male',
        educationLevel VARCHAR(150) NOT NULL,
        gradeSection VARCHAR(150) NULL,
        school VARCHAR(255) NOT NULL,
        enrollmentDate DATE NOT NULL,
        status ENUM('Active','Completed','Dropped') NOT NULL DEFAULT 'Active',
        address TEXT NULL,
        guardianName VARCHAR(150) NULL,
        guardianContact VARCHAR(100) NULL,
        notes TEXT NULL,
        lrn VARCHAR(100) NULL,
        traineeNumber VARCHAR(100) NULL,
        files JSON NULL,
        createdBy VARCHAR(100) NULL,
        modifiedBy VARCHAR(100) NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_education_residentId (residentId),
        INDEX idx_education_status (status),
        INDEX idx_education_level (educationLevel),
        CONSTRAINT fk_education_resident FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS education_progress_reports (
        id VARCHAR(40) PRIMARY KEY,
        educationRecordId VARCHAR(40) NOT NULL,
        residentId VARCHAR(40) NULL,
        month VARCHAR(7) NOT NULL,
        subject VARCHAR(150) NOT NULL,
        result ENUM('Passed','Failed') NOT NULL,
        academicProgress TEXT NULL,
        participation TEXT NULL,
        strengths TEXT NULL,
        areasForImprovement TEXT NULL,
        overallDevelopment TEXT NULL,
        schoolVisits INT NOT NULL DEFAULT 0,
        createdBy VARCHAR(100) NULL,
        modifiedBy VARCHAR(100) NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_education_progress_record (educationRecordId),
        INDEX idx_education_progress_resident (residentId),
        CONSTRAINT fk_education_progress_record FOREIGN KEY (educationRecordId) REFERENCES education_records(id) ON DELETE CASCADE,
        CONSTRAINT fk_education_progress_resident FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS education_school_visits (
        id VARCHAR(40) PRIMARY KEY,
        educationRecordId VARCHAR(40) NOT NULL,
        residentId VARCHAR(40) NULL,
        visitDate DATE NOT NULL,
        school VARCHAR(255) NOT NULL,
        purpose TEXT NULL,
        findings TEXT NULL,
        fileName VARCHAR(255) NULL,
        fileData LONGTEXT NULL,
        createdBy VARCHAR(100) NULL,
        modifiedBy VARCHAR(100) NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_education_visit_record (educationRecordId),
        INDEX idx_education_visit_resident (residentId),
        CONSTRAINT fk_education_visit_record FOREIGN KEY (educationRecordId) REFERENCES education_records(id) ON DELETE CASCADE,
        CONSTRAINT fk_education_visit_resident FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS education_monthly_reports (
        id VARCHAR(40) PRIMARY KEY,
        educationRecordId VARCHAR(40) NOT NULL,
        residentId VARCHAR(40) NULL,
        reportMonth VARCHAR(7) NOT NULL,
        reportData JSON NOT NULL,
        status ENUM('Draft','Submitted','Approved','Rejected') NOT NULL DEFAULT 'Draft',
        submittedBy VARCHAR(100) NULL,
        submittedAt DATETIME NULL,
        reviewedBy VARCHAR(100) NULL,
        reviewedAt DATETIME NULL,
        createdBy VARCHAR(100) NULL,
        modifiedBy VARCHAR(100) NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_education_monthly_record (educationRecordId),
        INDEX idx_education_monthly_resident (residentId),
        INDEX idx_education_monthly_period (reportMonth),
        CONSTRAINT fk_education_monthly_record FOREIGN KEY (educationRecordId) REFERENCES education_records(id) ON DELETE CASCADE,
        CONSTRAINT fk_education_monthly_resident FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Migration: Education module tables ensured.');
  } catch (err) {
    console.warn('Migration warning (Education module):', err.message);
  }

  // ── Quarterly Progress Report ──
  // Created here rather than only in schema.sql so an already-provisioned
  // database picks the module up on the next boot without a manual migration.
  // Each statement is guarded separately: the two tables are independent, and a
  // problem with one must not leave the other uncreated.
  //
  // NOTE ON THE PERIOD: this report is deliberately NOT keyed to a calendar
  // quarter. The official form the facility uses runs a three-month window that
  // begins in June (the sample reads "JUNE-AUGUST 2024"), so the period is
  // stored as an explicit start/end date pair. That keeps the picker honest for
  // any window the facility chooses later without a schema change.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quarterlyProgressReports (
        id VARCHAR(40) PRIMARY KEY,
        residentId VARCHAR(40) NOT NULL,
        periodStart DATE NOT NULL,
        periodEnd DATE NOT NULL,
        periodLabel VARCHAR(60) NULL,
        identifyingInformation JSON NULL,
        status ENUM('Draft','Submitted','Under Review','Returned','Finalized') NOT NULL DEFAULT 'Draft',
        preparedByName VARCHAR(150) NULL,
        preparedBySignature LONGTEXT NULL,
        attestedByName VARCHAR(150) NULL,
        attestedBySignature LONGTEXT NULL,
        notedByName VARCHAR(150) NULL,
        notedBySignature LONGTEXT NULL,
        createdBy VARCHAR(100) NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedBy VARCHAR(100) NULL,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        submittedBy VARCHAR(100) NULL,
        submittedAt DATETIME NULL,
        reviewedBy VARCHAR(100) NULL,
        reviewedAt DATETIME NULL,
        finalizedBy VARCHAR(100) NULL,
        finalizedAt DATETIME NULL,
        reviewNotes TEXT NULL,
        UNIQUE KEY uq_quarterly_progress_period (residentId, periodStart),
        INDEX idx_quarterly_progress_resident (residentId),
        INDEX idx_quarterly_progress_period (periodStart, periodEnd),
        INDEX idx_quarterly_progress_status (status),
        CONSTRAINT fk_quarterly_progress_resident FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Migration: quarterlyProgressReports table ensured.');
  } catch (err) {
    console.warn('Migration warning (quarterlyProgressReports):', err.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quarterlyProgressReportSections (
        id VARCHAR(40) PRIMARY KEY,
        reportId VARCHAR(40) NOT NULL,
        aspectKey VARCHAR(40) NOT NULL,
        aspectLabel VARCHAR(100) NOT NULL,
        sortOrder TINYINT NOT NULL DEFAULT 0,
        assignedTo VARCHAR(40) NULL,
        assignedToName VARCHAR(150) NULL,
        assignedToRole VARCHAR(50) NULL,
        assembledPresentLevel TEXT NULL,
        assembledObservations TEXT NULL,
        assembledInterventions TEXT NULL,
        presentLevel TEXT NULL,
        observations TEXT NULL,
        interventions TEXT NULL,
        status ENUM('Not Started','In Progress','Submitted','Returned') NOT NULL DEFAULT 'Not Started',
        signedByName VARCHAR(150) NULL,
        signature LONGTEXT NULL,
        returnedReason TEXT NULL,
        submittedBy VARCHAR(100) NULL,
        submittedAt DATETIME NULL,
        createdBy VARCHAR(100) NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedBy VARCHAR(100) NULL,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_quarterly_progress_section (reportId, aspectKey),
        INDEX idx_quarterly_progress_section_report (reportId),
        INDEX idx_quarterly_progress_section_assignee (assignedTo),
        CONSTRAINT fk_quarterly_progress_section_report FOREIGN KEY (reportId) REFERENCES quarterlyProgressReports(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Migration: quarterlyProgressReportSections table ensured.');
  } catch (err) {
    console.warn('Migration warning (quarterlyProgressReportSections):', err.message);
  }

  // The two tables belonging to the superseded standalone Quarterly Reports
  // module. They had exactly one consumer — the controller deleted when the
  // feature moved into the Reports module — so nothing reads them any more and
  // they would otherwise sit in the database as dead weight. Sections first,
  // because of the foreign key.
  try {
    await pool.query('DROP TABLE IF EXISTS quarterlyReportSections');
    await pool.query('DROP TABLE IF EXISTS quarterlyReports');
    console.log('Migration: superseded quarterlyReports/quarterlyReportSections tables dropped.');
  } catch (err) {
    console.warn('Migration warning (drop superseded quarterly tables):', err.message);
  }

  // Links a Documents-module entry back to the Quarterly Progress Report it
  // mirrors. Finalizing a report publishes the combined PDF into the resident's
  // folder; the unique index is what makes a re-publish update that same entry
  // instead of leaving two copies of the same period.
  await ensureColumn('documents', 'quarterlyReportId', 'VARCHAR(40) NULL', 'residentId');
  await ensureUniqueIndex('documents', 'uq_documents_quarterly_report', 'quarterlyReportId');

  // Links a Documents-module entry back to the Health Record it mirrors. Saving
  // a health record publishes its PDF into the resident's Medical Records folder;
  // the link is what makes that idempotent, so editing a record updates the same
  // entry rather than leaving a second copy of it in the child's folder. Before
  // this, a nurse's health records existed only in the Health module and never
  // reached the Documents module at all.
  await ensureColumn('documents', 'healthRecordId', 'VARCHAR(40) NULL', 'residentId');
  await ensureUniqueIndex('documents', 'uq_documents_health_record', 'healthRecordId');
}

// Start server
async function startServer() {
  try {
    // ── Fail fast on an unusable JWT signing secret ──
    // A missing or publicly-known secret lets anyone mint a token for any role,
    // so the process must refuse to start rather than fall back to a default.
    const { assessJwtSecret } = require('./utils/security');
    const secretCheck = assessJwtSecret(process.env.JWT_SECRET);
    if (!secretCheck.ok) {
      console.error(`❌ ${secretCheck.reason}`);
      console.error('   Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
      console.error('   Then set JWT_SECRET in backend/.env and restart.');
      process.exit(1);
    }

    // Test database connection
    await testConnection();

    // Run schema migrations
    await runMigrations();

    // ── Fail fast on a missing Anecdotal Report template ──
    // Accepted Anecdotal Reports are published as the official form with the
    // filled-up entries overlaid on it, so the template is a hard dependency of
    // the Documents module. Report it at boot rather than at the first accept.
    const { resolveTemplatePath } = require('./utils/anecdotalReportPdf');
    const anecdotalTemplate = resolveTemplatePath();
    if (anecdotalTemplate) {
      console.log(`Anecdotal Report template: ${anecdotalTemplate}`);
    } else {
      console.error('❌ The official Anecdotal Report template could not be found.');
      console.error('   Expected at frontend/public/forms/Anecdotal Report.pdf');
      console.error('   Accepted Anecdotal Reports cannot be published until it is restored.');
    }

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
