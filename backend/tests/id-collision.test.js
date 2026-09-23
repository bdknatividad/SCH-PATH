/**
 * Primary-key collision handling for the generic create path.
 *
 * generateId() derives the next id from the current maximum, so two concurrent
 * creates can compute the same id. The loser's INSERT fails with ER_DUP_ENTRY,
 * which surfaces to the user as "sometimes the record won't save".
 *
 * baseController.create() now re-reads and retries. These tests pin that
 * behaviour, and also pin the INSERT parameter order, because the fix moved the
 * id out of the pre-built values array and into the per-attempt INSERT.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const DB_MODULE_PATH = require.resolve('../src/config/database');
const BASE_CONTROLLER_PATH = require.resolve('../src/controllers/baseController');

/** Inject a stub pool, then load a fresh controller bound to it. */
function loadController(poolStub, resource = 'reports') {
  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH,
    filename: DB_MODULE_PATH,
    loaded: true,
    exports: { pool: poolStub, dbConfig: {}, testConnection: async () => true },
  };
  // baseController captured the previous stub at import time, so drop it.
  delete require.cache[BASE_CONTROLLER_PATH];

  const { createController } = require(BASE_CONTROLLER_PATH);
  return createController(resource);
}

function fakeRequest(body = {}) {
  return {
    body,
    params: {},
    user: { id: 'U1', username: 'tester', role: 'centerhead' },
  };
}

function fakeResponse() {
  const captured = { statusCode: null, payload: null };
  return {
    captured,
    res: {
      status(code) { captured.statusCode = code; return this; },
      json(payload) { captured.payload = payload; return this; },
    },
  };
}

const DUP_ENTRY = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });

/**
 * A pool stub whose INSERT behaviour is scripted.
 *
 * @param {Object} options
 * @param {string[][]} options.idLists - successive results of `SELECT id FROM ...`
 * @param {Error[]} options.insertErrors - error to throw per INSERT attempt (null = succeed)
 */
function createPoolStub({ idLists, insertErrors }) {
  const inserts = [];
  let idReadCount = 0;

  async function query(sql, params) {
    const text = String(sql);

    if (/^SELECT id FROM/i.test(text)) {
      const list = idLists[Math.min(idReadCount, idLists.length - 1)] || [];
      idReadCount += 1;
      return [list.map((id) => ({ id }))];
    }

    if (/^INSERT INTO/i.test(text)) {
      const attempt = inserts.length;
      inserts.push({ sql: text, params });
      const failure = insertErrors[attempt];
      if (failure) throw failure;
      return [{ affectedRows: 1 }];
    }

    // The post-insert read-back.
    if (/^SELECT \* FROM/i.test(text)) {
      return [[{ id: params[0], title: 'Monthly Report', type: 'Monthly' }]];
    }

    return [[]];
  }

  return {
    inserts,
    get idReadCount() { return idReadCount; },
    query,
  };
}

const REPORT_BODY = { title: 'Monthly Report', type: 'Monthly', date: '2026-09-16' };

test('create retries with a fresh id when the INSERT hits a duplicate key', async () => {
  const pool = createPoolStub({
    // First read only sees REP001, so the controller computes REP002 — which a
    // concurrent request has already committed. The second read sees it and
    // therefore computes REP003.
    idLists: [['REP001'], ['REP001', 'REP002']],
    insertErrors: [DUP_ENTRY, null],
  });

  const controller = loadController(pool);
  const { captured, res } = fakeResponse();
  let passedToNext = null;

  await controller.create(fakeRequest(REPORT_BODY), res, (err) => { passedToNext = err; });

  assert.equal(passedToNext, null, 'the retry should have succeeded, not called next(error)');
  assert.equal(captured.statusCode, 201);
  assert.equal(pool.inserts.length, 2, 'exactly one retry was needed');

  // The first attempt used the colliding id; the retry must use the next one.
  assert.equal(pool.inserts[0].params[0], 'REP002');
  assert.equal(pool.inserts[1].params[0], 'REP003');
  assert.equal(captured.payload.data.id, 'REP003');
});

test('create gives up after a bounded number of attempts and surfaces the error', async () => {
  const pool = createPoolStub({
    idLists: [['REP001']], // the maximum never advances
    insertErrors: [DUP_ENTRY, DUP_ENTRY, DUP_ENTRY, DUP_ENTRY, DUP_ENTRY, DUP_ENTRY],
  });

  const controller = loadController(pool);
  const { captured, res } = fakeResponse();
  let passedToNext = null;

  await controller.create(fakeRequest(REPORT_BODY), res, (err) => { passedToNext = err; });

  assert.equal(passedToNext, DUP_ENTRY, 'the duplicate-key error must not be swallowed');
  assert.equal(captured.statusCode, null, 'no success response may be sent');
  assert.equal(pool.inserts.length, 5, 'attempts must be bounded');
  assert.equal(pool.inserts.length, pool.idReadCount, 'each attempt re-reads the ids');
});

