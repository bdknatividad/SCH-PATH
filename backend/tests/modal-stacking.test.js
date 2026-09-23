/**
 * Guards for the modal-stacking fix.
 *
 * ## The reported bug
 *
 * Documents → Pending Review → Approve produced a "Document approved" dialog
 * that dimmed the screen and could not be clicked. Esc was the only way out.
 *
 * It is not a z-index conflict. Every modal content is a Radix
 * `DismissableLayer`, and the library computes whether the layer may receive
 * pointer events from its position in an insertion-ordered `Set`:
 *
 *   const highest = [...layersWithOutsidePointerEventsDisabled].slice(-1)[0];
 *   const isPointerEventsEnabled = layers.indexOf(node) >= layers.indexOf(highest);
 *   style={{ pointerEvents: isBodyPointerEventsDisabled
 *     ? (isPointerEventsEnabled ? 'auto' : 'none')
 *     : undefined }}
 *
 * A workflow that shows a confirm and then an outcome opens two layers moments
 * apart. If the outgoing layer has not been removed from the `Set` when the
 * incoming one measures itself, the incoming dialog is judged "not the top
 * layer" and Radix inlines `pointer-events: none` onto it. It still paints, and
 * Esc still closes it — Escape is a document-level key handler, not a pointer
 * event — but every button in it is inert. That combination *is* the report.
 *
 * Two independent defences are asserted here, because either alone is fragile:
 *
 *   1. `modalPointerGuard` — Radix spreads `...props.style` after its own
 *      computed value, so a value passed by the app wins and no dialog in this
 *      app can be made inert by whatever is mounting behind it.
 *   2. The provider yields a frame before replacing a dialog, so the outgoing
 *      layer leaves the DOM first and the common case never reaches the
 *      ambiguous state.
 *
 * Plus an ordering rule for callers: a dialog closed by the same handler that
 * shows the outcome must be closed *before* the first await, not after.
 *
 * Run: node --test tests/modal-stacking.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND = path.join(REPO_ROOT, 'frontend');
const COMPONENTS = path.join(FRONTEND, 'src', 'app', 'components');
const UI = path.join(COMPONENTS, 'ui');

const read = (file) => fs.readFileSync(file, 'utf8');

// ── Defence 1: the app owns the pointer-events decision ────────────────────

test('the shared pointer guard exists and explains why', () => {
  const source = read(path.join(UI, 'modalLayer.ts'));

  assert.match(
    source,
    /export const modalPointerGuard[^=]*=\s*\{\s*pointerEvents:\s*'auto'\s*\}/,
    'modalPointerGuard must be the single source of the pointer-events override',
  );
  // The mechanism is subtle enough that removing it will look like dead code to
  // whoever finds it next, so the reasoning has to travel with the value.
  assert.match(source, /DismissableLayer/, 'the guard must name the Radix mechanism it corrects');
  assert.match(source, /pointer-events: none/, 'the guard must record the symptom it prevents');
});

test('every modal content applies the pointer guard', () => {
  const modals = [
    ['dialog.tsx', /DialogPrimitive\.Content/],
    ['alert-dialog.tsx', /AlertDialogPrimitive\.Content/],
  ];

  for (const [file, primitive] of modals) {
    const source = read(path.join(UI, file));
    assert.match(source, primitive, `${file} no longer renders the Radix content primitive`);
    assert.match(
      source,
      /style=\{\{\s*\.\.\.modalPointerGuard/,
      `${file} does not apply modalPointerGuard — a dialog rendered through it can be ` +
        'left inert whenever another modal is mounted behind it',
    );
    assert.match(
      source,
      /import \{ modalPointerGuard \} from "\.\/modalLayer"/,
      `${file} must import the shared guard rather than inlining its own copy`,
    );
  }
});

test('the guard is spread before the caller style so a caller can still override', () => {
  // Radix spreads `...props.style` after its computed value; these wrappers must
  // do the same or a caller could not pass its own style at all.
  for (const file of ['dialog.tsx', 'alert-dialog.tsx']) {
    const source = read(path.join(UI, file));
    assert.match(
      source,
      /style=\{\{\s*\.\.\.modalPointerGuard,\s*\.\.\.style\s*\}\}/,
      `${file} must let an explicit caller style win over the guard`,
    );
  }
});

test('the app confirm dialog uses the shared guard rather than its own inline copy', () => {
  const source = read(path.join(COMPONENTS, 'SystemDialog.tsx'));

  assert.match(
    source,
    /import \{ modalPointerGuard \} from '@\/app\/components\/ui\/modalLayer'/,
    'SystemDialog must share the guard, so there is one explanation to maintain',
  );
  assert.match(
    source,
    /<AlertDialogContent[\s\S]{0,200}?style=\{modalPointerGuard\}/,
    'the app confirm dialog is the one opened from inside other dialogs — it must be guarded',
  );
  // An inline copy would silently drift from the shared one.
  assert.doesNotMatch(
    source,
    /style=\{\{\s*pointerEvents:\s*'auto'\s*\}\}/,
    'SystemDialog re-inlined the guard instead of importing it',
  );
});

// ── Defence 2: replacing a dialog must not overlap its predecessor ─────────

test('the dialog provider waits for the previous layer to unmount before replacing it', () => {
  const source = read(path.join(COMPONENTS, 'SystemDialog.tsx'));

  const open = source.match(/const open = useCallback\([\s\S]*?\n  \), \[\]\);/);
  assert.ok(open, 'expected the dialog provider `open` implementation');

  // The yield is what lets React commit the dismissal and run the outgoing
  // layer's cleanup effect before the replacement is presented.
  assert.match(
    open[0],
    /requestAnimationFrame\(present\)|setTimeout\(present,\s*0\)/,
    'replacing a dialog must yield a frame, or the two layers overlap and the ' +
      'incoming one is left inert',
  );

  // The decision must be made on "is a layer still on screen", not on "is a
  // caller still awaiting an answer" — the latter is false the instant a button
  // is pressed, which is precisely when the risky handoff happens.
  assert.match(
    source,
    /const layerMounted = useRef\(false\)/,
    'the provider must track whether a layer is still mounted, separately from the resolver',
  );
  assert.match(
    open[0],
    /layerMounted\.current/,
    'the fast path must consult layerMounted, or a settled-but-unmounted dialog ' +
      'is treated as closed and its replacement mounts on top of it',
  );

  // A second replacement must supersede the first, or the older request can win
  // the frame race and mount over the newer one.
  assert.match(
    source,
    /const cancelQueued = useRef/,
    'a queued replacement must be cancellable so the latest request wins',
  );
});

test('settling a dialog does not clear the mounted flag before the caller can act', () => {
  const source = read(path.join(COMPONENTS, 'SystemDialog.tsx'));

  // `settle` is written as the useCallback shorthand — `useCallback((value) => {`
  // with no opening paren before the arrow — so the search must not assume one.
  const settleAt = source.indexOf('const settle = useCallback(');
  assert.ok(settleAt !== -1, 'expected the `settle` implementation');

  const open = source.indexOf('{', source.indexOf('(', settleAt + 'const settle = useCallback'.length));
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end !== -1, 'expected to find the end of `settle`');
  const settle = source.slice(settleAt, end);

  assert.match(
    settle,
    /layerMounted\.current = false/,
    'settle must clear the mounted flag so the next dialog takes the fast path',
  );
  assert.match(
    settle,
    /resolve\?\.\(value\)/,
    'settle must resolve the caller promise, or the awaiting handler never resumes',
  );
});

// ── Defence 3: callers close their own dialog before awaiting ──────────────

/**
 * Every `await dialog.success(...)` / `await dialog.failure(...)` in a module.
 * `dialog` is whichever local name the module bound `useSystemDialog()` to.
 */
