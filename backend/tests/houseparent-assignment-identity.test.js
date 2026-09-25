/**
 * The Houseparent on duty is linked by id, not by printed name.
 *
 * The Admission Slip has always recorded this person as a name the Social
 * Worker picks from a dropdown (`admissions.houseparentOnDuty`), and the
 * caseload scope resolved a resident's Houseparent by matching that name back
 * against `users.username` / `displayName` / `fullName` / `staff.name`.
 *
 * A name is not a key. Three silent failures followed from that, none of which
 * raised an error — the wrong list was simply returned:
 *
 *   - Renaming a member of staff moved their caseload to whoever now held the
 *     old name, and detached it from them.
 *   - Two accounts sharing a display name each saw the other's residents. The
 *     matching was case- and whitespace-insensitive, so this is easier to hit
 *     than it sounds.
 *   - A stray double space in the dropdown label matched nothing at all, so the
 *     resident fell out of every caseload.
 *
 * The admission now carries `houseparentUserId` alongside the name. The name is
 * still stored and printed — it is what the official slip shows — but it is a
 * label again rather than the link. The name match survives only for rows
 * admitted before the column existed and never backfilled, which is why every
 * reader has to gate it on `houseparentUserId IS NULL`: without the gate, a
 * rename could still move a resident that already has a perfectly good id.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
/**
 * Line endings are normalised on read. The working tree is LF but a tool that
 * rewrites a file on Windows can leave CRLF behind, and every slice below is
 * located by a multi-line marker — which would silently stop matching, returning
 * `-1` and making a slice of one character that fails or, worse, passes for the
 * wrong reason.
 */
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const RESIDENT_SCOPE = read('backend/src/utils/residentScope.js');
const ASSIGNMENT = read('backend/src/controllers/assignmentController.js');
const ADMISSION = read('backend/src/controllers/admissionController.js');
const SERVER = read('backend/src/server.js');
const SCHEMA = read('backend/src/database/schema.sql');
const CONSTANTS = read('backend/src/utils/constants.js');
const CHILD_RECORDS = read('frontend/src/app/components/ChildRecords.tsx');

/**
 * How many name comparisons sit *after* the last `houseparentUserId IS NULL`
 * gate, versus how many exist in the block at all.
 *
 * A fixed look-behind window does not work here: the fourth comparison (the
 * `staff.name` one) sits further past the gate than any window worth choosing,
 * so the gate would be missed and the test would fail on correct code.
 */
function gateCoverage(block) {
  const gate = block.lastIndexOf('houseparentUserId IS NULL');
  const count = (text) => (text.match(/LOWER\(TRIM\(a\.houseparentOnDuty\)\)/g) || []).length;
  return { gate, total: count(block), gated: gate < 0 ? 0 : count(block.slice(gate)) };
}

