/**
 * Base Controller
 * @module controllers/baseController
 * @description Generic CRUD operations for all resources
 */

const { pool } = require('../config/database');
const { RESOURCES } = require('../utils/constants');
const { insertWithGeneratedId, mapRow, buildWhereClause, getCurrentTimestamp, normalizeDatetimes } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');

/**
 * Generic CRUD controller factory
 * @param {string} resource - Resource name from RESOURCES
 * @returns {Object} Controller methods
 */
function resolveResource(resource) {
  const requested = String(resource || '').trim();

  // Education routes historically used snake_case names while the resource
  // registry may contain either snake_case or camelCase keys. Resolve the
  // requested name to one canonical config key and the real SQL table name.
  const explicitAliases = {
    education_records: { key: 'education_records', table: 'education_records' },
    educationRecords: { key: 'education_records', table: 'education_records' },
    education_progress_reports: { key: 'education_progress_reports', table: 'education_progress_reports' },
    educationProgressReports: { key: 'education_progress_reports', table: 'education_progress_reports' },
    education_school_visits: { key: 'education_school_visits', table: 'education_school_visits' },
    educationSchoolVisits: { key: 'education_school_visits', table: 'education_school_visits' },
    education_monthly_reports: { key: 'education_monthly_reports', table: 'education_monthly_reports' },
    educationMonthlyReports: { key: 'education_monthly_reports', table: 'education_monthly_reports' },
  };

  const snakeToCamel = requested
    .split('_')
    .filter(Boolean)
    .map((part, index) => index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  if (explicitAliases[requested]) {
    const alias = explicitAliases[requested];
    const config = RESOURCES[alias.key] || RESOURCES[requested] || RESOURCES[snakeToCamel];
    if (config) return { config, key: alias.key, tableName: alias.table };
  }

  if (RESOURCES[requested]) {
    return { config: RESOURCES[requested], key: requested, tableName: requested };
  }

  if (RESOURCES[snakeToCamel]) {
    return { config: RESOURCES[snakeToCamel], key: snakeToCamel, tableName: requested };
  }

  throw new Error(`Unknown resource: ${resource}`);
}

/**
 * The value to bind for one column.
 *
 * A column the resource declares in `blankToNull` takes NULL for an empty or
 * whitespace-only string. Without this, "not recorded" has two spellings in the
 * same column — `''` from a caller that sent the empty form field it read, and
 * NULL from one that sent nothing — and every comparison downstream has to know
 * about both. Only the declared columns change; this is opt-in per resource.
 *
 * @param {Object} config - The resource config from RESOURCES
 * @param {string} col - The column being bound
 * @param {*} value - The value the request supplied
 */
function bindValue(config, col, value) {
  if ((config.blankToNull || []).includes(col)) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    }
    return value;
  }

  // Handle JSON fields
  if (config.jsonFields.includes(col) && typeof value === 'object') {
    return JSON.stringify(value);
  }

  return value;
}

/** Parse a resource's `orderBy` — `col DESC`, or `a DESC, b DESC` — into terms. */
function parseOrderBy(orderBy) {
  return String(orderBy || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [column, direction] = part.split(/\s+/);
      return { column, desc: String(direction || '').toUpperCase() === 'DESC' };
    })
    .filter((term) => term.column);
}

/**
 * Order rows in the application instead of in SQL.
 *
 * MySQL sorts each row together with the columns it has to carry along, so a row
 * holding a large JSON or TEXT payload can exhaust `sort_buffer_size` and fail
 * the query outright with ER_OUT_OF_SORTMEMORY — a 400 on the whole list, with
 * the column never named. A resource opts in with `sortInApplication: true` when
 * its rows are too wide to sort in the database; see `education_records` in
 * constants.js for the measurement behind this.
 *
 * NULLs sort last in both directions, so "not recorded" never leads the list.
 * Numbers compare numerically, so an INT column does not order as text.
 * Everything else compares as a string, which is exact for the TIMESTAMP and
 * DATE columns these resources order by.
 */
