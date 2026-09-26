/**
 * Violation Routes
 * @module routes/violationRoutes
 * @description Violation logging with auto-alerts
 */

const express = require('express');
const router = express.Router();
const violationController = require('../controllers/violationController');
const { asyncHandler } = require('../middleware/errorHandler');
const { authorize } = require('../middleware/auth');
const { requireModule } = require('../middleware/rbac');

/**
 * Reading a violation is a Violations-module capability. The SPA reads this data
 * from the store payload (already module-gated), so these guards close the
 * direct-API path rather than changing any menu-visible behaviour: a role whose
 * sidebar has no Violations entry has no legitimate reason to call them.
 */
const canReadViolations = requireModule('Violations');

/**
 * GET /api/violations
 * Get all violations
 */
router.get('/', canReadViolations, asyncHandler(violationController.getAll));

/**
 * GET /api/violations/matrix
 * Get violation decision matrix (must be before /:id)
 */
router.get('/matrix', canReadViolations, asyncHandler(violationController.getMatrix));

/**
 * GET /api/violations/resident/:residentId/stats
 * Get violation statistics for resident (must be before /:id)
 */
router.get('/resident/:residentId/stats', canReadViolations, asyncHandler(violationController.getStats));

/**
 * GET /api/violations/:id
 * Get violation by ID
 */
router.get('/:id/review-preview', authorize('psychologist', 'socialworker', 'centerhead'), asyncHandler(violationController.getReviewPreview));

router.get('/:id', canReadViolations, asyncHandler(violationController.getById));

/**
 * POST /api/violations
 * Create new violation (triggers auto-alerts)
 *
 * The Houseparent is deliberately absent. The Houseparent specification lists
 * "Create/Edit/Delete incidents" under what the role may *not* do, and nothing
 * grants it elsewhere — the incident logger is gone from the interface too,
 * because the Violations module now carries `view` alone. Leaving the role in
 * this list would have kept a direct-API path to a workflow with no screen.
 *
 * The role records what happens on the floor as an Anecdotal Report, which is
 * the Houseparent module's own `create` grant — not as a violation.
 *
 * The "Log Incident" buttons are gated on this same `create` capability
 * (`ChildDetail.tsx`, `Violations.tsx`) rather than on a role exclusion. They
 * used to be hidden for the Houseparent by name and shown to everyone else,
 * including the Nurse and the Educator, who hold no Violations module at all —
 * so the button was visible to roles the route then refused.
 */
// A Houseparent may log (add) an incident for a resident on their own Case Load;
// the controller's canAccessResident check refuses anyone else's resident.
router.post('/', authorize('socialworker', 'centerhead', 'houseparent'), asyncHandler(violationController.create));

/**
 * POST /api/violations/:id/review
 * Psychological Staff reviews a violation — confirm/adjust severity, change status to Reviewed
 */
// Dual verification: the Psychological Support Staff and the Social Worker
// both verify a logged incident; it proceeds only when both have.
router.post('/:id/review', authorize('psychologist', 'socialworker', 'centerhead'), asyncHandler(violationController.review));

/**
 * POST /api/violations/:id/resubmit
 * The reporter corrects a rejected report and sends it back for verification.
 *
 * The reporter's own route, so the roles that can log an incident are the ones
 * that can correct one. The controller additionally requires the caller to be
 * the reporter or a verifier, so a Houseparent cannot resubmit another
 * Houseparent's incident.
 */
router.post('/:id/resubmit', authorize('socialworker', 'centerhead', 'houseparent'), asyncHandler(violationController.resubmit));

/**
 * POST /api/violations/:id/mark-done
 * Mark an intervention as Done from the Intervention Tracker.
 *
 * The tracker is a tab of the Violations module, so completing an intervention
 * requires holding that module. The Nurse was in this role list while the role
 * still carried Violations; the specification now grants only Dashboard, Child
 * Records, Health and Documents, which leaves the tracker unreachable from the
 * interface — so the entry here would be a direct-API path to a workflow the
 * role has no screen for.
 */
router.post(
  '/:id/mark-done',
  authorize('socialworker', 'centerhead', 'psychologist', 'houseparent'),
  requireModule('Violations'),
  asyncHandler(violationController.markDone),
);

/**
 * PUT /api/violations/:id
 * Update violation
 */
router.put('/:id', authorize('socialworker', 'centerhead'), asyncHandler(violationController.update));

/**
 * DELETE /api/violations/:id
 * Delete violation
 */
router.delete('/:id', authorize('socialworker', 'centerhead'), asyncHandler(violationController.delete));

module.exports = router;
