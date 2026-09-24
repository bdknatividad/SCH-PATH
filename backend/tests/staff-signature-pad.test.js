/**
 * Regression guards for the staff signature pads.
 *
 * Every staff signature in the system used to be either a typed name or a blank
 * printed line. This suite locks in the replacement: a shared draw-in-place
 * `SignaturePad`, the record it saves into, and the two places the saved image
 * has to reappear (the on-screen slip and the generated PDF).
 *
 * Most assertions read the source rather than run it. The defects these guard
 * against — a pad wired to the wrong field, an overlay and a PDF stamp drifting
 * apart, a typed name creeping back into a signature column — all type-check,
 * build, and are invisible without a browser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.resolve(__dirname, '../../frontend/src/app');
const COMPONENTS = path.join(FRONTEND, 'components');
const UTILS = path.join(FRONTEND, 'utils');

const SIGNATURE_PAD = path.join(COMPONENTS, 'SignaturePad.tsx');
const SIGNATURE_PDF = path.join(UTILS, 'signaturePdf.ts');
const CHILD_RECORDS = path.join(COMPONENTS, 'ChildRecords.tsx');
const CHILD_DETAIL = path.join(COMPONENTS, 'ChildDetail.tsx');
const HEALTH = path.join(COMPONENTS, 'Health.tsx');
const ADMISSION_CONTROLLER = path.resolve(
  __dirname,
  '../src/controllers/admissionController.js'
);

const read = (file) => fs.readFileSync(file, 'utf8');

/* ================================================================
   THE SHARED PAD
   ================================================================ */

test('the shared signature pad exists and is a real drawing surface', () => {
  const source = read(SIGNATURE_PAD);

  assert.match(source, /export function SignaturePad/, 'SignaturePad must be exported');
  assert.match(source, /<canvas/, 'the pad must draw onto a canvas');

  // Pointer Events are what make one code path serve mouse, pen and touch.
  assert.match(source, /onPointerDown/, 'no pointer-down handler: the pad cannot be drawn on');
  assert.match(source, /onPointerMove/, 'no pointer-move handler: strokes would not follow the pointer');
  assert.match(source, /onPointerUp/, 'no pointer-up handler: strokes would never be committed');

  // Without touch-action:none the browser scrolls the page instead of drawing.
  assert.match(source, /touch-none/, 'the canvas must opt out of browser touch gestures');
});

test('the pad offers Clear and Redo', () => {
  const source = read(SIGNATURE_PAD);

  assert.match(source, />\s*Clear\s*</, 'the pad has no Clear control');
  assert.match(source, />\s*Redo\s*</, 'the pad has no Redo control');

  // Clear must stash what it removed, otherwise Redo has nothing to restore.
  assert.match(source, /redoRef/, 'Clear does not remember the signature it erased');
});

