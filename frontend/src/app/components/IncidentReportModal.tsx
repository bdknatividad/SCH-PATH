import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/app/components/ui/dialog';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { Alert, AlertDescription } from '@/app/components/ui/alert';
import { Label } from '@/app/components/ui/label';
import { Textarea } from '@/app/components/ui/textarea';
import { Save, Download, Loader2, ShieldCheck, Clock, Undo2 } from 'lucide-react';
import { Document as PdfDocument, Page as PdfPage, pdfjs } from 'react-pdf';
import { request } from '@/services/api';
import { useAuth } from '../state/AuthContext';
import { SignaturePadModal } from '@/app/components/SignaturePad';
import { getCurrentPHDateTime } from '@/utils/dateFormatter';
import { form8SideForRole, form8SideEntry, form8IsFiler, FORM08_SIDE_BOX_KEY } from '@/app/utils/form08Signing';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// `?v=` is a cache key, not a fetch hint — see the note in QuarterlyProgressReport.tsx.
pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.mjs?v=${pdfjs.version}`;

const FORM_FILE = '/forms/incident-report.pdf';
const PAGE_WIDTH = 612.2;
const PAGE_HEIGHT = 936.2;

/**
 * Where Form 08's four sign-offs are signed, in the template's top-left
 * coordinate space.
 *
 * Mirrors FORM08_SIGNATURE_BOXES in
 * backend/src/controllers/incidentReportController.js — the pad sits exactly
 * where the signature is later stamped onto the generated PDF, so what the
 * signer sees is what gets filed. Each box is the blank band directly above its
 * own label, which is also where the printed name sits.
 */
const SIGNATURE_BOXES = {
  reportedBy: { x: 98, top: 654, width: 152, height: 32 },
  endorsedTo: { x: 387, top: 654, width: 158, height: 32 },
  checkedBy: { x: 36, top: 722, width: 138, height: 32 },
  notedBy: { x: 360, top: 722, width: 167, height: 32 },
  // Psychological Support Staff, below "SWO I - Case Manager".
  psychStaff: { x: 36, top: 804, width: 140, height: 30 },
} as const;

const SIGNATURE_LABELS: Record<keyof typeof SIGNATURE_BOXES, string> = {
  reportedBy: 'Reported by',
  endorsedTo: 'Endorsed to',
  checkedBy: 'Checked by',
  notedBy: 'Noted by',
  psychStaff: 'Psychological Support Staff',
};

/**
 * The lines the person filling the form in signs, and the lines they do not.
 *
 * The three signer lines are drawn by the Social Worker, the Psychological
 * Support Staff and the Center Head from the Form 08 card in the Intervention
 * Tracker — never here — so this form shows them but cannot set them.
 */
const FILER_SIGNATURE_KEYS = ['reportedBy', 'endorsedTo'] as const;
const SIGNER_SIGNATURE_KEYS = ['checkedBy', 'notedBy', 'psychStaff'] as const;

/**
 * The two right-hand sign-off lines are pre-printed, not typed: the same two
 * people endorse and note every Form 08, so leaving them to be filled in meant
 * they could differ — or be left blank — from one report to the next. These
 * mirror the constants the PDF builder stamps, so the preview and the printed
 * form cannot disagree.
 *
 * "Reported by" stays typed: whoever witnessed the incident files the report.
 */
// "Endorsed to" is a fillable name (typed on each report). The other printed
// names mirror the constants the PDF builder stamps, so the preview and the
// printed form cannot disagree.
const FIXED_CHECKED_BY_NAME = 'Francis C. Patricio, RSW';
const FIXED_CHECKED_BY_ROLE = 'SWO I - Case Manager';
const FIXED_NOTED_BY_NAME = 'MARICOR C. NAVARRO, RSW';
const FIXED_NOTED_BY_ROLE = 'SWO II - Center Head';
const FIXED_PSYCH_STAFF_NAME = 'Joyce Anne D.C. Tenorio';
const FIXED_PSYCH_STAFF_ROLE = 'Psychological Support Staff';

const REPORT_TYPES = [
  'Quarrelling', 'Stealing',
  'Threatening Others', 'Runaway',
  'Accident', 'Serious Illness',
  'Discovery of substance used', 'Unusual Sexual Behavior',
];

export interface IncidentReportData {
  id: string;
  violationId: string;
  residentId: string;
  interventionTrackerId?: string | null;
  pdfDocumentId?: string | null;
  reportTypes: string[];
  othersSpecify?: string | null;
  incidentDateTime: string;
  summary?: string | null;
  actionTaken?: string | null;
  result?: string | null;
  reportedBy?: string | null;
  endorsedTo?: string | null;
  checkedBy?: string | null;
  notedBy?: string | null;
  reportedBySignature?: string | null;
  endorsedToSignature?: string | null;
  checkedBySignature?: string | null;
  notedBySignature?: string | null;
  psychStaffSignature?: string | null;
  status: 'Submitted' | 'Pending Review' | 'Verified' | 'Failed' | 'Reassessment';
  statusLabel?: string;
  interventionType?: string | null;
  interventionScheduleDate?: string | null;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
  /**
   * The signing state the API derives for the report — which of the three lines
   * are filled and whose turn it is. Optional because a report fetched before it
   * was saved carries none; the screens read it through `form8SideEntry`.
   */
  signatures?: {
    /** `required: false` for a line this report does not need (the Social Worker's, on a report a Social Worker filed). */
    sides: { side: string; label: string; line: string; required?: boolean; signed: boolean; by: string | null; at: string | null }[];
    signedCount: number;
    total: number;
    complete: boolean;
    /** The account that filed the report, which never signs it. */
    filedBy?: string | null;
    filedByRole?: string | null;
    nextSide: 'sw' | 'psych' | 'ch' | null;
  };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * `sign` is the reviewer's screen: the same full-screen form, read-only, with a
   * pad on the one line this account owns. It is what a Form 08 notification
   * opens, so a signer reads the report they are signing rather than a dialog.
   */
  mode: 'create' | 'view' | 'edit' | 'sign';
  violationId: string | null;
  residentId?: string;
  residentIds?: string[];
  residentName?: string;
  currentUsername?: string;
  violationIds?: string[];
  onSaved?: () => void;
  initialIncidentDateTime?: string;
}

const emptyForm = {
  reportTypes: [] as string[],
  othersSpecify: '',
  // A `datetime-local` reads its value as wall-clock, so the default has to be
  // Manila's wall-clock. `toISOString().slice(0, 16)` is UTC, which offered
  // 06:40 AM as the incident time on a form opened at 2:40 PM.
  incidentDateTime: getCurrentPHDateTime(),
  summary: '',
  actionTaken: '',
  result: '',
  reportedBy: '',
  endorsedTo: '',
  checkedBy: '',
  notedBy: '',
  reportedBySignature: '',
  endorsedToSignature: '',
  checkedBySignature: '',
  notedBySignature: '',
  psychStaffSignature: '',
};

function fieldStyle(x: number, top: number, width: number, height: number, scale: number) {
  return {
    left: `${x * scale}px`,
    top: `${top * scale}px`,
    width: `${width * scale}px`,
    height: `${height * scale}px`,
    boxSizing: 'border-box' as const,
  };
}

function formatDateTime(value?: string | null) {
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-PH', {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function Form08Editor({
  residentName,
  form,
  editable,
  onChange,
  signBoxKey = null,
  signValue = '',
  onSignChange,
  signReady = false,
}: {
  residentName: string;
  form: typeof emptyForm;
  editable: boolean;
  onChange: (key: keyof typeof emptyForm, value: string | string[]) => void;
  /**
   * The line the person looking at this form is signing, if any — the overlay key
   * (`checkedBy`, `notedBy`, `psychStaff`). A pad is drawn on that line and only
   * that line; the other two signer lines show what is already on them.
   */
  signBoxKey?: 'checkedBy' | 'notedBy' | 'psychStaff' | null;
  signValue?: string;
  onSignChange?: (value: string) => void;
  /** False when the API would refuse the signature — someone else's turn, or done. */
  signReady?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [pageWidth, setPageWidth] = useState(760);
  const scale = pageWidth / PAGE_WIDTH;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      if (host.clientWidth > 0) setPageWidth(Math.min(900, host.clientWidth));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const inputClass = 'absolute z-10 rounded-none border-0 bg-transparent px-0 py-0 text-[clamp(8px,1.15vw,11px)] leading-none text-black outline-none focus:bg-yellow-100/80 disabled:bg-white/35';
  const areaClass = 'absolute z-10 resize-none rounded-none border-0 bg-transparent px-0 py-0 text-[clamp(8px,1.05vw,10px)] text-black outline-none focus:bg-yellow-100/80 disabled:bg-white/35';

  const toggleType = (type: string) => {
    const next = form.reportTypes.includes(type)
      ? form.reportTypes.filter(t => t !== type)
      : [...form.reportTypes, type];
    onChange('reportTypes', next);
  };

  return (
    <div ref={hostRef} className="min-h-0 flex-1 overflow-y-auto bg-slate-100 p-3 sm:p-5">
      <div className="mx-auto w-full max-w-[900px]">
        <div className="relative w-full bg-white shadow-xl" style={{ height: `${pageWidth * PAGE_HEIGHT / PAGE_WIDTH}px` }}>
          <div className="absolute inset-0 overflow-hidden">
            <PdfDocument file={FORM_FILE} loading={<div className="p-8 text-center text-sm">Loading official Form 08…</div>}>
              <PdfPage pageNumber={1} width={pageWidth} renderTextLayer={false} renderAnnotationLayer={false} />
            </PdfDocument>
          </div>

          <input
            aria-label="Name of Client"
            value={residentName}
            readOnly
            className={`${inputClass} font-bold`}
            style={{ ...fieldStyle(116.2, 140.5, 239, 15, scale), lineHeight: `${15 * scale}px`, paddingTop: `${0 * scale}px` }}
          />
          <input
            aria-label="Date and Time"
            type="datetime-local"
            value={form.incidentDateTime}
            onChange={e => onChange('incidentDateTime', e.target.value)}
            disabled={!editable}
            className={inputClass}
            style={{ ...fieldStyle(446.9, 140.5, 114, 15, scale), lineHeight: `${15 * scale}px`, paddingTop: `${0 * scale}px` }}
          />

          {REPORT_TYPES.map((type, index) => {
            const row = Math.floor(index / 2);
            const col = index % 2;
            // The labels are already printed in the official PDF. Only place a
            // transparent clickable checkbox over each printed box.
            const top = 180 + row * 13.3;
            const left = col === 0 ? 74 : 348;
            const checked = form.reportTypes.includes(type);
            return (
              <button
                type="button"
                key={type}
                aria-label={type}
                title={type}
                disabled={!editable}
                onClick={() => toggleType(type)}
                className="absolute z-20 flex items-center justify-center border-0 bg-transparent p-0 disabled:cursor-default"
                style={fieldStyle(left, top, 12, 12, scale)}
              >
                <span className="inline-flex h-full w-full items-center justify-center rounded-[1px] border border-black bg-white/20 text-[10px] font-bold leading-none text-black">
                  {checked ? '✓' : ''}
                </span>
              </button>
            );
          })}

          {/* "Other" isn't one of the printed checkboxes, but the digital
              form needs a real, selectable option here — checking it is
              what makes the specify text below count as a valid Type of
              Report selection, same as any of the printed eight. */}
          <button
            type="button"
            aria-label="Other"
            title="Other"
            disabled={!editable}
            onClick={() => toggleType('Other')}
            className="absolute z-20 flex items-center justify-center border-0 bg-transparent p-0 disabled:cursor-default"
            style={fieldStyle(34, 232.8, 12, 12, scale)}
          >
            <span className="inline-flex h-full w-full items-center justify-center rounded-[1px] border border-black bg-white/20 text-[10px] font-bold leading-none text-black">
              {form.reportTypes.includes('Other') ? '✓' : ''}
            </span>
          </button>

          <input
            aria-label="Others specify"
            value={form.othersSpecify}
            onChange={e => onChange('othersSpecify', e.target.value)}
            disabled={!editable}
            placeholder={form.reportTypes.includes('Other') ? 'Please specify...' : ''}
            className={inputClass}
            style={{ ...fieldStyle(120.9, 231.9, 320, 15, scale), lineHeight: `${15 * scale}px`, paddingTop: `${0 * scale}px` }}
          />

          <textarea
            aria-label="Summary of the Incident"
            value={form.summary}
            onChange={e => onChange('summary', e.target.value)}
            disabled={!editable}
            className={areaClass}
            style={{ ...fieldStyle(38, 281.5, 538, 132, scale), lineHeight: `${18 * scale}px`, paddingTop: `${1 * scale}px` }}
          />
          <textarea
            aria-label="Action Taken"
            value={form.actionTaken}
            onChange={e => onChange('actionTaken', e.target.value)}
            disabled={!editable}
            className={areaClass}
            style={{ ...fieldStyle(38, 449.8, 538, 82, scale), lineHeight: `${22 * scale}px`, paddingTop: `${1 * scale}px` }}
          />
          <textarea
            aria-label="Result"
            value={form.result}
            onChange={e => onChange('result', e.target.value)}
            disabled={!editable}
            className={areaClass}
            style={{ ...fieldStyle(38, 573.2, 538, 82, scale), lineHeight: `${22 * scale}px`, paddingTop: `${1 * scale}px` }}
          />

          <input aria-label="Reported by" value={form.reportedBy} onChange={e => onChange('reportedBy', e.target.value)} disabled={!editable} className={inputClass} style={{ ...fieldStyle(98, 687.6, 153, 15, scale), lineHeight: `${15 * scale}px`, paddingTop: `${0 * scale}px` }} />
          <input aria-label="Endorsed to" placeholder={editable ? 'Name' : ''} value={form.endorsedTo} onChange={e => onChange('endorsedTo', e.target.value)} disabled={!editable} className={inputClass} style={{ ...fieldStyle(387, 687.6, 158, 15, scale), lineHeight: `${15 * scale}px`, paddingTop: `${0 * scale}px`, fontWeight: 700 }} />
          <div aria-label="Checked by printed name" className="absolute z-20 pointer-events-none" style={fieldStyle(36, 776.2, 220, 34, scale)}>
            <div className="font-bold text-black" style={{ fontSize: `${8.5 * scale}px`, lineHeight: `${10 * scale}px` }}>{FIXED_CHECKED_BY_NAME}</div>
            <div className="text-black" style={{ fontSize: `${8.5 * scale}px`, lineHeight: `${10 * scale}px` }}>{FIXED_CHECKED_BY_ROLE}</div>
          </div>
          <div aria-label="Noted by printed name" className="absolute z-20 pointer-events-none" style={fieldStyle(360, 776.2, 220, 34, scale)}>
            <div className="font-bold text-black" style={{ fontSize: `${8.5 * scale}px`, lineHeight: `${10 * scale}px` }}>{FIXED_NOTED_BY_NAME}</div>
            <div className="text-black" style={{ fontSize: `${8.5 * scale}px`, lineHeight: `${10 * scale}px` }}>{FIXED_NOTED_BY_ROLE}</div>
          </div>
          {/* Psychological Support Staff: printed name, a signature line under
              it, and the role under the line (its Sign here pad is above). */}
          <div aria-label="Psychological Support Staff printed name" className="absolute z-20 pointer-events-none" style={fieldStyle(36, 836, 142, 30, scale)}>
            <div className="font-bold text-black" style={{ fontSize: `${8.5 * scale}px`, lineHeight: `${12 * scale}px`, borderBottom: '1px solid black' }}>{FIXED_PSYCH_STAFF_NAME}</div>
            <div className="text-black" style={{ fontSize: `${8.5 * scale}px`, lineHeight: `${12 * scale}px` }}>{FIXED_PSYCH_STAFF_ROLE}</div>
          </div>

          {/*
            Only the filer's own two lines are signed here.

            "Checked by", "Noted by" and the Psychological Support Staff line
            belong to the three people who sign them, and they sign from the
            Form 08 card in the Intervention Tracker — each one drawing on their
            own line, in their own session. A pad in this form would let whoever
            filed the report sign on their behalf, which is what the flow exists
            to prevent.

            A line that already carries a signature is still shown, so the
            preview here matches the PDF in the resident's folder.
          */}
          {FILER_SIGNATURE_KEYS.map((key) => {
            const box = SIGNATURE_BOXES[key];
            const field = `${key}Signature` as keyof typeof emptyForm;
            return (
              <div
                key={key}
                className="absolute z-20"
                style={fieldStyle(box.x, box.top, box.width, box.height, scale)}
              >
                <SignaturePadModal
                  label={`${SIGNATURE_LABELS[key]} signature`}
                  value={String(form[field] || '')}
                  onChange={(value) => onChange(field, value)}
                  disabled={!editable}
                  hint="Sign here"
                />
              </div>
            );
          })}

          {/*
            The three signer lines.

            Normally they are shown, never signed here: "Checked by", the psych
            line and "Noted by" belong to the people who own them, and a pad for
            everyone would let whoever filed the report sign on their behalf.

            The exception is the one person looking at this form *to sign it* —
            they get a pad on their own line and nowhere else. The other two keep
            showing what is already on them, so the signer can see the form they
            are adding to, which is the point of opening the report rather than a
            dialog.
          */}
          {SIGNER_SIGNATURE_KEYS.map((key) => {
            const box = SIGNATURE_BOXES[key];
            const drawn = String((form as Record<string, unknown>)[`${key}Signature`] || '');
            const isMine = signBoxKey === key;

            if (isMine && signReady) {
              return (
                <div
                  key={key}
                  data-form08-sign-slot={key}
                  className="absolute z-30"
                  style={fieldStyle(box.x, box.top, box.width, box.height, scale)}
                >
                  <SignaturePadModal
                    label={`${SIGNATURE_LABELS[key]} signature`}
                    value={signValue}
                    onChange={(value) => onSignChange?.(value)}
                    hint="Sign here"
                  />
                </div>
              );
            }

            if (!drawn) return null;
            return (
              <div
                key={key}
                aria-label={`${SIGNATURE_LABELS[key]} signature`}
                className="absolute z-20 pointer-events-none"
                style={fieldStyle(box.x, box.top, box.width, box.height, scale)}
              >
                <img
                  src={drawn}
                  alt={`${SIGNATURE_LABELS[key]} signature`}
                  className="h-full w-full object-contain object-bottom"
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function IncidentReportModal({
  open, onOpenChange, mode, violationId, residentId, residentIds, residentName,
  currentUsername, violationIds, onSaved, initialIncidentDateTime,
}: Props) {
  const { user } = useAuth();
  const [form, setForm] = useState({ ...emptyForm });
  const [report, setReport] = useState<IncidentReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** The signature being drawn in `sign` mode, and its in-flight flag. */
  const [signValue, setSignValue] = useState('');
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  /**
   * The Social Worker's return action. The report is reviewed by the Social
   * Worker first; if something is wrong it goes back to the filer instead of
   * being signed, so the reason is required — the filer is told to correct it
   * and has nothing to act on without one.
   */
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnReason, setReturnReason] = useState('');
  const [returning, setReturning] = useState(false);
  const [returnError, setReturnError] = useState<string | null>(null);

  const role = String(user?.role || '').toLowerCase();
  // The four roles the specification names as filers. The Psychological Staff
  // used to be read-only here — the role files Form 08 and signs it, so it fills
  // it in too.
  const isReadOnly = mode === 'view' || !['socialworker', 'social_worker', 'social worker', 'centerhead', 'center_head', 'center head', 'houseparent', 'psychologist', 'psychological staff', 'admin'].includes(role);

  useEffect(() => {
    if (!open) return;
    setSaveError(null);
    if (mode === 'create') {
      setReport(null);
      setForm({
        ...emptyForm,
        incidentDateTime: initialIncidentDateTime || emptyForm.incidentDateTime,
        reportedBy: user?.fullName || '',
        checkedBy: FIXED_CHECKED_BY_NAME,
        notedBy: FIXED_NOTED_BY_NAME,
      });
      return;
    }
    if ((mode === 'view' || mode === 'edit' || mode === 'sign') && violationId) {
      setLoading(true);
      setSignValue('');
      setSignError(null);
      request(`/incident-reports/violation/${violationId}`, { method: 'GET' })
        .then((res: any) => {
          if (res?.success && res.data) {
            const r = res.data as IncidentReportData;
            setReport(r);
            setForm({
              reportTypes: r.reportTypes || [],
              othersSpecify: r.othersSpecify || '',
              incidentDateTime: String(r.incidentDateTime || '').replace(' ', 'T').slice(0, 16),
              summary: r.summary || '',
              actionTaken: r.actionTaken || '',
              result: r.result || '',
              reportedBy: r.reportedBy || '',
              endorsedTo: r.endorsedTo || '',
              checkedBy: FIXED_CHECKED_BY_NAME,
              notedBy: FIXED_NOTED_BY_NAME,
              reportedBySignature: r.reportedBySignature || '',
              endorsedToSignature: r.endorsedToSignature || '',
              checkedBySignature: r.checkedBySignature || '',
              notedBySignature: r.notedBySignature || '',
              psychStaffSignature: r.psychStaffSignature || '',
            });
          } else {
            setReport(null);
          }
        })
        .catch((err: any) => setSaveError(err?.message || 'Unable to load Incident Report.'))
        .finally(() => setLoading(false));
    }
  }, [open, mode, violationId, residentId, currentUsername, initialIncidentDateTime, user?.username]);

  function update(key: keyof typeof emptyForm, value: string | string[]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (!violationId || !residentId) {
      setSaveError('This Incident Report is not linked to a resident and violation.');
      return;
    }
    if (!form.reportTypes.length) {
      setSaveError('Select at least one Type of Report.');
      return;
    }
    if (form.reportTypes.includes('Other') && !form.othersSpecify.trim()) {
      setSaveError('Please specify the "Other" type of report.');
      return;
    }
    if (!form.summary.trim()) {
      setSaveError('Summary of the Incident is required.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const mysqlDateTime = form.incidentDateTime.replace('T', ' ') + (form.incidentDateTime.length <= 16 ? ':00' : '');
      const targetResidentIds = residentIds?.length ? residentIds : [residentId];
      const targetViolationIds = violationIds?.length ? violationIds : [violationId];
      const pairCount = Math.min(targetResidentIds.length, targetViolationIds.length);

      const payload = {
        incidentDateTime: mysqlDateTime,
        reportTypes: form.reportTypes,
        othersSpecify: form.othersSpecify || null,
        summary: form.summary,
        actionTaken: form.actionTaken,
        result: form.result,
        reportedBy: form.reportedBy,
        endorsedTo: form.endorsedTo,
        checkedBy: form.checkedBy,
        notedBy: form.notedBy,
        reportedBySignature: form.reportedBySignature || null,
        endorsedToSignature: form.endorsedToSignature || null,
      };

      if (mode === 'edit' && report?.id) {
        const response: any = await request(`/incident-reports/${report.id}/resubmit`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (!response?.success) throw new Error(response?.message || 'Unable to resubmit Incident Report.');
      } else {
        for (let i = 0; i < pairCount; i += 1) {
          const response: any = await request('/incident-reports', {
            method: 'POST',
            body: JSON.stringify({
              violationId: targetViolationIds[i],
              residentId: targetResidentIds[i],
              ...payload,
            }),
          });
          if (!response?.success) throw new Error(response?.message || 'Unable to save Incident Report.');
        }
      }

      onOpenChange(false);
      onSaved?.();
    } catch (err: any) {
      setSaveError(err?.message || 'Unable to save Incident Report.');
    } finally {
      setSaving(false);
    }
  }

  async function viewPdf() {
    const documentId = report?.pdfDocumentId;
    if (!documentId) {
      setSaveError('No PDF copy is linked to this Form 08 yet.');
      return;
    }
    try {
      const response: any = await request(`/documents/${documentId}`, { method: 'GET' });
      const base64 = response?.data?.fileData;
      if (!base64) throw new Error('PDF file data is not available.');
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err: any) {
      setSaveError(err?.message || 'Unable to open the saved PDF.');
    }
  }

  /*
   * The signing state for `sign` mode.
   *
   * The API decides everything — which line this account owns, whether it is
   * that line's turn, and whether this signature completes the form — so this
   * only decides what to draw: a pad on the caller's own line when the form is
   * waiting on them, and a plain reading of the form otherwise.
   */
  const mySide = mode === 'sign' ? form8SideForRole(role) : null;
  const signBoxKey = mySide ? FORM08_SIDE_BOX_KEY[mySide] : null;
  const myLine = form8SideEntry(report, mySide);
  // The filer never signs their own report, and a line the report does not need
  // (the Social Worker's, when a Social Worker filed it) is not offered. The API
  // refuses both as well.
  const iFiledIt = form8IsFiler(report, user?.username);
  const myLineRequired = myLine?.required !== false;
  const signReady = Boolean(mode === 'sign' && mySide && !iFiledIt && myLineRequired && !myLine?.signed && report?.signatures?.nextSide === mySide);
  const waitingOn = form8SideEntry(report, report?.signatures?.nextSide);
  const signBlockedReason = (() => {
    if (mode !== 'sign' || !report) return null;
    if (!mySide) return 'Your role has no line to sign on Form 08.';
    if (iFiledIt) return 'You filed this Incident Report, so you cannot sign or approve it.';
    if (!myLineRequired) return 'This report was filed by a Social Worker, so the Social Worker signature is not required. It is approved by the Psychological Support Staff and the Center Head.';
    if (myLine?.signed) return `You have already signed this report (${myLine.by}).`;
    if (report.status === 'Verified' || report.signatures?.complete) return 'This report has all its required signatures.';
    if (!signReady) {
      return waitingOn
        ? `Waiting for the ${waitingOn.label} signature first — the form reaches you after that.`
        : 'This report is not ready for your signature yet.';
    }
    return null;
  })();

  /**
   * Sign this account's own line.
   *
   * The signature goes to the Incident Report, not to the document: the report is
   * the record, and the endpoint is what decides whether this caller's line is
   * the one the form is waiting on and whether this signature completes it. On
   * the third signature the linked document becomes 'Approved', which is what
   * unlocks `Mark Done` — so the caller is asked to refresh afterwards.
   */
  async function handleSign() {
    if (!report?.id) return;
    if (!signValue) {
      setSignError('Draw your signature first.');
      return;
    }
    setSigning(true);
    setSignError(null);
    try {
      const response: any = await request(`/incident-reports/${report.id}/verify`, {
        method: 'POST',
        body: JSON.stringify({ signature: signValue }),
      });
      if (!response?.success) throw new Error(response?.message || 'Unable to sign the Incident Report.');
      setSignValue('');
      onOpenChange(false);
      onSaved?.();
    } catch (err: any) {
      setSignError(err?.message || 'The signature was not recorded. Please try again.');
    } finally {
      setSigning(false);
    }
  }

  /**
   * Return the report to the filer instead of signing it.
   *
   * The Social Worker reviews the filed report first, so this is their other
   * outcome: the reason is required, and the return clears every signature and
   * sends the incident back to the Intervention Tracker as "Fill Out Again".
   * It reuses the Documents module's tested return path — `Reassessment` — so
   * the incident, the document and the filer's notification stay in step.
   */
  const canReturn = Boolean(
    mode === 'sign'
      && mySide === 'sw'
      && !iFiledIt
      && myLineRequired
      && report
      && !report.signatures?.complete
      && ['Submitted', 'Pending Review'].includes(String(report.status)),
  );

  async function handleReturn() {
    if (!report?.pdfDocumentId) {
      setReturnError('This report has no linked document, so it cannot be returned from here.');
      return;
    }
    const reason = returnReason.trim();
    if (!reason) {
      setReturnError('Write a reason for the filer — they are told to correct the report and need to know what to fix.');
      return;
    }
    setReturning(true);
    setReturnError(null);
    try {
      await request(`/documents/${report.pdfDocumentId}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'Reassessment', rejectionReason: reason }),
      });
      setReturnOpen(false);
      setReturnReason('');
      onOpenChange(false);
      onSaved?.();
    } catch (err: any) {
      setReturnError(err?.message || 'The report could not be returned. Please try again.');
    } finally {
      setReturning(false);
    }
  }

  const title = mode === 'create'
    ? 'Incident Report'
    : mode === 'edit'
      ? 'Fill Out Incident Report Again'
      : mode === 'sign'
        ? `Incident Report · Sign the “${SIGNATURE_LABELS[signBoxKey || 'checkedBy']}” line`
        : `Incident Report${report?.status ? ` · ${report.statusLabel || report.status}` : ''}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="!top-0 !left-0 !h-[100dvh] !w-screen !max-h-none !max-w-none !translate-x-0 !translate-y-0 rounded-none p-0 overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0 border-b bg-white px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <DialogTitle className="text-[#2F3E46]">{title}</DialogTitle>
              <p className="text-xs text-gray-500">{residentName || 'Client'} · Digital fill-out form</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {report?.status && <Badge className={report.status === 'Failed' || report.status === 'Reassessment' ? 'bg-yellow-100 text-yellow-800 border-yellow-200' : ''}>{report.statusLabel || report.status}</Badge>}
              {report?.pdfDocumentId && <Button size="sm" variant="outline" onClick={viewPdf}><Download className="mr-1 h-4 w-4" /> View Saved PDF</Button>}
            </div>
          </div>
        </DialogHeader>

        {saveError && <div className="mx-4 mt-3 shrink-0"><Alert variant="destructive"><AlertDescription>{saveError}</AlertDescription></Alert></div>}

        {/*
          This form is where Form 08 is both filled in and signed.
          `create`/`edit` draw the filer's own two lines; `sign` opens the same
          form read-only with a pad on the one line the signed-in account owns, so
          a signer reads the report they are signing instead of a dialog over it.
          The three signatures arrive in strict order — the Social Worker first,
          then the Psychological Support Staff, then the Center Head — and the
          form is approved on the third. The API enforces all of that;
          this screen only draws what it allows.
        */}

        {/*
          The signing banner. It states whose turn it is before the signer hunts
          for their line, and states the refusal plainly when it is not theirs —
          the API answers 409 for the same cases, but a signer who opened the
          report from a notification deserves to know why there is no pad.
        */}
        {mode === 'sign' && report && (
          <div className={`mx-4 mt-3 shrink-0 rounded-lg border px-3 py-2 text-xs ${signReady ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
            {signReady
              ? <>Draw your signature on the “{SIGNATURE_LABELS[signBoxKey || 'checkedBy']}” line below, then press Sign. {report.signatures?.nextSide === 'ch' ? 'This is the last signature — the report is approved once you sign.' : ''}</>
              : signBlockedReason}
          </div>
        )}

        {signError && <div className="mx-4 mt-3 shrink-0"><Alert variant="destructive"><AlertDescription>{signError}</AlertDescription></Alert></div>}

        {loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center bg-slate-100 text-sm text-gray-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading Incident Report…</div>
        ) : (
          <Form08Editor
            residentName={residentName || report?.residentId || ''}
            form={form}
            editable={!isReadOnly && (mode === 'create' || mode === 'edit')}
            onChange={update}
            signBoxKey={signBoxKey}
            signValue={signValue}
            onSignChange={setSignValue}
            signReady={signReady}
          />
        )}

        <DialogFooter className="shrink-0 border-t bg-white px-4 py-3">
          {(mode === 'create' || mode === 'edit') && !isReadOnly ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving || !form.incidentDateTime} className="bg-[#2F3E46]">
                {saving ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Saving…</> : <><Save className="mr-1 h-4 w-4" /> {mode === 'edit' ? 'Fill Out Again & Resubmit' : 'Save Incident Report'}</>}
              </Button>
            </>
          ) : mode === 'sign' ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={signing || returning}>Close</Button>
              {canReturn && (
                <Button
                  variant="outline"
                  onClick={() => { setReturnError(null); setReturnReason(''); setReturnOpen(true); }}
                  disabled={signing || returning}
                  className="border-amber-300 text-amber-800 hover:bg-amber-50"
                >
                  <Undo2 className="mr-1 h-4 w-4" /> Return for Correction
                </Button>
              )}
              <Button
                onClick={handleSign}
                disabled={signing || returning || !signValue || !signReady}
                className="bg-[#2F3E46]"
                title={signReady ? undefined : signBlockedReason || undefined}
              >
                {signing ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Signing…</> : <><ShieldCheck className="mr-1 h-4 w-4" /> Sign this report</>}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          )}
        </DialogFooter>

        {/*
          The return dialog. One outcome: the report goes back to the filer to be
          corrected, and every signature is cleared. The reason is required — it
          travels to the filer's notification and the tracker row, which is the
          whole point of returning rather than signing.
        */}
        <Dialog open={returnOpen} onOpenChange={(next) => { if (!returning) setReturnOpen(next); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Return this Incident Report?</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                The report goes back to the person who filed it so they can correct it. Every signature is cleared, and it returns to you to review afterwards.
              </p>
              <div>
                <Label htmlFor="incident-return-reason">Reason (required)</Label>
                <Textarea
                  id="incident-return-reason"
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  placeholder="What needs to be corrected?"
                  className="mt-1 min-h-20"
                  disabled={returning}
                />
              </div>
              {returnError && <Alert variant="destructive"><AlertDescription>{returnError}</AlertDescription></Alert>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setReturnOpen(false)} disabled={returning}>Cancel</Button>
              <Button onClick={handleReturn} disabled={returning || !returnReason.trim()} className="bg-[#2F3E46]">
                {returning ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null} Send back for correction
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
