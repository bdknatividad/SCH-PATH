-- Migration: Connect Assessments to Violations/Interventions
-- Run this once in phpMyAdmin's SQL tab against sch_path_db.
-- NOT safe to re-run blindly — if you run it twice you'll get a
-- "Duplicate column name" error, which just means it already applied. Fine to ignore.

USE sch_path_db;

-- Links an assessment to the violation(s) it was triggered by / covers.
-- (JSON array, same pattern as activities.violationIds — one assessment can
-- cover several children/violations when merged into a group session.)
ALTER TABLE assessments
  ADD COLUMN violationIds JSON NULL AFTER triggeredBy;

-- Tracks whether the assessment tied to this violation's intervention has been
-- completed. Only ever set to TRUE for violations whose intervention actually
-- included an assessment (assessmentTriggered = TRUE) — see assessmentController.complete().
ALTER TABLE violations
  ADD COLUMN assessmentCompleted BOOLEAN NOT NULL DEFAULT FALSE AFTER assessmentTriggered;

-- Links an assessment to the exact requirement completed by this assessment.
ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS interventionTrackerId VARCHAR(40) NULL AFTER violationIds;

ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS interventionRequirementId VARCHAR(40) NULL AFTER interventionTrackerId;
