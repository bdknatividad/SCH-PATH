/**
 * RBAC tests.
 *
 * The permission model is the security boundary for the whole application, so
 * these tests cover it at four levels:
 *
 *  1. **The definition itself** — the hierarchy, the permission vocabulary and
 *     the role matrix are asserted against the specification literally, and the
 *     frontend's copy is asserted byte-identical to the backend's.
 *  2. **The resolver** — every access decision, including the Center Head
 *     bypass, per-account narrowing and legacy alias handling.
 *  3. **The middleware and `authorize()`** — the guards routes actually use.
 *  4. **HTTP** — the real Express app, so the model is proven end to end.
 *
 * Plus an **extensibility proof**: a role and a module are injected into a
 * patched definition and shown to resolve with no code change. That is the
 * requirement this system exists to satisfy — more roles are coming.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const TEST_SECRET = 'rbac-test-secret-value-long-enough-to-sign';
process.env.JWT_SECRET = TEST_SECRET;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const DB_MODULE_PATH = require.resolve('../src/config/database');
const ROUTES_MODULE_PATH = require.resolve('../src/routes');
const DEFINITION_PATH = require.resolve('../src/config/rbac.definition.json');
const RBAC_MODULE_PATH = require.resolve('../src/config/rbac');

const rbac = require('../src/config/rbac');
const accessDefaults = require('../src/utils/accessDefaults');
const { requirePermission, requireSubModule, requireModule, snapshotFor } = require('../src/middleware/rbac');
const { authorize, authenticate } = require('../src/middleware/auth');
const { ApiError } = require('../src/middleware/errorHandler');

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(REPO_ROOT, relativePath));
}

// ─────────────────────────── 1. the definition ───────────────────────────────

/**
 * The module hierarchy exactly as specified. Order matters: it is the order the
 * sidebar renders in.
 */
const EXPECTED_HIERARCHY = [
  { key: 'Dashboard', subModules: [] },
  {
    key: 'Child Records',
    subModules: ['Personal Info', 'Phase Timeline', 'Education', 'Medical', 'Behavioral'],
  },
  {
    key: 'Violations',
    subModules: [
      'Violation List',
      'Intervention Tracker',
      'For Verification',
      'Manage Violations & Interventions',
      // Rendered by Violations.tsx as `?tab=anecdotal` for Houseparents, but it had
      // no declaration, so `hasSubModuleAccess` answered false for it and the tab
      // could never be granted.
      'Anecdotal Reports',
    ],
  },
  { key: 'Activities', subModules: [] },
  { key: 'Assessments', subModules: [] },
  { key: 'Court Records', subModules: [] },
  {
    key: 'Houseparent',
    subModules: ['Case Load', 'TRI Records', 'Anecdotal Reports'],
  },
  {
    key: 'Documents',
    subModules: [
      'Folders by Child',
      'All Documents',
      'Pending Review',
      // Rendered by DocumentUpload.tsx as `?tab=access`; undeclared for the same
      // reason as the Violations tab above.
      'Access Requests',
      // The permanent audit trail of completed (Approved / Rejected) requests.
      // Rendered as `?tab=history` and granted to the Center Head (full access)
      // and the Social Worker.
      'Access Request History',
    ],
  },
  { key: 'Health', subModules: [] },
  { key: 'Education', subModules: [] },
  { key: 'Reports', subModules: [] },
  { key: 'Account Management', subModules: [] },
];

/** The permission vocabulary exactly as specified. */
const EXPECTED_PERMISSIONS = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  verify: 'Verify',
  approve: 'Approve',
  export: 'Export',
  manageUsers: 'Manage Users',
  manageRoles: 'Manage Roles',
  manageSettings: 'Manage Settings',
};

test('the module hierarchy matches the specification exactly', () => {
  const actual = rbac.MODULE_TREE.map((module) => ({
    key: module.key,
    subModules: module.subModules.map((sub) => sub.key),
  }));
  assert.deepEqual(actual, EXPECTED_HIERARCHY);
});

test('every module carries a route and an icon so the sidebar can render it', () => {
  for (const module of rbac.MODULE_TREE) {
    assert.ok(module.label, `${module.key} needs a label`);
    assert.match(module.route, /^\//, `${module.key} needs an absolute route`);
    assert.ok(module.icon, `${module.key} needs an icon`);
  }
  // Routes must be unique — two modules sharing one would shadow each other.
  const routes = rbac.MODULE_TREE.map((module) => module.route);
  assert.equal(new Set(routes).size, routes.length, 'module routes must be unique');
});

test('the permission vocabulary matches the specification exactly', () => {
  assert.deepEqual(rbac.PERMISSION_LABELS, EXPECTED_PERMISSIONS);
  assert.deepEqual([...rbac.PERMISSION_KEYS], Object.keys(EXPECTED_PERMISSIONS));
});

test('centerhead is declared as the full-access baseline role', () => {
  const role = rbac.ROLE_DEFINITIONS.centerhead;
  assert.ok(role, 'centerhead must exist in the definition');
  assert.equal(role.fullAccess, true, 'centerhead must be a full-access role');
  assert.equal(role.modules, '*');
  assert.equal(role.subModules, '*');
  assert.equal(role.permissions, '*');
  assert.ok(rbac.FULL_ACCESS_ROLES.includes('centerhead'));
});

test('every declared role is resolvable and declares its grants', () => {
  assert.ok(rbac.ROLE_KEYS.length >= 1);
  for (const role of rbac.ROLE_KEYS) {
    const definition = rbac.ROLE_DEFINITIONS[role];
    assert.ok(definition.label, `${role} needs a label`);
    assert.equal(typeof definition.fullAccess, 'boolean', `${role}.fullAccess must be a boolean`);

    const grants = rbac.resolveRoleGrants(role);
    assert.equal(grants.known, true, `${role} must resolve`);
    if (!definition.fullAccess) {
      assert.ok(grants.modules.length > 0, `${role} must hold at least one module`);
    }
  }
});

test('the frontend keeps a byte-identical copy of the definition', () => {
  const frontendDefinition = 'frontend/src/app/config/rbac.definition.json';
  assert.ok(exists(frontendDefinition), 'the frontend must ship the shared definition');
  assert.equal(
    read(frontendDefinition),
    read('backend/src/config/rbac.definition.json'),
    'the two definition copies have diverged — the frontend would enforce a different model',
  );
});

test('the storage-shaped module list still covers every module in the definition', () => {
  // `MODULE_ORDER` is the order `users.accessibleModules` is written in. It is
  // explicit (order is a storage decision) but must not silently miss a module
  // that the definition added.
  for (const moduleKey of rbac.MODULE_KEYS) {
    assert.ok(accessDefaults.MODULE_ORDER.includes(moduleKey), `MODULE_ORDER is missing ${moduleKey}`);
  }
  // And a stored legacy grant must survive canonicalization rather than being
  // dropped — dropping it would silently revoke access on upgrade.
  for (const legacy of Object.keys(rbac.LEGACY_MODULE_ALIASES)) {
    const canonicalized = accessDefaults.canonicalizeModules([legacy]);
    assert.ok(
      canonicalized.length > 0,
      `a stored grant of "${legacy}" would be dropped by canonicalization`,
    );
  }
});

test('the storage defaults never grant a module its role does not declare', () => {
  for (const [role, modules] of Object.entries(accessDefaults.DEFAULT_MODULE_ACCESS)) {
    const declared = new Set(rbac.resolveRoleGrants(role).modules);
    for (const moduleName of modules) {
      const canonical = rbac.normalizeModuleKey(moduleName);
      assert.ok(
        declared.has(canonical),
        `${role}'s storage defaults grant ${moduleName}, which its matrix does not declare`,
      );
    }
  }
});

test('the frontend DEFAULT_MODULE_ACCESS agrees with the role matrix', () => {
  const source = read('frontend/src/app/config/moduleAccess.ts');
  const block = /export const DEFAULT_MODULE_ACCESS[^{]*\{([\s\S]*?)\n\};/.exec(source);
  assert.ok(block, 'expected to find DEFAULT_MODULE_ACCESS in moduleAccess.ts');

  const parsed = {};
  for (const match of block[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    const [, role, raw] = match;
    parsed[role] = /\.\.\.AVAILABLE_MODULES/.test(raw)
      ? 'EVERY_MODULE'
      : [...raw.matchAll(/'([^']+)'/g)].map((quoted) => quoted[1]);
  }

  for (const role of rbac.ROLE_KEYS) {
    const entry = parsed[role];
    assert.ok(entry, `no DEFAULT_MODULE_ACCESS entry for ${role}`);
    const declared = rbac.resolveRoleGrants(role).modules;
    if (entry === 'EVERY_MODULE') {
      assert.equal(
        declared.length,
        rbac.MODULE_KEYS.length,
        `${role} claims every module but its matrix does not grant them`,
      );
      continue;
    }
    const canonical = [...new Set(entry.map((moduleName) => rbac.normalizeModuleKey(moduleName)))];
    assert.deepEqual(
      [...canonical].sort(),
      [...declared].sort(),
      `${role}'s frontend defaults disagree with the role matrix`,
    );
  }
});

test("the sidebar's module list matches the definition's keys and routes", () => {
  const layout = read('frontend/src/app/components/Layout.tsx');
  const block = /const SIDEBAR_ORDER[^=]*=\s*\[([\s\S]*?)\n\];/.exec(layout);
  assert.ok(block, 'expected to find SIDEBAR_ORDER in Layout.tsx');

  const entries = [...block[1].matchAll(/module:\s*'([^']+)',\s*path:\s*'([^']+)'/g)].map(
    (match) => ({ module: match[1], path: match[2] }),
  );
  assert.ok(entries.length > 0, 'SIDEBAR_ORDER must not be empty');

  const expected = rbac.MODULE_TREE.map((module) => ({ module: module.key, path: module.route }));
  assert.deepEqual(entries, expected, 'the sidebar and the RBAC hierarchy have diverged');
});

// ───────────────────── 1b. the Psychologist role matrix ──────────────────────
//
// The Psychologist specification is written as two lists — what the role may do
// and what it may not — plus a note that the "may not" list must hold even when
// the caller reaches the endpoint directly. These tests assert the *effective*
// snapshot rather than the JSON, so they keep holding if the definition is ever
// restructured.

/** The modules the specification grants, verbatim. */
const PSYCHOLOGIST_MODULES = ['Dashboard', 'Child Records', 'Violations', 'Assessments', 'Documents'];

test('the Psychologist holds exactly the modules the specification lists', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'psychologist' });

  assert.deepEqual([...snapshot.modules].sort(), [...PSYCHOLOGIST_MODULES].sort());

  // Everything the specification never mentioned must be absent, not merely
  // unmentioned: an over-granted module is a visible sidebar entry.
  for (const withheld of ['Activities', 'Court Records', 'Houseparent', 'Health', 'Education', 'Reports', 'Account Management']) {
    assert.equal(
      rbac.hasModuleAccess(snapshot, withheld),
      false,
      `the Psychologist must not hold ${withheld}`,
    );
  }
});

test("the Psychologist's Child Records tabs are the four clinical ones, and not Education", () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'psychologist' });

  assert.deepEqual(
    snapshot.subModules['Child Records'],
    ['Personal Info', 'Phase Timeline', 'Medical', 'Behavioral'],
  );
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Child Records', 'Education'), false);
});

test("the Psychologist's Violations tabs stop short of Anecdotal Reports", () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'psychologist' });

  assert.deepEqual(snapshot.subModules.Violations, [
    'Violation List',
    'Intervention Tracker',
    'For Verification',
    'Manage Violations & Interventions',
  ]);
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Violations', 'Anecdotal Reports'), false);
});

test("the Psychologist's Documents tabs stop short of the review queue", () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'psychologist' });

  assert.deepEqual(snapshot.subModules.Documents, ['Folders by Child', 'All Documents', 'Access Requests']);
  assert.equal(
    rbac.hasSubModuleAccess(snapshot, 'Documents', 'Pending Review'),
    false,
    'the Psychologist has no review queue — approval is scoped to requests assigned to the role',
  );
});

test('every module the Psychologist holds declares its tabs, so none default open', () => {
  // The resolver treats a module with *no* declared subModules entry as "all
  // tabs". That fallback is what previously handed the Psychologist all five
  // Violations tabs and all four Documents tabs. This is the guard against a
  // future module being added to the role without its tab list.
  const definition = rbac.getRoleDefinition('psychologist');
  const declared = definition.subModules || {};

  for (const moduleKey of PSYCHOLOGIST_MODULES) {
    const tree = rbac.MODULE_BY_KEY[moduleKey];
    const tabCount = tree && (tree.subModules || []).length;
    if (!tabCount) continue;
    assert.notEqual(
      declared[moduleKey],
      undefined,
      `${moduleKey} has ${tabCount} tab(s) but the Psychologist declares none — they would all open by default`,
    );
  }
});

test('the Psychologist holds no document delete and no global document approval', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'psychologist' });

  assert.equal(rbac.can(snapshot, 'Documents', 'delete'), false, 'the Psychologist must not delete documents');
  assert.equal(rbac.can(snapshot, 'Documents', 'approve'), false, 'the Psychologist has no global approval authority');
  assert.equal(rbac.can(snapshot, 'Documents', 'managePermissions'), false);

  // The capabilities the specification does grant on the module.
  assert.equal(rbac.can(snapshot, 'Documents', 'view'), true);
  assert.equal(rbac.can(snapshot, 'Documents', 'export'), true);
});

test('the Psychologist grants no capability the specification withholds, on any module', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'psychologist' });

  // An exhaustive sweep: the role's own matrix is the allowed set, so a
  // capability appearing anywhere it was not declared fails here.
  const allowed = {
    'Child Records': ['view', 'edit', 'export'],
    Violations: ['view', 'edit', 'verify', 'export'],
    Assessments: ['view', 'create', 'edit', 'delete', 'export'],
    Documents: ['view', 'create', 'edit', 'export'],
    Dashboard: ['view'],
  };

  for (const permission of rbac.PERMISSION_KEYS) {
    for (const moduleKey of PSYCHOLOGIST_MODULES) {
      const expected = (allowed[moduleKey] || []).includes(permission);
      assert.equal(
        rbac.can(snapshot, moduleKey, permission),
        expected,
        `Psychologist ${moduleKey}:${permission} should be ${expected}`,
      );
    }
  }
});

test('the Psychologist reads incident forms and interventions but creates neither', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'psychologist' });

  // Viewing an incident form / an intervention rides on the Violations module.
  assert.equal(rbac.hasModuleAccess(snapshot, 'Violations'), true);
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Violations', 'Violation List'), true);
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Violations', 'Intervention Tracker'), true);

  // Creating an incident (a violation) or deleting an intervention is refused.
  assert.equal(rbac.can(snapshot, 'Violations', 'create'), false, 'the Psychologist must not create incidents');
  assert.equal(rbac.can(snapshot, 'Violations', 'delete'), false, 'the Psychologist must not delete interventions');

  // Verification is the one write the workflow assigns to the role.
  assert.equal(rbac.can(snapshot, 'Violations', 'verify'), true);
});

test('the Intervention Tracker alias does not resurrect a module the Psychologist does not hold', () => {
  // `Intervention Tracker` is a Violations submenu, not a module. It used to be
  // declared as a module too, which made `hasModuleAccess('Intervention Tracker')`
  // succeed and produced a second, contradictory route to the same feature.
  assert.equal(rbac.MODULE_KEYS.includes('Intervention Tracker'), false);
  assert.equal(rbac.normalizeModuleKey('Intervention Tracker'), 'Violations');

  const snapshot = rbac.buildAccessSnapshot({ role: 'psychologist' });
  assert.equal(rbac.hasModuleAccess(snapshot, 'Intervention Tracker'), true, 'the alias resolves to Violations');
  assert.equal(rbac.permissionsFor(snapshot, 'Intervention Tracker').includes('delete'), false);
});

