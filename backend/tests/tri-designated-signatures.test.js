/**
 * Regression guards for the four designated officials on the TRI.
 *
 * The official TRI's "Assessed by" block carries five signature lines in two rows:
 *
 *   row 1  Houseparent            Administrative Officer   SWO I/Case Manager
 *   row 2  SWO II/Center Head                             SWO III/Section Chief
 *
 * The Houseparent's line is pinned by `tri-houseparent-signature.test.js`. The other
 * four are the facility's designated personnel, and each is signed and stored on its
 * own line: a reviewer must not be able to write the Houseparent's line, and the
 * Houseparent must not be able to write theirs, so the two are separate routes over
 * separate columns. Several tests below exist to keep them separate — folding them
 * back into one route with a `line` parameter is the regression.
 *
 * THE COVER BAND IS GONE, ON PURPOSE. An earlier design assumed the template's second
 * row printed stale example names, so both writers painted a white band over them and
 * printed the real names on top. The facility then confirmed the opposite: the two
 * names the form prints there (Maricor C. Navarro, Nicolas Q. Regalario) are the
 * correct people, and the band was hiding them. So row 2 now draws NO name at all and
 * only stamps a signature, and a cover band reappearing anywhere on this block is the
 * defect. The tests below pin that, because a white rectangle on a PDF is invisible
 * without opening the document.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const SCHEMA = 'backend/src/database/schema.sql';
const SERVER = 'backend/src/server.js';
const CONTROLLER = 'backend/src/controllers/triController.js';
const ROUTES = 'backend/src/routes/triRoutes.js';
const PDF = 'backend/src/utils/triReportPdf.js';
const TRI_UI = 'frontend/src/app/components/Tri.tsx';
const LAYOUT = 'frontend/src/shared/triLayout.json';

/**
 * Each line's key, and the three columns its drawing and its signer are stored in.
 *
 * The keys name the LINE, not the office-holder, because the people on them change.
 * `swo2`/`swo3` keep the column names they shipped with (`centerhead*`,
 * `sectionchief*`) so the signatures already stored on live records are not moved —
 * pinning that mapping is the point of this table.
 */
const COLUMNS = {
  adminofficer: ['adminOfficerSignature', 'adminOfficerSignedBy', 'adminOfficerSignedAt'],
  swo1: ['swo1Signature', 'swo1SignedBy', 'swo1SignedAt'],
  swo2: ['centerheadSignature', 'centerheadSignedBy', 'centerheadSignedAt'],
  swo3: ['sectionchiefSignature', 'sectionchiefSignedBy', 'sectionchiefSignedAt'],
};

const ALL_COLUMNS = Object.values(COLUMNS).flat();

/** The four people the facility named, exactly as they must print. */
const DESIGNATED = {
  adminofficer: 'PERCILA S. VILLA',
  swo1: 'FRANCIS C. PATRICIO, RSW',
  swo2: 'MARICOR C. NAVARRO, MSSW, RSW',
  swo3: 'NICOLAS Q. REGALARIO, MSSW, RSW',
};

/** The two lines the template prints its own name for, and the extent of that name. */
const TEMPLATE_PRINTED = { swo2: 179.32, swo3: 188.12 };

/**
 * Measurements taken from the template's own text layer with pdf.js, not assumed.
 * Page 8 is 612 x 936 and the origin is bottom-left, so a larger y is higher up.
 */
const TEMPLATE = {
  // Row 1 — the rules' ink tops out at 772.5, captions sit at 752.11.
  rowOneRuleTop: 772.5,
  rowOneCaptionBaseline: 752.11,
  // Row 2 — the rules' ink tops out at 670.25, the printed names are at 649.61 and
  // the captions at 638.09.
  rowTwoRuleTop: 670.25,
  rowTwoNameBaseline: 649.61,
  rowTwoCaptionBaseline: 638.09,
  // The descenders of the heading above the whole block,
  // "The Rehabilitation Team together with the resident:".
  headingDescentBottom: 811.4,
  // No caption in this block has descenders, so its ink bottom is its baseline.
  nameDescent: 2.1,
};

