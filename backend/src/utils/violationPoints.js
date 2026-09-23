/**
 * Violation severity → points.
 * @module utils/violationPoints
 *
 * `violations.points` is what both the urgency rating on the dashboard and the
 * monthly performance ratings SUM. It was declared in the schema and skipped by
 * every writer, so it defaulted to 0 and every resident read as "Very Good" no
 * matter how many unresolved violations they carried — the widget was, in
 * effect, hardcoded.
 *
 * The map itself lives in `constants.VIOLATION_SEVERITY`; this module is the one
 * place that turns a severity into the number stored in that column, so a writer
 * cannot invent its own scale.
 */

const { VIOLATION_SEVERITY } = require('./constants');

/**
 * Points for a severity, e.g. `'Major'` → 3. Unknown or missing severities are
 * worth 0 rather than throwing: a violation row must not fail to save because
 * its category is new.
 *
 * @param {string} severity
 * @returns {number}
 */
function pointsForSeverity(severity) {
  const raw = String(severity || '').trim();
  if (!raw) return 0;

  const exact = VIOLATION_SEVERITY[raw];
  if (exact) return exact.points;

  // The stored severities are capitalized ('Minor', 'Major', 'Critical'), but a
  // guide row or a hand-written API call may arrive in another case.
  const canonical = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return VIOLATION_SEVERITY[canonical] ? VIOLATION_SEVERITY[canonical].points : 0;
}

module.exports = { pointsForSeverity };
