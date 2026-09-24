/**
 * Quarterly Progress Report — the whole workflow, end to end.
 *
 * The other QPR test file checks the capability logic and the PDF in isolation.
 * This one drives the actual HTTP endpoints through a complete reporting cycle,
 * because the interesting failures in this feature are not in any single
 * endpoint — they are in the hand-off between them:
 *
 *   - a Social Worker opens the period and gets a blank six-aspect report with
 *     the identifying block already filled from the resident's records;
 *   - the Social Worker writes all six aspects — there is no assignment, and no
 *     aspect is anybody else's to write;
 *   - a blank aspect blocks finalizing, and the capability says so before the
 *     button is offered;
 *   - the Social Worker signs and finalizes, which publishes a PDF into the
 *     resident's Documents;
 *   - and a finalized report refuses every subsequent write.
 *
 * The routes that belonged to the removed per-aspect workflow — assign, the
 * per-aspect submit and return, the whole-report submit and return — must now be
 * absent, which is asserted here rather than assumed: a stale route would let a
 * client drive a workflow the UI no longer offers and the PDF no longer shows.
 *
 * The database is a small in-memory store rather than a stub that returns empty
 * sets, because a stub that always answers `[]` cannot tell the difference
 * between "the workflow works" and "nothing ever happened".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const TEST_SECRET = 'quarterly-progress-report-workflow-secret-long-enough';
process.env.JWT_SECRET = TEST_SECRET;

const jwt = require('jsonwebtoken');

const SRC = path.resolve(__dirname, '..', 'src');
const DB_MODULE_PATH = require.resolve('../src/config/database');
const ROUTES_MODULE_PATH = require.resolve('../src/routes');
const NOTIFY_MODULE_PATH = require.resolve('../src/services/notificationService');

// ── THE PEOPLE ──────────────────────────────────────────────────────────────

const SW = { id: 'U-SW', username: 'sw.one', role: 'socialworker', displayName: 'Soc Worker', status: 'Active' };
const HP = { id: 'U-HP', username: 'hp.one', role: 'houseparent', displayName: 'House Parent', status: 'Active' };
const HP2 = { id: 'U-HP2', username: 'hp.two', role: 'houseparent', displayName: 'Other Parent', status: 'Active' };
const USERS = [SW, HP, HP2];

const tokenFor = (user) => jwt.sign(
  { id: user.id, username: user.username, role: user.role },
  TEST_SECRET,
  { expiresIn: '1h' }
);

// ── THE RECORDS THE PERIOD ALREADY HOLDS ────────────────────────────────────

const RESIDENT = 'CH001';
/** Q2 2024 — a canonical calendar quarter, which is what the API now requires. */
const PERIOD = { start: '2024-04-01', end: '2024-06-30' };

/** Form 11-A, exactly as Health.tsx stores it: twelve rows, untouched ones empty. */
function form11a() {
  const monthlyMeasurements = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, height: '', weight: '' }));
  monthlyMeasurements[5] = { month: 6, height: '150', weight: '42.75' };
  monthlyMeasurements[7] = { month: 8, height: '151', weight: '45.35' };
  return [{ id: 'HR1', residentId: RESIDENT, date: '2024-06-01', recordType: 'Height & Weight Monitoring', details: { monitoringYear: '2024', monthlyMeasurements } }];
}

function seed() {
  return {
    users: USERS.map((u) => ({ ...u })),
    children: [{
      id: RESIDENT, name: 'Juan Dela Cruz', status: 'Active', caseType: 'Neglected',
      birthDate: '2008-03-15', admissionDate: '2024-06-01', address: 'Brgy. San Jose',
      guardianName: 'Maria Dela Cruz', guardianContact: '09171234567', gender: 'Male',
      medicalRecords: [], behavioralLogs: [],
    }],
    admissions: [{
      id: 'AD1', residentId: RESIDENT, admissionDate: '2024-06-01', sex: 'Male', religion: 'Roman Catholic',
      address: 'Brgy. San Jose', age: 16, guardianName: 'Maria Dela Cruz', guardianContact: '09171234567',
      createdAt: '2024-06-01 08:00:00',
    }],
    education_records: [{ id: 'ED1', residentId: RESIDENT, educationLevel: 'Elementary', school: 'SCH ALS CLC', address: 'Calamba City', status: 'Active', createdAt: '2024-06-02 08:00:00' }],
    anecdotalReports: [{
      id: 'AR1', residentId: RESIDENT, reportDate: '2024-07-05',
      content: JSON.stringify({ physical: 'Keeps himself neat and clean', behavioral: 'Obeyed the house rules', productivity: '' }),
    }],
    activities: [
      { id: 'A1', title: 'Safety measures session', category: 'Livelihood', date: '2024-08-05', selectedResidentIds: JSON.stringify([RESIDENT]) },
      { id: 'A2', title: 'Founding Anniversary', category: 'Recreational', date: '2024-07-20', selectedResidentIds: JSON.stringify([RESIDENT]) },
      { id: 'A3', title: 'Not his activity', category: 'Livelihood', date: '2024-08-06', selectedResidentIds: JSON.stringify(['CH999']) },
    ],
    incidentReports: [{ id: 'IR1', residentId: RESIDENT, incidentDateTime: '2024-06-14 10:00:00', reportTypes: JSON.stringify(['Bullying']), summary: 'Bullying' }],
    healthRecords: form11a(),
    education_progress_reports: [],
    education_school_visits: [],
    intervention_tracker: [],
    quarterlyProgressReports: [],
    quarterlyProgressReportSections: [],
    documents: [],
  };
}

