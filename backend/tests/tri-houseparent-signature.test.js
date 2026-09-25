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
  // The Houseparent's line is the first entry of the one line list the writer
  // iterates, so there is a single stamping path for all five lines.
  assert.match(source, /const SIGNATURE_LINES = \[/, 'the writer has no line list');
  assert.match(
    source,
    /key: 'houseparent',[\s\S]*?signatureColumn: 'houseparentSignature'/,
    "the Houseparent's line is not in the writer's line list",
  );
  assert.match(source, /await drawLineSignature\(pdf, pages, record, line, nameWidth\)/, 'the signature is never stamped');
  // The drawing is read through the line's own column, so a signature can never be
  // stamped from another line's field.
  assert.match(
    source,
    /String\(\(record && record\[line\.signatureColumn\]\) \|\| ''\)/,
    'the generator never reads the stored signature',
  );
  assert.match(
    source,
    /key: 'houseparent',[\s\S]*?signatureColumn: 'houseparentSignature'/,
    "the Houseparent's line no longer reads the Houseparent signature column",
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
  const helper = source.match(/async function drawLineSignature\(([\s\S]*?)\n\}/);
  assert.ok(helper, 'the stamping helper was not found');

  // No signature at all is the normal case for a draft.
  assert.match(helper[1], /if \(!match\) return false;/, 'a missing signature is not handled');
  // A corrupt data URL must not take the whole document down with it.
  assert.match(helper[1], /catch \{[\s\S]*?return false;/, 'a decode failure is not swallowed');
});

test('the signature box sits in the blank band above the printed underscore rule', () => {
  const box = parseBox(read(PDF), 'HOUSEPARENT_SIGNATURE_BOX');

  // Measured from the template's own text layer: the "Houseparent" signature rule
  // is a run of underscores whose baseline sits at y = 772.75 and whose ink occupies
  // 770.57–772.5; the descenders of the line above the block ("The Rehabilitation
  // Team together with the resident:", baseline 813.58) reach down to y = 811.40.
  // The band between them is blank.
  const RULE_INK_TOP = 772.5;
  const TEXT_ABOVE_DESCENDER = 811.4;

  assert.ok(
    box.y >= RULE_INK_TOP,
    `the signature box starts at y=${box.y}, which is on or below the printed rule's ink at y=${RULE_INK_TOP}`
  );
  assert.ok(
    box.y + box.height <= TEXT_ABOVE_DESCENDER,
    `the signature box ends at y=${box.y + box.height}, overlapping the text above whose descenders reach y=${TEXT_ABOVE_DESCENDER}`
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

test('the printed Houseparent name is drawn below the signature, above the rule', () => {
  const source = read(PDF);

  assert.match(source, /const HOUSEPARENT_NAME_POS/, 'the name position is not defined');
  assert.match(source, /drawLineName\(pages, layout, line, record, bold\)/, 'the name is never drawn');
  assert.match(
    source,
    /record\.houseparentSignedBy \|\| record\.submittedBy/,
    'the name is not taken from the record, so the line cannot fill itself in'
  );
  assert.match(source, /module\.exports[\s\S]*HOUSEPARENT_NAME_POS/, 'the name position is not exported');
});

test('the printed name sits below the signature box and clear of the rule', () => {
  const source = read(PDF);
  const name = parseBox(source, 'HOUSEPARENT_NAME_POS');
  const box = parseBox(source, 'HOUSEPARENT_SIGNATURE_BOX');

  // The requirement: on the TRI the assigned Houseparent's name goes BELOW the
  // signature, so the printed rule reads as the underline of the name.
  //
  // Measured from the template's text layer: the printed rule's ink occupies
  // 770.57–772.5. The extremes of an 8pt Helvetica-Bold glyph box around its baseline
  // are taken from the generated PDF rather than assumed.
  const RULE_INK_TOP = 772.5;
  const NAME_ASCENT = 8.56;
  const NAME_DESCENT = 2.46;

  const nameTop = name.y + NAME_ASCENT;
  const nameBottom = name.y - NAME_DESCENT;

  assert.ok(
    nameTop <= box.y,
    `the name reaches y=${nameTop.toFixed(2)}, into the signature box which starts at y=${box.y} — the name must go below the signature`,
  );
  assert.ok(
    nameBottom >= RULE_INK_TOP,
    `the name drops to y=${nameBottom.toFixed(2)}, through the printed rule whose ink tops out at y=${RULE_INK_TOP}`,
  );
  assert.equal(name.page, box.page, 'the name and the signature must be on the same page');
});

test('the stamp lands on the last page, where the signature block is printed', () => {
  const box = parseBox(read(PDF), 'HOUSEPARENT_SIGNATURE_BOX');

  // The "Assessed by" block is on page 8 of 8, which is index 7.
  assert.equal(box.page, 7, `the signature is stamped on page index ${box.page}, not the signature page`);
  assert.match(
    read(PDF),
    /pages\[line\.box\.page\]/,
    'the stamp ignores the line\'s box page and always draws on page 1'
  );
});

test('the exported document says which lines carry a signature', () => {
  const source = read(PDF);

  // The subject has to describe the page it is attached to. It used to be a fixed
  // sentence naming the Houseparent's line and calling the rest blank; that stopped
  // being true once all five lines could be signed, so the wording is now built from
  // what was actually drawn.
  assert.match(source, /pdf\.setSubject\(/, 'the PDF subject is gone');
  assert.match(
    source,
    /signedRoles\.length[\s\S]*?Left blank:[\s\S]*?blankRoles\.join/,
    'the subject no longer says which lines are signed and which are still blank',
  );
  // Every line is classified by what the stamping call actually returned, so a line
  // cannot be reported as signed when no drawing was placed.
  assert.match(
    source,
    /const stamped = await drawLineSignature\(pdf, pages, record, line, nameWidth\)/,
    'the stamping result is not captured, so the subject cannot report it',
  );
  assert.match(
    source,
    /\(stamped \? signedRoles : blankRoles\)\.push\(line\.label\)/,
    'a stamped line is not being recorded as signed',
  );
  // And the labels come from the line list, so a rename cannot leave the subject
  // naming a line the form no longer has.
  assert.match(source, /label: 'Houseparent'/, 'the Houseparent line has no label for the subject');
  assert.match(source, /label: 'SWO I\/Case Manager'/, 'the SWO I line has no label for the subject');
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

test('the signing surfaces are one per signable line, each gated to its own role', () => {
  const source = read(TRI_UI);

  // Two literal pads in the source: the Houseparent's own, and one rendered inside
  // `TRI_OFFICIAL_LINES.map(...)` for the four official lines. Not more — a third
  // literal pad would be a line nothing ever writes to.
  assert.equal(
    (source.match(/<SignaturePadModal/g) || []).length,
    2,
    'the TRI form does not render exactly one signing surface per signable line'
  );
  // The Houseparent's own line stays Houseparent-only...
  assert.match(source, /canSignHouseparent && \(/, 'the Houseparent pad is not gated at all');
  assert.match(
    source,
    /canSignHouseparent=\{isHouseparent\}/,
    'the Houseparent pad is not limited to a Houseparent'
  );
  // ...and the four official lines are gated to the reviewing roles instead, which is
  // a separate switch — one gate cannot express both rules.
  assert.match(
    source,
    /canSignOfficial && TRI_OFFICIAL_LINES\.map\(/,
    'the official lines are not gated separately from the Houseparent line'
  );
  assert.match(
    source,
    /canSignOfficial=\{canReview\}/,
    'the official lines are not limited to the reviewing roles'
  );
  // Center Head and Social Worker still get approve / send-for-reassessment.
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
  // The print view inlines the drawing above the Houseparent rule. Both the
  // Houseparent's line and the four official lines go through the one builder, so the
  // shape check and the "signed" slot cannot exist for one line and not another.
  assert.match(
    source,
    /SIGNATURE_DATA_URL\.test\(dataUrl\)/,
    'the print view no longer validates a signature before inlining it'
  );
  assert.match(
    source,
    /const signatureCellHtml = \(label: string, name: string, dataUrl: string\)/,
    'the printed signature block no longer has one builder for its lines'
  );
  assert.match(
    source,
    /<div class="rule">\$\{escapeHtml\(label\)\}<\/div>/,
    'the printed signature block lost the rule each drawing sits on'
  );
  assert.match(
    source,
    /const slot = img \|\| name \? 'signed' : ''/,
    'the printed signature block no longer has a slot for the drawing and the name'
  );
});

test('the browser export reads the same signature geometry as the server', () => {
  const ui = read(TRI_UI);
  const layout = JSON.parse(read(path.resolve(__dirname, '../../frontend/src/shared/triLayout.json')));

  // One copy of the coordinates, or the downloaded PDF and the published one would
  // place the signature differently on the same form. Measured from the template:
  // the Houseparent rule's ink tops out at y 772.5, its underscore run spans
  // x 72.02 .. 162.26, and the name goes below the signature at baseline y 777.
  assert.deepEqual(
    { page: layout.houseparentSignatureBox.page, x: layout.houseparentSignatureBox.x, y: layout.houseparentSignatureBox.y, width: layout.houseparentSignatureBox.width, height: layout.houseparentSignatureBox.height },
    { page: 7, x: 72.02, y: 786, width: 90.24, height: 20 },
    'triLayout.json no longer matches the box the server stamps'
  );
  assert.deepEqual(
    { page: layout.houseparentNamePos.page, x: layout.houseparentNamePos.x, y: layout.houseparentNamePos.y, size: layout.houseparentNamePos.size, width: layout.houseparentNamePos.width },
    { page: 7, x: 72.02, y: 777, size: 8, width: 90.24 },
    'triLayout.json no longer matches the name position the server draws'
  );
  assert.match(ui, /triLayout\.houseparentSignatureBox/, 'the export does not read the shared signature box');
  assert.match(ui, /triLayout\.houseparentNamePos/, 'the export does not read the shared name position');

  // And the server refuses to start on a layout that disagrees with it.
  const server = read(PDF);
  assert.match(server, /houseparentSignatureBox', HOUSEPARENT_SIGNATURE_BOX/, 'the layout is no longer cross-checked against the writer');
  assert.match(server, /houseparentNamePos', HOUSEPARENT_NAME_POS/, 'the name position is no longer cross-checked against the writer');
});
