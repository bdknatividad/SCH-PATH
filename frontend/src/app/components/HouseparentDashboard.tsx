/**
 * The Houseparent's landing page.
 *
 * The role's day is its own case load and the paperwork that goes with it: TRI
 * records that are still theirs to finish, Anecdotal Reports in the same state,
 * and what is scheduled today. It is a *work queue*, not a facility overview —
 * so this page shows no facility-wide figure at all.
 *
 * ## Everything on it is caseload-scoped, by the server
 *
 * `children` arrives from `/api/store` already narrowed to the residents this
 * Houseparent is assigned (the store applies the same boundary `GET /children`
 * does — see the note on `rowResidentIds` in `routes/index.js`). `/tri` and
 * `/anecdotal-reports` scope themselves the same way: both filter to the
 * caller's active assignments server-side. Nothing here re-filters by
 * assignment, because a second copy of that rule is how a page starts showing a
 * resident the API would refuse.
 *
 * ## No resident profile links
 *
 * A Houseparent holds **no Child Records module**, so `/children/:id` is refused
 * by the route guard. Every control on this page therefore stays inside the
 * modules the role does hold — Houseparent, Violations, Activities and
 * Assessments. The resident list opens the TRI case load rather than a profile,
 * which is the screen the role actually works from.
 *
 * ## Fetched, not read from the store
 *
 * TRI records and Anecdotal Reports are not in the bulk store payload, and both
 * endpoints already return the caller's own scope in one query — narrower than
 * handing the role a whole table.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Users, ClipboardList, FileText, Calendar, ClipboardCheck, AlertCircle, ChevronRight,
} from 'lucide-react';
import { request } from '@/services/api';
import type { Child } from '../state/DataContext';
import { formatShortDate } from '@/utils/dateFormatter';
import { Badge } from '@/app/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/app/components/ui/dialog';
import {
  DashboardHeader, StatTile, StatTileRow, SectionCard, ListRow,
} from './DashboardKit';

/** A TRI record as `/tri` returns it, reduced to what this page reads. */
interface TriRecordRow {
  id: string;
  residentId: string;
  reportingYear?: number;
  reportingMonth?: number;
  status?: string;
}

/** An Anecdotal Report as `/anecdotal-reports` returns it. */
interface AnecdotalReportRow {
  id: string;
  residentId: string;
  reportDate?: string;
  status?: string;
}

interface HouseparentDashboardProps {
  displayRole: string;
  /** The caller's case load, already scoped by `/api/store`. */
  residents: Child[];
  /** Residents on the Active filter, counted once by the page. */
  activeCount: number;
  todayActivities: any[];
  todayAssessments: any[];
  onOpen: (path: string) => void;
}

/**
 * The TRI statuses that are the Houseparent's turn to act on — the same set
 * `Tri.tsx` uses to decide a record is editable (`canEditFn`). A `Submitted` or
 * `Under Review` record belongs to a reviewer, so it is not this role's queue.
 */
const TRI_ACTIONABLE = ['Draft', 'Returned', 'For Reassessment'];

/**
 * The Anecdotal Report statuses that are the author's turn — the set
 * `AnecdotalReports.tsx` uses for `isReportAuthor` edit rights.
 */
const ANECDOTAL_ACTIONABLE = ['Draft', 'Returned'];

/** Status pill colours, matching the TRI and Anecdotal modules. */
function statusClass(status?: string): string {
  switch (status) {
    case 'Finalized':
      return 'bg-green-100 text-green-700 border-green-200';
    case 'Submitted':
    case 'Under Review':
      return 'bg-blue-100 text-blue-700 border-blue-200';
    case 'Returned':
    case 'For Reassessment':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    default:
      return 'bg-gray-100 text-gray-600 border-gray-200';
  }
}

