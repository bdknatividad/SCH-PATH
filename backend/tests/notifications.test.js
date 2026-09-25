/**
 * Notification system — visibility, addressee rules, single-writer contract,
 * and event coverage.
 *
 * These tests are deliberately source-level. Everything they pin is a rule that
 * type-checks, lints and builds cleanly while being wrong:
 *
 *   - an alert written with no addressee (visible to nobody),
 *   - a read endpoint that answers 403 instead of 404 (an existence oracle),
 *   - a controller that hand-rolls its own INSERT and forgets `targetUserId`,
 *   - a frontend that filters notifications in the browser instead of trusting
 *     the server, which is what made the badge and the list disagree.
 *
 * None of that fails a compile, and none of it is visible in a diff review.
 * The live half (real HTTP across all seven roles) is in the end-to-end run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notifications = require('../src/services/notificationService');
const residentScope = require('../src/utils/residentScope');
const { RESOURCES } = require('../src/utils/constants');

const SRC = path.resolve(__dirname, '../src');
const FRONTEND = path.resolve(__dirname, '../../frontend/src/app');
const read = (file) => fs.readFileSync(file, 'utf8');

const SERVICE = path.join(SRC, 'services/notificationService.js');
const ALERT_CONTROLLER = path.join(SRC, 'controllers/alertController.js');
const ALERT_ROUTES = path.join(SRC, 'routes/alertRoutes.js');
const ROUTES_INDEX = path.join(SRC, 'routes/index.js');
const SCHEMA = path.join(SRC, 'database/schema.sql');
const SERVER = path.join(SRC, 'server.js');

const DATA_CONTEXT = path.join(FRONTEND, 'state/DataContext.tsx');
const NOTIFICATIONS_UI = path.join(FRONTEND, 'components/Notifications.tsx');

/** The body of a top-level `function name(...) { ... }`, async or not. */
function functionBody(source, name, next) {
  const marker = `function ${name}`;
  const from = source.indexOf(marker);
  assert.ok(from >= 0, `${name}() is missing`);
  const to = source.indexOf(`function ${next}`, from + marker.length);
  return source.slice(from, to > 0 ? to : undefined);
}

/** Every source file under src/, for the single-writer sweep. */
function allSourceFiles(dir = SRC) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return allSourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

// ── One writer ──────────────────────────────────────────────────────────────

test('exactly one module writes to the alerts table', () => {
  // triController used to be the one documented exception to this sweep. It now
  // writes through the service like everything else, so there is no exception
  // left: every source file is checked and the service is the only permitted
  // writer. Re-adding a raw INSERT anywhere — TRI included — fails here.
  const offenders = allSourceFiles()
    .filter((file) => !file.endsWith(path.join('services', 'notificationService.js')))
    .filter((file) => /INSERT INTO alerts/i.test(read(file)))
    .map((file) => path.relative(SRC, file));

  assert.deepEqual(offenders, [],
    'every alert must be written by notificationService.notify()');
});

test('no controller re-implements the read-state write', () => {
  // The old pattern flipped the single shared `isRead` flag on the alerts row,
  // which marked an alert read for every member of a role at once.
  const offenders = allSourceFiles()
    .filter((file) => !file.endsWith(path.join('services', 'notificationService.js')))
    .filter((file) => /UPDATE alerts SET isRead/i.test(read(file)))
    .map((file) => path.relative(SRC, file));

  assert.deepEqual(offenders, [],
    'read state is per user and belongs to notificationService.markRead/markRelatedRead');
});

test('the service is the only place the visibility rule is expressed', () => {
  const source = read(SERVICE);
  assert.match(source, /function visibilityClause/, 'the rule must live in one function');
  assert.match(source, /a\.targetUserId = \?/, 'an alert addressed to me by id must match');
  assert.match(source, /a\.targetRole IS NOT NULL/, 'a role-addressed alert needs a role to match on');
  assert.match(source, /LOWER\(a\.targetRole\) = \?/, 'role matching must be case-insensitive');
  assert.match(source, /a\.actorUsername IS NULL OR LOWER\(a\.actorUsername\) <> LOWER\(\?\)/,
    'the person who caused the event must not be notified about it');
});

