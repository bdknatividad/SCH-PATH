/**
 * Regression guard for the TRI "Save & Submit" button.
 *
 * Reported bug: a Houseparent created a new TRI, filled in the form, and could not
 * submit. Nothing happened and no error appeared.
 *
 * Root cause: the button was `disabled={submitting || !form.residentId || !allPartOneScored}`,
 * where allPartOneScored means all 150 Part I indicators carry a score. A disabled button
 * never fires onClick, so the helpful refusal in handleSubmit — "Please score all 150 Part I
 * items before submitting (n/150 done)" — was unreachable. There was also no counter anywhere
 * on screen, and no way to save partial progress on a new record, so the only feedback was an
 * inert button. Confirmed against the live database at the time: triRecords held 0 rows, so no
 * request had ever been sent.
 *
 * The rule itself (150/150 required to submit) is intentional and is NOT relaxed here — only
 * the feedback changed. These tests pin both halves: the guard must stay, the dead button must
 * not come back.
 *
 * They read the source rather than run it, because the regression is a change to one attribute
 * that type-checks, builds, and is invisible without a browser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TRI_TSX = path.resolve(__dirname, '../../frontend/src/app/components/Tri.tsx');
const source = fs.readFileSync(TRI_TSX, 'utf8');

/** Collapse a slice of JSX to one line so attribute assertions do not depend on formatting. */
const flat = (text) => text.replace(/\s+/g, ' ');

/** The `<Button>` that submits — located by its onClick, not by position. */
function submitButtonTag() {
  const index = source.indexOf('onClick={handleSubmit}');
  assert.ok(index > 0, 'handleSubmit is no longer wired to any button');
  const open = source.lastIndexOf('<Button', index);
  const close = source.indexOf('>', index);
  return flat(source.slice(open, close));
}

/** Slice of source between two anchors. */
function between(startAnchor, endAnchor) {
  const start = source.indexOf(startAnchor);
  assert.ok(start > 0, `anchor not found: ${startAnchor}`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.ok(end > start, `end anchor not found after ${startAnchor}: ${endAnchor}`);
  return source.slice(start, end);
}

// ── the three id tables that must agree, or 150/150 becomes unreachable ──────────
//
// These now live in frontend/src/shared/triLayout.json rather than inline in Tri.tsx,
// because the backend draws the same official PDF on approval and both sides must use
// the same measured coordinates. Reading the JSON is also stricter than scraping the
// TSX: the three tables are now compared as data rather than by regex over source text.

const LAYOUT = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../frontend/src/shared/triLayout.json'), 'utf8')
);

function partOneIds() {
  return LAYOUT.partOne.flatMap((section) => section.items.map((item) => item.id));
}
function pageIds() {
  return LAYOUT.pageItems.flatMap((entry) => entry.ids);
}
function yCoordIds() {
  return Object.keys(LAYOUT.itemY);
}

test('TRI Part I declares exactly 150 indicators', () => {
  assert.equal(partOneIds().length, 150);
  assert.match(source, /const TOTAL_ITEMS = TRI_PART_ONE\.reduce/);
});

test('the component reads the shared layout instead of holding its own copy', () => {
  assert.match(source, /import triLayout from '@\/shared\/triLayout\.json'/,
    'Tri.tsx no longer imports the shared layout — the coordinates are duplicated again');
  assert.match(source, /const TRI_PART_ONE = triLayout\.partOne;/,
    'Tri.tsx no longer takes TRI_PART_ONE from the shared layout');
  assert.doesNotMatch(source, /^const TRI_ITEM_Y: Record<string, number> = \{/m,
    'a second inline copy of the y-coordinates is back in Tri.tsx');
});

test('the shared layout also carries what the backend PDF writer needs', () => {
  assert.equal(LAYOUT.partTwoOffenses.length, 45, 'Part II offense table is incomplete');
  assert.equal(LAYOUT.offensePos.length, 45, 'offense coordinates do not cover all 45 rows');
  assert.equal(LAYOUT.scoreX.length, 4, 'the four score columns are not all present');
  assert.ok(
    LAYOUT.partTwoOffenses.every((o) => typeof o.points === 'number' && o.points > 0),
    'an offense row has no point value, so deductions would be wrong'
  );
});

test('every declared indicator is rendered on a PDF page', () => {
  const declared = new Set(partOneIds());
  const rendered = new Set(pageIds());
  const unrenderable = [...declared].filter((id) => !rendered.has(id));
  assert.deepEqual(
    unrenderable,
    [],
    `these items have no page mapping, so they can never be scored and 150/150 is unreachable: ${unrenderable.join(', ')}`
  );
});

test('every rendered indicator has a y-coordinate', () => {
  // OfficialTriEditor does `if (centerY == null) return null` — a missing y means the
  // score buttons are never drawn for that row.
  const rendered = pageIds();
  const coords = new Set(yCoordIds());
  const missing = [...new Set(rendered)].filter((id) => !coords.has(id));
  assert.deepEqual(
    missing,
    [],
    `these items render no score cells (TRI_ITEM_Y has no entry): ${missing.join(', ')}`
  );
});

test('no y-coordinate is orphaned from the page map', () => {
  const rendered = new Set(pageIds());
  const orphans = yCoordIds().filter((id) => !rendered.has(id));
  assert.deepEqual(orphans, [], `TRI_ITEM_Y entries with no page: ${orphans.join(', ')}`);
});

// ── the reported bug: the button must not be inert ───────────────────────────────

/** The expression inside `disabled={...}` of a JSX tag. */
function disabledExpr(tag) {
  const match = tag.match(/disabled=\{([^}]*)\}/);
  return match ? match[1].trim() : '';
}

