/**
 * Guards the upload size limits against drifting apart.
 *
 * ## The bug this exists for
 *
 * A file is sent as base64 inside a JSON body, so the bytes on the wire are about
 * 4/3 the size of the file. Three numbers have to agree, and they live in two
 * different files:
 *
 *   · the label the user reads          — "File * (Max 10MB)"
 *   · the client-side check             — `file.size > 10 * 1024 * 1024`
 *   · the server's JSON body limit      — `express.json({ limit: '10mb' })`
 *
 * They did not agree. With all three at "10", a 10 MB file produced ~13.3 MB of
 * JSON and was rejected by `body-parser` with a 413 *before any route handler
 * ran* — so the error was a bare "Request failed", naming no limit at all. The
 * real ceiling was about 7.5 MB while the form said 10 MB.
 *
 * That mattered most on a phone, which is the point of this test: camera photos
 * and scans routinely land between 8 MB and 12 MB, so the uploads most likely to
 * be attempted on Android were the ones most likely to be silently refused.
 *
 * The rule: the body limit must exceed the file limit by at least the base64
 * expansion factor, plus room for the rest of the metadata.
 *
 * Run: node --test tests/upload-limits.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(REPO_ROOT, 'backend', 'src', 'server.js');
const UPLOAD = path.join(
  REPO_ROOT, 'frontend', 'src', 'app', 'components', 'DocumentUpload.tsx',
);

const server = fs.readFileSync(SERVER, 'utf8');
const upload = fs.readFileSync(UPLOAD, 'utf8');

/** base64 encodes 3 bytes into 4 characters. */
const BASE64_EXPANSION = 4 / 3;

/** Parses `'16mb'` / `'512kb'` into bytes. */
function parseSize(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) return null;
  const factor = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Number(match[1]) * factor[(match[2] || 'b').toLowerCase()];
}

function serverBodyLimit() {
  const match = server.match(/express\.json\(\s*\{\s*limit:\s*'([^']+)'\s*\}/);
  assert.ok(match, 'expected express.json({ limit }) in server.js');
  return parseSize(match[1]);
}

function clientFileLimit() {
  // The constant is the single source for the client-side ceiling.
  const match = upload.match(/const MAX_UPLOAD_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
  assert.ok(match, 'expected MAX_UPLOAD_BYTES in DocumentUpload.tsx');
  return Number(match[1]) * 1024 * 1024;
}

test('the server body limit leaves room for base64 expansion', () => {
  const body = serverBodyLimit();
  const file = clientFileLimit();

  assert.ok(body > 0, 'the server body limit must be a real size');
  assert.ok(file > 0, 'the client file limit must be a real size');

  const encoded = Math.ceil(file / 3) * 4;
  const headroom = 512 * 1024; // the rest of the multipart-free JSON metadata

  assert.ok(
    body >= encoded + headroom,
    `the server accepts a ${body / 1024 / 1024} MB body, but a permitted ` +
      `${file / 1024 / 1024} MB file arrives as ${(encoded / 1024 / 1024).toFixed(2)} MB ` +
      'of base64 JSON. Anything between the two is rejected with a 413 before any ' +
      'handler runs, so the user is told "Request failed" for a file the form said ' +
      'was acceptable. Raise the limit in server.js or lower MAX_UPLOAD_BYTES.',
  );
});

test('the client-side check uses the shared constant, not a literal', () => {
  // A second copy of the number is how the label and the check drift apart.
  assert.match(
    upload,
    /file\.size\s*>\s*MAX_UPLOAD_BYTES/,
    'handleFileSelect must compare against MAX_UPLOAD_BYTES',
  );
  assert.doesNotMatch(
    upload,
    /file\.size\s*>\s*\d+\s*\*\s*1024\s*\*\s*1024/,
    'a hard-coded size literal is back — it will not stay in step with the server',
  );
});

test('the label the user reads is built from the same constant', () => {
  assert.match(
    upload,
    /Max \{MAX_UPLOAD_LABEL\}/,
    'the "Max …" label must interpolate MAX_UPLOAD_LABEL so it cannot advertise ' +
      'a size the check or the server does not accept',
  );
  assert.doesNotMatch(
    upload,
    /Max 10 ?MB(?!\})/,
    'the label is hard-coded again',
  );
});

test('the upload is reachable on a phone at the advertised size', () => {
  // The concrete regression: an 8 MB photo — an ordinary Android camera output —
  // must fit, because the form tells the user that 10 MB is fine.
  const body = serverBodyLimit();
  const photo = 8 * 1024 * 1024;
  const encoded = Math.ceil(photo / 3) * 4;

  assert.ok(
    encoded < body,
    `an 8 MB photo becomes ${(encoded / 1024 / 1024).toFixed(2)} MB of JSON and ` +
      `must fit inside the ${body / 1024 / 1024} MB body limit; otherwise the ` +
      'uploads most likely to be attempted from a phone are the ones refused',
  );

  const client = clientFileLimit();
  assert.ok(client >= photo, 'the client check must accept an 8 MB photo');
});

test('the expansion factor assumed here matches what the browser produces', () => {
  // The client sends `FileReader.readAsDataURL` output, i.e. a data: URL with
  // base64. Pinned so a future move to a raw multipart upload — which would make
  // the base64 slack unnecessary — fails loudly rather than silently keeping a
  // body limit chosen for the old encoding.
  assert.match(
    upload,
    /readAsDataURL|readAsArrayBuffer/,
    'the upload no longer encodes through FileReader — re-check whether the JSON ' +
      'body limit still needs base64 headroom',
  );
  if (/readAsDataURL/.test(upload)) {
    assert.ok(
      Math.abs(BASE64_EXPANSION - 4 / 3) < Number.EPSILON,
      'base64 expansion is 4/3',
    );
  }
});
