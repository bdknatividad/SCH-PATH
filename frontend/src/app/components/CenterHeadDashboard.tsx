/**
 * The Center Head's command centre.
 *
 * ## What this page is
 *
 * A month-scoped operational summary: three counters, two distributions, what is
 * coming up next, and the two review queues. Everything is read from
 * `GET /dashboard/center-head` — one request, answered from the live tables —
 * and nothing is derived from the browser's cached store, because a record filed
 * by any other member of staff has to be visible here without a re-login.
 *
 * ## The period selector drives the query, not the screen
 *
 * "View Statistics As Of" sends `?period=YYYY-MM` and the **server** re-runs
 * every statistic against that month. Filtering already-loaded rows in the
 * browser would have been cheaper to write and wrong: it could only re-cut the
 * residents the store happens to hold, and it would silently disagree with the
 * module the tile opens.
 *
 * The period deliberately does **not** move "today". The schedule feed answers
 * "what is coming up next", which is a question about now — re-basing it on a
 * past month would hide commitments that are still ahead of the facility. So the
 * counters follow the month you pick and the schedule column does not.
 *
 * ## Where a number comes from
 *
 * Each counter reuses the definition of the module it opens, server-side, so a
 * tile cannot disagree with the screen behind it:
 *
 *   Total Active Residents   Child Records **Active** filter, evaluated over the month
 *   Active Violations        the Violation List's **Reviewed** status bucket
 *   Discharged Residents     Child Records **Discharged** filter, closed in the month
 *   Rehabilitation phase     the same population, split by `casePhase`
 *   Behavioural status       the Finalized TRI for that month, by rating band
 *   Documents / Reports      the live review queues, counted once, server-side
 *
 * ## What is deliberately not clickable
 *
 * The phase and behavioural bars are display-only. Child Records has filters for
 * status only — Active / Discharged / Absconded — and there is no resident list
 * filtered by phase or by rating anywhere in the system. Pointing those bars at
 * `/children` would land the reader on an unrelated screen, which is worse than
 * a bar that does not pretend to be a link.
 *
 * ## Why there is no charting library here
 *
 * Both distributions are drawn with CSS widths rather than recharts. The shapes
 * are bar lists, which is what recharts was being asked for anyway, and dropping
 * it takes this chunk from ~447 kB to a fraction of that for every role that can
 * reach the page. Recharts is off the critical path entirely now.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users, ShieldAlert, UserMinus, Calendar, FileText, ClipboardCheck,
  RefreshCw, Loader2, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Badge } from '@/app/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/app/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/app/components/ui/select';
import { request } from '@/services/api';
import { formatShortDate } from '@/utils/dateFormatter';

// ── PAYLOAD ─────────────────────────────────────────────────────────────────

/** A resident as the breakdown lists name them. */
interface ResidentRef {
  id: string;
  name: string;
}

interface PhaseRow {
  phase: string;
  short: string;
  count: number;
  /** Who the bar is made of — the same rows the count was taken from. */
  residents: ResidentRef[];
}

interface BehavioralRow {
  label: string;
  count: number;
  residents: ResidentRef[];
}

interface ScheduleItem {
  kind: string;
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
}

interface Overview {
  today: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  residents: {
    active: number;
    discharged: number;
    absconded: number;
    total: number;
    byPhase: PhaseRow[];
    behavioral: BehavioralRow[];
  };
  violations: { active: number; reviewed: number; list: number; overdue: number; resolved: number };
  documents: { count: number };
  reports: {
    anecdotal: { count: number };
    quarterly: { count: number };
    tri: { count: number };
    education: { count: number };
    incidentPending: number;
    total: number;
  };
  schedules: { upcoming: ScheduleItem[] };
}

// ── PERIOD HELPERS ──────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * The facility's current month, `YYYY-MM`.
 *
 * Built from an `en-CA` day string rather than `toISOString()`, which is UTC and
 * therefore still *yesterday* — and, on the first of a month, still last month —
 * for the first eight hours of every Philippine day. `Intl` with an explicit
 * `Asia/Manila` zone is the same rule the server applies in `manilaToday()`.
 */
function currentPeriod(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).slice(0, 7);
}

