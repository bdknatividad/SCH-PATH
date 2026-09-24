import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/app/components/ui/dialog';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { Alert, AlertDescription } from '@/app/components/ui/alert';
import { Save, Download, Loader2 } from 'lucide-react';
import { Document as PdfDocument, Page as PdfPage, pdfjs } from 'react-pdf';
import { request } from '@/services/api';
import { useAuth } from '../state/AuthContext';
import { SignaturePadModal } from '@/app/components/SignaturePad';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';

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
} as const;

const SIGNATURE_LABELS: Record<keyof typeof SIGNATURE_BOXES, string> = {
  reportedBy: 'Reported by',
  endorsedTo: 'Endorsed to',
  checkedBy: 'Checked by',
  notedBy: 'Noted by',
};

/**
 * The two right-hand sign-off lines are pre-printed, not typed: the same two
 * people endorse and note every Form 08, so leaving them to be filled in meant
 * they could differ — or be left blank — from one report to the next. These
 * mirror the constants the PDF builder stamps, so the preview and the printed
 * form cannot disagree.
 *
 * "Reported by" stays typed: whoever witnessed the incident files the report.
 */
const FIXED_ENDORSED_TO_NAME = "Ma'am Joyce";
const FIXED_CHECKED_BY_NAME = 'Francis C. Patricio, RSW';
const FIXED_CHECKED_BY_ROLE = 'SWO I - Case Manager';
const FIXED_NOTED_BY_NAME = 'Sir Francis';
const FIXED_NOTED_BY_ROLE = 'SWO II - Center Head';

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
  status: 'Submitted' | 'Pending Review' | 'Verified' | 'Failed' | 'Reassessment';
  statusLabel?: string;
  interventionType?: string | null;
  interventionScheduleDate?: string | null;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'view' | 'edit';
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
  incidentDateTime: new Date().toISOString().slice(0, 16),
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
}: {
  residentName: string;
  form: typeof emptyForm;
  editable: boolean;
  onChange: (key: keyof typeof emptyForm, value: string | string[]) => void;
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
          <div aria-label="Endorsed to printed name" className="absolute z-20 pointer-events-none" style={fieldStyle(387, 687.6, 159, 15, scale)}>
            <div className="font-bold text-black" style={{ fontSize: `${8.5 * scale}px`, lineHeight: `${15 * scale}px` }}>{FIXED_ENDORSED_TO_NAME}</div>
          </div>
          <div aria-label="Checked by printed name" className="absolute z-20 pointer-events-none" style={fieldStyle(36, 776.2, 220, 34, scale)}>
            <div className="font-bold text-black" style={{ fontSize: `${8.5 * scale}px`, lineHeight: `${10 * scale}px` }}>{FIXED_CHECKED_BY_NAME}</div>
            <div className="text-black" style={{ fontSize: `${8.5 * scale}px`, lineHeight: `${10 * scale}px` }}>{FIXED_CHECKED_BY_ROLE}</div>
          </div>
          <div aria-label="Noted by printed name" className="absolute z-20 pointer-events-none" style={fieldStyle(360, 776.2, 220, 34, scale)}>
            <div className="font-bold text-black" style={{ fontSize: `${8.5 * scale}px`, lineHeight: `${10 * scale}px` }}>{FIXED_NOTED_BY_NAME}</div>
            <div className="text-black" style={{ fontSize: `${8.5 * scale}px`, lineHeight: `${10 * scale}px` }}>{FIXED_NOTED_BY_ROLE}</div>
          </div>

          {/* One signature pad per sign-off, drawn in place on the form. Each
              keeps its own typed name above it, so an unsigned line still shows
              who was meant to sign. */}
          {(Object.keys(SIGNATURE_BOXES) as Array<keyof typeof SIGNATURE_BOXES>).map((key) => {
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

  const role = String(user?.role || '').toLowerCase();
  const isReadOnly = mode === 'view' || !['socialworker', 'social_worker', 'social worker', 'centerhead', 'center_head', 'center head', 'houseparent', 'admin'].includes(role);

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
    if ((mode === 'view' || mode === 'edit') && violationId) {
      setLoading(true);
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
        checkedBySignature: form.checkedBySignature || null,
        notedBySignature: form.notedBySignature || null,
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

  const title = mode === 'create' ? 'Incident Report' : mode === 'edit' ? 'Fill Out Incident Report Again' : `Incident Report${report?.status ? ` · ${report.statusLabel || report.status}` : ''}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="!top-0 !left-0 !h-screen !w-screen !max-h-none !max-w-none !translate-x-0 !translate-y-0 rounded-none p-0 overflow-hidden flex flex-col">
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

        {loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center bg-slate-100 text-sm text-gray-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading Incident Report…</div>
        ) : (
          <Form08Editor residentName={residentName || report?.residentId || ''} form={form} editable={!isReadOnly && (mode === 'create' || mode === 'edit')} onChange={update} />
        )}

        <DialogFooter className="shrink-0 border-t bg-white px-4 py-3">
          {(mode === 'create' || mode === 'edit') && !isReadOnly ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving || !form.incidentDateTime} className="bg-[#2F3E46]">
                {saving ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Saving…</> : <><Save className="mr-1 h-4 w-4" /> {mode === 'edit' ? 'Fill Out Again & Resubmit' : 'Save Incident Report'}</>}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
