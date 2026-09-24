/**
 * Alert Controller
 * @module controllers/alertController
 * @description Alert and notification endpoints.
 *
 * Every read path here delegates its authorisation to
 * `services/notificationService`, so there is exactly one definition of "may
 * this user see this notification". Before, each endpoint had its own filter
 * and three of them had none at all.
 *
 * Not-found and not-visible are deliberately the same answer (404) so an
 * endpoint cannot be used to probe whether another user's notification exists.
 */

const { ApiError } = require('../middleware/errorHandler');
const { hasRole, isSupportedRole } = require('../utils/authorization');
const { ROLE_KEYS } = require('../config/rbac');
const { loadResidentScope, residentInScope } = require('../utils/residentScope');
const notifications = require('../services/notificationService');

/** How many notifications the panel shows by default. */
const DEFAULT_LIMIT = 50;

async function getAll(req, res, next) {
  try {
    const requested = req.query.limit ? Number(req.query.limit) : DEFAULT_LIMIT;
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 200) : DEFAULT_LIMIT;

    const data = await notifications.listFor(req.user, {
      limit,
      unreadOnly: req.query.unread === 'true',
    });

    res.json({ success: true, data, count: data.length });
  } catch (error) {
    next(error);
  }
}

async function getById(req, res, next) {
  try {
    const alert = await notifications.findVisible(req.params.id, req.user);
    if (!alert) throw new ApiError(404, 'Alert not found');
    res.json({ success: true, data: alert });
  } catch (error) {
    next(error);
  }
}

/**
 * Mark alert as read.
 *
 * Read state is recorded per user, so one recipient marking a role-addressed
 * alert read no longer marks it read for everyone else in that role.
 */
async function markAsRead(req, res, next) {
  try {
    const ok = await notifications.markRead(req.params.id, req.user);
    if (!ok) throw new ApiError(404, 'Alert not found');

    const alert = await notifications.findVisible(req.params.id, req.user);
    res.json({ success: true, message: 'Alert marked as read', data: alert });
  } catch (error) {
    next(error);
  }
}

/** Mark every visible unread alert read for the caller. */
async function markAllAsRead(req, res, next) {
  try {
    const count = await notifications.markAllRead(req.user);
    res.json({ success: true, message: `${count} alert(s) marked as read`, count });
  } catch (error) {
    next(error);
  }
}

async function getUnreadCount(req, res, next) {
  try {
    const count = await notifications.unreadCountFor(req.user);
    res.json({ success: true, count });
  } catch (error) {
    next(error);
  }
}

/**
 * Alerts for one resident.
 *
 * Scoped twice: the alerts must be addressed to the caller, and the resident
 * must be in their caseload. Previously this returned every alert for any
 * resident id a caller cared to guess.
 */
async function getByResident(req, res, next) {
  try {
    const { residentId } = req.params;

    if (!(await notifications.residentExists(residentId))) {
      throw new ApiError(404, 'Resident not found');
    }

    const allowedResidentIds = await loadResidentScope(req.user);
    if (!residentInScope({ residentId }, allowedResidentIds)) {
      // Reported as missing, not forbidden: a 403 would confirm the child exists.
      throw new ApiError(404, 'Resident not found');
    }

    const rows = await notifications.listFor(req.user);
    const data = rows.filter((row) => row.residentId === residentId);

    res.json({ success: true, data, count: data.length });
  } catch (error) {
    next(error);
  }
}

/** Unread high-priority alerts the caller can act on. */
async function getUrgent(req, res, next) {
  try {
    const rows = await notifications.listFor(req.user, { unreadOnly: true });
    const data = rows.filter((row) => ['Urgent', 'High'].includes(row.priority)).slice(0, 10);

    res.json({ success: true, data, count: data.length });
  } catch (error) {
    next(error);
  }
}

/**
 * Create an alert by hand.
 *
 * Restricted to supervisors. It was open to every authenticated account, so any
 * user could forge a notification into any role's feed.
 */
async function create(req, res, next) {
  try {
    if (!hasRole(req.user, 'centerhead', 'admin')) {
      throw new ApiError(403, 'Only a Center Head or Administrator can create a notification directly');
    }

    // Validate the body here rather than letting `notify()` reject it.
    //
    // `notify()` raises a plain Error when the title, message or addressee is
    // missing. The error handler can only map a plain Error to 500, and in
    // production the message is masked to "Internal server error" — so an
    // incomplete request came back as a server fault with nothing the caller
    // could act on. Measured against the deployed API before this change:
    //   POST /alerts {}                        -> 500
    //   POST /alerts {title, message}          -> 500  (no addressee)
    //   POST /alerts {targetRole}              -> 500  (no title/message)
    // Every one of those is the caller's mistake, so every one is a 400.
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';

    if (!title) throw new ApiError(400, 'title is required');
    if (!message) throw new ApiError(400, 'message is required');
    if (!body.targetRole && !body.targetUserId) {
      throw new ApiError(400, 'A notification needs a recipient: supply targetRole or targetUserId');
    }

    // An unrecognised role is stored verbatim and then read by nobody, which is
    // the same unreadable-row shape the service documents as a bug (see the 13
    // legacy addressee-less rows). Fail loudly instead of writing another one.
    if (body.targetRole && !isSupportedRole(body.targetRole, ROLE_KEYS)) {
      throw new ApiError(
        400,
        `Unknown targetRole "${body.targetRole}". Expected one of: ${ROLE_KEYS.join(', ')}`,
      );
    }

    const id = await notifications.notify({
      type: body.type || 'Announcement',
      title,
      message,
      priority: body.priority,
      actionRequired: body.actionRequired,
      residentId: body.residentId || null,
      relatedRecordType: body.relatedRecordType || null,
      relatedRecordId: body.relatedRecordId || null,
      targetRole: body.targetRole || null,
      targetUserId: body.targetUserId || null,
      actorUsername: req.user?.username || null,
    });

    // Echoed back through the service's unscoped read: an announcement is
    // hidden from the person who caused it, so the author cannot necessarily
    // read their own notification back.
    const created = await notifications.findAny(id);
    res.status(201).json({ success: true, data: created });
  } catch (error) {
    next(error);
  }
}

/**
 * Only the action-taken field may be edited through the API.
 *
 * The previous implementation forwarded the raw body to the generic CRUD
 * controller, which meant a caller could rewrite the title, message, priority
 * or addressee of any notification they could see.
 */
async function update(req, res, next) {
  try {
    const alert = await notifications.findVisible(req.params.id, req.user);
    if (!alert) throw new ApiError(404, 'Alert not found');

    const { actionTaken } = req.body || {};
    if (actionTaken !== undefined) {
      await notifications.setActionTaken(req.params.id, actionTaken);
    }

    const updated = await notifications.findAny(req.params.id);
    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
}

async function remove(req, res, next) {
  try {
    const ok = await notifications.remove(req.params.id, req.user);
    if (!ok) throw new ApiError(404, 'Alert not found');
    res.json({ success: true, message: 'Alert deleted' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: remove,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  getByResident,
  getUrgent,
};