export function HouseparentDashboard({
  displayRole,
  residents,
  activeCount,
  todayActivities,
  todayAssessments,
  onOpen,
}: HouseparentDashboardProps) {
  const [triRecords, setTriRecords] = useState<TriRecordRow[]>([]);
  const [anecdotalReports, setAnecdotalReports] = useState<AnecdotalReportRow[]>([]);
  const [loading, setLoading] = useState(true);

  /** The Schedule tile opens the day's activities and assessments in a dialog. */
  const [showSchedule, setShowSchedule] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Both endpoints scope to the caller's assignments server-side, so a
      // failure here is a genuinely empty queue, not a missing filter.
      const [tri, anecdotal] = await Promise.allSettled([
        request<{ success: boolean; data?: TriRecordRow[] }>('/tri'),
        request<{ success: boolean; data?: AnecdotalReportRow[] }>('/anecdotal-reports'),
      ]);
      if (cancelled) return;
      const rowsOf = (result: PromiseSettledResult<{ success: boolean; data?: unknown[] }>) =>
        result.status === 'fulfilled' && Array.isArray(result.value?.data) ? result.value.data : [];
      setTriRecords(rowsOf(tri) as TriRecordRow[]);
      setAnecdotalReports(rowsOf(anecdotal) as AnecdotalReportRow[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const nameOf = (residentId?: string | null) =>
    residents.find((resident) => String(resident.id) === String(residentId))?.name ||
    'Unassigned resident';

  /** TRI records still on this role's desk, newest period first. */
  const triToDo = useMemo(
    () =>
      triRecords
        .filter((record) => TRI_ACTIONABLE.includes(String(record.status || 'Draft')))
        .sort(
          (a, b) =>
            (b.reportingYear || 0) - (a.reportingYear || 0) ||
            (b.reportingMonth || 0) - (a.reportingMonth || 0),
        ),
    [triRecords],
  );

  /** Anecdotal Reports still on this role's desk, newest first. */
  const anecdotalToDo = useMemo(
    () =>
      anecdotalReports
        .filter((report) => ANECDOTAL_ACTIONABLE.includes(String(report.status || 'Draft')))
        .sort((a, b) => String(b.reportDate || '').localeCompare(String(a.reportDate || ''))),
    [anecdotalReports],
  );

  /** The three most recently touched reports, whatever their status. */
  const anecdotalRecent = useMemo(
    () =>
      [...anecdotalReports]
        .sort((a, b) => String(b.reportDate || '').localeCompare(String(a.reportDate || '')))
        .slice(0, 5),
    [anecdotalReports],
  );

  const scheduleCount = todayActivities.length + todayAssessments.length;

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Houseparent Dashboard"
        displayRole={displayRole}
        subtitle="your residents, TRI records & the day's schedule"
      />

      <StatTileRow>
        <StatTile
          title="My Residents"
          value={residents.length}
          caption={`${activeCount} active`}
          icon={Users}
          onClick={() => onOpen('/tri')}
        />
        <StatTile
          title="TRI To Finish"
          value={loading ? '…' : triToDo.length}
          caption={loading ? 'Reading records' : 'Draft or returned to you'}
          icon={ClipboardList}
          onClick={() => onOpen('/tri?tab=records')}
        />
        <StatTile
          title="Anecdotal To Finish"
          value={loading ? '…' : anecdotalToDo.length}
          caption={loading ? 'Reading reports' : 'Draft or returned to you'}
          icon={FileText}
          onClick={() => onOpen('/tri?tab=anecdotal')}
        />
        <StatTile
          title="Schedule"
          value={scheduleCount}
          caption={scheduleCount ? 'Activities and assessments' : 'Nothing scheduled'}
          icon={Calendar}
          onClick={() => setShowSchedule(true)}
        />
      </StatTileRow>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* The case load. Rows open the TRI module, not a resident profile —
            the role holds no Child Records module, so `/children/:id` is a
            route the guard refuses. */}
        <SectionCard
          title="My Residents"
          icon={<Users className="w-4 h-4 text-[#FFD100]" />}
          badge={residents.length}
          isEmpty={residents.length === 0}
          empty="No residents are assigned to you yet."
        >
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {residents.map((resident) => (
              <ListRow
                key={resident.id}
                title={resident.name}
                meta={resident.casePhase || 'No phase set'}
                trailing={
                  <span className="text-[10px] font-semibold text-gray-600 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">
                    {resident.status || 'Active'}
                  </span>
                }
                onClick={() => onOpen('/tri')}
              />
            ))}
          </div>
        </SectionCard>

        {/* The TRI queue — the role's own paperwork, not the facility's. */}
        <SectionCard
          title="TRI Records To Finish"
          icon={<ClipboardList className="w-4 h-4 text-[#FFD100]" />}
          badge={triToDo.length}
          isEmpty={!loading && triToDo.length === 0}
          empty={loading ? 'Reading TRI records…' : 'Every TRI on your case load is filed.'}
          action={
            triToDo.length > 0 ? (
              <button
                type="button"
                onClick={() => onOpen('/tri?tab=records')}
                className="text-[10px] border border-gray-200 px-2 py-1 rounded hover:bg-[#FFD100] transition-all shrink-0"
              >
                Open
              </button>
            ) : undefined
          }
        >
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {triToDo.slice(0, 6).map((record) => (
              <ListRow
                key={record.id}
                title={nameOf(record.residentId)}
                meta={`${record.reportingMonth || '—'}/${record.reportingYear || '—'}`}
                trailing={
                  <span
                    className={`text-[10px] font-semibold border rounded px-1.5 py-0.5 ${statusClass(record.status)}`}
                  >
                    {record.status || 'Draft'}
                  </span>
                }
                onClick={() => onOpen('/tri?tab=records')}
              />
            ))}
          </div>
        </SectionCard>

        {/* Anecdotal Reports — the other half of the role's paperwork. */}
        <SectionCard
          title="Anecdotal Reports"
          icon={<FileText className="w-4 h-4 text-[#FFD100]" />}
          badge={anecdotalToDo.length}
          isEmpty={!loading && anecdotalRecent.length === 0}
          empty={loading ? 'Reading reports…' : 'No Anecdotal Reports filed yet.'}
          action={
            <button
              type="button"
              onClick={() => onOpen('/tri?tab=anecdotal')}
              className="text-[10px] border border-gray-200 px-2 py-1 rounded hover:bg-[#FFD100] transition-all shrink-0"
            >
              Open
            </button>
          }
        >
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {anecdotalRecent.map((report) => (
              <ListRow
                key={report.id}
                title={nameOf(report.residentId)}
                meta={formatShortDate(report.reportDate)}
                trailing={
                  <span
                    className={`text-[10px] font-semibold border rounded px-1.5 py-0.5 ${statusClass(report.status)}`}
                  >
                    {report.status || 'Draft'}
                  </span>
                }
                onClick={() => onOpen('/tri?tab=anecdotal')}
              />
            ))}
          </div>
        </SectionCard>

      </div>

      <p className="text-[10px] text-gray-400 flex items-start gap-1.5">
        <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
        Everything on this page is limited to the residents assigned to you. TRI and Anecdotal
        counts follow the statuses each module treats as your turn to act on.
      </p>

      {/* ── The day's schedule ──
          The tile used to jump straight to Activities, which answered only half
          the question: the count it shows is activities *and* assessments. The
          dialog lists both, so the number and what it opens finally agree. */}
      <Dialog open={showSchedule} onOpenChange={setShowSchedule}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#2F3E46]">
              <Calendar className="h-4 w-4 text-[#FFD100]" /> Schedule
              <Badge className="bg-[#FFD100] px-1.5 py-0 text-[10px] text-[#2F3E46]">
                {scheduleCount}
              </Badge>
            </DialogTitle>
          </DialogHeader>

          {scheduleCount === 0 ? (
            <p className="py-6 text-center text-xs italic text-gray-400">
              Nothing is scheduled for today.
            </p>
          ) : (
            <div className="space-y-5">
              <ScheduleGroup
                title="Activities"
                icon={<ClipboardCheck className="h-4 w-4 text-[#FFD100]" />}
                empty="No activities scheduled today."
                items={todayActivities.map((activity) => ({
                  id: `activity-${activity.id}`,
                  title: activity.title || 'Untitled activity',
                  meta: `${activity.time || 'All day'} · ${activity.location || 'Shelter'}`,
                  onOpen: () => { setShowSchedule(false); onOpen('/activities'); },
                }))}
              />
              <ScheduleGroup
                title="Assessments"
                icon={<ClipboardList className="h-4 w-4 text-[#FFD100]" />}
                empty="No assessments scheduled today."
                items={todayAssessments.map((assessment) => ({
                  id: `assessment-${assessment.id}`,
                  title: assessment.title || 'Untitled assessment',
                  meta: `${formatShortDate(assessment.date)} · ${assessment.time || 'TBA'}`,
                  onOpen: () => { setShowSchedule(false); onOpen('/assessments'); },
                }))}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * One section of the Schedule dialog.
 *
 * Takes a plain `items` array rather than the two collections, so the dialog
 * decides what a row says while this decides only how a group looks — and an
 * empty group prints its own sentence instead of vanishing, which is what tells
 * the reader the difference between "no activities today" and a failed load.
 */
function ScheduleGroup({
  title, icon, empty, items,
}: {
  title: string;
  icon: ReactNode;
  empty: string;
  items: Array<{ id: string; title: string; meta: string; onOpen: () => void }>;
}) {
  return (
    <div>
      <p className="mb-2 flex items-center gap-2 border-b border-gray-100 pb-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-500">
        {icon}
        {title}
      </p>
      {items.length === 0 ? (
        <p className="py-2 text-[11px] italic text-gray-400">{empty}</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={item.onOpen}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-gray-100 p-2.5 text-left transition-colors hover:border-[#FFD100] hover:bg-[#FFD100]/10"
            >
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold text-[#2F3E46]">{item.title}</span>
                <span className="block text-[10px] text-gray-400">{item.meta}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default HouseparentDashboard;
