/**
 * The Center Head's command centre.
 *
 * Every number and every row on this page comes from `GET /dashboard/center-head`
 * — one request, answered from the live tables. Nothing is derived from the
 * browser's cached store, because the point of the page is that a record filed by
 * any other member of staff is visible here without a re-login, and a count that
 * is assembled client-side is a count that can lag the database.
 *
 * The counts on a tile and the rows in the list behind it are built from the same
 * SQL predicate on the server, so a tile can never open a screen that disagrees
 * with it. Where a definition already exists in a module, the server reuses that
 * module's definition rather than inventing a second one — "active resident" is
 * the Child Records Active filter, "Reviewed" is the Violations list's status
 * filter, and a resident's behavioural status is the rating their own Behavioral
 * tab prints.
 *
 * Everything is clickable and lands on the record or the filtered module view —
 * see `scheduleRoute()` and the `to` on each row. Where a module has no
 * per-record route (Court Records, Education), the link opens the module with the
 * relevant tab selected rather than pretending a detail page exists.
 *
 * Layout, top to bottom:
 *   1. Command bar      — who this is, when it was read, manual refresh
 *   2. Action Center    — the summary strip, then what is waiting and on what
 *   3. Facility status  — one band, not six competing cards
 *   4. Timeline         — Today | Upcoming | Overdue, the same feed split three ways
 *   5. Residents        — rehabilitation phase, behavioural status, case type
 *   6. Violations and recent admissions
 *   7. TRI statistics, reused from the TRI module
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users, UserPlus, UserMinus, Calendar, CalendarClock, AlertTriangle,
  FileText, ClipboardCheck, ClipboardList, Clock, Gavel, GraduationCap,
  ShieldAlert, RefreshCw, Inbox, Scale, ChevronRight,
  BookOpen, Stethoscope, ListChecks, Hourglass, CheckCircle2,
} from 'lucide-react';
import { useAuth } from '../state/AuthContext';
import { request } from '@/services/api';
import { TriStatistics } from './TriStatistics';

// ── PAYLOAD ─────────────────────────────────────────────────────────────────

type ScheduleKind = 'activity' | 'assessment' | 'hearing' | 'intervention' | 'schoolVisit' | 'triDeadline';

interface ScheduleItem {
  kind: ScheduleKind;
  id: string;
  title: string;
  date: string;
  time?: string | null;
  location?: string | null;
  status?: string | null;
  days: number;
  residentId?: string | null;
  residentName?: string | null;
  caseNumber?: string | null;
  type?: string | null;
}

interface ScheduleCounts {
  activity: number;
  assessment: number;
  hearing: number;
  intervention: number;
  schoolVisit: number;
  triDeadline: number;
  total: number;
}

interface HearingRow {
  id: string;
  residentId: string;
  residentName: string | null;
  caseNumber?: string | null;
  courtName?: string | null;
  hearingType?: string | null;
  hearingDate: string;
  hearingTime?: string | null;
  daysOverdue?: number;
}

interface DocumentRow {
  id: string;
  residentId: string | null;
  residentName: string | null;
  residentNameLive: string | null;
  title: string;
  type?: string | null;
  documentCategory?: string | null;
  status: string;
  uploaderRole?: string | null;
  submittedAt?: string | null;
  phase?: string | null;
}

interface ReportRow {
  id: string;
  residentId: string;
  residentName: string | null;
  status: string;
  submittedBy?: string | null;
  submittedAt?: string | null;
  // Anecdotal / TRI
  reportYear?: number;
  reportMonth?: number;
  reportingYear?: number;
  reportingMonth?: number;
  submissionDeadline?: string | null;
  /** TRI only — the score and the band it falls in, as the TRI itself recorded them. */
  finalPoints?: number | null;
  rating?: string | null;
  // Quarterly
  periodLabel?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  // Education monthly
  reportMonthKey?: string | null;
}

interface ReportBucket<T = ReportRow> { count: number; items: T[] }

interface AccessRequestRow {
  id: string;
  requesterUsername: string;
  requesterRole?: string | null;
  moduleName?: string | null;
  recordTab?: string | null;
  residentId?: string | null;
  residentName?: string | null;
  reason: string;
  createdAt: string;
}

interface Overview {
  today: string;
  generatedAt: string;
  residents: {
    active: number; discharged: number; absconded: number; total: number;
    byPhase: { phase: string; short: string; count: number }[];
    byCaseType: { label: string; count: number }[];
    /** The Child Detail Behavioral tab's status, counted per active resident. */
    behavioral: { label: string; count: number }[];
  };
  admissions: {
    current: number;
    thisMonth: number;
    recent: { id: string; residentId: string; admissionNumber: number; admissionDate: string; residentName: string | null; admissionName: string }[];
    expectedUpcoming: { residentId: string; residentName: string | null; expectedDate: string; days: number }[];
    expectedOverdue: { residentId: string; residentName: string | null; expectedDate: string; days: number; daysOverdue: number }[];
  };
  discharges: {
    total: number;
    thisMonth: number;
    pendingRecommendations: {
      id: string; residentId: string; triRecordId: string; thresholdType: string;
      recommendationNote: string; reportingYear: number; reportingMonth: number;
      createdAt: string; residentName: string | null;
    }[];
  };
  hearings: { upcoming: number; overdue: number; upcomingRows: HearingRow[]; overdueRows: HearingRow[] };
  violations: {
    /** The Violation List filtered to Reviewed — the module's own filter. */
    active: number;
    list: number;
    reviewed: number;
    overdue: number;
    resolved: number;
    open: number;
    pendingReview: number;
    underInvestigation: number;
    escalated: number;
    rejected: number;
    resolvedThisMonth: number;
    bySeverity: { Minor: number; Major: number; Critical: number };
  };
  documents: { count: number; items: DocumentRow[] };
  reports: {
    anecdotal: ReportBucket; quarterly: ReportBucket; tri: ReportBucket; education: ReportBucket;
    incidentPending: number;
    total: number;
  };
  accessRequests: { count: number; items: AccessRequestRow[] };
  schedules: {
    today: ScheduleCounts & { date: string };
    upcomingCounts: ScheduleCounts;
    overdueCounts: ScheduleCounts;
    upcoming: ScheduleItem[];
    overdue: ScheduleItem[];
  };
}

// ── PRESENTATION PRIMITIVES ─────────────────────────────────────────────────

const INK = '#2F3E46';
const ACCENT = '#FFD100';

type Tone = 'danger' | 'warn' | 'info' | 'ok' | 'muted' | 'review';

