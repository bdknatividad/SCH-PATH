import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Badge } from '@/app/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Textarea } from '@/app/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/app/components/ui/alert-dialog';
import { Search, Plus, Eye, Edit, Trash2, ShieldAlert, AlertTriangle, AlertCircle, User } from 'lucide-react';
import { useData, Violation } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { formatShortDate } from '@/utils/dateFormatter';
import { request } from '@/services/api';

// SCH Violation Matrix — from official shelter guidelines
const SCH_VIOLATION_MATRIX = [
  // ── MAJOR OFFENSES ──────────────────────────────────────────────
  {
    id: 'MJ01', category: 'Major', severity: 'Major' as const, points: 3,
    label: 'Pagtangkang Tumakas / Pagtakas (Escape Attempt)',
    tagalog: 'Pagtangkang tumakas at Pagtakas / Pagpaplano at pagyayakag sa Pagtakas',
    intervention: 'No resistance: 1 meal HHC + Privilege suspension + Psychosocial activity + 3 day isolation\n1st Offense: Same as above\n2nd Offense: Blotter + Case filing + Guardian notification + Court notification',
    assessor: 'Psychologist', assessmentType: 'Risk & Safety Assessment',
  },
  {
    id: 'MJ02', category: 'Major', severity: 'Major' as const, points: 3,
    label: 'Pagpasok ng Pera at Phone',
    tagalog: 'Pag gamit at pagpasok ng Pera at Phone',
    intervention: '1st Offense: 2 weeks Privilege Suspension + Psychosocial activity\n2nd Offense: Confiscate + Return to guardian + Psychosocial activity',
    assessor: 'Social Worker', assessmentType: 'Behavioral Assessment',
  },
  {
    id: 'MJ03', category: 'Major', severity: 'Major' as const, points: 3,
    label: 'Pagpasok ng Alak at Sigarilyo',
    tagalog: 'Pag gamit at pagpasok ng Alak at Sigarilyo',
    intervention: '1st Offense: 2 weeks Privilege Suspension + 1 day household chores + Psychosocial activity\n2nd Offense: Drug test + Extended suspension + Psychosocial activity',
    assessor: 'Nurse', assessmentType: 'Substance Use Assessment',
  },
  {
    id: 'MJ04', category: 'Major', severity: 'Critical' as const, points: 5,
    label: 'Paggamit ng Droga sa Shelter',
    tagalog: 'Pag gamit at pagpasok ng Droga sa shelter',
    intervention: 'Drug test + Blotter + Case filing (all offenses)',
    assessor: 'Nurse', assessmentType: 'Substance Use Medical Assessment',
  },
  {
    id: 'MJ05', category: 'Major', severity: 'Major' as const, points: 3,
    label: 'Paggamit ng Tablet (Hindi Ayon sa Rules)',
    tagalog: 'Pag gamit ng tablet na hindi naaayon sa pagsagot ng modules/pagvisit sa mga site',
    intervention: '1st Offense: 2 weeks Privilege Suspension + 2 weeks no tablet use + Psychosocial activity\n2nd Offense: 1 month no tablet use + Extended suspension + Psychosocial activity',
    assessor: 'Social Worker', assessmentType: 'Behavioral Assessment',
  },
  {
    id: 'MJ06', category: 'Major', severity: 'Major' as const, points: 3,
    label: 'Pakikipag-away / Pananakit / Pakikipagsuntukan (Fighting)',
    tagalog: 'Pakikipag-away, pananakit, at pakikipagsuntukan sa kapwa residente o staff; Hali',
    intervention: '1st Offense: 1 day household chores + Laundry of bedsheets and towels + 1 week privilege suspension + Psychosocial activity\n2nd Offense: 3 days household chores + Laundry + Extended suspension\n3rd Offense: Blotter + Case filing + Court notification',
    assessor: 'Psychologist', assessmentType: 'Crisis Intervention Assessment',
  },
  {
    id: 'MJ07', category: 'Major', severity: 'Major' as const, points: 3,
    label: 'Pagsira ng Gamit sa Shelter (Property Damage)',
    tagalog: 'Pagsira ng anumang uri ng gamit sa shelter',
    intervention: '1st Offense: Pagpalit/Pagbayad ng nasirang gamit + Character building + Counseling\nIf repeat: Pagpalit/Pagbayad + Isolation + Privilege suspension + Psychosocial activity',
    assessor: 'Social Worker', assessmentType: 'Behavioral Assessment',
  },
  {
    id: 'MJ08', category: 'Major', severity: 'Critical' as const, points: 5,
    label: 'Pagbasag ng Salamin / Paggawa ng Sandata (Dangerous Object)',
    tagalog: 'Pagbasag ng salamin at pagputol ng toothbrush na maaring gamiting panaksak at panganib',
    intervention: '1st Offense: Pagpalit/Pagbayad + 1 day isolation + Privilege suspension + Psychosocial activity\n2nd Offense: Pagpalit/Pagbayad + 3 days isolation + Extended suspension + Psychosocial activity',
    assessor: 'Psychologist', assessmentType: 'Risk & Safety Assessment',
  },
  {
    id: 'MJ09', category: 'Major', severity: 'Major' as const, points: 3,
    label: 'Paglalagay ng Tattoo / Piercing / Bulitas',
    tagalog: 'Paglalagay ng tattoo at piercing o bulitas sa anumang bahagi ng katawan',
    intervention: '1st Offense: Laundry of bedsheets and towels + Psychosocial activity\n2nd Offense: 3 days household chores + Extended privilege suspension + Psychosocial activity',
    assessor: 'Nurse', assessmentType: 'Medical Assessment',
  },
  {
    id: 'MJ10a', category: 'Major', severity: 'Major' as const, points: 3,
    label: 'Pagkuha ng Supplies ng Shelter (Food/Kubyertos/Appliance)',
    tagalog: 'Pagkuha ng supplies ng shelter gaya ng pagkain, kubyertos, parte ng appliance',
    intervention: '1st Offense: 1 day household chores + Laundry of bedsheets and towels + Psychosocial activity\n2nd Offense: 3 days household chores + Laundry + Extended suspension',
    assessor: 'Social Worker', assessmentType: 'Behavioral Assessment',
  },
  {
    id: 'MJ10b', category: 'Major', severity: 'Major' as const, points: 3,
    label: 'Pagkuha ng Gamit ng Kapwa Residente (Meryenda/Damit)',
    tagalog: 'Pagkuha ng kagamitan ng kapwa residente tulad ng meryenda, damit o ibang gamit',
    intervention: '1st Offense: 2 days household chores + Laundry of bedsheets and towels + Psychosocial activity\n2nd Offense: 3 days household chores + Laundry + Extended suspension',
    assessor: 'Social Worker', assessmentType: 'Behavioral Assessment',
  },
  {
    id: 'MJ11', category: 'Major', severity: 'Major' as const, points: 3,
    label: 'Kawalang Respeto sa Residente/Staff/Bisita (Pagmumura/Panlalait)',
    tagalog: 'Kawalang respeto sa kapwa residente/staff/bisita tulad ng pagmumura, panlalait',
    intervention: '1st Offense: 1 day household chores + 1 week privilege suspension + Character building + Counseling\n2nd Offense: 3 days household chores + Extended suspension + Psychosocial activity',
    assessor: 'Social Worker', assessmentType: 'Behavioral Assessment',
  },
  {
    id: 'MJ12', category: 'Major', severity: 'Critical' as const, points: 5,
    label: 'Sexually Deviant Behavior (Paninilip)',
    tagalog: 'Sexually Deviant Behavior / Paninilip sa kapwa residente habang nasa palikuran',
    intervention: '1st Offense: Subject for medical and/or psychological check-up/treatment + Case conference\n2nd Offense: Case conference + Blotter + Possible case filing',
    assessor: 'Psychologist', assessmentType: 'Psychological Evaluation',
  },
  {
    id: 'MJ13', category: 'Major', severity: 'Major' as const, points: 3,
    label: 'Pagtanggi sa Intervention (Refusal)',
    tagalog: 'Pagtanggi na pumirma at gawin ang Intervention',
    intervention: '1st Offense: Verbal warning (still required to do intervention) + Psychosocial activity\n2nd Offense: Written warning + Extended intervention requirement + Psychosocial activity',
    assessor: 'Social Worker', assessmentType: 'Behavioral Assessment',
  },
  // ── MINOR OFFENSES ──────────────────────────────────────────────
  {
    id: 'MN01', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Pagsuway sa Schedule / Hindi Sumasali sa Activities',
    tagalog: 'Pagsuway sa schedule at di pagsali sa mga activities tulad ng tutorials, exercise',
    intervention: '1st Offense: 2 days no watching TV + Psychosocial activity\n2nd Offense: 1 week no TV/music activity + Psychosocial activity',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN02', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Pagbubukas ng Appliances / Pagpasok sa Restricted Areas',
    tagalog: 'Pagbubukas ng appliances at pagpasok sa mga kwarto tulad ng storage room at opisina',
    intervention: '1st Offense: 1 day CR cleaning (ground floor) + Psychosocial activity\n2nd Offense: 3 days CR cleaning + Psychosocial activity',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN03', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Pagsusuot ng Alahas / Palamuti',
    tagalog: 'Pagsusuot ng anumang uri ng alahas/palamuti sa katawan tulad ng relo, kwintas',
    intervention: '1st Offense: Confiscate + Ipapauwi sa magulang + Psychosocial activity\n2nd Offense: Extended confiscation + Psychosocial activity',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN04', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Pakikipagpalit ng Gamit sa Kapwa Residente',
    tagalog: 'Paghingi ng pansariling interest sa kapwa residente / pakikipagpalit ng gamit',
    intervention: 'Pagpapauwi ng mga gamit na pinalitan + Hindi na itutuloy ang exchange',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN05a', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Pag-iingay sa Oras ng Pag-aaral',
    tagalog: 'Pag-iingay sa oras ng Pag-aaral',
    intervention: '1st Offense: 1 day no using tablet during study time + Psychosocial activity\n2nd Offense: 3 days no tablet during study time + Psychosocial activity',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN05b', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Pag-iingay sa Oras ng Panonood ng TV',
    tagalog: 'Pag-iingay sa oras ng Panonood ng TV',
    intervention: '1st Offense: 1 day no watching TV + Psychosocial activity\n2nd Offense: 3 days no TV + Psychosocial activity',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN05c', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Pag-iingay sa Oras ng Pagtulog',
    tagalog: 'Pag-iingay sa oras ng Pagtulog',
    intervention: '1st Offense: 1 day no nap time + Psychosocial activity\n2nd Offense: 2 days no nap time + Psychosocial activity',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN06', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Pagtago ng Pagkain sa Kwarto',
    tagalog: 'Pagtago ng pagkain sa kwarto',
    intervention: '1st Offense: No merienda sa susunod na araw at huling kakain\n2nd Offense: 1 week no merienda + Huling kakain',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN07', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Late Gumising / Pagligo ng Wala sa Oras',
    tagalog: 'Late gumising, pagligo ng sabay at pagligo ng wala sa oras',
    intervention: 'Huling kakain at 1 day household chores',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN08', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Hindi Pagkain sa Takdang Oras',
    tagalog: 'Hindi pagkain sa takdang oras (not unless sick)',
    intervention: 'Ipapakain ang kanyang pagkain sa mga kapwa residente',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN09', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Kawalang Respeto sa Hapag-Kainan',
    tagalog: 'Kawalang respeto sa hapag kainan / Agarang pag-alis sa hapag-kainan',
    intervention: '1st Offense: Half rice and half ulam on current meal and following meal + Psychosocial activity\n2nd Offense: 1 day no merienda + Half rice and ulam + Psychosocial activity',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN10', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Vandalism (Pagsulat sa Pader)',
    tagalog: 'Vandalism',
    intervention: 'Pagkuskos/pagbura ng mga sulat sa pader + Pagbili ng 1 Litro ng puting pintura + Character building',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN11', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Paglalagi sa Baba ng Walang Toka / Bintana',
    tagalog: 'Paglalagi sa baba na hindi naman toka sa paglalaba o pagluluto at paglalagi sa bintana',
    intervention: '1st Offense: Verbal warning + Dialogue\n2nd Offense: 1 day cleaning of receiving area',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN12', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Walang Damit Itaas / Nakaboxer Shorts',
    tagalog: 'Walang pantaas na damit, pag hubo at nakaboxer shorts (except nap time or bed time)',
    intervention: '1st Offense: Verbal warning + Dialogue\n2nd Offense: 1 day cleaning of laundry area + Psychosocial activity',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN13', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Hindi Pag-ayos ng Higaan / Kutson',
    tagalog: 'Hindi pag-ayos ng higaan o pagsalansan ng mga kutson, paglatag ng kutson at pagtatago ng unan',
    intervention: '1st Offense: Pagsamsam ng unan\n2nd Offense: Pagsamsam ng kutson\n3rd Offense: Pagsamsam ng unan at kutson (matutulog sa sahig na may banig lang)',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN14', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Pagsabit ng Gamit sa Bintana',
    tagalog: 'Pagsabit ng kung anu-ano sa bintana ng bawat room',
    intervention: 'Pagsamsam at pagpapauwi ng kung anuman ang nadatnang gamit na nakasabit',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
  {
    id: 'MN15', category: 'Minor', severity: 'Minor' as const, points: 1,
    label: 'Pakikipag-usap sa Residente sa Isolation',
    tagalog: 'Pagsilip at Pakikipag usap sa kapwa residente na nasa loob ng isolation room',
    intervention: '1st Offense: No phone call / video call\n2nd Offense: +1 day in isolation room sa bawat batang kinakausap + No phone/video call',
    assessor: 'Social Worker', assessmentType: 'Behavioral Coaching',
  },
];

const SEVERITY_OPTIONS = [
  { value: 'Minor', label: 'Minor (1 point)', points: 1 },
  { value: 'Major', label: 'Major (3 points)', points: 3 },
  { value: 'Critical', label: 'Critical (5 points)', points: 5 },
];

export function Violations() {
  const navigate = useNavigate();
  const { children, staff, violations, addViolation, updateViolation, deleteViolation, refreshData, addAssessment } = useData();
  const { user } = useAuth();
  const isPsychologist = user?.role === 'psychologist';
  const isCenterHead = user?.role === 'centerhead';

  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterSeverity, setFilterSeverity] = useState('all');

  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [interventionPlan, setInterventionPlan] = useState<any>(null);
  const [isInterventionDialogOpen, setIsInterventionDialogOpen] = useState(false);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isReviewDialogOpen, setIsReviewDialogOpen] = useState(false);

  const [selectedViolation, setSelectedViolation] = useState<Violation | null>(null);
  const [violationToDelete, setViolationToDelete] = useState<Violation | null>(null);


  const [reviewForm, setReviewForm] = useState({ severity: 'Minor' as 'Minor' | 'Major' | 'Critical', actionTaken: '', status: 'Reviewed' as string });

  const staffNames = staff.filter(s => s.status === 'Active').map(s => s.name);

  const defaultReportedBy = user?.username || '';

  const [formData, setFormData] = useState({
    residentId: '',
    date: new Date().toISOString().split('T')[0],
    type: '',
    description: '',
    severity: 'Minor' as 'Minor' | 'Major' | 'Critical',
    points: 1,
    location: '',
    witnesses: '',
    reportedBy: defaultReportedBy,
    actionTaken: '',
    status: 'Pending Review' as 'Pending Review' | 'Under Investigation' | 'Reviewed' | 'Resolved' | 'Escalated',
    requiresAssessment: true,
    assessmentTriggered: false,
  });

  const filteredViolations = violations.filter((v) => {
    const resident = children.find((c) => c.id === v.residentId);
    const residentName = resident?.name || '';
    const matchesSearch = 
      residentName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (v.type || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      v.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === 'all' || v.status === filterStatus;
    const matchesSeverity = filterSeverity === 'all' || v.severity === filterSeverity;
    return matchesSearch && matchesStatus && matchesSeverity;
  });

  const handleSeverityChange = (severity: 'Minor' | 'Major' | 'Critical') => {
    const points = SEVERITY_OPTIONS.find((s) => s.value === severity)?.points || 1;
    setFormData((prev) => ({ ...prev, severity, points }));
  };

  const resetForm = () => {
    setFormData({
      residentId: '',
      date: new Date().toISOString().split('T')[0],
      type: '',
      description: '',
      severity: 'Minor',
      points: 1,
      location: '',
      witnesses: '',
      reportedBy: user?.username || '',
      actionTaken: '',
      status: 'Pending Review',
      requiresAssessment: true,
      assessmentTriggered: false,
    });
  };

  const handleSubmit = async () => {
    if (!formData.residentId || !formData.type) return;
    const payload = {
      ...formData,
      reportedBy: formData.reportedBy,
      witnesses: formData.witnesses,
      status: 'Pending Review' as const,
    };
    const result = await addViolation(payload);
    setIsAddDialogOpen(false);
    if (result) {
      // Backend rule engine already created assessment + alert
      // If it returned an interventionPlan, show it to the user
      const plan = (result as any).interventionPlan;
      if (plan) {
        setInterventionPlan(plan);
        setIsInterventionDialogOpen(true);
      }
      // If backend didn't create assessment (Minor violation), create one via DataContext
      const backendCreatedAssessment = !!(result as any).autoCreatedAssessment;
      if (!backendCreatedAssessment && (payload.severity === 'Major' || payload.severity === 'Critical')) {
        try {
          await addAssessment({
            title: `Behavioral Follow-up — ${payload.type}`,
            type: 'Behavioral Follow-up',
            date: payload.date,
            time: '09:00',
            assessor: payload.reportedBy || 'Social Worker',
            description: `Auto-scheduled intervention for ${payload.severity} violation: ${payload.type}`,
            status: 'Scheduled',
            forResidents: [payload.residentId],
          });
        } catch { /* silent */ }
      }
      setTimeout(() => refreshData(), 500);
    }
    resetForm();
  };

  const handleReview = async () => {
    if (!selectedViolation) return;
    try {
      await request(`/violations/${selectedViolation.id}/review`, {
        method: 'POST',
        body: JSON.stringify(reviewForm),
      });
      setIsReviewDialogOpen(false);
      setSelectedViolation(null);
      setTimeout(() => refreshData(), 300);
    } catch { /* ignore */ }
  };

  const handleUpdate = async () => {
    if (!selectedViolation) return;
    await updateViolation(selectedViolation.id, formData);
    setIsEditDialogOpen(false);
    setSelectedViolation(null);
  };

  const handleDelete = async () => {
    if (!violationToDelete) return;
    await deleteViolation(violationToDelete.id);
    setIsDeleteDialogOpen(false);
    setViolationToDelete(null);
  };

  const openViewDialog = (violation: Violation) => {
    setSelectedViolation(violation);
    setIsViewDialogOpen(true);
  };

  const openEditDialog = (violation: Violation) => {
    setSelectedViolation(violation);
    setFormData({
      residentId: violation.residentId,
      date: violation.date,
      type: violation.type,
      description: violation.description || '',
      severity: violation.severity,
      points: violation.points,
      location: violation.location || '',
      witnesses: violation.witnesses || '',
      reportedBy: violation.reportedBy || '',
      actionTaken: violation.actionTaken || '',
      status: violation.status,
      requiresAssessment: violation.requiresAssessment,
      assessmentTriggered: violation.assessmentTriggered,
    });
    setIsEditDialogOpen(true);
  };

  const openDeleteDialog = (violation: Violation) => {
    setViolationToDelete(violation);
    setIsDeleteDialogOpen(true);
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'Critical': return 'bg-red-100 text-red-800 border-red-200';
      case 'Major': return 'bg-orange-100 text-orange-800 border-orange-200';
      default: return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Resolved': return 'bg-green-100 text-green-800';
      case 'Reviewed': return 'bg-purple-100 text-purple-800';
      case 'Under Investigation': return 'bg-blue-100 text-blue-800';
      case 'Escalated': return 'bg-red-100 text-red-800';
      case 'Pending Review': return 'bg-yellow-100 text-yellow-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getViolationPointsForResident = (residentId: string) => {
    return violations
      .filter((v) => v.residentId === residentId && v.status !== 'Resolved')
      .reduce((sum, v) => sum + v.points, 0);
  };

  // ─── Intervention Plan Dialog ──────────────────────────────────────────────
  const InterventionDialog = () => (
    <Dialog open={isInterventionDialogOpen} onOpenChange={setIsInterventionDialogOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#2F3E46]">
            <ShieldAlert className="w-5 h-5 text-orange-500" />
            Auto-Generated Intervention Plan
          </DialogTitle>
        </DialogHeader>
        {interventionPlan && (
          <div className="space-y-3 text-sm">
            <div className={`p-3 rounded-lg border font-semibold ${
              interventionPlan.escalate ? 'bg-red-50 border-red-200 text-red-800' : 'bg-orange-50 border-orange-200 text-orange-800'
            }`}>
              {interventionPlan.summary}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2 bg-gray-50 rounded border">
                <p className="text-[10px] text-gray-400 uppercase font-bold mb-0.5">Deadline</p>
                <p className="font-semibold text-gray-800">{interventionPlan.deadline}</p>
              </div>
              <div className="p-2 bg-gray-50 rounded border">
                <p className="text-[10px] text-gray-400 uppercase font-bold mb-0.5">Assessment Type</p>
                <p className="font-semibold text-gray-800">{interventionPlan.assessmentType || 'None required'}</p>
              </div>
              {interventionPlan.assessor && (
                <div className="p-2 bg-blue-50 rounded border border-blue-100 col-span-2">
                  <p className="text-[10px] text-blue-400 uppercase font-bold mb-0.5">Assigned Assessor</p>
                  <p className="font-semibold text-blue-800">{interventionPlan.assessor}</p>
                </div>
              )}
            </div>
            <div className="p-3 bg-yellow-50 border border-yellow-200 rounded">
              <p className="text-[10px] text-yellow-600 uppercase font-bold mb-1">Required Immediate Action</p>
              <p className="text-yellow-900">{interventionPlan.immediateAction}</p>
            </div>
            {interventionPlan.phaseNote && (
              <div className="p-2 bg-purple-50 border border-purple-100 rounded text-purple-800">
                <span className="text-[10px] uppercase font-bold text-purple-500">Phase Context: </span>
                {interventionPlan.phaseNote}
              </div>
            )}
            <div className={`p-2 rounded border text-xs ${
              interventionPlan.escalate ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-gray-200 text-gray-600'
            }`}>
              {interventionPlan.pointsNote}
            </div>
            {interventionPlan.assessmentRequired && (
              <div className="p-2 bg-green-50 border border-green-200 rounded text-green-800 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Assessment has been automatically scheduled and added to the Assessments module.
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end pt-2">
          <Button className="bg-[#2F3E46] text-white" onClick={() => setIsInterventionDialogOpen(false)}>
            Acknowledged
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-[#2F3E46]">Incident Records</h2>
          <p className="text-gray-600">Track resident infractions and behavioral incidents</p>
        </div>
        <Button className="flex items-center gap-2 bg-[#2F3E46]" onClick={() => setIsAddDialogOpen(true)}>
          <Plus className="w-4 h-4" />
          <span>Log Incident</span>
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <ShieldAlert className="w-8 h-8 text-red-500" />
              <div>
                <p className="text-sm text-gray-500">Total Violations</p>
                <p className="text-2xl font-bold">{violations.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-8 h-8 text-orange-500" />
              <div>
                <p className="text-sm text-gray-500">Pending Review</p>
                <p className="text-2xl font-bold">{violations.filter((v) => v.status === 'Pending Review').length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-8 h-8 text-yellow-500" />
              <div>
                <p className="text-sm text-gray-500">Under Investigation</p>
                <p className="text-2xl font-bold">{violations.filter((v) => v.status === 'Under Investigation').length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <User className="w-8 h-8 text-blue-500" />
              <div>
                <p className="text-sm text-gray-500">Residents with Violations</p>
                <p className="text-2xl font-bold">{new Set(violations.map((v) => v.residentId)).size}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder="Search by resident name or violation type..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="Pending Review">Pending Review</SelectItem>
                <SelectItem value="Under Investigation">Under Investigation</SelectItem>
                <SelectItem value="Reviewed">Reviewed</SelectItem>
                <SelectItem value="Resolved">Resolved</SelectItem>
                <SelectItem value="Escalated">Escalated</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterSeverity} onValueChange={setFilterSeverity}>
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder="Filter by severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Severity</SelectItem>
                <SelectItem value="Minor">Minor</SelectItem>
                <SelectItem value="Major">Major</SelectItem>
                <SelectItem value="Critical">Critical</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Violations List */}
      <div className="space-y-4">
        {filteredViolations.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <ShieldAlert className="w-12 h-12 mx-auto mb-4 text-gray-300" />
              <p className="text-gray-500">No violations found matching your criteria.</p>
            </CardContent>
          </Card>
        ) : (
          filteredViolations.map((violation) => {
            const resident = children.find((c) => c.id === violation.residentId);
            const totalPoints = getViolationPointsForResident(violation.residentId);
            return (
              <Card key={violation.id} className="hover:shadow-md transition-shadow">
                <CardContent className="p-6">
                  <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-lg font-semibold text-[#2F3E46]">{resident?.name || 'Unknown Resident'}</h3>
                        <Badge className={getSeverityColor(violation.severity)}>{violation.severity}</Badge>
                        <Badge className={getStatusColor(violation.status)}>{violation.status}</Badge>
                        {violation.assessmentTriggered && (
                          <Badge variant="outline" className="bg-blue-50 text-blue-700">Assessment Auto-Created</Badge>
                        )}
                      </div>
                      <p className="text-sm text-gray-600 mb-2">
                        <span className="font-medium">Type:</span> {violation.type} | 
                        <span className="font-medium"> Points:</span> {violation.points} | 
                        <span className="font-medium"> Date:</span> {formatShortDate(violation.date)}
                      </p>
                      <p className="text-sm text-gray-600 mb-2">
                        <span className="font-medium">Description:</span> {violation.description || 'No description provided'}
                      </p>
                      {totalPoints >= 5 && (
                        <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm ${
                          totalPoints >= 10 ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'
                        }`}>
                          <AlertTriangle className="w-4 h-4" />
                          Total Points: {totalPoints} {totalPoints >= 10 ? '(Critical Threshold)' : '(Warning)'}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => openViewDialog(violation)}>
                        <Eye className="w-4 h-4 mr-1" /> View
                      </Button>
                      {(isPsychologist || isCenterHead) && violation.status === 'Pending Review' && (
                        <Button
                          size="sm"
                          className="bg-purple-600 hover:bg-purple-700 text-white"
                          onClick={() => {
                            setSelectedViolation(violation);
                            setReviewForm({ severity: violation.severity, actionTaken: violation.actionTaken || '', status: 'Reviewed' });
                            setIsReviewDialogOpen(true);
                          }}
                        >
                          <ShieldAlert className="w-4 h-4 mr-1" /> Review
                        </Button>
                      )}
                      <Button variant="outline" size="sm" onClick={() => openEditDialog(violation)}>
                        <Edit className="w-4 h-4 mr-1" /> Edit
                      </Button>
                      <Button variant="outline" size="sm" className="text-red-600" onClick={() => openDeleteDialog(violation)}>
                        <Trash2 className="w-4 h-4 mr-1" /> Delete
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Add Incident Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Log New Incident</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-4">
            <div className="space-y-2">
              <Label>Resident *</Label>
              <Select value={formData.residentId} onValueChange={(value) => setFormData({ ...formData, residentId: value })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select resident" />
                </SelectTrigger>
                <SelectContent>
                  {children.map((child) => (
                    <SelectItem key={child.id} value={child.id}>
                      {child.name} ({getViolationPointsForResident(child.id)} points)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Date *</Label>
              <Input type="date" value={formData.date} onChange={(e) => setFormData({ ...formData, date: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Incident Type *</Label>
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
                <SelectTrigger><SelectValue placeholder="Select incident type..." /></SelectTrigger>
                <SelectContent className="max-h-80">
                  <div className="px-2 py-1 text-[10px] font-black uppercase text-red-500 tracking-wider">⚠ Major Offenses (3–5 pts)</div>
                  {SCH_VIOLATION_MATRIX.filter(m => m.category === "Major").map(m => (
                    <SelectItem key={m.id} value={m.label}>
                      <div className="flex items-center gap-2">
                        <span className={m.severity === "Critical" ? "w-2 h-2 rounded-full bg-red-600" : "w-2 h-2 rounded-full bg-orange-500"} />
                        <span className="text-sm">{m.label}</span>
                        <span className="text-[10px] text-gray-400">{m.points}pts</span>
                      </div>
                    </SelectItem>
                  ))}
                  <div className="px-2 py-1 text-[10px] font-black uppercase text-yellow-600 tracking-wider border-t">Minor Offenses (1 pt)</div>
                  {SCH_VIOLATION_MATRIX.filter(m => m.category === "Minor").map(m => (
                    <SelectItem key={m.id} value={m.label}>
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-yellow-400" />
                        <span className="text-sm">{m.label}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {formData.type && (
                <div className={"flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold " + (
                  formData.severity === "Critical" ? "bg-red-50 text-red-700 border border-red-200" :
                  formData.severity === "Major" ? "bg-orange-50 text-orange-700 border border-orange-200" :
                  "bg-yellow-50 text-yellow-700 border border-yellow-200"
                )}>
                  <span>{formData.severity} — {formData.points} point{formData.points !== 1 ? "s" : ""}</span>
                  <span className="text-gray-400 font-normal">· auto-detected from matrix</span>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label>Severity *</Label>
              <Select value={formData.severity} onValueChange={(value) => handleSeverityChange(value as 'Minor' | 'Major' | 'Critical')}>
                <SelectTrigger>
                  <SelectValue placeholder="Select severity" />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Description</Label>
              <Textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Describe the incident..."
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>Location</Label>
              <Input value={formData.location} onChange={(e) => setFormData({ ...formData, location: e.target.value })} placeholder="Where did it occur?" />
            </div>
            <div className="space-y-2">
              <Label>Reported By *</Label>
              <Input value={formData.reportedBy} onChange={(e) => setFormData({ ...formData, reportedBy: e.target.value })} placeholder="Enter reporter's full name" />
            </div>
            <div className="space-y-2">
              <Label>Witnesses</Label>
              <Input value={formData.witnesses} onChange={(e) => setFormData({ ...formData, witnesses: e.target.value })} placeholder="Enter witness name(s), or leave blank" />
            </div>
            <div className="space-y-2">
              <Label>Action Taken</Label>
              <Input value={formData.actionTaken} onChange={(e) => setFormData({ ...formData, actionTaken: e.target.value })} placeholder="Immediate action taken" />
            </div>
            <div className="sm:col-span-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
              <strong>Note:</strong> All violations are saved as <strong>Pending Review</strong>. A Psychologist must review and confirm severity before it is finalized.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsAddDialogOpen(false); resetForm(); }}>Cancel</Button>
            <Button onClick={handleSubmit} className="bg-[#2F3E46]">Save Incident</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Incident Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Incident Details</DialogTitle>
          </DialogHeader>
          {selectedViolation && (
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-2">
                <Badge className={getSeverityColor(selectedViolation.severity)}>{selectedViolation.severity}</Badge>
                <Badge className={getStatusColor(selectedViolation.status)}>{selectedViolation.status}</Badge>
                {selectedViolation.assessmentTriggered && (
                  <Badge variant="outline" className="bg-blue-50 text-blue-700">Assessment Auto-Created</Badge>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="font-medium text-gray-500">Resident</p>
                  <p>{children.find(c => c.id === selectedViolation.residentId)?.name || 'Unknown'}</p>
                </div>
                <div>
                  <p className="font-medium text-gray-500">Date</p>
                  <p>{formatShortDate(selectedViolation.date)}</p>
                </div>
                <div>
                  <p className="font-medium text-gray-500">Type</p>
                  <p>{selectedViolation.type}</p>
                </div>
                <div>
                  <p className="font-medium text-gray-500">Points</p>
                  <p>{selectedViolation.points}</p>
                </div>
                <div>
                  <p className="font-medium text-gray-500">Location</p>
                  <p>{selectedViolation.location || 'N/A'}</p>
                </div>
                <div>
                  <p className="font-medium text-gray-500">Reported By</p>
                  <p>{selectedViolation.reportedBy || 'N/A'}</p>
                </div>
              </div>
              <div>
                <p className="font-medium text-gray-500">Description</p>
                <p className="text-sm">{selectedViolation.description || 'No description'}</p>
              </div>
              {selectedViolation.witnesses && (
                <div>
                  <p className="font-medium text-gray-500">Witnesses</p>
                  <p className="text-sm">{selectedViolation.witnesses}</p>
                </div>
              )}
              {selectedViolation.actionTaken && (
                <div>
                  <p className="font-medium text-gray-500">Action Taken</p>
                  <p className="text-sm">{selectedViolation.actionTaken}</p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsViewDialogOpen(false)}>Close</Button>
            {selectedViolation && (
              <Button onClick={() => { setIsViewDialogOpen(false); openEditDialog(selectedViolation); }} className="bg-[#2F3E46]">
                <Edit className="w-4 h-4 mr-1" /> Edit
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Incident Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Incident</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-4">
            <div className="space-y-2">
              <Label>Resident *</Label>
              <Select value={formData.residentId} onValueChange={(value) => setFormData({ ...formData, residentId: value })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select resident" />
                </SelectTrigger>
                <SelectContent>
                  {children.map((child) => (
                    <SelectItem key={child.id} value={child.id}>
                      {child.name} ({getViolationPointsForResident(child.id)} points)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Date *</Label>
              <Input type="date" value={formData.date} onChange={(e) => setFormData({ ...formData, date: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Incident Type *</Label>
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
                <SelectTrigger><SelectValue placeholder="Select incident type..." /></SelectTrigger>
                <SelectContent className="max-h-80">
                  <div className="px-2 py-1 text-[10px] font-black uppercase text-red-500 tracking-wider">⚠ Major Offenses (3–5 pts)</div>
                  {SCH_VIOLATION_MATRIX.filter(m => m.category === "Major").map(m => (
                    <SelectItem key={m.id} value={m.label}>
                      <div className="flex items-center gap-2">
                        <span className={m.severity === "Critical" ? "w-2 h-2 rounded-full bg-red-600" : "w-2 h-2 rounded-full bg-orange-500"} />
                        <span className="text-sm">{m.label}</span>
                        <span className="text-[10px] text-gray-400">{m.points}pts</span>
                      </div>
                    </SelectItem>
                  ))}
                  <div className="px-2 py-1 text-[10px] font-black uppercase text-yellow-600 tracking-wider border-t">Minor Offenses (1 pt)</div>
                  {SCH_VIOLATION_MATRIX.filter(m => m.category === "Minor").map(m => (
                    <SelectItem key={m.id} value={m.label}>
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-yellow-400" />
                        <span className="text-sm">{m.label}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {formData.type && (
                <div className={"flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold " + (
                  formData.severity === "Critical" ? "bg-red-50 text-red-700 border border-red-200" :
                  formData.severity === "Major" ? "bg-orange-50 text-orange-700 border border-orange-200" :
                  "bg-yellow-50 text-yellow-700 border border-yellow-200"
                )}>
                  <span>{formData.severity} — {formData.points} point{formData.points !== 1 ? "s" : ""}</span>
                  <span className="text-gray-400 font-normal">· auto-detected from matrix</span>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label>Severity *</Label>
              <Select value={formData.severity} onValueChange={(value) => handleSeverityChange(value as 'Minor' | 'Major' | 'Critical')}>
                <SelectTrigger>
                  <SelectValue placeholder="Select severity" />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Description</Label>
              <Textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Describe the incident..."
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>Location</Label>
              <Input value={formData.location} onChange={(e) => setFormData({ ...formData, location: e.target.value })} placeholder="Where did it occur?" />
            </div>
            <div className="space-y-2">
              <Label>Witnesses</Label>
              <Input value={formData.witnesses} onChange={(e) => setFormData({ ...formData, witnesses: e.target.value })} placeholder="Names of witnesses" />
            </div>
            <div className="space-y-2">
              <Label>Reported By</Label>
              <Input value={formData.reportedBy} onChange={(e) => setFormData({ ...formData, reportedBy: e.target.value })} placeholder="Your name" />
            </div>
            <div className="space-y-2">
              <Label>Action Taken</Label>
              <Input value={formData.actionTaken} onChange={(e) => setFormData({ ...formData, actionTaken: e.target.value })} placeholder="Immediate action taken" />
            </div>
            <div className="space-y-2">
              <Label>Status *</Label>
              <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value as Violation['status'] })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Pending Review">Pending Review</SelectItem>
                  <SelectItem value="Under Investigation">Under Investigation</SelectItem>
                  <SelectItem value="Reviewed">Reviewed</SelectItem>
                  <SelectItem value="Resolved">Resolved</SelectItem>
                  <SelectItem value="Escalated">Escalated</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleUpdate} className="bg-[#2F3E46]">Update Incident</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Incident Record</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this violation record? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setIsDeleteDialogOpen(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Psychologist Review Dialog */}
      <Dialog open={isReviewDialogOpen} onOpenChange={setIsReviewDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-purple-600" />
              Review Incident
            </DialogTitle>
          </DialogHeader>
          {selectedViolation && (
            <div className="space-y-4 py-2">
              <div className="p-3 bg-gray-50 rounded-lg text-sm space-y-1">
                <p><span className="font-medium">Resident:</span> {children.find(c => c.id === selectedViolation.residentId)?.name || 'Unknown'}</p>
                <p><span className="font-medium">Type:</span> {selectedViolation.type}</p>
                <p><span className="font-medium">Reported on:</span> {formatShortDate(selectedViolation.date)}</p>
                <p><span className="font-medium">Reported by:</span> {selectedViolation.reportedBy || 'N/A'}</p>
                <p className="text-gray-600">{selectedViolation.description}</p>
              </div>
              <div className="space-y-2">
                <Label>Confirm / Adjust Severity</Label>
                <Select value={reviewForm.severity} onValueChange={(v) => setReviewForm(p => ({ ...p, severity: v as 'Minor' | 'Major' | 'Critical' }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SEVERITY_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Review Status</Label>
                <Select value={reviewForm.status} onValueChange={(v) => setReviewForm(p => ({ ...p, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Reviewed">Reviewed</SelectItem>
                    <SelectItem value="Under Investigation">Under Investigation</SelectItem>
                    <SelectItem value="Escalated">Escalated</SelectItem>
                    <SelectItem value="Resolved">Resolved</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Recommended Action / Notes</Label>
                <Textarea
                  value={reviewForm.actionTaken}
                  onChange={(e) => setReviewForm(p => ({ ...p, actionTaken: e.target.value }))}
                  placeholder="Describe recommended intervention or action..."
                  rows={3}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsReviewDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleReview} className="bg-purple-600 hover:bg-purple-700 text-white">
              <ShieldAlert className="w-4 h-4 mr-1" /> Submit Review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
