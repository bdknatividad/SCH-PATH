import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from '@/app/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/app/components/ui/select';
import {
  FileText, Download, Loader2, AlertCircle, CheckCircle2,
  UserCheck, Lock, PenLine, Eye, ArrowLeft,
} from 'lucide-react';
import { Document as PdfDocument, Page as PdfPage, pdfjs } from 'react-pdf';
import { SignaturePadModal } from '@/app/components/SignaturePad';
import { downloadAnecdotalPdf } from '@/app/components/AnecdotalReports';
import { useData } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { request } from '@/services/api';
import templateLayout from '@/shared/quarterlyReportTemplate.json';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';

/**
 * Quarterly Progress Report — the facility's six-Developmental-Aspect report.
 *
 * This lives inside the Reports module (it has no sidebar entry of its own).
 * `QuarterlyProgressReportsCard` is what the Reports tab shows; opening one
 * raises `QuarterlyProgressReportEditor`, a full-screen form.
 *
 * ── THE FORM IS THE REPORT ───────────────────────────────────────────────────
 * Opening a report fetches a fill-in PDF from `GET /:id/template` and renders it
 * in a full-screen dialog, the way the TRI renders the official TRI. The document
 * behind the inputs is the report's own layout, so the Social Worker is writing on
 * the form they are producing rather than on a web page that resembles it.
 *
 * ── WHAT THE SYSTEM FILLS IN ─────────────────────────────────────────────────
 * Everything on page 1. The masthead, the period and the whole identifying block —
 * name, sex, age, birth date, religion, educational attainment, school, addresses,
 * admission date, guardian, contact, case type and status — come from the
 * resident's records, and the "Prepared by" name comes from the signed-in
 * account. None of it is typed here.
 *
 * ── WHAT ONLY A PERSON CAN SUPPLY ────────────────────────────────────────────
 * The three narrative columns of each aspect, and the signature. "Present level of
 * Functioning" in particular is a professional assessment: a system that guessed
 * at it would be inventing a clinical opinion. The reference form's own sample
 * values (Moderate, Normal) are offered as suggestions, and nothing is inserted on
 * the Social Worker's behalf.
 *
 * The inputs are transparent and borderless because the PDF underneath already
 * draws the cell, the column rules and the row shading. Their positions come from
 * `frontend/src/shared/quarterlyReportTemplate.json`, which the backend PDF writer
 * also reads — one copy of the coordinates, as with `triLayout.json`.
 */

export interface QprSection {
  id: string;
  reportId: string;
  aspectKey: string;
  aspectLabel: string;
  sortOrder: number;
  presentLevel?: string | null;
  observations?: string | null;
  interventions?: string | null;
  status: string;
  /** Server-computed: the caller may write this aspect and the report is open. */
  canEdit?: boolean;
  /** Server-computed: the aspect holds something the report can print. */
  hasContent?: boolean;
}

export interface QprReport {
  id: string;
  residentId: string;
  periodStart: string;
  periodEnd: string;
  periodLabel?: string | null;
  identifyingInformation?: Record<string, string> | null;
  status: string;
  /** The single signature at the foot of the report — whoever prepared it. */
  preparedByName?: string | null;
  preparedBySignature?: string | null;
  sections?: QprSection[];
  /** Server-computed: the caller may prepare this report. */
  isReviewer?: boolean;
  canEditReport?: boolean;
  canFinalize?: boolean;
  canDelete?: boolean;
  sectionsTotal?: number;
  /** Aspects that hold text. Drives the completeness hint before finalizing. */
  sectionsComplete?: number;
}

export interface QprPeriod {
  periodStart: string;
  periodEnd: string;
  label: string;
  headerLabel: string;
}

/**
 * The rating suggestions. These are the two values the official form's own
 * worked example uses; the field stays free text so staff are not forced into a
 * vocabulary the facility has not agreed on.
 */
const RATING_SUGGESTIONS = ['Normal', 'Moderate'];

