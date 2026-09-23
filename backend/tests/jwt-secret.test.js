/**
 * JWT secret handling.
 *
 * `auth.js` fell back to a hardcoded constant when `JWT_SECRET` was unset. That
 * value is in the repository, and a token signed with it is valid for any
 * account — including the Center Head. `railway.toml` does not declare
 * `JWT_SECRET`, so it exists only in the hosting dashboard, which means a fresh
 * deployment from this repository would boot on the built-in secret with
 * nothing in the logs to say so.
 *
 * These tests spawn a real child process per case rather than mutating
 * `process.env` in-process, because the behaviour under test is *what happens
 * at load time*. A module-level `throw` cannot be observed from a module that
 * has already been required.
 *
 * Verified separately against the deployed API: tokens signed with the fallback
 * value, with an empty secret, and with a whitespace secret are all rejected
 * (401), so the live secret is a real one and the guard does not fire there.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const AUTH = path.join(__dirname, '..', 'src', 'middleware', 'auth.js');

/**
 * Load auth.js in a child process with the given environment.
 *
 * The child runs from a directory with no `.env` in it. `auth.js` requires
 * `config/database`, which calls `dotenv.config()`; a local `backend/.env`
 * carrying a `JWT_SECRET` would otherwise satisfy the production guard and the
 * "refuses to start" case would pass for the wrong reason. Production has no
 * `.env` — the image copies only `backend/src`, and the file is gitignored — so
 * a bare directory is the faithful simulation.
 *
 * stderr is captured on success as well as failure, because the short-secret
 * warning is written there by a load that succeeds.
 *
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
function loadWith(env) {
  const script = `require(${JSON.stringify(AUTH)}); console.log('LOADED');`;
  const base = { ...process.env };
  // Remove any inherited value so each case is decided by `env` alone.
  delete base.JWT_SECRET;
  delete base.NODE_ENV;

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-secret-test-'));

  try {
    // spawnSync, not execFileSync: the short-secret warning is written to stderr
    // by a load that *succeeds*, so stderr has to be readable either way.
    const result = spawnSync(process.execPath, ['-e', script], {
      env: { ...base, ...env },
      cwd,
      encoding: 'utf8',
    });

    return {
      ok: result.status === 0,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('production without JWT_SECRET refuses to start', () => {
  const result = loadWith({ NODE_ENV: 'production' });

  assert.equal(result.ok, false, 'auth.js must not load in production without JWT_SECRET');
  assert.match(result.stderr, /JWT_SECRET is not set/);
  // The message has to say what to do, or the operator is left guessing.
  assert.match(result.stderr, /Set JWT_SECRET/);
  // And it must say why, because "insecure default" is not self-evident.
  assert.match(result.stderr, /forgeable/);
});

test('an empty or whitespace JWT_SECRET is treated as unset in production', () => {
  for (const value of ['', '   ', '\t']) {
    const result = loadWith({ NODE_ENV: 'production', JWT_SECRET: value });
    assert.equal(result.ok, false, `JWT_SECRET=${JSON.stringify(value)} must not satisfy the guard`);
    assert.match(result.stderr, /JWT_SECRET is not set/);
  }
});

test('production with a real JWT_SECRET loads', () => {
  const result = loadWith({
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(48),
  });

  assert.equal(result.ok, true, `should have loaded, stderr: ${result.stderr}`);
  assert.match(result.stdout, /LOADED/);
});

test('development keeps working without JWT_SECRET', () => {
  // A developer must be able to clone and run without ceremony; that is the
  // only reason the fallback exists.
  const result = loadWith({ NODE_ENV: 'development' });

  assert.equal(result.ok, true, `should have loaded, stderr: ${result.stderr}`);
  assert.match(result.stdout, /LOADED/);
});

test('a short JWT_SECRET warns but still loads', () => {
  // Short secrets are brute-forceable offline. Warn loudly, but do not refuse
  // to boot over it — that is an existing deployment's decision to make.
  const result = loadWith({ NODE_ENV: 'production', JWT_SECRET: 'tooshort' });

  assert.equal(result.ok, true, 'a short secret must not block startup');
  assert.match(result.stderr, /only 8 characters/);
  assert.match(result.stderr, /at least 32/);
});

test('the fallback value is never reachable in production', () => {
  // The whole point: whatever the fallback string is, production must not be
  // able to run on it.
  const source = require('node:fs').readFileSync(AUTH, 'utf8');

  assert.match(source, /NODE_ENV === 'production'/, 'the production guard must exist');
  assert.match(
    source,
    /throw new Error\(\s*'JWT_SECRET is not set/,
    'production must throw rather than fall through to the default',
  );
});

test('token verification pins the accepted algorithm', () => {
  // Without `algorithms`, the accepted set is a property of the library's
  // defaults rather than a decision made here. Signing is HS256.
  const source = require('node:fs').readFileSync(AUTH, 'utf8');
  const verifyCalls = source.match(/jwt\.verify\(/g) || [];

  assert.ok(verifyCalls.length >= 2, 'both authenticate and optionalAuth verify tokens');
  assert.equal(
    (source.match(/algorithms: JWT_ALGORITHMS/g) || []).length,
    verifyCalls.length,
    'every jwt.verify call must pin algorithms',
  );
  assert.match(source, /const JWT_ALGORITHMS = \['HS256'\]/);
});
