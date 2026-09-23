/**
 * Non-finite numbers must never reach a bound query parameter.
 *
 * mysql2 escapes a `number` by emitting it verbatim, so `NaN` lands in the SQL
 * text as the bare token `NaN` and MySQL rejects the whole statement with
 * `Unknown column 'NaN' in 'field list'`. The user sees "Database error
 * occurred" for what is really a missing input, and nothing points at the field.
 *
 * This was live in `POST /api/admissions`: `Number(resident.age)` was bound
 * directly, so an admission submitted without an explicit age failed with that
 * opaque error. `normalizeAge()` derives the age from the birth date instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeAge, calculateAge } = require('../src/utils/helpers');

test('a supplied age is used as-is', () => {
  assert.equal(normalizeAge(14, '2012-04-05'), 14);
  assert.equal(normalizeAge('14', '2012-04-05'), 14);
  assert.equal(normalizeAge(14.7, '2012-04-05'), 14, 'a fractional age must be truncated');
});

test('a missing or unusable age falls back to the birth date', () => {
  const expected = calculateAge('2012-04-05');
  assert.ok(expected > 0, 'the fixture date must yield a real age');

  for (const missing of [undefined, null, '', 0, 'abc', NaN, -3, Infinity, -Infinity]) {
    assert.equal(normalizeAge(missing, '2012-04-05'), expected,
      `age ${JSON.stringify(missing)} should fall back to the birth date, never NaN`);
  }
});

test('the result is never NaN, Infinity or negative', () => {
  const inputs = [
    [undefined, undefined], [null, null], ['', ''], ['abc', 'not-a-date'],
    [NaN, '2012-04-05'], [Infinity, undefined], [-1, ''],
    [undefined, '2012-04-05'], [5, undefined], [5, null],
  ];

  for (const [age, birthDate] of inputs) {
    const result = normalizeAge(age, birthDate);
    assert.ok(
      result === null || (Number.isFinite(result) && result > 0),
      `normalizeAge(${JSON.stringify(age)}, ${JSON.stringify(birthDate)}) returned ${result}`,
    );
  }
});

test('an unusable birth date yields null rather than a NaN', () => {
  // calculateAge() does arithmetic on Invalid Date, which is NaN — binding that
  // is exactly the failure this helper exists to prevent.
  assert.ok(Number.isNaN(calculateAge('not-a-date')), 'fixture assumption: calculateAge yields NaN');
  assert.equal(normalizeAge(undefined, 'not-a-date'), null);
  assert.equal(normalizeAge(0, 'not-a-date'), null);
});

/**
 * The admission write binds the age in three places (children insert,
 * readmission update, admissions insert). A bare `Number(resident.age)` in any
 * of them reintroduces the opaque database error.
 */
test('the admission write never binds a raw Number(resident.age)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/controllers/admissionController.js'), 'utf8',
  );

  assert.ok(
    !source.includes('Number(resident.age)'),
    'admissionController binds Number(resident.age) directly — use normalizeAge()',
  );

  const wrapped = (source.match(/normalizeAge\(resident\.age, resident\.birthDate\)/g) || []).length;
  assert.equal(wrapped, 3, `expected all 3 age bindings to be normalized, found ${wrapped}`);

  // Anti-vacuity: the file must still contain the bindings being guarded.
  assert.ok(source.includes('resident.age'), 'the guard is no longer looking at the right field');
  assert.ok(source.includes('INSERT INTO admissions'), 'the guarded statement is missing');
});

test('a required date field is checked for validity, not just presence', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/controllers/admissionController.js'), 'utf8',
  );

  assert.ok(source.includes("requireValidDate(resident.birthDate, 'Date of birth')"),
    'the birth date must be validated as a real date, or calculateAge yields NaN');
  assert.ok(!source.includes("requireField(resident.birthDate, 'Date of birth')"),
    'requireField only proves non-emptiness; it cannot reject an unparseable date');

  // The helper itself must actually reject an invalid date.
  assert.ok(source.includes('Number.isNaN(new Date(value).getTime())'),
    'requireValidDate must test the parsed timestamp');
});

test('the NOT NULL caseHistory column is normalised to the form\'s empty string', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/controllers/admissionController.js'), 'utf8',
  );

  assert.ok(source.includes("const caseHistory = String(admission.caseHistory ?? '')"),
    'admissions.caseHistory is NOT NULL; an omitted field must not become a null binding');
  assert.ok(!/^\s+admission\.caseHistory,$/m.test(source),
    'a binding still passes admission.caseHistory straight through');
});
