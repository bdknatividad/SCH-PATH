/**
 * Form 08 takes two verifications, not one.
 *
 * The Incident Report is filed by a Social Worker and reviewed by the
 * Psychological Staff, and the specification requires both to sign it off: the
 * Psychological Staff signs the clinical side — and with it the intervention and
 * its schedule — and the Social Worker counter-signs.
 *
 * What shipped was a single call that set `status = 'Verified'`, so whichever
 * role reached the endpoint first completed the form and the second signatory was
 * never asked. The endpoint also had no caller in the SPA at all, so in practice
 * the form was approved through the document workflow and the verification columns
 * were never written.
 *
 * The rule now: `POST /incident-reports/:id/verify` records exactly one side per
 * call, refuses a second signature from a side that has already signed, and only
 * moves the report to 'Verified' when both sides are present.
 *
 * Two consequences this file pins, because both are easy to lose:
 *
 *   - The Social Worker's counter-signature must not overwrite the intervention
 *     the Psychological Staff prescribed. Only the clinical side writes it.
 *   - A resubmission has to clear both stamps. Without that, the "a side signs
 *     once" guard would fire on the second cycle and the report could never be
 *     verified again.
 *
 * A Houseparent holds `Violations:view` alone, which is what keeps them out of
 * verification on the API and in the UI — that is asserted here from the RBAC
 * definition rather than from a role name list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const CONTROLLER_SRC = read('backend/src/controllers/incidentReportController.js');
const DOC_CONTROLLER_SRC = read('backend/src/controllers/documentController.js');
const ROUTES_SRC = read('backend/src/routes/incidentReportRoutes.js');
const SCHEMA = read('backend/src/database/schema.sql');
const SERVER = read('backend/src/server.js');
const MIGRATION = read('backend/src/database/migrate_incident_reports.sql');
const MODAL_SRC = read('frontend/src/app/components/IncidentReportModal.tsx');

// ── Stubs ───────────────────────────────────────────────────────────────────

let reportRow = null;
const writes = [];

async function poolQuery(sql, params) {
  const text = String(sql);
  if (/^\s*UPDATE incidentReports/i.test(text)) {
    writes.push({ sql: text, params });
    // Apply the write so the controller's read-back is realistic — the handler
    // re-reads the row and returns it, and a stub that ignored the update would
    // report the pre-signature status back to the caller.
    const [signer, interventionType, interventionScheduleDate, status, verifiedBy, verifiedAt] = params;
    reportRow = {
      ...reportRow,
      interventionType, interventionScheduleDate, status, verifiedBy, verifiedAt,
      ...(/psychVerifiedBy = \?/.test(text)
        ? { psychVerifiedBy: signer }
        : { swVerifiedBy: signer }),
    };
    return [{ affectedRows: 1 }];
  }
  if (/FROM incidentReports WHERE id = \?/i.test(text)) {
    return [[reportRow]];
  }
  return [[], []];
}

const pool = { query: poolQuery };

const notices = [];
const notificationStub = {
  residentName: async () => 'Resident One',
  notify: async (payload) => { notices.push(payload); },
  notifyUsers: async (ids, payload) => { notices.push({ ...payload, userIds: ids }); },
  houseparentsOf: async () => [],
  markRelatedRead: async () => {},
  userIdForUsername: async () => null,
  usersWithAnyRole: async () => [],
};

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub('../src/config/database', { pool, dbConfig: {}, testConnection: async () => true });
stub('../src/services/notificationService', notificationStub);
stub('../src/controllers/assignmentController', { canAccessResident: async () => true });

const incidentReportController = require('../src/controllers/incidentReportController');

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

/** Run verify() and return `{ body, error }` — the error is the ApiError, not a 500. */
async function verify(user, body = {}, id = 'INC1') {
  writes.length = 0;
  notices.length = 0;
  const res = makeRes();
  let captured = null;
  await incidentReportController.verify({ params: { id }, user, body }, res, (error) => { captured = error; });
  return { body: res.body, error: captured, writes: [...writes], notices: [...notices] };
}

const PSYCH = { id: 'U-PSY', username: 'francis', role: 'psychologist' };
const SW = { id: 'U-SW', username: 'joyce', role: 'socialworker' };
const HOUSE_PARENT = { id: 'U-HP', username: 'hp1', role: 'houseparent' };
const CENTER_HEAD = { id: 'U-CH', username: 'centerhead', role: 'centerhead' };

