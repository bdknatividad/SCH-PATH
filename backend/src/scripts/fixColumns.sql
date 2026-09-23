-- Fix phaseProgress table columns
ALTER TABLE phaseProgress 
ADD COLUMN IF NOT EXISTS violationCount INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS advancementBlocked BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS demotionRecommended BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS demotionCount INT NOT NULL DEFAULT 0;

-- Reset all blocks for children without violations
UPDATE phaseProgress pp
LEFT JOIN (
    SELECT residentId, COUNT(*) as violationCount 
    FROM violations 
    WHERE status IN ('Pending', 'Under Review')
    GROUP BY residentId
) v ON pp.residentId = v.residentId
SET pp.advancementBlocked = FALSE,
    pp.violationCount = COALESCE(v.violationCount, 0),
    pp.demotionRecommended = FALSE
WHERE pp.isCurrent = 1;

-- Set blocks for children with violations
UPDATE phaseProgress pp
JOIN (
    SELECT residentId, COUNT(*) as violationCount 
    FROM violations 
    WHERE status IN ('Pending', 'Under Review')
    GROUP BY residentId
    HAVING COUNT(*) > 0
) v ON pp.residentId = v.residentId
SET pp.advancementBlocked = TRUE,
    pp.violationCount = v.violationCount,
    pp.demotionRecommended = (v.violationCount >= 2)
WHERE pp.isCurrent = 1;

SELECT 'Columns added and blocks synced' as result;
