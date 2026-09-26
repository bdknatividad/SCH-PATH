import { useState, useRef, useEffect } from 'react';
import { useData } from '@/app/state/DataContext';
import { request, createResource, updateResource, deleteResource } from '@/services/api';
import { useAuth } from '@/app/state/AuthContext';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { SignaturePadModal } from '@/app/components/SignaturePad';
import { drawSignatureImageOnPage } from '@/app/utils/signaturePdf';
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
  ChevronDown, ChevronUp, Paperclip, CalendarDays, CheckCircle2,
} from 'lucide-react';
import { ProgramQuarterlyReports } from './QuarterlyProgressReport';

// ── TYPES ────────────────────────────────────────────────────────────────────

export type EducationLevel =
  | 'Junior High School'
  | 'Senior High School'
  | 'Tutorial'
  | 'Alternative Learning System (ALS)'
  | 'ALS Elementary'
  | 'ALS Junior High School'
  | 'ALS Senior High School'
  | 'Calamba Manpower Development Center (CMDC)'
  // Legacy spellings. Kept in the union so a record written before the levels
  // were renamed or split still renders; none of them is offered in the picker.
  // `High School` is the old name for `Junior High School` — it sat beside
  // `Senior High School` and read as either one.
  | 'High School'
  | 'ALS - Elementary'
  | 'ALS - High School';

export interface EducationFile {
  id: string;
  name: string;
  type: string;
  size: number;
  uploadDate: string;
  category: 'Performance' | 'Evaluation' | 'Certificate' | 'Monthly Report' | 'Progress Report' | 'Other';
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
  lrn?: string;
  traineeNumber?: string;
  files: EducationFile[];
  residentId?: string;
  /**
   * Username of the account that created the learner record. Set by the API.
   * Used to scope the Quarterly Education Report to an educator's own learners.
   */
  createdBy?: string;
}

/**
 * A record as the API stores it. `school` and `enrollmentDate` are nullable
 * there, because a learner who is not enrolled in school has neither to give.
 * The component works in `Student`, where both are strings, so every record
 * crossing that boundary passes through `normalizeStudent`.
 */
interface EducationRecordWire extends Omit<Student, 'school' | 'enrollmentDate'> {
  school: string | null;
  enrollmentDate: string | null;
}

// ── CONSTANTS ────────────────────────────────────────────────────────────────

// Progress report per student
export interface ProgressReport {
  id: string;
  studentId: string;
  month: string; // YYYY-MM
  subject: string;
  result: 'Passed' | 'Failed';
  academicProgress: string;
  participation: string;
  strengths: string;
  areasForImprovement: string;
  overallDevelopment: string;
  schoolVisits: number;
  createdAt: string;
}

// Monthly report

export interface SchoolVisitReport {
  id: string;
  studentId: string;
  visitDate: string;
  school: string;
  purpose: string;
  findings: string;
  /**
   * `Scheduled` for a visit that has been planned but not yet made, `Completed`
   * once it has happened. Optional so reports stored before this field existed
   * still load — those are read as `Completed`, which is what they are.
   */
  status?: 'Scheduled' | 'Completed';
  fileName?: string;
  fileData?: string;
  createdAt: string;
}

const STORAGE_KEY = 'educationStudents';
const VISIT_KEY = 'educationVisitReports';

const loadVisits = (): SchoolVisitReport[] => {
  try { return JSON.parse(localStorage.getItem(VISIT_KEY) || '[]'); } catch { return []; }
};
const saveVisits = (r: SchoolVisitReport[]) => {
  try { localStorage.setItem(VISIT_KEY, JSON.stringify(r)); } catch {}
};
const PROGRESS_KEY = 'educationProgressReports';
const MONTHLY_KEY  = 'educationMonthlyReports';

const loadProgress = (): ProgressReport[] => {
  try {
    const saved = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.map((report: any) => ({
      ...report,
      result: report.result === 'Pass' ? 'Passed' : report.result === 'Fail' ? 'Failed' : report.result,
      academicProgress: report.academicProgress || '',
      participation: report.participation || '',
      strengths: report.strengths || '',
      areasForImprovement: report.areasForImprovement || '',
      overallDevelopment: report.overallDevelopment || '',
    })).filter((report: ProgressReport) => report.result === 'Passed' || report.result === 'Failed');
  } catch { return []; }
};
const saveProgress = (r: ProgressReport[]) => {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(r)); } catch {}
};
// What the picker offers. Deliberately more specific than the type union: an
// ALS learner is recorded at the level they are actually in, and a resident who
// is not enrolled at all (the enrollment window closed, or they are between
// schools) is recorded as Tutorial rather than being forced into a school level
// they do not have.
//
// The generic 'Alternative Learning System (ALS)' is deliberately absent: with
// ALS Elementary / Junior High / Senior High separated, it was the one option
// that said nothing about where the learner actually is, and it was the only
// remaining level offered here whose legacy counterpart had already been
// retired. It stays in the type union and the colour maps so a record written
// before the split still renders and still filters.
const EDUCATION_LEVELS: EducationLevel[] = [
  'Junior High School',
  'Senior High School',
  'Tutorial',
  'ALS Elementary',
  'ALS Junior High School',
  'ALS Senior High School',
  'Calamba Manpower Development Center (CMDC)',
];

/*
 * The label the user reads, which is not always the stored value.
 *
 * `Tutorial` is the value already written on existing records, so renaming the
 * value would orphan them; only the label changes. It is the facility's Academic
 * Support Sessions / Tutorial activity, recorded for a resident who is not
 * enrolled in school.
 */
const LEVEL_LABELS: Partial<Record<EducationLevel, string>> = {
  'Tutorial': 'Academic Support Sessions / Tutorial',
};

const levelLabel = (level: EducationLevel): string => LEVEL_LABELS[level] || level;

/*
 * Whether a level means "not enrolled in school". Such a learner has no school
 * and no enrolment date to give, so neither is required of them — every other
 * level is a school placement and still requires both.
 */
const isNotEnrolled = (level: EducationLevel): boolean => level === 'Tutorial';

const LEVEL_COLORS: Record<EducationLevel, { bg: string; text: string; accent: string }> = {
  'Junior High School':                         { bg: '#DBEAFE', text: '#1E40AF', accent: '#3B82F6' },
  'High School':                                { bg: '#DBEAFE', text: '#1E40AF', accent: '#3B82F6' },
  'Senior High School':                         { bg: '#FEF3C7', text: '#92400E', accent: '#F59E0B' },
  'Tutorial':                                   { bg: '#FFE4E6', text: '#9F1239', accent: '#FB7185' },
  'Alternative Learning System (ALS)':          { bg: '#D1FAE5', text: '#065F46', accent: '#10B981' },
  'ALS Elementary':                             { bg: '#ECFDF5', text: '#047857', accent: '#10B981' },
  'ALS Junior High School':                     { bg: '#F0FDF4', text: '#166534', accent: '#22C55E' },
  'ALS Senior High School':                     { bg: '#DCFCE7', text: '#14532D', accent: '#16A34A' },
  'Calamba Manpower Development Center (CMDC)': { bg: '#EDE9FE', text: '#5B21B6', accent: '#7C3AED' },
  'ALS - Elementary':                           { bg: '#ECFDF5', text: '#047857', accent: '#10B981' },
  'ALS - High School':                          { bg: '#F0FDF4', text: '#166534', accent: '#22C55E' },
};

const LEVEL_SHORT: Record<EducationLevel, string> = {
  'Junior High School': 'JHS',
  'High School': 'HS',
  'Senior High School': 'SHS',
  'Tutorial': 'Tutorial',
  'Alternative Learning System (ALS)': 'ALS',
  'ALS Elementary': 'ALS-E',
  'ALS Junior High School': 'ALS-JHS',
  'ALS Senior High School': 'ALS-SHS',
  'Calamba Manpower Development Center (CMDC)': 'CMDC',
  'ALS - Elementary': 'ALS-E',
  'ALS - High School': 'ALS-HS',
};

