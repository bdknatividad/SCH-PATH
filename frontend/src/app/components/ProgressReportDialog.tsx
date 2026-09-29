import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/app/components/ui/dialog';
import { Button } from '@/app/components/ui/button';
import { Label } from '@/app/components/ui/label';
import { Textarea } from '@/app/components/ui/textarea';
import { Loader2, Plus, Trash2, PenLine } from 'lucide-react';
import { SignaturePadModal } from '@/app/components/SignaturePad';
import { useData } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { useSystemDialog } from '@/app/components/SystemDialog';
import { describeError } from '@/services/api';
import {
  generateProgressReportPdf,
  type ProgressReportRow,
} from '@/app/utils/progressReportPdf';

/** The two documents this form produces. The wording goes on the `(PROGRAM)` line. */
export const EDUCATION_PROGRESS_PROGRAM = 'Education Quarterly Report';
export const MEDICAL_PROGRESS_PROGRAM = 'Medical Quarterly Report';

/** The printed names under "Checked by" and "Noted by" — fixed by the official form. */
const SOCIAL_WORKER_NAME = 'Francis Patricio, RSW';
const CENTER_HEAD_NAME = 'Maricor C. Navarro, RSW, MSSW';
const CENTER_HEAD_TITLE = 'Center Head, SCH';

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
  const explicit = text.match(/REPORT\s+QUARTER\s*:\s*(Q[1-4])\s*REPORT\s+YEAR\s*:\s*(\d{4})/i);
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

interface ProgressReportDialogProps {
  open: boolean;
  onClose: () => void;
  residentId: string;
  residentName: string;
  /** `EDUCATION_PROGRESS_PROGRAM` or `MEDICAL_PROGRESS_PROGRAM`. */
  program: string;
  /** Called after the report is filed, so the module can refresh its lists. */
  onSubmitted?: () => void;
}

/**
 * The shared Education / Health quarterly report form.
 *
 * One template, two producers — the educator files the Education report and the
 * nurse the Medical one, and they differ only in the `(PROGRAM)` line and who
 * signs "Prepared by". Everything the author types is the same, which is why
 * this is one component rather than two.
 *
 * The author fills the table and the narrative, signs, and submits. Submitting
 * files the PDF into the resident's own folder (Educational Records or Medical
 * Records, by the document's type) as `Submitted`, and the reviewers are
 * alerted. The reviewer adds *their* signature at approval, so the answers are
 * stored on the document (`reportData`) and the PDF is drawn again with that
 * signature in it — see the note on the column in `server.js`.
 *
 * The four fields of a row are a four-column grid on a wide screen and a
 * stacked card on a phone: a four-column table at phone width is unusable, and
 * this form is filled in on tablets.
 */
