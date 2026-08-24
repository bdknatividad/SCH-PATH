/**
 * Sync violation blocks with actual violations
 */

import { pool } from '../config/database.js';

async function syncViolationBlocks() {
  try {
    console.log('Syncing violation blocks...\n');

    // Get all residents with pending violations
    const [violations] = await pool.query(`
      SELECT residentId, COUNT(*) as count 
      FROM violations 
      WHERE status IN ('Pending', 'Under Review', 'Reviewed')
      GROUP BY residentId
    `);

    const violationMap = {};
    for (const v of violations) {
      violationMap[v.residentId] = v.count;
    }

    console.log('Violations found:', violationMap);

    // Get all current phases
    const [phases] = await pool.query('SELECT id, residentId, phaseName FROM phaseProgress WHERE isCurrent = 1');

    console.log(`\nUpdating ${phases.length} phases...\n`);

    for (const phase of phases) {
      const violationCount = violationMap[phase.residentId] || 0;
      const blocked = violationCount > 0;
      const demotionRecommended = violationCount >= 2;

      await pool.query(
        'UPDATE phaseProgress SET violationCount = ?, advancementBlocked = ?, demotionRecommended = ? WHERE id = ?',
        [violationCount, blocked, demotionRecommended, phase.id]
      );

      console.log(`${phase.residentId} (${phase.phaseName}): ${violationCount} violations, blocked=${blocked}, demote=${demotionRecommended}`);
    }

    console.log('\n✅ Sync complete!');
    process.exit(0);
  } catch (error) {
    console.error('Sync failed:', error);
    process.exit(1);
  }
}

syncViolationBlocks();
