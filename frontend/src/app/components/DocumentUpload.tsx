import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/app/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import { Textarea } from '@/app/components/ui/textarea';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Badge } from '@/app/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/app/components/ui/alert-dialog';
import { Upload, X, CheckCircle, FileText, Image, FileSpreadsheet, File, Lock, AlertTriangle, Folder, FolderOpen, ChevronDown, ChevronRight as ChevronRightIcon, Download, Archive, Filter, Eye, Printer, Search } from 'lucide-react';
import JSZip from 'jszip';
import { useData, DocumentWithApproval } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { useSubModuleTab } from '@/app/hooks/useSubModuleTab';
import { useSubModuleTabs } from '@/app/hooks/useSubModuleTabs';
import { usePermissions } from '@/app/hooks/usePermissions';
import { useSystemDialog } from '@/app/components/SystemDialog';
import { formatShortDate, formatShortDateTime } from '@/utils/dateFormatter';
import { DOCUMENT_FOLDERS, folderForDocument } from '@/utils/documentCategory';
import { admissionPeriodKeyFor, admissionPeriodsFor } from '@/utils/admissionPeriods';
import { downloadDocumentFile } from '@/utils/documentFile';
import { describeError, request, apiUrl, authHeaders } from '@/services/api';

/**
 * The largest file a person may upload, and the only place it is written down.
 *
 * Must stay within the server's JSON body limit. A file is sent base64-encoded,
 * which inflates it by about a third, so the body limit is deliberately larger
 * than this number — see the `express.json({ limit })` comment in
 * `backend/src/server.js`. Raising this without raising that rejects the upload
 * with a 413 before any handler runs, and the user sees a bare "Request failed".
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_LABEL = '10 MB';

const CASE_PHASES = [
  'Admission', 'Orientation', 'Observation', 'Rehabilitation',
  'Pre-integration', 'Reintegration',
];

const PHASE_NAME_MAP: Record<string, string> = {
  'Admission Phase': 'Admission',
  'Orientation Phase': 'Orientation',
  'Enculturation/Observation Phase': 'Observation',
  'Caring & Rehabilitation Phase / DP or IPP Implementation': 'Rehabilitation',
  'Pre-integration Phase': 'Pre-integration',
  'Reintegration/Aftercare Program': 'Reintegration',
};

const PHASE_REQUIREMENTS: Record<string, { requiredDocuments: string[]; optionalDocuments?: string[]; requiredTasks: string[] }> = {
  Admission: {
    requiredDocuments: ['Court order','OCP resolution','Case Information','Diversion plan referral letter','Medical Certificate','Birth/baptismal certificate'],
    optionalDocuments: ['Psychological assessment (if needed)'],
    requiredTasks: [],
  },
  Orientation: {
    requiredDocuments: [],
    requiredTasks: [],
  },
  Observation: {
    requiredDocuments: ['Discernment assessment','Case Conference Form','Home Visit Form','SCSR'],
    requiredTasks: [],
  },
  Rehabilitation: {
    requiredDocuments: [],
    // Court hearing assistance is optional, not required.
    optionalDocuments: ['Court hearing assistance (optional)'],
    requiredTasks: ['Casework/group work','Counseling sessions','Group living services','Family conferencing','Sports and values formation activities'],
  },
  'Pre-integration': {
    requiredDocuments: ['Parenting capability assessment','Exit Case Conference Form'],
    requiredTasks: [],
  },
  Reintegration: {
    requiredDocuments: ['Discharge Form'],
    requiredTasks: [],
  },
};

/**
 * Upload permission per document type.
 *
 * This must stay identical to the backend's copy in
 * `backend/src/utils/constants.js`. The two had drifted: this copy was missing
 * 'Psychological Testing', 'Casework / Groupwork', 'Monitoring Report',
 * 'Quarterly Education Report' and 'Monthly Education Progress Report'.
 *
 * A missing entry is NOT "nobody may upload it" — every lookup in this file
 * treats `undefined` as "allowed for every role" (`if (!allowedRoles || ...)`),
 * so the drift widened the upload picker to roles the backend then rejected
 * with a 403. The backend is the enforcement point; this map only decides what
 * the picker offers, so it has to agree.
 */
const DOCUMENT_ROLE_PERMISSIONS: Record<string, string[]> = {
  'Court order': ['socialworker','centerhead'],
  'Court Order': ['socialworker','centerhead'],
  'OCP resolution': ['socialworker','centerhead'],
  'OCP Resolution': ['socialworker','centerhead'],
  'Case Information': ['socialworker','centerhead'],
  'Diversion plan referral letter': ['socialworker','centerhead'],
  'Diversion Plan Referral Letter': ['socialworker','centerhead'],
  'Medical Certificate': ['socialworker','nurse','centerhead'],
  'Medical Certificate / Birth Certificate': ['socialworker','centerhead'],
  'Birth/baptismal certificate': ['socialworker','centerhead'],
  'Baptismal Certificate': ['socialworker','centerhead'],
  'Psychological assessment (if needed)': ['psychologist','centerhead'],
  'Psychological Assessment': ['psychologist','centerhead'],
  'Psychological Testing': ['psychologist','centerhead'],
  'Discernment assessment': ['psychologist','centerhead'],
  'Discernment Assessment': ['psychologist','centerhead'],
  'SCSR': ['socialworker','centerhead'],
  'Parenting capability assessment': ['psychologist','centerhead'],
  'Parenting Capability Assessment': ['psychologist','centerhead'],
  'Case Conference Form': ['socialworker','centerhead'],
  'Exit Case Conference Form': ['socialworker','centerhead'],
  'Home Visit Form': ['socialworker','centerhead'],
  'Home/School Visit Form': ['socialworker','educator','centerhead'],
  'Quarterly Education Report': ['educator','centerhead'],
  'Monthly Education Progress Report': ['educator','centerhead'],
  'Quarterly Progress Report': ['socialworker','centerhead'],
  'Casework/group work': ['socialworker','centerhead'],
  'Casework / Groupwork': ['socialworker','centerhead'],
  'Monitoring Report': ['socialworker','centerhead'],
  'Case Assistance Feedback Form': ['socialworker','centerhead'],
  'Court hearing assistance (optional)': ['socialworker','centerhead'],
  'Court Assistance': ['socialworker','centerhead'],
  'Court Assistance Feedback Form': ['socialworker','centerhead'],
  'Discharge Form': ['socialworker','centerhead'],
  'Progress Report': ['socialworker','psychologist','nurse','educator','centerhead'],
  'Health Record Form': ['nurse','centerhead'],
  'Incident Report': ['socialworker','psychologist','centerhead','admin'],
  'Other': ['socialworker','psychologist','nurse','educator','centerhead','admin'],
};

const getFileIcon = (fileName: string) => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (['pdf'].includes(ext || '')) return <FileText className="w-5 h-5 text-red-500" />;
  if (['jpg', 'jpeg', 'png', 'gif'].includes(ext || '')) return <Image className="w-5 h-5 text-blue-500" />;
  if (['doc', 'docx'].includes(ext || '')) return <FileText className="w-5 h-5 text-blue-700" />;
  if (['xls', 'xlsx'].includes(ext || '')) return <FileSpreadsheet className="w-5 h-5 text-green-600" />;
  return <File className="w-5 h-5 text-gray-500" />;
};

const formatFileSize = (bytes: number) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

function normalizeFileData(fileData: string | undefined, fileType?: string) {
  if (!fileData) return undefined;
  if (fileData.startsWith('data:') || fileData.startsWith('blob:') || fileData.startsWith('http://') || fileData.startsWith('https://')) {
    return fileData;
  }
  // Form 08 PDFs are stored by the backend as raw base64. Prefix them so
  // browser PDF viewers/iframes treat the value as an actual PDF instead of
  // navigating to the current application route.
  const mime = fileType || 'application/octet-stream';
  return `data:${mime};base64,${fileData}`;
}

/**
 * Fetches the stored binary and saves it under the document's real filename.
 * Shared with the Health module, which mirrors the medical documents — see
 * `utils/documentFile.ts`.
 */

/**
 * A row from `/access-requests`.
 *
 * The endpoint returns the caller's own requests in every state (so the
 * requester can see Pending / Approved / Rejected) plus every Pending request
 * the caller is entitled to decide, flagged with `canReview`. The document
 * metadata is joined in by the backend so the reviewer can judge the request
 * without loading the document list.
 */
interface AccessRequestRow {
  id: string;
  requesterId: string;
  requesterUsername: string;
  requesterRole?: string;
  targetRole?: string;
  documentId?: string;
  residentId?: string;
  reason: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  reviewedBy?: string;
  reviewedAt?: string;
  reviewerNote?: string;
  createdAt?: string;
  documentTitle?: string;
  documentFileName?: string;
  documentCategory?: string;
  residentName?: string;
  isRequester?: boolean;
  canReview?: boolean;
}

/**
 * One row of a document's audit trail, as returned by
 * `GET /api/documents/:id/history`.
 *
 * Every state change is recorded — who did it, when, and why — so a document's
 * whole life (including every rejection and resubmission) survives regardless of
 * what the document's *current* status happens to be.
 */
interface DocumentAuditEntry {
  id: string;
  documentId: string;
  revision?: number;
  action: string;
  status?: string;
  actor?: string;
  actorRole?: string;
  reason?: string;
  notes?: string;
  createdAt?: string;
}

const ROLE_LABEL_FALLBACK: Record<string, string> = {
  nurse: 'Nurse',
  psychologist: 'Psychologist',
  socialworker: 'Social Worker',
  educator: 'Educator',
  centerhead: 'Center Head',
  admin: 'Administrator',
  houseparent: 'Houseparent',
};

/**
 * Badge for a document the viewer cannot open.
 *
 * Three distinct states, not two. Before this, anything that was not Pending
 * collapsed to a grey "No Access" — so a Rejected request looked identical to a
 * request that was never made, and the rejection reason was invisible.
 */
function accessStatusBadge(status?: string) {
  if (status === 'Pending') return { label: 'Access Pending', className: 'bg-yellow-100 text-yellow-800' };
  if (status === 'Rejected') return { label: 'Request Rejected', className: 'bg-red-100 text-red-800' };
  return { label: 'No Access', className: 'bg-gray-100 text-gray-700' };
}

interface DocListProps {
  docs: (DocumentWithApproval & { canView?: boolean; accessRequestStatus?: string; accessRequestNote?: string })[];
  children: { id: string; name: string }[];
  canApprove: boolean;
  onApprove: (doc: DocumentWithApproval) => void;
  onReject: (doc: DocumentWithApproval) => void;
  onReassessment?: (doc: DocumentWithApproval) => void;
  onView: (doc: DocumentWithApproval) => void;
  onPrint?: (doc: DocumentWithApproval) => void;
  onRequestAccess: (doc: DocumentWithApproval) => void;
  onDelete: (doc: DocumentWithApproval) => void;
  getStatusBadge: (status: string) => React.ReactNode;
  getFileIcon: (name: string) => React.ReactNode;
  formatFileSize: (bytes: number) => string;
  emptyMessage?: string;
  /**
   * Whether the caller holds the `delete` capability on the Documents module.
   * This is a capability, not a role: the delete button used to be derived from
   * DOCUMENT_ROLE_PERMISSIONS, which answers "who may upload this document
   * type" and therefore let a role remove a document it had no business
   * touching. RBAC owns this decision now.
   */
  canDelete: boolean;
  deriveCategory?: (doc: DocumentWithApproval) => string;
  bulkMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
}

