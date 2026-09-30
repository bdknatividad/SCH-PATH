/**
 * Did this resident finish the programme, or was the timeline forced?
 *
 * This is the question a discharge turns on. A phase row is marked complete only
 * when its documents are `Approved` and its checklist is ticked — or when a
 * Center Head or Social Worker overrode it, which the `forced` column records.
 * So the two facts together answer it: every phase of the current admission has
 * a `completedAt`, and none of them was forced.
 *
 * The distinction matters because the two outcomes are not the same thing. A
 * resident who met every requirement is **Discharged**; one who was pushed
 * through is **Transferred**, and recording the second as the first would put a
 * completed programme on file for someone who never completed it.
 */

const { CASE_PHASES } = require('./constants');

/**
 * The rows belonging to the resident's **current** admission.
 *
 * A returning resident's earlier stay is retired but its rows are still on file,
 * and every one of them is complete — so reading the whole history would call a
 * resident who has just been re-admitted "finished". The slice starts at the
 * newest `Admission Phase` row rather than trusting `admissionId`, which legacy
 * rows do not carry; `backfillPhaseProgressAdmissions()` fills it where it can.
 */
function currentAdmissionRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (String(list[i]?.phaseName || '').trim() === 'Admission Phase') {
      return list.slice(i);
    }
  }
  return list;
}

/**
 * @param {{query: Function}} executor pool or a transaction connection
 * @param {string} residentId
 * @returns {Promise<{forced:boolean, missingPhases:string[], complete:boolean}>}
 */
async function admissionCompletion(executor, residentId) {
  const [rows] = await executor.query(
    `SELECT phaseName, completedAt, forced
       FROM phaseProgress
      WHERE residentId = ?
      ORDER BY enteredAt ASC, id ASC`,
    [residentId],
  );

  const current = currentAdmissionRows(rows);
  const forced = current.some((row) => Number(row.forced) === 1);
  const done = new Set(
    current.filter((row) => row.completedAt).map((row) => String(row.phaseName || '').trim()),
  );
  const missingPhases = CASE_PHASES.filter((phase) => !done.has(phase));

  return { forced, missingPhases, complete: missingPhases.length === 0 && !forced };
}

module.exports = { admissionCompletion, currentAdmissionRows };
