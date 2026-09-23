/**
 * Authentication Middleware
 * @module middleware/auth
 * @description JWT authentication and role-based access control
 */

const jwt = require('jsonwebtoken');
const { ApiError } = require('./errorHandler');
const { pool } = require('../config/database');
const { normalizeRole } = require('../utils/authorization');
const { buildAccessSnapshot, isFullAccessRole } = require('../config/rbac');

/**
 * JWT secret from environment.
 *
 * The fallback below exists so a developer can clone and run without ceremony.
 * It must never reach production: it is a constant, it is in the repository, and
 * anyone holding it can mint a token for any account — including the Center
 * Head. `railway.toml` does not declare `JWT_SECRET`, so it lives only in the
 * hosting dashboard, which means a fresh deployment from this repository would
 * otherwise boot with the built-in value and no indication anything was wrong.
 *
 * So production refuses to start without it. A boot failure that names the
 * missing variable is a far better outcome than a service that looks healthy
 * while accepting forged credentials.
 *
 * Verified on the deployed API: a token signed with the fallback value is
 * rejected (401), as is one signed with an empty or whitespace secret — so the
 * live secret is a real one and this guard does not fire there.
 *
 * @constant {string}
 */
const JWT_SECRET = (() => {
  const fromEnv = typeof process.env.JWT_SECRET === 'string' ? process.env.JWT_SECRET.trim() : '';

  if (fromEnv) {
    if (fromEnv.length < 32) {
      console.warn(
        `[auth] JWT_SECRET is only ${fromEnv.length} characters. Use at least 32 — a short secret is brute-forceable offline.`,
      );
    }
    return fromEnv;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET is not set. Refusing to start in production with the built-in development secret: ' +
        'every token, including a Center Head token, would be forgeable by anyone who has read this repository. ' +
        'Set JWT_SECRET in the deployment environment.',
    );
  }

  return 'your_jwt_secret_key_change_this_in_production';
})();

/**
 * Algorithms accepted when verifying a token.
 *
 * Pinned rather than inferred. `jwt.verify` without this infers the algorithm
 * from the key type, which is correct today but makes the accepted set a
 * property of the library's defaults rather than a decision this codebase made.
 * Signing is HS256 (the `jsonwebtoken` default), so that is the only value that
 * can legitimately appear.
 *
 * @constant {string[]}
 */
const JWT_ALGORITHMS = ['HS256'];

/**
 * JWT expiration time
 * @constant {string}
 */
const JWT_EXPIRE = process.env.JWT_EXPIRE || '24h';

/**
 * Load the account row an access snapshot is built from.
 *
 * The grant columns are read in one statement. A database provisioned by an
 * older build may not have `childRecordTabs`/`subModules` yet, in which case
 * the fallback returns the identity columns only and the role's declared
 * matrix supplies the grants — degraded, never wrong.
 */
async function loadAccountForAuth(userId) {
  try {
    const [rows] = await pool.query(
      'SELECT id, username, role, status, accessibleModules, childRecordTabs, subModules FROM users WHERE id = ?',
      [userId],
    );
    return rows;
  } catch {
    const [rows] = await pool.query(
      'SELECT id, username, role, status FROM users WHERE id = ?',
      [userId],
    );
    return rows;
  }
}

/**
 * Shape the request's principal. The access snapshot rides along so every
 * downstream check — and the client — reads one server-computed answer
 * instead of re-deriving the rules.
 */
function principalFrom(user) {
  return {
    id: user.id,
    username: user.username,
    role: normalizeRole(user.role),
    access: buildAccessSnapshot({
      role: user.role,
      accessibleModules: user.accessibleModules,
      childRecordTabs: user.childRecordTabs,
      subModules: user.subModules,
    }),
  };
}

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
      role: normalizeRole(user.role)
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
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: JWT_ALGORITHMS });

    // Check if user still exists in database
    const rows = await loadAccountForAuth(decoded.id);

    if (rows.length === 0) {
      throw new ApiError(401, 'User not found. Token invalid.');
    }

    const user = rows[0];

    if (user.status !== 'Active') {
      throw new ApiError(401, 'Account is inactive. Please contact administrator.');
    }

    // Attach user info to request
    req.user = principalFrom(user);

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
 *
 * Roles flagged `fullAccess` in the RBAC definition (centerhead) pass every
 * role gate, including gates written after this one. That is what makes
 * "unrestricted access to all routes" independent of each route's hand-written
 * role list — a new endpoint cannot accidentally lock the Center Head out.
 * Note this bypass is deliberately narrower than `modules: "*"`: the
 * Administrator role holds every module and permission but is still subject to
 * these lists, so account and phase management stay Center Head-only.
 *
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

    if (isFullAccessRole(req.user.role)) return next();

    const allowedRoles = roles.map(normalizeRole);
    if (!allowedRoles.includes(normalizeRole(req.user.role))) {
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
    if (!token) return next();

    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: JWT_ALGORITHMS });

    // Re-read the account instead of trusting the token payload. Otherwise a
    // deactivated user, or a user whose role was changed, keeps the old role
    // until the token expires. Mirrors authenticate(); the only difference is
    // that an unusable token degrades to an anonymous request rather than 401.
    const rows = await loadAccountForAuth(decoded.id);

    const user = rows[0];
    if (!user || user.status !== 'Active') {
      return next();
    }

    req.user = principalFrom(user);
    next();
  } catch (error) {
    // Invalid or expired token — continue as an anonymous request.
    next();
  }
}

/**
 * Deny Houseparent write access to modules that are view-only for HP.
 * Houseparent-specific write workflows (e.g. logging violations and completing
 * intervention requirements) use their own route authorization instead.
 */
function authorizeNonHouseparent(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'Authentication required'));
  if (normalizeRole(req.user.role) === 'houseparent') {
    return next(new ApiError(403, 'Houseparents have view-only access to this module.'));
  }
  next();
}

module.exports = {
  generateToken,
  authenticate,
  authorize,
  optionalAuth,
  authorizeNonHouseparent,
  JWT_SECRET,
  JWT_EXPIRE,
};
