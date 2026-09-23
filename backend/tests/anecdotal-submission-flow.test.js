/**
 * Anecdotal Report submission flow — Houseparent access, Draft/Submit, and the
 * Social Worker's review queue.
 *
 * These tests are mostly source-level on purpose. The behaviour they pin is a
 * set of rules that type-check and build cleanly when broken: a Submit button
 * rendered for the wrong role, a status guard removed, a notification addressed
 * to nobody, a reviewer list that offers the wrong actions. None of that fails a
 * compile, and the API-level half is covered by the end-to-end run described in
 * AUDIT_REPORT §21.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const controller = require('../src/controllers/anecdotalReportController');

const CONTROLLER = path.resolve(__dirname, '../src/controllers/anecdotalReportController.js');
const EDITOR = path.resolve(__dirname, '../../frontend/src/app/components/AnecdotalReports.tsx');
const REPORTS = path.resolve(__dirname, '../../frontend/src/app/components/Reports.tsx');
const NOTIFICATIONS = path.resolve(__dirname, '../../frontend/src/app/components/Notifications.tsx');

const read = (file) => fs.readFileSync(file, 'utf8');

/** The body of a top-level `async function name(...) { ... }`. */
function functionBody(source, name, next) {
  const from = source.indexOf(`async function ${name}`);
  assert.ok(from >= 0, `${name}() is missing`);
  const to = source.indexOf(`async function ${next}`, from + 1);
  return source.slice(from, to > 0 ? to : undefined);
}

/** The section keys the frontend actually renders, in form order. */
function frontendSectionKeys() {
  return [...read(EDITOR).matchAll(
    /\{\s*key:\s*'([^']+)',\s*label:\s*'[^']*',\s*page:\s*\d+/g
  )].map((m) => m[1]);
}

// ── The completeness rule ───────────────────────────────────────────────────

test('a report is incomplete until every section of the official form is filled', () => {
  const complete = Object.fromEntries(controller.REQUIRED_CONTENT_KEYS.map((k) => [k, 'noted']));

  assert.equal(controller.REQUIRED_CONTENT_KEYS.length, 10, 'the official form has ten sections');
  assert.equal(controller.missingRequiredFields({ reportDate: '2026-09-16', content: complete }).length, 0);
  assert.equal(controller.missingRequiredFields({ reportDate: '2026-09-16', content: {} }).length, 10);
  assert.equal(controller.missingRequiredFields({ reportDate: '', content: complete }).join(', '), 'Report date');
});

test('whitespace is not an answer', () => {
  const complete = Object.fromEntries(controller.REQUIRED_CONTENT_KEYS.map((k) => [k, 'noted']));
  const padded = { ...complete, behavioral: '   \n\t ' };
  assert.deepEqual(controller.missingRequiredFields({ reportDate: '2026-09-16', content: padded }), ['Behavioral']);
});

test('the API and the form agree on which sections are required', () => {
  // If a section is added to the form and not to CONTENT_LABELS, the frontend
  // would gate on a field the backend does not check (or vice versa) and one of
  // the two would silently let an incomplete report through.
  assert.deepEqual(controller.REQUIRED_CONTENT_KEYS, frontendSectionKeys());
  assert.match(read(EDITOR), /const REQUIRED_SECTION_KEYS = textFields\.map\(field => field\.key\)/,
    'the frontend required set must be derived from the rendered fields, not hand-listed');
});