/** Slice `source` between two markers, asserting both were found. */
function between(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${label}: the start marker was not found (${JSON.stringify(startMarker)})`);
  const end = endMarker === null ? source.length : source.indexOf(endMarker, start);
  assert.ok(end > start, `${label}: the end marker was not found (${JSON.stringify(endMarker)})`);
  return source.slice(start, end);
}

/**
 * The three places that decide which residents a Houseparent may reach. Each is
 * checked independently because they are independent code paths — fixing one and
 * missing another leaves the rename bug live through a different door.
 */
const READERS = [
  [
    'the caseload scope',
    between(RESIDENT_SCOPE, 'async function assignedResidentIds', 'async function loadResidentScope', 'caseload scope'),
  ],
  [
    'canAccessResident',
    between(ASSIGNMENT, 'async function canAccessResident', 'async function ensureResident', 'canAccessResident'),
  ],
  [
    'the Case Load roster',
    between(ASSIGNMENT, 'async function getCaseload', 'async function getMyResidents', 'getCaseload'),
  ],
];

test('the reader blocks were located, not silently sliced to nothing', () => {
  // A slice that missed its marker would be one character long and every
  // assertion below would fail for the wrong reason — or, with a loose pattern,
  // pass.
  for (const [label, block] of READERS) {
    assert.ok(block.length > 200, `${label} resolved to ${block.length} characters — the marker moved`);
  }
});

test('the admission stores the Houseparent as a stable id beside the name', () => {
  assert.match(
    SCHEMA,
    /houseparentOnDuty VARCHAR\(150\) NOT NULL,[\s\S]{0,400}?houseparentUserId VARCHAR\(50\) NULL,/,
    'the reference schema does not declare admissions.houseparentUserId',
  );
  assert.match(
    SERVER,
    /ensureColumn\('admissions', 'houseparentUserId'/,
    'a deployed database would never gain the column, so the id could never be stored',
  );
  assert.match(
    CONSTANTS,
    /'houseparentUserId'/,
    'the admissions resource does not expose houseparentUserId, so mapRow strips it from every response',
  );
});

test('the id is written on both admission paths', () => {
  // Create: the INSERT carries the column and binds the resolved id next to the
  // name it belongs to.
  assert.match(
    ADMISSION,
    /INSERT INTO admissions \([\s\S]*?houseparentOnDuty,\s*houseparentUserId,\s*houseparentSignature,/,
    'the admission INSERT does not store the Houseparent id',
  );
  assert.match(
    ADMISSION,
    /admission\.houseparentOnDuty,\s*houseparentUserId,\s*admission\.houseparentSignature,/,
    'the admission INSERT does not bind the resolved Houseparent id',
  );
  // Update: reassigning the resident has to move the id too, or the slip and the
  // caseload would disagree about who holds the resident.
  assert.match(
    ADMISSION,
    /const fields = \[[^\]]*'houseparentUserId'/,
    'editing an admission cannot change the Houseparent id, so a reassignment would not take effect',
  );
});

test('an id that names nobody is refused rather than stored', () => {
  const { resolveHouseparentUserId } = require('../src/controllers/admissionController');

  // A dangling id would read as an assignment while granting nothing, so it has
  // to fail loudly at the call site.
  return resolveHouseparentUserId('GHOST', { query: async () => [[]] }).then(
    () => assert.fail('an unknown Houseparent id was accepted'),
    (error) => assert.equal(error.statusCode, 400, 'an unknown id must be a 400, not a 500'),
  );
});

test('a selected id is stored verbatim and an empty selection clears the link', async () => {
  const { resolveHouseparentUserId } = require('../src/controllers/admissionController');
  const executor = { query: async () => [[{ id: 'U-42' }]] };

  assert.equal(await resolveHouseparentUserId('U-42', executor), 'U-42');
  assert.equal(await resolveHouseparentUserId('  U-42  ', executor), 'U-42', 'a padded id must still resolve');
  assert.equal(await resolveHouseparentUserId('', executor), null, 'clearing the field must clear the link');
  assert.equal(await resolveHouseparentUserId(null, executor), null);
  assert.equal(await resolveHouseparentUserId(undefined, executor), null);
});

test('the Houseparent on Duty never becomes the Case Load Manager', () => {
  // HP on Duty (admissions.houseparentOnDuty / houseparentUserId) and the Case
  // Load Manager (residentAssignments) are two separate fields. None of the
  // readers that decide a Houseparent's residents may fall back to the
  // admission, or selecting an HP on Duty would silently hand them the case.
  for (const [label, block] of READERS) {
    assert.doesNotMatch(block, /FROM admissions|JOIN admissions/, `${label} still reads the admission as a caseload link`);
    assert.doesNotMatch(block, /houseparentOnDuty\)|a\.houseparentUserId/, `${label} still matches the HP on Duty`);
    assert.match(block, /residentAssignments|assignedResidentIds|effectiveRows|rows\.length/, `${label} no longer reads the assignment table`);
  }
});

test('saving an Admission Slip does not create a Case Load assignment', () => {
  const posts = CHILD_RECORDS.match(/request\(\s*`\/resident-assignments\/resident\//g) || [];
  assert.equal(posts.length, 0, 'the admission form still creates a residentAssignments row from the HP on Duty');
  assert.doesNotMatch(CHILD_RECORDS, /\/resident-assignments\/\$\{editingAssignmentId\}\/end/, 'editing an admission still ends the Case Load assignment');
});

test('only the Center Head can assign or change a Case Load Manager', () => {
  const { canAssignCaseLoadManager } = require('../src/controllers/assignmentController');
  assert.equal(canAssignCaseLoadManager({ role: 'centerhead' }), true);
  assert.equal(canAssignCaseLoadManager({ role: 'Center Head' }), true);
  assert.equal(canAssignCaseLoadManager({ role: 'admin' }), true);
  for (const role of ['socialworker', 'houseparent', 'nurse', 'psychologist', 'educator']) {
    assert.equal(canAssignCaseLoadManager({ role }), false, `${role} may assign a Case Load Manager`);
  }
  for (const fn of ['async function create', 'async function update', 'async function end']) {
    const next = ASSIGNMENT.indexOf('\nasync function', ASSIGNMENT.indexOf(fn) + 1);
    const block = ASSIGNMENT.slice(ASSIGNMENT.indexOf(fn), next < 0 ? undefined : next);
    assert.match(block, /canAssignCaseLoadManager\(req\.user\)/, `${fn} does not apply the Center Head rule`);
  }
});

test('the SPA sends the id it shows, on create and on edit', () => {
  const writes = CHILD_RECORDS.match(/houseparentUserId:\s*\n?\s*form\.assignedHouseparentId/g) || [];
  assert.ok(
    writes.length >= 3,
    `only ${writes.length} of the three payloads (create, update, admission record) send the Houseparent id`,
  );
  // The HP on Duty is restored from the admission alone — never from the Case
  // Load assignment, which is a separate field.
  assert.match(
    CHILD_RECORDS,
    /assignedHouseparentId: source\.houseparentUserId \|\| ''/,
    'the form restores the HP on Duty from the Case Load assignment',
  );
});
