const express = require('express');
const router = express.Router();
const triController = require('../controllers/triController');
const { asyncHandler } = require('../middleware/errorHandler');
const { authorize, authorizeNonHouseparent } = require('../middleware/auth');
const { requireModule } = require('../middleware/rbac');

// The aggregate views below are management reporting: the Dashboard renders them
// only for socialworker / centerhead / admin. That restriction used to live in the
// component alone, so any authenticated user could read the same data by calling the
// endpoint directly. Gated here to match the client exactly. The per-resident
// endpoints (`/resident/:id/history`, `/resident/:id/deductions`) stay open — the TRI
// form and the child record page use them for every role.
router.get('/summary', authorize('socialworker', 'centerhead', 'admin'), asyncHandler(triController.summary));
// Violation data, so the gate is the module that owns it. The TRI form is the only
// caller, and every role that reaches it holds Violations — which keeps an
// Educator, whose specification says it cannot access Violations, out.
router.get(
  '/resident/:residentId/violations',
  requireModule('Violations'),
  asyncHandler(triController.referenceViolations),
);
router.get('/resident/:residentId/history', asyncHandler(triController.residentHistory));
router.get(
  '/resident/:residentId/deductions',
  requireModule('Violations'),
  asyncHandler(triController.offenseDeductions),
);
router.get('/monitor', authorize('socialworker', 'centerhead', 'admin'), asyncHandler(triController.monitor));
// The TRI list is the Houseparent module's own surface. Ungated it returned every
// TRI record in the facility to any authenticated account — the direct-API
// counterpart of the sidebar entry the role matrix already withholds.
router.get('/', requireModule('Houseparent'), asyncHandler(triController.list));
router.post('/', authorize('socialworker', 'centerhead', 'admin', 'houseparent'), asyncHandler(triController.create));
router.get('/:id', requireModule('Houseparent'), asyncHandler(triController.getById));
router.put('/:id', authorize('socialworker', 'centerhead', 'admin', 'houseparent'), asyncHandler(triController.update));
router.post('/:id/submit', authorize('socialworker', 'centerhead', 'admin', 'houseparent'), asyncHandler(triController.submit));
// The "Houseparent" signature line on page 8 of the form belongs to the Houseparent
// and to nobody else. A Center Head or Social Worker used to be able to write it on
// the Houseparent's behalf; that is no longer the workflow. Their part is to approve
// or return the submitted TRI (`/finalize`, `/return`) — neither of which touches a
// signature. Kept narrow on purpose: widening this list would let a reviewer sign
// the very document they are reviewing.
router.post('/:id/signature', authorize('houseparent'), asyncHandler(triController.sign));
router.post('/:id/review', authorize('socialworker', 'centerhead', 'admin'), asyncHandler(triController.review));
router.post('/:id/return', authorize('socialworker', 'centerhead', 'admin'), asyncHandler(triController.returnForRevision));
router.post('/:id/finalize', authorize('socialworker', 'centerhead', 'admin'), asyncHandler(triController.finalize));

module.exports = router;
