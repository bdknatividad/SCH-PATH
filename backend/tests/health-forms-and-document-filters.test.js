/**
 * The Health forms and the Documents list — the Nurse's batch.
 *
 * Everything here is a rule that type-checks and builds cleanly while being
 * wrong, which is why it is pinned by reading the source rather than by a
 * compile:
 *
 *   - a signature pad still rendered on one of the two sheets after the
 *     signature was removed from both,
 *   - a BMI that is typed in rather than derived, so a corrected height leaves a
 *     stale figure beside it,
 *   - a resident-status filter that defaults to "all", which is the same as not
 *     having one,
 *   - a document type offered by the picker with no permission entry, which the
 *     undefined-means-everyone rule turns into an open upload,
 *   - a medical-notes notification addressed by name instead of by caseload id.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const HEALTH = read('frontend/src/app/components/Health.tsx');
const DOCUMENTS = read('frontend/src/app/components/DocumentUpload.tsx');
const PHASE_PROGRESS = read('frontend/src/app/components/PhaseProgress.tsx');
const CONSTANTS = read('backend/src/utils/constants.js');
const CHILD_CONTROLLER = read('backend/src/controllers/childController.js');

/** The record form's own body, so the view dialog cannot satisfy an assertion. */
function recordFormSource() {
  const start = HEALTH.indexOf('THE RECORD FORM.');
  assert.ok(start > 0, 'the record form marker is gone');
  const end = HEALTH.indexOf('{/* VIEW DIALOG */}', start);
  assert.ok(end > start, 'the record form has no end marker');
  return HEALTH.slice(start, end);
}

// ── The medical sheet ───────────────────────────────────────────────────────

