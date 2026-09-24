/**
 * Child/Resident Routes
 * @module routes/childRoutes
 * @description Resident management endpoints
 */

const express = require('express');
const router = express.Router();
const childController = require('../controllers/childController');
const { asyncHandler } = require('../middleware/errorHandler');
const { requirePermission } = require('../middleware/rbac');

/**
 * GET /api/children
 * Get all children with optional filters
 */
router.get('/', asyncHandler(childController.getAll));

/**
 * GET /api/children/incomplete-documents
 * Get children with incomplete documents
 */
router.get('/incomplete-documents', asyncHandler(childController.getIncompleteDocuments));

/**
 * GET /api/children/performance-ratings
 * Get ratings for the previous completed month.
 */
router.get('/performance-ratings', asyncHandler(childController.getMonthlyPerformanceRatings));

/**
 * POST /api/children/:id/readmit
 * Re-admit a discharged child with a new case cycle
 * MUST be before /:id routes to avoid being caught by getById
 *
 * Gated on the Child Records `edit` capability rather than left open: a
 * re-admission writes the resident's case cycle, and the Educator's Personal
 * Info access is view-only ("cannot access Admissions").
 */
router.post(
  '/:id/readmit',
  requirePermission('Child Records', 'edit'),
  asyncHandler(childController.readmit),
);

/**
 * POST /api/children/:id/toggle-psych-assessment
 * Toggle the needsPsychAssessment flag for conditional Psychological Assessment requirement
 */
router.post(
  '/:id/toggle-psych-assessment',
  requirePermission('Child Records', 'edit'),
  asyncHandler(childController.togglePsychAssessment),
);

/**
 * GET /api/children/:id
 * Get child by ID with full details
 */
router.get('/:id', asyncHandler(childController.getById));

/**
 * POST /api/children
 * Create new child record
 *
 * Gated at the route, like the other writes on this router. The controller
 * re-checks the same thing (`isManager`) — that is defence in depth rather than
 * duplication: a route-level guard cannot be forgotten by a controller that
 * later grows another entry point, and the controller check still holds if this
 * router is ever remounted without one.
 *
 * `Child Records.create` is held by Center Head, Admin and Social Worker, which
 * is exactly the set `isManager` admits, so this denies nobody who could write
 * before.
 */
router.post('/', requirePermission('Child Records', 'create'), asyncHandler(childController.create));

/**
 * PUT /api/children/:id
 * Update child record
 *
 * `edit` is held more widely than the controller's `canModifyResident` — the
 * Nurse and the Psychological Staff hold it too — so this narrows nothing by
 * itself. The per-resident check inside the controller is what actually decides
 * an update; this guard is here so the module boundary is enforced at the edge
 * as well.
 */
router.put('/:id', requirePermission('Child Records', 'edit'), asyncHandler(childController.update));

/**
 * DELETE /api/children/:id
 * Delete child record
 *
 * `delete` is held by Center Head, Admin and Social Worker — again the same set
 * the controller's `isManager` admits.
 */
router.delete('/:id', requirePermission('Child Records', 'delete'), asyncHandler(childController.delete));

module.exports = router;
