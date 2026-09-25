/**
 * Admission: an optional guardian, and a classification that is stored.
 *
 * Two rules that look like field tweaks and are not:
 *
 *   - `guardianName` / `guardianContact` / `guardianAddress` were NOT NULL and
 *     mandatory in the form, so a resident whose guardian had not been traced
 *     could not be admitted at all. A placeholder typed to get past the check is
 *     worse than a blank, because it reads as a real guardian afterwards.
 *   - the admission's classification was derived on every render from the
 *     resident's name and date of birth, which can only ever answer "is this the
 *     first admission". A resident who left without permission and a resident who
 *     returned to substance use are identical in the data, so the two returning
 *     values have to be chosen and stored.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const CONTROLLER = read('backend/src/controllers/admissionController.js');
const CONSTANTS = read('backend/src/utils/constants.js');
const SERVER = read('backend/src/server.js');
const SCHEMA = read('backend/src/database/schema.sql');
const RECORDS = read('frontend/src/app/components/ChildRecords.tsx');

const { resolveAdmissionStatus } = require('../src/controllers/admissionController');
const { ADMISSION_STATUSES } = require('../src/utils/constants');

// ── The guardian is optional ────────────────────────────────────────────────

test('the guardian is not a required field on the admission API', () => {
  // `requireField` is the thing that refused the admission, so its absence for
  // each of the three is the rule. Matching the call rather than the word, so a
  // comment about the old behaviour cannot satisfy it.
  for (const field of ['guardianName', 'guardianContact', 'guardianAddress']) {
    assert.doesNotMatch(
      CONTROLLER,
      new RegExp(`requireField\\(\\s*resident\\.${field}`),
      `${field} is still mandatory, so a resident without a guardian cannot be admitted`,
    );
  }
});

test('a supplied guardian contact still has to be usable', () => {
  // Optional is not "unchecked": a number that was typed has to be a number.
  assert.match(
    CONTROLLER,
    /if \(guardianContact\) \{\s*requireContactNumber\(guardianContact, 'Guardian contact'\);/,
    'a malformed guardian contact is now accepted',
  );
  assert.match(
    RECORDS,
    /form\.guardianContact\.trim\(\) &&\s*!\/\^\\d\{11\}\$\/\.test\(/,
    'the form no longer validates a contact number that was filled in',
  );
});

test('a blank guardian is stored as NULL, not as an empty string', () => {
  // `guardianName || null` at every bind site: an empty string would pass the
  // column and then read as "a guardian whose name is empty".
  const binds = CONTROLLER.match(/guardian(Name|Contact|Address) \|\| null/g) || [];
  assert.ok(binds.length >= 4, `only ${binds.length} guardian values are normalised before binding`);
  // The only reads of the raw value are the three that build the trimmed locals;
  // anything else means a bind is taking the caller's value unnormalised.
  const rawReads = CONTROLLER.match(/resident\.guardian(Name|Contact|Address)\b/g) || [];
  assert.equal(
    rawReads.length,
    3,
    `the raw guardian value is read in ${rawReads.length} places; only the three normalisations may`,
  );
});

test('the guardian columns are nullable in both definitions and on an existing database', () => {
  for (const [name, source] of [['schema.sql', SCHEMA], ['the boot DDL', SERVER]]) {
    for (const column of ['guardianName VARCHAR(150)', 'guardianContact VARCHAR(100)', 'guardianAddress TEXT']) {
      assert.ok(
        source.includes(`${column} NULL`),
        `${name} still declares ${column} NOT NULL`,
      );
      assert.ok(
        !source.includes(`${column} NOT NULL`),
        `${name} still declares ${column} NOT NULL`,
      );
    }
  }
  // And an existing database is relaxed rather than left behind, guarded so the
  // table rebuild does not run on every boot.
  assert.match(SERVER, /SELECT IS_NULLABLE FROM INFORMATION_SCHEMA\.COLUMNS/, 'the columns are never relaxed on an existing database');
  assert.match(
    SERVER,
    /MODIFY COLUMN[\s\S]{0,80}\$\{column\}[\s\S]{0,40}\$\{definition\}/,
    'the relaxation never alters the column',
  );
});

test('clearing the guardian on the slip clears it on the resident too', () => {
  // Personal Info reads `children`, the slip reads `admissions`. COALESCE would
  // keep the old name after the slip was blanked, so the two views would
  // disagree about whether the resident has a guardian.
  //
  // Scoped to `update()` on purpose: there is a second `UPDATE children` in the
  // returning-resident branch, and slicing from the first occurrence in the file
  // asserts on a statement this rule is not about.
  const updateFn = CONTROLLER.slice(CONTROLLER.indexOf('async function update('));
  assert.ok(updateFn.length > 0, 'update() is gone');
  const mirror = updateFn.slice(
    updateFn.indexOf('UPDATE children'),
    updateFn.indexOf('UPDATE children') + 900,
  );
  assert.match(mirror, /guardianName = \?,\s*guardianContact = \?,/, 'the guardian is still COALESCEd, so it cannot be cleared');
  assert.doesNotMatch(mirror, /guardianName = COALESCE/, 'the guardian is still COALESCEd, so it cannot be cleared');
});

// ── The classification is stored ────────────────────────────────────────────

test('the vocabulary is exactly the three classifications', () => {
  assert.deepEqual(ADMISSION_STATUSES, [
    'New',
    'Returning Resident (Abscon/Tumakas)',
    'Relapse',
  ]);
});

test('a first admission is New whatever the caller asks for', () => {
  for (const requested of ['Relapse', 'Returning Resident (Abscon/Tumakas)', 'New', '', null, undefined, 'nonsense']) {
    assert.equal(
      resolveAdmissionStatus(1, requested),
      'New',
      `admission number 1 was classified "${requested}"`,
    );
  }
});

test('a later admission takes the caller\'s choice, and only a real one', () => {
  assert.equal(resolveAdmissionStatus(2, 'Relapse'), 'Relapse');
  assert.equal(resolveAdmissionStatus(2, 'Returning Resident (Abscon/Tumakas)'), 'Returning Resident (Abscon/Tumakas)');
  assert.equal(resolveAdmissionStatus(7, 'Relapse'), 'Relapse');

  // "New" is not available for a later admission, and an unknown value falls
  // back rather than reaching the column.
  assert.equal(resolveAdmissionStatus(2, 'New'), 'Returning Resident (Abscon/Tumakas)');
  for (const junk of ['', null, undefined, 'nonsense', '  ']) {
    assert.equal(
      resolveAdmissionStatus(2, junk),
      'Returning Resident (Abscon/Tumakas)',
      `an unrecognised classification (${JSON.stringify(junk)}) reached the admission`,
    );
  }
});

test('the classification is persisted and can be corrected', () => {
  assert.match(CONTROLLER, /resolveAdmissionStatus\(admissionNumber, admission\.admissionStatus\)/, 'the create path does not classify the admission');
  assert.match(CONTROLLER, /\n\s+admissionStatus,\n\s+expectedDischargeDate,/, 'the create path does not bind the classification');
  assert.match(
    CONTROLLER,
    /'specificOffense','admissionStatus'\]/,
    'the edit path cannot correct a misclassification',
  );
  assert.match(CONSTANTS, /'admissionStatus',\n\s+'status',/, 'the column is not registered on the admissions resource');
});

test('the column exists on a fresh database and is backfilled on an old one', () => {
  assert.match(SCHEMA, /admissionStatus VARCHAR\(40\) NULL/, 'schema.sql has no admissionStatus column');
  assert.match(SERVER, /admissionStatus VARCHAR\(40\) NULL/, 'the boot DDL has no admissionStatus column');
  assert.match(
    SERVER,
    /ensureColumn\('admissions', 'admissionStatus', 'VARCHAR\(40\) NULL', 'caseHistory'\)/,
    'an existing database never gains the column',
  );
  // Rows written before the column existed are classified from the two-value
  // vocabulary the interface used then, not left NULL.
  assert.match(
    SERVER,
    /WHEN admissionNumber > 1 THEN \?[\s\S]{0,120}ELSE 'New'[\s\S]{0,80}WHERE admissionStatus IS NULL/,
    'existing admissions are left unclassified',
  );
});

test('the form sends the classification and only asks when it can differ', () => {
  // Both write paths carry it; a create that omits it silently gets the fallback.
  const sends = RECORDS.match(/\n\s+admissionStatus,\n/g) || [];
  assert.ok(sends.length >= 3, `the classification is sent in only ${sends.length} payloads`);

  // The chooser appears for a returning admission only — a first admission has
  // no choice to make — and not at all for a resident returning from Abscond,
  // where the classification is forced and the API overrides whatever is sent.
  // Offering the chooser there would show a choice that cannot be honoured.
  assert.match(RECORDS, /const isReturningAdmission = Boolean\(/, 'the returning case is not distinguished');
  assert.match(RECORDS, /const isReturningFromAbscond = Boolean\(/, 'the forced Abscond classification is not distinguished');
  assert.match(
    RECORDS,
    /\{isReturningAdmission && !isReturningFromAbscond && \(/,
    'the chooser is not limited to a returning admission that can differ',
  );
  assert.match(RECORDS, /'Returning Resident \(Abscon\/Tumakas\)',\s*'Relapse',/, 'the two returning classifications are not offered');
  // Editing an existing slip must not reclassify it.
  assert.match(
    RECORDS,
    /existingAdmission\?\.admissionStatus \|\| 'New'/,
    'editing a slip reclassifies it instead of keeping what it was',
  );
  // The old two-value vocabulary is gone.
  assert.doesNotMatch(RECORDS, /'First Admission'/, 'the old "First Admission" label is still in the form');
});
