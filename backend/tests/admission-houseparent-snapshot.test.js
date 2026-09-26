/**
 * Item 1 — the Admission Slip's "Houseparent on Duty".
 *
 * The requirement, as the user restated it:
 *
 *   1. it refers to the Houseparent on duty *at that admission*, and
 *   2. it must not follow the resident when they are later assigned to a
 *      different Houseparent.
 *
 * (2) is a property of the write paths, so it is pinned structurally: the only
 * writers of `admissions.houseparentOnDuty` are the admission controller's
 * create/update and this file's re-admission INSERT, and the assignment
 * controller — which is what a reassignment goes through — never touches
 * `admissions` at all. The direction is slip -> assignment, never the reverse.
 *
 * (1) is behavioural for the re-admission path, because that is where it was
 * broken: the INSERT read `child.houseparentOnDuty`, and `children` has no such
 * column, so a re-admitted resident's slip always printed "Unspecified" and
 * stored no `houseparentUserId` — losing the caseload link the superseded
 * admission still had. The resolver is exercised directly with a fake executor
 * that dispatches on the SQL text.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const childController = require('../src/controllers/childController');

const SRC = (...parts) => path.resolve(__dirname, '..', ...parts);
const read = (...parts) => fs.readFileSync(SRC(...parts), 'utf8');

const assignmentSrc = read('src', 'controllers', 'assignmentController.js');
const childSrc = read('src', 'controllers', 'childController.js');
const childDetailTsx = read('..', 'frontend', 'src', 'app', 'components', 'ChildDetail.tsx');
const childRecordsTsx = read('..', 'frontend', 'src', 'app', 'components', 'ChildRecords.tsx');

/** Collapse whitespace so a pin does not depend on how a call was wrapped. */
const flatten = (text) => text.replace(/\s+/g, ' ');

/**
 * Strip comments before asserting on *code*.
 *
 * The resolver's own docblock explains the bug by naming the dead column, so a
 * bare `doesNotMatch` over the file would fail on the explanation rather than on
 * the code. Assertions about what the code does must not be satisfiable — or
 * broken — by prose.
 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

/**
 * A fake executor that answers by SQL text.
 *
 * The first query is always the `users` column probe; after that it answers the
 * assignment lookup. Returning `assignments` from a mutable closure lets each
 * test choose the state without a second stub.
 */
function fakeExecutor({ usersColumns = ['id', 'username', 'displayName'], assignments = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/INFORMATION_SCHEMA\.COLUMNS/i.test(text)) {
        return [usersColumns.map((COLUMN_NAME) => ({ COLUMN_NAME }))];
      }
      if (/FROM residentAssignments/i.test(text)) return [assignments];
      throw new Error(`unexpected query: ${text.slice(0, 120)}`);
    },
  };
}

test('the resolver picks the resident\'s current active Houseparent, name and id', async () => {
  const executor = fakeExecutor({
    assignments: [{ userId: 'UHP03', label: 'HP 3' }],
  });
  const result = await childController.resolveAdmissionHouseparent(executor, 'CH001', {
    houseparentOnDuty: 'Nanay Jen',
    houseparentUserId: 'UHP01',
  });

  assert.deepEqual(result, { userId: 'UHP03', label: 'HP 3' });

  // The lookup must be restricted to an *active* `houseparent` row. `household`
  // rows are the seed's whole-facility placeholder — one per Houseparent per
  // resident — so matching them would snapshot an arbitrary Houseparent.
  const lookup = executor.calls.find((c) => /FROM residentAssignments/i.test(c.sql));
  assert.ok(lookup, 'expected an assignment lookup');
  assert.match(flatten(lookup.sql), /ra\.status = 'Active'/);
  assert.match(flatten(lookup.sql), /LOWER\(TRIM\(ra\.assignmentType\)\) = 'houseparent'/);
  assert.deepEqual(lookup.params, ['CH001']);
});

test('the resolver falls back to the admission it supersedes when nobody is assigned', async () => {
  const executor = fakeExecutor({ assignments: [] });
  const result = await childController.resolveAdmissionHouseparent(executor, 'CH001', {
    houseparentOnDuty: 'Nanay Jen',
    houseparentUserId: 'UHP01',
  });

  assert.deepEqual(result, { userId: 'UHP01', label: 'Nanay Jen' });
});

test('the resolver carries an id even when the previous admission had only a name', async () => {
  // A row admitted before `houseparentUserId` existed: the name is all there is.
  // It must still be carried rather than dropped, or the caseload link is lost.
  const executor = fakeExecutor({ assignments: [] });
  const result = await childController.resolveAdmissionHouseparent(executor, 'CH001', {
    houseparentOnDuty: 'Nanay Jen',
    houseparentUserId: null,
  });

  assert.deepEqual(result, { userId: null, label: 'Nanay Jen' });
});

test('the resolver refuses to invent a Houseparent when there is nothing to snapshot', async () => {
  // `admissions.houseparentOnDuty` is NOT NULL, so a last resort is required —
  // but it must be an honest blank, never a guess at whoever holds the resident.
  const executor = fakeExecutor({ assignments: [] });
  const result = await childController.resolveAdmissionHouseparent(executor, 'CH001', null);

  assert.deepEqual(result, { userId: null, label: 'Unspecified' });
});

