/**
 * Security response headers.
 *
 * @module middleware/securityHeaders
 * @description Sets the baseline hardening headers on every API response.
 *
 * Why this exists rather than `helmet`:
 *
 * The project ships without `helmet`, and the four headers that matter for a
 * JSON API are a dozen lines. Adding a dependency to set four constants is not
 * a trade this codebase makes anywhere else — it wrote its own rate limiter and
 * its own validators for the same reason.
 *
 * What each header buys, given that this API returns JSON and never HTML:
 *
 *   X-Content-Type-Options: nosniff
 *     Stops a browser from re-interpreting a JSON body as HTML or JavaScript
 *     because it guessed the type. The only XSS route this API has is a
 *     response being sniffed into something executable.
 *
 *   X-Frame-Options / CSP frame-ancestors
 *     The API must never be framed. `frame-ancestors 'none'` is the modern
 *     form; X-Frame-Options is kept for older browsers that ignore it.
 *
 *   Strict-Transport-Security
 *     Railway terminates TLS at its edge and forwards over the private
 *     network, so the app cannot see whether the original request was secure
 *     unless the proxy says so — which is exactly what `trust proxy` above
 *     arranges. Once that is set, HSTS is safe to assert, and it is what stops
 *     a downgrade to plain HTTP on the next visit.
 *
 *   Referrer-Policy
 *     Keeps API URLs (which carry record ids) out of the Referer of any
 *     third-party request a page makes.
 *
 *   Permissions-Policy
 *     The API serves no documents, so no origin that somehow renders one of
 *     its responses should be able to ask for camera, microphone or location.
 *
 * Deliberately absent: a Content-Security-Policy beyond frame-ancestors. The
 * frontend is served by Vercel, which sets its own; a `default-src` here would
 * apply to JSON responses that load nothing, and a wrong one would be noise
 * that hides the real policy in the browser's report.
 *
 * The frontend's own header set lives in `frontend/vercel.json` and is the
 * one that governs the pages a person actually loads.
 */

const HSTS_MAX_AGE = 60 * 60 * 24 * 180; // 180 days

/**
 * Express middleware setting the hardening headers.
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Only over HTTPS. Railway's edge terminates TLS and sets
  // `x-forwarded-proto`; sending HSTS over plain HTTP is ignored by browsers
  // anyway, but asserting it on a local http:// dev server would pin
  // localhost to https in the developer's browser and break the next run.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE}; includeSubDomains`);
  }

  next();
}

module.exports = { securityHeaders };
