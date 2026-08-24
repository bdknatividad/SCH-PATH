import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { createResource, deleteResource, getStore, updateResource, request } from '@/services/api';

// === TYPES ===

export interface BehavioralLog {
  id: string;
  date: string;
  type: string;
  severity: 'Low' | 'Medium' | 'High' | 'Minor' | 'Major' | 'Critical';
  points: number;
}

export interface MedicalRecord {
  id: string;
  name: string;
  category: string;
  dateUploaded: string;
  fileData?: string;
  fileName?: string;
}

export interface Document {
  id: string;
  title: string;
  type: string;
  uploadDate: string;
  fileName: string;
  fileSize: number;
  note?: string;
}

export interface PreviousCase {
  offense: string;
  date: string;
  facility: string;
}

export interface Child {
  id: string;
  name: string;
  age: number;
  gender: 'Male' | 'Female';
  admissionDate: string;
  legalCategory: string;
  caseType: string;
  status: 'Active' | 'Discharged';
  casePhase: string;
  isRepeatOffender: boolean;
  previousCaseDetails?: string;
  previousCases?: PreviousCase[];
  birthDate?: string;
  address?: string;
  documentsComplete: boolean;
  documents?: Document[];
  medicalRecords?: MedicalRecord[]; 
  lastCheckup?: string; 
  notes?: string;
  behaviorNotes?: string;
  guardianName?: string;
  guardianContact?: string;
  behavioralLogs: BehavioralLog[];
  assessments?: any[];
  phaseTasksCompleted?: Record<string, string[]>;
  readmissionDate?: string;
  readmissionDatetime?: string; // Full ISO datetime of re-admission — precise cutoff for doc splitting // { [phaseName]: [completedTask, ...] }
  needsPsychAssessment?: boolean;
}

export interface Staff {
  id: string;
  name: string;
  position: string;
  department: string;
  email: string;
  phone: string;
  status: 'Active' | 'Inactive';
  joinDate: string;
  endDate?: string;
  documents: Document[];
}

export interface Activity {
  id: string;
  title: string;
  date: string;
  time: string;
  type: string;
  category?: string;
  location?: string;
  status: 'Upcoming' | 'Completed';
  description?: string;
  notes?: string;
  personInCharge: string[];
  facilitators?: string[];
  participants?: string[];
  selectedResidentIds: string[];
  recommendedResidentIds?: string[];    // Children recommended for this activity (from violations)
  notRecommendedResidentIds?: string[]; // Children restricted by Psychologist
  notRecommendedReasons?: Record<string, string>; // childId → reason
  violationIds?: string[];              // Violation IDs that triggered recommendations
}

export interface Assessment {
  id: string;
  title: string;
  date: string;
  time: string;
  type: string;
  /** Name of the assessor / staff in-charge */
  assessor: string;
  status: 'Scheduled' | 'Completed';
  /** Array of child IDs assigned to this assessment */
  forResidents: string[];
  description?: string;
  results?: string;
  /** Set when the assessment was auto-triggered by a behavioral violation */
  triggeredBy?: string;
}

export interface Report {
  id: string;
  title: string;
  type: 'daily' | 'weekly' | 'staff' | 'discharge' | 'monthly';
  date: string;
  generatedBy: string;
  status: 'generated' | 'downloading';
}

export interface Violation {
  id: string;
  residentId: string;
  date: string;
  type: string;
  description?: string;
  severity: 'Minor' | 'Major' | 'Critical';
  points: number;
  location?: string;
  witnesses?: string;
  reportedBy?: string;
  reviewedBy?: string;
  actionTaken?: string;
  status: 'Pending Review' | 'Under Investigation' | 'Reviewed' | 'Resolved' | 'Escalated';
  requiresAssessment: boolean;
  assessmentTriggered: boolean;
  autoCreatedAssessment?: Assessment;
  autoCreatedAlerts?: Alert[];
}

export interface Alert {
  id: string;
  residentId?: string;
  type: string;
  title: string;
  message: string;
  priority: 'Low' | 'Medium' | 'High' | 'Urgent';
  isRead: boolean;
  readBy?: string;
  readAt?: string;
  actionRequired?: string;
  actionTaken?: string;
  relatedRecordType?: string;
  relatedRecordId?: string;
  targetRole?: string;
  createdAt?: string;
}