function DocumentList({ docs, children, canApprove, canDelete, onApprove, onReject, onReassessment, onView, onPrint, onRequestAccess, onDelete, getStatusBadge, getFileIcon, formatFileSize, emptyMessage, deriveCategory, bulkMode, selectedIds, onToggleSelect }: DocListProps) {
  // Declared before the empty-list return below: a hook after a conditional
  // return changes the number of hooks between renders.
  const dialog = useSystemDialog();
  if (docs.length === 0) {
    return (
      <Card>
        <CardContent className="p-12 text-center">
          <FileText className="w-12 h-12 mx-auto mb-4 text-gray-300" />
          <p className="text-gray-500">{emptyMessage || 'No documents found. Upload your first document.'}</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {docs.map((doc) => {
        const resident = children.find(c => c.id === doc.residentId);
        const category = deriveCategory?.(doc) || 'Other Documents';
        const isSelected = selectedIds?.has(doc.id);
        return (
          <Card key={doc.id} data-document-id={doc.id} className={`hover:shadow-md transition-shadow ${isSelected ? 'ring-1 ring-[#FFD100]' : ''}`}>
            <CardContent className="p-5">
              <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
                <div className="flex items-start gap-4 flex-1">
                  {bulkMode && onToggleSelect && (
                    <input
                      type="checkbox"
                      className="mt-2 shrink-0 w-4 h-4 accent-[#2F3E46]"
                      checked={isSelected}
                      onChange={() => onToggleSelect(doc.id)}
                    />
                  )}
                  <div className="p-2 bg-gray-50 rounded-lg shrink-0">{getFileIcon(doc.fileName || '')}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="font-semibold text-[#2F3E46] truncate">{doc.title}</h3>
                      {doc.canView === false ? (() => {
                        const access = accessStatusBadge(doc.accessRequestStatus);
                        return <Badge className={access.className}>{access.label}</Badge>;
                      })() : getStatusBadge(doc.title === 'Incident Report' && doc.status === 'Rejected' ? 'Failed' : doc.status)}
                      {doc.phase && (
                        <Badge variant="outline" className="text-[10px] text-gray-500 border-gray-300">{doc.phase}</Badge>
                      )}
                      <Badge variant="outline" className="text-[10px] text-[#2F3E46] border-[#2F3E46]/30 bg-[#2F3E46]/5">{category}</Badge>
                    </div>
                    {doc.description && <p className="text-sm text-gray-600 mb-1 line-clamp-2 whitespace-pre-line">{doc.description}</p>}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                      <span><strong>Resident:</strong> {resident?.name || 'Unknown'}</span>
                      {/* Some entries are records rather than uploads (e.g. an
                          Anecdotal Report published on submit), so the file
                          line is only rendered when there is actually a file —
                          otherwise it printed "undefined (0 Bytes)". */}
                      {doc.fileName && <span><strong>File:</strong> {doc.fileName} ({formatFileSize(doc.fileSize || 0)})</span>}
                      {(doc.submittedAt || doc.uploadedAt) && <span><strong>Submitted:</strong> {new Date(doc.submittedAt || doc.uploadedAt || '').toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}</span>}
                      {(doc.submittedBy || doc.uploadedBy) && (
                        <span><strong>Submitted by:</strong> {doc.submittedBy || doc.uploadedBy}{doc.uploaderRole ? ` (${ROLE_LABEL_FALLBACK[doc.uploaderRole] || doc.uploaderRole})` : ''}</span>
                      )}
                    </div>
                    {/* Who decided it — kept separate from the submitter line so a
                        document always shows both "who sent it" and "who acted on it". */}
                    {doc.status === 'Approved' && doc.approvedBy && (
                      <p className="text-xs text-green-600 mt-1">
                        ✓ <strong>Approved by</strong> {doc.approvedBy}{doc.approvedAt ? ` on ${new Date(doc.approvedAt).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}` : ''}
                      </p>
                    )}
                    {doc.status === 'Rejected' && (
                      <p className={`text-xs mt-1 ${doc.title === 'Incident Report' ? 'text-yellow-700' : 'text-red-600'}`}>
                        ✗ <strong>{doc.title === 'Incident Report' ? 'Failed' : 'Rejected'} by</strong> {doc.reviewedBy || 'Reviewer'}{doc.reviewedAt ? ` on ${new Date(doc.reviewedAt).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}` : ''}{doc.rejectionReason ? `: ${doc.rejectionReason}` : ''}
                      </p>
                    )}
                    {doc.canView === false && doc.accessRequestStatus === 'Rejected' && (
                      <p className="text-xs text-red-600 mt-1">
                        ✗ Access request rejected{doc.accessRequestNote ? `: ${doc.accessRequestNote}` : ''}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  {doc.canView === false ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRequestAccess(doc)}
                      disabled={doc.accessRequestStatus === 'Pending'}
                      title={doc.accessRequestStatus === 'Rejected' && doc.accessRequestNote
                        ? `Rejected: ${doc.accessRequestNote}`
                        : undefined}
                    >
                      {doc.accessRequestStatus === 'Pending' ? 'Access Pending' : 'Request Access'}
                    </Button>
                  ) : <Button variant="outline" size="sm" onClick={() => onView(doc)}>View</Button>}
                  {doc.canView !== false && <Button variant="outline" size="sm" onClick={() => onPrint?.(doc)} title="Print">Print</Button>}
                  {doc.canView !== false && (
                    <Button
                      variant="outline"
                      size="sm"
                      title="Download"
                      onClick={() => downloadDocumentFile(doc, (message) => { void dialog.failure('Could not download the document', message); })}
                    >
                      <Download className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  {canApprove && doc.status === 'Submitted' && (
                    <>
                      <Button variant="outline" size="sm" className="text-green-600 border-green-200 hover:bg-green-50" onClick={() => onApprove(doc)}>
                        <CheckCircle className="w-3.5 h-3.5 mr-1" /> Approve
                      </Button>
                      <Button variant="outline" size="sm" className="text-red-600 border-red-200 hover:bg-red-50" onClick={() => onReject(doc)}>
                        <X className="w-3.5 h-3.5 mr-1" /> Failed
                      </Button>
                      <Button variant="outline" size="sm" className="text-yellow-600 border-yellow-200 hover:bg-yellow-50" onClick={() => onReassessment?.(doc)}>
                        ↺ Reassessment
                      </Button>
                    </>
                  )}
                  {canDelete && (
                    <Button variant="outline" size="sm" className="text-red-500" onClick={() => onDelete(doc)}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function FolderDownloadButton({ doc }: { doc: DocumentWithApproval }) {
  const dialog = useSystemDialog();
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={() => downloadDocumentFile(doc, (message) => { void dialog.failure('Could not download the document', message); })}
      title="Download"
    >
      <Download className="w-3 h-3" />
    </Button>
  );
}

/**
 * One file inside a category folder.
 *
 * The spec for the folder view is that the review metadata is readable
 * *without opening the file*: document name, status, date submitted, submitted
 * by, approved by / rejected by, and the approval or rejection date. The
 * previous row printed a single run-on line of these — and omitted the
 * rejection entirely — so a reader had to open each file to find out whether it
 * had been rejected or by whom. Here they are labelled fields, and a rejection
 * carries its reason inline because that is what the submitter has to act on.
 */
interface FolderDocumentRowProps {
  doc: DocumentWithApproval & { canView?: boolean; accessRequestStatus?: string; accessRequestNote?: string };
  canApprove: boolean;
  canDelete: boolean;
  getStatusBadge: (status: string) => React.ReactNode;
  onView: () => void;
  onApprove: () => void;
  onFailed: () => void;
  onReassessment: () => void;
  onDelete: () => void;
  onHistory: () => void;
  onRequestAccess: () => void;
}

function FolderDocumentRow({
  doc, canApprove, canDelete, getStatusBadge,
  onView, onApprove, onFailed, onReassessment, onDelete, onHistory, onRequestAccess,
}: FolderDocumentRowProps) {
  // The most recent review outcome. A rejection is kept on the row even after a
  // resubmission, so `status` decides which of the two the reader is looking at
  // while the other stays in the audit trail.
  const isRejected = doc.status === 'Rejected';
  const decidedBy = isRejected
    ? (doc.rejectedBy || doc.reviewedBy)
    : (doc.approvedBy || doc.reviewedBy);
  const decidedAt = isRejected
    ? (doc.rejectedAt || doc.reviewedAt)
    : (doc.approvedAt || doc.reviewedAt);
  const submittedBy = doc.submittedBy || doc.uploadedBy;
  const submittedAt = doc.submittedAt || doc.uploadedAt;

  const field = (label: string, value: React.ReactNode, className = '') => (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className={`text-xs text-gray-700 truncate ${className}`}>{value || '—'}</p>
    </div>
  );

  return (
    <div className="px-3 py-3 hover:bg-gray-50">
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">{getFileIcon(doc.fileName || '')}</div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-gray-800 truncate">{doc.title}</p>
            {doc.canView === false ? (() => {
              const access = accessStatusBadge(doc.accessRequestStatus);
              return <Badge className={access.className}>{access.label}</Badge>;
            })() : getStatusBadge(isRejected && doc.title === 'Incident Report' ? 'Failed' : doc.status)}
            {Number(doc.revision) > 1 && (
              <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300 bg-amber-50">
                Revision {doc.revision}
              </Badge>
            )}
            {doc.phase && (
              <Badge variant="outline" className="text-[10px] text-gray-500 border-gray-300">{doc.phase}</Badge>
            )}
          </div>

          <p className="text-[10px] text-gray-400 mt-0.5">
            {doc.fileName ? `${doc.fileName} · ${formatFileSize(doc.fileSize || 0)}` : 'Record (no file attached)'}
          </p>

          {/* The review metadata, readable without opening the file. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5 mt-2">
            {field('Date Submitted', submittedAt ? formatShortDate(submittedAt) : '')}
            {field('Submitted By', submittedBy)}
            {field(isRejected ? 'Rejected By' : 'Approved By', decidedBy, isRejected ? 'text-red-600' : 'text-green-700')}
            {field(isRejected ? 'Rejection Date' : 'Approval Date', decidedAt ? formatShortDate(decidedAt) : '')}
          </div>

          {isRejected && doc.rejectionReason && (
            <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5">
              <p className="text-[10px] uppercase tracking-wide text-red-500 font-semibold">Reason for rejection</p>
              <p className="text-xs text-red-800 whitespace-pre-line">{doc.rejectionReason}</p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-1 shrink-0 justify-end">
          {doc.canView === false ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onRequestAccess}
              disabled={doc.accessRequestStatus === 'Pending'}
              title={doc.accessRequestStatus === 'Rejected' && doc.accessRequestNote
                ? `Rejected: ${doc.accessRequestNote}`
                : undefined}
            >
              {doc.accessRequestStatus === 'Pending' ? 'Access Pending' : 'Request Access'}
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={onView}>View</Button>
          )}
          {doc.canView !== false && <FolderDownloadButton doc={doc} />}
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs text-gray-600"
            onClick={onHistory}
            title="Audit history"
          >
            History
          </Button>
          {canApprove && (doc.status === 'Submitted' || doc.status === 'Under Review') && (
            <>
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-green-600" onClick={onApprove} title="Approve">✓ Approve</Button>
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-red-500" onClick={onFailed} title="Reject">✕ Reject</Button>
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-yellow-600" onClick={onReassessment} title="Reassessment">↺ Reassessment</Button>
            </>
          )}
          {/* The folder view must honour the same capability as the flat list —
              the delete button used to be unconditional here, letting any role
              remove any document. A rejected document is never deletable: the
              rejection and its reason are part of the record. */}
          {canDelete && !isRejected && (
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-red-500" onClick={onDelete} title="Delete">
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function DocumentUpload() {
  const { documents, addDocument, updateDocument, deleteDocument, children, refreshData } = useData();
  const { user } = useAuth();
  const { can } = usePermissions();
  const dialog = useSystemDialog();

  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<DocumentWithApproval | null>(null);
  const [documentToDelete, setDocumentToDelete] = useState<DocumentWithApproval | null>(null);

  const [filterResident, setFilterResident] = useState('all');
  const [filterCategory, setFilterCategory] = useState('all');
  // Search-by-name for the Documents Module (Folder and All Documents views).
  const [documentSearch, setDocumentSearch] = useState('');
  // Per-resident search inside each expanded folder card (Folder view), keyed
  // by the same nameKey the card itself is keyed on. Independent of the
  // toolbar search above — narrows only that one resident's own documents.
  const [folderSearchByChild, setFolderSearchByChild] = useState<Record<string, string>>({});
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [groupByType, setGroupByType] = useState(true);
  const [uploadResidentId, setUploadResidentId] = useState('');
  const [documentTitle, setDocumentTitle] = useState('');
  const [otherDocumentType, setOtherDocumentType] = useState('');
  const [description, setDescription] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [isRejectDialogOpen, setIsRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectTarget, setRejectTarget] = useState<DocumentWithApproval | null>(null);
  const [isReviewDialogOpen, setIsReviewDialogOpen] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<DocumentWithApproval | null>(null);
  const [reviewDecision, setReviewDecision] = useState<'Passed' | 'Failed' | 'Reassessment'>('Passed');
  const [reviewNotes, setReviewNotes] = useState('');
  // The audit trail for one document, loaded on demand. Every transition —
  // upload, submission, resubmission, approval, each rejection with its reason —
  // is a row here, so a rejection is never erased by a later approval.
  const [historyTarget, setHistoryTarget] = useState<DocumentWithApproval | null>(null);
  const [historyRows, setHistoryRows] = useState<DocumentAuditEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [isViewLoading, setIsViewLoading] = useState(false);
  const [requestableDocuments, setRequestableDocuments] = useState<DocumentWithApproval[]>([]);
  // documentId → the caller's own most decisive request state, so a card can
  // show "Access Pending" / "Request Rejected" (and why) rather than a bare
  // "No Access" that looks identical to never having asked.
  const [documentAccessStates, setDocumentAccessStates] = useState<Record<string, { status: string; reviewerNote?: string }>>({});
  const [accessRequests, setAccessRequests] = useState<AccessRequestRow[]>([]);
  const [accessRequestTarget, setAccessRequestTarget] = useState<DocumentWithApproval | null>(null);
  const [accessRequestReason, setAccessRequestReason] = useState('');
  const [isAccessRequestOpen, setIsAccessRequestOpen] = useState(false);
  const [isAccessRequestSubmitting, setIsAccessRequestSubmitting] = useState(false);
  const [accessRequestError, setAccessRequestError] = useState('');
  const [reviewRequestTarget, setReviewRequestTarget] = useState<AccessRequestRow | null>(null);
  const [reviewRequestDecision, setReviewRequestDecision] = useState<'Approved' | 'Rejected'>('Approved');
  const [reviewRequestNote, setReviewRequestNote] = useState('');
  const [isReviewRequestSubmitting, setIsReviewRequestSubmitting] = useState(false);
  const [reviewRequestError, setReviewRequestError] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Every child folder starts closed. The tree is an index of residents first;
  // opening a resident is a deliberate act, and a caseload of twenty children
  // would otherwise land as several hundred file rows on one screen.
  const [expandedChildren, setExpandedChildren] = useState<Record<string, boolean>>({});
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  // Admission periods are the level between a returning resident and their
  // category folders. Open by default: the whole reason the level exists is that
  // a file's admission must be visible, and a collapsed period would hide it
  // behind another click.
  const [expandedPeriods, setExpandedPeriods] = useState<Record<string, boolean>>({});

  const ROLE_LABELS: Record<string, string> = {
    nurse: 'Nurse',
    psychologist: 'Psychologist',
    socialworker: 'Social Worker',
    educator: 'Educator',
    centerhead: 'Center Head',
    admin: 'Administrator',
    general: 'General / Other',
    other: 'General / Other',
  };

  const toggleChild = (childId: string) => setExpandedChildren(prev => ({ ...prev, [childId]: !prev[childId] }));
  const toggleCategory = (key: string) => setExpandedCategories(prev => ({ ...prev, [key]: !prev[key] }));
  const togglePeriod = (key: string) => setExpandedPeriods(prev => ({ ...prev, [key]: !prev[key] }));

  useEffect(() => {
    refreshData();
    const refreshOnFocus = () => { refreshData(); };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, []);

  /**
   * Loads everything the access-request UI needs: the documents the caller may
   * ask for, and the access requests they are allowed to see. Called on mount,
   * when the document list changes, and again after a decision — an approval
   * must immediately move a document out of "Request Access" and into the
   * normal readable list, so local state is reloaded rather than patched.
   */
  const loadAccessData = useCallback(async () => {
    try {
      const [requestable, requests] = await Promise.all([
        request<{ success: boolean; data: DocumentWithApproval[] }>('/documents/requestable'),
        request<{ success: boolean; data: AccessRequestRow[] }>('/access-requests'),
      ]);
      setRequestableDocuments(requestable.data || []);
      setAccessRequests(requests.data || []);

      // Only the caller's OWN requests may colour their own document cards;
      // the same endpoint also returns requests they merely review.
      const rank: Record<string, number> = { Approved: 3, Pending: 2, Rejected: 1 };
      const states: Record<string, { status: string; reviewerNote?: string }> = {};
      (requests.data || []).filter(item => item.isRequester).forEach(item => {
        if (!item.documentId) return;
        const existing = states[item.documentId];
        if (existing && (rank[existing.status] || 0) >= (rank[item.status] || 0)) return;
        states[item.documentId] = { status: item.status, reviewerNote: item.reviewerNote };
      });
      setDocumentAccessStates(states);
    } catch {
      setRequestableDocuments([]);
      setAccessRequests([]);
    }
  }, []);

  useEffect(() => {
    loadAccessData();
  }, [loadAccessData, user, documents.length]);

  // Derived: resident's current phase and allowed docs for the logged-in role
  const uploadResident = useMemo(
    () => children.find(c => c.id === uploadResidentId) || null,
    [children, uploadResidentId]
  );
  const residentPhaseRaw = uploadResident?.casePhase || '';
  const residentPhase = PHASE_NAME_MAP[residentPhaseRaw] || residentPhaseRaw;
  const residentPhaseIndex = CASE_PHASES.indexOf(residentPhase);
  const userRole = (user?.role || '').toLowerCase();

  const allowedDocuments = useMemo(() => {
    if (!residentPhase) return [];
    const result: { doc: string; phase: string }[] = [];
    // Collect docs from current phase and all previous phases
    for (let i = 0; i <= residentPhaseIndex; i++) {
      const phase = CASE_PHASES[i];
      const req = PHASE_REQUIREMENTS[phase];
      if (!req) continue;
      // Only the document lists are read here. `requiredTasks` sits in the same
      // entry but names *phase tasks* ("Counseling sessions"), not document
      // types — folding it in offered task names as uploadable documents that
      // have no permission entry, which is exactly the state this map's
      // undefined-means-everyone rule turns into an open upload.
      const allDocs = [...req.requiredDocuments, ...(req.optionalDocuments || [])];
      for (const doc of allDocs) {
        const allowedRoles = DOCUMENT_ROLE_PERMISSIONS[doc];
        if (!allowedRoles || allowedRoles.includes(userRole)) {
          if (!result.find(r => r.doc === doc)) {
            result.push({ doc, phase });
          }
        }
      }
    }
    // "Other" is a generic document type available to any non-houseparent
    // uploader. Its exact document type is captured in the required Specify field.
    if (uploadResidentId && !result.find(r => r.doc === 'Other')) {
      result.push({ doc: 'Other', phase: 'General' });
    }
    return result;
  }, [residentPhase, residentPhaseIndex, userRole, uploadResidentId]);
  
  // Explicit element type: the folder view reads `canView`/`accessRequestStatus`
  // off these rows, and without the annotation TypeScript treats the two spread
  // variants as a union where the property may be missing.
  const documentsForDisplay = useMemo<(DocumentWithApproval & { canView?: boolean; accessRequestStatus?: string; accessRequestNote?: string })[]>(() => [
    ...documents.map(document => ({ ...document, canView: true })),
    ...requestableDocuments.map(document => {
      const access = documentAccessStates[document.id];
      return {
        ...document,
        canView: false,
        accessRequestStatus: access?.status,
        accessRequestNote: access?.reviewerNote,
      };
    }),
  ], [documents, requestableDocuments, documentAccessStates]);

  // Requests this user is entitled to decide. The backend only returns Pending
  // rows to a reviewer, so this filter is a belt-and-braces guard.
  const requestsToReview = useMemo(
    () => accessRequests.filter(row => row.canReview && row.status === 'Pending'),
    [accessRequests]
  );
  // The user's own requests, in every state, for the history panel.
  const myAccessRequests = useMemo(
    () => accessRequests.filter(row => row.isRequester),
    [accessRequests]
  );

  /**
   * The category folders, in the order the UI shows them.
   *
   * Documents are organised `Child → Document Category → File`. This list is
   * the canonical one from `config/documentCategories.json`, shared byte-for-byte
   * with the backend, and replaces the module's old ad-hoc buckets
   * ("Houseparent Record", "Court Document", "Admission Document") which no
   * longer described anything the backend actually stored.
   */
  const DOCUMENT_CATEGORIES = DOCUMENT_FOLDERS;

  /**
   * Which folder a document belongs in.
   *
   * A folder the API persisted is trusted so a document filed before a rule
   * changed does not silently move; anything else — including every legacy row
   * created before folders existed — is resolved from the document's own
   * `type`/`category`/title/file name.
   */
  function deriveDocumentCategory(doc: {
    documentCategory?: string;
    title?: string;
    type?: string;
    category?: string;
    fileName?: string;
  }): string {
    return folderForDocument(doc);
  }

  // Matches a document's name/title against the search bar's query. Applied
  // wherever documents are listed (Folder view and All Documents view), on
  // top of whatever the backend already scoped to the logged-in user.
  const matchesDocumentSearch = useCallback((doc: { title?: string }) => {
    const q = documentSearch.trim().toLowerCase();
    if (!q) return true;
    return String(doc.title || '').toLowerCase().includes(q);
  }, [documentSearch]);

  const filteredDocuments = useMemo(() => {
    let list = documentsForDisplay;
    if (filterResident && filterResident !== 'all') {
      list = list.filter(d => d.residentId === filterResident);
    }
    if (filterCategory && filterCategory !== 'all') {
      list = list.filter(d => deriveDocumentCategory(d) === filterCategory);
    }
    list = list.filter(matchesDocumentSearch);
    return list;
  }, [documentsForDisplay, filterResident, filterCategory, matchesDocumentSearch]);

  /**
   * How many documents the folder view has to show for the current resident
   * filter. "No folders at all" and "folders, but nothing filed in them" are
   * different states, so the folder view cannot reuse `filteredDocuments`
   * (which also applies the category filter the folder tree does not use).
   */
  const visibleDocumentsCount = useMemo(
    () => documentsForDisplay.filter(d =>
      children.some(c => c.id === d.residentId && (filterResident === 'all' || c.id === filterResident))
    ).filter(matchesDocumentSearch).length,
    [documentsForDisplay, children, filterResident, matchesDocumentSearch]
  );

  /**
   * Documents grouped under their category heading, in the canonical category
   * order. This is the "organised by type of file / form" view: a reader sees
   * every Houseparent Record together, every Assessment together, and so on.
   */
  const groupedDocuments = useMemo(() => {
    const groups = new Map<string, typeof filteredDocuments>();
    for (const doc of filteredDocuments) {
      const category = deriveDocumentCategory(doc);
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)!.push(doc);
    }
    // Canonical order first, then any category the canonical list does not know.
    const orderedKeys = [
      ...DOCUMENT_CATEGORIES.filter(c => groups.has(c)),
      ...[...groups.keys()].filter(c => !DOCUMENT_CATEGORIES.includes(c)),
    ];
    return orderedKeys.map(category => ({ category, docs: groups.get(category)! }));
  }, [filteredDocuments, filterCategory]);

  const toggleDocSelection = (id: string) => {
    setSelectedDocIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllSelection = () => {
    if (selectedDocIds.size === filteredDocuments.length && filteredDocuments.length > 0) {
      setSelectedDocIds(new Set());
    } else {
      setSelectedDocIds(new Set(filteredDocuments.map(d => d.id)));
    }
  };

  const downloadBulkZip = async () => {
    const docs = filteredDocuments.filter(d => selectedDocIds.has(d.id));
    if (docs.length === 0) return;
    setBulkDownloading(true);
    try {
      const zip = new JSZip();
      for (const doc of docs) {
        try {
          const res = await fetch(apiUrl(`/documents/${doc.id}/file`), {
            headers: authHeaders(),
          });
          if (!res.ok) continue;
          const blob = await res.blob();
          const fileName = doc.fileName || doc.title || `${doc.id}.pdf`;
          zip.file(fileName, blob);
        } catch {
          // Skip files that fail to download
        }
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `documents-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setBulkDownloading(false);
    }
  };

  const openAccessRequest = (document: DocumentWithApproval) => {
    setAccessRequestTarget(document);
    setAccessRequestReason('');
    setAccessRequestError('');
    setIsAccessRequestOpen(true);
  };

  /**
   * Load a document's audit trail.
   *
   * The trail is the authoritative record of every rejection, so it is read from
   * the server rather than reconstructed from the row's current status — a
   * document that was rejected and later approved must still show the rejection.
   */
  const openHistory = async (document: DocumentWithApproval) => {
    setHistoryTarget(document);
    setHistoryRows([]);
    setHistoryError('');
    setHistoryLoading(true);
    try {
      const res = await request<{ success: boolean; data: DocumentAuditEntry[] }>(`/documents/${document.id}/history`);
      setHistoryRows(res?.data || []);
    } catch (error: any) {
      setHistoryError(error?.message || 'Could not load the audit history.');
    } finally {
      setHistoryLoading(false);
    }
  };

  const submitAccessRequest = async () => {
    if (!accessRequestTarget || !accessRequestReason.trim()) {
      setAccessRequestError('A reason is required.');
      return;
    }
    setIsAccessRequestSubmitting(true);
    setAccessRequestError('');
    try {
      await request('/access-requests', {
        method: 'POST',
        body: JSON.stringify({ documentId: accessRequestTarget.id, reason: accessRequestReason.trim() }),
      });
      setDocumentAccessStates(prev => ({ ...prev, [accessRequestTarget.id]: { status: 'Pending' } }));
      setIsAccessRequestOpen(false);
      // Reload so the request also appears in the requester's own list, and so
      // a duplicate-Pending refusal from the server surfaces immediately.
      loadAccessData();
    } catch (error) {
      setAccessRequestError(error instanceof Error ? error.message : 'Unable to submit access request.');
    } finally {
      setIsAccessRequestSubmitting(false);
    }
  };

  const openReviewRequest = (row: AccessRequestRow, decision: 'Approved' | 'Rejected') => {
    setReviewRequestTarget(row);
    setReviewRequestDecision(decision);
    setReviewRequestNote('');
    setReviewRequestError('');
  };

  const submitReviewRequest = async () => {
    if (!reviewRequestTarget) return;
    setIsReviewRequestSubmitting(true);
    setReviewRequestError('');
    try {
      await request(`/access-requests/${reviewRequestTarget.id}/review`, {
        method: 'POST',
        body: JSON.stringify({
          decision: reviewRequestDecision,
          reviewerNote: reviewRequestNote.trim() || undefined,
        }),
      });
      setReviewRequestTarget(null);
      // An approval changes what the requester can read, so reload the document
      // list and the request list together instead of patching local state.
      await Promise.all([refreshData(), loadAccessData()]);
    } catch (error) {
      setReviewRequestError(error instanceof Error ? error.message : 'Unable to save the decision.');
    } finally {
      setIsReviewRequestSubmitting(false);
    }
  };
  
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > MAX_UPLOAD_BYTES) {
        void dialog.validation('That file is too large', {
          description: `Documents must be ${MAX_UPLOAD_LABEL} or smaller. Compress the file or split it, then upload it again.`,
        });
        return;
      }
      setSelectedFile(file);
    }
  };
  
  const handleUpload = async () => {
    setUploadError('');
    if (!selectedFile || !uploadResidentId || !documentTitle) {
      setUploadError('Please select a resident, document type, and file.');
      return;
    }
    if (documentTitle === 'Other' && !otherDocumentType.trim()) {
      setUploadError('Please specify the exact document type.');
      return;
    }
    if (!residentPhase) {
      setUploadError('Selected resident has no active phase.');
      return;
    }
    // Determine phase for this document
    const docEntry = allowedDocuments.find(a => a.doc === documentTitle);
    const docPhase = docEntry?.phase || residentPhase;

    setIsUploading(true);
    setUploadProgress(0);

    const progressInterval = setInterval(() => {
      setUploadProgress(prev => Math.min(prev + 10, 90));
    }, 200);

    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Data = reader.result as string;
        const newDocument: Omit<DocumentWithApproval, 'id'> = {
          residentId: uploadResidentId,
          residentName: uploadResident?.name || '',
          category: docEntry?.phase ? `${docEntry.phase} - Required` : 'General',
          title: documentTitle === 'Other' ? otherDocumentType.trim() : documentTitle,
          type: documentTitle === 'Other' ? 'Other' : undefined,
          phase: docPhase,
          description: description || undefined,
          fileName: selectedFile.name,
          fileSize: selectedFile.size,
          fileData: base64Data,
          fileType: selectedFile.type,
          status: 'Submitted',
          uploaderRole: userRole,
          uploadedBy: user?.username || 'System',
          uploadedAt: new Date().toISOString(),
        };
        try {
          await addDocument(newDocument);
          clearInterval(progressInterval);
          setUploadProgress(100);
          setTimeout(() => { setIsUploading(false); setIsUploadDialogOpen(false); resetForm(); }, 500);
        } catch (err: any) {
          clearInterval(progressInterval);
          setIsUploading(false);
          setUploadError(err.message || 'Upload failed.');
        }
      };
      reader.readAsDataURL(selectedFile);
    } catch {
      clearInterval(progressInterval);
      setIsUploading(false);
      setUploadError('Failed to read file.');
    }
  };
  
  const resetForm = () => {
    setUploadResidentId('');
    setDocumentTitle('');
    setOtherDocumentType('');
    setDescription('');
    setSelectedFile(null);
    setUploadProgress(0);
    setUploadError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  
  const handleView = async (doc: DocumentWithApproval) => {
    setIsViewLoading(true);
    try {
      // Fetch the file as binary instead of embedding database base64 directly.
      // This is especially important for Form 08 PDFs generated by the backend.
      const res = await fetch(apiUrl(`/documents/${doc.id}/file`), {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error('Unable to load document file.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setSelectedDocument({ ...doc, fileData: url });
    } catch (error: any) {
      // Fallback for legacy files that are still returned as base64.
      try {
        const res = await fetch(apiUrl(`/documents/${doc.id}`), {
          headers: authHeaders(),
        });
        const json = await res.json();
        const fileData = json?.data?.fileData || json?.fileData || null;
        if (!fileData) throw new Error('Document file is not available.');
        setSelectedDocument({ ...doc, fileData: normalizeFileData(fileData, doc.fileType) });
      } catch {
        setSelectedDocument(doc);
      }
    } finally {
      setIsViewLoading(false);
      setIsViewDialogOpen(true);
    }
  };

  const handlePrint = async (doc: DocumentWithApproval) => {
    try {
      const res = await fetch(apiUrl(`/documents/${doc.id}/file`), {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error('Unable to load document for printing.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const w = window.open(url, '_blank', 'width=900,height=900');
      if (!w) {
        URL.revokeObjectURL(url);
        throw new Error('Please allow pop-ups to print documents.');
      }
      setTimeout(() => { try { w.print(); } catch {} }, 1200);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error: any) {
      void dialog.failure('Could not print the document', describeError(error, 'Unable to print the document.'));
    }
  };

  /**
   * Resolves the document an access request points at, so an approved row can
   * offer View / Print / Download without the caller hunting for it in another
   * tab. Returns undefined when the document is not in the caller's list — the
   * list is itself permission-scoped, so that is a real state and not a bug.
   */
  const documentForRequest = (row: AccessRequestRow): DocumentWithApproval | undefined =>
    row.documentId ? documents.find(doc => doc.id === row.documentId) : undefined;

  /**
   * The four approval outcomes, each through the endpoint written for it.
   *
   * These used to `PUT` the fields onto the row from the browser. That skipped
   * everything the endpoints do besides the write — the audit entry, the
   * "pending review" alert being cleared for the reviewer, and the notification
   * back to whoever submitted the file — and, because `updateDocument` reports a
   * failure through the shared store rather than to its caller, a failed
   * approval looked exactly like a successful one. Going through the API is what
   * makes the outcome something this screen can actually report.
   *
   * `Reassessment` has no endpoint of its own, so it stays a plain update.
   */
  const handleApprove = async (document: DocumentWithApproval) => {
    const confirmed = await dialog.confirm({
      title: 'Approve this document?',
      description: `“${document.title}” becomes part of the resident's official record and is readable by everyone entitled to that category. This cannot be undone — reject it instead if something is wrong.`,
      confirmLabel: 'Approve document',
      tone: 'warning',
    });
    if (!confirmed) return;
    try {
      await request(`/documents/${document.id}/approve`, { method: 'POST' });
      await refreshData();
      await dialog.success('Document approved.', `“${document.title}” is approved and filed.`);
    } catch (err) {
      await dialog.failure('Could not approve the document', describeError(err, 'The document was not approved. Please try again.'));
    }
  };

  const handleReviewSubmit = async () => {
    if (!reviewTarget) return;
    const document = reviewTarget;
    // The API refuses a rejection with no reason, and rightly so: the submitter
    // would be told to correct the file with nothing to act on.
    if (reviewDecision !== 'Passed' && !reviewNotes.trim()) {
      void dialog.validation('Add a note for the submitter', {
        description: reviewDecision === 'Failed'
          ? 'Say what is wrong with the document so it can be corrected.'
          : 'Say what the submitter needs to add or change before it is reviewed again.',
      });
      return;
    }

    // Close this form *before* the request, not after it.
    //
    // The success dialog is shown from this same handler. Closing the form
    // afterwards leaves its Radix layer mounted while the success dialog opens,
    // and Radix then judges the success dialog "not the top layer" and inlines
    // `pointer-events: none` on it — the OK button stops responding and only Esc
    // gets you out. Closing first also means the reviewer sees the outcome
    // against the list they were working on, rather than on top of a form that
    // has already been submitted.
    const notes = reviewNotes.trim();
    setIsReviewDialogOpen(false);
    setReviewTarget(null);
    setReviewNotes('');

    try {
      if (reviewDecision === 'Passed') {
        await request(`/documents/${document.id}/approve`, { method: 'POST' });
      } else if (reviewDecision === 'Failed') {
        await request(`/documents/${document.id}/reject`, {
          method: 'POST',
          body: JSON.stringify({ rejectionReason: notes }),
        });
      } else {
        await updateDocument(document.id, {
          status: 'Reassessment' as any,
          reviewedBy: user?.username,
          rejectionReason: `Reassessment required. ${notes}`,
        });
      }
      await refreshData();
      await dialog.success(
        reviewDecision === 'Passed'
          ? 'Document approved.'
          : reviewDecision === 'Failed'
            ? 'Document rejected.'
            : 'Document sent for reassessment.',
        reviewDecision === 'Passed'
          ? `“${document.title}” is approved and filed.`
          : `“${document.title}” was returned with your note, and the submitter has been notified.`,
      );
    } catch (err) {
      await dialog.failure(
        'Could not save the decision',
        describeError(err, 'The decision was not saved. Please try again.'),
      );
    }
  };

  const handleReject = async () => {
    if (!rejectTarget) return;
    const document = rejectTarget;
    if (!rejectReason.trim()) {
      void dialog.validation('Add a reason for the rejection', {
        description: 'The submitter is told to correct the document, so they need to know what is wrong with it.',
      });
      return;
    }
    const reason = rejectReason.trim();
    // Close the form before the first await, not after the request. `refreshData()`
    // is a second await, so closing afterwards keeps this Radix layer mounted for
    // the whole round trip — and the failure path below never closed it at all.
    // A still-mounted layer is what makes Radix inline `pointer-events: none` on
    // the outcome dialog — see ui/modalLayer.ts.
    setIsRejectDialogOpen(false);
    setRejectReason('');
    setRejectTarget(null);
    try {
      await request(`/documents/${document.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ rejectionReason: reason }),
      });
      await refreshData();
      await dialog.success('Document rejected.', `“${document.title}” was returned with your reason, and the submitter has been notified.`);
    } catch (err) {
      await dialog.failure('Could not reject the document', describeError(err, 'The document was not rejected. Please try again.'));
    }
  };

  const openRejectDialog = (doc: DocumentWithApproval) => {
    setRejectTarget(doc);
    setRejectReason('');
    setIsRejectDialogOpen(true);
  };
  
  const handleDelete = async () => {
    if (!documentToDelete) return;
    await deleteDocument(documentToDelete.id);
    setIsDeleteDialogOpen(false);
    setDocumentToDelete(null);
  };
  
  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'Approved':
        return <Badge className="bg-green-100 text-green-800">Approved</Badge>;
      case 'Rejected':
        return <Badge className="bg-red-100 text-red-800">Rejected</Badge>;
      case 'Failed':
        return <Badge className="bg-yellow-100 text-yellow-800">Failed</Badge>;
      case 'Reassessment':
        return <Badge className="bg-yellow-100 text-yellow-800">For Reassessment</Badge>;
      case 'Under Review':
        return <Badge className="bg-yellow-100 text-yellow-800">Under Review</Badge>;
      case 'Submitted':
        return <Badge className="bg-blue-100 text-blue-800">Submitted</Badge>;
      default:
        return <Badge className="bg-gray-100 text-gray-800">Draft</Badge>;
    }
  };
  
  // Approving and deleting are *capabilities*, not per-document-type upload
  // rights. `DOCUMENT_ROLE_PERMISSIONS` answers "who may upload a Psychological
  // Assessment" — using it as a delete authority handed the Delete button to the
  // Psychologist, whose spec forbids deleting documents outright.
  const canApprove = can('Documents', 'approve');
  const canDeleteDocuments = can('Documents', 'delete');
  const pendingDocs = documents.filter(d => d.status === 'Submitted' || d.status === 'Under Review');

  // The module's tabs, as the RBAC definition declares them. `?tab=` remains a
  // deep link so a notification can open the right one directly, and a link to a
  // tab this account may not open simply falls back to the first reachable one.
  //
  // Default is 'folders': the module's own filing structure is Child → Category
  // → File, so the folder tree is the way into it. Every child folder starts
  // closed (see the tree below), which keeps the landing view a short index of
  // residents rather than a wall of files. "All Documents" is one click away and
  // carries the flat, filterable list.
  const tabs = useSubModuleTabs('Documents');
  const tabKeys = useMemo(() => tabs.map((tab) => tab.key), [tabs]);
  const [activeTab, setActiveTab] = useSubModuleTab(tabKeys, tabKeys[0] ?? 'folders');

  /**
   * Access Request History — the completed decisions.
   *
   * `loadAccessData` above covers the Pending queue and the caller's own
   * requests, and a decision leaves that list the moment it is taken. This is
   * the permanent record behind the "Access Request History" submenu: every
   * Approved / Rejected request the caller is entitled to see, filterable by
   * outcome so the record can be narrowed without losing any of it.
   *
   * Fetched only when the account actually holds the submenu. The endpoint is
   * gated on that same submenu, so asking on behalf of any other role would only
   * log a 403. `accessRequests` is a dependency because a decision reloads it —
   * which is exactly when the history has a new row to show.
   */
  const canReadHistory = tabKeys.includes('history');
  const [accessHistory, setAccessHistory] = useState<AccessRequestRow[]>([]);
  const [historyFilter, setHistoryFilter] = useState<'All' | 'Approved' | 'Rejected'>('All');
  const [accessHistoryLoading, setAccessHistoryLoading] = useState(false);

  useEffect(() => {
    if (!canReadHistory) {
      setAccessHistory([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setAccessHistoryLoading(true);
      try {
        const result = await request<{ success: boolean; data: AccessRequestRow[] }>(
          `/access-requests/history?status=${historyFilter}`,
        );
        if (!cancelled) setAccessHistory(result.data || []);
      } catch {
        if (!cancelled) setAccessHistory([]);
      } finally {
        if (!cancelled) setAccessHistoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canReadHistory, historyFilter, user, accessRequests]);

  /**
   * One category folder inside the tree — Child → Category → File, and now also
   * Child → Admission Period → Category → File.
   *
   * A function rather than a component so a returning resident's two levels can
   * share it: the folder body is identical whether it hangs off the child or off
   * one of their admission periods, and the only thing that changes is the key
   * prefix that keeps the open/closed state of the two levels apart.
   */
  /** "1st", "2nd", "3rd", "4th Admission", ... — used only on the Admission
   * Files folder, so it always reads which admission cycle it belongs to. */
  const admissionOrdinalLabel = (n: number): string => {
    const rem100 = n % 100;
    const suffix = rem100 >= 11 && rem100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
    return `${n}${suffix} Admission`;
  };

  const renderCategoryFolder = (
    keyPrefix: string,
    folder: string,
    folderDocs: typeof documentsForDisplay,
    admissionOrdinal?: number,
    admissionClosed = false,
  ) => {
    const folderKey = `${keyPrefix}::${folder}`;
    // Open by default: the whole point of the folder view is that the status and
    // the review metadata are visible without drilling in.
    const isFolderOpen = expandedCategories[folderKey] ?? true;
    return (
      <div key={folderKey} className="border border-gray-200 rounded-lg overflow-hidden bg-white">
        <button
          className="w-full flex items-center gap-2 px-3 py-2 bg-gray-100 hover:bg-gray-200 transition-colors text-sm"
          onClick={() => toggleCategory(folderKey)}
        >
          {isFolderOpen
            ? <FolderOpen className="w-4 h-4 text-[#2F3E46]" />
            : <Folder className="w-4 h-4 text-[#2F3E46]" />}
          <span className="font-medium text-gray-700 flex-1 text-left">
            {folder}
            {folder === 'Admission Files' && admissionOrdinal != null && (
              <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-[#2F3E46] bg-[#FFD100]/60 px-2 py-0.5 rounded-full align-middle">
                {admissionOrdinalLabel(admissionOrdinal)}
              </span>
            )}
          </span>
          <span className="text-xs text-gray-400 mr-1">{folderDocs.length} file{folderDocs.length !== 1 ? 's' : ''}</span>
          {isFolderOpen ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRightIcon className="w-3.5 h-3.5 text-gray-400" />}
        </button>
        {isFolderOpen && (
          <div className="divide-y divide-gray-100">
            {admissionClosed && folderDocs.length > 0 && (
              <p className="px-3 py-2 text-[11px] text-gray-500 bg-gray-50 italic">
                This admission has been closed. Its documents are kept as the historical
                record of that stay and can no longer be edited or removed.
              </p>
            )}
            {folderDocs.map(doc => (
              <FolderDocumentRow
                key={doc.id}
                doc={doc}
                canApprove={canApprove && !admissionClosed}
                canDelete={canDeleteDocuments && !admissionClosed}
                getStatusBadge={getStatusBadge}
                onView={() => handleView(doc)}
                onApprove={() => handleApprove(doc)}
                onFailed={() => { setReviewTarget(doc); setReviewDecision('Failed'); setReviewNotes(''); setIsReviewDialogOpen(true); }}
                onReassessment={() => { setReviewTarget(doc); setReviewDecision('Reassessment'); setReviewNotes(''); setIsReviewDialogOpen(true); }}
                onDelete={() => { setDocumentToDelete(doc); setIsDeleteDialogOpen(true); }}
                onHistory={() => openHistory(doc)}
                onRequestAccess={() => openAccessRequest(doc)}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-[#2F3E46]">Document Management</h2>
          <p className="text-gray-600">Upload, review, and manage resident documents</p>
        </div>
        <Button className="flex items-center gap-2 bg-[#2F3E46]" onClick={() => setIsUploadDialogOpen(true)}>
          <Upload className="w-4 h-4" />
          <span>Upload Document</span>
        </Button>
      </div>
      
      {/* Pending review alert for Center Head */}
      {canApprove && pendingDocs.length > 0 && (
        <div className="flex items-center gap-3 p-3 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-800">
          <CheckCircle className="w-4 h-4 shrink-0 text-blue-500" />
          <span><strong>{pendingDocs.length} document{pendingDocs.length > 1 ? 's' : ''}</strong> awaiting your review and approval.</span>
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(value) =>
          setActiveTab(value as 'folders' | 'all' | 'pending' | 'access' | 'history')
        }
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* Four tab labels overflow a phone; the list scrolls instead.
              Which tabs exist is the RBAC definition's answer, not a role check
              here: the Psychologist holds Folders by Child / All Documents /
              Access Requests and no global review queue. */}
          <TabsList className="max-w-full justify-start overflow-x-auto">
            {tabs.map((tab) => {
              if (tab.key === 'folders') {
                return <TabsTrigger key={tab.key} value="folders" className="shrink-0">📁 {tab.label}</TabsTrigger>;
              }
              if (tab.key === 'all') {
                return <TabsTrigger key={tab.key} value="all" className="shrink-0">All Documents ({documents.length})</TabsTrigger>;
              }
              if (tab.key === 'pending') {
                // The review queue needs the submenu *and* the capability. A
                // stored per-account grant can hand a role the tab, but approval
                // authority is what decides whether there is anything behind it —
                // and the Psychologist is never granted global approval.
                if (!canApprove) return null;
                return (
                  <TabsTrigger key={tab.key} value="pending" className="relative shrink-0">
                    {tab.label}
                    {pendingDocs.length > 0 && (
                      <span className="ml-1.5 bg-blue-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{pendingDocs.length}</span>
                    )}
                  </TabsTrigger>
                );
              }
              if (tab.key === 'access') {
                return (
                  <TabsTrigger key={tab.key} value="access" className="relative shrink-0">
                    {tab.label}
                    {requestsToReview.length > 0 && (
                      <span className="ml-1.5 bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{requestsToReview.length}</span>
                    )}
                  </TabsTrigger>
                );
              }
              if (tab.key === 'history') {
                return (
                  <TabsTrigger key={tab.key} value="history" className="relative shrink-0">
                    {tab.label}
                    {accessHistory.length > 0 && (
                      <span className="ml-1.5 bg-slate-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{accessHistory.length}</span>
                    )}
                  </TabsTrigger>
                );
              }
              return <TabsTrigger key={tab.key} value={tab.key} className="shrink-0">{tab.label}</TabsTrigger>;
            })}
          </TabsList>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {/* Search by document name/title — applies to the Folder and All
                Documents views, scoped to whatever documentsForDisplay already
                limits the logged-in user to. */}
            <div className="relative w-full sm:w-56">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                value={documentSearch}
                onChange={(e) => setDocumentSearch(e.target.value)}
                placeholder="Search documents by name"
                className="pl-8"
              />
            </div>
            {/* Resident filter (only for flat views) */}
            <Select value={filterResident} onValueChange={setFilterResident}>
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder="All Residents" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Residents</SelectItem>
                {children.map((child) => (
                  <SelectItem key={child.id} value={child.id}>{child.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* FOLDER VIEW — Child → Document Category → File.
            This used to nest files under the account that uploaded them (and
            under an "1st/2nd Admission" bucket), which made one child's record
            impossible to read: the same category was scattered across as many
            folders as there were uploaders. A document is filed by category now,
            and every file row carries its own review metadata. */}
        <TabsContent value="folders" className="mt-4">
          <div className="space-y-3">
            {(() => {
              const filteredChildren = children.filter(c =>
                filterResident === 'all' || c.id === filterResident
              );

              // A returning resident has one DB record per admission. They share
              // a single root folder keyed by name so their whole record reads as
              // one child, which is what "Child Name → Category → Files" means.
              const byName: Record<string, typeof children> = {};
              filteredChildren.forEach(c => {
                const key = c.name.trim().toLowerCase();
                if (!byName[key]) byName[key] = [];
                byName[key].push(c);
              });

              const visibleDocs = documentsForDisplay
                .filter(d => filteredChildren.some(c => c.id === d.residentId))
                .filter(matchesDocumentSearch);

              if (Object.keys(byName).length === 0) {
                return (
                  <Card>
                    <CardContent className="p-12 text-center">
                      <Folder className="w-12 h-12 mx-auto mb-4 text-gray-300" />
                      <p className="text-gray-500">No residents to show.</p>
                    </CardContent>
                  </Card>
                );
              }

              return Object.entries(byName).map(([nameKey, residents]) => {
                const allResidentIds = residents.map(r => r.id);
                const allDocs = visibleDocs.filter(d => allResidentIds.includes(d.residentId || ''));
                if (allDocs.length === 0 && filterResident === 'all') return null;

                const displayName = residents[0].name;
                const isChildOpen = expandedChildren[nameKey] ?? false;
                const childSearchQuery = folderSearchByChild[nameKey] || '';
                const childDocsMatchingSearch = childSearchQuery.trim()
                  ? allDocs.filter(d => String(d.title || '').toLowerCase().includes(childSearchQuery.trim().toLowerCase()))
                  : allDocs;

                /**
                 * The admission history lives on whichever row carries it. A
                 * re-admission writes `previousCases` onto the resident's own
                 * row, so a resident with history is a returning resident; the
                 * `residents.length > 1` case is the legacy shape where the same
                 * name exists as two rows, and the readmission cutoff on either
                 * of them is still the boundary that separates the two.
                 */
                const historyRow = residents.find(r => Array.isArray(r.previousCases) && r.previousCases.length > 0);
                const periods = admissionPeriodsFor(historyRow);
                const splitByAdmission = periods.length > 1;
                const isReturning = splitByAdmission
                  || residents.length > 1
                  || residents.some(r => r.isRepeatOffender || r.readmissionDate || r.readmissionDatetime);

                // One folder per category, in the canonical order, so a given
                // category always sits in the same place across every child.
                const groupByCategory = (docs: typeof allDocs) => {
                  const groups = new Map<string, typeof allDocs>();
                  docs.forEach(d => {
                    const folder = deriveDocumentCategory(d);
                    if (!groups.has(folder)) groups.set(folder, []);
                    groups.get(folder)!.push(d);
                  });
                  return [
                    ...DOCUMENT_CATEGORIES.filter(f => groups.has(f)),
                    ...[...groups.keys()].filter(f => !DOCUMENT_CATEGORIES.includes(f)),
                  ].map(folder => ({ folder, docs: groups.get(folder)! }));
                };

                /**
                 * A returning resident's files, separated by admission. Nothing
                 * is dropped and nothing is merged: every document is placed in
                 * exactly one period, so both admissions stay readable and a
                 * file can always be traced to the admission it was made under.
                 *
                 * Displayed current-first. `periods` itself is oldest-first
                 * because `admissionPeriodKeyFor` reads its boundaries in that
                 * order, so the reordering happens here rather than in the
                 * resolver. The sort is stable, so the closed stays keep their
                 * chronological order below the current one.
                 */
                const displayPeriods = splitByAdmission
                  ? [...periods].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))
                  : [];
                const periodGroups = splitByAdmission
                  ? displayPeriods.map(period => ({
                      period,
                      docs: allDocs.filter(d =>
                        admissionPeriodKeyFor(d, periods, historyRow?.readmissionDatetime) === period.key
                      ),
                    }))
                  : [];
                const flatGroups = splitByAdmission ? [] : groupByCategory(allDocs);
                // Same grouping, narrowed to this card's own search box — used
                // only for what's actually listed when the card is open. The
                // header badge above keeps counting from `allDocs`/`flatGroups`
                // so it always reads as the resident's true totals.
                const filteredPeriodGroups = splitByAdmission
                  ? displayPeriods.map(period => ({
                      period,
                      docs: childDocsMatchingSearch.filter(d =>
                        admissionPeriodKeyFor(d, periods, historyRow?.readmissionDatetime) === period.key
                      ),
                    }))
                  : [];
                const filteredFlatGroups = splitByAdmission ? [] : groupByCategory(childDocsMatchingSearch);

                return (
                  <Card key={nameKey} className="overflow-hidden">
                    <button
                      className="w-full flex items-center gap-3 px-4 py-3 bg-[#2F3E46] text-white hover:bg-[#263440] transition-colors"
                      onClick={() => toggleChild(nameKey)}
                    >
                      {isChildOpen ? <FolderOpen className="w-5 h-5 text-[#FFD100]" /> : <Folder className="w-5 h-5 text-[#FFD100]" />}
                      <span className="font-semibold flex-1 text-left">{displayName}</span>
                      {isReturning && <span className="text-[10px] bg-orange-400 text-white px-2 py-0.5 rounded-full font-bold mr-1">Returning</span>}
                      <span className="text-xs text-gray-300 mr-2">
                        {splitByAdmission
                          ? `${periods.length} admissions · ${allDocs.length} file${allDocs.length !== 1 ? 's' : ''}`
                          : `${flatGroups.length} categor${flatGroups.length === 1 ? 'y' : 'ies'} · ${allDocs.length} file${allDocs.length !== 1 ? 's' : ''}`}
                      </span>
                      {isChildOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
                    </button>
                    {isChildOpen && (
                      <CardContent className="p-3 space-y-2 bg-gray-50">
                        {allDocs.length > 0 && (
                          <div className="relative mb-1">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                            <Input
                              value={childSearchQuery}
                              onChange={(e) => setFolderSearchByChild(prev => ({ ...prev, [nameKey]: e.target.value }))}
                              placeholder={`Search ${displayName}'s documents by name`}
                              className="pl-8 h-8 text-xs bg-white"
                            />
                          </div>
                        )}

                        {allDocs.length === 0 && (
                          <p className="text-sm text-gray-400 italic text-center py-4">No documents filed for this resident yet.</p>
                        )}
                        {allDocs.length > 0 && childSearchQuery.trim() && childDocsMatchingSearch.length === 0 && (
                          <p className="text-sm text-gray-400 italic text-center py-4">No documents match "{childSearchQuery.trim()}".</p>
                        )}

                        {/* A returning resident: one folder per admission, each
                            holding the same category folders. The two are never
                            merged, so a file always reads against the admission
                            it was made under. */}
                        {splitByAdmission && filteredPeriodGroups.map(({ period, docs }) => {
                          const periodKey = `${nameKey}::${period.key}`;
                          const isPeriodOpen = expandedPeriods[periodKey] ?? true;
                          const categories = groupByCategory(docs);
                          return (
                            <div key={period.key} className="border border-gray-300 rounded-lg overflow-hidden bg-white">
                              <button
                                className="w-full flex items-center gap-2 px-3 py-2.5 bg-[#2F3E46] hover:bg-[#263440] transition-colors text-left"
                                onClick={() => togglePeriod(periodKey)}
                              >
                                {isPeriodOpen
                                  ? <FolderOpen className="w-4 h-4 text-[#FFD100]" />
                                  : <Folder className="w-4 h-4 text-[#FFD100]" />}
                                <span className="flex-1 min-w-0">
                                  <span className="block truncate text-sm font-semibold text-white">
                                    {period.label}
                                    {period.isCurrent && (
                                      <span className="ml-2 rounded-full bg-[#FFD100] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#2F3E46]">Current</span>
                                    )}
                                  </span>
                                  <span className="block text-[11px] text-gray-300">{period.rangeLabel}</span>
                                </span>
                                <span className="text-xs text-gray-300 mr-1">{docs.length} file{docs.length !== 1 ? 's' : ''}</span>
                                {isPeriodOpen ? <ChevronDown className="w-3.5 h-3.5 text-gray-300" /> : <ChevronRightIcon className="w-3.5 h-3.5 text-gray-300" />}
                              </button>
                              {isPeriodOpen && (
                                <div className="space-y-2 p-2">
                                  {categories.length === 0 ? (
                                    <p className="text-xs text-gray-400 italic text-center py-3">No documents filed for this admission.</p>
                                  ) : categories.map(({ folder, docs: folderDocs }) =>
                                    renderCategoryFolder(
                                      periodKey,
                                      folder,
                                      folderDocs,
                                      period.admissionNumber,
                                      !period.isCurrent,
                                    )
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}

                        {/* A resident with a single admission: the flat
                            Child → Category → File tree, unchanged. Reaching
                            this branch means `previousCases` is empty (see
                            `admissionPeriodsFor`), so this is always their
                            1st admission. */}
                        {!splitByAdmission && filteredFlatGroups.map(({ folder, docs: folderDocs }) =>
                          renderCategoryFolder(nameKey, folder, folderDocs, 1)
                        )}
                      </CardContent>
                    )}
                  </Card>
                );
              });
            })()}
            {/* Only when no child folder was rendered at all: a specific
                resident always renders their own card (with a per-child "nothing
                filed yet" message), and with "All Residents" a child that has no
                documents is skipped, so the tab would otherwise be blank. */}
            {filterResident === 'all' && children.length > 0 && visibleDocumentsCount === 0 && (
              <Card>
                <CardContent className="p-12 text-center">
                  <Folder className="w-12 h-12 mx-auto mb-4 text-gray-300" />
                  <p className="text-gray-500">No documents uploaded yet. Use the Upload Document button to get started.</p>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* All Documents tab */}
        <TabsContent value="all" className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Filter className="w-4 h-4 shrink-0 text-gray-500" />
              <Select value={filterCategory} onValueChange={setFilterCategory}>
                <SelectTrigger className="w-full text-xs sm:w-48"><SelectValue placeholder="Filter by category" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {DOCUMENT_CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => setGroupByType(v => !v)}
            >
              {groupByType ? 'Ungroup' : 'Group by Type'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => { setBulkMode(v => !v); setSelectedDocIds(new Set()); }}
            >
              {bulkMode ? 'Done' : 'Select Multiple'}
            </Button>
            {bulkMode && (
              <>
                <Button variant="outline" size="sm" className="text-xs" onClick={toggleAllSelection}>
                  {selectedDocIds.size === filteredDocuments.length && filteredDocuments.length > 0 ? 'Deselect All' : 'Select All'}
                </Button>
                <Button
                  size="sm"
                  className="text-xs bg-[#2F3E46]"
                  disabled={selectedDocIds.size === 0 || bulkDownloading}
                  onClick={downloadBulkZip}
                >
                  <Archive className="w-3.5 h-3.5 mr-1" />
                  {bulkDownloading ? 'Zipping…' : `Download ${selectedDocIds.size} selected`}
                </Button>
              </>
            )}
          </div>
          {groupByType ? (
            groupedDocuments.length === 0 ? (
              <DocumentList docs={[]} children={children} canApprove={canApprove}
                canDelete={canDeleteDocuments}
                onApprove={handleApprove} onReject={() => {}} onView={handleView}
                onRequestAccess={openAccessRequest} onDelete={() => {}}
                getStatusBadge={getStatusBadge} getFileIcon={getFileIcon}
                formatFileSize={formatFileSize}
                emptyMessage="No documents match the current filter." />
            ) : (
              <div className="space-y-6">
                {groupedDocuments.map(({ category, docs }) => (
                  <div key={category} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-bold text-[#2F3E46]">{category}</h3>
                      <Badge className="bg-[#2F3E46]/10 text-[#2F3E46]">{docs.length}</Badge>
                    </div>
                    <DocumentList
                      docs={docs}
                      children={children}
                      canApprove={canApprove}
                      onApprove={handleApprove}
                      onReject={(doc) => { setReviewTarget(doc); setReviewDecision('Failed'); setReviewNotes(''); setIsReviewDialogOpen(true); }}
                      onReassessment={(doc) => { setReviewTarget(doc); setReviewDecision('Reassessment'); setReviewNotes(''); setIsReviewDialogOpen(true); }}
                      onView={handleView}
                      onPrint={handlePrint}
                      onRequestAccess={openAccessRequest}
                      onDelete={(doc) => { setDocumentToDelete(doc); setIsDeleteDialogOpen(true); }}
                      getStatusBadge={getStatusBadge}
                      getFileIcon={getFileIcon}
                      formatFileSize={formatFileSize}
                      canDelete={canDeleteDocuments}
                      deriveCategory={deriveDocumentCategory}
                      bulkMode={bulkMode}
                      selectedIds={selectedDocIds}
                      onToggleSelect={toggleDocSelection}
                    />
                  </div>
                ))}
              </div>
            )
          ) : (
            <DocumentList
              docs={filteredDocuments}
              children={children}
              canApprove={canApprove}
              onApprove={handleApprove}
              onReject={(doc) => { setReviewTarget(doc); setReviewDecision('Failed'); setReviewNotes(''); setIsReviewDialogOpen(true); }}
              onReassessment={(doc) => { setReviewTarget(doc); setReviewDecision('Reassessment'); setReviewNotes(''); setIsReviewDialogOpen(true); }}
              onView={handleView}
              onPrint={handlePrint}
              onRequestAccess={openAccessRequest}
              onDelete={(doc) => { setDocumentToDelete(doc); setIsDeleteDialogOpen(true); }}
              getStatusBadge={getStatusBadge}
              getFileIcon={getFileIcon}
              formatFileSize={formatFileSize}
              canDelete={canDeleteDocuments}
              deriveCategory={deriveDocumentCategory}
              bulkMode={bulkMode}
              selectedIds={selectedDocIds}
              onToggleSelect={toggleDocSelection}
            />
          )}
        </TabsContent>

        {/* Pending Review tab (Center Head only) */}
        {canApprove && (
          <TabsContent value="pending" className="mt-4">
            <DocumentList
              docs={pendingDocs.filter(d => filterResident === 'all' || d.residentId === filterResident)}
              children={children}
              canApprove={canApprove}
              onApprove={handleApprove}
              onReject={(doc) => { setReviewTarget(doc); setReviewDecision('Failed'); setReviewNotes(''); setIsReviewDialogOpen(true); }}
              onReassessment={(doc) => { setReviewTarget(doc); setReviewDecision('Reassessment'); setReviewNotes(''); setIsReviewDialogOpen(true); }}
              onView={handleView}
              onRequestAccess={openAccessRequest}
              onDelete={(doc) => { setDocumentToDelete(doc); setIsDeleteDialogOpen(true); }}
              getStatusBadge={getStatusBadge}
              getFileIcon={getFileIcon}
              formatFileSize={formatFileSize}
              emptyMessage="No documents pending review."
              canDelete={canDeleteDocuments}
            />
          </TabsContent>
        )}
        {/* Access Requests tab — the reviewer queue, plus the caller's own
            request history so a decision is never invisible to the requester. */}
        {(requestsToReview.length > 0 || myAccessRequests.length > 0) && (
          <TabsContent value="access" className="mt-4">
            <div className="space-y-6">
              {requestsToReview.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-[#2F3E46]">Awaiting your decision</h3>
                    <Badge className="bg-amber-100 text-amber-800">{requestsToReview.length}</Badge>
                  </div>
                  {requestsToReview.map(row => (
                    <Card key={row.id} data-access-request={row.id}>
                      <CardContent className="p-5 space-y-3">
                        <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
                          <div className="flex items-start gap-3 flex-1 min-w-0">
                            <div className="p-2 bg-amber-50 rounded-lg shrink-0">
                              <Lock className="w-5 h-5 text-amber-600" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <h4 className="font-semibold text-[#2F3E46] truncate">
                                {row.documentTitle || 'Document'}
                              </h4>
                              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 mt-1">
                                <span><strong>Resident:</strong> {row.residentName || 'Unknown'}</span>
                                {row.documentFileName && <span><strong>File:</strong> {row.documentFileName}</span>}
                                {row.documentCategory && <span><strong>Type:</strong> {row.documentCategory}</span>}
                              </div>
                              <p className="text-xs text-gray-500 mt-2">
                                <strong>{row.requesterUsername}</strong>
                                {row.requesterRole ? ` (${ROLE_LABEL_FALLBACK[row.requesterRole] || row.requesterRole})` : ''}
                                {' requested access'}
                                {row.createdAt ? ` on ${new Date(row.createdAt).toLocaleDateString()}` : ''}
                              </p>
                              <p className="text-sm text-gray-700 mt-2 whitespace-pre-line border-l-2 border-amber-200 pl-3">
                                {row.reason}
                              </p>
                            </div>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <Button
                              size="sm"
                              className="bg-[#2F3E46] text-white"
                              onClick={() => openReviewRequest(row, 'Approved')}
                              data-approve-request={row.id}
                            >
                              <CheckCircle className="w-3.5 h-3.5 mr-1" /> Approve
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-red-600 border-red-200 hover:bg-red-50"
                              onClick={() => openReviewRequest(row, 'Rejected')}
                              data-reject-request={row.id}
                            >
                              <X className="w-3.5 h-3.5 mr-1" /> Reject
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              {myAccessRequests.length > 0 && (
                <div className="space-y-3">
                  <h3 className="font-semibold text-[#2F3E46]">Your access requests</h3>
                  {myAccessRequests.map(row => (
                    <Card key={row.id} data-my-request={row.id} data-my-request-status={row.status}>
                      <CardContent className="p-4 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-[#2F3E46] truncate">{row.documentTitle || 'Document'}</span>
                          {row.status === 'Pending' && <Badge className="bg-yellow-100 text-yellow-800">Access Pending</Badge>}
                          {row.status === 'Approved' && <Badge className="bg-green-100 text-green-800">Approved</Badge>}
                          {row.status === 'Rejected' && <Badge className="bg-red-100 text-red-800">Rejected</Badge>}
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                          <span><strong>Resident:</strong> {row.residentName || 'Unknown'}</span>
                          {row.createdAt && <span><strong>Requested:</strong> {new Date(row.createdAt).toLocaleDateString()}</span>}
                          {row.reviewedBy && <span><strong>Reviewed by:</strong> {row.reviewedBy}</span>}
                          {row.reviewedAt && <span><strong>Decided:</strong> {new Date(row.reviewedAt).toLocaleDateString()}</span>}
                        </div>
                        <p className="text-xs text-gray-600 whitespace-pre-line"><strong>Your reason:</strong> {row.reason}</p>
                        {row.status === 'Rejected' && (
                          <p className="text-xs text-red-600 whitespace-pre-line">
                            <strong>Reviewer note:</strong> {row.reviewerNote || 'No reason given.'}
                          </p>
                        )}

                        {/*
                          An approved request is what actually unlocks the file, so the
                          row has to carry the actions that unlock it. Before this the
                          badge turned green and stopped there — the requester still had
                          to hunt the document down in another tab to read it.
                        */}
                        {row.status === 'Approved' && (
                          documentForRequest(row) ? (
                            <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-3">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 text-xs"
                                onClick={() => handleView(documentForRequest(row)!)}
                              >
                                <Eye className="h-3.5 w-3.5" /> View
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 text-xs"
                                onClick={() => handlePrint(documentForRequest(row)!)}
                              >
                                <Printer className="h-3.5 w-3.5" /> Print
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 text-xs"
                                onClick={() => downloadDocumentFile(
                                  documentForRequest(row)!,
                                  (message) => { void dialog.failure('Could not download the document', message); },
                                )}
                              >
                                <Download className="h-3.5 w-3.5" /> Download
                              </Button>
                            </div>
                          ) : (
                            // The document list is scoped to what the caller may see, so an
                            // approved-but-still-absent row is possible. Say so rather than
                            // rendering three buttons that would fail.
                            <p className="border-t border-gray-100 pt-2 text-[11px] italic text-gray-400">
                              Access approved. The file appears here once the document list refreshes.
                            </p>
                          )
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        )}

        {/*
          Access Request History — the completed decisions, kept permanently.

          Deliberately outside the condition above: that block only renders when
          there is something in the Pending queue or the caller has requests of
          their own, but a reviewer whose queue is empty is exactly who needs the
          record of what they already decided. The tab strip already filters on
          the submenu, and the panel repeats the check so a deep link to
          `?tab=history` cannot open it for a role that does not hold it.
        */}
        {canReadHistory && (
          <TabsContent value="history" className="mt-4">
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-[#2F3E46]">Access Request History</h3>
                  <p className="text-xs text-gray-500">
                    Every access request that has been approved or rejected, kept permanently as an audit record.
                  </p>
                </div>
                <div className="flex gap-1 shrink-0" data-history-filters>
                  {(['All', 'Approved', 'Rejected'] as const).map((option) => (
                    <Button
                      key={option}
                      size="sm"
                      variant={historyFilter === option ? 'default' : 'outline'}
                      className={historyFilter === option ? 'bg-[#2F3E46] text-white' : ''}
                      onClick={() => setHistoryFilter(option)}
                      data-history-filter={option}
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              </div>

              {accessHistoryLoading ? (
                <p className="text-xs text-gray-400 py-6 text-center">Loading access request history...</p>
              ) : accessHistory.length === 0 ? (
                <p className="text-xs text-gray-400 py-6 text-center">
                  {historyFilter === 'All'
                    ? 'No access request has been decided yet.'
                    : `No ${historyFilter.toLowerCase()} access requests.`}
                </p>
              ) : (
                accessHistory.map((row) => (
                  <Card key={row.id} data-history-request={row.id} data-history-status={row.status}>
                    <CardContent className="p-4 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-[#2F3E46] truncate">{row.documentTitle || 'Document'}</span>
                        {row.status === 'Approved' ? (
                          <Badge className="bg-green-100 text-green-800">Approved</Badge>
                        ) : (
                          <Badge className="bg-red-100 text-red-800">Rejected</Badge>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-500">
                        <span><strong>Child:</strong> {row.residentName || 'Unknown'}</span>
                        <span><strong>Document:</strong> {row.documentFileName || row.documentTitle || '—'}</span>
                        <span><strong>Category:</strong> {row.documentCategory || '—'}</span>
                        <span><strong>Requested by:</strong> {row.requesterUsername || '—'}</span>
                        <span><strong>Reviewed by:</strong> {row.reviewedBy || '—'}</span>
                        <span>
                          <strong>{row.status === 'Rejected' ? 'Rejected on' : 'Approved on'}:</strong>{' '}
                          {row.reviewedAt ? new Date(row.reviewedAt).toLocaleString() : '—'}
                        </span>
                      </div>
                      {row.status === 'Rejected' && (
                        <p className="text-xs text-red-600 whitespace-pre-line">
                          <strong>Rejection reason:</strong> {row.reviewerNote || 'No reason given.'}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </TabsContent>
        )}
      </Tabs>
      
      {/* Upload Dialog */}
      <Dialog open={isUploadDialogOpen} onOpenChange={setIsUploadDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">

            {/* Resident selector */}
            <div className="space-y-2">
              <Label>Resident *</Label>
              <Select value={uploadResidentId} onValueChange={v => { setUploadResidentId(v); setDocumentTitle(''); setOtherDocumentType(''); }}>
                <SelectTrigger><SelectValue placeholder="Select resident" /></SelectTrigger>
                <SelectContent>
                  {children.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Phase info */}
            {uploadResident && (
              <div className="flex items-center gap-2 p-2 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-800">
                <FileText className="w-3.5 h-3.5 shrink-0" />
                <span>Resident is in <strong>{residentPhase}</strong> phase. You can upload documents for this phase and earlier phases.</span>
              </div>
            )}

            {/* Document type — filtered by phase + role */}
            <div className="space-y-2">
              <Label>Document Type *</Label>
              {!uploadResidentId ? (
                <p className="text-xs text-gray-400 italic">Select a resident first to see allowed document types.</p>
              ) : allowedDocuments.length === 0 ? (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-orange-50 border border-orange-200 text-xs text-orange-700">
                  <Lock className="w-3.5 h-3.5" />
                  <span>No documents are allowed for your role in the current phase ({residentPhase}).</span>
                </div>
              ) : (
                <Select value={documentTitle} onValueChange={v => { setDocumentTitle(v); if (v !== 'Other') setOtherDocumentType(''); }}>
                  <SelectTrigger><SelectValue placeholder="Select document type" /></SelectTrigger>
                  <SelectContent>
                    {allowedDocuments.map(({ doc, phase }) => (
                      <SelectItem key={doc} value={doc}>
                        <span>{doc}</span>
                        {doc !== 'Other' && <span className="ml-2 text-[10px] text-gray-400">({phase})</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {documentTitle === 'Other' && (
              <div className="space-y-2">
                <Label>Specify *</Label>
                <Input
                  value={otherDocumentType}
                  onChange={e => setOtherDocumentType(e.target.value)}
                  placeholder="Enter the exact document type"
                />
              </div>
            )}

            <div className="space-y-2">
              <Label>Description</Label>
              <Input
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Brief description of the document"
              />
            </div>

            <div className="space-y-2">
              <Label>File * (Max {MAX_UPLOAD_LABEL})</Label>
              <Input
                ref={fileInputRef}
                type="file"
                onChange={handleFileSelect}
                accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.xls,.xlsx"
              />
              {selectedFile && (
                <p className="text-sm text-gray-600">Selected: {selectedFile.name} ({formatFileSize(selectedFile.size)})</p>
              )}
            </div>

            {uploadError && (
              <div className="flex items-center gap-2 p-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {uploadError}
              </div>
            )}

            {isUploading && (
              <div className="space-y-2">
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full bg-[#2F3E46] transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                </div>
                <p className="text-sm text-gray-600 text-center">{uploadProgress}% uploaded</p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsUploadDialogOpen(false); resetForm(); }}>Cancel</Button>
            <Button
              onClick={handleUpload}
              className="bg-[#2F3E46]"
              disabled={isUploading || !selectedFile || !uploadResidentId || !documentTitle || (documentTitle === 'Other' && !otherDocumentType.trim())}
            >
              {isUploading ? 'Uploading...' : 'Upload Document'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* View Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent
          className={`max-h-[90vh] overflow-y-auto ${
            selectedDocument?.category === 'Admission' ? 'max-w-5xl' : 'max-w-3xl'
          }`}
        >
          <DialogHeader>
            <DialogTitle>Document Details</DialogTitle>
          </DialogHeader>
          {isViewLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#2F3E46]" />
              <span className="ml-3 text-gray-500">Loading document...</span>
            </div>
          ) : selectedDocument && (
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-4">
                {getFileIcon(selectedDocument.fileName || '')}
                <div>
                  <h3 className="font-semibold text-lg">{selectedDocument.title}</h3>
                  {getStatusBadge(selectedDocument.status)}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-gray-500">Resident</p>
                  <p className="font-medium break-words">{children.find(c => c.id === selectedDocument.residentId)?.name || 'Unknown'}</p>
                </div>
                <div>
                  <p className="text-gray-500">Category</p>
                  <p className="font-medium break-words">{selectedDocument.category}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-gray-500">File Name</p>
                  <p className="font-medium break-all">{selectedDocument.fileName}</p>
                </div>
                <div>
                  <p className="text-gray-500">File Size</p>
                  <p className="font-medium">{formatFileSize(selectedDocument.fileSize || 0)}</p>
                </div>
                <div>
                  <p className="text-gray-500">Uploaded By</p>
                  <p className="font-medium break-words">{selectedDocument.uploadedBy}</p>
                </div>
                <div>
                  <p className="text-gray-500">Upload Date</p>
                  <p className="font-medium">{new Date(selectedDocument.uploadedAt || '').toLocaleString()}</p>
                </div>
              </div>
              {selectedDocument.description && (
                <div>
                  <p className="text-gray-500 text-sm mb-1.5 font-semibold">Description</p>
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 max-h-96 overflow-y-auto">
                    <pre className="text-sm text-[#2F3E46] whitespace-pre-wrap break-words font-sans leading-relaxed">
                      {selectedDocument.description}
                    </pre>
                  </div>
                </div>
              )}
              {selectedDocument.fileData && (
                <div className="border rounded-lg p-4 bg-gray-50">
                  <p className="text-sm text-gray-500 mb-2">Preview</p>
                  {selectedDocument.fileType?.startsWith('image/') ? (
                    <img 
                      src={selectedDocument.fileData} 
                      alt={selectedDocument.title}
                      className="max-w-full max-h-96 object-contain"
                    />
                  ) : selectedDocument.fileType === 'application/pdf' ? (
                    <iframe
                      src={normalizeFileData(selectedDocument.fileData, selectedDocument.fileType)}
                      className={
                        selectedDocument.category === 'Admission'
                          ? 'w-full h-[85vh] min-h-[650px]'
                          : 'w-full h-96'
                      }
                      title={selectedDocument.title}
                    />
                  ) : (
                    <div className="text-center py-8">
                      <p className="text-gray-500 mb-4">Preview not available for this file type</p>
                      <a 
                        href={normalizeFileData(selectedDocument.fileData, selectedDocument.fileType)}
                        download={selectedDocument.fileName}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-[#2F3E46] text-white rounded-lg hover:bg-[#263440]"
                      >
                        <Upload className="w-4 h-4" />
                        Download File
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsViewDialogOpen(false)}>
              Close
            </Button>
            {selectedDocument?.fileData && (
              <a 
                href={selectedDocument.fileData}
                download={selectedDocument.fileName}
                className="inline-flex"
              >
                <Button className="bg-[#2F3E46]">
                  <Upload className="w-4 h-4 mr-2" />
                  Download
                </Button>
              </a>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Document access request dialog */}
      <Dialog open={isAccessRequestOpen} onOpenChange={setIsAccessRequestOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46]">Request Document Access</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="rounded-xl bg-gray-50 border border-gray-100 p-3">
              <p className="font-semibold text-[#2F3E46]">{accessRequestTarget?.title}</p>
              <p className="text-xs text-gray-500">{accessRequestTarget?.fileName || 'Document'}</p>
            </div>
            <div className="space-y-1.5">
              <Label>Reason for requesting access *</Label>
              <Textarea
                value={accessRequestReason}
                onChange={event => setAccessRequestReason(event.target.value)}
                placeholder="Explain why you need to view this document..."
                rows={4}
                required
              />
            </div>
            {accessRequestError && <p className="text-sm text-red-600">{accessRequestError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAccessRequestOpen(false)}>Cancel</Button>
            <Button onClick={submitAccessRequest} disabled={isAccessRequestSubmitting || !accessRequestReason.trim()} className="bg-[#2F3E46] text-white">
              {isAccessRequestSubmitting ? 'Submitting...' : 'Submit Request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Access request decision dialog — reviewer side of the flow */}
      <Dialog open={!!reviewRequestTarget} onOpenChange={open => { if (!open) setReviewRequestTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46]">
              {reviewRequestDecision === 'Approved' ? 'Approve access request' : 'Reject access request'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="rounded-xl bg-gray-50 border border-gray-100 p-3">
              <p className="font-semibold text-[#2F3E46]">{reviewRequestTarget?.documentTitle || 'Document'}</p>
              <p className="text-xs text-gray-500">
                Requested by {reviewRequestTarget?.requesterUsername}
                {reviewRequestTarget?.residentName ? ` · ${reviewRequestTarget.residentName}` : ''}
              </p>
            </div>
            <div className="rounded-xl bg-amber-50 border border-amber-100 p-3">
              <p className="text-xs font-semibold text-amber-800">Reason given</p>
              <p className="text-sm text-amber-900 whitespace-pre-line mt-1">{reviewRequestTarget?.reason}</p>
            </div>
            <p className="text-xs text-gray-600">
              {reviewRequestDecision === 'Approved'
                ? 'Approving grants this user lasting read access to this one document only. It survives signing out and does not extend to any other document.'
                : 'Rejecting grants no access at all. The request is kept as history and the requester will see your note.'}
            </p>
            <div className="space-y-1.5">
              <Label>{reviewRequestDecision === 'Rejected' ? 'Reason for rejection *' : 'Note (optional)'}</Label>
              <Textarea
                value={reviewRequestNote}
                onChange={event => setReviewRequestNote(event.target.value)}
                placeholder={reviewRequestDecision === 'Rejected'
                  ? 'Explain why access is being denied...'
                  : 'Optional note for the requester...'}
                rows={3}
              />
            </div>
            {reviewRequestError && <p className="text-sm text-red-600">{reviewRequestError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewRequestTarget(null)}>Cancel</Button>
            <Button
              onClick={submitReviewRequest}
              disabled={isReviewRequestSubmitting || (reviewRequestDecision === 'Rejected' && !reviewRequestNote.trim())}
              className={reviewRequestDecision === 'Approved' ? 'bg-[#2F3E46] text-white' : 'bg-red-600 text-white'}
            >
              {isReviewRequestSubmitting ? 'Saving...' : reviewRequestDecision === 'Approved' ? 'Approve' : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reassessment Dialog — enter reason then confirm */}
      <Dialog open={isReviewDialogOpen} onOpenChange={setIsReviewDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46] flex items-center gap-2">
              ↺ {reviewDecision === 'Failed' ? 'Mark as Failed' : 'Request Reassessment'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm font-semibold text-yellow-800">{reviewTarget?.title}</p>
              <p className="text-xs text-yellow-600 mt-1">
                {reviewDecision === 'Failed'
                  ? 'This document will be marked as Failed.'
                  : 'This document will be sent back for revision and re-submission.'}
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-bold text-[#2F3E46]">
                Reason {reviewDecision === 'Reassessment' ? 'for Reassessment' : 'for Failure'} *
              </label>
              <textarea
                value={reviewNotes}
                onChange={e => setReviewNotes(e.target.value)}
                placeholder={reviewDecision === 'Reassessment'
                  ? 'Enter the reason why this document needs reassessment...'
                  : 'Enter the reason why this document failed...'}
                rows={4}
                className="w-full text-sm rounded-xl border border-gray-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#FFD100]"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { setIsReviewDialogOpen(false); setReviewNotes(''); }}
              className="flex-1 px-4 py-2 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50"
            >Cancel</button>
            <button
              disabled={!reviewNotes.trim()}
              onClick={handleReviewSubmit}
              className={`flex-1 px-4 py-2 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                reviewDecision === 'Failed' ? 'bg-red-600 hover:bg-red-700' : 'bg-yellow-500 hover:bg-yellow-600'
              }`}
            >
              {reviewDecision === 'Reassessment' ? 'Confirm Reassessment' : 'Confirm Failed'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reject Reason Dialog */}
      <Dialog open={isRejectDialogOpen} onOpenChange={setIsRejectDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-red-600 flex items-center gap-2">
              <X className="w-4 h-4" /> Reject Document
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {rejectTarget && (
              <p className="text-sm text-gray-700">
                Rejecting: <strong>{rejectTarget.title}</strong>
                {rejectTarget.uploadedBy && <span className="text-gray-500"> — uploaded by {rejectTarget.uploadedBy}</span>}
              </p>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Reason for rejection *</Label>
              <Textarea
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                placeholder="e.g. Incomplete information, wrong document format, missing signature..."
                rows={3}
                className="text-sm"
              />
              <p className="text-xs text-gray-400">This reason will be visible to the uploader.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRejectDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={handleReject}
              disabled={!rejectReason.trim()}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Confirm Rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Document</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this document? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setIsDeleteDialogOpen(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/*
        Audit trail dialog.

        Every transition the document went through, oldest first. A rejected
        document is not deleted and its rejection is not overwritten by a later
        approval, so this list is the record of what actually happened: who
        created it, who submitted or resubmitted it, who rejected it and why, and
        who finally approved it.
      */}
      <Dialog open={!!historyTarget} onOpenChange={open => { if (!open) setHistoryTarget(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Audit History</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
              <p className="text-sm font-medium text-[#2F3E46]">{historyTarget?.title}</p>
              <p className="text-xs text-gray-500">
                {deriveDocumentCategory(historyTarget || { title: '' })}
                {historyTarget?.residentName ? ` · ${historyTarget.residentName}` : ''}
                {Number(historyTarget?.revision) > 1 ? ` · Revision ${historyTarget?.revision}` : ''}
              </p>
            </div>

            {historyLoading && <p className="text-sm text-gray-500">Loading history…</p>}
            {historyError && <p className="text-sm text-red-600">{historyError}</p>}
            {!historyLoading && !historyError && historyRows.length === 0 && (
              <p className="text-sm text-gray-500 italic">
                No history recorded for this document yet. Transitions are recorded from the moment it is uploaded or submitted.
              </p>
            )}

            <div className="max-h-80 overflow-y-auto space-y-2">
              {historyRows.map(entry => {
                const tone = entry.action === 'Rejected'
                  ? 'border-red-200 bg-red-50'
                  : entry.action === 'Approved'
                    ? 'border-green-200 bg-green-50'
                    : 'border-gray-200 bg-white';
                return (
                  <div key={entry.id} className={`rounded-lg border px-3 py-2 ${tone}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-gray-800">{entry.action}</span>
                      {entry.status && <Badge variant="outline" className="text-[10px]">{entry.status}</Badge>}
                      {Number(entry.revision) > 1 && (
                        <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300 bg-amber-50">
                          Revision {entry.revision}
                        </Badge>
                      )}
                      <span className="text-[10px] text-gray-500 ml-auto">{formatShortDateTime(entry.createdAt)}</span>
                    </div>
                    <p className="text-xs text-gray-600 mt-1">
                      By {entry.actor || 'System'}
                      {entry.actorRole ? ` (${ROLE_LABEL_FALLBACK[entry.actorRole] || entry.actorRole})` : ''}
                    </p>
                    {entry.reason && (
                      <p className="text-xs text-red-700 mt-1 whitespace-pre-line">
                        <strong>Reason:</strong> {entry.reason}
                      </p>
                    )}
                    {entry.notes && <p className="text-xs text-gray-600 mt-1 whitespace-pre-line">{entry.notes}</p>}
                  </div>
                );
              })}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryTarget(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
