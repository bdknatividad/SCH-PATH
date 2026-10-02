/**
 * Form 08 carries three signatures, in two stages.
 *
 * The specification: the Houseparent files the report (as may the Social Worker,
 * the Psychological Support Staff and the Center Head); the Social Worker signs
 * "Checked by" (Francis C. Patricio, RSW); the Psychological Support Staff signs
 * the clinical line (Joyce Anne D.C. Tenorio) — and with it the intervention and
 * its schedule — and the Center Head signs "Noted by" (MARICOR C. NAVARRO, RSW)
 * LAST. The report is approved when all three have signed, and that approval is
 * what the Intervention Tracker's `Mark Done` waits for.
 *
 * `POST /incident-reports/:id/verify` is the one signing endpoint. Each call fills
 * exactly one line, with the drawn signature it sends:
 *
 *   - the side comes from the caller's role and cannot be chosen, so no account
 *     can sign on someone else's behalf — not even a full-access one;
 *   - a line signs once;
 *   - the Center Head is refused until both Stage-1 lines are in;
 *   - `status` reaches 'Verified' — and the linked document 'Approved' — only on
 *     the third signature.
 *
 * A correction clears every signature, because a signature belongs to the text its
 * signer read. Both routes are pinned here: the Stage-1 correction of a report
 * still under review, and the resubmission of a returned one.
 *
 * Two consequences worth naming, because both are easy to lose:
 *
 *   - The Social Worker's signature must not overwrite the intervention the
 *     Psychological Support Staff prescribed. Only the clinical line writes it.
 *   - A report whose signatures were cleared has to be signable again, or the
 *     "a line signs once" guard fires on the second cycle and the form can never
 *     be completed.
 *
 * A Houseparent holds `Violations:view` alone, which is what keeps them out of
 * signing on the API and in the menu — asserted here from the RBAC definition
 * rather than from a role name list.
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
const TRACKER_SRC = read('frontend/src/app/components/InterventionTracker.tsx');
const SIGNING_UTIL_SRC = read('frontend/src/app/utils/form08Signing.ts');
const NOTIFICATIONS_SRC = read('frontend/src/app/components/Notifications.tsx');

// ── Stubs ───────────────────────────────────────────────────────────────────

let reportRow = null;
const writes = [];

/**
 * Apply an `UPDATE incidentReports` to the stub row.
 *
 * The statement is assembled at runtime — which lines it touches depends on the
 * caller's side and on whether the signature completes the set — so it is parsed
 * here rather than destructured positionally. A stub that ignored the write would
 * report the pre-signature status back to the caller, and the handler re-reads the
 * row and returns it.
 */
function applyIncidentUpdate(sql, params) {
  const setClause = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'));
  const next = { ...reportRow };
  let index = 0;
  for (const assignment of setClause.split(',')) {
    const [column, rawValue] = assignment.split('=').map((part) => part.trim());
    if (!column) continue;
    if (rawValue === 'NOW()') { next[column] = '2026-09-02 09:00:00'; continue; }
    if (rawValue === 'CURRENT_TIMESTAMP') continue;
    if (/^'.*'$/.test(rawValue)) { next[column] = rawValue.replace(/^'|'$/g, ''); continue; }
    next[column] = params[index++];
  }
  reportRow = next;
}

async function poolQuery(sql, params) {
  const text = String(sql);
  writes.push({ sql: text, params });
  if (/^\s*UPDATE incidentReports/i.test(text)) {
    applyIncidentUpdate(text, params || []);
    return [{ affectedRows: 1 }];
  }
  if (/FROM incidentReports WHERE id = \?/i.test(text)) return [[reportRow]];
  if (/FROM children WHERE id = \?/i.test(text)) return [[{ name: 'Resident One' }]];
  if (/FROM documents WHERE id = \?/i.test(text)) return [[{ submittedBy: 'hp1' }]];
  return [[], []];
}

const pool = { query: poolQuery };

