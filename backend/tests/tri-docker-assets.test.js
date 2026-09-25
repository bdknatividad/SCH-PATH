/**
 * Every file the backend reads out of the frontend tree at request time must be
 * present in the Docker image.
 *
 * ## The bug this exists for
 *
 * `backend/Dockerfile` builds with the repository root as its context but copies
 * only the frontend assets the backend actually reads. `triReportPdf.js` resolves
 * `frontend/src/shared/triLayout.json` and `loadLayout()` reads it unconditionally
 * — "Throws rather than silently drawing nothing". That path was never added to
 * the COPY list, so inside the container the read failed with `ENOENT`.
 *
 * Nothing about the build fails, which is what makes it dangerous: the TRI is
 * approved, `publishDocumentForTri` throws, and its non-fatal `catch` logs the
 * error and answers `documentId: null`. The reviewer sees "TRI approved." and the
 * official form is filed nowhere in the resident's Documents. Measured live on
 * 2026-09-25:
 *
 *   POST /api/tri/TRI003/finalize → 200, documentId: null
 *   GET  /api/documents          → no row carries a triRecordId
 *
 * The same shape of omission is invisible in review, because the Dockerfile lists
 * a handful of unrelated files and a missing line looks exactly like a file nobody
 * needed.
 *
 * ## Why the check is by basename
 *
 * Each helper declares a *list* of candidate paths and uses the first that reads
 * successfully (`frontend/public/forms/...`, then `frontend/dist/forms/...`). Only
 * one candidate has to survive into the image for the feature to work, so the rule
 * is "at least one candidate for this asset is copied", not "every candidate is".
 * `dist/` candidates are build output and are never present — that is fine, as long
 * as the `public/` one is there.
 *
 * Only string literals passed to `path.resolve(...)` count as reads: that is the
 * shape every runtime lookup uses, and it excludes paths that merely appear in
 * prose or in a log message.
 *
 * Run: node --test tests/tri-docker-assets.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'backend', 'src');
const DOCKERFILE = path.join(REPO_ROOT, 'backend', 'Dockerfile');

function jsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') jsFiles(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/** A frontend path in a comment is not a read — the whole point is to check reads. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** @returns {Array<{file: string, target: string}>} repo-relative frontend paths. */
function runtimeReads() {
  const found = [];
  for (const file of jsFiles(SRC)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    // The trailing `\.[ext]` matters: `server.js` also resolves the `frontend/dist`
    // *directory* to serve the SPA, and that one is deliberately absent from the
    // API-only image. Only files are covered by this rule.
    const pattern = /path\.resolve\([^)]*?['"`]([^'"`]*frontend\/[^'"`]+\.[A-Za-z0-9]+)['"`]/g;
    for (const match of code.matchAll(pattern)) {
      const index = match[1].indexOf('frontend/');
      found.push({
        file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
        target: match[1].slice(index),
      });
    }
  }
  return found;
}

/** @returns {string[]} the `COPY <source>` paths that come out of the frontend tree. */
function dockerfileCopies() {
  const lines = fs.readFileSync(DOCKERFILE, 'utf8').split('\n');
  const sources = [];
  for (const line of lines) {
    const match = line.match(/^\s*COPY\s+(?:--\S+\s+)*(\S+)/);
    if (match && match[1].startsWith('frontend/')) sources.push(match[1]);
  }
  return sources;
}

/** A COPY of a directory covers everything under it; a COPY of a file covers itself. */
function isCopied(target, copies) {
  return copies.some(source => target === source || target.startsWith(`${source}/`));
}

const basename = (p) => p.split('/').pop();

test('every frontend asset the backend reads at runtime is copied into the image', () => {
  const reads = runtimeReads();
  const copies = dockerfileCopies();

  // A floor, so the check cannot pass by finding nothing to check. If this trips,
  // the extraction broke (a new helper shape?) rather than the Dockerfile.
  assert.ok(
    reads.length >= 8,
    `expected to find the backend's runtime reads of the frontend tree, found ${reads.length}. ` +
      'If the extraction regex is right, this is a real loss of coverage.',
  );
  assert.ok(copies.length >= 2, `expected COPY lines from the frontend tree, found ${copies.length}`);

  const groups = new Map();
  for (const read of reads) {
    const key = basename(read.target);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(read);
  }

  const uncovered = [];
  for (const [name, entries] of groups) {
    const targets = [...new Set(entries.map((entry) => entry.target))];
    if (targets.some((target) => isCopied(target, copies))) continue;
    uncovered.push(
      `  ${name}\n` +
        targets.map((t) => `      ${t}`).join('\n') +
        `\n      read by: ${[...new Set(entries.map((e) => e.file))].join(', ')}`,
    );
  }

  assert.deepEqual(
    uncovered,
    [],
    'the backend reads these from the frontend tree at request time, but no COPY line ' +
      'in backend/Dockerfile puts them in the image. The build still succeeds and the ' +
      'feature fails only when it is used:\n' +
      uncovered.join('\n'),
  );
});

test('the TRI layout is copied, because publishing an approved TRI needs it', () => {
  // Named explicitly: this is the asset whose absence produced the reported bug,
  // and the generic check above would go quiet if the extraction ever narrowed.
  const copies = dockerfileCopies();
  assert.ok(
    isCopied('frontend/src/shared/triLayout.json', copies),
    'frontend/src/shared/triLayout.json must be copied — triReportPdf.loadLayout() ' +
      'reads it unconditionally, and without it an approved TRI is filed nowhere',
  );

  const reads = runtimeReads().filter((r) => r.target.endsWith('triLayout.json'));
  assert.ok(reads.length >= 1, 'triLayout.json is no longer read by the backend — remove this test');
});

test('the shared JSON the overlay geometry depends on is the same file both sides read', () => {
  // The frontend imports it too; a copy into the image must be the same content,
  // so the check is that the path exists in the repo at the copied location.
  const copies = dockerfileCopies().filter((c) => c.includes('triLayout.json'));
  for (const source of copies) {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, source)),
      `${source} is copied into the image but does not exist in the repository`,
    );
  }
});
