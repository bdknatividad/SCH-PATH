/**
 * Helper Functions
 * @module utils/helpers
 * @description Utility functions for SCH-PATH system
 */

const { RESOURCES } = require('./constants');

/**
 * Generate unique ID for resources
 * @param {string} prefix - ID prefix (e.g., 'CH', 'VIO')
 * @param {Array} existing - Array of existing items to check for duplicates
 * @returns {string} Generated unique ID
 * @example
 * generateId('CH', children) // Returns: 'CH-2024-01-15-001'
 */
function generateId(prefix, existing = []) {
  // Extract the highest existing sequential number for this prefix
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const item of existing) {
    const match = (item.id || '').match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  const next = (max + 1).toString().padStart(3, '0');
  return `${prefix}${next}`;
}

/**
 * Map database row to resource object
 * @param {string} resource - Resource name
 * @param {Object} row - Database row
 * @returns {Object} Mapped resource object
 */
function mapRow(resource, row) {
  if (!row) return null;
  
  const config = RESOURCES[resource];
  if (!config) return row;
  
  const mapped = {};
  
  for (const col of config.columns) {
    if (col in row) {
      mapped[col] = row[col];
    }
  }
  
  // Parse JSON fields
  for (const field of config.jsonFields) {
    if (mapped[field] && typeof mapped[field] === 'string') {
      try {
        mapped[field] = JSON.parse(mapped[field]);
      } catch {
        mapped[field] = [];
      }
    }
  }
  
  // Convert boolean fields
  const boolFields = ['isRepeatOffender', 'documentsComplete', 'isRead', 'isCurrent', 'requiresAssessment', 'assessmentTriggered', 'assessmentCompleted'];
  for (const field of boolFields) {
    if (field in mapped) {
      mapped[field] = Boolean(mapped[field]);
    }
  }
  
  // Convert timestamp fields to ISO string
  const timestampFields = ['createdAt', 'updatedAt', 'submittedAt', 'uploadedAt', 'reviewedAt', 'approvedAt', 'readAt'];
  for (const field of timestampFields) {
    if (mapped[field] && mapped[field] instanceof Date) {
      mapped[field] = mapped[field].toISOString();
    }
  }

  // Normalize date-only fields to YYYY-MM-DD (strip time/timezone)
  const dateOnlyFields = ['birthDate', 'admissionDate', 'expectedDischargeDate', 'date', 'hearingDate', 'nextHearing', 'createdDate', 'enteredAt', 'completedAt'];
  for (const field of dateOnlyFields) {
    if (mapped[field]) {
      const val = mapped[field];
      if (val instanceof Date) {
        mapped[field] = val.toISOString().split('T')[0];
      } else if (typeof val === 'string' && val.includes('T')) {
        mapped[field] = val.split('T')[0];
      }
    }
  }
  
  return mapped;
}

/**
 * Build SQL WHERE clause from filters
 *
 * Only values are parameterised, so the column names have to be validated:
 * a raw query key would otherwise be interpolated straight into the statement.
 * When `allowedColumns` is supplied, anything outside that allow-list is
 * ignored instead of being written into the SQL string.
 *
 * @param {Object} filters - Filter criteria
 * @param {Array<string>|null} allowedColumns - Permitted column names
 * @returns {Object} { clause: string, values: Array }
 */
function buildWhereClause(filters = {}, allowedColumns = null) {
  const conditions = [];
  const values = [];
  const allowList = Array.isArray(allowedColumns) ? new Set(allowedColumns) : null;

  for (const [key, value] of Object.entries(filters)) {
    if (allowList && !allowList.has(key)) {
      continue;
    }
    if (value !== undefined && value !== null && value !== '') {
      conditions.push(`${key} = ?`);
      values.push(value);
    }
  }
  
  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  };
}

/**
 * Get current timestamp in ISO format
 * @returns {string} ISO timestamp
 */
function getCurrentTimestamp() {
  return new Date().toISOString();
}

/**
 * Format date for display
 * @param {string|Date} date - Date to format
 * @returns {string} Formatted date string
 */
function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toISOString().split('T')[0];
}

/**
 * Calculate resident age from birth date
 * @param {string|Date} birthDate - Birth date
 * @returns {number} Age in years
 */
function calculateAge(birthDate) {
  if (!birthDate) return 0;
  const today = new Date();
  const birth = new Date(birthDate);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  
  return age;
}

/**
 * Sanitize string input
 * @param {string} input - Input string
 * @returns {string} Sanitized string
 */
function sanitizeString(input) {
  if (!input || typeof input !== 'string') return '';
  return input.trim().replace(/[<>]/g, '');
}

/**
 * Validate required fields
 * @param {Object} data - Data object to validate
 * @param {Array<string>} required - Required field names
 * @returns {Array<string>} Array of missing fields
 */
function validateRequired(data, required) {
  const missing = [];
  for (const field of required) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      missing.push(field);
    }
  }
  return missing;
}

