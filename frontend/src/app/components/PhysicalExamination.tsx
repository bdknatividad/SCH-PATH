import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { request, fetchBinary, describeError } from '@/services/api';
import { useAuth } from '@/app/state/AuthContext';
import { useData } from '@/app/state/DataContext';
import { systemDialog } from '@/app/components/SystemDialog';
import { formatShortDate, getCurrentPHDate } from '@/utils/dateFormatter';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Textarea } from '@/app/components/ui/textarea';
import { Badge } from '@/app/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/app/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Stethoscope, Plus, Eye, FileText, Loader2, Pencil, Trash2, X } from 'lucide-react';

/**
 * Physical Examination — the facility's paper form, digitised.
 *
 * The paper has the resident's name, the date, the date of admission, the age,
 * and a front and back body figure. Here the figures are clickable: a click
 * drops a small marker on the spot and asks what was found there (a tattoo or a
 * piercing, the body part, a label and notes). Markers stay small on the figure
 * and open a popup when clicked, so the form does not fill up with text.
 *
 * Saving files the examination as a "Physical Examination" PDF in the
 * resident's Documents (under their open admission) and keeps the structured
 * exam so it can be opened again — see physicalExaminationController.js.
 */

export type MarkingType = 'Tattoo' | 'Piercing';
type View = 'front' | 'back';

export interface ExamMarking {
  id: string;
  view: View;
  /** Fractions of the figure's width / height, so a marker stays on its spot at any size. */
  x: number;
  y: number;
  type: MarkingType;
  bodyPart: string;
  label: string;
  notes: string;
}

interface SavedExam {
  id: string;
  residentId: string;
  admissionId?: string | null;
  examDate: string;
  residentAge?: number | null;
  admissionDate?: string | null;
  markings: ExamMarking[];
  documentId?: string | null;
  documentStatus?: string | null;
  examinedBy?: string | null;
  createdAt?: string;
}

/** Mirrored in backend/src/controllers/physicalExaminationController.js. */
export const BODY_PARTS = [
  'Head', 'Face', 'Left Ear', 'Right Ear', 'Eyebrow', 'Nose', 'Lip', 'Tongue', 'Neck',
  'Chest', 'Abdomen', 'Navel', 'Back', 'Upper Back', 'Lower Back',
  'Left Shoulder', 'Right Shoulder', 'Left Arm', 'Right Arm', 'Left Elbow', 'Right Elbow',
  'Left Forearm', 'Right Forearm', 'Left Hand', 'Right Hand', 'Left Finger', 'Right Finger',
  'Hip', 'Buttocks', 'Left Thigh', 'Right Thigh', 'Left Leg', 'Right Leg',
  'Left Knee', 'Right Knee', 'Left Foot', 'Right Foot', 'Other',
] as const;

const FIGURES: Record<View, { src: string; label: string }> = {
  front: { src: '/forms/body-diagram-front.png', label: 'Front' },
  back: { src: '/forms/body-diagram-back.png', label: 'Back' },
};
/** Width / height of both figure images (389 × 1000 and 388 × 1000). */
const FIGURE_RATIO = 389 / 1000;

const TYPE_STYLE: Record<MarkingType, { dot: string; ring: string; pdf: [number, number, number] }> = {
  Tattoo: { dot: 'bg-indigo-600', ring: 'ring-indigo-200', pdf: [0.31, 0.27, 0.9] },
  Piercing: { dot: 'bg-amber-500', ring: 'ring-amber-200', pdf: [0.96, 0.62, 0.04] },
};

/**
 * A first guess at the body part from where the figure was clicked. It is only
 * a starting value for the dropdown — the examiner confirms or changes it. On
 * the front figure the resident's left is on the viewer's right.
 */
export function guessBodyPart(view: View, x: number, y: number): string {
  const residentLeft = view === 'front' ? x > 0.5 : x < 0.5;
  const side = residentLeft ? 'Left' : 'Right';
  if (y < 0.135) return view === 'front' && y > 0.035 ? 'Face' : 'Head';
  if (y < 0.17) return 'Neck';
  if (y >= 0.93) return `${side} Foot`;
  const outer = x < 0.24 || x > 0.76;
  if (outer) {
    if (y < 0.22) return `${side} Shoulder`;
    if (y < 0.47) return `${side} Arm`;
    return `${side} Hand`;
  }
  if (y < 0.22 && (x < 0.33 || x > 0.67)) return `${side} Shoulder`;
  if (y < 0.31) return view === 'front' ? 'Chest' : 'Upper Back';
  if (y < 0.45) return view === 'front' ? 'Abdomen' : 'Lower Back';
  if (y < 0.53) return view === 'front' ? 'Hip' : 'Buttocks';
  if (y < 0.68) return `${side} Thigh`;
  if (y < 0.74) return `${side} Knee`;
  return `${side} Leg`;
}

