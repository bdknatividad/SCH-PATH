/**
 * Database Configuration
 * @module config/database
 * @description MySQL connection pool configuration for SCH-PATH system
 */

const mysql = require('mysql2/promise');
const { resolveDatabaseEnv } = require('./databaseEnv');
const {
  setDatabaseZone,
  getDatabaseZoneLabel,
  offsetSuffix,
  parseTimeDiff,
  processZoneName,
  processOffsetMinutes,
} = require('../utils/serverTime');
require('dotenv').config();

/**
 * Database connection pool configuration
 * @type {Object}
 */
/**
 * Pool size.
 *
 * The limit is the real ceiling on how many requests can touch the database
 * concurrently: past it, callers wait in the queue rather than failing
 * (`queueLimit: 0` means the queue is unbounded), so the symptom of a pool that
 * is too small is latency, not errors — which is why it is worth raising before
 * it is noticed.
 *
 * It has to stay *below* the provider's own connection cap. Managed MySQL plans
 * commonly allow a few dozen connections; exceeding that gets the client
 * refused with `ER_CON_COUNT_ERROR` ("Too many connections"), which is a hard
 * failure for every user at once. So this is deliberately tunable rather than
 * guessed at: set `DB_POOL_LIMIT` to something like half the plan's allowance,
 * leaving headroom for the migrations, the cron jobs and any admin session.
 */
const parsedPoolLimit = Number(process.env.DB_POOL_LIMIT);
const POOL_LIMIT = Number.isFinite(parsedPoolLimit) && parsedPoolLimit > 0
  ? Math.min(Math.floor(parsedPoolLimit), 200)
  : 20;

/**
 * Connection details from a single URL, when one is provided.
 *
 * Managed MySQL providers hand out a `mysql://user:pass@host:port/db` string and
 * some (Railway, Heroku, Clever Cloud) expose it as `MYSQL_URL` / `DATABASE_URL`
 * rather than as separate fields. Reading it here means a deployment that only
 * has the URL still connects, instead of silently falling back to
 * `root@localhost` and failing at boot with a confusing ECONNREFUSED.
 *
 * `DB_*` still wins over every source, so nothing that works today changes.
 * The precedence rules live in `config/databaseEnv.js` so they can be tested
 * without opening a pool.
 */
const resolved = resolveDatabaseEnv(process.env);

const dbConfig = {
  ...resolved,
  waitForConnections: true,
  connectionLimit: POOL_LIMIT,
  // Unbounded queue: a burst is absorbed and served as connections free up. A
  // bounded queue would reject the overflow with an opaque error instead.
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  connectTimeout: 15000,
  dateStrings: true,
  ...(process.env.DB_SSL === 'true' ? { ssl: { minVersion: 'TLSv1.2' } } : {}),
};

/**
 * MySQL connection pool instance
 * @type {mysql.Pool}
 */
const pool = mysql.createPool(dbConfig);

/**
 * Ask MySQL what its `NOW()` is relative to UTC, and record it for the response
 * serialiser.
 *
 * Two different clocks fill these columns. `helpers.toMysqlDateTime` converts a
 * client-supplied value using the **process's** local time, while `NOW()` uses
 * the **database's** — so the application is only self-consistent while those
 * two agree. Nothing enforced that: the container is UTC because
 * `node:22-alpine` ships no local timezone, which is an accident of the base
 * image rather than a decision, and the managed MySQL is UTC for its own
 * reasons.
 *
 * So it is measured rather than assumed, and reported either way. A mismatch
 * means client-supplied datetimes are stored at one offset and `NOW()`-filled
 * columns at another, on the same row — a skew that is invisible until somebody
 * compares two timestamps that ought to be equal. The response serialiser needs
 * the database's offset, not the process's, because the values it converts are
 * the ones MySQL stored.
 */
async function detectDatabaseZone(connection) {
  try {
    const [rows] = await connection.query(
      'SELECT @@session.time_zone AS zone, TIMEDIFF(NOW(), UTC_TIMESTAMP()) AS diff'
    );
    const row = rows[0] || {};
    const minutes = parseTimeDiff(row.diff);
    setDatabaseZone({ offsetMinutes: minutes, label: row.zone || 'SYSTEM' });

    console.log(
      `🕐 Database timezone: ${getDatabaseZoneLabel()} (${offsetSuffix(minutes)}) · process timezone: ${processZoneName()}`
    );

    if (minutes !== processOffsetMinutes()) {
      console.warn(
        `⚠️ Database and process timezones disagree (${offsetSuffix(minutes)} vs ${offsetSuffix(processOffsetMinutes())}). `
        + 'Client-supplied datetimes are converted with the process zone while NOW() uses the database zone, '
        + 'so timestamps on the same row will not agree. Set TZ on the container to match the database.'
      );
    }
  } catch (error) {
    console.warn('⚠️ Could not read the database timezone; assuming UTC:', error.message);
  }
}

/**
 * Test database connection
 * @async
 * @returns {Promise<boolean>} Connection status
 * @throws {Error} If connection fails
 */
async function testConnection() {
  try {
    // The application stores supporting documents as binary data in MySQL.
    // Raise the per-session packet limit so normal multi-megabyte uploads do
    // not fail with ER_NET_PACKET_TOO_LARGE. The GLOBAL change is best-effort
    // so startup still works for MySQL users without SUPER/SYSTEM_VARIABLES_ADMIN.
    const connection = await pool.getConnection();
    try {
      await detectDatabaseZone(connection);
      await connection.query('SET SESSION max_allowed_packet = 67108864');
    } catch (sessionErr) {
      console.warn('⚠️ Could not raise SESSION max_allowed_packet:', sessionErr.message);
    }
    try {
      await connection.query('SET GLOBAL max_allowed_packet = 67108864');
    } catch (globalErr) {
      console.warn('⚠️ Could not raise GLOBAL max_allowed_packet. If uploads still fail, set max_allowed_packet=64M in MySQL configuration:', globalErr.message);
    }
    console.log('✅ Database connected successfully');
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', {
      code: error.code || 'UNKNOWN',
      errno: error.errno || 'UNKNOWN',
      message: error.message || 'No error message returned',
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      ssl: process.env.DB_SSL === 'true',
    });
    throw error;
  }
}

module.exports = {
  pool,
  dbConfig,
  testConnection,
  detectDatabaseZone,
};
