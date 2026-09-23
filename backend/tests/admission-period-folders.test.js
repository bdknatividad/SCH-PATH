/**
 * Guards for the Documents module's admission-period folders, and for the end of
 * browser-generated dialogs across the workflow modules.
 *
 * Three things are pinned here:
 *
 * 1. A returning resident's documents are separated by admission. The resident
 *    keeps one `children` row; `POST /children/:id/readmit` pushes the closing
 *    case onto `previousCases[]` and overwrites `admissionDate`. Before this, the
 *    folder view showed one child folder holding every admission's files, so a
 *    resident admitted three times read as a single undated pile.
 * 2. The split rule agrees with `PhaseProgress.belongsToCurrentAdmission`, which
 *    is the module that already splits documents by admission. Two answers to
 *    "which admission is this file from" is how the two views start disagreeing.
 * 3. No workflow reports itself through `window.alert` / `confirm` / `prompt`.
 *    Those boxes are framed by the browser with the page's own origin — a staff
 *    member reading "localhost:5173 says…" is reading an implementation detail.
 *
 * The resolver is TypeScript and lives in the frontend, so it is loaded here by
 * transpiling it in memory with the frontend's own compiler. That is deliberate:
 * a source-level assertion cannot tell a correct date comparison from a broken
 * one, and the date comparison is the whole feature.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND = path.join(REPO_ROOT, 'frontend');
const RESOLVER = path.join(FRONTEND, 'src', 'utils', 'admissionPeriods.ts');
const COMPONENTS = path.join(FRONTEND, 'src', 'app', 'components');
const FOLDER_VIEW = path.join(COMPONENTS, 'DocumentUpload.tsx');

const read = (file) => fs.readFileSync(file, 'utf8');

// ── Loading the TypeScript resolver ────────────────────────────────────────
//
// `ts.transpileModule` is the same compiler the build uses, so the loaded module
// is the shipped logic rather than a re-implementation of it.

function loadResolver() {
  const tsPath = path.join(FRONTEND, 'node_modules', 'typescript');
  let ts;
  try {
    ts = require(tsPath);
  } catch (error) {
    throw new Error(
      `the frontend's TypeScript is required to load ${path.relative(REPO_ROOT, RESOLVER)}: ${error.message}`
    );
  }

  const { outputText } = ts.transpileModule(read(RESOLVER), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: RESOLVER,
  });

  const loaded = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(loaded, loaded.exports, require);
  return loaded.exports;
}

const { admissionPeriodsFor, admissionPeriodKeyFor } = loadResolver();

// ── Fixtures ───────────────────────────────────────────────────────────────

/**
 * A resident readmitted once: closed 12 Mar 2025 – 30 Jun 2025, open since 15
 * Jan 2026.
 *
 * The boundary is written without a zone so the expectation does not depend on
 * the machine's timezone. The stored value carries one, and the conversion is
 * covered on its own below.
 */
const READMITTED_ONCE = {
  admissionDate: '2026-01-15',
  readmissionDate: '2026-01-15',
  readmissionDatetime: '2026-01-15T09:20:00',
  previousCases: [{ offense: 'Theft', date: '2025-03-12', dischargeDate: '2025-06-30' }],
};

/** A resident readmitted twice. */
const READMITTED_TWICE = {
  admissionDate: '2026-05-04',
  readmissionDate: '2026-05-04',
  readmissionDatetime: '2026-05-04T08:00:00',
  previousCases: [
    { offense: 'Theft', date: '2024-02-01', dischargeDate: '2024-08-15' },
    { offense: 'Assault', date: '2025-03-12', dischargeDate: '2025-06-30' },
  ],
};

/** A resident admitted once and never readmitted. */
const FIRST_ADMISSION = {
  admissionDate: '2026-02-01',
  previousCases: [],
};

/**
 * The same two residents again, but in the shape the **intake form** actually
 * writes (`admissionController.create`): `admissionNumber` / `admissionDate` /
 * `closedDate`.
 *
 * This is the shape that reaches the browser from a real discharge-then-intake,
 * and the one the folder view must understand. The `date` / `dischargeDate`
 * spelling above is what `childController.readmit` writes; both are supported,
 * and a test below pins that they describe the same admissions.
 */
const INTAKE_READMITTED_ONCE = {
  admissionDate: '2026-01-15',
  readmissionDate: '2026-01-15',
  readmissionDatetime: '2026-01-15T09:20:00',
  previousCases: [
    {
      admissionNumber: 1,
      admissionDate: '2025-03-12',
      legalCategory: 'Court Diversion',
      specificOffense: 'Theft',
      caseHistory: '',
      closedDate: '2025-06-30',
    },
  ],
};

/** Three admissions in the intake shape, so the numbering has to continue. */
const INTAKE_READMITTED_TWICE = {
  admissionDate: '2026-05-04',
  readmissionDate: '2026-05-04',
  readmissionDatetime: '2026-05-04T08:00:00',
  previousCases: [
    { admissionNumber: 1, admissionDate: '2024-02-01', closedDate: '2024-08-15' },
    { admissionNumber: 2, admissionDate: '2025-03-12', closedDate: '2025-06-30' },
  ],
};

// ── The period list ────────────────────────────────────────────────────────

