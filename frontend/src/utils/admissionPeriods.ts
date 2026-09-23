/**
 * Admission periods — how a returning resident's documents are kept apart.
 *
 * A resident who is discharged and later re-admitted keeps **one** `children`
 * row: the intake form (`admissionController.create`) writes the closing
 * admission onto `previousCases[]` and overwrites `admissionDate` with the new
 * one. So the row itself is the admission history, and the Documents module
 * reads it from there rather than asking the API for the `admissions` table
 * (which `resourceMapping` never exposes to the client):
 *
 *   previousCases[i].admissionNumber which admission it was, 1-based
 *   previousCases[i].admissionDate   start of that admission
 *   previousCases[i].closedDate      end of that admission
 *   admissionDate                    start of the latest admission
 *   readmissionDate                  the same, once the resident has returned
 *   readmissionDatetime              precise ISO start of the latest admission
 *
 * The older `date` / `dischargeDate` spellings are still read as a fallback,
 * because `childController.readmit` writes that shape and a record created
 * through it must not silently lose its split.
 *
 * The point of all this is that documents must not be merged. Before this, the
 * folder view showed one child folder holding every admission's files together,
 * so a resident admitted three times read as a single undated pile and there was
 * no way to tell which admission a TRI or a medical record belonged to.
 *
 * ## Which period a document belongs to
 *
 * The rule matches `PhaseProgress.belongsToCurrentAdmission`, which is the
 * module that already splits documents by admission and therefore the one whose
 * answer must not disagree:
 *
 *   · at the latest admission's boundary, `readmissionDatetime` decides — the
 *     document's full timestamp is compared, so a file uploaded the same day but
 *     before the resident arrived stays with the admission that was closing;
 *   · at that boundary with only a date to go on, the comparison is strict, so a
 *     same-day file is likewise read as belonging to the closing admission;
 *   · at the older boundaries only a date exists, so a file dated on the
 *     boundary goes to the later admission;
 *   · a file with no timestamp at all is treated as belonging to the earliest
 *     period, which is what `PhaseProgress` does with it too.
 */

/** One admission of a resident, as the folder view needs to describe it. */
export interface AdmissionPeriod {
  /** Stable React key and the grouping key documents are matched against. */
  key: string;
  /** Folder heading, e.g. "Previous Admission Records". */
  label: string;
  /** Date range printed under the heading. */
  rangeLabel: string;
  /** 1 for the first admission, 2 for the second, and so on. */
  admissionNumber: number;
  /** The `admissions` row this period stands for, when the record names it. */
  admissionId: string;
  /** The admission currently open — or the most recent one when all are closed. */
  isCurrent: boolean;
  /** `YYYY-MM-DD`, or '' when the record does not say. */
  startDate: string;
  /** `YYYY-MM-DD`, or null while the admission is still open. */
  endDate: string | null;
}

/** The part of a resident this module needs. */
export interface AdmissionHistorySource {
  admissionDate?: unknown;
  readmissionDate?: unknown;
  readmissionDatetime?: unknown;
  previousCases?: unknown;
}

/** The part of a document this module needs. */
export interface AdmissionDatedDocument {
  /** The admission the document was filed under. Decides placement on its own. */
  admissionId?: unknown;
  uploadedAt?: unknown;
  createdAt?: unknown;
  submittedAt?: unknown;
}

/** `YYYY-MM-DD` from a date, a timestamp, or an ISO datetime. */
function dateOnly(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

/**
 * The document's own clock, normalised so two of them can be compared as
 * strings: `'YYYY-MM-DDTHH:mm:ss'` when a time is known, `'YYYY-MM-DD'` when
 * only a date is.
 *
 * `uploadedAt` first because that is what `PhaseProgress` compares — a document
 * published by TRI / Anecdotal / QPR / Health is stamped at upload time, and
 * `createdAt` is the fallback for a row written before that column was filled.
 */
function comparableStamp(document: AdmissionDatedDocument | null | undefined): string {
  const candidates = [document?.uploadedAt, document?.createdAt, document?.submittedAt];
  for (const candidate of candidates) {
    const raw = String(candidate ?? '').trim();
    if (!raw) continue;
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2}))?/);
    if (!match) continue;
    return match[2] ? `${match[1]}T${match[2]}` : match[1];
  }
  return '';
}

/**
 * The readmission boundary as `'YYYY-MM-DDTHH:mm:ss'`, so it can be compared
 * with a document stamp as a string.
 *
 * `readmissionDatetime` is written with `toISOString()`, so it carries a zone and
 * milliseconds, while a document's `uploadedAt` arrives from MySQL already in
 * local time. Comparing the two raw strings is wrong twice over: the longer one
 * sorts as "greater" at the same instant, and the zone puts the boundary hours
 * away from the files it is meant to divide. Converting the boundary to local
 * time and to the same precision fixes both, and leaves the comparison as a
 * plain string test on two values that describe the same clock.
 */
function comparableBoundary(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    // Not something `Date` understands: fall back to the literal text, trimmed
    // to the precision a document stamp has.
    return raw.replace(' ', 'T').slice(0, 19);
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}` +
    `T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `'2025-03-12'` → `'12 Mar 2025'`, read as text rather than through `Date`. */
function readableDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return value;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

function rangeFor(start: string, end: string | null): string {
  if (start && end) return `${readableDate(start)} – ${readableDate(end)}`;
  if (start) return `${readableDate(start)} – present`;
  if (end) return `until ${readableDate(end)}`;
  return 'dates not recorded';
}

