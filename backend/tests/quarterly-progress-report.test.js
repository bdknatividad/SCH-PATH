/**
 * Quarterly Progress Report tests.
 *
 * The report's whole reason to exist is that it assembles itself from records
 * that are already on file, so the tests concentrate on that assembly: the
 * period arithmetic, the mapping onto each source table's own vocabulary, and
 * the wording the generated lines produce. A regression there is silent — the
 * report still renders, it just quietly stops containing anything.
 *
 * The PDF assertions use `pdfDrawnText` below. pdf-lib Flate-compresses its
 * content streams and writes every string as a hex literal (`<506879...> Tj`),
 * so nothing is greppable in the raw bytes. Inflate each stream and hex-decode
 * the `Tj` operands, and you can assert on what actually prints.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');

// Must be set before the auth middleware is loaded, or every request 500s.
const TEST_SECRET = 'quarterly-progress-report-test-secret-long-enough';
process.env.JWT_SECRET = TEST_SECRET;

const jwt = require('jsonwebtoken');

const SRC = path.resolve(__dirname, '..', 'src');
const REPO = path.resolve(__dirname, '..', '..');

const controller = require('../src/controllers/quarterlyProgressReportController');
const pdf = require('../src/utils/quarterlyReportPdf');

const read = (relative) => fs.readFileSync(path.join(REPO, relative), 'utf8');

function pdfDrawnText(buffer) {
  const raw = buffer.toString('latin1');
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const drawn = [];
  let stream;
  while ((stream = streamRe.exec(raw)) !== null) {
    let decoded;
    try {
      decoded = zlib.inflateSync(Buffer.from(stream[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    if (!decoded.includes(' Tj')) continue;
    for (const hex of decoded.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      drawn.push(Buffer.from(hex[1], 'hex').toString('latin1'));
    }
  }
  return drawn;
}

// ── THE PERIOD ──────────────────────────────────────────────────────────────

test('a year offers four calendar-quarter periods beginning in January', () => {
  const periods = controller.periodsForYear(2024);
  assert.equal(periods.length, 4);
  assert.deepEqual(
    periods.map((p) => p.periodStart),
    ['2024-01-01', '2024-04-01', '2024-07-01', '2024-10-01']
  );
});

test('the first period of a year matches the reference document exactly', () => {
  const [q1] = controller.periodsForYear(2024);
  assert.equal(q1.periodStart, '2024-01-01');
  assert.equal(q1.periodEnd, '2024-03-31');
  assert.equal(q1.headerLabel, 'Q1 2024');
  assert.equal(q1.label, 'Q1 2024');
});

test('the fourth period ends in the same calendar year it starts in', () => {
  // Calendar quarters do not roll over the year boundary the way the facility's
  // old June-anchored cycle did: Q4 is October-December, and December closes the
  // year it begins in.
  const q4 = controller.periodFor(2024, 10);
  assert.equal(q4.periodStart, '2024-10-01');
  assert.equal(q4.periodEnd, '2024-12-31');
  assert.equal(q4.headerLabel, 'Q4 2024');
});

test('a quarter ends on the true last day of its final month', () => {
  // Calendar quarters never end in February, so the leap-year case that used to
  // be tested here is gone — but the month-length arithmetic still has to be
  // right for a 30-day and a 31-day close, and for a leap February inside Q1.
  assert.equal(controller.periodFor(2024, 1).periodEnd, '2024-03-31');
  assert.equal(controller.periodFor(2024, 4).periodEnd, '2024-06-30');
  assert.equal(controller.periodFor(2024, 7).periodEnd, '2024-09-30');
  assert.equal(controller.periodFor(2024, 10).periodEnd, '2024-12-31');
});

test('the current period is one the picker actually offers', () => {
  const current = controller.periodForDate(new Date('2024-07-15T12:00:00'));
  assert.equal(current.periodStart, '2024-07-01');
  assert.equal(current.periodEnd, '2024-09-30');
});

test('every generated label names its calendar quarter', () => {
  // The inverse of the guard that used to live here. The facility's cycle is the
  // calendar quarter, so every label is a "Qn YYYY" and none is a month range —
  // and the header is the same string as the label rather than a second format
  // that could drift from it.
  for (const period of controller.periodsForYear(2024)) {
    assert.match(period.headerLabel, /^Q[1-4] 2024$/);
    assert.equal(period.headerLabel, period.label);
    assert.equal(period.year, 2024);
    assert.equal(period.quarter, Number(period.label.slice(1, 2)));
  }
});

test('an invalid year is rejected rather than silently coerced', () => {
  assert.throws(() => controller.periodsForYear('nonsense'), /valid year/i);
});

// ── AGE ─────────────────────────────────────────────────────────────────────

test('age is computed at the end of the period, not at admission', () => {
  assert.equal(controller.ageAt('2008-03-15', '2024-08-31'), 16);
  assert.equal(controller.ageAt('2008-11-02', '2024-08-31'), 15);
});

test('ageAt does not drift a day in a negative-offset timezone', () => {
  // The naive `new Date(iso)` approach parses as UTC and reads back locally,
  // which west of Greenwich moves the boundary by a day.
  assert.equal(controller.ageAt('2008-08-31', '2024-08-31'), 16);
  assert.equal(controller.ageAt('2008-09-01', '2024-08-31'), 15);
});

test('ageAt returns null rather than a nonsense number for bad input', () => {
  assert.equal(controller.ageAt('', '2024-08-31'), null);
  assert.equal(controller.ageAt('2008-03-15', ''), null);
});

// ── BULLET HANDLING ─────────────────────────────────────────────────────────

test('bullets are stripped from already-bulleted text', () => {
  assert.deepEqual(controller.toBulletLines('- one\n* two\n\nthree  '), ['one', 'two', 'three']);
});

test('a sentence written in three months appears once in the roll-up', () => {
  assert.deepEqual(
    controller.dedupeLines(['Keeps clean', 'KEEPS CLEAN', 'keeps  clean', 'other']),
    ['Keeps clean', 'other']
  );
});

// ── THE ASSEMBLY ────────────────────────────────────────────────────────────

test('every aspect resolves to an Anecdotal Report key that really exists', () => {
  // This is the silent-failure guard. The Anecdotal Report calls its two odd
  // aspects `education` and `productivity`; this report calls them `educational`
  // and `economicProductivity`. If the map drifts, those two aspects assemble
  // nothing at all and nothing else complains.
  const anecdotal = read('frontend/src/app/components/AnecdotalReports.tsx');
  const declared = [...anecdotal.matchAll(/\{ key: '([a-zA-Z]+)', label: '/g)].map((m) => m[1]);

  assert.ok(declared.length >= 10, 'expected to find the Anecdotal Report field keys');
  for (const aspect of controller.ASPECTS) {
    const config = controller.ASPECT_SOURCES[aspect.key];
    assert.ok(config, `no source map entry for ${aspect.key}`);
    assert.ok(
      declared.includes(config.anecdotalKey),
      `${aspect.key} reads anecdotal key "${config.anecdotalKey}", which the Anecdotal Report does not define`
    );
  }
});

test('every aspect maps to a category the Activities module actually writes', () => {
  const activities = read('frontend/src/app/components/Activities.tsx');
  const match = /const activityCategories = \[([^\]]*)\]/.exec(activities);
  assert.ok(match, 'expected to find the activity category vocabulary');
  const categories = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  for (const aspect of controller.ASPECTS) {
    for (const category of controller.ASPECT_SOURCES[aspect.key].activityCategories || []) {
      assert.ok(
        categories.includes(category),
        `${aspect.key} filters activities by "${category}", which is not one of ${categories.join(', ')}`
      );
    }
  }
});

test('Form 11-A measurements reproduce the reference document wording', () => {
  const health = [{
    details: {
      monitoringYear: '2024',
      monthlyMeasurements: [
        { month: 1, height: '150', weight: '42.75' },
        { month: 6, height: '150.5', weight: '44' },
        { month: 8, height: '151', weight: '45.35' },
      ],
    },
  }];

  const lines = controller.healthMeasurementLines(health, '2024-06-01', '2024-08-31');
  assert.ok(
    lines.includes('Improvement in weight: from 42.75 kg. (admission) to 45.35 kg. as per update'),
    `expected the reference weight line, got ${JSON.stringify(lines)}`
  );
  assert.ok(
    lines.includes('Improvement in height: from 150 cm (admission) to 151 cm as per update'),
    `expected the reference height line, got ${JSON.stringify(lines)}`
  );
});

test('a resident with a single measurement gets no self-comparison line', () => {
  const health = [{ details: { monitoringYear: '2024', monthlyMeasurements: [{ month: 6, height: '150', weight: '44' }] } }];
  const lines = controller.healthMeasurementLines(health, '2024-06-01', '2024-08-31');
  assert.equal(lines.filter((l) => l.includes('Improvement')).length, 0);
});

test('measurements recorded outside the period are still used as the baseline', () => {
  // The form says "(admission)", which is usually months before the period.
  const health = [{
    details: {
      monitoringYear: '2024',
      monthlyMeasurements: [
        { month: 2, height: '149', weight: '41' },
        { month: 7, height: '151', weight: '45' },
      ],
    },
  }];
  const lines = controller.healthMeasurementLines(health, '2024-06-01', '2024-08-31');
  assert.ok(lines.some((l) => l.includes('from 41 kg.')), JSON.stringify(lines));
});

test('an incident report becomes a dated bullet naming its subject', () => {
  const lines = controller.incidentLines([
    { reportTypes: '["Bullying"]', incidentDateTime: '2024-06-14 09:00:00' },
  ]);
  assert.deepEqual(lines, ['Had an Incident Report regarding involvement in Bullying - June 2024']);
});

test('only activities in the aspect own categories are offered', () => {
  const lines = controller.activityLines([
    { title: 'Safety measures session', category: 'Physical', date: '2024-08-05' },
    { title: 'Tutorial', category: 'Educational', date: '2024-08-06' },
  ], ['Physical']);
  assert.deepEqual(lines, ['Involvement in Safety measures session - August 2024']);
});

test('the educational aspect reads the Anecdotal Report education field, not physical', () => {
  const records = {
    anecdotal: [{
      reportDate: '2024-06-10',
      content: JSON.stringify({
        physical: 'Practices adequate self-care',
        education: 'Participative during sessions with the Center Educator',
        productivity: 'Joins daily household chores',
      }),
    }],
    activities: [],
    incidents: [],
    tri: [],
    health: [],
    educationReports: [],
    schoolVisits: [],
    interventions: [],
    periodStart: '2024-06-01',
    periodEnd: '2024-08-31',
  };

  const educational = controller.assembleAspect(controller.ASPECTS.find((a) => a.key === 'educational'), records);
  assert.match(educational.assembledObservations, /Participative during sessions/);
  assert.doesNotMatch(educational.assembledObservations, /adequate self-care/);

  const productivity = controller.assembleAspect(controller.ASPECTS.find((a) => a.key === 'economicProductivity'), records);
  assert.match(productivity.assembledObservations, /Joins daily household chores/);
});

test('the assembled draft is a bullet list and the rating is left blank', () => {
  const records = {
    anecdotal: [{ reportDate: '2024-06-10', content: JSON.stringify({ physical: 'Line one\nLine two' }) }],
    activities: [], incidents: [], tri: [], health: [], educationReports: [], schoolVisits: [], interventions: [],
    periodStart: '2024-06-01', periodEnd: '2024-08-31',
  };
  const section = controller.assembleAspect(controller.ASPECTS.find((a) => a.key === 'physical'), records);

  assert.equal(section.assembledObservations, '- Line one\n- Line two');
  // The rating is a professional judgement; the system must never invent one.
  assert.equal(section.assembledPresentLevel, '');
});

test('an aspect with nothing on file assembles empty rather than throwing', () => {
  const records = {
    anecdotal: [], activities: [], incidents: [], tri: [], health: [],
    educationReports: [], schoolVisits: [], interventions: [],
    periodStart: '2024-06-01', periodEnd: '2024-08-31',
  };
  for (const aspect of controller.ASPECTS) {
    const section = controller.assembleAspect(aspect, records);
    assert.equal(section.assembledObservations, '');
    assert.equal(section.assembledInterventions, '');
  }
});

// ── SOURCE-LEVEL GUARDS ─────────────────────────────────────────────────────

test('the schema declares the new tables and no longer the superseded ones', () => {
  const schema = read('backend/src/database/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS quarterlyProgressReports \(/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS quarterlyProgressReportSections \(/);
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS quarterlyReports \(/);
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS quarterlyReportSections \(/);
});

test('the report is keyed by an explicit period, never by a quarter number', () => {
  const schema = read('backend/src/database/schema.sql');
  const table = /CREATE TABLE IF NOT EXISTS quarterlyProgressReports \(([\s\S]*?)\n\)\s*ENGINE/.exec(schema);
  assert.ok(table, 'expected to find the quarterlyProgressReports table');
  assert.match(table[1], /periodStart DATE NOT NULL/);
  assert.match(table[1], /periodEnd DATE NOT NULL/);
  assert.doesNotMatch(table[1], /\bquarter\b/i);
  assert.doesNotMatch(table[1], /\breportYear\b/);
});

test('each aspect stores both the assembled draft and the curated text', () => {
  const schema = read('backend/src/database/schema.sql');
  const table = /CREATE TABLE IF NOT EXISTS quarterlyProgressReportSections \(([\s\S]*?)\n\)\s*ENGINE/.exec(schema);
  assert.ok(table, 'expected to find the quarterlyProgressReportSections table');
  for (const column of ['assembledObservations', 'assembledInterventions', 'assembledPresentLevel']) {
    assert.match(table[1], new RegExp(column), `missing ${column}`);
  }
  for (const column of ['observations', 'interventions', 'presentLevel']) {
    assert.match(table[1], new RegExp(`\\b${column} TEXT`), `missing curated ${column}`);
  }
});

test('the RESOURCES contract matches the renamed tables', () => {
  const constants = read('backend/src/utils/constants.js');
  assert.match(constants, /quarterlyProgressReports: \{/);
  assert.match(constants, /quarterlyProgressReportSections: \{/);
  assert.doesNotMatch(constants, /^\s{2}quarterlyReports: \{/m);
  assert.doesNotMatch(constants, /^\s{2}quarterlyReportSections: \{/m);
});

test('literal routes are declared before /:id, or they would be read as ids', () => {
  const routes = read('backend/src/routes/quarterlyProgressReportRoutes.js');
  const literal = routes.indexOf("'/periods'");
  const param = routes.indexOf("'/:id'");
  assert.ok(literal > -1 && param > -1);
  assert.ok(literal < param, "'/periods' must be declared before '/:id'");
  // `assert.ok(-1 < param)` would pass on a route that no longer exists, so the
  // literal is required to be present AND before the parameter route.
  const identifying = routes.indexOf("'/identifying/:residentId'");
  assert.ok(identifying > -1, "'/identifying/:residentId' must still be declared");
  assert.ok(identifying < param, "'/identifying/:residentId' must precede '/:id'");
});

test('the PDF is published before the status flips to Finalized', () => {
  // If the order were reversed, a generation failure would leave a report marked
  // Finalized with no document in the resident's folder.
  const source = read('backend/src/controllers/quarterlyProgressReportController.js');
  const body = /async function finalize\(([\s\S]*?)\n\/\*\* GET \/quarterly-progress-reports\/:id\/pdf/.exec(source);
  assert.ok(body, 'expected to find the finalize handler');
  const publish = body[1].indexOf('syncDocumentForReport(');
  const flip = body[1].indexOf("status = 'Finalized'");
  assert.ok(publish > -1, 'finalize must publish the document');
  assert.ok(flip > -1, 'finalize must set the status');
  assert.ok(publish < flip, 'the document must be published before the status changes');
});

test('the report has no module of its own any more', () => {
  const moduleAccess = read('frontend/src/app/config/moduleAccess.ts');
  assert.doesNotMatch(moduleAccess, /'Quarterly Reports'/);
  assert.doesNotMatch(moduleAccess, /\/quarterly-reports/);
});

test('every role that can prepare a report can reach the Reports module', () => {
  // The report is a card inside Reports, so a preparer without 'Reports' would
  // have no page to prepare it on. Only the roles the server accepts as preparers
  // need the module — the report is no longer shared out to other staff.
  const moduleAccess = read('frontend/src/app/config/moduleAccess.ts');
  const block = /export const DEFAULT_MODULE_ACCESS[^{]*\{([\s\S]*?)\n\};/.exec(moduleAccess);
  assert.ok(block, 'expected to find DEFAULT_MODULE_ACCESS');

  const arrayFor = (role) => {
    // Checked first: `role: [...AVAILABLE_MODULES]` also matches the literal-list
    // pattern below, and would be captured as the useless string
    // "...AVAILABLE_MODULES".
    if (new RegExp(`\\b${role}:\\s*\\[\\.\\.\\.AVAILABLE_MODULES\\]`).test(block[1])) return 'EVERY_MODULE';
    const match = new RegExp(`\\b${role}:\\s*\\[([^\\]]*)\\]`).exec(block[1]);
    return match ? match[1] : '';
  };

  for (const role of ['socialworker', 'centerhead', 'admin']) {
    const entry = arrayFor(role);
    assert.notEqual(entry, '', `no DEFAULT_MODULE_ACCESS entry found for ${role}`);
    assert.ok(
      entry === 'EVERY_MODULE' || entry.includes("'Reports'"),
      `${role} can prepare a report but cannot reach the Reports module`
    );
  }
});

test('the sidebar has no quarterly entry and Reports is not listed twice', () => {
  const layout = read('frontend/src/app/components/Layout.tsx');
  assert.doesNotMatch(layout, /quarterly/i);
  const reports = [...layout.matchAll(/path: '\/reports'/g)];
  assert.equal(reports.length, 1, 'the Reports sidebar entry must appear exactly once');
});

test('a quarterly notification deep-links into the Reports module', () => {
  const notifications = read('frontend/src/app/components/Notifications.tsx');
  const section = /case 'quarterly progress report':([\s\S]*?)break;/.exec(notifications);
  assert.ok(section, 'expected the quarterly notification case');
  assert.match(section[1], /\/reports\?quarterlyReportId=/);
  assert.doesNotMatch(notifications, /\/quarterly-reports/);
});

// ── PERMISSIONS ─────────────────────────────────────────────────────────────

test('the preparer may edit every aspect of the report', () => {
  // There is no per-aspect ownership any more. The report has one preparer, and
  // preparing it is the permission — so all six aspects are editable by them.
  const report = { id: 'QPR1', status: 'Draft' };
  const sw = { id: 'USR1', username: 'sw', role: 'socialworker' };
  for (const aspectKey of ['physical', 'emotional', 'behavioral', 'spiritual', 'educational', 'economicProductivity']) {
    const section = { id: `QRS-${aspectKey}`, aspectKey, status: 'Not Started' };
    assert.equal(
      controller.decorateSection({ user: sw }, section, report).canEdit,
      true,
      `${aspectKey} must be editable by the Social Worker`
    );
  }
});

test('a staff member who does not prepare reports may edit no aspect at all', () => {
  // The other half of removing assignment: an aspect used to be editable by
  // whoever it was assigned to. With assignment gone there is no aspect for a
  // Houseparent or Nurse to write, and the server refuses rather than filtering.
  const report = { id: 'QPR1', status: 'Draft' };
  const section = { id: 'QRS1', aspectKey: 'physical', status: 'Not Started' };
  for (const role of ['houseparent', 'nurse', 'psychologist', 'educator']) {
    const user = { id: 'USR7', username: 'juan', role };
    assert.equal(
      controller.decorateSection({ user }, section, report).canEdit,
      false,
      `${role} must not be able to edit an aspect`
    );
  }
});

test('the Center Head has the same capability as the Social Worker', () => {
  // The report is normally the Social Worker's, but the Center Head can file one
  // too — which is why the "Prepared by" name follows the caller rather than
  // being hard-coded to a role.
  const report = { id: 'QPR1', status: 'Draft' };
  const section = { id: 'QRS1', status: 'Not Started' };
  const centerhead = { id: 'USR2', username: 'ch', role: 'centerhead' };
  assert.equal(controller.decorateSection({ user: centerhead }, section, report).canEdit, true);
  assert.equal(controller.mapReport({ user: centerhead }, report, []).canEditReport, true);
});

test('a finalized report is read-only for everyone', () => {
  const report = { id: 'QPR1', status: 'Finalized' };
  const section = { id: 'QRS1', status: 'In Progress', presentLevel: 'Moderate' };
  for (const role of ['houseparent', 'socialworker', 'centerhead', 'admin']) {
    const decorated = controller.decorateSection({ user: { id: 'U', username: 'u', role } }, section, report);
    assert.equal(decorated.canEdit, false, `${role} must not edit a finalized report`);
  }
  const mapped = controller.mapReport({ user: { id: 'U', username: 'u', role: 'socialworker' } }, report, [section]);
  assert.equal(mapped.canEditReport, false);
  assert.equal(mapped.canFinalize, false);
  assert.equal(mapped.canDelete, false);
});

test('only a preparer may finalize or delete', () => {
  const report = { id: 'QPR1', status: 'Draft' };
  const filled = [{ presentLevel: 'Normal', observations: 'x', interventions: 'y' }];
  const owner = controller.mapReport({ user: { id: 'USR7', username: 'juan', role: 'houseparent' } }, report, filled);
  assert.equal(owner.isReviewer, false);
  assert.equal(owner.canEditReport, false);
  assert.equal(owner.canFinalize, false);
  assert.equal(owner.canDelete, false);

  const reviewer = controller.mapReport({ user: { id: 'USR1', username: 'sw', role: 'socialworker' } }, report, filled);
  assert.equal(reviewer.isReviewer, true);
  assert.equal(reviewer.canEditReport, true);
  assert.equal(reviewer.canFinalize, true);
  assert.equal(reviewer.canDelete, true);
});

test('an aspect counts as written once it holds any text', () => {
  // The completeness gate replaced the per-aspect "submitted" flag. An aspect is
  // either written or it is not, and that is all finalizing needs to know — so a
  // rating with no narrative still counts, and a narrative with no rating does.
  const report = { id: 'QPR1', status: 'Draft' };
  const sw = { id: 'USR1', username: 'sw', role: 'socialworker' };
  const sections = [
    { id: 'QRS1', presentLevel: 'Moderate', observations: '', interventions: '' },
    { id: 'QRS2', presentLevel: '', observations: 'Observed.', interventions: '' },
    { id: 'QRS3', presentLevel: '', observations: '', interventions: 'Provided.' },
    { id: 'QRS4', presentLevel: '', observations: '', interventions: '' },
  ];
  assert.equal(controller.sectionHasContent(sections[0]), true, 'a rating alone is content');
  assert.equal(controller.sectionHasContent(sections[1]), true, 'observations alone are content');
  assert.equal(controller.sectionHasContent(sections[3]), false);
  assert.deepEqual(
    controller.incompleteSections(sections).map((s) => s.id),
    ['QRS4']
  );

  const mapped = controller.mapReport({ user: sw }, report, sections);
  assert.equal(mapped.sectionsTotal, 4);
  assert.equal(mapped.sectionsComplete, 3);
  assert.equal(mapped.canFinalize, false, 'a blank aspect must block finalizing');
  assert.equal(
    controller.mapReport({ user: sw }, report, sections.slice(0, 3)).canFinalize,
    true,
    'finalizing is allowed once every aspect holds something'
  );
});

// ── THE PDF ─────────────────────────────────────────────────────────────────

test('multi-line cell content survives into the PDF as separate lines', () => {
  // Regression guard. `sanitize` maps every character outside printable Latin-1
  // to '?', and '\n' is one of them — so wrapping the sanitized string meant
  // every multi-line cell was drawn as one run-on line of '?' separators, which
  // is exactly what the assembled bullet lists are made of.
  const font = { widthOfTextAtSize: (text) => text.length * 5 };
  const lines = pdf.wrapToWidth('- first\n- second\n- third', font, 9, 1000);
  assert.deepEqual(lines, ['- first', '- second', '- third']);
});

test('a long line is still wrapped to the column width', () => {
  const font = { widthOfTextAtSize: (text) => text.length * 5 };
  const lines = pdf.wrapToWidth('one two three four five six', font, 9, 50);
  assert.ok(lines.length > 1, 'expected the line to wrap');
  for (const line of lines) assert.ok(font.widthOfTextAtSize(line) <= 50);
});

test('the rendered PDF has no section sign-offs and one signature slot', async () => {
  // Asserted against the drawn text rather than the source: `drawSectionSignOffs`
  // being gone from the file would not prove the table is gone from the page if
  // something else still drew the same headings.
  const buffer = await pdf.buildQuarterlyReportPdf({
    id: 'QPR1', residentId: 'CH001',
    periodStart: '2024-04-01', periodEnd: '2024-06-30', periodLabel: 'Q2 2024',
    preparedByName: 'Soc Worker', preparedBySignature: null,
    identifyingInformation: { childName: 'Juan Dela Cruz', _sources: {} },
  }, pdf.ASPECTS.map((aspect, index) => ({
    aspectKey: aspect.key, aspectLabel: aspect.label, sortOrder: index,
    presentLevel: 'Moderate',
    // Short markers: a long cell wraps and would split the marker across two
    // drawn strings, reading as a false negative.
    observations: `- OBS-${aspect.key}`,
    interventions: `- INT-${aspect.key}`,
  })), 'Juan Dela Cruz');

  const text = pdfDrawnText(buffer).join('\n');

  // Removed: the per-aspect sign-off table and the two extra signature blocks.
  for (const gone of ['SECTION SIGN-OFFS', 'Assigned To', 'Unassigned', 'Attested by:', 'Noted by:']) {
    assert.equal(text.includes(gone), false, `"${gone}" must not be printed any more`);
  }

  // Kept: the report's own output, and the single signature that remains.
  for (const kept of [
    'SECOND CHANCE HOME', 'QUARTERLY PROGRESS REPORT', 'APRIL-JUNE 2024',
    'Developmental Aspect', 'Present level of Functioning', 'Rendered',
    'SIGNATURES', 'Prepared by:', 'Soc Worker',
  ]) {
    assert.ok(text.includes(kept), `"${kept}" must still be printed`);
  }

  // All six aspects, with their narrative.
  for (const aspect of pdf.ASPECTS) {
    assert.ok(text.includes(`OBS-${aspect.key}`), `missing observations for ${aspect.key}`);
    assert.ok(text.includes(`INT-${aspect.key}`), `missing interventions for ${aspect.key}`);
  }
});

test('the generated PDF carries the period header and no quarter label', async () => {
  const buffer = await pdf.buildQuarterlyReportPdf({
    id: 'QPR1',
    residentId: 'CH001',
    periodStart: '2024-06-01',
    periodEnd: '2024-08-31',
    periodLabel: 'June - August 2024',
    identifyingInformation: { childName: 'Juan Dela Cruz', sex: 'Male', _sources: {} },
  }, [], 'Juan Dela Cruz');

  const text = pdfDrawnText(buffer).join('\n');
  assert.match(text, /SECOND CHANCE HOME/);
  assert.match(text, /QUARTERLY PROGRESS REPORT/);
  assert.match(text, /JUNE-AUGUST 2024/);
  assert.doesNotMatch(text, /\bQ[1-4] 20\d\d\b/);
});

test('the PDF prints the four columns the official form asks for', async () => {
  const buffer = await pdf.buildQuarterlyReportPdf({
    id: 'QPR1', residentId: 'CH001',
    periodStart: '2024-06-01', periodEnd: '2024-08-31',
    identifyingInformation: { childName: 'Juan Dela Cruz', _sources: {} },
  }, pdf.ASPECTS.map((aspect, index) => ({
    aspectKey: aspect.key, aspectLabel: aspect.label, sortOrder: index,
    presentLevel: 'Moderate',
    observations: `- OBS-${aspect.key}`,
    interventions: `- INT-${aspect.key}`,
  })), 'Juan Dela Cruz');

  const text = pdfDrawnText(buffer).join('\n');
  // Asserted as fragments: pdf-lib wraps the header cells, so the full phrase is
  // split across several drawn strings.
  for (const fragment of ['Developmental Aspect', 'Present level of Functioning', 'Observations', 'Rendered', 'Programs/Activities/Intervention']) {
    assert.ok(text.includes(fragment), `missing column header fragment "${fragment}"`);
  }
  for (const aspect of pdf.ASPECTS) {
    assert.ok(text.includes(`OBS-${aspect.key}`), `missing observations for ${aspect.key}`);
    assert.ok(text.includes(`INT-${aspect.key}`), `missing interventions for ${aspect.key}`);
  }
});

test('a report with no period still renders rather than throwing', async () => {
  const buffer = await pdf.buildQuarterlyReportPdf({ id: 'QPR1', residentId: 'CH001' }, [], 'Resident');
  assert.ok(buffer.length > 0);
});

test('the period helpers agree with each other', () => {
  assert.equal(pdf.periodRangeLabel('2024-06-01', '2024-08-31'), 'June - August 2024');
  assert.equal(pdf.periodHeaderLabel('2024-06-01', '2024-08-31'), 'JUNE-AUGUST 2024');
  assert.equal(pdf.periodRangeLabel('2024-12-01', '2025-02-28'), 'December 2024 - February 2025');
  assert.equal(pdf.periodRangeLabel('', ''), '');
});

test('a malformed date yields an empty label instead of a shifted one', () => {
  // `new Date('2024-06-01')` parses as UTC and reads back locally; west of
  // Greenwich that lands on 31 May and would move the whole period a month.
  assert.equal(pdf.periodRangeLabel('not-a-date', '2024-08-31'), '');
  assert.equal(pdf.periodRangeLabel('2024-13-01', '2024-08-31'), '');
});

test('the file name names the period, not a quarter', () => {
  const name = pdf.quarterlyReportFileName(
    { periodStart: '2024-06-01', periodEnd: '2024-08-31', identifyingInformation: { childName: 'Juan' } },
    'Juan'
  );
  assert.equal(name, 'Quarterly Progress Report - Juan - June - August 2024.pdf');
});

// ── HTTP ────────────────────────────────────────────────────────────────────

const DB_MODULE_PATH = require.resolve('../src/config/database');
const ROUTES_MODULE_PATH = require.resolve('../src/routes');
const CONTROLLER_MODULE_PATH = require.resolve('../src/controllers/quarterlyProgressReportController');

function purgeSrcModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC) && !key.includes('node_modules')) delete require.cache[key];
  }
}

/** A pool that answers the auth lookup and returns empty sets for everything else. */
function createPoolStub() {
  const queries = [];
  async function query(sql, params) {
    const text = String(sql);
    queries.push({ sql: text, params });
    if (/FROM users WHERE id = \?/i.test(text)) {
      return [[{ id: 'U-TEST', username: 'tester', role: 'centerhead', status: 'Active' }]];
    }
    return [[]];
  }
  return {
    queries,
    query,
    async getConnection() {
      return { query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
    },
  };
}

function loadApp(poolStub) {
  purgeSrcModules();
  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH,
    filename: DB_MODULE_PATH,
    loaded: true,
    exports: { pool: poolStub, dbConfig: {}, testConnection: async () => true },
  };
  const express = require('express');
  const routes = require(ROUTES_MODULE_PATH);
  const { errorHandler, notFoundHandler } = require('../src/middleware/errorHandler');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', routes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/**
 * Loads a fresh controller bound to `poolStub`, so a test can drive the queries
 * it makes without a database.
 *
 * Why a fresh instance rather than patching the pool the controller at the top of
 * this file closed over: `loadApp` above purges every `src` module from
 * `require.cache`, so a `require('../src/config/database')` issued from inside a
 * test resolves to a *new* module — a different pool object from the one the
 * cached controller is holding. Patching that one leaves the real pool in place
 * and the test opens an actual connection.
 */
function loadController(poolStub) {
  purgeSrcModules();
  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH,
    filename: DB_MODULE_PATH,
    loaded: true,
    exports: { pool: poolStub, dbConfig: {}, testConnection: async () => true },
  };
  return require(CONTROLLER_MODULE_PATH);
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const originalError = console.error;
  console.error = () => {};
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
  }
}

