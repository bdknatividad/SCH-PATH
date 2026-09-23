/**
 * HTTP-level integration tests.
 *
 * These exercise the real Express app — routing order, the auth middleware, the
 * login throttle and the profile endpoint — against a stubbed database pool.
 * No MySQL instance is required, and no real network is touched: the app is
 * bound to an ephemeral loopback port for the duration of each test.
 *
 * This closes the biggest gap in the earlier test coverage, which was entirely
 * unit-level. The first test below originally settled whether the legacy generic
 * `GET /api/:resource` handler in routes/index.js was reachable — it was not,
 * and the handler has since been deleted. That test now stands as a guard
 * against anyone reintroducing an unfiltered generic read endpoint.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const TEST_SECRET = 'integration-test-secret-value-long-enough';
process.env.JWT_SECRET = TEST_SECRET;

const DB_MODULE_PATH = require.resolve('../src/config/database');
const ROUTES_MODULE_PATH = require.resolve('../src/routes');
const SRC_ROOT = path.resolve(__dirname, '..', 'src');

/**
 * Drop every cached module that lives under src/ so the next require()
 * re-executes it. Third-party modules (node_modules) are left alone.
 */
function purgeSrcModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_ROOT) && !key.includes('node_modules')) {
      delete require.cache[key];
    }
  }
}

// A hash for the password below. Pre-computed once so the tests stay fast.
const KNOWN_PASSWORD = 'correct-horse-battery';
let knownPasswordHashPromise = null;
function knownPasswordHash() {
  if (!knownPasswordHashPromise) knownPasswordHashPromise = bcrypt.hash(KNOWN_PASSWORD, 4);
  return knownPasswordHashPromise;
}

/**
 * Build a pool stub that records every statement and answers the two auth
 * lookups. Everything else returns an empty result set.
 */
function createPoolStub({ passwordHash = null } = {}) {
  const queries = [];

  async function query(sql, params) {
    const text = String(sql);
    queries.push({ sql: text, params });

    // updateProfile()/changePassword() password verification.
    // NOTE: this branch MUST come before the generic account lookup below —
    // `SELECT password FROM users WHERE id = ?` also matches that looser
    // pattern, and matching it first would hand the controller a row with no
    // `password` column at all, making the verification appear to fail.
    if (/SELECT password FROM users WHERE id = \?/i.test(text)) {
      return [[{ password: passwordHash }]];
    }
    // authenticate() / optionalAuth() account lookup
    if (/FROM users WHERE id = \?/i.test(text)) {
      return [[{ id: 'U-TEST', username: 'tester', role: 'centerhead', status: 'Active' }]];
    }
    return [[]];
  }

  const pool = {
    queries,
    query,
    async getConnection() {
      return {
        query,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      };
    },
  };

  return pool;
}

/** Inject the stub, then load the router so every controller binds to it. */
function loadApp(poolStub) {
  // Every module under src/ captured `pool` at import time, and the router
  // (plus the rate limiter's in-memory counters) is a singleton. Without this
  // purge, only the FIRST loadApp call would bind to the stub it was given —
  // later calls would silently keep talking to the first test's stub, and the
  // throttle state would leak across tests. server.js is never imported here,
  // so there is no cron job to double-register.
  purgeSrcModules();

  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH,
    filename: DB_MODULE_PATH,
    loaded: true,
    exports: { pool: poolStub, dbConfig: {}, testConnection: async () => true },
  };

  const express = require('express');
  const routes = require(ROUTES_MODULE_PATH);
  const { errorHandler, notFoundHandler } = require('../src/middleware/errorHandler');

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', routes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Run `fn` against a live server on an ephemeral port, then shut it down. */
async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  // The error handler logs every non-2xx; keep the test output readable.
  const originalError = console.error;
  console.error = () => {};

  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
  }
}

function tokenFor(role = 'centerhead') {
  return jwt.sign({ id: 'U-TEST', username: 'tester', role }, TEST_SECRET, { expiresIn: '1h' });
}

function authedFetch(base, path, init = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenFor()}`,
      ...(init.headers || {}),
    },
  });
}

// ───────────────────── the legacy generic GET is unreachable ─────────────────

test('legacy generic GET /api/:resource never executes (routing shadowing)', async () => {
  // Guards against reintroducing the unfiltered generic read endpoint that used
  // to live at the bottom of routes/index.js. That handler returned every row of
  // a table with no role, ownership or resident-assignment filtering. It never
  // ran — every resource in its allow-list is already mounted above at a more
  // specific path, and Express matches the earlier mount first — so it was
  // deleted. This test fails if anyone adds it back.
  //
  // Its SQL is distinctive: a backticked table name with no WHERE clause, while
  // the real list controllers build `... FROM children WHERE 1=1` style queries
  // with an unquoted table name. (The same shape appears at routes/index.js:107
  // inside the GET /store bulk loader, which is intentional and is not reached
  // by any of the request paths exercised below.)
  const GENERIC_HANDLER_SQL = /^SELECT \* FROM `\w+` ORDER BY/;

  const pool = createPoolStub();
  const app = loadApp(pool);

  const resources = ['children', 'staff', 'activities', 'assessments', 'reports',
    'healthRecords', 'activityEvaluations', 'violations', 'alerts', 'courtRecords',
    'phaseProgress'];

  await withServer(app, async (base) => {
    for (const resource of resources) {
      pool.queries.length = 0;
      const res = await authedFetch(base, `/api/${resource}`);

      assert.notEqual(res.status, 404, `GET /api/${resource} should be handled by its own router`);

      // Anti-vacuity: the request must actually have reached a controller that
      // talked to the database. Without this, the test would also pass if the
      // stub were never consulted at all.
      assert.ok(
        pool.queries.length > 0,
        `GET /api/${resource} did not reach a controller that queries the database`
      );

      const hitGeneric = pool.queries.some((q) => GENERIC_HANDLER_SQL.test(q.sql));
      assert.equal(
        hitGeneric,
        false,
        `GET /api/${resource} reached the legacy generic handler — it must be removed or given policy filters`
      );
    }
  });
});

// ───────────────────────────── auth middleware ──────────────────────────────

test('a request with no token is rejected with 401', async () => {
  const app = loadApp(createPoolStub());

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/children`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.message, /authentication required/i);
  });
});

