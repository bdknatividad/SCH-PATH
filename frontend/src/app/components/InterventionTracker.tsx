import { useState, useEffect, useMemo } from 'react';
import { useData } from '@/app/state/DataContext';
import { useAuth } from '@/app/state/AuthContext';
import { usePermissions } from '@/app/hooks/usePermissions';
import { useNavigate } from 'react-router-dom';
import { describeError, request } from '@/services/api';
import { systemDialog } from '@/app/components/SystemDialog';
import { getCurrentPHDateTime } from '@/utils/dateFormatter';
import IncidentReportModal from './IncidentReportModal';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/dialog';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Button } from '@/app/components/ui/button';
import {
  Shield, AlertTriangle, CheckCircle2, Clock,
  ChevronDown, ChevronRight, User, Search,
  Activity, ArrowRight, CheckCheck, ListFilter, FileText,
} from 'lucide-react';

const SEV_BADGE: Record<string, string> = {
  Major: 'bg-orange-100 text-orange-700',
  Minor: 'bg-yellow-100 text-yellow-700',
};

type ActiveTab = 'active' | 'done';
type SevFilter = 'All' | 'Major' | 'Minor';
type StatusFilter = 'All Status' | 'Reviewed' | 'Resolved' | 'Overdue';

const toMonthKey = (value: any) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, '0')}`;
  const slash = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (slash) {
    const [, a, b, year] = slash;
    const first = Number(a); const second = Number(b);
    const month = first > 12 ? second : first;
    return `${year}-${String(month).padStart(2, '0')}`;
  }
  return raw.slice(0, 7);
};

const localMonthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// Scheduling is a property of the configured intervention TYPE, not of the
// display text, metadata flags, duration, or any other guide field. Only the
// two shelter intervention types below are schedulable.
const isSchedulingIntervention = (step: any) => {
  const type = String(step?.interventionType || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return type === 'psychosocial activity' || type === 'dialogue / counseling' || type === 'dialogue/counseling';
};

const formatDateValue = (value: any) => {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString();
};

export function InterventionTracker({ embedded = false }: { embedded?: boolean } = {}) {
  const { children, violations, refreshData } = useData();
  const { user } = useAuth();
  const { canOpenModule } = usePermissions();
  const isHouseparent = user?.role?.toLowerCase() === 'houseparent';
  const navigate = useNavigate();
  /**
   * The "Profile" action opens `/children/:id`, guarded by the Child Records
   * module. The Houseparent holds Violations (and therefore this tracker) without
   * Child Records, so the button is withheld rather than left to 403 — the same
   * rule the Log Incident button follows in Violations.tsx.
   */
  const canOpenResidentProfile = canOpenModule('Child Records');

  const [tab, setTab] = useState<ActiveTab>('active');
  const [search, setSearch] = useState('');
  const [sevFilter, setSevFilter] = useState<SevFilter>('All');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All Status');
  const [incidentMonthFilter, setIncidentMonthFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [markingDone, setMarkingDone] = useState<string | null>(null);
  const [completingReqId, setCompletingReqId] = useState<string | null>(null);
  const [incidentReportsByViolation, setIncidentReportsByViolation] = useState<Record<string, any>>({});
  const [form8ViolationId, setForm8ViolationId] = useState<string | null>(null);
  const [form8Mode, setForm8Mode] = useState<'create' | 'edit'>('create');
  const [form8ResidentId, setForm8ResidentId] = useState<string | null>(null);
  const [scheduleTarget, setScheduleTarget] = useState<any | null>(null);
  const [scheduleValue, setScheduleValue] = useState('');
  const [schedulingId, setSchedulingId] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [earlyEndTarget, setEarlyEndTarget] = useState<{ step: any; endDate: string; expectedEnd: Date } | null>(null);

  const localDateTimeInput = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const handleStartRequirement = async (trackerId: string) => {
    setStartingId(trackerId);
    try {
      const startDate = localDateTimeInput().slice(0, 10);
      await request(`/violation-guide/intervention-tracker/${trackerId}`, {
        method: 'PUT',
        body: JSON.stringify({ startDate }),
      });
      await loadTrackerRecords();
    } catch (err) {
      void systemDialog.failure('Could not start the intervention', describeError(err, 'The intervention was not started. Please try again.'));
    } finally {
      setStartingId(null);
    }
  };

  const localDate = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const addDuration = (dateString: string, duration: number, unit: string) => {
    const date = new Date(`${dateString}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;
    const normalizedUnit = String(unit || '').toLowerCase().replace(/\s+/g, '');
    if (normalizedUnit.startsWith('day')) date.setDate(date.getDate() + duration);
    else if (normalizedUnit.startsWith('week')) date.setDate(date.getDate() + (duration * 7));
    else if (normalizedUnit.startsWith('month')) date.setMonth(date.getMonth() + duration);
    else return null;
    return date;
  };

  const completeEndRequirement = async (step: any, endDate: string) => {
    if (!step?.id) return;
    setCompletingReqId(step.id);
    try {
      await request(`/violation-guide/intervention-tracker/${step.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'Completed', endDate }),
      });
      await loadTrackerRecords();
    } catch (err) {
      void systemDialog.failure('Could not end the intervention', describeError(err, 'The intervention was not ended. Please try again.'));
    } finally {
      setCompletingReqId(null);
      setEarlyEndTarget(null);
    }
  };

  const handleEndRequirement = async (step: any) => {
    if (!step?.id) return;
    if (!step.startDate) {
      void systemDialog.validation('Start the intervention first', {
        description: 'A duration-based intervention has to be started before it can be ended.',
      });
      return;
    }

    const endDate = localDate();
    const expectedEnd = step.duration && step.unit
      ? addDuration(String(step.startDate).slice(0, 10), Number(step.duration), String(step.unit))
      : null;

    const endingEarly = expectedEnd && new Date(`${endDate}T00:00:00`).getTime() < expectedEnd.getTime();

    if (endingEarly && expectedEnd) {
      setEarlyEndTarget({ step, endDate, expectedEnd });
      return;
    }

    await completeEndRequirement(step, endDate);
  };

  const handleScheduleSave = async () => {
    if (!scheduleTarget || !scheduleValue) return;
    if (new Date(scheduleValue).getTime() <= Date.now()) {
      void systemDialog.validation('Choose a future date and time', {
        description: 'A schedule in the past cannot be saved.',
      });
      return;
    }
    setSchedulingId(scheduleTarget.id);
    try {
      await request(`/violation-guide/intervention-tracker/${scheduleTarget.id}`, {
        method: 'PUT',
        body: JSON.stringify({ scheduledAt: scheduleValue }),
      });
      await loadTrackerRecords();
      setScheduleTarget(null);
      setScheduleValue('');
    } catch (err) {
      void systemDialog.failure('Could not schedule the intervention', describeError(err, 'The intervention was not scheduled. Please try again.'));
    } finally {
      setSchedulingId(null);
    }
  };

  const handleCompleteRequirement = async (trackerId: string) => {
    setCompletingReqId(trackerId);
    try {
      await request(`/violation-guide/intervention-tracker/${trackerId}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'Completed' }),
      });
      await loadTrackerRecords();
    } catch (err) {
      void systemDialog.failure('Could not complete the requirement', describeError(err, 'The requirement was not marked complete. Please try again.'));
    } finally {
      setCompletingReqId(null);
    }
  };

  const [trackerRecords, setTrackerRecords] = useState<any[]>([]);

  const activeChildren = children.filter(c => c.status !== 'Discharged');

  const displayViolationStatus = (v: any) => {
    if (v?.status === 'Resolved') return 'Resolved';
    const month = toMonthKey(v?.interventionMonth || v?.date);
    if (v?.status === 'Escalated' || (month && month < localMonthKey() && !['Pending Review', 'Rejected'].includes(v?.status))) return 'Overdue';
    if (v?.status === 'Reviewed' || v?.status === 'Under Investigation') return 'Reviewed';
    return v?.status || '';
  };

  const matchesFilters = (v: any) => {
    const child = children.find(c => c.id === v?.residentId);
    const query = search.trim().toLowerCase();
    const haystack = `${child?.name || ''} ${v?.type || ''}`.toLowerCase();
    const matchesSearch = !query || haystack.includes(query);
    const matchesSeverity = sevFilter === 'All' || v?.severity === sevFilter;
    const matchesMonth = !incidentMonthFilter || toMonthKey(v?.date || v?.interventionMonth) === incidentMonthFilter;
    const status = displayViolationStatus(v);
    const matchesStatus = statusFilter === 'All Status' || status === statusFilter;
    return matchesSearch && matchesSeverity && matchesMonth && matchesStatus;
  };

  const buildTracks = (resolved: boolean) => {
    return activeChildren.flatMap(child => {
      const childViolations = violations.filter(v =>
        v.residentId === child.id &&
        (resolved ? v.status === 'Resolved' : !['Pending Review', 'Rejected', 'Resolved'].includes(v.status)) &&
        matchesFilters(v)
      );

      if (childViolations.length === 0) return [];

      const tracks = childViolations.map(v => {
        const interventionRows = trackerRecords.filter(row => row.violationId === v.id);
        return { violation: v, interventions: interventionRows, severity: v.severity };
      }).filter(track => track.interventions.length > 0);

      if (tracks.length === 0) return [];

      return [{ child, tracks, count: tracks.length }];
    })
    .sort((a, b) => b.count - a.count);
  };

  const filteredTrackerRecords = useMemo(() => trackerRecords.filter(row => {
    const v = violations.find(item => item.id === row.violationId);
    return v ? matchesFilters(v) : false;
  }), [trackerRecords, violations, search, sevFilter, statusFilter, incidentMonthFilter]);

  /**
   * Whether the Form 08 (Incident Report) section has anything to show for this
   * track, and whether the report has come back.
   *
   * The checklist gate alone is not enough. Sending an Incident Report back for
   * reassessment reopens every tracker row — that is the whole point of the
   * decision, and it is what `reopenInterventionForReassessment` does in the
   * backend. So the checklist stops being complete at exactly the moment this
   * section has something to say, and gating it on completion alone hid the "For
   * Reassessment" badge together with the "Fill Out Again" button — the only
   * control that can answer the decision. The report came back with no way to
   * resubmit it, which read as the reassessment never reaching the tracker.
   *
   * A 'Failed' report never hits that, because failure deliberately does not
   * reopen the checklist. It is covered here anyway, so both returned states
   * read the same and neither depends on the checklist's state to stay visible.
   */
  const form8Section = (track: any) => {
    const report = incidentReportsByViolation[track.violation.id];
    const checklistComplete = track.interventions.length > 0
      && track.interventions.every((s: any) => s.status === 'Completed');
    const needsRework = Boolean(report && (report.status === 'Reassessment' || report.status === 'Failed'));
    return { report, needsRework, visible: checklistComplete || needsRework };
  };

  const loadTrackerRecords = async () => {
    try {
      const all: any[] = [];

      for (const child of activeChildren) {
        const response = await request<{ success: boolean; data?: any[] }>(
          `/violation-guide/resident/${child.id}/interventions`
        );

        if (response?.success && Array.isArray(response.data)) {
          all.push(...response.data);
        }
      }

      setTrackerRecords(all);
    } catch (error) {
      console.error('Failed to load intervention tracker records:', error);
      setTrackerRecords([]);
    }
  };

  useEffect(() => {
    loadTrackerRecords();
  }, [children, violations]);

  useEffect(() => {
    const ids = Array.from(new Set(trackerRecords.map(r => r.violationId).filter(Boolean)));
    if (!ids.length) { setIncidentReportsByViolation({}); return; }
    Promise.all(ids.map(async (id) => {
      try {
        const response: any = await request(`/incident-reports/violation/${id}`, { method: 'GET' });
        return [id, response?.success ? response.data : null] as const;
      } catch { return [id, null] as const; }
    })).then(entries => setIncidentReportsByViolation(Object.fromEntries(entries)));
  }, [trackerRecords]);

  const activeList = useMemo(
    () => buildTracks(false),
    [children, violations, trackerRecords, search, sevFilter, statusFilter, incidentMonthFilter]
  );

  const doneList = useMemo(
    () => buildTracks(true),
    [children, violations, trackerRecords, search, sevFilter, statusFilter, incidentMonthFilter]
  );

  const totalActive = useMemo(() => filteredTrackerRecords.filter(row => row.status === 'In Progress').length, [filteredTrackerRecords]);
  const totalInProgress = useMemo(() => filteredTrackerRecords.filter(row => row.status === 'In Progress').length, [filteredTrackerRecords]);
  const totalDone = useMemo(() => filteredTrackerRecords.filter(row => row.status === 'Completed').length, [filteredTrackerRecords]);
  const totalEscalated = useMemo(() => filteredTrackerRecords.filter(row => {
    const v = violations.find(item => item.id === row.violationId);
    return displayViolationStatus(v) === 'Overdue';
  }).length, [filteredTrackerRecords, violations]);

  const [markDoneError, setMarkDoneError] = useState<string | null>(null);

  const handleMarkDone = async (violationId: string) => {
    setMarkingDone(violationId);
    setMarkDoneError(null);
    try {
      const res: any = await request(`/violations/${violationId}/mark-done`, { method: 'POST' });
      if (res?.success) {
        // Shared violations state — Violation Module reflects this the moment it re-renders.
        await refreshData();
      }
    } catch (err) {
      setMarkDoneError(err instanceof Error ? err.message : 'Unable to mark intervention as done.');
    } finally {
      setMarkingDone(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      {markDoneError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg">
          {markDoneError}
        </div>
      )}
      <div className="bg-[#2F3E46] p-6 rounded-xl border-b-4 border-[#FFD100]">
        <div className="flex items-center gap-3 mb-1">
          <Shield className="w-7 h-7 text-[#FFD100]" />
          <h2 className="text-2xl font-bold text-white">Intervention Tracker</h2>
        </div>
        <p className="text-gray-300 text-sm">Monitor verified active interventions and prescribed interventions per resident based on the SCH matrix</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Active Interventions', value: totalActive, icon: Activity, color: 'text-blue-600', bg: 'bg-blue-100' },
          { label: 'In Progress', value: totalInProgress, icon: Activity, color: 'text-blue-600', bg: 'bg-blue-100' },
          { label: 'Escalated',   value: totalEscalated,  icon: AlertTriangle, color: 'text-red-600',    bg: 'bg-red-100'    },
          { label: 'Done',        value: totalDone,        icon: CheckCheck,    color: 'text-green-600',  bg: 'bg-green-100'  },
        ].map(s => (
          <Card key={s.label} className="border-none shadow-sm">
            <CardContent className="p-4 flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl ${s.bg} flex items-center justify-center shrink-0`}>
                <s.icon className={`w-5 h-5 ${s.color}`} />
              </div>
              <div>
                <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-[10px] text-gray-500">{s.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs — scrolls rather than overflowing the page on a narrow screen. */}
      <div className="flex items-center gap-2 border-b border-gray-200 pb-0 overflow-x-auto">
        {([
          { key: 'active', label: 'Active', count: activeList.reduce((s,ci) => s + ci.count, 0) },
          { key: 'done',   label: 'Done',             count: doneList.reduce((s,ci) => s + ci.count, 0)   },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setExpanded(null); }}
            className={`shrink-0 whitespace-nowrap flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-all -mb-px ${
              tab === t.key
                ? 'border-[#FFD100] text-[#2F3E46]'
                : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            {t.key === 'done' ? <CheckCheck className="w-4 h-4" /> : <ListFilter className="w-4 h-4" />}
            {t.label}
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
              tab === t.key ? 'bg-[#FFD100] text-[#2F3E46]' : 'bg-gray-100 text-gray-500'
            }`}>{t.count}</span>
          </button>
        ))}
      </div>

      {/* Filters — matches the Violation List filters */}
      <Card><CardContent className="p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_180px_180px_180px]">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by resident name or violation type..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#FFD100]"
            />
          </div>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as StatusFilter)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl">
            <option>All Status</option>
            <option value="Reviewed">Reviewed</option>
            <option value="Resolved">Resolved</option>
            <option value="Overdue">Overdue</option>
          </select>
          <select value={sevFilter} onChange={e => setSevFilter(e.target.value as SevFilter)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-white">
            <option value="All">All Severity</option>
            <option value="Major">Major</option>
            <option value="Minor">Minor</option>
          </select>
          <div className="space-y-1">
            <Label className="text-[11px] font-semibold text-gray-500">Incident Month</Label>
            <input type="month" value={incidentMonthFilter} onChange={e => setIncidentMonthFilter(e.target.value)} aria-label="Incident month" className="w-full min-w-0 px-3 py-2 text-sm border border-gray-200 rounded-xl" />
          </div>
        </div>
      </CardContent></Card>

      {(tab === 'active' ? activeList : doneList).length === 0 ? (
        <Card className="border-none shadow-sm">
          <CardContent className="p-12 text-center">
            <CheckCircle2 className="w-12 h-12 text-green-400 mx-auto mb-3" />
            <p className="text-gray-500 font-semibold">
              {tab === 'done' ? 'No completed interventions yet.' : 'No active interventions found.'}
            </p>
            <p className="text-gray-400 text-sm mt-1">
              {tab === 'done'
                ? 'Completed interventions will appear here once marked as Done.'
                : 'All residents are in good standing or no violations match your filter.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(tab === 'active' ? activeList : doneList).map(({ child, tracks, count }) => (
            <Card key={child.id} className="border-none shadow-sm overflow-hidden">
              {/* Child row */}
              <button
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left"
                onClick={() => setExpanded(expanded === child.id ? null : child.id)}
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {expanded === child.id
                    ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />
                    : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
                  <div className="min-w-0">
                    <p className="font-bold text-[#2F3E46] text-sm">{child.name}</p>
                    <p className="text-xs text-gray-400">{child.id} · {child.casePhase}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                    {count} {tab === 'done' ? 'completed' : 'active'}
                  </span>
                  {canOpenResidentProfile && (
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={e => { e.stopPropagation(); navigate(`/children/${child.id}`); }}>
                    Profile <ArrowRight className="w-3 h-3 ml-1" />
                  </Button>
                  )}
                </div>
              </button>

              {/* Expanded tracks */}
              {expanded === child.id && (
                <div className="border-t border-gray-100 bg-gray-50 p-4 space-y-3">
                  {tracks.map((track, idx) => (
                    <div key={idx} className={`rounded-xl border p-3 bg-white ${
                      tab === 'done'                  ? 'border-green-200' :
                      track.violation.actionTaken     ? 'border-blue-200'  : 'border-gray-200'
                    }`}>
                      {/* Violation info */}
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] font-black uppercase px-1.5 py-0.5 rounded ${SEV_BADGE[track.severity] || 'bg-gray-100 text-gray-600'}`}>
                              {track.severity}
                            </span>
                            <p className="text-xs font-semibold text-gray-800 truncate">{track.violation.type}</p>
                          </div>
                          <p className="text-[10px] text-gray-400 mt-0.5">
                            {track.violation.date} · Reported by: {track.violation.reportedBy || '—'}
                          </p>
                          {(track.violation as any).assessmentTriggered && (
                            <p className={`text-[10px] font-semibold mt-0.5 ${
                              (track.violation as any).assessmentCompleted ? 'text-green-600' : 'text-amber-600'
                            }`}>
                              {(track.violation as any).assessmentCompleted ? '✓ Assessment done' : 'Assessment pending'}
                            </p>
                          )}
                        </div>
                        {tab === 'done' ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200 shrink-0 flex items-center gap-1">
                            <CheckCheck className="w-3 h-3" /> Done
                          </span>
                        ) : (() => {
                          const totalReqs = track.interventions.length;
                          const completedReqs = track.interventions.filter((s: any) => s.status === 'Completed').length;
                          const allComplete = totalReqs > 0 && completedReqs === totalReqs;
                          const incidentReport = incidentReportsByViolation[track.violation.id];
                          const hasForm8 = Boolean(incidentReport);
                          const hasApprovedForm8 = Boolean(incidentReport && (
                            incidentReport.documentStatus === 'Approved' ||
                            (!incidentReport.pdfDocumentId && incidentReport.status === 'Verified')
                          ));
                          return (
                            <div className="flex flex-col items-end gap-1 shrink-0">
                              {allComplete && !hasForm8 && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs border-blue-300 text-blue-700 hover:bg-blue-50"
                                  onClick={() => { setForm8ViolationId(track.violation.id); setForm8ResidentId(track.violation.residentId); }}
                                >
                                  <FileText className="w-3 h-3 mr-1" /> Fill Out Incident Report
                                </Button>
                              )}
                              <Button
                                size="sm"
                                className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white disabled:bg-gray-300 disabled:cursor-not-allowed"
                                disabled={markingDone === track.violation.id || !allComplete || !hasApprovedForm8}
                                title={!allComplete ? `Complete all ${totalReqs} requirement(s) first (${completedReqs}/${totalReqs} done)` : !hasForm8 ? 'Fill out and save Form 08 first' : !hasApprovedForm8 ? 'Form 08 must be approved before marking this intervention Done' : undefined}
                                onClick={() => track.violation.id && handleMarkDone(track.violation.id)}
                              >
                                {markingDone === track.violation.id
                                  ? 'Saving...'
                                  : <><CheckCircle2 className="w-3 h-3 mr-1" /> Mark Done</>}
                              </Button>
                              {!allComplete && totalReqs > 0 && (
                                <span className="text-[10px] text-gray-400">{completedReqs}/{totalReqs} requirements done</span>
                              )}
                              {allComplete && hasApprovedForm8 && <span className="text-[10px] text-green-600 font-semibold">✓ Form 08 approved — ready to Mark Done</span>}
                              {allComplete && hasForm8 && !hasApprovedForm8 && <span className="text-[10px] text-amber-600 font-semibold">Form 08 pending approval</span>}
                            </div>
                          );
                        })()}
                      </div>

                      {/* Intervention steps */}
                      <div className="border-t border-gray-100 pt-2 mt-1">
                        <p className="text-[10px] font-bold uppercase text-gray-400 tracking-wider mb-1.5">Prescribed Interventions</p>
                        <ol className="space-y-1">
                          {track.interventions.length === 0 ? (
                            <p className="text-xs text-gray-400">
                              No intervention records have been generated.
                            </p>
                          ) : (
                            <ol className="space-y-2">
                              {track.interventions.map((step: any, si: number) => {
                                let metadata = step.metadata;

                                if (typeof metadata === 'string') {
                                  try {
                                    metadata = JSON.parse(metadata);
                                  } catch {
                                    metadata = {};
                                  }
                                }

                                const officialText =
                                  metadata?.officialText ||
                                  step.interventionType ||
                                  'Other';
                                const isCompleted = step.status === 'Completed';
                                const isSchedulable = isSchedulingIntervention(step);
                                const isPsychosocialType = String(step?.interventionType || '').trim().toLowerCase().replace(/\s+/g, ' ') === 'psychosocial activity';

                                return (
                                  <li
                                    key={step.id || si}
                                    className={`rounded-lg border p-2 ${isCompleted ? 'border-green-200 bg-green-50' : 'border-gray-100 bg-gray-50'}`}
                                  >
                                    <div className="flex items-start gap-2">
                                      <span className={`font-bold shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[9px] ${isCompleted ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-600'}`}>
                                        {isCompleted ? '✓' : si + 1}
                                      </span>

                                      <div className="flex-1">
                                        <p className={`text-xs ${isCompleted ? 'text-green-800 line-through' : 'text-gray-700'}`}>
                                          {officialText}
                                        </p>

                                        {(step.duration && step.unit) && (
                                          <p className="text-[10px] text-gray-400 mt-1">
                                            Duration: {step.duration} {step.unit}
                                          </p>
                                        )}

                                        {step.duration && step.startDate && (
                                          <p className="text-[10px] text-green-700 mt-0.5 font-semibold">
                                            Started: {formatDateValue(step.startDate)}
                                          </p>
                                        )}

                                        {step.duration && step.endDate && (
                                          <p className="text-[10px] text-green-700 mt-0.5 font-semibold">
                                            Ended: {formatDateValue(step.endDate)}
                                          </p>
                                        )}

                                        {step.scheduledAt && (
                                          <p className="text-[10px] text-blue-600 mt-0.5 font-semibold">
                                            Scheduled: {new Date(step.scheduledAt).toLocaleString()}
                                          </p>
                                        )}

                                        {isPsychosocialType && (
                                          <span className="inline-flex mt-1 px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 text-[10px] font-bold">
                                            Psychosocial activity required
                                          </span>
                                        )}

                                        {!isHouseparent && isSchedulingIntervention(step) && !step.scheduledAt && !isCompleted && (
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="mt-1.5 h-6 text-[10px] px-2 border-blue-300 text-blue-700 hover:bg-blue-50"
                                            onClick={() => { setScheduleTarget(step); setScheduleValue(localDateTimeInput()); }}
                                            disabled={schedulingId === step.id}
                                          >
                                            {schedulingId === step.id ? 'Scheduling...' : 'Scheduling Required'}
                                          </Button>
                                        )}

                                        {isCompleted && (
                                          <p className="text-[10px] text-green-700 mt-1 font-semibold">
                                            ✓ Completed{step.completionDate ? ` on ${new Date(step.completionDate).toLocaleDateString()}` : ''}
                                          </p>
                                        )}

                                        {step.duration ? (
                                          !isCompleted ? (
                                            <div className="mt-1.5 flex items-center gap-2">
                                              {!step.startDate ? (
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  className="h-6 text-[10px] px-2 border-blue-300 text-blue-700 hover:bg-blue-50"
                                                  disabled={startingId === step.id}
                                                  onClick={() => handleStartRequirement(step.id)}
                                                >
                                                  {startingId === step.id ? 'Starting...' : 'Start'}
                                                </Button>
                                              ) : (
                                                <Button
                                                  size="sm"
                                                  className="h-6 text-[10px] px-2 bg-green-600 hover:bg-green-700 text-white"
                                                  disabled={completingReqId === step.id}
                                                  onClick={() => handleEndRequirement(step)}
                                                >
                                                  {completingReqId === step.id ? 'Ending...' : 'End'}
                                                </Button>
                                              )}
                                            </div>
                                          ) : null
                                        ) : (
                                          !isCompleted && !isSchedulable && step.id ? (
                                            <Button
                                              size="sm"
                                              variant="outline"
                                              className="mt-1.5 h-6 text-[10px] px-2"
                                              disabled={completingReqId === step.id}
                                              onClick={() => handleCompleteRequirement(step.id)}
                                            >
                                              {completingReqId === step.id ? 'Marking...' : 'Mark Complete'}
                                            </Button>
                                          ) : null
                                        )}
                                      </div>
                                    </div>
                                  </li>
                                );
                              })}
                              {form8Section(track).visible && (
                                <li className="rounded-lg border border-blue-200 bg-blue-50 p-2 mt-2">
                                  <div className="flex items-center gap-2">
                                    <span className="font-bold shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[9px] bg-blue-500 text-white">8</span>
                                    <div className="flex-1">
                                      <p className="text-xs font-semibold text-blue-800">Incident Report (Form 08)</p>
                                      <p className="text-[10px] text-blue-600 mt-0.5">
                                        {form8Section(track).needsRework
                                          ? 'Returned by the Center Head — correct it and resubmit. The intervention stays pending until this report is approved.'
                                          : 'Available after all checklist requirements are completed and before Mark Done.'}
                                      </p>
                                    </div>
                                    {incidentReportsByViolation[track.violation.id] ? (() => {
                                      const report = incidentReportsByViolation[track.violation.id];
                                      const approved = report.documentStatus === 'Approved' || (!report.pdfDocumentId && report.status === 'Verified');
                                      const failed = report.status === 'Failed' || (report.documentStatus === 'Rejected' && report.status !== 'Verified');
                                      const reassessment = report.status === 'Reassessment';
                                      if (approved) return <span className="text-[10px] font-bold text-green-700">✓ Approved</span>;
                                      if (failed) return (
                                        <div className="flex items-center gap-2">
                                          <span className="text-[10px] font-bold text-yellow-700 bg-yellow-100 border border-yellow-200 rounded-full px-2 py-0.5">Failed</span>
                                          <Button size="sm" variant="outline" className="h-6 text-[10px] border-yellow-300 text-yellow-800 hover:bg-yellow-50" onClick={() => { setForm8ViolationId(track.violation.id); setForm8ResidentId(track.violation.residentId); setForm8Mode('edit'); }}>
                                            Fill Out Again
                                          </Button>
                                        </div>
                                      );
                                      if (reassessment) return (
                                        <div className="flex items-center gap-2">
                                          <span className="text-[10px] font-bold text-yellow-700 bg-yellow-100 border border-yellow-200 rounded-full px-2 py-0.5">For Reassessment</span>
                                          <Button size="sm" variant="outline" className="h-6 text-[10px] border-yellow-300 text-yellow-800 hover:bg-yellow-50" onClick={() => { setForm8ViolationId(track.violation.id); setForm8ResidentId(track.violation.residentId); setForm8Mode('edit'); }}>
                                            Fill Out Again
                                          </Button>
                                        </div>
                                      );
                                      return <span className="text-[10px] font-bold text-amber-600">Pending approval</span>;
                                    })() : (
                                      <Button size="sm" variant="outline" className="h-6 text-[10px] border-blue-300 text-blue-700" onClick={() => { setForm8ViolationId(track.violation.id); setForm8ResidentId(track.violation.residentId); setForm8Mode('create'); }}>
                                        Fill Out Incident Report
                                      </Button>
                                    )}
                                  </div>
                                </li>
                              )}
                            </ol>
                          )}
                        </ol>
                        {track.violation.actionTaken && track.violation.actionTaken !== 'Intervention completed and marked as done.' && (
                          <div className="mt-2 p-2 rounded-lg bg-blue-50 border border-blue-100">
                            <p className="text-[10px] font-bold text-blue-600 uppercase">Action Taken</p>
                            <p className="text-xs text-blue-700 mt-0.5">{track.violation.actionTaken}</p>
                          </div>
                        )}
                        {tab === 'done' && (
                          <div className="mt-2 p-2 rounded-lg bg-green-50 border border-green-100 flex items-center gap-2">
                            <CheckCheck className="w-3.5 h-3.5 text-green-600 shrink-0" />
                            <p className="text-xs text-green-700 font-semibold">Intervention completed</p>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!scheduleTarget} onOpenChange={(open) => { if (!open) { setScheduleTarget(null); setScheduleValue(''); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Schedule Intervention</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="rounded-lg bg-gray-50 border p-3 text-sm">
              <p className="font-semibold text-[#2F3E46]">{scheduleTarget?.officialText || scheduleTarget?.interventionType || 'Intervention'}</p>
              {scheduleTarget?.duration ? <p className="text-xs text-gray-500 mt-1">Duration: {scheduleTarget.duration} {scheduleTarget.unit || ''}</p> : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="tracker-schedule">Schedule Date and Time</Label>
              <Input id="tracker-schedule" type="datetime-local" min={getCurrentPHDateTime()} value={scheduleValue} onChange={(e) => setScheduleValue(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setScheduleTarget(null); setScheduleValue(''); }}>Cancel</Button>
            <Button className="bg-[#2F3E46]" disabled={!scheduleValue || !!schedulingId} onClick={handleScheduleSave}>{schedulingId ? 'Saving...' : 'Schedule'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!earlyEndTarget} onOpenChange={(open) => { if (!open) setEarlyEndTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>End Intervention Early?</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              This intervention has not reached its configured duration yet.
            </div>
            <div className="text-sm space-y-1">
              <p><span className="font-semibold">Expected duration end:</span> {earlyEndTarget?.expectedEnd.toLocaleDateString() || '—'}</p>
              <p><span className="font-semibold">End today:</span> {earlyEndTarget ? new Date(`${earlyEndTarget.endDate}T00:00:00`).toLocaleDateString() : '—'}</p>
            </div>
            <p className="text-xs text-gray-500">The intervention will be marked complete using the date you choose now. Any remaining configured duration will not be completed automatically.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEarlyEndTarget(null)}>Cancel</Button>
            <Button className="bg-red-600 hover:bg-red-700 text-white" disabled={!!completingReqId} onClick={() => earlyEndTarget && completeEndRequirement(earlyEndTarget.step, earlyEndTarget.endDate)}>End Intervention</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <IncidentReportModal
        open={Boolean(form8ViolationId)}
        onOpenChange={(open) => { if (!open) { setForm8ViolationId(null); setForm8ResidentId(null); setForm8Mode('create'); } }}
        mode={form8Mode}
        violationId={form8ViolationId}
        residentId={form8ResidentId || undefined}
        residentName={children.find(c => c.id === form8ResidentId)?.name}
        onSaved={async () => {
          if (form8ViolationId) {
            try {
              const response: any = await request(`/incident-reports/violation/${form8ViolationId}`, { method: 'GET' });
              setIncidentReportsByViolation(prev => ({ ...prev, [form8ViolationId]: response?.data || null }));
            } catch {}
          }
          setForm8ViolationId(null);
          setForm8ResidentId(null);
          setForm8Mode('create');
          await loadTrackerRecords();
        }}
      />
    </div>
  );
}
