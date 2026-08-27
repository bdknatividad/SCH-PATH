/**
 * User Routes
 * @module routes/userRoutes
 * @description Authentication and user management endpoints
 */

const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate, authorize } = require('../middleware/auth');

/**
 * GET /api/users
 * Get all users
 */
router.get('/', authenticate, authorize('centerhead'), asyncHandler(userController.getAll));

router.post('/login', asyncHandler(userController.login));

router.post('/register', authenticate, authorize('centerhead'), asyncHandler(userController.register));

router.get('/profile', authenticate, asyncHandler(userController.getProfile));

router.put('/profile', authenticate, asyncHandler(userController.updateProfile));

router.post('/change-password', authenticate, asyncHandler(userController.changePassword));

/**
 * GET /api/users/:id
 * Get user by ID
 */
router.get('/:id', authenticate, authorize('centerhead'), asyncHandler(userController.getById));

/**
 * POST /api/users
 * Create new user
 */
router.post('/', authenticate, authorize('centerhead'), asyncHandler(userController.register));

/**
 * PUT /api/users/:id
 * Update user by ID (admin use)
 */
router.put('/:id', authenticate, authorize('centerhead'), asyncHandler(userController.updateById));

/**
 * DELETE /api/users/:id
 * Delete user by ID
 */
router.delete('/:id', authenticate, authorize('centerhead'), asyncHandler(userController.deleteById));

module.exports = router;
