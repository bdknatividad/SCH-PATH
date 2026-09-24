/**
 * Incident Report Routes
 * @module routes/incidentReportRoutes
 * @description Digital Form 08 — create, fetch, and verify incident reports
 */

const express = require('express');
const router = express.Router();
const incidentReportController = require('../controllers/incidentReportController');
const { asyncHandler } = require('../middleware/errorHandler');
const { authorize } = require('../middleware/auth');
const { requireModule, requirePermission } = require('../middleware/rbac');

/**
 * Incident forms belong to the Violations module. Reading one therefore requires
 * holding that module — otherwise the endpoint is a direct-API bypass for a role
 * whose menu never offers it. The Psychological Staff holds Violations, so this is a
 * no-op for them; it closes the path for every role that does not.
 */
const canReadIncidentForms = requireModule('Violations');

/**
 * POST /api/incident-reports
 * Social Worker saves a completed digital Incident Report against a violation.
 * The Psychological Staff is deliberately absent: the specification forbids creating
 * an incident.
 */
router.post('/', authorize('socialworker', 'centerhead', 'houseparent'), asyncHandler(incidentReportController.create));

/**
 * GET /api/incident-reports/violation/:violationId
 * Fetch the incident report tied to a specific violation.
 */
router.post('/:id/resubmit', authorize('socialworker', 'centerhead', 'houseparent', 'admin'), asyncHandler(incidentReportController.resubmit));

router.get('/violation/:violationId', canReadIncidentForms, asyncHandler(incidentReportController.getByViolationId));

/**
 * GET /api/incident-reports/resident/:residentId
 * List incident reports for a resident.
 */
router.get('/resident/:residentId', canReadIncidentForms, asyncHandler(incidentReportController.getByResidentId));

/**
 * POST /api/incident-reports/:id/verify
 * Verify the report. Form 08 takes TWO verifications — the Psychological Staff
 * signs the clinical side and the Social Worker counter-signs — so both roles
 * reach this endpoint and each signature fills its own slot. `status` only
 * becomes 'Verified' once both are present.
 *
 * The capability, not the role name, is the gate — so a future role granted
 * `verify` on Violations inherits the endpoint with no route change. The
 * Houseparent holds `view` alone, which is what keeps them out of verification
 * on the API as well as in the menu.
 *
 * `centerhead`/`admin` are full-access and may sign either side, but they must
 * say which (`verificationSide`), so one account cannot complete the form alone.
 */
router.post(
  '/:id/verify',
  authorize('psychologist', 'socialworker', 'centerhead'),
  requirePermission('Violations', 'verify'),
  asyncHandler(incidentReportController.verify),
);

module.exports = router;
