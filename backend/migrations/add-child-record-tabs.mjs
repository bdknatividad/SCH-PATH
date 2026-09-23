/**
 * Migration: add childRecordTabs column to users table
 * Run once to update existing databases.
 */

import { createPool } from 'mysql2/promise';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '../.env') });

const pool = createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'secondchancehome',
  port: Number(process.env.DB_PORT) || 3306,
});

async function migrate() {
  const conn = await pool.getConnection();
  try {
    // Check if column already exists
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'childRecordTabs'`
    );

    if (cols.length > 0) {
      console.log('✓ childRecordTabs column already exists — skipping.');
      return;
    }

    await conn.query(
      `ALTER TABLE users ADD COLUMN childRecordTabs JSON NULL AFTER accessibleModules`
    );
    console.log('✓ Added childRecordTabs column to users table.');

    // Back-fill existing users with all tabs (safe default)
    const allTabs = JSON.stringify(['Personal Info', 'Phase Timeline', 'Case Progress', 'Medical', 'Behavioral']);
    await conn.query(`UPDATE users SET childRecordTabs = ? WHERE childRecordTabs IS NULL`, [allTabs]);
    console.log('✓ Back-filled childRecordTabs for existing users.');
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
