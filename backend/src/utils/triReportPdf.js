/**
 * TRI report PDF generator.
 * @module utils/triReportPdf
 * @description Fills the official TRI form by overlaying the recorded answers onto
 * the ORIGINAL `tri.pdf` — the same file the editor renders in the browser. Logos,
 * pre-printed wording, the scoring-band table and the eight-page layout are the
 * genuine article; only the answers are added on top.
 *
 * Generation lives on the server because approval happens on the server. The record
 * can be approved from the Reports queue with no form open, so a browser-side
 * generator would leave a file-less Documents entry for any client that did not
 * happen to have the form on screen.
 *
 * Coordinates come from `frontend/src/shared/triLayout.json`, which the frontend
 * overlay reads too — one copy, so the exported PDF and the on-screen form cannot
 * drift apart.
 *
 * NOTE ON SIGNATURES: the official TRI carries five signature lines (Houseparent,
 * Administrative Officer, SWO I/Case Manager, SWO II/Center Head, SWO III/Section
 * Chief). All five are filled in when their drawing has been recorded. On the three
 * lines the template leaves blank the writer also prints the name (the Houseparent
 * comes from the record; the two officials come from `triLayout.json`), placed below
 * the signature so the rule underlines it. The block's second row already carries
 * its two names on the form itself, so only a signature is stamped there.
 *
 * The published document is still titled as a system copy: it reproduces the
 * recorded answers and whatever signatures are stored, it is not the fully executed
 * instrument, and it does not pretend to be. The subject line names exactly which
 * lines were signed and which were left blank.
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { periodLabel } = require('./triPeriod');
const { ratingForPoints } = require('./triScoring');

/** The official form. The `public` copy is canonical — the editor fetches the same file. */
const TEMPLATE_CANDIDATES = [
  path.resolve(__dirname, '../../../frontend/public/forms/tri.pdf'),
  path.resolve(__dirname, '../../../frontend/dist/forms/tri.pdf'),
];

/** Measured layout shared with the frontend overlay. */
const LAYOUT_PATH = path.resolve(__dirname, '../../../frontend/src/shared/triLayout.json');

/** Page 0 header line, where the resident / room / period values sit. */
const HEADER_Y = 753;
const HEADER = { name: 74, room: 254, period: 398 };
/** Part I total, on page 5. */
const TOTAL_POINTS_POS = { page: 5, x: 307, y: 602 };
/** Page 6 summary column: previous, earned, deductions, final, rating, previous rating. */
const SUMMARY = { page: 6, x: 482, previous: 273, earned: 252, deductions: 231, final: 210, rating: 189, previousRating: 168 };

/**
 * The "Assessed by" block on the last page (page 8, index 7), in pdf-lib's
 * bottom-left coordinate space.
 *
 * Five lines in two rows, measured against the template rather than guessed:
 *
 *   Row 1 — rules' ink at y 770.57-772.5, captions at y 752.11
 *     Houseparent             x 72.02  w 90.24
 *     Administrative Officer  x 223.75 w 95.03
 *     SWO I/Case Manager      x 346.2  w 115.25   (three underscore runs)
 *   Row 2 — rules' ink at y 668-670.25, printed names at y 649.61, captions y 638.09
 *     SWO II/Center Head      name x 72.02  w 179.32
 *     SWO III/Section Chief   name x 329.88 w 188.12
 *
 * The template leaves row 1 completely blank, so this writer fills all three of
 * its printed names. Row 2 already carries the facility's two names, printed
 * correctly by the form itself, so nothing is drawn there — only the signature
 * is stamped. Nothing is ever painted white: there is no stale text to hide.
 *
 * Every line reads the same way on the three lines the template leaves blank: the
 * signature sits in the blank band above the rule and the printed name sits below the
 * signature, so the rule doubles as the underline of the name. Row 2 is the template's
 * own arrangement and is not the same: it prints its names BELOW its rules, so the app
 * draws no name there and only stamps a signature above the rule.
 *
 * `tri-houseparent-signature.test.js` and `tri-designated-signatures.test.js` assert
 * the boxes stay inside those bands and inside each rule's horizontal extent.
 */
const HOUSEPARENT_SIGNATURE_BOX = { page: 7, x: 72.02, y: 786, width: 90.24, height: 20 };

/**
 * Where the Houseparent's PRINTED NAME goes: below the signature and directly
 * above the rule, so the rule underlines the name.
 *
 * Baseline y 777 puts the 8pt ascenders at 782.7 — clear of the 786 box bottom
 * above them — and the descenders at 775.3, clear of the rule's ink at 772.5.
 * The name is shrunk to the rule's width so a long name cannot run into the
 * "Administrative Officer" line beside it.
 */
