/**
 * Report Routes
 * @module routes/reportRoutes
 * @description Report generation endpoints
 */

const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/reports
 * Get all reports
 */
router.get('/', asyncHandler(reportController.getAll));

/**
 * GET /api/reports/:id
 * Get report by ID
 */
router.get('/:id', asyncHandler(reportController.getById));

/**
 * POST /api/reports
 * Create custom report
 */
router.post('/', asyncHandler(reportController.create));

/**
 * POST /api/reports/generate-daily
 * Generate daily report
 */
router.post('/generate-daily', asyncHandler(reportController.createDaily));

/**
 * GET /api/reports/daily-data
 * Get daily report data (manual trigger)
 */
router.get('/daily-data', asyncHandler(reportController.getDaily));

/**
 * POST /api/reports/generate-quarterly
 * Generate quarterly DSWD report
 */
router.post('/generate-quarterly', asyncHandler(reportController.createQuarterly));

/**
 * PUT /api/reports/:id
 * Update report
 */
router.put('/:id', asyncHandler(reportController.update));

/**
 * DELETE /api/reports/:id
 * Delete report
 */
router.delete('/:id', asyncHandler(reportController.delete));

module.exports = router;
