/**
 * Guards the API base URL against being bypassed.
 *
 * ## The bug this exists for
 *
 * `request()` in `services/api.ts` builds `${API_BASE_URL}${path}`, so every call
 * that goes through it resolves against the configured API host. The binary and
 * PDF endpoints cannot use it — they need a `Blob` or an object URL, not parsed
 * JSON — so they call `fetch()` directly. Those were written with a literal
 * `'/api/...'`, which the browser resolves against the *page* origin.
 *
 * In the split deployment (frontend on Vercel, API on Render) the page origin is
 * Vercel. So `/api/documents/<id>/file` never reached the API at all: Vercel's SPA
 * rewrite turned it into `index.html`, `res.ok` came back true, and the "file"
 * was a copy of the app's own HTML. That silently broke View, Download, Print,
 * bulk ZIP, the Anecdotal Report PDF and the Quarterly Progress Report PDF — and
 * it broke them identically on every device, because the fault is in the page
 * origin rather than in anything device-specific.
 *
 * The same class of mistake was already fixed once in `api.ts` itself (see the
 * comment on `API_BASE_URL`, which describes the identical symptom for the
 * non-binary calls). These raw fetches were missed, so this test closes the gap
 * statically rather than relying on someone noticing at runtime.
 *
 * The binary callers now go through `fetchBinary()` in `api.ts`, which joins the
 * base URL and *also* refuses a body that is not a file — because a 200 carrying
 * `index.html` satisfies `res.ok`, and the caller's next step was to hand those
 * bytes to pdf.js and report a failure to *display* the document. That is why
 * reading a response as a Blob is pinned to that one function below.
 *
 * Run: node --test tests/api-base-url.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'frontend', 'src');

/** Every .ts/.tsx file under frontend/src, excluding build output. */
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

