/**
 * SCH-PATH local API — SQLite, no cloud.
 * Resources: children, staff, activities, assessments, reports, users
 */

import cors from 'cors';
import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const dataDir = path.join(projectRoot, 'data');
const dbPath = path.join(dataDir, 'sch.db');

const PORT = Number(process.env.PORT) || 5000;
const ALLOWED_BUCKETS = new Set(['children', 'staff', 'activities', 'assessments', 'reports', 'users']);

function ensureDbPath() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash || hash.length % 2 !== 0) return false;
  let chk;
  try {
    chk = crypto.scryptSync(plain, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(chk, 'hex'));
  } catch {
    return false;
  }
}

function openDb() {
  ensureDbPath();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      bucket TEXT NOT NULL,
      id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (bucket, id)
    );
    CREATE INDEX IF NOT EXISTS idx_users_username
      ON entities (bucket, lower(json_extract(payload, '$.username')))
      WHERE bucket = 'users';
  `);
  return db;
}

const db = openDb();

const selectAll = db.prepare(`SELECT id, payload FROM entities WHERE bucket = ? ORDER BY id`);
const selectOne = db.prepare(`SELECT payload FROM entities WHERE bucket = ? AND id = ?`);
const upsertRow = db.prepare(`
  INSERT INTO entities (bucket, id, payload) VALUES (@bucket, @id, @payload)
  ON CONFLICT(bucket, id) DO UPDATE SET payload = excluded.payload
