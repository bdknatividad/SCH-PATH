/**
 * The pending-review queue, counted one way.
 *
 * "Docs Pending" on the Dashboard and the Documents module's "For Review" badge
 * describe the same queue, and they disagreed in two separate ways:
 *
 *   - The Dashboard carried a hand-written list of document titles to hide from a
 *     Social Worker. Which documents a role may see is the API's answer — the
 *     store load already filters the list through `canReadDocument`, so those
 *     rows never arrive — and the list had drifted: it named `Mental Health
 *     Report`, which has no role restriction anywhere in the definition, so the
 *     tile hid a document the module listed.
 *   - The module's badge counted every pending document while its own tab listed
 *     only the ones the module's default filters admit. The default resident
 *     status is `Active`, so a discharged resident's pending file was counted and
 *     then not shown.
 *
 * The rule therefore lives here, once, and both screens read it. A second copy is
 * how the two numbers came apart in the first place.
 */

/** The two pre-decision statuses. `Submitted` is a first look; `Under Review` is
 *  one a reviewer has opened but not decided. `GET /documents/pending` and the
 *  Documents module both treat the two as pending. */
export const PENDING_REVIEW_STATUSES = ['Submitted', 'Under Review'] as const;

/** Is this document waiting for a review decision? */
export function isPendingReview(doc: any): boolean {
  return (PENDING_REVIEW_STATUSES as readonly string[]).includes(String(doc?.status || ''));
}

/**
 * Is this document's resident still an active case?
 *
 * A resident who is not in the loaded list counts as active rather than
 * disappearing — the filter is meant to narrow the list, not to make a file
 * unreachable because a second page of residents has not loaded. This mirrors the
 * Documents module's own rule.
 */
export function residentIsActive(children: any[] | undefined, residentId?: string | null): boolean {
  const owner = (children || []).find((child) => child?.id === residentId);
  return !owner || owner.status !== 'Discharged';
}

/**
 * The pending-review queue as the Dashboard's "Docs Pending" tile counts it: what
 * is waiting, for residents who are still active. That is the Documents module's
 * default view, so the tile and the module's badge agree without the reader
 * having to know which filters are on.
 */
export function pendingReviewQueue(documents: any[] | undefined, children: any[] | undefined): any[] {
  return (documents || []).filter(
    (doc) => isPendingReview(doc) && residentIsActive(children, doc?.residentId),
  );
}
