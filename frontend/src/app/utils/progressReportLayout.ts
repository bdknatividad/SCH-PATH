/**
 * The measured geometry of the official "PROGRESS REPORT" form.
 *
 * Every number here was read out of the real PDF
 * (`public/forms/progress-report.pdf`) by decompressing its page content stream
 * and decoding the text runs and rules — not estimated from a screenshot. The
 * editor and the PDF writer both read these, so an input box and the value drawn
 * under it cannot land in different places.
 *
 * **Where the real form ends and the app takes over.** The printed table's rows
 * are 14.3 pt tall — one line of text each — and the rows below them are fixed
 * on the page. There is no way to type a sentence into a cell and keep the
 * printed form intact underneath, so the page is split:
 *
 *   - **`TABLE_TOP_Y` and above** is the real PDF, untouched: the letterhead, the
 *     title, the `(PROGRAM)` line and the `RESIDENT:` line. That is the part
 *     people recognise, and it stays the file the agency issued.
 *   - **Below it** the app draws the form — the table, the narrative and the
 *     three signature blocks — using the same column positions and rules, so it
 *     looks the same but the rows can grow and rows can be added.
 *
 * Coordinates are PDF points, **y measured from the bottom of the page**, which
 * is the PDF's own convention. The editor converts; the writer does not.
 *
 * @module utils/progressReportLayout
 */

export const REPORT_PAGE = { width: 612, height: 792 } as const;

/** The form's left and right text margin. */
export const REPORT_MARGIN = 72;

/**
 * The table's top rule. Everything above this comes from the real PDF.
 *
 * The value is the printed table's top edge, so the app-drawn table starts
 * exactly where the printed one does and the two line up at the seam.
 */
export const TABLE_TOP_Y = 590.26;

/** The printed table's vertical rules, left edge first — five boundaries, four columns. */
export const TABLE_COLUMN_X = [72.5, 160.58, 335.47, 413.47, 539.62] as const;

/** 590.26 → 562.18 on the printed form. */
export const TABLE_HEADER_HEIGHT = 28.08;

export const TABLE_HEADINGS = [
  'AREA OF CONCERN',
  'OBSERVATIONS/PROGRESS',
  'ACTION TAKEN',
  'RECOMMENDATION',
] as const;

/** The right edge of the table = the form's right margin. */
export const TABLE_RIGHT_X = TABLE_COLUMN_X[TABLE_COLUMN_X.length - 1];

/**
 * The `(PROGRAM)` line — the run of underscores the program name is written on.
 *
 * Measured at x=195.05, 12 pt, and centred on the page: the label below it sits
 * at x=271.01, which is the same centre.
 */
export const PROGRAM_LINE = { x: 195.05, y: 657.22, width: 222, height: 16 } as const;

/**
 * Where the resident's name goes on the `RESIDENT:` line.
 *
 * The printed label starts at the margin; its own width in Calibri 12 pt is
 * ≈57 pt, so the blank begins at ≈131.
 */
export const RESIDENT_NAME = { x: 131, y: 605.26, width: 199, height: 16 } as const;

/**
 * Bands to mask before writing on a printed line.
 *
 * Both blanks on the untouched part of the form are runs of **underscore
 * glyphs**, not rules. Drawing a value on top of one leaves the underscores
 * running through the middle of the words, which reads as a strikethrough —
 * the first real output did exactly that. So the run is covered and a clean
 * rule is drawn in its place.
 *
 * The bands are kept clear of everything else on their line: the program line
 * has nothing but underscores on it, and the resident band starts just past the
 * printed `RESIDENT:` label so the label survives.
 */
export const PROGRAM_LINE_MASK = { x: 150, y: 649, width: 410, height: 15 } as const;
export const RESIDENT_NAME_MASK = { x: 126, y: 597, width: 434, height: 15 } as const;

/** How far each clean rule runs — the printed underscores' own extent. */
export const PROGRAM_LINE_RULE_WIDTH = 225;
export const RESIDENT_NAME_RULE_WIDTH = 199;

/** The names the official form prints, which the app redraws below the table. */
export const REPORT_CHECKED_BY_NAME = 'Francis Patricio, RSW';
export const REPORT_NOTED_BY_NAME = 'Maricor C. Navarro, RSW, MSSW';
export const REPORT_NOTED_BY_TITLE = 'Center Head, SCH';
