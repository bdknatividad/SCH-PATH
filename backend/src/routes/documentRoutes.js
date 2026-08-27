/**
 * Document Routes
 * @module routes/documentRoutes
 * @description Document management with approval workflow
 */

const express = require('express');
const router = express.Router();
const documentController = require('../controllers/documentController');
const { asyncHandler } = require('../middleware/errorHandler');
const { authorize } = require('../middleware/auth');

/**
 * GET /api/documents
 * Get all documents
 */
router.get('/', asyncHandler(documentController.getAll));

/**
 * GET /api/documents/pending
 * Get pending documents
 */
router.get('/pending', asyncHandler(documentController.getPending));

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
router.get('/:id', asyncHandler(documentController.getById));

/**
 * POST /api/documents
 * Create new document
 */
router.post('/', asyncHandler(documentController.create));

/**
 * PUT /api/documents/:id
 * Update document
 */
router.put('/:id', asyncHandler(documentController.update));

/**
 * POST /api/documents/:id/submit
 * Submit document for review
 */
router.post('/:id/submit', asyncHandler(documentController.submit));

/**
 * POST /api/documents/:id/approve
 * Approve document
 */
router.post('/:id/approve', authorize('centerhead', 'socialworker'), asyncHandler(documentController.approve));

/**
 * POST /api/documents/:id/reject
 * Reject document
 */
router.post('/:id/reject', authorize('centerhead', 'socialworker'), asyncHandler(documentController.reject));

/**
 * DELETE /api/documents/:id
 * Delete document
 */
router.delete('/:id', asyncHandler(documentController.delete));

module.exports = router;
