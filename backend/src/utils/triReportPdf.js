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
 * Chief). Only the Houseparent's line is filled in: their printed name goes just
 * above the rule and their drawn signature is stamped onto it. The other four stay
 * blank, so the published document is still titled as a system copy — it reproduces
 * the recorded answers, it is not the fully executed instrument, and it does not
 * pretend to be.
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
 * The "Houseparent" signature line on the last page (page 8, index 7), in
 * pdf-lib's bottom-left coordinate space.
 *
 * Measured against the template rather than guessed: the block is printed as
 * literal text, so the line itself is a run of underscores at x 72.02 width 90.24
 * whose baseline sits at y = 772.75. The caption "Houseparent" is printed 20.6pt
 * below it, and the line above the block ("The Rehabilitation Team together with
 * the resident:") ends at y = 804. That leaves a blank band 774–801, which is what
 * this box fills.
 *
 * `tri-signature.test.js` asserts the box stays inside that band and inside the
 * underscore run's horizontal extent.
 */
const HOUSEPARENT_SIGNATURE_BOX = { page: 7, x: 72.02, y: 774, width: 90.24, height: 22 };

/**
 * Where the Houseparent's PRINTED NAME goes, on the same page-8 line as the
 * signature and just above it.
 *
 * The official form prints a filled-in example of this block further down the same
 * page: a rule, then the typed name, then the role caption. The Houseparent block
 * only ever had the rule and the "Houseparent" caption, so the typed name belongs
 * directly above its rule — that is also where a signer would write their name.
 *
 * Measured band: the rule's ink sits at y 770.57–772.5, the line of text above the
 * block ("The Rehabilitation Team together with the resident:") has its descenders
 * at y 811.40, and the "Houseparent" caption occupies 749.93–761.09. The 22pt
 * signature box fills 774–796 and the name is drawn on an 8pt bold face with its
 * baseline at y = 800, so it clears the box below by ~1.5pt and the text above by
 * ~2.8pt. Both are pinned by `tri-houseparent-signature.test.js`.
 */
const HOUSEPARENT_NAME_POS = { page: 7, x: 72.02, y: 800, size: 8, width: 90.24 };

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
  for (const [key, expected] of [['houseparentSignatureBox', HOUSEPARENT_SIGNATURE_BOX], ['houseparentNamePos', HOUSEPARENT_NAME_POS]]) {
    const declared = raw[key];
    if (!declared) continue; // a layout file written before the geometry was shared
    for (const [field, value] of Object.entries(expected)) {
      if (Number(declared[field]) !== value) {
        throw new Error(`The TRI layout's ${key}.${field} is ${declared[field]}, but the PDF writer stamps ${value} (${LAYOUT_PATH})`);
      }
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
 * Prints the Houseparent's name above the signature rule on page 8.
 *
 * Returns false when there is no name to print. The text is shrunk to the width of
 * the rule so a long name cannot run into the "Administrative Officer" line printed
 * beside it, and it is left-aligned at the same x as the template's own typed names.
 */
function drawHouseparentName(pages, record, font) {
  const page = pages[HOUSEPARENT_NAME_POS.page];
  const name = houseparentNameOf(record);
  if (!page || !name) return false;

  let size = HOUSEPARENT_NAME_POS.size;
  while (size > 4 && font.widthOfTextAtSize(name, size) > HOUSEPARENT_NAME_POS.width) size -= 0.25;

  page.drawText(name, {
    x: HOUSEPARENT_NAME_POS.x,
    y: HOUSEPARENT_NAME_POS.y,
    size,
    font,
    color: rgb(0.08, 0.08, 0.08),
  });
  return true;
}

/**
 * Stamps the Houseparent's drawn signature onto the form's "Houseparent" line.
 *
 * Returns false and leaves the line blank when there is no signature, when it is
 * not a PNG/JPEG data URL, or when it cannot be decoded — an unsigned TRI is still
 * a perfectly valid export, so a bad image must never abort the document.
 */
async function drawHouseparentSignature(pdf, pages, record) {
  const dataUrl = String((record && record.houseparentSignature) || '');
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,/i);
  if (!match) return false;
  const page = pages[HOUSEPARENT_SIGNATURE_BOX.page];
  if (!page) return false;

  try {
    const image = match[1].toLowerCase() === 'png'
      ? await pdf.embedPng(dataUrl)
      : await pdf.embedJpg(dataUrl);
    const box = HOUSEPARENT_SIGNATURE_BOX;
    const scale = Math.min(box.width / image.width, box.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, {
      x: box.x + (box.width - width) / 2,
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

  // The Houseparent's own line is the one the facility asked to have filled in: the
  // printed name goes on first, then the drawn signature is stamped over it. The
  // other four lines (Administrative Officer, SWO I/II/III) stay blank, so this
  // remains a system copy rather than the fully executed instrument.
  //
  // Metadata only beyond that — no overlay text, so nothing can collide with the
  // form's own footer. The "system copy" distinction is carried by the Documents
  // entry title and description, which is where a reader actually looks.
  drawHouseparentName(pages, record, bold);
  const signed = await drawHouseparentSignature(pdf, pages, record);

  pdf.setTitle(`TRI ${periodLabel(record.reportingYear, record.reportingMonth)} - ${residentName || record.residentId}`);
  pdf.setSubject(signed
    ? 'System-generated copy of the Treatment and Rehabilitation Indicator. The Houseparent signature line is signed; the remaining signature lines are blank.'
    : 'System-generated copy of the Treatment and Rehabilitation Indicator. Signature lines are blank; this is not the signed original.');
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
  houseparentNameOf,
};
