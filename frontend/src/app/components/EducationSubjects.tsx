import { useEffect, useMemo, useState } from 'react';
import { request, createResource, updateResource, deleteResource, describeError } from '@/services/api';
import { systemDialog } from '@/app/components/SystemDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/app/components/ui/dialog';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { BookOpen, Plus, Settings2, Trash2, AlertCircle, Loader2 } from 'lucide-react';

/**
 * Subjects — Pass / Fail per subject, with an automatic Overall Remark.
 *
 * The subject list belongs to the **education level**, not to the learner: the
 * Educator defines it once per level and every learner at that level is graded
 * against the same list. Each learner's results are stored per subject
 * (`education_subject_results`, one row per learner per subject; clearing a
 * mark deletes the row).
 *
 * Laid out after the facility's paper form: the learner's name across the top,
 * the level and LRN beneath it, then one row per subject with a Pass / Fail box,
 * and the overall Pass / Fail at the bottom right.
 */

export type SubjectResultValue = 'Passed' | 'Failed';

export interface EducationSubject {
  id: string;
  educationLevel: string;
  name: string;
  sortOrder: number;
}

interface SubjectResultRow {
  id: string;
  educationRecordId: string;
  residentId?: string | null;
  subjectId: string;
  result: SubjectResultValue;
}

export interface SubjectsLearner {
  id: string;
  name: string;
  residentId?: string;
  educationLevel: string;
  /** Shown beneath the level. Omit (undefined) where the learner has none. */
  idLabel?: string;
  idValue?: string;
  levelLabel: string;
}

/**
 * The Overall Remark, from the number of Passed and Failed subjects.
 *
 * More subjects passed than failed is Passed; anything else (including a tie)
 * is Failed. With nothing marked yet there is no remark. Only marked subjects
 * count, and the remark recomputes on every change.
 */
export function overallRemark(passed: number, failed: number): SubjectResultValue | null {
  if (passed + failed === 0) return null;
  return passed > failed ? 'Passed' : 'Failed';
}

/**
 * A legacy level name resolves to the level whose subject list it now shares,
 * so a record written before a rename is graded against the current list.
 */
export function subjectLevelFor(level: string): string {
  if (level === 'High School') return 'Junior High School';
  if (level === 'ALS - Elementary') return 'ALS Elementary';
  return level;
}

// System theme: slate #2F3E46 with the yellow #FFD100 accent, white boxes
// with the light grey borders used by the rest of the forms.
const BOX_BORDER = '#E5E7EB';

/** The "Pass / Fail" box: the chosen word is underlined, as on the paper form. */
function PassFailBox({
  value,
  onChange,
  disabled,
  busy,
  label,
}: {
  value: SubjectResultValue | null;
  onChange?: (next: SubjectResultValue | null) => void;
  disabled?: boolean;
  busy?: boolean;
  label: string;
}) {
  const interactive = Boolean(onChange) && !disabled;
  const word = (result: SubjectResultValue, text: string) => {
    const chosen = value === result;
    const colour = chosen ? (result === 'Passed' ? 'text-green-700' : 'text-red-600') : 'text-gray-500';
    const classes = `${colour} ${chosen ? 'font-bold underline underline-offset-4 decoration-2' : 'font-medium'}`;
    if (!interactive) return <span className={classes}>{text}</span>;
    return (
      <button
        type="button"
        aria-pressed={chosen}
        aria-label={`${label}: ${text}`}
        onClick={() => onChange?.(chosen ? null : result)}
        className={`${classes} rounded px-1 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD100]`}
      >
        {text}
      </button>
    );
  };

  return (
    <div
      className="flex h-11 items-center justify-center gap-1 rounded-lg border bg-white px-3 text-[15px]"
      style={{ borderColor: BOX_BORDER }}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : (
        <>
          {word('Passed', 'Pass')}
          <span className="text-gray-400">/</span>
          {word('Failed', 'Fail')}
        </>
      )}
    </div>
  );
}

