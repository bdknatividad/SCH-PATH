import { useEffect, useMemo, useRef, useState } from 'react';
import { PDFDocument, StandardFonts, rgb, PDFName } from 'pdf-lib';
import { Document as PdfDocument, Page as PdfPage, pdfjs } from 'react-pdf';
import { Button } from '@/app/components/ui/button';
import { Card, CardContent } from '@/app/components/ui/card';
import { Input } from '@/app/components/ui/input';
import { Textarea } from '@/app/components/ui/textarea';
import { Badge } from '@/app/components/ui/badge';
import { Alert, AlertDescription } from '@/app/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/dialog';
import { Save, Send, Download, Eye, X, Loader2, CheckCheck, RotateCcw } from 'lucide-react';
import { describeError, request } from '@/services/api';
import { useSystemDialog } from '@/app/components/SystemDialog';
import { useAuth } from '../state/AuthContext';
import { useData } from '../state/DataContext';

// `?v=` is a cache key, not a fetch hint — see the note in QuarterlyProgressReport.tsx.
pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.mjs?v=${pdfjs.version}`;

export type AnecdotalStatus = 'Draft' | 'Submitted' | 'Under Review' | 'Returned' | 'Finalized';

export interface AnecdotalRecord {
  id: string;
  residentId: string;
  reportingYear: number;
  reportingMonth: number;
  status: AnecdotalStatus;
  content: Record<string, string>;
  room?: string | null;
  reportDate?: string | null;
  submittedBy?: string | null;
  submittedAt?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  finalizedBy?: string | null;
  finalizedAt?: string | null;
  reviewNotes?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

const PAGE_WIDTH = 612.2;
const PAGE_HEIGHT = 936.2;
const SECTION_FIELDS = [
  ['physical', 'Physical', 231.4, 5],
  ['emotional', 'Emotional', 314.2, 5],
  ['behavioral', 'Behavioral', 397.0, 5],
  ['education', 'Education', 479.8, 5],
  ['spiritual', 'Spiritual', 562.7, 5],
  ['productivity', 'Productivity', 645.5, 5],
  ['coPeers', 'Relationship with co-peers', 728.3, 2],
];
const PAGE2_FIELDS = [
  ['coPeers2', 'Relationship with co-peers (continued)', 113.8, 3],
  ['staff', 'Relationship with staff', 169.0, 5],
  ['groupLiving', 'Group Living Activities', 251.8, 5],
  ['recommendations', 'Recommendation/s', 334.6, 5],
];

const blankContent = () => ({
  physical: '', emotional: '', behavioral: '', education: '', spiritual: '', productivity: '',
  coPeers: '', coPeers2: '', staff: '', groupLiving: '', recommendations: '',
});

const formatDate = (value?: string | null) => {
  if (!value) return '';
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
};

const normalizeContent = (content: any) => ({ ...blankContent(), ...(content || {}) });

function fieldStyle(x: number, yTop: number, w: number, h: number, scale: number) {
  return {
    left: `${x * scale}px`,
    top: `${yTop * scale}px`,
    width: `${w * scale}px`,
    height: `${h * scale}px`,
    // Hard reset so the shared Input/Textarea components' own defaults
    // (padding, min-height, and especially Textarea's `field-sizing: content`
    // auto-grow) can never override this field's exact pixel box — inline
    // styles win specificity, but only if we actually set every property
    // that could otherwise leak through.
    boxSizing: 'border-box' as const,
    padding: 0,
    margin: 0,
    border: 0,
    minHeight: 0,
    maxHeight: `${h * scale}px`,
    lineHeight: 1.3,
    fieldSizing: 'fixed' as any,
  } as const;
}

export function AnecdotalReportEditor({
  residentId,
  record,
  open,
  onOpenChange,
  onSaved,
  onClosed,
}: {
  residentId: string;
  record?: AnecdotalRecord | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSaved?: (record: AnecdotalRecord) => void;
  onClosed?: () => void;
}) {
  const { user } = useAuth();
  const { children } = useData();
  const child = children.find(c => c.id === residentId);
  const role = String(user?.role || '').toLowerCase();
  const isHouseparent = role === 'houseparent';
  const canReview = ['socialworker', 'centerhead', 'admin'].includes(role);
  const editable = !record || ['Draft', 'Returned'].includes(record.status);

  const [localOpen, setLocalOpen] = useState(Boolean(open));
  const [content, setContent] = useState<Record<string, string>>(normalizeContent(record?.content));
  const [room, setRoom] = useState(record?.room || (child as any)?.room || '');
  const [reportDate, setReportDate] = useState(record?.reportDate || new Date().toISOString().slice(0, 10));
  const [reportMonth, setReportMonth] = useState(record?.reportingMonth || new Date().getMonth() + 1);
  const [reportYear, setReportYear] = useState(record?.reportingYear || new Date().getFullYear());
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Returning a report needs the reviewer's notes, which used to be collected by
  // `window.prompt` — a single-line browser box that cannot be validated, is
  // titled with the page's origin, and is suppressed outright by some browsers.
  const [showReturnDialog, setShowReturnDialog] = useState(false);
  const [returnNotes, setReturnNotes] = useState('');
  const dialog = useSystemDialog();
  const page1Ref = useRef<HTMLDivElement | null>(null);
  const page2Ref = useRef<HTMLDivElement | null>(null);
  const [pageWidth, setPageWidth] = useState(760);
  const pageScale = pageWidth / PAGE_WIDTH;

  useEffect(() => {
    const elements = [page1Ref.current, page2Ref.current].filter(Boolean) as HTMLDivElement[];
    if (!elements.length) return;
    const update = () => {
      const widths = elements.map(el => el.clientWidth).filter(w => w > 0);
      if (widths.length) setPageWidth(Math.min(...widths));
    };
    update();
    const observer = new ResizeObserver(update);
    elements.forEach(el => observer.observe(el));
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);


  useEffect(() => {
    setLocalOpen(Boolean(open));
  }, [open]);

  useEffect(() => {
    setContent(normalizeContent(record?.content));
    setRoom(record?.room || (child as any)?.room || '');
    setReportDate(record?.reportDate || new Date().toISOString().slice(0, 10));
    setReportMonth(record?.reportingMonth || new Date().getMonth() + 1);
    setReportYear(record?.reportingYear || new Date().getFullYear());
  }, [record, child]);

  const actualOpen = open === undefined ? localOpen : open;
  const name = child?.name || record?.residentId || '';
  const displayMonth = new Date(reportYear, reportMonth - 1, 1).toLocaleString('en-PH', { month: 'long' });

  function close() {
    if (onOpenChange) onOpenChange(false);
    else setLocalOpen(false);
    onClosed?.();
  }

  function updateField(key: string, value: string) {
    setContent(prev => ({ ...prev, [key]: value }));
  }

  async function saveDraft(submit = false) {
    if (!residentId) return;
    setError(null);
    submit ? setSubmitting(true) : setSaving(true);
    try {
      const payload = {
        residentId,
        reportingYear: reportYear,
        reportingMonth: reportMonth,
        reportDate,
        room,
        content,
      };
      let saved: AnecdotalRecord;
      if (record?.id) {
        const response = await request<{ success: boolean; data: AnecdotalRecord }>(`/anecdotal-reports/${record.id}`, {
          method: 'PUT', body: JSON.stringify(payload),
        });
        saved = response.data;
      } else {
        const response = await request<{ success: boolean; data: AnecdotalRecord }>('/anecdotal-reports', {
          method: 'POST', body: JSON.stringify(payload),
        });
        saved = response.data;
      }
      if (submit) {
        const submitted = await request<{ success: boolean; data: AnecdotalRecord }>(`/anecdotal-reports/${saved.id}/submit`, { method: 'POST' });
        saved = submitted.data;
      }
      onSaved?.(saved);
      close();
      await dialog.success(
        submit ? 'Anecdotal Report submitted.' : 'Draft saved.',
        submit
          ? 'The Social Worker and the Center Head can now review it. You will be notified if it is returned to you for revision.'
          : 'The report is stored as a Draft. You can keep editing it and submit it when every section is filled in.',
      );
    } catch (err: any) {
      setError(describeError(err, 'Unable to save the anecdotal report.'));
      await dialog.failure(
        submit ? 'Could not submit the report' : 'Could not save the report',
        describeError(err, 'The report was not saved. Please try again.'),
      );
    } finally {
      setSaving(false);
      setSubmitting(false);
    }
  }

  /** Opens the notes dialog. The notes are the whole point of a return, so it is
   *  a form, not a one-line prompt. */
  function requestReturn() {
    if (!record?.id) return;
    setReturnNotes('');
    setShowReturnDialog(true);
  }

  async function confirmReturn() {
    if (!record?.id || !returnNotes.trim()) return;
    setShowReturnDialog(false);
    setReviewBusy(true); setError(null);
    try {
      const res = await request<{ success: boolean; data: AnecdotalRecord }>(`/anecdotal-reports/${record.id}/return`, { method: 'POST', body: JSON.stringify({ reviewNotes: returnNotes.trim() }) });
      onSaved?.(res.data);
      setReturnNotes('');
      await dialog.success(
        'Report returned for revision.',
        'The author can edit it again and resubmit. Your notes are shown with the report.',
      );
    } catch (err: any) {
      setError(describeError(err, 'Unable to return the report.'));
      await dialog.failure('Could not return the report', describeError(err, 'The report was not returned. Please try again.'));
    } finally {
      setReviewBusy(false);
    }
  }

  async function reviewAction(action: 'review' | 'return' | 'finalize') {
    if (!record?.id) return;
    if (action === 'return') { requestReturn(); return; }

    if (action === 'finalize') {
      const confirmed = await dialog.confirm({
        title: 'Approve this Anecdotal Report?',
        description: 'Approving is final. The report becomes part of the resident\'s official record, is filed in their Anecdotal Reports folder, and can no longer be edited. If something needs changing, return it for revision instead.',
        confirmLabel: 'Approve report',
        tone: 'warning',
      });
      if (!confirmed) return;
    }

    setReviewBusy(true); setError(null);
    try {
      if (action === 'review') {
        const res = await request<{ success: boolean; data: AnecdotalRecord }>(`/anecdotal-reports/${record.id}/review`, { method: 'POST' });
        onSaved?.(res.data);
        await dialog.success('Review started.', 'The report is now marked Under Review.');
      }
      if (action === 'finalize') {
        const res = await request<{ success: boolean; data: AnecdotalRecord }>(`/anecdotal-reports/${record.id}/finalize`, { method: 'POST' });
        onSaved?.(res.data);
        close();
        await dialog.success(
          'Anecdotal Report approved.',
          'The report is now part of the resident\'s official record and has been filed in the Documents module.',
        );
      }
    } catch (err: any) {
      setError(describeError(err, 'Unable to update the report.'));
      await dialog.failure(
        action === 'finalize' ? 'Could not approve the report' : 'Could not start the review',
        describeError(err, 'The report was not updated. Please try again.'),
      );
    } finally {
      setReviewBusy(false);
    }
  }

  async function exportPdf() {
    try {
      const bytes = await buildFilledPdf({ childName: name, room, reportDate, reportMonth, reportYear, content, houseparentName: record?.submittedBy || user?.username || '' });
      const safe = new Uint8Array(bytes.byteLength); safe.set(bytes);
      const url = URL.createObjectURL(new Blob([safe.buffer], { type: 'application/pdf' }));
      const a = document.createElement('a'); a.href = url;
      a.download = `Anecdotal-Report-${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}-${reportYear}-${String(reportMonth).padStart(2, '0')}.pdf`;
      a.click(); URL.revokeObjectURL(url);
    } catch (err: any) {
      const message = describeError(err, 'Unable to export the anecdotal report.');
      setError(message);
      await dialog.failure('Could not export the report', message);
    }
  }

  return (
    <>
    <Dialog open={actualOpen} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="!top-0 !left-0 !h-screen !w-screen !max-h-none !max-w-none !translate-x-0 !translate-y-0 rounded-none p-0 overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0 border-b bg-white px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <DialogTitle className="text-[#2F3E46]">Anecdotal Report {record?.id ? `— ${record.status}` : ''}</DialogTitle>
              <p className="text-xs text-gray-500">{name} · {displayMonth} {reportYear}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {record?.status && <Badge>{record.status}</Badge>}
              {record?.id && <Button size="sm" variant="outline" onClick={exportPdf}><Download className="w-4 h-4 mr-1" /> Download</Button>}
              <Button size="sm" variant="outline" onClick={close}><X className="w-4 h-4" /> Close</Button>
            </div>
          </div>
        </DialogHeader>

        {error && <div className="mx-4 mt-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div>}

        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-100 p-3 sm:p-5">
          <div className="mx-auto w-full max-w-[760px]">
            <div ref={page1Ref} className="relative w-full bg-white shadow-xl" style={{ height: `${pageWidth * PAGE_HEIGHT / PAGE_WIDTH}px` }}>
              <div className="absolute inset-0 overflow-hidden"> 
                <PdfDocument file="/forms/Anecdotal%20Report.pdf" loading={<div className="p-8 text-center">Loading official Anecdotal Report...</div>}>
                  <PdfPage pageNumber={1} width={pageWidth} renderTextLayer={false} renderAnnotationLayer={false} />
                </PdfDocument>
              </div>
              <input value={name} readOnly className="absolute z-10 bg-white font-bold text-[11px] outline-none" style={fieldStyle(163, 148.6, 155, 15, pageScale)} />
              <Input type="date" value={reportDate} onChange={e => setReportDate(e.target.value)} disabled={!editable} className="absolute z-10 rounded-none border-transparent bg-transparent text-[11px] p-0 h-auto shadow-none" style={fieldStyle(456, 148.6, 70, 15, pageScale)} />
              <Input value={room} onChange={e => setRoom(e.target.value)} disabled={!editable} className="absolute z-10 rounded-none border-transparent bg-transparent text-[11px] p-0 h-auto shadow-none" style={fieldStyle(113, 162.4, 150, 15, pageScale)} />
              <select value={reportMonth} onChange={e => setReportMonth(Number(e.target.value))} disabled={!editable} className="absolute z-10 appearance-none bg-transparent text-[11px] outline-none" style={fieldStyle(466, 162.4, 72, 15, pageScale)}>
                {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{new Date(2000, i, 1).toLocaleString('en-PH', { month: 'long' })}</option>)}
              </select>
              {SECTION_FIELDS.map(([key, , y, lines]) => (
                <Textarea key={String(key)} value={content[String(key)] || ''} onChange={e => updateField(String(key), e.target.value)} disabled={!editable} className="absolute z-10 resize-none rounded-none border-0 bg-transparent text-[10px] p-0 m-0 min-h-0 leading-[1.6] shadow-none focus:ring-0 focus-visible:ring-0 overflow-hidden" style={fieldStyle(108, Number(y), 428, Number(lines) * 13.8 + 4, pageScale)} />
              ))}
            </div>

            <div ref={page2Ref} className="mt-3 relative w-full bg-white shadow-xl" style={{ height: `${pageWidth * PAGE_HEIGHT / PAGE_WIDTH}px` }}>
              <div className="absolute inset-0 overflow-hidden">
                <PdfDocument file="/forms/Anecdotal%20Report.pdf">
                  <PdfPage pageNumber={2} width={pageWidth} renderTextLayer={false} renderAnnotationLayer={false} />
                </PdfDocument>
              </div>
              {PAGE2_FIELDS.map(([key, , y, lines]) => (
                <Textarea key={String(key)} value={content[String(key)] || ''} onChange={e => updateField(String(key), e.target.value)} disabled={!editable} className="absolute z-10 resize-none rounded-none border-0 bg-transparent text-[10px] p-0 m-0 min-h-0 leading-[1.6] shadow-none focus:ring-0 focus-visible:ring-0 overflow-hidden" style={fieldStyle(108, Number(y), 428, Number(lines) * 13.8 + 4, pageScale)} />
              ))}
              <Input value={record?.submittedBy || (isHouseparent ? user?.username || '' : '')} readOnly className="absolute z-10 rounded-none border-transparent bg-white font-bold text-[11px] p-0 h-auto shadow-none" style={fieldStyle(58, 472.6, 210, 18, pageScale)} />
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t bg-white px-4 py-3 flex-wrap gap-2 justify-between">
          <div className="flex flex-wrap gap-2">
            {isHouseparent && editable && <Button variant="outline" onClick={() => saveDraft(false)} disabled={saving || submitting}><Save className="w-4 h-4 mr-1" /> {saving ? 'Saving...' : 'Save Draft'}</Button>}
            {isHouseparent && editable && <Button className="bg-[#2F3E46]" onClick={() => saveDraft(true)} disabled={saving || submitting}><Send className="w-4 h-4 mr-1" /> {submitting ? 'Submitting...' : 'Submit to Social Worker'}</Button>}
            {canReview && record && ['Submitted', 'Under Review'].includes(record.status) && <Button variant="outline" onClick={() => reviewAction('review')} disabled={reviewBusy}><Eye className="w-4 h-4 mr-1" /> Start Review</Button>}
            {canReview && record && ['Submitted', 'Under Review'].includes(record.status) && <Button variant="outline" className="text-red-600 border-red-200" onClick={requestReturn} disabled={reviewBusy}><RotateCcw className="w-4 h-4 mr-1" /> Return for revision</Button>}
            {canReview && record && ['Under Review'].includes(record.status) && <Button className="bg-[#2F3E46]" onClick={() => reviewAction('finalize')} disabled={reviewBusy}><CheckCheck className="w-4 h-4 mr-1" /> Finalize</Button>}
          </div>
          <Button variant="ghost" onClick={close}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Return for revision: the reviewer's notes are required, so they are
        collected in a real form rather than a one-line browser prompt. */}
    <Dialog open={showReturnDialog} onOpenChange={setShowReturnDialog}>
      <DialogContent className="rounded-2xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[#2F3E46]">Return this report for revision</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <label className="text-xs font-semibold text-gray-500">
            Review notes <span className="text-red-500">*</span>
          </label>
          <Textarea
            value={returnNotes}
            onChange={e => setReturnNotes(e.target.value)}
            rows={5}
            placeholder="Explain what the Houseparent needs to correct before resubmitting this report..."
          />
          <p className="text-[11px] leading-relaxed text-gray-500">
            The notes are stored with the report and shown to the author.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => { setShowReturnDialog(false); setReturnNotes(''); }}>Cancel</Button>
          <Button
            className="bg-red-600 hover:bg-red-700 text-white"
            onClick={confirmReturn}
            disabled={reviewBusy || !returnNotes.trim()}
          >
            {reviewBusy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-1" />}
            Return for revision
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

export async function buildFilledPdf({ childName, room, reportDate, reportMonth, reportYear, content, houseparentName }: {
  childName: string; room: string; reportDate: string; reportMonth: number; reportYear: number; content: Record<string, string>; houseparentName: string;
}) {
  const source = await fetch('/forms/Anecdotal%20Report.pdf').then(r => r.arrayBuffer());
  const pdf = await PDFDocument.load(source);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  const p1 = pages[0]; const p2 = pages[1];
  // The source template has a hidden Square annotation sitting directly over
  // the Name of Client and Houseparent-name areas, positioned by whoever
  // last sample-filled this file. Annotations composite ON TOP of page
  // content, so it silently hid any new text drawn underneath it — this is
  // the actual cause of the "text holder position" being wrong. Strip it.
  p1.node.delete(PDFName.of('Annots'));
  p2.node.delete(PDFName.of('Annots'));
  const whiteOut = (page: any, x: number, yTop: number, width: number, height: number) => {
    page.drawRectangle({ x: x - 2, y: PAGE_HEIGHT - yTop - height, width: width + 4, height: height + 3, color: rgb(1, 1, 1) });
  };
  const draw = (page: any, text: string, x: number, yTop: number, size = 10, font = regular, maxWidth = 430, lineHeight = size + 2) => {
    if (!text) return;
    const words = String(text).split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) <= maxWidth) line = test;
      else { if (line) lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    lines.slice(0, 6).forEach((ln, i) => page.drawText(ln, { x, y: PAGE_HEIGHT - yTop - size - i * lineHeight, size, font, color: rgb(0,0,0) }));
  };
  // The source template has sample data (a name and a houseparent signature)
  // baked directly into it, not left blank — cover those two exact spots
  // with white before drawing the real values, or they'd overlap illegibly.
  whiteOut(p1, 160, 149.6, 165, 15);
  draw(p1, childName, 163, 148.6, 11, bold, 155);
  draw(p1, formatDate(reportDate), 456, 148.6, 11, bold, 68);
  draw(p1, room, 113, 162.4, 10, regular, 150);
  draw(p1, new Date(reportYear, reportMonth - 1, 1).toLocaleString('en-PH', { month: 'long' }), 466, 162.4, 10, regular, 62);
  // Content fields' blank lines are 13.8pt apart on the actual template —
  // match that exactly so multi-line answers don't drift off the ruled lines.
  SECTION_FIELDS.forEach(([key, , y]) => draw(p1, content[String(key)] || '', 108, Number(y), 9.5, regular, 428, 13.8));
  PAGE2_FIELDS.forEach(([key, , y]) => draw(p2, content[String(key)] || '', 108, Number(y), 9.5, regular, 428, 13.8));
  whiteOut(p2, 55, 473.6, 220, 15);
  draw(p2, houseparentName, 58, 472.6, 11, bold, 210);
  return pdf.save();
}

export function AnecdotalReportsTab({ initialResidentId }: { initialResidentId?: string }) {
  const { user } = useAuth();
  const { children } = useData();
  const role = String(user?.role || '').toLowerCase();
  const isHouseparent = role === 'houseparent';
  const canReview = ['socialworker', 'centerhead', 'admin'].includes(role);
  const [records, setRecords] = useState<AnecdotalRecord[]>([]);
  const [selectedResident, setSelectedResident] = useState(initialResidentId || '');
  const [selectedRecord, setSelectedRecord] = useState<AnecdotalRecord | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [assignedResidentIds, setAssignedResidentIds] = useState<string[]>([]);

  async function load() {
    setLoading(true);
    try {
      const response = await request<{ success: boolean; data: AnecdotalRecord[] }>('/anecdotal-reports');
      setRecords(response.data || []);
    } catch { setRecords([]); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    load();
    if (isHouseparent) {
      request<{ success: boolean; data?: any[] }>('/resident-assignments/my-residents')
        .then(res => setAssignedResidentIds((res?.data || []).map((c: any) => String(c.id))))
        .catch(() => setAssignedResidentIds([]));
    } else {
      setAssignedResidentIds([]);
    }
  }, [isHouseparent]);

  const filtered = useMemo(() => records.filter(r => {
    const name = children.find(c => c.id === r.residentId)?.name || '';
    const q = search.trim().toLowerCase();
    return (statusFilter === 'all' || r.status === statusFilter) && (!q || name.toLowerCase().includes(q) || `${r.reportingMonth}/${r.reportingYear}`.includes(q));
  }), [records, children, search, statusFilter]);

  const activeChildren = children.filter(c => (c.status === 'Active' || !c.status) && (!isHouseparent || assignedResidentIds.includes(String(c.id))));

  return (
    <div className="space-y-4">
      <Card className="border-gray-200 shadow-sm"><CardContent className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex-1"><label className="text-xs font-semibold text-gray-500">Search</label><Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search resident or reporting period..." /></div>
          <div><label className="text-xs font-semibold text-gray-500">Status</label><select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="h-10 rounded-md border border-gray-300 px-3 text-sm"><option value="all">All Status</option><option value="Draft">Draft</option><option value="Submitted">Submitted</option><option value="Under Review">Under Review</option><option value="Returned">Returned</option><option value="Finalized">Finalized</option></select></div>
          {isHouseparent && <div><label className="text-xs font-semibold text-gray-500">Resident</label><select value={selectedResident} onChange={e => setSelectedResident(e.target.value)} className="h-10 rounded-md border border-gray-300 px-3 text-sm"><option value="">Select resident</option>{activeChildren.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
          {isHouseparent && <Button disabled={!selectedResident} className="bg-[#2F3E46]" onClick={() => { setSelectedRecord(null); setShowEditor(true); }}><Save className="w-4 h-4 mr-1" /> New Anecdotal Report</Button>}
        </div>
      </CardContent></Card>
      {loading ? <div className="py-10 text-center text-sm text-gray-400">Loading anecdotal reports...</div> : filtered.length === 0 ? <Card><CardContent className="py-10 text-center text-sm text-gray-400">No anecdotal reports found.</CardContent></Card> : (
        <Card><CardContent className="p-0 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b bg-gray-50 text-xs uppercase text-gray-500"><th className="p-3 text-left">Resident</th><th className="p-3 text-left">Period</th><th className="p-3 text-left">Status</th><th className="p-3 text-left">Submitted By</th><th className="p-3 text-left">Action</th></tr></thead><tbody className="divide-y">{filtered.map(r => <tr key={r.id}><td className="p-3 font-semibold">{children.find(c => c.id === r.residentId)?.name || r.residentId}</td><td className="p-3">{String(r.reportingMonth).padStart(2,'0')}/{r.reportingYear}</td><td className="p-3"><Badge>{r.status}</Badge></td><td className="p-3">{r.submittedBy || '—'}</td><td className="p-3"><Button size="sm" variant="outline" onClick={() => { setSelectedRecord(r); setSelectedResident(r.residentId); setShowEditor(true); }}>{canReview && ['Submitted','Under Review'].includes(r.status) ? 'Review / Edit' : 'View / Edit'}</Button></td></tr>)}</tbody></table></CardContent></Card>
      )}
      {selectedRecord || selectedResident ? <AnecdotalReportEditor residentId={selectedResident} record={selectedRecord} open={showEditor} onOpenChange={setShowEditor} onSaved={() => load()} /> : null}
    </div>
  );
}
