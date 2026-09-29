import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document as PdfDocument, Page as PdfPage, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/app/components/ui/dialog';
import { Button } from '@/app/components/ui/button';
import { Label } from '@/app/components/ui/label';
import { Loader2, Plus, Trash2, PenLine } from 'lucide-react';
import { SignaturePadModal } from '@/app/components/SignaturePad';
import { useData } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { useSystemDialog } from '@/app/components/SystemDialog';
import { describeError } from '@/services/api';
import {
  generateProgressReportPdf,
  PROGRESS_REPORT_TEMPLATE_URL,
  type ProgressReportRow,
} from '@/app/utils/progressReportPdf';
import {
  REPORT_PAGE,
  REPORT_MARGIN,
  TABLE_TOP_Y,
  TABLE_COLUMN_X,
  TABLE_HEADER_HEIGHT,
  TABLE_HEADINGS,
  PROGRAM_LINE,
  RESIDENT_NAME,
  REPORT_CHECKED_BY_NAME,
  REPORT_NOTED_BY_NAME,
  REPORT_NOTED_BY_TITLE,
} from '@/app/utils/progressReportLayout';

pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.mjs?v=${pdfjs.version}`;

/** The two documents this form produces. The wording goes on the `(PROGRAM)` line. */
export const EDUCATION_PROGRESS_PROGRAM = 'Education Quarterly Report';
export const MEDICAL_PROGRESS_PROGRAM = 'Medical Quarterly Report';

/** The printed column widths, derived once from the measured boundaries. */
const COLUMN_WIDTHS = TABLE_COLUMN_X.slice(1).map((x, i) => x - TABLE_COLUMN_X[i]);

/** One entry per printed column, in order, with the field it holds. */
const TABLE_CELLS: Array<[keyof ProgressReportRow, string, number]> = [
  ['areaOfConcern', 'Area of concern', 0],
  ['observations', 'Observations / progress', 1],
  ['actionTaken', 'Action taken', 2],
  ['recommendation', 'Recommendation', 3],
];
/** How much of the printed page survives above the table — the part that is not redrawn. */
const KEPT_HEIGHT = REPORT_PAGE.height - TABLE_TOP_Y;

export function calendarQuarter(date = new Date()): string {
  return `Q${Math.floor(date.getMonth() / 3) + 1}`;
}

/**
 * The quarter a filed report covers, read back out of the document.
 *
 * Read from `description` first and the file name second, matching how the
 * education module has always recorded it — the quarter has to survive on the
 * stored row or the once-a-quarter rule cannot see that a quarter is taken.
 */
export function reportQuarterOf(doc: any, program: string): string | null {
  if (String(doc?.title || '') !== program) return null;
  const text = `${doc?.description || ''} ${doc?.fileName || ''}`;
  const explicit = text.match(/REPORT\s+QUARTER\s*:\s*(Q[1-4])\s+REPORT\s+YEAR\s*:\s*(\d{4})/i);
  if (explicit) return `${explicit[1].toUpperCase()} ${explicit[2]}`;
  const fromFile = String(doc?.fileName || '').match(/Progress_Report_(Q[1-4])_(\d{4})_/i);
  return fromFile ? `${fromFile[1].toUpperCase()} ${fromFile[2]}` : null;
}

const emptyRow = (): ProgressReportRow => ({
  areaOfConcern: '',
  observations: '',
  actionTaken: '',
  recommendation: '',
});

/**
 * A textarea that grows with what is typed into it.
 *
 * The printed rows are one line tall and this form is filled in with sentences,
 * so a fixed-height box would hide most of what the author wrote. Growing the
 * box is what lets the table push the rest of the form down.
 */
function AutoTextarea({
  value,
  onChange,
  placeholder,
  minHeight,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  minHeight: number;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const resize = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.max(minHeight, node.scrollHeight)}px`;
  }, [minHeight]);

  useEffect(() => { resize(); }, [value, resize]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(event) => { onChange(event.target.value); resize(); }}
      placeholder={placeholder}
      rows={1}
      style={{ minHeight }}
      className={`w-full resize-none overflow-hidden bg-transparent outline-none focus:bg-yellow-50/60 ${className || ''}`}
    />
  );
}

