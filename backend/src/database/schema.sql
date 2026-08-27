CREATE DATABASE IF NOT EXISTS sch_path_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE sch_path_db;

SET FOREIGN_KEY_CHECKS = 0;
DROP VIEW IF EXISTS resident_summary;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS phaseProgress;
DROP TABLE IF EXISTS courtRecords;
DROP TABLE IF EXISTS alerts;
DROP TABLE IF EXISTS violations;
DROP TABLE IF EXISTS activityEvaluations;
DROP TABLE IF EXISTS healthRecords;
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS assessments;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS staff;
DROP TABLE IF EXISTS children;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS accessRequests;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE users (
  id VARCHAR(40) PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,
  accessibleModules JSON NOT NULL,
  childRecordTabs JSON NULL,
  status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
  createdDate DATE NOT NULL,
  createdBy VARCHAR(100) NULL,
  modifiedBy VARCHAR(100) NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE accessRequests (
  id VARCHAR(40) PRIMARY KEY,
  requesterId VARCHAR(40) NOT NULL,
  requesterUsername VARCHAR(100) NOT NULL,
  targetUserId VARCHAR(40) NULL,
  targetRole VARCHAR(50) NULL,
  residentId VARCHAR(40) NULL,
  moduleName VARCHAR(100) NULL,
  recordTab VARCHAR(100) NULL,
  reason TEXT NOT NULL,
  status ENUM('Pending', 'Approved', 'Rejected') NOT NULL DEFAULT 'Pending',
  reviewedBy VARCHAR(100) NULL,
  reviewedAt TIMESTAMP NULL,
  reviewerNote TEXT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_access_requesterId (requesterId),
  INDEX idx_access_status (status),
  INDEX idx_access_targetRole (targetRole)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE children (
  id VARCHAR(40) PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  age INT NOT NULL DEFAULT 0,
  gender ENUM('Male', 'Female') NOT NULL,
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE staff (
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
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE activities (
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
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE assessments (
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
  createdBy VARCHAR(100) NULL,
  modifiedBy VARCHAR(100) NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reports (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE healthRecords (
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
  modifiedBy VARCHAR(100) NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE activityEvaluations (
  id VARCHAR(80) PRIMARY KEY,
  activityId VARCHAR(40) NULL,
  residentId VARCHAR(40) NULL,
  residentName VARCHAR(150) NULL,
  rating INT NOT NULL,
  remarks TEXT NULL,
  dateEvaluated DATETIME NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE violations (
  id VARCHAR(40) PRIMARY KEY,
  residentId VARCHAR(40) NOT NULL,
  date DATE NOT NULL,
  type VARCHAR(100) NOT NULL,
  description TEXT NULL,
  severity ENUM('Minor', 'Major', 'Critical') NOT NULL DEFAULT 'Minor',
  points INT NOT NULL DEFAULT 1,
  location VARCHAR(150) NULL,
  witnesses VARCHAR(255) NULL,
  reportedBy VARCHAR(100) NULL,
  reviewedBy VARCHAR(100) NULL,
  actionTaken TEXT NULL,
  status ENUM('Pending Review', 'Under Investigation', 'Reviewed', 'Resolved', 'Escalated') NOT NULL DEFAULT 'Pending Review',
  requiresAssessment BOOLEAN NOT NULL DEFAULT TRUE,
  assessmentTriggered BOOLEAN NOT NULL DEFAULT FALSE,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_residentId (residentId),
  INDEX idx_status (status),
  INDEX idx_date (date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE alerts (
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
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_residentId (residentId),
  INDEX idx_isRead (isRead),
  INDEX idx_priority (priority),
  INDEX idx_type (type),
  INDEX idx_targetRole (targetRole)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE courtRecords (
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
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_residentId (residentId),
  INDEX idx_hearingDate (hearingDate),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE phaseProgress (
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
  INDEX idx_residentId (residentId),
  INDEX idx_isCurrent (isCurrent),
  INDEX idx_advancementBlocked (advancementBlocked)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE documents (
  id VARCHAR(40) PRIMARY KEY,
  residentId VARCHAR(40) NULL,
  residentName VARCHAR(150) NULL,
  staffId VARCHAR(40) NULL,
  title VARCHAR(150) NOT NULL,
  type VARCHAR(100) NULL,
  category VARCHAR(100) NULL,
  description TEXT NULL,
  fileName VARCHAR(255) NULL,
  fileSize INT NULL,
  filePath VARCHAR(500) NULL,
  fileData LONGTEXT NULL,
  fileType VARCHAR(100) NULL,
  uploaderRole VARCHAR(100) NULL,
  status ENUM('Draft', 'Submitted', 'Under Review', 'Approved', 'Rejected', 'Archived') NOT NULL DEFAULT 'Draft',
  submittedBy VARCHAR(100) NULL,
  submittedAt TIMESTAMP NULL,
  uploadedBy VARCHAR(100) NULL,
  uploadedAt TIMESTAMP NULL,
  reviewedBy VARCHAR(100) NULL,
  reviewedAt TIMESTAMP NULL,
  approvedBy VARCHAR(100) NULL,
  approvedAt TIMESTAMP NULL,
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO users (id, username, password, role, accessibleModules, status, createdDate)
VALUES ('U001', 'centerhead', '$2b$10$scQCtHY9EHXFG6J6Kct7RuTnx2vXvul2s.cOO6snvb8fKI47h82aO', 'centerhead', JSON_ARRAY('Dashboard', 'Child Records', 'Activities', 'Assessments', 'Health', 'Reports', 'Account Management', 'Violations', 'Court Records', 'Documents', 'Social Worker'), 'Active', '2025-01-01');
