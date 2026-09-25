/**
 * "For Reassessment" reopens the intervention, and it stays pending.
 *
 * An Incident Report (Form 08) is the record of a completed intervention: the
 * violation's tracker rows are all 'Completed' and its requirement rows are all
 * 'Done' before the report can even be filed (`incidentReportController.create`
 * refuses otherwise). Sending the report back for reassessment means it has to be
 * produced again — which only makes sense if the work it records has to be done
 * again.
 *
 * Until now the decision wrote `incidentReports.status = 'Reassessment'` and
 * nothing else. Two consequences, and the second is the dangerous one:
 *
 *   - The Intervention Tracker kept showing the case as finished, so the reopened
 *     work was invisible to the people who have to redo it.
 *   - Every completion gate was still satisfied by that same work. `markDone`
 *     requires all tracker rows 'Completed', and so does the Form 08 filing — so
 *     the intervention could be marked Done a second time, and a fresh Form 08
 *     filed, without anyone redoing anything. The reassessment request was
 *     effectively a no-op.
 *
 * The fix moves the tracker rows and the violation back in one transaction. The
 * requirement rows are deliberately left alone; the reason is set out at the
 * helper and pinned below, because resetting them is the obvious-looking change
 * that would make Mark Done unreachable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const DOC_CONTROLLER = read('backend/src/controllers/documentController.js');
const VIOLATION_CONTROLLER = read('backend/src/controllers/violationController.js');
const INCIDENT_CONTROLLER = read('backend/src/controllers/incidentReportController.js');
const TRACKER_UI = read('frontend/src/app/components/InterventionTracker.tsx');
const ASSESSMENTS_UI = read('frontend/src/app/components/Assessments.tsx');
const INCIDENT_MODAL = read('frontend/src/app/components/IncidentReportModal.tsx');

/** Slice a block by explicit markers, asserting both were actually found. */
function between(source, startMarker, endMarker, label) {
  const from = source.indexOf(startMarker);
  assert.ok(from >= 0, `${label}: start marker not found — ${startMarker}`);
  const to = source.indexOf(endMarker, from + startMarker.length);
  assert.ok(to > from, `${label}: end marker not found — ${endMarker}`);
  return source.slice(from, to);
}

// ── A pool that records what the helper writes ──────────────────────────────

let statements = [];
let failOn = null;

async function connectionQuery(sql, params) {
  const text = String(sql);
  statements.push({ sql: text, params });
  if (failOn && failOn.test(text)) throw new Error('stub connection failure');
  return [{ affectedRows: 1 }];
}

const connection = {
  beginTransaction: async () => { statements.push({ sql: 'BEGIN' }); },
  query: connectionQuery,
  commit: async () => { statements.push({ sql: 'COMMIT' }); },
  rollback: async () => { statements.push({ sql: 'ROLLBACK' }); },
  release: () => { statements.push({ sql: 'RELEASE' }); },
};

let connectionsOpened = 0;
const pool = {
  query: async () => [[], []],
  getConnection: async () => { connectionsOpened += 1; return connection; },
};

const DB_MODULE_PATH = require.resolve('../src/config/database');
require.cache[DB_MODULE_PATH] = {
  id: DB_MODULE_PATH,
  filename: DB_MODULE_PATH,
  loaded: true,
  exports: { pool, dbConfig: {}, testConnection: async () => true },
};

const documentController = require('../src/controllers/documentController');

const findStatement = (pattern) => statements.find((s) => pattern.test(s.sql));

async function reopen(violationId = 'VIO1', actor = { username: 'joyce' }) {
  statements = [];
  failOn = null;
  connectionsOpened = 0;
  await documentController.reopenInterventionForReassessment(violationId, actor);
}

// ── Behaviour ───────────────────────────────────────────────────────────────

