/**
 * Date Formatter Utilities
 * Formats dates for Philippines timezone (Asia/Manila)
 */

/**
 * Parse a date value safely — avoids timezone shift for YYYY-MM-DD strings
 */
function parseDate(date: string | Date): Date {
  if (date instanceof Date) return date;
  // If it's a plain date string (YYYY-MM-DD), parse as local noon to avoid TZ shift
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  // ISO string — strip time part first if present
  if (date.includes('T')) {
    const dateOnly = date.split('T')[0];
    const [y, m, d] = dateOnly.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  return new Date(date);
}

export function formatPHDate(date: string | Date | undefined): string {
  if (!date) return 'N/A';
  const d = parseDate(date);
  if (isNaN(d.getTime())) return 'Invalid Date';
  return d.toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Format date and time to Philippines local string
 * @param date - Date string or Date object
 * @returns Formatted date and time string
 */
export function formatPHDateTime(date: string | Date | undefined): string {
  if (!date) return 'N/A';
  
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'Invalid Date';
  
  return d.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format short date (MM/DD/YYYY)
 * @param date - Date string or Date object
 * @returns Formatted short date string
 */
export function formatShortDate(date: string | Date | undefined): string {
  if (!date) return 'N/A';
  const d = parseDate(date);
  if (isNaN(d.getTime())) return 'Invalid Date';
  return d.toLocaleDateString('en-PH', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * Format date with time (MM/DD/YYYY HH:MM)
 * @param date - Date string or Date object
 * @returns Formatted date and time string
 */
export function formatShortDateTime(date: string | Date | undefined): string {
  if (!date) return 'N/A';
  if (typeof date === 'string' && (/^\d{4}-\d{2}-\d{2}$/.test(date) || /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(date))) {
    return formatShortDate(date.split('T')[0]);
  }
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'Invalid Date';
  const dateStr = d.toLocaleDateString('en-PH', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const timeStr = d.toLocaleTimeString('en-PH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `${dateStr} ${timeStr}`;
}

/**
 * Format date to YYYY-MM-DD (for input fields)
 */
export function formatDateInput(date: string | Date | undefined): string {
  if (!date) return '';
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = parseDate(date as string | Date);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Get current date in Philippines timezone
 * @returns Date string in YYYY-MM-DD format
 */
export function getCurrentPHDate(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}
