/**
 * Render an HTML report to a PDF blob, so a generated report can be filed into
 * a resident's Documents folder instead of existing only as a print-out.
 *
 * Extracted from `PhaseProgress.tsx`, which grew it for the discharge report.
 * The Reports module files a report per resident and needs exactly the same
 * machinery, and two copies of a pagination routine is how one of them ends up
 * a page short.
 *
 * `html2canvas` and `jspdf` are imported on demand — together they outweigh
 * everything else the modules that use this carry, and a report is generated
 * rarely, so nobody should download them to open a phase checklist.
 *
 * The report is drawn into a hidden same-origin iframe rather than into this
 * document. A report's stylesheet uses bare selectors — `body`, `table`, `th`,
 * `.section`, `.header` — so mounting the markup here would restyle the entire
 * application the moment the report was generated. An iframe gets its own
 * document, and the styles stay inside it.
 *
 * The caller is expected to hand over markup that is safe to render headlessly:
 * a report that prints itself on load (`<script>window.onload … window.print()`,
 * which the Phase Timeline's discharge report does) is stripped here, and a
 * report whose screen-only chrome is styled with `@media print` should be built
 * without that chrome rather than relying on this — `html2canvas` does not apply
 * print media queries, so a toolbar hidden only for printing would be captured.
 */
/**
 * A blob as a `data:` URL, which is how the Documents module carries a file's
 * bytes (`DocumentWithApproval.fileData`).
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('The generated report could not be read.'));
    reader.onabort = () => reject(new Error('Reading the generated report was cancelled.'));
    reader.readAsDataURL(blob);
  });
}

export async function renderReportPdf(html: string): Promise<Blob> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);

  // The report prints itself on load. That must not fire inside a hidden frame.
  const printable = html.replace(/<script>window\.onload[\s\S]*?<\/script>/i, '');

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;';
  document.body.appendChild(frame);
  try {
    const frameDoc = frame.contentDocument;
    if (!frameDoc) throw new Error('The report frame could not be created.');
    frameDoc.open();
    frameDoc.write(printable);
    frameDoc.close();

    // One turn for the written document to lay out before it is measured.
    await new Promise(resolve => window.setTimeout(resolve, 250));

    const canvas = await html2canvas(frameDoc.body, {
      scale: 2,
      backgroundColor: '#ffffff',
      windowWidth: frameDoc.body.scrollWidth,
    });

    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imageHeight = (canvas.height * pageWidth) / canvas.width;
    const image = canvas.toDataURL('image/jpeg', 0.92);

    // A4 is shorter than the report, so the whole image is drawn once per page
    // with the overflow pushed above the top edge. A row can straddle a page
    // break; keeping whole sections together would mean paginating the report
    // itself rather than slicing one tall image.
    let drawn = 0;
    while (drawn < imageHeight) {
      pdf.addImage(image, 'JPEG', 0, -drawn, pageWidth, imageHeight);
      drawn += pageHeight;
      if (drawn < imageHeight) pdf.addPage();
    }

    return pdf.output('blob');
  } finally {
    frame.remove();
  }
}
