-- Migration: Add missing document columns
-- Run this in phpMyAdmin or MySQL if you already have the database set up
-- Safe to run multiple times (uses IF NOT EXISTS pattern)

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS residentName VARCHAR(150) NULL AFTER residentId,
  ADD COLUMN IF NOT EXISTS description TEXT NULL AFTER category,
  ADD COLUMN IF NOT EXISTS fileData LONGTEXT NULL AFTER filePath,
  ADD COLUMN IF NOT EXISTS fileType VARCHAR(100) NULL AFTER fileData,
  ADD COLUMN IF NOT EXISTS uploaderRole VARCHAR(100) NULL AFTER fileType,
  ADD COLUMN IF NOT EXISTS uploadedBy VARCHAR(100) NULL AFTER submittedAt,
  ADD COLUMN IF NOT EXISTS uploadedAt TIMESTAMP NULL AFTER uploadedBy,
  ADD COLUMN IF NOT EXISTS createdBy VARCHAR(100) NULL AFTER notes,
  ADD COLUMN IF NOT EXISTS modifiedBy VARCHAR(100) NULL AFTER createdBy;

-- Add index for uploaderRole if not exists
ALTER TABLE documents ADD INDEX IF NOT EXISTS idx_uploaderRole (uploaderRole);

SELECT 'Migration complete. Missing columns added.' AS result;

-- Migration: Add missing columns to assessments table
ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS createdBy VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS modifiedBy VARCHAR(100) NULL;

SELECT 'Migration complete.' AS result;

-- Migration: Add createdBy/modifiedBy to violations table
ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS createdBy VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS modifiedBy VARCHAR(100) NULL;

-- Migration: Add createdBy/modifiedBy to assessments table  
ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS createdBy VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS modifiedBy VARCHAR(100) NULL;

SELECT 'All migrations complete.' AS result;

-- Migration: Add recommendation columns to activities table
ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS recommendedResidentIds JSON NULL,
  ADD COLUMN IF NOT EXISTS notRecommendedResidentIds JSON NULL,
  ADD COLUMN IF NOT EXISTS notRecommendedReasons JSON NULL,
  ADD COLUMN IF NOT EXISTS violationIds JSON NULL;

SELECT 'Activity recommendation columns added.' AS result;

-- Migration: Add modifiedBy to phaseProgress table
ALTER TABLE phaseProgress
  ADD COLUMN IF NOT EXISTS modifiedBy VARCHAR(100) NULL;

SELECT 'phaseProgress modifiedBy added.' AS result;

ALTER TABLE children ADD COLUMN IF NOT EXISTS phaseTasksCompleted JSON NULL;
SELECT 'phaseTasksCompleted added.' AS result;

ALTER TABLE children ADD COLUMN IF NOT EXISTS readmissionDate DATE NULL;
ALTER TABLE children ADD COLUMN IF NOT EXISTS readmissionDatetime DATETIME NULL;
SELECT 'readmissionDate columns updated.' AS result;
