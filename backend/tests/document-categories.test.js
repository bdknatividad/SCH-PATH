/**
 * Documents are organised Child → Document Category → File.
 *
 * This file pins the whole refactor:
 *
 *   - the folder list and the routing rules are ONE definition, shared
 *     byte-for-byte with the frontend, so the API and the folder view can never
 *     file the same document in two different places
 *   - every publisher (TRI, Anecdotal Report, QPR, Incident Report) files the
 *     record it generates, and records WHO submitted it — the folder view shows
 *     "Submitted By" per file and the publisher used to leave it empty
 *   - a rejection requires a reason and is never erased: not by a resubmission,
 *     not by a later approval, and not by deleting the document
 *   - every transition lands in `documentRevisions` with its actor and date, so
 *     the audit trail is complete rather than reconstructed from current state
 *
 * The resolver is pure and is exercised directly. The controller paths run
 * against an injected pool stub — no MySQL and no network. The wiring (which
 * publisher writes which column, which row the folder view renders) is asserted
 * at source level, which is this project's established way of pinning a rule
 * that has no frontend test runner behind it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DB_MODULE_PATH = require.resolve('../src/config/database');

const BACKEND_JSON = path.join(SRC_ROOT, 'config', 'documentCategories.json');
const FRONTEND_JSON = path.join(REPO_ROOT, 'frontend', 'src', 'app', 'config', 'documentCategories.json');
const FRONTEND_TS = path.join(REPO_ROOT, 'frontend', 'src', 'utils', 'documentCategory.ts');
const FOLDER_VIEW = path.join(REPO_ROOT, 'frontend', 'src', 'app', 'components', 'DocumentUpload.tsx');

const read = (file) => fs.readFileSync(file, 'utf8');
const controller = (name) => read(path.join(SRC_ROOT, 'controllers', name));

// ── Injected pool stub ─────────────────────────────────────────────────────
//
// Stateful enough to be worth something: `UPDATE documents SET ...` is actually
// applied to the stored row, so a test can drive a document through a whole
// lifecycle and then read back what the controller left behind. Anything the
// stub does not recognise throws, so a new query in a controller path shows up
// as a failure here rather than as a silent empty result.

let documents = [];
let revisions = [];
let issued = [];

/** Split `a = ?, b = NOW(), c = 'x'` on top-level commas only. */
function splitAssignments(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function applyAssignments(row, assignmentText, params) {
  let index = 0;
  for (const part of splitAssignments(assignmentText)) {
    const match = part.match(/^\s*([A-Za-z0-9_]+)\s*=\s*([\s\S]*)$/);
    if (!match) continue;
    const column = match[1];
    const value = match[2].trim();
    if (value === '?') row[column] = params[index++];
    else if (/^NULL$/i.test(value)) row[column] = null;
    else if (/^NOW\(\)$/i.test(value) || /^CURRENT_TIMESTAMP$/i.test(value)) row[column] = '2026-09-22 10:00:00';
    else if (/^'.*'$/.test(value)) row[column] = value.slice(1, -1);
    // Anything else is a SQL function this stub does not model; leave it alone.
  }
  return row;
}

const poolStub = {
  async query(sql, params = []) {
    const text = String(sql);
    issued.push(text);

    if (/SELECT \* FROM documents WHERE id = \?/i.test(text)) {
      return [documents.filter(row => row.id === params[0])];
    }

    if (/UPDATE documents\b/i.test(text)) {
      const setIndex = text.search(/\bSET\b/i);
      const whereIndex = text.search(/\bWHERE id = \?/i);
      const assignments = text.slice(setIndex + 3, whereIndex);
      const row = documents.find(r => r.id === params[params.length - 1]);
      if (row) applyAssignments(row, assignments, params);
      return [{ affectedRows: row ? 1 : 0 }];
    }

    if (/SELECT id FROM documentRevisions/i.test(text)) {
      return [revisions.map(r => ({ id: r.id }))];
    }

    if (/INSERT INTO documentRevisions/i.test(text)) {
      revisions.push({
        id: params[0], documentId: params[1], revision: params[2], action: params[3],
        status: params[4], actor: params[5], actorRole: params[6], reason: params[7],
        notes: params[8], createdAt: '2026-09-22 10:00:00',
      });
      return [{ affectedRows: 1 }];
    }

    if (/FROM documentRevisions/i.test(text)) {
      return [revisions.filter(r => r.documentId === params[0])];
    }

    if (/FROM accessRequests/i.test(text)) return [[]];
    if (/FROM children/i.test(text)) return [[{ name: 'Child One' }]];
    if (/FROM users/i.test(text)) return [[]];
    if (/FROM residentAssignments/i.test(text)) return [[]];
    if (/UPDATE incidentReports/i.test(text)) return [{ affectedRows: 1 }];
    if (/FROM incidentReports/i.test(text)) return [[]];
    if (/FROM documents\b/i.test(text)) return [[]];
    // Notifications are a side effect of a decision, not part of it; the tests
    // here are about the document row and its audit trail.
    if (/INSERT INTO alertReads/i.test(text)) return [{ affectedRows: 0 }];
    if (/UPDATE alerts/i.test(text)) return [{ affectedRows: 0 }];
    if (/INSERT INTO alerts/i.test(text)) return [{ affectedRows: 1 }];
    if (/FROM alerts/i.test(text)) return [[]];

    throw new Error(`UNHANDLED SQL in the document-category stub: ${text}`);
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

const docs = require('../src/controllers/documentController');
const { categoryForDocument, folderForDocument, folderForType, DOCUMENT_FOLDERS, DEFAULT_DOCUMENT_FOLDER } =
  require('../src/utils/documentCategory');

// ── The shared definition ──────────────────────────────────────────────────

test('the backend and the frontend read the same folder definition', () => {
  const backend = fs.readFileSync(BACKEND_JSON);
  const frontend = fs.readFileSync(FRONTEND_JSON);
  assert.ok(
    backend.equals(frontend),
    'documentCategories.json has diverged: the API and the folder view would file the ' +
      'same document under different folders'
  );
  assert.deepEqual(JSON.parse(backend.toString()), JSON.parse(frontend.toString()));
});

test('the folder list is the eleven canonical folders, in order', () => {
  assert.deepEqual(DOCUMENT_FOLDERS, [
    'Admission Files',
    'TRI Records',
    'Anecdotal Reports',
    'Assessments',
    'Medical Records',
    'Educational Records',
    'Behavioral Records',
    'Violation Records',
    'Intervention Records',
    'Quarterly Reports',
    'Other Documents',
  ]);
});

test('the default folder is a real folder', () => {
  assert.ok(
    DOCUMENT_FOLDERS.includes(DEFAULT_DOCUMENT_FOLDER),
    `the fallback folder "${DEFAULT_DOCUMENT_FOLDER}" is not in the folder list, so an ` +
      'unrecognised document would be filed somewhere the UI never renders'
  );
});

test('the frontend resolver is the same three-pass rule, not a second copy', () => {
  const source = read(FRONTEND_TS);
  assert.match(
    source,
    /import definition from '@\/app\/config\/documentCategories\.json'/,
    'the frontend stopped reading the shared definition'
  );
  assert.match(source, /export function categoryForDocument/, 'the frontend resolver is gone');
  assert.match(source, /export function folderForDocument/, 'the frontend folder coercion is gone');
  assert.match(source, /export const DOCUMENT_FOLDERS/, 'the frontend no longer exports the folder list');
  // A local rule table would be the drift this whole arrangement exists to stop.
  assert.doesNotMatch(source, /'Houseparent Record'/, 'an ad-hoc frontend-only category is back');
  assert.doesNotMatch(source, /'Court Document'/, 'an ad-hoc frontend-only category is back');
});

// ── Routing: the categories the user named ─────────────────────────────────

test('every document category the module publishes routes to its own folder', () => {
  const cases = [
    // [description, document, expected folder]
    ['an Admission Slip', { title: 'Admission Slip', category: 'Admission' }, 'Admission Files'],
    ['an Admission Slip Part 2', { title: 'Admission Slip Part 2', category: 'Admission - Required' }, 'Admission Files'],
    ['a Court Order', { title: 'Court Order', category: 'Admission - Required' }, 'Admission Files'],
    ['a TRI record', { title: 'TRI — September 2026 (system copy)', type: 'TRI', category: 'Assessment' }, 'TRI Records'],
    ['an Anecdotal Report', { title: 'Anecdotal Report — May 2026', type: 'Anecdotal Report', category: 'Anecdotal' }, 'Anecdotal Reports'],
    ['a Psychological Assessment', { title: 'Psychological Assessment', category: 'Assessment' }, 'Assessments'],
    ['a Medical Certificate', { title: 'Medical Certificate', category: 'Medical' }, 'Medical Records'],
    ['a Quarterly Education Report', { title: 'Quarterly Education Report', category: 'Educational' }, 'Educational Records'],
    ['a Violation Report', { title: 'Violation Report', category: 'Violation' }, 'Violation Records'],
    ['an Incident Report', { title: 'Incident Report', type: 'PDF', category: 'Incident Reports' }, 'Violation Records'],
    ['an Intervention Plan', { title: 'Intervention Plan', category: 'Intervention' }, 'Intervention Records'],
    ['a Quarterly Progress Report', { title: 'Quarterly Progress Report - Q3 2026', type: 'Quarterly Progress Report', category: 'Progress Report' }, 'Quarterly Reports'],
  ];

  for (const [label, document, expected] of cases) {
    assert.equal(categoryForDocument(document), expected, `${label} was filed in the wrong folder`);
  }
});

test('an explicit type outranks a category that belongs to another folder', () => {
  // A published TRI carries category "Assessment" and a QPR carries "Progress
  // Report" — neither of which is their folder. If the category pass ran first,
  // TRI records would land in Assessments and QPRs in the default folder.
  assert.equal(
    categoryForDocument({ type: 'TRI', category: 'Assessment', title: 'Anything' }),
    'TRI Records'
  );
  assert.equal(
    categoryForDocument({ type: 'Quarterly Progress Report', category: 'Progress Report' }),
    'Quarterly Reports'
  );
  assert.equal(
    categoryForDocument({ type: 'Anecdotal Report', category: 'Anecdotal' }),
    'Anecdotal Reports'
  );
});

test('a keyword in the title alone is enough to file a document', () => {
  assert.equal(categoryForDocument({ title: 'Laboratory Result' }), 'Medical Records');
  assert.equal(categoryForDocument({ title: 'X-ray Result' }), 'Medical Records');
  assert.equal(categoryForDocument({ title: 'Report Card' }), 'Educational Records');
  assert.equal(categoryForDocument({ title: 'Behavioral Incident Log' }), 'Behavioral Records');
  assert.equal(categoryForDocument({ title: 'Intervention Plan' }), 'Intervention Records');
  assert.equal(categoryForDocument({ title: 'Counseling Session Notes' }), 'Behavioral Records');
});

test('a home-visit form is a casework record, not an educational one', () => {
  // Its title contains "school", so the Educational rule would claim it if the
  // order of the rules were reversed.
  assert.equal(categoryForDocument({ title: 'Home/School Visit Form' }), 'Assessments');
  assert.equal(categoryForDocument({ title: 'Home Visitation Report' }), 'Assessments');
});

test('a file name is part of the searchable text', () => {
  assert.equal(
    categoryForDocument({ title: 'Scan 0001', fileName: 'laboratory-result.pdf' }),
    'Medical Records'
  );
});

test('an unrecognised document lands in the default folder, never nowhere', () => {
  assert.equal(categoryForDocument({ title: 'Miscellaneous', category: 'General' }), DEFAULT_DOCUMENT_FOLDER);
  assert.equal(categoryForDocument({}), DEFAULT_DOCUMENT_FOLDER);
  assert.equal(categoryForDocument(null), DEFAULT_DOCUMENT_FOLDER);
  assert.equal(categoryForDocument(undefined), DEFAULT_DOCUMENT_FOLDER);
});

test('a stored folder is trusted, and anything else is resolved', () => {
  // A document filed before a rule changed must not silently move.
  assert.equal(
    folderForDocument({ documentCategory: 'Medical Records', title: 'Report Card' }),
    'Medical Records'
  );
  // A legacy row with no folder (or a stale one) is resolved from its own fields.
  assert.equal(folderForDocument({ title: 'Report Card' }), 'Educational Records');
  assert.equal(
    folderForDocument({ documentCategory: 'Not A Folder', title: 'Report Card' }),
    'Educational Records'
  );
  assert.equal(folderForDocument({ documentCategory: '   ' }), DEFAULT_DOCUMENT_FOLDER);
});

test('a publisher can ask for its own folder without writing a literal', () => {
  assert.equal(folderForType('TRI'), 'TRI Records');
  assert.equal(folderForType('Anecdotal Report'), 'Anecdotal Reports');
  assert.equal(folderForType('Quarterly Progress Report'), 'Quarterly Reports');
  assert.equal(folderForType('Violation Report'), 'Violation Records');
  assert.equal(folderForType('Nothing Like This'), DEFAULT_DOCUMENT_FOLDER);
});

// ── The publishers file what they generate ─────────────────────────────────

test('the TRI publisher files the report and records who submitted it', () => {
  const source = controller('triController.js');
  assert.match(source, /const \{ folderForType \} = require\('\.\.\/utils\/documentCategory'\)/);
  assert.match(source, /const TRI_FOLDER = folderForType\('TRI'\)/, 'the TRI folder is hardcoded again');
  assert.match(source, /documentCategory = \?,/, 'the TRI re-publish no longer files the document');
  assert.match(source, /submittedBy = \?, modifiedBy = \?/, 'the TRI re-publish no longer records who submitted the document');
  assert.match(source, /category, documentCategory, description/, 'the TRI insert no longer files the document');
  assert.match(
    source,
    /record\.submittedBy \|\| null, actor,/,
    'the TRI insert no longer records the Houseparent who prepared it as the submitter'
  );
  // The published copy is Approved from the moment it is written, so it has to name
  // its approver — the Documents module prints these under "Approved By" and
  // "Approval Date", and a row with a submitter and no approver is what the user sees.
  assert.match(source, /approvedBy = \?, approvedAt = NOW\(\)/, 'the TRI re-publish no longer records the approver');
  assert.match(source, /approvedBy, approvedAt/, 'the TRI insert no longer records the approver');
});

test('the Anecdotal Report publisher files the report and records who submitted it', () => {
  const source = controller('anecdotalReportController.js');
  assert.match(source, /const ANECDOTAL_FOLDER = folderForType\('Anecdotal Report'\)/);
  assert.match(source, /const submittedBy = report\.submittedBy \|\| report\.createdBy \|\| actor/);
  assert.match(source, /documentCategory = \?,/, 'the Anecdotal re-publish no longer files the document');
  assert.match(source, /submittedBy = \?, modifiedBy = \?/, 'the Anecdotal re-publish no longer records who submitted the document');
  assert.match(source, /category, documentCategory, description/, 'the Anecdotal insert no longer files the document');
  assert.match(source, /approvedBy = \?, approvedAt = NOW\(\)/, 'the Anecdotal re-publish no longer records the approver');
  assert.match(source, /approvedBy, approvedAt/, 'the Anecdotal insert no longer records the approver');
});

test('the QPR publisher files the report and records who submitted it', () => {
  const source = controller('quarterlyProgressReportController.js');
  assert.match(source, /const QUARTERLY_FOLDER = folderForType\('Quarterly Progress Report'\)/);
  assert.match(source, /const submittedBy = text\(report\.submittedBy\) \|\| text\(report\.preparedByName\) \|\| actorName/);
  assert.match(source, /documentCategory = \?,/, 'the QPR re-publish no longer files the document');
  assert.match(source, /submittedBy = \?, modifiedBy = \?/, 'the QPR re-publish no longer records who submitted the document');
  assert.match(source, /category, documentCategory, description/, 'the QPR insert no longer files the document');
  assert.match(source, /approvedBy = \?, approvedAt = NOW\(\)/, 'the QPR re-publish no longer records the approver');
  assert.match(source, /approvedBy, approvedAt/, 'the QPR insert no longer records the approver');
});

test('the Incident Report publisher files the report as a violation record', () => {
  const source = controller('incidentReportController.js');
  assert.match(source, /const VIOLATION_FOLDER = folderForType\('Violation Report'\)/);
  assert.match(source, /category, documentCategory, description/, 'the Incident Report insert no longer files the document');
  assert.match(source, /documentCategory = \?, submittedBy = \?, submittedAt = NOW\(\)/, 'the Incident Report resubmission no longer re-files the document');
  assert.doesNotMatch(
    source,
    /rejectionReason = NULL/,
    'resubmitting an Incident Report erases the previous rejection again — the reason is ' +
      'part of the record and the folder view shows it'
  );
});

test('the controller files a hand-uploaded document and refuses to trust a client folder', () => {
  const source = controller('documentController.js');
  assert.match(source, /const \{ categoryForDocument, folderForDocument, DOCUMENT_FOLDERS \} = require\('\.\.\/utils\/documentCategory'\)/);
  assert.match(
    source,
    /documentCategory/,
    'the create path no longer stamps a folder'
  );
  assert.match(
    source,
    /columns\.filter\(\(column\) => column !== 'documentCategory'\)|!== 'documentCategory'/,
    'the create path accepts a client-supplied folder, so a caller could file a document anywhere'
  );
});

// ── A rejection is required, permanent, and auditable ─────────────────────

function resetState(document) {
  documents = [{ ...document }];
  revisions = [];
  issued = [];
}

/** A minimal Express-like response that records what the handler wrote. */
function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

/** Run a controller handler and resolve with whatever it reported. */
function run(handler, req) {
  return new Promise((resolve) => {
    const res = makeRes();
    handler(req, res, (error) => {
      res.statusCode = error?.statusCode || 500;
      res.body = { error: error?.message || String(error) };
      resolve(res);
    });
    // Handlers that succeed call res.json synchronously before returning.
    setImmediate(() => resolve(res));
  });
}

const REVIEWER = { id: 'U1', username: 'head.one', role: 'centerhead' };

test('a rejection without a reason is refused and nothing is written', async () => {
  resetState({ id: 'DOC1', title: 'Court Order', status: 'Submitted', revision: 1 });

  for (const body of [{}, { rejectionReason: '' }, { rejectionReason: '   ' }, { rejectionReason: null }]) {
    resetState({ id: 'DOC1', title: 'Court Order', status: 'Submitted', revision: 1 });
    const res = await run(docs.reject, { params: { id: 'DOC1' }, body, user: REVIEWER });
    assert.equal(res.statusCode, 400, `a rejection with ${JSON.stringify(body)} was accepted`);
    assert.ok(
      !issued.some(sql => /UPDATE documents/i.test(sql)),
      'a rejected-without-reason request still wrote to the document'
    );
  }
});

test('a rejection stores the reason, the reviewer and the date', async () => {
  resetState({ id: 'DOC1', title: 'Court Order', status: 'Submitted', revision: 1 });

  const res = await run(docs.reject, {
    params: { id: 'DOC1' },
    body: { rejectionReason: 'Missing page 2.' },
    user: REVIEWER,
  });

  assert.equal(res.statusCode, 200, res.body?.error);
  const row = documents[0];
  assert.equal(row.status, 'Rejected');
  assert.equal(row.rejectionReason, 'Missing page 2.');
  assert.equal(row.rejectedBy, 'head.one');
  assert.ok(row.rejectedAt, 'no rejection date was stored');
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].action, 'Rejected');
  assert.equal(revisions[0].reason, 'Missing page 2.');
  assert.equal(revisions[0].actor, 'head.one');
  assert.ok(revisions[0].createdAt, 'the audit row has no date');
});

test('a resubmission keeps the rejection and advances the revision', async () => {
  resetState({
    id: 'DOC1', title: 'Court Order', status: 'Rejected', revision: 1,
    rejectionReason: 'Missing page 2.', rejectedBy: 'head.one', rejectedAt: '2026-09-20 09:00:00',
  });

  const res = await run(docs.submit, { params: { id: 'DOC1' }, body: {}, user: { id: 'U2', username: 'sw.one', role: 'socialworker' } });
  assert.equal(res.statusCode, 200, res.body?.error);

  const row = documents[0];
  assert.equal(row.status, 'Under Review');
  assert.equal(row.revision, 2, 'the resubmission did not start a new revision');
  assert.equal(row.rejectionReason, 'Missing page 2.', 'the rejection reason was erased by the resubmission');
  assert.equal(row.rejectedBy, 'head.one', 'the rejecting reviewer was erased by the resubmission');

  const actions = revisions.map(r => r.action);
  assert.deepEqual(actions, ['Resubmitted'], `the trail recorded ${JSON.stringify(actions)}`);
  assert.equal(
    revisions[0].reason,
    'Missing page 2.',
    'the trail no longer carries the reason that prompted the resubmission'
  );
});

test('a document that is rejected then approved still shows the rejection', async () => {
  resetState({
    id: 'DOC1', title: 'Court Order', status: 'Rejected', revision: 2,
    rejectionReason: 'Missing page 2.', rejectedBy: 'head.one', rejectedAt: '2026-09-20 09:00:00',
  });

  await run(docs.submit, { params: { id: 'DOC1' }, body: {}, user: { id: 'U2', username: 'sw.one', role: 'socialworker' } });
  const res = await run(docs.approve, { params: { id: 'DOC1' }, body: {}, user: REVIEWER });
  assert.equal(res.statusCode, 200, res.body?.error);

  const actions = revisions.map(r => r.action);
  assert.deepEqual(actions, ['Resubmitted', 'Approved'], `the trail lost a step: ${JSON.stringify(actions)}`);
  assert.equal(
    documents[0].rejectionReason,
    'Missing page 2.',
    'approving the resubmission erased the earlier rejection'
  );
});

test('a rejected document cannot be deleted, and nothing is removed', async () => {
  resetState({ id: 'DOC1', title: 'Court Order', status: 'Rejected', revision: 2 });

  const res = await run(docs.delete, { params: { id: 'DOC1' }, body: {}, user: REVIEWER });
  assert.equal(res.statusCode, 409, 'a rejected document was deletable');
  assert.ok(
    !issued.some(sql => /DELETE FROM documents/i.test(sql)),
    'the delete was refused but the row was removed anyway'
  );
  assert.equal(documents.length, 1);
});

test('the audit trail reads back oldest first, with the current state alongside', async () => {
  resetState({ id: 'DOC1', title: 'Court Order', status: 'Submitted', revision: 1 });
  await run(docs.reject, { params: { id: 'DOC1' }, body: { rejectionReason: 'Missing page 2.' }, user: REVIEWER });
  await run(docs.submit, { params: { id: 'DOC1' }, body: {}, user: { id: 'U2', username: 'sw.one', role: 'socialworker' } });

  const res = await run(docs.getHistory, { params: { id: 'DOC1' }, body: {}, user: REVIEWER });
  assert.equal(res.statusCode, 200, res.body?.error);
  assert.equal(res.body.success, true);
  assert.equal(res.body.count, 2);
  assert.deepEqual(res.body.data.map(r => r.action), ['Rejected', 'Resubmitted']);
  assert.ok(res.body.document, 'the trail is returned without the document it describes');
  assert.equal(res.body.document.rejectionReason, 'Missing page 2.');
});

test('every transition is recorded, and a failed audit write does not fail the request', () => {
  const source = controller('documentController.js');
  const calls = source.match(/action: '(Uploaded|Submitted|Resubmitted|Approved|Rejected|Reassessment|Updated|Archived)'/g) || [];
  const distinct = new Set(calls.map(call => call.split("'")[1]));

  for (const action of ['Uploaded', 'Submitted', 'Resubmitted', 'Approved', 'Rejected']) {
    assert.ok(distinct.has(action), `no transition ever records "${action}"`);
  }
  assert.match(
    source,
    /catch \(error\) \{\s*console\.error\('\[DocumentController\] Audit trail write failed \(non-fatal\)/,
    'an audit-trail failure is no longer swallowed, so it could roll back a successful approval'
  );
  assert.match(source, /function revisionSnapshot/, 'the per-revision snapshot is gone');
  assert.match(
    source,
    /const \{ fileData, \.\.\.rest \} = document/,
    'the snapshot no longer strips fileData, so every revision would store a megabyte of base64'
  );
});

// ── Persistence: schema, migrations, and the list API ─────────────────────

test('the schema carries the folder, the revision and the rejection fields', () => {
  const schema = read(path.join(SRC_ROOT, 'database', 'schema.sql'));
  for (const column of ['documentCategory VARCHAR(100) NULL', 'revision INT NOT NULL DEFAULT 1', 'rejectedBy VARCHAR(100) NULL', 'rejectedAt TIMESTAMP NULL']) {
    assert.ok(schema.includes(column), `documents is missing ${column}`);
  }
  assert.match(schema, /CREATE TABLE documentRevisions/, 'the audit-trail table is missing from the schema');
  assert.match(
    schema,
    /action ENUM\('Uploaded', 'Submitted', 'Resubmitted', 'Approved', 'Rejected', 'Reassessment', 'Updated', 'Archived'\)/,
    'the audit-trail action list is incomplete'
  );
  assert.match(schema, /snapshot JSON NULL/, 'the audit trail cannot hold a previous version');
  assert.match(
    schema,
    /CONSTRAINT fk_document_revisions_document FOREIGN KEY \(documentId\) REFERENCES documents\(id\) ON DELETE CASCADE/,
    'the audit trail is not tied to its document'
  );
});

test('the server migrates an existing database, and backfills the folders', () => {
  const server = read(path.join(SRC_ROOT, 'server.js'));
  for (const column of ['documentCategory', 'revision', 'rejectedBy', 'rejectedAt']) {
    assert.match(
      server,
      new RegExp(`ensureColumn\\('documents', '${column}'`),
      `an existing database never gains documents.${column}`
    );
  }
  assert.match(server, /CREATE TABLE IF NOT EXISTS documentRevisions/, 'the audit-trail table is never created at boot');
  assert.match(
    server,
    /UPDATE documents SET documentCategory = \? WHERE id = \?/,
    'existing documents are never re-filed, so the migration would leave every pre-existing ' +
      'file unfiled and invisible in the folder view'
  );
  assert.match(
    server,
    /categoryForDocument/,
    'the backfill does not use the shared resolver, so migrated files could land in different ' +
      'folders than newly uploaded ones'
  );
});

test('the list API returns the new columns', () => {
  // `/store` selects its columns explicitly. A column that is not listed never
  // reaches the client, and `mapRow` would then drop it even if it were.
  const routes = read(path.join(SRC_ROOT, 'routes', 'index.js'));
  const from = routes.indexOf('FROM documents ORDER BY');
  assert.ok(from > 0, 'the /store documents query is gone');
  const select = routes.slice(routes.lastIndexOf('SELECT', from), from);
  for (const column of ['documentCategory', 'revision', 'rejectedBy', 'rejectedAt']) {
    assert.ok(select.includes(column), `the /store documents query does not return ${column}`);
  }

  const constants = require('../src/utils/constants');
  for (const column of ['documentCategory', 'revision', 'rejectedBy', 'rejectedAt']) {
    assert.ok(
      constants.RESOURCES.documents.columns.includes(column),
      `constants.RESOURCES.documents is missing ${column}, so mapRow would strip it`
    );
  }
  assert.ok(
    constants.RESOURCES.documentRevisions,
    'there is no resource definition for the audit trail, so the history endpoint cannot map a row'
  );
  assert.ok(
    constants.RESOURCES.documentRevisions.columns.includes('reason'),
    'the audit-trail resource drops the rejection reason'
  );
});

// ── The folder view ───────────────────────────────────────────────────────

test('the folder view is Child to Category to File, not Child to Uploader to File', () => {
  const source = read(FOLDER_VIEW);

  assert.doesNotMatch(
    source,
    /byUploader/,
    'the folder view groups by uploader again — a child\'s record is then scattered across as ' +
      'many folders as there are people who uploaded something'
  );
  assert.doesNotMatch(
    source,
    /d\.uploadedBy \|\| d\.uploaderRole \|\| 'Unknown'/,
    'the uploader grouping is back'
  );
  assert.doesNotMatch(source, /offenseGroups/, 'the per-admission sub-grouping is back');
  assert.doesNotMatch(
    source,
    /'Houseparent Record'/,
    'the folder view still uses the old ad-hoc category list instead of the shared folders'
  );

  assert.match(source, /import \{ DOCUMENT_FOLDERS, folderForDocument \} from '@\/utils\/documentCategory'/, 'the folder view no longer uses the shared resolver');
  assert.match(source, /const DOCUMENT_CATEGORIES = DOCUMENT_FOLDERS/, 'the folder view has its own category list again');
  // The grouping moved inside a reusable helper when the admission-period level
  // was inserted above the categories, so it is asserted by shape rather than by
  // the old `byCategory` identifier: one bucket per category, emitted in the
  // canonical order, never one bucket per uploader.
  assert.match(
    source,
    /const groupByCategory = \(docs: typeof allDocs\) => \{[\s\S]*?const groups = new Map<string, typeof allDocs>\(\);/,
    'the folder view does not group by category'
  );
  assert.match(
    source,
    /DOCUMENT_CATEGORIES\.filter\(f => groups\.has\(f\)\)/,
    'the folder view no longer emits the shared categories in their canonical order'
  );
  assert.match(
    source,
    /\.map\(folder => \(\{ folder, docs: groups\.get\(folder\)! \}\)\)/,
    'the folder view no longer produces one { folder, docs } entry per category'
  );
  assert.match(source, /deriveDocumentCategory\(d\)/, 'the folder view does not resolve each document to a folder');
});

test('the folder view shows the review metadata without opening the file', () => {
  const source = read(FOLDER_VIEW);
  const start = source.indexOf('function FolderDocumentRow');
  assert.ok(start > 0, 'the folder row component is gone');
  const row = source.slice(start, source.indexOf('export function DocumentUpload', start));

  for (const label of ['Date Submitted', 'Submitted By', 'Approved By', 'Rejected By', 'Approval Date', 'Rejection Date']) {
    assert.ok(row.includes(`'${label}'`), `the folder row does not show "${label}"`);
  }
  assert.match(row, /Reason for rejection/, 'the rejection reason is not shown on the row');
  assert.match(row, /doc\.rejectionReason/, 'the row does not read the stored rejection reason');
  assert.match(row, /doc\.submittedBy \|\| doc\.uploadedBy/, 'the row does not fall back for older rows with no submittedBy');
  assert.match(row, /doc\.rejectedBy \|\| doc\.reviewedBy/, 'the row does not fall back for older rows with no rejectedBy');
});

test('the folder view offers the audit history and refuses to delete a rejected file', () => {
  const source = read(FOLDER_VIEW);
  assert.match(source, /const openHistory = async/, 'there is no way to open a document\'s audit history');
  assert.match(source, /\/documents\/\$\{document\.id\}\/history/, 'the history dialog does not call the history endpoint');
  assert.match(source, /Audit History/, 'the history dialog is not rendered');
  assert.match(
    source,
    /canDelete && !isRejected/,
    'a rejected document is still deletable from the folder view, which would destroy the ' +
      'rejection it exists to record'
  );
});

test('the history endpoint is routed', () => {
  const routes = read(path.join(SRC_ROOT, 'routes', 'documentRoutes.js'));
  assert.match(
    routes,
    /router\.get\('\/:id\/history'/,
    'the history endpoint is not routed, so the audit trail is unreachable from the UI'
  );
  // It has to be declared before the greedy `/:id` route, or Express would treat
  // "history" as a document id.
  assert.ok(
    routes.indexOf("'/:id/history'") < routes.indexOf("'/:id/file'"),
    'the history route is declared after a conflicting path and would never match'
  );
});
