/**
 * Health Record Routes
 * @module routes/healthRoutes
 * @description Health record and vital signs endpoints
 */

const express = require('express');
const router = express.Router();
const healthController = require('../controllers/healthController');
const { asyncHandler } = require('../middleware/errorHandler');
const { requirePermission } = require('../middleware/rbac');

/**
 * GET /api/health
 * Get all health records
 */
router.get('/', asyncHandler(healthController.getAll));

/**
 * GET /api/health/resident/:residentId
 * Get health records by resident
 */
router.get('/resident/:residentId', asyncHandler(healthController.getByResident));

/**
 * GET /api/health/resident/:residentId/latest
 * Get latest health record for resident
 */
router.get('/resident/:residentId/latest', asyncHandler(healthController.getLatest));

/**
 * GET /api/health/resident/:residentId/stats
 * Get health statistics for resident
 */
router.get('/resident/:residentId/stats', asyncHandler(healthController.getStats));

/**
 * GET /api/health/:id
 * Get health record by ID
 */
router.get('/:id', asyncHandler(healthController.getById));

/**
 * POST /api/health
 * Create new health record
 *
 * The mount carries the Health module gate; these three carry the capability, so
 * an account granted Health read-only cannot write a medical record — or, through
 * it, file a document into the resident's Medical Records folder.
 */
router.post('/', requirePermission('Health', 'create'), asyncHandler(healthController.create));

/**
 * PUT /api/health/:id
 * Update health record
 */
router.put('/:id', requirePermission('Health', 'edit'), asyncHandler(healthController.update));

/**
 * POST /api/health/:id/prescription-given
 * Mark a prescription (Medication Log) as given, or clear that.
 *
 * Its own route rather than a `PUT` because `update` re-publishes the record's
 * document and validates the whole record — a checkbox should not rewrite the
 * child's filed copy. Both the Health module and Child Records → Medical call
 * this one route, so the two views cannot disagree.
 */
router.post('/:id/prescription-given', requirePermission('Health', 'edit'), asyncHandler(healthController.markPrescriptionGiven));

/**
 * DELETE /api/health/:id
 * Delete health record
 */
router.delete('/:id', requirePermission('Health', 'delete'), asyncHandler(healthController.delete));

module.exports = router;
