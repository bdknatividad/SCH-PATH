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
 * ## Charts
 *
 * Four charts, each drawn from a distribution the server already returns. No
 * series is invented to fill a hole, and a chart whose data is empty is replaced
 * by a sentence rather than drawn flat:
 *
 *   Rehabilitation phase    horizontal bars   `residents.byPhase`
 *   Behavioural status      donut             `residents.behavioral`
 *   Violations by severity  donut             `violations.bySeverity`
 *   Workload by kind        stacked bars      `schedules.*Counts`
 *
 * Case type is a bar list rather than a chart: its labels are free text typed by
 * staff, so a chart axis would clip them. Recharts animation is off — this page
 * re-reads itself every minute and whenever the window regains focus, and
 * re-animating four charts on every read is noise.
 *
 * ## Layout, top to bottom
 *   1. Command bar      — who this is, when it was read, manual refresh
 *   2. KPI strip        — six facility numbers, one band
 *   3. Action Center    — the decision queue as a table, and what is late
 *   4. Residents        — three cuts of one population
 *   5. Schedule         — workload chart, then Today | Upcoming | Overdue tables
 *   6. Violations and admissions
 *   7. TRI statistics, reused from the TRI module
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users, UserPlus, UserMinus, Calendar, CalendarClock, AlertTriangle,
  FileText, ClipboardCheck, ClipboardList, Clock, Gavel, GraduationCap,
  ShieldAlert, RefreshCw, Inbox, Scale, ChevronRight, Landmark,
  BookOpen, Stethoscope, ListChecks, Hourglass, CheckCircle2, ChartColumn,
} from 'lucide-react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, BarChart,
  Bar as RechartsBar, XAxis, YAxis, Tooltip as RechartsTooltip,
} from 'recharts';
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

/** The two brand colours the rest of the app is built from. */
const INK = '#2F3E46';
const ACCENT = '#FFD100';

/** Every surface on the page. One shadow, so nothing looks a shade deeper. */
const SURFACE = 'rounded-xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]';

/** The one tooltip shape, shared by all four charts. */
const TOOLTIP_STYLE = {
  contentStyle: {
    borderRadius: 10,
    border: '1px solid #e5e7eb',
    boxShadow: '0 6px 16px rgba(16,24,40,0.10)',
    fontSize: 11,
    padding: '6px 10px',
    backgroundColor: '#ffffff',
  },
  labelStyle: { color: INK, fontWeight: 700, fontSize: 11, marginBottom: 2 },
  itemStyle: { color: '#374151', fontSize: 11, padding: 0 },
};

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

/** "Today" / "Tomorrow" / "In 4 days" / "6 days late". */
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

