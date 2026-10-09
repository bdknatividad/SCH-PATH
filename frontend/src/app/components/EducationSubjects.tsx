import { useEffect, useMemo, useRef, useState } from 'react';
import { request, createResource, deleteResource, describeError } from '@/services/api';
import { systemDialog } from '@/app/components/SystemDialog';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Textarea } from '@/app/components/ui/textarea';
import { formatShortDate } from '@/utils/dateFormatter';
import { Plus, Settings2, Trash2, AlertCircle, Loader2, Pencil, Save, X, ClipboardList, Wand2 } from 'lucide-react';

/**
 * Education Progress Monitoring — replaces Pass / Fail.
 *
 * Every subject (module, activity) on the learner's level list carries its own
 * progress status — Not Started, Ongoing, Submitted, Completed or Pending — and
 * the outputs submitted against the outputs expected. Each learner also has one
 * monitoring record: modules / activities completed and pending, outputs
 * submitted and not submitted, progress / participation notes, the date of
 * monitoring and education-related concerns.
 *
 * Everything is stored by the API (`/education-progress`) and read back from
 * it, so the Education module and Child Record → Education show the same rows.
 * Only the Educator may edit; everyone else with access reads.
 *
 * The subject list still belongs to the **education level**: the Educator
 * defines it once per level and every learner at that level is monitored
 * against the same list.
 */

export const PROGRESS_STATUSES = ['Not Started', 'Ongoing', 'Submitted', 'Completed', 'Pending'] as const;
export type ProgressStatus = typeof PROGRESS_STATUSES[number];

export interface EducationSubject {
  id: string;
  educationLevel: string;
  name: string;
  sortOrder: number;
}

export interface SubjectProgress {
  subjectId: string;
  name: string;
  status: ProgressStatus;
  outputsSubmitted: number | null;
  outputsTotal: number | null;
}

