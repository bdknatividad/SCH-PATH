import { useState, useMemo, useRef, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useData, BehavioralLog, Child } from '../state/DataContext';
import { describeError, request } from '@/services/api';
import { systemDialog } from '@/app/components/SystemDialog';
import { useAuth } from '../state/AuthContext';
import { useSubModuleTabs } from '@/app/hooks/useSubModuleTabs';
import { usePermissions } from '@/app/hooks/usePermissions';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import {
  ArrowLeft, ArrowRight, ShieldAlert, CalendarCheck, Plus,
  User, MapPin, Stethoscope, CheckCircle2, Circle,
  ClipboardList, Eye, BookOpen, Heart, RefreshCw,
  ChevronLeft, ChevronRight, AlertTriangle, FileText,
  Printer, Edit,
} from 'lucide-react';
import { Textarea } from '@/app/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/app/components/ui/dialog';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { formatShortDate } from '@/utils/dateFormatter';
import { triTrend } from '@/utils/triRating';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  ADMISSION_HOUSEPARENT_SIGNATURE_BOX,
  ADMISSION_REFERRING_PARTY_SIGNATURE_BOX,
  ADMISSION_GUARDIAN_SIGNATURE_BOX,
  ADMISSION_RESIDENT_SIGNATURE_BOX,
  drawSignatureImage,
  toPdfBox,
} from '@/app/utils/signaturePdf';
import { Document as PdfDocument, Page as PdfPage, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';
import { PhaseProgress } from './PhaseProgress';
import IncidentReportModal from './IncidentReportModal';

interface ViolationGuideRecord {
  id: string;
  name: string;
  category: 'Major' | 'Minor';
  description?: string;
  status?: string;
  interventions?: any;
}

interface LatestTriRecord {
  id: string;
  residentId: string;
  reportingYear: number;
  reportingMonth: number;
  status: string;
  rating: string | null;
  finalPoints?: number | null;
  previousPoints?: number | null;
  previousRating?: string | null;
  finalizedAt?: string | null;
}

interface DischargeExtensionRecord {
  id: string;
  previousDischargeDate: string;
  newDischargeDate: string;
  extensionDays: number;
  reason: string;
  relatedViolationId?: string | null;
  decidedBy: string;
  decidedAt: string;
}

interface DischargeRecommendationRecord {
  id: string;
  triRecordId: string;
  reportingYear: number;
  reportingMonth: number;
  majorCount: number;
  minorCount: number;
  thresholdType: string;
  recommendationNote: string;
  status: string;
  createdAt: string;
}

interface DischargePlanData {
  admission: AdmissionRecord | null;
  history: DischargeExtensionRecord[];
  recommendations: DischargeRecommendationRecord[];
}

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



interface ChildDetailProps {
  id?: string;
  onBack?: () => void;
  /**
   * The tab to open on when the page is embedded (e.g. inside the Houseparent
   * Case Load). An embedded page does not read `?tab=` — that belongs to the
   * page hosting it.
   */
  initialTab?: string;
}

interface AdmissionRecord {
  id: string;
  residentId: string;
  admissionNumber: number;
  admissionDate: string;
  expectedDischargeDate?: string | null;
  name: string;
  age: number;
  sex: 'Male' | 'Female';
  birthDate: string;
  religion: string;
  address: string;
  residentSignature?: string | null;
  guardianName: string;
  guardianContact: string;
  guardianAddress: string;
  guardianSignature?: string | null;
  referringParty: string;
  referringPartyContact: string;
  referringPartySignature?: string | null;
  houseparentOnDuty: string;
  houseparentSignature?: string | null;
  legalCategory: string;
  specificOffense: string;
  residentImage?: string | null;
  status?: string;
}

const PDF_WIDTH = 936;
const PDF_HEIGHT = 612;

export function ChildDetail({ id: idProp, onBack, initialTab }: ChildDetailProps = {}) {
  const { id: idParam } = useParams();
  const id = idProp ?? idParam;
  const navigate = useNavigate();
  const handleBack = onBack ?? (() => navigate('/children'));
  const location = useLocation();
  const { children, updateChild, addViolation, violations, refreshData, addDocument, documents, healthRecords } = useData();
  const { user } = useAuth();
  const { can } = usePermissions();
  const isHouseparent = user?.role?.toLowerCase() === 'houseparent';

  /**
   * The Child Records tabs are the module's submenus as the RBAC definition
   * declares them, so a role sees exactly the tabs it holds.
   *
   * This replaced a hand-written list with an all-tabs fallback: a role whose
   * `childRecordTabs` was never set saw every tab, including ones its matrix
   * withholds — a Psychological Staff was shown the Education tab, which its
   * specification does not grant.
   */
  const rbacChildRecordTabs = useSubModuleTabs('Child Records');
  // Houseparents reach this viewer from their own Houseparent caseload, so the
  // resident page always exposes the five requested tabs even when an older
  // per-account Child Records grant omitted them. The backend still enforces
  // the resident assignment and every write capability.
  const childRecordTabs = isHouseparent
    ? [
        { key: 'personal', label: 'Personal Info', subModule: 'Personal Info' },
        { key: 'timeline', label: 'Phase Timeline', subModule: 'Phase Timeline' },
        { key: 'education', label: 'Education Progress', subModule: 'Education' },
        { key: 'medical', label: 'Medical', subModule: 'Medical' },
        { key: 'behavioral', label: 'Behavioral', subModule: 'Behavioral' },
      ]
    : rbacChildRecordTabs;

  const [activeTab, setActiveTab] = useState(() => {
    if (idProp) return initialTab || 'personal';
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    return tab || 'personal';
  });

  /**
   * Tabs are reached inside the page, but `?tab=<key>` is still a live deep
   * link (a notification for this resident lands on `/children/:id?tab=<key>`).
   * The initialiser above only runs on first mount, so following such a link
   * while already viewing a resident changed the URL but left the tab where it
   * was. Re-sync whenever the query string changes.
   */
  useEffect(() => {
    if (idProp) return;
    const tab = new URLSearchParams(location.search).get('tab');
    if (tab && tab !== activeTab) {
      setActiveTab(tab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [isIncidentReportOpen, setIsIncidentReportOpen] = useState(false);
  const [activeIncidentViolationId, setActiveIncidentViolationId] = useState<string | null>(null);
  const [activeIncidentViolationIds, setActiveIncidentViolationIds] = useState<string[]>([]);
  const [activeIncidentResidentIds, setActiveIncidentResidentIds] = useState<string[]>([]);
  const [selectedIncidentResidentIds, setSelectedIncidentResidentIds] = useState<string[]>([]);
  const localDateTimeInput = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const [incidentDateTime, setIncidentDateTime] = useState(localDateTimeInput());
  const [incidentCreating, setIncidentCreating] = useState(false);
  const [incidentResidentSearch, setIncidentResidentSearch] = useState('');
  const [violationFilterValue, setViolationFilterValue] = useState<string>('all');
  const [violationTypeSearch, setViolationTypeSearch] = useState('');
  const medicalFileRef = useRef<HTMLInputElement | null>(null);
  const [isUploadingMedical, setIsUploadingMedical] = useState(false);
  // Medical Notes and the medical documents are managed by the Nurse and the
  // Center Head only — the same `Health` edit capability the Health module gates
  // its own create/edit on, so the two surfaces cannot disagree.
  const isAbsconded = children.find(c => c.id === id)?.status === 'Absconded';
  // An absconded resident's record is view-only.
  const canEditMedical = can('Health', 'edit') && !isAbsconded;
  const [isEditingMedicalNotes, setIsEditingMedicalNotes] = useState(false);
  const [medicalNotesDraft, setMedicalNotesDraft] = useState('');
  const [savingMedicalNotes, setSavingMedicalNotes] = useState(false);
  const [showEndorseDialog, setShowEndorseDialog] = useState(false);
  const [endorseTo, setEndorseTo] = useState('');
  const [endorseNote, setEndorseNote] = useState('');
  const [isEndorsing, setIsEndorsing] = useState(false);
  const [phaseRequirements, setPhaseRequirements] = useState<any>(null);
  const [admissions, setAdmissions] = useState<AdmissionRecord[]>([]);
  const [loadingAdmissions, setLoadingAdmissions] = useState(false);
  const [dischargePlan, setDischargePlan] = useState<DischargePlanData | null>(null);
  const [loadingDischargePlan, setLoadingDischargePlan] = useState(false);
  const [extensionDays, setExtensionDays] = useState('');
  const [extensionUnit, setExtensionUnit] = useState<'days' | 'months'>('days');
  const [extensionReason, setExtensionReason] = useState('');
  const [relatedViolationId, setRelatedViolationId] = useState('');
  const [extensionSaving, setExtensionSaving] = useState(false);
  const [showExtensionDialog, setShowExtensionDialog] = useState(false);
  const [expectedDateDraft, setExpectedDateDraft] = useState('');
  const [expectedDateSaving, setExpectedDateSaving] = useState(false);
  const [latestTri, setLatestTri] = useState<LatestTriRecord | null>(null);
  const [previousTri, setPreviousTri] = useState<LatestTriRecord | null>(null);
  const [loadingTri, setLoadingTri] = useState(false);
  const [violationGuides, setViolationGuides] = useState<ViolationGuideRecord[]>([]);
  const [loadingViolationGuides, setLoadingViolationGuides] = useState(false);
  const [admissionPdfUrl, setAdmissionPdfUrl] = useState<string | null>(null);
  const [remoteChild, setRemoteChild] = useState<any | null>(null);
  const [admissionPdfTitle, setAdmissionPdfTitle] = useState('Admission Slip');
  const [isAdmissionPdfOpen, setIsAdmissionPdfOpen] = useState(false);

  useEffect(() => {
    const fetchRequirements = async () => {
      try {
        const res = await request<{ success: boolean; data: any }>('/phases/requirements');
        if (res.success) setPhaseRequirements(res.data);
      } catch (err) {
        console.error('Failed to fetch phase requirements:', err);
      }
    };
    fetchRequirements();
  }, []);

  useEffect(() => {
    if (!id) {
      setAdmissions([]);
      return;
    }

    const loadAdmissions = async () => {
      setLoadingAdmissions(true);
      try {
        const response = await request<{
          success: boolean;
          data?: AdmissionRecord[];
        }>(`/admissions/resident/${id}`);
        setAdmissions(response?.success ? response.data || [] : []);
      } catch (error) {
        console.error('Failed to load resident admissions:', error);
        setAdmissions([]);
      } finally {
        setLoadingAdmissions(false);
      }
    };

    loadAdmissions();
  }, [id]);

  useEffect(() => {
    if (!id) {
      setDischargePlan(null);
      return;
    }
    let cancelled = false;
    setLoadingDischargePlan(true);
    request<{ success: boolean; data?: DischargePlanData }>(`/discharge-plans/resident/${id}`)
      .then(response => {
        if (!cancelled) {
          const data = response?.success ? response.data || null : null;
          setDischargePlan(data);
          setExpectedDateDraft(data?.admission?.expectedDischargeDate || '');
        }
      })
      .catch(error => console.error('Failed to load discharge plan:', error))
      .finally(() => { if (!cancelled) setLoadingDischargePlan(false); });
    return () => { cancelled = true; };
  }, [id]);

  const latestAdmission = admissions[0] || null;

  useEffect(() => {
    const storedExpectedDate = dischargePlan?.admission?.expectedDischargeDate || latestAdmission?.expectedDischargeDate || '';
    if (storedExpectedDate) setExpectedDateDraft(storedExpectedDate);
  }, [dischargePlan?.admission?.expectedDischargeDate, latestAdmission?.expectedDischargeDate]);

  useEffect(() => {
    if (!id) { setLatestTri(null); setPreviousTri(null); return; }
    const loadLatestTri = async () => {
      setLoadingTri(true);
      try {
        const response = await request<{ success: boolean; data?: LatestTriRecord[] }>(`/tri/resident/${id}/history?status=Finalized`);
        const records = response?.success ? response.data || [] : [];
        records.sort((a,b) => b.reportingYear - a.reportingYear || b.reportingMonth - a.reportingMonth || String(b.finalizedAt || '').localeCompare(String(a.finalizedAt || '')));
        const finalized = records.filter(r => r.status === 'Finalized');
        // The second-newest finalized record is what the newest is compared against —
        // without it the page can only state the current rating, not whether it moved.
        setLatestTri(finalized[0] || null);
        setPreviousTri(finalized[1] || null);
      } catch (error) {
        console.error('Failed to load latest finalized TRI:', error);
        setLatestTri(null);
        setPreviousTri(null);
      } finally { setLoadingTri(false); }
    };
    loadLatestTri();
  }, [id]);

  useEffect(() => {
    const loadViolationGuides = async () => {
      setLoadingViolationGuides(true);
      try {
        const response = await request<{ success: boolean; data?: ViolationGuideRecord[] }>('/violation-guide');
        const active = (response?.success ? response.data || [] : [])
          .filter(g => g && g.status !== 'Inactive' && (g.category === 'Minor' || g.category === 'Major'));
        setViolationGuides(active);
      } catch (error) {
        console.error('Failed to load active SCH violations:', error);
        setViolationGuides([]);
      } finally { setLoadingViolationGuides(false); }
    };
    loadViolationGuides();
  }, []);

  const contextChild = useMemo(() => children.find((c) => c.id === id), [id, children]);

  // Child Records and Houseparent Case Load both use this same detail viewer.
  // The Houseparent caseload summary deliberately carries only id/name, so make
  // one assignment-scoped request here when the browser cache does not contain
  // the complete resident record. This keeps the detail page identical to
  // Child Records without weakening the server-side assignment check.
  useEffect(() => {
    let cancelled = false;
    if (!id) {
      setRemoteChild(null);
      return;
    }

    // For Houseparents, always refresh the selected resident from the server so
    // the viewer reflects the actual current record. Other roles keep the
    // existing Child Records behavior unless their context is missing the row.
    const shouldFetch = isHouseparent || !contextChild;
    if (!shouldFetch) {
      setRemoteChild(null);
      return;
    }

    request<{ success: boolean; data?: any }>(`/children/${encodeURIComponent(id)}`)
      .then(response => {
        if (!cancelled) setRemoteChild(response?.success ? response.data || null : null);
      })
      .catch(() => {
        if (!cancelled) setRemoteChild(null);
      });

    return () => { cancelled = true; };
  }, [id, isHouseparent, contextChild]);

  const child = remoteChild || contextChild;

  /**
   * Save the Medical Notes onto the resident record.
   *
   * `child.notes` is the field the card has always rendered, so this keeps one
   * stored value instead of adding a second medical-notes column that would then
   * need syncing against it. Guarded by `canEditMedical` at the call site; the
   * backend enforces the same rule.
   */
  const saveMedicalNotes = async () => {
    setSavingMedicalNotes(true);
    try {
      await updateChild(child.id, { notes: medicalNotesDraft });
      setIsEditingMedicalNotes(false);
    } finally {
      setSavingMedicalNotes(false);
    }
  };
  const childViolations = useMemo(() => violations.filter((v) => v.residentId === id), [violations, id]);
  const behaviorSummary = useMemo(() => {
    if (!latestTri) return { status: 'Still Monitoring', color: 'bg-blue-500' };
    const rating = latestTri.rating || 'Not Rated';
    if (rating === 'Very Good') return { status: rating, color: 'bg-green-600' };
    if (rating === 'Good') return { status: rating, color: 'bg-blue-600' };
    if (rating === 'Fair') return { status: rating, color: 'bg-amber-500' };
    if (rating === 'Needs Improvement') return { status: rating, color: 'bg-red-600' };
    return { status: rating, color: 'bg-gray-500' };
  }, [latestTri]);

  // How the newest finalized TRI compares with the one before it. `triTrend`
  // returns direction 'unknown' when there is no earlier record, which is the
  // normal case for a resident with a single TRI — shown as "First recorded
  // rating" rather than an arrow implying no movement.
  const triTrendSummary = useMemo(
    () => triTrend(
      { rating: latestTri?.rating, finalPoints: latestTri?.finalPoints },
      previousTri ? { rating: previousTri.rating, finalPoints: previousTri.finalPoints } : null
    ),
    [latestTri, previousTri]
  );

  const triTrendPeriod = previousTri
    ? `${previousTri.reportingMonth.toString().padStart(2, '0')}/${previousTri.reportingYear}`
    : null;

  const handlePrintAdmission = async (admission: AdmissionRecord) => {
    try {
      const response = await fetch('/forms/admission-slip.pdf');
      if (!response.ok) throw new Error('Admission Slip PDF could not be loaded.');

      const originalPdfBytes = await response.arrayBuffer();
      const pdfDoc = await PDFDocument.load(originalPdfBytes);
      const page = pdfDoc.getPage(0);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

      const drawText = (text: string | number | null | undefined, x: number, y: number, size = 11, maxWidth?: number) => {
        let value = String(text ?? '').trim();
        if (!value) return;
        if (maxWidth) {
          while (value.length > 1 && font.widthOfTextAtSize(value, size) > maxWidth) {
            value = value.slice(0, -1);
          }
        }
        page.drawText(value, { x, y, size, font, color: rgb(0, 0, 0) });
      };

      const displayDate = (value?: string) => {
        if (!value) return '';
        const normalized = String(value).slice(0, 10);
        const parts = normalized.split('-');
        return parts.length === 3 ? `${parts[1]}/${parts[2]}/${parts[0]}` : normalized;
      };

      drawText(displayDate(admission.admissionDate), 183, 385, 11, 215);
      drawText(admission.name, 179, 360, 11, 215);
      drawText(admission.age, 108, 345, 11, 29);
      drawText(admission.sex, 163, 345, 11, 50);
      drawText(displayDate(admission.birthDate), 269, 345, 11, 126);
      drawText(admission.religion, 443, 345, 11, 96);
      drawText(admission.address, 178, 321, 11, 238);

      // The resident's drawn signature, stamped into the blank rule right
      // after "Signature of Resident:", the same band the Child Records
      // editor shows it in.
      await drawSignatureImage(
        pdfDoc,
        admission.residentSignature,
        toPdfBox(ADMISSION_RESIDENT_SIGNATURE_BOX, PDF_HEIGHT)
      );

      drawText(admission.guardianName, 178, 272, 11, 215);
      drawText(admission.guardianContact, 456, 272, 11, 244);
      drawText(admission.guardianAddress, 178, 249, 11, 238);

      // The guardian's drawn signature, stamped into the blank rule right
      // after "Signature of Guardian:", the same band the Child Records
      // editor shows it in.
      await drawSignatureImage(
        pdfDoc,
        admission.guardianSignature,
        toPdfBox(ADMISSION_GUARDIAN_SIGNATURE_BOX, PDF_HEIGHT)
      );

      drawText(admission.referringParty, 81, 199, 11, 208);
      drawText(admission.referringPartyContact, 352, 199, 11, 245);
      drawText(admission.houseparentOnDuty, 80, 147, 11, 215);

      // The referring party's drawn signature, stamped into the same blank
      // band the Child Records editor shows it in, on the "Referring Party:"
      // line.
      await drawSignatureImage(
        pdfDoc,
        admission.referringPartySignature,
        toPdfBox(ADMISSION_REFERRING_PARTY_SIGNATURE_BOX, PDF_HEIGHT)
      );

      // The Houseparent's drawn signature, stamped into the same blank band the
      // Child Records editor shows it in, so both renders agree.
      await drawSignatureImage(
        pdfDoc,
        admission.houseparentSignature,
        toPdfBox(ADMISSION_HOUSEPARENT_SIGNATURE_BOX, PDF_HEIGHT)
      );

      if (admission.residentImage) {
        try {
          const match = admission.residentImage.match(/^data:image\/(png|jpeg|jpg);base64,/i);
          if (match) {
            const image = match[1].toLowerCase() === 'png'
              ? await pdfDoc.embedPng(admission.residentImage)
              : await pdfDoc.embedJpg(admission.residentImage);
            const boxX = 705, boxY = 384, boxWidth = 157, boxHeight = 123;
            const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
            const width = image.width * scale;
            const height = image.height * scale;
            page.drawImage(image, {
              x: boxX + (boxWidth - width) / 2,
              y: boxY + (boxHeight - height) / 2,
              width,
              height,
            });
          }
        } catch (error) {
          console.error('Failed to embed resident image:', error);
        }
      }

      const bytes = await pdfDoc.save();
      const safeBytes = new Uint8Array(bytes.byteLength);
      safeBytes.set(bytes);
      const blob = new Blob([safeBytes.buffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);

      if (admissionPdfUrl) {
        URL.revokeObjectURL(admissionPdfUrl);
      }

      setAdmissionPdfUrl(url);
      setAdmissionPdfTitle(
        `Admission Slip #${admission.admissionNumber} — ${admission.name}`
      );
      setIsAdmissionPdfOpen(true);
    } catch (error) {
      console.error('Failed to generate Admission Slip:', error);
      void systemDialog.failure('Could not generate the Admission Slip', 'The PDF could not be built. Please try again.');
    }
  };

  useEffect(() => {
    return () => {
      if (admissionPdfUrl) URL.revokeObjectURL(admissionPdfUrl);
    };
  }, [admissionPdfUrl]);

  const closeAdmissionPdf = () => {
    if (admissionPdfUrl) {
      URL.revokeObjectURL(admissionPdfUrl);
    }
    setAdmissionPdfUrl(null);
    setIsAdmissionPdfOpen(false);
  };

  const handleDownloadAdmissionSlip = () => {
    if (!admissionPdfUrl) return;
    const link = document.createElement('a');
    link.href = admissionPdfUrl;
    link.download = `${admissionPdfTitle.replace(/[^a-z0-9-_]+/gi, '_')}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handlePrintAdmissionSlip = () => {
    if (!admissionPdfUrl) return;
    const printWindow = window.open(admissionPdfUrl, '_blank');
    if (!printWindow) {
      void systemDialog.failure(
        'Could not open the print window',
        'Your browser blocked the new window. Allow pop-ups for this site, then print the Admission Slip again.',
      );
      return;
    }
    setTimeout(() => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch {
        printWindow.focus();
      }
    }, 1200);
  };

  const role = String(user?.role || '').toLowerCase();
  const canDecideDischarge = ['centerhead', 'admin', 'socialworker'].includes(role);

  const reloadDischargePlan = async () => {
    if (!id) return;
    const response = await request<{ success: boolean; data?: DischargePlanData }>(`/discharge-plans/resident/${id}`);
    if (response?.success) {
      setDischargePlan(response.data || null);
      setExpectedDateDraft(response.data?.admission?.expectedDischargeDate || '');
    }
  };

  const handleSaveExpectedDate = async () => {
    if (!id || !expectedDateDraft) return;
    setExpectedDateSaving(true);
    try {
      await request(`/discharge-plans/resident/${id}/expected-date`, { method: 'PUT', body: JSON.stringify({ expectedDischargeDate: expectedDateDraft }) });
      await reloadDischargePlan();
    } catch (error: any) {
      void systemDialog.failure('Could not save the expected discharge date', describeError(error, 'The expected discharge date was not saved. Please try again.'));
    }
    finally { setExpectedDateSaving(false); }
  };

  const handleAddExtension = async () => {
    if (!id || !extensionDays || !extensionReason.trim() || !expectedDateDraft) return;
    setExtensionSaving(true);
    try {
      const amount = Number(extensionDays);
      if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter a whole number greater than 0.');
      let daysToAdd = amount;
      if (extensionUnit === 'months') {
        const [year, month, day] = expectedDateDraft.split('-').map(Number);
        const base = new Date(Date.UTC(year, month - 1, day));
        const targetMonthIndex = base.getUTCMonth() + amount;
        const targetYear = base.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
        const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
        const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
        const target = new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay)));
        daysToAdd = Math.round((target.getTime() - base.getTime()) / 86400000);
      }
      const latestRecommendation = dischargePlan?.recommendations?.find(r => r.status === 'Pending');
      await request(`/discharge-plans/resident/${id}/extensions`, {
        method: 'POST',
        body: JSON.stringify({ extensionDays: daysToAdd, reason: extensionReason.trim(), relatedViolationId: relatedViolationId || null, recommendationId: latestRecommendation?.id || null, triRecordId: latestRecommendation?.triRecordId || null }),
      });
      setShowExtensionDialog(false);
      setExtensionDays('');
      setExtensionUnit('days');
      setExtensionReason('');
      setRelatedViolationId('');
      await reloadDischargePlan();
    } catch (error: any) {
      void systemDialog.failure('Could not save the extension', describeError(error, 'The discharge extension was not saved. Please try again.'));
    }
    finally { setExtensionSaving(false); }
  };

  const handleDismissRecommendation = async (recommendationId: string) => {
    try { await request(`/discharge-plans/recommendations/${recommendationId}/dismiss`, { method: 'POST' }); await reloadDischargePlan(); }
    catch (error: any) {
      void systemDialog.failure('Could not dismiss the recommendation', describeError(error, 'The recommendation was not dismissed. Please try again.'));
    }
  };

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
        // The document *is* the record — the Documents module is the single
        // source of truth, and `addDocument` above has already put it in the
        // shared `documents` array that both this tab and the Health module
        // read. Appending it to the legacy `child.medicalRecords` JSON as well
        // is what used to make one upload two rows; the read path keeps
        // de-duping against rows written before that was fixed, but nothing
        // writes there any more. Only `lastCheckup` is still updated: it is a
        // different fact (when the resident was last seen), not a copy of the
        // document.
        await updateChild(child.id, { lastCheckup: today });
      } catch (e) { console.error('Medical upload error:', e); }
      setIsUploadingMedical(false);
    };
    reader.onerror = () => setIsUploadingMedical(false);
    reader.readAsDataURL(file);
  };

  const [formData, setFormData] = useState({
    type: '',
    severity: 'Minor' as 'Minor' | 'Major',
    sessionType: 'group' as 'individual' | 'group',
    note: '',
  });

  const handleEndorse = async () => {
    if (!endorseTo.trim() || !child) return;
    setIsEndorsing(true);
    const now = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', hour12: true });
    const fromUser = (user?.username || 'Staff') + ' (' + (user?.role || '') + ')';
    const nl = String.fromCharCode(10);
    const entry = '[' + now + '] ' + fromUser + ' -> ' + endorseTo + ': ' + (endorseNote || 'Case endorsed');
    const existingNotes = child.notes || '';
    const hasSection = existingNotes.includes('[ENDORSEMENTS]');
    const newNotes = hasSection ? existingNotes + entry + nl : existingNotes + (existingNotes ? nl : '') + '[ENDORSEMENTS]' + nl + entry + nl;
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
      return { timestamp: line.substring(1, idx1), from: line.substring(idx1 + 2, idx2), to: line.substring(idx2 + 4, idx3), note: line.substring(idx3 + 2) };
    }).filter(Boolean);
  })();

  const handleOpenLogIncident = async () => {
    setLoadingViolationGuides(true);
    try {
      const response = await request<{ success: boolean; data?: ViolationGuideRecord[] }>('/violation-guide');
      const active = (response?.success ? response.data || [] : [])
        .filter(g => g && g.status !== 'Inactive' && (g.category === 'Minor' || g.category === 'Major'));
      setViolationGuides(active);
      if (active.length === 0) {
        void systemDialog.validation('No active violations are configured', {
          description: 'Add a violation in Manage Violations & Interventions before logging an incident.',
        });
        return;
      }
      setFormData({ type: '', severity: 'Minor', sessionType: 'group', note: '' });
      setSelectedIncidentResidentIds([child?.id || ''].filter(Boolean));
      setIncidentResidentSearch('');
      setViolationTypeSearch('');
      setIncidentDateTime(localDateTimeInput());
      setIsLogModalOpen(true);
    } catch (error) {
      console.error('Failed to load active SCH violations:', error);
      setViolationGuides([]);
      void systemDialog.failure('Could not load the active violations', 'Manage Violations & Interventions returned no usable list. Try again in a moment.');
    } finally { setLoadingViolationGuides(false); }
  };

  const handleAddLog = async () => {
    if (!child || !formData.type.trim() || selectedIncidentResidentIds.length === 0) return;
    const selectedGuide = violationGuides.find(guide => guide.name === formData.type);
    if (!selectedGuide) {
      void systemDialog.validation('That violation is no longer active', {
        description: 'It was changed or deactivated in Manage Violations & Interventions. Pick a current one.',
      });
      return;
    }
    setIncidentCreating(true);
    try {
      const createdIds: string[] = [];
      const groupId = selectedIncidentResidentIds.length > 1 ? `INC-GRP-${Date.now()}` : undefined;
      for (const residentId of selectedIncidentResidentIds) {
        const response: any = await request('/violations', {
          method: 'POST',
          body: JSON.stringify({
            residentId,
            date: incidentDateTime.slice(0, 10),
            type: selectedGuide.name,
            description: formData.note || null,
            severity: selectedGuide.category,
            location: '', witnesses: '', reportedBy: user?.username || '', actionTaken: '',
            status: 'Pending Review', requiresAssessment: true, assessmentTriggered: false,
            sessionType: formData.sessionType, incidentGroupId: groupId,
          }),
        });
        if (!response?.success || !response.data?.id) throw new Error('Unable to create the incident record.');
        createdIds.push(response.data.id);
      }
      setActiveIncidentViolationId(createdIds[0] || null);
      setActiveIncidentViolationIds(createdIds);
      setActiveIncidentResidentIds(selectedIncidentResidentIds);
      // Form 08 is a post-intervention record. Do not open it immediately
      // after logging a violation; it becomes available once this violation's
      // intervention is fully completed and marked Done.
      setIsLogModalOpen(false);
      setIsIncidentReportOpen(false);
      await refreshData();
    } catch (error) {
      void systemDialog.failure('Could not log the incident', describeError(error, 'The incident was not logged. Please try again.'));
    } finally { setIncidentCreating(false); }
  };

  if (!child) return <div className="p-10 text-center">Resident record not found.</div>;

  // Abscond — Center Head / Social Worker only (the API enforces the same).
  const canMarkAbscond = ['centerhead', 'admin', 'socialworker'].includes(String(user?.role || '').toLowerCase().replace(/[\s_-]+/g, ''));
  const handleAbscond = async () => {
    const confirmed = await systemDialog.confirm({
      title: `Mark ${child.name} as absconded?`,
      description: 'The resident will be moved to the Abscond tab. Their Phase Timeline will be frozen and their record becomes view-only. All existing phase progress and records are kept.',
      confirmLabel: 'Mark as Absconded',
      tone: 'warning',
    });
    if (!confirmed) return;
    try {
      await request(`/children/${child.id}/abscond`, { method: 'POST' });
      await refreshData();
    } catch (error) {
      void systemDialog.failure('Could not mark the resident as absconded', describeError(error, 'The status was not changed. Please try again.'));
    }
  };

  const basicName = latestAdmission?.name || child.name || '—';
  const basicAge = latestAdmission?.age ?? child.age ?? '—';
  const basicBirthDate = latestAdmission?.birthDate || child.birthDate || '';
  const basicSex = latestAdmission?.sex || child.gender || '—';
  const basicGuardianName = latestAdmission?.guardianName || child.guardianName || '—';
  const basicGuardianContact = latestAdmission?.guardianContact || child.guardianContact || '—';
  const basicAddress = latestAdmission?.address || child.address || '—';
  const basicReligion = latestAdmission?.religion || '—';

  return (
    <div className="space-y-6 pb-10">
      <div className="flex items-center justify-between">
        <Button onClick={handleBack} variant="ghost" className="flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <Button onClick={() => setActiveTab('behavioral')} className={`${behaviorSummary.color} text-white px-4 py-1.5 flex gap-2 shadow-sm hover:opacity-90`}>
          <ShieldAlert className="w-4 h-4" /> {behaviorSummary.status}
        </Button>
      </div>

      <Card className="border-l-4 border-l-[#2F3E46]">
        <CardContent className="p-6">
          <div>
            <h2 className="text-2xl font-bold text-[#2F3E46] flex items-center gap-2">
              {child.name}
              {isAbsconded && <Badge className="bg-orange-100 text-orange-800 border-none text-[10px] uppercase font-bold">Absconded</Badge>}
            </h2>
            <p className="text-sm text-gray-500">ID: {child.id}</p>
          </div>
          {isAbsconded && (
            <p className="mt-3 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800">
              This resident has absconded{(child as any).abscondedAt ? ` (${formatShortDate(String((child as any).abscondedAt).slice(0, 10))})` : ''}. The record is view-only and the Phase Timeline is frozen; all existing records are kept.
            </p>
          )}
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        {/*
          Five tabs squeezed into a 5-column grid are unreadable on a phone.
          Below lg the list scrolls horizontally instead; at lg and up it keeps
          the original even 5-column layout.
        */}
        <TabsList
          className="flex w-full max-w-full items-center justify-start gap-1 overflow-x-auto overflow-y-hidden bg-gray-100/50 p-1 lg:grid"
          // The grid used to be a fixed 5 columns. The tab count is the role's
          // now, so it is derived rather than assumed.
          style={{ gridTemplateColumns: `repeat(${Math.max(childRecordTabs.length, 1)}, minmax(0, 1fr))` }}
        >
          {childRecordTabs.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key} className="flex-none lg:flex-1">
              {/* The stored label is 'Education'; the page has always shown it as
                  'Education Progress' because the tab covers the resident's
                  progress record rather than the school record. */}
              {tab.key === 'Education' ? 'Education Progress' : tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="personal" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2"><User className="w-4 h-4" /> Basic Information</CardTitle>
                {canMarkAbscond && !isAbsconded && child.status !== 'Discharged' && (
                  <Button type="button" size="sm" variant="outline" className="h-8 border-orange-300 text-orange-700 hover:bg-orange-50" onClick={() => { void handleAbscond(); }}>
                    Abscond
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-3 text-sm">
              <div className="flex justify-between border-b pb-2"><span className="text-gray-500">Full Name</span><span className="font-semibold text-right">{basicName}</span></div>
              <div className="flex justify-between border-b pb-2"><span className="text-gray-500">Age</span><span className="font-semibold">{basicAge}</span></div>
              <div className="flex justify-between border-b pb-2"><span className="text-gray-500">Birth Date</span><span className="font-semibold">{basicBirthDate ? formatShortDate(basicBirthDate) : '—'}</span></div>
              <div className="flex justify-between border-b pb-2"><span className="text-gray-500">Sex</span><span className="font-semibold">{basicSex}</span></div>
              <div className="flex justify-between border-b pb-2"><span className="text-gray-500">Guardian Name</span><span className="font-semibold text-right">{basicGuardianName}</span></div>
              <div className="flex justify-between border-b pb-2"><span className="text-gray-500">Guardian Contact</span><span className="font-semibold">{basicGuardianContact}</span></div>
              <div className="flex justify-between border-b pb-2 md:col-span-2"><span className="text-gray-500">Complete Address</span><span className="font-semibold text-right max-w-[70%]">{basicAddress}</span></div>
              <div className="flex justify-between border-b pb-2"><span className="text-gray-500">Religion</span><span className="font-semibold">{basicReligion}</span></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2"><FileText className="w-4 h-4" /> Case Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {loadingAdmissions ? (
                <div className="py-5 text-center text-sm text-gray-400">Loading admission history...</div>
              ) : admissions.length > 0 ? (
                <div className="space-y-3">
                  {admissions.map((admission) => (
                    <div key={admission.id} className="rounded-xl border border-gray-200 bg-white p-3">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline">Admission #{admission.admissionNumber}</Badge>
                          <Badge className={admission.status === 'Closed' ? 'bg-gray-100 text-gray-700' : 'bg-green-100 text-green-700'}>
                            {admission.status || 'Active'}
                          </Badge>
                        </div>
                        <Button type="button" variant="outline" size="sm" className="rounded-lg shrink-0" onClick={() => handlePrintAdmission(admission)}>
                          <FileText className="w-4 h-4 mr-2" /> View Admission Slip
                        </Button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-0 text-sm">
                        <div className="flex items-center justify-between border-b py-1.5"><span className="text-gray-500">Case ID</span><span className="font-semibold font-mono text-right">{child.id}</span></div>
                        <div className="flex items-center justify-between border-b py-1.5"><span className="text-gray-500">Date of Admission</span><span className="font-semibold">{formatShortDate(admission.admissionDate)}</span></div>
                        <div className="flex items-center justify-between border-b py-1.5"><span className="text-gray-500">Specific Offense</span><span className="font-semibold text-right max-w-[65%]">{admission.specificOffense || '—'}</span></div>
                        <div className="flex items-center justify-between border-b py-1.5"><span className="text-gray-500">Legal Category</span><span className="font-semibold text-right max-w-[65%]">{admission.legalCategory || '—'}</span></div>
                        <div className="flex items-center justify-between border-b py-1.5"><span className="text-gray-500">Referring Party</span><span className="font-semibold text-right max-w-[65%]">{admission.referringParty || '—'}</span></div>
                        <div className="flex items-center justify-between border-b py-1.5"><span className="text-gray-500">Contact No. (Referring Party)</span><span className="font-semibold">{admission.referringPartyContact || '—'}</span></div>
                        <div className="flex items-center justify-between border-b py-1.5 md:col-span-2"><span className="text-gray-500">Houseparent on Duty</span><span className="font-semibold">{admission.houseparentOnDuty || '—'}</span></div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-gray-200 bg-white p-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-0 text-sm">
                    <div className="flex items-center justify-between border-b py-1.5"><span className="text-gray-500">Case ID</span><span className="font-semibold font-mono">{child.id}</span></div>
                    <div className="flex items-center justify-between border-b py-1.5"><span className="text-gray-500">Date of Admission</span><span className="font-semibold">{child.admissionDate ? formatShortDate(child.admissionDate) : '—'}</span></div>
                    <div className="flex items-center justify-between border-b py-1.5"><span className="text-gray-500">Specific Offense</span><span className="font-semibold">{child.caseType || '—'}</span></div>
                    <div className="flex items-center justify-between border-b py-1.5"><span className="text-gray-500">Legal Category</span><span className="font-semibold">{child.legalCategory || '—'}</span></div>
                    <div className="flex items-center justify-between border-b py-1.5"><span className="text-gray-500">Referring Party</span><span className="font-semibold">—</span></div>
                    <div className="flex items-center justify-between border-b py-1.5"><span className="text-gray-500">Contact No. (Referring Party)</span><span className="font-semibold">—</span></div>
                    <div className="flex items-center justify-between border-b py-1.5 md:col-span-2"><span className="text-gray-500">Houseparent on Duty</span><span className="font-semibold">—</span></div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-amber-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2">📅 Discharge Plan</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {loadingDischargePlan ? (
                <p className="text-sm text-gray-400">Loading discharge plan...</p>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="rounded-lg border bg-amber-50/50 p-3"><p className="text-[10px] uppercase font-bold tracking-wider text-gray-400">Expected Discharge</p><p className="mt-1 text-base font-bold text-[#2F3E46]">{(dischargePlan?.admission?.expectedDischargeDate || latestAdmission?.expectedDischargeDate) ? formatShortDate(dischargePlan?.admission?.expectedDischargeDate || latestAdmission?.expectedDischargeDate || '') : 'Not set'}</p></div>
                    <div className="rounded-lg border bg-gray-50 p-3"><p className="text-[10px] uppercase font-bold tracking-wider text-gray-400">Total Extensions</p><p className="mt-1 text-base font-bold text-[#2F3E46]">{(dischargePlan?.history || []).reduce((sum, item) => sum + Number(item.extensionDays || 0), 0)} days</p></div>
                    <div className="rounded-lg border bg-gray-50 p-3"><p className="text-[10px] uppercase font-bold tracking-wider text-gray-400">Behavioral Review</p><p className="mt-1 text-base font-bold text-[#2F3E46]">{dischargePlan?.recommendations?.some(r => r.status === 'Pending') ? 'Review recommended' : 'No pending recommendation'}</p></div>
                  </div>

                  {canDecideDischarge && (
                    <div className="rounded-lg border p-3 bg-white">
                      <div className="flex flex-col md:flex-row md:items-end gap-3">
                        <div className="flex-1 max-w-xs"><Label className="text-xs font-semibold">Expected Discharge Date</Label><Input type="date" value={expectedDateDraft || latestAdmission?.expectedDischargeDate || ''} min={latestAdmission?.admissionDate || child.admissionDate || undefined} onChange={e => setExpectedDateDraft(e.target.value)} className="mt-1" /></div>
                        <Button size="sm" onClick={handleSaveExpectedDate} disabled={!expectedDateDraft || expectedDateSaving}>{expectedDateSaving ? 'Saving...' : 'Save Date'}</Button>
                        <Button size="sm" variant="outline" onClick={() => setShowExtensionDialog(true)} disabled={!expectedDateDraft}>Add Time Extension</Button>
                      </div>
                    </div>
                  )}

                  {(dischargePlan?.recommendations || []).filter(r => r.status === 'Pending').map(rec => (
                    <div key={rec.id} className="rounded-xl border border-amber-300 bg-amber-50 p-4">
                      <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-amber-800">Behavioral Review Recommendation</p><p className="text-sm font-semibold text-[#2F3E46] mt-1">{String(rec.reportingMonth).padStart(2, '0')}/{rec.reportingYear} · {rec.thresholdType}</p></div>{canDecideDischarge && <Button size="sm" variant="ghost" onClick={() => handleDismissRecommendation(rec.id)}>Dismiss</Button>}</div>
                      <div className="grid grid-cols-2 gap-3 mt-3"><div><p className="text-[10px] uppercase text-gray-500">Major</p><p className="font-bold text-orange-700">{rec.majorCount}</p></div><div><p className="text-[10px] uppercase text-gray-500">Minor</p><p className="font-bold text-yellow-700">{rec.minorCount}</p></div></div>
                      <p className="text-sm text-gray-700 mt-3 leading-relaxed">{rec.recommendationNote}</p>
                    </div>
                  ))}

                  <div><h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Extension History</h4>{(dischargePlan?.history || []).length === 0 ? <p className="text-sm text-gray-400 italic">No extension decisions recorded.</p> : <div className="space-y-2">{(dischargePlan?.history || []).map(item => <div key={item.id} className="rounded-lg border bg-gray-50 p-3"><div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2"><div><p className="font-semibold text-sm">+{item.extensionDays} day{Number(item.extensionDays) === 1 ? '' : 's'} · {formatShortDate(item.previousDischargeDate)} → {formatShortDate(item.newDischargeDate)}</p><p className="text-xs text-gray-600 mt-1">{item.reason}</p></div><p className="text-[10px] text-gray-400">{item.decidedBy} · {item.decidedAt ? new Date(item.decidedAt).toLocaleString() : '—'}</p></div></div>)}</div>}</div>
                </>
              )}
            </CardContent>
          </Card>

        </TabsContent>

        <TabsContent value="education" className="mt-4 space-y-4">
          {(() => {
            const eduStudents: any[] = [];
            try { const saved = localStorage.getItem('educationStudents'); if (saved) { const all = JSON.parse(saved); eduStudents.push(...all.filter((s: any) => s.name === child.name || s.residentId === child.id)); } } catch {}
            const student = eduStudents[0] || null;

            // Visit reports and Pass/Fail results are sourced from the real
            // Document Module (not browser-local storage) so counts are
            // accurate for whoever views this record, on any device.
            const visitDocs = documents.filter(d => d.residentId === child.id && d.title === 'School Visit Report');
            const quarterlyDocs = documents.filter(d => d.residentId === child.id && d.title === 'Quarterly Education Report');
            // Pass/Fail counts reflect the Center Head's actual review decision
            // (Approve = Pass, Failed = Fail) — not just what the Educator
            // originally wrote, since that's not final until reviewed.
            const passCount = quarterlyDocs.filter(d => d.status === 'Approved').length;
            const failCount = quarterlyDocs.filter(d => d.status === 'Rejected').length;

            return (
              <div className="space-y-4">
                <Card className="border-l-4 border-blue-400 shadow-sm"><CardContent className="p-5"><div className="flex items-center gap-4"><div className="p-3 rounded-xl bg-blue-50 shrink-0"><span className="text-2xl">🎓</span></div><div className="flex-1"><p className="text-[10px] uppercase font-bold tracking-widest text-gray-400 mb-0.5">Education Status</p>{student ? <><h3 className="text-lg font-black text-blue-700">{student.educationLevel || 'Not specified'}</h3><p className="text-xs text-gray-500 mt-0.5">Enrolled as: {student.name}</p></> : <h3 className="text-lg font-bold text-gray-400">Not yet enrolled in Education Module</h3>}</div></div></CardContent></Card>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Card className="border-none shadow-sm"><CardContent className="p-4 text-center"><p className="text-2xl font-black text-blue-600">{visitDocs.length}</p><p className="text-xs text-gray-500 mt-0.5">School Visits</p></CardContent></Card><Card className="border-none shadow-sm"><CardContent className="p-4 text-center"><p className="text-2xl font-black text-green-600">{passCount}</p><p className="text-xs text-gray-500 mt-0.5">Passed</p></CardContent></Card><Card className="border-none shadow-sm"><CardContent className="p-4 text-center"><p className="text-2xl font-black text-red-500">{failCount}</p><p className="text-xs text-gray-500 mt-0.5">Failed</p></CardContent></Card></div>
                {quarterlyDocs.length > 0 && <Card className="border-none shadow-sm"><CardContent className="p-4"><h4 className="font-bold text-[#2F3E46] text-sm mb-3">Quarterly Reports</h4><div className="space-y-2">{quarterlyDocs.map((d) => { const firstLines = (d.description || '').split('\n').slice(0, 2).join(' '); const badge = d.status === 'Approved' ? { label: 'Pass', cls: 'bg-green-100 text-green-700' } : d.status === 'Rejected' ? { label: 'Fail', cls: 'bg-red-100 text-red-700' } : (d.status as string) === 'Reassessment' ? { label: 'Reassessment', cls: 'bg-yellow-100 text-yellow-700' } : { label: 'Pending Review', cls: 'bg-gray-100 text-gray-600' }; return (<div key={d.id} className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl"><div className="flex-1 min-w-0"><div className="flex items-center gap-2 flex-wrap"><p className="text-xs font-bold text-[#2F3E46] truncate">{firstLines}</p><span className={`px-2 py-0.5 rounded-full font-bold text-[10px] shrink-0 ${badge.cls}`}>{badge.label}</span></div><p className="text-[10px] text-gray-400 mt-0.5">Submitted {d.submittedAt ? new Date(d.submittedAt).toLocaleDateString() : '—'} by {d.uploadedBy || 'Educator'}</p></div></div>); })}</div></CardContent></Card>}
                {visitDocs.length > 0 && <Card className="border-none shadow-sm"><CardContent className="p-4"><h4 className="font-bold text-[#2F3E46] text-sm mb-3">School Visit Reports</h4><div className="space-y-2">{visitDocs.map((d) => (<div key={d.id} className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl"><div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center shrink-0"><span className="text-sm">🏫</span></div><div className="flex-1 min-w-0"><p className="text-xs text-gray-600">{d.description}</p><p className="text-[10px] text-gray-400 mt-0.5">{d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString() : ''}</p></div></div>))}</div></CardContent></Card>}
                {!student && <Card className="border-none shadow-sm"><CardContent className="p-8 text-center"><span className="text-4xl">📚</span><p className="text-gray-400 mt-2 text-sm">No education records found for this resident.</p><p className="text-xs text-gray-300 mt-1">Go to the Education module to enroll this resident.</p></CardContent></Card>}
              </div>
            );
          })()}
        </TabsContent>

        <TabsContent value="timeline" className="mt-4"><PhaseProgress residentId={child.id} currentPhase={child.casePhase || 'Admission'} onPhaseAdvanced={() => refreshData()} /></TabsContent>

        <TabsContent value="medical" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 gap-4">
            <Card className="bg-green-50/50 border-green-100">
              <CardContent className="p-4 flex items-center gap-4">
                <div className="p-3 bg-white rounded-lg shadow-sm"><CalendarCheck className="w-6 h-6 text-green-600" /></div>
                <div>
                  <p className="text-[10px] uppercase font-bold text-green-600 tracking-wider">Last Checkup</p>
                  <p className="text-xl font-black text-slate-700">{child.lastCheckup && child.lastCheckup.trim() !== '' ? formatShortDate(child.lastCheckup) : '—'}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Medical Notes — create/edit is the Nurse's and the Center Head's.
              The rule is enforced by the `Health` edit capability rather than a
              role name, so it cannot drift from the Health module's own gates. */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-bold text-slate-600">Medical Notes</CardTitle>
              {canEditMedical && !isEditingMedicalNotes && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-xs"
                  onClick={() => { setMedicalNotesDraft(child.notes || ''); setIsEditingMedicalNotes(true); }}
                >
                  <Edit className="w-3 h-3" /> {child.notes ? 'Edit' : 'Add'}
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-2">
              {isEditingMedicalNotes ? (
                <>
                  <Textarea
                    rows={3}
                    value={medicalNotesDraft}
                    onChange={(e) => setMedicalNotesDraft(e.target.value)}
                    placeholder="Allergies, ongoing medication, vaccination status, dietary needs…"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" className="bg-[#2F3E46] text-white" disabled={savingMedicalNotes} onClick={saveMedicalNotes}>
                      {savingMedicalNotes ? 'Saving…' : 'Save'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setIsEditingMedicalNotes(false)}>Cancel</Button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-slate-500 italic">{child.notes || 'No known allergies. Up to date with basic vaccinations.'}</p>
              )}
            </CardContent>
          </Card>

          {/* Health & Medical History.
              Two lists, each with exactly one source, so nothing is duplicated
              and nothing is missing:
                · documents with category 'Medical' — the Documents module, which
                  is also what the Health module lists as "Medical Documents";
                · records written by the Health module — the same rows the Health
                  module shows in its own tabs. */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-sm font-bold text-slate-700">Health & Medical History</CardTitle>
              {canEditMedical && (
                <>
                  <input
                    type="file"
                    ref={medicalFileRef}
                    className="hidden"
                    accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.xls,.xlsx"
                    onChange={async (e) => { const file = e.target.files?.[0]; if (file) await handleMedicalDocUpload(file); if (e.target) e.target.value = ''; }}
                  />
                  <Button size="sm" className="bg-[#2F3E46] hover:bg-[#263440] text-white flex gap-2 h-8" onClick={() => medicalFileRef.current?.click()} disabled={isUploadingMedical}>
                    <Plus className="w-4 h-4" /> {isUploadingMedical ? 'Uploading...' : 'Add Document'}
                  </Button>
                </>
              )}
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-gray-400">Medical Documents</p>
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
                        const docModuleMedical = documents.filter(d => d.residentId === child.id && d.category === 'Medical').map(d => ({ id: d.id, name: d.title, category: 'Medical', dateUploaded: d.uploadedAt ? d.uploadedAt.split('T')[0] : d.approvedAt?.split('T')[0] || '—', fileName: d.fileName, fileData: d.fileData }));
                        const legacyRecords = (child.medicalRecords || []).filter(r => !docModuleMedical.some(d => d.name === r.name));
                        const allRecords = [...docModuleMedical, ...legacyRecords];
                        if (allRecords.length === 0) return <tr><td colSpan={4} className="p-10 text-center"><div className="flex flex-col items-center gap-2 opacity-30"><Stethoscope className="w-10 h-10" /><p className="text-sm italic">No medical records found for this resident.</p></div></td></tr>;
                        return allRecords.map((rec) => <tr key={rec.id} className="hover:bg-gray-50/50"><td className="p-3 font-medium">{rec.name}</td><td className="p-3 text-gray-500">{rec.category}</td><td className="p-3 text-gray-500">{rec.dateUploaded}</td><td className="p-3 text-right">{rec.fileData && <a href={rec.fileData} download={rec.fileName || rec.name} className="text-xs text-[#2F3E46] underline font-semibold">Download</a>}</td></tr>);
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-gray-400">Health Records</p>
                {(() => {
                  const records = healthRecords.filter(r => String(r.residentId) === String(child.id));
                  if (records.length === 0) {
                    return <p className="rounded-md border border-dashed border-gray-200 p-6 text-center text-sm italic text-gray-400">Nothing logged in the Health module for this resident yet.</p>;
                  }
                  return (
                    <div className="divide-y divide-gray-100 rounded-md border border-gray-100">
                      {records.map((r: any) => (
                        <div key={r.id} className="flex items-start justify-between gap-3 p-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-[#2F3E46]">{r.recordType || 'Health Record'}</p>
                            <p className="text-[11px] text-gray-400">
                              {r.date ? formatShortDate(String(r.date).slice(0, 10)) : '—'}
                              {r.recordedBy ? ` · ${r.recordedBy}` : ''}
                            </p>
                            {(r.findings || r.procedure_ || r.medicationName) && (
                              <p className="mt-0.5 text-xs text-gray-500">{r.findings || r.procedure_ || r.medicationName}</p>
                            )}
                          </div>
                          <Badge className="shrink-0 bg-[#2F3E46]/10 text-[#2F3E46]">{r.status || 'Completed'}</Badge>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="behavioral" className="mt-4 space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3"><ShieldAlert className="w-7 h-7 text-[#2F3E46]" /><div><p className="text-xs text-gray-500 uppercase tracking-wide">Behavioral Status</p><p className="text-xl font-bold text-[#2F3E46]">{behaviorSummary.status}</p></div></div>
                <div className="text-right"><p className="text-xs text-gray-500 uppercase tracking-wide">Latest Finalized TRI</p><p className="text-sm font-semibold text-gray-600">{latestTri ? `${latestTri.reportingMonth.toString().padStart(2, '0')}/${latestTri.reportingYear}` : loadingTri ? 'Loading…' : 'No finalized record'}</p></div>
              </div>
              {latestTri && (
                <div className="mt-3 border-t border-gray-100 pt-3" data-tri-trend={triTrendSummary.direction}>
                  <p className="text-xs text-gray-500">
                    {triTrendSummary.direction === 'unknown' ? (
                      // 'unknown' covers two different situations, and calling
                      // both "first recorded rating" is wrong. Either there is
                      // genuinely no earlier record, or there is one but it
                      // carries neither a rating nor points (a Finalized TRI can
                      // score 0), and that case does have a period to name.
                      <span className="italic">
                        {previousTri
                          ? `The ${triTrendPeriod} record has no rating or points to compare against.`
                          : 'First recorded rating — nothing to compare against yet.'}
                      </span>
                    ) : (
                      <>
                        <span className="text-gray-400">vs {triTrendPeriod}</span>
                        {'  '}
                        <span className={`font-semibold ${
                          triTrendSummary.direction === 'improved' ? 'text-green-700'
                          : triTrendSummary.direction === 'declined' ? 'text-red-700'
                          : 'text-gray-600'
                        }`}>{triTrendSummary.label}</span>
                      </>
                    )}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
          <div className="flex justify-between items-center"><h3 className="font-semibold text-gray-700">Incident History</h3><div className="flex gap-3 items-center"><Select value={violationFilterValue} onValueChange={setViolationFilterValue}><SelectTrigger className="w-40 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All Violations</SelectItem><SelectItem value="Major">Major Severity</SelectItem><SelectItem value="Minor">Minor Severity</SelectItem><SelectItem value="Resolved">Resolved Only</SelectItem><SelectItem value="Unresolved">Unresolved Only</SelectItem></SelectContent></Select>{can('Violations', 'create') && <Button onClick={handleOpenLogIncident} disabled={loadingViolationGuides} className="bg-red-600 hover:bg-red-700"><Plus className="mr-2 h-4 w-4" /> {loadingViolationGuides ? 'Loading…' : 'Add Incident'}</Button>}</div></div>
          <Card><CardContent className="p-0"><table className="w-full text-sm text-left"><thead className="bg-gray-50 border-b text-gray-600"><tr><th className="p-3">Date</th><th className="p-3">Type</th><th className="p-3">Severity</th><th className="p-3">Status</th></tr></thead><tbody className="divide-y">{(() => { let filtered = childViolations; if (violationFilterValue !== 'all') { if (violationFilterValue === 'Resolved') filtered = childViolations.filter(v => v.status === 'Resolved'); else if (violationFilterValue === 'Unresolved') filtered = childViolations.filter(v => v.status !== 'Resolved'); else filtered = childViolations.filter(v => v.severity === violationFilterValue); } return filtered.length === 0 ? <tr><td colSpan={4} className="p-8 text-center text-gray-400 italic text-sm">{violationFilterValue === 'all' ? 'No violations recorded in system.' : 'No violations match the selected filter.'}</td></tr> : filtered.map((violation) => <tr key={violation.id} className={`hover:bg-gray-50/50 ${violation.status === 'Resolved' ? 'opacity-60' : ''}`}><td className="p-3">{formatShortDate(violation.date)}</td><td className="p-3 font-medium">{violation.type}</td><td className="p-3"><Badge variant="outline" className={violation.severity === 'Major' ? 'border-orange-400 text-orange-600' : 'border-yellow-400 text-yellow-600'}>{violation.severity}</Badge></td><td className="p-3"><Badge className={violation.status === 'Resolved' ? 'bg-green-100 text-green-800' : violation.status === 'Under Investigation' ? 'bg-blue-100 text-blue-800' : violation.status === 'Escalated' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-800'}>{violation.status}</Badge></td></tr>); })()}</tbody></table></CardContent></Card>
          {(child.behavioralLogs || []).length > 0 && <Card className="opacity-75"><CardHeader className="pb-2"><CardTitle className="text-xs text-gray-500">Legacy Incident Logs (Pre-Migration)</CardTitle></CardHeader><CardContent className="p-0"><table className="w-full text-sm text-left"><tbody className="divide-y">{child.behavioralLogs.map((log) => <tr key={log.id} className="hover:bg-gray-50/50"><td className="p-2 text-xs">{formatShortDate(log.date)}</td><td className="p-2 text-xs">{log.type}</td></tr>)}</tbody></table></CardContent></Card>}
        </TabsContent>
      </Tabs>

      <Dialog open={showExtensionDialog} onOpenChange={setShowExtensionDialog}>
        <DialogContent className="!w-[min(720px,calc(100vw-2rem))] !max-w-none min-w-0 overflow-hidden">
          <DialogHeader><DialogTitle>Add Time Extension</DialogTitle></DialogHeader>
          <div className="w-full min-w-0 space-y-4 overflow-hidden">
            <div className="w-full min-w-0">
              <Label>Expected Discharge Date</Label>
              <Input type="date" value={expectedDateDraft || ''} readOnly disabled={!expectedDateDraft} className="mt-1 w-full min-w-0 bg-gray-50" />
            </div>
            <div className="grid w-full min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
              <div className="w-full min-w-0">
                <Label>{extensionUnit === 'months' ? 'Additional Months' : 'Additional Days'}</Label>
                <Input
                  type="number"
                  min={1}
                  max={extensionUnit === 'months' ? 120 : 3650}
                  step={1}
                  value={extensionDays}
                  onChange={e => setExtensionDays(e.target.value)}
                  placeholder={extensionUnit === 'months' ? 'e.g. 1' : 'e.g. 30'}
                  className="mt-1 w-full min-w-0"
                />
              </div>
              <div className="w-full min-w-0">
                <Label>Extension Unit</Label>
                <Select value={extensionUnit} onValueChange={v => { setExtensionUnit(v as 'days' | 'months'); setExtensionDays(''); }}>
                  <SelectTrigger className="mt-1 w-full min-w-0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="days">Days</SelectItem>
                    <SelectItem value="months">Months</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="w-full min-w-0">
              <Label>Reason for Extension</Label>
              <Textarea value={extensionReason} onChange={e => setExtensionReason(e.target.value)} placeholder="Document the reason for the decision..." rows={4} className="mt-1 w-full min-w-0" />
            </div>
            <div className="w-full min-w-0">
              <Label>Related Violation (optional)</Label>
              <Select value={relatedViolationId || 'none'} onValueChange={v => setRelatedViolationId(v === 'none' ? '' : v)}>
                <SelectTrigger className="mt-1 w-full min-w-0 overflow-hidden">
                  <SelectValue className="min-w-0 truncate" placeholder="Select violation" />
                </SelectTrigger>
                <SelectContent className="max-w-[calc(100vw-2rem)]">
                  <SelectItem value="none">None</SelectItem>{childViolations.map(v => <SelectItem key={v.id} value={v.id}>{formatShortDate(v.date)} · {v.severity} · {v.type}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {extensionDays && Number(extensionDays) > 0 && expectedDateDraft && (() => {
              const amount = Number(extensionDays);
              const [year, month, day] = expectedDateDraft.split('-').map(Number);
              const base = new Date(Date.UTC(year, month - 1, day));
              let target: Date;
              if (extensionUnit === 'months') {
                const targetMonthIndex = base.getUTCMonth() + amount;
                const targetYear = base.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
                const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
                const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
                target = new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay)));
              } else {
                target = new Date(base.getTime() + amount * 86400000);
              }
              return <p className="text-xs text-gray-500">New expected discharge: {formatShortDate(target.toISOString().slice(0, 10))}</p>;
            })()}
          </div>
          <DialogFooter className="w-full min-w-0">
            <Button variant="outline" onClick={() => setShowExtensionDialog(false)}>Cancel</Button>
            <Button onClick={handleAddExtension} disabled={extensionSaving || !extensionDays || Number(extensionDays) <= 0 || !extensionReason.trim()}>{extensionSaving ? 'Saving...' : 'Save Extension'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAdmissionPdfOpen} onOpenChange={(open) => { if (!open) closeAdmissionPdf(); }}>
        {/*
          `w-[98vw]` with a bare `max-w` override is not safe on a phone: dialog.tsx
          sets `max-w-[calc(100%-2rem)]` as the guard that keeps a dialog inside the
          viewport, and this line's max-width was applied unconditionally (no `sm:`),
          so on a narrow screen the width was capped by `98vw` (352px on a 360px
          phone) instead — under the 2rem margin the base rule reserves and tight
          enough that the PDF viewer and its toolbar had no room.
          The `min(...)` form keeps the desktop width at 1250px while never
          exceeding the viewport minus a 1rem margin on each side.
        */}
        <DialogContent className="h-[95vh] w-[min(1250px,calc(100vw-2rem))] !max-w-none p-0 overflow-hidden">
          <DialogHeader className="px-4 py-3 border-b bg-white">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <DialogTitle className="text-sm font-semibold">{admissionPdfTitle}</DialogTitle>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={handlePrintAdmissionSlip}>
                  <Printer className="w-4 h-4 mr-2" /> Print
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleDownloadAdmissionSlip}>
                  <FileText className="w-4 h-4 mr-2" /> Download
                </Button>
              </div>
            </div>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-auto bg-gray-100 p-4">
            {admissionPdfUrl ? (
              <div className="flex justify-center items-start min-w-max">
                <PdfDocument
                  file={admissionPdfUrl}
                  loading={<div className="py-10 text-sm text-gray-400">Loading Admission Slip...</div>}
                  error={<div className="py-10 text-sm text-red-500">Unable to display the Admission Slip PDF.</div>}
                >
                  <PdfPage
                    pageNumber={1}
                    width={1080}
                    renderAnnotationLayer={false}
                    renderTextLayer={false}
                  />
                </PdfDocument>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-gray-400">Loading Admission Slip...</div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isLogModalOpen} onOpenChange={setIsLogModalOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Log Incident</DialogTitle></DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-4">
            <div className="space-y-2 sm:col-span-2">
              <Label>Resident(s) *</Label>
              <div className="rounded-lg border border-gray-200 bg-white">
                <div className="border-b border-gray-100 p-2">
                  <Input value={incidentResidentSearch} onChange={e => setIncidentResidentSearch(e.target.value)} placeholder="Search residents..." className="h-9 text-sm" />
                </div>
                <div className="max-h-44 overflow-y-auto p-2">
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {children.filter(c => c.status !== 'Discharged' && c.status !== 'Absconded' && c.name.toLowerCase().includes(incidentResidentSearch.toLowerCase())).map(c => {
                      const checked = selectedIncidentResidentIds.includes(c.id);
                      return <label key={c.id} className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs transition-colors ${checked ? 'border-[#2F3E46] bg-gray-50' : 'border-transparent hover:bg-gray-50'}`}><input type="checkbox" checked={checked} onChange={() => setSelectedIncidentResidentIds(prev => checked ? prev.filter(x => x !== c.id) : [...prev, c.id])} className="mt-0.5 h-4 w-4 accent-[#2F3E46]" /><span className="min-w-0"><span className="block font-semibold text-[#2F3E46] break-words">{c.name}</span><span className="block text-[10px] text-gray-400">{c.id}{c.id === child.id ? ' · current resident' : ''}</span></span></label>;
                    })}
                  </div>
                </div>
                <div className="border-t border-gray-100 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">{selectedIncidentResidentIds.length} resident{selectedIncidentResidentIds.length === 1 ? '' : 's'} selected</div>
              </div>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Incident Type *</Label>
              <Select value={formData.type} onValueChange={(value) => { const selected = violationGuides.find(guide => guide.name === value); if (selected) setFormData(prev => ({ ...prev, type: selected.name, severity: selected.category })); }}>
                <SelectTrigger className="w-full h-auto min-h-10 py-2 pr-10 text-left items-start whitespace-normal [&_[data-slot=select-value]]:line-clamp-none [&_[data-slot=select-value]]:whitespace-normal [&_[data-slot=select-value]]:break-words [&_[data-slot=select-value]]:leading-5 [&_[data-slot=select-value]]:flex-wrap [&_[data-slot=select-value]]:min-w-0"><SelectValue placeholder="Select incident type..." /></SelectTrigger>
                <SelectContent className="max-h-80 min-w-[var(--radix-select-trigger-width)] w-[min(640px,calc(100vw-3rem))]">
                  <div className="sticky top-0 z-10 bg-white p-2 border-b" onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}><Input autoFocus value={violationTypeSearch} onChange={e => setViolationTypeSearch(e.target.value)} placeholder="Search violation type..." className="h-8 text-xs" /></div>
                  {(['Major', 'Minor'] as const).map(category => {
                    const matches = violationGuides.filter(g => g.category === category && g.name.toLowerCase().includes(violationTypeSearch.toLowerCase()));
                    if (!matches.length) return null;
                    return <div key={category}><div className="px-2 py-1 text-[10px] font-black uppercase tracking-wider border-b text-gray-500">{category} Offenses</div>{matches.map(guide => <SelectItem key={guide.id} value={guide.name} className="h-auto py-2"><span className="block whitespace-normal break-words leading-5 text-sm">{guide.name}</span></SelectItem>)}</div>;
                  })}
                </SelectContent>
              </Select>
              {formData.type && <div className={`inline-flex w-fit items-center px-3 py-1.5 rounded-lg text-xs font-semibold ${formData.severity === 'Major' ? 'bg-orange-50 text-orange-700 border border-orange-200' : 'bg-yellow-50 text-yellow-700 border border-yellow-200'}`}>{formData.severity}</div>}
            </div>
            <div className="space-y-2 sm:col-span-2"><Label>Date and Time of Incident *</Label><Input type="datetime-local" value={incidentDateTime} onChange={e => setIncidentDateTime(e.target.value)} /></div>
            <div className="space-y-2 sm:col-span-2"><Label>Note (optional)</Label><Textarea value={formData.note} onChange={e => setFormData(prev => ({ ...prev, note: e.target.value }))} placeholder="Add any relevant note about this incident..." rows={3} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setIsLogModalOpen(false)}>Cancel</Button><Button onClick={handleAddLog} disabled={!formData.type || selectedIncidentResidentIds.length === 0 || incidentCreating} className="bg-[#2F3E46] text-white">{incidentCreating ? 'Logging...' : 'Log Incident'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <IncidentReportModal
        open={isIncidentReportOpen}
        onOpenChange={setIsIncidentReportOpen}
        mode="create"
        violationId={activeIncidentViolationId}
        residentId={activeIncidentResidentIds[0] || child?.id}
        residentIds={activeIncidentResidentIds}
        violationIds={activeIncidentViolationIds}
        residentName={activeIncidentResidentIds.length > 1 ? `${activeIncidentResidentIds.length} residents` : child?.name}
        currentUsername={user?.username}
        initialIncidentDateTime={incidentDateTime}
        onSaved={() => { setTimeout(() => refreshData(), 300); }}
      />
    </div>
  );
}
