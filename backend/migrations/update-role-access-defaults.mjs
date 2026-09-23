import mysql from 'mysql2/promise';
import { config } from 'dotenv';

config();

const pool = await mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'secondchancehome',
  port: Number(process.env.DB_PORT) || 3306,
});

const ALL_MODULES = ['Dashboard','Child Records','Violations','Intervention Tracker','Documents','Activities','Assessments','Court Records','Houseparent','Health','Education','Reports','Account Management'];
const ALL_CHILD_TABS = ['Personal Info','Phase Timeline','Education','Medical','Behavioral'];
const DEFAULTS = {
  centerhead: { modules: ALL_MODULES, tabs: ALL_CHILD_TABS },
  nurse: { modules: ['Dashboard','Activities','Documents','Health','Reports'], tabs: ['Personal Info','Phase Timeline','Medical','Behavioral'] },
  psychologist: { modules: ['Dashboard','Child Records','Violations','Intervention Tracker','Documents'], tabs: ['Personal Info','Phase Timeline','Medical','Behavioral'] },
  educator: { modules: ['Dashboard','Documents','Activities','Education'], tabs: ['Personal Info','Education'] },
  socialworker: { modules: ['Dashboard','Child Records','Violations','Intervention Tracker','Activities','Assessments','Houseparent','Documents','Court Records','Reports'], tabs: ALL_CHILD_TABS },
  houseparent: { modules: ['Dashboard','Violations','Activities','Assessments','Houseparent'], tabs: ['Personal Info','Phase Timeline','Education','Medical','Behavioral'] },
};

try {
  const [cols] = await pool.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`);
  const names = new Set(cols.map(c => c.COLUMN_NAME));
  const hasDisplayName = names.has('displayName');

  for (const [role, cfg] of Object.entries(DEFAULTS)) {
    const [rows] = await pool.query(
      "SELECT id, username FROM users WHERE role = ? AND status = 'Active'",
      [role]
    );
    for (const row of rows) {
      const displayName = row.username?.startsWith('HP ')
        ? row.username
        : ({ centerhead: 'Center Head', nurse: 'Nurse', psychologist: 'Psychologist', educator: 'Educator', socialworker: 'Social Worker', houseparent: row.username }[role] || row.username);
      if (hasDisplayName) {
        await pool.query(
          'UPDATE users SET displayName = ?, accessibleModules = ?, childRecordTabs = ? WHERE id = ?',
          [displayName, JSON.stringify(cfg.modules), JSON.stringify(cfg.tabs), row.id]
        );
      } else {
        await pool.query(
          'UPDATE users SET accessibleModules = ?, childRecordTabs = ? WHERE id = ?',
          [JSON.stringify(cfg.modules), JSON.stringify(cfg.tabs), row.id]
        );
      }
    }
  }

  // Canonicalize legacy module/tab labels for any remaining user records without changing their other access.
  const [users] = await pool.query('SELECT id, role, accessibleModules, childRecordTabs FROM users');
  for (const u of users) {
    let mods = [];
    let tabs = [];
    try { mods = Array.isArray(u.accessibleModules) ? u.accessibleModules : JSON.parse(u.accessibleModules || '[]'); } catch {}
    try { tabs = Array.isArray(u.childRecordTabs) ? u.childRecordTabs : JSON.parse(u.childRecordTabs || '[]'); } catch {}
    const normalizedMods = mods.map(m => m === 'TRI' ? 'Houseparent' : m === 'System Evaluation' ? null : m).filter(Boolean);
    const normalizedTabs = tabs.map(t => t === 'Case Progress' || t === 'Education Progress' ? 'Education' : t);
    const uniqueMods = [...new Set(normalizedMods)];
    const uniqueTabs = [...new Set(normalizedTabs)];
    await pool.query('UPDATE users SET accessibleModules = ?, childRecordTabs = ? WHERE id = ?', [JSON.stringify(uniqueMods), JSON.stringify(uniqueTabs), u.id]);
  }
  console.log('Role access defaults synchronized.');
} finally {
  await pool.end();
}