const EMPTY_STUDENT: Omit<Student, 'id' | 'files'> = {
  name: '',
  age: 0,
  gender: 'Male',
  educationLevel: 'Junior High School',
  gradeSection: '',
  school: '',
  enrollmentDate: '',
  status: 'Active',
  address: '',
  guardianName: '',
  guardianContact: '',
  notes: '',
  lrn: '',
  traineeNumber: '',
};

// ── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * `school` and `enrollmentDate` are nullable on the server, because a learner
 * who is not enrolled in school has neither to give. Everything here treats them
 * as strings, so every record that enters state — from the API, from the cache,
 * or from a save response — passes through here first. Without this a Tutorial
 * record saved once would put `null` into a controlled input on the next render.
 */
function normalizeStudent(s: EducationRecordWire): Student {
  return {
    ...s,
    school: s.school || '',
    enrollmentDate: s.enrollmentDate || '',
  };
}

function loadStudents(): Student[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStudent);
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

/**
 * Space reserved for the teacher's signature on the Quarterly Progress Report.
 * The report is drawn from scratch, so unlike the template-overlay forms there
 * is no printed rule to measure against — these are the box the signature is
 * scaled into, and the room kept clear for it above the printed name.
 */
const SIGNATURE_WIDTH = 220;
const SIGNATURE_HEIGHT = 44;

/**
 * Generates the Quarterly Progress Report as a real PDF, laid out to match
 * the official template exactly: centered underlined title/period, then
 * bold field labels with generous spacing — not just a wrapped text dump.
 */
