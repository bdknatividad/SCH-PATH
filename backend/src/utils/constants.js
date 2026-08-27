/**
 * System Constants
 * @module utils/constants
 * @description Centralized constants for SCH-PATH system
 */

/**
 * Resource configurations for database operations
 * @constant {Object}
 */
const RESOURCES = {
  accessRequests: {
    prefix: 'ACC',
    orderBy: 'createdAt DESC',
    jsonFields: [],
    columns: ['id', 'requesterId', 'requesterUsername', 'targetUserId', 'targetRole', 'residentId', 'moduleName', 'recordTab', 'reason', 'status', 'reviewedBy', 'reviewedAt', 'reviewerNote', 'createdAt', 'updatedAt'],
  },
  users: {
    prefix: 'U',
    orderBy: 'createdAt ASC',
    jsonFields: ['accessibleModules', 'childRecordTabs'],
    columns: ['id', 'username', 'password', 'role', 'accessibleModules', 'childRecordTabs', 'status', 'createdDate', 'createdBy', 'modifiedBy'],
  },
  children: {
    prefix: 'CH',
    orderBy: 'createdAt ASC',
    jsonFields: ['previousCases', 'documents', 'medicalRecords', 'behavioralLogs', 'assessments', 'phaseTasksCompleted'],
    columns: ['id', 'name', 'age', 'gender', 'admissionDate', 'legalCategory', 'caseType', 'status', 'casePhase', 'isRepeatOffender', 'previousCaseDetails', 'previousCases', 'birthDate', 'address', 'documentsComplete', 'documents', 'medicalRecords', 'lastCheckup', 'notes', 'behaviorNotes', 'guardianName', 'guardianContact', 'behavioralLogs', 'assessments', 'phaseTasksCompleted', 'needsPsychAssessment', 'readmissionDate', 'readmissionDatetime', 'createdBy', 'modifiedBy'],
  },
  staff: {
    prefix: 'ST',
    orderBy: 'createdAt ASC',
    jsonFields: ['documents'],
    columns: ['id', 'name', 'position', 'department', 'email', 'phone', 'status', 'joinDate', 'endDate', 'documents', 'createdBy', 'modifiedBy'],
  },
  activities: {
    prefix: 'ACT',
    orderBy: 'createdAt ASC',
    jsonFields: ['personInCharge', 'facilitators', 'participants', 'selectedResidentIds', 'recommendedResidentIds', 'notRecommendedResidentIds', 'notRecommendedReasons', 'violationIds'],
    columns: ['id', 'title', 'date', 'time', 'type', 'category', 'location', 'status', 'description', 'notes', 'personInCharge', 'facilitators', 'participants', 'selectedResidentIds', 'recommendedResidentIds', 'notRecommendedResidentIds', 'notRecommendedReasons', 'violationIds', 'createdBy', 'modifiedBy'],
  },
  assessments: {
    prefix: 'ASM',
    orderBy: 'createdAt DESC',
    jsonFields: ['forResidents'],
    columns: ['id', 'title', 'date', 'time', 'type', 'assessor', 'status', 'forResidents', 'description', 'results', 'triggeredBy', 'createdBy', 'modifiedBy'],
  },
  reports: {
    prefix: 'REP',
    orderBy: 'createdAt DESC',
    jsonFields: ['summary'],
    columns: ['id', 'title', 'type', 'date', 'generatedBy', 'status', 'summary', 'createdBy', 'modifiedBy'],
  },
  healthRecords: {
    prefix: 'HLT',
    orderBy: 'createdAt DESC',
    jsonFields: [],
    columns: ['id', 'residentId', 'residentName', 'recordType', 'date', 'assessmentType', 'findings', 'allergies', 'conditions', 'status', 'recordedBy', 'bloodPressure', 'temperature', 'weight', 'height', 'pulse', 'medicationName', 'dosage', 'frequency', 'prescribedBy', 'createdBy', 'modifiedBy'],
  },
  activityEvaluations: {
    prefix: 'EVAL',
    orderBy: 'createdAt DESC',
    jsonFields: [],
    columns: ['id', 'activityId', 'residentId', 'residentName', 'rating', 'remarks', 'dateEvaluated', 'createdBy', 'modifiedBy'],
  },
  violations: {
    prefix: 'VIO',
    orderBy: 'createdAt DESC',
    jsonFields: [],
    columns: ['id', 'residentId', 'date', 'type', 'description', 'severity', 'points', 'location', 'witnesses', 'reportedBy', 'reviewedBy', 'actionTaken', 'status', 'requiresAssessment', 'assessmentTriggered', 'createdBy', 'modifiedBy'],
  },
  alerts: {
    prefix: 'ALR',
    orderBy: 'createdAt DESC',
    jsonFields: [],
    columns: ['id', 'residentId', 'type', 'title', 'message', 'priority', 'isRead', 'readBy', 'readAt', 'actionRequired', 'actionTaken', 'relatedRecordType', 'relatedRecordId', 'targetRole'],
  },
  courtRecords: {
    prefix: 'CRT',
    orderBy: 'hearingDate ASC',
    jsonFields: [],
    columns: ['id', 'residentId', 'caseNumber', 'courtName', 'judge', 'prosecutor', 'publicAttorney', 'hearingType', 'hearingDate', 'hearingTime', 'courtOrder', 'nextHearingDate', 'status', 'notes', 'createdBy', 'modifiedBy'],
  },
  phaseProgress: {
    prefix: 'PHS',
    orderBy: 'enteredAt ASC',
    jsonFields: ['tasksRequired', 'tasksCompleted'],
    columns: ['id', 'residentId', 'phaseName', 'enteredAt', 'completedAt', 'tasksRequired', 'tasksCompleted', 'notes', 'enteredBy', 'completedBy', 'isCurrent', 'createdBy', 'modifiedBy'],
  },
  documents: {
    prefix: 'DOC',
    orderBy: 'createdAt DESC',
    jsonFields: [],
    columns: ['id', 'residentId', 'residentName', 'staffId', 'title', 'type', 'category', 'description', 'fileName', 'fileSize', 'filePath', 'fileData', 'fileType', 'uploaderRole', 'status', 'phase', 'requiredFor', 'submittedBy', 'submittedAt', 'uploadedBy', 'uploadedAt', 'reviewedBy', 'reviewedAt', 'approvedBy', 'approvedAt', 'rejectionReason', 'notes', 'createdBy', 'modifiedBy'],
  },
};

