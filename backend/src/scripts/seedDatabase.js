/**
 * Database Seeding Script
 * @description Creates default users if they don't exist
 */

const bcrypt = require('bcrypt');
const { pool } = require('../config/database');

const DEFAULT_USERS = [
  { id: 'U001', username: 'centerhead', password: 'centerhead123', role: 'centerhead', status: 'Active' },
  { id: 'U002', username: 'socialworker', password: 'social123', role: 'socialworker', status: 'Active' },
  { id: 'U003', username: 'psychologist', password: 'psych123', role: 'psychologist', status: 'Active' },
  { id: 'U004', username: 'nurse', password: 'nurse123', role: 'nurse', status: 'Active' },
  { id: 'U005', username: 'educator', password: 'educator123', role: 'educator', status: 'Active' },
];

async function seedDatabase() {
  try {
    console.log('Checking default users...');
    
    for (const user of DEFAULT_USERS) {
      const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [user.username]);
      
      if (existing.length === 0) {
        const hashedPassword = await bcrypt.hash(user.password, 10);
        await pool.query(
          'INSERT INTO users (id, username, password, role, status, createdDate, accessibleModules) VALUES (?, ?, ?, ?, ?, NOW(), ?)',
          [user.id, user.username, hashedPassword, user.role, user.status, JSON.stringify([])]
        );
        console.log(`✅ Created user: ${user.username}`);
      } else {
        const [row] = await pool.query('SELECT password FROM users WHERE username = ?', [user.username]);
        const stored = row[0]?.password;
        if (stored && !stored.startsWith('$2')) {
          const hashedPassword = await bcrypt.hash(user.password, 10);
          await pool.query('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, user.username]);
          console.log(`🔒 Rehashed legacy password for: ${user.username}`);
        }
        console.log(`✓ User exists: ${user.username}`);
      }
    }
    
    console.log('Database seeding complete!');
  } catch (error) {
    console.error('Seeding failed:', error.message);
  }
}

module.exports = { seedDatabase };
