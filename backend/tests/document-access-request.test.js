/**
 * Document access + Request Access + Pending Review + Approve/Reject.
 *
 * The rules being pinned here are exactly the kind that compile and build
 * cleanly when broken:
 *
 *   - a read that authorises on the role but forgets the caller's caseload
 *   - a reviewer rule that lets you approve your own request
 *   - a grant that is applied to the UI but never persisted
 *   - three copies of the same permission map that quietly disagree, where a
 *     missing key means "everyone" rather than "nobody"
 *
 * The pure rules are exercised directly. `canReviewRequest` needs one document
 * lookup, so it runs against an injected pool stub — no MySQL instance and no
 * network are required. The wiring (which controller calls which rule) is
 * asserted at source level, which is this project's established way of pinning
 * a rule that has no frontend test runner behind it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const DB_MODULE_PATH = require.resolve('../src/config/database');

// ── Injected pool stub ─────────────────────────────────────────────────────
// Only canReviewRequest's "load the document" query reaches the database, so
// the stub answers that one statement from a table the tests control and
// returns an empty result set for everything else.
let documentsTable = [];
// The completed-request rows `getHistory` reads. Kept separate so a test can set
// one without disturbing the other.
let historyTable = [];

const poolStub = {
  async query(sql, params) {
    const text = String(sql);
    if (/FROM documents WHERE id = \?/i.test(text)) {
      const id = params && params[0];
      return [documentsTable.filter((row) => row.id === id)];
    }
    // The history listing joins `documents` and `children`; the stub answers it
    // from `historyTable` so the scoping and the status filter can be asserted
    // without a database. It honours the statement's own `WHERE status IN (?)`
    // so the filter under test is the one the controller actually sent.
    if (/FROM accessRequests ar/i.test(text)) {
      const statuses = Array.isArray(params && params[0]) ? params[0] : null;
      const rows = statuses
        ? historyTable.filter((row) => statuses.includes(row.status))
        : historyTable;
      return [rows];
    }
    return [[]];
  },
  async getConnection() {
    return {
      query: poolStub.query,
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
    };
  },
};

for (const key of Object.keys(require.cache)) {
  if (key.startsWith(SRC_ROOT) && !key.includes('node_modules')) delete require.cache[key];
}
require.cache[DB_MODULE_PATH] = {
  id: DB_MODULE_PATH,
  filename: DB_MODULE_PATH,
  loaded: true,
  exports: { pool: poolStub, dbConfig: {}, testConnection: async () => true },
};

const docs = require('../src/controllers/documentController');
const accessRequests = require('../src/controllers/accessRequestController');

const { documentVisibleTo, residentInScope, canReadDocument, CASELOAD_SCOPED_ROLES } = docs;
const { canReviewRequest } = accessRequests;
const rbac = require('../src/config/rbac');

/** A scope with no grants and no caseload restriction. */
const UNSCOPED = { approvedDocumentIds: [], allowedResidentIds: null };
/** A caseload-restricted scope (what a Houseparent gets). */
const scopedTo = (...residentIds) => ({ approvedDocumentIds: [], allowedResidentIds: residentIds });

const read = (file) => fs.readFileSync(file, 'utf8');

