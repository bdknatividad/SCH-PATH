import mysql from 'mysql2/promise';

async function updateTable() {
  const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'sch_path_db'
  });
  
  try {
    // Check if columns exist
    const [columns] = await pool.query('SHOW COLUMNS FROM documents');
    const columnNames = columns.map(c => c.Field);
    
    // Add missing columns
    if (!columnNames.includes('description')) {
      await pool.query('ALTER TABLE documents ADD COLUMN description TEXT NULL');
      console.log('✅ Added description column');
    }
    
    if (!columnNames.includes('fileData')) {
      await pool.query('ALTER TABLE documents ADD COLUMN fileData LONGTEXT NULL');
      console.log('✅ Added fileData column');
    }
    
    if (!columnNames.includes('fileType')) {
      await pool.query('ALTER TABLE documents ADD COLUMN fileType VARCHAR(100) NULL');
      console.log('✅ Added fileType column');
    }
    
    if (!columnNames.includes('uploadedBy')) {
      await pool.query('ALTER TABLE documents ADD COLUMN uploadedBy VARCHAR(100) NULL');
      console.log('✅ Added uploadedBy column');
    }
    
    if (!columnNames.includes('uploadedAt')) {
      await pool.query('ALTER TABLE documents ADD COLUMN uploadedAt TIMESTAMP NULL');
      console.log('✅ Added uploadedAt column');
    }
    
    console.log('✅ Documents table updated successfully!');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await pool.end();
  }
}

updateTable();