test('the Psychologist resolves identically from stored grants and from the matrix', () => {
  const fromMatrix = rbac.buildAccessSnapshot({ role: 'psychologist' });
  const fromEmptyGrants = rbac.buildAccessSnapshot({ role: 'psychologist', accessibleModules: [] });

  assert.deepEqual([...fromEmptyGrants.modules].sort(), [...fromMatrix.modules].sort());

  // A stored grant may narrow the role but never widen it: storing a module the
  // role does not declare still yields that module's tabs, and the capability
  // check is what refuses the action.
  const widened = rbac.buildAccessSnapshot({ role: 'psychologist', accessibleModules: ['Documents', 'Court Records'] });
  assert.equal(rbac.hasModuleAccess(widened, 'Court Records'), true);
  assert.equal(rbac.can(widened, 'Documents', 'delete'), false, 'a module grant cannot confer a withheld capability');
});

// ──────────────────────── 1c. the Nurse role matrix ──────────────────────────
//
// The Nurse specification is written as an access list plus five numbered
// requirements. As with the Psychologist, these assert the *effective* snapshot
// so they keep holding if the definition is ever restructured.

/** The modules the specification grants, verbatim. */
const NURSE_MODULES = ['Dashboard', 'Child Records', 'Health', 'Documents'];

test('the Nurse holds exactly the modules the specification lists', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'nurse' });

  assert.deepEqual([...snapshot.modules].sort(), [...NURSE_MODULES].sort());

  // Everything the specification never mentioned must be absent, not merely
  // unmentioned: an over-granted module is a visible sidebar entry. Violations
  // matters most — requirement 4 is "Nurse cannot create, edit, or delete
  // incidents", and an incident is a violation.
  for (const withheld of ['Violations', 'Activities', 'Assessments', 'Court Records', 'Houseparent', 'Education', 'Reports', 'Account Management']) {
    assert.equal(
      rbac.hasModuleAccess(snapshot, withheld),
      false,
      `the Nurse must not hold ${withheld}`,
    );
  }
});

test('the Nurse may only open the three Child Records tabs the specification lists', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'nurse' });

  assert.deepEqual(snapshot.subModules['Child Records'], ['Personal Info', 'Phase Timeline', 'Medical']);
  // Requirement 4 — the Behavioral tab is the "view if authorized" case, so it
  // is not held by default. Requirement 2's Medical tab is.
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Child Records', 'Behavioral'), false);
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Child Records', 'Education'), false);
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Child Records', 'Medical'), true);
});

test('a per-account grant is what authorises the Behavioral tab', () => {
  // Requirement 4 says "Nurse can view if authorized". The authorization is the
  // per-account submenu grant, and it must survive resolution.
  const authorized = rbac.buildAccessSnapshot({
    role: 'nurse',
    subModules: { 'Child Records': ['Personal Info', 'Phase Timeline', 'Medical', 'Behavioral'] },
  });

  assert.equal(rbac.hasSubModuleAccess(authorized, 'Child Records', 'Behavioral'), true);
  // Authorised to *view* it — the grant opens the tab, it does not confer the
  // Violations module, which is where incidents live.
  assert.equal(rbac.hasModuleAccess(authorized, 'Violations'), false);
});

test("the Nurse's Documents tabs stop short of the review queue", () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'nurse' });

  assert.deepEqual(snapshot.subModules.Documents, ['Folders by Child', 'All Documents', 'Access Requests']);
  assert.equal(
    rbac.hasSubModuleAccess(snapshot, 'Documents', 'Pending Review'),
    false,
    'the Nurse has no review queue — requirement 6 withholds approval authority',
  );
});

test('every module the Nurse holds declares its tabs, so none default open', () => {
  // The resolver treats a module with *no* declared subModules entry as "all
  // tabs" — that fallback is what handed the Nurse the Documents review queue
  // and would hand it the Behavioral tab. Guard against a future module being
  // added to the role without its tab list.
  const definition = rbac.getRoleDefinition('nurse');
  const declared = definition.subModules || {};

  for (const moduleKey of NURSE_MODULES) {
    const tree = rbac.MODULE_BY_KEY[moduleKey];
    const tabCount = tree && (tree.subModules || []).length;
    if (!tabCount) continue;
    assert.notEqual(
      declared[moduleKey],
      undefined,
      `${moduleKey} has ${tabCount} tab(s) but the Nurse declares none — they would all open by default`,
    );
  }
});

test('the Nurse holds no document delete and no global document approval', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'nurse' });

  // Requirement 6, verbatim: "Can view, create, submit, print, and download
  // authorized medical documents. Cannot delete documents. No global document
  // approval/rejection permissions."
  assert.equal(rbac.can(snapshot, 'Documents', 'delete'), false, 'the Nurse must not delete documents');
  assert.equal(rbac.can(snapshot, 'Documents', 'approve'), false, 'the Nurse has no approval authority');
  assert.equal(rbac.can(snapshot, 'Documents', 'verify'), false);
  assert.equal(rbac.can(snapshot, 'Documents', 'managePermissions'), false);

  // The capabilities requirement 6 does grant on the module.
  assert.equal(rbac.can(snapshot, 'Documents', 'view'), true);
  assert.equal(rbac.can(snapshot, 'Documents', 'create'), true);
  assert.equal(rbac.can(snapshot, 'Documents', 'edit'), true);
  assert.equal(rbac.can(snapshot, 'Documents', 'export'), true);
});

test('the Nurse grants no capability the specification withholds, on any module', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'nurse' });

  const allowed = {
    'Child Records': ['view', 'edit', 'export'],
    Health: ['view', 'create', 'edit', 'delete', 'export'],
    Documents: ['view', 'create', 'edit', 'export'],
    Dashboard: ['view'],
  };

  for (const permission of rbac.PERMISSION_KEYS) {
    for (const moduleKey of NURSE_MODULES) {
      const expected = (allowed[moduleKey] || []).includes(permission);
      assert.equal(
        rbac.can(snapshot, moduleKey, permission),
        expected,
        `Nurse ${moduleKey}:${permission} should be ${expected}`,
      );
    }
  }
});

test('the Nurse writes health records and reads incidents, and only that', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'nurse' });

  // Requirement 1 and 2 — the Health module is the nurse's write surface.
  assert.equal(rbac.hasModuleAccess(snapshot, 'Health'), true);
  assert.equal(rbac.can(snapshot, 'Health', 'create'), true);
  assert.equal(rbac.can(snapshot, 'Health', 'edit'), true);

  // Requirement 4 — "Nurse cannot create, edit, or delete incidents." An
  // incident is a violation, and the module is not held at all, so every write
  // capability is refused rather than merely unmentioned.
  for (const permission of ['view', 'create', 'edit', 'delete', 'verify', 'approve']) {
    assert.equal(
      rbac.can(snapshot, 'Violations', permission),
      false,
      `the Nurse must not hold Violations:${permission}`,
    );
  }
});

test('only the Nurse and the Center Head may write a Medical Note', () => {
  // Requirement 1, verbatim: "Medical Notes — Allow create/edit only for Nurse
  // and Center Head." The Medical Notes editor on Child Records → Medical is
  // gated on `Health: edit`, so that capability is what defines "who may write
  // one". Admin is the full-access baseline account, not a separate role.
  const writers = rbac.ROLE_KEYS.filter((role) => rbac.can({ role }, 'Health', 'edit'));

  assert.deepEqual([...writers].sort(), ['admin', 'centerhead', 'nurse']);
});

test('the Nurse resolves identically from stored grants and from the matrix', () => {
  const fromMatrix = rbac.buildAccessSnapshot({ role: 'nurse' });
  const fromEmptyGrants = rbac.buildAccessSnapshot({ role: 'nurse', accessibleModules: [] });

  assert.deepEqual([...fromEmptyGrants.modules].sort(), [...fromMatrix.modules].sort());

  // A stored grant may narrow the role but never widen it: storing a module the
  // role does not declare still yields that module's tabs, and the capability
  // check is what refuses the action.
  const widened = rbac.buildAccessSnapshot({ role: 'nurse', accessibleModules: ['Documents', 'Assessments'] });
  assert.equal(rbac.hasModuleAccess(widened, 'Assessments'), true);
  assert.equal(rbac.can(widened, 'Documents', 'delete'), false, 'a module grant cannot confer a withheld capability');
});

// ────────────────────── 1d. the Houseparent role matrix ──────────────────────
//
// The Houseparent specification is an access list plus a "can"/"cannot" pair.
// As with the Psychologist and the Nurse, these assert the *effective* snapshot
// so they keep holding if the definition is ever restructured.

/** The modules the specification grants, verbatim. */
const HOUSEPARENT_MODULES = ['Dashboard', 'Activities', 'Assessments', 'Houseparent', 'Violations'];

test('the Houseparent holds exactly the modules the specification lists', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'houseparent' });

  assert.deepEqual([...snapshot.modules].sort(), [...HOUSEPARENT_MODULES].sort());

  // Everything the "cannot" list names must be absent, not merely unmentioned:
  // an over-granted module is a visible sidebar entry *and* a reachable page.
  // Child Records matters most — its Medical tab is "cannot access Medical
  // records/modules", and the Reports module is not in the access list at all.
  for (const withheld of ['Child Records', 'Court Records', 'Documents', 'Health', 'Education', 'Reports', 'Account Management']) {
    assert.equal(
      rbac.hasModuleAccess(snapshot, withheld),
      false,
      `the Houseparent must not hold ${withheld}`,
    );
  }
});

test("the Houseparent's Violations tabs are the two the specification lists", () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'houseparent' });

  // "Violation List" and "Intervention Tracker", in the definition's order.
  assert.deepEqual(snapshot.subModules.Violations, ['Violation List', 'Intervention Tracker']);

  // The verification queue and the guide editor are reviewer surfaces, and the
  // specification grants neither.
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Violations', 'For Verification'), false);
  assert.equal(
    rbac.hasSubModuleAccess(snapshot, 'Violations', 'Manage Violations & Interventions'),
    false,
  );
  // Anecdotal Reports is a Houseparent-module tab, not a Violations one.
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Violations', 'Anecdotal Reports'), false);
});

test("the Houseparent's own module declares all three of its tabs", () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'houseparent' });

  assert.deepEqual(
    snapshot.subModules.Houseparent,
    ['Case Load', 'TRI Records', 'Anecdotal Reports'],
  );
  for (const tab of ['Case Load', 'TRI Records', 'Anecdotal Reports']) {
    assert.equal(
      rbac.hasSubModuleAccess(snapshot, 'Houseparent', tab),
      true,
      `the Houseparent must hold ${tab}`,
    );
  }
});

test('every module the Houseparent holds declares its tabs, so none default open', () => {
  // The resolver treats a module with *no* declared subModules entry as "all
  // tabs". The Houseparent entry used to declare a five-tab `Child Records` list
  // for a module the role does not hold — inert, but a trap: adding Child
  // Records to the role would have opened all five tabs, Medical included.
  const definition = rbac.getRoleDefinition('houseparent');
  const declared = definition.subModules || {};

  for (const moduleKey of HOUSEPARENT_MODULES) {
    const tree = rbac.MODULE_BY_KEY[moduleKey];
    const tabCount = tree && (tree.subModules || []).length;
    if (!tabCount) continue;
    assert.notEqual(
      declared[moduleKey],
      undefined,
      `${moduleKey} has ${tabCount} tab(s) but the Houseparent declares none — they would all open by default`,
    );
  }

  // And nothing is declared for a module the role does not hold.
  for (const moduleKey of Object.keys(declared)) {
    assert.ok(
      HOUSEPARENT_MODULES.includes(moduleKey),
      `the Houseparent declares tabs for ${moduleKey}, which it does not hold`,
    );
  }
});

test('the Houseparent views incidents and interventions but creates neither', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'houseparent' });

  // "View Violation List" / "View Intervention Tracker".
  assert.equal(rbac.can(snapshot, 'Violations', 'view'), true);

  // "Cannot: Create/Edit/Delete incidents unless explicitly permitted
  // elsewhere." An incident is a violation, and nothing grants the role the
  // capability, so every write verb is refused rather than merely unmentioned.
  for (const permission of ['create', 'edit', 'delete', 'verify', 'approve']) {
    assert.equal(
      rbac.can(snapshot, 'Violations', permission),
      false,
      `the Houseparent must not hold Violations:${permission}`,
    );
  }
});

test('the Houseparent grants no capability the specification withholds, on any module', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'houseparent' });

  const allowed = {
    Dashboard: ['view'],
    Activities: ['view', 'create', 'edit', 'export'],
    Assessments: ['view', 'export'],
    Houseparent: ['view', 'create', 'edit', 'export'],
    Violations: ['view'],
  };

  for (const permission of rbac.PERMISSION_KEYS) {
    for (const moduleKey of HOUSEPARENT_MODULES) {
      const expected = (allowed[moduleKey] || []).includes(permission);
      assert.equal(
        rbac.can(snapshot, moduleKey, permission),
        expected,
        `Houseparent ${moduleKey}:${permission} should be ${expected}`,
      );
    }
  }
});

test('the Houseparent manages TRI records and anecdotal reports within its own module', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'houseparent' });

  // "Manage TRI Records within assigned workflow" and "Manage Anecdotal Reports
  // within assigned workflow" — both live in the Houseparent module.
  for (const permission of ['view', 'create', 'edit', 'export']) {
    assert.equal(rbac.can(snapshot, 'Houseparent', permission), true, `Houseparent:${permission}`);
  }
  // Deleting a TRI record is a reviewer action, not a Houseparent one.
  assert.equal(rbac.can(snapshot, 'Houseparent', 'delete'), false);

  // "Access Activities" / "Access Assessments" — read plus the day-to-day
  // activity writes, but scheduling an assessment is not an access capability.
  assert.equal(rbac.can(snapshot, 'Activities', 'view'), true);
  assert.equal(rbac.can(snapshot, 'Activities', 'create'), true);
  assert.equal(rbac.can(snapshot, 'Assessments', 'view'), true);
  assert.equal(rbac.can(snapshot, 'Assessments', 'create'), false);
  assert.equal(rbac.can(snapshot, 'Assessments', 'edit'), false);
});

test('the Houseparent resolves identically from stored grants and from the matrix', () => {
  const fromMatrix = rbac.buildAccessSnapshot({ role: 'houseparent' });
  const fromEmptyGrants = rbac.buildAccessSnapshot({ role: 'houseparent', accessibleModules: [] });

  assert.deepEqual([...fromEmptyGrants.modules].sort(), [...fromMatrix.modules].sort());

  // A stored grant may name a module the role does not declare — but the role's
  // own matrix still decides the capabilities, so the grant cannot widen them.
  const widened = rbac.buildAccessSnapshot({
    role: 'houseparent',
    accessibleModules: ['Violations', 'Health'],
  });
  assert.equal(rbac.hasModuleAccess(widened, 'Health'), true);
  assert.equal(rbac.can(widened, 'Health', 'create'), false, 'a module grant cannot confer a withheld capability');
});

// ────────────────────── 1e. the Educator role matrix ─────────────────────────
//
// The Educator specification is an access list plus a "can"/"cannot" pair, the
// same shape as the Houseparent's. These assert the *effective* snapshot so they
// keep holding if the definition is ever restructured.

/** The modules the specification grants, verbatim. */
const EDUCATOR_MODULES = ['Dashboard', 'Child Records', 'Education', 'Documents'];

