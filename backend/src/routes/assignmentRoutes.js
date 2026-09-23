const express = require('express');
const router = express.Router();
const controller = require('../controllers/assignmentController');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/caseload', asyncHandler(controller.getCaseload));
router.get('/my-residents', asyncHandler(controller.getMyResidents));
router.get('/resident/:residentId', asyncHandler(controller.getByResident));
router.post('/resident/:residentId', asyncHandler(controller.create));
router.put('/:id', asyncHandler(controller.update));
router.post('/:id/end', asyncHandler(controller.end));

module.exports = router;
