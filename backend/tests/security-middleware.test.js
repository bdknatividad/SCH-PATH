/**
 * Security middleware regression tests.
 *
 * Covers three fixes that had no coverage before:
 *   1. JWT signing-secret validation (startup must refuse a known secret)
 *   2. Login rate limiting (brute-force throttle on /api/users/login)
 *   3. optionalAuth must re-read the account instead of trusting the token
 *
 * Run with:  npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { assessJwtSecret, JWT_SECRET_MIN_LENGTH } = require('../src/utils/security');
const { createRateLimiter } = require('../src/middleware/rateLimit');
const { normalizeRole } = require('../src/utils/authorization');

// ─────────────────────────────── 1. JWT secret ───────────────────────────────

test('JWT secret: an unset secret is rejected', () => {
  for (const value of [undefined, null, '', '   ']) {
    const result = assessJwtSecret(value);
    assert.equal(result.ok, false, `expected ${JSON.stringify(value)} to be rejected`);
    assert.match(result.reason, /not set/i);
  }
});

test('JWT secret: a too-short secret is rejected', () => {
  const result = assessJwtSecret('a'.repeat(JWT_SECRET_MIN_LENGTH - 1));
  assert.equal(result.ok, false);
  assert.match(result.reason, /at least/i);
});

test('JWT secret: the historical default placeholder is rejected', () => {
  // This exact string used to be the hard-coded fallback in middleware/auth.js.
  const result = assessJwtSecret('your_jwt_secret_key_change_this_in_production');
  assert.equal(result.ok, false, 'a publicly known secret must never be accepted');
  assert.match(result.reason, /placeholder/i);
});

test('JWT secret: a strong random secret is accepted', () => {
  const result = assessJwtSecret('a'.repeat(64));
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

// ───────────────────────────── 2. Rate limiting ──────────────────────────────

function makeReq(body = {}, ip = '10.0.0.1') {
  return { body, ip, headers: {} };
}

function makeRes() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) { headers[name] = value; },
  };
}

/** Drive one middleware invocation and resolve with whatever it passes to next(). */
function run(middleware, req, res) {
  return new Promise((resolve) => {
    middleware(req, res, (err) => resolve(err || null));
  });
}

test('rate limiter: allows up to the limit, then rejects with 429', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3, message: 'too many' });
  const res = makeRes();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const err = await run(limiter, makeReq({ username: 'alice' }), res);
    assert.equal(err, null, `attempt ${attempt} should be allowed`);
  }

  const blocked = await run(limiter, makeReq({ username: 'alice' }), res);
  assert.ok(blocked, 'the 4th attempt must be rejected');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.message, 'too many');
  assert.ok(res.headers['Retry-After'], 'a 429 must advertise Retry-After');
});

test('rate limiter: counts per username, not just per IP', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
  const res = makeRes();

  await run(limiter, makeReq({ username: 'alice' }), res);
  await run(limiter, makeReq({ username: 'alice' }), res);
  assert.ok(await run(limiter, makeReq({ username: 'alice' }), res), 'alice is throttled');

  // A different account from the same address must not inherit alice's bucket.
  assert.equal(await run(limiter, makeReq({ username: 'bob' }), res), null);
});

test('rate limiter: resetRateLimit clears the bucket after a successful login', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
  const res = makeRes();

  const first = makeReq({ username: 'carol' });
  await run(limiter, first, res);
  await run(limiter, makeReq({ username: 'carol' }), res);
  assert.ok(await run(limiter, makeReq({ username: 'carol' }), res), 'bucket is exhausted');

  // The route calls this on success.
  assert.equal(typeof first.resetRateLimit, 'function');
  first.resetRateLimit();

  assert.equal(
    await run(limiter, makeReq({ username: 'carol' }), res),
    null,
    'a successful login must clear the counter'
  );
});

test('rate limiter: the window expires', async () => {
  const limiter = createRateLimiter({ windowMs: 30, max: 1 });
  const res = makeRes();

  await run(limiter, makeReq({ username: 'dave' }), res);
  assert.ok(await run(limiter, makeReq({ username: 'dave' }), res), 'second call is throttled');

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    await run(limiter, makeReq({ username: 'dave' }), res),
    null,
    'the bucket must reset once the window elapses'
  );
});

