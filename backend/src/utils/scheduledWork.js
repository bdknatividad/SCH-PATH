/**
 * Telling the schedule's audience about a row that just landed on it.
 *
 * Assessments and activities are both written by `baseController.create`, which
 * has no idea who should hear about a new record — and until this existed,
 * neither module notified anybody at all. The assessment a verified violation
 * raises has the same problem from the other direction: it is inserted straight
 * into the table, so no create path ever sees it.
 *
 * All three end up here, so the audience and the wording are defined once. The
 * audience itself lives in `notificationService.notifyScheduleAudience`.
 */

const notifications = require('../services/notificationService');

/**
 * The resident ids a row names, in either shape the data carries.
 *
 * The Activities module writes `selectedResidentIds` as bare ids; older rows and
 * the Assessments module carry `{ id, name }` objects. Reading only one shape
 * would quietly notify nobody for half the records.
 */
function asResidentIds(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => (entry && typeof entry === 'object' ? entry.id : entry))
    .map((id) => String(id || '').trim())
    .filter(Boolean);
}

/** Per-resource wording and the JSON columns that name residents. */
const SCHEDULE_RESOURCES = {
  assessments: {
    residentFields: ['forResidents'],
    label: 'Assessment',
    type: 'Assessment Scheduled',
    relatedRecordType: 'assessments',
    verb: 'scheduled',
  },
  activities: {
    // `participants` as well as `selectedResidentIds`: an activity built from the
    // violation recommendations writes the latter, one typed in by hand may only
    // fill the former, and either names residents who should be told.
    residentFields: ['selectedResidentIds', 'participants'],
    label: 'Activity',
    type: 'Activity Scheduled',
    relatedRecordType: 'activities',
    verb: 'scheduled',
  },
};

/** `YYYY-MM-DD` only. A `Date` or a locale string is left out rather than mangled. */
function dateOnly(value) {
  const text = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

/**
 * Announce a newly created assessment or activity.
 *
 * Never throws. The record is already written, and a failed alert must not turn
 * a successful save into an error the caller sees.
 */
async function notifyScheduleCreated({ resource, row, actor }) {
  const config = SCHEDULE_RESOURCES[resource];
  if (!config || !row?.id) return;

  const ids = [...new Set(config.residentFields.flatMap((field) => asResidentIds(row[field])))];

  try {
    const names = [];
    for (const id of ids.slice(0, 3)) {
      const name = await notifications.residentName(id);
      if (name) names.push(name);
    }
    const who = names.length
      ? names.join(', ') + (ids.length > names.length ? ` +${ids.length - names.length} more` : '')
      : 'the residents on their list';

    const title = String(row.title || config.label);
    const when = dateOnly(row.date);
    const actorLabel = actor?.fullName || actor?.username || 'Staff';

    await notifications.notifyScheduleAudience(
      {
        type: config.type,
        title: `New ${config.label.toLowerCase()} — ${title}`,
        message: `${actorLabel} ${config.verb} "${title}"${when ? ` on ${when}` : ''} for ${who}.`,
        priority: 'Medium',
        // A single-resident record scopes the alert to that resident; one naming
        // several leaves it unscoped rather than picking a winner.
        residentId: ids.length === 1 ? ids[0] : null,
        relatedRecordType: config.relatedRecordType,
        relatedRecordId: row.id,
        actorUsername: actor?.username || null,
        dedupeKey: `${resource}:${row.id}:scheduled`,
      },
      ids,
    );
  } catch (error) {
    console.error(`[Schedule] ${resource} notification failed (non-fatal):`, error.message);
  }
}

module.exports = { asResidentIds, notifyScheduleCreated };
