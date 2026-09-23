/**
 * Rate Limiting Middleware
 * @module middleware/rateLimit
 * @description Small fixed-window in-memory limiter. Deliberately dependency
 *              free — the project already ships without a rate-limit package
 *              and this covers the single endpoint that actually needs it
 *              (credential submission).
 *
 * Scope note: the counters live in process memory, so they are per-instance.
 * That is sufficient for the current single-process deployment; if the API is
 * ever scaled horizontally this must move to a shared store (e.g. Redis).
 */

const { ApiError } = require('./errorHandler');

/**
 * Build an Express middleware that rejects requests above `max` within
 * `windowMs`.
 *
 * @param {Object} [options]
 * @param {number} [options.windowMs=900000] Window length in ms (default 15 min)
 * @param {number} [options.max=10] Allowed requests per window per key
 * @param {(req: Object) => string} [options.keyGenerator] Bucket key builder
 * @param {string} [options.message] Error message for 429 responses
 * @returns {Function} Express middleware, with a `.reset(key)` helper
 */
function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  max = 10,
  keyGenerator,
  message = 'Too many attempts. Please try again later.',
} = {}) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();
  let lastSweep = 0;

  // Default key: one bucket per client IP *per submitted username*, so one
  // noisy account cannot lock out everyone else behind the same NAT address.
  const buildKey = keyGenerator || ((req) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    return `${req.ip}|${username}`;
  });

  function sweep(now) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  function middleware(req, res, next) {
    const now = Date.now();

    // Opportunistic cleanup keeps the map bounded without a timer handle.
    if (now - lastSweep > windowMs) {
      sweep(now);
      lastSweep = now;
    }

    const key = buildKey(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return next(new ApiError(429, message));
    }

    // Lets a route clear its own bucket after a success, so a legitimate user
    // who mistyped a password a few times is not locked out once they get in.
    req.resetRateLimit = () => buckets.delete(key);
    return next();
  }

  middleware.reset = (key) => buckets.delete(key);
  middleware.clear = () => buckets.clear();

  return middleware;
}

module.exports = { createRateLimiter };
