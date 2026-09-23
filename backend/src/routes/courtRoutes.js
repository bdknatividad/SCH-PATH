/**
 * Court Record Routes
 * @module routes/courtRoutes
 * @description Court hearing and legal case endpoints
 */

const express = require('express');
const router = express.Router();
const courtController = require('../controllers/courtController');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/court
 * Get all court records
 */
router.get('/', asyncHandler(courtController.getAll));

/**
 * GET /api/court/upcoming
 * Get upcoming hearings
 */
router.get('/upcoming', asyncHandler(courtController.getUpcoming));

/**
 * GET /api/court/by-date-range
 * Get hearings by date range
 */
router.get('/by-date-range', asyncHandler(courtController.getByDateRange));

/**
 * GET /api/court/resident/:residentId
 * Get court records by resident
 */
router.get('/resident/:residentId', asyncHandler(courtController.getByResident));

/**
 * GET /api/court/:id
 * Get court record by ID
 */
router.get('/:id', asyncHandler(courtController.getById));

/**
 * POST /api/court
 * Create new court record
 */
router.post('/', asyncHandler(courtController.create));

/**
 * PUT /api/court/:id
 * Update court record
 */
router.put('/:id', asyncHandler(courtController.update));

/**
 * DELETE /api/court/:id
 * Delete court record
 */
router.delete('/:id', asyncHandler(courtController.delete));

module.exports = router;
