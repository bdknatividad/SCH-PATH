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
 * DELETE /api/health/:id
 * Delete health record
 */
router.delete('/:id', requirePermission('Health', 'delete'), asyncHandler(healthController.delete));

module.exports = router;
