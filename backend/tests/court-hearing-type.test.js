/**
 * Item 7 — the Court Records hearing type.
 *
 * The dropdown offered "Sentencing". A criminal case in the Philippines is not
 * *sentenced*; the judgment is **promulgated** (Rule 120, Rules of Court). The
 * option is now "Promulgation of Judgement".
 *
 * The rename is cheap to guard because `hearingType` is free text:
 *
 *   - the column is `VARCHAR(100) NULL` in both `server.js` and `schema.sql`,
 *   - there is no `ENUM`, no `CHECK` and no lookup table anywhere,
 *   - every reader renders `record.hearingType` verbatim.
 *
 * So the label can only ever be a string literal in the UI, which makes the
 * guard total rather than spot: the new wording must be the option offered, and
 * the old wording must appear in **no** source file. A future "helpful" label
 * map at a render site is the one way the old name could come back, so the four
 * display sites are pinned to the raw value as well.
 *
 * Live `courtRecords` is empty, so there is no stored row to migrate — and with
 * the column free text there could not be one anyway.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

/** Comments stripped, so an explanatory note may name the wording it replaced. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const COURT_RECORDS = read('frontend/src/app/components/CourtRecords.tsx');

const NEW_LABEL = 'Promulgation of Judgement';
const OLD_LABEL = 'Sentencing';

/** The option list inside the "Hearing Type" field, in source order. */
function hearingTypeField() {
  const start = COURT_RECORDS.indexOf('<Label>Hearing Type</Label>');
  assert.ok(start >= 0, 'the Hearing Type field is gone from CourtRecords.tsx');
  const end = COURT_RECORDS.indexOf('</Select>', start);
  assert.ok(end > start, 'the Hearing Type dropdown was not closed');

  const block = COURT_RECORDS.slice(start, end);
  const options = [...block.matchAll(/<SelectItem value="([^"]*)">([^<]*)<\/SelectItem>/g)]
    .map((match) => ({ value: match[1], label: match[2] }));
  assert.ok(options.length > 0, 'the Hearing Type dropdown offers no options');
  return { block, options };
}

/** Every TS/TSX/JS/JSX/JSON file under a source root, minus build output. */
function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) continue;
        walk(full);
      } else if (/\.(ts|tsx|js|jsx|json)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(path.join(REPO, root));
  return out;
}

// ── What the dropdown offers ────────────────────────────────────────────────

test('the hearing type field offers "Promulgation of Judgement"', () => {
  const { options } = hearingTypeField();
  const renamed = options.find((option) => option.value === NEW_LABEL);
  assert.ok(renamed, `the dropdown does not offer ${JSON.stringify(NEW_LABEL)}`);
  assert.equal(
    renamed.label,
    NEW_LABEL,
    'the option stores one wording and displays another, so a saved record would not match what was picked',
  );
});

test('the hearing type list is exactly the intended set', () => {
  const { options } = hearingTypeField();
  assert.deepEqual(
    options.map((option) => option.value),
    ['Arraignment', 'Pre-Trial', 'Trial', 'Disposition', NEW_LABEL, 'Appeal'],
  );
  for (const option of options) {
    assert.equal(option.label, option.value, `${option.value} displays a different wording than it stores`);
  }
});

test('the hearing type field never offers the removed wording', () => {
  const { block } = hearingTypeField();
  assert.doesNotMatch(block, new RegExp(`\\b${OLD_LABEL}\\b`), 'the removed hearing type is still an option');
});

// ── Nowhere else either ─────────────────────────────────────────────────────

test('the removed wording survives in no source file', () => {
  const files = [...sourceFiles('frontend/src'), ...sourceFiles('backend/src')];
  assert.ok(files.length > 100, `expected to scan both source trees, only found ${files.length} files`);

  const offenders = files
    .filter((file) => code(fs.readFileSync(file, 'utf8')).includes(OLD_LABEL))
    .map((file) => path.relative(REPO, file).replace(/\\/g, '/'));

  assert.deepEqual(offenders, [], 'the removed hearing type is still offered somewhere');
});

// ── The rename needs no migration, and must reach the browser ───────────────

test('hearingType stays free text, so the rename needs no migration', () => {
  for (const rel of ['backend/src/server.js', 'backend/src/database/schema.sql']) {
    const source = read(rel);
    assert.match(source, /hearingType VARCHAR\(100\) NULL/, `${rel} no longer declares hearingType as free text`);
    assert.doesNotMatch(
      source,
      /hearingType\s+ENUM/i,
      `${rel} turned hearingType into an enum, which would reject the renamed value`,
    );
  }

  const { RESOURCES } = require(path.join(REPO, 'backend', 'src', 'utils', 'constants.js'));
  assert.ok(
    RESOURCES.courtRecords.columns.includes('hearingType'),
    'the bulk store would drop hearingType, so a renamed record could never reach the browser',
  );
});

test('every display site renders the stored hearing type verbatim', () => {
  const sites = [
    ['frontend/src/app/components/CourtRecords.tsx', /record\.hearingType \|\| 'N\/A'/],
    ['frontend/src/app/components/Dashboard.tsx', /h\.hearingType \|\| 'Hearing'/],
    ['frontend/src/app/components/SocialWorker.tsx', /hearing\.hearingType \|\| 'N\/A'/],
    ['frontend/src/app/components/UnifiedTimeline.tsx', /court\.hearingType \|\| 'Hearing'/],
  ];
  for (const [rel, pattern] of sites) {
    assert.match(read(rel), pattern, `${rel} no longer renders the stored hearing type verbatim`);
  }
});