/** Strips comments, so prose about the bug is not mistaken for the bug. */
function withoutComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Escapes a literal string so it can be embedded in a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('no source file builds a URL from a bare /api/ literal', () => {
  // A literal `'/api/...'` in a fetch resolves against the page origin. It only
  // appears to work when the backend serves the frontend from the same origin,
  // which is not how this is deployed.
  const offenders = [];

  for (const file of sourceFiles(SRC)) {
    const raw = fs.readFileSync(file, 'utf8');
    const code = withoutComments(raw);

    code.split('\n').forEach((line, index) => {
      // A string or template literal that starts a path with /api/.
      if (!/['"`]\/api\//.test(line)) return;
      // `apiUrl('/api/...')`, `${API_BASE_URL}/api/...` and the fallback in
      // api.ts itself are all correct.
      if (/apiUrl\(/.test(line) || /API_BASE_URL/.test(line)) return;

      offenders.push(
        `${path.relative(REPO_ROOT, file).replace(/\\/g, '/')}:${index + 1}  ${line.trim()}`,
      );
    });
  }

  assert.deepEqual(
    offenders,
    [],
    'these build a URL from a bare "/api/" literal, which resolves against the ' +
      'page origin instead of the configured API host. In the split deployment ' +
      'the request never reaches the API — Vercel rewrites it to index.html and ' +
      "the caller receives the app's HTML with a 200. Use apiUrl() from " +
      'services/api.ts:\n  ' + offenders.join('\n  '),
  );
});

test('the binary endpoints resolve through the configured API host', () => {
  // Pinned explicitly because these are the endpoints that were broken, and they
  // are the ones a person notices: View, Download, Print and the PDF generators.
  //
  // They go through `fetchBinary` now rather than `apiUrl` + a bare `fetch`. The
  // invariant is unchanged — the path is still joined to the configured base in
  // exactly one place — but it is checked one level down, in a form a bare
  // `fetch` that merely *looks* right cannot satisfy.
  const expectations = [
    ['utils/documentFile.ts', '/documents/${doc.id}/file'],
    ['app/components/DocumentUpload.tsx', '/documents/${doc.id}/file'],
    ['app/components/PhaseProgress.tsx', '/documents/${doc.id}/file'],
    ['app/components/AnecdotalReports.tsx', '/anecdotal-reports/${encodeURIComponent(record.id)}/pdf'],
    ['app/components/QuarterlyProgressReport.tsx', '/quarterly-progress-reports/${encodeURIComponent(report.id)}/pdf'],
    ['app/components/QuarterlyProgressReport.tsx', '/quarterly-progress-reports/${encodeURIComponent(reportId)}/template'],
  ];

  for (const [relPath, fragment] of expectations) {
    const file = path.join(SRC, ...relPath.split('/'));
    const code = withoutComments(fs.readFileSync(file, 'utf8'));

    // `\s*` because the call may be wrapped: a long path is usually put on its
    // own line, and a pin that only matched the single-line spelling would fail
    // on formatting rather than on behaviour.
    const call = new RegExp(`fetchBinary\\(\\s*\`${escapeRegExp(fragment)}\``);

    assert.match(
      code,
      call,
      `${relPath} must fetch \`${fragment}\` through fetchBinary(), so the request ` +
        'reaches the API host rather than the page origin and a response that is ' +
        'not a file is reported as such',
    );
  }
});

test('fetchBinary is the only place a binary body is read', () => {
  // The shape of the original bug was `fetch` -> `res.ok` -> `res.blob()`. Every
  // clause of that is satisfied by a 200 carrying the app's own `index.html`,
  // which is what an unrouted API path returns in the split deployment. Reading
  // a body as a Blob is therefore only allowed inside `fetchBinary`, where the
  // status *and* the shape are checked. A `/forms/*.pdf` asset is a static file
  // served by the frontend itself and is unaffected — it is read as an
  // ArrayBuffer and is not an API call.
  const offenders = [];

  for (const file of sourceFiles(SRC)) {
    if (file.endsWith(path.join('services', 'api.ts'))) continue;
    const code = withoutComments(fs.readFileSync(file, 'utf8'));
    code.split('\n').forEach((line, index) => {
      if (/\.blob\(\)/.test(line)) {
        offenders.push(
          `${path.relative(REPO_ROOT, file).replace(/\\/g, '/')}:${index + 1}  ${line.trim()}`,
        );
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    'these read a fetch response as a Blob outside fetchBinary(), so a 200 that ' +
      "is really the app's HTML would be handed on as if it were the file. Use " +
      'fetchBinary() from services/api.ts:\n  ' + offenders.join('\n  '),
  );
});

test('fetchBinary refuses a response that is not the file that was asked for', () => {
  const api = withoutComments(fs.readFileSync(path.join(SRC, 'services', 'api.ts'), 'utf8'));

  assert.match(
    api,
    /export async function fetchBinary\(/,
    'fetchBinary() must be exported — it is the shared guard for the binary endpoints',
  );
  assert.match(
    api,
    /fetch\(apiUrl\(path\)/,
    'fetchBinary() must resolve its path through apiUrl(), so the base URL is ' +
      'still joined in one place',
  );
  assert.match(
    // Flattened, so the pin does not depend on how the guard happens to be
    // wrapped — and `[^;]` keeps it inside the one statement, rather than
    // letting `.*` wander off to some later `throw`.
    api.replace(/\s+/g, ' '),
    /if \([^;]*text\/html[^;]*\) \{ throw new Error\(/,
    'fetchBinary() must *throw* on an HTML body: the frontend host answers an ' +
      'unrouted path with index.html and a 200, which passes an `ok` check, so ' +
      'merely noticing the content type is not enough',
  );
  assert.match(
    api,
    /did not reach the API/,
    'fetchBinary() must say the request never reached the API when the body is a ' +
      'web page, rather than leaving the caller to report a parse failure',
  );
});

test('the API base URL is exported for the callers that cannot use request()', () => {
  const api = fs.readFileSync(path.join(SRC, 'services', 'api.ts'), 'utf8');

  assert.match(
    api,
    /export\s*\{\s*API_BASE_URL\s*\}/,
    'API_BASE_URL must be exported, or the raw-fetch callers cannot build a ' +
      'correct URL without duplicating the resolution logic',
  );
  assert.match(
    api,
    /export function apiUrl\(/,
    'apiUrl() must be exported — it is the single place the base URL is joined ' +
      'to a path, so a trailing-slash mistake can only exist in one spot',
  );
  assert.match(
    api,
    /export function authHeaders\(/,
    'authHeaders() must be exported so the raw fetches attach the token the ' +
      'same way the rest of the app does',
  );

  // The fallback is what keeps the single-service deployment working with no
  // configuration, and is why the bug only appeared after splitting the hosts.
  assert.match(
    api,
    /import\.meta\.env\.VITE_API_URL\s*\?\?\s*'\/api'/,
    'the base URL must fall back to the same-origin /api when VITE_API_URL is unset',
  );
});

test('the static asset fetches stay same-origin', () => {
  // `/forms/*.pdf` are files copied into the frontend's own output directory, not
  // API calls. They must resolve against the page origin and must NOT be routed
  // through apiUrl(), which would send them to the backend and 404.
  const offenders = [];

  for (const file of sourceFiles(SRC)) {
    const code = withoutComments(fs.readFileSync(file, 'utf8'));
    for (const match of code.matchAll(/apiUrl\(\s*[`'"]([^`'"]+)/g)) {
      if (match[1].startsWith('/forms/')) offenders.push(path.relative(REPO_ROOT, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a /forms/ asset is served by the frontend itself; sending it through ' +
      'apiUrl() points it at the backend, where it does not exist:\n  ' +
      offenders.join('\n  '),
  );
});
