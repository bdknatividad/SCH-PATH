/**
 * Fix phase consistency - ensure only the latest phase is marked as current
 * and all previous phases are properly marked as completed
 */

import { pool } from '../config/database.js';

async function fixPhaseConsistency() {
  try {
    console.log('Starting phase consistency fix...');

    const [children] = await pool.query('SELECT id, name, casePhase FROM children');
    
    for (const child of children) {
      console.log(`\nProcessing ${child.id} (${child.name}) - Current casePhase: ${child.casePhase}`);
      
      // Get all phases ordered by enteredAt
      const [phases] = await pool.query(
        'SELECT * FROM phaseProgress WHERE residentId = ? ORDER BY enteredAt ASC',
        [child.id]
      );

      if (phases.length === 0) {
        console.log(`  No phases found, skipping`);
        continue;
      }

      // Get the expected current phase from child's casePhase
      const expectedCurrentPhase = child.casePhase;
      
      // Find the phase record that matches the expected current phase and is most recent
      const currentPhaseRecords = phases.filter(p => p.phaseName === expectedCurrentPhase);
      
      if (currentPhaseRecords.length === 0) {
        console.log(`  WARNING: No phase record found for expected phase "${expectedCurrentPhase}"`);
        continue;
      }

      // Keep only the most recent as current, mark others as not current
      const sorted = currentPhaseRecords.sort((a, b) => new Date(a.enteredAt) - new Date(b.enteredAt));
      const latestCurrent = sorted[sorted.length - 1];
      
      console.log(`  Expected current: ${expectedCurrentPhase}, Latest record: ${latestCurrent.id}`);

      // Mark all phases except the latest current one as isCurrent=0 and ensure they have completedAt
      for (const phase of phases) {
        if (phase.id === latestCurrent.id) {
          // This should be the only current phase
          if (!phase.isCurrent) {
            await pool.query('UPDATE phaseProgress SET isCurrent = 1 WHERE id = ?', [phase.id]);
            console.log(`  Set isCurrent=1 for latest ${phase.phaseName}`);
          }
        } else {
          // All other phases should NOT be current and should have completedAt
          const needsUpdate = phase.isCurrent || !phase.completedAt;
          if (needsUpdate) {
            // If no completedAt, set it to the enteredAt of the next phase
            const nextPhase = phases.find(p => new Date(p.enteredAt) > new Date(phase.enteredAt));
            const completedAt = phase.completedAt || (nextPhase ? nextPhase.enteredAt : new Date().toISOString().split('T')[0]);
            
            await pool.query(
              'UPDATE phaseProgress SET isCurrent = 0, completedAt = ? WHERE id = ?',
              [completedAt, phase.id]
            );
            console.log(`  Fixed ${phase.phaseName}: isCurrent=0, completedAt=${completedAt}`);
          }
        }
      }
    }

    console.log('\nPhase consistency fix complete!');
    process.exit(0);
  } catch (error) {
    console.error('Fix failed:', error);
    process.exit(1);
  }
}

fixPhaseConsistency();
