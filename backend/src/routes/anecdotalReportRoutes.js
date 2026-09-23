const express = require('express');
const router = express.Router();
const controller = require('../controllers/anecdotalReportController');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/', asyncHandler(controller.list));
router.get('/:id', asyncHandler(controller.getById));
router.get('/:id/pdf', asyncHandler(controller.getPdf));
router.post('/', asyncHandler(controller.create));
router.put('/:id', asyncHandler(controller.update));
router.post('/:id/submit', asyncHandler(controller.submit));
router.post('/:id/review', asyncHandler(controller.review));
router.post('/:id/return', asyncHandler(controller.returnForRevision));
router.post('/:id/finalize', asyncHandler(controller.finalize));

module.exports = router;
