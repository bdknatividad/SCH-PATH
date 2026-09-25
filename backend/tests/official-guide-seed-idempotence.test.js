/**
 * The official-guide sync must be idempotent.
 *
 * Background, because the failure is invisible without it: `parseGuideRequirement()`
 * stores an EMPTY `officialText` for a requirement that resolves to
 * interventionType `Psychosocial Activity`, but the sync's "is this set already
 * correct?" check compared the stored rows against the RAW source text. Those
 * two can never be equal, so every guide x offense-level set containing a
 * Psychosocial requirement was deleted and re-created on every boot.
 *
 * Measured on production 2026-09-25: 52 of the 99 sets, i.e. 154 fresh
 * `guide_interventions` ids minted per restart, with the id counter reaching
 * GI4857 for 237 live rows. The symptom only became visible once
 * `intervention_tracker` rows referenced those rows and
 * `fk_tracker_guide_intervention` (ON DELETE RESTRICT) refused the delete --
 * which aborted the whole sync transaction:
 *
 *   Seeding step failed (official violation guide): Cannot delete or update a
 *   parent row: a foreign key constraint fails (`railway`.`intervention_tracker`,
 *   CONSTRAINT `fk_tracker_guide_intervention` ...)
 *
 * The fix compares the stored form of the requirement instead of the raw text.
 * The tests below pin both halves of that coupling: the check must compare the
 * STORED form, and a genuinely different stored set must still be repaired.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pool } = require('../src/config/database');
const {
  seedOfficialViolationGuide,
  parseGuideRequirement,
  OFFICIAL_VIOLATION_GUIDE,
} = require('../src/scripts/seedDatabase');

const SEED_PATH = path.join(__dirname, '..', 'src', 'scripts', 'seedDatabase.js');
const LEVELS = ['1st', '2nd', '3rd'];

/** The text the sync actually writes into metadata.officialText. */
const storedText = (requirement) =>
  String(parseGuideRequirement(requirement).metadata.officialText || '').trim();

/**
 * Run the sync against a fake `guide_interventions` table.
 *
 * `buildRows(key, requirements)` returns the rows the table should appear to
 * hold for one `guideId/offenseLevel` set; `null` means "no rows".
 */
async function runSync(buildRows) {
  const issued = [];
  const events = [];

  const connection = {
    async query(sql, params) {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      issued.push({ sql: flat, params });

      if (/FROM guide_interventions/i.test(flat) && /WHERE guideId = \? AND offenseLevel = \?/i.test(flat)) {
        const key = params[0] + '/' + params[1];
        const guide = OFFICIAL_VIOLATION_GUIDE.find((g) => g.id === params[0]);
        const requirements = (guide?.interventions?.[params[1]]) || [];
        const rows = buildRows(key, requirements);
        return [rows || [], []];
      }
      // nextSeedGuideInterventionId() reads every id in the table.
      if (/^SELECT id FROM guide_interventions$/i.test(flat)) return [[], []];
      // The guide row must look system-owned, or the repair path is skipped.
      if (/FROM violation_guide WHERE id = \?/i.test(flat)) {
        return [[{ id: params[0], createdBy: 'system', updatedBy: 'system' }], []];
      }
      return [[], []];
    },
    async beginTransaction() { events.push('begin'); },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    release() {},
  };

  const realGetConnection = pool.getConnection;
  const realQuery = pool.query;
  pool.getConnection = async () => connection;
  pool.query = async (sql) => {
    issued.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: undefined });
    return [[], []];
  };

  try {
    await seedOfficialViolationGuide();
  } finally {
    pool.getConnection = realGetConnection;
    pool.query = realQuery;
  }

  return {
    issued,
    events,
    deletes: issued.filter((i) => /^DELETE FROM guide_interventions/i.test(i.sql)),
    inserts: issued.filter((i) => /^INSERT INTO guide_interventions/i.test(i.sql)),
  };
}

/** Rows shaped the way the sync itself would have written them. */
function rowsFromStored(requirements, idPrefix) {
  return requirements.map((requirement, index) => ({
    id: idPrefix + String(index + 1).padStart(3, '0'),
    metadata: JSON.stringify(parseGuideRequirement(requirement).metadata),
  }));
}

