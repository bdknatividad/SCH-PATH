const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const DOC_CONTROLLER = read('backend/src/controllers/documentController.js');
const INCIDENT_CONTROLLER = read('backend/src/controllers/incidentReportController.js');
const TRACKER_UI = read('frontend/src/app/components/InterventionTracker.tsx');

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
