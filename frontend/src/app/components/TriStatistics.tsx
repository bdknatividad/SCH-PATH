/**
 * TRI Statistics — how many active residents sit under each TRI status.
 *
 * Read from GET /tri/monitor, which returns one row per Active resident with the
 * rating of their most recent Finalized TRI (or none). Nothing is recomputed
 * here: the rating is the one the TRI itself recorded, so the scoring rules stay
 * exactly where they are.
 *
 *   Scored             residents whose latest Finalized TRI has a rating
 *   Very Good / Good / Fair / Needs Improvement
 *                      the scored residents, by that rating
 *   Unscored           residents with no Finalized TRI yet
 *
 * Scored always equals the sum of the four ratings, and Scored + Unscored is
 * every active resident.
 *
 * Kept current without a page reload: re-read when `refreshKey` changes (the TRI
 * module passes its records, which change whenever a TRI is saved, submitted or
 * finalized), when the window regains focus, and every 30 seconds.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { request } from '@/services/api';

export interface TriMonitorRow {
  residentId: string;
  name: string;
  rating: string | null;
  points?: number | null;
  period?: { year: number; month: number } | null;
}

const RATINGS = ['Very Good', 'Good', 'Fair', 'Needs Improvement'] as const;

export function countTriStatistics(rows: TriMonitorRow[]) {
  const counts: Record<string, number> = { Scored: 0, 'Very Good': 0, Good: 0, Fair: 0, 'Needs Improvement': 0, Unscored: 0 };
  for (const row of rows || []) {
    if (row.rating && (RATINGS as readonly string[]).includes(row.rating)) {
      counts[row.rating] += 1;
      counts.Scored += 1;
    } else {
      counts.Unscored += 1;
    }
  }
  return counts;
}

/** Loads /tri/monitor and keeps it current. */
export function useTriMonitor(refreshKey?: unknown, enabled = true) {
  const [rows, setRows] = useState<TriMonitorRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    const id = (requestId.current += 1);
    try {
      const result = await request<{ success: boolean; data?: TriMonitorRow[] }>('/tri/monitor');
      if (id === requestId.current) { setRows(result?.data || []); setError(null); }
    } catch (err) {
      if (id === requestId.current) setError(err instanceof Error ? err.message : 'Unable to load TRI statistics');
    }
  }, [enabled]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => { load(); };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(onFocus, 30000);
    return () => { window.removeEventListener('focus', onFocus); window.clearInterval(timer); };
  }, [load, enabled]);

  return { rows, error, reload: load };
}

const TILES: { key: string; label: string; cls: string; hint: string }[] = [
  { key: 'Scored', label: 'Scored', cls: 'border-[#2F3E46]/20 bg-[#2F3E46]/5 text-[#2F3E46]', hint: 'Have a finalized TRI score' },
  { key: 'Very Good', label: 'Very Good', cls: 'border-green-200 bg-green-50 text-green-700', hint: '451–600 points' },
  { key: 'Good', label: 'Good', cls: 'border-blue-200 bg-blue-50 text-blue-700', hint: '301–450 points' },
  { key: 'Fair', label: 'Fair', cls: 'border-yellow-200 bg-yellow-50 text-yellow-700', hint: '151–300 points' },
  { key: 'Needs Improvement', label: 'Needs Improvement', cls: 'border-red-200 bg-red-50 text-red-700', hint: '1–150 points' },
  { key: 'Unscored', label: 'Unscored', cls: 'border-gray-200 bg-gray-50 text-gray-500', hint: 'No finalized TRI yet' },
];

/** The TRI Statistics card. */
export function TriStatistics({ refreshKey }: { refreshKey?: unknown }) {
  const { rows, error } = useTriMonitor(refreshKey);
  const counts = useMemo(() => countTriStatistics(rows || []), [rows]);
  const total = rows?.length ?? 0;

  return (
    <Card className="border-none shadow-sm" data-tri-statistics>
      <CardHeader className="border-b border-gray-100 pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-[#2F3E46]">
          <BarChart3 className="w-5 h-5 text-[#FFD100]" /> TRI Statistics
        </CardTitle>
        <p className="mt-1 text-[11px] text-gray-500">
          Active residents by the rating of their most recent Finalized TRI{rows ? ` · ${total} resident${total === 1 ? '' : 's'}` : ''}.
        </p>
      </CardHeader>
      <CardContent className="pt-3">
        {error && !rows ? (
          <p className="text-xs text-red-600">{error}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {TILES.map((tile) => (
              <div key={tile.key} className={`rounded-lg border p-3 ${tile.cls}`} data-tri-stat={tile.key}>
                <p className="text-[11px] font-bold uppercase tracking-wide opacity-80">{tile.label}</p>
                <p className="text-2xl font-bold">{rows ? counts[tile.key] : '…'}</p>
                <p className="text-[10px] opacity-70">{tile.hint}</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default TriStatistics;
