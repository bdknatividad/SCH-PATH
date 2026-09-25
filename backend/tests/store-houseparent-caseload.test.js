/**
 * `/store` must apply the Houseparent caseload boundary — the same one
 * `GET /children` applies — rather than a stricter one that hides everything.
 *
 * The bulk store resolves a row's resident ids through `rowResidentIds()` in
 * routes/index.js. That helper read `row.residentId` and then scanned a small
 * set of JSON columns, but a `children` row IS the resident: it is keyed by
 * `id` and has no `residentId`. So the helper returned `[]` for every resident,
 * the Houseparent filter matched nothing, and `/store` answered
 * `children: []` for a Houseparent who held four assigned residents.
 *
 * Nothing errored and no screen broke — `DataContext` re-reads
 * `/resident-assignments/my-residents` for Houseparents and overwrote the
 * empty list — which is exactly why this needs a test rather than a smoke
 * check. The failure mode is a silently wrong list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const TEST_SECRET = 'store-caseload-test-secret-value-long-enough';
process.env.JWT_SECRET = TEST_SECRET;

const DB_MODULE_PATH = require.resolve('../src/config/database');
const ROUTES_MODULE_PATH = require.resolve('../src/routes');
const SRC_ROOT = path.resolve(__dirname, '..', 'src');

/** Drop every cached module under src/ so the router rebinds to the next stub. */
function purgeSrcModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_ROOT) && !key.includes('node_modules')) {
      delete require.cache[key];
    }
  }
}

/**
 * A pool stub that answers only what this contract needs.
 *
 * `assignedIds` is what the Houseparent is actually assigned to, and
 * `childrenRows` is the whole resident table — the store has to narrow the
 * second to the first.
 */
function createPoolStub({ role, userId, assignedIds, childrenRows }) {
  const seen = [];

  async function query(sql, params) {
    const text = String(sql);
    seen.push({ sql: text, params });

    // authenticate() account lookup.
    if (/FROM users WHERE id = \?/i.test(text)) {
      return [[{ id: userId, username: 'hp-tester', role, status: 'Active' }]];
    }
    // assignedResidentIds() — the explicit assignment table.
    if (/FROM residentAssignments ra/i.test(text)) {
      return [assignedIds.map((residentId) => ({ residentId }))];
    }
    // assignedResidentIds() — the legacy admissions compatibility query.
    if (/FROM admissions a\s+JOIN users u ON u\.id = \?/i.test(text)) {
      return [[]];
    }
    // The bulk store's per-table read.
    const tableMatch = text.match(/^SELECT \* FROM `(\w+)`/);
    if (tableMatch) {
      if (tableMatch[1] === 'children') return [childrenRows];
      return [[]];
    }
    return [[]];
  }

  return {
    seen,
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
}

function loadApp(poolStub) {
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

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const originalError = console.error;
  console.error = () => {};
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
  }
}

function tokenFor(role) {
  return jwt.sign({ id: 'U-HP', username: 'hp-tester', role }, TEST_SECRET, { expiresIn: '1h' });
}

const CHILDREN = [
  { id: 'CH001', name: 'Assigned Resident', status: 'Active' },
  { id: 'CH002', name: 'Someone Else', status: 'Active' },
];

async function getStore(base, role) {
  const response = await fetch(`${base}/api/store`, {
    headers: { Authorization: `Bearer ${tokenFor(role)}` },
  });
  const body = await response.json();
  return { status: response.status, body };
}

test('a Houseparent gets their assigned residents from /store, not an empty list', async () => {
  const pool = createPoolStub({
    role: 'houseparent',
    userId: 'U-HP',
    assignedIds: ['CH001'],
    childrenRows: CHILDREN,
  });
  const app = loadApp(pool);

  await withServer(app, async (base) => {
    const { status, body } = await getStore(base, 'houseparent');

    assert.equal(status, 200, 'the store should answer 200 for a Houseparent');
    const children = body?.data?.children;
    assert.ok(Array.isArray(children), 'the store payload must carry a children array');

    // The regression: this came back as [] for every Houseparent.
    assert.deepEqual(
      children.map((child) => child.id),
      ['CH001'],
      'a Houseparent must receive exactly their assigned residents',
    );
  });
});

test('the Houseparent boundary still withholds an unassigned resident', async () => {
  const pool = createPoolStub({
    role: 'houseparent',
    userId: 'U-HP',
    assignedIds: ['CH001'],
    childrenRows: CHILDREN,
  });
  const app = loadApp(pool);

  await withServer(app, async (base) => {
    const { body } = await getStore(base, 'houseparent');
    const ids = (body?.data?.children || []).map((child) => child.id);
    assert.ok(!ids.includes('CH002'), 'an unassigned resident must not appear in the store payload');
  });
});

test('a Houseparent with no assignments still gets nothing', async () => {
  const pool = createPoolStub({
    role: 'houseparent',
    userId: 'U-HP',
    assignedIds: [],
    childrenRows: CHILDREN,
  });
  const app = loadApp(pool);

  await withServer(app, async (base) => {
    const { body } = await getStore(base, 'houseparent');
    assert.deepEqual(body?.data?.children, [], 'an unassigned Houseparent must see no residents');
  });
});

test('a Center Head is not caseload-scoped', async () => {
  const pool = createPoolStub({
    role: 'centerhead',
    userId: 'U-CH',
    assignedIds: [],
    childrenRows: CHILDREN,
  });
  const app = loadApp(pool);

  await withServer(app, async (base) => {
    const { body } = await getStore(base, 'centerhead');
    assert.deepEqual(
      (body?.data?.children || []).map((child) => child.id),
      ['CH001', 'CH002'],
      'a role with no caseload concept must receive every resident',
    );
  });
});