/**
 * Insert a row whose primary key is derived from the current maximum id.
 *
 * `generateId()` reads the highest existing id and adds one, so two concurrent
 * creates can compute the same id. The second INSERT then fails with
 * ER_DUP_ENTRY — which reaches the user as "sometimes the record won't save".
 * This re-reads the ids and retries, so the loser of the race simply takes the
 * next id instead of failing.
 *
 * The retry only works because every statement runs through the pool in
 * autocommit mode, so each re-read sees the row that caused the collision.
 * Inside a transaction REPEATABLE READ would keep returning the original
 * snapshot and collide again — do not use this with a transaction connection.
 *
 * `insert` must be safe to call more than once with different ids: it is only
 * retried when the previous attempt failed on a duplicate key, which means no
 * row was written and no other side effect took place.
 *
 * @param {Object} executor - `pool` (or a connection) exposing `query()`
 * @param {Object} options
 * @param {string} options.table - Table to read existing ids from
 * @param {string} options.prefix - Id prefix, e.g. 'DOC'
 * @param {(id: string) => Promise<any>} options.insert - Performs the INSERT for a given id
 * @param {number} [options.attempts=5] - Maximum INSERT attempts
 * @returns {Promise<string>} The id that was inserted
 */
async function insertWithGeneratedId(executor, { table, prefix, insert, attempts = 5 }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const [existing] = await executor.query(`SELECT id FROM ${table}`);
    const id = generateId(prefix, existing.map((row) => ({ id: row.id })));

    try {
      await insert(id);
      return id;
    } catch (error) {
      const isLastAttempt = attempt === attempts - 1;
      if (error.code !== 'ER_DUP_ENTRY' || isLastAttempt) throw error;
    }
  }

  // Unreachable: the final attempt always either returns or throws.
  throw new Error(`Could not allocate a unique id for ${table}`);
}

/**
 * Runs a unit of work inside a transaction, retrying the whole transaction when
 * it fails because it collided on a primary key.
 *
 * The transactional id-generation sites cannot use `insertWithGeneratedId()`:
 * at REPEATABLE READ a non-locking re-read returns the transaction's original
 * snapshot, so the retry would recompute the same colliding id forever. Making
 * the read a locking one (`FOR UPDATE`) is worse — these transactions already
 * hold row locks (`children`, `phaseProgress`) before the id read, so locking
 * the whole id range afterwards creates a lock-order cycle. Two concurrent
 * transitions each holding a row lock and each wanting the entire range is a
 * textbook deadlock, which trades a rare duplicate-key error for a rare
 * deadlock.
 *
 * Retrying the transaction avoids both. The failed transaction is rolled back,
 * the retry opens a new one, and its fresh snapshot sees the row that caused
 * the collision — so the next id it computes is correct. No extra locks are
 * taken, so no lock-order cycle can be introduced.
 *
 * `run` receives the connection and its return value is passed through. It must
 * be safe to run more than once: it is only retried after a rollback, so no
 * write from the previous attempt survives.
 *
 * @param {{getConnection: Function}} pool - Connection pool
 * @param {(connection: Object) => Promise<any>} run - Unit of work
 * @param {Object} [options]
 * @param {number} [options.attempts=3] - Maximum attempts
 * @returns {Promise<any>} Whatever `run` returned
 */
async function runInTransactionWithIdRetry(pool, run, { attempts = 3 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await run(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); } catch { /* connection already gone */ }

      // Only a collision on the primary key is worth retrying — that is the one
      // another transaction can win, and the next attempt computes a new id. A
      // duplicate on a business unique key (or any other error) would fail
      // identically on every attempt, so surface it immediately.
      const isIdCollision = error.code === 'ER_DUP_ENTRY' && /key 'PRIMARY'/i.test(error.sqlMessage || '');
      if (!isIdCollision || attempt === attempts - 1) throw error;
    } finally {
      connection.release();
    }
  }

  // Unreachable: the final attempt always either returns or throws.
  throw new Error('Could not complete the transaction after retrying id collisions.');
}

/**
 * Resolves a resident's age, preferring the value the client supplied.
 *
 * mysql2 renders a non-finite number as the bare token `NaN`, and MySQL then
 * rejects the statement with `Unknown column 'NaN' in 'field list'`. That
 * reached the user as an opaque "Database error occurred" for what is really a
 * missing or unparseable input, and it is why a non-finite value must never be
 * bound as a query parameter.
 *
 * Falling back to the birth date keeps the write valid; returning `null` (the
 * columns are nullable) is better than binding a NaN.
 *
 * @param {*} value - Age supplied by the client, if any
 * @param {*} birthDate - The resident's date of birth
 * @returns {number|null} A positive whole number of years, or null
 */
function normalizeAge(value, birthDate) {
  const supplied = Number(value);
  if (Number.isFinite(supplied) && supplied > 0) return Math.trunc(supplied);

  const derived = calculateAge(birthDate);
  return Number.isFinite(derived) && derived > 0 ? derived : null;
}

module.exports = {
  generateId,
  insertWithGeneratedId,
  runInTransactionWithIdRetry,
  normalizeAge,
  mapRow,
  buildWhereClause,
  getCurrentTimestamp,
  formatDate,
  calculateAge,
  sanitizeString,
  validateRequired,
};