const HOUSEPARENT_NAME_POS = { page: 7, x: 72.02, y: 777, size: 8, width: 90.24 };

/** Row 1's middle line — "Administrative Officer", captioned at y 752.11. */
const ADMIN_OFFICER_SIGNATURE_BOX = { page: 7, x: 223.75, y: 786, width: 95.03, height: 20 };
const ADMIN_OFFICER_NAME_POS = { page: 7, x: 223.75, y: 777, size: 8, width: 95.03 };

/** Row 1's right line — "SWO I/Case Manager". Its rule is three underscore runs. */
const SWO1_SIGNATURE_BOX = { page: 7, x: 346.2, y: 786, width: 115.25, height: 20 };
const SWO1_NAME_POS = { page: 7, x: 346.2, y: 777, size: 8, width: 115.25 };

/**
 * Row 2's two lines. Their names are already on the form, so the x and width
 * here are the template's own printed-name extent rather than the rule's — that
 * is the width the signature is centred over.
 */
const SWO2_SIGNATURE_BOX = { page: 7, x: 72.02, y: 672, width: 179.32, height: 20 };
const SWO3_SIGNATURE_BOX = { page: 7, x: 329.88, y: 672, width: 188.12, height: 20 };

/**
 * The five lines, in the order they appear across the page. One list, so the
 * layout cross-check, the name drawing and the stamping cannot disagree about
 * which column and which coordinates belong together.
 *
 * `nameFrom` says where the printed name comes from:
 *   'record'   — the Houseparent who prepared the report; not a fixed person
 *   'layout'   — one of the facility's four designated officials
 *   'template' — the form already prints it, so the app draws nothing
 *
 * `nameInkWidth` is only needed for the 'template' lines, where there is no
 * drawn name to measure. Every other line measures its own text.
 */
const SIGNATURE_LINES = [
  {
    key: 'houseparent',
    label: 'Houseparent',
    box: HOUSEPARENT_SIGNATURE_BOX,
    namePos: HOUSEPARENT_NAME_POS,
    nameFrom: 'record',
    signatureColumn: 'houseparentSignature',
  },
  {
    key: 'adminofficer',
    label: 'Administrative Officer',
    box: ADMIN_OFFICER_SIGNATURE_BOX,
    namePos: ADMIN_OFFICER_NAME_POS,
    nameFrom: 'layout',
    signatureColumn: 'adminOfficerSignature',
  },
  {
    key: 'swo1',
    label: 'SWO I/Case Manager',
    box: SWO1_SIGNATURE_BOX,
    namePos: SWO1_NAME_POS,
    nameFrom: 'layout',
    signatureColumn: 'swo1Signature',
  },
  {
    key: 'swo2',
    label: 'SWO II/Center Head',
    box: SWO2_SIGNATURE_BOX,
    namePos: null,
    nameFrom: 'template',
    nameInkWidth: 179.32,
    // The SWO II/Center Head line's drawing is stored under the column it shipped
    // with (`centerheadSignature`), not under its key, so the signatures already
    // saved on live records keep working. The key names the line; the column names
    // where its drawing lives.
    signatureColumn: 'centerheadSignature',
  },
  {
    key: 'swo3',
    label: 'SWO III/Section Chief',
    box: SWO3_SIGNATURE_BOX,
    namePos: null,
    nameFrom: 'template',
    nameInkWidth: 188.12,
    // Same as `swo2`: the line's key is `swo3`, its column is `sectionchiefSignature`.
    signatureColumn: 'sectionchiefSignature',
  },
];

let cachedTemplateBytes = null;
let cachedLayout = null;

function loadTemplateBytes() {
  if (cachedTemplateBytes) return cachedTemplateBytes;
  for (const candidate of TEMPLATE_CANDIDATES) {
    try {
      const bytes = fs.readFileSync(candidate);
      if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
        cachedTemplateBytes = bytes;
        return bytes;
      }
    } catch {
      // Not at this path — try the next candidate.
    }
  }
  throw new Error(
    `The official TRI template could not be read. Looked in: ${TEMPLATE_CANDIDATES.join(', ')}`
  );
}

