/**
 * Cleanup script for phaseProgress table
 *
 * ⚠️ DO NOT RUN THIS ON A DATABASE WITH RETURNING RESIDENTS.
 *
 * It was written when one resident meant one admission, and removes "duplicate"
 * phases by grouping on `phaseName` alone. A resident admitted three times
 * legitimately has three `Admission Phase` rows — one per admission — and this
 * script would delete all but the last, destroying the phase history of every
 * earlier admission.
 *
 * Kept only for the old single-admission databases it was written for. If a
 * duplicate-phase problem appears on a current database, the rule is now
 * "at most one *current* row per resident per admission", which
 * `admissionController` already enforces by scoping its archival to the
 * admission being closed — so this script should not be needed at all.
 */

import { pool } from '../config/database.js';
import { activeAdmissionIdFor } from '../services/admissionLink.js';

const ALLOW_UNSAFE = process.env.ALLOW_UNSAFE_PHASE_CLEANUP === '1';

async function cleanupPhaseProgress() {
  try {
    if (!ALLOW_UNSAFE) {
      const [returning] = await pool.query(
        `SELECT COUNT(*) AS total FROM children WHERE isRepeatOffender = 1`
      );
      if (returning[0]?.total) {
        console.error(
          `Refusing to run: ${returning[0].total} returning resident(s) on record.\n` +
          'Their multiple Admission Phase rows are legitimate history, not duplicates,\n' +
          'and this script would delete them.\n\n' +
          'If you are certain this database has no returning residents, re-run with\n' +
          '  ALLOW_UNSAFE_PHASE_CLEANUP=1 node src/scripts/cleanupPhaseProgress.mjs'
        );
        process.exit(1);
      }
    }

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

        const admissionId = await activeAdmissionIdFor(pool, child.id);

        await pool.query(
          `INSERT INTO phaseProgress (id, residentId, admissionId, phaseName, enteredAt, isCurrent, tasksRequired, tasksCompleted, enteredBy, createdBy)
           VALUES (?, ?, ?, ?, CURDATE(), 1, ?, '[]', 'System', 'System')`,
          [newId, child.id, admissionId, child.casePhase || 'Admission Phase', '[]']
        );
        console.log(`Created initial phase for ${child.id}`);
        continue;
      }

      // Group phases by phaseName AND admission: the same phase name recurs
      // across admissions by design, and only a repeat *within one admission* is
      // a real duplicate.
      const phaseGroups = {};
      for (const phase of phases) {
        const groupKey = `${phase.admissionId || 'unlinked'}::${phase.phaseName}`;
        if (!phaseGroups[groupKey]) {
          phaseGroups[groupKey] = [];
        }
        phaseGroups[groupKey].push(phase);
      }

      // For each group, keep only the latest and delete the rest
      for (const [groupKey, groupPhases] of Object.entries(phaseGroups)) {
        if (groupPhases.length > 1) {
          // Keep the latest one (last in array due to ASC order)
          const toDelete = groupPhases.slice(0, -1);
          for (const phase of toDelete) {
            await pool.query('DELETE FROM phaseProgress WHERE id = ?', [phase.id]);
            console.log(`Deleted duplicate phase ${phase.id} (${groupKey}) for ${child.id}`);
          }
        }
      }

      // Ensure only one phase is marked as current *per admission*. A resident
      // mid-admission has exactly one current row; the check must not span
      // admissions or it would clear the current phase of the open one.
      const [currentPhases] = await pool.query(
        'SELECT * FROM phaseProgress WHERE residentId = ? AND isCurrent = 1 ORDER BY enteredAt ASC',
        [child.id]
      );

      const currentByAdmission = {};
      const toClear = [];
      for (const phase of currentPhases) {
        const key = phase.admissionId || 'unlinked';
        if (currentByAdmission[key]) {
          toClear.push(phase);
        } else {
          currentByAdmission[key] = phase;
        }
      }

      for (const phase of toClear) {
        await pool.query(
          'UPDATE phaseProgress SET isCurrent = 0 WHERE id = ?',
          [phase.id]
        );
        console.log(`Set isCurrent = 0 for ${phase.id}`);
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
