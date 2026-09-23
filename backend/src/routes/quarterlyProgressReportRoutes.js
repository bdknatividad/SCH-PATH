/**
 * Routes for the Quarterly Progress Report.
 *
 * The report lives inside the Reports module in the UI; this is its API. Every
 * handler is wrapped in `asyncHandler` so a rejected promise reaches the shared
 * error middleware instead of hanging the request.
 *
 * Literal paths are declared before `/:id`, or Express would match `/periods`
 * and `/identifying` as report ids — the same ordering trap the TRI and
 * Anecdotal routers avoid.
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/quarterlyProgressReportController');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/', asyncHandler(controller.list));
router.get('/periods', asyncHandler(controller.listPeriods));
router.get('/identifying/:residentId', asyncHandler(controller.identifyingFor));

router.post('/', asyncHandler(controller.create));

router.get('/:id', asyncHandler(controller.getById));
router.put('/:id', asyncHandler(controller.update));
router.delete('/:id', asyncHandler(controller.remove));
router.get('/:id/pdf', asyncHandler(controller.getPdf));

// The fill-in form the Social Worker writes on: the report as it will print, with
// the resident's details already filled in and only the aspect cells and the
// signature left blank. The popup form renders this PDF and overlays its inputs.
router.get('/:id/template', asyncHandler(controller.getTemplate));

// The report has one preparer, so there is one signature and one transition out
// of Draft. The removed routes — `/assign`, `/submit`, `/return` and the
// per-aspect `/sections/:sectionId/submit` and `/return` — belonged to a
// workflow where six staff members each owned an aspect and a Center Head
// approved the result. The Social Worker now writes and finalizes the whole
// report, and the Center Head approves the TRI instead.
router.post('/:id/signatures', asyncHandler(controller.signReport));
router.post('/:id/finalize', asyncHandler(controller.finalize));

router.put('/:id/sections/:sectionId', asyncHandler(controller.updateSection));

module.exports = router;
