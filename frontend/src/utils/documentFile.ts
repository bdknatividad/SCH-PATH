/**
 * Saving a stored document to disk — the one implementation.
 *
 * The lists are fed by `/store`, which deliberately omits `fileData` (base64
 * files would bloat every page load), so an `<a href={doc.fileData}>` link never
 * renders. The bytes are fetched on demand instead, which also guarantees the
 * saved file is exactly what View shows.
 *
 * This lived inside `DocumentUpload.tsx`. The Health module needs the same
 * behaviour for the medical documents it mirrors out of the Documents module,
 * and a second copy is how two downloads of the same file start to differ.
 */

import { fetchBinary } from '../services/api';

export interface DownloadableDocument {
  id: string;
  fileName?: string | null;
  title?: string | null;
}

/**
 * Fetch the stored binary and save it under the document's real filename.
 *
 * A failure is reported through `onError` rather than the `alert()` this used to
 * call — a browser box titled with the page's origin is not how a download
 * should fail. When no reporter is supplied the failure goes to the console
 * only: a module that forgets one shows nothing rather than the wrong thing.
 */
export async function downloadDocumentFile(
  doc: DownloadableDocument,
  onError?: (message: string) => void,
): Promise<void> {
  try {
    const { blob, fileName } = await fetchBinary(`/documents/${doc.id}/file`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || doc.fileName || doc.title || 'document';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error: any) {
    const message = error?.message || 'Could not download the file.';
    if (onError) onError(message); else console.error('Document download failed:', message);
  }
}
