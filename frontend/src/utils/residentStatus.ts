/**
 * A resident's case status — the frontend twin of
 * `backend/src/utils/residentStatus.js`. Keep the two in step.
 *
 * `children.status` holds four values:
 *
 *   - `Active`      — in care
 *   - `Discharged`  — completed the programme and left
 *   - `Transferred` — left **without** completing it, because a phase was
 *                     force-advanced past its requirements
 *   - `Absconded`   — left without notice
 *
 * `Discharged` and `Transferred` are both **closed**. Every filter, count and
 * gate that used to test `status === 'Discharged'` was really asking "is this
 * case over?", so they read through here now. Testing the string directly is how
 * a transferred resident reappears in an active list, or vanishes from the
 * archive.
 */

export const CLOSED_RESIDENT_STATUSES = ['Discharged', 'Transferred'] as const;

export type ResidentStatus = 'Active' | 'Discharged' | 'Transferred' | 'Absconded';

/** Is this case over, either way? */
export function isClosedResident(status?: string | null): boolean {
  return (CLOSED_RESIDENT_STATUSES as readonly string[]).includes(String(status || '').trim());
}

/** Is this resident still in care? An absconded resident is not. */
export function isActiveResident(status?: string | null): boolean {
  const value = String(status || '').trim();
  return value !== 'Absconded' && !isClosedResident(value);
}

/**
 * The status to *show*. A record with no status is Active — that is what the
 * blank means on rows written before the field existed, and it is what every
 * list in the app already assumes.
 */
export function residentStatusLabel(status?: string | null): ResidentStatus {
  const value = String(status || '').trim();
  if (value === 'Discharged' || value === 'Transferred' || value === 'Absconded') return value;
  return 'Active';
}

/** How a closed case should read on screen. */
export function closedStatusLabel(status?: string | null): string {
  return String(status || '').trim() === 'Transferred' ? 'Transferred' : 'Discharged';
}
