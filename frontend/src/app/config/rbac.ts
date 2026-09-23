/**
 * RBAC — the client half of the permission model.
 *
 * This is a direct mirror of `backend/src/config/rbac.js` over the *same*
 * `rbac.definition.json` data (the file is kept byte-identical in both
 * packages; `backend/tests/rbac.test.js` fails if the two copies diverge).
 *
 * Two rules keep this honest:
 *
 * 1. **The server decides, the client renders.** When the API ships an access
 *    snapshot (`GET /api/rbac/me`, or the login payload) the client uses that
 *    verbatim. The resolver below only fills in while that snapshot is in
 *    flight or when talking to an older server. Re-deriving the rules
 *    independently is exactly how the sidebar and the API drift apart.
 * 2. **Adding a role is a data change.** Everything is driven by the
 *    definition, so a new role needs no edit here.
 */

import definition from './rbac.definition.json';

export type PermissionKey =
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'verify'
  | 'approve'
  | 'export'
  | 'manageUsers'
  | 'manageRoles'
  | 'manageSettings';

export interface SubModuleDefinition {
  key: string;
  label: string;
  /** In-page tab this submenu maps to, when the page has one. */
  tab?: string;
}

export interface ModuleDefinition {
  key: string;
  label: string;
  route: string;
  icon: string;
  legacyKeys?: string[];
  subModules: SubModuleDefinition[];
}

export interface RoleDefinition {
  label: string;
  fullAccess: boolean;
  description?: string;
  modules: string[] | '*';
  subModules: Record<string, string[]> | '*';
  permissions: Record<string, string[]> | '*';
}

/** Effective access for one account — the shape the API returns. */
export interface AccessSnapshot {
  role: string;
  fullAccess: boolean;
  modules: string[];
  subModules: Record<string, string[]>;
  permissions: Record<string, string[]>;
  permissionList: string[];
  /** Present when the server already filtered the tree (login / `/rbac/me`). */
  menus?: AccessibleMenu[];
}

/** A menu tree already filtered to what the account may see. */
export interface AccessibleMenu {
  key: string;
  label: string;
  route: string;
  icon: string;
  subModules: SubModuleDefinition[];
}

interface RbacDefinition {
  version: number;
  description?: string;
  permissions: Record<string, string>;
  modules: ModuleDefinition[];
  roles: Record<string, RoleDefinition>;
  childRecordTabsModule: string;
}

const RBAC_DEFINITION = definition as unknown as RbacDefinition;

export const PERMISSION_LABELS: Readonly<Record<string, string>> = RBAC_DEFINITION.permissions;
export const PERMISSION_KEYS: readonly string[] = Object.keys(RBAC_DEFINITION.permissions);

/** Canonical module tree, in the order the sidebar renders it. */
export const MODULE_TREE: readonly ModuleDefinition[] = RBAC_DEFINITION.modules;

export const MODULE_KEYS: readonly string[] = MODULE_TREE.map((module) => module.key);

const MODULE_BY_KEY: Record<string, ModuleDefinition> = MODULE_TREE.reduce(
  (accumulator, module) => {
    accumulator[module.key] = module;
    return accumulator;
  },
  {} as Record<string, ModuleDefinition>,
);

/** Submenu keys per module: `{ 'Child Records': ['Personal Info', …] }`. */
export const SUB_MODULE_KEYS_BY_MODULE: Readonly<Record<string, string[]>> = MODULE_TREE.reduce(
  (accumulator, module) => {
    accumulator[module.key] = module.subModules.map((sub) => sub.key);
    return accumulator;
  },
  {} as Record<string, string[]>,
);

export const MODULE_BY_LABEL: Readonly<Record<string, ModuleDefinition>> = MODULE_BY_KEY;

/** Legacy module names that stored grants may still carry. */
export const LEGACY_MODULE_ALIASES: Readonly<Record<string, string>> = MODULE_TREE.reduce(
  (accumulator, module) => {
    for (const legacy of module.legacyKeys || []) accumulator[legacy] = module.key;
    return accumulator;
  },
  {} as Record<string, string>,
);

/** Non-module aliases kept for storage written by earlier builds. */
export const EXTRA_MODULE_ALIASES: Readonly<Record<string, string>> = {
  Intervention: 'Intervention Tracker',
  'Case Progress': 'Education',
  'Education Progress': 'Education',
};

