/**
 * Date Formatter Utilities
 * Formats dates for Philippines timezone (Asia/Manila)
 *
 * System display format:
 *   MM/DD/YYYY
 *
 * Stored/input format:
 *   YYYY-MM-DD
 */

/**
 * Parse a date value safely — avoids timezone shift
 * for YYYY-MM-DD strings.
 */
function parseDate(
  date: string | Date
): Date {
  if (date instanceof Date) {
    return date;
  }

  /*
   * Plain date string (YYYY-MM-DD):
   * parse at local noon to avoid timezone shift.
   */
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(
      date
    )
  ) {
    const [
      y,
      m,
      d,
    ] = date
      .split('-')
      .map(Number);

    return new Date(
      y,
      m - 1,
      d,
      12,
      0,
      0
    );
  }

  /*
   * ISO string:
   * strip the time portion first so the
   * calendar date does not shift.
   */
  if (date.includes('T')) {
    const dateOnly =
      date.split('T')[0];

    const [
      y,
      m,
      d,
    ] = dateOnly
      .split('-')
      .map(Number);

    return new Date(
      y,
      m - 1,
      d,
      12,
      0,
      0
    );
  }

  return new Date(date);
}

/**
 * Format date as:
 *
 * MM/DD/YYYY
 *
 * Example:
 * 09/12/2026
 */
export function formatPHDate(
  date:
    | string
    | Date
    | undefined
    | null
): string {
  if (!date) {
    return 'N/A';
  }

  const d =
    parseDate(date);

  if (
    isNaN(
      d.getTime()
    )
  ) {
    return 'Invalid Date';
  }

  const month =
    String(
      d.getMonth() + 1
    ).padStart(
      2,
      '0'
    );

  const day =
    String(
      d.getDate()
    ).padStart(
      2,
      '0'
    );

  const year =
    d.getFullYear();

  return `${month}/${day}/${year}`;
}

/**
 * Format date and time using
 * Philippines timezone.
 *
 * Date portion:
 *   MM/DD/YYYY
 */
export function formatPHDateTime(
  date:
    | string
    | Date
    | undefined
    | null
): string {
  if (!date) {
    return 'N/A';
  }

  const d =
    new Date(date);

  if (
    isNaN(
      d.getTime()
    )
  ) {
    return 'Invalid Date';
  }

  const month =
    String(
      new Intl.DateTimeFormat(
        'en-US',
        {
          timeZone:
            'Asia/Manila',
          month:
            '2-digit',
        }
      ).format(d)
    );

  const day =
    String(
      new Intl.DateTimeFormat(
        'en-US',
        {
          timeZone:
            'Asia/Manila',
          day:
            '2-digit',
        }
      ).format(d)
    );

  const year =
    String(
      new Intl.DateTimeFormat(
        'en-US',
        {
          timeZone:
            'Asia/Manila',
          year:
            'numeric',
        }
      ).format(d)
    );

  const time =
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone:
          'Asia/Manila',
        hour:
          '2-digit',
        minute:
          '2-digit',
        hour12:
          true,
      }
    ).format(d);

  return `${month}/${day}/${year} ${time}`;
}

/**
 * Format short date.
 *
 * Same system format:
 *   MM/DD/YYYY
 */
export function formatShortDate(
  date:
    | string
    | Date
    | undefined
    | null
): string {
  return formatPHDate(
    date
  );
}

/**
 * Format date with time.
 *
 * Date:
 *   MM/DD/YYYY
 *
 * Time:
 *   12-hour format
 */
export function formatShortDateTime(
  date:
    | string
    | Date
    | undefined
    | null
): string {
  if (!date) {
    return 'N/A';
  }

  /*
   * For a plain calendar date, do not construct
   * a UTC timestamp. Keep it as a calendar date.
   */
  if (
    typeof date ===
      'string' &&
    (
      /^\d{4}-\d{2}-\d{2}$/.test(
        date
      ) ||
      /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(
        date
      )
    )
  ) {
    return formatShortDate(
      date.split('T')[0]
    );
  }

  const d =
    new Date(date);

  if (
    isNaN(
      d.getTime()
    )
  ) {
    return 'Invalid Date';
  }

  const dateStr =
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone:
          'Asia/Manila',
        month:
          '2-digit',
        day:
          '2-digit',
        year:
          'numeric',
      }
    ).format(d);

  const timeStr =
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone:
          'Asia/Manila',
        hour:
          '2-digit',
        minute:
          '2-digit',
        hour12:
          true,
      }
    ).format(d);

  return `${dateStr} ${timeStr}`;
}