export interface ProgressMonitoring {
  id?: string;
  admissionId?: string | null;
  monitoringDate: string | null;
  modulesCompleted: string;
  modulesPending: string;
  outputsSubmitted: string;
  outputsNotSubmitted: string;
  participationNotes: string;
  concerns: string;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

/** One learner's Education Progress, as the API computes it. */
export interface LearnerProgress {
  educationRecordId: string;
  residentId: string | null;
  educationLevel: string;
  /** Every subject Completed with all outputs submitted — Complete is offered. */
  complete?: boolean;
  /** Completed and moved to the Archive. */
  archived?: boolean;
  total: number;
  counts: Record<ProgressStatus, number>;
  outputsSubmitted: number;
  outputsTotal: number;
  subjects: SubjectProgress[];
  monitoring: ProgressMonitoring | null;
}

export interface ProgressLearner {
  id: string;
  name: string;
  residentId?: string;
  educationLevel: string;
  levelLabel: string;
}

/**
 * A legacy level name resolves to the level whose subject list it now shares,
 * so a record written before a rename is monitored against the current list.
 */
export function subjectLevelFor(level: string): string {
  if (level === 'High School') return 'Junior High School';
  if (level === 'ALS - Elementary') return 'ALS Elementary';
  return level;
}

/**
 * Status colours, on the system's slate panel. Each status has its own hue and
 * a dot, so it reads at a glance and never relies on colour alone (the word is
 * always printed).
 */
const STATUS_STYLE: Record<ProgressStatus, { pill: string; dot: string; light: string }> = {
  'Not Started': { pill: 'bg-white/10 text-gray-200 ring-white/20', dot: 'bg-gray-400', light: 'bg-gray-100 text-gray-700' },
  Ongoing: { pill: 'bg-sky-400/15 text-sky-200 ring-sky-300/30', dot: 'bg-sky-400', light: 'bg-sky-100 text-sky-800' },
  Submitted: { pill: 'bg-violet-400/15 text-violet-200 ring-violet-300/30', dot: 'bg-violet-400', light: 'bg-violet-100 text-violet-800' },
  Completed: { pill: 'bg-emerald-400/15 text-emerald-200 ring-emerald-300/30', dot: 'bg-emerald-400', light: 'bg-emerald-100 text-emerald-800' },
  Pending: { pill: 'bg-[#FFD100]/15 text-[#FFD100] ring-[#FFD100]/40', dot: 'bg-[#FFD100]', light: 'bg-amber-100 text-amber-800' },
};

export function statusStyle(status: ProgressStatus) {
  return STATUS_STYLE[status] || STATUS_STYLE['Not Started'];
}

/** "3/5 submitted", "3 submitted", or "—" when nothing is recorded. */
export function outputsLabel(submitted: number | null, total: number | null): string {
  if (total !== null && total !== undefined) return `${submitted ?? 0}/${total} submitted`;
  if (submitted !== null && submitted !== undefined) return `${submitted} submitted`;
  return '—';
}

function StatusPill({ status }: { status: ProgressStatus }) {
  const style = statusStyle(status);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${style.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
      {status}
    </span>
  );
}

/** Counts per status, shown above the table. */
export function StatusCounts({ counts, light = false }: { counts: Record<ProgressStatus, number>; light?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {PROGRESS_STATUSES.map((status) => (
        <span
          key={status}
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${light ? statusStyle(status).light : `ring-1 ring-inset ${statusStyle(status).pill}`}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${statusStyle(status).dot}`} aria-hidden />
          {status} · {counts?.[status] ?? 0}
        </span>
      ))}
    </div>
  );
}

const GRID = 'grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3';

/**
 * The progress table: Subject / Learning Area · Status · Outputs — laid out
 * after the reference (dark panel, bold header, one thin-ruled row per
 * subject), in the system's slate with its yellow accent.
 */
export function ProgressTable({ subjects, emptyText }: { subjects: SubjectProgress[]; emptyText?: string }) {
  return (
    <div className="overflow-hidden rounded-xl border-b-4 border-[#FFD100] bg-[#2F3E46] shadow-md">
      <div className={`${GRID} border-b border-white/15 px-4 py-3 text-sm font-bold text-white`}>
        <span>Subject / Learning Area</span>
        <span>Status</span>
        <span>Outputs</span>
      </div>
      {subjects.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-gray-300">{emptyText || 'No subjects have been set for this level yet.'}</p>
      ) : (
        <ul>
          {subjects.map((subject, index) => (
            <li
              key={subject.subjectId}
              className={`${GRID} px-4 py-3 text-sm text-gray-100 ${index < subjects.length - 1 ? 'border-b border-white/10' : ''}`}
            >
              <span className="truncate" title={subject.name}>{subject.name}</span>
              <span><StatusPill status={subject.status} /></span>
              <span className="text-gray-200">{outputsLabel(subject.outputsSubmitted, subject.outputsTotal)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const MONITORING_ROWS: { key: keyof ProgressMonitoring; label: string }[] = [
  { key: 'modulesCompleted', label: 'Modules/Activities Completed' },
  { key: 'modulesPending', label: 'Modules/Activities Pending' },
  { key: 'outputsSubmitted', label: 'Outputs Submitted' },
  { key: 'outputsNotSubmitted', label: 'Outputs Not Submitted' },
  { key: 'participationNotes', label: 'Progress/Participation Notes' },
  { key: 'concerns', label: 'Education-Related Concerns' },
];

/** The learner's Education Progress Monitoring record, read-only. */
export function MonitoringDetails({ monitoring }: { monitoring: ProgressMonitoring | null }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-bold text-[#2F3E46]">
          <ClipboardList className="h-4 w-4" /> Education Progress Monitoring
        </h4>
        {monitoring && (
          <span className="text-[11px] text-gray-500">
            Date of Monitoring:{' '}
            <span className="font-semibold text-[#2F3E46]">{monitoring.monitoringDate ? formatShortDate(monitoring.monitoringDate) : '—'}</span>
            {monitoring.updatedBy ? ` · by ${monitoring.updatedBy}` : ''}
          </span>
        )}
      </div>
      {!monitoring ? (
        <p className="text-xs italic text-gray-400">No monitoring has been recorded yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {MONITORING_ROWS.map(({ key, label }) => (
            <div key={key} className={`rounded-lg bg-gray-50 px-3 py-2 ${key === 'participationNotes' || key === 'concerns' ? 'sm:col-span-2' : ''}`}>
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{label}</p>
              <p className="mt-0.5 whitespace-pre-wrap text-sm text-[#2F3E46]">{String(monitoring[key] || '') || '—'}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Read-only Education Progress, from data already loaded (Child Record). */
export function EducationProgressReadOnly({ progress }: { progress: LearnerProgress | null }) {
  if (!progress) {
    return <p className="text-xs italic text-gray-400">No education progress has been recorded yet.</p>;
  }
  return (
    <div className="space-y-3">
      {progress.total > 0 && <StatusCounts counts={progress.counts} light />}
      <ProgressTable subjects={progress.subjects} emptyText="No subjects have been set for this learner's level yet." />
      <MonitoringDetails monitoring={progress.monitoring} />
    </div>
  );
}

function manilaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
}

const EMPTY_MONITORING: ProgressMonitoring = {
  monitoringDate: null,
  modulesCompleted: '',
  modulesPending: '',
  outputsSubmitted: '',
  outputsNotSubmitted: '',
  participationNotes: '',
  concerns: '',
};

interface DraftSubject {
  subjectId: string;
  name: string;
  status: ProgressStatus;
  outputsSubmitted: string;
  outputsTotal: string;
}

const toDraft = (s: SubjectProgress): DraftSubject => ({
  subjectId: s.subjectId,
  name: s.name,
  status: s.status,
  outputsSubmitted: s.outputsSubmitted === null || s.outputsSubmitted === undefined ? '' : String(s.outputsSubmitted),
  outputsTotal: s.outputsTotal === null || s.outputsTotal === undefined ? '' : String(s.outputsTotal),
});

/**
 * The Education module's Education Progress view for one learner: the table,
 * the monitoring record, the Educator's Edit, and (for whoever may create
 * subjects) the level's subject list.
 */
export function EducationProgressPanel({
  learner,
  canManageSubjects: mayManageSubjects,
  onChanged,
  readOnly = false,
  startInEdit = false,
}: {
  learner: ProgressLearner;
  /** May add or remove subjects for the level. */
  canManageSubjects: boolean;
  /** Called after progress or the subject list was saved, so other views refresh. */
  onChanged?: () => void;
  /** View only — no Edit, no subject management (the student View page). */
  readOnly?: boolean;
  /** Open straight into editing when the reader may edit (Edit Education Progress). */
  startInEdit?: boolean;
}) {
  const [progress, setProgress] = useState<LearnerProgress | null>(null);
  const [mayEdit, setCanEdit] = useState(false);
  const canEdit = mayEdit && !readOnly;
  const canManageSubjects = mayManageSubjects && !readOnly && !progress?.archived;
  const autoEditFor = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [editing, setEditing] = useState(false);
  const [draftSubjects, setDraftSubjects] = useState<DraftSubject[]>([]);
  const [draftMonitoring, setDraftMonitoring] = useState<ProgressMonitoring>(EMPTY_MONITORING);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [managing, setManaging] = useState(false);
  const [newSubject, setNewSubject] = useState('');
  const [manageError, setManageError] = useState('');
  const [adding, setAdding] = useState(false);

  const level = subjectLevelFor(learner.educationLevel);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const res = await request<{ data: LearnerProgress; canEdit?: boolean }>(`/education-progress/${encodeURIComponent(learner.id)}`);
        if (cancelled) return;
        setProgress(res.data || null);
        setCanEdit(Boolean(res.canEdit));
      } catch (error) {
        if (!cancelled) setLoadError(describeError(error, 'Could not load the education progress.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [learner.id, reloadKey]);

  // A different learner never inherits an open edit.
  useEffect(() => { setEditing(false); setManaging(false); setSaveError(''); autoEditFor.current = null; }, [learner.id]);

  const startEdit = () => {
    if (!progress) return;
    setDraftSubjects(progress.subjects.map(toDraft));
    setDraftMonitoring(progress.monitoring
      ? { ...EMPTY_MONITORING, ...progress.monitoring }
      : { ...EMPTY_MONITORING, monitoringDate: manilaToday() });
    setSaveError('');
    setManaging(false);
    setEditing(true);
  };

  // Edit Education Progress opens straight into the edit form, once per learner.
  useEffect(() => {
    if (!startInEdit || !canEdit || !progress || loading || autoEditFor.current === learner.id) return;
    if (progress.educationRecordId !== learner.id) return;
    autoEditFor.current = learner.id;
    startEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startInEdit, canEdit, progress, loading, learner.id]);

  const setDraft = (subjectId: string, patch: Partial<DraftSubject>) =>
    setDraftSubjects((rows) => rows.map((row) => (row.subjectId === subjectId ? { ...row, ...patch } : row)));

  /** Fill the four list fields from the statuses set above (the Educator can then edit them). */
  const fillFromSubjects = () => {
    const names = (statuses: ProgressStatus[]) =>
      draftSubjects.filter((s) => statuses.includes(s.status)).map((s) => s.name).join(', ');
    const submitted = draftSubjects
      .filter((s) => Number(s.outputsSubmitted) > 0)
      .map((s) => `${s.name}: ${outputsLabel(Number(s.outputsSubmitted), s.outputsTotal === '' ? null : Number(s.outputsTotal))}`)
      .join('\n');
    const missing = draftSubjects
      .filter((s) => s.outputsTotal !== '' && Number(s.outputsTotal) > Number(s.outputsSubmitted || 0))
      .map((s) => `${s.name}: ${Number(s.outputsTotal) - Number(s.outputsSubmitted || 0)} not submitted`)
      .join('\n');
    setDraftMonitoring((m) => ({
      ...m,
      modulesCompleted: names(['Completed']),
      modulesPending: names(['Pending', 'Ongoing', 'Not Started', 'Submitted']),
      outputsSubmitted: submitted,
      outputsNotSubmitted: missing,
    }));
  };

  const save = async () => {
    setSaveError('');
    if (!draftMonitoring.monitoringDate) { setSaveError('Enter the Date of Monitoring.'); return; }
    for (const row of draftSubjects) {
      if (row.outputsSubmitted !== '' && row.outputsTotal !== '' && Number(row.outputsSubmitted) > Number(row.outputsTotal)) {
        setSaveError(`${row.name}: outputs submitted cannot be more than the total outputs.`);
        return;
      }
    }
    setSaving(true);
    try {
      const res = await request<{ data: LearnerProgress; canEdit?: boolean }>(`/education-progress/${encodeURIComponent(learner.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          subjects: draftSubjects.map((row) => ({
            subjectId: row.subjectId,
            status: row.status,
            outputsSubmitted: row.outputsSubmitted === '' ? null : Number(row.outputsSubmitted),
            outputsTotal: row.outputsTotal === '' ? null : Number(row.outputsTotal),
          })),
          monitoring: {
            monitoringDate: draftMonitoring.monitoringDate,
            modulesCompleted: draftMonitoring.modulesCompleted,
            modulesPending: draftMonitoring.modulesPending,
            outputsSubmitted: draftMonitoring.outputsSubmitted,
            outputsNotSubmitted: draftMonitoring.outputsNotSubmitted,
            participationNotes: draftMonitoring.participationNotes,
            concerns: draftMonitoring.concerns,
          },
        }),
      });
      setProgress(res.data || null);
      setEditing(false);
      onChanged?.();
    } catch (error) {
      setSaveError(describeError(error, 'The education progress was not saved.'));
    } finally {
      setSaving(false);
    }
  };

  const subjectNames = useMemo(() => (progress?.subjects || []).map((s) => s.name.trim().toLowerCase()), [progress]);

  const addSubject = async () => {
    const name = newSubject.trim();
    setManageError('');
    if (!name) { setManageError('Type the subject name.'); return; }
    if (subjectNames.includes(name.toLowerCase())) {
      setManageError(`"${name}" is already on this level's list.`);
      return;
    }
    setAdding(true);
    try {
      const list = await request<{ data: EducationSubject[] }>(`/education-subjects?educationLevel=${encodeURIComponent(level)}`);
      const sortOrder = (Array.isArray(list.data) ? list.data : []).reduce((max, s) => Math.max(max, Number(s.sortOrder) || 0), 0) + 1;
      await createResource<EducationSubject>('education-subjects', { educationLevel: level, name, sortOrder } as EducationSubject);
      setNewSubject('');
      setReloadKey((k) => k + 1);
      onChanged?.();
    } catch (error) {
      setManageError(describeError(error, 'The subject was not added.'));
    } finally {
      setAdding(false);
    }
  };

  const removeSubject = async (subject: SubjectProgress) => {
    const confirmed = await systemDialog.confirm({
      title: `Remove ${subject.name}?`,
      description: `It will be removed from the subject list for ${learner.levelLabel}, together with every learner's progress in it.`,
      confirmLabel: 'Remove subject',
      tone: 'warning',
    });
    if (!confirmed) return;
    try {
      await deleteResource('education-subjects', subject.subjectId);
      setReloadKey((k) => k + 1);
      onChanged?.();
    } catch (error) {
      void systemDialog.failure('Could not remove the subject', describeError(error, `${subject.name} is still on the list.`));
    }
  };

  if (loading && !progress) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl bg-gray-50 py-8 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading education progress…
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-3 py-3 text-sm text-red-700">
        <AlertCircle className="h-4 w-4 shrink-0" /> {loadError}
      </div>
    );
  }
  if (!progress) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-[#2F3E46]">Education Progress</p>
          <p className="text-[11px] text-gray-500">{learner.levelLabel} · {progress.total} subject{progress.total !== 1 ? 's' : ''}/module{progress.total !== 1 ? 's' : ''}</p>
        </div>
        {canEdit && !editing && (
          <Button
            size="sm"
            className="gap-1.5 rounded-lg font-bold"
            style={{ backgroundColor: '#FFD100', color: '#2F3E46' }}
            onClick={startEdit}
          >
            <Pencil className="h-3.5 w-3.5" /> Edit Progress
          </Button>
        )}
      </div>

      {startInEdit && !canEdit && (
        <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
          {progress.archived
            ? 'This student is in the Archive. Their education progress is kept as history and is view-only.'
            : 'View only — only the Educator can edit a student\'s education progress.'}
        </p>
      )}

      {!editing ? (
        <>
          {progress.total > 0 && <StatusCounts counts={progress.counts} light />}
          <ProgressTable
            subjects={progress.subjects}
            emptyText={`No subjects have been set for ${learner.levelLabel} yet.${canManageSubjects ? ' Use “Manage subjects” below to add them.' : ''}`}
          />
          <MonitoringDetails monitoring={progress.monitoring} />
        </>
      ) : (
        <div className="space-y-4">
          {/* Same table, with each subject's status and outputs editable. */}
          <div className="overflow-hidden rounded-xl border-b-4 border-[#FFD100] bg-[#2F3E46] shadow-md">
            <div className={`${GRID} border-b border-white/15 px-4 py-3 text-sm font-bold text-white`}>
              <span>Subject / Learning Area</span>
              <span>Status</span>
              <span>Outputs <span className="font-normal text-gray-300">(submitted / total)</span></span>
            </div>
            {draftSubjects.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-gray-300">No subjects have been set for this level yet.</p>
            ) : (
              <ul>
                {draftSubjects.map((row, index) => (
                  <li key={row.subjectId} className={`${GRID} px-4 py-2.5 text-sm text-gray-100 ${index < draftSubjects.length - 1 ? 'border-b border-white/10' : ''}`}>
                    <span className="truncate" title={row.name}>{row.name}</span>
                    <select
                      value={row.status}
                      onChange={(e) => setDraft(row.subjectId, { status: e.target.value as ProgressStatus })}
                      aria-label={`${row.name} status`}
                      className="h-8 w-full rounded-lg border-0 bg-white px-2 text-xs font-semibold text-[#2F3E46] focus:outline-none focus:ring-2 focus:ring-[#FFD100]"
                    >
                      {PROGRESS_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                    <span className="flex items-center gap-1 text-xs text-gray-200">
                      <input
                        type="number"
                        min={0}
                        max={999}
                        inputMode="numeric"
                        value={row.outputsSubmitted}
                        onChange={(e) => setDraft(row.subjectId, { outputsSubmitted: e.target.value.replace(/[^0-9]/g, '') })}
                        aria-label={`${row.name} outputs submitted`}
                        className="h-8 w-11 rounded-lg border-0 bg-white px-1 text-center text-xs font-semibold text-[#2F3E46] focus:outline-none focus:ring-2 focus:ring-[#FFD100]"
                      />
                      /
                      <input
                        type="number"
                        min={0}
                        max={999}
                        inputMode="numeric"
                        value={row.outputsTotal}
                        onChange={(e) => setDraft(row.subjectId, { outputsTotal: e.target.value.replace(/[^0-9]/g, '') })}
                        aria-label={`${row.name} total outputs`}
                        className="h-8 w-11 rounded-lg border-0 bg-white px-1 text-center text-xs font-semibold text-[#2F3E46] focus:outline-none focus:ring-2 focus:ring-[#FFD100]"
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* The monitoring record. */}
          <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="flex items-center gap-2 text-sm font-bold text-[#2F3E46]">
                <ClipboardList className="h-4 w-4" /> Education Progress Monitoring
              </h4>
              {draftSubjects.length > 0 && (
                <Button type="button" variant="outline" size="sm" className="gap-1.5 rounded-lg text-xs" onClick={fillFromSubjects}>
                  <Wand2 className="h-3.5 w-3.5" /> Fill from subject statuses
                </Button>
              )}
            </div>
            <div className="max-w-[12rem]">
              <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500" htmlFor="monitoring-date">Date of Monitoring *</label>
              <Input
                id="monitoring-date"
                type="date"
                value={draftMonitoring.monitoringDate || ''}
                onChange={(e) => setDraftMonitoring((m) => ({ ...m, monitoringDate: e.target.value }))}
                className="mt-1 rounded-lg border border-gray-200 bg-gray-50"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {MONITORING_ROWS.map(({ key, label }) => (
                <div key={key} className={key === 'participationNotes' || key === 'concerns' ? 'sm:col-span-2' : ''}>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500" htmlFor={`monitoring-${key}`}>{label}</label>
                  <Textarea
                    id={`monitoring-${key}`}
                    value={String(draftMonitoring[key] || '')}
                    onChange={(e) => setDraftMonitoring((m) => ({ ...m, [key]: e.target.value }))}
                    rows={2}
                    maxLength={5000}
                    className="mt-1 rounded-lg border border-gray-200 bg-gray-50 text-sm"
                  />
                </div>
              ))}
            </div>
          </div>

          {saveError && (
            <p className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle className="h-4 w-4 shrink-0" /> {saveError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" className="gap-1.5 rounded-lg" onClick={() => { setEditing(false); setSaveError(''); }} disabled={saving}>
              <X className="h-4 w-4" /> Cancel
            </Button>
            <Button
              className="gap-1.5 rounded-lg font-bold"
              style={{ backgroundColor: '#2F3E46', color: 'white' }}
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Progress
            </Button>
          </div>
        </div>
      )}

      {canManageSubjects && !editing && (
        <div className="rounded-xl border border-gray-200 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold text-[#2F3E46]">
              Subjects for {learner.levelLabel}
              <span className="block font-normal text-gray-500">Shared by every learner at this level.</span>
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5 rounded-lg"
              onClick={() => { setManaging((v) => !v); setManageError(''); }}
            >
              <Settings2 className="h-3.5 w-3.5" /> {managing ? 'Done' : 'Manage subjects'}
            </Button>
          </div>
          {managing && (
            <div className="mt-3 space-y-2">
              {progress.subjects.length > 0 && (
                <ul className="space-y-1">
                  {progress.subjects.map((subject) => (
                    <li key={subject.subjectId} className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-1.5 text-sm text-[#2F3E46]">
                      <span className="truncate">{subject.name}</span>
                      <button
                        type="button"
                        onClick={() => void removeSubject(subject)}
                        className="shrink-0 rounded p-1 text-red-500 hover:bg-red-50"
                        aria-label={`Remove ${subject.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <Input
                  value={newSubject}
                  onChange={(e) => { setNewSubject(e.target.value); setManageError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addSubject(); } }}
                  placeholder="e.g. Mathematics"
                  maxLength={150}
                  className="rounded-xl"
                  autoFocus
                />
                <Button
                  type="button"
                  onClick={() => void addSubject()}
                  disabled={adding}
                  className="shrink-0 gap-1.5 rounded-xl font-bold"
                  style={{ backgroundColor: '#FFD100', color: '#2F3E46' }}
                >
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </div>
              {manageError && <p className="text-xs text-red-600">{manageError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
