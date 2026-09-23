/**
 * RBAC resolver.
 * @module config/rbac
 * @description Turns the canonical `rbac.definition.json` into the access
 * decisions the API enforces.
 *
 * Design notes
 * ------------
 * - **One source of truth.** `rbac.definition.json` holds the permission
 *   vocabulary, the module/submenu hierarchy and every role's access matrix.
 *   Nothing in this file restates them; it only resolves them.
 * - **Adding a role is a data change.** Append an entry to
 *   `definition.roles` and the role is instantly grantable, renderable and
 *   enforceable. No new branch anywhere in the codebase.
 * - **Full access is a flag, not a list.** `fullAccess: true` short-circuits
 *   every check, including for modules and permissions that do not exist yet.
 *   That is what makes `centerhead` immune to future restrictions.
 * - **Submodules default open.** A role that lists a module but not that
 *   module's submodules receives *all* of them. Restrictions are therefore
 *   explicit and additive, which keeps the model honest about what the UI
 *   already allowed instead of silently locking tabs nobody asked to lock.
 */

const definition = require('./rbac.definition.json');

const PERMISSION_LABELS = Object.freeze({ ...definition.permissions });
const PERMISSION_KEYS = Object.freeze(Object.keys(PERMISSION_LABELS));

/** Canonical module tree, in the order the sidebar renders it. */
const MODULE_TREE = Object.freeze(
  definition.modules.map((module) =>
    Object.freeze({
      ...module,
      subModules: Object.freeze((module.subModules || []).map((sub) => Object.freeze({ ...sub }))),
    }),
  ),
);

const MODULE_KEYS = Object.freeze(MODULE_TREE.map((module) => module.key));
const MODULE_BY_KEY = Object.freeze(
  MODULE_TREE.reduce((accumulator, module) => {
    accumulator[module.key] = module;
    return accumulator;
  }, {}),
);

/** Submodule keys per module: `{ 'Child Records': ['Personal Info', ...] }`. */
const SUB_MODULE_KEYS_BY_MODULE = Object.freeze(
  MODULE_TREE.reduce((accumulator, module) => {
    accumulator[module.key] = Object.freeze(module.subModules.map((sub) => sub.key));
    return accumulator;
  }, {}),
);

/**
 * Legacy module names that older rows or browser storage may still hold.
 * A legacy key resolves to the module that now owns that feature.
 */
const LEGACY_MODULE_ALIASES = Object.freeze(
  MODULE_TREE.reduce((accumulator, module) => {
    for (const legacy of module.legacyKeys || []) accumulator[legacy] = module.key;
    return accumulator;
  }, {}),
);

/** Non-module aliases kept for storage written by earlier builds. */
const EXTRA_MODULE_ALIASES = Object.freeze({
  Intervention: 'Intervention Tracker',
  'Case Progress': 'Education',
  'Education Progress': 'Education',
});

const ROLE_DEFINITIONS = Object.freeze(definition.roles);
const ROLE_KEYS = Object.freeze(Object.keys(ROLE_DEFINITIONS));
const ROLE_LABELS = Object.freeze(
  ROLE_KEYS.reduce((accumulator, key) => {
    accumulator[key] = ROLE_DEFINITIONS[key].label || key;
    return accumulator;
  }, {}),
);

/** Roles whose definition carries `fullAccess: true`. */
const FULL_ACCESS_ROLES = Object.freeze(
  ROLE_KEYS.filter((key) => ROLE_DEFINITIONS[key].fullAccess === true),
);

const CHILD_RECORD_TABS_MODULE = definition.childRecordTabsModule || 'Child Records';

const ROLE_ALIASES = Object.freeze({
  'center head': 'centerhead',
  center_head: 'centerhead',
  'center-head': 'centerhead',
  'social worker': 'socialworker',
  social_worker: 'socialworker',
  'house parent': 'houseparent',
  house_parent: 'houseparent',
  administrator: 'admin',
});

function normalizeRoleKey(role) {
  const value = String(role || '').trim().toLowerCase();
  return ROLE_ALIASES[value] || value;
}

/** Resolve a possibly-legacy module name to its canonical key. */
function normalizeModuleKey(module) {
  const trimmed = String(module || '').trim();
  if (!trimmed) return '';
  if (MODULE_BY_KEY[trimmed]) return trimmed;
  if (LEGACY_MODULE_ALIASES[trimmed]) return LEGACY_MODULE_ALIASES[trimmed];
  const viaExtra = EXTRA_MODULE_ALIASES[trimmed];
  if (viaExtra) return normalizeModuleKey(viaExtra);
  return trimmed;
}

