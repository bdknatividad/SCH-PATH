import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/app/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import {
  Users, Calendar, AlertCircle, FileText, ClipboardCheck,
  Zap, X, Download, Brain, HeartPulse, Briefcase,
  ChevronDown, ChevronUp, Upload, CheckCircle2, Circle, ExternalLink,
  Search, ArrowUpDown, Shield, TrendingUp, FolderOpen, FolderX,
  ArrowRight, Activity, UserCheck, Clock, BarChart3,
} from 'lucide-react';
import { useData, Child } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';

// ── FORM CATALOGUE ──────────────────────────────────────────────────────────
interface FormEntry {
  name: string;
  description: string;
  file: string; // filename inside SCH FORMS (or psych forms/)
  path: string; // for future routing; unused for now
}

const SW_FORMS: FormEntry[] = [
  { name: 'Admission Slip',               description: 'Form 00 — Initial intake & admission record',              file: '/forms/admission-slip.pdf',          path: '' },
  { name: 'Intake Baseline Data',         description: 'Form 02 — Comprehensive intake & baseline information',    file: '/forms/intake-baseline.pdf',         path: '' },
  { name: 'Child Needs Assessment',       description: 'Form 05-A — Behavioral observation (Caring Services)',     file: '/forms/child-needs-assessment.pdf',  path: '' },
  { name: 'Kasunduan',                    description: 'Behavioral covenant / agreement with resident',            file: '/forms/kasunduan.pdf',               path: '' },
  { name: 'Visitor Log (Adult)',          description: 'CPP visitor registration for sponsors & donors',           file: '/forms/visitor-log-adult.pdf',       path: '' },
  { name: 'Visitor Log (Students)',       description: 'CPP visitor registration for student visitors',            file: '/forms/visitor-log-students.pdf',    path: '' },
];

const PSYCH_FORMS: FormEntry[] = [
  { name: 'CANS Assessment',             description: 'Child & Adolescent Needs & Strengths assessment tool',     file: '/forms/psych/cans.pdf',              path: '' },
  { name: 'MBTI Personality Test',       description: 'Myers-Briggs Type Indicator personality assessment',       file: '/forms/psych/mbti.pdf',              path: '' },
  { name: 'Mental Health 20 Questions',  description: 'Standard 20-item mental health screening tool',            file: '/forms/psych/mental20q.pdf',         path: '' },
  { name: 'SSCT (Sacks)',                description: 'Sacks Sentence Completion Test (Tagalog)',                 file: '/forms/psych/ssct.pdf',              path: '' },
];

const NURSE_FORMS: FormEntry[] = [
  { name: 'Health Record Form',          description: 'Form 10-AB&C — Medical history, treatments & vitals',      file: '/forms/health-record.pdf',           path: '' },
];

