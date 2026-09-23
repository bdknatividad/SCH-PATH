import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Badge } from '@/app/components/ui/badge';
import { Button } from '@/app/components/ui/button';
import { Users, ChevronRight, ArrowLeft, User, Calendar, AlertCircle, Eye, Search } from 'lucide-react';
import { request } from '@/services/api';
import { useData } from '@/app/state/DataContext';
import { useAuth } from '@/app/state/AuthContext';
import { formatPHDate } from '@/utils/dateFormatter';
import { ChildDetail } from './ChildDetail';

interface CaseloadEntry {
  userId: string;
  username: string;
  displayName: string | null;
  label: string;
  assignedCount: number;
  maxCaseload: number;
  availableSlots: number;
  residents: { id: string; name: string }[];
}

export function CaseLoad() {
  const { children } = useData();
  const { user } = useAuth();
  const [viewingChildId, setViewingChildId] = useState<string | null>(null);
  const [data, setData] = useState<CaseloadEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedHP, setSelectedHP] = useState<CaseloadEntry | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [assignedResidentRecords, setAssignedResidentRecords] = useState<any[]>([]);

  const load = () => {
    setLoading(true);
    setError(null);
    request<{ success: boolean; data: CaseloadEntry[] }>('/resident-assignments/caseload', { method: 'GET' })
      .then((res) => {
        if (res?.success) setData(res.data || []);
        else setError('Unable to load case load data.');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Unable to load case load data.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    // Keep the Case Load in sync with Center Head assignments while the module
    // is open. This is intentionally scoped to this module only; it does not
    // alter the existing Center Head UI or any other module's refresh logic.
    load();
    const interval = window.setInterval(load, 5000);
    const handleFocus = () => load();
    window.addEventListener('focus', handleFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  const normalizedRole = String(user?.role || '').toLowerCase().replace(/[-_\s]+/g, '');
  const isHouseparent = normalizedRole === 'houseparent';

  const filteredData = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const currentUserId = String((user as any)?.id || '').trim();
    const currentUsername = String((user as any)?.username || '').trim().toLowerCase();

    // Houseparents are strictly self-scoped. The backend is the authoritative
    // boundary; this client-side filter is a second guard against stale data.
    // Managers retain the existing facility-wide Case Load behavior.
    const scoped = isHouseparent
      ? data.map(hp => {
          const own = (currentUserId && String(hp.userId) === currentUserId)
            || (currentUsername && currentUsername === String(hp.username || '').trim().toLowerCase());
          return own ? hp : { ...hp, residents: [], assignedCount: 0, availableSlots: hp.maxCaseload };
        })
      : data;

    if (!q || isHouseparent) return scoped;
    return scoped.filter(hp => [hp.label, hp.username, hp.displayName || ''].some(v => String(v).toLowerCase().includes(q)));
  }, [data, searchTerm, isHouseparent, user]);

  // When an HP opens their own case load, fetch the same complete resident
  // records used by Child Records. The caseload summary intentionally returns
  // only id/name, so relying on it alone made the HP card lose age, gender,
  // admission date, category, offense and phase. The endpoint is already
  // assignment-scoped for Houseparents.
  useEffect(() => {
    let cancelled = false;
    const loadAssignedResidentRecords = async () => {
      if (!selectedHP) {
        setAssignedResidentRecords([]);
        return;
      }

      const currentUserId = String((user as any)?.id || '').trim();
      const currentUsername = String((user as any)?.username || '').trim().toLowerCase();
      const isOwn = isHouseparent && (
        (currentUserId && String(selectedHP.userId) === currentUserId) ||
        (currentUsername && currentUsername === String(selectedHP.username || '').trim().toLowerCase())
      );

      if (!isHouseparent || !isOwn) {
        setAssignedResidentRecords([]);
        return;
      }

      try {
        const results = await Promise.all(
          (selectedHP.residents || []).map(async (resident) => {
            try {
              const response = await request<{ success: boolean; data?: any }>(`/children/${encodeURIComponent(resident.id)}`);
              return response?.success ? response.data : null;
            } catch {
              return null;
            }
          })
        );
        if (!cancelled) setAssignedResidentRecords(results.filter(Boolean));
      } catch {
        if (!cancelled) setAssignedResidentRecords([]);
      }
    };

    loadAssignedResidentRecords();
    return () => { cancelled = true; };
  }, [selectedHP, isHouseparent, user]);

  // Keep the drill-down in sync if the underlying data refreshes while it's open.
  const liveSelectedHP = selectedHP ? data.find(hp => hp.userId === selectedHP.userId) || selectedHP : null;

  // Viewing a specific child's full profile — rendered inline, right here in
  // Case Load. No navigation away from this module at any point.
  if (viewingChildId) {
    return (
      <div className="space-y-4">
        <ChildDetail id={viewingChildId} onBack={() => setViewingChildId(null)} />
      </div>
    );
  }

  if (liveSelectedHP) {
    // Prefer the full child record when DataContext has it, but never drop a
    // resident just because that separate fetch hasn't (yet, or for some
    // other reason) produced a matching record — the assignment itself is
    // already confirmed via this same liveSelectedHP data, so a resident the
    // caseload endpoint says is assigned must always show up here, even with
    // only the name it already gave us.
    const assignedChildren = liveSelectedHP.residents.map(r => {
      const remote = assignedResidentRecords.find(c => String(c.id) === String(r.id));
      const full = remote || children.find(c => c.id === r.id);
      return full || { id: r.id, name: r.name, fallback: true as const };
    });

    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" className="gap-2 -ml-2 text-gray-500" onClick={() => setSelectedHP(null)}>
          <ArrowLeft className="w-4 h-4" /> Back to Case Load
        </Button>

        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-[#2F3E46]">{liveSelectedHP.label}'s Residents</h3>
            <p className="text-sm text-gray-500">{liveSelectedHP.assignedCount}/{liveSelectedHP.maxCaseload} assigned — view only</p>
          </div>
        </div>

        <div className="grid gap-4">
          {assignedChildren.length > 0 ? (
            assignedChildren.map((child: any) => (
              <Card
                key={child.id}
                style={{ backgroundColor: '#2F3E46' }}
                className="border-none shadow-lg overflow-hidden hover:scale-[1.005] transition-all duration-200 rounded-2xl text-white"
              >
                <CardContent className="p-0 flex flex-col md:flex-row">
                  <div style={{ backgroundColor: '#FFD100' }} className="w-1.5" />
                  <div className="p-6 flex-1 flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div className="space-y-3">
                      <div className="flex items-center gap-3 flex-wrap">
                        <h3 className="text-xl font-bold tracking-tight">{child.name}</h3>
                        <Badge className="bg-white/10 text-[#FFD100] border-none text-[10px] uppercase font-bold">
                          {child.legalCategory || child.caseType || 'No category'}
                        </Badge>
                        {child.status === 'Discharged' && (
                          <Badge className="bg-emerald-500/20 text-emerald-300 border-none text-[10px] uppercase font-bold">
                            Case Closed
                          </Badge>
                        )}
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-2 text-sm opacity-90">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <User size={14} className="text-[#FFD100]" />
                            <span>{child.age ?? '—'} yrs old • {child.gender || '—'}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Calendar size={14} className="text-[#FFD100]" />
                            <span>Admitted: {child.admissionDate ? formatPHDate(child.admissionDate) : '—'}</span>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="border-gray-500 text-gray-400 font-normal text-xs">{child.id}</Badge>
                            <span className="font-medium text-[#FFD100]">{child.caseType || 'No offense'}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs opacity-70">{child.casePhase || '—'}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* HP action: exactly the Child Records View action, with all edit/delete actions removed. */}
                    <div className="flex items-center gap-2 pt-4 md:pt-0 border-t md:border-t-0 md:border-l md:pl-6 border-white/10">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-white hover:bg-white/10 gap-2"
                        onClick={() => setViewingChildId(child.id)}
                      >
                        <Eye size={16} className="text-[#FFD100]" />
                        View
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <div className="text-center py-16 text-gray-400">
              <AlertCircle className="w-10 h-10 mx-auto mb-2 opacity-20" />
              <p>No residents assigned to {liveSelectedHP.label} yet.</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (isHouseparent) {
    // Keep the HP Case Load overview visually identical to the reference:
    // always show the complete roster of active Houseparents.  Only the signed-in
    // Houseparent's card contains resident names and has an active View
    // residents action; other HP cards remain visible but their residents
    // cannot be opened.
    const sortedHPs = [...filteredData].sort((a, b) =>
      String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' })
    );
    const currentUserId = String((user as any)?.id || '').trim();
    const currentUsername = String((user as any)?.username || '').trim().toLowerCase();

    return (
      <div className="space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg">{error}</div>
        )}

        {loading ? (
          <p className="text-sm text-gray-500">Loading case loads...</p>
        ) : sortedHPs.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedHPs.map((hp) => {
              const isOwn =
                (currentUserId && String(hp.userId) === currentUserId) ||
                (currentUsername && currentUsername === String(hp.username || '').trim().toLowerCase());

              return (
                <Card key={hp.userId} className="border-gray-200 shadow-sm bg-white">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base font-medium text-[#2F3E46]">
                      <Users className="w-4 h-4 text-gray-400" />
                      <span>{hp.label}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-end justify-between gap-4 min-h-[58px]">
                      <div className="min-w-0 flex-1">
                        {hp.residents?.length > 0 && (
                          <p className="max-w-full whitespace-normal break-words text-[11px] leading-4 text-gray-500">
                            {hp.residents.map(r => (
                              <span key={r.id} className="block">{r.name}</span>
                            ))}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!isOwn}
                        className={`shrink-0 gap-1 font-normal ${isOwn ? 'text-[#2F3E46] hover:bg-gray-50' : 'text-[#2F3E46] opacity-100'}`}
                        onClick={() => { if (isOwn) setSelectedHP(hp); }}
                      >
                        View residents
                        <ChevronRight className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-16 text-gray-400">
            <AlertCircle className="w-10 h-10 mx-auto mb-2 opacity-20" />
            <p>No Houseparent accounts found.</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!isHouseparent && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Search houseparent…" className="h-10 w-full rounded-lg border border-gray-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-[#FFD100]" />
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading case loads...</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...filteredData].sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' })).map((hp) => {
            const normalizedCurrentUsername = String(user?.username || '').trim().toLowerCase();
            const currentUserId = String((user as any)?.id || '').trim();
            const isOwnHouseparent = isHouseparent && (
              (currentUserId && String(hp.userId) === currentUserId) ||
              (normalizedCurrentUsername && normalizedCurrentUsername === String(hp.username || '').trim().toLowerCase())
            );
            const isClickable = !isHouseparent || isOwnHouseparent;

            return (
            <Card
              key={hp.userId}
              onClick={() => { if (isClickable) setSelectedHP(hp); }}
              role={isClickable ? 'button' : undefined}
              tabIndex={isClickable ? 0 : -1}
              onKeyDown={(e) => { if (isClickable && e.key === 'Enter') setSelectedHP(hp); }}
              className={`transition-all border-gray-200 ${
                isOwnHouseparent
                  ? 'ring-2 ring-[#FFD100] bg-[#FFFDF0] shadow-md'
                  : isHouseparent
                    ? 'cursor-default opacity-90'
                    : 'cursor-pointer hover:shadow-md hover:-translate-y-0.5'
              }`}
            >
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  <span className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-gray-400" />
                    <span>
                      {hp.label}
                      {hp.displayName && <span className="block text-[10px] font-normal text-gray-400">{hp.username}</span>}
                    </span>
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    
                    {hp.residents?.length > 0 && (
                      <p className="mt-2 max-w-full whitespace-normal break-words text-[11px] leading-4 text-gray-500" title={hp.residents.map(r => r.name).join(', ')}>
                        {hp.residents.map(r => <span key={r.id} className="block">{r.name}</span>)}
                      </p>
                    )}
                  </div>
                  <span className={`shrink-0 flex items-center gap-0.5 text-[11px] font-semibold ${isClickable ? 'text-[#2F3E46]' : 'text-gray-400'}`}>
                    {isOwnHouseparent ? 'View my residents' : 'View residents'}
                    {isClickable && <ChevronRight className="w-3.5 h-3.5" />}
                  </span>
                </div>
              </CardContent>
            </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
