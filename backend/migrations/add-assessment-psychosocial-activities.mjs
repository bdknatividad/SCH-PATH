import { pool } from '../src/config/database.js';

async function hasColumn(table, column) {
  const [rows] = await pool.query(`SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`, [table, column]);
  return rows.length > 0;
}

try {
  if (!(await hasColumn('assessments', 'psychosocialActivities'))) {
    await pool.query(`ALTER TABLE assessments ADD COLUMN psychosocialActivities JSON NULL AFTER type`);
    console.log('Added assessments.psychosocialActivities.');
  } else {
    console.log('assessments.psychosocialActivities already exists.');
  }
} catch (error) {
  console.error('Failed to add assessments.psychosocialActivities:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