test('an alert with no addressee is visible to nobody', () => {
  // This is the rule that makes the 14 legacy broadcast rows harmless. It works
  // by construction — the WHERE clause can only match on targetUserId or
  // targetRole — so it is asserted by reading the generated SQL.
  const { where } = notifications.visibilityClause(
    { id: 'U002', username: 'socialworker', role: 'socialworker' },
    null
  );
  assert.match(where, /targetUserId = \?/, 'must match an alert addressed to me by id');
  assert.match(where, /a\.targetUserId IS NULL\s+AND a\.targetRole IS NOT NULL/,
    'the role branch requires a role to actually be present');
  assert.doesNotMatch(where, /a\.targetRole IS NULL/,
    'there must be no branch that matches a row with no addressee at all');
});

test('notify() refuses to write a notification nobody can read', async () => {
  await assert.rejects(
    () => notifications.notify({ type: 'X', title: 'Y', message: 'Z' }),
    /no addressee/,
    'an event with neither targetUserId nor targetRole must be rejected'
  );
});

test('notify() refuses an incomplete event', async () => {
  for (const missing of ['type', 'title', 'message']) {
    const event = { type: 'X', title: 'Y', message: 'Z', targetRole: 'socialworker' };
    delete event[missing];
    await assert.rejects(
      () => notifications.notify(event),
      /requires/,
      `missing ${missing} must be rejected`
    );
  }
});

test('a caseload-scoped role only ever sees notifications about its own residents', () => {
  const scoped = notifications.visibilityClause(
    { id: 'UHP01', username: 'hp1', role: 'houseparent' },
    ['CH001', 'CH002']
  );
  assert.match(scoped.where, /a\.residentId IS NULL OR a\.residentId IN \(\?, \?\)/,
    'a Houseparent must not see another Houseparent\'s resident');
  assert.deepEqual(scoped.params.slice(-2), ['CH001', 'CH002']);

  // A Social Worker sees the whole facility: no resident predicate at all.
  const broad = notifications.visibilityClause(
    { id: 'U002', username: 'socialworker', role: 'socialworker' },
    null
  );
  assert.doesNotMatch(broad.where, /residentId IN/, 'a non-caseload role is not resident-filtered');
});

test('only Houseparents are caseload-scoped', () => {
  // No other role has a per-child assignment row, so scoping them would lock
  // them out of everything. This pins that decision.
  assert.deepEqual([...residentScope.CASELOAD_SCOPED_ROLES], ['houseparent']);
});

test('the caseload filter applies only to role-addressed notifications', () => {
  // An alert addressed to a specific account is always visible to them. The
  // caseload filter guards the *role* branch, because that is the one that can
  // reach a Houseparent who does not have the child.
  //
  // Getting this nesting wrong is invisible in a diff and breaks the single most
  // important notification of all: "you have been unassigned from CH005" is sent
  // to the Houseparent who no longer has CH005, so an outer filter hides the
  // message telling them their access ended.
  const { where } = notifications.visibilityClause(
    { id: 'UHP01', username: 'hp1', role: 'houseparent' },
    ['CH001']
  );
  const beforeActor = where.slice(0, where.indexOf('AND (a.actorUsername'));
  assert.match(
    beforeActor,
    /LOWER\(a\.targetRole\) = \?\s+AND \(a\.residentId IS NULL OR a\.residentId IN \(\?\)\)/,
    'the resident predicate must be nested inside the role branch'
  );
  assert.doesNotMatch(
    beforeActor,
    /\)\s*\)\s*AND \(a\.residentId IS NULL OR a\.residentId IN/,
    'and must not sit outside it, where it would also filter direct targeting'
  );
});

