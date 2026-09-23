/**
 * Guards for the returning-resident document split.
 *
 * A resident may be admitted any number of times. Each admission owns its own
 * documents, and nothing that happens in a later admission may move, merge or
 * reassign an earlier one — a discharge closes an admission, it does not archive
 * its files away, and a brand-new admission starts an empty folder.
 *
 * The failure this file exists for: re-publishing a Health record resolved the
 * document's `admissionId` from the resident's *current* admission rather than
 * leaving it where it was filed. A resident admitted twice would therefore have
 * every earlier health document dragged into the newer admission folder the next
 * time anyone opened and saved the record — silently, and with no way back,
 * because the original value was overwritten in place.
 *
 * These are source-level guards on the publisher contract plus behavioural tests
 * of the resolver the folder view uses. The resolver is exercised through the
 * real TypeScript module; the publishers are checked because their SQL is the
 * only place the reassignment can happen.
 *
 * Run: node --test tests/returning-resident-admissions.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND = path.join(REPO_ROOT, 'backend', 'src');
const FRONTEND = path.join(REPO_ROOT, 'frontend');
const RESOLVER = path.join(FRONTEND, 'src', 'utils', 'admissionPeriods.ts');

const read = (file) => fs.readFileSync(file, 'utf8');

/** Load the shipped TypeScript resolver so the tests exercise real behaviour. */
function loadResolver() {
  const ts = require(path.join(FRONTEND, 'node_modules', 'typescript'));
  const { outputText } = ts.transpileModule(read(RESOLVER), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: RESOLVER,
  });
  const loaded = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(loaded, loaded.exports, require);
  return loaded.exports;
}

const { admissionPeriodsFor, admissionPeriodKeyFor } = loadResolver();

// ── Fixtures: four admissions, oldest first ────────────────────────────────

/** A resident on their fourth admission, with the three closed ones on record. */
const FOURTH_ADMISSION = {
  admissionDate: '2026-09-01',
  readmissionDate: '2026-09-01',
  readmissionDatetime: '2026-09-01T08:00:00',
  previousCases: [
    { admissionId: 'ADM-1', admissionNumber: 1, admissionDate: '2024-01-10', closedDate: '2024-05-20' },
    { admissionId: 'ADM-2', admissionNumber: 2, admissionDate: '2024-11-03', closedDate: '2025-04-15' },
    { admissionId: 'ADM-3', admissionNumber: 3, admissionDate: '2025-10-01', closedDate: '2026-02-28' },
  ],
};

// ── The period list ────────────────────────────────────────────────────────

test('four admissions produce four folders, numbered oldest first', () => {
  const periods = admissionPeriodsFor(FOURTH_ADMISSION);

  assert.equal(periods.length, 4, 'a resident admitted four times needs four folders');
  assert.deepEqual(
    periods.map((period) => period.key),
    ['admission-1', 'admission-2', 'admission-3', 'admission-4'],
  );
  assert.deepEqual(
    periods.map((period) => period.admissionNumber),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    periods.map((period) => period.isCurrent),
    [false, false, false, true],
    'only the newest admission is the current one',
  );
});

test('every closed admission keeps its own admission id', () => {
  const periods = admissionPeriodsFor(FOURTH_ADMISSION);
  assert.deepEqual(
    periods.map((period) => period.admissionId),
    ['ADM-1', 'ADM-2', 'ADM-3', ''],
    'the open admission is the one the closed history cannot name',
  );
});

// ── Placement: a document stays where it was filed ─────────────────────────

test('a document filed under any admission is placed in that admission, whatever its date', () => {
  const periods = admissionPeriodsFor(FOURTH_ADMISSION);

  // Every one of these is deliberately given the *same* recent timestamp, which
  // is what makes the link authoritative: four documents written today, in four
  // different admissions, must not collapse into one folder.
  const today = '2026-09-15T10:00:00';
  const cases = [
    ['ADM-1', 'admission-1'],
    ['ADM-2', 'admission-2'],
    ['ADM-3', 'admission-3'],
  ];

  for (const [admissionId, expected] of cases) {
    assert.equal(
      admissionPeriodKeyFor({ admissionId, uploadedAt: today }, periods, FOURTH_ADMISSION.readmissionDatetime),
      expected,
      `a document filed under ${admissionId} must stay in ${expected}`,
    );
  }
});

test('a document belonging to the open admission is placed there even when the history cannot name it', () => {
  const periods = admissionPeriodsFor(FOURTH_ADMISSION);
  assert.equal(
    admissionPeriodKeyFor(
      { admissionId: 'ADM-4', uploadedAt: '2026-09-15T10:00:00' },
      periods,
      FOURTH_ADMISSION.readmissionDatetime,
    ),
    'admission-4',
    'the open admission is matched by exclusion, not by name',
  );
});

