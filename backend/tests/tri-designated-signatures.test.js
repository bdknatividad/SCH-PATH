/**
 * Regression guards for the four designated officials on the TRI.
 *
 * The official TRI's "Assessed by" block carries five signature lines in two rows:
 *
 *   row 1  Houseparent            Administrative Officer   SWO I/Case Manager
 *   row 2  SWO II/Center Head                             SWO III/Section Chief
 *
 * The Houseparent's line is pinned by `tri-houseparent-signature.test.js`. The other
 * four are the facility's designated personnel. Each is signed and stored on its own
 * line: a reviewer must not be able to write the Houseparent's line, and the
 * Houseparent must not be able to write theirs, so the two are separate routes over
 * separate storage. Several tests below exist to keep them separate — folding them
 * back into one route with a `line` parameter is the regression.
 *
 * ## Where each line's signature actually lives
 *
 * A line's E-Signature is stored in TWO places that are kept in step: the
 * `triRecords.signatories` JSON (the authoritative store, one entry per slot) and
 * that line's own three columns. `mirrorSignatoryToColumns()` in the controller
 * writes the columns after every JSON write, so neither store can go stale. The
 * columns are what the live records already contain, and `centerhead*` /
 * `sectionchief*` are the names they shipped with — renaming them to match a new
 * line key would strand the drawings already stored on published documents, which
 * is why the mapping is pinned here rather than derived.
 *
 * ## The cover band is gone, on purpose
 *
 * An earlier design assumed the template's second row printed stale example names,
 * so both writers painted a white band over them and printed the real names on top.
 * The facility then confirmed the opposite: the two names the form prints there
 * (Maricor C. Navarro, Nicolas Q. Regalario) are the correct people, and the band
 * was hiding them. So row 2 now draws NO name at all and only stamps a signature,
 * and a cover band reappearing anywhere on this block is the defect. The tests below
 * pin that, because a white rectangle on a PDF is invisible without opening the
 * document.
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
 * The slot each line writes to, and the three columns its drawing and its signer
 * are stored in. The slots name the LINE, not the office-holder, because the people
 * on them change.
 */
const SLOT_COLUMNS = {
  administrativeOfficer: ['adminOfficerSignature', 'adminOfficerSignedBy', 'adminOfficerSignedAt'],
  caseManager: ['swo1Signature', 'swo1SignedBy', 'swo1SignedAt'],
  centerHead: ['centerheadSignature', 'centerheadSignedBy', 'centerheadSignedAt'],
  sectionChief: ['sectionchiefSignature', 'sectionchiefSignedBy', 'sectionchiefSignedAt'],
};

const HOUSEPARENT_COLUMNS = ['houseparentSignature', 'houseparentSignedBy', 'houseparentSignedAt'];
const ALL_COLUMNS = [...HOUSEPARENT_COLUMNS, ...Object.values(SLOT_COLUMNS).flat()];

/** The keys the per-line signing route accepts, and the slot each maps to. */
const OFFICIAL_LINES = {
  adminofficer: 'administrativeOfficer',
  swo1: 'caseManager',
  swo2: 'centerHead',
  swo3: 'sectionChief',
};

/** The two people the template prints on its second row, exactly as they must print. */
const TEMPLATE_PRINTED = {
  centerHead: 'MARICOR C. NAVARRO, RSW, MSSW',
  sectionChief: 'NICOLAS Q. REGALARIO, RSW, MSSW',
};

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
  // The descenders of the heading above the whole block,
  // "The Rehabilitation Team together with the resident:".
  headingDescentBottom: 811.4,
  // No caption in this block has descenders, so its ink bottom is its baseline.
  nameDescent: 2.1,
};

const layout = JSON.parse(read(LAYOUT));

/** Row 1 is the three lines whose names the app prints; row 2 is the template's own. */
const ROW_ONE = ['houseparent', 'administrativeOfficer', 'caseManager'];
const ROW_TWO = ['centerHead', 'sectionChief'];

