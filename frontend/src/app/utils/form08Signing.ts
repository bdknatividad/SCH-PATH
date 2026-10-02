/**
 * Which line of Form 08 a role signs, and where that line sits on the form.
 *
 * Shared by the two screens that need it: `IncidentReportModal` (the signer draws
 * on their own line inside the report) and `InterventionTracker` (the row says
 * whose turn it is and opens the report). Two copies of this map would be two
 * chances to disagree about who signs what — and the API is the authority either
 * way: `resolveVerificationSide` refuses a line the caller does not own, and
 * `verify` refuses a signer until the one before them has signed (the Social
 * Worker, then the Psychological Support Staff, then the Center Head).
 *
 * @module utils/form08Signing
 */

export type Form08Side = 'sw' | 'psych' | 'ch';

/**
 * The line this role signs, or `null` for a role with no line on the form.
 *
 * The Administrator is deliberately absent: it holds full access but has no
 * printed line on Form 08, and the API refuses it for the same reason.
 */
export function form8SideForRole(role: string): Form08Side | null {
  switch (String(role || '').trim().toLowerCase()) {
    case 'socialworker':
    case 'social_worker':
    case 'social worker':
      return 'sw';
    case 'psychologist':
    case 'psychological staff':
      return 'psych';
    case 'centerhead':
    case 'center_head':
    case 'center head':
      return 'ch';
    default:
      return null;
  }
}

/**
 * The overlay each side draws on, keyed as `SIGNATURE_BOXES` and `SIGNATURE_LABELS`
 * are in the modal — the pad's box and the PDF stamp's box are the same
 * measurement, so a signature always lands where it was drawn.
 */
export const FORM08_SIDE_BOX_KEY: Record<Form08Side, 'checkedBy' | 'notedBy' | 'psychStaff'> = {
  sw: 'checkedBy',
  psych: 'psychStaff',
  ch: 'notedBy',
};

/**
 * One entry of the report's `signatures.sides`, as the API derived it — including
 * the printed line each signer owns. Read from the payload rather than kept as a
 * second copy here, so the screens and the form cannot disagree.
 */
export function form8SideEntry(report: any, side: string | null | undefined): any | null {
  return (report?.signatures?.sides || []).find((entry: any) => entry.side === side) || null;
}

/** Who the form is waiting on, in words: "the Social Worker", or null when done. */
export function form8WaitingLabel(report: any): string | null {
  const next = report?.signatures?.nextSide;
  if (!next) return null;
  return form8SideEntry(report, next)?.label || null;
}