// ── THE STORE ───────────────────────────────────────────────────────────────

/**
 * Columns MySQL stores as JSON. mysql2 hands them back already parsed, so the
 * store must not keep the raw string.
 */
const JSON_COLUMNS = new Set(['identifyingInformation', 'content', 'details', 'reportTypes', 'selectedResidentIds', 'responses']);

/**
 * The columns the store's tables have, for the `INFORMATION_SCHEMA` probe the
 * controller runs before it alters a table.
 *
 * The list models a database created *after* the closing narrative was added, so
 * the probe finds the column and no `ALTER` is issued. That is the state these
 * workflow tests run in; the migration itself — a table that predates the column
 * — is covered directly in `quarterly-progress-report.test.js`, where a stub
 * pool can be told to answer either way.
 *
 * A table missing from this map answers with no columns, which the controller
 * reads as "the table does not exist" and skips the alteration.
 */
const SCHEMA_COLUMNS = {
  quarterlyprogressreports: [
    'id', 'residentId', 'periodStart', 'periodEnd', 'periodLabel',
    'identifyingInformation', 'narrative', 'status', 'preparedByName',
    'preparedBySignature', 'attestedByName', 'attestedBySignature',
    'notedByName', 'notedBySignature', 'createdBy', 'createdAt', 'updatedBy',
    'updatedAt', 'submittedBy', 'submittedAt', 'reviewedBy', 'reviewedAt',
    'finalizedBy', 'finalizedAt', 'reviewNotes',
  ],
};

/**
 * A tiny in-memory stand-in for MySQL, covering only the statements this feature
 * issues. Anything unrecognised throws with the SQL attached, so a new query in
 * the controller fails loudly here instead of silently returning `[]`.
 */
