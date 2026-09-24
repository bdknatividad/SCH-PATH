/**
 * Quarterly Progress Report PDF generator.
 * @module utils/quarterlyReportPdf
 * @description Builds the resident's Quarterly Progress Report — a branded,
 * print-ready A4 document assembled from the report header, the auto-filled
 * identifying information, the six Developmental Aspect sections, the closing
 * narrative and the signature block.
 *
 * Unlike the Anecdotal Report, this document has no official pre-printed
 * template to overlay: the reference form is a plain Word file, so the layout
 * is designed here. Generation lives on the server for the same reason it does
 * for the Anecdotal Report — the resident's Documents entry must always receive
 * its file, whichever client triggered the finalize.
 *
 * The six aspect keys and labels are mirrored in
 * `frontend/src/app/components/QuarterlyReports.tsx` (`ASPECTS`). The test suite
 * parses both and fails if they disagree, so a section cannot be authored under
 * one label and printed under another.
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// ── Page geometry (A4 portrait, in points) ──
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 45;
const MARGIN_TOP = 48;
const MARGIN_BOTTOM = 52;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

// ── Layout metrics ──
//
// The distances the finished report is built from. They are named because the
// fill-in template has to know where the finished report's table *would* start,
// and it can only work that out by re-walking the same arithmetic — see
// TEMPLATE_GEOMETRY below.
const MASTHEAD_BAND_HEIGHT = 74;
const MASTHEAD_BAND_LIFT = 22;
const MASTHEAD_TAIL = 22;
const SECTION_HEADING_HEIGHT = 16;
const IDENTIFYING_ROW_HEIGHT = 25;
const IDENTIFYING_TAIL = 10;
const TABLE_HEADER_HEIGHT = 26;
const SIGNATURE_LIFT = 12;
const SIGNATURE_HEIGHT = 34;
const SIGNATURE_TAIL = 36;
// The closing narrative. `NARRATIVE_LIFT` is the gap between the last aspect row
// and the narrative's heading; `NARRATIVE_TAIL` the gap between the box and the
// signature heading below it.
const NARRATIVE_LIFT = 10;
const NARRATIVE_TAIL = 14;

// ── Fill-in template metrics ──
//
// The popup form renders the template PDF behind its inputs, so the six aspect
// rows have to sit where the client can work them out in advance: a row that
// grew to fit its own text would slide the inputs out from under the cursor
// mid-sentence. The template therefore lays the rows out at a fixed height, while
// the finished report keeps the content-sized rows it has always had.
//
// Three rows fit under the identifying block on page 1 (the six fixed rows end
// 10pt above the bottom margin), and the remaining three share page 2 with the
// signature slot.
const TEMPLATE_ROW_HEIGHT = 130;
const TEMPLATE_ROWS_PER_PAGE = 3;
// The blank narrative box the client overlays its textarea on. Fixed for the
// same reason the rows are: the box may not grow to fit what is typed into it,
// or the textarea would slide out from under the cursor mid-sentence.
const TEMPLATE_NARRATIVE_HEIGHT = 150;

// ── Type scale ──
const BODY_SIZE = 9;
const SMALL_SIZE = 7.5;
const LABEL_SIZE = 8;
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

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The six Developmental Aspects, in report order. This is the single source of
 * truth for the aspect vocabulary on the backend: `quarterlyReportController`
 * creates one section row per entry when a report is opened, and the PDF draws
 * them in this order.
 */
const ASPECTS = [
  { key: 'physical', label: 'Physical' },
  { key: 'emotional', label: 'Emotional' },
  { key: 'behavioral', label: 'Behavioral' },
  { key: 'spiritual', label: 'Spiritual' },
  { key: 'educational', label: 'Educational' },
  { key: 'economicProductivity', label: 'Economic Productivity' },
];

/**
 * The identifying-information block, in the order the reference form lists it.
 * `key` indexes into the report's `identifyingInformation` JSON snapshot.
 */
const IDENTIFYING_FIELDS = [
  { key: 'childName', label: 'Name of the Child' },
  { key: 'sex', label: 'Sex' },
  { key: 'age', label: 'Age' },
  { key: 'birthDate', label: 'Date of Birth' },
  { key: 'religion', label: 'Religion' },
  { key: 'educationalAttainment', label: 'Educational Attainment' },
  { key: 'schoolAttended', label: 'School Attended' },
  { key: 'schoolAddress', label: 'School Address' },
  { key: 'permanentAddress', label: 'Permanent Address' },
  { key: 'presentAddress', label: 'Present Address' },
  { key: 'dateOfAdmission', label: 'Date of Admission' },
  { key: 'ageUponAdmission', label: 'Age upon Admission' },
  { key: 'guardian', label: 'Guardian' },
  { key: 'contactNumber', label: 'Contact Number' },
  { key: 'caseType', label: 'Case' },
  { key: 'caseStatus', label: 'Case Status' },
];

