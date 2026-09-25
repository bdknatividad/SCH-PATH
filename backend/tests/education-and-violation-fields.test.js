/**
 * The four remaining production-audit items: a body part on a body-marking
 * violation, a planned school visit, the scope of the Quarterly Education
 * Report, and the one-month Case Load Manager warning.
 *
 * All four are additions to records that already existed, so the part worth
 * pinning is what each must NOT change:
 *
 *   - `violations.bodyLocation` belongs to one violation type. Every other type
 *     must send null, or a value left over from a previous selection would be
 *     filed against a violation it does not describe.
 *
 *   - `education_school_visits.status` defaults to 'Completed', which is what
 *     every existing row already is. A scheduled visit must not be counted as a
 *     school visit and must not be copied into the resident's Documents: there
 *     is no report yet, and that Documents copy is what the Child Record counts
 *     as education progress.
 *
 *   - The Quarterly Education Report is scoped for the `educator` role only, and
 *     it fails OPEN. A learner whose record carries no `createdBy` stays visible
 *     to every educator, so scoping can never empty an educator's list.
 *
 *   - The one-month warning is advisory and reads the caseload endpoint's own
 *     answer for who is assigned, so it cannot disagree with the cards beside it.
 *     Two residents must never appear on it: a discharged resident, and one who
 *     already has a Case Load Manager.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { RESOURCES } = require('../src/utils/constants');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SERVER = read('backend/src/server.js');
const SCHEMA = read('backend/src/database/schema.sql');
const MIGRATE_EDUCATION = read('backend/src/database/migrate_education.sql');
const QPR_CONTROLLER = read('backend/src/controllers/quarterlyProgressReportController.js');
const VIOLATIONS_UI = read('frontend/src/app/components/Violations.tsx');
const EDUCATION_UI = read('frontend/src/app/components/Education.tsx');
const CASELOAD_UI = read('frontend/src/app/components/CaseLoad.tsx');

// ── Item 10: where on the body ───────────────────────────────────────────────

test('a violation can record where on the body it happened', () => {
  assert.ok(
    RESOURCES.violations.columns.includes('bodyLocation'),
    'bodyLocation must be in the violations column whitelist, or the controller drops it'
  );
  // The column has to exist on an already-deployed database, not only on a fresh
  // one, so it needs the CREATE TABLE *and* the boot migration.
  assert.match(SERVER, /bodyLocation VARCHAR\(100\) NULL/, 'server.js must create the column');
  assert.match(SERVER, /ensureColumn\('violations', 'bodyLocation'/, 'server.js must migrate the column');
  assert.match(SCHEMA, /bodyLocation VARCHAR\(100\) NULL/, 'schema.sql must carry the column');
});

test('the body-location dropdown appears only for a body-marking violation', () => {
  // Matched by keyword rather than by exact label: the violation type is
  // editable in Manage Violations & Interventions, and `triController` scores it
  // the same way.
  assert.match(VIOLATIONS_UI, /const isBodyMarkingViolation = \(label: string\) =>/);
  assert.match(VIOLATIONS_UI, /tattoo\|tattat\|piercing\|bulitas\|hikaw/);

  // Both places a violation is logged: the Log Incident dialog and the edit form.
  const gates = VIOLATIONS_UI.match(/\{isBodyMarkingViolation\(formData\.type\) && \(/g) || [];
  assert.equal(gates.length, 2, 'the dropdown must be gated in both the Log Incident dialog and the edit form');
});

test('only a body-marking violation ever sends a body part', () => {
  // Without the ternary, a part chosen for one violation would be carried into
  // the next one the same form is used for.
  assert.match(
    VIOLATIONS_UI,
    /bodyLocation: isBodyMarkingViolation\(formData\.type\) \? \(formData\.bodyLocation \|\| null\) : null,/,
    'the create payload must null the body part for every other violation type'
  );
  // And switching type away from a body-marking one clears what was chosen.
  const clears = VIOLATIONS_UI.match(/bodyLocation: isBodyMarkingViolation\(found\.label\) \? prev\.bodyLocation : '',/g) || [];
  assert.equal(clears.length, 2, 'both type selectors must clear the body part when the type changes');
});

// ── Item 31: a planned school visit ──────────────────────────────────────────

test('a school visit can be scheduled, and existing rows read as completed', () => {
  assert.ok(
    RESOURCES.education_school_visits.columns.includes('status'),
    'status must be in the school-visit column whitelist'
  );

  const definition = /status ENUM\('Scheduled','Completed'\) NOT NULL DEFAULT 'Completed'/;
  assert.match(SERVER, definition, 'server.js must create the column');
  assert.match(SCHEMA, definition, 'schema.sql must carry the column');
  assert.match(MIGRATE_EDUCATION, definition, 'the education migration must carry the column');
  assert.match(
    SERVER,
    /ensureColumn\('education_school_visits', 'status'/,
    'server.js must migrate the column onto an existing database'
  );

  // The default is what makes the migration safe: a row that predates the column
  // is a visit that happened.
  assert.match(SERVER, /DEFAULT 'Completed'/);
});

test('the quarterly report counts only visits that happened', () => {
  assert.match(
    QPR_CONTROLLER,
    /AND status = 'Completed' AND visitDate BETWEEN/,
    'a scheduled visit must not be printed as a visit that took place'
  );
});

test('a scheduled visit is not filed in the resident Documents', () => {
  // The Documents copy is what the Child Record counts as education progress, so
  // a plan must not produce one. The resident lookup is gated on the status, and
  // the copy sits behind that lookup.
  assert.match(
    EDUCATION_UI,
    /const resident = visitForm\.status === 'Completed'/,
    'the Documents copy must be gated on a completed visit'
  );
  // The visit record itself still carries the status.
  assert.match(EDUCATION_UI, /status: visitForm\.status,/, 'the saved visit must carry its status');
  // And the per-learner count excludes anything still scheduled.
  assert.match(
    EDUCATION_UI,
    /\(v\.status \?\? 'Completed'\) === 'Completed'/,
    'a scheduled visit must not be counted as a school visit'
  );
});

test('a scheduled visit can be marked completed', () => {
  assert.match(EDUCATION_UI, /const markVisitCompleted = async \(visit: SchoolVisitReport\) =>/);
  assert.match(
    EDUCATION_UI,
    /updateResource<any>\('education-school-visits', visit\.id, \{ status: 'Completed' \}\)/,
    'marking it complete must be persisted, not only shown'
  );
  // A failed write puts the row back rather than leaving a status the server
  // never accepted on screen.
  assert.match(EDUCATION_UI, /setVisitReports\(previous\);\s*\n\s*saveVisits\(previous\);/);
});

// ── Item 12: the Quarterly Education Report per role ─────────────────────────

test('the quarterly report is scoped to an educator own learners, and fails open', () => {
  assert.match(
    EDUCATION_UI,
    /const quarterlyLearnerPool = user\?\.role === 'educator'/,
    'only the educator role is scoped'
  );
  // Failing open matters more than the filter: a record with no `createdBy`
  // predates the rule, and hiding it from every educator would be worse than
  // showing it to the wrong one.
  assert.match(
    EDUCATION_UI,
    /\? students\.filter\(s => !s\.createdBy \|\| s\.createdBy === user\?\.username\)/,
    'a learner with no recorded creator must stay visible'
  );
  // The dropdown the report is filed from uses the pool, not the whole roll.
  assert.match(EDUCATION_UI, /\{quarterlyLearnerPool\.filter\(s => s\.status === 'Active'\)\.map\(s => \(/);
  // An empty pool explains itself rather than showing a blank list.
  assert.match(EDUCATION_UI, /No active learners are assigned to you\./);
});

// ── Item 2: a Case Load Manager within the first month ───────────────────────

test('the Case Load screen warns about residents a month without a manager', () => {
  assert.match(CASELOAD_UI, /const ONE_MONTH_MS = 30 \* 24 \* 60 \* 60 \* 1000;/);
  assert.match(CASELOAD_UI, /const unassignedOverMonth = useMemo\(/);

  // It reads who is assigned from the caseload endpoint's own answer, so the
  // warning cannot contradict the cards rendered beside it.
  assert.match(
    CASELOAD_UI,
    /const assignedResidentIds = useMemo\(\(\) => \{[\s\S]*?data\.forEach\(\(hp\) => \(hp\.residents \|\| \[\]\)\.forEach\(\(r\) => ids\.add\(String\(r\.id\)\)\)\);/,
    'the warning must take its assignments from the caseload payload'
  );

  // Advisory only, and only where someone can act on it: a Houseparent cannot
  // assign a case, so the banner is not shown to them.
  assert.match(CASELOAD_UI, /\{!isHouseparent && unassignedOverMonth\.length > 0 && \(/);

  // An unknown admission date cannot be "over a month", so it is left out rather
  // than guessed at.
  assert.match(CASELOAD_UI, /const admitted = c\.admissionDate \|\| c\.createdAt;/);
  assert.match(CASELOAD_UI, /return Number\.isFinite\(at\) && at <= cutoff;/);
});

test('the one-month warning excludes discharged and already-managed residents', () => {
  // Two ways a resident must NOT be chased, and both are silent if dropped:
  // the banner would simply name people it has no business naming.
  //
  //  - A discharged resident has no case left to manage.
  //  - A resident who already has a Case Load Manager is the entire point of the
  //    list; counting them would make the banner permanently wrong, and it would
  //    be wrong in the direction that matters — it would look like work is
  //    outstanding when it is not.
  assert.match(
    CASELOAD_UI,
    /if \(String\(c\.status \|\| ''\) === 'Discharged'\) return false;/,
    'a discharged resident must not be reported as missing a Case Load Manager'
  );
  assert.match(
    CASELOAD_UI,
    /if \(assignedResidentIds\.has\(String\(c\.id\)\)\) return false;/,
    'a resident who already has a Case Load Manager must not be reported'
  );
});

// ── The resident writes are gated at the route ───────────────────────────────
//
// `/children` is mounted with `authenticate` and nothing else, so POST / PUT /
// DELETE relied entirely on the checks inside `childController`. That works
// until a controller grows a second entry point, or the router is remounted
// somewhere without the controller — the module boundary belongs at the edge as
// well. The guards chosen are the ones that admit exactly the roles that could
// already write, so nothing that worked before is refused now.

const { requirePermission } = require('../src/middleware/rbac');
const { ApiError } = require('../src/middleware/errorHandler');

const CHILD_ROUTES = read('backend/src/routes/childRoutes.js');

function runMiddleware(middleware, user) {
  let outcome = { nexted: false, error: null };
  middleware({ user }, {}, (error) => {
    outcome = { nexted: !error, error: error || null };
  });
  return outcome;
}

test('the resident writes carry a route-level capability gate', () => {
  assert.match(
    CHILD_ROUTES,
    /router\.post\('\/', requirePermission\('Child Records', 'create'\)/,
    'POST /children must be gated at the route'
  );
  assert.match(
    CHILD_ROUTES,
    /router\.put\('\/:id', requirePermission\('Child Records', 'edit'\)/,
    'PUT /children/:id must be gated at the route'
  );
  assert.match(
    CHILD_ROUTES,
    /router\.delete\('\/:id', requirePermission\('Child Records', 'delete'\)/,
    'DELETE /children/:id must be gated at the route'
  );
});

test('the resident write gates admit exactly the roles that could write before', () => {
  const user = (role) => ({ id: 'U1', username: role, role });

  // Center Head holds full access, Admin is a wildcard, Social Worker holds
  // create/delete explicitly. These are the roles `isManager` admits.
  for (const role of ['centerhead', 'admin', 'socialworker']) {
    assert.equal(
      runMiddleware(requirePermission('Child Records', 'create'), user(role)).nexted,
      true,
      `${role} must still be able to create a resident`
    );
    assert.equal(
      runMiddleware(requirePermission('Child Records', 'delete'), user(role)).nexted,
      true,
      `${role} must still be able to delete a resident`
    );
  }

  // Everyone else is refused, and refused as a 403 rather than a 500.
  for (const role of ['psychologist', 'nurse', 'educator', 'houseparent']) {
    const created = runMiddleware(requirePermission('Child Records', 'create'), user(role));
    assert.equal(created.nexted, false, `${role} must not create a resident`);
    assert.ok(created.error instanceof ApiError, `${role} must be refused with an ApiError`);
    assert.equal(created.error.statusCode, 403);

    assert.equal(
      runMiddleware(requirePermission('Child Records', 'delete'), user(role)).nexted,
      false,
      `${role} must not delete a resident`
    );
  }
});