test('the medical sheet logs one consultation per row, each with its own date', () => {
  // Multi-date is the point of the sheet: a resident's history is one record,
  // not one record per visit. The date column has to be an input inside the row
  // rather than a single field above the table.
  assert.match(
    HEALTH,
    /function emptyMedicalRow\(/,
    'the row factory is gone, so the three places that create a row can drift apart',
  );
  assert.match(
    HEALTH,
    /date: date \|\| new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/,
    'a new row no longer defaults to today',
  );

  const form = recordFormSource();
  assert.match(
    form,
    /\(\['date', 'findings', 'laboratoryProcedure', 'prescription', 'careProvider', 'doctorName', 'specialization'\] as const\)\.map/,
    'the row no longer renders every column, including the doctor and the specialization',
  );
  // The row builder has to be shared, or "Add entry" can create a row the table
  // cannot render.
  assert.ok(
    (HEALTH.match(/emptyMedicalRow\(/g) || []).length >= 3,
    'the row factory is not used by the initial state, the reset and "Add entry" alike',
  );
});

test('an older single-entry medical record is lifted into a row, not shown blank', () => {
  // Records written before the sheet became a running log keep their fields on
  // `details` rather than in a `medicalRows` array. Opening one has to show what
  // it holds, and the fields it does not have have to be defaulted rather than
  // left undefined for a controlled input.
  assert.match(
    HEALTH,
    /\(r\.details\?\.medicalRows \|\| \[\{/,
    'the pre-log shape is no longer lifted into a row, so those records open blank',
  );
  assert.match(
    HEALTH,
    /\.map\(\(row: Partial<ReturnType<typeof emptyMedicalRow>>\) => \(\{ \.\.\.emptyMedicalRow\(row\.date\), \.\.\.row \}\)\)/,
    'the lifted row is not merged over a complete row, so its new fields are undefined',
  );
});

// ── The signature is gone from both sheets ──────────────────────────────────

test('neither sheet collects a signature, and the stored value survives an edit', () => {
  assert.doesNotMatch(HEALTH, /<SignaturePadModal/, 'a signature pad is still rendered');

  // Removing the input must not erase what an older record already has. The
  // field is carried through the save payload untouched.
  assert.match(
    HEALTH,
    /doctorSignature: form\.doctorSignature,/,
    'the stored signature is dropped from the payload, so editing an old record erases it',
  );
  assert.match(
    HEALTH,
    /doctorSignature: r\.details\?\.doctorSignature \|\| '',/,
    'the stored signature is no longer read back when a record is opened',
  );
});

test('the dentist and the clinic replace the dental signature', () => {
  const form = recordFormSource();
  assert.match(form, /label="Dentist's Name"/, 'the dentist is not recorded');
  assert.match(form, /label="Dental Clinic Name"/, 'the clinic is not recorded');
  assert.match(
    HEALTH,
    /dentistName: form\.dentistName,\s*dentalClinicName: form\.dentalClinicName,/,
    'the two fields are rendered but never saved',
  );
  assert.match(
    HEALTH,
    /dentistName: r\.details\?\.dentistName \|\| '',/,
    'the two fields are saved but never read back',
  );
});

// ── BMI ─────────────────────────────────────────────────────────────────────

test('BMI is derived from the recorded height and weight, never typed', () => {
  // The formula and the band are the whole feature; a hardcoded or absent BMI
  // is indistinguishable from a correct one on screen.
  assert.match(HEALTH, /function bmiFor\(/, 'the BMI helper is gone');
  assert.match(
    HEALTH,
    /const bmi = kilograms \/ \(metres \* metres\);/,
    'the BMI is not computed from the weight and the height',
  );
  assert.match(HEALTH, /value > 3 \? value \/ 100 : value/, 'centimetres are not converted to metres');
  // The reference range is the 18.5–24.9 band expressed as kilograms.
  assert.match(HEALTH, /18\.5 \* metres \* metres/, 'the healthy-weight range is gone');
  assert.match(HEALTH, /24\.9 \* metres \* metres/, 'the healthy-weight range is gone');

  // And the sheet renders both from the measurements rather than from inputs.
  const form = recordFormSource();
  const bmiIndex = form.indexOf('bmiFor(entry.height, entry.weight)');
  assert.ok(bmiIndex > 0, 'the form does not show a computed BMI');
  assert.match(form, /healthyWeightRange\(entry\.height\)/, 'the form does not show the healthy-weight reference');

  // The BMI cell must be rendered text, not a field: an input beside the two
  // measurements can be typed over and then disagree with them.
  const bmiCell = form.slice(Math.max(0, bmiIndex - 400), bmiIndex + 200);
  assert.doesNotMatch(
    bmiCell,
    /<Input/,
    'the BMI is an input, so it can disagree with the measurements beside it',
  );
  assert.match(bmiCell, /<td/, 'the BMI is no longer a table cell');
});

test('the saved measurement sheet keeps its twelve months', () => {
  assert.match(
    HEALTH,
    /const \[monthlyMeasurements, setMonthlyMeasurements\] = useState\(\(\) => Array\.from\(\{ length: 12 \}/,
    'the monthly record is no longer twelve entries',
  );
  assert.match(HEALTH, /monthlyMeasurements,\s*observations:/, 'the monthly measurements are no longer saved');
});

// ── Documents: the resident-status filter ───────────────────────────────────

test('the Documents list filters residents by status and defaults to Active', () => {
  assert.match(
    DOCUMENTS,
    /useState<'Active' \| 'Discharged' \| 'all'>\('Active'\)/,
    'the resident-status filter does not default to Active',
  );
  assert.match(
    DOCUMENTS,
    /\(child\.status === 'Discharged' \? 'Discharged' : 'Active'\) === residentStatusFilter/,
    'the status predicate no longer treats everything but Discharged as Active',
  );
  // Applied everywhere the resident filter is: the folder tree, the flat list,
  // the folder count and the pending queue. A filter that only narrowed one of
  // them would leave the others showing the closed cases it exists to hide.
  const applications = DOCUMENTS.match(/matchesResidentStatus(?:ForDocument)?\(/g) || [];
  assert.ok(
    applications.length >= 5,
    `the status filter is applied in only ${applications.length} places`,
  );
  assert.match(
    DOCUMENTS,
    /const filteredChildren = children\.filter\(c =>\s*\n\s*\(filterResident === 'all' \|\| c\.id === filterResident\)\s*\n\s*&& matchesResidentStatus\(c\)/,
    'the folder tree does not apply the status filter',
  );
  assert.match(
    DOCUMENTS,
    /docs=\{pendingDocs\.filter\(d =>[\s\S]{0,160}matchesResidentStatusForDocument\(d\.residentId\)/,
    'the pending queue does not apply the status filter',
  );
  for (const label of ['Active Residents', 'Discharged Residents']) {
    assert.ok(DOCUMENTS.includes(label), `the picker no longer offers "${label}"`);
  }
});

// ── Documents: the medical upload types ─────────────────────────────────────

test('Laboratory Results is declared in all three permission maps, for the Nurse', () => {
  // A key present in one copy and missing from another is not "nobody": every
  // lookup treats undefined as "every role", so a missing entry is an open
  // upload. tests/document-access-request.test.js asserts the three maps are
  // equal; this asserts the entry exists at all and names the right roles.
  const entry = /'Laboratory Results':\s*\[([^\]]*)\]/;
  for (const [name, source] of [
    ['backend constants', CONSTANTS],
    ['DocumentUpload', DOCUMENTS],
    ['PhaseProgress', PHASE_PROGRESS],
  ]) {
    const match = source.match(entry);
    assert.ok(match, `Laboratory Results is missing from ${name}`);
    const roles = match[1].split(',').map((role) => role.trim().replace(/^'|'$/g, '')).sort();
    assert.deepEqual(roles, ['centerhead', 'nurse'], `${name} grants the wrong roles`);
  }
});

test('the upload picker offers the types no phase gates', () => {
  assert.match(
    DOCUMENTS,
    /const GENERAL_DOCUMENTS = \['Medical Certificate', 'Laboratory Results'\];/,
    'the un-gated document types are gone, so the picker can only offer phase documents',
  );
  assert.match(
    DOCUMENTS,
    /for \(const doc of GENERAL_DOCUMENTS\)/,
    'the list is declared but never offered',
  );
  // Offered only to a role the permission map allows — the API refuses the rest,
  // so offering it would be a button that always fails.
  assert.match(
    DOCUMENTS,
    /if \(\(!allowedRoles \|\| allowedRoles\.includes\(userRole\)\) && !result\.find\(r => r\.doc === doc\)\)/,
    'the picker no longer checks the permission map before offering a type',
  );
});

test('a laboratory slip files into the Medical Records folder', () => {
  // The folder rules are shared with the backend and the word "laboratory" is
  // what routes it; without the keyword it lands in Other Documents.
  const rules = JSON.parse(read('frontend/src/app/config/documentCategories.json'));
  const medical = rules.rules.find((rule) => rule.folder === 'Medical Records');
  assert.ok(medical, 'the Medical Records rule is gone');
  assert.ok(
    (medical.keywords || []).includes('laboratory'),
    'a laboratory slip no longer routes to Medical Records',
  );
});

// ── The medical-notes notification ──────────────────────────────────────────

test('updating the Medical Notes notifies the assigned Houseparents, by id', () => {
  const update = CHILD_CONTROLLER.slice(
    CHILD_CONTROLLER.indexOf('async function update('),
    CHILD_CONTROLLER.indexOf('async function deleteChild('),
  );

  // Read the previous value first: the form re-saves the same text whenever an
  // unrelated field is touched, and that is not news.
  assert.match(
    update,
    /const \[before\] = await pool\.query\('SELECT notes FROM children WHERE id = \?', \[req\.params\.id\]\)/,
    'the previous notes are not read, so every save notifies',
  );
  assert.ok(
    update.indexOf('SELECT notes FROM children') < update.indexOf('baseController.update(req, res, next)'),
    'the previous value is read after the write, so it is already the new one',
  );
  assert.match(
    update,
    /\(previousMedicalNotes \?\? ''\) !== medicalNotes/,
    'an unchanged note still notifies',
  );

  // Addressed through the caseload helper, which resolves assignments by user id.
  assert.match(
    update,
    /notifications\.houseparentsOf\(req\.params\.id\)/,
    'the notification is not scoped to the resident’s assigned Houseparents',
  );
  assert.match(update, /notifications\.notifyUsers\(/, 'the Houseparents are not addressed individually');
  assert.doesNotMatch(
    update,
    /targetRole:\s*'houseparent'/,
    'the alert is addressed to the whole role, so every Houseparent sees another resident’s notes',
  );
  // A failed alert must not fail the save that already succeeded.
  assert.match(update, /catch \(alertError\)/, 'a failed notification would now fail the save');
});