/**
 * One place for the status colours, so "Overdue" is the same red everywhere on
 * the page. The four words the brief asks for — Pending, Upcoming, Overdue,
 * Completed — map onto these; anything else falls back to `muted`.
 */
const TONE: Record<Tone, { chip: string; dot: string; text: string }> = {
  danger: { chip: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500', text: 'text-red-600' },
  warn: { chip: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500', text: 'text-amber-600' },
  info: { chip: 'bg-sky-50 text-sky-700 border-sky-200', dot: 'bg-sky-500', text: 'text-sky-600' },
  ok: { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500', text: 'text-emerald-600' },
  review: { chip: 'bg-violet-50 text-violet-700 border-violet-200', dot: 'bg-violet-500', text: 'text-violet-600' },
  muted: { chip: 'bg-gray-50 text-gray-600 border-gray-200', dot: 'bg-gray-400', text: 'text-gray-500' },
};

function Pill({ tone, children, className = '' }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TONE[tone].chip} ${className}`}>
      {children}
    </span>
  );
}

/** Statuses that appear on documents and reports, mapped to a tone once. */
function statusTone(status?: string | null): Tone {
  switch (String(status || '')) {
    case 'Submitted': return 'review';
    case 'Under Review': return 'warn';
    case 'Approved':
    case 'Finalized':
    case 'Resolved':
    case 'Completed':
    case 'Verified': return 'ok';
    case 'Rejected':
    case 'Returned':
    case 'Failed':
    case 'Escalated': return 'danger';
    case 'Pending':
    case 'Pending Review': return 'warn';
    case 'Scheduled':
    case 'Upcoming':
    case 'In Progress': return 'info';
    default: return 'muted';
  }
}

/** "Today" / "Tomorrow" / "In 4 days" / "6 days overdue". */
function relativeLabel(days: number): string {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1) return `In ${days} days`;
  if (days === -1) return '1 day late';
  return `${Math.abs(days)} days late`;
}

function relativeTone(days: number): Tone {
  if (days < 0) return 'danger';
  if (days === 0) return 'warn';
  if (days <= 3) return 'info';
  return 'muted';
}

/**
 * `2026-09-27` → `Sep 27`, and `2027-09-27` → `Sep 27, 2027`.
 *
 * The year is appended only when it is not the current one. A dense list wants
 * the short form, but an expected discharge date a year out printed as "Sep 27"
 * beside "in 365 days" reads as a contradiction rather than a date — the one
 * place on this page where the year is load-bearing.
 */
function shortDay(value?: string | null): string {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const year = Number(match[1]);
  const label = `${months[Number(match[2]) - 1]} ${Number(match[3])}`;
  return year === new Date().getFullYear() ? label : `${label}, ${year}`;
}

/**
 * A real instant — a `submittedAt` or a `createdAt` — as `Sep 27 · 08:15` in the
 * facility's timezone.
 *
 * The API hands these out as ISO instants (`...Z`), so they must go through
 * `toLocaleString` with an explicit zone: slicing the clock out of the string
 * would print the database's UTC time, eight hours behind the wall clock in the
 * Philippines. `DATE` columns are deliberately not sent through here — they
 * arrive as a bare `YYYY-MM-DD` and `shortDay` reads them directly.
 */
function shortDateTime(value?: string | null): string {
  const text = String(value ?? '');
  if (!text) return '—';
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return shortDay(text);
  const day = parsed.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
  const clock = parsed.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} · ${clock}`;
}

/** How long ago, in whole days, from an ISO instant. Null when unreadable. */
function daysAgo(value?: string | null): number | null {
  const parsed = new Date(String(value ?? ''));
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 86400000));
}

/** "waiting 3 days" / "waiting today" — the age of a queued item. */
function waitingLabel(value?: string | null): string | null {
  const days = daysAgo(value);
  if (days === null) return null;
  if (days === 0) return 'since today';
  if (days === 1) return '1 day waiting';
  return `${days} days waiting`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthName(month?: number | null): string {
  const index = Number(month);
  return Number.isFinite(index) && index >= 1 && index <= 12 ? MONTHS[index - 1] : '';
}

/**
 * A section. Fewer, larger surfaces rather than a wall of small boxes: the page
 * has six sections, not sixteen cards.
 */
function Section({
  icon: Icon, title, subtitle, action, children, className = '',
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex flex-col rounded-2xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(47,62,70,0.04)] ${className}`}>
      <header className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: `${ACCENT}26` }}>
            <Icon className="h-4 w-4 text-[#2F3E46]" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold" style={{ color: INK }}>{title}</h3>
            {subtitle && <p className="mt-0.5 text-[11px] leading-tight text-gray-500">{subtitle}</p>}
          </div>
        </div>
        {action}
      </header>
      <div className="flex-1 p-5">{children}</div>
    </section>
  );
}

/** A group heading inside a section — "Today", "Awaiting a decision". */
function GroupHeading({ label, count, tone = 'muted', children }: { label: string; count?: number; tone?: Tone; children?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h4 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-500">
        {tone !== 'muted' && <span className={`h-1.5 w-1.5 rounded-full ${TONE[tone].dot}`} />}
        {label}
      </h4>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        {count !== undefined && (
          <span className={`text-xs font-bold tabular-nums ${count > 0 && tone !== 'muted' ? TONE[tone].text : 'text-gray-400'}`}>{count}</span>
        )}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-center text-xs italic text-gray-400">{children}</p>;
}

/** The all-clear state. Deliberately calm, never a bare zero. */
function Clear({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-lg bg-emerald-50/70 px-3 py-2.5 text-[11px] font-medium text-emerald-700">
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
      {children}
    </p>
  );
}

/** A row that navigates somewhere. Used for every list on the page. */
function Row({
  onClick, children, className = '', tone,
}: {
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  tone?: Tone;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 text-left transition-colors hover:border-[#FFD100] hover:bg-[#FFD100]/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD100] ${className}`}
    >
      {tone && <span className={`h-8 w-1 shrink-0 rounded-full ${TONE[tone].dot}`} />}
      {children}
      <ChevronRight className="h-4 w-4 shrink-0 text-gray-300 transition-colors group-hover:text-[#2F3E46]" />
    </button>
  );
}

