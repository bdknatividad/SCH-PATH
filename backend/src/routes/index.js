/**
 * API Routes Index
 * @module routes/index
 * @description Main route aggregator for all API endpoints
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { RESOURCES } = require('../utils/constants');
const { mapRow } = require('../utils/helpers');
const { authenticate } = require('../middleware/auth');

const userRoutes = require('./userRoutes');
const childRoutes = require('./childRoutes');
const staffRoutes = require('./staffRoutes');
const activityRoutes = require('./activityRoutes');
const assessmentRoutes = require('./assessmentRoutes');
const reportRoutes = require('./reportRoutes');
const healthRoutes = require('./healthRoutes');
const evaluationRoutes = require('./evaluationRoutes');
const violationRoutes = require('./violationRoutes');
const alertRoutes = require('./alertRoutes');
const courtRoutes = require('./courtRoutes');
const phaseRoutes = require('./phaseRoutes');
const documentRoutes = require('./documentRoutes');

// Public health check endpoint (must be before mounting routes)
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'API is running',
    timestamp: new Date().toISOString(),
  });
});

// Store endpoint - get all data (used by frontend DataContext)
// Public endpoint - can be called with or without auth
router.get('/store', authenticate, async (req, res, next) => {
  try {
    const data = {};
    
    // Map table names to frontend resource names
    const resourceMapping = {
      'users': 'users',
      'children': 'children',
      'staff': 'staff',
      'activities': 'activities',
      'assessments': 'assessments',
      'reports': 'reports',
      'healthRecords': 'healthRecords',
      'activityEvaluations': 'activityEvaluations',
      'violations': 'violations',
      'alerts': 'alerts',
      'courtRecords': 'courtRecords',
      'phaseProgress': 'phaseProgress',
      'documents': 'documents',
    };
    
    for (const [tableName, resourceName] of Object.entries(resourceMapping)) {
      try {
        let rows;
        if (tableName === 'documents') {
          // Exclude fileData from store load — it's base64 and can be huge (MB per file).
          // fileData is fetched individually via GET /documents/:id when viewing/downloading.
          [rows] = await pool.query(
            `SELECT id, residentId, residentName, staffId, title, type, category, description,
                    fileName, fileSize, filePath, fileType, uploaderRole, status, phase, requiredFor,
                    submittedBy, submittedAt, uploadedBy, uploadedAt, reviewedBy, reviewedAt,
                    approvedBy, approvedAt, rejectionReason, notes, createdBy, modifiedBy,
                    createdAt, updatedAt
             FROM documents ORDER BY createdAt DESC`
          );
        } else {
          [rows] = await pool.query(`SELECT * FROM \`${tableName}\` ORDER BY ${RESOURCES[tableName]?.orderBy || 'createdAt DESC'}`);
        }
        data[resourceName] = rows.map((row) => {
          const mapped = mapRow(tableName, row);
          if (tableName === 'users' && mapped) delete mapped.password;
          return mapped;
        });
      } catch (resourceError) {
        // Keep healthy modules available while an older deployment is migrated.
        console.error(`Store load failed for ${tableName}:`, resourceError.message);
        data[resourceName] = [];
      }
    }
    
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// Mount all routes
router.use('/auth', userRoutes);
router.use('/users', userRoutes); // Add /users endpoint for frontend compatibility
router.use('/children', authenticate, childRoutes);
router.use('/staff', authenticate, staffRoutes);
router.use('/activities', authenticate, activityRoutes);
router.use('/assessments', authenticate, assessmentRoutes);
router.use('/reports', authenticate, reportRoutes);
router.use('/health-records', authenticate, healthRoutes);
router.use('/healthRecords', authenticate, healthRoutes); // backward compatible
router.use('/evaluations', authenticate, evaluationRoutes);
router.use('/activityEvaluations', authenticate, evaluationRoutes); // backward compatible
router.use('/violations', authenticate, violationRoutes);
router.use('/alerts', authenticate, alertRoutes);
router.use('/court', authenticate, courtRoutes);
router.use('/courtRecords', authenticate, courtRoutes); // backward compatible
router.use('/phases', authenticate, phaseRoutes);
router.use('/phaseProgress', authenticate, phaseRoutes); // backward compatible
router.use('/documents', authenticate, documentRoutes);

// Generic resource endpoints for backward compatibility
// These handle requests like /api/children, /api/staff, etc. with full CRUD
const genericResources = ['children', 'staff', 'activities', 'assessments', 'reports', 
  'healthRecords', 'activityEvaluations', 'violations', 'alerts', 'courtRecords', 
  'phaseProgress', 'documents'];

// GET all for any resource
router.get('/:resource', async (req, res, next) => {
  try {
    const { resource } = req.params;
    if (!genericResources.includes(resource)) {
      return next(); // Pass to 404 handler
    }
    
    const [rows] = await pool.query(`SELECT * FROM \`${resource}\` ORDER BY ${RESOURCES[resource]?.orderBy || 'createdAt DESC'}`);
    res.json({ 
      success: true, 
      data: rows.map(row => mapRow(resource, row)),
      count: rows.length 
    });
  } catch (error) {
    next(error);
  }
});

// POST create for any resource
router.post('/:resource', async (req, res, next) => {
  try {
    const { resource } = req.params;
    if (!genericResources.includes(resource)) {
      return next();
    }
    
    const config = RESOURCES[resource];
    const data = req.body || {};
    
    // Get existing IDs for uniqueness check
    const [existing] = await pool.query(`SELECT id FROM \`${resource}\``);
    const newId = generateId(config.prefix, existing.map(r => ({ id: r.id })));
    
    // Build columns and values
    const columns = ['id'];
    const values = [newId];
    const placeholders = ['?'];

    for (const col of config.columns) {
      if (col !== 'id' && col !== 'createdAt' && col !== 'updatedAt') {
        if (data[col] !== undefined) {
          columns.push(col);
          if (config.jsonFields.includes(col) && typeof data[col] === 'object') {
            values.push(JSON.stringify(data[col]));
          } else {
            values.push(data[col]);
          }
          placeholders.push('?');
        }
      }
    }

    const query = `INSERT INTO \`${resource}\` (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
    await pool.query(query, values);

    const [rows] = await pool.query(`SELECT * FROM \`${resource}\` WHERE id = ?`, [newId]);
    res.status(201).json({ success: true, data: mapRow(resource, rows[0]) });
  } catch (error) {
    next(error);
  }
});

// PUT update for any resource
router.put('/:resource/:id', async (req, res, next) => {
  try {
    const { resource, id } = req.params;
    if (!genericResources.includes(resource)) {
      return next();
    }
    
    const config = RESOURCES[resource];
    const data = req.body || {};

    // Build update query
    const updates = [];
    const values = [];

    for (const col of config.columns) {
      if (col !== 'id' && col !== 'createdAt' && data[col] !== undefined) {
        updates.push(`\`${col}\` = ?`);
        if (config.jsonFields.includes(col) && typeof data[col] === 'object') {
          values.push(JSON.stringify(data[col]));
        } else {
          values.push(data[col]);
        }
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    values.push(id);
    const query = `UPDATE \`${resource}\` SET ${updates.join(', ')} WHERE id = ?`;
    await pool.query(query, values);

    const [rows] = await pool.query(`SELECT * FROM \`${resource}\` WHERE id = ?`, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Record not found' });
    }
    
    res.json({ success: true, data: mapRow(resource, rows[0]) });
  } catch (error) {
    next(error);
  }
});

// DELETE for any resource
router.delete('/:resource/:id', async (req, res, next) => {
  try {
    const { resource, id } = req.params;
    if (!genericResources.includes(resource)) {
      return next();
    }
    
    await pool.query(`DELETE FROM \`${resource}\` WHERE id = ?`, [id]);
    res.json({ success: true, message: 'Record deleted successfully' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
