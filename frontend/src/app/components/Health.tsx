
const NURSE_FORMS_DATA = [
  { name: 'Health Record Form', description: 'Form 10-AB&C — Medical history, treatments & vitals', file: '/forms/health-record.pdf' },
];
import { useEffect, useState, useMemo, type ReactNode } from 'react';
import { createResource, deleteResource, getStore, request } from '@/services/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Textarea } from '@/app/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/app/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/app/components/ui/alert-dialog';
import { Search, Plus, Eye, Edit, Trash2, Pill, Stethoscope, HeartPulse, AlertTriangle, User, Calendar, Printer, FileText, Download, PenLine, X as CloseIcon } from 'lucide-react';
import { useData } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { usePermissions } from '@/app/hooks/usePermissions';
import { useSystemDialog } from './SystemDialog';
import { downloadDocumentFile } from '@/utils/documentFile';
import { formatShortDate } from '@/utils/dateFormatter';

// ── CONSTANTS ──────────────────────────────────────────────────────────────
const ALLERGIES = ['None', 'Penicillin', 'Aspirin', 'Sulfa drugs', 'Food allergies', 'Others'];
const CONDITIONS = ['None', 'Asthma', 'Diabetes', 'Epilepsy', 'Hypertension', 'Malnutrition', 'Mental health condition', 'Others'];
const FREQUENCIES = ['Once daily', 'Twice daily', 'Three times daily', 'Every 8 hours', 'Every 12 hours', 'As needed (PRN)', 'Weekly'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

/**
 * The six record types the API accepts. Every one of them is offered here: the
 * form, the validator and the PDF generator must agree, or a record type can be
 * storable and uncreatable — which is what happened to the assessment,
 * medication and treatment forms, whose fields this component has always been
 * able to render but whose picker never offered them.
 */
const FORM_OPTIONS = [
  { value: 'Medical Record', code: 'Form 11-B', title: 'Health/Medical Record', description: 'Resident medical history and ongoing medical entries.' },
  { value: 'Dental Services', code: 'Form 11-C', title: 'Dental Services', description: 'Dental complaints, services, quantities, and sign-off.' },
  { value: 'Height & Weight Monitoring', code: 'Form 11-A', title: 'Height and Weight Monitoring', description: 'Monthly measurements and quarterly observations.' },
  { value: 'Health Assessment', code: 'Form 11-D', title: 'Health Assessment', description: 'Assessment findings, allergies and known conditions.' },
  { value: 'Medication Log', code: 'Form 11-E', title: 'Medication Log', description: 'Prescribed medication, dosage, frequency and duration.' },
  { value: 'Medical Treatment', code: 'Form 11-F', title: 'Medical Treatment', description: 'Treatment performed, its outcome and follow-up date.' },
] as const;

const EMPTY_FORM = {
  residentId: '', residentName: '',
  recordType: 'Medical Record',
  date: new Date().toISOString().split('T')[0],
  // `doctorSignature` is no longer collected by either form — the medical sheet
  // records the doctor's name and specialization per entry, and the dental sheet
  // records the dentist and the clinic. The field is still carried through
  // unchanged on save so that a signature already stored on an older record is
  // not erased by editing it.
  medicalFindings: '', laboratoryProcedure: '', prescription: '', careProvider: '', doctorSignature: '',
  chiefComplaints: '', referredBy: '', dentalService: '', dentalServiceCount: '', dentalRemarks: '',
  dentistName: '', dentalClinicName: '',
  monitoringYear: new Date().getFullYear().toString(), observations: '', firstQuarter: '', secondQuarter: '', thirdQuarter: '', fourthQuarter: '',
  // Health Assessment
  assessmentType: '', findings: '', allergies: 'None', conditions: 'None',
  // Medication Log
  medicationName: '', dosage: '', frequency: '', duration: '', prescribedBy: '',
  // Medical Treatment
  treatmentType: '', procedure_: '', outcome: '', followUpDate: '',
};

const EMPTY_DENTAL_SERVICES = { extraction: false, extractionNumber: '', prophylaxis: false, denture: false, dentureNumber: '', toothFilling: false, toothFillingNumber: '', brace: false };

/** The dentist's service checklist, in the order the form lists it. */
const DENTAL_SERVICE_ROWS = [
  ['extraction', 'Extraction', 'extractionNumber'],
  ['prophylaxis', 'Prophylaxis', null],
  ['denture', 'Denture', 'dentureNumber'],
  ['toothFilling', 'Tooth filling (cavity)', 'toothFillingNumber'],
  ['brace', 'Brace', null],
] as const;

type DentalServices = typeof EMPTY_DENTAL_SERVICES;

/**
 * The dentist's services as the single string `details.dentalService` holds.
 *
 * The API requires that field on every dental record and the form never wrote
 * it, so a new dental record was refused with "chiefComplaints and dentalService
 * are required" no matter what was ticked. The column already existed; only the
 * value was missing.
 */
function dentalServiceSummary(services: DentalServices) {
  return DENTAL_SERVICE_ROWS
    .filter(([key]) => Boolean(services[key]))
    .map(([, label]) => label)
    .join(', ');
}

/** The ticked counts, for the "Number" column of the official form. */
function dentalServiceCounts(services: DentalServices) {
  return DENTAL_SERVICE_ROWS
    .map(([, , numberKey]) => (numberKey ? String(services[numberKey] || '').trim() : ''))
    .filter(Boolean)
    .join(', ');
}

/**
 * One row of the medical sheet.
 *
 * The sheet is a running log — one row per consultation, each with its own date
 * and its own doctor — so a factory keeps the three places that create a row
 * (the initial state, the reset, and "Add entry") from drifting apart.
 * `doctorSignature` is carried through untouched: it is no longer collected, but
 * an older row that has one must survive being re-saved.
 */
function emptyMedicalRow(date?: string) {
  return {
    date: date || new Date().toISOString().split('T')[0],
    findings: '',
    laboratoryProcedure: '',
    prescription: '',
    careProvider: '',
    doctorName: '',
    specialization: '',
    doctorSignature: '',
  };
}

/** The numeric part of a free-text measurement, or NaN. */
function measurement(value: unknown) {
  const parsed = Number.parseFloat(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN;
}

/**
 * Height in metres.
 *
 * The sheet records centimetres and the labels say so, but the fields are free
 * text and older rows were filled in metres. A value of 3 or less is read as
 * metres rather than producing a BMI 10,000× too large.
 */
function heightInMetres(height: unknown) {
  const value = measurement(height);
  if (Number.isNaN(value)) return NaN;
  return value > 3 ? value / 100 : value;
}

/**
 * BMI for one month's measurements, to one decimal place, or '' when the month
 * has not been filled in yet.
 */
function bmiFor(height: unknown, weight: unknown) {
  const metres = heightInMetres(height);
  const kilograms = measurement(weight);
  if (Number.isNaN(metres) || Number.isNaN(kilograms)) return '';
  const bmi = kilograms / (metres * metres);
  if (!Number.isFinite(bmi) || bmi <= 0) return '';
  return bmi.toFixed(1);
}

/** The band the computed BMI falls in, for the reference column. */
function bmiBand(bmi: string) {
  if (!bmi) return '';
  const value = Number.parseFloat(bmi);
  if (value < 18.5) return 'Below healthy range';
  if (value < 25) return 'Healthy range';
  if (value < 30) return 'Above healthy range';
  return 'Well above healthy range';
}

/**
 * The healthy weight range for a height, as the 18.5–24.9 BMI band expressed in
 * kilograms. This is the reference the sheet is read against; it is derived from
 * the recorded height rather than typed, so it cannot disagree with it.
 */
function healthyWeightRange(height: unknown) {
  const metres = heightInMetres(height);
  if (Number.isNaN(metres)) return '';
  return `${(18.5 * metres * metres).toFixed(1)}–${(24.9 * metres * metres).toFixed(1)} kg`;
}

// ── FORM LAYOUT PRIMITIVES ─────────────────────────────────────────────────
//
// The same shape the Quarterly Progress Report and the Anecdotal Report forms
// use: one card per block, a brand heading bar, and a labelled field grid that
// collapses to a single column on a phone.

function FormSection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 bg-[#2F3E46] px-4 py-2.5">
        <h3 className="text-xs font-black uppercase tracking-wider text-white">{title}</h3>
        {note && <span className="text-[10px] font-semibold uppercase tracking-wider text-[#FFD100]">{note}</span>}
      </header>
      <div className="space-y-4 p-4 sm:p-5">{children}</div>
    </section>
  );
}

function Field({ label, hint, required, className, children }: { label: string; hint?: string; required?: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={['space-y-1.5', className].filter(Boolean).join(' ')}>
      <Label className="text-[11px] font-bold uppercase tracking-wider text-[#2F3E46]">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </Label>
      {children}
      {hint && <p className="text-[10px] leading-snug text-gray-400">{hint}</p>}
    </div>
  );
}

/** A value the system already knows — printed, not typed. */
function ReadOnlyField({ label, value, className }: { label: string; value?: string | number | null; className?: string }) {
  const shown = value === undefined || value === null || String(value).trim() === '' ? '—' : String(value);
  return (
    <Field label={label} className={className}>
      <div className="flex h-9 items-center truncate rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm text-gray-700">
        {shown}
      </div>
    </Field>
  );
}

function SectionNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-[11px] leading-relaxed text-blue-800">{children}</p>
  );
}

