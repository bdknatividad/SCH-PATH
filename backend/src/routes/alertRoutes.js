/**
 * Alert Routes
 * @module routes/alertRoutes
 * @description Alert and notification endpoints
 */

const express = require('express');
const router = express.Router();
const alertController = require('../controllers/alertController');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/alerts
 * Get all alerts
 */
router.get('/', asyncHandler(alertController.getAll));

/**
 * GET /api/alerts/unread-count
 * Get unread alerts count
 */
router.get('/unread-count', asyncHandler(alertController.getUnreadCount));

/**
 * GET /api/alerts/urgent
 * Get urgent alerts
 */
router.get('/urgent', asyncHandler(alertController.getUrgent));

/**
 * GET /api/alerts/resident/:residentId
 * Get alerts by resident
 */
router.get('/resident/:residentId', asyncHandler(alertController.getByResident));

/**
 * GET /api/alerts/:id
 * Get alert by ID
 */
router.get('/:id', asyncHandler(alertController.getById));

/**
 * POST /api/alerts
 * Create new alert
 */
router.post('/', asyncHandler(alertController.create));

/**
 * POST /api/alerts/:id/read
 * Mark alert as read
 */
router.post('/:id/read', asyncHandler(alertController.markAsRead));

/**
 * PUT /api/alerts/:id
 * Update alert
 */
router.put('/:id', asyncHandler(alertController.update));

/**
 * DELETE /api/alerts/:id
 * Delete alert
 */
router.delete('/:id', asyncHandler(alertController.delete));

module.exports = router;