/**
 * Format date for HTML date inputs.
 *
 * This intentionally remains:
 *
 * YYYY-MM-DD
 *
 * because <input type="date"> requires
 * this internal value format.
 */
export function formatDateInput(
  date:
    | string
    | Date
    | undefined
    | null
): string {
  if (!date) {
    return '';
  }

  if (
    typeof date ===
      'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(
      date
    )
  ) {
    return date;
  }

  const d =
    parseDate(
      date
    );

  if (
    isNaN(
      d.getTime()
    )
  ) {
    return '';
  }

  const y =
    d.getFullYear();

  const m =
    String(
      d.getMonth() + 1
    ).padStart(
      2,
      '0'
    );

  const day =
    String(
      d.getDate()
    ).padStart(
      2,
      '0'
    );

  return `${y}-${m}-${day}`;
}

/**
 * Get current date in Philippines timezone.
 *
 * Returns:
 *   YYYY-MM-DD
 *
 * This remains YYYY-MM-DD because it is
 * primarily used as a database/input value.
 */
export function getCurrentPHDate(): string {
  const parts =
    new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone:
          'Asia/Manila',
        year:
          'numeric',
        month:
          '2-digit',
        day:
          '2-digit',
      }
    ).formatToParts(
      new Date()
    );

  const year =
    parts.find(
      (part) =>
        part.type ===
        'year'
    )?.value || '';

  const month =
    parts.find(
      (part) =>
        part.type ===
        'month'
    )?.value || '';

  const day =
    parts.find(
      (part) =>
        part.type ===
        'day'
    )?.value || '';

  return `${year}-${month}-${day}`;
}

/**
 * Get the current moment in the Philippines, shaped for a `datetime-local`.
 *
 * Returns:
 *   YYYY-MM-DDTHH:MM
 *
 * The counterpart to `getCurrentPHDate()` for the controls that take a time as
 * well as a day. `new Date().toISOString().slice(0, 16)` is the wrong tool for
 * that: `toISOString()` is UTC, so seeding an incident time from it put the
 * default eight hours early — a form opened at 2:40 PM offered 6:40 AM. The
 * control reads its value as wall-clock, so the value has to be built from
 * Manila's wall-clock, not from an instant.
 *
 * `hour12: false` matters — `en-CA` with the default 12-hour cycle renders
 * "02:40 p.m.", which a `datetime-local` rejects as an empty value.
 */
export function getCurrentPHDateTime(): string {
  const parts =
    new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone:
          'Asia/Manila',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }
    ).formatToParts(
      new Date()
    );

  const pick = (
    type: string
  ) =>
    parts.find(
      (part) =>
        part.type ===
        type
    )?.value || '';

  // `hourCycle` is not pinned, and some engines report midnight as "24" for
  // `hour12: false`; a `datetime-local` accepts 00–23 only.
  const hour =
    pick('hour') === '24'
      ? '00'
      : pick('hour');

  return (
    `${pick('year')}-${pick('month')}-${pick('day')}` +
    `T${hour}:${pick('minute')}`
  );
}

/**
 * Is a DATE-only value (`YYYY-MM-DD`) today or later?
 *
 * A hearing date, an admission date or any other value that came from an
 * `<input type="date">` is a *calendar day*, not an instant. `new Date('2026-09-24')`
 * parses as UTC midnight, which in Manila is 08:00 on the 24th — so comparing it
 * against `new Date()` silently drops everything scheduled for *today* from the
 * moment the clock passes 8am. A "Scheduled Today" list built that way is empty
 * for the whole working day, which is exactly when it matters.
 *
 * The comparison therefore has to be on the calendar day, and for `YYYY-MM-DD`
 * strings that is a plain string comparison: the format is zero-padded and
 * big-endian, so lexicographic order is chronological order. Nothing is parsed
 * as a `Date`, so there is no timezone to get wrong.
 *
 * A missing or malformed value is not "today or later" — it is not a date at
 * all, and counting it would overstate the list.
 */
export function isTodayOrLater(value?: string | null): boolean {
  const day = String(value ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day >= getCurrentPHDate();
}