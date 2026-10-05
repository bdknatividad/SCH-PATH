/**
 * A Social Worker may not approve or reject an incident they logged.
 *
 * The rule is keyed on who logged the incident (`createdBy`, stamped from the
 * session; `reportedBy` for older rows) and applies to the Social Worker only:
 * other roles, and a Social Worker reviewing someone else's incident, are
 * unaffected.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub('../src/config/database', { pool: { query: async () => [[]] }, dbConfig: {}, testConnection: async () => true });

const { isSocialWorkerOwnIncident } = require('../src/controllers/violationController');

const SW = { username: 'joyce', role: 'socialworker' };

test('the Social Worker who logged the incident cannot review it', () => {
  assert.equal(isSocialWorkerOwnIncident(SW, { createdBy: 'joyce' }), true);
  assert.equal(isSocialWorkerOwnIncident(SW, { createdBy: 'JOYCE ' }), true);
  // An older incident with no createdBy falls back to reportedBy.
  assert.equal(isSocialWorkerOwnIncident(SW, { reportedBy: 'joyce' }), true);
});

test('createdBy wins over an edited reportedBy', () => {
  assert.equal(isSocialWorkerOwnIncident(SW, { createdBy: 'hp1', reportedBy: 'joyce' }), false);
  assert.equal(isSocialWorkerOwnIncident(SW, { createdBy: 'joyce', reportedBy: 'someone else' }), true);
});

test('a Social Worker can still review incidents other users logged', () => {
  assert.equal(isSocialWorkerOwnIncident(SW, { createdBy: 'hp1' }), false);
  assert.equal(isSocialWorkerOwnIncident(SW, {}), false);
});

test('other roles are not affected', () => {
  assert.equal(isSocialWorkerOwnIncident({ username: 'centerhead', role: 'centerhead' }, { createdBy: 'centerhead' }), false);
  assert.equal(isSocialWorkerOwnIncident({ username: 'francis', role: 'psychologist' }, { createdBy: 'francis' }), false);
});

test('the review refuses both decisions before anything is written, and create stamps the logger', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/controllers/violationController.js'), 'utf8');
  const review = src.slice(src.indexOf('async function review('));
  const guard = review.indexOf('isSocialWorkerOwnIncident(req.user, violation)');
  assert.ok(guard > 0, 'review() does not check for the Social Worker\'s own incident');
  assert.ok(guard < review.indexOf("if (status === 'Reviewed')"), 'the check must run for Rejected as well as Reviewed');
  assert.match(src, /createdBy: req\.user\?\.username \|\| null,/, 'create() must stamp the logger from the session');
  assert.match(src, /delete req\.body\.createdBy;/, 'update() must not let an edit change the logger');
});
