/**
 * The Center Head's command centre.
 *
 * Every number and every row on this page comes from `GET /dashboard/center-head`
 * — one request, answered from the live tables. Nothing is derived from the
 * browser's cached store, because the point of the page is that a record filed by
 * any other member of staff is visible here without a re-login, and a count that
 * is assembled client-side is a count that can lag the database.
 *
 * The counts on the tiles and the rows in the lists behind them are built from
 * the same SQL predicate on the server, so a tile can never open a screen that
 * disagrees with it. That was the bug this page is meant to end: "Docs Pending"
 * and the Documents module's badge had drifted apart twice over, because the
 * rule lived in two places.
 *
 * Everything is clickable and lands on the record or the filtered module view —
 * see `open()` and `scheduleRoute()` for the mapping. Where a module has no
 * per-record route (Court Records, Education), the link opens the module with
 * the relevant tab selected rather than pretending a detail page exists.
 *
 * Layout, top to bottom:
 *   1. Command bar        — who this is, when it was read, manual refresh
 *   2. Attention strip    — only what is late or waiting on a decision
 *   3. Facility KPIs      — the state of the home
 *   4. Schedules | Overdue & waiting
 *   5. Documents to review | Reports to review
 *   6. Operations         — phase mix, case types, violations, TRI
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users, UserPlus, UserMinus, Calendar, CalendarClock, AlertTriangle,
  FileText, ClipboardCheck, ClipboardList, Clock, Gavel, GraduationCap,
  ShieldAlert, RefreshCw, Inbox, Activity, Scale, ChevronRight,
  BookOpen, Stethoscope, ListChecks, Hourglass, ArrowUpRight,
} from 'lucide-react';
import { useAuth } from '../state/AuthContext';
import { request } from '@/services/api';
import { TriStatistics } from './TriStatistics';

// ── PAYLOAD ─────────────────────────────────────────────────────────────────

type ScheduleKind = 'activity' | 'assessment' | 'hearing' | 'intervention' | 'schoolVisit';

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
    open: number; pendingReview: number; underInvestigation: number;
    escalated: number; resolvedThisMonth: number;
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
    today: { date: string; activities: number; assessments: number; hearings: number; interventions: number; schoolVisits: number; total: number };
    upcomingCounts: { activities: number; assessments: number; hearings: number; interventions: number; schoolVisits: number; total: number };
    overdueCounts: { activities: number; assessments: number; hearings: number; interventions: number; schoolVisits: number; total: number };
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
  if (days === -1) return '1 day overdue';
  return `${Math.abs(days)} days overdue`;
}

function relativeTone(days: number): Tone {
  if (days < 0) return 'danger';
  if (days === 0) return 'warn';
  if (days <= 3) return 'info';
  return 'muted';
}

/** `2026-09-27` → `Sep 27`. The list is dense; the year is in the tooltip. */
function shortDay(value?: string | null): string {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(match[2]) - 1]} ${Number(match[3])}`;
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthName(month?: number | null): string {
  const index = Number(month);
  return Number.isFinite(index) && index >= 1 && index <= 12 ? MONTHS[index - 1] : '';
}

/**
 * A KPI tile.
 *
 * `value` is a real count from the API — never a placeholder. While the first
 * read is in flight the tile shows a skeleton bar rather than a zero, so a slow
 * response cannot be mistaken for an empty facility.
 */
function StatTile({
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
      className="group relative flex flex-col rounded-xl border border-gray-200 bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#FFD100] hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD100]"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">{label}</span>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-[#2F3E46] transition-colors group-hover:bg-[#FFD100]/25">
          <Icon className="h-4 w-4" />
        </span>
      </div>
      {loading ? (
        <span className="mt-2 h-8 w-16 animate-pulse rounded bg-gray-100" />
      ) : (
        <span className="mt-1 text-3xl font-bold leading-none tabular-nums text-[#2F3E46]">{value}</span>
      )}
      <span className="mt-2 flex items-center gap-1.5 text-[11px] leading-tight text-gray-500">
        {tone !== 'muted' && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[tone].dot}`} />}
        <span className="truncate">{sub}</span>
      </span>
      <ArrowUpRight className="absolute bottom-3 right-3 h-3.5 w-3.5 text-gray-300 transition-colors group-hover:text-[#2F3E46]" />
    </button>
  );
}

