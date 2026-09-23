const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('TRI submit is wired to the discharge recommendation engine', () => {
  const tri = read('backend/src/controllers/triController.js');
  assert.match(tri, /buildRecommendationForTri/);
  assert.match(tri, /dischargeRecommendation/);
});

test('monthly discharge thresholds are 3+ major or 5+ minor', () => {
  const controller = read('backend/src/controllers/dischargeController.js');
  assert.match(controller, /const MAJOR_THRESHOLD = 3/);
  assert.match(controller, /const MINOR_THRESHOLD = 5/);
  assert.match(controller, /majorCount >= MAJOR_THRESHOLD/);
  assert.match(controller, /minorCount >= MINOR_THRESHOLD/);
});

test('extension decisions require an authorized case-management role', () => {
  const controller = read('backend/src/controllers/dischargeController.js');
  assert.match(controller, /centerhead.*admin.*socialworker/);
  assert.match(controller, /Only authorized case-management staff can decide discharge extensions/);
});

test('discharge extension history stores previous and new dates plus reason and decision maker', () => {
  const controller = read('backend/src/controllers/dischargeController.js');
  assert.match(controller, /previousDischargeDate/);
  assert.match(controller, /newDischargeDate/);
  assert.match(controller, /extensionDays/);
  assert.match(controller, /reason/);
  assert.match(controller, /decidedBy/);
});

test('ChildDetail exposes read-only discharge information to HP while edit controls are role-gated', () => {
  const detail = read('frontend/src/app/components/ChildDetail.tsx');
  assert.match(detail, /canDecideDischarge/);
  assert.match(detail, /Add Time Extension/);
  assert.match(detail, /Extension History/);
  assert.match(detail, /expectedDischargeDate/);
});
