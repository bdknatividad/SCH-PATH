/**
 * Which admission a newly created document belongs to.
 *
 * Documents are filed Resident → Admission → Category → File, so every
 * `documents` row has to carry the admission it was produced under. Without it
 * a returning resident's files are only distinguishable by upload timestamp,
 * which cannot tell two same-day admissions apart and silently mixes the two
 * whenever a document is created without an `uploadedAt`.
 *
 * The active admission is the right answer at creation time: a resident has at
 * most one open admission, and anything produced while they are in care was
 * produced under it. The fallback covers the gap between a discharge and a
 * re-intake — every admission closed, but records still being written — where
 * the most recent admission is the only sensible folder.
 *
 * The `ORDER BY` mirrors `dischargeController`: the active admission first, then
 * the highest admission number. `admissionNumber` is per resident, so this is
 * the resident's own latest admission and never another resident's.
 */

/**
 * @param {{ query: Function }} executor A pool or an open transaction connection.
 * @param {string} residentId
 * @returns {Promise<string|null>} the admission id, or null when the resident
 *   has no admission on record at all.
 */
async function activeAdmissionIdFor(executor, residentId) {
  if (!executor || !residentId) return null;

  const [rows] = await executor.query(
    `SELECT id
       FROM admissions
      WHERE residentId = ?
      ORDER BY (status = 'Active') DESC, admissionNumber DESC
      LIMIT 1`,
    [residentId]
  );

  return rows[0]?.id || null;
}

module.exports = { activeAdmissionIdFor };
