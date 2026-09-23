import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { CheckCircle2, Circle, ChevronRight, AlertTriangle, Lock, ClipboardList, FileText, Loader2, Upload, Clock, XCircle, Download, FolderOpen, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/dialog';
import { Textarea } from '@/app/components/ui/textarea';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { SignaturePadModal } from '@/app/components/SignaturePad';
import { describeError, request, apiUrl, authHeaders } from '@/services/api';
import { systemDialog } from '@/app/components/SystemDialog';
import { useAuth } from '../state/AuthContext';
import { useData } from '../state/DataContext';
import { formatShortDate, formatShortDateTime } from '@/utils/dateFormatter';
import { admissionPeriodsFor } from '@/utils/admissionPeriods';

const CASE_PHASES = [
  'Admission Phase',
  'Orientation Phase',
  'Enculturation/Observation Phase',
  'Caring & Rehabilitation Phase / DP or IPP Implementation',
  'Pre-integration Phase',
  'Reintegration/Aftercare Program',
];

/**
 * Upload permission per document type — kept identical to the backend's copy in
 * `backend/src/utils/constants.js` and to the copy in `DocumentUpload.tsx`.
 *
 * This map had drifted furthest: it was missing 'Quarterly Education Report',
 * 'Monthly Education Progress Report', 'Casework / Groupwork', 'Monitoring
 * Report', 'Progress Report', 'Health Record Form' and 'Medical Certificate'.
 * Every lookup here treats `undefined` as "allowed for every role"
 * (`!allowedRoles || allowedRoles.includes(userRole)`), so the missing entries
 * offered an upload box to roles the backend then refused with a 403 — and the
 * "X only" hint next to the upload control was silently omitted.
 */
const DOCUMENT_ROLE_PERMISSIONS: Record<string, string[]> = {
  'Court order':                        ['socialworker', 'centerhead'],
  'Court Order':                        ['socialworker', 'centerhead'],
  'OCP resolution':                     ['socialworker', 'centerhead'],
  'OCP Resolution':                     ['socialworker', 'centerhead'],
  'Case Information':                   ['socialworker', 'centerhead'],
  'Diversion plan referral letter':     ['socialworker', 'centerhead'],
  'Diversion Plan Referral Letter':     ['socialworker', 'centerhead'],
  'Medical Certificate':                ['socialworker', 'nurse', 'centerhead'],
  'Medical Certificate / Birth Certificate': ['socialworker', 'centerhead'],
  'Birth/baptismal certificate':        ['socialworker', 'centerhead'],
  'Baptismal Certificate':              ['socialworker', 'centerhead'],
  'Psychological assessment (if needed)': ['psychologist', 'centerhead'],
  'Psychological Assessment':           ['psychologist', 'centerhead'],
  'Psychological Testing':              ['psychologist', 'centerhead'],
  'Discernment assessment':             ['psychologist', 'centerhead'],
  'Discernment Assessment':             ['psychologist', 'centerhead'],
  'SCSR':                               ['socialworker', 'centerhead'],
  'Parenting capability assessment':    ['psychologist', 'centerhead'],
  'Parenting Capability Assessment':    ['psychologist', 'centerhead'],
  'Case Conference Form':               ['socialworker', 'centerhead'],
  'Exit Case Conference Form':          ['socialworker', 'centerhead'],
  'Home Visit Form':                    ['socialworker', 'centerhead'],
  'Home/School Visit Form':             ['socialworker', 'educator', 'centerhead'],
  'Quarterly Education Report':         ['educator', 'centerhead'],
  'Monthly Education Progress Report':  ['educator', 'centerhead'],
  'Quarterly Progress Report':          ['socialworker', 'centerhead'],
  'Casework/group work':                ['socialworker', 'centerhead'],
  'Casework / Groupwork':               ['socialworker', 'centerhead'],
  'Monitoring Report':                  ['socialworker', 'centerhead'],
  'Case Assistance Feedback Form':      ['socialworker', 'centerhead'],
  'Court hearing assistance (optional)': ['socialworker', 'centerhead'],
  'Court Assistance':                   ['socialworker', 'centerhead'],
  'Court Assistance Feedback Form':     ['socialworker', 'centerhead'],
  'Discharge Form':                     ['socialworker', 'centerhead'],
  'Progress Report':                    ['socialworker', 'psychologist', 'nurse', 'educator', 'centerhead'],
  'Health Record Form':                 ['nurse', 'centerhead'],
  'Incident Report':                    ['socialworker', 'psychologist', 'centerhead', 'admin'],
  'Other':                              ['socialworker', 'psychologist', 'nurse', 'educator', 'centerhead', 'admin'],
};

/**
 * Free-form document upload for a phase.
 *
 * Every phase (Admission included) offers a plain "Upload Document" button: the
 * user picks a file, gives it a name, and it is stored in that child's Child
 * Documents folder tagged with the phase. It is deliberately NOT tied to a
 * specific required document — the user uploads whatever paperwork they have.
 *
 * Uploads are marked with a `"<phase> - Uploaded"` category, mirroring the
 * `"<phase> - Required"` category the digital-form upload already writes, so
 * the phase view can list exactly the documents uploaded here without touching
 * the required-document status matching.
 */
const PHASE_UPLOAD_CATEGORY_SUFFIX = ' - Uploaded';
const phaseUploadCategory = (phase: string) => `${phase}${PHASE_UPLOAD_CATEGORY_SUFFIX}`;
const isPhaseUpload = (doc: { category?: string }, phase: string) =>
  String(doc.category || '') === phaseUploadCategory(phase);

// Legacy titles are accepted when checking existing uploads so correcting the
// Phase Timeline labels does not make already-stored documents appear missing.
const LEGACY_DOCUMENT_ALIASES: Record<string, string[]> = {
  'Court order': ['Court Order'],
  'OCP resolution': ['OCP Resolution'],
  'Diversion plan referral letter': ['Diversion Plan Referral Letter'],
  'Medical Certificate': ['Medical Certificate / Birth Certificate'],
  'Birth/baptismal certificate': ['Baptismal Certificate'],
  'Psychological assessment (if needed)': ['Psychological Assessment'],
  'Discernment assessment': ['Discernment Assessment'],
  'Home Visit Form': ['Home/School Visit Form'],
  'Casework/group work': ['Casework / Groupwork'],
  'Parenting capability assessment': ['Parenting Capability Assessment'],
  'Court hearing assistance (optional)': ['Court Assistance', 'Court Assistance Feedback Form'],
};

const acceptedDocumentTitles = (canonical: string) => [
  canonical,
  ...(LEGACY_DOCUMENT_ALIASES[canonical] || []),
].map(title => title.trim().toLowerCase());

const LEGACY_TASK_ALIASES: Record<string, string[]> = {
  'Orientation on house rules': ['Orientation on House Rules'],
  'Provision of hygiene kit': ['Provision of Hygiene Kit'],
  'Provision of clothes': ['Provision of Clothes'],
  'Room assignment': ['Room Assignment'],
  'Counseling sessions': ['Counseling Sessions'],
  'Group living services': ['Group Living Services'],
  'Family conferencing': ['Family Conferencing'],
  'Sports and values formation activities': ['Sports / Values Formation'],
};

const taskIsCompleted = (task: string, completed: string[]) => {
  const accepted = [task, ...(LEGACY_TASK_ALIASES[task] || [])]
    .map(item => item.trim().toLowerCase());
  return completed.some(item => accepted.includes(String(item || '').trim().toLowerCase()));
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
    reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled.`));
    reader.readAsDataURL(file);
  });
}

interface PhaseRecord {
  id: string;
  residentId: string;
  phaseName: string;
  violationBlock?: { violationCount: number; demotionRecommended: boolean } | null;
  enteredAt: string;
  completedAt?: string;
  tasksRequired: string[];
  tasksCompleted: string[];
  isCurrent: boolean;
  enteredBy?: string;
  completedBy?: string;
  notes?: string;
  requirementsMet?: boolean;
  missingRequirements?: { documents: string[]; tasks: string[] };
}

interface PhaseRequirements {
  [phase: string]: {
    requiredDocuments: string[];
    requiredTasks: string[];
    optionalTasks?: string[];
    optionalDocuments?: string[];
    manualCompletion?: boolean;
  };
}

interface ResidentDoc {
  title: string;
  status: string;
  uploadedBy?: string;
  uploadedAt?: string;
  approvedBy?: string;
  phase?: string;
  fileData?: string;
  fileName?: string;
  // Set when a document is returned for reassessment; rendered next to the
  // Reassessment badge.
  rejectionReason?: string;
}

interface Props {
  residentId: string;
  currentPhase: string;
  onPhaseAdvanced?: () => void;
}

interface PhaseReqWithOptional {
  requiredDocuments: string[];
  optionalDocuments?: string[];
  optionalTasks?: string[];
  requiredTasks: string[];
  manualCompletion?: boolean;
}

export function PhaseProgress({ residentId, currentPhase, onPhaseAdvanced }: Props) {
  const { user } = useAuth();
  const { addDocument, deleteDocument, documents: allDocuments, updateChild, children, generateReport, refreshData } = useData();
  const isCenterHead = user?.role === 'centerhead';
  // Houseparents can view the complete phase timeline. The only write
  // affordance is checking/unchecking the Orientation Phase checklist; uploads,
  // phase transitions, demotion and discharge remain unavailable.
  const isHouseparent = user?.role?.toLowerCase() === 'houseparent';
  const uploadRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const [history, setHistory] = useState<PhaseRecord[]>([]);
  const [currentRecord, setCurrentRecord] = useState<PhaseRecord | null>(null);
  const [requirements, setRequirements] = useState<PhaseRequirements>({});
  // Derive residentDocs live from DataContext — no separate state needed
  const [loading, setLoading] = useState(true);
  const [validating, setValidating] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState<string | null>(null);
  // Free-form "Upload Document" dialog for the displayed phase.
  const [isDocUploadOpen, setIsDocUploadOpen] = useState(false);
  const [docUploadName, setDocUploadName] = useState('');
  const [docUploadDescription, setDocUploadDescription] = useState('');
  const [docUploadFile, setDocUploadFile] = useState<File | null>(null);
  const [docUploadError, setDocUploadError] = useState('');
  const [isDocUploading, setIsDocUploading] = useState(false);
  const docUploadInputRef = useRef<HTMLInputElement>(null);
  const [isDischargePopupOpen, setIsDischargePopupOpen] = useState(false);
  const [isDischargeConfirmed, setIsDischargeConfirmed] = useState(false);
  const [showDischargeConfirmPrompt, setShowDischargeConfirmPrompt] = useState(false);
  const [isCaseClosed, setIsCaseClosed] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  /**
   * The Discharge Report's two staff signatures. They are collected before the
   * document is written and embedded into it, so nothing is persisted and a
   * second download starts from blank pads.
   */
  const [isDischargeSignOpen, setIsDischargeSignOpen] = useState(false);
  // Two signers, as the printed Discharge Report requires: the staff who
  // prepared it and the approving authority (Center Head). Each has a typed
  // name — printed under the signature line — and a drawn signature.
  const [dischargeSignerName, setDischargeSignerName] = useState('');
  const [dischargePreparedBySignature, setDischargePreparedBySignature] = useState('');
  const [dischargeApprovedByName, setDischargeApprovedByName] = useState('');
  const [dischargeApprovedBySignature, setDischargeApprovedBySignature] = useState('');
  // Flips true when Cancel is clicked while a report is still being built, so
  // an in-flight generation can bail out before it opens the print window or
  // records the report — Cancel must never let a generation it stopped
  // finish anyway.
  const dischargeGenerationCancelledRef = useRef(false);
  const [isConfirmingDischarge, setIsConfirmingDischarge] = useState(false);
  const [dischargeRecommendation, setDischargeRecommendation] = useState<'For Reintegration' | 'For Transfer' | ''>('For Reintegration');
  const [dischargeDate, setDischargeDate] = useState('');
  const [dischargeDateOptional, setDischargeDateOptional] = useState(true); // date can be set later
  // Reason/context the user can attach when discharging before every
  // requirement of the final phase is complete.
  const [dischargeNote, setDischargeNote] = useState('');
  // The resident's Estimated Discharge Date, read from their admission /
  // discharge plan record — drives which of the three discharge dialog
  // states (incomplete / early / ready) is shown.
  const [estimatedDischargeDate, setEstimatedDischargeDate] = useState<string>('');
  const [localTasksCompleted, setLocalTasksCompleted] = useState<string[]>([]);
  const [tasksInitialized, setTasksInitialized] = useState(false);
  const [needsPsychAssessment, setNeedsPsychAssessment] = useState(false);
  const [togglingPsych, setTogglingPsych] = useState(false);
  const [demoting, setDemoting] = useState(false);
  const [returningPhase, setReturningPhase] = useState<string | null>(null);
  const [viewingPhase, setViewingPhase] = useState<string | null>(null);

  const [isAdvanceDialogOpen, setIsAdvanceDialogOpen] = useState(false);
  const [advanceNotes, setAdvanceNotes] = useState('');
  const [showAdvanceConfirm, setShowAdvanceConfirm] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    canAdvance: boolean;
    missingRequirements: { documents: string[]; tasks: string[]; violations?: boolean };
    violationBlock?: { violationCount: number; demotionRecommended: boolean } | null;
    message: string;
  } | null>(null);
  const [violationBlock, setViolationBlock] = useState<{ violationCount: number; demotionRecommended: boolean } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [histRes, reqRes] = await Promise.all([
        request<{ success: boolean; data: PhaseRecord[] }>(`/phases/resident/${residentId}`),
        request<{ success: boolean; data: PhaseRequirements }>('/phases/requirements'),
      ]);
      if (histRes.success) setHistory(histRes.data);
      if (reqRes.success) setRequirements(reqRes.data);

      const curRes = await request<{ success: boolean; data: PhaseRecord | null }>(`/phases/resident/${residentId}/current`);
      if (curRes.success) {
        if (curRes.data) {
          setCurrentRecord(curRes.data);
          setViolationBlock(curRes.data.violationBlock || null);
        } else {
          // No current record — auto-create ONLY if this phase doesn't already exist in history
          const phaseName = currentPhase || 'Admission Phase';
          const alreadyExists = histRes.success && histRes.data.some(
            (h: PhaseRecord) => h.phaseName === phaseName
          );
          if (alreadyExists) {
            // Re-use the existing record instead of creating a duplicate
            const existing = histRes.data.find((h: PhaseRecord) => h.phaseName === phaseName);
            if (existing) setCurrentRecord(existing);
          } else {
            try {
              const reqRes2 = await request<{ success: boolean; data: PhaseRequirements }>('/phases/requirements');
              const phaseReqs = reqRes2.success ? reqRes2.data : {};
              const phaseTasks = (phaseReqs[phaseName]?.requiredTasks) || [];

              const created = await request<{ success: boolean; data: PhaseRecord }>('/phases', {
                method: 'POST',
                body: JSON.stringify({
                  residentId,
                  phaseName,
                  enteredAt: new Date().toISOString().split('T')[0],
                  isCurrent: true,
                  tasksRequired: phaseTasks,
                  tasksCompleted: [],
                  enteredBy: 'System',
                  createdBy: 'System',
                }),
              });
              if (created.success) setCurrentRecord(created.data);
            } catch { /* silent */ }
          }
        }
      }
    } catch { /* silent */ }
    setLoading(false);
  }, [residentId, currentPhase]);

  // Sync discharged state — resets to false when child is re-admitted
  useEffect(() => {
    const child = children.find(c => c.id === residentId);
    if (child?.status === 'Discharged') {
      setIsCaseClosed(true);
    } else if (child?.status === 'Active') {
      setIsCaseClosed(false); // reset when re-admitted
    }
    if (child && child.needsPsychAssessment !== undefined) {
      setNeedsPsychAssessment(!!child.needsPsychAssessment);
    }
  }, [children, residentId]);

  // Load the resident's Estimated Discharge Date for the Discharge dialog.
  useEffect(() => {
    if (!residentId) { setEstimatedDischargeDate(''); return; }
    let cancelled = false;
    request<{ success: boolean; data?: { admission?: { expectedDischargeDate?: string | null } | null } }>(`/discharge-plans/resident/${residentId}`)
      .then(res => {
        if (cancelled) return;
        const date = res?.success ? (res.data?.admission?.expectedDischargeDate || '') : '';
        setEstimatedDischargeDate(date || '');
      })
      .catch(() => { if (!cancelled) setEstimatedDischargeDate(''); });
    return () => { cancelled = true; };
  }, [residentId]);

  // Sync localTasksCompleted from child record when it first loads
  useEffect(() => {
    if (!tasksInitialized) {
      const child = children.find(c => c.id === residentId);
      const saved = child?.phaseTasksCompleted?.[currentPhase] || [];
      setLocalTasksCompleted(saved);
      if (child) setTasksInitialized(true);
    }
  }, [children, residentId, currentPhase, tasksInitialized]);

  // Keep localTasksCompleted in sync with child record (for tab switching persistence)
  useEffect(() => {
    const child = children.find(c => c.id === residentId);
    if (child && tasksInitialized) {
      const saved = child?.phaseTasksCompleted?.[currentPhase] || [];
      // Only update if different (to avoid infinite loops and preserve optimistic updates)
      if (JSON.stringify(saved) !== JSON.stringify(localTasksCompleted)) {
        // Use a small delay to allow optimistic update to persist first
        const timer = setTimeout(() => {
          const latestChild = children.find(c => c.id === residentId);
          const latestSaved = latestChild?.phaseTasksCompleted?.[currentPhase] || [];
          if (JSON.stringify(latestSaved) !== JSON.stringify(localTasksCompleted)) {
            setLocalTasksCompleted(latestSaved);
          }
        }, 500);
        return () => clearTimeout(timer);
      }
    }
  }, [children, residentId, currentPhase, tasksInitialized, localTasksCompleted]);

  // Reset when phase changes OR when phaseTasksCompleted is wiped (re-admit)
  useEffect(() => {
    const child = children.find(c => c.id === residentId);
    const phaseData = child?.phaseTasksCompleted?.[currentPhase];
    // If phaseTasksCompleted is empty object {} after re-admit, reset local state
    if (child && (!child.phaseTasksCompleted || Object.keys(child.phaseTasksCompleted || {}).length === 0)) {
      setLocalTasksCompleted([]);
    }
  }, [children, residentId]);

  // Reset when phase changes — clear everything and reload from backend
  useEffect(() => {
    setTasksInitialized(false);
    setLocalTasksCompleted([]);
    setCurrentRecord(null);
    loadData();
  }, [currentPhase]);

  // Also reset tasks when residentId changes (e.g. navigating to re-admitted child)
  useEffect(() => {
    const child = children.find(c => c.id === residentId);
    // If child was re-admitted (has readmissionDate), reset task state
    if (child?.readmissionDate) {
      setTasksInitialized(false);
      setLocalTasksCompleted([]);
    }
  }, [residentId]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleToggleTask = async (task: string, done: boolean) => {
    // Houseparents may write checklist state only for Orientation Phase.
    if (isHouseparent && displayPhase !== 'Orientation Phase') return;

    // Determine which phase record we're updating
    const targetRecord = viewingPhase ? displayRecord : currentRecord;
    const targetPhase = displayPhase; // displayPhase = viewingPhase || currentPhase

    // Get current tasks for this specific phase
    const currentPhaseTasks = viewingPhase
      ? (displayRecord?.tasksCompleted || [])
      : localTasksCompleted;

    const taskAliases = new Set([task, ...(LEGACY_TASK_ALIASES[task] || [])]);
    const newTasks = done
      ? [...currentPhaseTasks.filter(t => !taskAliases.has(t)), task]
      : currentPhaseTasks.filter(t => !taskAliases.has(t));

    // Update local state — for current phase update localTasksCompleted
    // For viewed phase, update via child's phaseTasksCompleted
    if (!viewingPhase) {
      setLocalTasksCompleted(newTasks);
    }

    const child = children.find(c => c.id === residentId);
    try {
      // Save to the phase record in DB
      if (targetRecord) {
        await request<{ success: boolean; tasksCompleted?: string[] }>(
          `/phases/${targetRecord.id}/task`,
          {
            method: 'POST',
            body: JSON.stringify({ task, completed: done }),
          }
        );
      }
      // Non-HP roles keep the existing child-level mirror. Houseparents must
      // not use PUT /children because that endpoint is intentionally forbidden
      // to them; the HP-specific phase endpoint persists the allowed checklist
      // change server-side instead.
      if (child && !isHouseparent) {
        const existing: Record<string, string[]> = child.phaseTasksCompleted || {};
        const updated = { ...existing, [targetPhase]: newTasks };
        await updateChild(residentId, { phaseTasksCompleted: updated });
      }
      // Reload history so displayRecord reflects saved state
      await loadData();
    } catch (error) {
      console.error('[PhaseProgress] Failed to save checklist task:', error);
      // Revert on error
      if (!viewingPhase) setLocalTasksCompleted(currentPhaseTasks);
    }
  };

  const handleTogglePsychAssessment = async (value: boolean) => {
    setTogglingPsych(true);
    try {
      await request(`/children/${residentId}/toggle-psych-assessment`, {
        method: 'POST',
        body: JSON.stringify({ needsPsychAssessment: value, flaggedBy: user?.username }),
      });
      setNeedsPsychAssessment(value);
      // Refresh store so the new alert appears in Notifications immediately
      refreshData();
    } catch (err) {
      console.error('Failed to toggle psych assessment:', err);
    }
    setTogglingPsych(false);
  };

  const handleDemote = async () => {
    if (!currentRecord) return;
    setDemoting(true);
    try {
      const result = await request<{ success: boolean; message: string }>(
        `/phases/${currentRecord.id}/demote`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: 'Violation pattern detected' }),
        }
      );
      if (result.success) {
        setIsAdvanceDialogOpen(false);
        await loadData();
        onPhaseAdvanced?.();
      }
    } catch (e) {
      console.error('[Demote] Failed:', e);
    }
    setDemoting(false);
  };



  const handleValidate = async () => {
    setValidating(true);

    // Build effective required documents (include conditional psych assessment if flagged)
    const phaseReq = requirements[currentPhase] as PhaseReqWithOptional | undefined;
    let effectiveDocs = [...(currentReq.requiredDocuments || [])];
    if (phaseReq?.optionalDocuments?.includes('Psychological Assessment') && needsPsychAssessment) {
      effectiveDocs.push('Psychological Assessment');
    }

    // Frontend validation — no backend dependency
    const missingTasks = tasksRequired.filter(t => !tasksCompleted.includes(t));
    const missingDocs = effectiveDocs.filter(doc => {
      const uploaded = residentDocs.find(d =>
        (d.title === doc || d.title?.toLowerCase() === doc.toLowerCase()) &&
        (d.phase === currentPhase || !d.phase || d.phase === '')
      );
      return !uploaded || uploaded.status !== 'Approved';
    });

    // Check for violation blocks via backend
    let violationBlock = null;
    try {
      const phaseValidation = await request<{ success: boolean; data?: any }>(
        `/phases/resident/${residentId}/current`
      );
      if (phaseValidation.success && phaseValidation.data) {
        violationBlock = phaseValidation.data.violationBlock || null;
      }
    } catch (e) {
      console.error('[PhaseProgress] Failed to check violations:', e);
    }

    const hasViolationBlock = violationBlock !== null;
    const canAdvance = missingTasks.length === 0 && missingDocs.length === 0 && !hasViolationBlock;
    
    let message = '';
    if (hasViolationBlock) {
      message = `Cannot advance: ${violationBlock.violationCount} unresolved violation(s) exist.`;
      if (violationBlock.demotionRecommended) {
        message += ' Demotion to previous phase is recommended.';
      }
    } else if (!canAdvance) {
      message = `Cannot advance: ${missingDocs.length} document(s) and ${missingTasks.length} task(s) still required.`;
    } else {
      message = `All requirements for ${currentPhase} are met. Phase can be advanced.`;
    }

    const result = {
      success: true,
      canAdvance,
      missingRequirements: { 
        documents: missingDocs, 
        tasks: missingTasks,
        violations: hasViolationBlock 
      },
      violationBlock,
      message,
    };

    setValidationResult(result);
    setIsAdvanceDialogOpen(true);
    setValidating(false);
  };

  const handleAdvance = async () => {
    setAdvancing(true);
    try {
      const currentIndex = CASE_PHASES.indexOf(currentPhase);
      if (currentIndex < 0 || currentIndex >= CASE_PHASES.length - 1) {
        console.warn('[Advance] Phase not found or already at last phase');
        setAdvancing(false);
        return;
      }
      const nextPhase = CASE_PHASES[currentIndex + 1];

      if (!currentRecord) throw new Error('Current phase record is unavailable');
      await request(`/phases/${currentRecord.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ notes: advanceNotes, force: isCenterHead && !validationResult?.canAdvance }),
      });

      // Backend completion updates both the phase history and child.casePhase.
      setLocalTasksCompleted([]);
      setTasksInitialized(false);

      setIsAdvanceDialogOpen(false);
      setAdvanceNotes('');
      setValidationResult(null);
      await loadData();
      onPhaseAdvanced?.();
    } catch (e) {
      console.error('[Advance] Failed:', e);
    }
    setAdvancing(false);
  };

  /**
   * Crops a signature-pad PNG down to the drawn ink's own bounding box (plus a
   * little padding). The pad's backing canvas is much larger than any one
   * signature, so embedding it uncropped leaves the ink sitting wherever it
   * was drawn instead of centered — this trims the blank margin so the ink
   * itself lands directly over the printed name. Scoped to the Discharge
   * Report's own generation step; the shared signature pad component (used by
   * other forms) is untouched.
   */
  const cropSignatureToInk = (dataUrl: string): Promise<string> => {
    return new Promise((resolve) => {
      if (!dataUrl) { resolve(''); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx || canvas.width === 0 || canvas.height === 0) { resolve(dataUrl); return; }
          ctx.drawImage(img, 0, 0);
          const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          let minX = width, minY = height, maxX = -1, maxY = -1;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const alpha = data[(y * width + x) * 4 + 3];
              if (alpha > 10) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          if (maxX < 0 || maxY < 0) { resolve(''); return; } // nothing actually drawn
          const pad = 6;
          minX = Math.max(0, minX - pad);
          minY = Math.max(0, minY - pad);
          maxX = Math.min(width - 1, maxX + pad);
          maxY = Math.min(height - 1, maxY + pad);
          const cropW = maxX - minX + 1;
          const cropH = maxY - minY + 1;
          const cropCanvas = document.createElement('canvas');
          cropCanvas.width = cropW;
          cropCanvas.height = cropH;
          const cropCtx = cropCanvas.getContext('2d');
          if (!cropCtx) { resolve(dataUrl); return; }
          cropCtx.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
          resolve(cropCanvas.toDataURL('image/png'));
        } catch {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  };

  /**
   * Builds and opens the Discharge Report.
   *
   * Both signatures arrive as arguments rather than being read from state, so
   * the dialog hands over exactly what was drawn in the same tick as the click.
   * Reading them from component state inside this async function risked
   * generating the report with the previous attempt's signatures.
   */
  const buildDischargeReport = async (preparedBySignature: string, approvedBySignature: string) => {
    dischargeGenerationCancelledRef.current = false;
    setIsGeneratingReport(true);
    try {
      const child = children.find(c => c.id === residentId);
      if (!child) return;

      // Trim each signature to its ink so it sits tightly over the printed
      // name instead of centering a mostly-blank canvas. The plain names are
      // deliberately reused for the cropped results, because those are what the
      // report template below embeds.
      preparedBySignature = preparedBySignature
        ? await cropSignatureToInk(preparedBySignature)
        : '';
      approvedBySignature = approvedBySignature
        ? await cropSignatureToInk(approvedBySignature)
        : '';
      if (dischargeGenerationCancelledRef.current) return; // Cancel was clicked mid-generation

      const reportDate = new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
      const phaseRows = history
        .filter(h => h.phaseName !== 'Admission')
        .map(h => `
          <tr>
            <td>${h.phaseName}</td>
            <td>${h.enteredAt ? new Date(h.enteredAt).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}</td>
            <td>${h.completedAt ? new Date(h.completedAt).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : '<em>Current</em>'}</td>
          </tr>`).join('');

      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Discharge Report</title>
  <style>
    @page { size: A4; margin: 20mm 18mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Georgia', serif; font-size: 11pt; color: #1a1a1a; background: #fff; }
    .header { text-align: center; border-bottom: 3px solid #2F3E46; padding-bottom: 14px; margin-bottom: 20px; }
    .header .agency { font-size: 9pt; letter-spacing: 2px; text-transform: uppercase; color: #666; margin-bottom: 4px; }
    .header h1 { font-size: 18pt; font-weight: bold; color: #2F3E46; letter-spacing: 1px; }
    .header .subtitle { font-size: 9pt; color: #888; margin-top: 4px; }
    .meta { display: flex; justify-content: space-between; font-size: 9pt; color: #555; margin-bottom: 20px; }
    .section { margin-bottom: 18px; }
    .section-title { font-size: 9pt; font-weight: bold; text-transform: uppercase; letter-spacing: 1.5px; color: #2F3E46; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-bottom: 10px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 20px; }
    .field { font-size: 10pt; }
    .field .label { font-size: 8pt; text-transform: uppercase; color: #888; letter-spacing: 0.5px; }
    .field .value { font-weight: bold; color: #1a1a1a; }
    table { width: 100%; border-collapse: collapse; font-size: 10pt; }
    table thead tr { background: #2F3E46; color: white; }
    table thead th { padding: 7px 10px; text-align: left; font-size: 9pt; letter-spacing: 0.5px; }
    table tbody tr:nth-child(even) { background: #f5f7f9; }
    table tbody td { padding: 7px 10px; border-bottom: 1px solid #e5e7eb; }
    .status-badge { display: inline-block; background: #dcfce7; color: #166534; font-weight: bold; font-size: 9pt; padding: 3px 10px; border-radius: 20px; border: 1px solid #bbf7d0; }
    .notes-box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 14px; font-size: 10pt; color: #444; min-height: 50px; }
    .footer { margin-top: 30px; border-top: 1px solid #ccc; padding-top: 14px; display: flex; justify-content: space-between; font-size: 8.5pt; color: #888; }
    .signature-block { display: flex; justify-content: space-around; gap: 24px; margin-top: 40px; }
    /* Each signer gets one column. Both rows are block-level and auto-centered
       within it, so the signature always stacks directly above the printed name
       (never side-by-side). The 60px slot reserves exactly the space the
       signature occupies, so the two columns stay level however much ink each
       signer drew. */
    .signature-col { flex: 1 1 0; text-align: center; }
    .signature-slot { height: 60px; width: 220px; margin: 0 auto; display: flex; align-items: flex-end; justify-content: center; }
    .signature-slot img { max-height: 58px; max-width: 220px; }
    .signature-line { display: block; width: 220px; margin: 0 auto; border-top: 1px solid #333; padding-top: 4px; font-size: 9pt; text-align: center; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="agency">Republic of the Philippines &nbsp;·&nbsp; Department of Social Welfare and Development</div>
    <h1>SECOND CHANCE HOME</h1>
    <div class="subtitle">Bahay Pagbabago — Discharge Report</div>
  </div>

  <div class="meta">
    <span><strong>Resident:</strong> ${child.name}</span>
    <span><strong>Case ID:</strong> ${child.id}</span>
    <span><strong>Prepared by:</strong> ${user?.username || 'Staff'}</span>
  </div>

  <div class="section">
    <div class="section-title">Resident Information</div>
    <div class="grid">
      <div class="field"><div class="label">Age</div><div class="value">${child.age} years old</div></div>
      <div class="field"><div class="label">Gender</div><div class="value">${child.gender}</div></div>
      <div class="field"><div class="label">Date of Admission</div><div class="value">${child.admissionDate ? new Date(child.admissionDate).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}</div></div>
      <div class="field"><div class="label">Specific Offense</div><div class="value">${child.caseType}</div></div>
      <div class="field"><div class="label">Legal Category</div><div class="value">${child.legalCategory}</div></div>
      <div class="field"><div class="label">Guardian Name</div><div class="value">${child.guardianName || '—'}</div></div>
      <div class="field"><div class="label">Guardian Contact</div><div class="value">${child.guardianContact || '—'}</div></div>
      <div class="field" style="grid-column: span 2"><div class="label">Address</div><div class="value">${child.address || '—'}</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Phase Completion History</div>
    <table>
      <thead><tr><th>Phase</th><th>Date Started</th><th>Date Completed</th></tr></thead>
      <tbody>${phaseRows || '<tr><td colspan="3" style="text-align:center;color:#999">No phase history recorded.</td></tr>'}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">Discharge Summary</div>
    <div class="grid">
      <div class="field"><div class="label">Final Phase</div><div class="value">${currentPhase}</div></div>
      <div class="field"><div class="label">Discharge Status</div><div class="value"><span class="status-badge">✓ Cleared for Discharge</span></div></div>
      <div class="field"><div class="label">Shelter Recommendation</div><div class="value">${dischargeRecommendation || 'For Reintegration'}</div></div>
      <div class="field"><div class="label">Discharge Date</div><div class="value">${dischargeDate || 'To be confirmed'}</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">After-Care Notes</div>
    <div class="notes-box">${child.notes || 'No additional notes provided.'}</div>
  </div>

  <div class="signature-block">
    <div class="signature-col">
      <div class="signature-slot">${preparedBySignature ? `<img src="${preparedBySignature}" alt="Prepared by signature"/>` : '&nbsp;'}</div>
      <div class="signature-line">${dischargeSignerName || '&nbsp;'}<br/><span style="color:#888">Prepared by — Signature over Printed Name</span></div>
    </div>
    <div class="signature-col">
      <div class="signature-slot">${approvedBySignature ? `<img src="${approvedBySignature}" alt="Approving authority signature"/>` : '&nbsp;'}</div>
      <div class="signature-line">${dischargeApprovedByName || '&nbsp;'}<br/><span style="color:#888">Approving Authority — Signature over Printed Name</span></div>
    </div>
  </div>

  <div class="footer">
    <span>Generated by SCH-PATH System &nbsp;·&nbsp; ${reportDate}</span>
    <span>CONFIDENTIAL — For official use only</span>
  </div>

  <script>window.onload = function(){ window.print(); }</script>
</body>
</html>`;

      if (dischargeGenerationCancelledRef.current) return; // Cancel was clicked mid-generation

      const win = window.open('', '_blank');
      if (win) {
        win.document.write(html);
        win.document.close();
      }

      // Save a discharge report record to the Reports module
      await generateReport(
        'discharge',
        `Discharge Report — ${child.name} (${child.id}) — ${reportDate}`,
        user?.username || 'System'
      );
      if (dischargeGenerationCancelledRef.current) return; // Cancel was clicked mid-generation
      // Only close the signing dialog once the report actually finished —
      // Cancel closes it (and resets the draft) on its own.
      setIsDischargeSignOpen(false);
    } catch (e) {
      console.error('Report generation failed:', e);
    } finally {
      // Always clears the spinner on every exit path (success, error, or an
      // early return from Cancel) — Cancel already resets this itself too, so
      // the button is never left stuck either way.
      setIsGeneratingReport(false);
    }
  };

  /**
   * The "Download Discharge Report" buttons open the signature step first: the
   * report is written as one finished document, so both names and both
   * signatures have to be known before it is produced.
   */
  const handleDownloadDischargeReport = () => {
    setDischargeSignerName('');
    setDischargePreparedBySignature('');
    setDischargeApprovedByName('');
    setDischargeApprovedBySignature('');
    setIsDischargeSignOpen(true);
  };

  const handleConfirmDischarge = async () => {
    setIsConfirmingDischarge(true);
    try {
      const existingNotes = children.find(c => c.id === residentId)?.notes || '';
      const recNote = dischargeRecommendation ? (String.fromCharCode(10) + '[Discharge Recommendation: ' + dischargeRecommendation + ']') : '';
      const reasonNote = dischargeNote.trim() ? (String.fromCharCode(10) + '[Discharge Note: ' + dischargeNote.trim() + ']') : '';
      await updateChild(residentId, {
        status: 'Discharged',
        notes: existingNotes + recNote + reasonNote,
        ...(dischargeDate ? { dischargeDate } : {}),
      } as any);
      setIsDischargeConfirmed(true);
      onPhaseAdvanced?.();
    } catch (e) { console.error('Discharge failed:', e); }
    setIsConfirmingDischarge(false);
  };

  const handleInlineUpload = async (doc: string, file: File) => {
    setUploadingDoc(doc);
    try {
      const base64Data = await readFileAsDataUrl(file);

      const child = children.find(c => c.id === residentId);
      const now = new Date().toISOString();
      // Save through the same Documents API/state used by the Documents module.
      // The residentId is the actual child folder key, so this upload is visible
      // in Documents → Folders by Child after the server confirms it.
      await addDocument({
        residentId,
        residentName: child?.name || '',
        category: `${currentPhase} - Required`,
        title: doc,
        phase: currentPhase,
        fileName: file.name,
        fileSize: file.size,
        fileData: base64Data,
        fileType: file.type || 'application/octet-stream',
        status: 'Submitted',
        uploaderRole: user?.role || 'socialworker',
        uploadedBy: user?.username || 'System',
        uploadedAt: now,
      });

      // Re-read the authoritative server state so Documents and Phase Timeline
      // cannot diverge after an upload.
      await loadData();
      setUploadingDoc(null);
    } catch (error) {
      console.error('Phase document upload failed:', error);
      setUploadingDoc(null);
      void systemDialog.failure('Could not upload the document', describeError(error, 'The document was not uploaded. Please try again.'));
    }
  };

  /** Clears and closes the free-form upload dialog. */
  const closeDocUpload = () => {
    setIsDocUploadOpen(false);
    setDocUploadName('');
    setDocUploadDescription('');
    setDocUploadFile(null);
    setDocUploadError('');
    if (docUploadInputRef.current) docUploadInputRef.current.value = '';
  };

  /**
   * Uploads the document the user picked, under the name they typed, for the
   * phase currently on screen.
   *
   * It goes through the same Documents API as every other upload, so the file
   * lands in the child's Child Documents folder under the existing storage and
   * permission rules. `residentId` and `phase` are what file it against the
   * right child and phase.
   */
  const handleDocUpload = async () => {
    const name = docUploadName.trim();
    if (!docUploadFile) {
      setDocUploadError('Please choose a file to upload.');
      return;
    }
    if (!name) {
      setDocUploadError('Please give the document a name.');
      return;
    }

    setIsDocUploading(true);
    setDocUploadError('');
    try {
      const base64Data = await readFileAsDataUrl(docUploadFile);
      const child = children.find(c => c.id === residentId);

      await addDocument({
        residentId,
        residentName: child?.name || '',
        title: name,
        description: docUploadDescription.trim() || undefined,
        category: phaseUploadCategory(displayPhase),
        phase: displayPhase,
        fileName: docUploadFile.name,
        fileSize: docUploadFile.size,
        fileData: base64Data,
        fileType: docUploadFile.type || 'application/octet-stream',
        status: 'Submitted',
        uploaderRole: user?.role || 'socialworker',
        uploadedBy: user?.username || 'System',
        uploadedAt: new Date().toISOString(),
      });

      await loadData();
      closeDocUpload();
    } catch (error) {
      console.error('Phase document upload failed:', error);
      setDocUploadError(error instanceof Error ? error.message : 'Unable to upload the document.');
    }
    setIsDocUploading(false);
  };

  /** Fetches a stored file through the same authorised endpoint the Documents module uses. */
  const fetchStoredFile = async (doc: { id: string; fileName?: string; title?: string }) => {
    const res = await fetch(apiUrl(`/documents/${doc.id}/file`), {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error('Could not load the file. You may not have access to it.');
    return { blob: await res.blob(), fileName: doc.fileName || doc.title || 'document' };
  };

  const viewStoredDocument = async (doc: { id: string; fileName?: string; title?: string }) => {
    try {
      const { blob } = await fetchStoredFile(doc);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      void systemDialog.failure('Could not open the file', describeError(error, 'The file could not be opened. Please try again.'));
    }
  };

  const downloadStoredDocument = async (doc: { id: string; fileName?: string; title?: string }) => {
    try {
      const { blob, fileName } = await fetchStoredFile(doc);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      void systemDialog.failure('Could not download the file', describeError(error, 'The file could not be downloaded. Please try again.'));
    }
  };

  const handlePhaseDocumentDelete = async (doc: { id: string; fileName?: string; title?: string }) => {
    const name = doc.title || doc.fileName || 'this document';
    const confirmed = await systemDialog.confirm({
      title: `Remove “${name}”?`,
      description: 'The file is removed from this resident\'s documents. This cannot be undone.',
      confirmLabel: 'Remove file',
      tone: 'error',
    });
    if (!confirmed) return;
    try {
      await deleteDocument(doc.id);
      await loadData();
      await systemDialog.success('Document removed.', `“${name}” was removed from the resident's documents.`);
    } catch (error) {
      console.error('Document removal failed:', error);
      await systemDialog.failure('Could not remove the document', describeError(error, 'The document was not removed. Please try again.'));
    }
  };


  const currentPhaseIndex = CASE_PHASES.indexOf(currentPhase);


  // Live-derived from DataContext — updates instantly when any doc is added
  // For readmitted children, only show docs from CURRENT admission
  // (docs before admissionDate belong to previous offense, not shown in requirements)
  const currentChildRecord = children.find(c => c.id === residentId);
  // Use readmissionDate (if exists) as cutoff — only docs from current admission shown
  // readmissionDate is set on re-admit, admissionDate may be same for both offenses
  const docCutoffDatetime = currentChildRecord?.readmissionDatetime || '';
  const docCutoffDate = currentChildRecord?.readmissionDate || '';
  const isReadmitted = !!(currentChildRecord?.isRepeatOffender && (docCutoffDatetime || docCutoffDate));

  /**
   * The admissions on record for this resident, so a document can be matched to
   * its own instead of to a date.
   *
   * This mirrors `admissionPeriodsFor` in utils/admissionPeriods — the same list
   * the Documents folder splits on — because the two must not disagree about
   * where a document lives. The one admission this list cannot name is the open
   * one, which is what `currentAdmissionIds` below is for.
   */
  const admissionPeriods = useMemo(
    () => admissionPeriodsFor(currentChildRecord),
    [currentChildRecord],
  );
  const knownAdmissionIds = useMemo(
    () => new Set(admissionPeriods.map(p => p.admissionId).filter(Boolean)),
    [admissionPeriods],
  );

  const belongsToCurrentAdmission = (d: { residentId?: string; admissionId?: string; uploadedAt?: string }) => {
    if (d.residentId !== residentId) return false;
    if (!isReadmitted) return true; // new child — show all their docs

    // The document's own admission link, when it has one, decides outright — a
    // document filed under a previous admission is history, whichever date it
    // carries, and one filed under an admission the closed history does not name
    // is this admission's own. Only the timestamp fallback below is a guess.
    const linked = String(d.admissionId ?? '').trim();
    if (linked) return !knownAdmissionIds.has(linked);

    if (!d.uploadedAt) return false; // readmitted child — old doc with no timestamp = 1st offense, hide
    // Use full datetime comparison for precision
    if (docCutoffDatetime) {
      const docDT = d.uploadedAt.includes('T') ? d.uploadedAt : d.uploadedAt.replace(' ', 'T');
      return docDT >= docCutoffDatetime;
    }
    // Date-only fallback: strict greater-than (not >=) so same-day old docs are hidden
    if (docCutoffDate) {
      return d.uploadedAt.substring(0, 10) > docCutoffDate;
    }
    return true;
  };
  const residentDocs: ResidentDoc[] = allDocuments
    .filter(belongsToCurrentAdmission)
    .map(d => ({
      title: d.title,
      status: d.status as ResidentDoc['status'],
      uploadedBy: d.uploadedBy,
      uploadedAt: d.uploadedAt,
      phase: d.phase,
      fileData: d.fileData,
      fileName: d.fileName,
    }));

  // displayPhase: the phase whose content is shown — switches when user clicks a phase pill
  const displayPhase = viewingPhase || currentPhase;

  // displayRecord: the history record for the displayed phase (not necessarily the current DB record)
  const displayRecord = viewingPhase
    ? (history.find(h => h.phaseName === viewingPhase) || null)
    : currentRecord;

  // Requirements for the displayed phase
  const currentReq = requirements[displayPhase] || { requiredDocuments: [], requiredTasks: [], optionalDocuments: [] };
  const currentReqFull = requirements[displayPhase] as PhaseReqWithOptional | undefined;
  // Build effective documents list including conditional psych assessment
  // effectiveRequiredDocs — for the displayed phase
  const requiredDocsForCompletion: string[] = [
    ...(currentReq.requiredDocuments || []),
    ...((currentReqFull?.optionalDocuments || []).filter(doc =>
      doc === 'Psychological assessment (if needed)' && needsPsychAssessment
    )),
  ];
  const effectiveRequiredDocs: string[] = [
    ...requiredDocsForCompletion,
    ...((currentReqFull?.optionalDocuments || []).filter(doc =>
      !requiredDocsForCompletion.includes(doc)
    )),
  ];
  const optionalDisplayDocs = new Set(currentReqFull?.optionalDocuments || []);
  // Tasks always come from PHASE_REQUIREMENTS (backend constants) for the displayed phase
  const tasksRequired: string[] = currentReq.requiredTasks || [];
  const tasksOptional: string[] = (currentReq as any).optionalTasks || [];

  // ── Free-form documents uploaded for the displayed phase ──────────────────
  // These are the files the "Upload Document" button below produces. They are
  // listed here so the upload is visible where it was made; the same rows are
  // what the Documents module shows in the child's folder.
  const phaseUploadedDocs = allDocuments.filter(
    d => belongsToCurrentAdmission(d) && isPhaseUpload(d, displayPhase)
  );
  // Anyone who can submit documents may upload here — the same boundary the
  // server enforces on POST /documents. Houseparents are view-only in this tab.
  const canUploadDocument = !isHouseparent;
  // Removal mirrors the backend: the uploader may remove their own document
  // while it is not approved, Center Heads and Administrators may remove any.
  const canManageDocument = (doc: { uploadedBy?: string; status?: string }) => {
    if (isCenterHead || (user?.role || '').toLowerCase() === 'admin') return true;
    const owner = String(doc.uploadedBy || '').toLowerCase();
    return !!owner && owner === String(user?.username || '').toLowerCase() && doc.status !== 'Approved';
  };

  // Completed tasks: read from child's phaseTasksCompleted map for the displayed phase
  // This preserves each phase's checklist independently
  const tasksCompleted: string[] = viewingPhase
    ? (children.find(c => c.id === residentId)?.phaseTasksCompleted?.[viewingPhase] || displayRecord?.tasksCompleted || [])
    : localTasksCompleted;

  const tasksDone = tasksRequired.filter(t => tasksCompleted.includes(t)).length;
  const tasksTotal = tasksRequired.length;

  // ── Discharge eligibility (independent of whichever phase is being viewed) ──
  // Always evaluated against the resident's actual final phase, so browsing an
  // earlier phase's history doesn't change what the Discharge dialog shows.
  const finalPhaseName = CASE_PHASES[CASE_PHASES.length - 1];
  const allPreviousPhasesComplete = CASE_PHASES.slice(0, -1).every(phase =>
    !!history.find(h => h.phaseName === phase)?.completedAt
  );
  const finalPhaseReq = requirements[finalPhaseName] || { requiredDocuments: [], requiredTasks: [], optionalDocuments: [] };
  const finalPhaseReqFull = requirements[finalPhaseName] as PhaseReqWithOptional | undefined;
  const finalEffectiveDocs: string[] = [
    ...(finalPhaseReq.requiredDocuments || []),
    ...((finalPhaseReqFull?.optionalDocuments?.includes('Psychological Assessment') && needsPsychAssessment) ? ['Psychological Assessment'] : []),
  ];
  const finalTasksRequired: string[] = finalPhaseReq.requiredTasks || [];
  const finalTasksCompletedList: string[] = currentPhase === finalPhaseName && !viewingPhase
    ? localTasksCompleted
    : (children.find(c => c.id === residentId)?.phaseTasksCompleted?.[finalPhaseName] || currentRecord?.tasksCompleted || []);
  const finalTasksDone = finalTasksRequired.filter(t => finalTasksCompletedList.includes(t)).length;
  const finalApprovedDocs = finalEffectiveDocs.filter(doc =>
    residentDocs.some(d =>
      (d.title === doc || d.title?.toLowerCase() === doc.toLowerCase()) &&
      (d.phase === finalPhaseName || !d.phase || d.phase === '') &&
      d.status === 'Approved'
    )
  ).length;
  const finalTotalDone = finalTasksDone + finalApprovedDocs;
  const finalTotalAll = finalTasksRequired.length + finalEffectiveDocs.length;
  const finalPhaseAllDone = finalTotalAll > 0 && finalTotalDone === finalTotalAll;
  // "Not all phases are completed" — every earlier phase closed out AND the
  // final phase's own requirements are all met.
  const allPhasesComplete = allPreviousPhasesComplete && finalPhaseAllDone;
  const todayDateStr = new Date().toISOString().split('T')[0];
  const hasReachedEstimatedDate = !estimatedDischargeDate || todayDateStr >= estimatedDischargeDate;
  type DischargeCase = 'incomplete' | 'early' | 'ready';
  const dischargeCase: DischargeCase = !allPhasesComplete
    ? 'incomplete'
    : (!hasReachedEstimatedDate ? 'early' : 'ready');

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  // Case Closed display
  if (isCaseClosed) {
    const child = children.find(c => c.id === residentId);
    return (
      <div className="flex flex-col items-center justify-center py-16 space-y-6 text-center">
        <div className="w-24 h-24 bg-emerald-100 rounded-full flex items-center justify-center">
          <CheckCircle2 className="w-14 h-14 text-emerald-500" />
        </div>
        <div className="space-y-2">
          <h2 className="text-4xl font-black text-emerald-700 tracking-tight">CASE CLOSED</h2>
          <p className="text-gray-500 text-sm">
            <strong>{child?.name}</strong> has been officially discharged from Second Chance Home.
          </p>
          <p className="text-xs text-gray-400 italic">Record preserved and accessible in archives.</p>
        </div>
        <button
          onClick={handleDownloadDischargeReport}
          disabled={isGeneratingReport}
          className="flex items-center gap-2 px-6 py-3 bg-[#2F3E46] text-white rounded-xl hover:bg-[#1e2a30] font-semibold transition-all"
        >
          {isGeneratingReport ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
          Download Discharge Report
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-4">
      {/* Timeline Card */}
      <Card className="shadow-sm border border-gray-200 bg-white">
        <CardHeader className="border-b border-gray-200 pb-4 bg-gradient-to-r from-gray-50 to-white">
          <CardTitle className="text-base font-bold text-[#2F3E46] flex items-center gap-3">
            <Clock className="w-5 h-5 text-[#FFD100]" />
            <span>Phase Timeline</span>
          </CardTitle>
          <p className="text-xs text-gray-500 mt-1">Progression through rehabilitation phases</p>
        </CardHeader>
        <CardContent className="pt-6 space-y-6">
          {/* Phase progression indicators */}
          <div>
            <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide mb-4 flex items-center gap-2">
              <ChevronRight className="w-3.5 h-3.5 text-[#FFD100]" />
              Current Progress
            </h3>
            <div className="flex items-center gap-1.5 flex-wrap">
            {CASE_PHASES.map((phase, idx) => {
              const histEntry = history.find(h => h.phaseName === phase);
              const isCurrent = phase === currentPhase;
              const wasVisited = !!histEntry; // has a DB record = was visited
              const isDone = !!(histEntry?.completedAt);
              const isFuture = !wasVisited && !isCurrent; // never visited and not current
              const hasMissing = histEntry?.missingRequirements &&
                ((histEntry.missingRequirements.documents?.length || 0) > 0 || (histEntry.missingRequirements.tasks?.length || 0) > 0);
              // When viewing a different phase, current phase is also clickable to return
              const isBeingViewed = viewingPhase === phase;
              const canClick = wasVisited && (!isCurrent || !!viewingPhase); // allow clicking current when in view mode
              return (
                <div key={phase} className="flex items-center gap-1">
                  <button
                    disabled={isFuture}
                    onClick={() => {
                      if (isFuture) return;
                      if (isCurrent) {
                        // Always go to current phase when clicking it
                        setViewingPhase(null);
                      } else if (wasVisited) {
                        // Switch to this visited phase
                        setViewingPhase(phase);
                      }
                    }}
                    title={
                      isFuture  ? 'Phase not yet reached' :
                      isCurrent ? (viewingPhase ? 'Click to return to current phase' : 'Current phase') :
                      wasVisited ? 'Click to switch to this phase' :
                      'Phase not yet reached'
                    }
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-semibold transition-all ${
                      isFuture    ? 'bg-gray-100 text-gray-400 cursor-not-allowed opacity-50' :
                      isBeingViewed ? 'bg-blue-600 text-white shadow-sm ring-2 ring-blue-300 cursor-default' :
                      isCurrent && viewingPhase ? 'bg-[#2F3E46] text-white shadow-sm hover:bg-[#1e2a30] cursor-pointer' :
                      isCurrent   ? 'bg-[#2F3E46] text-white shadow-sm cursor-default' :
                      hasMissing  ? 'bg-red-100 text-red-800 border border-red-300 hover:bg-red-200 cursor-pointer' :
                      isDone      ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 cursor-pointer' :
                                  'bg-gray-100 text-gray-600 hover:bg-gray-200 cursor-pointer'
                    }`}
                  >
                    {hasMissing ? <AlertTriangle className="w-3.5 h-3.5" /> : isDone ? <CheckCircle2 className="w-3.5 h-3.5" /> : isFuture ? <Lock className="w-3.5 h-3.5" /> : <Circle className="w-3.5 h-3.5" />}
                    <span className="hidden sm:inline">{phase}</span>
                    <span className="sm:hidden text-xs">{idx + 1}</span>
                  </button>
                  {idx < CASE_PHASES.length - 1 && (
                    <div className={`w-4 h-0.5 transition-colors ${
                      isDone ? 'bg-emerald-300' : 'bg-gray-200'
                    }`} />
                  )}
                </div>
              );
            })}
            </div>
          </div>




      {/* Phase Requirements — shows displayPhase content */}
      {(currentRecord || displayRecord) && (
        <Card className="shadow-sm border border-gray-200 bg-white">
          <CardHeader className="border-b border-gray-200 pb-4 bg-gradient-to-r from-amber-50 to-white">
            <div className="flex items-center justify-between mb-2">
              <CardTitle className="text-base font-bold text-[#2F3E46] flex items-center gap-2">
                <ClipboardList className="w-5 h-5 text-[#FFD100]" />
                <span>{displayPhase}</span>
                {viewingPhase && viewingPhase !== currentPhase && (
                  <span className="text-xs font-normal text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                    actual current: {currentPhase}
                  </span>
                )}
              </CardTitle>
              {(() => {
                const approvedDocs = requiredDocsForCompletion.filter(doc =>
                  residentDocs.some(d =>
                    acceptedDocumentTitles(doc).includes(String(d.title || '').trim().toLowerCase()) &&
                    (d.phase === displayPhase || !d.phase || d.phase === '') &&
                    d.status === 'Approved'
                  )
                ).length;
                const totalDocs = requiredDocsForCompletion.length;
                const totalDone = tasksDone + approvedDocs;
                const totalAll = tasksTotal + totalDocs;
                const allDone = totalAll > 0 && totalDone === totalAll;
                return (
                  <Badge className={`text-xs font-bold ${allDone ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                    {totalDone}/{totalAll} Complete
                  </Badge>
                );
              })()}
            </div>
            <p className="text-xs text-gray-500">Current phase requirements and progress</p>
          </CardHeader>
          <CardContent className="pt-5 space-y-5">
            {/* Violation Warning Banner */}
            {violationBlock && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-red-700">
                      🚫 Phase Advancement BLOCKED
                    </p>
                    <p className="text-xs text-red-600 mt-1">
                      {violationBlock.violationCount} unresolved violation(s) exist. 
                      Must resolve all violations before advancing.
                    </p>
                    {violationBlock.demotionRecommended && isCenterHead && (
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={handleDemote}
                          disabled={demoting}
                          className="text-xs"
                        >
                          {demoting ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                          Demote Phase
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => window.location.href = `/violations?residentId=${residentId}`}
                          className="text-xs"
                        >
                          View Violations
                        </Button>
                      </div>
                    )}
                    {!isCenterHead && violationBlock.demotionRecommended && (
                      <p className="text-xs text-orange-600 mt-1">
                        ⚠️ Center Head review required for demotion
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Required Documents — live status */}
            {effectiveRequiredDocs.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
                  <FileText className="w-3 h-3" /> Required Documents
                </p>
                <div className="space-y-1.5">
                  {effectiveRequiredDocs.map(doc => {
                    const matchingDocs = residentDocs.filter(
                      d => acceptedDocumentTitles(doc).includes(String(d.title || '').trim().toLowerCase()) &&
                        (d.phase === displayPhase || !d.phase || d.phase === '')
                    );
                    // Multiple submissions are allowed for phase documents. Use
                    // the strongest/current submission for the status display.
                    const statusRank: Record<string, number> = { Approved: 4, Submitted: 3, Reassessment: 2, Rejected: 1, Draft: 0 };
                    const uploaded = [...matchingDocs].sort((a, b) =>
                      (statusRank[b.status] || 0) - (statusRank[a.status] || 0) ||
                      String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || ''))
                    )[0];
                    const status = uploaded?.status || 'Missing';
                    const isReassessment = status === 'Reassessment';
                    return (
                      <div key={doc} className={`flex flex-col gap-1 text-sm p-2 rounded-lg border ${
                        status === 'Approved'      ? 'bg-green-50 border-green-200' :
                        isReassessment            ? 'bg-yellow-50 border-yellow-300' :
                        status === 'Submitted'     ? 'bg-blue-50 border-blue-200' :
                        status === 'Rejected'      ? 'bg-red-50 border-red-200' :
                                                     'bg-gray-50 border-gray-200'
                      }`}>
                        <div className="flex items-center gap-2">
                        {status === 'Approved'  ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" /> :
                         isReassessment         ? <AlertTriangle className="w-3.5 h-3.5 text-yellow-600 shrink-0" /> :
                         status === 'Submitted' ? <Clock className="w-3.5 h-3.5 text-blue-500 shrink-0" /> :
                         status === 'Rejected'  ? <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" /> :
                                                  <Circle className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
                        <span className={`flex-1 ${
                          status === 'Approved' ? 'text-green-800 font-medium' :
                          isReassessment        ? 'text-yellow-800 font-medium' :
                          status === 'Submitted' ? 'text-blue-800' :
                          status === 'Rejected' ? 'text-red-700 line-through' :
                          'text-gray-600'
                        }`}>{doc}{optionalDisplayDocs.has(doc) && <span className="text-[10px] text-gray-400 ml-1">(Optional)</span>}</span>
                        <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
                          status === 'Approved'  ? 'bg-green-100 text-green-700' :
                          isReassessment        ? 'bg-yellow-100 text-yellow-700' :
                          status === 'Submitted' ? 'bg-blue-100 text-blue-700' :
                          status === 'Rejected'  ? 'bg-red-100 text-red-700' :
                                                   'bg-gray-200 text-gray-500'
                        }`}>{isReassessment ? 'Reassessment' : status}</span>
                        </div>
                        {isReassessment && uploaded && (
                          <div className="flex items-center gap-2 pl-5">
                            <span className="text-[10px] text-yellow-700">Document needs revision.</span>
                            {uploaded.rejectionReason && (
                              <span className="text-[10px] text-yellow-600 italic">{uploaded.rejectionReason.replace('Reassessment required. ', '')}</span>
                            )}
                          </div>
                        )}
                        {(status === 'Approved' || status === 'Submitted') && (uploaded as any)?.fileData && (
                          <a
                            href={(uploaded as any).fileData}
                            download={(uploaded as any).fileName || doc}
                            className="text-[10px] text-[#2F3E46] underline flex items-center gap-0.5 shrink-0"
                            title="Download"
                          >
                            <Download className="w-3 h-3" />
                          </a>
                        )}
                        {(status === 'Missing' || status === 'Rejected' || status === 'Reassessment') && (() => {
                          const allowedRoles = DOCUMENT_ROLE_PERMISSIONS[doc];
                          const userRole = (user?.role || '').toLowerCase();
                          // Houseparents are view-only in this tab regardless of
                          // DOCUMENT_ROLE_PERMISSIONS — a document type not
                          // listed there defaults to allowing every role, which
                          // would otherwise let a Houseparent upload it.
                          const canUpload = !isHouseparent && (!allowedRoles || allowedRoles.includes(userRole));
                          const roleDisplayNames: Record<string,string> = {
                            socialworker: 'Social Worker', psychologist: 'Psychologist',
                            centerhead: 'Center Head', nurse: 'Nurse', educator: 'Educator',
                          };
                          const roleLabel = allowedRoles
                            ? allowedRoles.map(r => roleDisplayNames[r] || r).join(' / ') + ' only'
                            : '';
                          return canUpload ? (
                            <div className="flex items-center gap-1 shrink-0">
                              {roleLabel && (
                                <span className="text-[9px] text-blue-500 italic">{roleLabel}</span>
                              )}
                              <input
                                type="file"
                                ref={el => { uploadRefs.current[doc] = el; }}
                                className="hidden"
                                accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.xls,.xlsx"
                                onChange={async (e) => {
                                  const file = e.target.files?.[0];
                                  if (file) await handleInlineUpload(doc, file);
                                  if (e.target) e.target.value = '';
                                }}
                              />
                              <button
                                onClick={() => uploadRefs.current[doc]?.click()}
                                disabled={uploadingDoc === doc}
                                className="text-[10px] bg-[#2F3E46] text-white px-2 py-0.5 rounded flex items-center gap-0.5 hover:bg-[#1e2a30] disabled:opacity-60"
                                title="Upload document"
                              >
                                {uploadingDoc === doc ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                                Upload
                              </button>
                            </div>
                          ) : (
                            <span className="text-[10px] text-red-400 italic shrink-0 font-semibold">
                              🔒 {roleLabel}
                            </span>
                          );
                        })()}
                        {status === 'Submitted' && (
                          <span className="text-[10px] text-blue-500 italic shrink-0">Pending review</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {isCenterHead && residentDocs.some(d =>
                  effectiveRequiredDocs.includes(d.title) && d.status === 'Submitted'
                ) && (
                  <a href="/documents" className="mt-2 flex items-center gap-1 text-xs text-[#2F3E46] font-semibold hover:underline">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Go to Documents to approve pending submissions
                  </a>
                )}
              </div>
            )}

            {/* ── PHASE DOCUMENTS — free-form upload ──────────────────────
                A plain upload button for every phase, Admission included. It is
                not tied to any required document: whatever paperwork the user
                has, they name it and it is filed under this child and phase. */}
            <div className="rounded-lg border border-[#2F3E46]/15 bg-[#f8f9fa] p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1">
                  <FolderOpen className="w-3 h-3" /> Phase Documents
                </p>
                {canUploadDocument && (
                  <button
                    type="button"
                    onClick={() => { setDocUploadError(''); setIsDocUploadOpen(true); }}
                    className="text-[11px] font-bold bg-[#2F3E46] text-white px-3 py-1.5 rounded-lg flex items-center gap-1.5 hover:bg-[#1e2a30] transition-colors"
                    title={`Upload any document for ${displayPhase}`}
                  >
                    <Upload className="w-3.5 h-3.5" /> Upload Document
                  </button>
                )}
              </div>
              <p className="text-[11px] text-gray-500 mt-1">
                Optional. Any scanned form or supporting paperwork for {displayPhase} — saved to this
                child's Documents folder.
              </p>

              {phaseUploadedDocs.length === 0 ? (
                <p className="text-[11px] text-gray-400 italic mt-2">No documents uploaded for this phase yet.</p>
              ) : (
                <div className="mt-2 space-y-1">
                  {phaseUploadedDocs.map(doc => (
                    <div key={doc.id} className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5">
                      <FileText className="w-3.5 h-3.5 text-[#2F3E46] shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-[#2F3E46] truncate">{doc.title}</p>
                        <p className="text-[10px] text-gray-400 truncate">
                          {[
                            doc.fileName,
                            doc.uploadedAt ? formatShortDate(doc.uploadedAt) : '',
                            doc.uploadedBy,
                          ].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => viewStoredDocument(doc)}
                        className="text-[10px] text-[#2F3E46] underline shrink-0"
                        title={`View ${doc.title}`}
                      >
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadStoredDocument(doc)}
                        className="text-[#2F3E46] shrink-0"
                        title="Download"
                      >
                        <Download className="w-3 h-3" />
                      </button>
                      {canManageDocument(doc) && (
                        <button
                          type="button"
                          onClick={() => handlePhaseDocumentDelete(doc)}
                          className="text-red-500 shrink-0"
                          title="Remove"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Checklist Tasks */}
            {tasksRequired.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
                  <ClipboardList className="w-3 h-3" /> Requirements
                </p>
                <div className="space-y-1">
                  {[...tasksRequired, ...tasksOptional].map(task => {
                    const done = taskIsCompleted(task, tasksCompleted);
                    const isOptional = tasksOptional.includes(task);
                    return (
                      <label key={task} className="flex items-start gap-2 text-sm cursor-pointer p-1.5 rounded hover:bg-gray-50 group">
                        <input
                          type="checkbox"
                          checked={done}
                          onChange={(e) => handleToggleTask(task, e.target.checked)}
                          className="mt-0.5 accent-green-600"
                          disabled={isHouseparent && displayPhase !== 'Orientation Phase'}
                        />
                        <span className={done ? 'line-through text-gray-400' : 'text-gray-700'}>
                          {task} {isOptional && <span className="text-[10px] text-gray-400">(Optional)</span>}
                        </span>
                        {done && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 ml-auto shrink-0" />}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}


            {/* Conditional Psych Assessment Toggle (Admission Phase only, after base docs uploaded) */}
            {currentPhase === 'Admission Phase' && (user?.role === 'socialworker' || user?.role === 'centerhead') && (() => {
              const baseDocs = currentReq.requiredDocuments || [];
              const allBaseUploaded = baseDocs.length > 0 && baseDocs.every(doc =>
                residentDocs.some(d =>
                  (d.title === doc || d.title?.toLowerCase() === doc.toLowerCase()) &&
                  (d.phase === currentPhase || !d.phase || d.phase === '') &&
                  (d.status === 'Submitted' || d.status === 'Approved')
                )
              );
              return allBaseUploaded ? (
                <div className="p-3 bg-purple-50 border border-purple-200 rounded-lg">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={needsPsychAssessment}
                      onChange={(e) => handleTogglePsychAssessment(e.target.checked)}
                      disabled={togglingPsych}
                      className="w-4 h-4 accent-purple-600"
                    />
                    <div>
                      <p className="text-sm font-medium text-purple-800">Does this child need a Psychological Assessment?</p>
                      <p className="text-xs text-purple-600">
                        {needsPsychAssessment
                          ? 'Flagged — Psychologist has been notified. Waiting for assessment upload.'
                          : 'Check this to flag and notify the Psychologist to conduct an assessment.'}
                      </p>
                    </div>
                  </label>
                </div>
              ) : (
                <div className="p-2 bg-gray-50 border border-gray-200 rounded-lg">
                  <p className="text-xs text-gray-500 italic">
                    Upload all required documents first to decide if a Psychological Assessment is needed.
                  </p>
                </div>
              );
            })()}

            {/* Advance or Discharge Button */}
            {!isHouseparent && (
            <div className="pt-2 border-t border-gray-100">
              {currentPhase === CASE_PHASES[CASE_PHASES.length - 1] ? (
                <Button
                  onClick={() => {
                    setDischargeDate(todayDateStr);
                    setDischargeNote('');
                    setIsDischargePopupOpen(true);
                  }}
                  className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold"
                  size="sm"
                >
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Discharge
                </Button>
              ) : (
                <Button
                  onClick={handleValidate}
                  disabled={validating}
                  className="w-full bg-[#2F3E46] hover:bg-[#1e2a30] text-white"
                  size="sm"
                >
                  {validating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ChevronRight className="w-4 h-4 mr-2" />}
                  Check & Advance to Next Phase
                </Button>
              )}
            </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Advance Dialog */}
      <Dialog open={isAdvanceDialogOpen} onOpenChange={(open) => { setIsAdvanceDialogOpen(open); if (!open) setShowAdvanceConfirm(false); }}>
        <DialogContent className="max-w-lg w-full overflow-y-auto max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {validationResult?.canAdvance
                ? <CheckCircle2 className="w-5 h-5 text-green-500" />
                : <AlertTriangle className="w-5 h-5 text-orange-500" />}
              Advance Phase: {currentPhase}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className={`p-3 rounded-lg text-sm ${validationResult?.canAdvance ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-orange-50 text-orange-800 border border-orange-200'}`}>
              {validationResult?.message}
            </div>

            {validationResult && !validationResult.canAdvance && (
              <div className="space-y-2">
                {validationResult.missingRequirements.violations && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                    <p className="text-xs font-semibold text-red-700 mb-1">
                      <AlertTriangle className="w-3 h-3 inline mr-1" />
                      Violations Blocking Advancement:
                    </p>
                    <p className="text-xs text-red-600">
                      {validationResult.violationBlock?.violationCount} unresolved violation(s)
                    </p>
                    {validationResult.violationBlock?.demotionRecommended && (
                      <p className="text-xs text-red-700 mt-1 font-medium">
                        ⚠️ Demotion to previous phase is recommended
                      </p>
                    )}
                  </div>
                )}
                {validationResult.missingRequirements.documents.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-red-600 mb-1">Missing Documents:</p>
                    {validationResult.missingRequirements.documents.map(d => (
                      <div key={d} className="flex items-center gap-1 text-xs text-red-700 ml-2">
                        <AlertTriangle className="w-3 h-3" /> {d}
                      </div>
                    ))}
                  </div>
                )}
                {validationResult.missingRequirements.tasks.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-orange-600 mb-1">Incomplete Tasks:</p>
                    {validationResult.missingRequirements.tasks.map(t => (
                      <div key={t} className="flex items-center gap-1 text-xs text-orange-700 ml-2">
                        <Circle className="w-3 h-3" /> {t}
                      </div>
                    ))}
                  </div>
                )}
                {isCenterHead && (
                  <div className="p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-800">
                    <strong>Center Head Override:</strong> You can force-advance despite incomplete requirements.
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs">Notes (optional)</Label>
              <Textarea
                value={advanceNotes}
                onChange={e => setAdvanceNotes(e.target.value)}
                placeholder="Add notes about this phase completion..."
                rows={2}
                className="text-sm"
              />
            </div>
          </div>

          <DialogFooter className="flex flex-wrap gap-2 justify-end">
            <Button variant="outline" onClick={() => setIsAdvanceDialogOpen(false)}>Cancel</Button>
            {(validationResult?.canAdvance || isCenterHead) && !showAdvanceConfirm && (
              <Button
                onClick={() => setShowAdvanceConfirm(true)}
                className={validationResult?.canAdvance ? 'bg-green-600 hover:bg-green-700 text-white' : 'bg-orange-500 hover:bg-orange-600 text-white'}
              >
                <ChevronRight className="w-4 h-4 mr-2" />
                {validationResult?.canAdvance ? 'Advance Phase' : 'Force Advance (Override)'}
              </Button>
            )}
            {showAdvanceConfirm && (
              <div className="flex flex-col w-full gap-2 border border-amber-300 bg-amber-50 rounded-lg p-3">
                <p className="text-sm font-semibold text-amber-800 text-center">
                  ⚠ Are you sure you want to approve and advance this phase?
                </p>
                <p className="text-xs text-amber-600 text-center">
                  This will mark <strong>{currentPhase}</strong> as completed and move the resident to the next phase.
                </p>
                <div className="flex gap-2 mt-1">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setShowAdvanceConfirm(false)}
                  >
                    Cancel — Stay in Phase
                  </Button>
                  <Button
                    onClick={() => { setShowAdvanceConfirm(false); handleAdvance(); }}
                    disabled={advancing}
                    className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                  >
                    {advancing ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <CheckCircle2 className="w-4 h-4 mr-1" />}
                    Yes, Approve & Advance
                  </Button>
                </div>
              </div>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── DISCHARGE POPUP ──────────────────────────────────────────────── */}
      {/* CASE CLOSURE CONFIRMATION DIALOG */}
      <Dialog open={isDischargePopupOpen} onOpenChange={(open) => { setIsDischargePopupOpen(open); if (!open) setShowDischargeConfirmPrompt(false); }}>
        <DialogContent className="max-w-md">
          {!isDischargeConfirmed ? (
            <>
              {!showDischargeConfirmPrompt ? (
                /* ── Step 1: Pre-confirmation prompt ── */
                <>
                  <DialogHeader>
                    <DialogTitle className={`flex items-center gap-2 text-lg ${dischargeCase === 'incomplete' ? 'text-amber-600' : dischargeCase === 'early' ? 'text-blue-600' : 'text-emerald-700'}`}>
                      {dischargeCase === 'ready' ? <CheckCircle2 className="w-5 h-5" /> : '⚠'} Are you sure you want to close this case?
                    </DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 py-2">
                    {dischargeCase === 'incomplete' && (
                      <div className="p-4 bg-amber-50 border border-amber-300 rounded-lg">
                        <p className="text-amber-900 text-sm font-semibold">
                          You are about to officially close the case of{' '}
                          <strong>{children.find(c => c.id === residentId)?.name}</strong>.
                        </p>
                        <p className="text-amber-700 text-xs mt-2">
                          This will discharge the resident from the shelter and mark the case as <strong>Closed</strong>, even though not
                          all phase requirements are complete yet.
                        </p>
                      </div>
                    )}

                    {dischargeCase === 'early' && (
                      <div className="p-4 bg-blue-50 border border-blue-300 rounded-lg space-y-2">
                        <p className="text-blue-900 text-sm font-semibold">
                          You are about to officially close the case of{' '}
                          <strong>{children.find(c => c.id === residentId)?.name}</strong>.
                        </p>
                        <p className="text-blue-700 text-xs">
                          The current date has not yet reached the Estimated Discharge Date. Please confirm you still want to proceed.
                        </p>
                      </div>
                    )}

                    {dischargeCase === 'ready' && (
                      <div className="p-4 bg-emerald-50 border border-emerald-300 rounded-lg space-y-2">
                        <p className="text-emerald-900 text-sm font-semibold">
                          You are about to officially close the case of{' '}
                          <strong>{children.find(c => c.id === residentId)?.name}</strong>.
                        </p>
                        <p className="text-emerald-700 text-xs">
                          All phase requirements are complete and the Estimated Discharge Date has been reached. Please confirm to
                          proceed — this will mark the case as <strong>Closed</strong>.
                        </p>
                      </div>
                    )}

                    {/* Estimated Discharge Date — shown in every case */}
                    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 flex items-center justify-between">
                      <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Estimated Discharge Date</p>
                      <p className="text-sm font-semibold text-[#2F3E46]">
                        {estimatedDischargeDate ? formatShortDate(estimatedDischargeDate) : 'Not set'}
                      </p>
                    </div>

                    {/* Shelter Recommendation */}
                    <div className="space-y-2">
                      <p className="text-sm font-bold text-[#2F3E46]">Shelter Recommendation *</p>
                      <div className="flex gap-2">
                        {(['For Reintegration', 'For Transfer'] as const).map(rec => (
                          <button
                            key={rec}
                            type="button"
                            onClick={() => setDischargeRecommendation(rec)}
                            className={`flex-1 p-3 rounded-xl border-2 text-sm font-semibold transition-all ${
                              dischargeRecommendation === rec
                                ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                                : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                            }`}
                          >
                            {rec}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Discharge Date — auto-set to today, not editable */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-bold text-[#2F3E46]">Discharge Date</p>
                        <span className="text-xs text-gray-400">Set to today, not editable</span>
                      </div>
                      <div className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-[#2F3E46]">
                        {formatShortDate(todayDateStr)}
                      </div>
                    </div>

                    {/* Note — only relevant while requirements are still incomplete */}
                    {dischargeCase === 'incomplete' && (
                      <div className="space-y-1">
                        <p className="text-sm font-bold text-[#2F3E46]">Note</p>
                        <Textarea
                          value={dischargeNote}
                          onChange={(e) => setDischargeNote(e.target.value)}
                          placeholder="Reason or additional information for closing this case before all requirements are complete…"
                          className="text-sm"
                          rows={3}
                        />
                      </div>
                    )}

                    {dischargeCase === 'early' && (
                      <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                        Today's date is earlier than the Estimated Discharge Date shown above. Confirm below if you still want to
                        discharge now.
                      </p>
                    )}

                    <div className="flex gap-3">
                      <Button
                        variant="ghost"
                        className="flex-1"
                        onClick={() => setIsDischargePopupOpen(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                        disabled={!dischargeRecommendation}
                        onClick={() => setShowDischargeConfirmPrompt(true)}
                      >
                        Yes, proceed to close case
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                /* ── Step 2: Discharge actions ── */
                <>
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-emerald-700 text-lg">
                      <CheckCircle2 className="w-6 h-6 text-emerald-500" />
                      {dischargeCase === 'ready' ? 'Ready for Discharge' : 'Confirm Discharge'}
                    </DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 py-2">
                    <div className={`p-4 rounded-lg border ${dischargeCase === 'ready' ? 'bg-emerald-50 border-emerald-200' : dischargeCase === 'early' ? 'bg-blue-50 border-blue-200' : 'bg-amber-50 border-amber-200'}`}>
                      {dischargeCase === 'ready' && (
                        <p className="text-emerald-800 text-sm font-semibold">
                          {children.find(c => c.id === residentId)?.name} has completed all requirements
                          of the <strong>Reintegration/Aftercare Program</strong> and is ready for discharge.
                        </p>
                      )}
                      {dischargeCase === 'early' && (
                        <p className="text-blue-800 text-sm font-semibold">
                          {children.find(c => c.id === residentId)?.name} has completed all requirements, but today's date is earlier
                          than the Estimated Discharge Date ({estimatedDischargeDate ? formatShortDate(estimatedDischargeDate) : 'not set'}).
                          Confirm below to discharge now anyway.
                        </p>
                      )}
                      {dischargeCase === 'incomplete' && (
                        <p className="text-amber-800 text-sm font-semibold">
                          {children.find(c => c.id === residentId)?.name} has not yet completed every requirement
                          of the <strong>Reintegration/Aftercare Program</strong>. Confirm below to discharge anyway.
                        </p>
                      )}
                    </div>
                    <div className="space-y-3">
                      <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Discharge Actions</p>
                      <button
                        onClick={handleDownloadDischargeReport}
                        disabled={isGeneratingReport}
                        className="w-full flex items-center gap-3 p-3 border-2 border-[#2F3E46] rounded-xl hover:bg-[#2F3E46] hover:text-white transition-all group"
                      >
                        <div className="p-2 bg-[#2F3E46] text-white rounded-lg group-hover:bg-white group-hover:text-[#2F3E46] transition-all">
                          {isGeneratingReport ? <Loader2 className="w-5 h-5 animate-spin" /> : <FileText className="w-5 h-5" />}
                        </div>
                        <div className="text-left">
                          <p className="font-bold text-sm">Download Discharge Report</p>
                          <p className="text-xs opacity-60">Generates a complete case summary report</p>
                        </div>
                      </button>
                      <button
                        onClick={handleConfirmDischarge}
                        disabled={isConfirmingDischarge}
                        className="w-full flex items-center gap-3 p-3 border-2 border-emerald-500 rounded-xl hover:bg-emerald-500 hover:text-white transition-all group"
                      >
                        <div className="p-2 bg-emerald-500 text-white rounded-lg group-hover:bg-white group-hover:text-emerald-500 transition-all">
                          {isConfirmingDischarge ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
                        </div>
                        <div className="text-left">
                          <p className="font-bold text-sm">Confirm Discharge</p>
                          <p className="text-xs opacity-60">Marks the child as officially discharged</p>
                        </div>
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button variant="ghost" onClick={() => { setShowDischargeConfirmPrompt(false); setIsDischargePopupOpen(false); }}>Cancel</Button>
                  </div>
                </>
              )}
            </>
          ) : (
            // ── DISCHARGE CONFIRMED SCREEN ────────────────────────────────
            <div className="py-8 text-center space-y-5">
              <div className="flex justify-center">
                <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center">
                  <CheckCircle2 className="w-12 h-12 text-emerald-500" />
                </div>
              </div>
              <div className="space-y-2">
                <h2 className="text-2xl font-black text-emerald-700">Case Closed</h2>
                <p className="text-gray-600 text-sm">
                  <strong>{children.find(c => c.id === residentId)?.name}</strong> has been
                  officially discharged from Second Chance Home.
                </p>
              </div>
              <div className="p-4 bg-gray-50 rounded-xl text-left space-y-1 text-sm text-gray-600">
                <p>✅ All rehabilitation phases completed</p>
                <p>✅ Required documents filed and archived</p>
                <p>✅ Guardian notified of discharge</p>
                <p>✅ After-care support arranged</p>
                <p>✅ Child status updated to <strong>Discharged</strong></p>
              </div>
              <p className="text-xs text-gray-400 italic">
                The child's record has been preserved and can be accessed in the archives.
              </p>
              <Button
                onClick={() => { setIsDischargePopupOpen(false); setIsDischargeConfirmed(false); }}
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-8"
              >
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Upload Document dialog — free-form, per phase ─────────────── */}
      <Dialog open={isDocUploadOpen} onOpenChange={(open) => { if (!open) closeDocUpload(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="w-4 h-4 text-[#FFD100]" /> Upload Document — {displayPhase}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <p className="text-xs text-gray-500">
              Any scanned form or supporting paperwork. It will be saved to this child's Documents
              folder under {displayPhase}.
            </p>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Document Name *</Label>
              <Input
                value={docUploadName}
                onChange={e => setDocUploadName(e.target.value)}
                placeholder="e.g. Signed Court Order (scanned)"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Description (optional)</Label>
              <Textarea
                value={docUploadDescription}
                onChange={e => setDocUploadDescription(e.target.value)}
                placeholder="Anything worth noting about this document"
                rows={2}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">File *</Label>
              <input
                ref={docUploadInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                onChange={e => setDocUploadFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-[#2F3E46] file:px-3 file:py-2 file:text-xs file:font-bold file:text-white hover:file:bg-[#1e2a30]"
              />
              <p className="text-[11px] text-gray-400">PDF, JPG or PNG recommended.</p>
            </div>

            {docUploadError && (
              <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {docUploadError}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDocUpload} disabled={isDocUploading}>
              Cancel
            </Button>
            <Button
              onClick={handleDocUpload}
              disabled={isDocUploading || !docUploadFile || !docUploadName.trim()}
              className="bg-[#2F3E46]"
            >
              {isDocUploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Upload className="w-4 h-4 mr-2" />}
              {isDocUploading ? 'Uploading...' : 'Upload Document'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DISCHARGE REPORT SIGNATURE */}
      <Dialog
        open={isDischargeSignOpen}
        onOpenChange={(open) => {
          // Cancelling (Escape / overlay click / the Cancel button all route
          // through here) discards the draft names and signatures and stops an
          // in-flight generation from finishing — nothing is saved,
          // submitted, or written to the report once this fires.
          if (!open) {
            dischargeGenerationCancelledRef.current = true;
            setDischargeSignerName('');
            setDischargePreparedBySignature('');
            setDischargeApprovedByName('');
            setDischargeApprovedBySignature('');
            setIsGeneratingReport(false);
          }
          setIsDischargeSignOpen(open);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46]">Sign the Discharge Report</DialogTitle>
            <DialogDescription>
              Two signatures are printed on the report, each above its printed name: the staff who
              prepared it and the approving authority. Leave a pad blank to print that form with an
              empty line instead.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-6 py-2 sm:grid-cols-2">
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-sm font-bold" htmlFor="discharge-prepared-by-name">Prepared by — Full Name</Label>
                <Input
                  id="discharge-prepared-by-name"
                  value={dischargeSignerName}
                  onChange={(e) => setDischargeSignerName(e.target.value)}
                  placeholder="Enter full name"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-bold">Prepared by signature</Label>
                <div className="h-28 w-full">
                  <SignaturePadModal
                    label="Prepared by signature"
                    value={dischargePreparedBySignature}
                    onChange={setDischargePreparedBySignature}
                    hint="Tap to sign"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-sm font-bold" htmlFor="discharge-approved-by-name">Approving authority — Full Name</Label>
                <Input
                  id="discharge-approved-by-name"
                  value={dischargeApprovedByName}
                  onChange={(e) => setDischargeApprovedByName(e.target.value)}
                  placeholder="Enter full name"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-bold">Approving authority signature</Label>
                <div className="h-28 w-full">
                  <SignaturePadModal
                    label="Approving authority signature"
                    value={dischargeApprovedBySignature}
                    onChange={setDischargeApprovedBySignature}
                    hint="Tap to sign"
                  />
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            {/* Always clickable — including while a report is being generated,
                so Cancel can stop that in-flight generation instead of being
                greyed out and leaving the user stuck on this screen. */}
            <Button
              variant="outline"
              onClick={() => {
                dischargeGenerationCancelledRef.current = true;
                setDischargeSignerName('');
                setDischargePreparedBySignature('');
                setDischargeApprovedByName('');
                setDischargeApprovedBySignature('');
                setIsGeneratingReport(false);
                setIsDischargeSignOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => buildDischargeReport(dischargePreparedBySignature, dischargeApprovedBySignature)}
              disabled={isGeneratingReport}
              className="bg-[#2F3E46] text-white gap-2"
            >
              {isGeneratingReport ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Generate Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

          {/* History table */}
          {history.length > 0 && (
            <div className="border-t border-gray-200 pt-6">
              <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide mb-4 flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-[#FFD100]" />
                <span>Phase History</span>
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b-2 border-gray-200 bg-gray-50">
                      <th className="text-left px-4 py-3 font-bold text-gray-700">Phase</th>
                      <th className="text-left px-4 py-3 font-bold text-gray-700">Started</th>
                      <th className="text-left px-4 py-3 font-bold text-gray-700">Completed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {history.map(h => {
                      const hasIncomplete = h.missingRequirements &&
                        ((h.missingRequirements.documents?.length || 0) > 0 ||
                         (h.missingRequirements.tasks?.length || 0) > 0);
                      return (
                      <tr key={h.id} className={`transition-colors ${
                        h.isCurrent ? 'bg-yellow-50/60 hover:bg-yellow-50' :
                        hasIncomplete && !h.completedAt ? 'bg-red-50 hover:bg-red-100' :
                        'hover:bg-gray-50'
                      }`}>
                        <td className="px-4 py-3 flex items-center gap-3">
                          <div className="flex-shrink-0">
                            {h.completedAt ? (
                              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                            ) : hasIncomplete ? (
                              <AlertTriangle className="w-5 h-5 text-red-500" />
                            ) : (
                              <Circle className="w-5 h-5 text-gray-300" />
                            )}
                          </div>
                          <div>
                            <p className={`font-semibold ${hasIncomplete && !h.completedAt ? 'text-red-700' : 'text-gray-900'}`}>{h.phaseName}</p>
                            {h.isCurrent && (
                              <Badge className="mt-1 text-[10px] bg-[#2F3E46] text-white px-2">Current</Badge>
                            )}
                            {hasIncomplete && !h.completedAt && (
                              <p className="text-[10px] text-red-600 font-bold mt-0.5">Incomplete</p>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-600 font-mono text-xs">{formatShortDateTime(h.enteredAt)}</td>
                        <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                          {h.completedAt && !h.isCurrent && !hasIncomplete ? formatShortDateTime(h.completedAt) : '—'}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
