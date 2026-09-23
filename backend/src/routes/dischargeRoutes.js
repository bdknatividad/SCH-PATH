const express = require('express');
const router = express.Router();
const controller = require('../controllers/dischargeController');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/resident/:residentId', asyncHandler(controller.getResidentPlan));
router.get('/tri/:triId/recommendation', asyncHandler(controller.recommendationForTri));
router.put('/resident/:residentId/expected-date', asyncHandler(controller.setExpectedDate));
router.post('/resident/:residentId/extensions', asyncHandler(controller.addExtension));
router.post('/recommendations/:id/dismiss', asyncHandler(controller.dismissRecommendation));

module.exports = router;
