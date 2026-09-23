/**
 * Anecdotal Report PDF regression tests.
 *
 * An accepted Anecdotal Report is published to its resident's Documents module
 * as a PDF built by overlaying the filled-up entries onto the *official* form
 * (`frontend/public/forms/Anecdotal Report.pdf`) — not by re-drawing a
 * look-alike. These tests therefore assert two things:
 *
 *  1. the original form survives intact — same page count, same page geometry,
 *     and byte-identical logo images; and
 *  2. the Houseparent's entries actually reach the page.
 *
 * No database and no HTTP server are required: the generator is a pure function.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { PDFDocument, PDFName, PDFRawStream } = require('pdf-lib');

const {
  buildAnecdotalReportPdf,
  buildAnecdotalReportDocument,
  anecdotalReportFileName,
  formatReportDate,
  monthLabel,
  wrapText,
  maxLinesFor,
  isOfficialAnecdotalPdf,
  loadTemplateBytes,
  resolveTemplatePath,
  clearTemplateCache,
  FIELDS,
  WRAP_CHARS,
} = require('../src/utils/anecdotalReportPdf');

const CONTENT = {
  physical: 'Healthy and well-groomed; no complaints of pain reported.',
  emotional: 'Generally positive mood; spoke about missing family.',
  behavioral: 'Follows house rules consistently.',
  education: 'Regular attendance; grades improving in Mathematics.',
  spiritual: 'Joins Sunday service voluntarily.',
  productivity: 'Completes assigned chores on time.',
  coPeers: 'Maintains harmonious relationships with co-peers.',
  staff: 'Respectful and responsive to staff instructions.',
  groupLiving: 'Participates actively in group activities.',
  recommendations: 'Continue psychosocial support; review next month.',
};

const REPORT = {
  id: 'ANR900',
  residentId: 'CH001',
  reportDate: '2026-09-16',
  reportYear: 2026,
  reportMonth: 9,
  room: 'Cottage 2',
  houseparentName: 'Maria Santos',
  content: CONTENT,
};

/** Every stream in the file, inflated when it is Flate-encoded. */
function decodedStreams(buffer) {
  const source = buffer.toString('latin1');
  const streams = [];
  const pattern = /stream\r?\n/g;
  let match;
  while ((match = pattern.exec(source))) {
    const from = match.index + match[0].length;
    const to = source.indexOf('endstream', from);
    if (to < 0) continue;
    const raw = Buffer.from(source.slice(from, to), 'latin1');
    try {
      streams.push(zlib.inflateSync(raw).toString('latin1'));
    } catch {
      streams.push(raw.toString('latin1'));
    }
  }
  return streams.join('\n');
}

/**
 * The text the generator drew, recovered from the page content streams.
 *
 * pdf-lib writes base-14 font text as a hex string of the encoded bytes, so
 * `<42656E> Tj` is the word "Ben". Decoding those hex strings is enough to
 * prove a value reached the page. (The template's own pre-printed wording uses
 * subset-font glyph codes and is not recoverable this way — it is verified
 * through the geometry and logo assertions instead.)
 */
function drawnText(buffer) {
  return [...decodedStreams(buffer).matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)]
    .map((match) => (match[1].length % 2 === 0 ? Buffer.from(match[1], 'hex').toString('latin1') : ''))
    .join('\n');
}

/** Image XObjects keyed by `page:name`, with their raw compressed bytes. */
function imageStreams(pdf) {
  const images = new Map();
  pdf.getPages().forEach((page, index) => {
    const xObjects = page.node.Resources()?.lookup(PDFName.of('XObject'));
    if (!xObjects) return;
    for (const [name, ref] of xObjects.entries()) {
      const stream = pdf.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      if (String(stream.dict.get(PDFName.of('Subtype'))) !== '/Image') continue;
      images.set(`${index}:${name.asString()}`, {
        width: Number(stream.dict.get(PDFName.of('Width'))),
        height: Number(stream.dict.get(PDFName.of('Height'))),
        bytes: Buffer.from(stream.contents),
      });
    }
  });
  return images;
}

