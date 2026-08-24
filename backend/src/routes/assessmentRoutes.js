/**
 * Assessment Routes
 * @module routes/assessmentRoutes
 * @description Assessment scheduling and management endpoints
 */

const express = require('express');
const router = express.Router();
const assessmentController = require('../controllers/assessmentController');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/assessments
 * Get all assessments
 */
router.get('/', asyncHandler(assessmentController.getAll));

/**
 * GET /api/assessments/upcoming
 * Get upcoming assessments
 */
router.get('/upcoming', asyncHandler(assessmentController.getUpcoming));

/**
 * GET /api/assessments/pending-count
 * Get pending assessments count
 */
router.get('/pending-count', asyncHandler(assessmentController.getPendingCount));

/**
 * GET /api/assessments/resident/:residentId
 * Get assessments by resident
 */
router.get('/resident/:residentId', asyncHandler(assessmentController.getByResident));

/**
 * GET /api/assessments/:id
 * Get assessment by ID
 */
router.get('/:id', asyncHandler(assessmentController.getById));

/**
 * POST /api/assessments
 * Create new assessment
 */
router.post('/', asyncHandler(assessmentController.create));

/**
 * PUT /api/assessments/:id
 * Update assessment
 */
router.put('/:id', asyncHandler(assessmentController.update));

/**
 * POST /api/assessments/:id/complete
 * Mark assessment as completed
 */
router.post('/:id/complete', asyncHandler(assessmentController.complete));

/**
 * DELETE /api/assessments/:id
 * Delete assessment
 */
router.delete('/:id', asyncHandler(assessmentController.delete));

module.exports = router;