// ───────────────────────────── 3. optionalAuth ───────────────────────────────

const DB_MODULE_PATH = require.resolve('../src/config/database');
const AUTH_MODULE_PATH = require.resolve('../src/middleware/auth');

/**
 * Load middleware/auth.js against a stubbed database pool, then restore the
 * real module cache so the rest of the process is unaffected.
 */
function loadAuthWithStub(poolStub) {
  const dbEntry = require.cache[DB_MODULE_PATH];
  const authEntry = require.cache[AUTH_MODULE_PATH];

  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH,
    filename: DB_MODULE_PATH,
    loaded: true,
    exports: { pool: poolStub, dbConfig: {}, testConnection: async () => true },
  };
  delete require.cache[AUTH_MODULE_PATH];

  const auth = require(AUTH_MODULE_PATH);

  if (dbEntry) require.cache[DB_MODULE_PATH] = dbEntry;
  else delete require.cache[DB_MODULE_PATH];
  if (authEntry) require.cache[AUTH_MODULE_PATH] = authEntry;
  else delete require.cache[AUTH_MODULE_PATH];

  return auth;
}

const TEST_SECRET = 'unit-test-secret-value-that-is-long-enough';
process.env.JWT_SECRET = TEST_SECRET;

function tokenFor(payload) {
  return jwt.sign(payload, TEST_SECRET, { expiresIn: '1h' });
}

function authHeader(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

/** Build a pool stub that records its calls and returns one user row. */
function poolReturning(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return [rows];
    },
  };
}

test('optionalAuth: the database role wins over the role baked into the token', async () => {
  const pool = poolReturning([
    { id: 'U1', username: 'nurse.one', role: 'nurse', status: 'Active' },
  ]);
  const { optionalAuth } = loadAuthWithStub(pool);

  // Token claims centerhead; the account is actually a nurse.
  const req = { ...authHeader(tokenFor({ id: 'U1', username: 'nurse.one', role: 'centerhead' })) };
  await new Promise((resolve) => optionalAuth(req, {}, resolve));

  assert.equal(pool.calls.length, 1, 'the account must be re-read from the database');
  assert.ok(req.user, 'an active user should still be attached');
  assert.equal(req.user.role, normalizeRole('nurse'));
  assert.notEqual(req.user.role, normalizeRole('centerhead'));
});

test('optionalAuth: an inactive account is treated as anonymous', async () => {
  const pool = poolReturning([
    { id: 'U2', username: 'gone', role: 'socialworker', status: 'Inactive' },
  ]);
  const { optionalAuth } = loadAuthWithStub(pool);

  const req = { ...authHeader(tokenFor({ id: 'U2', username: 'gone', role: 'socialworker' })) };
  await new Promise((resolve) => optionalAuth(req, {}, resolve));

  assert.equal(req.user, undefined, 'a deactivated account must not authenticate');
});

test('optionalAuth: a deleted account is treated as anonymous', async () => {
  const pool = poolReturning([]);
  const { optionalAuth } = loadAuthWithStub(pool);

  const req = { ...authHeader(tokenFor({ id: 'U3', username: 'deleted', role: 'admin' })) };
  await new Promise((resolve) => optionalAuth(req, {}, resolve));

  assert.equal(req.user, undefined);
});

test('optionalAuth: a malformed token degrades to anonymous instead of erroring', async () => {
  const pool = poolReturning([]);
  const { optionalAuth } = loadAuthWithStub(pool);

  const req = { headers: { authorization: 'Bearer not-a-real-token' } };
  let nextError = 'unset';
  await new Promise((resolve) => {
    optionalAuth(req, {}, (err) => { nextError = err; resolve(); });
  });

  assert.equal(nextError, undefined, 'optionalAuth must never propagate a token error');
  assert.equal(req.user, undefined);
});

test('optionalAuth: a request with no Authorization header passes straight through', async () => {
  const pool = poolReturning([]);
  const { optionalAuth } = loadAuthWithStub(pool);

  const req = { headers: {} };
  await new Promise((resolve) => optionalAuth(req, {}, resolve));

  assert.equal(req.user, undefined);
  assert.equal(pool.calls.length, 0, 'no database work for an anonymous request');
});
