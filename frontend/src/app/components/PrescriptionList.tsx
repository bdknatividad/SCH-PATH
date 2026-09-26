/**
 * Prescriptions, as a list with a "given" toggle.
 *
 * A prescription is a `healthRecords` row of type `Medication Log` — the record
 * already carries the medicine, dosage, frequency, duration and prescriber. What
 * it lacked was any way to say the prescription had actually been given, and
 * anywhere to read one properly outside the Health module's own editor.
 *
 * One component for both surfaces, deliberately. The requirement is that marking
 * a prescription done in Child Records → Medical and marking it done in the
 * Health module are the same act; rendering the same component over the same
 * records and calling the same endpoint is what makes that true, rather than two
 * screens that have to be kept in step by hand.
 */

import { useState } from 'react';
import { Pill, Check, Loader2, RotateCcw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { request } from '@/services/api';

/** The record type a prescription is stored as. */
export const PRESCRIPTION_RECORD_TYPE = 'Medication Log';

/** Is this health record a prescription? */
export function isPrescription(record: any): boolean {
  return String(record?.recordType || '') === PRESCRIPTION_RECORD_TYPE;
}

/** `2026-09-26` → `Sep 26, 2026`, without dragging in a formatter. */
function shortDate(value?: string | null): string {
  const iso = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '—';
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The prescription's own line: `500mg · Once daily · 2 weeks`. */
function doseLine(record: any): string {
  return [record?.dosage, record?.frequency, record?.duration]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' · ');
}

export function PrescriptionList({
  records,
  canMark,
  onChanged,
  title = 'Prescriptions',
  emptyMessage = 'No prescriptions on file for this resident.',
}: {
  records: any[];
  /** Whether the caller holds `Health:edit` — the capability the route checks. */
  canMark: boolean;
  /** Re-read the records after a change, so both surfaces show the same answer. */
  onChanged?: () => void;
  title?: string;
  emptyMessage?: string;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const prescriptions = (records || []).filter(isPrescription);

  /**
   * Mark given, or clear it.
   *
   * One endpoint for both surfaces. `PUT /health-records/:id` was not usable —
   * it re-publishes the record's document, so a checkbox would rewrite the
   * child's filed copy.
   */
  const setGiven = async (record: any, given: boolean) => {
    setBusyId(record.id);
    setError(null);
    try {
      await request(`/health-records/${record.id}/prescription-given`, {
        method: 'POST',
        body: JSON.stringify({ given }),
      });
      onChanged?.();
    } catch (err: any) {
      setError(err?.message || 'Unable to update this prescription.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="border-none shadow-sm">
      <CardHeader className="border-b border-gray-100 pb-3">
        <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
          <Pill className="w-5 h-5 text-[#FFD100]" /> {title}
          <Badge className="bg-[#2F3E46]/10 text-[#2F3E46]">{prescriptions.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        {error && <p className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        {prescriptions.length === 0 ? (
          <p className="py-2 text-sm italic text-gray-400">{emptyMessage}</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {prescriptions.map((record) => {
              const given = Boolean(record.givenAt);
              return (
                <li key={record.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-bold text-[#2F3E46]">{record.medicationName || 'Medication'}</p>
                      {given ? (
                        <Badge className="border-none bg-green-100 text-green-800">Given</Badge>
                      ) : (
                        <Badge className="border-none bg-amber-100 text-amber-800">Not yet given</Badge>
                      )}
                    </div>
                    {/* What the medicine is, how much, how often, for how long —
                        the four things another staff member needs. */}
                    {doseLine(record) && <p className="mt-0.5 text-xs font-semibold text-gray-600">{doseLine(record)}</p>}
                    <p className="mt-0.5 text-[11px] text-gray-400">
                      Prescribed {shortDate(record.date)}
                      {record.prescribedBy ? ` by ${record.prescribedBy}` : ''}
                      {given && record.givenBy ? ` · given by ${record.givenBy}` : ''}
                    </p>
                  </div>
                  {canMark && (
                    <Button
                      size="sm"
                      variant={given ? 'outline' : 'default'}
                      className={given ? 'shrink-0 gap-1.5' : 'shrink-0 gap-1.5 bg-[#2F3E46] text-white'}
                      disabled={busyId !== null}
                      onClick={() => void setGiven(record, !given)}
                    >
                      {busyId === record.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : given ? <RotateCcw className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                      {given ? 'Undo' : 'Mark as given'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
