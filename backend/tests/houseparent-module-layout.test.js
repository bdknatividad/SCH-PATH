/**
 * The Houseparent module's editor must not cover its own footer.
 *
 * ## The reported bug
 *
 * "Houseparent Module UI — cramped, overlapping layout."
 *
 * The Houseparent module is `/tri`, and its editor is a **full-screen** dialog
 * (`!top-0 !left-0 !h-screen !w-screen`). Inside it the form is a `flex-1`
 * scroll area, so the scroll area's bottom edge is exactly the footer's top
 * edge — the footer holds Save Draft and Save & Submit.
 *
 * The violations reference was pinned to the viewport rather than to the
 * dialog:
 *
 *     className="fixed bottom-5 left-5 z-[80] ..."      // the toggle
 *     className="fixed bottom-20 right-3 z-[79] ..."    // the panel
 *
 * `fixed` resolves against the viewport, not the scroll area, so `bottom-5`
 * put the toggle 20px above the bottom of the *screen* — which is inside the
 * footer, on top of Save Draft — and `bottom-20` put the panel over Save &
 * Submit. On a phone the footer wraps to two rows (`flex-wrap`), so the overlap
 * was worse there, and the panel's `max-h-[72vh]` let it grow until it met the
 * footer instead of stopping short of it.
 *
 * The fix moves both into the dialog's own flex column, between the form and
 * the footer, so they cannot cover anything at any width.
 *
 * These are source assertions because the frontend has no test runner and the
 * defect is a layout decision, not a computation — there is no value to run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');

const TRI = read('frontend/src/app/components/Tri.tsx');

/**
 * Source with its comments removed.
 *
 * The fix's own comment quotes the offending class names to explain what was
 * wrong with them, so asserting against the raw text would keep passing after
 * the classes came back — the comment alone would satisfy the match.
 */
const code = (src) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** The whole of the editor's return value, from the scroll area to the fragment close. */
function editorBody() {
  const start = TRI.indexOf('function OfficialTriEditor');
  assert.ok(start > 0, 'OfficialTriEditor is gone — the Houseparent module moved');
  const end = TRI.indexOf('function openPrintReport', start);
  assert.ok(end > start, 'could not find the end of the editor');
  return code(TRI.slice(start, end));
}

test('the full-screen TRI editor is a column whose form area is the flexible row', () => {
  // The premise of the bug. If the form stops being `flex-1` inside a
  // full-screen dialog, the footer no longer sits under it and the reasoning
  // below has to be revisited rather than trusted.
  assert.match(
    TRI,
    /!h-screen[^"]*flex flex-col/,
    'the TRI editor is no longer a full-screen flex column, so the footer no longer sits under the form',
  );
  assert.match(
    editorBody(),
    /relative min-h-0 flex-1 overflow-y-auto/,
    'the form area is no longer the flexible row of that column',
  );
});

test('nothing in the TRI editor is pinned to the viewport', () => {
  // `fixed` is what made the controls escape the dialog and land on the footer.
  // Scoped to the editor: the page around it may legitimately pin things.
  const body = editorBody();
  assert.equal(
    /\bfixed\b/.test(body),
    false,
    'the editor pins something to the viewport again; inside a full-screen dialog that lands on the footer',
  );
});

test('the violations reference takes its own row instead of covering the footer', () => {
  const body = editorBody();

  // Its own row: a non-shrinking flex child, so it is laid out *beside* the
  // form and the footer rather than over them.
  assert.match(
    body,
    /className="shrink-0 border-t[^"]*">/,
    'the violations reference no longer occupies its own row above the footer',
  );

  // And it is bounded, so it cannot grow down into the footer.
  assert.match(
    body,
    /max-h-\[32vh\] overflow-y-auto/,
    'the violations panel is unbounded again — it will grow until it meets the footer',
  );
});

test('the violations reference still works', () => {
  const body = editorBody();

  // The fix is a move, not a removal: the control and its list must survive.
  assert.match(body, /onToggleResidentViolations/, 'the Show/Hide Violations control is gone');
  assert.match(
    body,
    /showResidentViolations \? 'Hide Violations' : 'Show Violations'/,
    'the toggle no longer names what it does',
  );
  assert.match(body, /residentViolations\.map/, 'the resident violations list is gone');
  assert.match(body, /PART_TWO_OFFENSES/, 'the Part II offense dates are gone from the reference');
});
