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
  dateStrings: true,
  ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
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
    const connection = await pool.getConnection();
    console.log('✅ Database connected successfully');
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    throw error;
  }
}

module.exports = {
  pool,
  dbConfig,
  testConnection,
};