function pageSizes(pdf) {
  return pdf.getPages().map((page) => {
    const box = page.getMediaBox();
    return { width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 };
  });
}

// ────────────────────────────────────────────────────────────────────────────

test('the official template is present and readable', () => {
  const resolved = resolveTemplatePath();
  assert.ok(resolved, 'no Anecdotal Report template found — accepted reports cannot be published');
  assert.ok(resolved.endsWith(path.join('forms', 'Anecdotal Report.pdf')), `unexpected template path ${resolved}`);
  const bytes = loadTemplateBytes();
  assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
});

test('a report is built on the original form: same pages, same geometry, same logos', async () => {
  const template = await PDFDocument.load(loadTemplateBytes());
  const output = await PDFDocument.load(await buildAnecdotalReportPdf({
    childName: 'Juan Dela Cruz',
    reportDate: REPORT.reportDate,
    room: REPORT.room,
    monthLabel: monthLabel(REPORT.reportYear, REPORT.reportMonth),
    houseparentName: REPORT.houseparentName,
    content: CONTENT,
  }));

  assert.deepEqual(pageSizes(output), pageSizes(template),
    'the output must keep the official form\'s page count and page size');
  assert.equal(pageSizes(output).length, 2, 'the official form is two pages');

  const templateImages = imageStreams(template);
  const outputImages = imageStreams(output);
  assert.ok(templateImages.size > 0, 'the template should embed the agency logos');
  assert.equal(outputImages.size, templateImages.size, 'a logo went missing');
  for (const [key, expected] of templateImages) {
    const actual = outputImages.get(key);
    assert.ok(actual, `image ${key} is missing from the output`);
    assert.equal(actual.width, expected.width, `image ${key} width changed`);
    assert.equal(actual.height, expected.height, `image ${key} height changed`);
    // The logos must be the original artwork, not a re-encode.
    assert.equal(actual.bytes.length, expected.bytes.length, `image ${key} was re-encoded`);
    assert.ok(actual.bytes.equals(expected.bytes), `image ${key} bytes differ from the template`);
  }
});

test('every filled-up entry reaches the page', async () => {
  const buffer = await buildAnecdotalReportPdf({
    childName: 'Juan Dela Cruz',
    reportDate: REPORT.reportDate,
    room: REPORT.room,
    monthLabel: monthLabel(REPORT.reportYear, REPORT.reportMonth),
    houseparentName: REPORT.houseparentName,
    content: CONTENT,
  });
  const text = drawnText(buffer);

  for (const [key, value] of Object.entries(CONTENT)) {
    assert.ok(text.includes(value), `filled-up "${key}" entry never reached the PDF`);
  }
  for (const needle of ['Juan Dela Cruz', '09/16/2026', 'Cottage 2', 'September 2026', 'Maria Santos']) {
    assert.ok(text.includes(needle), `header value ${JSON.stringify(needle)} never reached the PDF`);
  }
});

test('the entry boxes hold exactly as many lines as their height allows', async () => {
  // A box's first baseline sits at (top + height - 9) and rows step by 13.8pt.
  assert.equal(maxLinesFor(70), 5, 'the 70pt observation boxes take five rows');
  assert.equal(maxLinesFor(28), 2, 'the 28pt co-peers box takes two rows');

  const single = 'one two three four five six seven eight nine ten';
  const buffer = await buildAnecdotalReportPdf({ content: { physical: single } });
  assert.ok(drawnText(buffer).includes(single), 'a short entry should be drawn in full');

  // Over-long entries are truncated inside the box rather than running through
  // the pre-printed rule below it, and the truncation is visible.
  const long = Array(40).fill('The child was observed in good health throughout the period.').join(' ');
  const truncated = drawnText(await buildAnecdotalReportPdf({ content: { physical: long } }));
  const rows = truncated.split('\n').filter(Boolean);
  assert.equal(rows.length, maxLinesFor(70), 'a long entry must be cut to the box\'s row budget');
  assert.ok(rows[rows.length - 1].endsWith('...'), 'the last drawn row must mark the truncation');
  assert.ok(!truncated.includes(long), 'the entry must not be drawn in full past the box edge');
});

