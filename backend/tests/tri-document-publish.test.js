/**
 * TRI PDF publishing tests.
 *
 * Approving a TRI now files the filled official form into the resident's Documents
 * folder. Three things can go quietly wrong and are pinned here:
 *
 *   1. A second copy. The publisher is idempotent through `documents.triRecordId`,
 *      which is only a guarantee if the unique index actually exists — the lookup
 *      before insert is a read-then-write race.
 *   2. Coordinates drifting from the form. The generator and the on-screen overlay
 *      must read the same layout file, or the exported PDF stops matching what the
 *      Houseparent saw and signed.
 *   3. A document that pretends to be the signed instrument. The official TRI has
 *      five signature lines; this copy has none, so it must be labelled as a system
 *      copy wherever a reader will look.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const CONTROLLER = read('src/controllers/triController.js');
const SERVER = read('src/server.js');
const GENERATOR = read('src/utils/triReportPdf.js');
const SCORING = read('src/utils/triScoring.js');

const {
  buildTriReportPdf,
  buildTriReportDocument,
  triReportFileName,
  triDocumentTitle,
  loadLayout,
  scoreMapOf,
  LAYOUT_PATH,
  triTemplatePath,
} = require('../src/utils/triReportPdf');
const { ratingForPoints } = require('../src/utils/triScoring');
const { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } = require('pdf-lib');

const LAYOUT = JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf8'));

/**
 * Reads back what the PDF actually instructs a viewer to draw.
 *
 * Searching the raw bytes for the marks does not work: `pdf-lib` Flate-compresses
 * every content stream and encodes text as a hex string, so a drawn `X` is stored as
 * `<58> Tj` inside a compressed stream — a byte-level search for `(X) Tj` finds zero
 * marks in a document that is full of them. This walks the page content streams
 * through pdf-lib's own parser and returns every text run with the `Tm` position it
 * was drawn at, which is what lets the assertions below check placement rather than
 * mere presence.
 *
 * @returns {Promise<{ pageCount: number, runs: Array<{page:number,x:number,y:number,text:string}> }>}
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
    // `1 0 0 1 <x> <y> Tm` followed by either a hex or a literal string and `Tj`.
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

// ── one layout, shared with the form ───────────────────────────────────────────

test('the layout the generator reads is the layout the form renders', () => {
  assert.equal(
    path.resolve(LAYOUT_PATH),
    path.resolve(__dirname, '../../frontend/src/shared/triLayout.json'),
    'the generator reads a different layout file than the frontend overlay'
  );
  assert.equal(LAYOUT.partOne.flatMap((s) => s.items).length, 150, 'the layout no longer holds 150 items');
  assert.equal(LAYOUT.pageItems.flatMap((p) => p.ids).length, 150, 'page mapping does not cover 150 items');
  assert.equal(Object.keys(LAYOUT.itemY).length, 150, 'y-coordinates do not cover 150 items');
  assert.equal(LAYOUT.offensePos.length, 45, 'offense coordinates do not cover 45 rows');
});

test('the shared layout is read from the frontend tree, as the anecdotal writer does', () => {
  assert.match(
    GENERATOR,
    /frontend\/src\/shared\/triLayout\.json|frontend', 'src', 'shared', 'triLayout\.json/,
    'the generator no longer points at the frontend copy of the layout'
  );
  assert.match(GENERATOR, /frontend.*forms.*tri\.pdf/, 'the generator no longer reads the official template');
});

test('the template and layout actually resolve on this checkout', () => {
  assert.ok(triTemplatePath(), 'the official tri.pdf template could not be found');
  assert.doesNotThrow(() => loadLayout());
});

// ── the bands agree with the frontend ─────────────────────────────────────────

test('the backend bands are the official ones', () => {
  assert.equal(ratingForPoints(600), 'Very Good');
  assert.equal(ratingForPoints(451), 'Very Good');
  assert.equal(ratingForPoints(450), 'Good');
  assert.equal(ratingForPoints(301), 'Good');
  assert.equal(ratingForPoints(300), 'Fair');
  assert.equal(ratingForPoints(151), 'Fair');
  assert.equal(ratingForPoints(150), 'Needs Improvement');
  assert.equal(ratingForPoints(1), 'Needs Improvement');
  assert.equal(ratingForPoints(0), null);
  assert.equal(ratingForPoints(null), null);
  assert.equal(ratingForPoints(''), null, "an empty string must not read as 0 points");
});

test('the controller uses the shared bands rather than its own chain', () => {
  assert.match(CONTROLLER, /require\('\.\.\/utils\/triScoring'\)/, 'the controller no longer imports the shared bands');
  assert.doesNotMatch(CONTROLLER, /const TRI_SCORING = \{/, 'the bands are defined in the controller again');
  assert.doesNotMatch(CONTROLLER, /finalPoints >= 451/, 'an inline threshold chain is back in the controller');
});

// ── idempotency ───────────────────────────────────────────────────────────────

test('the publisher looks the existing entry up by triRecordId', () => {
  const start = CONTROLLER.indexOf('async function publishDocumentForTri');
  assert.ok(start > 0, 'publishDocumentForTri is gone');
  const body = CONTROLLER.slice(start, CONTROLLER.indexOf('\nasync function finalize', start));
  assert.match(body, /SELECT id FROM documents WHERE triRecordId = \?/, 'the publisher no longer checks for an existing entry');
  assert.match(body, /UPDATE documents SET/, 'the publisher no longer updates the existing entry');
  assert.match(body, /INSERT INTO documents/, 'the publisher no longer inserts');
});

test('the database enforces one document per TRI record', () => {
  assert.match(
    SERVER,
    /ensureColumn\('documents', 'triRecordId'/,
    'the triRecordId column migration is gone, so the link cannot be stored'
  );
  assert.match(
    SERVER,
    /ensureUniqueIndex\('documents', 'uq_documents_tri_record', 'triRecordId'\)/,
    'the unique index is gone — the lookup-then-insert becomes a race and a second ' +
      'approve could leave two copies of the same month in the resident\u2019s folder'
  );
});

// ── a failure to publish must not undo the approval ───────────────────────────

test('publishing is non-fatal to the approval', () => {
  const start = CONTROLLER.indexOf('async function finalize');
  const body = CONTROLLER.slice(start, CONTROLLER.indexOf('\nasync function referenceViolations', start));
  assert.match(body, /try \{\s*documentId = await publishDocumentForTri/, 'the publish is no longer wrapped');
  assert.match(body, /catch \(perr\)/, 'the publish has no error handler, so a PDF failure would roll back the approval');
  assert.match(body, /status = 'Finalized'/, 'finalize no longer sets the status');
});

// ── it must not pretend to be the signed form ─────────────────────────────────

test('the published entry is labelled a system copy', () => {
  const title = triDocumentTitle({ reportingYear: 2026, reportingMonth: 9 });
  assert.match(title, /system copy/i, `the title does not say it is a system copy: ${title}`);
  assert.match(title, /September 2026/, `the title does not name the period: ${title}`);
});

test('the description states which signature lines are filled', () => {
  const start = CONTROLLER.indexOf('async function publishDocumentForTri');
  const body = CONTROLLER.slice(start, CONTROLLER.indexOf('\nasync function finalize', start));
  // The official TRI carries five signature lines. Only the Houseparent's is ever
  // filled, so the description has to say so — and it has to be accurate both ways,
  // because a copy that shows a signature while claiming to be unsigned (or the
  // reverse) is worse than saying nothing.
  assert.match(
    body,
    /houseparentSignature[\s\S]{0,120}signature line is signed/,
    'the description no longer distinguishes a signed copy from an unsigned one — the ' +
      'official TRI carries five signature lines and a reader must not assume they were witnessed'
  );
  assert.match(
    body,
    /signature lines are blank/i,
    'the unsigned branch of the description is gone, so an unsigned copy would claim to be signed'
  );
  // The published entry is Approved from the moment it is written, so it must carry
  // its own approval — the Documents module prints `approvedBy` / `approvedAt` as
  // "Approved By" / "Approval Date", and without them the row showed a submitter
  // and an empty approver.
  assert.match(body, /approvedBy = \?, approvedAt = NOW\(\)/, 'the UPDATE no longer records the approver');
  assert.match(body, /approvedBy, approvedAt/, 'the INSERT no longer records the approver');
  // `submittedBy` is the Houseparent who prepared the record, so it sits between
  // the status and the uploader in the column list.
  assert.match(body, /status, submittedBy, uploadedBy/, 'the document status column is no longer set');
  assert.match(body, /'Approved'/, 'the published document is no longer Approved');
  assert.match(
    body,
    /submittedBy = \?, modifiedBy/,
    'the UPDATE no longer refreshes who submitted the document'
  );
});

test('the generator stamps the captured Houseparent signature and nothing else', () => {
  // It cannot fabricate a signature, but the Houseparent's own drawn signature is
  // recorded data — it belongs on the exported form, and its absence is exactly the
  // "the signature is missing from the download" defect.
  assert.match(
    GENERATOR,
    /drawLineSignature/,
    'the generator no longer stamps the captured Houseparent signature, so exports print a blank line'
  );
  assert.match(
    GENERATOR,
    /key: 'houseparent',[\s\S]*?signatureColumn: 'houseparentSignature'/,
    "the Houseparent's line is no longer in the generator's line list"
  );
  assert.match(
    GENERATOR,
    /embedPng|embedJpg/,
    'the generator no longer embeds the signature image'
  );
  assert.doesNotMatch(
    GENERATOR,
    /drawText\([^)]*signature/i,
    'the generator now draws a text signature, which it cannot legitimately reproduce'
  );
  assert.match(GENERATOR, /setSubject\(/, 'the PDF metadata no longer records that this is a system copy');
});

// ── the answers must land in the right boxes ──────────────────────────────────

test('scoreMapOf accepts both stored shapes', () => {
  // Records written by the form are arrays of { id, score }; the counter in Tri.tsx
  // also tolerates a plain map, so both must round-trip here.
  assert.deepEqual(scoreMapOf([{ id: 'p1', score: 3 }, { id: 'p2', score: 1 }]), { p1: 3, p2: 1 });
  assert.deepEqual(scoreMapOf({ p1: 3, p2: 1 }), { p1: 3, p2: 1 });
  assert.deepEqual(scoreMapOf(null), {});
  assert.deepEqual(scoreMapOf([{ id: 'p1' }]), { p1: 0 }, 'a missing score must not become NaN');
});

test('the filename names the resident and the period', () => {
  const name = triReportFileName({ reportingYear: 2026, reportingMonth: 9, residentId: 'CH001' }, 'Benedict Natividad Medina');
  assert.equal(name, 'TRI-Benedict-Natividad-Medina-2026-09.pdf');
  const fallback = triReportFileName({ reportingYear: 2026, reportingMonth: 1, residentId: 'CH001' });
  assert.equal(fallback, 'TRI-CH001-2026-01.pdf');
});

test('a generated PDF is a real 8-page document with the answers drawn in the right boxes', async () => {
  const layout = loadLayout();
  const items = layout.partOne.flatMap((s) => s.items).map((i) => ({ id: i.id, score: 3 }));
  const buffer = await buildTriReportPdf(
    { id: 'TRI-TEST', residentId: 'CH001', reportingYear: 2026, reportingMonth: 9, status: 'Finalized',
      responses: { items, offenses: [] }, partOnePoints: 450, deductions: 0, finalPoints: 450, rating: 'Good' },
    { residentName: 'Test Resident' }
  );
  assert.ok(Buffer.isBuffer(buffer), 'the generator no longer returns a Buffer');
  assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-', 'the output is not a PDF');

  const { pageCount, runs } = await drawnText(buffer);
  assert.equal(pageCount, 8, 'the official form is eight pages; the copy must not drop any');

  // Every item is scored, so the document must carry exactly 150 marks.
  const marks = runs.filter((r) => r.text === 'X');
  assert.equal(marks.length, 150, `expected 150 drawn marks, found ${marks.length}`);

  // ...and they must land inside the form's score columns, not somewhere off the page.
  // scoreX is [459, 486, 513, 542] and the mark is drawn 3pt to the left of it.
  const stray = marks.filter((r) => r.x < 440 || r.x > 560 || r.y < 0 || r.y > 936);
  assert.equal(stray.length, 0, `${stray.length} marks were drawn outside the score columns`);

  // The header line (page 0) and the summary block (page 6) are fixed positions on the
  // official form. These coordinates were read off the real tri.pdf, so a change here
  // means the values would print on the wrong line of a legal document.
  const at = (page, x, y) => runs.filter((r) => r.page === page && r.x === x && r.y === y).map((r) => r.text);
  assert.deepEqual(at(0, 74, 753), ['Test Resident'], 'the resident name is not on the header line');
  assert.deepEqual(at(0, 398, 753), ['September 2026'], 'the reporting period is not on the header line');
  assert.deepEqual(at(5, 307, 602), ['450'], 'the Part I total is not on its line on page 5');
  assert.deepEqual(at(6, 482, 252), ['450'], 'the earned total is not on the summary line');
  assert.deepEqual(at(6, 482, 231), ['0'], 'the deductions total is not on the summary line');
  assert.deepEqual(at(6, 482, 210), ['450'], 'the final score is not on the summary line');
  assert.deepEqual(at(6, 482, 189), ['Good'], 'the rating is not on the summary line');
  // Nothing was scored against a previous period, so those two lines must stay empty.
  assert.deepEqual(at(6, 482, 273), [], 'a previous-period score was invented for a first TRI');
  assert.deepEqual(at(6, 482, 168), [], 'a previous-period rating was invented for a first TRI');
});

test('the offences are ticked on their own rows, not on the item grid', async () => {
  const layout = loadLayout();
  const items = layout.partOne.flatMap((s) => s.items).map((i) => ({ id: i.id, score: 1 }));
  const offenses = [0, 3, 7];
  const buffer = await buildTriReportPdf(
    { id: 'TRI-TEST', residentId: 'CH001', reportingYear: 2026, reportingMonth: 9,
      responses: { items, offenses }, partOnePoints: 150, deductions: 12, finalPoints: 138, rating: 'Needs Improvement' },
    { residentName: 'Test Resident' }
  );
  const { runs } = await drawnText(buffer);
  const marks = runs.filter((r) => r.text === 'X');
  assert.equal(marks.length, 150 + offenses.length, `expected 153 marks, found ${marks.length}`);

  // The offence ticks sit in a single column at x = 484, on the row of each offence.
  const offenseTicks = offenses.map((i) => runs.find((r) => r.text === 'X' && r.x === 484 && r.y === layout.offensePos[i].y - 11));
  assert.ok(offenseTicks.every(Boolean), 'an offence was not ticked on its own row');

  // The deductions reached the summary block.
  const deductions = runs.filter((r) => r.page === 6 && r.x === 482 && r.y === 231).map((r) => r.text);
  assert.deepEqual(deductions, ['12'], 'the offence deductions did not reach the summary block');
});

test('the document builder returns everything the publisher stores', async () => {
  const items = loadLayout().partOne.flatMap((s) => s.items).map((i) => ({ id: i.id, score: 1 }));
  const doc = await buildTriReportDocument(
    { id: 'TRI-TEST', residentId: 'CH001', reportingYear: 2026, reportingMonth: 9,
      responses: { items, offenses: [] }, partOnePoints: 150, deductions: 0, finalPoints: 150, rating: 'Needs Improvement' },
    'Test Resident'
  );
  for (const key of ['buffer', 'fileName', 'fileSize', 'title']) {
    assert.ok(doc[key] !== undefined, `the document builder no longer returns ${key}`);
  }
  assert.equal(doc.fileSize, doc.buffer.length);
});
