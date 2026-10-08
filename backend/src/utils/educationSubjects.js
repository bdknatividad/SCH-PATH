/**
 * Education Progress, read in one place.
 *
 * Pass / Fail is gone: each subject (module, activity) a learner takes now has
 * a progress status — Not Started, Ongoing, Submitted, Completed or Pending —
 * with the outputs submitted against the outputs expected, and every learner
 * has one Education Progress Monitoring record (modules completed / pending,
 * outputs submitted / not submitted, participation notes, date of monitoring,
 * concerns).
 *
 * The Education module's student cards and tiles, its View → Education
 * Progress tab and the Child Record → Education tab all read this, over the
 * stored rows, so they cannot disagree and nothing is copied to show it
 * somewhere else.
 *
 * The subject list belongs to the learner's education level; a subject with no
 * stored row yet reads as Not Started. The old `result` column (Passed /
 * Failed) is left in the table untouched and is no longer read.
 *
 * @module utils/educationSubjects
 */

const PROGRESS_STATUSES = ['Not Started', 'Ongoing', 'Submitted', 'Completed', 'Pending'];
const DEFAULT_PROGRESS_STATUS = 'Not Started';

/** The monitoring record's own fields, in the order the screens show them. */
const MONITORING_FIELDS = [
  'monitoringDate',
  'modulesCompleted',
  'modulesPending',
  'outputsSubmitted',
  'outputsNotSubmitted',
  'participationNotes',
  'concerns',
];

/** A legacy level name shares the subject list of the level it became. */
function subjectLevelFor(level) {
  const value = String(level || '').trim();
  if (value === 'High School') return 'Junior High School';
  if (value === 'ALS - Elementary') return 'ALS Elementary';
  return value;
}

function asCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function monitoringFromRow(row) {
  if (!row) return null;
  const out = {
    id: row.id,
    admissionId: row.admissionId || null,
    updatedBy: row.modifiedBy || row.createdBy || null,
    updatedAt: row.updatedAtText || null,
  };
  for (const field of MONITORING_FIELDS) out[field] = row[field] ?? (field === 'monitoringDate' ? null : '');
  return out;
}

/**
 * The Education Progress of every learner record selected.
 *
 * @param {{query: Function}} executor - The pool (or a connection).
 * @param {{residentId?: string, recordIds?: string[]}} [filter]
 * @returns {Promise<Array<{educationRecordId: string, residentId: string|null,
 *   educationLevel: string, total: number, counts: Record<string, number>,
 *   outputsSubmitted: number, outputsTotal: number,
 *   subjects: Array<{subjectId: string, name: string, status: string,
 *     outputsSubmitted: number|null, outputsTotal: number|null}>,
 *   monitoring: object|null}>>}
 */
async function progressSummaries(executor, filter = {}) {
  // `files` is deliberately not selected: it can hold large uploads.
  let recordSql = 'SELECT id, residentId, educationLevel FROM education_records';
  const params = [];
  if (filter.residentId) {
    recordSql += ' WHERE residentId = ?';
    params.push(filter.residentId);
  } else if (Array.isArray(filter.recordIds) && filter.recordIds.length) {
    recordSql += ` WHERE id IN (${filter.recordIds.map(() => '?').join(', ')})`;
    params.push(...filter.recordIds);
  }
  const [records] = await executor.query(recordSql, params);
  if (!records.length) return [];

  const [subjects] = await executor.query(
    'SELECT id, educationLevel, name FROM education_subjects ORDER BY sortOrder ASC, createdAt ASC',
  );
  const ids = records.map((r) => r.id);
  const marks = ids.map(() => '?').join(', ');
  const [rows] = await executor.query(
    `SELECT educationRecordId, subjectId, progressStatus, outputsSubmitted, outputsTotal
       FROM education_subject_results
      WHERE educationRecordId IN (${marks})`,
    ids,
  );

  let monitoringRows = [];
  try {
    [monitoringRows] = await executor.query(
      `SELECT m.*, DATE_FORMAT(m.monitoringDate, '%Y-%m-%d') AS monitoringDate,
              DATE_FORMAT(m.updatedAt, '%Y-%m-%d %H:%i:%s') AS updatedAtText
         FROM education_progress_monitoring m
        WHERE m.educationRecordId IN (${marks})`,
      ids,
    );
  } catch (error) {
    if (error?.code !== 'ER_NO_SUCH_TABLE') throw error;
  }
  const monitoringByRecord = new Map(monitoringRows.map((row) => [row.educationRecordId, row]));

  const bySubject = new Map();
  for (const row of rows) {
    if (!bySubject.has(row.educationRecordId)) bySubject.set(row.educationRecordId, new Map());
    bySubject.get(row.educationRecordId).set(row.subjectId, row);
  }

  return records.map((record) => {
    const level = subjectLevelFor(record.educationLevel);
    const stored = bySubject.get(record.id) || new Map();
    const levelSubjects = subjects
      .filter((s) => s.educationLevel === level)
      .map((s) => {
        const row = stored.get(s.id);
        const status = PROGRESS_STATUSES.includes(row?.progressStatus) ? row.progressStatus : DEFAULT_PROGRESS_STATUS;
        return {
          subjectId: s.id,
          name: s.name,
          status,
          outputsSubmitted: asCount(row?.outputsSubmitted),
          outputsTotal: asCount(row?.outputsTotal),
        };
      });
    const counts = Object.fromEntries(PROGRESS_STATUSES.map((status) => [status, 0]));
    for (const subject of levelSubjects) counts[subject.status] += 1;
    return {
      educationRecordId: record.id,
      residentId: record.residentId || null,
      educationLevel: record.educationLevel,
      total: levelSubjects.length,
      counts,
      outputsSubmitted: levelSubjects.reduce((sum, s) => sum + (s.outputsSubmitted || 0), 0),
      outputsTotal: levelSubjects.reduce((sum, s) => sum + (s.outputsTotal || 0), 0),
      subjects: levelSubjects,
      monitoring: monitoringFromRow(monitoringByRecord.get(record.id)),
    };
  });
}

module.exports = {
  PROGRESS_STATUSES,
  DEFAULT_PROGRESS_STATUS,
  MONITORING_FIELDS,
  subjectLevelFor,
  progressSummaries,
};
