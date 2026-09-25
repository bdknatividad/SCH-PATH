import { rgb } from 'pdf-lib';
import bodyMarkingsConfig from '@/app/config/bodyMarkings.json';

/**
 * The piercings / tattoos block on the generated Admission Slip.
 *
 * The official template has no body-marking area, so the block is overlaid on
 * the free band between the "Houseparent on Duty" block and the "Attested by /
 * Checked by / Noted by" row. Measured on
 * `frontend/public/forms/admission-slip.pdf` at 150 dpi: ink-free from y_top
 * 492.3 to 531.4 across the full width. The four lines below occupy y_top
 * 495.75..528, clearing both neighbours. Changing any of these without
 * re-measuring can print over a signature rule, and nothing else would notice.
 *
 * **One implementation, called by both slip writers.** `ChildRecords.tsx` and
 * `ChildDetail.tsx` each draw the slip from their own copy of the same drawing
 * code, and they are not identical — their coordinates differ by a few points.
 * The markings were first added to the Child Records writer only, so the slip
 * opened from a resident's own page printed without them; the live check caught
 * it by reading the generated PDF's text layer. Anything added to one writer has
 * to be added to the other, and the cheapest way to be sure is to have only one.
 */

/*
 * One piercing or tattoo recorded on an admission.
 *
 * `location` is one of `bodyMarkings.json`'s locations and `type` one of its
 * marking types; both are chosen from a dropdown so a stored marking can be read
 * back and compared between two admissions. `description` is the free-text note
 * — the design, the size, anything the two dropdowns cannot say.
 */
export interface BodyMarkingEntry {
  type: string;
  location: string;
  description: string;
}

const MARKING_TYPES = bodyMarkingsConfig.markingTypes as string[];
const MAX_DESCRIPTION = bodyMarkingsConfig.maxDescriptionLength as number;

const FONT_SIZE = 7;
const LINE_HEIGHT = 8.5;
const MAX_LINES = 4;
/** 72 + 636 = 708, the right edge of the template's own widest line. */
const WIDTH = 636;
const LEFT = 72;
const BASELINE = 111;

/**
 * The recorded markings as the single string the slip prints.
 *
 * Grouped by type so each kind's body parts read together, with a marking's note
 * following it in parentheses. `dropped` is the number of markings that did not
 * fit the band — it is printed rather than silently omitted, because a slip that
 * looks like a complete list when it is not is worse than one that says so.
 * `noteLimit` shortens the notes when even one marking will not fit.
 */
export function bodyMarkingsSlipText(
  entries: BodyMarkingEntry[] | null | undefined,
  dropped = 0,
  noteLimit = MAX_DESCRIPTION
): string {
  const list = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry && String(entry.location || '').trim() !== ''
  );

  const parts: string[] = [];

  for (const type of MARKING_TYPES) {
    const inType = list.filter((entry) => entry.type === type);

    if (inType.length === 0) continue;

    const listed = inType
      .map((entry) => {
        const note = String(entry.description || '').trim();

        if (!note) return entry.location;

        const clipped =
          note.length > noteLimit
            ? `${note.slice(0, Math.max(1, noteLimit - 1)).trimEnd()}…`
            : note;

        return `${entry.location} (${clipped})`;
      })
      .join(', ');

    parts.push(`${type}: ${listed}`);
  }

  const body = parts.join('; ');
  const suffix = dropped > 0 ? `${body ? ' ' : ''}(+${dropped} more)` : '';

  return `Piercings / Tattoos: ${body}${suffix}`;
}

/** How many lines `text` occupies at the block's width and size. */
function countLines(text: string, font: any): number {
  let lines = 1;
  let current = '';

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;

    if (font.widthOfTextAtSize(candidate, FONT_SIZE) <= WIDTH) {
      current = candidate;
    } else {
      lines += 1;
      current = word;
    }
  }

  return lines;
}

/**
 * Draw the block onto `page`. Returns false when nothing was drawn, which is
 * what happens for a resident with no markings on record — their slip is then
 * byte-for-byte the slip the app produced before this feature existed.
 */
export function drawBodyMarkingsOnSlip(
  page: any,
  font: any,
  entries: BodyMarkingEntry[] | null | undefined
): boolean {
  const recorded = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry && String(entry.location || '').trim() !== ''
  );

  if (recorded.length === 0) return false;

  /*
   * The band holds MAX_LINES lines. When the whole list will not fit, whole
   * markings are dropped from the end and the number dropped is printed; when
   * even one will not fit, its note is shortened instead of the marking being
   * lost.
   */
  let kept = recorded.length;
  let noteLimit = MAX_DESCRIPTION;
  let text = bodyMarkingsSlipText(recorded);

  while (countLines(text, font) > MAX_LINES) {
    if (kept > 1) {
      kept -= 1;
    } else if (noteLimit > 8) {
      noteLimit = Math.max(8, Math.floor(noteLimit / 2));
    } else {
      break;
    }

    text = bodyMarkingsSlipText(recorded.slice(0, kept), recorded.length - kept, noteLimit);
  }

  // Fitted by whole words, so the last line is not a stub that overflows.
  let lineIndex = 0;
  let current = '';

  const flush = (line: string) => {
    if (!line) return;
    page.drawText(line, {
      x: LEFT,
      y: BASELINE - lineIndex * LINE_HEIGHT,
      size: FONT_SIZE,
      font,
      color: rgb(0, 0, 0),
    });
    lineIndex += 1;
  };

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;

    if (font.widthOfTextAtSize(candidate, FONT_SIZE) <= WIDTH) {
      current = candidate;
    } else {
      flush(current);
      current = word;
    }
  }
  flush(current);

  return true;
}