function noticeCalls(source) {
  return [...source.matchAll(/await\s+\w+\.(?:success|failure|notify|validation)\(/g)];
}

/**
 * Handler declarations, arrow or `function` form. Captures the name in group 1
 * or 2 — a module mixes both styles freely.
 */
const HANDLER = /(?:const\s+(\w+)\s*=\s*async\b[^=]*=>|async\s+function\s+(\w+)\s*\()/g;

/** Slice from a top-level `{` to its matching `}`. */
function braceBody(source, openAt) {
  let depth = 0;
  for (let i = openAt; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openAt, i + 1);
    }
  }
  return null;
}

/**
 * The `set…(false)` calls that appear *after* the first `await` inside a
 * handler. Closing a dialog there is too late: the outcome dialog opens from the
 * same handler, so the form's layer is still mounted when it does.
 *
 * The pattern must not require `Open` or let `\w*` run greedily up to the
 * keyword: this codebase closes dialogs with `setShowForm(false)`,
 * `setIsReviewDialogOpen(false)` and `setShowFinalizeDialog(false)` alike, and a
 * pattern that matches only the second shape makes this test pass on everything.
 */
const DIALOG_CLOSE = /\bset\w*(?:Dialog|Modal|Form|Overlay)\w*\(false\)/g;

function closesAfterFirstAwait(body) {
  const code = withoutComments(body);
  const firstAwait = code.search(/\bawait\b/);
  if (firstAwait === -1) return [];
  const tail = code.slice(firstAwait);
  return [...tail.matchAll(DIALOG_CLOSE)].map((match) => match[0]);
}

