CREATE DATABASE IF NOT EXISTS sch_path_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE sch_path_db;

SET FOREIGN_KEY_CHECKS = 0;
DROP VIEW IF EXISTS resident_summary;
DROP TABLE IF EXISTS admissions;
DROP TABLE IF EXISTS documentRevisions;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS incidentReports;
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
DROP TABLE IF EXISTS residentPerformanceRatings;
DROP TABLE IF EXISTS education_monthly_reports;
DROP TABLE IF EXISTS education_school_visits;
DROP TABLE IF EXISTS education_progress_reports;
DROP TABLE IF EXISTS education_records;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE users (
  id VARCHAR(40) PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  displayName VARCHAR(150) NULL,
  fullName VARCHAR(150) NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,
  accessibleModules JSON NOT NULL,
  childRecordTabs JSON NULL,
  subModules JSON NULL,
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
  requesterRole VARCHAR(50) NULL,
  targetUserId VARCHAR(40) NULL,
  targetRole VARCHAR(50) NULL,
  documentId VARCHAR(40) NULL,
  residentId VARCHAR(40) NULL,
  moduleName VARCHAR(100) NULL,
  recordTab VARCHAR(100) NULL,
  reason TEXT NOT NULL,
  status ENUM('Pending', 'Approved', 'Rejected') NOT NULL DEFAULT 'Pending',
  reviewedBy VARCHAR(100) NULL,

  -- Who decided the request, as a stable users.id, beside the printed username.
  -- The history is scoped by this, so renaming an account cannot empty its own
  -- audit trail.
  reviewedById VARCHAR(40) NULL,

  reviewedAt TIMESTAMP NULL,
  reviewerNote TEXT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_access_requesterId (requesterId),
  INDEX idx_access_status (status),
  INDEX idx_access_targetRole (targetRole),
  INDEX idx_access_documentId (documentId),
  INDEX idx_access_reviewedById (reviewedById)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE childIdSequence (
  id TINYINT PRIMARY KEY,
  nextNumber INT NOT NULL
) ENGINE=InnoDB;

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


CREATE TABLE admissions (
  id VARCHAR(40) PRIMARY KEY,
  residentId VARCHAR(40) NOT NULL,

  admissionNumber INT NOT NULL,

  admissionDate DATE NOT NULL,

  name VARCHAR(150) NOT NULL,
  age INT NOT NULL,
  sex ENUM('Male', 'Female') NOT NULL,
  birthDate DATE NOT NULL,
  religion VARCHAR(100) NOT NULL,
  address TEXT NOT NULL,

  residentSignature LONGTEXT NULL,
  residentImage LONGTEXT NULL,

  guardianName VARCHAR(150) NULL,
  guardianContact VARCHAR(100) NULL,
  guardianAddress TEXT NULL,
  guardianSignature LONGTEXT NULL,

  referringParty VARCHAR(150) NOT NULL,
  referringPartyContact VARCHAR(100) NOT NULL,
  referringPartySignature LONGTEXT NULL,

  houseparentOnDuty VARCHAR(150) NOT NULL,

  -- The Houseparent on duty as a stable users.id, alongside the printed name.
  -- The name is what the official slip shows; this is what links the resident to
  -- a caseload, so renaming a member of staff does not move their residents.
  houseparentUserId VARCHAR(50) NULL,

  houseparentSignature LONGTEXT NULL,

  legalCategory VARCHAR(150) NOT NULL,
  specificOffense TEXT NOT NULL,
  caseHistory TEXT NOT NULL,

  admissionStatus VARCHAR(40) NULL,

  expectedDischargeDate DATE NULL,
  status ENUM('Active', 'Closed') NOT NULL DEFAULT 'Active',
  closedDate DATE NULL,

  createdBy VARCHAR(100) NULL,
  modifiedBy VARCHAR(100) NULL,

  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (residentId) REFERENCES children(id)
    ON DELETE CASCADE,

  UNIQUE KEY uq_resident_admission_number (residentId, admissionNumber),
  INDEX idx_admissions_residentId (residentId),
  INDEX idx_admissions_status (status),
  INDEX idx_admissions_admissionDate (admissionDate)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

CREATE TABLE residentPerformanceRatings (
  residentId VARCHAR(40) NOT NULL,
  ratingYear SMALLINT NOT NULL,
  ratingMonth TINYINT NOT NULL,
  rating VARCHAR(30) NOT NULL,
  points INT NOT NULL DEFAULT 0,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (residentId, ratingYear, ratingMonth),
  INDEX idx_performance_period (ratingYear, ratingMonth)
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
  userId VARCHAR(40) NULL,
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
  title VARCHAR(300) NOT NULL,
  date DATE NULL,
  time VARCHAR(50) NULL,
  type VARCHAR(255) NULL,
  psychosocialActivities JSON NULL,
  assessor VARCHAR(150) NULL,
  status ENUM('Scheduled', 'Completed') NOT NULL DEFAULT 'Scheduled',
  forResidents JSON NULL,
  description TEXT NULL,
  results TEXT NULL,
  triggeredBy VARCHAR(600) NULL,
  violationIds JSON NULL,
  interventionTrackerId VARCHAR(40) NULL,
  interventionRequirementId VARCHAR(40) NULL,
  schedulingMode VARCHAR(30) NULL,
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
  details JSON NULL,
  createdBy VARCHAR(100) NULL,
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
  type VARCHAR(500) NOT NULL,
  description TEXT NULL,
  severity ENUM('Minor', 'Major', 'Critical') NOT NULL DEFAULT 'Minor',
  points INT NOT NULL DEFAULT 1,
  location VARCHAR(150) NULL,
  bodyLocation VARCHAR(100) NULL,
  witnesses VARCHAR(255) NULL,
  reportedBy VARCHAR(100) NULL,
  reviewedBy VARCHAR(100) NULL,
  actionTaken TEXT NULL,
  status ENUM('Pending Review', 'Under Investigation', 'Reviewed', 'Resolved', 'Escalated', 'Rejected') NOT NULL DEFAULT 'Pending Review',
  requiresAssessment BOOLEAN NOT NULL DEFAULT TRUE,
  assessmentTriggered BOOLEAN NOT NULL DEFAULT FALSE,
  offenseNumber VARCHAR(20) NULL,
  interventionStartDate DATE NULL,
  interventionMonth VARCHAR(7) NULL,
  clearedBy VARCHAR(100) NULL,
  clearedAt DATETIME NULL,
  incidentGroupId VARCHAR(60) NULL,
  guideId VARCHAR(40) NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_residentId (residentId),
  INDEX idx_status (status),
  INDEX idx_date (date),
  INDEX idx_violations_guideId (guideId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE incidentReports (
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
  reportedBySignature LONGTEXT NULL,
  endorsedToSignature LONGTEXT NULL,
  checkedBySignature LONGTEXT NULL,
  notedBySignature LONGTEXT NULL,
  status ENUM('Submitted', 'Pending Review', 'Verified', 'Failed', 'Reassessment') NOT NULL DEFAULT 'Submitted',
  interventionType VARCHAR(100) NULL,
  interventionScheduleDate DATETIME NULL,
  -- Form 08 needs two verifications, not one: the Psychological Staff signs the
  -- clinical side and the Social Worker counter-signs. `status` only becomes
  -- 'Verified' when both are present, and `verifiedBy`/`verifiedAt` then record
  -- whichever signature completed the pair.
  verifiedBy VARCHAR(100) NULL,
  verifiedAt DATETIME NULL,
  psychVerifiedBy VARCHAR(100) NULL,
  psychVerifiedAt DATETIME NULL,
  swVerifiedBy VARCHAR(100) NULL,
  swVerifiedAt DATETIME NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (violationId) REFERENCES violations(id) ON DELETE CASCADE,
  INDEX idx_incidentReports_residentId (residentId),
  INDEX idx_incidentReports_violationId (violationId),
  INDEX idx_incidentReports_status (status)
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
  -- Direct targeting. `targetRole` addresses a whole role; this addresses one
  -- account. Used where the recipient is a specific person rather than a job
  -- title: the assigned Houseparent, the submitter of a report, the requester.
  targetUserId VARCHAR(40) NULL,
  -- Who caused the event, so the UI can say "approved by <name>" and so a
  -- notification is never silently addressed back to its own author.
  actorUsername VARCHAR(100) NULL,
  -- One business event = one row. The caller supplies a stable key
  -- ("anecdotal:ANR004:returned"); a unique index makes a retried request a
  -- no-op instead of a second notification.
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-user read state.
--
-- `alerts.isRead` is a single flag on the row, so one recipient marking a
-- role-addressed alert as read marked it read for every other recipient of that
-- role. Read state belongs to (alert, user), not to the alert.
--
-- `alerts.isRead/readBy/readAt` are kept in sync for the single-recipient case
-- so existing consumers and exports do not break, but this table is the source
-- of truth for what the UI shows.
CREATE TABLE alertReads (
  alertId VARCHAR(40) NOT NULL,
  userId VARCHAR(40) NOT NULL,
  readAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (alertId, userId),
  INDEX idx_alertReads_userId (userId)
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
  -- The admission this document was produced under. Documents are filed
  -- Resident -> Admission -> Category -> File, so a returning resident's earlier
  -- and current files never mix. Set from the resident's active admission on
  -- every create path; see src/services/admissionLink.js.
  admissionId VARCHAR(40) NULL,
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- The Documents module's permanent audit trail.
--
-- One row per workflow transition, never updated and never deleted while the
-- document exists. This is what makes a rejection note permanent: `documents`
-- holds only the CURRENT decision, so resubmitting a rejected document used to
-- overwrite `rejectionReason` with NULL and the reviewer's note was gone. Here
-- the note survives every later revision, alongside who submitted, who reviewed
-- and when.
--
-- `revision` is the submission round the transition belongs to: uploading and
-- the first submission are revision 1, and every resubmission increments it.
-- `snapshot` keeps the document's own fields at that moment, so an earlier
-- version of a corrected document can be read back.
CREATE TABLE documentRevisions (
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
  INDEX idx_document_revisions (documentId, revision, createdAt),
  CONSTRAINT fk_document_revisions_document FOREIGN KEY (documentId) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


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

-- ─── Violation & Intervention Guide Tables ─────────────────────────────────

CREATE TABLE violation_guide (
  id VARCHAR(40) PRIMARY KEY,
  name VARCHAR(500) NOT NULL,
  category ENUM('Minor', 'Major') NOT NULL DEFAULT 'Minor',
  description TEXT NULL,
  status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
  createdBy VARCHAR(100) NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updatedBy VARCHAR(100) NULL,
  INDEX idx_status (status),
  INDEX idx_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE intervention_types (
  id VARCHAR(40) PRIMARY KEY,
  type VARCHAR(100) NOT NULL UNIQUE,
  description TEXT NULL,
  requiresDuration BOOLEAN NOT NULL DEFAULT TRUE,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE guide_interventions (
  id VARCHAR(40) PRIMARY KEY,
  guideId VARCHAR(40) NOT NULL,
  offenseLevel VARCHAR(50) NOT NULL,
  interventionType VARCHAR(100) NOT NULL,
  duration INT NULL,
  unit VARCHAR(50) NULL,
  metadata JSON NULL,
  status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (guideId) REFERENCES violation_guide(id) ON DELETE CASCADE,
  INDEX idx_guideId (guideId),
  INDEX idx_offenseLevel (offenseLevel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE intervention_tracker (
  id VARCHAR(40) PRIMARY KEY,
  residentId VARCHAR(40) NOT NULL,
  violationId VARCHAR(40) NOT NULL,
  guideId VARCHAR(40) NOT NULL,
  guideInterventionId VARCHAR(40) NOT NULL,
  offenseLevel VARCHAR(50) NOT NULL,
  interventionType VARCHAR(100) NOT NULL,
  duration INT NULL,
  unit VARCHAR(50) NULL,
  metadata JSON NULL,
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
  FOREIGN KEY (guideInterventionId) REFERENCES guide_interventions(id) ON DELETE RESTRICT,
  INDEX idx_residentId (residentId),
  INDEX idx_status (status),
  INDEX idx_violationId (violationId),
  UNIQUE KEY uq_tracker_violation_guide_intervention (violationId, guideInterventionId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE residentAssignments (
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

CREATE TABLE triRecords (
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
  -- The Houseparent's drawn signature (PNG data URL). The official TRI carries a
  -- "Houseparent" signature line on its last page; this is what gets stamped onto
  -- it when the record is exported. NULL means the line stays blank.
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Remove legacy placeholder type if this schema is applied to an existing database
DELETE FROM intervention_types WHERE type = 'Guide Requirement';

-- Insert default intervention types
INSERT INTO intervention_types (id, type, description, requiresDuration) VALUES
('IT002', 'Psychosocial Activity', 'Psychosocial activity required by the official SCH intervention guide', FALSE),
('IT003', 'Privilege Restriction', 'Restriction of a specific privilege described by the guide', TRUE),
('IT004', 'Privilege Suspension', 'Suspension of privileges described by the guide', TRUE),
('IT005', 'Household Chores', 'Household chore requirement described by the guide', TRUE),
('IT006', 'Cleaning', 'Cleaning requirement described by the guide', TRUE),
('IT007', 'Confiscation', 'Confiscation or safekeeping requirement', FALSE),
('IT008', 'Other', 'Other exact requirement from the official guide', FALSE),
      ('IT009', 'Isolation', 'Isolation requirement described by the official guide', TRUE)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  requiresDuration = VALUES(requiresDuration);

INSERT INTO users (id, username, password, role, accessibleModules, status, createdDate)
VALUES ('U001', 'centerhead', '$2b$10$scQCtHY9EHXFG6J6Kct7RuTnx2vXvul2s.cOO6snvb8fKI47h82aO', 'centerhead', JSON_ARRAY('Dashboard', 'Child Records', 'Activities', 'Assessments', 'Health', 'Reports', 'Account Management', 'Violations', 'Court Records', 'Documents', 'Social Worker'), 'Active', '2025-01-01');


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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Quarterly Progress Report (QPR)
--
-- One report per resident per reporting period, split into one row per
-- Developmental Aspect so a different staff member can be assigned to each
-- aspect and can only see and edit their own. Reviewers (Social Worker / Center
-- Head) own the whole report and are the only ones who can approve and finalize
-- it.
--
-- THE PERIOD IS NOT A CALENDAR QUARTER. The official form the facility uses
-- covers a three-month window that begins in June — the sample reads
-- "(JUNE-AUGUST 2024)" — so the period is stored as an explicit start/end date
-- pair rather than a `quarter` number. That keeps any window expressible without
-- a schema change.
--
-- `identifyingInformation` is a JSON snapshot of the resident's details taken
-- from `children` / `admissions` / `education_records`. It is captured rather
-- than joined live so that a finalized report keeps the identifying data it was
-- approved with, even if the resident's record is edited afterwards. Each entry
-- records where its value came from, so a reviewer can tell an empty field apart
-- from one the system could not find a source for.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quarterlyProgressReports (
  id VARCHAR(40) PRIMARY KEY,
  residentId VARCHAR(40) NOT NULL,
  periodStart DATE NOT NULL,
  periodEnd DATE NOT NULL,
  periodLabel VARCHAR(60) NULL,
  identifyingInformation JSON NULL,
  narrative TEXT NULL,
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per Developmental Aspect. The `assembled*` columns hold the evidence
-- the system gathered from the period's existing records at the moment the
-- report was opened; the plain `presentLevel` / `observations` /
-- `interventions` columns hold what the assigned staff member curated from it.
-- Keeping both is what makes the draft a snapshot: a later incident report or
-- activity cannot silently rewrite an aspect somebody has already edited, and a
-- reviewer can still see what the system proposed against what was submitted.
CREATE TABLE IF NOT EXISTS quarterlyProgressReportSections (
  id VARCHAR(40) PRIMARY KEY,
  reportId VARCHAR(40) NOT NULL,
  aspectKey VARCHAR(40) NOT NULL,
  aspectLabel VARCHAR(100) NOT NULL,
  sortOrder TINYINT NOT NULL DEFAULT 0,
  -- No foreign key on `assignedTo`, matching residentAssignments.userId: an
  -- account that is deactivated or removed must not block a report from being
  -- opened, and the section's own content is the record that matters.
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
