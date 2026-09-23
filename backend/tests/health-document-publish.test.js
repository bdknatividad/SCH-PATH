/**
 * Health records must reach the resident's Documents folder.
 *
 * Reported gap: a Nurse saved a health or medical record, the record was stored,
 * and it never appeared in Documents → Child Folder → Medical Records. The Health
 * module showed it and the Documents module did not, so the child's file — which
 * is what the Center Head and the Social Worker actually read — was missing every
 * nurse-generated record.
 *
 * The cause was that `healthController` wrote `healthRecords` and nothing else.
 * Every other module that produces a record a reviewer reads publishes it into
 * the folder (TRI, Anecdotal Report, QPR, Incident Report); health records were
 * the one that did not.
 *
 * What is pinned here, because each can go quietly wrong:
 *
 *   1. The folder. Health record types are not folder names, so routing on the
 *      type would leave "Height & Weight Monitoring" in Other Documents. The
 *      folder is resolved from the stamped category instead.
 *   2. The category. It is what decides who may read the published record. A
 *      category that resolves to nobody, or to everybody, is a data-protection
 *      bug rather than a filing bug.
 *   3. A second copy. The publisher is idempotent through
 *      `documents.healthRecordId`, which is only a guarantee if the unique index
 *      exists — the lookup before insert is a read-then-write race.
 *   4. A save that loses the record. Publishing runs after the write; a PDF
 *      failure must not turn a stored record into a 500.
 *
 * The controller paths run against an injected pool stub — no MySQL and no
 * network. The generator is exercised for real and its output read back through
 * pdf-lib, so "a PDF was produced" means a PDF whose drawn text can be located.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DB_MODULE_PATH = require.resolve('../src/config/database');

const read = (rel) => fs.readFileSync(path.resolve(SRC_ROOT, rel), 'utf8');
const SERVER = read('server.js');
const CONTROLLER = read('controllers/healthController.js');
const ROUTES = read('routes/healthRoutes.js');
const GENERATOR = read('utils/healthRecordPdf.js');
const DOCUMENT_CONTROLLER = read('controllers/documentController.js');
const HEALTH_FORM = fs.readFileSync(
  path.join(REPO_ROOT, 'frontend', 'src', 'app', 'components', 'Health.tsx'),
  'utf8',
);

// ── Injected pool stub ─────────────────────────────────────────────────────
//
// Stateful enough to be worth something: the INSERT column list and the VALUES
// list are both read, so the stored row is what the controller actually wrote,
// and `UPDATE` is applied to that row rather than ignored. Anything the stub does
// not recognise throws, so a new query in a write path shows up here as a failure
// instead of as a silent empty result.

let healthRows = [];
let documentRows = [];
let issued = [];
let failDocumentInsert = false;

const CHILD = {
  name: 'Juan Dela Cruz',
  age: 16,
  gender: 'Male',
  birthDate: '2010-03-04',
  admissionDate: '2026-01-15',
  casePhase: 'Phase 2',
};

const NOW = '2026-09-22 10:00:00';

/** The admission the stub reports as the resident's active one. */
const TEST_ADMISSION_ID = 'ADM-TEST-1';