test('re-publishing never changes which folder a document is in', () => {
  const periods = admissionPeriodsFor(FOURTH_ADMISSION);
  const boundary = FOURTH_ADMISSION.readmissionDatetime;

  // The same document, seen before and after an unrelated edit elsewhere in the
  // resident's record. The admission link is immutable, so the answer is too —
  // the reported bug was exactly this changing.
  const filedUnderAdmission1 = { admissionId: 'ADM-1', uploadedAt: '2024-02-01T09:00:00' };
  const first = admissionPeriodKeyFor(filedUnderAdmission1, periods, boundary);
  const second = admissionPeriodKeyFor({ ...filedUnderAdmission1, uploadedAt: '2026-09-15T10:00:00' }, periods, boundary);

  assert.equal(first, 'admission-1');
  assert.equal(second, 'admission-1', 'a later timestamp must not move a linked document');
});

// ── Publisher contract ─────────────────────────────────────────────────────
//
// The SQL in these controllers is the only place an admission link can be
// rewritten. Each check reads the statement that runs when an *existing*
// document is re-published, because that is the path a returning resident hits.

test('the Health publisher keeps a document\'s admission when the resident has not changed', () => {
  const source = read(path.join(BACKEND, 'controllers', 'healthController.js'));

  const update = source.match(
    /const \[existing\][\s\S]*?healthRecordId = \? LIMIT 1'[\s\S]*?WHERE id = \?`[\s\S]*?\);/
  );
  assert.ok(update, 'expected the health document re-publish branch');

  // The re-publish may still assign the column, but the admission it writes must
  // never be *derived* unconditionally from the resident's current admission —
  // that is the bug: an edit to an old record dragged its document forward.
  //
  // The resolution is allowed, but only as the true branch of the move guard.
  // Matching the ternary is what distinguishes "guarded" from "unconditional";
  // a bare doesNotMatch on the call would also reject the correct code.
  assert.match(
    update[0],
    /residentChanged\s*\?\s*await activeAdmissionIdFor\(pool, record\.residentId\)\s*:\s*previous\.admissionId/,
    'the admission may only be re-resolved when the record moved to another resident',
  );
  assert.match(
    update[0],
    /previous\.admissionId/,
    "the document's existing admission must be carried through unchanged",
  );

  // And there must be no bare, unguarded re-resolution anywhere in the branch.
  assert.doesNotMatch(
    update[0],
    /(?<!\?\s*await )activeAdmissionIdFor\(pool, record\.residentId\)(?!\s*:\s*previous\.admissionId)/,
    're-publishing a health record must not re-resolve the admission unconditionally',
  );
});

test('the Health publisher only re-files a document when the record moves resident', () => {
  const source = read(path.join(BACKEND, 'controllers', 'healthController.js'));

  // The lookup has to read the columns the decision depends on, or `previous`
  // cannot tell a same-resident save from a move.
  assert.match(
    source,
    /SELECT id, residentId, admissionId FROM documents WHERE healthRecordId = \?/,
    'the re-publish lookup must select residentId and admissionId to compare them',
  );

  const branch = source.match(/const residentChanged = [^;]+;/);
  assert.ok(branch, 'expected the residentChanged decision');
  assert.match(
    branch[0],
    /previous\.residentId[\s\S]*?record\.residentId/,
    'residentChanged must compare the stored resident against the incoming one',
  );
});

