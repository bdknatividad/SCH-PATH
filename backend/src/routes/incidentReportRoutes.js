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
 * Save a completed digital Incident Report against a violation.
 *
 * The four roles the specification names as filers: the Houseparent (who files
 * most of them), the Social Worker, the Center Head, and the Psychological
 * Support Staff. The Psychological Staff used to be absent here, on the reading
 * that the role could not create an incident — the role files the form and signs
 * it, so it is authorized now.
 */
router.post('/', authorize('socialworker', 'centerhead', 'houseparent', 'psychologist'), asyncHandler(incidentReportController.create));

/**
 * GET /api/incident-reports/violation/:violationId
 * Fetch the incident report tied to a specific violation.
 */
router.post('/:id/resubmit', authorize('socialworker', 'centerhead', 'houseparent', 'admin', 'psychologist'), asyncHandler(incidentReportController.resubmit));

router.get('/violation/:violationId', canReadIncidentForms, asyncHandler(incidentReportController.getByViolationId));

/**
 * GET /api/incident-reports/resident/:residentId
 * List incident reports for a resident.
 */
router.get('/resident/:residentId', canReadIncidentForms, asyncHandler(incidentReportController.getByResidentId));

/**
 * POST /api/incident-reports/:id/verify
 * Sign Form 08. It carries THREE signatures — the Social Worker signs "Checked
 * by", the Psychological Support Staff signs the clinical line, and the Center
 * Head signs "Noted by" last — so all three roles reach this endpoint and each
 * call fills exactly one line with the drawn signature it sends.
 *
 * The route is the same for all three because the side is derived from the
 * caller's role, never requested: a role can only fill its own line, so no
 * account can sign on someone else's behalf. The Center Head is refused until
 * both Stage-1 lines are in, and `status` only becomes 'Verified' — and the
 * linked document only 'Approved' — once all three are present.
 *
 * The capability, not the role name, is the gate — so a future role granted
 * `verify` on Violations inherits the endpoint with no route change. The
 * Houseparent holds `view` alone, which is what keeps them out of signing on the
 * API as well as in the menu.
 */
router.post(
  '/:id/verify',
  authorize('psychologist', 'socialworker', 'centerhead'),
  requirePermission('Violations', 'verify'),
  asyncHandler(incidentReportController.verify),
);

module.exports = router;