test('the Educator holds exactly the modules the specification lists', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'educator' });

  assert.deepEqual([...snapshot.modules].sort(), [...EDUCATOR_MODULES].sort());

  // Everything the "cannot" list names must be absent, not merely unmentioned:
  // an over-granted module is a visible sidebar entry *and* a reachable page.
  for (const withheld of [
    'Violations',            // "cannot access Violations"
    'Health',                // "cannot access the Health Module"
    'Activities',
    'Assessments',
    'Court Records',
    'Houseparent',
    'Reports',
    'Account Management',    // "cannot access Administrative Modules"
  ]) {
    assert.equal(
      rbac.hasModuleAccess(snapshot, withheld),
      false,
      `the Educator must not hold ${withheld}`,
    );
  }
});

test('the Educator may only open the two Child Records tabs the specification lists', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'educator' });

  // "Child Records → Personal Info, Education".
  assert.deepEqual(snapshot.subModules['Child Records'], ['Personal Info', 'Education']);

  // "Cannot access Medical Records" — the Medical tab is where they live — and
  // Phase Timeline and Behavioral are not in the access list at all.
  for (const withheld of ['Phase Timeline', 'Medical', 'Behavioral']) {
    assert.equal(
      rbac.hasSubModuleAccess(snapshot, 'Child Records', withheld),
      false,
      `the Educator must not open Child Records: ${withheld}`,
    );
  }
  for (const tab of ['Personal Info', 'Education']) {
    assert.equal(
      rbac.hasSubModuleAccess(snapshot, 'Child Records', tab),
      true,
      `the Educator must open Child Records: ${tab}`,
    );
  }
});

test('the Educator reads Personal Info and writes Education records, and nothing else', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'educator' });

  // "View Personal Info" — view, not edit. The API enforces the same thing: a
  // resident PUT is gated on Child Records:edit, so this capability is what
  // actually stops the role writing a Personal Info change.
  assert.equal(rbac.can(snapshot, 'Child Records', 'view'), true);
  for (const permission of ['create', 'edit', 'delete', 'export', 'verify', 'approve']) {
    assert.equal(
      rbac.can(snapshot, 'Child Records', permission),
      false,
      `the Educator must not hold Child Records:${permission}`,
    );
  }

  // "View / create / edit Education Records" — and no delete.
  for (const permission of ['view', 'create', 'edit']) {
    assert.equal(rbac.can(snapshot, 'Education', permission), true, `Education:${permission}`);
  }
  for (const permission of ['delete', 'verify', 'approve']) {
    assert.equal(
      rbac.can(snapshot, 'Education', permission),
      false,
      `the Educator must not hold Education:${permission}`,
    );
  }
});

test('the Educator holds no document create, delete or global approval', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'educator' });

  // "Manage Documents" is what the role may not do. Reading stays, because the
  // specification's Documents paragraph explicitly allows a *view* — "only if
  // access is granted through the document access request workflow" — and an
  // approved request is unreachable without it.
  assert.equal(rbac.can(snapshot, 'Documents', 'view'), true);
  for (const permission of ['create', 'edit', 'delete', 'approve', 'verify']) {
    assert.equal(
      rbac.can(snapshot, 'Documents', permission),
      false,
      `the Educator must not hold Documents:${permission}`,
    );
  }

  // The review queue is the global approval surface; the history is the Center
  // Head's and the Social Worker's audit trail.
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Documents', 'Pending Review'), false);
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Documents', 'Access Request History'), false);
  // And the role can still ask: "Request Access" lives on the Access Requests tab.
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Documents', 'Access Requests'), true);
});

test('the Educator grants no capability the specification withholds, on any module', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'educator' });

  const allowed = {
    Dashboard: ['view'],
    'Child Records': ['view'],
    Education: ['view', 'create', 'edit'],
    Documents: ['view'],
  };

  for (const permission of rbac.PERMISSION_KEYS) {
    for (const moduleKey of EDUCATOR_MODULES) {
      const expected = (allowed[moduleKey] || []).includes(permission);
      assert.equal(
        rbac.can(snapshot, moduleKey, permission),
        expected,
        `Educator ${moduleKey}:${permission} should be ${expected}`,
      );
    }
  }
});

test('every module the Educator holds declares its tabs, so none default open', () => {
  // The resolver treats a module with *no* declared subModules entry as "all
  // tabs". Child Records and Documents both have five, so both must be declared
  // or the Educator would silently receive every tab of each.
  const definition = rbac.getRoleDefinition('educator');
  const declared = definition.subModules || {};

  for (const moduleKey of EDUCATOR_MODULES) {
    const tree = rbac.MODULE_BY_KEY[moduleKey];
    const tabCount = tree && (tree.subModules || []).length;
    if (!tabCount) continue;
    assert.notEqual(
      declared[moduleKey],
      undefined,
      `${moduleKey} has ${tabCount} tab(s) but the Educator declares none — they would all open by default`,
    );
  }

  // And nothing is declared for a module the role does not hold.
  for (const moduleKey of Object.keys(declared)) {
    assert.ok(
      EDUCATOR_MODULES.includes(moduleKey),
      `the Educator declares tabs for ${moduleKey}, which it does not hold`,
    );
  }
});

test('the Educator resolves identically from stored grants and from the matrix', () => {
  const fromMatrix = rbac.buildAccessSnapshot({ role: 'educator' });
  const fromEmptyGrants = rbac.buildAccessSnapshot({ role: 'educator', accessibleModules: [] });

  assert.deepEqual([...fromEmptyGrants.modules].sort(), [...fromMatrix.modules].sort());

  // A stored grant may name a module the role does not declare — but the role's
  // own matrix still decides the capabilities, so the grant cannot widen them.
  const widened = rbac.buildAccessSnapshot({
    role: 'educator',
    accessibleModules: ['Education', 'Health'],
  });
  assert.equal(rbac.hasModuleAccess(widened, 'Health'), true);
  assert.equal(
    rbac.can(widened, 'Health', 'create'),
    false,
    'a module grant cannot confer a withheld capability',
  );
});

// ──────────────────────────── 2. the resolver ────────────────────────────────

test('centerhead receives every module and every submenu', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'centerhead' });

  assert.equal(snapshot.fullAccess, true);
  // Compared canonically: the snapshot also carries the legacy keys so a stored
  // grant naming one of them still resolves.
  assert.deepEqual(
    [...new Set(snapshot.modules.map((module) => rbac.normalizeModuleKey(module)))].sort(),
    [...rbac.MODULE_KEYS].sort(),
  );
  assert.deepEqual([...snapshot.permissionList].sort(), [...rbac.PERMISSION_KEYS].sort());
  for (const module of rbac.MODULE_TREE) {
    assert.deepEqual(
      snapshot.subModules[module.key],
      module.subModules.map((sub) => sub.key),
      `centerhead must hold every submenu of ${module.key}`,
    );
  }
});

test('the menus centerhead is shown are the full hierarchy, submenus included', () => {
  const menus = rbac.listAccessibleMenus({ role: 'centerhead' });
  assert.deepEqual(
    menus.map((menu) => ({ key: menu.key, subModules: menu.subModules.map((sub) => sub.key) })),
    EXPECTED_HIERARCHY,
  );
});

test('centerhead bypasses every permission check, including unknown ones', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'centerhead' });

  // A module and permission that do not exist yet must still pass — that is
  // what makes "unrestricted access" survive future features.
  assert.equal(rbac.can(snapshot, 'Some Module Added Next Year', 'aPermissionAddedNextYear'), true);
  assert.equal(rbac.hasModuleAccess(snapshot, 'Not A Module'), true);
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Violations', 'Not A Submenu'), true);
  assert.equal(rbac.hasPermission(snapshot, 'Documents', 'delete'), true);
  assert.equal(rbac.hasPermission(snapshot, 'Account Management', 'manageUsers'), true);
  assert.equal(rbac.hasPermission(snapshot, 'Account Management', 'manageRoles'), true);
  assert.equal(rbac.hasPermission(snapshot, 'Account Management', 'manageSettings'), true);
});

test('the centerhead bypass does not depend on stored grants', () => {
  // Even with a deliberately empty grant list, a full-access role passes.
  const snapshot = rbac.buildAccessSnapshot({
    role: 'centerhead',
    accessibleModules: [],
    childRecordTabs: [],
    subModules: {},
  });
  assert.equal(snapshot.fullAccess, true);
  assert.equal(rbac.can(snapshot, 'Violations', 'delete'), true);
  assert.equal(rbac.listAccessibleMenus(snapshot).length, rbac.MODULE_KEYS.length);
});

test('a non-full-access role is held to its declared matrix', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'houseparent' });

  assert.equal(snapshot.fullAccess, false);
  assert.ok(rbac.hasModuleAccess(snapshot, 'Violations'));
  assert.equal(rbac.hasModuleAccess(snapshot, 'Education'), false, 'houseparent has no Education module');
  assert.equal(rbac.hasModuleAccess(snapshot, 'Account Management'), false);
  // The Houseparent specification grants "View Violation List" and "View
  // Intervention Tracker" and forbids creating, editing or deleting incidents.
  assert.equal(rbac.can(snapshot, 'Violations', 'view'), true);
  assert.equal(rbac.can(snapshot, 'Violations', 'create'), false);
  assert.equal(rbac.can(snapshot, 'Violations', 'edit'), false);
  assert.equal(rbac.can(snapshot, 'Violations', 'delete'), false);
  assert.equal(rbac.can(snapshot, 'Violations', 'verify'), false);
  assert.equal(rbac.can(snapshot, 'Account Management', 'manageUsers'), false);
});

test('per-account module narrowing is honoured', () => {
  const narrowed = rbac.buildAccessSnapshot({
    role: 'socialworker',
    accessibleModules: ['Dashboard', 'Court Records'],
  });
  assert.deepEqual([...narrowed.modules].sort(), ['Court Records', 'Dashboard']);
  assert.equal(rbac.hasModuleAccess(narrowed, 'Violations'), false);
  assert.equal(rbac.hasModuleAccess(narrowed, 'Court Records'), true);
  // The verbs still come from the role, so granting a module is enough.
  assert.equal(rbac.can(narrowed, 'Court Records', 'delete'), true);
});

test('an account with no stored grants falls back to its role matrix', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'nurse', accessibleModules: [] });
  assert.deepEqual([...snapshot.modules].sort(), [...rbac.resolveRoleGrants('nurse').modules].sort());
});

test('submenus default open and can be narrowed explicitly', () => {
  const open = rbac.buildAccessSnapshot({ role: 'educator' });
  assert.deepEqual(open.subModules['Child Records'], ['Personal Info', 'Education']);

  const narrowed = rbac.buildAccessSnapshot({
    role: 'educator',
    accessibleModules: ['Child Records'],
    subModules: { 'Child Records': ['Education'] },
  });
  assert.deepEqual(narrowed.subModules['Child Records'], ['Education']);
  assert.equal(rbac.hasSubModuleAccess(narrowed, 'Child Records', 'Education'), true);
  assert.equal(rbac.hasSubModuleAccess(narrowed, 'Child Records', 'Medical'), false);
});

test('a module with no submenus always passes a submenu check', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'nurse' });
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Dashboard', 'anything'), true);
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Health', undefined), true);
});

test('an unknown submenu name is refused rather than silently allowed', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'socialworker' });
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Documents', 'Made Up Tab'), false);
});

test('a stored submenu grant is honoured in every shape a JSON column arrives in', () => {
  // Regression: a JSON column can reach the resolver parsed OR as a string,
  // depending on the driver. Reading only the parsed case silently discarded
  // every stored narrowing, so a withheld submenu came back.
  const expected = ['Folders by Child'];

  const objectShapes = {
    'parsed object': { Documents: ['Folders by Child'] },
    'JSON string of an object': JSON.stringify({ Documents: ['Folders by Child'] }),
  };

  for (const [label, subModules] of Object.entries(objectShapes)) {
    const snapshot = rbac.buildAccessSnapshot({
      role: 'educator',
      accessibleModules: ['Documents'],
      subModules,
    });
    assert.deepEqual(
      snapshot.subModules.Documents,
      expected,
      `subModules as ${label} was not read correctly`,
    );
    assert.equal(rbac.hasSubModuleAccess(snapshot, 'Documents', 'All Documents'), false);
  }

  // A flat array is the legacy `childRecordTabs` shape, so it narrows Child
  // Records — not whichever module happens to be first.
  const flatShapes = {
    'flat legacy array': ['Personal Info', 'Education'],
    'JSON string of a flat array': JSON.stringify(['Personal Info', 'Education']),
  };

  for (const [label, subModules] of Object.entries(flatShapes)) {
    const snapshot = rbac.buildAccessSnapshot({
      role: 'educator',
      accessibleModules: ['Child Records', 'Documents'],
      subModules,
    });
    assert.deepEqual(
      snapshot.subModules['Child Records'],
      ['Personal Info', 'Education'],
      `subModules as ${label} was not read as the legacy tab grant`,
    );
    // Documents was not mentioned, so it keeps its declared set.
    assert.deepEqual(snapshot.subModules.Documents, ['Folders by Child', 'All Documents', 'Access Requests']);
  }

  // And an absent / unusable value falls back to the role's declared set.
  for (const subModules of [undefined, null, '', 'not json', 42]) {
    const snapshot = rbac.buildAccessSnapshot({
      role: 'educator',
      accessibleModules: ['Documents'],
      subModules,
    });
    assert.deepEqual(
      snapshot.subModules.Documents,
      ['Folders by Child', 'All Documents', 'Access Requests'],
      `subModules = ${JSON.stringify(subModules)} should fall back to the role default`,
    );
  }
});

test('a JSON-string childRecordTabs list is still read as a tab grant', () => {
  const snapshot = rbac.buildAccessSnapshot({
    role: 'educator',
    accessibleModules: ['Child Records'],
    childRecordTabs: JSON.stringify(['Personal Info', 'Education']),
  });
  assert.deepEqual(snapshot.subModules['Child Records'], ['Personal Info', 'Education']);
  assert.equal(rbac.hasSubModuleAccess(snapshot, 'Child Records', 'Medical'), false);
});

test('a permission on a module the caller cannot open is refused', () => {
  // The "*" baseline means "on every module I hold" — it must not leak a
  // permission onto a module that is not granted.
  const snapshot = rbac.buildAccessSnapshot({ role: 'educator' });
  assert.equal(rbac.hasModuleAccess(snapshot, 'Violations'), false);
  assert.equal(rbac.hasPermission(snapshot, 'Violations', 'view'), false);
  assert.equal(rbac.can(snapshot, 'Violations', 'view'), false);
  // ...while the same baseline still answers for a module it does hold.
  assert.equal(rbac.hasPermission(snapshot, 'Dashboard', 'view'), true);
});

test('legacy stored module names resolve to the module that now owns the feature', () => {
  // An older row may grant 'Intervention Tracker', which is now a Violations
  // submenu. The grant must still open the Violations module.
  const snapshot = rbac.buildAccessSnapshot({
    role: 'psychologist',
    accessibleModules: ['Intervention Tracker'],
  });
  assert.equal(rbac.hasModuleAccess(snapshot, 'Violations'), true);
  assert.equal(rbac.hasModuleAccess(snapshot, 'Intervention Tracker'), true);
  assert.ok(rbac.hasSubModuleAccess(snapshot, 'Violations', 'Intervention Tracker'));

  assert.equal(rbac.normalizeModuleKey('TRI'), 'Houseparent');
  assert.equal(rbac.normalizeModuleKey('Intervention Tracker'), 'Violations');
  assert.equal(rbac.normalizeModuleKey('Case Progress'), 'Education');
});

test('permissions accept either their key or their display label', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'nurse' });
  assert.equal(rbac.hasPermission(snapshot, 'Health', 'edit'), true);
  assert.equal(rbac.hasPermission(snapshot, 'Health', 'Edit'), true);
  assert.equal(rbac.normalizePermission('Manage Users'), 'manageUsers');
  assert.equal(rbac.normalizePermission('delete'), 'delete');
});

