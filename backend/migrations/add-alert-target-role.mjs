/**
 * Migration: Add targetRole column to alerts table
 * This allows alerts to be targeted to specific roles (e.g., 'psychologist')
 * Alerts without a targetRole are visible to all users.
 */

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../.env') });

async function migrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'sch',
  });

  try {
    console.log('Adding targetRole column to alerts table...');

    // Check if column already exists
    const [columns] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'alerts' AND COLUMN_NAME = 'targetRole'`,
      [process.env.DB_NAME || 'sch']
    );

    if (columns.length > 0) {
      console.log('Column targetRole already exists. Skipping.');
    } else {
      await connection.query(
        `ALTER TABLE alerts ADD COLUMN targetRole VARCHAR(50) NULL AFTER relatedRecordId`
      );
      await connection.query(
        `ALTER TABLE alerts ADD INDEX idx_targetRole (targetRole)`
      );
      console.log('✅ Migration complete: targetRole column added to alerts table.');
    }
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

migrate();
