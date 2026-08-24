/**
 * Document Controller
 * @module controllers/documentController
 * @description Document management with approval workflow
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { generateId, mapRow } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');
const { DOCUMENT_ROLE_PERMISSIONS, PHASE_REQUIREMENTS, CASE_PHASES, RESOURCES } = require('../utils/constants');

const baseController = createController('documents');

/**
 * Create a document with phase & role restrictions enforced
 * @async
 */
async function create(req, res, next) {
  try {
    const data = req.body || {};
    const uploaderRole = (req.user?.role || data.uploaderRole || '').toLowerCase();
    const docTitle = data.title || '';
    const docPhase = data.phase || '';

    // Role restriction check — enforced for all upload sources
    const allowedRoles = DOCUMENT_ROLE_PERMISSIONS[docTitle];
    if (allowedRoles && uploaderRole && !allowedRoles.includes(uploaderRole) && uploaderRole !== 'centerhead') {
      throw new ApiError(403, `Your role (${uploaderRole}) is not permitted to upload "${docTitle}". Allowed roles: ${allowedRoles.join(', ')}.`);
    }

    // Phase restriction: cannot upload docs for a future phase
    // Medical/non-phase-specific uploads are exempt from this check
    if (docPhase && data.residentId && data.category !== 'Medical') {
      const [children] = await pool.query('SELECT casePhase FROM children WHERE id = ?', [data.residentId]);
      if (children.length > 0) {
        const residentPhase = children[0].casePhase;
        const residentPhaseIndex = CASE_PHASES.indexOf(residentPhase);
        const docPhaseIndex = CASE_PHASES.indexOf(docPhase);
        if (docPhaseIndex > residentPhaseIndex) {
          throw new ApiError(422, `Cannot upload documents for a future phase (${docPhase}). Resident is currently in "${residentPhase}".`);
        }
      }
    }

    // Proceed with insert
    const config = RESOURCES['documents'];
    const [existing] = await pool.query('SELECT id FROM documents');
    const newId = generateId(config.prefix, existing.map(r => ({ id: r.id })));

    const columns = ['id'];
    const values = [newId];
    const placeholders = ['?'];

    for (const col of config.columns) {
      if (col !== 'id' && col !== 'createdAt' && col !== 'updatedAt') {
        if (data[col] !== undefined) {
          columns.push(col);
          values.push(config.jsonFields.includes(col) && typeof data[col] === 'object' ? JSON.stringify(data[col]) : data[col]);
          placeholders.push('?');
        }
      }
    }

    // Auto-set submittedBy and uploadedBy
    if (!data.submittedBy && req.user?.username) {
      columns.push('submittedBy'); values.push(req.user.username); placeholders.push('?');
    }
    if (!data.createdBy && req.user?.username) {
      columns.push('createdBy'); values.push(req.user.username); placeholders.push('?');
    }

    await pool.query(
      `INSERT INTO documents (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    );

    const [rows] = await pool.query('SELECT * FROM documents WHERE id = ?', [newId]);

    // Auto-notify Social Workers when Psychologist uploads a Psychological Assessment
    if (docTitle === 'Psychological Assessment' && uploaderRole === 'psychologist' && data.residentId) {
      try {
        const [childRows] = await pool.query('SELECT name FROM children WHERE id = ?', [data.residentId]);
        const childName = childRows[0]?.name || data.residentId;
        const [existingAlerts] = await pool.query('SELECT id FROM alerts');
        const alertId = generateId('ALR', existingAlerts.map(r => ({ id: r.id })));
        await pool.query(
          `INSERT INTO alerts (id, residentId, type, title, message, priority, actionRequired, relatedRecordType, relatedRecordId, targetRole)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            alertId,
            data.residentId,
            'Assessment Completed',
            `Psychological Assessment Uploaded - ${childName}`,
            `Psychologist has uploaded the Psychological Assessment for ${childName}. The document is pending review and approval.`,
            'Medium',
            'Review and approve Psychological Assessment document',
            'documents',
            newId,
            'socialworker',
          ]
        );
      } catch (alertErr) {
        console.error('Failed to create psych assessment completion alert:', alertErr);
      }
    }

    res.status(201).json({ success: true, data: mapRow('documents', rows[0]) });
  } catch (error) {
    next(error);
  }
}

