/**
 * Item 10 — piercings and tattoos recorded at admission.
 *
 * The requirement is small and the failure mode is not: "use a dropdown for the
 * location, not free text". A body part typed into a text box is not a fact you
 * can read back — "left chest", "left side of the chest" and "chest (L)" are the
 * same finding, and a record that says a tattoo was placed but not *where* is
 * the thing a case conference asks about. So the location has to come from one
 * shared list, and the API has to enforce that same list: a frontend-only
 * dropdown is a suggestion, not a constraint.
 *
 * Three things therefore have to agree, and each is pinned here:
 *
 *   - `src/config/bodyMarkings.json`, mirrored byte-for-byte into the frontend
 *     (the `*.definition.json` convention — see `rbac.definition.json`).
 *   - `admissionController.normalizeBodyMarkings`, the one validator, used by
 *     both the create and the edit path.
 *   - `ChildRecords.tsx`, which renders the dropdown and sends the list.
 *
 * The column is `admissions.bodyMarkings` — TEXT holding a JSON array, declared
 * in schema.sql, in the boot DDL, in the boot `ensureColumn`, and registered on
 * the `admissions` resource as a jsonField. A column that is in the table but not
 * in `RESOURCES[].columns` never reaches the browser: `mapRow` copies only the
 * declared columns, so the feature would save and then read back empty.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const readBytes = (rel) => fs.readFileSync(path.join(REPO, rel));

const CONFIG_REL = 'src/config/bodyMarkings.json';
const CONFIG = JSON.parse(read(`backend/${CONFIG_REL}`));
const MIRROR_REL = 'frontend/src/app/config/bodyMarkings.json';

const CONTROLLER = read('backend/src/controllers/admissionController.js');
const CONSTANTS = read('backend/src/utils/constants.js');
const SERVER = read('backend/src/server.js');
const SCHEMA = read('backend/src/database/schema.sql');
const RECORDS = read('frontend/src/app/components/ChildRecords.tsx');

const { normalizeBodyMarkings } = require('../src/controllers/admissionController');

const LOCATIONS = CONFIG.locations;
const TYPES = CONFIG.markingTypes;

const isBadRequest = (error) => error && error.statusCode === 400;

// ── One vocabulary, two runtimes ────────────────────────────────────────────

test('the vocabulary is mirrored byte-for-byte into the frontend', () => {
  // Retyping a constant on one side is the divergence nobody notices, so the
  // two files are compared as bytes rather than parsed and compared field by
  // field — a reformat or a reordering is a divergence too.
  assert.deepEqual(
    readBytes(`backend/${CONFIG_REL}`),
    readBytes(MIRROR_REL),
    'the frontend copy of bodyMarkings.json has drifted from the backend one',
  );
});

test('the vocabulary is the one the form needs', () => {
  assert.deepEqual(TYPES, ['Tattoo', 'Piercing']);

  // The two the user named as examples, and the reason a combined dropdown was
  // chosen: a side-qualified entry is one click and one stored value.
  for (const location of ['Left Chest', 'Right Ear']) {
    assert.ok(LOCATIONS.includes(location), `${location} is not offered`);
  }

  // No duplicates: a repeated option renders twice in the dropdown and makes the
  // stored value ambiguous against the list it is validated with.
  assert.equal(
    new Set(LOCATIONS).size,
    LOCATIONS.length,
    'the location list contains a duplicate',
  );

  // Every entry is a real label, and "Other" is last so the list reads as a body
  // map rather than an alphabetised dump.
  for (const location of LOCATIONS) {
    assert.equal(typeof location, 'string');
    assert.equal(location, location.trim());
    assert.ok(location.length > 0, 'an empty location is offered');
  }
  assert.equal(LOCATIONS[LOCATIONS.length - 1], 'Other');

  assert.ok(Number.isInteger(CONFIG.maxEntries) && CONFIG.maxEntries > 0);
  assert.ok(
    Number.isInteger(CONFIG.maxDescriptionLength) && CONFIG.maxDescriptionLength > 0,
  );
});

test('both sides read the vocabulary instead of restating it', () => {
  // The dropdown is generated from the JSON, not from a literal array in the
  // component: a literal is what drifts.
  assert.match(CONTROLLER, /require\('\.\.\/config\/bodyMarkings\.json'\)/);
  assert.match(RECORDS, /import bodyMarkingsConfig from '@\/app\/config\/bodyMarkings\.json'/);
  assert.match(RECORDS, /const BODY_MARKING_LOCATIONS = bodyMarkingsConfig\.locations/);
  assert.match(RECORDS, /const BODY_MARKING_TYPES = bodyMarkingsConfig\.markingTypes/);
});

// ── The column exists on a fresh database and on an existing one ────────────

test('the column is declared in every place a table is created', () => {
  // `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so the boot
  // DDL alone would leave a deployed database without the column — and the
  // error would surface as the masked "Database error occurred".
  assert.match(SCHEMA, /bodyMarkings TEXT NULL/, 'schema.sql has no bodyMarkings column');
  assert.match(SERVER, /bodyMarkings TEXT NULL/, 'the boot DDL has no bodyMarkings column');
  assert.match(
    SERVER,
    /ensureColumn\('admissions', 'bodyMarkings', 'TEXT NULL', 'caseHistory'\)/,
    'an existing database never gains the column',
  );

  // Anchored after `caseHistory`, which is where the create path binds it.
  for (const [name, source] of [['schema.sql', SCHEMA], ['the boot DDL', SERVER]]) {
    assert.match(
      source,
      /caseHistory TEXT NOT NULL,\s*(?:--[^\n]*\n\s*)*bodyMarkings TEXT NULL,\s*(?:--[^\n]*\n\s*)*admissionStatus VARCHAR\(40\) NULL/,
      `${name} does not declare bodyMarkings between caseHistory and admissionStatus`,
    );
  }
});

test('the column is registered on the admissions resource, as a jsonField', () => {
  const resource = CONSTANTS.slice(
    CONSTANTS.indexOf('admissions: {'),
    CONSTANTS.indexOf('staff: {'),
  );
  assert.ok(resource.length > 100, 'the admissions resource was not found');

  // `columns` decides whether the value reaches the browser at all; `jsonFields`
  // decides whether it arrives as an array or as the raw JSON text.
  assert.match(resource, /jsonFields: \['bodyMarkings'\]/);
  assert.match(resource, /'caseHistory',\s*'bodyMarkings',\s*'admissionStatus',/);
});

// ── The validator ───────────────────────────────────────────────────────────

test('nothing recorded is stored as NULL, not as an empty list', () => {
  // `'[]'` reads as "checked, and there are none", which is a different
  // statement from "not recorded" — and an admission written before the column
  // existed holds NULL, so the two must not collide.
  assert.equal(normalizeBodyMarkings(undefined), null);
  assert.equal(normalizeBodyMarkings(null), null);
  assert.equal(normalizeBodyMarkings([]), null);
  assert.equal(normalizeBodyMarkings(''), null);
  assert.equal(normalizeBodyMarkings('   '), null);
  assert.equal(normalizeBodyMarkings('[]'), null);
});

test('an untouched row is dropped rather than refused', () => {
  // The form has an "Add marking" button, so a row can exist that was never
  // filled in. Refusing it would make an untouched button block the admission.
  assert.equal(normalizeBodyMarkings([{ type: '', location: '', description: '' }]), null);
  assert.equal(normalizeBodyMarkings([{}, null, undefined]), null);

  const mixed = normalizeBodyMarkings([
    { type: '', location: '', description: '' },
    { type: 'Tattoo', location: 'Left Chest', description: '  small heart  ' },
  ]);
  assert.deepEqual(JSON.parse(mixed), [
    { type: 'Tattoo', location: 'Left Chest', description: 'small heart' },
  ]);
});

test('a recorded marking round-trips, and a stored column is re-readable', () => {
  const stored = normalizeBodyMarkings([
    { type: 'Tattoo', location: 'Left Chest', description: 'dragon' },
    { type: 'Piercing', location: 'Right Ear', description: '' },
  ]);

  assert.equal(typeof stored, 'string', 'the column takes JSON text');
  assert.deepEqual(JSON.parse(stored), [
    { type: 'Tattoo', location: 'Left Chest', description: 'dragon' },
    { type: 'Piercing', location: 'Right Ear', description: '' },
  ]);

  // The edit form re-sends what it was given, so a round-tripped value has to be
  // accepted rather than refused as "not a list".
  assert.equal(normalizeBodyMarkings(stored), stored);
});

test('a body part the dropdown does not offer is refused, not stored', () => {
  // The whole point of the requirement. A free-text body part reaching the
  // column is the defect this guards.
  for (const location of ['left chest', 'Chest (L)', 'somewhere', 'Left  Chest', '']) {
    assert.throws(
      () => normalizeBodyMarkings([{ type: 'Tattoo', location, description: '' }]),
      isBadRequest,
      `"${location}" was accepted as a body part`,
    );
  }
});

test('an unknown marking type is refused', () => {
  // Case matters: "tattoo" and "TATTOO" are not the option the dropdown offers,
  // and storing them would put two spellings of one type in the column.
  for (const type of ['tattoo', 'TATTOO', 'Branding', '', 'Piercing/Tattoo']) {
    assert.throws(
      () => normalizeBodyMarkings([{ type, location: 'Left Chest', description: '' }]),
      isBadRequest,
      `"${type}" was accepted as a marking type`,
    );
  }

  // Surrounding whitespace is not a different value — it is trimmed and then
  // validated, so a padded value is stored in the dropdown's own spelling rather
  // than refused for a reason the user cannot see.
  assert.deepEqual(
    JSON.parse(normalizeBodyMarkings([{ type: '  Piercing  ', location: ' Left Ear ', description: '' }])),
    [{ type: 'Piercing', location: 'Left Ear', description: '' }],
  );
});

test('anything that is not a list is refused', () => {
  for (const value of [42, true, { type: 'Tattoo' }, 'not json', '{"a":1}']) {
    assert.throws(
      () => normalizeBodyMarkings(value),
      isBadRequest,
      `${JSON.stringify(value)} was accepted`,
    );
  }
});

test('the list and the note are both bounded', () => {
  const tooMany = Array.from({ length: CONFIG.maxEntries + 1 }, () => ({
    type: 'Tattoo',
    location: 'Left Chest',
    description: '',
  }));
  assert.throws(() => normalizeBodyMarkings(tooMany), isBadRequest);

  // Exactly at the cap is allowed — an off-by-one here would refuse a legitimate
  // record, which is worse than the bound being generous.
  const atCap = Array.from({ length: CONFIG.maxEntries }, () => ({
    type: 'Tattoo',
    location: 'Left Chest',
    description: '',
  }));
  assert.equal(JSON.parse(normalizeBodyMarkings(atCap)).length, CONFIG.maxEntries);

  const longNote = 'x'.repeat(CONFIG.maxDescriptionLength + 1);
  assert.throws(
    () => normalizeBodyMarkings([{ type: 'Tattoo', location: 'Left Chest', description: longNote }]),
    isBadRequest,
  );

  const noteAtCap = 'x'.repeat(CONFIG.maxDescriptionLength);
  assert.equal(
    JSON.parse(normalizeBodyMarkings([{ type: 'Tattoo', location: 'Left Chest', description: noteAtCap }]))[0]
      .description.length,
    CONFIG.maxDescriptionLength,
  );
});

// ── The API writes it ───────────────────────────────────────────────────────

test('the create path validates before the transaction opens', () => {
  // An unknown body part is the caller's mistake, and the transaction below
  // creates a resident, a phase row and the admission — so it must not be opened
  // to discover the mistake.
  const computeAt = CONTROLLER.indexOf('const bodyMarkings = normalizeBodyMarkings(admission.bodyMarkings)');
  const transactionAt = CONTROLLER.indexOf('await runInTransactionWithIdRetry(');
  assert.ok(computeAt > 0, 'the create path never validates the markings');
  assert.ok(
    computeAt < transactionAt,
    'the markings are validated inside the transaction, so a bad body part creates a resident first',
  );
});

test('the admission INSERT carries the column, a placeholder and a value', () => {
  const start = CONTROLLER.indexOf('INSERT INTO admissions (');
  const end = CONTROLLER.indexOf('`,', start);
  assert.ok(start > 0 && end > start, 'the admissions INSERT was not found');
  const sql = CONTROLLER.slice(start, end);

  assert.match(
    sql,
    /caseHistory,\s*bodyMarkings,\s*admissionStatus,/,
    'the column is not in the INSERT, so the value is silently dropped',
  );

  // The count is the real guard: adding a column without its `?` shifts every
  // later bind by one, so the classification would be written from the markings
  // and vice versa — and the failure is a wrong row, not an error.
  const placeholders = (sql.match(/\?/g) || []).length;
  assert.equal(placeholders, 29, `the INSERT binds ${placeholders} values, not 29`);

  // And the value itself, in the params array beside `caseHistory`.
  const params = CONTROLLER.slice(end, end + 1400);
  assert.match(params, /caseHistory,\s*bodyMarkings,\s*admissionStatus,/, 'the value is not bound');
});

test('the edit path accepts the markings and validates them the same way', () => {
  // The whitelist decides what an edit may change at all.
  assert.match(
    CONTROLLER,
    /'legalCategory','bodyMarkings','specificOffense','admissionStatus'\]/,
    'the edit path cannot correct the markings',
  );

  // And the generic bind must not be used for this field: that branch turns ''
  // into NULL, which is right for a text column and wrong here — an emptied list
  // has to clear the column, and a supplied one has to be checked first.
  assert.match(
    CONTROLLER,
    /if \(field === 'bodyMarkings'\) \{\s*sets\.push\(`\$\{field\} = \?`\);\s*values\.push\(normalizeBodyMarkings\(b\[field\]\)\);/,
    'the edit path binds the markings raw, so an unknown body part can be stored',
  );
});

// ── The form ────────────────────────────────────────────────────────────────

/** The piercing/tattoo card, sliced by its own comment markers. */
function bodyMarkingsCard() {
  const start = RECORDS.indexOf('{/* PIERCING / TATTOO */}');
  // The card was moved from Part 1 to Part 2 on the user's instruction, so its
  // end is no longer the ADMISSION STATUS block — it now has its own explicit
  // end marker. Slicing to the neighbouring element would quietly start
  // matching whatever sits below the card after any later edit.
  const end = RECORDS.indexOf('{/* END PIERCING / TATTOO', start);
  assert.ok(start > 0, 'the card is gone from the admission slip');
  assert.ok(end > start, 'the card has no end marker');
  const card = RECORDS.slice(start, end);
  // A slice marker that stopped matching turns the block into a few characters,
  // and every assertion below would then pass vacuously.
  assert.ok(card.length > 1500, `the card sliced to ${card.length} characters`);
  return card;
}

