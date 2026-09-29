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
 * Measured out of the real form: the underscore run starts at x=195.05 and ends
 * at **420.07**, and its ink box spans y 654.64 → 668.57. `y` here is the rule's
 * own line, which is the printed baseline (657.22); the value is drawn 4 pt above
 * it. The label below sits at x=271.01, which is the same centre.
 */
export const PROGRAM_LINE = { x: 195.05, y: 657.22, width: 225.02, height: 16 } as const;

/**
 * Where the resident's name goes on the `RESIDENT:` line.
 *
 * The printed label is not ≈57 pt wide, which is what this used to assume: it
 * runs from the margin to **x=134.74** (`RESIDENT:`, Arial 12 pt), then a space,
 * then the underscore run from **138.11 to 291.38**. Starting the value at 131
 * therefore wrote the name straight through the `T:` of the label — the first
 * real output read `RESIDENChristian Secret Victoria`. `x` is the rule's start,
 * so it is the underscore run's own left edge.
 */
export const RESIDENT_NAME = { x: 138.11, y: 605.26, width: 153.27, height: 16 } as const;

/**
 * Bands to mask before writing on a printed line.
 *
 * Both blanks on the untouched part of the form are runs of **underscore
 * glyphs**, not rules. Drawing a value on top of one leaves the underscores
 * running through the middle of the words, which reads as a strikethrough —
 * the first real output did exactly that. So the run is covered and a clean
 * rule is drawn in its place.
 *
 * **A band has to cover the whole ink box, not just the middle of it.** The
 * printed text's box is 13.4 pt tall (`RESIDENT:` spans y 602.74 → 616.12), and
 * the first version masked 15 pt starting 5 pt too low — so the top of every
 * letter survived and the label showed through above the mask as half-height
 * glyphs. Both bands are now the measured box plus a little clearance.
 *
 * And a band must not start inside the label it is meant to preserve: the
 * resident band begins at 136, just past the printed `RESIDENT:`.
 */
export const PROGRAM_LINE_MASK = { x: 193, y: 652, width: 230, height: 17.5 } as const;
export const RESIDENT_NAME_MASK = { x: 136, y: 600.5, width: 170, height: 17.5 } as const;

/** How far each clean rule runs — the printed underscores' own extent. */
export const PROGRAM_LINE_RULE_WIDTH = 225.02;
export const RESIDENT_NAME_RULE_WIDTH = 153.27;

/** The names the official form prints, which the app redraws below the table. */
export const REPORT_CHECKED_BY_NAME = 'Francis Patricio, RSW';
export const REPORT_NOTED_BY_NAME = 'Maricor C. Navarro, RSW, MSSW';
export const REPORT_NOTED_BY_TITLE = 'Center Head, SCH';
