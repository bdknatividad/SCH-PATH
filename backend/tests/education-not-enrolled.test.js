/**
 * Item 11 — a resident who is not enrolled in school.
 *
 * The requirement: "Residents not enrolled in school (e.g. the enrolment period
 * has ended) should have Academic Support Sessions / Tutorial as the appropriate
 * educational activity."
 *
 * The level already existed — `Tutorial` is in the union and in the picker, and
 * the comment above it says it is for exactly this case. It was unreachable
 * anyway: `school` and `enrollmentDate` were NOT NULL in the database and
 * unconditionally required in the form, so a not-enrolled learner could not be
 * saved at all. The educator had to invent a school and an enrolment date, and
 * whatever they typed was then indistinguishable from a real placement — which
 * is worse than the field being empty.
 *
 * So three things are pinned here:
 *
 *   - the two columns are nullable, in both places a table is created, and an
 *     already-provisioned database is relaxed on boot;
 *   - the form requires them for every level that *is* a school placement and
 *     for nothing else;
 *   - the stored value stays `Tutorial` (existing records use it) while the label
 *     the user reads is the facility's own wording.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const SERVER = read('backend/src/server.js');
const SCHEMA = read('backend/src/database/schema.sql');
const CONSTANTS = read('backend/src/utils/constants.js');
const EDUCATION = read('frontend/src/app/components/Education.tsx');

/** The `CREATE TABLE ... education_records` statement, wherever it lives. */
function educationRecordsDdl(source, label) {
  const start = source.indexOf('CREATE TABLE IF NOT EXISTS education_records');
  assert.ok(start > 0, `${label} does not create education_records`);
  const end = source.indexOf('ENGINE=InnoDB', start);
  assert.ok(end > start, `${label}'s education_records statement has no end`);
  const ddl = source.slice(start, end);
  assert.ok(ddl.length > 400, `${label}'s education_records DDL sliced to ${ddl.length} characters`);
  return ddl;
}

// ── The columns are nullable ────────────────────────────────────────────────

test('a not-enrolled learner can be stored without a school or an enrolment date', () => {
  // Both places a table is created, because a fresh database and a provisioned
  // one take different paths and only one of them is exercised by a local run.
  for (const [source, label] of [
    [SERVER, 'the boot DDL'],
    [SCHEMA, 'schema.sql'],
  ]) {
    const ddl = educationRecordsDdl(source, label);
    assert.match(
      ddl,
      /school VARCHAR\(255\) NULL,/,
      `${label} still makes education_records.school NOT NULL`,
    );
    assert.match(
      ddl,
      /enrollmentDate DATE NULL,/,
      `${label} still makes education_records.enrollmentDate NOT NULL`,
    );
  }

  // `educationLevel` is what identifies the level, and stays required — the whole
  // point is that the *level* is recorded even when the placement is not.
  for (const [source, label] of [
    [SERVER, 'the boot DDL'],
    [SCHEMA, 'schema.sql'],
  ]) {
    assert.match(
      educationRecordsDdl(source, label),
      /educationLevel VARCHAR\(150\) NOT NULL,/,
      `${label} made educationLevel optional, so a record need not say what it is`,
    );
  }
});

