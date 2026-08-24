/**
 * Authentication Middleware
 * @module middleware/auth
 * @description JWT authentication and role-based access control
 */

const jwt = require('jsonwebtoken');
const { ApiError } = require('./errorHandler');
const { pool } = require('../config/database');

/**
 * JWT secret from environment
 * @constant {string}
 */
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_change_this_in_production';

/**
 * JWT expiration time
 * @constant {string}
 */
const JWT_EXPIRE = process.env.JWT_EXPIRE || '24h';

/**
 * Generate JWT token for user
 * @param {Object} user - User object
 * @returns {string} JWT token
 */
function generateToken(user) {
  return jwt.sign(
    { 
      id: user.id, 
      username: user.username, 
      role: user.role 
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRE }
  );
}

/**
 * Verify JWT token from request header
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ApiError(401, 'Authentication required. No token provided.');
    }

    const token = authHeader.substring(7);
    
    if (!token) {
      throw new ApiError(401, 'Authentication required. Invalid token format.');
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Check if user still exists in database
    const [rows] = await pool.query(
      'SELECT id, username, role, status FROM users WHERE id = ?',
      [decoded.id]
    );

    if (rows.length === 0) {
      throw new ApiError(401, 'User not found. Token invalid.');
    }

    const user = rows[0];
    
    if (user.status !== 'Active') {
      throw new ApiError(401, 'Account is inactive. Please contact administrator.');
    }

    // Attach user info to request
    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return next(new ApiError(401, 'Invalid token. Please login again.'));
    }
    if (error.name === 'TokenExpiredError') {
      return next(new ApiError(401, 'Token expired. Please login again.'));
    }
    next(error);
  }
}

/**
 * Authorize specific roles
 * @param {...string} roles - Allowed roles
 * @returns {Function} Express middleware
 * @example
 * router.get('/admin-only', authorize('centerhead'), controller);
 * router.get('/staff', authorize('centerhead', 'socialworker'), controller);
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new ApiError(401, 'Authentication required'));
    }

    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, `Access denied. Required role: ${roles.join(' or ')}`));
    }

    next();
  };
}

/**
 * Optional authentication - attaches user if token valid, continues regardless
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET);
    
    req.user = decoded;
    next();
  } catch (error) {
    // Continue without authentication
    next();
  }
}

module.exports = {
  generateToken,
  authenticate,
  authorize,
  optionalAuth,
  JWT_SECRET,
  JWT_EXPIRE,
};
