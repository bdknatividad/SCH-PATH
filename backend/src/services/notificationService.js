/**
 * Notification service — the single place that writes notifications and the
 * single place that decides who may read one.
 *
 * ## Why this exists
 *
 * Before this, every caller hand-rolled its own `INSERT INTO alerts (...)`, and
 * the read paths each invented their own filter. The result was that the
 * notification feed was not scoped at all (`GET /store` returned the whole
 * `alerts` table to every authenticated user), read state was a single flag on
 * the row so one recipient marking an alert read marked it read for everybody
 * sharing that role, and half the workflow never produced a notification.
 *
 * ## The visibility rule
 *
 * An alert is visible to a user when:
 *
 *   1. it names them (`targetUserId`), or
 *   2. it names their role (`targetRole`) and has no specific addressee, and
 *      the resident it concerns is in their caseload, or is not resident-bound.
 *
 * …and it is **not** visible to the person who caused it. That last clause is
 * how "don't notify yourself" is enforced centrally: a Social Worker who
 * submits a document does not get the "document submitted" alert addressed to
 * the Social Worker role, without the caller having to special-case it.
 *
 * An alert with neither `targetUserId` nor `targetRole` is visible to nobody.
 * Those rows are malformed — an event with no addressee — and showing them to
 * everyone is exactly the leak this module removes. (The 13 legacy
 * "Access Request Decision" rows in the live database are of this shape; see
 * the audit notes.)
 *
 * ## Read state
 *
 * Read state belongs to (alert, user), not to the alert, and lives in
 * `alertReads`. `alerts.isRead/readBy/readAt` are still written for alerts that
 * have exactly one possible recipient, so existing exports do not break, but
 * they are never consulted to decide what a user has read.
 */

const { pool } = require('../config/database');
const { insertWithGeneratedId } = require('../utils/helpers');
const { normalizeRole } = require('../utils/authorization');
const { loadResidentScope, residentInScope } = require('../utils/residentScope');
const alertStream = require('./alertStream');

/** Roles with facility-wide supervisory visibility. */
const MANAGER_ROLES = ['centerhead', 'admin'];

/**
 * The columns a client needs, with read state resolved for one user.
 *
 * `isRead`/`readBy`/`readAt` are computed, never read off `alerts` — that is
 * what makes read state per-user.
 */
const ALERT_SELECT = `
  a.id, a.residentId, a.type, a.title, a.message, a.priority,
  a.actionRequired, a.actionTaken, a.relatedRecordType, a.relatedRecordId,
  a.targetRole, a.targetUserId, a.actorUsername, a.dedupeKey,
  a.createdAt, a.updatedAt,
  CASE WHEN r.userId IS NULL THEN 0 ELSE 1 END AS isRead,
  CASE WHEN r.userId IS NULL THEN NULL ELSE ? END AS readBy,
  r.readAt AS readAt`;

/**
 * The WHERE clause implementing the visibility rule above.
 *
 * @param {Object} user
 * @param {string[]|null} allowedResidentIds null = role is not caseload-scoped
 * @returns {{ where: string, params: unknown[] }}
 */
function visibilityClause(user, allowedResidentIds) {
  const params = [String(user?.id || ''), normalizeRole(user?.role), String(user?.username || '')];

  // The caseload filter applies ONLY to a role-addressed notification.
  //
  // It exists to stop "all Houseparents" leaking one child's affairs to a
  // Houseparent who does not have that child. An alert addressed to a specific
  // account is different: the recipient was chosen deliberately at write time,
  // and re-filtering it later breaks the one case where it matters most —
  // "you have been unassigned from CH005" is addressed to the Houseparent who no
  // longer has CH005, so a caseload filter would hide the very notification
  // telling them their access ended.
  //
  // Rows with no residentId are facility-wide and stay visible either way.
  let residentFilter = '';
  if (Array.isArray(allowedResidentIds)) {
    if (allowedResidentIds.length === 0) {
      residentFilter = ' AND a.residentId IS NULL';
    } else {
      residentFilter = ` AND (a.residentId IS NULL OR a.residentId IN (${allowedResidentIds.map(() => '?').join(', ')}))`;
      params.push(...allowedResidentIds);
    }
  }

  const where = `
    (
      a.targetUserId = ?
      OR (
        a.targetUserId IS NULL
        AND a.targetRole IS NOT NULL
        AND LOWER(a.targetRole) = ?
        ${residentFilter}
      )
    )
    AND (a.actorUsername IS NULL OR LOWER(a.actorUsername) <> LOWER(?))`;

  return { where, params };
}