/* ================================================================
   STORAGE
   ================================================================ */

test('triRecords has somewhere to keep each official signature', () => {
  const schema = read(SCHEMA);
  const table = schema.match(/CREATE TABLE triRecords \(([\s\S]*?)\n\)\s*ENGINE/);
  assert.ok(table, 'the triRecords table definition was not found in schema.sql');

  // The authoritative store: one JSON entry per signature line.
  assert.match(table[1], /\bsignatories LONGTEXT NULL/, 'triRecords has no signatories column');

  // And the per-line columns, which hold what the live records already contain.
  for (const column of ALL_COLUMNS) {
    assert.match(table[1], new RegExp(`\\b${column}\\b`), `triRecords has no ${column} column`);
  }

  // The table is created by the boot migration too, and the two must agree — a
  // database built by the migration alone would be missing the columns.
  const server = read(SERVER);
  assert.match(server, /\bsignatories LONGTEXT NULL/, 'the triRecords CREATE TABLE in server.js does not declare signatories');
  for (const column of ALL_COLUMNS) {
    assert.match(
      server,
      new RegExp(`\\b${column} (LONGTEXT|VARCHAR\\(100\\)|DATETIME) NULL`),
      `the triRecords CREATE TABLE in server.js does not declare ${column}`,
    );
  }
});