test('a resident with no readmission on record gets no period folders', () => {
  assert.deepEqual(admissionPeriodsFor(FIRST_ADMISSION), []);
  assert.deepEqual(admissionPeriodsFor({}), []);
  assert.deepEqual(admissionPeriodsFor(null), []);
  assert.deepEqual(admissionPeriodsFor(undefined), []);
  // A missing `previousCases` is the same as an empty one — older rows have no
  // column at all, and they must not be read as a returning resident.
  assert.deepEqual(admissionPeriodsFor({ admissionDate: '2026-02-01' }), []);
});

test('one closed admission produces a Previous folder and a Current folder', () => {
  const periods = admissionPeriodsFor(READMITTED_ONCE);

  assert.equal(periods.length, 2, 'a readmitted resident must get exactly two period folders');
  assert.deepEqual(
    periods.map((period) => period.label),
    ['Previous Admission Records', 'Current Admission Records'],
  );
  assert.deepEqual(
    periods.map((period) => period.isCurrent),
    [false, true],
  );
  assert.deepEqual(
    periods.map((period) => period.admissionNumber),
    [1, 2],
  );
  assert.equal(periods[0].startDate, '2025-03-12');
  assert.equal(periods[0].endDate, '2025-06-30');
  assert.equal(periods[1].startDate, '2026-01-15');
  assert.equal(periods[1].endDate, null, 'the open admission has no end date');
});

test('two closed admissions produce three numbered folders, oldest first', () => {
  const periods = admissionPeriodsFor(READMITTED_TWICE);

  assert.equal(periods.length, 3);
  assert.deepEqual(
    periods.map((period) => period.label),
    [
      'Previous Admission Records — Admission 1',
      'Previous Admission Records — Admission 2',
      'Current Admission Records',
    ],
  );
  assert.deepEqual(
    periods.map((period) => period.admissionNumber),
    [1, 2, 3],
  );
  // Chronological, so the reader meets the admissions in the order they happened.
  assert.deepEqual(
    periods.map((period) => period.startDate),
    ['2024-02-01', '2025-03-12', '2026-05-04'],
  );
});

test('each period folder says which dates it covers', () => {
  const [previous, current] = admissionPeriodsFor(READMITTED_ONCE);

  assert.equal(previous.rangeLabel, '12 Mar 2025 – 30 Jun 2025');
  assert.equal(current.rangeLabel, '15 Jan 2026 – present', 'an open admission reads as "present"');
  // The range is read from the stored date text, never through `Date`, so a
  // timezone can never shift a folder heading by a day.
  assert.equal(admissionPeriodsFor({ admissionDate: '2026-01-15', previousCases: [{ date: '2025-01-01' }] })[0].rangeLabel, '1 Jan 2025 – present');
});

test('period keys are stable and unique', () => {
  const periods = admissionPeriodsFor(READMITTED_TWICE);
  assert.deepEqual(
    periods.map((period) => period.key),
    ['admission-1', 'admission-2', 'admission-3'],
  );
  assert.equal(new Set(periods.map((period) => period.key)).size, periods.length);
});

// ── The shape the intake form actually writes ──────────────────────────────

test('the intake form\'s own field names are understood', () => {
  const periods = admissionPeriodsFor(INTAKE_READMITTED_ONCE);
  assert.equal(
    periods.length,
    2,
    'a returning resident created through the intake form produced no split, so both intakes ' +
      'would be merged into one folder again',
  );
  const [previous, current] = periods;
  assert.equal(previous.label, 'Previous Admission Records');
  assert.equal(previous.startDate, '2025-03-12');
  assert.equal(previous.endDate, '2025-06-30');
  assert.equal(previous.rangeLabel, '12 Mar 2025 – 30 Jun 2025');
  assert.equal(previous.isCurrent, false);
  assert.equal(current.label, 'Current Admission Records');
  assert.equal(current.startDate, '2026-01-15');
  assert.equal(current.isCurrent, true);
});

test('the two spellings of the history describe the same admissions', () => {
  // `admissionController.create` writes admissionDate/closedDate and
  // `childController.readmit` writes date/dischargeDate. A record made through
  // either route must produce the same folders, or the split would depend on
  // which form was used.
  assert.deepEqual(admissionPeriodsFor(INTAKE_READMITTED_ONCE), admissionPeriodsFor(READMITTED_ONCE));
  assert.deepEqual(admissionPeriodsFor(INTAKE_READMITTED_TWICE), admissionPeriodsFor(READMITTED_TWICE));
});

test('the open admission continues the numbering the record already uses', () => {
  const periods = admissionPeriodsFor(INTAKE_READMITTED_TWICE);
  assert.deepEqual(periods.map((period) => period.admissionNumber), [1, 2, 3]);
  assert.deepEqual(periods.map((period) => period.key), ['admission-1', 'admission-2', 'admission-3']);
  assert.equal(periods[0].label, 'Previous Admission Records — Admission 1');
  assert.equal(periods[1].label, 'Previous Admission Records — Admission 2');
  assert.equal(periods[2].label, 'Current Admission Records');
});