export interface CourtRecord {
  id: string;
  residentId: string;
  caseNumber?: string;
  courtName?: string;
  judge?: string;
  prosecutor?: string;
  publicAttorney?: string;
  hearingType?: string;
  hearingDate: string;
  hearingTime?: string;
  courtOrder?: string;
  nextHearingDate?: string;
  status: 'Scheduled' | 'Completed' | 'Postponed' | 'Cancelled';
  notes?: string;
  createdBy?: string;
}

export interface PhaseProgress {
  id: string;
  residentId: string;
  phaseName: string;
  enteredAt: string;
  completedAt?: string;
  tasksRequired?: string[];
  tasksCompleted?: string[];
  notes?: string;
  enteredBy?: string;
  completedBy?: string;
  isCurrent: boolean;
}

export interface DocumentWithApproval {
  id: string;
  residentId?: string;
  residentName?: string;
  staffId?: string;
  title: string;
  type?: string;
  category?: string;
  phase?: string;
  uploaderRole?: string;
  description?: string;
  fileName?: string;
  fileSize?: number;
  filePath?: string;
  fileData?: string; // Base64 encoded file data
  fileType?: string; // MIME type
  status: 'Draft' | 'Submitted' | 'Under Review' | 'Approved' | 'Rejected' | 'Archived';
  submittedBy?: string;
  submittedAt?: string;
  uploadedBy?: string; // Alias for submittedBy
  uploadedAt?: string; // Alias for submittedAt
  reviewedBy?: string;
  reviewedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectionReason?: string;
  notes?: string;
}

