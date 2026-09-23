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
 */
router.post('/', asyncHandler(childController.create));

/**
 * PUT /api/children/:id
 * Update child record
 */
router.put('/:id', asyncHandler(childController.update));

/**
 * DELETE /api/children/:id
 * Delete child record
 */
router.delete('/:id', asyncHandler(childController.delete));

module.exports = router;
