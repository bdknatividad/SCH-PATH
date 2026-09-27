/**
 * Dashboard Routes
 * @module routes/dashboardRoutes
 * @description Database-backed counts for the Dashboard. Each kind of schedule
 * is gated by its own module inside the controller, so the mount itself is not
 * module-gated: a role that holds only some of the modules still gets the
 * parts it may see.
 */
const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { asyncHandler } = require('../middleware/errorHandler');
const { authorize } = require('../middleware/auth');

router.get('/schedule-summary', asyncHandler(dashboardController.scheduleSummary));

/**
 * GET /api/dashboard/center-head — the Center Head's command centre.
 *
 * Gated by role rather than by module, matching `/tri/summary` and
 * `/tri/monitor`: this is management reporting over every module at once, and a
 * full-access role passes regardless. The `admin` role is named alongside
 * `centerhead` because `isFullAccessRole` covers both and the two labels are the
 * same screen.
 */
router.get(
  '/center-head',
  authorize('centerhead', 'admin'),
  asyncHandler(dashboardController.centerHeadOverview),
);

module.exports = router;
