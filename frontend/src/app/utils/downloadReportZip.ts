/**
 * Build one ZIP out of several generated report PDFs.
 *
 * The reports module downloads each report from its own PDF endpoint — TRI,
 * Anecdotal and Quarterly each have one — and there was no way to take a whole
 * month or quarter in one go. This is the same shape as the Documents module's
 * bulk download (`DocumentUpload.downloadBulkZip`): JSZip is already a
 * dependency, each file is fetched with `fetchBinary`, and a file that fails is
 * skipped rather than aborting the archive.
 *
 * Sequential on purpose. A month of TRIs is ~500 KB each, and firing twenty
 * requests at once to a single Railway container competes with whatever the
 * staff are doing; the loop also gives an honest "3 of 8" to show.
 *
 * Nothing is written to the server: the PDFs are already generated on demand,
 * and this only collects them in the browser.
 */

import JSZip from 'jszip';
import { fetchBinary } from '@/services/api';

export interface ReportZipItem {
  /** API path of the report's PDF, e.g. `/tri/TRI008/pdf`. */
  path: string;
  /** Fallback file name when the response carries no `Content-Disposition`. */
  name: string;
}

export interface ReportZipResult {
  included: number;
  /** Names of the reports that could not be fetched, for an honest message. */
  skipped: string[];
}

/**
 * Keep every entry name unique.
 *
 * Two residents can produce the same file name — the server's name is built from
 * the resident's name and the period, and a duplicate or a blank name would
 * otherwise make JSZip keep only the last one, silently dropping a report from
 * the archive.
 */
function uniqueEntryName(desired: string, used: Set<string>): string {
  const clean = desired.replace(/[\\/:*?"<>|]/g, '-').trim() || 'report.pdf';
  if (!used.has(clean)) {
    used.add(clean);
    return clean;
  }
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const extension = dot > 0 ? clean.slice(dot) : '';
  let counter = 2;
  let candidate = `${stem} (${counter})${extension}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${stem} (${counter})${extension}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Fetch every report and download them as a single ZIP.
 *
 * @param zipName the `.zip` file name the user receives
 * @param items   the reports to include, in the order they should appear
 * @param onProgress called after each file, for a "3 of 8" indicator
 */
export async function downloadReportZip(
  zipName: string,
  items: ReportZipItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<ReportZipResult> {
  const zip = new JSZip();
  const used = new Set<string>();
  const skipped: string[] = [];
  let included = 0;
  let done = 0;

  for (const item of items) {
    try {
      const { blob, fileName } = await fetchBinary(item.path);
      zip.file(uniqueEntryName(fileName || item.name, used), blob);
      included += 1;
    } catch {
      // One unavailable report must not cost the user the whole archive — the
      // same rule the Documents bulk download follows.
      skipped.push(item.name);
    } finally {
      done += 1;
      onProgress?.(done, items.length);
    }
  }

  if (included === 0) {
    throw new Error('None of the reports could be downloaded, so there is nothing to put in the ZIP.');
  }

  const content = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(content);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = zipName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on a delay so the download has started; revoking immediately cancels
  // it in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { included, skipped };
}

/** `TRI-Reports-2026-09.zip` — the month is zero-padded so the files sort. */
export function periodZipName(prefix: string, year: string | number, month: string | number): string {
  return `${prefix}-${year}-${String(month).padStart(2, '0')}.zip`;
}

/**
 * Save one report's PDF.
 *
 * The counterpart to the ZIP: same endpoints, same `fetchBinary`, one file. Used
 * by the per-resident rows in the Reports module so "give me this one" and "give
 * me all of them" sit next to each other instead of the single file living only
 * inside an editor.
 */
export async function downloadReportPdf(path: string, fallbackName: string): Promise<void> {
  const { blob, fileName } = await fetchBinary(path);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName || fallbackName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
