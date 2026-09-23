/**
 * Session teardown and per-user data isolation.
 *
 * Two users sharing one workstation is the normal case in a care facility, so
 * "sign out" has to actually remove the previous user's data. The caches are
 * written to `localStorage` by three different modules under three different
 * naming conventions, and the logout handler's list is hand-maintained — which
 * is exactly how it drifted: it cleared `educationSchoolVisits` while
 * `Education.tsx` was writing `educationVisitReports`, so the Education caches
 * and the account roster survived logout and were readable by the next person
 * with no API call and no role check.
 *
 * These tests read the key literals out of the writers and compare them with
 * the logout list, so a rename on either side fails here rather than leaking in
 * production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND_SRC = path.join(__dirname, '..', '..', 'frontend', 'src');
const AUTH_CONTEXT = path.join(FRONTEND_SRC, 'app', 'state', 'AuthContext.tsx');
const DATA_CONTEXT = path.join(FRONTEND_SRC, 'app', 'state', 'DataContext.tsx');
const EDUCATION = path.join(FRONTEND_SRC, 'app', 'components', 'Education.tsx');
const ACCOUNT_MGMT = path.join(FRONTEND_SRC, 'app', 'components', 'AccountManagement.tsx');

function withoutComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const read = (file) => withoutComments(fs.readFileSync(file, 'utf8'));

const authCode = read(AUTH_CONTEXT);
const dataCode = read(DATA_CONTEXT);
const educationCode = read(EDUCATION);
const accountCode = read(ACCOUNT_MGMT);

/** The keys named in AuthContext's CACHED_DATA_KEYS array. */
function clearedKeys() {
  const start = authCode.indexOf('const CACHED_DATA_KEYS');
  assert.notEqual(start, -1, 'CACHED_DATA_KEYS must exist');
  const end = authCode.indexOf('];', start);
  const block = authCode.slice(start, end);
  return Array.from(block.matchAll(/'([^']+)'/g)).map((match) => match[1]);
}

/** `localStorage.setItem('key', ...)` literals, and `const X = 'key'` aliases. */
function writtenKeys(code) {
  const keys = new Set();

  for (const match of code.matchAll(/localStorage\.setItem\(\s*'([^']+)'/g)) {
    keys.add(match[1]);
  }

  // Keys held in a constant and written as `setItem(SOME_KEY, ...)`.
  const aliases = new Map();
  for (const match of code.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*'([^']+)'/g)) {
    aliases.set(match[1], match[2]);
  }
  for (const match of code.matchAll(/localStorage\.setItem\(\s*([A-Z_][A-Z0-9_]*)\s*,/g)) {
    if (aliases.has(match[1])) keys.add(aliases.get(match[1]));
  }

  // A writer that takes the key as a parameter (`persist('children', ...)`).
  for (const match of code.matchAll(/\bpersist\(\s*'([^']+)'/g)) {
    keys.add(match[1]);
  }

  return keys;
}

/** What each module actually persists. */
function residentDataKeys() {
  return new Set([
    ...writtenKeys(dataCode),
    ...writtenKeys(educationCode),
  ]);
}

test('DataContext declares the collections it persists', () => {
  const keys = writtenKeys(dataCode);
  for (const expected of ['children', 'staff', 'alerts', 'courtRecords', 'violations']) {
    assert.ok(keys.has(expected), `DataContext should persist "${expected}" (found: ${[...keys].join(', ')})`);
  }
});

test('Education keys are read from the module that writes them', () => {
  const keys = writtenKeys(educationCode);

  // These are the two that the logout list got wrong.
  assert.ok(
    keys.has('educationVisitReports'),
    `Education.tsx must write "educationVisitReports" (found: ${[...keys].join(', ')})`,
  );
  assert.ok(
    keys.has('educationProgressReports'),
    `Education.tsx must write "educationProgressReports" (found: ${[...keys].join(', ')})`,
  );
});

test('every key a component persists is cleared on logout', () => {
  const cleared = new Set(clearedKeys());
  const written = residentDataKeys();

  const leaked = [...written].filter((key) => !cleared.has(key));

  assert.deepEqual(
    leaked,
    [],
    `these caches hold resident data but survive logout, so the next person on the machine can read them: ${leaked.join(', ')}. Add them to CACHED_DATA_KEYS in AuthContext.tsx.`,
  );
});

