/**
 * Access Request History is scoped by user id, not by the reviewer's name.
 *
 * The history is the permanent audit trail: every Approved / Rejected request,
 * who decided it, when, and why. A full-access caller sees all of it; everyone
 * else sees the ones they decided — which is what "all document access requests
 * they previously approved or rejected" means.
 *
 * That scope used to be `String(row.reviewedBy) === String(req.user.username)`,
 * comparing two display names with `===`. Three things follow from keying a
 * relationship on a name, and only the first is obvious:
 *
 *   - Renaming an account silently emptied its own audit trail. The decisions
 *     were still in the table; the reviewer could no longer see them.
 *   - The `reviewedBy` column collates case-insensitively (utf8mb4_unicode_ci)
 *     while the JavaScript comparison does not, so the database and the
 *     controller disagreed about whether two names matched.
 *   - A name match could not be told apart from an id match, because the
 *     document-owner lookup searched `WHERE username IN (?) OR id IN (?)` with a
 *     list of *usernames* — so it could address a request to an unrelated
 *     account whose id happened to read like the uploader's name.
 *
 * `reviewedById` is written on every decision and the history is keyed on it.
 * `reviewedBy` is kept and returned, because the interface shows it; it is a
 * label again rather than the link. Rows decided before the column existed fall
 * back to the name comparison, and only those.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const CONTROLLER_SRC = read('backend/src/controllers/accessRequestController.js');
const SCHEMA = read('backend/src/database/schema.sql');
const SERVER = read('backend/src/server.js');

// ── A pool that answers only what the assertions need ───────────────────────

let historyRows = [];
const queries = [];

async function query(sql, params) {
  const text = String(sql);
  queries.push({ sql: text, params });

  if (/CREATE TABLE|ALTER TABLE/i.test(text)) return [[], []];
  if (/UPDATE accessRequests ar/i.test(text)) return [{ affectedRows: 0 }];
  if (/FROM accessRequests ar/i.test(text)) return [historyRows];
  return [[], []];
}

const DB_MODULE_PATH = require.resolve('../src/config/database');
require.cache[DB_MODULE_PATH] = {
  id: DB_MODULE_PATH,
  filename: DB_MODULE_PATH,
  loaded: true,
  exports: { pool: { query }, dbConfig: {}, testConnection: async () => true },
};

const controller = require('../src/controllers/accessRequestController');

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

/** The rows the caller is allowed to see in the history. */
async function historyFor(user, status = 'All') {
  const res = makeRes();
  let captured = null;
  await controller.getHistory({ user, query: { status } }, res, (error) => { captured = error; });
  assert.equal(captured, null, `getHistory failed: ${captured && captured.message}`);
  return res.body.data;
}

/** A completed decision row, as the history query returns it. */
const decidedRow = (overrides) => ({
  id: 'ACC1', requesterId: 'U-REQ', requesterUsername: 'requester', requesterRole: 'nurse',
  targetUserId: 'U-REV', targetRole: 'centerhead', documentId: 'DOC1', residentId: 'CH001',
  moduleName: null, recordTab: null, reason: 'needed for the report', status: 'Approved',
  reviewedBy: 'Old Name', reviewedById: 'U-REV', reviewedAt: new Date('2026-01-02T00:00:00Z'),
  reviewerNote: null, createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  documentTitle: 'Medical Certificate', documentFileName: 'mc.pdf', documentResidentId: 'CH001',
  documentCategory: 'Medical', documentUploaderRole: 'nurse', residentName: 'Resident One',
  ...overrides,
});

const SOCIAL_WORKER = { id: 'U-REV', username: 'joyce', role: 'socialworker' };

test('a reviewer keeps their history after being renamed', async () => {
  // The decision was recorded under the id; the printed name is stale. Keying on
  // the name would show this reviewer nothing at all.
  historyRows = [decidedRow({ reviewedBy: 'Ma\'am Joyce (old)' })];
  const visible = await historyFor(SOCIAL_WORKER);
  assert.equal(visible.length, 1, 'the reviewer lost a decision they had taken, because the name changed');
  assert.equal(visible[0].id, 'ACC1');
});

test('a recorded reviewer id is never overridden by a matching name', async () => {
  // Someone else decided it, but the stored name happens to equal my username.
  // The id is authoritative, so this must stay hidden — otherwise a rename hands
  // me another person's decisions.
  historyRows = [decidedRow({ reviewedById: 'U-SOMEONE-ELSE', reviewedBy: 'joyce' })];
  const visible = await historyFor(SOCIAL_WORKER);
  assert.equal(
    visible.length,
    0,
    'a name match leaked a decision that the recorded reviewer id says belongs to someone else',
  );
});

