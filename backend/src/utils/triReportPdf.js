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
 * NOTE ON SIGNATURES: the official TRI carries five signature lines. For the
 * Houseparent, the Administrative Officer and the SWO I / Case Manager, the E-Signature
 * (drawn or uploaded) is stamped at the top, and the typed name sits below it on the
 * rule, above the printed caption. For MARICOR C. NAVARRO (SWO II / Center Head) and
 * NICOLAS Q. REGALARIO (SWO III / Section Chief), whose names are pre-printed on the
 * form, only the E-Signature is stamped, directly above their printed name. A line
 * nobody has signed is left blank. */

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
 * The "Houseparent" line on the last page (page 8, index 7), in pdf-lib's
 * bottom-left coordinate space. Order, top to bottom: E-Signature, typed name,
 * the printed underscore rule, the caption.
 *
 * Measured against the template: the rule is a run of underscores at x 72.02
 * width 90.24 whose ink sits at y 770.57–772.5, and the line of text above the
 * block has its descenders at y 811.40. The typed name sits on the rule with its
 * baseline at y 775 (an 8pt bold face reaches 783.56 at most), and the signature
 * band fills 784–810 above it.
 *
 * `tri-houseparent-signature.test.js` pins these against the template.
 */
const HOUSEPARENT_SIGNATURE_BOX = { page: 7, x: 72.02, y: 784, width: 90.24, height: 26 };

/** The Houseparent's typed name, on the rule and below the E-Signature. */
const HOUSEPARENT_NAME_POS = { page: 7, x: 72.02, y: 775, size: 8, width: 90.24 };

/**
 * All five signature lines of the page-8 "Assessed by" block. `hasName` marks the
 * three lines whose name is typed in (a text holder); the other two carry a name
 * pre-printed on the form.
 */
