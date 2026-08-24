/**
 * Cleanup script to remove duplicate phase records
 * Ensures only one phase is marked as current per child
 */

import { pool } from '../config/database.js';

async function cleanupDuplicatePhases() {
  try {
    console.log('Starting duplicate phase cleanup...');

    // Get all children
    const [children] = await pool.query('SELECT id, name FROM children');
    console.log(`Found ${children.length} children`);

    for (const child of children) {
      // Get all phaseProgress records for this child
      const [phases] = await pool.query(
        'SELECT * FROM phaseProgress WHERE residentId = ? ORDER BY enteredAt ASC',
        [child.id]
      );

      if (phases.length === 0) {
        console.log(`${child.id}: No phases found`);
        continue;
      }

      // Group by phaseName
      const phaseGroups = {};
      for (const phase of phases) {
        if (!phaseGroups[phase.phaseName]) {
          phaseGroups[phase.phaseName] = [];
        }
        phaseGroups[phase.phaseName].push(phase);
      }

      let hasChanges = false;

      for (const [phaseName, groupPhases] of Object.entries(phaseGroups)) {
        if (groupPhases.length > 1) {
          // Sort by enteredAt, keep the most recent
          groupPhases.sort((a, b) => new Date(a.enteredAt) - new Date(b.enteredAt));
          
          const toDelete = groupPhases.slice(0, -1); // All except the last one
          for (const phase of toDelete) {
            await pool.query('DELETE FROM phaseProgress WHERE id = ?', [phase.id]);
            console.log(`Deleted duplicate: ${phase.id} - ${phaseName} for ${child.id}`);
            hasChanges = true;
          }
        }
      }

      // Ensure only one phase is marked as current (the last one)
      const [currentPhases] = await pool.query(
        'SELECT * FROM phaseProgress WHERE residentId = ? AND isCurrent = 1 ORDER BY enteredAt DESC',
        [child.id]
      );

      if (currentPhases.length > 1) {
        // Keep only the first (most recent) as current
        const toUpdate = currentPhases.slice(1);
        for (const phase of toUpdate) {
          // Only mark as not current if it doesn't have a completedAt date
          if (!phase.completedAt) {
            await pool.query(
              'UPDATE phaseProgress SET isCurrent = 0 WHERE id = ?',
              [phase.id]
            );
            console.log(`Set isCurrent=0 for: ${phase.id} - ${phase.phaseName} for ${child.id}`);
            hasChanges = true;
          }
        }
      }

      if (hasChanges) {
        console.log(`Fixed ${child.id} (${child.name})`);
      }
    }

    console.log('Cleanup complete!');
    process.exit(0);
  } catch (error) {
    console.error('Cleanup failed:', error);
    process.exit(1);
  }
}

cleanupDuplicatePhases();
