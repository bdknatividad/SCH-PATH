/**
 * Base Controller
 * @module controllers/baseController
 * @description Generic CRUD operations for all resources
 */

const { pool } = require('../config/database');
const { RESOURCES } = require('../utils/constants');
const { generateId, mapRow, buildWhereClause, getCurrentTimestamp } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');

/**
 * Generic CRUD controller factory
 * @param {string} resource - Resource name from RESOURCES
 * @returns {Object} Controller methods
 */
function createController(resource) {
  const config = RESOURCES[resource];
  
  if (!config) {
    throw new Error(`Unknown resource: ${resource}`);
  }

  return {
    /**
     * Get all records with optional filtering
     * @async
     */
    async getAll(req, res, next) {
      try {
        const filters = req.query || {};
        const { clause, values } = buildWhereClause(filters);
        
        const query = `SELECT * FROM ${resource} ${clause} ORDER BY ${config.orderBy}`;
        const [rows] = await pool.query(query, values);
        
        res.json({
          success: true,
          data: rows.map(row => mapRow(resource, row)),
          count: rows.length,
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
          `SELECT * FROM ${resource} WHERE id = ?`,
          [id]
        );

        if (rows.length === 0) {
          throw new ApiError(404, `${resource} not found`);
        }

        res.json({
          success: true,
          data: mapRow(resource, rows[0]),
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
        const data = req.body || {};
        
        // Get existing IDs for uniqueness check
        const [existing] = await pool.query(`SELECT id FROM ${resource}`);
        
        // Generate ID
        const newId = generateId(config.prefix, existing.map(r => ({ id: r.id })));
        
        // Build columns and values
        const columns = ['id'];
        const values = [newId];
        const placeholders = ['?'];

        for (const col of config.columns) {
          if (col !== 'id' && col !== 'createdAt' && col !== 'updatedAt') {
            if (data[col] !== undefined) {
              columns.push(col);
              // Handle JSON fields
              if (config.jsonFields.includes(col) && typeof data[col] === 'object') {
                values.push(JSON.stringify(data[col]));
              } else {
                values.push(data[col]);
              }
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

        const query = `INSERT INTO ${resource} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
        await pool.query(query, values);

        // Fetch created record
        const [rows] = await pool.query(`SELECT * FROM ${resource} WHERE id = ?`, [newId]);

        res.status(201).json({
          success: true,
          data: mapRow(resource, rows[0]),
          message: `${resource} created successfully`,
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
        const data = req.body || {};

        // Check if record exists
        const [existing] = await pool.query(`SELECT * FROM ${resource} WHERE id = ?`, [id]);
        if (existing.length === 0) {
          throw new ApiError(404, `${resource} not found`);
        }

        // Build update query
        const updates = [];
        const values = [];

        for (const col of config.columns) {
          if (col !== 'id' && col !== 'createdAt' && data[col] !== undefined) {
            updates.push(`${col} = ?`);
            // Handle JSON fields
            if (config.jsonFields.includes(col) && typeof data[col] === 'object') {
              values.push(JSON.stringify(data[col]));
            } else {
              values.push(data[col]);
            }
          }
        }

        // Add modifiedBy if user is authenticated
        if (req.user && config.columns.includes('modifiedBy')) {
          updates.push('modifiedBy = ?');
          values.push(req.user.username);
        }

        if (updates.length === 0) {
          throw new ApiError(400, 'No fields to update');
        }

        values.push(id);

        const query = `UPDATE ${resource} SET ${updates.join(', ')} WHERE id = ?`;
        await pool.query(query, values);

        // Fetch updated record
        const [rows] = await pool.query(`SELECT * FROM ${resource} WHERE id = ?`, [id]);

        res.json({
          success: true,
          data: mapRow(resource, rows[0]),
          message: `${resource} updated successfully`,
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
        const [existing] = await pool.query(`SELECT * FROM ${resource} WHERE id = ?`, [id]);
        if (existing.length === 0) {
          throw new ApiError(404, `${resource} not found`);
        }

        await pool.query(`DELETE FROM ${resource} WHERE id = ?`, [id]);

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
};
