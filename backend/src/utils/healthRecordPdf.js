/**
 * Health Record PDF generator.
 * @module utils/healthRecordPdf
 * @description Builds the resident's Health Record — a branded, print-ready A4
 * document assembled from the recorded row and the resident's own details.
 *
 * There is no pre-printed template to overlay here. The official forms the
 * facility uses (Form 11-A, 11-B, 11-C) are download-only references, so the
 * layout is designed here in the same visual language as the Quarterly Progress
 * Report: the brand masthead, a section bar per block, label/value pairs sitting
 * on a printed rule, and a footer on every page.
 *
 * Generation lives on the server for the same reason it does for the TRI, the
 * Anecdotal Report and the QPR: the record is saved from the Health module, and
 * the resident's Documents entry must receive its file whichever client — or
 * which API call — triggered the save. A browser-side generator would leave a
 * file-less Documents entry for any client that did not happen to have the form
 * on screen.
 *
 * The six record types are the ones `healthController.validateHealthRecord`
 * accepts; each one draws its own block. Every field is read defensively: a
 * record saved before a column existed still renders, with the missing value
 * shown as an em dash rather than omitted.
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { wrapToWidth } = require('./quarterlyReportPdf');

// ── Page geometry (A4 portrait, in points) ──
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 45;
const MARGIN_TOP = 48;
const MARGIN_BOTTOM = 52;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

// ── Layout metrics ──
const MASTHEAD_BAND_HEIGHT = 74;
const MASTHEAD_BAND_LIFT = 22;
const MASTHEAD_TAIL = 22;
const SECTION_HEADING_HEIGHT = 16;
const FIELD_ROW_HEIGHT = 25;
const FIELD_TAIL = 10;
const TABLE_HEADER_HEIGHT = 26;
const SIGNATURE_BOX_HEIGHT = 34;
const SIGNATURE_TAIL = 30;

// ── Type scale ──
const BODY_SIZE = 9;
const SMALL_SIZE = 7.5;
const MICRO_SIZE = 6.5;
const HEADING_SIZE = 11;
const TITLE_SIZE = 16;
const SUBTITLE_SIZE = 10;
const LINE_STEP = 11.6;
const CELL_PAD = 5;

// ── Brand palette (matches the application shell) ──
const BRAND = rgb(0.1843, 0.2431, 0.2745); // #2F3E46
const ACCENT = rgb(1, 0.8196, 0); // #FFD100
const INK = rgb(0.13, 0.16, 0.18);
const MUTED = rgb(0.42, 0.45, 0.47);
const RULE = rgb(0.78, 0.81, 0.83);
const HEAD_FILL = rgb(0.9255, 0.9373, 0.9412);
const ZEBRA = rgb(0.9725, 0.9765, 0.9804);
const WHITE = rgb(1, 1, 1);

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

/**
 * The six record types, with the label each one prints under. This mirrors the
 * `FORM_OPTIONS` list in `frontend/src/app/components/Health.tsx` and the type
 * list in `healthController.validateHealthRecord`; a test asserts all three
 * agree, so a type cannot be accepted by the API and then render untitled.
 */
const RECORD_TYPE_LABELS = {
  'Medical Record': { code: 'Form 11-B', label: 'Health / Medical Record' },
  'Dental Services': { code: 'Form 11-C', label: 'Dental Services' },
  'Height & Weight Monitoring': { code: 'Form 11-A', label: 'Height and Weight Monitoring' },
  'Health Assessment': { code: 'Form 11-D', label: 'Health Assessment' },
  'Medication Log': { code: 'Form 11-E', label: 'Medication Log' },
  'Medical Treatment': { code: 'Form 11-F', label: 'Medical Treatment' },
};

// ── Text helpers ──