test('an admission the summary never recorded still cannot renumber the open one', () => {
  // An older build replaced previousCases with only the latest admission, so a
  // resident's third intake could arrive with admissionNumber 2 alone. The open
  // admission must still be numbered after it rather than colliding with it.
  const periods = admissionPeriodsFor({
    admissionDate: '2026-07-01',
    readmissionDate: '2026-07-01',
    previousCases: [{ admissionNumber: 2, admissionDate: '2025-09-09', closedDate: '2026-01-01' }],
  });
  assert.equal(periods.length, 2);
  assert.equal(periods[0].key, 'admission-2');
  assert.equal(periods[1].key, 'admission-3');
  assert.equal(periods[1].isCurrent, true);
});

// ── The history the server keeps ───────────────────────────────────────────

test('a re-intake keeps every earlier admission, not just the latest', () => {
  const source = read(path.join(REPO_ROOT, 'backend', 'src', 'controllers', 'admissionController.js'));
  const start = source.indexOf('async function create');
  assert.ok(start > 0, 'admissionController.create is gone');
  const body = source.slice(start, source.indexOf('async function update', start));

  assert.match(
    body,
    /FROM admissions[\s\S]{0,300}?admissionNumber < \?/,
    'previousCases is built from the latest admission only, so a third intake would erase the second ' +
      'and its documents would have no period to belong to',
  );
  assert.match(
    body,
    /closedDate: row\.closedDate \|\| admission\.admissionDate/,
    'the closing date is no longer taken from the admission row, with a fallback for one never closed',
  );
  assert.doesNotMatch(
    body,
    /closedDate: new Date\(\)/,
    'the closing date is stamped as "today" rather than read from the admission that is closing',
  );
});

// ── The admission link on the document ─────────────────────────────────────

/**
 * The same two-admission resident, but with the admission ids the intake form
 * now carries through into `previousCases`.
 */
const LINKED_TWICE = {
  admissionDate: '2026-05-04',
  readmissionDate: '2026-05-04',
  readmissionDatetime: '2026-05-04T08:00:00',
  previousCases: [
    { admissionId: 'ADM-A', admissionNumber: 1, admissionDate: '2024-02-01', closedDate: '2024-08-15' },
    { admissionId: 'ADM-B', admissionNumber: 2, admissionDate: '2025-03-12', closedDate: '2025-06-30' },
  ],
};

test('a period carries the admission id it stands for', () => {
  const periods = admissionPeriodsFor(LINKED_TWICE);
  assert.deepEqual(periods.map((period) => period.admissionId), ['ADM-A', 'ADM-B', '']);
});

test('a document goes to the admission it is linked to, whatever its date', () => {
  const periods = admissionPeriodsFor(LINKED_TWICE);
  // The link is the record of where the file was produced, so a stray timestamp
  // cannot move it out of the admission it belongs to.
  assert.equal(
    admissionPeriodKeyFor({ admissionId: 'ADM-A', uploadedAt: '2026-04-01' }, periods),
    'admission-1',
  );
  assert.equal(
    admissionPeriodKeyFor({ admissionId: 'ADM-B', uploadedAt: '2024-03-01' }, periods),
    'admission-2',
  );
});

test('two admissions on the same day are separated by the link', () => {
  // The case no timestamp can decide: both admissions open and close on the same
  // date, and the two documents even share a title. Only the stored admission id
  // tells them apart.
  const sameDay = {
    admissionDate: '2026-09-22',
    readmissionDate: '2026-09-22',
    readmissionDatetime: '2026-09-22T14:11:15',
    previousCases: [
      { admissionId: 'ADM-1', admissionNumber: 1, admissionDate: '2026-09-22', closedDate: '2026-09-22' },
    ],
  };
  const periods = admissionPeriodsFor(sameDay);
  assert.equal(
    admissionPeriodKeyFor({ admissionId: 'ADM-1', uploadedAt: '2026-09-22T14:06:44' }, periods),
    'admission-1',
  );
  assert.equal(
    admissionPeriodKeyFor({ admissionId: 'ADM-2', uploadedAt: '2026-09-22T14:11:15' }, periods),
    'admission-2',
  );
});

test('a document linked to an admission the record does not name is current', () => {
  const periods = admissionPeriodsFor(LINKED_TWICE);
  assert.equal(
    admissionPeriodKeyFor({ admissionId: 'ADM-OPEN', uploadedAt: '2020-01-01' }, periods),
    'admission-3',
  );
});

test('a link with nothing to match against falls back to the timestamp', () => {
  // `previousCases` written before it carried admission ids. The periods name no
  // admission, so the link cannot be resolved — and an unresolvable link must not
  // be read as "the current admission", which would sweep every earlier
  // admission's files into the open folder. The timestamp decides instead.
  const periods = admissionPeriodsFor(READMITTED_TWICE);
  assert.equal(
    periods.every((period) => period.admissionId === ''),
    true,
    'the fixture is meant to have no admission ids',
  );
  assert.equal(
    admissionPeriodKeyFor(
      { admissionId: 'ADM-UNKNOWN', uploadedAt: '2024-03-01' },
      periods,
      READMITTED_TWICE.readmissionDatetime,
    ),
    'admission-1',
    'an unresolvable link was treated as the current admission',
  );
});

