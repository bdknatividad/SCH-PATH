/**
 * Security response headers.
 *
 * The API shipped none of these. Measured against the deployed service before
 * this existed, every response was missing X-Content-Type-Options,
 * X-Frame-Options, Strict-Transport-Security, Content-Security-Policy,
 * Referrer-Policy and Permissions-Policy, and every response advertised
 * `X-Powered-By: Express`.
 *
 * The frontend sets its own equivalents in `frontend/vercel.json`; these cover
 * the API, which Vercel never sees.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { securityHeaders } = require('../src/middleware/securityHeaders');

/** Minimal Express response double that records what was set. */
function fakeRes({ secure = false } = {}) {
  const headers = {};
  return {
    req: { secure },
    headers,
    setHeader(name, value) {
      headers[name.toLowerCase()] = String(value);
    },
  };
}

function apply(options) {
  const res = fakeRes(options);
  let nexted = false;
  securityHeaders({ secure: options?.secure ?? false }, res, () => { nexted = true; });
  return { headers: res.headers, nexted };
}

test('nosniff is always set, so a JSON body cannot be sniffed into HTML', () => {
  const { headers } = apply();
  assert.equal(headers['x-content-type-options'], 'nosniff');
});

test('the API refuses to be framed', () => {
  const { headers } = apply();
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('referrer and permissions policies are set', () => {
  const { headers } = apply();
  assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.match(headers['permissions-policy'], /camera=\(\)/);
  assert.match(headers['permissions-policy'], /microphone=\(\)/);
  assert.match(headers['permissions-policy'], /geolocation=\(\)/);
});

test('HSTS is asserted over TLS and withheld otherwise', () => {
  // Sending HSTS on a plain http:// dev server pins localhost to https in the
  // developer's browser and breaks the next run, so it is conditional.
  const secure = apply({ secure: true }).headers;
  assert.match(secure['strict-transport-security'], /max-age=\d+/);
  assert.match(secure['strict-transport-security'], /includeSubDomains/);

  const plain = apply({ secure: false }).headers;
  assert.equal(plain['strict-transport-security'], undefined);
});

test('the middleware always continues the chain', () => {
  assert.equal(apply().nexted, true);
  assert.equal(apply({ secure: true }).nexted, true);
});

test('no Content-Security-Policy default-src is set on API responses', () => {
  // The API returns JSON and loads nothing. A default-src here would be a
  // second, weaker policy competing with the one Vercel sets on the pages.
  const { headers } = apply();
  assert.doesNotMatch(headers['content-security-policy'], /default-src/);
});

test('server.js mounts the headers, and disables the framework banner', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  assert.match(source, /app\.use\(securityHeaders\)/, 'server.js must mount securityHeaders');
  assert.match(source, /app\.disable\('x-powered-by'\)/, 'server.js must disable x-powered-by');

  // The headers must be registered before the routes, or a route could send a
  // response that never passes through them.
  assert.ok(
    source.indexOf('app.use(securityHeaders)') < source.indexOf("app.use('/api'"),
    'securityHeaders must be mounted before the API routes',
  );
});

test('the middleware does not depend on helmet', () => {
  // The project ships without it deliberately; the four headers that matter for
  // a JSON API are a dozen lines. If a dependency creeps in, this test is the
  // reminder that the trade was made on purpose.
  const pkg = require('../package.json');
  assert.equal(pkg.dependencies.helmet, undefined, 'helmet should not be a dependency');
});