const baseReport = (overrides = {}) => ({
  id: 'INC1', violationId: 'VIO1', residentId: 'CH001',
  reportTypes: '["Stealing"]', incidentDateTime: '2026-09-01 10:00:00',
  status: 'Submitted', interventionType: null, interventionScheduleDate: null,
  verifiedBy: null, verifiedAt: null,
  psychVerifiedBy: null, psychVerifiedAt: null,
  swVerifiedBy: null, swVerifiedAt: null,
  ...overrides,
});

const updateWrite = (writes_) => writes_.find((w) => /UPDATE incidentReports/i.test(w.sql));

// ── Which side a caller signs ───────────────────────────────────────────────

test('each role signs its own side, and only its own', () => {
  assert.equal(incidentReportController.resolveVerificationSide(PSYCH), 'psych');
  assert.equal(incidentReportController.resolveVerificationSide(SW), 'sw');

  // A Social Worker cannot counter-sign on the Psychological Staff's behalf, or
  // the two signatures would be one person's.
  assert.throws(
    () => incidentReportController.resolveVerificationSide(SW, 'psych'),
    (error) => error.statusCode === 403,
    'a Social Worker was allowed to sign the Psychological Staff verification',
  );
  assert.throws(
    () => incidentReportController.resolveVerificationSide(PSYCH, 'sw'),
    (error) => error.statusCode === 403,
  );
});

test('a full-access account signs one side at a time, and must say which', () => {
  // Otherwise a single Center Head account could complete the form alone.
  assert.throws(
    () => incidentReportController.resolveVerificationSide(CENTER_HEAD),
    (error) => error.statusCode === 400,
    'a full-access account verified without naming a side, so it filled both slots',
  );
  assert.equal(incidentReportController.resolveVerificationSide(CENTER_HEAD, 'psych'), 'psych');
  assert.equal(incidentReportController.resolveVerificationSide(CENTER_HEAD, 'sw'), 'sw');
  assert.throws(
    () => incidentReportController.resolveVerificationSide(CENTER_HEAD, 'both'),
    (error) => error.statusCode === 400,
  );
});

test('a role without the capability is refused, and a Houseparent is one', () => {
  assert.throws(
    () => incidentReportController.resolveVerificationSide(HOUSE_PARENT),
    (error) => error.statusCode === 403,
    'a Houseparent was allowed to verify an Incident Report',
  );
  // The refusal is the capability, not a name list: the definition gives the
  // Houseparent `view` and `create` on Violations — enough to read the list and
  // log an incident, never to verify one — and the route's requirePermission
  // reads the same thing.
  const definition = JSON.parse(read('backend/src/config/rbac.definition.json'));
  assert.ok(
    !definition.roles.houseparent.permissions.Violations.includes('verify'),
    'the Houseparent gained Violations:verify, so it could sign off its own incident report',
  );
  for (const role of ['psychologist', 'socialworker']) {
    assert.ok(
      definition.roles[role].permissions.Violations.includes('verify'),
      `${role} no longer holds Violations:verify, so their signature is unreachable`,
    );
  }
});

// ── One signature is not a verification ─────────────────────────────────────

test('one signature records its own side and leaves the report unverified', async () => {
  reportRow = baseReport();
  const { error, body, writes: w } = await verify(SW);
  assert.equal(error, null, `verify failed: ${error && error.message}`);

  const update = updateWrite(w);
  assert.ok(update, 'nothing was written');
  assert.match(update.sql, /swVerifiedBy = \?, swVerifiedAt = NOW\(\)/, 'the Social Worker side was not stamped');
  assert.equal(update.params[0], 'joyce');

  // status stays where it was; the report is NOT approved on one signature.
  assert.equal(update.params[3], 'Submitted', 'a single signature approved the report');
  assert.equal(update.params[4], null, 'verifiedBy was stamped before both sides signed');
  assert.equal(body.data.status, 'Submitted');
});

