/**
 * Canonical module/access configuration.
 *
 * The permission *matrix* now lives in `app/config/rbac.definition.json` and is
 * resolved by `app/config/rbac.ts`. This file keeps the flat, storage-shaped
 * view of it that `users.accessibleModules` / `users.childRecordTabs` are
 * written in, plus the hierarchy-aware helpers the sidebar and Account
 * Management use.
 *
 * Everything here is derived from the definition except `AVAILABLE_MODULES` and
 * `DEFAULT_MODULE_ACCESS`, which stay explicit because they are the *storage
 * format* — their order and spelling are what existing rows and browser
 * storage already contain. `backend/tests/rbac.test.js` asserts both are
 * consistent with the definition, so they cannot silently drift.
 */

import {
  CHILD_RECORD_TABS_MODULE,
  EXTRA_MODULE_ALIASES,
  LEGACY_MODULE_ALIASES,
  MODULE_KEYS,
  MODULE_TREE,
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  ROLE_DEFINITIONS,
  ROLE_KEYS,
  ROLE_LABELS,
  SUB_MODULE_KEYS_BY_MODULE,
  buildAccessSnapshot,
  can as rbacCan,
  hasModuleAccess,
  hasPermission,
  hasSubModuleAccess,
  isFullAccessRole as rbacIsFullAccessRole,
  listAccessibleMenus,
  normalizeModuleKey,
  permissionsFor,
  resolveRoleGrants,
  type AccessSnapshot,
  type AccessibleMenu,
  type AccessSubject,
} from './rbac';

// ── Re-exports ───────────────────────────────────────────────────────────────
// Consumers can reach the whole model through this module, so nothing has to
// import `rbac.ts` directly just to read the hierarchy.
export {
  MODULE_TREE,
  MODULE_KEYS,
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  ROLE_DEFINITIONS,
  ROLE_KEYS,
  ROLE_LABELS,
  SUB_MODULE_KEYS_BY_MODULE,
  CHILD_RECORD_TABS_MODULE,
  buildAccessSnapshot,
  hasModuleAccess,
  hasPermission,
  hasSubModuleAccess,
  listAccessibleMenus,
  normalizeModuleKey,
  permissionsFor,
  resolveRoleGrants,
};
export type { AccessSnapshot, AccessibleMenu, AccessSubject };

/** Canonical module order used by Account Management and navigation. */
export const AVAILABLE_MODULES = [
  'Dashboard',
  'Child Records',
  'Violations',
  'Intervention Tracker',
  'Documents',
  'Activities',
  'Assessments',
  'Court Records',
  'Houseparent',
  'Health',
  'Education',
  'Reports',
  'Account Management',
] as const;

/**
 * Compatibility alias used by AuthContext and other access-control code.
 * Exported as an array, not a new copy, so it stays synchronized with the
 * canonical module definition.
 */
export const CANONICAL_MODULE_ACCESS = AVAILABLE_MODULES;

/**
 * Module label -> application route, derived from the hierarchy so a new
 * module's route cannot be forgotten here.
 */
export const MODULE_ROUTES: Record<string, string> = {
  ...MODULE_TREE.reduce<Record<string, string>>((accumulator, module) => {
    accumulator[module.key] = module.route;
    return accumulator;
  }, {}),
  // Legacy aliases retained so older stored permissions do not crash routing.
  ...Object.fromEntries(
    Object.entries(LEGACY_MODULE_ALIASES).map(([legacy, canonical]) => [
      legacy,
      MODULE_TREE.find((module) => module.key === canonical)?.route || '/dashboard',
    ]),
  ),
  // Kept for compatibility with installations that still expose the legacy
  // standalone route. The consolidated Violations screen can also render
  // this feature as a tab without changing the access vocabulary.
  'Intervention Tracker': '/intervention-tracker',
};

/** Default Child Records tab access by role, read from the role matrix. */
export const CHILD_RECORD_TAB_ORDER: readonly string[] =
  SUB_MODULE_KEYS_BY_MODULE[CHILD_RECORD_TABS_MODULE] || [];

export const DEFAULT_CHILD_TAB_ACCESS: Record<string, string[]> = ROLE_KEYS.reduce(
  (accumulator, role) => {
    accumulator[role] = [...(resolveRoleGrants(role).subModules[CHILD_RECORD_TABS_MODULE] || [])];
    return accumulator;
  },
  {} as Record<string, string[]>,
);

