import React, { useState, useRef, useMemo, useEffect } from 'react';
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
import { Upload, X, CheckCircle, FileText, Image, FileSpreadsheet, File, Lock, AlertTriangle, Folder, FolderOpen, ChevronDown, ChevronRight as ChevronRightIcon, Download, User } from 'lucide-react';
import { useData, DocumentWithApproval } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { formatShortDate } from '@/utils/dateFormatter';

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
  Admission:        { requiredDocuments: ['Court Order','OCP Resolution','Case Information','Diversion Plan Referral Letter','Medical Certificate / Birth Certificate','Baptismal Certificate'], optionalDocuments: ['Psychological Assessment'], requiredTasks: [] },
  Orientation:      { requiredDocuments: [], requiredTasks: [] },
  Observation:      { requiredDocuments: ['Discernment Assessment','Case Conference Form','Home/School Visit Form'], optionalDocuments: ['Psychological Testing'], requiredTasks: [] },
  Rehabilitation:   { requiredDocuments: ['Casework / Groupwork'], optionalDocuments: ['Monitoring Report','Case Assistance Feedback Form','Court Assistance Feedback Form'], requiredTasks: [] },
  'Pre-integration':{ requiredDocuments: ['Case Conference Form','Parenting Capability Assessment'], requiredTasks: [] },
  Reintegration:    { requiredDocuments: ['Discharge Form'], requiredTasks: [] },
};