interface ProgressReportDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * The resident the report is for. Optional on purpose: a module that has no
   * resident selected yet passes `residents` instead and the dialog asks, so the
   * form is never reachable-but-unusable behind a disabled button whose only
   * explanation is a tooltip.
   */
  residentId?: string;
  residentName?: string;
  /** Offered as a picker when `residentId` is not given. */
  residents?: Array<{ id: string; name: string }>;
  /** `EDUCATION_PROGRESS_PROGRAM` or `MEDICAL_PROGRESS_PROGRAM`. */
  program: string;
  /** Called after the report is filed, so the module can refresh its lists. */
  onSubmitted?: () => void;
}

/**
 * The shared Education / Health quarterly report form.
 *
 * **The official form is what gets filled in.** The page is rendered from
 * `public/forms/progress-report.pdf` — the file the agency issued — and the
 * input boxes sit on its own blanks, the way the TRI is filled in. Everything
 * above the table is that file, untouched: the letterhead, the title, the
 * `(PROGRAM)` line, the `RESIDENT:` line.
 *
 * From the table down the form is drawn by the app, on top of the printed one,
 * because the printed rows are one line tall and cannot move. See
 * `utils/progressReportLayout` for the measurement. That is what lets a row grow
 * with a sentence, rows be added, and the narrative run long.
 *
 * The author signs "Prepared by" and submits; the reviewers are alerted, and the
 * *reviewer* signs "Checked by" or "Noted by" at approval. Their signature needs
 * the same answers, which is why they are stored on the document
 * (`reportData`) rather than only inside the file.
 */
