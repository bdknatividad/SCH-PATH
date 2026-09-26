/**
 * The Dashboard counts what the module counts, and shows each schedule once.
 *
 * Two decisions the user made, pinned here so a later edit cannot quietly undo
 * them:
 *
 *   - "Docs Pending" (Dashboard) and the Documents module's "For Review" badge
 *     describe the same queue. They disagreed because the rule was written
 *     twice: the Dashboard kept its own list of titles to hide and its own status
 *     test, and the module's badge ignored its own tab's filters. The rule now
 *     lives in `utils/pendingDocuments.ts` and both screens read it, so this
 *     asserts there is one copy rather than re-checking the arithmetic.
 *
 *   - The "Scheduled Today" tile opens the Today's Schedule dialog, which lists
 *     today's activities, assessments, hearings and assigned interventions. The
 *     page also rendered today's activities and today's hearings as two more
 *     cards, so the same schedules appeared twice — once always-on, once a click
 *     away. The cards were removed and the dialog is the single place for them.
 *     The Pending Assessments card stayed, because it lists *scheduled*
 *     assessments rather than only today's.
 *
 * The rating cards were deliberately left alone: "Urgency Level — Unresolved
 * Violations" and "TRI Monitoring" read different sources, and the user chose to
 * keep both.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const DASHBOARD = read('frontend/src/app/components/Dashboard.tsx');
const DOCUMENTS = read('frontend/src/app/components/DocumentUpload.tsx');
const RULE = read('frontend/src/utils/pendingDocuments.ts');

// ── One pending-review rule ─────────────────────────────────────────────────

test('the pending-review statuses are declared once, in the shared rule', () => {
  assert.match(
    RULE,
    /PENDING_REVIEW_STATUSES = \['Submitted', 'Under Review'\]/,
    'the shared rule no longer names the two pre-decision statuses',
  );
  // A second copy of the *list* is exactly how the two counts came apart. The
  // module still compares a single status in two places, and those are per-row
  // action gates — whether to offer Approve on this row — not the queue's
  // definition, so they are deliberately not routed through the shared rule.
  for (const [label, source] of [['Dashboard.tsx', DASHBOARD], ['DocumentUpload.tsx', DOCUMENTS]]) {
    assert.doesNotMatch(
      source,
      /\['Submitted',\s*'Under Review'\]/,
      `${label} declares the pending statuses again instead of using the shared rule`,
    );
    assert.doesNotMatch(
      source,
      /documents\.filter\(\s*d\s*=>\s*d\.status === 'Submitted'/,
      `${label} filters the pending queue by hand again`,
    );
  }
});

test('both screens read the shared rule', () => {
  assert.match(
    DASHBOARD,
    /import \{ pendingReviewQueue \} from '@\/utils\/pendingDocuments'/,
    'the Dashboard no longer imports the shared rule',
  );
  assert.match(
    DASHBOARD,
    /const pendingApprovals = pendingReviewQueue\(documents, children\)/,
    'the "Docs Pending" tile computes its own queue again',
  );
  assert.match(
    DOCUMENTS,
    /import \{ isPendingReview \} from '@\/utils\/pendingDocuments'/,
    'the Documents module no longer imports the shared rule',
  );
  assert.match(
    DOCUMENTS,
    /const pendingDocs = documents\.filter\(isPendingReview\)/,
    'the Documents module filters pending documents by hand again',
  );
});

test('the Dashboard no longer keeps its own list of documents to hide', () => {
  // Which documents a role may see is the API's answer — the store load filters
  // through `canReadDocument`. The hand-written list had already drifted:
  // `Mental Health Report` has no role restriction anywhere in the definition.
  assert.doesNotMatch(
    DASHBOARD,
    /Mental Health Report/,
    'the Dashboard is hiding documents by title again, which the API already decides',
  );
  assert.doesNotMatch(
    DASHBOARD,
    /!\[[\s\S]{0,80}Psychological Testing[\s\S]{0,80}\]\.includes\(d\.title/,
    'the Dashboard carries a hand-written title exclusion again',
  );
});

test('the module badge counts the same set its tab lists', () => {
  // The tab applies the module's resident and resident-status filters; the badge
  // and the alert have to apply them too, or the badge promises more than the
  // tab shows.
  const queue = DOCUMENTS.slice(
    DOCUMENTS.indexOf('const pendingApprovalQueue = pendingDocs.filter('),
    DOCUMENTS.indexOf(');', DOCUMENTS.indexOf('const pendingApprovalQueue = pendingDocs.filter(')),
  );
  assert.ok(queue.length > 100, 'the pending queue was not located');
  assert.match(queue, /filterResident === 'all' \|\| d\.residentId === filterResident/);
  assert.match(queue, /matchesResidentStatusForDocument\(d\.residentId\)/);

  // Every place that shows the number reads the queue, not the unfiltered set.
  const badge = DOCUMENTS.slice(
    DOCUMENTS.indexOf("value=\"pending\""),
    DOCUMENTS.indexOf('</TabsTrigger>', DOCUMENTS.indexOf("value=\"pending\"")),
  );
  assert.match(badge, /pendingApprovalQueue\.length/, 'the tab badge counts the unfiltered set again');
  assert.doesNotMatch(badge, /pendingDocs\.length/, 'the tab badge counts the unfiltered set again');

  const alert = DOCUMENTS.slice(
    DOCUMENTS.indexOf('Pending review alert'),
    DOCUMENTS.indexOf(')}', DOCUMENTS.indexOf('awaiting your review and approval')),
  );
  assert.ok(alert.length > 100, 'the review alert was not located');
  assert.match(alert, /pendingApprovalQueue\.length/, 'the review alert counts the unfiltered set again');

  const list = DOCUMENTS.slice(
    DOCUMENTS.indexOf('<TabsContent value="pending"'),
    DOCUMENTS.indexOf('</TabsContent>', DOCUMENTS.indexOf('<TabsContent value="pending"')),
  );
  assert.match(list, /docs=\{pendingApprovalQueue\}/, 'the Pending tab lists a differently filtered set again');
});

// ── Each schedule rendered once ─────────────────────────────────────────────

test('Dashboard has one top-level Schedules card', () => {
  assert.match(DASHBOARD, /title: 'Schedules'/, 'the single Schedules card is missing');
  for (const label of ['Activities', 'Assessments', 'Court Hearings', 'Assigned Schedules']) {
    assert.doesNotMatch(DASHBOARD, new RegExp(`title: '${label}'`), `${label} is still rendered as a separate dashboard card`);
  }
  assert.doesNotMatch(DASHBOARD, /title: 'Scheduled Today'/, 'Scheduled Today is still a separate schedule card');
  assert.match(DASHBOARD, /scheduledCounts\.total/, 'the Schedules card is not using the database-backed total');
  assert.match(DASHBOARD, /stat\.title === 'Schedules'/, 'the Schedules card does not open its summary');
});

test('Schedules dialog exposes four clickable categories with database counts', () => {
  const dialog = DASHBOARD.slice(
    DASHBOARD.indexOf('<Dialog open={showScheduleChoice}'),
    DASHBOARD.indexOf('</Dialog>', DASHBOARD.indexOf('<Dialog open={showScheduleChoice}')),
  );
  assert.ok(dialog.length > 1000, 'the Schedules dialog was not located');
  for (const [label, count, route] of [
    ['Activities', 'scheduledCounts.activities', '/activities'],
    ['Assessments', 'scheduledCounts.assessments', '/assessments'],
    ['Court Hearings', 'scheduledCounts.hearings', '/court-records?filter=Scheduled'],
    ['Assigned Schedules', 'scheduledCounts.assigned', '/violations?tab=interventions'],
  ]) {
    assert.match(dialog, new RegExp(label), `${label} category is missing`);
    assert.match(dialog, new RegExp(count.replace('.', '\\.'), 'g'), `${label} does not show its database count`);
    assert.match(dialog, new RegExp(route.replace(/[?]/g, '\\?')), `${label} does not route to its module`);
  }
  assert.match(dialog, /scheduledCounts\.total/, 'the dialog does not show the total schedule count');
});

test('Scheduled Today counts today\'s Activities + Assessments only', () => {
  assert.match(
    DASHBOARD,
    /const scheduledTodayCount = scheduleSummary\?\.scheduledToday\?\.count \?\? \(todayActivities\.length \+ todayAssessments\.length\);/,
    'Scheduled Today counts something other than today\'s activities and assessments',
  );
  assert.match(DASHBOARD, /timeZone: 'Asia\/Manila'/, 'today is not taken in the facility timezone');
  assert.match(DASHBOARD, /scheduleSummary\?\.scheduledToday\?\.count/, 'the count is not sourced from the database summary');
});

test('Dashboard exposes database-backed counts for all four schedule categories', () => {
  for (const label of ['Activities', 'Assessments', 'Court Hearings', 'Assigned Schedules']) {
    assert.match(DASHBOARD, new RegExp(`scheduledCounts\\.${label === 'Court Hearings' ? 'hearings' : label === 'Assigned Schedules' ? 'assigned' : label.toLowerCase()}`), `${label} count is not read from the schedule summary`);
  }
  assert.match(DASHBOARD, /scheduledCounts\.total/, 'the total is not read from the schedule summary');
});

test('Pending Assessments stayed, because it is not a today-only list', () => {
  assert.match(
    DASHBOARD,
    /<ClipboardCheck[^>]*\/>\s*Pending Assessments/,
    'the Pending Assessments card was removed too',
  );
  assert.match(
    DASHBOARD,
    /scheduledAssessments\.slice\(0, 3\)/,
    'the Pending Assessments card no longer lists scheduled assessments',
  );
});

test('the two rating cards are both still there', () => {
  // The user chose to keep both: they read different sources.
  assert.match(DASHBOARD, /Urgency Level — Unresolved Violations/, 'the Urgency card was removed');
  assert.match(DASHBOARD, /TRI Monitoring — Official Monthly Performance Ratings/, 'the TRI card was removed');
});