test('a malformed token is rejected with 401', async () => {
  const app = loadApp(createPoolStub());

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/children`, {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(res.status, 401);
  });
});

test('a token signed with the wrong secret is rejected with 401', async () => {
  const app = loadApp(createPoolStub());

  await withServer(app, async (base) => {
    const forged = jwt.sign({ id: 'U-TEST', username: 'tester', role: 'centerhead' }, 'the-wrong-secret-value', { expiresIn: '1h' });
    const res = await fetch(`${base}/api/children`, {
      headers: { Authorization: `Bearer ${forged}` },
    });
    assert.equal(res.status, 401, 'a token signed with a different secret must not be accepted');
  });
});

test('an unknown route reports the real HTTP method', async () => {
  const app = loadApp(createPoolStub());

  await withServer(app, async (base) => {
    const res = await authedFetch(base, '/api/definitely-not-a-route');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.message, 'Route GET /api/definitely-not-a-route not found');
  });
});

// ─────────────────── login throttle, end to end over HTTP ───────────────────

test('POST /api/users/login returns 429 after 10 failed attempts', async () => {
  const app = loadApp(createPoolStub());

  await withServer(app, async (base) => {
    const attempt = () => fetch(`${base}/api/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bruteforce.target', password: 'guess' }),
    });

    for (let i = 1; i <= 10; i += 1) {
      const res = await attempt();
      assert.equal(res.status, 401, `attempt ${i} should fail with 401, not ${res.status}`);
    }

    const blocked = await attempt();
    assert.equal(blocked.status, 429, 'the 11th attempt must be throttled');
    assert.ok(blocked.headers.get('retry-after'), 'a 429 must include Retry-After');
    assert.match((await blocked.json()).message, /too many login attempts/i);
  });
});

test('the login throttle is per username, so one account cannot lock out another', async () => {
  const app = loadApp(createPoolStub());

  await withServer(app, async (base) => {
    const attempt = (username) => fetch(`${base}/api/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'guess' }),
    });

    for (let i = 0; i < 11; i += 1) await attempt('noisy.account');
    assert.equal((await attempt('noisy.account')).status, 429, 'noisy.account is throttled');

    assert.equal(
      (await attempt('quiet.account')).status,
      401,
      'a different username from the same address must not be throttled'
    );
  });
});

// ─────────────── profile password change requires the current one ───────────

test('PUT /api/users/profile refuses a password change without the current password', async () => {
  const hash = await knownPasswordHash();
  const pool = createPoolStub({ passwordHash: hash });
  const app = loadApp(pool);

  await withServer(app, async (base) => {
    const res = await authedFetch(base, '/api/users/profile', {
      method: 'PUT',
      body: JSON.stringify({ password: 'a-brand-new-password' }),
    });

    assert.equal(res.status, 401, 'omitting currentPassword must not be accepted');
    assert.match((await res.json()).message, /current password is incorrect/i);
    // The controller must actually have consulted the stored hash. Without
    // this, the test would still pass if the endpoint rejected everything.
    assert.equal(
      pool.queries.some((q) => /^SELECT password FROM users WHERE id = \?/i.test(q.sql)),
      true,
      'the stored hash must be read before deciding'
    );
    assert.equal(
      pool.queries.some((q) => /^UPDATE users SET/i.test(q.sql)),
      false,
      'no password write may happen when verification fails'
    );
  });
});

test('PUT /api/users/profile refuses a wrong current password', async () => {
  const hash = await knownPasswordHash();
  const pool = createPoolStub({ passwordHash: hash });
  const app = loadApp(pool);

  await withServer(app, async (base) => {
    const res = await authedFetch(base, '/api/users/profile', {
      method: 'PUT',
      body: JSON.stringify({ password: 'a-brand-new-password', currentPassword: 'not-the-password' }),
    });

    assert.equal(res.status, 401);
    assert.equal(
      pool.queries.some((q) => /^UPDATE users SET/i.test(q.sql)),
      false,
      'a wrong current password must not reach the UPDATE'
    );
  });
});

test('PUT /api/users/profile accepts the change when the current password is correct', async () => {
  const hash = await knownPasswordHash();
  const pool = createPoolStub({ passwordHash: hash });
  const app = loadApp(pool);

  await withServer(app, async (base) => {
    const res = await authedFetch(base, '/api/users/profile', {
      method: 'PUT',
      body: JSON.stringify({ password: 'a-brand-new-password', currentPassword: KNOWN_PASSWORD }),
    });

    assert.equal(res.status, 200, 'a correct current password must be accepted');
    const update = pool.queries.find((q) => /^UPDATE users SET/i.test(q.sql));
    assert.ok(update, 'the password write should have been issued');
    // The stored value must be a bcrypt hash, never the plaintext.
    assert.match(String(update.params[0]), /^\$2[aby]\$/);
    assert.ok(!String(update.params[0]).includes('a-brand-new-password'));
  });
});
