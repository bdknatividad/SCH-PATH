import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/app/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import {
  Users, Calendar, AlertCircle, FileText, ClipboardCheck, ClipboardList,
  Zap, X, Download, HeartPulse, Briefcase,
  ChevronDown, ChevronUp, Upload, CheckCircle2, Circle, ExternalLink,
  Search, ArrowUpDown, Shield, TrendingUp, FolderOpen, FolderX,
  ArrowRight, UserCheck, Clock, BarChart3, Gavel, GraduationCap,
} from 'lucide-react';
import { useData, Child, Assessment, Violation } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { request } from '@/services/api';
import { canOpenModule } from '@/app/config/moduleAccess';
import { formatShortDate } from '@/utils/dateFormatter';

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
    const active = violations.filter(
      v => v.residentId === childId && v.status !== 'Resolved'
    );

    if (active.some(v => v.severity === 'Critical')) {
      return { label: 'Critical', order: 0, dot: 'bg-red-500', badge: 'bg-red-100 text-red-700' };
    }
    if (active.some(v => v.severity === 'Major')) {
      return { label: 'Severe', order: 1, dot: 'bg-orange-400', badge: 'bg-orange-100 text-orange-700' };
    }
    if (active.some(v => v.severity === 'Minor')) {
      return { label: 'Moderate', order: 2, dot: 'bg-yellow-400', badge: 'bg-yellow-100 text-yellow-700' };
    }
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
        <div className="flex-1 overflow-auto">
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

// ── PSYCHOLOGIST DASHBOARD ──────────────────────────────────────────────────

