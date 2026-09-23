import mysql from 'mysql2/promise';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const pool = await mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const q = (sql, params = []) => pool.query(sql, params);

try {
  // 1) Repair the generic controller's Education backing tables if the
  // database was created from an older schema.
  await q(`
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
      CONSTRAINT fk_education_resident_repair FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await q(`
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
      CONSTRAINT fk_education_progress_record_repair FOREIGN KEY (educationRecordId) REFERENCES education_records(id) ON DELETE CASCADE,
      CONSTRAINT fk_education_progress_resident_repair FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await q(`
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
      CONSTRAINT fk_education_visit_record_repair FOREIGN KEY (educationRecordId) REFERENCES education_records(id) ON DELETE CASCADE,
      CONSTRAINT fk_education_visit_resident_repair FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await q(`
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
      CONSTRAINT fk_education_monthly_record_repair FOREIGN KEY (educationRecordId) REFERENCES education_records(id) ON DELETE CASCADE,
      CONSTRAINT fk_education_monthly_resident_repair FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 2) intervention_requirements is a live table used by violation,
  // assessment, and intervention-tracker workflows, so it belongs in the
  // canonical schema rather than only being created ad hoc by server startup.
  await q(`
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

  // 3) Remove the obsolete placeholder intervention type. Do not delete live
  // tables: the current application actively references all canonical tables.
  await q(`DELETE FROM intervention_types WHERE type = 'Guide Requirement'`);

  // 4) Report any tables that exist in this database but are not part of the
  // current application's canonical schema. We report rather than auto-drop so
  // an unrelated/custom table can never be destroyed accidentally.
  const canonical = new Set([
    'users','accessRequests','childIdSequence','children','admissions',
    'residentPerformanceRatings','staff','activities','assessments','reports',
    'healthRecords','activityEvaluations','violations','incidentReports','alerts',
    'alertReads','courtRecords','phaseProgress','documents','education_records',
    'education_progress_reports','education_school_visits','education_monthly_reports',
    'violation_guide','intervention_types','guide_interventions','intervention_tracker',
    'intervention_requirements','residentAssignments','triRecords','anecdotalReports'
  ]);
  const [rows] = await q(
    `SELECT TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
  );
  const extras = rows.map(r => r.tableName).filter(name => !canonical.has(name));
  console.log('Schema repair complete.');
  console.log(`Unexpected/non-canonical tables found: ${extras.length ? extras.join(', ') : 'none'}`);
  if (extras.length) {
    console.log('No tables were auto-dropped. Review these names before removing them.');
  }
} finally {
  await pool.end();
}
