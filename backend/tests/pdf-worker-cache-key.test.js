/**
 * Guards the pdf.js worker URL against being served, and cached, as the wrong
 * kind of file.
 *
 * ## The bug this exists for
 *
 * The first `vercel.json` (2026-09-23 12:34) set `Content-Type` on
 * `/pdf.worker.mjs` twice — `text/javascript` from one rule and
 * `application/octet-stream` from a later, broader rule. Vercel's last match
 * wins, so the worker was served as **octet-stream**, and the catch-all rule
 * added `X-Content-Type-Options: nosniff` on top of it. The browser then refuses
 * to execute the file as a script at all.
 *
 * The rule was corrected 2h23m later (commit `2437e39`), but the worker was also
 * sent with `Cache-Control: public, max-age=31536000, immutable`. **`immutable`
 * means the browser never revalidates it during the freshness lifetime**, so
 * every browser that loaded the app in that window kept the octet-stream copy
 * for a year — and no header change can reach it. pdf.js cannot start, and every
 * PDF view falls through to its error branch. Measured on 2026-09-25, the user's
 * browser reported exactly:
 *
 *   Unable to display the report form (Setting up fake worker failed:
 *   "Failed to fetch dynamically imported module:
 *    https://sch-path.vercel.app/pdf.worker.mjs".).
 *
 * A fresh browser profile always works, which is why this reads as "works for me
 * but not for you" and why it cannot be reproduced by simply opening the app.
 *
 * ## The two rules that follow
 *
 * 1. **The worker URL must carry a version query.** A new URL is a new cache key,
 *    so a poisoned entry is bypassed rather than waited out. Deriving the version
 *    from `pdfjs.version` also keeps the worker and the library in step, since a
 *    version bump changes the URL.
 * 2. **The worker must never be `immutable`.** It lives at an unhashed path, so
 *    an immutable response is one no future fix can reach. Revalidating costs a
 *    304 — the file has an ETag.
 *
 * Run: node --test tests/pdf-worker-cache-key.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'frontend', 'src');

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/^(node_modules|dist|__snapshots__)$/.test(entry.name)) sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Strips comments, so the prose above is not mistaken for the code. */
function withoutComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const rel = (file) => path.relative(REPO_ROOT, file).replace(/\\/g, '/');

test('every pdf.js worker URL carries a version query', () => {
  // A bare `/pdf.worker.mjs` is a URL that some browsers have already cached
  // under a broken Content-Type and will not revalidate. The query is what makes
  // the URL new.
  const assignments = [];
  const bare = [];

  for (const file of sourceFiles(SRC)) {
    const code = withoutComments(fs.readFileSync(file, 'utf8'));

    for (const match of code.matchAll(/GlobalWorkerOptions\.workerSrc\s*=\s*([^\n]+)/g)) {
      assignments.push({ file: rel(file), expression: match[1].trim() });
    }

    code.split('\n').forEach((line, index) => {
      // A complete literal '/pdf.worker.mjs' — the versioned form ends in `?v=`,
      // so it does not match.
      if (/['"`]\/pdf\.worker\.mjs['"`]/.test(line)) {
        bare.push(`${rel(file)}:${index + 1}  ${line.trim()}`);
      }
    });
  }

  assert.ok(
    assignments.length >= 7,
    `expected every component that renders a PDF to configure the worker, found ` +
      `${assignments.length}`,
  );

  for (const { file, expression } of assignments) {
    assert.match(
      expression,
      /\?v=\$\{pdfjs\.version\}/,
      `${file} must build the worker URL with a \`?v=\${pdfjs.version}\` query. A ` +
        'bare path is the URL that was cached as application/octet-stream under ' +
        '`immutable`, and no header change can reach an entry like that.',
    );
  }

  assert.deepEqual(
    bare,
    [],
    'these reference the worker by a bare, unversioned path:\n  ' + bare.join('\n  '),
  );
});

test('the worker is not served with an immutable cache', () => {
  const vercel = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'frontend', 'vercel.json'), 'utf8'),
  );

  const rule = vercel.headers.find((h) => h.source === '/pdf.worker.mjs');
  assert.ok(rule, 'vercel.json must keep an explicit header rule for /pdf.worker.mjs');

  const cache = rule.headers.find((h) => h.key === 'Cache-Control');
  assert.ok(cache, '/pdf.worker.mjs must declare a Cache-Control header');
  assert.doesNotMatch(
    cache.value,
    /immutable/,
    'the worker lives at an unhashed path, so `immutable` makes a bad response ' +
      'permanent for its whole freshness lifetime — it was served as ' +
      'application/octet-stream once and browsers kept it for a year',
  );
  assert.match(
    cache.value,
    /must-revalidate/,
    'the worker must be revalidated, so a corrected response reaches browsers ' +
      'that already hold one',
  );

  const type = rule.headers.find((h) => h.key === 'Content-Type');
  assert.ok(type, '/pdf.worker.mjs must declare its Content-Type explicitly');
  assert.match(
    type.value,
    /javascript/,
    'the worker is an ES module; served as anything else it cannot be imported, ' +
      'and nosniff makes the browser refuse it outright',
  );
});

test('the worker is excluded from the SPA rewrite', () => {
  const vercel = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'frontend', 'vercel.json'), 'utf8'),
  );

  const rewrite = vercel.rewrites.find((r) => r.destination === '/index.html');
  assert.ok(rewrite, 'vercel.json must keep its SPA fallback rewrite');
  assert.match(
    rewrite.source,
    /pdf\\?\.worker/,
    'pdf.worker must stay in the rewrite exclusion, or an unrouted worker path ' +
      'is answered with index.html — an HTML body is not an importable module',
  );
});