/** The layout tables. Throws rather than silently drawing nothing. */
function loadLayout() {
  if (cachedLayout) return cachedLayout;
  const raw = JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf8'));
  for (const key of ['partOne', 'scoreX', 'pageItems', 'itemY', 'offensePos', 'partTwoOffenses']) {
    if (!raw[key]) throw new Error(`The TRI layout is missing "${key}" (${LAYOUT_PATH})`);
  }
  if (raw.scoreX.length !== 4) throw new Error('The TRI layout must define four score columns');

  // The page-8 signature geometry is declared here as well, because the browser's
  // export stamps the same line. Two copies of a coordinate drift; a mismatch means
  // the exported PDF and the published copy would place the signature differently,
  // so it is a hard error rather than a silent difference.
  for (const [key, expected] of [
    ['houseparentSignatureBox', HOUSEPARENT_SIGNATURE_BOX],
    ['houseparentNamePos', HOUSEPARENT_NAME_POS],
    ['adminOfficerSignatureBox', ADMIN_OFFICER_SIGNATURE_BOX],
    ['adminOfficerNamePos', ADMIN_OFFICER_NAME_POS],
    ['swo1SignatureBox', SWO1_SIGNATURE_BOX],
    ['swo1NamePos', SWO1_NAME_POS],
    ['swo2SignatureBox', SWO2_SIGNATURE_BOX],
    ['swo3SignatureBox', SWO3_SIGNATURE_BOX],
  ]) {
    const declared = raw[key];
    if (!declared) continue; // a layout file written before the geometry was shared
    for (const [field, value] of Object.entries(expected)) {
      if (Number(declared[field]) !== value) {
        throw new Error(`The TRI layout's ${key}.${field} is ${declared[field]}, but the PDF writer stamps ${value} (${LAYOUT_PATH})`);
      }
    }
  }

  // The four designated names are facts, not coordinates, but they live in the same
  // file for the same reason: the browser print view prints them too, and a
  // published copy that disagrees with the printed one is the defect this prevents.
  // The Houseparent's line is deliberately absent — it is whoever prepared the
  // report, so it comes from the record, not from a fixed list.
  for (const key of ['adminofficer', 'swo1', 'swo2', 'swo3']) {
    const person = raw.designatedPersonnel && raw.designatedPersonnel[key];
    if (!person || !String(person.name || '').trim()) {
      throw new Error(`The TRI layout is missing the designated name for "${key}" (${LAYOUT_PATH})`);
    }
  }

  cachedLayout = raw;
  return cachedLayout;
}

/** The template path that will actually be used, for the boot-time log. */
function triTemplatePath() {
  return TEMPLATE_CANDIDATES.find((candidate) => {
    try { return fs.readFileSync(candidate).subarray(0, 5).toString('ascii') === '%PDF-'; } catch { return false; }
  }) || null;
}

/** `responses` may arrive as a JSON string (MariaDB LONGTEXT) or an object. */
function asObject(value) {
  if (!value) return {};
  if (typeof value === 'string') { try { return JSON.parse(value) || {}; } catch { return {}; } }
  return typeof value === 'object' ? value : {};
}

/** `{ id: score }` from either the array form or a plain map. */
function scoreMapOf(items) {
  const map = {};
  if (Array.isArray(items)) {
    for (const item of items) if (item && item.id != null) map[item.id] = Number(item.score) || 0;
  } else if (items && typeof items === 'object') {
    for (const [id, score] of Object.entries(items)) map[id] = Number(score) || 0;
  }
  return map;
}