test('create does not retry a non-duplicate error', async () => {
  const badField = Object.assign(new Error('Unknown column'), { code: 'ER_BAD_FIELD_ERROR' });
  const pool = createPoolStub({
    idLists: [['REP001']],
    insertErrors: [badField, null],
  });

  const controller = loadController(pool);
  const { captured, res } = fakeResponse();
  let passedToNext = null;

  await controller.create(fakeRequest(REPORT_BODY), res, (err) => { passedToNext = err; });

  assert.equal(passedToNext, badField, 'a schema error must propagate immediately');
  assert.equal(pool.inserts.length, 1, 'a schema error must not be retried');
  assert.equal(captured.statusCode, null);
});

test('the INSERT still receives the id followed by the body values in column order', async () => {
  const pool = createPoolStub({ idLists: [['REP001']], insertErrors: [null] });

  const controller = loadController(pool);
  const { captured, res } = fakeResponse();

  await controller.create(fakeRequest(REPORT_BODY), res, () => {});

  const { sql, params } = pool.inserts[0];
  const columnList = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());

  assert.equal(columnList[0], 'id');
  assert.equal(params[0], 'REP002', 'the generated id is the first bound parameter');
  assert.equal(params[1], 'Monthly Report', 'body values follow the id');
  assert.equal(
    params.length,
    columnList.length,
    `parameter count (${params.length}) must match the column list (${columnList.length})`
  );
  assert.equal(captured.statusCode, 201);
});

// ───────────────── the shared helper's own contract ─────────────────

const { insertWithGeneratedId } = require('../src/utils/helpers');

test('insertWithGeneratedId passes the generated id to the insert callback and returns it', async () => {
  const reads = [];
  const inserted = [];
  const executor = {
    async query(sql) {
      reads.push(sql);
      return [[{ id: 'DOC007' }]];
    },
  };

  const id = await insertWithGeneratedId(executor, {
    table: 'documents',
    prefix: 'DOC',
    insert: async (generatedId) => { inserted.push(generatedId); },
  });

  assert.equal(id, 'DOC008', 'the id follows the highest existing number');
  assert.deepEqual(inserted, ['DOC008'], 'the callback receives exactly the returned id');
  assert.equal(reads.length, 1);
});

test('insertWithGeneratedId surfaces a non-duplicate error without retrying', async () => {
  const boom = Object.assign(new Error('Unknown column'), { code: 'ER_BAD_FIELD_ERROR' });
  let inserts = 0;
  const executor = { async query() { return [[{ id: 'DOC001' }]]; } };

  await assert.rejects(
    () => insertWithGeneratedId(executor, {
      table: 'documents', prefix: 'DOC',
      insert: async () => { inserts += 1; throw boom; },
    }),
    (error) => error === boom
  );
  assert.equal(inserts, 1);
});

test('insertWithGeneratedId stops after the configured number of attempts', async () => {
  const dup = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
  let inserts = 0;
  let reads = 0;
  const executor = {
    async query() { reads += 1; return [[{ id: 'DOC001' }]]; },
  };

  await assert.rejects(
    () => insertWithGeneratedId(executor, {
      table: 'documents', prefix: 'DOC', attempts: 3,
      insert: async () => { inserts += 1; throw dup; },
    }),
    (error) => error === dup
  );
  assert.equal(inserts, 3, 'attempts must be bounded by the caller-supplied limit');
  assert.equal(reads, 3, 'each attempt re-reads the ids');
});

test('insertWithGeneratedId retries a duplicate and succeeds with the next id', async () => {
  let reads = 0;
  const inserted = [];
  const executor = {
    async query() {
      reads += 1;
      // Second read sees the row the concurrent request committed.
      return reads === 1 ? [[{ id: 'DOC007' }]] : [[{ id: 'DOC007' }, { id: 'DOC008' }]];
    },
  };

  const dup = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
  const id = await insertWithGeneratedId(executor, {
    table: 'documents', prefix: 'DOC',
    insert: async (generatedId) => {
      inserted.push(generatedId);
      if (inserted.length === 1) throw dup;
    },
  });

  assert.equal(id, 'DOC009');
  assert.deepEqual(inserted, ['DOC008', 'DOC009'], 'the retry must use a fresh id');
});