/**
 * Violation severity mapping with points
 * @constant {Object}
 */
const VIOLATION_SEVERITY = {
  Critical: { points: 5, label: 'Critical' },
  Major: { points: 3, label: 'Major' },
  Minor: { points: 1, label: 'Minor' },
};

/**
 * Assessment types for violation auto-creation
 * @constant {Object}
 */
const ASSESSMENT_TYPES = {
  VIOLENT: { type: 'Psychological', assessor: 'Psychologist', title: 'Crisis Intervention Assessment' },
  BEHAVIORAL: { type: 'Behavioral', assessor: 'Social Worker', title: 'Behavioral Assessment' },
  MEDICAL: { type: 'Medical', assessor: 'Nurse', title: 'Medical Assessment' },
  GENERAL: { type: 'Psychological', assessor: 'Psychologist', title: 'Psychological Assessment' },
};

/**
 * User roles in the system
 * @constant {Array<string>}
 */
const USER_ROLES = ['centerhead', 'socialworker', 'psychologist', 'nurse', 'educator'];

/**
 * Case phases
 * @constant {Array<string>}
 */
const CASE_PHASES = [
  'Admission Phase',
  'Orientation Phase',
  'Enculturation/Observation Phase',
  'Caring & Rehabilitation Phase / DP or IPP Implementation',
  'Pre-integration Phase',
  'Reintegration/Aftercare Program',
];

