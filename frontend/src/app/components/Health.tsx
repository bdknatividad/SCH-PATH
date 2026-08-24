import { useEffect, useState, useCallback, useMemo } from 'react';
import { createResource, deleteResource, getStore, request } from '@/services/api';
import { Card, CardContent } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Textarea } from '@/app/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/app/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/app/components/ui/alert-dialog';
import { Search, Plus, Eye, Edit, Trash2, Pill, Stethoscope, HeartPulse, AlertTriangle, User, Calendar } from 'lucide-react';
import { useData } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { formatShortDate } from '@/utils/dateFormatter';

// ── CONSTANTS ──────────────────────────────────────────────────────────────
const ALLERGIES = ['None', 'Penicillin', 'Aspirin', 'Sulfa drugs', 'Food allergies', 'Others'];
const CONDITIONS = ['None', 'Asthma', 'Diabetes', 'Epilepsy', 'Hypertension', 'Malnutrition', 'Mental health condition', 'Others'];
const FREQUENCIES = ['Once daily', 'Twice daily', 'Three times daily', 'Every 8 hours', 'Every 12 hours', 'As needed (PRN)', 'Weekly'];

const EMPTY_FORM = {
  residentId: '', residentName: '',
  recordType: 'Health Assessment',
  date: new Date().toISOString().split('T')[0],
  // Health Assessment
  assessmentType: '', findings: '', allergies: 'None', conditions: 'None',
  // Medication Log
  medicationName: '', dosage: '', frequency: '', duration: '', prescribedBy: '',
  // Medical Treatment
  treatmentType: '', procedure_: '', outcome: '', followUpDate: '',
};

// ── TYPE ICON HELPER ────────────────────────────────────────────────────────
function RecordTypeBadge({ type }: { type: string }) {
  if (type === 'Medication Log')
    return <Badge className="bg-purple-100 text-purple-700 border-none gap-1"><Pill className="w-3 h-3" />{type}</Badge>;
  if (type === 'Medical Treatment')
    return <Badge className="bg-blue-100 text-blue-700 border-none gap-1"><Stethoscope className="w-3 h-3" />{type}</Badge>;
  return <Badge className="bg-green-100 text-green-700 border-none gap-1"><HeartPulse className="w-3 h-3" />{type}</Badge>;
}

// ── GENERATE SEQUENTIAL ID ──────────────────────────────────────────────────
function genHealthId(records: any[]) {
  const nums = records
    .map(r => parseInt((r.id || '').replace(/^HLT0*/, '') || '0'))
    .filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `HLT${String(next).padStart(3, '0')}`;
}

