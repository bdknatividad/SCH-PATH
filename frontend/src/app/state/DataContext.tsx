import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { createResource, deleteResource, getStore, updateResource, request } from '@/services/api';
import { useAuth } from './AuthContext';

// ponytail: dedupe concurrent mark-as-read calls (per-id) to prevent the
// "Unable to update notifications" race condition.
const readingAlerts = new Set<string>();

/**
 * The server-maintained columns every stored row carries, which the domain
 * interfaces above do not model. `updatedAt` is what makes conflict detection
 * possible — see `withVersion` in the provider.
 */
interface RecordVersion {
  id: string;
  updatedAt?: string;
}

/**
 * Local cache writes must never take the app down. `children` carries base64
 * file data, so the ~5MB origin quota is reachable; an uncaught
 * QuotaExceededError inside an effect unmounts the whole tree.
 */
function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or serialisation failure — keep the in-memory state.
  }
}

// === TYPES ===

export interface BehavioralLog {
  id: string;
  date: string;
  type: string;
  severity: 'Low' | 'Medium' | 'High' | 'Minor' | 'Major' | 'Critical';
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
  status: 'Active' | 'Discharged' | 'Absconded';
  /** When and by whom the resident was marked Absconded. */
  abscondedAt?: string | null;
  abscondedBy?: string | null;
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
  lrn?: string;
  traineeNumber?: string;
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
  notRecommendedResidentIds?: string[]; // Children restricted by Psychological Staff
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
  violationIds?: string[];
  interventionTrackerId?: string;
  interventionRequirementId?: string;
  schedulingMode?: 'auto' | 'manual' | 'violation-scheduled' | string;
  psychosocialActivities?: string[];
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
  location?: string;
  /**
   * Where on the body a body-marking violation happened.
   *
   * Only meaningful for the tattoo/piercing type, whose own wording is
   * "sa anumang bahagi ng katawan" — the record could say *that* a tattoo was
   * placed but not *where*, which is the part a case conference asks about.
   */
  bodyLocation?: string;
  witnesses?: string;
  reportedBy?: string;
  reviewedBy?: string;
  actionTaken?: string;
  status: 'Pending Review' | 'Under Investigation' | 'Reviewed' | 'Resolved' | 'Escalated' | 'Rejected';
  requiresAssessment: boolean;
  assessmentTriggered: boolean;
  assessmentCompleted?: boolean;
  guideId?: string;
  autoCreatedAssessment?: Assessment;
  autoCreatedAlerts?: Alert[];
  // New fields
  offenseNumber?: '1st Offense' | '2nd Offense' | '3rd Offense' | '4th Offense+';
  interventionStartDate?: string;
  interventionMonth?: string; // YYYY-MM for monthly reset tracking
  clearedBy?: string;
  clearedAt?: string;
  points?: number;
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
  assessmentId?: string;
  title: string;
  type?: string;
  category?: string;
  /**
   * The category folder this document lives in — `Child → Document Category →
   * File`. Resolved by the backend from the routing rules and persisted, so the
   * folder view can group without re-deriving; a legacy row without it is
   * resolved on the fly by `folderForDocument`.
   */
  documentCategory?: string;
  phase?: string;
  uploaderRole?: string;
  description?: string;
  fileName?: string;
  fileSize?: number;
  filePath?: string;
  fileData?: string; // Base64 encoded file data
  fileType?: string; // MIME type
  status: 'Draft' | 'Submitted' | 'Under Review' | 'Approved' | 'Rejected' | 'Archived' | 'Reassessment';
  /** Submission round. Starts at 1 and advances on every resubmission. */
  revision?: number;
  submittedBy?: string;
  submittedAt?: string;
  uploadedBy?: string; // Alias for submittedBy
  uploadedAt?: string; // Alias for submittedAt
  reviewedBy?: string;
  reviewedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  /**
   * The most recent rejection, kept even after the document is resubmitted —
   * a rejection is not an erasure, and the folder view shows who rejected it and
   * when. Every rejection is also in the document's audit history.
   */
  rejectedBy?: string;
  rejectedAt?: string;
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
  /** Re-read the caller's own notifications from the server. */
  refreshAlerts: () => Promise<boolean>;
  /** Server-authoritative unread notification count for the badge. */
  unreadAlertsCount: number;
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
  /**
   * The structured health records the Health module writes (`/healthRecords`).
   *
   * Held here rather than in each consumer because the same rows have to appear
   * in two places — the Health module and Child Records → Medical — and a second
   * fetch in the child view is how the two lists drift apart. One load, one
   * source, both views read the same array.
   */
  healthRecords: any[];
  // Status
  isLoading: boolean;
  setLoading: (loading: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
  refreshData: () => void;
}

const DataContext = createContext<DataContextType | undefined>(undefined);

export function DataProvider({ children: childrenProp }: { children: ReactNode }) {
  const { token, user } = useAuth();
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
        psychosocialActivities: Array.isArray(a.psychosocialActivities)
          ? a.psychosocialActivities
          : (typeof a.psychosocialActivities === 'string' ? (() => { try { return JSON.parse(a.psychosocialActivities); } catch { return []; } })() : []),
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
  const [healthRecords, setHealthRecords] = useState<any[]>([]);
  const [unreadAlertsCount, setUnreadAlertsCount] = useState(0);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Monotonic token identifying the newest `loadStore()` call.
   *
   * `loadStore()` fires on mount, on every `token`/role change, and — through
   * `refreshData()` — from window-focus handlers and after most actions. With
   * two people working at once those calls overlap, and responses can land out
   * of order: a request sent first but answered last would write older rows
   * over newer ones, so a record the user had just seen appear would vanish
   * again until the next refresh. The store response carries no server
   * timestamp to order by, so the client orders by issue order instead — only
   * the response belonging to the newest call is allowed to write state.
   *
   * Deliberately a ref, not state: it must not trigger a render, and the guard
   * has to read the *current* value rather than the value captured when the
   * promise was created.
   */
  const loadGeneration = useRef(0);

  /** Same guard for the notification feed — see `refreshAlerts`. */
  const alertLoadGeneration = useRef(0);

  /**
   * Re-read the caller's notifications from the server.
   *
   * Alerts are the one collection where the server must be the only source of
   * truth: the list is scoped to the authenticated user by the backend, so
   * there is no role filter here any more. The browser-side `targetRole`
   * filter that used to live in this file and in Notifications.tsx was the only
   * thing stopping a Houseparent from seeing every other role's alerts, and it
   * compared raw strings against a lower-cased role.
   *
   * The unread badge is read from the server as well, so it cannot drift from
   * the list it is describing.
   */
  const refreshAlerts = useCallback(async () => {
    // Same out-of-order hazard as loadStore(): this runs on a 30s poll, on
    // window focus, and after alert actions, so two calls can overlap and the
    // slower one would overwrite the newer list and count.
    const generation = (alertLoadGeneration.current += 1);
    try {
      const [list, counts] = await Promise.all([
        request<{ data?: Alert[] }>('/alerts?limit=200'),
        request<{ count?: number }>('/alerts/unread-count'),
      ]);
      if (generation !== alertLoadGeneration.current) return true;
      setAlerts(Array.isArray(list.data) ? list.data : []);
      setUnreadAlertsCount(Number(counts.count || 0));
      return true;
    } catch (err) {
      if (generation !== alertLoadGeneration.current) return true;
      setError(err instanceof Error ? err.message : 'Unable to load notifications');
      return false;
    }
  }, []);

  // Memoised so consumers that depend on its identity (e.g. the Notifications
  // polling interval) are not torn down on every provider render.
  const loadStore = useCallback(async () => {
    // Claim the newest generation. Any response from an earlier call that is
    // still in flight will see a higher number below and discard itself.
    const generation = (loadGeneration.current += 1);
    setIsLoading(true);
    setError(null);
    try {
      const store = await getStore();
      // A newer load started while this one was in flight — its data is at
      // least as fresh, so writing this response would move the UI backwards.
      if (generation !== loadGeneration.current) return;
      let loadedChildren = Array.isArray(store.children) ? store.children.map((c: any) => ({
        ...c,
        behavioralLogs: Array.isArray(c.behavioralLogs) ? c.behavioralLogs : [],
        assessments: Array.isArray(c.assessments) ? c.assessments : [],
        medicalRecords: Array.isArray(c.medicalRecords) ? c.medicalRecords : [],
        lastCheckup: c.lastCheckup || null,
      })) : [];

      // Houseparent resident lists are refreshed directly from the active
      // assignment source. This keeps Child Records, TRI and Anecdotal Report
      // in sync even when the bulk store was loaded before an assignment was
      // changed or when a legacy assignment is linked through staff.userId.
      if (String(user?.role || '').trim().toLowerCase().replace(/[_-]/g, ' ') === 'houseparent') {
        try {
          const assigned = await request<{ success: boolean; data?: any[] }>('/resident-assignments/my-residents');
          if (assigned?.success && Array.isArray(assigned.data)) {
            loadedChildren = assigned.data.map((c: any) => ({
              ...c,
              behavioralLogs: Array.isArray(c.behavioralLogs) ? c.behavioralLogs : [],
              assessments: Array.isArray(c.assessments) ? c.assessments : [],
              medicalRecords: Array.isArray(c.medicalRecords) ? c.medicalRecords : [],
              lastCheckup: c.lastCheckup || null,
            }));
          }
        } catch (assignmentError) {
          console.warn('[DataContext] Unable to refresh Houseparent assigned residents:', assignmentError);
        }
      }

      // The Houseparent branch above awaits a second request, so re-check the
      // generation before touching any state.
      if (generation !== loadGeneration.current) return;

      setChildren(loadedChildren);
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
        psychosocialActivities: Array.isArray(a.psychosocialActivities)
          ? a.psychosocialActivities
          : (typeof a.psychosocialActivities === 'string' ? (() => { try { return JSON.parse(a.psychosocialActivities); } catch { return []; } })() : []),
      })) : []);
      setReports(Array.isArray(store.reports) ? store.reports : []);
      setViolations(Array.isArray(store.violations) ? store.violations : []);
      setAlerts(Array.isArray(store.alerts) ? store.alerts : []);
      setCourtRecords(Array.isArray(store.courtRecords) ? store.courtRecords : []);
      setHealthRecords(Array.isArray(store.healthRecords) ? store.healthRecords : []);
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
      // The unread badge is the server's number, and the list is the server's
      // list. Counting `store.alerts` in the browser is what let the badge
      // disagree with the panel it describes.
      await refreshAlerts();
    } catch (err) {
      // A superseded request must not surface its error either: the newer load
      // is already on its way and will report whatever is actually wrong.
      if (generation !== loadGeneration.current) return;
      setError(err instanceof Error ? err.message : 'Unable to load backend data');
    } finally {
      // Only the newest call owns the spinner. Clearing it here unconditionally
      // would hide the progress indicator while a newer request is still
      // running, so the page would look idle-but-empty.
      if (generation === loadGeneration.current) setIsLoading(false);
    }
  }, [user?.role, refreshAlerts]);

  useEffect(() => {
    if (token) loadStore();
  }, [token, loadStore]);

  useEffect(() => { persist('children', children); }, [children]);
  useEffect(() => { persist('staff', staff); }, [staff]);
  useEffect(() => { persist('activitiesRecords', activities); }, [activities]);
  useEffect(() => { persist('assessments', assessments); }, [assessments]);
  useEffect(() => { persist('reports', reports); }, [reports]);
  useEffect(() => { persist('violations', violations); }, [violations]);
  useEffect(() => { persist('alerts', alerts); }, [alerts]);
  useEffect(() => { persist('courtRecords', courtRecords); }, [courtRecords]);

  /**
   * A temporary, client-only key for an optimistically rendered row.
   *
   * This is deliberately **not** a record id and must never be sent as one.
   * The previous version computed the next sequential id from the ids already
   * on screen (`CH001` → `CH006`) and posted it as the record's id, which broke
   * in two ways the moment two people used the system at the same time:
   *
   * 1. **Collision.** Two browsers holding the same list compute the *same*
   *    next id. The backend ignores a client-supplied id and allocates its own
   *    (§ `insertWithGeneratedId`), so neither request failed — but the client
   *    then reconciled its optimistic row by matching that id, and one of the
   *    two rows could never be matched, leaving a phantom in the list.
   * 2. **Orphaned rows.** Because the server minted a different id than the one
   *    sent, `prev.map(d => d.id === tempId ? saved : d)` never matched and the
   *    optimistic row was never replaced — it showed a stale copy until reload.
   *
   * A random, namespaced key is unique per browser, so reconciliation is exact
   * and two simultaneous creates can no longer produce the same key.
   */
  const provisionalKey = (prefix: string) => {
    const random = Math.random().toString(36).slice(2, 10);
    return `tmp-${prefix}-${Date.now().toString(36)}-${random}`;
  };

  const addChild = async (data: Omit<Child, 'id' | 'behavioralLogs'>): Promise<Child | null> => {
    // See provisionalKey(). The id is the server's to allocate — sending one
    // let two concurrent creates collide on the same value.
    const { id: _ignoredProvisional, ...payload } = data as any;
    void _ignoredProvisional;
    try {
      const saved = await createResource<Child>('children', {
        ...payload,
        behavioralLogs: [],
        assessments: [],
        medicalRecords: [],
        lastCheckup: undefined,
      } as any);
      setChildren(prev => [...prev, saved]);
      return saved;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add child');
      return null;
    }
  };

  /**
   * Attach the caller's rendered `updatedAt` to a partial update payload.
   *
   * The backend compares it against the stored value and refuses the write with
   * a 409 when someone else saved the row first (see `baseController.update`).
   * Without this a second editor silently overwrote the first — and because
   * these updates are partial (`{ notes }`, `{ phaseTasksCompleted }`), the
   * overwrite also destroyed fields the payload never mentioned.
   *
   * The domain interfaces in this file do not declare `updatedAt`, but every
   * row carries it: the backend selects `*` and MySQL maintains the column via
   * `ON UPDATE CURRENT_TIMESTAMP`. It is read through `RecordVersion` so the
   * dependency on a column the types omit is stated in one place rather than
   * scattered as casts.
   *
   * `updatedAt` is stripped and re-added rather than left in place so a caller
   * that already put something else there cannot defeat the check.
   */
  // A trailing comma on the type parameter is required in `.tsx`: without it
  // TypeScript parses `<T>` as the start of a JSX element.
  const withVersion = <T,>(list: T[], id: string, updates: Partial<T>): Partial<T> => {
    const { updatedAt: _drop, ...rest } = updates as Record<string, unknown>;
    void _drop;
    const rendered = (list.find(item => (item as RecordVersion).id === id) as RecordVersion | undefined)
      ?.updatedAt;
    return (rendered ? { ...rest, updatedAt: rendered } : rest) as Partial<T>;
  };

  const updateChild = async (id: string, updates: Partial<Child>) => {
    const previous = children;
    setChildren(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
    try {
      const saved = await updateResource<Child>('children', id, withVersion(children, id, updates));
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
        try {
          const store = await getStore();
          if (store) {
            // Re-apply the same normalisation loadStore uses — overwriting with
            // raw rows dropped the array defaults and could replace the
            // just-computed reset with unnormalised data.
            setChildren(Array.isArray(store.children) ? store.children.map((c: any) => ({
              ...c,
              behavioralLogs: Array.isArray(c.behavioralLogs) ? c.behavioralLogs : [],
              assessments: Array.isArray(c.assessments) ? c.assessments : [],
              medicalRecords: Array.isArray(c.medicalRecords) ? c.medicalRecords : [],
              lastCheckup: c.lastCheckup || null,
            })) : []);
          }
        } catch (refreshError) {
          console.error('Re-admit succeeded but the follow-up refresh failed:', refreshError);
        }
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
      // No id in the payload: the server allocates it (see provisionalKey).
      const saved = await createResource<Staff>('staff', { ...data } as any);
      setStaff(prev => [...prev, saved]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add staff');
    }
  };

  const updateStaff = async (id: string, updates: Partial<Staff>) => {
    const previous = staff;
    setStaff(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
    try {
      const saved = await updateResource<Staff>('staff', id, withVersion(staff, id, updates));
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
      // No id in the payload: the server allocates it (see provisionalKey).
      const saved = await createResource<Activity>('activities', { ...data } as any);
      setActivities(prev => [...prev, saved]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add activity');
    }
  };

  const updateActivity = async (id: string, updates: Partial<Activity>) => {
    const previous = activities;
    setActivities(prev => prev.map(a => a.id === id ? { ...a, ...updates } : a));
    try {
      const saved = await updateResource<Activity>('activities', id, withVersion(activities, id, updates));
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
    try {
      // No id in the payload: the server allocates it (see provisionalKey).
      const saved = await createResource<Assessment>('assessments', { ...data } as any);
      setAssessments(prev => [saved, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add assessment');
    }
  };

  const updateAssessment = async (id: string, updates: Partial<Assessment>) => {
    const previous = assessments;
    setAssessments(prev => prev.map(a => a.id === id ? { ...a, ...updates } : a));
    try {
      const saved = await updateResource<Assessment>('assessments', id, withVersion(assessments, id, updates));
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
    const newRep = {
      // No id in the payload: the server allocates it (see provisionalKey).
      title: title || `${type.toUpperCase()} Report - ${new Date().toLocaleDateString()}`,
      type,
      date: new Date().toISOString().split('T')[0],
      generatedBy: generatedBy || 'System',
      status: 'generated',
    };
    try {
      const saved = await createResource<Report>('reports', newRep as any);
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
    const newEntry = { ...data };
    try {
      const saved = await createResource<Violation>('violations', newEntry as any);
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
      // Auto-created alerts belong to whichever roles were addressed, which is
      // not necessarily this user — a Social Worker logging a violation gets an
      // alert addressed to the Psychological Staff. Pushing the response array
      // straight into local state put another role's alert in this user's list;
      // re-reading the server's scoped list is both simpler and correct.
      if (Array.isArray(saved.autoCreatedAlerts) && saved.autoCreatedAlerts.length > 0) {
        await refreshAlerts();
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
      const saved = await updateResource<Violation>('violations', id, withVersion(violations, id, updates));
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
    // ponytail: dedupe concurrent mark-as-read calls (per-id) to prevent the
    // "Unable to update notifications" race condition where overlapping
    // optimistic updates clobber each other.
    if (readingAlerts.has(id)) { return; }
    readingAlerts.add(id);
    const previous = alerts;
    const alert = alerts.find(a => a.id === id);

    // Optimistic update
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, isRead: true, readBy, readAt: new Date().toISOString() } : a));
    if (alert && !alert.isRead) {
      setUnreadAlertsCount(prev => Math.max(0, prev - 1));
    }

    try {
      await request<{ data?: Alert }>(`/alerts/${id}/read`, {
        method: 'POST',
        body: JSON.stringify({ readBy }),
      });
      setError(null);
    } catch (err) {
      setAlerts(previous);
      setUnreadAlertsCount(prev => Math.max(0, prev + (alert && !alert.isRead ? 1 : 0)));
      setError(err instanceof Error ? err.message : 'Unable to mark alert as read');
    } finally {
      readingAlerts.delete(id);
    }
  };

  const markAllAlertsAsRead = async (readBy: string) => {
    // The server decides which alerts this user can see and marks exactly
    // those. The old implementation looped over the locally-held array, so an
    // alert that had arrived since the last poll was silently left unread — and
    // it fired one request per alert.
    const unreadAlerts = alerts.filter(a => !a.isRead);
    if (unreadAlerts.length === 0) return;
    const unreadIds = unreadAlerts.map(a => a.id);

    // Optimistic update
    setAlerts(prev => prev.map(a => unreadIds.includes(a.id) ? { ...a, isRead: true, readBy, readAt: new Date().toISOString() } : a));
    setUnreadAlertsCount(0);

    try {
      await request('/alerts/mark-all-read', { method: 'POST' });
      await refreshAlerts();
      setError(null);
    } catch (err) {
      // Revert precisely: restore the pre-change value of exactly the alerts
      // this call touched, instead of replacing the whole array with a stale
      // closure snapshot (which discarded concurrent successful changes).
      const previousById = new Map<string, Alert>(unreadAlerts.map(a => [a.id, a] as [string, Alert]));
      setAlerts(prev => prev.map(a => previousById.get(a.id) ?? a));
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
    const newEntry = { ...data };
    try {
      const saved = await createResource<CourtRecord>('courtRecords', newEntry as any);
      setCourtRecords(prev => [...prev, saved]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add court record');
    }
  };

  const updateCourtRecord = async (id: string, updates: Partial<CourtRecord>) => {
    const previous = courtRecords;
    setCourtRecords(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
    try {
      const saved = await updateResource<CourtRecord>('courtRecords', id, withVersion(courtRecords, id, updates));
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
    const newEntry = { ...data };
    try {
      const saved = await createResource<PhaseProgress>('phaseProgress', newEntry as any);
      setPhaseProgress(prev => [...prev, saved]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add phase progress');
    }
  };

  const updatePhaseProgress = async (id: string, updates: Partial<PhaseProgress>) => {
    const previous = phaseProgress;
    setPhaseProgress(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));
    try {
      const saved = await updateResource<PhaseProgress>('phaseProgress', id, withVersion(phaseProgress, id, updates));
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
    // The only genuine use of a provisional key: the row must appear in the UI
    // before the upload finishes. It is *not* sent as the record's id — the
    // server allocates that — so two people uploading at the same moment can
    // no longer produce the same key, and the replacement below always matches.
    const tempId = provisionalKey('DOC');
    const optimistic: DocumentWithApproval = { ...data, id: tempId };
    // Optimistic update — show immediately in UI before backend confirms
    setDocuments(prev => [optimistic, ...prev]);
    try {
      const { id: _omitServerAllocated, ...payload } = optimistic as any;
      void _omitServerAllocated;
      const saved = await createResource<DocumentWithApproval>('documents', payload);
      // Replace optimistic entry with server-confirmed entry
      setDocuments(prev => prev.map(d => d.id === tempId ? saved : d));
    } catch (err) {
      // Roll the optimistic row back. Keeping it made a document that was never
      // persisted look saved — often already marked Approved — and it silently
      // vanished on the next reload.
      setDocuments(prev => prev.filter(d => d.id !== tempId));
      const message = err instanceof Error ? err.message : 'Unable to save document to server';
      setError(message);
      // Re-throw so callers can surface a per-upload error instead of
      // reporting success.
      throw err instanceof Error ? err : new Error(message);
    }
  };

  const updateDocument = async (id: string, updates: Partial<DocumentWithApproval>) => {
    const previous = documents;
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, ...updates } : d));
    try {
      const saved = await updateResource<DocumentWithApproval>('documents', id, withVersion(documents, id, updates));
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
      alerts, markAlertAsRead, markAllAlertsAsRead, deleteAlert, refreshAlerts,
      courtRecords, addCourtRecord, updateCourtRecord, deleteCourtRecord,
      phaseProgress, addPhaseProgress, updatePhaseProgress, completePhase, validatePhaseProgress,
      documents, addDocument, updateDocument, deleteDocument, submitDocument, approveDocument, rejectDocument,
      healthRecords,
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