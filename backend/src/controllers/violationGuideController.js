/**
 * Violation Guide Controller
 * @module controllers/violationGuideController
 * @description Manages Violation & Intervention Guide configuration
 */

const { pool } = require('../config/database');
const { insertWithGeneratedId } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');
const { canAccessResident } = require('./assignmentController');
const { loadResidentScope } = require('../utils/residentScope');
// The one Manila-date helper. Every "today" in a query has to be the facility's
// today; `toISOString()` gives UTC's, which is a different day for eight hours
// of every day here.
const { manilaToday } = require('../utils/triPeriod');
// `normalizeRole` is called by the scheduling guard below. It was referenced
// without ever being imported, so `PUT /intervention-tracker/:id` threw
// `ReferenceError: normalizeRole is not defined` for any body carrying
// `scheduledAt` — and only for those, since the guard is the first thing that
// touches it. Scheduling an intervention was therefore impossible from the
// Intervention Tracker, and the failure surfaced as a bare 500 because a
// ReferenceError is not an `ApiError`.
const { normalizeRole } = require('../utils/authorization');

function isSchedulingInterventionType(value) {
  const type = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return type === 'psychosocial activity' || type === 'dialogue / counseling' || type === 'dialogue/counseling';
}

/**
 * Whether an intervention may be given a schedule.
 *
 * Reads the configured `metadata.schedulable` flag first and only falls back to
 * the type name when it is absent, so this agrees with the verification path in
 * `violationController`. Judging by the type name alone let a
 * Dialogue/Counseling requirement be scheduled here while verification refused
 * to accept it, and vice versa.
 */
function interventionNeedsSchedule(row) {
  const source = row && typeof row === 'object' ? row : { interventionType: row };
  let metadata = source.metadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = null;
    }
  }
  if (metadata && typeof metadata.schedulable === 'boolean') return metadata.schedulable;
  return isSchedulingInterventionType(source.interventionType);
}

async function getNextId(connection, table, prefix) {
  const allowed = new Set(['violation_guide', 'guide_interventions']);
  if (!allowed.has(table)) throw new Error('Unsupported guide table.');

  // Use the highest existing numeric ID instead of assuming the table starts at 001.
  // This also makes the generator safe when rows were seeded previously with gaps.
  const [rows] = await connection.query(`SELECT id FROM ${table}`);
  let maxNumber = 0;
  for (const row of rows) {
    const match = String(row.id || '').match(new RegExp(`^${prefix}(\\d+)$`, 'i'));
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }

  let next = maxNumber + 1;
  const used = new Set(rows.map((row) => String(row.id || '')));
  while (used.has(`${prefix}${String(next).padStart(3, '0')}`)) next += 1;
  return `${prefix}${String(next).padStart(3, '0')}`;
}

async function nextGuideInterventionId(connection) {
  const [rows] = await connection.query('SELECT id FROM guide_interventions');
  let maxNumber = 0;
  for (const row of rows) {
    const match = String(row.id || '').match(/^GI(\d+)$/i);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }
  let next = maxNumber + 1;
  const used = new Set(rows.map((row) => String(row.id || '')));
  while (used.has(`GI${String(next).padStart(3, '0')}`)) next += 1;
  return `GI${String(next).padStart(3, '0')}`;
}

/**
 * Get all violation guides with optional filtering
 */
