/**
 * Regression guard for the TRI rating trend.
 *
 * The trend answers the one question the paper form implies but the system never
 * stated: did this resident move up or down a band since the last finalized TRI?
 *
 * Two traps are pinned here.
 *
 * 1. `Number(null)` is 0 and `Number('')` is 0. A first-ever TRI has
 *    `previousPoints = null`, so a naive comparison reads that as a previous score
 *    of zero and reports every first TRI as a large improvement — a fabricated
 *    result on the majority of records. `numOrNull` must reject absent values
 *    before coercing.
 *
 * 2. The adjectival bands were inlined as a `>=` chain in Tri.tsx while the backend
 *    keeps its own copy in TRI_SCORING. Two copies of a scoring rule drift; the
 *    Dashboard already demonstrates that. The bands now live once in
 *    `utils/triRating.ts` and are cross-checked against the backend here.
 *
 * These read the source rather than run it because the frontend has no test runner
 * and the logic lives in a .ts module the backend suite cannot import.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const RATING = read('frontend/src/utils/triRating.ts');
const TRI_TSX = read('frontend/src/app/components/Tri.tsx');
const CHILD_DETAIL = read('frontend/src/app/components/ChildDetail.tsx');
const CONTROLLER = read('backend/src/controllers/triController.js');
// The backend bands moved out of the controller so the PDF writer can label the
// summary block without a second copy of the thresholds.
const SCORING = read('backend/src/utils/triScoring.js');

// ── trap 1: an absent previous score is not zero ────────────────────────────────

test('numOrNull rejects null, undefined and empty string before coercing', () => {
  const start = RATING.indexOf('const numOrNull');
  assert.ok(start > 0, 'numOrNull is gone — the trend no longer normalises its inputs');
  const body = RATING.slice(start, RATING.indexOf('};', start));

  assert.match(
    body,
    /value === null/,
    `numOrNull no longer checks for null. Number(null) is 0, so a first TRI would be ` +
      `reported as an improvement against a phantom previous score of zero.\n${body}`
  );
  assert.match(body, /value === undefined/, 'numOrNull no longer checks for undefined');
  assert.match(body, /value === ''/, "numOrNull no longer checks for the empty string, which also coerces to 0");

  // The guard has to come before the coercion, not after it.
  assert.ok(
    body.indexOf('value === null') < body.indexOf('Number(value)'),
    'the absent-value guard runs after Number(), which is too late'
  );
});

test('triTrend refuses to call a first TRI improved', () => {
  // The guard exists in the helper; this asserts the helper is actually consulted
  // with the record's stored previous values rather than the raw fields.
  assert.match(RATING, /if \(!previous\) return empty;/, 'triTrend no longer short-circuits a missing previous record');
  assert.match(
    RATING,
    /let direction: TriTrendDirection = 'unknown';/,
    "triTrend no longer starts from an 'unknown' outcome, so a comparison it cannot make " +
      'would default to whatever the fall-through happens to be'
  );
  assert.match(RATING, /'improved' \| 'declined' \| 'unchanged' \| 'unknown'/, 'the unknown direction was dropped from the type');
});

test('the TRI form draws no trend strip when there is nothing to compare', () => {
  assert.match(
    TRI_TSX,
    /selectedRecord && recordTrend\.direction !== 'unknown'/,
    'the trend strip renders for every record again, so a first TRI shows a meaningless arrow'
  );
});

// ── trap 2: one copy of the bands, and it agrees with the backend ───────────────

test('the frontend bands match the backend TRI_SCORING minimums', () => {
  const band = (key) => {
    const m = SCORING.match(new RegExp(`${key}:\\s*\\{\\s*min:\\s*(\\d+)`));
    assert.ok(m, `backend TRI_SCORING.${key} is gone`);
    return Number(m[1]);
  };
  const expected = {
    'Very Good': band('VERY_GOOD'),
    Good: band('GOOD'),
    Fair: band('FAIR'),
    'Needs Improvement': 1,
  };

  // Pull `if (n >= 451) return 'Very Good';` style clauses out of ratingForPoints.
  const start = RATING.indexOf('export function ratingForPoints');
  assert.ok(start > 0, 'ratingForPoints is gone — the bands have been inlined somewhere else again');
  const body = RATING.slice(start, RATING.indexOf('\n}', start));

  for (const [label, min] of Object.entries(expected)) {
    assert.match(
      body,
      new RegExp(`n >= ${min}\\) return '${label}'`),
      `ratingForPoints no longer maps ${min}+ to "${label}", but the backend still does — ` +
        `a score would read one way in the form and another way in the stored record`
    );
  }
});

test('the TRI form uses the shared band function instead of its own thresholds', () => {
  assert.match(
    TRI_TSX,
    /const computedRating = ratingForPoints\(finalPoints\)/,
    'Tri.tsx computes the rating inline again; the bands now exist in two places'
  );
  assert.doesNotMatch(
    TRI_TSX,
    /finalPoints >= 451 \? 'Very Good'/,
    'the inline threshold chain is back in Tri.tsx'
  );
});

// ── both surfaces must show it ─────────────────────────────────────────────────

test('the child record page compares the two newest finalized records', () => {
  assert.match(
    CHILD_DETAIL,
    /setPreviousTri\(finalized\[1\] \|\| null\)/,
    'the child page no longer keeps the earlier finalized record, so it can only state ' +
      'the current rating and never the direction'
  );
  assert.match(CHILD_DETAIL, /triTrend\(/, 'the child page no longer computes a trend');
  assert.match(CHILD_DETAIL, /data-tri-trend=/, 'the child page no longer marks the trend element');
});

test('the TRI record view shows the trend too', () => {
  assert.match(TRI_TSX, /const recordTrend = triTrend\(/, 'the TRI record view no longer computes a trend');
  assert.match(TRI_TSX, /data-tri-trend=\{recordTrend\.direction\}/, 'the TRI record view no longer renders it');
});

// ── the snapshot has to be refreshed, not just taken at create ──────────────────

test('submit refreshes the previous-period snapshot', () => {
  const start = CONTROLLER.indexOf('async function submit');
  assert.ok(start > 0, 'submit is gone');
  const body = CONTROLLER.slice(start, CONTROLLER.indexOf('async function', start + 10));

  assert.match(
    body,
    /previousFinalized\(record\.residentId, record\.reportingYear, record\.reportingMonth\)/,
    'submit no longer refreshes the previous snapshot. A draft started before the prior ' +
      'month was finalized would stay at "nothing to compare against" permanently.'
  );
  assert.match(body, /previousPoints = \?/, 'the submit UPDATE no longer writes previousPoints');
  assert.match(body, /previousRating = \?/, 'the submit UPDATE no longer writes previousRating');
});