`);
const deleteRow = db.prepare(`DELETE FROM entities WHERE bucket = ? AND id = ?`);

function findUserByUsername(username) {
  const lowered = username.trim().toLowerCase();
  const rows = db
    .prepare(`SELECT id, payload FROM entities WHERE bucket = 'users'`)
    .all();
  for (const row of rows) {
    try {
      const u = JSON.parse(row.payload);
      if (typeof u.username === 'string' && u.username.trim().toLowerCase() === lowered) {
        return { id: row.id, parsed: u };
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

function mergeUser(existingParsed, incoming) {
  const e = existingParsed ? { ...existingParsed } : {};
  const plainPwd = incoming.password;
  const next = {
    ...e,
    ...incoming,
    password: undefined,
  };
  delete next.password;
  if (typeof plainPwd === 'string' && plainPwd.trim() !== '') {
    next.passwordHash = hashPassword(plainPwd.trim());
  } else {
    next.passwordHash = e.passwordHash;
  }
  return next;
}

function userOutbound(parsed) {
  if (!parsed) return parsed;
  const o = { ...parsed };
  delete o.passwordHash;
  o.password = '';
  return o;
}

function normalizeUserInbound(body, existingParsed = null) {
  return mergeUser(existingParsed, body);
}

function parseJson(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function listBucket(bucket) {
  return selectAll.all(bucket).map((row) => {
    let obj = parseJson(row.payload);
    if (obj == null) obj = {};
    if (bucket === 'users') return userOutbound(obj);
    return obj;
  });
}

function seedIfEmpty() {
  const countUsers = db.prepare(`SELECT COUNT(*) AS c FROM entities WHERE bucket = 'users'`).get();
  if (!countUsers || countUsers.c > 0) return;

  const defaultModules = [
    'Dashboard',
    'Child Records',
    'Activities',
    'Assessments',
    'Reports',
    'Account Management',
  ];
  const user = normalizeUserInbound(
    {
      id: 'U001',
      username: 'centerhead',
      password: 'centerhead123',
      role: 'centerhead',
      accessibleModules: defaultModules,
      status: 'Active',
      createdDate: '2025-01-01',
    },
    null,
  );

  upsertRow.run({
    bucket: 'users',
    id: user.id || 'U001',
    payload: JSON.stringify(user),
  });
}

seedIfEmpty();

const app = express();
app.use(
  cors({
    origin: true,
    credentials: false,
  }),
);
app.use(express.json({ limit: '2mb' }));

app.use((req, _res, next) => {
  if (process.env.DEBUG_API) console.log(req.method, req.path);
  next();
});

/** GET full store — must match frontend getStore() */
app.get('/api/store', (_req, res) => {
  try {
    res.json({
      success: true,
      data: {
        children: listBucket('children'),
        staff: listBucket('staff'),
        activities: listBucket('activities'),
        assessments: listBucket('assessments'),
        reports: listBucket('reports'),
        users: listBucket('users'),
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message || 'Store read failed' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required' });
  }
  const hit = findUserByUsername(username);
  if (!hit) {
    return res.status(401).json({ success: false, message: 'Invalid username or password' });
  }
  const u = hit.parsed;
  if (!verifyPassword(password, u.passwordHash)) {
    return res.status(401).json({ success: false, message: 'Invalid username or password' });
  }
  if (String(u.status || 'Active').toLowerCase() === 'inactive') {
    return res.status(403).json({ success: false, message: 'Account inactive' });
  }
  const role = typeof u.role === 'string' ? u.role.toLowerCase() : 'staff';
  res.json({
    success: true,
    user: {
      username: u.username,
      role,
      accessibleModules: Array.isArray(u.accessibleModules) ? u.accessibleModules : [],
    },
  });
});

function assertBucket(bucket) {
  return ALLOWED_BUCKETS.has(bucket);
}

app.post('/api/:bucket', (req, res) => {
  const { bucket } = req.params;
  if (!assertBucket(bucket)) {
    return res.status(404).json({ success: false, message: 'Unknown resource' });
  }
  try {
    const body = req.body;
    const id = body?.id ?? body?.[`${bucket.slice(0, -1)}Id`]; // fallback unused
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ success: false, message: 'Missing id' });
    }

    if (bucket === 'users') {
      const existing = findUserByUsername(body.username);
      if (existing && existing.id !== id) {
        return res.status(409).json({ success: false, message: 'Username already exists.' });
      }
      const normalized = normalizeUserInbound(body, null);
      normalized.id = id;
      upsertRow.run({
        bucket,
        id,
        payload: JSON.stringify(normalized),
      });
      return res.status(201).json({ success: true, data: userOutbound(normalized) });
    }

    const duplicate = selectOne.get(bucket, id);
    if (duplicate) {
      return res.status(409).json({ success: false, message: 'Resource already exists' });
    }

    upsertRow.run({
      bucket,
      id,
      payload: JSON.stringify(body),
    });

    const row = selectOne.get(bucket, id);
    res.status(201).json({ success: true, data: parseJson(row?.payload ?? '{}') ?? body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message || 'Create failed' });
  }
});

app.put('/api/:bucket/:id', (req, res) => {
  const { bucket, id } = req.params;
  if (!assertBucket(bucket)) {
    return res.status(404).json({ success: false, message: 'Unknown resource' });
  }

  try {
    const prev = selectOne.get(bucket, id);
    if (!prev) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    if (bucket === 'users') {
      const mergedIn = prev.payload ? parseJson(prev.payload) ?? {} : {};
      const normalized = normalizeUserInbound({ ...req.body, id }, mergedIn);
      const candUser = normalized.username ?? mergedIn.username;
      const conflict = candUser ? findUserByUsername(candUser) : null;
      if (conflict && conflict.id !== id) {
        return res.status(409).json({ success: false, message: 'Username already exists.' });
      }
      normalized.id = id;
      upsertRow.run({ bucket, id, payload: JSON.stringify(normalized) });
      return res.json({ success: true, data: userOutbound(normalized) });
    }

    let existing = {};
    try {
      existing = JSON.parse(prev.payload);
    } catch {
      existing = {};
    }
    const next = { ...existing, ...req.body, id };
    upsertRow.run({ bucket, id, payload: JSON.stringify(next) });

    const row = selectOne.get(bucket, id);
    res.json({ success: true, data: parseJson(row?.payload ?? '{}') ?? next });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message || 'Update failed' });
  }
});

app.delete('/api/:bucket/:id', (req, res) => {
  const { bucket, id } = req.params;
  if (!assertBucket(bucket)) {
    return res.status(404).json({ success: false, message: 'Unknown resource' });
  }
  try {
    if (bucket === 'users') {
      const prev = selectOne.get(bucket, id);
      if (!prev) return res.json({ success: true });
      const u = parseJson(prev.payload);
      if (u && String(u.role).toLowerCase() === 'centerhead') {
        const centerheads = db
          .prepare(`SELECT id FROM entities WHERE bucket = 'users'`)
          .all()
          .filter((row) => {
            const parsed = parseJson(selectOne.get('users', row.id)?.payload);
            return parsed && String(parsed.role).toLowerCase() === 'centerhead';
          });
        if (centerheads.length <= 1) {
          return res.status(400).json({ success: false, message: 'Cannot delete the last center head.' });
        }
      }
    }
    deleteRow.run(bucket, id);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message || 'Delete failed' });
  }
});

const server = app.listen(PORT, () => {
  console.log(`SCH API listening on http://localhost:${PORT} (database: ${dbPath})`);
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. Stop the other process or run with a different PORT, e.g. PORT=5002 npm run server (and point Vite’s proxy at that port).`,
    );
    process.exit(1);
    return;
  }
  console.error(err);
  process.exit(1);
});
