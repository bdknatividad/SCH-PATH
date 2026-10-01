/**
 * The Social Worker's landing page.
 *
 * The role carries cases across every module the facility has — Child Records,
 * Violations and their interventions, Court Records, Documents and Reports — so
 * its dashboard is a *work queue* rather than a facility overview: what is
 * missing from a case file, what is waiting on a review decision, which
 * violation is still unverified, and which hearing is next.
 *
 * It is a separate component rather than the shared dashboard with sections
 * hidden. Hiding is the fragile option — every widget added to the shared page
 * afterwards has to remember to exclude this role, and one missed `hasModule()`
 * brings an unrelated statistic back.
 *
 * ## Every figure is derived once, by the page
 *
 * Nothing here recounts a collection. `activeCount`, `pendingApprovals`,
 * `missingDocuments`, `upcomingHearings` and `phases` are computed in
 * `Dashboard.tsx` from the same predicates the rest of the application already
 * uses, and passed in. That is deliberate: "Docs Pending" on this page and the
 * Documents module's badge are the same queue, and the two came apart once
 * already when each counted it its own way (see `utils/pendingDocuments.ts`). A
 * second copy of a rule is how a tile starts disagreeing with the screen it
 * opens.
 *
 * ## The two distributions are the command centre's, drawn once
 *
 * "Residents by Rehabilitation Phase" and "Behavioral Status" are the two cards
 * the Center Head's page carries, and both pages render the same
 * `DistributionCard` — one component, so the two cannot drift into
 * different-looking charts of the same thing. Each bar opens the residents it is
 * made of; each resident opens their profile.
 *
 * The two pages source them differently, and that difference is real:
 *
 *  - The command centre reads both from `GET /dashboard/center-head`, scoped to
 *    the month its period selector names — a **finalized TRI for that month**.
 *  - This page has no period selector, so Behavioral Status reads
 *    `GET /tri/monitor`, the rating of each resident's **most recent** finalized
 *    TRI. That is the same reading as the TRI Statistics card below it, which is
 *    the point: the two cannot disagree.
 *
 * ## Links
 *
 * The role holds Child Records, Violations, Court Records, Activities,
 * Assessments and Documents, so every path below is one it can open. A control
 * pointing into a module the role does not hold is a dead control — it
 * type-checks, and the click is silently refused by the route guard.
 */

import {
  Briefcase, FolderOpen, ShieldAlert, Gavel, ClipboardCheck, Calendar, ArrowRight,
  TrendingUp,
} from 'lucide-react';
import type { Child, CourtRecord, Violation } from '../state/DataContext';
import { formatShortDate } from '@/utils/dateFormatter';
import { TriStatistics, useTriMonitor } from './TriStatistics';
import {
  DashboardHeader, StatTile, StatTileRow, SectionCard, EmptyState, ListRow,
  DistributionCard, BEHAVIORAL_BAR, BEHAVIORAL_BANDS, type DistributionRow, type ResidentRef,
} from './DashboardKit';

interface MissingDocumentsEntry {
  child: Child;
  phase: string;
  missing: string[];
  pending: string[];
}

interface SocialWorkerDashboardProps {
  displayRole: string;
  /** Every resident the caller can see. Used for name lookups only. */
  residents: Child[];
  /** Residents on the Active filter, counted once by the page. */
  activeCount: number;
  /** Documents in a pre-decision state, for residents who are still active. */
  pendingApprovals: any[];
  /** Active residents missing, or awaiting, a required phase document. */
  missingDocuments: MissingDocumentsEntry[];
  violations: Violation[];
  /** Scheduled hearings dated today or later. */
  upcomingHearings: CourtRecord[];
  /** Active residents per rehabilitation phase, with the residents behind each. */
  phases: Array<{ short: string; count: number; residents: ResidentRef[] }>;
  /** Assessments still on the Scheduled status. */
  pendingAssessments: Array<{ id: string; title?: string; type?: string; date?: string; time?: string }>;
  todayActivities: any[];
  todayAssessments: any[];
  onOpen: (path: string) => void;
}

/** The four ratings a finalized TRI can carry. Anything else is `Unscored`. */
const SCORED_BANDS = ['Very Good', 'Good', 'Fair', 'Needs Improvement'];