const TRI_SIGNATORY_SLOTS = [
  { slot: 'houseparent', title: 'Houseparent', hasName: true },
  { slot: 'administrativeOfficer', title: 'Administrative Officer', hasName: true },
  { slot: 'caseManager', title: 'SWO I / Case Manager', hasName: true },
  { slot: 'centerHead', title: 'SWO II / Center Head', printedName: 'MARICOR C. NAVARRO, RSW, MSSW', hasName: false },
  { slot: 'sectionChief', title: 'SWO III / Section Chief', printedName: 'NICOLAS Q. REGALARIO, RSW, MSSW', hasName: false },
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
  if (!raw.signatories) throw new Error(`The TRI layout is missing "signatories" (${LAYOUT_PATH})`);
  for (const { slot, hasName } of TRI_SIGNATORY_SLOTS) {
    const geometry = raw.signatories[slot];
    const required = hasName
      ? ['page', 'x', 'width', 'signatureY', 'signatureHeight', 'nameY', 'nameSize']
      : ['page', 'x', 'width', 'signatureY', 'signatureHeight'];
    if (!geometry || required.some((field) => !Number.isFinite(Number(geometry[field])))) {
      throw new Error(`The TRI layout's signatories.${slot} is incomplete (${LAYOUT_PATH})`);
    }
  }
  // The Houseparent's slot and the two legacy Houseparent keys must agree.
  const hp = raw.signatories.houseparent;
  if (hp.signatureY !== HOUSEPARENT_SIGNATURE_BOX.y || hp.signatureHeight !== HOUSEPARENT_SIGNATURE_BOX.height
    || hp.nameY !== HOUSEPARENT_NAME_POS.y || hp.x !== HOUSEPARENT_SIGNATURE_BOX.x) {
    throw new Error(`The TRI layout's signatories.houseparent disagrees with the Houseparent signature box (${LAYOUT_PATH})`);
  }
  for (const [key, expected] of [['houseparentSignatureBox', HOUSEPARENT_SIGNATURE_BOX], ['houseparentNamePos', HOUSEPARENT_NAME_POS]]) {
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

/** The record's `signatories` column, as an object. */
function signatoriesOf(record) {
  return asObject(record && record.signatories);
}

/**
 * The name that belongs on the Houseparent line.
 *
 * The name typed into the Houseparent's text holder wins. A record signed before
 * the text holder existed falls back to whoever signed, then whoever submitted,
 * so an older TRI still prints the name it always printed. Returns '' when none
 * is known, which leaves the line blank rather than printing a guess.
 */
function houseparentNameOf(record) {
  const typed = sanitize(signatoriesOf(record).houseparent?.name || '');
  if (typed) return typed;
  return sanitize((record && (record.houseparentSignedBy || record.submittedBy)) || '');
}

/** The typed name for a signature line ('' when the line has no text holder). */
function signatoryNameOf(record, slot) {
  if (slot === 'houseparent') return houseparentNameOf(record);
  const definition = TRI_SIGNATORY_SLOTS.find((entry) => entry.slot === slot);
  if (!definition || !definition.hasName) return '';
  return sanitize(signatoriesOf(record)[slot]?.name || '');
}

/** The E-Signature data URL for a signature line ('' when unsigned). */
function signatorySignatureOf(record, slot) {
  const value = slot === 'houseparent'
    ? record && record.houseparentSignature
    : signatoriesOf(record)[slot]?.signature;
  return String(value || '');
}

/** Draws `text` left-aligned at `x`, shrunk to fit `width`. */
function drawFittedText(page, text, x, y, width, size, font) {
  let fitted = size;
  while (fitted > 4 && font.widthOfTextAtSize(text, fitted) > width) fitted -= 0.25;
  page.drawText(text, { x, y, size: fitted, font, color: rgb(0.08, 0.08, 0.08) });
}

/**
 * Prints the Houseparent's name on the page-8 rule, below the E-Signature.
 *
 * Returns false when there is no name to print. The text is shrunk to the width of
 * the rule so a long name cannot run into the \"Administrative Officer\" line printed
 * beside it.
 */
function drawHouseparentName(pages, record, font) {
  const page = pages[HOUSEPARENT_NAME_POS.page];
  const name = houseparentNameOf(record);
  if (!page || !name) return false;
  drawFittedText(page, name, HOUSEPARENT_NAME_POS.x, HOUSEPARENT_NAME_POS.y, HOUSEPARENT_NAME_POS.width, HOUSEPARENT_NAME_POS.size, font);
  return true;
}

/**
 * Stamps one E-Signature image into `box`, scaled to fit, centred horizontally
 * and resting on the bottom of the band so it sits just above the name / rule.
 *
 * Returns false and leaves the line blank when there is no signature, when it is
 * not a PNG/JPEG data URL, or when it cannot be decoded — an unsigned TRI is still
 * a perfectly valid export, so a bad image must never abort the document.
 */
async function stampSignature(pdf, page, dataUrl, box) {
  const match = String(dataUrl || '').match(/^data:image\/(png|jpeg|jpg);base64,/i);
  if (!match || !page) return false;
  try {
    const image = match[1].toLowerCase() === 'png'
      ? await pdf.embedPng(dataUrl)
      : await pdf.embedJpg(dataUrl);
    const scale = Math.min(box.width / image.width, box.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const anchorWidth = nameWidth != null ? nameWidth : (line.nameInkWidth || box.width);
    page.drawImage(image, {
      x: box.x + (box.width - width) / 2,
      y: box.y,
      width,
      height,
    });
    return true;
  } catch {
    return false;
  }
}

/** Stamps the Houseparent's E-Signature onto the form's \"Houseparent\" line. */
async function drawHouseparentSignature(pdf, pages, record) {
  return stampSignature(pdf, pages[HOUSEPARENT_SIGNATURE_BOX.page], signatorySignatureOf(record, 'houseparent'), HOUSEPARENT_SIGNATURE_BOX);
}

/**
 * Fills the other four signature lines — Administrative Officer, SWO I / Case
 * Manager (E-Signature + typed name), and MARICOR C. NAVARRO / NICOLAS Q. REGALARIO
 * (E-Signature above the pre-printed name).
 *
 * @returns {Promise<number>} how many of the four carry a signature.
 */
async function drawOtherSignatories(pdf, pages, record, layout, font) {
  let signed = 0;
  for (const { slot, hasName } of TRI_SIGNATORY_SLOTS) {
    if (slot === 'houseparent') continue;
    const geometry = layout.signatories[slot];
    const page = pages[geometry.page];
    if (!page) continue;
    if (hasName) {
      const name = signatoryNameOf(record, slot);
      if (name) drawFittedText(page, name, geometry.x, geometry.nameY, geometry.width, geometry.nameSize, font);
    }
    const box = { x: geometry.x, y: geometry.signatureY, width: geometry.width, height: geometry.signatureHeight };
    if (await stampSignature(pdf, page, signatorySignatureOf(record, slot), box)) signed += 1;
  }
  return signed;
}

/** How many of the five signature lines carry an E-Signature. */
function signedLineCount(record) {
  return TRI_SIGNATORY_SLOTS.filter(({ slot }) => /^data:image\/(png|jpeg|jpg);base64,/i.test(signatorySignatureOf(record, slot))).length;
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

  // Every signature line of the page-8 block: E-Signature on top, typed name on
  // the rule below it (Houseparent, Administrative Officer, SWO I / Case Manager),
  // and an E-Signature above each pre-printed name (MARICOR C. NAVARRO, NICOLAS
  // Q. REGALARIO). An unsigned line stays blank.
  drawHouseparentName(pages, record, bold);
  const houseparentSigned = await drawHouseparentSignature(pdf, pages, record);
  const othersSigned = await drawOtherSignatories(pdf, pages, record, layout, bold);
  const signed = (houseparentSigned ? 1 : 0) + othersSigned;
  const total = TRI_SIGNATORY_SLOTS.length;

  pdf.setTitle(`TRI ${periodLabel(record.reportingYear, record.reportingMonth)} - ${residentName || record.residentId}`);
  pdf.setSubject(signed
    ? `System-generated copy of the Treatment and Rehabilitation Indicator. ${signed} of ${total} signature lines are signed${signed < total ? '; the remaining signature lines are blank' : ''}.`
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
  TRI_SIGNATORY_SLOTS,
  houseparentNameOf,
  signatoryNameOf,
  signatorySignatureOf,
  signedLineCount,
};
