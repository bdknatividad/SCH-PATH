import { useState, useMemo } from 'react';
import { useData } from '@/app/state/DataContext';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import {
  Shield, AlertTriangle, CheckCircle2, Clock,
  ChevronDown, ChevronRight, User, Search,
  Activity, ArrowRight, CheckCheck, ListFilter,
} from 'lucide-react';

const INTERVENTION_MATRIX: Record<string, { severity: 'Minor' | 'Major' | 'Critical'; interventions: string[]; assessor: string }> = {
  'Pagtangkang Tumakas / Pagtakas (Escape Attempt)':
    { severity: 'Major', interventions: ['1 meal HHC', 'Privilege suspension', 'Psychosocial activity', '3-day isolation'], assessor: 'Psychologist' },
  'Pagpasok ng Pera at Phone':
    { severity: 'Major', interventions: ['2 weeks Privilege Suspension', 'Psychosocial activity', 'Confiscate item'], assessor: 'Social Worker' },
  'Pagpasok ng Alak at Sigarilyo':
    { severity: 'Major', interventions: ['2 weeks Privilege Suspension', '1 day household chores', 'Psychosocial activity'], assessor: 'Nurse' },
  'Paggamit ng Droga sa Shelter':
    { severity: 'Critical', interventions: ['Drug test', 'Blotter', 'Case filing'], assessor: 'Nurse' },
  'Paggamit ng Tablet (Hindi Ayon sa Rules)':
    { severity: 'Major', interventions: ['2 weeks Privilege Suspension', '2 weeks no tablet'], assessor: 'Social Worker' },
  'Pakikipag-away / Pananakit / Pakikipagsuntukan (Fighting)':
    { severity: 'Major', interventions: ['1 day household chores', 'Laundry of bedsheets', '1 week privilege suspension', 'Psychosocial activity'], assessor: 'Psychologist' },
  'Pagsira ng Gamit sa Shelter (Property Damage)':
    { severity: 'Major', interventions: ['Replacement/Payment of item', 'Character building', 'Counseling'], assessor: 'Social Worker' },
  'Pagbasag ng Salamin / Paggawa ng Sandata (Dangerous Object)':
    { severity: 'Critical', interventions: ['Replacement/Payment', '1 day isolation', 'Privilege suspension', 'Psychosocial activity'], assessor: 'Psychologist' },
  'Paglalagay ng Tattoo / Piercing / Bulitas':
    { severity: 'Major', interventions: ['Laundry of bedsheets and towels', 'Psychosocial activity'], assessor: 'Nurse' },
  'Kawalang Respeto sa Residente/Staff/Bisita (Pagmumura)':
    { severity: 'Major', interventions: ['1 day household chores', '1 week privilege suspension', 'Character building', 'Counseling'], assessor: 'Social Worker' },
  'Sexually Deviant Behavior (Paninilip)':
    { severity: 'Critical', interventions: ['Medical/psychological check-up', 'Case conference'], assessor: 'Psychologist' },
  'Pagtanggi sa Intervention (Refusal)':
    { severity: 'Major', interventions: ['Verbal warning', 'Still required to do intervention', 'Psychosocial activity'], assessor: 'Social Worker' },
};
const MINOR_INTERVENTION = ['Verbal warning / Dialogue', 'Psychosocial activity', 'Privilege restriction'];

const SEV_BADGE: Record<string, string> = {
  Critical: 'bg-red-100 text-red-700',
  Major:    'bg-orange-100 text-orange-700',
  Minor:    'bg-yellow-100 text-yellow-700',
};
const URGENCY_COLOR: Record<string, string> = {
  Critical: 'text-red-600 bg-red-50 border-red-200',
  Severe:   'text-orange-600 bg-orange-50 border-orange-200',
  Moderate: 'text-yellow-600 bg-yellow-50 border-yellow-200',
  Good:     'text-green-600 bg-green-50 border-green-200',
};

type ActiveTab = 'active' | 'done';
type SevFilter = 'All' | 'Critical' | 'Major' | 'Minor';