export function SocialWorkerDashboard({
  displayRole,
  residents,
  activeCount,
  pendingApprovals,
  missingDocuments,
  violations,
  upcomingHearings,
  phases,
  pendingAssessments,
  todayActivities,
  todayAssessments,
  onOpen,
}: SocialWorkerDashboardProps) {
  /**
   * The TRI rows behind Behavioral Status, loaded here rather than inside the
   * TRI Statistics card so the page makes one request and both cards read the
   * same rows.
   */
  const triMonitor = useTriMonitor();
  const triRows = triMonitor.rows || [];

  const nameOf = (residentId?: string | null) =>
    residents.find((resident) => String(resident.id) === String(residentId))?.name ||
    'Unlinked resident';

  /**
   * The verification queue, by the Violations module's own definition: the "For
   * Verification" tab lists records whose status is exactly `Pending Review`
   * (`Violations.tsx`). Counting anything else here would open a tab that
   * disagrees with the tile that sent you to it.
   */
  const forVerification = violations.filter((violation) => violation.status === 'Pending Review');

  const scheduleCount = todayActivities.length + todayAssessments.length;

  /** The phase bars, in the shape the shared card draws. */
  const phaseRows: DistributionRow[] = phases.map((phase) => ({
    key: phase.short,
    label: phase.short,
    fullLabel: phase.short,
    count: phase.count,
    barClass: 'bg-[#2F3E46]',
    residents: phase.residents,
    dialogTitle: phase.short,
    dialogNote: phase.short === 'Unassigned'
      ? 'Active residents with no rehabilitation phase set.'
      : `Active residents in the ${phase.short} phase.`,
  }));

  /**
   * The behavioural bars: one per band, in the order every screen draws them,
   * built from the same rows the TRI Statistics card shows. A resident is in a
   * band when their latest finalized TRI carries that rating, and `Unscored`
   * when it carries none — the TRI module's own reading, not a second rule.
   */
  const behavioralRows: DistributionRow[] = BEHAVIORAL_BANDS.map((label) => {
    const bandResidents = triRows
      .filter((row) => (
        label === 'Unscored'
          ? !row.rating || !SCORED_BANDS.includes(String(row.rating))
          : row.rating === label
      ))
      .map((row) => ({ id: String(row.residentId), name: row.name }));

    return {
      key: label,
      label,
      count: bandResidents.length,
      barClass: BEHAVIORAL_BAR[label],
      residents: bandResidents,
      dialogTitle: label,
      dialogNote: label === 'Unscored'
        ? 'Active residents with no finalized TRI yet.'
        : `Active residents whose most recent finalized TRI rates ${label}.`,
    };
  });

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Social Worker Dashboard"
        displayRole={displayRole}
        subtitle="case files, reviews, interventions & court schedules"
      />

      <StatTileRow>
        <StatTile
          title="Active Cases"
          value={activeCount}
          caption="On the Active filter"
          icon={Briefcase}
          onClick={() => onOpen('/children')}
        />
        <StatTile
          title="Docs Pending"
          value={pendingApprovals.length}
          caption="Awaiting a review decision"
          icon={FolderOpen}
          onClick={() => onOpen('/documents?tab=pending')}
        />
        <StatTile
          title="For Verification"
          value={forVerification.length}
          caption="Violations awaiting verification"
          icon={ShieldAlert}
          onClick={() => onOpen('/violations?tab=verification')}
        />
        <StatTile
          title="Upcoming Hearings"
          value={upcomingHearings.length}
          caption={upcomingHearings.length ? 'Scheduled, today or later' : 'Nothing scheduled'}
          icon={Gavel}
          onClick={() => onOpen('/court-records')}
        />
      </StatTileRow>

      {/* The command centre's two distributions. Same card, same behaviour —
          each bar opens the residents behind it. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DistributionCard
          title="Residents by Rehabilitation Phase"
          icon={<Calendar className="w-4 h-4 text-[#FFD100]" />}
          caption={activeCount ? 'Residents in the facility now.' : 'Nothing to report yet.'}
          rows={phaseRows}
          total={activeCount}
          empty="No residents are on the Active filter."
          onOpenResident={(id) => onOpen(`/children/${id}`)}
        />

        <DistributionCard
          title="Behavioral Status"
          icon={<ClipboardCheck className="w-4 h-4 text-[#FFD100]" />}
          caption="Based on each resident's most recent finalized TRI."
          rows={behavioralRows}
          total={triRows.length}
          loading={triMonitor.rows === null}
          empty="No residents are on the Active filter."
          onOpenResident={(id) => onOpen(`/children/${id}`)}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Cases needing attention — the case-file gaps, which is the one thing
            a Social Worker can only see by cross-reading residents against
            documents. Rows open the resident, because the role holds Child
            Records and the fix is on that profile. */}
        <SectionCard
          title="Cases Needing Attention"
          icon={<AlertIcon />}
          badge={missingDocuments.length}
          isEmpty={missingDocuments.length === 0}
          empty="Every active case file has its required documents."
        >
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {missingDocuments.map((entry) => (
              <ListRow
                key={entry.child.id}
                title={entry.child.name}
                meta={
                  <>
                    {entry.phase}
                    {entry.missing.length > 0 && ` · ${entry.missing.length} missing`}
                    {entry.pending.length > 0 && ` · ${entry.pending.length} awaiting review`}
                  </>
                }
                trailing={<ArrowRight className="w-4 h-4 text-gray-300" />}
                onClick={() => onOpen(`/children/${entry.child.id}`)}
              />
            ))}
          </div>
        </SectionCard>

        {/* Documents awaiting review */}
        <SectionCard
          title="Documents Awaiting Review"
          icon={<FolderOpen className="w-4 h-4 text-[#FFD100]" />}
          badge={pendingApprovals.length}
          isEmpty={pendingApprovals.length === 0}
          empty="No documents are waiting for a decision."
          action={
            pendingApprovals.length > 0 ? (
              <button
                type="button"
                onClick={() => onOpen('/documents?tab=pending')}
                className="text-[10px] border border-gray-200 px-2 py-1 rounded hover:bg-[#FFD100] transition-all shrink-0"
              >
                Open
              </button>
            ) : undefined
          }
        >
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {pendingApprovals.slice(0, 6).map((doc) => (
              <ListRow
                key={doc.id}
                title={doc.title || 'Untitled document'}
                meta={doc.residentName || nameOf(doc.residentId)}
                trailing={
                  <span className="text-[10px] font-semibold text-orange-700 bg-orange-50 border border-orange-100 rounded px-1.5 py-0.5">
                    {doc.status}
                  </span>
                }
                onClick={() => onOpen('/documents?tab=pending')}
              />
            ))}
          </div>
        </SectionCard>

        {/* Violations awaiting verification */}
        <SectionCard
          title="Violations For Verification"
          icon={<ShieldAlert className="w-4 h-4 text-[#FFD100]" />}
          badge={forVerification.length}
          isEmpty={forVerification.length === 0}
          empty="Nothing is waiting on a verification decision."
        >
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {forVerification.slice(0, 6).map((violation) => (
              <ListRow
                key={violation.id}
                title={nameOf(violation.residentId)}
                meta={
                  <>
                    {violation.type || 'Violation'}
                    {violation.severity && ` · ${violation.severity}`}
                  </>
                }
                trailing={<ArrowRight className="w-4 h-4 text-gray-300" />}
                onClick={() => onOpen('/violations?tab=verification')}
              />
            ))}
          </div>
        </SectionCard>

        {/* Upcoming hearings */}
        <SectionCard
          title="Upcoming Court Hearings"
          icon={<Gavel className="w-4 h-4 text-[#FFD100]" />}
          badge={upcomingHearings.length}
          isEmpty={upcomingHearings.length === 0}
          empty="No hearings are scheduled."
        >
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {upcomingHearings.slice(0, 6).map((hearing) => (
              <ListRow
                key={hearing.id}
                title={nameOf(hearing.residentId)}
                meta={
                  <>
                    {formatShortDate(hearing.hearingDate)}
                    {hearing.hearingType && ` · ${hearing.hearingType}`}
                    {hearing.courtName && ` · ${hearing.courtName}`}
                  </>
                }
                trailing={<ArrowRight className="w-4 h-4 text-gray-300" />}
                onClick={() => onOpen('/court-records')}
              />
            ))}
          </div>
        </SectionCard>
      </div>

      {/* TRI Statistics — the shared card, reused rather than re-drawn, and fed
          the rows Behavioral Status already loaded so the page asks once. It
          reads `/tri/monitor`, which this role is entitled to (the endpoint is
          gated to the reviewer roles and the Social Worker is one of them). */}
      <TriStatistics rows={triMonitor.rows} />

      {/* Pending assessments. Each card opens the assessment it names. */}
      <SectionCard
        title="Pending Assessments"
        icon={<ClipboardCheck className="w-4 h-4 text-[#FFD100]" />}
        badge={pendingAssessments.length}
        isEmpty={pendingAssessments.length === 0}
        empty="No assessments are awaiting a sitting."
        action={
          pendingAssessments.length > 0 ? (
            <button
              type="button"
              onClick={() => onOpen('/assessments')}
              className="text-[10px] border border-gray-200 px-2 py-1 rounded hover:bg-[#FFD100] transition-all shrink-0"
            >
              Open
            </button>
          ) : undefined
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {pendingAssessments.slice(0, 6).map((assessment) => (
            <button
              key={assessment.id}
              type="button"
              onClick={() => onOpen(`/assessments/${assessment.id}`)}
              className="flex w-full items-start gap-3 rounded-lg border-l-4 border-[#FFD100] bg-gray-50 p-3 text-left transition-colors hover:bg-[#FFD100]/10"
            >
              <div className="text-[10px] font-bold text-[#FFD100] bg-[#2F3E46] p-1 rounded min-w-[64px] text-center leading-tight shrink-0">
                <div>{formatShortDate(assessment.date)}</div>
                <div className="font-semibold text-white">{assessment.time || 'TBA'}</div>
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-xs text-[#2F3E46] truncate">{assessment.title}</p>
                <p className="text-[10px] text-gray-400 italic truncate">{assessment.type}</p>
              </div>
              <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" />
            </button>
          ))}
        </div>
      </SectionCard>

      {/* Today's schedule. Read from the database summary the page already
          fetches, so the count and this list cannot disagree. */}
      <SectionCard
        title="Today's Schedule"
        icon={<Calendar className="w-4 h-4 text-[#FFD100]" />}
        badge={scheduleCount}
        isEmpty={scheduleCount === 0}
        empty="Nothing is scheduled for today."
        action={
          <button
            type="button"
            onClick={() => onOpen('/activities')}
            className="text-[10px] border border-gray-200 px-2 py-1 rounded hover:bg-[#FFD100] transition-all shrink-0"
          >
            Open calendar
          </button>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {todayActivities.map((activity) => (
            <ListRow
              key={`activity-${activity.id}`}
              title={activity.title || 'Untitled activity'}
              meta={`${activity.time || 'All day'} · ${activity.location || 'Shelter'}`}
              trailing={<TrendingUp className="w-4 h-4 text-gray-300" />}
              onClick={() => onOpen(`/activities/${activity.id}`)}
            />
          ))}
          {todayAssessments.map((assessment) => (
            <ListRow
              key={`assessment-${assessment.id}`}
              title={assessment.title || 'Untitled assessment'}
              meta={`${formatShortDate(assessment.date)} · ${assessment.time || 'TBA'}`}
              trailing={<ClipboardCheck className="w-4 h-4 text-gray-300" />}
              onClick={() => onOpen(`/assessments/${assessment.id}`)}
            />
          ))}
        </div>
      </SectionCard>

      {/* So the page is never a wall of cards with no explanation of where a
          number came from. */}
      <p className="text-[10px] text-gray-400">
        Counts follow the module each card opens: Active Cases is the Child Records Active
        filter, Docs Pending is the Documents module&rsquo;s For Review queue, For Verification
        is the Violations module&rsquo;s verification queue, and TRI Statistics is the TRI
        module&rsquo;s own card. Click any bar to see the residents behind it.
      </p>

      {activeCount === 0 && (
        <EmptyState>
          No residents are on the Active filter, so there is nothing to queue here yet.
        </EmptyState>
      )}
    </div>
  );
}

/** The warning glyph used by the case-file queue heading. */
function AlertIcon() {
  return <ShieldAlert className="w-4 h-4 text-[#FFD100]" />;
}

export default SocialWorkerDashboard;
