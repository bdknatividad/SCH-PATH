/**
 * Assessment Routes
 * @module routes/assessmentRoutes
 * @description Assessment scheduling and management endpoints
 */

const express = require('express');
const router = express.Router();
const assessmentController = require('../controllers/assessmentController');
const { asyncHandler } = require('../middleware/errorHandler');
const { authorize } = require('../middleware/auth');
const { requireModule } = require('../middleware/rbac');

/**
 * Every route here belongs to the Assessments module, so every route carries
 * its gate — a role without the module must not read the table by calling the
 * API directly. The write routes also name the roles, which keeps the two
 * statements of the rule in step: the role list says who writes, the module gate
 * says who may look at all.
 *
 * `GET /upcoming` is the one exception and is deliberately left ungated: the
 * Nurse's dashboard shows "Upcoming Assessments" but the role holds no
 * Assessments module, so this read-only schedule is its one window onto the
 * table. It returns scheduled rows only — no draft, no completed assessment.
 */
const inAssessments = requireModule('Assessments');

/**
 * GET /api/assessments
 * Get all assessments
 */
router.get('/', inAssessments, asyncHandler(assessmentController.getAll));

/**
 * GET /api/assessments/upcoming
 * Get upcoming assessments
 *
 * Ungated on purpose — see `inAssessments` above.
 */
router.get('/upcoming', asyncHandler(assessmentController.getUpcoming));

/**
 * GET /api/assessments/pending-count
 * Get pending assessments count
 */
router.get('/pending-count', inAssessments, asyncHandler(assessmentController.getPendingCount));

/**
 * GET /api/assessments/resident/:residentId
 * Get assessments by resident
 */
router.get('/resident/:residentId', inAssessments, asyncHandler(assessmentController.getByResident));

/**
 * GET /api/assessments/:id
 * Get assessment by ID
 */
router.get('/:id', inAssessments, asyncHandler(assessmentController.getById));

/**
 * POST /api/assessments
 * Create new assessment
 * Houseparents and Social Workers have view-only access to assessments.
 */
router.post('/', inAssessments, authorize('centerhead', 'admin', 'psychologist', 'educator'), asyncHandler(assessmentController.create));

/**
 * PUT /api/assessments/:id
 * Update assessment
 * Houseparents and Social Workers have view-only access to assessments.
 */
router.put('/:id', inAssessments, authorize('centerhead', 'admin', 'psychologist', 'educator'), asyncHandler(assessmentController.update));

/**
 * POST /api/assessments/:id/complete
 * Mark assessment as completed
 * Houseparents and Social Workers have view-only access to assessments.
 */
router.post('/:id/complete', inAssessments, authorize('centerhead', 'admin', 'psychologist', 'educator'), asyncHandler(assessmentController.complete));

/**
 * DELETE /api/assessments/:id
 * Delete assessment
 * Houseparents and Social Workers have view-only access to assessments.
 */
router.delete('/:id', inAssessments, authorize('centerhead', 'admin', 'psychologist', 'educator'), asyncHandler(assessmentController.delete));

module.exports = router;