/** Split on top-level commas only — aware of parens, quotes and backticks. */
function splitTopLevel(text) {
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
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Turn an `INSERT INTO t (a, b) VALUES (?, 'x', NOW())` into a row object, in the
 * order the values were bound.
 */
function insertRow(text, params) {
  const columnsText = text.slice(text.indexOf('(') + 1, text.indexOf(')'));
  const valuesStart = text.search(/\bVALUES\b/i);
  const valuesText = text.slice(text.indexOf('(', valuesStart) + 1, text.lastIndexOf(')'));
  const columns = splitTopLevel(columnsText).map((c) => c.trim());
  const values = splitTopLevel(valuesText).map((v) => v.trim());

  const row = {};
  let index = 0;
  columns.forEach((column, position) => {
    const value = values[position];
    if (value === undefined) return;
    if (value === '?') row[column] = params[index++];
    else if (/^NULL$/i.test(value)) row[column] = null;
    else if (/^NOW\(\)$/i.test(value) || /^CURRENT_TIMESTAMP$/i.test(value)) row[column] = NOW;
    else if (/^'.*'$/.test(value)) row[column] = value.slice(1, -1);
    else row[column] = value;
  });
  return row;
}

/** Apply `SET a = ?, b = NOW()` to a stored row, in binding order. */
function applyUpdate(row, text, params) {
  const setIndex = text.search(/\bSET\b/i);
  const whereIndex = text.search(/\bWHERE\b/i);
  let index = 0;
  for (const part of splitTopLevel(text.slice(setIndex + 3, whereIndex))) {
    const match = part.match(/^\s*([A-Za-z0-9_]+)\s*=\s*([\s\S]*)$/);
    if (!match) continue;
    const value = match[2].trim();
    if (value === '?') row[match[1]] = params[index++];
    else if (/^NULL$/i.test(value)) row[match[1]] = null;
    else if (/^NOW\(\)$/i.test(value) || /^CURRENT_TIMESTAMP$/i.test(value)) row[match[1]] = NOW;
    else if (/^'.*'$/.test(value)) row[match[1]] = value.slice(1, -1);
  }
  return row;
}

const poolStub = {
  async query(sql, params = []) {
    const text = String(sql);
    issued.push(text);

    if (/SELECT id FROM healthRecords/i.test(text)) return [healthRows.map((r) => ({ id: r.id }))];
    if (/INSERT INTO healthRecords/i.test(text)) {
      const row = insertRow(text, params);
      healthRows.push(row);
      return [{ affectedRows: 1 }];
    }
    if (/SELECT \* FROM healthRecords WHERE id = \?/i.test(text)) {
      return [healthRows.filter((r) => r.id === params[0])];
    }
    if (/UPDATE healthRecords\b/i.test(text)) {
      const row = healthRows.find((r) => r.id === params[params.length - 1]);
      if (row) applyUpdate(row, text, params);
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (/DELETE FROM healthRecords/i.test(text)) {
      const before = healthRows.length;
      healthRows = healthRows.filter((r) => r.id !== params[0]);
      return [{ affectedRows: before - healthRows.length }];
    }

    if (/SELECT name, age, gender, birthDate, admissionDate, casePhase FROM children/i.test(text)) {
      return [[CHILD]];
    }

    // The admission a newly filed document is linked to. Documents are filed
    // Resident -> Admission -> Category -> File, so every publish path looks this
    // up before inserting; see src/services/admissionLink.js.
    if (/FROM admissions/i.test(text)) return [[{ id: TEST_ADMISSION_ID }]];

    // The re-publish lookup reads the columns it needs to decide whether the
    // record moved resident. A save that does not move it must be able to carry
    // the document's existing admissionId straight through, so the stub has to
    // hand back what the real query selects — returning only `id` would let a
    // regression through, because `previous.admissionId` would be undefined.
    if (/SELECT .* FROM documents WHERE healthRecordId = \?/i.test(text)) {
      const columns = text
        .slice(text.indexOf('SELECT') + 'SELECT'.length, text.indexOf('FROM'))
        .split(',')
        .map((column) => column.trim())
        .filter(Boolean);
      return [
        documentRows
          .filter((r) => r.healthRecordId === params[0])
          .map((r) => Object.fromEntries(columns.map((column) => [column, r[column]]))),
      ];
    }
    if (/SELECT id FROM documents/i.test(text)) return [documentRows.map((r) => ({ id: r.id }))];
    if (/INSERT INTO documents/i.test(text)) {
      if (failDocumentInsert) {
        const error = new Error('the documents table is unavailable');
        error.code = 'ER_NO_SUCH_TABLE';
        throw error;
      }
      documentRows.push(insertRow(text, params));
      return [{ affectedRows: 1 }];
    }
    if (/UPDATE documents\b/i.test(text)) {
      const row = documentRows.find((r) => r.id === params[params.length - 1]);
      if (row) applyUpdate(row, text, params);
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (/DELETE FROM documents WHERE healthRecordId/i.test(text)) {
      const before = documentRows.length;
      documentRows = documentRows.filter((r) => r.healthRecordId !== params[0]);
      return [{ affectedRows: before - documentRows.length }];
    }

    throw new Error(`UNHANDLED SQL in the health-publish stub: ${text}`);
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

const healthController = require('../src/controllers/healthController');
const { categoryForDocument, DOCUMENT_FOLDERS } = require('../src/utils/documentCategory');
const {
  buildHealthRecordDocument,
  buildHealthRecordPdf,
  RECORD_TYPE_LABELS,
} = require('../src/utils/healthRecordPdf');
const { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } = require('pdf-lib');

// ── Harness ────────────────────────────────────────────────────────────────

const NURSE = { id: 'U-NURSE', username: 'nurse1', role: 'nurse' };

function reset() {
  healthRows = [];
  documentRows = [];
  issued = [];
  failDocumentInsert = false;
}

/** A valid body for each of the six record types. */
function bodyFor(recordType) {
  const base = {
    residentId: 'CH1',
    residentName: CHILD.name,
    recordType,
    date: '2026-09-22',
    status: 'Completed',
    recordedBy: 'nurse1',
  };
  if (recordType === 'Medical Record') {
    return { ...base, details: { medicalRows: [{ date: '2026-09-22', findings: 'Mild cough', careProvider: 'Dr. Reyes' }] } };
  }
  if (recordType === 'Dental Services') {
    return { ...base, details: { chiefComplaints: 'Toothache', dentalService: 'Extraction', dentalServices: { extraction: true } } };
  }
  if (recordType === 'Height & Weight Monitoring') {
    return { ...base, details: { monitoringYear: '2026', monthlyMeasurements: [{ month: 1, height: '150', weight: '45' }] } };
  }
  if (recordType === 'Health Assessment') {
    return { ...base, assessmentType: 'Physical Examination', findings: 'Healthy.', allergies: 'None', conditions: 'Asthma' };
  }
  if (recordType === 'Medication Log') {
    return { ...base, medicationName: 'Amoxicillin', dosage: '500mg', frequency: 'Three times daily' };
  }
  return { ...base, treatmentType: 'Wound Care', procedure_: 'Cleaned and dressed.', outcome: 'Healing well' };
}

/** Drives a controller handler and resolves `{ status, payload }`. */
function call(handler, { params = {}, body = {}, user = NURSE } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); return this; },
    };
    handler({ params, body, user }, res, (error) => resolve({ status: error?.statusCode || 500, error }));
  });
}