interface DataContextType {
  children: Child[];
  addChild: (child: Omit<Child, 'id' | 'behavioralLogs'>) => Promise<Child | null>;
  updateChild: (id: string, updates: Partial<Child>) => void;
  deleteChild: (id: string) => void;
  readmitChild: (id: string, data: { newAdmissionDate?: string; newCaseType?: string; newLegalCategory?: string }) => Promise<Child | null>;
  staff: Staff[];
  addStaff: (staff: Omit<Staff, 'id'>) => void;
  updateStaff: (id: string, updates: Partial<Staff>) => void;
  deleteStaff: (id: string) => void;
  activities: Activity[];
  addActivity: (activity: Omit<Activity, 'id'>) => void;
  updateActivity: (id: string, updates: Partial<Activity>) => void;
  deleteActivity: (id: string) => void;
  assessments: Assessment[];
  addAssessment: (assessment: Omit<Assessment, 'id'>) => void;
  updateAssessment: (id: string, updates: Partial<Assessment>) => void;
  deleteAssessment: (id: string) => void;
  reports: Report[];
  generateReport: (type: Report['type'], title?: string, generatedBy?: string) => void;
  generateDailyReport: () => Promise<any>;
  generateQuarterlyDSWDReport: () => Promise<any>;
  getDSWDReportFormat: (reportId: string) => Promise<any>;
  // Violations
  violations: Violation[];
  addViolation: (violation: Omit<Violation, 'id'>) => Promise<(Violation & { autoCreatedAssessment?: any; autoCreatedAlerts?: any[]; interventionPlan?: any }) | null>;
  updateViolation: (id: string, updates: Partial<Violation>) => void;
  deleteViolation: (id: string) => void;
  // Alerts
  alerts: Alert[];
  markAlertAsRead: (id: string, readBy: string) => Promise<void>;
  markAllAlertsAsRead: (readBy: string) => Promise<void>;
  deleteAlert: (id: string) => void;
  // Court Records
  courtRecords: CourtRecord[];
  addCourtRecord: (record: Omit<CourtRecord, 'id'>) => void;
  updateCourtRecord: (id: string, updates: Partial<CourtRecord>) => void;
  deleteCourtRecord: (id: string) => void;
  // Phase Progress
  phaseProgress: PhaseProgress[];
  addPhaseProgress: (progress: Omit<PhaseProgress, 'id'>) => void;
  updatePhaseProgress: (id: string, updates: Partial<PhaseProgress>) => void;
  completePhase: (id: string, completedBy: string) => void;
  validatePhaseProgress: (residentId: string, targetPhase?: string) => Promise<any>;
  // Documents
  documents: DocumentWithApproval[];
  addDocument: (doc: Omit<DocumentWithApproval, 'id'>) => void;
  updateDocument: (id: string, updates: Partial<DocumentWithApproval>) => void;
  deleteDocument: (id: string) => void;
  submitDocument: (id: string, submittedBy: string) => void;
  approveDocument: (id: string, approvedBy: string) => void;
  rejectDocument: (id: string, rejectionReason: string, reviewedBy: string) => void;
  // Status
  isLoading: boolean;
  setLoading: (loading: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
  unreadAlertsCount: number;
  refreshData: () => void;
}

const DataContext = createContext<DataContextType | undefined>(undefined);

export function DataProvider({ children: childrenProp }: { children: ReactNode }) {
  const [children, setChildren] = useState<Child[]>(() => {
    try {
      const saved = localStorage.getItem('children');
      if (!saved) return [];
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((c: any) => ({
        ...c,
        behavioralLogs: Array.isArray(c.behavioralLogs) ? c.behavioralLogs : [],
        assessments: Array.isArray(c.assessments) ? c.assessments : [],
        medicalRecords: Array.isArray(c.medicalRecords) ? c.medicalRecords : [],
        lastCheckup: c.lastCheckup || null,
      }));
    } catch { return []; }
  });

  const [staff, setStaff] = useState<Staff[]>(() => {
    try {
      const saved = localStorage.getItem('staff');
      if (!saved) return [];
      const parsed = JSON.parse(saved);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });

  const [activities, setActivities] = useState<Activity[]>(() => {
    try {
      const saved = localStorage.getItem('activitiesRecords');
      if (!saved) return [];
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((a: any) => ({
        ...a,
        facilitators: Array.isArray(a.facilitators) ? a.facilitators : [],
        participants: Array.isArray(a.participants) ? a.participants : [],
        selectedResidentIds: Array.isArray(a.selectedResidentIds) ? a.selectedResidentIds : [],
      }));
    } catch { return []; }
  });

  const [assessments, setAssessments] = useState<Assessment[]>(() => {
    try {
      const saved = localStorage.getItem('assessments');
      if (!saved) return [];
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((a: any) => ({
        ...a,
        forResidents: Array.isArray(a.forResidents) ? a.forResidents : [],
      }));
    } catch { return []; }
  });

  const [reports, setReports] = useState<Report[]>(() => {
    try {
      const saved = localStorage.getItem('reports');
      if (!saved) return [];
      const parsed = JSON.parse(saved);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });

  const [violations, setViolations] = useState<Violation[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [courtRecords, setCourtRecords] = useState<CourtRecord[]>([]);
  const [phaseProgress, setPhaseProgress] = useState<PhaseProgress[]>([]);
  const [documents, setDocuments] = useState<DocumentWithApproval[]>([]);
  const [unreadAlertsCount, setUnreadAlertsCount] = useState(0);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStore = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const store = await getStore();
      setChildren(Array.isArray(store.children) ? store.children.map((c: any) => ({
        ...c,
        behavioralLogs: Array.isArray(c.behavioralLogs) ? c.behavioralLogs : [],
        assessments: Array.isArray(c.assessments) ? c.assessments : [],
        medicalRecords: Array.isArray(c.medicalRecords) ? c.medicalRecords : [],
        lastCheckup: c.lastCheckup || null,
      })) : []);
      setStaff(Array.isArray(store.staff) ? store.staff : []);
      setActivities(Array.isArray(store.activities) ? store.activities.map((a: any) => ({
        ...a,
        facilitators: Array.isArray(a.facilitators) ? a.facilitators : [],
        participants: Array.isArray(a.participants) ? a.participants : [],
        selectedResidentIds: Array.isArray(a.selectedResidentIds) ? a.selectedResidentIds : [],
      })) : []);
      setAssessments(Array.isArray(store.assessments) ? store.assessments.map((a: any) => ({
        ...a,
        forResidents: Array.isArray(a.forResidents) ? a.forResidents : [],
      })) : []);
      setReports(Array.isArray(store.reports) ? store.reports : []);
      setViolations(Array.isArray(store.violations) ? store.violations : []);
      setAlerts(Array.isArray(store.alerts) ? store.alerts : []);
      setCourtRecords(Array.isArray(store.courtRecords) ? store.courtRecords : []);
      setPhaseProgress(Array.isArray(store.phaseProgress) ? store.phaseProgress.map((p: any) => ({
        ...p,
        tasksRequired: Array.isArray(p.tasksRequired) ? p.tasksRequired : [],
        tasksCompleted: Array.isArray(p.tasksCompleted) ? p.tasksCompleted : [],
      })) : []);
      // Merge: keep existing fileData in memory (store omits it for performance)
      setDocuments(prev => {
        const incoming: DocumentWithApproval[] = Array.isArray(store.documents) ? store.documents : [];
        return incoming.map(d => {
          const existing = prev.find(p => p.id === d.id);
          return existing?.fileData ? { ...d, fileData: existing.fileData } : d;
        });
      });
      setUnreadAlertsCount(Array.isArray(store.alerts) ? store.alerts.filter((a: Alert) => !a.isRead).length : 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load backend data');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadStore(); }, []);

  useEffect(() => { localStorage.setItem('children', JSON.stringify(children)); }, [children]);
  useEffect(() => { localStorage.setItem('staff', JSON.stringify(staff)); }, [staff]);
  useEffect(() => { localStorage.setItem('activitiesRecords', JSON.stringify(activities)); }, [activities]);
  useEffect(() => { localStorage.setItem('assessments', JSON.stringify(assessments)); }, [assessments]);
  useEffect(() => { localStorage.setItem('reports', JSON.stringify(reports)); }, [reports]);
  useEffect(() => { localStorage.setItem('violations', JSON.stringify(violations)); }, [violations]);
  useEffect(() => { localStorage.setItem('alerts', JSON.stringify(alerts)); }, [alerts]);
  useEffect(() => { localStorage.setItem('courtRecords', JSON.stringify(courtRecords)); }, [courtRecords]);

  const generateId = (prefix: string, list: any[]) => {
    const nextNum = list.length > 0 
      ? Math.max(...list.map(i => parseInt(i.id.replace(prefix, '')) || 0)) + 1 
      : 1;
    return `${prefix}${String(nextNum).padStart(3, '0')}`;
  };

  const addChild = async (data: Omit<Child, 'id' | 'behavioralLogs'>): Promise<Child | null> => {
    const newEntry: Child = { 
      ...data, 
      id: generateId('CH', children), 
      behavioralLogs: [],
      assessments: [],
      medicalRecords: [],
      lastCheckup: undefined
    };
    try {
      const saved = await createResource<Child>('children', newEntry);
      setChildren(prev => [...prev, saved]);
      return saved;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add child');
      return null;
    }
  };

  const updateChild = async (id: string, updates: Partial<Child>) => {
    const previous = children;
    setChildren(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
    try {
      const saved = await updateResource<Child>('children', id, updates);
      setChildren(prev => prev.map(c => c.id === id ? saved : c));
    } catch (err) {
      setChildren(previous);
      setError(err instanceof Error ? err.message : 'Unable to update child');
    }
  };

  const deleteChild = async (id: string) => {
    const previous = children;
    setChildren(prev => prev.filter(c => c.id !== id));
    try {
      await deleteResource('children', id);
    } catch (err) {
      setChildren(previous);
      setError(err instanceof Error ? err.message : 'Unable to delete child');
    }
  };

  const readmitChild = async (id: string, data: { newAdmissionDate?: string; newCaseType?: string; newLegalCategory?: string }): Promise<Child | null> => {
    try {
      const result = await request<{ success: boolean; data: Child & { phaseProgress: PhaseProgress[] } }>(`/children/${id}/readmit`, {
        method: 'POST',
        body: JSON.stringify({
          ...data,
          resetPhase: true,           // signal backend to reset phase
          phaseTasksCompleted: {},     // clear all task checkboxes
        }),
      });
      if (result.success && result.data) {
        // Update child in state with reset phaseTasksCompleted
        const resetChild = { ...result.data, phaseTasksCompleted: {} };
        setChildren(prev => prev.map(c => c.id === id ? resetChild : c));
        // Update phase progress state with new archived + current phases
        if (result.data.phaseProgress) {
          setPhaseProgress(prev => {
            const filtered = prev.filter(p => p.residentId !== id);
            return [...filtered, ...result.data.phaseProgress];
          });
        }
        // Refresh full store to get clean state
        try { const store = await getStore(); if (store) { setChildren(Array.isArray(store.children) ? store.children : []); } } catch { /* silent */ }
        return resetChild;
      }
      return null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to re-admit child');
      return null;
    }
  };

  const addStaff = async (data: Omit<Staff, 'id'>) => {
    try {
      const saved = await createResource<Staff>('staff', { ...data, id: generateId('ST', staff) });
      setStaff(prev => [...prev, saved]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add staff');
    }
  };

  const updateStaff = async (id: string, updates: Partial<Staff>) => {
    const previous = staff;
    setStaff(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
    try {
      const saved = await updateResource<Staff>('staff', id, updates);
      setStaff(prev => prev.map(s => s.id === id ? saved : s));
    } catch (err) {
      setStaff(previous);
      setError(err instanceof Error ? err.message : 'Unable to update staff');
    }
  };

  const deleteStaff = async (id: string) => {
    const previous = staff;
    setStaff(prev => prev.filter(s => s.id !== id));
    try {
      await deleteResource('staff', id);
    } catch (err) {
      setStaff(previous);
      setError(err instanceof Error ? err.message : 'Unable to delete staff');
    }
  };

  const addActivity = async (data: Omit<Activity, 'id'>) => {
    try {
      const saved = await createResource<Activity>('activities', { ...data, id: generateId('ACT', activities) });
      setActivities(prev => [...prev, saved]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add activity');
    }
  };

  const updateActivity = async (id: string, updates: Partial<Activity>) => {
    const previous = activities;
    setActivities(prev => prev.map(a => a.id === id ? { ...a, ...updates } : a));
    try {
      const saved = await updateResource<Activity>('activities', id, updates);
      setActivities(prev => prev.map(a => a.id === id ? saved : a));
    } catch (err) {
      setActivities(previous);
      setError(err instanceof Error ? err.message : 'Unable to update activity');
    }
  };

  const deleteActivity = async (id: string) => {
    const previous = activities;
    setActivities(prev => prev.filter(a => a.id !== id));
    try {
      await deleteResource('activities', id);
    } catch (err) {
      setActivities(previous);
      setError(err instanceof Error ? err.message : 'Unable to delete activity');
    }
  };

  // FIX: In-update para laging nasa taas ang bagong assessment
  const addAssessment = async (data: Omit<Assessment, 'id'>) => {
    const newId = generateId('ASM', assessments);
    const newEntry = { ...data, id: newId };
    try {
      const saved = await createResource<Assessment>('assessments', newEntry);
      setAssessments(prev => [saved, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add assessment');
    }
  };

  const updateAssessment = async (id: string, updates: Partial<Assessment>) => {
    const previous = assessments;
    setAssessments(prev => prev.map(a => a.id === id ? { ...a, ...updates } : a));
    try {
      const saved = await updateResource<Assessment>('assessments', id, updates);
      setAssessments(prev => prev.map(a => a.id === id ? saved : a));
    } catch (err) {
      setAssessments(previous);
      setError(err instanceof Error ? err.message : 'Unable to update assessment');
    }
  };

  const deleteAssessment = async (id: string) => {
    const previous = assessments;
    setAssessments(prev => prev.filter(a => a.id !== id));
    try {
      await deleteResource('assessments', id);
    } catch (err) {
      setAssessments(previous);
      setError(err instanceof Error ? err.message : 'Unable to delete assessment');
    }
  };

  const generateReport = async (type: Report['type'], title?: string, generatedBy?: string) => {
    const newRep: Report = {
      id: generateId('REP', reports),
      title: title || `${type.toUpperCase()} Report - ${new Date().toLocaleDateString()}`,
      type,
      date: new Date().toISOString().split('T')[0],
      generatedBy: generatedBy || 'System',
      status: 'generated',
    };
    try {
      const saved = await createResource<Report>('reports', newRep);
      setReports(prev => [saved, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to generate report');
    }
  };

  const generateDailyReport = async () => {
    try {
      const data = await request<{ success: boolean; report: Report }>('/reports/generate-daily', {
        method: 'POST',
      });
      if (data.success && data.report) {
        setReports(prev => [data.report, ...prev]);
      }
      return data.report;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to generate daily report');
      return null;
    }
  };

  const generateQuarterlyDSWDReport = async () => {
    try {
      const data = await request<{ success: boolean; report: Report }>('/reports/generate-quarterly', {
        method: 'POST',
      });
      if (data.success && data.report) {
        setReports(prev => [data.report, ...prev]);
      }
      return data.report;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to generate quarterly report');
      return null;
    }
  };

  const getDSWDReportFormat = async (reportId: string) => {
    try {
      const data = await request<{ success: boolean; report: any }>(`/reports/dswd-format/${reportId}`);
      return data.report;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to get DSWD report format');
      return null;
    }
  };

  // === VIOLATIONS ===
  const addViolation = async (data: Omit<Violation, 'id'>): Promise<(Violation & { autoCreatedAssessment?: any; autoCreatedAlerts?: any[]; interventionPlan?: any }) | null> => {
    const newEntry = { ...data, id: generateId('VIO', violations) };
    try {
      const saved = await createResource<Violation>('violations', newEntry);
      // Add violation to state immediately
      setViolations(prev => [saved, ...prev]);
      // Auto-created assessment — add to assessments state immediately
      if (saved.autoCreatedAssessment) {
        const asm = saved.autoCreatedAssessment;
        setAssessments(prev => [{
          ...asm,
          forResidents: Array.isArray(asm.forResidents) ? asm.forResidents : [],
        }, ...prev]);
      }
      // Auto-created alerts — add to alerts state and bump unread count immediately
      if (Array.isArray(saved.autoCreatedAlerts) && saved.autoCreatedAlerts.length > 0) {
        setAlerts(prev => [...saved.autoCreatedAlerts!, ...prev]);
        setUnreadAlertsCount(prev => prev + saved.autoCreatedAlerts!.length);
      }
      return saved;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add violation');
      return null;
    }
  };

  const updateViolation = async (id: string, updates: Partial<Violation>) => {
    const previous = violations;
    setViolations(prev => prev.map(v => v.id === id ? { ...v, ...updates } : v));
    try {
      const saved = await updateResource<Violation>('violations', id, updates);
      setViolations(prev => prev.map(v => v.id === id ? saved : v));
    } catch (err) {
      setViolations(previous);
      setError(err instanceof Error ? err.message : 'Unable to update violation');
    }
  };

  const deleteViolation = async (id: string) => {
    const previous = violations;
    setViolations(prev => prev.filter(v => v.id !== id));
    try {
      await deleteResource('violations', id);
    } catch (err) {
      setViolations(previous);
      setError(err instanceof Error ? err.message : 'Unable to delete violation');
    }
  };

  // === ALERTS ===
  const markAlertAsRead = async (id: string, readBy: string) => {
    const previous = alerts;
    const alert = alerts.find(a => a.id === id);
    
    // Optimistic update
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, isRead: true, readBy, readAt: new Date().toISOString() } : a));
    if (alert && !alert.isRead) {
      setUnreadAlertsCount(prev => Math.max(0, prev - 1));
    }
    
    try {
      const result = await request<{ data?: Alert }>(`/alerts/${id}/read`, {
        method: 'POST',
        body: JSON.stringify({ readBy }),
      });
      setAlerts(prev => prev.map(a => a.id === id ? (result.data || { ...a, isRead: true, readBy, readAt: new Date().toISOString() }) : a));
      
      // Recalculate unread count from all alerts
      const allAlertsData = await request<{ data?: Alert[] }>('/alerts');
      const unreadCount = (allAlertsData.data || []).filter((a: Alert) => !a.isRead).length;
      setUnreadAlertsCount(unreadCount);
    } catch (err) {
      setAlerts(previous);
      setUnreadAlertsCount(prev => Math.max(0, prev + (alert && !alert.isRead ? 1 : 0)));
      setError(err instanceof Error ? err.message : 'Unable to mark alert as read');
    }
  };

  const markAllAlertsAsRead = async (readBy: string) => {
    const unreadAlerts = alerts.filter(a => !a.isRead);
    const unreadIds = unreadAlerts.map(a => a.id);
    if (unreadIds.length === 0) return;

    // Optimistic update
    setAlerts(prev => prev.map(a => unreadIds.includes(a.id) ? { ...a, isRead: true, readBy, readAt: new Date().toISOString() } : a));
    setUnreadAlertsCount(0);

    try {
      // Mark all as read in backend
      await Promise.all(unreadIds.map(async (id) => {
        await request(`/alerts/${id}/read`, {
          method: 'POST',
          body: JSON.stringify({ readBy }),
        });
      }));
      
      // Refresh alerts from backend to ensure consistency
      const allAlertsData = await request<{ data?: Alert[] }>('/alerts');
      setAlerts(allAlertsData.data || []);
      const unreadCount = (allAlertsData.data || []).filter((a: Alert) => !a.isRead).length;
      setUnreadAlertsCount(unreadCount);
    } catch (err) {
      // Revert on error
      setAlerts(alerts);
      setUnreadAlertsCount(unreadAlerts.length);
      setError(err instanceof Error ? err.message : 'Unable to mark all alerts as read');
    }
  };

  const deleteAlert = async (id: string) => {
    const previous = alerts;
    const alert = alerts.find(a => a.id === id);
    setAlerts(prev => prev.filter(a => a.id !== id));
    if (alert && !alert.isRead) setUnreadAlertsCount(prev => Math.max(0, prev - 1));
    try {
      await deleteResource('alerts', id);
    } catch (err) {
      setAlerts(previous);
      setError(err instanceof Error ? err.message : 'Unable to delete alert');
    }
  };

  // === COURT RECORDS ===
  const addCourtRecord = async (data: Omit<CourtRecord, 'id'>) => {
    const newEntry = { ...data, id: generateId('CRT', courtRecords) };
    try {
      const saved = await createResource<CourtRecord>('courtRecords', newEntry);
      setCourtRecords(prev => [...prev, saved]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add court record');
    }
  };

  const updateCourtRecord = async (id: string, updates: Partial<CourtRecord>) => {
    const previous = courtRecords;
    setCourtRecords(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
    try {
      const saved = await updateResource<CourtRecord>('courtRecords', id, updates);
      setCourtRecords(prev => prev.map(c => c.id === id ? saved : c));
    } catch (err) {
      setCourtRecords(previous);
      setError(err instanceof Error ? err.message : 'Unable to update court record');
    }
  };

  const deleteCourtRecord = async (id: string) => {
    const previous = courtRecords;
    setCourtRecords(prev => prev.filter(c => c.id !== id));
    try {
      await deleteResource('courtRecords', id);
    } catch (err) {
      setCourtRecords(previous);
      setError(err instanceof Error ? err.message : 'Unable to delete court record');
    }
  };

  // === PHASE PROGRESS ===
  const addPhaseProgress = async (data: Omit<PhaseProgress, 'id'>) => {
    const newEntry = { ...data, id: generateId('PHS', phaseProgress) };
    try {
      const saved = await createResource<PhaseProgress>('phaseProgress', newEntry);
      setPhaseProgress(prev => [...prev, saved]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add phase progress');
    }
  };

  const updatePhaseProgress = async (id: string, updates: Partial<PhaseProgress>) => {
    const previous = phaseProgress;
    setPhaseProgress(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));
    try {
      const saved = await updateResource<PhaseProgress>('phaseProgress', id, updates);
      setPhaseProgress(prev => prev.map(p => p.id === id ? saved : p));
    } catch (err) {
      setPhaseProgress(previous);
      setError(err instanceof Error ? err.message : 'Unable to update phase progress');
    }
  };

  const completePhase = async (id: string, completedBy: string) => {
    const updates = { completedAt: new Date().toISOString().split('T')[0], completedBy, isCurrent: false };
    await updatePhaseProgress(id, updates);
  };

  const validatePhaseProgress = async (residentId: string, targetPhase?: string) => {
    try {
      const url = targetPhase 
        ? `/phaseProgress/validate/${residentId}?targetPhase=${encodeURIComponent(targetPhase)}`
        : `/phaseProgress/validate/${residentId}`;
      const result = await request<{ success: boolean; data: any }>(url);
      return result?.data;
    } catch (error) {
      console.error('Failed to validate phase progress:', error);
      return null;
    }
  };

  // === DOCUMENTS ===
  const addDocument = async (data: Omit<DocumentWithApproval, 'id'>) => {
    const tempId = generateId('DOC', documents);
    const optimistic: DocumentWithApproval = { ...data, id: tempId };
    // Optimistic update — show immediately in UI before backend confirms
    setDocuments(prev => [optimistic, ...prev]);
    try {
      const saved = await createResource<DocumentWithApproval>('documents', optimistic);
      // Replace optimistic entry with server-confirmed entry
      setDocuments(prev => prev.map(d => d.id === tempId ? saved : d));
    } catch (err) {
      // On failure, keep the optimistic entry so UI still shows it
      // (avoids confusing disappearing uploads)
      setError(err instanceof Error ? err.message : 'Unable to save document to server');
    }
  };

  const updateDocument = async (id: string, updates: Partial<DocumentWithApproval>) => {
    const previous = documents;
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, ...updates } : d));
    try {
      const saved = await updateResource<DocumentWithApproval>('documents', id, updates);
      setDocuments(prev => prev.map(d => d.id === id ? saved : d));
    } catch (err) {
      setDocuments(previous);
      setError(err instanceof Error ? err.message : 'Unable to update document');
    }
  };

  const deleteDocument = async (id: string) => {
    const previous = documents;
    setDocuments(prev => prev.filter(d => d.id !== id));
    try {
      await deleteResource('documents', id);
    } catch (err) {
      setDocuments(previous);
      setError(err instanceof Error ? err.message : 'Unable to delete document');
    }
  };

  const submitDocument = async (id: string, submittedBy: string) => {
    await updateDocument(id, { status: 'Submitted', submittedBy, submittedAt: new Date().toISOString() });
  };

  const approveDocument = async (id: string, approvedBy: string) => {
    await updateDocument(id, { status: 'Approved', approvedBy, approvedAt: new Date().toISOString() });
  };

  const rejectDocument = async (id: string, rejectionReason: string, reviewedBy: string) => {
    await updateDocument(id, { status: 'Rejected', rejectionReason, reviewedBy, reviewedAt: new Date().toISOString() });
  };

  return (
    <DataContext.Provider value={{
      children, addChild, updateChild, deleteChild, readmitChild,
      staff, addStaff, updateStaff, deleteStaff,
      activities, addActivity, updateActivity, deleteActivity,
      assessments, addAssessment, updateAssessment, deleteAssessment,
      reports, generateReport, generateDailyReport, generateQuarterlyDSWDReport, getDSWDReportFormat,
      violations, addViolation, updateViolation, deleteViolation,
      alerts, markAlertAsRead, markAllAlertsAsRead, deleteAlert,
      courtRecords, addCourtRecord, updateCourtRecord, deleteCourtRecord,
      phaseProgress, addPhaseProgress, updatePhaseProgress, completePhase, validatePhaseProgress,
      documents, addDocument, updateDocument, deleteDocument, submitDocument, approveDocument, rejectDocument,
      isLoading, setLoading: setIsLoading,
      error, setError,
      unreadAlertsCount,
      refreshData: loadStore,
    }}>
      {childrenProp}
    </DataContext.Provider>
  );
}

export const useData = () => {
  const context = useContext(DataContext);
  if (context === undefined) throw new Error('useData must be used within a DataProvider');
  return context;
};