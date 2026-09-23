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
const { requirePermission, requireSubModule } = require('../middleware/rbac');

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
 */
router.post('/', authorizeNonHouseparent, requirePermission('Documents', 'create'), asyncHandler(documentController.create));

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
