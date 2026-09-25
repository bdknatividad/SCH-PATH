/**
 * Regression guards for the two designated officials on the TRI.
 *
 * The official TRI's "Assessed by" block carries five signature lines in two rows.
 * Two of them are never signed here — "Administrative Officer" and "SWO I/Case
 * Manager" stay blank on every export. The other three carry the people the facility
 * named: the Houseparent who prepared the report (pinned by
 * `tri-houseparent-signature.test.js`) and the two officials on the block's second
 * row, the SWO II/Center Head and the SWO III/Section Chief.
 *
 * What matters here is that the second row is a separate line of authority from the
 * Houseparent's. A reviewer must not be able to write the Houseparent's line, and the
 * Houseparent must not be able to write theirs, so the two are separate routes over
 * separate columns. Several tests below exist to keep them separate — folding them
 * back into one route with a `line` parameter is the regression.
 *
 * The geometry assertions matter for the same reason the Houseparent's do, plus one
 * of their own: the template ALREADY PRINTS an example name on each of these two
 * lines, so the writer has to paint that band out before printing the real name. Get
 * the band wrong and a stale official's name shows through on a published document —
 * which type-checks, builds, and is invisible without opening the PDF.
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

const COLUMNS = {
  centerhead: ['centerheadSignature', 'centerheadSignedBy', 'centerheadSignedAt'],
  sectionchief: ['sectionchiefSignature', 'sectionchiefSignedBy', 'sectionchiefSignedAt'],
};

/**
 * Measurements taken from the template's own text layer with pdf.js, not assumed.
 * Page 8 is 612 x 936 and the origin is bottom-left, so a larger y is higher up.
 */
const TEMPLATE = {
  rowTwoRuleBaseline: 670.25,
  rowTwoNameBaseline: 649.61,
  rowTwoCaptionBaseline: 638.09,
  rowOneCaptionBaseline: 752.11,
  glyphBox: 10.08,
  // Ink extents, which are what a cover band has to clear. The caption
  // "SWO II/Center Head" has no descenders, so its ink top is roughly a cap height
  // above its baseline; the example names carry commas and a Q, so their ink dips
  // below theirs.
  capHeight: 5.8,
  nameDescent: 2.1,
  // Right edge of each printed example name, as extracted.
  exampleNameRight: { centerhead: 251.34, sectionchief: 518.0 },
  exampleNameLeft: { centerhead: 72.02, sectionchief: 329.88 },
};

const layout = JSON.parse(read(LAYOUT));

/* ================================================================
   STORAGE
   ================================================================ */

test('triRecords has somewhere to keep each official signature', () => {
  const schema = read(SCHEMA);
  const table = schema.match(/CREATE TABLE triRecords \(([\s\S]*?)\n\)\s*ENGINE/);
  assert.ok(table, 'the triRecords table definition was not found in schema.sql');

  for (const columns of Object.values(COLUMNS)) {
    for (const column of columns) {
      assert.match(table[1], new RegExp(`\\b${column}\\b`), `triRecords has no ${column} column`);
    }
  }

  // The table is created by the boot migration too, and the two must agree — a
  // database built by the migration alone would be missing the columns.
  const server = read(SERVER);
  for (const column of [...COLUMNS.centerhead, ...COLUMNS.sectionchief]) {
    assert.match(
      server,
      new RegExp(`\\b${column} (LONGTEXT|VARCHAR\\(100\\)|DATETIME) NULL`),
      `the triRecords CREATE TABLE in server.js does not declare ${column}`,
    );
  }
});

