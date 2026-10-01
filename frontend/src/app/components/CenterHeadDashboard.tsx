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
 *   Total Active Residents   Child Records **Active** filter, read at the end of the month
 *                            (so a resident discharged during the month is not counted)
 *   Active Violations        the Violation List's **Reviewed** status bucket
 *   Discharged Residents     Child Records **Discharged** filter, closed in the month
 *   Rehabilitation phase     the same population, split by `casePhase`
 *   Behavioural status       the Finalized TRI for that month, by rating band
 *   Documents / Reports      the live review queues, counted once, server-side
 *
 * ## The bars open the residents behind them
 *
 * Both distributions are drawn by `DistributionCard` (`DashboardKit`), which is
 * also what the Social Worker's page uses, so the two pages cannot drift into
 * two different-looking charts of the same thing. Clicking a bar opens the
 * residents it is made of; clicking a resident opens their profile. Pointing a
 * bar at `/children` would land the reader on an unrelated screen, which is why
 * the bar carries the list itself rather than a link.
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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/app/components/ui/select';
import { request } from '@/services/api';
import { formatShortDate } from '@/utils/dateFormatter';
import {
  DistributionCard, BEHAVIORAL_BAR, type DistributionRow,
} from './DashboardKit';

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
  /** The period has not happened yet — the statistics are empty by design. */
  periodIsFuture: boolean;
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


// ── COMPONENT ───────────────────────────────────────────────────────────────

export function CenterHeadDashboard({ displayRole }: { displayRole?: string }) {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(currentPeriod);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  /**
   * A month that has not happened yet has nothing to report.
   *
   * The server empties the statistics and flags it, because it owns the facility's
   * calendar — a browser re-deriving "which month is it" from its own clock can be
   * a day out. This only explains the empty figures; without the sentence, three
   * zeros and two empty charts read as a broken page rather than an answer.
   */
  const periodIsFuture = Boolean(data?.periodIsFuture);
  const futureNote = 'This month hasn’t happened yet — there is nothing to report for it.';

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

  /**
   * The two distributions, in the shape the shared card draws.
   *
   * Built from the rows the server returned — including the residents behind
   * each bar — so a bar's count and the list its click opens come from the same
   * query and cannot drift apart.
   *
   * The behavioural bands are dropped entirely when nobody is in them: the
   * server always sends all five so the bars keep their places month to month,
   * but five zero bars with nothing behind them would read as a broken page
   * rather than an empty month.
   */
  const phaseRows: DistributionRow[] = (data?.residents.byPhase || []).map((row) => ({
    key: row.phase || row.short,
    label: row.short,
    fullLabel: row.phase,
    count: row.count,
    barClass: 'bg-[#2F3E46]',
    residents: row.residents,
    dialogTitle: row.short,
    dialogNote: `In ${row.phase || 'no phase'} during ${periodLabel(period)}`,
  }));

  const behavioralRows: DistributionRow[] = behavioralTotal === 0
    ? []
    : (data?.residents.behavioral || []).map((row) => ({
        key: row.label,
        label: row.label,
        count: row.count,
        barClass: BEHAVIORAL_BAR[row.label] || 'bg-gray-400',
        residents: row.residents,
        dialogTitle: row.label,
        dialogNote: `Behavioural status for ${periodLabel(period)}, from finalized TRI results`,
      }));

  /** `'…'` while a period is in flight, so no stale figure is ever on screen. */
  const figure = (value: number | undefined) => (loading ? '…' : String(value ?? 0));

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
          caption={
            periodIsFuture
              ? 'Nothing to report yet'
              : isCurrent
                ? 'In the facility now'
                : `Still in the facility at the end of ${periodLabel(period)}`
          }
          icon={Users}
          onClick={() => open('/children?filter=Active')}
        />
        <StatCard
          title="Active Violations"
          value={figure(data?.violations.active)}
          caption={periodIsFuture ? 'Nothing to report yet' : 'Reviewed, from the Violation List'}
          icon={ShieldAlert}
          onClick={() => open('/violations?tab=list&status=Reviewed')}
        />
        <StatCard
          title="Discharged Residents"
          value={figure(data?.residents.discharged)}
          caption={
            periodIsFuture
              ? 'Nothing to report yet'
              : isCurrent
                ? 'Cases closed this month'
                : `Cases closed in ${periodLabel(period)}`
          }
          icon={UserMinus}
          onClick={() => open('/children?filter=Discharged')}
        />
      </div>

      {/* Why the three tiles and both charts are empty. A future month has no
          facts, and without this sentence the zeros read as a broken page. */}
      {periodIsFuture && !loading && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          {futureNote} Pick this month once it arrives, or choose an earlier one.
        </div>
      )}

      {/* ── Two distributions ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DistributionCard
          title="Residents by Rehabilitation Phase"
          icon={<Calendar className="h-4 w-4 text-[#FFD100]" />}
          caption={
            periodIsFuture
              ? 'Nothing to report yet.'
              : isCurrent
                ? 'Residents in the facility now.'
                : `Residents still in the facility at the end of ${periodLabel(period)}.`
          }
          rows={phaseRows}
          total={phaseTotal}
          loading={loading}
          empty={periodIsFuture ? futureNote : 'No residents were present in this period.'}
          onOpenResident={(id) => open(`/children/${id}`)}
        />

        <DistributionCard
          title="Behavioral Status"
          icon={<ClipboardCheck className="h-4 w-4 text-[#FFD100]" />}
          caption={
            periodIsFuture
              ? 'Nothing to report yet.'
              : `Based on finalized TRI results for ${periodLabel(period)}.`
          }
          rows={behavioralRows}
          total={behavioralTotal}
          loading={loading}
          empty={periodIsFuture ? futureNote : 'No residents were present in this period.'}
          onOpenResident={(id) => open(`/children/${id}`)}
        />
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

export default CenterHeadDashboard;
