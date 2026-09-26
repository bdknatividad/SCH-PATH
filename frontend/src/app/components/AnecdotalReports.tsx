import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Badge } from '@/app/components/ui/badge';
import { Alert, AlertDescription } from '@/app/components/ui/alert';
import {
  FileText, Save, Send, CheckCircle2, RotateCcw, Download, Printer,
  Loader2, AlertCircle, CalendarDays, User, X as CloseIcon,
} from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/app/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { useAuth } from '../state/AuthContext';
import { useData } from '../state/DataContext';
import { describeError, request, fetchBinary } from '@/services/api';
import { useSystemDialog } from '@/app/components/SystemDialog';
import { SignaturePadModal } from '@/app/components/SignaturePad';
import { Document as PdfDocument, Page as PdfPage, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// `?v=` is a cache key, not a fetch hint — see the note in QuarterlyProgressReport.tsx.
pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.mjs?v=${pdfjs.version}`;

export interface AnecdotalRecord {
  id: string;
  residentId: string;
  reportDate: string;
  reportYear: number;
  reportMonth: number;
  room: string;
  houseparentName: string;
  houseparentSignature?: string | null;
  status: 'Draft' | 'Submitted' | 'Under Review' | 'Returned' | 'Finalized' | string;
  content: Record<string, string>;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
  submittedBy?: string | null;
  submittedAt?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  finalizedBy?: string | null;
  finalizedAt?: string | null;
  reviewNotes?: string | null;
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const PDF_WIDTH = 612;
const PDF_HEIGHT = 936;
const PDF_FILE = '/forms/Anecdotal%20Report.pdf';

const textFields = [
  // Coordinates measured directly from public/forms/Anecdotal Report.pdf
  // (via pdftotext -bbox on each blank line's actual position) — not guessed.
  { key: 'physical', label: '1. PHYSICAL', page: 0, x: 109, top: 634.6, width: 414, height: 70 },
  { key: 'emotional', label: '2. EMOTIONAL', page: 0, x: 109, top: 551.8, width: 414, height: 70 },
  { key: 'behavioral', label: '3. BEHAVIORAL', page: 0, x: 109, top: 469.0, width: 414, height: 70 },
  { key: 'education', label: '4. EDUCATION', page: 0, x: 109, top: 386.2, width: 414, height: 70 },
  { key: 'spiritual', label: '5. SPIRITUAL', page: 0, x: 109, top: 303.3, width: 414, height: 70 },
  { key: 'productivity', label: '6. PRODUCTIVITY', page: 0, x: 109, top: 220.5, width: 414, height: 70 },
  { key: 'coPeers', label: 'B. Relationship with co-peers', page: 0, x: 109, top: 179.7, width: 414, height: 28 },
  { key: 'staff', label: 'C. Relationship with staff', page: 1, x: 109, top: 697.0, width: 414, height: 70 },
  { key: 'groupLiving', label: 'D. Group Living Activities', page: 1, x: 109, top: 614.2, width: 414, height: 70 },
  { key: 'recommendations', label: 'E. Recommendation/s', page: 1, x: 109, top: 531.4, width: 414, height: 70 },
] as const;

function blankContent(): Record<string, string> {
  return Object.fromEntries(textFields.map(field => [field.key, '']));
}

/**
 * The statuses a Social Worker may act on, mirroring `REVIEWABLE_STATUSES` in
 * anecdotalReportController.js. Approve and Reject are offered on the report the
 * reviewer is looking at, with no separate "Start Review" step in between.
 */
const REVIEWABLE_STATUSES = ['Submitted', 'Under Review'];

/**
 * Every section of the official form, in form order. A Houseparent may save an
 * incomplete report as a Draft, but submission requires all of these — the
 * backend enforces the same set in `missingRequiredFields`.
 */
const REQUIRED_SECTION_KEYS = textFields.map(field => field.key);

function parseDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce((a: any, p) => ({ ...a, [p.type]: p.value }), {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function getLastMonday(year: number, month: number) {
  const d = new Date(Date.UTC(year, month, 0));
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function fmtDate(value?: string | null) {
  if (!value) return '—';
  const [y,m,d] = String(value).slice(0,10).split('-').map(Number);
  if (!y || !m || !d) return value;
  return `${String(m).padStart(2,'0')}/${String(d).padStart(2,'0')}/${y}`;
}

function displayName(user: any) {
  return user?.displayName || user?.name || user?.username || '';
}

function pdfLeft(x: number) { return `${(x / PDF_WIDTH) * 100}%`; }
function pdfTop(topFromBottom: number, height: number) {
  return `${((PDF_HEIGHT - topFromBottom - height) / PDF_HEIGHT) * 100}%`;
}

/**
 * The blank band on page 2 reserved for the Houseparent's signature, in
 * top-left coordinates.
 *
 * Mirrors `HOUSEPARENT_SIGNATURE_BOX` in
 * backend/src/utils/anecdotalReportPdf.js — the pad sits exactly where the
 * signature is stamped when the report is published, so what the Houseparent
 * draws is what the child's Documents folder receives.
 */
const HOUSEPARENT_SIGNATURE_BOX = { x: 58, top: 446, width: 220, height: 26 };

/**
 * Downloads the official Anecdotal Report PDF for a saved report.
 *
 * The file is built by the backend, which overlays the filled-up entries onto
 * the real form. That makes what is downloaded here byte-for-byte the same
 * document that lands in the child's Documents folder once the report is
 * accepted.
 *
 * This used to be rebuilt in the browser with pdf-lib, which meant two
 * implementations of one layout to keep in step — and a client-side generator
 * that threw on any character outside WinAnsi. The overlay now has a single
 * implementation, on the server, and this endpoint is the only consumer.
 */
export async function downloadAnecdotalPdf(record: { id: string }): Promise<void> {
  // `fetchBinary` reports the server's own message, reads its RFC 6266 filename
  // for us, and refuses a response that is a web page rather than the PDF.
  let blob: Blob;
  let serverName: string | null;
  try {
    ({ blob, fileName: serverName } = await fetchBinary(
      `/anecdotal-reports/${encodeURIComponent(record.id)}/pdf`
    ));
  } catch (error: any) {
    throw new Error(error?.message || 'Unable to download the Anecdotal Report PDF.');
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = serverName || `${record.id}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function AnecdotalPdfEditor({
  record,
  child,
  room,
  content,
  reportDate,
  houseparentName,
  houseparentSignature,
  isEditable,
  onChange,
}: {
  record: AnecdotalRecord | null;
  child: any;
  room: string;
  content: Record<string, string>;
  reportDate: string;
  houseparentName: string;
  houseparentSignature: string;
  isEditable: boolean;
  onChange: (key: string, value: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(900);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      if (host.clientWidth > 0) setWidth(Math.min(900, Math.floor(host.clientWidth)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const dateParts = reportDate ? reportDate.slice(0, 10).split('-').map(Number) : [0,0,0];
  const monthLabel = dateParts[1] ? MONTHS[dateParts[1] - 1] : '';

  const overlay = 'absolute z-10 border-0 bg-white/65 px-1 text-[clamp(7px,1vw,12px)] text-black outline-none focus:bg-yellow-100/70 disabled:bg-white/40';
  const areaOverlay = 'absolute z-10 resize-none rounded-sm border border-transparent bg-white/55 px-1 text-[clamp(6px,0.9vw,11px)] leading-[1.35] text-black outline-none focus:border-yellow-400 focus:bg-yellow-100/80 disabled:border-transparent disabled:bg-white/35';

  return (
    <div ref={hostRef} className="min-h-0 flex-1 overflow-y-auto bg-neutral-200 p-2 sm:p-4">
      <div className="mx-auto w-full max-w-[900px] space-y-3">
        <PdfDocument file={PDF_FILE} loading={<div className="bg-white p-8 text-center text-sm">Loading official Anecdotal Report…</div>}>
          <div className="relative w-full overflow-hidden bg-white shadow-lg" style={{ aspectRatio: '612 / 936' }}>
            <PdfPage pageNumber={1} width={width} renderTextLayer={false} renderAnnotationLayer={false} className="absolute inset-0 h-full w-full" />
            <input aria-label="Name of Client" value={child?.name || ''} readOnly className={`${overlay} font-bold`} style={{ left: pdfLeft(163), top: pdfTop(768.4, 19), width: pdfLeft(150), height: '2.1%' }} />
            <input aria-label="Date" type="date" value={reportDate} onChange={e => onChange('__reportDate', e.target.value)} disabled={!isEditable} className={overlay} style={{ left: pdfLeft(456), top: pdfTop(768.4, 19), width: pdfLeft(70), height: '2.1%' }} />
            <input aria-label="Room" value={room} onChange={e => onChange('__room', e.target.value)} disabled={!isEditable} className={overlay} style={{ left: pdfLeft(113), top: pdfTop(754.6, 19), width: pdfLeft(100), height: '2.1%' }} />
            <input aria-label="Month" value={monthLabel} readOnly className={overlay} style={{ left: pdfLeft(466), top: pdfTop(754.6, 19), width: pdfLeft(65), height: '2.1%' }} />
            {textFields.slice(0, 7).map(field => (
              <textarea key={field.key} aria-label={field.label} value={content[field.key] || ''} onChange={e => onChange(field.key, e.target.value)} disabled={!isEditable} className={areaOverlay} style={{ left: pdfLeft(field.x), top: pdfTop(field.top, field.height), width: pdfLeft(field.width), height: `${(field.height / PDF_HEIGHT) * 100}%` }} />
            ))}
          </div>
          <div className="relative w-full overflow-hidden bg-white shadow-lg" style={{ aspectRatio: '612 / 936' }}>
            <PdfPage pageNumber={2} width={width} renderTextLayer={false} renderAnnotationLayer={false} className="absolute inset-0 h-full w-full" />
            {textFields.slice(7).map(field => (
              <textarea key={field.key} aria-label={field.label} value={content[field.key] || ''} onChange={e => onChange(field.key, e.target.value)} disabled={!isEditable} className={areaOverlay} style={{ left: pdfLeft(field.x), top: pdfTop(field.top, field.height), width: pdfLeft(field.width), height: `${(field.height / PDF_HEIGHT) * 100}%` }} />
            ))}
            <input aria-label="Houseparent Assessed By" value={houseparentName} readOnly className={`${overlay} font-bold`} style={{ left: pdfLeft(58), top: pdfTop(444.4, 19), width: pdfLeft(220), height: '2.1%' }} />

            {/* The Houseparent's signature, drawn in place on the "Assessed by"
                band. Read-only once the report is no longer editable, and it
                keeps showing whatever was signed. */}
            <div
              className="absolute z-20"
              style={{
                left: pdfLeft(HOUSEPARENT_SIGNATURE_BOX.x),
                top: `${(HOUSEPARENT_SIGNATURE_BOX.top / PDF_HEIGHT) * 100}%`,
                width: pdfLeft(HOUSEPARENT_SIGNATURE_BOX.width),
                height: `${(HOUSEPARENT_SIGNATURE_BOX.height / PDF_HEIGHT) * 100}%`,
              }}
            >
              {/*
                The "Assessed by" band is only a few millimetres tall on the
                printed form, so the pad opens a full-size canvas in a modal
                instead of drawing into that sliver.
              */}
              <SignaturePadModal
                label="Houseparent signature"
                value={houseparentSignature}
                onChange={(value) => onChange('__houseparentSignature', value)}
                disabled={!isEditable}
                hint="Sign here"
              />
            </div>
          </div>
        </PdfDocument>
      </div>
    </div>
  );
}

export function AnecdotalReports({
  recordId: recordIdProp,
  embedded = false,
  canReview = false,
  onStatusChange,
}: {
  recordId?: string | null;
  embedded?: boolean;
  canReview?: boolean;
  /** Called after a reviewer approves or rejects, so a parent list can refresh. */
  onStatusChange?: () => void;
} = {}) {
  const { user } = useAuth();
  const { children } = useData();
  const role = String(user?.role || '').toLowerCase();
  const isHouseparent = ['houseparent', 'house_parent', 'house parent'].includes(role);
  const isSocialWorker = ['socialworker', 'social_worker', 'social worker'].includes(role);
  const isCenterHeadOrAdmin = ['centerhead', 'center_head', 'center head', 'admin', 'administrator'].includes(role);
  const isReportAuthor = isHouseparent || isSocialWorker || isCenterHeadOrAdmin;
  const reviewer = canReview || ['socialworker','centerhead','admin'].includes(role);
  const [records, setRecords] = useState<AnecdotalRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Confirmations and outcomes for save / submit / return / approve. The inline
  // `error` box stays for the messages that belong beside the form; the
  // transitions get a dialog, so nothing is reported in a browser box titled
  // with the page's origin.
  const dialog = useSystemDialog();
  const [selectedRecord, setSelectedRecord] = useState<AnecdotalRecord | null>(null);
  const [newResidentId, setNewResidentId] = useState('');
  const [showResidentPicker, setShowResidentPicker] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [room, setRoom] = useState('');
  const [reportDate, setReportDate] = useState('');
  const [houseparentSignature, setHouseparentSignature] = useState('');
  const [content, setContent] = useState<Record<string,string>>(blankContent());
  const [searchTerm, setSearchTerm] = useState('');
  const [filterYear, setFilterYear] = useState(String(parseDateParts().year));
  const [filterMonth, setFilterMonth] = useState(String(parseDateParts().month));
  const [reviewNotes, setReviewNotes] = useState('');
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [recordIdFromUrl] = useState(() => recordIdProp || new URLSearchParams(window.location.search).get('anecdotalId'));
  /**
   * The residents a Houseparent may write about. `null` means "not restricted"
   * (every other author role sees the whole facility); a Set means "only these".
   * The backend enforces the same rule in `assertResidentAccess`, which is what
   * actually stops a forged request — this only keeps the picker honest.
   */
  const [assignedResidentIds, setAssignedResidentIds] = useState<Set<string> | null>(() => isHouseparent ? new Set<string>() : null);

  const activeChildren = useMemo(() => children.filter(c => c.status === 'Active' || !c.status), [children]);
  const currentResidentId = selectedRecord?.residentId || newResidentId;
  const selectedChild = currentResidentId ? children.find(c => c.id === currentResidentId) : null;
  const houseparentName = selectedRecord?.houseparentName || displayName(user);

  // A Houseparent's picker lists only their own caseload. The caseload
  // response carries one card per active Houseparent (so the roster can
  // mirror the Center Head's view elsewhere in the app), so the caller's
  // own entry has to be picked out by id/username rather than assumed to be
  // the only one in the response.
  useEffect(() => {
    if (!isHouseparent) { setAssignedResidentIds(null); return; }
    let cancelled = false;
    const currentUserId = String((user as any)?.id || '');
    const currentUsername = String((user as any)?.username || '').toLowerCase();
    request<{ success: boolean; data: any[] }>('/resident-assignments/caseload', { method: 'GET' })
      .then(res => {
        if (cancelled) return;
        const mine = (res?.data || []).find((entry) =>
          (currentUserId && String(entry?.userId) === currentUserId) ||
          (currentUsername && String(entry?.username || '').toLowerCase() === currentUsername)
        );
        const ids = new Set<string>();
        for (const resident of mine?.residents || []) if (resident?.id) ids.add(String(resident.id));
        setAssignedResidentIds(ids);
      })
      // Fail closed: an unreadable caseload must not silently widen the picker
      // to every resident in the facility.
      .catch(() => { if (!cancelled) setAssignedResidentIds(new Set()); });
    return () => { cancelled = true; };
  }, [isHouseparent, user]);

  const selectableChildren = useMemo(
    () => (assignedResidentIds ? activeChildren.filter(c => assignedResidentIds.has(String(c.id))) : activeChildren),
    [activeChildren, assignedResidentIds]
  );

  /** Which required sections are still blank, in form order. */
  const missingSections = useMemo(() => {
    const missing: string[] = [];
    if (!String(reportDate || '').trim()) missing.push('Report date');
    for (const field of textFields) {
      if (!String(content[field.key] || '').trim()) missing.push(field.label);
    }
    return missing;
  }, [content, reportDate]);
  const isComplete = missingSections.length === 0;
  const canSubmit = isHouseparent && isComplete && !saving;
  // Mirrors the backend's editability rule in anecdotalReportController.update():
  // reviewers may edit anything not yet finalized; any author role may edit a
  // Draft or a report returned to them. The previous version granted Draft access
  // only to center heads/admins, so a Social Worker who created a report could
  // save it but then had no Save/Submit buttons at all.
  const isEditable = !selectedRecord
    || (reviewer && ['Draft','Returned','Submitted','Under Review'].includes(selectedRecord.status))
    || (isReportAuthor && ['Draft','Returned'].includes(selectedRecord.status));

  async function loadRecords() {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (filterYear) params.set('year', filterYear);
      if (filterMonth) params.set('month', filterMonth);
      const res = await request<{ success: boolean; data?: AnecdotalRecord[] }>(`/anecdotal-reports?${params.toString()}`);
      setRecords(res?.success ? res.data || [] : []);
    } catch (err: any) {
      setError(err?.message || 'Unable to load anecdotal reports.');
      setRecords([]);
    } finally { setLoading(false); }
  }

  useEffect(() => { loadRecords(); }, [filterYear, filterMonth]);

  useEffect(() => {
    if (!recordIdFromUrl) return;
    request<{ success: boolean; data?: AnecdotalRecord }>(`/anecdotal-reports/${encodeURIComponent(recordIdFromUrl)}`)
      .then(res => { if (res?.success && res.data) openRecord(res.data); })
      .catch(() => {});
  }, [recordIdFromUrl]);

  function openRecord(record: AnecdotalRecord) {
    setSelectedRecord(record);
    setRoom(record.room || '');
    setReportDate(String(record.reportDate || '').slice(0,10));
    setHouseparentSignature(record.houseparentSignature || '');
    setContent({ ...blankContent(), ...(record.content || {}) });
    setReviewNotes(record.reviewNotes || '');
    setShowEditor(true);
  }

  function startNew() {
    if (!isReportAuthor) return;
    const p = parseDateParts();
    setSelectedRecord(null);
    setNewResidentId('');
    setRoom('');
    setReportDate(`${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`);
    setHouseparentSignature('');
    setContent(blankContent());
    setReviewNotes('');
    setError(null);
    setShowEditor(false);
    setShowResidentPicker(true);
  }

  async function beginNewForResident(residentId: string) {
    if (!residentId) return;
    setError(null);
    try {
      const p = parseDateParts();
      const res = await request<{ success: boolean; data?: AnecdotalRecord[] }>(
        `/anecdotal-reports?residentId=${encodeURIComponent(residentId)}&year=${p.year}&month=${p.month}`
      );
      const existing = Array.isArray(res.data) ? res.data : [];
      if (existing.length > 0) {
        const editable = existing.find(r => ['Returned', 'Draft'].includes(r.status));
        if (editable) {
          openRecord(editable);
          setShowResidentPicker(false);
          setError(editable.reviewNotes
            ? `An Anecdotal Report already exists for this resident and month and was returned for revision. Reviewer note: ${editable.reviewNotes}`
            : 'An Anecdotal Report already exists for this resident and month. The existing editable record has been opened.');
          return;
        }
        setError('An Anecdotal Report already exists for this resident and month and cannot be created again until that report is returned for revision.');
        return;
      }
    } catch (err: any) {
      setError(err?.message || 'Unable to check whether an Anecdotal Report already exists for this resident and month.');
      return;
    }
    setNewResidentId(residentId);
    setShowResidentPicker(false);
    setShowEditor(true);
  }

  function changeField(key: string, value: string) {
    if (key === '__room') { setRoom(value); return; }
    if (key === '__reportDate') { setReportDate(value); return; }
    if (key === '__houseparentSignature') { setHouseparentSignature(value); return; }
    setContent(prev => ({ ...prev, [key]: value }));
  }

  async function saveDraft() {
    if (!isReportAuthor) return;
    const childId = selectedRecord?.residentId || newResidentId;
    if (!childId) {
      setError('Select a resident from the New Anecdotal Report action before saving.');
      return;
    }
    setSaving(true); setError(null);
    try {
      const payload = { residentId: childId, reportDate, room, houseparentName: displayName(user), houseparentSignature, content };
      const res = selectedRecord
        ? await request<{ success:boolean; data:AnecdotalRecord }>(`/anecdotal-reports/${selectedRecord.id}`, { method:'PUT', body: JSON.stringify(payload) })
        : await request<{ success:boolean; data:AnecdotalRecord }>('/anecdotal-reports', { method:'POST', body: JSON.stringify(payload) });
      setSelectedRecord(res.data); setShowEditor(true); await loadRecords();
      await dialog.success(
        'Draft saved.',
        'The report is stored as a Draft. You can keep editing it and submit it when every section is filled in.',
      );
    } catch (err:any) {
      setError(describeError(err, 'Unable to save the anecdotal report.'));
      await dialog.failure('Could not save the report', describeError(err, 'The report was not saved. Please try again.'));
    }
    finally { setSaving(false); }
  }

  /**
   * Submission is a Houseparent action — a reviewer approves or rejects, they do
   * not submit. Everything is validated before the confirmation is shown, so the
   * dialog is never the thing that discovers a blank section.
   */
  function requestSubmit() {
    if (!isHouseparent) return;
    if (!(selectedRecord?.residentId || newResidentId)) { setError('Select a resident before submitting the report.'); return; }
    if (!isComplete) {
      setError(`Complete every section before submitting. Still blank: ${missingSections.join(', ')}.`);
      return;
    }
    setError(null);
    setShowSubmitConfirm(true);
  }

  /**
   * Persists the report and then submits it, in that order.
   *
   * The save is an update when the report already exists and a create when it
   * does not, so a Houseparent can fill the form in and submit straight away —
   * they never have to save a Draft, leave the editor, and reopen it from Saved
   * Drafts first. Submitting an already-saved Draft goes through the same path.
   */
  async function confirmSubmit() {
    setShowSubmitConfirm(false);
    if (!isHouseparent) return;
    const childId = selectedRecord?.residentId || newResidentId;
    if (!childId) { setError('Select a resident before submitting the report.'); return; }
    setSaving(true); setError(null);
    try {
      const payload = { residentId: childId, reportDate, room, houseparentName: displayName(user), houseparentSignature, content };
      const saved = selectedRecord
        ? await request<{ success: boolean; data: AnecdotalRecord }>(`/anecdotal-reports/${selectedRecord.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await request<{ success: boolean; data: AnecdotalRecord }>('/anecdotal-reports', { method: 'POST', body: JSON.stringify(payload) });
      const id = saved?.data?.id;
      if (!id) throw new Error('Unable to save the report before submitting.');
      const res = await request<{ success: boolean; data: AnecdotalRecord }>(`/anecdotal-reports/${id}/submit`, { method: 'POST' });
      setSelectedRecord(res.data);
      await loadRecords();
      await dialog.success(
        'Anecdotal Report submitted.',
        'The Social Worker and the Center Head can now review it. You will be notified if it is returned to you for revision.',
      );
    } catch (err: any) {
      setError(describeError(err, 'Unable to submit the anecdotal report.'));
      await dialog.failure('Could not submit the report', describeError(err, 'The report was not submitted. Please try again.'));
    }
    finally { setSaving(false); }
  }

  async function returnForRevision() {
    if (!selectedRecord || !reviewer || !reviewNotes.trim()) return;
    setSaving(true); setError(null);
    const notes = reviewNotes.trim();
    try {
      const res = await request<{success:boolean;data:AnecdotalRecord}>(`/anecdotal-reports/${selectedRecord.id}/return`, { method:'POST', body:JSON.stringify({ reviewNotes: notes }) });
      setReviewNotes('');
      setSelectedRecord(res.data); await loadRecords(); onStatusChange?.();
      await dialog.success(
        'Report returned for revision.',
        'The author can edit it again and resubmit. Your notes are shown with the report.',
      );
    } catch (err:any) {
      setError(describeError(err, 'Unable to return the report.'));
      await dialog.failure('Could not return the report', describeError(err, 'The report was not returned. Please try again.'));
    }
    finally { setSaving(false); }
  }

  async function finalize() {
    if (!selectedRecord || !reviewer) return;
    const confirmed = await dialog.confirm({
      title: 'Approve this Anecdotal Report?',
      description: 'Approving is final. The report becomes part of the resident\'s official record, is filed in their Anecdotal Reports folder, and can no longer be edited. If something needs changing, return it for revision instead.',
      confirmLabel: 'Approve report',
      tone: 'warning',
    });
    if (!confirmed) return;
    setSaving(true); setError(null);
    try {
      const res = await request<{success:boolean;data:AnecdotalRecord}>(`/anecdotal-reports/${selectedRecord.id}/finalize`, { method:'POST' });
      setSelectedRecord(res.data); await loadRecords(); onStatusChange?.();
      await dialog.success(
        'Anecdotal Report approved.',
        'The report is now part of the resident\'s official record and has been filed in the Documents module.',
      );
    } catch (err:any) {
      setError(describeError(err, 'Unable to approve the report.'));
      await dialog.failure('Could not approve the report', describeError(err, 'The report was not approved. Please try again.'));
    }
    finally { setSaving(false); }
  }

  async function exportPdf(record: AnecdotalRecord | null) {
    if (!record?.id) return;
    setError(null);
    try {
      await downloadAnecdotalPdf(record);
    } catch (err: any) {
      const message = describeError(err, 'Unable to download the Anecdotal Report PDF.');
      setError(message);
      await dialog.failure('Could not download the report', message);
    }
  }

  const filtered = records.filter(r => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return true;
    const name = children.find(c => c.id === r.residentId)?.name || r.residentId;
    return name.toLowerCase().includes(q) || String(r.status).toLowerCase().includes(q);
  });

  const deadline = getLastMonday(Number(filterYear), Number(filterMonth));

  return (
    <div className={embedded ? 'space-y-4' : 'space-y-5 p-2'}>
      {!embedded && (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold text-[#2F3E46] flex items-center gap-2"><FileText className="w-6 h-6 text-[#FFD100]" /> Anecdotal Reports</h2>
            <p className="text-sm text-gray-500">Monthly resident observations submitted by Houseparents for Social Worker review.</p>
          </div>
          {isReportAuthor && !isSocialWorker && <Button onClick={startNew} className="bg-[#2F3E46] text-white gap-2"><FileText className="w-4 h-4" /> New Anecdotal Report</Button>}
        </div>
      )}
      {/*
        The Monthly Submission Deadline banner used to sit here as well, so a
        Houseparent saw it twice: once at the top of the Houseparent module and
        again under this heading. It is kept at the top of the module, where it
        belongs to every tab rather than to one, and removed here. This component
        has no other non-embedded home — the Reports module always passes
        `embedded` — so nothing loses the warning.
      */}

      {!showEditor && !embedded && (
        <>
          <div className="flex flex-col gap-3 sm:flex-row"><Input value={searchTerm} onChange={e=>setSearchTerm(e.target.value)} placeholder="Search resident…" className="sm:max-w-sm" /><div className="flex gap-2"><select value={filterYear} onChange={e=>setFilterYear(e.target.value)} className="h-10 rounded-md border px-3 text-sm">{[Number(filterYear)-1,Number(filterYear),Number(filterYear)+1].map(y=><option key={y}>{y}</option>)}</select><select value={filterMonth} onChange={e=>setFilterMonth(e.target.value)} className="h-10 rounded-md border px-3 text-sm">{MONTHS.map((m,i)=><option key={m} value={i+1}>{m}</option>)}</select></div></div>
          {error && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{error}</AlertDescription></Alert>}
          <Card><CardHeader><CardTitle className="text-[#2F3E46]">Anecdotal Report Records</CardTitle></CardHeader><CardContent>{loading ? <div className="py-12 text-center text-sm text-gray-400">Loading…</div> : filtered.length===0 ? <div className="py-12 text-center text-sm text-gray-400">No anecdotal reports found.</div> : <div className="space-y-2">{filtered.map(r=>{const child=children.find(c=>c.id===r.residentId); return <div key={r.id} className="rounded-xl border p-3"><div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div><p className="font-semibold text-[#2F3E46]">{child?.name||r.residentId}</p><p className="text-xs text-gray-500">{MONTHS[(r.reportMonth||1)-1]} {r.reportYear} · {r.houseparentName||'—'}</p><div className="mt-1 flex flex-wrap items-center gap-2"><Badge className="bg-gray-100 text-gray-700">{r.status}</Badge>{r.submittedAt && <span className="text-[10px] text-gray-400">Submitted {new Date(r.submittedAt).toLocaleString()}</span>}</div></div><Button size="sm" variant="outline" onClick={()=>openRecord(r)}>{reviewer ? 'View / Edit' : 'View'}</Button></div></div>})}</div>}</CardContent></Card>
        </>
      )}

      <Dialog open={showResidentPicker} onOpenChange={setShowResidentPicker}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Who is this Anecdotal Report for?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-gray-500">Select a resident before completing the formal Anecdotal Report.</p>
            <Select onValueChange={beginNewForResident}>
              <SelectTrigger><SelectValue placeholder="Select resident..." /></SelectTrigger>
              <SelectContent>
                {selectableChildren.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-gray-400">
                    {isHouseparent
                      ? 'No residents are currently assigned to you. Ask the Center Head to assign a resident to your caseload.'
                      : 'No active residents available.'}
                  </div>
                ) : selectableChildren.map(child => (
                  <SelectItem key={child.id} value={child.id}>{child.name} ({child.id})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation before the report leaves the Houseparent's hands. Until
          they answer Yes the report stays exactly as it is — still editable. */}
      <Dialog open={showSubmitConfirm} onOpenChange={setShowSubmitConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Are you sure you want to submit this report?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            {selectedChild ? `${selectedChild.name}'s` : 'This'} Anecdotal Report will be sent to the Social Worker for review.
            You will not be able to edit it while it is under review.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowSubmitConfirm(false)} disabled={saving}>
              No
            </Button>
            <Button onClick={confirmSubmit} disabled={saving} className="gap-2 bg-[#2F3E46] text-white">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Yes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showEditor && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-white px-4 py-3 shadow-sm">
            <div className="min-w-0 flex-1"><p className="text-sm font-bold text-[#2F3E46]">Anecdotal Report{selectedChild ? ` — ${selectedChild.name}` : ''}</p><p className="text-xs text-gray-500">{selectedRecord ? selectedRecord.status : 'Draft'}</p></div>
            <div className="flex flex-wrap gap-2">
              {selectedRecord && <Button size="sm" variant="outline" onClick={()=>exportPdf(selectedRecord)} className="gap-2"><Download className="h-4 w-4" /> Download</Button>}
              <Button size="sm" variant="ghost" onClick={()=>{setShowEditor(false); if(!embedded) loadRecords();}}><CloseIcon className="h-4 w-4" /> Close</Button>
            </div>
          </div>
          {error && <div className="mx-4 mt-3"><Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{error}</AlertDescription></Alert></div>}
          {selectedRecord || newResidentId ? (
            <AnecdotalPdfEditor record={selectedRecord} child={selectedChild} room={room} content={content} reportDate={reportDate} houseparentName={houseparentName} houseparentSignature={houseparentSignature} isEditable={isEditable} onChange={changeField} />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="max-w-md rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center">
                <p className="font-semibold text-[#2F3E46]">Select a resident first</p>
                <p className="mt-1 text-sm text-gray-500">Choose the resident above before the official Anecdotal Report form becomes available.</p>
              </div>
            </div>
          )}
          {reviewer && selectedRecord && REVIEWABLE_STATUSES.includes(selectedRecord.status) && (
            <p className="border-t bg-white px-4 pt-3 text-xs text-gray-500">
              <strong>Approve</strong> publishes the official Anecdotal Report PDF to {selectedChild?.name || 'the resident'}&rsquo;s Documents folder.
              {' '}<strong>Reject</strong> sends it back to the author and publishes nothing.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-gray-50 px-4 py-3">
            {reviewer && selectedRecord && REVIEWABLE_STATUSES.includes(selectedRecord.status) && (
              <div className="mr-auto flex min-w-[280px] flex-1 gap-2">
                <Input value={reviewNotes} onChange={e=>setReviewNotes(e.target.value)} placeholder="Reason for rejection (required to reject)…" />
              </div>
            )}
            {reviewer && selectedRecord && REVIEWABLE_STATUSES.includes(selectedRecord.status) && (
              <Button variant="outline" onClick={returnForRevision} disabled={saving || !reviewNotes.trim()} className="gap-2 text-red-600" title="Send the report back to its author without publishing it">
                <RotateCcw className="h-4 w-4" /> Reject
              </Button>
            )}
            {reviewer && selectedRecord && REVIEWABLE_STATUSES.includes(selectedRecord.status) && (
              <Button onClick={finalize} disabled={saving} className="gap-2 bg-green-600 hover:bg-green-700" title="Approve the report and publish its PDF to the resident's Documents">
                <CheckCircle2 className="h-4 w-4" /> Approve
              </Button>
            )}
            {isReportAuthor && isEditable && <Button variant="outline" onClick={saveDraft} disabled={saving || !(selectedRecord?.residentId || newResidentId)} className="gap-2"><Save className="h-4 w-4" /> Save Draft</Button>}
            {/* Submission belongs to the Houseparent. A Social Worker reviewing
                the same report approves or rejects it instead. */}
            {isHouseparent && isEditable && (
              <Button
                onClick={requestSubmit}
                disabled={!canSubmit}
                className="gap-2 bg-[#2F3E46] text-white"
                title={isComplete ? undefined : `Still blank: ${missingSections.join(', ')}`}
              >
                <Send className="h-4 w-4" /> Submit to Social Worker
              </Button>
            )}
          </div>
        </div>
      )}

      {!embedded && !showEditor && isHouseparent && (
        <p className="text-xs text-gray-400">Reports are submitted to the Social Worker for review. The official PDF is added to the resident&rsquo;s Documents only once the report is approved.</p>
      )}
    </div>
  );
}
