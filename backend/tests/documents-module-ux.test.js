/**
 * Guards for how the Documents module presents itself and its files.
 *
 * Three defects are pinned here:
 *
 * 1. The module opened on "All Documents" instead of the Child → Category → File
 *    tree it is organised around, and every child folder auto-expanded on load, so
 *    landing on it produced a wall of file rows rather than an index of residents.
 * 2. A file row could show who submitted it and not who approved it. The folder row
 *    rendered the fields; the data was simply never written for the documents the
 *    TRI / Anecdotal / QPR modules publish (they hardcoded `status = 'Approved'` and
 *    never recorded an approver). The controller side of that is pinned in
 *    `document-categories.test.js`; here the row itself is pinned.
 *
 * These are all source-level assertions because the components have no test harness
 * — but every one of them is a defect that type-checks, builds, and is only visible
 * by opening the page.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DOCUMENTS_UI = path.resolve(__dirname, '../../frontend/src/app/components/DocumentUpload.tsx');

const read = (file) => fs.readFileSync(file, 'utf8');

// ── landing on the folder tree ──────────────────────────────────────────────

test('the Documents module opens on Folders by Child', () => {
  const source = read(DOCUMENTS_UI);

  // The tab list is no longer written into the component: it is the Documents
  // module's submenus as the RBAC definition declares them, so a role only sees
  // the tabs it holds and the order lives in one place. The landing tab is the
  // first of those.
  assert.match(
    source,
    /useSubModuleTabs\('Documents'\)/,
    'the module no longer derives its tabs from the RBAC definition',
  );

  const hook = source.match(/useSubModuleTab\(\s*(\w+)\s*,\s*([^)]+?)\s*\)/);
  assert.ok(hook, 'the module no longer adopts useSubModuleTab, so the tab default cannot be checked');
  assert.equal(hook[1], 'tabKeys', 'the tab state must be keyed to the definition-driven tab list');
  assert.match(
    hook[2],
    /^tabKeys\[0\]\s*\?\?\s*'folders'$/,
    'the module must land on the first tab the account may open, defaulting to the folder tree',
  );

  // And the first tab the definition declares really is the folder tree.
  const rbac = require('../src/config/rbac');
  const tabs = rbac.MODULE_BY_KEY.Documents.subModules.map((sub) => sub.tab);
  assert.deepEqual(
    tabs,
    ['folders', 'all', 'pending', 'access', 'history'],
    'the Documents tab order changed — update this expectation deliberately',
  );
  assert.equal(tabs[0], 'folders', 'the module no longer lands on the folder tree');
});

test('every child folder starts closed', () => {
  const source = read(DOCUMENTS_UI);

  // The tree reads the flag with a false fallback, so an unset key is a closed
  // folder — the auto-expand effect is what used to fill it in.
  assert.match(
    source,
    /expandedChildren\[nameKey\]\s*\?\?\s*false/,
    'the child folder no longer defaults to closed'
  );
  assert.doesNotMatch(
    source,
    /expandedChildrenInit/,
    'the auto-expand that opened every child folder on load is back'
  );
  assert.doesNotMatch(
    source,
    /autoExpand\[name\.trim\(\)\.toLowerCase\(\)\]\s*=\s*true/,
    'a child folder is being auto-opened again'
  );
  assert.match(
    source,
    /const \[expandedChildren, setExpandedChildren\] = useState<Record<string, boolean>>\(\{\}\)/,
    'the expansion state no longer starts empty'
  );
});

// ── the per-file metadata ───────────────────────────────────────────────────

test('a file row shows who submitted it and who decided it, with both dates', () => {
  const source = read(DOCUMENTS_UI);
  const start = source.indexOf('function FolderDocumentRow(');
  assert.ok(start !== -1, 'FolderDocumentRow is gone');
  const body = source.slice(start, source.indexOf('\nfunction ', start + 10));
  assert.ok(body.length > 0, 'the folder row body was not found');

  for (const label of ['Date Submitted', 'Submitted By', 'Approved By', 'Approval Date']) {
    assert.match(body, new RegExp(`'${label}'`), `the folder row no longer prints "${label}"`);
  }
  for (const label of ['Rejected By', 'Rejection Date']) {
    assert.match(body, new RegExp(`'${label}'`), `the folder row no longer prints "${label}" for a rejected file`);
  }

  // The approver and the submitter are separate facts: a row must not fall back to
  // the submitter when nobody approved it, or it would name the wrong person.
  assert.match(body, /doc\.approvedBy/, 'the row no longer reads the recorded approver');
  assert.match(body, /doc\.approvedAt/, 'the row no longer reads the recorded approval date');
  assert.match(body, /doc\.rejectedBy/, 'the row no longer reads the recorded rejector');
  assert.match(body, /doc\.rejectionReason/, 'the row no longer shows why a file was rejected');
});

test('the flat list also names the approver', () => {
  const source = read(DOCUMENTS_UI);
  // The "All Documents" row keeps its decision line separate from the submitter
  // line, so both are always visible rather than one replacing the other.
  assert.match(
    source,
    /Approved by<\/strong> \{doc\.approvedBy\}/,
    'the flat list no longer prints who approved a document'
  );
  assert.match(
    source,
    /doc\.approvedAt \? ` on \$\{new Date\(doc\.approvedAt\)/,
    'the flat list no longer prints the approval date'
  );
});

// ── the approved entry must carry its approver ──────────────────────────────

test('the publishers that write an already-approved file record the approver', () => {
  const publishers = {
    'triController.js': 'the TRI publisher',
    'anecdotalReportController.js': 'the Anecdotal Report publisher',
    'quarterlyProgressReportController.js': 'the QPR publisher',
  };

  for (const [file, name] of Object.entries(publishers)) {
    const source = read(path.resolve(__dirname, `../src/controllers/${file}`));
    assert.match(
      source,
      /'Approved'/,
      `${name} no longer publishes an approved entry — this test needs revisiting`
    );
    assert.match(
      source,
      /approvedBy, approvedAt/,
      `${name} writes an Approved document without recording who approved it, so the ` +
        'folder row shows a submitter and an empty approver'
    );
    assert.match(
      source,
      /approvedAt = NOW\(\)/,
      `${name} never refreshes the approval date when the entry is re-published`
    );
  }
});

test('the Documents module can read the approval columns it renders', () => {
  const constants = read(path.resolve(__dirname, '../src/utils/constants.js'));
  const resource = constants.match(/documents: \{([\s\S]*?)\n  \},/);
  assert.ok(resource, 'the documents resource is gone');

  for (const column of ['approvedBy', 'approvedAt', 'rejectedBy', 'rejectedAt', 'submittedBy', 'documentCategory']) {
    assert.match(
      resource[1],
      new RegExp(`'${column}'`),
      `documents.${column} is not registered, so mapRow drops it before the row can render it`
    );
  }
});

test('documents published before the publishers recorded an approver are backfilled', () => {
  const server = read(path.resolve(__dirname, '../src/server.js'));
  const start = server.indexOf('Backfill: name the approver on documents');
  assert.ok(start !== -1, 'the approver backfill is gone — every already-published entry keeps an empty approver');

  const block = server.slice(start, start + 2600);
  for (const [table, link] of [
    ['triRecords', 'triRecordId'],
    ['anecdotalReports', 'anecdotalReportId'],
    ['quarterlyProgressReports', 'quarterlyReportId'],
  ]) {
    assert.match(block, new RegExp(table), `the backfill no longer reads ${table}`);
    assert.match(block, new RegExp(link), `the backfill no longer links documents to ${table} via ${link}`);
  }
  // Idempotent and non-destructive: only a row that is Approved with no approver
  // is touched, so a decision a reviewer actually made is never overwritten.
  assert.match(
    block,
    /d\.status = 'Approved' AND d\.approvedBy IS NULL/,
    'the backfill is no longer limited to approved documents with no approver'
  );
  assert.match(
    block,
    /COALESCE\(s\.finalizedBy, s\.reviewedBy\) IS NOT NULL/,
    'the backfill no longer requires the source record to name someone'
  );
  assert.match(
    block,
    /ER_NO_SUCH_TABLE/,
    'the backfill no longer tolerates a source table that does not exist yet — the ' +
      'Anecdotal and QPR tables are created lazily, so boot would warn on a fresh database'
  );
});

// ── delete is a capability, not a document type ─────────────────────────────

test('the delete affordance comes from RBAC, never from the document type', () => {
  const source = read(DOCUMENTS_UI);

  // The Psychologist may not delete a document, but DOCUMENT_ROLE_PERMISSIONS
  // grants the role the *upload* of a Psychological Assessment — so deriving
  // delete from that map handed the role a Delete button on its own uploads.
  // It must not be consulted for delete authority at all.
  assert.doesNotMatch(
    source,
    /DOCUMENT_ROLE_PERMISSIONS\[doc\.title\]/,
    'delete is derived from the per-document-type upload map again'
  );
  assert.doesNotMatch(
    source,
    /docPerms\.includes\(/,
    'a document-type permission list is still being used as a delete authority'
  );

  // Both the flat list and the folder row take the capability as a prop.
  assert.match(
    source,
    /canDelete:\s*boolean;/,
    'the delete capability is no longer threaded into the row components'
  );
  const rowComponents = (source.match(/<DocumentList/g) || []).length
    + (source.match(/<FolderDocumentRow/g) || []).length;
  assert.ok(rowComponents > 0, 'expected the document row components to be rendered');
  // The capability must still originate in RBAC at every call site. It may be
  // refined further — a closed admission is read-only regardless of the role —
  // but it must never be *replaced* by something the role did not grant.
  assert.equal(
    (source.match(/canDelete=\{[^}]*canDeleteDocuments[^}]*\}/g) || []).length,
    rowComponents,
    'every DocumentList / FolderDocumentRow call site must pass the RBAC capability'
  );
  assert.match(
    source,
    /const canDeleteDocuments = can\('Documents', 'delete'\);/,
    'the module no longer asks RBAC for the delete capability'
  );
});

test('the review queue is hidden unless the account holds the Documents review tab', () => {
  const source = read(DOCUMENTS_UI);

  // `canApprove` gates the Approve / Reject / Reassessment buttons and the
  // Pending Review tab. It used to be a role literal, which let a role keep the
  // buttons after its approval authority was removed.
  assert.match(
    source,
    /const canApprove = can\('Documents', 'approve'\);/,
    'approval authority is decided by a role literal rather than by the capability'
  );
  assert.doesNotMatch(
    source,
    /canApprove\s*=\s*\[[^\]]*'centerhead'/,
    'a hand-written role list is deciding approval again'
  );
});