function formatDate(value?: string | null): string {
  const iso = String(value ?? '').slice(0, 10);
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const STATUS_STYLES: Record<string, string> = {
  'Draft': 'bg-gray-100 text-gray-700',
  'Submitted': 'bg-blue-100 text-blue-700',
  'Under Review': 'bg-amber-100 text-amber-700',
  'Returned': 'bg-red-100 text-red-700',
  'Finalized': 'bg-green-100 text-green-700',
  'Not Started': 'bg-gray-100 text-gray-600',
  'In Progress': 'bg-amber-100 text-amber-700',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

/** Downloads the combined PDF for a saved report. */
export async function downloadQuarterlyProgressPdf(report: { id: string }): Promise<void> {
  const token = localStorage.getItem('token');
  const response = await fetch(`/api/quarterly-progress-reports/${encodeURIComponent(report.id)}/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    let message = 'Unable to download the Quarterly Progress Report.';
    try {
      const body = await response.json();
      if (body?.message) message = body.message;
    } catch { /* non-JSON error body */ }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'Quarterly Progress Report.pdf';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * The fill-in geometry, shared with the backend writer
 * (`backend/src/utils/quarterlyReportPdf.js`) through one JSON file — the same
 * arrangement `triLayout.json` uses for the TRI overlay. The backend derives
 * these numbers from the metrics it draws with and a test fails if the two stop
 * agreeing, so a coordinate is never written down twice.
 */
interface TemplateLayout {
  page: { width: number; height: number; marginX: number; marginBottom: number };
  table: {
    cellPad: number;
    rowHeight: number;
    rowsPerPage: number;
    tableTops: number[];
    columns: Array<{ key: string; x: number; width: number }>;
  };
  signature: { x: number; top: number; width: number; height: number };
}

const LAYOUT = templateLayout as unknown as TemplateLayout;

/** PDF points → a CSS percentage of the rendered page. */
const pctX = (points: number) => `${(points / LAYOUT.page.width) * 100}%`;
const pctH = (points: number) => `${(points / LAYOUT.page.height) * 100}%`;
/** pdf-lib measures y up from the bottom of the page; CSS measures down from the top. */
const pctTop = (yFromBottom: number) => `${((LAYOUT.page.height - yFromBottom) / LAYOUT.page.height) * 100}%`;

/**
 * The box one writable cell occupies on the rendered page.
 *
 * A row's top edge is its page's table top less the rows above it, and the input
 * is inset by the same cell padding the PDF draws its own text with — so what is
 * typed here lands where the finished report will print it.
 */
function cellBox(pageIndex: number, rowIndex: number, columnKey: string) {
  const column = LAYOUT.table.columns.find((entry) => entry.key === columnKey);
  if (!column) throw new Error(`Unknown template column: ${columnKey}`);
  const pad = LAYOUT.table.cellPad;
  const rowTop = LAYOUT.table.tableTops[pageIndex] - rowIndex * LAYOUT.table.rowHeight;
  return {
    left: pctX(column.x + pad),
    top: pctTop(rowTop - pad),
    width: pctX(column.width - pad * 2),
    height: pctH(LAYOUT.table.rowHeight - pad * 2),
  };
}

/**
 * The three writable columns of one Developmental Aspect, laid over the blank row
 * the template PDF printed for it.
 *
 * The fields are transparent and borderless on purpose: the report underneath
 * already draws the cell, the column rules and the row shading, so anything this
 * adds would be a second set of lines on the same table. Only the cell being
 * written is tinted, which is what makes it findable on a page of white cells.
 */
function AspectCells({
  section,
  pageIndex,
  rowIndex,
  onChange,
  disabled,
}: {
  section: QprSection;
  pageIndex: number;
  rowIndex: number;
  onChange: (patch: Partial<QprSection>) => void;
  disabled: boolean;
}) {
  const editable = Boolean(section.canEdit) && !disabled;
  const field = [
    'absolute z-10 resize-none border-0 bg-transparent p-0 leading-snug text-black',
    'text-[clamp(7px,1.05vw,12px)] outline-none',
    editable
      ? 'focus:bg-yellow-100/70 focus:ring-1 focus:ring-yellow-500/70'
      : 'pointer-events-none',
  ].join(' ');

  return (
    <>
      <input
        aria-label={`${section.aspectLabel} — present level of functioning`}
        list={`qpr-rating-${section.id}`}
        value={section.presentLevel || ''}
        onChange={(event) => onChange({ presentLevel: event.target.value })}
        readOnly={!editable}
        placeholder={editable ? 'e.g. Moderate' : ''}
        className={field}
        style={cellBox(pageIndex, rowIndex, 'presentLevel')}
      />
      <datalist id={`qpr-rating-${section.id}`}>
        {RATING_SUGGESTIONS.map((value) => <option key={value} value={value} />)}
      </datalist>

      <textarea
        aria-label={`${section.aspectLabel} — observations`}
        value={section.observations || ''}
        onChange={(event) => onChange({ observations: event.target.value })}
        readOnly={!editable}
        placeholder={editable ? 'What was observed this period…' : ''}
        className={field}
        style={cellBox(pageIndex, rowIndex, 'observations')}
      />

      <textarea
        aria-label={`${section.aspectLabel} — rendered programs, activities and intervention`}
        value={section.interventions || ''}
        onChange={(event) => onChange({ interventions: event.target.value })}
        readOnly={!editable}
        placeholder={editable ? 'What was provided, arranged or encouraged…' : ''}
        className={field}
        style={cellBox(pageIndex, rowIndex, 'interventions')}
      />
    </>
  );
}

// ── ANECDOTAL REPORT REFERENCE ───────────────────────────────────────────────
//
// The QPR editor offers the resident's Anecdotal Reports as a *reference*, the
// way the TRI form offers the resident's violations. It is placed and behaves
// like that control — a button in the form toolbar that surfaces another record
// set about the same resident — with one difference the specification asks for:
// a modal rather than the TRI's inline panel, plus Month/Year filtering.
//
// It is reference only. Nothing here is copied into the report and no
// observation is generated from it, which is why the panel has no "Insert" or
// "Use this" action: the only route from an anecdotal report into the QPR is the
// Social Worker or Center Head typing it themselves.

/** The ten sections of the official form, in form order. */
const ANECDOTAL_SECTIONS: Array<{ key: string; label: string }> = [
  { key: 'physical', label: '1. Physical' },
  { key: 'emotional', label: '2. Emotional' },
  { key: 'behavioral', label: '3. Behavioral' },
  { key: 'education', label: '4. Education' },
  { key: 'spiritual', label: '5. Spiritual' },
  { key: 'productivity', label: '6. Productivity' },
  { key: 'coPeers', label: 'B. Relationship with co-peers' },
  { key: 'staff', label: 'C. Relationship with staff' },
  { key: 'groupLiving', label: 'D. Group Living Activities' },
  { key: 'recommendations', label: 'E. Recommendation/s' },
];

const ANECDOTAL_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Roles the button is offered to. The API refuses every other role outright. */
const ANECDOTAL_REFERENCE_ROLES = new Set(['socialworker', 'centerhead', 'admin']);

interface AnecdotalReferenceRecord {
  id: string;
  residentId?: string;
  reportDate?: string;
  reportYear?: number;
  reportMonth?: number;
  room?: string;
  houseparentName?: string;
  status?: string;
  content?: Record<string, string>;
  createdBy?: string | null;
  submittedBy?: string | null;
  submittedAt?: string | null;
}

/** A short standfirst for the list, taken from the first section that was filled. */
function anecdotalPreview(record: AnecdotalReferenceRecord): string {
  const content = record.content || {};
  for (const section of ANECDOTAL_SECTIONS) {
    const text = String(content[section.key] || '').trim();
    if (text) return text.length > 180 ? `${text.slice(0, 180)}…` : text;
  }
  return 'No section has been written yet.';
}

function AnecdotalReferenceDialog({
  residentId,
  residentName,
  onClose,
}: {
  residentId: string;
  residentName?: string;
  onClose: () => void;
}) {
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState('all');
  const [records, setRecords] = useState<AnecdotalReferenceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AnecdotalReferenceRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ residentId });
        if (year) params.set('year', year);
        if (month !== 'all') params.set('month', month);
        const result = await request<{ success: boolean; data?: AnecdotalReferenceRecord[] }>(
          `/anecdotal-reports?${params.toString()}`,
        );
        if (!cancelled) setRecords(Array.isArray(result?.data) ? result.data : []);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || "Unable to load this resident's Anecdotal Reports.");
          setRecords([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [residentId, year, month]);

  // Years to offer: the current one back six, plus anything the loaded rows
  // mention, so a report filed in an older year is still reachable from here.
  const yearOptions = useMemo(() => {
    const years = new Set<number>();
    for (let offset = 0; offset < 6; offset += 1) years.add(now.getFullYear() - offset);
    records.forEach((record) => {
      const value = Number(record.reportYear);
      if (value) years.add(value);
    });
    return [...years].sort((a, b) => b - a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records]);

  const titleOf = (record: AnecdotalReferenceRecord) => {
    const monthName = ANECDOTAL_MONTH_NAMES[(Number(record.reportMonth) || 1) - 1];
    const recordYear = Number(record.reportYear) || now.getFullYear();
    return `Anecdotal Report — ${monthName} ${recordYear}`;
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-anecdotal-reference>
        <DialogHeader>
          <DialogTitle className="text-[#2F3E46]">
            Anecdotal Reports — {residentName || residentId}
          </DialogTitle>
          <DialogDescription>
            Reference only. Nothing here is copied into the Quarterly Progress Report — use it as a
            guide and write the observations yourself.
          </DialogDescription>
        </DialogHeader>

        {selected ? (
          <div className="space-y-3" data-anecdotal-full-report={selected.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button size="sm" variant="outline" className="gap-2" onClick={() => setSelected(null)}>
                <ArrowLeft className="h-3.5 w-3.5" /> Back to the list
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-2"
                onClick={() => downloadAnecdotalPdf(selected).catch((err) => setError(err.message))}
              >
                <Download className="h-3.5 w-3.5" /> PDF
              </Button>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
              <span><strong>Date:</strong> {formatDate(String(selected.reportDate || '').slice(0, 10))}</span>
              <span><strong>Submitted by:</strong> {selected.submittedBy || selected.houseparentName || selected.createdBy || '—'}</span>
              {selected.status && <span><strong>Status:</strong> {selected.status}</span>}
              {selected.room && <span><strong>Room:</strong> {selected.room}</span>}
            </div>

            <div className="space-y-3">
              {ANECDOTAL_SECTIONS.map((section) => (
                <div key={section.key}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#2F3E46]">{section.label}</p>
                  <p className="mt-1 whitespace-pre-line rounded border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-700">
                    {String(selected.content?.[section.key] || '').trim() || '—'}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Month</Label>
                <Select value={month} onValueChange={setMonth}>
                  <SelectTrigger className="w-40" data-anecdotal-month>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All months</SelectItem>
                    {ANECDOTAL_MONTH_NAMES.map((name, index) => (
                      <SelectItem key={name} value={String(index + 1)}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Year</Label>
                <Select value={year} onValueChange={setYear}>
                  <SelectTrigger className="w-32" data-anecdotal-year>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {yearOptions.map((option) => (
                      <SelectItem key={option} value={String(option)}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {error && (
              <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
            )}

            {loading ? (
              <p className="py-6 text-center text-xs text-gray-400">Loading Anecdotal Reports...</p>
            ) : records.length === 0 ? (
              <p className="py-6 text-center text-xs text-gray-400">
                No Anecdotal Report was filed for this resident in the selected period.
              </p>
            ) : (
              <div className="space-y-3">
                {records.map((record) => (
                  <Card key={record.id} data-anecdotal-record={record.id}>
                    <CardContent className="space-y-2 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-[#2F3E46]">{titleOf(record)}</span>
                        {record.status && (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600">
                            {record.status}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                        <span><strong>Date:</strong> {formatDate(String(record.reportDate || '').slice(0, 10))}</span>
                        <span>
                          <strong>Submitted by:</strong>{' '}
                          {record.submittedBy || record.houseparentName || record.createdBy || '—'}
                        </span>
                      </div>
                      <p className="whitespace-pre-line border-l-2 border-[#FFD100] pl-3 text-xs text-gray-700">
                        {anecdotalPreview(record)}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-2"
                        onClick={() => setSelected(record)}
                        data-anecdotal-open={record.id}
                      >
                        <Eye className="h-3.5 w-3.5" /> View full report
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The report editor: identifying information, the six aspects, and the sign-off
 * block. Rendered inline by the Reports tab and by the review queue.
 */
export function QuarterlyProgressReportEditor({
  reportId,
  onClose,
  onChanged,
}: {
  reportId: string;
  onClose?: () => void;
  onChanged?: () => void;
}) {
  const { children } = useData();
  const { user } = useAuth();
  /**
   * The name that will print under "Prepared by:".
   *
   * Defaults to the signed-in account's configured name — the display name set in
   * Account Management, falling back to the username — so the field is never
   * blank and never carries somebody else's leftover text. The server applies the
   * same default, so the stored report is right even if the client never sends it.
   */
  const accountName = String(user?.fullName || user?.username || '');
  const [report, setReport] = useState<QprReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Partial<QprSection>>>({});
  const [templateUrl, setTemplateUrl] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [renderWidth, setRenderWidth] = useState(900);
  const [anecdotalOpen, setAnecdotalOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  /**
   * Re-reads the report. `quiet` keeps the form on screen instead of swapping it
   * for the spinner — used after a save, where replacing the form with "Loading
   * report…" would look like the save had thrown the page away.
   */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const result = await request<{ data: QprReport }>(`/quarterly-progress-reports/${encodeURIComponent(reportId)}`);
      setReport(result.data);
      setDrafts({});
    } catch (err: any) {
      setError(err?.message || 'Unable to load the Quarterly Progress Report.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [reportId]);

  useEffect(() => { load(); }, [load]);

  /**
   * The form the Social Worker writes on *is* the report, so it is fetched rather
   * than rebuilt here: the server already knows how to lay the document out, and
   * drawing it a second time in the browser would be a second copy of the layout
   * to keep in step. What this component adds is only the handful of inputs that
   * cannot be printed.
   *
   * It comes back through the authenticated API, hence a blob URL rather than a
   * plain `/forms/...` path like the TRI's pre-printed template.
   */
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setTemplateError(null);
    setTemplateUrl(null);
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch(
          `/api/quarterly-progress-reports/${encodeURIComponent(reportId)}/template`,
          { headers: token ? { Authorization: `Bearer ${token}` } : undefined }
        );
        if (!response.ok) throw new Error('Unable to load the report form.');
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) { URL.revokeObjectURL(objectUrl); return; }
        setTemplateUrl(objectUrl);
      } catch (err: any) {
        if (!cancelled) setTemplateError(err?.message || 'Unable to load the report form.');
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reportId]);

  /**
   * Renders the PDF at the width of its host, capped so a wide screen does not
   * blow the page up past its natural size. The overlay is positioned in
   * percentages of that same box, so it scales with the render.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const measured = Math.floor(host.clientWidth);
      if (measured > 0) setRenderWidth(Math.min(900, measured));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const sections = report?.sections || [];
  const merged = useMemo(
    () => sections.map((section) => ({ ...section, ...(drafts[section.id] || {}) })),
    [sections, drafts]
  );

  const patch = (sectionId: string, value: Partial<QprSection>) => {
    setDrafts((prev) => ({ ...prev, [sectionId]: { ...(prev[sectionId] || {}), ...value } }));
  };

  const dirtySectionIds = Object.keys(drafts);
  const dirty = dirtySectionIds.length > 0;

  const discardDrafts = () => {
    setDrafts({});
    setMessage(null);
  };

  /**
   * Saves every aspect that was touched, in one action.
   *
   * Only the aspects travel from here: the identifying information is not typed
   * on this form, so there is nothing on it to save. The report was seeded from
   * the resident's records when it was opened and the server is the only thing
   * that writes that block.
   */
  const saveForm = async () => {
    if (!dirty) {
      setMessage('Nothing to save — the form already matches the report.');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      for (const sectionId of dirtySectionIds) {
        const section = merged.find((s) => s.id === sectionId);
        await request(
          `/quarterly-progress-reports/${encodeURIComponent(reportId)}/sections/${encodeURIComponent(sectionId)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              presentLevel: section?.presentLevel ?? '',
              observations: section?.observations ?? '',
              interventions: section?.interventions ?? '',
            }),
          }
        );
      }
      await load(true);
      setMessage('Form saved.');
      onChanged?.();
    } catch (err: any) {
      setError(err?.message || 'The form could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const send = async (path: string, body: Record<string, unknown>, successMessage: string, method = 'POST') => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await request<{ data: QprReport; message?: string }>(
        `/quarterly-progress-reports/${encodeURIComponent(reportId)}${path}`,
        { method, body: JSON.stringify(body) }
      );
      setReport(result.data);
      setDrafts({});
      setMessage(result.message || successMessage);
      onChanged?.();
      return true;
    } catch (err: any) {
      setError(err?.message || 'That action could not be completed.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const child = children.find((c) => c.id === report?.residentId);
  const canEdit = Boolean(report?.canEditReport);
  const rowsPerPage = LAYOUT.table.rowsPerPage;
  const pageCount = Math.max(1, Math.ceil(merged.length / rowsPerPage));
  const remainingAspects = (report?.sectionsTotal ?? 0) - (report?.sectionsComplete ?? 0);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <DialogContent className="!top-0 !left-0 !flex !h-screen !w-screen !max-h-none !max-w-none !translate-x-0 !translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-white p-0">
        <DialogHeader className="hidden">
          <DialogTitle>Quarterly Progress Report</DialogTitle>
          <DialogDescription>Fill in the six Developmental Aspects and sign.</DialogDescription>
        </DialogHeader>

        {/* Toolbar — who the report is for, and the two things you can do to it from here. */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-white px-4 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-[#2F3E46]">
              {child?.name || report?.residentId || 'Quarterly Progress Report'}
            </span>
            {report && <StatusBadge status={report.status} />}
            {report && (
              <span className="text-xs text-gray-500">
                {report.periodLabel || `${formatDate(report.periodStart)} – ${formatDate(report.periodEnd)}`}
                {' · '}
                {report.sectionsComplete ?? 0}/{report.sectionsTotal ?? 0} aspects written
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/*
              The resident's Anecdotal Reports, offered the way the TRI form
              offers the resident's violations. Only the two roles the
              specification names see it; the API refuses the rest, so the
              control is hidden rather than shown and then failing.
            */}
            {report?.residentId && ANECDOTAL_REFERENCE_ROLES.has(String(user?.role || '').toLowerCase()) && (
              <Button
                size="sm"
                variant="outline"
                className="gap-2"
                onClick={() => setAnecdotalOpen(true)}
                data-view-anecdotal-reports
              >
                <Eye className="h-3.5 w-3.5" /> View Anecdotal Reports
              </Button>
            )}
            {report && (
              <Button
                size="sm"
                variant="outline"
                className="gap-2"
                onClick={() => downloadQuarterlyProgressPdf(report).catch((err) => setError(err.message))}
              >
                <Download className="h-3.5 w-3.5" /> PDF
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => onClose?.()}>Close</Button>
          </div>
        </div>

        {(message || error || templateError) && (
          <div className="space-y-2 border-b border-gray-100 bg-white px-4 py-2">
            {message && <p className="rounded-lg border border-green-100 bg-green-50 px-3 py-2 text-xs text-green-700">{message}</p>}
            {error && <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
            {templateError && <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{templateError}</p>}
          </div>
        )}

        {/*
          THE FORM.
          The report is shown as it prints, with the resident's details already on
          it. The only things this layer adds are the fields a person has to
          supply: the three narrative columns of each Developmental Aspect, laid
          over the blank rows the template left for them, and the signature.
        */}
        <div className="relative min-h-0 flex-1 overflow-y-auto bg-neutral-200 px-2 py-4 sm:px-6">
          <div ref={hostRef} className="mx-auto w-full max-w-[900px]">
            <div className="mb-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              The resident&rsquo;s details are already filled in from their records. Write the six Developmental
              Aspects, then sign at the foot of the last page.
            </div>

            {loading && (
              <p className="flex items-center gap-2 rounded-lg bg-white p-8 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading report…
              </p>
            )}
            {!loading && !report && (
              <p className="flex items-center gap-2 rounded-lg bg-white p-8 text-sm text-red-600">
                <AlertCircle className="h-4 w-4" /> {error || 'Report not found.'}
              </p>
            )}

            {report && templateUrl && (
              <PdfDocument
                file={templateUrl}
                loading={<div className="rounded-lg bg-white p-8 text-center text-sm text-gray-500">Loading the report form…</div>}
                error={<div className="rounded-lg bg-white p-8 text-center text-sm text-red-600">Unable to display the report form.</div>}
              >
                {Array.from({ length: pageCount }, (_, pageIndex) => (
                  <div
                    key={pageIndex}
                    className="relative mb-4 w-full overflow-hidden bg-white shadow-lg"
                    style={{ aspectRatio: `${LAYOUT.page.width} / ${LAYOUT.page.height}` }}
                  >
                    <PdfPage
                      pageNumber={pageIndex + 1}
                      width={renderWidth}
                      renderTextLayer={false}
                      renderAnnotationLayer={false}
                      className="absolute inset-0 h-full w-full"
                    />

                    {merged
                      .slice(pageIndex * rowsPerPage, (pageIndex + 1) * rowsPerPage)
                      .map((section, rowIndex) => (
                        <AspectCells
                          key={section.id}
                          section={section}
                          pageIndex={pageIndex}
                          rowIndex={rowIndex}
                          disabled={busy || !canEdit}
                          onChange={(value) => patch(section.id, value)}
                        />
                      ))}

                    {/*
                      The signature slot the template printed at the foot of the
                      last page. It opens a full-size canvas rather than drawing
                      into this strip, which was unusable on a phone.
                    */}
                    {pageIndex === pageCount - 1 && (
                      <div
                        className="absolute z-10"
                        style={{
                          left: pctX(LAYOUT.signature.x),
                          top: pctTop(LAYOUT.signature.top),
                          width: pctX(LAYOUT.signature.width),
                          height: pctH(LAYOUT.signature.height),
                        }}
                      >
                        <SignaturePadModal
                          value={report.preparedBySignature ?? ''}
                          onChange={(value) => setReport({ ...report, preparedBySignature: value })}
                          disabled={!canEdit}
                          label="Prepared by signature"
                          hint="Tap to sign"
                        />
                      </div>
                    )}
                  </div>
                ))}
              </PdfDocument>
            )}
          </div>
        </div>

        {report && !canEdit && (
          <p className="flex items-center gap-2 border-t border-gray-100 bg-gray-50 px-4 py-2 text-[11px] text-gray-500">
            <Lock className="h-3 w-3" />
            {report.status === 'Finalized' ? 'Finalized — this report is read only.' : 'Read only.'}
          </p>
        )}

        {report && canEdit && report.canFinalize === false && (
          <p className="border-t border-amber-100 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
            {remainingAspects} aspect{remainingAspects === 1 ? ' is' : 's are'} still empty. Write every aspect
            before finalizing.
          </p>
        )}

        {/* One save for the one form, one signature, one finalize. */}
        <DialogFooter className="flex-row flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-4 py-3 sm:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[11px] text-gray-500">
              <PenLine className="h-3 w-3" />
              Prepared by:{' '}
              <span className="font-semibold text-[#2F3E46]">{report?.preparedByName || accountName || '—'}</span>
            </p>
            <p className="mt-0.5 text-[10px] text-gray-400">
              Your account&rsquo;s name, from Account Management. It is printed on the form.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-gray-500">
              {dirty ? 'Unsaved changes.' : 'Everything saved.'}
            </span>
            {dirty && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={discardDrafts}>Discard</Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              disabled={busy || !canEdit}
              onClick={() => send('/signatures', {
                preparedBy: {
                  name: report?.preparedByName || accountName,
                  signature: report?.preparedBySignature,
                },
              }, 'Signature saved.')}
            >
              <UserCheck className="h-3.5 w-3.5" /> Save signature
            </Button>
            <Button
              size="sm"
              className="gap-2 bg-[#2F3E46] text-white"
              disabled={busy || !dirty || !canEdit}
              onClick={saveForm}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Save form
            </Button>
            <Button
              size="sm"
              className="gap-2 bg-[#FFD100] text-[#2F3E46] hover:bg-[#e6bd00]"
              disabled={busy || !report?.canFinalize}
              onClick={() => send('/finalize', {}, 'Report finalized and published to Documents.')}
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> Finalize &amp; publish PDF
            </Button>
          </div>
        </DialogFooter>

        {/*
          Rendered inside the editor's own Dialog so the report stays open behind
          it: a reviewer can read an Anecdotal Report and go straight back to
          writing without the QPR being unmounted and reloaded.
        */}
        {anecdotalOpen && report?.residentId && (
          <AnecdotalReferenceDialog
            residentId={report.residentId}
            residentName={child?.name}
            onClose={() => setAnecdotalOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Reports tab card: pick a resident and a period, and open the report.
 *
 * Opening a period that already has a report returns it untouched rather than
 * overwriting it, so an aspect somebody has already written is never lost to a
 * second click on "Open report".
 *
 * The editor is rendered by the parent rather than here, so that this card can
 * sit inside the Reports tab's two-column grid without dragging a full-width
 * panel into a grid cell.
 */
export function QuarterlyProgressReportsCard({ onOpenReport }: { onOpenReport: (id: string) => void }) {
  const { children } = useData();
  const [open, setOpen] = useState(false);
  const [residentId, setResidentId] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [periods, setPeriods] = useState<QprPeriod[]>([]);
  const [periodStart, setPeriodStart] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listReload, setListReload] = useState(0);
  const [existing, setExisting] = useState<QprReport[]>([]);
  // Shipped by the server with the list. Defaults to true so an older response
  // does not silently remove the control from a reviewer.
  const [canOpenReport, setCanOpenReport] = useState(true);

  const activeChildren = children.filter((c) => c.status === 'Active' || !c.status);

  useEffect(() => {
    request<{ data: QprPeriod[] }>(`/quarterly-progress-reports/periods?year=${encodeURIComponent(year)}`)
      .then((result) => {
        setPeriods(result.data || []);
        setPeriodStart((prev) => (result.data || []).some((p) => p.periodStart === prev) ? prev : (result.data?.[0]?.periodStart || ''));
      })
      .catch(() => setPeriods([]));
  }, [year]);

  useEffect(() => {
    request<{ data: QprReport[]; canOpenReport?: boolean }>('/quarterly-progress-reports')
      .then((result) => {
        setExisting(result.data || []);
        setCanOpenReport(result.canOpenReport !== false);
      })
      .catch(() => setExisting([]));
  }, [listReload]);

  const canOpen = Boolean(residentId && periodStart);

  const handleOpen = async () => {
    const period = periods.find((p) => p.periodStart === periodStart);
    if (!residentId || !period) return;
    setBusy(true);
    setError(null);
    try {
      const result = await request<{ data: QprReport }>('/quarterly-progress-reports', {
        method: 'POST',
        body: JSON.stringify({ residentId, periodStart: period.periodStart, periodEnd: period.periodEnd }),
      });
      onOpenReport(result.data.id);
      setOpen(false);
      setListReload((t) => t + 1);
    } catch (err: any) {
      setError(err?.message || 'Unable to open the report.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="shadow-sm border-none">
      <CardHeader className="border-b border-gray-100">
        <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
          <FileText className="h-5 w-5 text-[#FFD100]" /> Quarterly Progress Reports
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        <p className="mb-4 text-sm text-gray-500">
          {canOpenReport
            ? 'Pick a resident and a period, then open the report. The six Developmental Aspects appear as a form you fill in directly.'
            : 'A Social Worker or Center Head opens each period. Only they can create and manage a Quarterly Progress Report.'}
        </p>

        {error && <p className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

        {/*
          Opening a report is Social-Worker-only (the server enforces it). The
          button is driven by the capability the list endpoint ships rather than
          by the caller's role, so the two cannot disagree.
        */}
        {canOpenReport && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="w-full gap-2 bg-[#2F3E46] text-white hover:bg-[#263440]">
              <FileText className="h-4 w-4" /> Open a Progress Report
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md rounded-2xl bg-white">
            <DialogHeader>
              <DialogTitle className="font-bold text-[#2F3E46]">Resident and period</DialogTitle>
              <DialogDescription>
                Reports are submitted once per calendar quarter and year (Q1–Q4) for each resident.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-gray-500">Resident</Label>
                <Select value={residentId} onValueChange={setResidentId}>
                  <SelectTrigger className="h-10"><SelectValue placeholder="Select a resident" /></SelectTrigger>
                  <SelectContent>
                    {activeChildren.map((child) => (
                      <SelectItem key={child.id} value={child.id}>{child.name} ({child.id})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs font-semibold text-gray-500">Year</Label>
                  <Input value={year} onChange={(event) => setYear(event.target.value)} inputMode="numeric" className="h-10" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-semibold text-gray-500">Period</Label>
                  <Select value={periodStart} onValueChange={setPeriodStart}>
                    <SelectTrigger className="h-10"><SelectValue placeholder="Select" /></SelectTrigger>
                    <SelectContent>
                      {periods.map((period) => (
                        <SelectItem key={period.periodStart} value={period.periodStart}>{period.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleOpen} disabled={!canOpen || busy} className="gap-2 bg-[#2F3E46] text-white">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                {busy ? 'Opening…' : 'Open report'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        )}

        {existing.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Recent reports</p>
            <div className="max-h-52 space-y-1.5 overflow-y-auto">
              {existing.slice(0, 12).map((row) => {
                const child = children.find((c) => c.id === row.residentId);
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => onOpenReport(row.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-100 px-3 py-2 text-left hover:bg-gray-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-semibold text-[#2F3E46]">{child?.name || row.residentId}</span>
                      <span className="block text-[10px] text-gray-400">{row.periodLabel}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-[10px] text-gray-400">{row.sectionsComplete ?? 0}/{row.sectionsTotal ?? 0}</span>
                      <StatusBadge status={row.status} />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