const notices = [];
const notificationStub = {
  residentName: async () => 'Resident One',
  notify: async (payload) => { notices.push(payload); },
  notifyUsers: async (ids, payload) => { notices.push({ ...payload, userIds: ids }); },
  houseparentsOf: async () => [{ id: 'U-HP', username: 'hp1' }],
  markRelatedRead: async () => {},
  userIdForUsername: async (username) => (username ? 'U-FILER' : null),
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

/** Run verify() and return `{ body, error, writes, notices }` — the error is the ApiError, not a 500. */
async function sign(user, body = {}, id = 'INC1') {
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
const ADMIN = { id: 'U-AD', username: 'admin', role: 'admin' };

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const baseReport = (overrides = {}) => ({
  id: 'INC1', violationId: 'VIO1', residentId: 'CH001', pdfDocumentId: null,
  reportTypes: '["Stealing"]', incidentDateTime: '2026-09-01 10:00:00',
  status: 'Submitted', interventionType: null, interventionScheduleDate: null,
  verifiedBy: null, verifiedAt: null,
  psychVerifiedBy: null, psychVerifiedAt: null,
  swVerifiedBy: null, swVerifiedAt: null,
  chVerifiedBy: null, chVerifiedAt: null,
  ...overrides,
});

const incidentWrite = (list) => list.find((entry) => /^\s*UPDATE incidentReports/i.test(entry.sql));
const documentWrite = (list) => list.find((entry) => /^\s*UPDATE documents/i.test(entry.sql));

// ── Which line a caller signs ───────────────────────────────────────────────

test('each role signs its own line, and only its own', () => {
  assert.equal(incidentReportController.resolveVerificationSide(SW), 'sw');
  assert.equal(incidentReportController.resolveVerificationSide(PSYCH), 'psych');
  assert.equal(incidentReportController.resolveVerificationSide(CENTER_HEAD), 'ch');

  // The side is derived from the role and never from the body: a conflicting
  // `verificationSide` is ignored, so three signatures cannot become one
  // person's by asking for someone else's line. A role with no line of its own
  // gets no line for asking.
  assert.equal(incidentReportController.resolveVerificationSide({ ...PSYCH, verificationSide: 'sw' }), 'psych');
  assert.equal(incidentReportController.resolveVerificationSide({ ...SW, verificationSide: 'ch' }), 'sw');
  assert.throws(
    () => incidentReportController.resolveVerificationSide({ ...HOUSE_PARENT, verificationSide: 'sw' }),
    (error) => error.statusCode === 403,
    'a Houseparent was allowed to name a line it does not own',
  );
});

test('a role with no line on the form is refused, and the Houseparent is one', () => {
  assert.throws(
    () => incidentReportController.resolveVerificationSide(HOUSE_PARENT),
    (error) => error.statusCode === 403,
    'a Houseparent was allowed to sign an Incident Report',
  );
  // The Administrator is full-access but has no printed line on Form 08. It used
  // to be able to *name* a side, which made one account able to complete a form
  // the specification says three named people sign.
  assert.throws(
    () => incidentReportController.resolveVerificationSide(ADMIN),
    (error) => error.statusCode === 403,
    'an Administrator was allowed to fill a line that is not theirs',
  );

  // The refusal is the capability, not a name list: the definition gives the
  // Houseparent `view` and `create` on Violations — enough to read the list and
  // log an incident, never to sign one off. The Center Head holds full access
  // rather than a per-module matrix, so its authorization is pinned by the route
  // test below instead.
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
  assert.equal(
    definition.roles.centerhead.fullAccess,
    true,
    'the Center Head lost full access, so it can no longer sign the form it notes',
  );
});

// ── One line at a time ──────────────────────────────────────────────────────

test('one signature records its own line and leaves the report unverified', async () => {
  reportRow = baseReport();
  const { error, body, writes: w } = await sign(SW, { signature: SIG });
  assert.equal(error, null, `verify failed: ${error && error.message}`);

  const update = incidentWrite(w);
  assert.ok(update, 'nothing was written');
  assert.match(update.sql, /swVerifiedBy = \?, swVerifiedAt = NOW\(\)/, 'the Social Worker line was not stamped');
  assert.match(update.sql, /checkedBySignature = \?/, 'the drawn signature was not stored on the Checked-by line');
  assert.equal(reportRow.swVerifiedBy, 'joyce');
  assert.equal(reportRow.checkedBySignature, SIG);

  // The report is NOT approved on one signature, and the completion columns are
  // not touched.
  assert.doesNotMatch(update.sql, /status = \?/, 'a single signature approved the report');
  assert.doesNotMatch(update.sql, /verifiedBy = \?/, 'verifiedBy was stamped before all three signed');
  assert.equal(body.data.status, 'Submitted');
  assert.equal(body.data.signatures.signedCount, 1);
  assert.equal(body.data.signatures.nextSide, 'psych', 'the form is not waiting on the other Stage-1 line');
});

test('the second Stage-1 signature still does not approve it — the Center Head is next', async () => {
  reportRow = baseReport({ swVerifiedBy: 'joyce', swVerifiedAt: '2026-09-02 09:00:00' });
  const { error, body, writes: w } = await sign(PSYCH, { signature: SIG, interventionType: 'Psychosocial Activity' });
  assert.equal(error, null, `verify failed: ${error && error.message}`);

  const update = incidentWrite(w);
  assert.match(update.sql, /psychVerifiedBy = \?, psychVerifiedAt = NOW\(\)/);
  assert.match(update.sql, /psychStaffSignature = \?/);
  assert.doesNotMatch(update.sql, /status = \?/, 'two of three signatures approved the report');
  assert.equal(body.data.status, 'Submitted');
  assert.equal(body.data.signatures.signedCount, 2);
  assert.equal(body.data.signatures.nextSide, 'ch', 'the form is not waiting on the Center Head');
});

test('the Psychological Support Staff is refused until the Social Worker has signed', async () => {
  // Form 08 routes strictly: the Social Worker reviews the filed report first,
  // and the clinical line opens only after that. A blank report is therefore not
  // the Psychological Support Staff's to sign yet.
  reportRow = baseReport();
  const { error, writes: w } = await sign(PSYCH, { signature: SIG });
  assert.ok(error, 'the Psychological Support Staff signed before the Social Worker');
  assert.equal(error.statusCode, 409);
  assert.equal(incidentWrite(w), undefined, 'the out-of-turn signature was written anyway');

  // Once the Social Worker has signed, the clinical line opens and the Center
  // Head is next.
  reportRow = baseReport({ swVerifiedBy: 'joyce', swVerifiedAt: '2026-09-02 09:00:00' });
  const next = await sign(PSYCH, { signature: SIG });
  assert.equal(next.error, null, `verify failed: ${next.error && next.error.message}`);
  assert.equal(next.body.data.signatures.nextSide, 'ch');
  assert.equal(next.body.data.status, 'Submitted');
});

test('the Center Head is refused until both Stage-1 lines are in', async () => {
  reportRow = baseReport();
  const { error, writes: w } = await sign(CENTER_HEAD, { signature: SIG });
  assert.ok(error, 'the Center Head signed an unreviewed report');
  assert.equal(error.statusCode, 409);
  assert.equal(incidentWrite(w), undefined, 'the out-of-turn signature was written anyway');

  reportRow = baseReport({ swVerifiedBy: 'joyce', swVerifiedAt: '2026-09-02 09:00:00' });
  const half = await sign(CENTER_HEAD, { signature: SIG });
  assert.equal(half.error?.statusCode, 409, 'the Center Head signed with one Stage-1 line missing');
});

test('the third signature completes the report and approves the linked document', async () => {
  reportRow = baseReport({
    pdfDocumentId: 'DOC1',
    swVerifiedBy: 'joyce', swVerifiedAt: '2026-09-02 09:00:00',
    psychVerifiedBy: 'francis', psychVerifiedAt: '2026-09-02 10:00:00',
    psychStaffSignature: SIG, checkedBySignature: SIG,
  });
  const { error, body, writes: w } = await sign(CENTER_HEAD, { signature: SIG });
  assert.equal(error, null, `verify failed: ${error && error.message}`);

  const update = incidentWrite(w);
  assert.match(update.sql, /chVerifiedBy = \?, chVerifiedAt = NOW\(\)/);
  assert.match(update.sql, /notedBySignature = \?/);
  assert.match(update.sql, /status = \?/, 'the third signature did not approve the report');
  assert.equal(reportRow.status, 'Verified');
  assert.equal(reportRow.verifiedBy, 'centerhead', 'verifiedBy does not record who completed the set');
  assert.equal(body.data.signatures.complete, true);
  assert.equal(body.data.signatures.nextSide, null);

  // The document is the copy the resident's folder serves and the copy `Mark
  // Done` reads, so it carries the signatures and is only approved here.
  const docUpdate = documentWrite(w);
  assert.ok(docUpdate, 'the signed PDF was never written to the document');
  assert.match(docUpdate.sql, /status = 'Approved'/, 'the linked document was not approved on the third signature');
  assert.match(docUpdate.sql, /approvedBy = \?/);
});

test('the document is NOT approved before the third signature', async () => {
  reportRow = baseReport({ pdfDocumentId: 'DOC1' });
  const { error, writes: w } = await sign(SW, { signature: SIG });
  assert.equal(error, null, `verify failed: ${error && error.message}`);

  const docUpdate = documentWrite(w);
  assert.ok(docUpdate, 'the signed PDF was never written to the document');
  assert.doesNotMatch(
    docUpdate.sql,
    /status = 'Approved'/,
    'the document was approved on the first signature, which would unlock Mark Done on an unsigned form',
  );
});

test('a line signs once', async () => {
  reportRow = baseReport({ swVerifiedBy: 'joyce', swVerifiedAt: '2026-09-02 09:00:00' });
  const { error, writes: w } = await sign(SW, { signature: SIG });
  assert.ok(error, 'the same line signed twice');
  assert.equal(error.statusCode, 409);
  assert.equal(incidentWrite(w), undefined, 'a duplicate signature was written anyway');
});

test('an already-signed-off report is left alone', async () => {
  reportRow = baseReport({
    status: 'Verified',
    swVerifiedBy: 'joyce', psychVerifiedBy: 'francis', chVerifiedBy: 'centerhead',
  });
  const { error, body, writes: w } = await sign(PSYCH, { signature: SIG });
  assert.equal(error, null);
  assert.equal(incidentWrite(w), undefined, 'an already-signed-off report was re-written');
  assert.equal(body.data.status, 'Verified');
});

test('a signature is required — a name is not enough', async () => {
  // The drawn signature is the point of the endpoint; `buildForm08Pdf` draws
  // nothing for a value it cannot decode, so an unusable one has to be refused
  // rather than recorded.
  for (const body of [{}, { signature: '' }, { signature: 'joyce' }, { signature: 'data:image/png;base64,' }]) {
    reportRow = baseReport();
    const { error, writes: w } = await sign(SW, body);
    assert.ok(error, `an unsigned request was accepted: ${JSON.stringify(body)}`);
    assert.equal(error.statusCode, 400);
    assert.equal(incidentWrite(w), undefined, 'a signature-less request still wrote a stamp');
  }
});

// ── The clinical line owns the intervention ─────────────────────────────────

test('the other two lines do not overwrite the prescribed intervention', async () => {
  // The intervention and its schedule are the clinical decision. Neither the
  // Social Worker nor the Center Head may blank them.
  for (const [user, existing] of [
    [SW, { psychVerifiedBy: 'francis', psychVerifiedAt: '2026-09-02 09:00:00' }],
    [CENTER_HEAD, {
      swVerifiedBy: 'joyce', swVerifiedAt: '2026-09-02 09:00:00',
      psychVerifiedBy: 'francis', psychVerifiedAt: '2026-09-02 10:00:00',
    }],
  ]) {
    reportRow = baseReport({
      ...existing,
      interventionType: 'Psychosocial Activity', interventionScheduleDate: '2026-09-10 09:00:00',
    });
    const { error, writes: w } = await sign(user, {
      signature: SIG,
      interventionType: 'Something Else',
      interventionScheduleDate: '2030-01-01T09:00',
    });
    assert.equal(error, null, `verify failed: ${error && error.message}`);
    assert.equal(
      reportRow.interventionType,
      'Psychosocial Activity',
      `${user.role} replaced the intervention`,
    );
    assert.equal(reportRow.interventionScheduleDate, '2026-09-10 09:00:00', `${user.role} replaced the schedule`);
    assert.ok(incidentWrite(w), 'nothing was written');
  }
});

test('the clinical line does write the intervention', async () => {
  reportRow = baseReport({ swVerifiedBy: 'joyce', swVerifiedAt: '2026-09-02 09:00:00' });
  const { error } = await sign(PSYCH, {
    signature: SIG,
    interventionType: 'Dialogue / Counseling',
    interventionScheduleDate: '2026-09-20T14:30',
  });
  assert.equal(error, null, `verify failed: ${error && error.message}`);
  assert.equal(reportRow.interventionType, 'Dialogue / Counseling');
  assert.equal(reportRow.interventionScheduleDate, '2026-09-20 14:30', 'the schedule was not normalised for MySQL');
});

// ── Who is asked next ───────────────────────────────────────────────────────

test('the Social Worker signature asks the Psychologist next', async () => {
  reportRow = baseReport();
  const { notices: n } = await sign(SW, { signature: SIG });
  const waiting = n.find((payload) => /needs your verification/i.test(String(payload.title || '')));
  assert.ok(waiting, 'nobody was asked for the next signature');
  assert.equal(waiting.targetRole, 'psychologist', 'the Social Worker signature asked the wrong line');

  // And the notice goes to the next line only — the Social Worker is not asked
  // for a signature that is already in.
  assert.ok(
    !n.some((payload) => payload.targetRole === 'socialworker'),
    'the Social Worker was asked to sign a line that is already signed',
  );
});

test('both Stage-1 lines in asks the Center Head, and nobody before that', async () => {
  reportRow = baseReport({ swVerifiedBy: 'joyce', swVerifiedAt: '2026-09-02 09:00:00' });
  const { notices: n } = await sign(PSYCH, { signature: SIG });
  const waiting = n.find((payload) => /ready for your signature/i.test(String(payload.title || '')));
  assert.ok(waiting, 'the Center Head was never told the form is ready');
  assert.equal(waiting.targetRole, 'centerhead', 'the wrong role was asked for the final signature');

  // And a Stage-1 signature must not address the Center Head while the other
  // Stage-1 line is still blank.
  reportRow = baseReport();
  const { notices: early } = await sign(SW, { signature: SIG });
  assert.ok(
    !early.some((payload) => payload.targetRole === 'centerhead'),
    'the Center Head was asked to sign before both Stage-1 lines were in',
  );
});

test('the completing signature tells the filer and the houseparents', async () => {
  reportRow = baseReport({
    pdfDocumentId: 'DOC1',
    swVerifiedBy: 'joyce', swVerifiedAt: '2026-09-02 09:00:00',
    psychVerifiedBy: 'francis', psychVerifiedAt: '2026-09-02 10:00:00',
  });
  const { notices: n } = await sign(CENTER_HEAD, { signature: SIG, interventionType: 'Psychosocial Activity' });
  assert.ok(
    n.some((payload) => /Incident Report Verified/i.test(String(payload.title || ''))),
    'nobody was told the report was approved',
  );
  assert.ok(
    n.some((payload) => (payload.userIds || []).includes('U-HP')),
    "the resident's Houseparents were not told",
  );
  assert.ok(
    n.some((payload) => (payload.userIds || []).includes('U-FILER')),
    'the person who filed the report was not told',
  );
});

// ── Schema, routes and the UI ───────────────────────────────────────────────

test('all three stamp pairs exist wherever incidentReports is declared', () => {
  const columns = [
    'psychVerifiedBy', 'psychVerifiedAt',
    'swVerifiedBy', 'swVerifiedAt',
    'chVerifiedBy', 'chVerifiedAt',
  ];
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
    /ensureColumn\('incidentReports', 'chVerifiedAt'/,
    'an existing database would never gain the Center Head stamp pair',
  );
});

test('a correction clears every signature, on both routes', () => {
  // Otherwise the "a line signs once" guard fires on the second cycle and the
  // report can never be signed off again.
  const resubmit = CONTROLLER_SRC.slice(
    CONTROLLER_SRC.indexOf('SET reportTypes = ?'),
    CONTROLLER_SRC.indexOf('WHERE id = ?', CONTROLLER_SRC.indexOf('SET reportTypes = ?')),
  );
  for (const column of ['psychVerifiedBy', 'psychVerifiedAt', 'swVerifiedBy', 'swVerifiedAt', 'chVerifiedBy', 'chVerifiedAt']) {
    assert.match(resubmit, new RegExp(`${column} = NULL`), `resubmit does not clear ${column}`);
  }
  for (const column of ['checkedBySignature', 'notedBySignature', 'psychStaffSignature']) {
    assert.match(resubmit, new RegExp(`${column} = NULL`), `resubmit does not clear the ${column} drawing`);
  }

  const documentResubmit = DOC_CONTROLLER_SRC.slice(
    DOC_CONTROLLER_SRC.indexOf("UPDATE incidentReports\n              SET status = 'Submitted'"),
    DOC_CONTROLLER_SRC.indexOf('WHERE pdfDocumentId = ?', DOC_CONTROLLER_SRC.indexOf("UPDATE incidentReports\n              SET status = 'Submitted'")),
  );
  assert.ok(documentResubmit.length > 0, 'the document resubmission path was not located');
  for (const column of ['psychVerifiedBy', 'psychVerifiedAt', 'swVerifiedBy', 'swVerifiedAt', 'chVerifiedBy', 'chVerifiedAt']) {
    assert.match(
      documentResubmit,
      new RegExp(`${column} = NULL`),
      `the document resubmission path does not clear ${column}`,
    );
  }

  // A returned report is cleared as it is returned, so a form waiting to be
  // corrected does not still read "1 of 3 signed". Sliced from the UPDATE itself:
  // the function opens with a SELECT that also ends in `WHERE pdfDocumentId = ?`,
  // and slicing from the function head would stop at that one.
  const returned = DOC_CONTROLLER_SRC.slice(
    DOC_CONTROLLER_SRC.indexOf('SET status = ?, updatedAt = CURRENT_TIMESTAMP,'),
    DOC_CONTROLLER_SRC.indexOf('WHERE pdfDocumentId = ?', DOC_CONTROLLER_SRC.indexOf('SET status = ?, updatedAt = CURRENT_TIMESTAMP,')),
  );
  assert.ok(returned.length > 0, 'the return path was not located');
  for (const column of ['swVerifiedBy', 'psychVerifiedBy', 'chVerifiedBy']) {
    assert.match(returned, new RegExp(`${column} = NULL`), `returning a report does not clear ${column}`);
  }
  for (const column of ['checkedBySignature', 'notedBySignature', 'psychStaffSignature']) {
    assert.match(returned, new RegExp(`${column} = NULL`), `returning a report does not clear the ${column} drawing`);
  }
});

test('an Incident Report cannot be approved from the Documents module', () => {
  // The approval is the third signature. One click in Documents — which the
  // Center Head, the Social Worker and the Administrator can all make — would
  // otherwise file a form with empty signature lines and let `Mark Done` proceed
  // on it.
  assert.match(
    DOC_CONTROLLER_SRC,
    /function assertNotIncidentReportApproval\(document\)/,
    'the guard against approving a Form 08 from Documents is gone',
  );
  const approve = DOC_CONTROLLER_SRC.slice(
    DOC_CONTROLLER_SRC.indexOf('async function approve('),
    DOC_CONTROLLER_SRC.indexOf('async function reject('),
  );
  assert.match(approve, /assertNotIncidentReportApproval\(existing\[0\]\)/, 'the approve route no longer refuses a Form 08');
  const update = DOC_CONTROLLER_SRC.slice(
    DOC_CONTROLLER_SRC.indexOf('async function update('),
    DOC_CONTROLLER_SRC.indexOf('async function remove('),
  );
  assert.match(
    update,
    /if \(status === 'Approved'\) assertNotIncidentReportApproval\(before\)/,
    'the PUT path — the one the Documents page actually approves through — no longer refuses a Form 08',
  );
});

test('the three signing roles reach the verify route and the Houseparent does not', () => {
  const route = ROUTES_SRC.slice(
    ROUTES_SRC.indexOf("'/:id/verify'"),
    ROUTES_SRC.indexOf('incidentReportController.verify'),
  );
  assert.ok(route.length > 0, 'the verify route was not located');
  assert.match(route, /authorize\('psychologist', 'socialworker', 'centerhead'\)/, 'a signing role cannot reach the route');
  assert.match(route, /requirePermission\('Violations', 'verify'\)/, 'the verify route lost its capability gate');
  assert.doesNotMatch(route, /houseparent/, 'a Houseparent was authorized on the verify route');
});

test('the incident report asks for no in-modal verification', () => {
  // The form is filled in here; it is signed from the Intervention Tracker. A pad
  // in this modal would let whoever filed the report sign the three lines on
  // behalf of the people who own them.
  assert.doesNotMatch(MODAL_SRC, /VerificationPanel/, 'the modal still renders a verification surface');
  assert.doesNotMatch(MODAL_SRC, /canVerifyIncidentReport/, 'the modal still reads the verify capability');
  for (const column of ['psychVerifiedBy', 'psychVerifiedAt', 'swVerifiedBy', 'swVerifiedAt', 'chVerifiedBy', 'chVerifiedAt']) {
    assert.ok(
      !MODAL_SRC.includes(column),
      `the modal still reads ${column} — the Form 08 carries no verification columns of its own`,
    );
  }
});

test('the Form 08 row offers the report to the signer whose turn it is', () => {
  // The tracker no longer signs: it says whose turn it is and opens the report,
  // where the pad sits on that signer's own line. The role-to-line map lives in
  // one shared module so the row and the form cannot disagree about it.
  assert.match(SIGNING_UTIL_SRC, /export function form8SideForRole/, 'the shared role-to-line map is gone');
  assert.match(SIGNING_UTIL_SRC, /case 'socialworker':\n(?:.*\n)*?\s+return 'sw';/, 'the Social Worker line is gone');
  assert.match(SIGNING_UTIL_SRC, /case 'psychologist':\n(?:.*\n)*?\s+return 'psych';/, 'the Psychological Staff line is gone');
  assert.match(SIGNING_UTIL_SRC, /case 'centerhead':\n(?:.*\n)*?\s+return 'ch';/, 'the Center Head line is gone');

  assert.match(TRACKER_SRC, /from '@\/app\/utils\/form08Signing'/, 'the tracker no longer reads the shared map');
  assert.match(TRACKER_SRC, /signatures\?\.nextSide === mySide/, "the tracker no longer waits for the caller's turn");
  assert.match(
    TRACKER_SRC,
    /openForm8\(track\.violation\.id, track\.violation\.residentId, 'sign'\)/,
    'the row no longer opens the report for signing',
  );
  assert.match(TRACKER_SRC, /mode=\{form8Mode\}/, 'the tracker no longer passes the mode to the report');
});

test('the report itself is where a signature is drawn', () => {
  // The requirement: a signer opens the incident report — the way the TRI opens
  // for review — and signs on their own printed line, not in a dialog over it.
  assert.match(MODAL_SRC, /'create' \| 'view' \| 'edit' \| 'sign'/, 'the report has no signing mode');
  assert.match(MODAL_SRC, /const signBoxKey = mySide \? FORM08_SIDE_BOX_KEY\[mySide\] : null/, 'the report does not resolve the line to sign');
  assert.match(MODAL_SRC, /data-form08-sign-slot=\{key\}/, 'the pad is not placed on the form itself');
  assert.match(MODAL_SRC, /form8SideEntry\(report, mySide\)/, 'the report does not read the signing state the API derived');
  assert.match(MODAL_SRC, /request\(`\/incident-reports\/\$\{report\.id\}\/verify`/, 'the report does not send the signature');

  // And the pad is only ever drawn for the caller's own line: the other two keep
  // showing what is already on them.
  const padBlock = MODAL_SRC.slice(
    MODAL_SRC.indexOf('{SIGNER_SIGNATURE_KEYS.map'),
    MODAL_SRC.indexOf('{SIGNER_SIGNATURE_KEYS.map') + 1800,
  );
  assert.match(padBlock, /const isMine = signBoxKey === key;/, 'the pad is not scoped to one line');
  assert.match(padBlock, /if \(isMine && signReady\)/, 'the pad is drawn for a line that is not the caller\'s turn');
});

test('a Form 08 notification opens the report, and reaches the first reviewer and the Center Head', () => {
  // Opening the tracker alone left the signer hunting for the row; the notice
  // carries the report id so the tracker opens that Form 08 ready to sign.
  assert.match(
    NOTIFICATIONS_SRC,
    /\/intervention-tracker\?incidentReportId=\$\{encodeURIComponent\(relatedRecordId\)\}/,
    'the signing notice no longer deep-links to the report',
  );
  assert.match(TRACKER_SRC, /get\('incidentReportId'\)/, 'the tracker ignores the deep link');
  assert.match(
    TRACKER_SRC,
    /setForm8Mode\('sign'\)/,
    'the deep link no longer opens the report ready to sign',
  );

  // The report is filed to the Social Worker — the first reviewer — and the
  // Center Head is told his turn comes last rather than being left to discover
  // it. The Psychological Support Staff is deliberately NOT pinged at filing
  // time: they are told when the Social Worker signs (see `verify`).
  assert.match(
    CONTROLLER_SRC,
    /await accountsFor\(\[VERIFICATION_SIDES\[FIRST_SIDE\]\.role\]\)/,
    'the first reviewer (the Social Worker) is no longer notified on submission',
  );
  assert.match(
    CONTROLLER_SRC,
    /await accountsFor\(\[VERIFICATION_SIDES\[FINAL_SIDE\]\.role\]\)/,
    'the Center Head is no longer notified when a Form 08 is filed',
  );
  assert.match(
    CONTROLLER_SRC,
    /your signature is the approval/,
    'the Center Head is no longer told that his signature is the approval',
  );
});