/** `2026-09` → `September 2026`. */
function periodLabel(period: string): string {
  const [year, month] = String(period).split('-').map(Number);
  if (!year || !month) return period;
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** Step a `YYYY-MM` period by whole months. */
function shiftPeriod(period: string, months: number): string {
  const [year, month] = String(period).split('-').map(Number);
  const zeroBased = (year * 12) + (month - 1) + months;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = (zeroBased % 12) + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
}

/** The rating bands, and the colour each one carries everywhere in the app. */
const BEHAVIORAL_STYLE: Record<string, string> = {
  'Needs Improvement': 'bg-red-500',
  Fair: 'bg-orange-400',
  Good: 'bg-blue-500',
  'Very Good': 'bg-green-500',
  Unscored: 'bg-gray-300',
};

// ── COMPONENT ───────────────────────────────────────────────────────────────

export function CenterHeadDashboard({ displayRole }: { displayRole?: string }) {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(currentPeriod);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * The resident breakdown behind one bar.
   *
   * Held as the residents the server returned with that bar, not recomputed
   * here: the bar's count and this list come from the same query, so they cannot
   * disagree — which is the whole reason the server sends the names rather than
   * the client matching a phase against the store it happens to hold.
   */
  const [breakdown, setBreakdown] = useState<
    { title: string; note: string; residents: ResidentRef[] } | null
  >(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = (requestId.current += 1);
    setLoading(true);
    setError(null);
    try {
      const result = await request<{ success: boolean; data?: Overview }>(
        `/dashboard/center-head?period=${encodeURIComponent(period)}`,
      );
      // A slower earlier request must not overwrite a newer one — the reader
      // would be looking at August's numbers under September's label.
      if (id !== requestId.current) return;
      setData(result?.data || null);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : 'Unable to load the dashboard.');
      setData(null);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  // Keep the page current without a reload, but only for the live month: a past
  // month is settled data and re-reading it every minute is noise.
  useEffect(() => {
    const onFocus = () => { if (period === currentPeriod()) load(); };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(onFocus, 60000);
    return () => { window.removeEventListener('focus', onFocus); window.clearInterval(timer); };
  }, [load, period]);

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

  const currentYear = Number(currentPeriod().slice(0, 4));
  const years = useMemo(
    () => Array.from({ length: 8 }, (_, index) => currentYear - 6 + index),
    [currentYear],
  );
  const isCurrent = period === currentPeriod();

  /** The three schedule columns the template names, in its own order. */
  const scheduleColumns = useMemo(() => {
    const upcoming = data?.schedules?.upcoming || [];
    return [
      { key: 'activity', label: 'Activities', items: upcoming.filter((item) => item.kind === 'activity') },
      { key: 'assessment', label: 'Assessments', items: upcoming.filter((item) => item.kind === 'assessment') },
      { key: 'hearing', label: 'Hearing', items: upcoming.filter((item) => item.kind === 'hearing') },
    ];
  }, [data]);

  const behavioralTotal = (data?.residents?.behavioral || []).reduce((sum, row) => sum + row.count, 0);
  const phaseTotal = (data?.residents?.byPhase || []).reduce((sum, row) => sum + row.count, 0);

  /** `'…'` while a period is in flight, so no stale figure is ever on screen. */
  const figure = (value: number | undefined) => (loading ? '…' : String(value ?? 0));

  const share = (count: number, total: number) =>
    total > 0 ? `${Math.round((count / total) * 100)}%` : '0%';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header — identity on the left, the period control on the right. */}
      <div className="bg-[#2F3E46] p-5 sm:p-6 rounded-xl shadow-md border-b-4 border-[#FFD100]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-xl sm:text-2xl font-bold mb-1 text-white">Center Head Dashboard</h2>
            <p className="text-sm text-gray-300">
              Welcome back,{' '}
              <span className="font-bold text-[#FFD100] uppercase">{displayRole || 'CENTER HEAD'}</span>
            </p>
          </div>

          {/* View Statistics As Of / Period */}
          <div className="shrink-0">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#FFD100]">
              View Statistics As Of / Period
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setPeriod((value) => shiftPeriod(value, -1))}
                aria-label="Previous month"
                className="flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white transition-colors hover:bg-white/20"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>

              <Select
                value={String(Number(period.slice(5, 7)))}
                onValueChange={(month) => setPeriod(`${period.slice(0, 4)}-${String(month).padStart(2, '0')}`)}
              >
                <SelectTrigger className="h-9 w-[132px] bg-white text-[#2F3E46]" aria-label="Month">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTH_NAMES.map((name, index) => (
                    <SelectItem key={name} value={String(index + 1)}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={period.slice(0, 4)}
                onValueChange={(year) => setPeriod(`${year}-${period.slice(5, 7)}`)}
              >
                <SelectTrigger className="h-9 w-[92px] bg-white text-[#2F3E46]" aria-label="Year">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map((year) => (
                    <SelectItem key={year} value={String(year)}>{year}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <button
                type="button"
                onClick={() => setPeriod((value) => shiftPeriod(value, 1))}
                aria-label="Next month"
                className="flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white transition-colors hover:bg-white/20"
              >
                <ChevronRight className="h-4 w-4" />
              </button>

              {!isCurrent && (
                <button
                  type="button"
                  onClick={() => setPeriod(currentPeriod())}
                  className="h-9 rounded-md bg-[#FFD100] px-3 text-xs font-bold text-[#2F3E46] transition-opacity hover:opacity-90"
                >
                  Current
                </button>
              )}

              <button
                type="button"
                onClick={load}
                disabled={loading}
                aria-label="Refresh"
                className="flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white transition-colors hover:bg-white/20 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-2 text-right text-[10px] text-gray-400">
              {isCurrent ? 'Current' : periodLabel(period)}
              {data?.periodStart && !isCurrent ? ` · ${data.periodStart} to ${data.periodEnd}` : ''}
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── Three counters ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          title="Total Active Residents"
          value={figure(data?.residents.active)}
          caption={isCurrent ? 'In the facility now' : `In the facility during ${periodLabel(period)}`}
          icon={Users}
          onClick={() => open('/children?filter=Active')}
        />
        <StatCard
          title="Active Violations"
          value={figure(data?.violations.active)}
          caption="Reviewed, from the Violation List"
          icon={ShieldAlert}
          onClick={() => open('/violations?tab=list&status=Reviewed')}
        />
        <StatCard
          title="Discharged Residents"
          value={figure(data?.residents.discharged)}
          caption={isCurrent ? 'Cases closed this month' : `Cases closed in ${periodLabel(period)}`}
          icon={UserMinus}
          onClick={() => open('/children?filter=Discharged')}
        />
      </div>

      {/* ── Two distributions ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="border-none shadow-sm">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-bold text-[#2F3E46]">
              <Calendar className="h-4 w-4 text-[#FFD100]" /> Residents by Rehabilitation Phase
            </CardTitle>
            <p className="mt-1 text-[11px] text-gray-500">
              {isCurrent ? 'Residents in the facility now' : `Residents present during ${periodLabel(period)}`}.
            </p>
          </CardHeader>
          <CardContent className="pt-4">
            {loading ? (
              <p className="py-4 text-center text-xs text-gray-400">Loading…</p>
            ) : (data?.residents.byPhase || []).length === 0 ? (
              <p className="py-4 text-center text-xs italic text-gray-400">
                No residents were present in this period.
              </p>
            ) : (
              <div className="space-y-2">
                {data!.residents.byPhase.map((row) => (
                  <BarRow
                    key={row.phase || row.short}
                    label={row.short}
                    fullLabel={row.phase}
                    count={row.count}
                    percent={share(row.count, phaseTotal)}
                    barClass="bg-[#2F3E46]"
                    onOpen={() => setBreakdown({
                      title: row.short,
                      note: `In ${row.phase || 'no phase'} during ${periodLabel(period)}`,
                      residents: row.residents,
                    })}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-bold text-[#2F3E46]">
              <ClipboardCheck className="h-4 w-4 text-[#FFD100]" /> Behavioral Status
            </CardTitle>
            <p className="mt-1 text-[11px] text-gray-500">
              Based on finalized TRI results for {periodLabel(period)}.
            </p>
          </CardHeader>
          <CardContent className="pt-4">
            {loading ? (
              <p className="py-4 text-center text-xs text-gray-400">Loading…</p>
            ) : behavioralTotal === 0 ? (
              <p className="py-4 text-center text-xs italic text-gray-400">
                No residents were present in this period.
              </p>
            ) : (
              <div className="space-y-2">
                {(data?.residents.behavioral || []).map((row) => (
                  <BarRow
                    key={row.label}
                    label={row.label}
                    count={row.count}
                    percent={share(row.count, behavioralTotal)}
                    barClass={BEHAVIORAL_STYLE[row.label] || 'bg-gray-400'}
                    onOpen={() => setBreakdown({
                      title: row.label,
                      note: `Behavioural status for ${periodLabel(period)}, from finalized TRI results`,
                      residents: row.residents,
                    })}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Upcoming schedules ── */}
      <Card className="border-none shadow-sm">
        <CardHeader className="border-b border-gray-100 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-bold text-[#2F3E46]">
            <Calendar className="h-4 w-4 text-[#FFD100]" /> Upcoming Schedules
          </CardTitle>
          <p className="mt-1 text-[11px] text-gray-500">
            The next commitments from today — the period above does not filter this list.
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {scheduleColumns.map((column) => (
              <div key={column.key}>
                <p className="mb-2 border-b border-gray-100 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                  {column.label}
                </p>
                {column.items.length === 0 ? (
                  <p className="py-3 text-[11px] italic text-gray-400">Nothing scheduled.</p>
                ) : (
                  <div className="space-y-2">
                    {column.items.slice(0, 5).map((item) => (
                      <button
                        key={`${item.kind}-${item.id}`}
                        type="button"
                        onClick={() => open(scheduleRoute(item))}
                        className="w-full rounded-lg border border-gray-100 p-2.5 text-left transition-colors hover:border-[#FFD100] hover:bg-[#FFD100]/10"
                      >
                        <p className="text-[11px] font-bold text-[#2F3E46]">
                          {formatShortDate(item.date)}
                          {item.time ? ` · ${item.time}` : ''}
                        </p>
                        <p className="truncate text-xs text-gray-600" title={item.title}>
                          {item.title}
                        </p>
                        {item.residentName && (
                          <p className="truncate text-[10px] text-gray-400">{item.residentName}</p>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Two review queues ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatCard
          title="Documents Needing Review"
          value={figure(data?.documents.count)}
          caption="Open Documents → Pending Review"
          icon={FileText}
          onClick={() => open('/documents?tab=pending')}
        />
        <StatCard
          title="Reports Needing Review"
          value={figure(data?.reports.total)}
          caption="Open Reports → Needs Review"
          icon={ClipboardCheck}
          onClick={() => open('/reports?tab=review')}
        />
      </div>

      <p className="text-[10px] text-gray-400">
        Read from the live database{data?.generatedAt ? ` at ${new Date(data.generatedAt).toLocaleTimeString()}` : ''}.
        The two review queues are counted as they stand now — they are what the Pending Review and Needs
        Review screens will show you. Click any bar to see the residents behind it.
      </p>

      {/* ── The residents behind a bar ── */}
      <Dialog open={breakdown !== null} onOpenChange={(next) => { if (!next) setBreakdown(null); }}>
        <DialogContent className="max-h-[80vh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#2F3E46]">
              <Users className="h-4 w-4 text-[#FFD100]" />
              {breakdown?.title}
              {breakdown && (
                <Badge className="bg-[#FFD100] text-[#2F3E46] px-1.5 py-0 text-[10px]">
                  {breakdown.residents.length}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>

          {breakdown && (
            <>
              <p className="text-[11px] text-gray-500">{breakdown.note}</p>
              {breakdown.residents.length === 0 ? (
                <p className="py-4 text-center text-xs italic text-gray-400">
                  No residents in this group for the selected period.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {breakdown.residents.map((resident) => (
                    <button
                      key={resident.id}
                      type="button"
                      onClick={() => {
                        setBreakdown(null);
                        open(`/children/${resident.id}`);
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-gray-100 p-2.5 text-left transition-colors hover:border-[#FFD100] hover:bg-[#FFD100]/10"
                    >
                      <span className="truncate text-xs font-semibold text-[#2F3E46]">{resident.name}</span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One counter. The whole card is the tap target. */
function StatCard({
  title, value, caption, icon: Icon, onClick,
}: {
  title: string;
  value: string;
  caption: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
}) {
  return (
    <Card
      className="cursor-pointer border-none shadow-sm transition-all hover:shadow-md hover:ring-2 hover:ring-[#FFD100] active:scale-95"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{title}</p>
            <p className="mt-1 text-3xl font-bold text-[#2F3E46]">{value}</p>
            <p className="mt-0.5 text-[10px] text-gray-400">{caption}</p>
          </div>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#FFD100]/20">
            <Icon className="h-5 w-5 text-[#2F3E46]" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One bar in a distribution.
 *
 * A **button** rather than a div whenever there is a breakdown to show, because
 * hover alone would leave the residents unreachable on every phone and tablet —
 * and the row is a far larger tap target than the bar itself. An empty band stays
 * a plain div: there is nothing behind it, and a control that opens an empty
 * dialog is worse than one that does not respond.
 */
function BarRow({
  label, fullLabel, count, percent, barClass, onOpen,
}: {
  label: string;
  fullLabel?: string;
  count: number;
  percent: string;
  barClass: string;
  onOpen: () => void;
}) {
  const interactive = count > 0;
  const Wrapper = interactive ? 'button' : 'div';

  return (
    <Wrapper
      type={interactive ? 'button' : undefined}
      onClick={interactive ? onOpen : undefined}
      aria-label={interactive ? `${label}: ${count} residents. Show the list.` : undefined}
      className={`flex w-full items-center gap-3 rounded-lg px-1.5 py-1 text-left ${
        interactive ? 'transition-colors hover:bg-[#FFD100]/15' : ''
      }`}
    >
      <span
        className={`w-28 shrink-0 truncate text-xs sm:w-32 ${interactive ? 'font-medium text-[#2F3E46]' : 'text-gray-600'}`}
        title={fullLabel || label}
      >
        {label}
      </span>
      <div className="h-5 flex-1 overflow-hidden rounded-full bg-gray-100">
        <div className={`h-full rounded-full transition-all ${barClass}`} style={{ width: percent }} />
      </div>
      <span className="w-8 text-right text-xs font-bold text-[#2F3E46]">{count}</span>
    </Wrapper>
  );
}

export default CenterHeadDashboard;