test('the second signature completes the report', async () => {
  reportRow = baseReport({ swVerifiedBy: 'joyce', swVerifiedAt: '2026-09-02 09:00:00' });
  const { error, body, writes: w } = await verify(PSYCH, { interventionType: 'Psychosocial Activity' });
  assert.equal(error, null, `verify failed: ${error && error.message}`);

  const update = updateWrite(w);
  assert.match(update.sql, /psychVerifiedBy = \?, psychVerifiedAt = NOW\(\)/);
  assert.equal(update.params[3], 'Verified', 'both sides had signed but the report was not approved');
  assert.equal(update.params[4], 'francis', 'verifiedBy does not record who completed the pair');
  assert.ok(update.params[5], 'verifiedAt was left empty on the completing signature');
  assert.equal(body.data.status, 'Verified');
});

test('the reverse order completes it too', async () => {
  // The Social Worker files the form, so in practice they sign first — but the
  // rule must not depend on which side happens to go first.
  reportRow = baseReport({ psychVerifiedBy: 'francis', psychVerifiedAt: '2026-09-02 09:00:00' });
  const { error, writes: w } = await verify(SW);
  assert.equal(error, null, `verify failed: ${error && error.message}`);
  assert.equal(updateWrite(w).params[3], 'Verified', 'the Social Worker signature did not complete the pair');
});

test('a side signs once', async () => {
  reportRow = baseReport({ swVerifiedBy: 'joyce', swVerifiedAt: '2026-09-02 09:00:00' });
  const { error, writes: w } = await verify(SW);
  assert.ok(error, 'the same side signed twice');
  assert.equal(error.statusCode, 409);
  assert.equal(updateWrite(w), undefined, 'a duplicate signature was written anyway');
});

test('an already-verified report is left alone', async () => {
  reportRow = baseReport({ status: 'Verified', psychVerifiedBy: 'francis', swVerifiedBy: 'joyce' });
  const { error, body, writes: w } = await verify(PSYCH);
  assert.equal(error, null);
  assert.equal(updateWrite(w), undefined, 'an already-verified report was re-written');
  assert.equal(body.data.status, 'Verified');
});

test('the counter-signature does not overwrite the prescribed intervention', async () => {
  // The intervention and its schedule are the clinical decision. A Social Worker
  // signing afterwards must not blank them.
  reportRow = baseReport({
    psychVerifiedBy: 'francis', psychVerifiedAt: '2026-09-02 09:00:00',
    interventionType: 'Psychosocial Activity', interventionScheduleDate: '2026-09-10 09:00:00',
  });
  const { error, writes: w } = await verify(SW, { interventionType: 'Something Else', interventionScheduleDate: '2030-01-01T09:00' });
  assert.equal(error, null, `verify failed: ${error && error.message}`);

  const update = updateWrite(w);
  assert.equal(update.params[1], 'Psychosocial Activity', 'the Social Worker signature replaced the intervention');
  assert.equal(update.params[2], '2026-09-10 09:00:00', 'the Social Worker signature replaced the schedule');
});

test('the clinical signature does write the intervention', async () => {
  reportRow = baseReport({ swVerifiedBy: 'joyce', swVerifiedAt: '2026-09-02 09:00:00' });
  const { error, writes: w } = await verify(PSYCH, {
    interventionType: 'Dialogue / Counseling',
    interventionScheduleDate: '2026-09-20T14:30',
  });
  assert.equal(error, null, `verify failed: ${error && error.message}`);
  const update = updateWrite(w);
  assert.equal(update.params[1], 'Dialogue / Counseling');
  assert.equal(update.params[2], '2026-09-20 14:30', 'the schedule was not normalised for MySQL');
});

// ── The other signatory is asked ────────────────────────────────────────────

test('the first signature asks the other side to sign', async () => {
  reportRow = baseReport();
  const { notices: n } = await verify(SW);
  const waiting = n.find((payload) => /needs your verification/i.test(String(payload.title || '')));
  assert.ok(waiting, 'nobody was asked for the second signature');
  assert.equal(waiting.targetRole, 'psychologist', 'the Social Worker signature asked the wrong side');

  reportRow = baseReport();
  const { notices: psychNotices } = await verify(PSYCH);
  const waitingOnSw = psychNotices.find((payload) => /needs your verification/i.test(String(payload.title || '')));
  assert.ok(waitingOnSw, 'nobody was asked for the second signature');
  assert.equal(waitingOnSw.targetRole, 'socialworker', 'the Psychological Staff signature asked the wrong side');
});