// ── TYPE ICON HELPER ────────────────────────────────────────────────────────
function RecordTypeBadge({ type }: { type: string }) {
  if (type === 'Medication Log')
    return <Badge className="bg-purple-100 text-purple-700 border-none gap-1"><Pill className="w-3 h-3" />{type}</Badge>;
  if (type === 'Medical Treatment')
    return <Badge className="bg-blue-100 text-blue-700 border-none gap-1"><Stethoscope className="w-3 h-3" />{type}</Badge>;
  return <Badge className="bg-green-100 text-green-700 border-none gap-1"><HeartPulse className="w-3 h-3" />{type}</Badge>;
}

// ── RECORD ID ───────────────────────────────────────────────────────────────
// The id is the server's to allocate. This screen used to send
// `HLT<max+1>` computed from the rows it could see, so two people filing a
// health record at the same time derived the same id — see the note on
// `provisionalKey` in `state/DataContext`. The payload now carries no id and
// the store is re-read after the save.

export function Health() {
  // The records come from the shared store, not a private fetch: the same rows
  // are listed in Child Records → Medical → Health & Medical History, and two
  // independent loads is how the two views end up disagreeing.
  const { children, healthRecords, documents, refreshData } = useData();
  const { user } = useAuth();
  const { can } = usePermissions();
  const dialog = useSystemDialog();

  const [searchTerm, setSearchTerm] = useState('');
  const [filterResident, setFilterResident] = useState('all');
  const [activeTab, setActiveTab] = useState('all');
  const [showForms, setShowForms] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [childToDelete, setChildToDelete] = useState<string | null>(null);
  const [isFormPickerOpen, setIsFormPickerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [viewRecord, setViewRecord] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [monthlyMeasurements, setMonthlyMeasurements] = useState(() => Array.from({ length: 12 }, (_, index) => ({ month: index + 1, height: '', weight: '' })));
  const [medicalRows, setMedicalRows] = useState(() => [emptyMedicalRow()]);
  const [dentalServices, setDentalServices] = useState<DentalServices>({ ...EMPTY_DENTAL_SERVICES });

  // Medical records and documents are created and managed by the Nurse and the
  // Center Head only — the same capability that unlocks the Medical Notes field
  // on the child's Medical tab.
  const canManageMedical = can('Health', 'edit');

  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  /**
   * The resident the record is being written for. Read from the shared store, so
   * every auto-filled field on the form comes from the resident's own record
   * rather than from a second copy that could disagree with it.
   */
  const formResident = useMemo(
    () => children.find(child => child.id === form.residentId) || null,
    [children, form.residentId],
  );

  /** The official form this record belongs to, for the toolbar and the print title. */
  const formOption = FORM_OPTIONS.find(option => option.value === form.recordType);

  const chooseHealthForm = (recordType: typeof FORM_OPTIONS[number]['value']) => {
    resetForm();
    const selectedResident = filterResident !== 'all' ? children.find(child => child.id === filterResident) : null;
    setForm(p => ({ ...p, recordType, residentId: selectedResident?.id || '', residentName: selectedResident?.name || '' }));
    setIsFormPickerOpen(false);
    setIsFormOpen(true);
  };

  const resetForm = () => {
    setForm({ ...EMPTY_FORM });
    setMonthlyMeasurements(Array.from({ length: 12 }, (_, index) => ({ month: index + 1, height: '', weight: '' })));
    setMedicalRows([emptyMedicalRow()]);
    setDentalServices({ ...EMPTY_DENTAL_SERVICES });
    setEditingId(null); setFormError(''); setSaveMessage(''); setIsFormOpen(false);
  };

  const openEdit = (r: any) => {
    setForm({
      residentId: r.residentId || '',
      residentName: r.residentName || '',
      recordType: r.recordType || 'Medical Record',
      date: r.date || new Date().toISOString().split('T')[0],
      medicalFindings: r.details?.medicalFindings || '', laboratoryProcedure: r.details?.laboratoryProcedure || '', prescription: r.details?.prescription || '', careProvider: r.details?.careProvider || '', doctorSignature: r.details?.doctorSignature || '',
      chiefComplaints: r.details?.chiefComplaints || '', referredBy: r.details?.referredBy || '', dentalService: r.details?.dentalService || '', dentalServiceCount: r.details?.dentalServiceCount || '', dentalRemarks: r.details?.dentalRemarks || '',
      dentistName: r.details?.dentistName || '', dentalClinicName: r.details?.dentalClinicName || '',
      monitoringYear: r.details?.monitoringYear || new Date().getFullYear().toString(), observations: r.details?.observations || '', firstQuarter: r.details?.firstQuarter || '', secondQuarter: r.details?.secondQuarter || '', thirdQuarter: r.details?.thirdQuarter || '', fourthQuarter: r.details?.fourthQuarter || '',
      assessmentType: r.assessmentType || '',
      findings: r.findings || '',
      allergies: r.allergies || 'None',
      conditions: r.conditions || 'None',
      medicationName: r.medicationName || '',
      dosage: r.dosage || '',
      frequency: r.frequency || '',
      duration: r.duration || '',
      prescribedBy: r.prescribedBy || '',
      treatmentType: r.treatmentType || '',
      procedure_: r.procedure_ || '',
      outcome: r.outcome || '',
      followUpDate: r.followUpDate || '',
    });
    setMonthlyMeasurements(r.details?.monthlyMeasurements || Array.from({ length: 12 }, (_, index) => ({ month: index + 1, height: '', weight: '' })));
    // A record written before the sheet became a running log has a single set of
    // fields on `details` rather than a `medicalRows` array; it is lifted into one
    // row so the older shape stays editable instead of appearing blank.
    setMedicalRows(
      (r.details?.medicalRows || [{
        date: r.date || new Date().toISOString().split('T')[0],
        findings: r.details?.medicalFindings || '',
        laboratoryProcedure: r.details?.laboratoryProcedure || '',
        prescription: r.details?.prescription || '',
        careProvider: r.details?.careProvider || '',
        doctorName: r.details?.doctorName || '',
        specialization: r.details?.specialization || '',
        doctorSignature: r.details?.doctorSignature || '',
      }]).map((row: Partial<ReturnType<typeof emptyMedicalRow>>) => ({ ...emptyMedicalRow(row.date), ...row })),
    );
    setDentalServices(r.details?.dentalServices || { ...EMPTY_DENTAL_SERVICES });
    setEditingId(r.id);
    setFormError('');
    setSaveMessage('');
    setIsFormOpen(true);
  };

  const validateForm = () => {
    if (!form.residentId) return 'Please select a resident.';
    if (!form.date) return 'Please select a date.';
    if (form.recordType === 'Medical Record' && medicalRows.every(row => !row.findings.trim() && !row.laboratoryProcedure.trim() && !row.prescription.trim() && !row.careProvider.trim() && !row.doctorName.trim())) return 'Add at least one medical record row.';
    if (form.recordType === 'Dental Services' && (!form.chiefComplaints.trim() || !Object.values(dentalServices).some(value => value === true))) return 'Chief complaint and at least one dental service are required.';
    if (form.recordType === 'Height & Weight Monitoring' && !form.monitoringYear.trim()) return 'Monitoring year is required.';
    if (form.recordType === 'Health Assessment' && (!form.assessmentType.trim() || !form.findings.trim())) return 'Assessment type and findings are required.';
    if (form.recordType === 'Medication Log' && (!form.medicationName.trim() || !form.dosage.trim() || !form.frequency)) return 'Medication name, dosage, and frequency are required.';
    if (form.recordType === 'Medical Treatment' && (!form.treatmentType.trim() || !form.procedure_.trim())) return 'Treatment type and procedure are required.';
    return null;
  };

  const handleSave = async () => {
    const err = validateForm();
    if (err) { setFormError(err); setSaveMessage(''); return; }
    setIsSaving(true);
    setFormError('');
    setSaveMessage('');
    // The dental checklist is the source of truth for the two fields the API
    // requires; they were previously sent straight from `form`, which nothing on
    // this screen ever set, so every new dental record was refused.
    const isDental = form.recordType === 'Dental Services';
    // `editingId` is still needed for the PUT branch; a new record must not
    // carry an id at all, or the client would be choosing the primary key.
    const entry = {
      ...form,
      ...(editingId ? { id: editingId } : {}),
      status: 'Completed',
      recordedBy: user?.username || 'Staff',
      dentalService: isDental ? dentalServiceSummary(dentalServices) : form.dentalService,
      dentalServiceCount: isDental ? dentalServiceCounts(dentalServices) : form.dentalServiceCount,
      details: {
        medicalFindings: form.medicalFindings,
        laboratoryProcedure: form.laboratoryProcedure,
        prescription: form.prescription,
        careProvider: form.careProvider,
        doctorSignature: form.doctorSignature,
        medicalRows,
        dentalServices,
        chiefComplaints: form.chiefComplaints,
        referredBy: form.referredBy,
        dentalService: isDental ? dentalServiceSummary(dentalServices) : form.dentalService,
        dentalServiceCount: isDental ? dentalServiceCounts(dentalServices) : form.dentalServiceCount,
        dentalRemarks: form.dentalRemarks,
        dentistName: form.dentistName,
        dentalClinicName: form.dentalClinicName,
        monitoringYear: form.monitoringYear,
        monthlyMeasurements,
        observations: form.observations,
        firstQuarter: form.firstQuarter,
        secondQuarter: form.secondQuarter,
        thirdQuarter: form.thirdQuarter,
        fourthQuarter: form.fourthQuarter,
      },
    };
    try {
      if (editingId) {
        await request(`/healthRecords/${editingId}`, { method: 'PUT', body: JSON.stringify(entry) });
      } else {
        await createResource('healthRecords', entry);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to save health record.');
      setIsSaving(false);
      return;
    }
    // Re-read rather than patching local state: the record has to appear in the
    // child's Medical tab too, and that view reads the same store.
    await refreshData();
    setIsSaving(false);
    const successMessage = editingId ? 'Health record updated successfully.' : 'Health record saved successfully.';
    resetForm();
    setSaveMessage(successMessage);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try { await deleteResource('healthRecords', deleteTarget.id); } catch { /* local remove */ }
    await refreshData();
    setDeleteTarget(null);
  };

  const filtered = useMemo(() => healthRecords.filter(r => {
    const matchSearch = (r.residentName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (r.id || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchResident = filterResident === 'all' || r.residentId === filterResident;
    const matchTab = activeTab === 'all' || r.recordType === activeTab;
    return matchSearch && matchResident && matchTab;
  }), [healthRecords, searchTerm, filterResident, activeTab]);

  const tabCounts = useMemo(() => ({
    all: healthRecords.length,
    'Health Assessment': healthRecords.filter(r => r.recordType === 'Health Assessment').length,
    'Medication Log': healthRecords.filter(r => r.recordType === 'Medication Log').length,
    'Medical Treatment': healthRecords.filter(r => r.recordType === 'Medical Treatment').length,
  }), [healthRecords]);

  // Per-resident summary for the selected resident filter
  const residentSummary = useMemo(() => {
    if (filterResident === 'all') return null;
    const recs = healthRecords.filter(r => r.residentId === filterResident);
    const lastCheckup = recs.find(r => r.recordType === 'Health Assessment');
    const activeMeds = recs.filter(r => r.recordType === 'Medication Log');
    const conditions = recs.filter(r => r.conditions && r.conditions !== 'None').map(r => r.conditions);
    const allergies = recs.filter(r => r.allergies && r.allergies !== 'None').map(r => r.allergies);
    return { lastCheckup, activeMeds, conditions: [...new Set(conditions)], allergies: [...new Set(allergies)] };
  }, [healthRecords, filterResident]);

  /**
   * The medical documents, read straight from the Documents module.
   *
   * These are the SAME rows the child's Medical tab lists under "Health &
   * Medical History" — one source (`documents` with category 'Medical'), so a
   * file added in either place is one row and can never appear twice. The Health
   * module shows them because the specification requires a file uploaded in
   * Documents to be visible here too.
   */
  const medicalDocuments = useMemo(
    () => documents
      .filter(d => String(d.category || '').trim().toLowerCase() === 'medical')
      .filter(d => filterResident === 'all' || d.residentId === filterResident)
      .sort((a, b) => String(b.uploadedAt || b.approvedAt || '')
        .localeCompare(String(a.uploadedAt || a.approvedAt || ''))),
    [documents, filterResident],
  );

  return (
    <div className="space-y-5 p-2">
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-[#2F3E46]">Health & Medical Records</h2>
          <p className="text-sm text-gray-500">Log health assessments, treatments, and medications</p>
        </div>
        {/* Creating a health record is a `create` capability on Health, which the
            specification grants to the Nurse and the Center Head only. */}
        {can('Health', 'create') && (
          <Button
            style={{ backgroundColor: '#FFD100', color: '#2F3E46' }}
            className="font-bold hover:opacity-90 gap-2"
            onClick={() => { resetForm(); setIsFormPickerOpen(true); }}
          >
            <Plus className="w-4 h-4" /> Log Health Record
          </Button>
        )}
      </div>
      {saveMessage && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-semibold text-green-700">{saveMessage}</div>}

      {/* FILTERS */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input className="pl-10" placeholder="Search by resident or record ID..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
        </div>
        <Select value={filterResident} onValueChange={setFilterResident}>
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue placeholder="Filter by resident" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Residents</SelectItem>
            {children.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* RESIDENT SUMMARY */}
      {residentSummary && (
        <Card className="border border-[#FFD100]/40 bg-[#FFFDF0]">
          <CardContent className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Last Checkup</p>
              <p className="font-semibold text-[#2F3E46]">{residentSummary.lastCheckup ? formatShortDate(residentSummary.lastCheckup.date) : '—'}</p>
            </div>
            <div>
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Active Medications</p>
              <p className="font-semibold text-[#2F3E46]">{residentSummary.activeMeds.length > 0 ? residentSummary.activeMeds.map(m => m.medicationName).join(', ') : '—'}</p>
            </div>
            <div>
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Known Conditions</p>
              <p className="font-semibold text-[#2F3E46]">{residentSummary.conditions.length > 0 ? residentSummary.conditions.join(', ') : 'None'}</p>
            </div>
            <div>
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Allergies</p>
              <p className="font-semibold text-[#2F3E46]">{residentSummary.allergies.length > 0 ? residentSummary.allergies.join(', ') : 'None'}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/*
        Medical documents — the other half of the Health ↔ Medical sync. Files
        filed in the Documents module's Medical Records folder (by the Nurse, the
        Center Head, or the child's Medical tab) are listed here so the Health
        module shows the same set the child's Medical tab does. This is a *view*
        of the Documents module, not a second store of it: the rows are the same
        rows, so there is nothing to de-duplicate.
      */}
      <Card className="border border-gray-200">
        {/* Stacks on a phone. In a row, the hint text and the title compete for
            320px and the title loses — "Medical Documents" broke mid-word
            ("Documen / ts"), which is the same unreadable compression the table
            fixes removed. Side by side again from `sm` up. */}
        <CardHeader className="pb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-sm font-bold text-slate-700 flex items-center gap-2">
            <FileText className="w-4 h-4 text-[#2F3E46] shrink-0" /> Medical Documents
            <Badge className="bg-[#2F3E46]/10 text-[#2F3E46]">{medicalDocuments.length}</Badge>
          </CardTitle>
          <p className="text-[11px] text-gray-400">Filed under Documents → Medical Records</p>
        </CardHeader>
        <CardContent>
          {medicalDocuments.length === 0 ? (
            <p className="py-4 text-center text-sm italic text-gray-400">
              No medical documents filed for this {filterResident === 'all' ? 'set of residents' : 'resident'}.
            </p>
          ) : (
            <div className="divide-y divide-gray-100">
              {medicalDocuments.map(doc => (
                <div key={doc.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[#2F3E46]">{doc.title}</p>
                    <p className="text-[11px] text-gray-400">
                      {children.find(c => c.id === doc.residentId)?.name || doc.residentName || 'Unassigned'}
                      {' · '}
                      {doc.uploadedAt ? formatShortDate(String(doc.uploadedAt).slice(0, 10)) : '—'}
                      {doc.status ? ` · ${doc.status}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 gap-1 px-2 text-xs"
                    onClick={() => downloadDocumentFile(
                      doc,
                      (message) => { void dialog.failure('Could not download the document', message); },
                    )}
                  >
                    <Download className="w-3 h-3" /> Download
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div>
        <button
          onClick={() => setShowForms(v => !v)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-green-200 text-green-700 bg-green-50 hover:bg-green-100 font-semibold text-sm transition-all"
        >
          <span>📋</span>
          {showForms ? 'Hide Forms' : 'Available Forms'}
        </button>
        {showForms && (
          <div className="mt-3 border border-green-200 rounded-2xl overflow-hidden bg-white shadow-sm">
            <div className="bg-green-600 px-5 py-3 flex items-center gap-2">
              <span className="text-white text-lg">📋</span>
              <h3 className="font-bold text-white">Nurse / Medical Forms</h3>
              <span className="text-green-200 text-xs ml-1">— Click to download</span>
            </div>
            <div className="divide-y divide-gray-100">
              {NURSE_FORMS_DATA.map(form => (
                <div key={form.file} className="flex items-center justify-between px-5 py-3 hover:bg-green-50 transition-all">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-green-100 flex items-center justify-center shrink-0">
                      <span className="text-base">📄</span>
                    </div>
                    <div>
                      <p className="font-semibold text-[#2F3E46] text-sm">{form.name}</p>
                      <p className="text-xs text-gray-400">{form.description}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <button onClick={() => window.open(form.file, '_blank', 'noopener,noreferrer')} className="rounded-lg border border-green-200 px-2.5 py-1.5 text-xs font-bold text-green-600 hover:bg-green-100">View</button>
                    <button onClick={() => { const w=window.open(form.file, '_blank'); w?.addEventListener('load',()=>w.print()); }} className="rounded-lg border border-green-200 px-2.5 py-1.5 text-xs font-bold text-green-600 hover:bg-green-100">Print</button>
                    <button onClick={() => { const l = document.createElement('a'); l.href = form.file; l.download = form.name + '.pdf'; l.click(); }} className="rounded-lg border border-green-200 px-2.5 py-1.5 text-xs font-bold text-green-600 hover:bg-green-100">Download</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* TABS */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-2">
          <TabsTrigger value="all">All ({tabCounts.all})</TabsTrigger>
          <TabsTrigger value="Health Assessment">
            <HeartPulse className="w-3.5 h-3.5 mr-1" /> Assessments ({tabCounts['Health Assessment']})
          </TabsTrigger>
          <TabsTrigger value="Medication Log">
            <Pill className="w-3.5 h-3.5 mr-1" /> Medications ({tabCounts['Medication Log']})
          </TabsTrigger>
          <TabsTrigger value="Medical Treatment">
            <Stethoscope className="w-3.5 h-3.5 mr-1" /> Treatments ({tabCounts['Medical Treatment']})
          </TabsTrigger>
        </TabsList>

        {(['all', 'Health Assessment', 'Medication Log', 'Medical Treatment'] as const).map(tab => (
          <TabsContent key={tab} value={tab}>
            <div className="grid gap-3">
              {filtered.length === 0 ? (
                <Card><CardContent className="py-12 text-center text-gray-400 text-sm italic">No records found.</CardContent></Card>
              ) : filtered.map(record => (
                <Card key={record.id} className="border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
                  <CardContent className="p-5">
                    <div className="flex flex-col sm:flex-row justify-between gap-4">
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="font-bold text-[#2F3E46] text-base">{record.residentName}</span>
                          <RecordTypeBadge type={record.recordType} />
                          {record.recordType === 'Health Assessment' && record.conditions && record.conditions !== 'None' && (
                            <Badge className="bg-orange-100 text-orange-700 border-none gap-1 text-[10px]">
                              <AlertTriangle className="w-3 h-3" />{record.conditions}
                            </Badge>
                          )}
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-sm text-gray-600">
                          <div className="flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5 text-[#FFD100]" />{formatShortDate(record.date)}</div>
                          <div className="flex items-center gap-1.5"><User className="w-3.5 h-3.5 text-[#FFD100]" />{record.recordedBy}</div>
                          <div className="text-[10px] text-gray-400 font-mono">{record.id}</div>

                          {record.recordType === 'Health Assessment' && <>
                            <div><span className="font-medium">Type:</span> {record.assessmentType}</div>
                            {record.allergies && record.allergies !== 'None' && <div><span className="font-medium">Allergies:</span> {record.allergies}</div>}
                          </>}
                          {record.recordType === 'Medication Log' && <>
                            <div><span className="font-medium">Drug:</span> {record.medicationName}</div>
                            <div><span className="font-medium">Dose:</span> {record.dosage} — {record.frequency}</div>
                            {record.duration && <div><span className="font-medium">Duration:</span> {record.duration}</div>}
                          </>}
                          {record.recordType === 'Medical Treatment' && <>
                            <div><span className="font-medium">Treatment:</span> {record.treatmentType}</div>
                            {record.outcome && <div><span className="font-medium">Outcome:</span> {record.outcome}</div>}
                            {record.followUpDate && <div><span className="font-medium">Follow-up:</span> {formatShortDate(record.followUpDate)}</div>}
                          </>}
                          {record.recordType === 'Medical Record' && <>
                            <div><span className="font-medium">Care Provider:</span> {record.details?.careProvider}</div>
                            {record.details?.laboratoryProcedure && <div><span className="font-medium">Laboratory:</span> {record.details.laboratoryProcedure}</div>}
                          </>}
                          {record.recordType === 'Dental Services' && <>
                            <div><span className="font-medium">Service:</span> {record.details?.dentalService}</div>
                            {record.details?.referredBy && <div><span className="font-medium">Referred by:</span> {record.details.referredBy}</div>}
                          </>}
                          {record.recordType === 'Height & Weight Monitoring' && <div><span className="font-medium">Year:</span> {record.details?.monitoringYear}</div>}
                        </div>
                        {(record.findings || record.procedure_) && (
                          <p className="text-xs text-gray-500 italic line-clamp-2 bg-gray-50 rounded px-2 py-1">
                            {record.findings || record.procedure_}
                          </p>
                        )}
                      </div>
                      <div className="flex sm:flex-col gap-2 shrink-0">
                        <Button variant="outline" size="sm" className="gap-1.5 text-[#2F3E46] border-[#2F3E46]/30" onClick={() => setViewRecord(record)}>
                          <Eye className="w-3.5 h-3.5" /> View
                        </Button>
                        {canManageMedical && (
                          <Button variant="outline" size="sm" className="gap-1.5 text-[#2F3E46] border-[#2F3E46]/30" onClick={() => openEdit(record)}>
                            <Edit className="w-3.5 h-3.5" /> Edit
                          </Button>
                        )}
                        {can('Health', 'delete') && (
                          <Button variant="outline" size="sm" className="gap-1.5 text-red-600 border-red-200 hover:border-red-400" onClick={() => setDeleteTarget(record)}>
                            <Trash2 className="w-3.5 h-3.5" /> Delete
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>
        ))}

      </Tabs>

      {/* OFFICIAL FORM SELECTION */}
      <Dialog open={isFormPickerOpen} onOpenChange={setIsFormPickerOpen}>
        <DialogContent className="max-w-3xl rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black text-[#2F3E46]">Select Health Form</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-500">Choose the official SCH form you want to complete.</p>
          <div className="grid gap-4 md:grid-cols-3 py-4">
            {FORM_OPTIONS.map(option => (
              <button key={option.value} type="button" onClick={() => chooseHealthForm(option.value)} className="text-left rounded-2xl border-2 border-gray-200 p-5 hover:border-[#FFD100] hover:bg-[#FFFDF0] transition-colors">
                <p className="text-xs font-black uppercase tracking-wider text-[#2F3E46]">{option.code}</p>
                <h3 className="mt-2 font-bold text-[#2F3E46]">{option.title}</h3>
                <p className="mt-2 text-sm text-gray-500">{option.description}</p>
                <span className="mt-4 inline-block text-xs font-bold text-blue-700">Open form</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/*
        THE RECORD FORM.

        Laid out the way the Quarterly Progress Report form is: a toolbar naming
        the resident and the record, a scrollable body of section cards, and one
        footer that saves. The resident's details are read from their own record
        rather than typed, so the only things a nurse supplies are the findings —
        which is what the form is for.
      */}
      <Dialog open={isFormOpen} onOpenChange={open => { if (!open) resetForm(); }}>
        <DialogContent className="!top-0 !left-0 !flex !h-screen !w-screen !max-h-none !max-w-none !translate-x-0 !translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-white p-0">
          <DialogHeader className="hidden">
            <DialogTitle>{formOption?.title || form.recordType}</DialogTitle>
            <DialogDescription>Record the findings for this resident, then save.</DialogDescription>
          </DialogHeader>

          {/* Toolbar — who the record is for, and which form it is. */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-white px-4 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-[#2F3E46]">{form.residentName || 'New Health Record'}</span>
              <RecordTypeBadge type={form.recordType} />
              <span className="text-xs text-gray-500">
                {formOption?.code || 'Health Record'}
                {' · '}
                {form.date ? formatShortDate(form.date) : 'No date'}
                {' · '}
                {editingId ? `Editing ${editingId}` : 'New record'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={resetForm}>Close</Button>
            </div>
          </div>

          {(formError || saveMessage) && (
            <div className="space-y-2 border-b border-gray-100 bg-white px-4 py-2">
              {saveMessage && <p className="rounded-lg border border-green-100 bg-green-50 px-3 py-2 text-xs text-green-700">{saveMessage}</p>}
              {formError && <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{formError}</p>}
            </div>
          )}

          <div className="relative min-h-0 flex-1 overflow-y-auto bg-neutral-200 px-2 py-4 sm:px-6">
            <div className="mx-auto w-full max-w-[900px] space-y-4">
              <SectionNote>
                The resident&rsquo;s details are already filled in from their record. Add the findings below and save
                &mdash; the record is filed in the resident&rsquo;s Documents folder under Medical Records automatically.
              </SectionNote>

              {/* IDENTIFYING INFORMATION — read from the resident, never typed. */}
              <FormSection title="Identifying Information" note="Auto-filled from the resident's record">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Name of the Child" required className="lg:col-span-2">
                    <Select value={form.residentId} onValueChange={v => { const c = children.find(x => x.id === v); set('residentId', v); set('residentName', c?.name || ''); }}>
                      <SelectTrigger className="rounded-lg"><SelectValue placeholder="Select resident..." /></SelectTrigger>
                      <SelectContent>{children.map(c => <SelectItem key={c.id} value={c.id}>{c.name} ({c.id})</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                  <ReadOnlyField label="Resident ID" value={form.residentId} />
                  <ReadOnlyField label="Age" value={formResident?.age} />
                  <ReadOnlyField label="Sex" value={formResident?.gender} />
                  <ReadOnlyField label="Date of Birth" value={formResident?.birthDate ? formatShortDate(formResident.birthDate) : ''} />
                  <ReadOnlyField label="Date of Admission" value={formResident?.admissionDate ? formatShortDate(formResident.admissionDate) : ''} />
                  <ReadOnlyField label="Case Phase" value={formResident?.casePhase} />
                  <Field label="Date of Record" required>
                    <Input type="date" value={form.date} onChange={e => set('date', e.target.value)} className="rounded-lg" />
                  </Field>
                </div>
              </FormSection>

              {/* ── MEDICAL RECORD (Form 11-B) ────────────────────────────── */}
              {form.recordType === 'Medical Record' && (
                <FormSection
                  title="Medical Record"
                  note={`${medicalRows.length} ${medicalRows.length === 1 ? 'entry' : 'entries'}`}
                >
                  <SectionNote>
                    One row per consultation. Each row carries its own date, so a
                    resident&rsquo;s history is one sheet rather than one record per visit.
                  </SectionNote>
                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="w-full min-w-[1040px] border-collapse text-xs">
                      <thead>
                        <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-[#2F3E46]">
                          <th className="border-b border-gray-200 p-2 text-left font-bold w-32">Date</th>
                          <th className="border-b border-gray-200 p-2 text-left font-bold">Medical Findings</th>
                          <th className="border-b border-gray-200 p-2 text-left font-bold">Laboratory Procedure</th>
                          <th className="border-b border-gray-200 p-2 text-left font-bold">Prescription</th>
                          <th className="border-b border-gray-200 p-2 text-left font-bold">Care Provider</th>
                          <th className="border-b border-gray-200 p-2 text-left font-bold">Doctor&apos;s Name</th>
                          <th className="border-b border-gray-200 p-2 text-left font-bold">Specialization</th>
                          <th className="border-b border-gray-200 p-2 w-10" />
                        </tr>
                      </thead>
                      <tbody>
                        {medicalRows.map((row, index) => (
                          <tr key={index} className="align-top odd:bg-white even:bg-gray-50/60">
                            {(['date', 'findings', 'laboratoryProcedure', 'prescription', 'careProvider', 'doctorName', 'specialization'] as const).map(field => (
                              <td key={field} className="border-b border-gray-100 p-1.5">
                                <Input
                                  type={field === 'date' ? 'date' : 'text'}
                                  value={row[field]}
                                  onChange={event => setMedicalRows(rows => rows.map((item, rowIndex) => rowIndex === index ? { ...item, [field]: event.target.value } : item))}
                                  className="min-w-0 rounded-lg border-gray-200 text-xs"
                                  aria-label={`${field} for medical row ${index + 1}`}
                                />
                              </td>
                            ))}
                            <td className="border-b border-gray-100 p-1.5 text-center">
                              <button
                                type="button"
                                aria-label={`Remove medical row ${index + 1}`}
                                disabled={medicalRows.length === 1}
                                onClick={() => setMedicalRows(rows => rows.length > 1 ? rows.filter((_, rowIndex) => rowIndex !== index) : rows)}
                                className="rounded-md p-1 text-red-500 hover:bg-red-50 disabled:opacity-30"
                              >
                                <CloseIcon className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => setMedicalRows(rows => [...rows, emptyMedicalRow()])}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add entry
                  </Button>
                </FormSection>
              )}

              {/* ── DENTAL SERVICES (Form 11-C) ───────────────────────────── */}
              {form.recordType === 'Dental Services' && (
                <>
                  <FormSection title="Dental Services" note="Form 11-C">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label="Referred By">
                        <Input value={form.referredBy} onChange={e => set('referredBy', e.target.value)} className="rounded-lg" placeholder="Houseparent, guardian, or clinic" />
                      </Field>
                      <Field label="Recorded By">
                        <div className="flex h-9 items-center truncate rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm text-gray-700">
                          {user?.fullName || user?.username || '—'}
                        </div>
                      </Field>
                    </div>
                    <Field label="Chief Complaint(s)" required>
                      <Textarea value={form.chiefComplaints} onChange={e => set('chiefComplaints', e.target.value)} className="rounded-lg min-h-[80px]" placeholder="What the resident reported..." />
                    </Field>
                  </FormSection>

                  <FormSection title="Dentist's Service" note="Tick every service performed">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {DENTAL_SERVICE_ROWS.map(([key, label, numberKey]) => (
                        <div key={key} className="flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2">
                          <label className="flex flex-1 items-center gap-2.5 text-sm text-[#2F3E46]">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[#2F3E46]"
                              checked={dentalServices[key]}
                              onChange={event => setDentalServices(previous => ({ ...previous, [key]: event.target.checked }))}
                            />
                            {label}
                          </label>
                          {numberKey && (
                            <Input
                              type="number"
                              min="0"
                              placeholder="No."
                              aria-label={`${label} count`}
                              value={dentalServices[numberKey]}
                              onChange={event => setDentalServices(previous => ({ ...previous, [numberKey]: event.target.value }))}
                              disabled={!dentalServices[key]}
                              className="w-20 rounded-lg text-xs"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] text-gray-500">
                      Recorded as: <span className="font-semibold text-[#2F3E46]">{dentalServiceSummary(dentalServices) || '—'}</span>
                    </p>
                  </FormSection>

                  <FormSection title="Remarks &amp; Sign-off">
                    <Field label="Remarks">
                      <Textarea value={form.dentalRemarks} onChange={e => set('dentalRemarks', e.target.value)} className="rounded-lg min-h-[70px]" placeholder="Aftercare, follow-up, or any complication..." />
                    </Field>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label="Dentist's Name">
                        <Input value={form.dentistName} onChange={e => set('dentistName', e.target.value)} className="rounded-lg" placeholder="Dr. Juan Dela Cruz" />
                      </Field>
                      <Field label="Dental Clinic Name">
                        <Input value={form.dentalClinicName} onChange={e => set('dentalClinicName', e.target.value)} className="rounded-lg" placeholder="Clinic or health centre" />
                      </Field>
                    </div>
                  </FormSection>
                </>
              )}

              {/* ── HEIGHT & WEIGHT MONITORING (Form 11-A) ────────────────── */}
              {form.recordType === 'Height & Weight Monitoring' && (
                <>
                  <FormSection title="Height and Weight Monitoring" note="Form 11-A">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                      <Field label="Monitoring Year" required>
                        <Input value={form.monitoringYear} onChange={e => set('monitoringYear', e.target.value)} className="rounded-lg max-w-[10rem]" placeholder="2026" />
                      </Field>
                      <ReadOnlyField label="Name of the Child" value={form.residentName} className="sm:col-span-2" />
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-gray-200">
                      <table className="w-full min-w-[820px] border-collapse text-xs">
                        <thead>
                          <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-[#2F3E46]">
                            <th className="border-b border-gray-200 p-2 text-left font-bold w-24">Month</th>
                            {MONTHS.map(month => <th key={month} className="border-b border-gray-200 p-2 text-center font-bold">{month}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {(['height', 'weight'] as const).map(measure => (
                            <tr key={measure} className="align-middle">
                              <th className="border-b border-gray-100 p-2 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500">
                                {measure}
                                <span className="block font-normal normal-case text-gray-400">
                                  {measure === 'height' ? 'cm' : 'kg'}
                                </span>
                              </th>
                              {monthlyMeasurements.map((entry, index) => (
                                <td key={entry.month} className="border-b border-gray-100 p-1">
                                  <Input
                                    aria-label={`${measure} for ${MONTHS[index]}`}
                                    value={entry[measure]}
                                    onChange={e => setMonthlyMeasurements(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, [measure]: e.target.value } : row))}
                                    className="w-full min-w-[3.5rem] rounded-lg border-gray-200 px-1.5 text-center text-xs"
                                  />
                                </td>
                              ))}
                            </tr>
                          ))}
                          {/* BMI and the healthy-weight reference are derived from the
                              two rows above, never typed, so a corrected height
                              corrects both at once. */}
                          <tr className="align-middle bg-gray-50">
                            <th className="border-b border-gray-100 p-2 text-left text-[10px] font-bold uppercase tracking-wider text-[#2F3E46]">
                              BMI
                              <span className="block font-normal normal-case text-gray-400">kg/m&sup2;</span>
                            </th>
                            {monthlyMeasurements.map((entry, index) => (
                              <td
                                key={entry.month}
                                className="border-b border-gray-100 p-1 text-center text-xs font-semibold text-[#2F3E46]"
                                aria-label={`BMI for ${MONTHS[index]}`}
                              >
                                {bmiFor(entry.height, entry.weight) || '—'}
                              </td>
                            ))}
                          </tr>
                          <tr className="align-middle">
                            <th className="border-b border-gray-100 p-2 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500">
                              Healthy weight
                              <span className="block font-normal normal-case text-gray-400">for the height</span>
                            </th>
                            {monthlyMeasurements.map((entry, index) => (
                              <td
                                key={entry.month}
                                className="border-b border-gray-100 p-1 text-center text-[10px] leading-tight text-gray-500"
                                aria-label={`Healthy weight range for ${MONTHS[index]}`}
                              >
                                {healthyWeightRange(entry.height) || '—'}
                              </td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <SectionNote>
                      BMI is computed from the height and weight in the same column, and the
                      healthy-weight reference is the 18.5&ndash;24.9 BMI band for that height.
                      Both are shown for guidance and are not stored separately.
                    </SectionNote>
                  </FormSection>

                  <FormSection title="Observations" note="Narrative">
                    <Field label="Observation">
                      <Textarea value={form.observations} onChange={e => set('observations', e.target.value)} className="rounded-lg min-h-[80px]" placeholder="Growth pattern and any concern..." />
                    </Field>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {([['firstQuarter', '1st Quarter'], ['secondQuarter', '2nd Quarter'], ['thirdQuarter', '3rd Quarter'], ['fourthQuarter', '4th Quarter']] as const).map(([key, label]) => (
                        <Field key={key} label={label}>
                          <Textarea value={form[key]} onChange={e => set(key, e.target.value)} className="rounded-lg min-h-[70px]" />
                        </Field>
                      ))}
                    </div>
                  </FormSection>
                </>
              )}

              {/* ── HEALTH ASSESSMENT (Form 11-D) ─────────────────────────── */}
              {form.recordType === 'Health Assessment' && (
                <FormSection title="Assessment Details" note="Form 11-D">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Assessment Type" required>
                      <Input value={form.assessmentType} onChange={e => set('assessmentType', e.target.value)} placeholder="e.g. Physical Examination" className="rounded-lg" />
                    </Field>
                    <Field label="Allergies">
                      <Select value={form.allergies} onValueChange={v => set('allergies', v)}>
                        <SelectTrigger className="rounded-lg"><SelectValue /></SelectTrigger>
                        <SelectContent>{ALLERGIES.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field>
                    <Field label="Medical Conditions" className="sm:col-span-2">
                      <Select value={form.conditions} onValueChange={v => set('conditions', v)}>
                        <SelectTrigger className="rounded-lg"><SelectValue /></SelectTrigger>
                        <SelectContent>{CONDITIONS.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <Field label="Findings / Notes" required>
                    <Textarea value={form.findings} onChange={e => set('findings', e.target.value)} placeholder="Describe the findings and observations..." className="rounded-lg min-h-[110px]" />
                  </Field>
                </FormSection>
              )}

              {/* ── MEDICATION LOG (Form 11-E) ────────────────────────────── */}
              {form.recordType === 'Medication Log' && (
                <FormSection title="Medication Details" note="Form 11-E">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Medication Name" required>
                      <Input value={form.medicationName} onChange={e => set('medicationName', e.target.value)} placeholder="e.g. Amoxicillin" className="rounded-lg" />
                    </Field>
                    <Field label="Dosage" required>
                      <Input value={form.dosage} onChange={e => set('dosage', e.target.value)} placeholder="e.g. 500mg" className="rounded-lg" />
                    </Field>
                    <Field label="Frequency" required>
                      <Select value={form.frequency} onValueChange={v => set('frequency', v)}>
                        <SelectTrigger className="rounded-lg"><SelectValue placeholder="Select frequency..." /></SelectTrigger>
                        <SelectContent>{FREQUENCIES.map(f => <SelectItem key={f} value={f}>{f}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field>
                    <Field label="Duration">
                      <Input value={form.duration} onChange={e => set('duration', e.target.value)} placeholder="e.g. 7 days" className="rounded-lg" />
                    </Field>
                    <Field label="Prescribed By" className="sm:col-span-2">
                      <Input value={form.prescribedBy} onChange={e => set('prescribedBy', e.target.value)} placeholder="Doctor or prescribing staff name" className="rounded-lg" />
                    </Field>
                    <Field label="Allergies" className="sm:col-span-1">
                      <Select value={form.allergies} onValueChange={v => set('allergies', v)}>
                        <SelectTrigger className="rounded-lg"><SelectValue /></SelectTrigger>
                        <SelectContent>{ALLERGIES.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field>
                    <Field label="Medical Conditions" className="sm:col-span-1">
                      <Select value={form.conditions} onValueChange={v => set('conditions', v)}>
                        <SelectTrigger className="rounded-lg"><SelectValue /></SelectTrigger>
                        <SelectContent>{CONDITIONS.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <Field label="Notes" hint="Side effects, administration instructions, or anything the next shift needs to know.">
                    <Textarea value={form.findings} onChange={e => set('findings', e.target.value)} placeholder="Additional notes..." className="rounded-lg min-h-[80px]" />
                  </Field>
                </FormSection>
              )}

              {/* ── MEDICAL TREATMENT (Form 11-F) ─────────────────────────── */}
              {form.recordType === 'Medical Treatment' && (
                <FormSection title="Treatment Details" note="Form 11-F">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Treatment Type" required>
                      <Input value={form.treatmentType} onChange={e => set('treatmentType', e.target.value)} placeholder="e.g. Wound Care, IV Therapy" className="rounded-lg" />
                    </Field>
                    <Field label="Follow-up Date">
                      <Input type="date" value={form.followUpDate} onChange={e => set('followUpDate', e.target.value)} className="rounded-lg" />
                    </Field>
                  </div>
                  <Field label="Procedure / Description" required>
                    <Textarea value={form.procedure_} onChange={e => set('procedure_', e.target.value)} placeholder="Describe the treatment procedure performed..." className="rounded-lg min-h-[110px]" />
                  </Field>
                  <Field label="Outcome">
                    <Textarea value={form.outcome} onChange={e => set('outcome', e.target.value)} placeholder="Describe the treatment outcome..." className="rounded-lg min-h-[80px]" />
                  </Field>
                </FormSection>
              )}
            </div>
          </div>

          <DialogFooter className="flex-row flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-4 py-3 sm:justify-between">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[11px] text-gray-500">
                <PenLine className="h-3 w-3" />
                Recorded by:{' '}
                <span className="font-semibold text-[#2F3E46]">{user?.fullName || user?.username || '—'}</span>
              </p>
              <p className="mt-0.5 text-[10px] text-gray-400">
                Filed automatically in Documents &rarr; Medical Records when you save.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={resetForm}>Cancel</Button>
              <Button
                disabled={isSaving}
                onClick={handleSave}
                style={{ backgroundColor: '#FFD100', color: '#2F3E46' }}
                className="font-bold rounded-xl px-8 hover:opacity-90"
              >
                {isSaving ? 'Saving...' : editingId ? 'Update Record' : 'Save Record'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* VIEW DIALOG */}
      <Dialog open={!!viewRecord} onOpenChange={open => { if (!open) setViewRecord(null); }}>
        <DialogContent className="max-w-6xl max-h-[92vh] bg-white rounded-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46] font-bold flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">{viewRecord && <RecordTypeBadge type={viewRecord.recordType} />}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => window.print()}><Printer className="w-3.5 h-3.5 mr-1" /> Print</Button>
            </DialogTitle>
          </DialogHeader>
          {viewRecord && (
            <div className="space-y-4 py-2 text-sm">
              <div className="text-center border-y-2 border-[#2F3E46] py-4 uppercase"><p className="text-xs">Republic of the Philippines</p><p className="text-xs">Province of Laguna</p><p className="font-black">City Government of Calamba</p><p className="text-xs">City Social Services Department</p><p className="font-black tracking-widest">Second Chance Home</p><h3 className="mt-2 font-black">{FORM_OPTIONS.find(option => option.value === viewRecord.recordType)?.title || viewRecord.recordType}</h3><p className="text-xs font-bold">{FORM_OPTIONS.find(option => option.value === viewRecord.recordType)?.code}</p></div>
              <div className="grid grid-cols-3 gap-3 border p-3"><span><b>Name:</b> {viewRecord.residentName}</span><span><b>Age:</b> {children.find(child => child.id === viewRecord.residentId)?.age || '—'}</span><span><b>Birthday:</b> {children.find(child => child.id === viewRecord.residentId)?.birthDate || '—'}</span></div>
              {viewRecord.recordType === 'Medical Record' && <div className="overflow-x-auto"><table className="min-w-[1000px] w-full border-collapse text-xs"><thead><tr>{['Date', 'Medical Findings', 'Laboratory Procedure', 'Prescription', 'Care Provider', "Doctor's Name", 'Specialization'].map(label => <th key={label} className="border bg-gray-100 p-2 text-left">{label}</th>)}</tr></thead><tbody>{(viewRecord.details?.medicalRows || []).map((row: any, index: number) => <tr key={index}>{[row.date, row.findings, row.laboratoryProcedure, row.prescription, row.careProvider, row.doctorName, row.specialization].map((value: string, cellIndex: number) => <td key={cellIndex} className="border p-2 align-top">{value || '—'}</td>)}</tr>)}</tbody></table></div>}
              {viewRecord.recordType === 'Height & Weight Monitoring' && <div className="overflow-x-auto"><table className="min-w-[900px] w-full border-collapse text-sm"><thead><tr><th className="border p-2 text-left">Month</th>{MONTHS.map(month => <th key={month} className="border p-2">{month}</th>)}</tr></thead><tbody><tr><th className="border p-2 text-left">Height</th>{(viewRecord.details?.monthlyMeasurements || []).map((row: any) => <td key={row.month} className="border p-2">{row.height || '—'}</td>)}</tr><tr><th className="border p-2 text-left">Weight</th>{(viewRecord.details?.monthlyMeasurements || []).map((row: any) => <td key={row.month} className="border p-2">{row.weight || '—'}</td>)}</tr><tr className="bg-gray-50"><th className="border p-2 text-left">BMI</th>{(viewRecord.details?.monthlyMeasurements || []).map((row: any) => <td key={row.month} className="border p-2 font-semibold">{bmiFor(row.height, row.weight) || '—'}</td>)}</tr><tr><th className="border p-2 text-left text-xs font-normal">Healthy weight for height</th>{(viewRecord.details?.monthlyMeasurements || []).map((row: any) => <td key={row.month} className="border p-2 text-xs text-gray-500">{healthyWeightRange(row.height) || '—'}</td>)}</tr></tbody></table></div>}
              <div className="grid grid-cols-3 gap-y-2 gap-x-3">
                <span className="font-semibold text-gray-500">ID</span><span className="col-span-2 font-mono text-xs">{viewRecord.id}</span>
                <span className="font-semibold text-gray-500">Resident</span><span className="col-span-2 font-medium">{viewRecord.residentName}</span>
                <span className="font-semibold text-gray-500">Date</span><span className="col-span-2">{formatShortDate(viewRecord.date)}</span>
                <span className="font-semibold text-gray-500">Recorded By</span><span className="col-span-2">{viewRecord.recordedBy}</span>

                {viewRecord.recordType === 'Health Assessment' && <>
                  <span className="font-semibold text-gray-500">Assessment</span><span className="col-span-2">{viewRecord.assessmentType}</span>
                  <span className="font-semibold text-gray-500">Allergies</span><span className="col-span-2">{viewRecord.allergies || 'None'}</span>
                  <span className="font-semibold text-gray-500">Conditions</span><span className="col-span-2">{viewRecord.conditions || 'None'}</span>
                </>}
                {viewRecord.recordType === 'Medication Log' && <>
                  <span className="font-semibold text-gray-500">Medication</span><span className="col-span-2">{viewRecord.medicationName}</span>
                  <span className="font-semibold text-gray-500">Dosage</span><span className="col-span-2">{viewRecord.dosage}</span>
                  <span className="font-semibold text-gray-500">Frequency</span><span className="col-span-2">{viewRecord.frequency}</span>
                  <span className="font-semibold text-gray-500">Duration</span><span className="col-span-2">{viewRecord.duration || '—'}</span>
                  <span className="font-semibold text-gray-500">Prescribed By</span><span className="col-span-2">{viewRecord.prescribedBy || '—'}</span>
                </>}
                {viewRecord.recordType === 'Medical Treatment' && <>
                  <span className="font-semibold text-gray-500">Treatment</span><span className="col-span-2">{viewRecord.treatmentType}</span>
                  <span className="font-semibold text-gray-500">Follow-up</span><span className="col-span-2">{viewRecord.followUpDate ? formatShortDate(viewRecord.followUpDate) : '—'}</span>
                </>}
                {viewRecord.recordType === 'Medical Record' && <>
                  <span className="font-semibold text-gray-500">Medical Findings</span><span className="col-span-2">{viewRecord.details?.medicalFindings || '—'}</span>
                  <span className="font-semibold text-gray-500">Laboratory Procedure</span><span className="col-span-2">{viewRecord.details?.laboratoryProcedure || '—'}</span>
                  <span className="font-semibold text-gray-500">Prescription</span><span className="col-span-2">{viewRecord.details?.prescription || '—'}</span>
                  <span className="font-semibold text-gray-500">Care Provider</span><span className="col-span-2">{viewRecord.details?.careProvider || '—'}</span>
                </>}
                {viewRecord.recordType === 'Dental Services' && <>
                  <span className="font-semibold text-gray-500">Chief Complaint(s)</span><span className="col-span-2">{viewRecord.details?.chiefComplaints || '—'}</span>
                  <span className="font-semibold text-gray-500">Referred By</span><span className="col-span-2">{viewRecord.details?.referredBy || '—'}</span>
                  <span className="font-semibold text-gray-500">Dental Service</span><span className="col-span-2">{viewRecord.details?.dentalService || '—'}</span>
                  <span className="font-semibold text-gray-500">Number</span><span className="col-span-2">{viewRecord.details?.dentalServiceCount || '—'}</span>
                  <span className="font-semibold text-gray-500">Dentist&apos;s Name</span><span className="col-span-2">{viewRecord.details?.dentistName || '—'}</span>
                  <span className="font-semibold text-gray-500">Dental Clinic</span><span className="col-span-2">{viewRecord.details?.dentalClinicName || '—'}</span>
                </>}
                {viewRecord.recordType === 'Height & Weight Monitoring' && <>
                  <span className="font-semibold text-gray-500">Monitoring Year</span><span className="col-span-2">{viewRecord.details?.monitoringYear || '—'}</span>
                  <span className="font-semibold text-gray-500">Observation</span><span className="col-span-2">{viewRecord.details?.observations || '—'}</span>
                  <span className="font-semibold text-gray-500">1st Quarter</span><span className="col-span-2">{viewRecord.details?.firstQuarter || '—'}</span>
                  <span className="font-semibold text-gray-500">2nd Quarter</span><span className="col-span-2">{viewRecord.details?.secondQuarter || '—'}</span>
                  <span className="font-semibold text-gray-500">3rd Quarter</span><span className="col-span-2">{viewRecord.details?.thirdQuarter || '—'}</span>
                  <span className="font-semibold text-gray-500">4th Quarter</span><span className="col-span-2">{viewRecord.details?.fourthQuarter || '—'}</span>
                  <span className="font-semibold text-gray-500">Prepared by / Nurse</span><span className="col-span-2">{viewRecord.recordedBy || '—'}</span>
                </>}
              </div>
              {(viewRecord.findings || viewRecord.procedure_) && (
                <div className="border-t pt-3">
                  <p className="font-semibold text-gray-600 mb-1 text-xs uppercase tracking-wider">
                    {viewRecord.recordType === 'Medical Treatment' ? 'Procedure' : 'Findings & Notes'}
                  </p>
                  <div className="bg-gray-50 p-3 rounded-xl text-sm italic text-gray-700 leading-relaxed border">
                    "{viewRecord.findings || viewRecord.procedure_}"
                  </div>
                </div>
              )}
              {viewRecord.outcome && (
                <div>
                  <p className="font-semibold text-gray-600 mb-1 text-xs uppercase tracking-wider">Outcome</p>
                  <div className="bg-blue-50 p-3 rounded-xl text-sm text-blue-800 leading-relaxed border border-blue-100">
                    {viewRecord.outcome}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setViewRecord(null)} style={{ backgroundColor: '#2F3E46' }} className="text-white rounded-xl">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DELETE CONFIRM */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent className="bg-white rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[#2F3E46] font-bold">Delete Health Record</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the <strong>{deleteTarget?.recordType}</strong> record for <strong>{deleteTarget?.residentName}</strong> dated {deleteTarget && formatShortDate(deleteTarget.date)}. This cannot be undone.
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