test('a document with no link at all still uses its timestamp', () => {
  const periods = admissionPeriodsFor(LINKED_TWICE);
  assert.equal(admissionPeriodKeyFor({ uploadedAt: '2024-03-01' }, periods), 'admission-1');
  assert.equal(admissionPeriodKeyFor({ uploadedAt: '2026-05-05' }, periods), 'admission-3');
});

// ── Linking at creation time ───────────────────────────────────────────────

test('the Documents module links every upload to the active admission', () => {
  const source = read(path.join(REPO_ROOT, 'backend', 'src', 'controllers', 'documentController.js'));
  assert.match(
    source,
    /activeAdmissionIdFor\(pool, data\.residentId\)/,
    'an upload is no longer linked to the resident\'s admission',
  );
  assert.match(source, /columns\.push\('admissionId'\)/, 'the admission column is not written on insert');
  assert.match(
    source,
    /col !== 'admissionId'/,
    'the admission is taken from the request, so a client could file a document into a closed admission',
  );
});

test('every publishing module links the document it files to an admission', () => {
  const publishers = [
    'triController.js',
    'anecdotalReportController.js',
    'quarterlyProgressReportController.js',
    'healthController.js',
    'incidentReportController.js',
  ];
  for (const file of publishers) {
    const source = read(path.join(REPO_ROOT, 'backend', 'src', 'controllers', file));
    assert.match(
      source,
      /require\('\.\.\/services\/admissionLink'\)/,
      `${file}: does not use the shared admission resolver`,
    );
    assert.match(source, /activeAdmissionIdFor\(/, `${file}: does not resolve an admission`);
    const at = source.indexOf('INSERT INTO documents');
    assert.ok(at > 0, `${file}: no document insert found`);
    assert.match(
      source.slice(at, at + 700),
      /admissionId/,
      `${file}: the published document is not linked to an admission`,
    );
  }
});

test('the resident record names the admission each closed period stands for', () => {
  const source = read(path.join(REPO_ROOT, 'backend', 'src', 'controllers', 'admissionController.js'));
  const start = source.indexOf('async function create');
  const body = source.slice(start, source.indexOf('async function update', start));
  assert.match(
    body,
    /admissionId: row\.id/,
    'previousCases no longer carries the admission id, so the folder view cannot match a document to its period',
  );
});

test('a document cannot be moved to another admission after it is filed', () => {
  // Requirement: a document produced during an earlier admission stays in that
  // admission's folder. `update` spreads the request body, so without this the
  // link would be writable through a plain PUT.
  const source = read(path.join(REPO_ROOT, 'backend', 'src', 'controllers', 'documentController.js'));
  const at = source.indexOf('async function update');
  assert.ok(at > 0, 'documentController.update is gone');
  const body = source.slice(at, source.indexOf('async function ', at + 20));
  assert.match(
    body,
    /delete req\.body\.admissionId/,
    'a PUT can move a document out of the admission it was filed under',
  );
});

// ── Placing a document in a period ─────────────────────────────────────────

const PERIODS = admissionPeriodsFor(READMITTED_ONCE);
const BOUNDARY = READMITTED_ONCE.readmissionDatetime;

const keyFor = (uploadedAt, boundary = BOUNDARY) => admissionPeriodKeyFor({ uploadedAt }, PERIODS, boundary);

test('a single-admission resident is never grouped', () => {
  assert.equal(admissionPeriodKeyFor({ uploadedAt: '2026-02-02' }, []), null);
  assert.equal(admissionPeriodKeyFor({ uploadedAt: '2026-02-02' }, admissionPeriodsFor(FIRST_ADMISSION)), null);
  assert.equal(
    admissionPeriodKeyFor({ uploadedAt: '2026-02-02' }, [admissionPeriodsFor(READMITTED_ONCE)[1]]),
    null,
    'one period is not a grouping',
  );
});

test('a document filed during the closed admission stays with it', () => {
  assert.equal(keyFor('2025-04-02 10:00:00'), 'admission-1');
  assert.equal(keyFor('2025-06-30 23:59:59'), 'admission-1', 'the last day of the admission is still that admission');
  // Uploaded after the discharge date but before the resident came back: the
  // admission it was made under is still the closed one.
  assert.equal(keyFor('2025-09-01 12:00:00'), 'admission-1');
});

test('a document filed during the open admission is current', () => {
  assert.equal(keyFor('2026-01-16 08:00:00'), 'admission-2');
  assert.equal(keyFor('2026-09-22 20:00:00'), 'admission-2');
});

test('a document dated before the first admission belongs to the first admission', () => {
  assert.equal(keyFor('2024-12-01 09:00:00'), 'admission-1');
  // A legacy row with no timestamp at all is old by definition — `PhaseProgress`
  // reads it the same way, and a file must not be shown as current on a guess.
  assert.equal(admissionPeriodKeyFor({}, PERIODS, BOUNDARY), 'admission-1');
  assert.equal(admissionPeriodKeyFor({ uploadedAt: '' }, PERIODS, BOUNDARY), 'admission-1');
  assert.equal(admissionPeriodKeyFor({ uploadedAt: 'not a date' }, PERIODS, BOUNDARY), 'admission-1');
});

test('the readmission timestamp decides a same-day upload', () => {
  // Uploaded on the day the resident came back, before the admission was
  // recorded: it belongs to the admission that was closing.
  assert.equal(keyFor('2026-01-15 06:00:00'), 'admission-1');
  // After it: the new admission.
  assert.equal(keyFor('2026-01-15 14:00:00'), 'admission-2');
  // Exactly on the boundary counts as the new admission.
  assert.equal(keyFor('2026-01-15 09:20:00'), 'admission-2');
  // A timestamp written with a space instead of a T is normalised first.
  assert.equal(keyFor('2026-01-15 06:00:00'), keyFor('2026-01-15T06:00:00'));
});

test('a boundary stored in UTC is shifted to local time before it is compared', () => {
  // `readmissionDatetime` is written with `toISOString()`, so it arrives with a
  // zone and milliseconds while a document's `uploadedAt` is already local. The
  // boundary has to be converted, or it sits hours away from the files it
  // divides — and its extra characters alone would make it sort as "later".
  const utc = '2026-01-15T09:20:00.000Z';
  const local = new Date(utc);
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

  const localStamp = fmt(local);
  const before = fmt(new Date(local.getTime() - 60000));
  const after = fmt(new Date(local.getTime() + 60000));

  assert.equal(keyFor(before, utc), 'admission-1', 'a file uploaded before the readmission is still the previous admission');
  assert.equal(keyFor(localStamp, utc), 'admission-2', 'a file uploaded at the readmission instant is the new admission');
  assert.equal(keyFor(after, utc), 'admission-2');

  // The extra characters on their own must not decide it: without the
  // conversion, `'…09:20:00' >= '…09:20:00.000Z'` is false and the file would be
  // filed against the admission that had just closed.
  assert.equal(keyFor(localStamp, utc), keyFor(localStamp, '2026-01-15T09:20:00'), 'the zone must not change the answer');
});

test('with no timestamp on record, a same-day upload stays with the closing admission', () => {
  // `PhaseProgress` falls back to a strict `>` comparison when only a date is
  // known, so a same-day file is not claimed by the new admission.
  assert.equal(keyFor('2026-01-15', ''), 'admission-1');
  // Strictly after the boundary day is the new admission.
  assert.equal(keyFor('2026-01-16', ''), 'admission-2');
});

test('a middle admission is reachable when there are more than two', () => {
  const periods = admissionPeriodsFor(READMITTED_TWICE);
  const boundary = READMITTED_TWICE.readmissionDatetime;
  const middle = (uploadedAt) => admissionPeriodKeyFor({ uploadedAt }, periods, boundary);

  assert.equal(middle('2024-05-01 10:00:00'), 'admission-1');
  assert.equal(middle('2025-03-12 00:00:00'), 'admission-2', 'a file on the boundary day joins the later admission');
  assert.equal(middle('2025-05-01 10:00:00'), 'admission-2');
  assert.equal(middle('2025-06-30 23:00:00'), 'admission-2');
  assert.equal(middle('2025-07-01 00:00:00'), 'admission-2', 'a gap after a discharge still belongs to the admission that closed');
  assert.equal(middle('2026-05-04 09:00:00'), 'admission-3');
  assert.equal(middle('2026-06-01 09:00:00'), 'admission-3');
});

test('every document lands in exactly one period', () => {
  const periods = admissionPeriodsFor(READMITTED_TWICE);
  const stamps = [
    '2024-02-01 00:00:00', '2024-08-15 12:00:00', '2025-03-11 23:59:59',
    '2025-03-12 00:00:00', '2025-06-30 23:59:59', '2025-12-31 00:00:00',
    '2026-05-04 07:59:59', '2026-05-04 08:00:00', '2026-09-22 20:00:00',
  ];
  const keys = new Set(periods.map((period) => period.key));

  for (const stamp of stamps) {
    const key = admissionPeriodKeyFor({ uploadedAt: stamp }, periods, READMITTED_TWICE.readmissionDatetime);
    assert.ok(keys.has(key), `${stamp} was placed in "${key}", which is not one of the folders`);
  }

  // And no file is lost: the four buckets together hold every stamp.
  const placed = stamps.map((stamp) => admissionPeriodKeyFor({ uploadedAt: stamp }, periods, READMITTED_TWICE.readmissionDatetime));
  assert.equal(placed.length, stamps.length);
  assert.deepEqual(
    periods.map((period) => placed.filter((key) => key === period.key).length),
    [3, 4, 2],
    'the three admissions hold 3, 4 and 2 of the nine stamps',
  );
});

test('a document falls back to createdAt when it was never stamped as uploaded', () => {
  assert.equal(admissionPeriodKeyFor({ createdAt: '2025-05-05 10:00:00' }, PERIODS, BOUNDARY), 'admission-1');
  assert.equal(admissionPeriodKeyFor({ createdAt: '2026-02-05 10:00:00' }, PERIODS, BOUNDARY), 'admission-2');
  // uploadedAt wins when both are present.
  assert.equal(
    admissionPeriodKeyFor({ uploadedAt: '2026-02-05 10:00:00', createdAt: '2025-05-05 10:00:00' }, PERIODS, BOUNDARY),
    'admission-2',
  );
});

// ── The split rule must not drift from PhaseProgress ───────────────────────

test('the split rule is the one PhaseProgress already applies', () => {
  const phaseProgress = read(path.join(COMPONENTS, 'PhaseProgress.tsx'));

  assert.match(phaseProgress, /const docCutoffDatetime = currentChildRecord\?\.readmissionDatetime/, 'PhaseProgress no longer splits on readmissionDatetime');
  assert.match(phaseProgress, /return docDT >= docCutoffDatetime;/, 'PhaseProgress no longer compares the full timestamp');
  assert.match(phaseProgress, /return d\.uploadedAt\.substring\(0, 10\) > docCutoffDate;/, 'PhaseProgress no longer falls back to a strict date comparison');

  // The resolver documents that it is following that rule, so the next person to
  // change one is pointed at the other.
  assert.match(read(RESOLVER), /PhaseProgress/, 'the resolver no longer says which rule it mirrors');

  // And it really behaves that way — the same three outcomes, asserted directly.
  assert.equal(keyFor('2026-01-15 06:00:00'), 'admission-1');
  assert.equal(keyFor('2026-01-15 14:00:00'), 'admission-2');
  assert.equal(keyFor('2026-01-15', ''), 'admission-1');
});

// ── The folder view ────────────────────────────────────────────────────────

test('the folder view reads the admission history from the resident row', () => {
  const source = read(FOLDER_VIEW);

  assert.match(
    source,
    /import \{ admissionPeriodKeyFor, admissionPeriodsFor \} from '@\/utils\/admissionPeriods'/,
    'the folder view no longer uses the shared admission-period resolver',
  );
  assert.match(
    source,
    /const historyRow = residents\.find\(r => Array\.isArray\(r\.previousCases\) && r\.previousCases\.length > 0\)/,
    'the folder view no longer finds the row that carries the admission history',
  );
  assert.match(source, /const periods = admissionPeriodsFor\(historyRow\)/, 'the periods are no longer derived from the resident');
  assert.match(source, /const splitByAdmission = periods\.length > 1/, 'a single admission must not be grouped');
});

test('the period headings come from the resolver, not from the component', () => {
  const source = read(FOLDER_VIEW);

  // The labels are the resolver's, so they cannot drift from the periods.
  assert.doesNotMatch(
    source,
    /'Current Admission Records'|"Current Admission Records"/,
    'the folder view hardcodes a period label instead of using the resolver\'s',
  );
  assert.doesNotMatch(
    source,
    /'Previous Admission Records'|"Previous Admission Records"/,
    'the folder view hardcodes a period label instead of using the resolver\'s',
  );
  assert.match(source, /\{period\.label\}/, 'the period heading is no longer rendered from the resolver');
  assert.match(source, /\{period\.rangeLabel\}/, 'the period no longer shows which dates it covers');
});

test('every document is placed in exactly one period folder', () => {
  const source = read(FOLDER_VIEW);

  assert.match(
    source,
    /admissionPeriodKeyFor\(d, periods, historyRow\?\.readmissionDatetime\) === period\.key/,
    'the folder view no longer matches a document to a period by the shared rule',
  );
  // The same document list feeds both paths, so nothing is dropped by the split.
  assert.match(source, /const allDocs = visibleDocs\.filter/, 'the folder view no longer collects the resident\'s documents once');
  assert.match(source, /const flatGroups = splitByAdmission \? \[\] : groupByCategory\(allDocs\)/, 'the flat path no longer shares the same document list');
});

test('the Child → Category → File structure is the same inside a period', () => {
  const source = read(FOLDER_VIEW);

  // One renderer, used by both levels: the category folder cannot look or behave
  // differently depending on whether it hangs off a child or off an admission.
  assert.match(source, /const renderCategoryFolder = \(/, 'the category folder renderer was removed');
  // Both call sites are matched on the key they pass and the folder they pass,
  // not on the literal argument list. The renderer has since grown a trailing
  // `admissionOrdinal` argument, and pinning the old three-argument text made
  // this test fail against correct code — it asserted a calling convention
  // rather than the sharing it exists to protect.
  assert.match(
    source,
    /renderCategoryFolder\(\s*periodKey,\s*folder,\s*folderDocs\b/,
    'a period no longer renders category folders'
  );
  assert.match(
    source,
    /renderCategoryFolder\(\s*nameKey,\s*folder,\s*folderDocs\b/,
    'a single-admission resident no longer renders category folders'
  );
  // And the child-level count still reads correctly in both modes.
  assert.match(source, /splitByAdmission\s*\?\s*`\$\{periods\.length\} admissions/, 'the child header no longer counts admissions for a returning resident');
});

test('period folders are open by default, child folders are not', () => {
  const source = read(FOLDER_VIEW);

  // The period level exists to make a file's admission visible; collapsing it
  // would hide exactly the fact it was added to show.
  assert.match(source, /expandedPeriods\[periodKey\] \?\? true/, 'period folders no longer default to open');
  // The child folder still starts closed — the tree is an index of residents.
  assert.match(source, /expandedChildren\[nameKey\] \?\? false/, 'child folders no longer default to closed');
});

test('both admissions stay readable — no period is filtered out', () => {
  const source = read(FOLDER_VIEW);
  const block = source.slice(source.indexOf('const periodGroups'), source.indexOf('const flatGroups'));

  // Every period is rendered, including one with nothing filed in it: an
  // admission that exists but produced no files is a fact about the record.
  assert.match(block, /periods\.map\(period => \(\{/, 'the folder view no longer renders every admission');
  assert.doesNotMatch(block, /periods\.filter\(/, 'a period is being dropped — a previous admission must not disappear');
  assert.doesNotMatch(block, /\.slice\(0,/, 'only some admissions are being shown');
  assert.match(source, /No documents filed for this admission\./, 'an empty period no longer says so');
});

// ── No browser dialogs ─────────────────────────────────────────────────────

/** The modules whose workflows must report through the system dialog. */
const WORKFLOW_MODULES = [
  'Tri.tsx',
  'AnecdotalReports.tsx',
  'AnecdotalReport.tsx',
  'Reports.tsx',
  'DocumentUpload.tsx',
  'Health.tsx',
  'Violations.tsx',
  'InterventionTracker.tsx',
  'PhaseProgress.tsx',
  'ChildDetail.tsx',
  'ChildRecords.tsx',
  'Activities.tsx',
  'Assessments.tsx',
  'EvaluationForm.tsx',
  'CourtRecords.tsx',
  'SocialWorker.tsx',
  'SystemEvaluation.tsx',
  'ViolationGuide.tsx',
];

/** Lines that are prose, not code. */
const isComment = (line) => {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
};

test('no workflow module opens a browser alert, confirm or prompt', () => {
  const offenders = [];

  for (const name of WORKFLOW_MODULES) {
    const lines = read(path.join(COMPONENTS, name)).split('\n');
    lines.forEach((line, index) => {
      if (isComment(line)) return;
      if (/(?:^|[^.\w])(?:window\.)?(?:alert|confirm|prompt)\s*\(/.test(line)) {
        offenders.push(`${name}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `a browser dialog is back — it is framed with the page's origin ("localhost:5173 says…"):\n${offenders.join('\n')}`,
  );
});

test('nothing in the frontend renders a localhost reference', () => {
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      read(full).split('\n').forEach((line, index) => {
        if (isComment(line)) return;
        if (/localhost|127\.0\.0\.1/.test(line)) {
          offenders.push(`${path.relative(FRONTEND, full)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  };

  walk(path.join(FRONTEND, 'src'));
  assert.deepEqual(offenders, [], `a user-facing localhost reference was added:\n${offenders.join('\n')}`);
});

test('the workflow modules report through the system dialog', () => {
  for (const name of WORKFLOW_MODULES) {
    const source = read(path.join(COMPONENTS, name));
    assert.match(
      source,
      /from '@\/app\/components\/SystemDialog'|from '\.\/SystemDialog'/,
      `${name} no longer imports the system dialog`,
    );
    assert.match(
      source,
      /systemDialog\.|dialog\.(?:confirm|notify|success|failure|validation)\(/,
      `${name} imports the dialog but never reports through it`,
    );
  }
});

test('a failure is described in a sentence, not printed raw', () => {
  const api = read(path.join(FRONTEND, 'src', 'services', 'api.ts'));

  assert.match(api, /export function describeError/, 'the error describer was removed');
  assert.match(api, /NETWORK_NOISE/, 'the network-noise list was removed — "Failed to fetch" would reach a dialog');
  assert.match(api, /Could not reach the server/, 'the network failure no longer has a sentence of its own');

  // The transport strings that must never be shown.
  for (const noise of ['failed to fetch', 'load failed', 'networkerror']) {
    assert.match(api, new RegExp(`'${noise}'`), `describeError no longer recognises "${noise}"`);
  }
});

test('the dialogs are one component, mounted once', () => {
  const app = read(path.join(FRONTEND, 'src', 'app', 'App.tsx'));
  const dialog = read(path.join(COMPONENTS, 'SystemDialog.tsx'));

  assert.match(app, /<SystemDialogProvider>/, 'the dialog layer is no longer mounted at the app root');
  assert.match(app, /<\/SystemDialogProvider>/, 'the dialog layer is not closed');
  assert.match(dialog, /export function useSystemDialog/, 'the hook is gone');
  assert.match(dialog, /export const systemDialog/, 'the module-level handle is gone');
  assert.match(dialog, /systemDialogHandler = open/, 'the provider no longer publishes the implementation');

  // Four outcomes, as the module's contract requires.
  for (const kind of ['confirm', 'notify', 'success', 'failure', 'validation']) {
    assert.match(dialog, new RegExp(`\\b${kind}:`), `the dialog no longer offers ${kind}()`);
  }
  // Every tone is styled, so a success cannot render as an error.
  for (const tone of ['success', 'error', 'warning', 'info']) {
    assert.match(dialog, new RegExp(`${tone}: \\{`), `the ${tone} tone is gone`);
  }
});

test('the app-level error screen does not print the exception', () => {
  const app = read(path.join(FRONTEND, 'src', 'app', 'App.tsx'));
  // Comments stripped: the note explaining what this screen used to do names
  // `error.message`, and matching that would defeat the check.
  const boundary = app
    .slice(app.indexOf('class ErrorBoundary'), app.indexOf('export default function App'))
    .split('\n')
    .filter((line) => !isComment(line))
    .join('\n');

  assert.doesNotMatch(boundary, /<pre>/, 'the raw error text is rendered again');
  assert.doesNotMatch(boundary, /error\?\.message|error\.message/, 'the exception message is rendered again');
  assert.doesNotMatch(boundary, /May Error sa Component/, 'the old developer-facing heading is back');
  // The console still gets it, which is where a stack belongs.
  assert.match(boundary, /componentDidCatch/, 'the error is no longer logged for whoever is debugging');
});

// ── The actions the workflow has to cover ──────────────────────────────────

test('every TRI transition asks before it acts and reports afterwards', () => {
  const source = read(path.join(COMPONENTS, 'Tri.tsx'));

  // Submit.
  assert.match(source, /title: 'Submit this TRI for review\?'/, 'submitting a TRI no longer asks first');
  assert.match(source, /'TRI submitted for review\.'/, 'submitting a TRI no longer confirms it');
  // Return for revision.
  assert.match(source, /'TRI returned for revision\.'/, 'returning a TRI no longer confirms it');
  // Approve.
  assert.match(source, /'TRI approved\.'/, 'approving a TRI no longer confirms it');
  // Save draft.
  assert.match(source, /'Draft saved\.'/, 'saving a TRI draft no longer confirms it');
  // And a failure is reported for each of them.
  assert.match(source, /'Could not submit the TRI'/, 'a failed submit is no longer reported');
  assert.match(source, /'Could not return the TRI'/, 'a failed return is no longer reported');
  assert.match(source, /'Could not approve the TRI'/, 'a failed approve is no longer reported');
  assert.match(source, /'Could not save the draft'/, 'a failed save is no longer reported');
  // The export helper reports through its caller rather than a browser box.
  assert.match(source, /onError\?: \(message: string\) => void/, 'the export helper lost its error reporter');
});

test('every Anecdotal Report transition asks before it acts and reports afterwards', () => {
  const list = read(path.join(COMPONENTS, 'AnecdotalReports.tsx'));
  const editor = read(path.join(COMPONENTS, 'AnecdotalReport.tsx'));

  // Save draft and submit.
  assert.match(list, /'Draft saved\.'/, 'saving an anecdotal draft no longer confirms it');
  assert.match(list, /'Anecdotal Report submitted\.'/, 'submitting an anecdotal report no longer confirms it');
  // Return for revision — with the notes in a real form.
  assert.match(list, /'Report returned for revision\.'/, 'returning an anecdotal report no longer confirms it');
  assert.match(editor, /'Report returned for revision\.'/, 'the editor no longer confirms a return');
  assert.match(editor, /Review notes <span className="text-red-500">\*<\/span>/, 'the return notes are no longer a required field');
  assert.match(editor, /onClick=\{confirmReturn\}/, 'the return no longer goes through the notes form');
  assert.doesNotMatch(editor, /Review notes required for return/, 'the browser prompt string is back');
  // Approve.
  assert.match(list, /title: 'Approve this Anecdotal Report\?'/, 'approving an anecdotal report no longer asks first');
  assert.match(list, /'Anecdotal Report approved\.'/, 'approving no longer confirms it');
  assert.match(editor, /'Anecdotal Report approved\.'/, 'the editor no longer confirms an approval');
});

test('every document approval outcome reports its result', () => {
  const source = read(path.join(COMPONENTS, 'DocumentUpload.tsx'));

  // Approve, from the row and from the review dialog.
  assert.match(source, /title: 'Approve this document\?'/, 'approving a document no longer asks first');
  assert.match(source, /'Document approved\.'/, 'approving a document no longer confirms it');
  assert.match(source, /'Document rejected\.'/, 'rejecting a document no longer confirms it');
  assert.match(source, /'Document sent for reassessment\.'/, 'a reassessment is no longer confirmed');
  // And they go through the endpoints that keep the audit trail and notify the
  // submitter, rather than PUT-ing the fields from the browser.
  assert.match(source, /request\(`\/documents\/\$\{document\.id\}\/approve`, \{ method: 'POST' \}\)/, 'approving no longer uses the approve endpoint');
  assert.match(source, /request\(`\/documents\/\$\{document\.id\}\/reject`, \{/, 'rejecting no longer uses the reject endpoint');
  // A rejection with no reason is refused before the request, not by a 400.
  assert.match(source, /dialog\.validation\('Add a reason for the rejection'/, 'a reasonless rejection is no longer caught in the form');
  assert.match(source, /dialog\.validation\('Add a note for the submitter'/, 'a reasonless review decision is no longer caught in the form');
});

test('the Reports module reports the same way as the modules it reviews', () => {
  const source = read(path.join(COMPONENTS, 'Reports.tsx'));

  assert.match(source, /title: 'Approve this TRI\?'/, 'the TRI review queue no longer asks before approving');
  assert.match(source, /'TRI approved\.'/, 'the TRI review queue no longer confirms an approval');
  assert.match(source, /'TRI returned for revision\.'/, 'the TRI review queue no longer confirms a return');
  assert.match(source, /title: 'Some required monthly documents are missing'/, 'the missing-document check is no longer a dialog');
  assert.match(source, /items: missing/, 'the missing documents are no longer listed in the dialog');
  // The monthly package's own error path names no exception.
  assert.match(source, /describeError\(error, 'The report could not be generated/, 'the report generator prints a raw failure again');
});