test('an unknown role is granted nothing', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'time-traveller' });
  assert.equal(snapshot.fullAccess, false);
  assert.deepEqual(snapshot.modules, []);
  assert.deepEqual(rbac.listAccessibleMenus(snapshot), []);
  assert.equal(rbac.can(snapshot, 'Dashboard', 'view'), false);
  assert.equal(rbac.resolveRoleGrants('time-traveller').known, false);
});

test('role spellings are normalized before lookup', () => {
  assert.equal(rbac.normalizeRoleKey(' Center Head '), 'centerhead');
  assert.equal(rbac.normalizeRoleKey('SOCIAL WORKER'), 'socialworker');
  assert.equal(rbac.isFullAccessRole('CENTER HEAD'), true);
  assert.equal(rbac.roleLabel('centerhead'), 'Center Head');
});

test('roles that hold Manage Users are derived, not hard-coded', () => {
  assert.ok(rbac.rolesWithPermission('manageUsers').includes('centerhead'));
  assert.equal(rbac.rolesWithPermission('manageUsers').includes('houseparent'), false);
});

// ───────────────────── 2b. extensibility (the point of it all) ───────────────

/**
 * Re-load the resolver against a patched definition.
 *
 * The definition is a JSON module, so replacing its cache entry is enough to
 * make `rbac.js` see a different model — no source edit, which is exactly the
 * claim these tests need to verify.
 */
function loadRbacWithPatchedDefinition(patch) {
  const base = JSON.parse(fs.readFileSync(DEFINITION_PATH, 'utf8'));
  const patched = patch(base);

  const definitionEntry = require.cache[DEFINITION_PATH];
  const rbacEntry = require.cache[RBAC_MODULE_PATH];

  require.cache[DEFINITION_PATH] = {
    id: DEFINITION_PATH,
    filename: DEFINITION_PATH,
    loaded: true,
    exports: patched,
  };
  delete require.cache[RBAC_MODULE_PATH];

  const patchedRbac = require(RBAC_MODULE_PATH);

  if (definitionEntry) require.cache[DEFINITION_PATH] = definitionEntry;
  else delete require.cache[DEFINITION_PATH];
  if (rbacEntry) require.cache[RBAC_MODULE_PATH] = rbacEntry;
  else delete require.cache[RBAC_MODULE_PATH];

  return patchedRbac;
}

test('a new role needs only a definition entry — no code change', () => {
  const patched = loadRbacWithPatchedDefinition((definition) => ({
    ...definition,
    roles: {
      ...definition.roles,
      clinician: {
        label: 'Clinician',
        fullAccess: false,
        description: 'A role that did not exist when the resolver was written.',
        modules: ['Dashboard', 'Child Records', 'Health'],
        subModules: { 'Child Records': ['Personal Info', 'Medical'] },
        permissions: { '*': ['view'], Health: ['view', 'create', 'edit'] },
      },
    },
  }));

  assert.ok(patched.ROLE_KEYS.includes('clinician'));
  assert.equal(patched.roleLabel('clinician'), 'Clinician');

  const snapshot = patched.buildAccessSnapshot({ role: 'clinician' });
  assert.deepEqual([...snapshot.modules].sort(), ['Child Records', 'Dashboard', 'Health']);
  assert.deepEqual(snapshot.subModules['Child Records'], ['Personal Info', 'Medical']);
  assert.equal(patched.can(snapshot, 'Health', 'create'), true);
  assert.equal(patched.can(snapshot, 'Health', 'delete'), false);
  assert.equal(patched.hasModuleAccess(snapshot, 'Violations'), false);

  const menus = patched.listAccessibleMenus(snapshot);
  assert.deepEqual(
    menus.map((menu) => menu.key),
    ['Dashboard', 'Child Records', 'Health'],
  );
  assert.deepEqual(menus[1].subModules.map((sub) => sub.key), ['Personal Info', 'Medical']);

  // The unpatched resolver must be unaffected — the cache was restored.
  assert.equal(rbac.ROLE_KEYS.includes('clinician'), false);
});

test('a new module and submenu appear without touching the resolver', () => {
  const patched = loadRbacWithPatchedDefinition((definition) => ({
    ...definition,
    modules: [
      ...definition.modules,
      {
        key: 'Family Engagement',
        label: 'Family Engagement',
        route: '/family',
        icon: 'Users',
        subModules: [
          { key: 'Visits', label: 'Visits', tab: 'visits' },
          { key: 'Home Study', label: 'Home Study', tab: 'home-study' },
        ],
      },
    ],
    roles: {
      ...definition.roles,
      socialworker: {
        ...definition.roles.socialworker,
        modules: [...definition.roles.socialworker.modules, 'Family Engagement'],
        subModules: {
          ...definition.roles.socialworker.subModules,
          'Family Engagement': ['Visits'],
        },
      },
    },
  }));

  const snapshot = patched.buildAccessSnapshot({ role: 'socialworker' });
  assert.equal(patched.hasModuleAccess(snapshot, 'Family Engagement'), true);
  assert.equal(patched.hasSubModuleAccess(snapshot, 'Family Engagement', 'Visits'), true);
  assert.equal(patched.hasSubModuleAccess(snapshot, 'Family Engagement', 'Home Study'), false);

  // And a full-access role picks the new module up with no extra work.
  const centerheadMenus = patched.listAccessibleMenus({ role: 'centerhead' });
  const family = centerheadMenus.find((menu) => menu.key === 'Family Engagement');
  assert.ok(family, 'a full-access role must see a module added to the definition');
  assert.deepEqual(family.subModules.map((sub) => sub.key), ['Visits', 'Home Study']);
});

test('a new full-access role inherits the bypass', () => {
  const patched = loadRbacWithPatchedDefinition((definition) => ({
    ...definition,
    roles: {
      ...definition.roles,
      auditor: { label: 'Auditor', fullAccess: true, modules: '*', subModules: '*', permissions: '*' },
    },
  }));

  assert.ok(patched.FULL_ACCESS_ROLES.includes('auditor'));
  assert.equal(patched.isFullAccessRole('auditor'), true);
  assert.equal(patched.can({ role: 'auditor' }, 'Anything At All', 'whatever'), true);
});

// ──────────────────────── 3. middleware and authorize ────────────────────────

function runMiddleware(middleware, user) {
  const req = { user };
  let outcome = { nexted: false, error: null };
  middleware(req, {}, (error) => {
    outcome = { nexted: !error, error: error || null };
  });
  return { outcome, req };
}

test('requirePermission allows a granted capability and refuses the rest', () => {
  const socialworker = { id: 'U1', username: 'sw', role: 'socialworker' };

  assert.equal(runMiddleware(requirePermission('Violations', 'edit'), socialworker).outcome.nexted, true);

  // Social Worker has delete on Violations in the updated matrix; test a
  // permission they do not hold (manageUsers) so the refusal path is still
  // exercised.
  const denied = runMiddleware(requirePermission('Violations', 'manageUsers'), socialworker);
  assert.equal(denied.outcome.nexted, false);
  assert.ok(denied.outcome.error instanceof ApiError);
  assert.equal(denied.outcome.error.statusCode, 403);
  assert.match(denied.outcome.error.message, /manageUsers permission is required/i);
});

test('requirePermission refuses a module the caller cannot open', () => {
  const educator = { id: 'U2', username: 'ed', role: 'educator' };
  const denied = runMiddleware(requirePermission('Violations', 'view'), educator);
  assert.equal(denied.outcome.nexted, false);
  assert.equal(denied.outcome.error.statusCode, 403);
  assert.match(denied.outcome.error.message, /Violations module is not available/i);
});

test('requireSubModule refuses a submenu that was withheld', () => {
  const user = {
    id: 'U3',
    username: 'ed',
    role: 'educator',
    accessibleModules: ['Documents'],
    subModules: { Documents: ['Folders by Child'] },
  };

  assert.equal(runMiddleware(requireSubModule('Documents', 'Folders by Child'), user).outcome.nexted, true);

  const denied = runMiddleware(requireSubModule('Documents', 'Pending Review'), user);
  assert.equal(denied.outcome.nexted, false);
  assert.equal(denied.outcome.error.statusCode, 403);
  assert.match(denied.outcome.error.message, /Pending Review section of Documents/);
});

test('requireModule gates on the module alone', () => {
  const houseparent = { id: 'U4', username: 'hp', role: 'houseparent' };
  assert.equal(runMiddleware(requireModule('Violations'), houseparent).outcome.nexted, true);
  assert.equal(runMiddleware(requireModule('Education'), houseparent).outcome.nexted, false);
});

test('every RBAC guard bypasses for centerhead', () => {
  const centerhead = { id: 'U5', username: 'ch', role: 'centerhead' };

  assert.equal(runMiddleware(requirePermission('Violations', 'delete'), centerhead).outcome.nexted, true);
  assert.equal(runMiddleware(requirePermission('Account Management', 'manageUsers'), centerhead).outcome.nexted, true);
  assert.equal(runMiddleware(requireSubModule('Documents', 'Pending Review'), centerhead).outcome.nexted, true);
  assert.equal(runMiddleware(requireModule('Anything'), centerhead).outcome.nexted, true);
  // Even a module that does not exist in the definition.
  assert.equal(
    runMiddleware(requirePermission('Not A Module', 'notAPermission'), centerhead).outcome.nexted,
    true,
  );
});

test('every RBAC guard refuses an anonymous request with 401', () => {
  for (const guard of [
    requireModule('Dashboard'),
    requireSubModule('Documents', 'All Documents'),
    requirePermission('Violations', 'view'),
  ]) {
    const result = runMiddleware(guard, undefined);
    assert.equal(result.outcome.nexted, false);
    assert.equal(result.outcome.error.statusCode, 401);
  }
});

test('the guard computes and caches the snapshot on the request', () => {
  const req = { user: { id: 'U6', username: 'n', role: 'nurse' } };
  const snapshot = snapshotFor(req);
  assert.equal(req.user.access, snapshot, 'the snapshot must be cached on the request');
  assert.equal(snapshotFor(req), snapshot, 'a second call must reuse it');
});

test('authorize() lets a full-access role through a role list it is absent from', () => {
  const centerhead = { id: 'U7', username: 'ch', role: 'centerhead' };
  // A gate that names only 'nurse' must still admit the Center Head.
  assert.equal(runMiddleware(authorize('nurse'), centerhead).outcome.nexted, true);

  const houseparent = { id: 'U8', username: 'hp', role: 'houseparent' };
  const denied = runMiddleware(authorize('nurse'), houseparent);
  assert.equal(denied.outcome.nexted, false);
  assert.equal(denied.outcome.error.statusCode, 403);
});

test('authorize() still refuses an anonymous request', () => {
  const result = runMiddleware(authorize('centerhead'), undefined);
  assert.equal(result.outcome.nexted, false);
  assert.equal(result.outcome.error.statusCode, 401);
});

test('the admin role holds every module but is not a bypass', () => {
  // Deliberate: account and phase management stay Center Head-only, so a
  // blanket admin bypass would widen access the API never granted.
  const admin = { id: 'U9', username: 'admin', role: 'admin' };
  assert.equal(rbac.isFullAccessRole('admin'), false);
  assert.equal(rbac.listAccessibleMenus({ role: 'admin' }).length, rbac.MODULE_KEYS.length);
  assert.equal(rbac.can({ role: 'admin' }, 'Account Management', 'manageUsers'), true);

  const denied = runMiddleware(authorize('centerhead'), admin);
  assert.equal(denied.outcome.nexted, false, 'admin must not pass a centerhead-only gate');
  assert.equal(denied.outcome.error.statusCode, 403);
});

// ──────────────────────────────── 4. HTTP ────────────────────────────────────

function purgeSrcModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_ROOT) && !key.includes('node_modules')) delete require.cache[key];
  }
}

/**
 * A pool stub that answers the account lookup with one row and nothing else.
 * The row carries the grant columns, so the snapshot the API serves is built
 * from a realistic account rather than a hand-made object.
 */
function createPoolStub(account, { passwordHash = null } = {}) {
  const queries = [];

  async function query(sql, params) {
    const text = String(sql);
    queries.push({ sql: text, params });

    if (/SELECT \* FROM users WHERE username = \?/i.test(text)) {
      return [[{ ...account, password: passwordHash, status: 'Active' }]];
    }
    if (/FROM users WHERE id = \?/i.test(text)) {
      return [[{ ...account, status: 'Active' }]];
    }
    return [[]];
  }

  return {
    queries,
    query,
    async getConnection() {
      return {
        query,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      };
    },
  };
}

function loadApp(poolStub) {
  purgeSrcModules();
  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH,
    filename: DB_MODULE_PATH,
    loaded: true,
    exports: { pool: poolStub, dbConfig: {}, testConnection: async () => true },
  };

  const express = require('express');
  const routes = require(ROUTES_MODULE_PATH);
  const { errorHandler, notFoundHandler } = require('../src/middleware/errorHandler');

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', routes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const originalError = console.error;
  console.error = () => {};
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
  }
}

function tokenFor(role) {
  return jwt.sign({ id: 'U-TEST', username: 'tester', role }, TEST_SECRET, { expiresIn: '1h' });
}

function get(base, route, role) {
  return fetch(`${base}${route}`, {
    headers: { Authorization: `Bearer ${tokenFor(role)}` },
  });
}

/** Same as `get`, for the verbs a bypass attempt would actually use. */
function send(base, route, role, { method = 'GET', body } = {}) {
  return fetch(`${base}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokenFor(role)}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('GET /api/rbac/me returns the caller’s effective access and filtered menus', async () => {
  const account = {
    id: 'U-TEST',
    username: 'tester',
    role: 'centerhead',
    accessibleModules: JSON.stringify([...rbac.MODULE_KEYS]),
    childRecordTabs: JSON.stringify(['Personal Info']),
    subModules: JSON.stringify({}),
  };
  const app = loadApp(createPoolStub(account));

  await withServer(app, async (base) => {
    const response = await get(base, '/api/rbac/me', 'centerhead');
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.data.fullAccess, true);
    assert.equal(body.data.role, 'centerhead');
    assert.equal(body.data.roleLabel, 'Center Head');
    assert.deepEqual([...body.data.permissionList].sort(), [...rbac.PERMISSION_KEYS].sort());
    assert.deepEqual(
      body.data.menus.map((menu) => ({
        key: menu.key,
        subModules: menu.subModules.map((sub) => sub.key),
      })),
      EXPECTED_HIERARCHY,
      'the API must ship the full hierarchy for a full-access role',
    );
  });
});

test('GET /api/rbac/me narrows the menu tree for a restricted role', async () => {
  const account = {
    id: 'U-TEST',
    username: 'tester',
    role: 'educator',
    accessibleModules: JSON.stringify(['Dashboard', 'Child Records', 'Education', 'Documents']),
    childRecordTabs: JSON.stringify(['Personal Info', 'Education']),
    subModules: JSON.stringify({ Documents: ['Folders by Child'] }),
  };
  const app = loadApp(createPoolStub(account));

  await withServer(app, async (base) => {
    const response = await get(base, '/api/rbac/me', 'educator');
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.data.fullAccess, false);
    // Modules come back in definition order, which is the sidebar's order.
    assert.deepEqual(
      body.data.menus.map((menu) => menu.key),
      ['Dashboard', 'Child Records', 'Documents', 'Education'],
    );
    const childRecords = body.data.menus.find((menu) => menu.key === 'Child Records');
    assert.deepEqual(childRecords.subModules.map((sub) => sub.key), ['Personal Info', 'Education']);
    const documents = body.data.menus.find((menu) => menu.key === 'Documents');
    assert.deepEqual(documents.subModules.map((sub) => sub.key), ['Folders by Child']);
  });
});

test('GET /api/rbac/me requires authentication', async () => {
  const app = loadApp(createPoolStub({ id: 'U-TEST', username: 'tester', role: 'nurse' }));
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/rbac/me`);
    assert.equal(response.status, 401);
  });
});

