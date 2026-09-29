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

/** The document types the shared PROGRESS REPORT form produces. */
export const PROGRESS_REPORT_TYPES = ['Education Quarterly Report', 'Medical Quarterly Report'];

export function isProgressReportDocument(document: any): boolean {
  return PROGRESS_REPORT_TYPES.includes(String(document?.type || '').trim());
}

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

  let fields: ProgressReportFields;
  try {
    fields = JSON.parse(String(document?.reportData || ''));
  } catch {
    return null;
  }
  if (!fields || !Array.isArray(fields.rows)) return null;

  return generateProgressReportPdf({ ...fields, [field]: signature });
}
