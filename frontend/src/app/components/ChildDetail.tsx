import { useState, useMemo, useRef, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useData, BehavioralLog, Child } from '../state/DataContext';
import { request } from '@/services/api';
import { useAuth } from '../state/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import {
  ArrowLeft, ArrowRight, ShieldAlert, CalendarCheck, Plus,
  User, MapPin, Stethoscope, CheckCircle2, Circle,
  ClipboardList, Eye, BookOpen, Heart, RefreshCw,
  ChevronLeft, ChevronRight, Clock, AlertTriangle, FileText,
} from 'lucide-react';
import { Textarea } from '@/app/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/app/components/ui/dialog';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { getAssessmentTypeForViolation } from '@/utils/interventionRules';
import { formatShortDate } from '@/utils/dateFormatter';
import { PhaseProgress } from './PhaseProgress';

interface PhaseConfig {
  label: string;
  shortLabel: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  borderColor: string;
  tasks: string[];
  requiredDocs?: string[];
}

const PHASE_CONFIG: PhaseConfig[] = [
  {
    label: 'Admission Phase',
    shortLabel: 'Admission',
    description: 'Initial intake, documentation, and orientation to the facility.',
    icon: <ClipboardList className="w-5 h-5" />,
    color: 'text-violet-600',
    bgColor: 'bg-violet-50',
    borderColor: 'border-violet-400',
    tasks: ['Complete intake forms', 'Medical screening', 'Initial risk assessment', 'Family notification'],
  },
  {
    label: 'Orientation Phase',
    shortLabel: 'Orientation',
    description: 'Familiarization with house rules, schedules, and program expectations.',
    icon: <Eye className="w-5 h-5" />,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-400',
    tasks: ['House rules orientation', 'Staff introductions', 'Program overview', 'Schedule familiarization'],
  },
  {
    label: 'Enculturation/Observation Phase',
    shortLabel: 'Observation',
    description: 'Behavioral observation, case study completion, and adjustment to the program.',
    icon: <Eye className="w-5 h-5" />,
    color: 'text-cyan-600',
    bgColor: 'bg-cyan-50',
    borderColor: 'border-cyan-400',
    tasks: ['Behavioral observation', 'Social Case Study Report', 'Psychological assessment', 'Initial intervention plan'],
  },
  {
    label: 'Caring & Rehabilitation Phase / DP or IPP Implementation',
    shortLabel: 'Rehabilitation',
    description: 'Active implementation of the Diversion Plan or Individualized Placement Plan.',
    icon: <BookOpen className="w-5 h-5" />,
    color: 'text-amber-600',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-400',
    tasks: ['DP / IPP implementation', 'Counseling sessions', 'Skills training', 'Regular progress review'],
  },
  {
    label: 'Pre-integration Phase',
    shortLabel: 'Pre-integration',
    description: 'Preparation for reintegration into family and community life.',
    icon: <Heart className="w-5 h-5" />,
    color: 'text-orange-600',
    bgColor: 'bg-orange-50',
    borderColor: 'border-orange-400',
    tasks: ['Family counseling', 'Community linkage', 'Livelihood preparation', 'Exit assessment'],
  },
  {
    label: 'Reintegration/Aftercare Program',
    shortLabel: 'Reintegration',
    description: 'Active reintegration with community follow-up and aftercare support. After completion, child is ready for discharge.',
    icon: <RefreshCw className="w-5 h-5" />,
    color: 'text-green-600',
    bgColor: 'bg-green-50',
    borderColor: 'border-green-400',
    tasks: ['Life Skills Sessions', 'PES', 'Family Planning', 'Community involvement'],
  },
];

const casePhases = PHASE_CONFIG.map((p) => p.label);

const SCH_VIOLATION_MATRIX = [
  // MAJOR OFFENSES
  { id:'MJ01', category:'Major', severity:'Major' as const, points:3, label:'Pagtangkang Tumakas / Pagtakas (Escape Attempt)' },
  { id:'MJ02', category:'Major', severity:'Major' as const, points:3, label:'Pagpasok ng Pera at Phone' },
  { id:'MJ03', category:'Major', severity:'Major' as const, points:3, label:'Pagpasok ng Alak at Sigarilyo' },
  { id:'MJ04', category:'Major', severity:'Critical' as const, points:5, label:'Paggamit ng Droga sa Shelter' },
  { id:'MJ05', category:'Major', severity:'Major' as const, points:3, label:'Paggamit ng Tablet (Hindi Ayon sa Rules)' },
  { id:'MJ06', category:'Major', severity:'Major' as const, points:3, label:'Pakikipag-away / Pananakit / Pakikipagsuntukan (Fighting)' },
  { id:'MJ07', category:'Major', severity:'Major' as const, points:3, label:'Pagsira ng Gamit sa Shelter (Property Damage)' },
  { id:'MJ08', category:'Major', severity:'Critical' as const, points:5, label:'Pagbasag ng Salamin / Paggawa ng Sandata (Dangerous Object)' },
  { id:'MJ09', category:'Major', severity:'Major' as const, points:3, label:'Paglalagay ng Tattoo / Piercing / Bulitas' },
  { id:'MJ10a', category:'Major', severity:'Major' as const, points:3, label:'Pagkuha ng Supplies ng Shelter (Food/Kubyertos/Appliance)' },
  { id:'MJ10b', category:'Major', severity:'Major' as const, points:3, label:'Pagkuha ng Gamit ng Kapwa Residente (Meryenda/Damit)' },
  { id:'MJ11', category:'Major', severity:'Major' as const, points:3, label:'Kawalang Respeto sa Residente/Staff/Bisita (Pagmumura)' },
  { id:'MJ12', category:'Major', severity:'Critical' as const, points:5, label:'Sexually Deviant Behavior (Paninilip)' },
  { id:'MJ13', category:'Major', severity:'Major' as const, points:3, label:'Pagtanggi sa Intervention (Refusal)' },
  // MINOR OFFENSES
  { id:'MN01', category:'Minor', severity:'Minor' as const, points:1, label:'Pagsuway sa Schedule / Hindi Sumasali sa Activities' },
  { id:'MN02', category:'Minor', severity:'Minor' as const, points:1, label:'Pagbubukas ng Appliances / Pagpasok sa Restricted Areas' },
  { id:'MN03', category:'Minor', severity:'Minor' as const, points:1, label:'Pagsusuot ng Alahas / Palamuti' },
  { id:'MN04', category:'Minor', severity:'Minor' as const, points:1, label:'Pakikipagpalit ng Gamit sa Kapwa Residente' },
  { id:'MN05a', category:'Minor', severity:'Minor' as const, points:1, label:'Pag-iingay sa Oras ng Pag-aaral' },
  { id:'MN05b', category:'Minor', severity:'Minor' as const, points:1, label:'Pag-iingay sa Oras ng Panonood ng TV' },
  { id:'MN05c', category:'Minor', severity:'Minor' as const, points:1, label:'Pag-iingay sa Oras ng Pagtulog' },
  { id:'MN06', category:'Minor', severity:'Minor' as const, points:1, label:'Pagtago ng Pagkain sa Kwarto' },
  { id:'MN07', category:'Minor', severity:'Minor' as const, points:1, label:'Late Gumising / Pagligo ng Wala sa Oras' },
  { id:'MN08', category:'Minor', severity:'Minor' as const, points:1, label:'Hindi Pagkain sa Takdang Oras' },
  { id:'MN09', category:'Minor', severity:'Minor' as const, points:1, label:'Kawalang Respeto sa Hapag-Kainan' },
  { id:'MN10', category:'Minor', severity:'Minor' as const, points:1, label:'Vandalism (Pagsulat sa Pader)' },
  { id:'MN11', category:'Minor', severity:'Minor' as const, points:1, label:'Paglalagi sa Baba ng Walang Toka / Bintana' },
  { id:'MN12', category:'Minor', severity:'Minor' as const, points:1, label:'Walang Damit Itaas / Nakaboxer Shorts' },
  { id:'MN13', category:'Minor', severity:'Minor' as const, points:1, label:'Hindi Pag-ayos ng Higaan / Kutson' },
  { id:'MN14', category:'Minor', severity:'Minor' as const, points:1, label:'Pagsabit ng Gamit sa Bintana' },
  { id:'MN15', category:'Minor', severity:'Minor' as const, points:1, label:'Pakikipag-usap sa Residente sa Isolation' },
];