/**
 * Normalise a row for the API.
 *
 * `isRead` comes out of SQL as 0/1, but the frontend's `Alert` type declares a
 * boolean and compares it with `===` in places. Returning the raw integer made
 * "read" and "unread" depend on which endpoint you asked.
 */
function shapeAlert(row) {
  if (!row) return row;
  return { ...row, isRead: Boolean(row.isRead) };
}

/**
 * Parameters for the `alertReads` join, in order.
 *
 * `ALERT_SELECT` contains TWO placeholders (the join key and the `readBy` case),
 * so any query that uses the full select list needs `selectParams`; a query that
 * only joins needs `joinParams`. Passing the wrong one silently shifts every
 * following parameter — which is exactly how the unread count once came back 0
 * for a user with nine unread notifications.
 *
 * ORDER MATTERS, and it is the opposite of what the names suggest: `?` is
 * numbered by position in the SQL text, and the SELECT list is written before
 * the FROM. So the `readBy` case in ALERT_SELECT takes the *first* parameter and
 * the join takes the *second*. Returning [id, username] here made the join look
 * for a user literally named "centerhead", which matched nothing — every
 * notification came back unread to every user while the (correct) unread count
 * said otherwise.
 */
const joinParams = (user) => [String(user?.id || '')];
const selectParams = (user) => [String(user?.username || ''), String(user?.id || '')];

/**
 * Write one notification.
 *
 * @param {Object} event
 * @param {string} event.type             short category shown in the UI
 * @param {string} event.title            headline
 * @param {string} event.message          one sentence explaining what happened
 * @param {'Low'|'Medium'|'High'|'Urgent'} [event.priority]
 * @param {string} [event.actionRequired] what the recipient is expected to do
 * @param {string|null} [event.residentId]
 * @param {string} [event.relatedRecordType] destination hint for the UI
 * @param {string} [event.relatedRecordId]
 * @param {string} [event.targetRole]     address a role
 * @param {string} [event.targetUserId]   address one account
 * @param {string} [event.actorUsername]  who caused it (never notified)
 * @param {string} [event.dedupeKey]      one business event = one row
 * @returns {Promise<string|null>} the new id, or null when it was a duplicate
 */
