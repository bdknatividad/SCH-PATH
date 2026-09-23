import { pool } from '../src/config/database.js';

async function run() {
  await pool.query("ALTER TABLE documents ADD COLUMN assessmentId VARCHAR(40) NULL AFTER staffId").catch(err => { if (err.code !== 'ER_DUP_FIELDNAME') throw err; });
  await pool.query("CREATE INDEX idx_documents_assessmentId ON documents (assessmentId)").catch(err => { if (err.code !== 'ER_DUP_KEYNAME') throw err; });
  await pool.query("ALTER TABLE assessments ADD COLUMN schedulingMode VARCHAR(30) NULL AFTER interventionRequirementId").catch(err => { if (err.code !== 'ER_DUP_FIELDNAME') throw err; });
  console.log('Assessment document link migration complete.');
  await pool.end();
}
run().catch(err => { console.error(err); process.exit(1); });
