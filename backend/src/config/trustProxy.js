/**
 * Resolve Express's `trust proxy` setting from the environment.
 *
 * @module config/trustProxy
 * @description Kept separate from `server.js` so the hop-count rules can be
 * asserted directly, without starting a listener or opening a pool. The value
 * is security-relevant: over-trusting lets a client prepend
 * `X-Forwarded-For: <anything>` and pick its own rate-limit bucket, which turns
 * login throttling into a formality.
 *
 * Why the hop count matters at all — see the long note in `server.js`. In
 * short, Railway puts at least one proxy between the visitor and the app, so
 * `req.ip` is a Railway node rather than the client. `createRateLimiter` keys
 * its buckets on `req.ip|username`, so an unstable `req.ip` means no bucket
 * ever fills and login throttling silently stops working.
 */

/** Hops used when nothing is configured. Railway's trace names two. */
const DEFAULT_HOPS = 2;

/**
 * @param {Object} env - Process environment (or a stand-in in tests)
 * @returns {number|boolean} Value for `app.set('trust proxy', ...)`
 */
function resolveTrustProxy(env = {}) {
  const raw = env.TRUST_PROXY;

  // Unset or empty: fall back to the deployment default rather than to
  // `false`. `false` would silently restore the bug this exists to fix.
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_HOPS;
  }

  const value = String(raw).trim();

  // Explicit opt-outs, for a deployment with no proxy at all.
  if (value === 'false' || value === '0') return false;
  if (value === 'true') return true;

  const hops = Number(value);

  // A malformed or non-positive value is not a reason to disable the setting —
  // that would fail open. Keep the safe default and let the log surface it.
  if (!Number.isInteger(hops) || hops < 1) {
    console.warn(
      `[config] TRUST_PROXY="${value}" is not a positive integer or boolean; using ${DEFAULT_HOPS}.`,
    );
    return DEFAULT_HOPS;
  }

  return hops;
}

module.exports = { resolveTrustProxy, DEFAULT_HOPS };