// Opens the PDF in a new tab for preview; falls back to direct download
function openForm(file: string, name: string) {
  const link = document.createElement('a');
  link.href = file;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.download = name + '.pdf';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ── FORM CARD COMPONENT ─────────────────────────────────────────────────────
function FormItem({ form }: { form: FormEntry }) {
  return (
    <div className="flex items-center justify-between gap-3 p-3 rounded-xl border border-gray-100 bg-white hover:border-[#FFD100] hover:shadow-sm transition-all group">
      <div className="flex items-center gap-3 min-w-0">
        <div className="p-2 rounded-lg bg-gray-50 group-hover:bg-[#FFD100]/10 transition-colors shrink-0">
          <FileText className="w-4 h-4 text-[#2F3E46]" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-[#2F3E46] leading-tight">{form.name}</p>
          <p className="text-xs text-gray-400 mt-0.5 leading-tight line-clamp-1">{form.description}</p>
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => openForm(form.file, form.name)}
        className="shrink-0 h-8 px-3 text-xs font-bold text-[#2F3E46] hover:bg-[#FFD100] hover:text-[#2F3E46] gap-1.5 transition-all"
        title={`Open ${form.name}`}
      >
        <Download className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Open</span>
      </Button>
    </div>
  );
}

// ── COLLAPSIBLE FORMS SECTION ───────────────────────────────────────────────
interface FormsSectionProps {
  title: string;
  role: string;
  icon: React.ReactNode;
  accentColor: string;
  bgColor: string;
  forms: FormEntry[];
  defaultOpen?: boolean;
}

function FormsSection({ title, role, icon, accentColor, bgColor, forms, defaultOpen = false }: FormsSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Card className="shadow-sm border-none overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-5 text-left transition-colors hover:bg-gray-50"
      >
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl" style={{ backgroundColor: bgColor }}>
            <span style={{ color: accentColor }}>{icon}</span>
          </div>
          <div>
            <p className="font-black text-[#2F3E46] text-base">{title}</p>
            <p className="text-xs text-gray-400">{forms.length} form{forms.length !== 1 ? 's' : ''} available</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            className="text-[10px] font-bold uppercase px-2 py-0.5 border-none"
            style={{ backgroundColor: bgColor, color: accentColor }}
          >
            {role}
          </Badge>
          {open
            ? <ChevronUp className="w-4 h-4 text-gray-400" />
            : <ChevronDown className="w-4 h-4 text-gray-400" />
          }
        </div>
      </button>

      {open && (
        <div className="px-5 pb-5">
          <div className="h-px bg-gray-100 mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {forms.map((form) => (
              <FormItem key={form.file} form={form} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

// ── CHILDREN OVERVIEW MODAL ─────────────────────────────────────────────────
interface ChildrenOverviewModalProps {
  open: boolean;
  onClose: () => void;
  children: Child[];
  violations: any[];
  onChildClick: (id: string) => void;
}

function ChildrenOverviewModal({ open, onClose, children: allChildren, violations, onChildClick }: ChildrenOverviewModalProps) {
  const [tab, setTab] = useState<'Active' | 'Discharged'>('Active');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<'name' | 'age' | 'admissionDate' | 'phase' | 'risk'>('name');
  const [sortAsc, setSortAsc] = useState(true);

  if (!open) return null;

  const activeChildren = allChildren.filter(c => !c.status || c.status === 'Active');
  const dischargedChildren = allChildren.filter(c => c.status === 'Discharged');
  const getRisk = (childId: string) => {
    const pts = violations
      .filter(v => v.residentId === childId && v.status !== 'Resolved')
      .reduce((s: number, v: any) => s + v.points, 0);
    if (pts >= 10) return { label: 'Critical', order: 0, dot: 'bg-red-500', badge: 'bg-red-100 text-red-700' };
    if (pts >= 6) return { label: 'Severe', order: 1, dot: 'bg-orange-400', badge: 'bg-orange-100 text-orange-700' };
    if (pts >= 3) return { label: 'Moderate', order: 2, dot: 'bg-yellow-400', badge: 'bg-yellow-100 text-yellow-700' };
    return { label: 'Good', order: 3, dot: 'bg-green-400', badge: 'bg-green-100 text-green-700' };
  };

  // Filter by tab
  const tabChildren = tab === 'Active' ? activeChildren : dischargedChildren;

  // Filter by search
  const filtered = tabChildren.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'name': cmp = a.name.localeCompare(b.name); break;
      case 'age': cmp = (a.age || 0) - (b.age || 0); break;
      case 'admissionDate': cmp = (a.admissionDate || '').localeCompare(b.admissionDate || ''); break;
      case 'phase': cmp = (a.casePhase || '').localeCompare(b.casePhase || ''); break;
      case 'risk': cmp = getRisk(a.id).order - getRisk(b.id).order; break;
    }
    return sortAsc ? cmp : -cmp;
  });

  const toggleSort = (key: typeof sortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(true); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[9999] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="bg-[#2F3E46] p-4 text-white flex justify-between items-center shrink-0">
          <div>
            <h3 className="font-bold text-lg flex items-center gap-2">
              <Users className="w-5 h-5 text-[#FFD100]" /> Total Children Overview
            </h3>
            <p className="text-xs text-gray-300 mt-0.5">{allChildren.length} total residents in the system</p>
          </div>
          <button onClick={onClose} className="hover:bg-white/10 rounded-full p-1.5 transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Summary badges */}
        <div className="p-4 border-b border-gray-100 flex flex-wrap gap-3">
          <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-3 py-2">
            <span className="text-lg font-bold text-green-700">{activeChildren.length}</span>
            <span className="text-xs text-green-600 font-medium">Active</span>
          </div>
          <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2">
            <span className="text-lg font-bold text-gray-700">{dischargedChildren.length}</span>
            <span className="text-xs text-gray-500 font-medium">Discharged</span>
          </div>
        </div>

        {/* Tabs + Search */}
        <div className="px-4 pt-2 pb-2 flex items-center gap-3 border-b border-gray-100">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setTab('Active')}
              className={`text-xs font-bold px-3 py-1.5 rounded-md transition-colors ${
                tab === 'Active' ? 'bg-[#2F3E46] text-white' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Active ({activeChildren.length})
            </button>
            <button
              onClick={() => setTab('Discharged')}
              className={`text-xs font-bold px-3 py-1.5 rounded-md transition-colors ${
                tab === 'Discharged' ? 'bg-[#2F3E46] text-white' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Discharged ({dischargedChildren.length})
            </button>
          </div>
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name..."
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#FFD100]"
            />
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                {[
                  { key: 'name' as const, label: 'Name' },
                  { key: 'age' as const, label: 'Age' },
                  { key: 'phase' as const, label: 'Phase' },
                  { key: 'admissionDate' as const, label: 'Admission Date' },
                  { key: 'risk' as const, label: 'Risk' },
                ].map(col => (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    className="p-3 text-left font-bold text-gray-500 uppercase tracking-wide cursor-pointer hover:text-[#2F3E46] select-none"
                  >
                    <span className="flex items-center gap-1">
                      {col.label}
                      <ArrowUpDown className={`w-3 h-3 ${sortKey === col.key ? 'text-[#FFD100]' : 'text-gray-300'}`} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sorted.length > 0 ? sorted.map((child) => {
                const risk = getRisk(child.id);
                return (
                  <tr
                    key={child.id}
                    onClick={() => onChildClick(child.id)}
                    className="hover:bg-[#FFD100]/5 cursor-pointer transition-colors"
                  >
                    <td className="p-3 font-semibold text-[#2F3E46]">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${risk.dot}`} />
                        {child.name}
                      </div>
                    </td>
                    <td className="p-3 text-gray-600">{child.age}</td>
                    <td className="p-3">
                      <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-[10px] font-semibold">
                        {child.casePhase || 'Admission'}
                      </span>
                    </td>
                    <td className="p-3 text-gray-500">{child.admissionDate || '—'}</td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${risk.badge}`}>
                        {risk.label}
                      </span>
                    </td>
                  </tr>
                );
              }) : (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-gray-400 italic">No children found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t p-3 flex justify-between items-center bg-gray-50">
          <p className="text-xs text-gray-400">Showing {sorted.length} of {tabChildren.length} {tab.toLowerCase()} residents</p>
          <button onClick={onClose} className="text-xs font-bold text-[#2F3E46] border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-100">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── DASHBOARD ───────────────────────────────────────────────────────────────
export function Dashboard() {
  const navigate = useNavigate();
  const { children, activities, assessments, violations, documents } = useData();
  const { user } = useAuth();

  const [showAdmissionModal, setShowAdmissionModal] = useState(false);
  const [showDischargeModal, setShowDischargeModal] = useState(false);
  const [showChildrenModal, setShowChildrenModal] = useState(false);
  const [docAlertOpen, setDocAlertOpen] = useState(false);
  const [activeCardModal, setActiveCardModal] = useState<string | null>(null);
  const [cardSearch, setCardSearch] = useState('');
  const [showScheduleChoice, setShowScheduleChoice] = useState(false);
  const [monitoringFilter, setMonitoringFilter] = useState<string | null>(null);
  const [monitoringSearch, setMonitoringSearch] = useState('');

  const openForm = (file: string, name: string) => {
    const link = document.createElement('a');
    link.href = file;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.download = name + '.pdf';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const userRole = user?.role?.toLowerCase() || '';

  const roleLabels: Record<string, string> = {
    centerhead:   'CENTER HEAD',
    admin:        'CENTER HEAD',
    nurse:        'NURSE',
    socialworker: 'SOCIAL WORKER',
    educator:     'EDUCATOR',
    psychologist: 'PSYCHOLOGIST',
  };

  const displayRole = user?.role
    ? (roleLabels[user.role.toLowerCase()] || user.role.toUpperCase())
    : 'GUEST';

  const activeChildren  = children.filter(c => !c.status || c.status === 'Active');
  const todayString     = new Date().toISOString().slice(0, 10);
  const todayActivities = activities.filter(a => a.date === todayString);
  const scheduledAssessments = assessments.filter(a => a.status === 'Scheduled');

  const PHASE_NAME_MAP: Record<string, string> = {
    'Admission Phase': 'Admission',
    'Orientation Phase': 'Orientation',
    'Enculturation/Observation Phase': 'Observation',
    'Caring & Rehabilitation Phase / DP or IPP Implementation': 'Rehabilitation',
    'Pre-integration Phase': 'Pre-integration',
    'Reintegration/Aftercare Program': 'Reintegration',
  };

  const PHASE_REQUIRED_DOCS: Record<string, string[]> = {
    Admission:         ['Court Order', 'OCP Resolution', 'Case Information', 'Diversion Plan Referral Letter', 'Medical Certificate / Birth Certificate', 'Baptismal Certificate'],
    Orientation:       [],
    Observation:       ['Psychological Testing', 'Discernment Assessment', 'SCSR'],
    Rehabilitation:    [],
    'Pre-integration': ['Parenting Capability Assessment'],
    Reintegration:     [],
  };

  const childrenWithMissingDocs = activeChildren.map(child => {
    const phaseRaw = child.casePhase || 'Admission';
    const phase = PHASE_NAME_MAP[phaseRaw] || phaseRaw;
    const required = PHASE_REQUIRED_DOCS[phase] || [];
    const childDocs = documents.filter(d => d.residentId === child.id);
    const missing = required.filter(req => {
      const uploaded = childDocs.find(d => d.title === req);
      return !uploaded || uploaded.status === 'Rejected';
    });
    const pending = required.filter(req => {
      const uploaded = childDocs.find(d => d.title === req);
      return uploaded && uploaded.status === 'Submitted';
    });
    const approved = required.filter(req => {
      const uploaded = childDocs.find(d => d.title === req);
      return uploaded && uploaded.status === 'Approved';
    });
    return { child, phase, required, missing, pending, approved };
  }).filter(r => r.required.length > 0 && (r.missing.length > 0 || r.pending.length > 0));


  const alerts: { message: string; type: 'alert'; link: string }[] = [];

  // Scheduled Today = total assessments scheduled for today
  const todayAssessments = assessments.filter(a => a.date === todayString && a.status === 'Scheduled');
  const scheduledTodayCount = todayAssessments.length;

  // ── getResidentStatus must be defined first ─────────────────────────
  const getResidentStatus = (residentId: string) => {
    const pts = violations
      .filter(v => v.residentId === residentId && v.status !== 'Resolved')
      .reduce((s, v) => s + v.points, 0);
    if (pts >= 10) return { label: 'Critical',      color: 'bg-red-500',    text: 'text-red-700',    badge: 'bg-red-100 text-red-700',     dot: 'bg-red-500'    };
    if (pts >= 6)  return { label: 'Severe Risk',   color: 'bg-orange-400', text: 'text-orange-700', badge: 'bg-orange-100 text-orange-700', dot: 'bg-orange-400' };
    if (pts >= 3)  return { label: 'Moderate Risk', color: 'bg-yellow-400', text: 'text-yellow-700', badge: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-400' };
    return             { label: 'Good Standing', color: 'bg-green-400',  text: 'text-green-700',  badge: 'bg-green-100 text-green-700',   dot: 'bg-green-400'  };
  };

  // ── Computed stats ─────────────────────────────────────────────────
  const activeCount    = children.filter(c => c.status !== 'Discharged').length;
  const closedCount    = children.filter(c => c.status === 'Discharged').length;
  const openCount      = activeCount;

  const goodCount      = activeChildren.filter(c => getResidentStatus(c.id).label === 'Good Standing').length;
  const moderateCount  = activeChildren.filter(c => getResidentStatus(c.id).label === 'Moderate Risk').length;
  const severeCount    = activeChildren.filter(c => getResidentStatus(c.id).label === 'Severe Risk').length;
  const criticalCount  = activeChildren.filter(c => getResidentStatus(c.id).label === 'Critical').length;

  // Phase counts
  const PHASE_LABELS: Record<string,string> = {
    'Admission Phase':                          'Admission',
    'Orientation Phase':                         'Orientation',
    'Enculturation/Observation Phase':           'Observation',
    'Caring & Rehabilitation Phase / DP or IPP Implementation': 'Rehab',
    'Pre-integration Phase':                     'Pre-integration',
    'Reintegration/Aftercare Program':           'Reintegration',
  };
  const phaseCounts = Object.keys(PHASE_LABELS).map(phase => ({
    phase,
    short: PHASE_LABELS[phase],
    count: activeChildren.filter(c => c.casePhase === phase).length,
  })).filter(p => p.count > 0);

  // Offense tracking per child (based on violation category counts)
  const getOffenseLevel = (residentId: string) => {
    const childViolations = violations.filter(v => v.residentId === residentId && v.status !== 'Resolved');
    const majorCount  = childViolations.filter(v => v.severity === 'Major' || v.severity === 'Critical').length;
    const minorCount  = childViolations.filter(v => v.severity === 'Minor').length;
    if (majorCount >= 3 || (majorCount >= 1 && minorCount >= 5)) return '3rd Offense+';
    if (majorCount >= 2 || (majorCount >= 1 && minorCount >= 3)) return '2nd Offense';
    if (majorCount >= 1 || minorCount >= 3) return '1st Offense';
    return 'No Violations';
  };

  // Role-based stats cards (Active Residents removed, others clickable)
  const buildStats = () => {
    const base = [
      { title: 'Closed Cases',    value: String(closedCount),          icon: FolderX,    color: '#64748b', sub: 'Discharged', clickable: true },
      { title: 'Scheduled Today', value: String(scheduledTodayCount),  icon: Calendar,   color: '#2F3E46', sub: "Today's schedule", clickable: true },
    ];
    if (['centerhead','admin'].includes(userRole)) {
      base.push({ title: 'Total Residents', value: String(activeCount), icon: Users, color: '#2F3E46', sub: 'Active only', clickable: true });
    }
    return base;
  };
  const stats = buildStats();

  // Decide which form sections this role should see
  const showSW    = ['centerhead', 'admin', 'socialworker'].includes(userRole);
  const showPsych = ['centerhead', 'admin', 'psychologist'].includes(userRole);
  const showNurse = ['centerhead', 'admin', 'nurse'].includes(userRole);
  const showForms = showSW || showPsych || showNurse;

  const flaggedResidents = activeChildren
    .map(c => ({ child: c, status: getResidentStatus(c.id) }))
    .sort((a, b) => {
      const order = ['Critical', 'Severe Risk', 'Moderate Risk', 'Good Standing'];
      return order.indexOf(a.status.label) - order.indexOf(b.status.label);
    });

  // ── Role-specific title & subtitle ─────────────────────────────────
  const roleTitle =
    userRole === 'centerhead' || userRole === 'admin' ? 'Center Head Dashboard' :
    userRole === 'socialworker' ? 'Social Worker Dashboard' :
    userRole === 'psychologist' ? 'Psychologist Dashboard' :
    userRole === 'nurse' ? 'Nurse Dashboard' :
    userRole === 'educator' ? 'Educator Dashboard' : 'Dashboard';

  const roleSub =
    userRole === 'socialworker' ? 'Case management, document uploads & resident records' :
    userRole === 'psychologist' ? 'Assessments, psychological records & evaluations' :
    userRole === 'nurse' ? 'Health monitoring, medical records & check-ups' :
    userRole === 'educator' ? 'Education programs, activities & resident progress' :
    'Full system overview & management';

  // ── My assigned assessments (psychologist) ───────────────────────
  const myAssessments = assessments.filter(a =>
    a.status === 'Scheduled' &&
    (a.assessor?.toLowerCase().includes(userRole) ||
     (userRole === 'psychologist' && (a.type?.toLowerCase().includes('psych') || a.type?.toLowerCase().includes('assessment'))))
  );

  // ── My assigned activities (educator) ────────────────────────────
  const myActivities = activities.filter(a =>
    a.status !== 'Cancelled' &&
    (Array.isArray(a.facilitators)
      ? a.facilitators.some((f: any) => String(f).toLowerCase().includes(user?.username?.toLowerCase() || ''))
      : String(a.facilitators || '').toLowerCase().includes(user?.username?.toLowerCase() || ''))
  );

  // ── Pending doc approvals (nurse, socialworker) ──────────────────
  const pendingApprovals = documents.filter(d =>
    d.status === 'Submitted' &&
    (userRole === 'nurse'
      ? ['Health Record Form', 'Medical Certificate / Birth Certificate', 'Medical Clearance'].includes(d.title || '')
      : userRole === 'socialworker'
      ? !['Psychological Testing', 'Discernment Assessment', 'Mental Health Report'].includes(d.title || '')
      : true)
  );

  return (
    <div className="space-y-6 relative">

      {/* Header */}
      <div className="bg-[#2F3E46] p-6 rounded-xl shadow-md border-b-4 border-[#FFD100]">
        <h2 className="text-2xl font-bold mb-1 text-white">{roleTitle}</h2>
        <p className="text-gray-300">
          Welcome back, <span className="font-bold text-[#FFD100] uppercase">{displayRole}</span>
          <span className="text-gray-400 text-sm ml-2">— {roleSub}</span>
        </p>
      </div>

      {/* Stats Cards — all clickable */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card
              key={stat.title}
              className="border-none shadow-sm hover:shadow-md transition-shadow cursor-pointer hover:ring-2 hover:ring-[#FFD100] active:scale-95 transition-transform"
              onClick={() => {
                if (stat.title === 'Total Residents') {
                  navigate('/children?filter=Active');
                } else if (stat.title === 'Closed Cases') {
                  navigate('/children?filter=Discharged');
                } else if (stat.title === 'Scheduled Today') {
                  setShowScheduleChoice(true);
                }
              }}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{stat.title}</p>
                    <p className="text-3xl font-bold mt-1 text-[#2F3E46]">{stat.value}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">{stat.sub}</p>
                  </div>
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[#FFD100]/20 shrink-0">
                    <Icon className="w-5 h-5 text-[#2F3E46]" />
                  </div>
                </div>
                <p className="text-[10px] text-[#2F3E46] opacity-50 mt-2 font-medium">Click to view →</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Urgency Indicators + Phase Counts Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Urgency Distribution */}
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2 border-b border-gray-100">
            <CardTitle className="text-sm font-bold text-[#2F3E46] flex items-center gap-2">
              <Shield className="w-4 h-4 text-[#FFD100]" /> Resident Urgency Level
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 space-y-2">
            {[
              { label: 'Critical', count: criticalCount, bg: 'bg-red-100',    text: 'text-red-700',    bar: 'bg-red-500'    },
              { label: 'Severe',   count: severeCount,   bg: 'bg-orange-100', text: 'text-orange-700', bar: 'bg-orange-500' },
              { label: 'Moderate', count: moderateCount, bg: 'bg-yellow-100', text: 'text-yellow-700', bar: 'bg-yellow-400' },
              { label: 'Good',     count: goodCount,     bg: 'bg-green-100',  text: 'text-green-700',  bar: 'bg-green-500'  },
            ].map(u => (
              <div key={u.label} className="flex items-center gap-3">
                <span className={`text-xs font-semibold w-16 ${u.text}`}>{u.label}</span>
                <div className="flex-1 h-5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${u.bar} rounded-full transition-all`}
                    style={{ width: activeChildren.length ? `${(u.count/activeChildren.length)*100}%` : '0%' }}
                  />
                </div>
                <span className={`text-xs font-bold w-6 text-right ${u.text}`}>{u.count}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Phase Distribution */}
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2 border-b border-gray-100">
            <CardTitle className="text-sm font-bold text-[#2F3E46] flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-[#FFD100]" /> Children per Intervention Phase
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 space-y-2">
            {phaseCounts.length === 0 ? (
              <p className="text-xs text-gray-400 italic">No active children</p>
            ) : phaseCounts.map(p => (
              <div key={p.phase} className="flex items-center gap-3">
                <span className="text-xs text-gray-600 w-28 truncate" title={p.phase}>{p.short}</span>
                <div className="flex-1 h-5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#2F3E46] rounded-full transition-all"
                    style={{ width: activeChildren.length ? `${(p.count/activeChildren.length)*100}%` : '0%' }}
                  />
                </div>
                <span className="text-xs font-bold w-5 text-right text-[#2F3E46]">{p.count}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Resident Monitoring Overview — dropdown status groups */}
      {activeChildren.length > 0 && (
        <Card className="shadow-sm border-none">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-md text-[#2F3E46]">
              <Activity className="w-5 h-5 text-[#FFD100]" /> Resident Monitoring Overview
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 space-y-2">
            {[
              { key: 'Critical',       label: 'Critical', badge: 'bg-red-100 text-red-700',       dot: 'bg-red-500',    count: criticalCount },
              { key: 'Severe Risk',    label: 'Severe',   badge: 'bg-orange-100 text-orange-700', dot: 'bg-orange-500', count: severeCount },
              { key: 'Moderate Risk',  label: 'Moderate', badge: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-400', count: moderateCount },
              { key: 'Good Standing',  label: 'Good',     badge: 'bg-green-100 text-green-700',   dot: 'bg-green-500',  count: goodCount },
            ].map(group => (
              <div key={group.key} className="border border-gray-100 rounded-xl overflow-hidden">
                {/* Dropdown header — click to expand */}
                <button
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
                  onClick={() => setMonitoringFilter(monitoringFilter === group.key ? null : group.key)}
                >
                  <div className="flex items-center gap-3">
                    <span className={`w-3 h-3 rounded-full ${group.dot}`} />
                    <span className="font-semibold text-sm text-[#2F3E46]">{group.label}</span>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${group.badge}`}>
                      {group.count} resident{group.count !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${monitoringFilter === group.key ? 'rotate-180' : ''}`} />
                </button>

                {/* Expanded resident list */}
                {monitoringFilter === group.key && (
                  <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 space-y-2">
                    {/* Search within group */}
                    <div className="relative">
                      <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        type="text"
                        placeholder={`Search ${group.label} residents...`}
                        value={monitoringSearch}
                        onChange={e => setMonitoringSearch(e.target.value)}
                        className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#FFD100] bg-white"
                      />
                    </div>
                    {/* Resident rows */}
                    {flaggedResidents
                      .filter(({ status }) => status.label === group.key)
                      .filter(({ child }) => !monitoringSearch || child.name.toLowerCase().includes(monitoringSearch.toLowerCase()))
                      .map(({ child, status }) => {
                        const offense = getOffenseLevel(child.id);
                        const phaseShort = PHASE_LABELS[child.casePhase || ''] || child.casePhase || 'Admission';
                        const action =
                          group.key === 'Critical'      ? 'Immediate case conference required' :
                          group.key === 'Severe Risk'   ? 'Schedule psychological evaluation' :
                          group.key === 'Moderate Risk' ? 'Monitor + behavioral session' :
                          'Continue current plan';
                        return (
                          <div key={child.id} className="flex items-center justify-between bg-white rounded-lg px-3 py-2 border border-gray-100">
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <span className={`w-2 h-2 rounded-full shrink-0 ${status.dot}`} />
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-[#2F3E46] truncate">{child.name}</p>
                                <p className="text-[10px] text-gray-400">{phaseShort} · {offense}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[10px] text-gray-500 hidden sm:block">{action}</span>
                              <button
                                onClick={() => navigate(`/children/${child.id}`)}
                                className="text-[10px] border border-gray-200 px-2 py-1 rounded hover:bg-[#FFD100] hover:border-[#FFD100] transition-all font-semibold"
                              >
                                View
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    {flaggedResidents.filter(({ status }) => status.label === group.key).length === 0 && (
                      <p className="text-xs text-gray-400 italic text-center py-2">No residents in this category.</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ── PSYCHOLOGIST SECTION ── */}
      {userRole === 'psychologist' && (
        <Card className="border-none shadow-sm">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <Brain className="w-5 h-5 text-[#FFD100]" /> My Scheduled Assessments
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            {myAssessments.length === 0 ? (
              <p className="text-sm text-gray-400 italic text-center py-4">No assessments scheduled for you.</p>
            ) : (
              <div className="space-y-2">
                {myAssessments.slice(0, 5).map(a => (
                  <div key={a.id} className="flex items-center justify-between p-3 rounded-lg border border-gray-100 hover:bg-gray-50">
                    <div>
                      <p className="text-sm font-semibold text-[#2F3E46]">{a.title}</p>
                      <p className="text-xs text-gray-400">{a.date} {a.time && `at ${a.time}`} · {a.type}</p>
                    </div>
                    <button onClick={() => navigate('/assessments')} className="text-xs text-[#2F3E46] border border-gray-200 px-2 py-1 rounded hover:bg-[#FFD100] transition-all">View</button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── NURSE SECTION ── */}
      {userRole === 'nurse' && (
        <Card className="border-none shadow-sm">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <HeartPulse className="w-5 h-5 text-[#FFD100]" /> Health Overview
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-blue-50 rounded-xl border border-blue-100">
                <p className="text-xs text-blue-600 font-semibold uppercase tracking-wide">Active Residents</p>
                <p className="text-2xl font-bold text-blue-700">{activeChildren.length}</p>
                <p className="text-xs text-blue-500">Requiring health monitoring</p>
              </div>
              <div className="p-3 bg-orange-50 rounded-xl border border-orange-100">
                <p className="text-xs text-orange-600 font-semibold uppercase tracking-wide">Medical Docs Pending</p>
                <p className="text-2xl font-bold text-orange-700">{pendingApprovals.length}</p>
                <p className="text-xs text-orange-500">Awaiting your review</p>
              </div>
            </div>
            {pendingApprovals.length > 0 && (
              <div>
                <p className="text-xs font-bold text-gray-500 uppercase mb-2">Pending Medical Documents</p>
                {pendingApprovals.slice(0, 4).map(d => (
                  <div key={d.id} className="flex items-center justify-between p-2 rounded border border-gray-100 mb-1">
                    <div>
                      <p className="text-xs font-semibold">{d.title}</p>
                      <p className="text-[10px] text-gray-400">{d.residentName}</p>
                    </div>
                    <button onClick={() => navigate('/documents')} className="text-[10px] text-white bg-[#2F3E46] px-2 py-1 rounded">Review</button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── EDUCATOR SECTION ── */}
      {userRole === 'educator' && (
        <Card className="border-none shadow-sm">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <ClipboardCheck className="w-5 h-5 text-[#FFD100]" /> My Activities & Programs
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className="p-3 bg-purple-50 rounded-xl border border-purple-100">
                <p className="text-xs text-purple-600 font-semibold uppercase">Today's Activities</p>
                <p className="text-2xl font-bold text-purple-700">{todayActivities.length}</p>
              </div>
              <div className="p-3 bg-green-50 rounded-xl border border-green-100">
                <p className="text-xs text-green-600 font-semibold uppercase">Active Residents</p>
                <p className="text-2xl font-bold text-green-700">{activeChildren.length}</p>
              </div>
            </div>
            {todayActivities.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-bold text-gray-500 uppercase">Today's Schedule</p>
                {todayActivities.slice(0, 4).map(a => (
                  <div key={a.id} className="flex items-center gap-3 p-2 rounded-lg border border-gray-100">
                    <div className="w-8 h-8 rounded-lg bg-[#FFD100]/20 flex items-center justify-center shrink-0">
                      <Zap className="w-4 h-4 text-[#2F3E46]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold truncate">{a.title}</p>
                      <p className="text-[10px] text-gray-400">{a.time || 'All day'} · {a.location || 'Shelter'}</p>
                    </div>
                    <button onClick={() => navigate('/activities')} className="text-[10px] border border-gray-200 px-2 py-1 rounded hover:bg-[#FFD100] transition-all">View</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400 italic text-center py-3">No activities scheduled today.</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── SOCIAL WORKER SECTION ── */}
      {userRole === 'socialworker' && (
        <Card className="border-none shadow-sm">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <Briefcase className="w-5 h-5 text-[#FFD100]" /> My Caseload
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div className="p-3 bg-blue-50 rounded-xl border border-blue-100">
                <p className="text-xs text-blue-600 font-semibold uppercase">Active Cases</p>
                <p className="text-2xl font-bold text-blue-700">{activeChildren.length}</p>
              </div>
              <div className="p-3 bg-orange-50 rounded-xl border border-orange-100">
                <p className="text-xs text-orange-600 font-semibold uppercase">Docs Pending</p>
                <p className="text-2xl font-bold text-orange-700">{pendingApprovals.length}</p>
              </div>
              <div className="p-3 bg-green-50 rounded-xl border border-green-100">
                <p className="text-xs text-green-600 font-semibold uppercase">Closed Cases</p>
                <p className="text-2xl font-bold text-green-700">{closedCount}</p>
              </div>
            </div>
            {pendingApprovals.length > 0 && (
              <div>
                <p className="text-xs font-bold text-gray-500 uppercase mb-2">Documents Awaiting Review</p>
                {pendingApprovals.slice(0, 4).map(d => (
                  <div key={d.id} className="flex items-center justify-between p-2 rounded border border-gray-100 mb-1">
                    <div>
                      <p className="text-xs font-semibold">{d.title}</p>
                      <p className="text-[10px] text-gray-400">{d.residentName}</p>
                    </div>
                    <button onClick={() => navigate('/documents')} className="text-[10px] text-white bg-[#2F3E46] px-2 py-1 rounded">Review</button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* System Notifications */}
      {(['admin', 'nurse', 'socialworker', 'centerhead'].includes(userRole)) && (
        <Card className="border-l-4 border-[#FFD100] shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-lg text-[#2F3E46]">
              <AlertCircle className="w-5 h-5 text-[#FFD100]" />
              System Notifications
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">

            {/* Missing/Pending Documents Alert — expandable */}
            {childrenWithMissingDocs.length > 0 ? (
              <div className="border border-orange-200 rounded-xl overflow-hidden">
                <button
                  onClick={() => setDocAlertOpen(!docAlertOpen)}
                  className="w-full flex items-center justify-between p-4 bg-orange-50 hover:bg-orange-100 transition-colors text-left"
                >
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-orange-500 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-orange-800">
                        {childrenWithMissingDocs.filter(r => r.missing.length > 0).length > 0
                          ? `${childrenWithMissingDocs.filter(r => r.missing.length > 0).length} resident(s) have missing required documents`
                          : `${childrenWithMissingDocs.filter(r => r.pending.length > 0).length} resident(s) have documents pending approval`
                        }
                      </p>
                      <p className="text-xs text-orange-600 mt-0.5">Click to see details and take action</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs bg-orange-400 text-white px-2 py-0.5 rounded font-bold">{childrenWithMissingDocs.length}</span>
                    {docAlertOpen ? <ChevronUp className="w-4 h-4 text-orange-500" /> : <ChevronDown className="w-4 h-4 text-orange-500" />}
                  </div>
                </button>

                {docAlertOpen && (
                  <div className="divide-y divide-orange-100">
                    {childrenWithMissingDocs.map(({ child, phase, required, missing, pending, approved }) => (
                      <div key={child.id} className="p-4 bg-white">
                        <div className="flex items-center justify-between mb-2">
                          <div>
                            <span className="font-semibold text-[#2F3E46] text-sm">{child.name}</span>
                            <span className="ml-2 text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">{phase} phase</span>
                          </div>
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => navigate(`/children/${child.id}`)}
                              className="text-xs text-[#2F3E46] border border-gray-300 px-2 py-0.5 rounded hover:bg-gray-50 flex items-center gap-1"
                            >
                              <ExternalLink className="w-3 h-3" /> View Record
                            </button>
                            <button
                              onClick={() => navigate('/documents')}
                              className="text-xs text-white bg-[#2F3E46] px-2 py-0.5 rounded hover:bg-[#1e2a30] flex items-center gap-1"
                            >
                              <Upload className="w-3 h-3" /> Upload
                            </button>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                          {required.map(doc => {
                            const isMissing  = missing.includes(doc);
                            const isPending  = pending.includes(doc);
                            const isApproved = approved.includes(doc);
                            return (
                              <div key={doc} className={`flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-lg ${
                                isApproved ? 'bg-green-50 text-green-700' :
                                isPending  ? 'bg-blue-50 text-blue-700' :
                                             'bg-red-50 text-red-700'
                              }`}>
                                {isApproved ? <CheckCircle2 className="w-3 h-3 shrink-0" /> :
                                 isPending  ? <Circle className="w-3 h-3 shrink-0 fill-blue-300" /> :
                                              <X className="w-3 h-3 shrink-0" />}
                                <span className="truncate">{doc}</span>
                                {isPending && <span className="ml-auto text-[10px] shrink-0 font-medium">Pending review</span>}
                                {isMissing && <span className="ml-auto text-[10px] shrink-0 font-medium">Missing</span>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 p-4 bg-green-50 border border-green-200 rounded-xl">
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                <p className="text-sm text-green-700 font-medium">All required documents are in order.</p>
              </div>
            )}

            {/* Other alerts */}
            {alerts.length > 0 && alerts.map((alert, i) => (
              <div
                key={i}
                onClick={() => navigate(alert.link)}
                className="p-4 rounded-lg cursor-pointer hover:bg-gray-50 transition-all flex items-center justify-between border border-gray-100"
              >
                <p className="text-sm font-medium text-gray-700">{alert.message}</p>
                <span className="text-xs bg-[#FFD100] text-[#2F3E46] px-2 py-1 rounded font-bold">VIEW</span>
              </div>
            ))}

          </CardContent>
        </Card>
      )}

      {/* Schedules */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="shadow-sm border-none">
          <CardHeader className="border-b border-gray-100">
            <CardTitle className="flex items-center gap-2 text-md text-[#2F3E46]">
              <Calendar className="w-5 h-5 text-[#FFD100]" /> Today's Activities
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {todayActivities.length > 0 ? (
              <div className="space-y-3">
                {todayActivities.slice(0, 3).map((activity) => (
                  <div key={activity.id} className="flex items-start gap-3 p-3 rounded-lg bg-gray-50 border-l-4 border-[#2F3E46]">
                    <div className="text-xs font-bold bg-[#2F3E46] text-white p-1 rounded min-w-[60px] text-center">{activity.time}</div>
                    <div className="flex-1">
                      <p className="font-bold text-sm text-[#2F3E46]">{activity.title}</p>
                      <p className="text-xs text-gray-500 italic">{activity.type}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-gray-500 text-sm py-4 italic">Clean schedule for today.</p>
            )}
          </CardContent>
        </Card>

        {userRole !== 'educator' && (
          <Card className="shadow-sm border-none">
            <CardHeader className="border-b border-gray-100">
              <CardTitle className="flex items-center gap-2 text-md text-[#2F3E46]">
                <ClipboardCheck className="w-5 h-5 text-[#FFD100]" /> Pending Assessments
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {scheduledAssessments.length > 0 ? (
                <div className="space-y-3">
                  {scheduledAssessments.slice(0, 3).map((assessment) => (
                    <div key={assessment.id} className="flex items-start gap-3 p-3 rounded-lg bg-gray-50 border-l-4 border-[#FFD100]">
                      <div className="text-xs font-bold text-[#FFD100] bg-[#2F3E46] p-1 rounded min-w-[60px] text-center">{assessment.time || 'TBA'}</div>
                      <div className="flex-1">
                        <p className="font-bold text-sm text-[#2F3E46]">{assessment.title}</p>
                        <p className="text-xs text-gray-400 italic">{assessment.type}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-sm py-4 italic">No pending assessments.</p>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* ── FORMS LIBRARY ── */}
      {showForms && (
        <div className="space-y-3">
          {/* Section header */}
          <div className="flex items-center gap-3 pt-2">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs font-black uppercase tracking-widest text-gray-400 px-2">Forms Library</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>

          {showSW && (
            <FormsSection
              title="Social Worker Forms"
              role="Social Worker"
              icon={<Briefcase className="w-5 h-5" />}
              accentColor="#2F3E46"
              bgColor="#FFD100"
              forms={SW_FORMS}
              defaultOpen={userRole === 'socialworker'}
            />
          )}

          {showPsych && (
            <FormsSection
              title="Psychologist Forms"
              role="Psychologist"
              icon={<Brain className="w-5 h-5" />}
              accentColor="#7C3AED"
              bgColor="#EDE9FE"
              forms={PSYCH_FORMS}
              defaultOpen={userRole === 'psychologist'}
            />
          )}

          {showNurse && (
            <FormsSection
              title="Nurse / Medical Forms"
              role="Nurse"
              icon={<HeartPulse className="w-5 h-5" />}
              accentColor="#059669"
              bgColor="#D1FAE5"
              forms={NURSE_FORMS}
              defaultOpen={userRole === 'nurse'}
            />
          )}
        </div>
      )}

      {/* Quick Actions */}
      <Card className="bg-[#2F3E46] text-white border-none shadow-xl overflow-hidden relative">
        <div className="absolute top-0 right-0 w-32 h-32 bg-[#FFD100]/10 rounded-full -mr-16 -mt-16 blur-3xl" />
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-white">
            <Zap className="w-5 h-5 text-[#FFD100]" /> Quick Actions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 max-w-sm">
            <Button
              variant="outline"
              className="flex flex-col items-center gap-2 h-24 bg-white/5 border-white/10 hover:bg-[#FFD100] hover:text-[#2F3E46] text-white border-2 transition-all group"
              onClick={() => setShowAdmissionModal(true)}
            >
              <FileText className="w-6 h-6 group-hover:scale-110 transition-transform" />
              <span className="text-xs font-bold uppercase tracking-tighter">Admission Slip</span>
            </Button>

            <Button
              variant="outline"
              className="flex flex-col items-center gap-2 h-24 bg-white/5 border-white/10 hover:bg-[#FFD100] hover:text-[#2F3E46] text-white border-2 transition-all group"
              onClick={() => setShowDischargeModal(true)}
            >
              <FileText className="w-6 h-6 group-hover:scale-110 transition-transform" />
              <span className="text-xs font-bold uppercase tracking-tighter">Discharge</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── CHILDREN OVERVIEW MODAL ── */}
      {/* ── SCHEDULE CHOICE DIALOG ── */}
      <Dialog open={showScheduleChoice} onOpenChange={setShowScheduleChoice}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46] flex items-center gap-2">
              <Calendar className="w-5 h-5 text-[#FFD100]" /> Go to Schedule
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-500 mb-2">Where would you like to go?</p>
          <div className="flex flex-col gap-3">
            <button
              onClick={() => { setShowScheduleChoice(false); navigate('/activities'); }}
              className="flex items-center gap-3 p-4 rounded-xl border-2 border-gray-200 hover:border-[#FFD100] hover:bg-[#FFD100]/5 transition-all text-left"
            >
              <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center shrink-0">
                <Zap className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="font-bold text-sm text-[#2F3E46]">Activities</p>
                <p className="text-xs text-gray-400">View today's activities and programs</p>
              </div>
            </button>
            <button
              onClick={() => { setShowScheduleChoice(false); navigate('/assessments'); }}
              className="flex items-center gap-3 p-4 rounded-xl border-2 border-gray-200 hover:border-[#FFD100] hover:bg-[#FFD100]/5 transition-all text-left"
            >
              <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center shrink-0">
                <ClipboardCheck className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="font-bold text-sm text-[#2F3E46]">Assessments</p>
                <p className="text-xs text-gray-400">View scheduled assessments for today</p>
              </div>
            </button>
          </div>
        </DialogContent>
      </Dialog>

            <ChildrenOverviewModal
        open={showChildrenModal}
        onClose={() => setShowChildrenModal(false)}
        children={children}
        violations={violations}
        onChildClick={(id) => { setShowChildrenModal(false); navigate(`/children/${id}`); }}
      />

      {/* ── ADMISSION SLIP MODAL ── */}
      {showAdmissionModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[9999] p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="bg-[#2F3E46] p-4 text-white flex justify-between items-center shrink-0">
              <div>
                <h3 className="font-bold text-lg flex items-center gap-2">
                  <FileText className="w-5 h-5 text-[#FFD100]" /> Admission Slip
                </h3>
                <p className="text-xs text-gray-300 mt-0.5">Second Chance Home — City Social Services Department</p>
              </div>
              <button onClick={() => setShowAdmissionModal(false)} className="hover:bg-white/10 rounded-full p-1.5 transition-colors">
                <X size={20} />
              </button>
            </div>

            {/* Scrollable form body */}
            <div className="overflow-y-auto flex-1 p-6 space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Date of Admission *</label>
                  <input type="date" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Name of Resident *</label>
                  <input type="text" placeholder="Full name" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Age</label>
                  <input type="number" placeholder="Age" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Sex</label>
                  <select className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]">
                    <option value="">Select</option>
                    <option>Male</option>
                    <option>Female</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Date of Birth</label>
                  <input type="date" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Religion</label>
                  <input type="text" placeholder="e.g. Roman Catholic" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Complete Address of Resident</label>
                <input type="text" placeholder="Barangay, City, Province" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
              </div>

              <div className="h-px bg-gray-100" />
              <p className="text-xs font-black uppercase tracking-widest text-gray-400">Guardian Information</p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Name of Guardian</label>
                  <input type="text" placeholder="Full name" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Contact No.</label>
                  <input type="text" placeholder="09XX XXX XXXX" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Complete Address of Guardian</label>
                <input type="text" placeholder="Barangay, City, Province" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
              </div>

              <div className="h-px bg-gray-100" />
              <p className="text-xs font-black uppercase tracking-widest text-gray-400">Referring Party</p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Name of Referring Party</label>
                  <input type="text" placeholder="Name / Agency" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Contact No.</label>
                  <input type="text" placeholder="09XX XXX XXXX" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="shrink-0 border-t p-4 flex justify-between items-center gap-3 bg-gray-50">
              <button onClick={() => setShowAdmissionModal(false)} className="text-sm text-gray-400 hover:text-gray-600 font-medium px-4 py-2">
                Cancel
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => { openForm('/forms/admission-slip.pdf', 'Admission Slip'); }}
                  className="flex items-center gap-2 px-4 py-2 border-2 border-[#2F3E46] text-[#2F3E46] rounded-xl text-sm font-bold hover:bg-gray-100 transition-colors"
                >
                  <Download size={15} /> Download Blank
                </button>
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-2 px-5 py-2 bg-[#2F3E46] text-white rounded-xl text-sm font-bold hover:bg-[#263440] transition-colors"
                >
                  <FileText size={15} /> Print Form
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── DISCHARGE MODAL ── */}
      {showDischargeModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[9999] p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="bg-[#2F3E46] p-4 text-white flex justify-between items-center shrink-0">
              <div>
                <h3 className="font-bold text-lg flex items-center gap-2">
                  <FileText className="w-5 h-5 text-[#FFD100]" /> Discharge Form (RPSE)
                </h3>
                <p className="text-xs text-gray-300 mt-0.5">Rehabilitation Program Satisfaction Evaluation</p>
              </div>
              <button onClick={() => setShowDischargeModal(false)} className="hover:bg-white/10 rounded-full p-1.5 transition-colors">
                <X size={20} />
              </button>
            </div>

            {/* Scrollable form body */}
            <div className="overflow-y-auto flex-1 p-6 space-y-5">
              {/* Resident info */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2 space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Pangalan (Full Name) *</label>
                  <input type="text" placeholder="Buong pangalan ng residente" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Edad (Age)</label>
                  <input type="number" placeholder="Edad" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Kapanganakan (Date of Birth)</label>
                  <input type="date" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Ilang buwan/taon sa shelter</label>
                  <input type="text" placeholder="e.g. 6 buwan" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Antas ng Pinag-aralan</label>
                  <input type="text" placeholder="e.g. Grade 9" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Paraan ng Pag-aaral</label>
                  <input type="text" placeholder="e.g. In-person / Modular" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Kondisyon ng Kalusugan</label>
                  <input type="text" placeholder="Kasalukuyang kondisyon" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Estado ng Kaso</label>
                  <input type="text" placeholder="e.g. Dismissed / Pending" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
              </div>

              {/* Satisfaction table */}
              <div className="h-px bg-gray-100" />
              <p className="text-xs font-black uppercase tracking-widest text-gray-400">I. Antas ng Kasiyahan sa mga Programa/Serbisyo</p>
              <p className="text-xs text-gray-500 italic">Lagyan ng tsek ang antas ng kasiyahan para sa bawat serbisyo.</p>

              <div className="overflow-x-auto rounded-xl border border-gray-100">
                <table className="w-full text-xs">
                  <thead className="bg-[#2F3E46] text-white">
                    <tr>
                      <th className="p-3 text-left font-bold">Programa / Serbisyo</th>
                      {['Lubhang Hindi', 'Hindi', 'Neutral', 'Nasiyahan', 'Lubhang Nasiyahan'].map(h => (
                        <th key={h} className="p-3 text-center font-semibold whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {[
                      'Health Services', 'Psychological Services', 'Educational Services',
                      'Spiritual Enhancement Services', 'Social Services',
                      'Occupational Services', 'Recreational Therapy Services',
                    ].map((svc, i) => (
                      <tr key={svc} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                        <td className="p-3 font-medium text-[#2F3E46]">{svc}</td>
                        {[1, 2, 3, 4, 5].map(v => (
                          <td key={v} className="p-3 text-center">
                            <input type="radio" name={`svc-${i}`} value={v} className="accent-[#2F3E46]" />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Open-ended questions */}
              <div className="h-px bg-gray-100" />
              <p className="text-xs font-black uppercase tracking-widest text-gray-400">II. Mga Tanong</p>

              {[
                { num: '1', q: 'Ano sa palagay mo ang mga kalakasan ng programa?' },
                { num: '2', q: 'Anong mga aspeto sa tingin mo ang nangangailangan ng pagpapabuti o pagpapaunlad?' },
                { num: '3', q: 'Ano ang iyong mga realisasyon at/o mga natutunan habang nasa shelter? At ano ang karanasan mo sa shelter na hindi mo makakalimutan?' },
              ].map(({ num, q }) => (
                <div key={num} className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46]">{num}. {q}</label>
                  <textarea rows={3} className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100] resize-none" placeholder="Isulat dito ang iyong sagot..." />
                </div>
              ))}

              <div className="grid grid-cols-2 gap-4 pt-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Pangalan at Lagda ng Bata</label>
                  <input type="text" placeholder="Ilagay ang pangalan" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#2F3E46] uppercase tracking-wide">Petsa ng Pagsagot</label>
                  <input type="date" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD100]" />
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="shrink-0 border-t p-4 flex justify-between items-center gap-3 bg-gray-50">
              <button onClick={() => setShowDischargeModal(false)} className="text-sm text-gray-400 hover:text-gray-600 font-medium px-4 py-2">
                Cancel
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => openForm('/forms/psych/exit-form-rpse.pdf', 'Discharge Form (RPSE)')}
                  className="flex items-center gap-2 px-4 py-2 border-2 border-[#2F3E46] text-[#2F3E46] rounded-xl text-sm font-bold hover:bg-gray-100 transition-colors"
                >
                  <Download size={15} /> Download Blank
                </button>
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-2 px-5 py-2 bg-[#2F3E46] text-white rounded-xl text-sm font-bold hover:bg-[#263440] transition-colors"
                >
                  <FileText size={15} /> Print Form
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