/** Column widths of the Observation/Progress table. Must sum to CONTENT_WIDTH. */
const TABLE_COLUMNS = [
  { key: 'aspect', label: 'Developmental Aspect', width: 92 },
  { key: 'presentLevel', label: 'Present level of Functioning', width: 131 },
  { key: 'observations', label: 'Observations', width: 137 },
  { key: 'interventions', label: 'Rendered Programs/Activities/Intervention', width: CONTENT_WIDTH - 92 - 131 - 137 },
];

const MIN_ROW_HEIGHT = 54;
// The finished report sizes its narrative box to the text; this is the floor, so
// an empty or one-line narrative still prints as a field rather than a hairline.
const MIN_NARRATIVE_HEIGHT = 72;

/**
 * Where the fill-in template puts everything, in PDF points from the bottom-left.
 *
 * This is the authority for the template's coordinates. It is derived from the
 * same metrics the finished report is drawn with, and it is mirrored in
 * `frontend/src/shared/quarterlyReportTemplate.json`, which the overlay reads to
 * position its inputs. The test suite compares the two and fails if they drift,
 * so a change to the masthead or the identifying block cannot silently leave the
 * inputs pointing at the wrong cells.
 *
 * The rows are laid out at a fixed height here, not the content-sized height the
 * finished report uses — see TEMPLATE_ROW_HEIGHT.
 */
const TEMPLATE_GEOMETRY = (() => {
  // Rounded to hundredths of a point: the column widths come out of a running
  // subtraction (`505.28 - 92 - 131 - 137`), and an unrounded 145.27999999999997
  // would never compare equal to the 145.28 the shared JSON has to hold.
  const round = (value) => Math.round(value * 100) / 100;

  const mastheadEnd = (PAGE_HEIGHT - MARGIN_TOP + MASTHEAD_BAND_LIFT) - MASTHEAD_BAND_HEIGHT - MASTHEAD_TAIL;
  const identifyingEnd = mastheadEnd - SECTION_HEADING_HEIGHT
    - Math.ceil(IDENTIFYING_FIELDS.length / 2) * IDENTIFYING_ROW_HEIGHT - IDENTIFYING_TAIL;

  // Page 1 continues under the identifying block; page 2 starts at the top margin
  // and restates the heading, exactly as the finished report's continuation does.
  const tableTops = [
    round(identifyingEnd - SECTION_HEADING_HEIGHT - TABLE_HEADER_HEIGHT),
    round(PAGE_HEIGHT - MARGIN_TOP - SECTION_HEADING_HEIGHT - TABLE_HEADER_HEIGHT),
  ];

  const columns = {};
  let x = MARGIN_X;
  for (const column of TABLE_COLUMNS) {
    columns[column.key] = { x: round(x), width: round(column.width) };
    x += column.width;
  }

  // The closing narrative sits between the last row of page 2 and the signature
  // block: the report reads as evidence, then prose, then a signature. The
  // signature band therefore has to be derived from the narrative's bottom edge
  // rather than from the last row — moving the box without moving the band would
  // print the signature over the narrative.
  const rowsOnPageTwo = Math.max(0, ASPECTS.length - TEMPLATE_ROWS_PER_PAGE);
  const narrativeStart = tableTops[1] - rowsOnPageTwo * TEMPLATE_ROW_HEIGHT;
  const narrativeTop = round(narrativeStart - SECTION_HEADING_HEIGHT - NARRATIVE_LIFT);
  const narrativeBottom = narrativeTop - TEMPLATE_NARRATIVE_HEIGHT;
  const signatureStart = narrativeBottom - NARRATIVE_TAIL;
  const signatureRuleY = signatureStart - SECTION_HEADING_HEIGHT - SIGNATURE_LIFT - SIGNATURE_HEIGHT;

  return {
    page: { width: PAGE_WIDTH, height: PAGE_HEIGHT, marginX: MARGIN_X, marginBottom: MARGIN_BOTTOM },
    table: {
      cellPad: CELL_PAD,
      rowHeight: TEMPLATE_ROW_HEIGHT,
      rowsPerPage: TEMPLATE_ROWS_PER_PAGE,
      tableTops,
      columns,
    },
    narrative: {
      x: MARGIN_X,
      top: narrativeTop,
      width: round(CONTENT_WIDTH),
      height: TEMPLATE_NARRATIVE_HEIGHT,
    },
    signature: {
      x: MARGIN_X,
      top: round(signatureRuleY + 2 + SIGNATURE_HEIGHT),
      width: round(CONTENT_WIDTH / 2 - 20),
      height: SIGNATURE_HEIGHT + 2,
    },
  };
})();

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

