const { pool } = require('../config/database');
const { mapRow, insertWithGeneratedId } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');
const {
  canReadDocumentAsync,
  loadDocumentScope,
  residentInScope,
  documentVisibleTo,
} = require('./documentController');
const { DOCUMENT_ROLE_PERMISSIONS } = require('../utils/constants');
const { normalizeRole, hasRole } = require('../utils/authorization');
const rbac = require('../config/rbac');
const notifications = require('../services/notificationService');

const REQUEST_COLUMNS = [
  'id', 'requesterId', 'requesterUsername', 'requesterRole', 'targetUserId', 'targetRole',
  'documentId', 'residentId', 'moduleName', 'recordTab', 'reason', 'status', 'reviewedBy',
  'reviewedAt', 'reviewerNote', 'createdAt', 'updatedAt',
];

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accessRequests (
      id VARCHAR(40) PRIMARY KEY,
      requesterId VARCHAR(40) NOT NULL,
      requesterUsername VARCHAR(100) NOT NULL,
      requesterRole VARCHAR(50) NULL,
      targetUserId VARCHAR(40) NULL,
      targetRole VARCHAR(50) NULL,
      documentId VARCHAR(40) NULL,
      residentId VARCHAR(40) NULL,
      moduleName VARCHAR(100) NULL,
      recordTab VARCHAR(100) NULL,
      reason TEXT NOT NULL,
      status ENUM('Pending', 'Approved', 'Rejected') NOT NULL DEFAULT 'Pending',
      reviewedBy VARCHAR(100) NULL,
      reviewedAt TIMESTAMP NULL,
      reviewerNote TEXT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_access_requesterId (requesterId),
      INDEX idx_access_status (status),
      INDEX idx_access_targetRole (targetRole),
      INDEX idx_access_documentId (documentId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  try {
    await pool.query('ALTER TABLE accessRequests ADD COLUMN documentId VARCHAR(40) NULL AFTER targetRole');
    await pool.query('ALTER TABLE accessRequests ADD INDEX idx_access_documentId (documentId)');
  } catch (error) {
    if (!['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(error.code)) throw error;
  }
  try {
    // The requester's role at the time of asking. Stored rather than joined so the
    // request stays an accurate record even if the account's role later changes.
    await pool.query('ALTER TABLE accessRequests ADD COLUMN requesterRole VARCHAR(50) NULL AFTER requesterUsername');
  } catch (error) {
    if (error.code !== 'ER_DUP_FIELDNAME') throw error;
  }
}

/**
 * May this user decide this request?
 *
 * Center Head / Administrator may review any request. Everyone else may review
 * only a *document* request, only while it is Pending, and only if they can
 * already read that document — which is what "the existing system's permissions
 * and document relationship give them that authority" means here. Nobody may
 * decide their own request.
 *
 * Exported so the rule can be tested directly and reused by the listing.
 */
async function canReviewRequest(user, request, scope = null) {
  // hasRole() normalises via normalizeRole(user.role) internally. Passing the
  // user object to normalizeRole() directly would stringify it to
  // "[object Object]" and silently make every manager check fail.
  if (request.status !== 'Pending') return false;
  if (String(request.requesterId) === String(user?.id)) return false;
  if (hasRole(user, 'centerhead', 'admin')) return true;
  // A module/tab request has no document to reason about; only the roles above
  // may decide those. The Psychologist is the one historical exception, kept
  // because those requests are addressed to that role by the module itself.
  if (!request.documentId) {
    return hasRole(user, 'psychologist') && request.targetRole === 'psychologist';
  }

  // Deciding who else may read a document is separate from being able to read
  // it. The specification is explicit: "A user's ability to view a document does
  // not automatically grant approval authority."
  //
  // A caseload-bounded caller is the exception: for a Houseparent "can read"
  // already means "is responsible for this child", so a request for one of their
  // own residents is theirs to decide. A caller with no caseload boundary can
  // read across the whole facility, so reading there is not authority — it needs
  // the `approve` capability. Without this the Psychologist could approve a
  // request for any document it happened to be able to read, which is the global
  // approval authority its specification withholds.
  //
  // This also closes the API/UI mismatch: the Documents module already hides the
  // Approve / Reject buttons behind `can('Documents', 'approve')`, so no role
  // loses a decision it could actually reach from the interface.
  const [rows] = await pool.query('SELECT * FROM documents WHERE id = ?', [request.documentId]);
  if (rows.length === 0) return false;
  const documentScope = scope || await loadDocumentScope(user);
  if (documentScope.allowedResidentIds === null && !rbac.can(user, 'Documents', 'approve')) {
    return false;
  }
  return documentVisibleTo(rows[0], user, documentScope);
}

async function getAll(req, res, next) {
  try {
    await ensureTable();
    // Own requests in every state (so a requester can see Pending / Approved /
    // Rejected), plus every Pending request the caller is entitled to decide.
    const [rows] = await pool.query(
      `SELECT ar.${REQUEST_COLUMNS.join(', ar.')},
              d.title AS documentTitle, d.fileName AS documentFileName,
              d.residentId AS documentResidentId, d.category AS documentCategory,
              d.uploaderRole AS documentUploaderRole, c.name AS residentName
       FROM accessRequests ar
       LEFT JOIN documents d ON d.id = ar.documentId
       LEFT JOIN children c ON c.id = COALESCE(d.residentId, ar.residentId)
       ORDER BY ar.createdAt DESC`
    );
    const scope = await loadDocumentScope(req.user);
    const visible = [];
    for (const row of rows) {
      const isRequester = String(row.requesterId) === String(req.user.id);
      if (!isRequester && !await canReviewRequest(req.user, row, scope)) continue;
      visible.push({
        ...mapRow('accessRequests', row),
        documentTitle: row.documentTitle,
        documentFileName: row.documentFileName,
        documentResidentId: row.documentResidentId,
        documentCategory: row.documentCategory,
        residentName: row.residentName,
        isRequester,
        canReview: !isRequester,
      });
    }
    res.json({ success: true, data: visible, count: visible.length });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    await ensureTable();
    const { targetUserId, targetRole, documentId, residentId, moduleName, recordTab, reason } = req.body || {};
    if (!targetUserId && !targetRole && !documentId) throw new ApiError(400, 'A target user, role, or document is required');
    if (!documentId && !moduleName && !recordTab) throw new ApiError(400, 'A document, module, or record tab is required');
    if (!reason || !String(reason).trim()) throw new ApiError(400, 'A reason is required');

    let resolvedTargetUserId = targetUserId || null;
    let resolvedTargetRole = targetRole || null;
    let document = null;
    if (documentId) {
      const [documents] = await pool.query('SELECT * FROM documents WHERE id = ?', [documentId]);
      if (documents.length === 0) throw new ApiError(404, 'Document not found');
      document = documents[0];
      const scope = await loadDocumentScope(req.user);
      // A document outside the caller's resident scope is reported as missing
      // rather than forbidden. Otherwise this endpoint is an existence oracle:
      // a Houseparent could walk document ids and learn which children have a
      // Court Order. It also stops a request being filed — and then approved by
      // a Center Head — for a child the requester has no access to, which would
      // contradict "a Houseparent reaches only their assigned children".
      if (!residentInScope(document, req.user, scope.allowedResidentIds)) {
        throw new ApiError(404, 'Document not found');
      }
      // The scoped check, not the raw one: a Houseparent outside the document's
      // caseload does NOT "already have access" and must be allowed to ask.
      // Passing the loaded grants avoids a second query.
      if (await canReadDocumentAsync(document, req.user, scope.approvedDocumentIds)) {
        throw new ApiError(409, 'You already have access to this document');
      }

      const owners = [document.createdBy, document.uploadedBy, document.submittedBy].filter(Boolean);
      if (!resolvedTargetUserId && owners.length > 0) {
        const [users] = await pool.query(
          'SELECT id, username, role FROM users WHERE username IN (?) OR id IN (?) LIMIT 1',
          [owners, owners]
        );
        if (users[0]) {
          resolvedTargetUserId = users[0].id;
          resolvedTargetRole = resolvedTargetRole || users[0].role;
        }
      }
      if (!resolvedTargetRole) {
        resolvedTargetRole = DOCUMENT_ROLE_PERMISSIONS[document.title]?.find(role => role !== normalizeRole(req.user?.role)) || 'centerhead';
      }
    }

    const [existing] = await pool.query(
      `SELECT id FROM accessRequests WHERE requesterId = ? AND documentId <=> ? AND targetUserId <=> ? AND targetRole <=> ?
       AND residentId <=> ? AND moduleName <=> ? AND recordTab <=> ? AND status = 'Pending'`,
      [req.user.id, documentId || null, resolvedTargetUserId, resolvedTargetRole, residentId || null, moduleName || null, recordTab || null]
    );
    if (existing.length > 0) throw new ApiError(409, 'A matching access request is already pending');

    // Two concurrent requests can derive the same id; retry instead of 500.
    const id = await insertWithGeneratedId(pool, {
      table: 'accessRequests',
      prefix: 'ACC',
      insert: (generatedId) => pool.query(
        `INSERT INTO accessRequests
          (id, requesterId, requesterUsername, requesterRole, targetUserId, targetRole, documentId, residentId, moduleName, recordTab, reason, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`,
        [generatedId, req.user.id, req.user.username, normalizeRole(req.user?.role), resolvedTargetUserId, resolvedTargetRole, documentId || null, residentId || null, moduleName || null, recordTab || null, String(reason).trim()]
      ),
    });

    // Notify everyone who can actually decide this request: the role that owns
    // the document type, plus the Center Head as the fallback approver. Sent as
    // one row per person so that read state, deletion and the notification list
    // are per-recipient rather than shared across the whole role.
    const reviewerRole = resolvedTargetRole || 'centerhead';
    const reviewers = await notifications.usersWithAnyRole(
      [...new Set([reviewerRole, 'centerhead', 'admin'])]
    );
    const documentLabel = document?.title || moduleName || recordTab || 'a document';
    await notifications.notifyUsers(
      reviewers.map((user) => user.id),
      {
        type: 'Access Request',
        title: `Access request from ${req.user.username}`,
        message: `${req.user.username} requested access to ${documentLabel}${document?.residentName ? ` for ${document.residentName}` : ''}. A decision is needed.`,
        priority: 'Medium',
        actionRequired: 'Approve or reject the access request',
        residentId: document?.residentId || residentId || null,
        relatedRecordType: 'accessRequests',
        relatedRecordId: id,
        actorUsername: req.user.username,
        dedupeKey: `access-request:${id}:filed`,
      }
    );

    const [rows] = await pool.query(`SELECT ${REQUEST_COLUMNS.join(', ')} FROM accessRequests WHERE id = ?`, [id]);
    res.status(201).json({ success: true, data: mapRow('accessRequests', rows[0]) });
  } catch (error) { next(error); }
}

/**
 * Completed access requests — the permanent audit trail.
 *
 * `getAll` returns the caller's own requests plus the *Pending* ones they are
 * entitled to decide, so a request leaves that list the moment a decision is
 * taken. This endpoint is the other half of the picture: every request that has
 * reached a terminal state, which is what lets a Center Head or Social Worker
 * re-read what was approved or rejected, by whom, when, and why.
 *
 * Scope. A full-access caller (Center Head / Administrator) sees every completed
 * request. Everyone else sees the ones they themselves decided, matched on
 * `reviewedBy` — "all document access requests they previously approved or
 * rejected". Rows are never deleted, so the history is permanent.
 *
 * `?status=` accepts All (default), Approved or Rejected; anything else is
 * treated as All so a malformed filter cannot silently empty the table.
 */
async function getHistory(req, res, next) {
  try {
    await ensureTable();
    const requested = String(req.query.status || 'All').trim().toLowerCase();
    const statuses = requested === 'approved'
      ? ['Approved']
      : requested === 'rejected'
        ? ['Rejected']
        : ['Approved', 'Rejected'];

    const [rows] = await pool.query(
      `SELECT ar.${REQUEST_COLUMNS.join(', ar.')},
              d.title AS documentTitle, d.fileName AS documentFileName,
              d.residentId AS documentResidentId, d.category AS documentCategory,
              d.uploaderRole AS documentUploaderRole, c.name AS residentName
         FROM accessRequests ar
         LEFT JOIN documents d ON d.id = ar.documentId
         LEFT JOIN children c ON c.id = COALESCE(d.residentId, ar.residentId)
        WHERE ar.status IN (?)
        ORDER BY ar.reviewedAt DESC, ar.createdAt DESC`,
      [statuses]
    );

    const seesEveryDecision = hasRole(req.user, 'centerhead', 'admin');
    const visible = rows
      .filter((row) => seesEveryDecision
        || String(row.reviewedBy || '') === String(req.user.username || ''))
      .map((row) => ({
        ...mapRow('accessRequests', row),
        documentTitle: row.documentTitle,
        documentFileName: row.documentFileName,
        documentResidentId: row.documentResidentId,
        documentCategory: row.documentCategory,
        residentName: row.residentName,
      }));

    res.json({ success: true, data: visible, count: visible.length });
  } catch (error) { next(error); }
}

async function review(req, res, next) {
  try {
    await ensureTable();
    const { id } = req.params;
    const { decision, reviewerNote } = req.body || {};
    if (!['Approved', 'Rejected'].includes(decision)) throw new ApiError(400, 'Decision must be Approved or Rejected');

    const [requests] = await pool.query('SELECT * FROM accessRequests WHERE id = ?', [id]);
    if (requests.length === 0) throw new ApiError(404, 'Access request not found');
    const request = requests[0];
    // Order matters: report the state conflict before the permission conflict so
    // a second reviewer gets "already reviewed" rather than a misleading 403.
    if (request.status !== 'Pending') throw new ApiError(409, 'Access request has already been reviewed');
    // Enforces all three rules at once: pending-only, never your own request, and
    // the reviewer must already be able to read the document in question.
    if (!await canReviewRequest(req.user, request)) throw new ApiError(403, 'You are not authorized to review this access request');

    await pool.query(
      `UPDATE accessRequests
         SET status = ?, reviewedBy = ?, reviewedAt = NOW(),
             reviewerNote = COALESCE(?, reviewerNote)
       WHERE id = ?`,
      [decision, req.user.username, reviewerNote || null, id]
    );

    if (decision === 'Approved') {
      if (request.moduleName) {
        await pool.query(
          `UPDATE users SET accessibleModules = JSON_ARRAY_APPEND(COALESCE(accessibleModules, JSON_ARRAY()), '$', ?), modifiedBy = ?
           WHERE id = ? AND JSON_CONTAINS(COALESCE(accessibleModules, JSON_ARRAY()), JSON_QUOTE(?)) = 0`,
          [request.moduleName, req.user.username, request.requesterId, request.moduleName]
        );
      }
      if (request.recordTab) {
        await pool.query(
          `UPDATE users SET childRecordTabs = JSON_ARRAY_APPEND(COALESCE(childRecordTabs, JSON_ARRAY()), '$', ?), modifiedBy = ?
           WHERE id = ? AND JSON_CONTAINS(COALESCE(childRecordTabs, JSON_ARRAY()), JSON_QUOTE(?)) = 0`,
          [request.recordTab, req.user.username, request.requesterId, request.recordTab]
        );
      }
    }

    // Notify the requester — and only the requester.
    //
    // This used to write `targetRole = request.requesterId ? null : ...`, which
    // is always null, and a null targetRole meant "everyone". So all thirteen
    // "Access Request Decision" rows in the live database are addressed to
    // nobody and were shown to the whole facility. The recipient is the
    // requester, by id.
    const decisionWord = decision === 'Approved' ? 'approved' : 'rejected';
    let documentLabel = request.moduleName || request.recordTab || 'your requested item';
    if (request.documentId) {
      const [docRows] = await pool.query('SELECT title FROM documents WHERE id = ?', [request.documentId]);
      if (docRows[0]?.title) documentLabel = docRows[0].title;
    }

    await notifications.notify({
      type: 'Access Request Decision',
      title: `Access request ${decisionWord}`,
      message: decision === 'Approved'
        ? `Your request for access to ${documentLabel} was approved by ${req.user.username}. You can open it now.`
        : `Your request for access to ${documentLabel} was rejected by ${req.user.username}.${reviewerNote ? ` Reason: ${reviewerNote}` : ''}`,
      priority: 'Medium',
      actionRequired: decision === 'Approved' ? null : 'Request again with more detail if you still need access',
      residentId: request.residentId || null,
      relatedRecordType: 'accessRequests',
      relatedRecordId: id,
      targetUserId: request.requesterId,
      actorUsername: req.user.username,
      dedupeKey: `access-request:${id}:decision`,
    });

    res.json({ success: true, message: `Access request ${decision.toLowerCase()}` });
  } catch (error) { next(error); }
}

module.exports = { getAll, getHistory, create, review, canReviewRequest };
