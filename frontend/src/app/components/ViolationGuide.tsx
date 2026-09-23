import { useEffect, useMemo, useState } from 'react';
import { Card as CardLike } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Textarea } from '@/app/components/ui/textarea';
import { Badge } from '@/app/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/app/components/ui/alert-dialog';
import {
  CheckCircle2,
  Edit,
  Eye,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { describeError, request } from '@/services/api';
import { systemDialog } from '@/app/components/SystemDialog';

type Category = 'Major' | 'Minor';
type OffenseLevel = '1st' | '2nd' | '3rd';
type GuideStatus = 'Active' | 'Inactive';

interface GuideIntervention {
  id?: string;
  guideId?: string;
  offenseLevel: OffenseLevel;
  interventionType?: string;
  duration?: number | null;
  unit?: string | null;
  metadata?: any;
}

interface GuideRecord {
  id: string;
  name: string;
  category: Category;
  description?: string | null;
  status?: GuideStatus | string;
  interventions?: GuideIntervention[];
  createdBy?: string | null;
  createdAt?: string | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
  systemOwned?: boolean;
}

interface InterventionDraft {
  interventionType: string;
  duration: string;
  unit: string;
  details: string;
}

const INTERVENTION_TYPES = [
    { value: 'Psychosocial Activity', label: 'Psychosocial Activity', requiresDuration: false },
  { value: 'Privilege Restriction', label: 'Privilege Restriction', requiresDuration: true },
  { value: 'Privilege Suspension', label: 'Privilege Suspension', requiresDuration: true },
  { value: 'Household Chores', label: 'Household Chores', requiresDuration: true },
  { value: 'Cleaning', label: 'Cleaning', requiresDuration: true },
  { value: 'Confiscation', label: 'Confiscation', requiresDuration: false },
  { value: 'Dialogue/Counseling', label: 'Dialogue / Counseling', requiresDuration: false },
  { value: 'Medical', label: 'Medical / Drug Test', requiresDuration: false },
  { value: 'Case Conference', label: 'Case Conference', requiresDuration: false },
  { value: 'Isolation', label: 'Isolation', requiresDuration: true },
  { value: 'Referral', label: 'Referral', requiresDuration: false },
  { value: 'Other', label: 'Other', requiresDuration: true },
] as const;

const UNIT_OPTIONS = ['Day(s)', 'Week(s)', 'Month(s)', 'Minute(s)', 'Meal(s)'];
const OFFENSES: Array<{ key: 'first' | 'second' | 'third'; label: string; level: OffenseLevel }> = [
  { key: 'first', label: '1st Offense', level: '1st' },
  { key: 'second', label: '2nd Offense', level: '2nd' },
  { key: 'third', label: '3rd Offense & Beyond', level: '3rd' },
];

function readMetadata(value: any) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function groupInterventions(interventions: GuideIntervention[] | undefined) {
  const grouped: Record<OffenseLevel, GuideIntervention[]> = {
    '1st': [],
    '2nd': [],
    '3rd': [],
  };
  for (const row of interventions || []) {
    if (grouped[row.offenseLevel]) grouped[row.offenseLevel].push(row);
  }
  return grouped;
}

function getInterventionType(row: GuideIntervention) {
  const known = INTERVENTION_TYPES.some((type) => type.value === row.interventionType);
  return known ? String(row.interventionType) : 'Other';
}

function toDraft(row: GuideIntervention): InterventionDraft {
  const metadata = readMetadata(row.metadata);
  return {
    interventionType: getInterventionType(row),
    duration: row.duration != null ? String(row.duration) : '',
    unit: row.unit || 'Day(s)',
    details: String(metadata?.officialText || metadata?.rawText || '').trim(),
  };
}

function emptyIntervention(): InterventionDraft {
  return {
    interventionType: 'Psychosocial Activity',
    duration: '',
    unit: 'Day(s)',
    details: '',
  };
}

function buildMetadata(type: string, details: string) {
  return {
    officialText: details.trim(),
    source: 'structured-intervention-guide',
    requiresPsychosocial: type === 'Psychosocial Activity',
    requiresPsychological: type === 'Medical',
    requiresMedical: type === 'Medical',
    requiresCaseConference: type === 'Case Conference',
    requiresIsolation: type === 'Isolation',
    requiresPrivilegeSuspension: type === 'Privilege Suspension',
    requiresPrivilegeRestriction: type === 'Privilege Restriction',
    requiresHouseholdChores: type === 'Household Chores',
    requiresCleaning: type === 'Cleaning',
    requiresConfiscation: type === 'Confiscation',
    schedulable:
      type === 'Psychosocial Activity' ||
      type === 'Medical' ||
      type === 'Case Conference' ||
      type === 'Dialogue/Counseling',
  };
}

function formatAuditDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function requirementText(row: GuideIntervention) {
  const metadata = readMetadata(row.metadata);
  return String(metadata?.officialText || metadata?.rawText || '').trim();
}

function levelLabel(level: OffenseLevel) {
  return level === '3rd' ? '3rd Offense & Beyond' : `${level} Offense`;
}

export default function ViolationGuide() {
  const [guides, setGuides] = useState<GuideRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'All' | Category>('All');
  const [statusFilter, setStatusFilter] = useState<'Active' | 'Inactive' | 'All'>('Active');
  const [editing, setEditing] = useState<GuideRecord | null>(null);
  const [viewing, setViewing] = useState<GuideRecord | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [toggleTarget, setToggleTarget] = useState<GuideRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    category: 'Major' as Category,
    status: 'Active' as GuideStatus,
    description: '',
    first: [] as InterventionDraft[],
    second: [] as InterventionDraft[],
    third: [] as InterventionDraft[],
  });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await request<{ success: boolean; data?: GuideRecord[] }>('/violation-guide');
      if (!response?.success) throw new Error('Unable to load the violation guide.');
      setGuides(
        (response.data || []).filter(
          (row) => row && (row.category === 'Major' || row.category === 'Minor')
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load the violation guide.');
      setGuides([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return guides.filter((guide) => {
      const matchesCategory = categoryFilter === 'All' || guide.category === categoryFilter;
      const matchesStatus = statusFilter === 'All' || (guide.status || 'Active') === statusFilter;
      const matchesSearch = !query || guide.name.toLowerCase().includes(query);
      return matchesCategory && matchesStatus && matchesSearch;
    });
  }, [guides, searchTerm, categoryFilter, statusFilter]);

  const openCreate = () => {
    setEditing(null);
    setFormError(null);
    setForm({
      name: '',
      category: 'Major',
      status: 'Active',
      description: '',
      first: [],
      second: [],
      third: [],
    });
    setShowEditor(true);
  };

  const openEdit = (guide: GuideRecord) => {
    const grouped = groupInterventions(guide.interventions);
    setEditing(guide);
    setFormError(null);
    setForm({
      name: guide.name,
      category: guide.category,
      status: (guide.status || 'Active') as GuideStatus,
      description: guide.description || '',
      first: grouped['1st'].map(toDraft),
      second: grouped['2nd'].map(toDraft),
      third: grouped['3rd'].map(toDraft),
    });
    setShowEditor(true);
  };

  const updateLevel = (
    level: 'first' | 'second' | 'third',
    index: number,
    patch: Partial<InterventionDraft>
  ) => {
    setForm((previous) => ({
      ...previous,
      [level]: previous[level].map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row
      ),
    }));
  };

  const addLevel = (level: 'first' | 'second' | 'third') => {
    setForm((previous) => ({
      ...previous,
      [level]: [...previous[level], emptyIntervention()],
    }));
  };

  const removeLevel = (level: 'first' | 'second' | 'third', index: number) => {
    setForm((previous) => ({
      ...previous,
      [level]: previous[level].filter((_, rowIndex) => rowIndex !== index),
    }));
  };

  const buildRows = (rows: InterventionDraft[]) =>
    rows.map((row) => {
      const type = INTERVENTION_TYPES.find((item) => item.value === row.interventionType);
      const requiresDuration = !!type?.requiresDuration;
      const detailsRequired = row.interventionType === 'Other';

      if (detailsRequired && !row.details.trim()) {
        throw new Error('Specific Requirement / Details is required when Intervention Type is Other.');
      }
      if (requiresDuration && !row.duration.trim()) {
        throw new Error(`Duration is required for ${row.interventionType}.`);
      }
      if (requiresDuration && !row.unit) {
        throw new Error(`Unit is required for ${row.interventionType}.`);
      }

      return {
        interventionType: row.interventionType,
        duration: row.duration.trim() ? Number(row.duration) : null,
        unit: row.duration.trim() ? row.unit || 'Day(s)' : null,
        metadata: buildMetadata(row.interventionType, row.details),
      };
    });

  const save = async () => {
    setFormError(null);
    if (!form.name.trim()) {
      setFormError('Violation Name is required.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        category: form.category,
        status: form.status,
        // Official seeded violations intentionally have no description.
        description: form.description.trim() || null,
        interventions: {
          '1st': buildRows(form.first),
          '2nd': buildRows(form.second),
          '3rd': buildRows(form.third),
        },
      };

      const response = await request<{ success: boolean; data?: GuideRecord }>(
        editing ? `/violation-guide/${editing.id}` : '/violation-guide',
        {
          method: editing ? 'PUT' : 'POST',
          body: JSON.stringify(payload),
        }
      );

      if (!response?.success) {
        throw new Error('Unable to save the violation guide entry.');
      }

      await load();
      setEditing(null);
      setShowEditor(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to save the violation guide entry.');
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (guide: GuideRecord) => {
    const current = (guide.status || 'Active') as GuideStatus;
    const nextStatus: GuideStatus = current === 'Inactive' ? 'Active' : 'Inactive';
    try {
      const response = await request<{ success: boolean }>(`/violation-guide/${guide.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!response?.success) {
        throw new Error(`Unable to ${nextStatus === 'Active' ? 'activate' : 'deactivate'} the violation.`);
      }
      await load();
    } catch (err) {
      void systemDialog.failure('Could not update the violation', describeError(err, 'The violation status was not changed. Please try again.'));
    }
  };

  const categoryCounts = {
    Major: guides.filter((g) => (g.status || 'Active') === 'Active' && g.category === 'Major').length,
    Minor: guides.filter((g) => (g.status || 'Active') === 'Active' && g.category === 'Minor').length,
  };
  const activeCount = guides.filter((g) => (g.status || 'Active') === 'Active').length;
  const inactiveCount = guides.filter((g) => (g.status || 'Active') === 'Inactive').length;

  const renderLevelItems = (rows: GuideIntervention[]) => {
    if (rows.length === 0) {
      return <p className="text-xs italic text-gray-400">No interventions added.</p>;
    }

    return (
      <ul className="space-y-2">
        {rows.map((row, index) => {
          const type = getInterventionType(row);
          const detail = requirementText(row);
          return (
            <li key={row.id || `${type}-${index}`} className="rounded-lg border border-gray-200 bg-gray-50 p-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-[10px]">{type}</Badge>
                {row.duration != null && row.unit && (
                  <Badge variant="outline" className="text-[10px]">{row.duration} {row.unit}</Badge>
                )}
              </div>
              {detail && (
                <p className="mt-1.5 break-words text-[11px] leading-relaxed text-gray-600">{detail}</p>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="text-lg font-bold text-[#2F3E46]">Manage Violations &amp; Interventions</h3>
          <p className="text-xs text-gray-500">This is the source of truth for the violations that can be logged in SCH.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          <Button size="sm" onClick={openCreate} className="gap-2 bg-[#2F3E46] text-white">
            <Plus className="w-4 h-4" /> Add Violation
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline" className="border-orange-200 text-orange-700">Major: {categoryCounts.Major}</Badge>
        <Badge variant="outline" className="border-yellow-200 text-yellow-700">Minor: {categoryCounts.Minor}</Badge>
        <Badge variant="outline" className="border-green-200 text-green-700">Active: {activeCount}</Badge>
        <Badge variant="outline" className="border-gray-200 text-gray-500">Inactive: {inactiveCount}</Badge>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_180px_180px]">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="Search violation..." className="pl-9" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Category</Label>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as 'All' | Category)}
            className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm"
          >
            <option value="All">All Categories</option>
            <option value="Major">Major</option>
            <option value="Minor">Minor</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Status</Label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'Active' | 'Inactive' | 'All')}
            className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm"
          >
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
            <option value="All">All Statuses</option>
          </select>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="rounded-xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-400">Loading violation guide…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-12 text-center">
          <p className="font-semibold text-gray-600">No violations found.</p>
          <p className="mt-1 text-xs text-gray-400">Adjust the status/category filter or add a violation guide entry.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((guide) => {
            const grouped = groupInterventions(guide.interventions);
            return (
              <CardLike key={guide.id} className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                <div className="p-4 sm:p-5">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                        <h4 className="min-w-0 break-words text-sm font-bold leading-relaxed text-[#2F3E46]">{guide.name}</h4>
                        <Badge variant="outline" className={guide.category === 'Major' ? 'border-orange-200 text-orange-700 text-[10px]' : 'border-yellow-200 text-yellow-700 text-[10px]'}>{guide.category}</Badge>
                        <Badge className={(guide.status || 'Active') === 'Inactive' ? 'bg-gray-100 text-gray-700 text-[10px]' : 'bg-green-100 text-green-700 text-[10px]'}>{guide.status || 'Active'}</Badge>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1.5 sm:w-36">
                      <Button size="sm" variant="outline" className="h-8 w-full justify-start gap-1.5 px-2 text-[11px]" onClick={() => setViewing(guide)}><Eye className="w-3.5 h-3.5" /> View</Button>
                      <Button size="sm" variant="outline" className="h-8 w-full justify-start gap-1.5 px-2 text-[11px] text-blue-600" onClick={() => openEdit(guide)}><Edit className="w-3.5 h-3.5" /> Edit</Button>
                      {(guide.status || 'Active') === 'Inactive' ? (
                        <Button size="sm" variant="outline" className="h-8 w-full justify-start gap-1.5 px-2 text-[11px] text-green-600" onClick={() => toggleStatus(guide)}><CheckCircle2 className="w-3.5 h-3.5" /> Activate</Button>
                      ) : (
                        <Button size="sm" variant="outline" className="h-8 w-full justify-start gap-1.5 px-2 text-[11px] text-red-600" onClick={() => setToggleTarget(guide)}><Trash2 className="w-3.5 h-3.5" /> Deactivate</Button>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
                    {OFFENSES.map((offense) => (
                      <section key={offense.level} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                        <p className="mb-2 text-xs font-black uppercase tracking-wide text-gray-500">{offense.label}</p>
                        {renderLevelItems(grouped[offense.level])}
                      </section>
                    ))}
                  </div>
                </div>
              </CardLike>
            );
          })}
        </div>
      )}

      <Dialog
        open={showEditor}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setShowEditor(false);
            setFormError(null);
          }
        }}
      >
        <DialogContent className="w-[96vw] max-w-4xl max-h-[94vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Violation & Interventions' : 'Add Violation & Interventions'}</DialogTitle>
          </DialogHeader>

          {formError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div>
          )}

          <div className="space-y-4 py-1">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.6fr_1fr_1fr]">
              <div className="space-y-2">
                <Label>Violation Name *</Label>
                <Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="e.g., Making noise during study time" />
              </div>
              <div className="space-y-2">
                <Label>Category *</Label>
                <select value={form.category} onChange={(e) => setForm((p) => ({ ...p, category: e.target.value as Category }))} className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm">
                  <option value="Minor">Minor</option>
                  <option value="Major">Major</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>Status *</Label>
                <select value={form.status} onChange={(e) => setForm((p) => ({ ...p, status: e.target.value as GuideStatus }))} className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm">
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Description (Optional)</Label>
              <Textarea rows={2} value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} placeholder="Optional description" />
            </div>

            <div className="border-t pt-4">
              <h4 className="mb-1 text-sm font-bold text-[#2F3E46]">Interventions by Offense Level</h4>
              <p className="mb-3 text-xs text-gray-500">Choose the structured intervention type. Use Specific Requirement / Details for the exact instruction to implement.</p>

              <div className="space-y-3">
                {OFFENSES.map(({ key, label }) => {
                  const rows = form[key];
                  return (
                    <section key={key} className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <p className="text-sm font-bold text-[#2F3E46]">{label}</p>
                        <Button type="button" variant="outline" size="sm" className="h-8 gap-1 px-2 text-xs" onClick={() => addLevel(key)}><Plus className="w-3.5 h-3.5" /> Add</Button>
                      </div>

                      {rows.length === 0 ? (
                        <p className="text-xs italic text-gray-400">No interventions added.</p>
                      ) : (
                        <div className="space-y-3">
                          {rows.map((row, index) => {
                            const selectedType = INTERVENTION_TYPES.find((type) => type.value === row.interventionType);
                            const isOther = row.interventionType === 'Other';
                            return (
                              <div key={index} className="rounded-lg border border-gray-200 bg-white p-3">
                                <div className="flex items-end gap-2">
                                  <div className="min-w-0 flex-1 space-y-1">
                                    <Label className="text-xs">Intervention Type</Label>
                                    <select value={row.interventionType} onChange={(e) => updateLevel(key, index, { interventionType: e.target.value })} className="h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-xs">
                                      {INTERVENTION_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                                    </select>
                                  </div>
                                  <button type="button" className="mb-1 text-gray-400 hover:text-red-600" onClick={() => removeLevel(key, index)} title="Remove intervention"><X className="h-4 w-4" /></button>
                                </div>

                                {selectedType?.requiresDuration && (
                                  <div className="mt-2 grid grid-cols-2 gap-2">
                                    <div className="space-y-1">
                                      <Label className="text-xs">Duration *</Label>
                                      <Input inputMode="numeric" value={row.duration} onChange={(e) => updateLevel(key, index, { duration: e.target.value.replace(/\D/g, '') })} placeholder="e.g. 2" className="h-9 text-xs" />
                                    </div>
                                    <div className="space-y-1">
                                      <Label className="text-xs">Unit *</Label>
                                      <select value={row.unit} onChange={(e) => updateLevel(key, index, { unit: e.target.value })} className="h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-xs">
                                        {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                                      </select>
                                    </div>
                                  </div>
                                )}

                                <div className="mt-2 space-y-1">
                                  <Label className="text-xs">Specific Requirement / Details {isOther ? '*' : '(Optional)'}</Label>
                                  <Textarea rows={3} value={row.details} onChange={(e) => updateLevel(key, index, { details: e.target.value })} placeholder={isOther ? 'Required: exact requirement/details' : 'Optional exact requirement from the guide'} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditing(null); setShowEditor(false); setFormError(null); }}>Cancel</Button>
            <Button disabled={saving || !form.name.trim()} onClick={save} className="bg-[#2F3E46] text-white">{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Violation'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!viewing} onOpenChange={(open) => { if (!open) setViewing(null); }}>
        <DialogContent className="w-[96vw] max-w-4xl max-h-[94vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="break-words">{viewing?.name}</DialogTitle></DialogHeader>
          {viewing && (() => {
            const grouped = groupInterventions(viewing.interventions);
            return (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{viewing.category}</Badge>
                  <Badge className={(viewing.status || 'Active') === 'Inactive' ? 'bg-gray-100 text-gray-700' : 'bg-green-100 text-green-700'}>{viewing.status || 'Active'}</Badge>
                </div>

                {viewing.description && (
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Description</p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-700">{viewing.description}</p>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    ['Created By', viewing.createdBy || '—'],
                    ['Created', formatAuditDate(viewing.createdAt)],
                    ['Last Edited By', viewing.updatedBy || '—'],
                    ['Last Edited', formatAuditDate(viewing.updatedAt)],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</p>
                      <p className="mt-1 break-words text-sm font-semibold text-[#2F3E46]">{value}</p>
                    </div>
                  ))}
                </div>

                <div className="space-y-3">
                  {OFFENSES.map((offense) => (
                    <section key={offense.level} className="rounded-xl border border-gray-200 bg-white">
                      <div className="border-b border-gray-200 bg-gray-50 px-3 py-2.5">
                        <p className="text-xs font-bold text-[#2F3E46]">{offense.label}</p>
                      </div>
                      <div className="p-3">{renderLevelItems(grouped[offense.level])}</div>
                    </section>
                  ))}
                </div>
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewing(null)}>Close</Button>
            {viewing && <Button onClick={() => { const current = viewing; setViewing(null); openEdit(current); }} className="bg-[#2F3E46] text-white"><Edit className="mr-1 h-4 w-4" /> Edit</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!toggleTarget} onOpenChange={(open) => { if (!open) setToggleTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{toggleTarget && (toggleTarget.status || 'Active') === 'Inactive' ? 'Activate violation?' : 'Deactivate violation?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {toggleTarget && (toggleTarget.status || 'Active') === 'Inactive'
                ? 'This will make the violation available for future SCH incident logging again.'
                : 'This will remove the violation from future logging choices while preserving existing incident history.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={async () => { if (!toggleTarget) return; const target = toggleTarget; setToggleTarget(null); await toggleStatus(target); }}>
              {toggleTarget && (toggleTarget.status || 'Active') === 'Inactive' ? 'Activate' : 'Deactivate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