/**
 * Default submenu access by role, per module — the hierarchy-aware form of
 * `DEFAULT_CHILD_TAB_ACCESS`.
 */
export const DEFAULT_SUBMODULE_ACCESS: Record<string, Record<string, string[]>> = ROLE_KEYS.reduce(
  (accumulator, role) => {
    const grants = resolveRoleGrants(role).subModules;
    accumulator[role] = Object.entries(grants).reduce<Record<string, string[]>>(
      (inner, [module, subModules]) => {
        inner[module] = [...subModules];
        return inner;
      },
      {},
    );
    return accumulator;
  },
  {} as Record<string, Record<string, string[]>>,
);

/**
 * Default module access by role.
 *
 * These are the *storage* defaults — what a newly created account starts with,
 * and what the browser falls back to when a stored grant is unreadable. The
 * permission matrix in `rbac.definition.json` is the authority; this list must
 * name exactly the modules that matrix declares for the role. A role listed
 * here with a module its matrix does not declare is an over-grant, and the
 * backend test `the frontend DEFAULT_MODULE_ACCESS agrees with the role matrix`
 * fails on it.
 *
 * The Quarterly Progress Report has no module of its own — it is a card inside
 * the Reports module. Roles that may be assigned a Developmental Aspect
 * therefore hold 'Reports'; the Psychological Staff does not, because its
 * specification grants no Reports access. A Psychological Staff who needs to work a
 * QPR section is a workflow decision, not a default to be guessed at here.
 *
 * The module gate controls the *page*, not the data. What an assignee can
 * actually see and edit is decided per section by the backend — a non-reviewer
 * receives only the sections assigned to them (see
 * `backend/src/controllers/quarterlyProgressReportController.js`). A Center Head
 * can still revoke a module per account in Account Management.
 */
export const DEFAULT_MODULE_ACCESS: Record<string, string[]> = {
  centerhead: [...AVAILABLE_MODULES],
  nurse: ['Dashboard', 'Child Records', 'Health', 'Documents'],
  psychologist: ['Dashboard', 'Child Records', 'Violations', 'Assessments', 'Documents'],
  educator: ['Dashboard', 'Child Records', 'Education', 'Documents'],
  socialworker: [
    'Dashboard',
    'Child Records',
    'Violations',
    'Intervention Tracker',
    'Activities',
    'Assessments',
    'Houseparent',
    'Documents',
    'Court Records',
    'Reports',
  ],
  houseparent: [
    'Dashboard',
    'Violations',
    'Activities',
    'Assessments',
    'Houseparent',
  ],
  admin: [...AVAILABLE_MODULES],
};

/**
 * Legacy module names that may still exist in browser storage or older rows.
 * New code should persist only canonical names.
 */
export const MODULE_ALIASES: Record<string, string> = {
  ...LEGACY_MODULE_ALIASES,
  ...EXTRA_MODULE_ALIASES,
  TRI: 'Houseparent',
  'Case Progress': 'Education',
  'Education Progress': 'Education',
};

function normalizeModuleName(module?: string | null): string {
  return normalizeModuleKey(module);
}

/**
 * Normalize an entire stored module-access list to the canonical names used
 * by routing and Account Management. Legacy TRI/old Education labels are
 * converted here so callers do not need to repeat that logic.
 */
export function canonicalizeModules(
  modules?: readonly string[] | string | null,
): string[] {
  if (modules == null) return [];
  const values = Array.isArray(modules) ? modules : [modules];
  return Array.from(
    new Set(
      values
        .map((module) => normalizeModuleName(String(module)))
        .filter(Boolean),
    ),
  );
}

/**
 * Does this role hold every module? Full-access roles bypass the gate
 * entirely; a role whose matrix grants `"*"` (Administrator) holds them all.
 */
export function isFullAccessRole(role?: string | null): boolean {
  if (rbacIsFullAccessRole(role)) return true;
  const grants = resolveRoleGrants(role);
  return MODULE_KEYS.every((module) => grants.modules.includes(module));
}

