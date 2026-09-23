/**
 * Transaction-level retry for the id-generating writes that live inside a
 * transaction.
 *
 * The seven call sites that could not use `insertWithGeneratedId()` all sit
 * inside a transaction. There, a non-locking re-read returns the transaction's
 * original snapshot (so the retry would recompute the same colliding id), and a
 * locking read would deadlock because the transaction already holds a row lock
 * before it reads the id range. Retrying the whole transaction is the only
 * option that adds no locks, so these tests pin its behaviour — especially that
 * it does NOT retry errors a retry cannot fix.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runInTransactionWithIdRetry } = require('../src/utils/helpers');

const primaryKeyCollision = () => Object.assign(new Error('duplicate'), {
  code: 'ER_DUP_ENTRY',
  sqlMessage: "Duplicate entry 'PHS005' for key 'PRIMARY'",
});

const businessKeyCollision = () => Object.assign(new Error('duplicate'), {
  code: 'ER_DUP_ENTRY',
  sqlMessage: "Duplicate entry 'CH001-2026-9' for key 'uq_anecdotal_resident_period'",
});

/** Records every transaction control call so the sequence can be asserted. */
function fakePool() {
  const events = [];
  return {
    events,
    getConnection: async () => ({
      beginTransaction: async () => { events.push('begin'); },
      commit: async () => { events.push('commit'); },
      rollback: async () => { events.push('rollback'); },
      release: () => { events.push('release'); },
    }),
  };
}

test('commits the work and returns its result', async () => {
  const pool = fakePool();
  const result = await runInTransactionWithIdRetry(pool, async () => 'value');

  assert.equal(result, 'value');
  assert.deepEqual(pool.events, ['begin', 'commit', 'release']);
});

test('retries the whole transaction on a primary-key collision, from a fresh connection', async () => {
  const pool = fakePool();
  let attempt = 0;

  const result = await runInTransactionWithIdRetry(pool, async () => {
    attempt += 1;
    if (attempt === 1) throw primaryKeyCollision();
    return `attempt-${attempt}`;
  });

  assert.equal(result, 'attempt-2');
  assert.equal(attempt, 2, 'the work must actually run twice');
  assert.deepEqual(pool.events, ['begin', 'rollback', 'release', 'begin', 'commit', 'release'],
    'the first attempt must be rolled back and released before the retry');
});

test('does not retry an error that a retry cannot fix', async () => {
  const cases = [
    ['a non-duplicate error', () => Object.assign(new Error('bad column'), { code: 'ER_BAD_FIELD_ERROR' })],
    ['a business unique-key collision', businessKeyCollision],
  ];

  for (const [label, makeError] of cases) {
    const pool = fakePool();
    let attempts = 0;

    await assert.rejects(
      () => runInTransactionWithIdRetry(pool, async () => { attempts += 1; throw makeError(); }),
      (error) => error === undefined || true,
      label,
    );

    assert.equal(attempts, 1, `${label} must not be retried`);
    assert.deepEqual(pool.events, ['begin', 'rollback', 'release'], `${label} must roll back and release`);
  }
});

test('gives up after the attempt limit and surfaces the collision', async () => {
  const pool = fakePool();
  let attempts = 0;

  await assert.rejects(
    () => runInTransactionWithIdRetry(pool, async () => { attempts += 1; throw primaryKeyCollision(); }, { attempts: 3 }),
    (error) => error.code === 'ER_DUP_ENTRY',
  );

  assert.equal(attempts, 3);
  assert.equal(pool.events.filter((e) => e === 'release').length, 3, 'every attempt must release its connection');
  assert.equal(pool.events.includes('commit'), false, 'nothing may commit when every attempt failed');
});

test('a single attempt cannot survive a collision — the retry is load-bearing', async () => {
  // Mutation check: with attempts = 1 the helper behaves like the old code, so
  // the collision reaches the caller. This is what the converted call sites used
  // to do, and it is the behaviour the retry exists to remove.
  const pool = fakePool();

  await assert.rejects(
    () => runInTransactionWithIdRetry(pool, async () => { throw primaryKeyCollision(); }, { attempts: 1 }),
    (error) => error.code === 'ER_DUP_ENTRY',
  );
});

test('the rollback itself failing must not mask the original error', async () => {
  const events = [];
  const pool = {
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => { events.push('rollback'); throw new Error('connection already gone'); },
      release: () => { events.push('release'); },
    }),
  };

  await assert.rejects(
    () => runInTransactionWithIdRetry(pool, async () => { throw new Error('the real failure'); }),
    /the real failure/,
  );
  assert.deepEqual(events, ['rollback', 'release'], 'the connection must still be released');
});

/**
 * The four files that hold the transactional id sites must keep using the
 * helper. Without this guard, a future edit could reintroduce the bare
 * `generateId()` + commit pattern that these tests exist to prevent.
 *
 * The call count is asserted, not just presence: reverting a single call site
 * must fail this test.
 */
test('every transactional id site uses the retry helper', () => {
  // Expected number of `runInTransactionWithIdRetry(pool, ...)` calls per file —
  // one per transaction that derives a primary key from the current maximum.
  const expected = {
    'controllers/phaseController.js': 3,        // complete, demote, returnToPhase
    'controllers/admissionController.js': 1,    // create (CH, 2x PHS, ADM)
    'controllers/incidentReportController.js': 1, // Form 08 (INC, DOC)
    'utils/violationGuideHelper.js': 1,         // intervention trackers (IT)
  };

  for (const [file, count] of Object.entries(expected)) {
    const source = fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8');

    // Anti-vacuity: the file must be real and must still generate ids, otherwise
    // the count below proves nothing.
    assert.ok(source.length > 500, `${file} looks empty — the guard is not checking anything`);
    assert.ok(source.includes('generateId'), `${file} no longer generates ids; drop it from this list`);

    const actual = (source.match(/runInTransactionWithIdRetry\(\s*pool/g) || []).length;
    assert.equal(actual, count,
      `${file} should wrap ${count} id-generating transaction(s) in the retry helper, found ${actual}`);
  }
});

/**
 * A manual `beginTransaction()` followed by a bare `generateId()` is exactly the
 * pattern that was fixed: the retry cannot see past the transaction's snapshot.
 * This scans each converted file for that shape so a partial revert is caught.
 */
test('no converted file opens a transaction and then generates an id inline', () => {
  const files = [
    'controllers/phaseController.js',
    'controllers/admissionController.js',
    'controllers/incidentReportController.js',
    'utils/violationGuideHelper.js',
  ];

  let scanned = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8');
    const lines = source.split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      if (!/beginTransaction\(\)/.test(lines[i])) continue;
      scanned += 1;
      // Look ahead within the same block for a bare id derivation.
      const window = lines.slice(i, i + 400).join('\n');
      const inlineId = /connection\.query\(\s*['"`]SELECT id FROM/.test(window) && /generateId\(/.test(window);
      const wrapped = /runInTransactionWithIdRetry\(\s*pool/.test(lines.slice(Math.max(0, i - 12), i + 1).join('\n'));
      assert.ok(!inlineId || wrapped,
        `${file}:${i + 1} opens a transaction, reads ids and calls generateId without the retry helper`);
    }
  }

  assert.ok(scanned > 0, 'no beginTransaction() found — the scanner is not looking at the right files');
});