test('an existing database gets all fifteen signature columns on boot', () => {
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
  // Renaming them to match the new slot names would strand those drawings — a silent
  // loss of a signature on a published document. The map is the only place the
  // mapping lives, so it is pinned here.
  const controller = read(CONTROLLER);
  const map = controller.match(/const SIGNATORY_COLUMNS = \{([\s\S]*?)\n\};/);
  assert.ok(map, 'the slot→column map was not found');

  assert.match(map[1], /centerHead: \['centerheadSignature'/, 'the SWO II line no longer reads centerheadSignature');
  assert.match(map[1], /sectionChief: \['sectionchiefSignature'/, 'the SWO III line no longer reads sectionchiefSignature');
  assert.match(map[1], /caseManager: \['swo1Signature'/, 'the SWO I line no longer reads swo1Signature');
  assert.match(map[1], /administrativeOfficer: \['adminOfficerSignature'/, 'the Administrative Officer line no longer reads adminOfficerSignature');
  assert.doesNotMatch(map[1], /'swo2Signature'|'swo3Signature'/, 'a column was renamed to match the slot, stranding the stored drawings');

  // Every column is claimed by exactly one slot, so a drawing cannot be written
  // through another line's field.
  const seen = new Set();
  for (const [slot, columns] of Object.entries(SLOT_COLUMNS)) {
    for (const column of columns) {
      assert.match(map[1], new RegExp(`'${column}'`), `the map does not name ${column} (${slot})`);
      assert.ok(!seen.has(column), `${column} is claimed by two lines`);
      seen.add(column);
    }
  }
});

/* ================================================================
   THE ENDPOINT — a separate route, over separate storage
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
  const handler = source.match(/async function signOfficialLine\(req, res, next\) \{([\s\S]*?)\n\}\n/);
  assert.ok(handler, 'signOfficialLine was not found');

  // The line is matched against a fixed map, so an unknown one is a 400 rather than
  // a fallback that writes somewhere unexpected.
  assert.match(source, /const OFFICIAL_SIGNATURE_LINES = \{/, 'the line map is gone');
  assert.match(handler[1], /OFFICIAL_SIGNATURE_LINES\[key\]/, 'the handler does not look the line up');
  assert.match(handler[1], /if \(!line\) \{/, 'an unknown line is not refused');
  assert.match(handler[1], /throw new ApiError\(400/, 'an unknown line is not refused with a 400');

  // Only the reviewing roles may sign here.
  assert.match(handler[1], /if \(!canReview\(req\.user\)\)/, 'the handler does not gate on the reviewing roles');

  // The slot — and therefore the column names — comes from the map, never from the
  // request, so a caller cannot name a column to write.
  assert.match(handler[1], /const slot = slotForSignatureLine\(line\);/, 'the storage slot is not resolved from the map');
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

test('a signed official line is written to both stores, so neither can go stale', () => {
  const source = read(CONTROLLER);

  // The JSON is authoritative...
  assert.match(
    source,
    /UPDATE triRecords SET signatories = \?, updatedBy = \? WHERE id = \?/,
    'the signatories JSON is no longer written',
  );
  // ...and the line's own columns are mirrored straight after, from the same entry,
  // so a reader that only knows the columns still finds the drawing.
  assert.match(source, /await mirrorSignatoryToColumns\(record\.id, slot, entry, req\.user\.username\);/, 'the line\'s columns are no longer mirrored from the JSON');

  const mirror = source.match(/async function mirrorSignatoryToColumns\(recordId, slot, entry, updatedBy\) \{([\s\S]*?)\n\}/);
  assert.ok(mirror, 'mirrorSignatoryToColumns was not found');
  // Only fields the entry actually carries are mirrored: an update that says nothing
  // about `signature` must not blank a column that holds one.
  assert.match(mirror[1], /if \(!columns \|\| !entry \|\| !\('signature' in entry\)\) return;/, 'the mirror does not skip entries that carry no signature');
  // A database that predates a column must not turn a signature save into a 500.
  assert.match(mirror[1], /error\.errno === 1054 \|\| error\.errno === 1060/, 'the mirror does not tolerate a missing column');
});

test('the four official lines are stored separately, so a drawing cannot be misattributed', () => {
  const source = read(CONTROLLER);
  const map = source.match(/const OFFICIAL_SIGNATURE_LINES = \{([\s\S]*?)\n\};/);
  assert.ok(map, 'the line map was not found');

  for (const key of Object.keys(OFFICIAL_LINES)) {
    assert.match(map[1], new RegExp(`\\b${key}: \\{`), `the map has no entry for ${key}`);
  }
  // Each official line names the three columns of the slot it resolves to, and no
  // two lines share a column.
  const claimed = new Set();
  for (const [key, slot] of Object.entries(OFFICIAL_LINES)) {
    const entry = map[1].match(new RegExp(`${key}: \\{([\\s\\S]*?)\\n  \\},`));
    assert.ok(entry, `the map has no body for ${key}`);
    for (const column of SLOT_COLUMNS[slot]) {
      assert.match(entry[1], new RegExp(`'${column}'`), `${key} does not name ${column}`);
      assert.ok(!claimed.has(column), `${column} is claimed by two lines`);
      claimed.add(column);
    }
  }
});

test('every official line maps to a slot the writer and the layout both know', () => {
  // A mismatch here is a silent failure at the pad: the line resolves to no slot (a
  // 500), or to a slot the PDF writer has no geometry for, and the signature is
  // saved but never printed.
  const controller = read(CONTROLLER);
  const map = controller.match(/const OFFICIAL_SIGNATURE_LINES = \{([\s\S]*?)\n\};/)[1];

  // Every column the map names must be a column the slot map claims, or
  // `slotForSignatureLine` returns null and the handler 500s.
  const slotMap = controller.match(/const SIGNATORY_COLUMNS = \{([\s\S]*?)\n\};/)[1];
  for (const [key, slot] of Object.entries(OFFICIAL_LINES)) {
    const entry = map.match(new RegExp(`${key}: \\{([\\s\\S]*?)\\n  \\},`))[1];
    const signatureColumn = entry.match(/signature: '(\w+)'/)[1];
    assert.match(
      slotMap,
      new RegExp(`${slot}: \\['${signatureColumn}'`),
      `${key} names ${signatureColumn}, which ${slot} does not claim — the line would resolve to no slot`,
    );
  }

  // And the writer's own line list must declare the same five slots.
  const pdf = read(PDF);
  const slots = pdf.match(/const TRI_SIGNATORY_SLOTS = \[([\s\S]*?)\n\];/)[1];
  const declared = [...slots.matchAll(/slot: '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    declared,
    ['houseparent', ...Object.values(OFFICIAL_LINES)],
    'the writer no longer declares all five lines, in the order they appear across the page',
  );

  // And the layout carries geometry for each of them.
  for (const slot of declared) {
    assert.ok(layout.signatories[slot], `triLayout.json has no signatories.${slot}`);
  }
});

/* ================================================================
   THE SHARED LAYOUT — geometry and the names
   ================================================================ */

test('the layout declares the two names the template prints, and no others', () => {
  // The names live on the writer's slot table, which the layout's geometry is
  // checked against at load. `printedName` marks a line the template already prints.
  const pdf = read(PDF);
  const slots = pdf.match(/const TRI_SIGNATORY_SLOTS = \[([\s\S]*?)\n\];/)[1];

  for (const [slot, name] of Object.entries(TEMPLATE_PRINTED)) {
    const entry = slots.match(new RegExp(`slot: '${slot}'([^\\n]*)`));
    assert.ok(entry, `${slot} is missing from the writer's line list`);
    assert.match(entry[1], /hasName: false/, `${slot} would draw a name over the one the template already prints`);
    assert.ok(entry[1].includes(`printedName: '${name}'`), `${slot}'s printed name changed`);
  }

  // The three lines the app prints a name for carry a text holder instead.
  for (const slot of ROW_ONE) {
    const entry = slots.match(new RegExp(`slot: '${slot}'([^\\n]*)`));
    assert.ok(entry, `${slot} is missing from the writer's line list`);
    assert.match(entry[1], /hasName: true/, `${slot} no longer declares a typed-name holder`);
    assert.doesNotMatch(entry[1], /printedName/, `${slot} would print a fixed name over the typed one`);
  }
});

test('the layout geometry is the same one the writer draws', () => {
  const source = read(PDF);

  // The writer hard-throws on a mismatch, so this is the same contract stated twice:
  // once as coordinates, once as the cross-check that refuses to load without them.
  // The Houseparent's slot and the two legacy Houseparent keys must agree.
  assert.match(source, /if \(!raw\.signatories\) throw new Error/, 'the writer no longer requires the layout signatories block');
  assert.match(
    source,
    /hp\.signatureY !== HOUSEPARENT_SIGNATURE_BOX\.y \|\| hp\.signatureHeight !== HOUSEPARENT_SIGNATURE_BOX\.height/,
    'the Houseparent slot is not cross-checked against the legacy signature box',
  );
  assert.match(
    source,
    /\['houseparentSignatureBox', HOUSEPARENT_SIGNATURE_BOX\], \['houseparentNamePos', HOUSEPARENT_NAME_POS\]/,
    'the legacy Houseparent layout keys are no longer cross-checked against the writer',
  );
  // Every declared slot must have complete geometry, and a line that prints its own
  // name must not be asked for a name position.
  assert.match(source, /for \(const \{ slot, hasName \} of TRI_SIGNATORY_SLOTS\) \{/, 'the writer no longer validates each slot\'s geometry');
  assert.match(source, /is incomplete/, 'a slot with missing geometry is not refused');

  for (const [layoutKey, constant] of [['houseparentSignatureBox', 'HOUSEPARENT_SIGNATURE_BOX'], ['houseparentNamePos', 'HOUSEPARENT_NAME_POS']]) {
    assert.ok(layout[layoutKey], `triLayout.json has no ${layoutKey}`);
    assert.match(source, new RegExp(`const ${constant} = \\{`), `${constant} is not defined in the writer`);
  }
});

test('every signature box sits in the blank band above its own rule', () => {
  for (const slot of ROW_ONE) {
    const box = layout.signatories[slot];
    assert.ok(box, `${slot} has no signature geometry in triLayout.json`);
    assert.equal(box.page, 7, `${slot}'s signature would be stamped on page index ${box.page}, not the signature page`);
    assert.ok(
      box.signatureY >= TEMPLATE.rowOneRuleTop,
      `${slot}'s box starts at y=${box.signatureY}, on or below the printed rule whose ink tops out at y=${TEMPLATE.rowOneRuleTop}`,
    );
    assert.ok(
      box.signatureY + box.signatureHeight <= TEMPLATE.headingDescentBottom,
      `${slot}'s box ends at y=${box.signatureY + box.signatureHeight}, into the heading above whose descenders reach y=${TEMPLATE.headingDescentBottom}`,
    );
    assert.ok(box.signatureHeight >= 18, `a ${box.signatureHeight}pt tall box is too small to sign in`);
    assert.ok(box.width >= 60, `a ${box.width}pt wide box is too narrow to sign in`);
  }

  for (const slot of ROW_TWO) {
    const box = layout.signatories[slot];
    assert.ok(box, `${slot} has no signature geometry in triLayout.json`);
    assert.equal(box.page, 7, `${slot}'s signature would be stamped on page index ${box.page}, not the signature page`);
    assert.ok(
      box.signatureY >= TEMPLATE.rowTwoRuleTop,
      `${slot}'s box starts at y=${box.signatureY}, on or below the printed rule whose ink tops out at y=${TEMPLATE.rowTwoRuleTop}`,
    );
    // Row 2 sits below row 1's captions, so the box must not reach up into them.
    assert.ok(
      box.signatureY + box.signatureHeight <= TEMPLATE.rowOneCaptionBaseline,
      `${slot}'s box ends at y=${box.signatureY + box.signatureHeight}, into row 1's caption at y=${TEMPLATE.rowOneCaptionBaseline}`,
    );
    assert.ok(box.signatureHeight >= 18, `a ${box.signatureHeight}pt tall box is too small to sign in`);
  }
});

test('the drawn names sit below their signature and above their rule', () => {
  // The requirement: on the TRI the name goes below the signature, so the rule reads
  // as the underline of the name. That applies to the three lines the app prints a
  // name for — the Houseparent's and row 1's two officials.
  for (const slot of ROW_ONE) {
    const box = layout.signatories[slot];
    assert.ok(Number.isFinite(Number(box.nameY)), `${slot} has no printed-name position`);
    assert.ok(
      box.nameY <= box.signatureY,
      `${slot}'s name baseline is y=${box.nameY}, above its signature box at y=${box.signatureY} — the name must go below the signature`,
    );
    // And the descenders must clear the rule it is meant to sit on.
    assert.ok(
      box.nameY - TEMPLATE.nameDescent >= TEMPLATE.rowOneRuleTop,
      `${slot}'s name drops to y=${box.nameY - TEMPLATE.nameDescent}, through the rule whose ink tops out at y=${TEMPLATE.rowOneRuleTop}`,
    );
  }
});

test('no name is drawn for the two lines the template already prints', () => {
  // The template prints both second-row names itself, and they are the right people.
  // Drawing one would put two names on top of each other; painting the template's out
  // would hide a correct name. So these two lines carry a signature and nothing else.
  for (const slot of ROW_TWO) {
    assert.equal(
      layout.signatories[slot].nameY,
      undefined,
      `${slot} has a printed-name position again — the template already prints that name`,
    );
  }
});

/* ================================================================
   THE WRITERS — the signature is centred on the line it belongs to
   ================================================================ */

test('each signature box is the extent of the name or rule it belongs to', () => {
  // The signature is centred inside its box, so the box has to BE the thing it is
  // centred over. It used to be centred over a separately-recorded name extent;
  // sizing the box to that extent is the same placement with one number instead of
  // two, and this is what keeps the two from drifting apart.
  for (const slot of ROW_ONE) {
    const box = layout.signatories[slot];
    assert.ok(Number.isFinite(Number(box.width)), `${slot} has no box width`);
    assert.ok(box.width > 0, `${slot}'s box has no width to centre in`);
  }
  // The two template-printed lines carry the extent of the printed name, so centring
  // in the box is centring over that name.
  const printedWidths = { centerHead: 175.3, sectionChief: 185 };
  for (const [slot, width] of Object.entries(printedWidths)) {
    assert.equal(
      layout.signatories[slot].width,
      width,
      `${slot}'s box is no longer the width of the printed name it is centred over`,
    );
  }
});

test('the writer draws each name from the shared layout, and never paints one out', () => {
  const source = read(PDF);

  assert.match(source, /function drawHouseparentName\(pages, record, font\)/, 'the Houseparent name helper is gone');
  assert.match(source, /function drawOtherSignatories\(pdf, pages, record, layout, font\)/, 'the official-lines helper is gone');
  assert.match(source, /const name = signatoryNameOf\(record, slot\);/, 'the printed name does not come from the record');
  assert.match(source, /layout\.signatories\[slot\]/, 'the printed name does not come from the shared layout');

  // No cover band, anywhere on this block. The template's own second-row names are
  // the right people, so there is nothing to hide.
  assert.doesNotMatch(source, /DESIGNATED_NAME_COVER/, 'the writer still has a cover band');
  assert.doesNotMatch(source, /drawRectangle/, 'the writer paints a rectangle over the signature block');
  assert.doesNotMatch(source, /rgb\(1, 1, 1\)/, 'the writer still paints white on this block');
});

test('the writer centres each signature inside its own box, and stamps the right page', () => {
  const source = read(PDF);
  const helper = source.match(/async function stampSignature\(pdf, page, dataUrl, box\) \{([\s\S]*?)\n\}/);
  assert.ok(helper, 'stampSignature was not found');

  assert.match(
    helper[1],
    /x: box\.x \+ \(box\.width - width\) \/ 2/,
    'the signature is not centred in the box that represents its line',
  );
  // Resting on the bottom of the band, so it sits directly above the name / rule
  // rather than floating in the middle of it.
  assert.match(helper[1], /y: box\.y,/, 'the signature no longer rests on the bottom of its band');
  // The box carries its own page, so a line on page 8 is never stamped on page 1.
  assert.match(
    source,
    /stampSignature\(pdf, pages\[HOUSEPARENT_SIGNATURE_BOX\.page\], signatorySignatureOf\(record, 'houseparent'\), HOUSEPARENT_SIGNATURE_BOX\)/,
    'the Houseparent stamp ignores the box\'s page',
  );
  assert.match(source, /const page = pages\[geometry\.page\];/, 'the official stamps ignore their layout geometry\'s page');
});

test('an unsigned or undecodable line leaves that line blank instead of aborting', () => {
  const source = read(PDF);
  const helper = source.match(/async function stampSignature\(pdf, page, dataUrl, box\) \{([\s\S]*?)\n\}/);
  assert.ok(helper, 'the stamping helper was not found');

  assert.match(helper[1], /if \(!match \|\| !page\) return false;/, 'a missing signature is not handled');
  assert.match(helper[1], /catch \{[\s\S]*?return false;/, 'a decode failure is not swallowed');
  // One bad image must not stop the loop that draws the other lines.
  assert.doesNotMatch(helper[1], /throw/, 'a decode failure escapes and would abort the document');
  // The swallow must stay narrow. A swallowed programming error is how every export
  // printed a blank signature line with nothing in the log; the behavioural guard for
  // that is `tri-signature-stamp.test.js`.
  assert.match(source, /const signed = \(houseparentSigned \? 1 : 0\) \+ othersSigned;/, 'the writer no longer counts what it stamped');
});

test('the published copy records which lines were signed and which were left blank', () => {
  // The subject line is the only place a reader is told the document is a system
  // copy, so it has to be built from what was actually stamped rather than from a
  // fixed sentence a second signer would make untrue.
  const source = read(PDF);
  assert.match(source, /const signed = \(houseparentSigned \? 1 : 0\) \+ othersSigned;/, 'the writer no longer counts the stamped lines');
  assert.match(source, /const total = TRI_SIGNATORY_SLOTS\.length;/, 'the writer no longer knows how many lines there are');
  assert.match(source, /\$\{signed\} of \$\{total\} signature lines are signed/, 'the subject no longer says how many lines are signed');
  assert.match(source, /the remaining signature lines are blank/, 'the subject no longer says the unsigned lines are blank');
  assert.match(source, /Signature lines are blank; this is not the signed original\./, 'the unsigned case no longer disclaims being the original');
});

/* ================================================================
   THE FORM AND THE PRINT VIEW
   ================================================================ */

test('the browser export stamps the same five lines as the server', () => {
  const source = read(TRI_UI);

  assert.match(source, /async function drawTriSignatures\(/, 'the shared stamping helper is gone');
  assert.match(source, /await drawTriSignatures\(pdf, pages, record, bold\)/, 'the PDF export no longer stamps the signature lines');
  assert.match(source, /const TRI_SIGNATORIES: \{ slot: TriSignatorySlot; title: string; hasName: boolean; printedName\?: string \}\[\] = \[/, 'the frontend no longer knows which lines to stamp');
  assert.match(source, /const TRI_SIGNATORY_LAYOUT = triLayout\.signatories/, 'the export does not read the shared geometry');
  assert.match(source, /for \(const \{ slot, hasName \} of TRI_SIGNATORIES\)/, 'the export does not iterate the line list');
  // The same slots, in the same order, as the server's writer.
  const pdf = read(PDF);
  const serverSlots = [...pdf.match(/const TRI_SIGNATORY_SLOTS = \[([\s\S]*?)\n\];/)[1].matchAll(/slot: '(\w+)'/g)].map((m) => m[1]);
  const uiSlots = [...source.match(/const TRI_SIGNATORIES:[\s\S]*?\n\];/)[0].matchAll(/slot: '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(uiSlots, serverSlots, 'the export and the server disagree about which lines the block has');

  // No cover band here either — and nothing white painted on the block.
  assert.doesNotMatch(source, /TRI_DESIGNATED_NAME_COVER/, 'the export still has a cover band');
  assert.doesNotMatch(source, /drawTriSignatures[\s\S]{0,2000}drawRectangle/, 'the export paints a rectangle over the block');
});

test('the browser export centres each signature in its own box too', () => {
  const source = read(TRI_UI);
  assert.match(source, /const geometry = slot === 'houseparent'/, 'the export no longer resolves the Houseparent geometry');
  assert.match(
    source,
    /page\.drawImage\(image, \{ x: geometry\.x \+ \(geometry\.width - width\) \/ 2, y: geometry\.signatureY, width, height \}\);/,
    'the export does not centre a signature in the box that represents its line',
  );
  // The typed name is drawn below the signature, on the rule — the same order as the
  // server writer, so an export and a published copy read the same.
  assert.match(source, /if \(name && geometry\.nameY != null\)/, 'the export no longer gates the name on the line having a name position');
  assert.match(source, /page\.drawText\(name, \{ x: geometry\.x, y: geometry\.nameY, size, font/, 'the export no longer draws the name below the signature');
});

test('the record interface carries the Houseparent fields and the signatories store', () => {
  const source = read(TRI_UI);
  const iface = source.match(/interface TriRecord \{([\s\S]*?)\n\}/);
  assert.ok(iface, 'the TriRecord interface was not found');

  // The Houseparent's line is read from its own columns...
  for (const column of HOUSEPARENT_COLUMNS) {
    assert.match(iface[1], new RegExp(`\\b${column}\\b`), `TriRecord does not declare ${column}`);
  }
  // ...and every other line from the JSON, which is the authoritative store.
  assert.match(iface[1], /\bsignatories\?: TriSignatories \| string \| null;/, 'TriRecord does not declare the signatories store');
});

test('the printed signature block carries all five lines, with every printed name', () => {
  const source = read(TRI_UI);

  // The block used to render four lines with two of them blank; the official form has
  // five, and every one of them now prints its name. The whole block comes from one
  // builder keyed by slot, so a caption cannot be attached to the wrong signature.
  assert.match(source, /const signatureBlocks = TRI_SIGNATORIES\.map\(\(\{ slot, title, printedName \}\) =>/, 'the printed block is not built from the line list');
  assert.match(source, /\$\{signatureBlocks\}/, 'the signature block is computed and then never rendered');
  // Every line prints its name, including the two the official template carries — this
  // is a generated summary, not the template.
  assert.match(source, /designatedLineName|signatoryLineName/, 'the printed names do not come from the shared line list');
  // The drawing is inlined only after the strict shape check, exactly as the
  // Houseparent's is.
  assert.match(source, /SIGNATURE_DATA_URL\.test\(dataUrl\)/, 'the printed official signature is not shape-checked');
  assert.match(source, /const slot = img \|\| name \? 'signed' : ''/, 'the printed line no longer has a slot for the drawing and the name');
});

test('the five official lines have a pad each, on the signature page', () => {
  const source = read(TRI_UI);

  const pageEight = source.indexOf('pageNumber={8}');
  assert.ok(pageEight !== -1, 'the TRI editor no longer renders page 8');
  assert.ok(
    source.indexOf('data-tri-signatory-name') > pageEight,
    'the official names are not rendered on page 8, where the block is printed',
  );
  assert.ok(
    source.lastIndexOf('<SignaturePadModal') > pageEight,
    'the official pads are not on page 8',
  );
  assert.match(source, /onSaveSignatory\(slot, \{ signature: next \}\)|onSaveSignatory\(slot,/, 'the official pad is not wired to the handler');
  assert.match(source, /record\?\.status === 'Finalized'/, 'the official pads stay editable on a finalized TRI');
});

test('the on-screen form draws the names from the shared layout, and no white band', () => {
  const source = read(TRI_UI);

  // The form renders page 8 of the template underneath itself. Row 1 is blank on the
  // template, so the app draws those names; row 2 is printed by the template, so it
  // must draw none — a name span for the two pre-printed lines would print two names
  // on top of each other, and the band that used to hide the template's name was
  // hiding a correct one.
  assert.match(
    source,
    /hasName && geometry\.nameY != null && \(/,
    'the on-screen name is not gated on the line having a name position',
  );
  assert.match(source, /pdfPercentTop\(geometry\.nameY \+ 3, 11\)/, 'the on-screen name is not placed from the shared name position');
  assert.match(source, /data-tri-signatory-name=\{slot\}/, 'the on-screen name is not keyed by slot');

  // No opaque white band anywhere on page 8. The page container paints its own
  // background above this point, and the empty-signature placeholder is deliberately
  // translucent (`bg-white/60`) — what must not come back is a solid rectangle over
  // the names the template prints.
  const pageEight = source.indexOf('pageNumber={8}');
  const pageEightBlock = source.slice(pageEight, source.indexOf('</PdfDocument>', pageEight));
  assert.ok(pageEightBlock.length > 0, 'the page-8 render block was not found');
  assert.doesNotMatch(
    pageEightBlock,
    /bg-white(?![\/\w-])/,
    'the on-screen form paints an opaque white band over the printed names again',
  );

  // The two template-printed lines carry no name position and no name holder, which
  // is what makes the `hasName &&` guard above skip them.
  const pdf = read(PDF);
  const slots = pdf.match(/const TRI_SIGNATORY_SLOTS = \[([\s\S]*?)\n\];/)[1];
  for (const slot of ROW_TWO) {
    const entry = slots.match(new RegExp(`slot: '${slot}'([^\\n]*)`))[1];
    assert.match(entry, /hasName: false/, `${slot} would draw a name over the one the template already prints`);
  }
  assert.equal(layout.signatories[ROW_TWO[0]].nameY, undefined, 'the on-screen name position for the SWO II line is back');
  assert.equal(layout.signatories[ROW_TWO[1]].nameY, undefined, 'the on-screen name position for the SWO III line is back');
});
