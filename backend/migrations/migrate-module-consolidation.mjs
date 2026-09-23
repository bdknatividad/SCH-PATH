import mysql from 'mysql2/promise';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const pool = await mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const ALL = ['Dashboard','Child Records','Violations','Documents','Activities','Assessments','Court Records','Houseparent','Health','Education','Reports','Account Management'];
const seeded = {
  centerhead: ALL,
  houseparent: ['Dashboard','Violations','Activities','Assessments','Houseparent'],
  socialworker: ['Dashboard','Child Records','Violations','Activities','Assessments','Houseparent','Documents','Court Records','Reports'],
  psychologist: ['Dashboard','Child Records','Violations','Documents'],
  nurse: ['Dashboard','Child Records','Health','Documents'],
  educator: ['Dashboard','Child Records','Education'],
};
const roleTabs = {
  centerhead: ['Personal Info','Phase Timeline','Education','Medical','Behavioral'],
  nurse: ['Personal Info','Phase Timeline','Medical','Behavioral'],
  psychologist: ['Personal Info','Phase Timeline','Medical','Behavioral'],
  educator: ['Personal Info','Education'],
  socialworker: ['Personal Info','Phase Timeline','Education','Medical','Behavioral'],
  houseparent: ['Personal Info','Phase Timeline','Education','Medical','Behavioral'],
};
function parse(value) { if (Array.isArray(value)) return value; try { return JSON.parse(value || '[]'); } catch { return []; } }
try {
  const [rows] = await pool.query('SELECT id, username, role, accessibleModules, childRecordTabs FROM users');
  for (const row of rows) {
    let modules = parse(row.accessibleModules).map(m => m === 'TRI' ? 'Houseparent' : m === 'Intervention Tracker' ? 'Violations' : m);
    modules = Array.from(new Set(modules));
    if (seeded[row.username]) modules = seeded[row.username];
    if (String(row.role).toLowerCase() === 'centerhead') modules = ALL;
    if (/^HP \d+$/.test(String(row.username).trim())) modules = seeded.houseparent;
    let tabs = parse(row.childRecordTabs).map(t => t === 'Case Progress' ? 'Education' : t);
    tabs = Array.from(new Set(tabs));
    if (roleTabs[row.role] && (tabs.length === 0 || ['centerhead','socialworker','psychologist','nurse','educator','houseparent'].includes(row.role))) tabs = roleTabs[row.role];
    await pool.query('UPDATE users SET accessibleModules = ?, childRecordTabs = ? WHERE id = ?', [JSON.stringify(modules), JSON.stringify(tabs), row.id]);
  }
  console.log('Module consolidation migration complete.');
} finally { await pool.end(); }
