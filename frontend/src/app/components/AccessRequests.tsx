import { useEffect, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Textarea } from '@/app/components/ui/textarea';
import { useAuth } from '../state/AuthContext';
import { request } from '@/services/api';

interface AccessRequest {
  id: string;
  requesterUsername: string;
  targetRole?: string;
  residentId?: string;
  moduleName?: string;
  recordTab?: string;
  reason: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  reviewedBy?: string;
  reviewerNote?: string;
  createdAt?: string;
}

export function AccessRequests() {
  const { user } = useAuth();
  const [items, setItems] = useState<AccessRequest[]>([]);
  const [targetRole, setTargetRole] = useState('psychologist');
  const [moduleName, setModuleName] = useState('Assessments');
  const [recordTab, setRecordTab] = useState('');
  const [residentId, setResidentId] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const canReview = user?.role === 'centerhead' || user?.role === 'admin' || user?.role === 'psychologist';

  const load = async () => {
    try {
      const result = await request<{ success: boolean; data: AccessRequest[] }>('/access-requests');
      setItems(result.data || []);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to load access requests'); }
  };

  useEffect(() => { load(); }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true); setMessage('');
    try {
      await request('/access-requests', {
        method: 'POST',
        body: JSON.stringify({ targetRole, moduleName: moduleName || undefined, recordTab: recordTab || undefined, residentId: residentId || undefined, reason }),
      });
      setReason(''); setResidentId(''); setRecordTab('');
      setMessage('Access request submitted.');
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to submit request'); }
    setLoading(false);
  };

  const review = async (id: string, decision: 'Approved' | 'Rejected') => {
    try {
      await request(`/access-requests/${id}/review`, { method: 'POST', body: JSON.stringify({ decision }) });
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to review request'); }
  };

  return (
    <div className="space-y-6 p-4">
      <div><h2 className="text-2xl font-bold text-[#2F3E46]">Request Access</h2><p className="text-sm text-gray-500">Request controlled access to another team&apos;s records.</p></div>
      <Card><CardHeader><CardTitle className="text-base">Submit Request</CardTitle></CardHeader><CardContent>
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
          <div><Label>Authorized Role</Label><select className="mt-1 w-full rounded-md border p-2" value={targetRole} onChange={e => setTargetRole(e.target.value)}><option value="psychologist">Psychologist</option><option value="centerhead">Center Head</option></select></div>
          <div><Label>Module</Label><Input className="mt-1" value={moduleName} onChange={e => setModuleName(e.target.value)} placeholder="e.g. Assessments" /></div>
          <div><Label>Record Tab (optional)</Label><Input className="mt-1" value={recordTab} onChange={e => setRecordTab(e.target.value)} placeholder="e.g. Medical" /></div>
          <div><Label>Resident ID (optional)</Label><Input className="mt-1" value={residentId} onChange={e => setResidentId(e.target.value)} placeholder="Specific resident" /></div>
          <div className="md:col-span-2"><Label>Reason</Label><Textarea className="mt-1" value={reason} onChange={e => setReason(e.target.value)} required placeholder="Explain why access is needed" /></div>
          <div className="md:col-span-2 flex items-center gap-3"><Button type="submit" disabled={loading}>{loading ? 'Submitting...' : 'Submit Access Request'}</Button>{message && <span className="text-sm text-gray-600">{message}</span>}</div>
        </form>
      </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Request Status</CardTitle></CardHeader><CardContent className="space-y-3">
        {items.length === 0 ? <p className="text-sm text-gray-500">No access requests.</p> : items.map(item => <div key={item.id} className="flex flex-col gap-2 rounded-md border p-3 md:flex-row md:items-center"><div className="flex-1 text-sm"><p className="font-semibold">{item.requesterUsername} requested {item.moduleName || item.recordTab}</p><p className="text-gray-500">Target: {item.targetRole || 'designated user'}{item.residentId ? ` · Resident: ${item.residentId}` : ''}</p><p className="text-gray-500">{item.reason}</p></div><span className={`rounded px-2 py-1 text-xs font-semibold ${item.status === 'Approved' ? 'bg-green-100 text-green-700' : item.status === 'Rejected' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>{item.status}</span>{canReview && item.status === 'Pending' && item.requesterUsername !== user?.username && <div className="flex gap-2"><Button size="sm" onClick={() => review(item.id, 'Approved')}>Approve</Button><Button size="sm" variant="outline" onClick={() => review(item.id, 'Rejected')}>Reject</Button></div>}</div>)}
      </CardContent></Card>
    </div>
  );
}