const authed = (base, url, init = {}) => fetch(`${base}${url}`, {
  ...init,
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwt.sign({ id: 'U-TEST', username: 'tester', role: 'centerhead' }, TEST_SECRET, { expiresIn: '1h' })}`,
    ...(init.headers || {}),
  },
});

test('GET /periods reaches the periods handler, not the /:id handler', async () => {
  // This is the runtime proof of the literal-before-parameter ordering. If the
  // order were wrong, "/periods" would be matched as a report id and the request
  // would come back as a 404 "report not found" instead of a period list.
  const app = loadApp(createPoolStub());
  await withServer(app, async (base) => {
    const response = await authed(base, '/api/quarterly-progress-reports/periods?year=2024');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.data.length, 4);
    assert.equal(body.data[0].headerLabel, 'Q1 2024');
  });
});

test('the report endpoints require authentication', async () => {
  const app = loadApp(createPoolStub());
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/quarterly-progress-reports/periods?year=2024`);
    assert.equal(response.status, 401);
  });
});

test('opening a report validates its period before touching the database', async () => {
  const poolStub = createPoolStub();
  const app = loadApp(poolStub);
  await withServer(app, async (base) => {
    const response = await authed(base, '/api/quarterly-progress-reports', {
      method: 'POST',
      body: JSON.stringify({ residentId: 'CH001' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.message, /periodStart and periodEnd are required/i);
    // `ensureTables` legitimately runs a CREATE first, so the assertion is about
    // the read and write paths, not about the connection being untouched.
    assert.equal(
      poolStub.queries.some((q) => /(INSERT INTO|SELECT .* FROM) quarterlyProgressReports/i.test(q.sql)),
      false,
      'no report row should be read or written when the period is missing'
    );
  });
});

test('a reversed period is rejected rather than silently producing an empty report', async () => {
  const app = loadApp(createPoolStub());
  await withServer(app, async (base) => {
    const response = await authed(base, '/api/quarterly-progress-reports', {
      method: 'POST',
      body: JSON.stringify({ residentId: 'CH001', periodStart: '2024-08-31', periodEnd: '2024-06-01' }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /must not be after/i);
  });
});

// ── AUDIT REGRESSIONS ───────────────────────────────────────────────────────
//
// Each test below pins a defect found by auditing the controller against the
// tables it actually reads. They are the silent kind: the report still renders,
// and the aspect simply comes out empty or carries a wrong date.

const CONTROLLER_SOURCE = fs.readFileSync(
  path.join(SRC, 'controllers/quarterlyProgressReportController.js'),
  'utf8'
);

/** The source of one top-level function, up to the next `async function`/comment banner. */
function controllerBody(signature, until) {
  const start = CONTROLLER_SOURCE.indexOf(signature);
  assert.ok(start > -1, `expected to find ${signature}`);
  const end = CONTROLLER_SOURCE.indexOf(until, start);
  assert.ok(end > start, `expected to find ${until} after ${signature}`);
  return CONTROLLER_SOURCE.slice(start, end);
}

/** A Form 11-A grid exactly as Health.tsx seeds it: twelve rows, untouched ones empty. */
function form11aGrid(filled) {
  const grid = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, height: '', weight: '' }));
  for (const [month, height, weight] of filled) grid[month - 1] = { month, height, weight };
  return [{ date: '2024-06-01', details: { monitoringYear: '2024', monthlyMeasurements: grid } }];
}

test('an untouched Form 11-A grid row is not a measurement', () => {
  // Health.tsx seeds all twelve months and stores `{ month, height: '', weight: '' }`.
  // `Number('')` is 0, which is finite, so an empty row used to be pushed as a
  // measurement — and because January sorts first it became the baseline. The
  // weight and height lines were then skipped for every real resident, because
  // `baseline.weight` was null. This is the reference document's headline content.
  const lines = controller.healthMeasurementLines(
    form11aGrid([[6, '150', '42.75'], [8, '151', '45.35']]),
    '2024-06-01',
    '2024-08-31'
  );

  assert.ok(
    lines.includes('Improvement in weight: from 42.75 kg. (admission) to 45.35 kg. as per update'),
    `expected the reference document's weight line, got: ${JSON.stringify(lines)}`
  );
  assert.ok(
    lines.includes('Improvement in height: from 150 cm (admission) to 151 cm as per update'),
    `expected the reference document's height line, got: ${JSON.stringify(lines)}`
  );
});

test('a grid row with only one of height or weight still counts as a measurement', () => {
  const lines = controller.healthMeasurementLines(
    form11aGrid([[6, '150', ''], [8, '151', '']]),
    '2024-06-01',
    '2024-08-31'
  );
  assert.ok(lines.some((l) => l.startsWith('Improvement in height:')), JSON.stringify(lines));
  assert.equal(lines.some((l) => l.startsWith('Improvement in weight:')), false, 'no weight was ever recorded');
});

test('the BMI line is not a comparison of a value with itself', () => {
  // The weight and height lines already refuse to compare a measurement with
  // itself; the BMI line did not, so a resident with one measurement on file got
  // "Normal BMI from admission (20) up to present (20)."
  const lines = controller.healthMeasurementLines(form11aGrid([[6, '150', '45']]), '2024-06-01', '2024-08-31');
  assert.deepEqual(lines, [], 'one measurement is not progress');
});

test('a period with no measurement falls back to the latest on record', () => {
  // The resident was measured before the period and not during it. The delta is
  // still true, so it is still printed.
  const lines = controller.healthMeasurementLines(
    form11aGrid([[1, '148', '40'], [2, '149', '41']]),
    '2024-06-01',
    '2024-08-31'
  );
  assert.ok(
    lines.includes('Improvement in weight: from 40 kg. (admission) to 41 kg. as per update'),
    JSON.stringify(lines)
  );
});

test('the current period is the one that actually contains today', () => {
  // `periodForDate` drives the picker's "current period" default. It used to
  // return a FUTURE period in January and February — the previous December
  // period was never considered — and a PAST one in December, because the
  // candidate list was unsorted and it took the last "already started" entry.
  const cases = [
    ['2026-01-15', '2026-01-01', '2026-03-31', 'Q1 2026'],
    ['2026-02-28', '2026-01-01', '2026-03-31', 'Q1 2026'],
    ['2026-03-31', '2026-01-01', '2026-03-31', 'Q1 2026'],
    ['2026-04-01', '2026-04-01', '2026-06-30', 'Q2 2026'],
    ['2026-06-15', '2026-04-01', '2026-06-30', 'Q2 2026'],
    ['2026-07-01', '2026-07-01', '2026-09-30', 'Q3 2026'],
    ['2026-10-01', '2026-10-01', '2026-12-31', 'Q4 2026'],
    ['2026-12-31', '2026-10-01', '2026-12-31', 'Q4 2026'],
  ];
  for (const [date, start, end, header] of cases) {
    const period = controller.periodForDate(new Date(`${date}T12:00:00`));
    assert.equal(period.periodStart, start, `${date} start`);
    assert.equal(period.periodEnd, end, `${date} end`);
    assert.equal(period.headerLabel, header, `${date} header`);
  }
});

test('the four periods of a year tile the calendar with no gap and no overlap', () => {
  // If they do not tile, `periodForDate` cannot be a lookup: a date could fall
  // outside every period or inside two of them. Calendar quarters tile the year
  // exactly, from 1 January to 31 December.
  const periods = controller.periodsForYear(2024)
    .slice()
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  assert.equal(periods[0].periodStart, '2024-01-01');
  for (let i = 1; i < periods.length; i += 1) {
    const previousEnd = new Date(`${periods[i - 1].periodEnd}T00:00:00Z`);
    const thisStart = new Date(`${periods[i].periodStart}T00:00:00Z`);
    assert.equal(
      thisStart - previousEnd,
      24 * 60 * 60 * 1000,
      `${periods[i - 1].periodEnd} must be the day before ${periods[i].periodStart}`
    );
  }
  // The last period closes the same year it opened: nothing runs over.
  assert.equal(periods[periods.length - 1].periodEnd, '2024-12-31');
});

test('an activity is not reported under three different aspects', () => {
  // The sample never repeats a line across aspects. Psychosocial was mapped to
  // emotional, behavioral AND spiritual, so one group session printed three
  // times in the combined PDF and was handed to three different staff members.
  const owners = Object.entries(controller.ASPECT_SOURCES)
    .filter(([, config]) => (config.activityCategories || []).includes('Psychosocial'))
    .map(([key]) => key);
  assert.deepEqual(
    owners,
    ['emotional', 'behavioral'],
    'a psychosocial activity is evidence of emotional and behavioral functioning, not of spiritual practice'
  );
});

test('every activity category the Activities module offers is claimed by an aspect', () => {
  // An unclaimed category means activities that are recorded and then never
  // appear in any aspect's draft.
  const declared = read('frontend/src/app/components/Activities.tsx')
    .match(/const activityCategories = \[([^\]]+)\]/)[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  assert.equal(declared.length, 5, `expected 5 categories, parsed ${JSON.stringify(declared)}`);

  const claimed = new Set(
    Object.values(controller.ASPECT_SOURCES).flatMap((config) => config.activityCategories || [])
  );
  for (const category of declared) {
    assert.ok(claimed.has(category), `${category} is offered by Activities.tsx but no aspect claims it`);
  }
});

test('the assembly does not query triRecords, which it never reads', () => {
  // It was fetched and then ignored: a wasted round trip, and the module header
  // claimed TRI was a source when it was not.
  const load = controllerBody('async function loadPeriodRecords', 'function healthMeasurementLines');
  assert.doesNotMatch(load, /triRecords/, 'loadPeriodRecords must not query a table it does not use');
  assert.doesNotMatch(CONTROLLER_SOURCE, /STR_TO_DATE/, 'the unused TRI query carried a fragile STR_TO_DATE');
});

test('editing an aspect that has not been started moves it to In Progress', () => {
  // Otherwise the badge keeps saying "Not Started" for an aspect that already
  // holds a full draft, and nobody can tell it apart from a blank one.
  const update = controllerBody('async function updateSection', 'async function signReport');
  assert.match(
    update,
    /'Not Started'[\s\S]{0,80}'In Progress'/,
    'a first write must advance the section out of Not Started'
  );
});

test('an aspect is editable by the preparer and nobody else', () => {
  // This replaces the old "canSubmit is false while the aspect is empty" guard.
  // There is no per-aspect Submit any more, so what the server has to get right
  // is who may write the aspect at all — and `canEdit` is what the UI keys off.
  const empty = {
    id: 'QRS1', status: 'Not Started',
    presentLevel: '', observations: '', interventions: '',
  };
  const sw = { user: { id: 'U1', username: 'sw1', role: 'socialworker' } };
  const houseparent = { user: { id: 'U2', username: 'hp1', role: 'houseparent' } };

  assert.equal(controller.decorateSection(sw, empty, { status: 'Draft' }).canEdit, true);
  assert.equal(controller.decorateSection(houseparent, empty, { status: 'Draft' }).canEdit, false);
  assert.equal(
    controller.decorateSection(sw, empty, { status: 'Draft' }).hasContent,
    false,
    'an empty aspect must report itself as unwritten'
  );
});

test('the per-aspect submit and return endpoints are gone', () => {
  // The report has one preparer and one signature, so there is nothing for a
  // per-aspect Submit or Return to do. Their absence is asserted against the
  // route declarations, with comments stripped — the file's own note explains
  // which routes were removed, and that prose must not satisfy the check.
  const routes = stripComments(read('backend/src/routes/quarterlyProgressReportRoutes.js'));
  assert.doesNotMatch(routes, /sections\/:sectionId\/submit/);
  assert.doesNotMatch(routes, /sections\/:sectionId\/return/);
  assert.doesNotMatch(routes, /'\/:id\/assign'/);
  assert.doesNotMatch(routes, /'\/:id\/submit'/);
  assert.doesNotMatch(routes, /'\/:id\/return'/);
  assert.doesNotMatch(routes, /assignable-staff/);
  // The two that remain.
  assert.match(routes, /'\/:id\/signatures'/);
  assert.match(routes, /'\/:id\/finalize'/);
});

test('the report has exactly one signature slot, and it is the preparer', () => {
  // The three-block sign-off (Prepared by / Attested by / Noted by) and the
  // SECTION SIGN-OFFS table were removed at the facility's request. The PDF must
  // print the single remaining slot and none of the removed ones.
  const source = read('backend/src/utils/quarterlyReportPdf.js');
  assert.doesNotMatch(source, /drawSectionSignOffs/, 'the SECTION SIGN-OFFS table must be gone');
  assert.doesNotMatch(source, /'SECTION SIGN-OFFS'/);
  assert.doesNotMatch(source, /Attested by:/);
  assert.doesNotMatch(source, /Noted by:/);
  assert.match(source, /caption: 'Prepared by:'/);
  assert.match(source, /preparedBySignature/);
});

test('the identifying block is only replaced by a plain object', () => {
  // `JSON.stringify('some string')` stores a JSON scalar, which `asObject` then
  // reads back as `{}` — silently wiping every field of the identifying block.
  const update = controllerBody('async function update(', 'async function remove(');
  assert.match(
    update,
    /isPlainObject|typeof identifyingInformation !== 'object'/,
    'a non-object identifyingInformation must be rejected, not stringified'
  );
});

// ── THE EDITOR'S CAPABILITIES ───────────────────────────────────────────────
//
// The UI renders exactly what the server sends. These guard the two places where
// a client-side condition quietly cancelled a server capability.

const EDITOR_TSX = read('frontend/src/app/components/QuarterlyProgressReport.tsx');

/**
 * Removes comments so a source assertion cannot trip on prose.
 *
 * Learned the hard way: an assertion that a symbol is absent will match the
 * comment that explains why it is absent. Assert against code, not commentary.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const EDITOR_CODE = stripComments(EDITOR_TSX);

test('the assignment control and the per-aspect workflow controls are gone', () => {
  // Assignee selection was removed — the Social Worker completes the report
  // directly — and with it every control that belonged to the per-aspect
  // workflow: the Submit-aspect button, the Return-for-revision dialog, the
  // Move-to-Under-Review button and the assembled-draft checklist.
  for (const gone of [
    'Assign to',
    'Submit aspect',
    'Return for revision',
    'Move to Under Review',
    'Assembled from this period',
  ]) {
    assert.equal(
      EDITOR_CODE.indexOf(gone),
      -1,
      `"${gone}" must not exist after the per-aspect workflow was removed`
    );
  }
});

test('the editor offers the three fields each aspect needs', () => {
  // Requirement 2 in the UI: the Social Worker must be able to complete every
  // Developmental Aspect, which means all three fields on every aspect. The
  // column headings themselves are printed by the PDF; these are the accessible
  // names of the three inputs laid over each blank row.
  for (const label of [
    'present level of functioning',
    'observations',
    'rendered programs, activities and intervention',
  ]) {
    assert.ok(EDITOR_CODE.includes(label), `the editor must render a "${label}" field`);
  }
  // Six aspects are six rows of one form, so there is one save for the form
  // rather than a save per aspect — "save aspect" made each one feel like a
  // separate document, which is what the per-aspect workflow used to be.
  assert.match(EDITOR_CODE, /Save form/, 'the form must have a single Save control');
  assert.equal(
    EDITOR_CODE.indexOf('Save aspect'),
    -1,
    'there must be no per-aspect save after the form was unified'
  );
});

test('the form is the report: the template PDF is rendered with inputs over it', () => {
  // The TRI pattern, which is what was asked for: the document is shown as it
  // prints and only the writable fields are overlaid on it. Composing the form
  // out of HTML boxes instead would be a second rendering of the report's layout
  // to keep in step with the PDF.
  assert.match(EDITOR_CODE, /PdfDocument/, 'the template must be rendered as a PDF');
  assert.match(EDITOR_CODE, /PdfPage/, 'the template must be rendered as a PDF');
  assert.match(
    EDITOR_CODE,
    /quarterly-progress-reports\/\$\{encodeURIComponent\(reportId\)\}\/template/,
    'the template must come from the report endpoint'
  );
  // Full-screen, like the TRI's form dialog — a "proper pop up form".
  assert.match(EDITOR_CODE, /<Dialog open/, 'the form must open as a dialog');
  assert.match(EDITOR_CODE, /!h-screen !w-screen/, 'the dialog must be full-screen');
});

test('the overlaid inputs are positioned from the shared layout', () => {
  // The coordinates live in one JSON file that the backend PDF writer also reads,
  // so an input cannot drift off the cell it belongs to.
  assert.match(
    EDITOR_CODE,
    /import templateLayout from '@\/shared\/quarterlyReportTemplate\.json'/,
    'the shared layout must be imported'
  );
  assert.match(EDITOR_CODE, /LAYOUT\.table\.tableTops/, 'rows must be placed from the shared layout');
  assert.match(EDITOR_CODE, /LAYOUT\.table\.rowHeight/, 'the row height must come from the shared layout');
  assert.match(EDITOR_CODE, /LAYOUT\.signature/, 'the signature band must come from the shared layout');
  // PDF points are converted to fractions of the page, so the overlay scales with
  // the render rather than being pinned to one pixel width.
  assert.match(EDITOR_CODE, /LAYOUT\.page\.width/, 'x must be a fraction of the page width');
  assert.match(EDITOR_CODE, /LAYOUT\.page\.height/, 'y must be a fraction of the page height');
});

test('the identifying information is the system\'s to fill, not the Social Worker\'s', () => {
  // The report is seeded from the resident's records when it is opened, and the
  // server is the only thing that writes that block. Nothing on this form edits
  // it, so there is no draft state for it and no header write from here.
  assert.equal(EDITOR_CODE.indexOf('patchIdentifying'), -1, 'identifying fields must not be editable');
  assert.equal(EDITOR_CODE.indexOf('identifyingDrafts'), -1, 'there must be no identifying draft state');
  assert.equal(EDITOR_CODE.indexOf('IDENTIFYING_LABELS'), -1, 'the block must not be rendered as fields');
  // What it does instead: the template carries it, printed and already filled in.
  assert.match(EDITOR_CODE, /already filled in from their records/, 'the form must say the details are pre-filled');
});

test('finalizing is one action with one signature', () => {
  assert.match(EDITOR_CODE, /Finalize &(?:amp;)? ?publish PDF/, 'the finalize control must exist');
  assert.match(EDITOR_CODE, /SignaturePadModal/, 'the signature must be captured on a pad');
  assert.match(EDITOR_CODE, /send\('\/signatures'/, 'the signature must be persisted to the report');
  assert.match(EDITOR_CODE, /send\('\/finalize'/, 'finalize must call the finalize endpoint');
});

test('the "Prepared by" name comes from the account, not from a blank field', () => {
  // The name used to render as an empty input, so whatever the last person typed
  // stayed on the report and the PDF could print a blank rule. It is now the
  // signed-in account's configured name — shown, and printed on the form.
  assert.match(EDITOR_CODE, /useAuth\(\)/, 'the editor must read the signed-in account');
  assert.match(EDITOR_CODE, /user\?\.fullName \|\| user\?\.username/, 'the default must be the display name, falling back to the username');
  assert.match(EDITOR_CODE, /report\??\.preparedByName \|\| accountName/, 'the name must fall back to the account when the report has none');
});

test('an aspect is edited only by a caller the server would allow', () => {
  // The UI keys off the server's `canEdit`, not off a role list of its own — the
  // equivalent client-side rule would be a second copy of the permission model.
  assert.match(EDITOR_CODE, /Boolean\(section\.canEdit\)/, 'editability must come from the server flag');
});

test('the open-a-report control is hidden from a caller the server would refuse', () => {
  // Opening a period is Social-Worker-only. A caller who could not open one was
  // shown the button anyway and got a 403, so it now follows the `canOpenReport`
  // the list endpoint ships.
  assert.match(
    EDITOR_CODE,
    /canOpenReport &&/,
    'the dialog must be gated on the server capability'
  );
  assert.match(
    EDITOR_CODE,
    /result\.canOpenReport !== false/,
    'the flag must be read from the list response, defaulting to allowed'
  );
  // The caller who cannot open one is told who can, instead of being left with a
  // button that fails.
  assert.match(EDITOR_CODE, /A Social Worker or Center Head opens each period/);
});

test('the list endpoint ships the capability alongside the rows', () => {
  // Without it, a caller whose list is empty has no row to carry the flag.
  const list = controllerBody('async function list(', 'async function listPeriods(');
  assert.match(list, /canOpenReport: reviewer/);
});

// ── THE FILL-IN TEMPLATE ────────────────────────────────────────────────────
//
// The popup form renders this PDF and overlays its inputs on the blank aspect
// rows. Two things can go wrong silently: the coordinates the client uses can
// drift from the ones the writer draws with, and the blank rows can run off the
// page. Both are checked here rather than discovered in the browser.

const TEMPLATE_LAYOUT = JSON.parse(read('frontend/src/shared/quarterlyReportTemplate.json'));

test('the geometry the client positions inputs from is the one the writer draws with', () => {
  const derived = pdf.TEMPLATE_GEOMETRY;

  assert.deepEqual(derived.page, TEMPLATE_LAYOUT.page, 'the page geometry must match');
  assert.equal(derived.table.rowHeight, TEMPLATE_LAYOUT.table.rowHeight, 'the row height must match');
  assert.equal(derived.table.rowsPerPage, TEMPLATE_LAYOUT.table.rowsPerPage, 'the rows per page must match');
  assert.equal(derived.table.cellPad, TEMPLATE_LAYOUT.table.cellPad, 'the cell padding must match');
  assert.deepEqual(derived.table.tableTops, TEMPLATE_LAYOUT.table.tableTops, 'the row tops must match');
  assert.deepEqual(derived.narrative, TEMPLATE_LAYOUT.narrative, 'the narrative box must match');
  assert.deepEqual(derived.signature, TEMPLATE_LAYOUT.signature, 'the signature band must match');

  // Only the three writable columns are listed: the first column is the aspect's
  // printed name, not something anybody types into.
  for (const column of TEMPLATE_LAYOUT.table.columns) {
    assert.deepEqual(
      derived.table.columns[column.key],
      { x: column.x, width: column.width },
      `the "${column.key}" column must match`
    );
  }
});

test('the six aspects fit the template without running off the page', () => {
  const { rowHeight, rowsPerPage, tableTops } = TEMPLATE_LAYOUT.table;
  const pages = Math.ceil(pdf.ASPECTS.length / rowsPerPage);

  assert.equal(tableTops.length, pages, 'every page of rows must have a table top recorded');
  for (let index = 0; index < pages; index += 1) {
    const rows = Math.min(rowsPerPage, pdf.ASPECTS.length - index * rowsPerPage);
    const lastBottom = tableTops[index] - rows * rowHeight;
    assert.ok(
      lastBottom > TEMPLATE_LAYOUT.page.marginBottom,
      `page ${index + 1}'s last row must end above the bottom margin`
    );
  }
});

test('the template prints the resident details and leaves the aspect cells blank', async () => {
  const buffer = await pdf.buildQuarterlyReportTemplatePdf({
    id: 'QPR1',
    residentId: 'CH001',
    periodStart: '2024-04-01',
    periodEnd: '2024-06-30',
    preparedByName: 'Social Worker',
    identifyingInformation: {
      childName: 'Juan Dela Cruz',
      sex: 'Male',
      religion: 'Roman Catholic',
      guardian: 'Maria Dela Cruz',
    },
  }, 'Juan Dela Cruz');

  // Each wrapped line comes back as its own draw, so the text is flattened before
  // matching: "Economic Productivity" does not fit its 92pt column on one line.
  const text = pdfDrawnText(buffer).join('\n').replace(/\s+/g, ' ');

  // Page 1 is the part the system fills in, so it arrives printed.
  assert.match(text, /IDENTIFYING INFORMATION/);
  assert.match(text, /Juan Dela Cruz/);
  assert.match(text, /Roman Catholic/);
  assert.match(text, /Maria Dela Cruz/);
  assert.match(text, /\(APRIL-JUNE 2024\)/);

  // Every aspect is named, so each blank row says what is to be written on it.
  for (const aspect of pdf.ASPECTS) {
    assert.ok(text.includes(aspect.label), `the template must name the ${aspect.label} aspect`);
  }
  assert.match(text, /OBSERVATION \/ PROGRESS/);
  assert.match(text, /OBSERVATION \/ PROGRESS \(continued\)/);

  // The signature slot carries the preparer's name; the drawing is overlaid.
  assert.match(text, /SIGNATURES/);
  assert.match(text, /Prepared by:/);
  assert.match(text, /Social Worker/);
});

test('a blank template row draws no placeholder in its cells', () => {
  // `drawAspectRow` marks a cell it has nothing to say about with an em dash, and
  // the identifying block does the same for a field the records cannot fill. The
  // template's rows must not: those dashes would sit behind the inputs, and a
  // blank form should read as blank rather than as "no data".
  //
  // Checked at the source because the dash is one character among hundreds in a
  // rendered page, and the identifying block legitimately contains others.
  const source = read('backend/src/utils/quarterlyReportPdf.js');
  const start = source.indexOf('function drawTemplateAspectRow(');
  assert.notEqual(start, -1, 'the template row drawer must exist');

  const templateRow = source.slice(start, source.indexOf('The one sign-off block', start));
  assert.match(templateRow, /aspect\.label/, 'the template row must still name the aspect');
  assert.equal(templateRow.includes('\\u2014'), false, 'the template row must draw no placeholder dash');
});

// ── "View Anecdotal Reports" in the QPR editor ──────────────────────────────
//
// The reference panel the specification asks for, modelled on the TRI form's
// "Show Violations" control. Three properties have to hold together, and each
// one is easy to break while the build stays green:
//
//   1. it is offered to the Social Worker and the Center Head only
//   2. it opens a modal that filters by Month and Year and shows the four
//      columns the specification names
//   3. it is REFERENCE ONLY — nothing is copied into the report

/**
 * The Anecdotal Reports reference, sliced out of the QPR editor: the section
 * constants, the preview helper and the dialog, up to the report editor itself.
 */
function anecdotalReferenceSource() {
  const source = read('frontend/src/app/components/QuarterlyProgressReport.tsx');
  const start = source.indexOf('const ANECDOTAL_SECTIONS');
  assert.ok(start > 0, 'the Anecdotal Reports reference is gone');
  const end = source.indexOf('\n/**\n * The report editor:', start);
  assert.ok(end > start, 'could not find the end of the reference panel');
  return { source, component: source.slice(start, end) };
}

/** The section keys of the official Anecdotal Report form, in form order. */
function anecdotalFormSectionKeys() {
  const form = read('frontend/src/app/components/AnecdotalReports.tsx');
  const start = form.indexOf('const textFields = [');
  const end = form.indexOf('] as const;', start);
  assert.ok(start > 0 && end > start, 'the Anecdotal Report form no longer declares its sections');
  return [...form.slice(start, end).matchAll(/key:\s*'(\w+)'/g)].map((match) => match[1]);
}

test('the QPR offers the Anecdotal Reports reference to the two roles the specification names', () => {
  const source = read('frontend/src/app/components/QuarterlyProgressReport.tsx');

  assert.match(source, /data-view-anecdotal-reports/, 'the View Anecdotal Reports button is gone');
  assert.match(
    source,
    /ANECDOTAL_REFERENCE_ROLES\s*=\s*new Set\(\['socialworker', 'centerhead', 'admin'\]\)/,
    'the button must be offered to the Social Worker and the Center Head',
  );
  // Hidden, not shown-then-failing: the API refuses every other role outright.
  assert.match(
    source,
    /ANECDOTAL_REFERENCE_ROLES\.has\(String\(user\?\.role \|\| ''\)\.toLowerCase\(\)\)/,
    'the button is no longer gated on the role list',
  );
});

test('the reference opens a modal that filters by month and year', () => {
  const { component } = anecdotalReferenceSource();

  // A modal, which is what the specification asks for — not the TRI's inline panel.
  assert.match(component, /<Dialog open onOpenChange=/, 'the reference must open a dialog');
  // Month and Year, the two filters the specification names.
  assert.match(component, /data-anecdotal-month/, 'the month filter is gone');
  assert.match(component, /data-anecdotal-year/, 'the year filter is gone');
  assert.match(component, /ANECDOTAL_MONTH_NAMES/, 'the month names are gone');
  // And the query carries both, so the filter is the server's, not a client slice.
  assert.match(component, /params\.set\('year', year\)/, 'the year must be sent to the API');
  assert.match(component, /params\.set\('month', month\)/, 'the month must be sent to the API');
  assert.match(component, /residentId/, 'the reference must be scoped to the report resident');
});

test('the reference shows the four columns the specification names', () => {
  const { source, component } = anecdotalReferenceSource();

  assert.match(component, /<strong>Date:<\/strong>/, 'the Date column is gone');
  assert.match(component, /<strong>Submitted by:<\/strong>/, 'the Submitted By column is gone');
  // "Report Title (if available)" — derived from the report's own month and year.
  assert.match(component, /Anecdotal Report — \$\{monthName\} \$\{recordYear\}/, 'the report title is gone');
  // "Preview/Summary". The helper sits above the dialog, so it is asserted on the
  // whole file; the call site is inside the sliced component.
  assert.match(component, /anecdotalPreview\(record\)/, 'the preview is gone');
  assert.match(source, /function anecdotalPreview/, 'the preview helper is gone');
});

test('the full report opens inside the QPR rather than navigating away', () => {
  const { component } = anecdotalReferenceSource();

  assert.match(component, /data-anecdotal-open=/, 'there is no way to open the full report');
  assert.match(component, /data-anecdotal-full-report=/, 'the full report view is gone');
  // Every section of the official form is rendered, so "the full report" is
  // actually the whole report and not just the preview.
  assert.match(component, /ANECDOTAL_SECTIONS\.map/, 'the full report does not render every section');
  // Staying on the QPR page is the requirement: the panel must not navigate.
  assert.doesNotMatch(component, /navigate\(/, 'the reference must not navigate away from the QPR');
  assert.doesNotMatch(component, /window\.location/, 'the reference must not leave the page');
});

test('the reference section keys match the official form', () => {
  // The panel renders the resident's report; the form writes it. If the two key
  // lists drift, the panel silently shows ten empty sections.
  const { component } = anecdotalReferenceSource();
  const panelKeys = [...component.matchAll(/\{\s*key:\s*'(\w+)',\s*label:/g)].map((match) => match[1]);
  assert.deepEqual(panelKeys, anecdotalFormSectionKeys());
});

test('the reference never copies content into the report', () => {
  // "Reference only. Do not auto-copy anecdotal report content into the QPR; do
  // not auto-generate observations from anecdotal reports." The panel has no
  // route into the report's state, and no action that would write one.
  const { component } = anecdotalReferenceSource();

  for (const forbidden of ['setDrafts', 'onChange', 'saveForm', 'send(', 'drafts']) {
    assert.ok(
      !component.includes(forbidden),
      `the reference panel reaches into the report through ${forbidden}`,
    );
  }
  // The only two actions it offers are reading a report and downloading it.
  assert.match(component, /downloadAnecdotalPdf\(selected\)/, 'the PDF action is gone');
  assert.doesNotMatch(component, /Insert|Use this|Apply to report/i, 'the panel offers to write into the report');
});

// ── THE CLOSING NARRATIVE ───────────────────────────────────────────────────
//
// The report's last section, added after the table: one free-text account of the
// period, stored on the report rather than on any aspect, printed between the
// table and the signature.
//
// Three things have to hold, and each can break while the build stays green: the
// box has to be where the overlay puts the textarea, the finished report has to
// print what was typed, and a database that predates the column has to be able
// to save one.

test('the template prints a blank narrative box above the signature block', async () => {
  const buffer = await pdf.buildQuarterlyReportTemplatePdf({
    id: 'QPR1',
    residentId: 'CH001',
    periodStart: '2024-04-01',
    periodEnd: '2024-06-30',
    preparedByName: 'Social Worker',
    identifyingInformation: { childName: 'Juan Dela Cruz' },
  }, 'Juan Dela Cruz');

  const text = pdfDrawnText(buffer).join('\n');

  assert.ok(text.includes('NARRATIVE REPORT'), 'the template must label the narrative box');
  // Order matters: the narrative is the last thing before the signature, so a
  // box drawn after SIGNATURES would print under the preparer's name.
  assert.ok(
    text.indexOf('NARRATIVE REPORT') < text.indexOf('SIGNATURES'),
    'the narrative box must come before the signature block'
  );
  // The last aspect row must still be above it, or the box replaced a row.
  assert.ok(
    text.indexOf('Economic') < text.indexOf('NARRATIVE REPORT'),
    'the narrative must follow the aspect table'
  );
});

test('the finished report prints the narrative between the table and the signature', async () => {
  const buffer = await pdf.buildQuarterlyReportPdf({
    id: 'QPR1', residentId: 'CH001',
    periodStart: '2024-04-01', periodEnd: '2024-06-30',
    narrative: 'Juan settled into the house routine.\n\nHe asked to rejoin the tutorial group.',
    identifyingInformation: { childName: 'Juan Dela Cruz' },
  }, pdf.ASPECTS.map((aspect, index) => ({
    aspectKey: aspect.key, aspectLabel: aspect.label, sortOrder: index,
    presentLevel: 'Moderate',
    observations: `- OBS-${aspect.key}`,
    interventions: `- INT-${aspect.key}`,
  })), 'Juan Dela Cruz');

  const text = pdfDrawnText(buffer).join('\n');

  assert.ok(text.includes('NARRATIVE REPORT'), 'the section must be labelled');
  assert.ok(text.includes('Juan settled into the house routine.'), 'the narrative must print');
  assert.ok(
    text.includes('He asked to rejoin the tutorial group.'),
    'both paragraphs must print, not just the first'
  );
  assert.ok(
    text.indexOf('INT-economicProductivity') < text.indexOf('NARRATIVE REPORT'),
    'the narrative must follow the last aspect row'
  );
  assert.ok(
    text.indexOf('NARRATIVE REPORT') < text.indexOf('SIGNATURES'),
    'the narrative must precede the signature'
  );
});

test('a report with no narrative prints no narrative section at all', async () => {
  // An empty ruled box on a finalized document reads as a field somebody forgot
  // to fill in, not as an optional one. The section prints only when it has
  // something to say.
  for (const narrative of [null, undefined, '', '   \n  ']) {
    const buffer = await pdf.buildQuarterlyReportPdf({
      id: 'QPR1', residentId: 'CH001',
      periodStart: '2024-04-01', periodEnd: '2024-06-30',
      narrative,
      identifyingInformation: { childName: 'Juan Dela Cruz' },
    }, [], 'Juan Dela Cruz');

    const text = pdfDrawnText(buffer).join('\n');
    assert.equal(
      text.includes('NARRATIVE REPORT'),
      false,
      `an empty narrative (${JSON.stringify(narrative)}) must print no section`
    );
    // The rest of the document is unaffected.
    assert.ok(text.includes('SIGNATURES'), 'the signature block must still print');
  }
});

test('the narrative box cannot overlap the signature band, and both stay on the page', () => {
  const { narrative, signature, page, table } = pdf.TEMPLATE_GEOMETRY;

  // pdf-lib measures y upward from the bottom, so "above" is a larger y. The
  // signature band is derived from the narrative's bottom edge for exactly this
  // reason: deriving it from the last row instead would print it over the box.
  const narrativeBottom = narrative.top - narrative.height;
  assert.ok(
    narrativeBottom > signature.top,
    `the narrative box (bottom ${narrativeBottom}) must clear the signature band (top ${signature.top})`
  );

  // The heading needs a band of its own between the last aspect row and the box.
  // Without it the title's baseline lands on the row's bottom border and the
  // glyphs print up into the row — which is what the block did when it was first
  // added, and what `drawNarrativeSection` now reserves room for.
  const lastRowBottom = table.tableTops[1] - (pdf.ASPECTS.length - table.rowsPerPage) * table.rowHeight;
  assert.ok(
    narrative.top <= lastRowBottom - pdf.SECTION_HEADING_HEIGHT * 2,
    `the narrative box top (${narrative.top}) must leave the heading a band below the last row (${lastRowBottom})`
  );

  // The band's own lowest drawn element is the "Signature over Printed Name"
  // label, 24pt under the rule at the bottom of the signature image area.
  const ruleY = signature.top - 2 - 34;
  assert.ok(
    ruleY - 24 > page.marginBottom,
    'the printed-name label must sit above the bottom margin, not in the footer'
  );
});

test('the narrative keeps the blank line between paragraphs', () => {
  // A stand-in font, so the test is about the split and not about Helvetica.
  const font = { widthOfTextAtSize: (value) => value.length * 5 };

  assert.deepEqual(
    pdf.wrapNarrative('One.\n\nTwo.', font, 9, 1000),
    ['One.', '', 'Two.'],
    'the blank line between paragraphs must survive'
  );
  // `wrapToWidth` drops it, which is right for a bullet list and wrong here.
  assert.deepEqual(pdf.wrapToWidth('One.\n\nTwo.', font, 9, 1000), ['One.', 'Two.']);

  // A trailing newline must not leave an unexplained gap at the foot of the box.
  assert.deepEqual(pdf.wrapNarrative('One.\n', font, 9, 1000), ['One.']);
  // Nothing to say is no lines, not one empty one.
  for (const empty of ['', null, undefined, '  \n ']) {
    assert.deepEqual(pdf.wrapNarrative(empty, font, 9, 1000), [], `"${empty}" must produce no lines`);
  }
});

test('a paragraph break in the narrative is drawn as a gap, not run together', () => {
  // The break is a vertical gap, and `pdfDrawnText` flattens the page into a
  // list of strings with no positions — so a `wrapToWidth` that silently dropped
  // the blank line would still pass every assertion above. A stand-in page
  // records where each line lands instead.
  const drawn = [];
  const page = {
    drawRectangle: () => {},
    drawText: (line, options) => drawn.push({ text: line, y: options.y }),
  };
  const fonts = {
    regular: { widthOfTextAtSize: (value, size) => value.length * size * 0.5 },
    bold: { widthOfTextAtSize: (value, size) => value.length * size * 0.5 },
  };

  pdf.drawNarrativeSection(page, 400, 'One.\n\nTwo.', fonts, 100);

  const first = drawn.find((entry) => entry.text === 'One.');
  const second = drawn.find((entry) => entry.text === 'Two.');
  assert.ok(first, `the first paragraph must be drawn, got ${JSON.stringify(drawn)}`);
  assert.ok(second, `the second paragraph must be drawn, got ${JSON.stringify(drawn)}`);
  assert.equal(
    Math.round(first.y - second.y),
    Math.round(pdf.LINE_STEP * 2),
    'the second paragraph must start two line steps down — one line plus the blank one'
  );
  // And the blank line itself must not be drawn: pdf-lib has no use for an
  // empty string, and a drawn one would be an invisible no-op either way.
  assert.equal(drawn.filter((entry) => entry.text === '').length, 0, 'the blank line must not be drawn');

  // The heading gets a band of its own below the line the block starts at.
  // Drawing it *at* that line — which is what the block did first — put the
  // baseline on the border of the row above, so the title printed along it.
  const heading = drawn.find((entry) => entry.text === 'NARRATIVE REPORT');
  assert.ok(heading, 'the section must be labelled');
  assert.ok(
    heading.y <= 400 - pdf.SECTION_HEADING_HEIGHT,
    `the heading (${heading.y}) must sit a full band below the block top (400)`
  );
  // And the box starts below the heading, not on it.
  assert.ok(first.y < heading.y, 'the box must start below its own heading');
});

test('a report table that predates the narrative column is given it', async () => {
  // `CREATE TABLE IF NOT EXISTS` is a no-op on an already-provisioned database,
  // so the column needs its own migration. Without it the first save in
  // production fails with "Unknown column 'narrative' in 'field list'" — a 500
  // on a button that worked locally.
  //
  // Driven through a controller loaded against a stub pool: the HTTP harness
  // above purges `src` from `require.cache`, so the pool a test can reach is not
  // the one the cached controller holds.
  const runWithColumns = async (columns) => {
    const issued = [];
    const stub = {
      async query(sql) {
        const text = String(sql).replace(/\s+/g, ' ').trim();
        issued.push(text);
        if (/INFORMATION_SCHEMA\.COLUMNS/i.test(text)) {
          return [columns.map((column) => ({ COLUMN_NAME: column })), []];
        }
        return [{}, []];
      },
    };
    const fresh = loadController(stub);
    return { added: await fresh.ensureNarrativeColumn(), issued };
  };

  const older = await runWithColumns(['id', 'residentId', 'identifyingInformation']);
  assert.equal(older.added, true, 'the column must be added to a table that lacks it');
  assert.ok(
    older.issued.some((sql) => /^ALTER TABLE quarterlyProgressReports ADD COLUMN narrative TEXT NULL/i.test(sql)),
    `the migration must issue the ALTER, issued: ${JSON.stringify(older.issued)}`
  );

  const current = await runWithColumns(['id', 'residentId', 'identifyingInformation', 'narrative']);
  assert.equal(current.added, false, 'an existing column must not be added a second time');
  assert.equal(current.issued.length, 1, 'nothing beyond the probe may be issued');

  // An empty column list means the TABLE is missing. The ALTER must be skipped:
  // a missing table here is `CREATE TABLE`'s problem, and altering a table that
  // does not exist would throw ER_NO_SUCH_TABLE and take the request down.
  const missing = await runWithColumns([]);
  assert.equal(missing.added, false, 'a missing table must not be altered');
  assert.equal(missing.issued.length, 1, 'nothing beyond the probe may be issued');
});

test('the editor overlays a narrative field and saves it with the form', () => {  // Positioned from the shared layout like the cells and the signature, so it
  // lands on the box the template printed rather than beside it. Each edge is
  // pinned separately: matching `LAYOUT.narrative` alone would still pass if one
  // edge were taken from the signature band.
  for (const edge of ['x', 'top', 'width', 'height']) {
    assert.match(
      EDITOR_CODE,
      new RegExp(`LAYOUT\\.narrative\\.${edge}`),
      `the narrative box's ${edge} must come from the shared layout`
    );
  }
  assert.match(EDITOR_CODE, /function narrativeBox\(/, 'the overlay box must be derived, not hard-coded');
  assert.match(EDITOR_CODE, /NarrativeCell/, 'the narrative must be an overlaid field');
  assert.match(EDITOR_CODE, /aria-label="Narrative report"/, 'the field must be labelled');
  // A blank form must not look like a filled one.
  assert.match(EDITOR_CODE, /placeholder=\{disabled \? '' :/, 'a read-only form must show no placeholder');

  // Report-level, so it is a report-level write — and only when it changed, or
  // saving six aspects would bump the report's updatedAt for nothing. Pinned at
  // the call site: a declaration of `narrativeDirty` that nothing branches on
  // would satisfy a bare presence check.
  assert.match(EDITOR_CODE, /if \(narrativeDirty\) \{/, 'the narrative write must be gated on the change');
  assert.match(
    EDITOR_CODE,
    /body: JSON\.stringify\(\{ narrative: narrativeDraft \?\? '' \}\)/,
    'the narrative must be sent to the report endpoint'
  );
  assert.match(EDITOR_CODE, /method: 'PUT'/, 'the report header write must be a PUT');
  // It is one form with one save: the narrative must not get its own button.
  assert.doesNotMatch(EDITOR_CODE, /Save narrative/i, 'the narrative must save with the form');
});

test('the narrative is written to the report, and only ever as text', async () => {
  // The narrative is report-level, so it travels through the report's own PUT
  // rather than through an aspect. Driven through a controller loaded against a
  // stub pool, so the assertions are on the real status codes and the real bound
  // parameters rather than on the source text.
  const reports = [{
    id: 'QPR1', residentId: 'CH001',
    periodStart: '2024-04-01', periodEnd: '2024-06-30',
    periodLabel: 'Q2 2024', identifyingInformation: {},
    narrative: 'Old text', status: 'Draft',
  }];
  const writes = [];
  const stub = {
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (/^SELECT COLUMN_NAME FROM INFORMATION_SCHEMA/i.test(text)) {
        // The column exists: this is not the migration under test.
        return [[{ COLUMN_NAME: 'narrative' }], []];
      }
      if (/^SELECT \* FROM quarterlyProgressReports WHERE id = \?/i.test(text)) {
        return [reports.filter((row) => row.id === params[0]).map((row) => ({ ...row })), []];
      }
      if (/^UPDATE quarterlyProgressReports SET/i.test(text)) {
        writes.push({ sql: text, params });
        return [{}, []];
      }
      if (/^SELECT \* FROM quarterlyProgressReportSections/i.test(text)) return [[], []];
      return [{}, []];
    },
  };
  const fresh = loadController(stub);

  /** Calls the endpoint and reports the captured error, if any. */
  const put = async (body, { role = 'socialworker', status = 'Draft' } = {}) => {
    reports[0].status = status;
    let error = null;
    const before = writes.length;
    await fresh.update(
      { params: { id: 'QPR1' }, body, user: { id: 'U1', username: 'sw', role } },
      { json: () => {} },
      (err) => { error = err; }
    );
    return { error, write: writes[before], writes: writes.length - before };
  };

  const saved = await put({ narrative: 'Juan settled in well.' });
  assert.equal(saved.error, null, 'a reviewer must be able to save a narrative');
  // Bound parameters are [periodLabel, identifyingInformation, narrative, actor, id].
  assert.equal(saved.write.params[2], 'Juan settled in well.', 'the narrative must be the value written');

  // Omitting the field leaves the stored narrative alone: the aspect save path
  // does not touch it, and neither must a header write that did not mention it.
  const untouched = await put({ periodLabel: 'Q2 2024' });
  assert.equal(untouched.write.params[2], 'Old text', 'an omitted narrative must keep its value');

  // Clearing it is a real edit, and stored as NULL rather than as an empty
  // string, so "no narrative" has one representation in the database.
  const cleared = await put({ narrative: '' });
  assert.equal(cleared.write.params[2], null, 'clearing the narrative must store NULL');

  // A non-string is the caller's mistake, and must read as one: the controller
  // raises ApiError(400) rather than letting a bare Error out of the service,
  // which `errorHandler` would report as a 500 with a masked message.
  const wrongType = await put({ narrative: { text: 'nope' } });
  assert.equal(wrongType.error?.statusCode, 400, `expected 400, got ${wrongType.error?.statusCode}`);
  assert.match(String(wrongType.error?.message), /narrative/i, 'the message must name the field');
  assert.equal(wrongType.writes, 0, 'nothing may be written for a rejected body');

  const notReviewer = await put({ narrative: 'x' }, { role: 'nurse' });
  assert.equal(notReviewer.error?.statusCode, 403, 'only a reviewer may write the report');
  assert.equal(notReviewer.writes, 0, 'nothing may be written by a non-reviewer');

  const finalized = await put({ narrative: 'x' }, { status: 'Finalized' });
  assert.equal(finalized.error?.statusCode, 409, 'a finalized report refuses every write');
  assert.equal(finalized.writes, 0, 'nothing may be written to a finalized report');
});
