/**
 * Error Handling Middleware
 * @module middleware/errorHandler
 * @description Centralized error handling for the application
 */

/**
 * Custom API Error class
 * @class ApiError
 * @extends Error
 */
class ApiError extends Error {
  /**
   * @param {number} statusCode - HTTP status code
   * @param {string} message - Error message
   * @param {Object} data - Additional error data
   */
  constructor(statusCode, message, data = {}) {
    super(message);
    this.statusCode = statusCode;
    this.data = data;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Global error handling middleware
 * @param {Error} err - Error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
/**
 * Self-repair for a database that is missing something the code uses.
 *
 * "Unknown column", "no such table" and "value not in the ENUM" all mean the
 * live database is behind the code. When one reaches here, the schema sync
 * (utils/schemaSync.js) runs right away — at most once a minute — and the
 * user is told to try again. If the sync itself cannot make the change (for
 * example, the database account lacks ALTER permission), the reason is
 * returned too, so it can be fixed at the source.
 */
const SCHEMA_ERROR_CODES = new Set(['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', 'WARN_DATA_TRUNCATED', 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD']);
let lastSchemaRepairAt = 0;
let schemaRepairInFlight = null;
async function repairSchemaNow() {
  if (schemaRepairInFlight) return schemaRepairInFlight;
  if (Date.now() - lastSchemaRepairAt < 60 * 1000) return null;
  lastSchemaRepairAt = Date.now();
  schemaRepairInFlight = (async () => {
    const { pool } = require('../config/database');
    const { syncSchema } = require('../utils/schemaSync');
    return syncSchema(pool);
  })().finally(() => { schemaRepairInFlight = null; });
  return schemaRepairInFlight;
}

function errorHandler(err, req, res, next) {
  if (err && SCHEMA_ERROR_CODES.has(err.code) && !err.__schemaRepairTried) {
    err.__schemaRepairTried = true;
    return repairSchemaNow()
      .then((result) => {
        if (result && (result.added.length || result.widened.length)) {
          return res.status(409).json({
            success: false,
            code: err.code,
            message: `The database was missing ${[...result.added, ...result.widened].join(', ')} and has just been updated. Please try again.`,
            repaired: result,
          });
        }
        if (result && result.failed.length) {
          err.sqlMessage = `${err.sqlMessage || err.message} — automatic repair failed: ${result.failed[0]}`;
        }
        return errorHandler(err, req, res, next);
      })
      .catch((repairError) => {
        err.sqlMessage = `${err.sqlMessage || err.message} — automatic repair failed: ${repairError.sqlMessage || repairError.message}`;
        return errorHandler(err, req, res, next);
      });
  }

  // Log error for debugging
  console.error('Error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
  });

  // Handle specific error types
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      data: err.data,
    });
  }

  // Handle MySQL errors
  if (err.code && err.code.startsWith('ER_')) {
    // The MySQL error code and its one-line message go back with the response
    // so a failure can be diagnosed from the screen (e.g. "ER_BAD_FIELD_ERROR:
    // Unknown column ..."). Values and the SQL text itself are never included.
    const reason = String(err.sqlMessage || '').slice(0, 200);
    return res.status(400).json({
      success: false,
      message: reason ? `Database error occurred (${err.code}: ${reason})` : `Database error occurred (${err.code})`,
      code: err.code,
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }

  // Handle validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: err.errors,
    });
  }

  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: 'Token expired',
    });
  }

  // Default error response
  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' 
    ? 'Internal server error' 
    : err.message;

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

/**
 * 404 Not Found handler
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
}

/**
 * Async handler wrapper for controllers
 * @param {Function} fn - Async function to wrap
 * @returns {Function} Express middleware function
 * @example
 * router.get('/', asyncHandler(async (req, res) => {
 *   const data = await getData();
 *   res.json(data);
 * }));
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  ApiError,
  errorHandler,
  notFoundHandler,
  asyncHandler,
};
