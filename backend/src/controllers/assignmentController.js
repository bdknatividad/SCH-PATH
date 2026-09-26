const { pool } = require('../config/database');
const { insertWithGeneratedId, toMysqlDateTime } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');
const { normalizeRole, isManager, hasRole } = require('../utils/authorization');
const notifications = require('../services/notificationService');

function roleOf(user) {
  return normalizeRole(user?.role);
}

function canManage(user) {
  return isManager(user);
}

/**
 * Who may assign or transfer a resident's Houseparent Case Load Manager.
 *
 * The Center Head and the Social Worker. `admin` is included because it is the
 * Center Head's system account (the Dashboard labels it CENTER HEAD).
 * Houseparents and every other role can never assign or change it.
 */
function canAssignCaseLoadManager(user) {
  return hasRole(user, 'centerhead', 'admin', 'socialworker');
}

function isHouseparentAssignmentType(value) {
  return String(value || '').trim().toLowerCase() === 'houseparent';
}

/** The only sources a Houseparent Case Load assignment may come from. */
const MANUAL_ASSIGNMENT_SOURCES = ['caseload', 'manual'];

const CENTER_HEAD_ONLY_MESSAGE = 'Only the Center Head or a Social Worker can assign or transfer a resident\'s Houseparent Case Load Manager.';

async function canAccessResident(user, residentId) {
  if (canManage(user)) return true;

  // Houseparents are the only role with a resident-level caseload boundary.
  // Other staff roles (Nurse, Educator, Psychological Staff, etc.) use their module
  // permissions rather than a houseparent assignment to read resident records.
  if (roleOf(user) !== 'houseparent') return true;

  // Primary source: the explicit residentAssignments row created by the
  // Center Head assignment UI.
  const [rows] = await pool.query(
    `SELECT ra.id FROM residentAssignments ra
       LEFT JOIN staff s ON s.id = ra.staffId
      WHERE ra.residentId = ? AND ra.status = 'Active'
        AND LOWER(TRIM(ra.assignmentType)) = 'houseparent'
        AND (ra.userId = ? OR s.userId = ?)
      LIMIT 1`,
    [residentId, user?.id || null, user?.id || null]
  );
  // The Houseparent on Duty recorded on the Admission Slip is NOT a Case Load
  // assignment. Only an explicit residentAssignments row, created by the Center
  // Head, puts a resident on a Houseparent's case load.
  return rows.length > 0;
}

async function ensureResident(residentId) {
  const [rows] = await pool.query('SELECT id FROM children WHERE id = ?', [residentId]);
  if (rows.length === 0) throw new ApiError(404, 'Resident not found');
}

async function getUserLabelColumn() {
  try {
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = 'users'`
    );
    if (cols.some(c => String(c.COLUMN_NAME).toLowerCase() === 'displayname')) return 'displayName';
  } catch (error) {
    console.warn('[AssignmentController] Unable to inspect users label column:', error.message);
  }
  return null;
}

async function getByResident(req, res, next) {
  try {
    const { residentId } = req.params;
    if (!await canAccessResident(req.user, residentId)) throw new ApiError(403, 'You are not assigned to this resident');
    const labelColumn = await getUserLabelColumn();
    const labelSelect = labelColumn ? `, u.${labelColumn} AS userDisplayName` : '';
    const [rows] = await pool.query(
      `SELECT ra.*, u.username AS userUsername${labelSelect}
       FROM residentAssignments ra
       LEFT JOIN users u ON u.id = ra.userId
       WHERE ra.residentId = ? ORDER BY ra.status, ra.startAt DESC`,
      [residentId]
    );
    const mapped = rows.map(r => ({ ...r, userLabel: r.userDisplayName || r.userUsername || null }));
    res.json({ success: true, data: mapped, count: mapped.length });
  } catch (error) { next(error); }
}

/**
 * One Case Worker (the Houseparent acting as Case Load Manager) may hold at
 * most 15 residents — the facility's 1:15 case-worker-to-resident ratio.
 *
 * This was 3, which is not a ratio the facility uses; it capped every
 * Houseparent at three cards and made the fourth assignment fail with a 400.
 */
const MAX_RESIDENTS_PER_HOUSEPARENT = 15;

async function countActiveHouseparentCaseload(userId) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM residentAssignments
     WHERE userId = ? AND assignmentType = 'houseparent' AND status = 'Active'`,
    [userId]
  );
  return rows[0]?.cnt || 0;
}

