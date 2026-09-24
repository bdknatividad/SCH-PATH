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
 * The tests marked `skip` below each need a decision that is a matter of policy
 * rather than of code:
 *
 *   1. Should a Houseparent's `/violations` and `/phaseProgress` be limited to
 *      their caseload? They are not scoped at all today, so a Houseparent with
 *      an empty caseload reads every resident's incidents. Narrowing changes
 *      what staff can see day to day.
 *
 *   2. The `assignmentType` vocabulary. **Read this before "fixing" the seed.**
 *      `seedDatabase` inserts `'household'`; every reader requires
 *      `'houseparent'`. There are two readings and they lead to opposite code:
 *
 *      (a) Typo. The seed's own log line says "Created N resident assignments
 *          (houseparent -> child)", so it meant to write `'houseparent'` and
 *          the rows it creates are inert by accident.
 *          Fix: make the seed write `'houseparent'`.
 *
 *      (b) Deliberate. `assignmentController` documents `'household'` as "the
 *          shared whole-facility placeholder ... every Houseparent has one, so
 *          notifying on them would be pure noise". The seed builds the full
 *          houseparent x child cross product, which is what such a placeholder
 *          looks like, and no reader accepts the value.
 *          Fix: none — a placeholder is meant to grant nothing.
 *
 *      The readings are not equivalent in effect. Under (a) every seeded
 *      Houseparent gains every resident, because the cross product becomes
 *      live. That is why this is skipped rather than fixed: `'household'` is
 *      produced in exactly one place (the seed) and read in none, so the code
 *      cannot settle it — only the intended access model can.
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
  // This asserts reading (a) in the header — the typo interpretation. If reading
  // (b) turns out to be correct, delete this test rather than making it pass:
  // the point of (b) is that the seed is supposed to write a value no reader
  // accepts.
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