function makeStore(seedTables = seed()) {
  const tables = seedTables;
  const log = [];

  const rows = (table) => tables[table] || (tables[table] = []);
  const clone = (row) => (row ? { ...row } : row);
  const isNull = (v) => v === null || v === undefined;

  /**
   * Splits a `SET` clause on the commas that separate assignments.
   *
   * A plain `split(',')` is wrong: `COALESCE(?, signature)` contains a comma of
   * its own, so the naive split tore that assignment in half and every later
   * placeholder shifted onto the wrong column — the section's `status` was being
   * written from the signature parameter.
   */
  function splitAssignments(clause) {
    const parts = [];
    let current = '';
    let depth = 0;
    let quoted = false;
    for (const char of clause) {
      if (char === "'") quoted = !quoted;
      if (!quoted) {
        if (char === '(') depth += 1;
        if (char === ')') depth -= 1;
        if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
      }
      current += char;
    }
    if (current.trim()) parts.push(current);
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  /** Applies a `SET a = ?, b = ?` clause to a row. */
  function applySet(row, clause, values) {
    let index = 0;
    for (const pair of splitAssignments(clause)) {
      const equals = pair.indexOf('=');
      if (equals < 0) continue;
      const columnRaw = pair.slice(0, equals).trim();
      const valueRaw = pair.slice(equals + 1).trim();
      if (!columnRaw) continue;
      // `COALESCE(?, column)` still consumes a bound value — missing that
      // desynchronises every later placeholder. A null keeps the existing value.
      const coalesce = /^COALESCE\(\?,\s*\w+\)$/i.test(valueRaw);
      if (coalesce) {
        const incoming = values[index];
        index += 1;
        if (!isNull(incoming)) row[columnRaw] = incoming;
        continue;
      }
      if (/^(NOW\(\)|CURRENT_TIMESTAMP)$/i.test(valueRaw)) {
        row[columnRaw] = new Date().toISOString().slice(0, 19).replace('T', ' ');
      } else if (/^NULL$/i.test(valueRaw)) {
        row[columnRaw] = null;
      } else if (valueRaw === '?') {
        row[columnRaw] = values[index];
        index += 1;
      } else if (/^'([^']*)'$/.test(valueRaw)) {
        row[columnRaw] = valueRaw.slice(1, -1);
      }
    }
    return index;
  }

  /** Handles `INSERT INTO t (cols) VALUES (...)` and returns the inserted row. */
  function doInsert(sql, params) {
    const table = sql.match(/INSERT INTO (\w+)/i)[1];
    const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
    const valuesPart = sql.slice(sql.lastIndexOf('VALUES') + 6).trim();
    const tokens = [];
    let depth = 0;
    let current = '';
    for (const char of valuesPart) {
      if (char === '(') { depth += 1; if (depth === 1) continue; }
      if (char === ')') { depth -= 1; if (depth === 0) break; }
      if (char === ',' && depth === 1) { tokens.push(current.trim()); current = ''; continue; }
      current += char;
    }
    if (current.trim()) tokens.push(current.trim());

    const row = {};
    let index = 0;
    columns.forEach((column, i) => {
      const token = tokens[i];
      if (token === undefined) { row[column] = null; return; }
      if (token === '?') {
        const value = params[index];
        index += 1;
        // mysql2 parses a JSON column back into an object, so the store has to
        // as well — the controller reads `report.identifyingInformation.childName`,
        // and a raw JSON string there would read as undefined.
        row[column] = JSON_COLUMNS.has(column) && typeof value === 'string'
          ? (() => { try { return JSON.parse(value); } catch { return value; } })()
          : value;
      }
      else if (/^NOW\(\)$/i.test(token)) row[column] = new Date().toISOString().slice(0, 19).replace('T', ' ');
      else if (/^NULL$/i.test(token)) row[column] = null;
      else if (/^'([^']*)'$/.test(token)) row[column] = token.slice(1, -1);
      else if (/^-?\d+$/.test(token)) row[column] = Number(token);
      else row[column] = token;
    });
    rows(table).push(row);
    return row;
  }

  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    const args = Array.isArray(params) ? params : [];
    log.push({ sql: text, params: args });
    const unhandled = () => { throw new Error(`UNHANDLED SQL: ${text}`); };

    // -- schema / migrations
    if (/^CREATE TABLE IF NOT EXISTS/i.test(text)) return [{}, []];
    // The controller probes for the closing-narrative column before altering.
    // Answered from the declared schema rather than from the seeded rows: the
    // seeded tables start empty, and an empty table is not a missing one.
    if (/^SELECT COLUMN_NAME FROM INFORMATION_SCHEMA\.COLUMNS/i.test(text)) {
      const table = (text.match(/LOWER\(TABLE_NAME\) = '([^']+)'/i)?.[1] || '').toLowerCase();
      const columns = SCHEMA_COLUMNS[table] || [];
      return [columns.map((column) => ({ COLUMN_NAME: column })), []];
    }

    // -- auth
    if (/^SELECT id, username, role, status FROM users WHERE id = \?/i.test(text)) {
      return [rows('users').filter((u) => u.id === args[0]).map((u) => ({ ...u })), []];
    }
    if (/^SELECT id, username, role, displayName FROM users WHERE \(status IS NULL OR status = 'Active'\)/i.test(text)) {
      return [rows('users').filter((u) => !u.status || u.status === 'Active').map(clone), []];
    }
    if (/^SELECT id, username, role, displayName FROM users WHERE id = \? OR username = \?/i.test(text)) {
      return [rows('users').filter((u) => u.id === args[0] || u.username === args[1]).slice(0, 1).map(clone), []];
    }
    // The report's signature line is filled from the account's display name, so
    // the store has to be able to answer that one narrow lookup.
    if (/^SELECT displayName FROM users WHERE id = \?/i.test(text)) {
      const found = rows('users').find((u) => u.id === args[0]);
      return [found ? [{ displayName: found.displayName || null }] : [], []];
    }
    if (/^SELECT id FROM users WHERE LOWER\(role\) IN/i.test(text)) {
      const wanted = ['socialworker', 'social work', 'social_worker', 'centerhead', 'center head', 'admin'];
      return [rows('users').filter((u) => wanted.includes(String(u.role).toLowerCase())).map((u) => ({ id: u.id })), []];
    }

    // -- id allocation
    if (/^SELECT id FROM \w+$/i.test(text)) {
      const table = text.match(/^SELECT id FROM (\w+)$/i)[1];
      return [rows(table).map((r) => ({ id: r.id })), []];
    }

    // -- source records
    if (/^SELECT \* FROM children WHERE id = \?/i.test(text)) return [rows('children').filter((r) => r.id === args[0]).map(clone), []];
    if (/^SELECT (?:id, name|name) FROM children WHERE id = \?/i.test(text)) {
      const columns = text.slice('SELECT '.length, text.indexOf(' FROM')).split(',').map((c) => c.trim());
      return [rows('children').filter((r) => r.id === args[0]).map((r) => {
        const picked = {};
        for (const column of columns) picked[column] = r[column];
        return picked;
      }), []];
    }
    // The admission a newly filed document is linked to. Documents are filed
    // Resident -> Admission -> Category -> File, so every publish path resolves
    // this first; see src/services/admissionLink.js.
    if (/^SELECT id\s+FROM admissions\s+WHERE residentId = \?/i.test(text)) {
      const found = rows('admissions').filter((r) => r.residentId === args[0]);
      found.sort((a, b) =>
        Number(b.status === 'Active') - Number(a.status === 'Active') ||
        Number(b.admissionNumber) - Number(a.admissionNumber));
      return [found.slice(0, 1).map((r) => ({ id: r.id })), []];
    }
    if (/^SELECT \* FROM admissions WHERE residentId = \?/i.test(text)) {
      const found = rows('admissions').filter((r) => r.residentId === args[0]);
      found.sort((a, b) => String(b.admissionDate).localeCompare(String(a.admissionDate)));
      return [found.slice(0, 1).map(clone), []];
    }
    if (/^SELECT \* FROM education_records WHERE residentId = \?/i.test(text)) {
      const found = rows('education_records').filter((r) => r.residentId === args[0]);
      found.sort((a, b) => Number(b.status === 'Active') - Number(a.status === 'Active'));
      return [found.slice(0, 1).map(clone), []];
    }
    if (/^SELECT \* FROM anecdotalReports WHERE residentId = \?/i.test(text)) {
      return [rows('anecdotalReports').filter((r) => r.residentId === args[0] && r.reportDate >= args[1] && r.reportDate <= args[2]).map(clone), []];
    }
    if (/^SELECT \* FROM activities WHERE date BETWEEN/i.test(text)) {
      return [rows('activities').filter((r) => r.date >= args[0] && r.date <= args[1]).map(clone), []];
    }
    if (/^SELECT \* FROM incidentReports WHERE residentId = \?/i.test(text)) {
      return [rows('incidentReports').filter((r) => r.residentId === args[0]).map(clone), []];
    }
    if (/^SELECT \* FROM healthRecords WHERE residentId = \?/i.test(text)) {
      return [rows('healthRecords').filter((r) => r.residentId === args[0]).map(clone), []];
    }
    if (/^SELECT \* FROM education_progress_reports WHERE residentId = \?/i.test(text)) {
      return [rows('education_progress_reports').filter((r) => r.residentId === args[0]).map(clone), []];
    }
    if (/^SELECT \* FROM education_school_visits WHERE residentId = \?/i.test(text)) {
      return [rows('education_school_visits').filter((r) => r.residentId === args[0]).map(clone), []];
    }
    if (/^SELECT \* FROM intervention_tracker WHERE residentId = \?/i.test(text)) {
      return [rows('intervention_tracker').filter((r) => r.residentId === args[0]).map(clone), []];
    }

    // -- reports
    if (/^SELECT id FROM quarterlyProgressReports WHERE residentId = \? AND periodStart = \?/i.test(text)) {
      return [rows('quarterlyProgressReports').filter((r) => r.residentId === args[0] && r.periodStart === args[1]).map((r) => ({ id: r.id })), []];
    }
    if (/^SELECT \* FROM quarterlyProgressReports WHERE id = \?$/i.test(text)) {
      return [rows('quarterlyProgressReports').filter((r) => r.id === args[0]).map(clone), []];
    }
    if (/^SELECT \* FROM quarterlyProgressReports ORDER BY/i.test(text)) {
      return [rows('quarterlyProgressReports').slice().sort((a, b) => String(b.periodStart).localeCompare(String(a.periodStart))).map(clone), []];
    }
    if (/^SELECT r\.\* FROM quarterlyProgressReports r WHERE EXISTS/i.test(text)) {
      const mine = (id) => rows('quarterlyProgressReportSections').some(
        (s) => String(s.assignedTo) === String(id) || String(s.assignedTo || '').toLowerCase() === String(id).toLowerCase()
      );
      const owned = new Set();
      for (const section of rows('quarterlyProgressReportSections')) {
        const assignee = String(section.assignedTo || '');
        if (!assignee) continue;
        if (assignee === String(args[0]) || assignee.toLowerCase() === String(args[1])) owned.add(section.reportId);
      }
      void mine;
      return [rows('quarterlyProgressReports').filter((r) => owned.has(r.id)).map(clone), []];
    }

    // -- sections
    if (/^SELECT \* FROM quarterlyProgressReportSections WHERE reportId = \? ORDER BY/i.test(text)) {
      return [rows('quarterlyProgressReportSections').filter((s) => s.reportId === args[0]).sort((a, b) => a.sortOrder - b.sortOrder).map(clone), []];
    }
    if (/^SELECT \* FROM quarterlyProgressReportSections WHERE reportId IN \(/i.test(text)) {
      return [rows('quarterlyProgressReportSections').filter((s) => args.includes(s.reportId)).sort((a, b) => a.sortOrder - b.sortOrder).map(clone), []];
    }
    if (/^SELECT \* FROM quarterlyProgressReportSections WHERE id = \? AND reportId = \?/i.test(text)) {
      return [rows('quarterlyProgressReportSections').filter((s) => s.id === args[0] && s.reportId === args[1]).slice(0, 1).map(clone), []];
    }

    // -- documents
    if (/^SELECT id FROM documents WHERE quarterlyReportId = \?/i.test(text)) {
      return [rows('documents').filter((d) => d.quarterlyReportId === args[0]).map((d) => ({ id: d.id })), []];
    }
    if (/^DELETE FROM documents WHERE quarterlyReportId = \?/i.test(text)) {
      tables.documents = rows('documents').filter((d) => d.quarterlyReportId !== args[0]);
      return [{ affectedRows: 1 }, []];
    }
    if (/^DELETE FROM quarterlyProgressReports WHERE id = \?/i.test(text)) {
      tables.quarterlyProgressReports = rows('quarterlyProgressReports').filter((r) => r.id !== args[0]);
      tables.quarterlyProgressReportSections = rows('quarterlyProgressReportSections').filter((s) => s.reportId !== args[0]);
      return [{ affectedRows: 1 }, []];
    }

    // -- inserts
    if (/^INSERT INTO \w+/i.test(text)) {
      const row = doInsert(text, args);
      return [{ insertId: row.id, affectedRows: 1 }, []];
    }

    // -- updates
    if (/^UPDATE (\w+) SET ([\s\S]+) WHERE id = \?$/i.test(text)) {
      const match = text.match(/^UPDATE (\w+) SET ([\s\S]+) WHERE id = \?$/i);
      const table = match[1];
      const target = rows(table).find((r) => r.id === args[args.length - 1]);
      if (!target) return [{ affectedRows: 0 }, []];
      applySet(target, match[2], args.slice(0, -1));
      return [{ affectedRows: 1 }, []];
    }
    if (/^UPDATE documents SET/i.test(text)) {
      const target = rows('documents').find((d) => d.id === args[args.length - 1]);
      if (target) applySet(target, text.slice(text.indexOf('SET') + 3, text.lastIndexOf('WHERE')), args.slice(0, -1));
      return [{ affectedRows: target ? 1 : 0 }, []];
    }

    // -- notifications (only reached if the service stub is bypassed)
    if (/^INSERT INTO notifications/i.test(text)) return [{ insertId: 'N1', affectedRows: 1 }, []];

    return unhandled();
  }

  const connection = {
    query,
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };

  return {
    tables,
    log,
    query,
    async getConnection() { return connection; },
  };
}

