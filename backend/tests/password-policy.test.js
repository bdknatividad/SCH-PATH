/**
 * Password policy and account-edit validation.
 *
 * The Account Management module is the only place an account's username,
 * display name, password, role and module grants are changed, so a gap here is
 * a gap in the whole access-control story. These tests pin the rules that were
 * missing:
 *
 *   - a password is judged before it is hashed, at every entry point, by one
 *     shared rule instead of four ad-hoc ones;
 *   - an edit is validated in full before anything is written, so a request
 *     carrying one bad value cannot leave half an edit behind;
 *   - the role, the account status and the module grants are all checked
 *     against what the system can actually read back.
 *
 * The controller is driven directly against a small in-memory store, because
 * what matters is which UPDATE was issued — a stub that answers `[]` to
 * everything cannot tell "the edit was refused" from "the edit was never made".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bcrypt = require('bcrypt');

const DB_MODULE_PATH = require.resolve('../src/config/database');
const NOTIFY_MODULE_PATH = require.resolve('../src/services/notificationService');
const CONTROLLER_PATH = require.resolve('../src/controllers/userController');

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const BACKEND_POLICY = 'backend/src/config/passwordPolicy.json';
const FRONTEND_POLICY = 'frontend/src/app/config/passwordPolicy.json';
const policy = JSON.parse(read(BACKEND_POLICY));

// ── THE STORE ───────────────────────────────────────────────────────────────

const USER_COLUMNS = ['id', 'username', 'displayName', 'fullName', 'password', 'role', 'accessibleModules', 'childRecordTabs', 'subModules', 'status', 'createdDate'];

function createStore({ users = [], storedPassword = null } = {}) {
  const updates = [];
  const inserts = [];

  const store = {
    updates,
    inserts,
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      const args = Array.isArray(params) ? params : [];

      if (/^SELECT COLUMN_NAME FROM INFORMATION_SCHEMA\.COLUMNS/i.test(text)) {
        return [USER_COLUMNS.map((COLUMN_NAME) => ({ COLUMN_NAME })), []];
      }
      if (/^SELECT password FROM users WHERE id = \?/i.test(text)) {
        return [[{ password: storedPassword }], []];
      }
      if (/^SELECT id FROM users WHERE username = \? AND id != \?/i.test(text)) {
        return [users.filter((u) => u.username === args[0] && u.id !== args[1]).map((u) => ({ id: u.id })), []];
      }
      if (/^SELECT id FROM users WHERE username = \?/i.test(text)) {
        return [users.filter((u) => u.username === args[0]).map((u) => ({ id: u.id })), []];
      }
      if (/^SELECT id, role, username FROM users WHERE id = \?/i.test(text)) {
        return [users.filter((u) => u.id === args[0]).map((u) => ({ id: u.id, role: u.role, username: u.username })), []];
      }
      if (/^SELECT id, role FROM users WHERE id = \?/i.test(text)) {
        return [users.filter((u) => u.id === args[0]).map((u) => ({ id: u.id, role: u.role })), []];
      }
      if (/^SELECT id FROM users$/i.test(text)) {
        return [users.map((u) => ({ id: u.id })), []];
      }
      if (/^SELECT id, username, displayName, role/i.test(text)) {
        return [users.filter((u) => u.id === args[0]).map((u) => ({ ...u })), []];
      }
      if (/^INSERT INTO users/i.test(text)) {
        inserts.push({ sql: text, params: args });
        return [{ affectedRows: 1 }];
      }
      if (/^UPDATE users SET/i.test(text)) {
        updates.push({ sql: text, params: args });
        return [{ affectedRows: 1 }];
      }
      throw new Error(`UNHANDLED SQL: ${text}`);
    },
  };
  return store;
}

function loadController(store) {
  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH, filename: DB_MODULE_PATH, loaded: true,
    exports: { pool: store, dbConfig: {}, testConnection: async () => true },
  };
  require.cache[NOTIFY_MODULE_PATH] = {
    id: NOTIFY_MODULE_PATH, filename: NOTIFY_MODULE_PATH, loaded: true,
    exports: { notify: async () => ({}), notifyUsers: async () => ([]) },
  };
  delete require.cache[CONTROLLER_PATH];
  return require(CONTROLLER_PATH);
}

/** Run a controller handler and capture what it answered. */
async function run(handler, { body = {}, params = {}, user = { id: 'U001', username: 'centerhead', role: 'centerhead' } } = {}) {
  const captured = { status: 200, payload: null, error: null };
  const res = {
    status(code) { captured.status = code; return this; },
    json(payload) { captured.payload = payload; return this; },
  };
  await handler({ body, params, user }, res, (error) => { captured.error = error; });
  if (captured.error) {
    captured.status = captured.error.statusCode ?? captured.error.status ?? 500;
    captured.payload = { message: captured.error.message };
  }
  return captured;
}

