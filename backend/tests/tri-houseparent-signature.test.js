/**
 * Regression guards for the Houseparent signature on the TRI.
 *
 * The official TRI's last page (page 8) ends with an "Assessed by" block whose first
 * line is captioned "Houseparent". That line printed blank on every export because
 * nothing ever captured a signature. This suite locks in the replacement: the
 * column, the endpoint, the printed name, the on-screen pad on page 8, who is
 * allowed to use it, and the box the drawing is stamped into.
 *
 * The line belongs to the Houseparent alone. A Center Head or Social Worker used to
 * be able to write it on the Houseparent's behalf; that is gone, and several tests
 * below exist to keep it gone. Their part is to approve or return the submitted TRI.
 *
 * The geometry assertions matter most. The name and the signature have to land in
 * the blank band between the printed underscore rule and the line of text above it,
 * without colliding with each other or with either neighbour, and they have to stay
 * inside the width of that rule. All of those defects type-check, build, and are
 * invisible without opening the exported PDF.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = path.resolve(__dirname, '../src/database/schema.sql');
const SERVER = path.resolve(__dirname, '../src/server.js');
const CONTROLLER = path.resolve(__dirname, '../src/controllers/triController.js');
const ROUTES = path.resolve(__dirname, '../src/routes/triRoutes.js');
const PDF = path.resolve(__dirname, '../src/utils/triReportPdf.js');
const TRI_UI = path.resolve(__dirname, '../../frontend/src/app/components/Tri.tsx');

const read = (file) => fs.readFileSync(file, 'utf8');

/* ================================================================
   STORAGE
   ================================================================ */

test('triRecords has somewhere to keep the Houseparent signature', () => {
  const schema = read(SCHEMA);
  const table = schema.match(/CREATE TABLE triRecords \(([\s\S]*?)\n\)\s*ENGINE/);
  assert.ok(table, 'the triRecords table definition was not found');

  for (const column of ['houseparentSignature', 'houseparentSignedBy', 'houseparentSignedAt']) {
    assert.match(
      table[1],
      new RegExp(`\\b${column}\\b`),
      `triRecords has no ${column} column`
    );
  }
});

test('an existing database gets the TRI signature columns added on boot', () => {
  const source = read(SERVER);

  for (const column of ['houseparentSignature', 'houseparentSignedBy', 'houseparentSignedAt']) {
    assert.ok(
      source.includes(`['${column}'`),
      `server.js never migrates triRecords.${column}, so the first signature save would fail on an older database`
    );
  }
  // A second boot must not crash the migration with a duplicate-column error.
  assert.match(
    source,
    /err\.errno === 1060/,
    'the migration does not tolerate the column already existing'
  );
});

/* ================================================================
   THE ENDPOINT
   ================================================================ */

