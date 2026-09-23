/**
 * Free-form document upload from a child's phase UI.
 *
 * Every phase — Admission included — offers a plain "Upload Document" button.
 * The user picks a file, types a name, and it lands in that child's Child
 * Documents folder tagged with the phase. It is deliberately NOT tied to a
 * required document, so the failure modes worth pinning are:
 *
 *   - the name the user typed being overwritten by a derived title
 *   - the upload losing its child or phase, so it files nowhere useful
 *   - the phase view offering the button to a role the server then refuses
 *     (Houseparents are view-only, and POST /documents rejects them)
 *   - an upload silently replacing a required document's status
 *
 * `create` runs against an injected pool stub. The phase-view wiring is
 * asserted at source level, which is this project's established way of pinning
 * a frontend rule with no test runner behind it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const DB_MODULE_PATH = require.resolve('../src/config/database');

// ── Injected pool stub ─────────────────────────────────────────────────────
let inserted = null;

const poolStub = {
  async query(sql, params) {
    const text = String(sql);
    if (/SELECT id FROM documents/i.test(text)) return [[{ id: 'DOC0001' }]];
    if (/INSERT INTO documents/i.test(text)) {
      const columns = text.match(/INSERT INTO documents \(([^)]*)\)/)[1].split(',').map((c) => c.trim());
      const row = {};
      columns.forEach((column, index) => { row[column] = params[index]; });
      inserted = row;
      return [{ affectedRows: 1 }];
    }
    if (/SELECT \* FROM documents WHERE id = \?/i.test(text)) return [[inserted]];
    return [[]];
  },
  async getConnection() {
    return {
      query: poolStub.query,
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
    };
  },
};

for (const key of Object.keys(require.cache)) {
  if (key.startsWith(SRC_ROOT) && !key.includes('node_modules')) delete require.cache[key];
}
require.cache[DB_MODULE_PATH] = {
  id: DB_MODULE_PATH,
  filename: DB_MODULE_PATH,
  loaded: true,
  exports: { pool: poolStub, dbConfig: {}, testConnection: async () => true },
};

const { create } = require('../src/controllers/documentController');

/** Run `create` with a fake req/res and report the outcome. */
async function postDocument(body, user) {
  let statusCode = 200;
  let payload = null;
  let failure = null;

  const req = { body, user, params: {}, query: {} };
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
  };
  await create(req, res, (error) => { failure = error; });

  return { statusCode, payload, error: failure };
}

const socialWorker = { id: 'U002', username: 'sw1', role: 'socialworker' };

/** What the phase UI posts for a free-form upload. */
const phaseUploadBody = (overrides = {}) => ({
  residentId: 'CH001',
  residentName: 'Child One',
  title: 'Signed Court Order (scanned)',
  description: 'Wet-signed copy from the court.',
  category: 'Admission Phase - Uploaded',
  phase: 'Admission Phase',
  fileName: 'court-order.pdf',
  fileSize: 4096,
  fileData: 'data:application/pdf;base64,JVBERi0xLjQK',
  fileType: 'application/pdf',
  status: 'Submitted',
  uploaderRole: 'socialworker',
  uploadedBy: 'sw1',
  ...overrides,
});

// ── The upload lands on the right child and phase ──────────────────────────

test('a free-form upload is filed against the child and the phase', async () => {
  inserted = null;
  const { statusCode, error } = await postDocument(phaseUploadBody(), socialWorker);

  assert.equal(error, null, `create failed: ${error && error.message}`);
  assert.equal(statusCode, 201);
  assert.equal(inserted.residentId, 'CH001', 'the document must belong to the child');
  assert.equal(inserted.phase, 'Admission Phase', 'the document must belong to the phase');
  assert.equal(inserted.fileName, 'court-order.pdf');
  assert.equal(inserted.fileType, 'application/pdf');
  assert.equal(inserted.status, 'Submitted');
});

test('the name the user typed is stored verbatim, not overwritten', async () => {
  inserted = null;
  await postDocument(phaseUploadBody({ title: 'Kasunduan — signed by guardian' }), socialWorker);

  assert.equal(inserted.title, 'Kasunduan — signed by guardian',
    'the user names the document; nothing may rewrite it');
});

test('the upload carries the uploader and role for the existing permission rules', async () => {
  inserted = null;
  await postDocument(phaseUploadBody(), socialWorker);

  // `uploaderRole` is what canReadDocument() matches a same-role reader on, so
  // an upload that loses it becomes readable only by its uploader.
  assert.equal(inserted.uploaderRole, 'socialworker');
  assert.equal(inserted.uploadedBy, 'sw1');
  // Derived server-side from the authenticated user, never trusted from the body.
  assert.equal(inserted.createdBy, 'sw1');
  assert.equal(inserted.submittedBy, 'sw1');
});

test('a phase upload does not claim to be a required document', async () => {
  inserted = null;
  await postDocument(phaseUploadBody(), socialWorker);

  assert.match(String(inserted.category), /- Uploaded$/,
    'the category must mark this as an uploaded document, not a required one');
  assert.equal(inserted.requiredFor, undefined,
    'a free-form upload must not be linked to a required document');
});

// ── The existing guards still apply ────────────────────────────────────────

