/**
 * Guards the Quarterly Progress Report PDF endpoints against shipping a body
 * that is not a PDF.
 *
 * ## The bug this exists for
 *
 * Both `getPdf` and `getTemplate` generated a buffer and `res.send()`-ed it with
 * `Content-Type: application/pdf`, without ever looking at the bytes. The client
 * renders those bytes with pdf.js, so a generator fault did not surface as a
 * server error — it surfaced as "Unable to display the report form.", a sentence
 * about the *viewer*, on a screen with nothing to act on. That is the least
 * actionable shape a failure can take: it points at the side that is working.
 *
 * `sendPdf` checks the `%PDF-` signature before writing anything, so a bad
 * payload becomes an honest 500 while the fault is still where it happened.
 *
 * Run: node --test tests/pdf-payload-guard.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { sendPdf } = require('../src/controllers/quarterlyProgressReportController');

/** The smallest `res` that records what the controller tried to write. */
function fakeRes() {
  return {
    headers: {},
    body: undefined,
    setHeader(key, value) { this.headers[key] = value; },
    send(body) { this.body = body; },
  };
}

test('sendPdf sends a real PDF with the filename the caller chose', () => {
  const res = fakeRes();
  const buffer = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('trailer')]);

  sendPdf(res, buffer, 'Quarterly Progress Report (form).pdf');

  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.equal(
    res.headers['Content-Disposition'],
    'inline; filename="Quarterly Progress Report (form).pdf"',
  );
  assert.equal(res.body, buffer);
});

test('sendPdf strips quotes so the filename cannot break the header', () => {
  const res = fakeRes();

  sendPdf(res, Buffer.from('%PDF-1.7\n'), 're"port.pdf');

  assert.equal(res.headers['Content-Disposition'], 'inline; filename="report.pdf"');
});

test('sendPdf refuses a body that is not a PDF, and writes nothing', () => {
  const notPdfs = [
    ['empty', Buffer.from('')],
    ['html', Buffer.from('<!DOCTYPE html><html></html>')],
    ['truncated signature', Buffer.from('PDF-1.7')],
    ['json error body', Buffer.from('{"success":false}')],
    ['not a buffer', 'a string'],
    ['missing', undefined],
  ];

  for (const [label, bad] of notPdfs) {
    const res = fakeRes();

    assert.throws(
      () => sendPdf(res, bad, 'x.pdf'),
      (error) => {
        assert.equal(error.statusCode, 500, `${label}: must be a server fault, not a 200`);
        assert.match(error.message, /could not be generated as a PDF/);
        return true;
      },
      `a body of type "${label}" must not be sent as a PDF`,
    );

    assert.equal(
      res.body,
      undefined,
      `${label}: nothing may be written once the payload is known to be unusable`,
    );
  }
});