/**
 * Per-phase requirements (documents + tasks/checklist)
 * Observation phase uses checklist only (no required documents)
 * @constant {Object}
 */
const PHASE_REQUIREMENTS = {
  'Admission Phase': {
    requiredDocuments: [
      'Court Order',
      'OCP Resolution',
      'Case Information',
      'Diversion Plan Referral Letter',
      'Medical Certificate / Birth Certificate',
      'Baptismal Certificate',
    ],
    optionalDocuments: [
      'Psychological Assessment',
    ],
    requiredTasks: [],
    manualCompletion: false,
  },
  'Orientation Phase': {
    requiredDocuments: [],
    optionalDocuments: [],
    requiredTasks: [
      'Mark Orientation Complete',
    ],
    manualCompletion: true,
  },
  'Enculturation/Observation Phase': {
    requiredDocuments: [
      'Discernment Assessment',
      'Case Conference Form',
      'Home/School Visit Form',
    ],
    optionalDocuments: ['Psychological Testing'],
    requiredTasks: [
      'Conduct Observation',
      'Home Visit',
      'SCSR',
      'Case Conference',
    ],
    manualCompletion: false,
  },
  'Caring & Rehabilitation Phase / DP or IPP Implementation': {
    requiredDocuments: [
      'Casework / Groupwork',
    ],
    optionalDocuments: [
      'Monitoring Report',
      'Case Assistance Feedback Form',
      'Court Assistance Feedback Form',
    ],
    requiredTasks: [
      'Counseling Sessions',
      'Group Living Services',
      'Parent Visits',
      'Family Conferencing',
      'Sports / Values Formation',
    ],
    optionalTasks: ['Court Assistance'],
    manualCompletion: false,
  },
  'Pre-integration Phase': {
    requiredDocuments: [
      'Case Conference Form',
      'Parenting Capability Assessment',
    ],
    optionalDocuments: [],
    requiredTasks: [
      'Exit Case Conference',
    ],
    manualCompletion: false,
  },
  'Reintegration/Aftercare Program': {
    requiredDocuments: ['Discharge Form'],
    optionalDocuments: [],
    requiredTasks: [
      'Life Skills Sessions',
      'PES',
      'Family Planning',
      'Community involvement',
    ],
    manualCompletion: false,
  },
};

/**
 * Role-based document upload permissions
 * Maps document types to the roles allowed to upload them
 * @constant {Object}
 */
const DOCUMENT_ROLE_PERMISSIONS = {
  // Admission Phase documents
  'Court Order':                        ['socialworker', 'centerhead'],
  'OCP Resolution':                     ['socialworker', 'centerhead'],
  'Case Information':                   ['socialworker', 'centerhead'],
  'Diversion Plan Referral Letter':     ['socialworker', 'centerhead'],
  'Medical Certificate / Birth Certificate': ['socialworker', 'centerhead'],
  'Baptismal Certificate':              ['socialworker', 'centerhead'],
  'Psychological Assessment':           ['psychologist', 'centerhead'],
  // Enculturation/Observation Phase documents
  'Psychological Testing':              ['psychologist', 'centerhead'],
  'Discernment Assessment':             ['psychologist', 'centerhead'],
  'Case Conference Form':               ['socialworker', 'centerhead'],
  'Home/School Visit Form':             ['socialworker', 'educator', 'centerhead'],
  // Caring & Rehabilitation Phase documents
  'Casework / Groupwork':               ['socialworker', 'centerhead'],
  'Monitoring Report':                  ['socialworker', 'centerhead'],
  // Pre-integration Phase documents
  'Parenting Capability Assessment':    ['psychologist', 'centerhead'],
  'Case Assistance Feedback Form':      ['socialworker', 'centerhead'],
  'Court Assistance Feedback Form':      ['socialworker', 'centerhead'],
  'Discharge Form':                     ['socialworker', 'centerhead'],
  // General documents (kept for backwards compatibility)
  'Progress Report':                    ['socialworker', 'psychologist', 'nurse', 'educator', 'centerhead'],
  'Health Record Form':                 ['nurse', 'centerhead'],
  'Medical Certificate':                ['nurse', 'centerhead'],
};