/**
 * Every admission this resident has had, oldest first — or `[]` when there is
 * only one, because a single admission needs no grouping and the folder view
 * must stay exactly as it was for the common case.
 */
export function admissionPeriodsFor(child: AdmissionHistorySource | null | undefined): AdmissionPeriod[] {
  if (!child || typeof child !== 'object') return [];

  const history = Array.isArray(child.previousCases) ? child.previousCases : [];

  const closed = history
    .map((entry: any) => ({
      admissionId: String(entry?.admissionId ?? '').trim(),
      admissionNumber: Number(entry?.admissionNumber) || 0,
      // `admissionDate` is what the intake form writes; `date` is the older
      // `readmit` spelling. Same for the closing date.
      startDate: dateOnly(entry?.admissionDate) || dateOnly(entry?.date),
      endDate: dateOnly(entry?.closedDate) || dateOnly(entry?.dischargeDate) || null,
    }))
    .filter((entry) => entry.startDate || entry.endDate);

  // No closed admission on record: one admission, so nothing to separate.
  if (closed.length === 0) return [];

  const currentStart =
    dateOnly(child.readmissionDate) ||
    dateOnly(child.admissionDate) ||
    dateOnly(child.readmissionDatetime);

  // Continue the numbering the record already uses, so a resident admitted
  // three times reads as Admissions 1, 2 and 3 rather than being renumbered.
  const highestClosed = closed.reduce(
    (max, entry) => Math.max(max, entry.admissionNumber),
    closed.length,
  );
  const total = highestClosed + 1;

  const periods: AdmissionPeriod[] = closed.map((entry, index) => {
    const admissionNumber = entry.admissionNumber > 0 ? entry.admissionNumber : index + 1;
    return {
      key: `admission-${admissionNumber}`,
      label:
        closed.length === 1
          ? 'Previous Admission Records'
          : `Previous Admission Records — Admission ${admissionNumber}`,
      rangeLabel: rangeFor(entry.startDate, entry.endDate),
      admissionNumber,
      admissionId: entry.admissionId,
      isCurrent: false,
      startDate: entry.startDate,
      endDate: entry.endDate,
    };
  });

  periods.push({
    key: `admission-${total}`,
    label: 'Current Admission Records',
    rangeLabel: rangeFor(currentStart, null),
    admissionNumber: total,
    // The open admission's own id is not part of the closed history, so it is
    // left blank here and matched by exclusion in `admissionPeriodKeyFor`.
    admissionId: '',
    isCurrent: true,
    startDate: currentStart,
    endDate: null,
  });

  return periods;
}

/**
 * The key of the period a document belongs to, or `null` when the resident has
 * a single admission and no grouping applies.
 *
 * The document's own `admissionId` decides, when it has one. Only a document
 * with no link at all — one written before the column existed and not reached by
 * the backfill — falls back to its timestamp.
 *
 * @param preciseBoundary `readmissionDatetime` — used only by that fallback, as
 *   the one boundary on record that carries a time, and therefore the only one
 *   that can place a file uploaded on the day the resident came back.
 */
export function admissionPeriodKeyFor(
  document: AdmissionDatedDocument | null | undefined,
  periods: AdmissionPeriod[],
  preciseBoundary?: unknown,
): string | null {
  if (!periods || periods.length < 2) return null;

  const earliest = periods[0].key;
  const last = periods.length - 1;

  // An explicit link beats every inference below. The document stores the
  // admission it was produced under, so it goes there — and stays there, because
  // nothing the resident does afterwards changes that column. This is the only
  // rule that can separate two admissions on the same day, and the only one that
  // can place a document that carries no timestamp at all.
  //
  // Guarded on the period list actually naming admissions. A record written
  // before `previousCases` carried admission ids would otherwise match nothing,
  // and "matched nothing" is read below as "belongs to the current admission" —
  // which would sweep every earlier admission's files into the current folder.
  // That is worse than the timestamp fallback, so the link is only trusted when
  // there is something to match it against.
  const linked = String(document?.admissionId ?? '').trim();
  if (linked && periods.some((period) => period.admissionId)) {
    const match = periods.find((period) => period.admissionId === linked);
    // Not among the closed admissions on record, so it was produced under the
    // admission that is open now — the one admission this list cannot name.
    return match ? match.key : periods[last].key;
  }

  // No link on the row (a document written before the column existed and not
  // covered by the backfill): fall back to the document's own timestamp.
  const stamp = comparableStamp(document);
  if (!stamp) return earliest;

  const day = stamp.slice(0, 10);

  // The latest period whose start is at or before the document's day.
  let target = -1;
  for (let index = last; index >= 0; index -= 1) {
    const start = periods[index].startDate;
    if (start && start <= day) {
      target = index;
      break;
    }
  }
  // Dated before the first admission on record: the earliest period owns it.
  if (target === -1) return earliest;

  // The date alone can only say "on or after the day the resident came back".
  // When the record also carries the time, that decides instead.
  if (target === last && day === periods[last].startDate) {
    const boundary = comparableBoundary(preciseBoundary);
    if (stamp.length > 10 && boundary) {
      return stamp >= boundary ? periods[last].key : periods[last - 1].key;
    }
    // Date only: strictly after the boundary day is the current admission, so a
    // same-day file stays with the admission that was closing.
    return periods[last - 1].key;
  }

  return periods[target].key;
}