export const ROLE_DEFINITIONS: Readonly<Record<string, RoleDefinition>> = RBAC_DEFINITION.roles;
export const ROLE_KEYS: readonly string[] = Object.keys(RBAC_DEFINITION.roles);
export const ROLE_LABELS: Readonly<Record<string, string>> = ROLE_KEYS.reduce(
  (accumulator, key) => {
    accumulator[key] = ROLE_DEFINITIONS[key].label || key;
    return accumulator;
  },
  {} as Record<string, string>,
);

/** Roles flagged as a bypass in the definition. */
export const FULL_ACCESS_ROLES: readonly string[] = ROLE_KEYS.filter(
  (key) => ROLE_DEFINITIONS[key].fullAccess === true,
);

export const CHILD_RECORD_TABS_MODULE: string =
  RBAC_DEFINITION.childRecordTabsModule || 'Child Records';

const ROLE_ALIASES: Record<string, string> = {
  'center head': 'centerhead',
  center_head: 'centerhead',
  'center-head': 'centerhead',
  'social worker': 'socialworker',
  social_worker: 'socialworker',
  'house parent': 'houseparent',
  house_parent: 'houseparent',
  administrator: 'admin',
};

export function normalizeRoleKey(role?: string | null): string {
  const value = String(role || '').trim().toLowerCase();
  return ROLE_ALIASES[value] || value;
}

/** Resolve a possibly-legacy module name to its canonical key. */
export function normalizeModuleKey(module?: string | null): string {
  const trimmed = String(module || '').trim();
  if (!trimmed) return '';
  if (MODULE_BY_KEY[trimmed]) return trimmed;
  if (LEGACY_MODULE_ALIASES[trimmed]) return LEGACY_MODULE_ALIASES[trimmed];
  const viaExtra = EXTRA_MODULE_ALIASES[trimmed];
  if (viaExtra) return normalizeModuleKey(viaExtra);
  return trimmed;
}

/** Resolve a permission name or label to its canonical camelCase key. */
export function normalizePermission(permission?: string | null): string {
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

export function getRoleDefinition(role?: string | null): RoleDefinition | null {
  return ROLE_DEFINITIONS[normalizeRoleKey(role)] || null;
}

/** True when the role bypasses every permission check. */
export function isFullAccessRole(role?: string | null): boolean {
  const roleDefinition = getRoleDefinition(role);
  return Boolean(roleDefinition && roleDefinition.fullAccess === true);
}

export function roleLabel(role?: string | null): string {
  return ROLE_LABELS[normalizeRoleKey(role)] || String(role || '');
}

function allSubModules(): Record<string, string[]> {
  return MODULE_KEYS.reduce((accumulator, moduleKey) => {
    accumulator[moduleKey] = [...SUB_MODULE_KEYS_BY_MODULE[moduleKey]];
    return accumulator;
  }, {} as Record<string, string[]>);
}

function asStringArray(value: unknown): string[] {
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
 * Normalise a stored submenu grant into a `{ module: [subModule] }` map.
 *
 * The value may arrive as a parsed object, a JSON string of one, a flat array
 * (the legacy `childRecordTabs` shape), or a JSON string of one. Handling only
 * the parsed-object case silently discards every stored narrowing.
 */
function asSubModuleMap(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;

  let parsed: unknown = value;
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
  if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  return null;
}

/**
 * Expand a role's declared access matrix into concrete grants.
 * `"*"` means "everything in the definition" and is a *grant*, not a bypass —
 * only `fullAccess: true` bypasses checks.
 */
export function resolveRoleGrants(role?: string | null): AccessSnapshot & { known: boolean } {
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
      permissionList: [],
    };
  }

  const fullAccess = roleDefinition.fullAccess === true;

  const declaredModules = roleDefinition.modules;
  const modules =
    fullAccess || declaredModules === '*'
      ? [...MODULE_KEYS]
      : Array.from(
          new Set(asStringArray(declaredModules).map(normalizeModuleKey).filter(Boolean)),
        );

  const subModules: Record<string, string[]> = {};
  const declaredSubModules = roleDefinition.subModules;
  if (fullAccess || declaredSubModules === '*') {
    Object.assign(subModules, allSubModules());
  } else {
    const map =
      declaredSubModules && typeof declaredSubModules === 'object' ? declaredSubModules : {};
    for (const moduleKey of modules) {
      const declared = map[moduleKey];
      // Default-open: a reachable module exposes all of its submenus unless the
      // matrix explicitly narrows them.
      const allowed = Array.isArray(declared)
        ? declared
        : SUB_MODULE_KEYS_BY_MODULE[moduleKey] || [];
      subModules[moduleKey] = validSubModules(moduleKey, allowed);
    }
    for (const [moduleKey, declared] of Object.entries(map)) {
      const canonical = normalizeModuleKey(moduleKey);
      if (subModules[canonical] || !Array.isArray(declared)) continue;
      subModules[canonical] = validSubModules(canonical, declared);
    }
  }

  const declaredPermissions = roleDefinition.permissions;
  let permissions: Record<string, string[]>;
  if (fullAccess || declaredPermissions === '*') {
    permissions = { '*': [...PERMISSION_KEYS] };
  } else {
    const map =
      declaredPermissions && typeof declaredPermissions === 'object' ? declaredPermissions : {};
    permissions = {};
    for (const [moduleKey, values] of Object.entries(map)) {
      const key = moduleKey === '*' ? '*' : normalizeModuleKey(moduleKey);
      permissions[key] = Array.from(
        new Set(asStringArray(values).map(normalizePermission).filter(Boolean)),
      );
    }
    if (!permissions['*']) permissions['*'] = [];
  }

  const permissionList = Array.from(
    new Set([
      ...(permissions['*'] || []),
      ...modules.flatMap((moduleKey) => permissions[moduleKey] || []),
    ]),
  );

  return { role: roleKey, fullAccess, known: true, modules, subModules, permissions, permissionList };
}