test('the Submit button is not disabled on completeness', () => {
  const expr = disabledExpr(submitButtonTag());
  assert.ok(expr, 'the Submit button has no disabled expression at all — the guard was removed outright');
  assert.ok(
    !/allPartOneScored/.test(expr),
    `the Submit button is disabled on allPartOneScored again, which makes the refusal in ` +
      `handleSubmit unreachable and the button inert. disabled={${expr}}`
  );
});

test('the Submit button is still disabled without a resident or while in flight', () => {
  const expr = disabledExpr(submitButtonTag());
  assert.match(expr, /submitting/, 'Submit is no longer guarded against double-clicks');
  assert.match(expr, /form\.residentId/, 'Submit is no longer guarded against a missing resident');
});

test('handleSubmit still refuses an incomplete TRI', () => {
  const handler = between('async function handleSubmit', 'setSubmitting(true)');
  assert.match(handler, /if \(!allPartOneScored\)/, 'the 150/150 rule was dropped from handleSubmit');
  assert.match(handler, /return;/, 'the refusal no longer returns, so an incomplete TRI would be submitted');
});

test('the refusal states progress and names the first unanswered indicator', () => {
  const handler = between('async function handleSubmit', 'setSubmitting(true)');
  assert.match(handler, /scoredCount\}\/\$\{TOTAL_ITEMS\}/, 'the refusal no longer reports n/150');
  assert.match(handler, /firstUnscoredItem\(/, 'the refusal no longer identifies what is missing');
  assert.match(handler, /next\.label/, 'the refusal no longer names the unanswered indicator');
  assert.match(handler, /next\.section/, 'the refusal no longer names the section');
});

test('the refusal scrolls to the unanswered row', () => {
  const handler = between('async function handleSubmit', 'setSubmitting(true)');
  assert.match(handler, /scrollIntoView\(/, 'the refusal does not scroll to the row it is complaining about');
  assert.match(handler, /data-tri-item=/, 'the scroll target attribute is not queried');
});

test('firstUnscoredItem walks the form order and treats 0 as unanswered', () => {
  const helper = between('function firstUnscoredItem', 'function getMonthLabel');
  assert.match(helper, /for \(const section of TRI_PART_ONE\)/, 'the helper no longer walks TRI_PART_ONE');
  assert.match(helper, /Number\(map\[item\.id\]\) > 0/, 'the helper no longer treats 0/blank as unanswered');
});

// ── visible feedback ────────────────────────────────────────────────────────────

test('a live scored counter is rendered next to the button', () => {
  assert.match(
    source,
    /data-tri-scored-count=\{scoredCount\}/,
    'the scored counter is gone — without it the 150-item rule is invisible until the user clicks'
  );
  assert.match(source, /\{scoredCount\}\/\{TOTAL_ITEMS\} scored/, 'the counter no longer shows n/150');
});

test('unanswered rows are marked in the editor', () => {
  assert.match(source, /data-tri-unscored=\{id\}/, 'unanswered rows are no longer marked');
  assert.match(
    source,
    /isEditable && !isScored/,
    'the unanswered marker is no longer limited to an editable form'
  );
});

test('every indicator exposes a scroll anchor', () => {
  assert.match(
    source,
    /data-tri-item=\{score === 1 \? id : undefined\}/,
    'the scroll anchor was removed, so scrollIntoView has no target'
  );
});

// ── partial progress must be savable ────────────────────────────────────────────

test('Save Draft is offered for a brand-new TRI', () => {
  const index = source.indexOf('onClick={handleSaveDraft}');
  assert.ok(index > 0, 'handleSaveDraft is no longer wired to any button');
  const open = source.lastIndexOf('{', source.lastIndexOf('<Button', index));
  const guard = flat(source.slice(open, source.lastIndexOf('<Button', index)));
  assert.ok(
    !/selectedRecord\s*&&/.test(guard),
    `Save Draft is gated on an existing record again, so partial work on a new TRI cannot be saved: ${guard}`
  );
  assert.match(guard, /!selectedRecord \|\| isEditable/, `unexpected Save Draft guard: ${guard}`);
});

test('Save Draft still cannot fire without a resident', () => {
  const index = source.indexOf('onClick={handleSaveDraft}');
  const open = source.lastIndexOf('<Button', index);
  const close = source.indexOf('>', index);
  assert.match(flat(source.slice(open, close)), /disabled=\{[^}]*form\.residentId/);
});
