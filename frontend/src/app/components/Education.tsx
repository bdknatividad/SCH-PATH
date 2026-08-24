import { useState, useRef } from 'react';
import { Card, CardContent } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Badge } from '@/app/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/app/components/ui/tabs';
import { Label } from '@/app/components/ui/label';
import { Textarea } from '@/app/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/app/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from '@/app/components/ui/alert-dialog';
import {
  GraduationCap, Plus, Search, Upload, Eye, Edit, Trash2,
  User, FileText, BookOpen, Award, X, Download, AlertCircle,
  ChevronDown, ChevronUp, Paperclip,
} from 'lucide-react';

// ── TYPES ────────────────────────────────────────────────────────────────────

export type EducationLevel =
  | 'High School'
  | 'Senior High School'
  | 'Alternative Learning System (ALS)'
  | 'Calamba Manpower Development Center (CMDC)';

export interface EducationFile {
  id: string;
  name: string;
  type: string;
  size: number;
  uploadDate: string;
  category: 'Performance' | 'Evaluation' | 'Certificate' | 'Other';
  dataUrl?: string;
}

export interface Student {
  id: string;
  name: string;
  age: number;
  gender: 'Male' | 'Female';
  educationLevel: EducationLevel;
  gradeSection: string;
  school: string;
  enrollmentDate: string;
  status: 'Active' | 'Completed' | 'Dropped';
  address?: string;
  guardianName?: string;
  guardianContact?: string;
  notes?: string;
  files: EducationFile[];
}

// ── CONSTANTS ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'educationStudents';

const EDUCATION_LEVELS: EducationLevel[] = [
  'High School',
  'Senior High School',
  'Alternative Learning System (ALS)',
  'Calamba Manpower Development Center (CMDC)',
];

const LEVEL_COLORS: Record<EducationLevel, { bg: string; text: string; accent: string }> = {
  'High School':                             { bg: '#DBEAFE', text: '#1E40AF', accent: '#3B82F6' },
  'Senior High School':                      { bg: '#FEF3C7', text: '#92400E', accent: '#F59E0B' },
  'Alternative Learning System (ALS)':       { bg: '#D1FAE5', text: '#065F46', accent: '#10B981' },
  'Calamba Manpower Development Center (CMDC)': { bg: '#EDE9FE', text: '#5B21B6', accent: '#7C3AED' },
};

const LEVEL_SHORT: Record<EducationLevel, string> = {
  'High School': 'HS',
  'Senior High School': 'SHS',
  'Alternative Learning System (ALS)': 'ALS',
  'Calamba Manpower Development Center (CMDC)': 'CMDC',
};

const EMPTY_STUDENT: Omit<Student, 'id' | 'files'> = {
  name: '',
  age: 0,
  gender: 'Male',
  educationLevel: 'High School',
  gradeSection: '',
  school: '',
  enrollmentDate: '',
  status: 'Active',
  address: '',
  guardianName: '',
  guardianContact: '',
  notes: '',
};

// ── HELPERS ──────────────────────────────────────────────────────────────────

