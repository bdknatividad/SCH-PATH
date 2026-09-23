-- SCH-PATH: Add offense classification and intervention tracking columns to violations
-- Run this in phpMyAdmin: sch_path_db > SQL tab

ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS offenseNumber VARCHAR(20) NULL COMMENT '1st Offense, 2nd Offense, etc.',
  ADD COLUMN IF NOT EXISTS interventionStartDate DATE NULL COMMENT 'Date when intervention starts for this resident',
  ADD COLUMN IF NOT EXISTS interventionMonth VARCHAR(7) NULL COMMENT 'YYYY-MM for monthly reset tracking',
  ADD COLUMN IF NOT EXISTS clearedBy VARCHAR(100) NULL COMMENT 'Username who cleared this record',
  ADD COLUMN IF NOT EXISTS clearedAt DATETIME NULL COMMENT 'When record was cleared';

SELECT 'Violation columns added successfully.' AS result;

-- Verify columns were added
SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = 'sch_path_db' 
AND TABLE_NAME = 'violations'
AND COLUMN_NAME IN ('offenseNumber', 'interventionStartDate', 'interventionMonth', 'clearedBy', 'clearedAt');
