/**
 * The "PROGRESS REPORT" form, filled in.
 *
 * One template, two producers: the Educator files an **Education** quarterly
 * report and the Nurse a **Medical** one. They differ only in the `(PROGRAM)`
 * line and who signs "Prepared by" — everything else is the same form, which is
 * why this is one generator with a `program` field rather than two.
 *
 * **The official PDF is the document.** The page is loaded from
 * `public/forms/progress-report.pdf` — the file the agency issued — and the
 * answers are drawn onto it. The letterhead, the title, the `(PROGRAM)` line and
 * the `RESIDENT:` line are therefore the real thing, pixel for pixel.
 *
 * Everything from the table down is covered and redrawn, because the printed
 * rows are 14.3 pt tall and nothing below them can move. See
 * `utils/progressReportLayout` for the measurement and the reasoning.
 *
 * @module utils/progressReportPdf
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { drawSignatureImageOnPage } from '@/app/utils/signaturePdf';
import {
  REPORT_PAGE,
  REPORT_MARGIN,
  TABLE_TOP_Y,
  TABLE_COLUMN_X,
  TABLE_HEADER_HEIGHT,
  TABLE_HEADINGS,
  PROGRAM_LINE,
  RESIDENT_NAME,
  PROGRAM_LINE_MASK,
  RESIDENT_NAME_MASK,
  PROGRAM_LINE_RULE_WIDTH,
  RESIDENT_NAME_RULE_WIDTH,
} from '@/app/utils/progressReportLayout';

export interface ProgressReportRow {
  areaOfConcern: string;
  observations: string;
  actionTaken: string;
  recommendation: string;
}

export interface ProgressReportFields {
  /** Goes on the `(PROGRAM)` line — "Education Quarterly Report" or "Medical Quarterly Report". */
  program: string;
  /** "Q1".."Q4" — the quarter the report covers. */
  quarter: string;
  year: string;
  residentName: string;
  residentId: string;
  rows: ProgressReportRow[];
  narrative: string;
  /** Printed under the "Prepared by" rule, with "Program in-charge" beneath. */
  preparedByName: string;
  preparedBySignature?: string | null;
  /** Printed under the "Checked by" rule. The Social Worker. */
  checkedByName: string;
  checkedBySignature?: string | null;
  /** Printed under the "Noted by" rule. The Center Head. */
  notedByName: string;
  notedByTitle: string;
  notedBySignature?: string | null;
}

/** The blank official form, served from `public/forms/`. */
export const PROGRESS_REPORT_TEMPLATE_URL = '/forms/progress-report.pdf';

// ── The app-drawn body ──────────────────────────────────────────────────────
const BODY_FONT_SIZE = 9;
const BODY_LEADING = 11.5;
const HEADING_FONT_SIZE = 7.5;
const LABEL_FONT_SIZE = 11;
const NARRATIVE_FONT_SIZE = 10;
const NARRATIVE_LEADING = 13;
const CELL_PADDING = 4;
const MIN_ROW_HEIGHT = 30;
const SIGNATURE_RULE_WIDTH = 190;
const SIGNATURE_HEIGHT = 28;

const INK = rgb(0.05, 0.05, 0.05);
const BODY_INK = rgb(0.12, 0.12, 0.12);
const RULE = rgb(0.45, 0.45, 0.45);
const GRID = rgb(0.62, 0.62, 0.62);
const COVER = rgb(1, 1, 1);

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const source = String(text ?? '');
  if (!source.trim()) return [''];
  const lines: string[] = [];
  // Respect explicit newlines, then wrap each paragraph.
  for (const paragraph of source.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [''];
}

/**
 * Fill the form.
 *
 * Pure apart from pdf-lib — the template bytes are passed in so this can be
 * exercised without a browser.
 */
