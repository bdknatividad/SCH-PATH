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

test('an empty school is stored as NULL, not as an empty string', () => {
  // Relaxing the column to NULL creates a second way to say "no school": the
  // form sends `null`, but a caller that sends the empty string it read out of a
  // form field would store `''`. Two spellings of the same fact in one column
  // means every reader downstream has to know about both — and the education
  // form's own `normalizeStudent` only ever learned about one.
  //
  // Found live: `POST /education-records` with `school: ''` returned `""` while
  // `enrollmentDate: null` returned `null` from the same request.
  const { bindValue } = require('../src/controllers/baseController');
  const config = require('../src/utils/constants').RESOURCES.education_records;

  assert.deepEqual(
    config.blankToNull,
    ['school', 'enrollmentDate'],
    'the resource does not declare which columns collapse to NULL',
  );

  for (const column of config.blankToNull) {
    assert.equal(bindValue(config, column, ''), null, `"${column}: ''" is not stored as NULL`);
    assert.equal(bindValue(config, column, '   '), null, `"${column}: '   '" is not stored as NULL`);
    assert.equal(bindValue(config, column, null), null, `"${column}: null" is not stored as NULL`);
    assert.equal(bindValue(config, column, undefined), null, `"${column}: undefined" is not stored as NULL`);
    // A real value survives, trimmed — the trim is what makes '  ' blank.
    assert.equal(bindValue(config, column, '  LPU Laguna  '), 'LPU Laguna', `${column} is not trimmed`);
  }

  // Opt-in: a column the resource does not declare is untouched, so this cannot
  // quietly rewrite the empty strings other resources store deliberately.
  const other = { columns: ['x'], jsonFields: [], blankToNull: [] };
  assert.equal(bindValue(other, 'x', ''), '', 'a column outside the list was rewritten');
  assert.equal(bindValue({ columns: ['x'], jsonFields: [] }, 'x', ''), '', 'the rule is not opt-in');

  // And the JSON fields still stringify, since both branches now go through one
  // helper and an early return would have skipped this.
  const filesConfig = { columns: ['files'], jsonFields: ['files'] };
  assert.equal(bindValue(filesConfig, 'files', []), '[]', 'a JSON field is no longer stringified');
  assert.equal(bindValue(filesConfig, 'files', [{ name: 'a.pdf' }]), '[{"name":"a.pdf"}]');

  // A JSON field that is `null` keeps the behaviour it already had: the original
  // branch tested `typeof value === 'object'`, which is true for null, so the
  // column receives the four-character text `null`. That reads back as null
  // through `mapRow`'s JSON.parse, so it is harmless — and changing it here
  // would alter every resource that has a jsonField. Pinned so this refactor is
  // provably behaviour-preserving rather than assumed to be.
  assert.equal(bindValue(filesConfig, 'files', null), 'null', 'the jsonField branch changed behaviour');

  // Both write paths have to use it, or a create is normalized and an edit is
  // not — the same field, two behaviours.
  const BASE = read('backend/src/controllers/baseController.js');
  const uses = (BASE.match(/bindValue\(config, col, data\[col\]\)/g) || []).length;
  assert.equal(uses, 2, `bindValue is used ${uses} times, not 2 (create and update)`);
  assert.doesNotMatch(
    BASE,
    /values\.push\(data\[col\]\)/,
    'a write path still binds the raw value',
  );
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

  // And the null that comes back must not reach a controlled input. The
  // parameter is the wire shape, which is where the null legitimately exists.
  assert.match(
    EDUCATION,
    /function normalizeStudent\(s: EducationRecordWire\): Student \{/,
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

// ── The API enforces the same rule ──────────────────────────────────────────

test('the API refuses a school placement with no school or enrolment date', () => {
  // The frontend is not the only caller. Relaxing the two columns to NULL would
  // otherwise let a direct API call store a record that says "High School" while
  // naming no school — the exact inconsistency the form's check prevents.
  const { requireEducationPlacement } = require('../src/middleware/validation');

  const drive = (body) => {
    let error = null;
    let passed = false;
    requireEducationPlacement({ body }, {}, (e) => {
      if (e) error = e;
      else passed = true;
    });
    return { error, passed };
  };

  const SCHOOL_PLACEMENTS = [
    'High School',
    'Senior High School',
    'Alternative Learning System (ALS)',
    'ALS Elementary',
    'ALS Junior High School',
    'ALS Senior High School',
    'Calamba Manpower Development Center (CMDC)',
  ];

  for (const level of SCHOOL_PLACEMENTS) {
    const { error } = drive({ educationLevel: level, school: '', enrollmentDate: '' });
    assert.ok(error, `${level} was accepted with no school and no enrolment date`);
    assert.equal(error.statusCode, 400, `${level} was refused with ${error.statusCode}, not 400`);
    assert.match(error.message, /needs a school and an enrolment date/, 'the message does not say what is missing');
    assert.match(error.message, /missing: school, enrollmentDate/, 'the message does not name both missing fields');
  }

  // Half the pair is not enough — each field is checked on its own.
  const noDate = drive({ educationLevel: 'High School', school: 'LPU Laguna', enrollmentDate: '' });
  assert.equal(noDate.error && noDate.error.statusCode, 400, 'a school placement with no date was accepted');
  assert.match(noDate.error.message, /missing: enrollmentDate/);

  const noSchool = drive({ educationLevel: 'High School', school: '   ', enrollmentDate: '2026-06-01' });
  assert.equal(noSchool.error && noSchool.error.statusCode, 400, 'a school placement with a blank school was accepted');
  assert.match(noSchool.error.message, /missing: school/);

  // The not-enrolled level is the whole point: accepted with neither.
  assert.ok(
    drive({ educationLevel: 'Tutorial', school: '', enrollmentDate: null }).passed,
    'Tutorial is still refused, so a not-enrolled learner still cannot be recorded',
  );

  // A complete school placement is untouched.
  assert.ok(drive({ educationLevel: 'High School', school: 'LPU Laguna', enrollmentDate: '2026-06-01' }).passed);

  // A body that never mentions the level is left alone: the file-upload path
  // sends only `files`, and a partial update cannot be judged from one field.
  assert.ok(drive({ files: [] }).passed, 'a file-only update was refused');
  assert.ok(drive({}).passed, 'an empty body was refused');
});

test('the API and the form agree on which levels are not a school placement', () => {
  // Two runtimes, one rule. A level added to the form's predicate but not to the
  // middleware (or the reverse) means one side accepts what the other refuses.
  const validation = read('backend/src/middleware/validation.js');

  const list = validation.match(/const NOT_ENROLLED_EDUCATION_LEVELS = \[([^\]]*)\];/);
  assert.ok(list, 'the middleware has no not-enrolled level list');
  const levels = list[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);

  assert.deepEqual(levels, ['Tutorial'], `the middleware treats ${levels.join(', ')} as not enrolled`);

  // And the frontend's predicate names the same value.
  const predicate = EDUCATION.match(/const isNotEnrolled = \(level: EducationLevel\): boolean => level === '([^']+)';/);
  assert.ok(predicate, 'the form has no isNotEnrolled predicate');
  assert.deepEqual([predicate[1]], levels, 'the form and the API disagree about which level means "not enrolled"');
});