/**
 * Strips line and block comments.
 *
 * The ordering assertion below searches for `await`, and these handlers explain
 * themselves in prose right where the ordering matters — "closing afterwards
 * would leave this layer mounted" contains the word `await`. Matching that
 * makes the first await look earlier than the close and reports a defect that
 * does not exist. Comments are not code; take them out before measuring.
 */
function withoutComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('a handler does not close its dialog after awaiting, when it later shows an outcome', () => {
  // The shape being forbidden:
  //
  //   await save();                 // form still open
  //   setShowDialog(false);         // ← too late
  //   await dialog.success(...);    // opens over a dying layer
  //
  // Checked across the modules named in the brief, since each keeps its own
  // dialog state and a new one can be added without touching the others.
  const modules = [
    'DocumentUpload.tsx',
    'Tri.tsx',
    'AnecdotalReports.tsx',
    'AnecdotalReport.tsx',
  ];

  const offenders = [];

  for (const file of modules) {
    const source = read(path.join(COMPONENTS, file));

    // Handler bodies are extracted by balancing braces, not by splitting on the
    // next declaration. A split-based approach attributes a chunk to whichever
    // handler the text happened to start under — so a nested function, or a
    // plain helper declared between two handlers, is reported as the outer
    // handler closing late. That produced two false positives before this was
    // rewritten; a test that cries wolf about correct code gets deleted, and
    // then the real case goes unguarded.
    HANDLER.lastIndex = 0;
    let match;
    while ((match = HANDLER.exec(source))) {
      const name = match[1] || match[2];
      const open = source.indexOf('{', match.index + match[0].length - 1);
      if (open === -1) continue;
      const body = braceBody(source, open);
      if (!body || !noticeCalls(body).length) continue;

      const late = closesAfterFirstAwait(body);
      if (!late.length) continue;

      offenders.push(`${file} → ${name}() calls ${late.join(', ')} after its first await`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'closing a modal after an await leaves its Radix layer mounted while the ' +
      'outcome dialog opens, and that dialog is then judged "not the top layer" ' +
      'and made inert — the reported bug. Close before the first await:\n  ' +
      offenders.join('\n  '),
  );
});

test('the document review handler closes its form before the request', () => {
  // The exact reported path, pinned explicitly: Documents → Pending Review →
  // Review form → Approve/Reject.
  const source = read(path.join(COMPONENTS, 'DocumentUpload.tsx'));

  const handler = functionBody(source, 'const handleReviewSubmit = async');
  assert.ok(handler, 'expected handleReviewSubmit');

  const body = withoutComments(handler);
  const closeAt = body.indexOf('setIsReviewDialogOpen(false)');
  const firstAwait = body.search(/\bawait\b/);

  assert.ok(closeAt !== -1, 'the review form must be closed by this handler');
  assert.ok(
    closeAt < firstAwait,
    'the review form must close before the first await, or it is still mounted ' +
      'when the outcome dialog opens and that dialog cannot be clicked',
  );
});

/**
 * Extracts a named function's body by balancing braces from its opening `{`.
 *
 * A regex like `async function f\(\)[\s\S]*?\n  \}` looks right and is not: the
 * body of these handlers contains nested blocks (a `try`, an `if`) whose closing
 * brace is indented by four spaces and preceded by two, so the non-greedy match
 * stops inside the handler. The captured text then ends before the real code —
 * which makes the assertion below report a defect that is not there and, worse,
 * keeps reporting it after somebody has fixed the real one.
 */
function functionBody(source, header) {
  const start = source.indexOf(header);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  if (open === -1) return null;
  return braceBody(source, open);
}

test('the TRI review handlers close their dialogs before the request', () => {
  const source = read(path.join(COMPONENTS, 'Tri.tsx'));

  for (const [header, closeCall] of [
    ['async function handleReturn()', 'setShowReturnDialog(false)'],
    ['async function handleFinalize()', 'setShowFinalizeDialog(false)'],
    ['async function handleSubmit()', 'setShowForm(false)'],
  ]) {
    const body = functionBody(source, header);
    assert.ok(body, `expected ${header} in Tri.tsx`);

    const code = withoutComments(body);
    const closeAt = code.indexOf(closeCall);
    const firstAwait = code.search(/\bawait\b/);

    assert.ok(closeAt !== -1, `${header} must close ${closeCall}`);
    assert.ok(
      closeAt < firstAwait,
      `${header} closes its dialog after the first await — the outcome dialog ` +
        'would open underneath a still-mounted layer and be unclickable',
    );
  }
});

test('the ordering detector itself recognises every close-call shape in use', () => {
  // This test exists because the detector above was, for a while, a check that
  // could not fail. Its pattern required the setter to end in `Open(false)`,
  // which is true of `setIsReviewDialogOpen(false)` and false of
  // `setShowForm(false)` — so a handler closing late was reported as clean. Any
  // future tightening of the pattern has to keep matching all of these.
  const shapes = [
    'setShowForm(false)',
    'setShowFinalizeDialog(false)',
    'setShowReturnDialog(false)',
    'setIsReviewDialogOpen(false)',
    'setIsRejectDialogOpen(false)',
    'setShowRejectFormOpen(false)',
    'setIsDeleteDialogOpen(false)',
  ];
  for (const call of shapes) {
    DIALOG_CLOSE.lastIndex = 0;
    assert.ok(DIALOG_CLOSE.test(call), `the detector no longer matches \`${call}\``);
  }

  // …and must not fire on state that merely happens to be set to false.
  DIALOG_CLOSE.lastIndex = 0;
  assert.ok(
    !DIALOG_CLOSE.test('setDocumentToDelete(null)'),
    'the detector is matching unrelated setters, which would make it noisy',
  );
});

test('no handler anywhere shows an outcome dialog while its own dialog is mounted', () => {
  // The module-by-module tests above pin the workflows named in the brief. This
  // one is the safety net for the "any workflow" clause: it walks every
  // component and applies the ordering rule generically, so a new form added
  // later is covered without anybody remembering to extend a list.
  const { execFileSync } = require('node:child_process');

  const output = execFileSync(
    process.execPath,
    [path.join(__dirname, 'helpers', 'scan-modal-order.js')],
    { encoding: 'utf8' },
  );

  assert.match(
    output,
    /^No out-of-order dialog closes found\./,
    'a handler shows an outcome dialog while a dialog it owns is still mounted, ' +
      'which leaves that layer to be judged "not the top layer" and inlined ' +
      'with `pointer-events: none`:\n' +
      output,
  );
});
