/**
 * The recovery path for an approved TRI whose document never got filed.
 *
 * ## Why this exists
 *
 * `finalize` publishes the official form into the resident's Documents inside a
 * non-fatal `catch`, so a rendering fault can never roll back a reviewer's
 * approval. That is the right call — but it means a publish failure leaves the
 * record Finalized with no document and nothing that retries it. When
 * `backend/Dockerfile` was missing `frontend/src/shared/triLayout.json`, every
 * approval on the deployed backend took exactly that path: `200` with
 * `documentId: null`, no document, and a reviewer told the TRI was approved.
 *
 * Two things are pinned here, and they fail in different ways:
 *
 *   1. `publishMissingTriDocuments()` files the missing documents. This is a
 *      *workflow*, so it is tested behaviourally against a stateful store — a stub
 *      that answers `[]` to everything cannot tell "the repair works" from
 *      "nothing was ever selected", and every assertion would pass vacuously.
 *   2. The failure is reported, not only logged. The client gets `documentError`
 *      and `Tri.tsx` shows it; without that the next such fault is invisible again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-tri-recovery';

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const DB_MODULE_PATH = path.join(SRC_ROOT, 'config', 'database.js');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

// ── a store that actually applies the writes ──────────────────────────────────

/**
 * Answers the queries the repair and the publisher issue, and applies the INSERT
 * so a second run sees the document and selects nothing. Anything unmodelled
 * throws with the SQL attached, so a new query in the controller is a loud failure
 * rather than a silently-passing test.
 */
