/**
 * Migration: Repair seeded module grants that drifted from the RBAC definition
 *
 * @description
 * `seedDatabase.js` used to write a hand-copied `accessibleModules` array for the
 * seeded accounts. Because `buildAccessSnapshot()` prefers a non-empty stored
 * grant over the role matrix, that stale copy overrode the definition — in both
 * directions:
 *
 *   U002 socialworker  lost Activities and Assessments, kept the pre-rename `TRI`
 *   U004 nurse         gained Reports (its specification forbids Reports) and
 *                      Activities, and lost Child Records
 *   U005 educator      gained Activities, and lost Child Records
 *
 * This script clears the stored grant on exactly those accounts, so each one
 * inherits its role's declared matrix again — the same state a freshly seeded
 * database now produces.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 * It is a DRY RUN unless `--apply` is passed.
 *
 * It only rewrites an account whose stored grant is byte-identical to a known
 * stale seed value (see STALE_SEED_GRANTS). An account whose grant differs is
 * either already correct or a deliberate per-account customization made in
 * Account Management, and is reported but never touched. That keeps this
 * migration from silently narrowing someone's access.
 *
 * Usage:
 *   node migrations/repair-seeded-module-grants.mjs            # dry run
 *   node migrations/repair-seeded-module-grants.mjs --apply    # write
 */

import { pool } from '../src/config/database.js';
import { buildAccessSnapshot } from '../src/config/rbac.js';
import definition from '../src/config/rbac.definition.json' with { type: 'json' };

/**
 * The exact `accessibleModules` values the old seed wrote. Only an account
 * still carrying one of these is repaired.
 */
const STALE_SEED_GRANTS = {
  socialworker: ['Dashboard', 'Child Records', 'Violations', 'Court Records', 'Documents', 'Reports', 'TRI'],
  nurse: ['Dashboard', 'Activities', 'Documents', 'Health', 'Reports'],
  educator: ['Dashboard', 'Documents', 'Activities', 'Education'],
  houseparent: ['Dashboard', 'Violations', 'Activities', 'Assessments', 'Houseparent'],
};

const sameSet = (a, b) => {
  const left = [...new Set((a || []).map(String))].sort();
  const right = [...new Set((b || []).map(String))].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
};

const declaredModules = (role) => {
  const entry = definition.roles[role];
  if (!entry) return null;
  if (entry.modules === '*') return definition.modules.map((module) => module.key);
  return entry.modules;
};

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return value ? value.split(',').map((part) => part.trim()).filter(Boolean) : [];
    }
  }
  return [];
};

async function up() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? 'MODE: APPLY (writing)' : 'MODE: DRY RUN (no writes — pass --apply to write)');
  console.log('');

  const [rows] = await pool.query(
    'SELECT id, username, role, status, accessibleModules, childRecordTabs, subModules FROM users ORDER BY role, id',
  );

  const repairs = [];
  const untouched = [];

  for (const row of rows) {
    const stored = asArray(row.accessibleModules);
    const role = String(row.role || '').toLowerCase();
    const stale = STALE_SEED_GRANTS[role];

    if (stored.length === 0) continue; // already inheriting the matrix

    if (!stale || !sameSet(stored, stale)) {
      // Not the stale seed value: either already correct, or a deliberate
      // per-account customization. Report, never rewrite.
      const expected = declaredModules(role) || [];
      const snapshot = buildAccessSnapshot({
        role: row.role,
        accessibleModules: stored,
        childRecordTabs: row.childRecordTabs,
        subModules: row.subModules,
      });
      const missing = expected.filter((module) => !snapshot.modules.includes(module));
      const extra = snapshot.modules.filter((module) => !expected.includes(module));
      if (missing.length || extra.length) {
        untouched.push({ ...row, stored, missing, extra });
      }
      continue;
    }

    const before = buildAccessSnapshot({
      role: row.role,
      accessibleModules: stored,
      childRecordTabs: [],
      subModules: {},
    });
    const after = buildAccessSnapshot({
      role: row.role,
      accessibleModules: [],
      childRecordTabs: [],
      subModules: {},
    });
    repairs.push({
      id: row.id,
      username: row.username,
      role,
      stored,
      gains: after.modules.filter((module) => !before.modules.includes(module)),
      loses: before.modules.filter((module) => !after.modules.includes(module)),
      expected: declaredModules(role) || [],
    });
  }

  // An account still holding the old seed value that happens to match the
  // current definition needs no write — clearing it would be a no-op. Keeping
  // it also preserves the row exactly as an operator left it.
  const effective = repairs.filter((repair) => repair.gains.length || repair.loses.length);
  const noop = repairs.filter((repair) => !repair.gains.length && !repair.loses.length);

  console.log('=== ACCOUNTS TO REPAIR (stale seed grant, effective change) ===');
  if (!effective.length) console.log('  none');
  for (const repair of effective) {
    console.log(`  ${repair.id}  ${repair.role.padEnd(13)} ${repair.username}`);
    console.log(`      stored : ${JSON.stringify(repair.stored)}`);
    console.log(`      gains  : ${repair.gains.join(', ') || '—'}`);
    console.log(`      loses  : ${repair.loses.join(', ') || '—'}`);
  }

  console.log('\n=== STALE SEED VALUE THAT ALREADY MATCHES THE DEFINITION (no write needed) ===');
  if (!noop.length) console.log('  none');
  for (const item of noop) {
    console.log(`  ${item.id}  ${item.role.padEnd(13)} ${item.username}`);
  }

  console.log('\n=== DRIFTED BUT DELIBERATELY UNTOUCHED (not the stale seed value) ===');
  if (!untouched.length) console.log('  none');
  for (const item of untouched) {
    console.log(`  ${item.id}  ${item.role.padEnd(13)} ${item.username}`);
    console.log(`      missing: ${item.missing.join(', ') || '—'}   extra: ${item.extra.join(', ') || '—'}`);
  }

  if (!apply) {
    console.log(`\nDry run complete. Re-run with --apply to write the ${effective.length} repair(s).`);
    return;
  }

  let written = 0;
  for (const repair of effective) {
    await pool.query('UPDATE users SET accessibleModules = ? WHERE id = ?', [JSON.stringify([]), repair.id]);
    written += 1;
    console.log(`✓ ${repair.id} (${repair.username}) now inherits the ${repair.role} matrix`);
  }
  console.log(`\nApplied ${written} repair(s).`);
}

up()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Migration failed:', error.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