function text(value) {
  return sanitize(String(value ?? '').trim());
}

/**
 * Splits a `YYYY-MM-DD` value into its parts without going through `Date`.
 *
 * `new Date('2024-06-01')` is parsed as UTC midnight and then read back in the
 * server's local zone, which west of Greenwich lands on 31 May and shifts the
 * whole period a month. Reading the string directly avoids that entirely.
 */
function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** e.g. `June - August 2024` — the human-readable period range. */
function periodRangeLabel(periodStart, periodEnd) {
  const start = parseIsoDate(periodStart);
  const end = parseIsoDate(periodEnd);
  if (!start || !end) return '';
  const startMonth = MONTH_NAMES[start.month - 1];
  const endMonth = MONTH_NAMES[end.month - 1];
  if (!startMonth || !endMonth) return String(start.year);
  if (start.year !== end.year) {
    return `${startMonth} ${start.year} - ${endMonth} ${end.year}`;
  }
  if (start.month === end.month) return `${startMonth} ${start.year}`;
  return `${startMonth} - ${endMonth} ${start.year}`;
}

/**
 * e.g. `JUNE-AUGUST 2024` — the period as the official form writes it in its own
 * header. This is the shape the reference document uses, so the generated PDF
 * reads the same way as the form it stands in for.
 */
function periodHeaderLabel(periodStart, periodEnd) {
  const range = periodRangeLabel(periodStart, periodEnd);
  if (!range) return '';
  return range.replace(/\s+-\s+/g, '-').toUpperCase();
}

/**
 * Resolves the period a report covers, preferring the stored dates and falling
 * back to a pre-formatted `periodLabel` so a report written before the dates
 * were introduced still renders something sensible.
 */
function resolvePeriod(report = {}) {
  const range = periodRangeLabel(report.periodStart, report.periodEnd);
  return {
    range: range || text(report.periodLabel),
    header: periodHeaderLabel(report.periodStart, report.periodEnd) || text(report.periodLabel).toUpperCase(),
  };
}

/** e.g. `Quarterly Progress Report - Juan Dela Cruz - June - August 2024.pdf` */
function quarterlyReportFileName(report = {}, childName) {
  const name = childName || asObject(report.identifyingInformation).childName || report.residentId || 'Resident';
  const label = resolvePeriod(report).range || 'Period not set';
  return `Quarterly Progress Report - ${name} - ${label}.pdf`
    .replace(/[\\/:*?"<>|]/g, '-');
}

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

/**
 * Greedy word wrap measured against the real font metrics, so a long
 * intervention note cannot overflow its column the way a character-count
 * estimate would.
 *
 * @returns {string[]} the lines to draw, never empty.
 */
function wrapToWidth(value, font, size, maxWidth) {
  // The raw value is split on newlines BEFORE `sanitize` runs. `sanitize` maps
  // every character outside printable Latin-1 to '?', and '\n' is one of them —
  // so splitting afterwards found nothing to split on and every multi-line cell
  // was drawn as a single run-on line of '?' separators. That silently broke the
  // one thing this report needs most: the assembled bullet list in each aspect's
  // Observations and Interventions columns.
  const source = String(value ?? '');
  if (!source.trim()) return [];

  const lines = [];
  for (const paragraph of source.split(/\r?\n/)) {
    const cleaned = sanitize(paragraph);
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);

      // A single word wider than the column has to be broken, or it would be
      // drawn straight through the neighbouring cell.
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        current = word;
        continue;
      }
      let chunk = '';
      for (const char of word) {
        const next = chunk + char;
        if (font.widthOfTextAtSize(next, size) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk = next;
        }
      }
      current = chunk;
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * Wraps the report's narrative, keeping the blank line between paragraphs.
 *
 * `wrapToWidth` drops an empty paragraph, which is right for the bullet list in
 * an aspect cell and wrong here: a narrative is read as paragraphs, and running
 * two of them together silently changes what it says.
 *
 * @returns {string[]} the lines to draw, never empty; '' marks a paragraph break.
 */
function wrapNarrative(value, font, size, maxWidth) {
  const source = String(value ?? '');
  if (!source.trim()) return [];

  const lines = [];
  for (const paragraph of source.split(/\r?\n/)) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }
    lines.push(...wrapToWidth(paragraph, font, size, maxWidth));
  }
  // A trailing newline leaves an empty final line, which would print as an
  // unexplained gap at the foot of the box.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
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
 * A missing or unusable value is skipped rather than thrown: one unsigned
 * section must not stop the rest of the document being produced.
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
  page.drawText(title, { x: MARGIN_X + 9, y, size: HEADING_SIZE, font, color: BRAND });
  return y - SECTION_HEADING_HEIGHT;
}

