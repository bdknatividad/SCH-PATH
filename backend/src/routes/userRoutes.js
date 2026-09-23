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
const { createRateLimiter } = require('../middleware/rateLimit');

// Throttle credential submission. Without this, /login accepts unlimited
// password guesses against any account name.
const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Please wait a few minutes and try again.',
});

/**
 * GET /api/users
 * Get all users
 */
router.get('/', authenticate, authorize('centerhead'), asyncHandler(userController.getAll));

router.post('/login', loginRateLimiter, asyncHandler(userController.login));

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
router.put('/:id/access', authenticate, authorize('centerhead'), asyncHandler(userController.updateAccess));

/**
 * DELETE /api/users/:id
 * Delete user by ID
 */
router.delete('/:id', authenticate, authorize('centerhead'), asyncHandler(userController.deleteById));

module.exports = router;
