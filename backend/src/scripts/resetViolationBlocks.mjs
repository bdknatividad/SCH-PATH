/**
 * Reset advancementBlocked for all phases that don't have violations
 */

import { pool } from '../config/database.js';

async function resetViolationBlocks() {
  try {
    console.log('Resetting advancement blocks...');

    // Get all current phases
    const [phases] = await pool.query(
      'SELECT id, residentId, phaseName, violationCount, advancementBlocked FROM phaseProgress WHERE isCurrent = 1'
    );

    console.log(`Found ${phases.length} current phases`);

    for (const phase of phases) {
      // Count actual pending violations for this child
      const [violationCount] = await pool.query(
        `SELECT COUNT(*) as count FROM violations 
         WHERE residentId = ? AND status IN ('Pending', 'Under Review')`,
        [phase.residentId]
      );

      const actualViolations = violationCount[0].count;
      
      console.log(`${phase.residentId} (${phase.phaseName}): ${actualViolations} violations, advancementBlocked=${phase.advancementBlocked}`);

      // If no violations but blocked, unblock it
      if (actualViolations === 0 && phase.advancementBlocked) {
        await pool.query(
          'UPDATE phaseProgress SET advancementBlocked = FALSE, violationCount = 0 WHERE id = ?',
          [phase.id]
        );
        console.log(`  → Unblocked ${phase.id}`);
      }
      
      // If has violations but not blocked, block it
      if (actualViolations > 0 && !phase.advancementBlocked) {
        await pool.query(
          'UPDATE phaseProgress SET advancementBlocked = TRUE, violationCount = ? WHERE id = ?',
          [actualViolations, phase.id]
        );
        console.log(`  → Blocked ${phase.id} (${actualViolations} violations)`);
      }
    }

    console.log('Reset complete!');
    process.exit(0);
  } catch (error) {
    console.error('Reset failed:', error);
    process.exit(1);
  }
}

resetViolationBlocks();
