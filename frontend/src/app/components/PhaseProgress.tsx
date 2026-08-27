import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { CheckCircle2, Circle, ChevronRight, AlertTriangle, Lock, ClipboardList, FileText, Loader2, Upload, Clock, XCircle, Download } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/dialog';
import { Textarea } from '@/app/components/ui/textarea';
import { Label } from '@/app/components/ui/label';
import { request } from '@/services/api';
import { useAuth } from '../state/AuthContext';
import { useData } from '../state/DataContext';
import { formatShortDate, formatShortDateTime } from '@/utils/dateFormatter';

const CASE_PHASES = [
  'Admission Phase',
  'Orientation Phase',
  'Enculturation/Observation Phase',
  'Caring & Rehabilitation Phase / DP or IPP Implementation',
  'Pre-integration Phase',
  'Reintegration/Aftercare Program',
];

const DOCUMENT_ROLE_PERMISSIONS: Record<string, string[]> = {
  'Court Order':                        ['socialworker', 'centerhead'],
  'OCP Resolution':                     ['socialworker', 'centerhead'],
  'Case Information':                   ['socialworker', 'centerhead'],
  'Diversion Plan Referral Letter':     ['socialworker', 'centerhead'],
  'Medical Certificate / Birth Certificate': ['socialworker', 'centerhead'],
  'Baptismal Certificate':              ['socialworker', 'centerhead'],
  'Psychological Assessment':           ['psychologist', 'centerhead'],
  'Psychological Testing':              ['psychologist', 'centerhead'],
  'Discernment Assessment':             ['psychologist', 'centerhead'],
  'SCSR':                               ['socialworker', 'centerhead'],
  'Parenting Capability Assessment':    ['psychologist', 'centerhead'],
};

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
}

interface Props {
  residentId: string;
  currentPhase: string;
  onPhaseAdvanced?: () => void;
}

interface PhaseReqWithOptional {
  requiredDocuments: string[];
  optionalDocuments?: string[];
  requiredTasks: string[];
  manualCompletion?: boolean;
}

