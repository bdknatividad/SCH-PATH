/**
 * User Routes
 * @module routes/userRoutes
 * @description Authentication and user management endpoints
 */

const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/users
 * Get all users
 */
router.get('/', asyncHandler(userController.getAll));

/**
 * GET /api/users/:id
 * Get user by ID
 */
router.get('/:id', asyncHandler(userController.getById));

/**
 * POST /api/users
 * Create new user
 */
router.post('/', asyncHandler(userController.register));

/**
 * PUT /api/users/:id
 * Update user by ID (admin use)
 */
router.put('/:id', asyncHandler(userController.updateById));

/**
 * DELETE /api/users/:id
 * Delete user by ID
 */
router.delete('/:id', asyncHandler(userController.deleteById));

/**
 * POST /api/auth/login
 * Authenticate user and return JWT token
 */
router.post('/login', asyncHandler(userController.login));

/**
 * POST /api/auth/register
 * Register new user (public)
 */
router.post('/register', asyncHandler(userController.register));

/**
 * GET /api/auth/profile
 * Get current user profile
 */
router.get('/profile', asyncHandler(userController.getProfile));

/**
 * PUT /api/auth/profile
 * Update user profile
 */
router.put('/profile', asyncHandler(userController.updateProfile));

/**
 * POST /api/auth/change-password
 * Change user password
 */
router.post('/change-password', asyncHandler(userController.changePassword));

module.exports = router;
