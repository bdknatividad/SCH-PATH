import { pool } from '../src/config/database.js';

async function main() {
  // Active duration-based interventions created before the manual Start/End
  // workflow may contain dates that were written automatically by an older
  // implementation. Clear only those still in progress so staff must
  // explicitly press Start before a start date appears, and End before an end
  // date appears. Completed history is preserved.
  const [result] = await pool.query(`
    UPDATE intervention_tracker
    SET startDate = NULL,
        endDate = NULL,
        updatedAt = NOW()
    WHERE status = 'In Progress'
      AND duration IS NOT NULL
  `);

  const [reqResult] = await pool.query(`
    UPDATE intervention_requirements ir
    JOIN intervention_tracker it ON it.id = ir.interventionId
    SET ir.startedAt = NULL,
        ir.dueDate = NULL,
        ir.updatedAt = NOW()
    WHERE it.status = 'In Progress'
      AND it.duration IS NOT NULL
  `);

  console.log(`Reset ${result.affectedRows} active duration intervention(s).`);
  console.log(`Reset ${reqResult.affectedRows} linked intervention requirement(s).`);
}

main()
  .catch((error) => {
    console.error('Failed to reset unstarted duration interventions:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
