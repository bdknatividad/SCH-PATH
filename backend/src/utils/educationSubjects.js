/**
 * Subject results and the Overall Remark, computed in one place.
 *
 * The Education module's student cards and Passed/Failed tiles, and the Child
 * Record → Education tab, all show a learner's subject results. They read them
 * from here, over the stored `education_subject_results` rows, so the three
 * cannot disagree and nothing is copied to display it somewhere else.
 *
 * The rule matches the Subjects popup (`overallRemark` in
 * frontend/src/app/components/EducationSubjects.tsx): only subjects on the
 * learner's level list count; more passed than failed is Passed, anything else
 * Failed; nothing marked yet is no remark at all — such a learner is counted as
 * neither Passed nor Failed.
 *
 * @module utils/educationSubjects
 */

/** A legacy level name shares the subject list of the level it became. */
function subjectLevelFor(level) {
  const value = String(level || '').trim();
  if (value === 'High School') return 'Junior High School';
  if (value === 'ALS - Elementary') return 'ALS Elementary';
  return value;
}

/** 'Passed' | 'Failed' | null — see the module comment. */
function overallRemark(passed, failed) {
  if (passed + failed === 0) return null;
  return passed > failed ? 'Passed' : 'Failed';
}

/**
 * The subject summary of every learner record selected.
 *
 * @param {{query: Function}} executor - The pool (or a connection).
 * @param {{residentId?: string, recordIds?: string[]}} [filter]
 * @returns {Promise<Array<{educationRecordId: string, residentId: string|null,
 *   educationLevel: string, passed: number, failed: number, total: number,
 *   marked: number, overall: 'Passed'|'Failed'|null,
 *   subjects: Array<{subjectId: string, name: string, result: 'Passed'|'Failed'|null}>}>>}
 */
async function subjectSummaries(executor, filter = {}) {
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
  const [results] = await executor.query(
    `SELECT educationRecordId, subjectId, result FROM education_subject_results
      WHERE educationRecordId IN (${ids.map(() => '?').join(', ')})`,
    ids,
  );

  const resultsByRecord = new Map();
  for (const row of results) {
    if (!resultsByRecord.has(row.educationRecordId)) resultsByRecord.set(row.educationRecordId, new Map());
    resultsByRecord.get(row.educationRecordId).set(row.subjectId, row.result);
  }

  return records.map((record) => {
    const level = subjectLevelFor(record.educationLevel);
    const marks = resultsByRecord.get(record.id) || new Map();
    const levelSubjects = subjects
      .filter((s) => s.educationLevel === level)
      .map((s) => ({ subjectId: s.id, name: s.name, result: marks.get(s.id) || null }));
    const passed = levelSubjects.filter((s) => s.result === 'Passed').length;
    const failed = levelSubjects.filter((s) => s.result === 'Failed').length;
    return {
      educationRecordId: record.id,
      residentId: record.residentId || null,
      educationLevel: record.educationLevel,
      passed,
      failed,
      total: levelSubjects.length,
      marked: passed + failed,
      overall: overallRemark(passed, failed),
      subjects: levelSubjects,
    };
  });
}

module.exports = { subjectLevelFor, overallRemark, subjectSummaries };