test('the completing signature notifies the people who carry out the intervention', async () => {
  reportRow = baseReport({ swVerifiedBy: 'joyce', swVerifiedAt: '2026-09-02 09:00:00' });
  const { notices: n } = await verify(PSYCH, { interventionType: 'Psychosocial Activity' });
  assert.ok(
    n.some((payload) => /Incident Report Verified/i.test(String(payload.title || ''))),
    'the people who carry out the intervention were never told it was approved',
  );
});

// ── Schema, route and UI ────────────────────────────────────────────────────

test('both stamp pairs exist wherever incidentReports is declared', () => {
  const columns = ['psychVerifiedBy', 'psychVerifiedAt', 'swVerifiedBy', 'swVerifiedAt'];
  for (const [label, source] of [
    ['the reference schema', SCHEMA],
    ['the boot migration', SERVER],
    ['the reference migration', MIGRATION],
  ]) {
    for (const column of columns) {
      assert.ok(
        source.includes(column),
        `${label} does not declare incidentReports.${column}, so a deployed database could not record a signature`,
      );
    }
  }
  // The boot path has to add them to a database that already exists, not only to
  // a fresh one.
  assert.match(
    SERVER,
    /ensureColumn\('incidentReports', 'swVerifiedAt'/,
    'an existing database would never gain the second stamp pair',
  );
});

test('a resubmission clears both stamp pairs', () => {
  // Otherwise the "a side signs once" guard fires on the second cycle and the
  // report can never be verified again.
  const resubmit = CONTROLLER_SRC.slice(
    CONTROLLER_SRC.indexOf('SET reportTypes = ?'),
    CONTROLLER_SRC.indexOf('WHERE id = ?', CONTROLLER_SRC.indexOf('SET reportTypes = ?')),
  );
  for (const column of ['psychVerifiedBy', 'psychVerifiedAt', 'swVerifiedBy', 'swVerifiedAt']) {
    assert.match(resubmit, new RegExp(`${column} = NULL`), `resubmit does not clear ${column}`);
  }

  const documentResubmit = DOC_CONTROLLER_SRC.slice(
    DOC_CONTROLLER_SRC.indexOf("UPDATE incidentReports\n              SET status = 'Submitted'"),
    DOC_CONTROLLER_SRC.indexOf('WHERE pdfDocumentId = ?', DOC_CONTROLLER_SRC.indexOf("UPDATE incidentReports\n              SET status = 'Submitted'")),
  );
  assert.ok(documentResubmit.length > 0, 'the document resubmission path was not located');
  for (const column of ['psychVerifiedBy', 'psychVerifiedAt', 'swVerifiedBy', 'swVerifiedAt']) {
    assert.match(
      documentResubmit,
      new RegExp(`${column} = NULL`),
      `the document resubmission path does not clear ${column}`,
    );
  }
});

test('the Social Worker reaches the verify route and the Houseparent does not', () => {
  const route = ROUTES_SRC.slice(
    ROUTES_SRC.indexOf("'/:id/verify'"),
    ROUTES_SRC.indexOf('incidentReportController.verify'),
  );
  assert.ok(route.length > 0, 'the verify route was not located');
  assert.match(route, /authorize\('psychologist', 'socialworker', 'centerhead'\)/, 'the Social Worker cannot sign the form');
  assert.match(route, /requirePermission\('Violations', 'verify'\)/, 'the verify route lost its capability gate');
  assert.doesNotMatch(route, /houseparent/, 'a Houseparent was authorized on the verify route');
});

test('the verification surface is gated on the same capability as the route', () => {
  assert.match(
    MODAL_SRC,
    /const canVerifyIncidentReport = can\('Violations', 'verify'\)/,
    'the modal does not read the capability the route checks',
  );
  assert.match(MODAL_SRC, /if \(!canVerify\) return null;/, 'the panel renders for a role without the capability');
  // The two slots have to be the two sides, keyed to the columns the API writes.
  for (const column of ['psychVerifiedBy', 'psychVerifiedAt', 'swVerifiedBy', 'swVerifiedAt']) {
    assert.ok(MODAL_SRC.includes(column), `the panel does not read ${column}`);
  }
});