test('GET /api/rbac/definition is readable by a full-access role', async () => {
  const account = { id: 'U-TEST', username: 'tester', role: 'centerhead' };
  const app = loadApp(createPoolStub(account));

  await withServer(app, async (base) => {
    const response = await get(base, '/api/rbac/definition', 'centerhead');
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.deepEqual(body.data.permissions, EXPECTED_PERMISSIONS);
    assert.deepEqual(
      body.data.modules.map((module) => module.key),
      EXPECTED_HIERARCHY.map((module) => module.key),
    );

    const centerhead = body.data.roles.find((role) => role.key === 'centerhead');
    assert.equal(centerhead.fullAccess, true);
    assert.equal(centerhead.modules.length, rbac.MODULE_KEYS.length);

    const houseparent = body.data.roles.find((role) => role.key === 'houseparent');
    assert.equal(houseparent.fullAccess, false);
    assert.equal(houseparent.modules.includes('Education'), false);
  });
});

test('GET /api/rbac/definition is refused to a role without Manage Roles', async () => {
  const account = { id: 'U-TEST', username: 'tester', role: 'houseparent' };
  const app = loadApp(createPoolStub(account));

  await withServer(app, async (base) => {
    const response = await get(base, '/api/rbac/definition', 'houseparent');
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(String(body.message || ''), /Manage Roles/i);
  });
});

test('the login response carries the resolved access snapshot', async () => {
  const password = 'correct-horse-battery';
  const passwordHash = await bcrypt.hash(password, 4);
  const account = {
    id: 'U-TEST',
    username: 'tester',
    displayName: 'Test Center Head',
    role: 'centerhead',
    accessibleModules: JSON.stringify([...rbac.MODULE_KEYS]),
    childRecordTabs: JSON.stringify([]),
    subModules: JSON.stringify({}),
  };
  const app = loadApp(createPoolStub(account, { passwordHash }));

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password }),
    });
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.ok(body.data.token, 'a token must still be issued');
    assert.equal(body.data.access.fullAccess, true);
    assert.equal(body.data.user.fullAccess, true);
    assert.deepEqual([...body.data.access.permissionList].sort(), [...rbac.PERMISSION_KEYS].sort());
    assert.deepEqual(
      body.data.user.menus.map((menu) => ({
        key: menu.key,
        subModules: menu.subModules.map((sub) => sub.key),
      })),
      EXPECTED_HIERARCHY,
    );
  });
});

test('a restricted account cannot read another module through the store payload', async () => {
  // The store endpoint already filters per role; this asserts the RBAC module
  // list did not accidentally open it up.
  const account = {
    id: 'U-TEST',
    username: 'tester',
    role: 'houseparent',
    accessibleModules: JSON.stringify(['Dashboard', 'Violations']),
    childRecordTabs: JSON.stringify([]),
    subModules: JSON.stringify({}),
  };
  const app = loadApp(createPoolStub(account));

  await withServer(app, async (base) => {
    const response = await get(base, '/api/store', 'houseparent');
    assert.equal(response.status, 200);
    const body = await response.json();
    // Education is role-gated in the store loader and houseparent has no access.
    assert.deepEqual(body.data.educationRecords, []);
    assert.deepEqual(body.data.educationProgressReports, []);
  });
});

// ──────────── 4b. the Psychologist's boundaries, called directly ──────────────
//
// The specification's "may not" list has to hold when the caller skips the UI.
// Each of these calls an endpoint with a valid token for the role and no
// browser in the way, so the refusal has to come from the server. `authorize()`
// alone would not be enough here: it names roles, so it cannot express
// "approve only the requests assigned to me".

/**
 * A freshly created Psychologist: no stored grants, so the role matrix in
 * `rbac.definition.json` is what resolves — the same path a new account takes.
 */
function psychologistAccount() {
  return {
    id: 'U-TEST',
    username: 'tester',
    role: 'psychologist',
    accessibleModules: JSON.stringify([]),
    childRecordTabs: JSON.stringify([]),
    subModules: JSON.stringify({}),
  };
}

test('the Psychologist is refused document delete, approve and the review queue over HTTP', async () => {
  const app = loadApp(createPoolStub(psychologistAccount()));

  await withServer(app, async (base) => {
    for (const [method, route] of [
      ['DELETE', '/api/documents/D1'],
      ['POST', '/api/documents/D1/approve'],
      ['POST', '/api/documents/D1/reject'],
      ['GET', '/api/documents/pending'],
    ]) {
      const response = await send(base, route, 'psychologist', { method, body: method === 'GET' ? undefined : {} });
      assert.equal(response.status, 403, `${method} ${route} must be refused to the Psychologist`);
    }
  });
});

test('the Psychologist is refused every module it does not hold over HTTP', async () => {
  const poolStub = createPoolStub(psychologistAccount());
  const app = loadApp(poolStub);

  await withServer(app, async (base) => {
    const response = await send(base, '/api/store', 'psychologist');
    assert.equal(response.status, 200);
    const body = await response.json();

    for (const resource of ['courtRecords', 'healthRecords', 'reports']) {
      assert.deepEqual(
        body.data[resource],
        [],
        `${resource} must be withheld from the Psychologist`,
      );
    }

    // An empty array that still cost a full read of the table is a leak waiting
    // for a mapping mistake, so assert the loader never issued the query.
    const sql = poolStub.queries.map((entry) => entry.sql).join('\n');
    for (const table of ['courtRecords', 'healthRecords', 'reports']) {
      assert.equal(
        new RegExp(`FROM\\s+\`?${table}\`?\\b`, 'i').test(sql),
        false,
        `the store loader must not read ${table} for the Psychologist`,
      );
    }
  });
});

test('the Psychologist cannot create or edit an incident form over HTTP', async () => {
  const app = loadApp(createPoolStub(psychologistAccount()));

  await withServer(app, async (base) => {
    const create = await send(base, '/api/incident-reports', 'psychologist', { method: 'POST', body: {} });
    assert.equal(create.status, 403, 'the Psychologist must not create an incident');

    const resubmit = await send(base, '/api/incident-reports/I1/resubmit', 'psychologist', { method: 'POST', body: {} });
    assert.equal(resubmit.status, 403, 'the Psychologist must not edit an incident');

    // Verifying is the one write the workflow assigns to the role, so it must
    // get past the guards and fail later (on the missing record), not with 403.
    const verify = await send(base, '/api/incident-reports/I1/verify', 'psychologist', { method: 'POST', body: {} });
    assert.notEqual(verify.status, 403, 'verification is inside the Psychologist workflow');
  });
});

test('the Psychologist cannot create or delete a violation over HTTP', async () => {
  const app = loadApp(createPoolStub(psychologistAccount()));

  await withServer(app, async (base) => {
    const create = await send(base, '/api/violations', 'psychologist', { method: 'POST', body: {} });
    assert.equal(create.status, 403, 'the Psychologist must not create an incident');

    const remove = await send(base, '/api/violations/V1', 'psychologist', { method: 'DELETE' });
    assert.equal(remove.status, 403, 'the Psychologist must not delete an intervention');
  });
});

test('a role without the Violations module cannot read violations or incident forms', async () => {
  const account = {
    id: 'U-TEST',
    username: 'tester',
    role: 'nurse',
    accessibleModules: JSON.stringify([]),
    childRecordTabs: JSON.stringify([]),
    subModules: JSON.stringify({}),
  };
  const app = loadApp(createPoolStub(account));

  await withServer(app, async (base) => {
    for (const route of [
      '/api/violations',
      '/api/violations/V1',
      '/api/violations/matrix',
      '/api/incident-reports/violation/V1',
    ]) {
      const response = await send(base, route, 'nurse');
      assert.equal(response.status, 403, `a role without Violations must be refused ${route}`);
    }
  });
});

// ──────────────── 4c. the Nurse's boundaries, called directly ────────────────
//
// Requirement 6 ends with "prevent direct URL/API bypass". Each of these calls
// an endpoint with a valid Nurse token and no browser in the way, so the
// refusal has to come from the server.

/**
 * A freshly created Nurse: no stored grants, so the role matrix in
 * `rbac.definition.json` is what resolves — the same path a new account takes.
 */
function nurseAccount() {
  return {
    id: 'U-TEST',
    username: 'tester',
    role: 'nurse',
    accessibleModules: JSON.stringify([]),
    childRecordTabs: JSON.stringify([]),
    subModules: JSON.stringify({}),
  };
}

test('the Nurse is refused document delete, approve, reject and the review queue over HTTP', async () => {
  const app = loadApp(createPoolStub(nurseAccount()));

  await withServer(app, async (base) => {
    for (const [method, route] of [
      ['DELETE', '/api/documents/D1'],
      ['POST', '/api/documents/D1/approve'],
      ['POST', '/api/documents/D1/reject'],
      ['GET', '/api/documents/pending'],
    ]) {
      const response = await send(base, route, 'nurse', { method, body: method === 'GET' ? undefined : {} });
      assert.equal(response.status, 403, `${method} ${route} must be refused to the Nurse`);
    }
  });
});

test('the Nurse is refused every module it does not hold over HTTP', async () => {
  const poolStub = createPoolStub(nurseAccount());
  const app = loadApp(poolStub);

  await withServer(app, async (base) => {
    const response = await send(base, '/api/store', 'nurse');
    assert.equal(response.status, 200);
    const body = await response.json();

    // Requirement 5 — "Show only nurse-relevant data". The bulk loader is where
    // a whole withheld module would otherwise arrive anyway.
    for (const resource of ['violations', 'courtRecords', 'reports', 'assessments', 'activities']) {
      assert.deepEqual(body.data[resource], [], `${resource} must be withheld from the Nurse`);
    }

    // Health is the module the Nurse does hold, so it must still be served.
    assert.ok(Array.isArray(body.data.healthRecords), 'the Nurse must still receive health records');
    assert.ok(Array.isArray(body.data.documents), 'the Nurse must still receive its visible documents');

    // An empty array that still cost a full read of the table is a leak waiting
    // for a mapping mistake, so assert the loader never issued the query.
    const sql = poolStub.queries.map((entry) => entry.sql).join('\n');
    for (const table of ['violations', 'courtRecords', 'reports', 'assessments']) {
      assert.equal(
        new RegExp(`FROM\\s+\`?${table}\`?\\b`, 'i').test(sql),
        false,
        `the store loader must not read ${table} for the Nurse`,
      );
    }
  });
});

test('the Nurse cannot create, edit or delete an incident or a violation over HTTP', async () => {
  const app = loadApp(createPoolStub(nurseAccount()));

  await withServer(app, async (base) => {
    // Requirement 4 — incidents.
    const create = await send(base, '/api/incident-reports', 'nurse', { method: 'POST', body: {} });
    assert.equal(create.status, 403, 'the Nurse must not create an incident');
    const resubmit = await send(base, '/api/incident-reports/I1/resubmit', 'nurse', { method: 'POST', body: {} });
    assert.equal(resubmit.status, 403, 'the Nurse must not edit an incident');

    // And the same records through the Violations module.
    for (const [method, route] of [
      ['POST', '/api/violations'],
      ['PUT', '/api/violations/V1'],
      ['DELETE', '/api/violations/V1'],
      ['POST', '/api/violations/V1/mark-done'],
    ]) {
      const response = await send(base, route, 'nurse', { method, body: method === 'GET' ? undefined : {} });
      assert.equal(response.status, 403, `${method} ${route} must be refused to the Nurse`);
    }
  });
});

test('the Nurse cannot create, edit or delete an assessment over HTTP', async () => {
  // The Nurse reads the assessment schedule (the dashboard's "Upcoming
  // Assessments") but the specification grants no Assessments module, so every
  // write is refused. The write routes named `nurse` until this was fixed.
  const app = loadApp(createPoolStub(nurseAccount()));

  await withServer(app, async (base) => {
    for (const [method, route] of [
      ['POST', '/api/assessments'],
      ['PUT', '/api/assessments/A1'],
      ['POST', '/api/assessments/A1/complete'],
      ['DELETE', '/api/assessments/A1'],
    ]) {
      const response = await send(base, route, 'nurse', { method, body: method === 'GET' ? undefined : {} });
      assert.equal(response.status, 403, `${method} ${route} must be refused to the Nurse`);
    }

    // Reading the upcoming schedule is the one assessment surface the role
    // needs, so it must get past the guards rather than 403.
    const upcoming = await send(base, '/api/assessments/upcoming', 'nurse');
    assert.equal(upcoming.status, 200, 'the Nurse dashboard needs the upcoming assessment schedule');
  });
});

test('the Nurse cannot file a medical record under a generic title over HTTP', async () => {
  // Requirement 3 — "Nurse and Center Head only can create/manage medical
  // records and documents." The document-type rule cannot see a medical
  // document posted as `Other`, so the derived folder is what is enforced. This
  // is the socialworker path: it holds Documents:create, so only the folder
  // check stands between it and a Medical Records entry.
  const app = loadApp(createPoolStub({
    id: 'U-TEST',
    username: 'tester',
    role: 'socialworker',
    accessibleModules: JSON.stringify([]),
    childRecordTabs: JSON.stringify([]),
    subModules: JSON.stringify({}),
  }));

  await withServer(app, async (base) => {
    const response = await send(base, '/api/documents', 'socialworker', {
      method: 'POST',
      body: { title: 'Ward Note', type: 'Other', category: 'Medical', residentId: 'R1' },
    });
    assert.equal(response.status, 403, 'a non-medical role must not file a Medical Records document');
  });
});

test('the Nurse may file and manage a medical record over HTTP', async () => {
  // The counterpart to the test above: the folder gate must not have closed the
  // door on the role the specification names. A refusal here would be a 403; the
  // stub database cannot complete the insert, so "not 403" is the assertion that
  // matters — the guard let the request through to the write.
  const app = loadApp(createPoolStub(nurseAccount()));

  await withServer(app, async (base) => {
    const create = await send(base, '/api/documents', 'nurse', {
      method: 'POST',
      body: { title: 'Ward Note', type: 'Other', category: 'Medical', residentId: 'R1' },
    });
    assert.notEqual(create.status, 403, 'the Nurse must be able to file a medical record');

    const createNamed = await send(base, '/api/documents', 'nurse', {
      method: 'POST',
      body: { title: 'Health Record Form', type: 'Health Record Form', category: 'Medical', residentId: 'R1' },
    });
    assert.notEqual(createNamed.status, 403, 'the Nurse must be able to file a named medical document');
  });
});

// ───────────── 4d. the Houseparent's boundaries, called directly ─────────────
//
// The specification's Security section ends with "Prevent direct URL and API
// permission bypass". Each of these calls an endpoint with a valid Houseparent
// token and no browser in the way, so the refusal has to come from the server.

/**
 * A freshly created Houseparent: no stored grants, so the role matrix in
 * `rbac.definition.json` is what resolves — the same path a new account takes.
 */
function houseparentAccount() {
  return {
    id: 'U-TEST',
    username: 'tester',
    role: 'houseparent',
    accessibleModules: JSON.stringify([]),
    childRecordTabs: JSON.stringify([]),
    subModules: JSON.stringify({}),
  };
}

test('the Houseparent is refused every module it does not hold over HTTP', async () => {
  const app = loadApp(createPoolStub(houseparentAccount()));

  await withServer(app, async (base) => {
    for (const route of [
      '/api/health-records',              // "cannot access Health module"
      '/api/healthRecords',               // the same mount, legacy spelling
      '/api/reports',                     // not in the access list
      '/api/staff',                       // "cannot manage administrative settings"
      '/api/courtRecords',                // not in the access list
      '/api/court',
      '/api/quarterly-progress-reports',
    ]) {
      const response = await send(base, route, 'houseparent');
      assert.equal(response.status, 403, `GET ${route} must be refused to the Houseparent`);
    }
  });
});

