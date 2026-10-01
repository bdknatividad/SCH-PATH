/**
 * Document Routes
 * @module routes/documentRoutes
 * @description Document management with approval workflow
 */

const express = require('express');
const router = express.Router();
const documentController = require('../controllers/documentController');
const { asyncHandler } = require('../middleware/errorHandler');
const { authorize, authorizeNonHouseparent } = require('../middleware/auth');
const { requirePermission, requireSubModule, snapshotFor } = require('../middleware/rbac');
const { hasModuleAccess, hasPermission } = require('../config/rbac');
const { pool } = require('../config/database');
const { categoryForDocument } = require('../utils/documentCategory');

/** The folder the Education module's own uploads are filed into. */
const EDUCATION_FOLDER = 'Educational Records';

/**
 * The module each generated quarterly Progress Report is filed from.
 *
 * Only the two generators write these types, so the map is what tells this
 * route which capability to ask for. Kept beside the route rather than in
 * `constants.js` because it exists for this gate and nothing else.
 */
const PROGRESS_REPORT_PROGRAM_BY_TYPE = {
  'Education Quarterly Report': 'Education',
  'Medical Quarterly Report': 'Health',
};

/**
 * Filing a document needs `Documents: create` — except for the two generated
 * quarterly Progress Reports, which are filed from the program's own module.
 *
 * The Educator's specification deliberately withholds document management, and
 * the gate below is what enforces it. But the Educator is also the one who fills
 * in the **Education Quarterly Report**, from a button inside the Education
 * module, where they do hold `create` — so gating that write on
 * `Documents: create` made the whole form a dead end: the button is there, the
 * form fills in, and filing it answers *"Access denied. Documents: create
 * permission is required."* The Nurse was never affected because Health's
 * specification happens to grant `Documents: create` as well; Education's does
 * not, and that asymmetry is the bug.
 *
 * So a progress report is checked against the **program's** capability instead,
 * which also keeps the two apart: an Educator cannot file the Medical report and
 * a Nurse cannot file the Education one, because neither holds the other's
 * module. Everything else — and every other caller — still goes through
 * `Documents: create`, unchanged: a role that holds neither program module falls
 * back to it, so nothing that used to work stops working.
 */
function requireDocumentCreate(req, res, next) {
  const body = req.body || {};
  const snapshot = snapshotFor(req);
  const holds = (moduleName) =>
    hasModuleAccess(snapshot, moduleName) && hasPermission(snapshot, moduleName, 'create');

  const program = PROGRESS_REPORT_PROGRAM_BY_TYPE[String(body.type || '').trim()];
  if (program && holds(program)) return next();

  /*
   * The Education module's own Upload button, which files whatever the educator
   * chose straight into the child's **Educational Records** folder.
   *
   * Exactly the same asymmetry as the quarterly report above, and it produced a
   * worse failure: the Educator holds `Education: create` but only
   * `Documents: view`, so the copy into Documents answered 403. The upload
   * screen caught that, kept the file in the Education record, and said so in a
   * line most people never read — so the file appeared to save and then was
   * simply absent from the resident's record, which is how "I uploaded it but
   * it isn't in the child's documents" presents.
   *
   * Keyed on the folder the document is about to be filed into rather than on a
   * title, so it covers every education upload without the caller having to
   * name one — and it cannot be used to file anything outside Education,
   * because a document that derives anywhere else still goes through
   * `Documents: create`.
   */
  if (categoryForDocument(body) === EDUCATION_FOLDER && holds('Education')) return next();

  return requirePermission('Documents', 'create')(req, res, next);
}

/**
 * Editing a document needs `Documents: edit` — except for the uploader putting
 * their own returned document back into review.
 *
 * A Rejected / For Reassessment document is waiting on exactly one person: the
 * one who filed it. That person is not always a role holding `Documents: edit` —
 * the Educator files its quarterly reports through the create exemption above and
 * holds Documents read-only, so a returned education report had no way back. The
 * screen showed the reason and nothing to do about it, and the Phase Timeline's
 * upload box — the only other route — files a *second* document and leaves the
 * returned one orphaned in the record.
 *
 * The exemption is deliberately narrow; all three must hold:
 *   - the caller IS the uploader, by the same username identity the rest of the
 *     document workflow uses;
 *   - the document is in a returned state (`Rejected` / `Reassessment`);
 *   - the body asks only to put it back into review (`Submitted`).
 *
 * A different person, a document that is not returned, or any other target
 * status still goes through `Documents: edit`. So this cannot rewrite an
 * approved file, and it cannot decide anything: `Approved`, `Rejected` and
 * `Reassessment` all fall through to the permission check, and the controller
 * refuses them again for a caller without the approval capability.
 */