// ── APP ─────────────────────────────────────────────────────────────────────

const notifications = [];

function purgeSrcModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC) && !key.includes('node_modules')) delete require.cache[key];
  }
}

function loadApp(store) {
  purgeSrcModules();
  notifications.length = 0;
  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH,
    filename: DB_MODULE_PATH,
    loaded: true,
    exports: { pool: store, dbConfig: {}, testConnection: async () => true },
  };
  // The notification service is recorded rather than stored: what matters here
  // is that the right person was told, not how the row is shaped.
  require.cache[NOTIFY_MODULE_PATH] = {
    id: NOTIFY_MODULE_PATH,
    filename: NOTIFY_MODULE_PATH,
    loaded: true,
    exports: {
      notify: async (payload) => { notifications.push(payload); return { id: `N${notifications.length}` }; },
      notifyUsers: async (ids, payload) => {
        for (const id of ids) notifications.push({ ...payload, targetUserId: id });
        return ids.map((id) => ({ id: `N${notifications.length}-${id}` }));
      },
    },
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

/** A client bound to one identity, so the workflow reads like the people doing it. */
function clientFor(base, user) {
  const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(user)}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, body: payload };
  };
  return {
    user,
    // Convenience so a test can say `hp.id` rather than `hp.user.id`.
    id: user.id,
    username: user.username,
    role: user.role,
    get: (url) => call('GET', url, undefined),
    post: (url, body = {}) => call('POST', url, body),
    put: (url, body = {}) => call('PUT', url, body),
    del: (url) => call('DELETE', url, undefined),
  };
}

