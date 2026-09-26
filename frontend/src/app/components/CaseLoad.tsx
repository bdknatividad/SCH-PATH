import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Badge } from '@/app/components/ui/badge';
import { Button } from '@/app/components/ui/button';
import { Users, ChevronRight, ArrowLeft, User, Calendar, AlertCircle, Eye, Search, UserPlus, Repeat } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/app/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
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
  /** Set by the server: this card is the signed-in Houseparent's own (by account id). */
  isSelf?: boolean;
}

/**
 * Is this card the signed-in Houseparent's own? The server decides it by
 * account id (`isSelf`). The username match is only a fallback for an older
 * backend that does not send the flag; the display name is never used.
 */
function isOwnCard(hp: CaseloadEntry, username: string | undefined): boolean {
  if (typeof hp.isSelf === 'boolean') return hp.isSelf;
  const current = String(username || '').trim().toLowerCase();
  return Boolean(current) && current === String(hp.username || '').trim().toLowerCase();
}

/** `YYYY-MM-DD` of a date-ish value, or '' when it has none. */
function dayOf(value: unknown): string {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** Today in the facility's timezone (Asia/Manila), as `YYYY-MM-DD`. */
function manilaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/**
 * The date a resident must have a Case Load Manager by: one calendar month
 * after admission. A day that does not exist in the next month (31 Jan) is
 * clamped to that month's last day (28/29 Feb).
 */
function caseLoadDueDate(admissionDay: string): string {
  const [y, m, d] = admissionDay.split('-').map(Number);
  if (!y || !m || !d) return '';
  const targetMonth = m === 12 ? 1 : m + 1;
  const targetYear = m === 12 ? y + 1 : y;
  const lastDay = new Date(targetYear, targetMonth, 0).getDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`). */
function daysBetween(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86400000);
}

type AssignTarget =
  | { mode: 'resident'; hpUserId: string }
  | { mode: 'houseparent'; residentId: string };

export function CaseLoad() {
  const { children } = useData();
  const { user } = useAuth();
  const [viewingChildId, setViewingChildId] = useState<string | null>(null);
  // The ChildDetail tab to open on (e.g. 'medical' from a Medical Notes alert).
  const [viewingChildTab, setViewingChildTab] = useState<string | undefined>(undefined);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  // Deep link from a notification: /tri?tab=caseload&caseloadResidentId=…&childTab=…
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkResidentId = searchParams.get('caseloadResidentId');
  const deepLinkChildTab = searchParams.get('childTab') || undefined;
  const [data, setData] = useState<CaseloadEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedHP, setSelectedHP] = useState<CaseloadEntry | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [assignedResidentRecords, setAssignedResidentRecords] = useState<any[]>([]);

  /**
   * Load the roster.
   *
   * `background` is the whole difference between opening the module and keeping
   * it in sync. A background refresh must not raise the loading flag — that
   * blanked the cards every few seconds, so the page looked like it kept
   * reloading itself — and it must not replace a good list with an error, since
   * one failed poll is not a reason to empty the screen.
   */
  const load = (background = false) => {
    if (!background) {
      setLoading(true);
      setError(null);
    }
    request<{ success: boolean; data: CaseloadEntry[] }>('/resident-assignments/caseload', { method: 'GET' })
      .then((res) => {
        if (res?.success) {
          setData(res.data || []);
          if (background) setError(null);
        } else if (!background) {
          setError('Unable to load case load data.');
        }
      })
      .catch((err) => {
        if (!background) setError(err instanceof Error ? err.message : 'Unable to load case load data.');
      })
      .finally(() => { if (!background) setLoading(false); });
  };

  useEffect(() => {
    // Keep the Case Load in sync with Center Head assignments while the module is
    // open. This is intentionally scoped to this module only; it does not alter
    // the existing Center Head UI or any other module's refresh logic.
    //
    // Silently, and once a minute rather than every five seconds: an assignment
    // made elsewhere is not urgent to the second, and returning to the tab
    // refreshes immediately anyway.
    load();
    const interval = window.setInterval(() => load(true), 60_000);
    const handleFocus = () => load(true);
    window.addEventListener('focus', handleFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  const normalizedRole = String(user?.role || '').toLowerCase().replace(/[-_\s]+/g, '');
  const isHouseparent = normalizedRole === 'houseparent';
  // Only the Center Head and the Social Worker assign or transfer a resident's
  // Houseparent Case Load Manager (`admin` is the Center Head's system account).
  // The backend enforces the same rule; this only decides whether the buttons
  // are offered.
  const canAssignCaseLoad = normalizedRole === 'centerhead' || normalizedRole === 'admin' || normalizedRole === 'socialworker';

  // ── Assign Resident / Assign HP dialog ──────────────────────────────────
  const [assignTarget, setAssignTarget] = useState<AssignTarget | null>(null);
  const [assignChoice, setAssignChoice] = useState('');
  const [assignSaving, setAssignSaving] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  const openAssign = (target: AssignTarget) => {
    setAssignTarget(target);
    setAssignError(null);
    // Pre-select the current Case Load Manager when changing a resident's HP.
    setAssignChoice(target.mode === 'houseparent' ? (managerByResident.get(String(target.residentId))?.userId || '') : '');
  };

  const closeAssign = () => {
    if (assignSaving) return;
    setAssignTarget(null);
    setAssignChoice('');
    setAssignError(null);
  };

  const saveAssign = async () => {
    if (!assignTarget || !assignChoice) return;
    // Always the Houseparent's account id (users.id), never a display name, so
    // renaming a Houseparent cannot break or move the assignment.
    const residentId = assignTarget.mode === 'resident' ? assignChoice : assignTarget.residentId;
    const hpUserId = assignTarget.mode === 'resident' ? assignTarget.hpUserId : assignChoice;
    if (managerByResident.get(String(residentId))?.userId === hpUserId) {
      setAssignError('This Houseparent is already the resident\'s Case Load Manager.');
      return;
    }
    setAssignSaving(true);
    setAssignError(null);
    try {
      // The server ends the resident's previous Case Load assignment (if any)
      // before creating this one, so a change is a single request.
      await request(`/resident-assignments/resident/${encodeURIComponent(residentId)}`, {
        method: 'POST',
        body: JSON.stringify({
          userId: hpUserId,
          assignmentType: 'houseparent',
          startAt: new Date().toISOString(),
          source: 'caseload',
        }),
      });
      setAssignTarget(null);
      setAssignChoice('');
      load();
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : 'Unable to save the assignment.');
    } finally {
      setAssignSaving(false);
    }
  };

  const filteredData = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const currentUserId = String((user as any)?.id || '').trim();
    const currentUsername = String((user as any)?.username || '').trim().toLowerCase();

    // Every Houseparent sees the full assignment roster (names and counts for
    // each HP). Only their own residents can be opened — see the HP view below
    // and the server's canAccessResident check.
    void currentUserId; void currentUsername;
    const scoped = data;

    if (!q || isHouseparent) return scoped;
    return scoped.filter(hp => [hp.label, hp.username, hp.displayName || ''].some(v => String(v).toLowerCase().includes(q)));
  }, [data, searchTerm, isHouseparent, user]);

  // Every resident that currently has a Case Load Manager, taken from the
  // caseload endpoint itself so this agrees with what the cards show.
  const assignedResidentIds = useMemo(() => {
    const ids = new Set<string>();
    data.forEach((hp) => (hp.residents || []).forEach((r) => ids.add(String(r.id))));
    return ids;
  }, [data]);

  // Each resident's current Case Load Manager, keyed by resident id.
  const managerByResident = useMemo(() => {
    const map = new Map<string, { userId: string; label: string }>();
    data.forEach((hp) => (hp.residents || []).forEach((r) => map.set(String(r.id), { userId: String(hp.userId), label: hp.label })));
    return map;
  }, [data]);

  // Residents still waiting for a Case Load Manager. The facility's rule is
  // that every resident has an assigned Houseparent before one month after
  // admission, so each one carries its due date and whether it has passed.
  // A resident with no usable admission date is still listed (they still need
  // an HP) but without a due date rather than a guessed one.
  const unassignedResidents = useMemo(() => {
    const today = manilaToday();
    return (children || [])
      .filter((c: any) => c && String(c.status || '') !== 'Discharged' && !assignedResidentIds.has(String(c.id)))
      .map((c: any) => {
        const admitted = dayOf(c.admissionDate || c.createdAt);
        const due = admitted ? caseLoadDueDate(admitted) : '';
        const daysLeft = due ? daysBetween(today, due) : null;
        return { child: c, admitted, due, daysLeft, overdue: daysLeft !== null && daysLeft < 0 };
      })
      .sort((a, b) => (a.due || '9999-12-31').localeCompare(b.due || '9999-12-31'));
  }, [children, assignedResidentIds]);
  const overdueCount = unassignedResidents.filter((r) => r.overdue).length;

  // The Assign Resident dropdown lists only residents who have no Houseparent
  // yet. A resident who already has one is moved with "Transfer" on their card
  // instead, so an HP card's Assign button can never silently take a resident
  // from another Houseparent.
  const assignableResidents = useMemo(
    () => (children || [])
      .filter((c: any) => c && String(c.status || '') !== 'Discharged' && !assignedResidentIds.has(String(c.id)))
      .sort((a: any, b: any) => String(a.name || '').localeCompare(String(b.name || ''))),
    [children, assignedResidentIds]
  );

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

      const isOwn = isHouseparent && isOwnCard(selectedHP, user?.username);

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

  /**
   * Open the resident named by a notification's deep link, once the case load
   * has loaded. A Houseparent may open only a resident on their own Case Load
   * (the server refuses anything else too); anyone else gets a clear message
   * instead of a blank page.
   */
  useEffect(() => {
    if (!deepLinkResidentId || loading) return;
    const ownsResident = !isHouseparent || data.some((hp) =>
      isOwnCard(hp, user?.username) && (hp.residents || []).some((r) => String(r.id) === String(deepLinkResidentId)));
    if (ownsResident) {
      setViewingChildTab(deepLinkChildTab);
      setViewingChildId(deepLinkResidentId);
      setDeepLinkError(null);
    } else {
      setDeepLinkError('That resident is not on your Case Load, so their record cannot be opened here.');
    }
    // Consume the link so going Back does not reopen the resident.
    const next = new URLSearchParams(searchParams);
    next.delete('caseloadResidentId');
    next.delete('childTab');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkResidentId, loading, data]);

  const assignHP = assignTarget?.mode === 'resident' ? data.find((hp) => String(hp.userId) === String(assignTarget.hpUserId)) : null;
  const assignResident = assignTarget?.mode === 'houseparent'
    ? (children || []).find((c: any) => String(c.id) === String(assignTarget.residentId))
    : null;
  const assignResidentManager = assignTarget?.mode === 'houseparent' ? managerByResident.get(String(assignTarget.residentId)) : undefined;

  const assignDialog = canAssignCaseLoad && (
    <Dialog open={!!assignTarget} onOpenChange={(open) => { if (!open) closeAssign(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[#2F3E46]">
            {assignTarget?.mode === 'resident' ? `Assign Resident to ${assignHP?.label || 'Houseparent'}` : assignResidentManager ? 'Transfer Resident to Another Houseparent' : 'Assign Houseparent'}
          </DialogTitle>
          <DialogDescription>
            {assignTarget?.mode === 'resident'
              ? 'Choose a resident who has no Houseparent yet. To move a resident who already has one, open their current Houseparent and use Transfer.'
              : `${assignResident?.name || 'This resident'}${assignResidentManager ? ` — currently managed by ${assignResidentManager.label}` : ' has no Case Load Manager yet'}. This is separate from the Houseparent on Duty on the Admission Slip.`}
          </DialogDescription>
        </DialogHeader>

        <Select value={assignChoice || undefined} onValueChange={setAssignChoice}>
          <SelectTrigger aria-label={assignTarget?.mode === 'resident' ? 'Resident' : 'Houseparent'}>
            <SelectValue placeholder={assignTarget?.mode === 'resident' ? 'Select resident' : 'Select Houseparent'} />
          </SelectTrigger>
          <SelectContent>
            {assignTarget?.mode === 'resident'
              ? (assignableResidents.length === 0
                ? <div className="px-3 py-2 text-xs text-gray-400">Every resident already has a Houseparent.</div>
                : assignableResidents.map((c: any) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  )))
              : data.map((hp) => {
                  const isCurrent = assignResidentManager?.userId === String(hp.userId);
                  const isFull = hp.assignedCount >= hp.maxCaseload && !isCurrent;
                  return (
                    <SelectItem key={hp.userId} value={String(hp.userId)} disabled={isFull || isCurrent}>
                      {hp.label} — {hp.assignedCount}/{hp.maxCaseload}{isCurrent ? ' (current)' : isFull ? ' (Full)' : ''}
                    </SelectItem>
                  );
                })}
          </SelectContent>
        </Select>

        {assignTarget?.mode === 'resident' && assignHP && assignHP.assignedCount >= assignHP.maxCaseload && (
          <p className="text-xs text-amber-700">{assignHP.label} already has {assignHP.maxCaseload} residents — the maximum.</p>
        )}
        {assignError && <p className="text-xs text-red-600">{assignError}</p>}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeAssign} disabled={assignSaving}>Cancel</Button>
          <Button
            size="sm"
            className="bg-[#2F3E46] text-white"
            disabled={assignSaving || !assignChoice || (assignTarget?.mode === 'resident' && !!assignHP && assignHP.assignedCount >= assignHP.maxCaseload)}
            onClick={saveAssign}
          >
            {assignSaving ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Viewing a specific child's full profile — rendered inline, right here in
  // Case Load. No navigation away from this module at any point.
  if (viewingChildId) {
    return (
      <div className="space-y-4">
        <ChildDetail id={viewingChildId} initialTab={viewingChildTab} onBack={() => { setViewingChildId(null); setViewingChildTab(undefined); }} />
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
            <p className="text-sm text-gray-500">{liveSelectedHP.assignedCount}/{liveSelectedHP.maxCaseload} assigned{canAssignCaseLoad ? '' : ' — view only'}</p>
          </div>
          {canAssignCaseLoad && (
            <Button
              size="sm"
              className="gap-2 bg-[#2F3E46] text-white"
              disabled={liveSelectedHP.assignedCount >= liveSelectedHP.maxCaseload}
              onClick={() => openAssign({ mode: 'resident', hpUserId: String(liveSelectedHP.userId) })}
            >
              <UserPlus className="w-4 h-4" /> Assign Resident
            </Button>
          )}
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
                      {canAssignCaseLoad && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-white hover:bg-white/10 gap-2"
                          onClick={() => openAssign({ mode: 'houseparent', residentId: String(child.id) })}
                        >
                          <Repeat size={16} className="text-[#FFD100]" />
                          Transfer
                        </Button>
                      )}
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
        {assignDialog}
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
        {deepLinkError && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-2 rounded-lg">{deepLinkError}</div>
        )}

        {loading && data.length === 0 ? (
          <p className="text-sm text-gray-500">Loading case loads...</p>
        ) : sortedHPs.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedHPs.map((hp) => {
              const isOwn = isOwnCard(hp, user?.username);

              return (
                <Card key={hp.userId} className="border-gray-200 shadow-sm bg-white">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base font-medium text-[#2F3E46]">
                      <Users className="w-4 h-4 text-gray-400" />
                      <span>{hp.label}</span>
                      {isOwn && <Badge className="bg-[#FFD100]/30 text-[#2F3E46] border-none text-[10px]">You</Badge>}
                      <span className="ml-auto text-xs font-semibold text-gray-500" data-hp-assigned-count>
                        {hp.assignedCount} resident{hp.assignedCount === 1 ? '' : 's'}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-end justify-between gap-4 min-h-[58px]">
                      <div className="min-w-0 flex-1">
                        {/* The assignment list is visible for every HP; only
                            the signed-in HP's own residents can be opened. */}
                        {hp.residents?.length > 0 ? (
                          <p className="max-w-full whitespace-normal break-words text-[11px] leading-4 text-gray-500">
                            {hp.residents.map(r => (
                              <span key={r.id} className="block">{r.name}</span>
                            ))}
                          </p>
                        ) : (
                          <p className="text-[11px] italic text-gray-400">No residents assigned</p>
                        )}
                        {!isOwn && hp.residents?.length > 0 && (
                          <p className="mt-1 text-[10px] text-gray-400">Records open only to their assigned Houseparent.</p>
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

      {!isHouseparent && unassignedResidents.length > 0 && (
        <div className={`rounded-xl border p-4 ${overdueCount > 0 ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
          <div className="flex items-start gap-3">
            <AlertCircle className={`w-5 h-5 shrink-0 mt-0.5 ${overdueCount > 0 ? 'text-red-600' : 'text-amber-600'}`} />
            <div className="min-w-0 flex-1">
              <p className={`font-bold text-sm ${overdueCount > 0 ? 'text-red-800' : 'text-amber-800'}`}>
                {unassignedResidents.length} resident{unassignedResidents.length === 1 ? '' : 's'} without a Case Load Manager
                {overdueCount > 0 ? ` — ${overdueCount} past the one-month deadline` : ''}
              </p>
              <p className="text-xs text-gray-600 mt-1">
                Every resident must have an assigned Houseparent (Case Load Manager) before one month after admission.
                {canAssignCaseLoad ? '' : ' Only the Center Head or a Social Worker can assign one.'}
              </p>
              <div className="mt-3 space-y-1.5">
                {unassignedResidents.map(({ child, admitted, due, daysLeft, overdue }) => (
                  <div key={child.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white border border-gray-200 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[#2F3E46] truncate">{child.name}</p>
                      <p className="text-[11px] text-gray-500">
                        Admitted {admitted ? formatPHDate(admitted) : '—'}
                        {due ? ` · Assign by ${formatPHDate(due)}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {daysLeft !== null && (
                        <Badge className={`border-none text-[10px] font-bold ${overdue ? 'bg-red-100 text-red-700' : daysLeft <= 7 ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'}`}>
                          {overdue ? `Overdue by ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'}` : daysLeft === 0 ? 'Due today' : `Due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}
                        </Badge>
                      )}
                      {canAssignCaseLoad && (
                        <Button size="sm" className="h-7 gap-1 text-xs bg-[#2F3E46] text-white" onClick={() => openAssign({ mode: 'houseparent', residentId: String(child.id) })}>
                          <UserPlus className="w-3.5 h-3.5" /> Assign HP
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg">{error}</div>
      )}

      {loading && data.length === 0 ? (
        <p className="text-sm text-gray-500">Loading case loads...</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...filteredData].sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' })).map((hp) => {
            const isOwnHouseparent = isHouseparent && isOwnCard(hp, user?.username);
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
                {canAssignCaseLoad && (
                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-gray-100 pt-2">
                    <span className="text-[11px] text-gray-500">{hp.assignedCount}/{hp.maxCaseload} residents</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 text-xs"
                      disabled={hp.assignedCount >= hp.maxCaseload}
                      onClick={(e) => { e.stopPropagation(); openAssign({ mode: 'resident', hpUserId: String(hp.userId) }); }}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <UserPlus className="w-3.5 h-3.5" /> Assign Resident
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
            );
          })}
        </div>
      )}
      {assignDialog}
    </div>
  );
}
