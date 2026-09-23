import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { systemDialog } from '@/app/components/SystemDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Badge } from '@/app/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Textarea } from '@/app/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/app/components/ui/alert-dialog';
import { Search, Plus, Eye, Edit, Trash2, Gavel, Calendar, User, FileText, Printer, Download, ChevronDown, ChevronUp } from 'lucide-react';
import { useData, CourtRecord } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { formatShortDate } from '@/utils/dateFormatter';

export function CourtRecords() {
  const { children, courtRecords, addCourtRecord, updateCourtRecord, deleteCourtRecord } = useData();
  const { user } = useAuth();
  
  const [searchTerm, setSearchTerm] = useState('');
  const location = useLocation();
  const [filterStatus, setFilterStatus] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('filter') || 'all';
  });

  // Sync filter when URL changes (e.g. navigated from Dashboard)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const f = params.get('filter');
    if (f) setFilterStatus(f);
  }, [location.search]);
  
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<CourtRecord | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<CourtRecord | null>(null);
  const [courtFormOpen, setCourtFormOpen] = useState(false);
  const [courtFormViewer, setCourtFormViewer] = useState(false);
  
  const [formData, setFormData] = useState({
    residentId: '',
    caseNumber: '',
    courtName: '',
    judge: '',
    prosecutor: '',
    publicAttorney: '',
    hearingType: '',
    hearingDate: '',
    hearingTime: '',
    courtOrder: '',
    nextHearingDate: '',
    status: 'Scheduled' as 'Scheduled' | 'Completed' | 'Postponed' | 'Cancelled',
    notes: '',
  });

  useEffect(() => {
    // On mount, schedule 1-hour-before reminders for any hearings today
    const today = new Date().toISOString().split('T')[0];
    const todayHearings = courtRecords.filter(r => r.hearingDate === today && r.status === 'Scheduled');
    if (todayHearings.length > 0 && 'Notification' in window) {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          todayHearings.forEach(r => {
            const residentName = children.find(c => c.id === r.residentId)?.name || 'Resident';
            scheduleHearingReminder({
              residentId: r.residentId, caseNumber: r.caseNumber || '',
              courtName: r.courtName || '', judge: r.judge || '',
              prosecutor: r.prosecutor || '', publicAttorney: r.publicAttorney || '',
              hearingType: r.hearingType || '', hearingDate: r.hearingDate,
              hearingTime: r.hearingTime || '08:00', courtOrder: r.courtOrder || '',
              nextHearingDate: r.nextHearingDate || '', status: r.status, notes: r.notes || '',
            }, residentName);
          });
        }
      });
    }
  }, [courtRecords]);

  const filteredRecords = courtRecords.filter((r) => {
    const resident = children.find((c) => c.id === r.residentId);
    const residentName = resident?.name || '';
    const matchesSearch = 
      residentName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (r.caseNumber || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (r.courtName || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === 'all' || r.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const scheduleHearingReminder = (record: typeof formData, residentName: string) => {
    // Calculate time until 1 hour before the hearing
    const hearingDateStr = record.hearingDate;
    const hearingTimeStr = record.hearingTime || '08:00';
    const hearingDt = new Date(`${hearingDateStr}T${hearingTimeStr}`);
    const reminderDt = new Date(hearingDt.getTime() - 60 * 60 * 1000); // 1hr before
    const now = new Date();
    const msUntilReminder = reminderDt.getTime() - now.getTime();

    if (msUntilReminder > 0 && msUntilReminder < 24 * 60 * 60 * 1000) {
      // Schedule the browser notification for today's hearings
      setTimeout(() => {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(`⚖️ Court Hearing Reminder`, {
            body: `${residentName}'s ${record.hearingType || 'hearing'} at ${record.courtName || 'court'} is in 1 hour (${hearingTimeStr}).`,
            icon: '/favicon.ico',
          });
        }
        // In-app reminder, in the system's own dialog rather than a browser box.
        void systemDialog.notify({
          title: 'Court hearing in 1 hour',
          description: `${residentName} has a hearing at ${hearingTimeStr}. Please notify the assigned Social Worker.`,
          tone: 'warning',
        });
      }, msUntilReminder);
    }
  };

  const handleSubmit = async () => {
    if (!formData.residentId || !formData.hearingDate) return;
    await addCourtRecord({ ...formData, createdBy: user?.username || 'System' });
    // Request notification permission and schedule reminder
    const residentName = children.find(c => c.id === formData.residentId)?.name || 'Resident';
    if ('Notification' in window) {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') scheduleHearingReminder(formData, residentName);
      });
    }
    setIsAddDialogOpen(false);
    resetForm();
  };

  const handleUpdate = async () => {
    if (!selectedRecord) return;
    await updateCourtRecord(selectedRecord.id, formData);
    setIsEditDialogOpen(false);
    setSelectedRecord(null);
  };

  const handleDelete = async () => {
    if (!recordToDelete) return;
    await deleteCourtRecord(recordToDelete.id);
    setIsDeleteDialogOpen(false);
    setRecordToDelete(null);
  };

  const resetForm = () => {
    setFormData({
      residentId: '',
      caseNumber: '',
      courtName: '',
      judge: '',
      prosecutor: '',
      publicAttorney: '',
      hearingType: '',
      hearingDate: '',
      hearingTime: '',
      courtOrder: '',
      nextHearingDate: '',
      status: 'Scheduled',
      notes: '',
    });
  };

  const openEditDialog = (record: CourtRecord) => {
    setSelectedRecord(record);
    setFormData({
      residentId: record.residentId,
      caseNumber: record.caseNumber || '',
      courtName: record.courtName || '',
      judge: record.judge || '',
      prosecutor: record.prosecutor || '',
      publicAttorney: record.publicAttorney || '',
      hearingType: record.hearingType || '',
      hearingDate: record.hearingDate,
      hearingTime: record.hearingTime || '',
      courtOrder: record.courtOrder || '',
      nextHearingDate: record.nextHearingDate || '',
      status: record.status,
      notes: record.notes || '',
    });
    setIsEditDialogOpen(true);
  };

  const openDeleteDialog = (record: CourtRecord) => {
    setRecordToDelete(record);
    setIsDeleteDialogOpen(true);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Completed': return 'bg-green-100 text-green-800';
      case 'Postponed': return 'bg-yellow-100 text-yellow-800';
      case 'Cancelled': return 'bg-red-100 text-red-800';
      default: return 'bg-blue-100 text-blue-800';
    }
  };

  const upcomingHearings = courtRecords.filter(
    (r) => r.status === 'Scheduled' && new Date(r.hearingDate) >= new Date()
  ).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-[#2F3E46]">Court Records</h2>
          <p className="text-gray-600">Manage court hearings and case proceedings</p>
        </div>
        <Button
        className="flex items-center gap-2 bg-[#2F3E46]"
        onClick={() => setIsAddDialogOpen(true)}
        >
          <Plus className="w-4 h-4" />
          <span>Add Hearing</span>
        </Button>
      </div>
      {/* Available Forms button + panel — follows the same pattern as Health */}
      <div>
        <button
          onClick={() => setCourtFormOpen(v => !v)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-green-200 text-green-700 bg-green-50 hover:bg-green-100 font-semibold text-sm transition-all"
        >
          <span>📋</span>
          {courtFormOpen ? 'Hide Forms' : 'Available Forms'}
        </button>
        {courtFormOpen && (
          <div className="mt-3 border border-green-200 rounded-2xl overflow-hidden bg-white shadow-sm">
            <div className="bg-green-600 px-5 py-3 flex items-center gap-2">
              <span className="text-white text-lg">📋</span>
              <h3 className="font-bold text-white">Court Records Forms</h3>
              <span className="text-green-200 text-xs ml-1">— Click to download</span>
            </div>
            <div className="divide-y divide-gray-100">
              <div className="flex items-center justify-between px-5 py-3 hover:bg-green-50 transition-all gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-green-100 flex items-center justify-center shrink-0">
                    <FileText className="w-4 h-4 text-green-700" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-[#2F3E46] text-sm">Feedback Report</p>
                    <p className="text-xs text-gray-400">Official court assistance feedback report.</p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    onClick={() => setCourtFormViewer(true)}
                    className="rounded-lg border border-green-200 px-2.5 py-1.5 text-xs font-bold text-green-600 hover:bg-green-100"
                  >
                    View
                  </button>
                  <button
                    onClick={() => { const w = window.open('/forms/feedback-report.pdf', '_blank'); w?.addEventListener('load', () => { try { w.print(); } catch {} }); }}
                    className="rounded-lg border border-green-200 px-2.5 py-1.5 text-xs font-bold text-green-600 hover:bg-green-100"
                  >
                    Print
                  </button>
                  <button
                    onClick={() => { const link = document.createElement('a'); link.href = '/forms/feedback-report.pdf'; link.download = 'Feedback Report.pdf'; link.click(); }}
                    className="rounded-lg border border-green-200 px-2.5 py-1.5 text-xs font-bold text-green-600 hover:bg-green-100"
                  >
                    Download
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {courtFormViewer && (
        <Dialog open={true} onOpenChange={(open) => !open && setCourtFormViewer(false)}>
          <DialogContent className="flex h-[92vh] w-[96vw] max-w-6xl flex-col gap-0 overflow-hidden rounded-2xl p-0">
            <DialogHeader className="flex shrink-0 flex-row items-center justify-between border-b px-5 py-3">
              <DialogTitle className="text-[#2F3E46]">Feedback Report</DialogTitle>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => { const w = window.open('/forms/feedback-report.pdf', '_blank'); w?.addEventListener('load', () => { try { w.print(); } catch {} }); }}>
                  <Printer className="h-4 w-4 mr-1" /> Print
                </Button>
                <a href="/forms/feedback-report.pdf" download="Feedback Report.pdf" className="inline-flex items-center gap-2 rounded-md bg-[#2F3E46] px-3 py-2 text-xs font-bold text-white">
                  <Download className="h-4 w-4" /> Download
                </a>
              </div>
            </DialogHeader>
            <div className="min-h-0 flex-1 bg-neutral-200 p-2 sm:p-4">
              <iframe title="Feedback Report" src="/forms/feedback-report.pdf" className="h-full w-full rounded-lg border bg-white" />
            </div>
          </DialogContent>
        </Dialog>
      )}


      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Gavel className="w-8 h-8 text-blue-500" />
              <div>
                <p className="text-sm text-gray-500">Total Records</p>
                <p className="text-2xl font-bold">{courtRecords.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Calendar className="w-8 h-8 text-green-500" />
              <div>
                <p className="text-sm text-gray-500">Upcoming Hearings</p>
                <p className="text-2xl font-bold">{upcomingHearings}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <User className="w-8 h-8 text-orange-500" />
              <div>
                <p className="text-sm text-gray-500">Residents with Cases</p>
                <p className="text-2xl font-bold">{new Set(courtRecords.map((r) => r.residentId)).size}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder="Search by resident name, case number, or court..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="Scheduled">Scheduled</SelectItem>
                <SelectItem value="Completed">Completed</SelectItem>
                <SelectItem value="Postponed">Postponed</SelectItem>
                <SelectItem value="Cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Court Records List */}
      <div className="space-y-4">
        {filteredRecords.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Gavel className="w-12 h-12 mx-auto mb-4 text-gray-300" />
              <p className="text-gray-500">No court records found matching your criteria.</p>
            </CardContent>
          </Card>
        ) : (
          filteredRecords.map((record) => {
            const resident = children.find((c) => c.id === record.residentId);
            return (
              <Card key={record.id} className="hover:shadow-md transition-shadow">
                <CardContent className="p-6">
                  <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-lg font-semibold text-[#2F3E46]">{resident?.name || 'Unknown Resident'}</h3>
                        <Badge className={getStatusColor(record.status)}>{record.status}</Badge>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-gray-600">
                        <p><span className="font-medium">Case Number:</span> {record.caseNumber || 'N/A'}</p>
                        <p><span className="font-medium">Court:</span> {record.courtName || 'N/A'}</p>
                        <p><span className="font-medium">Hearing Date:</span> {formatShortDate(record.hearingDate)} {record.hearingTime && `at ${record.hearingTime}`}</p>
                        <p><span className="font-medium">Type:</span> {record.hearingType || 'N/A'}</p>
                        {record.judge && <p><span className="font-medium">Judge:</span> {record.judge}</p>}
                        {record.nextHearingDate && (
                          <p><span className="font-medium">Next Hearing:</span> {formatShortDate(record.nextHearingDate)}</p>
                        )}
                      </div>
                      {record.courtOrder && (
                        <div className="mt-3 p-3 bg-gray-50 rounded-lg">
                          <p className="text-sm font-medium text-gray-700">Court Order:</p>
                          <p className="text-sm text-gray-600">{record.courtOrder}</p>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => openEditDialog(record)}>
                        <Edit className="w-4 h-4 mr-1" /> Edit
                      </Button>
                      <Button variant="outline" size="sm" className="text-red-600" onClick={() => openDeleteDialog(record)}>
                        <Trash2 className="w-4 h-4 mr-1" /> Delete
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Add/Edit Dialog — the same form serves both modes. The Edit mode was
          previously unreachable: openEditDialog() set isEditDialogOpen, but no
          dialog was bound to that flag, so the Edit button did nothing. */}
      <Dialog
        open={isAddDialogOpen || isEditDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsAddDialogOpen(false);
            setIsEditDialogOpen(false);
            setSelectedRecord(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEditDialogOpen ? 'Edit Court Hearing' : 'Add Court Hearing'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-4">
            <div className="space-y-2">
              <Label>Resident *</Label>
              <Select value={formData.residentId} onValueChange={(value) => setFormData({ ...formData, residentId: value })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select resident" />
                </SelectTrigger>
                <SelectContent>
                  {children.map((child) => (
                    <SelectItem key={child.id} value={child.id}>{child.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Case Number</Label>
              <Input value={formData.caseNumber} onChange={(e) => setFormData({ ...formData, caseNumber: e.target.value })} placeholder="e.g., CRM-2024-001" />
            </div>
            <div className="space-y-2">
              <Label>Court Name</Label>
              <Input value={formData.courtName} onChange={(e) => setFormData({ ...formData, courtName: e.target.value })} placeholder="e.g., RTC Branch 52" />
            </div>
            <div className="space-y-2">
              <Label>Judge</Label>
              <Input value={formData.judge} onChange={(e) => setFormData({ ...formData, judge: e.target.value })} placeholder="Hon. [Name]" />
            </div>
            <div className="space-y-2">
              <Label>Prosecutor</Label>
              <Input value={formData.prosecutor} onChange={(e) => setFormData({ ...formData, prosecutor: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Public Attorney</Label>
              <Input value={formData.publicAttorney} onChange={(e) => setFormData({ ...formData, publicAttorney: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Hearing Date *</Label>
              <Input type="date" value={formData.hearingDate} onChange={(e) => setFormData({ ...formData, hearingDate: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Hearing Time</Label>
              <Input type="time" value={formData.hearingTime} onChange={(e) => setFormData({ ...formData, hearingTime: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Hearing Type</Label>
              <Select value={formData.hearingType} onValueChange={(value) => setFormData({ ...formData, hearingType: value })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Arraignment">Arraignment</SelectItem>
                  <SelectItem value="Pre-Trial">Pre-Trial</SelectItem>
                  <SelectItem value="Trial">Trial</SelectItem>
                  <SelectItem value="Disposition">Disposition</SelectItem>
                  <SelectItem value="Sentencing">Sentencing</SelectItem>
                  <SelectItem value="Appeal">Appeal</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value as any })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Scheduled">Scheduled</SelectItem>
                  <SelectItem value="Completed">Completed</SelectItem>
                  <SelectItem value="Postponed">Postponed</SelectItem>
                  <SelectItem value="Cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Court Order / Notes</Label>
              <Textarea value={formData.courtOrder} onChange={(e) => setFormData({ ...formData, courtOrder: e.target.value })} placeholder="Enter court orders or case notes..." rows={3} />
            </div>
            <div className="space-y-2">
              <Label>Next Hearing Date</Label>
              <Input type="date" value={formData.nextHearingDate} onChange={(e) => setFormData({ ...formData, nextHearingDate: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsAddDialogOpen(false);
                setIsEditDialogOpen(false);
                setSelectedRecord(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={isEditDialogOpen ? handleUpdate : handleSubmit}
              className="bg-[#2F3E46]"
            >
              {isEditDialogOpen ? 'Update Record' : 'Save Record'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit and Delete dialogs */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Court Record</AlertDialogTitle>
            <AlertDialogDescription>Are you sure you want to delete this court record?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setIsDeleteDialogOpen(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