export function ChildDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { children, updateChild, addViolation, violations, refreshData, addDocument, documents } = useData();
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState(() => {
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    return tab || 'personal';
  });
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [violationFilter, setViolationFilter] = useState<'all' | 'severity' | 'type' | 'status'>('all');
  const [violationFilterValue, setViolationFilterValue] = useState<string>('all');
  const [interventionPlan, setInterventionPlan] = useState<any>(null);
  const [isInterventionOpen, setIsInterventionOpen] = useState(false);
  const [schedulingPopup, setSchedulingPopup] = useState<any>(null);
  const [isSchedulingPopupOpen, setIsSchedulingPopupOpen] = useState(false);
  const medicalFileRef = useRef<HTMLInputElement | null>(null);
  const [isUploadingMedical, setIsUploadingMedical] = useState(false);
  const [showEndorseDialog, setShowEndorseDialog] = useState(false);
  const [endorseTo, setEndorseTo] = useState('');
  const [endorseNote, setEndorseNote] = useState('');
  const [isEndorsing, setIsEndorsing] = useState(false);
  const [phaseRequirements, setPhaseRequirements] = useState<any>(null);

  // Fetch phase requirements from backend
  useEffect(() => {
    const fetchRequirements = async () => {
      try {
        const res = await request<{ success: boolean; data: any }>('/phases/requirements');
        if (res.success) {
          setPhaseRequirements(res.data);
        }
      } catch (err) {
        console.error('Failed to fetch phase requirements:', err);
      }
    };
    fetchRequirements();
  }, []);

  const handleMedicalDocUpload = async (file: File) => {
    if (!child) return;
    setIsUploadingMedical(true);
    const reader = new FileReader();
    reader.onloadend = async () => {
      try {
        const base64Data = reader.result as string;
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const docTitle = file.name.replace(/\.[^.]+$/, '');

        // Save directly as Approved — no review needed for medical docs
        await addDocument({
          residentId: child.id,
          residentName: child.name,
          category: 'Medical',
          title: docTitle,
          phase: child.casePhase || '',
          fileName: file.name,
          fileSize: file.size,
          fileData: base64Data,
          fileType: file.type,
          status: 'Approved',
          uploaderRole: user?.role || 'nurse',
          uploadedBy: user?.username || 'Nurse',
          uploadedAt: now.toISOString(),
          approvedBy: 'Auto-Approved',
          approvedAt: now.toISOString(),
        });

        // Build new medical record entry
        const newRecord = {
          id: Date.now().toString(),
          name: docTitle,
          category: 'Medical',
          dateUploaded: today,
          fileName: file.name,
          fileData: base64Data,
          fileType: file.type,
        };

        // Update child: lastCheckup + append to medicalRecords
        const updatedRecords = [...(child.medicalRecords || []), newRecord];
        await updateChild(child.id, {
          lastCheckup: today,
          medicalRecords: updatedRecords,
        });

        // refreshData would reload store which excludes fileData — don't call it
        // updateChild already updated lastCheckup and medicalRecords in state
      } catch (e) { console.error('Medical upload error:', e); }
      setIsUploadingMedical(false);
    };
    reader.onerror = () => setIsUploadingMedical(false);
    reader.readAsDataURL(file);
  };
  const [formData, setFormData] = useState({
    type: '',
    severity: 'Minor' as 'Minor' | 'Major' | 'Critical',
    points: 0,
    sessionType: 'group' as 'individual' | 'group',
  });

  const child = useMemo(() => children.find((c) => c.id === id), [id, children]);

  // Get violations for this child from the violations table
  const childViolations = useMemo(() => violations.filter((v) => v.residentId === id), [violations, id]);


  // Calculate total violation points from proper violations table
  const totalViolationPoints = useMemo(() => childViolations.filter(v => v.status !== 'Resolved').reduce((sum, v) => sum + v.points, 0), [childViolations]);

  const behaviorSummary = useMemo(() => {
    if (totalViolationPoints >= 10) return { totalPoints: totalViolationPoints, status: 'CRITICAL FLAG', color: 'bg-red-600' };
    if (totalViolationPoints >= 5)  return { totalPoints: totalViolationPoints, status: 'Monitoring',    color: 'bg-amber-500' };
    return { totalPoints: totalViolationPoints, status: 'Good Standing', color: 'bg-green-500' };
  }, [totalViolationPoints]);

  // ── Case Endorsement ──────────────────────────────────────────────


  const handleEndorse = async () => {
    if (!endorseTo.trim() || !child) return;
    setIsEndorsing(true);
    const now = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', hour12: true });
    const fromUser = (user?.username || 'Staff') + ' (' + (user?.role || '') + ')';
    const nl = String.fromCharCode(10);
    const entry = '[' + now + '] ' + fromUser + ' -> ' + endorseTo + ': ' + (endorseNote || 'Case endorsed');
    const existingNotes = child.notes || '';
    const hasSection = existingNotes.includes('[ENDORSEMENTS]');
    const newNotes = hasSection
      ? existingNotes + entry + nl
      : existingNotes + (existingNotes ? nl : '') + '[ENDORSEMENTS]' + nl + entry + nl;
    await updateChild(child.id, { notes: newNotes });
    setEndorseTo('');
    setEndorseNote('');
    setShowEndorseDialog(false);
    setIsEndorsing(false);
  };

  const endorsements = (() => {
    if (!child?.notes || !child.notes.includes('[ENDORSEMENTS]')) return [];
    const nl = String.fromCharCode(10);
    const parts = child.notes.split('[ENDORSEMENTS]' + nl);
    const block = parts[1] || '';
    return block.split(nl).filter(Boolean).map(line => {
      const idx1 = line.indexOf('] ');
      const idx2 = line.indexOf(' -> ');
      const idx3 = line.indexOf(': ', idx2);
      if (idx1 < 0 || idx2 < 0 || idx3 < 0) return null;
      return {
        timestamp: line.substring(1, idx1),
        from: line.substring(idx1 + 2, idx2),
        to: line.substring(idx2 + 4, idx3),
        note: line.substring(idx3 + 2),
      };
    }).filter(Boolean);
  })();

    const handleAddLog = async () => {
    if (!child || !formData.type.trim()) return;

    // Create violation in the proper violations table
    const violationData = {
      residentId: child.id,
      date: new Date().toISOString().split('T')[0],
      type: formData.type,
      description: `Incident recorded from ChildDetail: ${formData.type}`,
      severity: formData.severity as 'Minor' | 'Major' | 'Critical',
      points: Number(formData.points),
      location: '',
      witnesses: '',
      reportedBy: '',
      actionTaken: '',
      status: 'Pending Review' as const,
      requiresAssessment: true,
      assessmentTriggered: false,
      sessionType: formData.sessionType,
    };

    // Capture current form values before they get reset
    const capturedType = formData.type;
    const capturedSeverity = formData.severity;
    const capturedPoints = formData.points;
    const capturedSessionType = formData.sessionType;

    // This will auto-create assessment and alerts via backend
    const result = await addViolation(violationData);

    setIsLogModalOpen(false);
    setFormData({ type: '', severity: 'Minor', points: 1, sessionType: 'group' });

    if (result) {
      // result = saved violation object from DataContext (includes interventionPlan from backend)
      const plan = (result as any).interventionPlan;

      // Show intervention dialog
      if (plan && plan.immediateAction) {
        setInterventionPlan(plan);
        setIsInterventionOpen(true);
      }

      // ── Shared utilities ──────────────────────────────────────────────
      const getOffsetDate = (daysOffset: number): string => {
        const ms = new Date().getTime() + (8 * 60 * 60 * 1000) + (daysOffset * 24 * 60 * 60 * 1000);
        const d = new Date(ms);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
      };
      const AM_PM_SLOTS = ['8:00 AM','9:00 AM','10:00 AM','11:00 AM','1:00 PM','2:00 PM','3:00 PM','4:00 PM'];
      const tomorrowStr = getOffsetDate(1);
      const violationLower = capturedType.toLowerCase();

      // ── RULE MATRICES ─────────────────────────────────────────────────
      const ASSESSMENT_RULES = [
        { keywords: ['fight','assault','aggress','violence','attack','harm','weapon'],
          title: 'Crisis Intervention Assessment', type: 'Psychological', assessor: 'Psychologist' },
        { keywords: ['drug','substance','alcohol','inhale','sniff'],
          title: 'Substance Use Medical Assessment', type: 'Medical', assessor: 'Nurse' },
        { keywords: ['escape','runaway','awol','absent without leave'],
          title: 'Risk & Safety Assessment', type: 'Psychological', assessor: 'Psychologist' },
        { keywords: ['theft','steal','stolen','robbery'],
          title: 'Behavioral Assessment', type: 'Behavioral', assessor: 'Social Worker' },
        { keywords: ['bully','harass','intimidate','threaten'],
          title: 'Behavioral Assessment', type: 'Behavioral', assessor: 'Social Worker' },
        { keywords: ['disrespect','defiance','insubordination','attitude','conduct'],
          title: 'Behavioral Assessment', type: 'Behavioral', assessor: 'Social Worker' },
        { keywords: ['property','damage','destroy','vandal'],
          title: 'Behavioral Assessment', type: 'Behavioral', assessor: 'Social Worker' },
      ];
      const ACTIVITY_MATRIX = [
        { keywords: ['fight','assault','violence','attack','harm','aggress','weapon'],
          activity: 'Conflict Resolution Group Session', type: 'Behavioral Activity',
          location: 'Multi-Purpose Hall', facilitator: 'Social Worker',
          description: 'Group conflict resolution workshop. Children who committed violence-related violations are grouped to promote accountability, empathy, and peaceful communication.' },
        { keywords: ['theft','steal','stolen','robbery'],
          activity: 'Livelihood Skills Training', type: 'Livelihood Activity',
          location: 'Skills Training Room', facilitator: 'Educator',
          description: 'Livelihood activity to redirect focus to productive skills. Children with theft-related violations learn income-generating skills and develop responsibility.' },
        { keywords: ['bully','harass','intimidate','threaten'],
          activity: 'Team Building — Basketball', type: 'Sports & Recreation',
          location: 'Basketball Court', facilitator: 'Social Worker',
          description: 'Supervised basketball session to promote teamwork and sportsmanship. Children with bullying violations build positive peer relationships through structured play.' },
        { keywords: ['property','damage','destroy','vandal'],
          activity: 'Clean-Up Drive & Facility Maintenance', type: 'Community Service',
          location: 'Facility Grounds', facilitator: 'Educator',
          description: 'Restorative clean-up activity. Children who damaged property take responsibility by cleaning and maintaining the facility, building respect for shared spaces.' },
        { keywords: ['disrespect','defiance','insubordination','attitude','conduct'],
          activity: 'Values Formation Session', type: 'Behavioral Activity',
          location: 'Counseling Room', facilitator: 'Social Worker',
          description: 'Structured values formation and reflection. Children with conduct violations discuss respect, discipline, and positive behavior within the facility.' },
        { keywords: ['escape','runaway','awol','absent without leave'],
          activity: 'Gardening & Nature Care', type: 'Therapeutic Activity',
          location: 'Facility Garden', facilitator: 'Educator',
          description: 'Therapeutic gardening to build routine, responsibility, and connection to the facility. Children with AWOL violations engage in supervised outdoor activity.' },
        { keywords: ['drug','substance','alcohol','inhale','sniff'],
          activity: 'Health & Wellness Workshop', type: 'Health Activity',
          location: 'Health Room', facilitator: 'Nurse',
          description: 'Health education on substance awareness and wellness. Children with substance-related violations join guided discussion and healthy lifestyle coaching.' },
      ];

      // Assessment scheduling handled entirely by backend
    } // end if (result)

    // Refresh to sync all backend-generated data
    setTimeout(() => refreshData(), 600);
  };

  // Auto-assign penalty points based on severity when severity changes
  const handleSeverityChange = (severity: 'Minor' | 'Major' | 'Critical') => {
    const defaultPoints = severity === 'Critical' ? 5 : severity === 'Major' ? 3 : 1;
    setFormData((prev) => ({ ...prev, severity, points: defaultPoints }));
  };

  if (!child) return <div className="p-10 text-center">Resident record not found.</div>;

  return (
    <div className="space-y-6 pb-10">
      <div className="flex items-center justify-between">
        <Button onClick={() => navigate('/children')} variant="ghost" className="flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <Button 
          onClick={() => setActiveTab('behavioral')}
          className={`${behaviorSummary.color} text-white px-4 py-1.5 flex gap-2 shadow-sm hover:opacity-90`}
        >
          <ShieldAlert className="w-4 h-4" /> {behaviorSummary.status}
        </Button>
      </div>

      <Card className="border-l-4 border-l-[#2F3E46]">
        <CardContent className="p-6">
          <h2 className="text-2xl font-bold text-[#2F3E46]">{child.name}</h2>
          <p className="text-sm text-gray-500">ID: {child.id} | Case Type: {child.caseType}</p>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-5 bg-gray-100/50 p-1">
          {(() => {
            const role = user?.role?.toLowerCase();
            const isAdmin = role === 'centerhead' || role === 'admin';
            const allowedTabs: string[] = isAdmin
              ? ['Personal Info', 'Phase Timeline', 'Case Progress', 'Medical', 'Behavioral']
              : (user?.childRecordTabs != null
                ? user.childRecordTabs
                : ['Personal Info', 'Phase Timeline', 'Case Progress', 'Medical', 'Behavioral']);
            return (
              <>
                {allowedTabs.includes('Personal Info') && <TabsTrigger value="personal">Personal Info</TabsTrigger>}
                {allowedTabs.includes('Phase Timeline') && <TabsTrigger value="timeline">Phase Timeline</TabsTrigger>}
                {allowedTabs.includes('Case Progress') && <TabsTrigger value="case">Case Progress</TabsTrigger>}
                {allowedTabs.includes('Medical') && <TabsTrigger value="medical">Medical</TabsTrigger>}
                {allowedTabs.includes('Behavioral') && <TabsTrigger value="behavioral">Behavioral</TabsTrigger>}
              </>
            );
          })()}
        </TabsList>

        {/* PERSONAL INFO TAB */}
        <TabsContent value="personal" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Basic Info + Location & Guardian Combined */}
            <Card className="md:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <User className="w-4 h-4" /> Basic Information
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-2 text-sm">
                <div className="flex justify-between border-b pb-1">
                  <span className="text-gray-500">Full Name</span>
                  <span className="font-semibold">{child.name}</span>
                </div>
                <div className="flex justify-between border-b pb-1">
                  <span className="text-gray-500">Birth Date</span>
                  <span className="font-semibold">{child.birthDate ? formatShortDate(child.birthDate) : '—'}</span>
                </div>
                <div className="flex justify-between border-b pb-1">
                  <span className="text-gray-500">Home Address</span>
                  <span className="font-semibold text-right max-w-[200px]">{child.address || '—'}</span>
                </div>
                <div className="flex justify-between border-b pb-1">
                  <span className="text-gray-500">Age</span>
                  <span className="font-semibold">{child.age} years old</span>
                </div>
                <div className="flex justify-between border-b pb-1">
                  <span className="text-gray-500">Gender</span>
                  <span className="font-semibold">{child.gender}</span>
                </div>
                <div className="flex justify-between border-b pb-1">
                  <span className="text-gray-500">Guardian Name</span>
                  <span className="font-semibold">{child.guardianName || '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Admission Date</span>
                  <span className="font-semibold">{formatShortDate(child.admissionDate)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Guardian Contact</span>
                  <span className="font-semibold">{child.guardianContact || '—'}</span>
                </div>
              </CardContent>
            </Card>

            {/* Case Info */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <FileText className="w-4 h-4" /> Case Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between border-b pb-1">
                  <span className="text-gray-500">Case ID</span>
                  <span className="font-semibold font-mono">{child.id}</span>
                </div>
                <div className="flex justify-between border-b pb-1">
                  <span className="text-gray-500">Specific Offense</span>
                  <span className="font-semibold">{child.caseType || '—'}</span>
                </div>
                <div className="flex justify-between border-b pb-1">
                  <span className="text-gray-500">Legal Category</span>
                  <span className="font-semibold">{child.legalCategory || '—'}</span>
                </div>
                <div className="flex justify-between border-b pb-1">
                  <span className="text-gray-500">Shelter Admissions</span>
                  <span className={`font-semibold ${child.isRepeatOffender ? 'text-orange-600' : 'text-green-600'}`}>
                    {(() => {
                      const previousCasesCount = Array.isArray((child as any).previousCases) ? (child as any).previousCases.length : 0;
                      const currentAdmissionNumber = previousCasesCount + 1;
                      const ordinalSuffix = 
                        currentAdmissionNumber === 1 ? 'st' :
                        currentAdmissionNumber === 2 ? 'nd' :
                        currentAdmissionNumber === 3 ? 'rd' : 'th';
                      return child.isRepeatOffender 
                        ? `${currentAdmissionNumber}${ordinalSuffix} Time Returning Resident`
                        : '1st Time Resident';
                    })()}
                  </span>
                </div>

              </CardContent>
            </Card>

            {/* Previous Case & Violation History */}
            {(child.isRepeatOffender || childViolations.length > 0) && (
              <Card className="md:col-span-2">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Clock className="w-4 h-4" /> Previous Case & Violation History
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {/* Previous shelter admissions — structured history */}
                  {child.isRepeatOffender && (
                    <div className="space-y-2">
                      <p className="text-xs font-bold text-orange-700 uppercase tracking-wide">Shelter Admission History</p>
                      {/* Structured previous cases */}
                      {Array.isArray((child as any).previousCases) && (child as any).previousCases.length > 0 ? (
                        (child as any).previousCases.map((pc: any, i: number) => (
                          <div key={i} className="p-3 rounded-lg bg-orange-50 border border-orange-200">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-bold text-orange-700">{pc.offense || `${i+1}st Offense`}</span>
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                pc.closedDate || pc.status === 'Closed' || pc.status === 'Discharged' 
                                  ? 'bg-green-100 text-green-700' 
                                  : 'bg-orange-100 text-orange-700'
                              }`}>
                                {pc.closedDate || pc.status === 'Closed' || pc.status === 'Discharged' ? 'Closed' : 'Active'}
                              </span>
                            </div>
                            <div className="space-y-0.5 text-xs text-orange-800">
                              <p><span className="font-semibold">Offense:</span> {pc.caseType || '—'}</p>
                              <p><span className="font-semibold">Category:</span> {pc.legalCategory || '—'}</p>
                              {pc.admissionDate && (
                                <p><span className="font-semibold">Admitted:</span> {new Date(pc.admissionDate).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                              )}
                              {pc.closedDate && (
                                <p><span className="font-semibold">Closed:</span> {new Date(pc.closedDate).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                              )}
                              {pc.phaseReached && (
                                <p><span className="font-semibold">Phase reached:</span> {pc.phaseReached}</p>
                              )}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="p-3 rounded-lg bg-orange-50 border border-orange-200">
                          <p className="text-xs text-orange-600">{child.previousCaseDetails || 'Previously admitted to the shelter.'}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Violation history */}
                  {childViolations.length > 0 && (
                    <div>
                      <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Recorded Incidents</p>
                      <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {childViolations.map((v, i) => (
                          <div key={v.id || i} className={`flex items-start gap-3 p-2 rounded-lg border text-xs ${
                            v.severity === 'Critical' ? 'border-red-200 bg-red-50' :
                            v.severity === 'Major'    ? 'border-orange-200 bg-orange-50' :
                                                        'border-yellow-100 bg-yellow-50'
                          }`}>
                            <span className={`mt-0.5 shrink-0 font-bold px-1.5 py-0.5 rounded text-[10px] ${
                              v.severity === 'Critical' ? 'bg-red-200 text-red-800' :
                              v.severity === 'Major'    ? 'bg-orange-200 text-orange-800' :
                                                          'bg-yellow-200 text-yellow-800'
                            }`}>{v.severity}</span>
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-gray-800 truncate">{v.type}</p>
                              {v.description && <p className="text-gray-500 text-[10px] truncate">{v.description}</p>}
                            </div>
                            <span className="text-gray-400 shrink-0 text-[10px]">{v.date}</span>
                            <span className={`shrink-0 text-[10px] font-semibold ${v.status === 'Resolved' ? 'text-green-600' : 'text-gray-500'}`}>
                              {v.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {childViolations.length === 0 && !child.isRepeatOffender && (
                    <p className="text-xs text-gray-400 italic">No violation history recorded.</p>
                  )}
                </CardContent>
              </Card>
            )}


          </div>
        </TabsContent>

        {/* CASE PROGRESS TAB */}
        <TabsContent value="case" className="mt-4 space-y-5">
          {(() => {
            const currentIndex = casePhases.indexOf(child.casePhase ?? '');
            const safeIndex = currentIndex === -1 ? 0 : currentIndex;
            const currentPhase = PHASE_CONFIG[safeIndex];

            // Dynamic progress: count approved documents + completed tasks across all phases
            const totalPhasesCompleted = safeIndex; // phases fully passed
            const currentPhaseConfig = currentPhase;
            const totalRequiredDocs = currentPhaseConfig?.requiredDocs?.length || 0;
            const totalRequiredTasks = currentPhaseConfig?.tasks?.length || 0;
            const totalRequirements = totalRequiredDocs + totalRequiredTasks;

            // Count approved docs for current phase from DataContext
            // (We approximate based on phase index: each completed phase = full weight)
            // Overall: 0% at start, grows as phases complete + within-phase doc approvals
            const phaseWeight = 100 / Math.max(casePhases.length, 1);
            const completedPhasesPct = totalPhasesCompleted * phaseWeight;
            // Within current phase — this will be updated by PhaseProgress component
            // For now show phase-based progress (0% if at phase 0 with no docs)
            const progressPct = child.status === 'Discharged'
              ? 100
              : Math.round(totalPhasesCompleted === 0 && safeIndex === 0 ? 0 : completedPhasesPct);

            return (
              <>
                {/* ── SUMMARY BANNER ── */}
                <Card className={`border-l-4 ${currentPhase.borderColor} shadow-sm`}>
                  <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
                    <div className={`p-3 rounded-xl ${currentPhase.bgColor} shrink-0`}>
                      <span className={currentPhase.color}>{currentPhase.icon}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] uppercase font-bold tracking-widest text-gray-400 mb-0.5">
                        Current Phase — {safeIndex + 1} of {casePhases.length}
                      </p>
                      <h3 className={`text-lg font-black ${currentPhase.color} leading-tight`}>
                        {currentPhase.shortLabel}
                      </h3>
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{currentPhase.description}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <span className={`text-3xl font-black ${currentPhase.color}`}>{progressPct}%</span>
                      <p className="text-[10px] text-gray-400 uppercase tracking-wide">Complete</p>
                    </div>
                  </CardContent>
                </Card>

                {/* ── HORIZONTAL PROGRESS BAR ── */}
                <Card className="shadow-sm">
                  <CardContent className="p-5 space-y-3">
                    <div className="flex justify-between items-center text-xs text-gray-500 font-medium">
                      <span>Admission</span>
                      <span>Discharge</span>
                    </div>
                    {/* Track */}
                    <div className="relative h-3 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="absolute left-0 top-0 h-full rounded-full transition-all duration-700"
                        style={{
                          width: `${progressPct}%`,
                          background: 'linear-gradient(90deg, #6d28d9, #2563eb, #0891b2, #d97706, #ea580c, #16a34a, #059669)',
                          backgroundSize: '700% 100%',
                          backgroundPosition: `${(safeIndex / (casePhases.length - 1)) * 100}% 0`,
                        }}
                      />
                    </div>
                    {/* Phase dots */}
                    <div className="flex justify-between mt-1">
                      {PHASE_CONFIG.map((phase, i) => {
                        const done = i < safeIndex;
                        const active = i === safeIndex;
                        return (
                          <div
                            key={phase.label}
                            title={phase.label}
                            className="flex flex-col items-center gap-1 group"
                          >
                            <div
                              className={`w-7 h-7 rounded-full flex items-center justify-center border-2 transition-all duration-200
                                ${active
                                  ? `${phase.bgColor} ${phase.borderColor} shadow-md scale-110`
                                  : done
                                  ? 'bg-gray-200 border-gray-300'
                                  : 'bg-white border-gray-200 opacity-50 group-hover:opacity-80'
                                }`}
                            >
                              {done ? (
                                <CheckCircle2 className="w-4 h-4 text-gray-400" />
                              ) : active ? (
                                <span className={phase.color}>{phase.icon}</span>
                              ) : (
                                <Circle className="w-3 h-3 text-gray-300" />
                              )}
                            </div>
                            <span
                              className={`text-[9px] font-semibold leading-tight text-center max-w-[52px] hidden sm:block
                                ${active ? phase.color : done ? 'text-gray-400' : 'text-gray-300'}`}
                            >
                              {phase.shortLabel}
                            </span>
                          </div>
                        );
                      })}
                      {/* Case Closed final dot */}
                      {child.status === 'Discharged' && (
                        <>
                          <div className="w-4 h-0.5 bg-emerald-400" />
                          <div className="flex flex-col items-center gap-1">
                            <div className="w-7 h-7 rounded-full flex items-center justify-center border-2 bg-emerald-500 border-emerald-500 shadow-md">
                              <CheckCircle2 className="w-4 h-4 text-white" />
                            </div>
                            <span className="text-[9px] font-semibold text-emerald-600 hidden sm:block">Closed</span>
                          </div>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>

                {/* Case Closed step + banner */}
                {child.status === 'Discharged' && (
                  <Card className="border-2 border-emerald-400 bg-emerald-50 shadow-sm">
                    <CardContent className="p-5 flex items-center gap-4">
                      <div className="p-3 bg-emerald-500 rounded-xl shrink-0">
                        <CheckCircle2 className="w-6 h-6 text-white" />
                      </div>
                      <div className="flex-1">
                        <h3 className="text-lg font-black text-emerald-700">CASE CLOSED</h3>
                        <p className="text-sm text-emerald-600">All rehabilitation phases completed. Child officially discharged.</p>
                      </div>
                      <span className="text-4xl font-black text-emerald-600">100%</span>
                    </CardContent>
                  </Card>
                )}

                {/* ── PHASE DETAIL CARD ── */}
                <Card className={`border ${currentPhase.borderColor} ${currentPhase.bgColor}/20 shadow-sm`}>
                  <CardHeader className="pb-2">
                    <CardTitle className={`text-sm font-bold flex items-center gap-2 ${currentPhase.color}`}>
                      {currentPhase.icon}
                      Phase {safeIndex + 1}: {currentPhase.label}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-sm text-gray-600">{currentPhase.description}</p>

                    {/* Task checklist */}
                    <div>
                      <p className="text-[10px] uppercase font-bold text-gray-400 mb-2 tracking-wider">
                        Phase Requirements
                      </p>
                      {phaseRequirements && phaseRequirements[currentPhase.label] ? (
                        <div className="space-y-2">
                          {phaseRequirements[currentPhase.label].requiredTasks?.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-gray-600 mb-1">Tasks:</p>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {phaseRequirements[currentPhase.label].requiredTasks.map((task: string) => (
                                  <div key={task} className="flex items-center gap-2 text-sm text-gray-700">
                                    <Circle className={`w-3 h-3 shrink-0 ${currentPhase.color}`} />
                                    {task}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {phaseRequirements[currentPhase.label].requiredDocuments?.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-gray-600 mb-1">Documents:</p>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {phaseRequirements[currentPhase.label].requiredDocuments.map((doc: string) => (
                                  <div key={doc} className="flex items-center gap-2 text-sm text-gray-700">
                                    <Circle className={`w-3 h-3 shrink-0 ${currentPhase.color}`} />
                                    {doc}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          <p className="text-xs text-blue-600 italic mt-3 p-2 bg-blue-50 rounded">
                            ℹ️ Use the <strong>Phase Timeline</strong> tab to track completion status and upload documents.
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {currentPhase.tasks.map((task) => (
                              <div key={task} className="flex items-center gap-2 text-sm text-gray-700">
                                <CheckCircle2 className={`w-4 h-4 shrink-0 ${currentPhase.color}`} />
                                {task}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Navigation info — actual advancement done via Phase Timeline tab */}
                    <div className="flex justify-between items-center pt-2 border-t border-gray-100">
                      <span className="text-xs text-gray-400 font-medium">
                        Phase {safeIndex + 1} of {casePhases.length}
                      </span>
                      <span className="text-xs text-gray-500 italic">Use the Phase Timeline tab to advance phases with validation.</span>
                    </div>
                  </CardContent>
                </Card>


              </>
            );
          })()}

          {/* ── Case Endorsements / Handovers ── */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <ArrowRight className="w-4 h-4" /> Case Endorsements / Handovers
                </CardTitle>
                <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => setShowEndorseDialog(true)}>
                  + Endorse Case
                </Button>
              </div>
            </CardHeader>
            <CardContent className="text-sm space-y-2">
              {endorsements.length === 0 ? (
                <p className="text-xs text-gray-400 italic">No endorsements recorded yet.</p>
              ) : endorsements.map((e, i) => e && (
                <div key={i} className="flex items-start gap-3 p-2 rounded-lg border border-gray-100 bg-gray-50">
                  <div className="w-2 h-2 rounded-full bg-[#FFD100] mt-1.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold text-[#2F3E46]">{e.from}</span>
                      <ArrowRight className="w-3 h-3 text-gray-400" />
                      <span className="text-xs font-bold text-blue-600">{e.to}</span>
                      <span className="text-[10px] text-gray-400 ml-auto">{e.timestamp}</span>
                    </div>
                    {e.note && <p className="text-xs text-gray-500 mt-0.5">{e.note}</p>}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Endorse Dialog */}
          <Dialog open={showEndorseDialog} onOpenChange={setShowEndorseDialog}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle className="text-[#2F3E46]">Endorse / Handover Case</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <div className="space-y-1">
                  <Label className="text-xs font-bold text-gray-600">Endorse To</Label>
                  <Select value={endorseTo} onValueChange={setEndorseTo}>
                    <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select recipient..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Center Head">Center Head</SelectItem>
                      <SelectItem value="Psychologist">Psychologist</SelectItem>
                      <SelectItem value="Social Worker">Social Worker</SelectItem>
                      <SelectItem value="Nurse">Nurse</SelectItem>
                      <SelectItem value="Educator">Educator</SelectItem>
                      <SelectItem value="Court">Court</SelectItem>
                      <SelectItem value="Guardian / Family">Guardian / Family</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-bold text-gray-600">Notes / Reason</Label>
                  <textarea
                    value={endorseNote}
                    onChange={e => setEndorseNote(e.target.value)}
                    placeholder="e.g. For psychological evaluation, final case review..."
                    rows={3}
                    className="w-full text-sm rounded-xl border border-gray-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#FFD100]"
                  />
                </div>
              </div>
              <DialogFooter className="gap-2">
                <Button variant="ghost" onClick={() => setShowEndorseDialog(false)}>Cancel</Button>
                <Button
                  onClick={handleEndorse}
                  disabled={!endorseTo || isEndorsing}
                  className="bg-[#2F3E46] hover:bg-[#1e2a30] text-white"
                >
                  {isEndorsing ? 'Saving...' : 'Save Endorsement'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

        </TabsContent>

        {/* PHASE TIMELINE TAB */}
        <TabsContent value="timeline" className="mt-4">
          <PhaseProgress
            residentId={child.id}
            currentPhase={child.casePhase || 'Admission'}
            onPhaseAdvanced={() => refreshData()}
          />
        </TabsContent>

        {/* MEDICAL TAB */}
        <TabsContent value="medical" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 gap-4">
            <Card className="bg-green-50/50 border-green-100">
              <CardContent className="p-4 flex items-center gap-4">
                <div className="p-3 bg-white rounded-lg shadow-sm">
                  <CalendarCheck className="w-6 h-6 text-green-600" />
                </div>
                <div>
                  <p className="text-[10px] uppercase font-bold text-green-600 tracking-wider">Last Checkup</p>
                  <p className="text-xl font-black text-slate-700">{child.lastCheckup && child.lastCheckup.trim() !== '' ? new Date(child.lastCheckup).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold text-slate-600">Medical Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-500 italic">
                {child.notes || 'No known allergies. Up to date with basic vaccinations.'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-sm font-bold text-slate-700">Health & Medical History</CardTitle>
              <>
                <input
                  type="file"
                  ref={medicalFileRef}
                  className="hidden"
                  accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.xls,.xlsx"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) await handleMedicalDocUpload(file);
                    if (e.target) e.target.value = '';
                  }}
                />
                <Button
                  size="sm"
                  className="bg-[#2F3E46] hover:bg-[#263440] text-white flex gap-2 h-8"
                  onClick={() => medicalFileRef.current?.click()}
                  disabled={isUploadingMedical}
                >
                  <Plus className="w-4 h-4" /> {isUploadingMedical ? 'Uploading...' : 'Add Document'}
                </Button>
              </>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border border-gray-100 overflow-hidden">
                <table className="w-full text-sm text-left">
                  <thead className="bg-gray-50 border-b text-gray-600">
                    <tr>
                      <th className="p-3 font-semibold">Document Name</th>
                      <th className="p-3 font-semibold">Category</th>
                      <th className="p-3 font-semibold">Date Uploaded</th>
                      <th className="p-3 text-right font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {(() => {
                      // Combine child.medicalRecords with documents from DataContext (live)
                      const docModuleMedical = documents
                        .filter(d => d.residentId === child.id && d.category === 'Medical')
                        .map(d => ({
                          id: d.id,
                          name: d.title,
                          category: 'Medical',
                          dateUploaded: d.uploadedAt ? d.uploadedAt.split('T')[0] : d.approvedAt?.split('T')[0] || '—',
                          fileName: d.fileName,
                          fileData: d.fileData,
                        }));
                      const legacyRecords = (child.medicalRecords || []).filter(r =>
                        !docModuleMedical.some(d => d.name === r.name)
                      );
                      const allRecords = [...docModuleMedical, ...legacyRecords];
                      if (allRecords.length === 0) return (
                        <tr>
                          <td colSpan={4} className="p-10 text-center">
                            <div className="flex flex-col items-center gap-2 opacity-30">
                              <Stethoscope className="w-10 h-10" />
                              <p className="text-sm italic">No medical records found for this resident.</p>
                            </div>
                          </td>
                        </tr>
                      );
                      return allRecords.map((rec) => (
                        <tr key={rec.id} className="hover:bg-gray-50/50">
                          <td className="p-3 font-medium">{rec.name}</td>
                          <td className="p-3 text-gray-500">{rec.category}</td>
                          <td className="p-3 text-gray-500">{rec.dateUploaded}</td>
                          <td className="p-3 text-right">
                            {rec.fileData && (
                              <a href={rec.fileData} download={rec.fileName || rec.name}
                                className="text-xs text-[#2F3E46] underline font-semibold">
                                Download
                              </a>
                            )}
                          </td>
                        </tr>
                      ));
                    })()}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* BEHAVIORAL TAB */}
        <TabsContent value="behavioral" className="mt-4 space-y-4">
          {/* Behavioral Status + Interventions (no points shown) */}
          {(() => {
            const statusInfo =
              totalViolationPoints >= 10 ? { label: 'CRITICAL',      border: 'border-red-200',    bg: 'bg-red-50',    text: 'text-red-700',    icon: 'text-red-600'    } :
              totalViolationPoints >= 6  ? { label: 'SEVERE',        border: 'border-orange-200', bg: 'bg-orange-50', text: 'text-orange-700', icon: 'text-orange-600' } :
              totalViolationPoints >= 3  ? { label: 'MODERATE',      border: 'border-yellow-200', bg: 'bg-yellow-50', text: 'text-yellow-700', icon: 'text-yellow-600' } :
                                           { label: 'GOOD STANDING', border: 'border-green-200',  bg: 'bg-green-50',  text: 'text-green-700',  icon: 'text-green-600'  };

            const majorV = childViolations.filter(v => v.severity === 'Major' || v.severity === 'Critical');
            const minorV = childViolations.filter(v => v.severity === 'Minor');
            const offenseLevel =
              majorV.length >= 3 || (majorV.length >= 1 && minorV.length >= 5) ? '3rd Offense or Higher' :
              majorV.length >= 2 || (majorV.length >= 1 && minorV.length >= 3) ? '2nd Offense' :
              majorV.length >= 1 || minorV.length >= 3 ? '1st Offense' : 'No Active Violations';

            const steps: string[] =
              totalViolationPoints >= 10 ? [
                'Immediate case conference required',
                'Psychological assessment referral',
                'Notify Center Head and Guardian',
                'Review safety plan',
              ] : totalViolationPoints >= 6 ? [
                'Schedule psychological evaluation',
                'Increase behavioral monitoring',
                'Individual counseling sessions',
              ] : totalViolationPoints >= 3 ? [
                'Regular behavioral check-ins',
                'Group psychosocial sessions recommended',
                'Review current intervention plan',
              ] : [
                'Continue current intervention plan',
                'Maintain regular activity participation',
              ];

            return (
              <Card className={`${statusInfo.border} ${statusInfo.bg}`}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <ShieldAlert className={`w-7 h-7 ${statusInfo.icon}`} />
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wide">Behavioral Status</p>
                        <p className={`text-xl font-bold ${statusInfo.text}`}>{statusInfo.label}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-gray-500 uppercase tracking-wide">Offense Level</p>
                      <p className={`text-sm font-bold ${statusInfo.text}`}>{offenseLevel}</p>
                    </div>
                  </div>
                  <div className={`border-t ${statusInfo.border} pt-3`}>
                    <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">Recommended Interventions</p>
                    <ol className="space-y-1">
                      {steps.map((s, i) => (
                        <li key={i} className={`flex items-start gap-2 text-xs ${statusInfo.text}`}>
                          <span className="font-bold shrink-0">{i+1}.</span><span>{s}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-gray-700">Incident History</h3>
            <div className="flex gap-3 items-center">
              <Select value={violationFilterValue} onValueChange={setViolationFilterValue}>
                <SelectTrigger className="w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Violations</SelectItem>
                  <SelectItem value="Critical">Critical Severity</SelectItem>
                  <SelectItem value="Major">Major Severity</SelectItem>
                  <SelectItem value="Minor">Minor Severity</SelectItem>
                  <SelectItem value="Resolved">Resolved Only</SelectItem>
                  <SelectItem value="Unresolved">Unresolved Only</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={() => setIsLogModalOpen(true)} className="bg-red-600 hover:bg-red-700">
                <Plus className="mr-2 h-4 w-4" /> Add Incident
              </Button>
            </div>
          </div>

          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 border-b text-gray-600">
                  <tr>
                    <th className="p-3">Date</th>
                    <th className="p-3">Type</th>
                    <th className="p-3">Severity</th>
                    <th className="p-3">Status</th>

                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(() => {
                    let filtered = childViolations;
                    
                    if (violationFilterValue !== 'all') {
                      if (violationFilterValue === 'Resolved') {
                        filtered = childViolations.filter(v => v.status === 'Resolved');
                      } else if (violationFilterValue === 'Unresolved') {
                        filtered = childViolations.filter(v => v.status !== 'Resolved');
                      } else {
                        // Filter by severity
                        filtered = childViolations.filter(v => v.severity === violationFilterValue);
                      }
                    }
                    
                    return filtered.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="p-8 text-center text-gray-400 italic text-sm">
                          {violationFilterValue === 'all' ? 'No violations recorded in system.' : 'No violations match the selected filter.'}
                        </td>
                      </tr>
                    ) : (
                      filtered.map((violation) => (
                        <tr key={violation.id} className={`hover:bg-gray-50/50 ${violation.status === 'Resolved' ? 'opacity-60' : ''}`}>
                          <td className="p-3">{formatShortDate(violation.date)}</td>
                          <td className="p-3 font-medium">{violation.type}</td>
                          <td className="p-3">
                            <Badge
                              variant="outline"
                              className={
                                violation.severity === 'Critical'
                                  ? 'border-red-400 text-red-600'
                                  : violation.severity === 'Major'
                                  ? 'border-orange-400 text-orange-600'
                                  : 'border-yellow-400 text-yellow-600'
                              }
                            >
                              {violation.severity}
                            </Badge>
                          </td>
                          <td className="p-3">
                            <Badge className={
                              violation.status === 'Resolved' ? 'bg-green-100 text-green-800' :
                              violation.status === 'Under Investigation' ? 'bg-blue-100 text-blue-800' :
                              violation.status === 'Escalated' ? 'bg-red-100 text-red-800' :
                              'bg-gray-100 text-gray-800'
                            }>
                              {violation.status}
                            </Badge>
                            {violation.assessmentTriggered && (
                              <span className="ml-1 text-xs text-blue-600" title="Assessment auto-created">(A)</span>
                            )}
                          </td>
                          <td className="p-3 text-right font-bold">{violation.points}</td>
                        </tr>
                      ))
                    );
                  })()}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {/* Old behavioral logs (legacy data) */}
          {(child.behavioralLogs || []).length > 0 && (
            <Card className="opacity-75">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-gray-500">Legacy Incident Logs (Pre-Migration)</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm text-left">
                  <tbody className="divide-y">
                    {child.behavioralLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-gray-50/50">
                        <td className="p-2 text-xs">{formatShortDate(log.date)}</td>
                        <td className="p-2 text-xs">{log.type}</td>
                        <td className="p-2 text-xs text-right">{log.points} pts</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* VIOLATION MODAL */}
      <Dialog open={isLogModalOpen} onOpenChange={setIsLogModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Incident</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Infraction Type — SCH Matrix Dropdown */}
            <div className="space-y-2">
              <Label>Infraction Type</Label>
              <Select
                value={formData.type}
                onValueChange={(v) => {
                  const found = SCH_VIOLATION_MATRIX.find(m => m.label === v);
                  if (found) {
                    setFormData(prev => ({
                      ...prev,
                      type: found.label,
                      severity: found.severity,
                      points: found.points,
                    }));
                  }
                }}
              >
                <SelectTrigger><SelectValue placeholder="Select infraction type..." /></SelectTrigger>
                <SelectContent className="max-h-80">
                  <div className="px-2 py-1.5 text-[10px] font-black uppercase text-red-500 tracking-wider">⚠ Major Offenses (3–5 pts)</div>
                  {SCH_VIOLATION_MATRIX.filter(m => m.category === 'Major').map(m => (
                    <SelectItem key={m.id} value={m.label}>
                      <div className="flex items-center gap-2">
                        <span className={m.severity === 'Critical' ? 'w-2 h-2 rounded-full bg-red-600 shrink-0' : 'w-2 h-2 rounded-full bg-orange-500 shrink-0'} />
                        <span className="text-sm">{m.label}</span>
                        <span className="text-[10px] text-gray-400 ml-auto">{m.points}pts</span>
                      </div>
                    </SelectItem>
                  ))}
                  <div className="px-2 py-1.5 text-[10px] font-black uppercase text-yellow-600 tracking-wider border-t">Minor Offenses (1 pt)</div>
                  {SCH_VIOLATION_MATRIX.filter(m => m.category === 'Minor').map(m => (
                    <SelectItem key={m.id} value={m.label}>
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-yellow-400 shrink-0" />
                        <span className="text-sm">{m.label}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Auto severity badge */}
              {formData.type && (
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border ${
                  formData.severity === 'Critical' ? 'bg-red-50 text-red-700 border-red-200' :
                  formData.severity === 'Major' ? 'bg-orange-50 text-orange-700 border-orange-200' :
                  'bg-yellow-50 text-yellow-700 border-yellow-200'
                }`}>
                  <span className={`w-2 h-2 rounded-full ${formData.severity === 'Critical' ? 'bg-red-600' : formData.severity === 'Major' ? 'bg-orange-500' : 'bg-yellow-400'}`} />
                  {formData.severity} Offense — {formData.points} point{formData.points !== 1 ? 's' : ''}
                  <span className="text-gray-400 font-normal ml-1">· auto-set</span>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Penalty Points</Label>
              <Input
                type="number"
                min={0}
                value={formData.points}
                onChange={(e) => setFormData({ ...formData, points: Number(e.target.value) })}
              />
            </div>

            <div className="space-y-2">
              <Label>Intervention Session Type</Label>
              <Select
                value={formData.sessionType}
                onValueChange={(v) => setFormData({ ...formData, sessionType: v as 'individual' | 'group' })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="group">
                    <span className="flex items-center gap-2">
                      <span className="text-blue-500">👥</span>
                      Group Session — merge with children with same violation
                    </span>
                  </SelectItem>
                  <SelectItem value="individual">
                    <span className="flex items-center gap-2">
                      <span className="text-green-500">👤</span>
                      Individual Session — dedicated one-on-one assessment
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-400 italic">
                Group: child is merged into an existing scheduled assessment. Individual: a separate session is created.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsLogModalOpen(false)}>Cancel</Button>
            <Button onClick={handleAddLog} className="bg-red-700 hover:bg-red-800 text-white">
              Confirm Entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Auto-Scheduling Popup */}
      <Dialog open={isSchedulingPopupOpen} onOpenChange={setIsSchedulingPopupOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#2F3E46]">
              <span className="text-2xl">{schedulingPopup?.sessionType === 'individual' ? '👤' : '👥'}</span>
              Auto-Scheduled: {schedulingPopup?.sessionType === 'individual' ? 'Individual' : 'Group'} Assessment
            </DialogTitle>
          </DialogHeader>
          {schedulingPopup && (
            <div className="space-y-3 text-sm">
              <div className="p-3 rounded-lg border bg-blue-50 border-blue-200">
                <p className="font-semibold text-blue-800">{schedulingPopup.childName} — {schedulingPopup.severity} violation: "{schedulingPopup.violationType}"</p>
              </div>

              {schedulingPopup.assessment && (
                <div className="p-3 bg-green-50 border border-green-200 rounded space-y-1">
                  <p className="text-[10px] uppercase font-bold text-green-600 tracking-wider">✅ Assessment Scheduled</p>
                  <p className="font-semibold text-green-800">{schedulingPopup.assessment.title}</p>
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    <div>
                      <p className="text-[10px] text-green-500 uppercase">Date</p>
                      <p className="text-green-800">{schedulingPopup.assessment.date}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-green-500 uppercase">Time</p>
                      <p className="text-green-800">{schedulingPopup.assessment.time}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-green-500 uppercase">Assessor</p>
                      <p className="text-green-800">{schedulingPopup.assessment.assessor}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-green-500 uppercase">Type</p>
                      <p className="text-green-800">{schedulingPopup.assessment.type}</p>
                    </div>
                  </div>
                  {schedulingPopup.assessment.merged && (
                    <p className="text-xs text-green-600 mt-1 italic">👥 Child grouped into existing assessment session</p>
                  )}
                </div>
              )}

              {schedulingPopup.activity && (
                <div className="p-3 bg-purple-50 border border-purple-200 rounded space-y-1">
                  <p className="text-[10px] uppercase font-bold text-purple-600 tracking-wider">🎯 Activity Recommendation</p>
                  {schedulingPopup.activity.enrolled ? (
                    <>
                      <p className="font-semibold text-purple-800">Enrolled in: {schedulingPopup.activity.activityTitle}</p>
                      <p className="text-xs text-purple-600 italic">Child automatically enrolled in an existing scheduled activity.</p>
                    </>
                  ) : (
                    <>
                      <p className="font-semibold text-purple-800">Marked as recommended</p>
                      <p className="text-xs text-purple-600 italic">{schedulingPopup.activity.note || 'No matching activity currently scheduled. Child flagged for enrollment when one is added.'}</p>
                    </>
                  )}
                </div>
              )}

              {schedulingPopup.plan && (
                <div className="p-3 bg-yellow-50 border border-yellow-200 rounded">
                  <p className="text-[10px] uppercase font-bold text-yellow-600 tracking-wider mb-1">Required Immediate Action</p>
                  <p className="text-yellow-900 text-xs">{schedulingPopup.plan.immediateAction}</p>
                  <p className="text-[10px] text-yellow-600 mt-1">Deadline: {schedulingPopup.plan.deadline}</p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button className="bg-[#2F3E46] text-white" onClick={() => setIsSchedulingPopupOpen(false)}>Acknowledged</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Auto-Intervention Plan Dialog */}
      <Dialog open={isInterventionOpen} onOpenChange={setIsInterventionOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#2F3E46]">
              <ShieldAlert className="w-5 h-5 text-orange-500" />
              Auto-Generated Intervention Plan
            </DialogTitle>
          </DialogHeader>
          {interventionPlan && (
            <div className="space-y-3 text-sm">
              <div className={`p-3 rounded-lg border font-semibold ${interventionPlan.escalate ? 'bg-red-50 border-red-200 text-red-800' : 'bg-orange-50 border-orange-200 text-orange-800'}`}>
                {interventionPlan.summary}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 bg-gray-50 rounded border">
                  <p className="text-[10px] text-gray-400 uppercase font-bold mb-0.5">Deadline</p>
                  <p className="font-semibold text-gray-800">{interventionPlan.deadline}</p>
                </div>
                <div className="p-2 bg-gray-50 rounded border">
                  <p className="text-[10px] text-gray-400 uppercase font-bold mb-0.5">Assessment</p>
                  <p className="font-semibold text-gray-800">{interventionPlan.assessmentType || 'None required'}</p>
                </div>
                {interventionPlan.assessor && (
                  <div className="p-2 bg-blue-50 rounded border col-span-2">
                    <p className="text-[10px] text-blue-400 uppercase font-bold mb-0.5">Assigned Assessor</p>
                    <p className="font-semibold text-blue-800">{interventionPlan.assessor}</p>
                  </div>
                )}
              </div>
              <div className="p-3 bg-yellow-50 border border-yellow-200 rounded">
                <p className="text-[10px] text-yellow-600 uppercase font-bold mb-1">Required Action</p>
                <p className="text-yellow-900">{interventionPlan.immediateAction}</p>
              </div>
              {interventionPlan.assessmentRequired && (
                <div className="p-2 bg-green-50 border border-green-200 rounded text-green-800 text-xs">
                  ✅ Assessment automatically scheduled and added to the Assessments module.
                </div>
              )}
              <p className={`p-2 rounded border text-xs ${interventionPlan.escalate ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 text-gray-600'}`}>
                {interventionPlan.pointsNote}
              </p>
            </div>
          )}
          <div className="flex justify-end pt-2">
            <Button className="bg-[#2F3E46] text-white" onClick={() => setIsInterventionOpen(false)}>Acknowledged</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
