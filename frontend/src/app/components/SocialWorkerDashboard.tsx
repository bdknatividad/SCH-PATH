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
 * `missingDocuments`, `upcomingHearings`, `urgency` and `phases` are computed in
 * `Dashboard.tsx` from the same predicates the rest of the application already
 * uses, and passed in. That is deliberate: "Docs Pending" on this page and the
 * Documents module's badge are the same queue, and the two came apart once
 * already when each counted it its own way (see `utils/pendingDocuments.ts`). A
 * second copy of a rule is how a tile starts disagreeing with the screen it
 * opens.
 *
 * TRI Statistics is the one exception, and deliberately so: it is the existing
 * shared card, which loads `/tri/monitor` itself and is already used by the TRI
 * module and the command centre. Reusing it is what keeps this page and those
 * two reading the same rating.
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
  BarChart3, TrendingUp,
} from 'lucide-react';
import type { Child, CourtRecord, Violation } from '../state/DataContext';
import { formatShortDate } from '@/utils/dateFormatter';
import { TriStatistics } from './TriStatistics';
import {
  DashboardHeader, StatTile, StatTileRow, SectionCard, EmptyState, ListRow,
} from './DashboardKit';

interface MissingDocumentsEntry {
  child: Child;
  phase: string;
  missing: string[];
  pending: string[];
}

/** Unresolved violations per urgency band, counted once by the page. */
interface UrgencyCounts {
  needImprovement: number;
  fair: number;
  good: number;
  veryGood: number;
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
  /** Active residents per intervention phase. */
  phases: Array<{ short: string; count: number }>;
  /** Unresolved violations by urgency band. */
  urgency: UrgencyCounts;
  /** Assessments still on the Scheduled status. */
  pendingAssessments: Array<{ id: string; title?: string; type?: string; date?: string; time?: string }>;
  todayActivities: any[];
  todayAssessments: any[];
  onOpen: (path: string) => void;
}

export function SocialWorkerDashboard({
  displayRole,
  residents,
  activeCount,
  pendingApprovals,
  missingDocuments,
  violations,
  upcomingHearings,
  phases,
  urgency,
  pendingAssessments,
  todayActivities,
  todayAssessments,
  onOpen,
}: SocialWorkerDashboardProps) {
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

  const urgencyBands = [
    { label: 'Need Improvement', count: urgency.needImprovement, text: 'text-red-700', bar: 'bg-red-500' },
    { label: 'Fair', count: urgency.fair, text: 'text-orange-700', bar: 'bg-orange-500' },
    { label: 'Good', count: urgency.good, text: 'text-yellow-700', bar: 'bg-yellow-400' },
    { label: 'Very Good', count: urgency.veryGood, text: 'text-green-700', bar: 'bg-green-500' },
  ];

  const share = (count: number) =>
    activeCount ? `${Math.round((count / activeCount) * 100)}%` : '0%';

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

      {/* The two distributions the role read on the shared dashboard. Both are
          about the whole active population, which is what a case-carrying role
          works across. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SectionCard
          title="Urgency — Unresolved Violations"
          icon={<ShieldAlert className="w-4 h-4 text-[#FFD100]" />}
          isEmpty={activeCount === 0}
          empty="No active residents."
        >
          <div className="space-y-2">
            {urgencyBands.map((band) => (
              <div key={band.label} className="flex items-center gap-3">
                <span className="text-xs text-gray-600 w-28 shrink-0">{band.label}</span>
                <div className="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${band.bar} rounded-full transition-all`}
                    style={{ width: share(band.count) }}
                  />
                </div>
                <span className={`text-xs font-bold w-6 text-right ${band.text}`}>{band.count}</span>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard
          title="Residents per Intervention Phase"
          icon={<BarChart3 className="w-4 h-4 text-[#FFD100]" />}
          isEmpty={phases.length === 0}
          empty="No active residents."
        >
          <div className="space-y-2">
            {phases.map((phase) => (
              <div key={phase.short} className="flex items-center gap-3">
                <span className="text-xs text-gray-600 w-28 shrink-0 truncate" title={phase.short}>
                  {phase.short}
                </span>
                <div className="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#2F3E46] rounded-full transition-all"
                    style={{ width: share(phase.count) }}
                  />
                </div>
                <span className="text-xs font-bold w-6 text-right text-[#2F3E46]">{phase.count}</span>
              </div>
            ))}
          </div>
        </SectionCard>
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

      {/* TRI Statistics — the shared card, reused rather than re-drawn. It reads
          `/tri/monitor`, which this role is entitled to (the endpoint is gated
          to the reviewer roles and the Social Worker is one of them). */}
      <TriStatistics />

      {/* Pending assessments */}
      <SectionCard
        title="Pending Assessments"
        icon={<ClipboardCheck className="w-4 h-4 text-[#FFD100]" />}
        badge={pendingAssessments.length}
        isEmpty={pendingAssessments.length === 0}
        empty="No assessments are awaiting a sitting."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {pendingAssessments.slice(0, 6).map((assessment) => (
            <div
              key={assessment.id}
              className="flex items-start gap-3 p-3 rounded-lg bg-gray-50 border-l-4 border-[#FFD100]"
            >
              <div className="text-[10px] font-bold text-[#FFD100] bg-[#2F3E46] p-1 rounded min-w-[64px] text-center leading-tight shrink-0">
                <div>{formatShortDate(assessment.date)}</div>
                <div className="font-semibold text-white">{assessment.time || 'TBA'}</div>
              </div>
              <div className="min-w-0">
                <p className="font-bold text-xs text-[#2F3E46] truncate">{assessment.title}</p>
                <p className="text-[10px] text-gray-400 italic truncate">{assessment.type}</p>
              </div>
            </div>
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
              onClick={() => onOpen('/activities')}
            />
          ))}
          {todayAssessments.map((assessment) => (
            <ListRow
              key={`assessment-${assessment.id}`}
              title={assessment.title || 'Untitled assessment'}
              meta={`${formatShortDate(assessment.date)} · ${assessment.time || 'TBA'}`}
              trailing={<ClipboardCheck className="w-4 h-4 text-gray-300" />}
              onClick={() => onOpen('/assessments')}
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
        module&rsquo;s own card.
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