/**
 * Reads back what the PDF actually instructs a viewer to draw.
 *
 * `pdf-lib` Flate-compresses every content stream, so a byte-level search for a
 * drawn string finds nothing. This walks the page content streams through
 * pdf-lib's own parser and returns every text run with the `Tm` position it was
 * drawn at, which is what lets the assertions check placement rather than mere
 * presence.
 */
async function drawnText(buffer) {
  const doc = await PDFDocument.load(buffer);
  const pages = doc.getPages();
  const runs = [];
  pages.forEach((page, pageIndex) => {
    const contents = page.node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    let source = '';
    for (const ref of refs) {
      const stream = doc.context.lookup(ref);
      let bytes = null;
      if (stream instanceof PDFRawStream) bytes = decodePDFRawStream(stream).decode();
      else if (stream && typeof stream.getContents === 'function') bytes = stream.getContents();
      if (bytes) source += Buffer.from(bytes).toString('latin1');
    }
    const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+Tm\s*(?:<([0-9A-Fa-f]*)>|\(((?:[^()\\]|\\.)*)\))\s*Tj/g;
    let m;
    while ((m = re.exec(source))) {
      runs.push({
        page: pageIndex,
        x: Number(m[1]),
        y: Number(m[2]),
        text: m[3] !== undefined
          ? Buffer.from(m[3], 'hex').toString('latin1')
          : m[4].replace(/\\(.)/g, '$1'),
      });
    }
  });
  return { pageCount: pages.length, runs };
}

const RECORD_TYPES = [
  'Medical Record',
  'Dental Services',
  'Height & Weight Monitoring',
  'Health Assessment',
  'Medication Log',
  'Medical Treatment',
];

// ── 1. The folder ──────────────────────────────────────────────────────────

test('every health record is filed in the Medical Records folder', () => {
  assert.equal(
    healthController.HEALTH_DOCUMENT_FOLDER,
    'Medical Records',
    'the published folder is no longer Medical Records'
  );
  assert.ok(
    DOCUMENT_FOLDERS.includes(healthController.HEALTH_DOCUMENT_FOLDER),
    'the resolved folder is not one of the module\u2019s folders'
  );
});

test('the folder is resolved from the rules, never written as a literal', () => {
  assert.match(
    CONTROLLER,
    /categoryForDocument\(\{ category: HEALTH_DOCUMENT_CATEGORY \}\)/,
    'the folder is no longer resolved from the shared routing rules, so renaming the folder ' +
      'in documentCategories.json would strand these documents in the old one'
  );
  assert.doesNotMatch(
    CONTROLLER,
    /'Medical Records'/,
    'the folder name is written as a literal in the controller, which bypasses the rules'
  );
});

