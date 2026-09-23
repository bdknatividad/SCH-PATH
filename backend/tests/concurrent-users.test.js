/**
 * Multi-user correctness.
 *
 * Everything here pins a defect that only appears when two people use the
 * system at the same time — the single-user happy path passed for all of them.
 *
 * Three independent hazards are covered:
 *
 * 1. **Client-minted record ids.** The frontend used to compute the next
 *    sequential id from the list it had on screen and post it as the record's
 *    id. Two browsers holding the same list compute the same value, so the
 *    optimistic row could never be reconciled with the row the server actually
 *    created.
 * 2. **Out-of-order refreshes.** `/store` is re-read on mount, on window focus
 *    and after most actions. Overlapping calls could land out of order and
 *    write older rows over newer ones.
 * 3. **Lost updates.** Two callers editing one record was a silent
 *    last-write-wins, and partial payloads clobbered fields they never
 *    mentioned.
 *
 * These are source-text assertions: the defects are in control flow between an
 * await and a state write, which a unit test with stubs would not reproduce.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND_SRC = path.join(__dirname, '..', '..', 'frontend', 'src');
const DATA_CONTEXT = path.join(FRONTEND_SRC, 'app', 'state', 'DataContext.tsx');
const ACCOUNT_MANAGEMENT = path.join(FRONTEND_SRC, 'app', 'components', 'AccountManagement.tsx');
const BASE_CONTROLLER = path.join(__dirname, '..', 'src', 'controllers', 'baseController.js');
const USER_CONTROLLER = path.join(__dirname, '..', 'src', 'controllers', 'userController.js');

const dataContextSource = fs.readFileSync(DATA_CONTEXT, 'utf8');
const baseControllerSource = fs.readFileSync(BASE_CONTROLLER, 'utf8');
const userControllerSource = fs.readFileSync(USER_CONTROLLER, 'utf8');

/** Strip comments so prose about a hazard is never mistaken for the hazard. */
function withoutComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const dataContextCode = withoutComments(dataContextSource);
const baseControllerCode = withoutComments(baseControllerSource);
const accountManagementCode = withoutComments(fs.readFileSync(ACCOUNT_MANAGEMENT, 'utf8'));
const userControllerCode = withoutComments(userControllerSource);

/**
 * Extract a function body by brace balancing.
 *
 * A fixed character window is not safe here: `loadStore` is ~90 lines, and a
 * window that is too short silently truncates the `finally` block, so the
 * assertion that reads it matches the wrong text. Balance the braces instead.
 *
 * Both shapes put a `{` before the body, so "the first `{`" is wrong:
 *   function f({ attempts = 3 } = {}) { ... }   // destructured default
 *   const f = useCallback(async () => { ... })  // arrow inside a call
 *
 * The body opener is the first `{` immediately preceded by `)` or `=>`. Brace
 * *depth* is not a usable test: for the `useCallback(...)` form the body sits at
 * depth 1, because `useCallback(`'s own paren is still open.
 */
function braceBody(source, fromIndex) {
  let bodyOpen = -1;

  for (let i = fromIndex; i < source.length; i += 1) {
    if (source[i] !== '{') continue;
    // `\s` covers the CRLF line ending the sources come with on Windows.
    const before = source.slice(Math.max(fromIndex, i - 6), i);
    if (/\)\s*$|=>\s*$/.test(before)) { bodyOpen = i; break; }
  }

  if (bodyOpen === -1) return '';

  let depth = 0;
  for (let i = bodyOpen; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyOpen, i + 1);
    }
  }
  return source.slice(bodyOpen);
}

/** The body of `const <name> = useCallback(...)` in DataContext. */
function loadStoreBody() {
  const start = dataContextCode.indexOf('const loadStore = useCallback');
  assert.notEqual(start, -1, 'loadStore must exist');
  return braceBody(dataContextCode, start);
}

/** Every `.ts`/`.tsx` file under a directory, recursively. */
function walk(dir, extensions, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, extensions, found);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) found.push(full);
  }
  return found;
}

// ───────────────────────── 1. no client-minted record ids ─────────────────────────