test('only a Houseparent may sign the TRI, and the route says so', () => {
  const routes = read(ROUTES);
  assert.match(
    routes,
    /router\.post\('\/:id\/signature'[\s\S]*?triController\.sign\)/,
    'POST /:id/signature is not wired to triController.sign'
  );

  // The page-8 line is the Houseparent's own, so they must be able to reach it.
  const line = routes.match(/router\.post\('\/:id\/signature'[^\n]*/);
  assert.match(line[0], /'houseparent'/, 'a Houseparent cannot sign their own TRI');

  // ...and nobody else may. A reviewer who can sign the document they are reviewing
  // is exactly the workflow this replaced: Center Head and Social Worker approve or
  // return the submitted TRI instead.
  for (const role of ['socialworker', 'centerhead', 'admin']) {
    assert.doesNotMatch(
      line[0],
      new RegExp(`'${role}'`),
      `a ${role} can still write the Houseparent's signature`
    );
  }
});

test('the controller refuses a signer who is not the Houseparent', () => {
  const source = read(CONTROLLER);
  const handler = source.match(/async function sign\(req, res, next\) \{([\s\S]*?)\n\}/)[1];

  assert.match(
    handler,
    /!==\s*'houseparent'/,
    'the handler does not refuse a caller who is not a Houseparent, so the rule ' +
      'only holds for as long as the route keeps its authorize() gate'
  );
});

test('the controller stores the drawing, not the printed name', () => {
  const source = read(CONTROLLER);
  const handler = source.match(/async function sign\(req, res, next\) \{([\s\S]*?)\n\}/);
  assert.ok(handler, 'the sign handler was not found');

  assert.match(
    handler[1],
    /houseparentSignature = \?/,
    'the UPDATE does not write the signature column'
  );
  assert.match(
    handler[1],
    /houseparentSignedBy/,
    'the UPDATE does not record who signed'
  );
  assert.match(
    handler[1],
    /houseparentSignedAt/,
    'the UPDATE does not record when it was signed'
  );
  assert.ok(
    !/houseparentSignature = req\.user\.username/.test(handler[1]),
    'the typed username is being stored as the signature again'
  );
});

test('the controller only accepts a drawn image, and refuses a finalized record', () => {
  const source = read(CONTROLLER);
  const handler = source.match(/async function sign\(req, res, next\) \{([\s\S]*?)\n\}/)[1];

  assert.match(
    handler,
    /data:image\\\/\(png\|jpeg\|jpg\);base64,/,
    'the handler does not validate the data-URL shape'
  );
  assert.match(
    handler,
    /status === 'Finalized'/,
    'a finalized TRI can still be re-signed'
  );
  assert.match(
    handler,
    /canAccessResident\(req\.user, record\.residentId\)/,
    'the handler does not check the caller is assigned to the resident'
  );
});

/* ================================================================
   THE STAMP ON THE GENERATED PDF
   ================================================================ */

/** Parses `const NAME = { ... }` into an object of numbers. */
function parseBox(source, name) {
  const match = source.match(new RegExp(`const ${name}\\s*=\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${name} has no literal definition to check`);
  const box = {};
  for (const pair of match[1].split(',')) {
    const [key, raw] = pair.split(':');
    if (!key || raw === undefined) continue;
    const value = Number(raw.trim());
    if (!Number.isNaN(value)) box[key.trim()] = value;
  }
  return box;
}

test('the generator stamps the saved signature onto the Houseparent line', () => {
  const source = read(PDF);

  assert.match(source, /const HOUSEPARENT_SIGNATURE_BOX/, 'the signature box is not defined');
  assert.match(source, /await drawHouseparentSignature\(/, 'the signature is never stamped');
  assert.match(
    source,
    /record\.houseparentSignature/,
    'the generator never reads the stored signature'
  );
  assert.match(source, /page\.drawImage\(/, 'the signature image is never drawn');
  assert.match(
    source,
    /export[\s\S]*HOUSEPARENT_SIGNATURE_BOX|HOUSEPARENT_SIGNATURE_BOX,\n\};/,
    'the box is not exported, so a test cannot pin its geometry'
  );
});

test('an unsigned or unreadable signature leaves the line blank instead of aborting', () => {
  const source = read(PDF);
  const helper = source.match(/async function drawHouseparentSignature\(([\s\S]*?)\n\}/);
  assert.ok(helper, 'the stamping helper was not found');

  // No signature at all is the normal case for a draft.
  assert.match(helper[1], /if \(!match\) return false;/, 'a missing signature is not handled');
  // A corrupt data URL must not take the whole document down with it.
  assert.match(helper[1], /catch \{[\s\S]*?return false;/, 'a decode failure is not swallowed');
});

test('the signature box sits in the blank band above the printed underscore rule', () => {
  const box = parseBox(read(PDF), 'HOUSEPARENT_SIGNATURE_BOX');

  // Measured from the template's own text layer: the "Houseparent" signature rule
  // is a run of underscores whose baseline sits at y = 772.75, and the line of
  // text above the block ends at y = 804. The band between them is blank.
  const RULE_BASELINE = 772.75;
  const TEXT_ABOVE_BOTTOM = 804;

  assert.ok(
    box.y >= RULE_BASELINE,
    `the signature box starts at y=${box.y}, which is on or below the printed rule at y=${RULE_BASELINE}`
  );
  assert.ok(
    box.y + box.height <= TEXT_ABOVE_BOTTOM,
    `the signature box ends at y=${box.y + box.height}, overlapping the text above at y=${TEXT_ABOVE_BOTTOM}`
  );
  // It must be a signature-shaped space, not a sliver.
  assert.ok(box.height >= 18, `a ${box.height}pt tall box is too small to sign in`);
});

test('the signature box stays inside the width of the Houseparent rule', () => {
  const box = parseBox(read(PDF), 'HOUSEPARENT_SIGNATURE_BOX');

  // The underscore run spans x = 72.02 .. 162.26 on the template.
  const RULE_X1 = 72.02;
  const RULE_X2 = 162.26;

  assert.ok(box.x >= RULE_X1 - 0.5, `the box starts at x=${box.x}, left of the rule`);
  assert.ok(
    box.x + box.width <= RULE_X2 + 0.5,
    `the box ends at x=${box.x + box.width}, running past the rule at x=${RULE_X2}`
  );
});

test('the printed Houseparent name is drawn above the signature rule', () => {
  const source = read(PDF);

  assert.match(source, /const HOUSEPARENT_NAME_POS/, 'the name position is not defined');
  assert.match(source, /drawHouseparentName\(pages, record, bold\)/, 'the name is never drawn');
  assert.match(
    source,
    /record\.houseparentSignedBy \|\| record\.submittedBy/,
    'the name is not taken from the record, so the line cannot fill itself in'
  );
  assert.match(source, /module\.exports[\s\S]*HOUSEPARENT_NAME_POS/, 'the name position is not exported');
});

test('the printed name clears both the signature box and the text above it', () => {
  const source = read(PDF);
  const name = parseBox(source, 'HOUSEPARENT_NAME_POS');
  const box = parseBox(source, 'HOUSEPARENT_SIGNATURE_BOX');

  // Measured from the template's text layer: the descenders of the line above the
  // block ("The Rehabilitation Team together with the resident:") reach down to
  // y = 811.40, and the printed rule's ink occupies 770.57–772.5.
  const TEXT_ABOVE_DESCENDER = 811.40;
  // The extremes of an 8pt Helvetica-Bold glyph box around its baseline, taken from
  // the generated PDF rather than assumed.
  const NAME_ASCENT = 8.56;
  const NAME_DESCENT = 2.46;

  const nameTop = name.y + NAME_ASCENT;
  const nameBottom = name.y - NAME_DESCENT;

  assert.ok(
    nameTop <= TEXT_ABOVE_DESCENDER,
    `the name reaches y=${nameTop.toFixed(2)}, into the text above at y=${TEXT_ABOVE_DESCENDER}`
  );
  assert.ok(
    nameBottom >= box.y + box.height,
    `the name drops to y=${nameBottom.toFixed(2)}, into the signature box which ends at y=${box.y + box.height}`
  );
  assert.equal(name.page, box.page, 'the name and the signature must be on the same page');
});

test('the stamp lands on the last page, where the signature block is printed', () => {
  const box = parseBox(read(PDF), 'HOUSEPARENT_SIGNATURE_BOX');

  // The "Assessed by" block is on page 8 of 8, which is index 7.
  assert.equal(box.page, 7, `the signature is stamped on page index ${box.page}, not the signature page`);
  assert.match(
    read(PDF),
    /HOUSEPARENT_SIGNATURE_BOX\.page/,
    'the stamp ignores the box page and always draws on page 1'
  );
});

test('the exported document says whether it carries a signature', () => {
  const source = read(PDF);

  // The "system copy" wording has to change once a real signature is on the page,
  // otherwise the document misdescribes itself.
  assert.match(
    source,
    /signed\s*\?/,
    'the PDF subject does not distinguish a signed copy from a blank one'
  );
  assert.match(
    source,
    /remaining signature lines are blank/,
    'the signed subject line does not say the other lines are still blank'
  );
});

/* ================================================================
   THE ON-SCREEN PAD
   ================================================================ */

test('the TRI form offers the Houseparent a signature pad', () => {
  const source = read(TRI_UI);

  assert.match(
    source,
    /import\s*\{[\s\S]*?SignaturePadModal[\s\S]*?\}\s*from\s*'@\/app\/components\/SignaturePad'/,
    'Tri.tsx does not import the shared signature pad'
  );
  assert.match(
    source,
    /label="Houseparent signature"/,
    'the TRI form has no Houseparent signature field'
  );
  assert.match(
    source,
    /'\/tri\/'\s*\+\s*\w+\.id\s*\+\s*'\/signature'/,
    'the pad is not wired to the signature endpoint'
  );
});

test('a first-time signature saves without a draft being saved first', () => {
  const source = read(TRI_UI);
  // The handler used to bail out when no record existed yet, so the first signature
  // a Houseparent drew was silently discarded and they had to Save Draft and sign
  // again. The record is now created from the form on the spot.
  const start = source.indexOf('async function handleSaveSignature');
  assert.ok(start !== -1, 'handleSaveSignature is gone');
  // The file is CRLF, so the end marker cannot include the leading newline.
  const end = source.indexOf('async function handleSubmit', start);
  assert.ok(end > start, 'the signature handler end marker was not found');
  const body = source.slice(start, end);
  assert.ok(body.length > 0, 'the signature handler body was not found');

  assert.doesNotMatch(
    body,
    /if \(!selectedRecord\) return;/,
    'the signature handler drops the drawing again when the TRI has not been saved yet'
  );
  assert.match(
    body,
    /ensureRecordForSignature/,
    'the signature handler no longer creates the record it signs'
  );
  assert.match(
    source,
    /async function ensureRecordForSignature/,
    'the record-creating helper is gone, so a first signature has nowhere to be stored'
  );
  // A signed, complete form goes straight to review rather than waiting for a
  // second button.
  assert.match(body, /'\/tri\/' \+ updated\.id \+ '\/submit'/, 'a completed signed TRI is no longer submitted for review');
  assert.match(body, /submissionBlocker/, 'the signature flow no longer checks the submit gates before submitting');
});

test('the submit gates are shared, not re-implemented, by the signature flow', () => {
  const source = read(TRI_UI);
  // `validateOffenseDates` and `submissionBlocker` must ask the same question, or a
  // signature could push an unfinished TRI past the reviewer's queue.
  assert.match(source, /function missingOffenseDates\(form: any\): string\[\]/, 'the shared missing-date helper is gone');
  assert.match(source, /function validateOffenseDates\(\)[\s\S]*?missingOffenseDates\(form\)/, 'validateOffenseDates no longer uses the shared helper');
  assert.match(source, /function submissionBlocker\(\)[\s\S]*?missingOffenseDates\(form\)/, 'submissionBlocker does not use the shared helper');
});

test('the pad sits on page 8 of the form, where the signature line is printed', () => {
  const source = read(TRI_UI);
  const block = source.match(/canSignHouseparent && \(([\s\S]*?<SignaturePadModal[\s\S]*?\/>)/);
  assert.ok(block, 'the page-8 signing surface was not found in Tri.tsx');

  // The official form asks for this signature on its last page, so the pad must be
  // rendered inside that page's overlay — not in a strip somewhere above the form.
  const pageEight = source.indexOf('pageNumber={8}');
  assert.ok(pageEight !== -1, 'the TRI editor no longer renders page 8');
  assert.ok(
    source.indexOf('<SignaturePadModal') > pageEight,
    'the signing surface is not on page 8, which is where the form asks for it'
  );
});

test('the pad locks once the TRI is finalized', () => {
  const source = read(TRI_UI);
  const block = source.match(/canSignHouseparent && \(([\s\S]*?<SignaturePadModal[\s\S]*?\/>)/);
  assert.ok(block, 'the page-8 signing surface was not found in Tri.tsx');

  assert.match(
    block[1],
    /record\?\.status === 'Finalized'/,
    'the pad stays editable on a finalized TRI'
  );
});

test('only the Houseparent is offered a signing surface', () => {
  const source = read(TRI_UI);

  // Exactly one pad in the whole form, so a reviewer has no second way in.
  assert.equal(
    (source.match(/<SignaturePadModal/g) || []).length,
    1,
    'the TRI form renders more than one signing surface'
  );
  assert.match(source, /canSignHouseparent && \(/, 'the pad is not gated at all');
  assert.match(
    source,
    /canSignHouseparent=\{isHouseparent\}/,
    'the pad is not limited to a Houseparent'
  );
  // Center Head and Social Worker get approve / send-for-reassessment only.
  assert.match(source, /Send for reassessment/, 'the reviewer lost the return action');
});

test('the Houseparent name is filled in automatically, on the signature page', () => {
  const source = read(TRI_UI);

  assert.match(
    source,
    /const houseparentName = selectedRecord\?\.houseparentSignedBy[\s\S]*?selectedRecord\?\.submittedBy[\s\S]*?isHouseparent \? user\?\.username/,
    'the name is not derived from the record and the signed-in Houseparent, so the ' +
      'Houseparent would have to type it'
  );
  assert.match(
    source,
    /data-tri-houseparent-name=\{houseparentName\}/,
    'the name is not rendered onto the form'
  );

  const pageEight = source.indexOf('pageNumber={8}');
  assert.ok(
    source.indexOf('data-tri-houseparent-name') > pageEight,
    'the name is not on page 8, next to the line it belongs to'
  );
});

test('the record interface carries the signature fields', () => {
  const source = read(TRI_UI);
  const iface = source.match(/interface TriRecord \{([\s\S]*?)\n\}/);
  assert.ok(iface, 'the TriRecord interface was not found');

  for (const field of ['houseparentSignature', 'houseparentSignedBy', 'houseparentSignedAt']) {
    assert.match(iface[1], new RegExp(`\\b${field}\\b`), `TriRecord does not declare ${field}`);
  }
});

/* ================================================================
   THE EXPORTED FILE
   ================================================================ */

test('the browser export stamps the signature, not just the server copy', () => {
  const source = read(TRI_UI);

  // Two export paths leave the TRI module: `openFormalPdfReport` downloads the
  // official template with the answers drawn on it, and `openPrintReport` prints an
  // HTML summary. Both used to draw the answers and stop — so a Center Head
  // exporting the Houseparent's signed TRI got a document with a blank signature
  // line, which is the defect this pins.
  for (const fn of ['openFormalPdfReport', 'openPrintReport']) {
    assert.ok(source.includes(`function ${fn}(`), `${fn} is gone`);
  }

  assert.match(
    source,
    /async function drawTriHouseparentSignature\(/,
    'the shared stamping helper is gone, so the exports cannot draw the signature'
  );
  assert.match(
    source,
    /await drawTriHouseparentSignature\(pdf, pages, record, bold\)/,
    'the PDF export no longer stamps the signature before saving'
  );
  assert.match(
    source,
    /record\.houseparentSignature/,
    'the export no longer reads the stored signature'
  );
  // The print view inlines the drawing above the Houseparent rule.
  assert.match(
    source,
    /SIGNATURE_DATA_URL\.test\(signatureDataUrl\)/,
    'the print view no longer validates the signature before inlining it'
  );
  assert.match(
    source,
    /<div class="rule">Houseparent<\/div>/,
    'the printed signature block lost the Houseparent rule the drawing sits on'
  );
  assert.match(
    source,
    /class="signed"/,
    'the printed signature block no longer has a slot for the drawing and the name'
  );
});

test('the browser export reads the same signature geometry as the server', () => {
  const ui = read(TRI_UI);
  const layout = JSON.parse(read(path.resolve(__dirname, '../../frontend/src/shared/triLayout.json')));

  // One copy of the coordinates, or the downloaded PDF and the published one would
  // place the signature differently on the same form.
  assert.deepEqual(
    { page: layout.houseparentSignatureBox.page, x: layout.houseparentSignatureBox.x, y: layout.houseparentSignatureBox.y, width: layout.houseparentSignatureBox.width, height: layout.houseparentSignatureBox.height },
    { page: 7, x: 72.02, y: 774, width: 90.24, height: 22 },
    'triLayout.json no longer matches the box the server stamps'
  );
  assert.deepEqual(
    { page: layout.houseparentNamePos.page, x: layout.houseparentNamePos.x, y: layout.houseparentNamePos.y, size: layout.houseparentNamePos.size, width: layout.houseparentNamePos.width },
    { page: 7, x: 72.02, y: 800, size: 8, width: 90.24 },
    'triLayout.json no longer matches the name position the server draws'
  );
  assert.match(ui, /triLayout\.houseparentSignatureBox/, 'the export does not read the shared signature box');
  assert.match(ui, /triLayout\.houseparentNamePos/, 'the export does not read the shared name position');

  // And the server refuses to start on a layout that disagrees with it.
  const server = read(PDF);
  assert.match(server, /houseparentSignatureBox', HOUSEPARENT_SIGNATURE_BOX/, 'the layout is no longer cross-checked against the writer');
  assert.match(server, /houseparentNamePos', HOUSEPARENT_NAME_POS/, 'the name position is no longer cross-checked against the writer');
});
