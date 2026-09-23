/**
 * Regression guard: the Documents module must not know about TRI records.
 *
 * Removed feature: a "Repeated Forms — TRI Records" card that listed Submitted /
 * Under Review / Finalized TRI records separately from uploaded resident documents,
 * fed by GET /tri on mount and on every window focus.
 *
 * Verified in a real browser before removal: the card rendered "TRI — <resident>
 * 2026-09 · Finalized" above the document tabs, and the page issued
 * `GET http://localhost:5000/api/tri` on load.
 *
 * A source test is the right level here — the regression is a re-added block that
 * type-checks, builds, and is only visible on one screen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const COMPONENT = path.resolve(__dirname, '../../frontend/src/app/components/DocumentUpload.tsx');
const source = fs.readFileSync(COMPONENT, 'utf8');

test('the Documents module does not render a TRI records section', () => {
  assert.ok(!/Repeated Forms/i.test(source), 'the "Repeated Forms — TRI Records" heading is back');
  assert.ok(
    !/shown separately from uploaded resident documents/i.test(source),
    'the "shown separately from uploaded resident documents" subtitle is back'
  );
});

test('the Documents module holds no TRI state', () => {
  assert.ok(
    !/submittedTriRecords/.test(source),
    'submittedTriRecords is back — the Documents module is tracking TRI records again'
  );
});

test('the Documents module does not request TRI data', () => {
  assert.ok(
    !/['"`]\/tri['"`]/.test(source),
    "a GET '/tri' request is back in the Documents module"
  );
  assert.ok(
    !/\/tri\?recordId=/.test(source),
    'a link back into the TRI module is back in the Documents module'
  );
  assert.ok(
    !/\bTRI\b/.test(source),
    'the Documents module mentions TRI again'
  );
});

test('the Documents module still loads documents and refreshes on focus', () => {
  // The removal must not have taken the real refresh path with it.
  assert.match(source, /refreshData\(\)/, 'refreshData() was removed');
  assert.match(
    source,
    /addEventListener\('focus', refreshOnFocus\)/,
    'the focus refresh listener was removed'
  );
  assert.match(
    source,
    /removeEventListener\('focus', refreshOnFocus\)/,
    'the focus listener is no longer cleaned up'
  );
});