/**
 * Characters the base-14 fonts can represent. They are single-byte encoded, so
 * anything above U+00FF would either throw inside pdf-lib or be mangled.
 * Typographic punctuation is folded to ASCII; Latin-1 accents (ñ, é, …) are kept
 * because the fonts are declared with /WinAnsiEncoding.
 *
 * Kept identical to the copy in `quarterlyReportPdf.js` on purpose: a value is
 * wrapped there and drawn here, and the two must fold it the same way.
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

function text(value) {
  return sanitize(String(value ?? '').trim());
}

/** `details` arrives as an object from the model layer, but may be a JSON string. */
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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** A value for display, with a placeholder so a blank field is visibly blank. */
function display(value) {
  const rendered = text(value);
  return rendered || '\u2014';
}

/** `YYYY-MM-DD` read as text, never through `Date` — see quarterlyReportPdf. */
function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  if (!match) return text(value);
  const month = MONTH_NAMES[Number(match[2]) - 1];
  if (!month) return text(value);
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

/** e.g. `Health Record - Medication Log - Juan Dela Cruz - 2026-09-22.pdf` */
function healthRecordFileName(record = {}, residentName) {
  const name = residentName || record.residentName || record.residentId || 'Resident';
  const type = record.recordType || 'Health Record';
  const date = /^\d{4}-\d{2}-\d{2}/.test(String(record.date || '')) ? String(record.date).slice(0, 10) : '';
  return `Health Record - ${type} - ${name}${date ? ` - ${date}` : ''}.pdf`
    .replace(/[\\/:*?"<>|]/g, '-');
}

/**
 * The Documents entry's title. The record type alone is not enough — a resident
 * accumulates many medication logs — so the date is part of it.
 */
function healthRecordTitle(record = {}) {
  const type = text(record.recordType) || 'Health Record';
  const date = /^\d{4}-\d{2}-\d{2}/.test(String(record.date || '')) ? String(record.date).slice(0, 10) : '';
  return date ? `${type} - ${date}` : type;
}

// ── Drawing helpers ──

/**
 * The logo is read from the frontend tree because the two are deployed
 * together: `server.js` already serves `frontend/dist` from this same process.
 * A missing logo degrades to a text-only header rather than failing the build.
 */
const LOGO_CANDIDATES = [
  path.resolve(__dirname, '../../../frontend/src/assets/sch-logo.png'),
  path.resolve(__dirname, '../../../frontend/public/sch-logo.png'),
  path.resolve(__dirname, '../../../frontend/dist/assets/sch-logo.png'),
];

let cachedLogoBytes;
let logoLoaded = false;

function loadLogoBytes() {
  if (logoLoaded) return cachedLogoBytes;
  logoLoaded = true;
  for (const candidate of LOGO_CANDIDATES) {
    try {
      const bytes = fs.readFileSync(candidate);
      if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
        cachedLogoBytes = bytes;
        return cachedLogoBytes;
      }
    } catch {
      // Try the next location.
    }
  }
  return null;
}

/** Test seam: forget the cached logo so a re-read can be observed. */
function clearLogoCache() {
  cachedLogoBytes = undefined;
  logoLoaded = false;
}

/** Draws `lines` downward from `topY`, returning the y after the last line. */
function drawLines(page, lines, { x, topY, font, size, color, step = LINE_STEP }) {
  let y = topY;
  for (const line of lines) {
    page.drawText(line, { x, y, size, font, color });
    y -= step;
  }
  return y;
}

/**
 * Embeds a drawn signature inside `box` (pdf-lib's bottom-left coordinates),
 * scaled to fit without distortion and centred.
 *
 * A missing or unusable value is skipped rather than thrown: one unsigned field
 * must not stop the record being filed.
 */
async function drawSignatureImage(pdfDoc, page, dataUrl, box) {
  const value = String(dataUrl || '');
  const match = value.match(/^data:image\/(png|jpeg|jpg);base64,/i);
  if (!match) return false;

  try {
    const image = match[1].toLowerCase() === 'png'
      ? await pdfDoc.embedPng(value)
      : await pdfDoc.embedJpg(value);

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

/** Draws a filled section heading bar and returns the y below it. */
function drawSectionHeading(page, y, title, font) {
  page.drawRectangle({ x: MARGIN_X, y: y - 4, width: 3.5, height: 13, color: ACCENT });
  page.drawText(text(title), { x: MARGIN_X + 9, y, size: HEADING_SIZE, font, color: BRAND });
  return y - SECTION_HEADING_HEIGHT;
}

/** The branded masthead. Drawn once, on page 1. */
async function drawMasthead(pdfDoc, page, fonts, record, person) {
  const bandHeight = MASTHEAD_BAND_HEIGHT;
  const bandTop = PAGE_HEIGHT - MARGIN_TOP + MASTHEAD_BAND_LIFT;

  page.drawRectangle({
    x: 0,
    y: bandTop - bandHeight,
    width: PAGE_WIDTH,
    height: bandHeight,
    color: BRAND,
  });
  page.drawRectangle({ x: 0, y: bandTop - bandHeight, width: PAGE_WIDTH, height: 4, color: ACCENT });

  let textX = MARGIN_X;
  const logo = loadLogoBytes();
  if (logo) {
    try {
      const image = await pdfDoc.embedPng(logo);
      const size = 46;
      const scale = Math.min(size / image.width, size / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      page.drawRectangle({
        x: MARGIN_X,
        y: bandTop - bandHeight / 2 - 24,
        width: size,
        height: size,
        color: WHITE,
      });
      page.drawImage(image, {
        x: MARGIN_X + (size - width) / 2,
        y: bandTop - bandHeight / 2 - 24 + (size - height) / 2,
        width,
        height,
      });
      textX = MARGIN_X + size + 12;
    } catch {
      // Fall through to the text-only header.
    }
  }

  const meta = RECORD_TYPE_LABELS[record.recordType] || {};
  const titleY = bandTop - 30;
  page.drawText('SECOND CHANCE HOME', {
    x: textX, y: titleY, size: TITLE_SIZE, font: fonts.bold, color: WHITE,
  });
  page.drawText(text((meta.label || record.recordType || 'Health Record').toUpperCase()), {
    x: textX, y: titleY - 15, size: SUBTITLE_SIZE, font: fonts.regular, color: ACCENT,
  });

  const codeLine = [meta.code, record.date ? `Record date: ${formatDate(record.date)}` : '']
    .filter(Boolean)
    .join('  \u00B7  ');
  if (codeLine) {
    page.drawText(text(codeLine), {
      x: textX, y: titleY - 29, size: SMALL_SIZE, font: fonts.regular, color: rgb(0.82, 0.85, 0.86),
    });
  }

  const resident = text(person.name);
  if (resident) {
    const label = `Resident: ${resident}`;
    const width = fonts.bold.widthOfTextAtSize(label, SMALL_SIZE);
    page.drawText(label, {
      x: PAGE_WIDTH - MARGIN_X - width, y: titleY - 29, size: SMALL_SIZE, font: fonts.bold, color: WHITE,
    });
  }

  return bandTop - bandHeight - MASTHEAD_TAIL;
}

/**
 * A grid of label/value pairs, each value sitting on a printed rule — the same
 * block the Quarterly Progress Report uses for its identifying information.
 *
 * A value is truncated to its first wrapped line: this is a form, not a
 * narrative, and a field that grew to three lines would push the rest of the
 * page out of alignment with the printed rule beneath it.
 */
function drawFieldGrid(page, y, fields, fonts, { columns = 2, rowHeight = FIELD_ROW_HEIGHT } = {}) {
  const columnWidth = CONTENT_WIDTH / columns;
  const valueOffset = 11;

  for (let index = 0; index < fields.length; index += columns) {
    for (let column = 0; column < columns; column += 1) {
      const field = fields[index + column];
      if (!field) continue;

      const x = MARGIN_X + column * columnWidth;
      const available = columnWidth - 14;

      page.drawText(text(field.label), {
        x, y, size: SMALL_SIZE, font: fonts.bold, color: MUTED,
      });

      const lines = wrapToWidth(field.value, fonts.regular, BODY_SIZE, available);
      const value = lines.length ? lines[0] : '\u2014';
      page.drawText(value, { x, y: y - valueOffset, size: BODY_SIZE, font: fonts.regular, color: INK });
      page.drawLine({
        start: { x, y: y - valueOffset - 3 },
        end: { x: x + available, y: y - valueOffset - 3 },
        thickness: 0.5,
        color: RULE,
      });
    }
    y -= rowHeight;
  }

  return y - FIELD_TAIL;
}

/**
 * A table with a filled header row. `columns` is `{ label, width, align }` and
 * the widths must sum to `CONTENT_WIDTH`. Rows are `string[]`, one cell each.
 */
function drawTable(page, y, columns, rows, fonts, { zebra = true } = {}) {
  const headerHeight = TABLE_HEADER_HEIGHT;
  page.drawRectangle({
    x: MARGIN_X, y: y - headerHeight, width: CONTENT_WIDTH, height: headerHeight, color: HEAD_FILL,
  });

  let x = MARGIN_X;
  for (const column of columns) {
    const lines = wrapToWidth(column.label, fonts.bold, SMALL_SIZE, column.width - CELL_PAD * 2);
    drawLines(page, lines, {
      x: x + CELL_PAD,
      topY: y - CELL_PAD - SMALL_SIZE,
      font: fonts.bold,
      size: SMALL_SIZE,
      color: BRAND,
      step: SMALL_SIZE + 1.5,
    });
    x += column.width;
  }
  y -= headerHeight;

  rows.forEach((row, rowIndex) => {
    // A cell is wrapped rather than clipped, so a long finding grows its row
    // instead of running through the column beside it.
    const wrapped = columns.map((column, cellIndex) => wrapToWidth(
      row[cellIndex],
      fonts.regular,
      MICRO_SIZE,
      column.width - CELL_PAD * 2,
    ));
    const lineCount = Math.max(1, ...wrapped.map((lines) => lines.length));
    const height = lineCount * (MICRO_SIZE + 2) + CELL_PAD * 2;

    if (zebra && rowIndex % 2 === 1) {
      page.drawRectangle({ x: MARGIN_X, y: y - height, width: CONTENT_WIDTH, height, color: ZEBRA });
    }

    let cellX = MARGIN_X;
    columns.forEach((column, cellIndex) => {
      const lines = wrapped[cellIndex];
      drawLines(page, lines.length ? lines : ['\u2014'], {
        x: cellX + CELL_PAD,
        topY: y - CELL_PAD - MICRO_SIZE,
        font: fonts.regular,
        size: MICRO_SIZE,
        color: INK,
        step: MICRO_SIZE + 2,
      });
      cellX += column.width;
    });

    y -= height;
    page.drawLine({
      start: { x: MARGIN_X, y },
      end: { x: MARGIN_X + CONTENT_WIDTH, y },
      thickness: 0.5,
      color: RULE,
    });
  });

  return y - TABLE_TAIL;
}

/** A full-width narrative block: a heading and the wrapped body under it. */
function drawNarrative(page, y, heading, body, fonts) {
  const lines = wrapToWidth(body, fonts.regular, BODY_SIZE, CONTENT_WIDTH);
  if (!lines.length) return y;

  page.drawText(text(heading), { x: MARGIN_X, y, size: SMALL_SIZE, font: fonts.bold, color: MUTED });
  y -= 13;
  y = drawLines(page, lines, {
    x: MARGIN_X, topY: y, font: fonts.regular, size: BODY_SIZE, color: INK,
  });
  return y - 6;
}

/**
 * The gap a block leaves behind it. The table is the densest thing on the page,
 * so it needs more than a narrative does — a section heading printed straight
 * under the last row reads as part of the table.
 */
const TABLE_TAIL = 20;

function drawFooters(pdfDoc, fonts, record, person) {
  const pages = pdfDoc.getPages();
  const label = [person.name || 'Resident', record.recordType, record.date ? formatDate(record.date) : '']
    .filter(Boolean)
    .join('  \u00B7  ');

  pages.forEach((page, index) => {
    const y = MARGIN_BOTTOM - 24;
    page.drawLine({
      start: { x: MARGIN_X, y: y + 12 },
      end: { x: MARGIN_X + CONTENT_WIDTH, y: y + 12 },
      thickness: 0.5,
      color: RULE,
    });
    page.drawText(text(`SCH-PATH \u00B7 Health Record \u00B7 ${label}`), {
      x: MARGIN_X, y, size: SMALL_SIZE, font: fonts.regular, color: MUTED,
    });
    const pageLabel = `Page ${index + 1} of ${pages.length}`;
    const width = fonts.regular.widthOfTextAtSize(pageLabel, SMALL_SIZE);
    page.drawText(pageLabel, {
      x: PAGE_WIDTH - MARGIN_X - width, y, size: SMALL_SIZE, font: fonts.regular, color: MUTED,
    });
  });
}

// ── The record body, one block per record type ──

/**
 * BMI and the weight classification, matching the Health module exactly:
 * BMI = kg / m²; healthy band BMI 18.5–24.9; up to 6% over the top of the
 * healthy weight range is "Above Healthy"; beyond that Overweight below BMI 30,
 * Obese from 30. Heights of 3 or less are read as metres, larger as centimetres.
 */
function measurementValue(value) {
  const parsed = Number.parseFloat(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN;
}
function bmiOf(entry) {
  const raw = measurementValue(entry?.height);
  const kg = measurementValue(entry?.weight);
  if (Number.isNaN(raw) || Number.isNaN(kg)) return null;
  const metres = raw > 3 ? raw / 100 : raw;
  const bmi = kg / (metres * metres);
  return Number.isFinite(bmi) && bmi > 0 ? { bmi, kg, metres } : null;
}
function weightClassOf(entry) {
  const result = bmiOf(entry);
  if (!result) return '';
  const healthyMax = 24.9 * result.metres * result.metres;
  if (result.bmi < 18.5) return 'Under';
  if (result.kg <= healthyMax) return 'Healthy';
  if (result.kg <= healthyMax * 1.06) return 'Above';
  if (result.bmi < 30) return 'Overwt';
  return 'Obese';
}

/** The 12-column Height and Weight grid, drawn as the form lays it out. */
function drawMonthlyMeasurements(page, y, details, fonts) {
  const measurements = asArray(details.monthlyMeasurements);
  const monthWidth = 45;
  const cellWidth = (CONTENT_WIDTH - monthWidth) / 12;
  const rowHeight = 18;

  page.drawRectangle({
    x: MARGIN_X, y: y - rowHeight, width: CONTENT_WIDTH, height: rowHeight, color: HEAD_FILL,
  });
  page.drawText('Month', { x: MARGIN_X + CELL_PAD, y: y - 12, size: MICRO_SIZE, font: fonts.bold, color: BRAND });
  MONTH_NAMES.forEach((month, index) => {
    page.drawText(month, {
      x: MARGIN_X + monthWidth + index * cellWidth + 2,
      y: y - 12,
      size: MICRO_SIZE,
      font: fonts.bold,
      color: BRAND,
    });
  });
  y -= rowHeight;

  // Height and Weight as recorded, then BMI and the classification computed
  // from them (never stored, so a corrected measurement corrects both).
  const derived = {
    bmi: (entry) => { const r = bmiOf(entry); return r ? r.bmi.toFixed(1) : ''; },
    class: (entry) => weightClassOf(entry),
  };
  for (const [label, key] of [['Height', 'height'], ['Weight', 'weight'], ['BMI', 'bmi'], ['Class', 'class']]) {
    page.drawText(label, { x: MARGIN_X + CELL_PAD, y: y - 12, size: MICRO_SIZE, font: fonts.bold, color: MUTED });
    for (let index = 0; index < 12; index += 1) {
      const entry = measurements.find((row) => Number(row?.month) === index + 1) || {};
      const value = derived[key] ? derived[key](entry) : text(entry[key]);
      if (value) {
        page.drawText(value, {
          x: MARGIN_X + monthWidth + index * cellWidth + 2,
          y: y - 12,
          size: MICRO_SIZE,
          font: fonts.regular,
          color: INK,
        });
      }
      page.drawLine({
        start: { x: MARGIN_X + monthWidth + index * cellWidth, y: y - rowHeight },
        end: { x: MARGIN_X + monthWidth + (index + 1) * cellWidth, y: y - rowHeight },
        thickness: 0.5,
        color: RULE,
      });
    }
    y -= rowHeight;
    page.drawLine({
      start: { x: MARGIN_X, y },
      end: { x: MARGIN_X + CONTENT_WIDTH, y },
      thickness: 0.5,
      color: RULE,
    });
  }

  return y - FIELD_TAIL - 8;
}

/** The dentist's service checklist, rendered as the checked items it holds. */
function dentalServiceSummary(details) {
  const services = asObject(details.dentalServices);
  const entries = [
    ['Extraction', 'extraction', 'extractionNumber'],
    ['Prophylaxis', 'prophylaxis', null],
    ['Denture', 'denture', 'dentureNumber'],
    ['Tooth filling (cavity)', 'toothFilling', 'toothFillingNumber'],
    ['Brace', 'brace', null],
  ];
  const rendered = entries
    .filter(([, key]) => services[key])
    .map(([label, key, numberKey]) => {
      const count = numberKey ? text(services[numberKey]) : '';
      return count ? `${label} (${count})` : label;
    });
  return rendered.length ? rendered.join(', ') : '';
}

/**
 * Builds the complete Health Record.
 *
 * @param {Object} record             A `healthRecords` row.
 * @param {Object|string} [resident]  The joined `children` row, or just the name.
 * @returns {Promise<Buffer>}
 */
async function buildHealthRecordPdf(record = {}, resident = {}) {
  const person = typeof resident === 'string' ? { name: resident } : (resident || {});
  if (!person.name) person.name = record.residentName || record.residentId || '';
  const details = asObject(record.details);
  const meta = RECORD_TYPE_LABELS[record.recordType] || {};

  const pdfDoc = await PDFDocument.create();
  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  pdfDoc.setTitle(`${meta.label || record.recordType || 'Health Record'} - ${person.name || 'Resident'}`);
  pdfDoc.setAuthor('Second Chance Home');
  pdfDoc.setSubject(meta.label || 'Health Record');
  pdfDoc.setCreator('SCH-PATH');

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = await drawMasthead(pdfDoc, page, fonts, record, person);

  /** Starts a plain continuation page when `needed` points would not fit. */
  const ensureSpace = (needed) => {
    if (y - needed >= MARGIN_BOTTOM) return;
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN_TOP;
  };

  y = drawSectionHeading(page, y, 'IDENTIFYING INFORMATION', fonts.bold);
  y = drawFieldGrid(page, y, [
    { label: 'Name of the Child', value: person.name || record.residentName },
    { label: 'Record Type', value: record.recordType },
    { label: 'Age', value: person.age },
    { label: 'Sex', value: person.gender },
    { label: 'Date of Birth', value: person.birthDate ? formatDate(person.birthDate) : '' },
    { label: 'Date of Admission', value: person.admissionDate ? formatDate(person.admissionDate) : '' },
    { label: 'Case Phase', value: person.casePhase },
    { label: 'Date of Record', value: record.date ? formatDate(record.date) : '' },
    { label: 'Recorded By', value: record.recordedBy },
    { label: 'Status', value: record.status },
  ], fonts);

  y = drawSectionHeading(page, y, text((meta.label || record.recordType || 'HEALTH RECORD').toUpperCase()), fonts.bold);

  if (record.recordType === 'Medical Record') {
    const rows = asArray(details.medicalRows).filter((row) => row && Object.values(row).some((value) => String(value || '').trim()));
    ensureSpace(TABLE_HEADER_HEIGHT + 40);
    y = drawTable(page, y, [
      { label: 'Date', width: 56 },
      { label: 'Medical Findings', width: 92 },
      { label: 'Laboratory Procedure', width: 80 },
      { label: 'Laboratory Results', width: 80 },
      { label: 'Prescription', width: 80 },
      { label: 'Care Provider', width: 70 },
      { label: "Doctor's Signature", width: CONTENT_WIDTH - 56 - 92 - 80 - 80 - 80 - 70 },
    ], rows.map((row) => [
      row.date ? formatDate(row.date) : '',
      row.findings,
      row.laboratoryProcedure,
      row.laboratoryResultFileName || '',
      row.prescription,
      row.careProvider,
      row.doctorSignature ? '(signed)' : '',
    ]), fonts);

    // These are the record-level values the older single-row shape wrote. They
    // are printed only when the table is empty: a record that carries both would
    // otherwise print the same findings twice, and the table is the richer of
    // the two.
    if (rows.length === 0) {
      y = drawNarrative(page, y, 'Medical Findings', details.medicalFindings, fonts);
      y = drawNarrative(page, y, 'Laboratory Procedure', details.laboratoryProcedure, fonts);
      y = drawNarrative(page, y, 'Prescription', details.prescription, fonts);
      y = drawNarrative(page, y, 'Care Provider', details.careProvider, fonts);
    }
  }

  if (record.recordType === 'Dental Services') {
    y = drawFieldGrid(page, y, [
      { label: 'Date', value: record.date ? formatDate(record.date) : '' },
      { label: 'Referred By', value: details.referredBy },
      { label: "Dentist's Service", value: dentalServiceSummary(details) },
      { label: 'Recorded By', value: record.recordedBy },
    ], fonts);
    y = drawNarrative(page, y, 'Chief Complaint(s)', details.chiefComplaints, fonts);
    y = drawNarrative(page, y, 'Remarks', details.dentalRemarks, fonts);
  }

  if (record.recordType === 'Height & Weight Monitoring') {
    y = drawFieldGrid(page, y, [
      { label: 'Monitoring Year', value: details.monitoringYear },
      { label: 'Recorded By', value: record.recordedBy },
    ], fonts);
    ensureSpace(60);
    y = drawMonthlyMeasurements(page, y, details, fonts);
    y = drawNarrative(page, y, 'Observation', details.observations, fonts);
    y = drawNarrative(page, y, 'First Quarter', details.firstQuarter, fonts);
    y = drawNarrative(page, y, 'Second Quarter', details.secondQuarter, fonts);
    y = drawNarrative(page, y, 'Third Quarter', details.thirdQuarter, fonts);
    y = drawNarrative(page, y, 'Fourth Quarter', details.fourthQuarter, fonts);
  }

  if (record.recordType === 'Health Assessment') {
    y = drawFieldGrid(page, y, [
      { label: 'Assessment Type', value: record.assessmentType },
      { label: 'Date', value: record.date ? formatDate(record.date) : '' },
      { label: 'Allergies', value: record.allergies },
      { label: 'Medical Conditions', value: record.conditions },
    ], fonts);
    y = drawNarrative(page, y, 'Findings / Notes', record.findings, fonts);
  }

  if (record.recordType === 'Medication Log') {
    y = drawFieldGrid(page, y, [
      { label: 'Medication Name', value: record.medicationName },
      { label: 'Dosage', value: record.dosage },
      { label: 'Frequency', value: record.frequency },
      { label: 'Duration', value: record.duration },
      { label: 'Prescribed By', value: record.prescribedBy },
      { label: 'Date', value: record.date ? formatDate(record.date) : '' },
      { label: 'Allergies', value: record.allergies },
      { label: 'Medical Conditions', value: record.conditions },
    ], fonts);
    y = drawNarrative(page, y, 'Notes', record.findings, fonts);
  }

  if (record.recordType === 'Medical Treatment') {
    y = drawFieldGrid(page, y, [
      { label: 'Treatment Type', value: record.treatmentType },
      { label: 'Date', value: record.date ? formatDate(record.date) : '' },
      { label: 'Follow-up Date', value: record.followUpDate ? formatDate(record.followUpDate) : '' },
      { label: 'Outcome', value: record.outcome },
    ], fonts);
    y = drawNarrative(page, y, 'Procedure / Description', record.procedure_, fonts);
  }

  // ── Declaration ──
  //
  // The signature the form captured belongs to the practitioner who examined the
  // resident, so it prints over the rule with their name under it. A record with
  // no drawing still prints the rule and the name: the line is part of the form.
  ensureSpace(SIGNATURE_BOX_HEIGHT + SIGNATURE_TAIL);
  y = drawSectionHeading(page, y, 'CERTIFICATION', fonts.bold);

  const signature = details.doctorSignature;
  const boxY = y - SIGNATURE_BOX_HEIGHT;
  const signed = await drawSignatureImage(pdfDoc, page, signature, {
    x: MARGIN_X,
    y: boxY,
    width: CONTENT_WIDTH / 2 - 20,
    height: SIGNATURE_BOX_HEIGHT,
  });

  page.drawLine({
    start: { x: MARGIN_X, y: boxY },
    end: { x: MARGIN_X + CONTENT_WIDTH / 2 - 20, y: boxY },
    thickness: 0.7,
    color: BRAND,
  });
  page.drawText(text(details.careProvider || record.prescribedBy || 'Examining Practitioner'), {
    x: MARGIN_X, y: boxY - 11, size: SMALL_SIZE, font: fonts.bold, color: INK,
  });
  page.drawText('Signature over printed name', {
    x: MARGIN_X, y: boxY - 21, size: MICRO_SIZE, font: fonts.regular, color: MUTED,
  });
  if (!signed) {
    page.drawText('(no signature captured)', {
      x: MARGIN_X, y: boxY + 10, size: MICRO_SIZE, font: fonts.regular, color: MUTED,
    });
  }

  const preparedX = MARGIN_X + CONTENT_WIDTH / 2 + 20;
  page.drawLine({
    start: { x: preparedX, y: boxY },
    end: { x: MARGIN_X + CONTENT_WIDTH, y: boxY },
    thickness: 0.7,
    color: BRAND,
  });
  page.drawText(text(record.recordedBy || 'Nurse on duty'), {
    x: preparedX, y: boxY - 11, size: SMALL_SIZE, font: fonts.bold, color: INK,
  });
  page.drawText('Recorded by / Nurse', {
    x: preparedX, y: boxY - 21, size: MICRO_SIZE, font: fonts.regular, color: MUTED,
  });

  drawFooters(pdfDoc, fonts, record, person);

  return Buffer.from(await pdfDoc.save());
}

/**
 * Builds the PDF for a `healthRecords` row, ready to be stored on the matching
 * `documents` entry.
 *
 * Single entry point shared by the publisher and any on-demand download, so a
 * record is always rebuilt exactly the same way.
 *
 * @param {Object} record
 * @param {Object|string} [resident]
 * @returns {Promise<{ buffer: Buffer, fileName: string, fileSize: number, title: string }>}
 */
async function buildHealthRecordDocument(record = {}, resident = {}) {
  const person = typeof resident === 'string' ? { name: resident } : (resident || {});
  const buffer = await buildHealthRecordPdf(record, resident);
  return {
    buffer,
    fileName: healthRecordFileName(record, person.name || record.residentName),
    fileSize: buffer.length,
    title: healthRecordTitle(record),
  };
}

module.exports = {
  buildHealthRecordPdf,
  buildHealthRecordDocument,
  healthRecordFileName,
  healthRecordTitle,
  clearLogoCache,
  RECORD_TYPE_LABELS,
  PAGE_WIDTH,
  PAGE_HEIGHT,
};