export function PhaseProgress({ residentId, currentPhase, onPhaseAdvanced }: Props) {
  const { user } = useAuth();
  const { addDocument, documents: allDocuments, updateChild, children, generateReport, refreshData } = useData();
  const isCenterHead = user?.role === 'centerhead';
  const uploadRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const [history, setHistory] = useState<PhaseRecord[]>([]);
  const [currentRecord, setCurrentRecord] = useState<PhaseRecord | null>(null);
  const [requirements, setRequirements] = useState<PhaseRequirements>({});
  // Derive residentDocs live from DataContext — no separate state needed
  const [loading, setLoading] = useState(true);
  const [validating, setValidating] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState<string | null>(null);
  const [isDischargePopupOpen, setIsDischargePopupOpen] = useState(false);
  const [isDischargeConfirmed, setIsDischargeConfirmed] = useState(false);
  const [showDischargeConfirmPrompt, setShowDischargeConfirmPrompt] = useState(false);
  const [isCaseClosed, setIsCaseClosed] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [isConfirmingDischarge, setIsConfirmingDischarge] = useState(false);
  const [localTasksCompleted, setLocalTasksCompleted] = useState<string[]>([]);
  const [tasksInitialized, setTasksInitialized] = useState(false);
  const [needsPsychAssessment, setNeedsPsychAssessment] = useState(false);
  const [togglingPsych, setTogglingPsych] = useState(false);
  const [demoting, setDemoting] = useState(false);

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
    // Optimistic local update first (instant UI response)
    const newTasks = done
      ? [...localTasksCompleted.filter(t => t !== task), task]
      : localTasksCompleted.filter(t => t !== task);
    setLocalTasksCompleted(newTasks);

    // Persist to the authoritative phase record first, then mirror to the
    // legacy child field used by older clients.
    const child = children.find(c => c.id === residentId);
    try {
      if (currentRecord) {
        const result = await request<{ success: boolean; tasksCompleted?: string[] }>(
          `/phases/${currentRecord.id}/task`,
          {
            method: 'POST',
            body: JSON.stringify({ task, completed: done }),
          }
        );
        if (Array.isArray(result.tasksCompleted)) setLocalTasksCompleted(result.tasksCompleted);
      }
      if (child) {
        const existing: Record<string, string[]> = child.phaseTasksCompleted || {};
        const updated = { ...existing, [currentPhase]: newTasks };
        await updateChild(residentId, { phaseTasksCompleted: updated });
      }
    } catch (error) {
      console.error('[PhaseProgress] Failed to save checklist task:', error);
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
      console.log('[Advance] currentPhase:', currentPhase, 'index:', currentIndex, 'CASE_PHASES:', CASE_PHASES);
      if (currentIndex < 0 || currentIndex >= CASE_PHASES.length - 1) {
        console.warn('[Advance] Phase not found or already at last phase');
        setAdvancing(false);
        return;
      }
      const nextPhase = CASE_PHASES[currentIndex + 1];
      console.log('[Advance] Advancing to:', nextPhase);

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

  const handleDownloadDischargeReport = async () => {
    setIsGeneratingReport(true);
    try {
      const child = children.find(c => c.id === residentId);
      if (!child) return;

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
  <title>Discharge Report — ${child.name}</title>
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
    .signature-block { text-align: center; margin-top: 40px; }
    .signature-line { display: inline-block; width: 220px; border-top: 1px solid #333; padding-top: 4px; font-size: 9pt; }
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
    <span><strong>Report Date:</strong> ${reportDate}</span>
    <span><strong>Case ID:</strong> ${child.id}</span>
    <span><strong>Prepared by:</strong> ${user?.username || 'Staff'}</span>
  </div>

  <div class="section">
    <div class="section-title">Resident Information</div>
    <div class="grid">
      <div class="field"><div class="label">Full Name</div><div class="value">${child.name}</div></div>
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
    </div>
  </div>

  <div class="section">
    <div class="section-title">After-Care Notes</div>
    <div class="notes-box">${child.notes || 'No additional notes provided.'}</div>
  </div>

  <div class="signature-block">
    <div class="signature-line">${user?.username || 'Staff'}<br/><span style="color:#888">Prepared by</span></div>
    &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
    <div class="signature-line">&nbsp;<br/><span style="color:#888">Center Head / Approving Authority</span></div>
  </div>

  <div class="footer">
    <span>Generated by SCH-PATH System &nbsp;·&nbsp; ${reportDate}</span>
    <span>CONFIDENTIAL — For official use only</span>
  </div>

  <script>window.onload = function(){ window.print(); }</script>
</body>
</html>`;

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
    } catch (e) { console.error('Report generation failed:', e); }
    setIsGeneratingReport(false);
  };

  const handleConfirmDischarge = async () => {
    setIsConfirmingDischarge(true);
    try {
      // Mark child as Discharged
      await updateChild(residentId, {
        status: 'Discharged',
      });
      setIsDischargeConfirmed(true);
      onPhaseAdvanced?.();
    } catch (e) { console.error('Discharge failed:', e); }
    setIsConfirmingDischarge(false);
  };

  const handleInlineUpload = async (doc: string, file: File) => {
    setUploadingDoc(doc);
    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Data = reader.result as string;
        const now = new Date().toISOString();
        // addDocument updates DataContext documents state → residentDocs derived value
        // auto-updates → status badge turns green immediately, no separate fetch needed
        await addDocument({
          residentId,
          residentName: '',
          category: `${currentPhase} - Required`,
          title: doc,        // Exact match to required document name
          phase: currentPhase,
          fileName: file.name,
          fileSize: file.size,
          fileData: base64Data,
          fileType: file.type,
          status: 'Submitted',
          uploaderRole: user?.role || 'socialworker',
          uploadedBy: user?.username || 'System',
          uploadedAt: now,
        });
        // Refresh phase record (tasks/history) without re-fetching docs
        await loadData();
        setUploadingDoc(null);
      };
      reader.readAsDataURL(file);
    } catch { setUploadingDoc(null); }
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
  const residentDocs: ResidentDoc[] = allDocuments
    .filter(d => {
      if (d.residentId !== residentId) return false;
      if (!isReadmitted) return true; // new child — show all their docs
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
    })
    .map(d => ({
      title: d.title,
      status: d.status as ResidentDoc['status'],
      uploadedBy: d.uploadedBy,
      uploadedAt: d.uploadedAt,
      phase: d.phase,
      fileData: d.fileData,
      fileName: d.fileName,
    }));

  const currentReq = requirements[currentPhase] || { requiredDocuments: [], requiredTasks: [], optionalDocuments: [] };
  const currentReqFull = requirements[currentPhase] as PhaseReqWithOptional | undefined;
  // Build effective documents list including conditional psych assessment
  const effectiveRequiredDocs: string[] = [
    ...(currentReq.requiredDocuments || []),
    ...((currentReqFull?.optionalDocuments?.includes('Psychological Assessment') && needsPsychAssessment) ? ['Psychological Assessment'] : []),
  ];
  // Use local optimistic state — synced from child record on load
  const tasksCompleted = localTasksCompleted;

  const tasksRequired = currentRecord?.tasksRequired || currentReq.requiredTasks;
  const tasksDone = tasksRequired.filter(t => tasksCompleted.includes(t)).length;
  const tasksTotal = tasksRequired.length;

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
              const isDone = histEntry?.completedAt || (idx < currentPhaseIndex);
              const isFuture = idx > currentPhaseIndex;
              return (
                <div key={phase} className="flex items-center gap-1">
                  <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-semibold transition-all ${
                    isCurrent ? 'bg-[#2F3E46] text-white shadow-sm' :
                    isDone    ? 'bg-emerald-100 text-emerald-800' :
                    isFuture  ? 'bg-gray-100 text-gray-400'  :
                                'bg-gray-100 text-gray-500'
                  }`}>
                    {isDone ? <CheckCircle2 className="w-3.5 h-3.5" /> : isFuture ? <Lock className="w-3.5 h-3.5" /> : <Circle className="w-3.5 h-3.5" />}
                    <span className="hidden sm:inline">{phase}</span>
                    <span className="sm:hidden text-xs">{idx + 1}</span>
                  </div>
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
                    {history.map(h => (
                      <tr key={h.id} className={`transition-colors ${
                        h.isCurrent ? 'bg-yellow-50/60 hover:bg-yellow-50' : 'hover:bg-gray-50'
                      }`}>
                        <td className="px-4 py-3 flex items-center gap-3">
                          <div className="flex-shrink-0">
                            {h.completedAt ? (
                              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                            ) : (
                              <Circle className="w-5 h-5 text-gray-300" />
                            )}
                          </div>
                          <div>
                            <p className="font-semibold text-gray-900">{h.phaseName}</p>
                            {h.isCurrent && (
                              <Badge className="mt-1 text-[10px] bg-[#2F3E46] text-white px-2">Current</Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-600 font-mono text-xs">{formatShortDateTime(h.enteredAt)}</td>
                        <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                          {h.completedAt ? formatShortDateTime(h.completedAt) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Current Phase Requirements */}
      {currentRecord && (
        <Card className="shadow-sm border border-gray-200 bg-white">
          <CardHeader className="border-b border-gray-200 pb-4 bg-gradient-to-r from-amber-50 to-white">
            <div className="flex items-center justify-between mb-2">
              <CardTitle className="text-base font-bold text-[#2F3E46] flex items-center gap-2">
                <ClipboardList className="w-5 h-5 text-[#FFD100]" />
                <span>{currentPhase}</span>
              </CardTitle>
              {(() => {
                const approvedDocs = effectiveRequiredDocs.filter(doc =>
                  residentDocs.some(d =>
                    (d.title === doc || d.title?.toLowerCase() === doc.toLowerCase()) &&
                    (d.phase === currentPhase || !d.phase || d.phase === '') &&
                    d.status === 'Approved'
                  )
                ).length;
                const totalDocs = effectiveRequiredDocs.length;
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
                    const uploaded = residentDocs.find(
                      d => (
                        d.title === doc ||
                        d.title?.toLowerCase() === doc.toLowerCase()
                      ) && (d.phase === currentPhase || !d.phase || d.phase === '')
                    );
                    const status = uploaded?.status || 'Missing';
                    return (
                      <div key={doc} className={`flex items-center gap-2 text-sm p-2 rounded-lg border ${
                        status === 'Approved'  ? 'bg-green-50 border-green-200' :
                        status === 'Submitted' ? 'bg-blue-50 border-blue-200' :
                        status === 'Rejected'  ? 'bg-red-50 border-red-200' :
                                                 'bg-gray-50 border-gray-200'
                      }`}>
                        {status === 'Approved'  ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" /> :
                         status === 'Submitted' ? <Clock className="w-3.5 h-3.5 text-blue-500 shrink-0" /> :
                         status === 'Rejected'  ? <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" /> :
                                                  <Circle className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
                        <span className={`flex-1 ${
                          status === 'Approved' ? 'text-green-800 font-medium' :
                          status === 'Submitted' ? 'text-blue-800' :
                          status === 'Rejected' ? 'text-red-700 line-through' :
                          'text-gray-600'
                        }`}>{doc}</span>
                        <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
                          status === 'Approved'  ? 'bg-green-100 text-green-700' :
                          status === 'Submitted' ? 'bg-blue-100 text-blue-700' :
                          status === 'Rejected'  ? 'bg-red-100 text-red-700' :
                                                   'bg-gray-200 text-gray-500'
                        }`}>{status}</span>
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
                        {(status === 'Missing' || status === 'Rejected') && (() => {
                          const allowedRoles = DOCUMENT_ROLE_PERMISSIONS[doc];
                          const userRole = (user?.role || '').toLowerCase();
                          const canUpload = !allowedRoles || allowedRoles.includes(userRole);
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

            {/* Checklist Tasks */}
            {tasksRequired.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
                  <ClipboardList className="w-3 h-3" /> Requirements
                </p>
                <div className="space-y-1">
                  {tasksRequired.map(task => {
                    const done = tasksCompleted.includes(task);
                    return (
                      <label key={task} className="flex items-start gap-2 text-sm cursor-pointer p-1.5 rounded hover:bg-gray-50 group">
                        <input
                          type="checkbox"
                          checked={done}
                          onChange={(e) => handleToggleTask(task, e.target.checked)}
                          className="mt-0.5 accent-green-600"
                          disabled={false}
                        />
                        <span className={done ? 'line-through text-gray-400' : 'text-gray-700'}>{task}</span>
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
            <div className="pt-2 border-t border-gray-100">
              {currentPhase === CASE_PHASES[CASE_PHASES.length - 1] ? (
                <Button
                  onClick={() => setIsDischargePopupOpen(true)}
                  className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold"
                  size="sm"
                >
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Ready to Discharge
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
          </CardContent>
        </Card>
      )}

      {/* Advance Dialog */}
      <Dialog open={isAdvanceDialogOpen} onOpenChange={(open) => { setIsAdvanceDialogOpen(open); if (!open) setShowAdvanceConfirm(false); }}>
        <DialogContent className="max-w-md">
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

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAdvanceDialogOpen(false)}>Cancel</Button>
            {isCenterHead && validationResult?.violationBlock?.demotionRecommended && (
              <Button
                onClick={() => handleDemote()}
                disabled={demoting}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {demoting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <AlertTriangle className="w-4 h-4 mr-2" />}
                Demote Phase
              </Button>
            )}
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
                    <DialogTitle className="flex items-center gap-2 text-amber-600 text-lg">
                      ⚠ Are you sure you want to close this case?
                    </DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 py-2">
                    <div className="p-4 bg-amber-50 border border-amber-300 rounded-lg">
                      <p className="text-amber-900 text-sm font-semibold">
                        You are about to officially close the case of{' '}
                        <strong>{children.find(c => c.id === residentId)?.name}</strong>.
                      </p>
                      <p className="text-amber-700 text-xs mt-2">
                        This will discharge the resident from the shelter and mark the case as <strong>Closed</strong>.
                        This action cannot be undone without re-admitting the resident.
                      </p>
                    </div>
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
                      Ready for Discharge
                    </DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 py-2">
                    <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
                      <p className="text-emerald-800 text-sm font-semibold">
                        {children.find(c => c.id === residentId)?.name} has completed all requirements
                        of the <strong>Reintegration/Aftercare Program</strong> and is ready for discharge.
                      </p>
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
    </div>
  );
}
