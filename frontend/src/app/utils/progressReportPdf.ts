/**
 * The "PROGRESS REPORT" form, drawn as a real PDF.
 *
 * One template, two producers: the Educator files an **Education** quarterly
 * report and the Nurse a **Medical** one. They differ only in the `(PROGRAM)`
 * line and who signs "Prepared by" — everything else is the same form, which is
 * why this is one generator with a `program` field rather than two.
 *
 * The layout mirrors the official Word template: the agency header (three logos
 * + the four-line agency block, lifted from the Admission Slip so the two
 * documents carry an identical letterhead), a centred title, the program line,
 * the resident, a four-column progress table, a narrative conclusion, and three
 * signature blocks.
 *
 * Drawn from scratch rather than overlaid on the template file: the table grows
 * with the number of areas of concern the author adds, which an overlay cannot
 * do, and the two producer variants would have needed two templates.
 *
 * @module utils/progressReportPdf
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { drawSignatureImageOnPage } from '@/app/utils/signaturePdf';

export interface ProgressReportRow {
  areaOfConcern: string;
  observations: string;
  actionTaken: string;
  recommendation: string;
}

export interface ProgressReportFields {
  /** Goes on the `(PROGRAM)` line — "Education Quarterly Report" or "Medical Quarterly Report". */
  program: string;
  /** "Q1".."Q4" — the quarter the report covers, shown under the title. */
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

export interface ProgressReportLogos {
  calamba: ArrayBuffer | Uint8Array;
  dswd: ArrayBuffer | Uint8Array;
  bagongPilipinas: ArrayBuffer | Uint8Array;
}

/** The three agency logos, as served from `public/logos/`. */
export const PROGRESS_REPORT_LOGO_URLS = {
  calamba: '/logos/calamba-seal.png',
  dswd: '/logos/dswd-logo.png',
  bagongPilipinas: '/logos/bagong-pilipinas.jpg',
} as const;

// ── Geometry ────────────────────────────────────────────────────────────────
// Letter, matching the Word template and the Admission Slip.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Header
const LOGO_TOP = PAGE_HEIGHT - MARGIN;
const LOGO_HEIGHT = 44;
const BAGONG_HEIGHT = 36;
const LOGO_GAP = 9;
const HEADER_TEXT_X = 214;
const HEADER_TEXT_LEADING = 13;

// Table column widths — must sum to CONTENT_WIDTH.
const COLUMN_WIDTHS = [130, 150, 110, 110];
const TABLE_HEADER_HEIGHT = 22;
const TABLE_MIN_ROW_HEIGHT = 38;
const TABLE_FONT_SIZE = 9;
const TABLE_LEADING = 11;
const TABLE_CELL_PADDING = 5;

// Signatures
const SIGNATURE_WIDTH = 190;
const SIGNATURE_HEIGHT = 30;

const INK = rgb(0.05, 0.05, 0.05);
const BODY_INK = rgb(0.12, 0.12, 0.12);
const RULE = rgb(0.45, 0.45, 0.45);
const GRID = rgb(0.62, 0.62, 0.62);

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const source = String(text ?? '');
  if (!source.trim()) return [''];
  const lines: string[] = [];
  // Respect explicit newlines the author typed, then wrap each paragraph.
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
 * Build the form. Pure — the logos are passed in so this can be exercised
 * without a browser (see the render check in the daily log).
 */