test('the Houseparent is refused incident writes over HTTP', async () => {
  const app = loadApp(createPoolStub(houseparentAccount()));

  await withServer(app, async (base) => {
    for (const [method, route] of [
      ['POST', '/api/violations'],
      ['PUT', '/api/violations/V1'],
      ['DELETE', '/api/violations/V1'],
    ]) {
      const response = await send(base, route, 'houseparent', { method, body: {} });
      assert.equal(response.status, 403, `${method} ${route} must be refused to the Houseparent`);
    }

    // Reading the list is granted, so it has to get past the guards rather than
    // 403. The stub answers no rows, so an empty list is the success shape.
    const list = await send(base, '/api/violations', 'houseparent');
    assert.equal(list.status, 200, 'the Houseparent may view the Violation List');
  });
});

test('the Houseparent may still run the Intervention Tracker over HTTP', async () => {
  // The tracker is a Violations tab the specification grants, and completing an
  // intervention is authorised by the route's own role list — it must not be
  // caught by the module-level "view only" grant on Violations.
  const app = loadApp(createPoolStub(houseparentAccount()));

  await withServer(app, async (base) => {
    const done = await send(base, '/api/violations/V1/mark-done', 'houseparent', {
      method: 'POST',
      body: {},
    });
    assert.notEqual(done.status, 403, 'the Houseparent must be able to complete an intervention');

    const scheduled = await send(base, '/api/violation-guide/interventions/scheduled', 'houseparent');
    assert.equal(scheduled.status, 200, 'the dashboard needs the assigned intervention schedule');
  });
});

test('the Houseparent may still reach Activities and the assessment schedule', async () => {
  const app = loadApp(createPoolStub(houseparentAccount()));

  await withServer(app, async (base) => {
    assert.equal((await send(base, '/api/activities', 'houseparent')).status, 200);
    // The activity evaluation form writes `activityEvaluations`, an Activities
    // resource, so it travels with the Activities module.
    assert.equal((await send(base, '/api/evaluations', 'houseparent')).status, 200);
    assert.equal((await send(base, '/api/assessments/upcoming', 'houseparent')).status, 200);

    // Scheduling an assessment is not granted — "Access Assessments" is read.
    const create = await send(base, '/api/assessments', 'houseparent', { method: 'POST', body: {} });
    assert.equal(create.status, 403, 'the Houseparent must not schedule an assessment');
  });
});

test('the resident payload withholds the medical summary from the Houseparent', async () => {
  // `children.medicalRecords` and `children.lastCheckup` ride along on the
  // resident row instead of behind a route of their own, so no module gate
  // covers them. `GET /children` therefore has to redact them for a role that
  // does not hold Child Records — otherwise the API is a direct path to the
  // very data "cannot access Medical records/modules" withholds.
  //
  // The Nurse is the control: it holds Child Records, so its payload must be
  // untouched.
  const childRow = {
    id: 'CH1',
    name: 'Resident One',
    status: 'Active',
    medicalRecords: [{ name: 'Medical Certificate', category: 'Medical' }],
    lastCheckup: '2026-01-05',
  };
  const healthRow = { id: 'H1', residentId: 'CH1', recordType: 'Health Assessment' };

  function stubFor(role) {
    const stub = createPoolStub({ ...houseparentAccount(), role });
    const baseQuery = stub.query;
    stub.query = async (sql, params) => {
      const text = String(sql);
      if (/FROM\s+`?children`?\b/i.test(text)) return [[{ ...childRow }]];
      if (/FROM\s+`?healthRecords`?\b/i.test(text)) return [[{ ...healthRow }]];
      if (/FROM\s+residentAssignments\b/i.test(text)) return [[{ residentId: 'CH1' }]];
      return baseQuery(sql, params);
    };
    return stub;
  }

  for (const [role, medical, checkup] of [
    ['houseparent', [], null],
    ['nurse', childRow.medicalRecords, '2026-01-05'],
    // The control that matters for the Educator: it HOLDS Child Records, so a
    // module-level rule would leave the medical summary in its payload even
    // though its specification says it must never reach medical records. The
    // rule is the Medical tab, and this is what proves it.
    ['educator', [], null],
  ]) {
    const app = loadApp(stubFor(role));
    await withServer(app, async (base) => {
      const response = await send(base, '/api/children', role);
      assert.equal(response.status, 200);
      const body = await response.json();
      const child = (body.data || [])[0];
      assert.ok(child, `${role} must receive the resident row`);
      assert.deepEqual(child.medicalRecords, medical, `${role}: medicalRecords`);
      assert.equal(child.lastCheckup, checkup, `${role}: lastCheckup`);
    });
  }
});

test('the single-resident payload withholds the medical summary and the health records', async () => {
  // The same two fields appear again on `GET /children/:id`, which additionally
  // embeds the resident's `healthRecords` rows — the Health module's table. That
  // mount is now gated, so this embedding would otherwise be a second door.
  const childRow = {
    id: 'CH1',
    name: 'Resident One',
    status: 'Active',
    medicalRecords: [{ name: 'Medical Certificate', category: 'Medical' }],
    lastCheckup: '2026-01-05',
  };
  const healthRow = { id: 'H1', residentId: 'CH1', recordType: 'Health Assessment' };

  function stubFor(role) {
    const stub = createPoolStub({ ...houseparentAccount(), role });
    const baseQuery = stub.query;
    stub.query = async (sql, params) => {
      const text = String(sql);
      if (/FROM\s+`?children`?\b/i.test(text)) return [[{ ...childRow }]];
      if (/FROM\s+`?healthRecords`?\b/i.test(text)) return [[{ ...healthRow }]];
      if (/FROM\s+residentAssignments\b/i.test(text)) return [[{ residentId: 'CH1' }]];
      return baseQuery(sql, params);
    };
    return stub;
  }

  for (const [role, medical, checkup, health] of [
    ['houseparent', [], null, []],
    ['nurse', childRow.medicalRecords, '2026-01-05', [healthRow]],
    // Holds Child Records, must still see no medical summary and no health rows.
    ['educator', [], null, []],
  ]) {
    const app = loadApp(stubFor(role));
    await withServer(app, async (base) => {
      const response = await send(base, '/api/children/CH1', role);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.data.medicalRecords, medical, `${role}: medicalRecords`);
      assert.equal(body.data.lastCheckup, checkup, `${role}: lastCheckup`);
      assert.deepEqual(body.data.healthRecords, health, `${role}: healthRecords`);
    });
  }
});

// ─────────────── 4e. the Educator's boundaries, called directly ──────────────
//
// Same premise as 4d: a valid token, no browser in the way, so every refusal has
// to come from the server.

/** A freshly created Educator: no stored grants, so the role matrix resolves. */
function educatorAccount() {
  return {
    id: 'U-EDU',
    username: 'educator1',
    role: 'educator',
    accessibleModules: JSON.stringify([]),
    childRecordTabs: JSON.stringify([]),
    subModules: JSON.stringify({}),
  };
}

test('the Educator is refused every module it does not hold over HTTP', async () => {
  const app = loadApp(createPoolStub(educatorAccount()));

  await withServer(app, async (base) => {
    for (const route of [
      '/api/health-records',              // "cannot access the Health Module"
      '/api/healthRecords',               // the same mount, legacy spelling
      '/api/violations',                  // "cannot access Violations"
      '/api/activities',
      '/api/assessments',
      '/api/reports',                     // not in the access list
      '/api/staff',                       // "cannot access Administrative Modules"
      '/api/courtRecords',
      '/api/court',
      '/api/quarterly-progress-reports',
      '/api/tri',
    ]) {
      const response = await send(base, route, 'educator');
      assert.equal(response.status, 403, `GET ${route} must be refused to the Educator`);
    }
  });
});

test('the Educator is refused every document write over HTTP', async () => {
  // "Cannot: Manage Documents" — no create, no edit, no delete, no global
  // approval, and no review queue. Reading stays, because the specification
  // allows a view when the access-request workflow grants one.
  const app = loadApp(createPoolStub(educatorAccount()));

  await withServer(app, async (base) => {
    for (const [method, route] of [
      ['POST', '/api/documents'],
      ['PUT', '/api/documents/D1'],
      ['POST', '/api/documents/D1/submit'],
      ['POST', '/api/documents/D1/approve'],
      ['POST', '/api/documents/D1/reject'],
      ['DELETE', '/api/documents/D1'],
    ]) {
      const response = await send(base, route, 'educator', { method, body: {} });
      assert.equal(response.status, 403, `${method} ${route} must be refused to the Educator`);
    }

    // The review queue and the audit trail are separate GETs, so they carry no body.
    for (const route of ['/api/documents/pending', '/api/access-requests/history']) {
      const response = await send(base, route, 'educator');
      assert.equal(response.status, 403, `GET ${route} must be refused to the Educator`);
    }

    // The listing and the request queue are the readable half, so they must get
    // past the guards rather than 403.
    for (const route of ['/api/documents', '/api/documents/requestable', '/api/access-requests']) {
      const response = await send(base, route, 'educator');
      assert.notEqual(response.status, 403, `GET ${route} must not be refused to the Educator`);
    }
  });
});

test('the Educator may read and write Education records but never delete one', async () => {
  // The Education mount used to be a role-name allow-list, so the Educator could
  // DELETE an education record through the API even though its specification
  // grants only "view, create and edit".
  const app = loadApp(createPoolStub(educatorAccount()));

  await withServer(app, async (base) => {
    for (const route of [
      '/api/education-records',
      '/api/education-progress-reports',
      '/api/education-school-visits',
      '/api/education-monthly-reports',
    ]) {
      const read = await send(base, route, 'educator');
      assert.equal(read.status, 200, `GET ${route} must be granted to the Educator`);
    }

    for (const route of [
      '/api/education-records/E1',
      '/api/education-progress-reports/P1',
      '/api/education-school-visits/V1',
      '/api/education-monthly-reports/M1',
    ]) {
      const response = await send(base, route, 'educator', { method: 'DELETE' });
      assert.equal(response.status, 403, `DELETE ${route} must be refused to the Educator`);
    }

    // Creating and editing must get past the guard; the stub answers nothing, so
    // anything but 403 is the success shape.
    const create = await send(base, '/api/education-records', 'educator', {
      method: 'POST',
      body: { name: 'Resident One' },
    });
    assert.notEqual(create.status, 403, 'the Educator must be able to create an education record');
    const update = await send(base, '/api/education-records/E1', 'educator', {
      method: 'PUT',
      body: { name: 'Resident One' },
    });
    assert.notEqual(update.status, 403, 'the Educator must be able to edit an education record');
  });
});

test('the Educator is refused every resident and admission write over HTTP', async () => {
  // "View Personal Info" is a read. The resident update is gated on
  // Child Records:edit and the admission writes on Child Records:create/edit, so
  // the read-only grant is what refuses these — not a role name.
  const app = loadApp(createPoolStub(educatorAccount()));

  await withServer(app, async (base) => {
    for (const [method, route] of [
      ['PUT', '/api/children/CH1'],
      ['DELETE', '/api/children/CH1'],
      ['POST', '/api/children/CH1/readmit'],
      ['POST', '/api/children/CH1/toggle-psych-assessment'],
      ['POST', '/api/admissions'],
      ['PUT', '/api/admissions/A1'],
    ]) {
      const response = await send(base, route, 'educator', { method, body: {} });
      assert.equal(response.status, 403, `${method} ${route} must be refused to the Educator`);
    }

    // Reading is what "view Personal Info" grants, and the Admission Slip is
    // rendered inside that tab — so the read must not be caught by the write gate.
    const slip = await send(base, '/api/admissions/resident/CH1/latest', 'educator');
    assert.notEqual(slip.status, 403, 'the Personal Info tab must still render the Admission Slip');
    const residents = await send(base, '/api/children', 'educator');
    assert.equal(residents.status, 200, 'the Educator may list residents it holds Child Records for');
  });
});

test('the Educator cannot create, edit or delete an incident over HTTP', async () => {
  const app = loadApp(createPoolStub(educatorAccount()));

  await withServer(app, async (base) => {
    for (const [method, route] of [
      ['POST', '/api/violations'],
      ['PUT', '/api/violations/V1'],
      ['DELETE', '/api/violations/V1'],
      ['POST', '/api/incident-reports'],
      ['POST', '/api/incident-reports/I1/resubmit'],
    ]) {
      const response = await send(base, route, 'educator', { method, body: {} });
      assert.equal(response.status, 403, `${method} ${route} must be refused to the Educator`);
    }
  });
});

test('the store withholds every module the Educator does not hold', async () => {
  const poolStub = createPoolStub(educatorAccount());
  const app = loadApp(poolStub);

  await withServer(app, async (base) => {
    const response = await send(base, '/api/store', 'educator');
    assert.equal(response.status, 200);
    const body = await response.json();

    // The bulk loader is where a whole withheld module would otherwise arrive
    // anyway: the sidebar is not the only way into it, and the Educator's
    // dashboard reads from this payload.
    for (const resource of [
      'assessments', 'activities', 'activityEvaluations', 'violations',
      'violationGuide', 'interventionTypes', 'courtRecords', 'healthRecords',
      'reports', 'users',
    ]) {
      assert.deepEqual(body.data[resource], [], `${resource} must be withheld from the Educator`);
    }

    // The modules the Educator does hold must still be served, or the role's own
    // pages lose their data along with the withheld ones.
    assert.ok(Array.isArray(body.data.documents), 'the Educator must still receive its visible documents');
    assert.ok(Array.isArray(body.data.children), 'the Educator must still receive residents');

    // An empty array that still cost a full read of the table is a leak waiting
    // for a mapping mistake, so assert the loader never issued the query.
    const sql = poolStub.queries.map((entry) => entry.sql).join('\n');
    for (const table of ['violations', 'courtRecords', 'healthRecords', 'reports', 'assessments', 'activities']) {
      assert.equal(
        new RegExp(`FROM\\s+\`?${table}\`?\\b`, 'i').test(sql),
        false,
        `the store loader must not read ${table} for the Educator`,
      );
    }
  });
});

test('every store resource the loader gates is named the way the loader names it', () => {
  // `resourceMapping` renames a table to a frontend resource before
  // `STORE_MODULE_BY_RESOURCE` is consulted, so a map key that is a *table* name
  // rather than a *resource* name never matches. The entry looks like a gate and
  // is not one: the resource ships to every role. `violation_guide` and
  // `intervention_types` sat in exactly that state.
  const source = read('backend/src/routes/index.js');

  const mapStart = source.indexOf('const STORE_MODULE_BY_RESOURCE = {');
  assert.ok(mapStart > 0, 'STORE_MODULE_BY_RESOURCE is gone');
  const mapEnd = source.indexOf('};', mapStart);
  const mapped = [...source.slice(mapStart, mapEnd).matchAll(/^\s*(\w+):/gm)].map((match) => match[1]);

  const mappingStart = source.indexOf('const resourceMapping = {');
  assert.ok(mappingStart > 0, 'resourceMapping is gone');
  const mappingEnd = source.indexOf('};', mappingStart);
  const produced = [...source.slice(mappingStart, mappingEnd).matchAll(/'(\w+)':\s*'(\w+)'/g)]
    .map((match) => match[2]);

  for (const key of mapped) {
    assert.ok(
      produced.includes(key),
      `STORE_MODULE_BY_RESOURCE gates "${key}", but the loader never produces a resource by that name — the entry is dead and the resource is served to every role`,
    );
  }
});

// ───────────── 5. authenticate attaches the snapshot to the principal ─────────

