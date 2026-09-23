import mysql from 'mysql2/promise';
import { config } from 'dotenv';
config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sch_path_db',
  port: Number(process.env.DB_PORT) || 3306,
});

const DEFAULTS = {
  centerhead: {
    modules: ['Dashboard','Child Records','Violations','Intervention Tracker','Documents','Activities','Assessments','Court Records','Houseparent','Health','Education','Reports','Account Management'],
    tabs: ['Personal Info','Phase Timeline','Education','Medical','Behavioral'],
  },
  nurse: {
    modules: ['Dashboard','Child Records','Health','Documents'],
    tabs: ['Personal Info','Phase Timeline','Medical','Behavioral'],
  },
  psychologist: {
    modules: ['Dashboard','Child Records','Violations','Intervention Tracker','Documents'],
    tabs: ['Personal Info','Phase Timeline','Medical','Behavioral'],
  },
  educator: {
    modules: ['Dashboard','Child Records','Education'],
    tabs: ['Personal Info','Education'],
  },
  socialworker: {
    modules: ['Dashboard','Child Records','Violations','Intervention Tracker','Activities','Assessments','Houseparent','Documents','Court Records','Reports'],
    tabs: ['Personal Info','Phase Timeline','Education','Medical','Behavioral'],
  },
  houseparent: {
    modules: ['Dashboard','Violations','Intervention Tracker','Activities','Assessments','Houseparent'],
    tabs: [],
  },
};

const MODULE_ORDER = ['Dashboard','Child Records','Violations','Intervention Tracker','Documents','Activities','Assessments','Court Records','Houseparent','Health','Education','Reports','Account Management'];
const TAB_ORDER = ['Personal Info','Phase Timeline','Education','Medical','Behavioral'];
const MODULE_ALIASES = { TRI: 'Houseparent', Intervention: 'Intervention Tracker' };
const TAB_ALIASES = { 'Case Progress': 'Education', 'Education Progress': 'Education' };

const parseJson = (value) => {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch { return []; }
};

const normalizeModules = (value) => {
  const raw = Array.isArray(value) ? value : [];
  const normalized = raw.map(v => MODULE_ALIASES[String(v || '').trim()] || String(v || '').trim());
  const set = new Set(normalized);
  return MODULE_ORDER.filter(name => set.has(name));
};

const normalizeTabs = (value) => {
  const raw = Array.isArray(value) ? value : [];
  const normalized = raw.map(v => TAB_ALIASES[String(v || '').trim()] || String(v || '').trim());
  const set = new Set(normalized);
  return TAB_ORDER.filter(name => set.has(name));
};

const isStarterAccount = (user) => /^U00[1-5]$/.test(String(user.id || '')) || /^UHP(0[1-9]|10)$/.test(String(user.id || ''));

async function migrate() {
  const conn = await pool.getConnection();
  try {
    const [cols] = await conn.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = 'users'`);
    const names = new Set(cols.map(c => c.COLUMN_NAME));

    // The active schema stores the optional user-facing name in displayName.
    // Do not add or reference the retired users.fullName column.
    if (!names.has('displayName')) {
      await conn.query(`ALTER TABLE users ADD COLUMN displayName VARCHAR(150) NULL AFTER username`);
    }
    if (!names.has('fullName')) {
      await conn.query(`ALTER TABLE users ADD COLUMN fullName VARCHAR(150) NULL AFTER displayName`);
    }
    await conn.query(`UPDATE users SET displayName = COALESCE(NULLIF(TRIM(displayName), ''), username) WHERE displayName IS NULL OR TRIM(displayName) = ''`);
    await conn.query(`UPDATE users SET fullName = COALESCE(NULLIF(TRIM(fullName), ''), displayName, username) WHERE fullName IS NULL OR TRIM(fullName) = ''`);

    const selectColumns = ['id', 'username', 'role', 'accessibleModules'];
    if (names.has('childRecordTabs')) selectColumns.push('childRecordTabs');
    const [users] = await conn.query(`SELECT ${selectColumns.join(', ')} FROM users`);

    for (const user of users) {
      const role = String(user.role || '').trim().toLowerCase();
      const defaults = DEFAULTS[role];
      let modules = normalizeModules(parseJson(user.accessibleModules));
      let tabs = names.has('childRecordTabs') ? normalizeTabs(parseJson(user.childRecordTabs)) : [];

      // The seeded starter accounts receive the requested role defaults exactly.
      // Custom user accounts are not overwritten; only legacy names are normalized.
      if (defaults && isStarterAccount(user)) {
        modules = [...defaults.modules];
        tabs = [...defaults.tabs];
      }
      if (role === 'centerhead' && !modules.includes('Account Management')) {
        modules.push('Account Management');
      }
      modules = MODULE_ORDER.filter(name => new Set(modules).has(name));
      tabs = TAB_ORDER.filter(name => new Set(tabs).has(name));

      if (names.has('childRecordTabs')) {
        await conn.query('UPDATE users SET accessibleModules = ?, childRecordTabs = ? WHERE id = ?', [JSON.stringify(modules), JSON.stringify(tabs), user.id]);
      } else {
        await conn.query('UPDATE users SET accessibleModules = ? WHERE id = ?', [JSON.stringify(modules), user.id]);
      }
    }

    console.log('✓ User display names and role-based module/tab defaults normalized.');
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('User access migration failed:', error);
  process.exit(1);
});
