/**
 * Resident Discharge Report tests.
 *
 * The report is assembled in the browser from `useData()`, so these are
 * source-level assertions. They guard the specific defects that were found in
 * it — each one was silent, in the sense that the report still rendered and
 * simply printed "No … recorded" or a stale value:
 *
 *   - Activity Participation read `localStorage.activitiesRecords`, which is only
 *     DataContext's cache, so a browser that had never cached the module showed
 *     an empty section while the database held the rows.
 *   - Behavioral Assessment read `child.behavioralLogs`, a column ChildDetail
 *     labels "Legacy Incident Logs (Pre-Migration)". Live violations are in the
 *     `violations` table, so the section reported none for every current resident.
 *   - Medical Records ignored the Documents module's Medical category, where
 *     uploads land now.
 *   - The report is named a *discharge* report but carried no discharge data at
 *     all, despite `/discharge-plans/resident/:id` existing.
 *   - Age came from `child.age`, which is written once at admission.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const REPORTS_TSX = path.join(REPO, 'frontend/src/app/components/Reports.tsx');
const source = fs.readFileSync(REPORTS_TSX, 'utf8');

/** The body of `generateResidentReport`, from its declaration to the next top-level comment. */
function generatorBody() {
  const start = source.indexOf('async function generateResidentReport(');
  assert.ok(start > -1, 'expected to find generateResidentReport');
  const end = source.indexOf('// ── REPORT FORM ROW', start);
  assert.ok(end > start, 'expected to find the end of generateResidentReport');
  return source.slice(start, end);
}

const body = generatorBody();

test('the report reads activities from the data layer, not from localStorage', () => {
  assert.doesNotMatch(
    body,
    /localStorage/,
    'activities must come from useData(), which is server-backed; localStorage is only its cache'
  );
  assert.match(body, /activities/, 'expected the report to use the activities it is given');
});

test('the report takes its live data as arguments rather than reaching for globals', () => {
  assert.match(body, /live: \{ activities\?: any\[\]; violations\?: any\[\]; documents\?: any\[\] \}/);
  assert.match(body, /const violations = Array\.isArray\(live\.violations\)/);
  assert.match(body, /const documents = Array\.isArray\(live\.documents\)/);
});

test('the behavioural section reads the violations table, not the legacy log column', () => {
  assert.match(body, /v\.residentId === child\.id/, 'expected violations filtered by resident');
  assert.match(body, /Behavioral Record/);
  // The legacy column may still be shown for pre-migration residents, but it
  // must not be the only source.
  assert.match(body, /legacy/, 'expected legacy logs to be merged, not used exclusively');
});

