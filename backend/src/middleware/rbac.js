/**
 * RBAC enforcement middleware.
 * @module middleware/rbac
 * @description Express guards driven entirely by `config/rbac`.
 *
 * These are the declarative counterparts of `authorize(...roles)`: instead of
 * naming the roles allowed to call a handler, a route names the *capability*
 * it needs. That keeps routes stable when a new role is added — the new role's
 * access matrix decides the outcome, not a route edit.
 *
 * @example
 * router.post('/', requirePermission('Violations', 'create'), handler);
 * router.post('/:id/verify', requirePermission('Violations', 'verify'), handler);
 * router.get('/pending', requireSubModule('Documents', 'Pending Review'), handler);
 */

const { ApiError } = require('./errorHandler');
const {
  buildAccessSnapshot,
  hasModuleAccess,
  hasSubModuleAccess,
  hasPermission,
} = require('../config/rbac');

/**
 * The caller's effective access snapshot, computed once per request and cached
 * on `req.user`. `authenticate()` normally attaches it already; this is the
 * fallback for routes exercised without it (and for tests that build a
 * `req.user` by hand).
 */
function snapshotFor(req) {
  if (!req.user) return null;
  if (!req.user.access || typeof req.user.access !== 'object') {
    req.user.access = buildAccessSnapshot(req.user);
  }
  return req.user.access;
}

/**
 * Require access to a module (menu). Full-access roles always pass.
 * @param {string} module - Canonical module key, e.g. 'Violations'
 */
function requireModule(module) {
  return (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required');
      const snapshot = snapshotFor(req);
      if (!hasModuleAccess(snapshot, module)) {
        throw new ApiError(403, `Access denied. The ${module} module is not available to your account.`);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Require access to a module's submenu (tab). A module with no submenus passes.
 * @param {string} module
 * @param {string} subModule
 */
function requireSubModule(module, subModule) {
  return (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required');
      const snapshot = snapshotFor(req);
      if (!hasModuleAccess(snapshot, module)) {
        throw new ApiError(403, `Access denied. The ${module} module is not available to your account.`);
      }
      if (!hasSubModuleAccess(snapshot, module, subModule)) {
        throw new ApiError(
          403,
          `Access denied. The ${subModule} section of ${module} is not available to your account.`,
        );
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Require a permission on a module.
 *
 * The module gate is checked first, so a permission on a module the caller
 * cannot open is refused even when the role's `"*"` baseline lists it.
 *
 * @param {string} module - Canonical module key
 * @param {string} permission - Permission key or label ('edit' | 'Edit')
 * @param {{subModule?: string}} [options]
 */
function requirePermission(module, permission, options = {}) {
  return (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required');
      const snapshot = snapshotFor(req);

      if (!hasModuleAccess(snapshot, module)) {
        throw new ApiError(403, `Access denied. The ${module} module is not available to your account.`);
      }
      if (options.subModule && !hasSubModuleAccess(snapshot, module, options.subModule)) {
        throw new ApiError(
          403,
          `Access denied. The ${options.subModule} section of ${module} is not available to your account.`,
        );
      }
      if (!hasPermission(snapshot, module, permission)) {
        throw new ApiError(403, `Access denied. ${module}: ${permission} permission is required.`);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = {
  snapshotFor,
  requireModule,
  requireSubModule,
  requirePermission,
};
