import React from 'react';
import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Card, CardContent } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Badge } from '@/app/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Search, Plus, Eye, Edit, Trash2, Clock3, AlertCircle, User, Calendar, History, UserCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/app/components/ui/alert-dialog';
import { useData } from '../state/DataContext';
import { formatPHDate } from '@/utils/dateFormatter';

type Gender = 'Male' | 'Female';

interface ChildFormState {
  firstName: string;
  middleName: string;
  lastName: string;
  name: string;
  age: string;
  gender: Gender | '';
  admissionDate: string;
  birthDate: string;
  address: string;
  legalCategory: string;
  caseType: string;
  isRepeatOffender: boolean;
  previousCaseDetails: string;
  guardianName: string;
  guardianContact: string;
}

const EMPTY_FORM: ChildFormState = {
  firstName: '',
  middleName: '',
  lastName: '',
  name: '',
  age: '',
  gender: 'Male',
  admissionDate: '',
  birthDate: '',
  address: '',
  legalCategory: '',
  caseType: '',
  isRepeatOffender: false,
  previousCaseDetails: '',
  guardianName: '',
  guardianContact: '09',
};

export function ChildRecords() {
  const navigate = useNavigate();
  const location = useLocation();
  const { children, addChild, updateChild, deleteChild, readmitChild, refreshData } = useData();

  const [searchTerm, setSearchTerm] = useState('');
  const [nameSuggestions, setNameSuggestions] = useState<typeof children>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [duplicateChild, setDuplicateChild] = useState<typeof children[0] | null>(null);
  const [isDuplicatePopupOpen, setIsDuplicatePopupOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'All' | 'Active' | 'Discharged'>(() => {
    const params = new URLSearchParams(window.location.search);
    const f = params.get('filter');
    if (f === 'Discharged') return 'Discharged';
    if (f === 'All') return 'All';
    return 'Active';
  });

  // Sync filter when URL changes (e.g. navigated from dashboard)
  React.useEffect(() => {
    const params = new URLSearchParams(location.search);
    const f = params.get('filter');
    if (f === 'Discharged') setStatusFilter('Discharged');
    else if (f === 'All') setStatusFilter('All');
    else if (f === 'Active') setStatusFilter('Active');
  }, [location.search]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [childToDelete, setChildToDelete] = useState<string | null>(null);
  const [form, setForm] = useState<ChildFormState>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const todayYYYYMMDD = () => new Date().toISOString().split('T')[0];

  const resetForm = () => {
    setForm({ ...EMPTY_FORM, admissionDate: todayYYYYMMDD(), gender: 'Male', guardianContact: '09' });
    setFormErrors({});
    setEditingId(null);
    setDuplicateChild(null);
  };

  const clearDuplicateLink = () => {
    setDuplicateChild(null);
    setForm(prev => ({ ...prev, isRepeatOffender: false, previousCaseDetails: '' }));
  };

  const normalizeContact = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 11);
    if (!digits) return '09';
    const withoutPrefix = digits.replace(/^0+/, '');
    const prefixed = withoutPrefix.startsWith('9') ? `09${withoutPrefix.slice(1)}` : `09${withoutPrefix}`;
    return prefixed.slice(0, 11);
  };

  const validateForm = () => {
    const nextErrors: Record<string, string> = {};
    const trimmedName = form.name.trim();
    if (!trimmedName) nextErrors.name = 'Full name is required.';
    if (!form.legalCategory) nextErrors.legalCategory = 'Please select a legal category.';
    if (!form.caseType.trim()) nextErrors.caseType = 'Specific offense is required.';
    if (!form.admissionDate) nextErrors.admissionDate = 'Admission date is required.';

    const phone = form.guardianContact || '09';
    if (phone.length < 2 || !phone.startsWith('09') || phone.length !== 11) {
      nextErrors.guardianContact = 'Guardian contact number must start with 09 and have 11 digits total.';
    }

    setFormErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const openAdd = () => {
    resetForm();
    setIsFormOpen(true);
  };

  // Auto-calculate age from birthDate
  const calcAge = (birthDate: string): string => {
    if (!birthDate) return '';
    const today = new Date();
    const birth = new Date(birthDate);
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age >= 0 ? age.toString() : '';
  };

  // Handle name input with predictive search
  const handleNameChange = (value: string) => {
    const normalized = value.replace(/\s+/g, ' ').trimStart();
    setForm(prev => ({ ...prev, name: normalized }));
    setFormErrors(prev => ({ ...prev, name: undefined }));
    if (duplicateChild && normalized.trim().toLowerCase() !== duplicateChild.name.trim().toLowerCase()) {
      clearDuplicateLink();
    }
    if (normalized.length >= 2) {
      const matches = children.filter(c =>
        c.name.toLowerCase().includes(normalized.toLowerCase()) &&
        (!editingId || c.id !== editingId)
      );
      setNameSuggestions(matches);
      setShowSuggestions(matches.length > 0);
    } else {
      setNameSuggestions([]);
      setShowSuggestions(false);
    }
  };

  // When user selects a suggestion — auto-fill form directly, no popup
  const handleSelectSuggestion = (matched: typeof children[0]) => {
    setShowSuggestions(false);
    setDuplicateChild(matched);

    const nameParts = (matched.name || '').split(' ');
    const rawBD = matched.birthDate || '';
    const formattedBD = rawBD.includes('T') ? rawBD.split('T')[0] : rawBD;
    const autoAge = formattedBD ? calcAge(formattedBD) : (matched.age?.toString() || '');
    const previousStay = matched.previousCaseDetails || `Previous stay: ${matched.caseType || 'Unknown case'} · ${matched.admissionDate || '—'} · ${matched.legalCategory || 'N/A'} · ID: ${matched.id}`;

    setForm(prev => ({
      ...prev,
      firstName: nameParts[0] || '',
      middleName: nameParts.length > 2 ? nameParts.slice(1, -1).join(' ') : '',
      lastName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : '',
      name: matched.name,
      age: autoAge,
      gender: matched.gender || 'Male',
      birthDate: formattedBD,
      admissionDate: todayYYYYMMDD(),
      address: matched.address || '',
      guardianName: matched.guardianName || '',
      guardianContact: normalizeContact(matched.guardianContact || '09'),
      caseType: '',
      legalCategory: '',
      isRepeatOffender: true,
      previousCaseDetails: previousStay,
    }));
  };

  // "Add Person" — proceed and flag as returning resident
  const [isReadmitting, setIsReadmitting] = useState(false);

  const handleAddReturning = async () => {
    if (!duplicateChild) return;

    if (duplicateChild.status === 'Discharged') {
      setIsReadmitting(true);
      const today = new Date().toISOString().split('T')[0];
      try {
        // Store previous case info before resetting
        const prevCaseDetails = `Previous: ${duplicateChild.caseType} (${duplicateChild.admissionDate}) — ID: ${duplicateChild.id}`;

        const reAdmDate = form.admissionDate || today;

        // Build structured previous cases array preserving full history
        const existingPrevCases: any[] = Array.isArray((duplicateChild as any).previousCases)
          ? (duplicateChild as any).previousCases
          : [];
        const offenseNum = existingPrevCases.length + 1;
        const offenseSuffix = offenseNum === 1 ? 'st' : offenseNum === 2 ? 'nd' : offenseNum === 3 ? 'rd' : 'th';
        const newPrevCase = {
          offense: offenseNum + offenseSuffix + ' Offense',
          caseType: duplicateChild.caseType,
          legalCategory: duplicateChild.legalCategory,
          admissionDate: duplicateChild.admissionDate,
          closedDate: today,
          phaseReached: duplicateChild.casePhase,
        };
        const allPrevCases = [...existingPrevCases, newPrevCase];

        // Step 1: Call backend readmit — archives old phase, creates fresh Admission Phase
        try {
          await readmitChild(duplicateChild.id, {
            newAdmissionDate: reAdmDate,
            newCaseType: form.caseType || duplicateChild.caseType,
            newLegalCategory: form.legalCategory || duplicateChild.legalCategory,
          });
        } catch { /* proceed with updateChild fallback */ }

        // Step 2: updateChild — reset phase/tasks, preserve full case history
        await updateChild(duplicateChild.id, {
          status: 'Active',
          casePhase: 'Admission Phase',
          isRepeatOffender: true,
          admissionDate: reAdmDate,
          readmissionDate: reAdmDate,
          readmissionDatetime: new Date().toISOString() as any,
          caseType: form.caseType || duplicateChild.caseType,
          legalCategory: form.legalCategory || duplicateChild.legalCategory,
          previousCaseDetails: prevCaseDetails,
          previousCases: allPrevCases as any,
          phaseTasksCompleted: {} as any,
          documentsComplete: false,
        } as any);

        // Step 3: Force full DataContext refresh so all components see fresh state
        try { refreshData && await refreshData(); } catch { /* silent */ }

        setIsReadmitting(false);
        setIsDuplicatePopupOpen(false);
        setDuplicateChild(null);
        setIsFormOpen(false);
        resetForm();
        navigate(`/children/${duplicateChild.id}`);
      } catch (err) {
        setIsReadmitting(false);
        alert('Failed to re-admit: ' + (err instanceof Error ? err.message : 'Unknown error'));
      }
      return;
    }

    // If child is still active, pre-fill form but create as new record (existing behavior)
    setForm(prev => ({
      ...prev,
      name: duplicateChild.name,
      age: duplicateChild.age.toString(),
      gender: duplicateChild.gender || 'Male',
      birthDate: duplicateChild.birthDate || prev.birthDate,
      address: duplicateChild.address || prev.address,
      guardianName: duplicateChild.guardianName || prev.guardianName,
      guardianContact: duplicateChild.guardianContact || prev.guardianContact,
      legalCategory: duplicateChild.legalCategory || prev.legalCategory,
      caseType: duplicateChild.caseType || prev.caseType,
      isRepeatOffender: true,
      previousCaseDetails: `Previous case: ${duplicateChild.caseType} (${duplicateChild.admissionDate}) — ID: ${duplicateChild.id}`,
    }));
    setIsDuplicatePopupOpen(false);
    setDuplicateChild(null);
  };

  const openEdit = (childId: string) => {
    const child = children.find((c) => c.id === childId);
    if (!child) return;
    const nameParts = (child.name || '').split(' ');
    setForm({
      firstName: nameParts[0] || '',
      middleName: nameParts.length > 2 ? nameParts.slice(1, -1).join(' ') : '',
      lastName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : '',
      name: child.name,
      age: child.age.toString(),
      gender: child.gender,
      admissionDate: child.admissionDate,
      birthDate: child.birthDate || '',
      address: child.address || '',
      legalCategory: child.legalCategory,
      caseType: child.caseType,
      isRepeatOffender: child.isRepeatOffender,
      previousCaseDetails: child.previousCaseDetails || '',
      guardianName: child.guardianName || '',
      guardianContact: child.guardianContact || '',
    });
    setEditingId(childId);
    setIsFormOpen(true);
  };

  const handleSave = async () => {
    if (!validateForm()) return;

    const normalizedName = form.name.trim().replace(/\s+/g, ' ');
    const normalizedExistingName = duplicateChild?.name?.trim().replace(/\s+/g, ' ');
    const isUsingExistingResident = !!duplicateChild && form.isRepeatOffender && normalizedExistingName?.toLowerCase() === normalizedName.toLowerCase();

    const cleanedPhone = form.guardianContact.replace(/\D/g, '');
    const normalizedPhone = cleanedPhone.startsWith('09') ? cleanedPhone : cleanedPhone.startsWith('9') ? `0${cleanedPhone}` : cleanedPhone;
    const existing = editingId ? children.find((c) => c.id === editingId) : null;

    const childData = {
      name: normalizedName,
      age: parseInt(form.age) || 0,
      gender: 'Male' as Gender,
      admissionDate: form.admissionDate || todayYYYYMMDD(),
      birthDate: form.birthDate || undefined,
      address: form.address.trim() || undefined,
      legalCategory: form.legalCategory,
      caseType: form.caseType.trim(),
      isRepeatOffender: form.isRepeatOffender || !!duplicateChild,
      previousCaseDetails: form.isRepeatOffender || !!duplicateChild ? form.previousCaseDetails || `Previous stay: ${duplicateChild?.caseType || 'Unknown'} · ${duplicateChild?.admissionDate || '—'} · ID: ${duplicateChild?.id || '—'}` : '',
      status: existing?.status ?? ('Active' as const),
      casePhase: existing?.casePhase ?? 'Admission Phase',
      documentsComplete: existing?.documentsComplete ?? false,
      guardianName: form.guardianName.trim() || undefined,
      guardianContact: normalizedPhone || undefined,
    };

    try {
      if (editingId) {
        updateChild(editingId, childData);
      } else if (isUsingExistingResident && duplicateChild) {
        const priorCases: any[] = Array.isArray((duplicateChild as any).previousCases)
          ? (duplicateChild as any).previousCases
          : [];
        const offenseCount = priorCases.length + 1;
        const suffix = offenseCount === 1 ? 'st' : offenseCount === 2 ? 'nd' : offenseCount === 3 ? 'rd' : 'th';

        await updateChild(duplicateChild.id, {
          ...childData,
          previousCases: [...priorCases, {
            offense: `${offenseCount}${suffix} Offense`,
            caseType: form.caseType.trim(),
            legalCategory: form.legalCategory,
            admissionDate: form.admissionDate,
            closedDate: null,
            phaseReached: 'Admission Phase',
          }],
          previousCaseDetails: form.previousCaseDetails || `Previous stay: ${duplicateChild.caseType || 'Unknown case'} · ${duplicateChild.admissionDate || '—'} · ${duplicateChild.legalCategory || 'N/A'} · ID: ${duplicateChild.id}`,
          status: duplicateChild.status === 'Discharged' ? 'Active' : duplicateChild.status,
        } as any);
        setIsFormOpen(false);
        resetForm();
        navigate(`/children/${duplicateChild.id}`);
        return;
      } else {
        const created = await addChild(childData);
        if (created) {
          setIsFormOpen(false);
          resetForm();
          navigate(`/children/${created.id}`);
          return;
        }
      }
      setIsFormOpen(false);
      resetForm();
    } catch (err) {
      console.error('Error saving child record:', err);
      alert('Failed to save record. Please check the data.');
    }
  };

  const handleDelete = (childId: string) => {
    setChildToDelete(childId);
  };

  const filteredChildren = children.filter((child) => {
    const matchesSearch =
      (child.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      child.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus =
      statusFilter === 'All' ||
      (statusFilter === 'Active' && child.status !== 'Discharged') ||
      (statusFilter === 'Discharged' && child.status === 'Discharged');
    return matchesSearch && matchesStatus;
  });

  const activeCount = children.filter(c => c.status !== 'Discharged').length;
  const dischargedCount = children.filter(c => c.status === 'Discharged').length;

  return (
    <div className="space-y-6 p-4">
      {/* HEADER */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-[#2F3E46]">Child Records</h2>
          <p className="text-sm text-gray-500">Manage CICL beneficiaries</p>
        </div>
        <Button
          style={{ backgroundColor: '#FFD100', color: '#2F3E46' }}
          className="hover:opacity-90 font-bold shadow-sm rounded-lg"
          onClick={openAdd}
        >
          <Plus className="w-4 h-4 mr-2" /> Add Child
        </Button>
      </div>

      {/* FORM SECTION */}
      {isFormOpen && (
        <Card className="border-2 shadow-lg" style={{ borderColor: '#2F3E46' }}>
          <CardContent className="p-6">
            <div className="flex items-center gap-2 mb-6 text-[#2F3E46]">
              <Edit className="w-5 h-5 text-[#FFD100]" />
              <h3 className="text-lg font-bold">
                {editingId ? 'Edit Child Record' : 'New Child Record'}
              </h3>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {/* Name Fields: First / Middle / Last */}
              <div className="md:col-span-2 space-y-2">
                <Label className="font-bold text-[#2F3E46]">Full Name *</Label>
                <div className="grid grid-cols-3 gap-2">
                  <div className="relative">
                    <Input
                      value={form.firstName}
                      onChange={(e) => {
                        const v = e.target.value;
                        const full = [v, form.middleName, form.lastName].filter(Boolean).join(' ');
                        setForm(prev => ({ ...prev, firstName: v, name: full }));
                        setFormErrors(prev => ({ ...prev, name: undefined }));
                        if (duplicateChild && full.trim().toLowerCase() !== duplicateChild.name.trim().toLowerCase()) {
                          clearDuplicateLink();
                        }
                        if (v.trim().length >= 2) {
                          const matches = children.filter(c =>
                            c.name.toLowerCase().includes(v.toLowerCase()) &&
                            (!editingId || c.id !== editingId)
                          );
                          setNameSuggestions(matches);
                          setShowSuggestions(matches.length > 0);
                        } else {
                          setShowSuggestions(false);
                        }
                      }}
                      onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                      placeholder="First Name"
                      className="rounded-xl"
                      autoComplete="off"
                    />
                  </div>
                  <Input
                    value={form.middleName}
                    onChange={(e) => {
                      const v = e.target.value;
                      const full = [form.firstName, v, form.lastName].filter(Boolean).join(' ');
                      setForm(prev => ({ ...prev, middleName: v, name: full }));
                      if (duplicateChild && full.trim().toLowerCase() !== duplicateChild.name.trim().toLowerCase()) {
                        clearDuplicateLink();
                      }
                    }}
                    placeholder="Middle Name"
                    className="rounded-xl"
                  />
                  <Input
                    value={form.lastName}
                    onChange={(e) => {
                      const v = e.target.value;
                      const full = [form.firstName, form.middleName, v].filter(Boolean).join(' ');
                      setForm(prev => ({ ...prev, lastName: v, name: full }));
                      setFormErrors(prev => ({ ...prev, name: undefined }));
                      if (duplicateChild && full.trim().toLowerCase() !== duplicateChild.name.trim().toLowerCase()) {
                        clearDuplicateLink();
                      }
                    }}
                    placeholder="Last Name"
                    className="rounded-xl"
                  />
                </div>
                {showSuggestions && (
                  <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-xl shadow-lg mt-1 max-h-52 overflow-y-auto">
                    <p className="text-[10px] text-gray-400 px-3 pt-2 pb-1 uppercase font-bold tracking-wider">Existing Records Found</p>
                    {nameSuggestions.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onMouseDown={() => handleSelectSuggestion(c)}
                        className="w-full text-left px-3 py-2.5 hover:bg-gray-50 flex items-center gap-3 border-t border-gray-50"
                      >
                        <div className="p-1.5 bg-orange-100 rounded-lg">
                          <History className="w-3.5 h-3.5 text-orange-500" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold text-gray-800">{c.name}</p>
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${c.status === 'Discharged' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}>
                              {c.status === 'Discharged' ? 'Closed' : 'Active'}
                            </span>
                          </div>
                          <p className="text-xs text-gray-400">{c.id} · {c.caseType} · Admitted {c.admissionDate}</p>
                        </div>
                        <span className="text-[10px] text-orange-500 font-semibold shrink-0">Click to auto-fill →</span>
                      </button>
                    ))}
                  </div>
                )}
                {duplicateChild && (
                  <div className="mt-2 rounded-xl border border-orange-200 bg-orange-50 p-3 text-xs text-orange-900">
                    <p className="font-bold text-orange-700 uppercase tracking-wide">Previous shelter record found</p>
                    <p className="mt-1">This resident already has a previous stay under ID <span className="font-bold">{duplicateChild.id}</span>.</p>
                    <p className="mt-1">Previous case: <span className="font-semibold">{duplicateChild.caseType || 'Unknown case'}</span> · Admitted: <span className="font-semibold">{duplicateChild.admissionDate || '—'}</span> · Legal category: <span className="font-semibold">{duplicateChild.legalCategory || 'N/A'}</span></p>
                    <p className="mt-1">Status: <span className="font-semibold">{duplicateChild.status === 'Discharged' ? 'Closed / previous stay' : 'Active / previous stay'}</span></p>
                  </div>
                )}
                {formErrors.name && <p className="text-xs text-red-600 mt-1">{formErrors.name}</p>}
              </div>

              {/* Birth Date — auto-calculates age */}
              <div className="space-y-2">
                <Label className="font-bold text-[#2F3E46]">Birth Date</Label>
                <Input
                  type="date"
                  value={form.birthDate}
                  onChange={(e) => {
                    const bd = e.target.value;
                    const autoAge = calcAge(bd);
                    setForm(prev => ({ ...prev, birthDate: bd, age: autoAge || prev.age }));
                  }}
                  max={todayYYYYMMDD()}
                  className="rounded-xl"
                />
              </div>

              {/* Admission Date */}
              <div className="space-y-2">
                <Label className="font-bold text-[#2F3E46]">Admission Date *</Label>
                <Input
                  type="date"
                  value={form.admissionDate}
                  onChange={(e) => {
                    setForm({ ...form, admissionDate: e.target.value });
                    setFormErrors(prev => ({ ...prev, admissionDate: undefined }));
                  }}
                  className="rounded-xl"
                />
                {formErrors.admissionDate && <p className="text-xs text-red-600">{formErrors.admissionDate}</p>}
              </div>

              {/* Legal Category */}
              <div className="space-y-2">
                <Label className="font-bold text-[#2F3E46]">Legal Category *</Label>
                <Select
                  value={form.legalCategory || undefined}
                  onValueChange={(val) => {
                    setForm({ ...form, legalCategory: val });
                    setFormErrors(prev => ({ ...prev, legalCategory: undefined }));
                  }}
                >
                  <SelectTrigger className="rounded-xl">
                    <SelectValue placeholder="Select Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Diversion Plan">Diversion Plan</SelectItem>
                    <SelectItem value="Court Diversion">Court Diversion</SelectItem>
                  </SelectContent>
                </Select>
                {formErrors.legalCategory && <p className="text-xs text-red-600">{formErrors.legalCategory}</p>}
              </div>

              {/* Specific Offense */}
              <div className="space-y-2">
                <Label className="font-bold text-[#2F3E46]">Specific Offense *</Label>
                <Input
                  value={form.caseType}
                  onChange={(e) => {
                    setForm({ ...form, caseType: e.target.value });
                    setFormErrors(prev => ({ ...prev, caseType: undefined }));
                  }}
                  placeholder="e.g. Theft"
                  className="rounded-xl"
                />
                {formErrors.caseType && <p className="text-xs text-red-600">{formErrors.caseType}</p>}
              </div>

              {/* Address — spans full width */}
              <div className="md:col-span-2 space-y-2">
                <Label className="font-bold text-[#2F3E46]">Home Address</Label>
                <Input
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="e.g. Brgy. San Jose, Caloocan City"
                  className="rounded-xl"
                />
              </div>

              {/* Guardian Name */}
              <div className="space-y-2">
                <Label className="font-bold text-[#2F3E46]">Guardian Name</Label>
                <Input
                  value={form.guardianName}
                  onChange={(e) => setForm({ ...form, guardianName: e.target.value })}
                  placeholder="e.g. Maria Dela Cruz"
                  className="rounded-xl"
                />
              </div>

              {/* Guardian Contact */}
              <div className="space-y-2">
                <Label className="font-bold text-[#2F3E46]">Guardian Contact Number</Label>
                <Input
                  value={form.guardianContact || '09'}
                  onChange={(e) => {
                    const nextValue = e.target.value;
                    const digits = nextValue.replace(/\D/g, '').slice(0, 11);
                    const normalized = digits ? normalizeContact(digits) : '09';
                    setForm({ ...form, guardianContact: normalized });
                    setFormErrors(prev => ({ ...prev, guardianContact: undefined }));
                  }}
                  onKeyDown={(e) => {
                    if ((e.key === 'Backspace' || e.key === 'Delete') && (form.guardianContact.length <= 2)) {
                      e.preventDefault();
                    }
                  }}
                  placeholder="09XX-XXX-XXXX"
                  className="rounded-xl"
                />
                {formErrors.guardianContact && <p className="text-xs text-red-600">{formErrors.guardianContact}</p>}
              </div>

              {/* Offender Type */}
              <div className="md:col-span-2 space-y-2">
                <Label className="font-bold text-[#2F3E46]">Case History *</Label>
                <div className="flex gap-3">
                  {[
                    { value: false, label: 'First-Time Offender', desc: 'No previous shelter admission', color: 'border-green-400 bg-green-50 text-green-700', disabled: false },
                    { value: true,  label: 'Repeat Offender',     desc: 'Previously admitted to shelter', color: 'border-orange-400 bg-orange-50 text-orange-700', disabled: false },
                  ].map(opt => (
                    <button
                      key={String(opt.value)}
                      type="button"
                      disabled={opt.disabled}
                      onClick={() => {
                        if (!opt.value && duplicateChild) {
                          clearDuplicateLink();
                        }
                        setForm({ ...form, isRepeatOffender: opt.value });
                      }}
                      className={`flex-1 p-3 rounded-xl border-2 text-left transition-all ${
                        form.isRepeatOffender === opt.value
                          ? opt.color + ' border-opacity-100'
                          : opt.disabled
                          ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed opacity-60'
                          : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                      }`}
                    >
                      <p className="font-bold text-sm">{opt.label}</p>
                      <p className="text-xs mt-0.5 opacity-70">{opt.desc}</p>
                    </button>
                  ))}
                </div>

                {/* Previous case history from matched child */}
                {form.isRepeatOffender && duplicateChild && (
                  <div className="mt-2 p-3 rounded-xl border border-blue-200 bg-blue-50 space-y-2">
                    <p className="text-xs font-bold text-blue-700 uppercase tracking-wide flex items-center gap-1">
                      📋 Case History — {duplicateChild.name}
                    </p>
                    {(() => {
                      const prevCases: any[] = Array.isArray((duplicateChild as any).previousCases)
                        ? (duplicateChild as any).previousCases
                        : [];
                      const allCases = [
                        ...prevCases,
                        {
                          offense: (prevCases.length + 1) + (prevCases.length === 0 ? 'st' : prevCases.length === 1 ? 'nd' : prevCases.length === 2 ? 'rd' : 'th') + ' Offense (Current)',
                          caseType: duplicateChild.caseType,
                          legalCategory: duplicateChild.legalCategory,
                          admissionDate: duplicateChild.admissionDate,
                          closedDate: duplicateChild.status === 'Discharged' ? '—' : null,
                          phaseReached: duplicateChild.casePhase,
                          isCurrent: true,
                        }
                      ];
                      return allCases.map((pc, i) => (
                        <div key={i} className={`p-2 rounded-lg border text-xs ${pc.isCurrent ? 'border-orange-300 bg-orange-50' : 'border-gray-200 bg-white'}`}>
                          <div className="flex justify-between items-center mb-1">
                            <span className="font-bold text-gray-700">{pc.offense}</span>
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${pc.closedDate && pc.closedDate !== '—' ? 'bg-green-100 text-green-700' : pc.isCurrent && duplicateChild.status === 'Discharged' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                              {(pc.closedDate && pc.closedDate !== '—') || (pc.isCurrent && duplicateChild.status === 'Discharged') ? 'Closed' : 'Active'}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-gray-600">
                            <span><strong>Offense:</strong> {pc.caseType}</span>
                            <span><strong>Phase:</strong> {pc.phaseReached}</span>
                            <span><strong>Admitted:</strong> {pc.admissionDate ? new Date(pc.admissionDate).toLocaleDateString('en-PH', {year:'numeric',month:'short',day:'numeric'}) : '—'}</span>
                            <span><strong>Case Closed:</strong> {
                              pc.closedDate && pc.closedDate !== '—'
                                ? new Date(pc.closedDate).toLocaleDateString('en-PH', {year:'numeric',month:'long',day:'numeric'})
                                : pc.isCurrent && duplicateChild.status === 'Discharged'
                                ? 'Discharged'
                                : <span className="text-orange-600 font-semibold">Still Active</span>
                            }</span>
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                )}

                {/* Show previous case details when Repeat Offender is selected */}
                {form.isRepeatOffender && !duplicateChild && form.previousCaseDetails && (
                  <div className="mt-2 p-3 rounded-xl border border-orange-200 bg-orange-50 space-y-2">
                    <p className="text-xs font-bold text-orange-700 uppercase tracking-wide">Previous Case Record</p>
                    <div className="text-xs text-orange-800 space-y-1">
                      <p>{form.previousCaseDetails}</p>
                      {(() => {
                        const prev = children.find(c =>
                          form.previousCaseDetails?.includes(c.id) ||
                          c.name === form.name
                        );
                        if (!prev) return null;
                        const admDate = prev.admissionDate
                          ? new Date(prev.admissionDate).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
                          : prev.admissionDate;
                        const closedDate = prev.status === 'Discharged'
                          ? new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
                          : null;
                        return (
                          <div className="space-y-0.5 mt-1 border-t border-orange-200 pt-1">
                            <p><span className="font-semibold">Offense:</span> {prev.caseType}</p>
                            <p><span className="font-semibold">Admitted:</span> {admDate}</p>
                            <p><span className="font-semibold">Phase reached:</span> {prev.casePhase}</p>
                            {closedDate && <p><span className="font-semibold">Case closed:</span> {closedDate}</p>}
                            <p><span className="font-semibold">Status:</span> <span className={prev.status === 'Discharged' ? 'text-green-700 font-semibold' : 'text-orange-700 font-semibold'}>{prev.status === 'Discharged' ? 'Resolved / Closed' : 'Active'}</span></p>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>


            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => { setIsFormOpen(false); resetForm(); }}
                className="rounded-xl"
              >
                Cancel
              </Button>
              <Button
                style={{ backgroundColor: '#2F3E46', color: 'white' }}
                onClick={handleSave}
                className="rounded-xl px-8 font-bold"
              >
                {editingId ? 'Update Record' : 'Save Record'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* STATUS FILTER TABS */}
      <div className="flex items-center gap-2">
        {(['All', 'Active', 'Discharged'] as const).map((status) => {
          const count = status === 'All' ? children.length : status === 'Active' ? activeCount : dischargedCount;
          const isActive = statusFilter === status;
          return (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={[
                'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border-2 transition-all',
                isActive
                  ? status === 'Discharged' ? 'bg-emerald-600 border-emerald-600 text-white'
                  : status === 'Active' ? 'bg-[#2F3E46] border-[#2F3E46] text-white'
                  : 'bg-gray-700 border-gray-700 text-white'
                  : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300',
              ].join(' ')}
            >
              {status}
              <span className={[
                'text-xs px-1.5 py-0.5 rounded-full font-bold',
                isActive ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500',
              ].join(' ')}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* SEARCH */}
      <div className="relative w-full md:w-96">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
        <Input
          className="pl-10 bg-white border-gray-200 rounded-xl"
          placeholder="Search by name or ID..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {/* LIST */}
      <div className="grid gap-4">
        {filteredChildren.length > 0 ? (
          filteredChildren.map((child) => (
            <Card
              key={child.id}
              style={{ backgroundColor: '#2F3E46' }}
              className="border-none shadow-lg overflow-hidden hover:scale-[1.005] transition-all duration-200 rounded-2xl text-white"
            >
              <CardContent className="p-0 flex flex-col md:flex-row">
                <div style={{ backgroundColor: '#FFD100' }} className="w-1.5" />
                <div className="p-6 flex-1 flex flex-col md:flex-row md:items-center justify-between gap-6">
                  {/* Info */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h3 className="text-xl font-bold tracking-tight">{child.name}</h3>
                      <Badge className="bg-white/10 text-[#FFD100] border-none text-[10px] uppercase font-bold">
                        {child.legalCategory}
                      </Badge>
                      {child.isRepeatOffender && (
                        <Badge className="bg-orange-500/20 text-orange-300 border-none text-[10px] uppercase font-bold">
                          Repeat Offender
                        </Badge>
                      )}
                      {child.status === 'Discharged' && (
                        <Badge className="bg-emerald-500/20 text-emerald-300 border-none text-[10px] uppercase font-bold">
                          Case Closed
                        </Badge>
                      )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-2 text-sm opacity-90">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <User size={14} className="text-[#FFD100]" />
                          <span>{child.age} yrs old • {child.gender}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Calendar size={14} className="text-[#FFD100]" />
                          <span>Admitted: {formatPHDate(child.admissionDate)}</span>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="border-gray-500 text-gray-400 font-normal text-xs">
                            {child.id}
                          </Badge>
                          <span className="font-medium text-[#FFD100]">{child.caseType}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs opacity-70">{child.casePhase}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 pt-4 md:pt-0 border-t md:border-t-0 md:border-l md:pl-6 border-white/10">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-white hover:bg-white/10 gap-2"
                      onClick={() => navigate(`/children/${child.id}`)}
                    >
                      <Eye size={16} className="text-[#FFD100]" /> View
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-white hover:bg-white/10 gap-2"
                      onClick={() => openEdit(child.id)}
                    >
                      <Edit size={16} className="text-[#FFD100]" /> Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-2"
                      onClick={() => handleDelete(child.id)}
                    >
                      <Trash2 size={16} /> Delete
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        ) : (
          <div className="text-center py-16 text-gray-400">
            <AlertCircle className="w-10 h-10 mx-auto mb-2 opacity-20" />
            <p>No records found matching your search.</p>
          </div>
        )}
      </div>

      {/* DELETE CONFIRM DIALOG */}
      <AlertDialog open={!!childToDelete} onOpenChange={(open) => { if (!open) setChildToDelete(null); }}>
        <AlertDialogContent className="bg-white rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[#2F3E46] font-bold">Confirm Delete</AlertDialogTitle>
            <AlertDialogDescription>
              Delete record for <strong>{children.find(c => c.id === childToDelete)?.name}</strong>? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => { if (childToDelete) deleteChild(childToDelete); setChildToDelete(null); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