async function notify(event, executor = pool) {
  const {
    type, title, message, priority = 'Medium', actionRequired = null,
    residentId = null, relatedRecordType = null, relatedRecordId = null,
    targetRole = null, targetUserId = null, actorUsername = null, dedupeKey = null,
  } = event || {};

  if (!type || !title || !message) {
    throw new Error('notify() requires type, title and message');
  }
  if (!targetRole && !targetUserId) {
    throw new Error(`notify() called for "${type}" with no addressee — a notification nobody can read is a bug`);
  }

  try {
    const id = await insertWithGeneratedId(executor, {
      table: 'alerts',
      prefix: 'ALR',
      insert: (id) => executor.query(
        `INSERT INTO alerts
           (id, residentId, type, title, message, priority, actionRequired,
            relatedRecordType, relatedRecordId, targetRole, targetUserId,
            actorUsername, dedupeKey)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, residentId, type, title, message, priority, actionRequired,
          relatedRecordType, relatedRecordId,
          targetRole ? normalizeRole(targetRole) : null, targetUserId,
          actorUsername, dedupeKey]
      ),
    });

    // Wake the addressee's open stream so the feed updates now rather than at the
    // next poll. This runs only after a row was actually written: a suppressed
    // duplicate (the `ER_DUP_ENTRY` branch below) is not news, and signalling it
    // would make every re-open of a page look like an event.
    //
    // The frame is a bare signal — the client re-reads `GET /api/alerts`, which
    // owns the visibility rule. See `services/alertStream.js` for why the body is
    // deliberately not sent.
    alertStream.publish({ targetUserId, targetRole: targetRole ? normalizeRole(targetRole) : null });

    return id;
  } catch (error) {
    // A repeated business event. The unique index on dedupeKey is what makes
    // "refreshing the page must not create a second notification" true even
    // when two requests race.
    if (error.code === 'ER_DUP_ENTRY' && dedupeKey) return null;
    throw error;
  }
}

/**
 * Write the same event to several specific accounts.
 *
 * Used where the recipient is a set of people rather than a job title — the
 * Houseparents assigned to a child, or the reviewers who can actually act on a
 * document. Each recipient gets their own row so that read state, deletion and
 * targeting are per-person, and each row gets its own dedupe key.
 */
async function notifyUsers(userIds, event, executor = pool) {
  const unique = [...new Set((userIds || []).filter(Boolean).map(String))];
  const ids = [];
  for (const userId of unique) {
    const id = await notify(
      { ...event, targetUserId: userId, dedupeKey: event.dedupeKey ? `${event.dedupeKey}:${userId}` : null },
      executor
    );
    if (id) ids.push(id);
  }
  return ids;
}

/** Accounts holding a role. Used to address a role's members individually. */
async function usersWithRole(role, executor = pool) {
  const [rows] = await executor.query(
    `SELECT id, username, role FROM users
     WHERE LOWER(role) = LOWER(?) AND (status IS NULL OR status = 'Active')`,
    [normalizeRole(role)]
  );
  return rows;
}

/** Accounts holding any of the given roles. */
async function usersWithAnyRole(roles, executor = pool) {
  const list = (roles || []).map((r) => normalizeRole(r));
  if (list.length === 0) return [];
  const [rows] = await executor.query(
    `SELECT id, username, role FROM users
     WHERE LOWER(role) IN (${list.map(() => '?').join(', ')})
       AND (status IS NULL OR status = 'Active')`,
    list
  );
  return rows;
}

/**
 * Resolve an account id from a username.
 *
 * Records in this system store the actor's *username* (`uploadedBy`,
 * `submittedBy`, `createdBy`), but a notification has to be addressed to a
 * *user id* to reach exactly one person. This is the bridge, and it is
 * case-insensitive because the stored usernames are not normalised.
 */
async function userIdForUsername(username, executor = pool) {
  const name = String(username || '').trim();
  if (!name) return null;
  const [rows] = await executor.query(
    `SELECT id FROM users
     WHERE LOWER(username) = LOWER(?) AND (status IS NULL OR status = 'Active')
     LIMIT 1`,
    [name]
  );
  return rows[0]?.id || null;
}

/** The active Houseparents assigned to a resident. */
async function houseparentsOf(residentId, executor = pool) {
  if (!residentId) return [];
  const [rows] = await executor.query(
    `SELECT DISTINCT u.id, u.username, u.role
     FROM residentAssignments ra
     JOIN users u ON u.id = ra.userId
     WHERE ra.residentId = ?
       AND ra.status = 'Active'
       AND LOWER(ra.assignmentType) = 'houseparent'
       AND (u.status IS NULL OR u.status = 'Active')`,
    [residentId]
  );
  return rows;
}

/** A resident's display name, for message text. */
async function residentName(residentId, executor = pool) {
  if (!residentId) return null;
  const [rows] = await executor.query('SELECT name FROM children WHERE id = ?', [residentId]);
  return rows[0]?.name || residentId;
}

/** Does this resident exist at all? Used before answering a resident-scoped read. */
async function residentExists(residentId, executor = pool) {
  if (!residentId) return false;
  const [rows] = await executor.query('SELECT id FROM children WHERE id = ?', [residentId]);
  return rows.length > 0;
}

// ── Reading ────────────────────────────────────────────────────────────────

/** Notifications visible to this user, newest first. */
async function listFor(user, { limit = null, unreadOnly = false } = {}) {
  const scope = await loadResidentScope(user);
  const { where, params } = visibilityClause(user, scope);
  const readFilter = unreadOnly ? 'AND r.userId IS NULL' : '';
  const limitSql = limit ? `LIMIT ${Number(limit)}` : '';

  const [rows] = await pool.query(
    `SELECT ${ALERT_SELECT}
     FROM alerts a
     LEFT JOIN alertReads r ON r.alertId = a.id AND r.userId = ?
     WHERE ${where} ${readFilter}
     ORDER BY a.createdAt DESC
     ${limitSql}`,
    [...selectParams(user), ...params]
  );
  return rows.map(shapeAlert);
}

/** How many visible notifications this user has not read. */
async function unreadCountFor(user) {
  const scope = await loadResidentScope(user);
  const { where, params } = visibilityClause(user, scope);
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM alerts a
     LEFT JOIN alertReads r ON r.alertId = a.id AND r.userId = ?
     WHERE ${where} AND r.userId IS NULL`,
    [...joinParams(user), ...params]
  );
  return Number(rows[0]?.count || 0);
}

/**
 * Load one alert if — and only if — it is visible to this user.
 * Returns null rather than throwing so callers can answer 404 uniformly: a 403
 * would confirm that the alert exists.
 */
async function findVisible(id, user) {
  const scope = await loadResidentScope(user);
  const { where, params } = visibilityClause(user, scope);
  const [rows] = await pool.query(
    `SELECT ${ALERT_SELECT}
     FROM alerts a
     LEFT JOIN alertReads r ON r.alertId = a.id AND r.userId = ?
     WHERE a.id = ? AND ${where}`,
    [...selectParams(user), id, ...params]
  );
  return rows[0] ? shapeAlert(rows[0]) : null;
}

/**
 * Mark one alert read for this user.
 * Returns false when the alert is not visible to them.
 */
async function markRead(id, user) {
  const alert = await findVisible(id, user);
  if (!alert) return false;

  await pool.query(
    'INSERT INTO alertReads (alertId, userId, readAt) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE readAt = readAt',
    [id, user.id]
  );

  // Keep the legacy row-level columns accurate for alerts that have exactly one
  // possible reader. For a role-addressed alert they cannot represent the truth,
  // so they are left alone rather than showing one person's read state to all.
  if (alert.targetUserId && String(alert.targetUserId) === String(user.id)) {
    await pool.query(
      'UPDATE alerts SET isRead = ?, readBy = ?, readAt = NOW() WHERE id = ?',
      [true, user.username || 'System', id]
    );
  }

  return true;
}

/** Mark every visible unread alert read for this user. Returns how many. */
async function markAllRead(user) {
  const scope = await loadResidentScope(user);
  const { where, params } = visibilityClause(user, scope);

  const [result] = await pool.query(
    `INSERT INTO alertReads (alertId, userId, readAt)
     SELECT a.id, ?, NOW()
     FROM alerts a
     LEFT JOIN alertReads r ON r.alertId = a.id AND r.userId = ?
     WHERE ${where} AND r.userId IS NULL`,
    [String(user.id || ''), String(user.id || ''), ...params]
  );

  return Number(result.affectedRows || 0);
}

/**
 * Mark every alert about one business record read — for one user only.
 *
 * Used when the reviewer acts on the record itself (approving a document,
 * verifying a violation): the alert that asked them to do it is finished and
 * should stop counting as unread *for them*.
 *
 * It is deliberately per-user. The old code ran
 * `UPDATE alerts SET isRead = TRUE ... WHERE relatedRecordId = ?`, flipping the
 * single shared flag, so one reviewer acting cleared the alert out of every
 * other reviewer's list — and, because the flag was never keyed to a person,
 * it also cleared it for people who had never opened it.
 *
 * Matching is case-insensitive because the existing rows are inconsistent
 * ('documents', 'violation' lowercase vs 'Anecdotal Report' title case).
 */
async function markRelatedRead(user, relatedRecordType, relatedRecordId, executor = pool) {
  if (!user?.id || !relatedRecordType || !relatedRecordId) return 0;

  const scope = await loadResidentScope(user, executor);
  const { where, params } = visibilityClause(user, scope);

  const [result] = await executor.query(
    `INSERT INTO alertReads (alertId, userId, readAt)
     SELECT a.id, ?, NOW()
     FROM alerts a
     LEFT JOIN alertReads r ON r.alertId = a.id AND r.userId = ?
     WHERE LOWER(a.relatedRecordType) = LOWER(?)
       AND a.relatedRecordId = ?
       AND ${where}
       AND r.userId IS NULL`,
    [String(user.id), String(user.id), relatedRecordType, relatedRecordId, ...params]
  );

  // Same legacy sync rule as markRead(): only for alerts with exactly one
  // possible reader, so we never publish one person's read state to a role.
  await executor.query(
    `UPDATE alerts SET isRead = TRUE, readBy = ?, readAt = NOW()
     WHERE LOWER(relatedRecordType) = LOWER(?) AND relatedRecordId = ?
       AND targetUserId = ? AND isRead = FALSE`,
    [user.username || 'System', relatedRecordType, relatedRecordId, String(user.id)]
  );

  return Number(result.affectedRows || 0);
}

/**
 * Read one alert back by id, with **no visibility check**.
 *
 * Only for the write path: a request that has just created or amended a row
 * needs to echo it back, and the caller may legitimately be unable to *read*
 * their own notification (an alert is hidden from the person who caused it, and
 * a Center Head announcing something is the actor of their own announcement).
 *
 * Never use this to serve a user-supplied id — that is `findVisible`.
 */
async function findAny(id, executor = pool) {
  const [rows] = await executor.query(
    `SELECT ${ALERT_SELECT}
     FROM alerts a
     LEFT JOIN alertReads r ON r.alertId = a.id AND r.userId = ?
     WHERE a.id = ?`,
    [...selectParams({ id: null, username: null }), String(id)]
  );
  return rows[0] ? shapeAlert(rows[0]) : null;
}

/**
 * Record what someone did about a notification.
 *
 * The only mutable field. Everything else about an alert is a statement of
 * fact that happened at a point in time.
 */
async function setActionTaken(id, actionTaken) {
  await pool.query('UPDATE alerts SET actionTaken = ? WHERE id = ?', [actionTaken, id]);
}

/** Delete one alert, if it is visible to this user. */
async function remove(id, user) {
  const alert = await findVisible(id, user);
  if (!alert) return false;

  await pool.query('DELETE FROM alertReads WHERE alertId = ?', [id]);
  await pool.query('DELETE FROM alerts WHERE id = ?', [id]);
  return true;
}

module.exports = {
  MANAGER_ROLES,
  notify,
  notifyUsers,
  usersWithRole,
  usersWithAnyRole,
  userIdForUsername,
  houseparentsOf,
  residentName,
  residentExists,
  visibilityClause,
  ALERT_SELECT,
  joinParams,
  selectParams,
  listFor,
  unreadCountFor,
  findVisible,
  findAny,
  markRead,
  markAllRead,
  markRelatedRead,
  setActionTaken,
  remove,
  // Re-exported so notification callers do not each import two modules.
  loadResidentScope,
  residentInScope,
};
