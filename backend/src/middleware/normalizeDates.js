/**
 * Request date normalisation middleware.
 *
 * @module middleware/normalizeDates
 * @description Rewrites date/datetime fields in an incoming body into the
 * exact string shape MySQL expects, for every route, before any handler runs.
 *
 * Why this is middleware and not a controller concern:
 *
 * The frontend sends `new Date().toISOString()` — `2026-09-23T07:04:36.462Z` —
 * for whatever date field a form is filled in with. MySQL rejects that format
 * for DATE and DATETIME columns alike:
 *
 *   ERROR 1292 (22007): Incorrect datetime value: '2026-09-23T07:04:36.462Z'
 *   for column 'uploadedAt' at row 1
 *
 * A MariaDB instance without strict mode (the local XAMPP default) accepts it,
 * so the bug is invisible in development and only fires in production. Fixing
 * it per caller was not enough: there are dozens of `toISOString()` sites in
 * the frontend and a new one would silently reintroduce it. Normalising at the
 * edge means every present and future write path is covered at once, and a
 * controller cannot opt out by accident.
 *
 * Only the body is touched. Query strings and route params are compared rather
 * than stored, so rewriting them would change filter semantics.
 */

const { normalizeDatetimes } = require('../utils/helpers');

/**
 * Express middleware: replace `req.body` with a copy whose date fields are
 * MySQL-compatible strings.
 *
 * A shallow copy is assigned rather than mutating in place so that the raw
 * body remains available to any error logger that captured it earlier in the
 * chain, and so `sanitizeBody`-style consumers downstream see a plain object.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
function normalizeRequestDates(req, _res, next) {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    req.body = normalizeDatetimes(req.body);
  }
  next();
}

module.exports = { normalizeRequestDates };
