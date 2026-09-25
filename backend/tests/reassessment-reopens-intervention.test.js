const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const DOC_CONTROLLER = read('backend/src/controllers/documentController.js');
const INCIDENT_CONTROLLER = read('backend/src/controllers/incidentReportController.js');
const TRACKER_UI = read('frontend/src/app/components/InterventionTracker.tsx');
const ASSESSMENTS_UI = read('frontend/src/app/components/Assessments.tsx');
const INCIDENT_MODAL = read('frontend/src/app/components/IncidentReportModal.tsx');

function between(source, startMarker, endMarker) {
  const from = source.indexOf(startMarker);
  assert.ok(from >= 0, `start marker not found: ${startMarker}`);
  const to = source.indexOf(endMarker, from + startMarker.length);
  assert.ok(to > from, `end marker not found: ${endMarker}`);
  return source.slice(from, to);
}

test('returned Incident Reports do not reset completed intervention tracker rows', () => {
  const decision = between(DOC_CONTROLLER, 'async function applyIncidentReportDecision', 'const DOCUMENT_DELETE_ROLES');
  assert.doesNotMatch(decision, /UPDATE intervention_tracker[\\s\\S]{0,500}SET status = 'In Progress'/,
    'reassessment/rejection resets a completed intervention');
  assert.doesNotMatch(decision, /UPDATE intervention_requirements[\\s\\S]{0,500}status = 'In Progress'/,
    'reassessment/rejection resets intervention requirements');
  assert.doesNotMatch(decision, /UPDATE violations[\\s\\S]{0,500}SET status = 'Reviewed'/,
    'reassessment/rejection changes the completed violation state');
});

test('Incident Report resubmission preserves prescribed intervention and schedule', () => {
  const resubmit = between(INCIDENT_CONTROLLER, 'async function resubmit', 'async function canEditIncidentReport');
  assert.match(resubmit, /status = 'Submitted',[\s\S]{0,300}updatedAt = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(resubmit, /interventionType = NULL/);
  assert.doesNotMatch(resubmit, /interventionScheduleDate = NULL/);
});

test('generic document resubmission also preserves prescribed intervention and schedule', () => {
  const update = between(DOC_CONTROLLER, 'async function submit', 'async function notifyUploaderOfDecision');
  assert.doesNotMatch(update, /interventionType = NULL/);
  assert.doesNotMatch(update, /interventionScheduleDate = NULL/);
});

test('the same incident document is returned to the pending-review queue', () => {
  assert.match(INCIDENT_CONTROLLER, /UPDATE documents SET title = 'Incident Report', status = 'Submitted'/,
    'the resubmission does not put the existing document back into review');
  assert.match(INCIDENT_CONTROLLER, /WHERE id = \?/,
    'the existing linked document is not updated in place');
});

test('resolved violations with returned reports are surfaced in the active Intervention Tracker', () => {
  assert.match(TRACKER_UI, /const returnedIncident = incidentReportNeedsRework\(incidentReportsByViolation\[v\.id\]\);/);
  assert.match(TRACKER_UI, /return returnedIncident \|\| !\['Pending Review', 'Rejected', 'Resolved'\]\.includes\(v\.status\);/);
});

test('the returned report still uses the same Incident Report record', () => {
  assert.match(INCIDENT_CONTROLLER, /UPDATE incidentReports[\s\S]{0,1200}WHERE id = \?/,
    'resubmission creates a new incident instead of updating the same record');
  assert.doesNotMatch(INCIDENT_CONTROLLER, /INSERT INTO incidentReports[\s\S]{0,500}resubmit/,
    'resubmission inserts another incident report');
});


test('reassessment/rejection changes only the Incident Report status', () => {
  const decision = between(DOC_CONTROLLER, 'async function applyIncidentReportDecision', 'const DOCUMENT_DELETE_ROLES');
  assert.match(decision, /UPDATE incidentReports\s+SET status = \?, updatedAt = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(decision, /UPDATE assessments/);
  assert.doesNotMatch(decision, /UPDATE intervention_tracker/);
  assert.doesNotMatch(decision, /UPDATE intervention_requirements/);
  assert.doesNotMatch(decision, /UPDATE violations/);
  assert.doesNotMatch(decision, /SET status = 'Reviewed'/);
});

test('resubmission only moves the same Incident Report and document back to review', () => {
  const resubmit = between(INCIDENT_CONTROLLER, 'async function resubmit', 'async function canEditIncidentReport');
  assert.match(resubmit, /UPDATE incidentReports[\s\S]{0,900}status = 'Submitted'/);
  assert.match(resubmit, /UPDATE documents SET title = 'Incident Report', status = 'Submitted'/);
  assert.doesNotMatch(resubmit, /INSERT INTO incidentReports/);
  assert.doesNotMatch(resubmit, /UPDATE intervention_tracker/);
  assert.doesNotMatch(resubmit, /UPDATE intervention_requirements/);
  assert.doesNotMatch(resubmit, /UPDATE assessments/);
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
  // The states that mean "the Center Head sent this back" are defined once, in
  // `incidentReportNeedsRework`, and the gate has to go through it. Spelling
  // them out here again is what hid the section: this gate knew only
  // 'Reassessment' and 'Failed', while the row's own badge already treated
  // 'For Reassessment' and a Reassessment *document* as returned — so for those
  // two the section vanished and "Fill Out Again" was unreachable, which is the
  // same symptom arriving by a different state.
  assert.match(
    helper,
    /const needsRework = incidentReportNeedsRework\(report\)/,
    'the Form 08 gate no longer asks the shared "needs rework" test',
  );
  assert.match(
    helper,
    /visible: checklistComplete \|\| needsRework/,
    'the section is gated on the checklist alone, so reopening the intervention hides it',
  );

  const rework = between(
    TRACKER_UI,
    'const incidentReportNeedsRework = (report: any) =>',
    'const activeChildren =',
    'the shared "needs rework" test',
  );
  for (const state of ["'Failed'", "'Reassessment'", "'Rejected'", "'For Reassessment'"]) {
    assert.ok(
      rework.includes(`report.status === ${state}`),
      `a report with status ${state} no longer counts as returned, so its Form 08 section hides`,
    );
  }
  for (const doc of ["'Rejected'", "'Reassessment'"]) {
    assert.ok(
      rework.includes(`report.documentStatus === ${doc}`),
      `a ${doc} document no longer counts as returned, so its Form 08 section hides`,
    );
  }

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