export async function buildProgressReportPdf(
  fields: ProgressReportFields,
  template: ArrayBuffer | Uint8Array,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(template);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = pdf.getPage(0);

  // ── The two fields that live on the untouched part of the form ────────────
  // Each printed blank is a run of underscore glyphs, so it is masked first and
  // a clean rule drawn in its place — otherwise the underscores cut through the
  // value like a strikethrough. See `progressReportLayout`.
  const writeOnLine = (
    value: string,
    line: { x: number; y: number },
    mask: { x: number; y: number; width: number; height: number },
    ruleWidth: number,
  ) => {
    page.drawRectangle({ x: mask.x, y: mask.y, width: mask.width, height: mask.height, color: COVER });
    page.drawLine({
      start: { x: line.x, y: line.y },
      end: { x: line.x + ruleWidth, y: line.y },
      thickness: 0.75,
      color: RULE,
    });
    page.drawText(value, { x: line.x + 2, y: line.y + 4, size: 11, font: bold, color: INK });
  };

  writeOnLine(String(fields.program || ''), PROGRAM_LINE, PROGRAM_LINE_MASK, PROGRAM_LINE_RULE_WIDTH);
  writeOnLine(String(fields.residentName || ''), RESIDENT_NAME, RESIDENT_NAME_MASK, RESIDENT_NAME_RULE_WIDTH);

  // ── Cover everything from the table down ─────────────────────────────────
  // The printed rows are one line tall and the blocks below them are fixed, so
  // the whole lower half is replaced rather than written over.
  page.drawRectangle({
    x: 0,
    y: 0,
    width: REPORT_PAGE.width,
    height: TABLE_TOP_Y,
    color: COVER,
  });

  let y = TABLE_TOP_Y;

  const newPage = () => {
    page = pdf.addPage([REPORT_PAGE.width, REPORT_PAGE.height]);
    y = REPORT_PAGE.height - REPORT_MARGIN;
  };

  const ensure = (needed: number) => {
    if (y - needed < REPORT_MARGIN) newPage();
  };

  const columnX = [...TABLE_COLUMN_X];
  const tableWidth = columnX[columnX.length - 1] - columnX[0];

  const drawTableHeader = () => {
    const top = y;
    page.drawRectangle({
      x: columnX[0],
      y: top - TABLE_HEADER_HEIGHT,
      width: tableWidth,
      height: TABLE_HEADER_HEIGHT,
      color: rgb(0.95, 0.95, 0.94),
      borderColor: GRID,
      borderWidth: 0.5,
    });
    TABLE_HEADINGS.forEach((heading, index) => {
      page.drawText(heading, {
        x: columnX[index] + CELL_PADDING,
        y: top - TABLE_HEADER_HEIGHT / 2 - 2.5,
        size: HEADING_FONT_SIZE,
        font: bold,
        color: INK,
      });
    });
    y -= TABLE_HEADER_HEIGHT;
  };

  drawTableHeader();

  const rows = Array.isArray(fields.rows) && fields.rows.length > 0
    ? fields.rows
    : [{ areaOfConcern: '', observations: '', actionTaken: '', recommendation: '' }];

  rows.forEach((row, rowIndex) => {
    const widths = columnX.slice(1).map((x, i) => x - columnX[i]);
    const cells = [row.areaOfConcern, row.observations, row.actionTaken, row.recommendation]
      .map((cell, index) => wrapText(String(cell ?? ''), font, BODY_FONT_SIZE, widths[index] - CELL_PADDING * 2));

    const contentHeight = Math.max(...cells.map(lines => lines.length)) * BODY_LEADING;
    const rowHeight = Math.max(MIN_ROW_HEIGHT, contentHeight + CELL_PADDING * 2);

    ensure(rowHeight + (rowIndex > 0 ? TABLE_HEADER_HEIGHT : 0));
    if (y === REPORT_PAGE.height - REPORT_MARGIN && rowIndex > 0) {
      drawTableHeader();
    }

    const rowTop = y;
    const rowBottom = rowTop - rowHeight;

    page.drawRectangle({
      x: columnX[0],
      y: rowBottom,
      width: tableWidth,
      height: rowHeight,
      borderColor: GRID,
      borderWidth: 0.5,
    });
    for (let i = 1; i < columnX.length - 1; i += 1) {
      page.drawLine({
        start: { x: columnX[i], y: rowBottom },
        end: { x: columnX[i], y: rowTop },
        thickness: 0.5,
        color: GRID,
      });
    }

    cells.forEach((lines, index) => {
      let textY = rowTop - CELL_PADDING - BODY_FONT_SIZE;
      for (const line of lines) {
        page.drawText(line, {
          x: columnX[index] + CELL_PADDING,
          y: textY,
          size: BODY_FONT_SIZE,
          font,
          color: BODY_INK,
        });
        textY -= BODY_LEADING;
      }
    });

    y = rowBottom;
  });

  // ── Narrative conclusion ─────────────────────────────────────────────────
  ensure(80);
  y -= 24;
  page.drawText('Narrative conclusion:', { x: REPORT_MARGIN, y, size: LABEL_FONT_SIZE, font: bold, color: INK });
  y -= 16;

  const narrativeLines = wrapText(
    String(fields.narrative ?? ''),
    font,
    NARRATIVE_FONT_SIZE,
    REPORT_PAGE.width - REPORT_MARGIN * 2,
  );
  for (const line of narrativeLines) {
    ensure(NARRATIVE_LEADING + 4);
    page.drawText(line, { x: REPORT_MARGIN, y, size: NARRATIVE_FONT_SIZE, font, color: BODY_INK });
    y -= NARRATIVE_LEADING;
  }

  // ── Signature blocks ─────────────────────────────────────────────────────
  // "Signature over printed name": the drawn signature sits on the rule, the
  // name and role are printed beneath it — the arrangement the Admission Slip,
  // the discharge report and the education report all use.
  const drawSignatureBlock = async (options: {
    label: string;
    signature?: string | null;
    name: string;
    title?: string;
  }) => {
    // The rhythm the printed form uses, widened just enough to hold a drawn
    // signature: 14 pt from the rule to the name and from the name to the role,
    // and a clearly larger 30 pt between one block and the next. The first
    // output had the block gap *smaller* than the label-to-rule gap, which read
    // as the blocks running into each other.
    const blockHeight = 22 + 12 + SIGNATURE_HEIGHT + 13 + (options.title ? 13 : 0) + 10;
    ensure(blockHeight);
    y -= 22;

    page.drawText(options.label, { x: REPORT_MARGIN, y, size: LABEL_FONT_SIZE, font: bold, color: INK });

    const ruleY = y - 12 - SIGNATURE_HEIGHT;
    if (options.signature) {
      await drawSignatureImageOnPage(pdf, page, options.signature, {
        x: REPORT_MARGIN,
        y: ruleY,
        width: SIGNATURE_RULE_WIDTH,
        height: SIGNATURE_HEIGHT,
      });
    }
    page.drawLine({
      start: { x: REPORT_MARGIN, y: ruleY },
      end: { x: REPORT_MARGIN + SIGNATURE_RULE_WIDTH, y: ruleY },
      thickness: 0.75,
      color: RULE,
    });

    y = ruleY - 13;
    page.drawText(options.name, { x: REPORT_MARGIN, y, size: LABEL_FONT_SIZE, font, color: BODY_INK });
    if (options.title) {
      y -= 13;
      page.drawText(options.title, { x: REPORT_MARGIN, y, size: LABEL_FONT_SIZE, font, color: BODY_INK });
    }
  };

  await drawSignatureBlock({
    label: 'Prepared by:',
    signature: fields.preparedBySignature,
    name: fields.preparedByName,
    title: 'Program in-charge',
  });
  await drawSignatureBlock({
    label: 'Checked by:',
    signature: fields.checkedBySignature,
    name: fields.checkedByName,
  });
  await drawSignatureBlock({
    label: 'Noted by:',
    signature: fields.notedBySignature,
    name: fields.notedByName,
    title: fields.notedByTitle,
  });

  return pdf.save();
}

/** Fetch the blank official form. */
export async function loadProgressReportTemplate(): Promise<ArrayBuffer> {
  const response = await fetch(PROGRESS_REPORT_TEMPLATE_URL);
  if (!response.ok) throw new Error('Could not load the official Progress Report form.');
  return response.arrayBuffer();
}

/** Fill the form and hand it back as a `data:` URL, the shape the Documents module stores. */
export async function generateProgressReportPdf(
  fields: ProgressReportFields,
): Promise<{ dataUrl: string; size: number }> {
  const template = await loadProgressReportTemplate();
  const bytes = await buildProgressReportPdf(fields, template);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return { dataUrl: `data:application/pdf;base64,${btoa(binary)}`, size: bytes.length };
}
