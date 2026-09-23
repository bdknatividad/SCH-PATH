/**
 * Regression guards for violation points — the number the Urgency Level widget
 * is built on.
 *
 * `violations.points` is declared in the schema (`INT NOT NULL DEFAULT 0`) and
 * was summed in two places — the dashboard's "Urgency Level — Unresolved
 * Violations" widget and `childController.getMonthlyPerformanceRatings` — but
 * no writer ever set it: `buildInsertPayload` listed `points` among the columns
 * it skipped, and the review UPDATE never touched it. Every row therefore stored
 * 0, so every resident read "Very Good" no matter how many unresolved
 * violations they had. The defect type-checked, built, and was invisible without
 * reading the rendered dashboard against the database.
 *
 * These tests lock in the replacement: one derivation, applied on every path
 * that can change a violation's severity, plus a boot backfill for the rows that
 * were written while it was broken.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONTROLLER = path.resolve(__dirname, '../src/controllers/violationController.js');
const POINTS_UTIL = path.resolve(__dirname, '../src/utils/violationPoints.js');
const SERVER = path.resolve(__dirname, '../src/server.js');
const GUIDE_ROUTES = path.resolve(__dirname, '../src/routes/violationGuideRoutes.js');
const GUIDE_CONTROLLER = path.resolve(__dirname, '../src/controllers/violationGuideController.js');
const CHILD_CONTROLLER = path.resolve(__dirname, '../src/controllers/childController.js');

const read = (file) => fs.readFileSync(file, 'utf8');

const { pointsForSeverity } = require('../src/utils/violationPoints');
const { VIOLATION_SEVERITY, RESOURCES } = require('../src/utils/constants');

/* ================================================================
   THE DERIVATION
   ================================================================ */

test('points are derived from the severity the guide declares', () => {
  // The weights come from `VIOLATION_SEVERITY`, so a change there moves the
  // points with it rather than leaving a second copy behind.
  assert.equal(pointsForSeverity('Minor'), VIOLATION_SEVERITY.Minor.points);
  assert.equal(pointsForSeverity('Major'), VIOLATION_SEVERITY.Major.points);
  assert.equal(pointsForSeverity('Critical'), VIOLATION_SEVERITY.Critical.points);
});

test('the severity spelling does not decide the points', () => {
  // The guide's `category` column and the violations `severity` column have
  // never been normalized against each other, so the same weight arrives as
  // 'Minor', 'minor' and ' MINOR ' depending on which form wrote the row.
  assert.equal(pointsForSeverity('minor'), 1);
  assert.equal(pointsForSeverity('MAJOR'), 3);
  assert.equal(pointsForSeverity('  Critical  '), 5);
  assert.equal(pointsForSeverity('cRiTiCaL'), 5);
});

test('an unknown or missing severity weighs nothing rather than throwing', () => {
  // A row whose severity predates the current vocabulary must not abort the
  // insert or the review — it is worth 0 points, which is what it weighed
  // before this was fixed.
  for (const value of ['', null, undefined, 'Unknown', 'Severe', 0, {}]) {
    assert.equal(pointsForSeverity(value), 0, `${JSON.stringify(value)} must weigh 0`);
  }
});

/* ================================================================
   EVERY PATH THAT CAN CHANGE THE SEVERITY
   ================================================================ */

