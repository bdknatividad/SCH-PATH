/**
 * Two rules that live on both sides of the wire.
 *
 * 21. Force Advance in the Social Worker's Phase Timeline. The override existed
 *     but was gated to the Center Head on both the endpoint and the button, so
 *     the Social Worker — whose case it is — could not use it. Widening it needs
 *     both halves: a button the API refuses is worse than no button, because the
 *     reviewer only finds out after confirming.
 *
 * 23. The printed names on Form 08. Two of the four sign-off lines were left for
 *     the filer to type even though the same two people sign every incident
 *     report, so they could differ — or be left blank — from one report to the
 *     next. "Endorsed to" and "Noted by" are now pre-printed, and the modal
 *     mirrors the PDF builder's constants so the preview cannot disagree with
 *     the paper that comes out.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const PHASE_CONTROLLER = read('backend/src/controllers/phaseController.js');
const PHASE_UI = read('frontend/src/app/components/PhaseProgress.tsx');
const INCIDENT_CONTROLLER = read('backend/src/controllers/incidentReportController.js');
const INCIDENT_MODAL = read('frontend/src/app/components/IncidentReportModal.tsx');

// ── 21. The override is a role rule, and both halves read it ────────────────

test('the Social Worker and the Center Head may force a phase advance', () => {
  const { PHASE_OVERRIDE_ROLES } = require('../src/controllers/phaseController');

  assert.ok(PHASE_OVERRIDE_ROLES.has('centerhead'), 'the Center Head lost the override it has always held');
  assert.ok(PHASE_OVERRIDE_ROLES.has('socialworker'), 'the Social Worker cannot force-advance their own case');
  // Roles with no business overriding a phase's requirements.
  for (const role of ['psychologist', 'nurse', 'educator', 'houseparent']) {
    assert.ok(!PHASE_OVERRIDE_ROLES.has(role), `${role} must not be able to force a phase advance`);
  }
});

test('the endpoint decides the override from the role set, not a bare string', () => {
  assert.match(
    PHASE_CONTROLLER,
    /const canForceAdvance = Boolean\(force\) && PHASE_OVERRIDE_ROLES\.has\(normalizedRole\)/,
    'the endpoint no longer consults the shared role set, so it can drift from the interface',
  );
});

test('the SPA offers Force Advance to exactly the roles the API accepts', () => {
  // The button, the payload and the notice all read one predicate; the payload
  // in particular must not send `force` for a role the API will refuse.
  assert.match(
    PHASE_UI,
    /const canForceAdvance = isCenterHead \|\| isSocialWorker;/,
    'the SPA does not offer Force Advance to the Social Worker',
  );
  assert.match(
    PHASE_UI,
    /force: canForceAdvance && !validationResult\?\.canAdvance/,
    'the payload does not follow the same predicate as the button',
  );
  assert.match(
    PHASE_UI,
    /\(validationResult\?\.canAdvance \|\| canForceAdvance\) && !showAdvanceConfirm/,
    'the Force Advance button is still gated on the Center Head alone',
  );
  // The notice that explains the override has to appear for whoever holds it.
  assert.doesNotMatch(
    PHASE_UI,
    /\{isCenterHead && \(\s*<div className="p-2 bg-yellow-50/,
    'the override notice is still shown only to the Center Head',
  );
});

// ── 23. Form 08's pre-printed names ─────────────────────────────────────────

test('Form 08 pre-prints the endorsement and the noted-by name', () => {
  assert.match(
    INCIDENT_CONTROLLER,
    /const FORM08_ENDORSED_TO_NAME = "Ma'am Joyce";/,
    'the endorsement line is not pre-printed',
  );
  assert.match(
    INCIDENT_CONTROLLER,
    /const FORM08_NOTED_BY_NAME = 'Sir Francis';/,
    'the noted-by line does not carry the expected name',
  );
  // The typed value must no longer reach the paper, or the pre-printed name
  // would be overwritten by whatever was typed.
  assert.match(
    INCIDENT_CONTROLLER,
    /drawTextTop\(FORM08_ENDORSED_TO_NAME, 388, 687\.6/,
    'the endorsement line still draws the typed value',
  );
  assert.doesNotMatch(
    INCIDENT_CONTROLLER,
    /drawTextTop\(endorsedTo, 388, 687\.6/,
    'the endorsement line draws the typed value, so the pre-printed name is pointless',
  );
});

test('the record keeps the printed name without discarding what it held', () => {
  // `endorsedTo || FORM08_ENDORSED_TO_NAME` defaults new reports to the printed
  // name and leaves an existing value alone, so nothing is overwritten.
  const defaults = INCIDENT_CONTROLLER.match(/endorsedTo \|\| FORM08_ENDORSED_TO_NAME/g) || [];
  assert.equal(
    defaults.length,
    2,
    `both write paths (create and resubmit) must default endorsedTo; found ${defaults.length}`,
  );
});

test('the modal shows the same names the PDF stamps', () => {
  // A preview that disagrees with the output is how a wrong name gets signed.
  const pairs = [
    ["Ma'am Joyce", 'FIXED_ENDORSED_TO_NAME'],
    ['Francis C. Patricio, RSW', 'FIXED_CHECKED_BY_NAME'],
    ['Sir Francis', 'FIXED_NOTED_BY_NAME'],
  ];
  for (const [name, constant] of pairs) {
    const declaration = new RegExp(`const ${constant} = ["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'];`);
    assert.match(INCIDENT_MODAL, declaration, `${constant} is not declared as ${name} in the modal`);
    assert.match(INCIDENT_MODAL, new RegExp(`\\{${constant}\\}`), `${constant} is declared but never rendered`);
  }
  // And the backend must declare the same three strings, or the two halves of
  // the same form would print different names.
  for (const [name] of pairs) {
    assert.ok(
      INCIDENT_CONTROLLER.includes(`'${name}'`) || INCIDENT_CONTROLLER.includes(`"${name}"`),
      `the PDF builder does not stamp ${name}, which the modal shows`,
    );
  }
});

test('the endorsement line is no longer typed', () => {
  assert.doesNotMatch(
    INCIDENT_MODAL,
    /aria-label="Endorsed to" value=\{form\.endorsedTo\}/,
    'the endorsement line is still an editable field, so the typed value cannot match the printed name',
  );
  assert.match(
    INCIDENT_MODAL,
    /aria-label="Endorsed to printed name"/,
    'the endorsement line is neither typed nor shown',
  );
});

// ── What actually lands on the page ─────────────────────────────────────────

const { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } = require('pdf-lib');

/**
 * Every text run drawn on the page, with the `Tm` position it was drawn at.
 *
 * `pdf-lib` Flate-compresses its content streams, so a byte-level search for the
 * names finds nothing even when they are on the page. This walks the streams
 * through pdf-lib's own parser instead — same helper as
 * `tests/tri-document-publish.test.js`.
 */