test('the pad emits a PNG data URL, and an upload is normalised into one', () => {
  const source = read(SIGNATURE_PAD);

  assert.match(source, /toDataURL\('image\/png'\)/, 'the pad must emit a PNG data URL');

  // Uploading sits next to drawing. What matters is that the two paths converge:
  // an uploaded file has to come out as the same PNG data URL, or the PDF stamp
  // and the on-screen preview would each need a second code path.
  assert.match(source, /type="file"/, 'the pad offers no way to upload a signature image');
  assert.match(
    source,
    /accept="image\/png,image\/jpeg,image\/webp"/,
    'the upload control accepts formats the normaliser is not written for'
  );
  assert.match(source, /readAsDataURL/, 'the upload path never reads the chosen file');

  // The uploaded image is redrawn at the pad's own size. That is what keeps a
  // phone photo out of the signature column and drops its EXIF.
  assert.match(
    source,
    /async function imageFileToSignaturePng/,
    'no normaliser: an uploaded photo would be stored at whatever size it arrived'
  );
  assert.match(source, /context\.drawImage\(/, 'the normaliser never redraws the image');
  assert.match(
    source,
    /file\.size\s*>\s*MAX_UPLOAD_BYTES/,
    'the size ceiling is declared but never applied to the chosen file'
  );

  // SVG is the one image format that can carry script, so it stays refused.
  assert.match(source, /image\/svg\+xml/, 'the upload no longer refuses SVG');
});

test('a saved signature is restored without wiping strokes just drawn', () => {
  const source = read(SIGNATURE_PAD);

  // The sync effect must ignore the pad's own emissions, otherwise the parent
  // echoing our value back would clear the canvas mid-stroke.
  assert.match(source, /emittedRef/, 'the pad cannot tell its own value apart from a loaded record');
  assert.match(source, /incoming === emittedRef\.current/, 'the value-sync effect is unconditional');
});

/* ================================================================
   ADMISSION SLIP — HOUSEPARENT ON DUTY
   ================================================================ */

test('the Admission Slip offers the Houseparent on Duty a signature field', () => {
  const source = read(CHILD_RECORDS);

  assert.match(
    source,
    /import\s*\{[\s\S]*?SignaturePad[\s\S]*?\}\s*from\s*'@\/app\/components\/SignaturePad'/,
    'ChildRecords.tsx no longer imports the shared SignaturePad'
  );
  assert.match(
    source,
    /label="Houseparent on Duty signature"/,
    'the slip has no Houseparent on Duty signature field'
  );
  assert.match(
    source,
    /box=\{ADMISSION_HOUSEPARENT_SIGNATURE_BOX\}/,
    'the slip signature field is not positioned by the shared box'
  );
});

test('the Houseparent signature column stores the drawing, not the typed name', () => {
  const source = read(CHILD_RECORDS);

  assert.ok(
    !/houseparentSignature:\s*\n?\s*form\.houseparentOnDuty/.test(source),
    'the typed Houseparent name is being saved as the signature again'
  );

  const assignments = source.match(/houseparentSignature:\s*form\.houseparentSignature/g) || [];
  assert.ok(
    assignments.length >= 2,
    `expected both admission payload builders to send the drawing, found ${assignments.length}`
  );
});

test('the typed name is still carried, so the printed line is unchanged', () => {
  const source = read(CHILD_RECORDS);

  assert.match(
    source,
    /houseparentOnDuty:\s*form\.houseparentOnDuty/,
    'the printed Houseparent on Duty name must keep being saved'
  );
  assert.match(
    source,
    /drawText\(\s*\n?\s*admission\.houseparentOnDuty/,
    'the generated slip must still print the Houseparent on Duty name'
  );
});

test('an existing admission loads its saved signature back into the form', () => {
  const source = read(CHILD_RECORDS);

  assert.match(
    source,
    /houseparentSignature:\s*source\.houseparentSignature\s*\|\|\s*''/,
    'opening an admission for editing would show an empty pad over a signed record'
  );
});

test('a fresh admission starts with an empty signature', () => {
  const source = read(CHILD_RECORDS);

  assert.match(source, /houseparentSignature:\s*''/, 'EMPTY_FORM must start unsigned');
  assert.match(source, /houseparentSignature:\s*\n\s*''/, 'the duplicate-resident resets must clear it');
});

/* ================================================================
   THE SAVED SIGNATURE REACHES THE GENERATED PDF
   ================================================================ */

test('both Admission Slip renderers stamp the saved signature', () => {
  for (const file of [CHILD_RECORDS, CHILD_DETAIL]) {
    const name = path.basename(file);
    const source = read(file);

    assert.match(
      source,
      /await drawSignatureImage\(/,
      `${name} does not stamp the saved signature onto the slip`
    );
    assert.match(
      source,
      /ADMISSION_HOUSEPARENT_SIGNATURE_BOX/,
      `${name} does not use the shared signature box`
    );
    assert.match(
      source,
      /admission\.houseparentSignature/,
      `${name} never reads the stored signature`
    );
  }
});

test('the on-screen overlay and the PDF stamp share one rectangle', () => {
  const utils = read(SIGNATURE_PDF);

  assert.match(
    utils,
    /export const ADMISSION_HOUSEPARENT_SIGNATURE_BOX/,
    'the signature box is not shared, so the pad and the stamp can drift apart'
  );
  assert.match(
    utils,
    /export function toPdfBox/,
    'there is no shared top-left to bottom-left conversion'
  );

  // ChildRecords positions the overlay from the same box it later stamps.
  const records = read(CHILD_RECORDS);
  assert.match(
    records,
    /style=\{\s*pdfFieldStyle\(\s*box\.x,\s*box\.y,\s*box\.width,\s*box\.height\s*\)\s*\}/,
    'the overlay is not laid out from the shared box'
  );
  assert.match(
    records,
    /toPdfBox\(\s*\n?\s*ADMISSION_HOUSEPARENT_SIGNATURE_BOX,\s*\n?\s*PDF_HEIGHT\s*\)/,
    'the stamp does not convert the shared box'
  );
});

test('toPdfBox flips the vertical axis for pdf-lib', () => {
  const utils = read(SIGNATURE_PDF);

  assert.match(
    utils,
    /y:\s*pageHeight\s*-\s*box\.y\s*-\s*box\.height/,
    'the PDF stamp would be mirrored vertically'
  );
});

/** Parses `{ x: n, y: n, width: n, height: n }` out of a literal. */
function parseBox(source, name) {
  const match = source.match(new RegExp(`const ${name}[^=]*=\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${name} has no literal definition to check`);
  const box = {};
  for (const pair of match[1].split(',')) {
    const [key, raw] = pair.split(':');
    if (!key || !raw) continue;
    const value = Number(raw.trim());
    if (!Number.isNaN(value)) box[key.trim()] = value;
  }
  return box;
}

test('the Houseparent signature box sits in the blank band above the signature rule', () => {
  const box = parseBox(read(SIGNATURE_PDF), 'ADMISSION_HOUSEPARENT_SIGNATURE_BOX');

  // Measured against the template: the referring-party caption ends at y = 431
  // and the Houseparent signature rule is drawn at y = 475. The band between
  // them is completely blank across the page, which is why the pad lives there.
  const CAPTION_BOTTOM = 431;
  const SIGNATURE_RULE = 475;

  assert.ok(box.y >= CAPTION_BOTTOM, `the signature box starts at y=${box.y}, overlapping the caption above`);
  assert.ok(
    box.y + box.height <= SIGNATURE_RULE,
    `the signature box ends at y=${box.y + box.height}, past the signature rule at y=${SIGNATURE_RULE}`
  );
  assert.equal(box.x, 80, 'the box must start at the signature rule, not inside the margin');
  assert.ok(
    box.x + box.width <= 936,
    'the signature box runs off the right edge of the slip'
  );
});

test('the Referring Party signature box sits on its own label line, clear of the row below', () => {
  const box = parseBox(read(SIGNATURE_PDF), 'ADMISSION_REFERRING_PARTY_SIGNATURE_BOX');

  // Measured against the template: the "Referring Party:" label runs from
  // x = 81.5 to x = 155.5 on its own line, and the next line (the blank
  // name/contact rule) starts at y = 406.52. The box must clear the label
  // horizontally and stop above that next line.
  const LABEL_RIGHT_EDGE = 155.5;
  const NEXT_ROW_TOP = 406.52;

  assert.ok(
    box.x >= LABEL_RIGHT_EDGE,
    `the signature box starts at x=${box.x}, overlapping the "Referring Party:" label`
  );
  assert.ok(
    box.y + box.height <= NEXT_ROW_TOP,
    `the signature box ends at y=${box.y + box.height}, overlapping the name/contact row below at y=${NEXT_ROW_TOP}`
  );
  assert.ok(
    box.x + box.width <= 936,
    'the signature box runs off the right edge of the slip'
  );
});

test('the Admission Slip signature box does not cover the Houseparent dropdown', () => {
  // Reported bug: in Part 2 of the Admission Slip the Houseparent on Duty
  // dropdown could not be opened, because the signature field laid over the
  // blank band sat on top of it. Both are absolutely positioned overlays on the
  // same part of the form, so nothing but this check stops them colliding.
  const box = parseBox(read(SIGNATURE_PDF), 'ADMISSION_HOUSEPARENT_SIGNATURE_BOX');

  const records = read(CHILD_RECORDS);
  const trigger = records.indexOf('aria-label="Houseparent on Duty"');
  assert.ok(trigger > 0, 'the Houseparent on Duty field is gone');

  const style = records.slice(trigger).match(/pdfFieldStyle\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/);
  assert.ok(style, 'the Houseparent on Duty field has no pdfFieldStyle position');

  const select = {
    x: Number(style[1]),
    y: Number(style[2]),
    width: Number(style[3]),
    height: Number(style[4]),
  };

  const overlapsVertically = box.y < select.y + select.height && select.y < box.y + box.height;
  const overlapsHorizontally = box.x < select.x + select.width && select.x < box.x + box.width;

  assert.ok(
    !(overlapsVertically && overlapsHorizontally),
    `the signature field (y ${box.y}–${box.y + box.height}) overlaps the Houseparent on Duty dropdown `
    + `(y ${select.y}–${select.y + select.height}), so the dropdown cannot be clicked`
  );

  // And the dropdown must still land on the printed rule, not float above it.
  assert.equal(
    select.y + select.height,
    475,
    `the Houseparent on Duty text should sit on the rule at y=475, but ends at ${select.y + select.height}`
  );
});

/* ================================================================
   PERSISTENCE
   ================================================================ */

test('the backend lets an edited Admission Slip update its signature', () => {
  const source = read(ADMISSION_CONTROLLER);

  const match = source.match(/const fields = \[([^\]]*)\]/);
  assert.ok(match, 'the admission update whitelist could not be found');
  const fields = match[1].split(',').map((field) => field.trim().replace(/^['"]|['"]$/g, ''));

  assert.ok(
    fields.includes('houseparentSignature'),
    'an edited slip cannot save its signature: the column is not in the update whitelist'
  );
  assert.ok(
    fields.includes('houseparentOnDuty'),
    'the printed name must remain editable alongside the signature'
  );
});

test('the admission INSERT still writes every signature column it declares', () => {
  const source = read(ADMISSION_CONTROLLER);

  const insert = source.match(/INSERT INTO admissions \(([\s\S]*?)\) VALUES \(([\s\S]*?)\)`/);
  assert.ok(insert, 'the admissions INSERT could not be found');

  const columns = insert[1].split(',').map((column) => column.trim()).filter(Boolean);
  for (const column of ['houseparentSignature', 'houseparentOnDuty']) {
    assert.ok(columns.includes(column), `the admissions INSERT no longer writes ${column}`);
  }

  // `status` is the one literal in the VALUES tuple ('Active'); every other
  // column needs its own placeholder, so the counts must line up.
  const placeholders = (insert[2].match(/\?/g) || []).length;
  assert.equal(
    placeholders + 1,
    columns.length,
    `the admissions INSERT binds ${placeholders} values for ${columns.length} columns`
  );
});

/* ================================================================
   FORM 08 — INCIDENT REPORT SIGN-OFFS
   ================================================================ */

const INCIDENT_CONTROLLER = path.resolve(
  __dirname,
  '../src/controllers/incidentReportController.js'
);
const INCIDENT_MODAL = path.join(COMPONENTS, 'IncidentReportModal.tsx');
const SCHEMA = path.resolve(__dirname, '../src/database/schema.sql');
const SERVER = path.resolve(__dirname, '../src/server.js');

const FORM08_SIGNOFFS = ['reportedBy', 'endorsedTo', 'checkedBy', 'notedBy'];

test('Form 08 has a signature column for each of its four sign-offs', () => {
  const schema = read(SCHEMA);
  const table = schema.match(/CREATE TABLE (?:IF NOT EXISTS )?incidentReports \(([\s\S]*?)\n\)\s*(?:ENGINE|;)/);
  assert.ok(table, 'the incidentReports table definition was not found');

  for (const field of FORM08_SIGNOFFS) {
    assert.match(
      table[1],
      new RegExp(`\\b${field}Signature\\b`),
      `incidentReports has no ${field}Signature column`
    );
  }
});

test('an existing database gets the Form 08 signature columns added on boot', () => {
  const source = read(SERVER);

  for (const field of FORM08_SIGNOFFS) {
    assert.ok(
      source.includes(`'${field}Signature'`),
      `server.js never migrates incidentReports.${field}Signature, so the first Form 08 save would fail on an older database`
    );
  }
});

test('the Form 08 controller stores and stamps all four signatures', () => {
  const source = read(INCIDENT_CONTROLLER);

  for (const field of FORM08_SIGNOFFS) {
    assert.ok(
      source.includes(`${field}Signature`),
      `incidentReportController.js ignores ${field}Signature`
    );
  }

  // The INSERT must bind every signature it declares.
  const insert = source.match(/INSERT INTO incidentReports\s*\(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\)`/);
  assert.ok(insert, 'the incidentReports INSERT could not be found');
  const columns = insert[1].split(',').map((column) => column.trim()).filter(Boolean);
  for (const field of FORM08_SIGNOFFS) {
    assert.ok(columns.includes(`${field}Signature`), `the INSERT drops ${field}Signature`);
  }
  const placeholders = (insert[2].match(/\?/g) || []).length;
  assert.equal(
    placeholders + 1,
    columns.length,
    `the incidentReports INSERT binds ${placeholders} values for ${columns.length} columns`
  );
});

test('every Form 08 signature box is measured against the real template', () => {
  const source = read(INCIDENT_CONTROLLER);
  const block = source.match(/const FORM08_SIGNATURE_BOXES = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'FORM08_SIGNATURE_BOXES was not found');

  const boxes = {};
  const entry = /(\w+):\s*\{\s*x:\s*(-?\d+),\s*top:\s*(-?\d+),\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/g;
  let hit;
  while ((hit = entry.exec(block[1])) !== null) {
    boxes[hit[1]] = {
      x: Number(hit[2]),
      top: Number(hit[3]),
      width: Number(hit[4]),
      height: Number(hit[5]),
    };
  }

  assert.deepEqual(
    Object.keys(boxes).sort(),
    [...FORM08_SIGNOFFS].sort(),
    'a sign-off has no stamp box'
  );

  // Measured against frontend/public/forms/incident-report.pdf (612.2 x 936.2):
  //   * the divider rule sits at top = 651
  //   * the "Reported by / Endorsed to" labels occupy 689–697
  //   * the "Checked by / Noted by" labels occupy 762–770
  //   * nothing at all is drawn between 652 and 688, or between 714 and 761
  // so a box must stay inside one of those two blank bands.
  const bands = [
    { from: 652, to: 688 },
    { from: 714, to: 761 },
  ];

  for (const [name, box] of Object.entries(boxes)) {
    const band = bands.find((candidate) => box.top >= candidate.from && box.top + box.height <= candidate.to);
    assert.ok(
      band,
      `${name}'s stamp box (top ${box.top}, height ${box.height}) is not inside a blank band on the template`
    );
    assert.ok(box.x >= 0 && box.x + box.width <= 612.2, `${name}'s box runs off the page`);
  }

  // The two halves must not collide with each other.
  const byTop = Object.entries(boxes).sort((a, b) => a[1].x - b[1].x);
  for (let i = 1; i < byTop.length; i += 1) {
    const previous = byTop[i - 1][1];
    const current = byTop[i][1];
    if (previous.top !== current.top) continue;
    assert.ok(
      previous.x + previous.width <= current.x,
      `${byTop[i - 1][0]} and ${byTop[i][0]} overlap on the same line`
    );
  }
});

test('the on-screen Form 08 pads sit exactly where the stamps land', () => {
  const controller = read(INCIDENT_CONTROLLER);
  const modal = read(INCIDENT_MODAL);

  assert.match(
    modal,
    /import\s*\{[\s\S]*?SignaturePad[\s\S]*?\}\s*from\s*'@\/app\/components\/SignaturePad'/,
    'IncidentReportModal.tsx does not import the shared SignaturePad'
  );

  const expected = {};
  const entry = /(\w+):\s*\{\s*x:\s*(-?\d+),\s*top:\s*(-?\d+),\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/g;
  let hit;
  while ((hit = entry.exec(controller)) !== null) {
    expected[hit[1]] = `${hit[2]}/${hit[3]}/${hit[4]}/${hit[5]}`;
  }

  const modalBlock = modal.match(/const SIGNATURE_BOXES = \{([\s\S]*?)\n\} as const;/);
  assert.ok(modalBlock, 'the modal has no SIGNATURE_BOXES');

  const actual = {};
  entry.lastIndex = 0;
  while ((hit = entry.exec(modalBlock[1])) !== null) {
    actual[hit[1]] = `${hit[2]}/${hit[3]}/${hit[4]}/${hit[5]}`;
  }

  assert.deepEqual(
    actual,
    expected,
    'the Form 08 pads and the PDF stamps have drifted apart — signatures would land somewhere the signer did not draw'
  );
});

test('Form 08 sends its signatures to the server and loads them back', () => {
  const modal = read(INCIDENT_MODAL);

  // Save
  assert.match(modal, /reportedBySignature:\s*form\.reportedBySignature/, 'save drops the Reported-by signature');
  assert.match(modal, /notedBySignature:\s*form\.notedBySignature/, 'save drops the Noted-by signature');

  // Load — reopening a signed report must show the signatures again.
  assert.match(modal, /reportedBySignature:\s*r\.reportedBySignature/, 'view drops the Reported-by signature');
  assert.match(modal, /notedBySignature:\s*r\.notedBySignature/, 'view drops the Noted-by signature');

  // The pads must be read-only when the form is not editable.
  assert.match(
    modal,
    /disabled=\{!editable\}/,
    'the Form 08 pads are not tied to the form\'s editable state'
  );
});

/* ================================================================
   ANECDOTAL REPORT — HOUSEPARENT
   ================================================================ */

const ANECDOTAL_CONTROLLER = path.resolve(
  __dirname,
  '../src/controllers/anecdotalReportController.js'
);
const ANECDOTAL_PDF = path.resolve(__dirname, '../src/utils/anecdotalReportPdf.js');
const ANECDOTAL_REPORTS = path.join(COMPONENTS, 'AnecdotalReports.tsx');

test('the Anecdotal Report stores the Houseparent signature', () => {
  const controller = read(ANECDOTAL_CONTROLLER);

  assert.match(
    controller,
    /houseparentSignature LONGTEXT NULL/,
    'anecdotalReports has no houseparentSignature column'
  );

  // CREATE TABLE IF NOT EXISTS will not add a column to a database that already
  // has the table, so an explicit ALTER has to be there too.
  assert.match(
    controller,
    /ALTER TABLE anecdotalReports ADD COLUMN houseparentSignature/,
    'an existing database would never get the signature column'
  );

  for (const statement of ['INSERT INTO anecdotalReports', 'UPDATE anecdotalReports SET']) {
    const at = controller.indexOf(statement);
    assert.ok(at > 0, `${statement} not found`);
    const tail = controller.slice(at, at + 700);
    assert.ok(
      tail.includes('houseparentSignature'),
      `${statement} does not carry houseparentSignature`
    );
  }
});

test('the Anecdotal PDF stamps the signature above the printed name', () => {
  const source = read(ANECDOTAL_PDF);

  assert.match(
    source,
    /await drawSignature\(pdf, pages\[1\], report\.houseparentSignature/,
    'the Anecdotal PDF never stamps the Houseparent signature on page 2'
  );
  assert.match(
    source,
    /houseparentSignature: report\.houseparentSignature/,
    'buildAnecdotalReportDocument drops the signature before generating'
  );

  const box = source.match(/const HOUSEPARENT_SIGNATURE_BOX = \{([^}]*)\}/);
  assert.ok(box, 'HOUSEPARENT_SIGNATURE_BOX was not found');

  const values = {};
  for (const pair of box[1].split(',')) {
    const [key, raw] = pair.split(':');
    if (!key || !raw) continue;
    const value = Number(raw.trim());
    if (!Number.isNaN(value)) values[key.trim()] = value;
  }

  // Measured against page 2 of the template: the "Assessed by:" label ends at
  // top = 444, the printed name is drawn at top = 473.6, and nothing is printed
  // between them. The signature has to land inside that gap.
  assert.ok(values.top >= 444, `the signature box starts at top=${values.top}, over the "Assessed by:" label`);
  assert.ok(
    values.top + values.height <= 473.6,
    `the signature box ends at top=${values.top + values.height}, over the printed name`
  );
});

test('the Anecdotal editor pads over the same band the PDF stamps into', () => {
  const pdf = read(ANECDOTAL_PDF);
  const ui = read(ANECDOTAL_REPORTS);

  assert.match(
    ui,
    /import\s*\{[\s\S]*?SignaturePad[\s\S]*?\}\s*from\s*'@\/app\/components\/SignaturePad'/,
    'AnecdotalReports.tsx does not import the shared SignaturePad'
  );

  const grab = (source, name) => {
    const block = source.match(new RegExp(`const ${name} = \\{([^}]*)\\}`));
    assert.ok(block, `${name} was not found`);
    const values = {};
    for (const pair of block[1].split(',')) {
      const [key, raw] = pair.split(':');
      if (!key || !raw) continue;
      const value = Number(raw.trim());
      if (!Number.isNaN(value)) values[key.trim()] = value;
    }
    return values;
  };

  assert.deepEqual(
    grab(ui, 'HOUSEPARENT_SIGNATURE_BOX'),
    grab(pdf, 'HOUSEPARENT_SIGNATURE_BOX'),
    'the Anecdotal pad and the PDF stamp have drifted apart'
  );

  assert.match(ui, /houseparentSignature, content \}/, 'save drops the Houseparent signature');
  assert.match(
    ui,
    /setHouseparentSignature\(record\.houseparentSignature \|\| ''\)/,
    'opening a signed report would show an empty pad'
  );
});

/* ================================================================
   EDUCATION — QUARTERLY PROGRESS REPORT
   ================================================================ */

const EDUCATION = path.join(COMPONENTS, 'Education.tsx');

test('the Education quarterly report captures and prints a signature', () => {
  const source = read(EDUCATION);

  assert.match(
    source,
    /import\s*\{[\s\S]*?SignaturePad[\s\S]*?\}\s*from\s*'@\/app\/components\/SignaturePad'/,
    'Education.tsx does not import the shared SignaturePad'
  );
  assert.match(
    source,
    /preparedBySignature: string;/,
    'generateQuarterlyReportPdf does not accept a signature'
  );
  assert.match(
    source,
    /await drawSignatureImageOnPage\(pdf, page, fields\.preparedBySignature/,
    'the quarterly report never draws the signature'
  );

  // The signature must be placed on the page that is current when it is drawn —
  // this document is built from scratch and can span several pages.
  assert.match(
    source,
    /newPageIfNeeded\(lineHeight \* 3 \+ SIGNATURE_HEIGHT\)/,
    'the PREPARED BY block can be split across a page break'
  );

  // And it has to be carried through the form, the payload and the reset.
  assert.match(source, /preparedBySignature: ''/, 'the form starts without a signature field');
  assert.match(
    source,
    /preparedBySignature: quarterlyForm\.preparedBySignature/,
    'the submit payload drops the signature'
  );
  assert.match(
    source,
    /value=\{quarterlyForm\.preparedBySignature\}/,
    'no pad is rendered for the Education report'
  );
});

/* ================================================================
   GENERATED REPORTS — DSWD AND DISCHARGE
   ================================================================ */

const REPORTS = path.join(COMPONENTS, 'Reports.tsx');
const PHASE_PROGRESS = path.join(COMPONENTS, 'PhaseProgress.tsx');

test('the DSWD report prints both staff signatures', () => {
  const source = read(REPORTS);

  assert.match(
    source,
    /import\s*\{[\s\S]*?SignaturePad[\s\S]*?\}\s*from\s*'@\/app\/components\/SignaturePad'/,
    'Reports.tsx does not import the shared SignaturePad'
  );
  assert.match(
    source,
    /label="Prepared by signature"/,
    'the DSWD report has no pad for the Social Worker'
  );
  assert.match(
    source,
    /label="Reviewed and approved by signature"/,
    'the DSWD report has no pad for the Center Head'
  );

  // Both signatures must reach the generated HTML, each on its own line.
  assert.match(
    source,
    /preparedBySignature \? `<img src="\$\{preparedBySignature\}"/,
    'the Prepared-by signature is never embedded in the report'
  );
  assert.match(
    source,
    /approvedBySignature \? `<img src="\$\{approvedBySignature\}"/,
    'the Reviewed/Approved-by signature is never embedded in the report'
  );

  // A slot per signature, so the printed rule does not move when one is drawn.
  const slots = (source.match(/class="signature-slot"/g) || []).length;
  assert.equal(slots, 2, `expected two signature slots in the DSWD report, found ${slots}`);
});

test('the DSWD signature rules keep their original printed position', () => {
  const source = read(REPORTS);

  // The rule used to be pushed down by its own 60px top margin; that space is
  // now the slot the signature is drawn into. If the margin comes back as well,
  // the signature block jumps down the page.
  assert.ok(
    !/\.signature-line \{[^}]*margin-top/.test(source),
    'the DSWD signature rule still carries a top margin on top of the new slot'
  );
  assert.match(
    source,
    /\.signature-slot \{[^}]*height: 60px/,
    'the DSWD signature slot no longer reserves the 60px the margin used to'
  );
});

test('the Discharge Report prints both staff signatures', () => {
  const source = read(PHASE_PROGRESS);

  assert.match(
    source,
    /import\s*\{[\s\S]*?SignaturePad[\s\S]*?\}\s*from\s*'@\/app\/components\/SignaturePad'/,
    'PhaseProgress.tsx does not import the shared SignaturePad'
  );
  assert.match(source, /label="Prepared by signature"/, 'the Discharge Report has no pad for the preparing staff');
  assert.match(
    source,
    /label="Approving authority signature"/,
    'the Discharge Report has no pad for the Center Head'
  );

  assert.match(
    source,
    /preparedBySignature \? `<img src="\$\{preparedBySignature\}"/,
    'the Prepared-by signature is never embedded in the Discharge Report'
  );
  assert.match(
    source,
    /approvedBySignature \? `<img src="\$\{approvedBySignature\}"/,
    'the Approving-authority signature is never embedded in the Discharge Report'
  );

  const slots = (source.match(/class="signature-slot"/g) || []).length;
  assert.equal(slots, 2, `expected two signature slots in the Discharge Report, found ${slots}`);
});

test('the Discharge Report signatures are handed to the builder, not read from stale state', () => {
  const source = read(PHASE_PROGRESS);

  // The report is written as one finished document, so both signatures must be
  // passed in. Reading them from state inside the async builder would risk
  // generating with the previous attempt's values.
  assert.match(
    source,
    /const buildDischargeReport = async \(preparedBySignature: string, approvedBySignature: string\)/,
    'the Discharge Report builder does not take the signatures as arguments'
  );
  assert.match(
    source,
    /buildDischargeReport\(dischargePreparedBySignature, dischargeApprovedBySignature\)/,
    'the dialog does not pass what the signer drew to the builder'
  );

  // Both entry points must go through the signature step, not straight to the
  // builder — otherwise the buttons on the case-closed screen would silently
  // produce an unsigned report.
  const calls = source.match(/handleDownloadDischargeReport/g) || [];
  assert.ok(calls.length >= 3, `both Discharge Report buttons must still call the handler (found ${calls.length} references)`);
  assert.ok(
    !/onClick=\{buildDischargeReport\}/.test(source),
    'a Discharge Report button skips the signature step'
  );
});

test('generated reports keep their signatures out of any save payload', () => {
  // Both reports are produced on demand and never stored, so a signature drawn
  // for one belongs to the printed document only. This guards against the
  // signatures quietly being wired into a request as the feature grows.
  for (const file of [REPORTS, PHASE_PROGRESS]) {
    const name = path.basename(file);
    const source = read(file);

    for (const match of source.matchAll(/JSON\.stringify\(([\s\S]{0,400}?)\)/g)) {
      assert.ok(!/Signature\b/.test(match[1]), `${name}: a signature is being sent to the server`);
    }
    for (const match of source.matchAll(/body:\s*([^,\n]+)/g)) {
      assert.ok(!/Signature\b/.test(match[1]), `${name}: a signature is being sent to the server`);
    }
  }
});

/* ================================================================
   SCOPE
   ================================================================ */

test('the non-staff Health signature pad was left alone', () => {
  const source = read(HEALTH);

  // Health.tsx has its own private pad for the doctor and dentist. They are not
  // staff signatures under this brief, so it must not have been converted.
  assert.ok(
    !/from '@\/app\/components\/SignaturePad'/.test(source),
    'Health.tsx was switched to the shared pad; the doctor/dentist pads were out of scope'
  );
});

test('TRI keeps its documented blank signature policy', () => {
  const tri = read(path.resolve(__dirname, '../src/utils/triReportPdf.js'));

  assert.match(
    tri,
    /signature/i,
    'the TRI PDF no longer mentions its signature policy'
  );
});