test('authenticate attaches the resolved access snapshot to the request', async () => {
  const account = {
    id: 'U-TEST',
    username: 'tester',
    role: 'educator',
    accessibleModules: JSON.stringify(['Dashboard', 'Documents']),
    childRecordTabs: JSON.stringify(['Personal Info', 'Education']),
    subModules: JSON.stringify({ Documents: ['Folders by Child'] }),
  };

  purgeSrcModules();
  const dbEntry = require.cache[DB_MODULE_PATH];
  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH,
    filename: DB_MODULE_PATH,
    loaded: true,
    exports: { pool: createPoolStub(account), dbConfig: {}, testConnection: async () => true },
  };
  delete require.cache[require.resolve('../src/middleware/auth')];
  const auth = require('../src/middleware/auth');

  const req = { headers: { authorization: `Bearer ${tokenFor('educator')}` } };
  await new Promise((resolve, reject) => {
    auth.authenticate(req, {}, (error) => (error ? reject(error) : resolve()));
  });

  if (dbEntry) require.cache[DB_MODULE_PATH] = dbEntry;
  else delete require.cache[DB_MODULE_PATH];

  assert.equal(req.user.role, 'educator');
  assert.ok(req.user.access, 'the snapshot must ride along with the principal');
  assert.equal(req.user.access.fullAccess, false);
  assert.deepEqual([...req.user.access.modules].sort(), ['Dashboard', 'Documents']);
  assert.deepEqual(req.user.access.subModules.Documents, ['Folders by Child']);
  assert.equal(req.user.access.permissions['*'].includes('view'), true);
});

// ─────────────── 6. the grant editor cannot drift from the model ─────────────