const BASE = '/api/quarterly-progress-reports';

/** Opens the period as the Social Worker and returns the new report's id. */
async function openReport(sw) {
  const created = await sw.post(BASE, { residentId: RESIDENT, periodStart: PERIOD.start, periodEnd: PERIOD.end });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data.id;
}

/**
 * Writes and saves every aspect, the way the Social Worker does it.
 *
 * No per-aspect submit: the aspects are six fields of one document, and the
 * single signature at the foot covers all of them.
 */
async function fillEveryAspect(sw, reportId) {
  const detail = await sw.get(`${BASE}/${reportId}`);
  for (const section of detail.body.data.sections) {
    const saved = await sw.put(`${BASE}/${reportId}/sections/${section.id}`, {
      presentLevel: 'Moderate',
      observations: `- ${section.aspectLabel} observed during the period`,
      interventions: `- ${section.aspectLabel} support continued`,
    });
    assert.equal(saved.status, 200, `${section.aspectKey}: ${JSON.stringify(saved.body)}`);
  }
  return (await sw.get(`${BASE}/${reportId}`)).body.data;
}

// ── THE WORKFLOW ────────────────────────────────────────────────────────────

test('a Social Worker opens the period and gets a blank six-aspect report', async () => {
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const created = await sw.post(BASE, { residentId: RESIDENT, periodStart: PERIOD.start, periodEnd: PERIOD.end });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const report = created.body.data;
    assert.equal(report.status, 'Draft');
    assert.equal(report.sections.length, 6, 'all six aspects are created up front');
    assert.equal(report.sectionsTotal, 6);
    assert.equal(report.sectionsComplete, 0);
    assert.equal(report.isReviewer, true);
    assert.equal(report.canEditReport, true);
    assert.equal(report.canFinalize, false, 'nothing is written yet, so it cannot be finalized');
    // The signature line is filled from the account that opened it — the display
    // name Account Management holds — rather than left blank for the PDF to print
    // as an empty rule.
    assert.equal(report.preparedByName, 'Soc Worker');

    // The aspects are written, not assembled. The facility asked for the Social
    // Worker to fill them in, so they must arrive empty rather than pre-filled
    // from the period's records.
    for (const section of report.sections) {
      assert.equal(section.presentLevel, '', `${section.aspectKey} rating must start empty`);
      assert.equal(section.observations, '', `${section.aspectKey} observations must start empty`);
      assert.equal(section.interventions, '', `${section.aspectKey} interventions must start empty`);
      assert.equal(section.hasContent, false);
      assert.equal(section.canEdit, true, 'every aspect is the Social Worker\u2019s to write');
    }

    // The aspect keys are the six the form names, in canonical order.
    assert.deepEqual(
      report.sections.map((s) => s.aspectKey),
      ['physical', 'emotional', 'behavioral', 'spiritual', 'educational', 'economicProductivity']
    );
  });
});

