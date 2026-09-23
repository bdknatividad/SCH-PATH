-- Reassessment / failed Incident Report workflow
-- Safe to run against an existing deployment.

USE sch_path_db;

ALTER TABLE triRecords
  MODIFY COLUMN status ENUM('Draft','Submitted','Under Review','Returned','For Reassessment','Finalized')
  NOT NULL DEFAULT 'Draft';

ALTER TABLE incidentReports
  MODIFY COLUMN status ENUM('Submitted','Pending Review','Verified','Failed','Reassessment')
  NOT NULL DEFAULT 'Submitted';
