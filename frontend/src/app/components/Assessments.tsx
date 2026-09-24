
// Psychological Staff forms for download
const PSYCH_FORMS_DATA = [
  { name: 'CANS Assessment',            description: 'Child & Adolescent Needs & Strengths assessment tool',   file: '/forms/psych/cans.pdf' },
  { name: 'MBTI Personality Test',      description: 'Myers-Briggs Type Indicator personality assessment',     file: '/forms/psych/mbti.pdf' },
  { name: 'Mental Health 20 Questions', description: 'Standard 20-item mental health screening tool',          file: '/forms/psych/mental20q.pdf' },
  { name: 'SSCT (Sacks)',               description: 'Sacks Sentence Completion Test (Tagalog)',               file: '/forms/psych/ssct.pdf' },
];
import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Badge } from '@/app/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/app/components/ui/tabs';
import {
  Search, Plus, Eye, Edit, Clock, ClipboardCheck,
  Trash2, X, Calendar, User, Users, CheckCircle2, AlertTriangle, FileText,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/app/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from '@/app/components/ui/alert-dialog';
import { Label } from '@/app/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Textarea } from '@/app/components/ui/textarea';
import { useData, Assessment } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { usePermissions } from '@/app/hooks/usePermissions';
import { formatShortDate } from '@/utils/dateFormatter';
import { describeError, request } from '@/services/api';
import { systemDialog } from '@/app/components/SystemDialog';

const assessmentTypes = [
  'SSCT',
  'Mental Health Questionnaire',
  'MBTI Personality Type Test',
  'CANS Assessment',
  'Dialogue/Counseling Form',
  'Other',
];

const interventionAssessmentTypes = assessmentTypes;

interface FormState {
  title: string;
  type: string;
  date: string;
  time: string;
  assessors: string[];
  description: string;
  status: 'Scheduled' | 'Completed';
}

const EMPTY_FORM: FormState = {
  title: '',
  type: assessmentTypes[0],
  date: '',
  time: '',
  assessors: [''],
  description: '',
  status: 'Scheduled',
};

export function Assessments() {
  const navigate = useNavigate();
  const {
    assessments,
    addAssessment,
    updateAssessment,
    deleteAssessment,
    addDocument,
    refreshData,
    children,
    violations,
  } = useData();
  const { user } = useAuth();
  const { canOpenModule } = usePermissions();
  const isHouseparent = user?.role?.toLowerCase() === 'houseparent';
  /**
   * The resident names below link to `/children/:id`, which is guarded by the
   * Child Records module. A role that holds Assessments without Child Records
   * (the Houseparent) may read the schedule but cannot open the profile, so the
   * name is rendered as plain text rather than a link that 403s on click.
   */
  const canOpenResidentProfile = canOpenModule('Child Records');

  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [showForms, setShowForms] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [assessmentToDelete, setAssessmentToDelete] = useState<Assessment | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  // Mark Complete dialog
  const [completeTarget, setCompleteTarget] = useState<Assessment | null>(null);
  const [isCompleteDialogOpen, setIsCompleteDialogOpen] = useState(false);
  const [findings, setFindings] = useState('');
  const [isCompleting, setIsCompleting] = useState(false);
  const [supportingFiles, setSupportingFiles] = useState<File[]>([]);
  const [uploadError, setUploadError] = useState('');

  // Group completion checklist
  const [passedResidents, setPassedResidents] = useState<string[]>([]);
  const [failedResidents, setFailedResidents] = useState<string[]>([]);
  const [showPassFailError, setShowPassFailError] = useState(false);

  const toggleResidentPass = (id: string) => {
    setPassedResidents(prev => prev.includes(id) ? prev.filter(r => r !== id) : [...prev, id]);
    setFailedResidents(prev => prev.filter(r => r !== id));
  };
  const toggleResidentFail = (id: string) => {
    setFailedResidents(prev => prev.includes(id) ? prev.filter(r => r !== id) : [...prev, id]);
    setPassedResidents(prev => prev.filter(r => r !== id));
  };

  // Form state
  const [formState, setFormState] = useState<FormState>(EMPTY_FORM);
  const [selectedResidentIds, setSelectedResidentIds] = useState<string[]>([]);
  const [editingPsychosocialActivities, setEditingPsychosocialActivities] = useState<string[]>([]);

  // Manila date helpers (GMT+8)
  const getOffsetDateStr = (daysOffset: number): string => {
    const ms = new Date().getTime() + (8 * 60 * 60 * 1000) + (daysOffset * 24 * 60 * 60 * 1000);
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  };
  const todayStr = getOffsetDateStr(0);
  // Overdue threshold: 3 days after scheduled date
  const overdueCutoffStr = getOffsetDateStr(-3);

  const isOverdue = (a: Assessment) =>
    a.status === 'Scheduled' && a.date < overdueCutoffStr;

  // Include all children — those without explicit status are assumed Active
  const activeChildren = children.filter((c) => !c.status || c.status === 'Active');

  const toggleResident = (id: string) => {
    setSelectedResidentIds((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]
    );
  };

  const resetForm = () => {
    setFormState(EMPTY_FORM);
    setSelectedResidentIds([]);
    setEditingPsychosocialActivities([]);
    setEditingId(null);
    setIsDialogOpen(false);
  };

  const handleEditClick = (assessment: Assessment) => {
    const linked = isInterventionAssessment(assessment);
    const psychTypes = selectedPsychosocialFor(assessment);
    const rawDescription = assessment.description || '';
    const cleanDescription = linked && /^(Scheduled during Psychologist verification|Violation:)/i.test(rawDescription)
      ? ''
      : rawDescription;
    const currentType = String(assessment.type || '');

    setEditingId(assessment.id);
    setEditingPsychosocialActivities(psychTypes);
    setFormState({
      title: assessment.title,
      type: linked
        ? (psychTypes[0] || (assessmentTypes.includes(currentType) ? currentType : 'Other'))
        : (assessmentTypes.includes(currentType) ? currentType : currentType || assessmentTypes[0]),
      date: assessment.date,
      time: assessment.time,
      assessors: assessment.assessor ? assessment.assessor.split(', ').map((s: string) => s.trim()).filter(Boolean) : [''],
      description: cleanDescription,
      status: assessment.status,
    });

    const raw = assessment.forResidents || [];
    const normalized = raw.map((entry: string | {id?: string; name?: string}) => {
      if (typeof entry === 'object' && entry !== null) return entry.id || '';
      if (/^CH\d+$/i.test(entry)) return entry;
      const match = children.find(c => c.name?.toLowerCase() === entry?.toLowerCase());
      return match ? match.id : entry;
    }).filter(id => id);
    setSelectedResidentIds(normalized);
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formState.title.trim() || !formState.date || selectedResidentIds.length === 0 || (!editingId && !formState.assessors.some(a => a.trim()))) {
      void systemDialog.validation('Some required fields are still blank', {
        description: editingId
          ? 'Title, Date, Type, and at least one participant are required.'
          : 'Title, Date, at least one assessor, and at least one resident are required.',
        items: [
          !formState.title.trim() ? 'Title' : '',
          !formState.date ? 'Date' : '',
          selectedResidentIds.length === 0 ? 'At least one resident' : '',
          !editingId && !formState.assessors.some(a => a.trim()) ? 'At least one assessor' : '',
        ].filter(Boolean),
      });
      return;
    }
    if (isSaving) return;

    const currentlyEditing = editingId ? assessments.find(a => a.id === editingId) : null;
    const linked = isInterventionAssessment(currentlyEditing);
    const assessmentData: any = {
      title: formState.title.trim(),
      type: formState.type,
      date: formState.date,
      time: formState.time,
      description: formState.description,
      forResidents: selectedResidentIds,
    };
    if (!editingId || !linked) {
      assessmentData.assessor = formState.assessors.filter(a => a.trim()).join(', ');
      assessmentData.status = formState.status;
    }
    if (linked) {
      if (editingPsychosocialActivities.length === 0) {
        void systemDialog.validation('Select at least one psychosocial activity type', {
          description: 'This assessment is linked to an intervention, so it needs the activities it covers.',
        });
        return;
      }
      assessmentData.psychosocialActivities = editingPsychosocialActivities;
      assessmentData.type = editingPsychosocialActivities.join(', ');
    }

    // Await the write and only close the dialog once it actually succeeded.
    // Previously the dialog closed unconditionally, so a rejected save looked
    // exactly like a successful one.
    setIsSaving(true);
    try {
      if (editingId) {
        await updateAssessment(editingId, assessmentData);
      } else {
        await addAssessment(assessmentData);
      }
      resetForm();
    } catch (err) {
      void systemDialog.failure('Could not save the assessment', describeError(err, 'The assessment was not saved. Please try again.'));
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDelete = () => {
    if (assessmentToDelete) {
      deleteAssessment(assessmentToDelete.id);
      setAssessmentToDelete(null);
      setIsDeleteDialogOpen(false);
    }
  };

  const handleCompleteOpen = (a: Assessment) => {
    setCompleteTarget(a);
    setFindings('');
    setSupportingFiles([]);
    setUploadError('');
    // Initialize: all participants start as unchecked
    const ids = (a.forResidents || []).map((entry: string | {id?: string}) =>
      typeof entry === 'object' ? (entry.id || '') : entry
    ).filter(Boolean);
    setPassedResidents([]);
    setFailedResidents([]);
    setIsCompleteDialogOpen(true);
  };

  const handleCompleteSubmit = async () => {
    if (!completeTarget) return;
    if (supportingFiles.length === 0) {
      setUploadError('Please upload at least one supporting document before marking the assessment complete.');
      return;
    }
    if (supportingFiles.some(file => file.size > 10 * 1024 * 1024)) {
      setUploadError('Each supporting document must be 10MB or smaller.');
      return;
    }
    setUploadError('');

    // Validate: every resident must have Pass or Fail selected
    if ((completeTarget.forResidents || []).length > 0) {
      const allResidentIds = (completeTarget.forResidents || []).map((entry, idx) =>
        typeof entry === 'object' && entry !== null ? (entry as any).id ?? String(idx) : String(entry)
      );
      const unmarked = allResidentIds.filter(rid => !passedResidents.includes(rid) && !failedResidents.includes(rid));
      if (unmarked.length > 0) {
        setShowPassFailError(true);
        return;
      }
    }
    setShowPassFailError(false);
    setIsCompleting(true);
    try {
      // Persist the evidence first. Every supporting file is linked to the exact
      // assessment AND to each resident who belongs to that assessment. This is
      // what makes the upload appear inside each child's Documents folder rather
      // than only in a generic Assessment record.
      const assessmentResidentIds = (completeTarget.forResidents || [])
        .map((entry: string | { id?: string }) =>
          typeof entry === 'object' && entry !== null ? (entry.id || '') : entry
        )
        .filter(Boolean) as string[];

      if (assessmentResidentIds.length === 0) {
        throw new Error('This assessment has no linked resident, so the supporting document cannot be filed.');
      }

      for (const file of supportingFiles) {
        const base64Data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
          reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled.`));
          reader.readAsDataURL(file);
        });

        // Create a real Documents-module record for each participating child.
        // residentId is the child's actual folder key and assessmentId preserves
        // the link back to the assessment that required the evidence.
        for (const residentId of assessmentResidentIds) {
          await addDocument({
            residentId,
            residentName: residentLabel(residentId),
            assessmentId: completeTarget.id,
            title: `Assessment Supporting Document — ${completeTarget.title}`,
            type: completeTarget.type,
            category: 'Assessment',
            description: `Supporting document for assessment ${completeTarget.id}.`,
            fileName: file.name,
            fileSize: file.size,
            fileData: base64Data,
            fileType: file.type || 'application/octet-stream',
            status: 'Submitted',
            uploaderRole: user?.role,
            uploadedBy: user?.username || 'System',
            uploadedAt: new Date().toISOString(),
          });
        }
      }

      // Confirm the document rows are present in the server-backed Documents
      // collection before allowing the assessment completion transaction.
      await refreshData();

      await request(`/assessments/${completeTarget.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ findings: findings.trim() || null, results: { completedBy: user?.username, findings: findings.trim() || null, passedResidents, failedResidents } }),
      });
      // Re-read the server state so the Documents module and child folders are
      // immediately backed by the persisted rows, not only optimistic state.
      await refreshData();
      // Update the original assessment — mark as completed
      // Remove passed residents; only keep failed ones still pending
      updateAssessment(completeTarget.id, {
        status: 'Completed',
        description: findings.trim() || undefined,
        // Store who passed/failed in results for record
      });

      // Auto-schedule second session for failed residents
      if (failedResidents.length > 0) {
        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + 7); // 1 week later
        const nextDateStr = nextDate.toISOString().split('T')[0];
        await addAssessment({
          title: `${completeTarget.title} — 2nd Session`,
          type: completeTarget.type,
          date: nextDateStr,
          time: completeTarget.time,
          assessor: completeTarget.assessor,
          description: `Auto-scheduled 2nd session for residents who did not pass the original assessment on ${completeTarget.date}. Failed participants: ${failedResidents.map(id => residentLabel(id)).join(', ')}.`,
          status: 'Scheduled',
          forResidents: failedResidents,
          triggeredBy: `Failed assessment: ${completeTarget.title} (${completeTarget.id})`,
        });
      }
    } catch (e) {
      console.error('Failed to mark complete:', e);
      setUploadError(e instanceof Error ? e.message : 'Unable to complete assessment.');
      setIsCompleting(false);
      return;
    }
    setIsCompleting(false);
    setIsCompleteDialogOpen(false);
    setCompleteTarget(null);
    setShowPassFailError(false);
    setPassedResidents([]);
    setFailedResidents([]);
  };

  const searchFiltered = useMemo(() => assessments.filter(
    (a) =>
      (a.title || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (a.type || '').toLowerCase().includes(searchTerm.toLowerCase())
  ), [assessments, searchTerm]);

  const tabLists = useMemo(() => ({
    all:       searchFiltered,
    scheduled: searchFiltered.filter(a => a.status === 'Scheduled' && !isOverdue(a)),
    completed: searchFiltered.filter(a => a.status === 'Completed'),
    overdue:   searchFiltered.filter(a => isOverdue(a)),
  }), [searchFiltered, todayStr]);

  const displayList = tabLists[activeTab as keyof typeof tabLists] ?? tabLists.all;

  // Helper: get child name from ID
  const residentLabel = (id: string) =>
    children.find((c) => c.id === id)?.name ?? id;

  const linkedViolationsFor = (assessment: Assessment | null) => {
    if (!assessment?.violationIds?.length) return [];
    return assessment.violationIds
      .map((id: string) => violations.find(v => v.id === id))
      .filter(Boolean) as typeof violations;
  };

  const isInterventionAssessment = (assessment: Assessment | null) =>
    Boolean(assessment?.interventionTrackerId || assessment?.interventionRequirementId || assessment?.schedulingMode === 'violation-scheduled');

  const selectedPsychosocialFor = (assessment: Assessment | null) => {
    if (!assessment) return [];
    if (Array.isArray((assessment as any).psychosocialActivities) && (assessment as any).psychosocialActivities.length) {
      return (assessment as any).psychosocialActivities as string[];
    }
    const rawType = String(assessment.type || '');
    return interventionAssessmentTypes.filter(t => rawType.split(',').map(x => x.trim()).includes(t));
  };

  return (
    <div className="space-y-6 p-2">
      {/* HEADER */}
      {/* Stacks on a phone. In a row, the "Schedule Assessment" button left the
          title about 110px on a 320px screen, which is narrower than the word
          "Assessments" — so the heading broke mid-word ("Assessmen / ts"). */}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-[#2F3E46]">Assessments</h2>
          <p className="text-sm text-gray-500">Manage resident assessments</p>
        </div>

        {!isHouseparent && (
          <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) resetForm(); else setIsDialogOpen(true); }}>
            <DialogTrigger asChild>
              <Button
                style={{ backgroundColor: '#FFD100', color: '#2F3E46' }}
                className="hover:opacity-90 font-bold shadow-sm rounded-lg"
                onClick={() => { resetForm(); setIsDialogOpen(true); }}
              >
                <Plus className="w-4 h-4 mr-2" /> Schedule Assessment
              </Button>
            </DialogTrigger>

          <DialogContent className="max-w-2xl bg-white rounded-2xl overflow-hidden p-0">
            <DialogHeader className="p-6 border-b bg-gray-50/50">
              <DialogTitle className="text-[#2F3E46] text-xl font-bold">
                {editingId ? 'Edit Assessment' : 'New Assessment'}
              </DialogTitle>
            </DialogHeader>

            <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2 col-span-2 md:col-span-1">
                  <Label className="font-bold text-[#2F3E46]">Assessment Title *</Label>
                  <Input
                    value={formState.title}
                    onChange={(e) => setFormState({ ...formState, title: e.target.value })}
                    placeholder="e.g. Initial Interview"
                    className="rounded-xl"
                  />
                </div>
                <div className="space-y-2 col-span-2 md:col-span-1">
                  <Label className="font-bold text-[#2F3E46]">Type *</Label>
                  {editingId && isInterventionAssessment(assessments.find(a => a.id === editingId) || null) ? (
                    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 space-y-2 max-h-48 overflow-y-auto">
                      {assessmentTypes.map((t) => (
                        <label key={t} className="flex items-center gap-2 text-sm text-[#2F3E46] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editingPsychosocialActivities.includes(t)}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? Array.from(new Set([...editingPsychosocialActivities, t]))
                                : editingPsychosocialActivities.filter(x => x !== t);
                              setEditingPsychosocialActivities(next);
                              setFormState(prev => ({ ...prev, type: next[0] || 'Other' }));
                            }}
                            className="h-4 w-4"
                          />
                          {t}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <Select value={formState.type} onValueChange={(v) => setFormState({ ...formState, type: v })}>
                      <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {assessmentTypes.map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}
                        {editingId && formState.type && !assessmentTypes.includes(formState.type) && (
                          <SelectItem value={formState.type}>{formState.type}</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>

              {!editingId && (<>
              {/* Assessors — dynamic list */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="font-bold text-[#2F3E46]">Assessor(s) / Staff In-Charge *</Label>
                  <Button
                    type="button" size="sm" variant="outline" className="h-7 text-xs"
                    onClick={() => setFormState(prev => ({ ...prev, assessors: [...prev.assessors, ''] }))}
                  >+ Add Assessor</Button>
                </div>
                <div className="space-y-2">
                  {formState.assessors.map((a, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input placeholder={`Assessor ${idx + 1} name`} value={a}
                        onChange={(e) => { const updated = [...formState.assessors]; updated[idx] = e.target.value; setFormState(prev => ({ ...prev, assessors: updated })); }}
                        className="rounded-xl flex-1" />
                      {formState.assessors.length > 1 && (
                        <Button type="button" size="sm" variant="ghost" className="h-8 w-8 p-0 text-red-500 hover:text-red-700"
                          onClick={() => setFormState(prev => ({ ...prev, assessors: prev.assessors.filter((_, i) => i !== idx) }))}>✕</Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              </>)}

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="font-bold text-[#2F3E46]">Date *</Label>
                  <Input type="date" value={formState.date} onChange={(e) => setFormState({ ...formState, date: e.target.value })} className="rounded-xl" />
                </div>
                <div className="space-y-2">
                  <Label className="font-bold text-[#2F3E46]">Time</Label>
                  <Input type="time" value={formState.time} onChange={(e) => setFormState({ ...formState, time: e.target.value })} className="rounded-xl" />
                </div>
              </div>

              {!editingId && (
              <div className="space-y-2">
                <Label className="font-bold text-[#2F3E46]">Status</Label>
                <Select value={formState.status} onValueChange={(v) => setFormState({ ...formState, status: v as 'Scheduled' | 'Completed' })}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Scheduled">Scheduled</SelectItem>
                    <SelectItem value="Completed">Completed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              )}

              {editingId && (() => {
                const current = assessments.find(a => a.id === editingId) || null;
                const linked = isInterventionAssessment(current);
                const related = linkedViolationsFor(current);
                return linked ? (
                  <div className="rounded-2xl border border-orange-200 bg-orange-50/50 p-4 space-y-2">
                    <p className="text-xs font-bold uppercase tracking-wide text-orange-700">From Intervention — fixed information</p>
                    {related.length ? related.map(v => (
                      <div key={v.id} className="text-sm text-[#2F3E46]">
                        <div><span className="font-semibold">Violation:</span> {v.type}</div>
                        <div><span className="font-semibold">Offense Number:</span> {v.offenseNumber || '—'}</div>
                      </div>
                    )) : (
                      <div className="text-sm text-gray-500">Linked violation details are unavailable.</div>
                    )}
                  </div>
                ) : null;
              })()}


              {/* Resident Selection */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <Label className="font-bold text-[#2F3E46]">Participants (Residents) *</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">{selectedResidentIds.length} of {activeChildren.length} selected</span>
                    {activeChildren.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          if (selectedResidentIds.length === activeChildren.length) {
                            setSelectedResidentIds([]);
                          } else {
                            setSelectedResidentIds(activeChildren.map(c => c.id));
                          }
                        }}
                        className="text-[10px] font-bold text-[#2F3E46] hover:text-[#FFD100] underline underline-offset-2 transition-colors"
                      >
                        {selectedResidentIds.length === activeChildren.length ? 'Deselect All' : 'Select All'}
                      </button>
                    )}
                  </div>
                </div>

                {activeChildren.length === 0 ? (
                  <div className="p-6 bg-gray-50 rounded-2xl border border-gray-100 text-center">
                    <p className="text-sm text-gray-400 italic">No residents found. Add residents in Child Records first.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 p-3 bg-gray-50 rounded-2xl border border-gray-100 max-h-60 overflow-y-auto">
                    {activeChildren.map((child) => {
                      const isSelected = selectedResidentIds.includes(child.id);
                      return (
                        <div
                          key={child.id}
                          onClick={() => toggleResident(child.id)}
                          className={`flex items-center gap-3 p-2.5 rounded-xl border cursor-pointer transition-all duration-150 select-none
                            ${isSelected
                              ? 'bg-[#2F3E46] border-[#2F3E46]'
                              : 'bg-white border-gray-100 shadow-sm hover:border-[#FFD100] hover:shadow-md'
                            }`}
                        >
                          {/* Custom checkbox indicator */}
                          <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors
                            ${isSelected ? 'bg-[#FFD100] border-[#FFD100]' : 'border-gray-300 bg-white'}`}
                          >
                            {isSelected && (
                              <svg className="w-2.5 h-2.5" viewBox="0 0 10 10" fill="none">
                                <path d="M1.5 5L4 7.5L8.5 2.5" stroke="#2F3E46" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className={`text-sm font-bold leading-tight truncate ${isSelected ? 'text-white' : 'text-[#2F3E46]'}`}>
                              {child.name}
                            </p>
                            <p className={`text-[10px] truncate mt-0.5 ${isSelected ? 'text-[#FFD100]' : 'text-gray-400'}`}>
                              {child.id} · {child.caseType} · {child.age} yrs
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>


              <div className="space-y-2">
                <Label className="font-bold text-[#2F3E46]">Notes / Description</Label>
                <Textarea
                  placeholder="Notes..."
                  value={formState.description}
                  onChange={(e) => setFormState({ ...formState, description: e.target.value })}
                  className="rounded-2xl min-h-[100px]"
                />
              </div>
            </div>

            <DialogFooter className="bg-gray-50 p-6 border-t gap-2">
              <Button variant="ghost" onClick={resetForm} className="rounded-xl px-6">Cancel</Button>
              <Button
                style={{ backgroundColor: '#FFD100', color: '#2F3E46' }}
                onClick={handleSave}
                disabled={isSaving}
                className="rounded-xl px-8 font-bold hover:opacity-90"
              >
                {isSaving ? 'Saving...' : editingId ? 'Update Assessment' : 'Save Assessment'}
              </Button>
            </DialogFooter>
          </DialogContent>
          </Dialog>
        )}
      </div>

      {/* Houseparent read-only notice.  Keep the existing assessment UI for
          other roles; HPs may only inspect assessments that belong to their
          assigned residents. */}
      {isHouseparent && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 flex items-start gap-3">
          <Eye className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-bold text-blue-900 text-sm">View-only access</p>
            <p className="text-xs text-blue-700 mt-0.5">You can view assessments for your assigned residents only. Scheduling, editing, completing, and deleting assessments are not available.</p>
          </div>
        </div>
      )}

      {/* Available Forms button + panel */}
      <div>
        {!isHouseparent && (
        <button
          onClick={() => setShowForms(v => !v)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-purple-200 text-purple-700 bg-purple-50 hover:bg-purple-100 font-semibold text-sm transition-all"
        >
          <span>📋</span>
          {showForms ? 'Hide Forms' : 'Available Forms'}
        </button>
        )}
        {showForms && !isHouseparent && (
          <div className="mt-3 border border-purple-200 rounded-2xl overflow-hidden bg-white shadow-sm">
            <div className="bg-purple-600 px-5 py-3 flex items-center gap-2">
              <span className="text-white text-lg">📋</span>
              <h3 className="font-bold text-white">Psychological Staff Forms</h3>
              <span className="text-purple-200 text-xs ml-1">— Click to download</span>
            </div>
            <div className="divide-y divide-gray-100">
              {PSYCH_FORMS_DATA.map(form => (
                <div key={form.file} className="flex items-center justify-between px-5 py-3 hover:bg-purple-50 transition-all">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-purple-100 flex items-center justify-center shrink-0">
                      <span className="text-base">📄</span>
                    </div>
                    <div>
                      <p className="font-semibold text-[#2F3E46] text-sm">{form.name}</p>
                      <p className="text-xs text-gray-400">{form.description}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <button onClick={() => window.open(form.file, '_blank', 'noopener,noreferrer')} className="rounded-lg border border-purple-200 px-2.5 py-1.5 text-xs font-bold text-purple-600 hover:bg-purple-100">View</button>
                    <button onClick={() => { const w=window.open(form.file, '_blank'); w?.addEventListener('load',()=>w.print()); }} className="rounded-lg border border-purple-200 px-2.5 py-1.5 text-xs font-bold text-purple-600 hover:bg-purple-100">Print</button>
                    <button onClick={() => { const l = document.createElement('a'); l.href = form.file; l.download = form.name + '.pdf'; l.click(); }} className="rounded-lg border border-purple-200 px-2.5 py-1.5 text-xs font-bold text-purple-600 hover:bg-purple-100">Download</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* SEARCH + TABS */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
          <Input
            className="pl-10 bg-white border-gray-200"
            placeholder="Search assessments..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        {tabLists.overdue.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 font-semibold">
            <AlertTriangle className="w-3.5 h-3.5" />
            {tabLists.overdue.length} overdue assessment{tabLists.overdue.length > 1 ? 's' : ''}
          </div>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-2">
          <TabsTrigger value="all">All ({tabLists.all.length})</TabsTrigger>
          <TabsTrigger value="scheduled">Scheduled ({tabLists.scheduled.length})</TabsTrigger>
          <TabsTrigger value="completed">Completed ({tabLists.completed.length})</TabsTrigger>
          <TabsTrigger value="overdue" className="relative">
            Overdue
            {tabLists.overdue.length > 0 && (
              <span className="ml-1.5 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                {tabLists.overdue.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {(['all', 'scheduled', 'completed', 'overdue'] as const).map(tab => (
          <TabsContent key={tab} value={tab}>
            <div className="grid gap-4">
              {displayList.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <ClipboardCheck className="w-10 h-10 mx-auto mb-2 opacity-20" />
                  <p className="text-sm italic">No assessments found.</p>
                </div>
              ) : (
                displayList.map((item) => {
                  const overdue = isOverdue(item);
                  return (
                    <Card
                      key={item.id}
                      style={{ backgroundColor: '#2F3E46' }}
                      className="border-none shadow-lg overflow-hidden hover:scale-[1.005] transition-all duration-200 rounded-2xl text-white"
                    >
                      <CardContent className="p-0 flex flex-col md:flex-row">
                        {/* Left accent bar */}
                        <div
                          className="w-1.5 shrink-0"
                          style={{
                            backgroundColor: overdue ? '#EF4444' :
                              item.triggeredBy ? '#F97316' :
                              item.status === 'Completed' ? '#10B981' : '#FFD100'
                          }}
                        />
                        <div className="p-6 flex-1 flex flex-col md:flex-row md:items-start justify-between gap-6">
                          <div className="space-y-3 flex-1 min-w-0">
                            {/* Title + badges */}
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-lg font-bold tracking-tight">{item.title}</h3>
                              {item.status === 'Completed' ? (
                                <Badge className="border-none text-[10px] uppercase font-bold bg-emerald-500/20 text-emerald-300">
                                  <CheckCircle2 className="w-3 h-3 mr-1" /> Completed
                                </Badge>
                              ) : overdue ? (
                                <Badge className="border-none text-[10px] uppercase font-bold bg-red-500/20 text-red-300">
                                  <AlertTriangle className="w-3 h-3 mr-1" /> Overdue
                                </Badge>
                              ) : (
                                <Badge className="border-none text-[10px] uppercase font-bold bg-white/10 text-[#FFD100]">
                                  <Clock className="w-3 h-3 mr-1" /> Scheduled
                                </Badge>
                              )}
                              {item.triggeredBy && !item.interventionTrackerId && (
                                <Badge className="border-none text-[10px] uppercase font-bold bg-orange-500/20 text-orange-300">
                                  Auto-Scheduled
                                </Badge>
                              )}
                            </div>

                            {/* Meta grid */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5 text-sm opacity-90">
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-2">
                                  <Badge variant="outline" className="border-gray-500 text-gray-400 font-normal text-[10px]">
                                    {item.id}
                                  </Badge>
                                  <span className="font-medium text-[#FFD100] text-xs">{item.type}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Calendar size={13} className="text-[#FFD100] shrink-0" />
                                  <span className={overdue ? 'text-red-300 font-medium' : ''}>
                                    {formatShortDate(item.date)}{item.time ? ` · ${(() => {
                                      const t = item.time;
                                      if (t.includes('AM') || t.includes('PM')) return t;
                                      const [h, m] = t.split(':').map(Number);
                                      const ampm = h >= 12 ? 'PM' : 'AM';
                                      return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${ampm}`;
                                    })()}` : ''}
                                  </span>
                                </div>
                              </div>
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-2">
                                  <User size={13} className="text-[#FFD100] shrink-0" />
                                  <span className="truncate">{item.assessor}</span>
                                </div>
                                <div className="flex items-start gap-2">
                                  <Users size={13} className="text-[#FFD100] shrink-0 mt-0.5" />
                                  <div className="flex flex-wrap gap-1">
                                    {(item.forResidents || []).length === 0 ? (
                                      <span className="opacity-60">—</span>
                                    ) : (
                                      (item.forResidents || []).map((entry, idx) => {
                                        const rid = typeof entry === 'object' && entry !== null
                                          ? (entry as any).id ?? String(idx)
                                          : String(entry);
                                        const displayName = typeof entry === 'object' && entry !== null
                                          ? (entry as any).name
                                          : null;
                                        const child = children.find(c => c.id === rid);
                                        const label = child?.name ?? displayName ?? rid;
                                        return child && canOpenResidentProfile ? (
                                          <button
                                            key={rid}
                                            onClick={() => navigate(`/children/${child.id}`)}
                                            className="text-[#FFD100] underline underline-offset-2 hover:text-yellow-300 text-xs font-medium"
                                          >
                                            {label}
                                          </button>
                                        ) : (
                                          <span key={rid} className="text-xs opacity-60">{label}</span>
                                        );
                                      })
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Trigger note */}
                            {item.triggeredBy && (
                              <p className="text-xs text-orange-300 italic">Trigger: {item.triggeredBy}</p>
                            )}

                            {/* Findings (Completed only) */}
                            {item.status === 'Completed' && item.description && (
                              <div className="flex items-start gap-2 mt-1 bg-white/5 rounded-lg px-3 py-2">
                                <FileText size={13} className="text-emerald-400 shrink-0 mt-0.5" />
                                <p className="text-xs text-gray-300 italic leading-relaxed line-clamp-2">
                                  {item.description}
                                </p>
                              </div>
                            )}
                          </div>

                          {/* Actions */}
                          <div className="flex flex-col sm:flex-row md:flex-col gap-2 pt-3 md:pt-0 border-t md:border-t-0 md:border-l md:pl-5 border-white/10 shrink-0">
                            <Button
                              variant="ghost" size="sm"
                              className="text-white hover:bg-white/10 gap-1.5 justify-start"
                              onClick={() => navigate(`/assessments/${item.id}`)}
                            >
                              <Eye size={14} className="text-[#FFD100]" /> View
                            </Button>
                            {!isHouseparent && (
                              <>
                                <Button
                                  variant="ghost" size="sm"
                                  className="text-white hover:bg-white/10 gap-1.5 justify-start"
                                  onClick={() => handleEditClick(item)}
                                >
                                  <Edit size={14} className="text-[#FFD100]" /> Edit
                                </Button>
                                {item.status !== 'Completed' && (
                                  <Button
                                    variant="ghost" size="sm"
                                    className="text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 gap-1.5 justify-start"
                                    onClick={() => handleCompleteOpen(item)}
                                  >
                                    <CheckCircle2 size={14} /> Mark Complete
                                  </Button>
                                )}
                                <Button
                                  variant="ghost" size="sm"
                                  className="text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-1.5 justify-start"
                                  onClick={() => { setAssessmentToDelete(item); setIsDeleteDialogOpen(true); }}
                                >
                                  <Trash2 size={14} /> Delete
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>
          </TabsContent>
        ))}

      </Tabs>

      {/* MARK COMPLETE DIALOG */}
      <Dialog open={isCompleteDialogOpen} onOpenChange={setIsCompleteDialogOpen}>
        <DialogContent className="max-w-lg bg-white rounded-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46] font-bold flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-500" /> Mark Assessment as Complete
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {completeTarget && (
              <div className="p-3 bg-gray-50 rounded-xl border border-gray-100">
                <p className="text-sm font-semibold text-[#2F3E46]">{completeTarget.title}</p>
                <p className="text-xs text-gray-500 mt-0.5">{completeTarget.type} · {formatShortDate(completeTarget.date)}</p>
              </div>
            )}

            {/* Group Completion Checklist */}
            {completeTarget && (completeTarget.forResidents || []).length > 0 && (
              <div className="space-y-2">
                <Label className="font-semibold text-[#2F3E46] text-sm">
                  Resident Checklist <span className="text-gray-400 font-normal text-xs">(Mark each participant's outcome)</span>
                </Label>
                <div className="p-0.5 rounded-xl border border-gray-200 overflow-hidden">
                  <div className="grid grid-cols-3 bg-gray-100 px-3 py-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                    <span className="col-span-1">Resident</span>
                    <span className="text-center text-emerald-600">Passed</span>
                    <span className="text-center text-red-500">Failed</span>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {(completeTarget.forResidents || []).map((entry, idx) => {
                      const rid = typeof entry === 'object' && entry !== null ? (entry as any).id ?? String(idx) : String(entry);
                      const name = residentLabel(rid);
                      const passed = passedResidents.includes(rid);
                      const failed = failedResidents.includes(rid);
                      return (
                        <div key={rid} className={`grid grid-cols-3 items-center px-3 py-2.5 transition-colors ${passed ? 'bg-emerald-50' : failed ? 'bg-red-50' : showPassFailError ? 'bg-yellow-50 border-l-4 border-yellow-400' : 'bg-white'}`}>
                          <span className="text-sm font-medium text-[#2F3E46] truncate col-span-1">{name}</span>
                          <div className="flex justify-center">
                            <button
                              onClick={() => toggleResidentPass(rid)}
                              className={`w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all ${passed ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-gray-300 hover:border-emerald-400'}`}
                            >
                              {passed && <CheckCircle2 className="w-4 h-4" />}
                            </button>
                          </div>
                          <div className="flex justify-center">
                            <button
                              onClick={() => toggleResidentFail(rid)}
                              className={`w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all ${failed ? 'bg-red-500 border-red-500 text-white' : 'border-gray-300 hover:border-red-400'}`}
                            >
                              {failed && <X className="w-4 h-4" />}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {failedResidents.length > 0 && (
                  <div className="flex items-start gap-2 p-2.5 bg-orange-50 border border-orange-200 rounded-xl text-xs text-orange-700">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span><strong>{failedResidents.length}</strong> resident{failedResidents.length > 1 ? 's' : ''} will be automatically scheduled for a 2nd session (1 week from today).</span>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="font-semibold text-[#2F3E46] text-sm">
                Findings / Results <span className="text-gray-400 font-normal text-xs">(optional)</span>
              </Label>
              <Textarea
                value={findings}
                onChange={(e) => setFindings(e.target.value)}
                placeholder="Summarize the assessment outcome, observations, and recommendations..."
                className="rounded-xl min-h-[120px] text-sm"
              />
              <p className="text-xs text-gray-400">This will be recorded as the official findings for this assessment.</p>
            </div>

            <div className="space-y-2">
              <Label className="font-semibold text-[#2F3E46] text-sm">
                Supporting Documents <span className="text-red-500">*</span>
              </Label>
              <p className="text-xs text-gray-500">Upload at least one document before confirming completion.</p>
              <Input
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.xls,.xlsx"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  setSupportingFiles(files);
                  setUploadError('');
                }}
              />
              {supportingFiles.length > 0 && (
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-2 space-y-1">
                  {supportingFiles.map(file => (
                    <div key={`${file.name}-${file.size}`} className="text-xs text-gray-700 flex justify-between gap-2">
                      <span className="truncate">{file.name}</span>
                      <span className="text-gray-400 shrink-0">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                    </div>
                  ))}
                </div>
              )}
              {uploadError && (
                <p className="text-xs font-medium text-red-600">{uploadError}</p>
              )}
            </div>

            {/* Pass/Fail validation error notice */}
            {showPassFailError && (
              <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-300 rounded-xl">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                <p className="text-sm font-semibold text-red-700">
                  Please select Pass or Failed for all residents before confirming.
                </p>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setIsCompleteDialogOpen(false)}>Cancel</Button>
            <Button
              disabled={supportingFiles.length === 0 || isCompleting}
              onClick={handleCompleteSubmit}
              className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl"
            >
              {isCompleting ? 'Saving...' : 'Confirm Completion'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DELETE CONFIRM */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent className="bg-white rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[#2F3E46] font-bold">Confirm Delete</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{assessmentToDelete?.title}</strong>? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700 text-white" onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