/**
 * Tell a Houseparent their caseload changed.
 *
 * Addressed by user id, so it reaches exactly one person — the old alert model
 * had no way to express "this Houseparent", only "all Houseparents", which is
 * why assignment alerts could not exist at all before this.
 *
 * Non-fatal: the assignment is already committed, and a notification failure
 * must not turn a successful assignment into a 500.
 */
async function notifyAssignment(userId, assignment, action, actor) {
  try {
    const childName = (await notifications.residentName(assignment.residentId)) || assignment.residentId;
    const ended = action === 'ended';

    await notifications.notify({
      type: 'Assignment',
      residentId: assignment.residentId,
      title: ended
        ? `Resident Unassigned - ${childName}`
        : `New Resident Assigned - ${childName}`,
      message: ended
        ? `${actor?.username || 'A manager'} ended your assignment to ${childName}. You no longer have access to this resident's records.`
        : `${actor?.username || 'A manager'} assigned ${childName} to you as your Houseparent case.`,
      priority: 'Medium',
      actionRequired: ended ? null : `Review ${childName}'s case file and current phase.`,
      relatedRecordType: 'residentAssignments',
      relatedRecordId: assignment.id,
      targetUserId: userId,
      actorUsername: actor?.username,
      dedupeKey: `assignment:${assignment.id}:${action}`,
    });
  } catch (error) {
    console.error('[AssignmentController] Assignment notification failed (non-fatal):', error.message);
  }
}

