import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSubModuleTab } from '@/app/hooks/useSubModuleTab';
import { useSubModuleTabs } from '@/app/hooks/useSubModuleTabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Badge } from '@/app/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Textarea } from '@/app/components/ui/textarea';
import { Checkbox } from '@/app/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/app/components/ui/alert-dialog';
import { Search, Plus, Eye, ShieldAlert, AlertTriangle, AlertCircle, User, Check } from 'lucide-react';
import { useData, Violation } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { usePermissions } from '@/app/hooks/usePermissions';
import { formatShortDate } from '@/utils/dateFormatter';
import { describeError, request } from '@/services/api';
import { systemDialog } from '@/app/components/SystemDialog';
import ViolationGuide from './ViolationGuide';
import IncidentReportModal from './IncidentReportModal';
import { InterventionTracker } from './InterventionTracker';

const SEVERITY_OPTIONS = [
  { value: 'Minor', label: 'Minor' },
  { value: 'Major', label: 'Major' },
];

interface ViolationItem {
  id: string;
  category: 'Major' | 'Minor';
  severity: 'Minor' | 'Major';
  label: string;
  tagalog?: string;
  intervention?: string;
  assessor?: string;
  assessmentType?: string;
  interventions?: any[];
}

const guideToViolationMatrix = (guides: any[] = []): ViolationItem[] =>
  guides
    .filter((guide) => guide && guide.name && guide.status !== 'Inactive' && (guide.category === 'Minor' || guide.category === 'Major'))
    .map((guide, index) => {
      const rawInterventions = Array.isArray(guide.interventions)
        ? guide.interventions
        : Object.values(guide.interventions || {}).flat();
      const interventionText = rawInterventions
        .map((item: any) => {
          const type = item?.interventionType || item?.type || '';
          const customText = item?.metadata?.officialText || item?.metadata?.customType || item?.customType || null;
          if (customText) return customText;
          return type;
        })
        .filter(Boolean)
        .join('\n');
      return {
        id: guide.id || `guide-${index}`,
        category: guide.category === 'Major' ? 'Major' : 'Minor',
        severity: guide.category === 'Major' ? 'Major' : 'Minor',
        label: guide.name,
        tagalog: guide.description || '',
        intervention: interventionText,
        assessor: 'Social Worker',
        assessmentType: 'Behavioral Assessment',
        interventions: rawInterventions,
      };
    });

// Matches the backend's LOWER(TRIM()) guide lookup exactly — a strict
// (non-normalized) string comparison here was silently failing to find the
// guide whenever there was any stray whitespace or casing difference,
// making the frontend show "No intervention configured" for violations that
// actually did have one, while the backend's own (correctly normalized)
// lookup at verify-time found it — causing the exact "works on the backend,
// not shown in the UI" contradiction.
const normalizeLabel = (s: string) => String(s || '').trim().toLowerCase();

