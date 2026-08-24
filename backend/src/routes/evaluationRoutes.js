/**
 * Activity Evaluation Routes
 * @module routes/evaluationRoutes
 * @description Activity/resident evaluation endpoints
 */

const express = require('express');
const router = express.Router();
const evaluationController = require('../controllers/evaluationController');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/evaluations
 * Get all evaluations
 */
router.get('/', asyncHandler(evaluationController.getAll));

/**
 * GET /api/evaluations/activity/:activityId
 * Get evaluations by activity
 */
router.get('/activity/:activityId', asyncHandler(evaluationController.getByActivity));

/**
 * GET /api/evaluations/activity/:activityId/average
 * Get average rating for activity
 */
router.get('/activity/:activityId/average', asyncHandler(evaluationController.getAverageByActivity));

/**
 * GET /api/evaluations/resident/:residentId
 * Get evaluations by resident
 */
router.get('/resident/:residentId', asyncHandler(evaluationController.getByResident));

/**
 * GET /api/evaluations/:id
 * Get evaluation by ID
 */
router.get('/:id', asyncHandler(evaluationController.getById));

/**
 * POST /api/evaluations
 * Create new evaluation
 */
router.post('/', asyncHandler(evaluationController.create));

/**
 * PUT /api/evaluations/:id
 * Update evaluation
 */
router.put('/:id', asyncHandler(evaluationController.update));

/**
 * DELETE /api/evaluations/:id
 * Delete evaluation
 */
router.delete('/:id', asyncHandler(evaluationController.delete));

module.exports = router;