export function resolveModuleAccess(
  role?: string | null,
  modules?: string[] | readonly string[] | null,
): string[] {
  if (Array.isArray(modules) && modules.length > 0) {
    return canonicalizeModules(modules);
  }

  const normalizedRole = String(role || '').trim().toLowerCase();
  return [...(DEFAULT_MODULE_ACCESS[normalizedRole] || ['Dashboard'])];
}

export function canOpenModule(
  role: string | null | undefined,
  modules: string[] | readonly string[] | null | undefined,
  module: string,
): boolean {
  if (isFullAccessRole(role)) return true;
  return resolveModuleAccess(role, modules).includes(normalizeModuleName(module));
}

/**
 * Canonicalize a per-module submenu grant, dropping names the module does not
 * actually have and following the module's declared submenu order.
 */
export function canonicalizeSubModules(
  module: string,
  value?: readonly string[] | string | null,
  fallback: readonly string[] = [],
): string[] {
  const moduleKey = normalizeModuleName(module);
  const order = SUB_MODULE_KEYS_BY_MODULE[moduleKey] || [];
  const requested = Array.isArray(value) ? value : value ? [value] : [];
  const source = requested.length > 0 ? requested : fallback;
  const unique = new Set(source.map((item) => String(item || '').trim()).filter(Boolean));
  return order.filter((sub) => unique.has(sub));
}

/** Canonicalize a whole `{ module: [subModule] }` map. */
export function canonicalizeSubModuleMap(
  value?: Record<string, readonly string[]> | null,
  fallback: Record<string, readonly string[]> = {},
): Record<string, string[]> {
  const source = value && typeof value === 'object' ? value : fallback;
  const result: Record<string, string[]> = {};
  for (const [module, subModules] of Object.entries(source || {})) {
    const moduleKey = normalizeModuleName(module);
    if (!SUB_MODULE_KEYS_BY_MODULE[moduleKey]) continue;
    result[moduleKey] = canonicalizeSubModules(moduleKey, subModules);
  }
  return result;
}

/**
 * The submenus a role/account may see inside a module. Defaults to the role's
 * declared set when no per-account grant is stored.
 */
export function resolveSubModuleAccess(
  role?: string | null,
  module?: string | null,
  subModules?: Record<string, readonly string[]> | null,
): string[] {
  const moduleKey = normalizeModuleName(module);
  if (!moduleKey) return [];

  if (subModules && typeof subModules === 'object') {
    const raw = subModules[moduleKey];
    if (Array.isArray(raw)) return canonicalizeSubModules(moduleKey, raw);
  }

  const grants = resolveRoleGrants(role).subModules[moduleKey];
  if (grants) return [...grants];
  // Default-open, matching the resolver.
  return [...(SUB_MODULE_KEYS_BY_MODULE[moduleKey] || [])];
}

export function canOpenSubModule(
  role: string | null | undefined,
  modules: string[] | readonly string[] | null | undefined,
  module: string,
  subModule: string,
  subModules?: Record<string, readonly string[]> | null,
): boolean {
  if (!canOpenModule(role, modules, module)) return false;
  if (isFullAccessRole(role)) return true;
  return resolveSubModuleAccess(role, module, subModules).includes(subModule);
}

/**
 * Build the effective snapshot for a user object shaped like the one
 * `AuthContext` holds. Prefer the server's snapshot when it is present — this
 * is the offline fallback, not a second opinion.
 */
export function accessForUser(
  user?:
    | (AccessSubject & { access?: AccessSnapshot | null })
    | null,
): AccessSnapshot {
  if (user?.access && typeof user.access === 'object' && 'fullAccess' in user.access) {
    return user.access;
  }
  return buildAccessSnapshot(user || {});
}

/** One-call capability check against a user object from `AuthContext`. */
export function userCan(
  user?: (AccessSubject & { access?: AccessSnapshot | null }) | null,
  module?: string | null,
  permission?: string | null,
  subModule?: string | null,
): boolean {
  return rbacCan(accessForUser(user), module, permission, subModule);
}

/** The menu tree reduced to what this user may see. */
export function accessibleMenusFor(
  user?: (AccessSubject & { access?: AccessSnapshot | null }) | null,
): AccessibleMenu[] {
  return listAccessibleMenus(accessForUser(user));
}
