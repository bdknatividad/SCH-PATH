/**
 * Anecdotal Report PDF generator.
 * @module utils/anecdotalReportPdf
 * @description Produces the official Anecdotal Report by overlaying the
 * Houseparent's filled-up entries onto the ORIGINAL form.
 *
 * The base document is the real `Anecdotal Report.pdf` — the very file the
 * editor renders in the browser — so the logos, the pre-printed wording, the
 * rules, the fonts and the two-page layout are the genuine article. Only the
 * filled-up values are added on top; nothing of the original is re-created or
 * replaced.
 *
 * This replaced an earlier hand-rolled generator that drew a look-alike form
 * from scratch. That output was a structurally valid PDF, but it was not the
 * official document: no logos, different wording, one page instead of two.
 *
 * Generation lives on the server rather than in the browser so the resident's
 * Documents entry always receives its file, whichever client triggered the
 * accept — a browser-side generator would leave a file-less document for any
 * non-browser caller.
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, PDFName } = require('pdf-lib');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Page geometry of the official form, in points. */
const PDF_WIDTH = 612;
const PDF_HEIGHT = 936;

const BODY_SIZE = 9;
const HEADER_SIZE = 11;
const LINE_STEP = 13.8;
const WRAP_CHARS = 84;

/**
 * Where the official form is looked for, in order. The `public` copy is the
 * canonical one — the editor fetches the same path as `/forms/Anecdotal
 * Report.pdf` — and `dist` is the built copy that ships with the frontend.
 *
 * The backend reads it from the frontend tree because the two are deployed
 * together: `server.js` already serves `frontend/dist` from this same process.
 */
const TEMPLATE_CANDIDATES = [
  path.resolve(__dirname, '../../../frontend/public/forms/Anecdotal Report.pdf'),
  path.resolve(__dirname, '../../../frontend/dist/forms/Anecdotal Report.pdf'),
];

/**
 * Field boxes, measured from the blank lines of the real form with
 * `pdftotext -bbox` — not guessed. `top` is the box's lower edge in PDF
 * coordinates (origin bottom-left) and `height` extends upward.
 *
 * Kept in step with `textFields` in
 * `frontend/src/app/components/AnecdotalReports.tsx`, which positions the
 * on-screen textareas over the same blank lines. The test suite parses that
 * file and fails if the two tables disagree, so the layout cannot drift
 * silently.
 */
const FIELDS = [
  { key: 'physical', page: 0, x: 109, top: 634.6, height: 70 },
  { key: 'emotional', page: 0, x: 109, top: 551.8, height: 70 },
  { key: 'behavioral', page: 0, x: 109, top: 469.0, height: 70 },
  { key: 'education', page: 0, x: 109, top: 386.2, height: 70 },
  { key: 'spiritual', page: 0, x: 109, top: 303.3, height: 70 },
  { key: 'productivity', page: 0, x: 109, top: 220.5, height: 70 },
  { key: 'coPeers', page: 0, x: 109, top: 179.7, height: 28 },
  { key: 'staff', page: 1, x: 109, top: 697.0, height: 70 },
  { key: 'groupLiving', page: 1, x: 109, top: 614.2, height: 70 },
  { key: 'recommendations', page: 1, x: 109, top: 531.4, height: 70 },
];

/**
 * Characters the base-14 fonts can represent. They are single-byte encoded, so
 * anything above U+00FF would either throw inside pdf-lib or be mangled.
 * Typographic punctuation is folded to ASCII; Latin-1 accents (ñ, é, …) are
 * kept because the fonts are declared with /WinAnsiEncoding.
 */
const CHAR_FALLBACKS = {
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-',
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u2020': '+', '\u2022': '*', '\u2026': '...', '\u00A0': ' ', '\u00AD': '-',
};

function sanitize(value) {
  return String(value ?? '')
    .replace(/[\u2010-\u201F\u2020-\u2022\u2026\u00A0\u00AD]/g, (ch) => CHAR_FALLBACKS[ch] ?? '?')
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, '?');
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

let cachedTemplateBytes = null;

/**
 * Reads the official form once and keeps it in memory — it is ~158 KB and does
 * not change while the process runs.
 * @returns {Buffer}
 * @throws {Error} when no candidate path holds a readable PDF.
 */
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
    `The official Anecdotal Report template could not be read. Looked in: ${TEMPLATE_CANDIDATES.join(', ')}`
  );
}