test('no publisher re-resolves a document\'s admission when rewriting an existing entry', () => {
  // Only the Health publisher has a re-publish branch that touches the link, and
  // it is covered above. The others must leave the column alone entirely.
  const publishers = [
    'triController.js',
    'anecdotalReportController.js',
    'quarterlyProgressReportController.js',
  ];

  for (const file of publishers) {
    const source = read(path.join(BACKEND, 'controllers', file));
    for (const match of source.matchAll(/UPDATE documents[\s\S]*?WHERE[^`]*`/g)) {
      assert.doesNotMatch(
        match[0],
        /\badmissionId\s*=\s*\?/,
        `${file} rewrites documents.admissionId on an update`,
      );
    }
  }
});

test('every document publisher derives the admission from the resident, never the request', () => {
  // A client that could name the admission could file a document into a closed
  // one, or scatter a resident's files across admissions.
  const source = read(path.join(BACKEND, 'controllers', 'documentController.js'));
  assert.match(
    source,
    /activeAdmissionIdFor\(pool, data\.residentId\)/,
    'the upload path must derive the admission from the resident',
  );
  assert.match(
    source,
    /delete req\.body\.admissionId/,
    'a client-supplied admissionId must be discarded',
  );
});

test('a document is filed under the admission that was open when it was written', () => {
  // `activeAdmissionIdFor` decides which admission a new document joins. The
  // open admission wins, and the newest one is the fallback for the gap between
  // a discharge and a re-intake.
  const source = read(path.join(BACKEND, 'services', 'admissionLink.js'));
  assert.match(
    source,
    /ORDER BY \(status = 'Active'\) DESC, admissionNumber DESC/,
    'the active admission must be chosen before the newest one',
  );
  assert.match(
    source,
    /WHERE residentId = \?/,
    'the lookup must be scoped to the resident',
  );
});

test('creating an admission does not archive documents away from earlier admissions', () => {
  const source = read(path.join(BACKEND, 'controllers', 'admissionController.js'));

  // No statement on the admission-creation path may touch documents.admissionId.
  for (const match of source.matchAll(/UPDATE documents[\s\S]*?WHERE[^`]*`/g)) {
    assert.doesNotMatch(
      match[0],
      /admissionId\s*=/,
      'creating an admission must never reassign existing documents',
    );
  }

  // The previousCases rebuild must carry each prior admission's own id through,
  // or the folder view loses the ability to match a document to its admission.
  assert.match(
    source,
    /previousCases = priorAdmissions\.map\(\(row\) => \(\{[\s\S]*?admissionId: row\.id/,
    'previousCases must record each prior admission id',
  );
  assert.match(
    source,
    /WHERE residentId = \?[\s\S]*?AND admissionNumber < \?/,
    'the prior-admission query must exclude the admission being created',
  );
});

test('nothing deletes an admission row, so a closed admission keeps its folder', () => {
  // A discharged admission's documents stay attached to it and become a
  // historical record; deleting the admission would cascade them away.
  const controllers = fs.readdirSync(path.join(BACKEND, 'controllers'));
  for (const file of controllers) {
    const source = read(path.join(BACKEND, 'controllers', file));
    assert.doesNotMatch(
      source,
      /DELETE\s+FROM\s+admissions/i,
      `${file} deletes from admissions — a closed admission must survive its discharge`,
    );
  }
});

// ── The admission link has to exist on an upgraded database ────────────────
//
// schema.sql defines the column, but `CREATE TABLE IF NOT EXISTS` does nothing
// to a database that already has the table. Without a runtime migration the
// column exists only on a fresh install, so the merge this file guards against
// would reproduce on every upgraded deployment — and only there, which is the
// hardest version of the bug to reproduce. Assert both the column and the
// backfill that fills it.

test('documents.admissionId is added by a runtime migration, not only in schema.sql', () => {
  const server = read(path.join(BACKEND, 'server.js'));
  assert.match(
    server,
    /ensureColumn\('documents', 'admissionId'/,
    'an existing database never gets documents.admissionId — its documents would ' +
      'fall back to timestamps and every admission would merge into one folder',
  );
  assert.match(
    server,
    /ensureIndex\('documents', 'idx_documents_admission', 'admissionId'\)/,
    'the folder view filters documents by admission, so the column needs its index',
  );
});

test('existing documents are backfilled into an admission at boot', () => {
  const server = read(path.join(BACKEND, 'server.js'));
  assert.match(
    server,
    /await backfillDocumentAdmissions\(\);/,
    'the migration adds the column but never fills it, so legacy rows stay unlinked',
  );

  const backfill = server.match(/async function backfillDocumentAdmissions\(\)[\s\S]*?\n\}/);
  assert.ok(backfill, 'expected the documents backfill function');

  // Two passes: the admission in force when the document was written, then the
  // resident's earliest admission for anything that predates them all.
  assert.match(
    backfill[0],
    /a\.createdAt <= COALESCE\(d2\.createdAt, d2\.uploadedAt, d2\.submittedAt\)/,
    'placement must compare the admission against the document’s own creation time',
  );
  assert.match(
    backfill[0],
    /ORDER BY a\.admissionNumber DESC/,
    'the admission in force is the *latest* one that already existed',
  );
  assert.match(
    backfill[0],
    /ORDER BY a\.admissionNumber ASC/,
    'anything older than every admission must fall back to the earliest one',
  );
  assert.match(
    backfill[0],
    /WHERE d2\.admissionId IS NULL/,
    'the backfill must be idempotent — only rows with no link may be touched',
  );
});

// ── Retiring an admission must not retire a different admission ────────────
//
// `phaseProgress.isCurrent` is the only "which phase is the resident in" signal
// and it is per-resident, so the archival pass had to guess which rows belonged
// to the admission being closed. With no admission link it fell back to
// `WHERE residentId = ?`, which closed the newest admission's phases too.

test('phaseProgress carries the admission a phase belongs to', () => {
  const server = read(path.join(BACKEND, 'server.js'));
  assert.match(
    server,
    /ensureColumn\('phaseProgress', 'admissionId'/,
    'without the column the archival has nothing to scope on and must sweep the resident',
  );
  assert.match(
    server,
    /await backfillPhaseProgressAdmissions\(\);/,
    'existing phase rows need a link, or the scoped archival will skip them forever',
  );
});

test('retiring an admission only retires that admission’s phases', () => {
  const source = read(path.join(BACKEND, 'controllers', 'admissionController.js'));

  const archive = source.match(/UPDATE phaseProgress[\s\S]*?`,\s*\[[\s\S]*?\]\s*\);/);
  assert.ok(archive, 'expected the phase archival statement in the admissions controller');
  assert.match(
    archive[0],
    /admissionId = \?/,
    'the archival must be scoped to the admission being closed, or a returning ' +
      'resident arrives with every admission’s phases already discharged',
  );
  assert.match(
    archive[0],
    /isCurrent = 1/,
    'only the phases that are still current need retiring',
  );

  // The id has to be the *outgoing* admission, read before the new row is
  // written — otherwise it names the admission being created and retires nothing.
  assert.match(
    source,
    /const \[previousAdmissionRows\] = await connection\.query\([\s\S]{0,200}?ORDER BY admissionNumber DESC[\s\S]{0,80}?const previousAdmissionId = previousAdmissionRows\[0\]\?\.id/,
    'the archival must name the admission being closed, read before the new one is inserted',
  );
});

test('the legacy re-admission path leaves the same shape as the admissions form', () => {
  // `childController.readmit` is reachable at POST /api/children/:id/readmit. It
  // used to write previousCases entries with no admissionId and no
  // admissionNumber, and create no admissions row at all — the exact state that
  // makes the folder view fall back to timestamps and merge every admission.
  const source = read(path.join(BACKEND, 'controllers', 'childController.js'));

  const previousCaseInfo = source.match(/const previousCaseInfo = \{[\s\S]*?\n    \};/);
  assert.ok(previousCaseInfo, 'expected the previousCases entry the readmit path writes');
  assert.match(
    previousCaseInfo[0],
    /admissionId:/,
    'a previousCases entry with no admissionId cannot be matched to its admission',
  );
  assert.match(
    previousCaseInfo[0],
    /admissionNumber:/,
    'without an admissionNumber the folder view cannot number the period',
  );

  assert.match(
    source,
    /INSERT INTO admissions \(/,
    'the readmit path must create the admission row its documents will be linked to',
  );
  assert.match(
    source,
    /INSERT INTO phaseProgress \(id, residentId, admissionId,/,
    'the new phase must be anchored to the admission it belongs to',
  );
  assert.match(
    source,
    /ensureColumn|admissionId = \?[\s\S]*?OR admissionId IS NULL/,
    'the readmit phase archival must be scoped to the admission being closed',
  );
});

// ── The module that already split by admission must not disagree ───────────

test('PhaseProgress honours the admission link rather than only the timestamp', () => {
  // PhaseProgress keeps its own admission filter. It used to compare the
  // document's timestamp against the readmission cutoff and nothing else, so a
  // document filed under an earlier admission but uploaded today showed as
  // current — the same defect the folder view had.
  const source = read(path.join(FRONTEND, 'src', 'app', 'components', 'PhaseProgress.tsx'));

  assert.match(
    source,
    /admissionPeriodsFor/,
    'PhaseProgress must build the same period list the Documents folder splits on',
  );
  assert.match(
    source,
    /const linked = String\(d\.admissionId \?\? ''\)\.trim\(\);[\s\S]*?if \(linked\) return/,
    'a document with an admission link must be placed by that link, not by its date',
  );
  assert.match(
    source,
    /knownAdmissionIds\.has\(linked\)/,
    'a document filed under a previous admission is history and must be hidden',
  );
});

// ── A closed admission's documents are a historical record ────────────────
//
// Discharging a resident ends their admission: its files stay as they were and
// become the record of that stay. Enforced in the controller, not just by hiding
// buttons — the folder view is a convenience, not a control.

test('a closed admission refuses edits to its documents', () => {
  const source = read(path.join(BACKEND, 'controllers', 'documentController.js'));

  const guard = source.match(/async function assertAdmissionOpen\(document, action\)[\s\S]*?\n\}/);
  assert.ok(guard, 'expected the closed-admission guard');

  assert.match(
    guard[0],
    /FROM admissions WHERE id = \?/,
    'the guard must read the admission the document belongs to',
  );
  assert.match(
    guard[0],
    /admission\.status[\s\S]*?=== 'Active'[\s\S]*?return/,
    'an open admission must be allowed through, or nothing can ever be edited',
  );
  assert.match(
    guard[0],
    /new ApiError\(\s*409/,
    'a closed admission must be refused with a conflict, not a silent no-op',
  );
  assert.match(
    guard[0],
    /if \(!admissionId\) return;/,
    'a document with no admission link must not be locked — legacy rows have no admission to close',
  );
});

test('every write path to a document checks the admission is still open', () => {
  const source = read(path.join(BACKEND, 'controllers', 'documentController.js'));

  // Editing, deleting, approving, rejecting and resubmitting are all write paths
  // onto a document. Any one of them left unguarded is a way to rewrite the
  // record of a closed admission.
  const calls = source.match(/await assertAdmissionOpen\(/g) || [];
  assert.ok(
    calls.length >= 5,
    `only ${calls.length} write path(s) check the admission — edit, delete, ` +
      'approve, reject and resubmit must all be covered',
  );
});

test('the folder view marks a closed admission read-only', () => {
  const source = read(path.join(FRONTEND, 'src', 'app', 'components', 'DocumentUpload.tsx'));

  assert.match(
    source,
    /canApprove=\{canApprove && !admissionClosed\}/,
    'a closed admission must not offer the review actions',
  );
  assert.match(
    source,
    /canDelete=\{canDeleteDocuments && !admissionClosed\}/,
    'a closed admission must not offer delete',
  );
  assert.match(
    source,
    /!period\.isCurrent/,
    'the closed flag must come from the period, not from a page-level permission',
  );
});

// ── Every phase row carries its admission ──────────────────────────────────
//
// The scoped archival can only work if the rows it inspects have a link. A
// single insert that forgets `admissionId` writes a NULL row, and NULL rows are
// swept by the legacy per-resident fallback — so that row would be retired by
// whatever admission happens to close next, not by its own. This is a
// whole-codebase invariant, not a per-call-site detail.

test('every phaseProgress insert records the admission it belongs to', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs)$/.test(entry.name)) files.push(full);
    }
  };
  walk(BACKEND);

  const offenders = [];
  for (const file of files) {
    const source = read(file);

    // The admission intake form cannot set the link at insert time: the
    // `admissions` row it would point at is created afterwards, because the
    // admission id is only allocated once the resident exists. That path is
    // allowed to insert with a NULL link *provided* it anchors the rows
    // immediately after — so the exception is narrow and has to be earned.
    const anchorsAfterInsert = /UPDATE phaseProgress\s+SET admissionId = \?[\s\S]{0,120}?WHERE residentId = \?[\s\S]{0,60}?admissionId IS NULL/.test(source);

    for (const match of source.matchAll(/INSERT INTO phaseProgress\s*\(([^)]*)\)/gi)) {
      const columns = match[1];
      if (/\badmissionId\b/.test(columns)) continue;
      if (anchorsAfterInsert) continue;
      offenders.push(`${path.relative(BACKEND, file)} → (${columns.replace(/\s+/g, ' ').trim()})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these phaseProgress inserts leave admissionId NULL, so a later admission’s ' +
      `archival sweep would retire the row as its own:\n  ${offenders.join('\n  ')}`,
  );
});

test('the phase cleanup script refuses to run with returning residents on record', () => {
  // It groups rows by `phaseName` alone, so it treats a returning resident's
  // second "Admission Phase" row as a duplicate and deletes it — destroying the
  // phase history of every earlier admission. Guarded rather than deleted,
  // because it is still correct for a genuine single-admission database.
  const source = read(path.join(BACKEND, 'scripts', 'cleanupPhaseProgress.mjs'));

  assert.match(
    source,
    /isRepeatOffender = 1/,
    'the script must check for returning residents before deleting anything',
  );
  assert.match(
    source,
    /process\.exit\(1\)/,
    'it must refuse to run, not merely warn',
  );
  assert.match(
    source,
    /ALLOW_UNSAFE_PHASE_CLEANUP/,
    'there must be an explicit opt-in escape hatch',
  );
  assert.match(
    source,
    /`\$\{phase\.admissionId \|\| 'unlinked'\}::\$\{phase\.phaseName\}`/,
    'duplicates must be grouped per admission, not per resident',
  );
});
