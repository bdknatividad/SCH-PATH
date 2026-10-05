/**
 * Physical Examination routes.
 *
 * Reading follows the resident (the same rule as the Admission Slip). Saving is
 * the Nurse's and the Center Head's — exactly the roles allowed to file a
 * "Physical Examination" document — so the form cannot save an examination its
 * document would be refused for.
 */
const express = require('express');

const router = express.Router();

const controller = require('../controllers/physicalExaminationController');
const { asyncHandler } = require('../middleware/errorHandler');
const { authorize } = require('../middleware/auth');

router.get('/resident/:residentId', asyncHandler(controller.listForResident));
router.get('/:id', asyncHandler(controller.getById));
router.post('/', authorize('nurse', 'centerhead'), asyncHandler(controller.create));

module.exports = router;
