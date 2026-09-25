/**
 * Schema sync — make a deployed database match what the code expects.
 *
 * The step-by-step migrations in server.js assume each earlier step
 * succeeded. On a hosted database where one of them failed (a permission, a
 * provider quirk, an older copy of the tables), every later step in that
 * block is skipped, and the app later fails with "Unknown column ..." one
 * feature at a time.
 *
 * This runs after the migrations and compares the live database with
 * `database/expectedSchema.json` — every table and column the backend uses,
 * captured from a database the server itself built. Then it:
 *   - adds every missing column (always as NULL-able, so existing rows are
 *     never rejected), and
 *   - widens an ENUM that is missing values the code now writes (e.g. a
 *     resident status of 'Absconded').
 * Nothing is dropped, renamed or narrowed, and existing data is not changed.
 * Each change is independent: one that fails is logged and the rest go on.
 */
const expected = require('../database/expectedSchema.json');

function quoteDefault(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/^current_timestamp(\(\))?$/i.test(text)) return ' DEFAULT CURRENT_TIMESTAMP';
  if (/^-?\d+(\.\d+)?$/.test(text)) return ` DEFAULT ${text}`;
  return ` DEFAULT '${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function enumValues(type) {
  const match = /^enum\((.*)\)$/i.exec(String(type || '').trim());
  if (!match) return null;
  return (match[1].match(/'((?:[^']|'')*)'/g) || []).map((v) => v.slice(1, -1).replace(/''/g, "'"));
}

/** What would change, without changing anything. */
async function diffSchema(pool) {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()`
  );
  const live = new Map();
  for (const row of rows) {
    const key = String(row.TABLE_NAME).toLowerCase();
    if (!live.has(key)) live.set(key, { name: row.TABLE_NAME, columns: new Map() });
    live.get(key).columns.set(String(row.COLUMN_NAME).toLowerCase(), row);
  }

  const missingTables = [];
  const missingColumns = [];
  const narrowEnums = [];
  for (const [table, columns] of Object.entries(expected.tables)) {
    const current = live.get(table.toLowerCase());
    if (!current) { missingTables.push(table); continue; }
    for (const column of columns) {
      const have = current.columns.get(column.name.toLowerCase());
      if (!have) {
        missingColumns.push({ table: current.name, column });
        continue;
      }
      const want = enumValues(column.type);
      const got = enumValues(have.COLUMN_TYPE);
      if (want && got && want.some((value) => !got.includes(value))) {
        narrowEnums.push({ table: current.name, column, have });
      }
    }
  }
  return { missingTables, missingColumns, narrowEnums };
}

/** Apply the additive fixes. Returns a summary for the log / health check. */
async function syncSchema(pool, log = console) {
  const { missingTables, missingColumns, narrowEnums } = await diffSchema(pool);
  const added = [];
  const widened = [];
  const failed = [];

  for (const { table, column } of missingColumns) {
    const definition = `${column.type} NULL${column.extra && /auto_increment/i.test(column.extra) ? '' : quoteDefault(column.default)}`;
    try {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column.name}\` ${definition}`);
      added.push(`${table}.${column.name}`);
    } catch (error) {
      failed.push(`${table}.${column.name}: ${error.sqlMessage || error.message}`);
    }
  }

  for (const { table, column, have } of narrowEnums) {
    // Keep every value the live column already allows, then add the new ones,
    // so no existing row becomes invalid.
    const values = [...new Set([...enumValues(have.COLUMN_TYPE), ...enumValues(column.type)])];
    const type = `ENUM(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`;
    const nullable = have.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL';
    try {
      await pool.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column.name}\` ${type} ${nullable}${quoteDefault(have.COLUMN_DEFAULT)}`);
      widened.push(`${table}.${column.name}`);
    } catch (error) {
      failed.push(`${table}.${column.name} (enum): ${error.sqlMessage || error.message}`);
    }
  }

  if (added.length) log.log(`Schema sync: added ${added.length} missing column(s): ${added.join(', ')}`);
  if (widened.length) log.log(`Schema sync: widened ${widened.length} ENUM column(s): ${widened.join(', ')}`);
  if (missingTables.length) log.warn(`Schema sync: table(s) still missing: ${missingTables.join(', ')}`);
  if (failed.length) log.warn(`Schema sync: could not apply ${failed.length} change(s):\n  ${failed.join('\n  ')}`);
  if (!added.length && !widened.length && !missingTables.length && !failed.length) log.log('Schema sync: database matches the expected schema.');

  return { added, widened, missingTables, failed };
}

module.exports = { syncSchema, diffSchema };
