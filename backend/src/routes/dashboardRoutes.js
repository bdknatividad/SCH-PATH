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

router.get('/schedule-summary', asyncHandler(dashboardController.scheduleSummary));

module.exports = router;