test('no source file mints a sequential record id for the server to use', () => {
  // The exact shape of the removed helper: read the ids on screen, take the
  // highest, add one, pad to three digits.
  const sequentialId = /padStart\(\s*3\s*,\s*['"]0['"]\s*\)/;
  const offenders = [];

  for (const file of walk(FRONTEND_SRC, ['.ts', '.tsx'])) {
    const code = withoutComments(fs.readFileSync(file, 'utf8'));
    if (sequentialId.test(code)) {
      offenders.push(path.relative(FRONTEND_SRC, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `a client must not derive a record id from the ids it can see — two browsers compute the same value. Rebuild a unique key instead (see provisionalKey in DataContext). Offenders: ${offenders.join(', ')}`
  );
});

test('DataContext no longer defines or calls generateId', () => {
  assert.doesNotMatch(
    dataContextCode,
    /\bgenerateId\b/,
    'generateId() computed the next id from the visible list, which collides across two concurrent clients'
  );
});

test('provisionalKey produces keys that cannot collide across two clients', () => {
  // The key must not be a function of the visible list. Re-derive it from the
  // source so the test fails if the implementation drifts back to counting.
  const start = dataContextCode.indexOf('const provisionalKey');
  assert.notEqual(start, -1, 'provisionalKey() must exist');

  const bodyStart = dataContextCode.indexOf('{', start);
  let depth = 0;
  let end = bodyStart;
  for (let i = bodyStart; i < dataContextCode.length; i += 1) {
    if (dataContextCode[i] === '{') depth += 1;
    else if (dataContextCode[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = dataContextCode.slice(bodyStart, end + 1);

  // Reimplement it: Date.now() + a random suffix namespaces each client.
  const factory = new Function('prefix', body.replace(/^\{/, '').replace(/\}$/, ''));
  const a = factory('DOC');
  const b = factory('DOC');

  assert.notEqual(a, b, 'two calls in the same millisecond must still differ');
  assert.match(a, /^tmp-DOC-/, 'the key must be namespaced so it is never mistaken for a record id');
});

test('a provisional key is never sent as the record id', () => {
  // addDocument is the one caller that builds an optimistic row, so it is the
  // one place the provisional key could leak into the payload.
  const start = dataContextCode.indexOf('const addDocument');
  assert.notEqual(start, -1, 'addDocument must exist');
  const body = dataContextCode.slice(start, start + 1600);

  assert.match(
    body,
    /const\s*\{\s*id:\s*\w+,\s*\.\.\.\w+\s*\}\s*=\s*\w+/,
    'addDocument must destructure the id out of the payload before posting'
  );
  assert.match(body, /createResource<\w+>\('documents',\s*payload\)/,
    'addDocument must post the payload without the provisional id');
});

test('every create call site posts a payload with no id field', () => {
  const creates = dataContextCode.match(/createResource<[^>]+>\([^;]*\)/g) || [];
  assert.ok(creates.length >= 8, `expected the create call sites, found ${creates.length}`);

  for (const call of creates) {
    assert.doesNotMatch(
      call,
      /,\s*\{\s*\.\.\.\w+,\s*id:/,
      `a create call still injects an id into the body: ${call.slice(0, 120)}`
    );
  }
});

test('Account Management does not derive a new user id from the clock', () => {
  // `U` + the last four clock digits is the same defect in a second component:
  // two admins submitting in the same millisecond produce one id, and the id
  // can never equal the one userController.register() allocates.
  const start = accountManagementCode.indexOf('const handleAddUser');
  assert.notEqual(start, -1, 'handleAddUser must exist');
  const body = accountManagementCode.slice(start, start + 2200);

  assert.doesNotMatch(
    body,
    /id:\s*[`'"]U\$\{/,
    'the new-user payload must not carry a client-minted id — the server allocates it'
  );
  assert.doesNotMatch(
    body,
    /Date\.now\(\)[\s\S]{0,40}\bid\b/,
    'the new-user id must not be derived from Date.now()'
  );
});

test('the new-user payload the frontend posts has no id field', () => {
  const start = accountManagementCode.indexOf('const payload = {');
  assert.notEqual(start, -1, 'the new-user payload must be built as a named object');
  const body = accountManagementCode.slice(start, start + 900);

  assert.doesNotMatch(
    body,
    /^\s*id:/m,
    'the payload must omit id so insertWithGeneratedId() allocates it'
  );
  assert.match(
    body,
    /username:/,
    'the payload must still carry the fields the API reads'
  );
});

test('the created user is reconciled against the id the server returned', () => {
  // The response body is the row the server actually wrote, so the local list
  // must be rebuilt from `saved` — not from the object that was posted. If the
  // component ever appends the payload instead, the row it stores carries no
  // usable id and the next reload swaps it out.
  const start = accountManagementCode.indexOf('const handleAddUser');
  const body = accountManagementCode.slice(start, start + 2200);

  assert.match(
    body,
    /const\s+saved\s*=\s*await\s+createResource<User>\('users'/,
    'handleAddUser must capture the server response'
  );
  assert.match(
    body,
    /\[\.\.\.users,\s*saved\]/,
    'the local list must be rebuilt from the id the server allocated'
  );
  assert.doesNotMatch(
    body,
    /setUsers\(prev\s*=>/,
    'no optimistic row may be inserted for user creation — it would have no server id'
  );
});

test('userController.register allocates the id itself and retries on a collision', () => {
  const start = userControllerCode.indexOf('async function register');
  assert.notEqual(start, -1, 'register() must exist');
  const body = userControllerCode.slice(start, start + 4200);

  assert.match(body, /insertWithGeneratedId\(pool,\s*\{/,
    'the id must be allocated via insertWithGeneratedId()');
  assert.doesNotMatch(body, /req\.body[\s\S]{0,60}\bid\b[\s\S]{0,60}INSERT/,
    'register() must never insert an id taken from the request body');
  assert.match(body, /prefix:\s*'U'/,
    "user ids must keep the U prefix the rest of the system expects");
});

// ───────────────────────── 2. out-of-order refresh guard ─────────────────────────

test('loadStore discards a response that a newer load superseded', () => {
  const body = loadStoreBody();

  assert.match(
    body,
    /const\s+generation\s*=\s*\(?\s*loadGeneration\.current\s*\+=\s*1/,
    'loadStore must claim a new generation on entry'
  );
  assert.match(
    body,
    /if\s*\(\s*generation\s*!==\s*loadGeneration\.current\s*\)\s*return/,
    'loadStore must bail out when a newer load has started, before writing state'
  );
});

test('the Houseparent branch re-checks the generation before writing state', () => {
  // That branch awaits a second request, so the check that follows getStore()
  // is not sufficient — the generation can advance during the second await.
  const body = loadStoreBody();
  const checks = body.match(/generation\s*!==\s*loadGeneration\.current/g) || [];

  assert.ok(
    checks.length >= 3,
    `expected the generation to be re-checked after each await (found ${checks.length} checks; must cover the assignments, the error path and the finally block)`
  );
});

test('only the newest load clears the loading flag', () => {
  const body = loadStoreBody();
  assert.notEqual(body.indexOf('} finally {'), -1, 'loadStore must have a finally block');
  const finallyBlock = body.slice(body.indexOf('} finally {'));

  assert.match(
    finallyBlock,
    /if\s*\(\s*generation\s*===\s*loadGeneration\.current\s*\)/,
    'a superseded load must not clear isLoading while a newer load is still running'
  );
});

test('refreshAlerts has the same guard as loadStore', () => {
  const start = dataContextCode.indexOf('const refreshAlerts = useCallback');
  assert.notEqual(start, -1, 'refreshAlerts must exist');
  const body = dataContextCode.slice(start, start + 1200);

  assert.match(body, /alertLoadGeneration\.current\s*\+=/, 'refreshAlerts must claim a generation');
  assert.ok(
    (body.match(/generation\s*!==\s*alertLoadGeneration\.current/g) || []).length >= 2,
    'refreshAlerts must guard both the success and the error path — it runs on a poll and on focus'
  );
});

test('both generation counters are refs, not state', () => {
  // State would re-render the provider on every refresh and, worse, the guard
  // would read the value captured when the promise was created rather than the
  // current one.
  assert.match(dataContextCode, /const\s+loadGeneration\s*=\s*useRef\(0\)/);
  assert.match(dataContextCode, /const\s+alertLoadGeneration\s*=\s*useRef\(0\)/);
});

// ───────────────────────── 3. lost-update protection ─────────────────────────

test('baseController.update refuses a write when the stored row is newer', () => {
  const start = baseControllerCode.indexOf('async update(req, res, next)');
  assert.notEqual(start, -1, 'update() must exist');
  const body = baseControllerCode.slice(start, start + 2400);

  assert.match(body, /409/, 'a stale write must be refused with 409 Conflict');
  assert.match(
    body,
    /actual\s*>\s*expected/,
    'the conflict test must be "stored is newer than what the caller rendered"'
  );
});

test('the conflict check is opt-in so an existing client keeps working', () => {
  const start = baseControllerCode.indexOf('async update(req, res, next)');
  const body = baseControllerCode.slice(start, start + 2400);

  assert.match(
    body,
    /expectedUpdatedAt\s*!==\s*undefined\s*&&\s*expectedUpdatedAt\s*!==\s*null/,
    'a caller that sends no updatedAt must not be rejected'
  );
  assert.match(
    body,
    /Number\.isFinite\(expected\)\s*&&\s*Number\.isFinite\(actual\)/,
    'an unparseable timestamp must be ignored rather than rejecting the write'
  );
});

test('updatedAt can never be written from a request body', () => {
  // If a client could set updatedAt, it could also defeat the conflict check
  // for everyone else by writing a far-future value.
  const start = baseControllerCode.indexOf('async update(req, res, next)');
  const body = baseControllerCode.slice(start, start + 3000);

  assert.match(
    body,
    /col\s*!==\s*'updatedAt'/,
    'the update loop must skip updatedAt — MySQL maintains it via ON UPDATE CURRENT_TIMESTAMP'
  );
});

test('the frontend sends the updatedAt it rendered from', () => {
  const start = dataContextCode.indexOf('const withVersion');
  assert.notEqual(start, -1, 'withVersion() must exist');
  const body = dataContextCode.slice(start, start + 1400);

  assert.match(body, /updatedAt: rendered/, 'the rendered timestamp must be added to the payload');
  assert.match(
    body,
    /const\s*\{\s*updatedAt:\s*\w+,\s*\.\.\.\w+\s*\}\s*=\s*updates/,
    'a caller-supplied updatedAt must be dropped so it cannot defeat the check'
  );
});

test('every update call site passes through withVersion', () => {
  const calls = dataContextCode.match(/updateResource<[^>]+>\([^;]*\)/g) || [];
  assert.ok(calls.length >= 8, `expected the update call sites, found ${calls.length}`);

  const unguarded = calls.filter((call) => !/withVersion\(/.test(call));
  assert.deepEqual(
    unguarded,
    [],
    `these updates would still be a silent last-write-wins: ${unguarded.map((c) => c.slice(0, 100)).join(' | ')}`
  );
});

// ───────────────────────── 4. per-caller RBAC isolation ─────────────────────────

test('the access snapshot is rebuilt per request, never cached across callers', () => {
  const authSource = withoutComments(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'auth.js'), 'utf8'),
  );

  // A module-level cache keyed by user id would serve a stale matrix after a
  // role change, and a cache keyed by nothing would leak one caller's access
  // to another.
  assert.doesNotMatch(
    authSource,
    /^(?!.*\/\/).*(new Map\(\)|const cache|cachedSnapshot)/m,
    'auth.js must not memoise access snapshots outside the request'
  );
  assert.match(
    authSource,
    /req\.user\s*=\s*principalFrom\(user\)/,
    'each request must build its own principal from a fresh database read'
  );
});

test('authenticate re-reads the account so a role change takes effect immediately', () => {
  const authSource = withoutComments(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'auth.js'), 'utf8'),
  );

  assert.match(
    authSource,
    /async function authenticate[\s\S]*?loadAccountForAuth\(decoded\.id\)/,
    'the role and grants must come from the database, not the token payload — otherwise a revoked user keeps their old access until the token expires'
  );
  assert.match(
    authSource,
    /user\.status\s*!==\s*'Active'/,
    'a deactivated account must be refused on every request, not only at login'
  );
});

test('/store filters every module-gated resource against the caller snapshot', () => {
  const routesSource = withoutComments(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'index.js'), 'utf8'),
  );

  const start = routesSource.indexOf("router.get('/store'");
  assert.notEqual(start, -1, 'the /store route must exist');
  const body = routesSource.slice(start, start + 6000);

  assert.match(
    body,
    /hasModuleAccess\(snapshotFor\(req\),\s*owningModule\)/,
    'each resource must be gated by the *caller\'s* snapshot'
  );
  assert.match(
    body,
    /data\[resourceName\]\s*=\s*\[\]/,
    'a resource the caller cannot reach must be returned empty, not omitted'
  );
});

// ───────────────────────── 5. connection-pool ceiling ─────────────────────────

test('the pool size is tunable so it can be matched to the provider cap', () => {
  // A hard-coded limit is the ceiling on concurrent database access, and it
  // cannot be raised for a busier deployment or lowered for a stricter
  // provider plan without editing source.
  const databaseSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'config', 'database.js'),
    'utf8',
  );

  assert.match(
    databaseSource,
    /process\.env\.DB_POOL_LIMIT/,
    'the pool limit must be configurable — it has to sit below the provider connection cap',
  );
  assert.match(
    databaseSource,
    /connectionLimit:\s*POOL_LIMIT/,
    'connectionLimit must read the resolved value',
  );
});

test('a malformed DB_POOL_LIMIT falls back instead of breaking the pool', () => {
  const databaseSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'config', 'database.js'),
    'utf8',
  );

  // An empty string, a word, or a negative number must not reach mysql2 as a
  // connection limit — a NaN limit makes the pool unusable.
  assert.match(
    databaseSource,
    /Number\.isFinite\(parsedPoolLimit\)\s*&&\s*parsedPoolLimit\s*>\s*0/,
    'a non-finite or non-positive DB_POOL_LIMIT must be rejected in favour of the default',
  );
});

test('the pool limit is capped so a typo cannot exhaust the provider', () => {
  const databaseSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'config', 'database.js'),
    'utf8',
  );

  assert.match(
    databaseSource,
    /Math\.min\(Math\.floor\(parsedPoolLimit\),\s*200\)/,
    'an extra zero in the env var must not open an unbounded number of connections',
  );
});

test('every explicitly acquired connection is released', () => {
  // pool.getConnection() hands out one of the pool's slots. A path that
  // acquires without releasing leaks that slot permanently, so after enough
  // requests every user blocks in the queue.
  const controllersDir = path.join(__dirname, '..', 'src');
  const leaks = [];

  for (const file of walk(controllersDir, ['.js'])) {
    const code = withoutComments(fs.readFileSync(file, 'utf8'));
    const acquires = (code.match(/getConnection\(\)/g) || []).length;
    if (acquires === 0) continue;

    const releases = (code.match(/\.release\(\)/g) || []).length;
    if (releases < acquires) {
      leaks.push(`${path.relative(controllersDir, file)}: ${acquires} acquire(s), ${releases} release(s)`);
    }
  }

  assert.deepEqual(
    leaks,
    [],
    `a connection acquired without a release permanently consumes a pool slot: ${leaks.join(' | ')}`,
  );
});

test('the transaction retry releases the connection on every path', () => {
  const helpersSource = withoutComments(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'helpers.js'), 'utf8'),
  );

  const start = helpersSource.indexOf('async function runInTransactionWithIdRetry');
  assert.notEqual(start, -1, 'runInTransactionWithIdRetry must exist');
  const body = braceBody(helpersSource, start);

  assert.match(
    body,
    /\}\s*finally\s*\{\s*connection\.release\(\);/,
    'release() must sit in a finally block — the retry loop acquires a new connection per attempt, so an early throw would leak every previous one',
  );
});
