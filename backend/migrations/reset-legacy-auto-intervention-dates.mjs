import mysql from 'mysql2/promise';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const { dbConfig } = require('../src/config/database.js');

const connection = await mysql.createConnection({ ...dbConfig, multipleStatements: false });
try {
  // Older verification logic populated start/end dates automatically when an
  // intervention was assigned. Under the current workflow those dates must be
  // blank until staff explicitly presses Start/End. Only active/in-progress
  // duration records are touched; completed history remains unchanged.
  const [trackerResult] = await connection.execute(
    `UPDATE intervention_tracker
     SET startDate = NULL, endDate = NULL
     WHERE status = 'In Progress' AND duration IS NOT NULL`
  );

  const [requirementResult] = await connection.execute(
    `UPDATE intervention_requirements r
     JOIN intervention_tracker it ON it.id = r.interventionId
     SET r.startedAt = NULL, r.dueDate = NULL, r.status = 'In Progress'
     WHERE it.status = 'In Progress' AND it.duration IS NOT NULL AND r.status <> 'Done'`
  );

  console.log(`Cleared legacy automatic dates from ${trackerResult.affectedRows} active duration intervention(s).`);
  console.log(`Cleared legacy requirement start/due dates from ${requirementResult.affectedRows} active duration requirement(s).`);
} finally {
  await connection.end();
}
