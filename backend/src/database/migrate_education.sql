USE sch_path_db;

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
  archivedAt DATETIME NULL,
  archivedBy VARCHAR(100) NULL,
  createdBy VARCHAR(100) NULL,
  modifiedBy VARCHAR(100) NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_education_residentId (residentId),
  INDEX idx_education_status (status),
  INDEX idx_education_level (educationLevel),
  CONSTRAINT fk_education_resident FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS education_school_visits (
  id VARCHAR(40) PRIMARY KEY,
  educationRecordId VARCHAR(40) NOT NULL,
  residentId VARCHAR(40) NULL,
  visitDate DATE NOT NULL,
  school VARCHAR(255) NOT NULL,
  purpose TEXT NULL,
  findings TEXT NULL,
  status ENUM('Scheduled','Completed') NOT NULL DEFAULT 'Completed',
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Subjects, defined by the Educator per education level, and each learner's
-- Pass / Fail result in them. A cleared result is a deleted row, so `result`
-- is never NULL; one row per learner per subject (uq_education_subject_result).
CREATE TABLE IF NOT EXISTS education_subjects (
  id VARCHAR(40) PRIMARY KEY,
  educationLevel VARCHAR(150) NOT NULL,
  name VARCHAR(150) NOT NULL,
  sortOrder INT NOT NULL DEFAULT 0,
  createdBy VARCHAR(100) NULL,
  modifiedBy VARCHAR(100) NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_education_subject_level_name (educationLevel, name),
  INDEX idx_education_subject_level (educationLevel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS education_subject_results (
  id VARCHAR(40) PRIMARY KEY,
  educationRecordId VARCHAR(40) NOT NULL,
  residentId VARCHAR(40) NULL,
  subjectId VARCHAR(40) NOT NULL,
  result ENUM('Passed','Failed') NULL,
  progressStatus VARCHAR(20) NULL,
  outputsSubmitted INT NULL,
  outputsTotal INT NULL,
  createdBy VARCHAR(100) NULL,
  modifiedBy VARCHAR(100) NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_education_subject_result (educationRecordId, subjectId),
  INDEX idx_education_subject_result_resident (residentId),
  INDEX idx_education_subject_result_subject (subjectId),
  CONSTRAINT fk_education_subject_result_record FOREIGN KEY (educationRecordId) REFERENCES education_records(id) ON DELETE CASCADE,
  CONSTRAINT fk_education_subject_result_subject FOREIGN KEY (subjectId) REFERENCES education_subjects(id) ON DELETE CASCADE,
  CONSTRAINT fk_education_subject_result_resident FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Education Progress Monitoring: one record per learner (replaces Pass / Fail).
CREATE TABLE IF NOT EXISTS education_progress_monitoring (
  id VARCHAR(40) PRIMARY KEY,
  educationRecordId VARCHAR(40) NOT NULL,
  residentId VARCHAR(40) NULL,
  admissionId VARCHAR(40) NULL,
  monitoringDate DATE NULL,
  modulesCompleted TEXT NULL,
  modulesPending TEXT NULL,
  outputsSubmitted TEXT NULL,
  outputsNotSubmitted TEXT NULL,
  participationNotes TEXT NULL,
  concerns TEXT NULL,
  createdBy VARCHAR(100) NULL,
  modifiedBy VARCHAR(100) NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_education_progress_monitoring_record (educationRecordId),
  INDEX idx_education_progress_monitoring_resident (residentId),
  CONSTRAINT fk_education_progress_monitoring_record FOREIGN KEY (educationRecordId) REFERENCES education_records(id) ON DELETE CASCADE,
  CONSTRAINT fk_education_progress_monitoring_resident FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