function validSubModules(moduleKey: string, declared: unknown): string[] {
  const known = SUB_MODULE_KEYS_BY_MODULE[moduleKey] || [];
  return Array.from(new Set(asStringArray(declared).filter((sub) => known.includes(sub))));
}

/** Inputs the snapshot is built from. */
export interface AccessSubject {
  role?: string | null;
  accessibleModules?: string[] | string | null;
  childRecordTabs?: string[] | string | null;
  subModules?: Record<string, string[]> | string[] | string | null;
}

function isSnapshot(subject: unknown): subject is AccessSnapshot {
  return Boolean(subject && typeof subject === 'object' && 'fullAccess' in (subject as object));
}

/** Merge a role's matrix with an account's stored overrides. */
export function buildAccessSnapshot(subject?: AccessSubject | AccessSnapshot | null): AccessSnapshot {
  if (isSnapshot(subject)) return subject;

  const roleKey = normalizeRoleKey(subject?.role);
  const grants = resolveRoleGrants(roleKey);

  if (grants.fullAccess) {
    return {
      role: roleKey,
      fullAccess: true,
      modules: [...MODULE_KEYS, ...Object.keys(LEGACY_MODULE_ALIASES)],
      subModules: { ...grants.subModules },
      permissions: { '*': [...PERMISSION_KEYS] },
      permissionList: [...PERMISSION_KEYS],
    };
  }

  const requested = asStringArray(subject?.accessibleModules);
  const source = requested.length > 0 ? requested : grants.modules;
  const modules = Array.from(new Set(source.map(normalizeModuleKey).filter(Boolean)));

  const overrideMap: Record<string, string[]> = {};
  const storedOverrides = asSubModuleMap(subject?.subModules);
  if (storedOverrides) {
    for (const [moduleKey, values] of Object.entries(storedOverrides)) {
      overrideMap[normalizeModuleKey(moduleKey)] = asStringArray(values);
    }
  }
  // `childRecordTabs` is the legacy, single-module form of the same grant and
  // wins for Child Records when present.
  if (subject?.childRecordTabs !== undefined && subject?.childRecordTabs !== null) {
    overrideMap[CHILD_RECORD_TABS_MODULE] = asStringArray(subject.childRecordTabs);
  }

  const subModules: Record<string, string[]> = {};
  for (const moduleKey of modules) {
    const declared = grants.subModules[moduleKey];
    const fallback = declared !== undefined ? declared : SUB_MODULE_KEYS_BY_MODULE[moduleKey] || [];
    const override = overrideMap[moduleKey];
    const chosen = override !== undefined && override.length > 0 ? override : fallback;
    subModules[moduleKey] = validSubModules(moduleKey, chosen);
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

function toSnapshot(subject?: AccessSubject | AccessSnapshot | null): AccessSnapshot {
  return buildAccessSnapshot(subject);
}

/** Does the subject hold the module? Full access always says yes. */
export function hasModuleAccess(
  subject: AccessSubject | AccessSnapshot | null | undefined,
  module?: string | null,
): boolean {
  const snapshot = toSnapshot(subject);
  if (snapshot.fullAccess) return true;
  const key = normalizeModuleKey(module);
  if (!key) return false;
  return snapshot.modules.some((held) => normalizeModuleKey(held) === key);
}

/** Does the subject hold the submenu? A module with no submenus always passes. */
export function hasSubModuleAccess(
  subject: AccessSubject | AccessSnapshot | null | undefined,
  module?: string | null,
  subModule?: string | null,
): boolean {
  const snapshot = toSnapshot(subject);
  if (snapshot.fullAccess) return true;

  const moduleKey = normalizeModuleKey(module);
  const known = SUB_MODULE_KEYS_BY_MODULE[moduleKey];
  if (!known || known.length === 0) return true;
  if (!subModule) return true;

  const key = String(subModule).trim();
  if (!known.includes(key)) return false;
  return (snapshot.subModules[moduleKey] || []).includes(key);
}

/**
 * Does the subject hold the permission on the module?
 *
 * The module gate is checked first: the `"*"` baseline means "on every module I
 * hold", so a permission on a module the subject cannot open is never granted.
 */
export function hasPermission(
  subject: AccessSubject | AccessSnapshot | null | undefined,
  module?: string | null,
  permission?: string | null,
): boolean {
  const snapshot = toSnapshot(subject);
  if (snapshot.fullAccess) return true;

  const permissionKey = normalizePermission(permission);
  if (!permissionKey) return false;

  const moduleKey = normalizeModuleKey(module);
  if (!moduleKey) return false;
  if (!snapshot.modules.some((held) => normalizeModuleKey(held) === moduleKey)) return false;

  return (
    (snapshot.permissions[moduleKey] || []).includes(permissionKey) ||
    (snapshot.permissions['*'] || []).includes(permissionKey)
  );
}

/** One-call check: `can(user, 'Violations', 'verify')`. */
export function can(
  subject: AccessSubject | AccessSnapshot | null | undefined,
  module?: string | null,
  permission?: string | null,
  subModule?: string | null,
): boolean {
  if (!hasModuleAccess(subject, module)) return false;
  if (subModule !== undefined && subModule !== null && !hasSubModuleAccess(subject, module, subModule)) {
    return false;
  }
  if (permission === undefined || permission === null || permission === '') return true;
  return hasPermission(subject, module, permission);
}

/** The menu tree reduced to what the subject may see. */
export function listAccessibleMenus(
  subject: AccessSubject | AccessSnapshot | null | undefined,
): AccessibleMenu[] {
  const snapshot = toSnapshot(subject);
  return MODULE_TREE.filter((module) => hasModuleAccess(snapshot, module.key)).map((module) => ({
    key: module.key,
    label: module.label,
    route: module.route,
    icon: module.icon,
    subModules: module.subModules
      .filter((sub) => hasSubModuleAccess(snapshot, module.key, sub.key))
      .map((sub) => ({ key: sub.key, label: sub.label, tab: sub.tab })),
  }));
}

/** The permissions a subject holds on a specific module. */
export function permissionsFor(
  subject: AccessSubject | AccessSnapshot | null | undefined,
  module?: string | null,
): string[] {
  const snapshot = toSnapshot(subject);
  if (snapshot.fullAccess) return [...PERMISSION_KEYS];
  const moduleKey = normalizeModuleKey(module);
  return Array.from(
    new Set([...(snapshot.permissions['*'] || []), ...(snapshot.permissions[moduleKey] || [])]),
  );
}

/** Roles whose matrix includes the given permission. */
export function rolesWithPermission(permission: string): string[] {
  const permissionKey = normalizePermission(permission);
  return ROLE_KEYS.filter((key) => {
    const grants = resolveRoleGrants(key);
    if (grants.fullAccess) return true;
    return Object.values(grants.permissions).some((list) => list.includes(permissionKey));
  });
}

export { RBAC_DEFINITION };
