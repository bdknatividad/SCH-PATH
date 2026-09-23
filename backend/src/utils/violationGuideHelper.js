/**
 * Violation Guide Helper
 * @module utils/violationGuideHelper
 * @description Helper functions for the DB-backed SCH Violation & Intervention Guide.
 */

const { pool } = require('../config/database');
const { generateId, runInTransactionWithIdRetry } = require('./helpers');

function parseMetadata(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function findGuideByViolationType(violationType) {
  try {
    const lowerType = String(violationType || '').trim().toLowerCase();
    if (!lowerType) return null;

    const [exactMatch] = await pool.query(
      `SELECT *
       FROM violation_guide
       WHERE status = 'Active'
         AND category IN ('Minor', 'Major')
         AND LOWER(TRIM(name)) = ?
       LIMIT 1`,
      [lowerType]
    );

    return exactMatch[0] || null;
  } catch (error) {
    console.error('Error finding guide:', error);
    return null;
  }
}

/**
 * Determine the offense level for the SAME resident + SAME violation guide.
 * The official guide has three columns: 1st, 2nd, and 3rd/Beyond.
 * Therefore every occurrence after the third uses the 3rd-level requirement set.
 */
async function determineOffenseLevel(
  residentId,
  violationType,
  excludeId = null,
  referenceDate = null
) {
  if (!residentId || !violationType) return '1st';

  try {
    const params = [residentId, violationType];
    const rawReference = String(referenceDate || '').trim();
    const monthMatch = rawReference.match(/^(\d{4})-(\d{1,2})/);
    const monthStart = monthMatch
      ? `${monthMatch[1]}-${String(Number(monthMatch[2])).padStart(2, '0')}-01`
      : (() => {
          const now = new Date();
          return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        })();
    const [yearText, monthText] = monthStart.split('-');
    const nextMonthDate = new Date(Number(yearText), Number(monthText), 1);
    const nextMonthStart = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, '0')}-01`;
    let query = `
      SELECT COUNT(*) AS count
      FROM violations
      WHERE residentId = ?
        AND type = ?
        AND status NOT IN ('Dismissed', 'Rejected', 'Pending Review')
        AND date >= ?
        AND date < ?
    `;
    params.push(monthStart, nextMonthStart);

    if (excludeId) {
      query += ' AND id != ?';
      params.push(excludeId);
    }

    const [result] = await pool.query(query, params);
    const count = Number(result[0]?.count || 0);

    if (count === 0) return '1st';
    if (count === 1) return '2nd';
    return '3rd';
  } catch (error) {
    console.error('Error determining offense level:', error);
    return '1st';
  }
}

/**
 * Create one intervention_tracker row for every requirement in the official
 * guide for the selected offense level.
 */
async function assignInterventions(
  residentId,
  violationId,
  guideId,
  offenseLevel
) {
  try {
    const normalizedLevel =
      offenseLevel === '4th+' || offenseLevel === '4th Offense+'
        ? '3rd'
        : offenseLevel;

    // The guide lookup and the tracker inserts share one transaction, so a
    // failure part-way cannot leave a resident with only some of the
    // interventions the guide prescribes.
    //
    // Seed the ID sequence from the table once, then hand out consecutive IDs.
    // generateId('IT') with no existing rows returns "IT001" for *every* call,
    // so the second INSERT in this loop always hit a duplicate primary key and
    // the transaction rolled back — assigning a guide with two or more
    // interventions could never succeed.
    //
    // That fixes collisions *within* this loop. A concurrent assignment still
    // starts from the same maximum, so the whole transaction is retried on a
    // primary-key collision — the fresh transaction's snapshot then sees the
    // ids the other assignment committed. See runInTransactionWithIdRetry.
    const created = await runInTransactionWithIdRetry(pool, async (connection) => {
      const [interventions] = await connection.query(
        `SELECT *
         FROM guide_interventions
         WHERE guideId = ?
         AND status = 'Active'
           AND offenseLevel = ?
         ORDER BY createdAt ASC`,
        [guideId, normalizedLevel]
      );

      const [existingTrackers] = await connection.query('SELECT id FROM intervention_tracker');
      const issuedIds = existingTrackers.map(row => ({ id: row.id }));
      const rows = [];

      for (const intervention of interventions) {
        const trackerId = generateId('IT', issuedIds);
        issuedIds.push({ id: trackerId });
        const metadata = parseMetadata(intervention.metadata);

        await connection.query(
          `INSERT INTO intervention_tracker
           (
             id,
             residentId,
             violationId,
             guideId,
             offenseLevel,
             interventionType,
             duration,
             unit,
             metadata,
             status
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'In Progress')`,
          [
            trackerId,
            residentId,
            violationId,
            guideId,
            normalizedLevel,
            intervention.interventionType,
            intervention.duration,
            intervention.unit,
            metadata == null ? null : JSON.stringify(metadata),
          ]
        );

        rows.push({
          id: trackerId,
          guideId,
          offenseLevel: normalizedLevel,
          interventionType: intervention.interventionType,
          duration: intervention.duration,
          unit: intervention.unit,
          metadata,
          officialText:
            metadata?.officialText ||
            metadata?.rawText ||
            intervention.interventionType,
        });
      }

      return rows;
    });

    return { success: true, data: created };
  } catch (error) {
    console.error('Error assigning interventions:', error);
    return { success: false, error: error.message };
  }
}

async function getResidentInterventions(residentId, status = null) {
  try {
    let query = `
      SELECT
        it.*,
        gi.metadata AS guideMetadata,
        gi.interventionType AS guideInterventionType,
        gi.duration AS guideDuration,
        gi.unit AS guideUnit
      FROM intervention_tracker it
      LEFT JOIN guide_interventions gi
        ON gi.guideId = it.guideId
       AND gi.offenseLevel = it.offenseLevel
       AND gi.interventionType = it.interventionType
       AND (gi.duration <=> it.duration)
       AND (gi.unit <=> it.unit)
      WHERE it.residentId = ?
    `;
    const values = [residentId];

    if (status) {
      query += ' AND it.status = ?';
      values.push(status);
    }

    query += ' ORDER BY it.createdAt DESC';

    const [interventions] = await pool.query(query, values);

    return interventions.map((row) => {
      const metadata = parseMetadata(row.guideMetadata);
      return {
        ...row,
        metadata,
        officialText:
          metadata?.officialText ||
          metadata?.rawText ||
          row.interventionType,
      };
    });
  } catch (error) {
    console.error('Error getting resident interventions:', error);
    return [];
  }
}

function getInterventionDisplay(intervention) {
  if (intervention?.officialText) {
    return intervention.officialText;
  }

  if (intervention?.metadata?.officialText) {
    return intervention.metadata.officialText;
  }

  if (intervention?.duration && intervention?.unit) {
    return `${intervention.interventionType} - ${intervention.duration} ${intervention.unit}`;
  }

  return intervention?.interventionType || 'Unspecified';
}

function formatInterventionsByLevel(interventions = []) {
  return {
    '1st': interventions.filter((i) => i.offenseLevel === '1st'),
    '2nd': interventions.filter((i) => i.offenseLevel === '2nd'),
    '3rd': interventions.filter((i) => i.offenseLevel === '3rd'),
  };
}

module.exports = {
  findGuideByViolationType,
  determineOffenseLevel,
  assignInterventions,
  getResidentInterventions,
  getInterventionDisplay,
  formatInterventionsByLevel,
};