function sortRows(rows, orderBy) {
  const terms = parseOrderBy(orderBy);
  if (terms.length === 0) return rows;

  return [...rows].sort((a, b) => {
    for (const { column, desc } of terms) {
      const av = a?.[column];
      const bv = b?.[column];
      const aNull = av === null || av === undefined;
      const bNull = bv === null || bv === undefined;

      if (aNull || bNull) {
        if (aNull && bNull) continue;
        return aNull ? 1 : -1;
      }

      let result;
      if (typeof av === 'number' && typeof bv === 'number') {
        result = av - bv;
      } else {
        const as = String(av);
        const bs = String(bv);
        result = as < bs ? -1 : as > bs ? 1 : 0;
      }
      if (result !== 0) return desc ? -result : result;
    }
    return 0;
  });
}

function createController(resource) {
  const { config, key: resourceKey, tableName } = resolveResource(resource);

  return {
    /**
     * Get all records with optional filtering
     * @async
     */
    async getAll(req, res, next) {
      try {
        const filters = req.query || {};
        // Column names are interpolated into the SQL string, so only the
        // resource's own columns may be used as filters.
        const { clause, values } = buildWhereClause(filters, config.columns);
        
        // A resource whose rows are too wide to filesort is ordered here rather
        // than by MySQL — see `sortInApplication` in constants.js. Leaving the
        // ORDER BY off is the whole point: it is the sort that fails.
        const query = config.sortInApplication
          ? `SELECT * FROM \`${tableName}\` ${clause}`
          : `SELECT * FROM \`${tableName}\` ${clause} ORDER BY ${config.orderBy}`;
        const [rows] = await pool.query(query, values);
        const ordered = config.sortInApplication ? sortRows(rows, config.orderBy) : rows;

        res.json({
          success: true,
          data: ordered.map(row => mapRow(resourceKey, row)),
          count: ordered.length,
        });
      } catch (error) {
        next(error);
      }
    },

    /**
     * Get single record by ID
     * @async
     */
    async getById(req, res, next) {
      try {
        const { id } = req.params;
        
        const [rows] = await pool.query(
          `SELECT * FROM \`${tableName}\` WHERE id = ?`,
          [id]
        );

        if (rows.length === 0) {
          throw new ApiError(404, `${resourceKey} not found`);
        }

        res.json({
          success: true,
          data: mapRow(resourceKey, rows[0]),
        });
      } catch (error) {
        next(error);
      }
    },

    /**
     * Create new record
     * @async
     */
    async create(req, res, next) {
      try {
        // Every `*At` / `*DateTime` field is coerced before it can be bound.
        // The client sends ISO 8601 (`2026-09-23T07:04:36.462Z`), which MySQL
        // rejects for a DATETIME column under its default strict sql_mode.
        // Normalizing here covers all resources at once rather than trusting
        // each of the frontend's `new Date().toISOString()` sites.
        const data = normalizeDatetimes(req.body || {});

        // Build the non-id columns once. The id is chosen per attempt below.
        const columns = ['id'];
        const values = [];
        const placeholders = ['?'];

        for (const col of config.columns) {
          if (col !== 'id' && col !== 'createdAt' && col !== 'updatedAt') {
            if (data[col] !== undefined) {
              columns.push(col);
              values.push(bindValue(config, col, data[col]));
              placeholders.push('?');
            }
          }
        }

        // Add createdBy if user is authenticated
        if (req.user && !columns.includes('createdBy')) {
          columns.push('createdBy');
          values.push(req.user.username);
          placeholders.push('?');
        }

        const query = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;

        // generateId() derives the next id from the current maximum, so two
        // concurrent creates can compute the same one; the loser's INSERT then
        // fails with ER_DUP_ENTRY. insertWithGeneratedId() re-reads and retries.
        const newId = await insertWithGeneratedId(pool, {
          table: tableName,
          prefix: config.prefix,
          insert: (id) => pool.query(query, [id, ...values]),
        });

        // Fetch created record
        const [rows] = await pool.query(`SELECT * FROM ${tableName} WHERE id = ?`, [newId]);

        res.status(201).json({
          success: true,
          data: mapRow(resourceKey, rows[0]),
          message: `${resourceKey} created successfully`,
        });
      } catch (error) {
        next(error);
      }
    },

    /**
     * Update record by ID
     * @async
     */
    async update(req, res, next) {
      try {
        const { id } = req.params;
        // Same coercion as create(): an ISO 8601 timestamp in a partial update
        // would otherwise be rejected by MySQL on the way in.
        const data = normalizeDatetimes(req.body || {});

        // Check if record exists
        const [existing] = await pool.query(`SELECT * FROM \`${tableName}\` WHERE id = ?`, [id]);
        if (existing.length === 0) {
          throw new ApiError(404, `${resourceKey} not found`);
        }

        // ── Lost-update protection ──────────────────────────────────────────
        //
        // Two people editing the same record used to be a silent last-write-
        // wins: whoever saved second overwrote the first person's change with
        // no warning. Several callers also send *partial* payloads (a note, a
        // checklist, a status), so the second save clobbered fields it never
        // intended to touch.
        //
        // The client holds the `updatedAt` it rendered from, and `updatedAt` is
        // maintained by MySQL (`ON UPDATE CURRENT_TIMESTAMP`), so comparing the
        // two is a reliable staleness test. A caller that omits `updatedAt` is
        // unchanged in behaviour — this is opt-in, so no existing client breaks.
        const expectedUpdatedAt = data.updatedAt;
        const currentUpdatedAt = existing[0].updatedAt;
        if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null && currentUpdatedAt) {
          const expected = new Date(expectedUpdatedAt).getTime();
          const actual = new Date(currentUpdatedAt).getTime();
          // Only refuse when the stored row is genuinely newer. Unparseable
          // input is ignored rather than rejected, so a client sending a
          // non-date (or a locale string) cannot lock itself out of updating.
          if (Number.isFinite(expected) && Number.isFinite(actual) && actual > expected) {
            const actor = existing[0].modifiedBy || existing[0].createdBy || 'another user';
            throw new ApiError(
              409,
              `This ${resourceKey} was changed by ${actor} after you opened it. Reload it to see the current version, then reapply your edit.`,
            );
          }
        }

        // Build update query
        const updates = [];
        const values = [];

        for (const col of config.columns) {
          // `updatedAt` is database-maintained; never write it from a body.
          if (col !== 'id' && col !== 'createdAt' && col !== 'updatedAt' && data[col] !== undefined) {
            updates.push(`${col} = ?`);
            values.push(bindValue(config, col, data[col]));
          }
        }

        // Add modifiedBy only when the resource contract declares it.
        if (req.user && config.columns.includes('modifiedBy')) {
          updates.push('modifiedBy = ?');
          values.push(req.user.username);
        }

        if (updates.length === 0) {
          throw new ApiError(400, 'No fields to update');
        }

        values.push(id);

        const query = `UPDATE \`${tableName}\` SET ${updates.join(', ')} WHERE id = ?`;
        await pool.query(query, values);

        // Fetch updated record
        const [rows] = await pool.query(`SELECT * FROM \`${tableName}\` WHERE id = ?`, [id]);

        res.json({
          success: true,
          data: mapRow(resourceKey, rows[0]),
          message: `${resourceKey} updated successfully`,
        });
      } catch (error) {
        next(error);
      }
    },

    /**
     * Delete record by ID
     * @async
     */
    async delete(req, res, next) {
      try {
        const { id } = req.params;

        // Check if record exists
        const [existing] = await pool.query(`SELECT * FROM \`${tableName}\` WHERE id = ?`, [id]);
        if (existing.length === 0) {
          throw new ApiError(404, `${resourceKey} not found`);
        }

        await pool.query(`DELETE FROM \`${tableName}\` WHERE id = ?`, [id]);

        res.json({
          success: true,
          message: `${resource} deleted successfully`,
        });
      } catch (error) {
        next(error);
      }
    },
  };
}

module.exports = {
  createController,
  bindValue,
  sortRows,
};