test('the markings card sits on Part 2, with the slip replica', () => {
  // The user asked for the card on the "Official Admission Slip", which in this
  // editor is Part 2 (`formStep === 2`); Part 1 is the Resident Admission
  // Details step. Moving it back would put the fields somewhere the user did not
  // ask for, and nothing else would fail.
  const partTwo = RECORDS.indexOf('{formStep ===\n              2 && (');
  assert.ok(partTwo > 0, 'the Part 2 block is gone');

  const cardAt = RECORDS.indexOf('{/* PIERCING / TATTOO */}');
  const editorAt = RECORDS.indexOf('<AdmissionSlipEditor');
  const partOneAt = RECORDS.indexOf('{formStep ===\n              1 && (');

  assert.ok(cardAt > partTwo, 'the card is not inside the Part 2 block');
  assert.ok(cardAt > editorAt, 'the card is not after the slip replica');
  assert.ok(partOneAt < partTwo, 'Part 1 no longer precedes Part 2');
  assert.ok(
    cardAt > partTwo,
    'the card drifted back into Part 1',
  );

  // Part 1's own tail must no longer carry the card: the last card in Part 1 is
  // Admission Status, and the card marker must come after Part 2 opens.
  const partOne = RECORDS.slice(partOneAt, partTwo);
  assert.doesNotMatch(partOne, /PIERCING \/ TATTOO/, 'the card is still on Part 1');
});

