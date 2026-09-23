/**
 * Role/module default grants.
 *
 * The permission *matrix* lives in `config/rbac.definition.json`; this file
 * keeps the flat, storage-shaped view of it that `users.accessibleModules` /
 * `users.childRecordTabs` are written in, so existing rows and browser storage
 * keep working untouched.
 *
 * `MODULE_ORDER` is the storage order of the flat list. It must contain every
 * canonical module plus the legacy aliases; `tests/rbac.test.js` asserts that,
 * so a module added to the definition cannot be silently dropped here.
 */
const rbac = require('../config/rbac');

const MODULE_ORDER = [
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
];

/** Module order for the hierarchy-aware consumers (the sidebar, Account Management). */
const MODULE_TREE = rbac.MODULE_TREE;

/** Submenu order per module, keyed by canonical module name. */
const SUB_MODULE_ORDER_BY_MODULE = rbac.SUB_MODULE_KEYS_BY_MODULE;

const CHILD_RECORD_TAB_ORDER = [...(rbac.SUB_MODULE_KEYS_BY_MODULE[rbac.CHILD_RECORD_TABS_MODULE] || [])];

const DEFAULT_MODULE_ACCESS = Object.freeze({
  centerhead: MODULE_ORDER,
  nurse: ['Dashboard', 'Child Records', 'Health', 'Documents'],
  psychologist: ['Dashboard', 'Child Records', 'Violations', 'Assessments', 'Documents'],
  educator: ['Dashboard', 'Child Records', 'Education', 'Documents'],
  socialworker: ['Dashboard', 'Child Records', 'Violations', 'Intervention Tracker', 'Activities', 'Assessments', 'Houseparent', 'Documents', 'Court Records', 'Reports'],
  houseparent: ['Dashboard', 'Violations', 'Activities', 'Assessments', 'Houseparent'],
});

const DEFAULT_CHILD_RECORD_TABS = Object.freeze({
  centerhead: CHILD_RECORD_TAB_ORDER,
  nurse: ['Personal Info', 'Phase Timeline', 'Medical'],
  psychologist: ['Personal Info', 'Phase Timeline', 'Medical', 'Behavioral'],
  educator: ['Personal Info', 'Education'],
  socialworker: ['Personal Info', 'Phase Timeline', 'Education', 'Medical', 'Behavioral'],
});

/**
 * Default submenu grants per role, per module — the hierarchy-aware form of
 * `DEFAULT_CHILD_RECORD_TABS`. Derived from the role matrix so the two can
 * never disagree.
 */
const DEFAULT_SUBMODULE_ACCESS = Object.freeze(
  rbac.ROLE_KEYS.reduce((accumulator, role) => {
    accumulator[role] = Object.freeze({ ...rbac.resolveRoleGrants(role).subModules });
    return accumulator;
  }, {}),
);

const MODULE_ALIASES = Object.freeze({
  TRI: 'Houseparent',
  Intervention: 'Intervention Tracker',
});

const TAB_ALIASES = Object.freeze({
  'Case Progress': 'Education',
  'Education Progress': 'Education',
});

function canonicalizeModules(value, fallback = []) {
  const raw = Array.isArray(value) ? value : fallback;
  const mapped = raw
    .map(item => MODULE_ALIASES[String(item || '').trim()] || String(item || '').trim())
    .filter(Boolean);
  const unique = new Set(mapped);
  return MODULE_ORDER.filter(module => unique.has(module));
}

function canonicalizeTabs(value, fallback = []) {
  const raw = Array.isArray(value) ? value : fallback;
  const mapped = raw
    .map(item => TAB_ALIASES[String(item || '').trim()] || String(item || '').trim())
    .filter(Boolean);
  const unique = new Set(mapped);
  return CHILD_RECORD_TAB_ORDER.filter(tab => unique.has(tab));
}

/**
 * Canonicalize a per-module submenu grant.
 * Unknown submenu names are dropped, and the result follows the module's
 * declared submenu order so two identical grants always compare equal.
 *
 * @param {string} module - Canonical module name
 * @param {unknown} value - Stored grant (array, JSON string, or undefined)
 * @param {string[]} [fallback] - Used when `value` holds nothing usable
 */
function canonicalizeSubModules(module, value, fallback = []) {
  const moduleKey = rbac.normalizeModuleKey(module);
  const order = SUB_MODULE_ORDER_BY_MODULE[moduleKey] || [];
  const requested = rbac.asStringArray(value);
  const source = requested.length > 0 ? requested : fallback;
  const unique = new Set(source.map(item => String(item || '').trim()).filter(Boolean));
  return order.filter(sub => unique.has(sub));
}

/**
 * Canonicalize a whole `{ module: [subModule] }` map, keeping only modules the
 * definition knows and only that module's real submenus.
 */
function canonicalizeSubModuleMap(value, fallback = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  const result = {};
  for (const [module, subModules] of Object.entries(source || {})) {
    const moduleKey = rbac.normalizeModuleKey(module);
    if (!SUB_MODULE_ORDER_BY_MODULE[moduleKey]) continue;
    result[moduleKey] = canonicalizeSubModules(moduleKey, subModules);
  }
  return result;
}

function defaultsForRole(role) {
  const key = String(role || '').trim().toLowerCase();
  const modules = [...(DEFAULT_MODULE_ACCESS[key] || ['Dashboard'])];
  return {
    modules,
    // The tab defaults are only meaningful for a role that actually holds Child
    // Records. Handing them to every role was a trap of the same shape the
    // Houseparent entry used to carry: the value is inert while the module is
    // withheld, but the moment Child Records is granted the account silently
    // opens every tab — Medical included. Gating on the module means a role
    // cannot hold tabs for a module its matrix does not declare.
    childRecordTabs: modules.includes(rbac.CHILD_RECORD_TABS_MODULE)
      ? [...(DEFAULT_CHILD_RECORD_TABS[key] || CHILD_RECORD_TAB_ORDER)]
      : [],
    subModules: { ...(DEFAULT_SUBMODULE_ACCESS[key] || {}) },
    permissions: rbac.resolveRoleGrants(key).permissions,
    fullAccess: rbac.isFullAccessRole(key),
  };
}

module.exports = {
  MODULE_ORDER,
  MODULE_TREE,
  SUB_MODULE_ORDER_BY_MODULE,
  CHILD_RECORD_TAB_ORDER,
  DEFAULT_MODULE_ACCESS,
  DEFAULT_CHILD_RECORD_TABS,
  DEFAULT_SUBMODULE_ACCESS,
  MODULE_ALIASES,
  TAB_ALIASES,
  canonicalizeModules,
  canonicalizeTabs,
  canonicalizeSubModules,
  canonicalizeSubModuleMap,
  defaultsForRole,
};