async function generateQuarterlyReportPdf(fields: {
  titleLine1: string;
  titleLine2: string;
  nameOfResident: string;
  idLabel: string;
  gradeLevel: string;
  observationStatus: string;
  recommendations: string;
  preparedByName: string;
  preparedByTitle: string;
  preparedBySignature: string;
}): Promise<{ dataUrl: string; size: number }> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 72;
  const maxWidth = pageWidth - margin * 2;
  const bodySize = 11;
  const lineHeight = 16;

  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - 90;

  const newPageIfNeeded = (needed = lineHeight) => {
    if (y < margin + needed) {
      page = pdf.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  };

  const drawCenteredUnderlined = (text: string, size: number) => {
    const width = bold.widthOfTextAtSize(text, size);
    const x = (pageWidth - width) / 2;
    page.drawText(text, { x, y, size, font: bold, color: rgb(0.05, 0.05, 0.05) });
    page.drawLine({ start: { x, y: y - 3 }, end: { x: x + width, y: y - 3 }, thickness: 0.75, color: rgb(0.05, 0.05, 0.05) });
    y -= size + 12;
  };

  const wrapLine = (text: string, size: number, f: typeof font): string[] => {
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (f.widthOfTextAtSize(test, size) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  // Title block — centered, underlined, matching the official form.
  drawCenteredUnderlined(fields.titleLine1, 13);
  drawCenteredUnderlined(fields.titleLine2, 12);
  y -= 20;

  // A labeled field: bold label, then either inline value (if short) or the
  // value on its own line beneath — matching how the Word template flows.
  const drawField = (label: string, value: string, inline = true) => {
    newPageIfNeeded();
    if (inline && font.widthOfTextAtSize(`${label} ${value}`, bodySize) <= maxWidth) {
      page.drawText(label, { x: margin, y, size: bodySize, font: bold, color: rgb(0.05, 0.05, 0.05) });
      const labelWidth = bold.widthOfTextAtSize(`${label} `, bodySize);
      page.drawText(value, { x: margin + labelWidth, y, size: bodySize, font, color: rgb(0.1, 0.1, 0.1) });
      y -= lineHeight * 1.8;
    } else {
      page.drawText(label, { x: margin, y, size: bodySize, font: bold, color: rgb(0.05, 0.05, 0.05) });
      y -= lineHeight;
      for (const line of wrapLine(value || '—', bodySize, font)) {
        newPageIfNeeded();
        page.drawText(line, { x: margin, y, size: bodySize, font, color: rgb(0.1, 0.1, 0.1) });
        y -= lineHeight;
      }
      y -= lineHeight * 0.6;
    }
  };

  drawField('NAME OF RESIDENT:', fields.nameOfResident);
  drawField(fields.idLabel.split(':')[0] + ':', fields.idLabel.split(': ')[1] || '—');
  drawField('GRADE LEVEL/SHS STRAND:', fields.gradeLevel, false);
  drawField('OBSERVATION/STATUS:', fields.observationStatus, false);
  y -= 10;
  drawField('RECOMMENDATION/S:', fields.recommendations, false);
  y -= 20;

  newPageIfNeeded(lineHeight * 3 + SIGNATURE_HEIGHT);
  page.drawText('PREPARED BY:', { x: margin, y, size: bodySize, font: bold, color: rgb(0.05, 0.05, 0.05) });
  y -= lineHeight * 2.2;

  /*
   * The teacher's drawn signature, sitting on the blank line directly above the
   * printed name — the same "signature over printed name" arrangement the rest
   * of the system uses.
   *
   * This report is generated from scratch rather than overlaid onto an official
   * template, so there is no pre-printed rule to line up with: the space is
   * reserved here, and only when there is actually a signature to place.
   */
  if (fields.preparedBySignature) {
    const placed = await drawSignatureImageOnPage(pdf, page, fields.preparedBySignature, {
      x: margin,
      y: y + lineHeight * 0.8,
      width: SIGNATURE_WIDTH,
      height: SIGNATURE_HEIGHT,
    });

    if (placed) y -= SIGNATURE_HEIGHT + lineHeight * 0.8;
  }

  page.drawText(fields.preparedByName, { x: margin, y, size: bodySize, font, color: rgb(0.1, 0.1, 0.1) });
  y -= lineHeight;
  page.drawText(fields.preparedByTitle, { x: margin, y, size: bodySize, font, color: rgb(0.1, 0.1, 0.1) });

  const bytes = await pdf.save();
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const dataUrl = `data:application/pdf;base64,${btoa(binary)}`;
  return { dataUrl, size: bytes.length };
}

export function Education() {
  const [students, setStudents] = useState<Student[]>(() => loadStudents());
  const [searchTerm, setSearchTerm] = useState('');
  const [activeLevel, setActiveLevel] = useState<'all' | EducationLevel>('all');
  const { children: residents, documents, addDocument } = useData();
  const { user } = useAuth();
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

  // School Visit Reports
  const [visitReports, setVisitReports] = useState<SchoolVisitReport[]>(() => loadVisits());
  const [isVisitUploadOpen, setIsVisitUploadOpen] = useState(false);
  const [pendingVisitFile, setPendingVisitFile] = useState<File | null>(null);
  const [visitForm, setVisitForm] = useState({ studentId: '', visitDate: new Date().toISOString().split('T')[0], school: '', purpose: '', findings: '', status: 'Completed' as 'Scheduled' | 'Completed' });
  const visitFileRef = useRef<HTMLInputElement>(null);

  const handleSaveVisit = async () => {
    if (!visitForm.studentId || !visitForm.school) return;
    let fileData: string | undefined;
    let fileName: string | undefined;
    if (pendingVisitFile) {
      fileData = await new Promise<string>(res => {
        const reader = new FileReader();
        reader.onloadend = () => res(reader.result as string);
        reader.readAsDataURL(pendingVisitFile);
      });
      fileName = pendingVisitFile.name;
    }
    const rpt: SchoolVisitReport = {
      id: Date.now().toString(),
      studentId: visitForm.studentId,
      visitDate: visitForm.visitDate,
      school: visitForm.school,
      purpose: visitForm.purpose,
      findings: visitForm.findings,
      status: visitForm.status,
      fileName,
      fileData,
      createdAt: new Date().toISOString(),
    };
    const updated = [...visitReports, rpt];
    setVisitReports(updated);
    saveVisits(updated);

    const student = students.find(s => s.id === visitForm.studentId);
    try {
      const saved = await createResource<any>('education-school-visits', {
        ...rpt,
        educationRecordId: visitForm.studentId,
        residentId: student?.residentId,
      });
      const synced = updated.map(v => v.id === rpt.id ? { ...v, id: saved.id } : v);
      setVisitReports(synced);
      saveVisits(synced);
    } catch (error) {
      setVisitReports(visitReports);
      saveVisits(visitReports);
      throw error;
    }

    // Save to the resident's Documents module — every visit report counts
    // toward Education Progress in the Child Record, whether or not a file
    // was attached, so this always runs (not just when there's a file).
    // Only a completed visit has a report to file. A scheduled visit is a plan,
    // and copying it into Documents would put a "School Visit Report" in the
    // resident's record before the visit has happened.
    const resident = visitForm.status === 'Completed'
      ? residents.find(c => c.id === student?.residentId) || residents.find(c => c.name === student?.name)
      : undefined;
    if (resident) {
      try {
        await addDocument({
          residentId: resident.id,
          residentName: resident.name,
          title: 'School Visit Report',
          category: 'Education',
          phase: '',
          description: `School visit on ${visitForm.visitDate} at ${visitForm.school}.${visitForm.purpose ? ` Purpose: ${visitForm.purpose}.` : ''}${visitForm.findings ? ` Findings: ${visitForm.findings}` : ''}`,
          fileName: fileName || `Visit_Report_${visitForm.visitDate}_${student?.name?.replace(/\s+/g, '_') || ''}.txt`,
          fileType: pendingVisitFile?.type,
          fileSize: pendingVisitFile?.size,
          fileData,
          uploaderRole: user?.role || 'educator',
          uploadedBy: user?.username || 'Educator',
          uploadedAt: new Date().toISOString(),
          status: 'Submitted',
          submittedBy: user?.username || 'Educator',
          submittedAt: new Date().toISOString(),
          requiresAssessment: false,
          assessmentTriggered: false,
        } as any);
      } catch (docError) {
        // The visit report itself is already saved; a failed copy into the
        // Documents module must not abort the flow.
        console.error('Unable to copy the school visit report to Documents:', docError);
      }
    }

    setIsVisitUploadOpen(false);
    setVisitForm({ studentId: '', visitDate: new Date().toISOString().split('T')[0], school: '', purpose: '', findings: '', status: 'Completed' });
    setPendingVisitFile(null);
  };

  // A scheduled visit that has now happened. Only the status flips: the report is
  // still to be uploaded, and that flow is what files it in Documents.
  const markVisitCompleted = async (visit: SchoolVisitReport) => {
    const previous = visitReports;
    const updated = previous.map(v => (v.id === visit.id ? { ...v, status: 'Completed' as const } : v));
    setVisitReports(updated);
    saveVisits(updated);
    try {
      await updateResource<any>('education-school-visits', visit.id, { status: 'Completed' });
    } catch (error) {
      // Put the row back rather than showing a status the server did not accept.
      setVisitReports(previous);
      saveVisits(previous);
      console.error('Unable to mark the school visit completed:', error);
    }
  };

  // Progress Reports
  const [progressReports, setProgressReports] = useState<ProgressReport[]>(() => loadProgress());
  const [isProgressOpen, setIsProgressOpen] = useState(false);
  const [progressStudent, setProgressStudent] = useState<Student | null>(null);
  const [progressEditing, setProgressEditing] = useState<ProgressReport | null>(null);
  const [progressForm, setProgressForm] = useState({
    subject: '', result: '' as '' | 'Passed' | 'Failed',
    academicProgress: '', participation: '', strengths: '', areasForImprovement: '', overallDevelopment: '',
    schoolVisits: '0', month: new Date().toISOString().substring(0, 7),
  });

  const [isQuarterlyOpen, setIsQuarterlyOpen] = useState(false);
  const [quarterlySubmitting, setQuarterlySubmitting] = useState(false);
  const [quarterlyError, setQuarterlyError] = useState('');
  const QUARTER_PERIODS = [
    { value: 'Q1', label: 'January to March' },
    { value: 'Q2', label: 'April to June' },
    { value: 'Q3', label: 'July to September' },
    { value: 'Q4', label: 'October to December' },
  ] as const;
  const getCalendarQuarter = (date = new Date()) => {
    const month = date.getMonth() + 1;
    return (`Q${Math.ceil(month / 3)}`) as 'Q1' | 'Q2' | 'Q3' | 'Q4';
  };

  const getQuarterKey = (quarter: string, year: string) => `${year}-${quarter}`;

  const getQuarterlyDocumentKey = (doc: any) => {
    if (doc?.title !== 'Quarterly Education Report') return null;
    const text = `${doc?.description || ''} ${doc?.fileName || ''}`;
    const explicit = text.match(/REPORT\s+QUARTER\s*:\s*(Q[1-4])\s*REPORT\s+YEAR\s*:\s*(\d{4})/i);
    if (explicit) return getQuarterKey(explicit[1].toUpperCase(), explicit[2]);
    const fileMatch = String(doc?.fileName || '').match(/Quarterly_Report_(Q[1-4])_(\d{4})_/i);
    return fileMatch ? getQuarterKey(fileMatch[1].toUpperCase(), fileMatch[2]) : null;
  };

  const submittedQuarterKeysForResident = (studentId: string) => {
    const student = students.find(s => s.id === studentId);
    if (!student) return new Set<string>();
    const residentId = student.residentId || residents.find(r => r.name === student.name)?.id;
    if (!residentId) return new Set<string>();
    return new Set(
      documents
        .filter((doc: any) => doc.title === 'Quarterly Education Report' && String(doc.residentId) === String(residentId))
        .map(getQuarterlyDocumentKey)
        .filter(Boolean) as string[]
    );
  };

  const findNextAvailableQuarter = (studentId: string, fromDate = new Date()) => {
    const used = submittedQuarterKeysForResident(studentId);
    let cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
    for (let i = 0; i < 40; i += 1) {
      const quarter = getCalendarQuarter(cursor);
      const year = String(cursor.getFullYear());
      if (!used.has(getQuarterKey(quarter, year))) return { quarter, year };
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 3, 1);
    }
    return { quarter: getCalendarQuarter(fromDate), year: String(fromDate.getFullYear()) };
  };

  const [quarterlyForm, setQuarterlyForm] = useState({
    studentId: '',
    quarter: getCalendarQuarter(),
    year: new Date().getFullYear().toString(),
    gradeLevel: '',
    result: '' as '' | 'Passed' | 'Failed',
    observationStatus: '',
    recommendations: '',
    preparedByName: '',
    preparedByTitle: 'SCH Teacher',
    preparedBySignature: '',
  });

  // Which learners an account may file a Quarterly Education Report for.
  //
  // An educator files for their own learners — the ones whose record they
  // created. A record with no `createdBy` is shown to everyone: the field
  // predates this rule, and hiding a learner from every educator would be worse
  // than showing one to the wrong educator. Center Head, Admin and the Social
  // Worker are not scoped and see the whole roll.
  const quarterlyLearnerPool = user?.role === 'educator'
    ? students.filter(s => !s.createdBy || s.createdBy === user?.username)
    : students;

  const openQuarterlyReport = () => {
    setQuarterlyError('');
    const firstStudent = quarterlyLearnerPool.find(s => s.status === 'Active');
    const next = firstStudent ? findNextAvailableQuarter(firstStudent.id) : { quarter: getCalendarQuarter(), year: String(new Date().getFullYear()) };
    setQuarterlyForm(prev => ({ ...prev, studentId: '', quarter: next.quarter, year: next.year }));
    setIsQuarterlyOpen(true);
  };

  const handleQuarterlyResidentChange = (studentId: string) => {
    const s = students.find(st => st.id === studentId);
    const next = findNextAvailableQuarter(studentId);
    setQuarterlyForm(prev => ({ ...prev, studentId, quarter: next.quarter, year: next.year, gradeLevel: s?.gradeSection || prev.gradeLevel }));
  };

  const handleSubmitQuarterly = async () => {
    setQuarterlyError('');
    const student = students.find(s => s.id === quarterlyForm.studentId);
    if (!student) { setQuarterlyError('Select a learner.'); return; }
    if (!quarterlyForm.observationStatus.trim()) { setQuarterlyError('Observation/Status is required.'); return; }
    if (!quarterlyForm.preparedByName.trim()) { setQuarterlyError('Prepared by (name) is required.'); return; }

    const resident = residents.find(c => c.id === student.residentId) || residents.find(c => c.name === student.name);
    if (!resident) {
      setQuarterlyError(`Couldn't match "${student.name}" to a resident record, so this can't be submitted for Center Head review. Check the learner's name matches their resident record exactly.`);
      return;
    }

    const submittedQuarterKey = getQuarterKey(quarterlyForm.quarter, quarterlyForm.year.trim());
    const submittedQuarterKeys = submittedQuarterKeysForResident(student.id);
    if (submittedQuarterKeys.has(submittedQuarterKey)) {
      setQuarterlyError(`A Quarterly Progress Report has already been submitted for ${quarterlyForm.quarter} ${quarterlyForm.year} for this resident. Please use the next available quarter.`);
      return;
    }
    if (!/^\d{4}$/.test(quarterlyForm.year.trim())) {
      setQuarterlyError('Enter a valid 4-digit report year.');
      return;
    }

    const periodLabel = QUARTER_PERIODS.find(p => p.value === quarterlyForm.quarter)?.label || quarterlyForm.quarter;
    const idLabel = student.educationLevel === 'Calamba Manpower Development Center (CMDC)'
      ? `Trainee Number: ${student.traineeNumber || '—'}`
      : `LRN: ${student.lrn || '—'}`;

    const narrative = [
      `REPORT QUARTER: ${quarterlyForm.quarter}`,
      `REPORT YEAR: ${quarterlyForm.year.trim()}`,
      'QUARTERLY PROGRESS REPORT EDUCATIONAL SERVICES',
      `${periodLabel.toUpperCase()} ${quarterlyForm.year.trim()}`,
      '',
      `NAME OF RESIDENT: ${student.name}`,
      `${idLabel}`,
      `GRADE LEVEL/SHS STRAND: ${quarterlyForm.gradeLevel || student.gradeSection || '—'}`,
      quarterlyForm.result ? `RESULT: ${quarterlyForm.result === 'Passed' ? 'Pass' : 'Fail'}` : '',
      '',
      `OBSERVATION/STATUS:\n${quarterlyForm.observationStatus}`,
      '',
      `RECOMMENDATION/S:\n${quarterlyForm.recommendations || '—'}`,
      '',
      `PREPARED BY:\n${quarterlyForm.preparedByName}\n${quarterlyForm.preparedByTitle}`,
    ].filter(Boolean).join('\n');

    setQuarterlySubmitting(true);
    try {
      const { dataUrl, size } = await generateQuarterlyReportPdf({
        titleLine1: 'QUARTERLY PROGRESS REPORT EDUCATIONAL SERVICES',
        titleLine2: `${periodLabel.toUpperCase()} ${quarterlyForm.year}`,
        nameOfResident: student.name,
        idLabel,
        gradeLevel: quarterlyForm.gradeLevel || student.gradeSection || '—',
        observationStatus: quarterlyForm.observationStatus,
        recommendations: quarterlyForm.recommendations || 'none',
        preparedByName: quarterlyForm.preparedByName,
        preparedByTitle: quarterlyForm.preparedByTitle,
        preparedBySignature: quarterlyForm.preparedBySignature,
      });
      const pdfFileName = `Quarterly_Report_${quarterlyForm.quarter}_${quarterlyForm.year}_${student.name.replace(/\s+/g, '_')}.pdf`;
      await addDocument({
        residentId: resident.id,
        residentName: resident.name,
        title: 'Quarterly Education Report',
        category: 'Education',
        phase: '',
        description: narrative,
        fileName: pdfFileName,
        fileType: 'application/pdf',
        fileSize: size,
        fileData: dataUrl,
        uploaderRole: user?.role || 'educator',
        uploadedBy: user?.username || quarterlyForm.preparedByName,
        uploadedAt: new Date().toISOString(),
        status: 'Submitted',
        submittedBy: user?.username || quarterlyForm.preparedByName,
        submittedAt: new Date().toISOString(),
        requiresAssessment: false,
        assessmentTriggered: false,
      } as any);
      const next = findNextAvailableQuarter(student.id, new Date(Number(quarterlyForm.year), quarterlyForm.quarter === 'Q1' ? 0 : quarterlyForm.quarter === 'Q2' ? 3 : quarterlyForm.quarter === 'Q3' ? 6 : 9, 1));
      setIsQuarterlyOpen(false);
      setQuarterlyForm({ studentId: '', quarter: next.quarter, year: next.year, gradeLevel: '', result: '', observationStatus: '', recommendations: '', preparedByName: '', preparedByTitle: 'SCH Teacher', preparedBySignature: '' });
    } catch (err) {
      setQuarterlyError(err instanceof Error ? err.message : 'Unable to submit the quarterly report.');
    } finally {
      setQuarterlySubmitting(false);
    }
  };

  // Stats
  const totalLearners = students.filter(s => s.status === 'Active').length;
  const totalVisits = visitReports.length; // each report = 1 visit


  const passCount = progressReports.filter(r => r.result === 'Passed').length;
  const failCount = progressReports.filter(r => r.result === 'Failed').length;

  const handleSaveProgress = () => {
    if (!progressStudent || !progressForm.subject.trim() || !progressForm.result) return;
    const rpt: ProgressReport = {
      id: progressEditing?.id || Date.now().toString(),
      studentId: progressStudent.id,
      month: progressForm.month,
      subject: progressForm.subject,
      result: progressForm.result,
      academicProgress: progressForm.academicProgress,
      participation: progressForm.participation,
      strengths: progressForm.strengths,
      areasForImprovement: progressForm.areasForImprovement,
      overallDevelopment: progressForm.overallDevelopment,
      schoolVisits: parseInt(progressForm.schoolVisits) || 0,
      createdAt: new Date().toISOString(),
    };
    const updated = progressEditing
      ? progressReports.map(report => report.id === progressEditing.id ? rpt : report)
      : [...progressReports, rpt];
    setProgressReports(updated);
    saveProgress(updated);
    void (async () => {
      try {
        const saved = progressEditing
          ? await updateResource<any>('education-progress-reports', progressEditing.id, { ...rpt, educationRecordId: rpt.studentId, residentId: progressStudent?.residentId })
          : await createResource<any>('education-progress-reports', { ...rpt, educationRecordId: rpt.studentId, residentId: progressStudent?.residentId });
        setProgressReports(prev => prev.map(r => r.id === rpt.id ? { ...r, id: saved.id } : r));
      } catch (error) {
        console.error('Unable to persist education progress report:', error);
      }
    })();
    setIsProgressOpen(false);
    setProgressEditing(null);
    setProgressStudent(null);
    setProgressForm({ subject: '', result: '', academicProgress: '', participation: '', strengths: '', areasForImprovement: '', overallDevelopment: '', schoolVisits: '0', month: new Date().toISOString().substring(0, 7) });
  };

  const editProgressReport = (report: ProgressReport) => {
    setProgressEditing(report);
    setProgressStudent(students.find(student => student.id === report.studentId) || null);
    setProgressForm({
      subject: report.subject,
      result: report.result,
      academicProgress: report.academicProgress,
      participation: report.participation,
      strengths: report.strengths,
      areasForImprovement: report.areasForImprovement,
      overallDevelopment: report.overallDevelopment,
      schoolVisits: String(report.schoolVisits),
      month: report.month,
    });
    setIsProgressOpen(true);
  };

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
      lrn: s.lrn, traineeNumber: s.traineeNumber,
    });
    setFormError('');
    setIsStudentDialogOpen(true);
  };

  const handleSaveStudent = async () => {
    setFormError('');
    if (!studentForm.name.trim()) { setFormError('Name is required.'); return; }

    // A resident who is not enrolled in school has no school and no enrolment
    // date to give. Requiring them made the level unreachable: the educator had
    // to invent a placement before the record could be saved at all, and what
    // they typed was indistinguishable from a real one afterwards.
    if (!isNotEnrolled(studentForm.educationLevel)) {
      if (!studentForm.school.trim()) { setFormError('School is required.'); return; }
      if (!studentForm.enrollmentDate) { setFormError('Enrollment date is required.'); return; }
    }

    // An empty date must go as NULL, not '', which MySQL refuses for a DATE
    // column under the default strict sql_mode.
    const fields = {
      ...studentForm,
      school: studentForm.school.trim() || null,
      enrollmentDate: studentForm.enrollmentDate || null,
    };

    const resident = residents.find(c => c.name.trim().toLowerCase() === studentForm.name.trim().toLowerCase());
    try {
      if (editingStudent) {
        const saved = await updateResource<EducationRecordWire>('education-records', editingStudent.id, { ...fields, residentId: editingStudent.residentId || resident?.id });
        persist(students.map(s => s.id === editingStudent.id ? normalizeStudent(saved) : s));
      } else {
        const saved = await createResource<EducationRecordWire>('education-records', { ...fields, residentId: resident?.id, files: [] } as any);
        persist([...students, normalizeStudent(saved)]);
      }
      setIsStudentDialogOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to save education record to the database.');
    }
  };

  // ── FILE UPLOAD ───────────────────────────────────────────────────────────
  const openUpload = (s: Student, defaultCategory: EducationFile['category'] = 'Performance') => {
    setUploadTarget(s);
    setUploadCategory(defaultCategory);
    setUploadError('');
    setPendingFile(null);
    setIsUploadOpen(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setPendingFile(file);
  };

  const [uploadingToDocs, setUploadingToDocs] = useState(false);
  const [uploadDocsWarning, setUploadDocsWarning] = useState('');


  const handleUploadConfirm = () => {
    if (!pendingFile || !uploadTarget) { setUploadError('Please select a file.'); return; }
    setUploadDocsWarning('');
    const reader = new FileReader();
    reader.onloadend = async () => {
      const fileData = reader.result as string;
      const newFile: EducationFile = {
        id: `EF${Date.now()}`,
        name: pendingFile.name,
        type: pendingFile.type,
        size: pendingFile.size,
        uploadDate: new Date().toISOString().split('T')[0],
        category: uploadCategory,
        dataUrl: fileData,
      };
      const updated = students.map(s =>
        s.id === uploadTarget.id
          ? { ...s, files: [...s.files, newFile] }
          : s
      );
      persist(updated);
      void updateResource<Student>('education-records', uploadTarget.id, { files: updated.find(s => s.id === uploadTarget.id)?.files || [] })
        .then(saved => setStudents(prev => prev.map(s => s.id === saved.id ? normalizeStudent(saved) : s)))
        .catch(error => console.error('Unable to persist education file:', error));
      // also update viewStudent if open
      if (viewStudent?.id === uploadTarget.id) {
        setViewStudent(updated.find(s => s.id === uploadTarget.id) || null);
      }
      setIsUploadOpen(false);

      // Every education upload must also land in the Document Module, inside
      // the correct child's folder — not just kept locally in this module.
      const resident = residents.find(c => c.id === uploadTarget.residentId) || residents.find(c => c.name === uploadTarget.name);
      if (resident) {
        setUploadingToDocs(true);
        try {
          await addDocument({
            residentId: resident.id,
            residentName: resident.name,
            title: `Education — ${uploadCategory}`,
            category: 'Education',
            phase: '',
            description: `${uploadCategory} uploaded via Education Module for ${uploadTarget.name}.`,
            fileName: pendingFile.name,
            fileType: pendingFile.type,
            fileSize: pendingFile.size,
            fileData,
            uploaderRole: user?.role || 'educator',
            uploadedBy: user?.username || 'Educator',
            uploadedAt: new Date().toISOString(),
            status: 'Submitted',
            submittedBy: user?.username || 'Educator',
            submittedAt: new Date().toISOString(),
            requiresAssessment: false,
            assessmentTriggered: false,
          } as any);
        } catch {
          setUploadDocsWarning(`"${pendingFile.name}" saved in Education, but couldn't be copied to the Document Module.`);
        } finally {
          setUploadingToDocs(false);
        }
      } else {
        setUploadDocsWarning(`"${pendingFile.name}" saved in Education, but "${uploadTarget.name}" doesn't match a resident record — it won't appear in the Document Module until the name matches.`);
      }
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
    void updateResource<Student>('education-records', student.id, { files: updated.find(s => s.id === student.id)?.files || [] })
      .then(saved => setStudents(prev => prev.map(s => s.id === saved.id ? normalizeStudent(saved) : s)))
      .catch(error => console.error('Unable to persist education file deletion:', error));
    if (viewStudent?.id === student.id) {
      setViewStudent(updated.find(s => s.id === student.id) || null);
    }
  };

  // ── DELETE STUDENT ────────────────────────────────────────────────────────
  const handleDelete = () => {
    if (!deleteTarget || deleteConfirm !== deleteTarget.name) return;
    persist(students.filter(s => s.id !== deleteTarget.id));
    void deleteResource('education-records', deleteTarget.id).catch(error => console.error('Unable to delete education record:', error));
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

  // MySQL is the source of truth for Education. localStorage is retained only
  // as a temporary offline fallback for existing browser data.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [recordResult, progressResult, visitResult] = await Promise.all([
          request<{ success: boolean; data: Student[] }>('/education-records'),
          request<{ success: boolean; data: ProgressReport[] }>('/education-progress-reports'),
          request<{ success: boolean; data: SchoolVisitReport[] }>('/education-school-visits'),
        ]);
        if (cancelled) return;
        let records = (Array.isArray(recordResult.data) ? recordResult.data : []).map(normalizeStudent);
        let progress = Array.isArray(progressResult.data) ? progressResult.data.map((r: any) => ({ ...r, studentId: r.educationRecordId || r.studentId })) : [];
        let visits = Array.isArray(visitResult.data) ? visitResult.data.map((r: any) => ({ ...r, studentId: r.educationRecordId || r.studentId })) : [];

        // One-time migration for users who already had Education data in the
        // browser before the database-backed module was introduced.
        if (records.length === 0 && students.length > 0) {
          const idMap = new Map<string, string>();
          const migrated: Student[] = [];
          for (const cached of students) {
            const saved = await createResource<Student>('education-records', {
              ...cached,
              id: undefined,
              residentId: cached.residentId || residents.find(c => c.name.trim().toLowerCase() === cached.name.trim().toLowerCase())?.id,
            } as any);
            idMap.set(cached.id, saved.id);
            migrated.push(saved);
          }
          for (const report of progress) {
            const educationRecordId = idMap.get(report.studentId) || report.studentId;
            if (!idMap.has(report.studentId)) continue;
            await createResource<any>('education-progress-reports', {
              ...report, id: undefined, educationRecordId,
              residentId: migrated.find(s => s.id === educationRecordId)?.residentId,
            });
          }
          for (const visit of visits) {
            const educationRecordId = idMap.get(visit.studentId) || visit.studentId;
            if (!idMap.has(visit.studentId)) continue;
            await createResource<any>('education-school-visits', {
              ...visit, id: undefined, educationRecordId,
              residentId: migrated.find(s => s.id === educationRecordId)?.residentId,
            });
          }
          records = migrated;
          const progressResult2 = await request<{ success: boolean; data: ProgressReport[] }>('/education-progress-reports');
          const visitResult2 = await request<{ success: boolean; data: SchoolVisitReport[] }>('/education-school-visits');
          progress = Array.isArray(progressResult2.data) ? progressResult2.data.map((r: any) => ({ ...r, studentId: r.educationRecordId || r.studentId })) : [];
          visits = Array.isArray(visitResult2.data) ? visitResult2.data.map((r: any) => ({ ...r, studentId: r.educationRecordId || r.studentId })) : [];
        }

        setStudents(records);
        setProgressReports(progress);
        setVisitReports(visits);
        saveStudents(records);
        saveProgress(progress);
        saveVisits(visits);
      } catch (error) {
        console.warn('Education database load failed; using local cached records.', error);
      }
    })();
    return () => { cancelled = true; };
  }, []);


  // Grouped by level for category view
  const grouped = EDUCATION_LEVELS.reduce<Record<EducationLevel, Student[]>>((acc, lvl) => {
    acc[lvl] = filtered.filter(s => s.educationLevel === lvl);
    return acc;
  }, {} as Record<EducationLevel, Student[]>);

  // ── RENDER ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* Quarterly reporting starts here as well as in Reports: Education is one
          of the programs the consolidated quarterly report reads. */}
      <ProgramQuarterlyReports />

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
          <div className="bg-white/10 rounded-xl p-3 border border-white/10">
            <p className="text-[10px] font-bold text-gray-300 uppercase tracking-wider">Total Learners</p>
            <p className="text-2xl font-black text-white mt-0.5">{totalLearners}</p>
            <p className="text-[10px] text-gray-400">Active students</p>
          </div>
          <div className="bg-white/10 rounded-xl p-3 border border-white/10">
            <p className="text-[10px] font-bold text-gray-300 uppercase tracking-wider">School Visits</p>
            <p className="text-2xl font-black text-white mt-0.5">{totalVisits}</p>
            <p className="text-[10px] text-gray-400">Total conducted</p>
          </div>
          <div className="bg-white/10 rounded-xl p-3 border border-white/10">
            <p className="text-[10px] font-bold text-[#4ade80] uppercase tracking-wider">Passed</p>
            <p className="text-2xl font-black text-white mt-0.5">{passCount}</p>
            <p className="text-[10px] text-gray-400">Passed evaluations</p>
          </div>
          <div className="bg-white/10 rounded-xl p-3 border border-white/10">
            <p className="text-[10px] font-bold text-[#f87171] uppercase tracking-wider">Failed</p>
            <p className="text-2xl font-black text-white mt-0.5">{failCount}</p>
            <p className="text-[10px] text-gray-400">Failed evaluations</p>
          </div>
        </div>
        <div className="flex gap-2 mt-4 flex-wrap">
          <button
            onClick={openQuarterlyReport}
            className="px-4 py-2 rounded-xl text-xs font-bold bg-white text-[#2F3E46] border border-white hover:bg-gray-100 transition-all">
            Quarterly Report
          </button>
        </div>
      </div>

      {/* Toolbar */}
      {uploadDocsWarning && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs px-4 py-2 rounded-lg flex items-center justify-between">
          <span>{uploadDocsWarning}</span>
          <button onClick={() => setUploadDocsWarning('')} className="font-bold ml-3">✕</button>
        </div>
      )}
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
        <TabsList className="mb-2 w-full flex">
          <TabsTrigger value="masterlist" className="flex-1">Student Master List ({students.length})</TabsTrigger>
          <TabsTrigger value="visits" className="flex-1">School Visits</TabsTrigger>
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

        {/* ── SCHOOL VISIT REPORTS TAB ── */}
        <TabsContent value="visits" className="space-y-4">
          <div className="flex justify-between items-center gap-3 flex-wrap">
            <div>
              <h3 className="font-bold text-[#2F3E46]">School Visit Reports</h3>
              <p className="text-xs text-gray-400 mt-0.5">Each completed visit = 1 school visit counted</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  // A scheduled visit is a plan: no report yet, so clear any file
                  // left over from a previous upload.
                  setPendingVisitFile(null);
                  setVisitForm(p => ({ ...p, status: 'Scheduled' }));
                  setIsVisitUploadOpen(true);
                }}
              >
                <CalendarDays className="w-4 h-4 mr-1" /> Schedule a Visit
              </Button>
              <Button
                className="bg-[#2F3E46] text-white"
                onClick={() => {
                  setVisitForm(p => ({ ...p, status: 'Completed' }));
                  setIsVisitUploadOpen(true);
                }}
              >
                <Plus className="w-4 h-4 mr-1" /> Upload Visit Report
              </Button>
            </div>
          </div>

          {/* Per-student visit count */}
          {students.filter(s => s.status === 'Active').length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {students.filter(s => s.status === 'Active').map(s => {
                const count = visitReports.filter(v => v.studentId === s.id && (v.status ?? 'Completed') === 'Completed').length;
                return (
                  <div key={s.id} className="p-3 border border-gray-200 rounded-xl bg-white flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-[#2F3E46] text-white flex items-center justify-center font-bold text-sm shrink-0">
                      {s.name.charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-[#2F3E46] truncate">{s.name}</p>
                      <p className="text-[10px] text-gray-400">{count} school visit{count !== 1 ? 's' : ''} recorded</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {visitReports.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <FileText className="w-10 h-10 mx-auto mb-2 opacity-30" />
              <p>No school visit reports uploaded yet.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Copy before sorting: .sort() mutates in place, and this array is state. */}
              {[...visitReports].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(r => {
                const student = students.find(s => s.id === r.studentId);
                const isScheduled = (r.status ?? 'Completed') === 'Scheduled';
                return (
                  <div key={r.id} className="border border-gray-200 rounded-xl p-3 bg-white flex items-start gap-3">
                    <div className={"w-8 h-8 rounded-lg flex items-center justify-center shrink-0 " + (isScheduled ? 'bg-amber-100' : 'bg-blue-100')}>
                      {isScheduled
                        ? <CalendarDays className="w-4 h-4 text-amber-600" />
                        : <FileText className="w-4 h-4 text-blue-600" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-[#2F3E46]">{student?.name || '—'}</p>
                        <span className="text-[10px] text-gray-400">{r.visitDate}</span>
                        <span className={"text-[10px] font-bold px-2 py-0.5 rounded-full " + (isScheduled ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700')}>
                          {isScheduled ? 'Scheduled' : 'Completed'}
                        </span>
                      </div>
                      <p className="text-xs text-gray-600">{r.school}{r.purpose ? ` — ${r.purpose}` : ''}</p>
                      {r.findings && <p className="text-xs text-gray-400 italic mt-0.5">{r.findings}</p>}
                      {r.fileName && (
                        <p className="text-[10px] text-blue-600 mt-1 flex items-center gap-1">
                          <Paperclip className="w-3 h-3" /> {r.fileName}
                        </p>
                      )}
                    </div>
                    {isScheduled && (
                      <Button variant="outline" className="shrink-0" onClick={() => void markVisitCompleted(r)}>
                        <CheckCircle2 className="w-4 h-4 mr-1" /> Mark Completed
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
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
                <Label className="font-bold text-[#2F3E46]">Resident / Learner *</Label>
                <Select value={studentForm.name} onValueChange={v => {
                  const res = residents.find(r => r.name === v);
                  // Pull the rest of the learner's details off the resident
                  // record rather than making the Educator retype what the
                  // system already holds. `children` carries all three.
                  setStudentForm(p => ({
                    ...p,
                    name: v,
                    gender: (res?.gender as 'Male' | 'Female') || 'Male',
                    age: res?.age || p.age,
                    address: res?.address || p.address,
                    guardianName: res?.guardianName || p.guardianName,
                    guardianContact: res?.guardianContact || p.guardianContact,
                  }));
                }}>
                  <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select resident..." /></SelectTrigger>
                  <SelectContent>
                    {residents.filter(r => r.status !== 'Discharged').map(r => (
                      <SelectItem key={r.id} value={r.name}>{r.name} ({r.id})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Age *</Label>
                <Input type="number" min={1} max={30} value={studentForm.age || ''} onChange={e => setStudentForm(p => ({ ...p, age: Number(e.target.value) }))} className="rounded-xl" />
              </div>
              <div className="space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Gender</Label>
                <div className="rounded-xl border bg-gray-50 px-3 py-2 text-sm text-[#2F3E46] font-semibold">{studentForm.gender || 'Male'}</div>
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Educational Level *</Label>
                <Select value={studentForm.educationLevel} onValueChange={v => setStudentForm(p => ({ ...p, educationLevel: v as EducationLevel }))}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EDUCATION_LEVELS.map(l => <SelectItem key={l} value={l}>{levelLabel(l)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Grade / Section</Label>
                <Input value={studentForm.gradeSection} onChange={e => setStudentForm(p => ({ ...p, gradeSection: e.target.value }))} placeholder="e.g. Grade 9 - Amity" className="rounded-xl" />
              </div>
              <div className="space-y-1.5">
                {studentForm.educationLevel === 'Calamba Manpower Development Center (CMDC)' ? (
                  <>
                    <Label className="font-bold text-[#2F3E46]">Trainee Number</Label>
                    <Input value={studentForm.traineeNumber} onChange={e => setStudentForm(p => ({ ...p, traineeNumber: e.target.value }))} placeholder="CMDC Trainee Number" className="rounded-xl" />
                  </>
                ) : (
                  <>
                    <Label className="font-bold text-[#2F3E46]">LRN (Learner Reference Number)</Label>
                    <Input value={studentForm.lrn} onChange={e => setStudentForm(p => ({ ...p, lrn: e.target.value }))} placeholder="12-digit LRN" className="rounded-xl" />
                  </>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Status</Label>
                <Select value={studentForm.status} onValueChange={v => setStudentForm(p => ({ ...p, status: v as Student['status'] }))}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Active">Active</SelectItem>
                    <SelectItem value="Completed">Completed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">
                  {isNotEnrolled(studentForm.educationLevel)
                    ? 'School / Institution'
                    : 'School / Institution *'}
                </Label>
                <Input value={studentForm.school} onChange={e => setStudentForm(p => ({ ...p, school: e.target.value }))} placeholder={isNotEnrolled(studentForm.educationLevel) ? 'Not enrolled — leave blank' : 'School name'} className="rounded-xl" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">
                  {isNotEnrolled(studentForm.educationLevel)
                    ? 'Enrollment Date'
                    : 'Enrollment Date *'}
                </Label>
                <Input type="date" value={studentForm.enrollmentDate} onChange={e => setStudentForm(p => ({ ...p, enrollmentDate: e.target.value }))} className="rounded-xl" />
                {isNotEnrolled(studentForm.educationLevel) && (
                  <p className="text-xs text-gray-500">
                    Not enrolled in school — this record covers Academic Support Sessions / Tutorial.
                  </p>
                )}
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
                        <span className="text-xs font-medium" style={{ color: c.text }}>{levelLabel(viewStudent.educationLevel)}</span>
                        <span className="text-xs text-gray-500">· {viewStudent.id}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-6">
                  <Tabs value={profileTab} onValueChange={setProfileTab}>
                    <TabsList className="mb-4">
                      <TabsTrigger value="info">Personal Info</TabsTrigger>
                      <TabsTrigger value="evaluation">Passed / Failed</TabsTrigger>
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
                          [
                            viewStudent.educationLevel === 'Calamba Manpower Development Center (CMDC)' ? 'Trainee Number' : 'LRN',
                            (viewStudent.educationLevel === 'Calamba Manpower Development Center (CMDC)' ? viewStudent.traineeNumber : viewStudent.lrn) || '—',
                          ],
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

                    <TabsContent value="evaluation" className="space-y-4 py-2">
                      <p className="text-sm text-gray-600 font-semibold">Evaluate educational progress for <strong>{viewStudent.name}</strong>:</p>
                      <div className="flex gap-3">
                        {(['Passed', 'Failed'] as const).map(result => (
                          <button key={result} onClick={() => {
                            const rpt: ProgressReport = {
                              id: Date.now().toString(),
                              studentId: viewStudent.id,
                              month: new Date().toISOString().substring(0, 7),
                              subject: 'General Evaluation',
                              result,
                              academicProgress: '',
                              participation: '',
                              strengths: '',
                              areasForImprovement: '',
                              overallDevelopment: `Marked ${result === 'Passed' ? 'Pass' : 'Fail'} by Educator on ${new Date().toLocaleDateString()}`,
                              schoolVisits: 0,
                              createdAt: new Date().toISOString(),
                            };
                            const updated = [...progressReports, rpt];
                            setProgressReports(updated);
                            saveProgress(updated);
                            void createResource<any>('education-progress-reports', {
                              ...rpt,
                              educationRecordId: viewStudent.id,
                              residentId: viewStudent.residentId,
                            }).then(saved => {
                              setProgressReports(prev => prev.map(r => r.id === rpt.id ? { ...r, id: saved.id } : r));
                            }).catch(error => {
                              console.error('Unable to persist education evaluation:', error);
                            });
                          }}
                          className={`flex-1 py-4 rounded-xl border-2 text-lg font-black transition-all ${
                            result === 'Passed'
                              ? 'border-green-500 bg-green-50 text-green-700 hover:bg-green-100'
                              : 'border-red-500 bg-red-50 text-red-700 hover:bg-red-100'
                          }`}>
                            {result === 'Passed' ? '✓ Passed' : '✕ Failed'}
                          </button>
                        ))}
                      </div>
                      <div className="border-t pt-3">
                        <p className="text-xs font-bold text-gray-500 uppercase mb-2">Evaluation History</p>
                        {progressReports.filter(r => r.studentId === viewStudent.id).length === 0
                          ? <p className="text-xs text-gray-400 italic">No evaluations yet.</p>
                          : progressReports.filter(r => r.studentId === viewStudent.id).map(r => (
                            <div key={r.id} className="flex items-center gap-2 py-1.5 border-b border-gray-50 text-xs">
                              <span className="text-gray-600 flex-1">{r.subject} — {r.month}</span>
                              <span className={`font-bold px-2 py-0.5 rounded-full ${r.result === 'Passed' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{r.result}</span>
                              <button type="button" className="text-[#2F3E46] hover:text-blue-600 font-semibold" onClick={() => editProgressReport(r)}>Edit</button>
                            </div>
                          ))
                        }
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
                  <SelectItem value="Monthly Report">Monthly Report</SelectItem>
                  <SelectItem value="Progress Report">Progress Report</SelectItem>
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

      {/* ── EDIT PASS/FAIL RESULT DIALOG ── */}
      <Dialog open={isProgressOpen} onOpenChange={setIsProgressOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46]">Edit Result</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-sm font-bold">Learner *</Label>
              <Select value={progressStudent?.id || ''} onValueChange={id => setProgressStudent(students.find(s => s.id === id) || null)}>
                <SelectTrigger><SelectValue placeholder="Select learner..." /></SelectTrigger>
                <SelectContent>
                  {students.filter(s => s.status === 'Active').map(s => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-bold">Subject / Area *</Label>
              <Input value={progressForm.subject} onChange={e => setProgressForm({...progressForm, subject: e.target.value})} placeholder="e.g. Mathematics, Science, ALS Module..." />
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-bold">Result *</Label>
              <div className="flex gap-2 mt-1">
                {(['Passed', 'Failed'] as const).map(r => (
                  <button key={r} onClick={() => setProgressForm({...progressForm, result: r})}
                    className={`flex-1 py-2 rounded-xl border-2 text-sm font-bold transition-all ${
                      progressForm.result === r
                        ? r === 'Passed' ? 'border-green-500 bg-green-50 text-green-700' : 'border-red-500 bg-red-50 text-red-700'
                        : 'border-gray-200 text-gray-400 hover:border-gray-300'
                    }`}>{r === 'Passed' ? 'Pass' : 'Fail'}</button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsProgressOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveProgress} disabled={!progressStudent || !progressForm.subject.trim() || !progressForm.result} className="bg-[#2F3E46] text-white">
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── QUARTERLY REPORT DIALOG — digitized from the official template, submitted to Center Head for review ── */}
      <Dialog open={isQuarterlyOpen} onOpenChange={setIsQuarterlyOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46] text-center uppercase tracking-wide">Quarterly Progress Report<br />Educational Services</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {quarterlyError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded-lg">{quarterlyError}</div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-sm font-bold">Quarter *</Label>
                <Select value={quarterlyForm.quarter} onValueChange={v => setQuarterlyForm({ ...quarterlyForm, quarter: v as any })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {QUARTER_PERIODS.map(q => {
                      const used = quarterlyForm.studentId ? submittedQuarterKeysForResident(quarterlyForm.studentId).has(getQuarterKey(q.value, quarterlyForm.year)) : false;
                      return <SelectItem key={q.value} value={q.value} disabled={used}>{q.label}{used ? ' — Already submitted' : ''}</SelectItem>;
                    })}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-bold">Year *</Label>
                <Input value={quarterlyForm.year} onChange={e => setQuarterlyForm({ ...quarterlyForm, year: e.target.value })} placeholder="2026" />
              </div>
            </div>
            <p className="text-center text-xs font-bold text-gray-400 uppercase tracking-wide -mt-1">
              {QUARTER_PERIODS.find(p => p.value === quarterlyForm.quarter)?.label} {quarterlyForm.year}
            </p>

            <div className="space-y-1">
              <Label className="text-sm font-bold">Name of Resident *</Label>
              <Select
                value={quarterlyForm.studentId}
                onValueChange={handleQuarterlyResidentChange}
              >
                <SelectTrigger><SelectValue placeholder="Select learner..." /></SelectTrigger>
                <SelectContent>
                  {quarterlyLearnerPool.filter(s => s.status === 'Active').map(s => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                  {quarterlyLearnerPool.filter(s => s.status === 'Active').length === 0 && (
                    <div className="px-3 py-2 text-xs text-gray-500">No active learners are assigned to you.</div>
                  )}
                </SelectContent>
              </Select>
              {quarterlyForm.studentId && (() => {
                const s = students.find(st => st.id === quarterlyForm.studentId);
                if (!s) return null;
                return (
                  <p className="text-xs text-gray-400">
                    {s.educationLevel === 'Calamba Manpower Development Center (CMDC)' ? `Trainee Number: ${s.traineeNumber || '—'}` : `LRN: ${s.lrn || '—'}`}
                  </p>
                );
              })()}
            </div>

            <div className="space-y-1">
              <Label className="text-sm font-bold">Grade Level / SHS Strand *</Label>
              <Input value={quarterlyForm.gradeLevel} onChange={e => setQuarterlyForm({ ...quarterlyForm, gradeLevel: e.target.value })} placeholder="e.g. Enrolled in ALS Junior High School" />
            </div>

            <div className="space-y-1">
              <Label className="text-sm font-bold">Result</Label>
              <div className="flex gap-2 mt-1">
                {(['Passed', 'Failed'] as const).map(r => (
                  <button key={r} onClick={() => setQuarterlyForm({ ...quarterlyForm, result: r })}
                    className={`flex-1 py-2 rounded-xl border-2 text-sm font-bold transition-all ${
                      quarterlyForm.result === r
                        ? r === 'Passed' ? 'border-green-500 bg-green-50 text-green-700' : 'border-red-500 bg-red-50 text-red-700'
                        : 'border-gray-200 text-gray-400 hover:border-gray-300'
                    }`}>{r === 'Passed' ? 'Pass' : 'Fail'}</button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-sm font-bold">Observation / Status *</Label>
              <Textarea value={quarterlyForm.observationStatus} onChange={e => setQuarterlyForm({ ...quarterlyForm, observationStatus: e.target.value })} placeholder="Narrative observation of the resident's academic progress, participation, strengths, and areas for improvement this quarter..." rows={5} />
            </div>

            <div className="space-y-1">
              <Label className="text-sm font-bold">Recommendation/s</Label>
              <Textarea value={quarterlyForm.recommendations} onChange={e => setQuarterlyForm({ ...quarterlyForm, recommendations: e.target.value })} rows={3} />
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2 border-t">
              <div className="space-y-1">
                <Label className="text-sm font-bold">Prepared By *</Label>
                <Input value={quarterlyForm.preparedByName} onChange={e => setQuarterlyForm({ ...quarterlyForm, preparedByName: e.target.value })} placeholder="e.g. Mary Peth Lingo, LPT" />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-bold">Title</Label>
                <Input value={quarterlyForm.preparedByTitle} onChange={e => setQuarterlyForm({ ...quarterlyForm, preparedByTitle: e.target.value })} placeholder="SCH Teacher" />
              </div>
            </div>

            <div className="space-y-1 pt-2 border-t">
              <Label className="text-sm font-bold">Signature</Label>
              <p className="text-xs text-gray-500">
                Tap the box to open a full-size signing canvas. The signature is printed
                on the generated report, directly above the name.
              </p>
              <div className="h-24 w-full max-w-[440px]">
                <SignaturePadModal
                  label="Prepared by signature"
                  value={quarterlyForm.preparedBySignature}
                  onChange={(value) => setQuarterlyForm({ ...quarterlyForm, preparedBySignature: value })}
                  hint="Tap to sign"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsQuarterlyOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmitQuarterly} disabled={quarterlySubmitting} className="bg-[#2F3E46] text-white">
              {quarterlySubmitting ? 'Submitting...' : 'Submit to Center Head'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── SCHOOL VISIT UPLOAD DIALOG ── */}
      <Dialog open={isVisitUploadOpen} onOpenChange={setIsVisitUploadOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46]">
              {visitForm.status === 'Scheduled' ? 'Schedule a School Visit' : 'Upload School Visit Report'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-sm font-bold">Resident / Learner *</Label>
              <Select value={visitForm.studentId} onValueChange={v => setVisitForm(p => ({...p, studentId: v}))}>
                <SelectTrigger><SelectValue placeholder="Select learner..." /></SelectTrigger>
                <SelectContent>
                  {students.filter(s => s.status === 'Active').map(s => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-sm font-bold">Visit Date *</Label>
                <Input type="date" value={visitForm.visitDate} onChange={e => setVisitForm(p => ({...p, visitDate: e.target.value}))} />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-bold">School *</Label>
                <Input value={visitForm.school} onChange={e => setVisitForm(p => ({...p, school: e.target.value}))} placeholder="School name" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-bold">Purpose of Visit</Label>
              <Input value={visitForm.purpose} onChange={e => setVisitForm(p => ({...p, purpose: e.target.value}))} placeholder="e.g. Academic monitoring, enrollment..." />
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-bold">Findings / Notes</Label>
              <Textarea value={visitForm.findings} onChange={e => setVisitForm(p => ({...p, findings: e.target.value}))} rows={2} placeholder="Summary of visit findings..." />
            </div>
            {visitForm.status === 'Completed' ? (
              <div className="space-y-1">
                <Label className="text-sm font-bold">Attach Report File (optional)</Label>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => visitFileRef.current?.click()}>
                    <Upload className="w-4 h-4 mr-1" /> Choose File
                  </Button>
                  {pendingVisitFile && <span className="text-xs text-gray-500 truncate">{pendingVisitFile.name}</span>}
                </div>
                <input ref={visitFileRef} type="file" className="hidden"
                  onChange={e => setPendingVisitFile(e.target.files?.[0] || null)} />
                <p className="text-[10px] text-gray-400">File will also be saved to the resident's Documents folder.</p>
              </div>
            ) : (
              // A scheduled visit is a plan, so there is no report to attach yet
              // and nothing is filed in Documents until it is marked completed.
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                This records a planned visit. It is not counted as a school visit, and nothing is filed in the
                resident's Documents until you mark it Completed.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsVisitUploadOpen(false); setPendingVisitFile(null); }}>Cancel</Button>
            <Button onClick={handleSaveVisit} disabled={!visitForm.studentId || !visitForm.school} className="bg-[#2F3E46] text-white">
              {visitForm.status === 'Scheduled' ? 'Schedule Visit' : 'Save Visit Report'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
          {(student.educationLevel === 'Calamba Manpower Development Center (CMDC)' ? student.traineeNumber : student.lrn) && (
            <p>
              <span className="font-semibold text-gray-600">{student.educationLevel === 'Calamba Manpower Development Center (CMDC)' ? 'Trainee #:' : 'LRN:'}</span>{' '}
              {student.educationLevel === 'Calamba Manpower Development Center (CMDC)' ? student.traineeNumber : student.lrn}
            </p>
          )}
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