/** The template path that will actually be used, for the boot-time log. */
function resolveTemplatePath() {
  for (const candidate of TEMPLATE_CANDIDATES) {
    try {
      if (fs.readFileSync(candidate).subarray(0, 5).toString('ascii') === '%PDF-') return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** Drops the memoised template — used by tests that swap the file on disk. */
function clearTemplateCache() {
  cachedTemplateBytes = null;
  cachedTemplateGeometry = null;
}

let cachedTemplateGeometry = null;

/**
 * Page sizes of the official form, read once.
 * @returns {Promise<{width: number, height: number}[]>}
 */
async function templateGeometry() {
  if (!cachedTemplateGeometry) {
    const pdf = await PDFDocument.load(loadTemplateBytes());
    cachedTemplateGeometry = pdf.getPages().map((page) => {
      const box = page.getMediaBox();
      return { width: box.width, height: box.height };
    });
  }
  return cachedTemplateGeometry;
}

/**
 * Whether `buffer` is the official form with the entries overlaid on it.
 *
 * Page count and page size act as the form's fingerprint. This is what lets a
 * stored document be recognised as stale: the look-alike produced by the
 * previous generator was a single US-Letter (612x792) page, while the real form
 * is two 612.2x936.2 pages. Any stored payload that does not match is
 * regenerated from its report on read.
 *
 * @param {Buffer} buffer
 * @returns {Promise<boolean>}
 */
async function isOfficialAnecdotalPdf(buffer) {
  try {
    const expected = await templateGeometry();
    const pdf = await PDFDocument.load(buffer);
    const pages = pdf.getPages();
    if (pages.length !== expected.length) return false;
    return pages.every((page, index) => {
      const box = page.getMediaBox();
      return Math.abs(box.width - expected[index].width) < 0.5
        && Math.abs(box.height - expected[index].height) < 0.5;
    });
  } catch {
    return false;
  }
}

/**
 * How many lines fit inside a field box.
 *
 * Row `i` is drawn with its baseline at `top + height - 9 - i * LINE_STEP`, and
 * must stay clear of the box's lower edge with room for descenders. The 70pt
 * boxes take five rows; the 28pt co-peers box takes two — drawing a fixed five
 * there (as the browser export used to) ran the text straight through the
 * pre-printed rule below it.
 *
 * @param {number} height Box height in points.
 * @returns {number}
 */
function maxLinesFor(height) {
  return Math.max(1, Math.floor((height - 11) / LINE_STEP) + 1);
}

/**
 * Wraps an entry to `maxChars` per line. Paragraph breaks the author typed are
 * honoured, but blank lines are dropped so they do not consume a box row.
 * @param {string} value
 * @param {number} [maxChars]
 * @returns {string[]}
 */
function wrapText(value, maxChars = WRAP_CHARS) {
  const lines = [];
  for (const paragraph of String(value ?? '').split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let line = '';
    for (const word of words) {
      if (!line) {
        line = word;
      } else if (line.length + 1 + word.length <= maxChars) {
        line += ` ${word}`;
      } else {
        lines.push(line);
        line = word;
      }
      while (line.length > maxChars) {
        lines.push(line.slice(0, maxChars));
        line = line.slice(maxChars);
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * `MM/DD/YYYY`, the format the form's date line uses.
 *
 * Handles both shapes the column arrives in: the pool runs with
 * `dateStrings: true`, so a DATE comes back as `YYYY-MM-DD`, but a caller that
 * has already built a Date (or a full timestamp) is formatted from its local
 * parts — `toISOString()` would shift a Manila-midnight date back a day.
 *
 * @param {string|Date} value
 * @returns {string}
 */
function formatReportDate(value) {
  if (!value) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${month}/${day}/${value.getFullYear()}`;
  }
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return String(value);
  return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
}

/** e.g. `September 2026`, falling back to the raw month number. */
function monthLabel(year, month) {
  const name = MONTH_NAMES[Number(month) - 1];
  return `${name || month} ${year ?? ''}`.trim();
}

/** e.g. `Anecdotal Report - September 2026.pdf`. */
function anecdotalReportFileName(report = {}) {
  const label = monthLabel(report.reportYear, report.reportMonth);
  return `Anecdotal Report - ${label}.pdf`.replace(/[\\/:*?"<>|]/g, '-');
}

/**
 * The blank band on page 2 of the official form reserved for the Houseparent's
 * signature: below the "Assessed by:" label (which ends at y = 444) and above
 * the line their printed name sits on (y = 473.6), in top-left coordinates.
 *
 * Kept in step with `HOUSEPARENT_SIGNATURE_BOX` in
 * `frontend/src/app/components/AnecdotalReports.tsx`, which positions the
 * on-screen pad over the same band — the test suite parses both and fails if
 * they disagree, so a signature cannot land somewhere it was not drawn.
 */
const HOUSEPARENT_SIGNATURE_BOX = { x: 58, top: 446, width: 220, height: 26 };

/**
 * Stamps a drawn signature into `box` (top-left coordinates), scaled to fit and
 * centred.
 *
 * A missing or unusable value is skipped rather than thrown: one unsigned
 * report must not stop the rest of the document being produced.
 */
async function drawSignature(pdf, page, dataUrl, box) {
  const value = String(dataUrl || '');
  const match = value.match(/^data:image\/(png|jpeg|jpg);base64,/i);
  if (!match || !box) return false;

  try {
    const image = match[1].toLowerCase() === 'png'
      ? await pdf.embedPng(value)
      : await pdf.embedJpg(value);

    const fit = Math.min(box.width / image.width, box.height / image.height);
    const drawWidth = image.width * fit;
    const drawHeight = image.height * fit;

    page.drawImage(image, {
      x: box.x + (box.width - drawWidth) / 2,
      y: PDF_HEIGHT - box.top - drawHeight - (box.height - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Overlays the filled-up entries onto the official form.
 *
 * @param {Object} report
 * @param {string} [report.childName]       Resident's full name.
 * @param {string} [report.reportDate]      Reporting date.
 * @param {string} [report.room]            Room / cottage.
 * @param {string} [report.monthLabel]      e.g. "September 2026".
 * @param {string} [report.houseparentName] Houseparent who assessed the child.
 * @param {string} [report.houseparentSignature] Their drawn signature, as a PNG data URL.
 * @param {Object|string} [report.content]  The filled-up entries, keyed by field.
 * @returns {Promise<Buffer>} PDF bytes, starting with `%PDF-`.
 */
async function buildAnecdotalReportPdf(report = {}) {
  const content = asObject(report.content);
  const pdf = await PDFDocument.load(loadTemplateBytes());
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();

  // The template carries a hidden Square annotation covering the "Name of
  // Client" and "Houseparent Assessed By" lines. Annotations paint on top of
  // page content, so it silently hid any text drawn there. Drop it on both
  // pages — without this the name never shows, even though it is in the stream.
  for (const page of pages) page.node.delete(PDFName.of('Annots'));

  const draw = (page, value, x, y, size = BODY_SIZE, useFont = font) => {
    const text = sanitize(value);
    if (!text) return;
    page.drawText(text, { x, y, size, font: useFont, color: rgb(0, 0, 0) });
  };

  // Masks the pre-printed label/rule under a line before the value is written.
  const whiteOut = (page, x, yTop, width, height) => {
    page.drawRectangle({
      x: x - 2,
      y: PDF_HEIGHT - yTop - height,
      width: width + 4,
      height: height + 3,
      color: rgb(1, 1, 1),
    });
  };

  // ── Page 1 — identity lines
  if (pages[0]) {
    whiteOut(pages[0], 160, 149.6, 165, 15);
    draw(pages[0], report.childName, 163, 776.4, HEADER_SIZE, bold);
    draw(pages[0], formatReportDate(report.reportDate), 456, 776.4, HEADER_SIZE, font);
    draw(pages[0], report.room, 113, 762.6, HEADER_SIZE, font);
    draw(pages[0], report.monthLabel, 466, 762.6, HEADER_SIZE, font);
  }

  // ── Observation areas
  for (const field of FIELDS) {
    const page = pages[field.page];
    if (!page) continue;
    const lines = wrapText(content[field.key]);
    const maxLines = maxLinesFor(field.height);
    const visible = lines.slice(0, maxLines);
    // Make truncation visible rather than letting an entry vanish silently.
    if (lines.length > maxLines) {
      visible[visible.length - 1] = `${visible[visible.length - 1].slice(0, WRAP_CHARS - 3)}...`;
    }
    const startY = field.top + field.height - 9;
    visible.forEach((line, index) => draw(page, line, field.x, startY - index * LINE_STEP));
  }

  // ── Page 2 — who assessed the child
  if (pages[1]) {
    whiteOut(pages[1], 55, 473.6, 220, 15);
    draw(pages[1], report.houseparentName, 58, 452.4, HEADER_SIZE, bold);
    await drawSignature(pdf, pages[1], report.houseparentSignature, HOUSEPARENT_SIGNATURE_BOX);
  }

  return Buffer.from(await pdf.save());
}

/**
 * Builds the PDF for an `anecdotalReports` row, ready to be stored on the
 * matching `documents` entry.
 *
 * This is the single entry point shared by the publisher
 * (`anecdotalReportController.syncDocumentForReport`), the on-demand download
 * (`anecdotalReportController.getPdf`) and the reader-side repair
 * (`documentController.getFile`), so a report published before the template
 * existed is rebuilt exactly the same way as a freshly accepted one.
 *
 * @param {Object} report       Row from `anecdotalReports` (or equivalent).
 * @param {string} [childName]  Resident's name, joined from `children`.
 * @returns {Promise<{ buffer: Buffer, fileName: string, fileSize: number }>}
 */
async function buildAnecdotalReportDocument(report = {}, childName) {
  const buffer = await buildAnecdotalReportPdf({
    childName,
    reportDate: report.reportDate,
    room: report.room,
    monthLabel: monthLabel(report.reportYear, report.reportMonth),
    houseparentName: report.houseparentName,
    houseparentSignature: report.houseparentSignature,
    content: report.content,
  });
  return { buffer, fileName: anecdotalReportFileName(report), fileSize: buffer.length };
}

module.exports = {
  buildAnecdotalReportPdf,
  buildAnecdotalReportDocument,
  anecdotalReportFileName,
  formatReportDate,
  monthLabel,
  wrapText,
  maxLinesFor,
  isOfficialAnecdotalPdf,
  loadTemplateBytes,
  resolveTemplatePath,
  clearTemplateCache,
  FIELDS,
  HOUSEPARENT_SIGNATURE_BOX,
  PDF_WIDTH,
  PDF_HEIGHT,
  WRAP_CHARS,
  MONTH_NAMES,
};