export function EducationSubjectsDialog({
  open,
  onClose,
  learner,
  canMark,
  canManage,
}: {
  open: boolean;
  onClose: () => void;
  learner: SubjectsLearner | null;
  /** May set a subject's Pass / Fail. */
  canMark: boolean;
  /** May add or remove subjects for the level (the Educator). */
  canManage: boolean;
}) {
  const [subjects, setSubjects] = useState<EducationSubject[]>([]);
  const [results, setResults] = useState<SubjectResultRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [savingSubjectId, setSavingSubjectId] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [newSubject, setNewSubject] = useState('');
  const [manageError, setManageError] = useState('');
  const [adding, setAdding] = useState(false);

  const level = learner ? subjectLevelFor(learner.educationLevel) : '';

  useEffect(() => {
    if (!open || !learner) return;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    setManaging(false);
    setNewSubject('');
    setManageError('');
    (async () => {
      try {
        const [subjectResult, resultResult] = await Promise.all([
          request<{ data: EducationSubject[] }>(`/education-subjects?educationLevel=${encodeURIComponent(level)}`),
          request<{ data: SubjectResultRow[] }>(`/education-subject-results?educationRecordId=${encodeURIComponent(learner.id)}`),
        ]);
        if (cancelled) return;
        setSubjects(Array.isArray(subjectResult.data) ? subjectResult.data : []);
        setResults(Array.isArray(resultResult.data) ? resultResult.data : []);
      } catch (error) {
        if (!cancelled) setLoadError(describeError(error, 'Could not load the subjects.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, learner?.id, level]);

  const resultBySubject = useMemo(() => {
    const map = new Map<string, SubjectResultRow>();
    for (const row of results) map.set(row.subjectId, row);
    return map;
  }, [results]);

  // Only results for subjects still on the level's list count toward the remark.
  const passed = subjects.filter((s) => resultBySubject.get(s.id)?.result === 'Passed').length;
  const failed = subjects.filter((s) => resultBySubject.get(s.id)?.result === 'Failed').length;
  const remark = overallRemark(passed, failed);
  const marked = passed + failed;

  const setResult = async (subject: EducationSubject, next: SubjectResultValue | null) => {
    if (!learner) return;
    const previous = results;
    const existing = resultBySubject.get(subject.id);
    // Optimistic, so the Overall Remark moves the moment a box is clicked.
    setResults((rows) => {
      const others = rows.filter((row) => row.subjectId !== subject.id);
      return next
        ? [...others, { ...(existing || { id: `tmp-${subject.id}`, educationRecordId: learner.id, subjectId: subject.id }), result: next }]
        : others;
    });
    setSavingSubjectId(subject.id);
    try {
      if (!next) {
        if (existing && !existing.id.startsWith('tmp-')) {
          await deleteResource('education-subject-results', existing.id);
        }
      } else {
        // The server updates the learner's existing result for this subject
        // rather than adding a second one.
        const saved = await createResource<SubjectResultRow>('education-subject-results', {
          educationRecordId: learner.id,
          residentId: learner.residentId || null,
          subjectId: subject.id,
          result: next,
        } as SubjectResultRow);
        setResults((rows) => rows.map((row) => (row.subjectId === subject.id ? saved : row)));
      }
    } catch (error) {
      setResults(previous);
      void systemDialog.failure('Could not save the result', describeError(error, `The result for ${subject.name} was not changed.`));
    } finally {
      setSavingSubjectId(null);
    }
  };

  const addSubject = async () => {
    const name = newSubject.trim();
    setManageError('');
    if (!name) { setManageError('Type the subject name.'); return; }
    if (subjects.some((s) => s.name.trim().toLowerCase() === name.toLowerCase())) {
      setManageError(`"${name}" is already on this level's list.`);
      return;
    }
    setAdding(true);
    try {
      const sortOrder = subjects.reduce((max, s) => Math.max(max, Number(s.sortOrder) || 0), 0) + 1;
      const saved = await createResource<EducationSubject>('education-subjects', { educationLevel: level, name, sortOrder } as EducationSubject);
      setSubjects((list) => [...list, saved]);
      setNewSubject('');
    } catch (error) {
      setManageError(describeError(error, 'The subject was not added.'));
    } finally {
      setAdding(false);
    }
  };

  const removeSubject = async (subject: EducationSubject) => {
    const confirmed = await systemDialog.confirm({
      title: `Remove ${subject.name}?`,
      description: `It will be removed from the subject list for ${learner?.levelLabel || level}, together with every learner's Pass / Fail in it.`,
      confirmLabel: 'Remove subject',
      tone: 'warning',
    });
    if (!confirmed) return;
    try {
      await deleteResource('education-subjects', subject.id);
      setSubjects((list) => list.filter((s) => s.id !== subject.id));
      setResults((rows) => rows.filter((row) => row.subjectId !== subject.id));
    } catch (error) {
      void systemDialog.failure('Could not remove the subject', describeError(error, `${subject.name} is still on the list.`));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-bold text-[#2F3E46]">
            <BookOpen className="h-5 w-5" /> Subjects
          </DialogTitle>
        </DialogHeader>

        {learner && (
          <div className="space-y-4">
            {/* The form itself — grey panel, white boxes, as on the reference. */}
            <div className="rounded-xl border-b-4 border-[#FFD100] bg-[#2F3E46] p-4 shadow-md sm:p-5">
              <div className="rounded-lg border bg-white px-4 py-2.5 text-xl font-bold text-[#2F3E46]" style={{ borderColor: BOX_BORDER }}>
                {learner.name}
              </div>

              <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-1 text-sm text-gray-300">
                <span>
                  Educational level: <span className="font-semibold text-white">{learner.levelLabel}</span>
                </span>
                {learner.idLabel && (
                  <span className="text-xs sm:text-sm">
                    {learner.idLabel}: <span className="font-semibold text-white">{learner.idValue || '—'}</span>
                  </span>
                )}
              </div>

              <div className="mt-3 space-y-2">
                {loading ? (
                  <div className="flex items-center justify-center gap-2 rounded-lg bg-white/10 py-6 text-sm text-gray-300">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading subjects…
                  </div>
                ) : loadError ? (
                  <div className="flex items-center gap-2 rounded-lg bg-white px-3 py-3 text-sm text-red-700">
                    <AlertCircle className="h-4 w-4 shrink-0" /> {loadError}
                  </div>
                ) : subjects.length === 0 ? (
                  <div className="rounded-lg bg-white/10 px-3 py-5 text-center text-sm text-gray-300">
                    No subjects have been set for {learner.levelLabel} yet.
                    {canManage ? ' Use “Manage subjects” below to add them.' : ' The Educator adds them.'}
                  </div>
                ) : (
                  subjects.map((subject) => (
                    <div key={subject.id} className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2 sm:grid-cols-[minmax(0,1fr)_8.5rem] sm:gap-3">
                      <div
                        className="flex h-11 min-w-0 items-center gap-2 rounded-lg border bg-white px-3 text-[15px] font-medium text-[#2F3E46]"
                        style={{ borderColor: BOX_BORDER }}
                      >
                        <span className="truncate" title={subject.name}>{subject.name}</span>
                        {managing && (
                          <button
                            type="button"
                            onClick={() => void removeSubject(subject)}
                            className="ml-auto shrink-0 rounded p-1 text-red-500 hover:bg-red-50"
                            aria-label={`Remove ${subject.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                      <PassFailBox
                        label={subject.name}
                        value={resultBySubject.get(subject.id)?.result || null}
                        onChange={canMark ? (next) => void setResult(subject, next) : undefined}
                        busy={savingSubjectId === subject.id}
                      />
                    </div>
                  ))
                )}
              </div>

              {/* Overall Remark — bottom right, computed, never clicked. */}
              <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
                <div className="text-right text-xs text-gray-300">
                  <p className="text-sm font-bold uppercase tracking-wide text-[#FFD100]">Overall Remark</p>
                  <p>
                    {remark ? (
                      <span className={remark === 'Passed' ? 'font-semibold text-green-400' : 'font-semibold text-red-400'}>{remark}</span>
                    ) : 'No results yet'}
                    {subjects.length > 0 && ` · ${passed} passed, ${failed} failed${marked < subjects.length ? `, ${subjects.length - marked} not marked` : ''}`}
                  </p>
                </div>
                <div className="w-[9.5rem]">
                  <PassFailBox label="Overall remark" value={remark} />
                </div>
              </div>
            </div>

            {canMark && subjects.length > 0 && (
              <p className="text-[11px] text-gray-500">
                Click Pass or Fail to mark a subject; click the underlined one again to clear it. The Overall Remark is
                Passed when more subjects are passed than failed, and updates as you mark.
              </p>
            )}

            {canManage && (
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
                  <div className="mt-3 space-y-1.5">
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
                    <p className="text-[11px] text-gray-400">Use the bin beside a subject to remove it from this level.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
