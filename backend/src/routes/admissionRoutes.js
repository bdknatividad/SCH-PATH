const express = require('express');

const router = express.Router();

const admissionController = require('../controllers/admissionController');
const { asyncHandler } = require('../middleware/errorHandler');
const { requirePermission } = require('../middleware/rbac');

// Reads stay open on purpose: the Admission Slip is rendered inside the Child
// Records Personal Info tab, which every role that holds Child Records can open.
// The *writes* are what "cannot access Admissions" withholds, so they are gated
// on the Child Records create/edit capability — a view-only Child Records grant
// (the Educator) is refused here even though it can read the slip.

router.get(
  '/resident/:residentId/latest',
  asyncHandler(admissionController.getLatestForResident)
);

router.get(
  '/resident/:residentId',
  asyncHandler(admissionController.getByResident)
);

router.get(
  '/:id',
  asyncHandler(admissionController.getById)
);

router.post(
  '/',
  requirePermission('Child Records', 'create'),
  asyncHandler(admissionController.create)
);

router.put(
  '/:id',
  requirePermission('Child Records', 'edit'),
  asyncHandler(admissionController.update)
);

module.exports = router;