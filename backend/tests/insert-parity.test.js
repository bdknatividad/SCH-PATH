/**
 * Static INSERT placeholder/parameter parity.
 *
 * A mismatch between the number of `?` in an INSERT and the number of bound
 * values is a runtime error that no type-checker and no schema test can catch —
 * and it is easy to introduce when moving the generated id into or out of a
 * parameter list. This walks every `pool.query(`INSERT ...`, [...])` in the
 * controllers and compares the two counts.
 *
 * Statements whose SQL is assembled by interpolation (e.g.
 * `VALUES (${placeholders})`) cannot be counted this way and are skipped; they
 * are correct by construction because the same column list produces both the
 * placeholders and the values. The skip count is asserted below so a future
 * change that makes many more statements dynamic is noticed rather than
 * silently reducing coverage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONTROLLERS_DIR = path.join(__dirname, '..', 'src', 'controllers');

/** Count `?` characters outside single-quoted SQL string literals. */
function countPlaceholders(sqlLiteral) {
  let count = 0;
  let i = 0;
  while (i < sqlLiteral.length) {
    if (sqlLiteral[i] === "'") {
      i += 1;
      while (i < sqlLiteral.length && sqlLiteral[i] !== "'") {
        if (sqlLiteral[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (sqlLiteral[i] === '?') count += 1;
    i += 1;
  }
  return count;
}

/**
 * Count the top-level elements of the array literal starting at `openIndex`.
 * Aware of nested brackets and of strings, so commas inside either do not
 * inflate the count, and a trailing comma is not counted as an element.
 */
function countArrayElements(src, openIndex) {
  let depth = 0;
  let commas = 0;
  let hasContent = false;
  let i = openIndex;

  for (; i < src.length; i += 1) {
    const ch = src[i];

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) break;
        i += 1;
      }
      hasContent = true;
      continue;
    }

    if (ch === '(' || ch === '{') { depth += 1; hasContent = true; continue; }
    if (ch === ')' || ch === '}') { depth -= 1; continue; }
    if (ch === '[') { depth += 1; hasContent = true; continue; }
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) return hasContent ? commas + 1 : 0;
      continue;
    }
    if (ch === ',' && depth === 1) {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (src[j] !== ']') commas += 1;
      continue;
    }
    if (!/\s/.test(ch)) hasContent = true;
  }

  return -1;
}

function collectInsertStatements() {
  const checked = [];
  const skipped = [];

  for (const file of fs.readdirSync(CONTROLLERS_DIR).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(CONTROLLERS_DIR, file), 'utf8');
    const re = /query\(\s*(`INSERT[\s\S]*?`|'INSERT[\s\S]*?'|"INSERT[\s\S]*?")\s*,\s*\[/g;

    let match;
    while ((match = re.exec(src))) {
      const line = src.slice(0, match.index).split('\n').length;
      const sqlLiteral = match[1].slice(1, -1);

      // Interpolated SQL cannot be counted statically.
      if (sqlLiteral.includes('${')) {
        skipped.push(`${file}:${line}`);
        continue;
      }

      const arrayStart = src.indexOf('[', match.index + match[0].length - 1);
      checked.push({
        where: `${file}:${line}`,
        placeholders: countPlaceholders(sqlLiteral),
        params: countArrayElements(src, arrayStart),
      });
    }
  }

  return { checked, skipped };
}

test('every literal INSERT binds exactly as many values as it has placeholders', () => {
  const { checked, skipped } = collectInsertStatements();

  assert.ok(checked.length >= 30, `expected to inspect at least 30 INSERTs, saw ${checked.length}`);

  const mismatches = checked
    .filter((c) => c.placeholders !== c.params)
    .map((c) => `${c.where}: ${c.placeholders} placeholders but ${c.params} bound values`);

  assert.deepEqual(mismatches, [], `INSERT placeholder/parameter mismatches:\n  ${mismatches.join('\n  ')}`);

  // Every dynamic statement is correct by construction — one column list
  // produces both the placeholders and the values — but a jump here means
  // coverage silently dropped. The four are the generic CRUD writer
  // (baseController) and the three controllers that build their own INSERT from
  // `RESOURCES[...].columns` so they can act on the row before responding:
  // childController, documentController and healthController.
  assert.ok(
    skipped.length <= 4,
    `too many INSERTs were skipped as dynamic (${skipped.length}): ${skipped.join(', ')}`
  );
});