test('an already-provisioned database is relaxed on boot', () => {
  // `CREATE TABLE IF NOT EXISTS` does nothing to an existing table, so the
  // deployed database — which already has both columns NOT NULL — would keep
  // refusing a Tutorial record without this.
  const start = SERVER.indexOf("['school', 'VARCHAR(255) NULL']");
  assert.ok(start > 0, 'the boot migration does not relax education_records.school');

  const block = SERVER.slice(start - 900, start + 1200);
  assert.ok(block.length > 1500, 'the migration block sliced to nothing');

  assert.match(block, /\['enrollmentDate', 'DATE NULL'\]/, 'enrollmentDate is not relaxed');
  assert.match(block, /IS_NULLABLE FROM INFORMATION_SCHEMA\.COLUMNS/, 'the migration does not read IS_NULLABLE first');
  assert.match(
    block,
    /LOWER\(TABLE_NAME\) = 'education_records'/,
    'the migration is not scoped to education_records',
  );
  // The backticks around the table name are escaped in the source — it is a
  // template literal — so the regex has to allow the backslashes.
  assert.match(
    block,
    /ALTER TABLE \\`education_records\\` MODIFY COLUMN/,
    'the migration never alters the column',
  );
  // Guarded, or a MySQL without the table (or without the privilege) would stop
  // the whole boot rather than one migration.
  assert.match(block, /catch \(err\) \{[\s\S]{0,200}Migration warning/, 'the migration is not guarded');
});

test('the nullable columns still reach the browser', () => {
  // A column that is in the table but not in `RESOURCES[].columns` never leaves
  // the server: `mapRow` copies only the declared columns, so the record would
  // save and then read back with the fields missing.
  const start = CONSTANTS.indexOf('education_records: {');
  assert.ok(start > 0, 'the education_records resource is gone');
  const resource = CONSTANTS.slice(start, CONSTANTS.indexOf('education_progress_reports:', start));
  assert.ok(resource.length > 200, 'the resource sliced to nothing');

  for (const column of ['school', 'enrollmentDate']) {
    assert.ok(
      resource.includes(`'${column}'`),
      `${column} is not declared on the education_records resource`,
    );
  }
});

// ── The form requires them only for a school placement ──────────────────────

test('the form requires a school and an enrolment date only for a school placement', () => {
  // One predicate, so "which levels are school placements" is answered in a
  // single place rather than restated at each field.
  assert.match(
    EDUCATION,
    /const isNotEnrolled = \(level: EducationLevel\): boolean => level === 'Tutorial';/,
    'there is no single definition of "not enrolled"',
  );

  const save = EDUCATION.slice(
    EDUCATION.indexOf('const handleSaveStudent = async'),
    EDUCATION.indexOf('const handleSaveStudent = async') + 1400,
  );
  assert.ok(save.length > 800, 'handleSaveStudent sliced to nothing');

  // The name is always required; the placement fields are not.
  assert.match(save, /if \(!studentForm\.name\.trim\(\)\)/, 'the name stopped being required');
  assert.match(
    save,
    /if \(!isNotEnrolled\(studentForm\.educationLevel\)\) \{/,
    'the placement fields are required regardless of the level, so a Tutorial record still cannot be saved',
  );

  // Both fields must sit inside that guard — one outside it would still block.
  const guard = save.slice(save.indexOf('if (!isNotEnrolled('));
  const guarded = guard.slice(0, guard.indexOf('\n    }'));
  assert.match(guarded, /School is required\./, 'the school check is outside the guard');
  assert.match(guarded, /Enrollment date is required\./, 'the enrolment-date check is outside the guard');

  // And the labels drop their asterisk for a not-enrolled learner, so the form
  // does not claim a field is mandatory and then accept it empty.
  assert.match(
    EDUCATION,
    /\{isNotEnrolled\(studentForm\.educationLevel\)\s*\?\s*'School \/ Institution'\s*:\s*'School \/ Institution \*'\}/,
    'the School label always claims to be required',
  );
  assert.match(
    EDUCATION,
    /\{isNotEnrolled\(studentForm\.educationLevel\)\s*\?\s*'Enrollment Date'\s*:\s*'Enrollment Date \*'\}/,
    'the Enrollment Date label always claims to be required',
  );
});

test('an empty enrolment date is sent as NULL, not an empty string', () => {
  // MySQL refuses '' for a DATE column under the default strict sql_mode, and
  // `errorHandler` masks the refusal to "Database error occurred" — so the
  // educator would see a database fault for leaving an optional field empty.
  const save = EDUCATION.slice(
    EDUCATION.indexOf('const handleSaveStudent = async'),
    EDUCATION.indexOf('const handleSaveStudent = async') + 1400,
  );
  assert.match(save, /enrollmentDate: studentForm\.enrollmentDate \|\| null/, 'an empty date is not sent as NULL');
  assert.match(save, /school: studentForm\.school\.trim\(\) \|\| null/, 'an empty school is not sent as NULL');

  // And the null that comes back must not reach a controlled input.
  assert.match(
    EDUCATION,
    /function normalizeStudent\(s: Student\): Student \{/,
    'there is no normalizer for the nullable fields',
  );
  const normalizer = EDUCATION.slice(
    EDUCATION.indexOf('function normalizeStudent('),
    EDUCATION.indexOf('function loadStudents('),
  );
  // Deliberately a low bound: the function is eight short lines, and a threshold
  // set near its real length is a test that breaks when the code is tidied.
  assert.ok(normalizer.length > 100, `the normalizer sliced to ${normalizer.length} characters`);
  assert.match(normalizer, /school: s\.school \|\| ''/, 'a null school is not normalized');
  assert.match(normalizer, /enrollmentDate: s\.enrollmentDate \|\| ''/, 'a null enrolment date is not normalized');

  // Every path that puts a record into state, asserted individually rather than
  // by a total: the cache, the API load, and the four save responses (create,
  // update, and the two file-upload updates). A missed one leaves null in a
  // controlled input on the next render, and a bare count would not say which.
  assert.ok(EDUCATION.includes('parsed.map(normalizeStudent)'), 'the cache load does not normalize');
  assert.ok(
    EDUCATION.includes('recordResult.data : []).map(normalizeStudent)'),
    'the API load does not normalize',
  );
  const savedUses = (EDUCATION.match(/normalizeStudent\(saved\)/g) || []).length;
  assert.equal(savedUses, 4, `only ${savedUses} of the 4 save responses normalize the record they store`);
});

// ── The label, not the stored value ─────────────────────────────────────────

test('the label reads as the facility words it, and the stored value is untouched', () => {
  // The value is already written on existing records. Renaming it would orphan
  // them, so only the label changes.
  assert.match(
    EDUCATION,
    /const LEVEL_LABELS: Partial<Record<EducationLevel, string>> = \{\s*'Tutorial': 'Academic Support Sessions \/ Tutorial',\s*\};/,
    'the Tutorial label is not the facility wording',
  );
  assert.match(
    EDUCATION,
    /const levelLabel = \(level: EducationLevel\): string => LEVEL_LABELS\[level\] \|\| level;/,
    'there is no fallback to the stored value',
  );

  // The picker and the two places a record's level is printed read the label, so
  // the user never sees the bare stored value.
  assert.match(
    EDUCATION,
    /EDUCATION_LEVELS\.map\(l => <SelectItem key=\{l\} value=\{l\}>\{levelLabel\(l\)\}<\/SelectItem>\)/,
    'the picker shows the stored value instead of the label',
  );
  assert.match(EDUCATION, /\{levelLabel\(viewStudent\.educationLevel\)\}/, 'the detail view shows the stored value');

  // The value itself must still be `Tutorial` everywhere it is compared or
  // written — a label must never leak into a comparison.
  assert.match(EDUCATION, /'Tutorial': 'Tutorial',/, 'the short badge label is not the stored value');
  assert.doesNotMatch(
    EDUCATION,
    /educationLevel === 'Academic Support Sessions/,
    'the label leaked into a comparison against the stored value',
  );
  assert.doesNotMatch(
    EDUCATION,
    /educationLevel: 'Academic Support Sessions/,
    'the label leaked into a stored value',
  );

  // The union still carries the value the existing rows use.
  assert.match(EDUCATION, /\| 'Tutorial'/, 'the Tutorial value was removed from the type union');
});