/**
 * Splits on top-level commas only, ignoring commas inside quotes or parentheses.
 *
 * A plain `split(',')` is not enough here: the publisher's INSERT interleaves
 * literals with placeholders — `VALUES (?, ?, ?, ?, ?, 'TRI', 'Assessment', ?, …)`
 * — so columns and bound values are *not* at the same index. Pairing them
 * positionally writes `status` from the wrong parameter, which is the same class
 * of bug the store exists to catch. The placeholders have to be walked in order.
 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function createStore({ triRecords, children = [], admissions = [] }) {
  const documents = [];

  const query = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();

    // The repair's own selection.
    if (/FROM triRecords t LEFT JOIN documents d/.test(text)) {
      const rows = triRecords.filter((t) =>
        t.status === 'Finalized' && !documents.some((d) => d.triRecordId === t.id));
      return [rows, []];
    }
    // The publisher, step by step.
    if (/^SELECT name FROM children WHERE id = \?/.test(text)) {
      return [children.filter((c) => c.id === params[0]).map((c) => ({ name: c.name })), []];
    }
    if (/^SELECT id FROM documents WHERE triRecordId = \?/.test(text)) {
      return [documents.filter((d) => d.triRecordId === params[0]).map((d) => ({ id: d.id })), []];
    }
    if (/^SELECT id FROM admissions WHERE residentId = \?/.test(text)) {
      return [admissions.filter((a) => a.residentId === params[0]).map((a) => ({ id: a.id })), []];
    }
    // `insertWithGeneratedId` reads the existing ids before allocating one.
    if (/^SELECT id FROM documents$/.test(text)) {
      return [documents.map((d) => ({ id: d.id })), []];
    }
    if (/^INSERT INTO documents/.test(text)) {
      const columnsOpen = text.indexOf('(');
      const columnsClose = text.indexOf(')', columnsOpen);
      const columns = splitTopLevel(text.slice(columnsOpen + 1, columnsClose));

      const valuesOpen = text.indexOf('(', text.indexOf('VALUES', columnsClose));
      const values = splitTopLevel(text.slice(valuesOpen + 1, text.lastIndexOf(')')));

      const row = {};
      let bound = 0;
      values.forEach((value, index) => {
        // A literal keeps its own value; only `?` consumes the next parameter.
        row[columns[index]] = value === '?' ? params[bound++] : value.replace(/^'|'$/g, '');
      });
      documents.push(row);
      return [{ affectedRows: 1 }, []];
    }
    if (/^UPDATE documents SET/.test(text)) {
      return [{ affectedRows: 1 }, []];
    }

    throw new Error(`the store does not model this query:\n${text}\nparams: ${JSON.stringify(params)}`);
  };

  return { query, documents };
}

function loadControllerWith(store) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_ROOT) && !key.includes('node_modules')) delete require.cache[key];
  }
  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH,
    filename: DB_MODULE_PATH,
    loaded: true,
    exports: { pool: store, dbConfig: {}, testConnection: async () => true },
  };
  return require('../src/controllers/triController');
}

function triRecord(overrides = {}) {
  return {
    id: 'TRI900',
    residentId: 'CH900',
    reportingYear: 2026,
    reportingMonth: 9,
    status: 'Finalized',
    responses: JSON.stringify({ deductions: 0 }),
    submittedBy: 'houseparent1',
    finalizedBy: 'centerhead',
    reviewedBy: 'centerhead',
    houseparentSignature: null,
    ...overrides,
  };
}

// ── the repair ────────────────────────────────────────────────────────────────

test('an approved TRI with no document is filed by the repair', async () => {
  const store = createStore({
    triRecords: [triRecord()],
    children: [{ id: 'CH900', name: 'Test Resident' }],
    admissions: [{ id: 'ADM900', residentId: 'CH900' }],
  });
  const controller = loadControllerWith(store);

  const result = await controller.publishMissingTriDocuments();

  assert.equal(result.missing, 1, 'the repair did not select the approved TRI that has no document');
  assert.equal(result.filed, 1, 'the repair selected the record but did not file it');
  assert.equal(store.documents.length, 1, 'no document row was written');
  assert.equal(store.documents[0].triRecordId, 'TRI900', 'the document is not linked back to the TRI');
  assert.equal(store.documents[0].residentId, 'CH900', 'the document is filed against the wrong resident');
  assert.equal(store.documents[0].status, 'Approved', 'a published TRI document must be Approved');
  assert.equal(
    store.documents[0].submittedBy,
    'houseparent1',
    'submittedBy must stay the Houseparent who prepared the TRI, not the reviewer',
  );
});

test('the repair is idempotent — a second run files nothing', async () => {
  const store = createStore({
    triRecords: [triRecord()],
    children: [{ id: 'CH900', name: 'Test Resident' }],
  });
  const controller = loadControllerWith(store);

  await controller.publishMissingTriDocuments();
  const second = await controller.publishMissingTriDocuments();

  assert.equal(second.missing, 0, 'the repair re-selected a TRI that already has a document');
  assert.equal(second.filed, 0, 'the repair filed a second copy');
  assert.equal(store.documents.length, 1, 'a second document row was written for the same TRI');
});

test('the repair leaves an unapproved TRI alone', async () => {
  const store = createStore({
    triRecords: [
      triRecord({ id: 'TRI901', status: 'Submitted' }),
      triRecord({ id: 'TRI902', status: 'Draft' }),
      triRecord({ id: 'TRI903', status: 'Returned' }),
    ],
    children: [{ id: 'CH900', name: 'Test Resident' }],
  });
  const controller = loadControllerWith(store);

  const result = await controller.publishMissingTriDocuments();

  assert.equal(result.missing, 0, 'the repair selected a TRI that is not Finalized');
  assert.equal(store.documents.length, 0, 'a document was filed for an unapproved TRI');
});

test('one unrenderable record does not stop the others', async () => {
  const store = createStore({
    triRecords: [
      triRecord({ id: 'TRI910', residentId: 'CH900' }),
      triRecord({ id: 'TRI911', residentId: 'CH901' }),
    ],
    children: [{ id: 'CH900', name: 'A' }, { id: 'CH901', name: 'B' }],
  });

  // Fail the first publisher call only, by making its child lookup blow up.
  const inner = store.query;
  let calls = 0;
  store.query = async (sql, params) => {
    if (/^SELECT name FROM children/.test(String(sql).replace(/\s+/g, ' ').trim()) && calls++ === 0) {
      throw new Error('simulated render failure');
    }
    return inner(sql, params);
  };

  const controller = loadControllerWith(store);
  const result = await controller.publishMissingTriDocuments();

  assert.equal(result.missing, 2, 'both approved TRIs should have been selected');
  assert.equal(result.filed, 1, 'the repair did not continue past the failing record');
  assert.equal(store.documents.length, 1, 'the healthy record was not filed');
});

test('a database that has never used the TRI module is not an error', async () => {
  const controller = loadControllerWith({
    query: async () => { throw new Error("Table 'sch_path_db.triRecords' doesn't exist"); },
  });

  const result = await controller.publishMissingTriDocuments();
  assert.deepEqual(result, { missing: 0, filed: 0 }, 'a missing table must be treated as nothing to repair');
});

// ── the failure must be reported, not only logged ─────────────────────────────

test('finalize reports the publish failure to the caller', () => {
  const source = read('src/controllers/triController.js');
  const start = source.indexOf('async function finalize');
  assert.ok(start > 0, 'finalize is gone');
  const body = source.slice(start, source.indexOf('\nasync function referenceViolations', start));

  assert.match(
    body,
    /documentError = perr\.message/,
    'the publish failure is no longer captured — a silent failure is what let a broken ' +
      'Docker asset go unnoticed for a week',
  );
  assert.match(
    body,
    /res\.json\(\{[^}]*documentError\s*\}\)/,
    'finalize does not return documentError, so the client cannot tell the file did not land',
  );
  assert.match(body, /status = 'Finalized'/, 'finalize no longer sets the status');
});

test('the TRI screen warns when the form was not filed', () => {
  const source = read('../frontend/src/app/components/Tri.tsx');

  assert.match(
    source,
    /documentId\?: string \| null/,
    'the finalize response type no longer declares documentId, so the UI cannot branch on it',
  );
  assert.match(
    source,
    /if \(result\.documentId\)/,
    'Tri.tsx no longer branches on whether the document was filed — approving would ' +
      'report success even when nothing reached the resident\'s folder',
  );
  assert.match(
    source,
    /was not filed/,
    'the warning shown when the document is missing is gone',
  );
  assert.match(
    source,
    /tone: 'warning'/,
    'the unfiled-document case is no longer presented as a warning, so it reads as success',
  );
});