test('the resolver still works on a database without users.displayName', async () => {
  // The column arrives by boot migration, so an older database may lack it.
  // `assignmentController` guards for the same thing; the label expression must
  // degrade to the username rather than failing the re-admission.
  const executor = fakeExecutor({
    usersColumns: ['id', 'username'],
    assignments: [{ userId: 'UHP03', label: 'hp3' }],
  });
  const result = await childController.resolveAdmissionHouseparent(executor, 'CH001', null);

  assert.deepEqual(result, { userId: 'UHP03', label: 'hp3' });
  const lookup = executor.calls.find((c) => /FROM residentAssignments/i.test(c.sql));
  assert.doesNotMatch(flatten(lookup.sql), /displayName/);
});

test('the re-admission INSERT stores both the printed name and the id', () => {
  // The bug: the INSERT omitted `houseparentUserId` entirely and read a column
  // that does not exist, so the new admission lost the link its predecessor had.
  //
  // These assertions run over the whole (comment-stripped) file rather than over
  // the matched INSERT text. Scoping them to the INSERT made the dead-read check
  // vacuous: the offending expression is a *value*, which sits in the array after
  // the SQL template, outside anything the INSERT regex matches — so restoring
  // the original bug passed all ten tests.
  const code = flatten(stripComments(childSrc));

  assert.match(code, /INSERT INTO admissions \( id, residentId, admissionNumber,/, 'expected the re-admission INSERT');
  assert.match(code, /houseparentOnDuty, houseparentUserId,/, 'the INSERT must write the id beside the name');
  assert.match(code, /houseparent\.label, houseparent\.userId,/, 'the INSERT values must be the resolver output');
  assert.doesNotMatch(code, /child\.houseparentOnDuty/, 'children has no houseparentOnDuty column');
  assert.match(
    code,
    /const houseparent = await resolveAdmissionHouseparent\(pool, id, previousAdmission\)/,
    'the INSERT values must come from the resolver'
  );
});

test('children has no houseparentOnDuty column, which is why the old read was dead', () => {
  // Anti-vacuity for the assertion above: if the column were ever added, the
  // "dead read" reasoning would no longer hold and this file should be revisited.
  const schema = read('src', 'database', 'schema.sql');
  const table = schema.match(/CREATE TABLE children \(([\s\S]*?)\) ENGINE/);
  assert.ok(table, 'expected CREATE TABLE children in schema.sql');
  assert.doesNotMatch(table[1], /houseparentOnDuty/, 'children gained a houseparentOnDuty column — revisit this test');
});

test('a reassignment cannot reach the Admission Slip', () => {
  // This is requirement (2). `assignmentController` is the only path a
  // reassignment takes, and it must not write the admission at all.
  assert.doesNotMatch(assignmentSrc, /UPDATE\s+admissions/i, 'assignmentController must not UPDATE admissions');
  assert.doesNotMatch(assignmentSrc, /INSERT\s+INTO\s+admissions/i, 'assignmentController must not INSERT into admissions');

  // ...and its writes must all be to the assignment table.
  const writes = [...assignmentSrc.matchAll(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/gi)].map((m) => m[1]);
  assert.ok(writes.length > 0, 'expected assignmentController to contain writes');
  for (const table of writes) {
    assert.equal(table, 'residentAssignments', `assignmentController writes to ${table}`);
  }
});

test('both slip renderers print the admission row\'s own value', () => {
  // If either renderer derived the name from the current assignment instead, the
  // slip would follow a reassignment no matter what the write paths do.
  for (const [label, src, call] of [
    ['ChildDetail.tsx', childDetailTsx, /drawText\(\s*admission\.houseparentOnDuty/],
    ['ChildRecords.tsx', childRecordsTsx, /drawText\(\s*admission\.houseparentOnDuty/],
  ]) {
    assert.match(src, call, `${label} must draw admission.houseparentOnDuty`);
  }
});

test('the edit form takes the Houseparent from the admission, never the assignment', () => {
  // `source` is the latest *admission* row. The Case Load Manager
  // (residentAssignments) is a separate field, so restoring the slip from it
  // would make the HP on Duty follow a later reassignment — the exact thing the
  // snapshot exists to prevent. The fallback was removed deliberately; it is
  // pinned as an absence so it cannot come back in one line.
  const flat = flatten(childRecordsTsx);
  assert.match(
    flat,
    /const source = latest \|\| selectedChild/,
    'the edit form must read from the latest admission first'
  );
  assert.match(
    flat,
    /houseparentOnDuty: source\.houseparentOnDuty \|\| ''/,
    'the stored name must be restored from the admission alone'
  );
  assert.match(
    flat,
    /assignedHouseparentId: source\.houseparentUserId \|\| ''/,
    'the stored id must be restored from the admission alone'
  );
  // The two matches above are exact: `... || ''` has to be the end of the
  // expression, so a reintroduced `|| assignment?.userId || ''` would fail them
  // rather than slip through. The name fallback was `assignment?.userLabel`,
  // which appears nowhere else in the file, so its absence is safe to pin too.
  assert.doesNotMatch(
    flat,
    /assignment\?\.userLabel/,
    'the edit form falls back to the current Case Load assignment for the HP on Duty name'
  );
});