/** The branded masthead. Drawn once, on page 1. */
async function drawMasthead(pdfDoc, page, fonts, report, childName) {
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

  const titleY = bandTop - 30;
  page.drawText('SECOND CHANCE HOME', {
    x: textX, y: titleY, size: TITLE_SIZE, font: fonts.bold, color: WHITE,
  });
  page.drawText('QUARTERLY PROGRESS REPORT', {
    x: textX, y: titleY - 15, size: SUBTITLE_SIZE, font: fonts.regular, color: ACCENT,
  });

  // The period reads exactly as the official form writes it — "(JUNE-AUGUST
  // 2024)" — so a printed copy is recognisable next to the Word original.
  const period = resolvePeriod(report);
  const periodLine = period.header ? `(${period.header})` : period.range;
  if (periodLine) {
    page.drawText(periodLine, {
      x: textX, y: titleY - 29, size: SMALL_SIZE, font: fonts.regular, color: rgb(0.82, 0.85, 0.86),
    });
  }

  const resident = text(childName || asObject(report.identifyingInformation).childName);
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
 * The identifying-information block: a two-column grid of label/value pairs,
 * each value sitting on a printed rule.
 */
function drawIdentifyingInformation(page, y, report, fonts) {
  const snapshot = asObject(report.identifyingInformation);
  y = drawSectionHeading(page, y, 'IDENTIFYING INFORMATION', fonts.bold);

  const columnWidth = CONTENT_WIDTH / 2;
  const rowHeight = IDENTIFYING_ROW_HEIGHT;
  const valueOffset = 11;

  for (let index = 0; index < IDENTIFYING_FIELDS.length; index += 2) {
    for (let column = 0; column < 2; column += 1) {
      const field = IDENTIFYING_FIELDS[index + column];
      if (!field) continue;

      const x = MARGIN_X + column * columnWidth;
      const available = columnWidth - 14;

      page.drawText(text(field.label), {
        x, y, size: SMALL_SIZE, font: fonts.bold, color: MUTED,
      });

      const valueFont = fonts.regular;
      const valueLines = wrapToWidth(snapshot[field.key], valueFont, BODY_SIZE, available);
      const value = valueLines.length ? valueLines[0] : '\u2014';
      page.drawText(value, { x, y: y - valueOffset, size: BODY_SIZE, font: valueFont, color: INK });
      page.drawLine({
        start: { x, y: y - valueOffset - 3 },
        end: { x: x + available, y: y - valueOffset - 3 },
        thickness: 0.5,
        color: RULE,
      });
    }
    y -= rowHeight;
  }

  return y - IDENTIFYING_TAIL;
}

/** Draws the four-column header row of the Observation/Progress table. */
function drawTableHeader(page, y, fonts) {
  const height = TABLE_HEADER_HEIGHT;
  page.drawRectangle({
    x: MARGIN_X, y: y - height, width: CONTENT_WIDTH, height, color: HEAD_FILL,
  });

  let x = MARGIN_X;
  for (const column of TABLE_COLUMNS) {
    const lines = wrapToWidth(column.label, fonts.bold, SMALL_SIZE, column.width - CELL_PAD * 2);
    drawLines(page, lines, {
      x: x + CELL_PAD,
      topY: y - CELL_PAD - SMALL_SIZE,
      font: fonts.bold,
      size: SMALL_SIZE,
      color: BRAND,
      step: SMALL_SIZE + 1.5,
    });
    page.drawLine({
      start: { x, y: y - height },
      end: { x, y },
      thickness: 0.5,
      color: RULE,
    });
    x += column.width;
  }
  page.drawLine({ start: { x, y: y - height }, end: { x, y }, thickness: 0.5, color: RULE });
  page.drawLine({
    start: { x: MARGIN_X, y: y - height },
    end: { x: MARGIN_X + CONTENT_WIDTH, y: y - height },
    thickness: 0.6,
    color: BRAND,
  });

  return y - height;
}

/**
 * Lays out one aspect row: the aspect label and its assignee in column 1, and
 * the three narrative columns wrapped to their own widths. The row is as tall
 * as its tallest column.
 *
 * @returns {number} the y below the row.
 */
function drawAspectRow(page, y, section, fonts, zebra) {
  const cells = [
    { column: TABLE_COLUMNS[1], lines: wrapToWidth(section.presentLevel, fonts.regular, BODY_SIZE, TABLE_COLUMNS[1].width - CELL_PAD * 2) },
    { column: TABLE_COLUMNS[2], lines: wrapToWidth(section.observations, fonts.regular, BODY_SIZE, TABLE_COLUMNS[2].width - CELL_PAD * 2) },
    { column: TABLE_COLUMNS[3], lines: wrapToWidth(section.interventions, fonts.regular, BODY_SIZE, TABLE_COLUMNS[3].width - CELL_PAD * 2) },
  ];

  const aspectFont = fonts.bold;
  const aspectLines = wrapToWidth(section.aspectLabel, aspectFont, BODY_SIZE, TABLE_COLUMNS[0].width - CELL_PAD * 2);

  const tallestCell = Math.max(...cells.map((cell) => cell.lines.length), 0);
  const contentHeight = tallestCell * LINE_STEP + CELL_PAD * 2;
  const aspectHeight = (aspectLines.length * LINE_STEP) + CELL_PAD * 2;
  const height = Math.max(MIN_ROW_HEIGHT, contentHeight, aspectHeight);

  if (zebra) {
    page.drawRectangle({ x: MARGIN_X, y: y - height, width: CONTENT_WIDTH, height, color: ZEBRA });
  }

  // Column 1 — the aspect name alone. Nothing else is printed here: the official
  // form's first column carries only the aspect, and the report now has a single
  // preparer, so naming an owner per row would repeat one person six times and
  // widen the column for no information.
  drawLines(page, aspectLines, {
    x: MARGIN_X + CELL_PAD,
    topY: y - CELL_PAD - BODY_SIZE,
    font: aspectFont,
    size: BODY_SIZE,
    color: BRAND,
  });

  // Columns 2–4 — the narrative.
  let x = MARGIN_X + TABLE_COLUMNS[0].width;
  for (const cell of cells) {
    const lines = cell.lines.length ? cell.lines : ['\u2014'];
    drawLines(page, lines, {
      x: x + CELL_PAD,
      topY: y - CELL_PAD - BODY_SIZE,
      font: fonts.regular,
      size: BODY_SIZE,
      color: cell.lines.length ? INK : MUTED,
    });
    x += cell.column.width;
  }

  // Cell borders.
  let borderX = MARGIN_X;
  for (const column of TABLE_COLUMNS) {
    page.drawLine({
      start: { x: borderX, y: y - height },
      end: { x: borderX, y },
      thickness: 0.5,
      color: RULE,
    });
    borderX += column.width;
  }
  page.drawLine({
    start: { x: MARGIN_X, y: y - height },
    end: { x: MARGIN_X + CONTENT_WIDTH, y: y - height },
    thickness: 0.5,
    color: RULE,
  });

  return y - height;
}

/**
 * One blank row of the fill-in template: the aspect name and the cell grid, with
 * the three narrative cells left empty.
 *
 * Deliberately not `drawAspectRow` with empty text. That function prints an em
 * dash in a cell it has nothing to say about, and those dashes would sit behind
 * the client's inputs. The border drawing is repeated rather than shared for the
 * same reason the row height is separate: a change to the finished report's rows
 * must not be able to move the template's.
 */
function drawTemplateAspectRow(page, y, aspect, fonts, zebra, height) {
  if (zebra) {
    page.drawRectangle({ x: MARGIN_X, y: y - height, width: CONTENT_WIDTH, height, color: ZEBRA });
  }

  drawLines(page, wrapToWidth(aspect.label, fonts.bold, BODY_SIZE, TABLE_COLUMNS[0].width - CELL_PAD * 2), {
    x: MARGIN_X + CELL_PAD,
    topY: y - CELL_PAD - BODY_SIZE,
    font: fonts.bold,
    size: BODY_SIZE,
    color: BRAND,
  });

  let borderX = MARGIN_X;
  for (const column of TABLE_COLUMNS) {
    page.drawLine({
      start: { x: borderX, y: y - height },
      end: { x: borderX, y },
      thickness: 0.5,
      color: RULE,
    });
    borderX += column.width;
  }
  page.drawLine({
    start: { x: MARGIN_X, y: y - height },
    end: { x: MARGIN_X + CONTENT_WIDTH, y: y - height },
    thickness: 0.5,
    color: RULE,
  });
}

/**
 * The report's closing narrative: one free-text account of the period, in the
 * preparer's own words.
 *
 * It is drawn as a ruled box rather than as more table cells because the aspects
 * table is tabular evidence — a rating and two short columns per aspect — while
 * this is prose that does not belong to any one aspect. It is where the Social
 * Worker says what the six rows add up to.
 *
 * `height` is a parameter because the two callers need different things from it.
 * The fill-in template lays the box out at a fixed size, since the client
 * overlays a textarea on it and a box that grew would move the textarea. The
 * finished report sizes it to the text it actually carries, capped to the box.
 *
 * @param {string} narrative the report's `narrative` column.
 * @param {number} height    the box's height in points.
 * @returns {number} the y below the box.
 */
function drawNarrativeSection(page, y, narrative, fonts, height) {
  const headingBottom = drawSectionHeading(page, y, 'NARRATIVE REPORT', fonts.bold);
  const boxTop = headingBottom - NARRATIVE_LIFT;
  const boxBottom = boxTop - height;

  page.drawRectangle({
    x: MARGIN_X,
    y: boxBottom,
    width: CONTENT_WIDTH,
    height,
    borderColor: RULE,
    borderWidth: 0.7,
    color: WHITE,
  });

  // `wrapNarrative` already sanitised, so the lines are drawable as they are.
  const lines = wrapNarrative(narrative, fonts.regular, BODY_SIZE, CONTENT_WIDTH - CELL_PAD * 2);
  let textY = boxTop - CELL_PAD - BODY_SIZE;
  for (const line of lines) {
    if (textY < boxBottom + CELL_PAD) break;
    // An empty line is a paragraph break: it advances the cursor but draws
    // nothing, and pdf-lib has no use for a zero-length string.
    if (line) {
      page.drawText(line, {
        x: MARGIN_X + CELL_PAD, y: textY, size: BODY_SIZE, font: fonts.regular, color: INK,
      });
    }
    textY -= LINE_STEP;
  }

  return boxBottom - NARRATIVE_TAIL;
}

/**
 * The one sign-off block at the foot of the report: Prepared by.
 *
 * There used to be a SECTION SIGN-OFFS table above this (one row per
 * Developmental Aspect, with the owner, its status and that owner's signature)
 * and two further slots here — Attested by and Noted by. All three are gone:
 * a single Social Worker prepares the whole report, so a per-aspect sign-off
 * only restated the same person six times, and an attestation by the Center
 * Head duplicated the approval they already give outside this document.
 *
 * The slot prints the drawn signature above the name, over a rule, so the page
 * still reads as a signed instrument.
 */
async function drawReportSignatures(pdfDoc, page, y, report, fonts) {
  y = drawSectionHeading(page, y, 'SIGNATURES', fonts.bold);

  const slots = [
    { caption: 'Prepared by:', name: report.preparedByName, signature: report.preparedBySignature },
  ];

  // One slot, half the content width: a signature rule that spanned the page
  // would read as a blank field waiting to be filled in rather than a signature.
  const slotWidth = CONTENT_WIDTH / 2;
  const signatureHeight = SIGNATURE_HEIGHT;
  const ruleY = y - SIGNATURE_LIFT - signatureHeight;

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const x = MARGIN_X + index * slotWidth;
    const width = slotWidth - 20;

    // "Prepared by:" names the signatory and sits *above* the signature; the
    // conventional "Signature over Printed Name" sits under the printed name.
    // The caption used to be drawn below the name, where it labelled the rule
    // rather than the person, and the report carried no printed-name label at
    // all — so a signature on the page had nothing saying whose it was.
    page.drawText(text(slot.caption), {
      x, y, size: SMALL_SIZE, font: fonts.regular, color: MUTED,
    });

    await drawSignatureImage(pdfDoc, page, slot.signature, {
      x, y: ruleY + 2, width, height: signatureHeight,
    });

    page.drawLine({ start: { x, y: ruleY }, end: { x: x + width, y: ruleY }, thickness: 0.7, color: INK });
    const name = text(slot.name) || '\u2014';
    const nameWidth = fonts.bold.widthOfTextAtSize(name, BODY_SIZE);
    page.drawText(name, {
      x: x + Math.max(0, (width - nameWidth) / 2),
      y: ruleY - 12,
      size: BODY_SIZE,
      font: fonts.bold,
      color: INK,
    });

    const printedNameLabel = 'Signature over Printed Name';
    const printedNameWidth = fonts.regular.widthOfTextAtSize(printedNameLabel, SMALL_SIZE);
    page.drawText(printedNameLabel, {
      x: x + Math.max(0, (width - printedNameWidth) / 2),
      y: ruleY - 24,
      size: SMALL_SIZE,
      font: fonts.regular,
      color: MUTED,
    });
  }

  return ruleY - SIGNATURE_TAIL;
}

