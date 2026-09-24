/**
 * Liveness vs readiness.
 *
 * `/api/health` answers "is this process up?" and touches nothing, so Railway's
 * healthcheck cannot restart-loop the service over a database blip.
 * `/api/health/db` answers "is there a working database behind it?".
 *
 * Keeping those two separate is the point, and the failure mode of getting it
 * wrong is quiet: before this existed, a dead MySQL still reported the service
 * as healthy, and the only way to notice was to log in and read a screen. The
 * third test below is the one that matters most — it pins that `/health` stays
 * dependency-free, because folding a query into it is the obvious "simplification"
 * that would reintroduce the restart-loop hazard.
 *
 * Driven against a real Express server with the pool stubbed, so these assert the
 * actual status codes rather than that some text exists in a file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { pool } = require('../src/config/database');
const apiRoutes = require('../src/routes');

const REAL_QUERY = pool.query;

async function withServer(fn) {
  const app = express();
  app.use('/api', apiRoutes);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const { port } = server.address();
    await fn(async (path) => {
      // Bounded on purpose. This app has no error-handling middleware, so an
      // async throw inside a handler (Express 4 does not catch those) leaves the
      // request unanswered -- and an unbounded fetch would hang the whole test
      // run instead of failing it. The timeout turns that into a plain failure.
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(5000),
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, body };
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    pool.query = REAL_QUERY;
  }
}

test('readiness reports connected when the database answers', async () => {
  pool.query = async () => [[{ '1': 1 }], []];
  await withServer(async (get) => {
    const r = await get('/api/health/db');
    assert.equal(r.status, 200, 'a reachable database must report 200');
    assert.equal(r.body.database, 'connected');
    assert.equal(typeof r.body.latencyMs, 'number');
  });
});

test('readiness reports 503, and leaks nothing, when the database is gone', async () => {
  pool.query = async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:3306 for user admin'), { code: 'ECONNREFUSED' });
  };
  await withServer(async (get) => {
    const r = await get('/api/health/db');
    assert.equal(r.status, 503, 'an unreachable database must not report success');
    assert.equal(r.body.database, 'unreachable');
    assert.equal(r.body.success, false);

    // The endpoint is unauthenticated, so the driver's message -- which carries
    // the host, the port and the user -- must not reach the caller.
    const asText = JSON.stringify(r.body);
    assert.doesNotMatch(asText, /ECONNREFUSED/, 'must not echo the driver error');
    assert.doesNotMatch(asText, /10\.0\.0\.5/, 'must not disclose the database host');
    assert.doesNotMatch(asText, /3306/, 'must not disclose the database port');
  });
});

test('liveness stays independent of the database', async () => {
  // If this ever fails, /api/health has grown a query and Railway's healthcheck
  // will restart the container every time the database hiccups.
  pool.query = async () => {
    throw new Error('the database is unreachable and /health must not care');
  };
  await withServer(async (get) => {
    const r = await get('/api/health');
    assert.equal(r.status, 200, '/health is liveness: it must answer without the database');
    assert.equal(r.body.success, true);
    assert.equal(r.body.message, 'API is running');
    assert.equal(r.body.database, undefined, '/health must not report database state');
  });
});
