/**
 * Caseload (resident) scope — who may see which resident's records.
 *
 * Only Houseparents are caseload-scoped; the reasoning is in
 * `utils/residentScope.js` and is sound (no other role has a per-child column
 * anywhere in the schema). That makes Houseparent the one role where this can
 * be got wrong in a way that either exposes a resident's records or locks a
 * member of staff out of their own caseload.
 *
 * Measured against the live API before either fix:
 *
 *   HP 2 / HP 10  GET /children                 -> 200, 0 items
 *                 GET /documents/resident/CH001 -> 403 "not assigned to this resident"
 *                 GET /documents/resident/CH002 -> 403
 *                 GET /violations               -> 200, 3 items  (all of them)
 *                 GET /phaseProgress            -> 200, 4 items  (all of them)
 *
 * Two separate problems were visible in that block, pulling in opposite
 * directions — houseparents saw nothing where they should see their caseload,
 * and everything where they should see only their caseload.
 *
 * Both were put to the product owner and are now settled. The answers are
 * recorded here because they are policy, not something the code can derive:
 *
 *   1. `assignmentType` vocabulary — TYPO, now fixed. `seedDatabase` wrote
 *      `'household'`; every reader grants scope on `'houseparent'` only.
 *      `'household'` had no counterpart writer anywhere (the assignment UI posts
 *      `'houseparent'`, and `assignmentController` passes through whatever it is
 *      handed), so the seeded rows were inert by accident: a seeded Houseparent
 *      signed in to an empty caseload. The seed now writes `'houseparent'`, and
 *      the test below pins that.
 *
 *      The competing reading — that `'household'` was a deliberate
 *      whole-facility placeholder that should grant nothing — was rejected. Note
 *      the effect of the fix: the seed builds the full houseparent x child cross
 *      product, so every seeded Houseparent is now assigned every Active
 *      resident. Seeded data therefore cannot demonstrate per-Houseparent
 *      isolation.
 *
 *   2. `/violations` and `/phaseProgress` scope — LEFT FACILITY-WIDE, on
 *      purpose. A Houseparent with an empty caseload does read every resident's
 *      incidents and phase entries, and that is the intended behaviour rather
 *      than an oversight. There is deliberately no test here asserting those two
 *      controllers consult the caseload scope: the answer was "no", and a
 *      skipped test whose premise has been rejected is just a stale
 *      known-issue.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const RESIDENT_SCOPE = read('src/utils/residentScope.js');
const SEED = read('src/scripts/seedDatabase.js');

test('the scope reader accepts the assignment type its writer is documented to use', () => {
  // `assignedResidentIds` is the primary source of truth for a Houseparent's
  // caseload, and it filters on `assignmentType`. Whatever vocabulary it accepts
  // has to be the vocabulary the rest of the system writes, or the explicit
  // assignment table silently does nothing.
  assert.match(RESIDENT_SCOPE, /assignmentType/, 'assignedResidentIds must filter on assignmentType');
  assert.match(RESIDENT_SCOPE, /'houseparent'/, 'the reader must accept the houseparent type');
});

test('the seed writes the same assignment type the readers require', () => {
  // Pins reading (a) in the header — the typo interpretation, which the product
  // owner confirmed and the seed now satisfies. If this ever fails, the seed has
  // gone back to writing a value no reader accepts and every seeded Houseparent
  // will see an empty caseload again.
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

test('every reader that grants caseload scope agrees on one assignment type', () => {
  // True under both readings in the header, which is why this one is not skipped.
  // The placeholder value may or may not be deliberate, but whichever value
  // grants scope has to be the same one everywhere — otherwise a Houseparent's
  // caseload would depend on which module asked the question. In particular no
  // reader may grant scope on `'household'`, because the seed gives every
  // Houseparent one of those: accepting it would hand all of them every resident.
  const granters = {
    'utils/residentScope.js': read('src/utils/residentScope.js'),
    'controllers/assignmentController.js': read('src/controllers/assignmentController.js'),
    'services/notificationService.js': read('src/services/notificationService.js'),
  };

  for (const [name, source] of Object.entries(granters)) {
    assert.doesNotMatch(
      source,
      /assignmentType[^\n]*'household'/i,
      `${name} grants caseload scope on 'household', the whole-facility ` +
        'placeholder every Houseparent holds — that exposes every resident',
    );
    assert.match(
      source,
      /assignmentType[^\n]*'houseparent'/i,
      `${name} must grant caseload scope on the value the writers actually produce`,
    );
  }
});
