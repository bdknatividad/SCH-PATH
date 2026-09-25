/**
 * Response timestamp middleware.
 *
 * @module middleware/isoTimestamps
 * @description Gives every datetime on the way *out* an explicit UTC offset.
 *
 * This is the mirror of `middleware/normalizeDates`, which coerces datetimes on
 * the way *in* so MySQL accepts them. Together the two mean no caller has to
 * know the wire format in either direction.
 *
 * ## Why the response needs fixing at all
 *
 * The pool sets `dateStrings: true`, so a DATETIME comes back from MySQL as the
 * literal string stored — `2026-09-25 06:32:02` — with no zone on it. The
 * database holds UTC. JavaScript parses a date-time with no offset as **local**
 * time, so a Manila browser reads that as 06:32 +08:00 and every timestamp in
 * the system displays eight hours early.
 *
 * Adding the offset here means every client gets a real instant and can render
 * it in whatever zone it likes — including the browser's own. See
 * `utils/serverTime.js` for why this is one boundary fix rather than 47 call-site
 * fixes, and why `DATE` columns are deliberately left alone.
 *
 * ## Why middleware and not each controller
 *
 * Same reason as the request direction: a controller cannot opt out by accident.
 * There are dozens of endpoints, the generic controller serves a dozen resources
 * on its own, and a new one added tomorrow is covered the moment it exists.
 * `res.json` is the single funnel — every handler, including the error handler,
 * passes through it.
 *
 * `res.send` is deliberately not wrapped. It carries HTML, plain text and binary
 * bodies, none of which are datetimes, and running a deep walk over a document
 * download would be wasted work on the largest responses in the system.
 */

const { withIsoInstants } = require('../utils/serverTime');

/**
 * Express middleware: rewrite every timezone-less datetime string in the JSON
 * response into an ISO 8601 instant.
 *
 * `res.json` is replaced on the response object rather than monkey-patched
 * globally, so it applies for the life of exactly one request and cannot leak
 * into another.
 *
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function isoResponseTimestamps(_req, res, next) {
  const json = res.json.bind(res);

  res.json = (body) => json(withIsoInstants(body));

  next();
}

module.exports = { isoResponseTimestamps };