test('the signature line falls back to the username when no display name is set', async () => {
  // "Social Worker (or the username configured in Account Management)" — an
  // account with no display name must still produce a name, not a blank rule.
  const tables = seed();
  tables.users = tables.users.map((u) => (u.id === SW.id ? { ...u, displayName: null } : u));
  const store = makeStore(tables);
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const created = await sw.post(BASE, { residentId: RESIDENT, periodStart: PERIOD.start, periodEnd: PERIOD.end });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.preparedByName, 'sw.one');
  });
});

test('saving a signature without a name uses the account name, not the login name', async () => {
  // The field is pre-filled on the client, but the server must not depend on that:
  // a payload carrying only the drawing still names the right person.
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const reportId = await openReport(sw);

    const signed = await sw.post(`${BASE}/${reportId}/signatures`, {
      preparedBy: { signature: 'data:image/png;base64,AAA' },
    });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.data.preparedByName, 'Soc Worker');
    assert.equal(signed.body.data.preparedBySignature, 'data:image/png;base64,AAA');
  });
});

test('finalizing backfills a preparer name rather than publishing a blank rule', async () => {
  // A report opened before the name was seeded — or one whose signature was never
  // saved — must not print an empty "Prepared by:" line.
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const reportId = await openReport(sw);
    // Simulate the legacy row: the name was never written.
    store.tables.quarterlyProgressReports[0].preparedByName = null;
    await fillEveryAspect(sw, reportId);

    const finalized = await sw.post(`${BASE}/${reportId}/finalize`, {});
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    assert.equal(finalized.body.data.preparedByName, 'Soc Worker');
    assert.equal(store.tables.quarterlyProgressReports[0].preparedByName, 'Soc Worker');
  });
});

test('the identifying block is filled from the records, and blanks are flagged not guessed', async () => {
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const created = await sw.post(BASE, { residentId: RESIDENT, periodStart: PERIOD.start, periodEnd: PERIOD.end });
    const identifying = created.body.data.identifyingInformation;

    assert.equal(identifying.childName, 'Juan Dela Cruz');
    assert.equal(identifying.sex, 'Male', 'sex lives on admissions, not children');
    assert.equal(identifying.religion, 'Roman Catholic');
    assert.equal(identifying.age, '16', 'computed from birthDate as at the period end, as a form value');
    assert.equal(identifying.ageUponAdmission, '16');
    assert.equal(identifying.schoolAttended, 'SCH ALS CLC');
    assert.equal(identifying.presentAddress, 'SCH Jenel Subd., Brgy. San Jose, Calamba City');
    assert.ok(identifying._sources.religion, 'every field carries its provenance');
  });
});

test('opening the same resident and period twice returns the existing report untouched', async () => {
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const first = await sw.post(BASE, { residentId: RESIDENT, periodStart: PERIOD.start, periodEnd: PERIOD.end });
    const second = await sw.post(BASE, { residentId: RESIDENT, periodStart: PERIOD.start, periodEnd: PERIOD.end });

    assert.equal(second.status, 200);
    assert.equal(second.body.created, false);
    assert.equal(second.body.data.id, first.body.data.id);
    assert.equal(store.tables.quarterlyProgressReports.length, 1, 'the snapshot is not rebuilt');
  });
});

test('a Houseparent can neither list, open, nor write to a report', async () => {
  // The Houseparent specification withholds the Reports module outright, so the
  // mount gate refuses every verb before the controller runs. The list used to
  // answer 200 with an empty body and `canOpenReport: false` — a refusal inside
  // the handler, which still confirmed the endpoint was live and left it
  // reachable by direct URL.
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const hp = clientFor(base, HP);
    const reportId = await openReport(sw);
    const sectionId = (await sw.get(`${BASE}/${reportId}`)).body.data.sections[0].id;

    assert.equal((await hp.get(BASE)).status, 403, 'listing is refused by the module gate');

    assert.equal((await hp.get(`${BASE}/${reportId}`)).status, 403, 'opening it is refused');
    assert.equal((await hp.put(`${BASE}/${reportId}/sections/${sectionId}`, { observations: 'x' })).status, 403);
    assert.equal((await hp.post(`${BASE}/${reportId}/finalize`, {})).status, 403);
    assert.equal((await hp.del(`${BASE}/${reportId}`)).status, 403);
    assert.equal((await hp.put(`${BASE}/${reportId}`, { periodLabel: 'hacked' })).status, 403);

    // Access is checked before existence, so a bogus aspect id is refused too
    // rather than answered with a 404 that would confirm which ids are real.
    assert.equal((await hp.put(`${BASE}/${reportId}/sections/NOPE`, { observations: 'x' })).status, 403);
  });
});