async function requireDocumentEdit(req, res, next) {
  const snapshot = snapshotFor(req);
  if (hasPermission(snapshot, 'Documents', 'edit')) return next();

  const fallback = () => requirePermission('Documents', 'edit')(req, res, next);

  if (String(req.body?.status || '') !== 'Submitted') return fallback();

  try {
    const [rows] = await pool.query(
      'SELECT uploadedBy, submittedBy, createdBy, status FROM documents WHERE id = ? LIMIT 1',
      [req.params.id],
    );
    const document = rows[0];
    if (!document) return fallback();
    if (!['Rejected', 'Reassessment'].includes(String(document.status || ''))) return fallback();

    const owner = String(document.uploadedBy || document.submittedBy || document.createdBy || '').toLowerCase();
    const caller = String(req.user?.username || '').toLowerCase();
    if (!owner || owner !== caller) return fallback();

    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/documents
 * Get all documents
 */
router.get('/', asyncHandler(documentController.getAll));

/**
 * GET /api/documents/requestable
 * Metadata-only documents that require an access request.
 */
router.get('/requestable', asyncHandler(documentController.getRequestableDocuments));

/**
 * GET /api/documents/pending
 * Get pending documents
 */
router.get('/pending', requireSubModule('Documents', 'Pending Review'), asyncHandler(documentController.getPending));

/**
 * GET /api/documents/allowed?phase=X&role=Y
 * Get allowed document types for a role in a phase
 */
router.get('/allowed', asyncHandler(documentController.getAllowedForRole));

/**
 * GET /api/documents/resident/:residentId
 * Get documents by resident
 */
router.get('/resident/:residentId', asyncHandler(documentController.getByResident));

/**
 * GET /api/documents/:id
 * Get document by ID
 */
/**
 * GET /api/documents/:id/history
 * The document's audit trail — every submission and review decision, with the
 * reviewer's note. Declared before `/:id` so the path is not read as an id.
 */
router.get('/:id/history', asyncHandler(documentController.getHistory));

router.get('/:id/file', asyncHandler(documentController.getFile));

router.get('/:id', asyncHandler(documentController.getById));

/**
 * POST /api/documents
 * Create new document
 *
 * Filing a document is the Documents `create` capability, not merely being a
 * non-Houseparent. Without this the Educator — whose specification says it
 * cannot manage documents — could POST an upload even though every button that
 * would do so is hidden in the interface.
 *
 * `requireDocumentCreate` is that same check with one exemption, for the two
 * generated quarterly Progress Reports — see there for why.
 */
router.post('/', authorizeNonHouseparent, requireDocumentCreate, asyncHandler(documentController.create));

/**
 * PUT /api/documents/:id
 * Update document
 *
 * `requireDocumentEdit` is `Documents: edit` with one exemption, for the uploader
 * returning their own returned document to review — see there for why.
 */
router.put('/:id', authorizeNonHouseparent, requireDocumentEdit, asyncHandler(documentController.update));

/**
 * POST /api/documents/:id/submit
 * Submit document for review
 */
router.post('/:id/submit', authorizeNonHouseparent, requirePermission('Documents', 'edit'), asyncHandler(documentController.submit));

/**
 * POST /api/documents/:id/approve
 * Approve document
 */
router.post('/:id/approve', authorize('centerhead', 'socialworker'), requirePermission('Documents', 'approve'), asyncHandler(documentController.approve));

/**
 * POST /api/documents/:id/reject
 * Reject document
 */
router.post('/:id/reject', authorize('centerhead', 'socialworker'), requirePermission('Documents', 'approve'), asyncHandler(documentController.reject));

/**
 * DELETE /api/documents/:id
 * Delete document
 */
router.delete('/:id', authorizeNonHouseparent, requirePermission('Documents', 'delete'), asyncHandler(documentController.delete));

module.exports = router;