export function ProgressReportDialog({
  open,
  onClose,
  residentId,
  residentName,
  program,
  onSubmitted,
}: ProgressReportDialogProps) {
  const { documents, addDocument } = useData();
  const { user } = useAuth();
  const dialog = useSystemDialog();

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
   * Approving or rejecting happens in the Documents module, so the answer is
   * read off the same rows that module shows.
   */
  const existingForQuarter = useMemo(
    () => documents.find((doc: any) =>
      String(doc.residentId) === String(residentId) &&
      reportQuarterOf(doc, program) === quarterKey
    ),
    [documents, residentId, program, quarterKey],
  );
  const quarterIsTaken = Boolean(existingForQuarter) && existingForQuarter?.status !== 'Rejected';

  // Reset on open so a previous resident's answers never carry into the next.
  useEffect(() => {
    if (!open) return;
    setRows([emptyRow()]);
    setNarrative('');
    setSignature('');
    setError('');
    setSubmitting(false);
  }, [open, residentId]);

  const setRow = (index: number, key: keyof ProgressReportRow, value: string) => {
    setRows(prev => prev.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  };

  const addRow = () => setRows(prev => [...prev, emptyRow()]);
  const removeRow = (index: number) =>
    setRows(prev => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));

  const handleSubmit = async () => {
    setError('');

    if (quarterIsTaken) {
      setError(`A ${program} for ${quarterKey} is already on file for ${residentName}. Only a rejected report can be replaced.`);
      return;
    }
    const filled = rows.filter(row =>
      row.areaOfConcern.trim() || row.observations.trim() || row.actionTaken.trim() || row.recommendation.trim()
    );
    if (filled.length === 0) {
      setError('Add at least one area of concern.');
      return;
    }
    if (!narrative.trim()) {
      setError('The narrative conclusion is required.');
      return;
    }
    if (!signature) {
      setError('Sign the form before submitting.');
      return;
    }

    const preparedByName =
      (user as any)?.fullName || (user as any)?.displayName || user?.username || 'Staff';

    setSubmitting(true);
    try {
      const fields = {
        program,
        quarter,
        year,
        residentName,
        residentId,
        rows: filled,
        narrative: narrative.trim(),
        preparedByName,
        preparedBySignature: signature,
        checkedByName: SOCIAL_WORKER_NAME,
        notedByName: CENTER_HEAD_NAME,
        notedByTitle: CENTER_HEAD_TITLE,
      };

      const { dataUrl, size } = await generateProgressReportPdf(fields);
      const fileName = `Progress_Report_${quarter}_${year}_${residentName.replace(/\s+/g, '_')}.pdf`;

      await addDocument({
        residentId,
        residentName,
        title: program,
        type: program,
        // The category decides the folder *and* who may read it — see
        // `DOCUMENT_READ_ROLES_BY_CATEGORY`. It must match the document type, or
        // the reviewer the alert is addressed to is refused the file.
        category: program,
        description: [
          `${program} for ${residentName}.`,
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
        // The answers, so a reviewer's signature can be drawn onto the same
        // form at approval time.
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

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose(); }}>
      <DialogContent className="flex h-[92dvh] w-[96vw] max-w-4xl flex-col gap-0 overflow-hidden rounded-2xl p-0">
        <DialogHeader className="shrink-0 border-b px-5 py-3">
          <DialogTitle className="text-[#2F3E46]">{program}</DialogTitle>
          <DialogDescription>
            {residentName} · {quarterKey} — the program line and your name are filled in automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {quarterIsTaken && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              A {program} for {quarterKey} is already on file for {residentName}. It can only be replaced if a
              reviewer rejects it.
            </p>
          )}

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-[#2F3E46]">Areas of concern</Label>
              <Button type="button" size="sm" variant="outline" onClick={addRow} className="gap-1.5">
                <Plus className="h-3.5 w-3.5" /> Add row
              </Button>
            </div>

            {rows.map((row, index) => (
              <div key={index} className="rounded-xl border border-gray-200 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                    Row {index + 1}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => removeRow(index)}
                    disabled={rows.length <= 1}
                    className="h-7 gap-1 px-2 text-xs text-red-600 hover:text-red-700"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
                  {([
                    ['areaOfConcern', 'Area of concern'],
                    ['observations', 'Observations / progress'],
                    ['actionTaken', 'Action taken'],
                    ['recommendation', 'Recommendation'],
                  ] as Array<[keyof ProgressReportRow, string]>).map(([key, label]) => (
                    <div key={key} className="space-y-1">
                      <Label className="text-[11px] text-gray-500">{label}</Label>
                      <Textarea
                        value={row[key]}
                        onChange={(event) => setRow(index, key, event.target.value)}
                        rows={3}
                        className="min-h-[72px] text-xs"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <Label className="text-[#2F3E46]">Narrative conclusion</Label>
            <Textarea
              value={narrative}
              onChange={(event) => setNarrative(event.target.value)}
              rows={4}
              placeholder="Summarise the quarter."
            />
          </div>

          <div className="rounded-xl border border-gray-200 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#2F3E46]">
              <PenLine className="h-4 w-4 text-[#FFD100]" /> Prepared by
            </div>
            <SignaturePadModal
              label="Prepared by signature"
              value={signature}
              onChange={setSignature}
              hint="Tap to sign"
            />
            <p className="mt-2 text-xs text-gray-500">
              Printed as <span className="font-semibold text-[#2F3E46]">
                {(user as any)?.fullName || (user as any)?.displayName || user?.username}
              </span>{' '}
              — Program in-charge
            </p>
          </div>

          {error && (
            <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          )}
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
