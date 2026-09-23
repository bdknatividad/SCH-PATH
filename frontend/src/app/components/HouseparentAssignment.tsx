import { useEffect, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { request } from '@/services/api';
import { useAuth } from '@/app/state/AuthContext';

interface Props {
  residentId: string;
}

export default function HouseparentAssignment({ residentId }: Props) {
  const { user } = useAuth();
  /*
   * Must stay in step with the backend: assignmentController.create/update/end
   * and GET /resident-assignments/caseload all use authorization.isManager,
   * which accepts centerhead, admin and socialworker. Gating on Center Head
   * alone left a Social Worker with an empty Houseparent list.
   */
  const canAssignHouseparent = ['centerhead', 'admin', 'socialworker'].includes((user?.role || '').toLowerCase());

  const [current, setCurrent] = useState<any>(null);
  const [houseparents, setHouseparents] = useState<{ id: string; username: string; label: string; assignedCount: number; maxCaseload: number }[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      request<{ success: boolean; data: any[] }>(`/resident-assignments/resident/${residentId}`, { method: 'GET' }),
      canAssignHouseparent ? request<{ success: boolean; data: any[] }>('/resident-assignments/caseload', { method: 'GET' }) : Promise.resolve(null),
    ])
      .then(([assignmentsRes, caseloadRes]) => {
        const active = (assignmentsRes?.data || []).find((a: any) => a.assignmentType === 'houseparent' && a.status === 'Active');
        setCurrent(active || null);
        setSelected(active?.userId || '');
        if (caseloadRes?.success) {
          setHouseparents((caseloadRes.data || []).map((hp: any) => ({ ...hp, id: hp.userId })));
        }
      })
      .catch(() => { /* non-fatal */ })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [residentId]);

  const handleSave = async () => {
    if (!selected || selected === current?.userId) return;
    setSaving(true);
    setError(null);
    try {
      // End the previous active assignment (if any) before starting the new one,
      // so a resident never appears assigned to two Houseparents at once.
      if (current?.id) {
        await request(`/resident-assignments/${current.id}/end`, { method: 'POST' });
      }
      await request(`/resident-assignments/resident/${residentId}`, {
        method: 'POST',
        body: JSON.stringify({
          userId: selected,
          assignmentType: 'houseparent',
          startAt: new Date().toISOString(),
          source: 'manual',
        }),
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update the assignment.');
    } finally {
      setSaving(false);
    }
  };

  const currentLabel = current?.userLabel || houseparents.find((hp) => hp.id === current?.userId)?.label || current?.userId;

  if (!canAssignHouseparent) {
    // Houseparents and other roles just see who's responsible, read-only.
    return (
      <div className="flex justify-between border-b pb-1">
        <span className="text-gray-500">Assigned Houseparent</span>
        <span className="font-semibold">{loading ? '…' : (currentLabel || '—')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-1 pt-1">
      <div className="flex justify-between items-center">
        <span className="text-gray-500 text-sm">Assigned Houseparent</span>
        {current && <span className="text-xs text-green-600 font-semibold">Currently: {currentLabel}</span>}
      </div>
      <div className="flex items-center gap-2">
        <Select value={selected || undefined} onValueChange={setSelected}>
          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select Houseparent" /></SelectTrigger>
          <SelectContent>
            {houseparents.map((hp) => {
              const isFull = hp.assignedCount >= hp.maxCaseload && hp.id !== current?.userId;
              return (
                <SelectItem key={hp.id} value={hp.id} disabled={isFull}>
                  {hp.label} — {hp.assignedCount}/{hp.maxCaseload}{isFull ? ' (Full)' : ''}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <Button size="sm" className="h-8 text-xs bg-[#2F3E46]" disabled={saving || !selected || selected === current?.userId} onClick={handleSave}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
