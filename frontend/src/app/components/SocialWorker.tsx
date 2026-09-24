import { useState, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { Search, FolderPlus, ShieldCheck, Users, ChevronDown, Calendar, Gavel, FileText, Clock, AlertCircle } from 'lucide-react';
import { Input } from '@/app/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/app/components/ui/dialog';
import { Label } from '@/app/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Textarea } from '@/app/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import { useData } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { systemDialog } from '@/app/components/SystemDialog';
import { formatShortDate, isTodayOrLater } from '@/utils/dateFormatter';

// Social Worker component now connected to real database via DataContext

const getStatusColor = (status?: string | null) => {
  switch (status?.toLowerCase()) {
    case 'active':
    case 'scheduled':
      return 'bg-emerald-100 text-emerald-700';
    case 'review':
    case 'under investigation':
      return 'bg-amber-100 text-amber-700';
    case 'completed':
    case 'resolved':
      return 'bg-green-100 text-green-700';
    case 'escalated':
    case 'cancelled':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-sky-100 text-sky-700';
  }
};

export function SocialWorker() {
  const { children, courtRecords, violations, assessments, phaseProgress } = useData();
  const { user } = useAuth();
  
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<string | undefined>('cases');
  const [expandedCase, setExpandedCase] = useState<string | null>(null);
  const [selectedResident, setSelectedResident] = useState<string>('');
  const [newCaseNote, setNewCaseNote] = useState({
    resident: '',
    caseType: 'Case Note',
    note: '',
  });

  // Get children assigned to this social worker (or all if admin)
  const assignedResidents = useMemo(() => {
    // In a real system, this would filter by assigned social worker
    // For now, show all residents
    return children.filter(child => 
      (child.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (child.caseType || '').toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [children, searchTerm]);

  // Get upcoming court hearings for assigned residents.
  // "Upcoming" is a calendar-day question, not an instant one: `new Date(record.hearingDate)`
  // is UTC midnight, so comparing it with `new Date()` hid every hearing due today.
  const upcomingHearings = useMemo(() => {
    return courtRecords.filter(record =>
      isTodayOrLater(record.hearingDate) && record.status === 'Scheduled'
    ).sort((a, b) => String(a.hearingDate || '').localeCompare(String(b.hearingDate || '')));
  }, [courtRecords]);

  // Get residents with violations
  const residentsWithViolations = useMemo(() => {
    const residentIds = new Set(violations.filter(v => v.status !== 'Resolved').map(v => v.residentId));
    return children.filter(c => residentIds.has(c.id));
  }, [violations, children]);

  const handleAddNote = () => {
    // Still a local-only stub: nothing is written, so the dialog says what
    // actually happened rather than claiming the note was saved.
    void systemDialog.notify({
      title: 'Case note added to this session',
      description: `The note for ${newCaseNote.resident} is on screen only — case notes are not stored yet, so it will be lost when you leave the page.`,
      tone: 'info',
    });
    setNewCaseNote({ resident: '', caseType: 'Case Note', note: '' });
  };

  // Get resident active violation count
  const getResidentViolationCount = (residentId: string) => {
    return violations.filter(
      v => v.residentId === residentId && v.status !== 'Resolved'
    ).length;
  };

  // Get resident assessments
  const getResidentAssessments = (residentId: string) => {
    return assessments.filter(a => a.forResidents?.some((r: any) => r.id === residentId));
  };

  // Get resident court records
  const getResidentCourtRecords = (residentId: string) => {
    return courtRecords.filter(c => c.residentId === residentId);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Social Worker Hub</h2>
          <p className="text-gray-600">Manage resident case histories, family profiles, court records, and DSWD coordination.</p>
        </div>
        <Dialog>
          <DialogTrigger asChild>
            <Button className="flex items-center gap-2" style={{ backgroundColor: '#2F3E46' }}>
              <FolderPlus className="w-4 h-4" />
              <span>New Case Note</span>
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Case Note</DialogTitle>
              <DialogDescription>Record important case updates, family information, or court-related activities.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Resident Name</Label>
                <Select value={newCaseNote.resident} onValueChange={(value) => setNewCaseNote({ ...newCaseNote, resident: value })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select resident..." />
                  </SelectTrigger>
                  <SelectContent>
                    {children.map((child) => (
                      <SelectItem key={child.id} value={child.name}>
                        {child.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Note Type</Label>
                <Select value={newCaseNote.caseType} onValueChange={(value) => setNewCaseNote({ ...newCaseNote, caseType: value })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Case Note">Case Note</SelectItem>
                    <SelectItem value="Family Background">Family Background</SelectItem>
                    <SelectItem value="Court Update">Court Update</SelectItem>
                    <SelectItem value="DSWD Communication">DSWD Communication</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Details</Label>
                <Textarea
                  placeholder="Enter case note details..."
                  value={newCaseNote.note}
                  onChange={(e) => setNewCaseNote({ ...newCaseNote, note: e.target.value })}
                  rows={4}
                />
              </div>
              <Button className="w-full" style={{ backgroundColor: '#2F3E46' }} onClick={handleAddNote}>
                Save Case Note
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg flex items-center justify-center bg-slate-100 text-slate-700">
                <Users className="w-6 h-6" />
              </div>
              <div>
                <p className="text-sm text-gray-600">Total Residents</p>
                <p className="text-2xl font-semibold text-slate-900">{children.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg flex items-center justify-center bg-slate-100 text-slate-700">
                <Gavel className="w-6 h-6" />
              </div>
              <div>
                <p className="text-sm text-gray-600">Upcoming Court Dates</p>
                <p className="text-2xl font-semibold text-slate-900">{upcomingHearings.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg flex items-center justify-center bg-red-100 text-red-700">
                <AlertCircle className="w-6 h-6" />
              </div>
              <div>
                <p className="text-sm text-gray-600">Active Violations</p>
                <p className="text-2xl font-semibold text-red-600">{residentsWithViolations.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg flex items-center justify-center bg-blue-100 text-blue-700">
                <Calendar className="w-6 h-6" />
              </div>
              <div>
                <p className="text-sm text-gray-600">Open Cases</p>
                <p className="text-2xl font-semibold text-slate-900">8</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="residents" value={activeTab} onValueChange={setActiveTab} className="w-full">
        {/* Four labels in a fixed 4-column grid wrap badly on a phone. */}
        <TabsList className="flex w-full max-w-full items-center justify-start gap-1 overflow-x-auto lg:grid lg:grid-cols-4">
          <TabsTrigger value="residents" className="flex-none lg:flex-1">Residents</TabsTrigger>
          <TabsTrigger value="court" className="flex-none lg:flex-1">Court Records</TabsTrigger>
          <TabsTrigger value="violations" className="flex-none lg:flex-1">Violations</TabsTrigger>
          <TabsTrigger value="timeline" className="flex-none lg:flex-1">Timeline</TabsTrigger>
        </TabsList>

        {/* RESIDENTS TAB */}
        <TabsContent value="residents" className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
                <div>
                  <CardTitle className="text-lg">Resident Cases</CardTitle>
                  <CardDescription>View and manage all assigned resident cases.</CardDescription>
                </div>
                <div className="w-full sm:w-1/3">
                  <Input
                    placeholder="Search residents..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4">
            {assignedResidents.map((resident) => {
              const violationCount = getResidentViolationCount(resident.id);
              const residentAssessments = getResidentAssessments(resident.id);
              const residentCourts = getResidentCourtRecords(resident.id);
              return (
                <Card key={resident.id} className="hover:shadow-md transition-shadow">
                  <CardContent className="p-6">
                    <div className="flex flex-col sm:flex-row justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-3">
                          <div>
                            <p className="text-sm font-medium text-slate-700">{resident.name}</p>
                            <p className="text-xs text-gray-500">ID: {resident.id}</p>
                          </div>
                          <Badge className={getStatusColor(resident.casePhase || 'Active')}>
                            {resident.casePhase || 'Admission'}
                          </Badge>
                          {violationCount > 0 && (
                            <Badge className="bg-orange-100 text-orange-700">
                              {violationCount} active violation{violationCount !== 1 ? 's' : ''}
                            </Badge>
                          )}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm text-gray-700">
                          <div>
                            <p className="font-medium">Case Type</p>
                            <p>{resident.caseType}</p>
                          </div>
                          <div>
                            <p className="font-medium">Age / Gender</p>
                            <p>{resident.age} / {resident.gender}</p>
                          </div>
                          <div>
                            <p className="font-medium">Admission Date</p>
                            <p>{formatShortDate(resident.admissionDate)}</p>
                          </div>
                          <div>
                            <p className="font-medium">Assessments</p>
                            <p>{residentAssessments.length} scheduled</p>
                          </div>
                          <div>
                            <p className="font-medium">Court Records</p>
                            <p>{residentCourts.length} hearings</p>
                          </div>
                          <div>
                            <p className="font-medium">Address</p>
                            <p className="truncate">{resident.address || 'N/A'}</p>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center justify-end">
                        <ChevronDown className={`w-5 h-5 transition-transform ${expandedCase === resident.id ? 'transform rotate-180' : ''}`} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        {/* COURT RECORDS TAB */}
        <TabsContent value="court" className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <Gavel className="w-5 h-5" /> Court Hearings & Case Records
              </CardTitle>
              <CardDescription>View upcoming and past court hearings for all residents.</CardDescription>
            </CardContent>
          </Card>

          {upcomingHearings.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-gray-500">
                <Gavel className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p>No upcoming court hearings scheduled.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {upcomingHearings.map((hearing) => {
                const resident = children.find(c => c.id === hearing.residentId);
                return (
                  <Card key={hearing.id}>
                    <CardContent className="p-6">
                      <div className="flex flex-col sm:flex-row justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2">
                            <p className="font-semibold text-slate-900">{resident?.name || 'Unknown Resident'}</p>
                            <Badge className={getStatusColor(hearing.status)}>{hearing.status}</Badge>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-gray-700">
                            <div>
                              <p className="font-medium">Case Number</p>
                              <p>{hearing.caseNumber || 'N/A'}</p>
                            </div>
                            <div>
                              <p className="font-medium">Court</p>
                              <p>{hearing.courtName || 'N/A'}</p>
                            </div>
                            <div>
                              <p className="font-medium">Hearing Date</p>
                              <p>{formatShortDate(hearing.hearingDate)} {hearing.hearingTime && `at ${hearing.hearingTime}`}</p>
                            </div>
                            <div>
                              <p className="font-medium">Type</p>
                              <p>{hearing.hearingType || 'N/A'}</p>
                            </div>
                            {hearing.judge && (
                              <div>
                                <p className="font-medium">Judge</p>
                                <p>{hearing.judge}</p>
                              </div>
                            )}
                            {hearing.nextHearingDate && (
                              <div>
                                <p className="font-medium">Next Hearing</p>
                                <p>{formatShortDate(hearing.nextHearingDate)}</p>
                              </div>
                            )}
                          </div>
                          {hearing.courtOrder && (
                            <div className="mt-3 p-3 bg-gray-50 rounded-lg">
                              <p className="text-xs font-medium text-gray-500">Court Order:</p>
                              <p className="text-sm text-gray-700">{hearing.courtOrder}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* VIOLATIONS TAB */}
        <TabsContent value="violations" className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <AlertCircle className="w-5 h-5" /> Active Violations
              </CardTitle>
              <CardDescription>Residents with pending violations requiring attention.</CardDescription>
            </CardContent>
          </Card>

          {residentsWithViolations.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-gray-500">
                <ShieldCheck className="w-12 h-12 mx-auto mb-3 text-green-300" />
                <p>No active violations. All residents in good standing.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {residentsWithViolations.map((resident) => {
                const residentViolations = violations.filter(v => v.residentId === resident.id && v.status !== 'Resolved');
                return (
                  <Card key={resident.id}>
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <p className="font-semibold text-slate-900">{resident.name}</p>
                          <p className="text-xs text-gray-500">ID: {resident.id}</p>
                        </div>
                        <Badge className="bg-orange-100 text-orange-700">
                          {residentViolations.length} Active Violation{residentViolations.length !== 1 ? 's' : ''}
                        </Badge>
                      </div>
                      <div className="space-y-2">
                        {residentViolations.slice(0, 3).map((v) => (
                          <div key={v.id} className="flex justify-between items-center p-2 bg-gray-50 rounded">
                            <div>
                              <p className="text-sm font-medium">{v.type}</p>
                              <p className="text-xs text-gray-500">{formatShortDate(v.date)} • {v.severity}</p>
                            </div>
                            <Badge variant="outline">{v.status}</Badge>
                          </div>
                        ))}
                        {residentViolations.length > 3 && (
                          <p className="text-xs text-gray-500 text-center">+ {residentViolations.length - 3} more violations</p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* TIMELINE TAB */}
        <TabsContent value="timeline" className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className="w-5 h-5" /> Case Progress Timeline
              </CardTitle>
              <CardDescription>Chronological view of phase transitions, court dates, and assessments.</CardDescription>
            </CardContent>
          </Card>

          <div className="space-y-4">
            {phaseProgress.length === 0 ? (
              <Card>
                <CardContent className="p-8 text-center text-gray-500">
                  <Clock className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                  <p>No timeline events recorded yet.</p>
                </CardContent>
              </Card>
            ) : (
              phaseProgress.slice(0, 20).map((progress) => {
                const resident = children.find(c => c.id === progress.residentId);
                return (
                  <Card key={progress.id}>
                    <CardContent className="p-6">
                      <div className="flex gap-4">
                        <div className="flex flex-col items-center">
                          <div className={`w-3 h-3 rounded-full mt-1.5 ${progress.isCurrent ? 'bg-blue-500' : progress.completedAt ? 'bg-green-500' : 'bg-gray-400'}`}></div>
                          <div className="w-0.5 h-full bg-gray-200 mt-2"></div>
                        </div>
                        <div className="flex-1 pb-4">
                          <p className="text-sm font-medium text-slate-700">{progress.enteredAt}</p>
                          <p className="text-sm text-gray-900 mt-1">
                            <span className="font-semibold">{resident?.name}</span> entered <span className="font-medium">{progress.phaseName}</span> phase
                          </p>
                          {progress.completedAt && (
                            <p className="text-xs text-green-600 mt-1">Completed: {progress.completedAt}</p>
                          )}
                          {progress.notes && (
                            <p className="text-xs text-gray-500 mt-1">{progress.notes}</p>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