/** Resolve a permission name or label to its canonical camelCase key. */
function normalizePermission(permission) {
  const trimmed = String(permission || '').trim();
  if (!trimmed) return '';
  if (PERMISSION_LABELS[trimmed]) return trimmed;
  const lower = trimmed.toLowerCase().replace(/[\s_-]+/g, '');
  for (const key of PERMISSION_KEYS) {
    if (key.toLowerCase() === lower) return key;
    if (String(PERMISSION_LABELS[key]).toLowerCase().replace(/[\s_-]+/g, '') === lower) return key;
  }
  return trimmed;
}

function getRoleDefinition(role) {
  return ROLE_DEFINITIONS[normalizeRoleKey(role)] || null;
}

function isFullAccessRole(role) {
  const roleDefinition = getRoleDefinition(role);
  return Boolean(roleDefinition && roleDefinition.fullAccess === true);
}

function roleLabel(role) {
  return ROLE_LABELS[normalizeRoleKey(role)] || String(role || '');
}

/** Every submodule key in the definition, for a full-access snapshot. */
function allSubModules() {
  return MODULE_KEYS.reduce((accumulator, moduleKey) => {
    accumulator[moduleKey] = [...SUB_MODULE_KEYS_BY_MODULE[moduleKey]];
    return accumulator;
  }, {});
}

/** Drop submodule names the definition does not know for that module. */
function validSubModules(moduleKey, declared) {
  const known = SUB_MODULE_KEYS_BY_MODULE[moduleKey] || [];
  return Array.from(new Set(asStringArray(declared).filter((sub) => known.includes(sub))));
}

/**
 * Expand a role's declared access matrix.
 *
 * `modules`, `subModules` and `permissions` may each be the string `"*"`,
 * meaning "everything the definition knows about". Note that `"*"` is a
 * *grant*, not a bypass — only `fullAccess: true` bypasses checks. That
 * distinction is what lets `admin` hold every module and every permission
 * while `authorize('centerhead')` still keeps account and phase management
 * centerhead-only.
 *
 * @param {string} role
 * @returns {{role:string, fullAccess:boolean, known:boolean, modules:string[], subModules:Object, permissions:Object}}
 */
function resolveRoleGrants(role) {
  const roleKey = normalizeRoleKey(role);
  const roleDefinition = ROLE_DEFINITIONS[roleKey];

  if (!roleDefinition) {
    return {
      role: roleKey,
      fullAccess: false,
      known: false,
      modules: [],
      subModules: {},
      permissions: {},
    };
  }

  const fullAccess = roleDefinition.fullAccess === true;

  // ---- modules -----------------------------------------------------------
  const declaredModules = roleDefinition.modules;
  const modules =
    fullAccess || declaredModules === '*'
      ? [...MODULE_KEYS]
      : Array.from(new Set(asStringArray(declaredModules).map(normalizeModuleKey).filter(Boolean)));

  // ---- submodules --------------------------------------------------------
  const declaredSubModules = roleDefinition.subModules;
  const subModules = {};
  if (fullAccess || declaredSubModules === '*') {
    Object.assign(subModules, allSubModules());
  } else {
    const map =
      declaredSubModules && typeof declaredSubModules === 'object' && !Array.isArray(declaredSubModules)
        ? declaredSubModules
        : {};
    // Default-open: a module the role can reach exposes all of its submenus
    // unless the matrix explicitly narrows them.
    for (const moduleKey of modules) {
      const declared = map[moduleKey];
      const allowed = Array.isArray(declared) ? declared : SUB_MODULE_KEYS_BY_MODULE[moduleKey] || [];
      subModules[moduleKey] = validSubModules(moduleKey, allowed);
    }
    // A role may declare submodule access for a module it does not hold by
    // default (Child Records for houseparent, say). Keep it, so granting the
    // module later does not also require editing the matrix.
    for (const [moduleKey, declared] of Object.entries(map)) {
      const canonical = normalizeModuleKey(moduleKey);
      if (subModules[canonical] || !Array.isArray(declared)) continue;
      subModules[canonical] = validSubModules(canonical, declared);
    }
  }

  // ---- permissions -------------------------------------------------------
  const declaredPermissions = roleDefinition.permissions;
  let permissions;
  if (fullAccess || declaredPermissions === '*') {
    permissions = { '*': [...PERMISSION_KEYS] };
  } else {
    const map =
      declaredPermissions && typeof declaredPermissions === 'object' && !Array.isArray(declaredPermissions)
        ? declaredPermissions
        : {};
    permissions = {};
    for (const [moduleKey, values] of Object.entries(map)) {
      const key = moduleKey === '*' ? '*' : normalizeModuleKey(moduleKey);
      permissions[key] = Array.from(
        new Set(asStringArray(values).map(normalizePermission).filter(Boolean)),
      );
    }
    if (!permissions['*']) permissions['*'] = [];
  }

  return { role: roleKey, fullAccess, known: true, modules, subModules, permissions };
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? asStringArray(parsed) : [trimmed];
    } catch {
      return [trimmed];
    }
  }
  return [];
}