test('an existing database gets the two official signature columns on boot', () => {
  const source = read(SERVER);

  for (const column of [...COLUMNS.centerhead, ...COLUMNS.sectionchief]) {
    assert.ok(
      source.includes(`['${column}'`),
      `server.js never migrates triRecords.${column}, so the first signature save would fail with ER_BAD_FIELD_ERROR on an older database`,
    );
  }
  // A second boot must not crash the migration with a duplicate-column error.
  assert.match(source, /err\.errno === 1060/, 'the migration does not tolerate the column already existing');
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
  assert.ok(officialRoute, 'POST /:id/signature/:line is missing, so the two official lines cannot be signed at all');
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

test('the handler only ever touches the two official lines', () => {
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

test('the two official lines are stored separately, so a drawing cannot be misattributed', () => {
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

/* ================================================================
   THE SHARED LAYOUT — geometry and the names
   ================================================================ */

test('the layout carries both designated names', () => {
  assert.ok(layout.designatedPersonnel, 'triLayout.json has no designatedPersonnel block');
  for (const key of Object.keys(COLUMNS)) {
    const person = layout.designatedPersonnel[key];
    assert.ok(person, `triLayout.json names nobody for ${key}`);
    assert.ok(String(person.name || '').trim(), `${key} has no printed name`);
    assert.ok(String(person.role || '').trim(), `${key} has no printed role`);
  }
  // The Center Head's name is the one Form 08 already prints on its own Noted-by /
  // Checked-by lines, so the two modules cannot disagree about who holds the office.
  assert.equal(
    layout.designatedPersonnel.centerhead.name,
    'Francis C. Patricio, RSW',
    "the Center Head's printed name no longer matches Form 08's CHECKED_BY name",
  );
});

test('the layout geometry is the same one the writer draws', () => {
  const source = read(PDF);

  // The writer hard-throws on a mismatch, so this is the same contract stated twice:
  // once as coordinates, once as the cross-check that refuses to boot without them.
  const pairs = [
    ['centerheadSignatureBox', 'CENTERHEAD_SIGNATURE_BOX'],
    ['centerheadNamePos', 'CENTERHEAD_NAME_POS'],
    ['sectionchiefSignatureBox', 'SECTIONCHIEF_SIGNATURE_BOX'],
    ['sectionchiefNamePos', 'SECTIONCHIEF_NAME_POS'],
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

test('each signature box sits in the blank band above its own rule', () => {
  for (const key of ['centerhead', 'sectionchief']) {
    const box = layout[`${key}SignatureBox`];

    assert.equal(box.page, 7, `${key}'s signature would be stamped on page index ${box.page}, not the signature page`);

    // The rule is the line the signature sits on, so the box starts at or above it...
    assert.ok(
      box.y >= TEMPLATE.rowTwoRuleBaseline,
      `${key}'s box starts at y=${box.y}, on or below the printed rule at y=${TEMPLATE.rowTwoRuleBaseline}`,
    );
    // ...and must not reach up into the caption of the row above.
    const rowOneInkBottom = TEMPLATE.rowOneCaptionBaseline - TEMPLATE.nameDescent;
    assert.ok(
      box.y + box.height <= rowOneInkBottom,
      `${key}'s box ends at y=${box.y + box.height}, into the row above whose ink starts at y=${rowOneInkBottom}`,
    );
    // It must be a signature-shaped space, not a sliver.
    assert.ok(box.height >= 18, `a ${box.height}pt tall box is too small to sign in`);
    assert.ok(box.width >= 60, `a ${box.width}pt wide box is too narrow to sign in`);
  }
});

test('each printed name sits below its rule and above its caption', () => {
  for (const key of ['centerhead', 'sectionchief']) {
    const namePos = layout[`${key}NamePos`];

    // Below the rule it belongs to...
    assert.ok(
      namePos.y <= TEMPLATE.rowTwoNameBaseline + 0.5,
      `${key}'s name baseline is ${namePos.y}, above the row's own name baseline of ${TEMPLATE.rowTwoNameBaseline}`,
    );
    // ...and clear of the caption underneath it, or the two would overlap.
    const captionInkTop = TEMPLATE.rowTwoCaptionBaseline + TEMPLATE.capHeight;
    assert.ok(
      namePos.y - TEMPLATE.nameDescent >= captionInkTop,
      `${key}'s name drops to y=${namePos.y - TEMPLATE.nameDescent}, into its caption whose ink tops out at y=${captionInkTop}`,
    );
    // The signature is above the name, which is what the requirement asks for.
    assert.ok(
      layout[`${key}SignatureBox`].y >= namePos.y,
      `${key}'s signature box starts at y=${layout[`${key}SignatureBox`].y}, at or below its printed name at y=${namePos.y}`,
    );
  }
});

test('the cover band hides the template example name without clipping its caption', () => {
  const source = read(PDF);
  const cover = source.match(/const DESIGNATED_NAME_COVER = \{ y: ([\d.]+), height: ([\d.]+) \}/);
  assert.ok(cover, 'DESIGNATED_NAME_COVER has no literal definition to check');

  const y = Number(cover[1]);
  const height = Number(cover[2]);

  // The example name's ink: its baseline, dipping by a descent for the commas and
  // the tail of the Q.
  const exampleInkBottom = TEMPLATE.rowTwoNameBaseline - TEMPLATE.nameDescent;
  const exampleInkTop = TEMPLATE.rowTwoNameBaseline + TEMPLATE.capHeight;

  assert.ok(
    y <= exampleInkBottom,
    `the cover starts at y=${y}, leaving the bottom of the example name (y=${exampleInkBottom}) showing`,
  );
  assert.ok(
    y + height >= exampleInkTop,
    `the cover ends at y=${y + height}, leaving the top of the example name (y=${exampleInkTop}) showing`,
  );
  // And it must not clip the caption below, whose ink is the first thing it meets.
  const captionInkTop = TEMPLATE.rowTwoCaptionBaseline + TEMPLATE.capHeight;
  assert.ok(
    y >= captionInkTop,
    `the cover starts at y=${y}, clipping the caption below whose ink tops out at y=${captionInkTop}`,
  );
});

test('each printed name is wide enough to cover the example name under it', () => {
  for (const key of ['centerhead', 'sectionchief']) {
    const namePos = layout[`${key}NamePos`];

    assert.ok(
      namePos.x <= TEMPLATE.exampleNameLeft[key] + 0.5,
      `${key}'s name starts at x=${namePos.x}, to the right of the example name at x=${TEMPLATE.exampleNameLeft[key]}`,
    );
    assert.ok(
      namePos.x + namePos.width >= TEMPLATE.exampleNameRight[key],
      `${key}'s cover ends at x=${namePos.x + namePos.width}, short of the example name's right edge at x=${TEMPLATE.exampleNameRight[key]}`,
    );
  }
});

/* ================================================================
   THE WRITERS — both must paint out, name, then stamp
   ================================================================ */

test('the backend writer paints the band out before printing the real name', () => {
  const source = read(PDF);
  const helper = source.match(/function drawDesignatedName\(([\s\S]*?)\n\}/);
  assert.ok(helper, 'drawDesignatedName was not found');

  assert.match(helper[1], /page\.drawRectangle\(/, 'the example name is never painted out');
  assert.match(helper[1], /rgb\(1, 1, 1\)/, 'the cover is not white');
  assert.match(helper[1], /DESIGNATED_NAME_COVER/, 'the cover band is not taken from the shared constant');
  assert.match(helper[1], /designatedNameOf\(layout, line\.key\)/, 'the printed name does not come from the shared layout');
  // The name must be drawn AFTER the cover, or the cover would erase it.
  assert.ok(
    helper[1].indexOf('drawRectangle') < helper[1].indexOf('page.drawText'),
    'the cover is painted after the name, so it erases the name it was meant to hide',
  );

  assert.match(source, /await drawDesignatedSignature\(pdf, pages, record, line\)/, 'the signature is never stamped');
  assert.match(source, /for \(const line of DESIGNATED_LINES\)/, 'the writer does not iterate the two lines');
  assert.match(source, /designatedPersonnel/, 'the writer never reads the designated names');
  assert.match(source, /designatedNameOf,\s*\n\};|designatedNameOf,/, 'the name helper is not exported, so a test cannot pin it');
});

test('an unsigned or undecodable official line leaves that line blank instead of aborting', () => {
  const source = read(PDF);
  const helper = source.match(/async function drawDesignatedSignature\(([\s\S]*?)\n\}/);
  assert.ok(helper, 'the stamping helper was not found');

  assert.match(helper[1], /if \(!match\) return false;/, 'a missing signature is not handled');
  assert.match(helper[1], /catch \{[\s\S]*?return false;/, 'a decode failure is not swallowed');
  // One bad image must not stop the loop that draws the other line.
  assert.doesNotMatch(helper[1], /throw/, 'a decode failure escapes and would abort the document');
});

test('the browser export stamps the same two lines as the server', () => {
  const source = read(TRI_UI);

  assert.match(source, /async function drawTriDesignatedSignatures\(/, 'the shared stamping helper is gone');
  assert.match(source, /await drawTriDesignatedSignatures\(pdf, pages, record, bold\)/, 'the PDF export no longer stamps them');
  assert.match(source, /const TRI_DESIGNATED_LINES = \[/, 'the frontend no longer knows which lines to stamp');
  // Both sides read the same coordinates and the same cover band.
  assert.match(source, /triLayout as any\)\.centerheadSignatureBox|centerheadSignatureBox/, 'the export does not read the shared box');
  assert.match(source, /TRI_DESIGNATED_NAME_COVER = \{ y: 646\.5, height: 12 \}/, 'the export paints a different cover band than the server');
  assert.match(source, /rgb\(1, 1, 1\)/, 'the export does not paint the example name out');
});

/* ================================================================
   THE FORM AND THE PRINT VIEW
   ================================================================ */

test('the record interface carries the two officials signature fields', () => {
  const source = read(TRI_UI);
  const iface = source.match(/interface TriRecord \{([\s\S]*?)\n\}/);
  assert.ok(iface, 'the TriRecord interface was not found');

  for (const column of [...COLUMNS.centerhead, ...COLUMNS.sectionchief]) {
    assert.match(iface[1], new RegExp(`\\b${column}\\b`), `TriRecord does not declare ${column}`);
  }
});

test('the printed signature block carries all five lines, with the designated names', () => {
  const source = read(TRI_UI);

  // The block used to render four lines; the official form has five, and the SWO III
  // line was missing from the print view entirely.
  for (const caption of ['Houseparent', 'Administrative Officer', 'SWO I / Case Manager']) {
    assert.match(source, new RegExp(`<div class="rule">${caption}</div>`), `the printed block lost the ${caption} line`);
  }
  assert.match(source, /const designatedLinesHtml = TRI_DESIGNATED_LINES\.map\(/, 'the two official lines are not printed');
  assert.match(source, /\$\{designatedLinesHtml\}/, 'the two official lines are computed and then never rendered');
  assert.match(source, /designatedLineName\(line\.key\)/, 'the printed names do not come from the shared layout');
  // The drawing is inlined only after the strict shape check, exactly as the
  // Houseparent's is.
  assert.match(source, /SIGNATURE_DATA_URL\.test\(raw\)/, 'the printed official signature is not shape-checked');
});

test('the two official lines have a pad each, on the signature page', () => {
  const source = read(TRI_UI);

  const pageEight = source.indexOf('pageNumber={8}');
  assert.ok(pageEight !== -1, 'the TRI editor no longer renders page 8');
  assert.ok(
    source.indexOf('data-tri-designated-name') > pageEight,
    'the designated names are not rendered on page 8, where the block is printed',
  );
  assert.ok(
    source.lastIndexOf('<SignaturePadModal') > pageEight,
    'the official pads are not on page 8',
  );
  assert.match(source, /onSaveOfficialSignature\(line\.key, next\)/, 'the official pad is not wired to the handler');
  assert.match(source, /'\/tri\/' \+ selectedRecord\.id \+ '\/signature\/' \+ line/, 'the handler does not post to the per-line route');
  assert.match(source, /record\?\.status === 'Finalized'/, 'the official pads stay editable on a finalized TRI');
});
