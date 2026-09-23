/**
 * RBAC Routes
 * @module routes/rbacRoutes
 * @description Permission model endpoints. Mounted behind `authenticate`.
 */

const express = require('express');
const router = express.Router();
const rbacController = require('../controllers/rbacController');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/rbac/me
 * The caller's effective modules, submenus and permissions.
 */
router.get('/me', asyncHandler(rbacController.getMyAccess));

/**
 * GET /api/rbac/definition
 * The full role/module/permission matrix (requires Manage Roles).
 */
router.get('/definition', asyncHandler(rbacController.getDefinition));

module.exports = router;