/** Whole years between a birth date and a day, or null. */
function ageOn(birthDate: string | null | undefined, day: string): number | null {
  const b = String(birthDate || '').slice(0, 10);
  const d = String(day || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [by, bm, bd] = b.split('-').map(Number);
  const [dy, dm, dd] = d.split('-').map(Number);
  let age = dy - by;
  if (dm < bm || (dm === bm && dd < bd)) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

const day = (value: unknown) => String(value || '').slice(0, 10);
const newId = () => `M${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function loadPng(pdf: PDFDocument, src: string) {
  const bytes = await (await fetch(src)).arrayBuffer();
  return pdf.embedPng(bytes);
}

/**
 * The saved document: the paper's header and figures with the markers placed
 * where they were clicked, numbered, and a findings list beneath — on paper
 * the details are what a reader needs, so they are printed in full there.
 */
async function buildExamPdf(input: {
  name: string; examDate: string; admissionDate: string; age: string; markings: ExamMarking[]; examinedBy: string;
}): Promise<{ dataUrl: string; size: number }> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const W = 595.28; const H = 841.89; const M = 60;
  let page = pdf.addPage([W, H]);
  const ink = rgb(0.08, 0.08, 0.08);

  const title = 'Physical Examination';
  page.drawText(title, { x: (W - bold.widthOfTextAtSize(title, 17)) / 2, y: H - 80, size: 17, font: bold, color: ink });

  const field = (label: string, value: string, x: number, y: number, lineEnd: number) => {
    page.drawText(label, { x, y, size: 11, font: bold, color: ink });
    const startX = x + bold.widthOfTextAtSize(label, 11) + 4;
    page.drawLine({ start: { x: startX, y: y - 2 }, end: { x: lineEnd, y: y - 2 }, thickness: 0.6, color: rgb(0.45, 0.45, 0.45) });
    page.drawText(value || '', { x: startX + 3, y: y + 1, size: 11, font, color: ink });
  };
  field('Name:', input.name, M, H - 125, 350);
  field('Date:', input.examDate, 368, H - 125, W - M);
  field('Date of Admission:', input.admissionDate, M, H - 150, 350);
  field('Age:', input.age, 368, H - 150, W - M);

  // Figures — the same size and place as on the paper form.
  const figH = 430; const figW = figH * FIGURE_RATIO; const figTop = H - 185;
  const figX: Record<View, number> = { front: 105, back: W - 105 - figW };
  const markerNumber = new Map(input.markings.map((m, i) => [m.id, i + 1]));
  for (const view of ['front', 'back'] as View[]) {
    const img = await loadPng(pdf, FIGURES[view].src);
    page.drawImage(img, { x: figX[view], y: figTop - figH, width: figW, height: figH });
    const caption = FIGURES[view].label.toUpperCase();
    page.drawText(caption, { x: figX[view] + (figW - font.widthOfTextAtSize(caption, 9)) / 2, y: figTop - figH - 14, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
    for (const m of input.markings.filter((mk) => mk.view === view)) {
      const cx = figX[view] + m.x * figW; const cy = figTop - m.y * figH;
      const [r, g, b] = TYPE_STYLE[m.type].pdf;
      page.drawCircle({ x: cx, y: cy, size: 6.5, color: rgb(r, g, b), borderColor: rgb(1, 1, 1), borderWidth: 1 });
      const n = String(markerNumber.get(m.id));
      page.drawText(n, { x: cx - bold.widthOfTextAtSize(n, 7) / 2, y: cy - 2.4, size: 7, font: bold, color: rgb(1, 1, 1) });
    }
  }

  // Findings.
  let y = figTop - figH - 42;
  const ensure = (space: number) => {
    if (y - space < M) { page = pdf.addPage([W, H]); y = H - M; }
  };
  const wrap = (text: string, size: number, maxWidth: number): string[] => {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines: string[] = []; let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > maxWidth && line) { lines.push(line); line = word; } else { line = next; }
    }
    if (line) lines.push(line);
    return lines.length ? lines : ['—'];
  };
  ensure(40);
  page.drawText('Tattoos / Piercings', { x: M, y, size: 12, font: bold, color: ink });
  y -= 18;
  if (input.markings.length === 0) {
    page.drawText('None observed.', { x: M, y, size: 10.5, font, color: ink });
    y -= 16;
  } else {
    const cols = [M, M + 24, M + 84, M + 194, M + 324];
    const headers = ['#', 'Type', 'Body Part', 'Label / Description', 'Notes'];
    headers.forEach((h, i) => page.drawText(h, { x: cols[i], y, size: 9.5, font: bold, color: ink }));
    y -= 5;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
    y -= 12;
    input.markings.forEach((m, i) => {
      const labelLines = wrap(m.label, 9.5, cols[4] - cols[3] - 8);
      const noteLines = wrap(m.notes, 9.5, W - M - cols[4]);
      const rows = Math.max(labelLines.length, noteLines.length);
      ensure(rows * 12 + 6);
      page.drawText(String(i + 1), { x: cols[0], y, size: 9.5, font, color: ink });
      page.drawText(m.type, { x: cols[1], y, size: 9.5, font, color: ink });
      page.drawText(m.bodyPart, { x: cols[2], y, size: 9.5, font, color: ink });
      labelLines.forEach((l, k) => page.drawText(l, { x: cols[3], y: y - k * 12, size: 9.5, font, color: ink }));
      noteLines.forEach((l, k) => page.drawText(l, { x: cols[4], y: y - k * 12, size: 9.5, font, color: ink }));
      y -= rows * 12 + 6;
    });
  }
  ensure(24);
  y -= 8;
  page.drawText(`Examined by: ${input.examinedBy}`, { x: M, y, size: 10, font, color: ink });

  const bytes = await pdf.save();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return { dataUrl: `data:application/pdf;base64,${btoa(binary)}`, size: bytes.length };
}

// ── The body diagram ────────────────────────────────────────────────────────

function BodyFigure({
  view, markings, editable, onPlace, onOpen,
}: {
  view: View;
  markings: ExamMarking[];
  editable: boolean;
  onPlace: (view: View, x: number, y: number) => void;
  onOpen: (marking: ExamMarking) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!editable || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    onPlace(view, x, y);
  };
  return (
    <div className="flex flex-col items-center">
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-400">{FIGURES[view].label}</p>
      <div
        ref={ref}
        onClick={handleClick}
        role={editable ? 'button' : undefined}
        aria-label={editable ? `${FIGURES[view].label} body diagram — click to add a marker` : `${FIGURES[view].label} body diagram`}
        className={`relative select-none ${editable ? 'cursor-crosshair' : ''}`}
        style={{ height: 'min(56vh, 520px)', aspectRatio: `${FIGURE_RATIO}` }}
      >
        <img src={FIGURES[view].src} alt="" draggable={false} className="pointer-events-none h-full w-full" />
        {markings.map((m) => {
          const n = markings.indexOf(m);
          return (
            <button
              key={m.id}
              type="button"
              onClick={(event) => { event.stopPropagation(); onOpen(m); }}
              title={`${m.type} — ${m.bodyPart}`}
              aria-label={`${m.type} on ${m.bodyPart}${m.label ? `: ${m.label}` : ''}`}
              data-marker-index={n}
              className={`absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ring-2 ${TYPE_STYLE[m.type].dot} ${TYPE_STYLE[m.type].ring} hover:scale-125 transition-transform`}
              style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── The form ────────────────────────────────────────────────────────────────

type MarkerDraft = Omit<ExamMarking, 'id'> & { id?: string };

function PhysicalExaminationForm({
  open, onClose, child, admissionDate, exam, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  child: any;
  admissionDate: string;
  /** A saved exam to show read-only, or null for a new one. */
  exam: SavedExam | null;
  onSaved: () => void;
}) {
  const { user } = useAuth();
  const editable = !exam;
  const [examDate, setExamDate] = useState(getCurrentPHDate());
  const [markings, setMarkings] = useState<ExamMarking[]>([]);
  const [draft, setDraft] = useState<MarkerDraft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [viewing, setViewing] = useState<ExamMarking | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (!open) return;
    setExamDate(exam ? day(exam.examDate) : getCurrentPHDate());
    setMarkings(exam ? exam.markings || [] : []);
    setDraft(null); setViewing(null); setSaveError(''); setDraftError('');
  }, [open, exam]);

  const shownAdmission = exam ? day(exam.admissionDate) : day(admissionDate);
  const age = exam?.residentAge ?? ageOn(child?.birthDate, examDate) ?? (Number.isFinite(Number(child?.age)) ? Number(child.age) : null);

  const placeMarker = (view: View, x: number, y: number) => {
    setDraftError('');
    setDraft({ view, x, y, type: 'Tattoo', bodyPart: guessBodyPart(view, x, y), label: '', notes: '' });
  };

  const commitDraft = () => {
    if (!draft) return;
    if (!draft.bodyPart) { setDraftError('Choose the body part.'); return; }
    if (draft.id) {
      setMarkings((list) => list.map((m) => (m.id === draft.id ? { ...(draft as ExamMarking) } : m)));
    } else {
      setMarkings((list) => [...list, { ...draft, id: newId() } as ExamMarking]);
    }
    setDraft(null);
  };

  const removeMarker = (marking: ExamMarking) => {
    setMarkings((list) => list.filter((m) => m.id !== marking.id));
    setViewing(null);
  };

  const save = async () => {
    setSaveError('');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(examDate)) { setSaveError('Enter the date of the examination.'); return; }
    setSaving(true);
    try {
      const pdf = await buildExamPdf({
        name: child?.name || '',
        examDate: formatShortDate(examDate),
        admissionDate: shownAdmission ? formatShortDate(shownAdmission) : '—',
        age: age === null ? '—' : String(age),
        markings,
        examinedBy: user?.username || '',
      });
      await request('/physical-examinations', {
        method: 'POST',
        body: JSON.stringify({
          residentId: child.id,
          examDate,
          residentAge: age,
          markings,
          pdf: {
            fileName: `Physical_Examination_${examDate}_${String(child?.name || child.id).replace(/\s+/g, '_')}.pdf`,
            fileData: pdf.dataUrl,
            fileSize: pdf.size,
          },
        }),
      });
      onSaved();
      onClose();
      void systemDialog.success('Physical Examination saved', 'It is filed in the resident\'s Documents, in the Medical Records folder of the current admission.');
    } catch (error) {
      setSaveError(describeError(error, 'The examination was not saved. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  const tattoos = markings.filter((m) => m.type === 'Tattoo').length;
  const piercings = markings.length - tattoos;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <DialogContent className="max-h-[94vh] w-[96vw] max-w-4xl sm:max-w-4xl overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#2F3E46]">
            <Stethoscope className="h-5 w-5" /> Physical Examination
            {exam && <Badge variant="outline" className="ml-1 text-[10px]">Saved — view only</Badge>}
          </DialogTitle>
        </DialogHeader>

        {/* Header fields, as on the paper form. The resident's own details are
            read from their record rather than typed again. */}
        <div className="grid grid-cols-1 gap-3 rounded-xl border bg-gray-50/60 p-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs font-bold text-[#2F3E46]">Name</Label>
            <div className="rounded-lg border bg-white px-3 py-2 text-sm font-semibold text-[#2F3E46]">{child?.name || '—'}</div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-bold text-[#2F3E46]">Date</Label>
            {editable ? (
              <Input type="date" value={examDate} max={getCurrentPHDate()} onChange={(e) => setExamDate(e.target.value)} className="rounded-lg bg-white" />
            ) : (
              <div className="rounded-lg border bg-white px-3 py-2 text-sm font-semibold text-[#2F3E46]">{formatShortDate(examDate)}</div>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-bold text-[#2F3E46]">Date of Admission</Label>
            <div className="rounded-lg border bg-white px-3 py-2 text-sm font-semibold text-[#2F3E46]">{shownAdmission ? formatShortDate(shownAdmission) : '—'}</div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-bold text-[#2F3E46]">Age</Label>
            <div className="rounded-lg border bg-white px-3 py-2 text-sm font-semibold text-[#2F3E46]">{age ?? '—'}</div>
          </div>
        </div>

        {/* Body diagram */}
        <div className="rounded-xl border p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-[#2F3E46]">Tattoos / Piercings</p>
            <div className="flex items-center gap-3 text-[11px] text-gray-500">
              <span className="inline-flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-full ${TYPE_STYLE.Tattoo.dot}`} /> Tattoo ({tattoos})</span>
              <span className="inline-flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-full ${TYPE_STYLE.Piercing.dot}`} /> Piercing ({piercings})</span>
            </div>
          </div>
          <p className="mb-3 text-xs text-gray-500">
            {editable
              ? 'Click the spot on the figure to add a marker. Click a marker to see, edit or remove it.'
              : 'Click a marker to see its details.'}
          </p>
          <div className="flex flex-wrap items-start justify-center gap-6 sm:gap-16">
            {(['front', 'back'] as View[]).map((view) => (
              <BodyFigure
                key={view}
                view={view}
                markings={markings.filter((m) => m.view === view)}
                editable={editable}
                onPlace={placeMarker}
                onOpen={setViewing}
              />
            ))}
          </div>
          {markings.length === 0 && (
            <p className="mt-3 text-center text-xs italic text-gray-400">No tattoo or piercing marked.</p>
          )}
        </div>

        {saveError && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{saveError}</p>}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>{editable ? 'Cancel' : 'Close'}</Button>
          {editable && (
            <Button onClick={() => void save()} disabled={saving} className="bg-[#2F3E46] text-white">
              {saving ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Saving…</> : 'Save Physical Examination'}
            </Button>
          )}
        </DialogFooter>

        {/* Add / edit a marker */}
        <Dialog open={Boolean(draft)} onOpenChange={(next) => { if (!next) setDraft(null); }}>
          <DialogContent className="max-w-sm rounded-2xl">
            <DialogHeader>
              <DialogTitle className="text-[#2F3E46]">{draft?.id ? 'Edit marker' : 'Add marker'}</DialogTitle>
            </DialogHeader>
            {draft && (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs font-bold">Type *</Label>
                  <div className="flex gap-2">
                    {(['Tattoo', 'Piercing'] as MarkingType[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setDraft({ ...draft, type: t })}
                        className={`flex-1 rounded-lg border-2 py-1.5 text-sm font-bold transition-colors ${draft.type === t ? 'border-[#2F3E46] bg-[#2F3E46] text-white' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-bold">Body Part *</Label>
                  <Select value={draft.bodyPart} onValueChange={(v) => setDraft({ ...draft, bodyPart: v })}>
                    <SelectTrigger aria-label="Body part"><SelectValue placeholder="Select body part" /></SelectTrigger>
                    <SelectContent className="max-h-72">
                      {BODY_PARTS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-bold">Label / Description</Label>
                  <Input value={draft.label} maxLength={200} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="e.g. Rose, initials, stud" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-bold">Notes</Label>
                  <Textarea value={draft.notes} maxLength={1000} rows={3} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Size, colour, condition…" />
                </div>
                {draftError && <p className="text-xs text-red-600">{draftError}</p>}
              </div>
            )}
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
              <Button onClick={commitDraft} className="bg-[#2F3E46] text-white">{draft?.id ? 'Save changes' : 'Add marker'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* A marker's details */}
        <Dialog open={Boolean(viewing)} onOpenChange={(next) => { if (!next) setViewing(null); }}>
          <DialogContent className="max-w-sm rounded-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-[#2F3E46]">
                {viewing && <span className={`h-3 w-3 rounded-full ${TYPE_STYLE[viewing.type].dot}`} />}
                {viewing?.type}
              </DialogTitle>
            </DialogHeader>
            {viewing && (
              <dl className="space-y-2 text-sm">
                <div><dt className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Type</dt><dd className="font-semibold text-[#2F3E46]">{viewing.type}</dd></div>
                <div><dt className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Body Part</dt><dd className="font-semibold text-[#2F3E46]">{viewing.bodyPart}</dd></div>
                <div><dt className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Label / Description</dt><dd className="text-[#2F3E46] whitespace-pre-wrap break-words">{viewing.label || '—'}</dd></div>
                <div><dt className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Notes</dt><dd className="text-[#2F3E46] whitespace-pre-wrap break-words">{viewing.notes || '—'}</dd></div>
              </dl>
            )}
            <DialogFooter className="gap-2">
              {editable && viewing && (
                <>
                  <Button variant="outline" className="text-red-600 hover:bg-red-50" onClick={() => removeMarker(viewing)}>
                    <Trash2 className="mr-1 h-4 w-4" /> Remove
                  </Button>
                  <Button variant="outline" onClick={() => { setDraft({ ...viewing }); setViewing(null); }}>
                    <Pencil className="mr-1 h-4 w-4" /> Edit
                  </Button>
                </>
              )}
              <Button onClick={() => setViewing(null)} className="bg-[#2F3E46] text-white"><X className="mr-1 h-4 w-4" /> Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

// ── The card on the Medical tab ─────────────────────────────────────────────

export function PhysicalExaminationCard({ child, admissionDate }: { child: any; admissionDate?: string | null }) {
  const { user } = useAuth();
  const { refreshData } = useData();
  const role = String(user?.role || '').toLowerCase().replace(/[\s_-]+/g, '');
  // The roles allowed to file a "Physical Examination" document.
  const canCreate = role === 'nurse' || role === 'centerhead';

  const [exams, setExams] = useState<SavedExam[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [openExam, setOpenExam] = useState<SavedExam | null>(null);

  const load = useCallback(async () => {
    if (!child?.id) return;
    setLoading(true);
    setLoadError('');
    try {
      const res = await request<{ data: SavedExam[] }>(`/physical-examinations/resident/${encodeURIComponent(child.id)}`);
      setExams(Array.isArray(res.data) ? res.data : []);
    } catch (error) {
      setLoadError(describeError(error, 'Could not load the physical examinations.'));
    } finally {
      setLoading(false);
    }
  }, [child?.id]);

  useEffect(() => { void load(); }, [load]);

  const openPdf = async (exam: SavedExam) => {
    if (!exam.documentId) return;
    try {
      const { blob } = await fetchBinary(`/documents/${encodeURIComponent(exam.documentId)}/file`);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      void systemDialog.failure('Could not open the PDF', describeError(error, 'Try again from the resident\'s Documents folder.'));
    }
  };

  const latestAdmission = useMemo(() => day(admissionDate), [admissionDate]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-sm font-bold text-slate-600">Physical Examination</CardTitle>
          <p className="mt-0.5 text-xs text-gray-400">Body diagram with tattoos and piercings. Saved examinations are filed in Documents.</p>
        </div>
        {canCreate && (
          <Button size="sm" className="shrink-0 gap-1.5 bg-[#2F3E46] text-white" onClick={() => { setOpenExam(null); setFormOpen(true); }}>
            <Plus className="h-4 w-4" /> Physical Examination
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        ) : loadError ? (
          <p className="text-sm text-red-600">{loadError}</p>
        ) : exams.length === 0 ? (
          <p className="text-sm italic text-gray-400">No physical examination on file for this resident.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {exams.map((exam) => {
              const t = (exam.markings || []).filter((m) => m.type === 'Tattoo').length;
              const p = (exam.markings || []).length - t;
              return (
                <div key={exam.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[#2F3E46]">{formatShortDate(day(exam.examDate))}</p>
                    <p className="text-[11px] text-gray-500">
                      {t} tattoo{t === 1 ? '' : 's'} · {p} piercing{p === 1 ? '' : 's'}
                      {exam.examinedBy ? ` · by ${exam.examinedBy}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {exam.documentStatus && (
                      <Badge variant="outline" className={`text-[10px] ${exam.documentStatus === 'Approved' ? 'border-green-200 text-green-700' : 'border-blue-200 text-blue-700'}`}>
                        {exam.documentStatus}
                      </Badge>
                    )}
                    <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => { setOpenExam(exam); setFormOpen(true); }}>
                      <Eye className="h-3.5 w-3.5" /> View
                    </Button>
                    {exam.documentId && (
                      <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => void openPdf(exam)}>
                        <FileText className="h-3.5 w-3.5" /> PDF
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <PhysicalExaminationForm
        open={formOpen}
        onClose={() => { setFormOpen(false); setOpenExam(null); }}
        child={child}
        admissionDate={latestAdmission}
        exam={openExam}
        onSaved={() => { void load(); void refreshData(); }}
      />
    </Card>
  );
}
