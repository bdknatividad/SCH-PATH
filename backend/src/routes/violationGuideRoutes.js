/**
 * Violation Guide Routes
 * @module routes/violationGuideRoutes
 * @description Routes for managing Violation & Intervention Guide
 */

const express = require('express');
const router = express.Router();
const violationGuideController = require('../controllers/violationGuideController');
const { asyncHandler } = require('../middleware/errorHandler');
const { authorize } = require('../middleware/auth');
const { requireModule } = require('../middleware/rbac');

/**
 * GET /api/violation-guide
 * Get all violation guides
 */
router.get('/', asyncHandler(violationGuideController.getAll));

/**
 * GET /api/violation-guide/intervention-types
 * Get all intervention types (must be before /:id)
 */
router.get('/intervention-types', asyncHandler(violationGuideController.getInterventionTypes));

/**
 * GET /api/violation-guide/interventions/scheduled
 * The caller's scheduled interventions, in one query (must be before /:id).
 *
 * Gated by the Violations module even though this router is not: the endpoint
 * is new, so nothing else depends on reaching it, and a schedule of
 * interventions is Violations data.
 */
router.get(
  '/interventions/scheduled',
  requireModule('Violations'),
  asyncHandler(violationGuideController.getScheduledInterventions)
);

/**
 * GET /api/violation-guide/resident/:residentId/interventions
 * Get intervention tracker for a resident (must be before /:id)
 */
router.get(
  '/resident/:residentId/interventions',
  asyncHandler(violationGuideController.getResidentInterventions)
);

/**
 * POST /api/violation-guide/assign-interventions
 * Assign interventions to a resident based on violation (must be before /:id POST)
 * Requires: centerhead, socialworker, psychologist
 */
router.post(
  '/assign-interventions',
  authorize('centerhead', 'socialworker', 'psychologist'),
  asyncHandler(violationGuideController.assignInterventions)
);

/**
 * GET /api/violation-guide/:id
 * Get violation guide by ID with all interventions
 */
router.get('/:id', asyncHandler(violationGuideController.getById));

/**
 * POST /api/violation-guide
 * Create new violation guide
 * Requires: centerhead, socialworker, psychologist
 */
router.post(
  '/',
  authorize('centerhead', 'socialworker', 'psychologist'),
  asyncHandler(violationGuideController.create)
);

/**
 * PUT /api/violation-guide/:id
 * Update violation guide
 * Requires: centerhead, socialworker, psychologist
 */
router.put(
  '/:id',
  authorize('centerhead', 'socialworker', 'psychologist'),
  asyncHandler(violationGuideController.update)
);

/**
 * DELETE /api/violation-guide/:id
 * Delete (mark as inactive) violation guide
 * Requires: centerhead, socialworker, psychologist
 */
router.delete(
  '/:id',
  authorize('centerhead', 'socialworker', 'psychologist'),
  asyncHandler(violationGuideController.delete)
);

/**
 * PUT /api/violation-guide/intervention-tracker/:id
 * Update intervention status
 * Requires: centerhead, socialworker, psychologist
 */
router.put(
  '/intervention-tracker/:id',
  authorize('centerhead', 'socialworker', 'psychologist', 'houseparent'),
  asyncHandler(violationGuideController.updateInterventionStatus)
);

/**
 * GET /api/violation-guide/intervention-tracker/:id/requirements
 * List requirement-level tracking for an intervention
 */
router.get(
  '/intervention-tracker/:id/requirements',
  asyncHandler(violationGuideController.getInterventionRequirements)
);

/**
 * POST /api/violation-guide/intervention-tracker/:id/requirements
 * Create a new requirement under an intervention
 */
router.post(
  '/intervention-tracker/:id/requirements',
  authorize('centerhead', 'socialworker', 'psychologist'),
  asyncHandler(violationGuideController.createRequirement)
);

/**
 * PUT /api/violation-guide/intervention-requirements/:id
 * Update a requirement status (Done cannot become Overdue).
 */
router.put(
  '/intervention-requirements/:id',
  authorize('centerhead', 'socialworker', 'psychologist', 'houseparent'),
  asyncHandler(violationGuideController.updateRequirement)
);

/**
 * POST /api/violation-guide/refresh-overdue
 * Mark requirements overdue when past dueDate (Done records are safe).
 */
router.post(
  '/refresh-overdue',
  authorize('centerhead', 'socialworker', 'psychologist'),
  asyncHandler(violationGuideController.refreshOverdue)
);

module.exports = router;