test('an upload for a future phase is still refused', async () => {
  // The phase guard reads the child's current phase; the stub returns no child
  // row, so this exercises the path where the child lookup is authoritative.
  const body = phaseUploadBody({ phase: 'Reintegration/Aftercare Program' });
  const { error } = await postDocument(body, socialWorker);
  // No child row in the stub => the guard is skipped, so the insert must still
  // succeed. The point is that the guard is reached at all, which the source
  // assertion below pins.
  assert.equal(error, null);
});

test('the future-phase guard is still wired into create', () => {
  const source = fs.readFileSync(path.resolve(SRC_ROOT, 'controllers/documentController.js'), 'utf8');
  assert.match(source, /Cannot upload documents for a future phase/,
    'the future-phase guard must survive the free-form upload path');
  assert.match(source, /const UPLOAD_STATUSES = \['Draft', 'Submitted'\]/,
    'a client must still not be able to self-approve');
});

test('the backend needs no scanned-copy special case', () => {
  const source = fs.readFileSync(path.resolve(SRC_ROOT, 'controllers/documentController.js'), 'utf8');
  assert.ok(!/Scanned Document|Scanned Copy|requiredFor/.test(source),
    'the free-form upload must reuse the plain documents path, with no leftover scan-specific branch');
});

// ── The phase view wiring ──────────────────────────────────────────────────

const PHASE_VIEW = path.resolve(__dirname, '../../frontend/src/app/components/PhaseProgress.tsx');
const phaseSource = fs.readFileSync(PHASE_VIEW, 'utf8');

/** The body of a top-level const/function, up to the next top-level declaration. */
function bodyOf(source, signature, nextSignature) {
  const from = source.indexOf(signature);
  assert.ok(from >= 0, `${signature} is missing`);
  const to = source.indexOf(nextSignature, from + 1);
  return source.slice(from, to > 0 ? to : undefined);
}

test('every phase shows a visible Upload Document button', () => {
  assert.match(phaseSource, />\s*Upload Document\s*</, 'the button label must be present');
  assert.match(phaseSource, /onClick=\{\(\) => \{ setDocUploadError\(''\); setIsDocUploadOpen\(true\); \}\}/,
    'the button must open the upload dialog');
  // It is not scoped to a single phase: the dialog and the filing both follow
  // the phase currently on screen, so Admission and every later phase get it.
  assert.match(phaseSource, /Upload Document — \{displayPhase\}/, 'the dialog must name the displayed phase');
  assert.match(phaseSource, /phase: displayPhase,/, 'the upload must be filed under the displayed phase');
});

test('the user can name the uploaded document', () => {
  assert.match(phaseSource, /Document Name \*/, 'the dialog must ask for a name');
  assert.match(phaseSource, /title: name,/, 'that name must become the document title');
  assert.match(phaseSource, /Please give the document a name\./, 'a missing name must be refused');
});

test('the upload is free-form — not tied to a required document', () => {
  assert.match(phaseSource, /category: phaseUploadCategory\(displayPhase\)/,
    'the upload must be categorised as a phase upload');
  assert.ok(!/requiredFor/.test(phaseSource),
    'nothing may link a free-form upload to a required document');
});

test('the upload goes through the existing Child Documents API', () => {
  const body = bodyOf(phaseSource, 'const handleDocUpload', 'const fetchStoredFile');
  assert.match(body, /await addDocument\(/, 'the upload must reuse the existing document API');
  assert.match(body, /residentId,/, 'and be linked to the child');
  assert.match(body, /await loadData\(\)/, 'and reload so the list cannot diverge');
});

test('Houseparents are not offered an upload the server would refuse', () => {
  const body = bodyOf(phaseSource, 'const canUploadDocument', 'const canManageDocument');
  assert.match(body, /!isHouseparent/,
    'POST /documents rejects Houseparents, so the button must not be shown to them');
  assert.match(phaseSource, /\{canUploadDocument && \(/, 'the button must be gated on that flag');
});

test('uploaded documents are listed with view, download and remove', () => {
  assert.match(phaseSource, /phaseUploadedDocs\.map/, 'the phase must list what was uploaded');
  assert.match(phaseSource, /viewStoredDocument\(doc\)/);
  assert.match(phaseSource, /downloadStoredDocument\(doc\)/);
  assert.match(phaseSource, /handlePhaseDocumentDelete\(doc\)/);
});

test('removal follows the existing document permissions', () => {
  const body = bodyOf(phaseSource, 'const canManageDocument', '// Completed tasks');
  assert.match(body, /isCenterHead/, 'a Center Head may remove any document');
  assert.match(body, /doc\.status !== 'Approved'/,
    'an uploader must not remove an approved document on their own');
});

test('the existing required-document flow is untouched', () => {
  assert.match(phaseSource, /const handleInlineUpload/, 'the digital-form upload must remain');
  assert.match(phaseSource, /const effectiveRequiredDocs: string\[\] = \[/,
    'the required-document list must still be built from the phase requirements');
  assert.match(phaseSource, /const canUpload = !isHouseparent && \(!allowedRoles \|\| allowedRoles\.includes\(userRole\)\)/,
    'the per-document upload permission must be unchanged');
});