test('the category is what makes the folder deterministic for all six record types', () => {
  for (const recordType of RECORD_TYPES) {
    assert.equal(
      categoryForDocument({ type: recordType, category: healthController.HEALTH_DOCUMENT_CATEGORY }),
      'Medical Records',
      `${recordType} does not resolve to Medical Records`
    );
  }

  // The record types are not folder names, and the rules match a type by exact
  // name — so routing on the type alone would strand at least one of them. This
  // is the assertion that makes the category load-bearing rather than decorative.
  const stranded = RECORD_TYPES.filter((recordType) => categoryForDocument({ type: recordType }) !== 'Medical Records');
  assert.ok(
    stranded.length > 0,
    'every record type now resolves on its type alone, so the category no longer needs to be stamped'
  );
  assert.ok(
    stranded.includes('Height & Weight Monitoring'),
    `expected Height & Weight Monitoring to fall through without a category, got: ${stranded.join(', ')}`
  );
});

// ── 2. Who can read the published record ───────────────────────────────────

test('the stamped category is the one that grants the nurse and the Center Head read', () => {
  const category = healthController.HEALTH_DOCUMENT_CATEGORY.toLowerCase();
  const block = DOCUMENT_CONTROLLER.slice(
    DOCUMENT_CONTROLLER.indexOf('const DOCUMENT_READ_ROLES_BY_CATEGORY'),
    DOCUMENT_CONTROLLER.indexOf('const DOCUMENT_READ_ROLE_KEYWORDS')
  );
  const entry = block.match(new RegExp(`${category}:\\s*\\[([^\\]]*)\\]`));
  assert.ok(entry, `no read-role entry for the stamped category "${category}"`);

  const roles = entry[1].split(',').map((r) => r.trim().replace(/['"]/g, '')).filter(Boolean);
  for (const role of ['nurse', 'centerhead', 'admin']) {
    assert.ok(roles.includes(role), `${role} cannot read the record it just filed`);
  }
  for (const role of ['houseparent', 'educator']) {
    assert.ok(!roles.includes(role), `${role} must not be able to read a medical record`);
  }
});

test('this change does not widen who may author a medical record', () => {
  // The specification is explicit — Nurse and Center Head only. Publishing a
  // health record must not become a second way to author a medical document, so
  // the guard is asserted to be exactly what it was.
  const block = DOCUMENT_CONTROLLER.slice(
    DOCUMENT_CONTROLLER.indexOf('const MEDICAL_RECORD_ROLES'),
    DOCUMENT_CONTROLLER.indexOf('const DOCUMENT_READ_ROLES_BY_CATEGORY')
  );
  assert.match(
    block,
    /new Set\(\['nurse', 'centerhead', 'admin'\]\)/,
    'MEDICAL_RECORD_ROLES changed — a role can now author a medical record that could not before'
  );
  assert.doesNotMatch(CONTROLLER, /MEDICAL_RECORD_ROLES/, 'the health publisher now writes the uploader guard');
});

// ── 3. The write path, end to end against the stub ─────────────────────────

test('saving a health record files it in the resident\u2019s Medical Records folder', async () => {
  reset();
  const result = await call(healthController.create, { body: bodyFor('Health Assessment') });

  assert.equal(result.status, 201, `expected 201, got ${result.status}${result.error ? ` (${result.error.message})` : ''}`);
  assert.equal(documentRows.length, 1, 'no document was filed');
  const [document] = documentRows;

  assert.equal(document.residentId, 'CH1', 'the document is not filed under the resident');
  assert.equal(document.documentCategory, 'Medical Records', 'the document is not in the Medical Records folder');
  assert.equal(document.category, 'Medical', 'the stamped category changed, so the read roles changed with it');
  assert.equal(document.type, 'Health Assessment', 'the document does not record which kind of record it is');
  assert.equal(document.status, 'Approved', 'the published entry is not Approved');
  assert.equal(document.approvedBy, 'nurse1', 'the published entry has no approver, so the folder view shows a blank approver');
  assert.equal(document.approvedAt, NOW, 'the published entry has no approval date');
  assert.equal(document.submittedBy, 'nurse1', 'the folder view would show no submitter');
  assert.equal(document.uploaderRole, 'nurse', 'the uploader role is missing, so the owner match cannot resolve');
  assert.equal(document.healthRecordId, result.payload.data.id, 'the document is not linked to the record');
  assert.equal(document.fileType, 'application/pdf', 'the filed copy is not a PDF');
  assert.equal(document.fileSize, Buffer.from(document.fileData, 'base64').length, 'fileSize does not match the stored file');
  assert.match(document.fileName, /\.pdf$/, 'the filed copy has no file name');
  assert.ok(document.title.includes('Health Assessment'), `the title does not name the record: ${document.title}`);
});

test('every one of the six record types is filed, not just the assessed ones', async () => {
  for (const recordType of RECORD_TYPES) {
    reset();
    const result = await call(healthController.create, { body: bodyFor(recordType) });
    assert.equal(
      result.status,
      201,
      `${recordType} was refused: ${result.error ? result.error.message : 'no error'}`
    );
    assert.equal(documentRows.length, 1, `${recordType} produced no document`);
    assert.equal(
      documentRows[0].documentCategory,
      'Medical Records',
      `${recordType} was filed in ${documentRows[0].documentCategory}`
    );
  }
});

test('editing a record rewrites the copy already on file instead of adding a second', async () => {
  reset();
  const created = await call(healthController.create, { body: bodyFor('Medication Log') });
  const recordId = created.payload.data.id;
  const firstDocumentId = documentRows[0].id;

  const updated = await call(healthController.update, {
    params: { id: recordId },
    body: { ...bodyFor('Medication Log'), dosage: '1000mg' },
  });

  assert.equal(updated.status, 200, `expected 200, got ${updated.status}${updated.error ? ` (${updated.error.message})` : ''}`);
  assert.equal(documentRows.length, 1, 'a second copy of the same record was filed');
  assert.equal(documentRows[0].id, firstDocumentId, 'the filed document was replaced rather than rewritten');
  assert.equal(documentRows[0].healthRecordId, recordId, 'the link to the record was lost on edit');
  assert.ok(
    documentRows[0].description.includes('Medication Log'),
    'the description no longer names the record type'
  );
});

test('the filed document follows the record when it is moved to another resident', async () => {
  reset();
  const created = await call(healthController.create, { body: bodyFor('Health Assessment') });
  const recordId = created.payload.data.id;
  assert.equal(documentRows[0].residentId, 'CH1');

  await call(healthController.update, {
    params: { id: recordId },
    body: { ...bodyFor('Health Assessment'), residentId: 'CH2', residentName: 'Other Resident' },
  });

  assert.equal(documentRows.length, 1, 'moving the record filed a second copy');
  assert.equal(
    documentRows[0].residentId,
    'CH2',
    'the document stayed in the old resident\u2019s folder, where it would be readable by that child\u2019s team'
  );
});

test('deleting a record removes the copy filed in Documents', async () => {
  reset();
  const created = await call(healthController.create, { body: bodyFor('Dental Services') });
  const recordId = created.payload.data.id;
  assert.equal(documentRows.length, 1);

  const removed = await call(healthController.delete, { params: { id: recordId } });

  assert.equal(removed.status, 200, `expected 200, got ${removed.status}${removed.error ? ` (${removed.error.message})` : ''}`);
  assert.equal(healthRows.length, 0, 'the record was not deleted');
  assert.equal(
    documentRows.length,
    0,
    'the published copy outlived the record, leaving an orphan in the child\u2019s folder'
  );
});

test('a failure to publish does not lose the record', async () => {
  reset();
  failDocumentInsert = true;

  const result = await call(healthController.create, { body: bodyFor('Medical Treatment') });

  assert.equal(result.status, 201, 'a PDF failure turned a stored record into an error response');
  assert.equal(result.payload.documentId, null, 'the response claims a document that was not written');
  assert.equal(healthRows.length, 1, 'the record was not stored');
});

// ── 4. Idempotency in the database, not just in the lookup ─────────────────

test('the publisher looks the existing entry up by healthRecordId', () => {
  const start = CONTROLLER.indexOf('async function publishDocumentForHealthRecord');
  assert.ok(start > 0, 'publishDocumentForHealthRecord is gone');
  const body = CONTROLLER.slice(start, CONTROLLER.indexOf('\nasync function publishSafely', start));
  assert.match(
    body,
    /SELECT id, residentId, admissionId FROM documents WHERE healthRecordId = \?/,
    'the publisher no longer checks for an existing entry by healthRecordId, or no longer ' +
      'reads the columns the resident-move decision needs'
  );
  assert.match(body, /UPDATE documents SET/, 'the publisher no longer updates the existing entry');
  assert.match(body, /INSERT INTO documents/, 'the publisher no longer inserts');
});

test('the database enforces one document per health record', () => {
  assert.match(
    SERVER,
    /ensureColumn\('documents', 'healthRecordId'/,
    'the healthRecordId column migration is gone, so the link cannot be stored'
  );
  assert.match(
    SERVER,
    /ensureUniqueIndex\('documents', 'uq_documents_health_record', 'healthRecordId'\)/,
    'the unique index is gone — the lookup-then-insert becomes a race and two concurrent ' +
      'saves could leave two copies of the same record in the resident\u2019s folder'
  );
});

test('publishing is wrapped so a failure is reported and not thrown', () => {
  const start = CONTROLLER.indexOf('async function publishSafely');
  const body = CONTROLLER.slice(start, CONTROLLER.indexOf('function validateHealthRecord', start));
  assert.match(body, /try \{\s*return await publishDocumentForHealthRecord/, 'the publish is no longer wrapped');
  assert.match(body, /catch \(error\)/, 'the publish has no error handler');
  assert.match(body, /console\.error/, 'a failed publish is swallowed silently');
});

// ── 5. The generated document ──────────────────────────────────────────────

test('a health record produces a real PDF with its own details drawn on it', async () => {
  const buffer = await buildHealthRecordPdf(
    { id: 'HLT001', residentId: 'CH1', residentName: CHILD.name, recordType: 'Medication Log',
      date: '2026-09-22', recordedBy: 'nurse1', status: 'Completed',
      medicationName: 'Amoxicillin', dosage: '500mg', frequency: 'Three times daily' },
    CHILD,
  );
  assert.ok(Buffer.isBuffer(buffer), 'the generator no longer returns a Buffer');
  assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-', 'the output is not a PDF');

  const { pageCount, runs } = await drawnText(buffer);
  assert.ok(pageCount >= 1, 'the document has no pages');

  const drawn = runs.map((r) => r.text);
  for (const expected of ['Amoxicillin', '500mg', 'Three times daily', CHILD.name]) {
    assert.ok(
      drawn.some((line) => line.includes(expected)),
      `the record's "${expected}" was not drawn on the document`
    );
  }

  // Nothing may be drawn outside the page. The footer sits below the bottom
  // margin by design, so the floor is the footer's own line, not the margin.
  const stray = runs.filter((r) => r.x < 40 || r.x > 560 || r.y < 20 || r.y > 800);
  assert.equal(stray.length, 0, `${stray.length} runs were drawn outside the page: ${JSON.stringify(stray.slice(0, 3))}`);
});

test('every record type renders, and each is titled as itself', async () => {
  for (const recordType of RECORD_TYPES) {
    const buffer = await buildHealthRecordPdf(
      { id: 'HLT001', residentId: 'CH1', residentName: CHILD.name, recordType,
        date: '2026-09-22', recordedBy: 'nurse1', status: 'Completed',
        assessmentType: 'Physical Examination', findings: 'Healthy.',
        medicationName: 'Amoxicillin', dosage: '500mg', frequency: 'Daily',
        treatmentType: 'Wound Care', procedure_: 'Cleaned.',
        details: { medicalRows: [{ date: '2026-09-22', findings: 'Mild cough', careProvider: 'Dr. Reyes' }],
          chiefComplaints: 'Toothache', dentalService: 'Extraction', dentalServices: { extraction: true },
          monitoringYear: '2026', monthlyMeasurements: [{ month: 1, height: '150', weight: '45' }] } },
      CHILD,
    );
    assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-', `${recordType} did not produce a PDF`);
    const { runs } = await drawnText(buffer);
    const expected = RECORD_TYPE_LABELS[recordType].label.toUpperCase();
    assert.ok(
      runs.some((r) => r.text.includes(expected)),
      `${recordType} is not titled "${expected}" on the document`
    );
  }
});

test('the captured signature is embedded, and its absence still produces a document', async () => {
  // The form's doctor/dentist signature is recorded data, so it belongs on the
  // filed copy. A record with no drawing must still be filed — the line prints
  // blank, which is what the form shows too.
  const png = 'data:image/png;base64,'
    + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const withSignature = await buildHealthRecordPdf(
    { residentName: CHILD.name, recordType: 'Dental Services', date: '2026-09-22',
      details: { chiefComplaints: 'Toothache', dentalService: 'Extraction', doctorSignature: png } },
    CHILD,
  );
  const withoutSignature = await buildHealthRecordPdf(
    { residentName: CHILD.name, recordType: 'Dental Services', date: '2026-09-22',
      details: { chiefComplaints: 'Toothache', dentalService: 'Extraction' } },
    CHILD,
  );

  assert.equal(withSignature.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(withoutSignature.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(withSignature.length > withoutSignature.length, 'the signature image was not embedded');
});

test('the builder returns everything the publisher stores', async () => {
  const doc = await buildHealthRecordDocument(
    { id: 'HLT001', residentName: CHILD.name, recordType: 'Health Assessment', date: '2026-09-22' },
    CHILD,
  );
  for (const key of ['buffer', 'fileName', 'fileSize', 'title']) {
    assert.ok(doc[key] !== undefined, `the document builder no longer returns ${key}`);
  }
  assert.equal(doc.fileSize, doc.buffer.length);
  assert.ok(doc.title.startsWith('Health Assessment'), `the title does not name the type: ${doc.title}`);
  assert.ok(doc.title.includes('2026-09-22'), `the title does not name the date, so two logs look identical: ${doc.title}`);
});

test('the type list is the same in all three places that declare it', () => {
  const declared = Object.keys(RECORD_TYPE_LABELS).sort();

  const validated = CONTROLLER.slice(
    CONTROLLER.indexOf('function validateHealthRecord'),
    CONTROLLER.indexOf('const details = data.details')
  ).match(/\['([^\]]*)\]\.includes\(recordType\)/);
  assert.ok(validated, 'the controller no longer declares its accepted record types');
  const accepted = validated[1].split(',').map((t) => t.trim().replace(/^'|'$/g, '')).sort();

  assert.deepEqual(
    declared,
    accepted,
    'the PDF generator and the API validator disagree about which record types exist'
  );

  const formOptions = HEALTH_FORM.slice(HEALTH_FORM.indexOf('const FORM_OPTIONS'));
  for (const type of declared) {
    assert.ok(
      formOptions.includes(`value: '${type}'`),
      `the Health form no longer offers "${type}", so it can never be created`
    );
  }
});

// ── 6. The routes ──────────────────────────────────────────────────────────

test('the health write routes carry the capability, not just the module', () => {
  // The mount gate (`requireModule('Health')`) stops a role without the module.
  // It does not stop an account granted Health read-only from writing a medical
  // record — and, through it, filing a document into the child's folder.
  for (const [method, permission] of [["post('/'", 'create'], ["put('/:id'", 'edit'], ["delete('/:id'", 'delete']]) {
    const line = ROUTES.split('\n').find((l) => l.includes(`router.${method}`));
    assert.ok(line, `no route found for router.${method}`);
    assert.ok(
      line.includes(`requirePermission('Health', '${permission}')`),
      `the ${method} route is missing its Health ${permission} gate: ${line}`
    );
    const gateAt = line.indexOf('requirePermission(');
    const handlerAt = line.indexOf('asyncHandler(');
    assert.ok(gateAt > 0 && handlerAt > 0 && gateAt < handlerAt, `the gate must run before the handler: ${line}`);
  }
});

test('the delete route is wired to the handler that also removes the document', () => {
  assert.match(
    CONTROLLER,
    /delete: remove,/,
    'the controller exports the generic delete again, so deleting a record would leave its ' +
      'published document behind in the child\u2019s folder'
  );
});

test('the generator never invents a record type it was not given', () => {
  // An unrecognised type must still produce a document rather than throwing: the
  // record is already saved by the time the PDF is built.
  assert.ok(
    Object.keys(RECORD_TYPE_LABELS).length === RECORD_TYPES.length,
    'the label table and the record type list have drifted apart'
  );
  assert.doesNotMatch(GENERATOR, /throw new ApiError/, 'the generator can now fail a save');
});

// ── 7. The record form ─────────────────────────────────────────────────────

/** The create/edit dialog only, so an assertion cannot match the list view. */
function recordFormSource() {
  const start = HEALTH_FORM.indexOf('{/*\n        THE RECORD FORM.');
  assert.ok(start > 0, 'the record form is no longer marked, so its structure cannot be asserted');
  const end = HEALTH_FORM.indexOf('{/* VIEW DIALOG */}', start);
  assert.ok(end > start, 'the record form has no end marker');
  return HEALTH_FORM.slice(start, end);
}

test('the record form uses the same shell as the QPR form', () => {
  const form = recordFormSource();

  // The QPR's full-screen dialog classes, verbatim — one layout, not two.
  assert.match(
    form,
    /!top-0 !left-0 !flex !h-screen !w-screen !max-h-none !max-w-none !translate-x-0 !translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-white p-0/,
    'the record form no longer uses the full-screen shell the QPR form uses'
  );
  // A toolbar naming the resident and the record, a scrollable body, one footer.
  assert.match(form, /border-b border-gray-200 bg-white px-4 py-2/, 'the toolbar strip is gone');
  assert.match(form, /relative min-h-0 flex-1 overflow-y-auto bg-neutral-200 px-2 py-4 sm:px-6/, 'the scroll body is gone');
  assert.match(
    form,
    /flex-row flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-4 py-3/,
    'the footer no longer matches the QPR form'
  );
  assert.match(form, /mx-auto w-full max-w-\[900px\]/, 'the body is no longer a centred column');
  assert.match(form, /<FormSection /, 'the section cards are gone');
  assert.match(form, /<SectionNote>/, 'the explanatory note is gone');
  assert.match(
    HEALTH_FORM,
    /rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-\[11px\] leading-relaxed text-blue-800/,
    'the explanatory note no longer uses the QPR form\u2019s note styling'
  );
});

test('the resident is auto-filled and the identity fields are not editable', () => {
  const form = recordFormSource();

  // Everything the system already knows is printed, not typed: the only editable
  // control in the identifying block is the resident picker and the record date.
  assert.match(form, /<ReadOnlyField label="Age"/, 'age is no longer auto-filled');
  assert.match(form, /<ReadOnlyField label="Sex"/, 'sex is no longer auto-filled');
  assert.match(form, /<ReadOnlyField label="Date of Birth"/, 'date of birth is no longer auto-filled');
  assert.match(form, /<ReadOnlyField label="Date of Admission"/, 'admission date is no longer auto-filled');
  assert.match(form, /<ReadOnlyField label="Case Phase"/, 'case phase is no longer auto-filled');
  assert.match(form, /<ReadOnlyField label="Resident ID"/, 'the resident id is no longer shown');
  assert.match(form, /formResident\?\.age/, 'the age is not read from the resident record');
  assert.match(
    HEALTH_FORM,
    /const formResident = useMemo\(\s*\(\) => children\.find\(child => child\.id === form\.residentId\) \|\| null/,
    'the resident is no longer resolved from the shared store, so the form can show stale details'
  );
});

test('the signature is drawn in the shared modal, not an inline canvas', () => {
  // The inline canvas was 240x72 CSS pixels and unusable on a phone; the shared
  // modal is the component every other signing surface in the app uses.
  assert.match(HEALTH_FORM, /import \{ SignaturePadModal \} from '\.\/SignaturePad'/, 'the shared signature modal is no longer used');
  assert.doesNotMatch(
    HEALTH_FORM,
    /function SignaturePad\(/,
    'the component has its own canvas again, so a signature drawn here is captured differently ' +
      'from every other form in the app'
  );
  const form = recordFormSource();
  assert.match(form, /<SignaturePadModal/, 'the record form no longer offers a signature pad');
});

test('the dental checklist is what the saved record carries', () => {
  // The API requires `details.dentalService`; the form never wrote it, so a new
  // dental record was refused no matter what the nurse ticked.
  assert.match(
    HEALTH_FORM,
    /dentalService: isDental \? dentalServiceSummary\(dentalServices\) : form\.dentalService/,
    'the saved record no longer derives its dental service summary from the checklist'
  );
  assert.match(
    HEALTH_FORM,
    /dentalServiceCount: isDental \? dentalServiceCounts\(dentalServices\) : form\.dentalServiceCount/,
    'the saved record no longer derives its dental service counts from the checklist'
  );
  assert.match(HEALTH_FORM, /function dentalServiceSummary\(/, 'the summary helper is gone');
  // The checklist itself must be driven by one list, so a service cannot be
  // rendered as a tick-box and then omitted from the summary.
  assert.match(HEALTH_FORM, /const DENTAL_SERVICE_ROWS = \[/, 'the service list is gone');
  assert.ok(
    (HEALTH_FORM.match(/DENTAL_SERVICE_ROWS\s*\.(?:map|filter)/g) || []).length >= 3,
    'the service list is no longer shared by the form, the summary and the count — a service ' +
      'could be ticked on screen and then omitted from the saved record'
  );
});

test('the form is usable at phone width', () => {
  const form = recordFormSource();
  // Every field grid collapses to one column, and the two wide tables scroll
  // horizontally rather than forcing the page wider than the viewport.
  assert.match(form, /grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3/, 'the identifying grid no longer collapses');
  assert.match(form, /grid-cols-1 gap-4 sm:grid-cols-2/, 'the two-column field grids no longer collapse');
  assert.equal(
    (form.match(/overflow-x-auto rounded-lg border border-gray-200/g) || []).length,
    2,
    'the medical-record and height/weight tables must both scroll horizontally on a phone'
  );
});
