/**
 * Migration: Add needsPsychAssessment column to children table
 * Run: node backend/migrations/add-psych-assessment-flag.mjs
 */
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../.env') });

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sch_path_db',
});

async function migrate() {
  console.log('Adding needsPsychAssessment column to children table...');
  try {
    await pool.query(`
      ALTER TABLE children ADD COLUMN IF NOT EXISTS needsPsychAssessment BOOLEAN NOT NULL DEFAULT FALSE
    `);
    console.log('✅ Migration complete: needsPsychAssessment column added.');
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('Column already exists, skipping.');
    } else {
      console.error('❌ Migration failed:', err.message);
    }
  }
  await pool.end();
}

migrate();
