-- SCH-PATH: Link every violation to the configured guide and every tracker
-- intervention to the exact guide_interventions row used during verification.
-- Run once against sch_path_db. Existing unresolved/ambiguous rows are reported
-- instead of being assigned an invented intervention.

USE sch_path_db;

-- 1) Ensure guide_interventions can be retired without breaking historical
-- tracker references.
ALTER TABLE guide_interventions
  ADD COLUMN IF NOT EXISTS status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active';

-- 2) Ensure violations has a guide relationship.
ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS guideId VARCHAR(40) NULL;

-- 3) Backfill guideId only when the violation type has exactly one active guide.
UPDATE violations v
JOIN (
  SELECT LOWER(TRIM(name)) AS normalizedName, MIN(id) AS guideId
  FROM violation_guide
  WHERE status = 'Active' AND category IN ('Minor', 'Major')
  GROUP BY LOWER(TRIM(name))
  HAVING COUNT(*) = 1
) g ON LOWER(TRIM(v.type)) = g.normalizedName
SET v.guideId = g.guideId
WHERE v.guideId IS NULL;

-- 4) Show any violation that still has no unambiguous guide link.
SELECT v.id, v.type
FROM violations v
WHERE v.guideId IS NULL;

-- 5) Add the FK after the backfill. If step 3 returns rows, resolve those
-- configuration records first, then run this statement.
SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'violations'
    AND CONSTRAINT_NAME = 'fk_violations_guide'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE violations ADD CONSTRAINT fk_violations_guide FOREIGN KEY (guideId) REFERENCES violation_guide(id) ON DELETE RESTRICT',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 6) Add exact source intervention ID to tracker.
ALTER TABLE intervention_tracker
  ADD COLUMN IF NOT EXISTS guideInterventionId VARCHAR(40) NULL;

-- 7) Backfill tracker source IDs only when its guide + offense + type identifies
-- exactly one configured intervention.
UPDATE intervention_tracker it
JOIN (
  SELECT gi.guideId, gi.offenseLevel, LOWER(TRIM(gi.interventionType)) AS normalizedType,
         MIN(gi.id) AS guideInterventionId
  FROM guide_interventions gi
  GROUP BY gi.guideId, gi.offenseLevel, LOWER(TRIM(gi.interventionType))
  HAVING COUNT(*) = 1
) gi ON gi.guideId = it.guideId
    AND gi.offenseLevel = it.offenseLevel
    AND LOWER(TRIM(gi.normalizedType)) = LOWER(TRIM(it.interventionType))
SET it.guideInterventionId = gi.guideInterventionId
WHERE it.guideInterventionId IS NULL;

SELECT it.id, it.violationId, it.interventionType
FROM intervention_tracker it
WHERE it.guideInterventionId IS NULL;

-- 8) Add the source FK. Existing unlinked legacy tracker rows must be resolved
-- before making the relationship mandatory.
SET @fk_exists2 := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'intervention_tracker'
    AND CONSTRAINT_NAME = 'fk_tracker_guide_intervention'
);
SET @sql2 := IF(@fk_exists2 = 0,
  'ALTER TABLE intervention_tracker ADD CONSTRAINT fk_tracker_guide_intervention FOREIGN KEY (guideInterventionId) REFERENCES guide_interventions(id) ON DELETE RESTRICT',
  'SELECT 1'
);
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

SELECT 'Violation -> Guide -> Prescribed Intervention relationship migration completed.' AS result;
