/** Run: node backend/migrations/add-violation-verification-fields.mjs */
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../.env') });
const pool = mysql.createPool({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'sch_path_db' });
async function run() {
  try { await pool.query("ALTER TABLE violations MODIFY COLUMN status ENUM('Pending Review','Under Investigation','Reviewed','Resolved','Escalated','Rejected') NOT NULL DEFAULT 'Pending Review'"); } catch (error) { console.error('status migration:', error.message); }
  try { await pool.query('ALTER TABLE violations ADD COLUMN incidentGroupId VARCHAR(60) NULL AFTER clearedAt'); } catch (error) { if (!/duplicate column/i.test(error.message)) console.error('incidentGroupId migration:', error.message); }
  try { await pool.query('ALTER TABLE incidentReports MODIFY COLUMN interventionScheduleDate DATETIME NULL'); } catch (error) { console.error('schedule datetime migration:', error.message); }
  try { await pool.query('ALTER TABLE violations ADD COLUMN guideId VARCHAR(40) NULL AFTER incidentGroupId'); } catch (error) { if (!/duplicate column/i.test(error.message)) console.error('guideId migration:', error.message); }
  try { await pool.query("DELETE it FROM intervention_tracker it INNER JOIN violations v ON v.id = it.violationId WHERE v.status IN ('Pending Review','Rejected')"); } catch (error) { console.error('remove unverified tracker rows:', error.message); }
  try { await pool.query("UPDATE intervention_tracker SET status = 'In Progress' WHERE status = 'Pending'"); } catch (error) { console.error('normalize pending tracker rows:', error.message); }
  try { await pool.query("ALTER TABLE intervention_tracker MODIFY COLUMN status ENUM('In Progress','Completed') NOT NULL DEFAULT 'In Progress'"); } catch (error) { console.error('tracker status migration:', error.message); }
  try { await pool.query('ALTER TABLE intervention_tracker ADD COLUMN scheduledAt DATETIME NULL AFTER status'); } catch (error) { if (!/duplicate column/i.test(error.message)) console.error('scheduledAt migration:', error.message); }
  try { await pool.query('ALTER TABLE intervention_tracker ADD COLUMN psychosocialActivities JSON NULL AFTER scheduledAt'); } catch (error) { if (!/duplicate column/i.test(error.message)) console.error('psychosocialActivities migration:', error.message); }
  await pool.end();
}
run();