/** Footer on every page, numbered once the total is known. */
function drawFooters(pdfDoc, fonts, report, childName) {
  const pages = pdfDoc.getPages();
  const resident = text(childName || asObject(report.identifyingInformation).childName) || 'Resident';
  const period = resolvePeriod(report);
  const label = `${period.range || 'Period not set'}  \u00B7  ${resident}`;

  pages.forEach((page, index) => {
    const y = MARGIN_BOTTOM - 24;
    page.drawLine({
      start: { x: MARGIN_X, y: y + 12 },
      end: { x: MARGIN_X + CONTENT_WIDTH, y: y + 12 },
      thickness: 0.5,
      color: RULE,
    });
    page.drawText(`SCH-PATH \u00B7 Quarterly Progress Report \u00B7 ${label}`, {
      x: MARGIN_X, y, size: SMALL_SIZE, font: fonts.regular, color: MUTED,
    });
    const pageLabel = `Page ${index + 1} of ${pages.length}`;
    const width = fonts.regular.widthOfTextAtSize(pageLabel, SMALL_SIZE);
    page.drawText(pageLabel, {
      x: PAGE_WIDTH - MARGIN_X - width, y, size: SMALL_SIZE, font: fonts.regular, color: MUTED,
    });
  });
}

/**
 * Builds the complete Quarterly Progress Report.
 *
 * @param {Object} report             A `quarterlyReports` row.
 * @param {Object[]} [sections]       `quarterlyReportSections` rows, in any order.
 * @param {string} [childName]        Resident's name, joined from `children`.
 * @returns {Promise<Buffer>}
 */