test('the Social Worker can write every aspect, and the first write advances its status', async () => {
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const reportId = await openReport(sw);
    const before = (await sw.get(`${BASE}/${reportId}`)).body.data;
    assert.equal(before.sectionsComplete, 0);

    // Every aspect, not just one: this is the requirement that the Social Worker
    // must be able to complete all six.
    for (const section of before.sections) {
      const saved = await sw.put(`${BASE}/${reportId}/sections/${section.id}`, {
        presentLevel: 'Moderate',
        observations: `- ${section.aspectLabel} observed`,
        interventions: `- ${section.aspectLabel} support`,
      });
      assert.equal(saved.status, 200, `${section.aspectKey}: ${JSON.stringify(saved.body)}`);
      const written = saved.body.data.sections.find((s) => s.id === section.id);
      assert.equal(written.presentLevel, 'Moderate');
      assert.equal(written.status, 'In Progress', 'a first write must leave Not Started');
      assert.equal(written.hasContent, true);
    }

    const after = (await sw.get(`${BASE}/${reportId}`)).body.data;
    assert.equal(after.sectionsComplete, 6);
    assert.equal(after.canFinalize, true);
  });
});

test('a blank aspect blocks finalizing, and the capability says so before the button is offered', async () => {
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const reportId = await openReport(sw);

    const early = await sw.post(`${BASE}/${reportId}/finalize`, {});
    assert.equal(early.status, 409);
    assert.match(early.body.message, /still empty|Fill in every aspect/i);
    assert.equal((await sw.get(`${BASE}/${reportId}`)).body.data.canFinalize, false);

    // Five of six written is still not enough.
    const sections = (await sw.get(`${BASE}/${reportId}`)).body.data.sections;
    for (const section of sections.slice(0, 5)) {
      await sw.put(`${BASE}/${reportId}/sections/${section.id}`, { presentLevel: 'Moderate', observations: '- x' });
    }
    const partial = (await sw.get(`${BASE}/${reportId}`)).body.data;
    assert.equal(partial.sectionsComplete, 5);
    assert.equal(partial.canFinalize, false, 'one blank aspect is enough to block it');
    assert.equal((await sw.post(`${BASE}/${reportId}/finalize`, {})).status, 409);

    // An empty aspect is allowed to be saved — the block is on finalizing, not on
    // writing, so a Social Worker can clear a field and come back to it.
    const cleared = await sw.put(`${BASE}/${reportId}/sections/${sections[0].id}`, {
      presentLevel: '', observations: '', interventions: '',
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.sections.find((s) => s.id === sections[0].id).hasContent, false);
  });
});

test('the per-aspect workflow endpoints no longer exist', async () => {
  // The routes were removed, so Express must answer 404 rather than drive a
  // workflow the UI no longer offers and the PDF no longer reflects.
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const reportId = await openReport(sw);
    const sectionId = (await sw.get(`${BASE}/${reportId}`)).body.data.sections[0].id;

    assert.equal((await sw.post(`${BASE}/${reportId}/assign`, { assignments: [] })).status, 404);
    assert.equal((await sw.post(`${BASE}/${reportId}/submit`, {})).status, 404);
    assert.equal((await sw.post(`${BASE}/${reportId}/return`, { notes: 'x' })).status, 404);
    assert.equal((await sw.post(`${BASE}/${reportId}/sections/${sectionId}/submit`)).status, 404);
    assert.equal((await sw.post(`${BASE}/${reportId}/sections/${sectionId}/return`, { reason: 'x' })).status, 404);
    assert.equal((await sw.get(`${BASE}/assignable-staff`)).status, 404);
  });
});

