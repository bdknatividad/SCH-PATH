/**
 * Backfill `children.previousCases[i].admissionId`.
 *
 * The Documents module files a resident's files Resident → Admission → Category
 * → File. `documents.admissionId` says which admission a file belongs to, and
 * `previousCases` says which admissions the resident has had — but the two could
 * not be joined until `previousCases` named the admission too.
 *
 * A record written before this carries `admissionNumber` and dates but no id, so
 * the folder view cannot match a document to its period and falls back to
 * comparing upload timestamps. This fills the id in from the `admissions` row
 * that already holds it, keyed on (residentId, admissionNumber) — the pair that
 * is unique per resident.
 *
 * Idempotent: entries that already carry an admissionId are left alone.
 *
 * Run: node src/scripts/backfillPreviousCaseAdmissionIds.mjs
 */

import { pool } from '../config/database.js';

async function backfill() {
  const [children] = await pool.query(
    `SELECT id, previousCases
       FROM children
      WHERE previousCases IS NOT NULL
        AND previousCases <> ''
        AND previousCases <> '[]'`
  );

  console.log(`${children.length} resident(s) with an admission history.`);

  let updatedResidents = 0;
  let updatedEntries = 0;

  for (const child of children) {
    let history;
    try {
      history = JSON.parse(child.previousCases);
    } catch {
      console.log(`  ${child.id}: previousCases is not valid JSON — skipped.`);
      continue;
    }
    if (!Array.isArray(history) || history.length === 0) continue;

    const [admissions] = await pool.query(
      'SELECT id, admissionNumber FROM admissions WHERE residentId = ?',
      [child.id]
    );
    const idByNumber = new Map(admissions.map((row) => [Number(row.admissionNumber), row.id]));

    let changed = false;
    for (const entry of history) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.admissionId) continue;
      const id = idByNumber.get(Number(entry.admissionNumber));
      if (!id) {
        console.log(`  ${child.id}: no admission row for #${entry.admissionNumber} — left as is.`);
        continue;
      }
      entry.admissionId = id;
      updatedEntries += 1;
      changed = true;
    }

    if (!changed) continue;

    await pool.query('UPDATE children SET previousCases = ? WHERE id = ?', [
      JSON.stringify(history),
      child.id,
    ]);
    updatedResidents += 1;
  }

  console.log(`Linked ${updatedEntries} admission entr(ies) across ${updatedResidents} resident(s).`);
  await pool.end();
}

backfill().catch((error) => {
  console.error('Backfill failed:', error);
  process.exit(1);
});