async function buildQuarterlyReportPdf(report = {}, sections = [], childName) {
  const pdfDoc = await PDFDocument.create();
  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  const period = resolvePeriod(report);
  pdfDoc.setTitle(`Quarterly Progress Report - ${period.range || 'Period not set'}`);
  pdfDoc.setAuthor('Second Chance Home');
  pdfDoc.setSubject('Quarterly Progress Report');
  pdfDoc.setCreator('SCH-PATH');

  // Always render all six aspects in canonical order, even if a section row is
  // somehow missing — a report that silently dropped an aspect would look
  // complete while being incomplete.
  const byKey = new Map();
  for (const section of Array.isArray(sections) ? sections : []) {
    if (section?.aspectKey) byKey.set(String(section.aspectKey), section);
  }
  const ordered = ASPECTS.map((aspect, index) => {
    const found = byKey.get(aspect.key) || {};
    return {
      aspectKey: aspect.key,
      aspectLabel: found.aspectLabel || aspect.label,
      sortOrder: index,
      assignedToName: found.assignedToName || null,
      status: found.status || 'Not Started',
      presentLevel: found.presentLevel || null,
      observations: found.observations || null,
      interventions: found.interventions || null,
      signature: found.signature || null,
    };
  });

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = await drawMasthead(pdfDoc, page, fonts, report, childName);

  y = drawIdentifyingInformation(page, y, report, fonts);

  /** Starts a plain continuation page when `needed` points would not fit. */
  const ensureSpace = (needed) => {
    if (y - needed >= MARGIN_BOTTOM) return;
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN_TOP;
  };

  /**
   * Same, but restates the table heading and column headers so a row that
   * spilled onto a new page is still readable there.
   */
  const ensureTableSpace = (needed) => {
    if (y - needed >= MARGIN_BOTTOM) return;
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN_TOP;
    y = drawSectionHeading(page, y, 'OBSERVATION / PROGRESS (continued)', fonts.bold);
    y = drawTableHeader(page, y, fonts);
  };

  y = drawSectionHeading(page, y, 'OBSERVATION / PROGRESS', fonts.bold);
  y = drawTableHeader(page, y, fonts);

  for (let index = 0; index < ordered.length; index += 1) {
    const section = ordered[index];
    const probe = [
      section.presentLevel, section.observations, section.interventions,
    ].map((value) => wrapToWidth(value, fonts.regular, BODY_SIZE, 120).length);
    const estimated = Math.max(MIN_ROW_HEIGHT, Math.max(...probe) * LINE_STEP + CELL_PAD * 2 + 6);
    ensureTableSpace(estimated);
    y = drawAspectRow(page, y, section, fonts, index % 2 === 1);
  }

  // The closing narrative, when there is one.
  //
  // A report with no narrative prints no section at all rather than an empty
  // ruled box: on a finalized document an empty box at the foot of the page
  // reads as a field somebody forgot to fill in, not as an optional one.
  const narrativeLines = wrapNarrative(report.narrative, fonts.regular, BODY_SIZE, CONTENT_WIDTH - CELL_PAD * 2);
  if (narrativeLines.length) {
    const narrativeHeight = Math.max(
      MIN_NARRATIVE_HEIGHT,
      narrativeLines.length * LINE_STEP + CELL_PAD * 2 + 6
    );
    ensureSpace(SECTION_HEADING_HEIGHT + NARRATIVE_LIFT + narrativeHeight + NARRATIVE_TAIL);
    y = drawNarrativeSection(page, y, report.narrative, fonts, narrativeHeight);
  }

  ensureSpace(120);
  await drawReportSignatures(pdfDoc, page, y, report, fonts);

  drawFooters(pdfDoc, fonts, report, childName);

  return Buffer.from(await pdfDoc.save());
}