/** "3 days waiting" — the age of a queued item. Null when it has no timestamp. */
function waitingLabel(value?: string | null): string | null {
  const days = daysAgo(value);
  if (days === null) return null;
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthName(month?: number | null): string {
  const index = Number(month);
  return Number.isFinite(index) && index >= 1 && index <= 12 ? MONTHS[index - 1] : '';
}

/** The percentage of a whole, rounded. Zero total reads 0, never NaN. */
function percentOf(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

// ── SHELL ───────────────────────────────────────────────────────────────────

/**
 * A section. Fewer, larger surfaces rather than a wall of small boxes: the page
 * has six sections, not sixteen cards.
 */
function Section({
  icon: Icon, title, subtitle, action, children, className = '', bodyClassName = 'p-5',
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`flex flex-col ${SURFACE} ${className}`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-5 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${ACCENT}2E` }}>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold" style={{ color: INK }}>{title}</h3>
            {subtitle && <p className="mt-0.5 text-[11px] leading-snug text-gray-500">{subtitle}</p>}
          </div>
        </div>
        {action}
      </header>
      <div className={`flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** The small "Open …" link a section header carries. */
function SectionLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 self-center rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] font-bold transition-colors hover:border-[#FFD100] hover:bg-[#FFD100]/15"
      style={{ color: INK }}
    >
      {label}
    </button>
  );
}

/** A group heading inside a section — "Today", "Awaiting a decision". */
function GroupHeading({ label, count, tone = 'muted', children }: { label: string; count?: number; tone?: Tone; children?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <h4 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-500">
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
  return <p className="py-5 text-center text-[11px] italic text-gray-400">{children}</p>;
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

// ── TABLE PRIMITIVES ────────────────────────────────────────────────────────
// The markup the rest of the app's tables use (Violations, Child Records), so a
// Center Head reading this page and then a module sees the same table.

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`whitespace-nowrap px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 ${className}`}>
      {children}
    </th>
  );
}

function Td({
  children, className = '', style, title,
}: {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}) {
  return (
    <td style={style} title={title} className={`px-3 py-2.5 align-middle text-xs text-gray-600 ${className}`}>
      {children}
    </td>
  );
}

/** A table row that navigates. Every list on the page is one of these. */
function Tr({ onClick, children, title }: { onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <tr
      onClick={onClick}
      title={title}
      className="cursor-pointer border-b border-gray-100 transition-colors last:border-0 hover:bg-[#FFD100]/10"
    >
      {children}
    </tr>
  );
}

/** The scroll shell every table sits in, so a narrow screen scrolls not squashes. */
function TableShell({ minWidth, children }: { minWidth: string; children: React.ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className="w-full border-collapse text-left text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

/** The trailing chevron cell, so every clickable row ends the same way. */
function GoCell() {
  return (
    <Td className="w-8 pr-2 text-right">
      <ChevronRight className="ml-auto h-4 w-4 text-gray-300" />
    </Td>
  );
}

// ── CHART PRIMITIVES ────────────────────────────────────────────────────────

/** A labelled slice of the whole. `rows` is a server distribution, unmodified. */
function Donut({
  rows, colors, unit, onPick,
}: {
  rows: { label: string; count: number }[];
  colors: Record<string, string>;
  unit: string;
  onPick: () => void;
}) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const drawn = rows.filter((row) => row.count > 0);
  if (total === 0) return <Empty>Nothing to chart yet.</Empty>;

  return (
    <div className="flex min-w-0 items-center gap-4">
      <div className="relative h-[132px] w-[132px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={drawn}
              dataKey="count"
              nameKey="label"
              innerRadius={41}
              outerRadius={64}
              paddingAngle={2}
              stroke="#ffffff"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {drawn.map((row) => (
                <Cell key={row.label} fill={colors[row.label] || '#9ca3af'} />
              ))}
            </Pie>
            <RechartsTooltip
              {...TOOLTIP_STYLE}
              formatter={(value: number | string) => `${value} ${unit}`}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[22px] font-bold leading-none tabular-nums" style={{ color: INK }}>{total}</span>
          <span className="mt-1 text-[9px] font-bold uppercase tracking-wider text-gray-400">Total</span>
        </div>
      </div>

      <ul className="min-w-0 flex-1 space-y-0.5">
        {rows.map((row) => (
          <li key={row.label}>
            <button
              type="button"
              onClick={onPick}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[#FFD100]/15"
            >
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: colors[row.label] || '#9ca3af' }} />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-gray-600">{row.label}</span>
              <span className="shrink-0 text-[11px] font-bold tabular-nums" style={{ color: INK }}>{row.count}</span>
              <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-gray-400">{percentOf(row.count, total)}%</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A horizontal bar list, for distributions whose labels are free text. */
function BarList({
  rows, total, fill, onPick,
}: {
  rows: { label: string; count: number }[];
  total: number;
  fill: string;
  onPick: () => void;
}) {
  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <li key={row.label}>
          <button
            type="button"
            onClick={onPick}
            title={`${row.label} — ${row.count} resident${row.count === 1 ? '' : 's'}`}
            className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[#FFD100]/15"
          >
            <span className="w-[104px] shrink-0 truncate text-[11px] font-medium text-gray-600">{row.label}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
              <span className="block h-full rounded-full" style={{ width: `${percentOf(row.count, total)}%`, backgroundColor: fill }} />
            </span>
            <span className="w-4 shrink-0 text-right text-[11px] font-bold tabular-nums" style={{ color: INK }}>{row.count}</span>
            <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-gray-400">{percentOf(row.count, total)}%</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One metric in the KPI strip. */
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
      className="group flex min-w-0 flex-col items-start px-4 py-3.5 text-left transition-colors hover:bg-[#FFD100]/12 focus:outline-none focus-visible:bg-[#FFD100]/15"
    >
      <span className="flex w-full items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-gray-400 transition-colors group-hover:text-[#2F3E46]" />
        <span className="truncate text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</span>
      </span>
      {loading ? (
        <span className="mt-2 h-7 w-12 animate-pulse rounded bg-gray-100" />
      ) : (
        <span className="mt-1.5 text-[25px] font-bold leading-none tabular-nums" style={{ color: INK }}>{value}</span>
      )}
      <span className="mt-1.5 flex w-full min-w-0 items-center gap-1.5 text-[10px] leading-tight text-gray-500">
        {tone !== 'muted' && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[tone].dot}`} />}
        <span className="truncate">{sub}</span>
      </span>
    </button>
  );
}

/** The icon and colour for each kind of schedule. */
const KIND: Record<ScheduleKind, { icon: React.ComponentType<{ className?: string }>; bg: string; fg: string; label: string }> = {
  activity: { icon: Calendar, bg: 'bg-sky-50', fg: 'text-sky-600', label: 'Activity' },
  assessment: { icon: ClipboardCheck, bg: 'bg-violet-50', fg: 'text-violet-600', label: 'Assessment' },
  hearing: { icon: Gavel, bg: 'bg-amber-50', fg: 'text-amber-600', label: 'Hearing' },
  intervention: { icon: ShieldAlert, bg: 'bg-rose-50', fg: 'text-rose-600', label: 'Intervention' },
  schoolVisit: { icon: GraduationCap, bg: 'bg-emerald-50', fg: 'text-emerald-600', label: 'School visit' },
  triDeadline: { icon: ClipboardList, bg: 'bg-indigo-50', fg: 'text-indigo-600', label: 'TRI deadline' },
};

/** The kinds the workload chart and the per-kind summary print, in reading order. */
const SUMMARY_KINDS: ScheduleKind[] = ['activity', 'assessment', 'hearing', 'intervention', 'schoolVisit', 'triDeadline'];

/** The colours the behavioural bands print, matching the Child Detail tab. */
const BEHAVIORAL_COLORS: Record<string, string> = {
  'Very Good': '#10b981',
  Good: '#0ea5e9',
  Fair: '#f59e0b',
  'Needs Improvement': '#ef4444',
  'Not Rated': '#9ca3af',
  'Still Monitoring': '#60a5fa',
};

/** The Violations module's own severity colours. */
const SEVERITY_COLORS: Record<string, string> = {
  Minor: '#facc15',
  Major: '#f97316',
  Critical: '#dc2626',
};

/** Phase bars are shades of the brand slate, darkest first. */
const PHASE_COLORS = ['#2F3E46', '#46595F', '#5E747C', '#7C9299', '#A3B4B9', '#C8D3D6'];

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
   * Everything waiting on a decision, from all five queues, as one list. A
   * Center Head does not care which module filed the paperwork — only that it is
   * theirs to decide — so the sources are merged and ordered by how long each
   * has been waiting, oldest first.
   */
  const decisionQueue = useMemo(() => {
    if (!data) return [];
    type Item = {
      key: string; source: string; icon: React.ComponentType<{ className?: string }>;
      bg: string; fg: string; title: string; resident: string; detail: string; status: string;
      queuedAt: string | null; to: string;
    };
    const items: Item[] = [];

    for (const doc of data.documents.items) {
      items.push({
        key: `doc-${doc.id}`, source: 'Document', icon: FileText, bg: 'bg-gray-100', fg: 'text-gray-600',
        title: doc.title,
        resident: doc.residentNameLive || doc.residentName || '—',
        detail: doc.documentCategory || doc.type || '—',
        status: doc.status,
        queuedAt: doc.submittedAt || null,
        to: `/documents?tab=pending&docId=${encodeURIComponent(doc.id)}`,
      });
    }
    for (const row of data.reports.anecdotal.items) {
      items.push({
        key: `an-${row.id}`, source: 'Anecdotal', icon: BookOpen, bg: 'bg-violet-50', fg: 'text-violet-600',
        title: `${monthName(row.reportMonth)} ${row.reportYear}`.trim() || 'Anecdotal report',
        resident: row.residentName || row.residentId,
        detail: row.submittedBy ? `by ${row.submittedBy}` : '—',
        status: row.status, queuedAt: row.submittedAt || null,
        to: `/reports?tab=review&anecdotalId=${encodeURIComponent(row.id)}`,
      });
    }
    for (const row of data.reports.quarterly.items) {
      items.push({
        key: `qr-${row.id}`, source: 'Quarterly', icon: ListChecks, bg: 'bg-sky-50', fg: 'text-sky-600',
        title: row.periodLabel || `${shortDay(row.periodStart)} – ${shortDay(row.periodEnd)}`,
        resident: row.residentName || row.residentId,
        detail: row.submittedBy ? `by ${row.submittedBy}` : '—',
        status: row.status, queuedAt: row.submittedAt || null,
        to: `/reports?quarterlyReportId=${encodeURIComponent(row.id)}`,
      });
    }
    for (const row of data.reports.tri.items) {
      items.push({
        key: `tri-${row.id}`, source: 'TRI', icon: ClipboardList, bg: 'bg-amber-50', fg: 'text-amber-600',
        // No leading "TRI ·" here: the row already prints its `source`, so
        // repeating it produced "TRI · TRI · Sep 2026".
        title: `${monthName(row.reportingMonth)} ${row.reportingYear}`.trim() || 'TRI',
        resident: row.residentName || row.residentId,
        detail: [
          row.finalPoints != null ? `${row.finalPoints} pts` : null,
          row.rating,
          row.submittedBy ? `by ${row.submittedBy}` : null,
        ].filter(Boolean).join(' · ') || '—',
        status: row.status, queuedAt: row.submittedAt || null,
        to: `/tri?recordId=${encodeURIComponent(row.id)}`,
      });
    }
    for (const row of data.reports.education.items) {
      items.push({
        key: `ed-${row.id}`, source: 'Education', icon: GraduationCap, bg: 'bg-emerald-50', fg: 'text-emerald-600',
        title: row.reportMonthKey || 'Education monthly',
        resident: row.residentName || row.residentId,
        detail: row.submittedBy ? `by ${row.submittedBy}` : '—',
        status: row.status, queuedAt: row.submittedAt || null,
        to: '/education',
      });
    }
    for (const row of data.accessRequests.items) {
      items.push({
        key: `ar-${row.id}`, source: 'Access', icon: Inbox, bg: 'bg-amber-50', fg: 'text-amber-600',
        title: `${row.moduleName || 'Module'} access`,
        resident: row.residentName || row.residentId || row.requesterUsername,
        detail: `${row.requesterUsername}${row.recordTab ? ` · ${row.recordTab}` : ''}`,
        status: 'Pending', queuedAt: row.createdAt || null,
        to: '/documents?tab=access',
      });
    }

    // Oldest first: the item that has been waiting longest is the one to clear.
    // An item with no timestamp sorts last rather than jumping the queue.
    items.sort((a, b) => String(a.queuedAt || '9999').localeCompare(String(b.queuedAt || '9999')));
    return items;
  }, [data]);

  /**
   * The summary numbers on the Action Center strip. Only the non-zero ones are
   * rendered: a page that always shows seven zeroes trains the reader to ignore
   * all seven.
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
   * The queue's composition as one stacked bar — how much of the backlog is
   * paperwork, how much is reports, how much is permissions. Only drawn when
   * something is actually queued.
   */
  const queueMix = useMemo(() => {
    if (!data || decisionTotal === 0) return [];
    return ([
      { label: 'Documents', count: data.documents.count, color: INK },
      { label: 'Reports', count: data.reports.total, color: ACCENT },
      { label: 'Access requests', count: data.accessRequests.count, color: '#f59e0b' },
    ]).filter((part) => part.count > 0);
  }, [data, decisionTotal]);

  /** The deadline groups, each dropped when it has nothing in it. */
  const deadlineGroups = useMemo(() => {
    if (!data) return [];
    return ([
      {
        key: 'expectedOverdue', label: 'Discharge dates passed', icon: Hourglass, tone: 'danger' as Tone,
        rows: data.admissions.expectedOverdue.map((row) => ({
          key: `eo-${row.residentId}`, residentId: row.residentId, name: row.residentName || row.residentId,
          meta: `Expected ${shortDay(row.expectedDate)}`, badge: `${row.daysOverdue}d late`, tone: 'danger' as Tone,
        })),
      },
      {
        key: 'discharge', label: 'Discharge recommendations', icon: UserMinus, tone: 'warn' as Tone,
        rows: data.discharges.pendingRecommendations.map((rec) => ({
          key: rec.id, residentId: rec.residentId, name: rec.residentName || rec.residentId,
          meta: `${rec.thresholdType} · ${monthName(rec.reportingMonth)} ${rec.reportingYear}`, badge: 'Pending', tone: 'warn' as Tone,
        })),
      },
      {
        key: 'expectedUpcoming', label: 'Discharge dates ahead', icon: CalendarClock, tone: 'info' as Tone,
        rows: data.admissions.expectedUpcoming.map((row) => ({
          key: `eu-${row.residentId}`, residentId: row.residentId, name: row.residentName || row.residentId,
          meta: `Expected ${shortDay(row.expectedDate)}`, badge: relativeLabel(row.days), tone: relativeTone(row.days),
        })),
      },
    ]).filter((group) => group.rows.length > 0);
  }, [data]);

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

  /**
   * Workload by kind: today's share, the rest of what is ahead, and what has
   * already been missed. `ahead` is net of today so the three segments add up to
   * the feed's own totals instead of double-counting the day.
   */
  const workload = useMemo(() => {
    if (!data) return [];
    return SUMMARY_KINDS
      .map((kind) => ({
        label: KIND[kind].label,
        today: data.schedules.today[kind] || 0,
        ahead: Math.max(0, (data.schedules.upcomingCounts[kind] || 0) - (data.schedules.today[kind] || 0)),
        overdue: data.schedules.overdueCounts[kind] || 0,
      }))
      .filter((row) => row.today + row.ahead + row.overdue > 0);
  }, [data]);

  /** The Violations module's status buckets, in the order the module lists them. */
  const violationBuckets = useMemo(() => {
    if (!data) return [];
    const v = data.violations;
    return ([
      { label: 'Reviewed — in the Violation List', count: v.reviewed, tone: 'review' as Tone },
      { label: 'Overdue — intervention month passed', count: v.overdue, tone: 'danger' as Tone },
      { label: 'Pending review — not yet in the list', count: v.pendingReview, tone: 'warn' as Tone },
      { label: 'Resolved', count: v.resolved, tone: 'ok' as Tone },
      { label: 'Rejected', count: v.rejected, tone: 'muted' as Tone },
    ]);
  }, [data]);

  const severityRows = data
    ? [
      { label: 'Minor', count: data.violations.bySeverity.Minor },
      { label: 'Major', count: data.violations.bySeverity.Major },
      { label: 'Critical', count: data.violations.bySeverity.Critical },
    ]
    : [];

  /**
   * One schedule table, shared by the three timeline groups. `empty` is passed
   * in whole rather than as text so the overdue column can carry the all-clear
   * state instead of a grey sentence.
   */
  const scheduleTable = (items: ScheduleItem[], limit: number, empty: React.ReactNode) => {
    if (items.length === 0) return empty;
    return (
      <TableShell minWidth="320px">
        <tbody className="divide-y divide-gray-100">
          {items.slice(0, limit).map((item) => {
            const meta = KIND[item.kind] || KIND.activity;
            const Icon = meta.icon;
            return (
              <Tr
                key={`${item.kind}-${item.id}`}
                onClick={() => open(scheduleRoute(item))}
                title={`${item.title} — ${relativeLabel(item.days)}`}
              >
                <Td className="w-[74px] whitespace-nowrap">
                  <span className="block text-[11px] font-bold" style={{ color: INK }}>{shortDay(item.date)}</span>
                  {item.time && <span className="block text-[10px] tabular-nums text-gray-400">{item.time}</span>}
                </Td>
                <Td className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${meta.bg}`}>
                      <Icon className={`h-3 w-3 ${meta.fg}`} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-semibold" style={{ color: INK }}>{item.title}</span>
                      <span className="block truncate text-[10px] text-gray-400">
                        {[item.residentName, item.location, item.caseNumber].filter(Boolean).join(' · ') || meta.label}
                      </span>
                    </span>
                  </span>
                </Td>
                <Td className="w-[86px] text-right">
                  <Pill tone={relativeTone(item.days)}>{relativeLabel(item.days)}</Pill>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </TableShell>
    );
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">

      {/* 1 ── Command bar */}
      <header className="relative overflow-hidden rounded-xl bg-[#2F3E46] px-6 py-5 shadow-md">
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
              <div className="hidden rounded-lg bg-white/5 px-3.5 py-2 text-right sm:block">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">In the facility</p>
                <p className="text-lg font-bold leading-none text-white tabular-nums">{data.residents.active}</p>
              </div>
            )}
            <button
              type="button"
              onClick={() => load(true)}
              disabled={refreshing}
              className="flex items-center gap-2 rounded-lg border border-white/20 px-3.5 py-2 text-xs font-bold text-white transition-colors hover:bg-white/10 disabled:opacity-60"
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

      {/* 2 ── KPI strip. One band with hairline dividers instead of six
          separate cards, so the numbers read as one picture of the home. */}
      <div className={`overflow-hidden ${SURFACE}`}>
        <div className="grid grid-cols-2 divide-x divide-y divide-gray-100 sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
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

      {/* 3 ── ACTION CENTER. The queue as a table, the deadlines beside it. */}
      <Section
        icon={AlertTriangle}
        title="Action Center"
        subtitle="Everything waiting on the Center Head, and how long it has been waiting."
      >
        {/* The summary strip. Only non-zero counts appear. */}
        {loading && !data ? (
          <div className="mb-5 h-10 animate-pulse rounded-lg bg-gray-100" />
        ) : attention.length === 0 ? (
          <div className="mb-5">
            <Clear>Nothing is waiting on you. No document, report, request or deadline is outstanding.</Clear>
          </div>
        ) : (
          <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {attention.map((chip) => {
              const Icon = chip.icon;
              return (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => open(chip.to)}
                  className="group flex min-w-0 items-center gap-2 rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-left transition-colors hover:border-[#FFD100] hover:bg-[#FFD100]/12"
                >
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${TONE[chip.tone].text}`} />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-gray-600 group-hover:text-[#2F3E46]">{chip.label}</span>
                  <span className={`shrink-0 text-sm font-bold leading-none tabular-nums ${TONE[chip.tone].text}`}>{chip.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* The queue's composition. A single bar answers "what is the backlog
            made of" before the table answers "which item is next". */}
        {queueMix.length > 0 && (
          <div className="mb-5">
            <div className="flex h-2 overflow-hidden rounded-full bg-gray-100">
              {queueMix.map((part) => (
                <span key={part.label} style={{ width: `${percentOf(part.count, decisionTotal)}%`, backgroundColor: part.color }} />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
              {queueMix.map((part) => (
                <span key={part.label} className="flex items-center gap-1.5 text-[10px] font-medium text-gray-500">
                  <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: part.color }} />
                  {part.label}
                  <span className="font-bold tabular-nums" style={{ color: INK }}>{part.count}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          {/* What is waiting on a decision */}
          <div className="min-w-0 lg:col-span-2">
            <GroupHeading label="Awaiting a decision" count={decisionTotal} tone="review" />

            {loading && !data ? (
              <div className="space-y-2">{[0, 1, 2, 3].map((n) => <div key={n} className="h-10 animate-pulse rounded-lg bg-gray-100" />)}</div>
            ) : decisionQueue.length === 0 ? (
              <Clear>Every submitted document and report has been decided.</Clear>
            ) : (
              <>
                <TableShell minWidth="560px">
                  <thead className="border-b border-gray-200 bg-gray-50/80">
                    <tr>
                      <Th className="w-[104px]">Source</Th>
                      <Th>Item</Th>
                      <Th className="w-[22%]">Resident</Th>
                      <Th className="w-[92px]">Status</Th>
                      <Th className="w-[72px] text-right">Waiting</Th>
                      <Th className="w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {decisionQueue.slice(0, 8).map((item) => {
                      const Icon = item.icon;
                      const waiting = waitingLabel(item.queuedAt);
                      return (
                        <Tr key={item.key} onClick={() => open(item.to)} title={item.title}>
                          <Td>
                            <span className="flex items-center gap-1.5">
                              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${item.bg}`}>
                                <Icon className={`h-3 w-3 ${item.fg}`} />
                              </span>
                              <span className="truncate text-[10px] font-bold uppercase tracking-wide text-gray-500">{item.source}</span>
                            </span>
                          </Td>
                          <Td>
                            <span className="block truncate font-semibold" style={{ color: INK }}>{item.title}</span>
                            <span className="block truncate text-[10px] text-gray-400">{item.detail}</span>
                          </Td>
                          <Td className="truncate">{item.resident}</Td>
                          <Td><Pill tone={statusTone(item.status)}>{item.status}</Pill></Td>
                          <Td
                            className="text-right text-[11px] tabular-nums text-gray-500"
                            title={item.queuedAt ? `Queued ${shortDateTime(item.queuedAt)}` : undefined}
                          >
                            {waiting || '—'}
                          </Td>
                          <GoCell />
                        </Tr>
                      );
                    })}
                  </tbody>
                </TableShell>
                {decisionQueue.length > 8 && (
                  <p className="px-3 pt-2 text-[11px] text-gray-400">
                    {decisionQueue.length - 8} more in the review queues.
                  </p>
                )}
              </>
            )}

            {/* Incident reports — not the Center Head's queue, but visible. */}
            {(data?.reports.incidentPending || 0) > 0 && (
              <p className="mt-4 rounded-lg bg-gray-50 px-3 py-2 text-[11px] leading-relaxed text-gray-500">
                <span className="font-bold" style={{ color: INK }}>{data!.reports.incidentPending}</span> incident report
                {data!.reports.incidentPending === 1 ? '' : 's'} still awaiting Psychological / Social Worker verification
                — not your queue, counted so the workload is visible.
              </p>
            )}
          </div>

          {/* What is late, and the decisions attached to it */}
          <div className="min-w-0 lg:border-l lg:border-gray-100 lg:pl-6">
            <GroupHeading
              label="Deadlines"
              tone="danger"
              count={(data?.admissions.expectedOverdue.length || 0) + (data?.discharges.pendingRecommendations.length || 0)}
            />

            {deadlineGroups.length === 0 ? (
              <Clear>Nothing is past due, and no discharge decision is waiting.</Clear>
            ) : (
              <div className="space-y-4">
                {deadlineGroups.map((group) => {
                  const Icon = group.icon;
                  return (
                    <div key={group.key}>
                      <h5 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                        <Icon className="h-3 w-3" /> {group.label}
                      </h5>
                      <ul className="space-y-0.5">
                        {group.rows.slice(0, 4).map((row) => (
                          <li key={row.key}>
                            <button
                              type="button"
                              onClick={() => open(`/children/${row.residentId}?tab=personal`)}
                              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[#FFD100]/15"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[11px] font-semibold" style={{ color: INK }}>{row.name}</span>
                                <span className="block truncate text-[10px] text-gray-400">{row.meta}</span>
                              </span>
                              <Pill tone={row.tone}>{row.badge}</Pill>
                            </button>
                          </li>
                        ))}
                      </ul>
                      {group.rows.length > 4 && (
                        <p className="px-2 pt-1 text-[10px] text-gray-400">+{group.rows.length - 4} more</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </Section>

      {/* 4 ── RESIDENTS. One population, three cuts: rehabilitation phase,
          behavioural status, case type. */}
      <Section
        icon={Users}
        title="Residents"
        subtitle={`How the ${data?.residents.active ?? 0} residents currently in the facility are distributed. Every cut counts the same residents.`}
        action={<SectionLink label="Open Child Records" onClick={() => open(RESIDENTS_ACTIVE)} />}
      >
        {loading && !data ? (
          <div className="grid gap-6 lg:grid-cols-3">
            {[0, 1, 2].map((n) => <div key={n} className="h-40 animate-pulse rounded-lg bg-gray-100" />)}
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Rehabilitation phase */}
            <div className="min-w-0">
              <GroupHeading label="By rehabilitation phase" count={phaseTotal} />
              {data && data.residents.byPhase.length > 0 ? (
                <ResponsiveContainer width="100%" height={Math.max(120, data.residents.byPhase.length * 38 + 16)}>
                  <BarChart data={data.residents.byPhase} layout="vertical" margin={{ top: 0, right: 30, bottom: 0, left: 0 }} barSize={16}>
                    <XAxis type="number" hide />
                    <YAxis
                      type="category" dataKey="short" width={98} tickLine={false} axisLine={false}
                      tick={{ fontSize: 10, fill: '#6b7280' }}
                    />
                    <RechartsTooltip
                      {...TOOLTIP_STYLE}
                      formatter={(value: number | string) => `${value} resident${Number(value) === 1 ? '' : 's'}`}
                    />
                    <RechartsBar
                      dataKey="count" radius={[0, 4, 4, 0]} isAnimationActive={false}
                      label={{ position: 'right', fontSize: 10, fill: INK, fontWeight: 700 }}
                    >
                      {data.residents.byPhase.map((row, index) => (
                        <Cell key={row.phase} fill={PHASE_COLORS[index % PHASE_COLORS.length]} />
                      ))}
                    </RechartsBar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <Empty>No resident has a phase set.</Empty>
              )}
              <p className="mt-2 text-[10px] leading-relaxed text-gray-400">
                The case phase Child Records holds for each resident, in the order the phases run.
              </p>
            </div>

            {/* Behavioural status */}
            <div className="min-w-0 lg:border-l lg:border-gray-100 lg:pl-6">
              <GroupHeading label="By behavioral status" count={behavioralTotal} />
              <Donut
                rows={data?.residents.behavioral || []}
                colors={BEHAVIORAL_COLORS}
                unit="resident(s)"
                onPick={() => open(RESIDENTS_ACTIVE)}
              />
              <p className="mt-2 text-[10px] leading-relaxed text-gray-400">
                The rating on each resident's newest Finalized TRI, exactly as their Behavioral tab shows it.
              </p>
            </div>

            {/* Case type — a list, because its labels are free text */}
            <div className="min-w-0 lg:border-l lg:border-gray-100 lg:pl-6">
              <GroupHeading label="By case type" count={caseTypeTotal} />
              {data && data.residents.byCaseType.length > 0 ? (
                <BarList
                  rows={data.residents.byCaseType}
                  total={caseTypeTotal}
                  fill={ACCENT}
                  onPick={() => open(RESIDENTS_ACTIVE)}
                />
              ) : (
                <Empty>No resident has a case type set.</Empty>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* 5 ── SCHEDULE. Where the workload sits, then the feed itself. */}
      <Section
        icon={CalendarClock}
        title="Schedule Timeline"
        subtitle="Every dated commitment across the facility, read live — today, what is ahead, and what has been missed."
        action={
          data && (
            <div className="hidden shrink-0 flex-wrap items-center gap-1.5 md:flex">
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
        {/* Workload by kind */}
        <div className="mb-5 rounded-lg border border-gray-100 bg-gray-50/50 px-4 py-3.5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h4 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-500">
              <ChartColumn className="h-3 w-3" /> Workload by kind
            </h4>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {([
                ['Today', ACCENT],
                ['Ahead', INK],
                ['Overdue', '#dc2626'],
              ] as [string, string][]).map(([label, color]) => (
                <span key={label} className="flex items-center gap-1.5 text-[10px] font-medium text-gray-500">
                  <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: color }} />
                  {label}
                </span>
              ))}
            </div>
          </div>
          {loading && !data ? (
            <div className="h-[180px] animate-pulse rounded bg-gray-100" />
          ) : workload.length > 0 ? (
            <ResponsiveContainer width="100%" height={workload.length * 32 + 12}>
              <BarChart data={workload} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }} barSize={13}>
                <XAxis type="number" hide />
                <YAxis
                  type="category" dataKey="label" width={88} tickLine={false} axisLine={false}
                  tick={{ fontSize: 10, fill: '#6b7280' }}
                />
                <RechartsTooltip {...TOOLTIP_STYLE} />
                <RechartsBar dataKey="today" stackId="w" fill={ACCENT} name="Today" isAnimationActive={false} />
                <RechartsBar dataKey="ahead" stackId="w" fill={INK} name="Ahead" isAnimationActive={false} />
                <RechartsBar dataKey="overdue" stackId="w" fill="#dc2626" name="Overdue" isAnimationActive={false} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty>Nothing is on the calendar at all — no activity, assessment, hearing, intervention, visit or TRI deadline.</Empty>
          )}
        </div>

        {/* The feed, split three ways */}
        {loading && !data ? (
          <div className="grid gap-5 lg:grid-cols-3">
            {[0, 1, 2].map((n) => (
              <div key={n} className="space-y-2">
                <div className="h-4 w-24 animate-pulse rounded bg-gray-100" />
                {[0, 1, 2].map((m) => <div key={m} className="h-10 animate-pulse rounded-lg bg-gray-100" />)}
              </div>
            ))}
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Today */}
            <div className="min-w-0">
              <GroupHeading label="Today" count={data?.schedules.today.total} tone="warn" />
              {scheduleTable(todayItems, 6, <Empty>Nothing is booked for today.</Empty>)}
            </div>

            {/* Upcoming */}
            <div className="min-w-0 lg:border-l lg:border-gray-100 lg:pl-6">
              <GroupHeading label="Upcoming" count={aheadCount} tone="info" />
              {scheduleTable(upcomingItems, 8, <Empty>Nothing is booked ahead.</Empty>)}
              {aheadCount > Math.min(upcomingItems.length, 8) && (
                <p className="px-3 pt-1.5 text-[10px] text-gray-400">
                  showing {Math.min(upcomingItems.length, 8)} of {aheadCount}
                </p>
              )}
            </div>

            {/* Overdue */}
            <div className="min-w-0 lg:border-l lg:border-gray-100 lg:pl-6">
              <GroupHeading label="Overdue" count={data?.schedules.overdueCounts.total} tone="danger" />
              {scheduleTable(overdueItems, 8, <Clear>Nothing has been missed.</Clear>)}
              {data && data.schedules.overdueCounts.total > overdueItems.length && (
                <p className="px-3 pt-1.5 text-[10px] text-gray-400">
                  showing {Math.min(overdueItems.length, 8)} of {data.schedules.overdueCounts.total}
                </p>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* 6 ── Violations and admissions */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Section
          icon={Scale}
          title="Violations"
          subtitle="Incidents still on the books, by severity, and where each one stands."
          action={<SectionLink label="Open Violations" onClick={() => open('/violations')} />}
        >
          {data ? (
            <div className="space-y-5">
              <div>
                <GroupHeading label="Severity of the open cases" count={data.violations.open} />
                <Donut
                  rows={severityRows}
                  colors={SEVERITY_COLORS}
                  unit="case(s)"
                  onPick={() => open('/violations')}
                />
                <p className="mt-2 text-[10px] text-gray-400">
                  Resolved and Rejected incidents are excluded — these are the {data.violations.open} still live.
                </p>
              </div>

              <div className="border-t border-gray-100 pt-4">
                <GroupHeading label="Where each case stands" />
                <TableShell minWidth="320px">
                  <tbody className="divide-y divide-gray-100">
                    {violationBuckets.map((bucket) => (
                      <Tr key={bucket.label} onClick={() => open('/violations')}>
                        <Td className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[bucket.tone].dot}`} />
                            <span className="truncate">{bucket.label}</span>
                          </span>
                        </Td>
                        <Td className={`w-12 text-right font-bold tabular-nums ${bucket.count > 0 ? '' : 'text-gray-300'}`}>
                          {bucket.count}
                        </Td>
                      </Tr>
                    ))}
                    <Tr key="list-total" onClick={() => open('/violations')}>
                      <Td className="min-w-0 font-semibold" style={{ color: INK }}>
                        Violation List — neither pending nor rejected
                      </Td>
                      <Td className="w-12 text-right font-bold tabular-nums" style={{ color: INK }}>{data.violations.list}</Td>
                    </Tr>
                  </tbody>
                </TableShell>
              </div>
            </div>
          ) : (
            <Empty>Reading…</Empty>
          )}
        </Section>

        <Section
          icon={UserPlus}
          title="Admissions & Court"
          subtitle={`${data?.admissions.current ?? 0} open admission periods · ${data?.admissions.thisMonth ?? 0} opened and ${data?.discharges.thisMonth ?? 0} closed this month.`}
        >
          {data ? (
            <div className="space-y-5">
              <div>
                <GroupHeading label="Most recent admissions" count={data.admissions.recent.length} />
                {data.admissions.recent.length > 0 ? (
                  <TableShell minWidth="340px">
                    <tbody className="divide-y divide-gray-100">
                      {data.admissions.recent.map((row) => (
                        <Tr key={row.id} onClick={() => open(`/children/${row.residentId}?tab=personal`)}>
                          <Td className="min-w-0">
                            <span className="block truncate font-semibold" style={{ color: INK }}>
                              {row.residentName || row.admissionName || row.residentId}
                            </span>
                            <span className="block text-[10px] text-gray-400">Admission #{row.admissionNumber}</span>
                          </Td>
                          <Td className="w-[86px] text-right whitespace-nowrap text-[11px] text-gray-500">{shortDay(row.admissionDate)}</Td>
                          <GoCell />
                        </Tr>
                      ))}
                    </tbody>
                  </TableShell>
                ) : (
                  <Empty>No admissions recorded yet.</Empty>
                )}
              </div>

              <div className="border-t border-gray-100 pt-4">
                <GroupHeading
                  label="Court hearings"
                  count={data.hearings.upcoming + data.hearings.overdue}
                  tone={data.hearings.overdue ? 'danger' : 'muted'}
                />
                {data.hearings.upcomingRows.length + data.hearings.overdueRows.length > 0 ? (
                  <TableShell minWidth="380px">
                    <tbody className="divide-y divide-gray-100">
                      {[...data.hearings.overdueRows, ...data.hearings.upcomingRows].slice(0, 5).map((row) => (
                        <Tr
                          key={row.id}
                          onClick={() => open('/court-records?filter=Scheduled')}
                          title={`${row.courtName || 'Court'} · ${row.caseNumber || 'no case number'}`}
                        >
                          <Td className="min-w-0">
                            <span className="flex items-center gap-2">
                              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-50">
                                <Landmark className="h-3 w-3 text-amber-600" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[11px] font-semibold" style={{ color: INK }}>
                                  {row.residentName || row.residentId}
                                </span>
                                <span className="block truncate text-[10px] text-gray-400">
                                  {[row.hearingType, row.courtName, row.caseNumber].filter(Boolean).join(' · ') || 'Hearing'}
                                </span>
                              </span>
                            </span>
                          </Td>
                          <Td className="w-[92px] text-right whitespace-nowrap">
                            <span className="block text-[11px] font-semibold text-gray-600">{shortDay(row.hearingDate)}</span>
                            {row.daysOverdue ? (
                              <Pill tone="danger">{row.daysOverdue}d late</Pill>
                            ) : (
                              <span className="block text-[10px] text-gray-400">{row.hearingTime || '—'}</span>
                            )}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </TableShell>
                ) : (
                  <Clear>No hearing is scheduled and none is awaiting an outcome.</Clear>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2.5 border-t border-gray-100 pt-4">
                {([
                  ['On record', data.residents.total],
                  ['Discharged', data.residents.discharged],
                  ['Absconded', data.residents.absconded],
                ] as [string, number][]).map(([label, count]) => (
                  <div key={label} className="rounded-lg bg-gray-50 px-3 py-2">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</p>
                    <p className="mt-0.5 text-lg font-bold leading-none tabular-nums" style={{ color: INK }}>{count}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <Empty>Reading…</Empty>
          )}
        </Section>
      </div>

      {/* 7 ── TRI Statistics, reused exactly as the TRI module renders it. The
          rating bands are the instrument's own rule — re-deriving them here
          would be a second copy, which is how the two screens would come to
          disagree about a resident's rating. */}
      <TriStatistics refreshKey={data?.generatedAt} />

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