test('a decision taken before the id existed still matches by name', async () => {
  // Existing data must keep working: legacy rows have no id and fall through to
  // the name comparison, exactly as they behaved before.
  historyRows = [decidedRow({ reviewedById: null, reviewedBy: 'joyce' })];
  const visible = await historyFor(SOCIAL_WORKER);
  assert.equal(visible.length, 1, 'a legacy decision disappeared from the reviewer who took it');
});

test('a legacy decision another person took stays hidden', async () => {
  // The fallback only runs for rows with no recorded id, so its negative case
  // has to be pinned separately: without this, a fallback that matched
  // everything would still pass every other assertion here, and one reviewer
  // would see every legacy decision in the facility.
  historyRows = [decidedRow({ reviewedById: null, reviewedBy: 'someone-else' })];
  const visible = await historyFor(SOCIAL_WORKER);
  assert.equal(visible.length, 0, 'a legacy decision taken by another person was shown to this reviewer');
});

test('the legacy fallback compares names the way the column does', async () => {
  // `reviewedBy` collates case-insensitively (utf8mb4_unicode_ci), so a strict
  // `===` in the fallback disagreed with the database about whether two names
  // matched. Usernames are unique under that same collation, so this cannot
  // resolve to a different account.
  historyRows = [decidedRow({ reviewedById: null, reviewedBy: ' JOYCE ' })];
  const visible = await historyFor(SOCIAL_WORKER);
  assert.equal(visible.length, 1, 'the legacy fallback is stricter than the column it reads');
});

test('a manager still sees every decision', async () => {
  historyRows = [
    decidedRow({ id: 'ACC1', reviewedById: 'U-REV' }),
    decidedRow({ id: 'ACC2', reviewedById: 'U-OTHER', reviewedBy: 'someone' }),
  ];
  const visible = await historyFor({ id: 'U-CH', username: 'centerhead', role: 'centerhead' });
  assert.equal(visible.length, 2, 'the Center Head no longer sees the whole audit trail');
});

test('the decision is written with the reviewer id in all three table definitions', () => {
  assert.match(
    CONTROLLER_SRC,
    /SET status = \?, reviewedBy = \?, reviewedById = \?, reviewedAt = NOW\(\)/,
    'review() does not record the reviewer id, so the history would stay name-keyed',
  );
  assert.match(
    CONTROLLER_SRC,
    /\[decision, req\.user\.username, req\.user\.id, reviewerNote \|\| null, id\]/,
    'review() does not bind the reviewer id from the authenticated user',
  );
  // The column has to exist wherever the table is declared, or a fresh database
  // would only gain it through the lazy ensureTable path.
  for (const [label, source] of [['the reference schema', SCHEMA], ['the boot migration', SERVER]]) {
    assert.match(source, /reviewedById VARCHAR\(40\) NULL/, `${label} does not declare accessRequests.reviewedById`);
  }
  assert.match(
    CONTROLLER_SRC,
    /ADD COLUMN reviewedById VARCHAR\(40\) NULL/,
    'a deployed database would never gain the column',
  );
});

test('the backfill only links a name that resolves to exactly one account', () => {
  // An ambiguous name must be left NULL so the row keeps its old behaviour; the
  // backfill may make a link more precise, never reassign an audit trail.
  assert.match(
    CONTROLLER_SRC,
    /HAVING COUNT\(\*\) = 1/,
    'the reviewer backfill would resolve an ambiguous name to an arbitrary account',
  );
  assert.match(
    CONTROLLER_SRC,
    /WHERE ar\.reviewedById IS NULL/,
    'the backfill could overwrite an already-recorded reviewer',
  );
});

test('the document-owner lookup no longer confuses usernames with ids', () => {
  // createdBy / uploadedBy / submittedBy hold usernames. Matching them against
  // users.id could only hit by coincidence — and addressed the request to the
  // wrong person when it did.
  assert.doesNotMatch(
    CONTROLLER_SRC,
    /WHERE username IN \(\?\) OR id IN \(\?\)/,
    'the owner lookup still matches a username against users.id',
  );
  assert.match(
    CONTROLLER_SRC,
    /WHERE username IN \(\?\) LIMIT 1/,
    'the owner lookup no longer resolves the document owner by username',
  );
});
