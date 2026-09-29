/**
 * Signing a generated quarterly Progress Report at approval time.
 *
 * The author signs "Prepared by" when they fill the form in. The *reviewer*
 * signs later, in the Documents module, and their signature has to end up on the
 * same PDF — which is why the author's answers are stored on the document
 * (`reportData`) rather than only inside the file. The form is drawn again here
 * with one more signature in it, and that drawing replaces the stored file.
 *
 * The signature lands on the line the reviewer's role owns: the Social Worker
 * signs "Checked by", the Center Head "Noted by" — the two printed names on the
 * official form. A role that owns neither line has no signature to add, and the
 * report is approved exactly as it was submitted.
 *
 * @module utils/progressReportApproval
 */

import { generateProgressReportPdf, type ProgressReportFields } from '@/app/utils/progressReportPdf';
import { PROGRESS_REPORT_TYPES, isProgressReportDocument } from '@/app/utils/progressReportTypes';

/**
 * Which documents are these reports, and which quarter one covers, come from
 * `utils/progressReportTypes` — a module with no PDF dependency. They are
 * re-exported here because this is where the Documents module has always read
 * them from, and re-exporting keeps that import working while letting the
 * Reports module list the reports without pulling pdf-lib in to do it.
 */
export { PROGRESS_REPORT_TYPES, isProgressReportDocument };

/**
 * Which printed line this role signs, or `null` if it owns neither.
 *
 * `admin` is grouped with the Center Head because the two are interchangeable
 * throughout this system — `APPROVER_ROLES` treats them the same, and the
 * Center Head's line is the one the head of the facility signs.
 */
export function progressReportSignatureField(
  role: string,
): 'checkedBySignature' | 'notedBySignature' | null {
  switch (String(role || '').trim().toLowerCase()) {
    case 'socialworker':
      return 'checkedBySignature';
    case 'centerhead':
    case 'admin':
      return 'notedBySignature';
    default:
      return null;
  }
}

/**
 * The stored answers, whether the server handed them over parsed or as text.
 *
 * **`documents.reportData` is a `jsonField` in `backend/src/utils/constants.js`,
 * so `mapRow` parses it on the way out and the browser receives an object** —
 * not the JSON string the form sent. Reading only the string shape is what
 * silently cost every reviewer their signature: `JSON.parse('[object Object]')`
 * throws, `signProgressReportPdf` returned `null`, and the approval went through
 * on an unsigned file while the screen said it had been signed. Both shapes are
 * accepted, because a row straight out of `POST /documents` is still a string.
 */
export function readProgressReportFields(value: unknown): ProgressReportFields | null {
  if (!value) return null;
  let fields: any = value;
  if (typeof value === 'string') {
    try {
      fields = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!fields || typeof fields !== 'object' || !Array.isArray(fields.rows)) return null;
  return fields as ProgressReportFields;
}

/**
 * Draw the report again with the reviewer's signature in it.
 *
 * Returns `null` — rather than throwing — when there is nothing to sign or the
 * stored answers cannot be read. The caller then simply approves the document as
 * it stands, so an unreadable `reportData` costs the signature, not the
 * approval.
 */
export async function signProgressReportPdf(
  document: any,
  role: string,
  signature: string,
): Promise<{ dataUrl: string; size: number } | null> {
  const field = progressReportSignatureField(role);
  if (!field || !signature) return null;

  const fields = readProgressReportFields(document?.reportData);
  if (!fields) return null;

  return generateProgressReportPdf({ ...fields, [field]: signature });
}