function loadStudents(): Student[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveStudents(students: Student[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(students));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── COMPONENT ────────────────────────────────────────────────────────────────

export function Education() {
  const [students, setStudents] = useState<Student[]>(() => loadStudents());
  const [searchTerm, setSearchTerm] = useState('');
  const [activeLevel, setActiveLevel] = useState<'all' | EducationLevel>('all');
  const [activeTab, setActiveTab] = useState('masterlist');

  // Student dialog
  const [isStudentDialogOpen, setIsStudentDialogOpen] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [studentForm, setStudentForm] = useState<Omit<Student, 'id' | 'files'>>(EMPTY_STUDENT);
  const [formError, setFormError] = useState('');

  // View/Profile dialog
  const [viewStudent, setViewStudent] = useState<Student | null>(null);
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [profileTab, setProfileTab] = useState('info');

  // File upload
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<Student | null>(null);
  const [uploadCategory, setUploadCategory] = useState<EducationFile['category']>('Performance');
  const [uploadError, setUploadError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<Student | null>(null);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  // ── PERSIST ────────────────────────────────────────────────────────────────
  const persist = (updated: Student[]) => {
    setStudents(updated);
    saveStudents(updated);
  };

  // ── ADD / EDIT STUDENT ────────────────────────────────────────────────────
  const openAdd = () => {
    setEditingStudent(null);
    setStudentForm(EMPTY_STUDENT);
    setFormError('');
    setIsStudentDialogOpen(true);
  };

  const openEdit = (s: Student) => {
    setEditingStudent(s);
    setStudentForm({
      name: s.name, age: s.age, gender: s.gender,
      educationLevel: s.educationLevel, gradeSection: s.gradeSection,
      school: s.school, enrollmentDate: s.enrollmentDate,
      status: s.status, address: s.address, guardianName: s.guardianName,
      guardianContact: s.guardianContact, notes: s.notes,
    });
    setFormError('');
    setIsStudentDialogOpen(true);
  };

  const handleSaveStudent = () => {
    setFormError('');
    if (!studentForm.name.trim()) { setFormError('Name is required.'); return; }
    if (!studentForm.school.trim()) { setFormError('School is required.'); return; }
    if (!studentForm.enrollmentDate) { setFormError('Enrollment date is required.'); return; }

    if (editingStudent) {
      const updated = students.map(s =>
        s.id === editingStudent.id ? { ...s, ...studentForm } : s
      );
      persist(updated);
    } else {
      const newStudent: Student = {
        id: `STU${Date.now().toString().slice(-5)}`,
        ...studentForm,
        files: [],
      };
      persist([...students, newStudent]);
    }
    setIsStudentDialogOpen(false);
  };

  // ── FILE UPLOAD ───────────────────────────────────────────────────────────
  const openUpload = (s: Student) => {
    setUploadTarget(s);
    setUploadCategory('Performance');
    setUploadError('');
    setPendingFile(null);
    setIsUploadOpen(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setPendingFile(file);
  };

  const handleUploadConfirm = () => {
    if (!pendingFile || !uploadTarget) { setUploadError('Please select a file.'); return; }
    const reader = new FileReader();
    reader.onloadend = () => {
      const newFile: EducationFile = {
        id: `EF${Date.now()}`,
        name: pendingFile.name,
        type: pendingFile.type,
        size: pendingFile.size,
        uploadDate: new Date().toISOString().split('T')[0],
        category: uploadCategory,
        dataUrl: reader.result as string,
      };
      const updated = students.map(s =>
        s.id === uploadTarget.id
          ? { ...s, files: [...s.files, newFile] }
          : s
      );
      persist(updated);
      // also update viewStudent if open
      if (viewStudent?.id === uploadTarget.id) {
        setViewStudent(updated.find(s => s.id === uploadTarget.id) || null);
      }
      setIsUploadOpen(false);
    };
    reader.readAsDataURL(pendingFile);
  };

  const handleDeleteFile = (student: Student, fileId: string) => {
    const updated = students.map(s =>
      s.id === student.id
        ? { ...s, files: s.files.filter(f => f.id !== fileId) }
        : s
    );
    persist(updated);
    if (viewStudent?.id === student.id) {
      setViewStudent(updated.find(s => s.id === student.id) || null);
    }
  };

  // ── DELETE STUDENT ────────────────────────────────────────────────────────
  const handleDelete = () => {
    if (!deleteTarget || deleteConfirm !== deleteTarget.name) return;
    persist(students.filter(s => s.id !== deleteTarget.id));
    setIsDeleteOpen(false);
    setDeleteTarget(null);
    setDeleteConfirm('');
  };

  // ── VIEW ──────────────────────────────────────────────────────────────────
  const openView = (s: Student) => {
    setViewStudent(s);
    setProfileTab('info');
    setIsViewOpen(true);
  };

  // ── FILTER ────────────────────────────────────────────────────────────────
  const filtered = students.filter(s => {
    const matchSearch =
      s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.school.toLowerCase().includes(searchTerm.toLowerCase());
    const matchLevel = activeLevel === 'all' || s.educationLevel === activeLevel;
    return matchSearch && matchLevel;
  });

  // Grouped by level for category view
  const grouped = EDUCATION_LEVELS.reduce<Record<EducationLevel, Student[]>>((acc, lvl) => {
    acc[lvl] = filtered.filter(s => s.educationLevel === lvl);
    return acc;
  }, {} as Record<EducationLevel, Student[]>);

  // ── RENDER ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="bg-[#2F3E46] p-6 rounded-xl shadow-md border-b-4 border-[#FFD100]">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-[#FFD100] flex items-center justify-center">
            <GraduationCap className="w-6 h-6 text-[#2F3E46]" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Education Module</h2>
            <p className="text-gray-300 text-sm">Manage students, records, and educational track placements</p>
          </div>
        </div>
        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5">
          {EDUCATION_LEVELS.map(lvl => {
            const c = LEVEL_COLORS[lvl];
            const count = students.filter(s => s.educationLevel === lvl).length;
            return (
              <div key={lvl} className="bg-white/10 rounded-xl p-3 border border-white/10">
                <p className="text-[10px] font-bold text-gray-300 uppercase tracking-wider">{LEVEL_SHORT[lvl]}</p>
                <p className="text-2xl font-black text-white mt-0.5">{count}</p>
                <p className="text-[10px] text-gray-400 truncate">{lvl.split('(')[0].trim()}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center">
        <div className="flex gap-2 flex-1 w-full sm:max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              className="pl-10 rounded-xl"
              placeholder="Search by name, ID, or school..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
        </div>
        <Button
          onClick={openAdd}
          className="gap-2 font-bold rounded-xl px-5 shrink-0"
          style={{ backgroundColor: '#FFD100', color: '#2F3E46' }}
        >
          <Plus className="w-4 h-4" /> Add Student
        </Button>
      </div>

      {/* Main Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-2">
          <TabsTrigger value="masterlist">Student Master List ({students.length})</TabsTrigger>
          <TabsTrigger value="byLevel">By Educational Level</TabsTrigger>
        </TabsList>

        {/* MASTER LIST */}
        <TabsContent value="masterlist">
          {/* Level filter pills */}
          <div className="flex flex-wrap gap-2 mb-4">
            <button
              onClick={() => setActiveLevel('all')}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                activeLevel === 'all'
                  ? 'bg-[#2F3E46] text-white border-[#2F3E46]'
                  : 'border-gray-200 text-gray-600 hover:border-[#2F3E46]'
              }`}
            >
              All ({students.length})
            </button>
            {EDUCATION_LEVELS.map(lvl => {
              const c = LEVEL_COLORS[lvl];
              const count = students.filter(s => s.educationLevel === lvl).length;
              return (
                <button
                  key={lvl}
                  onClick={() => setActiveLevel(lvl)}
                  className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                    activeLevel === lvl
                      ? 'border-transparent text-white'
                      : 'border-gray-200 text-gray-600 hover:border-gray-400'
                  }`}
                  style={activeLevel === lvl ? { backgroundColor: c.accent } : {}}
                >
                  {LEVEL_SHORT[lvl]} ({count})
                </button>
              );
            })}
          </div>

          {filtered.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <GraduationCap className="w-10 h-10 mx-auto mb-2 opacity-20" />
              <p className="text-sm italic">No students found.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map(student => <StudentCard key={student.id} student={student} onView={openView} onEdit={openEdit} onUpload={openUpload} onDelete={s => { setDeleteTarget(s); setDeleteConfirm(''); setIsDeleteOpen(true); }} />)}
            </div>
          )}
        </TabsContent>

        {/* BY LEVEL */}
        <TabsContent value="byLevel">
          <div className="space-y-6">
            {EDUCATION_LEVELS.map(lvl => {
              const c = LEVEL_COLORS[lvl];
              const list = grouped[lvl];
              return (
                <div key={lvl}>
                  <div className="flex items-center gap-3 mb-3 pb-2 border-b-2" style={{ borderColor: c.accent }}>
                    <div className="w-8 h-8 rounded-full flex items-center justify-center font-black text-xs" style={{ backgroundColor: c.bg, color: c.text }}>
                      {LEVEL_SHORT[lvl]}
                    </div>
                    <div>
                      <h3 className="font-bold text-[#2F3E46]">{lvl}</h3>
                      <p className="text-xs text-gray-400">{list.length} student{list.length !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                  {list.length === 0 ? (
                    <p className="text-sm text-gray-400 italic pl-11">No students enrolled in this track.</p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {list.map(s => <StudentCard key={s.id} student={s} onView={openView} onEdit={openEdit} onUpload={openUpload} onDelete={s => { setDeleteTarget(s); setDeleteConfirm(''); setIsDeleteOpen(true); }} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </TabsContent>
      </Tabs>

      {/* ── ADD / EDIT STUDENT DIALOG ── */}
      <Dialog open={isStudentDialogOpen} onOpenChange={open => { if (!open) setIsStudentDialogOpen(false); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46] font-bold">
              {editingStudent ? 'Edit Student' : 'Add New Student'}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {formError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" /> {formError}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Full Name *</Label>
                <Input value={studentForm.name} onChange={e => setStudentForm(p => ({ ...p, name: e.target.value }))} placeholder="Juan dela Cruz" className="rounded-xl" />
              </div>
              <div className="space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Age *</Label>
                <Input type="number" min={1} max={30} value={studentForm.age || ''} onChange={e => setStudentForm(p => ({ ...p, age: Number(e.target.value) }))} className="rounded-xl" />
              </div>
              <div className="space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Gender *</Label>
                <Select value={studentForm.gender} onValueChange={v => setStudentForm(p => ({ ...p, gender: v as 'Male' | 'Female' }))}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Male">Male</SelectItem>
                    <SelectItem value="Female">Female</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Educational Level *</Label>
                <Select value={studentForm.educationLevel} onValueChange={v => setStudentForm(p => ({ ...p, educationLevel: v as EducationLevel }))}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EDUCATION_LEVELS.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Grade / Section</Label>
                <Input value={studentForm.gradeSection} onChange={e => setStudentForm(p => ({ ...p, gradeSection: e.target.value }))} placeholder="e.g. Grade 9 - Amity" className="rounded-xl" />
              </div>
              <div className="space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Status</Label>
                <Select value={studentForm.status} onValueChange={v => setStudentForm(p => ({ ...p, status: v as Student['status'] }))}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Active">Active</SelectItem>
                    <SelectItem value="Completed">Completed</SelectItem>
                    <SelectItem value="Dropped">Dropped</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">School / Institution *</Label>
                <Input value={studentForm.school} onChange={e => setStudentForm(p => ({ ...p, school: e.target.value }))} placeholder="School name" className="rounded-xl" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Enrollment Date *</Label>
                <Input type="date" value={studentForm.enrollmentDate} onChange={e => setStudentForm(p => ({ ...p, enrollmentDate: e.target.value }))} className="rounded-xl" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Address</Label>
                <Input value={studentForm.address} onChange={e => setStudentForm(p => ({ ...p, address: e.target.value }))} placeholder="Home address" className="rounded-xl" />
              </div>
              <div className="space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Guardian Name</Label>
                <Input value={studentForm.guardianName} onChange={e => setStudentForm(p => ({ ...p, guardianName: e.target.value }))} className="rounded-xl" />
              </div>
              <div className="space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Guardian Contact</Label>
                <Input value={studentForm.guardianContact} onChange={e => setStudentForm(p => ({ ...p, guardianContact: e.target.value }))} className="rounded-xl" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Notes</Label>
                <Textarea value={studentForm.notes} onChange={e => setStudentForm(p => ({ ...p, notes: e.target.value }))} className="rounded-xl min-h-[80px]" placeholder="Additional notes..." />
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" className="rounded-xl" onClick={() => setIsStudentDialogOpen(false)}>Cancel</Button>
            <Button className="rounded-xl px-6 font-bold" style={{ backgroundColor: '#2F3E46', color: 'white' }} onClick={handleSaveStudent}>
              {editingStudent ? 'Save Changes' : 'Add Student'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── VIEW / PROFILE DIALOG ── */}
      <Dialog open={isViewOpen} onOpenChange={open => { if (!open) setIsViewOpen(false); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl p-0">
          {viewStudent && (() => {
            const c = LEVEL_COLORS[viewStudent.educationLevel];
            return (
              <>
                <div className="p-6 border-b" style={{ backgroundColor: c.bg }}>
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-full flex items-center justify-center font-black text-lg" style={{ backgroundColor: c.accent, color: 'white' }}>
                      {viewStudent.name.charAt(0)}
                    </div>
                    <div>
                      <h2 className="text-xl font-bold" style={{ color: c.text }}>{viewStudent.name}</h2>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <Badge style={{ backgroundColor: c.accent, color: 'white', border: 'none' }} className="text-xs">{LEVEL_SHORT[viewStudent.educationLevel]}</Badge>
                        <span className="text-xs font-medium" style={{ color: c.text }}>{viewStudent.educationLevel}</span>
                        <span className="text-xs text-gray-500">· {viewStudent.id}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-6">
                  <Tabs value={profileTab} onValueChange={setProfileTab}>
                    <TabsList className="mb-4">
                      <TabsTrigger value="info">Personal Info</TabsTrigger>
                      <TabsTrigger value="files">
                        Files ({viewStudent.files.length})
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="info">
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        {[
                          ['Age', viewStudent.age],
                          ['Gender', viewStudent.gender],
                          ['Grade / Section', viewStudent.gradeSection || '—'],
                          ['School', viewStudent.school],
                          ['Enrollment Date', viewStudent.enrollmentDate],
                          ['Status', viewStudent.status],
                          ['Address', viewStudent.address || '—'],
                          ['Guardian', viewStudent.guardianName || '—'],
                          ['Guardian Contact', viewStudent.guardianContact || '—'],
                        ].map(([label, val]) => (
                          <div key={String(label)} className={label === 'Address' || label === 'School' ? 'col-span-2' : ''}>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{label}</p>
                            <p className="font-semibold text-[#2F3E46] mt-0.5">{String(val)}</p>
                          </div>
                        ))}
                        {viewStudent.notes && (
                          <div className="col-span-2">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Notes</p>
                            <p className="text-gray-600 mt-0.5 text-sm italic">{viewStudent.notes}</p>
                          </div>
                        )}
                      </div>
                    </TabsContent>

                    <TabsContent value="files">
                      <div className="flex justify-between items-center mb-3">
                        <p className="text-sm font-bold text-[#2F3E46]">Uploaded Documents</p>
                        <Button size="sm" className="rounded-lg gap-1.5 font-bold" style={{ backgroundColor: '#FFD100', color: '#2F3E46' }} onClick={() => { openUpload(viewStudent); }}>
                          <Upload className="w-3.5 h-3.5" /> Upload
                        </Button>
                      </div>

                      {viewStudent.files.length === 0 ? (
                        <div className="text-center py-10 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                          <Paperclip className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                          <p className="text-sm text-gray-400 italic">No files uploaded yet.</p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {viewStudent.files.map(f => (
                            <div key={f.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100 hover:border-gray-300 transition-colors">
                              <div className="w-8 h-8 rounded-lg bg-[#2F3E46]/10 flex items-center justify-center shrink-0">
                                <FileText className="w-4 h-4 text-[#2F3E46]" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-[#2F3E46] truncate">{f.name}</p>
                                <p className="text-[10px] text-gray-400">{f.category} · {formatBytes(f.size)} · {f.uploadDate}</p>
                              </div>
                              <div className="flex gap-1 shrink-0">
                                {f.dataUrl && (
                                  <a href={f.dataUrl} download={f.name}>
                                    <Button size="icon" variant="ghost" className="h-7 w-7 hover:bg-blue-50">
                                      <Download className="w-3.5 h-3.5 text-blue-500" />
                                    </Button>
                                  </a>
                                )}
                                <Button size="icon" variant="ghost" className="h-7 w-7 hover:bg-red-50 text-red-400" onClick={() => handleDeleteFile(viewStudent, f.id)}>
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>
                  </Tabs>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── FILE UPLOAD DIALOG ── */}
      <Dialog open={isUploadOpen} onOpenChange={open => { if (!open) setIsUploadOpen(false); }}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46] font-bold flex items-center gap-2">
              <Upload className="w-5 h-5" /> Upload File
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {uploadError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" /> {uploadError}
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="font-bold text-[#2F3E46]">Student</Label>
              <p className="text-sm font-semibold text-gray-600">{uploadTarget?.name}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="font-bold text-[#2F3E46]">Category *</Label>
              <Select value={uploadCategory} onValueChange={v => setUploadCategory(v as EducationFile['category'])}>
                <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Performance">Performance</SelectItem>
                  <SelectItem value="Evaluation">Evaluation</SelectItem>
                  <SelectItem value="Certificate">Certificate</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-bold text-[#2F3E46]">File *</Label>
              <div
                className="border-2 border-dashed border-gray-200 rounded-xl p-6 text-center cursor-pointer hover:border-[#FFD100] transition-colors"
                onClick={() => fileRef.current?.click()}
              >
                {pendingFile ? (
                  <div className="flex items-center gap-2 justify-center">
                    <FileText className="w-5 h-5 text-[#2F3E46]" />
                    <span className="text-sm font-semibold text-[#2F3E46] truncate max-w-[180px]">{pendingFile.name}</span>
                    <button onClick={e => { e.stopPropagation(); setPendingFile(null); }} className="text-red-400 hover:text-red-600">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <Upload className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                    <p className="text-sm text-gray-400">Click to select a file</p>
                  </>
                )}
              </div>
              <input ref={fileRef} type="file" className="hidden" onChange={handleFileChange} />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="rounded-xl" onClick={() => setIsUploadOpen(false)}>Cancel</Button>
            <Button className="rounded-xl font-bold" style={{ backgroundColor: '#2F3E46', color: 'white' }} onClick={handleUploadConfirm}>
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── DELETE DIALOG ── */}
      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent className="rounded-2xl bg-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <AlertCircle className="w-5 h-5" /> Confirm Delete
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span>This will permanently remove <strong>{deleteTarget?.name}</strong> from the master list.</span>
              <div className="pt-2 space-y-1.5">
                <Label className="text-xs text-gray-600">Type <strong>{deleteTarget?.name}</strong> to confirm:</Label>
                <Input value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)} placeholder="Student name" className="rounded-xl" />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteConfirm('')}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteConfirm !== deleteTarget?.name}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Delete Student
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── STUDENT CARD ──────────────────────────────────────────────────────────────

function StudentCard({
  student, onView, onEdit, onUpload, onDelete,
}: {
  student: Student;
  onView: (s: Student) => void;
  onEdit: (s: Student) => void;
  onUpload: (s: Student) => void;
  onDelete: (s: Student) => void;
}) {
  const c = LEVEL_COLORS[student.educationLevel];
  const statusColor = student.status === 'Active' ? '#10B981' : student.status === 'Completed' ? '#3B82F6' : '#EF4444';

  return (
    <Card className="overflow-hidden border-none shadow-md hover:shadow-lg transition-shadow rounded-2xl">
      <div className="h-1.5" style={{ backgroundColor: c.accent }} />
      <CardContent className="p-5">
        <div className="flex justify-between items-start mb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-full flex items-center justify-center font-black text-sm" style={{ backgroundColor: c.bg, color: c.text }}>
              {student.name.charAt(0)}
            </div>
            <div>
              <p className="font-bold text-[#2F3E46] leading-tight">{student.name}</p>
              <p className="text-[10px] text-gray-400 font-mono">{student.id}</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge className="border-none text-[10px] font-bold" style={{ backgroundColor: c.bg, color: c.text }}>
              {LEVEL_SHORT[student.educationLevel]}
            </Badge>
            <span className="text-[10px] font-bold" style={{ color: statusColor }}>{student.status}</span>
          </div>
        </div>

        <div className="space-y-1 text-xs text-gray-500 mb-3">
          <p><span className="font-semibold text-gray-600">School:</span> {student.school}</p>
          {student.gradeSection && <p><span className="font-semibold text-gray-600">Grade:</span> {student.gradeSection}</p>}
          <p><span className="font-semibold text-gray-600">Enrolled:</span> {student.enrollmentDate}</p>
          <p><span className="font-semibold text-gray-600">Files:</span> {student.files.length} document{student.files.length !== 1 ? 's' : ''}</p>
        </div>

        <div className="flex justify-between items-center pt-2 border-t border-gray-100 gap-1">
          <Button size="icon" variant="ghost" className="h-8 w-8 hover:bg-blue-50" onClick={() => onView(student)} title="View Profile">
            <Eye className="w-3.5 h-3.5 text-blue-500" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8 hover:bg-[#FFD100]/20" onClick={() => onEdit(student)} title="Edit">
            <Edit className="w-3.5 h-3.5 text-[#2F3E46]" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8 hover:bg-green-50" onClick={() => onUpload(student)} title="Upload File">
            <Upload className="w-3.5 h-3.5 text-green-600" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8 hover:bg-red-50" onClick={() => onDelete(student)} title="Delete">
            <Trash2 className="w-3.5 h-3.5 text-red-400" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