test('the intervention tracker rows go back to pending', async () => {
  await reopen();
  const tracker = findStatement(/UPDATE intervention_tracker/);
  assert.ok(tracker, 'the tracker rows were never reset, so the case still reads as finished');
  assert.match(tracker.sql, /SET status = 'In Progress'/, 'the tracker row was not returned to a pending status');
  assert.match(tracker.sql, /completionDate = NULL/, 'the old completion date is still on the tracker row');
  assert.match(tracker.sql, /completedBy = NULL/, 'the old completer is still on the tracker row');
  assert.match(tracker.sql, /WHERE violationId = \?/, 'the reset is not scoped to the one violation');
  assert.deepEqual(tracker.params, ['VIO1']);
});

test('the requirement rows are deliberately left alone', async () => {
  // This looks like the missing half of the fix and is not. A requirement row
  // only reaches 'Done' through the linked Assessment created when the violation
  // was verified, and neither path back is reachable afterwards: the
  // intervention-requirements endpoint has no caller in the SPA, and the
  // Assessments list refuses to re-complete a Completed assessment. Resetting
  // the rows would be irreversible, and markDone — which requires every
  // requirement 'Done' — could never pass again, reopening the intervention with
  // no way to close it. So this asserts the absence on purpose, and says why.
  await reopen();
  assert.equal(
    findStatement(/UPDATE intervention_requirements/),
    undefined,
    'the requirement rows are reset, which makes Mark Done permanently unreachable',
  );
  // Both paths back to 'Done' really are unreachable — this is the premise of the
  // assertion above, so it is pinned rather than assumed.
  assert.equal(
    (TRACKER_UI.match(/intervention-requirements\//g) || []).length,
    0,
    'the SPA now calls the requirement-status endpoint, so the reset may be safe after all — re-check before removing it',
  );
  assert.match(
    ASSESSMENTS_UI,
    /item\.status !== 'Completed' && \(/,
    'the Assessments list now offers Complete on a Completed assessment, so a reset requirement could be re-completed',
  );
});

test('the violation leaves Resolved, so it reappears in the active tracker list', async () => {
  await reopen();
  const violation = findStatement(/UPDATE violations/);
  assert.ok(violation, 'the violation is still Resolved, so the reopened intervention stays filed under Done');
  assert.match(violation.sql, /SET status = 'Reviewed'/);
  assert.match(
    violation.sql,
    /WHERE id = \? AND status = 'Resolved'/,
    'only a Resolved violation may be moved — any other status is already pending',
  );
  assert.deepEqual(violation.params, ['joyce', 'VIO1']);
});

test('the whole reset is one transaction, and the connection is always returned', async () => {
  await reopen();
  assert.equal(statements[0].sql, 'BEGIN');
  assert.equal(statements[statements.length - 2].sql, 'COMMIT');
  assert.equal(statements[statements.length - 1].sql, 'RELEASE');
  for (const table of ['intervention_tracker', 'violations']) {
    assert.ok(findStatement(new RegExp(`UPDATE ${table}`)), `${table} was left out of the transaction`);
  }
});

test('a failed write rolls the whole reset back', async () => {
  // A half-applied reset is worse than none: the tracker would read as pending
  // while the requirements still read as done, and the gates disagree with the UI.
  statements = [];
  connectionsOpened = 0;
  failOn = /UPDATE violations/;
  await assert.rejects(
    () => documentController.reopenInterventionForReassessment('VIO1', { username: 'joyce' }),
    /stub connection failure/,
  );
  assert.ok(findStatement(/^ROLLBACK$/), 'a failed reset was left half-applied');
  assert.equal(findStatement(/^COMMIT$/), undefined, 'a failed reset was committed');
  assert.equal(statements[statements.length - 1].sql, 'RELEASE', 'the connection leaked on failure');
});

test('no violation id means no work and no connection', async () => {
  // The caller reads the violation id off the incidentReports row; a report with
  // no linked violation must not open a connection or write anything.
  await reopen(null);
  assert.equal(connectionsOpened, 0, 'a connection was opened for a report with no violation');
  assert.equal(statements.length, 0, 'the reset ran without a violation to scope it to');
});

test('the reset values are the ones the completion gates reject', () => {
  // If the gates accepted 'In Progress', this whole fix would be decorative.
  const markDone = between(
    VIOLATION_CONTROLLER,
    'const incomplete = reqRows.filter',
    'if (incomplete.length > 0',
    'markDone tracker gate',
  );
  assert.match(markDone, /r\.status !== 'Completed'/, 'markDone no longer blocks on a non-Completed tracker row');

  const formGate = between(
    INCIDENT_CONTROLLER,
    'if (!trackerRows.length',
    'const completedInterventionId',
    'Form 08 filing gate',
  );
  assert.match(
    formGate,
    /row\.status !== 'Completed'/,
    'Form 08 can now be filed while the intervention is pending again',
  );
});

test('the active tracker list really excludes Resolved', () => {
  // This is *why* the violation status has to move: the Tracker files a Resolved
  // violation under Done, so resetting only the rows would leave the reopened
  // intervention invisible.
  const activeList = between(
    TRACKER_UI,
    'const buildTracks = (resolved: boolean)',
    'const filteredTrackerRecords',
    'the Tracker\'s active/Done split',
  );
  assert.match(
    activeList,
    /!\[['"]Pending Review['"], ['"]Rejected['"], ['"]Resolved['"]\]\.includes\(v\.status\)/,
    'the active list no longer excludes Resolved — the violation status move may now be unnecessary, or wrong',
  );
});

// ── The call site ───────────────────────────────────────────────────────────

test('only a Reassessment reopens the intervention, never a Failed decision', () => {
  const callSites = DOC_CONTROLLER.match(/await reopenInterventionForReassessment\(/g) || [];
  assert.equal(callSites.length, 1, `the reopen is called ${callSites.length} times; expected exactly one guarded site`);

  const guard = between(
    DOC_CONTROLLER,
    "if (incidentStatus === 'Reassessment') {",
    '} catch (reopenErr)',
    'the reopen guard',
  );
  assert.match(guard, /await reopenInterventionForReassessment\(/, 'the reopen is not inside the Reassessment guard');

  // A 'Failed' report asks for the form to be filled out again, not for the
  // intervention to be reopened, so it must not reach the helper.
  assert.doesNotMatch(
    DOC_CONTROLLER,
    /incidentStatus === 'Failed'[\s\S]{0,200}reopenInterventionForReassessment/,
    'a Failed decision now reopens the intervention',
  );
});

test('a failure to reopen does not lose the reassessment decision', () => {
  // The status write is what the reviewer asked for; it has already committed.
  // Losing it to a tracker error would leave the report looking approved.
  const callBlock = between(
    DOC_CONTROLLER,
    'if (incidentStatus === \'Reassessment\') {',
    'const uploader = document.uploadedBy',
    'the reassessment branch',
  );
  assert.match(
    callBlock,
    /catch \(reopenErr\)/,
    'a tracker failure now aborts the reassessment decision',
  );
  // The handler has to swallow it. Asserting only that a `catch` exists is not
  // enough: a catch that rethrows still contains the marker, and still loses the
  // decision. So the body is what gets checked.
  const handler = between(
    DOC_CONTROLLER,
    'catch (reopenErr) {',
    'const uploader = document.uploadedBy',
    'the reopen failure handler',
  );
  assert.doesNotMatch(
    handler,
    /\bthrow\b/,
    'the reopen failure handler rethrows, so a tracker error discards the reviewer\'s decision',
  );
  assert.match(
    DOC_CONTROLLER,
    /UPDATE incidentReports\s+SET status = \?, updatedAt = CURRENT_TIMESTAMP\s+WHERE pdfDocumentId = \?/,
    'the incident report status is no longer written',
  );
});

// ── The tracker has to keep showing, and offering, the returned report ──────
//
// The backend half above reopens the intervention. That alone is not enough: the
// Tracker's Form 08 section was gated on `every(row => row.status === 'Completed')`,
// and reopening sets every row back to 'In Progress'. So the reassessment closed
// the very gate that revealed it — the "For Reassessment" badge and the "Fill Out
// Again" button both disappeared, and the report came back with no way to answer
// it. That is the reported symptom: the report "does not return to the Tracker".
//
// A 'Failed' report never showed the symptom, because failure deliberately does
// not reopen the checklist. The asymmetry is what identifies the cause.

test('the Form 08 section is not gated on the checklist alone', () => {
  const helper = between(
    TRACKER_UI,
    'const form8Section = (track: any) => {',
    'const loadTrackerRecords = async () => {',
    'the Form 08 visibility helper',
  );
  assert.match(
    helper,
    /report\.status === 'Reassessment'/,
    'a reassessment no longer keeps the Form 08 section visible — it will vanish again',
  );
  assert.match(helper, /report\.status === 'Failed'/, 'a failed report no longer keeps the section visible');
  assert.match(
    helper,
    /visible: checklistComplete \|\| needsRework/,
    'the section is gated on the checklist alone, so reopening the intervention hides it',
  );

  // The gate itself must go through the helper. Asserting the helper's body
  // without this would leave the old expression free to be restored above it.
  assert.match(
    TRACKER_UI,
    /\{form8Section\(track\)\.visible && \(/,
    'the Form 08 section is no longer rendered through the helper',
  );
  assert.doesNotMatch(
    TRACKER_UI,
    /every\(\(s: any\) => s\.status === 'Completed'\)\)\s*&&\s*\(/,
    'the Form 08 section is gated on completion again, so a reassessment hides it',
  );
});

test('the returned report stays actionable, not just visible', () => {
  // A badge with no control is the bug, not the fix. The section has to carry
  // the button that opens the report in edit mode, and edit mode is what
  // resubmits it.
  const section = between(
    TRACKER_UI,
    '{form8Section(track).visible && (',
    '{track.violation.actionTaken &&',
    'the Form 08 section',
  );
  assert.match(section, /For Reassessment/, 'the returned report no longer says it is for reassessment');
  assert.match(section, /Fill Out Again/, 'the returned report can no longer be filled out again');
  assert.match(
    section,
    /setForm8Mode\('edit'\)/,
    'the Fill Out Again button no longer opens the report in edit mode',
  );

  // And edit mode has to reach the resubmit endpoint rather than filing a second
  // report — a new Form 08 would leave the reopened intervention with two.
  assert.match(
    INCIDENT_MODAL,
    /request\(`\/incident-reports\/\$\{report\.id\}\/resubmit`/,
    'edit mode no longer resubmits the existing report',
  );
  assert.match(
    INCIDENT_CONTROLLER,
    /if \(!\['Failed', 'Reassessment'\]\.includes\(existing\.status\)\)/,
    'the resubmit endpoint no longer accepts a reassessment report',
  );
});

test('the caption names the returned state instead of the checklist rule', () => {
  const section = between(
    TRACKER_UI,
    '{form8Section(track).visible && (',
    'setForm8Mode',
    'the Form 08 section header',
  );
  assert.match(
    section,
    /form8Section\(track\)\.needsRework\s*\?/,
    'the caption is unconditional, so a returned report still reads as "not yet available"',
  );
  assert.match(
    section,
    /stays pending until this report is approved/,
    'the caption no longer says the intervention stays pending until the report is approved',
  );
});

test('the intervention cannot be marked Done until the report is approved again', () => {
  // This is the "remains pending" half of the requirement, and it is what makes
  // the reopened checklist meaningful: Mark Done stays disabled while any row is
  // pending, and again while the Form 08 is not approved.
  //
  // The assertion is scoped to the `disabled` attribute itself. A slice that ran
  // on to `onClick` would also swallow the neighbouring `title={...}`, which
  // repeats both conditions for its tooltip — so dropping a condition from
  // `disabled` would still pass on the strength of the tooltip. That was the
  // first version of this test, and a mutation proved it vacuous.
  const disabledAttrs = TRACKER_UI.match(/disabled=\{[^}]*\}/g) || [];
  const markDoneDisabled = disabledAttrs.find((attr) => attr.includes('markingDone === track.violation.id'));
  assert.ok(markDoneDisabled, 'the Mark Done button no longer disables while it is saving');
  assert.match(markDoneDisabled, /!allComplete/, 'Mark Done is no longer blocked by an incomplete checklist');
  assert.match(
    markDoneDisabled,
    /!hasApprovedForm8/,
    'Mark Done is no longer blocked by an unapproved Form 08 — a reassessment could be finalised without resubmitting',
  );
});