test('the body part is a dropdown, and it is not also a text box', () => {
  const card = bodyMarkingsCard();

  assert.match(card, /BODY_MARKING_LOCATIONS\.map\(/, 'the locations are not rendered from the list');
  assert.match(card, /BODY_MARKING_TYPES\.map\(/, 'the types are not rendered from the list');

  // The location reaches the row only through the dropdown's own handler. A
  // free-text path would be an `Input` bound to `marking.location`, so that is
  // what is checked for — by counting the card's inputs and asserting the only
  // one is the note.
  const inputs = card.match(/<Input\b/g) || [];
  assert.equal(inputs.length, 1, `the card has ${inputs.length} text inputs, not 1`);
  assert.match(card, /<Input[\s\S]{0,300}value=\{\s*marking\.description\s*\}/);
  assert.doesNotMatch(card, /<Input[\s\S]{0,300}marking\.location/);

  // And the dropdown writes through the row updater rather than free text.
  assert.match(card, /onValueChange=\{\(value\) =>\s*updateBodyMarking\(index, \{ location: value \}\)/);
  assert.doesNotMatch(card, /location: event\.target\.value/);
});

test('the card can add and remove a marking, and is bounded', () => {
  const card = bodyMarkingsCard();

  assert.match(card, /onClick=\{addBodyMarking\}/, 'no way to add a marking');
  // `\s*` before the brace: the handler call and its closing brace sit on
  // different lines in this file's formatting.
  assert.match(
    card,
    /onClick=\{\(\) =>\s*removeBodyMarking\(index\)\s*\}/,
    'no way to remove a marking',
  );
  assert.match(
    card,
    /disabled=\{\s*form\.bodyMarkings\.length >=\s*BODY_MARKING_MAX_ENTRIES\s*\}/,
    'the add button is not bounded by the cap the API enforces',
  );

  // The remove control is labelled for a screen reader: it has no text.
  assert.match(card, /aria-label="Remove this marking"/);
});

test('the row updater patches only the row it was given', () => {
  // `map` with an index guard, not a shared slot: writing `bodyMarkings[0]`
  // would edit the first row whichever one the user touched — the same
  // one-key-for-everything shape as the per-resident search defect.
  assert.match(
    RECORDS,
    /const updateBodyMarking = \(\s*index: number,\s*patch: Partial<BodyMarkingEntry>\s*\) => \{/,
  );
  const updater = RECORDS.slice(
    RECORDS.indexOf('const updateBodyMarking = ('),
    RECORDS.indexOf('const removeBodyMarking = ('),
  );
  assert.ok(updater.length > 100, 'the updater sliced to nothing');
  assert.match(updater, /previous\.bodyMarkings\.map\(/, 'the updater does not map over the rows');
  assert.match(updater, /entryIndex === index/, 'the updater does not target the row it was given');
});

test('all three write paths send the markings', () => {
  // A create that omits them silently records nothing, and the edit form would
  // then look like it had never been filled in.
  const calls = RECORDS.match(/bodyMarkingsForPayload\(/g) || [];
  assert.equal(calls.length, 4, `bodyMarkingsForPayload is used ${calls.length} times, not 4 (1 definition + 3 payloads)`);

  const builder = RECORDS.slice(
    RECORDS.indexOf('function bodyMarkingsForPayload('),
    RECORDS.indexOf('/* ================================================================\n   DATE HELPERS'),
  );
  assert.ok(builder.length > 100, 'the payload helper sliced to nothing');
  // Blank rows are dropped here too, so the client and the server agree about
  // what an untouched row means.
  assert.match(builder, /\.filter\(/, 'the helper sends untouched rows to the API');
  assert.match(builder, /\.slice\(0, BODY_MARKING_MAX_DESCRIPTION\)/);
});

test('a new admission starts with no markings carried over', () => {
  // The body is recorded as it was found at *this* admission. Re-sending the
  // previous admission's list would assert that a tattoo seen a year ago is
  // still there, and a removed one would stay on record for ever.
  const resets = RECORDS.match(
    /caseHistory: '',\s*\/\*[\s\S]{0,400}?bodyMarkings: \[\],/g,
  ) || [];
  assert.equal(
    resets.length,
    2,
    `only ${resets.length} of the two new-admission paths reset the markings`,
  );
});

test('a half-filled row is caught in the form, not by the API', () => {
  // The dropdowns cannot produce a bad body part, but they can leave a row with
  // a type and no location. Without this the API refuses the whole slip after
  // every other field has been filled in.
  //
  // The rule lives in one helper because there are two write paths and only one
  // of them runs `validatePartTwo` — the edit form does not, so a rule written
  // inline in the validator would miss half the surface.
  const helper = RECORDS.slice(
    RECORDS.indexOf('function unfinishedBodyMarkings('),
    RECORDS.indexOf('const UNFINISHED_MARKING_MESSAGE'),
  );
  assert.ok(helper.length > 100, 'the helper sliced to nothing');
  assert.match(
    helper,
    /started &&\s*\(marking\.type === '' \|\|\s*marking\.location === ''\)/,
    'a row with only half of the pair is not detected',
  );

  const validator = RECORDS.slice(
    RECORDS.indexOf('const validatePartTwo ='),
    RECORDS.indexOf('const buildSlipData ='),
  );
  assert.ok(validator.length > 500, 'validatePartTwo sliced to nothing');
  assert.match(validator, /errors\.bodyMarkings =/, 'the form does not check the markings');
  assert.match(
    validator,
    /unfinishedBodyMarkings\(\s*form\.bodyMarkings\s*\)/,
    'the new-admission path does not use the shared rule',
  );

  // Building the error is not the same as showing it. The card sits on Part 1
  // while the save button sits on Part 2, so the only thing that reaches the
  // user is the form's error summary, which reads `formErrors`. A validator that
  // returns false without publishing leaves the save button looking dead —
  // verified in the live UI, where the refusal appears in that banner.
  assert.match(
    validator,
    /setFormErrors\(\s*errors\s*\)/,
    'validatePartTwo builds the errors without publishing them, so a refusal is never shown',
  );

  // And the edit path applies the same rule, or an edited slip reaches the API
  // with a row it will refuse.
  const editPath = RECORDS.slice(
    RECORDS.indexOf('const handleUpdateResident = async'),
    RECORDS.indexOf('const handleUpdateResident = async') + 1200,
  );
  assert.match(
    editPath,
    /unfinishedBodyMarkings\(form\.bodyMarkings\)/,
    'the edit path does not check the markings',
  );
  assert.match(
    editPath,
    /setFormErrors\(\{\s*bodyMarkings: UNFINISHED_MARKING_MESSAGE\s*\}\)/,
    'the edit path detects an unfinished row but never shows the message',
  );

  // The message is shown, or the save button would appear to do nothing.
  assert.match(bodyMarkingsCard(), /formErrors\.bodyMarkings && \(/);
});

test('the form state carries the markings through a load', () => {
  // A column that is not read back is a column that was never stored, from the
  // user's side. Rows are rebuilt field by field so an older row cannot leave an
  // undefined in a controlled input.
  assert.match(RECORDS, /bodyMarkings: Array\.isArray\(source\.bodyMarkings\)/);
  assert.match(RECORDS, /bodyMarkings: \[\]/, 'EMPTY_FORM has no markings list');

  // The type on both interfaces, so neither the load nor the payload compiles
  // against a field that does not exist.
  const declared = RECORDS.match(/bodyMarkings\??: BodyMarkingEntry\[\] \| null;/g) || [];
  assert.equal(declared.length, 1, 'AdmissionRecord does not carry the markings');
  assert.match(RECORDS, /bodyMarkings: BodyMarkingEntry\[\];/, 'ChildFormState has no markings field');
});

test('the printed Admission Slip carries the markings', () => {
  // The user asked for the piercings and tattoos to appear on the generated
  // slip. Three links have to hold, and each fails differently: the form data
  // reaching `buildSlipData`, the slip data reaching the generator, and the
  // generator actually drawing it.
  const slipData = RECORDS.slice(
    RECORDS.indexOf('const buildSlipData ='),
    RECORDS.indexOf('const buildSlipData =') + 4000,
  );
  assert.ok(slipData.length > 1000, 'buildSlipData sliced to nothing');
  assert.match(
    slipData,
    /bodyMarkings:\s*bodyMarkingsForPayload\(\s*form\.bodyMarkings\s*\)/,
    'the slip data does not carry the markings, so the PDF can never show them',
  );

  const generator = RECORDS.slice(
    RECORDS.indexOf('const generateAdmissionSlipPdf ='),
    RECORDS.indexOf('const generateAdmissionSlipPdf =') + 12000,
  );
  assert.ok(generator.length > 5000, 'the slip generator sliced to nothing');
  assert.match(generator, /Array\.isArray\(admission\.bodyMarkings\)/, 'the generator ignores the markings');
  assert.match(generator, /bodyMarkingsSlipText\(/, 'the generator never builds the markings text');
  assert.match(generator, /drawWrappedText\(\s*slipMarkings/, 'the markings text is built but never drawn');

  // Only when there is something to print: a resident with no markings must
  // produce the same slip it produced before this feature existed.
  assert.match(
    generator,
    /if \(recordedMarkings\.length > 0\) \{/,
    'the block would draw even with nothing on record',
  );
});

test('the slip text names the type, keeps the note, and admits what it dropped', () => {
  const helper = RECORDS.slice(
    RECORDS.indexOf('function bodyMarkingsSlipText('),
    RECORDS.indexOf('const EMPTY_FORM'),
  );
  assert.ok(helper.length > 400, 'the helper sliced to nothing');

  // The vocabulary is iterated, not restated, so the printed grouping cannot
  // drift from the dropdown's list.
  assert.ok(helper.includes('for (const type of BODY_MARKING_TYPES)'), 'the list is not grouped by type');
  // The note follows its own marking, so a note can never be read as belonging
  // to the next body part in the list.
  assert.ok(helper.includes('entry.location} (${clipped})'), 'a note is not printed with its marking');
  assert.ok(helper.includes('(+${dropped} more)'), 'the dropped count is not printed');
  assert.ok(helper.includes('Piercings / Tattoos: ${body}${suffix}'), 'the block has no label');

  // A slip that lists fewer markings than are on record must say so — silently
  // printing a short list reads as a complete one.
  assert.ok(helper.includes('dropped > 0 ?'), 'nothing distinguishes a truncated list from a full one');
  // And an empty note must not leave stray punctuation behind.
  assert.ok(helper.includes('if (!note) return entry.location;'), 'an absent note is not handled');
});

test('the printed block stays inside the free band on the template', () => {
  // The template has no body-marking area, so the block is overlaid on the band
  // between the Houseparent block and the Attested-by row. Measured on
  // frontend/public/forms/admission-slip.pdf at 150 dpi: ink-free from y_top
  // 492.3 to 531.4 across the full width. Moving the block, growing the font or
  // adding a line can collide with either neighbour, and no other test would
  // notice — the PDF would simply print on top of a signature line.
  const num = (name) => {
    const m = RECORDS.match(new RegExp(`const ${name} = ([0-9.]+);`));
    assert.ok(m, `${name} is gone from the component`);
    return Number(m[1]);
  };

  const size = num('MARKINGS_FONT_SIZE');
  const leading = num('MARKINGS_LINE_HEIGHT');
  const lines = num('MARKINGS_SLIP_MAX_LINES');
  const baseline = num('MARKINGS_SLIP_BASELINE');
  const width = num('MARKINGS_SLIP_WIDTH');

  assert.ok(leading > size, `line height ${leading} is not greater than font size ${size}`);
  assert.ok(lines >= 1 && lines <= 6, `the block claims ${lines} lines`);

  // PDF y grows upward; the measured bands are quoted top-down.
  const PAGE_HEIGHT = 612;
  const houseparentEdge = PAGE_HEIGHT - 492.3; // 119.7
  const attestedEdge = PAGE_HEIGHT - 531.4; // 80.6

  // `drawWrappedText` draws line `index` at `y - index * lineHeight`, so the
  // first line is the highest and the last is the lowest.
  const highest = baseline + size * 0.75;
  const lowest = baseline - (lines - 1) * leading - size * 0.25;

  assert.ok(
    highest <= houseparentEdge - 2,
    `the block reaches y=${highest.toFixed(2)}, into the Houseparent block at ${houseparentEdge}`,
  );
  assert.ok(
    lowest >= attestedEdge + 2,
    `the block drops to y=${lowest.toFixed(2)}, into the Attested-by row at ${attestedEdge}`,
  );

  // It is drawn at x=72 with this width, and must stay on the page and within
  // the template's own right margin (its widest line ends at 708.3).
  assert.equal(72 + width <= 708, true, `the block runs to x=${72 + width}, past the form's right margin`);
});