export function ProgressReportDialog({
  open,
  onClose,
  residentId,
  residentName,
  residents,
  program,
  onSubmitted,
}: ProgressReportDialogProps) {
  const { documents, addDocument } = useData();
  const { user } = useAuth();
  const dialog = useSystemDialog();

  const [pickedId, setPickedId] = useState('');
  const effectiveResidentId = residentId || pickedId;
  const effectiveResidentName = residentName
    || residents?.find((resident) => resident.id === effectiveResidentId)?.name
    || '';

  const [rows, setRows] = useState<ProgressReportRow[]>([emptyRow()]);
  const [narrative, setNarrative] = useState('');
  const [signature, setSignature] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const now = useMemo(() => new Date(), [open]);
  const quarter = calendarQuarter(now);
  const year = String(now.getFullYear());
  const quarterKey = `${quarter} ${year}`;

  /**
   * The quarter is taken when a report for it already exists — unless that
   * report was *rejected*, which is the only case the author may replace it in.
   */
  const existingForQuarter = useMemo(
    () => documents.find((doc: any) =>
      String(doc.residentId) === String(effectiveResidentId) &&
      reportQuarterOf(doc, program) === quarterKey
    ),
    [documents, effectiveResidentId, program, quarterKey],
  );
  const quarterIsTaken = Boolean(existingForQuarter) && existingForQuarter?.status !== 'Rejected';

  useEffect(() => {
    if (!open) return;
    setRows([emptyRow()]);
    setNarrative('');
    setSignature('');
    setError('');
    setSubmitting(false);
    setPickedId('');
  }, [open, residentId]);

  const setRow = (index: number, key: keyof ProgressReportRow, value: string) => {
    setRows(prev => prev.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  };
  const addRow = () => setRows(prev => [...prev, emptyRow()]);
  const removeRow = (index: number) =>
    setRows(prev => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));

  const handleSubmit = async () => {
    setError('');
    if (!effectiveResidentId) { setError('Choose the resident this report is for.'); return; }
    if (quarterIsTaken) {
      setError(`A ${program} for ${quarterKey} is already on file for ${effectiveResidentName}. Only a rejected report can be replaced.`);
      return;
    }
    const filled = rows.filter(row =>
      row.areaOfConcern.trim() || row.observations.trim() || row.actionTaken.trim() || row.recommendation.trim()
    );
    if (filled.length === 0) { setError('Add at least one area of concern.'); return; }
    if (!narrative.trim()) { setError('The narrative conclusion is required.'); return; }
    if (!signature) { setError('Sign the form before submitting.'); return; }

    const preparedByName =
      (user as any)?.fullName || (user as any)?.displayName || user?.username || 'Staff';

    setSubmitting(true);
    try {
      const fields = {
        program,
        quarter,
        year,
        residentName: effectiveResidentName,
        residentId: effectiveResidentId,
        rows: filled,
        narrative: narrative.trim(),
        preparedByName,
        preparedBySignature: signature,
        checkedByName: REPORT_CHECKED_BY_NAME,
        notedByName: REPORT_NOTED_BY_NAME,
        notedByTitle: REPORT_NOTED_BY_TITLE,
      };

      const { dataUrl, size } = await generateProgressReportPdf(fields);
      const fileName = `Progress_Report_${quarter}_${year}_${effectiveResidentName.replace(/\s+/g, '_')}.pdf`;

      await addDocument({
        residentId: effectiveResidentId,
        residentName: effectiveResidentName,
        title: program,
        type: program,
        // The category decides the folder *and* who may read it — see
        // `DOCUMENT_READ_ROLES_BY_CATEGORY`. It must match the document type, or
        // the reviewer the alert is addressed to is refused the file.
        category: program,
        description: [
          `${program} for ${effectiveResidentName}.`,
          `REPORT QUARTER: ${quarter}`,
          `REPORT YEAR: ${year}`,
        ].join(' '),
        fileName,
        fileSize: size,
        fileData: dataUrl,
        fileType: 'application/pdf',
        status: 'Submitted',
        uploaderRole: user?.role || '',
        uploadedBy: user?.username || 'System',
        uploadedAt: new Date().toISOString(),
        submittedBy: user?.username || 'System',
        submittedAt: new Date().toISOString(),
        reportData: JSON.stringify(fields),
      } as any);

      onSubmitted?.();
      onClose();
    } catch (submitError) {
      const detail = describeError(submitError, 'The report could not be filed. Please try again.');
      setError(detail);
      await dialog.failure('Could not file the report', detail);
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * The rendered width drives every overlay position: the form is laid out in
   * PDF points, so one scale factor converts a measured coordinate into pixels
   * and the boxes cannot drift from the form underneath them.
   */
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [pageWidth, setPageWidth] = useState(720);
  useEffect(() => {
    const measure = () => {
      const width = hostRef.current?.clientWidth || 720;
      setPageWidth(Math.max(280, Math.min(900, width)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  const scale = pageWidth / REPORT_PAGE.width;
  /** A PDF point, measured from the top of the page, in pixels. */
  const topPx = (pdfY: number) => (REPORT_PAGE.height - pdfY) * scale;
  const px = (points: number) => points * scale;
  const fieldFont = Math.max(5, 11 * scale);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose(); }}>
      <DialogContent className="!top-0 !left-0 !flex !h-[100dvh] !w-screen !max-h-none !max-w-none !translate-x-0 !translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-white p-0">
        <DialogHeader className="shrink-0 border-b px-5 py-3">
          <DialogTitle className="text-[#2F3E46]">{program}</DialogTitle>
          <DialogDescription>
            Fill the official form directly. {effectiveResidentName || 'No resident chosen'} · {quarterKey}.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto bg-neutral-200 px-2 py-3 sm:px-5">
          <div ref={hostRef} className="mx-auto w-full max-w-[900px]">

            {!residentId && (
              <div className="mb-3 space-y-1 rounded-lg bg-white p-3">
                <Label className="text-[#2F3E46]">Resident</Label>
                <select
                  value={pickedId}
                  onChange={(event) => setPickedId(event.target.value)}
                  className="h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-sm"
                >
                  <option value="">Select a resident…</option>
                  {(residents || []).map((resident) => (
                    <option key={resident.id} value={resident.id}>{resident.name}</option>
                  ))}
                </select>
              </div>
            )}

            {quarterIsTaken && (
              <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                A {program} for {quarterKey} is already on file for {effectiveResidentName}. It can only be
                replaced if a reviewer rejects it.
              </p>
            )}

            {/* ── The official form ─────────────────────────────────────────── */}
            <div className="overflow-hidden rounded-t-lg bg-white shadow-lg" style={{ width: pageWidth }}>
              {/* The part of the printed page that is kept: letterhead → RESIDENT. */}
              <div className="relative overflow-hidden" style={{ height: px(KEPT_HEIGHT) }}>
                <PdfDocument
                  file={PROGRESS_REPORT_TEMPLATE_URL}
                  loading={<div className="p-6 text-center text-xs text-gray-500">Loading the official form…</div>}
                >
                  <PdfPage
                    pageNumber={1}
                    width={pageWidth}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                  />
                </PdfDocument>

                <input
                  aria-label="Program"
                  value={program}
                  readOnly
                  className="pdf-overlay-cell absolute bg-white/70 font-bold outline-none"
                  style={{
                    left: px(PROGRAM_LINE.x), top: topPx(PROGRAM_LINE.y) - px(13),
                    width: px(PROGRAM_LINE.width), height: px(16), fontSize: fieldFont,
                  }}
                />
                <input
                  aria-label="Resident name"
                  value={effectiveResidentName}
                  readOnly
                  className="pdf-overlay-cell absolute bg-white/70 font-bold outline-none"
                  style={{
                    left: px(RESIDENT_NAME.x), top: topPx(RESIDENT_NAME.y) - px(13),
                    width: px(RESIDENT_NAME.width), height: px(16), fontSize: fieldFont,
                  }}
                />
              </div>

              {/* ── The app-drawn body: the table, the narrative, the signatures ── */}
              <div
                className="bg-white"
                style={{ paddingLeft: px(REPORT_MARGIN), paddingRight: px(REPORT_MARGIN), paddingBottom: px(40) }}
              >
                {/* Table header */}
                <div className="flex border border-gray-400 bg-[#f2f2f1]" style={{ height: px(TABLE_HEADER_HEIGHT) }}>
                  {TABLE_HEADINGS.map((heading, index) => (
                    <div
                      key={heading}
                      className="flex items-center border-r border-gray-400 px-1 font-bold uppercase last:border-r-0"
                      style={{ width: px(COLUMN_WIDTHS[index]), fontSize: Math.max(5, 7.5 * scale) }}
                    >
                      {heading}
                    </div>
                  ))}
                </div>

                {/* Table rows — each grows with what is typed */}
                {rows.map((row, index) => (
                  <div key={index} className="flex border-x border-b border-gray-400">
                    {TABLE_CELLS.map(([key, placeholder, column]) => (
                      <div
                        key={key}
                        className="border-r border-gray-400 p-1 last:border-r-0"
                        style={{ width: px(COLUMN_WIDTHS[column]) }}
                      >
                        <AutoTextarea
                          value={row[key]}
                          onChange={(next) => setRow(index, key, next)}
                          placeholder={placeholder}
                          minHeight={px(26)}
                          className="text-gray-900 placeholder:text-gray-300"
                        />
                      </div>
                    ))}
                  </div>
                ))}

                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={addRow} className="h-7 gap-1.5 px-2 text-xs">
                      <Plus className="h-3.5 w-3.5" /> Add row
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => removeRow(rows.length - 1)}
                      disabled={rows.length <= 1}
                      className="h-7 gap-1 px-2 text-xs text-red-600 hover:text-red-700"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Remove last
                    </Button>
                  </div>
                  <span className="text-[10px] text-gray-400">
                    The form grows as you type — the printed rows are one line each.
                  </span>
                </div>

                {/* Narrative */}
                <div style={{ marginTop: px(24) }}>
                  <p className="font-bold" style={{ fontSize: px(11) }}>Narrative conclusion:</p>
                  <div style={{ marginTop: px(4) }}>
                    <AutoTextarea
                      value={narrative}
                      onChange={setNarrative}
                      placeholder="Summarise the quarter."
                      minHeight={px(72)}
                      className="border-b border-gray-300 text-gray-900 placeholder:text-gray-300"
                    />
                  </div>
                </div>

                {/* Signatures */}
                <div style={{ marginTop: px(28), fontSize: px(11) }}>
                  <div className="flex flex-wrap items-start gap-6">
                    <div style={{ minWidth: px(230) }}>
                      <p className="font-bold">Prepared by:</p>
                      <div style={{ marginTop: px(6) }}>
                        <SignaturePadModal
                          label="Prepared by signature"
                          value={signature}
                          onChange={setSignature}
                          hint="Tap to sign"
                        />
                      </div>
                      <p style={{ marginTop: px(4) }}>
                        {((user as any)?.fullName || (user as any)?.displayName || user?.username) as string}
                      </p>
                      <p>Program in-charge</p>
                    </div>
                    <div style={{ minWidth: px(230) }}>
                      <p className="font-bold">Checked by:</p>
                      <p style={{ marginTop: px(6) }}>{REPORT_CHECKED_BY_NAME}</p>
                    </div>
                    <div style={{ minWidth: px(230) }}>
                      <p className="font-bold">Noted by:</p>
                      <p style={{ marginTop: px(6) }}>{REPORT_NOTED_BY_NAME}</p>
                      <p>{REPORT_NOTED_BY_TITLE}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {error && (
              <p className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col-reverse gap-2 border-t px-5 py-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting} className="sm:w-auto">
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || quarterIsTaken}
            className="gap-2 bg-[#2F3E46] text-white hover:bg-[#243038]"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {submitting ? 'Filing the report…' : 'Submit for approval'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
