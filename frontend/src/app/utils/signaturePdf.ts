import type { PDFDocument, PDFPage } from 'pdf-lib';

/**
 * Shared plumbing for stamping a drawn staff signature onto a generated PDF.
 *
 * Both Admission Slip renderers (the Child Records editor and the Child Detail
 * print action) build the same document from the same template, so the box
 * geometry and the embed/scale logic live here instead of being written twice.
 */

export interface SignatureBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The blank band on the official Admission Slip reserved for the Houseparent on
 * Duty signature, in the slip's top-left coordinate space. The on-screen overlay
 * and the PDF renderer both read this, so a signature lands exactly where the
 * signer drew it.
 *
 * The band is bounded above by the referring-party caption (which ends at
 * y = 431) and below by the "Houseparent on Duty" field, whose text sits on the
 * printed rule at y = 475. It is only the caption and the rule that are printed
 * — nothing is inked between them — so the signature has to stop above the
 * dropdown to stay clickable. Keep this clear of `pdfFieldStyle(80.025, 463, …)`
 * in ChildRecords.tsx; the test suite asserts they do not overlap.
 */
export const ADMISSION_HOUSEPARENT_SIGNATURE_BOX: SignatureBox = {
  x: 80,
  y: 432,
  width: 215,
  height: 30,
};

/**
 * The blank band reserved for the Referring Party signature, in the same
 * top-left coordinate space as the box above.
 *
 * Measured against the template: the "Referring Party:" label sits on its own
 * line and only runs from x = 81.5 to x = 155.5 — nothing else is printed on
 * that line. Sized up from the original compact field so the pad has real
 * room to sign in and the Clear/Redo buttons don't sit over the drawing
 * area: it now uses nearly all the blank space in that row, stopping just
 * clear of the guardian row above (ending at y = 371.33) and the referring
 * party's own name/contact line below (starting at y = 406.52).
 */
export const ADMISSION_REFERRING_PARTY_SIGNATURE_BOX: SignatureBox = {
  x: 158,
  y: 373,
  width: 120,
  height: 32,
};

/**
 * The blank band reserved for the Signature of Guardian field, in the same
 * top-left coordinate space as the boxes above.
 *
 * Measured against the template: "Signature of Guardian:" sits on the same
 * printed line as "Complete Address:" (the guardian's), ending at x = 504,
 * with a blank rule running from x = 508 to x = 704.5. Sized up from the
 * original compact field so the pad has real room to sign in and the
 * Clear/Redo buttons don't sit over the drawing area: it now uses most of
 * the blank rule's width, stopping just clear of the guardian contact row
 * above (ending at y = 344.5) and the "Referring Party:" line below
 * (starting at y = 380).
 */
export const ADMISSION_GUARDIAN_SIGNATURE_BOX: SignatureBox = {
  x: 513,
  y: 348,
  width: 165,
  height: 28,
};

/**
 * The blank band reserved for the Signature of Resident field, in the same
 * top-left coordinate space as the boxes above.
 *
 * Measured against the template: "Signature of Resident:" sits on the same
 * printed line as the resident's "Complete Address:", ending at x = 503.5,
 * with a blank rule running from x = 503.5 to x = 706.5. Same size as the
 * Guardian signature box, positioned the same way relative to its own row:
 * clear of the label to its left, clear of the Age/Sex/DOB/Religion row
 * above (ending at y = 270.67), and well clear of the Name of Guardian row
 * below (starting at y = 332.5).
 */
export const ADMISSION_RESIDENT_SIGNATURE_BOX: SignatureBox = {
  x: 513,
  y: 274,
  width: 165,
  height: 28,
};

/**
 * Converts a top-left box (how the slip overlay is laid out) into pdf-lib's
 * bottom-left coordinate space.
 */
export function toPdfBox(box: SignatureBox, pageHeight: number): SignatureBox {
  return {
    x: box.x,
    y: pageHeight - box.y - box.height,
    width: box.width,
    height: box.height,
  };
}

/**
 * Draws a saved signature into `box`, scaled to fit without distortion and
 * centred inside it.
 *
 * Returns `false` when the value is missing or is not a PNG/JPEG data URL, so
 * callers can leave the printed name as the only mark on the line.
 */
export async function drawSignatureImage(
  pdfDoc: PDFDocument,
  dataUrl: string | null | undefined,
  box: SignatureBox,
  pageIndex = 0
): Promise<boolean> {
  return drawSignatureImageOnPage(pdfDoc, pdfDoc.getPage(pageIndex), dataUrl, box);
}

/**
 * Same as {@link drawSignatureImage}, for documents whose signature lands on a
 * page other than the first, or on a page that may have been added part-way
 * through building the document.
 */
export async function drawSignatureImageOnPage(
  pdfDoc: PDFDocument,
  page: PDFPage,
  dataUrl: string | null | undefined,
  box: SignatureBox
): Promise<boolean> {
  const value = String(dataUrl || '');
  const match = value.match(/^data:image\/(png|jpeg|jpg);base64,/i);
  if (!match) return false;

  try {
    const image =
      match[1].toLowerCase() === 'png'
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
    // A corrupt data URL must not abort the whole document.
    return false;
  }
}