/**
 * Builds the fill-in form the Social Worker writes the report on.
 *
 * This is the report's own layout, printed as far as the system can take it: the
 * masthead, the period, and the identifying information — which is now filled in
 * entirely from the resident's records, so there is nothing on page 1 to type.
 * What is left blank is exactly what only a person can supply: the three
 * narrative columns of each of the six Developmental Aspects, and the signature.
 *
 * The client renders this PDF and overlays those fields on it, which is why the
 * rows are a fixed height here. The finished report is unaffected: it is still
 * built by {@link buildQuarterlyReportPdf} with content-sized rows, so the
 * document the resident's file receives is unchanged.
 *
 * @param {Object} report      A `quarterlyReports` row.
 * @param {string} [childName] Resident's name, joined from `children`.
 * @returns {Promise<Buffer>}
 */
async function buildQuarterlyReportTemplatePdf(report = {}, childName) {
  const pdfDoc = await PDFDocument.create();
  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  const period = resolvePeriod(report);
  pdfDoc.setTitle(`Quarterly Progress Report (form) - ${period.range || 'Period not set'}`);
  pdfDoc.setAuthor('Second Chance Home');
  pdfDoc.setSubject('Quarterly Progress Report - fill-in form');
  pdfDoc.setCreator('SCH-PATH');

  const { tableTops, rowHeight, rowsPerPage } = TEMPLATE_GEOMETRY.table;
  const rowsPageOne = Math.min(rowsPerPage, ASPECTS.length);
  const rowsPageTwo = Math.max(0, ASPECTS.length - rowsPageOne);

  // Page 1 — the masthead, the identifying information, and the first rows.
  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = await drawMasthead(pdfDoc, page, fonts, report, childName);
  y = drawIdentifyingInformation(page, y, report, fonts);
  y = drawSectionHeading(page, y, 'OBSERVATION / PROGRESS', fonts.bold);
  drawTableHeader(page, y, fonts);

  for (let row = 0; row < rowsPageOne; row += 1) {
    drawTemplateAspectRow(page, tableTops[0] - row * rowHeight, ASPECTS[row], fonts, row % 2 === 1, rowHeight);
  }

  // Page 2 — the remaining rows and the signature slot.
  page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  y = PAGE_HEIGHT - MARGIN_TOP;
  y = drawSectionHeading(page, y, 'OBSERVATION / PROGRESS (continued)', fonts.bold);
  y = drawTableHeader(page, y, fonts);

  for (let row = 0; row < rowsPageTwo; row += 1) {
    const index = rowsPageOne + row;
    drawTemplateAspectRow(page, tableTops[1] - row * rowHeight, ASPECTS[index], fonts, index % 2 === 1, rowHeight);
  }

  // The closing narrative, then the signature slot below it. The box is drawn
  // blank and at a fixed height — the client overlays its textarea on it — and
  // the signature block is placed from the box's bottom edge, not from the last
  // aspect row, so the two cannot overlap.
  const narrativeStart = tableTops[1] - rowsPageTwo * rowHeight;
  const signatureStart = drawNarrativeSection(page, narrativeStart, '', fonts, TEMPLATE_NARRATIVE_HEIGHT);

  // The slot prints the preparer's name under the rule; the drawing itself is
  // overlaid by the client and stamped into the finished report on finalize.
  await drawReportSignatures(pdfDoc, page, signatureStart, report, fonts);

  drawFooters(pdfDoc, fonts, report, childName);

  return Buffer.from(await pdfDoc.save());
}

