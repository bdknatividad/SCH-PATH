const express = require('express');
const router = express.Router();
const controller = require('../controllers/accessRequestController');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireSubModule } = require('../middleware/rbac');

router.get('/', asyncHandler(controller.getAll));

/**
 * GET /api/access-requests/history
 * Completed (Approved / Rejected) access requests, newest decision first.
 *
 * Declared before the `/:id` routes so a future `GET /:id` cannot shadow it.
 * The gate is the Documents "Access Request History" submenu, so the tab and
 * the API cannot disagree about who may read the history.
 */
router.get(
  '/history',
  requireSubModule('Documents', 'Access Request History'),
  asyncHandler(controller.getHistory),
);

router.post('/', asyncHandler(controller.create));
router.post('/:id/review', asyncHandler(controller.review));

module.exports = router;