async function drawnText(buffer) {
  const doc = await PDFDocument.load(buffer);
  const runs = [];
  doc.getPages().forEach((page, pageIndex) => {
    const contents = page.node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    let source = '';
    for (const ref of refs) {
      const stream = doc.context.lookup(ref);
      let bytes = null;
      if (stream instanceof PDFRawStream) bytes = decodePDFRawStream(stream).decode();
      else if (stream && typeof stream.getContents === 'function') bytes = stream.getContents();
      if (bytes) source += Buffer.from(bytes).toString('latin1');
    }
    const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+Tm\s*(?:<([0-9A-Fa-f]*)>|\(((?:[^()\\]|\\.)*)\))\s*Tj/g;
    let m;
    while ((m = re.exec(source))) {
      runs.push({
        page: pageIndex,
        x: Number(m[1]),
        y: Number(m[2]),
        text: m[3] !== undefined
          ? Buffer.from(m[3], 'hex').toString('latin1')
          : m[4].replace(/\\(.)/g, '$1'),
      });
    }
  });
  return runs;
}

const SENTINEL = 'TYPED-VALUE-MUST-NOT-PRINT';

async function form08Runs(overrides = {}) {
  const { buildForm08Pdf } = require('../src/controllers/incidentReportController');
  const buffer = await buildForm08Pdf({
    childName: 'Test Resident',
    incidentDateTime: '2026-09-24 10:30',
    reportTypes: ['Quarrelling'],
    othersSpecify: '',
    summary: 'Summary of the incident.',
    actionTaken: 'Action taken.',
    result: 'Result.',
    reportedBy: 'HP 1',
    endorsedTo: SENTINEL,
    checkedBy: null,
    notedBy: null,
    reportedBySignature: null,
    endorsedToSignature: null,
    checkedBySignature: null,
    notedBySignature: null,
    ...overrides,
  });
  return drawnText(buffer);
}

test('the printed names are on the page, and the typed endorsement is not', async () => {
  const runs = await form08Runs();
  const texts = runs.map((run) => run.text);

  for (const name of ["Ma'am Joyce", 'Francis C. Patricio, RSW', 'Sir Francis']) {
    assert.ok(
      texts.some((text) => text.includes(name)),
      `${name} is not drawn on Form 08, so the form prints without its signatory`,
    );
  }
  assert.ok(
    !texts.some((text) => text.includes(SENTINEL)),
    'the typed endorsement value reached the page — the pre-printed name can be overwritten',
  );
  // "Reported by" is the one line that is still typed.
  assert.ok(texts.includes('HP 1'), 'the typed Reported-by name is missing from the form');
});

test('the endorsement name sits on the top row and the noted-by name on the bottom', async () => {
  // Placement, not just presence: both names exist somewhere on the form, so
  // only the coordinates show that they landed on the lines the requirement
  // names. `drawTextTop` takes a distance from the *top* of the page and converts
  // it, so PDF y grows upwards and a larger `top` ends up at a *smaller* y —
  // hence the noted-by line, which is lower on the page, has the smaller y.
  const runs = await form08Runs();
  const at = (needle) => runs.find((run) => run.text.includes(needle));
  const endorsed = at("Ma'am Joyce");
  const noted = at('Sir Francis');
  const checked = at('Francis C. Patricio');

  assert.ok(endorsed, 'the endorsement name was not drawn');
  assert.ok(noted, 'the noted-by name was not drawn');
  assert.ok(checked, 'the checked-by name was not drawn');

  assert.ok(endorsed.x > 300, `the endorsement name was drawn at x=${endorsed.x}, which is the left column`);
  assert.ok(noted.x > 300, `the noted-by name was drawn at x=${noted.x}, which is the left column`);
  assert.ok(
    noted.y < endorsed.y,
    `the noted-by name (y=${noted.y}) is not below the endorsement name (y=${endorsed.y})`,
  );
  // And the two bottom-row names share a row, which is where the duplicate shows
  // up: "Checked by" and "Noted by" are the same person on this form.
  assert.ok(
    Math.abs(checked.y - noted.y) < 5,
    `the checked-by and noted-by names are not on the same row (y=${checked.y} vs ${noted.y})`,
  );
});

