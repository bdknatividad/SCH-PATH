const express = require('express');
const router = express.Router();
const controller = require('../controllers/accessRequestController');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/', asyncHandler(controller.getAll));
router.post('/', asyncHandler(controller.create));
router.post('/:id/review', asyncHandler(controller.review));

module.exports = router;
