/**
 * Staff Routes
 * @module routes/staffRoutes
 * @description Staff/personnel management endpoints
 */

const express = require('express');
const router = express.Router();
const staffController = require('../controllers/staffController');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/staff
 * Get all staff
 */
router.get('/', asyncHandler(staffController.getAll));

/**
 * GET /api/staff/active
 * Get active staff members
 */
router.get('/active', asyncHandler(staffController.getActive));

/**
 * GET /api/staff/department/:department
 * Get staff by department
 */
router.get('/department/:department', asyncHandler(staffController.getByDepartment));

/**
 * GET /api/staff/position/:position
 * Get staff by position
 */
router.get('/position/:position', asyncHandler(staffController.getByPosition));

/**
 * GET /api/staff/:id
 * Get staff by ID
 */
router.get('/:id', asyncHandler(staffController.getById));

/**
 * POST /api/staff
 * Create new staff record
 */
router.post('/', asyncHandler(staffController.create));

/**
 * PUT /api/staff/:id
 * Update staff record
 */
router.put('/:id', asyncHandler(staffController.update));

/**
 * DELETE /api/staff/:id
 * Delete staff record
 */
router.delete('/:id', asyncHandler(staffController.delete));

module.exports = router;