test('the stored form of a Psychosocial requirement is an empty officialText', () => {
  // This is the asymmetry that caused the churn. If it ever changes, the
  // comparison in seedOfficialViolationGuide() has to change with it -- which
  // is why it is pinned here rather than left implicit.
  const parsed = parseGuideRequirement('psychosocial activity');
  assert.equal(parsed.interventionType, 'Psychosocial Activity');
  assert.equal(parsed.metadata.officialText, '');

  const ordinary = parseGuideRequirement('2 days no watching tv');
  assert.equal(ordinary.interventionType, 'Privilege Restriction');
  assert.equal(ordinary.metadata.officialText, '2 days no watching tv');
});

test('a table already holding the stored form is left completely untouched', async () => {
  const { deletes, inserts, events } = await runSync((key, requirements) =>
    rowsFromStored(requirements, 'GI' + key.replace(/\W/g, '') + '-'));

  assert.equal(deletes.length, 0, 'an up-to-date guide must not be deleted and re-created');
  assert.equal(inserts.length, 0, 'an up-to-date guide must not be re-inserted');
  assert.ok(events.includes('commit'), 'the sync must commit');
  assert.ok(!events.includes('rollback'), 'the sync must not roll back');
});

test('the churn the fix removed is real: raw text never matches the stored text', () => {
  // Reproduces the pre-fix comparison exactly, so the size of the defect is
  // pinned rather than asserted by hand. On production this was 52 sets / 154
  // rows on every boot.
  let setsThatWouldChurn = 0;
  let rowsThatWouldChurn = 0;

  for (const guide of OFFICIAL_VIOLATION_GUIDE) {
    for (const level of LEVELS) {
      const requirements = guide.interventions?.[level] || [];
      if (!requirements.length) continue;

      const rawTexts = requirements.map((r) => String(r).trim());
      const storedTexts = requirements.map(storedText);
      const matchesUnderTheFix =
        rawTexts.length === storedTexts.length &&
        rawTexts.every((t, i) => t === storedTexts[i]);

      if (!matchesUnderTheFix) {
        setsThatWouldChurn += 1;
        rowsThatWouldChurn += requirements.length;
      }
    }
  }

  assert.ok(
    setsThatWouldChurn > 0,
    'the old comparison must be shown to be broken, or this test proves nothing'
  );
  assert.equal(
    setsThatWouldChurn,
    52,
    'the production signature was 52 churning sets; a change here means the guide data moved'
  );
  assert.equal(rowsThatWouldChurn, 154, 'the production signature was 154 rows re-created per boot');
});

test('a genuinely stale stored set is still repaired', async () => {
  // The negative control. If the comparison were relaxed into "always match",
  // the sync would silently stop applying guide updates -- the opposite bug.
  const { deletes, inserts } = await runSync((key, requirements) =>
    rowsFromStored(requirements, 'GI' + key.replace(/\W/g, '') + '-').map((row, index) => {
      // Corrupt exactly one set, and only its first row.
      if (key !== 'VG001/1st' || index !== 0) return row;
      const metadata = JSON.parse(row.metadata);
      metadata.officialText = 'a requirement that is no longer in the guide';
      return { ...row, metadata: JSON.stringify(metadata) };
    }));

  assert.equal(deletes.length, 1, 'exactly the stale set must be replaced');
  assert.match(String(deletes[0].params[0]), /^VG001$/);
  assert.match(String(deletes[0].params[1]), /^1st$/);
  assert.ok(inserts.length > 0, 'the replaced set must be re-inserted');
});

test('the sync compares the stored form, not the raw requirement text', () => {
  const source = fs.readFileSync(SEED_PATH, 'utf8');

  assert.ok(
    !/const officialTexts = requirements\.map\(\(item\) => String\(item\)\.trim\(\)\)/.test(source),
    'the sync must not compare stored rows against the raw requirement text'
  );
  assert.match(
    source,
    /const storedTexts = parsedRequirements\.map/,
    'the comparison must be derived from the parsed (stored) requirements'
  );
  assert.match(
    source,
    /ORDER BY createdAt ASC, id ASC/,
    'the row order feeding an order-sensitive comparison must be deterministic'
  );
});
