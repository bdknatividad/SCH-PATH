/**
 * Which documents are Quarterly Progress Reports, and which quarter one covers.
 *
 * A **leaf module** on purpose. Three different places need these answers:
 * `ProgressReportDialog` (react-pdf), `progressReportApproval` (pdf-lib) and the
 * Reports module's consolidation list. The list only needs the two strings and a
 * regex, so keeping them here is what stops a screen that merely *lists* the
 * reports from pulling pdf-lib into its chunk to read a label.
 *
 * @module utils/progressReportTypes
 */

/** The `(PROGRAM)` line the Education module's report carries. */
export const EDUCATION_PROGRESS_PROGRAM = 'Education Quarterly Report';

/** The `(PROGRAM)` line the Health module's report carries. */
export const MEDICAL_PROGRESS_PROGRAM = 'Medical Quarterly Report';

/**
 * The document types the shared PROGRESS REPORT form produces.
 *
 * The order is the order the Reports module lists them in, so the two program
 * blocks always appear the same way round.
 */
export const PROGRESS_REPORT_TYPES: string[] = [
  EDUCATION_PROGRESS_PROGRAM,
  MEDICAL_PROGRESS_PROGRAM,
];

/** `Q3` — the calendar quarter a date falls in. */
export function calendarQuarter(date = new Date()): string {
  return `Q${Math.floor(date.getMonth() / 3) + 1}`;
}

/**
 * The document type of a program's progress report.
 *
 * `title` is the fallback because the two are written together by the form, and
 * a row that carries only one of them should still be found rather than dropped
 * out of the consolidation silently.
 */
export function progressReportProgramOf(document: any): string {
  const label = String(document?.type || document?.title || '').trim();
  return PROGRESS_REPORT_TYPES.includes(label) ? label : '';
}

export function isProgressReportDocument(document: any): boolean {
  return Boolean(progressReportProgramOf(document));
}

/**
 * The quarter a filed report covers, read back out of the document.
 *
 * Read from `description` first and the file name second, matching how the
 * education module has always recorded it — the quarter has to survive on the
 * stored row or the once-a-quarter rule cannot see that a quarter is taken.
 */
export function progressReportQuarterKey(document: any): string | null {
  const text = `${document?.description || ''} ${document?.fileName || ''}`;
  const explicit = text.match(/REPORT\s+QUARTER\s*:\s*(Q[1-4])\s+REPORT\s+YEAR\s*:\s*(\d{4})/i);
  if (explicit) return `${explicit[1].toUpperCase()} ${explicit[2]}`;
  const fromFile = String(document?.fileName || '').match(/Progress_Report_(Q[1-4])_(\d{4})_/i);
  return fromFile ? `${fromFile[1].toUpperCase()} ${fromFile[2]}` : null;
}

/** The quarter a report covers *if* it belongs to `program`, else `null`. */
export function reportQuarterOf(document: any, program: string): string | null {
  if (progressReportProgramOf(document) !== program) return null;
  return progressReportQuarterKey(document);
}

/** `Q3 2026` → `20263`, so the quarters sort newest first without a date parse. */
export function quarterSortKey(key: string): number {
  const match = String(key || '').match(/^Q([1-4])\s+(\d{4})$/);
  return match ? Number(match[2]) * 10 + Number(match[1]) : 0;
}
