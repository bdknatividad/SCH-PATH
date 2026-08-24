/**
 * Cleanup script for phaseProgress table
 * Removes duplicate Admission Phase records and keeps only the most recent one per child
 */

import { pool } from '../config/database.js';

async function cleanupPhaseProgress() {
  try {
    console.log('Starting phaseProgress cleanup...');

    // Get all children
    const [children] = await pool.query('SELECT id, status, casePhase FROM children');
    console.log(`Found ${children.length} children`);

    for (const child of children) {
      // Get all phaseProgress records for this child ordered by enteredAt
      const [phases] = await pool.query(
        'SELECT * FROM phaseProgress WHERE residentId = ? ORDER BY enteredAt ASC',
        [child.id]
      );

      if (phases.length === 0) {
        // No phases exist - create initial Admission Phase
        const [existing] = await pool.query('SELECT id FROM phaseProgress');
        const newId = `PHS${String(existing.length + 1).padStart(3, '0')}`;
        
        await pool.query(
          `INSERT INTO phaseProgress (id, residentId, phaseName, enteredAt, isCurrent, tasksRequired, tasksCompleted, enteredBy, createdBy)
           VALUES (?, ?, ?, CURDATE(), 1, ?, '[]', 'System', 'System')`,
          [newId, child.id, child.casePhase || 'Admission Phase', '[]']
        );
        console.log(`Created initial phase for ${child.id}`);
        continue;
      }

      // Group phases by phaseName
      const phaseGroups = {};
      for (const phase of phases) {
        if (!phaseGroups[phase.phaseName]) {
          phaseGroups[phase.phaseName] = [];
        }
        phaseGroups[phase.phaseName].push(phase);
      }

      // For each phase group, keep only the latest and delete the rest
      for (const [phaseName, groupPhases] of Object.entries(phaseGroups)) {
        if (groupPhases.length > 1) {
          // Keep the latest one (last in array due to ASC order)
          const toDelete = groupPhases.slice(0, -1);
          for (const phase of toDelete) {
            await pool.query('DELETE FROM phaseProgress WHERE id = ?', [phase.id]);
            console.log(`Deleted duplicate phase ${phase.id} (${phaseName}) for ${child.id}`);
          }
        }
      }

      // Ensure only one phase is marked as current
      const [currentPhases] = await pool.query(
        'SELECT * FROM phaseProgress WHERE residentId = ? AND isCurrent = 1',
        [child.id]
      );

      if (currentPhases.length > 1) {
        // Keep only the first one as current, mark others as not current
        const toUpdate = currentPhases.slice(1);
        for (const phase of toUpdate) {
          await pool.query(
            'UPDATE phaseProgress SET isCurrent = 0 WHERE id = ?',
            [phase.id]
          );
          console.log(`Set isCurrent = 0 for ${phase.id}`);
        }
      }
    }

    console.log('Cleanup complete!');
    process.exit(0);
  } catch (error) {
    console.error('Cleanup failed:', error);
    process.exit(1);
  }
}

cleanupPhaseProgress();