test('the fill-in form is served as a PDF to the preparer and to nobody else', async () => {
  // The popup form renders this and overlays its inputs on it, so it has to be a
  // real PDF document. It must also not be cached: a stale form would show the
  // previous resident's details on the next report opened.
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const hp = clientFor(base, HP);
    const reportId = await openReport(sw);

    const response = await fetch(`${base}${BASE}/${reportId}/template`, {
      headers: { Authorization: `Bearer ${tokenFor(SW)}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/pdf/);
    assert.match(response.headers.get('cache-control') || '', /no-store/);

    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'the form must be a PDF document');
    assert.ok(bytes.length > 5000, 'the form must be a whole document, not a stub');

    // The same gate as the report itself: a caller who may not read the report may
    // not read the form built out of it.
    assert.equal((await hp.get(`${BASE}/${reportId}/template`)).status, 403);
  });
});

test('finalizing publishes the PDF into the resident Documents, then flips the status', async () => {
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const reportId = await openReport(sw);

    const ready = await fillEveryAspect(sw, reportId);
    assert.equal(ready.sectionsComplete, 6);
    assert.equal(ready.canFinalize, true);

    // The signature is saved before finalizing, so the published PDF carries it.
    const signed = await sw.post(`${BASE}/${reportId}/signatures`, {
      preparedBy: { name: 'Soc Worker', signature: 'data:image/png;base64,AAA' },
    });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.data.preparedByName, 'Soc Worker');

    const finalized = await sw.post(`${BASE}/${reportId}/finalize`, {});
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    assert.equal(finalized.body.data.status, 'Finalized');

    // Published before the status flipped, so a PDF failure would have left the
    // report open rather than finalized with no document.
    assert.equal(store.tables.documents.length, 1, 'exactly one document is published');
    const document = store.tables.documents[0];
    assert.equal(document.residentId, RESIDENT, 'filed against the resident, not the report');
    assert.equal(document.quarterlyReportId, reportId, 'and linked back to the report');
    assert.equal(document.type, 'Quarterly Progress Report');
    assert.equal(document.category, 'Progress Report');
    assert.equal(document.status, 'Approved');
    // The stored label is the facility's own name for the period — a calendar
    // quarter — while the PDF's own header spells the months out.
    assert.equal(document.title, 'Quarterly Progress Report - Q2 2024');
    assert.ok(document.fileData && document.fileData.length > 1000, 'the PDF body is stored');
    assert.ok(Number(document.fileSize) > 1000);

    // A second finalize must not create a second copy.
    assert.equal((await sw.post(`${BASE}/${reportId}/finalize`, {})).status, 409);
    assert.equal(store.tables.documents.length, 1);
  });
});

test('a finalized report refuses every write', async () => {
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const reportId = await openReport(sw);
    const sectionId = (await fillEveryAspect(sw, reportId)).sections[0].id;
    assert.equal((await sw.post(`${BASE}/${reportId}/finalize`, {})).status, 200);

    assert.equal((await sw.put(`${BASE}/${reportId}/sections/${sectionId}`, { observations: 'x' })).status, 409);
    assert.equal((await sw.post(`${BASE}/${reportId}/signatures`, { preparedBy: { name: 'x' } })).status, 409);
    assert.equal((await sw.put(`${BASE}/${reportId}`, { periodLabel: 'x' })).status, 409);
    assert.equal((await sw.del(`${BASE}/${reportId}`)).status, 409);

    // And the removed endpoints are absent regardless of the report's status.
    assert.equal((await sw.post(`${BASE}/${reportId}/sections/${sectionId}/submit`)).status, 404);
    assert.equal((await sw.post(`${BASE}/${reportId}/sections/${sectionId}/return`, { reason: 'x' })).status, 404);
    assert.equal((await sw.post(`${BASE}/${reportId}/submit`, {})).status, 404);
  });
});

test('the identifying block is a snapshot: a later record change does not rewrite it', async () => {
  // The report stores its own copy of the identifying block when it is opened.
  // If it were re-derived on read, correcting a resident's religion in their
  // record would silently rewrite a report that had already been signed.
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const reportId = await openReport(sw);
    const before = (await sw.get(`${BASE}/${reportId}`)).body.data.identifyingInformation;
    assert.equal(before.religion, 'Roman Catholic');

    // The resident's record is corrected afterwards.
    store.tables.admissions[0].religion = 'Iglesia ni Cristo';
    store.tables.children[0].name = 'Juan D. Cruz';

    const reopened = await sw.post(BASE, { residentId: RESIDENT, periodStart: PERIOD.start, periodEnd: PERIOD.end });
    assert.equal(reopened.body.created, false);
    const after = reopened.body.data.identifyingInformation;
    assert.equal(after.religion, 'Roman Catholic', 'the stored snapshot is untouched');
    assert.equal(after.childName, 'Juan Dela Cruz', 'and so is the stored name');
    assert.equal(reopened.body.data.id, reportId);
  });
});

test('deleting an unpublished report removes its aspects too', async () => {
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const reportId = await openReport(sw);

    assert.equal(store.tables.quarterlyProgressReportSections.length, 6);
    const deleted = await sw.del(`${BASE}/${reportId}`);
    assert.equal(deleted.status, 200);
    assert.equal(store.tables.quarterlyProgressReports.length, 0);
    assert.equal(store.tables.quarterlyProgressReportSections.length, 0, 'the aspects go with it');
  });
});

test('every query the workflow issues is one the store knows about', async () => {
  // The store throws on an unrecognised statement, so a clean run proves the
  // controller issues no SQL the workflow did not exercise.
  const store = makeStore();
  const app = loadApp(store);
  await withServer(app, async (base) => {
    const sw = clientFor(base, SW);
    const reportId = await openReport(sw);
    await fillEveryAspect(sw, reportId);
    await sw.post(`${BASE}/${reportId}/signatures`, { preparedBy: { name: 'Soc Worker', signature: null } });
    await sw.post(`${BASE}/${reportId}/finalize`, {});
    await sw.get(BASE);
    await sw.get(`${BASE}/periods?year=2024`);
    await sw.get(`${BASE}/identifying/${RESIDENT}`);
    const hp = clientFor(base, HP);
    await hp.get(BASE);
    assert.ok(store.log.length > 20, `expected a real exchange, saw ${store.log.length} statements`);
  });
});