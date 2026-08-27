/**
 * Child/Resident Controller
 * @module controllers/childController
 * @description Resident management with age calculation and document tracking
 */

const { pool } = require('../config/database');
const { createController } = require('./baseController');
const { calculateAge, generateId, mapRow } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');
const { PHASE_REQUIREMENTS, RESOURCES } = require('../utils/constants');

const baseController = createController('children');

/**
 * Create new child/resident record
 * @async
 */
async function create(req, res, next) {
  let connection;
  try {
    req.body = req.body || {};
    // Calculate age from birthDate if provided
    if (req.body.birthDate && !req.body.age) {
      req.body.age = calculateAge(req.body.birthDate);
    }

    // Set default values
    if (!req.body.status) req.body.status = 'Active';
    // Every new admission must start in the first canonical phase. The client
    // cannot skip phases by sending a different casePhase value.
    req.body.casePhase = 'Admission Phase';
    if (!req.body.documentsComplete) req.body.documentsComplete = false;

    const data = req.body || {};
    const config = RESOURCES.children;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS childIdSequence (
        id TINYINT PRIMARY KEY,
        nextNumber INT NOT NULL
      ) ENGINE=InnoDB
    `);
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Keep child IDs short and readable while preserving a server-side sequence
    // so deleted IDs are never reused.
    const [sequenceRows] = await connection.query('SELECT nextNumber FROM childIdSequence WHERE id = 1 FOR UPDATE');
    let nextNumber = sequenceRows[0]?.nextNumber || 1;
    let childId = `CH${String(nextNumber).padStart(2, '0')}`;
    let [existingChildId] = await connection.query('SELECT id FROM children WHERE id = ?', [childId]);
    while (existingChildId.length > 0) {
      nextNumber += 1;
      childId = `CH${String(nextNumber).padStart(2, '0')}`;
      [existingChildId] = await connection.query('SELECT id FROM children WHERE id = ?', [childId]);
    }
    if (sequenceRows.length === 0) {
      await connection.query('INSERT INTO childIdSequence (id, nextNumber) VALUES (1, ?)', [nextNumber + 1]);
    } else {
      await connection.query('UPDATE childIdSequence SET nextNumber = ? WHERE id = 1', [nextNumber + 1]);
    }
    const columns = ['id'];
    const values = [childId];
    const placeholders = ['?'];

    for (const column of config.columns) {
      if (column === 'id' || column === 'createdAt' || column === 'updatedAt' || data[column] === undefined) continue;
      columns.push(column);
      values.push(config.jsonFields.includes(column) && typeof data[column] === 'object'
        ? JSON.stringify(data[column])
        : data[column]);
      placeholders.push('?');
    }

    if (req.user && !columns.includes('createdBy')) {
      columns.push('createdBy');
      values.push(req.user.username);
      placeholders.push('?');
    }

    await connection.query(
      `INSERT INTO children (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    );

    const phase = 'Admission Phase';
    const phaseRequirements = PHASE_REQUIREMENTS[phase] || PHASE_REQUIREMENTS['Admission Phase'];
    const [existingPhases] = await connection.query('SELECT id FROM phaseProgress FOR UPDATE');
    const phaseId = generateId('PHS', existingPhases.map(row => ({ id: row.id })));
    await connection.query(
      `INSERT INTO phaseProgress (id, residentId, phaseName, enteredAt, isCurrent, tasksRequired, tasksCompleted, enteredBy, createdBy)
       VALUES (?, ?, ?, CURDATE(), 1, ?, '[]', ?, ?)`,
      [phaseId, childId, phase, JSON.stringify(phaseRequirements.requiredTasks || []), req.user?.username || 'System', req.user?.username || 'System']
    );

    const [rows] = await connection.query('SELECT * FROM children WHERE id = ?', [childId]);
    await connection.commit();
    res.status(201).json({
      success: true,
      data: mapRow('children', rows[0]),
      message: 'children created successfully',
    });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Get child by ID with full details
 * @async
 */
async function getById(req, res, next) {
  try {
    const { id } = req.params;
    
    // Get child data
    const [rows] = await pool.query(
      'SELECT * FROM children WHERE id = ?',
      [id]
    );

    if (rows.length === 0) {
      throw new ApiError(404, 'Child not found');
    }

    const child = rows[0];
    
    // Recalculate age
    if (child.birthDate) {
      child.age = calculateAge(child.birthDate);
    }

    // Get related records
    const [violations] = await pool.query(
      'SELECT * FROM violations WHERE residentId = ? ORDER BY date DESC',
      [id]
    );

    const [healthRecords] = await pool.query(
      'SELECT * FROM healthRecords WHERE residentId = ? ORDER BY date DESC',
      [id]
    );

    const [documents] = await pool.query(
      'SELECT * FROM documents WHERE residentId = ? ORDER BY createdAt DESC',
      [id]
    );

    const [phaseProgress] = await pool.query(
      'SELECT * FROM phaseProgress WHERE residentId = ? ORDER BY enteredAt ASC',
      [id]
    );

    res.json({
      success: true,
      data: {
        ...child,
        violations,
        healthRecords,
        documents,
        phaseProgress,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get all children with document status
 * @async
 */
async function getAll(req, res, next) {
  try {
    const { status, casePhase, documentsComplete } = req.query;
    let query = 'SELECT * FROM children WHERE 1=1';
    const params = [];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    if (casePhase) {
      query += ' AND casePhase = ?';
      params.push(casePhase);
    }

    if (documentsComplete !== undefined) {
      query += ' AND documentsComplete = ?';
      params.push(documentsComplete === 'true');
    }

    query += ' ORDER BY createdAt ASC';

    const [rows] = await pool.query(query, params);

    // Calculate age for each child
    const children = rows.map(child => ({
      ...child,
      age: child.birthDate ? calculateAge(child.birthDate) : child.age,
    }));

    res.json({
      success: true,
      data: children,
      count: children.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Update child record with age recalculation
 * @async
 */
async function update(req, res, next) {
  try {
    // Recalculate age if birthDate changed
    if (req.body.birthDate) {
      req.body.age = calculateAge(req.body.birthDate);
    }

    await baseController.update(req, res, next);
  } catch (error) {
    next(error);
  }
}

/**
 * Get children with incomplete documents
 * @async
 */
async function getIncompleteDocuments(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, 
        (SELECT COUNT(*) FROM documents d WHERE d.residentId = c.id AND d.status = 'Approved') as approvedDocs
      FROM children c 
      WHERE c.documentsComplete = false OR c.documentsComplete IS NULL
      ORDER BY c.createdAt ASC`
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
 * Re-admit a discharged child with a new case
 * This creates a new admission cycle with fresh phase progress
 * @async
 */
async function readmit(req, res, next) {
  try {
    const { id } = req.params;
    const { newAdmissionDate, newCaseType, newLegalCategory } = req.body || {};

    // Check if child exists
    const [childRows] = await pool.query('SELECT * FROM children WHERE id = ?', [id]);
    if (childRows.length === 0) {
      throw new ApiError(404, 'Child not found');
    }

    const child = childRows[0];

    // Store previous case info for history
    const previousCaseInfo = {
      offense: child.caseType,
      date: child.admissionDate,
      dischargeDate: child.status === 'Discharged' ? new Date().toISOString().split('T')[0] : null,
    };

    // Build updated previousCases array
    let previousCases = [];
    try {
      if (child.previousCases) {
        previousCases = JSON.parse(child.previousCases);
        if (!Array.isArray(previousCases)) previousCases = [];
      }
    } catch { previousCases = []; }

    previousCases.push(previousCaseInfo);

    const today = new Date().toISOString().split('T')[0];
    const completedBy = req.user?.username || 'System';

    // 1. Mark any existing phaseProgress records as not current (archive them)
    await pool.query(
      'UPDATE phaseProgress SET isCurrent = 0, completedAt = COALESCE(completedAt, ?), completedBy = COALESCE(completedBy, ?) WHERE residentId = ?',
      [today, completedBy, id]
    );

    // 2. Generate new phase ID for Admission Phase
    const [existingPhases] = await pool.query('SELECT id FROM phaseProgress');
    const { generateId } = require('../utils/helpers');
    const phaseId = generateId('PHS', existingPhases.map(r => ({ id: r.id })));

    // 3. Get required tasks for Admission Phase
    const { PHASE_REQUIREMENTS } = require('../utils/constants');
    const admissionReq = PHASE_REQUIREMENTS['Admission Phase'] || {};
    const tasksRequired = JSON.stringify(admissionReq.requiredTasks || []);

    // 4. Create new phaseProgress record for new Admission Phase
    await pool.query(
      `INSERT INTO phaseProgress (id, residentId, phaseName, enteredAt, isCurrent, tasksRequired, tasksCompleted, enteredBy, createdBy)
       VALUES (?, ?, ?, ?, 1, ?, '[]', ?, ?)`,
      [phaseId, id, 'Admission Phase', newAdmissionDate || today, tasksRequired, completedBy, completedBy]
    );

    // 5. Update child record for re-admission
    // Format date properly (ensure YYYY-MM-DD format)
    const formatDate = (dateStr) => {
      if (!dateStr) return '';
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return dateStr;
      return date.toISOString().split('T')[0];
    };
    const formattedPrevDate = formatDate(child.admissionDate);
    const prevDetailsText = child.previousCaseDetails
      ? ` | ${child.previousCaseDetails.replace(/Previous:\s*[^|]+\(\s*[^)]+\s*\)\s*\|?\s*/g, '').trim()}`
      : '';

    const reAdmissionDate = newAdmissionDate || today;
    const updateFields = {
      status: 'Active',
      casePhase: 'Admission Phase',
      isRepeatOffender: true,
      previousCases: previousCases,
      previousCaseDetails: `Previous: ${child.caseType} (${formattedPrevDate})${prevDetailsText}`,
      admissionDate: reAdmissionDate,
      readmissionDate: reAdmissionDate,
      readmissionDatetime: new Date().toISOString(), // Full datetime cutoff for precise doc splitting
      documentsComplete: false,
      phaseTasksCompleted: {}, // Reset all task checkboxes for new admission cycle
    };

    // Only update case type if new one provided
    if (newCaseType) {
      updateFields.caseType = newCaseType;
    }
    if (newLegalCategory) {
      updateFields.legalCategory = newLegalCategory;
    }

    const columns = Object.keys(updateFields);
    const values = columns.map(col => {
      const val = updateFields[col];
      if (col === 'previousCases' && Array.isArray(val)) {
        return JSON.stringify(val);
      }
      if (col === 'phaseTasksCompleted' && typeof val === 'object') {
        return JSON.stringify(val);
      }
      return val;
    });
    values.push(id);

    const setClause = columns.map(col => `${col} = ?`).join(', ');
    await pool.query(`UPDATE children SET ${setClause} WHERE id = ?`, values);

    // Fetch updated child
    const [updatedRows] = await pool.query('SELECT * FROM children WHERE id = ?', [id]);
    const updatedChild = mapRow('children', updatedRows[0]);

    // Get new phase progress
    const [newPhaseProgress] = await pool.query(
      'SELECT * FROM phaseProgress WHERE residentId = ? ORDER BY enteredAt ASC',
      [id]
    );

    res.json({
      success: true,
      message: `Child ${child.name} successfully re-admitted. New admission cycle started.`,
      data: {
        ...updatedChild,
        phaseProgress: newPhaseProgress.map(r => mapRow('phaseProgress', r)),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/children/:id/toggle-psych-assessment
 * Toggle the needsPsychAssessment flag and auto-create alert for Psychologist
 * @async
 */
async function togglePsychAssessment(req, res, next) {
  try {
    const { id } = req.params;
    const { needsPsychAssessment } = req.body;

    const [childRows] = await pool.query('SELECT * FROM children WHERE id = ?', [id]);
    if (childRows.length === 0) {
      throw new ApiError(404, 'Child not found');
    }

    const child = childRows[0];
    const flagValue = needsPsychAssessment ? 1 : 0;

    await pool.query(
      'UPDATE children SET needsPsychAssessment = ? WHERE id = ?',
      [flagValue, id]
    );

    // If flagging ON, create an alert for Psychologist
    if (needsPsychAssessment) {
      const [existingAlerts] = await pool.query('SELECT id FROM alerts');
      const alertId = generateId('ALR', existingAlerts.map(r => ({ id: r.id })));
      const flaggedBy = req.body.flaggedBy || req.user?.username || 'Case Worker';

      await pool.query(
        `INSERT INTO alerts (id, residentId, type, title, message, priority, actionRequired, relatedRecordType, relatedRecordId, targetRole)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          alertId,
          id,
          'Assessment Required',
          `Psychological Assessment Required - ${child.name}`,
          `Case Worker (${flaggedBy}) has flagged that ${child.name} requires a Psychological Assessment during the Admission Phase. Please conduct and upload the assessment.`,
          'High',
          'Upload Psychological Assessment document',
          'children',
          id,
          'psychologist',
        ]
      );
    }

    res.json({
      success: true,
      message: needsPsychAssessment
        ? `Psychological Assessment flagged as required for ${child.name}. Psychologist has been notified.`
        : `Psychological Assessment requirement removed for ${child.name}.`,
      needsPsychAssessment: !!needsPsychAssessment,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  create,
  getById,
  getAll,
  update,
  delete: baseController.delete,
  getIncompleteDocuments,
  readmit,
  togglePsychAssessment,
};