test('the grant editor renders the definition, not a private copy of it', () => {
  const source = read('frontend/src/app/components/AccountManagement.tsx');
  // A second, hand-written module list here is how the old three-copy
  // permission map started. The page must render MODULE_TREE.
  assert.match(source, /MODULE_TREE/, 'Account Management must render the canonical module tree');
  assert.doesNotMatch(
    source,
    /const AVAILABLE_MODULES\s*=\s*\[/,
    'Account Management must not keep its own module list',
  );
  assert.doesNotMatch(
    source,
    /const CHILD_RECORD_TABS\s*=\s*\[/,
    'Account Management must not keep its own tab list',
  );
  assert.match(source, /subModules/, 'the grant editor must send submenu grants');
});

test('the sidebar renders the RBAC hierarchy rather than a hand-written role list', () => {
  const source = read('frontend/src/app/components/Layout.tsx');
  assert.match(source, /MODULE_TREE/, 'the sidebar must read the canonical hierarchy');
  assert.match(source, /usePermissions/, 'the sidebar must gate on the resolved capabilities');
  // No hand-rolled role comparison should survive in the navigation.
  assert.doesNotMatch(source, /userRole\s*===\s*'centerhead'/, 'the sidebar must not special-case roles');
});

test('routes gate on the RBAC model rather than a hard-coded admin check', () => {
  const source = read('frontend/src/app/App.tsx');
  assert.match(source, /canOpenModule/, 'ProtectedRoute must use the RBAC module gate');
  assert.doesNotMatch(
    source,
    /const isAdmin\s*=\s*isFullAccessRole/,
    'ProtectedRoute must not branch on a hard-coded admin flag',
  );
});

test('notifications derive their route->module map instead of copying it', () => {
  const source = read('frontend/src/app/components/Notifications.tsx');
  assert.match(source, /MODULE_TREE/, 'notifications must derive the route map from the hierarchy');
  assert.match(source, /canOpenModule/, 'notifications must gate on the RBAC model');
  // The old hand-written map and the role shortcut are what let this drift.
  assert.doesNotMatch(source, /canonicalizeModules/, 'notifications must not re-derive module access');
  assert.doesNotMatch(
    source,
    /role\s*===\s*'centerhead'\s*\|\|\s*role\s*===\s*'admin'/,
    'notifications must not special-case roles',
  );
});

test('every frontend route->module derivation agrees with the definition', () => {
  // The three consumers (ProtectedRoute's MODULE_ROUTES, the sidebar and the
  // notification router) must resolve the same route to the same module.
  const layout = read('frontend/src/app/components/Layout.tsx');
  const sidebar = /const SIDEBAR_ORDER[^=]*=\s*\[([\s\S]*?)\n\];/.exec(layout);
  assert.ok(sidebar, 'expected SIDEBAR_ORDER');

  const byRoute = new Map(rbac.MODULE_TREE.map((module) => [module.route, module.key]));
  for (const match of sidebar[1].matchAll(/module:\s*'([^']+)',\s*path:\s*'([^']+)'/g)) {
    assert.equal(byRoute.get(match[2]), match[1], `route ${match[2]} maps to the wrong module`);
  }
});

test('userController persists the hierarchy-aware grant', () => {
  const source = read('backend/src/controllers/userController.js');
  assert.match(source, /resolveSubModuleGrants/, 'the controller must resolve submenu grants');
  assert.match(source, /subModules\s*=\s*\?/, 'the controller must write the subModules column');
  assert.match(source, /selectUsers/, 'reads must include the grant columns');
});

test('the subModules column is declared in the schema, the migration and the resource contract', () => {
  const schema = read('backend/src/database/schema.sql');
  const usersTable = /CREATE TABLE users \(([\s\S]*?)\) ENGINE/.exec(schema);
  assert.ok(usersTable, 'expected the users table definition');
  assert.match(usersTable[1], /subModules JSON NULL/, 'the users table must declare subModules');

  const server = read('backend/src/server.js');
  assert.match(
    server,
    /ensureColumn\('users',\s*'subModules'/,
    'runMigrations must add subModules to an existing database',
  );

  const { RESOURCES } = require('../src/utils/constants');
  assert.ok(
    RESOURCES.users.columns.includes('subModules'),
    'the users resource contract must list subModules',
  );
  assert.ok(
    RESOURCES.users.jsonFields.includes('subModules'),
    'subModules must be parsed as JSON when read back',
  );
});

// ─────────── 7. the Psychologist's module surfaces render the model ──────────
//
// The specification's "Remove unauthorized buttons, routes, and actions" is a
// frontend requirement as much as a backend one. A route guard the UI never
// consults still leaves the button on screen, and a hand-written tab list is a
// second copy of the matrix that drifts the moment the matrix changes.

test('the Violations module renders its tabs from the RBAC definition', () => {
  const source = read('frontend/src/app/components/Violations.tsx');

  assert.match(
    source,
    /useSubModuleTabs\('Violations'\)/,
    'the Violations tabs must come from the definition, not from a hand-written list',
  );
  // The old strip built the list inline and gated `manage` on `isCenterHead`,
  // which withheld a tab the guide's own write routes already authorized for the
  // Social Worker and the Psychologist.
  assert.doesNotMatch(
    source,
    /\.\.\.\(isCenterHead \? \[\{ key: 'manage'/,
    'the manage tab is gated on a role name again',
  );
  assert.doesNotMatch(
    source,
    /activeTab === 'manage' && isCenterHead/,
    'the manage panel is gated on a role name again',
  );
});

test('the Violations module hides incident creation behind the create capability', () => {
  const source = read('frontend/src/app/components/Violations.tsx');

  assert.match(
    source,
    /can\('Violations', 'create'\)/,
    'logging an incident must be gated on the Violations create capability',
  );
  assert.match(
    source,
    /can\('Violations', 'verify'\)/,
    'the verification tab must be gated on the verify capability',
  );
});

test('the Psychologist gets its own dashboard rather than the shared one pruned', () => {
  const source = read('frontend/src/app/components/Dashboard.tsx');

  // The six widgets the specification names, and nothing from the shared page.
  assert.match(source, /function PsychologistDashboard\(/, 'the Psychologist dashboard component is gone');
  assert.match(
    source,
    /if \(userRole === 'psychologist'\)\s*\{[\s\S]{0,400}?<PsychologistDashboard/,
    'the Psychologist no longer leaves the shared dashboard',
  );

  const component = source.slice(source.indexOf('function PsychologistDashboard('));
  const body = component.slice(0, component.indexOf('\n// ── DASHBOARD'));
  for (const widget of [
    "Today's Assessments",
    "This Week's Assessments",
    'Pending Assessments',
    'Assessment Summary',
    'Pending Reviews',
    'Assigned Cases',
  ]) {
    assert.ok(body.includes(widget), `the Psychologist dashboard is missing the "${widget}" widget`);
  }

  // The old inline section was reachable only by a Psychologist and is now
  // unreachable — a second, contradictory copy of the same page.
  assert.doesNotMatch(
    source,
    /My Scheduled Assessments/,
    'the superseded inline Psychologist section is still in the shared dashboard',
  );
});

test('the Psychologist dashboard counts only what the specification asks for', () => {
  const source = read('frontend/src/app/components/Dashboard.tsx');
  const component = source.slice(source.indexOf('function PsychologistDashboard('));
  const body = component.slice(0, component.indexOf('\n// ── DASHBOARD'));

  // Statistics that belong to other roles must not have been carried over.
  for (const unrelated of ['Closed Cases', 'Total Residents', 'Urgency Level', 'TRI Monitoring', 'Health Overview']) {
    assert.ok(
      !body.includes(unrelated),
      `the Psychologist dashboard still shows the unrelated "${unrelated}" statistic`,
    );
  }
});

test('the Child Records tabs render the definition rather than an all-tabs fallback', () => {
  const source = read('frontend/src/app/components/ChildDetail.tsx');

  assert.match(
    source,
    /useSubModuleTabs\('Child Records'\)/,
    'the Child Records tabs must come from the definition',
  );
  // The fallback handed every tab to any role whose `childRecordTabs` was unset,
  // which showed the Education tab to a Psychologist whose matrix withholds it.
  assert.doesNotMatch(
    source,
    /allowedTabs\.includes\('Education'\)/,
    'the hand-written tab list is back',
  );
  assert.doesNotMatch(
    source,
    /role === 'centerhead' \|\| role === 'admin'\)\s*\n?\s*\?\s*\['Personal Info'/,
    'the tab list is branched on a role name again',
  );

  // Every tab the definition declares must have a key the page can select, or
  // the strip renders a trigger that opens nothing.
  const rbac = require('../src/config/rbac');
  const declared = rbac.MODULE_BY_KEY['Child Records'].subModules.map((sub) => sub.tab);
  assert.deepEqual(declared, ['personal', 'timeline', 'education', 'medical', 'behavioral']);
  for (const tab of declared) {
    assert.ok(
      source.includes(`value="${tab}"`) || source.includes("value={tab.key}"),
      `no TabsContent for the ${tab} tab`,
    );
  }
});

// ────────────── 7c. the Nurse's surfaces render the model ───────────────────
//
// Requirement 1 (Medical Notes gated to Nurse + Center Head) and requirement 2
// (one source of truth for Health ↔ Medical) are both properties of the
// components, so they are asserted at the source level the way the module
// surfaces are.

test('the Medical Notes editor is gated on the Health capability, not a role name', () => {
  const source = read('frontend/src/app/components/ChildDetail.tsx');

  assert.match(
    source,
    /can\('Health',\s*'edit'\)/,
    'the Medical Notes editor must ask the RBAC model who may write one',
  );
  assert.doesNotMatch(
    source,
    /role\s*===\s*'nurse'/,
    'the Medical Notes editor is branched on a role name again',
  );
  // The editor and its button are the two affordances requirement 1 restricts.
  assert.match(source, /isEditingMedicalNotes/, 'the Medical Notes editor is gone');
});

test('the Health module and the child Medical tab read one source for medical documents', () => {
  // Requirement 2 — "Use a single source of truth and avoid duplicates."
  // Medical documents live in the Documents module; both views filter the same
  // in-memory `documents` array instead of each fetching their own copy.
  for (const file of ['frontend/src/app/components/Health.tsx', 'frontend/src/app/components/ChildDetail.tsx']) {
    const source = read(file);
    // Health compares the lower-cased category, ChildDetail the raw one — both
    // are the Documents module's Medical category, so either spelling counts.
    assert.match(
      source,
      /(category\s*===\s*'Medical'|toLowerCase\(\)\s*===\s*'medical')/,
      `${file} must read medical documents from the shared documents array`,
    );
  }

  const health = read('frontend/src/app/components/Health.tsx');
  // The module used to call the store itself and keep a private `health` array.
  assert.doesNotMatch(health, /getStore\(/, 'Health must not fetch the store a second time');
  assert.match(health, /healthRecords/, 'Health must read health records from the shared context');
});

test('the Health module and the child Medical tab read one source for health records', () => {
  // The other half of requirement 2: a record logged in Health appears in
  // Child Records → Medical → Health & Medical History, and vice versa, because
  // both read the one `healthRecords` array the data context loads.
  const context = read('frontend/src/app/state/DataContext.tsx');
  assert.match(context, /healthRecords/, 'the data context must expose health records');

  for (const file of ['frontend/src/app/components/Health.tsx', 'frontend/src/app/components/ChildDetail.tsx']) {
    const source = read(file);
    assert.match(
      source,
      /healthRecords/,
      `${file} must read health records from the shared context`,
    );
  }

  const detail = read('frontend/src/app/components/ChildDetail.tsx');
  // Both views must be fed by the same write path, or the second one goes stale.
  assert.match(detail, /updateChild\(/, 'the child record must persist through the shared update');
  assert.match(
    read('frontend/src/app/components/Health.tsx'),
    /refreshData/,
    'Health must refresh the shared store after a write rather than patch local state',
  );
});

test('a medical upload is filed once, in the Documents module', () => {
  const detail = read('frontend/src/app/components/ChildDetail.tsx');

  // The upload used to append to the legacy `child.medicalRecords` JSON *as
  // well as* creating the document, so one file produced two rows in the same
  // table and the two could drift. The document is the source of truth now.
  assert.doesNotMatch(
    detail,
    /medicalRecords:\s*updatedRecords/,
    'the medical upload writes the record to a second source again',
  );
  assert.match(detail, /addDocument\(/, 'the medical upload must file the document');
  // Legacy rows written before that fix are still readable and de-duped.
  assert.match(detail, /child\.medicalRecords/, 'rows written before the fix must still be shown');
});

test('the Nurse dashboard names the five widgets the specification lists', () => {
  const source = read('frontend/src/app/components/Dashboard.tsx');
  const component = source.slice(source.indexOf('function NurseDashboard('));
  const body = component.slice(0, component.indexOf('\n// ── DASHBOARD'));

  for (const widget of [
    'Medical Reminders',
    'Health Updates',
    'Upcoming Assessments',
    'Medical Notes',
    'Health Document Status',
  ]) {
    assert.ok(body.includes(widget), `the Nurse dashboard is missing "${widget}"`);
  }

  // Requirement 5 — "Show only nurse-relevant data". Statistics that belong to
  // other roles must not have been carried over from the shared dashboard.
  for (const unrelated of [
    'Total Residents',
    'Urgency Level',
    'TRI Monitoring',
    'Behavioral Records',
    'Court Records',
    'Activity Calendar',
  ]) {
    assert.ok(
      !body.includes(unrelated),
      `the Nurse dashboard still shows the unrelated "${unrelated}" statistic`,
    );
  }
});

test('the Nurse dashboard links only to pages the Nurse may open', () => {
  const source = read('frontend/src/app/components/Dashboard.tsx');
  const component = source.slice(source.indexOf('function NurseDashboard('));
  const body = component.slice(0, component.indexOf('\n// ── DASHBOARD'));

  // The Nurse reads the assessment schedule but holds no Assessments module, so
  // the "Upcoming Assessments" tile must not navigate to /assessments.
  assert.match(
    body,
    /Upcoming Assessments[\s\S]{0,400}?path:\s*null/,
    'the Upcoming Assessments tile must not link to a module the Nurse cannot open',
  );

  // Every other destination must be a module the role holds.
  const snapshot = rbac.buildAccessSnapshot({ role: 'nurse' });
  for (const [, path] of body.matchAll(/path:\s*'([^']+)'/g)) {
    const route = path.split('?')[0];
    const guarded = guardedRoutes().find((entry) => entry.route === route);
    if (!guarded) continue;
    assert.equal(
      rbac.hasModuleAccess(snapshot, guarded.module),
      true,
      `the Nurse dashboard links to ${route}, guarded by ${guarded.module}, which the Nurse does not hold`,
    );
  }
});

// ─── 7d. no Houseparent page links into a module the role cannot open ────────
//
// A button that navigates into a withheld module is an "unauthorized action" the
// specification says to remove: `ProtectedRoute` refuses the click and the
// control looks broken. Three did exactly that once Child Records was withheld —
// the resident names in the Assessments table, the "Profile" button in the
// Intervention Tracker, and "Review Resident" in the TRI discharge dialog all
// opened `/children/:id`.

/**
 * Pages the Houseparent can open, excluding the shared Dashboard — its
 * role-specific sections are separate components with their own early returns,
 * and section 7c already covers the same property for the Nurse's.
 */
const HOUSEPARENT_PAGES = [
  'frontend/src/app/components/Assessments.tsx',
  'frontend/src/app/components/InterventionTracker.tsx',
  'frontend/src/app/components/Tri.tsx',
  'frontend/src/app/components/Violations.tsx',
  'frontend/src/app/components/AnecdotalReports.tsx',
  'frontend/src/app/components/CaseLoad.tsx',
];

test('no Houseparent page links into a module the role cannot open', () => {
  // Every guarded route whose module the Houseparent does not hold. A link to one
  // of these either has to be behind a guard at the call site (so the roles that
  // DO hold the module keep the affordance) or not exist at all.
  //
  // The lookback window is deliberately short: it forces the guard to sit at the
  // call site, not merely to exist somewhere in the file.
  const snapshot = rbac.buildAccessSnapshot({ role: 'houseparent' });
  const withheld = guardedRoutes()
    .filter((entry) => !rbac.hasModuleAccess(snapshot, entry.module))
    .map((entry) => entry.route);
  const GUARD = /canOpenResidentProfile|canOpenModule\('/;

  const problems = [];
  for (const page of HOUSEPARENT_PAGES) {
    const source = read(page);
    for (const match of source.matchAll(/(?:navigate\(|window\.location\.href\s*=\s*)[`'"](\/[a-z0-9-]+)/gi)) {
      if (!withheld.includes(match[1])) continue;
      const before = source.slice(Math.max(0, match.index - 600), match.index);
      if (GUARD.test(before)) continue;
      problems.push(`${page} -> ${match[1]}`);
    }
  }

  assert.deepEqual(
    problems,
    [],
    `these links land on a page the Houseparent cannot open:\n  ${problems.join('\n  ')}`,
  );
});

test('the Houseparent still gets a resident profile, through Case Load', () => {
  // Withholding the links must not cost the role its "Access Case Load"
  // requirement. Case Load renders `ChildDetail` as a component, not a route, so
  // no guard applies and the Houseparent keeps a read-only profile view there.
  const caseLoad = read('frontend/src/app/components/CaseLoad.tsx');
  assert.match(
    caseLoad,
    /<ChildDetail id=\{viewingChildId\}/,
    'Case Load must still render the resident profile inline',
  );

  // And `ChildDetail` derives its own tabs from the definition, so the
  // Houseparent sees the Personal Info panel without a strip full of tabs it
  // may not open.
  const childDetail = read('frontend/src/app/components/ChildDetail.tsx');
  assert.match(
    childDetail,
    /useSubModuleTabs\('Child Records'\)/,
    'ChildDetail must derive its tabs from the definition, not from a role literal',
  );
});

// ─── 7e. no Educator page links into a module the role cannot open ───────────
//
// Same property as 7d, and it matters more here: the Educator's access list is
// the narrowest of any role so far. Activities, Assessments, Reports, Health,
// Violations and Court Records are all withheld while the role still opens four
// pages of its own, so a single unguarded link would be a broken control.

const EDUCATOR_PAGES = [
  'frontend/src/app/components/ChildRecords.tsx',
  'frontend/src/app/components/ChildDetail.tsx',
  'frontend/src/app/components/Education.tsx',
  'frontend/src/app/components/DocumentUpload.tsx',
];

test('no Educator page links into a module the role cannot open', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'educator' });
  const withheld = guardedRoutes()
    .filter((entry) => !rbac.hasModuleAccess(snapshot, entry.module))
    .map((entry) => entry.route);
  const GUARD = /canOpenResidentProfile|canOpenModule\('/;

  // The sweep is only meaningful if the Educator really is locked out of a lot.
  assert.ok(withheld.includes('/activities'), 'the sweep is not testing what it thinks');
  assert.ok(withheld.includes('/reports'));

  const problems = [];
  for (const page of EDUCATOR_PAGES) {
    const source = read(page);
    for (const match of source.matchAll(/(?:navigate\(|window\.location\.href\s*=\s*)[`'"](\/[a-z0-9-]+)/gi)) {
      if (!withheld.includes(match[1])) continue;
      const before = source.slice(Math.max(0, match.index - 600), match.index);
      if (GUARD.test(before)) continue;
      problems.push(`${page} -> ${match[1]}`);
    }
  }

  assert.deepEqual(
    problems,
    [],
    `these links land on a page the Educator cannot open:\n  ${problems.join('\n  ')}`,
  );
});

/**
 * The `EducatorDashboard` component, sliced out of the shared Dashboard file.
 *
 * The file also holds the shared dashboard and the other roles' components, whose
 * links are legitimately withheld-route targets — they simply never render for
 * this role. Slicing isolates the part that does.
 */
function educatorDashboardSource() {
  const source = read('frontend/src/app/components/Dashboard.tsx');
  const start = source.indexOf('function EducatorDashboard(');
  assert.ok(start > 0, 'the Educator dashboard component is gone');
  const end = source.indexOf('\nexport function Dashboard()', start);
  assert.ok(end > start, 'could not find the end of the Educator dashboard component');
  return { source, component: source.slice(start, end) };
}

test('the Educator dashboard shows the education widgets the specification names', () => {
  const { component } = educatorDashboardSource();

  for (const widget of [
    'Education Updates',
    'Upcoming Education Activities',
    'Assigned Educational Tasks',
  ]) {
    assert.ok(component.includes(widget), `the Educator dashboard is missing "${widget}"`);
  }

  // "Requiring Completion" was removed on request: once a resident is endorsed
  // to the school, tracking their remaining paperwork is not the Educator's job.
  assert.ok(
    !component.includes('Requiring Completion'),
    'the Educator dashboard still shows the removed "Requiring Completion" statistic',
  );

  // "The dashboard must show only education-related information" — nothing from
  // the shared dashboard, which is built around modules the role does not hold.
  for (const unrelated of ['Urgency Level', 'Pending Approvals', 'Violation', 'Court Record']) {
    assert.ok(
      !component.includes(unrelated),
      `the Educator dashboard still shows the unrelated "${unrelated}" statistic`,
    );
  }
});

test('the Educator dashboard stays inside the Education module', () => {
  const { source, component } = educatorDashboardSource();

  // The role leaves the shared dashboard before any of it renders, so no control
  // in it can point at a withheld module.
  assert.match(
    source,
    /if \(userRole === 'educator'\) \{\s*return \(\s*<EducatorDashboard/,
    'the Educator no longer leaves the shared dashboard',
  );

  const targets = [...component.matchAll(/onOpen\(\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(targets.length > 0, 'the Educator dashboard links nowhere');
  for (const target of targets) {
    assert.equal(
      target,
      '/education',
      `the Educator dashboard must stay inside the Education module, not link to ${target}`,
    );
  }
});

// ── 7b. direct URL access ───────────────────────────────────────────────────
//
// `ProtectedRoute` is the frontend half of "prevent permission bypass through
// direct URL access". Typing a path is the whole attack — there is no button to
// remove — so the route table is the enforcement point.

/** `{ route, module }` for every guarded route in the app. */
function guardedRoutes() {
  const source = read('frontend/src/app/App.tsx');
  return [...source.matchAll(
    /<Route path="([^"]+)"\s*\n?\s*element=\{\s*\n?\s*<ProtectedRoute moduleName="([^"]+)"/g,
  )].map(([, route, module]) => ({ route, module }));
}

test('the route table guards every page behind a module', () => {
  const routes = guardedRoutes();
  assert.ok(routes.length >= 12, `expected the guarded route table, found ${routes.length}`);
  assert.ok(routes.some((entry) => entry.route === '/dashboard'), 'the dashboard route is unguarded');
});

test('no route the Psychologist may not open is reachable by direct URL', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'psychologist' });
  // The paths the Psychologist's five modules legitimately reach.
  const reachable = new Set([
    '/dashboard',
    '/children',
    '/children/:id',
    '/assessments',
    '/assessments/:id',
    '/violations',
    '/documents',
  ]);

  for (const { route, module } of guardedRoutes()) {
    const open = rbac.hasModuleAccess(snapshot, module);
    assert.equal(
      open,
      reachable.has(route),
      `${route} is guarded by ${module}, which is ${open ? 'open' : 'closed'} to the Psychologist`,
    );
  }

  // And the pages the specification withholds are genuinely behind a closed gate.
  const withheld = guardedRoutes().filter((entry) => !reachable.has(entry.route)).map((entry) => entry.route);
  for (const path of ['/health', '/reports', '/court-records', '/education', '/staff', '/activities', '/tri']) {
    assert.ok(withheld.includes(path), `${path} is not guarded by a module the Psychologist lacks`);
  }
});

test('no route the Nurse may not open is reachable by direct URL', () => {
  const snapshot = rbac.buildAccessSnapshot({ role: 'nurse' });
  // The paths the Nurse's four modules legitimately reach.
  const reachable = new Set(['/dashboard', '/children', '/children/:id', '/health', '/documents']);

  for (const { route, module } of guardedRoutes()) {
    const open = rbac.hasModuleAccess(snapshot, module);
    assert.equal(
      open,
      reachable.has(route),
      `${route} is guarded by ${module}, which is ${open ? 'open' : 'closed'} to the Nurse`,
    );
  }

  // And the pages the specification withholds are genuinely behind a closed
  // gate — including every module requirement 4 and requirement 5 exclude.
  const withheld = guardedRoutes().filter((entry) => !reachable.has(entry.route)).map((entry) => entry.route);
  for (const path of ['/assessments', '/violations', '/activities', '/reports', '/court-records', '/education', '/staff', '/tri']) {
    assert.ok(withheld.includes(path), `${path} is not guarded by a module the Nurse lacks`);
  }
});

test('every route guard names a module the definition declares', () => {
  // A guard naming a module that does not exist resolves to "nobody but the
  // full-access roles" — a page silently walled off for everyone it was written
  // for, with no test failing. `/social-worker` is the one legacy case; it is
  // listed here so a *new* phantom module fails instead of joining it.
  const LEGACY_UNRESOLVED_ROUTES = new Set(['/social-worker']);

  for (const { route, module } of guardedRoutes()) {
    if (LEGACY_UNRESOLVED_ROUTES.has(route)) continue;
    const canonical = rbac.normalizeModuleKey(module);
    assert.ok(
      rbac.MODULE_KEYS.includes(canonical),
      `${route} is guarded by "${module}", which is not a module in the definition`,
    );
  }

  // The exception list must not silently grow into a graveyard: each entry must
  // still exist as a route.
  const paths = new Set(guardedRoutes().map((entry) => entry.route));
  for (const legacy of LEGACY_UNRESOLVED_ROUTES) {
    assert.ok(paths.has(legacy), `${legacy} is listed as a legacy route but no longer exists`);
  }
});

// ───────── 8. every gated API mount agrees with the role matrix ──────────────
//
// The per-role tests above check one role against one route. This checks the
// *property*: for every role and every module-gated mount, the HTTP outcome and
// the role matrix must agree. It is derived from the mount table itself, so a
// gate added without a matching expectation still gets checked — and a mount
// that loses its gate fails here rather than in production.
//
// This is the guard that would have caught the original gap: a Nurse could read
// every court record, activity, report and staff row over the API while the
// sidebar correctly showed none of them.

/** `{ mount, module }` for every mount in `routes/index.js` that names a module. */
function gatedMounts() {
  const source = read('backend/src/routes/index.js');
  return [...source.matchAll(
    /router\.use\('([^']+)',\s*authenticate,\s*requireModule\('([^']+)'\)/g,
  )].map(([, mount, module]) => ({ mount: `/api${mount}`, module }));
}

test('the mount table gates every module-owned API surface', () => {
  const mounts = gatedMounts();

  // The modules whose data lives behind a single mount. If a module is missing
  // here, its mount has lost its gate.
  const gatedModules = new Set(mounts.map((entry) => entry.module));
  for (const module of ['Activities', 'Court Records', 'Reports', 'Account Management']) {
    assert.ok(gatedModules.has(module), `no mount is gated by ${module}`);
  }

  // And the module each mount names must be a real module, or the gate would
  // resolve to "nobody but the full-access roles" — a mount silently walled off
  // for everyone it was written for.
  for (const { mount, module } of mounts) {
    assert.ok(
      rbac.MODULE_KEYS.includes(rbac.normalizeModuleKey(module)),
      `${mount} is gated by "${module}", which is not a module in the definition`,
    );
  }
});

test('every gated API mount agrees with the role matrix, for every role', async () => {
  const account = nurseAccount();
  const app = loadApp(createPoolStub(account));

  await withServer(app, async (base) => {
    for (const { mount, module } of gatedMounts()) {
      for (const role of rbac.ROLE_KEYS) {
        // The account row is what `authenticate` resolves the snapshot from, so
        // the role under test has to be on the row as well as on the token.
        account.role = role;
        const response = await send(base, mount, role);
        const holds = rbac.can({ role }, module, 'view');

        assert.equal(
          response.status !== 403,
          holds,
          `${role} to ${mount}: holds ${module} = ${holds}, but the API answered ${response.status}`,
        );
      }
    }
  });
});

test('the assessment schedule is the only ungated route in the assessments router', () => {
  // The Nurse's dashboard reads the schedule but the role holds no Assessments
  // module, so `GET /upcoming` is the single deliberate exception. Everything
  // else in the router must name the module.
  const source = read('backend/src/routes/assessmentRoutes.js');
  const routes = [...source.matchAll(/router\.(get|post|put|delete)\('([^']+)',([^;]*)\);/g)]
    .map(([, verb, routePath, middleware]) => ({
      label: `${verb.toUpperCase()} ${routePath}`,
      gated: /inAssessments/.test(middleware),
    }));

  assert.ok(routes.length >= 8, `expected the assessment route table, found ${routes.length}`);

  assert.deepEqual(
    routes.filter((entry) => !entry.gated).map((entry) => entry.label),
    ['GET /upcoming'],
    'a second assessment route lost its module gate',
  );
});

test('the evaluation form is guarded by the module that owns its data', () => {
  // The page writes `activityEvaluations`, which the API mount and the store
  // both file under Activities. Guarded by Assessments instead, a Psychologist
  // could open the form — it holds Assessments — and then have every save
  // refused, because the role holds no Activities module. The route guard and
  // the API must name the same module or the page is a dead end.
  const evaluationForm = guardedRoutes().find((entry) => entry.route === '/evaluation-form');
  assert.ok(evaluationForm, 'the evaluation form route is gone');
  assert.equal(
    evaluationForm.module,
    'Activities',
    'the evaluation form must be guarded by the module its data belongs to',
  );
});