/** One metric in the facility band. */
function Metric({
  label, value, sub, icon: Icon, onClick, tone = 'muted', loading = false, hint,
}: {
  label: string;
  value: number | string;
  sub?: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  tone?: Tone;
  loading?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className="group flex min-w-0 flex-1 flex-col items-start px-4 py-3.5 text-left transition-colors first:pl-5 last:pr-5 hover:bg-[#FFD100]/10 focus:outline-none focus-visible:bg-[#FFD100]/15"
    >
      <span className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-gray-400 transition-colors group-hover:text-[#2F3E46]" />
        <span className="truncate text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</span>
      </span>
      {loading ? (
        <span className="mt-2 h-7 w-12 animate-pulse rounded bg-gray-100" />
      ) : (
        <span className="mt-1.5 text-[26px] font-bold leading-none tabular-nums" style={{ color: INK }}>{value}</span>
      )}
      <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-gray-500">
        {tone !== 'muted' && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[tone].dot}`} />}
        <span className="truncate">{sub}</span>
      </span>
    </button>
  );
}

/** A bar in one of the resident breakdowns. */
function Bar({
  label, count, total, fill, onClick, title,
}: {
  label: string;
  count: number;
  total: number;
  fill: string;
  onClick: () => void;
  title?: string;
}) {
  const percent = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title || label}
      className="flex w-full items-center gap-3 rounded-lg px-1 py-1 text-left transition-colors hover:bg-gray-50"
    >
      <span className="w-[92px] shrink-0 truncate text-xs font-medium text-gray-600">{label}</span>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
        <span className={`block h-full rounded-full transition-all ${fill}`} style={{ width: `${percent}%` }} />
      </span>
      <span className="w-5 shrink-0 text-right text-xs font-bold tabular-nums" style={{ color: INK }}>{count}</span>
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-gray-400">{percent}%</span>
    </button>
  );
}

/** The icon and colour for each kind of schedule. */
const KIND: Record<ScheduleKind, { icon: React.ComponentType<{ className?: string }>; bg: string; fg: string; label: string }> = {
  activity: { icon: Calendar, bg: 'bg-sky-50', fg: 'text-sky-600', label: 'Activity' },
  assessment: { icon: ClipboardCheck, bg: 'bg-violet-50', fg: 'text-violet-600', label: 'Assessment' },
  hearing: { icon: Gavel, bg: 'bg-amber-50', fg: 'text-amber-600', label: 'Court hearing' },
  intervention: { icon: ShieldAlert, bg: 'bg-rose-50', fg: 'text-rose-600', label: 'Intervention' },
  schoolVisit: { icon: GraduationCap, bg: 'bg-emerald-50', fg: 'text-emerald-600', label: 'School visit' },
  triDeadline: { icon: ClipboardList, bg: 'bg-indigo-50', fg: 'text-indigo-600', label: 'TRI deadline' },
};

/** The kinds the timeline's per-kind summary strip prints, in reading order. */
const SUMMARY_KINDS: ScheduleKind[] = ['activity', 'assessment', 'hearing', 'intervention', 'schoolVisit', 'triDeadline'];

/** The colours the behavioral bands print, matching the Child Detail tab. */
const BEHAVIORAL_FILL: Record<string, string> = {
  'Very Good': 'bg-emerald-500',
  Good: 'bg-sky-500',
  Fair: 'bg-amber-500',
  'Needs Improvement': 'bg-red-500',
  'Not Rated': 'bg-gray-400',
  'Still Monitoring': 'bg-blue-400',
};

/** What the resident breakdowns count — one population, three cuts. */
const RESIDENTS_ACTIVE = '/children?filter=Active';

// ── THE PAGE ────────────────────────────────────────────────────────────────

export function CenterHeadDashboard({ displayRole }: { displayRole?: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(0);

  const load = useCallback(async (background = false) => {
    const id = (inFlight.current += 1);
    if (background) setRefreshing(true);
    try {
      const result = await request<{ success: boolean; data?: Overview }>('/dashboard/center-head');
      if (id !== inFlight.current) return;
      if (result?.success && result.data) {
        setData(result.data);
        setError(null);
      } else {
        setError('The dashboard returned no data.');
      }
    } catch (err) {
      if (id !== inFlight.current) return;
      setError(err instanceof Error ? err.message : 'Unable to read the dashboard.');
    } finally {
      if (id === inFlight.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  // Read on open, whenever the window regains focus (a record filed in another
  // tab should be reflected on return), and once a minute. The interval is a
  // minute rather than the schedule dialog's five seconds because this is an
  // aggregate over the whole database, not one day's list.
  useEffect(() => {
    if (!user) return;
    load();
    const onFocus = () => { load(true); };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(onFocus, 60000);
    return () => { window.removeEventListener('focus', onFocus); window.clearInterval(timer); };
  }, [user, load]);

  const open = useCallback((path: string) => navigate(path), [navigate]);

  // ── Navigation ───────────────────────────────────────────────────────────
  // Every click on this page ends up in one of these functions, so the mapping
  // from "what the Center Head is looking at" to "where it lives" is in one
  // place and cannot drift row by row.

  /** A schedule row → its own record where one exists, else the module. */
  const scheduleRoute = useCallback((item: ScheduleItem) => {
    switch (item.kind) {
      case 'activity': return `/activities/${item.id}`;
      case 'assessment': return `/assessments/${item.id}`;
      case 'hearing': return '/court-records?filter=Scheduled';
      case 'intervention': return '/violations?tab=interventions';
      case 'schoolVisit': return '/education';
      case 'triDeadline': return `/tri?recordId=${encodeURIComponent(item.id)}`;
      default: return '/dashboard';
    }
  }, []);

  // ── Derived view models ──────────────────────────────────────────────────

  /**
   * Everything waiting on a decision, from all four queues plus the document
   * inbox, as one list. A Center Head does not care which module filed the
   * paperwork — only that it is theirs to decide — so the sources are merged and
   * ordered by how long each has been waiting, oldest first.
   */
  const decisionQueue = useMemo(() => {
    if (!data) return [];
    type Item = {
      key: string; source: string; icon: React.ComponentType<{ className?: string }>;
      bg: string; fg: string; title: string; meta: string; status: string;
      submittedAt: string | null; to: string;
    };
    const items: Item[] = [];

    for (const doc of data.documents.items) {
      items.push({
        key: `doc-${doc.id}`, source: 'Document', icon: FileText, bg: 'bg-gray-100', fg: 'text-gray-600',
        title: doc.title,
        meta: [doc.residentNameLive || doc.residentName || 'No resident', doc.documentCategory].filter(Boolean).join(' · '),
        status: doc.status,
        submittedAt: doc.submittedAt || null,
        to: `/documents?tab=pending&docId=${encodeURIComponent(doc.id)}`,
      });
    }
    for (const row of data.reports.anecdotal.items) {
      items.push({
        key: `an-${row.id}`, source: 'Anecdotal', icon: BookOpen, bg: 'bg-violet-50', fg: 'text-violet-600',
        title: `${row.residentName || row.residentId}`,
        meta: [`${monthName(row.reportMonth)} ${row.reportYear}`, row.submittedBy].filter(Boolean).join(' · '),
        status: row.status, submittedAt: row.submittedAt || null,
        to: `/reports?tab=review&anecdotalId=${encodeURIComponent(row.id)}`,
      });
    }
    for (const row of data.reports.quarterly.items) {
      items.push({
        key: `qr-${row.id}`, source: 'Quarterly', icon: ListChecks, bg: 'bg-sky-50', fg: 'text-sky-600',
        title: `${row.residentName || row.residentId}`,
        meta: [`Quarterly Progress · ${row.periodLabel || `${shortDay(row.periodStart)} – ${shortDay(row.periodEnd)}`}`, row.submittedBy].filter(Boolean).join(' · '),
        status: row.status, submittedAt: row.submittedAt || null,
        to: `/reports?quarterlyReportId=${encodeURIComponent(row.id)}`,
      });
    }
    for (const row of data.reports.tri.items) {
      items.push({
        key: `tri-${row.id}`, source: 'TRI', icon: ClipboardList, bg: 'bg-amber-50', fg: 'text-amber-600',
        title: `${row.residentName || row.residentId}`,
        // No leading "TRI ·" here: the row already prints its `source`, so
        // repeating it produced "TRI · TRI · Sep 2026".
        meta: [
          `${monthName(row.reportingMonth)} ${row.reportingYear}`,
          row.finalPoints != null ? `${row.finalPoints} pts` : null,
          row.rating,
        ].filter(Boolean).join(' · '),
        status: row.status, submittedAt: row.submittedAt || null,
        to: `/tri?recordId=${encodeURIComponent(row.id)}`,
      });
    }
    for (const row of data.reports.education.items) {
      items.push({
        key: `ed-${row.id}`, source: 'Education', icon: GraduationCap, bg: 'bg-emerald-50', fg: 'text-emerald-600',
        title: `${row.residentName || row.residentId}`,
        meta: `Education monthly · ${row.reportMonthKey || '—'}`,
        status: row.status, submittedAt: row.submittedAt || null,
        to: '/education',
      });
    }

    // Oldest first: the item that has been waiting longest is the one to clear.
    // An item with no timestamp sorts last rather than jumping the queue.
    items.sort((a, b) => String(a.submittedAt || '9999').localeCompare(String(b.submittedAt || '9999')));
    return items;
  }, [data]);

  /**
   * The four summary numbers on the Action Center strip. Only the non-zero ones
   * are rendered: a page that always shows five zeroes trains the reader to
   * ignore all five.
   */
  const attention = useMemo(() => {
    if (!data) return [];
    // A hearing that has passed with no outcome is overdue *and* is already
    // inside the schedule feed's overdue total, so the two chips would count the
    // same hearing twice. The schedule chip therefore carries only the
    // non-hearing kinds, and the two still add up to the feed's own total.
    const overdueNonHearing = Math.max(
      0,
      data.schedules.overdueCounts.total - data.schedules.overdueCounts.hearing,
    );
    return ([
      { key: 'docs', label: 'Documents to review', count: data.documents.count, tone: 'review' as Tone, icon: FileText, to: '/documents?tab=pending' },
      { key: 'reports', label: 'Reports to review', count: data.reports.total, tone: 'review' as Tone, icon: ClipboardList, to: '/reports?tab=review' },
      { key: 'access', label: 'Access requests', count: data.accessRequests.count, tone: 'warn' as Tone, icon: Inbox, to: '/documents?tab=access' },
      { key: 'discharge', label: 'Discharge recommendations', count: data.discharges.pendingRecommendations.length, tone: 'warn' as Tone, icon: UserMinus, to: RESIDENTS_ACTIVE },
      { key: 'expected', label: 'Discharge dates passed', count: data.admissions.expectedOverdue.length, tone: 'danger' as Tone, icon: Hourglass, to: RESIDENTS_ACTIVE },
      { key: 'hearings', label: 'Hearings with no outcome', count: data.hearings.overdue, tone: 'danger' as Tone, icon: Gavel, to: '/court-records?filter=Scheduled' },
      { key: 'late', label: 'Other schedules past their date', count: overdueNonHearing, tone: 'danger' as Tone, icon: CalendarClock, to: '/activities' },
    ]).filter((chip) => chip.count > 0);
  }, [data]);

  /** Everything still waiting on a decision, across all five queues. */
  const decisionTotal = data
    ? data.documents.count + data.reports.total + data.accessRequests.count
    : 0;

  /**
   * Is the "Past due" column genuinely empty?
   *
   * Three stacked grey "nothing here" boxes is a lot of furniture to say one
   * thing, and it made the column read as broken rather than clear. When there
   * is nothing late, one calm line says it.
   */
  const pastDueEmpty = !data
    || (data.admissions.expectedOverdue.length === 0
      && data.discharges.pendingRecommendations.length === 0
      && data.admissions.expectedUpcoming.length === 0);

  const phaseTotal = data?.residents.byPhase.reduce((sum, row) => sum + row.count, 0) || 0;
  const caseTypeTotal = data?.residents.byCaseType.reduce((sum, row) => sum + row.count, 0) || 0;
  const behavioralTotal = data?.residents.behavioral.reduce((sum, row) => sum + row.count, 0) || 0;

  const today = data?.today || '';
  const generatedAt = data?.generatedAt
    ? new Date(data.generatedAt).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' })
    : null;

  const todayItems = data ? data.schedules.upcoming.filter((item) => item.days === 0) : [];
  const upcomingItems = data ? data.schedules.upcoming.filter((item) => item.days > 0) : [];
  const overdueItems = data ? data.schedules.overdue : [];
  // `upcomingCounts` covers today *and* everything after it; the "Upcoming"
  // group is only the part after today, so today's items are subtracted rather
  // than shown twice.
  const aheadCount = data ? Math.max(0, data.schedules.upcomingCounts.total - data.schedules.today.total) : 0;

  /**
   * "1 assessment · 1 intervention" — built from whichever kinds are actually on
   * today. Naming only activities and assessments understated the tile: a day of
   * two intervention sessions read as "0 activities · 0 assessments".
   */
  const todaySummary = data
    ? SUMMARY_KINDS
      .filter((kind) => data.schedules.today[kind] > 0)
      .map((kind) => {
        const count = data.schedules.today[kind];
        return `${count} ${KIND[kind].label.toLowerCase()}${count === 1 ? '' : 's'}`;
      })
      .join(' · ')
    : '';

  /** One schedule row, shared by the three timeline groups. */
  const scheduleRow = (item: ScheduleItem) => {
    const meta = KIND[item.kind] || KIND.activity;
    const Icon = meta.icon;
    const late = item.days < 0;
    return (
      <li key={`${item.kind}-${item.id}`}>
        <Row onClick={() => open(scheduleRoute(item))} tone={late ? 'danger' : undefined}>
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${meta.bg}`}>
            <Icon className={`h-4 w-4 ${meta.fg}`} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold" style={{ color: INK }}>{item.title}</span>
            <span className="block truncate text-[10px] text-gray-400">
              {[shortDay(item.date), item.time || null, item.residentName, item.location, meta.label].filter(Boolean).join(' · ')}
            </span>
          </span>
          <Pill tone={relativeTone(item.days)}>{relativeLabel(item.days)}</Pill>
        </Row>
      </li>
    );
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">

      {/* 1 ── Command bar */}
      <header className="relative overflow-hidden rounded-2xl bg-[#2F3E46] px-6 py-5 shadow-md">
        <div className="absolute inset-y-0 left-0 w-1.5 bg-[#FFD100]" />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">Command Centre</h1>
              <span className="flex items-center gap-1.5 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#FFD100]">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FFD100] opacity-70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#FFD100]" />
                </span>
                Live
              </span>
            </div>
            <p className="mt-1.5 text-sm text-gray-300">
              Welcome back, <span className="font-bold uppercase text-[#FFD100]">{displayRole || 'CENTER HEAD'}</span>
              <span className="ml-2 text-xs text-gray-400">
                {today ? `· ${shortDay(today)}` : ''}
                {generatedAt ? ` · read at ${generatedAt}` : ''}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {data && (
              <div className="hidden rounded-xl bg-white/5 px-3.5 py-2 text-right sm:block">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">In the facility</p>
                <p className="text-lg font-bold leading-none text-white tabular-nums">{data.residents.active}</p>
              </div>
            )}
            <button
              type="button"
              onClick={() => load(true)}
              disabled={refreshing}
              className="flex items-center gap-2 rounded-xl border border-white/20 px-3.5 py-2 text-xs font-bold text-white transition-colors hover:bg-white/10 disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <div>
            <p className="text-sm font-bold text-red-700">The dashboard could not be read</p>
            <p className="mt-0.5 text-xs text-red-600">{error}</p>
          </div>
        </div>
      )}

      {/* 2 ── ACTION CENTER. The summary strip is a single line of numbers, not
          six bordered boxes — the detail lives in the two columns below it. */}
      <Section
        icon={AlertTriangle}
        title="Action Center"
        subtitle="Everything that is waiting on the Center Head, and how long it has been waiting."
      >
        {/* The summary strip. Only non-zero counts appear. */}
        {loading && !data ? (
          <div className="mb-5 h-10 animate-pulse rounded-xl bg-gray-100" />
        ) : attention.length === 0 ? (
          <div className="mb-5">
            <Clear>Nothing is waiting on you. No document, report, request or deadline is outstanding.</Clear>
          </div>
        ) : (
          <div className="mb-5 flex flex-wrap items-stretch gap-x-6 gap-y-3 rounded-xl border border-gray-100 bg-gray-50/60 px-4 py-3">
            {attention.map((chip) => {
              const Icon = chip.icon;
              return (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => open(chip.to)}
                  className="group flex min-w-0 items-center gap-2 text-left"
                >
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${TONE[chip.tone].text}`} />
                  <span className="min-w-0 truncate text-[11px] font-semibold text-gray-600 group-hover:text-[#2F3E46]">{chip.label}</span>
                  <span className={`text-base font-bold leading-none tabular-nums ${TONE[chip.tone].text}`}>{chip.count}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* What is waiting on a decision */}
          <div className="min-w-0">
            <GroupHeading label="Awaiting a decision" count={decisionTotal} tone="review">
              {data && data.reports.total > 0 && (
                <span className="hidden items-center gap-1.5 sm:flex">
                  {([
                    ['Anecdotal', data.reports.anecdotal.count],
                    ['Quarterly', data.reports.quarterly.count],
                    ['TRI', data.reports.tri.count],
                    ['Education', data.reports.education.count],
                  ] as [string, number][]).map(([label, count]) => (
                    <span
                      key={label}
                      title={`${count} ${label} report${count === 1 ? '' : 's'} awaiting review`}
                      className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${count > 0 ? TONE.review.chip : 'border-gray-200 bg-gray-50 text-gray-300'}`}
                    >
                      {label.slice(0, 3)} {count}
                    </span>
                  ))}
                </span>
              )}
            </GroupHeading>

            {loading && !data ? (
              <div className="space-y-2">{[0, 1, 2, 3].map((n) => <div key={n} className="h-11 animate-pulse rounded-xl bg-gray-100" />)}</div>
            ) : decisionQueue.length === 0 && (data?.accessRequests.count || 0) === 0 ? (
              <Clear>Every submitted document and report has been decided.</Clear>
            ) : (
              <ul className="-mx-1 space-y-0.5">
                {decisionQueue.slice(0, 8).map((item) => {
                  const Icon = item.icon;
                  const waiting = waitingLabel(item.submittedAt);
                  return (
                    <li key={item.key}>
                      <Row onClick={() => open(item.to)}>
                        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${item.bg}`}>
                          <Icon className={`h-4 w-4 ${item.fg}`} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold" style={{ color: INK }}>{item.title}</span>
                          <span className="block truncate text-[10px] text-gray-400">
                            {[item.source, item.meta, waiting].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <Pill tone={statusTone(item.status)}>{item.status}</Pill>
                      </Row>
                    </li>
                  );
                })}
                {decisionQueue.length > 8 && (
                  <li className="px-2.5 pt-1.5 text-[11px] text-gray-400">
                    {decisionQueue.length - 8} more in the review queues.
                  </li>
                )}
              </ul>
            )}

            {/* Access requests — a decision only the Center Head makes. */}
            {(data?.accessRequests.count || 0) > 0 && (
              <div className="mt-4 border-t border-dashed border-gray-100 pt-3.5">
                <GroupHeading label="Access requests" count={data?.accessRequests.count} tone="warn" />
                <ul className="-mx-1 space-y-0.5">
                  {data!.accessRequests.items.slice(0, 4).map((row) => (
                    <li key={row.id}>
                      <Row onClick={() => open('/documents?tab=access')}>
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-50">
                          <Inbox className="h-4 w-4 text-amber-600" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold" style={{ color: INK }}>
                            {row.requesterUsername} · {row.moduleName || 'module'}
                          </span>
                          <span className="block truncate text-[10px] text-gray-400">
                            {[row.residentName || row.residentId, row.reason, waitingLabel(row.createdAt)].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <Pill tone="warn">Pending</Pill>
                      </Row>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Incident reports — not the Center Head's queue, but visible. */}
            {(data?.reports.incidentPending || 0) > 0 && (
              <p className="mt-4 rounded-xl bg-gray-50 px-3 py-2 text-[11px] leading-relaxed text-gray-500">
                <span className="font-bold" style={{ color: INK }}>{data!.reports.incidentPending}</span> incident report
                {data!.reports.incidentPending === 1 ? '' : 's'} still awaiting Psychological / Social Worker verification
                — not your queue, counted so the workload is visible.
              </p>
            )}
          </div>

          {/* What is late, and the decisions attached to it */}
          <div className="min-w-0 lg:border-l lg:border-gray-100 lg:pl-6">
            <GroupHeading
              label="Past due"
              tone="danger"
              count={(data?.admissions.expectedOverdue.length || 0) + (data?.discharges.pendingRecommendations.length || 0)}
            />

            {pastDueEmpty ? (
              <Clear>Nothing is past due, and no discharge decision is waiting.</Clear>
            ) : (
            <div className="space-y-4">
              {/* Expected discharge dates that have passed */}
              <div>
                <h5 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  <Hourglass className="h-3 w-3" /> Expected discharge dates passed
                </h5>
                {(data?.admissions.expectedOverdue.length || 0) > 0 ? (
                  <ul className="-mx-1 space-y-0.5">
                    {data!.admissions.expectedOverdue.slice(0, 4).map((row) => (
                      <li key={`eo-${row.residentId}`}>
                        <Row onClick={() => open(`/children/${row.residentId}?tab=personal`)} tone="danger">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold" style={{ color: INK }}>{row.residentName || row.residentId}</span>
                            <span className="block text-[10px] text-gray-400">Expected {shortDay(row.expectedDate)}</span>
                          </span>
                          <Pill tone="danger">{row.daysOverdue}d late</Pill>
                        </Row>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-lg bg-gray-50 px-2.5 py-2 text-[11px] text-gray-400">No expected discharge date has passed.</p>
                )}
              </div>

              {/* Discharge recommendations — a decision only the Center Head makes */}
              <div>
                <h5 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  <UserMinus className="h-3 w-3" /> Discharge recommendations
                </h5>
                {(data?.discharges.pendingRecommendations.length || 0) > 0 ? (
                  <ul className="-mx-1 space-y-0.5">
                    {data!.discharges.pendingRecommendations.slice(0, 4).map((rec) => (
                      <li key={rec.id}>
                        <Row onClick={() => open(`/children/${rec.residentId}?tab=personal`)} tone="warn">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold" style={{ color: INK }}>{rec.residentName || rec.residentId}</span>
                            <span className="block truncate text-[10px] text-gray-400">
                              {rec.thresholdType} · {monthName(rec.reportingMonth)} {rec.reportingYear}
                            </span>
                          </span>
                          <Pill tone="warn">Pending</Pill>
                        </Row>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-lg bg-gray-50 px-2.5 py-2 text-[11px] text-gray-400">No recommendation is waiting.</p>
                )}
              </div>

              {/* Upcoming expected discharge dates — the other half of the same list */}
              <div>
                <h5 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  <CalendarClock className="h-3 w-3" /> Expected discharge dates ahead
                </h5>
                {(data?.admissions.expectedUpcoming.length || 0) > 0 ? (
                  <ul className="-mx-1 space-y-0.5">
                    {data!.admissions.expectedUpcoming.slice(0, 3).map((row) => (
                      <li key={`eu-${row.residentId}`}>
                        <Row onClick={() => open(`/children/${row.residentId}?tab=personal`)}>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold" style={{ color: INK }}>{row.residentName || row.residentId}</span>
                            <span className="block text-[10px] text-gray-400">Expected {shortDay(row.expectedDate)}</span>
                          </span>
                          <Pill tone={relativeTone(row.days)}>{relativeLabel(row.days)}</Pill>
                        </Row>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-lg bg-gray-50 px-2.5 py-2 text-[11px] text-gray-400">No expected discharge date is set.</p>
                )}
              </div>
            </div>
            )}
          </div>
        </div>
      </Section>

      {/* 3 ── Facility status. One band with hairline dividers instead of six
          separate cards, so the numbers read as one picture of the home. */}
      <div className="overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(47,62,70,0.04)]">
        <div className="flex flex-wrap divide-y divide-gray-100 sm:divide-y-0 lg:divide-x">
          <Metric
            label="Active Residents" icon={Users} loading={loading}
            value={data?.residents.active ?? 0}
            sub={`of ${data?.residents.total ?? 0} on record${data?.residents.absconded ? ` · ${data.residents.absconded} absconded` : ''}`}
            onClick={() => open(RESIDENTS_ACTIVE)}
            hint="Residents the Child Records module counts under its Active filter."
          />
          <Metric
            label="Current Admissions" icon={UserPlus} loading={loading}
            value={data?.admissions.current ?? 0}
            sub={`${data?.admissions.thisMonth ?? 0} opened this month`}
            onClick={() => open(RESIDENTS_ACTIVE)}
            hint="Open admission periods — one per resident currently in the facility."
          />
          <Metric
            label="Discharged" icon={UserMinus} loading={loading}
            value={data?.residents.discharged ?? 0}
            sub={`${data?.discharges.thisMonth ?? 0} closed this month`}
            onClick={() => open('/children?filter=Discharged')}
            hint="Residents the Child Records module counts under its Discharged filter."
          />
          <Metric
            label="Active Violations" icon={Scale} loading={loading}
            value={data?.violations.active ?? 0}
            sub={`${data?.violations.pendingReview ?? 0} still to review · ${data?.violations.list ?? 0} in the list`}
            tone={data?.violations.overdue ? 'danger' : 'muted'}
            onClick={() => open('/violations')}
            hint="Violations in the Violation List whose status is Reviewed — the module's own filter."
          />
          <Metric
            label="Pending Cases" icon={Gavel} loading={loading}
            value={data?.hearings.upcoming ?? 0}
            sub={data?.hearings.overdue ? `${data.hearings.overdue} with no outcome` : 'hearings on the calendar'}
            tone={data?.hearings.overdue ? 'danger' : 'muted'}
            onClick={() => open('/court-records?filter=Scheduled')}
            hint="Court hearings still marked Scheduled."
          />
          <Metric
            label="Scheduled Today" icon={Calendar} loading={loading}
            value={data?.schedules.today.total ?? 0}
            sub={todaySummary || 'nothing on the calendar today'}
            onClick={() => open('/activities')}
            hint="Everything dated today across activities, assessments, hearings, interventions, school visits and TRI deadlines."
          />
        </div>
      </div>

      {/* 4 ── TIMELINE. One feed, split three ways: what is on today, what is
          coming, and what has been missed. */}
      <Section
        icon={CalendarClock}
        title="Schedule Timeline"
        subtitle="Every dated commitment across the facility, read live — today, what is ahead, and what has been missed."
        action={
          data && (
            <div className="hidden shrink-0 items-center gap-1.5 md:flex">
              {SUMMARY_KINDS.map((kind) => {
                const Icon = KIND[kind].icon;
                const count = data.schedules.upcomingCounts[kind];
                return (
                  <span
                    key={kind}
                    title={`${count} upcoming ${KIND[kind].label.toLowerCase()}${count === 1 ? '' : 's'}`}
                    className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${count > 0 ? `border-gray-200 ${KIND[kind].fg}` : 'border-gray-100 text-gray-300'}`}
                  >
                    <Icon className="h-3 w-3" />
                    {count}
                  </span>
                );
              })}
            </div>
          )
        }
      >
        {loading && !data ? (
          <div className="grid gap-5 lg:grid-cols-3">
            {[0, 1, 2].map((n) => (
              <div key={n} className="space-y-2">
                <div className="h-4 w-24 animate-pulse rounded bg-gray-100" />
                {[0, 1, 2].map((m) => <div key={m} className="h-11 animate-pulse rounded-xl bg-gray-100" />)}
              </div>
            ))}
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Today */}
            <div className="min-w-0">
              <GroupHeading label="Today" count={data?.schedules.today.total} tone="warn" />
              {todayItems.length > 0 ? (
                <ul className="-mx-1 space-y-0.5">{todayItems.map(scheduleRow)}</ul>
              ) : (
                <p className="rounded-xl bg-gray-50 px-3 py-3 text-[11px] text-gray-400">Nothing is booked for today.</p>
              )}
            </div>

            {/* Upcoming */}
            <div className="min-w-0 lg:border-l lg:border-gray-100 lg:pl-6">
              <GroupHeading label="Upcoming" count={aheadCount} tone="info" />
              {upcomingItems.length > 0 ? (
                <ul className="-mx-1 space-y-0.5">{upcomingItems.slice(0, 10).map(scheduleRow)}</ul>
              ) : (
                <p className="rounded-xl bg-gray-50 px-3 py-3 text-[11px] text-gray-400">Nothing is booked ahead.</p>
              )}
              {aheadCount > Math.min(upcomingItems.length, 10) && (
                <p className="px-2.5 pt-1.5 text-[11px] text-gray-400">
                  showing {Math.min(upcomingItems.length, 10)} of {aheadCount}
                </p>
              )}
            </div>

            {/* Overdue */}
            <div className="min-w-0 lg:border-l lg:border-gray-100 lg:pl-6">
              <GroupHeading label="Overdue" count={data?.schedules.overdueCounts.total} tone="danger" />
              {overdueItems.length > 0 ? (
                <ul className="-mx-1 space-y-0.5">{overdueItems.slice(0, 8).map(scheduleRow)}</ul>
              ) : (
                <Clear>Nothing has been missed.</Clear>
              )}
              {data && data.schedules.overdueCounts.total > overdueItems.length && (
                <p className="px-2.5 pt-1.5 text-[11px] text-gray-400">
                  showing {Math.min(overdueItems.length, 8)} of {data.schedules.overdueCounts.total}
                </p>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* 5 ── RESIDENTS. One section, three cuts of the same population:
          rehabilitation phase, behavioural status, case type. */}
      <Section
        icon={Users}
        title="Residents"
        subtitle={`How the ${data?.residents.active ?? 0} residents currently in the facility are distributed. Every cut counts the same residents.`}
        action={
          <button
            type="button"
            onClick={() => open(RESIDENTS_ACTIVE)}
            className="shrink-0 text-[11px] font-bold underline decoration-[#FFD100] decoration-2 underline-offset-2 hover:decoration-[#2F3E46]"
            style={{ color: INK }}
          >
            Open Child Records
          </button>
        }
      >
        {data && (data.residents.byPhase.length > 0 || data.residents.behavioral.length > 0 || data.residents.byCaseType.length > 0) ? (
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Rehabilitation phase */}
            <div className="min-w-0">
              <GroupHeading label="By rehabilitation phase" count={phaseTotal} />
              {data.residents.byPhase.length > 0 ? (
                <div className="space-y-0.5">
                  {data.residents.byPhase.map((row) => (
                    <Bar
                      key={row.phase}
                      label={row.short}
                      count={row.count}
                      total={phaseTotal}
                      fill="bg-[#2F3E46]"
                      title={`${row.phase} — ${row.count} resident${row.count === 1 ? '' : 's'}`}
                      onClick={() => open(RESIDENTS_ACTIVE)}
                    />
                  ))}
                </div>
              ) : (
                <Empty>No resident has a phase set.</Empty>
              )}
            </div>

            {/* Behavioural status */}
            <div className="min-w-0 lg:border-l lg:border-gray-100 lg:pl-6">
              <GroupHeading label="By behavioral status" count={behavioralTotal} />
              {data.residents.behavioral.length > 0 ? (
                <div className="space-y-0.5">
                  {data.residents.behavioral.map((row) => (
                    <Bar
                      key={row.label}
                      label={row.label}
                      count={row.count}
                      total={behavioralTotal}
                      fill={BEHAVIORAL_FILL[row.label] || 'bg-gray-400'}
                      title={`${row.label} — ${row.count} resident${row.count === 1 ? '' : 's'}`}
                      onClick={() => open(RESIDENTS_ACTIVE)}
                    />
                  ))}
                </div>
              ) : (
                <Empty>No active resident.</Empty>
              )}
              <p className="mt-2.5 text-[10px] leading-relaxed text-gray-400">
                The rating on each resident's newest Finalized TRI, exactly as their Behavioral tab shows it.
              </p>
            </div>

            {/* Case type */}
            <div className="min-w-0 lg:border-l lg:border-gray-100 lg:pl-6">
              <GroupHeading label="By case type" count={caseTypeTotal} />
              {data.residents.byCaseType.length > 0 ? (
                <div className="space-y-0.5">
                  {data.residents.byCaseType.map((row) => (
                    <Bar
                      key={row.label}
                      label={row.label}
                      count={row.count}
                      total={caseTypeTotal}
                      fill="bg-[#FFD100]"
                      onClick={() => open(RESIDENTS_ACTIVE)}
                    />
                  ))}
                </div>
              ) : (
                <Empty>No resident has a case type set.</Empty>
              )}
            </div>
          </div>
        ) : loading ? (
          <Empty>Reading…</Empty>
        ) : (
          <Empty>No active resident is on record.</Empty>
        )}
      </Section>

      {/* 6 ── Violations and admissions */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Section
          icon={Scale}
          title="Violations"
          subtitle="Incidents still on the books, by severity, and where each one stands."
          action={
            <button
              type="button"
              onClick={() => open('/violations')}
              className="shrink-0 text-[11px] font-bold underline decoration-[#FFD100] decoration-2 underline-offset-2 hover:decoration-[#2F3E46]"
              style={{ color: INK }}
            >
              Open Violations
            </button>
          }
        >
          {data ? (
            <div className="space-y-5">
              <div className="grid grid-cols-3 gap-2.5">
                {([
                  { label: 'Minor', count: data.violations.bySeverity.Minor, cls: 'border-yellow-200 bg-yellow-50 text-yellow-700' },
                  { label: 'Major', count: data.violations.bySeverity.Major, cls: 'border-orange-200 bg-orange-50 text-orange-700' },
                  { label: 'Critical', count: data.violations.bySeverity.Critical, cls: 'border-red-200 bg-red-50 text-red-700' },
                ]).map((row) => (
                  <button
                    key={row.label}
                    type="button"
                    onClick={() => open('/violations')}
                    className={`rounded-xl border p-3 text-left transition-transform hover:-translate-y-0.5 ${row.cls}`}
                  >
                    <span className="block text-[10px] font-bold uppercase tracking-wide opacity-80">{row.label}</span>
                    <span className="mt-1 block text-2xl font-bold leading-none tabular-nums">{row.count}</span>
                  </button>
                ))}
              </div>
              <p className="-mt-2 text-[10px] text-gray-400">
                Severity of the {data.violations.open} unresolved incident{data.violations.open === 1 ? '' : 's'} — Resolved and Rejected excluded.
              </p>

              <dl className="space-y-2 text-xs">
                {([
                  ['Reviewed (in the Violation List)', data.violations.reviewed, 'review'],
                  ['Overdue — intervention month passed', data.violations.overdue, 'danger'],
                  ['Resolved', data.violations.resolved, 'ok'],
                  ['Pending review — not yet in the list', data.violations.pendingReview, 'warn'],
                  ['Rejected', data.violations.rejected, 'muted'],
                  ['Resolved this month', data.violations.resolvedThisMonth, 'ok'],
                ] as [string, number, Tone][]).map(([label, count, tone]) => (
                  <div key={label} className="flex items-center justify-between border-b border-dashed border-gray-100 pb-2 last:border-0">
                    <dt className="flex items-center gap-2 text-gray-500">
                      <span className={`h-1.5 w-1.5 rounded-full ${TONE[tone].dot}`} />
                      {label}
                    </dt>
                    <dd className={`font-bold tabular-nums ${count > 0 ? '' : 'text-gray-300'}`} style={count > 0 ? { color: INK } : undefined}>{count}</dd>
                  </div>
                ))}
              </dl>

              {data.violations.list > 0 && (
                <button
                  type="button"
                  onClick={() => open('/violations')}
                  className="flex w-full items-center justify-between rounded-xl border border-gray-200 px-3.5 py-2.5 text-left transition-colors hover:border-[#FFD100] hover:bg-[#FFD100]/10"
                >
                  <span className="text-[11px] font-semibold text-gray-500">Violation List — cases that are neither pending nor rejected</span>
                  <span className="flex items-center gap-1.5 text-sm font-bold tabular-nums" style={{ color: INK }}>
                    {data.violations.list}
                    <ChevronRight className="h-4 w-4 text-gray-300" />
                  </span>
                </button>
              )}
            </div>
          ) : (
            <Empty>Reading…</Empty>
          )}
        </Section>

        <Section
          icon={UserPlus}
          title="Admissions & Discharges"
          subtitle={`${data?.admissions.current ?? 0} open admission periods · ${data?.admissions.thisMonth ?? 0} opened and ${data?.discharges.thisMonth ?? 0} closed this month.`}
        >
          {data && data.admissions.recent.length > 0 ? (
            <>
              <GroupHeading label="Most recent admissions" count={data.admissions.recent.length} />
              <ul className="-mx-1 space-y-0.5">
                {data.admissions.recent.map((row) => (
                  <li key={row.id}>
                    <Row onClick={() => open(`/children/${row.residentId}?tab=personal`)}>
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gray-100">
                        <UserPlus className="h-4 w-4 text-[#2F3E46]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold" style={{ color: INK }}>{row.residentName || row.admissionName || row.residentId}</span>
                        <span className="block text-[10px] text-gray-400">Admission #{row.admissionNumber}</span>
                      </span>
                      <span className="shrink-0 text-[11px] font-semibold text-gray-500">{shortDay(row.admissionDate)}</span>
                    </Row>
                  </li>
                ))}
              </ul>
              <div className="mt-4 grid grid-cols-3 gap-2.5 border-t border-dashed border-gray-100 pt-3.5">
                {([
                  ['On record', data.residents.total],
                  ['Discharged', data.residents.discharged],
                  ['Absconded', data.residents.absconded],
                ] as [string, number][]).map(([label, count]) => (
                  <div key={label}>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</p>
                    <p className="mt-0.5 text-lg font-bold leading-none tabular-nums" style={{ color: INK }}>{count}</p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Empty>No admissions recorded yet.</Empty>
          )}
        </Section>
      </div>

      {/* 7 ── TRI Statistics, reused exactly as the TRI module renders it. The
          rating bands are the instrument's own rule — re-deriving them here
          would be a second copy, which is how the two screens would come to
          disagree about a resident's rating. */}
      <TriStatistics />

      <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pb-2 text-center text-[10px] text-gray-400">
        <Stethoscope className="h-3 w-3" />
        Every figure on this page is read live from the database, and each count comes from the same query as the list it opens.
        <Clock className="h-3 w-3" />
        Refreshed every minute and whenever this window regains focus.
      </p>
    </div>
  );
}

export default CenterHeadDashboard;
