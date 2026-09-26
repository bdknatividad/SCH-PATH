/**
 * The TRI's E-Signatures must actually reach the page.
 *
 * ## Why this file exists
 *
 * `triReportPdf.js`'s stamping helper wrapped its work in a bare `try { … } catch
 * { return false }`. A stray reference left behind by a merge — an `anchorWidth`
 * line naming `nameWidth`, which is declared nowhere — threw a `ReferenceError`
 * on every call, and the helper's own `catch` swallowed it. The result: a TRI
 * exported with **every** signature line blank, no error in the log, and a
 * document that looks exactly like an unsigned one. Nothing in the suite
 * noticed, because every existing guard asserted the *source text* (a function
 * name, a column list) rather than the document.
 *
 * So this test reads the output. It generates a real PDF and counts the image
 * XObjects on page 8 through pdf-lib's object model, which is what "the
 * signature is on the form" actually means.
 *
 * Run: node --test tests/tri-signature-stamp.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, PDFName } = require('pdf-lib');

const {
  buildTriReportPdf,
  signedLineCount,
  signatorySignatureOf,
} = require('../src/utils/triReportPdf');

/** A 2x2 PNG — the smallest image `embedPng` will accept. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC';

/** The page-8 "Assessed by" block. */
const SIGNATURE_PAGE = 7;

const RECORD = {
  id: 'TRI999',
  residentId: 'CH001',
  reportingYear: 2026,
  reportingMonth: 9,
  status: 'Finalized',
  responses: { items: [], offenses: [] },
  finalPoints: 0,
  rating: 'Level 1',
};

/** Image XObjects drawn on one page of a generated PDF. */
async function imagesOnPage(buffer, pageIndex) {
  const doc = await PDFDocument.load(buffer);
  const resources = doc.getPages()[pageIndex].node.Resources();
  if (!resources) return 0;
  const xobjects = resources.lookup(PDFName.of('XObject'));
  if (!xobjects || typeof xobjects.entries !== 'function') return 0;

  let count = 0;
  for (const [, ref] of xobjects.entries()) {
    const obj = doc.context.lookup(ref);
    const subtype = obj?.dict?.get?.(PDFName.of('Subtype'));
    if (subtype && String(subtype) === '/Image') count += 1;
  }
  return count;
}

test('a supplied Houseparent signature is stamped onto page 8', async () => {
  const unsigned = await buildTriReportPdf(RECORD, { residentName: 'Test Resident', room: 'R1' });
  const signed = await buildTriReportPdf(
    { ...RECORD, houseparentSignature: PNG },
    { residentName: 'Test Resident', room: 'R1' },
  );

  const before = await imagesOnPage(unsigned, SIGNATURE_PAGE);
  const after = await imagesOnPage(signed, SIGNATURE_PAGE);

  assert.equal(
    after - before,
    1,
    'the Houseparent signature is not on the page — a swallowed error inside the '
      + 'stamping helper leaves every signature line blank with nothing in the log',
  );
});

test('every supplied signatory is stamped, and an unsigned line stays blank', async () => {
  const record = {
    ...RECORD,
    signatories: JSON.stringify({
      administrativeOfficer: { signature: PNG },
      caseManager: { signature: PNG },
    }),
  };

  const unsigned = await buildTriReportPdf(RECORD, { residentName: 'Test Resident', room: 'R1' });
  const signed = await buildTriReportPdf(record, { residentName: 'Test Resident', room: 'R1' });

  const before = await imagesOnPage(unsigned, SIGNATURE_PAGE);
  const after = await imagesOnPage(signed, SIGNATURE_PAGE);

  // Two lines carry an E-Signature; the other three are left alone.
  assert.equal(after - before, 2, 'the two supplied signatories were not both stamped');
  assert.equal(signedLineCount(record), 2, 'the record no longer reports which lines are signed');
});

test('an undecodable signature leaves the line blank instead of aborting the export', async () => {
  // The helper's catch is what makes a bad image survivable — that is why it must
  // stay narrow. What it must NOT do is hide a programming error, so this test
  // pins both halves: a bad data URL still produces a document, and the good lines
  // beside it are still stamped.
  const record = {
    ...RECORD,
    houseparentSignature: 'data:image/png;base64,!!!not-a-png!!!',
    signatories: JSON.stringify({ administrativeOfficer: { signature: PNG } }),
  };

  const buffer = await buildTriReportPdf(record, { residentName: 'Test Resident', room: 'R1' });
  assert.ok(buffer.length > 1000, 'the export was aborted by a bad signature image');

  const baseline = await buildTriReportPdf(RECORD, { residentName: 'Test Resident', room: 'R1' });
  const before = await imagesOnPage(baseline, SIGNATURE_PAGE);
  const after = await imagesOnPage(buffer, SIGNATURE_PAGE);

  assert.equal(after - before, 1, 'the one good signature was lost because a bad one sat beside it');
  assert.equal(signatorySignatureOf(record, 'houseparent'), 'data:image/png;base64,!!!not-a-png!!!');
});
