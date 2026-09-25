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
 * Deliberately not wrapped in `asyncHandler`.
 *
 * The stream handler never resolves — it owns the response for the life of the
 * connection — so `asyncHandler` would await a promise that settles only when the
 * client disconnects, and any throw would reach the error middleware, which would
 * try to write a JSON body onto a response already committed as
 * `text/event-stream`.
 */
const alertStreamHandler = (req, res) => {
  try {
    alertController.stream(req, res);
  } catch (error) {
    console.error('[alerts] opening the notification stream failed:', error.message);
    res.end();
  }
};

/**
 * GET /api/alerts
 * Get all alerts
 */
router.get('/', asyncHandler(alertController.getAll));

/**
 * GET /api/alerts/unread-count
 * Get unread alerts count for the caller
 */
router.get('/unread-count', asyncHandler(alertController.getUnreadCount));

/**
 * GET /api/alerts/urgent
 * Get unread high-priority alerts for the caller
 */
router.get('/urgent', asyncHandler(alertController.getUrgent));

/**
 * GET /api/alerts/resident/:residentId
 * Get alerts by resident (caller's caseload only)
 */
router.get('/resident/:residentId', asyncHandler(alertController.getByResident));

/**
 * GET /api/alerts/stream
 * Server-Sent Events channel: a frame whenever the caller's feed changes.
 *
 * Registered before `/:id` deliberately — Express matches in order, so below the
 * `/:id` route this path would be read as the id "stream" and answer 404.
 */
router.get('/stream', alertStreamHandler);

/**
 * GET /api/alerts/:id
 * Get alert by ID
 */
router.get('/:id', asyncHandler(alertController.getById));

/**
 * POST /api/alerts
 * Create new alert (Center Head / Administrator only)
 */
router.post('/', asyncHandler(alertController.create));

/**
 * POST /api/alerts/mark-all-read
 * Mark every alert the caller can see as read
 */
router.post('/mark-all-read', asyncHandler(alertController.markAllAsRead));

/**
 * POST /api/alerts/:id/read
 * Mark alert as read for the caller
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
