/**
 * `trust proxy` resolution, and the reason it is not cosmetic.
 *
 * Railway terminates TLS at its edge and forwards inward, so the socket peer is
 * always a Railway node. Without `trust proxy`, `req.ip` is a *different* edge
 * instance on almost every request.
 *
 * `createRateLimiter` keys its buckets on `req.ip|username`. An unstable
 * `req.ip` means the key never repeats, no bucket ever fills, and login
 * throttling silently stops working — while behaving perfectly on localhost,
 * where there is no proxy and `req.ip` is stable.
 *
 * Measured against the deployed API before this existed: fourteen consecutive
 * failed logins, fourteen 401s, no 429, and `X-RateLimit-Remaining` reset to 9
 * on every single attempt.
 *
 * The value must be a hop *count*. `true` trusts every hop, which lets a client
 * prepend `X-Forwarded-For: <anything>` and choose its own bucket key — a bypass
 * dressed up as a fix. So the tests below pin that `true` is only ever returned
 * when it was asked for explicitly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveTrustProxy, DEFAULT_HOPS } = require('../src/config/trustProxy');

test('an unset TRUST_PROXY falls back to the deployment hop count, never to false', () => {
  // Returning false here would silently restore the bug: no proxy is trusted,
  // req.ip goes back to being a Railway node, and login throttling dies again.
  assert.equal(resolveTrustProxy({}), DEFAULT_HOPS);
  assert.notEqual(resolveTrustProxy({}), false);
});

test('an empty or whitespace TRUST_PROXY is treated as unset', () => {
  assert.equal(resolveTrustProxy({ TRUST_PROXY: '' }), DEFAULT_HOPS);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: '   ' }), DEFAULT_HOPS);
});

test('an explicit hop count is honoured', () => {
  assert.equal(resolveTrustProxy({ TRUST_PROXY: '1' }), 1);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: '2' }), 2);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: '5' }), 5);
});

test('the boolean forms survive so a proxy-less deployment can opt out', () => {
  assert.equal(resolveTrustProxy({ TRUST_PROXY: 'false' }), false);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: '0' }), false);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: 'true' }), true);
});

test('a malformed TRUST_PROXY fails safe rather than open', () => {
  // Anything unparseable must not disable the setting — that would be failing
  // open, which is the exact failure mode being fixed. It must not become NaN
  // either, which Express would reject at boot.
  for (const bad of ['abc', '-1', '1.5', 'NaN', 'null', '2 hops']) {
    const resolved = resolveTrustProxy({ TRUST_PROXY: bad });
    assert.equal(resolved, DEFAULT_HOPS, `TRUST_PROXY="${bad}" should fall back`);
  }
});

test('true is only ever returned when it was asked for explicitly', () => {
  // `trust proxy: true` is a rate-limit bypass: a client can prepend its own
  // X-Forwarded-For and pick the bucket. Nothing except an explicit `true`
  // may produce it.
  const incidental = [
    {}, { TRUST_PROXY: '' }, { TRUST_PROXY: ' ' }, { TRUST_PROXY: 'yes' },
    { TRUST_PROXY: 'on' }, { TRUST_PROXY: '2' }, { TRUST_PROXY: '1' },
    { TRUST_PROXY: 'false' }, { TRUST_PROXY: 'abc' },
  ];
  for (const env of incidental) {
    assert.notEqual(resolveTrustProxy(env), true, `TRUST_PROXY=${JSON.stringify(env)} must not trust all hops`);
  }
});

test('server.js applies trust proxy before any route is mounted', () => {
  // Ordering is the whole point: if the setting landed after `app.use('/api')`
  // the first requests would already have been keyed on a proxy address.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  const trustAt = source.indexOf("app.set('trust proxy'");
  const routesAt = source.indexOf("app.use('/api'");

  assert.notEqual(trustAt, -1, 'server.js must set trust proxy');
  assert.notEqual(routesAt, -1, 'server.js must mount the API routes');
  assert.ok(trustAt < routesAt, 'trust proxy must be set before the API routes are mounted');
});

test('the rate limiter still keys on both the client and the username', () => {
  // The bucket key is what `trust proxy` exists to stabilise. If the IP were
  // dropped from it, the proxy setting would become irrelevant — and a single
  // attacker could lock a named account out for everyone.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'rateLimit.js'),
    'utf8',
  );

  assert.match(source, /req\.ip/, 'the limiter must key on req.ip');
  assert.match(source, /username/, 'the limiter must key on the submitted username');
});