const DOCUMENT_ROLE_PERMISSIONS: Record<string, string[]> = {
  'Court Order':                        ['socialworker','centerhead'],
  'OCP Resolution':                     ['socialworker','centerhead'],
  'Case Information':                   ['socialworker','centerhead'],
  'Diversion Plan Referral Letter':     ['socialworker','centerhead'],
  'Medical Certificate / Birth Certificate': ['socialworker','centerhead'],
  'Baptismal Certificate':              ['socialworker','centerhead'],
  'Psychological Assessment':           ['psychologist','centerhead'],
  'Psychological Testing':              ['psychologist','centerhead'],
  'Discernment Assessment':             ['psychologist','centerhead'],
  'SCSR':                               ['socialworker','centerhead'],
  'Parenting Capability Assessment':    ['psychologist','centerhead'],
  'Case Conference Form':               ['socialworker','centerhead'],
  'Home/School Visit Form':             ['socialworker','educator','centerhead'],
  'Case Assistance Feedback Form':      ['socialworker','centerhead'],
  'Court Assistance Feedback Form':     ['socialworker','centerhead'],
  'Discharge Form':                     ['socialworker','centerhead'],
  'Progress Report':                    ['socialworker','psychologist','nurse','educator','centerhead'],
  'Health Record Form':                 ['nurse','centerhead'],
  'Medical Certificate':                ['nurse','centerhead'],
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

interface DocListProps {
  docs: DocumentWithApproval[];
  children: { id: string; name: string }[];
  canApprove: boolean;
  onApprove: (doc: DocumentWithApproval) => void;
  onReject: (doc: DocumentWithApproval) => void;
  onView: (doc: DocumentWithApproval) => void;
  onDelete: (doc: DocumentWithApproval) => void;
  getStatusBadge: (status: string) => React.ReactNode;
  getFileIcon: (name: string) => React.ReactNode;
  formatFileSize: (bytes: number) => string;
  emptyMessage?: string;
  userRole?: string;
}

function DocumentList({ docs, children, canApprove, onApprove, onReject, onView, onDelete, getStatusBadge, getFileIcon, formatFileSize, emptyMessage, userRole }: DocListProps) {
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
        return (
          <Card key={doc.id} className="hover:shadow-md transition-shadow">
            <CardContent className="p-5">
              <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
                <div className="flex items-start gap-4 flex-1">
                  <div className="p-2 bg-gray-50 rounded-lg shrink-0">{getFileIcon(doc.fileName || '')}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="font-semibold text-[#2F3E46] truncate">{doc.title}</h3>
                      {getStatusBadge(doc.status)}
                      {doc.phase && (
                        <Badge variant="outline" className="text-[10px] text-gray-500 border-gray-300">{doc.phase}</Badge>
                      )}
                    </div>
                    {doc.description && <p className="text-sm text-gray-600 mb-1">{doc.description}</p>}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                      <span><strong>Resident:</strong> {resident?.name || 'Unknown'}</span>
                      <span><strong>File:</strong> {doc.fileName} ({formatFileSize(doc.fileSize || 0)})</span>
                      {doc.uploadedAt && <span><strong>Uploaded:</strong> {new Date(doc.uploadedAt).toLocaleDateString()}</span>}
                      {doc.uploadedBy && <span><strong>By:</strong> {doc.uploadedBy}</span>}
                    </div>
                    {doc.status === 'Approved' && doc.approvedBy && (
                      <p className="text-xs text-green-600 mt-1">✓ Approved by {doc.approvedBy} on {new Date(doc.approvedAt || '').toLocaleDateString()}</p>
                    )}
                    {doc.status === 'Rejected' && doc.rejectionReason && (
                      <p className="text-xs text-red-600 mt-1">✗ Rejected: {doc.rejectionReason}</p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button variant="outline" size="sm" onClick={() => onView(doc)}>View</Button>
                  {doc.fileData && (
                    <a href={doc.fileData} download={doc.fileName}>
                      <Button variant="outline" size="sm" title="Download"><Download className="w-3.5 h-3.5" /></Button>
                    </a>
                  )}
                  {canApprove && doc.status === 'Submitted' && (
                    <>
                      <Button variant="outline" size="sm" className="text-green-600 border-green-200 hover:bg-green-50" onClick={() => onApprove(doc)}>
                        <CheckCircle className="w-3.5 h-3.5 mr-1" /> Approve
                      </Button>
                      <Button variant="outline" size="sm" className="text-red-600 border-red-200 hover:bg-red-50" onClick={() => onReject(doc)}>
                        <X className="w-3.5 h-3.5 mr-1" /> Reject
                      </Button>
                    </>
                  )}
                  {(() => {
                    const docPerms = DOCUMENT_ROLE_PERMISSIONS[doc.title];
                    const canDelete = !docPerms || (userRole && docPerms.includes(userRole)) || userRole === 'centerhead';
                    return canDelete ? (
                      <Button variant="outline" size="sm" className="text-red-500" onClick={() => onDelete(doc)}>
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    ) : null;
                  })()}
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
  const handleDownload = async () => {
    if (doc.fileData) {
      const a = document.createElement('a');
      a.href = doc.fileData;
      a.download = doc.fileName || doc.title;
      a.click();
      return;
    }
    // fileData not in state (excluded from store) — fetch from API
    try {
      const res = await fetch(`/api/documents/${doc.id}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      const json = await res.json();
      if (json?.data?.fileData) {
        const a = document.createElement('a');
        a.href = json.data.fileData;
        a.download = doc.fileName || doc.title;
        a.click();
      }
    } catch { alert('Could not download file.'); }
  };
  return (
    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={handleDownload} title="Download">
      <Download className="w-3 h-3" />
    </Button>
  );
}

export function DocumentUpload() {
  const { documents, addDocument, updateDocument, deleteDocument, children } = useData();
  const { user } = useAuth();

  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<DocumentWithApproval | null>(null);
  const [documentToDelete, setDocumentToDelete] = useState<DocumentWithApproval | null>(null);

  const [filterResident, setFilterResident] = useState('all');
  const [uploadResidentId, setUploadResidentId] = useState('');
  const [documentTitle, setDocumentTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [isRejectDialogOpen, setIsRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectTarget, setRejectTarget] = useState<DocumentWithApproval | null>(null);
  const [isViewLoading, setIsViewLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [expandedChildren, setExpandedChildren] = useState<Record<string, boolean>>({});
  const [expandedRolesInit, setExpandedRolesInit] = useState(false);

  // Auto-expand all child folders that have documents
  useEffect(() => {
    if (!expandedRolesInit && documents.length > 0) {
      const autoExpand: Record<string, boolean> = {};
      documents.forEach(d => { if (d.residentId) autoExpand[d.residentId] = true; });
      setExpandedChildren(autoExpand);
      setExpandedRolesInit(true);
    }
  }, [documents, expandedRolesInit]);
  const [expandedRoles, setExpandedRoles] = useState<Record<string, boolean>>({});

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
  const toggleRole = (key: string) => setExpandedRoles(prev => ({ ...prev, [key]: !prev[key] }));

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
      // Include required documents
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
    return result;
  }, [residentPhase, residentPhaseIndex, userRole]);
  
  const filteredDocuments = filterResident && filterResident !== 'all'
    ? documents.filter(d => d.residentId === filterResident)
    : documents;
  
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 10 * 1024 * 1024) {
        alert('File size must be less than 10MB');
        return;
      }
      setSelectedFile(file);
      if (!documentTitle) {
        setDocumentTitle(file.name.split('.')[0]);
      }
    }
  };
  
  const handleUpload = async () => {
    setUploadError('');
    if (!selectedFile || !uploadResidentId || !documentTitle) {
      setUploadError('Please select a resident, document type, and file.');
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
          title: documentTitle,
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
    setDescription('');
    setSelectedFile(null);
    setUploadProgress(0);
    setUploadError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  
  const handleView = async (doc: DocumentWithApproval) => {
    if (doc.fileData) {
      setSelectedDocument(doc);
      setIsViewDialogOpen(true);
      return;
    }
    setIsViewLoading(true);
    try {
      const res = await fetch(`/api/documents/${doc.id}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      const json = await res.json();
      const fileData = json?.data?.fileData || json?.fileData || null;
      setSelectedDocument({ ...doc, fileData: fileData || undefined });
    } catch {
      setSelectedDocument(doc);
    } finally {
      setIsViewLoading(false);
      setIsViewDialogOpen(true);
    }
  };

  const handleApprove = async (document: DocumentWithApproval) => {
    await updateDocument(document.id, {
      status: 'Approved',
      approvedBy: user?.username,
      approvedAt: new Date().toISOString(),
    });
  };
  
  const handleReject = async () => {
    if (!rejectTarget) return;
    await updateDocument(rejectTarget.id, {
      status: 'Rejected',
      rejectionReason: rejectReason || 'No reason provided',
      reviewedBy: user?.username,
      reviewedAt: new Date().toISOString(),
    });
    setIsRejectDialogOpen(false);
    setRejectReason('');
    setRejectTarget(null);
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
      case 'Under Review':
        return <Badge className="bg-yellow-100 text-yellow-800">Under Review</Badge>;
      case 'Submitted':
        return <Badge className="bg-blue-100 text-blue-800">Submitted</Badge>;
      default:
        return <Badge className="bg-gray-100 text-gray-800">Draft</Badge>;
    }
  };
  
  const canApprove = user?.role === 'centerhead' || user?.role === 'socialworker' || user?.role === 'admin';
  const pendingDocs = documents.filter(d => d.status === 'Submitted' || d.status === 'Under Review');
  
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

      <Tabs defaultValue="folders">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="folders">📁 Folders by Child</TabsTrigger>
            <TabsTrigger value="all">All Documents ({documents.length})</TabsTrigger>
            {canApprove && (
              <TabsTrigger value="pending" className="relative">
                Pending Review
                {pendingDocs.length > 0 && (
                  <span className="ml-1.5 bg-blue-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{pendingDocs.length}</span>
                )}
              </TabsTrigger>
            )}
          </TabsList>

          {/* Resident filter (only for flat views) */}
          <Select value={filterResident} onValueChange={setFilterResident}>
            <SelectTrigger className="w-48">
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

        {/* FOLDER VIEW — per resident (merged), per offense, per uploader */}
        <TabsContent value="folders" className="mt-4">
          <div className="space-y-3">
            {(() => {
              // Group ALL children by name — returning residents share one root folder
              const filteredChildren = children.filter(c =>
                filterResident === 'all' || c.id === filterResident
              );

              // Merge children with same name into one root folder
              const byName: Record<string, typeof children> = {};
              filteredChildren.forEach(c => {
                const key = c.name.trim().toLowerCase();
                if (!byName[key]) byName[key] = [];
                byName[key].push(c);
              });

              return Object.entries(byName).map(([nameKey, residents]) => {
                // Collect ALL docs for all IDs under this name
                const allResidentIds = residents.map(r => r.id);
                const allDocs = documents.filter(d => allResidentIds.includes(d.residentId || ''));
                if (allDocs.length === 0 && filterResident === 'all') return null;

                const displayName = residents[0].name;
                const folderId = nameKey;
                const isChildOpen = expandedChildren[folderId] ?? false;
                const isReturning = residents.length > 1 || residents.some(r => r.isRepeatOffender);

                // Sort residents by admissionDate ascending to determine offense order
                const sortedResidents = [...residents].sort((a, b) =>
                  (a.admissionDate || '').localeCompare(b.admissionDate || '')
                );

                // Assign offense number per resident ID
                const offenseByResidentId: Record<string, number> = {};
                sortedResidents.forEach((r, i) => { offenseByResidentId[r.id] = i + 1; });

                const child = residents[0]; // primary record
                return (
                  <Card key={folderId} className="overflow-hidden">
                    <button
                      className="w-full flex items-center gap-3 px-4 py-3 bg-[#2F3E46] text-white hover:bg-[#263440] transition-colors"
                      onClick={() => toggleChild(folderId)}
                    >
                      {isChildOpen ? <FolderOpen className="w-5 h-5 text-[#FFD100]" /> : <Folder className="w-5 h-5 text-[#FFD100]" />}
                      <span className="font-semibold flex-1 text-left">{displayName}</span>
                      {isReturning && <span className="text-[10px] bg-orange-400 text-white px-2 py-0.5 rounded-full font-bold mr-1">Returning</span>}
                      <span className="text-xs text-gray-300 mr-2">{allDocs.length} file{allDocs.length !== 1 ? 's' : ''}</span>
                      {isChildOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
                    </button>
                    {isChildOpen && (
                      <CardContent className="p-3 space-y-3 bg-gray-50">
                        {(() => {
                          // ── Build offense groups ──────────────────────────────────────
                          const OFFENSE_STYLES = [
                            { color: 'text-blue-700', bgColor: 'bg-blue-50 border-blue-200' },
                            { color: 'text-orange-700', bgColor: 'bg-orange-50 border-orange-200' },
                            { color: 'text-purple-700', bgColor: 'bg-purple-50 border-purple-200' },
                          ];
                          type DocGroup = { label: string; admittedDate: string; docs: typeof allDocs; style: typeof OFFENSE_STYLES[0] };
                          const offenseGroups: DocGroup[] = [];
                          const labels = ['1st Offense','2nd Offense','3rd Offense','4th Offense'];

                          if (sortedResidents.length > 1) {
                            // Case A: Multiple DB records with same name
                            sortedResidents.forEach((res, idx) => {
                              offenseGroups.push({
                                label: labels[idx] || `Offense ${idx+1}`,
                                admittedDate: res.admissionDate,
                                docs: allDocs.filter(d => d.residentId === res.id),
                                style: OFFENSE_STYLES[Math.min(idx, OFFENSE_STYLES.length-1)],
                              });
                            });
                          } else {
                            // Case B: Single record
                            const res = sortedResidents[0];
                            const admDate = res?.admissionDate || '';

                            if (isReturning) {
                              // Use readmissionDate as cutoff (more reliable than admissionDate)
                              // Use full datetime if available — prevents same-day docs from mixing
                              const cutoffDatetime = res?.readmissionDatetime || null;
                              const cutoffDate = res?.readmissionDate || admDate;

                              const normalizeDateTime = (uploadedAt: string) => {
                                // MySQL: "2026-05-28 10:30:00" → "2026-05-28T10:30:00"
                                // ISO: "2026-05-28T10:30:00.000Z" → keep as is
                                return uploadedAt.includes('T') ? uploadedAt : uploadedAt.replace(' ', 'T');
                              };

                              const isFirstOffense = (d: typeof allDocs[0]) => {
                                if (!d.uploadedAt) return true; // no timestamp = old doc = 1st offense
                                if (cutoffDatetime) {
                                  // Compare full datetimes for precision
                                  return normalizeDateTime(d.uploadedAt) < cutoffDatetime;
                                }
                                // Fallback: date-only comparison
                                return d.uploadedAt.substring(0, 10) < cutoffDate;
                              };

                              const firstDocs = allDocs.filter(d => isFirstOffense(d));
                              const secondDocs = allDocs.filter(d => !isFirstOffense(d));
                              offenseGroups.push({ label: '1st Offense', admittedDate: '', docs: firstDocs, style: OFFENSE_STYLES[0] });
                              offenseGroups.push({ label: '2nd Offense', admittedDate: cutoffDate, docs: secondDocs, style: OFFENSE_STYLES[1] });
                            } else {
                              // Normal first-time child — just 1st Offense
                              offenseGroups.push({ label: '1st Offense', admittedDate: admDate, docs: allDocs, style: OFFENSE_STYLES[0] });
                            }
                          }

                          // If no docs at all and not returning, show empty message
                          if (allDocs.length === 0 && !isReturning) {
                            return <p className="text-sm text-gray-400 italic text-center py-4">No documents uploaded for this resident.</p>;
                          }

                          return offenseGroups.map((group, gIdx) => {
                            const isLastGroup = gIdx === offenseGroups.length - 1;
                            // Hide empty groups except the last one (for returning children)
                            if (group.docs.length === 0 && !isLastGroup && !isReturning) return null;
                            const byUploader: Record<string, typeof allDocs> = {};
                            group.docs.forEach(d => {
                              const uploader = d.uploadedBy || d.uploaderRole || 'Unknown';
                              if (!byUploader[uploader]) byUploader[uploader] = [];
                              byUploader[uploader].push(d);
                            });
                            const offenseDocs = group.docs;
                            const style = group.style;
                            const offenseLabel = group.label;

                            return (
                              <div key={gIdx} className="space-y-2">
                                {/* Offense label */}
                                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${style.bgColor}`}>
                                  <span className={`text-xs font-black uppercase tracking-wider ${style.color}`}>{offenseLabel}</span>
                                  {group.admittedDate && <span className={`text-[10px] ${style.color} opacity-70`}>— Admitted {group.admittedDate}</span>}
                                  <span className={`text-[10px] ${style.color} opacity-70`}>· {offenseDocs.length} file{offenseDocs.length !== 1 ? 's' : ''}</span>
                                </div>

                                {/* Per-uploader subfolders */}
                                {offenseDocs.length === 0 && (
                                  <p className="text-xs text-gray-400 italic px-3 py-2">No documents uploaded yet for this offense.</p>
                                )}
                                {Object.entries(byUploader).map(([uploader, uploaderDocs]) => {
                                  const roleKey = `${folderId}-${gIdx}-${uploader}`;
                                  const isRoleOpen = expandedRoles[roleKey] ?? false;
                                  return (
                                    <div key={uploader} className="border border-gray-200 rounded-lg overflow-hidden bg-white ml-2">
                                      <button
                                        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-100 hover:bg-gray-200 transition-colors text-sm"
                                        onClick={() => toggleRole(roleKey)}
                                      >
                                        <User className="w-4 h-4 text-gray-500" />
                                        <span className="font-medium text-gray-700 flex-1 text-left">{uploader}</span>
                                        <span className="text-xs text-gray-400 mr-1">{uploaderDocs.length} file{uploaderDocs.length !== 1 ? 's' : ''}</span>
                                        {isRoleOpen ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRightIcon className="w-3.5 h-3.5 text-gray-400" />}
                                      </button>
                                      {isRoleOpen && (
                                        <div className="divide-y divide-gray-50">
                                          {uploaderDocs.map(doc => (
                                            <div key={doc.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50">
                                              <div className="shrink-0">{getFileIcon(doc.fileName || '')}</div>
                                              <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium text-gray-800 truncate">{doc.title}</p>
                                                <p className="text-xs text-gray-400">{doc.fileName} · {formatFileSize(doc.fileSize || 0)} · {doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleDateString() : ''}</p>
                                              </div>
                                              {getStatusBadge(doc.status)}
                                              <div className="flex gap-1 shrink-0">
                                                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => { setSelectedDocument(doc); setIsViewDialogOpen(true); }}>View</Button>
                                                <FolderDownloadButton doc={doc} />
                                                {canApprove && (doc.status === 'Submitted' || doc.status === 'Under Review') && (
                                                  <>
                                                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-green-600" onClick={() => handleApprove(doc)}>✓</Button>
                                                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-red-500" onClick={() => openRejectDialog(doc)}>✕</Button>
                                                  </>
                                                )}
                                                <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-red-500" onClick={() => { setDocumentToDelete(doc); setIsDeleteDialogOpen(true); }}><X className="w-3 h-3" /></Button>
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          });
                        })()}
                      </CardContent>
                    )}
                  </Card>
                );
              });
            })()}
            {documents.filter(d => children.filter(c => filterResident === 'all' || c.id === filterResident).some(c => c.id === d.residentId)).length === 0 && (
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
        <TabsContent value="all" className="mt-4">
          <DocumentList
            docs={filteredDocuments}
            children={children}
            canApprove={canApprove}
            onApprove={handleApprove}
            onReject={openRejectDialog}
            onView={handleView}
            onDelete={(doc) => { setDocumentToDelete(doc); setIsDeleteDialogOpen(true); }}
            getStatusBadge={getStatusBadge}
            getFileIcon={getFileIcon}
            formatFileSize={formatFileSize}
            userRole={userRole}
          />
        </TabsContent>

        {/* Pending Review tab (Center Head only) */}
        {canApprove && (
          <TabsContent value="pending" className="mt-4">
            <DocumentList
              docs={pendingDocs.filter(d => filterResident === 'all' || d.residentId === filterResident)}
              children={children}
              canApprove={canApprove}
              onApprove={handleApprove}
              onReject={openRejectDialog}
              onView={handleView}
              onDelete={(doc) => { setDocumentToDelete(doc); setIsDeleteDialogOpen(true); }}
              getStatusBadge={getStatusBadge}
              getFileIcon={getFileIcon}
              formatFileSize={formatFileSize}
              emptyMessage="No documents pending review."
              userRole={userRole}
            />
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
              <Select value={uploadResidentId} onValueChange={v => { setUploadResidentId(v); setDocumentTitle(''); }}>
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
                <Select value={documentTitle} onValueChange={setDocumentTitle}>
                  <SelectTrigger><SelectValue placeholder="Select document type" /></SelectTrigger>
                  <SelectContent>
                    {allowedDocuments.map(({ doc, phase }) => (
                      <SelectItem key={doc} value={doc}>
                        <span>{doc}</span>
                        <span className="ml-2 text-[10px] text-gray-400">({phase})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <Input
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Brief description of the document"
              />
            </div>

            <div className="space-y-2">
              <Label>File * (Max 10MB)</Label>
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
              disabled={isUploading || !selectedFile || !uploadResidentId || !documentTitle}
            >
              {isUploading ? 'Uploading...' : 'Upload Document'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* View Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
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
                  <p className="font-medium">{children.find(c => c.id === selectedDocument.residentId)?.name || 'Unknown'}</p>
                </div>
                <div>
                  <p className="text-gray-500">Category</p>
                  <p className="font-medium">{selectedDocument.category}</p>
                </div>
                <div>
                  <p className="text-gray-500">File Name</p>
                  <p className="font-medium">{selectedDocument.fileName}</p>
                </div>
                <div>
                  <p className="text-gray-500">File Size</p>
                  <p className="font-medium">{formatFileSize(selectedDocument.fileSize || 0)}</p>
                </div>
                <div>
                  <p className="text-gray-500">Uploaded By</p>
                  <p className="font-medium">{selectedDocument.uploadedBy}</p>
                </div>
                <div>
                  <p className="text-gray-500">Upload Date</p>
                  <p className="font-medium">{new Date(selectedDocument.uploadedAt || '').toLocaleString()}</p>
                </div>
              </div>
              {selectedDocument.description && (
                <div>
                  <p className="text-gray-500 text-sm mb-1">Description</p>
                  <p className="text-sm">{selectedDocument.description}</p>
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
                      src={selectedDocument.fileData}
                      className="w-full h-96"
                      title={selectedDocument.title}
                    />
                  ) : (
                    <div className="text-center py-8">
                      <p className="text-gray-500 mb-4">Preview not available for this file type</p>
                      <a 
                        href={selectedDocument.fileData}
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
    </div>
  );
}