const layout = JSON.parse(read(LAYOUT));

/**
 * The layout key for each line's box and (where the app prints one) its name.
 *
 * Spelled out rather than derived from the line key, because the two are not the same
 * string: the line key is `adminofficer` (it is a URL segment, lowercased by the
 * handler) while the layout key is `adminOfficerSignatureBox`. A `${key}SignatureBox`
 * template would silently resolve to undefined and every geometry check below would
 * pass against nothing.
 */
const LAYOUT_BOX = {
  houseparent: 'houseparentSignatureBox',
  adminofficer: 'adminOfficerSignatureBox',
  swo1: 'swo1SignatureBox',
  swo2: 'swo2SignatureBox',
  swo3: 'swo3SignatureBox',
};
const LAYOUT_NAME = {
  houseparent: 'houseparentNamePos',
  adminofficer: 'adminOfficerNamePos',
  swo1: 'swo1NamePos',
};

/* ================================================================
   STORAGE
   ================================================================ */

test('triRecords has somewhere to keep each official signature', () => {
  const schema = read(SCHEMA);
  const table = schema.match(/CREATE TABLE triRecords \(([\s\S]*?)\n\)\s*ENGINE/);
  assert.ok(table, 'the triRecords table definition was not found in schema.sql');

  for (const column of ALL_COLUMNS) {
    assert.match(table[1], new RegExp(`\\b${column}\\b`), `triRecords has no ${column} column`);
  }

  // The table is created by the boot migration too, and the two must agree — a
  // database built by the migration alone would be missing the columns.
  const server = read(SERVER);
  for (const column of ALL_COLUMNS) {
    assert.match(
      server,
      new RegExp(`\\b${column} (LONGTEXT|VARCHAR\\(100\\)|DATETIME) NULL`),
      `the triRecords CREATE TABLE in server.js does not declare ${column}`,
    );
  }
});

test('an existing database gets all twelve signature columns on boot', () => {
  const source = read(SERVER);

  for (const column of ALL_COLUMNS) {
    assert.ok(
      source.includes(`['${column}'`),
      `server.js never migrates triRecords.${column}, so the first signature save would fail with ER_BAD_FIELD_ERROR on an older database`,
    );
  }
  // A second boot must not crash the migration with a duplicate-column error.
  assert.match(source, /err\.errno === 1060/, 'the migration does not tolerate the column already existing');
});

test('the columns the second row already uses are never renamed', () => {
  // `centerhead*`/`sectionchief*` are live: real records carry signatures in them.
  // Renaming them to match the new line keys would strand those drawings — a silent
  // loss of a signature on a published document. The map is the only place the
  // mapping lives, so it is pinned here.
  const controller = read(CONTROLLER);
  const map = controller.match(/const OFFICIAL_SIGNATURE_LINES = \{([\s\S]*?)\n\};/);
  assert.ok(map, 'the line map was not found');

  assert.match(map[1], /swo2:[\s\S]*?'centerheadSignature'/, 'the SWO II line no longer reads centerheadSignature');
  assert.match(map[1], /swo3:[\s\S]*?'sectionchiefSignature'/, 'the SWO III line no longer reads sectionchiefSignature');
  assert.doesNotMatch(map[1], /'swo2Signature'|'swo3Signature'/, 'a column was renamed to match the line key, stranding the stored drawings');

  // And the writer must read the same columns, or a published copy would print a
  // signature the record does not have.
  const pdf = read(PDF);
  assert.match(pdf, /signatureColumn: 'centerheadSignature'/, 'the writer does not read centerheadSignature for the SWO II line');
  assert.match(pdf, /signatureColumn: 'sectionchiefSignature'/, 'the writer does not read sectionchiefSignature for the SWO III line');
});

/* ================================================================
   THE ENDPOINT — a separate route, over separate columns
   ================================================================ */

