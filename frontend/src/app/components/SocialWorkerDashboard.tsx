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
 * The two distributions follow that rule too: each band arrives with the
 * residents it is made of, so a bar opens the very list its count was taken
 * from rather than a second guess at who is in the group.
 *
 * TRI Statistics is the one exception, and deliberately so: it is the existing
 * shared card, which loads `/tri/monitor` itself and is already used by the TRI
 * module and the command centre. Reusing it is what keeps this page and those
 * two reading the same rating.
 *
 * ## Everything on the page goes somewhere
 *
 * The tiles, every list row, both distribution bars, the pending-assessment
 * cards and the day's schedule all open the record or module they describe —
 * the same rule the command centre follows. A bar opens the residents behind
 * it; a resident opens their profile.
 *
 * ## Links
 *
 * The role holds Child Records, Violations, Court Records, Activities,
 * Assessments and Documents, so every path below is one it can open. A control
 * pointing into a module the role does not hold is a dead control — it
 * type-checks, and the click is silently refused by the route guard.
 */

import { useState } from 'react';
import {
  Briefcase, FolderOpen, ShieldAlert, Gavel, ClipboardCheck, Calendar, ArrowRight,
  BarChart3, TrendingUp, Users, ChevronRight,
} from 'lucide-react';
import type { Child, CourtRecord, Violation } from '../state/DataContext';
import { formatShortDate } from '@/utils/dateFormatter';
import { Badge } from '@/app/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/app/components/ui/dialog';
import { TriStatistics } from './TriStatistics';
import {
  DashboardHeader, StatTile, StatTileRow, SectionCard, EmptyState, ListRow, BarRow,
} from './DashboardKit';

interface MissingDocumentsEntry {
  child: Child;
  phase: string;
  missing: string[];
  pending: string[];
}

/** A resident as the breakdown lists name them. */
interface ResidentRef {
  id: string;
  name: string;
}

/** One urgency band: the count, and the residents it is made of. */
interface UrgencyBand {
  label: string;
  count: number;
  residents: ResidentRef[];
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
  /** Active residents per intervention phase, with the residents behind each. */
  phases: Array<{ short: string; count: number; residents: ResidentRef[] }>;
  /** Unresolved violations by urgency band, with the residents behind each. */
  urgency: UrgencyBand[];
  /** Assessments still on the Scheduled status. */
  pendingAssessments: Array<{ id: string; title?: string; type?: string; date?: string; time?: string }>;
  todayActivities: any[];
  todayAssessments: any[];
  onOpen: (path: string) => void;
}

/** The colour each urgency band carries on every screen that draws it. */
const URGENCY_BAR: Record<string, string> = {
  'Need Improvement': 'bg-red-500',
  Fair: 'bg-orange-500',
  Good: 'bg-yellow-400',
  'Very Good': 'bg-green-500',
};

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
  /**
   * The residents behind one bar.
   *
   * Held as the residents the page handed over with that band, not recomputed
   * here: the bar's count and this list come from the same pass, so they cannot
   * disagree.
   */
  const [breakdown, setBreakdown] = useState<
    { title: string; note: string; residents: ResidentRef[] } | null
  >(null);

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
          works across. Each bar opens the residents behind it, exactly as the
          command centre's bars do. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SectionCard
          title="Urgency — Unresolved Violations"
          icon={<ShieldAlert className="w-4 h-4 text-[#FFD100]" />}
          isEmpty={activeCount === 0}
          empty="No active residents."
        >
          <div className="space-y-2">
            {urgency.map((band) => (
              <BarRow
                key={band.label}
                label={band.label}
                count={band.count}
                percent={share(band.count)}
                barClass={URGENCY_BAR[band.label] || 'bg-gray-400'}
                onOpen={() => setBreakdown({
                  title: band.label,
                  note: `Unresolved violations rated ${band.label}, counted from live violation records.`,
                  residents: band.residents,
                })}
              />
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
              <BarRow
                key={phase.short}
                label={phase.short}
                fullLabel={phase.short}
                count={phase.count}
                percent={share(phase.count)}
                barClass="bg-[#2F3E46]"
                onOpen={() => setBreakdown({
                  title: phase.short,
                  note: `Active residents in the ${phase.short} phase.`,
                  residents: phase.residents,
                })}
              />
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
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" />
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
                  No residents in this group.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {breakdown.residents.map((resident) => (
                    <button
                      key={resident.id}
                      type="button"
                      onClick={() => {
                        setBreakdown(null);
                        onOpen(`/children/${resident.id}`);
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

/** The warning glyph used by the case-file queue heading. */
function AlertIcon() {
  return <ShieldAlert className="w-4 h-4 text-[#FFD100]" />;
}

export default SocialWorkerDashboard;
