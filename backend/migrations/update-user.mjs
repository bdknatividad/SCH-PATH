import mysql from 'mysql2/promise';

async function updateUser() {
  const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'sch_path_db'
  });
  
  try {
    await pool.query(`UPDATE users SET accessibleModules = JSON_ARRAY('Dashboard', 'Child Records', 'Activities', 'Assessments', 'Health', 'Reports', 'Account Management', 'Violations', 'Court Records', 'Documents', 'System Evaluation', 'Social Worker') WHERE id = 'U001'`);
    console.log('✅ User updated successfully with new modules: Documents, System Evaluation, Social Worker');
  } catch (err) {
    console.error('❌ Error updating user:', err.message);
  } finally {
    await pool.end();
  }
}

updateUser();