// ───────────────── userController.register, a converted call site ─────────────────

const USER_CONTROLLER_PATH = require.resolve('../src/controllers/userController');

function loadUserController(poolStub) {
  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH,
    filename: DB_MODULE_PATH,
    loaded: true,
    exports: { pool: poolStub, dbConfig: {}, testConnection: async () => true },
  };
  delete require.cache[USER_CONTROLLER_PATH];
  return require(USER_CONTROLLER_PATH);
}

/**
 * Stub for the register() flow: the username-exists probe, the id read, the
 * INSERT, and the read-back.
 *
 * @param {Object} options
 * @param {string[][]} options.idLists - successive results of `SELECT id FROM users`
 * @param {Error[]} options.insertErrors - error per INSERT attempt (null = succeed)
 */
function createRegisterPoolStub({ idLists, insertErrors = [] }) {
  const inserts = [];
  let idReads = 0;

  async function query(sql, params) {
    const text = String(sql);
    if (/^SELECT id FROM users WHERE username = \?/i.test(text)) return [[]];
    if (/^SELECT id FROM users$/i.test(text)) {
      const list = idLists[Math.min(idReads, idLists.length - 1)] || [];
      idReads += 1;
      return [list.map((id) => ({ id }))];
    }
    if (/^INSERT INTO users/i.test(text)) {
      const attempt = inserts.length;
      inserts.push({ sql: text, params });
      const failure = insertErrors[attempt];
      if (failure) throw failure;
      return [{ affectedRows: 1 }];
    }
    if (/^SELECT id, username/i.test(text)) {
      return [[{ id: params[0], username: 'new.staff', role: 'centerhead', status: 'Active' }]];
    }
    return [[]];
  }

  return { inserts, query };
}

function runRegister(controller, pool, body) {
  const captured = { statusCode: null, payload: null };
  const res = {
    status(code) { captured.statusCode = code; return this; },
    json(payload) { captured.payload = payload; return this; },
  };
  const req = {
    body,
    params: {},
    user: { id: 'U-ADMIN', username: 'admin.user', role: 'centerhead' },
  };
  return controller.register(req, res, () => {}).then(() => captured);
}

test('register retries with a fresh id when the INSERT hits a duplicate key', async () => {
  const dup = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
  const pool = createRegisterPoolStub({
    idLists: [['U001'], ['U001', 'U002']],
    insertErrors: [dup, null],
  });

  const controller = loadUserController(pool);
  const captured = await runRegister(controller, pool, {
    username: 'new.staff', role: 'centerhead', accessibleModules: ['Dashboard'],
  });

  assert.equal(captured.statusCode, 201);
  assert.equal(pool.inserts.length, 2, 'one retry was needed');
  assert.equal(pool.inserts[0].params[0], 'U002', 'first attempt used the colliding id');
  assert.equal(pool.inserts[1].params[0], 'U003', 'the retry must take the next id');
  assert.equal(captured.payload.data.id, 'U003');
});

test('register still falls back when childRecordTabs does not exist', async () => {
  const missingColumn = Object.assign(
    new Error("Unknown column 'childRecordTabs' in 'field list'"),
    { code: 'ER_BAD_FIELD_ERROR' }
  );
  const pool = createRegisterPoolStub({
    idLists: [['U001']],
    insertErrors: [missingColumn, null],
  });

  const controller = loadUserController(pool);
  const captured = await runRegister(controller, pool, {
    username: 'new.staff', role: 'centerhead', accessibleModules: ['Dashboard'],
  });

  assert.equal(captured.statusCode, 201, 'the fallback must keep registration working');
  assert.equal(pool.inserts.length, 2);
  assert.match(pool.inserts[0].sql, /childRecordTabs/, 'the first attempt includes the column');
  assert.doesNotMatch(
    pool.inserts[1].sql,
    /childRecordTabs/,
    'the fallback must omit the missing column'
  );
});

test('register binds exactly as many values as the INSERT has placeholders', async () => {
  const pool = createRegisterPoolStub({ idLists: [['U001']] });

  const controller = loadUserController(pool);
  await runRegister(controller, pool, {
    username: 'new.staff', role: 'centerhead', accessibleModules: ['Dashboard', 'TRI'],
  });

  const { sql, params } = pool.inserts[0];
  const placeholders = (sql.match(/\?/g) || []).length;
  assert.equal(
    params.length,
    placeholders,
    `bound ${params.length} values for ${placeholders} placeholders — the id must be bound first, then the body`
  );
  assert.equal(params[0], 'U002', 'the generated id is the first bound value');
  assert.equal(params[1], 'new.staff');
});
