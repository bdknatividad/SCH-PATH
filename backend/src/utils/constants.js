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
    columns: ['id', 'requesterId', 'requesterUsername', 'requesterRole', 'targetUserId', 'targetRole', 'documentId', 'residentId', 'moduleName', 'recordTab', 'reason', 'status', 'reviewedBy', 'reviewedAt', 'reviewerNote', 'createdAt', 'updatedAt'],
  },
  users: {
    prefix: 'U',
    orderBy: 'createdAt ASC',
    jsonFields: ['accessibleModules', 'childRecordTabs', 'subModules'],
    columns: ['id', 'username', 'displayName', 'password', 'role', 'accessibleModules', 'childRecordTabs', 'subModules', 'status', 'createdDate', 'createdBy', 'modifiedBy'],
  },
  children: {
    prefix: 'CH',
    orderBy: 'createdAt ASC',
    jsonFields: ['previousCases', 'documents', 'medicalRecords', 'behavioralLogs', 'assessments', 'phaseTasksCompleted'],
    columns: ['id', 'name', 'age', 'gender', 'admissionDate', 'legalCategory', 'caseType', 'status', 'casePhase', 'isRepeatOffender', 'previousCaseDetails', 'previousCases', 'birthDate', 'address', 'documentsComplete', 'documents', 'medicalRecords', 'lastCheckup', 'notes', 'behaviorNotes', 'guardianName', 'guardianContact', 'behavioralLogs', 'assessments', 'phaseTasksCompleted', 'needsPsychAssessment', 'readmissionDate', 'readmissionDatetime', 'lrn', 'traineeNumber', 'createdBy', 'modifiedBy'],
  },
    admissions: {
    prefix: 'ADM',
    orderBy: 'admissionDate DESC',
    jsonFields: [],
    columns: [
      'id',
      'residentId',
      'admissionNumber',
      'admissionDate',
      'expectedDischargeDate',
      'name',
      'age',
      'sex',
      'birthDate',
      'religion',
      'address',
      'residentSignature',
      'residentImage',
      'guardianName',
      'guardianContact',
      'guardianAddress',
      'guardianSignature',
      'referringParty',
      'referringPartyContact',
      'referringPartySignature',
      'houseparentOnDuty',
      'houseparentSignature',
      'legalCategory',
      'specificOffense',
      'caseHistory',
      'status',
      'closedDate',
      'createdBy',
      'modifiedBy'
    ],
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
    jsonFields: ['forResidents', 'violationIds', 'psychosocialActivities'],
    columns: ['id', 'title', 'date', 'time', 'type', 'assessor', 'status', 'forResidents', 'description', 'results', 'triggeredBy', 'violationIds', 'interventionTrackerId', 'interventionRequirementId', 'schedulingMode', 'psychosocialActivities', 'createdBy', 'modifiedBy'],
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
    jsonFields: ['details'],
    // Must mirror the actual healthRecords table. The previous list referenced
    // vitals columns (bloodPressure/temperature/weight/height/pulse) that do
    // not exist, and omitted real columns, which silently dropped
    // treatmentType/procedure_/outcome/followUpDate/duration on every write.
    columns: ['id', 'residentId', 'residentName', 'recordType', 'date', 'assessmentType', 'findings', 'allergies', 'conditions', 'status', 'recordedBy', 'medicationName', 'dosage', 'frequency', 'duration', 'prescribedBy', 'treatmentType', 'procedure_', 'outcome', 'followUpDate', 'details', 'createdBy', 'modifiedBy'],
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
    columns: ['id', 'residentId', 'date', 'type', 'description', 'severity', 'points', 'location', 'witnesses', 'reportedBy', 'reviewedBy', 'actionTaken', 'status', 'requiresAssessment', 'assessmentTriggered', 'assessmentCompleted', 'offenseNumber', 'interventionStartDate', 'interventionMonth', 'clearedBy', 'clearedAt', 'incidentGroupId', 'guideId', 'createdBy', 'modifiedBy'],
  },
  alerts: {
    prefix: 'ALR',
    orderBy: 'createdAt DESC',
    jsonFields: [],
    columns: ['id', 'residentId', 'type', 'title', 'message', 'priority', 'isRead', 'readBy', 'readAt', 'actionRequired', 'actionTaken', 'relatedRecordType', 'relatedRecordId', 'targetRole', 'targetUserId', 'actorUsername', 'dedupeKey', 'createdAt', 'updatedAt'],
  },
  alertReads: {
    prefix: 'ARD',
    orderBy: 'readAt DESC',
    jsonFields: [],
    columns: ['alertId', 'userId', 'readAt'],
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
  education_records: {
    prefix: 'EDU',
    orderBy: 'createdAt DESC',
    jsonFields: ['files'],
    columns: ['id', 'residentId', 'name', 'age', 'gender', 'educationLevel', 'gradeSection', 'school', 'enrollmentDate', 'status', 'address', 'guardianName', 'guardianContact', 'notes', 'lrn', 'traineeNumber', 'files', 'createdBy', 'modifiedBy'],
  },
  education_progress_reports: {
    prefix: 'EPR',
    orderBy: 'createdAt DESC',
    jsonFields: [],
    columns: ['id', 'educationRecordId', 'residentId', 'month', 'subject', 'result', 'academicProgress', 'participation', 'strengths', 'areasForImprovement', 'overallDevelopment', 'schoolVisits', 'createdBy', 'modifiedBy'],
  },
  education_school_visits: {
    prefix: 'ESV',
    orderBy: 'visitDate DESC',
    jsonFields: [],
    columns: ['id', 'educationRecordId', 'residentId', 'visitDate', 'school', 'purpose', 'findings', 'fileName', 'fileData', 'createdBy', 'modifiedBy'],
  },
  education_monthly_reports: {
    prefix: 'EMR',
    orderBy: 'reportMonth DESC, createdAt DESC',
    jsonFields: ['reportData'],
    columns: ['id', 'educationRecordId', 'residentId', 'reportMonth', 'reportData', 'status', 'submittedBy', 'submittedAt', 'reviewedBy', 'reviewedAt', 'createdBy', 'modifiedBy'],
  },
  documents: {
    prefix: 'DOC',
    orderBy: 'createdAt DESC',
    jsonFields: [],
    columns: ['id', 'residentId', 'admissionId', 'residentName', 'staffId', 'assessmentId', 'title', 'type', 'category', 'documentCategory', 'description', 'fileName', 'fileSize', 'filePath', 'fileData', 'fileType', 'uploaderRole', 'status', 'revision', 'phase', 'requiredFor', 'submittedBy', 'submittedAt', 'uploadedBy', 'uploadedAt', 'reviewedBy', 'reviewedAt', 'approvedBy', 'approvedAt', 'rejectedBy', 'rejectedAt', 'rejectionReason', 'notes', 'createdBy', 'modifiedBy'],
  },
  // The Documents module's audit trail. One row per workflow transition; see
  // schema.sql for why the rejection note has to live here rather than only on
  // `documents`, which holds just the current decision.
  documentRevisions: {
    prefix: 'DOCREV',
    orderBy: 'createdAt ASC',
    jsonFields: ['snapshot'],
    columns: ['id', 'documentId', 'revision', 'action', 'status', 'actor', 'actorRole', 'reason', 'notes', 'snapshot', 'createdAt'],
  },
  // Quarterly Progress Report. Registered here mainly so the schema-contract
  // test verifies the declared columns really exist, and so `mapRow` knows
  // `identifyingInformation` is JSON. The report has its own controller
  // (quarterlyProgressReportController) because its permission model is
  // per-section, which the generic CRUD controller cannot express, and because
  // opening a report has to assemble it from other tables first.
  //
  // The period is a start/end date pair, not a quarter number: the official form
  // runs a three-month window beginning in June, so it does not line up with
  // calendar quarters.
  quarterlyProgressReports: {
    prefix: 'QPR',
    orderBy: 'periodStart DESC, updatedAt DESC',
    jsonFields: ['identifyingInformation'],
    columns: [
      'id', 'residentId', 'periodStart', 'periodEnd', 'periodLabel', 'identifyingInformation', 'status',
      'preparedByName', 'preparedBySignature', 'attestedByName', 'attestedBySignature',
      'notedByName', 'notedBySignature',
      'createdBy', 'updatedBy', 'submittedBy', 'submittedAt',
      'reviewedBy', 'reviewedAt', 'finalizedBy', 'finalizedAt', 'reviewNotes',
    ],
  },
  quarterlyProgressReportSections: {
    prefix: 'QRS',
    orderBy: 'sortOrder ASC',
    jsonFields: [],
    columns: [
      'id', 'reportId', 'aspectKey', 'aspectLabel', 'sortOrder',
      'assignedTo', 'assignedToName', 'assignedToRole',
      'assembledPresentLevel', 'assembledObservations', 'assembledInterventions',
      'presentLevel', 'observations', 'interventions', 'status',
      'signedByName', 'signature', 'returnedReason',
      'submittedBy', 'submittedAt', 'createdBy', 'updatedBy',
    ],
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
  VIOLENT: { type: 'Psychological', assessor: 'Psychological Staff', title: 'Crisis Intervention Assessment' },
  BEHAVIORAL: { type: 'Behavioral', assessor: 'Social Worker', title: 'Behavioral Assessment' },
  MEDICAL: { type: 'Medical', assessor: 'Nurse', title: 'Medical Assessment' },
  GENERAL: { type: 'Psychological', assessor: 'Psychological Staff', title: 'Psychological Assessment' },
};

/**
 * User roles in the system
 * @constant {Array<string>}
 */
const USER_ROLES = ['centerhead', 'admin', 'socialworker', 'psychologist', 'nurse', 'educator', 'houseparent'];

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
 * Phase requirements below are the canonical Phase Timeline configuration.
 * @constant {Object}
 */
/**
 * Legacy document-title aliases kept only for backwards compatibility with
 * documents that were already uploaded before the Phase Timeline names were
 * corrected. New uploads use the canonical names in PHASE_REQUIREMENTS.
 */
const LEGACY_DOCUMENT_ALIASES = {
  'Court order': ['Court Order'],
  'OCP resolution': ['OCP Resolution'],
  'Diversion plan referral letter': ['Diversion Plan Referral Letter'],
  'Medical Certificate': ['Medical Certificate / Birth Certificate'],
  'Birth/baptismal certificate': ['Baptismal Certificate'],
  'Psychological assessment (if needed)': ['Psychological Assessment'],
  'Discernment assessment': ['Discernment Assessment'],
  'Home Visit Form': ['Home/School Visit Form'],
  'Casework/group work': ['Casework / Groupwork'],
  'Parenting capability assessment': ['Parenting Capability Assessment'],
  'Court hearing assistance (optional)': ['Court Assistance', 'Court Assistance Feedback Form'],
};

const LEGACY_TASK_ALIASES = {
  'Orientation on house rules': ['Orientation on House Rules'],
  'Provision of hygiene kit': ['Provision of Hygiene Kit'],
  'Provision of clothes': ['Provision of Clothes'],
  'Room assignment': ['Room Assignment'],
  'Counseling sessions': ['Counseling Sessions'],
  'Group living services': ['Group Living Services'],
  'Family conferencing': ['Family Conferencing'],
  'Sports and values formation activities': ['Sports / Values Formation'],
};

const PHASE_REQUIREMENTS = {
  'Admission Phase': {
    requiredDocuments: [
      'Court order',
      'OCP resolution',
      'Case Information',
      'Diversion plan referral letter',
      'Medical Certificate',
      'Birth/baptismal certificate',
    ],
    optionalDocuments: [
      'Psychological assessment (if needed)',
    ],
    requiredTasks: [],
    manualCompletion: false,
  },
  'Orientation Phase': {
    requiredDocuments: [],
    optionalDocuments: [],
    requiredTasks: [
      'Orientation on house rules',
      'Provision of hygiene kit',
      'Provision of clothes',
      'Room assignment',
    ],
    manualCompletion: true,
  },
  'Enculturation/Observation Phase': {
    requiredDocuments: [
      'Discernment assessment',
      'Case Conference Form',
      'Home Visit Form',
      'SCSR',
    ],
    optionalDocuments: [],
    requiredTasks: [],
    manualCompletion: false,
  },
  'Caring & Rehabilitation Phase / DP or IPP Implementation': {
    requiredDocuments: [],
    optionalDocuments: [
      'Court hearing assistance (optional)',
    ],
    requiredTasks: [
      'Casework/group work',
      'Counseling sessions',
      'Group living services',
      'Family conferencing',
      'Sports and values formation activities',
    ],
    manualCompletion: false,
  },
  'Pre-integration Phase': {
    requiredDocuments: [
      'Parenting capability assessment',
      'Exit Case Conference Form',
    ],
    optionalDocuments: [],
    requiredTasks: [],
    manualCompletion: false,
  },
  'Reintegration/Aftercare Program': {
    requiredDocuments: ['Discharge Form'],
    optionalDocuments: [],
    requiredTasks: [],
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
  //
  // Each of the next three is declared twice, under its legacy lower-case title
  // and its title-case title. That is not cosmetic: the upload picker and the
  // Phase Timeline/Dashboard required-document lists send the title-case form,
  // and a missing key is not "nobody may upload it" — documentController.create()
  // skips its role guard entirely when the lookup returns undefined. With only
  // the lower-case keys present, any role could POST a "Court Order", an
  // "OCP Resolution" or a "Diversion Plan Referral Letter" straight through the
  // API. tests/document-access-request.test.js pins all three copies of this map
  // together so they cannot drift apart again.
  'Court order':                        ['socialworker', 'centerhead'],
  'Court Order':                        ['socialworker', 'centerhead'],
  'OCP resolution':                     ['socialworker', 'centerhead'],
  'OCP Resolution':                     ['socialworker', 'centerhead'],
  'Case Information':                   ['socialworker', 'centerhead'],
  'Diversion plan referral letter':     ['socialworker', 'centerhead'],
  'Diversion Plan Referral Letter':     ['socialworker', 'centerhead'],
  'Medical Certificate':                ['socialworker', 'nurse', 'centerhead'],
  // The laboratory slip a consultation produces. The Nurse orders and receives
  // it, and it is a medical record like any other, so it files into the
  // Documents module's Medical Records folder via the "laboratory" keyword.
  'Laboratory Results':                 ['nurse', 'centerhead'],
  'Medical Certificate / Birth Certificate': ['socialworker', 'centerhead'],
  'Birth/baptismal certificate':         ['socialworker', 'centerhead'],
  'Baptismal Certificate':              ['socialworker', 'centerhead'],
  
  'Psychological assessment (if needed)': ['psychologist', 'centerhead'],
  'Psychological Assessment':           ['psychologist', 'centerhead'],
  // Enculturation/Observation Phase documents
  'Psychological Testing':              ['psychologist', 'centerhead'],
  'Discernment assessment':              ['psychologist', 'centerhead'],
  'Discernment Assessment':             ['psychologist', 'centerhead'],
  // SCSR (Social Case Study Report) is declared in both frontend copies of this
  // map and listed as an Observation-phase document on the dashboard, but was
  // missing here. A missing key is not "nobody may upload it": create() skips
  // its role guard entirely when the lookup returns undefined, so any role
  // could POST an SCSR. Declared so the guard actually runs.
  'SCSR':                               ['socialworker', 'centerhead'],
  'Case Conference Form':               ['socialworker', 'centerhead'],
  'Exit Case Conference Form':          ['socialworker', 'centerhead'],
  'Home Visit Form':                     ['socialworker', 'centerhead'],
  // Legacy title retained for already-uploaded documents.
  'Home/School Visit Form':             ['socialworker', 'educator', 'centerhead'],
  'Quarterly Education Report':         ['educator', 'centerhead'],
  'Monthly Education Progress Report':  ['educator', 'centerhead'],
  // Published by the Quarterly Progress Report module when a reviewer finalizes
  // a report, so no role uploads it by hand — declared anyway, because a missing
  // key skips the guard in documentController.create() entirely.
  'Quarterly Progress Report':          ['socialworker', 'centerhead'],
  // Caring & Rehabilitation Phase documents
  'Casework/group work':                ['socialworker', 'centerhead'],
  // Legacy title retained for already-uploaded documents.
  'Casework / Groupwork':               ['socialworker', 'centerhead'],
  'Monitoring Report':                  ['socialworker', 'centerhead'],
  // Pre-integration Phase documents
  'Parenting capability assessment':    ['psychologist', 'centerhead'],
  'Parenting Capability Assessment':    ['psychologist', 'centerhead'],
  'Case Assistance Feedback Form':      ['socialworker', 'centerhead'],
  'Court hearing assistance (optional)': ['socialworker', 'centerhead'],
  // Legacy titles retained for already-uploaded documents.
  'Court Assistance':                  ['socialworker', 'centerhead'],
  'Court Assistance Feedback Form':    ['socialworker', 'centerhead'],
  'Discharge Form':                     ['socialworker', 'centerhead'],
  // General documents (kept for backwards compatibility)
  'Progress Report':                    ['socialworker', 'psychologist', 'nurse', 'educator', 'centerhead'],
  'Health Record Form':                 ['nurse', 'centerhead'],
  // Medical Certificate is also used by the Admission Timeline; retain nurse
  // access while allowing the existing Social Worker admission upload path.
  // Published by the Incident Report module (Form 08) and offered by the upload
  // picker. It was declared in the frontend copy of this map but missing here,
  // and a missing key is not "nobody may upload it": create() skips its role
  // guard entirely when the lookup returns undefined, so any role could POST an
  // Incident Report. Declared so the guard actually runs.
  'Incident Report':                    ['socialworker', 'psychologist', 'centerhead', 'admin'],
  'Other':                             ['socialworker', 'psychologist', 'nurse', 'educator', 'centerhead', 'admin'],
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
    autoAssessment: { type: 'Psychological', assessor: 'Psychological Staff', title: 'Crisis Intervention Assessment' },
    intervention: 'Immediate psychological crisis intervention; isolate from peers; notify center head',
    escalate: true,
  },
  {
    id: 'VM002',
    keywords: ['drug', 'substance', 'alcohol', 'inhale', 'sniff'],
    severity: ['Critical'],
    autoAssessment: { type: 'Medical', assessor: 'Nurse', title: 'Substance Use Medical Assessment' },
    intervention: 'Medical assessment required; substance abuse counseling; notify the Psychological Staff and the Center Head',
    escalate: true,
  },
  {
    id: 'VM003',
    keywords: ['escape', 'runaway', 'absent without leave', 'awol'],
    severity: ['Major', 'Critical'],
    autoAssessment: { type: 'Psychological', assessor: 'Psychological Staff', title: 'Risk & Safety Assessment' },
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
  LEGACY_DOCUMENT_ALIASES,
  LEGACY_TASK_ALIASES,
  DOCUMENT_ROLE_PERMISSIONS,
  VIOLATION_MATRIX,
  RESIDENT_STATUS_THRESHOLDS,
};
