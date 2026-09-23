/**
 * TRI reporting-period arithmetic.
 *
 * These four helpers started life inside triController.js. They moved here because
 * the deadline reminder needs the same period maths, and a second copy of
 * `lastMonday` would be a third place for the reporting calendar to drift — the
 * duplicated rating bands already demonstrated how that goes.
 *
 * The reporting period is a calendar month. A TRI for that month is due on its last
 * Monday and takes effect on the 1st of the following month.
 */

const TRI_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** The last Monday of a month, as YYYY-MM-DD. */
function lastMonday(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0));
  const day = lastDay.getUTCDay();
  const offset = (day + 6) % 7;
  lastDay.setUTCDate(lastDay.getUTCDate() - offset);
  return lastDay.toISOString().slice(0, 10);
}

/** The 1st of the month after the reporting month, as YYYY-MM-DD. */
function effectiveDate(year, month) {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
}

/** Human period label for a TRI, e.g. "September 2026". Used in notification text. */
function periodLabel(year, month) {
  const name = TRI_MONTH_NAMES[Number(month) - 1];
  return name ? `${name} ${year}` : `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Whole days from `today` to `date`, both YYYY-MM-DD. Positive means `date` is in
 * the future. Compared in UTC so a timezone offset cannot shift the result by a day.
 */
function daysBetween(today, date) {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Today's date in the facility's timezone, as YYYY-MM-DD.
 *
 * The scheduled checks run at 23:xx Asia/Manila. Deriving "today" from
 * `toISOString()` would give the UTC date, which is still the *previous* day for
 * the four hours between midnight and 04:00 Manila — enough to send a "due today"
 * reminder a day late or call something overdue that is not.
 */
function manilaToday(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

module.exports = { TRI_MONTH_NAMES, lastMonday, effectiveDate, periodLabel, daysBetween, manilaToday };