/** The body of a top-level function, up to the next top-level declaration. */
function bodyOf(source, signature, nextSignature) {
  const from = source.indexOf(signature);
  assert.ok(from >= 0, `${signature} is missing`);
  const to = source.indexOf(nextSignature, from + 1);
  return source.slice(from, to > 0 ? to : undefined);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

// A Court Order is readable by socialworker/centerhead only (title rule), and
// its category is a phase label that matches no category rule.
const courtOrder = {
  id: 'DOC001', title: 'Court Order', category: 'Orientation Phase - Required',
  residentId: 'CH001', createdBy: null, uploadedBy: null, submittedBy: null,
};
// Anecdotal Reports are readable by houseparent/socialworker/centerhead.
const anecdotal = {
  id: 'DOC004', title: 'Anecdotal Report — September 2026', category: 'Anecdotal',
  residentId: 'CH001', createdBy: null, uploadedBy: null, submittedBy: null,
};
// A psychological instrument is readable by psychologist/centerhead only.
const psychological = {
  id: 'DOC005', title: 'Psychological Testing', category: '',
  residentId: 'CH001', createdBy: null, uploadedBy: null, submittedBy: null,
};
// Facility-wide paperwork carries no residentId and must never be caseload-filtered.
const facilityDoc = {
  id: 'DOC020', title: 'Facility Handbook', category: '', residentId: null,
};

const nurse = { id: 'U004', username: 'nurse', role: 'nurse' };
const socialWorker = { id: 'U002', username: 'socialworker', role: 'socialworker' };
const psychologist = { id: 'U003', username: 'psychologist', role: 'psychologist' };
const centerHead = { id: 'U001', username: 'centerhead', role: 'centerhead' };
const admin = { id: 'U099', username: 'admin', role: 'admin' };
const houseparent = { id: 'UHP01', username: 'hp1', role: 'houseparent' };

// ── The read rule ──────────────────────────────────────────────────────────

test('the caseload-scoped roles are exactly the ones with a real assignment', () => {
  // Only Houseparent qualifies. This is a fact about the schema, not a policy
  // preference: residentAssignments.assignmentType only ever holds
  // 'houseparent'/'household' and children has no per-staff column, so
  // "my assigned child" is not expressible for any other role. Scoping
  // Psychologist/Educator/Nurse here would lock them out of everything.
  assert.deepEqual([...CASELOAD_SCOPED_ROLES], ['houseparent']);
});

test('an unscoped role is never restricted by caseload', () => {
  for (const user of [centerHead, admin, socialWorker, psychologist, nurse]) {
    assert.equal(residentInScope(courtOrder, user, null), true, `${user.role} must not be caseload-filtered`);
  }
});

test('a scoped role reaches only its own residents', () => {
  assert.equal(residentInScope(courtOrder, houseparent, ['CH001']), true);
  assert.equal(residentInScope(courtOrder, houseparent, ['CH002', 'CH003']), false);
  assert.equal(residentInScope(courtOrder, houseparent, []), false, 'an unassigned Houseparent sees nothing');
});

test('a facility-wide document is not caseload-filtered', () => {
  assert.equal(residentInScope(facilityDoc, houseparent, ['CH002']), true);
});

test('an uploader keeps their own upload even after a reassignment', () => {
  const ownUpload = { ...courtOrder, uploadedBy: 'hp2' };
  const reassigned = { id: 'UHP02', username: 'hp2', role: 'houseparent' };
  assert.equal(residentInScope(ownUpload, reassigned, ['CH009']), true);
});

test('the role rules still decide, and caseload can only narrow them', () => {
  assert.equal(canReadDocument(courtOrder, centerHead), true);
  assert.equal(canReadDocument(courtOrder, admin), true);
  assert.equal(canReadDocument(courtOrder, socialWorker), true);
  assert.equal(canReadDocument(courtOrder, nurse), false, 'a Nurse has no claim on a Court Order');
  assert.equal(canReadDocument(courtOrder, houseparent), false);
  assert.equal(canReadDocument(anecdotal, houseparent), true, 'Anecdotal Reports are readable by Houseparents');
});

test('a role that passes the type rules is still refused outside its caseload', () => {
  // Anecdotal passes for houseparent by type, but the resident is not theirs.
  assert.equal(documentVisibleTo(anecdotal, houseparent, scopedTo('CH002')), false);
  assert.equal(documentVisibleTo(anecdotal, houseparent, scopedTo('CH001')), true);
  // And a caseload match cannot manufacture a role permission that is absent.
  assert.equal(documentVisibleTo(courtOrder, houseparent, scopedTo('CH001')), false);
});

test('an approved request is a grant in its own right', () => {
  // It overrides the type rules entirely: this is the whole point of asking.
  assert.equal(documentVisibleTo(courtOrder, nurse, UNSCOPED), false);
  assert.equal(
    documentVisibleTo(courtOrder, nurse, { approvedDocumentIds: ['DOC001'], allowedResidentIds: null }),
    true
  );
  // And it is deliberately sticky — an explicit human decision outlives a later
  // caseload change, which is what "persistent access to that one document"
  // means. It grants that document only.
  assert.equal(
    documentVisibleTo(courtOrder, houseparent, { approvedDocumentIds: ['DOC001'], allowedResidentIds: ['CH999'] }),
    true
  );
  assert.equal(
    documentVisibleTo(anecdotal, houseparent, { approvedDocumentIds: ['DOC001'], allowedResidentIds: ['CH999'] }),
    false,
    'a grant for one document must not leak to another'
  );
});

// ── The reviewer rule ──────────────────────────────────────────────────────

test('nobody may decide their own request, whatever their role', async () => {
  const request = { id: 'ACC1', requesterId: 'U001', requesterRole: 'centerhead', status: 'Pending', documentId: 'DOC001' };
  assert.equal(await canReviewRequest(centerHead, request, UNSCOPED), false);
  const byAdmin = { ...request, requesterId: 'U099' };
  assert.equal(await canReviewRequest(admin, byAdmin, UNSCOPED), false);
});

test('a request can only be decided once', async () => {
  for (const status of ['Approved', 'Rejected']) {
    const request = { id: 'ACC1', requesterId: 'U002', status, documentId: 'DOC001' };
    assert.equal(await canReviewRequest(centerHead, request, UNSCOPED), false, `${status} must not be re-decidable`);
  }
});

test('Center Head and Administrator may decide any pending request', async () => {
  const request = { id: 'ACC1', requesterId: 'U002', status: 'Pending', documentId: 'DOC001' };
  for (const role of ['centerhead', 'Center Head', 'CENTERHEAD', 'admin', 'Admin']) {
    assert.equal(await canReviewRequest({ id: 'U001', username: 'x', role }, request, UNSCOPED), true, `role ${role}`);
  }
});

test('another role may decide only a document request they can already read', async () => {
  documentsTable = [courtOrder];
  const request = { id: 'ACC1', requesterId: 'U007', status: 'Pending', documentId: 'DOC001' };

  assert.equal(await canReviewRequest(socialWorker, request, UNSCOPED), true, 'the Social Worker owns Court Orders');
  assert.equal(await canReviewRequest(nurse, request, UNSCOPED), false, 'a Nurse cannot read it, so cannot decide it');
  assert.equal(await canReviewRequest(psychologist, request, UNSCOPED), false);
});

test('a reviewer outside their own caseload cannot decide', async () => {
  documentsTable = [anecdotal]; // an Anecdotal Report for CH001 — readable by Houseparents
  const request = { id: 'ACC1', requesterId: 'U007', status: 'Pending', documentId: 'DOC004' };

  // Readable because CH001 is theirs.
  assert.equal(await canReviewRequest(houseparent, request, scopedTo('CH001')), true);
  // A Houseparent assigned elsewhere cannot read it, so cannot decide it.
  assert.equal(await canReviewRequest(houseparent, request, scopedTo('CH002')), false);
  assert.equal(await canReviewRequest(houseparent, request, scopedTo()), false);
});

test('caseload is necessary but not sufficient — the type rule still has to pass', async () => {
  // A Court Order for a resident this Houseparent IS assigned to is still not
  // theirs to read (socialworker/centerhead only), so it is not theirs to
  // decide either. The caseload filter narrows access; it never widens it.
  documentsTable = [courtOrder];
  const request = { id: 'ACC1', requesterId: 'U007', status: 'Pending', documentId: 'DOC001' };
  assert.equal(await canReviewRequest(houseparent, request, scopedTo('CH001')), false);
  // The Social Worker, who owns Court Orders, can.
  assert.equal(await canReviewRequest(socialWorker, request, UNSCOPED), true);
});

test('a request for a document that no longer exists cannot be decided', async () => {
  documentsTable = [];
  const request = { id: 'ACC1', requesterId: 'U007', status: 'Pending', documentId: 'DOC-GONE' };
  assert.equal(await canReviewRequest(socialWorker, request, UNSCOPED), false);
  assert.equal(await canReviewRequest(centerHead, request, UNSCOPED), true, 'a manager still clears the dead row');
});

test('a module or tab request is a manager decision, not a document decision', async () => {
  documentsTable = [];
  const moduleRequest = { id: 'ACC2', requesterId: 'U007', status: 'Pending', documentId: null, moduleName: 'Reports' };

  assert.equal(await canReviewRequest(centerHead, moduleRequest, UNSCOPED), true);
  assert.equal(await canReviewRequest(socialWorker, moduleRequest, UNSCOPED), false);
  assert.equal(await canReviewRequest(nurse, moduleRequest, UNSCOPED), false);

  // The one historical exception: a psychologist-addressed request.
  const addressed = { ...moduleRequest, targetRole: 'psychologist' };
  assert.equal(await canReviewRequest(psychologist, addressed, UNSCOPED), true);
  assert.equal(await canReviewRequest(psychologist, moduleRequest, UNSCOPED), false,
    'the exception must not apply to a request addressed elsewhere');
});

// ── The requester's side ───────────────────────────────────────────────────

test('asking for a document you can already read is refused with 409', () => {
  const body = bodyOf(read(path.resolve(__dirname, '../src/controllers/accessRequestController.js')),
    'async function create', 'async function review');

  assert.ok(/await canReadDocumentAsync\(document, req\.user/.test(body),
    'the "you already have access" check must use the scoped rule, or a Houseparent ' +
    'outside the caseload would be told they already have access to a document they cannot open');
  assert.ok(!/if \(canReadDocument\(document, req\.user\)\)/.test(body),
    'the unscoped check must be gone');
});

test('you cannot request a document outside your own caseload', () => {
  const body = bodyOf(read(path.resolve(__dirname, '../src/controllers/accessRequestController.js')),
    'async function create', 'async function review');

  assert.ok(/!residentInScope\(document, req\.user, scope\.allowedResidentIds\)/.test(body),
    'create() must refuse a document outside the caller\'s resident scope');
  // And it must refuse it as *missing*, not as forbidden — otherwise the
  // endpoint tells a Houseparent which document ids exist for other children.
  const guard = body.slice(body.indexOf('!residentInScope('), body.indexOf('!residentInScope(') + 260);
  assert.ok(/throw new ApiError\(404, 'Document not found'\)/.test(guard),
    'an out-of-scope document must be indistinguishable from one that does not exist');
  assert.ok(!/ApiError\(403/.test(guard), 'a 403 would confirm the document exists');
});

test('a request records the role the requester held when they asked', () => {
  const source = read(path.resolve(__dirname, '../src/controllers/accessRequestController.js'));

  assert.ok(/requesterRole/.test(source), 'requesterRole must be declared');
  // normalizeRole() takes a role STRING. Passing the user object stringifies it
  // to "[object Object]" and every role check silently fails — this assertion
  // exists because that mistake was made once already.
  assert.ok(/normalizeRole\(req\.user\?\.role\)/.test(source),
    'the stored role must be normalized from user.role, not from the user object');
  assert.ok(!/normalizeRole\(req\.user\)/.test(source),
    'normalizeRole() must never be handed the whole user object');
  assert.ok(/ADD COLUMN requesterRole VARCHAR\(50\) NULL AFTER requesterUsername/.test(source),
    'the column must be added at runtime for databases created before it existed');
  assert.ok(/requesterRole VARCHAR\(50\) NULL/.test(source), 'and declared in the CREATE TABLE');
});

test('the new column survives mapRow', () => {
  // mapRow() strips any key that is not declared in RESOURCES[table].columns,
  // so a column can be written correctly, read back correctly, and still be
  // missing from every API response. The requesterRole is rendered by the
  // reviewer queue, so it has to be declared in all three places.
  const { RESOURCES } = require('../src/utils/constants');
  assert.ok(RESOURCES.accessRequests.columns.includes('requesterRole'),
    'requesterRole must be declared in RESOURCES.accessRequests.columns or mapRow drops it');
});

test('a duplicate pending request is refused rather than queued twice', () => {
  const body = bodyOf(read(path.resolve(__dirname, '../src/controllers/accessRequestController.js')),
    'async function create', 'async function review');
  assert.ok(/status = 'Pending'/.test(body) && /A matching access request is already pending/.test(body),
    'the duplicate guard must look only at Pending rows, so a rejected request can be re-asked');
});

// ── The decision ───────────────────────────────────────────────────────────

test('review() delegates its authority to the one reviewer rule', () => {
  const body = bodyOf(read(path.resolve(__dirname, '../src/controllers/accessRequestController.js')),
    'async function review', 'module.exports');

  assert.ok(/await canReviewRequest\(req\.user, request\)/.test(body),
    'review() must use canReviewRequest, which enforces pending-only, no-self-approval and readability');
  assert.ok(!/let authorized =/.test(body), 'the old ad-hoc authorization expression must be gone');
  assert.ok(/throw new ApiError\(409, 'Access request has already been reviewed'\)/.test(body),
    'the already-decided case must stay a 409, reported before the 403');
});

test('an approval is the grant, and rejection preserves the record', () => {
  const body = bodyOf(read(path.resolve(__dirname, '../src/controllers/accessRequestController.js')),
    'async function review', 'module.exports');

  // The approved row itself is what getApprovedDocumentIds() reads.
  assert.ok(/SET status = \?, reviewedBy = \?, reviewedById = \?, reviewedAt = NOW\(\)/.test(body),
    'the decision must be written to the row');
  // The reviewer is recorded by stable id as well as by printed name, because
  // the history is scoped by the id — a name moves when an account is renamed.
  assert.ok(/\[decision, req\.user\.username, req\.user\.id, reviewerNote \|\| null, id\]/.test(body),
    'the reviewer must be recorded by user id, not only by username');
  assert.ok(/reviewerNote = COALESCE\(\?, reviewerNote\)/.test(body),
    'an omitted note must not erase a previously stored one');
  // Nothing deletes the row: rejection keeps the history.
  assert.ok(!/DELETE FROM accessRequests/.test(body), 'a decision must never delete the request');
});

test('the grant is read back on every later request, not held in the session', () => {
  const source = read(path.resolve(__dirname, '../src/controllers/documentController.js'));
  const body = bodyOf(source, 'async function getApprovedDocumentIds', 'async function canReadDocumentAsync');

  assert.ok(/FROM accessRequests/.test(body) && /status = 'Approved'/.test(body),
    'grants must be read from the database, so they survive signing out');
  assert.ok(/requesterId = \?/.test(body), 'grants must be scoped to the requester');
});

// ── The wiring: a rule that is not called is not enforced ──────────────────

test('the listing shows your own requests plus the ones you may decide', () => {
  const body = bodyOf(read(path.resolve(__dirname, '../src/controllers/accessRequestController.js')),
    'async function getAll', 'async function create');

  assert.ok(/await canReviewRequest\(req\.user, row, scope\)/.test(body),
    'getAll must apply the same reviewer rule as review()');
  assert.ok(/isRequester/.test(body), 'the caller must be able to see their own requests in every state');
  assert.ok(/canReview/.test(body), 'the reviewer flag must be reported so the UI can decide what to render');
});

test('the scoped rule is applied on every path that hands documents to a client', () => {
  const controllerSource = read(path.resolve(__dirname, '../src/controllers/documentController.js'));
  const routesSource = read(path.resolve(__dirname, '../src/routes/index.js'));
  const childSource = read(path.resolve(__dirname, '../src/controllers/childController.js'));

  // 1. the document module's own list. Scoped to the function body on purpose:
  // matching the whole file would also match the function's own declaration
  // line, which makes the assertion vacuous.
  const visible = bodyOf(controllerSource, 'async function visibleDocuments', 'async function getApprovedDocumentIds');
  assert.ok(/documentVisibleTo\(document, user, scope\)/.test(visible),
    'visibleDocuments must go through documentVisibleTo');
  // 2. the requestable list — a Houseparent must not even see the metadata
  const requestable = bodyOf(controllerSource, 'async function getRequestableDocuments', 'function withoutFileData');
  // Not `documentVisibleTo`: that one is used inverted here (`!documentVisibleTo`
  // means "cannot read it, so it is requestable"). The line that keeps another
  // child's documents off the list is the resident-scope filter.
  assert.ok(/residentInScope\(document, req\.user, scope\.allowedResidentIds\)/.test(requestable),
    'getRequestableDocuments must exclude documents outside the caller\'s caseload entirely');
  // 3. the bulk /store load that feeds the whole SPA
  assert.ok(/loadDocumentScope\(req\.user\)/.test(routesSource) && /documentVisibleTo\(/.test(routesSource),
    'the bulk store load must apply the same rule, or the caseload filter is trivially bypassed');
  // 4. a child's document tab
  assert.ok(/documentVisibleTo\(/.test(childSource) && /loadDocumentScope/.test(childSource),
    'childController.getById must filter a child\'s documents by the same rule');
});

test('the single-document paths authorise before serving bytes', () => {
  const source = read(path.resolve(__dirname, '../src/controllers/documentController.js'));
  for (const [fn, next] of [['getFile', 'getById'], ['getById', 'getRequestableDocuments']]) {
    const body = bodyOf(source, `async function ${fn}`, `async function ${next}`);
    assert.ok(/getReadableDocument|canReadDocumentAsync|documentVisibleTo/.test(body),
      `${fn}() must authorise the document before returning it`);
  }
});

// ── One permission map, three copies ───────────────────────────────────────

/**
 * Read a `DOCUMENT_ROLE_PERMISSIONS` block into `{ title: [roles] }`.
 *
 * The map is duplicated in three files, so the test has to parse all three
 * rather than trust any one of them.
 */
function permissionMap(file, marker) {
  const source = read(file);
  const from = source.indexOf(marker);
  assert.ok(from >= 0, `DOCUMENT_ROLE_PERMISSIONS not found in ${file}`);
  const to = source.indexOf('\n};', from);
  assert.ok(to > from, `the map in ${file} is not terminated`);

  const entries = {};
  for (const line of source.slice(from, to).split('\n')) {
    const match = line.match(/^\s*'([^']+)':\s*\[([^\]]*)\],?\s*$/);
    if (!match) continue;
    entries[match[1]] = match[2]
      .split(',')
      .map((role) => role.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
      .sort();
  }
  return entries;
}

const BACKEND_MAP = permissionMap(
  path.resolve(__dirname, '../src/utils/constants.js'),
  'const DOCUMENT_ROLE_PERMISSIONS = {'
);
const UPLOAD_MAP = permissionMap(
  path.resolve(__dirname, '../../frontend/src/app/components/DocumentUpload.tsx'),
  'const DOCUMENT_ROLE_PERMISSIONS: Record<string, string[]> = {'
);
const PHASE_MAP = permissionMap(
  path.resolve(__dirname, '../../frontend/src/app/components/PhaseProgress.tsx'),
  'const DOCUMENT_ROLE_PERMISSIONS: Record<string, string[]> = {'
);

test('all three copies of the permission map exist and were parsed', () => {
  // Guards the parser: a silently empty map would make the equality tests below
  // pass for the wrong reason.
  for (const [name, map] of [['backend', BACKEND_MAP], ['DocumentUpload', UPLOAD_MAP], ['PhaseProgress', PHASE_MAP]]) {
    assert.ok(Object.keys(map).length >= 20, `${name} parsed only ${Object.keys(map).length} entries`);
    assert.equal(map['Court Order'].join(','), 'centerhead,socialworker', `${name} mis-parsed the roles`);
  }
});

test('the backend and the upload picker agree on who may upload what', () => {
  assert.deepEqual(UPLOAD_MAP, BACKEND_MAP,
    'a key present in one map and missing from the other is not "nobody" — every lookup ' +
    'treats undefined as "every role", so a missing entry is a permission hole');
});

test('the phase view agrees too', () => {
  assert.deepEqual(PHASE_MAP, BACKEND_MAP);
});

test('every document type offered by a phase has a permission entry', () => {
  // A type reachable from PHASE_REQUIREMENTS but absent from the map would be
  // uploadable by any role.
  const source = read(path.resolve(__dirname, '../../frontend/src/app/components/DocumentUpload.tsx'));
  const from = source.indexOf('const PHASE_REQUIREMENTS');
  const block = source.slice(from, source.indexOf('\n};', from));

  // Only the two document lists are scanned. Scraping every quoted string in
  // the block also picked up `requiredTasks` — phase *tasks* such as
  // "Counseling sessions" are not document types and correctly have no
  // permission entry, so scraping them made this test assert the opposite of
  // what it documents. The picker itself only ever iterates these two lists.
  const offered = new Set();
  for (const match of block.matchAll(/(requiredDocuments|optionalDocuments):\s*\[([^\]]*)\]/g)) {
    for (const title of match[2].matchAll(/'([^']+)'/g)) offered.add(title[1]);
  }
  assert.ok(offered.size >= 10, `only ${offered.size} document titles were scraped`);

  for (const title of offered) {
    assert.ok(BACKEND_MAP[title], `"${title}" is offered by a phase but has no permission entry`);
  }
});

// ── The UI states ──────────────────────────────────────────────────────────

const UPLOAD_TSX = path.resolve(__dirname, '../../frontend/src/app/components/DocumentUpload.tsx');

test('the UI distinguishes pending from rejected, instead of collapsing both to "No Access"', () => {
  const source = read(UPLOAD_TSX);
  assert.ok(/function accessStatusBadge/.test(source), 'the three-state badge helper must exist');

  const body = bodyOf(source, 'function accessStatusBadge', 'interface DocListProps');
  assert.ok(/Access Pending/.test(body));
  assert.ok(/Request Rejected/.test(body));
  assert.ok(/No Access/.test(body));
  // The old two-state expression must be gone from both render sites.
  assert.equal((source.match(/=== 'Pending' \? 'Access Pending' : 'No Access'/g) || []).length, 0,
    'the two-state badge is still rendered somewhere');
  assert.equal((source.match(/accessStatusBadge\(/g) || []).length, 3,
    'both the flat list and the folder view must use the helper');
});

test('a rejected request shows the reviewer\'s reason to the requester', () => {
  const source = read(UPLOAD_TSX);
  assert.ok(/accessRequestNote/.test(source), 'the note must be carried onto the document row');
  assert.ok(/Access request rejected/.test(source), 'the requester must be told the request was rejected');
  assert.ok(/Reviewer note:/.test(source), 'and why');
});

test('a pending request cannot be sent twice from the UI', () => {
  const source = read(UPLOAD_TSX);
  assert.equal((source.match(/disabled=\{doc\.accessRequestStatus === 'Pending'\}/g) || []).length, 2,
    'both Request Access buttons must be disabled while a request is pending');
});

test('the reviewer queue only renders for people who may actually decide', () => {
  const source = read(UPLOAD_TSX);
  assert.ok(/const requestsToReview = useMemo\(/.test(source));
  assert.ok(/row\.canReview && row\.status === 'Pending'/.test(source),
    'the queue must be driven by the server\'s canReview flag, not by a client-side role list');
});

test('the decision is sent to the server, and the UI reloads rather than guessing', () => {
  const source = read(UPLOAD_TSX);
  const body = bodyOf(source, 'const submitReviewRequest', 'const handleFileSelect');

  assert.ok(/\/access-requests\/\$\{reviewRequestTarget\.id\}\/review/.test(body),
    'the decision must go to POST /access-requests/:id/review');
  assert.ok(/decision: reviewRequestDecision/.test(body));
  assert.ok(/await Promise\.all\(\[refreshData\(\), loadAccessData\(\)\]\)/.test(body),
    'an approval changes what is readable, so the document list and the request list must both reload');
});

test('a rejection carries a reason', () => {
  const source = read(UPLOAD_TSX);
  assert.ok(/reviewRequestDecision === 'Rejected' && !reviewRequestNote\.trim\(\)/.test(source),
    'the Reject action must require a note so the requester is never left guessing');
});

test('the requester can see the history of their own requests', () => {
  const source = read(UPLOAD_TSX);
  assert.ok(/const myAccessRequests = useMemo\(/.test(source));
  assert.ok(/Your access requests/.test(source));
  // The three states are spelled out as the facility names them: a decided
  // request reads "Approved" or "Rejected", not "Access Granted" / "Request
  // Rejected". Anything else and the requester has to translate.
  assert.ok(/>Approved</.test(source), 'an approved request must read "Approved"');
  assert.ok(/>Rejected</.test(source), 'a rejected request must read "Rejected"');
  assert.ok(/>Access Pending</.test(source), 'a pending request must still read "Access Pending"');
});

test('an approved request offers View, Print and Download', () => {
  const source = read(UPLOAD_TSX);
  // The approval is what unlocks the file, so the row that announces it has to
  // carry the actions that read it. A green badge on its own leaves the
  // requester hunting for the document in another tab.
  assert.ok(
    /row\.status === 'Approved'/.test(source),
    'the approved row is not treated specially'
  );
  assert.ok(/const documentForRequest = /.test(source), 'there is no lookup from a request to its document');
  assert.ok(/<Eye className="h-3\.5 w-3\.5" \/> View/.test(source), 'the approved row has no View action');
  assert.ok(/<Printer className="h-3\.5 w-3\.5" \/> Print/.test(source), 'the approved row has no Print action');
  assert.ok(/<Download className="h-3\.5 w-3\.5" \/> Download/.test(source), 'the approved row has no Download action');
});

test('the requester\'s document state is refreshed on focus, not only on mount', () => {
  const source = read(UPLOAD_TSX);
  // loadAccessData must be called from the focus listener path as well.
  assert.ok(/window\.addEventListener\('focus'/.test(source), 'the focus listener must still exist');
  assert.ok(/useEffect\(\(\) => \{\s*loadAccessData\(\);\s*\}, \[loadAccessData, user, documents\.length\]\)/.test(source),
    'the access data must reload when the document list changes');
});

// ── View is not approval authority ────────────────────────────────────────
//
// The Psychologist specification: "A user's ability to view a document does not
// automatically grant approval authority." Before this rule the read rule WAS
// the approval authority, so any role that could read a document could also
// decide who else was allowed to — for the Psychologist, effectively a global
// approval right over every document it could reach.

test('the Psychologist cannot decide a document request even for a document it can read', async () => {
  documentsTable = [psychological];
  const request = { id: 'ACC1', requesterId: 'U007', status: 'Pending', documentId: 'DOC005' };

  // Reading it is granted — the title rule is psychologist/centerhead.
  assert.equal(canReadDocument(psychological, psychologist), true, 'the Psychologist reads its own documents');
  // Deciding it is not.
  assert.equal(
    await canReviewRequest(psychologist, request, UNSCOPED),
    false,
    'reading a document is not authority to decide who else may read it',
  );
  // The Center Head decides it. The Social Worker holds the approve capability
  // but cannot read a psychological instrument, so the capability is necessary
  // and still not sufficient — the type rule continues to apply.
  assert.equal(await canReviewRequest(centerHead, request, UNSCOPED), true);
  assert.equal(
    await canReviewRequest(socialWorker, request, UNSCOPED),
    false,
    'holding approve does not override the document-type read rule',
  );
});

test('a role with no caseload boundary needs the approve capability to decide', async () => {
  // A Court Order is readable by socialworker/centerhead. With an unbounded scope
  // the caseload filter does not narrow it, so the only remaining authority is
  // the approve capability — reading it is not enough.
  documentsTable = [courtOrder];
  const request = { id: 'ACC1', requesterId: 'U007', status: 'Pending', documentId: 'DOC001' };

  const holdsApprove = (role) => rbac.can({ role }, 'Documents', 'approve');
  assert.equal(holdsApprove('socialworker'), true, 'the Social Worker holds Documents approve');
  assert.equal(holdsApprove('psychologist'), false);
  assert.equal(holdsApprove('nurse'), false);
  assert.equal(holdsApprove('educator'), false);
  assert.equal(holdsApprove('houseparent'), false);

  assert.equal(await canReviewRequest(nurse, request, UNSCOPED), false, 'a Nurse holds no approve capability');
  assert.equal(await canReviewRequest(psychologist, request, UNSCOPED), false);
  assert.equal(await canReviewRequest(socialWorker, request, UNSCOPED), true);
});

test('a caseload-bounded caller decides its own residents without the approve capability', async () => {
  // The exception that keeps the Houseparent workflow intact: their document
  // scope is bounded by assignment, so "can read" already means "responsible for
  // this child". The capability requirement applies only where the scope is
  // unbounded.
  documentsTable = [anecdotal];
  const request = { id: 'ACC1', requesterId: 'U007', status: 'Pending', documentId: 'DOC004' };

  assert.equal(rbac.can({ role: 'houseparent' }, 'Documents', 'approve'), false);
  assert.equal(await canReviewRequest(houseparent, request, scopedTo('CH001')), true);
  assert.equal(await canReviewRequest(houseparent, request, scopedTo('CH002')), false);

  // An unbounded scope is not the exception, so the capability is required.
  assert.equal(await canReviewRequest(houseparent, request, UNSCOPED), false);
});

test('the Psychologist still decides a module request addressed to the Psychologist role', async () => {
  // The scoped exception the specification allows: a request the workflow
  // addressed to this role. It is a module/tab request, so no document read is
  // involved and the capability gate does not apply.
  documentsTable = [];
  const addressed = {
    id: 'ACC2', requesterId: 'U007', status: 'Pending',
    documentId: null, moduleName: 'Reports', targetRole: 'psychologist',
  };
  assert.equal(await canReviewRequest(psychologist, addressed, UNSCOPED), true);

  const elsewhere = { ...addressed, targetRole: 'nurse' };
  assert.equal(await canReviewRequest(psychologist, elsewhere, UNSCOPED), false);

  const unaddressed = { ...addressed, targetRole: null };
  assert.equal(await canReviewRequest(psychologist, unaddressed, UNSCOPED), false);
});

// ── Access Request History ─────────────────────────────────────────────────
//
// The permanent audit trail of completed (Approved / Rejected) decisions. The
// gap this closes: `getAll` returns the caller's own requests plus the *Pending*
// ones they may decide, so a decision drops out of the list the moment it is
// taken and the reviewer can never re-read it.

/** Calls `getHistory` with a fake req/res and returns the payload it wrote. */
async function runHistory(user, query = {}) {
  let payload = null;
  const res = { json(body) { payload = body; return this; } };
  let failure = null;
  await accessRequests.getHistory({ user, query }, res, (error) => { failure = error; });
  if (failure) throw failure;
  return payload;
}

const completedRequests = [
  {
    id: 'ACC01', requesterId: 'U007', requesterUsername: 'hp1', status: 'Approved',
    reviewedBy: 'socialworker', reviewedAt: '2026-03-04 10:00:00', reviewerNote: null,
    documentId: 'DOC001', documentTitle: 'Court Order', documentFileName: 'court.pdf',
    documentCategory: 'Legal', residentName: 'Resident One', residentId: 'CH001',
  },
  {
    id: 'ACC02', requesterId: 'U008', requesterUsername: 'nurse', status: 'Rejected',
    reviewedBy: 'centerhead', reviewedAt: '2026-03-05 09:30:00', reviewerNote: 'Not required for your role.',
    documentId: 'DOC005', documentTitle: 'Psychological Testing', documentFileName: 'psych.pdf',
    documentCategory: 'Psychological', residentName: 'Resident Two', residentId: 'CH002',
  },
  {
    id: 'ACC03', requesterId: 'U009', requesterUsername: 'educator1', status: 'Pending',
    reviewedBy: null, reviewedAt: null, reviewerNote: null,
    documentId: 'DOC004', documentTitle: 'Anecdotal Report — March 2026', documentFileName: 'anec.pdf',
    documentCategory: 'Anecdotal', residentName: 'Resident One', residentId: 'CH001',
  },
];

test('the history returns completed requests and never a Pending one', async () => {
  historyTable = completedRequests.map((row) => ({ ...row }));

  const payload = await runHistory(centerHead);

  assert.equal(payload.success, true);
  assert.deepEqual(payload.data.map((row) => row.id), ['ACC01', 'ACC02']);
  assert.ok(
    !payload.data.some((row) => row.status === 'Pending'),
    'a Pending request is the review queue, not the history',
  );

  // The nine things the specification asks the tab to display.
  const approved = payload.data[0];
  assert.equal(approved.residentName, 'Resident One');       // Child Name
  assert.equal(approved.documentTitle, 'Court Order');        // Document Name
  assert.equal(approved.documentCategory, 'Legal');           // Document Category
  assert.equal(approved.requesterUsername, 'hp1');            // Requested By
  assert.equal(approved.reviewedBy, 'socialworker');          // Reviewed By
  assert.equal(approved.status, 'Approved');                  // Status
  assert.equal(approved.reviewedAt, '2026-03-04 10:00:00');   // Approval/Rejection Date
  assert.equal(approved.reviewerNote, null);                  // Rejection Reason (n/a)

  const rejected = payload.data[1];
  assert.equal(rejected.status, 'Rejected');
  assert.equal(rejected.reviewerNote, 'Not required for your role.');
});

test('a full-access caller sees every decision and everyone else sees their own', async () => {
  historyTable = completedRequests.map((row) => ({ ...row }));

  // The Center Head is full access, so the whole trail.
  assert.deepEqual((await runHistory(centerHead)).data.map((row) => row.id), ['ACC01', 'ACC02']);
  assert.deepEqual((await runHistory(admin)).data.map((row) => row.id), ['ACC01', 'ACC02']);

  // A Social Worker sees the requests *they* decided — "all document access
  // requests they previously approved or rejected".
  const asSocialWorker = await runHistory(socialWorker);
  assert.deepEqual(asSocialWorker.data.map((row) => row.id), ['ACC01']);

  // And a role that decided neither sees an empty trail rather than everything.
  assert.deepEqual((await runHistory(nurse)).data, []);
});

test('the status filter narrows the history without losing any of it', async () => {
  historyTable = completedRequests.map((row) => ({ ...row }));

  const approved = await runHistory(centerHead, { status: 'Approved' });
  assert.deepEqual(approved.data.map((row) => row.id), ['ACC01']);

  const rejected = await runHistory(centerHead, { status: 'Rejected' });
  assert.deepEqual(rejected.data.map((row) => row.id), ['ACC02']);

  const all = await runHistory(centerHead, { status: 'All' });
  assert.equal(all.data.length, 2);

  // A missing or malformed filter must not silently empty the table.
  assert.equal((await runHistory(centerHead)).data.length, 2);
  assert.equal((await runHistory(centerHead, { status: 'nonsense' })).data.length, 2);
  // Case and whitespace are not significant.
  assert.equal((await runHistory(centerHead, { status: ' approved ' })).data.length, 1);
});

test('the history is gated on the Documents submenu that owns it', () => {
  const routes = read(path.resolve(__dirname, '..', 'src', 'routes', 'accessRequestRoutes.js'));
  assert.match(
    routes,
    /requireSubModule\('Documents',\s*'Access Request History'\)/,
    'the history endpoint must be gated on the submenu the tab renders from',
  );
  // Declared before the `/:id` routes so a future `GET /:id` cannot shadow it.
  const historyAt = routes.indexOf("'/history'");
  const reviewAt = routes.indexOf("'/:id/review'");
  assert.ok(historyAt > 0, 'the history route is gone');
  assert.ok(historyAt < reviewAt, 'the history route must be declared before /:id');

  // The submenu is granted to the Center Head (full access) and the Social
  // Worker — the two roles the specification names — plus the Administrator,
  // which holds every module by definition. The tab strip and the API read one
  // source, so they cannot disagree.
  const granted = rbac.ROLE_KEYS.filter(
    (role) => rbac.hasSubModuleAccess(rbac.buildAccessSnapshot({ role }), 'Documents', 'Access Request History'),
  );
  assert.deepEqual(granted.sort(), ['admin', 'centerhead', 'socialworker']);
});

test('the Access Request History tab exists and reads the history endpoint', () => {
  const source = read(
    path.resolve(__dirname, '..', '..', 'frontend', 'src', 'app', 'components', 'DocumentUpload.tsx'),
  );

  assert.match(source, /access-requests\/history\?status=/, 'the tab no longer reads the history endpoint');
  // The three filters the specification names.
  assert.match(source, /\['All', 'Approved', 'Rejected'\]/, 'the All/Approved/Rejected filters are gone');
  // The panel renders from the submenu, so a role without it cannot deep-link in.
  assert.match(source, /canReadHistory/, 'the tab is no longer gated on the submenu');
  assert.match(
    source,
    /useSubModuleTabs\('Documents'\)/,
    'the Documents tab strip must come from the definition',
  );
  // The nine columns the specification lists.
  for (const column of ['Child:', 'Document:', 'Category:', 'Requested by:', 'Reviewed by:']) {
    assert.ok(source.includes(column), `the history row is missing the "${column}" column`);
  }
  assert.ok(source.includes('Rejection reason:'), 'the rejection reason is no longer displayed');
});
