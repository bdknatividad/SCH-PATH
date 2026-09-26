/**
 * When a violation needs an intervention scheduled before it can be verified.
 *
 * The rule lives on both sides and they have to agree, because the two halves do
 * different jobs: the SPA decides whether to *render* the Schedule field, and the
 * API decides whether to *refuse* the review without one. When they disagreed,
 * the failure mode was unanswerable — the API returned
 *
 *   A schedule date and time is required for this intervention.
 *
 * for a "Dialogue/Counseling" requirement whose description happened to read
 * "Counseling session with the resident", because the SPA had scanned the free
 * text for the word "dialogue", not found it, and therefore never rendered the
 * field the API was asking for. The reviewer had an error and nowhere to put the
 * answer.
 *
 * So this pins three things: the rule is decided by a property of the
 * intervention itself — the configured `metadata.schedulable` flag, falling back
 * to its *type* — the two type lists are the same list, and the SPA no longer
 * decides it from the guide's prose.
 *
 * The flag was added later, for the opposite failure: a `Dialogue/Counseling`
 * requirement the guide stores as **non-schedulable** was still being made to
 * demand a schedule by the type-name rule, and the review screen had no control
 * to supply one, so the incident could not be verified at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const BACKEND = read('backend/src/controllers/violationController.js');
const FRONTEND = read('frontend/src/app/components/Violations.tsx');

const normalize = (value) => value.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The types the API compares an intervention against.
 *
 * Read from the `type === '...'` comparisons rather than from every quoted
 * string in the function body: the body also contains `String(value || '')`,
 * and pairing quotes blindly desynchronises on that empty literal — every
 * capture after it comes back shifted by one quote.
 */
function backendSchedulingTypes(source) {
  const from = source.indexOf('function isSchedulingInterventionType');
  assert.ok(from >= 0, 'the API scheduling predicate was not found');
  const block = source.slice(from, source.indexOf('\n}', from));
  return [...block.matchAll(/type === '([^']+)'/g)].map((match) => normalize(match[1])).sort();
}

/** The types the SPA lists as schedulable. */
function frontendSchedulingTypes(source) {
  const from = source.indexOf('const SCHEDULING_INTERVENTION_TYPES = [');
  assert.ok(from >= 0, 'the SPA scheduling type list was not found');
  const block = source.slice(from, source.indexOf('];', from));
  return [...block.matchAll(/'([^']+)'/g)].map((match) => normalize(match[1])).sort();
}

const BACKEND_TYPES = backendSchedulingTypes(BACKEND);
const FRONTEND_TYPES = frontendSchedulingTypes(FRONTEND);

test('both sides list the same schedulable intervention types', () => {
  assert.ok(BACKEND_TYPES.length >= 2, `the backend list parsed as ${JSON.stringify(BACKEND_TYPES)}`);
  assert.ok(FRONTEND_TYPES.length >= 2, `the frontend list parsed as ${JSON.stringify(FRONTEND_TYPES)}`);
  assert.deepEqual(
    FRONTEND_TYPES,
    BACKEND_TYPES,
    'the SPA and the API disagree about which interventions must be scheduled, so one of them ' +
      'will render a field the other does not want, or refuse a review with no field to answer it',
  );
});

test('the rule reads the intervention type, not the guide\'s wording', () => {
  // The backend compares a normalised `interventionType`.
  assert.match(
    BACKEND,
    /function isSchedulingInterventionType\(value\) \{\s*const type = String\(value \|\| ''\)\.trim\(\)\.toLowerCase\(\)\.replace\(\/\\s\+\/g, ' '\);/,
    'the backend no longer normalises the intervention type before comparing it',
  );

  // The frontend reads `interventionType` (falling back to `type`) — and never
  // the description.
  assert.match(
    FRONTEND,
    /const normalizeInterventionType = \(row: any\) =>\s*String\(row\?\.interventionType \?\? row\?\.type \?\? ''\)/,
    'the SPA no longer reads the intervention type',
  );
  const rule = FRONTEND.slice(
    FRONTEND.indexOf('const SCHEDULING_INTERVENTION_TYPES'),
    FRONTEND.indexOf('const interventionDisplayText'),
  );
  assert.doesNotMatch(
    rule,
    /officialText|rawText/,
    'the scheduling rule scans the guide\'s free text again, which is the bug this pins',
  );
  assert.doesNotMatch(
    rule,
    /\/psychosocial\|dialogue\/i/,
    'the scheduling rule is a text pattern again',
  );
});

test('every place that decides scheduling uses the one predicate', () => {
  // The validation, the payload and the render must agree, or the field is shown
  // but not required, or required but not shown.
  const calls = FRONTEND.match(/interventionNeedsSchedule\b/g) || [];
  assert.ok(
    calls.length >= 3,
    `the scheduling predicate is used in only ${calls.length} places (definition + validation + render expected)`,
  );
  assert.doesNotMatch(
    FRONTEND,
    /\/psychosocial\|dialogue\/i/,
    'a text-pattern scheduling check is still in the file',
  );
  // And the payload sends the schedule only when the API will accept it.
  assert.match(
    FRONTEND,
    /scheduleDateTime: requirementNeedsSchedule \? reviewForm\.scheduleDateTime : null/,
    'the payload no longer follows the same predicate as the validation',
  );
});

test('the display text is a separate helper from the rule', () => {
  // The two were one expression, which is how prose came to decide a rule.
  assert.match(FRONTEND, /const interventionDisplayText = \(row: any\) =>/, 'the display helper is gone');
  assert.match(
    FRONTEND,
    /interventionDisplayText\(r\)/,
    'the review dialog no longer shows the guide\'s wording for an intervention',
  );
});

test('the API refuses a review without a schedule for a schedulable type', () => {
  // The rule is checked where the clinical decision is submitted — the
  // Psychological Staff's verification. A Social Worker's verification that
  // completes the pair re-uses the decision already recorded (and accepted) by
  // the Psychological Staff, so it is not re-checked against the clock. The
  // requirement is narrowed, not dropped: the schedule is still mandatory on the
  // side that supplies it, which is what keeps the SPA's field load-bearing.
  assert.match(
    BACKEND,
    /const clinicalInputsFromRequest = verificationSide === 'psych';/,
    'the API no longer distinguishes the side that supplies the clinical decision',
  );
  assert.match(
    BACKEND,
    /if \(status === 'Reviewed' && clinicalInputsFromRequest && needsSchedule && !scheduleDateTime\) throw new ApiError\(400,/,
    'the API no longer requires the schedule, so the SPA field is decorative',
  );
  assert.match(
    BACKEND,
    /const needsSchedule = requirements\.some\(interventionNeedsSchedule\)/,
    'the API no longer derives the requirement from the intervention',
  );
  // The predicate now reads the configured `metadata.schedulable` flag first and
  // falls back to the type. Both are properties of the intervention itself, so
  // the property this file exists to protect — that the rule is never derived
  // from the guide's prose — still holds. It is pinned here rather than left
  // implied, because a future edit could reintroduce a text scan in the fallback.
  assert.match(
    BACKEND,
    /function interventionNeedsSchedule\(row\) \{\s*const source = row && typeof row === 'object' \? row : \{ interventionType: row \};/,
    'the API scheduling predicate no longer accepts an intervention row',
  );
  assert.match(
    BACKEND,
    /if \(metadata && typeof metadata\.schedulable === 'boolean'\) return metadata\.schedulable;\s*return isSchedulingInterventionType\(source\.interventionType\);/,
    'the API no longer prefers the configured flag and falls back to the intervention type',
  );
});
