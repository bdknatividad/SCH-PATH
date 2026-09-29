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
  const program = PROGRESS_REPORT_PROGRAM_BY_TYPE[String(req.body?.type || '').trim()];
  if (program) {
    const snapshot = snapshotFor(req);
    if (hasModuleAccess(snapshot, program) && hasPermission(snapshot, program, 'create')) {
      return next();
    }
  }
  return requirePermission('Documents', 'create')(req, res, next);
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
 */
router.put('/:id', authorizeNonHouseparent, requirePermission('Documents', 'edit'), asyncHandler(documentController.update));

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