test('creating a violation stores the derived points', () => {
  const source = read(CONTROLLER);

  // `points` is in the column list, and its value comes from the derivation
  // rather than from the request body.
  assert.match(
    source,
    /if \(col === 'points'\) \{[\s\S]{0,200}pointsForSeverity\(canonicalSeverity\)/,
    'buildInsertPayload must derive points from the canonical severity',
  );
  assert.equal(
    /col === 'points'[\s\S]{0,80}continue;/.test(source),
    false,
    'points must no longer be skipped by the insert payload',
  );
});

test('reviewing a violation re-derives the points from the guide category', () => {
  const source = read(CONTROLLER);

  // The reviewer confirms or adjusts the severity. The points have to follow in
  // the same statement, or a re-graded violation keeps its old weight.
  assert.match(
    source,
    /UPDATE violations SET status = \?, actionTaken = \?, reviewedBy = \?, severity = \?, points = \?/,
    'the review UPDATE must write severity and points together',
  );
  assert.match(
    source,
    /pointsForSeverity\(guide\.category\)/,
    'the review UPDATE must derive points from the guide category it just wrote',
  );
});

test('editing a violation keeps the points in step with the severity', () => {
  const source = read(CONTROLLER);

  assert.match(
    source,
    /req\.body\.points = pointsForSeverity\(req\.body\.severity\)/,
    'the update wrapper must re-derive points whenever the severity changes',
  );
});

test('the request body can never set the points directly', () => {
  const source = read(CONTROLLER);

  // The client grades its own violation if it can name the points, so the only
  // value that may be assigned to `points` is the derivation. Anchored to the
  // right-hand side, so `points = pointsForSeverity(req.body.severity)` — where
  // the request supplies the *severity*, not the points — is not a match.
  assert.equal(
    /points\s*=\s*req\.(body|query|params)\b/.test(source),
    false,
    'points must never be assigned straight from the request',
  );
  assert.equal(
    /req\.body\.points\s*\?\?/.test(source),
    false,
    'points must not fall back to a request-supplied value',
  );
  // And the derivation is what is actually wired in.
  assert.match(source, /req\.body\.points = pointsForSeverity\(/, 'the update wrapper must derive points');
});

test('a resolved violation keeps its weight, so the sum is what changes', () => {
  // The dashboard sums `points` over rows whose status is not 'Resolved', and
  // the backend ratings do the same. Marking an intervention done must
  // therefore leave `points` alone — zeroing it would rewrite history and make
  // the two calculations disagree the moment a violation is reopened.
  const source = read(CONTROLLER);
  const markDone = source.slice(source.indexOf('async function markDone'));

  assert.ok(markDone, 'markDone was not found');
  assert.match(markDone, /status = 'Resolved'/, 'markDone must resolve the violation');
  assert.equal(
    /\bpoints\s*=/.test(markDone.slice(0, markDone.indexOf('async function', 10))),
    false,
    'markDone must not touch points',
  );
});

/* ================================================================
   THE DATA CONTRACT THE WIDGET READS
   ================================================================ */

test('the violations resource exposes points, so the dashboard can read them', () => {
  // The widget sums `v.points` from the store payload. A column that is written
  // but not serialized would leave the widget reading `undefined`, which the
  // `Number(...) || 0` fallback turns straight back into the original bug.
  assert.ok(
    RESOURCES.violations.columns.includes('points'),
    'RESOURCES.violations.columns must include points',
  );
});

test('the dashboard and the backend ratings count the same rows', () => {
  // The widget's rule is "unresolved", the backend's is "status <> 'Resolved'".
  // Both must exclude the same status, or the same resident reads differently
  // depending on which screen you open.
  const backend = read(CHILD_CONTROLLER);
  assert.match(
    backend,
    /status\s*<>\s*'Resolved'/,
    'getMonthlyPerformanceRatings must exclude resolved violations by status',
  );

  const widget = read(path.resolve(__dirname, '../../frontend/src/app/components/Dashboard.tsx'));
  assert.match(
    widget,
    /v\.status !== 'Resolved'/,
    'the dashboard urgency widget must exclude resolved violations by the same status',
  );
});

/* ================================================================
   THE BACKFILL
   ================================================================ */

test('an existing database has its stored points repaired on boot', () => {
  const server = read(SERVER);

  // Rows written while the derivation was missing hold 0. The backfill is
  // idempotent — it only touches rows that disagree with the current weights.
  assert.match(
    server,
    /UPDATE violations SET points = \$\{pointsCase\} WHERE points <> \$\{pointsCase\}/,
    'the boot migration must backfill points for rows that disagree',
  );
  assert.match(
    server,
    /CASE severity/,
    'the backfill must map each severity to its weight',
  );
  // A migration that can abort boot would take the whole API down with it.
  assert.match(
    server,
    /Migration warning \(violations points backfill\)/,
    'the backfill must be wrapped so a failure only warns',
  );
});

/* ================================================================
   THE ASSIGNED-SCHEDULE ENDPOINT
   ================================================================ */

test('the assigned-intervention schedule is one caseload-scoped query', () => {
  const controller = read(GUIDE_CONTROLLER);
  const start = controller.indexOf('async function getScheduledInterventions');
  assert.notEqual(start, -1, 'getScheduledInterventions was not found');

  // Bound the slice to this function, so a later query in the file cannot be
  // mistaken for one this endpoint issues.
  const tail = controller.slice(start);
  const nextFunction = tail.slice(1).search(/\nasync function |\nfunction /);
  const scheduled = nextFunction === -1 ? tail : tail.slice(0, nextFunction + 1);

  // Scoped, so a Houseparent sees their own caseload and nobody else's.
  assert.match(scheduled, /loadResidentScope\(req\.user\)/, 'the endpoint must apply the caseload scope');
  assert.match(scheduled, /it\.residentId IN \(/, 'the scope must narrow the query, not the response');
  // One query for the whole list — the dashboard must not fan out per resident.
  assert.match(scheduled, /FROM intervention_tracker it/, 'the schedule must come from intervention_tracker');
  assert.equal(
    (scheduled.match(/pool\.query\(/g) || []).length,
    1,
    'the schedule must be a single query',
  );
});

test('the assigned-schedule endpoint requires the Violations module', () => {
  const routes = read(GUIDE_ROUTES);

  // The router itself is not gated (the guide is a reference table the Child
  // Records page reads), so this one route carries its own gate.
  assert.match(
    routes,
    /'\/interventions\/scheduled',\s*requireModule\('Violations'\)/,
    'the schedule endpoint must require the Violations module',
  );
  // And it must be declared before `/:id`, or it would be captured as an id.
  assert.ok(
    routes.indexOf("'/interventions/scheduled'") < routes.indexOf("router.get('/:id'"),
    'the schedule route must be declared before /:id',
  );
});