test('placeholder arity matches the SQL it feeds', () => {
  // A mismatch here silently shifts every parameter — it produced a zero unread
  // count for a user with nine unread alerts. ALERT_SELECT carries one
  // placeholder (the readBy CASE); every query that uses it also joins
  // alertReads with one more, so the pair is what a caller must supply.
  const inSelect = (notifications.ALERT_SELECT.match(/\?/g) || []).length;
  assert.equal(inSelect, 1, 'ALERT_SELECT has exactly the readBy placeholder');
  assert.equal(notifications.selectParams({ id: 'U002', username: 'socialworker' }).length, inSelect + 1,
    'selectParams() must supply the readBy value and the alertReads join key');
  assert.equal(notifications.joinParams({ id: 'U002', username: 'socialworker' }).length, 1,
    'a query that only joins alertReads supplies one parameter');
});

test('selectParams supplies the readBy value before the join key', () => {
  // Order, not just arity. `?` is numbered by position in the SQL text, and the
  // SELECT list is written before the FROM clause — so the readBy CASE in
  // ALERT_SELECT takes the FIRST parameter and the alertReads join takes the
  // SECOND. Returning [id, username] made the join look for a user literally
  // named "centerhead", matched nothing, and reported every notification as
  // unread while the (separately correct) unread count said zero.
  const params = notifications.selectParams({ id: 'U002', username: 'socialworker' });
  assert.deepEqual(params, ['socialworker', 'U002'],
    'the readBy case comes first in the SQL, so the username must come first here');
  assert.equal(params[1], notifications.joinParams({ id: 'U002' })[0],
    'the second value is the join key, and must equal what joinParams supplies');
});

// ── Read-state isolation ────────────────────────────────────────────────────