test('the account roster is cleared on logout', () => {
  const written = writtenKeys(accountCode);
  if (written.size === 0) return; // no local account cache in this build

  const cleared = new Set(clearedKeys());
  for (const key of written) {
    assert.ok(
      cleared.has(key),
      `"${key}" caches account data but is not cleared on logout — it would expose usernames and roles to the next user`,
    );
  }
});

test('the logout list names no key that nothing writes', () => {
  // A stale entry is worse than useless: it suggests the cache is handled when
  // the real key is still leaking, which is how the Education drift went
  // unnoticed.
  //
  // `educationMonthlyReports` is exempt: `Education.tsx` declares `MONTHLY_KEY`
  // for it but never writes it in this build. It is kept in the logout list
  // deliberately — a key that is reserved today may be written tomorrow, and
  // clearing a key nobody writes costs nothing. Exempting it here rather than
  // deleting it from the list keeps the intent explicit.
  const RESERVED_BUT_UNWRITTEN = new Set(['educationMonthlyReports']);

  const written = new Set([...residentDataKeys(), ...writtenKeys(accountCode)]);
  const cleared = clearedKeys();
  const stale = cleared.filter((key) => !written.has(key) && !RESERVED_BUT_UNWRITTEN.has(key));

  assert.deepEqual(
    stale,
    [],
    `CACHED_DATA_KEYS names key(s) no component writes — the real key is probably spelled differently: ${stale.join(', ')}`,
  );
});

test('the reserved-but-unwritten exemption is still justified', () => {
  // If Education starts writing the key, the exemption should be removed so the
  // key is covered by the "every written key is cleared" assertion above.
  assert.match(
    educationCode,
    /MONTHLY_KEY\s*=\s*'educationMonthlyReports'/,
    'the exemption for educationMonthlyReports is stale — remove it from RESERVED_BUT_UNWRITTEN',
  );
  assert.doesNotMatch(
    educationCode,
    /setItem\(\s*MONTHLY_KEY/,
    'Education now writes educationMonthlyReports, so remove the exemption — the key must be verified as cleared',
  );
});

test('the token is removed on logout and on a rejected token', () => {
  const logoutStart = authCode.indexOf('const logout = ()');
  assert.notEqual(logoutStart, -1, 'logout() must exist');

  const logoutBody = authCode.slice(logoutStart, authCode.indexOf('\n  };', logoutStart));
  assert.match(logoutBody, /localStorage\.removeItem\('token'\)/, 'logout must drop the token');
  assert.match(logoutBody, /localStorage\.removeItem\('user'\)/, 'logout must drop the cached user');
  assert.match(logoutBody, /clearCachedData\(\)/, 'logout must drop the cached data');

  // The 401 handler is a separate code path; it must do the same teardown.
  const unauthorizedStart = authCode.indexOf('const handleUnauthorized = ()');
  assert.notEqual(unauthorizedStart, -1, 'the unauthorized handler must exist');
  const unauthorizedBody = authCode.slice(unauthorizedStart, unauthorizedStart + 700);

  assert.match(unauthorizedBody, /removeItem\('token'\)/, 'an expired token must drop the token');
  assert.match(unauthorizedBody, /clearCachedData\(\)/, 'an expired token must drop the cached data');
});

test('the cached user record is not trusted for the access matrix', () => {
  // A restored session takes `accessibleModules` from localStorage. That copy
  // is only a rendering hint — every request is re-authorised server-side — but
  // the provider must at least canonicalise it so a stale legacy value cannot
  // render a menu the server would refuse.
  const restoreStart = authCode.indexOf('const checkAuth = ()');
  assert.notEqual(restoreStart, -1, 'checkAuth must exist');
  const restoreBody = authCode.slice(restoreStart, restoreStart + 700);

  assert.match(
    restoreBody,
    /canonicalizeModules\(/,
    'the restored module list must be canonicalised rather than used verbatim',
  );
});

test('no data cache is written under a key the logout list cannot know about', () => {
  // Dynamic keys (`` `doc-${id}` ``) cannot be enumerated by a fixed list, so a
  // component that builds one would silently bypass the teardown. None should
  // exist.
  const dynamic = [];
  for (const [name, code] of [['DataContext', dataCode], ['Education', educationCode], ['AccountManagement', accountCode]]) {
    for (const match of code.matchAll(/localStorage\.setItem\(\s*`[^`]*\$\{/g)) {
      dynamic.push(`${name}: ${match[0]}`);
    }
  }

  assert.deepEqual(
    dynamic,
    [],
    `a computed localStorage key cannot be cleared by a fixed list: ${dynamic.join(' | ')}`,
  );
});
