/**
 * Ad-hoc scanner: reports handlers that show an outcome dialog while a dialog
 * they own is still mounted.
 *
 * The rule being checked is "close before the first await". A handler that shows
 * `dialog.success(...)` / `dialog.confirm(...)` while another Radix layer it
 * controls is still mounted risks that layer being judged "not the top layer"
 * and inlined with `pointer-events: none` — see ui/modalLayer.ts.
 *
 * Usage: node tests/helpers/scan-modal-order.js [dir]
 */

const fs = require('node:fs');
const path = require('node:path');

const DIR = process.argv[2]
  || path.resolve(__dirname, '..', '..', '..', 'frontend', 'src', 'app', 'components');

/** Line and block comments contain prose that mentions `await`. Remove them. */
function withoutComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

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

const HANDLER = /(?:const\s+(\w+)\s*=\s*async\b[^=]*=>|async\s+function\s+(\w+)\s*\()/g;
const OUTCOME = /\bawait\s+\w+\.(?:success|failure|notify|validation|confirm)\(/g;
// Matches every dialog-closing setter in this codebase, which is *not* a single
// convention: `setShowForm(false)`, `setIsReviewDialogOpen(false)` and
// `setShowFinalizeDialog(false)` all occur. Requiring `Open(false)` — or letting
// `\w*` be greedy before the keyword — silently matches nothing for most of them,
// which turns this whole scan into a check that always passes.
const CLOSE = /\bset\w*(?:Dialog|Modal|Form|Overlay)\w*\(false\)/g;

const findings = [];

for (const file of fs.readdirSync(DIR)) {
  if (!/\.tsx?$/.test(file)) continue;
  const raw = fs.readFileSync(path.join(DIR, file), 'utf8');
  const source = withoutComments(raw);
  if (!OUTCOME.test(source)) continue;
  OUTCOME.lastIndex = 0;

  HANDLER.lastIndex = 0;
  let match;
  while ((match = HANDLER.exec(source))) {
    const name = match[1] || match[2];
    const open = source.indexOf('{', match.index + match[0].length - 1);
    if (open === -1) continue;
    const body = braceBody(source, open);
    if (!body) continue;

    const outcomes = [...body.matchAll(OUTCOME)];
    if (!outcomes.length) continue;

    const closes = [...body.matchAll(CLOSE)].map((m) => ({ call: m[0], at: m.index }));
    const firstOutcome = outcomes[0].index;
    const firstAwait = body.search(/\bawait\b/);
    const line = source.slice(0, match.index).split('\n').length;

    // Closing after the outcome dialog is shown is unambiguously bad.
    const afterOutcome = closes.filter((c) => c.at > firstOutcome);

    // Closing after an earlier await is the subtler case: the layer stays
    // mounted across the whole round trip.
    const afterAwait = closes.filter((c) => c.at > firstAwait);

    if (afterOutcome.length || (afterAwait.length && firstAwait < firstOutcome)) {
      findings.push({
        file,
        line,
        handler: name,
        closes: (afterOutcome.length ? afterOutcome : afterAwait).map((c) => c.call),
        kind: afterOutcome.length ? 'after outcome' : 'after await',
      });
    }
  }
}

if (!findings.length) {
  console.log('No out-of-order dialog closes found.');
} else {
  for (const f of findings) {
    console.log(
      `${f.file}:${f.line}  ${f.handler}()  ${f.closes.join(', ')}  [${f.kind}]`,
    );
  }
  console.log(`\n${findings.length} finding(s).`);
}