/** A titled card. Every section on the page uses this, so the headers match. */
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
    <section className={`flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm ${className}`}>
      <header className="flex items-start justify-between gap-3 border-b border-gray-100 px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${ACCENT}26` }}>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold text-[#2F3E46]">{title}</h3>
            {subtitle && <p className="mt-0.5 text-[11px] leading-tight text-gray-500">{subtitle}</p>}
          </div>
        </div>
        {action}
      </header>
      <div className="flex-1 p-4">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-center text-xs italic text-gray-400">{children}</p>;
}

/** A row that navigates somewhere. Used for every list on the page. */
function Row({
  onClick, children, className = '',
}: {
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-[#FFD100] hover:bg-[#FFD100]/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD100] ${className}`}
    >
      {children}
      <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" />
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
};

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

  // ── Navigation ───────────────────────────────────────────────────────────
  // Every click on this page ends up in one of these three functions, so the
  // mapping from "what the Center Head is looking at" to "where it lives" is in
  // one place and cannot drift row by row.

  /** A schedule row → its own record where one exists, else the module. */
  const scheduleRoute = useCallback((item: ScheduleItem) => {
    switch (item.kind) {
      case 'activity': return `/activities/${item.id}`;
      case 'assessment': return `/assessments/${item.id}`;
      case 'hearing': return '/court-records?filter=Scheduled';
      case 'intervention': return '/violations?tab=interventions';
      case 'schoolVisit': return '/education';
      default: return '/dashboard';
    }
  }, []);

  const open = useCallback((path: string) => navigate(path), [navigate]);

  // ── Derived view models ──────────────────────────────────────────────────
  const attention = useMemo(() => {
    if (!data) return [];
    const chips: { key: string; label: string; count: number; tone: Tone; icon: React.ComponentType<{ className?: string }>; to: string }[] = [
      { key: 'docs', label: 'Documents awaiting review', count: data.documents.count, tone: 'review', icon: FileText, to: '/documents?tab=pending' },
      { key: 'reports', label: 'Reports awaiting review', count: data.reports.total, tone: 'review', icon: ClipboardList, to: '/reports?tab=review' },
      { key: 'overdueSchedules', label: 'Schedules past their date', count: data.schedules.overdueCounts.total, tone: 'danger', icon: CalendarClock, to: '/activities' },
      { key: 'overdueHearings', label: 'Hearings with no outcome', count: data.hearings.overdue, tone: 'danger', icon: Gavel, to: '/court-records?filter=Scheduled' },
      { key: 'access', label: 'Access requests pending', count: data.accessRequests.count, tone: 'warn', icon: Inbox, to: '/documents?tab=access' },
      { key: 'dischargeRec', label: 'Discharge recommendations', count: data.discharges.pendingRecommendations.length, tone: 'warn', icon: UserMinus, to: '/children?filter=Active' },
      { key: 'expectedDischarge', label: 'Expected discharge dates passed', count: data.admissions.expectedOverdue.length, tone: 'danger', icon: Hourglass, to: '/children?filter=Active' },
    ];
    return chips.filter((chip) => chip.count > 0);
  }, [data]);

  const phaseTotal = data?.residents.byPhase.reduce((sum, row) => sum + row.count, 0) || 0;
  const caseTypeTotal = data?.residents.byCaseType.reduce((sum, row) => sum + row.count, 0) || 0;

  const today = data?.today || '';
  const generatedAt = data?.generatedAt
    ? new Date(data.generatedAt).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' })
    : null;

  const liveSchedules = data ? [...data.schedules.upcoming] : [];

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">

      {/* 1 ── Command bar */}
      <header className="relative overflow-hidden rounded-xl bg-[#2F3E46] px-5 py-5 shadow-md">
        <div className="absolute inset-y-0 left-0 w-1.5 bg-[#FFD100]" />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">Command Centre</h1>
              <span className="flex items-center gap-1.5 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#FFD100]">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FFD100] opacity-70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#FFD100]" />
                </span>
                Live
              </span>
            </div>
            <p className="mt-1 text-sm text-gray-300">
              Welcome back, <span className="font-bold uppercase text-[#FFD100]">{displayRole || 'CENTER HEAD'}</span>
              <span className="ml-2 text-xs text-gray-400">
                {today ? `· ${shortDay(today)}` : ''}
                {generatedAt ? ` · read at ${generatedAt}` : ''}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {data && (
              <div className="hidden rounded-lg bg-white/5 px-3 py-2 text-right sm:block">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">In the facility</p>
                <p className="text-lg font-bold leading-none text-white tabular-nums">{data.residents.active}</p>
              </div>
            )}
            <button
              type="button"
              onClick={() => load(true)}
              disabled={refreshing}
              className="flex items-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-white/10 disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <div>
            <p className="text-sm font-bold text-red-700">The dashboard could not be read</p>
            <p className="mt-0.5 text-xs text-red-600">{error}</p>
          </div>
        </div>
      )}

      {/* 2 ── Attention strip. Only non-zero items appear: a page that always
          shows six zeroes trains the reader to ignore all six. */}
      {attention.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
          <div className="mb-2.5 flex items-center gap-2 px-1">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500">Needs your attention</h2>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {attention.map((chip) => {
              const Icon = chip.icon;
              return (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => open(chip.to)}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-transform hover:-translate-y-0.5 ${TONE[chip.tone].chip}`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/70">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 text-[11px] font-semibold leading-tight">{chip.label}</span>
                  <span className="shrink-0 text-lg font-bold leading-none tabular-nums">{chip.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 3 ── Facility KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Active Residents" icon={Users} loading={loading}
          value={data?.residents.active ?? 0}
          sub={`of ${data?.residents.total ?? 0} on record${data?.residents.absconded ? ` · ${data.residents.absconded} absconded` : ''}`}
          onClick={() => open('/children?filter=Active')}
        />
        <StatTile
          label="Current Admissions" icon={UserPlus} loading={loading}
          value={data?.admissions.current ?? 0}
          sub={`${data?.admissions.thisMonth ?? 0} opened this month`}
          onClick={() => open('/children?filter=Active')}
        />
        <StatTile
          label="Discharged Residents" icon={UserMinus} loading={loading}
          value={data?.residents.discharged ?? 0}
          sub={`${data?.discharges.thisMonth ?? 0} discharged this month`}
          onClick={() => open('/children?filter=Discharged')}
        />
        <StatTile
          label="Pending Cases" icon={Gavel} loading={loading}
          value={data?.hearings.upcoming ?? 0}
          sub={data?.hearings.overdue ? `${data.hearings.overdue} with no outcome` : 'hearings on the calendar'}
          tone={data?.hearings.overdue ? 'danger' : 'muted'}
          onClick={() => open('/court-records?filter=Scheduled')}
        />
        <StatTile
          label="Open Violations" icon={Scale} loading={loading}
          value={data?.violations.open ?? 0}
          sub={`${data?.violations.pendingReview ?? 0} pending · ${data?.violations.underInvestigation ?? 0} investigating`}
          tone={data?.violations.escalated ? 'danger' : 'muted'}
          onClick={() => open('/violations')}
        />
        <StatTile
          label="Scheduled Today" icon={Calendar} loading={loading}
          value={data?.schedules.today.total ?? 0}
          sub={
            data
              ? `${data.schedules.today.activities} activities · ${data.schedules.today.assessments} assessments`
              : ''
          }
          onClick={() => open('/activities')}
        />
      </div>

      {/* 4 ── Schedules and what is waiting */}
      <div className="grid gap-5 lg:grid-cols-3">
        <Section
          icon={CalendarClock}
          title="Upcoming Schedules"
          subtitle="Every dated commitment across the facility — activities, assessments, hearings, intervention sessions and school visits."
          className="lg:col-span-2"
          action={
            data && (
              <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
                {([
                  ['activity', data.schedules.upcomingCounts.activities],
                  ['assessment', data.schedules.upcomingCounts.assessments],
                  ['hearing', data.schedules.upcomingCounts.hearings],
                  ['intervention', data.schedules.upcomingCounts.interventions],
                  ['schoolVisit', data.schedules.upcomingCounts.schoolVisits],
                ] as [ScheduleKind, number][]).map(([kind, count]) => {
                  const Icon = KIND[kind].icon;
                  return (
                    <span key={kind} title={`${count} ${KIND[kind].label.toLowerCase()}${count === 1 ? '' : 's'}`} className={`flex items-center gap-1 rounded-md border border-gray-200 px-1.5 py-0.5 text-[10px] font-bold ${KIND[kind].fg}`}>
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
            <div className="space-y-2">{[0, 1, 2, 3].map((n) => <div key={n} className="h-11 animate-pulse rounded-lg bg-gray-100" />)}</div>
          ) : liveSchedules.length === 0 ? (
            <Empty>Nothing scheduled. Activities, assessments, hearings and sessions appear here as they are booked.</Empty>
          ) : (
            <ul className="-mx-1 space-y-0.5">
              {liveSchedules.map((item) => {
                const meta = KIND[item.kind];
                const Icon = meta.icon;
                return (
                  <li key={`${item.kind}-${item.id}`}>
                    <Row onClick={() => open(scheduleRoute(item))}>
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${meta.bg}`}>
                        <Icon className={`h-4 w-4 ${meta.fg}`} />
                      </span>
                      <span className="w-14 shrink-0 text-center">
                        <span className="block text-[11px] font-bold text-[#2F3E46]">{shortDay(item.date)}</span>
                        <span className="block text-[10px] text-gray-400">{item.time || 'All day'}</span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-[#2F3E46]">{item.title}</span>
                        <span className="block truncate text-[10px] text-gray-400">
                          {[item.residentName, item.location, meta.label].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <Pill tone={relativeTone(item.days)}>{relativeLabel(item.days)}</Pill>
                    </Row>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section
          icon={AlertTriangle}
          title="Overdue & Waiting"
          subtitle="Past their date, or waiting on a decision that is yours to make."
        >
          <div className="space-y-4">
            {/* Overdue schedules */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Past their date</h4>
                <span className={`text-xs font-bold tabular-nums ${data?.schedules.overdueCounts.total ? TONE.danger.text : 'text-gray-400'}`}>
                  {data?.schedules.overdueCounts.total ?? 0}
                </span>
              </div>
              {data && data.schedules.overdue.length > 0 ? (
                <ul className="space-y-0.5">
                  {data.schedules.overdue.slice(0, 5).map((item) => {
                    const meta = KIND[item.kind];
                    const Icon = meta.icon;
                    return (
                      <li key={`od-${item.kind}-${item.id}`}>
                        <Row onClick={() => open(scheduleRoute(item))} className="bg-red-50/40">
                          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${meta.bg}`}>
                            <Icon className={`h-3.5 w-3.5 ${meta.fg}`} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold text-[#2F3E46]">{item.title}</span>
                            <span className="block truncate text-[10px] text-gray-400">{shortDay(item.date)} · {meta.label}</span>
                          </span>
                          <Pill tone="danger">{Math.abs(item.days)}d late</Pill>
                        </Row>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="rounded-lg bg-emerald-50 px-2.5 py-2 text-[11px] font-medium text-emerald-700">Nothing is past its date.</p>
              )}
            </div>

            {/* Hearings with no recorded outcome */}
            {data && data.hearings.overdue > 0 && (
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Hearings with no outcome</h4>
                  <span className={`text-xs font-bold tabular-nums ${TONE.danger.text}`}>{data.hearings.overdue}</span>
                </div>
                <ul className="space-y-0.5">
                  {data.hearings.overdueRows.slice(0, 4).map((row) => (
                    <li key={`oh-${row.id}`}>
                      <Row onClick={() => open(`/children/${row.residentId}?tab=personal`)} className="bg-red-50/40">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-50">
                          <Gavel className="h-3.5 w-3.5 text-amber-600" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold text-[#2F3E46]">{row.residentName || row.residentId}</span>
                          <span className="block truncate text-[10px] text-gray-400">
                            {[row.caseNumber, row.courtName, shortDay(row.hearingDate)].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <Pill tone="danger">{row.daysOverdue}d late</Pill>
                      </Row>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Discharge recommendations — a decision only the Center Head makes */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Discharge recommendations</h4>
                <span className={`text-xs font-bold tabular-nums ${data?.discharges.pendingRecommendations.length ? TONE.warn.text : 'text-gray-400'}`}>
                  {data?.discharges.pendingRecommendations.length ?? 0}
                </span>
              </div>
              {data && data.discharges.pendingRecommendations.length > 0 ? (
                <ul className="space-y-0.5">
                  {data.discharges.pendingRecommendations.slice(0, 4).map((rec) => (
                    <li key={rec.id}>
                      <Row onClick={() => open(`/children/${rec.residentId}?tab=personal`)} className="bg-amber-50/40">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-50">
                          <UserMinus className="h-3.5 w-3.5 text-amber-600" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold text-[#2F3E46]">{rec.residentName || rec.residentId}</span>
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
                <p className="rounded-lg bg-emerald-50 px-2.5 py-2 text-[11px] font-medium text-emerald-700">No recommendation is waiting.</p>
              )}
            </div>

            {/* Expected discharge dates, upcoming then overdue */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Expected discharge dates</h4>
                <span className="text-xs font-bold tabular-nums text-gray-400">
                  {(data?.admissions.expectedUpcoming.length ?? 0) + (data?.admissions.expectedOverdue.length ?? 0)}
                </span>
              </div>
              {data && (data.admissions.expectedOverdue.length > 0 || data.admissions.expectedUpcoming.length > 0) ? (
                <ul className="space-y-0.5">
                  {[...data.admissions.expectedOverdue, ...data.admissions.expectedUpcoming].slice(0, 5).map((row) => (
                    <li key={`ed-${row.residentId}`}>
                      <Row onClick={() => open(`/children/${row.residentId}?tab=personal`)} className={row.days < 0 ? 'bg-red-50/40' : ''}>
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gray-50">
                          <Hourglass className="h-3.5 w-3.5 text-[#2F3E46]" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold text-[#2F3E46]">{row.residentName || row.residentId}</span>
                          <span className="block text-[10px] text-gray-400">{shortDay(row.expectedDate)}</span>
                        </span>
                        <Pill tone={relativeTone(row.days)}>{relativeLabel(row.days)}</Pill>
                      </Row>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-lg bg-gray-50 px-2.5 py-2 text-[11px] font-medium text-gray-500">No expected discharge dates are set.</p>
              )}
            </div>
          </div>
        </Section>
      </div>

      {/* 5 ── The two review queues */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Section
          icon={FileText}
          title="Documents Needing Review"
          subtitle="Files submitted and not yet approved or rejected, for residents who are still active."
          action={
            data && data.documents.count > 0
              ? <button type="button" onClick={() => open('/documents?tab=pending')} className="shrink-0 text-[11px] font-bold text-[#2F3E46] underline decoration-[#FFD100] decoration-2 underline-offset-2 hover:decoration-[#2F3E46]">Open queue</button>
              : undefined
          }
        >
          {loading && !data ? (
            <div className="space-y-2">{[0, 1, 2].map((n) => <div key={n} className="h-12 animate-pulse rounded-lg bg-gray-100" />)}</div>
          ) : data && data.documents.items.length > 0 ? (
            <>
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold leading-none tabular-nums text-[#2F3E46]">{data.documents.count}</span>
                <span className="text-[11px] text-gray-500">waiting{data.documents.count > data.documents.items.length ? ` · showing ${data.documents.items.length}` : ''}</span>
              </div>
              <ul className="space-y-0.5">
                {data.documents.items.map((doc) => (
                  <li key={doc.id}>
                    <Row onClick={() => open(`/documents?tab=pending&docId=${encodeURIComponent(doc.id)}`)}>
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-50">
                        <FileText className="h-4 w-4 text-[#2F3E46]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-[#2F3E46]">{doc.title}</span>
                        <span className="block truncate text-[10px] text-gray-400">
                          {[doc.residentNameLive || doc.residentName || 'No resident', doc.uploaderRole, doc.submittedAt ? shortDateTime(doc.submittedAt) : null].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <Pill tone={statusTone(doc.status)}>{doc.status}</Pill>
                    </Row>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="rounded-lg bg-emerald-50 px-3 py-3 text-center text-xs font-medium text-emerald-700">Every submitted document has been decided.</p>
          )}
        </Section>

        <Section
          icon={ClipboardList}
          title="Reports Needing Review"
          subtitle="Anecdotal, Quarterly Progress and TRI submissions awaiting a decision, plus Education monthly reports."
          action={
            data && data.reports.total > 0
              ? <button type="button" onClick={() => open('/reports?tab=review')} className="shrink-0 text-[11px] font-bold text-[#2F3E46] underline decoration-[#FFD100] decoration-2 underline-offset-2 hover:decoration-[#2F3E46]">Open queue</button>
              : undefined
          }
        >
          {loading && !data ? (
            <div className="space-y-2">{[0, 1, 2].map((n) => <div key={n} className="h-12 animate-pulse rounded-lg bg-gray-100" />)}</div>
          ) : data ? (
            <div className="space-y-3.5">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([
                  { key: 'anecdotal', label: 'Anecdotal', count: data.reports.anecdotal.count, icon: BookOpen, to: '/reports?tab=review' },
                  { key: 'quarterly', label: 'Quarterly', count: data.reports.quarterly.count, icon: ListChecks, to: '/reports?tab=reports' },
                  { key: 'tri', label: 'TRI', count: data.reports.tri.count, icon: ClipboardList, to: '/tri' },
                  { key: 'education', label: 'Education', count: data.reports.education.count, icon: GraduationCap, to: '/education' },
                ] as { key: string; label: string; count: number; icon: React.ComponentType<{ className?: string }>; to: string }[]).map((bucket) => {
                  const Icon = bucket.icon;
                  const active = bucket.count > 0;
                  return (
                    <button
                      key={bucket.key}
                      type="button"
                      onClick={() => open(bucket.to)}
                      className={`rounded-lg border p-2.5 text-left transition-transform hover:-translate-y-0.5 ${active ? TONE.review.chip : 'border-gray-200 bg-gray-50 text-gray-400'}`}
                    >
                      <span className="flex items-center gap-1.5">
                        <Icon className="h-3.5 w-3.5" />
                        <span className="text-[10px] font-bold uppercase tracking-wide">{bucket.label}</span>
                      </span>
                      <span className="mt-1 block text-xl font-bold leading-none tabular-nums">{bucket.count}</span>
                    </button>
                  );
                })}
              </div>

              {data.reports.total === 0 ? (
                <p className="rounded-lg bg-emerald-50 px-3 py-3 text-center text-xs font-medium text-emerald-700">No report is waiting for a decision.</p>
              ) : (
                <ul className="space-y-0.5">
                  {/* Anecdotal first: it is the queue with a dedicated reviewer screen. */}
                  {data.reports.anecdotal.items.map((row) => (
                    <li key={`an-${row.id}`}>
                      <Row onClick={() => open(`/reports?tab=review&anecdotalId=${encodeURIComponent(row.id)}`)}>
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-50">
                          <BookOpen className="h-3.5 w-3.5 text-violet-600" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold text-[#2F3E46]">{row.residentName || row.residentId}</span>
                          <span className="block truncate text-[10px] text-gray-400">
                            Anecdotal · {monthName(row.reportMonth)} {row.reportYear}{row.submittedBy ? ` · ${row.submittedBy}` : ''}
                          </span>
                        </span>
                        <Pill tone={statusTone(row.status)}>{row.status}</Pill>
                      </Row>
                    </li>
                  ))}
                  {data.reports.quarterly.items.map((row) => (
                    <li key={`qr-${row.id}`}>
                      <Row onClick={() => open(`/reports?quarterlyReportId=${encodeURIComponent(row.id)}`)}>
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-50">
                          <ListChecks className="h-3.5 w-3.5 text-sky-600" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold text-[#2F3E46]">{row.residentName || row.residentId}</span>
                          <span className="block truncate text-[10px] text-gray-400">
                            Quarterly Progress · {row.periodLabel || `${shortDay(row.periodStart)} – ${shortDay(row.periodEnd)}`}
                          </span>
                        </span>
                        <Pill tone={statusTone(row.status)}>{row.status}</Pill>
                      </Row>
                    </li>
                  ))}
                  {data.reports.tri.items.map((row) => (
                    <li key={`tri-${row.id}`}>
                      <Row onClick={() => open(`/tri?recordId=${encodeURIComponent(row.id)}`)}>
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-50">
                          <ClipboardList className="h-3.5 w-3.5 text-amber-600" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold text-[#2F3E46]">{row.residentName || row.residentId}</span>
                          <span className="block truncate text-[10px] text-gray-400">
                            TRI · {monthName(row.reportingMonth)} {row.reportingYear}
                            {row.finalPoints != null ? ` · ${row.finalPoints} pts` : ''}
                            {row.rating ? ` · ${row.rating}` : ''}
                          </span>
                        </span>
                        <Pill tone={statusTone(row.status)}>{row.status}</Pill>
                      </Row>
                    </li>
                  ))}
                  {data.reports.education.items.map((row) => (
                    <li key={`ed-${row.id}`}>
                      <Row onClick={() => open('/education')}>
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-50">
                          <GraduationCap className="h-3.5 w-3.5 text-emerald-600" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold text-[#2F3E46]">{row.residentName || row.residentId}</span>
                          <span className="block truncate text-[10px] text-gray-400">Education monthly · {row.reportMonthKey || '—'}</span>
                        </span>
                        <Pill tone={statusTone(row.status)}>{row.status}</Pill>
                      </Row>
                    </li>
                  ))}
                </ul>
              )}

              {data.reports.incidentPending > 0 && (
                <p className="rounded-lg bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
                  <span className="font-bold text-[#2F3E46]">{data.reports.incidentPending}</span> incident report
                  {data.reports.incidentPending === 1 ? '' : 's'} still awaiting Psychological / Social Worker verification.
                </p>
              )}
            </div>
          ) : null}
        </Section>
      </div>

      {/* 6 ── Operations: who is in the facility, what they are in for, and what
          is open against them. Three cards of equal weight, so the row reads as
          one block rather than three competing ones. */}
      <div className="grid gap-5 lg:grid-cols-3">
        <Section icon={Activity} title="Resident Profile" subtitle="Active residents by intervention phase and by case type.">
          {data && (data.residents.byPhase.length > 0 || data.residents.byCaseType.length > 0) ? (
            <div className="space-y-4">
              <div>
                <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-gray-400">By phase</h4>
                {data.residents.byPhase.length > 0 ? (
                  <div className="space-y-2.5">
                    {data.residents.byPhase.map((row) => (
                      <button
                        key={row.phase}
                        type="button"
                        onClick={() => open('/children?filter=Active')}
                        title={row.phase}
                        className="flex w-full items-center gap-3 text-left"
                      >
                        <span className="w-24 shrink-0 truncate text-xs font-medium text-gray-600">{row.short}</span>
                        <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                          <span
                            className="block h-full rounded-full bg-[#2F3E46] transition-all"
                            style={{ width: phaseTotal ? `${(row.count / phaseTotal) * 100}%` : '0%' }}
                          />
                        </span>
                        <span className="w-6 shrink-0 text-right text-xs font-bold tabular-nums text-[#2F3E46]">{row.count}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <Empty>No active residents.</Empty>
                )}
              </div>
              <div className="border-t border-dashed border-gray-100 pt-3">
                <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-gray-400">By case type</h4>
                {data.residents.byCaseType.length > 0 ? (
                  <div className="space-y-2.5">
                    {data.residents.byCaseType.map((row) => (
                      <button
                        key={row.label}
                        type="button"
                        onClick={() => open('/children?filter=Active')}
                        className="flex w-full items-center gap-3 text-left"
                      >
                        <span className="w-24 shrink-0 truncate text-xs font-medium text-gray-600" title={row.label}>{row.label}</span>
                        <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                          <span
                            className="block h-full rounded-full bg-[#FFD100] transition-all"
                            style={{ width: caseTypeTotal ? `${(row.count / caseTypeTotal) * 100}%` : '0%' }}
                          />
                        </span>
                        <span className="w-6 shrink-0 text-right text-xs font-bold tabular-nums text-[#2F3E46]">{row.count}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <Empty>No active residents.</Empty>
                )}
              </div>
            </div>
          ) : (
            <Empty>No active residents.</Empty>
          )}
        </Section>

        <Section icon={Scale} title="Violations" subtitle="Unresolved incidents by severity, and the status of the open cases.">
          {data ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2">
                {([
                  { label: 'Minor', count: data.violations.bySeverity.Minor, cls: 'border-yellow-200 bg-yellow-50 text-yellow-700' },
                  { label: 'Major', count: data.violations.bySeverity.Major, cls: 'border-orange-200 bg-orange-50 text-orange-700' },
                  { label: 'Critical', count: data.violations.bySeverity.Critical, cls: 'border-red-200 bg-red-50 text-red-700' },
                ]).map((row) => (
                  <button
                    key={row.label}
                    type="button"
                    onClick={() => open('/violations')}
                    className={`rounded-lg border p-2.5 text-left transition-transform hover:-translate-y-0.5 ${row.cls}`}
                  >
                    <span className="block text-[10px] font-bold uppercase tracking-wide opacity-80">{row.label}</span>
                    <span className="mt-0.5 block text-xl font-bold leading-none tabular-nums">{row.count}</span>
                  </button>
                ))}
              </div>
              <dl className="space-y-1.5 text-xs">
                {([
                  ['Pending review', data.violations.pendingReview, 'warn'],
                  ['Under investigation', data.violations.underInvestigation, 'info'],
                  ['Escalated', data.violations.escalated, 'danger'],
                  ['Resolved this month', data.violations.resolvedThisMonth, 'ok'],
                ] as [string, number, Tone][]).map(([label, count, tone]) => (
                  <div key={label} className="flex items-center justify-between border-b border-dashed border-gray-100 pb-1.5 last:border-0">
                    <dt className="flex items-center gap-1.5 text-gray-500">
                      <span className={`h-1.5 w-1.5 rounded-full ${TONE[tone].dot}`} />
                      {label}
                    </dt>
                    <dd className={`font-bold tabular-nums ${count > 0 ? 'text-[#2F3E46]' : 'text-gray-300'}`}>{count}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <Empty>Reading…</Empty>
          )}
        </Section>

        <Section icon={UserPlus} title="Recent Admissions" subtitle={`${data?.admissions.current ?? 0} open admission periods · ${data?.admissions.thisMonth ?? 0} opened this month.`}>
          {data && data.admissions.recent.length > 0 ? (
            <ul className="-mx-1 space-y-0.5">
              {data.admissions.recent.map((row) => (
                <li key={row.id}>
                  <Row onClick={() => open(`/children/${row.residentId}?tab=personal`)}>
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gray-50">
                      <UserPlus className="h-3.5 w-3.5 text-[#2F3E46]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-[#2F3E46]">{row.residentName || row.admissionName || row.residentId}</span>
                      <span className="block text-[10px] text-gray-400">Admission #{row.admissionNumber}</span>
                    </span>
                    <span className="shrink-0 text-[11px] font-semibold text-gray-500">{shortDay(row.admissionDate)}</span>
                  </Row>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No admissions recorded yet.</Empty>
          )}
        </Section>
      </div>

      {/* TRI Statistics, on its own row and reused exactly as the TRI module
          renders it. The rating bands are the instrument's own rule — re-deriving
          them here would be a second copy, which is how the two screens would
          come to disagree about a resident's rating. */}
      <TriStatistics />

      <p className="pb-2 text-center text-[10px] text-gray-400">
        <Stethoscope className="mr-1 inline h-3 w-3" />
        Every figure on this page is read live from the database. Counts and the lists they open come from the same query, so they cannot disagree.
        <Clock className="ml-1 inline h-3 w-3" /> Refreshed automatically every minute and on window focus.
      </p>
    </div>
  );
}

export default CenterHeadDashboard;