/**
 * Submit document for review
 * @async
 */
async function submit(req, res, next) {
  try {
    const { id } = req.params;
    const { submittedBy } = req.body || {};

    await pool.query(
      `UPDATE documents 
       SET status = ?, submittedBy = ?, submittedAt = NOW(), modifiedBy = ? 
       WHERE id = ?`,
      ['Pending Review', submittedBy || req.user?.username, req.user?.username || 'System', id]
    );

    res.json({
      success: true,
      message: 'Document submitted for review',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Approve document
 * @async
 */
async function approve(req, res, next) {
  try {
    const { id } = req.params;
    const { approvedBy } = req.body || {};

    await pool.query(
      `UPDATE documents 
       SET status = ?, approvedBy = ?, approvedAt = NOW(), modifiedBy = ? 
       WHERE id = ?`,
      ['Approved', approvedBy || req.user?.username, req.user?.username || 'System', id]
    );

    await pool.query(
      `UPDATE alerts SET isRead = TRUE, readBy = ?, readAt = NOW() WHERE relatedRecordType = 'documents' AND relatedRecordId = ?`,
      [approvedBy || req.user?.username || 'System', id]
    );

    res.json({
      success: true,
      message: 'Document approved',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Reject document
 * @async
 */
async function reject(req, res, next) {
  try {
    const { id } = req.params;
    const { rejectionReason, reviewedBy } = req.body || {};

    if (!rejectionReason) {
      throw new ApiError(400, 'Rejection reason is required');
    }

    await pool.query(
      `UPDATE documents 
       SET status = ?, rejectionReason = ?, reviewedBy = ?, reviewedAt = NOW(), modifiedBy = ? 
       WHERE id = ?`,
      ['Rejected', rejectionReason, reviewedBy || req.user?.username, req.user?.username || 'System', id]
    );

    await pool.query(
      `UPDATE alerts SET isRead = TRUE, readBy = ?, readAt = NOW() WHERE relatedRecordType = 'documents' AND relatedRecordId = ?`,
      [reviewedBy || req.user?.username || 'System', id]
    );

    res.json({
      success: true,
      message: 'Document rejected',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get documents by resident
 * @async
 */
async function getByResident(req, res, next) {
  try {
    const { residentId } = req.params;
    
    const [rows] = await pool.query(
      'SELECT * FROM documents WHERE residentId = ? ORDER BY createdAt DESC',
      [residentId]
    );

    res.json({
      success: true,
      data: rows,
      count: rows.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get pending documents
 * @async
 */
async function getPending(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT d.*, c.name as residentName 
       FROM documents d 
       LEFT JOIN children c ON d.residentId = c.id 
       WHERE d.status IN (?, ?) 
       ORDER BY d.submittedAt ASC`,
      ['Pending Review', 'Submitted']
    );

    res.json({
      success: true,
      data: rows,
      count: rows.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get allowed document types for a given phase + role
 * @async
 */
async function getAllowedForRole(req, res, next) {
  try {
    const role = (req.query.role || req.user?.role || '').toLowerCase();
    const phase = req.query.phase || '';

    const phaseReq = PHASE_REQUIREMENTS[phase] || {};
    const phaseDocs = phaseReq.requiredDocuments || [];

    // Filter to docs this role can upload
    const allowed = phaseDocs.filter(doc => {
      const roles = DOCUMENT_ROLE_PERMISSIONS[doc];
      return !roles || roles.includes(role) || role === 'centerhead';
    });

    res.json({
      success: true,
      phase,
      role,
      allowedDocuments: allowed,
      allPhaseDocuments: phaseDocs,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAll: baseController.getAll,
  getById: baseController.getById,
  create,
  update: baseController.update,
  delete: baseController.delete,
  submit,
  approve,
  reject,
  getByResident,
  getPending,
  getAllowedForRole,
};
