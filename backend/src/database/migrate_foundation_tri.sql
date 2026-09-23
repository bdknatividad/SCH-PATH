-- Additive SCH-PATH foundation + TRI migration.
-- Safe for existing data: no tables or records are dropped.

ALTER TABLE staff ADD COLUMN userId VARCHAR(40) NULL;

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
  INDEX idx_assignment_user_status (userId, status),
  INDEX idx_assignment_type (assignmentType)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS triRecords (
  id VARCHAR(40) PRIMARY KEY,
  residentId VARCHAR(40) NOT NULL,
  caseCycleKey VARCHAR(100) NULL,
  formVersion VARCHAR(30) NOT NULL DEFAULT 'TRI-2025-PDF',
  reportingYear SMALLINT NOT NULL,
  reportingMonth TINYINT NOT NULL,
  status ENUM('Draft', 'Submitted', 'Under Review', 'Returned', 'Finalized') NOT NULL DEFAULT 'Draft',
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
  createdBy VARCHAR(100) NULL,
  updatedBy VARCHAR(100) NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tri_resident_period (residentId, reportingYear, reportingMonth),
  INDEX idx_tri_period_status (reportingYear, reportingMonth, status),
  INDEX idx_tri_rating (rating),
  INDEX idx_tri_effectiveDate (effectiveDate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