async function create(req, res, next) {
  try {
    if (!canManage(req.user)) throw new ApiError(403, 'Only Center Head or Social Worker can manage assignments');
    if (isHouseparentAssignmentType(req.body?.assignmentType) && !canAssignCaseLoadManager(req.user)) {
      throw new ApiError(403, CENTER_HEAD_ONLY_MESSAGE);
    }
    const { residentId } = req.params;
    // `startAt` and `endAt` arrive as ISO 8601 from the browser
    // (`new Date().toISOString()`), which MySQL rejects for a DATETIME column
    // under its default strict sql_mode: "Incorrect datetime value:
    // '2026-09-23T07:04:37.531Z' for column 'startAt' at row 1". Coerce before
    // the comparison below so both the ordering check and the INSERT see the
    // same, MySQL-accepted, value.
    const {
      staffId, userId, assignmentType, notes, source,
      startAt: rawStartAt, endAt: rawEndAt,
    } = req.body || {};
    const startAt = toMysqlDateTime(rawStartAt);
    const endAt = toMysqlDateTime(rawEndAt);
    if (!assignmentType || !startAt) throw new ApiError(400, 'assignmentType and startAt are required');
    if (!staffId && !userId) throw new ApiError(400, 'staffId or userId is required');
    // A Case Load Manager is linked by the Houseparent's account id, never by a
    // staff row or a display name, so a rename cannot move or break it.
    if (isHouseparentAssignmentType(assignmentType) && !userId) {
      throw new ApiError(400, 'userId (the Houseparent\'s account id) is required for a Case Load assignment');
    }
    // A Case Load Manager is assigned only by hand, from the Houseparent Module
    // (Assign Resident / Transfer, which send source 'caseload'). Anything else —
    // in particular an older Admission Slip screen still posting its HP on Duty
    // as 'admission' / 'admission-update' — is refused here, on the server, so
    // no client can turn the HP on Duty into the Case Load Manager.
    if (isHouseparentAssignmentType(assignmentType) && !MANUAL_ASSIGNMENT_SOURCES.includes(String(source || '').trim().toLowerCase())) {
      throw new ApiError(403, 'A Case Load Manager can only be assigned from the Houseparent Module (Assign Resident). The HP on Duty on the Admission Slip is not an assignment.');
    }
    if (endAt && new Date(endAt) < new Date(startAt)) throw new ApiError(400, 'endAt cannot be before startAt');
    await ensureResident(residentId);
    if (userId) {
      const [users] = await pool.query('SELECT id, status, role FROM users WHERE id = ?', [userId]);
      if (!users[0] || users[0].status !== 'Active') throw new ApiError(400, 'Assigned user is not active');
      if (isHouseparentAssignmentType(assignmentType) && normalizeRole(users[0].role) !== 'houseparent') {
        throw new ApiError(400, 'The selected account is not a Houseparent');
      }

      // Cap each Houseparent at 3 active residents — checked here (not just in
      // the UI) so the limit holds even if two requests race or the frontend
      // list is stale. normalizeRole() rather than a bare toLowerCase(): a
      // legacy spelling such as `house_parent` is still a Houseparent, and
      // comparing the raw column would let it slip past the cap.
      if (assignmentType === 'houseparent' && normalizeRole(users[0].role) === 'houseparent') {
        const current = await countActiveHouseparentCaseload(userId);
        if (current >= MAX_RESIDENTS_PER_HOUSEPARENT) {
          throw new ApiError(400, `This Houseparent already has ${MAX_RESIDENTS_PER_HOUSEPARENT} assigned residents — the maximum. Reassign or remove one of their cases first.`);
        }
      }
    }
    if (staffId) {
      const [staff] = await pool.query('SELECT id, status FROM staff WHERE id = ?', [staffId]);
      if (!staff[0] || staff[0].status !== 'Active') throw new ApiError(400, 'Assigned staff member is not active');
    }
    // A resident has one Case Load Manager at a time. Assigning a new one ends
    // the previous assignment here, on the server, so the resident can never be
    // left on two Houseparents' case loads (or on none, if the client stops
    // half-way through a change).
    let replacedAssignments = [];
    if (isHouseparentAssignmentType(assignmentType)) {
      const [activeRows] = await pool.query(
        `SELECT * FROM residentAssignments
          WHERE residentId = ? AND status = 'Active'
            AND LOWER(TRIM(assignmentType)) = 'houseparent'`,
        [residentId]
      );
      if (activeRows.some((row) => String(row.userId) === String(userId))) {
        throw new ApiError(409, 'This Houseparent is already the resident\'s Case Load Manager.');
      }
      if (activeRows.length > 0) {
        await pool.query(
          `UPDATE residentAssignments SET status = 'Ended', endAt = NOW(), updatedBy = ?
            WHERE residentId = ? AND status = 'Active'
              AND LOWER(TRIM(assignmentType)) = 'houseparent'`,
          [req.user.username, residentId]
        );
        replacedAssignments = activeRows;
      }
    }

    // Two concurrent assignments can derive the same id; retry instead of 500.
    const id = await insertWithGeneratedId(pool, {
      table: 'residentAssignments',
      prefix: 'ASN',
      insert: (generatedId) => pool.query(
        `INSERT INTO residentAssignments
         (id, residentId, staffId, userId, assignmentType, status, startAt, endAt, source, notes, createdBy, updatedBy)
         VALUES (?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?)`,
        [generatedId, residentId, staffId || null, userId || null, assignmentType, startAt, endAt || null, source || 'manual', notes || null, req.user.username, req.user.username]
      ),
    });
    const [rows] = await pool.query('SELECT * FROM residentAssignments WHERE id = ?', [id]);

    // Tell the Houseparent they now hold this resident. `household` rows are
    // the shared whole-facility placeholder and are deliberately silent: every
    // Houseparent has one, so notifying on them would be pure noise.
    for (const previous of replacedAssignments) {
      if (previous.userId) await notifyAssignment(previous.userId, previous, 'ended', req.user);
    }
    if (isHouseparentAssignmentType(assignmentType) && userId) {
      await notifyAssignment(userId, rows[0], 'created', req.user);
    }

    res.status(201).json({ success: true, data: rows[0] });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  try {
    if (!canManage(req.user)) throw new ApiError(403, 'Only Center Head or Social Worker can manage assignments');
    const { id } = req.params;
    const [existingRows] = await pool.query('SELECT assignmentType FROM residentAssignments WHERE id = ?', [id]);
    if (!existingRows[0]) throw new ApiError(404, 'Assignment not found');
    if ((isHouseparentAssignmentType(existingRows[0].assignmentType) || isHouseparentAssignmentType(req.body?.assignmentType))
      && !canAssignCaseLoadManager(req.user)) {
      throw new ApiError(403, CENTER_HEAD_ONLY_MESSAGE);
    }
    const allowed = ['staffId', 'userId', 'assignmentType', 'status', 'startAt', 'endAt', 'source', 'notes'];
    const updates = [];
    const values = [];
    for (const field of allowed) {
      if (req.body?.[field] !== undefined) { updates.push(`${field} = ?`); values.push(req.body[field]); }
    }
    if (updates.length === 0) throw new ApiError(400, 'No fields to update');
    updates.push('updatedBy = ?'); values.push(req.user.username); values.push(id);
    const [result] = await pool.query(`UPDATE residentAssignments SET ${updates.join(', ')} WHERE id = ?`, values);
    if (result.affectedRows === 0) throw new ApiError(404, 'Assignment not found');
    const [rows] = await pool.query('SELECT * FROM residentAssignments WHERE id = ?', [id]);
    res.json({ success: true, data: rows[0] });
  } catch (error) { next(error); }
}

async function end(req, res, next) {
  try {
    if (!canManage(req.user)) throw new ApiError(403, 'Only Center Head or Social Worker can end assignments');
    const { id } = req.params;
    const [existingRows] = await pool.query('SELECT assignmentType FROM residentAssignments WHERE id = ?', [id]);
    if (existingRows[0] && isHouseparentAssignmentType(existingRows[0].assignmentType) && !canAssignCaseLoadManager(req.user)) {
      throw new ApiError(403, CENTER_HEAD_ONLY_MESSAGE);
    }
    const [result] = await pool.query(
      `UPDATE residentAssignments SET status = 'Ended', endAt = COALESCE(?, NOW()), updatedBy = ? WHERE id = ? AND status = 'Active'`,
      [req.body?.endAt || null, req.user.username, id]
    );
    if (result.affectedRows === 0) throw new ApiError(404, 'Active assignment not found');
    const [rows] = await pool.query('SELECT * FROM residentAssignments WHERE id = ?', [id]);

    // The Houseparent loses access to this resident's records the moment this
    // commits, so they need to be told rather than discovering it as a 404.
    if (rows[0]?.assignmentType === 'houseparent' && rows[0]?.userId) {
      await notifyAssignment(rows[0].userId, rows[0], 'ended', req.user);
    }

    res.json({ success: true, data: rows[0] });
  } catch (error) { next(error); }
}

/**
 * Who a Case Load request may ask about.
 *
 * - `all`    — Center Head / Social Worker / Admin: the whole facility.
 * - `self`   — Houseparent: may see the active Houseparent roster, but only
 *              their own resident assignment data is returned.
 * - `denied` — anyone else.
 *
 * Split out from `getCaseload` so the access rule can be asserted directly
 * rather than inferred from a live request.
 *
 * @param {Object} user Authenticated user.
 * @returns {{kind: 'all'|'self'|'denied', userId: string|null}}
 */
function caseloadScope(user) {
  // Houseparents can see the Houseparent Case Load roster so the interface
  // matches the facility Case Load layout, but resident-level data remains
  // self-scoped. Resident access is independently enforced by
  // canAccessResident(), so a Houseparent cannot bypass this boundary by
  // calling a resident endpoint directly with another resident's id.
  if (roleOf(user) === 'houseparent') return { kind: 'self', userId: user?.id || null };
  if (canManage(user)) return { kind: 'all', userId: null };
  return { kind: 'denied', userId: null };
}

/**
 * Every account that is currently a Houseparent.
 *
 * The roster is derived from the `role` column and the account's status — never
 * from the account's username. A username pattern ("HP 1"…"HP 10") used to
 * filter this list, which meant a Houseparent created through Account
 * Management never reached the Assigned Houseparent dropdown on Admission Slip
 * Part 2 no matter how the account was configured. The pattern is gone: an
 * account is a Houseparent because its role says so.
 *
 * Deactivated accounts drop out (status is filtered in SQL), so an inactive or
 * deleted Houseparent can no longer be assigned. Their existing
 * residentAssignments rows are left untouched — nothing is rewritten or
 * reassigned, they simply stop producing a card.
 *
 * Exported so the rule can be asserted directly rather than inferred from a
 * live request.
 *
 * @returns {Promise<Array<{id: string, username: string, role: string, status: string, displayLabel?: string}>>}
 */
async function activeHouseparents() {
  const labelColumn = await getUserLabelColumn();
  const labelSelect = labelColumn ? `, u.${labelColumn} AS displayLabel` : '';

  // The role is normalized in JS rather than in SQL so legacy spellings such as
  // `house_parent` / `Houseparent` cannot make a Houseparent disappear.
  const [allUsers] = await pool.query(
    `SELECT u.id, u.username, u.role, u.status${labelSelect}
     FROM users u
     WHERE u.status = 'Active'
     ORDER BY u.username`,
    []
  );

  return allUsers
    .filter((u) => normalizeRole(u.role) === 'houseparent')
    .sort((a, b) => String(a.username || '').localeCompare(
      String(b.username || ''),
      undefined,
      { numeric: true, sensitivity: 'base' }
    ));
}

/**
 * Case Load summary. Managers receive the roster of every active Houseparent.
 * Houseparents receive the same roster, with every card's resident names/counts
 * populated the same way the Center Head sees them. This is also the source for
 * the Houseparent's "My Caseload" card in TRI, and for the Assigned Houseparent
 * dropdown on Admission Slip Part 2.
 *
 * Resident-level access remains independently enforced by canAccessResident(),
 * so a Houseparent cannot open another HP's resident even if they obtain a URL
 * — only the Case Load roster names are shared; the underlying records are not.
 */
async function getCaseload(req, res, next) {
  try {
    const scope = caseloadScope(req.user);
    if (scope.kind === 'denied') {
      throw new ApiError(403, 'Only Center Head or Social Worker can view the case load overview');
    }

    // The Case Load roster is visible to Houseparents too. Resident details
    // are still self-scoped below, so this does not expose another HP's
    // residents.
    const houseparents = await activeHouseparents();

    // Straight from the database, keyed by the Houseparent's account id and the
    // resident id — never by a display name, so renaming an HP changes only
    // the label on the card. Only residents currently in the facility (status
    // Active) are listed: a discharged or absconded resident is no longer on
    // anyone's case load, even if an old assignment row was never ended.
    const [rows] = await pool.query(
      `SELECT COALESCE(ra.userId, s.userId) AS userId, c.id AS residentId, c.name AS residentName
         FROM residentAssignments ra
         LEFT JOIN staff s ON s.id = ra.staffId
         JOIN children c ON c.id = ra.residentId
        WHERE LOWER(TRIM(ra.assignmentType)) = 'houseparent'
          AND ra.status = 'Active'
          AND c.status = 'Active'
          AND COALESCE(ra.userId, s.userId) IS NOT NULL
        ORDER BY ra.startAt DESC, ra.createdAt DESC`,
      []
    );

    // Only explicit Center Head / Social Worker assignments count. The
    // Houseparent on Duty on the Admission Slip is a separate field and never
    // feeds the Case Load. A resident has ONE Case Load Manager: if legacy
    // data left more than one active row for a resident, the most recent
    // assignment is the one shown, so no resident is counted under two HPs.
    const byResident = new Map();
    rows.forEach((r) => {
      const key = String(r.residentId);
      if (!byResident.has(key)) byResident.set(key, r);
    });
    const effectiveRows = [...byResident.values()];

    const caseload = houseparents.map((hp) => {
      // The Case Load roster (which children are assigned to each HP) is
      // informational and mirrors the Center Head view for every HP card,
      // including HPs other than the signed-in one. What stays self-scoped
      // for a Houseparent is opening a resident's actual record — that
      // boundary is enforced separately by canAccessResident() and by the
      // /store caseload filter, neither of which this roster listing feeds.
      // Every Houseparent sees the whole assignment roster — which residents
      // (id and name only) are assigned to each HP, their own and others'.
      // Opening a resident's full record stays limited to the Houseparent's
      // own Case Load: canAccessResident() and the /store caseload filter
      // enforce that, and this listing carries nothing beyond the name.
      const residents = effectiveRows
        .filter((r) => String(r.userId) === String(hp.id))
        .map((r) => ({ id: r.residentId, name: r.residentName }));
      const label = hp.displayLabel || hp.username;
      return {
        // Whether this card is the signed-in Houseparent's own, decided on the
        // server by account id (users.id), so the page never has to match a
        // username or display name to know which residents may be opened.
        isSelf: String(hp.id) === String(req.user?.id ?? ''),
        userId: hp.id,
        username: hp.username,
        displayName: hp.displayLabel || null,
        label,
        assignedCount: residents.length,
        maxCaseload: MAX_RESIDENTS_PER_HOUSEPARENT,
        availableSlots: Math.max(0, MAX_RESIDENTS_PER_HOUSEPARENT - residents.length),
        residents,
      };
    });

    res.json({ success: true, data: caseload });
  } catch (error) { next(error); }
}

async function getMyResidents(req, res, next) {
  try {
    if (roleOf(req.user) !== 'houseparent') throw new ApiError(403, 'Only Houseparents can view their assigned residents');
    const ids = await require('../utils/residentScope').assignedResidentIds(req.user);
    if (!ids.length) return res.json({ success: true, data: [] });
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT * FROM children WHERE id IN (${placeholders}) AND status <> 'Discharged' ORDER BY name`,
      ids
    );
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
}

module.exports = { getByResident, create, update, end, canAccessResident, canManage, canAssignCaseLoadManager, getCaseload, caseloadScope, activeHouseparents, getMyResidents };
