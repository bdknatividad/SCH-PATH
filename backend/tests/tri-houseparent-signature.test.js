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
  // The five lines of the block are declared once, in `TRI_SIGNATORY_SLOTS`, and
  // the writer iterates them — so there is a single stamping path.
  assert.match(source, /const TRI_SIGNATORY_SLOTS = \[/, 'the writer has no line list');
  assert.match(
    source,
    /\{ slot: 'houseparent', title: 'Houseparent', hasName: true \}/,
    "the Houseparent's line is not in the writer's line list",
  );
  // The Houseparent's signature is the one line that lives in its own column
  // rather than in the `signatories` JSON, so it has its own entry point.
  assert.match(
    source,
    /async function drawHouseparentSignature\(pdf, pages, record\) \{[\s\S]*?return stampSignature\(pdf, pages\[HOUSEPARENT_SIGNATURE_BOX\.page\], signatorySignatureOf\(record, 'houseparent'\), HOUSEPARENT_SIGNATURE_BOX\);/,
    'the signature is never stamped',
  );
  // Every line resolves its signature through the slot accessor, so a signature
  // can never be stamped from another line's field.
  assert.match(
    source,
    /function signatorySignatureOf\(record, slot\) \{[\s\S]*?slot === 'houseparent'[\s\S]*?record\.houseparentSignature[\s\S]*?signatoriesOf\(record\)\[slot\]\?\.signature/,
    'the generator never reads the stored signature through the line\'s own field',
  );
  assert.match(source, /page\.drawImage\(/, 'the signature image is never drawn');
  assert.match(
    source,
    /module\.exports = \{[\s\S]*?\bHOUSEPARENT_SIGNATURE_BOX,/,
    'the box is not exported, so a test cannot pin its geometry'
  );
});

test('an unsigned or unreadable signature leaves the line blank instead of aborting', () => {
  const source = read(PDF);
  const helper = source.match(/async function stampSignature\(([\s\S]*?)\n\}/);
  assert.ok(helper, 'the stamping helper was not found');

  // No signature at all is the normal case for a draft.
  assert.match(helper[1], /if \(!match \|\| !page\) return false;/, 'a missing signature is not handled');
  // A corrupt data URL must not take the whole document down with it.
  assert.match(helper[1], /catch \{[\s\S]*?return false;/, 'a decode failure is not swallowed');
});

test('the signature box sits in the blank band above the printed underscore rule', () => {
  const box = parseBox(read(PDF), 'HOUSEPARENT_SIGNATURE_BOX');
  const name = parseBox(read(PDF), 'HOUSEPARENT_NAME_POS');

  // Measured from the template's own text layer: the rule's ink sits at
  // y 770.57–772.5 and the descenders of the text line above the block reach
  // y 811.40. The E-Signature is the top element of the line, above the typed
  // name, so it starts above the name's tallest glyph.
  const TEXT_ABOVE_DESCENDER = 811.40;
  const NAME_ASCENT = 8.56;

  assert.ok(
    box.y >= name.y + NAME_ASCENT,
    `the signature box starts at y=${box.y}, into the typed name below it (top ${name.y + NAME_ASCENT})`
  );
  assert.ok(
    box.y + box.height <= TEXT_ABOVE_DESCENDER,
    `the signature box ends at y=${box.y + box.height}, overlapping the text above at y=${TEXT_ABOVE_DESCENDER}`
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
  assert.match(source, /drawHouseparentName\(pages, record, bold\)/, 'the name is never drawn');
  assert.match(
    source,
    /record\.houseparentSignedBy \|\| record\.submittedBy/,
    'the name is not taken from the record, so the line cannot fill itself in'
  );
  // The name typed into the line's own text holder wins over the fallback, so a
  // renamed signatory does not reprint the account that happened to submit it.
  assert.match(
    source,
    /const typed = sanitize\(signatoriesOf\(record\)\.houseparent\?\.name \|\| ''\);/,
    'the typed name in the text holder is no longer preferred'
  );
  assert.match(source, /module\.exports[\s\S]*HOUSEPARENT_NAME_POS/, 'the name position is not exported');
});

test('the printed name sits below the signature box and clear of the rule', () => {
  const source = read(PDF);
  const name = parseBox(source, 'HOUSEPARENT_NAME_POS');
  const box = parseBox(source, 'HOUSEPARENT_SIGNATURE_BOX');

  // Order on the line, top to bottom: E-Signature, typed name, printed rule.
  // The rule's ink tops out at y 772.5; an 8pt Helvetica-Bold glyph box spans
  // 2.46 below to 8.56 above its baseline (taken from the generated PDF).
  const RULE_INK_TOP = 772.5;
  const NAME_ASCENT = 8.56;
  const NAME_DESCENT = 2.46;

  assert.ok(
    name.y - NAME_DESCENT >= RULE_INK_TOP,
    `the name drops to y=${(name.y - NAME_DESCENT).toFixed(2)}, through the printed rule at y=${RULE_INK_TOP}`
  );
  assert.ok(
    name.y + NAME_ASCENT <= box.y,
    `the name reaches y=${(name.y + NAME_ASCENT).toFixed(2)}, into the signature box which starts at y=${box.y}`
  );
  assert.equal(name.page, box.page, 'the name and the signature must be on the same page');
});

test('the stamp lands on the last page, where the signature block is printed', () => {
  const box = parseBox(read(PDF), 'HOUSEPARENT_SIGNATURE_BOX');

  // The "Assessed by" block is on page 8 of 8, which is index 7.
  assert.equal(box.page, 7, `the signature is stamped on page index ${box.page}, not the signature page`);
  assert.match(
    read(PDF),
    /pages\[HOUSEPARENT_SIGNATURE_BOX\.page\]/,
    'the stamp ignores the box\'s page and always draws on page 1'
  );
  // The other four lines take their page from the layout, not from a constant, so
  // moving the block in `triLayout.json` moves the stamp with it.
  assert.match(
    read(PDF),
    /pages\[geometry\.page\]/,
    'the other lines ignore their layout geometry\'s page'
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
    /\$\{signed\} of \$\{total\} signature lines are signed/,
    'the subject no longer says how many lines are signed',
  );
  assert.match(
    source,
    /the remaining signature lines are blank/,
    'the subject no longer says that the unsigned lines are blank',
  );
  assert.match(
    source,
    /Signature lines are blank; this is not the signed original\./,
    'the fully-unsigned subject is gone',
  );
  // Every line is classified by what the stamping call actually returned, so a line
  // cannot be reported as signed when no drawing was placed. The Houseparent's line
  // has its own call; the other four are counted by `drawOtherSignatories`, which
  // increments only when `stampSignature` resolved true.
  assert.match(
    source,
    /const houseparentSigned = await drawHouseparentSignature\(pdf, pages, record\)/,
    'the stamping result is not captured, so the subject cannot report it',
  );
  assert.match(
    source,
    /const othersSigned = await drawOtherSignatories\(pdf, pages, record, layout, bold\)/,
    'the other lines\' stamping result is not captured',
  );
  assert.match(
    source,
    /if \(await stampSignature\(pdf, page, signatorySignatureOf\(record, slot\), box\)\) signed \+= 1;/,
    'a stamped line is not being recorded as signed',
  );
  // And the count is over the declared line list, so a rename cannot leave the
  // subject naming a line the form no longer has.
  assert.match(source, /const total = TRI_SIGNATORY_SLOTS\.length;/, 'the subject no longer counts the declared lines');
  assert.match(source, /title: 'Houseparent'/, 'the Houseparent line has no title');
  assert.match(source, /title: 'SWO I \/ Case Manager'/, 'the SWO I line has no title');
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
  // One pad per page-8 line, labelled with the line's position.
  assert.match(source, /label=\{`\$\{title\} signature`\}/, 'the TRI form has no labelled signature field');
  for (const title of ['Houseparent', 'Administrative Officer', 'SWO I / Case Manager']) {
    assert.ok(source.includes(`title: '${title}', hasName: true`), `the ${title} line has no name text holder`);
  }
  for (const printed of ['MARICOR C. NAVARRO, RSW, MSSW', 'NICOLAS Q. REGALARIO, RSW, MSSW']) {
    assert.ok(source.includes(`hasName: false, printedName: '${printed}'`), `${printed} has no E-Signature line`);
  }
  // The Houseparent's own signature keeps its endpoint; the other lines save through /signatories.
  assert.match(source, /'\/tri\/'\s*\+\s*\w+\.id\s*\+\s*'\/signature'/, 'the pad is not wired to the signature endpoint');
  assert.match(source, /'\/tri\/'\s*\+\s*\w+\.id\s*\+\s*'\/signatories'/, 'the other lines are not wired to the signatories endpoint');
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
  const pageEight = source.indexOf('pageNumber={8}');
  assert.ok(pageEight !== -1, 'the TRI editor no longer renders page 8');
  assert.ok(
    source.indexOf('<SignaturePadModal') > pageEight,
    'the signing surface is not on page 8, which is where the form asks for it'
  );
  assert.match(source, /data-tri-signature-slot=\{slot\}/, 'the signature slots are not rendered per line');
});

test('the pad locks once the TRI is finalized', () => {
  const source = read(TRI_UI);
  assert.match(source, /const finalized = record\?\.status === 'Finalized';/, 'the page-8 block ignores the Finalized status');
  assert.match(
    source,
    /const mayWrite = !finalized && \(slot === 'houseparent' \? canSignHouseparent : canSignReviewerLines\);/,
    'a line stays editable on a finalized TRI'
  );
});

test('the signing surfaces are one per signable line, each gated to its own role', () => {
  const source = read(TRI_UI);

  // One pad in the source, rendered per line — and each line is written only by
  // its owner: the Houseparent line by the Houseparent, the other four by a reviewer.
  assert.equal(
    (source.match(/<SignaturePadModal/g) || []).length,
    1,
    'the TRI form renders a second, ungated signing surface'
  );
  assert.match(source, /canSignHouseparent=\{isHouseparent\}/, 'the Houseparent line is not limited to a Houseparent');
  assert.match(source, /canSignReviewerLines=\{canReview\}/, 'the other lines are not limited to a reviewer');
  // Center Head and Social Worker still get approve / send-for-reassessment.
  assert.match(source, /Send for reassessment/, 'the reviewer lost the return action');

  const routes = read(ROUTES);
  assert.match(routes, /router\.put\('\/:id\/signatories'[\s\S]*?triController\.updateSignatories\)/, 'PUT /:id/signatories is not wired');
  const handler = read(CONTROLLER).match(/async function updateSignatories\(req, res, next\) \{([\s\S]*?)\n\}/);
  assert.ok(handler, 'the signatories handler was not found');
  assert.match(handler[1], /slot === 'houseparent'[\s\S]*?roleOf\(req\.user\) !== 'houseparent'/, 'anyone can write the Houseparent name');
  assert.match(handler[1], /!canReview\(req\.user\)/, 'anyone can write the reviewer lines');
  assert.match(handler[1], /record\.status === 'Finalized'/, 'a finalized TRI can still be changed');
});

test('the Houseparent name is filled in automatically, on the signature page', () => {
  const source = read(TRI_UI);

  // A text holder the name is typed into, suggesting the automatic name.
  assert.match(source, /function TriNameField\(/, 'there is no name text holder');
  assert.match(
    source,
    /const houseparentName = selectedRecord\?\.houseparentSignedBy[\s\S]*?selectedRecord\?\.submittedBy[\s\S]*?isHouseparent \? user\?\.username/,
    'the fallback name is no longer derived from the record and the signed-in Houseparent'
  );
  assert.match(source, /placeholder=\{slot === 'houseparent' && houseparentName \? houseparentName : 'Type name'\}/);
  // The typed name wins; older records keep the name they always printed.
  assert.match(source, /return signatoryTypedName\(record, 'houseparent'\)\s*\|\| String\(record\.houseparentSignedBy \|\| record\.submittedBy/);

  const pageEight = source.indexOf('pageNumber={8}');
  assert.ok(source.indexOf('<TriNameField') > pageEight, 'the name is not on page 8, next to the line it belongs to');
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

  for (const fn of ['openFormalPdfReport', 'openPrintReport']) {
    assert.ok(source.includes(`function ${fn}(`), `${fn} is gone`);
  }
  assert.match(source, /async function drawTriSignatures\(/, 'the shared stamping helper is gone');
  assert.match(source, /await drawTriSignatures\(pdf, pages, record, bold\)/, 'the PDF export no longer stamps the signatures');
  assert.match(source, /record\.houseparentSignature/, 'the export no longer reads the stored Houseparent signature');
  // The print view inlines every line's drawing after validating it.
  assert.match(source, /SIGNATURE_DATA_URL\.test\(signatureDataUrl\)/, 'the print view no longer validates the signature');
  assert.match(source, /const signatureBlocks = TRI_SIGNATORIES\.map\(/, 'the print view no longer prints every signature line');
  assert.match(source, /class="signed"/, 'the printed signature block no longer has a slot for the drawing and the name');
});

test('the browser export reads the same signature geometry as the server', () => {
  const ui = read(TRI_UI);
  const layout = JSON.parse(read(path.resolve(__dirname, '../../frontend/src/shared/triLayout.json')));

  assert.deepEqual(
    { page: layout.houseparentSignatureBox.page, x: layout.houseparentSignatureBox.x, y: layout.houseparentSignatureBox.y, width: layout.houseparentSignatureBox.width, height: layout.houseparentSignatureBox.height },
    { page: 7, x: 72.02, y: 784, width: 90.24, height: 26 },
    'triLayout.json no longer matches the box the server stamps'
  );
  assert.deepEqual(
    { page: layout.houseparentNamePos.page, x: layout.houseparentNamePos.x, y: layout.houseparentNamePos.y, size: layout.houseparentNamePos.size, width: layout.houseparentNamePos.width },
    { page: 7, x: 72.02, y: 775, size: 8, width: 90.24 },
    'triLayout.json no longer matches the name position the server draws'
  );
  // Every line is declared once, for both writers.
  for (const slot of ['houseparent', 'administrativeOfficer', 'caseManager', 'centerHead', 'sectionChief']) {
    assert.ok(layout.signatories[slot], `triLayout.json has no geometry for the ${slot} line`);
    assert.equal(layout.signatories[slot].page, 7, `the ${slot} line is not on page 8`);
  }
  // Signature above name on the three typed lines; above the printed name (rule ~670) for the other two.
  for (const slot of ['houseparent', 'administrativeOfficer', 'caseManager']) {
    const g = layout.signatories[slot];
    assert.ok(g.signatureY >= g.nameY + 8.56, `the ${slot} signature is not above its name`);
    assert.ok(g.signatureY + g.signatureHeight <= 811.4, `the ${slot} signature runs into the text above the block`);
  }
  for (const slot of ['centerHead', 'sectionChief']) {
    const g = layout.signatories[slot];
    assert.ok(g.signatureY >= 670 && g.signatureY + g.signatureHeight <= 749.9, `the ${slot} signature is not between its rule and the captions above`);
  }
  assert.match(ui, /triLayout\.houseparentSignatureBox/, 'the export does not read the shared signature box');
  assert.match(ui, /triLayout\.houseparentNamePos/, 'the export does not read the shared name position');
  assert.match(ui, /triLayout\.signatories/, 'the export does not read the shared signatory geometry');

  const server = read(PDF);
  assert.match(server, /houseparentSignatureBox', HOUSEPARENT_SIGNATURE_BOX/, 'the layout is no longer cross-checked against the writer');
  assert.match(server, /houseparentNamePos', HOUSEPARENT_NAME_POS/, 'the name position is no longer cross-checked against the writer');
});
