/**
 * Activity Routes
 * @module routes/activityRoutes
 * @description Activity and event management endpoints
 */

const express = require('express');
const router = express.Router();
const activityController = require('../controllers/activityController');
const { asyncHandler } = require('../middleware/errorHandler');
const { authorizeNonHouseparent } = require('../middleware/auth');

/**
 * GET /api/activities
 * Get all activities
 */
router.get('/', asyncHandler(activityController.getAll));

/**
 * GET /api/activities/upcoming
 * Get upcoming activities
 */
router.get('/upcoming', asyncHandler(activityController.getUpcoming));

/**
 * GET /api/activities/by-date-range
 * Get activities by date range
 */
router.get('/by-date-range', asyncHandler(activityController.getByDateRange));

/**
 * GET /api/activities/type/:type
 * Get activities by type
 */
router.get('/type/:type', asyncHandler(activityController.getByType));

/**
 * GET /api/activities/:id
 * Get activity by ID
 */
router.get('/:id', asyncHandler(activityController.getById));

/**
 * POST /api/activities
 * Create new activity
 */
router.post('/', authorizeNonHouseparent, asyncHandler(activityController.create));

/**
 * PUT /api/activities/:id
 * Update activity
 */
router.put('/:id', authorizeNonHouseparent, asyncHandler(activityController.update));

/**
 * POST /api/activities/:id/complete
 * Mark activity as completed
 */
router.post('/:id/complete', authorizeNonHouseparent, asyncHandler(activityController.complete));

/**
 * DELETE /api/activities/:id
 * Delete activity
 */
router.delete('/:id', authorizeNonHouseparent, asyncHandler(activityController.delete));

module.exports = router;
