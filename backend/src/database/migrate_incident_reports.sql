-- Migration: Digital Incident Report (Form 08)
-- Run this once in phpMyAdmin's SQL tab against sch_path_db.
-- Safe to re-run: uses CREATE TABLE IF NOT EXISTS.

USE sch_path_db;

CREATE TABLE IF NOT EXISTS incidentReports (
  id VARCHAR(40) PRIMARY KEY,
  violationId VARCHAR(40) NOT NULL,
  residentId VARCHAR(40) NOT NULL,
  interventionTrackerId VARCHAR(40) NULL,
  pdfDocumentId VARCHAR(40) NULL,

  -- "Type of Report" checkboxes from Form 08, stored as a JSON array of labels
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

  -- Set by the Psychologist during verification (Phase 2 of this feature)
  status ENUM('Submitted', 'Pending Review', 'Verified', 'Failed', 'Reassessment') NOT NULL DEFAULT 'Submitted',
  interventionType VARCHAR(100) NULL,
  interventionScheduleDate DATE NULL,
  verifiedBy VARCHAR(100) NULL,
  verifiedAt DATETIME NULL,

  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (violationId) REFERENCES violations(id) ON DELETE CASCADE,
  INDEX idx_residentId (residentId),
  INDEX idx_violationId (violationId),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Link Form 08 to the completed intervention that unlocked it.
ALTER TABLE incidentReports ADD COLUMN interventionTrackerId VARCHAR(40) NULL AFTER residentId;

ALTER TABLE incidentReports MODIFY COLUMN status ENUM('Submitted', 'Pending Review', 'Verified', 'Failed', 'Reassessment') NOT NULL DEFAULT 'Submitted';

ALTER TABLE incidentReports ADD COLUMN pdfDocumentId VARCHAR(40) NULL AFTER interventionTrackerId;