test('legacy logs are de-duplicated against real violations', () => {
  assert.match(
    body,
    /\(child\.behavioralLogs \|\| \[\]\)\.filter\(\(log: any\) => !childViolations\.some/,
    'a violation that also exists as a legacy log must not be printed twice'
  );
});

test('medical records merge the Documents module with the legacy column', () => {
  assert.match(body, /d\.category === 'Medical'/);
  assert.match(body, /fromDocuments/);
  assert.match(body, /child\.medicalRecords/);
});

test('the discharge report actually contains discharge information', () => {
  assert.match(body, /discharge-plans\/resident/, 'expected the discharge plan to be fetched');
  assert.match(body, /Discharge Plan/);
  assert.match(body, /expectedDischargeDate/);
  assert.match(body, /extensionDays|history/, 'expected the extension history to be printed');
});

test('a resident whose discharge plan is not readable does not break the report', () => {
  // `/discharge-plans/resident/:id` is 403 for a caller not assigned to the
  // resident, which must degrade to an omitted section rather than a blank page.
  assert.match(body, /catch \{\s*plans\[child\.id\] = null;\s*\}/);
});

test('age is computed from the birth date, not read from the stale age column', () => {
  assert.match(body, /const age = ageOn\(child\.birthDate, now\)/);
  assert.doesNotMatch(
    body,
    /row\('Age', child\.age/,
    'children.age is written once at admission and goes stale'
  );
});

test('ageOn computes whole years correctly across a birthday boundary', () => {
  const match = /function ageOn\([\s\S]*?\n\}/.exec(source);
  assert.ok(match, 'expected to find the ageOn helper');

  // `ageOn` is TypeScript, so its annotations have to come off before it can be
  // evaluated as JavaScript. Each strip is asserted, so changing the signature
  // fails here loudly instead of silently skipping the arithmetic check.
  let js = match[0];
  const strips = [
    [/birthDate\?: string \| null/, 'birthDate'],
    [/atDate: Date = new Date\(\)/, 'atDate = new Date()'],
    [/\): number \| null \{/, ') {'],
  ];
  for (const [pattern, replacement] of strips) {
    assert.match(js, pattern, `expected the ageOn signature to still declare ${pattern}`);
    js = js.replace(pattern, replacement);
  }

  // eslint-disable-next-line no-new-func
  const ageOn = new Function(`${js}\nreturn ageOn;`)();
  const on = new Date('2024-08-31T12:00:00');

  // Birthday already passed this year.
  assert.equal(ageOn('2008-03-15', on), 16);
  // Birthday still to come.
  assert.equal(ageOn('2008-11-02', on), 15);
  // The birthday itself counts as reached; the day after does not.
  assert.equal(ageOn('2008-08-31', on), 16);
  assert.equal(ageOn('2008-09-01', on), 15);
  // No usable birth date means no age, not a NaN or a negative year count.
  assert.equal(ageOn('', new Date()), null);
  assert.equal(ageOn(null, new Date()), null);
  assert.equal(ageOn(undefined, new Date()), null);
  // A birth date in the future must not produce a negative age.
  assert.equal(ageOn('2030-01-01', on), null);
});

test('every interpolated value is escaped before it reaches the report HTML', () => {
  // The report is built by string concatenation and written into a new window
  // with `document.write`, so any markup stored in a resident's name, address,
  // notes or case details would execute there. Every interpolation of a stored
  // field must therefore go through `esc()`.
  //
  // Only *leaf* interpolations are inspected — those whose expression contains
  // no nested `${`, brace or backtick. That deliberately skips the
  // `records.map(r => \`<tr>…\`)` wrappers, whose own leaves are checked
  // individually, and avoids the trap of a `[^}]*` pattern matching into a
  // nested template literal and reporting the wrapper as the offender.
  const leaves = [...body.matchAll(/\$\{([^{}`]+)\}/g)].map((m) => m[1].trim());

  // Guard against the assertion going vacuous if the generator is refactored.
  assert.ok(leaves.length >= 60, `expected to inspect the report's interpolations, saw ${leaves.length}`);

  // Fragments that are not resident data: numbers, dates the page generated, and
  // section bodies that were themselves built from escaped parts.
  const NOT_RESIDENT_TEXT = [
    /^content$/, /^value \|\| '—'$/, /^age$/, /^dateStr$/, /^dateStr\.replace\(/,
    /^selected\.length$/, /^selected\.map\(/,
    /^personalInfo$/, /^caseProgress$/, /^dischargeSection$/, /^medicalInfo$/,
    /^activitySection$/, /^behaviorSection$/, /^assessmentSection$/, /^reintegration$/,
  ];

  // The four places where a stored field is interpolated without `esc()` on
  // purpose, each for a stated reason.
  const SPECIAL_CASES = [
    // A URL path segment, not HTML — entity-encoding it would corrupt the id.
    /^encodeURIComponent\(child\.id\)$/,
    // Booleans rendered as fixed words; nothing stored reaches the output.
    /^row\('Repeat Offender', child\.isRepeatOffender \? 'Yes' : 'No'\)$/,
    /^row\('Documents Complete', child\.documentsComplete \? 'Yes' : 'Pending'\)$/,
    // A conditional whose branches are a `row()` call and an empty string.
    /^child\.isRepeatOffender && child\.previousCaseDetails[\s\S]*\? row\(/,
  ];

  const unsafe = leaves.filter((expr) =>
    // A heuristic, not a parser: it proves `esc(` is applied somewhere in the
    // expression rather than at its outermost level.
    !expr.includes('esc(') &&
    !NOT_RESIDENT_TEXT.some((re) => re.test(expr)) &&
    !SPECIAL_CASES.some((re) => re.test(expr))
  );

  assert.deepEqual(unsafe, [], `unescaped interpolations found:\n  ${unsafe.join('\n  ')}`);
});

test('the report window is opened before the awaits, not after them', () => {
  // `generateResidentReport` awaits the discharge plans. Opening the window
  // after that await is outside the click's user gesture, and browsers block it
  // as a popup — which would have made the button appear to do nothing. So the
  // generator must not open the window itself, and the caller must do it
  // synchronously, before it awaits the generator.
  //
  // The assertion is on a *call* to `window.open(`, not on the name: the
  // generator is allowed to explain the rule in a comment.
  assert.doesNotMatch(body, /\bwindow\s*\.\s*open\s*\(/, 'the generator must not open the window itself');
  assert.match(source, /const win = window\.open\('', '_blank'\);/);
  assert.match(source, /await generateResidentReport\(children, selectedResidents, assessments, \{ activities, violations, documents \}, win\)/);
});

test('the generator is awaited by its click handler so failures are caught', () => {
  assert.match(source, /const handleGenerateReport = async \(\) => \{/);
  assert.match(source, /void handleGenerateReport\(\)/, 'the promise must be handled, not floated');
});

test('the Reports page passes the live collections it now needs', () => {
  assert.match(source, /const \{ children, assessments, reports, refreshData, activities, violations, documents \} = useData\(\);/);
});