// Normalize incident dates from the API/UI into YYYY-MM so the Incident Month
// filter works with ISO dates as well as common slash-formatted dates.
const toMonthKey = (value: string | undefined | null) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, '0')}`;
  const slash = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (slash) {
    const [, a, b, year] = slash;
    const first = Number(a);
    const second = Number(b);
    const month = first > 12 ? second : first;
    return `${year}-${String(month).padStart(2, '0')}`;
  }
  return raw.slice(0, 7);
};
const findGuideByLabel = (matrix: ViolationItem[], label: string) =>
  matrix.find((item) => normalizeLabel(item.label) === normalizeLabel(label));

/**
 * The intervention types that have to be scheduled before a violation can be
 * verified. Must stay identical to `isSchedulingInterventionType()` in
 * `backend/src/controllers/violationController.js`.
 *
 * The rule is about the intervention's *type*, never about what its description
 * happens to say. Deciding it by scanning the free text was the bug: a
 * "Dialogue/Counseling" requirement whose description read "Counseling session
 * with the resident" never used the word "dialogue", so the Schedule field was
 * never rendered — while the API, which reads the type, refused the review with
 * "A schedule date and time is required for this intervention." The reviewer was
 * shown an error with no field to answer it.
 *
 * The mirror-image case is just as wrong: a "Household Chores" requirement whose
 * description mentioned a dialogue used to demand a schedule the API never
 * wanted.
 */
const SCHEDULING_INTERVENTION_TYPES = [
  'psychosocial activity',
  'dialogue / counseling',
  'dialogue/counseling',
];

/** The stored type of an intervention row, normalised the way the API does. */
const normalizeInterventionType = (row: any) =>
  String(row?.interventionType ?? row?.type ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const interventionNeedsSchedule = (row: any) =>
  SCHEDULING_INTERVENTION_TYPES.includes(normalizeInterventionType(row));

const interventionIsPsychosocial = (row: any) =>
  normalizeInterventionType(row) === 'psychosocial activity';

/**
 * What to *show* for an intervention.
 *
 * Deliberately separate from the two predicates above: the guide's own wording
 * is what a reviewer needs to read, and it is not a reliable signal for what the
 * intervention is. The two were the same expression, which is how a description
 * containing the word "dialogue" came to decide whether a schedule was needed.
 */
const interventionDisplayText = (row: any) =>
  row?.officialText ||
  row?.metadata?.officialText ||
  row?.metadata?.rawText ||
  row?.interventionType ||
  'Unspecified';

export function Violations() {
  const navigate = useNavigate();
  const { children, staff, violations, updateViolation, deleteViolation, refreshData, addAssessment } = useData();
  const { user } = useAuth();
  const { can } = usePermissions();
  const isSocialWorker = ['socialworker', 'centerhead', 'admin'].includes(user?.role?.toLowerCase() || '');
  const isCenterHead = user?.role === 'centerhead';

  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterSeverity, setFilterSeverity] = useState('all');
  const [violationMonthFilter, setViolationMonthFilter] = useState('');
  const [verificationSearchTerm, setVerificationSearchTerm] = useState('');
  const [verificationSeverity, setVerificationSeverity] = useState('all');
  const [incidentTypeSearch, setIncidentTypeSearch] = useState('');
  const [residentSearch, setResidentSearch] = useState('');
  const [selectedResidentIds, setSelectedResidentIds] = useState<string[]>([]);

  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isIncidentReportOpen, setIsIncidentReportOpen] = useState(false);
  const [incidentReportMode, setIncidentReportMode] = useState<'create' | 'view'>('create');
  const [activeIncidentViolationId, setActiveIncidentViolationId] = useState<string | null>(null);
  const [activeIncidentResidentId, setActiveIncidentResidentId] = useState<string>('');
  const [activeIncidentResidentIds, setActiveIncidentResidentIds] = useState<string[]>([]);
  const [activeIncidentViolationIds, setActiveIncidentViolationIds] = useState<string[]>([]);
  const localDateTimeInput = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const [incidentDateTime, setIncidentDateTime] = useState(localDateTimeInput());
  const [creatingIncident, setCreatingIncident] = useState(false);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isReviewDialogOpen, setIsReviewDialogOpen] = useState(false);

  const [selectedViolation, setSelectedViolation] = useState<Violation | null>(null);
  const [viewRequirements, setViewRequirements] = useState<{ offenseLevel: string; interventions: any[] } | null>(null);
  const [violationToDelete, setViolationToDelete] = useState<Violation | null>(null);


  const [reviewForm, setReviewForm] = useState({ severity: 'Minor' as 'Minor' | 'Major', actionTaken: '', status: 'Reviewed' as string, offenseNumber: '', interventionType: '', psychosocialActivities: [] as string[], scheduleDateTime: '' });
  // Which decision (if any) is currently in flight. Doubles as the dialog's
  // loading flag and drives the per-button "Saving…" label.
  const [reviewPending, setReviewPending] = useState<'verify' | 'reject' | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [reviewSuccess, setReviewSuccess] = useState('');
  const [reviewRequirements, setReviewRequirements] = useState<{
    guide: { id: string; name: string; category: string; status: string };
    offenseLevel: string;
    interventions: any[];
  } | null>(null);
  const isReviewSubmitting = reviewPending !== null;
  const PSYCHOSOCIAL_OPTIONS = ['SSCT', 'Mental Health Questionnaire', 'MBTI Personality Type Test', 'CANS Assessment', 'Dialogue/Counseling Form', 'Other'];

  // Body parts offered when the violation is a body-marking one.
  //
  // The violation type itself is editable in Manage Violations & Interventions,
  // so it is matched by keyword rather than by exact label — the same approach
  // `triController` uses to score this violation. A re-worded or Tagalog-only
  // label still gets the dropdown.
  const BODY_LOCATIONS = [
    'Head', 'Face', 'Neck', 'Ear', 'Nose', 'Eyebrow', 'Tongue',
    'Chest', 'Back', 'Abdomen', 'Navel',
    'Upper Arm', 'Forearm', 'Hand', 'Finger',
    'Thigh', 'Leg', 'Foot', 'Other',
  ];
  const isBodyMarkingViolation = (label: string) => /tattoo|tattat|piercing|bulitas|hikaw/i.test(label || '');

  const staffNames = staff.filter(s => s.status === 'Active').map(s => s.name);

  const defaultReportedBy = user?.username || '';

  const [formData, setFormData] = useState({
    residentId: '',
    date: new Date().toISOString().split('T')[0],
    type: '',
    description: '',
    note: '',
    severity: 'Minor' as 'Minor' | 'Major',
    location: '',
    bodyLocation: '',
    witnesses: '',
    reportedBy: defaultReportedBy,
    actionTaken: '',
    status: 'Pending Review' as 'Pending Review' | 'Under Investigation' | 'Reviewed' | 'Resolved' | 'Escalated',
    offenseNumber: '1st Offense' as '1st Offense' | '2nd Offense' | '3rd Offense' | '4th Offense+',
    interventionStartDate: new Date().toISOString().split('T')[0],
    interventionMonth: new Date().toISOString().substring(0, 7),
  });
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearingMonth, setClearingMonth] = useState(new Date().toISOString().substring(0, 7));
  // The tabs are the module's own submenus as the RBAC definition declares them,
  // so a role sees exactly the tabs it holds. `?tab=<key>` is still a deep link
  // (the Intervention Tracker redirect and notifications both use it), and a
  // link to a tab the account may not open falls back to the first reachable one.
  //
  // The strip used to be hand-written — `[list, interventions, verification]`
  // plus a `manage` tab gated on `isCenterHead`, plus a separate hardcoded pair
  // for the Houseparent. That withheld "Manage Violations & Interventions" from
  // the Social Worker and the Psychological Staff even though the guide's own write
  // routes authorize both, and it meant removing a role's access needed a UI
  // edit as well as a matrix edit. The Houseparent branch was worse: it listed
  // only Intervention Tracker and Anecdotal Reports, so "Violation List" — which
  // the Houseparent specification grants — had no tab at all.
  //
  // "Anecdotal Reports" is declared under Violations for the full-access roles,
  // but its panel belongs to the Houseparent module and the Reports module, so
  // it stays out of this strip for everyone. The Houseparent reaches it through
  // the Houseparent module's own tab.
  const definitionTabs = useSubModuleTabs('Violations');
  const tabs = useMemo(
    () => definitionTabs.filter((tab) => tab.key !== 'anecdotal'),
    [definitionTabs],
  );
  const tabKeys = useMemo(() => tabs.map((tab) => tab.key), [tabs]);
  const [activeTab, setActiveTab] = useSubModuleTab(tabKeys, tabs[0]?.key);

  // The DB-backed ViolationGuide component is the source of truth. activeMatrix is read-only here and is used only by the incident logger.
  const [activeMatrix, setActiveMatrix] = useState<ViolationItem[]>([]);
  // `actionMenuOpen` used to live here. It drove a per-row action dropdown that
  // no longer exists — the state was still declared, and the `overflow-visible`
  // wrapper on the Violation List table was still justified by it, long after
  // the dropdown was removed. That stale constraint is what kept the table from
  // scrolling on a phone. Removed with the wrapper.

  // Returns the freshly-fetched matrix directly (not just via state) because
  // setActiveMatrix() doesn't apply synchronously — callers that need the
  // data immediately after calling this (like opening the verification
  // review) would otherwise still see the stale closure value on this same
  // tick, even after awaiting this function.
  const loadGuideMatrix = async (): Promise<ViolationItem[] | null> => {
    try {
      const response = await request<{
        success: boolean;
        data: any[];
      }>('/violation-guide', {
        method: 'GET',
      });

      if (!response?.success) {
        setActiveMatrix([]);
        return null;
      }

      const mapped = guideToViolationMatrix(response.data || []);
      setActiveMatrix(mapped);

      return mapped;
    } catch (error) {
      console.error(
        'Failed to load Manage Violations & Interventions:',
        error
      );
      setActiveMatrix([]);
      return null;
    }
  };

  useEffect(() => {
    loadGuideMatrix();
  }, []);

  const currentMonthKey = new Date().toISOString().slice(0, 7);
  const getDisplayStatus = (violation: Violation) => {
    if (violation.status === 'Resolved') return 'Resolved';
    const interventionMonth = String((violation as any).interventionMonth || violation.date || '').slice(0, 7);
    if (violation.status === 'Escalated' || (interventionMonth && interventionMonth < currentMonthKey && violation.status !== 'Pending Review' && violation.status !== 'Rejected')) {
      return 'Overdue';
    }
    if (violation.status === 'Reviewed' || violation.status === 'Under Investigation') return 'Reviewed';
    return violation.status;
  };

  const filteredViolations = violations.filter((v) => !['Pending Review', 'Rejected'].includes(v.status)).filter((v) => {
    const resident = children.find((c) => c.id === v.residentId);
    const residentName = resident?.name || '';
    const query = searchTerm.trim().toLowerCase();
    const matchesSearch =
      !query ||
      residentName.toLowerCase().includes(query) ||
      (v.type || '').toLowerCase().includes(query) ||
      v.id.toLowerCase().includes(query);
    const displayStatus = getDisplayStatus(v);
    const matchesStatus = filterStatus === 'all' || displayStatus === filterStatus;
    const matchesSeverity = filterSeverity === 'all' || v.severity === filterSeverity;
    const matchesMonth = !violationMonthFilter || toMonthKey(v.date) === violationMonthFilter;
    return matchesSearch && matchesStatus && matchesSeverity && matchesMonth;
  });

  const rejectedForReporter = violations.filter((v) =>
    v.status === 'Rejected' &&
    String(v.reportedBy || '').trim().toLowerCase() === String(user?.username || '').trim().toLowerCase()
  );

  // Newly logged violations are the records awaiting Psychological Staff verification.
  // Form 08 is deliberately excluded from this queue because it is a post-intervention
  // report and only becomes available after the intervention is marked Done.
  const forVerificationList = violations
    .filter((v) => v.status === 'Pending Review')
    .filter((v) => {
      const resident = children.find((c) => c.id === v.residentId);
      const residentName = resident?.name || '';
      const query = verificationSearchTerm.trim().toLowerCase();
      const matchesSearch =
        !query ||
        residentName.toLowerCase().includes(query) ||
        (v.type || '').toLowerCase().includes(query) ||
        v.id.toLowerCase().includes(query);
      const matchesSeverity = verificationSeverity === 'all' || v.severity === verificationSeverity;
      return matchesSearch && matchesSeverity;
    });

  const handleSeverityChange = (severity: 'Minor' | 'Major') => {
    setFormData(prev => ({ ...prev, severity }));
  };

  const resetForm = () => {
    setFormData({
      residentId: '',
      date: new Date().toISOString().split('T')[0],
      type: '',
      description: '',
      note: '',
      severity: 'Minor',
      location: '',
      bodyLocation: '',
      witnesses: '',
      reportedBy: user?.username || '',
      actionTaken: '',
      status: 'Pending Review',
      offenseNumber: '1st Offense',
      interventionStartDate: new Date().toISOString().split('T')[0],
      interventionMonth: new Date().toISOString().substring(0, 7),
    });
    setSelectedResidentIds([]);
    setResidentSearch('');
    setIncidentTypeSearch('');
    setIncidentDateTime(localDateTimeInput());
  };

  // Determine offense number within the calendar month of the new incident.
  // Each new month starts a fresh 1st/2nd/3rd+ sequence for that specific
  // violation. Pending/rejected records do not count as completed offenses.
  const getAutoOffenseNumber = (residentId: string): '1st Offense' | '2nd Offense' | '3rd Offense' | '4th Offense+' => {
    const monthKey = toMonthKey(incidentDateTime?.slice(0, 10)) || new Date().toISOString().slice(0, 7);
    const eligible = violations.filter(v =>
      v.residentId === residentId &&
      !['Pending Review', 'Rejected'].includes(v.status) &&
      toMonthKey(v.date) === monthKey
    );
    const sameType = formData.type
      ? eligible.filter(v => v.type === formData.type).length
      : eligible.length;
    if (sameType === 0) return '1st Offense';
    if (sameType === 1) return '2nd Offense';
    if (sameType === 2) return '3rd Offense';
    return '4th Offense+';
  };

  // Clear interventions for a month (Social Worker only)
  const handleClearMonth = async () => {
    const toResolve = violations.filter(v => {
      const vm = ((v as any).interventionMonth || v.date?.substring(0, 7) || '');
      return vm === clearingMonth && v.status !== 'Resolved';
    });
    for (const v of toResolve) {
      await updateViolation(v.id, {
        status: 'Resolved',
        clearedBy: user?.username || 'Social Worker',
        clearedAt: new Date().toISOString(),
      } as any);
    }
    setShowClearConfirm(false);
    void systemDialog.success(
      'Interventions cleared.',
      `${toResolve.length} intervention${toResolve.length === 1 ? '' : 's'} for ${clearingMonth} ${toResolve.length === 1 ? 'was' : 'were'} marked Resolved.`,
    );
  };

  const toggleResidentSelection = (residentId: string) => {
    setSelectedResidentIds((previous) => {
      const next = previous.includes(residentId)
        ? previous.filter((id) => id !== residentId)
        : [...previous, residentId];
      setFormData((current) => ({
        ...current,
        residentId: next[0] || '',
        offenseNumber: next[0] ? getAutoOffenseNumber(next[0]) : '1st Offense',
      }));
      return next;
    });
  };

  const filteredResidentChoices = children.filter((child) =>
    child.name.toLowerCase().includes(residentSearch.trim().toLowerCase()) ||
    child.id.toLowerCase().includes(residentSearch.trim().toLowerCase())
  );

  // Creates the underlying violation record only. Form 08 is available later,
  // after the intervention workflow is completed.
  const handleLogIncident = async () => {
    const residentIds = selectedResidentIds.length > 0
      ? selectedResidentIds
      : formData.residentId
        ? [formData.residentId]
        : [];

    if (residentIds.length === 0 || !formData.type) return;

    const selectedGuide = findGuideByLabel(activeMatrix, formData.type);
    if (!selectedGuide) {
      void systemDialog.validation('That violation is no longer active', {
        description: 'It was changed or deactivated in Manage Violations & Interventions. Pick a current one.',
      });
      setFormData((prev) => ({ ...prev, type: '' }));
      return;
    }

    setCreatingIncident(true);
    try {
      // New interventions/violations are independent. An unresolved intervention
      // must never block creation of another violation for the same resident.
      const createdIds: string[] = [];
      const createdResidentIds: string[] = [];
      const incidentGroupId = residentIds.length > 1 ? `INC-GRP-${Date.now()}` : undefined;

      for (const residentId of residentIds) {
        const offenseNumber = getAutoOffenseNumber(residentId);
        const response = await request<{ success: boolean; data?: Violation; message?: string }>(
          '/violations',
          {
            method: 'POST',
            body: JSON.stringify({
              residentId,
              date: incidentDateTime.slice(0, 10),
              type: formData.type,
              description: formData.note || null,
              severity: formData.severity,
              location: formData.location,
              // Only a body-marking violation carries a body part. Every other
              // type sends null rather than a stale value left over from a
              // previous selection.
              bodyLocation: isBodyMarkingViolation(formData.type) ? (formData.bodyLocation || null) : null,
              witnesses: formData.witnesses,
              reportedBy: formData.reportedBy,
              actionTaken: formData.actionTaken,
              status: 'Pending Review',
              requiresAssessment: true,
              assessmentTriggered: false,
              offenseNumber,
              interventionStartDate: formData.interventionStartDate,
              interventionMonth: formData.interventionMonth,
              incidentGroupId,
            }),
          }
        );

        if (!response?.success || !response.data?.id) {
          throw new Error(`Unable to create incident for ${residentId}.`);
        }

        createdIds.push(response.data.id);
        createdResidentIds.push(residentId);
      }

      setIsAddDialogOpen(false);
      resetForm();
      await refreshData();
    } catch (error) {
      void systemDialog.failure('Could not log the incident', describeError(error, 'The incident was not logged. Please try again.'));
    } finally {
      setCreatingIncident(false);
    }
  };

  // Opens the digital Incident Report (read-only, with Verify for Psychological Staff/Center Head)
  // for an existing violation record.
  const openIncidentReportView = async (violation: Violation) => {
    // Form 08 is isolated to this exact violation/resident. It is available
    // after all requirements are complete and before the final Mark Done.
    try {
      const response: any = await request(`/incident-reports/violation/${violation.id}`, { method: 'GET' });
      if (!response?.success || !response.data) {
        const tracker: any = await request(`/violation-guide/resident/${violation.residentId}/interventions`, { method: 'GET' });
        const rows = Array.isArray(tracker?.data) ? tracker.data.filter((r: any) => r.violationId === violation.id) : [];
        const allComplete = rows.length > 0 && rows.every((r: any) => r.status === 'Completed');
        if (!allComplete) {
          void systemDialog.validation('Form 08 is not available yet', {
            description: 'Every requirement configured for this specific violation has to be completed before the Incident Report can be opened.',
          });
          return;
        }
      }
      setActiveIncidentViolationId(violation.id);
      setActiveIncidentResidentId(violation.residentId);
      setActiveIncidentResidentIds([violation.residentId]);
      setActiveIncidentViolationIds([violation.id]);
      setIncidentReportMode(response?.success && response.data ? 'view' : 'create');
      setIsIncidentReportOpen(true);
    } catch (error) {
      void systemDialog.failure('Could not open the Incident Report', describeError(error, 'The Incident Report could not be opened. Please try again.'));
    }
  };


  const openVerificationReview = async (violation: Violation) => {
    // The backend is the source of truth for verification. It resolves the
    // violation -> guide -> guide_interventions relationship and returns the
    // exact configured intervention rows (including their IDs). The frontend
    // only displays those rows and never invents an intervention.
    try {
      setReviewError('');
      setReviewSuccess('');
      setReviewRequirements(null);
      const response = await request<{
        success: boolean;
        data?: {
          violation: Violation & { guideId?: string };
          guide: { id: string; name: string; category: string; status: string };
          offenseLevel: string;
          interventions: any[];
        };
        message?: string;
      }>(`/violations/${violation.id}/review-preview`, { method: 'GET' });

      if (!response?.success || !response.data) {
        throw new Error(response?.message || 'Unable to retrieve the prescribed intervention.');
      }

      const { offenseLevel, interventions, guide } = response.data;
      if (!interventions?.length) {
        throw new Error('No prescribed intervention is configured for this violation.');
      }

      setSelectedViolation(violation);
      setReviewRequirements({ guide, offenseLevel, interventions });
      setReviewForm({
        severity: violation.severity === 'Major' ? 'Major' : 'Minor',
        actionTaken: '',
        status: 'Reviewed',
        offenseNumber: `${offenseLevel === '3rd' ? '3rd Offense+' : offenseLevel + ' Offense'}`,
        interventionType: interventions
          .map((r: any) => r.officialText || r.metadata?.officialText || r.metadata?.rawText || r.interventionType)
          .join('; '),
        psychosocialActivities: [],
        scheduleDateTime: '',
      });
      setReviewPending(null);
      setIsReviewDialogOpen(true);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Unable to retrieve the prescribed intervention.');
      setSelectedViolation(violation);
      setIsReviewDialogOpen(true);
    }
  };

  const togglePsychosocialActivity = (value: string) => setReviewForm((prev) => ({ ...prev, psychosocialActivities: prev.psychosocialActivities.includes(value) ? prev.psychosocialActivities.filter((x) => x !== value) : [...prev.psychosocialActivities, value] }));

  const handleReview = async (decision: 'verify' | 'reject' = 'verify') => {
    if (!selectedViolation || isReviewSubmitting) return;
    const req = reviewRequirements;
    if (decision === 'verify' && !req) {
      setReviewError('The prescribed intervention could not be retrieved from Manage Violations & Interventions.');
      return;
    }
    // Notes come from the Review Notes field in the dialog itself. They used to
    // be collected through window.prompt(), which is why there was no visible
    // notes UI and why a failed submit lost whatever the reviewer had typed.
    const notes = reviewForm.actionTaken.trim();
    setReviewError('');
    setReviewSuccess('');
    // Validate before the request so a missing field sends the person straight
    // back to it, instead of costing a round-trip and surfacing a server error.
    // Judged on the intervention's type, exactly as the API judges it, so the
    // field this insists on is a field the dialog actually rendered.
    const requirementNeedsSchedule = Boolean(req?.interventions?.some(interventionNeedsSchedule));
    const requirementIsPsychosocial = Boolean(req?.interventions?.some(interventionIsPsychosocial));
    if (decision === 'verify' && requirementNeedsSchedule && !reviewForm.scheduleDateTime) {
      setReviewError('Please set the Schedule Date and Time for this intervention before verifying.');
      return;
    }
    if (decision === 'verify' && requirementIsPsychosocial && reviewForm.psychosocialActivities.length === 0) {
      setReviewError('Please select at least one Psychosocial Activity before verifying.');
      return;
    }
    if (decision === 'reject' && !notes) {
      setReviewError('Please enter a reason in Review Notes before rejecting.');
      return;
    }
    setReviewPending(decision);
    try {
      await request(`/violations/${selectedViolation.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ status: decision === 'reject' ? 'Rejected' : 'Reviewed', actionTaken: notes || null, scheduleDateTime: requirementNeedsSchedule ? reviewForm.scheduleDateTime : null, psychosocialActivities: requirementIsPsychosocial ? reviewForm.psychosocialActivities : [] }),
      });
      // Confirm the outcome in the dialog before it closes — previously it
      // vanished silently, so a success was indistinguishable from a no-op.
      setReviewSuccess(decision === 'reject'
        ? 'Violation rejected. Your review notes were saved.'
        : 'Violation verified. Interventions were assigned and your review notes were saved.');
      await refreshData();
      setTimeout(() => { setIsReviewDialogOpen(false); setSelectedViolation(null); }, 1200);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Unable to complete review.');
    } finally {
      setReviewPending(null);
    }
  };

  const handleUpdate = async () => {
    if (!selectedViolation) return;
    const selectedGuide = findGuideByLabel(activeMatrix, formData.type);
    if (!selectedGuide) {
      void systemDialog.validation('That violation is no longer active', {
        description: 'It was changed or deactivated in Manage Violations & Interventions. Pick a current one.',
      });
      return;
    }
    await updateViolation(selectedViolation.id, {
      ...formData,
      severity: selectedGuide.severity,
    });
    setIsEditDialogOpen(false);
    setSelectedViolation(null);
    setTimeout(() => refreshData(), 300);
  };

  const handleDelete = async () => {
    if (!violationToDelete) return;
    await deleteViolation(violationToDelete.id);
    setIsDeleteDialogOpen(false);
    setViolationToDelete(null);
  };

  const openViewDialog = async (violation: Violation) => {
    setSelectedViolation(violation);
    setViewRequirements(null);
    setIsViewDialogOpen(true);
    try {
      const response = await request<{
        success: boolean;
        data?: { offenseLevel: string; interventions: any[] };
      }>(`/violations/${violation.id}/review-preview`, { method: 'GET' });
      if (response?.success && response.data) {
        setViewRequirements({
          offenseLevel: response.data.offenseLevel,
          interventions: Array.isArray(response.data.interventions) ? response.data.interventions : [],
        });
      }
    } catch (error) {
      console.error('Failed to load prescribed interventions for violation:', error);
    }
  };

  const openEditDialog = (violation: Violation) => {
    setSelectedViolation(violation);

    setFormData({
      residentId: violation.residentId,
      date: violation.date,
      type: violation.type,
      description: violation.description || '',
      note: violation.description || '',
      severity: violation.severity === 'Major' ? 'Major' : 'Minor',
      location: violation.location || '',
      bodyLocation: (violation as any).bodyLocation || '',
      witnesses: violation.witnesses || '',
      reportedBy: violation.reportedBy || '',
      actionTaken: violation.actionTaken || '',
      status: violation.status as any,
      offenseNumber: (violation as any).offenseNumber || '1st Offense',
      interventionStartDate:
        (violation as any).interventionStartDate ||
        violation.date ||
        new Date().toISOString().split('T')[0],
      interventionMonth:
        (violation as any).interventionMonth ||
        violation.date?.substring(0, 7) ||
        new Date().toISOString().substring(0, 7),
    });

    setIsEditDialogOpen(true);
  };

  const openDeleteDialog = (violation: Violation) => {
    setViolationToDelete(violation);
    setIsDeleteDialogOpen(true);
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
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



  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-[#2F3E46]">Incident Records</h2>
          <p className="text-gray-600">Track resident infractions and behavioral incidents</p>
        </div>
        {/* Logging an incident is a `create` capability on Violations. The
            Psychological Staff's specification withholds it: they verify incidents,
            they do not raise them. The backend already refuses the call, so the
            button is removed rather than left to fail. */}
        {can('Violations', 'create') && (
        <Button
        className="flex items-center gap-2 bg-[#2F3E46]"
        onClick={async () => {
          const loaded = await loadGuideMatrix();
          if (loaded) {
            setIncidentDateTime(localDateTimeInput());
            setIncidentTypeSearch('');
            setResidentSearch('');
            setSelectedResidentIds([]);
            setFormData(prev => ({ ...prev, note: '' }));
            setIsAddDialogOpen(true);
          } else {
            void systemDialog.failure('Could not load the active violations', 'Manage Violations & Interventions returned no usable list. Try again in a moment.');
          }
        }}
        >
          <Plus className="w-4 h-4" />
          <span>Log Incident</span>
        </Button>
        )}
      </div>

      {/* Tabs: List | Overall Performance */}
      {/* A tab needs its submenu *and* the capability behind it. Holding the tab
          is not the same as being allowed to act in it — the same rule the
          Documents module applies to its review queue. */}
      {/* The strip scrolls rather than overflowing the page. Five submodule tabs
          do not fit a phone: "Manage Violations & Interventions" alone ran past
          the right edge (measured at x=392 on a 390px viewport) and was
          unreachable, while the strip dragged the whole page sideways. */}
      <div className="flex items-center gap-1 border-b border-gray-200 mb-4 overflow-x-auto">
        {tabs.map(t => {
          if (t.key === 'verification' && !can('Violations', 'verify')) return null;
          if (t.key === 'manage' && !can('Violations', 'edit')) return null;
          return (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`shrink-0 whitespace-nowrap px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-all ${
              activeTab === t.key ? 'border-[#FFD100] text-[#2F3E46]' : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}>
            {t.label}
          </button>
          );
        })}

      </div>

      {/* Overall Performance Tab */}

      {/* ── INTERVENTION TRACKER TAB — now part of Violations ── */}
      {activeTab === 'interventions' && (
        <InterventionTracker embedded />
      )}

      {/* ── MANAGE VIOLATIONS TAB ── */}
      {/* Rendered whenever the tab is reachable, not on a role name: the guide's
          write routes authorize the Social Worker and the Psychological Staff too, so a
          tab that appeared for the Center Head alone was hiding a feature those
          roles already had. */}
      {activeTab === 'manage' && (
        <div>
          <ViolationGuide />
        </div>
      )}
      {/* Violation List Tab — Table Format */}
      {activeTab === 'list' && (
        <>
          {rejectedForReporter.length > 0 && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-red-800">Violation report(s) rejected</p>
                  <div className="mt-2 space-y-2">
                    {rejectedForReporter.map((violation) => (
                      <div key={violation.id} className="rounded-lg border border-red-100 bg-white px-3 py-2">
                        <p className="text-sm font-semibold text-[#2F3E46]">{violation.type}</p>
                        <p className="mt-0.5 text-xs text-red-700">Reason: {violation.actionTaken || 'No rejection reason was recorded.'}</p>
                        {violation.reviewedBy && <p className="mt-0.5 text-[11px] text-gray-500">Reviewed by {violation.reviewedBy}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
          {(() => {
            const verifiedFiltered = filteredViolations;
            const verificationFiltered = violations.filter((v) => v.status === 'Pending Review').filter((v) => {
              const resident = children.find((c) => c.id === v.residentId);
              const residentName = resident?.name || '';
              const query = searchTerm.trim().toLowerCase();
              const matchesSearch = !query || residentName.toLowerCase().includes(query) || (v.type || '').toLowerCase().includes(query);
              const matchesSeverity = filterSeverity === 'all' || v.severity === filterSeverity;
              const matchesMonth = !violationMonthFilter || toMonthKey(v.date) === violationMonthFilter;
              return matchesSearch && matchesSeverity && matchesMonth;
            });
            const verifiedResidents = new Set(verifiedFiltered.map((v) => v.residentId)).size;
            return (
              <div className={`grid grid-cols-1 gap-4 mb-4 ${can('Violations', 'verify') ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <ShieldAlert className="w-8 h-8 text-red-500" />
                      <div>
                        <p className="text-sm text-gray-500">Total Violations</p>
                        <p className="text-2xl font-bold">{verifiedFiltered.length}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                {/* Verification is not a statistic every role may see. The
                    requirement is explicit for the Houseparent, and the rule is
                    about the capability rather than the role: the number and the
                    queue behind it belong to whoever holds `verify`. The API
                    withholds the rows themselves, so this only stops the tile
                    from advertising a queue the caller cannot open. */}
                {can('Violations', 'verify') && (
                  <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setActiveTab('verification')}>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <AlertTriangle className="w-8 h-8 text-orange-500" />
                        <div>
                          <p className="text-sm text-gray-500">For Verification</p>
                          <p className="text-2xl font-bold">{verificationFiltered.length}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <User className="w-8 h-8 text-blue-500" />
                      <div>
                        <p className="text-sm text-gray-500">Residents with Violations</p>
                        <p className="text-2xl font-bold">{verifiedResidents}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            );
          })()}
          <Card className="border border-gray-200 shadow-sm">
            <CardContent className="p-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_180px_180px_180px]">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <Input
                    placeholder="Search by resident name or violation type..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <Select value={filterStatus} onValueChange={setFilterStatus}>
                  <SelectTrigger><SelectValue placeholder="Filter by status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="Reviewed">Reviewed</SelectItem>
                    <SelectItem value="Resolved">Resolved</SelectItem>
                    <SelectItem value="Overdue">Overdue</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={filterSeverity} onValueChange={setFilterSeverity}>
                  <SelectTrigger><SelectValue placeholder="Filter by severity" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Severity</SelectItem>
                    <SelectItem value="Minor">Minor</SelectItem>
                    <SelectItem value="Major">Major</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <Label className="text-[11px] font-semibold text-gray-500">Incident Month</Label>
                    <Input
                      type="month"
                      value={violationMonthFilter}
                      onChange={(e) => setViolationMonthFilter(e.target.value)}
                      aria-label="Incident month"
                      className="min-w-0 w-full"
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
          <div className="mt-4">
          <Card className="border border-gray-200 shadow-sm">
            {filteredViolations.length === 0 ? (
              <CardContent className="p-12 text-center">
                <ShieldAlert className="w-12 h-12 mx-auto mb-4 text-gray-300" />
                <p className="text-gray-500">No violations found matching your criteria.</p>
              </CardContent>
            ) : (
              // Horizontal scroll, not compression.
              //
              // This was `overflow-visible` around a `table-fixed` table. The
              // seven columns declared more fixed width than a phone viewport
              // holds (`w-10` + `w-[28%]` + 4 × `w-24`), and `table-fixed`
              // resolves that by *shrinking* the over-committed columns — two of
              // them to 0px. With `px-4` on a 0px column the content box is
              // negative, so every header wrapped to one character per line and
              // the table grew to 288px tall. `overflow-visible` then removed any
              // chance of scrolling to the clipped columns.
              //
              // The `overflow-visible` was there so a per-row action dropdown
              // could escape the card. That dropdown no longer exists — the
              // `actionMenuOpen` state it served was declared and never rendered
              // — so the constraint is gone and the table can scroll inside its
              // own box like the other tables in this module.
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide w-10">#</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide w-[28%]">Incident Type</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Resident(s) Involved</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide w-24">Severity</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide w-24">Date</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide w-24">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide w-24">View</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredViolations.map((violation, idx) => {
                      const resident = children.find(c => c.id === violation.residentId);
                      return (
                        <tr key={violation.id} className={idx % 2 === 0 ? 'bg-white hover:bg-gray-50' : 'bg-gray-50 hover:bg-gray-100'}>
                          <td className="px-4 py-3 text-gray-400 text-xs">{idx + 1}</td>
                          <td className="px-4 py-3 align-top">
                            <p className="text-xs text-[#2F3E46] font-medium leading-5 whitespace-normal break-words">{violation.type}</p>
                            {(violation as any).incidentGroupId && <span className="text-[10px] text-gray-400">Group: {(violation as any).incidentGroupId}</span>}
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-semibold text-[#2F3E46] text-xs">{resident?.name || '—'}</p>
                            {(violation as any).offenseNumber && (
                              <span className="text-[10px] text-gray-400">{(violation as any).offenseNumber}</span>
                            )}
                            {(violation as any).assessmentTriggered && (
                              <span className={`block text-[10px] font-semibold mt-0.5 ${
                                (violation as any).assessmentCompleted ? 'text-green-600' : 'text-amber-600'
                              }`}>
                                {(violation as any).assessmentCompleted ? '✓ Assessment done' : 'Assessment pending'}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                            violation.severity === 'Major'    ? 'bg-orange-100 text-orange-700' :
                                                                  'bg-yellow-100 text-yellow-700'
                            }`}>{violation.severity}</span>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">{formatShortDate(violation.date)}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              violation.status === 'Resolved' ? 'bg-green-100 text-green-700' :
                              violation.status === 'Reviewed' ? 'bg-blue-100 text-blue-700' :
                              violation.status === 'Under Investigation' ? 'bg-purple-100 text-purple-700' :
                              violation.status === 'Escalated' ? 'bg-red-100 text-red-700' :
                              'bg-amber-100 text-amber-700'
                            }`}>
                              {violation.status}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openViewDialog(violation)}
                              className="h-8 text-xs"
                            >
                              <Eye className="mr-1 h-3.5 w-3.5" /> View
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="px-4 py-2 bg-gray-50 border-t border-gray-200">
              <p className="text-xs text-gray-400">Showing 1 to {filteredViolations.length} of {filteredViolations.length} entries</p>
            </div>
          </Card>
          </div>
        </>
      )}

      {/* For Verification Tab — Violations awaiting Psychological Staff verification */}
      {activeTab === 'verification' && can('Violations', 'verify') && (
        <div>
          <Card className="border border-gray-200 shadow-sm">
            <CardContent className="p-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <Input
                    placeholder="Search resident or violation..."
                    value={verificationSearchTerm}
                    onChange={(e) => setVerificationSearchTerm(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <Select value={verificationSeverity} onValueChange={setVerificationSeverity}>
                  <SelectTrigger><SelectValue placeholder="Filter by severity" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Severity</SelectItem>
                    <SelectItem value="Minor">Minor</SelectItem>
                    <SelectItem value="Major">Major</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
          <Card className="mt-4 border border-gray-200 shadow-sm overflow-hidden">
            {forVerificationList.length === 0 ? (
              <CardContent className="p-12 text-center">
                <AlertTriangle className="w-12 h-12 mx-auto mb-4 text-gray-300" />
                <p className="text-gray-500">No violations awaiting Psychological Staff verification.</p>
              </CardContent>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide w-10">#</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Resident</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Incident Type</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide w-24">Date</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide w-40">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {forVerificationList.map((violation, idx) => {
                      const resident = children.find(c => c.id === violation.residentId);
                      return (
                        <tr key={violation.id} className={idx % 2 === 0 ? 'bg-white hover:bg-gray-50' : 'bg-gray-50 hover:bg-gray-100'}>
                          <td className="px-4 py-3 text-gray-400 text-xs">{idx + 1}</td>
                          <td className="px-4 py-3">
                            <p className="font-semibold text-[#2F3E46] text-xs">{resident?.name || '—'}</p>
                          </td>
                          <td className="px-4 py-3">
                            <p className="text-xs text-[#2F3E46] font-medium leading-tight">{violation.type}</p>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">{formatShortDate(violation.date)}</td>
                          <td className="px-4 py-3">
                            <Button
                              size="sm"
                              onClick={() => openVerificationReview(violation)}
                              className="bg-purple-600 hover:bg-purple-700 text-white text-xs h-7"
                            >
                              Review
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="px-4 py-2 bg-gray-50 border-t border-gray-200">
              <p className="text-xs text-gray-400">Showing {forVerificationList.length} violation{forVerificationList.length !== 1 ? 's' : ''} awaiting Psychological Staff verification</p>
            </div>
          </Card>
        </div>
      )}

      {/* Add Incident Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Log Incident</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Resident(s) *</Label>
              <div className="rounded-lg border border-gray-200 bg-white">
                <div className="border-b border-gray-100 p-2">
                  <Input value={residentSearch} onChange={(e) => setResidentSearch(e.target.value)} placeholder="Search residents..." className="h-9 text-sm" />
                </div>
                <div className="max-h-44 overflow-y-auto p-2">
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {filteredResidentChoices.map((child) => {
                      const checked = selectedResidentIds.includes(child.id);
                      return (
                        <label key={child.id} className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs transition-colors ${checked ? 'border-[#2F3E46] bg-gray-50' : 'border-transparent hover:bg-gray-50'}`}>
                          <input type="checkbox" checked={checked} onChange={() => toggleResidentSelection(child.id)} className="mt-0.5 h-4 w-4 accent-[#2F3E46]" />
                          <span className="min-w-0">
                            <span className="block font-semibold text-[#2F3E46] break-words">{child.name}</span>
                            <span className="block text-[10px] text-gray-400">{child.id}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className="border-t border-gray-100 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
                  {selectedResidentIds.length} resident{selectedResidentIds.length === 1 ? '' : 's'} selected
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Incident Type *</Label>
              <Select
                value={formData.type}
                onValueChange={(value) => {
                  const found = findGuideByLabel(activeMatrix, value);
                  if (found) {
                    setFormData(prev => ({
                      ...prev,
                      type: found.label,
                      severity: found.severity,
                      // Switching to a type that is not a body-marking one drops
                      // the body part, so it cannot be saved against a violation
                      // it does not describe.
                      bodyLocation: isBodyMarkingViolation(found.label) ? prev.bodyLocation : '',
                    }));
                  }
                }}
              >
                <SelectTrigger className="w-full !h-auto min-h-[92px] py-3 pr-10 text-left items-start whitespace-normal break-words leading-5">
                  <SelectValue className="whitespace-normal break-words leading-5 text-left" placeholder="Select incident type..." />
                </SelectTrigger>
                <SelectContent className="max-h-80 min-w-[var(--radix-select-trigger-width)] w-[min(640px,calc(100vw-3rem))]">
                  <div className="sticky top-0 z-10 bg-white p-2 border-b" onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                    <Input autoFocus value={incidentTypeSearch} onChange={e => setIncidentTypeSearch(e.target.value)} placeholder="Search violation type..." className="h-8 text-xs" />
                  </div>
                  {(['Major', 'Minor'] as const).map(category => {
                    const matches = activeMatrix.filter(g => g.category === category && g.label.toLowerCase().includes(incidentTypeSearch.toLowerCase()));
                    if (!matches.length) return null;
                    return <div key={category}>
                      <div className="px-2 py-1 text-[10px] font-black uppercase tracking-wider border-b text-gray-500">{category} Offenses</div>
                      {matches.map(guide => (
                        <SelectItem key={guide.id} value={guide.label} className="h-auto py-2">
                          <span className="block whitespace-normal break-words leading-5 text-sm">{guide.label}</span>
                        </SelectItem>
                      ))}
                    </div>;
                  })}
                </SelectContent>
              </Select>
              {formData.type && (
                <div className={`inline-flex w-fit items-center px-3 py-1.5 rounded-lg text-xs font-semibold ${formData.severity === 'Major' ? 'bg-orange-50 text-orange-700 border border-orange-200' : 'bg-yellow-50 text-yellow-700 border border-yellow-200'}`}>
                  {formData.severity}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Date and Time of Incident *</Label>
              <Input type="datetime-local" value={incidentDateTime} onChange={e => setIncidentDateTime(e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label>Note (optional)</Label>
              <Textarea value={formData.note} onChange={(e) => setFormData(prev => ({ ...prev, note: e.target.value }))} placeholder="Add any relevant note about this incident..." rows={3} />
            </div>

            {isBodyMarkingViolation(formData.type) && (
              <div className="space-y-2">
                <Label>Body Location</Label>
                <Select value={formData.bodyLocation} onValueChange={(part) => setFormData(prev => ({ ...prev, bodyLocation: part }))}>
                  <SelectTrigger aria-label="Body location"><SelectValue placeholder="Which part of the body?" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {BODY_LOCATIONS.map((part) => (
                      <SelectItem key={part} value={part}>{part}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsAddDialogOpen(false); resetForm(); }}>Cancel</Button>
            <Button onClick={handleLogIncident} disabled={(selectedResidentIds.length === 0 && !formData.residentId) || !formData.type || creatingIncident} className="bg-[#2F3E46] text-white">
              {creatingIncident ? 'Logging...' : 'Log Incident'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <IncidentReportModal
        open={isIncidentReportOpen}
        onOpenChange={setIsIncidentReportOpen}
        mode={incidentReportMode}
        violationId={activeIncidentViolationId}
        residentId={activeIncidentResidentId}
        residentIds={activeIncidentResidentIds}
        violationIds={activeIncidentViolationIds}
        residentName={activeIncidentResidentIds.length > 1 ? `${activeIncidentResidentIds.length} residents` : children.find(c => c.id === activeIncidentResidentId)?.name}
        currentUsername={user?.username}
        onSaved={() => { resetForm(); setTimeout(() => refreshData(), 300); }}
      />

      {/* View Incident Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46] flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-orange-500" /> Violation Record
            </DialogTitle>
          </DialogHeader>
          {selectedViolation && (() => {
            const resident = children.find(c => c.id === selectedViolation.residentId);
            const interventions = viewRequirements?.interventions || [];
            const interventionLines = interventions.map((r: any) => ({
              text: r?.officialText || r?.metadata?.officialText || r?.metadata?.rawText || r?.interventionType || r?.type || 'Unspecified',
              duration: r?.duration,
              unit: r?.unit,
            }));
            return (
              <div className="space-y-4 py-2">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase">Resident</p>
                    <p className="font-bold text-[#2F3E46]">{resident?.name || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase">Date</p>
                    <p className="font-semibold text-[#2F3E46]">{formatShortDate(selectedViolation.date)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase">Offense Classification</p>
                    <p className="font-semibold text-[#2F3E46]">{(selectedViolation as any).offenseNumber || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase">Offense Classification</p>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-[#2F3E46]"></span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                selectedViolation.severity === 'Major'    ? 'bg-orange-100 text-orange-700' :
                                                                    'bg-yellow-100 text-yellow-700'
                      }`}>{selectedViolation.severity}</span>
                    </div>
                  </div>
                  {selectedViolation.reportedBy && (
                    <div>
                      <p className="text-[10px] font-bold text-gray-400 uppercase">Reported By</p>
                      <p className="font-semibold text-[#2F3E46]">{selectedViolation.reportedBy}</p>
                    </div>
                  )}
                  {selectedViolation.location && (
                    <div>
                      <p className="text-[10px] font-bold text-gray-400 uppercase">Location</p>
                      <p className="font-semibold text-[#2F3E46]">{selectedViolation.location}</p>
                    </div>
                  )}
                  {(selectedViolation as any).bodyLocation && (
                    <div>
                      <p className="text-[10px] font-bold text-gray-400 uppercase">Body Location</p>
                      <p className="font-semibold text-[#2F3E46]">{(selectedViolation as any).bodyLocation}</p>
                    </div>
                  )}
                </div>

                <div className="p-3 bg-gray-50 rounded-xl border border-gray-200">
                  <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Violation</p>
                  <p className="font-semibold text-[#2F3E46] text-sm">{selectedViolation.type}</p>

                </div>

                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="bg-[#2F3E46] px-4 py-2.5 flex items-center justify-between">
                    <p className="text-xs font-bold text-white uppercase tracking-wide">Prescribed Interventions</p>
                    {viewRequirements?.offenseLevel && <span className="text-[10px] text-gray-300">{viewRequirements.offenseLevel === '3rd' ? '3rd Offense+' : `${viewRequirements.offenseLevel} Offense`}</span>}
                  </div>
                  {interventionLines.length > 0 ? (
                    <div className="divide-y divide-gray-100">
                      {interventionLines.map((line: any, i: number) => (
                        <div key={i} className="flex items-start gap-3 p-3">
                          <span className="shrink-0 w-2 h-2 rounded-full bg-gray-300 mt-2" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-gray-700 whitespace-normal break-words">{line.text}</p>
                            {line.duration ? <p className="text-xs text-gray-500 mt-0.5">Duration: {line.duration} {line.unit || ''}</p> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="p-3 text-sm text-gray-500">No prescribed interventions on record.</p>
                  )}
                </div>

                {/* Review Notes captured during Psychological Staff verification. Shown
                    here so the notes remain readable after the dialog closes and
                    the page is reloaded — they are persisted on the violation
                    itself (actionTaken / reviewedBy). */}
                {(selectedViolation.actionTaken || selectedViolation.reviewedBy) && (
                  <div className="border border-gray-200 rounded-xl overflow-hidden">
                    <div className="bg-[#2F3E46] px-4 py-2.5">
                      <p className="text-xs font-bold text-white uppercase tracking-wide">Review Notes</p>
                    </div>
                    <div className="p-3 space-y-2">
                      {selectedViolation.actionTaken
                        ? <p className="text-sm text-gray-700 whitespace-pre-wrap">{selectedViolation.actionTaken}</p>
                        : <p className="text-sm text-gray-500">No review notes were recorded.</p>}
                      {selectedViolation.reviewedBy && (
                        <p className="text-xs text-gray-500">Reviewed by {selectedViolation.reviewedBy}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsViewDialogOpen(false)}>Close</Button>
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
              <Select value={formData.residentId} onValueChange={(value) => {
                const autoOffense = getAutoOffenseNumber(value);
                setFormData({ ...formData, residentId: value, offenseNumber: autoOffense });
              }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select resident" />
                </SelectTrigger>
                <SelectContent>
                  {children.map((child) => (
                    <SelectItem key={child.id} value={child.id}>
                      {child.name}
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
                  const found = findGuideByLabel(activeMatrix, v);
                  if (found) {
                    setFormData(prev => ({
                      ...prev,
                      type: found.label,
                      severity: found.severity,
                      // See the Log Incident dialog: a body part belongs only to
                      // a body-marking violation.
                      bodyLocation: isBodyMarkingViolation(found.label) ? prev.bodyLocation : '',
                    }));
                  }
                }}
              >
                <SelectTrigger><SelectValue placeholder="Select incident type..." /></SelectTrigger>
                <SelectContent className="max-h-80">
                  <div className="sticky top-0 z-10 bg-white p-2 border-b" onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                    <Input autoFocus value={incidentTypeSearch} onChange={e => setIncidentTypeSearch(e.target.value)} placeholder="Search violation type..." className="h-8 text-xs" />
                  </div>
                  <div className="px-2 py-1 text-[10px] font-black uppercase text-orange-600 tracking-wider">Major Offenses</div>
                  {activeMatrix.filter(m => m.category === "Major" && m.label.toLowerCase().includes(incidentTypeSearch.toLowerCase())).map(m => (
                    <SelectItem key={m.id} value={m.label}>
                      <div className="flex items-center gap-2">
                        <span className={"w-2 h-2 rounded-full bg-orange-500"} />
                        <span className="text-sm">{m.label}</span>
                      </div>
                    </SelectItem>
                  ))}
                  <div className="px-2 py-1 text-[10px] font-black uppercase text-yellow-600 tracking-wider border-t">Minor Offenses</div>
                  {activeMatrix.filter(m => m.category === "Minor" && m.label.toLowerCase().includes(incidentTypeSearch.toLowerCase())).map(m => (
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
                  formData.severity === "Major" ? "bg-orange-50 text-orange-700 border border-orange-200" :
                  "bg-yellow-50 text-yellow-700 border border-yellow-200"
                )}>
                  <span>{formData.severity} —</span>
                  <span className="text-gray-400 font-normal">· auto-detected from matrix</span>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label>Classification</Label>
              <div className="h-10 flex items-center rounded-md border border-gray-200 bg-gray-50 px-3 text-sm text-gray-700">
                {formData.severity} — detected from Manage Violations & Interventions
              </div>
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
            {isBodyMarkingViolation(formData.type) && (
              <div className="space-y-2">
                <Label>Body Location</Label>
                <Select value={formData.bodyLocation} onValueChange={(part) => setFormData(prev => ({ ...prev, bodyLocation: part }))}>
                  <SelectTrigger aria-label="Body location"><SelectValue placeholder="Which part of the body?" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {BODY_LOCATIONS.map((part) => (
                      <SelectItem key={part} value={part}>{part}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
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
              <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value as any })}>
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
      {/* ── VIEW MANAGE VIOLATION DIALOG ── */}
      <AlertDialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset Intervention Records?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark all active violations for <strong>{clearingMonth}</strong> as Resolved.
              Only Social Workers can perform this action.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={handleClearMonth}>
              Yes, Reset Month
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

      {/* Verification review dialog: values are read-only because they come from Manage Violations & Interventions. */}
      <Dialog open={isReviewDialogOpen} onOpenChange={(open) => { if (!isReviewSubmitting) setIsReviewDialogOpen(open); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><ShieldAlert className="w-5 h-5 text-purple-600" /> Review Violation</DialogTitle></DialogHeader>
          {selectedViolation && (() => {
            const req = reviewRequirements;
            const interventions = req?.interventions || [];
            // Same signal as the API and as the validation above. Scanning the
            // free text here is what hid the Schedule field for the exact
            // interventions the API refuses to verify without one.
            const needsSchedule = interventions.some(interventionNeedsSchedule);
            const isPsychosocial = interventions.some(interventionIsPsychosocial);
            return <div className="space-y-4 py-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-lg bg-gray-50 p-4 text-sm">
                <p><span className="font-medium">Incident Type:</span> {selectedViolation.type}</p>
                <p><span className="font-medium">Resident:</span> {children.find(c => c.id === selectedViolation.residentId)?.name || 'Unknown'}</p>
                <p><span className="font-medium">Offense Number:</span> {selectedViolation.offenseNumber || '—'}</p>
                <p><span className="font-medium">Reported By:</span> {selectedViolation.reportedBy || '—'}</p>
                <p><span className="font-medium">Classification:</span> {selectedViolation.severity}</p>
                <p><span className="font-medium">Incident Date:</span> {formatShortDate(selectedViolation.date)}</p>
                <p className="sm:col-span-2"><span className="font-medium">Notes:</span> {selectedViolation.description || '—'}</p>
              </div>
              <div className="rounded-lg border border-green-200 bg-green-50/40 p-4">
                 <div className="flex items-center justify-between gap-2">
                   <Label>Prescribed Intervention(s)</Label>
                 </div>
                 <div className="mt-2 space-y-1 text-sm">
                   {interventions.map((r: any) => (
                     <div key={r.id} className="rounded bg-white border px-3 py-2">
                       <div className="font-medium">{interventionDisplayText(r)}</div>
                       {r.duration ? <div className="text-xs text-gray-500 mt-0.5">Duration: {r.duration} {r.unit || ''}</div> : null}
                       <div className="text-[10px] text-gray-400 mt-1">Configured intervention ID: {r.id}</div>
                     </div>
                   ))}
                 </div>
               </div>
              {needsSchedule && <div className="space-y-2 rounded-lg border p-4"><Label>Schedule Date and Time</Label><Input type="datetime-local" min={new Date(Date.now() + 60000).toISOString().slice(0,16)} value={reviewForm.scheduleDateTime} onChange={(e) => setReviewForm(p => ({ ...p, scheduleDateTime: e.target.value }))} /><p className="text-xs text-gray-500">The configured intervention type is Psychosocial Activity or Dialogue/Counseling, which has to be scheduled before this violation can be verified.</p></div>}
              {isPsychosocial && <div className="space-y-2 rounded-lg border p-4"><Label>Psychosocial Activity (select all that apply)</Label><div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{PSYCHOSOCIAL_OPTIONS.map(option => <label key={option} className="flex items-center gap-2 text-sm"><Checkbox checked={reviewForm.psychosocialActivities.includes(option)} onCheckedChange={() => togglePsychosocialActivity(option)} />{option}</label>)}</div></div>}
              <div className="space-y-2 rounded-lg border p-4">
                <Label htmlFor="review-notes">Review Notes</Label>
                <Textarea
                  id="review-notes"
                  rows={4}
                  value={reviewForm.actionTaken}
                  onChange={(e) => setReviewForm((prev) => ({ ...prev, actionTaken: e.target.value }))}
                  placeholder="Record your findings, the reason for rejection, or any instruction for the assigned intervention…"
                  disabled={isReviewSubmitting}
                />
                <p className="text-xs text-gray-500">Saved with this violation and shown on its View details. Required when rejecting.</p>
              </div>
              {reviewError && (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <p>{reviewError}</p>
                </div>
              )}
              {reviewSuccess && (
                <div className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
                  <Check className="w-4 h-4 mt-0.5 shrink-0" />
                  <p>{reviewSuccess}</p>
                </div>
              )}
            </div>;
          })()}
          <DialogFooter>
            <Button variant="outline" disabled={isReviewSubmitting} onClick={() => setIsReviewDialogOpen(false)}>Cancel</Button>
            <Button disabled={isReviewSubmitting || !!reviewSuccess} onClick={() => handleReview('reject')} className="bg-red-600 hover:bg-red-700 text-white">{reviewPending === 'reject' ? 'Saving…' : 'Reject'}</Button>
            <Button disabled={isReviewSubmitting || !!reviewSuccess} onClick={() => handleReview('verify')} className="bg-green-600 hover:bg-green-700 text-white"><Check className="w-4 h-4 mr-1" /> {reviewPending === 'verify' ? 'Saving…' : 'Verify'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
