import { pool } from '../src/config/database.js';

async function main() {
  const connection = await pool.getConnection();
  try {
    // max_allowed_packet is read-only at SESSION scope on this MySQL setup.
    // Change the GLOBAL value only; newly opened DB connections will use it.
    await connection.query('SET GLOBAL max_allowed_packet = 67108864');

    const [rows] = await connection.query("SHOW GLOBAL VARIABLES LIKE 'max_allowed_packet'");
    const value = rows[0]?.Value;

    console.log(`GLOBAL max_allowed_packet is ${value || 'unknown'} bytes.`);
    if (String(value) !== '67108864') {
      throw new Error(`MySQL did not report the expected GLOBAL value. Current value: ${value ?? 'unknown'}`);
    }

    console.log('MySQL max_allowed_packet updated to 64 MB. Restart the backend so its new DB connections use the new global value.');
  } finally {
    connection.release();
  }
}

main().catch((error) => {
  console.error('Failed to update GLOBAL max_allowed_packet:', error.message);
  console.error('If SET GLOBAL is denied, use a MySQL account with permission to change GLOBAL variables, or set max_allowed_packet=64M in your MySQL server configuration and restart MySQL.');
  process.exitCode = 1;
}).finally(() => pool.end());
