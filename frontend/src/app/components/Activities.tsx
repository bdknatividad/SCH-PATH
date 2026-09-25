import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData, Activity } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { usePermissions } from '@/app/hooks/usePermissions';
import { describeError } from '@/services/api';
import { systemDialog } from '@/app/components/SystemDialog';
import { formatShortDate } from '@/utils/dateFormatter';
import { Card, CardContent } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Badge } from '@/app/components/ui/badge';
import { 
  Search, Plus, Edit, Trash2, X, Calendar,
  User, Users, MapPin, Eye, ShieldAlert, ThumbsUp, ThumbsDown, AlertTriangle
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/app/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/app/components/ui/alert-dialog';
import { Label } from '@/app/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Textarea } from '@/app/components/ui/textarea';
import { Checkbox } from '@/app/components/ui/checkbox';

// 1. FIXED: Idinagdag ang Interface para mawala ang 'any' errors

const activityCategories = ['Physical', 'Educational', 'Psychosocial', 'Recreational', 'Livelihood'];

export function Activities() {
  const navigate = useNavigate();
  const { children: allChildren, activities, addActivity, updateActivity, deleteActivity, isLoading, error } = useData();
  const { user } = useAuth();
  const isPsychologist = user?.role === 'psychologist' || user?.role === 'centerhead';
  const isHouseparent = user?.role?.toLowerCase() === 'houseparent';
  const { can } = usePermissions();
  const liveResidents = useMemo(
    () => allChildren.map(c => ({ id: c.id, name: c.name, caseType: c.caseType, age: c.age })),
    [allChildren]
  );

  const [searchTerm, setSearchTerm] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  
  const [activityToDelete, setActivityToDelete] = useState<Activity | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([]);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([]);
  const [participantSearchTerm, setParticipantSearchTerm] = useState('');
  const [newFacilitatorName, setNewFacilitatorName] = useState('');
  const [restrictDialogActivity, setRestrictDialogActivity] = useState<Activity | null>(null);
  const [restrictChildId, setRestrictChildId] = useState('');
  const [restrictReason, setRestrictReason] = useState('');
  const [isRestrictDialogOpen, setIsRestrictDialogOpen] = useState(false);
  
  const [formState, setFormState] = useState({
    title: '',
    category: activityCategories[0],
    date: '',
    time: '',
    location: '',
    facilitators: [] as string[],
    notes: '',
    status: 'Upcoming'
  });

  const filteredParticipantResidents = useMemo(() => {
    const normalizedSearch = participantSearchTerm.trim().toLowerCase();
    if (!normalizedSearch) return liveResidents;

    return liveResidents.filter((resident) =>
      [resident.name, resident.id, resident.caseType]
        .some((value) => String(value || '').toLowerCase().includes(normalizedSearch))
    );
  }, [liveResidents, participantSearchTerm]);

  const addFacilitator = () => {
    if (newFacilitatorName.trim()) {
      setFormState(prev => ({
        ...prev,
        facilitators: [...(Array.isArray(prev.facilitators) ? prev.facilitators : []), newFacilitatorName.trim()]
      }));
      setNewFacilitatorName('');
    }
  };

  const removeFacilitator = (name: string) => {
    setFormState(prev => ({
      ...prev,
      facilitators: (Array.isArray(prev.facilitators) ? prev.facilitators : []).filter(f => f !== name)
    }));
  };

  const toggleParticipant = (res: { id: string; name: string; caseType?: string; age?: number }) => {
    setSelectedParticipants(prev =>
      Array.isArray(prev)
        ? prev.includes(res.name) ? prev.filter(p => p !== res.name) : [...prev, res.name]
        : [res.name]
    );
    setSelectedParticipantIds(prev =>
      Array.isArray(prev)
        ? prev.includes(res.id) ? prev.filter(id => id !== res.id) : [...prev, res.id]
        : [res.id]
    );
  };

  const handleEditClick = (activity: any) => {
    setEditingId(activity.id);
    setFormState({
      title: activity.title,
      category: activity.category || activity.type || activityCategories[0],
      date: activity.date,
      time: activity.time,
      location: activity.location || '',
      facilitators: Array.isArray(activity.facilitators) ? [...activity.facilitators] : Array.isArray(activity.personInCharge) ? [...activity.personInCharge] : [],
      notes: activity.notes || activity.description || '',
      status: activity.status
    });
    setSelectedParticipants(Array.isArray(activity.participants) ? activity.participants : []);
    setSelectedParticipantIds(Array.isArray(activity.selectedResidentIds) ? activity.selectedResidentIds : []);
    setParticipantSearchTerm('');
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    // View-only for Houseparents (the API refuses the write as well).
    if (isHouseparent) return;
    if (!formState.title || !formState.date || formState.facilitators.length === 0) {
      void systemDialog.validation('Some required fields are still blank', {
        items: [
          !formState.title ? 'Title' : '',
          !formState.date ? 'Date' : '',
          formState.facilitators.length === 0 ? 'At least one facilitator' : '',
        ].filter(Boolean),
        description: 'Fill these in before saving the activity.',
      });
      return;
    }
    if (isSaving) return;

    const activityData = {
      ...formState,
      type: formState.category,
      description: formState.notes,
      personInCharge: formState.facilitators,
      participants: selectedParticipants,
      selectedResidentIds: selectedParticipantIds
    };

    // Await the write and only close the dialog once it actually succeeded.
    // Previously the dialog closed unconditionally, so a rejected save looked
    // exactly like a successful one.
    setIsSaving(true);
    try {
      if (editingId) {
        await updateActivity(editingId, activityData as any);
      } else {
        await addActivity(activityData as any);
      }
      resetForm();
    } catch (err) {
      void systemDialog.failure('Could not save the activity', describeError(err, 'The activity was not saved. Please try again.'));
    } finally {
      setIsSaving(false);
    }
  };

  const resetForm = () => {
    setFormState({ 
      title: '', category: activityCategories[0], date: '', 
      time: '', location: '', facilitators: [], notes: '', status: 'Upcoming' 
    });
    setEditingId(null);
    setSelectedParticipants([]);
    setSelectedParticipantIds([]);
    setParticipantSearchTerm('');
    setNewFacilitatorName('');
    setIsDialogOpen(false);
  };

  // Psychological Staff: mark a child as NOT recommended for an activity
  const handleRestrictChild = async () => {
    if (!restrictDialogActivity || !restrictChildId) return;
    const notRec = [...(restrictDialogActivity.notRecommendedResidentIds || [])];
    const reasons: Record<string, string> = { ...(restrictDialogActivity.notRecommendedReasons || {}) };
    // Also remove from enrolled if present
    const enrolled = (restrictDialogActivity.selectedResidentIds || []).filter(id => id !== restrictChildId);
    const recommended = (restrictDialogActivity.recommendedResidentIds || []).filter(id => id !== restrictChildId);
    if (!notRec.includes(restrictChildId)) notRec.push(restrictChildId);
    reasons[restrictChildId] = restrictReason || 'Not suitable for this activity';
    await updateActivity(restrictDialogActivity.id, {
      notRecommendedResidentIds: notRec,
      notRecommendedReasons: reasons,
      selectedResidentIds: enrolled,
      recommendedResidentIds: recommended,
    });
    setIsRestrictDialogOpen(false);
    setRestrictChildId('');
    setRestrictReason('');
    setRestrictDialogActivity(null);
  };

  const filteredActivities = activities.filter((a: Activity) => 
    (a.title || '').toLowerCase().includes(searchTerm.toLowerCase()) || 
    (a.location && a.location.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="space-y-6 p-2">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-[#2F3E46]">Activities</h2>
          <p className="text-sm text-gray-500">Schedule and monitor community shelter activities</p>
        </div>
        {/* Scheduling is a `create` capability on Activities. The Social Worker
            holds view/edit/delete but not create, so this button follows the
            definition rather than a role test. */}
        {/* Houseparents are view-only on Activities: no Add button, whatever a
            cached permission snapshot says (the API refuses the write too). */}
        {can('Activities', 'create') && !isHouseparent && (
          <Dialog open={isDialogOpen} onOpenChange={(open) => { if(!open) resetForm(); setIsDialogOpen(open); }}>
            <DialogTrigger asChild>
              <Button 
                style={{ backgroundColor: '#FFD100', color: '#2F3E46' }}
                className="hover:opacity-90 font-bold shadow-sm rounded-lg"
                onClick={() => resetForm()}
              >
                <Plus className="w-4 h-4 mr-2" /> New Activity
              </Button>
            </DialogTrigger>
          <DialogContent className="max-w-2xl bg-white rounded-2xl overflow-hidden p-0">
            <DialogHeader className="p-6 border-b bg-gray-50/50">
              <DialogTitle className="text-[#2F3E46] text-xl font-bold">
                {editingId ? 'Edit Activity' : 'Plan New Activity'}
              </DialogTitle>
            </DialogHeader>
            
            <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto text-black">
              {/* Form fields remain the same... */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2 col-span-2 md:col-span-1">
                  <Label className="font-bold text-[#2F3E46]">Activity Title</Label>
                  <Input 
                    value={formState.title} 
                    onChange={(e) => setFormState({...formState, title: e.target.value})} 
                    placeholder="e.g. Skills Training" 
                    className="rounded-xl"
                  />
                </div>
                <div className="space-y-2 col-span-2 md:col-span-1">
                  <Label className="font-bold text-[#2F3E46]">Category</Label>
                  <Select value={formState.category} onValueChange={(v) => setFormState({...formState, category: v})}>
                    <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-white">
                      {activityCategories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Facilitators section */}
              <div className="space-y-3">
                <Label className="font-bold text-[#2F3E46]">Facilitators (Staff In-Charge)</Label>
                <div className="flex gap-2">
                  <Input 
                    placeholder="Add facilitator name..." 
                    value={newFacilitatorName}
                    onChange={(e) => setNewFacilitatorName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addFacilitator())}
                    className="rounded-xl"
                  />
                  <Button onClick={addFacilitator} style={{ backgroundColor: '#2F3E46' }} className="text-white px-4 rounded-xl">
                    Add
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  {formState.facilitators.map((name, i) => (
                    <Badge key={i} variant="secondary" className="bg-gray-100 text-[#2F3E46] border-none py-1.5 px-3 rounded-lg flex items-center gap-2">
                      {name}
                      <button type="button" onClick={() => removeFacilitator(name)} className="text-gray-400 hover:text-red-500">
                        <X size={14} />
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Date, Time, Location remain unchanged... */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="font-bold text-[#2F3E46]">Date</Label>
                  <Input type="date" value={formState.date} onChange={(e) => setFormState({...formState, date: e.target.value})} className="rounded-xl" />
                </div>
                <div className="space-y-2">
                  <Label className="font-bold text-[#2F3E46]">Time</Label>
                  <Input type="time" value={formState.time} onChange={(e) => setFormState({...formState, time: e.target.value})} className="rounded-xl" />
                </div>
              </div>

              <div className="space-y-2">
                <Label className="font-bold text-[#2F3E46]">Location / Venue</Label>
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
                  <Input 
                    className="pl-10 rounded-xl" 
                    placeholder="e.g. Conference Room A" 
                    value={formState.location}
                    onChange={(e) => setFormState({...formState, location: e.target.value})}
                  />
                </div>
              </div>

              {/* Participant Residents Selection */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="font-bold text-[#2F3E46]">Participant Residents</Label>
                  <span className="text-xs text-gray-400">{selectedParticipantIds.length} selected</span>
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
                  <Input
                    value={participantSearchTerm}
                    onChange={(e) => setParticipantSearchTerm(e.target.value)}
                    placeholder="Search residents by name..."
                    aria-label="Search participant residents"
                    className="pl-10 pr-10 rounded-xl"
                  />
                  {participantSearchTerm && (
                    <button
                      type="button"
                      aria-label="Clear resident search"
                      title="Clear resident search"
                      onClick={() => setParticipantSearchTerm('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#2F3E46]"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
                {isLoading && liveResidents.length === 0 ? (
                  <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100 text-sm text-gray-500 text-center">
                    Loading residents...
                  </div>
                ) : error && liveResidents.length === 0 ? (
                  <div className="p-4 bg-red-50 rounded-2xl border border-red-100 text-sm text-red-600 text-center">
                    Unable to load residents. Please try again.
                  </div>
                ) : liveResidents.length === 0 ? (
                  <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100 text-sm text-gray-400 italic text-center">
                    No residents found. Add residents in Child Records first.
                  </div>
                ) : filteredParticipantResidents.length === 0 ? (
                  <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100 text-sm text-gray-500 text-center">
                    No residents match "{participantSearchTerm}".
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 p-4 bg-gray-50 rounded-2xl border border-gray-100 max-h-56 overflow-y-auto">
                    {filteredParticipantResidents.map((res) => (
                      <div
                        key={res.id}
                        onClick={() => toggleParticipant(res)}
                        className={`flex items-center gap-3 p-2.5 rounded-xl border cursor-pointer transition-all
                          ${selectedParticipantIds.includes(res.id)
                            ? 'bg-[#2F3E46] border-[#2F3E46] text-white'
                            : 'bg-white border-gray-100 shadow-sm hover:border-[#FFD100]'
                          }`}
                      >
                        <Checkbox
                          id={`res-${res.id}`}
                          checked={selectedParticipantIds.includes(res.id)}
                          onCheckedChange={() => toggleParticipant(res)}
                          className="pointer-events-none"
                        />
                        <div className="min-w-0">
                          <p className={`text-sm font-bold leading-tight truncate ${selectedParticipantIds.includes(res.id) ? 'text-white' : 'text-[#2F3E46]'}`}>
                            {res.name}
                          </p>
                          <p className={`text-[10px] truncate ${selectedParticipantIds.includes(res.id) ? 'text-[#FFD100]' : 'text-gray-400'}`}>
                            {res.id} · {res.caseType} · {res.age} yrs
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label className="font-bold text-[#2F3E46]">Activity Notes</Label>
                <Textarea 
                  placeholder="Additional details..." 
                  value={formState.notes}
                  onChange={(e) => setFormState({...formState, notes: e.target.value})}
                  className="rounded-2xl min-h-[100px]"
                />
              </div>
            </div>

            <DialogFooter className="bg-gray-50 p-6 border-t gap-2">
              <Button variant="ghost" onClick={resetForm} className="rounded-xl px-6">Cancel</Button>
              <Button 
                style={{ backgroundColor: '#FFD100', color: '#2F3E46' }} 
                onClick={handleSave}
                disabled={isSaving}
                className="rounded-xl px-8 font-bold"
              >
                {isSaving ? 'Saving...' : editingId ? 'Update Activity' : 'Save Activity'}
              </Button>
            </DialogFooter>
          </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="relative w-full md:w-96 mb-6">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
        <Input 
          className="pl-10 bg-white border-gray-200 text-black" 
          placeholder="Search activities or location..." 
          value={searchTerm} 
          onChange={(e) => setSearchTerm(e.target.value)} 
        />
      </div>

      {/* Activities List */}
      <div className="grid gap-4">
        {filteredActivities.map((item: Activity) => (
          <Card key={item.id} style={{ backgroundColor: '#2F3E46' }} className="border-none shadow-lg overflow-hidden hover:scale-[1.005] transition-all duration-200 rounded-2xl text-white">
            <CardContent className="p-0 flex flex-col md:flex-row">
              <div style={{ backgroundColor: '#FFD100' }} className="w-1.5"></div>
              <div className="p-6 flex-1 flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <h3 className="text-xl font-bold tracking-tight">{item.title}</h3>
                    <Badge className="bg-white/10 text-[#FFD100] border-none text-[10px] uppercase font-bold">
                      {item.category}
                    </Badge>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-2 text-sm opacity-90">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Calendar size={14} className="text-[#FFD100]"/>
                        <span>{formatShortDate(item.date)} • {(() => {
                          const t = item.time || '';
                          if (!t || t.includes('AM') || t.includes('PM')) return t;
                          const [h, m] = t.split(':').map(Number);
                          const ampm = h >= 12 ? 'PM' : 'AM';
                          const h12 = h % 12 || 12;
                          return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
                        })()}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <MapPin size={14} className="text-[#FFD100]"/>
                        <span>{item.location}</span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <User size={14} className="text-[#FFD100]"/>
                        <span className="truncate max-w-[200px]">{(item.facilitators || []).join(', ') || '—'}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Users size={14} className="text-[#FFD100]"/>
                        <span>{(item.participants?.length || item.selectedResidentIds?.length || 0)} Participants</span>
                      </div>
                      {/* Recommended children indicator */}
                      {(item.recommendedResidentIds?.length ?? 0) > 0 && (
                        <div className="flex items-center gap-2 mt-1">
                          <ThumbsUp size={14} className="text-green-400"/>
                          <span className="text-green-300 text-xs font-semibold">
                            {item.recommendedResidentIds!.length} Recommended
                          </span>
                        </div>
                      )}
                      {/* Not-recommended indicator */}
                      {(item.notRecommendedResidentIds?.length ?? 0) > 0 && (
                        <div className="flex items-center gap-2">
                          <ThumbsDown size={14} className="text-red-400"/>
                          <span className="text-red-300 text-xs font-semibold">
                            {item.notRecommendedResidentIds!.length} Restricted
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center gap-2 pt-4 md:pt-0 border-t md:border-t-0 md:border-l md:pl-6 border-white/10">
                  {isPsychologist && (item.recommendedResidentIds?.length ?? 0) > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-orange-300 hover:bg-white/10 gap-2"
                      onClick={() => { setRestrictDialogActivity(item); setIsRestrictDialogOpen(true); }}
                    >
                      <ShieldAlert size={14}/> Override
                    </Button>
                  )}
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-white hover:bg-white/10 gap-2" 
                    onClick={() => navigate(`/activities/${item.id}`)}
                  >
                    <Eye size={16} className="text-[#FFD100]" /> View
                  </Button>
                  
                  {can('Activities', 'edit') && !isHouseparent && (
                    <>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-white hover:bg-white/10 gap-2" 
                    onClick={() => handleEditClick(item)}
                  >
                    <Edit size={16} className="text-[#FFD100]" /> Edit
                  </Button>
                  
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-2" 
                    onClick={() => { setActivityToDelete(item); setIsDeleteDialogOpen(true); }}
                  >
                    <Trash2 size={16} /> Delete
                  </Button>

                    </>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Delete Confirmation */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent className="bg-white rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[#2F3E46] font-bold">Confirm Delete</AlertDialogTitle>
            <AlertDialogDescription>
              Delete activity <strong>{activityToDelete?.title}</strong>? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-gray-100">Cancel</AlertDialogCancel>
            <AlertDialogAction 
              className="bg-red-600 text-white hover:bg-red-700" 
              onClick={() => { 
                if (activityToDelete) {
                  deleteActivity(activityToDelete.id); 
                }
                setIsDeleteDialogOpen(false); 
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Psychological Staff Override Dialog */}
      <Dialog open={isRestrictDialogOpen} onOpenChange={setIsRestrictDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#2F3E46]">
              <ShieldAlert className="w-5 h-5 text-orange-500" />
              Psychological Staff Activity Override
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="text-gray-600">
              Select a child to mark as <strong>Not Recommended</strong> for <strong>{restrictDialogActivity?.title}</strong>. They will be removed from the enrolled list.
            </p>
            <div className="space-y-2">
              <Label className="font-bold">Child</Label>
              <select className="w-full border rounded-lg p-2 text-sm" value={restrictChildId} onChange={e => setRestrictChildId(e.target.value)}>
                <option value="">— Select child —</option>
                {[...(restrictDialogActivity?.recommendedResidentIds || []), ...(restrictDialogActivity?.selectedResidentIds || [])].filter((v, i, a) => a.indexOf(v) === i).map(cid => {
                  const child = liveResidents.find(c => c.id === cid);
                  return child ? <option key={cid} value={cid}>{child.name}</option> : null;
                })}
              </select>
            </div>
            <div className="space-y-2">
              <Label className="font-bold">Reason for Restriction</Label>
              <textarea className="w-full border rounded-lg p-2 text-sm min-h-[80px]" placeholder="e.g. Child shows aggression in group settings. Individual counseling recommended instead." value={restrictReason} onChange={e => setRestrictReason(e.target.value)} />
            </div>
            {restrictChildId && (
              <div className="p-3 bg-orange-50 border border-orange-200 rounded text-orange-800 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                This child will be marked as Not Recommended and removed from this activity.
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsRestrictDialogOpen(false)}>Cancel</Button>
            <Button className="bg-orange-500 text-white hover:bg-orange-600" onClick={handleRestrictChild} disabled={!restrictChildId}>Apply Restriction</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}