export function Health() {
  const { children } = useData();
  const { user } = useAuth();

  const [health, setHealth] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterResident, setFilterResident] = useState('all');
  const [activeTab, setActiveTab] = useState('all');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [viewRecord, setViewRecord] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [isSaving, setIsSaving] = useState(false);

  const loadRecords = useCallback(async () => {
    try {
      const store = await getStore();
      setHealth(Array.isArray(store.healthRecords) ? store.healthRecords : []);
    } catch {
      setHealth([]);
    }
  }, []);

  useEffect(() => { loadRecords(); }, [loadRecords]);

  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  const resetForm = () => { setForm({ ...EMPTY_FORM }); setEditingId(null); setIsFormOpen(false); };

  const openEdit = (r: any) => {
    setForm({
      residentId: r.residentId || '',
      residentName: r.residentName || '',
      recordType: r.recordType || 'Health Assessment',
      date: r.date || new Date().toISOString().split('T')[0],
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
    setEditingId(r.id);
    setIsFormOpen(true);
  };

  const validateForm = () => {
    if (!form.residentId) return 'Please select a resident.';
    if (form.recordType === 'Health Assessment' && (!form.assessmentType || !form.findings)) return 'Assessment type and findings are required.';
    if (form.recordType === 'Medication Log' && (!form.medicationName || !form.dosage || !form.frequency)) return 'Medication name, dosage, and frequency are required.';
    if (form.recordType === 'Medical Treatment' && (!form.treatmentType || !form.procedure_)) return 'Treatment type and procedure are required.';
    return null;
  };

  const handleSave = async () => {
    const err = validateForm();
    if (err) { alert(err); return; }
    setIsSaving(true);
    const entry = {
      ...form,
      id: editingId || genHealthId(health),
      status: 'Completed',
      recordedBy: user?.username || 'Staff',
    };
    try {
      if (editingId) {
        await request(`/healthRecords/${editingId}`, { method: 'PUT', body: JSON.stringify(entry) });
        setHealth(prev => prev.map(r => r.id === editingId ? { ...r, ...entry } : r));
      } else {
        const saved = await createResource('healthRecords', entry);
        setHealth(prev => [saved, ...prev]);
      }
    } catch {
      if (!editingId) setHealth(prev => [entry, ...prev]);
      else setHealth(prev => prev.map(r => r.id === editingId ? { ...r, ...entry } : r));
    }
    setIsSaving(false);
    resetForm();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try { await deleteResource('healthRecords', deleteTarget.id); } catch { /* local remove */ }
    setHealth(prev => prev.filter(r => r.id !== deleteTarget.id));
    setDeleteTarget(null);
  };

  const filtered = useMemo(() => health.filter(r => {
    const matchSearch = (r.residentName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (r.id || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchResident = filterResident === 'all' || r.residentId === filterResident;
    const matchTab = activeTab === 'all' || r.recordType === activeTab;
    return matchSearch && matchResident && matchTab;
  }), [health, searchTerm, filterResident, activeTab]);

  const tabCounts = useMemo(() => ({
    all: health.length,
    'Health Assessment': health.filter(r => r.recordType === 'Health Assessment').length,
    'Medication Log': health.filter(r => r.recordType === 'Medication Log').length,
    'Medical Treatment': health.filter(r => r.recordType === 'Medical Treatment').length,
  }), [health]);

  // Per-resident summary for the selected resident filter
  const residentSummary = useMemo(() => {
    if (filterResident === 'all') return null;
    const recs = health.filter(r => r.residentId === filterResident);
    const lastCheckup = recs.find(r => r.recordType === 'Health Assessment');
    const activeMeds = recs.filter(r => r.recordType === 'Medication Log');
    const conditions = recs.filter(r => r.conditions && r.conditions !== 'None').map(r => r.conditions);
    const allergies = recs.filter(r => r.allergies && r.allergies !== 'None').map(r => r.allergies);
    return { lastCheckup, activeMeds, conditions: [...new Set(conditions)], allergies: [...new Set(allergies)] };
  }, [health, filterResident]);

  return (
    <div className="space-y-5 p-2">
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-[#2F3E46]">Health & Medical Records</h2>
          <p className="text-sm text-gray-500">Log health assessments, treatments, and medications</p>
        </div>
        <Button
          style={{ backgroundColor: '#FFD100', color: '#2F3E46' }}
          className="font-bold hover:opacity-90 gap-2"
          onClick={() => { resetForm(); setIsFormOpen(true); }}
        >
          <Plus className="w-4 h-4" /> Log Health Record
        </Button>
      </div>

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
                        <Button variant="outline" size="sm" className="gap-1.5 text-[#2F3E46] border-[#2F3E46]/30" onClick={() => openEdit(record)}>
                          <Edit className="w-3.5 h-3.5" /> Edit
                        </Button>
                        <Button variant="outline" size="sm" className="gap-1.5 text-red-600 border-red-200 hover:border-red-400" onClick={() => setDeleteTarget(record)}>
                          <Trash2 className="w-3.5 h-3.5" /> Delete
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>
        ))}
      </Tabs>

      {/* ADD / EDIT DIALOG */}
      <Dialog open={isFormOpen} onOpenChange={open => { if (!open) resetForm(); }}>
        <DialogContent className="max-w-2xl bg-white rounded-2xl p-0 overflow-hidden">
          <DialogHeader className="p-6 border-b bg-gray-50/60">
            <DialogTitle className="text-[#2F3E46] font-bold text-lg">
              {editingId ? 'Edit Health Record' : 'New Health Record'}
            </DialogTitle>
          </DialogHeader>
          <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
            {/* Resident + Type + Date */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="font-semibold text-[#2F3E46]">Resident *</Label>
                <Select value={form.residentId} onValueChange={v => { const c = children.find(x => x.id === v); set('residentId', v); set('residentName', c?.name || ''); }}>
                  <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select resident..." /></SelectTrigger>
                  <SelectContent>{children.map(c => <SelectItem key={c.id} value={c.id}>{c.name} ({c.id})</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-semibold text-[#2F3E46]">Record Type *</Label>
                <Select value={form.recordType} onValueChange={v => set('recordType', v)}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Health Assessment">Health Assessment</SelectItem>
                    <SelectItem value="Medication Log">Medication Log</SelectItem>
                    <SelectItem value="Medical Treatment">Medical Treatment</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-semibold text-[#2F3E46]">Date *</Label>
                <Input type="date" value={form.date} onChange={e => set('date', e.target.value)} className="rounded-xl" />
              </div>
            </div>

            {/* Health Assessment fields */}
            {form.recordType === 'Health Assessment' && (
              <div className="space-y-4 border rounded-xl p-4 bg-green-50/40">
                <p className="text-xs font-bold text-green-700 uppercase tracking-wider">Assessment Details</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="font-semibold text-[#2F3E46]">Assessment Type *</Label>
                    <Input value={form.assessmentType} onChange={e => set('assessmentType', e.target.value)} placeholder="e.g. Physical Examination" className="rounded-xl" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="font-semibold text-[#2F3E46]">Allergies</Label>
                    <Select value={form.allergies} onValueChange={v => set('allergies', v)}>
                      <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                      <SelectContent>{ALLERGIES.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label className="font-semibold text-[#2F3E46]">Medical Conditions</Label>
                    <Select value={form.conditions} onValueChange={v => set('conditions', v)}>
                      <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                      <SelectContent>{CONDITIONS.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="font-semibold text-[#2F3E46]">Findings / Notes *</Label>
                  <Textarea value={form.findings} onChange={e => set('findings', e.target.value)} placeholder="Describe findings and observations..." className="rounded-xl min-h-[90px]" />
                </div>
              </div>
            )}

            {/* Medication Log fields */}
            {form.recordType === 'Medication Log' && (
              <div className="space-y-4 border rounded-xl p-4 bg-purple-50/40">
                <p className="text-xs font-bold text-purple-700 uppercase tracking-wider">Medication Details</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="font-semibold text-[#2F3E46]">Medication Name *</Label>
                    <Input value={form.medicationName} onChange={e => set('medicationName', e.target.value)} placeholder="e.g. Amoxicillin" className="rounded-xl" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="font-semibold text-[#2F3E46]">Dosage *</Label>
                    <Input value={form.dosage} onChange={e => set('dosage', e.target.value)} placeholder="e.g. 500mg" className="rounded-xl" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="font-semibold text-[#2F3E46]">Frequency *</Label>
                    <Select value={form.frequency} onValueChange={v => set('frequency', v)}>
                      <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select frequency..." /></SelectTrigger>
                      <SelectContent>{FREQUENCIES.map(f => <SelectItem key={f} value={f}>{f}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="font-semibold text-[#2F3E46]">Duration</Label>
                    <Input value={form.duration} onChange={e => set('duration', e.target.value)} placeholder="e.g. 7 days" className="rounded-xl" />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label className="font-semibold text-[#2F3E46]">Prescribed By</Label>
                    <Input value={form.prescribedBy} onChange={e => set('prescribedBy', e.target.value)} placeholder="Doctor or prescribing staff name" className="rounded-xl" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="font-semibold text-[#2F3E46]">Notes</Label>
                  <Textarea value={form.findings} onChange={e => set('findings', e.target.value)} placeholder="Additional notes (side effects, instructions)..." className="rounded-xl min-h-[70px]" />
                </div>
              </div>
            )}

            {/* Medical Treatment fields */}
            {form.recordType === 'Medical Treatment' && (
              <div className="space-y-4 border rounded-xl p-4 bg-blue-50/40">
                <p className="text-xs font-bold text-blue-700 uppercase tracking-wider">Treatment Details</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="font-semibold text-[#2F3E46]">Treatment Type *</Label>
                    <Input value={form.treatmentType} onChange={e => set('treatmentType', e.target.value)} placeholder="e.g. Wound Care, IV Therapy" className="rounded-xl" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="font-semibold text-[#2F3E46]">Follow-up Date</Label>
                    <Input type="date" value={form.followUpDate} onChange={e => set('followUpDate', e.target.value)} className="rounded-xl" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="font-semibold text-[#2F3E46]">Procedure / Description *</Label>
                  <Textarea value={form.procedure_} onChange={e => set('procedure_', e.target.value)} placeholder="Describe the treatment procedure performed..." className="rounded-xl min-h-[90px]" />
                </div>
                <div className="space-y-1.5">
                  <Label className="font-semibold text-[#2F3E46]">Outcome</Label>
                  <Textarea value={form.outcome} onChange={e => set('outcome', e.target.value)} placeholder="Describe the treatment outcome..." className="rounded-xl min-h-[70px]" />
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="bg-gray-50 px-6 py-4 border-t gap-2">
            <Button variant="ghost" onClick={resetForm}>Cancel</Button>
            <Button
              disabled={isSaving}
              onClick={handleSave}
              style={{ backgroundColor: '#FFD100', color: '#2F3E46' }}
              className="font-bold rounded-xl px-8 hover:opacity-90"
            >
              {isSaving ? 'Saving...' : editingId ? 'Update Record' : 'Save Record'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* VIEW DIALOG */}
      <Dialog open={!!viewRecord} onOpenChange={open => { if (!open) setViewRecord(null); }}>
        <DialogContent className="max-w-lg bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46] font-bold flex items-center gap-2">
              {viewRecord && <RecordTypeBadge type={viewRecord.recordType} />}
            </DialogTitle>
          </DialogHeader>
          {viewRecord && (
            <div className="space-y-4 py-2 text-sm">
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