export async function buildProgressReportPdf(
  fields: ProgressReportFields,
  logos: ProgressReportLogos,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const [calamba, dswd, bagong] = await Promise.all([
    pdf.embedPng(logos.calamba),
    pdf.embedPng(logos.dswd),
    pdf.embedJpg(logos.bagongPilipinas),
  ]);

  let page: PDFPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = 0;

  const newPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  };

  /** Start a page if `needed` points would not fit above the bottom margin. */
  const ensure = (needed: number) => {
    if (y - needed < MARGIN) newPage();
  };

  // ── Letterhead ────────────────────────────────────────────────────────────
  // Same arrangement as the Admission Slip: three logos, then the agency block.
  const logoBottom = LOGO_TOP - LOGO_HEIGHT;
  page.drawImage(calamba, { x: MARGIN, y: logoBottom, width: LOGO_HEIGHT, height: LOGO_HEIGHT });
  const dswdWidth = (dswd.width / dswd.height) * LOGO_HEIGHT;
  const dswdX = MARGIN + LOGO_HEIGHT + LOGO_GAP;
  page.drawImage(dswd, { x: dswdX, y: logoBottom, width: dswdWidth, height: LOGO_HEIGHT });
  const bagongWidth = (bagong.width / bagong.height) * BAGONG_HEIGHT;
  const bagongX = dswdX + dswdWidth + LOGO_GAP;
  page.drawImage(bagong, {
    x: bagongX,
    y: logoBottom + (LOGO_HEIGHT - BAGONG_HEIGHT) / 2,
    width: bagongWidth,
    height: BAGONG_HEIGHT,
  });

  const agencyLines: Array<[string, number, boolean]> = [
    ['Republic of the Philippines', 10, false],
    ['Province of Laguna', 10, false],
    ['CITY GOVERNMENT OF CALAMBA', 10, false],
    ['CITY SOCIAL SERVICES DEPARTMENT', 13, true],
  ];
  let headerY = LOGO_TOP - 8;
  for (const [text, size, isBold] of agencyLines) {
    page.drawText(text, {
      x: HEADER_TEXT_X,
      y: headerY,
      size,
      font: isBold ? bold : font,
      color: INK,
    });
    headerY -= HEADER_TEXT_LEADING;
  }

  y = Math.min(logoBottom, headerY + HEADER_TEXT_LEADING) - 12;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 1,
    color: INK,
  });

  // ── Title and period ──────────────────────────────────────────────────────
  y -= 22;
  const title = 'PROGRESS REPORT';
  page.drawText(title, {
    x: (PAGE_WIDTH - bold.widthOfTextAtSize(title, 15)) / 2,
    y,
    size: 15,
    font: bold,
    color: INK,
  });

  y -= 16;
  const period = `Quarter Covered: ${fields.quarter} ${fields.year}`;
  page.drawText(period, {
    x: (PAGE_WIDTH - font.widthOfTextAtSize(period, 10)) / 2,
    y,
    size: 10,
    font,
    color: BODY_INK,
  });

  // ── Program line, with the "(PROGRAM)" label beneath ──────────────────────
  y -= 26;
  const program = String(fields.program || '').trim();
  const programSize = 12;
  const programWidth = bold.widthOfTextAtSize(program, programSize);
  const programRuleWidth = Math.min(CONTENT_WIDTH - 60, Math.max(programWidth + 90, 260));
  const programRuleX = (PAGE_WIDTH - programRuleWidth) / 2;
  page.drawText(program, {
    x: (PAGE_WIDTH - programWidth) / 2,
    y: y + 3,
    size: programSize,
    font: bold,
    color: INK,
  });
  page.drawLine({
    start: { x: programRuleX, y },
    end: { x: programRuleX + programRuleWidth, y },
    thickness: 0.75,
    color: RULE,
  });

  y -= 11;
  const programLabel = '(PROGRAM)';
  page.drawText(programLabel, {
    x: (PAGE_WIDTH - font.widthOfTextAtSize(programLabel, 8)) / 2,
    y,
    size: 8,
    font,
    color: BODY_INK,
  });

  // ── Resident ──────────────────────────────────────────────────────────────
  y -= 20;
  const residentLine = `RESIDENT: ${fields.residentName}${fields.residentId ? `  (${fields.residentId})` : ''}`;
  page.drawText(residentLine, { x: MARGIN, y, size: 11, font: bold, color: INK });

  // ── Progress table ────────────────────────────────────────────────────────
  y -= 16;
  const columnX: number[] = [];
  {
    let cursor = MARGIN;
    for (const width of COLUMN_WIDTHS) {
      columnX.push(cursor);
      cursor += width;
    }
  }
  const tableLeft = MARGIN;
  const tableRight = MARGIN + CONTENT_WIDTH;
  const tableBottomY = () => y;

  const drawTableHeader = () => {
    const top = y;
    page.drawRectangle({
      x: tableLeft,
      y: top - TABLE_HEADER_HEIGHT,
      width: CONTENT_WIDTH,
      height: TABLE_HEADER_HEIGHT,
      color: rgb(0.95, 0.95, 0.94),
      borderColor: GRID,
      borderWidth: 0.5,
    });
    const headings = ['AREA OF CONCERN', 'OBSERVATIONS/PROGRESS', 'ACTION TAKEN', 'RECOMMENDATION'];
    headings.forEach((heading, index) => {
      page.drawText(heading, {
        x: columnX[index] + TABLE_CELL_PADDING,
        y: top - TABLE_HEADER_HEIGHT / 2 - 3,
        size: 8,
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
    const cells = [row.areaOfConcern, row.observations, row.actionTaken, row.recommendation]
      .map((cell, index) => wrapText(String(cell ?? ''), font, TABLE_FONT_SIZE, COLUMN_WIDTHS[index] - TABLE_CELL_PADDING * 2));

    const contentHeight = Math.max(...cells.map(lines => lines.length)) * TABLE_LEADING;
    const rowHeight = Math.max(TABLE_MIN_ROW_HEIGHT, contentHeight + TABLE_CELL_PADDING * 2);

    // Keep the header with at least the first row, and never split a row.
    ensure(rowHeight);
    if (y === PAGE_HEIGHT - MARGIN && rowIndex > 0) {
      page.drawLine({ start: { x: tableLeft, y }, end: { x: tableRight, y }, thickness: 0.5, color: GRID });
      drawTableHeader();
    }

    const rowTop = y;
    const rowBottom = rowTop - rowHeight;

    page.drawRectangle({
      x: tableLeft,
      y: rowBottom,
      width: CONTENT_WIDTH,
      height: rowHeight,
      borderColor: GRID,
      borderWidth: 0.5,
    });
    for (let i = 1; i < columnX.length; i += 1) {
      page.drawLine({
        start: { x: columnX[i], y: rowBottom },
        end: { x: columnX[i], y: rowTop },
        thickness: 0.5,
        color: GRID,
      });
    }

    cells.forEach((lines, index) => {
      let textY = rowTop - TABLE_CELL_PADDING - TABLE_FONT_SIZE;
      for (const line of lines) {
        page.drawText(line, {
          x: columnX[index] + TABLE_CELL_PADDING,
          y: textY,
          size: TABLE_FONT_SIZE,
          font,
          color: BODY_INK,
        });
        textY -= TABLE_LEADING;
      }
    });

    y = rowBottom;
  });

  // ── Narrative conclusion ──────────────────────────────────────────────────
  ensure(70);
  y -= 20;
  page.drawText('Narrative conclusion:', { x: MARGIN, y, size: 11, font: bold, color: INK });
  y -= 15;

  const narrativeLines = wrapText(String(fields.narrative ?? ''), font, 10, CONTENT_WIDTH);
  for (const line of narrativeLines) {
    ensure(14);
    page.drawText(line, { x: MARGIN, y, size: 10, font, color: BODY_INK });
    y -= 13;
  }

  // ── Signature blocks ──────────────────────────────────────────────────────
  // "Signature over printed name": the drawn signature sits on the rule, the
  // name and role are printed beneath it — the arrangement the rest of the
  // system already uses for the Admission Slip and the education report.
  const drawSignatureBlock = async (options: {
    label: string;
    signature?: string | null;
    name: string;
    title?: string;
  }) => {
    // The space the block actually consumes, measured from `y` *before* the
    // leading gap is deducted: 18 gap + 10 label-to-rule + the signature box +
    // 13 rule-to-name + 13 optional title + 13 trailing. Checking only the box
    // let the last block finish 1pt above the bottom margin.
    const blockHeight = 18 + 10 + SIGNATURE_HEIGHT + 13 + (options.title ? 13 : 0) + 13;
    ensure(blockHeight);
    y -= 18;

    page.drawText(options.label, { x: MARGIN, y, size: 11, font: bold, color: INK });

    const ruleY = y - 10 - SIGNATURE_HEIGHT;
    if (options.signature) {
      await drawSignatureImageOnPage(pdf, page, options.signature, {
        x: MARGIN,
        y: ruleY,
        width: SIGNATURE_WIDTH,
        height: SIGNATURE_HEIGHT,
      });
    }
    page.drawLine({
      start: { x: MARGIN, y: ruleY },
      end: { x: MARGIN + SIGNATURE_WIDTH, y: ruleY },
      thickness: 0.75,
      color: RULE,
    });

    y = ruleY - 13;
    page.drawText(options.name, { x: MARGIN, y, size: 11, font, color: BODY_INK });
    if (options.title) {
      y -= 13;
      page.drawText(options.title, { x: MARGIN, y, size: 10, font, color: BODY_INK });
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

/** Fetch the letterhead logos. Served from `public/logos/`. */
export async function loadProgressReportLogos(): Promise<ProgressReportLogos> {
  const [calamba, dswd, bagongPilipinas] = await Promise.all(
    Object.values(PROGRESS_REPORT_LOGO_URLS).map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load the report letterhead (${url}).`);
      return response.arrayBuffer();
    }),
  );
  return { calamba, dswd, bagongPilipinas };
}

/** Build the form and hand it back as a `data:` URL, the shape the Documents module stores. */
export async function generateProgressReportPdf(
  fields: ProgressReportFields,
): Promise<{ dataUrl: string; size: number }> {
  const logos = await loadProgressReportLogos();
  const bytes = await buildProgressReportPdf(fields, logos);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return { dataUrl: `data:application/pdf;base64,${btoa(binary)}`, size: bytes.length };
}