/** `YYYY-MM-DD` in local time — `toISOString()` would shift across midnight. */
function isoDay(value: Date): string {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** Monday of the week `now` falls in, at local midnight. */
function startOfWeek(now: Date): Date {
  const start = new Date(now);
  const daysSinceMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * `HH:MM` for a `scheduledAt` DATETIME.
 *
 * The connection runs with `dateStrings: true`, so the value arrives as
 * `'YYYY-MM-DD HH:MM:SS'` — slicing avoids `new Date(...)`, which would read
 * that string as local time and can land on the previous day.
 */
function scheduleClock(scheduledAt: unknown): string {
  const raw = String(scheduledAt || '');
  const match = raw.match(/(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : 'TBA';
}

interface PsychologistDashboardProps {
  displayRole: string;
  username?: string;
  fullName?: string;
  assessments: Assessment[];
  violations: Violation[];
  children: Child[];
  onOpen: (path: string) => void;
}

/**
 * The Psychologist's landing page.
 *
 * The role's specification names six widgets and says to remove everything
 * else, so the role gets its own page rather than the shared dashboard with
 * sections hidden. Hiding is the fragile option: every widget added to the
 * shared dashboard afterwards has to remember to exclude this role, and one
 * missed `hasModule()` brings an unrelated statistic back.
 *
 * Two of the six names are defined here, because the specification names the
 * widgets without defining them:
 *
 *  - **Pending Reviews** is the Psychologist's verification queue — violations
 *    logged against a resident that no one has reviewed yet. It is the same set
 *    the Violations module's "For Verification" tab lists.
 *  - **Assigned Cases** is every resident with an open item in that queue: an
 *    assessment the Psychologist owns, or a violation to verify. There is no
 *    Psychologist assignment table in the schema — `residentAssignments` only
 *    carries `houseparent` rows — so the queue is the only assignment signal the
 *    system actually has. If a real caseload model is added later, this is the
 *    one derivation to replace.
 */
function PsychologistDashboard({
  displayRole, username, fullName, assessments, violations, children, onOpen,
}: PsychologistDashboardProps) {
  const now = new Date();
  const today = isoDay(now);
  const weekStart = startOfWeek(now);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekStartIso = isoDay(weekStart);
  const weekEndIso = isoDay(weekEnd);

  const dayOf = (assessment: Assessment) => String(assessment.date || '').slice(0, 10);

  /**
   * Is this assessment the Psychologist's? The `assessor` column is free text,
   * so it is matched against the signed-in user first and only then against the
   * role — an assessment assigned to a named colleague must not appear here.
   */
  const isMine = (assessment: Assessment) => {
    const assessor = String(assessment.assessor || '').toLowerCase();
    const owners = [username, fullName]
      .filter(Boolean)
      .map((name) => String(name).toLowerCase());
    if (owners.some((name) => assessor.includes(name))) return true;
    if (assessor.includes('psycholog')) return true;
    return /psych/i.test(String(assessment.type || ''));
  };

  const todaysAssessments = assessments.filter((a) => dayOf(a) === today);
  const weekAssessments = assessments.filter((a) => dayOf(a) >= weekStartIso && dayOf(a) <= weekEndIso);
  const pendingAssessments = assessments.filter((a) => a.status === 'Scheduled');
  const pendingReviews = violations.filter(
    (v) => v.status === 'Pending Review' || v.status === 'Under Investigation',
  );

  /** Scheduled vs completed, plus a per-instrument count for the busiest few. */
  const summary = useMemo(() => {
    const completed = assessments.filter((a) => a.status === 'Completed').length;
    const scheduled = assessments.length - completed;
    const byType = new Map<string, number>();
    assessments.forEach((a) => {
      const key = String(a.type || 'Unspecified');
      byType.set(key, (byType.get(key) || 0) + 1);
    });
    const types = [...byType.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { completed, scheduled, total: assessments.length, types };
  }, [assessments]);

  const assignedCases = useMemo(() => {
    const ids = new Set<string>();
    assessments.filter(isMine).forEach((a) => {
      (a.forResidents || []).forEach((id) => ids.add(String(id)));
    });
    pendingReviews.forEach((v) => {
      if (v.residentId) ids.add(String(v.residentId));
    });
    return children
      .filter((child) => ids.has(String(child.id)))
      .map((child) => ({
        id: child.id,
        name: child.name,
        assessments: assessments.filter(
          (a) => isMine(a) && (a.forResidents || []).map(String).includes(String(child.id)),
        ).length,
        violations: pendingReviews.filter((v) => String(v.residentId) === String(child.id)).length,
      }))
      .sort((a, b) => (b.violations + b.assessments) - (a.violations + a.assessments));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessments, pendingReviews, children, username, fullName]);

  const tiles = [
    {
      title: "Today's Assessments",
      value: todaysAssessments.length,
      caption: todaysAssessments.length ? 'Scheduled or due today' : 'Nothing due today',
      icon: Calendar,
      path: '/assessments',
    },
    {
      title: "This Week's Assessments",
      value: weekAssessments.length,
      caption: `${weekStartIso} to ${weekEndIso}`,
      icon: ClipboardList,
      path: '/assessments',
    },
    {
      title: 'Pending Assessments',
      value: pendingAssessments.length,
      caption: 'Scheduled and not yet completed',
      icon: Clock,
      path: '/assessments',
    },
    {
      title: 'Pending Reviews',
      value: pendingReviews.length,
      caption: 'Violations awaiting verification',
      icon: AlertCircle,
      path: '/violations?tab=verification',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-[#2F3E46] p-6 rounded-xl shadow-md border-b-4 border-[#FFD100]">
        <h2 className="text-2xl font-bold mb-1 text-white">Psychologist Dashboard</h2>
        <p className="text-gray-300">
          Welcome back, <span className="font-bold text-[#FFD100] uppercase">{displayRole}</span>
          <span className="text-gray-400 text-sm ml-2">— assessments, verification & assigned cases</span>
        </p>
      </div>

      {/* The four counters the specification names. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <Card
              key={tile.title}
              className="border-none shadow-sm cursor-pointer hover:shadow-md hover:ring-2 hover:ring-[#FFD100] active:scale-95 transition-all"
              onClick={() => onOpen(tile.path)}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{tile.title}</p>
                    <p className="text-3xl font-bold mt-1 text-[#2F3E46]">{tile.value}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">{tile.caption}</p>
                  </div>
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[#FFD100]/20 shrink-0">
                    <Icon className="w-5 h-5 text-[#2F3E46]" />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Assessment Summary */}
        <Card className="border-none shadow-sm">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <BarChart3 className="w-5 h-5 text-[#FFD100]" /> Assessment Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            {summary.total === 0 ? (
              <p className="text-sm text-gray-400 italic text-center py-4">No assessments on record.</p>
            ) : (
              <>
                {/* Three stat cards side by side is fine from the sm breakpoint
                    up. On a phone each card would get roughly a third of ~360px,
                    which is narrower than the words in the labels above the
                    numbers, so they stack instead. */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="p-3 rounded-xl bg-blue-50 border border-blue-100">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-600">Scheduled</p>
                    <p className="text-2xl font-bold text-blue-700">{summary.scheduled}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-green-50 border border-green-100">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-green-600">Completed</p>
                    <p className="text-2xl font-bold text-green-700">{summary.completed}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-gray-50 border border-gray-200">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-600">Total</p>
                    <p className="text-2xl font-bold text-[#2F3E46]">{summary.total}</p>
                  </div>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-2">By instrument</p>
                  <div className="space-y-1">
                    {summary.types.slice(0, 5).map(([type, count]) => {
                      const share = Math.round((count / summary.total) * 100);
                      return (
                        <div key={type} className="flex items-center gap-2">
                          <span className="text-xs text-gray-600 w-40 truncate" title={type}>{type}</span>
                          <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                            <div className="h-full rounded-full bg-[#2F3E46]" style={{ width: `${share}%` }} />
                          </div>
                          <span className="text-xs font-semibold text-[#2F3E46] w-8 text-right">{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Assigned Cases */}
        <Card className="border-none shadow-sm">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <Users className="w-5 h-5 text-[#FFD100]" /> Assigned Cases
              <Badge className="bg-[#2F3E46]/10 text-[#2F3E46]">{assignedCases.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {assignedCases.length === 0 ? (
              <p className="text-sm text-gray-400 italic text-center py-4">
                No open assessments or violations are assigned to you.
              </p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {assignedCases.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() => onOpen(`/children/${entry.id}`)}
                    className="w-full flex items-center justify-between gap-3 p-3 rounded-lg border border-gray-100 hover:bg-gray-50 text-left transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[#2F3E46] truncate">{entry.name}</p>
                      <p className="text-[11px] text-gray-400">
                        {entry.assessments} assessment{entry.assessments === 1 ? '' : 's'}
                        {entry.violations > 0 && ` · ${entry.violations} to verify`}
                      </p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-gray-300 shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── NURSE DASHBOARD ─────────────────────────────────────────────────────────

/** How far ahead a follow-up counts as a reminder rather than history. */
const REMINDER_HORIZON_DAYS = 30;

/** A health record as the Health module stores it. */
interface NurseHealthRecord {
  id?: string;
  residentId?: string;
  residentName?: string;
  recordType?: string;
  date?: string;
  followUpDate?: string;
  chiefComplaints?: string;
  treatmentType?: string;
  outcome?: string;
  status?: string;
}

/** A scheduled assessment as `/assessments/upcoming` returns it. */
interface NurseAssessment {
  id: string;
  date?: string;
  time?: string;
  type?: string;
  status?: string;
  forResidents?: Array<string | { id?: string; name?: string }>;
}

interface NurseDashboardProps {
  displayRole: string;
  children: Child[];
  documents: Array<Record<string, any>>;
  healthRecords: NurseHealthRecord[];
  onOpen: (path: string) => void;
}

/**
 * The Nurse's landing page.
 *
 * The specification names five widgets — medical reminders, health updates,
 * upcoming assessments, medical notes and health document status — and says the
 * page shows "only nurse-relevant data". Hiding sections of the shared
 * dashboard is the fragile option: every widget added there afterwards has to
 * remember to exclude this role, and one missed check brings an unrelated
 * statistic back. So the role leaves the shared page entirely.
 *
 * Two of the five read from a source the bulk store deliberately withholds, and
 * both are handled without widening the store:
 *
 *  - **Upcoming assessments** come from `/assessments/upcoming`, the read-only
 *    endpoint. `/api/store` drops the whole `assessments` table for a role
 *    without the Assessments module — which is exactly the Nurse, who reads the
 *    schedule but never creates one. Fetching the one endpoint the role is meant
 *    to read is narrower than handing it the table.
 *  - **Medical notes** come from `child.notes`, which also carries the
 *    endorsement thread (`ChildDetail` appends a `[ENDORSEMENTS]` block to the
 *    same column), so only the part above the marker is a medical note.
 */
function NurseDashboard({
  displayRole, children, documents, healthRecords, onOpen,
}: NurseDashboardProps) {
  const now = new Date();
  const today = isoDay(now);
  const weekStartIso = isoDay(startOfWeek(now));
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + REMINDER_HORIZON_DAYS);
  const horizonIso = isoDay(horizon);

  const dayOf = (value?: string) => String(value || '').slice(0, 10);

  const [upcoming, setUpcoming] = useState<NurseAssessment[]>([]);
  const [upcomingLoading, setUpcomingLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result: any = await request('/assessments/upcoming');
        if (!cancelled) setUpcoming(Array.isArray(result?.data) ? result.data : []);
      } catch {
        if (!cancelled) setUpcoming([]);
      } finally {
        if (!cancelled) setUpcomingLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** Follow-ups to act on: overdue first, then anything inside the horizon. */
  const reminders = useMemo(() => healthRecords
    .map((record) => ({ record, due: dayOf(record.followUpDate) }))
    .filter(({ due }) => due && due <= horizonIso)
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 6), [healthRecords, horizonIso]);

  const overdueCount = reminders.filter(({ due }) => due < today).length;

  /** The most recently logged records, newest first. */
  const healthUpdates = useMemo(() => [...healthRecords]
    .sort((a, b) => dayOf(b.date).localeCompare(dayOf(a.date)))
    .slice(0, 6), [healthRecords]);

  const updatesThisWeek = healthRecords.filter(
    (record) => dayOf(record.date) >= weekStartIso && dayOf(record.date) <= today,
  ).length;

  /** The Documents module's Medical Records category — the nurse's own folder. */
  const medicalDocuments = useMemo(
    () => documents.filter((doc) => String(doc.category || '').trim().toLowerCase() === 'medical'),
    [documents],
  );

  const documentStatus = useMemo(() => {
    const buckets = ['Approved', 'Under Review', 'Submitted', 'Draft', 'Rejected'];
    const rows = buckets.map((status) => ({
      status,
      count: medicalDocuments.filter((doc) => String(doc.status || '') === status).length,
    }));
    const other = medicalDocuments.filter((doc) => !buckets.includes(String(doc.status || ''))).length;
    if (other > 0) rows.push({ status: 'Other', count: other });
    return rows;
  }, [medicalDocuments]);

  const medicalNotes = useMemo(() => children
    .map((child) => ({
      child,
      note: String(child.notes || '').split('[ENDORSEMENTS]')[0].trim(),
    }))
    .filter((entry) => entry.note.length > 0)
    .slice(0, 6), [children]);

  const residentName = (id?: string, fallback?: string) =>
    children.find((child) => String(child.id) === String(id))?.name || fallback || 'Unassigned';

  const tiles = [
    {
      title: 'Medical Reminders',
      value: reminders.length,
      caption: overdueCount ? `${overdueCount} overdue` : 'Follow-ups in 30 days',
      icon: AlertCircle,
      path: '/health',
    },
    {
      title: 'Health Updates',
      value: updatesThisWeek,
      caption: 'Records logged this week',
      icon: HeartPulse,
      path: '/health',
    },
    {
      title: 'Upcoming Assessments',
      value: upcoming.length,
      caption: 'Scheduled from today',
      icon: Calendar,
      // No path: the Nurse reads the schedule but holds no Assessments module,
      // so the Assessments page would bounce straight back out.
      path: null,
    },
    {
      title: 'Health Documents',
      value: medicalDocuments.length,
      caption: 'Filed under Medical Records',
      icon: FileText,
      path: '/documents?tab=folders',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-[#2F3E46] p-6 rounded-xl shadow-md border-b-4 border-[#FFD100]">
        <h2 className="text-2xl font-bold mb-1 text-white">Nurse Dashboard</h2>
        <p className="text-gray-300">
          Welcome back, <span className="font-bold text-[#FFD100] uppercase">{displayRole}</span>
          <span className="text-gray-400 text-sm ml-2">— medical reminders, health updates & document status</span>
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          const clickable = Boolean(tile.path);
          return (
            <Card
              key={tile.title}
              className={`border-none shadow-sm ${clickable ? 'cursor-pointer hover:shadow-md hover:ring-2 hover:ring-[#FFD100] active:scale-95 transition-all' : ''}`}
              onClick={clickable ? () => onOpen(tile.path as string) : undefined}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{tile.title}</p>
                    <p className="text-3xl font-bold mt-1 text-[#2F3E46]">{tile.value}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">{tile.caption}</p>
                  </div>
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[#FFD100]/20 shrink-0">
                    <Icon className="w-5 h-5 text-[#2F3E46]" />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Medical Reminders */}
        <Card className="border-none shadow-sm">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <AlertCircle className="w-5 h-5 text-[#FFD100]" /> Medical Reminders
              <Badge className="bg-[#2F3E46]/10 text-[#2F3E46]">{reminders.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {reminders.length === 0 ? (
              <p className="text-sm text-gray-400 italic text-center py-4">No follow-ups due.</p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {reminders.map(({ record, due }, index) => {
                  const overdue = due < today;
                  return (
                    <button
                      key={record.id || `${due}-${index}`}
                      onClick={() => record.residentId && onOpen(`/children/${record.residentId}?tab=medical`)}
                      className="w-full flex items-center justify-between gap-3 p-3 rounded-lg border border-gray-100 hover:bg-gray-50 text-left transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-[#2F3E46] truncate">
                          {residentName(record.residentId, record.residentName)}
                        </p>
                        <p className="text-[11px] text-gray-400 truncate">
                          {record.recordType || 'Health record'}
                          {record.treatmentType ? ` · ${record.treatmentType}` : ''}
                        </p>
                      </div>
                      <Badge className={overdue ? 'bg-red-100 text-red-700 shrink-0' : 'bg-amber-100 text-amber-700 shrink-0'}>
                        {overdue ? 'Overdue ' : 'Due '}{due}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Health Updates */}
        <Card className="border-none shadow-sm">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <HeartPulse className="w-5 h-5 text-[#FFD100]" /> Health Updates
              <Badge className="bg-[#2F3E46]/10 text-[#2F3E46]">{updatesThisWeek} this week</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {healthUpdates.length === 0 ? (
              <p className="text-sm text-gray-400 italic text-center py-4">No health records logged.</p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {healthUpdates.map((record, index) => (
                  <button
                    key={record.id || `${record.date}-${index}`}
                    onClick={() => record.residentId && onOpen(`/children/${record.residentId}?tab=medical`)}
                    className="w-full flex items-center justify-between gap-3 p-3 rounded-lg border border-gray-100 hover:bg-gray-50 text-left transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[#2F3E46] truncate">
                        {residentName(record.residentId, record.residentName)}
                      </p>
                      <p className="text-[11px] text-gray-400 truncate">
                        {record.recordType || 'Health record'}
                        {record.chiefComplaints ? ` · ${record.chiefComplaints}` : ''}
                      </p>
                    </div>
                    <span className="text-[11px] text-gray-400 shrink-0">{dayOf(record.date) || '—'}</span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Upcoming Assessments */}
        <Card className="border-none shadow-sm">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <Calendar className="w-5 h-5 text-[#FFD100]" /> Upcoming Assessments
              <Badge className="bg-[#2F3E46]/10 text-[#2F3E46]">{upcoming.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {upcomingLoading ? (
              <p className="text-sm text-gray-400 italic text-center py-4">Loading…</p>
            ) : upcoming.length === 0 ? (
              <p className="text-sm text-gray-400 italic text-center py-4">Nothing scheduled.</p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {upcoming.slice(0, 6).map((assessment) => {
                  const residents = (assessment.forResidents || [])
                    .map((entry) => (typeof entry === 'object' ? entry?.id : entry))
                    .filter(Boolean) as string[];
                  const firstResident = residents[0];
                  return (
                    <button
                      key={assessment.id}
                      onClick={() => firstResident && onOpen(`/children/${firstResident}`)}
                      className="w-full flex items-center justify-between gap-3 p-3 rounded-lg border border-gray-100 hover:bg-gray-50 text-left transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-[#2F3E46] truncate">
                          {assessment.type || 'Assessment'}
                        </p>
                        <p className="text-[11px] text-gray-400 truncate">
                          {residents.length
                            ? residents.map((id) => residentName(id)).join(', ')
                            : 'No resident linked'}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[11px] font-semibold text-[#2F3E46]">{dayOf(assessment.date) || '—'}</p>
                        {assessment.time && <p className="text-[10px] text-gray-400">{assessment.time}</p>}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Medical Notes */}
        <Card className="border-none shadow-sm">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <ClipboardList className="w-5 h-5 text-[#FFD100]" /> Medical Notes
              <Badge className="bg-[#2F3E46]/10 text-[#2F3E46]">{medicalNotes.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {medicalNotes.length === 0 ? (
              <p className="text-sm text-gray-400 italic text-center py-4">No medical notes recorded.</p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {medicalNotes.map(({ child, note }) => (
                  <button
                    key={child.id}
                    onClick={() => onOpen(`/children/${child.id}?tab=medical`)}
                    className="w-full flex items-start justify-between gap-3 p-3 rounded-lg border border-gray-100 hover:bg-gray-50 text-left transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[#2F3E46] truncate">{child.name}</p>
                      <p className="text-[11px] text-gray-500 line-clamp-2">{note}</p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-gray-300 shrink-0 mt-0.5" />
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Health Document Status */}
      <Card className="border-none shadow-sm">
        <CardHeader className="border-b border-gray-100 pb-3">
          <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
            <BarChart3 className="w-5 h-5 text-[#FFD100]" /> Health Document Status
            <Badge className="bg-[#2F3E46]/10 text-[#2F3E46]">{medicalDocuments.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {medicalDocuments.length === 0 ? (
            <p className="text-sm text-gray-400 italic text-center py-4">No medical documents filed.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                {documentStatus.filter((row) => row.count > 0).map((row) => (
                  <div key={row.status} className="p-3 rounded-xl bg-gray-50 border border-gray-200">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{row.status}</p>
                    <p className="text-2xl font-bold text-[#2F3E46]">{row.count}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 space-y-2">
                {medicalDocuments.slice(0, 5).map((doc) => (
                  <button
                    key={String(doc.id)}
                    onClick={() => onOpen('/documents?tab=folders')}
                    className="w-full flex items-center justify-between gap-3 p-3 rounded-lg border border-gray-100 hover:bg-gray-50 text-left transition-colors"
                  >
                    <div className="min-w-0 flex items-center gap-2">
                      <FileText className="w-4 h-4 text-[#2F3E46] shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-[#2F3E46] truncate">{doc.title || doc.fileName || 'Document'}</p>
                        <p className="text-[11px] text-gray-400 truncate">
                          {residentName(doc.residentId, doc.residentName)}
                          {doc.documentCategory ? ` · ${doc.documentCategory}` : ''}
                        </p>
                      </div>
                    </div>
                    <Badge className="bg-[#2F3E46]/10 text-[#2F3E46] shrink-0">{doc.status || 'Draft'}</Badge>
                  </button>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── DASHBOARD ───────────────────────────────────────────────────────────────
// ── EDUCATOR DASHBOARD ──────────────────────────────────────────────────────
//
// The Educator's specification names what its dashboard may show — education
// updates, upcoming education activities and assigned educational tasks — and
// requires the page to show "only education-related information". The shared
// dashboard is built around residents, violations, documents and hearings, none
// of which the role holds, so the Educator leaves it here and reads the
// Education module's own three collections instead.
//
// "Education Records Requiring Completion" was removed: once a resident is
// endorsed to the school the Educator is not the one tracking their remaining
// paperwork, so the list was noise rather than a work queue.
//
// Every link on this page stays inside the Education module. That matters:
// Violations, Health, Activities, Reports and Court Records are all withheld, so
// a control pointing at any of them would be a dead link.

interface EducatorStudent {
  id: string;
  name?: string;
  educationLevel?: string;
  gradeSection?: string;
  school?: string;
  status?: string;
  lrn?: string;
  traineeNumber?: string;
  files?: unknown;
  residentId?: string;
  createdAt?: string;
}

interface EducatorProgressReport {
  id: string;
  studentId?: string;
  educationRecordId?: string;
  month?: string;
  subject?: string;
  result?: string;
  createdAt?: string;
}

interface EducatorSchoolVisit {
  id: string;
  studentId?: string;
  educationRecordId?: string;
  visitDate?: string;
  school?: string;
  purpose?: string;
  findings?: string;
  createdAt?: string;
}

interface EducatorDashboardProps {
  displayRole: string;
  onOpen: (path: string) => void;
}

/** `YYYY-MM` for a date, which is the key `education_progress_reports.month` uses. */
function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key: string): string {
  const [year, month] = key.split('-').map(Number);
  if (!year || !month) return key;
  return new Date(year, month - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
}

/** The record a progress report or school visit belongs to, in either id shape. */
function linkedRecordId(row: { studentId?: string; educationRecordId?: string }): string {
  return String(row.studentId || row.educationRecordId || '');
}

function EducatorDashboard({ displayRole, onOpen }: EducatorDashboardProps) {
  const [students, setStudents] = useState<EducatorStudent[]>([]);
  const [progressReports, setProgressReports] = useState<EducatorProgressReport[]>([]);
  const [schoolVisits, setSchoolVisits] = useState<EducatorSchoolVisit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [records, progress, visits] = await Promise.allSettled([
        request<{ success: boolean; data?: EducatorStudent[] }>('/education-records'),
        request<{ success: boolean; data?: EducatorProgressReport[] }>('/education-progress-reports'),
        request<{ success: boolean; data?: EducatorSchoolVisit[] }>('/education-school-visits'),
      ]);
      if (cancelled) return;
      const rowsOf = (result: PromiseSettledResult<{ success: boolean; data?: unknown[] }>) =>
        result.status === 'fulfilled' && Array.isArray(result.value?.data) ? result.value.data : [];
      setStudents(rowsOf(records) as EducatorStudent[]);
      setProgressReports(rowsOf(progress) as EducatorProgressReport[]);
      setSchoolVisits(rowsOf(visits) as EducatorSchoolVisit[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const today = isoDay(new Date());
  const currentMonth = monthKey(new Date());

  /** Students with no progress report for the month in progress. */
  const outstandingReports = useMemo(() => {
    const filedThisMonth = new Set(
      progressReports
        .filter((report) => String(report.month || '') === currentMonth)
        .map((report) => linkedRecordId(report)),
    );
    return students
      .filter((student) => String(student.status || 'Active') === 'Active')
      .filter((student) => !filedThisMonth.has(String(student.id)))
      .map((student) => ({ student, lastReport: progressReports
        .filter((report) => linkedRecordId(report) === String(student.id))
        .map((report) => String(report.month || ''))
        .sort()
        .pop() || null }));
  }, [students, progressReports, currentMonth]);

  /** School visits dated today or later — the scheduled ones. */
  const upcomingVisits = useMemo(() => schoolVisits
    .filter((visit) => String(visit.visitDate || '').slice(0, 10) >= today)
    .sort((a, b) => String(a.visitDate).localeCompare(String(b.visitDate))), [schoolVisits, today]);

  /** The newest things filed against an education record. */
  const updates = useMemo(() => {
    const nameOf = (id: string) =>
      students.find((student) => String(student.id) === id)?.name || 'Unlinked record';
    const fromVisits = schoolVisits.map((visit) => ({
      id: `visit-${visit.id}`,
      when: String(visit.visitDate || visit.createdAt || '').slice(0, 10),
      label: 'School visit filed',
      detail: `${nameOf(linkedRecordId(visit))}${visit.purpose ? ` — ${visit.purpose}` : ''}`,
    }));
    const fromReports = progressReports.map((report) => ({
      id: `report-${report.id}`,
      when: String(report.createdAt || (report.month ? `${report.month}-01` : '')).slice(0, 10),
      label: `Progress report ${report.result ? `— ${report.result}` : ''}`.trim(),
      detail: `${nameOf(linkedRecordId(report))}${report.month ? ` — ${monthLabel(report.month)}` : ''}`,
    }));
    return [...fromVisits, ...fromReports]
      .filter((entry) => entry.when)
      .sort((a, b) => b.when.localeCompare(a.when))
      .slice(0, 6);
  }, [students, progressReports, schoolVisits]);

  const tiles = [
    {
      title: 'Education Records',
      value: students.length,
      caption: `${students.filter((s) => String(s.status || 'Active') === 'Active').length} active`,
      icon: GraduationCap,
    },
    {
      title: 'Upcoming Visits',
      value: upcomingVisits.length,
      caption: upcomingVisits.length ? 'Scheduled school visits' : 'Nothing scheduled',
      icon: Calendar,
    },
    {
      title: 'Reports Outstanding',
      value: outstandingReports.length,
      caption: `For ${monthLabel(currentMonth)}`,
      icon: ClipboardCheck,
    },
  ];

  const listCard = (title: string, icon: ReactNode, body: ReactNode, badge?: number) => (
    <Card className="border-none shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-[#2F3E46] flex items-center gap-2">
          {icon}
          {title}
          {badge !== undefined && badge > 0 && (
            <Badge className="bg-[#FFD100] text-[#2F3E46] text-[10px] px-1.5 py-0">{badge}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">{body}</CardContent>
    </Card>
  );

  const emptyRow = (message: string) => (
    <p className="text-xs text-gray-400 py-3 text-center">{message}</p>
  );

  return (
    <div className="space-y-6">
      <div className="bg-[#2F3E46] p-6 rounded-xl shadow-md border-b-4 border-[#FFD100]">
        <h2 className="text-2xl font-bold mb-1 text-white">Educator Dashboard</h2>
        <p className="text-gray-300">
          Welcome back, <span className="font-bold text-[#FFD100] uppercase">{displayRole}</span>
          <span className="text-gray-400 text-sm ml-2">— education updates, records & school visits</span>
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <Card
              key={tile.title}
              className="border-none shadow-sm cursor-pointer hover:shadow-md hover:ring-2 hover:ring-[#FFD100] active:scale-95 transition-all"
              onClick={() => onOpen('/education')}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{tile.title}</p>
                    <p className="text-3xl font-bold mt-1 text-[#2F3E46]">{tile.value}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">{tile.caption}</p>
                  </div>
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[#FFD100]/20 shrink-0">
                    <Icon className="w-5 h-5 text-[#2F3E46]" />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {listCard(
          'Education Updates',
          <TrendingUp className="w-4 h-4 text-[#2F3E46]" />,
          loading
            ? emptyRow('Loading education records...')
            : updates.length === 0
              ? emptyRow('Nothing filed against an education record yet.')
              : (
                <ul className="divide-y divide-gray-100">
                  {updates.map((entry) => (
                    <li key={entry.id} className="py-2 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-[#2F3E46]">{entry.label}</p>
                        <p className="text-[11px] text-gray-500 truncate">{entry.detail}</p>
                      </div>
                      <span className="text-[10px] text-gray-400 shrink-0">{formatShortDate(entry.when)}</span>
                    </li>
                  ))}
                </ul>
              ),
        )}

        {listCard(
          'Upcoming Education Activities',
          <Calendar className="w-4 h-4 text-[#2F3E46]" />,
          loading
            ? emptyRow('Loading school visits...')
            : upcomingVisits.length === 0
              ? emptyRow('No school visit is scheduled from today onward.')
              : (
                <ul className="divide-y divide-gray-100">
                  {upcomingVisits.slice(0, 6).map((visit) => (
                    <li key={visit.id} className="py-2 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-[#2F3E46]">
                          {students.find((s) => String(s.id) === linkedRecordId(visit))?.name || 'School visit'}
                        </p>
                        <p className="text-[11px] text-gray-500 truncate">
                          {visit.school || 'School not recorded'}{visit.purpose ? ` — ${visit.purpose}` : ''}
                        </p>
                      </div>
                      <span className="text-[10px] text-gray-400 shrink-0">
                        {formatShortDate(String(visit.visitDate || '').slice(0, 10))}
                      </span>
                    </li>
                  ))}
                </ul>
              ),
        )}

        {listCard(
          'Assigned Educational Tasks',
          <ClipboardList className="w-4 h-4 text-[#2F3E46]" />,
          loading
            ? emptyRow('Loading education records...')
            : outstandingReports.length === 0
              ? emptyRow(`Every active resident has a report for ${monthLabel(currentMonth)}.`)
              : (
                <ul className="divide-y divide-gray-100">
                  {outstandingReports.slice(0, 6).map(({ student, lastReport }) => (
                    <li key={student.id} className="py-2 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-[#2F3E46]">
                          Monthly progress report — {student.name || student.id}
                        </p>
                        <p className="text-[11px] text-gray-500">
                          {lastReport ? `Last filed ${monthLabel(lastReport)}` : 'No report on file yet'}
                        </p>
                      </div>
                      <Badge className="bg-orange-100 text-orange-700 text-[10px] px-1.5 py-0 shrink-0">
                        {monthLabel(currentMonth)}
                      </Badge>
                    </li>
                  ))}
                  {outstandingReports.length > 6 && (
                    <li className="pt-2 text-[10px] text-gray-400">
                      +{outstandingReports.length - 6} more
                    </li>
                  )}
                </ul>
              ),
          outstandingReports.length,
        )}
      </div>
    </div>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  const { children, activities, assessments, violations, documents, courtRecords, healthRecords } = useData();
  const { user } = useAuth();
  const [monthlyRatings, setMonthlyRatings] = useState<Array<{
    residentId: string;
    ratingYear: number;
    ratingMonth: number;
    rating: 'Need Improvement' | 'Fair' | 'Good' | 'Very Good';
    points: number;
  }>>([]);
  const [monthlyRatingsLoading, setMonthlyRatingsLoading] = useState(true);
  const [monthlyRatingsError, setMonthlyRatingsError] = useState<string | null>(null);

  const [showAdmissionModal, setShowAdmissionModal] = useState(false);
  const [showDischargeModal, setShowDischargeModal] = useState(false);
  const [showChildrenModal, setShowChildrenModal] = useState(false);
  const [showScheduleChoice, setShowScheduleChoice] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadMonthlyRatings = async () => {
      setMonthlyRatingsLoading(true);
      setMonthlyRatingsError(null);
      try {
        const result = await request<{
          success: boolean;
          data?: typeof monthlyRatings;
        }>('/children/performance-ratings');
        if (!cancelled) setMonthlyRatings(Array.isArray(result.data) ? result.data : []);
      } catch (error) {
        if (!cancelled) {
          setMonthlyRatingsError(error instanceof Error ? error.message : 'Unable to load monthly ratings');
          setMonthlyRatings([]);
        }
      } finally {
        if (!cancelled) setMonthlyRatingsLoading(false);
      }
    };

      if (user) loadMonthlyRatings();
    return () => { cancelled = true; };
  }, [user]);

  // TRI-authoritative monitoring data.
  const [triMonitor, setTriMonitor] = useState<any[] | null>(null);
  const [triMonitorLoading, setTriMonitorLoading] = useState(false);
  useEffect(() => {
    if (!user) return;
    // TRI monitoring is the Houseparent module's data, and the endpoint is gated
    // on that module. Asking on behalf of a role that cannot open it — the
    // Educator's dashboard now returns before it renders these counters — would
    // only produce a 403 in the console.
    if (!canOpenModule(user?.role, user?.accessibleModules, 'Houseparent')) {
      setTriMonitor([]);
      return;
    }
    let cancelled = false;
    const loadTriMonitor = async () => {
      setTriMonitorLoading(true);
      try {
        const result: any = await request('/tri/monitor');
        if (!cancelled) setTriMonitor(result?.data || []);
      } catch { if (!cancelled) setTriMonitor([]); }
      finally { if (!cancelled) setTriMonitorLoading(false); }
    };
    loadTriMonitor();
    return () => { cancelled = true; };
  }, [user]);

  // Aggregate finalized TRI ratings across active residents.
  const triRatingCounts = useMemo(() => {
    const counts: Record<string, number> = { 'Needs Improvement': 0, Fair: 0, Good: 0, 'Very Good': 0, Unscored: 0 };
    (triMonitor || []).forEach((r: any) => {
      if (r.rating && counts[r.rating] !== undefined) counts[r.rating]++;
      else counts.Unscored++;
    });
    return counts;
  }, [triMonitor]);

  /**
   * The interventions scheduled for the signed-in user today — the third kind of
   * schedule after activities and assessments.
   *
   * Fetched rather than read from the store: intervention schedules live in
   * `intervention_tracker`, which the bulk store does not carry. The endpoint
   * returns the caller's own scope in one query, so a Houseparent gets their
   * caseload and nobody pays for a request per resident.
   */
  const [assignedSchedules, setAssignedSchedules] = useState<Array<Record<string, any>>>([]);
  useEffect(() => {
    if (!user) return;
    // Only the roles that hold Violations have interventions to be scheduled
    // for; asking on behalf of a role that cannot open the module would only
    // produce a 403 in the console.
    if (!canOpenModule(user?.role, user?.accessibleModules, 'Violations')) {
      setAssignedSchedules([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result: any = await request('/violation-guide/interventions/scheduled');
        if (!cancelled) setAssignedSchedules(Array.isArray(result?.data) ? result.data : []);
      } catch {
        if (!cancelled) setAssignedSchedules([]);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

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
    houseparent: 'HOUSEPARENT',
  };

    const displayRole = user?.role
    ? (roleLabels[user.role.toLowerCase()] || user.role.toUpperCase())
    : 'GUEST';

  const isSocialWorker = ['socialworker', 'centerhead', 'admin'].includes(userRole);
  const isAdmin = userRole === 'centerhead' || userRole === 'admin';
  const hasModule = (module: string) => canOpenModule(user?.role, user?.accessibleModules, module);
  const canManageCases = isAdmin || userRole === 'socialworker';
  const monthLabel = (m: number) => new Date(2000, m - 1, 1).toLocaleString('default', { month: 'long' });

  const activeChildren  = children.filter(c => !c.status || c.status === 'Active');
  // Today's date in the browser's own timezone. This was `toISOString()`, which
  // is UTC: in GMT+8 that returns *yesterday* until 08:00, so a schedule for
  // today read as empty for the first eight hours of every day.
  const localDateString = (value: Date) =>
    `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const todayString     = localDateString(new Date());
  // Pending = still 'Scheduled'. Nearest first, so the next assessment to sit is
  // the one the card shows when it can only fit three.
  const scheduledAssessments = assessments
    .filter(a => a.status === 'Scheduled')
    .sort((a, b) =>
      String(a.date || '').localeCompare(String(b.date || '')) ||
      String(a.time || '').localeCompare(String(b.time || '')));

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

  // Scheduled Today = every schedule the signed-in user is meant to attend
  // today, and exactly the four lists the dialog below renders. The tile used to
  // count today's assessments alone while its dialog listed activities and
  // hearings too, so a day full of activities read as an empty schedule.
  //
  // Each source is read through the *same* module gate its section uses, so the
  // number can never include a row the dialog is hiding — and the tile is shown
  // when any one of the four modules is held, rather than only the first two.
  // Cancelled activities are not a schedule, so they are out of both.
  const canSeeActivities = hasModule('Activities');
  const canSeeAssessments = hasModule('Assessments');
  const canSeeHearings = hasModule('Court Records');
  const canSeeInterventions = hasModule('Violations');

  const todayActivities = canSeeActivities
    ? activities.filter(a => a.date === todayString && String(a.status || '') !== 'Cancelled')
    : [];
  const todayAssessments = canSeeAssessments
    ? assessments.filter(a => a.date === todayString && a.status === 'Scheduled')
    : [];
  const scheduledHearings = canSeeHearings
    ? (courtRecords || []).filter(r => r.status === 'Scheduled')
    : [];
  const todayHearings = scheduledHearings.filter(r => r.hearingDate === todayString);
  const todayInterventions = canSeeInterventions ? assignedSchedules : [];
  const scheduledTodayCount =
    todayActivities.length + todayAssessments.length + todayHearings.length + todayInterventions.length;

  const ratingByResidentId = new Map(monthlyRatings.map(rating => [rating.residentId, rating]));

  // Real-time urgency rating from unresolved violations.
  // Mirrors the backend rule in childController.getMonthlyPerformanceRatings:
  //   >= 10 points → Need Improvement
  //   >= 6  points → Fair
  //   >= 3  points → Good
  //   else         → Very Good
  const getRealTimeUrgency = (residentId: string) => {
    const points = (violations || [])
      .filter(v => v.residentId === residentId && v.status !== 'Resolved')
      .reduce((sum, v) => sum + (Number(v.points) || 0), 0);
    if (points >= 10) return { label: 'Need Improvement' as const, color: 'bg-red-500', text: 'text-red-700', badge: 'bg-red-100 text-red-700', dot: 'bg-red-500' };
    if (points >= 6)  return { label: 'Fair' as const, color: 'bg-orange-400', text: 'text-orange-700', badge: 'bg-orange-100 text-orange-700', dot: 'bg-orange-400' };
    if (points >= 3)  return { label: 'Good' as const, color: 'bg-yellow-400', text: 'text-yellow-700', badge: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-400' };
    return { label: 'Very Good' as const, color: 'bg-green-400', text: 'text-green-700', badge: 'bg-green-100 text-green-700', dot: 'bg-green-400' };
  };

  // Both dashboard rating sections use this same previous-month result.
  const getResidentStatus = (residentId: string) => {
    const rating = ratingByResidentId.get(residentId)?.rating;
    if (rating === 'Need Improvement') return { label: rating, color: 'bg-red-500', text: 'text-red-700', badge: 'bg-red-100 text-red-700', dot: 'bg-red-500' };
    if (rating === 'Fair') return { label: rating, color: 'bg-orange-400', text: 'text-orange-700', badge: 'bg-orange-100 text-orange-700', dot: 'bg-orange-400' };
    if (rating === 'Good') return { label: rating, color: 'bg-yellow-400', text: 'text-yellow-700', badge: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-400' };
    if (rating === 'Very Good') return { label: rating, color: 'bg-green-400', text: 'text-green-700', badge: 'bg-green-100 text-green-700', dot: 'bg-green-400' };
    return { label: 'No Rating', color: 'bg-gray-300', text: 'text-gray-500', badge: 'bg-gray-100 text-gray-500', dot: 'bg-gray-400' };
  };

  // ── Computed stats ─────────────────────────────────────────────────
  // One definition of "active" for the whole page. `activeChildren` above is the
  // precise reading (an explicit `Active`, or a row that predates the status
  // column); `activeCount` used to be a looser `status !== 'Discharged'`, which
  // counted a row with any other value as active. Two readings of the same word
  // is how the "Active Cases" tile and the "Total Residents" tile came to
  // disagree.
  const activeCount    = activeChildren.length;
  const closedCount    = children.filter(c => c.status === 'Discharged').length;

  const needImprovementCount = activeChildren.filter(c => getRealTimeUrgency(c.id).label === 'Need Improvement').length;
  const fairCount = activeChildren.filter(c => getRealTimeUrgency(c.id).label === 'Fair').length;
  const goodCount = activeChildren.filter(c => getRealTimeUrgency(c.id).label === 'Good').length;
  const veryGoodCount = activeChildren.filter(c => getRealTimeUrgency(c.id).label === 'Very Good').length;

  // Urgency is computed from real-time unresolved violations, not the
  // previous month's materialized ratings. The period label is therefore
  // "Real-time" rather than a fixed month.
  const urgencyPeriod = 'Real-time';

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
    const base: any[] = [];
    // A Social Worker's own "My Caseload" card below reports Active / Closed /
    // pending documents together, so the generic Closed Cases tile here would
    // print the same number twice on one page.
    if (hasModule('Child Records') && userRole !== 'socialworker') {
      base.push({ title: 'Closed Cases', value: String(closedCount), icon: FolderX, color: '#64748b', sub: 'Discharged', clickable: true });
    }
    if (canSeeActivities || canSeeAssessments || canSeeHearings || canSeeInterventions) {
      base.push({ title: 'Scheduled Today', value: String(scheduledTodayCount), icon: Calendar, color: '#2F3E46', sub: "Today's schedule", clickable: true });
    }
    if (['centerhead','admin'].includes(userRole)) {
      base.push({ title: 'Total Residents', value: String(activeCount), icon: Users, color: '#2F3E46', sub: 'Active only', clickable: true });
    }
    return base;
  };
  const stats = buildStats();

  // Decide which form sections this role should see

  const flaggedResidents = activeChildren
    .map(c => ({ child: c, status: getResidentStatus(c.id) }))
    .sort((a, b) => {
      const order = ['Need Improvement', 'Fair', 'Good', 'Very Good', 'No Rating'];
      return order.indexOf(a.status.label) - order.indexOf(b.status.label);
    });

  // ── Role-specific title & subtitle ─────────────────────────────────
  const roleTitle =
    userRole === 'centerhead' || userRole === 'admin' ? 'Center Head Dashboard' :
    userRole === 'socialworker' ? 'Social Worker Dashboard' :
    userRole === 'psychologist' ? 'Psychologist Dashboard' :
    userRole === 'nurse' ? 'Nurse Dashboard' :
    userRole === 'educator' ? 'Educator Dashboard' :
    userRole === 'houseparent' ? 'Houseparent Dashboard' : 'Dashboard';

  const roleSub =
    userRole === 'socialworker' ? 'Case management, document uploads & resident records' :
    userRole === 'psychologist' ? 'Assessments, psychological records & evaluations' :
    userRole === 'nurse' ? 'Health monitoring, medical records & check-ups' :
    userRole === 'educator' ? 'Education programs, activities & resident progress' :
    userRole === 'houseparent' ? 'Assigned residents, activities, assessments & interventions' :
    'Full system overview & management';

  // ── My assigned activities (educator) ────────────────────────────
  const myActivities = activities.filter(a =>
    (a.status as string) !== 'Cancelled' &&
    (Array.isArray(a.facilitators)
      ? a.facilitators.some((f: any) => String(f).toLowerCase().includes(user?.username?.toLowerCase() || ''))
      : String(a.facilitators || '').toLowerCase().includes(user?.username?.toLowerCase() || ''))
  );

  // ── Pending doc approvals (socialworker) ─────────────────────────
  // The Nurse branch was removed along with the role's shared-dashboard section:
  // a Nurse holds no document approval authority, so a list of documents
  // "awaiting your review" could never have been acted on. The Nurse's own page
  // reports health document *status* instead.
  //
  // Both pre-decision statuses count. `Submitted` is a document waiting for a
  // first look and `Under Review` is one a reviewer has opened but not decided —
  // `GET /documents/pending` and the Documents module both treat the two as
  // pending, so counting only `Submitted` made this tile under-report.
  const pendingApprovals = documents.filter(d =>
    (d.status === 'Submitted' || d.status === 'Under Review') &&
    (userRole === 'socialworker'
      ? !['Psychological Testing', 'Discernment Assessment', 'Mental Health Report'].includes(d.title || '')
      : true)
  );

  // The Psychologist's specification names its widgets and says to remove the
  // rest, so the role leaves the shared dashboard here. Every hook above has
  // already run, so returning early is safe.
  if (userRole === 'psychologist') {
    return (
      <PsychologistDashboard
        displayRole={displayRole}
        username={user?.username}
        fullName={(user as any)?.fullName || (user as any)?.displayName}
        assessments={assessments}
        violations={violations}
        children={children}
        onOpen={(path) => navigate(path)}
      />
    );
  }

  // The Nurse's specification names five widgets and says the page shows "only
  // nurse-relevant data", so the role leaves the shared dashboard here too.
  // Every hook above has already run, so returning early is safe.
  if (userRole === 'nurse') {
    return (
      <NurseDashboard
        displayRole={displayRole}
        children={children}
        documents={documents}
        healthRecords={healthRecords}
        onOpen={(path) => navigate(path)}
      />
    );
  }

  // The Educator's specification lists four widgets and requires the page to
  // show only education-related information, so the role leaves the shared
  // dashboard here. Every hook above has already run, so returning early is safe.
  if (userRole === 'educator') {
    return (
      <EducatorDashboard
        displayRole={displayRole}
        onOpen={(path) => navigate(path)}
      />
    );
  }

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

        {/* Urgency Distribution.
            This card and the TRI Monitoring card below show the same four band
            words but measure different things: this one counts unresolved
            violations, the other reads the TRI instrument. The captions exist
            because the two were previously distinguishable only by careful
            reading, and this one had no empty state — it silently drew four zero
            bars when there was nothing to report. */}
        {hasModule('Violations') && (
        <Card className="border-none shadow-sm" data-rating-card="urgency">
          <CardHeader className="pb-2 border-b border-gray-100">
            <CardTitle className="text-sm font-bold text-[#2F3E46] flex items-center gap-2">
              <Shield className="w-4 h-4 text-[#FFD100]" /> Urgency Level — Unresolved Violations
            </CardTitle>
            <p className="mt-1 text-[11px] text-gray-500">
              {urgencyPeriod ? `${urgencyPeriod} · ` : ''}counted from unresolved violations. Not the TRI.
            </p>
          </CardHeader>
          <CardContent className="pt-3 space-y-2">
            {activeChildren.length === 0 ? (
              <p className="text-xs text-gray-400 italic py-2">No active residents.</p>
            ) : [
              { label: 'Need Improvement', count: needImprovementCount, bg: 'bg-red-100', text: 'text-red-700', bar: 'bg-red-500' },
              { label: 'Fair', count: fairCount, bg: 'bg-orange-100', text: 'text-orange-700', bar: 'bg-orange-500' },
              { label: 'Good', count: goodCount, bg: 'bg-yellow-100', text: 'text-yellow-700', bar: 'bg-yellow-400' },
              { label: 'Very Good', count: veryGoodCount, bg: 'bg-green-100', text: 'text-green-700', bar: 'bg-green-500' },
            ].map(u => (
              <div key={u.label} className="flex items-center gap-3">
                {/* `w-16` (64px) could not hold "Need Improvement" at 12px, and
                    a flex item shrinks below its own width, so the column
                    measured 56px on a phone — narrower than the word
                    "Improvement". It broke mid-word across three lines. A fixed
                    width is still wanted so the bars line up, but it has to fit
                    the longest label, and `whitespace-nowrap` stops the break
                    regardless of what the metrics do. */}
                <span className={`shrink-0 whitespace-nowrap text-xs font-semibold w-28 ${u.text}`}>{u.label}</span>
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
        )}

        {/* Phase Distribution.
            Not shown on the Houseparent dashboard: the phase mix is a
            case-management view, and a Houseparent's own workload is the
            assigned residents and the day's schedule, which sit elsewhere on
            this page. */}
        {userRole !== 'houseparent' && (hasModule('Child Records') || hasModule('Houseparent')) && (
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
        )}
      </div>

            {/* ── TRI MONITORING (authoritative monthly performance rating) ── */}
      {(isSocialWorker || isAdmin) && (
        <Card className="border-none shadow-sm" data-rating-card="tri">
          <CardHeader className="border-b border-gray-100 pb-3">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <ClipboardList className="w-5 h-5 text-[#FFD100]" /> TRI Monitoring — Official Monthly Performance Ratings
            </CardTitle>
            <p className="mt-1 text-[11px] text-gray-500">
              From each resident&rsquo;s most recent Finalized TRI. This is the official monthly result.
            </p>
          </CardHeader>
          <CardContent className="pt-3 space-y-3">
            {triMonitorLoading ? <p className="text-xs text-gray-400">Loading TRI ratings…</p>
              : !triMonitor || triMonitor.length === 0 ? <p className="text-xs text-gray-400 italic">No active residents for TRI monitoring.</p>
              : <>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                    {[
                      { key: 'Needs Improvement', color: 'bg-red-100 text-red-700 border-red-200', icon: 'bg-red-500' },
                      { key: 'Fair', color: 'bg-yellow-100 text-yellow-700 border-yellow-200', icon: 'bg-yellow-500' },
                      { key: 'Good', color: 'bg-blue-100 text-blue-700 border-blue-200', icon: 'bg-blue-500' },
                      { key: 'Very Good', color: 'bg-green-100 text-green-700 border-green-200', icon: 'bg-green-500' },
                      { key: 'Unscored', color: 'bg-gray-100 text-gray-500 border-gray-200', icon: 'bg-gray-400' },
                    ].map(grp => (
                      <div key={grp.key} className={`border rounded-lg p-3 ${grp.color.split(' ')[2]}`}>
                        <p className="text-xs font-bold uppercase tracking-wide mb-1 opacity-75">{grp.key}</p>
                        <p className="text-2xl font-bold">{triRatingCounts[grp.key] ?? 0}</p>
                        <p className="text-[10px] opacity-70">resident{((triRatingCounts[grp.key] ?? 0) !== 1) ? 's' : ''}</p>
                      </div>
                    ))}
                  </div>
                  <details>
                    <summary className="text-xs text-gray-500 hover:text-[#2F3E46] cursor-pointer select-none">Show resident breakdown</summary>
                    {/* Six columns do not fit a phone. Without a scroll box the
                        browser compresses them instead — "Case Type" was given
                        32px at 320px and broke mid-word over four lines. Same
                        fix as the Violations list: scroll the table inside its
                        own box rather than squeezing it. */}
                    <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-xs mt-2">
                      <thead><tr className="text-gray-400 uppercase border-b border-gray-100">
                        <th className="text-left pb-1 pr-3">Resident</th><th className="text-left pb-1 pr-3">Case Type</th>
                        <th className="text-left pb-1 pr-3">Phase</th><th className="text-left pb-1 pr-3">Rating</th>
                        <th className="text-left pb-1 pr-3">Period</th><th className="text-left pb-1">Action</th>
                      </tr></thead>
                      <tbody>
                        {triMonitor.map((r: any) => (
                          <tr key={r.residentId} className="border-b border-gray-50 hover:bg-gray-50">
                            <td className="py-1.5 pr-3 font-semibold">{r.name}</td>
                            <td className="py-1.5 pr-3">{r.caseType || '—'}</td>
                            <td className="py-1.5 pr-3">{r.casePhase || '—'}</td>
                            <td className="py-1.5 pr-3">
                              {r.rating ? (
                                <span className={'px-1.5 py-0.5 rounded-full text-[10px] font-bold ' + (
                                  r.rating === 'Very Good' ? 'bg-green-100 text-green-700'
                                  : r.rating === 'Good' ? 'bg-blue-100 text-blue-700'
                                  : r.rating === 'Fair' ? 'bg-yellow-100 text-yellow-700'
                                  : 'bg-red-100 text-red-700'
                                )}>{r.rating}</span>
                              ) : <span className="text-gray-400">Unscored</span>}
                            </td>
                            <td className="py-1.5 pr-3 text-gray-500">
                              {r.period ? `${monthLabel(r.period.month)} ${r.period.year}` : '—'}
                            </td>
                            <td className="py-1.5">
                              <button onClick={() => navigate('/tri')} className="text-[10px] border border-gray-200 px-2 py-0.5 rounded hover:bg-[#FFD100] transition-all">View</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  </details>
                </>
            }
            <p className="text-[10px] text-gray-400">
              Per official TRI-2025 PDF Page 8: 451–600 = Very Good · 301–450 = Good · 151–300 = Fair · 1–150 = Needs Improvement.
              Residents without a finalized TRI are shown as Unscored.
            </p>
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
            <div className="grid grid-cols-1 gap-3 mb-3 sm:grid-cols-3">
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

      {/* Schedules */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {hasModule('Activities') && <Card className="shadow-sm border-none">
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
        </Card>}

        {hasModule('Assessments') && (
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
                      <div className="text-xs font-bold text-[#FFD100] bg-[#2F3E46] p-1 rounded min-w-[68px] text-center leading-tight">
                        <div>{formatShortDate(assessment.date)}</div>
                        <div className="text-[10px] font-semibold text-white">{assessment.time || 'TBA'}</div>
                      </div>
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
        {/* Hearing Schedule card */}
        {hasModule('Court Records') && <Card
          className="shadow-sm border-none cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => navigate('/court-records?filter=Scheduled')}
        >
          <CardHeader className="border-b border-gray-100">
            <CardTitle className="flex items-center gap-2 text-md text-[#2F3E46]">
              <Gavel className="w-5 h-5 text-[#FFD100]" /> Hearing Schedule
              {scheduledHearings.length > 0 && (
                <span className="ml-auto text-xs font-bold bg-[#FFD100] text-[#2F3E46] px-2 py-0.5 rounded-full">
                  {scheduledHearings.length} scheduled
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {todayHearings.length > 0 ? (
              <div className="space-y-3">
                {todayHearings.slice(0, 3).map(h => {
                  const resident = children.find(c => c.id === h.residentId);
                  return (
                    <div key={h.id} className="flex items-start gap-3 p-3 rounded-lg bg-gray-50 border-l-4 border-[#FFD100]">
                      <div className="text-xs font-bold bg-[#2F3E46] text-white p-1 rounded min-w-[60px] text-center">
                        {h.hearingTime || 'TBA'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm text-[#2F3E46] truncate">{resident?.name || '—'}</p>
                        <p className="text-xs text-gray-500 italic">{h.hearingType || h.courtName || 'Court Hearing'}</p>
                      </div>
                    </div>
                  );
                })}
                {scheduledHearings.length > todayHearings.length && (
                  <p className="text-xs text-gray-400 text-center pt-1">
                    +{scheduledHearings.length - todayHearings.length} more upcoming • Click to view all
                  </p>
                )}
              </div>
            ) : scheduledHearings.length > 0 ? (
              <div className="space-y-2">
                <p className="text-gray-500 text-sm italic">No hearings today.</p>
                <p className="text-xs text-[#2F3E46] font-semibold">{scheduledHearings.length} upcoming hearing{scheduledHearings.length !== 1 ? 's' : ''} — click to view</p>
              </div>
            ) : (
              <p className="text-gray-500 text-sm py-4 italic">No scheduled hearings.</p>
            )}
          </CardContent>
        </Card>}
      </div>

      {/* ── CHILDREN OVERVIEW MODAL ── */}
      {/* ── SCHEDULE CHOICE DIALOG ── */}
      <Dialog open={showScheduleChoice} onOpenChange={setShowScheduleChoice}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46] flex items-center gap-2">
              <Calendar className="w-5 h-5 text-[#FFD100]" /> Today's Schedule
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">

            {/* Activities */}
            {hasModule('Activities') && <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-blue-100 flex items-center justify-center">
                    <Zap className="w-4 h-4 text-blue-600" />
                  </div>
                  <p className="font-bold text-sm text-[#2F3E46]">Activities</p>
                </div>
                <button onClick={() => { setShowScheduleChoice(false); navigate('/activities'); }}
                  className="text-xs text-blue-600 font-semibold hover:underline">View all →</button>
              </div>
              {todayActivities.length > 0 ? (
                <div className="space-y-1.5">
                  {todayActivities.slice(0, 3).map(a => (
                    <div key={a.id} className="flex items-center gap-2 p-2 bg-blue-50 rounded-lg border-l-3 border-blue-400">
                      <span className="text-[10px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded whitespace-nowrap">
                        {formatShortDate(a.date)} · {a.time || 'TBA'}
                      </span>
                      <span className="text-xs font-semibold text-[#2F3E46] truncate">{a.title}</span>
                    </div>
                  ))}
                  {todayActivities.length > 3 && <p className="text-xs text-gray-400 pl-2">+{todayActivities.length - 3} more</p>}
                </div>
              ) : (
                <p className="text-xs text-gray-400 italic pl-2">No activities today.</p>
              )}
            </div>}

            <div className="h-px bg-gray-100" />

            {/* Assessments */}
            {hasModule('Assessments') && <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-purple-100 flex items-center justify-center">
                    <ClipboardCheck className="w-4 h-4 text-purple-600" />
                  </div>
                  <p className="font-bold text-sm text-[#2F3E46]">Assessments</p>
                </div>
                <button onClick={() => { setShowScheduleChoice(false); navigate('/assessments'); }}
                  className="text-xs text-purple-600 font-semibold hover:underline">View all →</button>
              </div>
              {todayAssessments.length > 0 ? (
                <div className="space-y-1.5">
                  {todayAssessments.slice(0, 3).map(a => (
                    <div key={a.id} className="flex items-center gap-2 p-2 bg-purple-50 rounded-lg border-l-3 border-purple-400">
                      <span className="text-[10px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded whitespace-nowrap">
                        {formatShortDate(a.date)} · {a.time || 'TBA'}
                      </span>
                      <span className="text-xs font-semibold text-[#2F3E46] truncate">{a.title}</span>
                    </div>
                  ))}
                  {todayAssessments.length > 3 && <p className="text-xs text-gray-400 pl-2">+{todayAssessments.length - 3} more</p>}
                </div>
              ) : (
                <p className="text-xs text-gray-400 italic pl-2">No assessments today.</p>
              )}
            </div>}

            <div className="h-px bg-gray-100" />

            {/* Hearing Schedule */}
            {hasModule('Court Records') && <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-amber-100 flex items-center justify-center">
                    <Gavel className="w-4 h-4 text-amber-600" />
                  </div>
                  <p className="font-bold text-sm text-[#2F3E46]">Hearing Schedule</p>
                </div>
                <button onClick={() => { setShowScheduleChoice(false); navigate('/court-records?filter=Scheduled'); }}
                  className="text-xs text-amber-600 font-semibold hover:underline">View all →</button>
              </div>
              {todayHearings.length > 0 ? (
                <div className="space-y-1.5">
                  {todayHearings.slice(0, 3).map(h => {
                    const resident = children.find(c => c.id === h.residentId);
                    return (
                      <div key={h.id} className="flex items-center gap-2 p-2 bg-amber-50 rounded-lg border-l-3 border-amber-400">
                        <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded whitespace-nowrap">{h.hearingTime || 'TBA'}</span>
                        <span className="text-xs font-semibold text-[#2F3E46] truncate">{resident?.name || '—'}</span>
                        <span className="text-[10px] text-gray-400 truncate">{h.hearingType || 'Hearing'}</span>
                      </div>
                    );
                  })}
                  {todayHearings.length > 3 && <p className="text-xs text-gray-400 pl-2">+{todayHearings.length - 3} more</p>}
                </div>
              ) : scheduledHearings.length > 0 ? (
                <div className="pl-2">
                  <p className="text-xs text-gray-400 italic">No hearings today.</p>
                  <p className="text-xs text-amber-600 font-semibold mt-0.5">{scheduledHearings.length} upcoming — click View all</p>
                </div>
              ) : (
                <p className="text-xs text-gray-400 italic pl-2">No scheduled hearings.</p>
              )}
            </div>}

            <div className="h-px bg-gray-100" />

            {/* Assigned Schedules — the intervention sessions the signed-in user
                is expected to run today. This is the only per-user schedule in
                the schema, and it is what the "Assigned schedules must display
                correctly" requirement refers to. */}
            {canSeeInterventions && <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-emerald-100 flex items-center justify-center">
                    <Clock className="w-4 h-4 text-emerald-600" />
                  </div>
                  <p className="font-bold text-sm text-[#2F3E46]">Assigned Schedules</p>
                </div>
                <button onClick={() => { setShowScheduleChoice(false); navigate('/violations?tab=interventions'); }}
                  className="text-xs text-emerald-600 font-semibold hover:underline">View all →</button>
              </div>
              {todayInterventions.length > 0 ? (
                <div className="space-y-1.5">
                  {todayInterventions.slice(0, 3).map(s => (
                    <div key={s.id} className="flex items-center gap-2 p-2 bg-emerald-50 rounded-lg border-l-3 border-emerald-400">
                      <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded whitespace-nowrap">
                        {formatShortDate(s.scheduledAt)} · {scheduleClock(s.scheduledAt)}
                      </span>
                      <span className="text-xs font-semibold text-[#2F3E46] truncate">{s.residentName || '—'}</span>
                      <span className="text-[10px] text-gray-400 truncate">{s.interventionType || 'Intervention'}</span>
                    </div>
                  ))}
                  {todayInterventions.length > 3 && <p className="text-xs text-gray-400 pl-2">+{todayInterventions.length - 3} more</p>}
                </div>
              ) : (
                <p className="text-xs text-gray-400 italic pl-2">No assigned schedules today.</p>
              )}
            </div>}

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