test('the drawn rows sit on the blank lines of the form', async () => {
  const buffer = await buildAnecdotalReportPdf({ content: { physical: 'row one' } });
  const streams = decodedStreams(buffer);
  // pdf-lib emits `1 0 0 1 x y Tm` before each run; the physical box's first row
  // is at (109, 634.6 + 70 - 9).
  assert.ok(streams.includes('109 695.6'), 'the first PHYSICAL row is not at its measured position');
});

test('a look-alike page is recognised as stale and a real one is not', async () => {
  const real = await buildAnecdotalReportPdf({ childName: 'x', content: CONTENT });
  assert.equal(await isOfficialAnecdotalPdf(real), true, 'a freshly generated report must be accepted as the official form');

  // A single US-Letter page — the shape the previous generator produced.
  const lookAlike = await PDFDocument.create();
  lookAlike.addPage([612, 792]);
  const stale = Buffer.from(await lookAlike.save());
  assert.equal(await isOfficialAnecdotalPdf(stale), false, 'a look-alike page must be flagged for regeneration');

  assert.equal(await isOfficialAnecdotalPdf(Buffer.from('not a pdf at all')), false);
  assert.equal(await isOfficialAnecdotalPdf(Buffer.alloc(0)), false);
});

test('typographic punctuation and non-Latin-1 input cannot break generation', async () => {
  const buffer = await buildAnecdotalReportPdf({
    childName: 'Ana \u2014 Reyes',
    room: 'Cottage \u2014 2 \u201Cquoted\u201D',
    houseparentName: 'Jos\u00e9 \u00f1',
    content: { physical: 'Emoji \u{1F600} and CJK \u4e2d\u6587 must not throw.' },
  });
  const text = drawnText(buffer);

  assert.ok(text.includes('Ana - Reyes'), 'an em dash should fold to a hyphen');
  assert.ok(text.includes('Cottage - 2 "quoted"'), 'smart quotes should fold to ASCII');
  assert.ok(text.includes('Jos\u00e9 \u00f1'), 'Latin-1 accents should survive');
  assert.ok(!text.includes('\uFFFD'), 'a replacement character leaked into the output');
  assert.ok(await isOfficialAnecdotalPdf(buffer), 'the result must still be the official form');
});

test('an empty report still produces the official form', async () => {
  for (const report of [{}, { childName: 'x', content: '{}' }, { content: null }]) {
    const buffer = await buildAnecdotalReportPdf(report);
    assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.ok(await isOfficialAnecdotalPdf(buffer), 'an empty report must still be the official form');
  }
});

test('wrapText honours the line budget, explicit newlines and hard breaks', () => {
  assert.deepEqual(wrapText(''), []);
  // A blank line is dropped so it does not consume a row of the box.
  assert.deepEqual(wrapText('a\n\nb'), ['a', 'b']);
  assert.deepEqual(wrapText('first paragraph\nsecond paragraph'), ['first paragraph', 'second paragraph']);
  for (const line of wrapText(`${'x'.repeat(500)} short words here`)) {
    assert.ok(line.length <= WRAP_CHARS, `wrapText emitted ${line.length} chars (max ${WRAP_CHARS})`);
  }
  assert.ok(wrapText('y'.repeat(1000)).every((line) => line.length <= WRAP_CHARS), 'a long word must be hard-broken');
});

test('the report date is formatted without shifting a Manila-midnight date', () => {
  assert.equal(formatReportDate('2026-09-16'), '09/16/2026');
  assert.equal(formatReportDate(''), '');
  assert.equal(formatReportDate(null), '');
  // A Date is formatted from its local parts — toISOString() would roll a
  // Manila-midnight date back to the previous day.
  assert.equal(formatReportDate(new Date(2026, 8, 16)), '09/16/2026');
  assert.equal(formatReportDate(new Date(2026, 0, 1)), '01/01/2026');
  assert.equal(formatReportDate(new Date('nonsense')), '');
});

