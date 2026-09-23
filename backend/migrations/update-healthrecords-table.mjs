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

async function updateHealthRecordsTable() {
  let connection;
  try {
    console.log('Connecting to MySQL...');
    connection = await mysql.createConnection(config);
    console.log('Connected!');

    // Check if columns exist
    const [columns] = await connection.execute(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'healthRecords' 
      AND TABLE_SCHEMA = ?
    `, [config.database]);

    const existingColumns = columns.map(c => c.COLUMN_NAME);
    console.log('Existing columns:', existingColumns);

    const columnsToAdd = [
      { name: 'bloodPressure', type: 'VARCHAR(20)' },
      { name: 'temperature', type: 'DECIMAL(4,1)' },
      { name: 'weight', type: 'DECIMAL(5,2)' },
      { name: 'height', type: 'DECIMAL(5,2)' },
      { name: 'pulse', type: 'INT' },
      { name: 'medicationName', type: 'VARCHAR(150)' },
      { name: 'dosage', type: 'VARCHAR(50)' },
      { name: 'frequency', type: 'VARCHAR(50)' },
      { name: 'prescribedBy', type: 'VARCHAR(150)' },
      { name: 'allergies', type: 'TEXT' },
      { name: 'conditions', type: 'TEXT' },
    ];

    for (const col of columnsToAdd) {
      if (!existingColumns.includes(col.name)) {
        console.log(`Adding column: ${col.name}`);
        await connection.execute(`
          ALTER TABLE healthRecords 
          ADD COLUMN ${col.name} ${col.type} NULL
        `);
        console.log(`✓ Added ${col.name}`);
      } else {
        console.log(`✓ Column ${col.name} already exists`);
      }
    }

    console.log('\n✅ Health records table updated successfully!');
    console.log('New columns added for vital signs, medication tracking, and allergies/conditions.');

  } catch (error) {
    console.error('❌ Error updating health records table:', error.message);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
  }
}

updateHealthRecordsTable();
