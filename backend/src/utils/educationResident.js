/**
 * Which resident an Education Module learner record belongs to.
 *
 * Every file the Education Module produces — an uploaded Performance,
 * Evaluation or Certificate file, a School Visit Report, a Quarterly Education
 * Report — is filed in the Documents module under the learner's own resident
 * folder (Child -> Admission -> Education Files/Records). The browser used to
 * pick that resident itself, by id or by an exact name match, so a learner
 * added before the masterlist link existed, or a returning resident who holds
 * one `children` row per admission, could land in the wrong folder or nowhere.
 * The server now answers it in one place.
 *
 * The answer, in order:
 *   1. the resident the learner record is linked to, and every row that shares
 *      that resident's name (a returning resident), or — for a record that was
 *      never linked — every resident whose name matches the learner's;
 *   2. of those, the one in care now: an Active admission first, then a
 *      resident whose case is not closed, then the linked row, then the latest
 *      admission.
 *
 * A record that was never linked is linked here once its resident is found
 * (unless another learner already holds that resident), so the learner, its
 * subject results and every later file agree on one resident.
 *
 * @param {{ query: Function }} executor pool or open connection
 * @param {string|{id:string,name?:string,residentId?:string}} recordOrId
 * @param {{ link?: boolean }} [options] link=false only reads
 * @returns {Promise<{ residentId: string, residentName: string, record: object } | null>}
 */
async function resolveEducationResident(executor, recordOrId, { link = true } = {}) {
  let record = recordOrId;
  if (!record || typeof record !== 'object') {
    const [rows] = await executor.query(
      'SELECT id, name, residentId FROM education_records WHERE id = ? LIMIT 1',
      [recordOrId],
    );
    record = rows[0];
  }
  if (!record) return null;

  let name = String(record.name || '').trim();
  if (record.residentId) {
    const [linked] = await executor.query('SELECT name FROM children WHERE id = ? LIMIT 1', [record.residentId]);
    if (linked[0]?.name) name = String(linked[0].name).trim();
  }

  const [candidates] = await executor.query(
    `SELECT c.id, c.name, c.status,
            EXISTS(SELECT 1 FROM admissions a WHERE a.residentId = c.id AND a.status = 'Active') AS hasActiveAdmission,
            (SELECT MAX(a.admissionNumber) FROM admissions a WHERE a.residentId = c.id) AS lastAdmission
       FROM children c
      WHERE c.id = ? OR (? <> '' AND LOWER(TRIM(c.name)) = LOWER(?))`,
    [record.residentId || '', name, name],
  );
  if (!candidates.length) return null;

  const closed = (status) => ['Discharged', 'Transferred'].includes(String(status || '').trim());
  candidates.sort((a, b) =>
    (Number(b.hasActiveAdmission) - Number(a.hasActiveAdmission))
    || (Number(!closed(b.status)) - Number(!closed(a.status)))
    || (Number(b.id === record.residentId) - Number(a.id === record.residentId))
    || (Number(b.lastAdmission || 0) - Number(a.lastAdmission || 0))
    || String(b.id).localeCompare(String(a.id)));
  const resident = candidates[0];

  // Only a record that was never linked is linked, and only to a resident no
  // other learner record already holds — the masterlist keeps one learner per
  // resident, and an existing link is the Educator's choice, not this one's.
  if (link && !record.residentId) {
    const [taken] = await executor.query(
      'SELECT id FROM education_records WHERE residentId = ? AND id <> ? LIMIT 1',
      [resident.id, record.id],
    );
    if (!taken.length) {
      await executor.query('UPDATE education_records SET residentId = ? WHERE id = ? AND residentId IS NULL', [resident.id, record.id]);
    }
  }

  return { residentId: resident.id, residentName: resident.name, record: { ...record, residentId: resident.id } };
}

module.exports = { resolveEducationResident };