async function getAll(req, res, next) {
  try {
    const { status } = req.query;
    
    let query = 'SELECT * FROM violation_guide';
    const values = [];
    
    if (status) {
      query += ' WHERE status = ?';
      values.push(status);
    }
    
    query += ' ORDER BY createdAt DESC';
    
    const [guides] = await pool.query(query, values);
    
    // Enrich each guide with its interventions
    const enrichedGuides = await Promise.all(
      guides.map(async (guide) => {
        const [interventions] = await pool.query(
          `SELECT * FROM guide_interventions 
           WHERE guideId = ? AND status = 'Active' 
           ORDER BY offenseLevel`,
          [guide.id]
        );
        
        return {
          ...guide,
          interventions: interventions,
        };
      })
    );
    
    res.json({
      success: true,
      data: enrichedGuides,
      count: enrichedGuides.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get violation guide by ID with all interventions
 */
async function getById(req, res, next) {
  try {
    const { id } = req.params;
    
    const [guides] = await pool.query(
      'SELECT * FROM violation_guide WHERE id = ?',
      [id]
    );
    
    if (guides.length === 0) {
      throw new ApiError(404, 'Violation guide not found');
    }
    
    const guide = guides[0];
    
    // Get all interventions for this guide
    const [interventions] = await pool.query(
      `SELECT * FROM guide_interventions 
       WHERE guideId = ? AND status = 'Active' 
       ORDER BY offenseLevel`,
      [id]
    );
    
    // Group interventions by offense level
    const grouped = {
      '1st': interventions.filter(i => i.offenseLevel === '1st'),
      '2nd': interventions.filter(i => i.offenseLevel === '2nd'),
      '3rd': interventions.filter(i => i.offenseLevel === '3rd'),
    };
    
    res.json({
      success: true,
      data: {
        ...guide,
        interventions: grouped,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Create new violation guide with interventions
 * 
 * Expected body:
 * {
 *   name: "Making noise during study time",
 *   category: "Minor",
 *   description: "...",
 *   status: "Active",
 *   interventions: {
 *     "1st": [{ interventionType, duration, unit }, ...],
 *     "2nd": [...],
 *     "3rd": [...]
 *   }
 * }
 */
async function create(req, res, next) {
  const connection = await pool.getConnection();
  
  let transactionStarted = false;
  try {
    const { name, category, description, status, interventions } = req.body;
    const userId = req.user?.id || req.user?.username || 'system';
    
    // Validate required fields
    if (!name) {
      throw new ApiError(400, 'Violation name is required');
    }

    // Start the transaction before ID allocation so the allocation is isolated.
    await connection.beginTransaction();
    transactionStarted = true;
    const guideId = await getNextId(connection, 'violation_guide', 'VG');
    
    // Insert violation guide
    await connection.query(
      `INSERT INTO violation_guide (id, name, category, description, status, createdBy, updatedBy)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [guideId, name, category || 'Minor', description ?? null, status || 'Active', userId, userId]
    );
    
    // Insert interventions for each offense level
    if (interventions) {
      for (const [offenseLevel, items] of Object.entries(interventions)) {
        if (Array.isArray(items)) {
          for (const item of items) {
            const interventionId = await nextGuideInterventionId(connection);
            await connection.query(
              `INSERT INTO guide_interventions 
               (id, guideId, offenseLevel, interventionType, duration, unit, metadata, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'Active')`,
              [
                interventionId,
                guideId,
                offenseLevel,
                item.interventionType,
                item.duration || null,
                item.unit || null,
                item.metadata ? JSON.stringify(item.metadata) : null,
              ]
            );
          }
        }
      }
    }
    
    await connection.commit();
    
    // Fetch and return the created guide
    const [guides] = await pool.query(
      'SELECT * FROM violation_guide WHERE id = ?',
      [guideId]
    );
    
    const [interventionRows] = await pool.query(
      'SELECT * FROM guide_interventions WHERE guideId = ? AND status = \'Active\'',
      [guideId]
    );
    
    const grouped = {
      '1st': interventionRows.filter(i => i.offenseLevel === '1st'),
      '2nd': interventionRows.filter(i => i.offenseLevel === '2nd'),
      '3rd': interventionRows.filter(i => i.offenseLevel === '3rd'),
    };
    
    res.status(201).json({
      success: true,
      data: {
        ...guides[0],
        interventions: grouped,
      },
    });
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
}

/**
 * Update violation guide and its interventions
 */
async function update(req, res, next) {
  const connection = await pool.getConnection();
  
  try {
    const { id } = req.params;
    const { name, category, description, status, interventions } = req.body;
    const userId = req.user?.id || req.user?.username || 'system';
    
    await connection.beginTransaction();
    
    // Update guide
    if (name || category !== undefined || description !== undefined || status) {
      const updates = [];
      const values = [];
      
      if (name !== undefined) {
        updates.push('name = ?');
        values.push(name);
      }
      if (category !== undefined) {
        updates.push('category = ?');
        values.push(category);
      }
      if (description !== undefined) {
        updates.push('description = ?');
        values.push(description);
      }
      if (status !== undefined) {
        updates.push('status = ?');
        values.push(status);
      }
      
      updates.push('updatedBy = ?');
      values.push(userId);
      
      updates.push('updatedAt = NOW()');
      
      values.push(id);
      
      await connection.query(
        `UPDATE violation_guide SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }
    
    // Update interventions if provided.
    // IMPORTANT: never DELETE configured intervention rows here. Verified
    // intervention_tracker rows keep an FK to the exact guide_interventions.id
    // they were created from. Deleting/recreating the rows would either break
    // that FK or make historical records point at a different configuration.
    // Instead, retire the previous configuration and create new immutable
    // configuration rows. Pending violations use the current Active rows;
    // existing tracker rows keep their exact source row for history.
    if (interventions) {
      await connection.query(
        `UPDATE guide_interventions
         SET status = 'Inactive', updatedAt = NOW()
         WHERE guideId = ? AND status = 'Active'`,
        [id]
      );
      
      // Insert the new active configuration rows.
      for (const [offenseLevel, items] of Object.entries(interventions)) {
        if (Array.isArray(items)) {
          for (const item of items) {
            const interventionId = await nextGuideInterventionId(connection);
            await connection.query(
              `INSERT INTO guide_interventions 
               (id, guideId, offenseLevel, interventionType, duration, unit, metadata, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'Active')`,
              [
                interventionId,
                id,
                offenseLevel,
                item.interventionType,
                item.duration || null,
                item.unit || null,
                item.metadata ? JSON.stringify(item.metadata) : null,
              ]
            );
          }
        }
      }
    }
    
    await connection.commit();
    
    // Fetch and return updated guide
    const [guides] = await pool.query(
      'SELECT * FROM violation_guide WHERE id = ?',
      [id]
    );
    
    const [interventionRows] = await pool.query(
      'SELECT * FROM guide_interventions WHERE guideId = ? AND status = \'Active\'',
      [id]
    );
    
    const grouped = {
      '1st': interventionRows.filter(i => i.offenseLevel === '1st'),
      '2nd': interventionRows.filter(i => i.offenseLevel === '2nd'),
      '3rd': interventionRows.filter(i => i.offenseLevel === '3rd'),
    };
    
    res.json({
      success: true,
      data: {
        ...guides[0],
        interventions: grouped,
      },
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
}

/**
 * Delete violation guide (soft delete - mark as inactive)
 * or hard delete if status changes to Inactive
 */
async function delete_(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user?.id || req.user?.username || 'system';

    await pool.query(
      'UPDATE violation_guide SET status = ?, updatedBy = ?, updatedAt = NOW() WHERE id = ?',
      ['Inactive', userId, id]
    );

    res.json({
      success: true,
      message: 'Violation guide marked as inactive',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get all intervention types
 */
async function getInterventionTypes(req, res, next) {
  try {
    const [types] = await pool.query(
      'SELECT * FROM intervention_types ORDER BY type'
    );
    
    res.json({
      success: true,
      data: types,
      count: types.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Assign interventions to a child based on violation
 * This is called after a violation is logged and verified
 * 
 * Expected body:
 * {
 *   residentId: "...",
 *   violationId: "...",
 *   guideId: "...",
 *   offenseLevel: "1st|2nd|3rd"
 * }
 */
async function assignInterventions(req, res, next) {
  const connection = await pool.getConnection();
  
  try {
    const { residentId, violationId, guideId, offenseLevel } = req.body;

    if (!residentId || !violationId || !guideId || !offenseLevel) {
      throw new ApiError(400, 'Missing required fields');
    }

    // Scope assignment to the selected violation. Other active interventions
    // for the same resident must never block a new intervention.
    const [violationRows] = await connection.query(
      'SELECT id, residentId, guideId FROM violations WHERE id = ? LIMIT 1',
      [violationId]
    );
    if (!violationRows.length) throw new ApiError(404, 'Violation not found');
    if (String(violationRows[0].residentId) !== String(residentId)) {
      throw new ApiError(422, 'Resident does not match the selected violation.');
    }
    if (violationRows[0].guideId && String(violationRows[0].guideId) !== String(guideId)) {
      throw new ApiError(422, 'Violation does not belong to the selected intervention guide.');
    }

    // Persist the exact guide relationship for legacy violations before any
    // tracker record is created.
    if (!violationRows[0].guideId) {
      await connection.query('UPDATE violations SET guideId = ? WHERE id = ?', [guideId, violationId]);
    }

    const normalizedLevel =
      offenseLevel === '4th+' || offenseLevel === '4th Offense+'
        ? '3rd'
        : offenseLevel;

    const [guideRows] = await pool.query(
      `SELECT id, status, category
       FROM violation_guide
       WHERE id = ?
       LIMIT 1`,
      [guideId]
    );

    if (!guideRows.length || guideRows[0].status !== 'Active') {
      throw new ApiError(400, 'Only an Active violation guide can assign interventions.');
    }

    if (!['Minor', 'Major'].includes(guideRows[0].category)) {
      throw new ApiError(400, 'Violation guide category must be Minor or Major.');
    }

    await connection.beginTransaction();

    // The official guide has 1st, 2nd, and 3rd-and-beyond requirements.
    const [interventions] = await connection.query(
      `SELECT * FROM guide_interventions
       WHERE guideId = ? AND offenseLevel = ? AND status = 'Active'
       ORDER BY createdAt ASC`,
      [guideId, normalizedLevel]
    );
    if (interventions.length === 0) {
      throw new ApiError(409, `No interventions are configured for ${normalizedLevel} offense in the selected guide.`);
    }

    // Create tracker entry for each guide requirement.
    const created = [];
    for (const [idx, intervention] of interventions.entries()) {
      // generateId() without existing rows would return the same id on every
      // loop iteration — build a guaranteed-unique one instead.
      const trackerId = `IT${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}${String(idx + 1).padStart(2, '0')}`;
      
      let metadata = intervention.metadata;
      if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch { metadata = null; }
      }

      // Duration is informational. Staff must explicitly Start and End the
      // intervention; duration never creates an automatic start/end date.
      const endDate = null;

      // Reuse an existing tracker for this exact configured intervention when
      // the endpoint is retried. This prevents duplicate monitoring records.
      const [existingTracker] = await connection.query(
        `SELECT * FROM intervention_tracker
         WHERE violationId = ? AND guideInterventionId = ?
         LIMIT 1`,
        [violationId, intervention.id]
      );
      if (existingTracker.length) {
        const existingRow = existingTracker[0];
        created.push({
          id: existingRow.id,
          guideId,
          guideInterventionId: intervention.id,
          offenseLevel: normalizedLevel,
          interventionType: existingRow.interventionType,
          duration: existingRow.duration,
          unit: existingRow.unit,
          metadata,
          officialText: metadata?.officialText || metadata?.rawText || intervention.interventionType,
          reused: true,
        });
        continue;
      }

      await connection.query(
        `INSERT INTO intervention_tracker
        (id, residentId, violationId, guideId, guideInterventionId, offenseLevel, interventionType,
         duration, unit, metadata, status, startDate, endDate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'In Progress', NULL, NULL)`,
        [
          trackerId, residentId, violationId, guideId, intervention.id, normalizedLevel,
          intervention.interventionType, intervention.duration, intervention.unit,
          metadata ? JSON.stringify(metadata) : null,
        ]
      );

      await connection.query(
        `INSERT INTO intervention_requirements
         (id, interventionId, residentId, title, status, startedAt, dueDate)
         VALUES (?, ?, ?, ?, 'In Progress', NULL, NULL)`,
        [
          `IR${trackerId}`,
          trackerId,
          residentId,
          metadata?.officialText || metadata?.rawText || intervention.interventionType || 'Intervention Requirement',
        ]
      );

      created.push({
        id: trackerId,
        guideId,
        guideInterventionId: intervention.id,
        offenseLevel: normalizedLevel,
        interventionType: intervention.interventionType,
        duration: intervention.duration,
        unit: intervention.unit,
        metadata,
        officialText: metadata?.officialText || metadata?.rawText || intervention.interventionType,
      });
    }
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      data: created,
      message: 'Interventions assigned to resident',
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
}

/**
 * The caller's scheduled interventions — the "assigned schedules" the dashboard
 * shows next to activities and assessments.
 *
 * One query for the whole caseload. The per-resident endpoint below would need a
 * request per resident, which is exactly why the Intervention Tracker page is
 * slow for a long caseload; a dashboard must not inherit that.
 *
 * `?from=` and `?to=` bound the window as `YYYY-MM-DD` (inclusive) and default
 * to today, so the dashboard asks for one day and gets one day.
 *
 * Scoping reuses `loadResidentScope` — the same helper documents and
 * notifications use — so a Houseparent sees their own residents and a role with
 * no caseload concept sees the facility. It never widens for anyone.
 */
async function getScheduledInterventions(req, res, next) {
  try {
    // Today in the facility's timezone, from the one shared helper.
    // `toISOString()` is UTC, which is still yesterday until 08:00 in the
    // Philippines; an inline `Intl.DateTimeFormat` here was a second copy of the
    // same rule and is gone for the same reason.
    const today = manilaToday();
    const from = String(req.query.from || today).slice(0, 10);
    const to = String(req.query.to || from).slice(0, 10);

    const allowedResidentIds = await loadResidentScope(req.user);
    if (allowedResidentIds !== null && allowedResidentIds.length === 0) {
      // A Houseparent with no assignments sees an empty schedule, not the
      // facility's. An empty IN () list is a syntax error, so it is answered
      // here rather than in SQL.
      return res.json({ success: true, data: [], count: 0 });
    }

    let scopeClause = '';
    const values = [from, to];
    if (allowedResidentIds !== null) {
      scopeClause = ` AND it.residentId IN (${allowedResidentIds.map(() => '?').join(', ')})`;
      values.push(...allowedResidentIds);
    }

    const [rows] = await pool.query(
      `SELECT it.*,
              it.guideInterventionId AS configuredInterventionId,
              c.name AS residentName
         FROM intervention_tracker it
         INNER JOIN children c ON c.id = it.residentId
        WHERE it.status = 'In Progress'
          AND it.scheduledAt IS NOT NULL
          AND DATE(it.scheduledAt) BETWEEN ? AND ?${scopeClause}
        ORDER BY it.scheduledAt ASC`,
      values
    );

    res.json({ success: true, data: rows, count: rows.length });
  } catch (error) {
    next(error);
  }
}

/**
 * Get intervention tracker for a resident
 */
async function getResidentInterventions(req, res, next) {
  try {
    const { residentId } = req.params;
    const { status } = req.query;
    if (!await canAccessResident(req.user, residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }
    
    let query = `
      SELECT
        it.*,
        it.guideInterventionId AS configuredInterventionId,
        gi.metadata AS guideMetadata
      FROM intervention_tracker it
      LEFT JOIN guide_interventions gi
        ON gi.id = it.guideInterventionId
      WHERE it.residentId = ?`;
    const values = [residentId];

    if (status) {
      query += ' AND it.status = ?';
      values.push(status);
    }

    query += ' ORDER BY it.createdAt DESC';

    const [interventions] = await pool.query(query, values);
    const enriched = interventions.map((item) => {
      let metadata = item.guideMetadata;
      if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch { metadata = null; }
      }
      return {
        ...item,
        metadata,
        officialText: metadata?.officialText || metadata?.rawText || item.interventionType,
      };
    });

    res.json({
      success: true,
      data: enriched,
      count: enriched.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Update intervention status (mark as completed, etc.)
 */
async function updateInterventionStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status, notes, scheduledAt, startDate, endDate } = req.body || {};
    const userId = req.user?.id || req.user?.username || 'system';

    const [existing] = await pool.query(
      'SELECT * FROM intervention_tracker WHERE id = ? LIMIT 1',
      [id]
    );
    if (!existing.length) throw new ApiError(404, 'Intervention not found');
    const rec = existing[0];
    if (!await canAccessResident(req.user, rec.residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }

    if (status && !['In Progress', 'Completed'].includes(status)) {
      throw new ApiError(400, 'Invalid intervention status.');
    }

    const updates = [];
    const values = [];

    if (status) {
      updates.push('status = ?');
      values.push(status);
    }
    if (notes !== undefined) {
      updates.push('notes = ?');
      values.push(notes);
    }

    // Houseparents may view and complete interventions, but scheduling is a
    // manager/staff workflow and is never available to a Houseparent.
    if (scheduledAt !== undefined && normalizeRole(req.user?.role) === 'houseparent') {
      throw new ApiError(403, 'Houseparents cannot schedule interventions.');
    }

    // Scheduling is available ONLY to the interventions the guide configures as
    // schedulable.
    if (scheduledAt !== undefined) {
      if (!interventionNeedsSchedule(rec)) {
        throw new ApiError(400, 'This intervention type does not require scheduling.');
      }
      if (scheduledAt && new Date(scheduledAt).getTime() <= Date.now()) {
        throw new ApiError(400, 'The intervention schedule must be in the future.');
      }
      updates.push('scheduledAt = ?');
      values.push(scheduledAt || null);
    }

    // Duration-based interventions are manually started and manually ended.
    // The duration never creates or implies an automatic start/end date.
    if (startDate !== undefined) {
      if (!rec.duration) {
        throw new ApiError(400, 'This intervention does not have a duration-based start.');
      }
      updates.push('startDate = ?');
      values.push(startDate || null);
    }
    if (endDate !== undefined) {
      if (!rec.duration) {
        throw new ApiError(400, 'This intervention does not have a duration-based end.');
      }
      updates.push('endDate = ?');
      values.push(endDate || null);
    }

    if (status === 'Completed') {
      if (rec.duration && !(startDate || rec.startDate)) {
        throw new ApiError(400, 'Start this duration-based intervention before ending it.');
      }
      updates.push('completionDate = NOW()');
      updates.push('completedBy = ?');
      values.push(userId);
      if (rec.duration && endDate === undefined) {
        updates.push('endDate = NOW()');
      }
    }

    if (!updates.length) throw new ApiError(400, 'No intervention changes were provided.');

    values.push(id);
    await pool.query(
      `UPDATE intervention_tracker SET ${updates.join(', ')}, updatedAt = NOW() WHERE id = ?`,
      values
    );

    if (status === 'Completed') {
      await pool.query(
        `UPDATE intervention_requirements
         SET status = 'Done', completedAt = COALESCE(completedAt, NOW()),
             completedBy = COALESCE(completedBy, ?)
         WHERE interventionId = ?`,
        [userId, id]
      );
    } else if (status === 'In Progress' || startDate !== undefined) {
      await pool.query(
        `UPDATE intervention_requirements
         SET status = 'In Progress', startedAt = COALESCE(startedAt, ?)
         WHERE interventionId = ? AND status <> 'Done'`,
        [startDate || null, id]
      );
    }

    const [records] = await pool.query(
      'SELECT * FROM intervention_tracker WHERE id = ?',
      [id]
    );

    res.json({ success: true, data: records[0] });
  } catch (error) {
    next(error);
  }
}

/**
 * Get requirements for an intervention (requirement-level tracking).
 */
async function getInterventionRequirements(req, res, next) {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      `SELECT r.*, it.residentId, it.violationId
       FROM intervention_requirements r
       JOIN intervention_tracker it ON it.id = r.interventionId
       WHERE r.interventionId = ?
       ORDER BY r.createdAt DESC`,
      [id]
    );
    if (rows.length > 0 && !await canAccessResident(req.user, rows[0].residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }
    res.json({ success: true, data: rows, count: rows.length });
  } catch (error) { next(error); }
}

/**
 * Create a requirement under an intervention.
 * IMPORTANT: completing one requirement does NOT complete its siblings.
 */
async function createRequirement(req, res, next) {
  try {
    const { id } = req.params;
    const { title, notes, startDate, dueDate } = req.body || {};
    const userId = req.user?.id || req.user?.username || 'system';
    const [parent] = await pool.query('SELECT residentId FROM intervention_tracker WHERE id = ?', [id]);
    if (parent.length === 0) throw new ApiError(404, 'Intervention not found');
    // Two concurrent creates can derive the same id; retry instead of 500.
    const newId = await insertWithGeneratedId(pool, {
      table: 'intervention_requirements',
      prefix: 'IR',
      insert: (generatedId) => pool.query(
        `INSERT INTO intervention_requirements (id, interventionId, residentId, title, notes, startedAt, dueDate)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [generatedId, id, parent[0].residentId, title || 'Intervention Requirement', notes || null, startDate || null, dueDate || null]
      ),
    });
    const [created] = await pool.query('SELECT * FROM intervention_requirements WHERE id = ?', [newId]);
    res.status(201).json({ success: true, data: created[0] });
  } catch (error) { next(error); }
}

/**
 * Update a requirement's status — with overdue detection.
 * Rule: a requirement already Done (Completed) can NEVER become Overdue.
 */
async function updateRequirement(req, res, next) {
  try {
    const { id } = req.params;
    const { status, notes, startDate, dueDate } = req.body || {};
    const userId = req.user?.id || req.user?.username || 'system';
    const [existing] = await pool.query('SELECT * FROM intervention_requirements WHERE id = ?', [id]);
    if (existing.length === 0) throw new ApiError(404, 'Requirement not found');
    const rec = existing[0];
    if (!await canAccessResident(req.user, rec.residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }

    const updates = [];
    const values = [];
    if (status) {
      // Rule #14: Done requirements must NEVER become Overdue.
      if (rec.status === 'Done') {
        throw new ApiError(409, 'A completed requirement cannot be changed to Overdue');
      }
      updates.push('status = ?'); values.push(status);
    }
    if (notes !== undefined) { updates.push('notes = ?'); values.push(notes); }
    if (startDate !== undefined) { updates.push('startedAt = ?'); values.push(startDate); }
    if (dueDate !== undefined) {
      updates.push('dueDate = ?'); values.push(dueDate);
    }
    if (status === 'Done') {
      updates.push('completedAt = NOW()');
      updates.push('completedBy = ?'); values.push(userId);
    }
    if (updates.length === 0) {
      throw new ApiError(400, 'No fields to update');
    }
    values.push(id);
    await pool.query(
      `UPDATE intervention_requirements SET ${updates.join(', ')}, updatedAt = NOW() WHERE id = ?`,
      values
    );

    // Reflect parent intervention status: parent is Done only when ALL
    // required child requirements are Done. This does NOT auto-complete
    // siblings. A Done child stays Done and can't flip to Overdue.
    if (status === 'Done' || status === 'Overdue' || status === 'In Progress') {
      const [children_] = await pool.query(
        `SELECT status FROM intervention_requirements WHERE interventionId = ?`,
        [rec.interventionId]
      );
      const allDone = children_.length > 0 && children_.every(c => c.status === 'Done');
      const parentStatus = allDone ? 'Completed' : (children_.some(c => c.status === 'Overdue') ? 'In Progress' : 'In Progress');
      await pool.query(
        `UPDATE intervention_tracker SET status = ? WHERE id = ?`,
        [parentStatus, rec.interventionId]
      );
    }

    const [updated] = await pool.query('SELECT * FROM intervention_requirements WHERE id = ?', [id]);
    res.json({ success: true, data: updated[0] });
  } catch (error) { next(error); }
}

/**
 * Overdue sweep: mark requirements overdue when past dueDate & not Done.
 * Safe to run periodically; Done requirements are never touched.
 */
async function refreshOverdue(req, res, next) {
  try {
    await pool.query(
      `UPDATE intervention_requirements
       SET status = 'Overdue'
       WHERE status IN ('Pending', 'In Progress')
         AND dueDate IS NOT NULL
         AND dueDate < CURDATE()`
    );
    /* ponytail: CURDATE is server-local; for Manila-tz accuracy the
       requirement creator should supply a Manila dueDate. */
    res.json({ success: true, message: 'Overdue sweep complete' });
  } catch (error) { next(error); }
}

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: delete_,
  getInterventionTypes,
  assignInterventions,
  getResidentInterventions,
  getScheduledInterventions,
  updateInterventionStatus,
  getInterventionRequirements,
  createRequirement,
  updateRequirement,
  refreshOverdue,
};
