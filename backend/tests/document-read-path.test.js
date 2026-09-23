/**
 * Document read-path invariants.
 *
 * Every document read goes through the same visibility scope
 * (`getReadableDocument` → `canReadDocumentAsync` → `documentVisibleTo`), and
 * three of the four list endpoints deliberately strip the base64 payload before
 * responding. `getById` is the exception, and it has to be: `IncidentReportModal`
 * reads `data.fileData` to open a Form 08 PDF, and `DocumentUpload` uses it as
 * its fallback for legacy rows. That makes the payload part of the contract for
 * exactly one endpoint, which is the kind of exception that quietly spreads.
 *
 * These tests pin the shape so the exception stays deliberate.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'controllers', 'documentController.js'),
  'utf8',
);

/** Pull one function body out of the controller by its declaration. */
function bodyOf(name) {
  const start = SOURCE.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `expected async function ${name} in documentController.js`);
  // Next top-level declaration, or end of file.
  const rest = SOURCE.slice(start + 1);
  const next = rest.search(/\n(?:async )?function \w+\(|\nmodule\.exports/);
  return next === -1 ? rest : rest.slice(0, next);
}

test('every document read resolves visibility through the shared scope check', () => {
  // Reading a document must never be a bare SELECT plus a send. `getReadableDocument`
  // is the single place that combines the fetch with the read rule, so a new
  // endpoint that forgets the rule is the failure mode this guards.
  for (const fn of ['getFile', 'getById']) {
    assert.match(
      bodyOf(fn),
      /getReadableDocument\(/,
      `${fn} must fetch through getReadableDocument so the visibility rule applies`,
    );
  }
});

test('the three list endpoints strip the base64 payload', () => {
  // A listing that carries `fileData` ships every file in the module as JSON.
  for (const fn of ['getAll', 'getByResident', 'getPending']) {
    assert.match(
      bodyOf(fn),
      /withoutFileData/,
      `${fn} must map through withoutFileData`,
    );
  }
});

test('getById is the documented exception and marks the payload no-store', () => {
  const body = bodyOf('getById');

  // It must NOT strip the payload — IncidentReportModal depends on it.
  assert.doesNotMatch(body, /withoutFileData/, 'getById intentionally returns fileData');

  // ...so it must not be cacheable.
  assert.match(body, /Cache-Control/, 'getById must set Cache-Control');
  assert.match(body, /private, no-store/, 'the payload must not be cached by any intermediary');
});

test('getFile sets no-store too, and both agree', () => {
  // The same bytes are served by two endpoints; they must make the same promise.
  const body = bodyOf('getFile');
  assert.match(body, /Cache-Control/);
  assert.match(body, /private, no-store/);
});

test('a write against a closed admission is refused, not silently applied', () => {
  // A discharge ends an admission. Editing its documents afterwards would
  // rewrite what the first stay says about a resident.
  assert.match(SOURCE, /async function assertAdmissionOpen\(/);
  assert.match(SOURCE, /has been closed, so its documents can no longer be/);

  // It has to be called from the write paths, not merely defined.
  const calls = SOURCE.match(/assertAdmissionOpen\(/g) || [];
  assert.ok(calls.length >= 4, `expected assertAdmissionOpen to be called from the write paths, found ${calls.length} references`);
});

test('a client cannot choose which admission a document is filed under', () => {
  // `admissionId` is derived from the resident's active admission. If a request
  // body could set it, a returning resident's upload could be filed into the
  // previous stay.
  assert.match(SOURCE, /col !== 'admissionId'/, 'create must exclude admissionId from client columns');
  assert.match(
    SOURCE,
    /delete req\.body\.admissionId/,
    'update must strip admissionId from the request body',
  );
  assert.match(
    SOURCE,
    /activeAdmissionIdFor\(pool, data\.residentId\)/,
    'create must derive the admission from the resident',
  );
});
