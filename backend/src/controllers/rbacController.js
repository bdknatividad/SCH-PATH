/**
 * RBAC Controller
 * @module controllers/rbacController
 * @description Serves the permission model to the client.
 *
 * The UI never re-derives the rules. It asks for its own effective access and
 * renders what it is told, which is what keeps the sidebar, the route guards
 * and the API's own 403s from drifting apart.
 */

const { ApiError } = require('../middleware/errorHandler');
const rbac = require('../config/rbac');

/**
 * GET /api/rbac/me
 * The caller's effective access: modules, submenus, permissions and the menu
 * tree already filtered down to what they may see.
 */
async function getMyAccess(req, res, next) {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required');

    const snapshot = req.user.access || rbac.buildAccessSnapshot(req.user);

    res.json({
      success: true,
      data: {
        role: snapshot.role,
        roleLabel: rbac.roleLabel(snapshot.role),
        fullAccess: snapshot.fullAccess,
        modules: snapshot.modules,
        subModules: snapshot.subModules,
        permissions: snapshot.permissions,
        permissionList: snapshot.permissionList || [],
        menus: rbac.listAccessibleMenus(snapshot),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/rbac/definition
 * The whole matrix: permission vocabulary, module hierarchy and every role's
 * declared grants. This is what makes the model inspectable — an operator can
 * see exactly what each role can do without reading the source.
 *
 * Restricted to roles that hold the Manage Roles permission.
 */
async function getDefinition(req, res, next) {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required');

    const snapshot = req.user.access || rbac.buildAccessSnapshot(req.user);
    const mayReadMatrix =
      snapshot.fullAccess || rbac.hasPermission(snapshot, 'Account Management', 'manageRoles');
    if (!mayReadMatrix) {
      throw new ApiError(403, 'Access denied. Manage Roles permission is required.');
    }

    res.json({
      success: true,
      data: {
        version: rbac.RBAC_DEFINITION.version,
        permissions: rbac.PERMISSION_LABELS,
        modules: rbac.MODULE_TREE,
        roles: rbac.ROLE_KEYS.map((roleKey) => {
          const grants = rbac.resolveRoleGrants(roleKey);
          return {
            key: roleKey,
            label: rbac.roleLabel(roleKey),
            description: rbac.ROLE_DEFINITIONS[roleKey].description || '',
            fullAccess: grants.fullAccess,
            modules: grants.modules,
            subModules: grants.subModules,
            permissions: grants.permissions,
            permissionList: Array.from(
              new Set(Object.values(grants.permissions).flat()),
            ),
          };
        }),
      },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getMyAccess,
  getDefinition,
};