/**
 * Normalise the stored submenu grant into a `{ module: [subModule] }` map.
 *
 * A JSON column reaches us in one of four shapes depending on the driver
 * version and how the row was read: an already-parsed object, a JSON string of
 * one, a flat array (the legacy `childRecordTabs` shape), or a JSON string of
 * one. Reading only the parsed-object case silently discards every stored
 * narrowing, which is how a withheld submenu reappears.
 */
function asSubModuleMap(value) {
  if (value === null || value === undefined) return null;

  let parsed = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (Array.isArray(parsed)) return { [CHILD_RECORD_TABS_MODULE]: parsed };
  if (parsed && typeof parsed === 'object') return parsed;
  return null;
}

/**
 * Merge a role's declared matrix with an account's per-user overrides into the
 * single snapshot every access check reads.
 *
 * A per-user override can only ever *narrow* a role for non-full-access roles,
 * except that an explicitly granted module always carries that role's declared
 * verbs. Full-access roles ignore overrides entirely — that is the bypass.
 *
 * @param {{role?:string, accessibleModules?:any, childRecordTabs?:any, subModules?:any, permissions?:any}} user
 */
function buildAccessSnapshot(user) {
  const roleKey = normalizeRoleKey(user?.role);
  const grants = resolveRoleGrants(roleKey);

  if (grants.fullAccess) {
    return {
      role: roleKey,
      fullAccess: true,
      // Legacy keys are included so a stored grant naming one of them still
      // resolves to a module the sidebar can open.
      modules: [...MODULE_KEYS, ...Object.keys(LEGACY_MODULE_ALIASES)],
      subModules: { ...grants.subModules },
      permissions: { '*': [...PERMISSION_KEYS] },
      permissionList: [...PERMISSION_KEYS],
    };
  }

  const requested = asStringArray(user?.accessibleModules);
  // An account with no stored grant list falls back to the role's matrix.
  const source = requested.length > 0 ? requested : grants.modules;
  const modules = Array.from(new Set(source.map(normalizeModuleKey).filter(Boolean)));

  const overrideMap = {};
  const storedOverrides = asSubModuleMap(user?.subModules);
  if (storedOverrides) {
    for (const [moduleKey, values] of Object.entries(storedOverrides)) {
      overrideMap[normalizeModuleKey(moduleKey)] = asStringArray(values);
    }
  }
  // `childRecordTabs` is the legacy, single-module form of the same grant and
  // wins for Child Records when present.
  if (user?.childRecordTabs !== undefined && user?.childRecordTabs !== null) {
    overrideMap[CHILD_RECORD_TABS_MODULE] = asStringArray(user.childRecordTabs);
  }

  const subModules = {};
  for (const moduleKey of modules) {
    const declared = grants.subModules[moduleKey];
    const fallback = declared !== undefined ? declared : SUB_MODULE_KEYS_BY_MODULE[moduleKey] || [];
    const override = overrideMap[moduleKey];
    const chosen = override !== undefined && override.length > 0 ? override : fallback;
    subModules[moduleKey] = Array.from(
      new Set(chosen.filter((sub) => (SUB_MODULE_KEYS_BY_MODULE[moduleKey] || []).includes(sub))),
    );
  }

  const permissionList = Array.from(
    new Set([
      ...(grants.permissions['*'] || []),
      ...modules.flatMap((moduleKey) => grants.permissions[moduleKey] || []),
    ]),
  );

  return {
    role: roleKey,
    fullAccess: false,
    modules,
    subModules,
    permissions: { ...grants.permissions },
    permissionList,
  };
}

function isSnapshot(snapshot) {
  return Boolean(snapshot && typeof snapshot === 'object' && 'fullAccess' in snapshot);
}

/** Accepts a snapshot or a raw user object. */
function toSnapshot(subject) {
  return isSnapshot(subject) ? subject : buildAccessSnapshot(subject);
}

/** Does the subject hold the module? Full access always says yes. */
function hasModuleAccess(subject, module) {
  const snapshot = toSnapshot(subject);
  if (snapshot.fullAccess) return true;
  const key = normalizeModuleKey(module);
  if (!key) return false;
  // Compare canonically on both sides so a stored legacy grant (for example
  // 'Intervention Tracker') opens the module that now owns that feature.
  return (snapshot.modules || []).some((held) => normalizeModuleKey(held) === key);
}