test('the download filename is safe and predictable', async () => {
  const { fileName, fileSize, buffer } = await buildAnecdotalReportDocument(REPORT, 'Juan Dela Cruz');
  assert.equal(fileName, 'Anecdotal Report - September 2026.pdf');
  assert.equal(fileSize, buffer.length);
  assert.equal(anecdotalReportFileName(REPORT), 'Anecdotal Report - September 2026.pdf');
  assert.equal(monthLabel(2026, 9), 'September 2026');
  // Month numbers outside 1-12 fall back to the raw value instead of throwing.
  assert.equal(monthLabel(2026, 13), '13 2026');
  // Path separators can never reach the Content-Disposition header.
  assert.ok(!/[/\\:*?"<>|]/.test(anecdotalReportFileName(REPORT)));
});

// ── Static guards ───────────────────────────────────────────────────────────
// These read the source rather than run it, to catch the specific regressions
// that are easy to reintroduce and hard to observe.

const FRONTEND_COMPONENT = path.resolve(__dirname, '../../frontend/src/app/components/AnecdotalReports.tsx');
const CONTROLLER = path.resolve(__dirname, '../src/controllers/anecdotalReportController.js');

test('the backend PDF layout and the frontend preview layout still agree', () => {
  const source = fs.readFileSync(FRONTEND_COMPONENT, 'utf8');
  const entries = [...source.matchAll(
    /\{\s*key:\s*'([^']+)',\s*label:[^,]+,\s*page:\s*(\d+),\s*x:\s*([\d.]+),\s*top:\s*([\d.]+),\s*width:\s*([\d.]+),\s*height:\s*([\d.]+)\s*\}/g
  )];
  assert.equal(entries.length, FIELDS.length,
    `the preview declares ${entries.length} fields but the PDF draws ${FIELDS.length}`);

  entries.forEach((entry, index) => {
    const [, key, page, x, top, width, height] = entry;
    const field = FIELDS[index];
    assert.equal(field.key, key, `field ${index} key differs`);
    assert.equal(field.page, Number(page), `${key}: page differs`);
    assert.equal(field.x, Number(x), `${key}: x differs`);
    assert.equal(field.top, Number(top), `${key}: top differs`);
    assert.equal(field.height, Number(height), `${key}: height differs`);
    // `width` is only used by the on-screen textarea; the PDF wraps to WRAP_CHARS.
    assert.ok(Number(width) > 0, `${key}: preview width must be positive`);
  });
});

test('only accepting a report publishes it, and rejecting removes it', () => {
  const source = fs.readFileSync(CONTROLLER, 'utf8');
  const body = (name, next) => {
    const from = source.indexOf(`async function ${name}`);
    assert.ok(from >= 0, `${name}() is missing`);
    const to = source.indexOf(`async function ${next}`, from + 1);
    return source.slice(from, to > 0 ? to : undefined);
  };

  const submitBody = body('submit', 'review');
  assert.ok(!/syncDocumentForReport/.test(submitBody),
    'submit() must not publish to Documents — only an accepted report belongs in the child\'s folder');

  const returnBody = body('returnForRevision', 'finalize');
  assert.ok(/unpublishDocumentForReport/.test(returnBody),
    'returnForRevision() must remove any published document when a report is rejected');

  const finalizeBody = body('finalize', 'getPdf');
  assert.ok(/syncDocumentForReport/.test(finalizeBody),
    'finalize() is the single place an accepted report is published');

  const updateBody = body('update', 'submit');
  assert.ok(!/syncDocumentForReport/.test(updateBody),
    'update() must not publish — an editable report is never an accepted one');
});

test('the template cache can be cleared, so a missing template is detectable', () => {
  assert.ok(loadTemplateBytes().length > 0);
  clearTemplateCache();
  assert.ok(loadTemplateBytes().length > 0, 'the template must be re-readable after clearing');
});
