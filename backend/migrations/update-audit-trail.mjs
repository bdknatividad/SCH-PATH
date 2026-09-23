import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const config = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sch_path_db',
  port: parseInt(process.env.DB_PORT || '3306'),
};

const TABLES_TO_UPDATE = [
  'users',
  'children',
  'staff',
  'activities',
  'assessments',
  'reports',
  'healthRecords',
  'activityEvaluations',
  'violations',
  'alerts',
  'courtRecords',
  'phaseProgress',
  'documents'
];

async function addAuditTrailFields() {
  let connection;
  try {
    console.log('Connecting to MySQL...');
    connection = await mysql.createConnection(config);
    console.log('Connected!\n');

    for (const tableName of TABLES_TO_UPDATE) {
      console.log(`Processing table: ${tableName}`);
      
      // Check if columns exist
      const [columns] = await connection.execute(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = ? 
        AND TABLE_SCHEMA = ?
      `, [tableName, config.database]);

      const existingColumns = columns.map(c => c.COLUMN_NAME);
      
      // Add createdBy if not exists
      if (!existingColumns.includes('createdBy')) {
        await connection.execute(`
          ALTER TABLE ${tableName} 
          ADD COLUMN createdBy VARCHAR(100) NULL AFTER updatedAt
        `);
        console.log(`  ✓ Added createdBy to ${tableName}`);
      } else {
        console.log(`  ✓ createdBy already exists in ${tableName}`);
      }
      
      // Add modifiedBy if not exists
      if (!existingColumns.includes('modifiedBy')) {
        await connection.execute(`
          ALTER TABLE ${tableName} 
          ADD COLUMN modifiedBy VARCHAR(100) NULL AFTER createdBy
        `);
        console.log(`  ✓ Added modifiedBy to ${tableName}`);
      } else {
        console.log(`  ✓ modifiedBy already exists in ${tableName}`);
      }
      
      console.log('');
    }

    console.log('\n✅ Audit trail fields added successfully to all tables!');
    console.log('Tables can now track who created and last modified each record.');

  } catch (error) {
    console.error('❌ Error adding audit trail fields:', error.message);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
  }
}

addAuditTrailFields();