/**
 * Violation → Assessment → Intervention decision matrix
 * Maps violation type keywords to automated actions
 * @constant {Array<Object>}
 */
const VIOLATION_MATRIX = [
  {
    id: 'VM001',
    keywords: ['fight', 'assault', 'aggress', 'violence', 'attack', 'harm', 'weapon'],
    severity: ['Major', 'Critical'],
    autoAssessment: { type: 'Psychological', assessor: 'Psychologist', title: 'Crisis Intervention Assessment' },
    intervention: 'Immediate psychological crisis intervention; isolate from peers; notify center head',
    escalate: true,
  },
  {
    id: 'VM002',
    keywords: ['drug', 'substance', 'alcohol', 'inhale', 'sniff'],
    severity: ['Critical'],
    autoAssessment: { type: 'Medical', assessor: 'Nurse', title: 'Substance Use Medical Assessment' },
    intervention: 'Medical assessment required; substance abuse counseling; notify psychologist and center head',
    escalate: true,
  },
  {
    id: 'VM003',
    keywords: ['escape', 'runaway', 'absent without leave', 'awol'],
    severity: ['Major', 'Critical'],
    autoAssessment: { type: 'Psychological', assessor: 'Psychologist', title: 'Risk & Safety Assessment' },
    intervention: 'Risk and safety assessment; review living arrangements; notify guardian and court',
    escalate: true,
  },
  {
    id: 'VM004',
    keywords: ['theft', 'steal', 'stolen', 'robbery'],
    severity: ['Major'],
    autoAssessment: { type: 'Behavioral', assessor: 'Social Worker', title: 'Behavioral Assessment' },
    intervention: 'Restitution plan; behavioral counseling; guardian notification',
    escalate: false,
  },
  {
    id: 'VM005',
    keywords: ['bully', 'harass', 'intimidate', 'threaten'],
    severity: ['Minor', 'Major'],
    autoAssessment: { type: 'Behavioral', assessor: 'Social Worker', title: 'Behavioral Assessment' },
    intervention: 'Mediation session; behavioral contract; monitor for recurrence',
    escalate: false,
  },
  {
    id: 'VM006',
    keywords: ['disrespect', 'defiance', 'insubordination', 'attitude', 'conduct'],
    severity: ['Minor'],
    autoAssessment: { type: 'Behavioral', assessor: 'Social Worker', title: 'Behavioral Assessment' },
    intervention: 'Counseling session; review behavioral plan; document incident',
    escalate: false,
  },
  {
    id: 'VM007',
    keywords: ['property', 'damage', 'destroy', 'vandal'],
    severity: ['Minor', 'Major'],
    autoAssessment: { type: 'Behavioral', assessor: 'Social Worker', title: 'Behavioral Assessment' },
    intervention: 'Restitution; community service within facility; guardian notification',
    escalate: false,
  },
];

/**
 * Resident status color thresholds based on violation points
 * @constant {Object}
 */
const RESIDENT_STATUS_THRESHOLDS = {
  GOOD:     { min: 0,  max: 2,  color: 'green',  label: 'Good Standing' },
  MODERATE: { min: 3,  max: 5,  color: 'yellow', label: 'Moderate Risk' },
  SEVERE:   { min: 6,  max: 9,  color: 'orange', label: 'Severe Risk' },
  CRITICAL: { min: 10, max: Infinity, color: 'red', label: 'Critical' },
};

module.exports = {
  RESOURCES,
  VIOLATION_SEVERITY,
  ASSESSMENT_TYPES,
  USER_ROLES,
  CASE_PHASES,
  PHASE_REQUIREMENTS,
  DOCUMENT_ROLE_PERMISSIONS,
  VIOLATION_MATRIX,
  RESIDENT_STATUS_THRESHOLDS,
};