/**
 * Builds the PDF for a `quarterlyReports` row, ready to be stored on the
 * matching `documents` entry.
 *
 * Single entry point shared by the publisher
 * (`quarterlyReportController.syncDocumentForReport`) and the on-demand
 * download, so a report is always rebuilt exactly the same way.
 *
 * @returns {Promise<{ buffer: Buffer, fileName: string, fileSize: number }>}
 */
async function buildQuarterlyReportDocument(report = {}, sections = [], childName) {
  const buffer = await buildQuarterlyReportPdf(report, sections, childName);
  return { buffer, fileName: quarterlyReportFileName(report, childName), fileSize: buffer.length };
}

module.exports = {
  buildQuarterlyReportPdf,
  buildQuarterlyReportTemplatePdf,
  buildQuarterlyReportDocument,
  quarterlyReportFileName,
  periodRangeLabel,
  periodHeaderLabel,
  resolvePeriod,
  wrapToWidth,
  wrapNarrative,
  drawNarrativeSection,
  clearLogoCache,
  ASPECTS,
  IDENTIFYING_FIELDS,
  TABLE_COLUMNS,
  TEMPLATE_GEOMETRY,
  PAGE_WIDTH,
  PAGE_HEIGHT,
  LINE_STEP,
  MONTH_NAMES,
};
