/**
 * TRI deadline reminders.
 *
 * A TRI for a calendar month is due on that month's last Monday (see
 * utils/triPeriod.js). Until now nothing told anyone: the deadline was stored on
 * every record and shown on the form, but a Houseparent had to remember it, and a
 * month could pass with no TRI at all and no prompt anywhere.
 *
 * Two states are reported, and only these two:
 *   - `due`     — inside the reminder window, not yet submitted
 *   - `overdue` — past the deadline, not yet submitted
 *
 * "Not yet submitted" means there is no record for the period, or the record is
 * still Draft or Returned. A Submitted or Finalized record clears it — a record
 * sitting with a reviewer is not the Houseparent's outstanding work.
 *
 * Each (resident, period, state) is notified once. The dedupe key carries the
 * state, so the same period can produce one `due` and later one `overdue` notice,
 * but a daily check cannot nag. Re-sending would need a deliberate change here.
 */

const { pool } = require('../config/database');
const notifications = require('./notificationService');
const { lastMonday, periodLabel, daysBetween, manilaToday } = require('../utils/triPeriod');

/** How many days before the deadline the reminder goes out. */
const REMINDER_WINDOW_DAYS = 3;

/**
 * Active residents with no Submitted/Finalized TRI for the given period.
 * Returns the residents only — recipients are resolved per resident, because the
 * person responsible is an assignment, not a role.
 */
async function outstandingForPeriod(year, month, executor = pool) {
  const [rows] = await executor.query(
    `SELECT c.id AS residentId, c.name AS residentName
       FROM children c
      WHERE c.status = 'Active'
        AND NOT EXISTS (
          SELECT 1 FROM triRecords t
           WHERE t.residentId = c.id
             AND t.reportingYear = ? AND t.reportingMonth = ?
             AND t.status IN ('Submitted', 'Finalized')
        )
      ORDER BY c.id`,
    [year, month]
  );
  return rows;
}

/**
 * Which reminder, if any, a period is owed on a given day.
 * Pure, so the boundary behaviour can be tested without a database or a clock.
 */
function deadlineState(today, deadline, windowDays = REMINDER_WINDOW_DAYS) {
  const daysLeft = daysBetween(today, deadline);
  if (daysLeft === null) return null;
  if (daysLeft < 0) return { state: 'overdue', daysLeft };
  if (daysLeft <= windowDays) return { state: 'due', daysLeft };
  return null;
}

/**
 * Send the reminders owed for one reporting period.
 *
 * Returns a summary rather than throwing, because this runs unattended: one
 * resident with no assigned Houseparent must not stop the rest of the run.
 */
async function runTriDeadlineReminders({ today, year, month, windowDays = REMINDER_WINDOW_DAYS, executor = pool } = {}) {
  const day = today || manilaToday();
  const [y, m] = day.split('-').map(Number);
  const reportYear = year || y;
  const reportMonth = month || m;
  const deadline = lastMonday(reportYear, reportMonth);

  const verdict = deadlineState(day, deadline, windowDays);
  const result = {
    date: day, period: `${reportYear}-${String(reportMonth).padStart(2, '0')}`,
    deadline, state: verdict ? verdict.state : null, daysLeft: verdict ? verdict.daysLeft : null,
    outstanding: 0, notified: 0, unassigned: [], skipped: 0,
  };
  if (!verdict) return result;

  const outstanding = await outstandingForPeriod(reportYear, reportMonth, executor);
  result.outstanding = outstanding.length;

  const period = periodLabel(reportYear, reportMonth);
  const overdue = verdict.state === 'overdue';

  for (const resident of outstanding) {
    const houseparents = await notifications.houseparentsOf(resident.residentId, executor);
    if (houseparents.length === 0) {
      // Nobody is assigned, so there is nobody to remind. Reported rather than
      // silently dropped — an unassigned resident is a separate problem.
      result.unassigned.push(resident.residentId);
      continue;
    }
    const message = overdue
      ? `${resident.residentName} — the TRI for ${period} was due ${deadline} and has not been submitted.`
      : `${resident.residentName} — the TRI for ${period} is due ${deadline} (${verdict.daysLeft === 0 ? 'today' : `${verdict.daysLeft} day${verdict.daysLeft === 1 ? '' : 's'} left`}).`;

    const ids = await notifications.notifyUsers(houseparents.map((hp) => hp.id), {
      type: overdue ? 'TRI Overdue' : 'TRI Due',
      title: overdue ? 'TRI overdue' : 'TRI due soon',
      message,
      priority: overdue ? 'High' : 'Medium',
      actionRequired: 'Submit the TRI',
      residentId: resident.residentId,
      relatedRecordType: 'tri',
      relatedRecordId: `${resident.residentId}:${reportYear}-${String(reportMonth).padStart(2, '0')}`,
      dedupeKey: `tri:${resident.residentId}:${reportYear}-${reportMonth}:${verdict.state}`,
    }, executor);
    if (ids.length) result.notified += 1;
    else result.skipped += 1;   // already reminded for this period+state
  }

  return result;
}

module.exports = {
  REMINDER_WINDOW_DAYS,
  outstandingForPeriod,
  deadlineState,
  runTriDeadlineReminders,
};