function sanitize(value) {
  return String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

function safeFileName(value) {
  return String(value || 'resident').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'resident';
}

/**
 * The name that belongs on the Houseparent line.
 *
 * Prefers whoever actually signed, then whoever submitted — the TRI is submitted by
 * the Houseparent, so either one identifies them. Returns '' when neither is known,
 * which leaves the line blank rather than printing a guess.
 */
function houseparentNameOf(record) {
  return sanitize((record && (record.houseparentSignedBy || record.submittedBy)) || '');
}

/**
 * Shrinks `text` until it fits `maxWidth`, returning the size and the width it
 * ended up at. The width is what the signature gets centred over, so it has to
 * come from the same font and size the name is actually drawn with.
 */
function fitText(text, font, size, maxWidth) {
  let fitted = size;
  while (fitted > 4 && font.widthOfTextAtSize(text, fitted) > maxWidth) fitted -= 0.25;
  return { size: fitted, width: font.widthOfTextAtSize(text, fitted) };
}

/** The designated official's printed name, read from the shared layout. */
function designatedNameOf(layout, key) {
  const person = layout && layout.designatedPersonnel && layout.designatedPersonnel[key];
  return sanitize(person && person.name);
}

/**
 * The printed name for a line, or '' when the form prints it itself.
 *
 * The Houseparent's line is not a fixed person — it is whoever prepared and signed
 * the report — so it comes from the record. The four officials are the facility's
 * designated personnel, so they come from the shared layout. The two second-row
 * lines are already printed correctly by the template, so nothing is drawn for them.
 */
function lineNameOf(line, record, layout) {
  if (line.nameFrom === 'record') return houseparentNameOf(record);
  if (line.nameFrom === 'layout') return designatedNameOf(layout, line.key);
  return '';
}

/**
 * Prints a line's name below its signature and above its rule, so the rule doubles
 * as the underline of the name.
 *
 * Returns the name's rendered width, so the signature can be centred over the name
 * rather than over the box, or null when there is no name to draw. The text is
 * shrunk to its slot so a long name cannot run into the line printed beside it.
 */
function drawLineName(pages, layout, line, record, bold) {
  if (!line.namePos) return null;
  const page = pages[line.namePos.page];
  const name = lineNameOf(line, record, layout);
  if (!page || !name) return null;

  const fitted = fitText(name, bold, line.namePos.size, line.namePos.width);
  page.drawText(name, {
    x: line.namePos.x,
    y: line.namePos.y,
    size: fitted.size,
    font: bold,
    color: rgb(0.08, 0.08, 0.08),
  });
  return fitted.width;
}

/**
 * Stamps a line's drawn signature into the blank band above its rule.
 *
 * The image is scaled to fit the band and then centred on the printed name rather
 * than on the box: the name is left-aligned and usually narrower than its slot, so
 * centring on the box would leave the signature floating away from the name it
 * belongs to. The two lines the template prints itself have no drawn name to
 * measure, so their measured extent from the template is used instead.
 *
 * Returns false and leaves the line blank when there is no signature, when it is
 * not a PNG/JPEG data URL, or when it cannot be decoded — an unsigned TRI is still
 * a perfectly valid export, so a bad image must never abort the document.
 */
async function drawLineSignature(pdf, pages, record, line, nameWidth) {
  const dataUrl = String((record && record[line.signatureColumn]) || '');
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,/i);
  if (!match) return false;
  const page = pages[line.box.page];
  if (!page) return false;

  try {
    const image = match[1].toLowerCase() === 'png'
      ? await pdf.embedPng(dataUrl)
      : await pdf.embedJpg(dataUrl);
    const box = line.box;
    const scale = Math.min(box.width / image.width, box.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const anchorWidth = nameWidth != null ? nameWidth : (line.nameInkWidth || box.width);
    page.drawImage(image, {
      x: box.x + (anchorWidth - width) / 2,
      y: box.y + (box.height - height) / 2,
      width,
      height,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Draws the official TRI with the record's answers.
 *
 * @param {Object} record               Row from `triRecords`.
 * @param {Object} [options]
 * @param {string} [options.residentName]  Joined from `children`.
 * @param {string} [options.room]          Fallback when the record has no room.
 * @returns {Promise<Buffer>}
 */
async function buildTriReportPdf(record = {}, { residentName, room } = {}) {
  const layout = loadLayout();
  const responses = asObject(record.responses);
  const scores = scoreMapOf(responses.items);
  const offenses = Array.isArray(responses.offenses) ? responses.offenses.map(Number) : [];

  const pdf = await PDFDocument.load(loadTemplateBytes());
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();

  const draw = (page, value, x, y, size = 9, useFont = font) => {
    const text = sanitize(value);
    if (!text || !page) return;
    page.drawText(text, { x, y, size, font: useFont, color: rgb(0.08, 0.08, 0.08) });
  };

  // ── header: resident, room, period
  draw(pages[0], residentName || record.residentId, HEADER.name, HEADER_Y, 10, bold);
  draw(pages[0], responses.room || room || '', HEADER.room, HEADER_Y, 10, font);
  draw(pages[0], periodLabel(record.reportingYear, record.reportingMonth), HEADER.period, HEADER_Y, 10, font);

  // ── Part I: one X per answered row, in the column for its score
  for (const entry of layout.pageItems) {
    const page = pages[entry.page];
    if (!page) continue;
    for (const id of entry.ids) {
      const score = Number(scores[id] || 0);
      const y = layout.itemY[id];
      if (score >= 1 && score <= 4 && y != null) {
        page.drawText('X', { x: layout.scoreX[score - 1] - 3, y: y - 11, size: 10, font: bold, color: rgb(0, 0, 0) });
      }
    }
  }

  // ── Part II: one X per ticked offense row
  layout.offensePos.forEach((pos, index) => {
    if (offenses.includes(index)) {
      draw(pages[pos.page], 'X', 484, pos.y - 11, 10, bold);
    }
  });

  // ── totals and the summary block
  const earned = record.partOnePoints ?? Object.values(scores).reduce((sum, n) => sum + (Number(n) || 0), 0);
  const deductions = record.deductions
    ?? offenses.reduce((sum, index) => sum + (layout.partTwoOffenses[index]?.points || 0), 0);
  const finalPoints = record.finalPoints ?? Math.max(0, earned - deductions);
  const rating = record.rating || ratingForPoints(finalPoints) || '';

  draw(pages[TOTAL_POINTS_POS.page], String(earned), TOTAL_POINTS_POS.x, TOTAL_POINTS_POS.y, 10, bold);
  const summary = pages[SUMMARY.page];
  draw(summary, record.previousPoints ?? '', SUMMARY.x, SUMMARY.previous, 10, font);
  draw(summary, String(earned), SUMMARY.x, SUMMARY.earned, 10, font);
  draw(summary, String(deductions), SUMMARY.x, SUMMARY.deductions, 10, font);
  draw(summary, String(finalPoints), SUMMARY.x, SUMMARY.final, 10, bold);
  draw(summary, rating, SUMMARY.x, SUMMARY.rating, 9, bold);
  draw(summary, record.previousRating || '', SUMMARY.x, SUMMARY.previousRating, 9, font);

  // All five lines of the block are filled in now. On each one the printed name goes
  // down first — below the signature, directly above the rule — and the drawn
  // signature is stamped over it, centred on the name. The two second-row lines
  // already carry their names on the form itself, so only their signatures are
  // stamped and `drawLineName` draws nothing for them.
  //
  // Metadata only beyond that — no overlay text, so nothing can collide with the
  // form's own footer. The "system copy" distinction is carried by the Documents
  // entry title and description, which is where a reader actually looks.
  const signedRoles = [];
  const blankRoles = [];
  for (const line of SIGNATURE_LINES) {
    const nameWidth = drawLineName(pages, layout, line, record, bold);
    const stamped = await drawLineSignature(pdf, pages, record, line, nameWidth);
    (stamped ? signedRoles : blankRoles).push(line.label);
  }

  pdf.setTitle(`TRI ${periodLabel(record.reportingYear, record.reportingMonth)} - ${residentName || record.residentId}`);
  // The subject has to describe the page it is attached to. Which lines carry a
  // signature is variable — any of the five may be signed independently — so it is
  // built from what was actually drawn rather than from a fixed sentence that a
  // second signer would make untrue.
  pdf.setSubject(
    'System-generated copy of the Treatment and Rehabilitation Indicator. '
    + (signedRoles.length
      ? `Signed: ${signedRoles.join(', ')}.`
        + (blankRoles.length ? ` Left blank: ${blankRoles.join(', ')}.` : '')
      : 'No signature line is signed; this is not the signed original.'),
  );
  pdf.setProducer('SCH-PATH');
  pdf.setCreator('SCH-PATH');

  const buffer = Buffer.from(await pdf.save());
  return buffer;
}

/** Filename for the published copy. */
function triReportFileName(record = {}, residentName) {
  const month = String(record.reportingMonth || 0).padStart(2, '0');
  return `TRI-${safeFileName(residentName || record.residentId)}-${record.reportingYear}-${month}.pdf`;
}

/** Title of the Documents entry. Says "system copy" so it is never mistaken for the signed form. */
function triDocumentTitle(record = {}) {
  return `TRI — ${periodLabel(record.reportingYear, record.reportingMonth)} (system copy)`;
}

/**
 * Builds the PDF for a `triRecords` row, ready to store on a `documents` entry.
 * Single entry point, so a published copy and a re-generated one are identical.
 *
 * @returns {Promise<{ buffer: Buffer, fileName: string, fileSize: number, title: string }>}
 */
async function buildTriReportDocument(record = {}, residentName, room) {
  const buffer = await buildTriReportPdf(record, { residentName, room });
  return {
    buffer,
    fileName: triReportFileName(record, residentName),
    fileSize: buffer.length,
    title: triDocumentTitle(record),
  };
}

module.exports = {
  buildTriReportPdf,
  buildTriReportDocument,
  triReportFileName,
  triDocumentTitle,
  triTemplatePath,
  loadLayout,
  scoreMapOf,
  LAYOUT_PATH,
  HOUSEPARENT_SIGNATURE_BOX,
  HOUSEPARENT_NAME_POS,
  ADMIN_OFFICER_SIGNATURE_BOX,
  ADMIN_OFFICER_NAME_POS,
  SWO1_SIGNATURE_BOX,
  SWO1_NAME_POS,
  SWO2_SIGNATURE_BOX,
  SWO3_SIGNATURE_BOX,
  SIGNATURE_LINES,
  fitText,
  houseparentNameOf,
  lineNameOf,
  designatedNameOf,
};
