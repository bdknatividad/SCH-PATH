/**
 * Violation Routes
 * @module routes/violationRoutes
 * @description Violation logging with auto-alerts
 */

const express = require('express');
const router = express.Router();
const violationController = require('../controllers/violationController');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/violations
 * Get all violations
 */
router.get('/', asyncHandler(violationController.getAll));

/**
 * GET /api/violations/matrix
 * Get violation decision matrix (must be before /:id)
 */
router.get('/matrix', asyncHandler(violationController.getMatrix));

/**
 * GET /api/violations/resident/:residentId/stats
 * Get violation statistics for resident (must be before /:id)
 */
router.get('/resident/:residentId/stats', asyncHandler(violationController.getStats));

/**
 * GET /api/violations/:id
 * Get violation by ID
 */
router.get('/:id', asyncHandler(violationController.getById));

/**
 * POST /api/violations
 * Create new violation (triggers auto-alerts)
 */
router.post('/', asyncHandler(violationController.create));

/**
 * POST /api/violations/:id/review
 * Psychologist reviews a violation — confirm/adjust severity, change status to Reviewed
 */
router.post('/:id/review', asyncHandler(violationController.review));

/**
 * PUT /api/violations/:id
 * Update violation
 */
router.put('/:id', asyncHandler(violationController.update));

/**
 * DELETE /api/violations/:id
 * Delete violation
 */
router.delete('/:id', asyncHandler(violationController.delete));

module.exports = router;
