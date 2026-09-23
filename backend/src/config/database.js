/**
 * Database Configuration
 * @module config/database
 * @description MySQL connection pool configuration for SCH-PATH system
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

/**
 * Database connection pool configuration
 * @type {Object}
 */
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sch_path_db',
  waitForConnections: true,
  connectionLimit: 10,
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
};
