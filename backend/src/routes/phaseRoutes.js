/**
 * Phase Progress Routes
 * @module routes/phaseRoutes
 * @description Phase progression tracking endpoints
 */

const express = require('express');
const router = express.Router();
const phaseController = require('../controllers/phaseController');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate, authorize, authorizeNonHouseparent } = require('../middleware/auth');
// An absconded resident's Phase Timeline is frozen: every write below refuses.
const { blockAbscondedPhaseWrites } = require('../utils/abscond');

/**
 * GET /api/phases
 * Get all phase progress records
 */
router.get('/', asyncHandler(phaseController.getAll));

/**
 * GET /api/phases/resident/:residentId
 * Get phase progress by resident
 */
router.get('/resident/:residentId', asyncHandler(phaseController.getByResident));

/**
 * GET /api/phases/resident/:residentId/current
 * Get current phase for resident
 */
router.get('/resident/:residentId/current', asyncHandler(phaseController.getCurrent));

/**
 * GET /api/phases/requirements
 * Get all phase requirements (must be before /:id)
 */
router.get('/requirements', asyncHandler(phaseController.getRequirements));

router.get('/validate/:residentId', authenticate, asyncHandler(phaseController.validateByResident));

/**
 * GET /api/phases/:id
 * Get phase progress by ID
 */
router.get('/:id', asyncHandler(phaseController.getById));

/**
 * POST /api/phases
 * Create new phase progress record
 */
router.post('/', authorizeNonHouseparent, blockAbscondedPhaseWrites, asyncHandler(phaseController.create));

/**
 * PUT /api/phases/:id
 * Update phase progress
 */
router.put('/:id', authorizeNonHouseparent, blockAbscondedPhaseWrites, asyncHandler(phaseController.update));

/**
 * POST /api/phases/:id/complete
 * Mark phase as completed
 */
router.post('/:id/complete', authenticate, authorize('centerhead'), blockAbscondedPhaseWrites, asyncHandler(phaseController.complete));

/**
 * POST /api/phases/:id/demote
 * Demote child to previous phase due to violations
 */
router.post('/:id/demote', authenticate, authorize('centerhead'), blockAbscondedPhaseWrites, asyncHandler(phaseController.demote));

router.post('/:id/return', authenticate, authorize('centerhead'), blockAbscondedPhaseWrites, asyncHandler(phaseController.returnToPhase));

/**
 * POST /api/phases/:id/validate
 * Validate phase completion
 */
router.post('/:id/validate', authenticate, authorizeNonHouseparent, blockAbscondedPhaseWrites, asyncHandler(phaseController.validate));

/**
 * POST /api/phases/:id/task
 * Toggle a checklist task on a phase
 */
router.post('/:id/task', authenticate, blockAbscondedPhaseWrites, asyncHandler(phaseController.toggleTask));

/**
 * DELETE /api/phases/:id
 * Delete phase progress record
 */
router.delete('/:id', authorizeNonHouseparent, blockAbscondedPhaseWrites, asyncHandler(phaseController.delete));

module.exports = router;