export function InterventionTracker() {
  const { children, violations, updateViolation } = useData();
  const navigate = useNavigate();

  const [tab, setTab] = useState<ActiveTab>('active');
  const [search, setSearch] = useState('');
  const [sevFilter, setSevFilter] = useState<SevFilter>('All');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [markingDone, setMarkingDone] = useState<string | null>(null);

  // Split violations: active = not Resolved, done = Resolved
  const activeChildren = children.filter(c => c.status !== 'Discharged');

  const buildTracks = (resolved: boolean) => {
    return activeChildren.flatMap(child => {
      const childViolations = violations.filter(v =>
        v.residentId === child.id &&
        (resolved ? v.status === 'Resolved' : v.status !== 'Resolved')
      );
      if (childViolations.length === 0) return [];
      const tracks = childViolations.map(v => {
        const matrix = INTERVENTION_MATRIX[v.type || ''];
        return {
          violation: v,
          interventions: matrix ? matrix.interventions : MINOR_INTERVENTION,
          assessor: matrix ? matrix.assessor : 'Social Worker',
          severity: (v.severity as string) || 'Minor',
        };
      });
      const allViolations = violations.filter(v => v.residentId === child.id);
      const totalPoints = allViolations.reduce((s, v) => s + (v.points || 0), 0);
      const urgency = totalPoints >= 10 ? 'Critical' : totalPoints >= 6 ? 'Severe' : totalPoints >= 3 ? 'Moderate' : 'Good';
      return [{ child, tracks, urgency, count: childViolations.length }];
    })
    .filter(ci => !search || ci.child.name.toLowerCase().includes(search.toLowerCase()))
    .filter(ci => sevFilter === 'All' || ci.tracks.some(t => t.severity === sevFilter))
    .sort((a, b) => b.count - a.count);
  };

  const activeList = useMemo(() => buildTracks(false), [children, violations, search, sevFilter]);
  const doneList   = useMemo(() => buildTracks(true),  [children, violations, search, sevFilter]);

  const totalPending   = useMemo(() => violations.filter(v => v.status !== 'Resolved' && !v.actionTaken).length, [violations]);
  const totalInProgress= useMemo(() => violations.filter(v => v.status !== 'Resolved' && !!v.actionTaken).length, [violations]);
  const totalDone      = useMemo(() => violations.filter(v => v.status === 'Resolved').length, [violations]);
  const totalEscalated = useMemo(() => violations.filter(v => v.status !== 'Resolved' && v.severity === 'Critical').length, [violations]);

  const handleMarkDone = async (violationId: string) => {
    setMarkingDone(violationId);
    await updateViolation(violationId, {
      status: 'Resolved',
      reviewedBy: 'Staff',
      actionTaken: 'Intervention completed and marked as done.',
    });
    setMarkingDone(null);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-[#2F3E46] p-6 rounded-xl border-b-4 border-[#FFD100]">
        <div className="flex items-center gap-3 mb-1">
          <Shield className="w-7 h-7 text-[#FFD100]" />
          <h2 className="text-2xl font-bold text-white">Intervention Tracker</h2>
        </div>
        <p className="text-gray-300 text-sm">Monitor active violations and prescribed interventions per resident based on the SCH matrix</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Pending',     value: totalPending,    icon: Clock,         color: 'text-yellow-600', bg: 'bg-yellow-100' },
          { label: 'In Progress', value: totalInProgress, icon: Activity,      color: 'text-blue-600',   bg: 'bg-blue-100'   },
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

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-gray-200 pb-0">
        {([
          { key: 'active', label: 'Active / Pending', count: activeList.reduce((s,ci) => s + ci.count, 0) },
          { key: 'done',   label: 'Done',             count: doneList.reduce((s,ci) => s + ci.count, 0)   },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setExpanded(null); }}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-all -mb-px ${
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

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search resident..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#FFD100]"
          />
        </div>
        <div className="flex gap-2">
          {(['All', 'Critical', 'Major', 'Minor'] as const).map(f => (
            <button
              key={f}
              onClick={() => setSevFilter(f)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border-2 transition-all ${
                sevFilter === f
                  ? f === 'Critical' ? 'bg-red-600 border-red-600 text-white'
                  : f === 'Major'    ? 'bg-orange-500 border-orange-500 text-white'
                  : f === 'Minor'    ? 'bg-yellow-500 border-yellow-500 text-white'
                  : 'bg-[#2F3E46] border-[#2F3E46] text-white'
                  : 'border-gray-200 text-gray-500 hover:border-gray-300 bg-white'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
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
          {(tab === 'active' ? activeList : doneList).map(({ child, tracks, urgency, count }) => (
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
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${URGENCY_COLOR[urgency] || ''}`}>{urgency}</span>
                  <span className="text-xs font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                    {count} {tab === 'done' ? 'completed' : 'active'}
                  </span>
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={e => { e.stopPropagation(); navigate(`/children/${child.id}`); }}>
                    Profile <ArrowRight className="w-3 h-3 ml-1" />
                  </Button>
                </div>
              </button>

              {/* Expanded tracks */}
              {expanded === child.id && (
                <div className="border-t border-gray-100 bg-gray-50 p-4 space-y-3">
                  {tracks.map((track, idx) => (
                    <div key={idx} className={`rounded-xl border p-3 bg-white ${
                      tab === 'done'                  ? 'border-green-200' :
                      track.severity === 'Critical'   ? 'border-red-200'   :
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
                            {track.violation.date} · Reported by: {track.violation.reportedBy || '—'} · Assessor: {track.assessor}
                          </p>
                        </div>
                        {tab === 'done' ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200 shrink-0 flex items-center gap-1">
                            <CheckCheck className="w-3 h-3" /> Done
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white shrink-0"
                            disabled={markingDone === track.violation.id}
                            onClick={() => track.violation.id && handleMarkDone(track.violation.id)}
                          >
                            {markingDone === track.violation.id
                              ? 'Saving...'
                              : <><CheckCircle2 className="w-3 h-3 mr-1" /> Mark Done</>}
                          </Button>
                        )}
                      </div>

                      {/* Intervention steps */}
                      <div className="border-t border-gray-100 pt-2 mt-1">
                        <p className="text-[10px] font-bold uppercase text-gray-400 tracking-wider mb-1.5">Prescribed Interventions</p>
                        <ol className="space-y-1">
                          {track.interventions.map((step, si) => (
                            <li key={si} className="flex items-start gap-2 text-xs text-gray-700">
                              <span className={`font-bold shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] mt-0.5 ${
                                tab === 'done' ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'
                              }`}>{si + 1}</span>
                              <span className={tab === 'done' ? 'line-through text-gray-400' : ''}>{step}</span>
                            </li>
                          ))}
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
    </div>
  );
}