const messageOf = (captured) => String(captured.payload?.message || '');

// ── ONE POLICY, TWO COPIES ──────────────────────────────────────────────────

test('the backend and the frontend read the same password policy', () => {
  assert.equal(
    read(BACKEND_POLICY),
    read(FRONTEND_POLICY),
    'passwordPolicy.json has drifted between the backend and the frontend — the form would accept a '
    + 'password the API then rejects'
  );
  assert.ok(policy.minLength >= 8, 'the minimum length must be at least 8');
  // bcrypt silently ignores everything past 72 bytes, so accepting more would
  // let two different long passwords authenticate each other.
  assert.equal(policy.maxLengthBytes, 72);
});

test('the frontend enforces the policy through the same shared rule', () => {
  const source = read('frontend/src/app/components/AccountManagement.tsx');
  assert.match(source, /from '@\/utils\/passwordPolicy'/, 'Account Management must use the shared policy');
  assert.match(source, /passwordProblem\(/, 'the add and edit dialogs must judge the password before saving');

  // The numbers themselves must come from the mirrored file, not be retyped.
  const helper = read('frontend/src/utils/passwordPolicy.ts');
  assert.match(helper, /@\/app\/config\/passwordPolicy\.json/, 'the helper must read the mirrored policy file');
  assert.match(helper, /policy\.minLength/, 'the minimum length must not be hardcoded');
  assert.match(helper, /policy\.maxLengthBytes/, 'the byte ceiling must not be hardcoded');
});

test('the policy is applied by every password-writing endpoint', () => {
  const source = read('backend/src/controllers/userController.js');
  const callSites = (source.match(/assertPassword\(/g) || []).length;
  assert.ok(
    callSites >= 4,
    `assertPassword() is called ${callSites} time(s) in userController.js — register, the account edit, `
    + 'change-password and the profile update must all judge the password the same way'
  );
});

test('the frontend never persists a password to browser storage', () => {
  // `saveUsers` mirrors the account list into localStorage. A password could
  // only ever arrive there as the plaintext a Center Head just typed into the
  // reset field — the API returns no hash — so the field is dropped on the way
  // out rather than left readable.
  const source = read('frontend/src/app/components/AccountManagement.tsx');
  const body = source.slice(source.indexOf('function saveUsers'), source.indexOf('// ── COMPONENT'));
  assert.match(body, /delete copy\.password/, 'saveUsers must strip the password before writing');
  assert.ok(
    !/localStorage\.setItem\(STORAGE_KEY, JSON\.stringify\(users\)\)/.test(body),
    'saveUsers is writing the account list verbatim again, password and all'
  );
});

test('the edit dialog adopts the grants the server stored, not its own guess', () => {
  const source = read('frontend/src/app/components/AccountManagement.tsx');
  assert.match(
    source,
    /const accessResponse = await request<\{ success: boolean; data: User \}>/,
    'the access call must read the stored account back'
  );
  assert.match(source, /const reconciled = persisted/, 'the stored account must replace the local guess');
  assert.match(source, /setUsers\(reconciled\)/, 'the list must be updated from the stored account');
});

// ── THE RULES ───────────────────────────────────────────────────────────────

test('a password shorter than the minimum is refused', async () => {
  const store = createStore({ users: [] });
  const { register } = loadController(store);
  const captured = await run(register, { body: { username: 'new.staff', role: 'nurse', password: 'short' } });

  assert.equal(captured.status, 400);
  assert.match(messageOf(captured), /at least 8 characters/i);
  assert.equal(store.inserts.length, 0, 'a refused password must not reach the INSERT');
});

test('a password of only spaces is refused', async () => {
  const store = createStore({ users: [] });
  const { register } = loadController(store);
  const captured = await run(register, { body: { username: 'new.staff', role: 'nurse', password: '          ' } });

  assert.equal(captured.status, 400);
  assert.equal(store.inserts.length, 0);
});

test('a password equal to the username is refused', async () => {
  const store = createStore({ users: [] });
  const { register } = loadController(store);
  const captured = await run(register, { body: { username: 'new.staff', role: 'nurse', password: 'new.staff' } });

  assert.equal(captured.status, 400);
  assert.match(messageOf(captured), /same as the username/i);
  assert.equal(store.inserts.length, 0);
});

test('a password longer than bcrypt can read is refused rather than silently truncated', async () => {
  const store = createStore({ users: [] });
  const { register } = loadController(store);
  const captured = await run(register, {
    body: { username: 'new.staff', role: 'nurse', password: 'a'.repeat(policy.maxLengthBytes + 1) },
  });

  assert.equal(captured.status, 400);
  assert.match(messageOf(captured), /at most 72 bytes/i);
  assert.equal(store.inserts.length, 0);
});

test('an acceptable password is hashed, never stored as written', async () => {
  const store = createStore({ users: [] });
  const { register } = loadController(store);
  const captured = await run(register, {
    body: { username: 'new.staff', role: 'nurse', password: 'a-good-password' },
  });

  assert.equal(captured.status, 201, messageOf(captured));
  const stored = store.inserts[0].params.find((value) => typeof value === 'string' && value.startsWith('$2'));
  assert.ok(stored, 'the INSERT must carry a bcrypt hash');
  assert.ok(!stored.includes('a-good-password'), 'the plaintext must never be stored');
  assert.equal(await bcrypt.compare('a-good-password', stored), true, 'and the hash must verify');
});

// ── THE ACCOUNT EDIT ────────────────────────────────────────────────────────

test('editing an account refuses a weak password before writing anything', async () => {
  const store = createStore({ users: [{ id: 'U002', username: 'nurse.one', role: 'nurse', status: 'Active' }] });
  const { updateById } = loadController(store);
  const captured = await run(updateById, {
    params: { id: 'U002' },
    body: { username: 'nurse.two', displayName: 'Nurse Two', password: 'weak', role: 'nurse' },
  });

  assert.equal(captured.status, 400);
  assert.match(messageOf(captured), /at least 8 characters/i);
  assert.equal(store.updates.length, 0, 'a rejected edit must not write a partial UPDATE');
});

test('editing an account refuses a role the system does not know', async () => {
  const store = createStore({ users: [{ id: 'U002', username: 'nurse.one', role: 'nurse', status: 'Active' }] });
  const { updateById } = loadController(store);
  const captured = await run(updateById, { params: { id: 'U002' }, body: { role: 'superuser' } });

  assert.equal(captured.status, 400);
  assert.match(messageOf(captured), /Unsupported user role/i);
  assert.equal(store.updates.length, 0);
});

test('editing an account refuses a status the users table cannot hold', async () => {
  const store = createStore({ users: [{ id: 'U002', username: 'nurse.one', role: 'nurse', status: 'Active' }] });
  const { updateById } = loadController(store);
  const captured = await run(updateById, { params: { id: 'U002' }, body: { status: 'Suspended' } });

  assert.equal(captured.status, 400);
  assert.match(messageOf(captured), /Unsupported account status/i);
  assert.equal(store.updates.length, 0, 'the ENUM must be checked here, not left to MySQL as a 500');
});

test('editing an account refuses a blank username', async () => {
  const store = createStore({ users: [{ id: 'U002', username: 'nurse.one', role: 'nurse', status: 'Active' }] });
  const { updateById } = loadController(store);
  const captured = await run(updateById, { params: { id: 'U002' }, body: { username: '   ' } });

  assert.equal(captured.status, 400);
  assert.equal(store.updates.length, 0);
});

test('editing an account refuses a username another account already holds', async () => {
  const store = createStore({
    users: [
      { id: 'U002', username: 'nurse.one', role: 'nurse', status: 'Active' },
      { id: 'U003', username: 'nurse.two', role: 'nurse', status: 'Active' },
    ],
  });
  const { updateById } = loadController(store);
  const captured = await run(updateById, { params: { id: 'U002' }, body: { username: 'nurse.two' } });

  assert.equal(captured.status, 409);
  assert.match(messageOf(captured), /already taken/i);
  assert.equal(store.updates.length, 0);
});

test('editing an account drops a module grant the system cannot read', async () => {
  const store = createStore({ users: [{ id: 'U002', username: 'nurse.one', role: 'nurse', status: 'Active' }] });
  const { updateById } = loadController(store);
  const captured = await run(updateById, {
    params: { id: 'U002' },
    body: { accessibleModules: ['Dashboard', 'Not A Real Module', 'Health'] },
  });

  assert.equal(captured.status, 200, messageOf(captured));
  const update = store.updates.find((q) => /accessibleModules/.test(q.sql));
  const written = JSON.parse(update.params[0]);
  assert.ok(!JSON.stringify(written).includes('Not A Real Module'),
    'an unknown module key must never be persisted as a grant');
  assert.ok(written.includes('Dashboard') && written.includes('Health'), 'the real grants must survive');
});

test('a full-access role cannot be stripped of its modules by a truncated request', async () => {
  const store = createStore({ users: [{ id: 'U001', username: 'centerhead', role: 'centerhead', status: 'Active' }] });
  const { updateById } = loadController(store);
  const captured = await run(updateById, {
    params: { id: 'U001' },
    body: { accessibleModules: ['Dashboard'] },
  });

  assert.equal(captured.status, 200, messageOf(captured));
  const update = store.updates.find((q) => /accessibleModules/.test(q.sql));
  const written = JSON.parse(update.params[0]);
  assert.ok(written.length > 5, `a Center Head must keep every module, got ${JSON.stringify(written)}`);
  assert.ok(written.includes('Account Management'), 'and must never lose Account Management');
});

test('the permission-only endpoint gives the same guarantee', async () => {
  // PUT /users/:id/access is what Account Management actually calls for a
  // module edit, so it needs the same protection as PUT /users/:id.
  const store = createStore({ users: [{ id: 'U001', username: 'centerhead', role: 'centerhead', status: 'Active' }] });
  const { updateAccess } = loadController(store);
  const captured = await run(updateAccess, {
    params: { id: 'U001' },
    body: { accessibleModules: ['Dashboard'] },
  });

  assert.equal(captured.status, 200, messageOf(captured));
  const update = store.updates.find((q) => /accessibleModules/.test(q.sql));
  const written = JSON.parse(update.params[0]);
  assert.ok(written.length > 5, `a Center Head must keep every module, got ${JSON.stringify(written)}`);
  assert.ok(written.includes('Account Management'), 'and must never lose Account Management');
});

test('a role change rewrites the grants, so access follows the role with no manual DB edit', async () => {
  const store = createStore({
    users: [{ id: 'U002', username: 'nurse.one', role: 'houseparent', status: 'Active' }],
  });
  const { updateById } = loadController(store);
  const captured = await run(updateById, { params: { id: 'U002' }, body: { role: 'nurse' } });

  assert.equal(captured.status, 200, messageOf(captured));
  const update = store.updates.find((q) => /role = \?/.test(q.sql));
  assert.ok(update, 'the role change must be written');

  // The module grant is the JSON array bound alongside it.
  const written = update.params
    .filter((value) => typeof value === 'string' && value.startsWith('['))
    .map((value) => JSON.parse(value))
    .find((list) => list.includes('Health'));
  assert.ok(written, 'the module grants must be rewritten for the new role');
  assert.ok(!written.includes('Houseparent'), 'and the old role\u2019s grants must not linger');
});

// ── THE SELF-SERVICE PATHS ──────────────────────────────────────────────────

test('change-password refuses a weak new password without writing', async () => {
  const hash = await bcrypt.hash('correct-horse-battery', 10);
  const store = createStore({ storedPassword: hash });
  const { changePassword } = loadController(store);
  const captured = await run(changePassword, {
    user: { id: 'U001', username: 'centerhead', role: 'centerhead' },
    body: { currentPassword: 'correct-horse-battery', newPassword: 'weak' },
  });

  assert.equal(captured.status, 400);
  assert.match(messageOf(captured), /at least 8 characters/i);
  assert.equal(store.updates.length, 0);
});

test('change-password still refuses a wrong current password', async () => {
  const hash = await bcrypt.hash('correct-horse-battery', 10);
  const store = createStore({ storedPassword: hash });
  const { changePassword } = loadController(store);
  const captured = await run(changePassword, {
    user: { id: 'U001', username: 'centerhead', role: 'centerhead' },
    body: { currentPassword: 'wrong-password', newPassword: 'a-good-password' },
  });

  assert.equal(captured.status, 401);
  assert.equal(store.updates.length, 0);
});

test('the profile update refuses a weak password even with the correct current one', async () => {
  const hash = await bcrypt.hash('correct-horse-battery', 10);
  const store = createStore({ storedPassword: hash });
  const { updateProfile } = loadController(store);
  const captured = await run(updateProfile, {
    user: { id: 'U001', username: 'centerhead', role: 'centerhead' },
    body: { password: 'weak', currentPassword: 'correct-horse-battery' },
  });

  assert.equal(captured.status, 400);
  assert.equal(store.updates.length, 0);
});
