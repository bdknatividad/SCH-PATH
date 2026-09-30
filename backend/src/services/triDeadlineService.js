/**
 * TRI and Anecdotal Report deadline reminders.
 *
 * A TRI and an Anecdotal Report for a calendar month are both due on that month's
 * last Monday (see utils/triPeriod.js). Until now nothing told anyone: the deadline
 * was stored on every record and shown on the form, but a Houseparent had to
 * remember it, and a month could pass with no TRI at all and no prompt anywhere.
 *
 * The Anecdotal Report carries the same obligation on the same day and had no
 * reminder at all — the TRI pass shipped on its own. Both are chased here, from
 * one list, so a second report cannot be forgotten the same way again. (The module
 * and the entry point keep their TRI names for their callers; what they do now is
 * the monthly reports.)
 *
 * Two states are reported, and only these two:
 *   - `due`     — inside the reminder window, not yet submitted
 *   - `overdue` — past the deadline, not yet submitted
 *
 * "Not yet submitted" means there is no record for the period, or the record is
 * still Draft or Returned. A Submitted or Finalized record clears it — a record
 * sitting with a reviewer is not the Houseparent's outstanding work.
 *
 * Each (report, resident, period, state) is notified once. The dedupe key carries
 * the report, the period and the state, so the same period can produce one `due`
 * and later one `overdue` notice, but a daily check cannot nag. Re-sending would
 * need a deliberate change here.
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
 * Active residents with no Anecdotal Report for the given period.
 *
 * The same shape as the TRI check, with one difference that is the schema's, not
 * a decision: the anecdotal table has an extra `Under Review` status between
 * Submitted and Finalized, so a report a reviewer has opened clears the
 * obligation here as well. In both cases the test is the same — has this stopped
 * being the Houseparent's work?
 */
async function outstandingAnecdotalForPeriod(year, month, executor = pool) {
  const [rows] = await executor.query(
    `SELECT c.id AS residentId, c.name AS residentName
       FROM children c
      WHERE c.status = 'Active'
        AND NOT EXISTS (
          SELECT 1 FROM anecdotalReports a
           WHERE a.residentId = c.id
             AND a.reportYear = ? AND a.reportMonth = ?
             AND a.status IN ('Submitted', 'Under Review', 'Finalized')
        )
      ORDER BY c.id`,
    [year, month]
  );
  return rows;
}

/**
 * The monthly reports a Houseparent owes, and how each one is found and chased.
 *
 * Listed together because they share everything else: the deadline, the
 * recipients, the states and the dedupe shape. `relatedRecordType` is what the
 * notification router switches on, so each notice opens the module that holds
 * the work — `tri` for the TRI form, `anecdotal report` for the Anecdotal tab.
 */
const MONTHLY_REPORTS = [
  {
    key: 'tri',
    label: 'TRI',
    relatedRecordType: 'tri',
    noticeType: { due: 'TRI Due', overdue: 'TRI Overdue' },
    title: { due: 'TRI due soon', overdue: 'TRI overdue' },
    action: 'Submit the TRI',
    outstanding: outstandingForPeriod,
  },
  {
    key: 'anecdotal',
    label: 'Anecdotal Report',
    // `houseparent` rather than `anecdotal report`: this notice only ever reaches
    // the Houseparent who owes the report, and `anecdotal report` is the
    // *reviewer's* destination — the Social Worker's Needs Review queue, which a
    // Houseparent cannot open. The router sends them to their own Anecdotal tab.
    relatedRecordType: 'houseparent',
    noticeType: { due: 'Anecdotal Report Due', overdue: 'Anecdotal Report Overdue' },
    title: { due: 'Anecdotal Report due soon', overdue: 'Anecdotal Report overdue' },
    action: 'Submit the Anecdotal Report',
    outstanding: outstandingAnecdotalForPeriod,
  },
];

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
 * Send the reminders owed for one report in one period.
 *
 * Returns a summary rather than throwing, because this runs unattended: one
 * resident with no assigned Houseparent must not stop the rest of the run.
 */
async function remindForReport(kind, { reportYear, reportMonth, deadline, verdict, period, executor }) {
  const result = { outstanding: 0, notified: 0, unassigned: [], skipped: 0 };

  const outstanding = await kind.outstanding(reportYear, reportMonth, executor);
  result.outstanding = outstanding.length;

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
      ? `${resident.residentName} — the ${kind.label} for ${period} was due ${deadline} and has not been submitted.`
      : `${resident.residentName} — the ${kind.label} for ${period} is due ${deadline} (${verdict.daysLeft === 0 ? 'today' : `${verdict.daysLeft} day${verdict.daysLeft === 1 ? '' : 's'} left`}).`;

    const ids = await notifications.notifyUsers(houseparents.map((hp) => hp.id), {
      type: overdue ? kind.noticeType.overdue : kind.noticeType.due,
      title: overdue ? kind.title.overdue : kind.title.due,
      message,
      priority: overdue ? 'High' : 'Medium',
      actionRequired: kind.action,
      residentId: resident.residentId,
      relatedRecordType: kind.relatedRecordType,
      relatedRecordId: `${resident.residentId}:${reportYear}-${String(reportMonth).padStart(2, '0')}`,
      dedupeKey: `${kind.key}:${resident.residentId}:${reportYear}-${reportMonth}:${verdict.state}`,
    }, executor);
    if (ids.length) result.notified += 1;
    else result.skipped += 1;   // already reminded for this period+state
  }

  return result;
}

/**
 * Send the reminders owed for one reporting period, for every monthly report.
 *
 * Returns a summary rather than throwing, because this runs unattended.
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
    reports: [],
  };
  if (!verdict) return result;

  const period = periodLabel(reportYear, reportMonth);
  for (const kind of MONTHLY_REPORTS) {
    const summary = await remindForReport(kind, {
      reportYear, reportMonth, deadline, verdict, period, executor,
    });
    result.reports.push({ key: kind.key, label: kind.label, ...summary });
  }

  return result;
}

module.exports = {
  REMINDER_WINDOW_DAYS,
  MONTHLY_REPORTS,
  outstandingForPeriod,
  outstandingAnecdotalForPeriod,
  deadlineState,
  runTriDeadlineReminders,
};