test('read state is recorded per user, not per row', () => {
  const body = functionBody(read(SERVICE), 'markRead', 'markAllRead');
  assert.match(body, /INSERT INTO alertReads \(alertId, userId/, 'the read must be keyed by user');
  assert.match(body, /ON DUPLICATE KEY UPDATE/, 'marking twice must be idempotent');
  assert.match(body, /alert\.targetUserId && String\(alert\.targetUserId\) === String\(user\.id\)/,
    'the legacy shared flag may only be written for an alert with one possible reader');
});

test('marking a related record read is scoped to the acting user', () => {
  const body = functionBody(read(SERVICE), 'markRelatedRead', 'remove');
  assert.match(body, /INSERT INTO alertReads \(alertId, userId/, 'must write per-user read state');
  assert.match(body, /visibilityClause\(user, scope\)/, 'must reuse the one visibility rule');
  // Computing the clause is not enough — it has to be interpolated into the
  // query, and its parameters bound, or the statement silently loses its filter.
  assert.ok(body.includes('AND ${where}'), 'the visibility clause must be interpolated into the query');
  assert.match(body, /\.\.\.params\]/, 'and its parameters must be bound');
  assert.match(body, /targetUserId = \?/, 'the legacy sync must be limited to alerts addressed to that user');
});

test('mark-all-read is one statement, not a loop over the client\'s list', () => {
  const body = functionBody(read(SERVICE), 'markAllRead', 'markRelatedRead');
  assert.match(body, /INSERT INTO alertReads[\s\S]*SELECT/, 'must be a set-based insert');
  assert.doesNotMatch(body, /for \(/, 'must not loop per alert');
});

// ── The API surface ─────────────────────────────────────────────────────────

test('every alert read path delegates its authorisation to the service', () => {
  const source = read(ALERT_CONTROLLER);
  for (const [name, next] of [
    ['getAll', 'getById'],
    ['getById', 'markAsRead'],
    ['markAsRead', 'markAllAsRead'],
    ['markAllAsRead', 'getUnreadCount'],
    ['getUnreadCount', 'getByResident'],
    ['getByResident', 'getUrgent'],
  ]) {
    const body = functionBody(source, name, next);
    assert.match(body, /notifications\./, `${name}() must go through the notification service`);
  }
});

test('the alert controller owns no SQL at all', () => {
  // Every statement about alerts — reading, writing, marking, deleting — is the
  // service's, so there is one place to audit and one place to get wrong.
  const source = read(ALERT_CONTROLLER);
  assert.doesNotMatch(source, /FROM alerts/i, 'no hand-rolled reads');
  assert.doesNotMatch(source, /(INSERT INTO|UPDATE|DELETE FROM) alerts/i, 'no hand-rolled writes');
  assert.doesNotMatch(source, /pool\.query/, 'the controller must not reach the database directly');
});

test('out-of-scope records answer 404, never 403', () => {
  // A 403 on a read would confirm that another user's notification, or another
  // Houseparent's resident, exists. 403 is only correct on the write paths.
  const source = read(ALERT_CONTROLLER);
  for (const [name, next] of [
    ['getById', 'markAsRead'],
    ['getByResident', 'getUrgent'],
    ['update', 'remove'],
  ]) {
    assert.doesNotMatch(functionBody(source, name, next), /ApiError\(403/,
      `${name}() must not distinguish forbidden from missing`);
  }
  assert.match(source, /ApiError\(404, 'Alert not found'\)/, 'a hidden alert is simply not found');
  assert.match(source, /ApiError\(404, 'Resident not found'\)/, 'so is a resident outside the caseload');
});

test('a resident\'s alerts are scoped to the caller\'s caseload', () => {
  const body = functionBody(read(ALERT_CONTROLLER), 'getByResident', 'getUrgent');
  assert.match(body, /loadResidentScope/, 'must load the caller\'s caseload');
  assert.match(body, /residentInScope/, 'must check the resident is in it');
});

test('only the Center Head and Admin may forge an alert', () => {
  const body = functionBody(read(ALERT_CONTROLLER), 'create', 'update');
  assert.match(body, /hasRole\(req\.user, 'centerhead', 'admin'\)/,
    'POST /alerts must be role-gated — it was open to every authenticated user');
});

test('an incomplete create request answers 400, not 500', async () => {
  // `notify()` raises a *plain* Error for a missing title, message or addressee.
  // The error handler can only map a plain Error to 500, and in production it
  // masks the message to "Internal server error" — so the caller got a server
  // fault with nothing to act on. Measured against the deployed API before this
  // change, every case below answered 500.
  //
  // Driven through the controller rather than read as source text, because the
  // thing under test is the status code that comes back. Validation runs before
  // any database access, so this needs no connection.
  const alertController = require('../src/controllers/alertController');

  const invoke = (user, body) => new Promise((resolve) => {
    const res = {
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    alertController.create({ user, body }, res, (error) => resolve({ error }));
  });

  const manager = { id: 'U001', username: 'centerhead', role: 'centerhead' };

  for (const [label, body] of [
    ['no title', { message: 'm', targetRole: 'nurse' }],
    ['no message', { title: 't', targetRole: 'nurse' }],
    ['no addressee', { title: 't', message: 'm' }],
    ['whitespace-only title', { title: '   ', message: 'm', targetRole: 'nurse' }],
    ['unknown targetRole', { title: 't', message: 'm', targetRole: 'not-a-role' }],
  ]) {
    const { error } = await invoke(manager, body);
    assert.ok(error, `${label}: must be rejected`);
    assert.equal(error.statusCode, 400, `${label}: must be a 400, not a 500`);
  }

  // An unrecognised role is the one that used to be accepted silently, writing a
  // row addressed to a role nobody holds — the same unreadable shape as the
  // legacy addressee-less rows. It has to be refused at the edge.
  const { error: badRole } = await invoke(manager, { title: 't', message: 'm', targetRole: 'not-a-role' });
  assert.match(badRole.message, /Unknown targetRole/, 'the message must name the problem');

  // A non-manager is refused before validation, and that one genuinely is a 403.
  const { error: forbidden } = await invoke({ id: 'U003', username: 'nurse', role: 'nurse' }, {});
  assert.equal(forbidden.statusCode, 403, 'only a manager may forge an alert');
});

test('updating an alert cannot rewrite what it says or who it is for', () => {
  const body = functionBody(read(ALERT_CONTROLLER), 'update', 'delete');
  assert.match(body, /actionTaken/, 'actionTaken is the one editable field');
  for (const forbidden of ['targetRole', 'targetUserId', 'title', 'message']) {
    assert.doesNotMatch(
      body,
      new RegExp(`req\\.body\\??\\.?\\[?['"]?${forbidden}`, 'i'),
      `update() must not accept ${forbidden} from the request body`
    );
  }
});

test('the unread count is scoped to the caller', () => {
  const body = functionBody(read(ALERT_CONTROLLER), 'getUnreadCount', 'getByResident');
  assert.match(body, /unreadCountFor\(req\.user\)/, 'the count must be the caller\'s own');
});

test('mark-all-read is exposed as a single endpoint', () => {
  const source = read(ALERT_ROUTES);
  assert.match(source, /router\.post\('\/mark-all-read'/, 'the endpoint must exist');
  assert.match(source, /markAllAsRead\)\)/, 'and be wired to the controller');
  assert.ok(
    source.indexOf("/mark-all-read") < source.indexOf("'/:id/read'"),
    'it must be registered before the /:id/read route or "mark-all-read" is read as an id'
  );
});

test('the bulk /store endpoint no longer ships the whole alerts table', () => {
  const source = read(ROUTES_INDEX);
  assert.match(source, /tableName === 'alerts'/, '/store must special-case alerts');
  assert.match(source, /notifications\.listFor\(req\.user/, 'and return only the caller\'s own');
});

test('the dashboard summary counts the caller\'s notifications', () => {
  const source = read(path.join(SRC, 'controllers/reportController.js'));
  assert.match(source, /notifications\.listFor\(user, \{ unreadOnly: true \}\)/,
    'the summary must not count every user\'s alerts');
});

// ── Event coverage ──────────────────────────────────────────────────────────

/** Each business event that must produce a notification, and where it lives. */
const EVENT_SITES = [
  // Addressed one row per user against the same REVIEWER_ROLES list that gates
  // approval. It used to be a single role-addressed row, so a Center Head could
  // approve a report they were never told about — the defect the TRI entry below
  // had already been fixed for.
  ['anecdotal submitted for review', 'controllers/anecdotalReportController.js', 'notifyReviewersForReview', 'notifyAuthor', /usersWithAnyRole\(REVIEWER_ROLES[,)]/, /notifyUsers\(/],
  ['anecdotal returned or finalized', 'controllers/anecdotalReportController.js', 'notifyAuthor', 'returnForRevision', /decision === 'Returned'|targetUserId/],
  // The intervention alerts go through createStaffAlert(), so this one asserts on
  // the caller rather than on a direct call to the service.
  ['violation intervention assigned', 'controllers/violationController.js', 'notifyRequiredInterventions', 'buildInsertPayload', /targetRole: '[a-z]+'[\s\S]*?dedupeKey: link\(/, /createStaffAlert\(/],
  ['violation intervention completed', 'controllers/violationController.js', 'markDone', 'getResidentName', /violation:\$\{id\}:intervention-done/],
  ['psych assessment flagged', 'controllers/childController.js', 'togglePsychAssessment', 'getStats', /targetRole: 'psychologist'/],
  ['psych assessment uploaded', 'controllers/documentController.js', 'create', 'approve', /psych-assessment-uploaded/],
  ['document approved or rejected', 'controllers/documentController.js', 'notifyUploaderOfDecision', 'approve', /document:\$\{doc\.id\}:/],
  ['phase completed', 'controllers/phaseController.js', 'complete', 'demote', /phase-progress:\$\{id\}:completed/],
  ['phase demotion', 'controllers/phaseController.js', 'demote', 'getHistory', /phase-progress:\$\{newId\}:demoted/],
  ['houseparent assignment created', 'controllers/assignmentController.js', 'notifyAssignment', 'create', /assignment:\$\{assignment\.id\}:\$\{action\}/],
  ['form 08 submitted for verification', 'controllers/incidentReportController.js', 'create', 'getByViolationId', /incident-report:\$\{newId\}:submitted/],
  ['form 08 verified', 'controllers/incidentReportController.js', 'verify', 'module.exports', /incident-report:\$\{id\}:verified/],
  // The slice delimiter is the next function defined after create(); it used to
  // be getLatestAdmission, which the full-admission-history change removed.
  ['resident admitted', 'controllers/admissionController.js', 'create', 'update', /admission:\$\{admissionId\}:created/],
  ['access request filed', 'controllers/accessRequestController.js', 'create', 'review', /access-request:\$\{id\}:filed/],
  ['access request decided', 'controllers/accessRequestController.js', 'review', 'canReviewRequest', /access-request:\$\{id\}:decision/],
  // TRI submission must reach both reviewer roles. It is addressed one row per
  // user because a single alert row carries one targetRole — the row this
  // replaced was role-addressed to 'socialworker', so a Center Head was never
  // told a TRI was waiting.
  ['TRI submitted for review', 'controllers/triController.js', 'submit', 'review', /usersWithAnyRole\(\['socialworker', 'centerhead', 'admin'\]\)/, /notifyUsers\(/],
  ['TRI sent for reassessment', 'controllers/triController.js', 'returnForRevision', 'finalize', /tri:\$\{record\.id\}:reassessment/, /notifyPreparer\(/],
  ['TRI approved', 'controllers/triController.js', 'finalize', 'referenceViolations', /tri:\$\{record\.id\}:approved/, /notifyPreparer\(/],
];

test('every business event that should notify does notify', () => {
  for (const [label, file, name, next, expected, writes] of EVENT_SITES) {
    const body = functionBody(read(path.join(SRC, file)), name, next);
    assert.match(body, writes || /notifications\.notify|notifyUsers/, `${label}: must write a notification`);
    assert.match(body, expected, `${label}: wrong recipient or missing dedupe key`);
  }
});

test('every notification carries a dedupe key, except where a repeat is a new event', () => {
  // Without a dedupe key, a double-click or a retry produces a second identical
  // row — which is how 36 alerts accumulated for two real requests.
  //
  // Two events are genuinely *new* every time they happen, so a permanent key
  // would be wrong: it would suppress the second occurrence forever. Both are
  // guarded by an atomic status transition in the UPDATE instead, and that guard
  // — not a key — is what makes the notification idempotent.
  //
  //   psych assessment flagged — un-flagging and re-flagging a child is a new
  //     request, so the guard is an atomic 0→1 transition on the flag itself.
  //   TRI submitted for review — a TRI that was returned and then resubmitted
  //     must notify reviewers again. A `submittedAt` key is no safer than a fixed
  //     one, because the column has second precision and a fast return-and-
  //     resubmit lands on the same key, swallowing the resubmission silently.
  const TRANSITION_GUARDED = new Map([
    ['psych assessment flagged', /AND COALESCE\(needsPsychAssessment, 0\) <> \?/],
    ['TRI submitted for review', /WHERE id = \? AND status IN \('Draft', 'Returned', 'For Reassessment'\)/],
  ]);

  for (const [label, file, name, next] of EVENT_SITES) {
    const body = functionBody(read(path.join(SRC, file)), name, next);
    const guard = TRANSITION_GUARDED.get(label);
    if (guard) {
      assert.match(body, guard, `${label}: the transition guard must live in the UPDATE`);
      assert.match(body, /affectedRows|flagChanged/,
        `${label}: the notification must be gated on the transition actually happening`);
      assert.doesNotMatch(body, /dedupeKey/,
        `${label}: a permanent key here would suppress the next occurrence`);
      continue;
    }
    assert.match(body, /dedupeKey/, `${label}: must be idempotent`);
  }
});

test('a document decision actually reaches the uploader', () => {
  // The helper existing is not the same as it being called. Removing the call
  // from approve()/reject() is a one-line change that leaves the helper — and
  // every assertion about it — perfectly intact.
  const docs = read(path.join(SRC, 'controllers/documentController.js'));
  for (const [name, next] of [['approve', 'reject'], ['reject', 'getByResident']]) {
    assert.match(functionBody(docs, name, next), /notifyUploaderOfDecision\(/,
      `${name}() must tell the uploader what happened`);
  }
});

test('a TRI review decision actually reaches the preparer', () => {
  // Same trap as the document uploader above: notifyPreparer() existing is not
  // the same as it being called, and it must address a *user id*. The row it
  // replaces was written with targetRole = null, which the visibility rule
  // treats as addressed to nobody — so the Houseparent was never told anything.
  const tri = read(path.join(SRC, 'controllers/triController.js'));

  for (const [name, next] of [['returnForRevision', 'finalize'], ['finalize', 'referenceViolations']]) {
    assert.match(functionBody(tri, name, next), /notifyPreparer\(/,
      `${name}() must tell the preparer what the reviewer decided`);
  }

  const helper = functionBody(tri, 'notifyPreparer', 'asObject');
  assert.match(helper, /userIdForUsername\(record\.submittedBy\)/,
    'the preparer must be resolved from submittedBy (a username) to a user id');
  assert.match(helper, /targetUserId: preparerId/,
    'and the alert must be addressed to that id, not to a role');
  assert.match(helper, /catch/,
    'a notification failure must not turn a committed review decision into a 500');
});

test('each intervention alert gets its own dedupe key', () => {
  // A violation can require several interventions at once, and two of them are
  // addressed to the same role. Sharing a dedupe key — or dropping one — would
  // make the unique index silently collapse them into a single notification.
  const body = functionBody(
    read(path.join(SRC, 'controllers/violationController.js')),
    'notifyRequiredInterventions',
    'buildInsertPayload'
  );
  const calls = (body.match(/createStaffAlert\(\{/g) || []).length;
  const keys = (body.match(/dedupeKey: link\(/g) || []).length;
  assert.ok(calls >= 3, 'psychosocial, referral and case conference are all possible');
  assert.equal(keys, calls, 'every intervention alert needs its own dedupe key');

  const suffixes = [...body.matchAll(/dedupeKey: link\('([^']+)'\)/g)].map((m) => m[1]);
  assert.equal(new Set(suffixes).size, suffixes.length, 'and they must all be different');
});

test('notifications are not sent for actions nobody needs to hear about', () => {
  // Draft saves, field edits and page views must stay silent.
  const anecdotal = read(path.join(SRC, 'controllers/anecdotalReportController.js'));
  const saveDraft = functionBody(anecdotal, 'update', 'submit');
  assert.doesNotMatch(saveDraft, /notifications\.notify/, 'editing or saving a Draft must not notify');

  // Opening a document, listing children and logging in are reads.
  const docs = read(path.join(SRC, 'controllers/documentController.js'));
  // The end marker has to be a function declared AFTER getByResident: getById
  // sits above it in the file, so slicing to the next "getById" ran to the
  // exports block and swept up approve()/reject(), which legitimately notify.
  assert.doesNotMatch(functionBody(docs, 'getByResident', 'getPending'), /notifications\.notify/,
    'reading documents must not notify');

  // Creating an account is the Center Head's own action and has no other
  // audience — notifying them would be a self-notification, which the service
  // drops anyway. Deliberately not wired.
  const users = read(path.join(SRC, 'controllers/userController.js'));
  assert.doesNotMatch(functionBody(users, 'register', 'getProfile'), /notifications\.notify/,
    'account creation must not notify');
});

// ── Schema and migration ────────────────────────────────────────────────────

test('the schema declares the columns the service writes', () => {
  const schema = read(SCHEMA);
  for (const column of ['targetUserId', 'actorUsername', 'dedupeKey']) {
    assert.match(schema, new RegExp(`\\b${column}\\b`), `schema.sql must declare alerts.${column}`);
  }
  assert.match(schema, /CREATE TABLE alertReads/i, 'alertReads must be declared');
  assert.match(schema, /PRIMARY KEY \(alertId, userId\)/i, 'one read state per (alert, user)');
});

test('the boot migration applies each new column independently', () => {
  // A single try/catch around all of them means one already-applied column
  // masks the rest, and a fresh column silently never appears.
  const server = read(SERVER);
  assert.match(server, /CREATE TABLE IF NOT EXISTS alertReads/i, 'the table must be created at boot');
  for (const column of ['targetUserId', 'actorUsername', 'dedupeKey']) {
    assert.match(server, new RegExp(`'${column}'`), `the migration must add alerts.${column}`);
  }
  assert.match(server, /ER_DUP_FIELDNAME/, 'already-applied columns must be tolerated');
  assert.match(server, /uq_alerts_dedupeKey/, 'the unique dedupe index must be created');
});

test('the generic CRUD layer knows about the new columns', () => {
  // mapRow() strips anything not declared here, so a column can be written and
  // read back correctly and still be missing from every API response.
  for (const column of ['targetUserId', 'actorUsername', 'dedupeKey']) {
    assert.ok(RESOURCES.alerts.columns.includes(column), `RESOURCES.alerts must expose ${column}`);
  }
  assert.ok(RESOURCES.alertReads, 'RESOURCES.alertReads must exist');
  assert.ok(RESOURCES.alertReads.columns.includes('userId'), 'and expose userId');
});

// ── The frontend ────────────────────────────────────────────────────────────

test('the browser no longer filters notifications by role', () => {
  // The server scopes the list. A second, string-comparing filter in the client
  // was the only thing hiding other roles' alerts, and it dropped alerts the
  // user was entitled to whenever the casing differed.
  for (const file of [NOTIFICATIONS_UI, DATA_CONTEXT]) {
    const source = read(file);
    assert.doesNotMatch(source, /roleFilteredAlerts/, `${path.basename(file)} must not re-filter by role`);
    assert.doesNotMatch(
      source,
      /a\.targetRole\s*===/,
      `${path.basename(file)} must not compare targetRole in the browser`
    );
  }
});

test('the unread badge is the server\'s number', () => {
  const context = read(DATA_CONTEXT);
  assert.match(context, /\/alerts\/unread-count/, 'the count must come from the server');

  const ui = read(NOTIFICATIONS_UI);
  assert.match(ui, /const roleUnreadCount = unreadAlertsCount;/,
    'the panel must show the shared count, not recompute it');
  assert.doesNotMatch(ui, /alerts\.filter\(a => !a\.isRead\)\.length/,
    'the badge must not be recomputed from the local array');
});

test('mark-all-as-read uses the single endpoint', () => {
  const context = read(DATA_CONTEXT);
  assert.match(context, /request\('\/alerts\/mark-all-read', \{ method: 'POST' \}\)/,
    'one request, not one per alert');
  assert.doesNotMatch(context, /Promise\.all\(unreadIds\.map/,
    'the per-alert loop must be gone');
});

test('the panel polls notifications without refetching the whole system', () => {
  const ui = read(NOTIFICATIONS_UI);
  assert.match(ui, /setInterval\(\(\) => \{ void refreshAlerts\(\); \}, 30000\)/,
    'polling must refresh only the feed');
  assert.doesNotMatch(ui, /refreshData\(\)/, 'it must not refetch every collection');
});

test('a notification never navigates to a page the user cannot open', () => {
  const ui = read(NOTIFICATIONS_UI);
  assert.match(ui, /const canReach = \(path: string\)/, 'destinations must be checked against module access');
  assert.match(ui, /return canReach\(target\) \? target : fallbackPath\(\);/,
    'an unreachable destination must fall back');
  assert.match(ui, /const CHILD_TABS = new Set\(/, 'child tabs must be validated');
  assert.match(ui, /'personal', 'timeline', 'education', 'medical', 'behavioral'/,
    'and only contain tabs that exist');
  assert.doesNotMatch(ui, /'case'/, '"case" is not a ChildDetail tab — it rendered an empty panel');
});

test('an intervention alert opens the Intervention Tracker', () => {
  const ui = read(NOTIFICATIONS_UI);
  assert.match(ui, /case 'Violation Intervention':[\s\S]*?'\/intervention-tracker'/,
    'that is where the work is actually done, and it is reachable by every role');
});