test('the official lines are a separate route from the Houseparent line', () => {
  const routes = read(ROUTES);

  // The Houseparent's line keeps its own, narrow gate. If a `line` parameter had
  // been added to it instead, this line would have had to widen — which is exactly
  // the regression the sibling suite pins against.
  const houseparentRoute = routes.match(/router\.post\('\/:id\/signature'[^\n]*/);
  assert.ok(houseparentRoute, 'POST /:id/signature is gone');
  assert.match(houseparentRoute[0], /authorize\('houseparent'\)/, "the Houseparent's line is no longer Houseparent-only");
  for (const role of ['socialworker', 'centerhead', 'admin']) {
    assert.doesNotMatch(
      houseparentRoute[0],
      new RegExp(`'${role}'`),
      `a ${role} can now write the Houseparent's signature`,
    );
  }

  // The official lines have their own path, with their own gate.
  const officialRoute = routes.match(/router\.post\('\/:id\/signature\/:line'[^\n]*/);
  assert.ok(officialRoute, 'POST /:id/signature/:line is missing, so the official lines cannot be signed at all');
  for (const role of ['socialworker', 'centerhead', 'admin']) {
    assert.match(officialRoute[0], new RegExp(`'${role}'`), `a ${role} cannot sign the official lines`);
  }
  assert.doesNotMatch(
    officialRoute[0],
    /'houseparent'/,
    'a Houseparent can write an official line they are not the designated person for',
  );
  assert.match(officialRoute[0], /triController\.signOfficialLine/, 'the route is not wired to the handler');
});

test('the handler only ever touches a line the map declares', () => {
  const source = read(CONTROLLER);
  const handler = source.match(/async function signOfficialLine\(req, res, next\) \{([\s\S]*?)\n\}/);
  assert.ok(handler, 'signOfficialLine was not found');

  // The line is matched against a fixed map, so an unknown one is a 400 rather than
  // a fallback that writes somewhere unexpected.
  assert.match(source, /const OFFICIAL_SIGNATURE_LINES = \{/, 'the line map is gone');
  assert.match(handler[1], /OFFICIAL_SIGNATURE_LINES\[key\]/, 'the handler does not look the line up');
  assert.match(handler[1], /if \(!line\)/, 'an unknown line is not refused');

  // Only the reviewing roles may sign here.
  assert.match(handler[1], /if \(!canReview\(req\.user\)\)/, 'the handler does not gate on the reviewing roles');

  // Column names come from the map, never from the request.
  assert.match(handler[1], /\$\{line\.signature\} = \?/, 'the signature column is not taken from the map');
  assert.match(handler[1], /\$\{line\.signedBy\} = \?/, 'the signer column is not taken from the map');
  assert.match(handler[1], /\$\{line\.signedAt\} = \?/, 'the timestamp column is not taken from the map');
  assert.doesNotMatch(handler[1], /req\.params\.line\s*\}\s*=/, 'the request value is being interpolated into the SQL');

  // Same payload contract as the Houseparent's line.
  assert.match(handler[1], /data:image\\\/\(png\|jpeg\|jpg\);base64,/, 'the data-URL shape is not validated');
  assert.match(handler[1], /status === 'Finalized'/, 'a finalized TRI can still be re-signed');
  assert.match(handler[1], /canAccessResident\(req\.user, record\.residentId\)/, 'the handler does not check the caller is assigned to the resident');

  // And it must never submit: an official signs a record already in front of them,
  // so auto-submitting would let a reviewer push a record through on their own
  // signature.
  assert.doesNotMatch(handler[1], /submit/i, 'signing an official line advances the record');
});

test('the four official lines are stored separately, so a drawing cannot be misattributed', () => {
  const source = read(CONTROLLER);
  const map = source.match(/const OFFICIAL_SIGNATURE_LINES = \{([\s\S]*?)\n\};/);
  assert.ok(map, 'the line map was not found');

  const seen = new Set();
  for (const [key, columns] of Object.entries(COLUMNS)) {
    assert.match(map[1], new RegExp(`\\b${key}:`), `the map has no entry for ${key}`);
    for (const column of columns) {
      assert.match(map[1], new RegExp(`'${column}'`), `the map does not name ${column}`);
      assert.ok(!seen.has(column), `${column} is claimed by two lines`);
      seen.add(column);
    }
  }
});

test('the frontend and the backend agree on the four line keys', () => {
  // A mismatch here is a silent 400 at the pad: the export would post a key the
  // server does not know, and the signature would never save.
  const controller = read(CONTROLLER);
  const map = controller.match(/const OFFICIAL_SIGNATURE_LINES = \{([\s\S]*?)\n\};/)[1];
  const backendKeys = [...map.matchAll(/^\s{2}(\w+): \{/gm)].map((m) => m[1]);

  const ui = read(TRI_UI);
  const from = ui.indexOf('const TRI_OFFICIAL_LINES');
  assert.ok(from !== -1, 'the frontend no longer declares its official lines');
  const block = ui.slice(from, ui.indexOf('\n];', from));
  const uiKeys = [...block.matchAll(/key: '(\w+)'/g)].map((m) => m[1]);

  assert.deepEqual(backendKeys.sort(), ['adminofficer', 'swo1', 'swo2', 'swo3'], 'the server no longer knows four official lines');
  assert.deepEqual(uiKeys.sort(), backendKeys.sort(), 'the export would post a line key the server does not know');
});

/* ================================================================
   THE SHARED LAYOUT — geometry and the names
   ================================================================ */

test('the layout carries all four designated names', () => {
  assert.ok(layout.designatedPersonnel, 'triLayout.json has no designatedPersonnel block');
  for (const [key, name] of Object.entries(DESIGNATED)) {
    const person = layout.designatedPersonnel[key];
    assert.ok(person, `triLayout.json names nobody for ${key}`);
    assert.equal(person.name, name, `${key}'s printed name changed`);
    assert.ok(String(person.role || '').trim(), `${key} has no printed role`);
  }
  // The Houseparent's line is deliberately absent: it is not a fixed person, it is
  // whoever prepared and signed the report.
  assert.equal(layout.designatedPersonnel.houseparent, undefined, 'the Houseparent must not be a fixed designated person');
});

test('the two names the template prints are the same people the layout names', () => {
  // This is the correction that removed the cover band. The template prints its own
  // names on the second row; if the layout disagreed with them, one of the two would
  // have to be painted out, and painting out a correct name is the defect.
  assert.equal(DESIGNATED.swo2, 'MARICOR C. NAVARRO, MSSW, RSW');
  assert.equal(DESIGNATED.swo3, 'NICOLAS Q. REGALARIO, MSSW, RSW');

  // And the layout's recorded ink extent is the template's own, which is what a
  // signature with no drawn name is centred over.
  for (const [key, width] of Object.entries(TEMPLATE_PRINTED)) {
    assert.equal(
      layout.designatedPersonnel[key].nameInkWidth,
      width,
      `${key}'s recorded name extent is not the template's measured one`,
    );
    assert.equal(
      layout[`${key}SignatureBox`].width,
      width,
      `${key}'s signature box is no longer the width of the printed name it is centred over`,
    );
  }
});

test('the layout geometry is the same one the writer draws', () => {
  const source = read(PDF);

  // The writer hard-throws on a mismatch, so this is the same contract stated twice:
  // once as coordinates, once as the cross-check that refuses to boot without them.
  const pairs = [
    ['houseparentSignatureBox', 'HOUSEPARENT_SIGNATURE_BOX'],
    ['houseparentNamePos', 'HOUSEPARENT_NAME_POS'],
    ['adminOfficerSignatureBox', 'ADMIN_OFFICER_SIGNATURE_BOX'],
    ['adminOfficerNamePos', 'ADMIN_OFFICER_NAME_POS'],
    ['swo1SignatureBox', 'SWO1_SIGNATURE_BOX'],
    ['swo1NamePos', 'SWO1_NAME_POS'],
    ['swo2SignatureBox', 'SWO2_SIGNATURE_BOX'],
    ['swo3SignatureBox', 'SWO3_SIGNATURE_BOX'],
  ];
  for (const [layoutKey, constant] of pairs) {
    assert.ok(layout[layoutKey], `triLayout.json has no ${layoutKey}`);
    assert.match(source, new RegExp(`const ${constant} = \\{`), `${constant} is not defined in the writer`);
    assert.match(
      source,
      new RegExp(`'${layoutKey}', ${constant}`),
      `${layoutKey} is not cross-checked against ${constant}, so the two copies could drift`,
    );
  }
});

test('the writer declares exactly the five lines, one per signature line on the form', () => {
  const source = read(PDF);
  const list = source.match(/const SIGNATURE_LINES = \[([\s\S]*?)\n\];/);
  assert.ok(list, 'SIGNATURE_LINES was not found');

  const keys = [...list[1].matchAll(/key: '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    keys,
    ['houseparent', 'adminofficer', 'swo1', 'swo2', 'swo3'],
    'the writer no longer stamps all five lines, in the order they appear across the page',
  );
});

test('every signature box sits in the blank band above its own rule', () => {
  const rowOne = ['houseparent', 'adminofficer', 'swo1'];
  const rowTwo = ['swo2', 'swo3'];

  for (const key of rowOne) {
    const box = layout[LAYOUT_BOX[key]];
    assert.ok(box, `${key} has no signature box in triLayout.json`);
    assert.equal(box.page, 7, `${key}'s signature would be stamped on page index ${box.page}, not the signature page`);
    assert.ok(
      box.y >= TEMPLATE.rowOneRuleTop,
      `${key}'s box starts at y=${box.y}, on or below the printed rule whose ink tops out at y=${TEMPLATE.rowOneRuleTop}`,
    );
    assert.ok(
      box.y + box.height <= TEMPLATE.headingDescentBottom,
      `${key}'s box ends at y=${box.y + box.height}, into the heading above whose descenders reach y=${TEMPLATE.headingDescentBottom}`,
    );
    assert.ok(box.height >= 18, `a ${box.height}pt tall box is too small to sign in`);
    assert.ok(box.width >= 60, `a ${box.width}pt wide box is too narrow to sign in`);
  }

  for (const key of rowTwo) {
    const box = layout[LAYOUT_BOX[key]];
    assert.ok(box, `${key} has no signature box in triLayout.json`);
    assert.equal(box.page, 7, `${key}'s signature would be stamped on page index ${box.page}, not the signature page`);
    assert.ok(
      box.y >= TEMPLATE.rowTwoRuleTop,
      `${key}'s box starts at y=${box.y}, on or below the printed rule whose ink tops out at y=${TEMPLATE.rowTwoRuleTop}`,
    );
    // Row 2 sits below row 1's captions, so the box must not reach up into them.
    assert.ok(
      box.y + box.height <= TEMPLATE.rowOneCaptionBaseline,
      `${key}'s box ends at y=${box.y + box.height}, into row 1's caption at y=${TEMPLATE.rowOneCaptionBaseline}`,
    );
    assert.ok(box.height >= 18, `a ${box.height}pt tall box is too small to sign in`);
  }
});

test('the drawn names sit below their signature and above their rule', () => {
  // The requirement: on the TRI the name goes below the signature, so the rule reads
  // as the underline of the name. That applies to the three lines the app prints a
  // name for — the Houseparent's and row 1's two officials.
  for (const key of ['houseparent', 'adminofficer', 'swo1']) {
    const box = layout[LAYOUT_BOX[key]];
    const namePos = layout[LAYOUT_NAME[key]];

    assert.ok(namePos, `${key} has no printed-name position`);
    assert.ok(
      namePos.y <= box.y,
      `${key}'s name baseline is y=${namePos.y}, above its signature box at y=${box.y} — the name must go below the signature`,
    );
    // And the descenders must clear the rule it is meant to sit on.
    assert.ok(
      namePos.y - TEMPLATE.nameDescent >= TEMPLATE.rowOneRuleTop,
      `${key}'s name drops to y=${namePos.y - TEMPLATE.nameDescent}, through the rule whose ink tops out at y=${TEMPLATE.rowOneRuleTop}`,
    );
  }
});

test('no name is drawn for the two lines the template already prints', () => {
  // The template prints both second-row names itself, and they are the right people.
  // Drawing one would put two names on top of each other; painting the template's out
  // would hide a correct name. So these two lines carry a signature and nothing else.
  for (const key of ['swo2', 'swo3']) {
    assert.equal(layout[`${key}NamePos`], undefined, `${key} has a printed-name position again — the template already prints that name`);
  }

  const source = read(PDF);
  const list = source.match(/const SIGNATURE_LINES = \[([\s\S]*?)\n\];/)[1];
  for (const key of ['swo2', 'swo3']) {
    const entry = list.match(new RegExp(`key: '${key}',([\\s\\S]*?)\\n  \\},`));
    assert.ok(entry, `${key} is missing from the writer's line list`);
    assert.match(entry[1], /nameFrom: 'template'/, `${key} no longer declares that the template prints its name`);
    assert.match(entry[1], /namePos: null/, `${key} would draw a name over the one the template already prints`);
  }
});

/* ================================================================
   THE WRITERS — name below the signature, signature centred over the name
   ================================================================ */

test('the writer draws each name from the shared layout, and never paints one out', () => {
  const source = read(PDF);

  assert.match(source, /function drawLineName\(/, 'the name helper is gone');
  assert.match(source, /designatedNameOf\(layout, line\.key\)/, 'the printed name does not come from the shared layout');
  assert.match(source, /designatedNameOf,\s*\n\};|designatedNameOf,/, 'the name helper is not exported, so a test cannot pin it');

  // No cover band, anywhere on this block. The template's own second-row names are
  // the right people, so there is nothing to hide.
  assert.doesNotMatch(source, /DESIGNATED_NAME_COVER/, 'the writer still has a cover band');
  assert.doesNotMatch(source, /drawRectangle/, 'the writer paints a rectangle over the signature block');
  assert.doesNotMatch(source, /rgb\(1, 1, 1\)/, 'the writer still paints white on this block');
});

test('the writer centres each signature over its printed name, not over the empty box', () => {
  const source = read(PDF);
  const helper = source.match(/async function drawLineSignature\(([\s\S]*?)\n\}/);
  assert.ok(helper, 'drawLineSignature was not found');

  assert.match(helper[1], /anchorWidth/, 'the signature is not anchored to the printed name');
  assert.match(
    helper[1],
    /box\.x \+ \(anchorWidth - width\) \/ 2/,
    'the signature is not centred over the name it belongs to',
  );
  assert.doesNotMatch(
    helper[1],
    /box\.x \+ \(box\.width - width\) \/ 2/,
    'the signature is still centred on the box, so it floats away from a short name',
  );
  // A line the template prints itself has no drawn name to measure, so it falls back
  // to the template's own recorded extent rather than to the rule's width.
  assert.match(helper[1], /nameWidth != null \? nameWidth : \(line\.nameInkWidth \|\| box\.width\)/, 'the fallback for a template-printed name changed');
});

test('an unsigned or undecodable line leaves that line blank instead of aborting', () => {
  const source = read(PDF);
  const helper = source.match(/async function drawLineSignature\(([\s\S]*?)\n\}/);
  assert.ok(helper, 'the stamping helper was not found');

  assert.match(helper[1], /if \(!match\) return false;/, 'a missing signature is not handled');
  assert.match(helper[1], /catch \{[\s\S]*?return false;/, 'a decode failure is not swallowed');
  // One bad image must not stop the loop that draws the other lines.
  assert.doesNotMatch(helper[1], /throw/, 'a decode failure escapes and would abort the document');
});

test('the published copy records which lines were signed and which were left blank', () => {
  // The subject line is the only place a reader is told the document is a system
  // copy, so it has to be built from what was actually stamped rather than from a
  // fixed sentence a second signer would make untrue.
  const source = read(PDF);
  assert.match(source, /const signedRoles = \[\];/, 'the writer no longer tracks which lines were signed');
  assert.match(source, /const blankRoles = \[\];/, 'the writer no longer tracks which lines were left blank');
  assert.match(source, /Signed: \$\{signedRoles\.join\(', '\)\}/, 'the subject no longer names the signed lines');
  assert.match(source, /Left blank: \$\{blankRoles\.join\(', '\)\}/, 'the subject no longer names the blank lines');
  assert.match(source, /this is not the signed original/, 'the unsigned case no longer disclaims being the original');
});

test('the browser export stamps the same five lines as the server', () => {
  const source = read(TRI_UI);

  assert.match(source, /async function drawTriOfficialSignatures\(/, 'the shared stamping helper is gone');
  assert.match(source, /await drawTriOfficialSignatures\(pdf, pages, record, bold\)/, 'the PDF export no longer stamps the official lines');
  assert.match(source, /await drawTriHouseparentSignature\(pdf, pages, record, bold\)/, 'the PDF export no longer stamps the Houseparent line');
  assert.match(source, /const TRI_OFFICIAL_LINES: TriOfficialLine\[\] = \[/, 'the frontend no longer knows which lines to stamp');
  assert.match(source, /triLayout\.swo1SignatureBox|triLayout\.adminOfficerSignatureBox/, 'the export does not read the shared boxes');

  // No cover band here either — and nothing white painted on the block.
  assert.doesNotMatch(source, /TRI_DESIGNATED_NAME_COVER/, 'the export still has a cover band');
  assert.doesNotMatch(source, /drawTriOfficialSignatures[\s\S]{0,2000}drawRectangle/, 'the export paints a rectangle over the block');
});

test('the browser export centres each signature over its name too', () => {
  const source = read(TRI_UI);
  assert.match(
    source,
    /const anchorWidth = nameWidth \|\| line\.nameInkWidth \|\| box\.width/,
    'the export does not anchor a signature to its printed name',
  );
  assert.match(source, /box\.x \+ \(anchorWidth - width\) \/ 2/, 'the export does not centre a signature over its name');
  assert.doesNotMatch(
    source,
    /box\.x \+ \(box\.width - width\) \/ 2/,
    'the export still centres a signature on the box, so it floats away from a short name',
  );
  // The Houseparent's line has the same contract.
  assert.match(
    source,
    /const anchorWidth = nameWidth \|\| box\.width/,
    "the export does not centre the Houseparent's signature over their name",
  );
});

/* ================================================================
   THE FORM AND THE PRINT VIEW
   ================================================================ */

test('the record interface carries all four officials signature fields', () => {
  const source = read(TRI_UI);
  const iface = source.match(/interface TriRecord \{([\s\S]*?)\n\}/);
  assert.ok(iface, 'the TriRecord interface was not found');

  for (const column of ALL_COLUMNS) {
    assert.match(iface[1], new RegExp(`\\b${column}\\b`), `TriRecord does not declare ${column}`);
  }
});

test('the printed signature block carries all five lines, with every printed name', () => {
  const source = read(TRI_UI);

  // The block used to render four lines with two of them blank; the official form has
  // five, and every one of them now prints its name. The Houseparent's line is built
  // inline; the four officials come from one builder keyed by line, so a caption
  // cannot be attached to the wrong signature.
  assert.match(source, /signatureCellHtml\('Houseparent', signatureName, signatureDataUrl\)/, 'the printed block lost the Houseparent line');
  assert.match(source, /const officialCellHtml = \(key: string\)/, 'the four official lines are not printed from one builder');
  for (const key of ['adminofficer', 'swo1', 'swo2', 'swo3']) {
    assert.match(source, new RegExp(`officialCellHtml\\('${key}'\\)`), `the printed block lost the ${key} line`);
  }
  assert.match(source, /\$\{signatureRowOne\}/, 'the first signature row is computed and then never rendered');
  assert.match(source, /\$\{signatureRowTwo\}/, 'the second signature row is computed and then never rendered');
  assert.match(source, /designatedLineName\(line\.key\)/, 'the printed names do not come from the shared layout');
  // The drawing is inlined only after the strict shape check, exactly as the
  // Houseparent's is.
  assert.match(source, /SIGNATURE_DATA_URL\.test\(dataUrl\)/, 'the printed official signature is not shape-checked');
  // Every line prints its name, including the two the official template carries — this
  // is a generated summary, not the template.
  assert.match(source, /const slot = img \|\| name \? 'signed' : ''/, 'the printed line no longer has a slot for the drawing and the name');
});

test('the five official lines have a pad each, on the signature page', () => {
  const source = read(TRI_UI);

  const pageEight = source.indexOf('pageNumber={8}');
  assert.ok(pageEight !== -1, 'the TRI editor no longer renders page 8');
  assert.ok(
    source.indexOf('data-tri-designated-name') > pageEight,
    'the official names are not rendered on page 8, where the block is printed',
  );
  assert.ok(
    source.lastIndexOf('<SignaturePadModal') > pageEight,
    'the official pads are not on page 8',
  );
  assert.match(source, /onSaveOfficialSignature\(line\.key, next\)/, 'the official pad is not wired to the handler');
  assert.match(source, /'\/tri\/' \+ selectedRecord\.id \+ '\/signature\/' \+ line/, 'the handler does not post to the per-line route');
  assert.match(source, /record\?\.status === 'Finalized'/, 'the official pads stay editable on a finalized TRI');
});

test('the on-screen form draws the first row\'s names and no name for the second', () => {
  const source = read(TRI_UI);

  // The form renders page 8 of the template underneath itself. Row 1 is blank on the
  // template, so the app draws those names; row 2 is printed by the template, so it
  // must draw none — a name span for `swo2`/`swo3` would print two names on top of
  // each other, and the band that used to hide the template's name was hiding a
  // correct one.
  const mapAt = source.indexOf('canSignOfficial && TRI_OFFICIAL_LINES.map(');
  assert.ok(mapAt !== -1, 'the official lines are not rendered on the form');
  const block = source.slice(mapAt, source.indexOf('</React.Fragment>', mapAt));
  assert.ok(block.length > 0, 'the official line block was not found');

  // The name is drawn only when the line has a name position.
  assert.match(block, /namePos && designatedLineName\(line\.key\)/, 'the on-screen name is not gated on the line having a name position');
  assert.match(block, /pdfPercentTop\(namePos\.y \+ 3, 11\)/, 'the on-screen name is not placed from the shared name position');
  assert.doesNotMatch(block, /bg-white/, 'the on-screen form still paints a white band on this block');

  // The two template-printed lines carry no name position, which is what makes the
  // `namePos &&` guard above skip them. `data-tri-designated-name={line.key}` is an
  // expression, so a literal-looking search for the rendered attribute would pass
  // whatever the constants said — the constants are the thing to check.
  const from = source.indexOf('const TRI_OFFICIAL_LINES');
  const constants = source.slice(from, source.indexOf('\n];', from));
  for (const key of ['swo2', 'swo3']) {
    const entry = constants.match(new RegExp(`key: '${key}',([\\s\\S]*?)\\n  \\},`));
    assert.ok(entry, `${key} is missing from the frontend's line list`);
    assert.match(entry[1], /namePos: null/, `${key} would draw a name over the one the template already prints`);
  }
  // And the two lines the app does print a name for do carry one.
  for (const key of ['adminofficer', 'swo1']) {
    const entry = constants.match(new RegExp(`key: '${key}',([\\s\\S]*?)\\n  \\},`));
    assert.ok(entry, `${key} is missing from the frontend's line list`);
    assert.match(entry[1], /namePos: triLayout\./, `${key} has no name position, so the form would print no name for it`);
  }
});