test('submit() refuses an incomplete report instead of sending a blank one to the reviewer', () => {
  const body = functionBody(read(CONTROLLER), 'submit', 'review');
  assert.match(body, /missingRequiredFields\(row\)/, 'submit() must check completeness');
  assert.match(body, /throw new ApiError\(400/, 'an incomplete report must be a 400, not a silent success');
});

// ── Duplicate submissions ───────────────────────────────────────────────────

test('submit() cannot be won twice by two concurrent requests', () => {
  const body = functionBody(read(CONTROLLER), 'submit', 'review');
  // The status must be part of the WHERE clause. Reading the status and then
  // writing it unconditionally is what allowed a double-click to submit twice.
  assert.match(body, /WHERE id=\? AND status IN \('Draft','Returned'\)/,
    'the status flip must be a conditional UPDATE');
  assert.match(body, /result\.affectedRows === 0/, 'the losing request must be detected and rejected');
});

test('submit() commits the status change and its notification together', () => {
  const body = functionBody(read(CONTROLLER), 'submit', 'review');
  assert.match(body, /runInTransactionWithIdRetry\(pool, async \(connection\)/,
    'the flip and the notification are two writes and must be one transaction');
  assert.match(body, /notifySocialWorkersForReview\(connection,/,
    'the notification must run on the transaction connection, not the pool');
});

// ── The notification ────────────────────────────────────────────────────────

test('the notification is addressed to the Social Worker and links to the report', () => {
  const source = read(CONTROLLER);
  const from = source.indexOf('async function notifySocialWorkersForReview');
  assert.ok(from > 0, 'notifySocialWorkersForReview() is missing');
  const body = source.slice(from, source.indexOf('\nasync function', from + 1));
  const notify = body > '' ? body : source.slice(from, from + 2000);

  // The write must go through notificationService, which is the single writer
  // and the single owner of the visibility rule. Hand-rolling an INSERT here is
  // what left half the recipients unreachable in the first place.
  assert.match(notify, /notifications\.notify\(/, 'must reuse the existing Notifications table via the service');
  assert.doesNotMatch(notify, /INSERT INTO alerts/, 'must not hand-roll SQL — the service owns the write');
  assert.match(notify, /targetRole[\s\S]*'socialworker'/, 'must target the socialworker role');
  assert.match(notify, /relatedRecordType[\s\S]*'Anecdotal Report'/, 'must record what the alert is about');
  assert.match(notify, /report\.id/, 'must link to the exact report');
  assert.match(notify, /dedupeKey/, 'must carry a dedupe key so a retry cannot double-notify');
  assert.match(notify, /needs review/i, 'the message must say a report needs review');
});

test('the notification opens the report in the reviewer queue', () => {
  const source = read(NOTIFICATIONS);
  // The destination table is now a switch, so this pins the branch rather than
  // the old `&&` expression.
  assert.match(source, /case 'anecdotal report':[\s\S]*?relatedRecordId[\s\S]*?\/reports\?tab=review&anecdotalId=/,
    'Notifications.tsx must special-case the Anecdotal Report alert and deep-link to Needs Review');
});

test('Reports.tsx honours that deep link', () => {
  const source = read(REPORTS);
  assert.match(source, /get\('anecdotalId'\)/, 'Reports must read anecdotalId from the URL');
  assert.match(source, /get\('tab'\) === 'review'/, 'Reports must open the Needs Review tab');
});

// ── Reviewer actions ────────────────────────────────────────────────────────

test('a reviewer can approve or reject a report without a separate "start review" step', () => {
  assert.deepEqual(controller.REVIEWABLE_STATUSES, ['Submitted', 'Under Review']);

  const reject = functionBody(read(CONTROLLER), 'returnForRevision', 'finalize');
  const approve = functionBody(read(CONTROLLER), 'finalize', 'getPdf');
  for (const [name, body] of [['returnForRevision', reject], ['finalize', approve]]) {
    assert.match(body, /REVIEWABLE_STATUSES\.includes\(row\.status\)/,
      `${name}() must act on a Submitted report, not only an Under Review one`);
  }

  const editor = read(EDITOR);
  assert.match(editor, /const REVIEWABLE_STATUSES = \['Submitted', 'Under Review'\]/,
    'the UI must offer the same two statuses the API accepts');
  // Match the button and its handler, not the prose explaining their removal.
  assert.ok(!/beginReview/.test(editor), 'the intermediate "Start Review" handler must be gone');
  assert.ok(!/> Start Review</.test(editor), 'no "Start Review" button may remain');
});

test('approving publishes the PDF and rejecting removes it', () => {
  const approve = functionBody(read(CONTROLLER), 'finalize', 'getPdf');
  assert.match(approve, /syncDocumentForReport\(row, actor\)/, 'Approve must publish to Documents');

  const reject = functionBody(read(CONTROLLER), 'returnForRevision', 'finalize');
  assert.match(reject, /unpublishDocumentForReport\(row\.id, actor\)/,
    'Reject must remove any published document and publish nothing');
});

// ── Role boundaries ─────────────────────────────────────────────────────────

test('only a Houseparent is offered the Submit button', () => {
  const source = read(EDITOR);
  // Submission is a Houseparent action. A Social Worker looking at the same
  // report gets Approve/Reject instead.
  assert.match(source, /\{isHouseparent && isEditable && \(/,
    'the Submit button must be gated on the Houseparent role');
  assert.ok(!/isReportAuthor && isEditable && <Button onClick=\{requestSubmit\}/.test(source),
    'Submit must not be offered to every report author');
});

test('the Houseparent resident picker is limited to the assigned caseload', () => {
  const source = read(EDITOR);
  assert.match(source, /'\/resident-assignments\/caseload'/, 'the editor must read the caller\'s caseload');
  assert.match(source, /assignedResidentIds \? activeChildren\.filter/,
    'the picker must be restricted to assigned residents');
  assert.match(source, /selectableChildren\.map\(child =>/,
    'the picker must render the restricted list');
  // Failing open would show every resident in the facility if the caseload call
  // errored, which is exactly the access the backend would then refuse.
  assert.match(source, /\.catch\(\(\) => \{ if \(!cancelled\) setAssignedResidentIds\(new Set\(\)\); \}\)/,
    'an unreadable caseload must fail closed');
});

test('the resident picker only reads the caller\'s own caseload card, not every HP\'s', () => {
  // /resident-assignments/caseload now returns one card per HP 1–HP 10 slot
  // (so the Case Load roster can mirror the Center Head's view). The picker
  // must pick out the caller's own card by id/username before reading its
  // residents — folding every card's residents together would hand a
  // Houseparent the whole facility's caseload, not just their own.
  const source = read(EDITOR);
  assert.match(source, /find\(\(entry\) =>[\s\S]{0,200}entry\?\.userId/,
    'the caller\'s own caseload entry must be located by id/username before its residents are read');
  assert.ok(
    !/for \(const entry of res\?\.data \|\| \[\]\)/.test(source),
    'residents must not be aggregated across every caseload entry'
  );
});

// ── Confirmation ────────────────────────────────────────────────────────────

test('submitting asks for confirmation and No leaves the report editable', () => {
  const source = read(EDITOR);
  assert.match(source, /Are you sure you want to submit this report\?/,
    'the confirmation must use the exact wording the user asked for');
  assert.match(source, /onClick=\{\(\) => setShowSubmitConfirm\(false\)\}[\s\S]{0,80}>[\s\S]{0,40}No/,
    'the No button must only dismiss the dialog');
  assert.match(source, /onClick=\{confirmSubmit\}/, 'the Yes button must perform the submission');
  // The dialog is a gate, not a second editor: Yes must be the only path to submit.
  assert.ok(!/requestSubmit\(\)[\s\S]{0,200}await request/.test(source),
    'requestSubmit() must not itself call the API');
});

test('submitting an unsaved report saves it first, so Drafts need not be opened', () => {
  const source = read(EDITOR);
  const from = source.indexOf('async function confirmSubmit');
  assert.ok(from > 0, 'confirmSubmit() is missing');
  const body = source.slice(from, source.indexOf('\n  async function', from + 1));
  assert.match(body, /selectedRecord\s*\n?\s*\?[\s\S]*method: 'PUT'[\s\S]*:[\s\S]*method: 'POST'/,
    'confirmSubmit() must update an existing report and create a missing one');
  assert.ok(!/Save the report before submitting/.test(body),
    'an unsaved report must no longer block submission');
});

// ── The reviewer list ───────────────────────────────────────────────────────

test('the Needs Review list offers only View and Download', () => {
  const source = read(REPORTS);
  const from = source.indexOf('function AnecdotalReviewQueue');
  assert.ok(from > 0, 'AnecdotalReviewQueue is missing');
  const to = source.indexOf('\nfunction ', from + 1);
  const queue = source.slice(from, to > 0 ? to : undefined);

  assert.match(queue, /Download<\/Button>/, 'Download must be offered');
  assert.match(queue, /> View<\/Button>/, 'View must be offered');
  // Deciding a report belongs inside the report, not on a list row.
  assert.ok(!/Accept \/ Reject/.test(queue), 'the list must not offer Accept / Reject');
  assert.ok(!/> Review<\/Button>/.test(queue), 'the list must not offer a generic Review action');
  assert.ok(!/onClick=\{finalize\}|onClick=\{returnForRevision\}/.test(queue),
    'the list must not call the approve/reject endpoints directly');
});

test('the queue refreshes after a report is decided', () => {
  const source = read(REPORTS);
  assert.match(source, /reloadToken = 0/, 'the queue must accept a reload token');
  assert.match(source, /useEffect\(\(\)=>\{load\(\);\},\[reloadToken\]\)/, 'and reload when it changes');
  assert.match(source, /onStatusChange=\{\(\) => setReviewReloadToken\(t => t \+ 1\)\}/,
    'the embedded reviewer must tell the queue to reload');
  assert.match(read(EDITOR), /onStatusChange\?\.\(\)/,
    'AnecdotalReports must invoke the callback after Approve and Reject');
});
