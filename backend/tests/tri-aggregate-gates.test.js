/**
 * Regression guard for the TRI aggregate endpoints.
 *
 * Reported gap: `GET /tri/monitor` and `GET /tri/summary` had no role check at all.
 * The Dashboard renders the TRI Monitoring card only for socialworker / centerhead /
 * admin, so the restriction *looked* enforced — but it lived in the component alone,
 * and any authenticated user could read the same facility-wide data by calling the
 * endpoint directly.
 *
 * These tests pin three things: the gate exists on the two aggregate routes, it
 * accepts exactly the three management roles, and it is NOT applied to the
 * per-resident routes the TRI form itself needs for every role.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { authorize } = require('../src/middleware/auth');

const ROUTES = fs.readFileSync(path.resolve(__dirname, '../src/routes/triRoutes.js'), 'utf8');

/** The single source line declaring a route, so assertions stay scoped to it. */
function routeLine(fragment) {
  const line = ROUTES.split('\n').find((l) => l.includes(fragment));
  assert.ok(line, `no route found containing ${fragment}`);
  return line;
}

/** Runs the gate for a role and resolves the status it produced. */
function statusFor(gate, role) {
  return new Promise((resolve) => {
    gate({ user: { role } }, {}, (err) => resolve(err ? err.statusCode || err.status : 200));
  });
}

// ── the reported gap ────────────────────────────────────────────────────────────

test('the TRI monitor endpoint is role-gated on the server', () => {
  const line = routeLine("'/monitor'");
  assert.match(
    line,
    /authorize\('socialworker', 'centerhead', 'admin'\)/,
    `GET /tri/monitor is no longer server-gated — the Dashboard-only check does not stop a direct call: ${line}`
  );
});

test('the TRI summary endpoint is role-gated on the server', () => {
  const line = routeLine("'/summary'");
  assert.match(
    line,
    /authorize\('socialworker', 'centerhead', 'admin'\)/,
    `GET /tri/summary is no longer server-gated: ${line}`
  );
});

test('the gate sits between the path and the handler, not after it', () => {
  for (const fragment of ["'/monitor'", "'/summary'"]) {
    const line = routeLine(fragment);
    const gateAt = line.indexOf('authorize(');
    const handlerAt = line.indexOf('asyncHandler(');
    assert.ok(gateAt > 0 && handlerAt > 0, `expected both a gate and a handler: ${line}`);
    assert.ok(gateAt < handlerAt, `authorize() must run before the handler: ${line}`);
  }
});

// ── the exact role set ──────────────────────────────────────────────────────────

test('the gate admits socialworker, centerhead and admin', async () => {
  const gate = authorize('socialworker', 'centerhead', 'admin');
  for (const role of ['socialworker', 'centerhead', 'admin']) {
    assert.equal(await statusFor(gate, role), 200, `${role} should be admitted`);
  }
});

test('the gate refuses every other role', async () => {
  const gate = authorize('socialworker', 'centerhead', 'admin');
  for (const role of ['houseparent', 'nurse', 'psychologist', 'educator']) {
    assert.equal(await statusFor(gate, role), 403, `${role} should be refused`);
  }
});

test('the gate matches the Dashboard card gate exactly', () => {
  // Dashboard.tsx: const isSocialWorker = ['socialworker', 'centerhead', 'admin'].includes(userRole)
  const dashboard = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/src/app/components/Dashboard.tsx'),
    'utf8'
  );
  const declared = dashboard.match(/const isSocialWorker = \[([^\]]*)\]/);
  assert.ok(declared, 'the Dashboard no longer declares isSocialWorker');
  const clientRoles = declared[1].match(/'([a-z]+)'/g).map((r) => r.replace(/'/g, '')).sort();
  assert.deepEqual(
    clientRoles,
    ['admin', 'centerhead', 'socialworker'],
    'the client and server role sets have drifted apart — one of them now shows or hides the card incorrectly'
  );
});

test('"administrator" is still not a management role on the backend (pre-existing)', async () => {
  const gate = authorize('socialworker', 'centerhead', 'admin');
  assert.equal(await statusFor(gate, 'administrator'), 403);
});

// ── the routes that must stay open ──────────────────────────────────────────────

test('the per-resident routes the TRI form needs are NOT gated', () => {
  // Tri.tsx calls /resident/:id/deductions while a Houseparent fills the form, and
  // ChildDetail.tsx calls /resident/:id/history for every role. Gating these would
  // break the form for the very people who have to submit it.
  for (const fragment of ["'/resident/:residentId/deductions'", "'/resident/:residentId/history'", "'/resident/:residentId/violations'"]) {
    const line = routeLine(fragment);
    assert.ok(
      !line.includes('authorize('),
      `${fragment} is now role-gated; a Houseparent can no longer load the data the TRI form depends on: ${line}`
    );
  }
});

test('the record list stays available to every role', () => {
  const line = routeLine("router.get('/', ");
  assert.ok(!line.includes('authorize('), `GET /tri is now gated, which hides the list from Houseparents: ${line}`);
});