/**
 * Does the subject hold the submenu? A module with no submenus always passes.
 * Full access always passes.
 */
function hasSubModuleAccess(subject, module, subModule) {
  const snapshot = toSnapshot(subject);
  if (snapshot.fullAccess) return true;

  const moduleKey = normalizeModuleKey(module);
  const known = SUB_MODULE_KEYS_BY_MODULE[moduleKey];
  if (!known || known.length === 0) return true;
  if (!subModule) return true;

  const key = String(subModule).trim();
  if (!known.includes(key)) return false;
  return (snapshot.subModules?.[moduleKey] || []).includes(key);
}

/**
 * Does the subject hold the permission on the module?
 *
 * `permission` may be a key (`'edit'`) or its label (`'Edit'`). The module gate
 * is checked first: the `"*"` baseline means "on every module I hold", so a
 * permission on a module the subject cannot open is never granted. Full access
 * returns true for every combination, including ones the definition does not
 * know about.
 */
function hasPermission(subject, module, permission) {
  const snapshot = toSnapshot(subject);
  if (snapshot.fullAccess) return true;

  const permissionKey = normalizePermission(permission);
  if (!permissionKey) return false;

  const moduleKey = normalizeModuleKey(module);
  if (!moduleKey) return false;
  if (!(snapshot.modules || []).some((held) => normalizeModuleKey(held) === moduleKey)) return false;

  const granted = snapshot.permissions || {};
  // Definition entries are stored under canonical module keys, so a caller
  // passing the legacy name resolves to the same entry.
  return (
    (granted[moduleKey] || []).includes(permissionKey) ||
    (granted['*'] || []).includes(permissionKey)
  );
}

/**
 * Single-call check used by controllers that already hold a snapshot:
 * `can(req.user.access, 'Violations', 'verify')`.
 */
function can(subject, module, permission, subModule) {
  if (!hasModuleAccess(subject, module)) return false;
  if (subModule !== undefined && !hasSubModuleAccess(subject, module, subModule)) return false;
  if (permission === undefined || permission === null) return true;
  return hasPermission(subject, module, permission);
}

/**
 * The menu tree reduced to what the subject may see — the payload the client
 * renders. Modules with no accessible submenu are dropped to their own entry
 * so a granted module is never invisible.
 */
function listAccessibleMenus(subject) {
  const snapshot = toSnapshot(subject);
  return MODULE_TREE.filter((module) => hasModuleAccess(snapshot, module.key)).map((module) => ({
    key: module.key,
    label: module.label,
    route: module.route,
    icon: module.icon,
    subModules: module.subModules
      .filter((sub) => hasSubModuleAccess(snapshot, module.key, sub.key))
      .map((sub) => ({ key: sub.key, label: sub.label, tab: sub.tab || null })),
  }));
}

/** The permissions a subject holds on a specific module. */
function permissionsFor(subject, module) {
  const snapshot = toSnapshot(subject);
  if (snapshot.fullAccess) return [...PERMISSION_KEYS];
  const moduleKey = normalizeModuleKey(module);
  return Array.from(
    new Set([...(snapshot.permissions?.['*'] || []), ...(snapshot.permissions?.[moduleKey] || [])]),
  );
}

/** Roles whose matrix includes the given permission on any module. */
function rolesWithPermission(permission) {
  const permissionKey = normalizePermission(permission);
  return ROLE_KEYS.filter((key) => {
    const grants = resolveRoleGrants(key);
    if (grants.fullAccess) return true;
    return Object.values(grants.permissions).some((list) => list.includes(permissionKey));
  });
}

module.exports = {
  RBAC_DEFINITION: definition,
  PERMISSIONS: PERMISSION_LABELS,
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  MODULE_TREE,
  MODULE_KEYS,
  MODULE_BY_KEY,
  SUB_MODULE_KEYS_BY_MODULE,
  LEGACY_MODULE_ALIASES,
  EXTRA_MODULE_ALIASES,
  ROLE_DEFINITIONS,
  ROLE_KEYS,
  ROLE_LABELS,
  FULL_ACCESS_ROLES,
  CHILD_RECORD_TABS_MODULE,
  normalizeRoleKey,
  normalizeModuleKey,
  normalizePermission,
  getRoleDefinition,
  isFullAccessRole,
  roleLabel,
  resolveRoleGrants,
  buildAccessSnapshot,
  toSnapshot,
  hasModuleAccess,
  hasSubModuleAccess,
  hasPermission,
  permissionsFor,
  rolesWithPermission,
  can,
  listAccessibleMenus,
  asStringArray,
  asSubModuleMap,
};
