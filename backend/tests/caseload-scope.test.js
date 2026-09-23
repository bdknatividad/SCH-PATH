/**
 * Caseload (resident) scope — who may see which resident's records.
 *
 * Only Houseparents are caseload-scoped; the reasoning is in
 * `utils/residentScope.js` and is sound (no other role has a per-child column
 * anywhere in the schema). That makes Houseparent the one role where this can
 * be got wrong in a way that either exposes a resident's records or locks a
 * member of staff out of their own caseload.
 *
 * Measured against the live API while writing these:
 *
 *   HP 2 / HP 10  GET /children                 -> 200, 0 items
 *                 GET /documents/resident/CH001 -> 403 "not assigned to this resident"
 *                 GET /documents/resident/CH002 -> 403
 *                 GET /violations               -> 200, 3 items  (all of them)
 *                 GET /phaseProgress            -> 200, 4 items  (all of them)
 *
 * Two separate problems are visible in that block and they pull in opposite
 * directions — houseparents see nothing where they should see their caseload,
 * and everything where they should see only their caseload.
 *
 * The three tests marked `skip` below assert the behaviour that should hold.
 * They are skipped, not deleted, because each needs a decision that is a matter
 * of policy rather than of code:
 *
 *   1. Should the eleven seeded Houseparent accounts each see every resident?
 *      The seed creates the full houseparent x child cross product, so widening
 *      the reader to accept `'household'` grants all of them everything.
 *   2. Should a Houseparent's `/violations` and `/phaseProgress` be limited to
 *      their caseload? Narrowing changes what staff can see day to day.
 *
 * Un-skip them once those are answered; they are written to pass against the
 * corrected code.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const RESIDENT_SCOPE = read('src/utils/residentScope.js');
const ASSIGNMENT = read('src/controllers/assignmentController.js');
const SEED = read('src/scripts/seedDatabase.js');

const NEEDS_POLICY =
  'KNOWN ISSUE: documented in .workbuddy-ai/memory/2026-09-23.md — needs a policy decision before the code changes';

test('the scope reader accepts the assignment type its writer is documented to use', () => {
  // `assignedResidentIds` is the primary source of truth for a Houseparent's
  // caseload, and it filters on `assignmentType`. Whatever vocabulary it accepts
  // has to be the vocabulary the rest of the system writes, or the explicit
  // assignment table silently does nothing.
  assert.match(RESIDENT_SCOPE, /assignmentType/, 'assignedResidentIds must filter on assignmentType');
  assert.match(RESIDENT_SCOPE, /'houseparent'/, 'the reader must accept the houseparent type');
});

test('the seed writes the same assignment type the readers require', { skip: NEEDS_POLICY }, () => {
  // The seed's own log line says "resident assignments (houseparent -> child)",
  // but the INSERT hard-codes `'household'`. Every reader filters on
  // `'houseparent'`, so the rows it creates are inert: the assignment exists in
  // the table and grants nothing.
  const insert = SEED.match(/INSERT INTO residentAssignments[\s\S]{0,400}?\)`/);
  assert.ok(insert, 'expected the residentAssignments seed INSERT');

  const written = /'(houseparent|household)'/.exec(insert[0]);
  assert.ok(written, 'expected a literal assignmentType in the seed INSERT');

  assert.equal(
    written[1],
    'houseparent',
    `the seed writes '${written[1]}' but every reader requires 'houseparent', ` +
      'so the seeded assignments grant nothing',
  );
});

test('caseload scoping is applied to every resident-scoped module, not just some', { skip: NEEDS_POLICY }, () => {
  // `documents`, `children`, `activities`, `alerts` and access requests all
  // apply it. `/violations` and `/phaseProgress` do not, which is how a
  // Houseparent with an empty caseload still reads every resident's incidents.
  for (const controller of ['violationController', 'phaseController']) {
    const source = read(`src/controllers/${controller}.js`);
    assert.match(
      source,
      /residentScope/,
      `${controller} handles resident-scoped rows but never consults the caseload scope`,
    );
  }
});

test('the assignment type vocabulary is one value, not two', { skip: NEEDS_POLICY }, () => {
  // `assignmentController` reads and writes `'houseparent'`. If a second
  // spelling is legitimate, every reader has to agree on it in one place.
  const spellings = new Set();
  for (const m of ASSIGNMENT.matchAll(/assignmentType[^\n]*?'(\w+)'/g)) spellings.add(m[1]);
  for (const m of RESIDENT_SCOPE.matchAll(/assignmentType[^\n]*?'(\w+)'/g)) spellings.add(m[1]);

  assert.ok(
    spellings.size <= 1,
    `assignmentType is compared against ${[...spellings].join(' and ')}; ` +
      'a value that only some readers accept is a silent no-op',
  );
});
