import React, {
  CSSProperties,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  useLocation,
  useNavigate,
} from 'react-router-dom';

import {
  Card,
  CardContent,
} from '@/app/components/ui/card';

import {
  Button,
} from '@/app/components/ui/button';

import {
  Input,
} from '@/app/components/ui/input';

import {
  Label,
} from '@/app/components/ui/label';

import {
  Badge,
} from '@/app/components/ui/badge';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/select';

import {
  Search,
  Plus,
  Eye,
  Trash2,
  AlertCircle,
  User,
  Calendar,
  History,
  Printer,
  Edit,
  Loader2,
  ArrowLeft,
  ArrowRight,
  FileText,
  CheckCircle2,
  X,
} from 'lucide-react';

import {
  SignaturePad,
  SignaturePadModal,
} from '@/app/components/SignaturePad';

import {
  ADMISSION_HOUSEPARENT_SIGNATURE_BOX,
  ADMISSION_REFERRING_PARTY_SIGNATURE_BOX,
  ADMISSION_GUARDIAN_SIGNATURE_BOX,
  ADMISSION_RESIDENT_SIGNATURE_BOX,
  drawSignatureImage,
  toPdfBox,
  type SignatureBox,
} from '@/app/utils/signaturePdf';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/app/components/ui/dialog';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/app/components/ui/alert-dialog';

import {
  PDFDocument,
  StandardFonts,
  rgb,
} from 'pdf-lib';

import {
  Document as PdfDocument,
  Page as PdfPage,
  pdfjs,
} from 'react-pdf';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { useData } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { usePermissions } from '@/app/hooks/usePermissions';
import { describeError, request } from '@/services/api';
import { systemDialog } from '@/app/components/SystemDialog';
import { formatPHDate } from '@/utils/dateFormatter';
import bodyMarkingsConfig from '@/app/config/bodyMarkings.json';
import {
  BodyMarkingEntry,
  drawBodyMarkingsOnSlip,
} from '@/app/utils/admissionSlipMarkings';

// The body parts a piercing or tattoo can be recorded against. Read from the
// same file `admissionController` validates against, so the dropdown and the API
// cannot disagree about the vocabulary — and the location is a dropdown rather
// than a text box, which is the whole point: a typed body part is not
// comparable between two admissions.
const BODY_MARKING_TYPES = bodyMarkingsConfig.markingTypes;
const BODY_MARKING_LOCATIONS = bodyMarkingsConfig.locations;
const BODY_MARKING_MAX_ENTRIES = bodyMarkingsConfig.maxEntries;
const BODY_MARKING_MAX_DESCRIPTION = bodyMarkingsConfig.maxDescriptionLength;

// `?v=` is a cache key, not a fetch hint — see the note in QuarterlyProgressReport.tsx.
pdfjs.GlobalWorkerOptions.workerSrc =
  `/pdf.worker.mjs?v=${pdfjs.version}`;

type Gender =
  | 'Male'
  | 'Female';

type FormStep =
  | 1
  | 2;

/*
 * One piercing or tattoo recorded on the admission — the type lives in
 * `admissionSlipMarkings.ts` beside the code that prints it, because the slip a
 * user opens from a resident's own page is drawn by a second writer and both
 * have to describe the same shape.
 */

interface ChildFormState {
  firstName: string;
  middleName: string;
  surname: string;

  birthDate: string;
  age: string;

  sex: Gender | '';
  religion: string;
  address: string;

  /*
   * The Resident's own drawn signature, as a PNG data
   * URL, captured the same way as the other staff/party
   * signatures below.
   */
  residentSignature: string;

  guardianName: string;
  guardianContact: string;
  guardianAddress: string;

  /*
   * The Guardian's drawn signature, as a PNG data URL,
   * captured the same way as the other staff/party
   * signatures below.
   */
  guardianSignature: string;

  admissionDate: string;
  expectedDischargeDate: string;

  legalCategory: string;
  specificOffense: string;

  /*
   * Kept for database/back-end compatibility.
   * There is no Case History textbox in the UI.
   */
  caseHistory: string;

  referringParty: string;
  referringPartyContact: string;

  /*
   * The Referring Party's drawn signature, as a PNG data
   * URL, captured the same way as the Houseparent
   * signature below.
   */
  referringPartySignature: string;

  /*
   * This is the selected/displayed houseparent
   * for the official Houseparent on Duty field.
   */
  houseparentOnDuty: string;

  /*
   * The Houseparent on Duty's drawn signature, as a PNG
   * data URL.
   */
  houseparentSignature: string;

  /*
   * Optional resident photo.
   */
  residentImage: string;

  /*
   * Database/user assignment ID.
   */
  assignedHouseparentId: string;

  /*
   * The piercings and tattoos recorded for this admission. `location` is one of
   * BODY_MARKING_LOCATIONS, chosen from a dropdown.
   */
  bodyMarkings: BodyMarkingEntry[];
}

interface AdmissionRecord {
  id: string;
  residentId: string;
  admissionNumber: number;

  /*
   * New / Returning Resident (Abscon/Tumakas) / Relapse. Stored on the admission
   * because the two returning values cannot be derived from the data.
   */
  admissionStatus?: string | null;

  admissionDate: string;
  expectedDischargeDate?: string | null;

  name: string;
  age: number;
  sex: Gender;
  birthDate: string;
  religion: string;
  address: string;

  residentSignature?: string | null;
  residentImage?: string | null;

  guardianName: string;
  guardianContact: string;
  guardianAddress: string;

  guardianSignature?: string | null;

  referringParty: string;
  referringPartyContact: string;

  referringPartySignature?: string | null;

  houseparentOnDuty: string;

  /*
   * The Houseparent on duty as a stable users.id. The name above is a label for
   * the official slip; this is the link the caseload is resolved from, so it
   * survives a rename and cannot be confused between two people with the same
   * display name. Absent on admissions saved before the column existed.
   */
  houseparentUserId?: string | null;

  houseparentSignature?: string | null;

  legalCategory: string;
  specificOffense: string;

  caseHistory?: string | null;

  /*
   * Piercings and tattoos observed at admission. Belongs to the admission
   * rather than the resident: a later admission records the body as it is then.
   * Absent on admissions saved before the column existed, which is "not
   * recorded" rather than "none found".
   */
  bodyMarkings?: BodyMarkingEntry[] | null;

  status?: string;
}

const PDF_WIDTH = 936;
const PDF_HEIGHT = 612;

const PRINT_FONT_SIZE = 11;
const PRINT_LINE_HEIGHT = 13;

const EMPTY_FORM: ChildFormState = {
  firstName: '',
  middleName: '',
  surname: '',

  birthDate: '',
  age: '',

  /*
   * Default for new admissions.
   */
  sex: 'Male',

  religion: '',
  address: '',
  residentSignature: '',

  guardianName: '',
  guardianContact: '',
  guardianAddress: '',
  guardianSignature: '',

  admissionDate: '',
  expectedDischargeDate: '',

  legalCategory: '',
  specificOffense: '',

  caseHistory: '',

  bodyMarkings: [],

  referringParty: '',
  referringPartyContact: '',
  referringPartySignature: '',

  houseparentOnDuty: '',

  houseparentSignature: '',

  residentImage: '',

  assignedHouseparentId: '',
};

/*
 * The body markings as the API receives them.
 *
 * A row the form opened and left blank is dropped here as well as on the
 * server, so an untouched "Add entry" button cannot make the admission
 * unsaveable. The note is capped to the same length `admissionController`
 * enforces — a long note would otherwise be refused by the API after the whole
 * slip had been filled in.
 */
function bodyMarkingsForPayload(
  entries: BodyMarkingEntry[]
): BodyMarkingEntry[] {
  return (
    Array.isArray(entries) ? entries : []
  )
    .map((entry) => ({
      type: String(entry?.type || '').trim(),
      location: String(entry?.location || '').trim(),
      description: String(entry?.description || '')
        .trim()
        .slice(0, BODY_MARKING_MAX_DESCRIPTION),
    }))
    .filter(
      (entry) =>
        entry.type !== '' ||
        entry.location !== '' ||
        entry.description !== ''
    );
}

/*
 * A marking is a type *plus* a body part. A row that was never touched is simply
 * dropped, but one carrying only half of the pair is an unfinished entry.
 *
 * One rule, used by both write paths: a new admission goes through
 * `validatePartTwo`, and the edit form does not run that validator — so without
 * this the API would refuse an edited slip after every other field had been
 * filled in.
 */
function unfinishedBodyMarkings(
  entries: BodyMarkingEntry[]
): BodyMarkingEntry[] {
  return (
    Array.isArray(entries) ? entries : []
  ).filter((marking) => {
    const started =
      marking.type !== '' ||
      marking.location !== '' ||
      marking.description !== '';

    return (
      started &&
      (marking.type === '' ||
        marking.location === '')
    );
  });
}

const UNFINISHED_MARKING_MESSAGE =
  'Choose both the type and the body part for every marking.';

/* ================================================================
   DATE HELPERS
   ================================================================ */

function normalizeName(
  value: string
): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(
  value?: string | null
): string {
  if (!value) {
    return '';
  }

  return String(value).slice(0, 10);
}

/*
 * Stored internally as YYYY-MM-DD.
 * Displayed in Part 2 as MM/DD/YYYY.
 */
function formatDateInput(
  value?: string | null
): string {
  const normalized =
    normalizeDate(value);

  if (!normalized) {
    return '';
  }

  const parts =
    normalized.split('-');

  if (parts.length !== 3) {
    return '';
  }

  const [
    year,
    month,
    day,
  ] = parts;

  return `${month}/${day}/${year}`;
}

function parseMDYDate(
  value: string
): string {
  const digits =
    value
      .replace(/\D/g, '')
      .slice(0, 8);

  if (
    digits.length !== 8
  ) {
    return '';
  }

  const month =
    Number(
      digits.slice(0, 2)
    );

  const day =
    Number(
      digits.slice(2, 4)
    );

  const year =
    Number(
      digits.slice(4, 8)
    );

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    year < 1900 ||
    year > 2100
  ) {
    return '';
  }

  const date =
    new Date(
      year,
      month - 1,
      day
    );

  if (
    date.getFullYear() !==
      year ||
    date.getMonth() !==
      month - 1 ||
    date.getDate() !==
      day
  ) {
    return '';
  }

  return [
    String(year).padStart(
      4,
      '0'
    ),
    String(month).padStart(
      2,
      '0'
    ),
    String(day).padStart(
      2,
      '0'
    ),
  ].join('-');
}

function formatDateWhileTyping(
  value: string
): string {
  const digits =
    value
      .replace(/\D/g, '')
      .slice(0, 8);

  if (
    digits.length <= 2
  ) {
    return digits;
  }

  if (
    digits.length <= 4
  ) {
    return `${digits.slice(
      0,
      2
    )}/${digits.slice(2)}`;
  }

  return `${digits.slice(
    0,
    2
  )}/${digits.slice(
    2,
    4
  )}/${digits.slice(4)}`;
}

function formatSlipDate(
  value?: string | null
): string {
  return formatDateInput(
    value
  );
}

function calculateAge(
  birthDate: string
): string {
  if (!birthDate) {
    return '';
  }

  const today =
    new Date();

  const birth =
    new Date(
      `${birthDate}T00:00:00`
    );

  if (
    Number.isNaN(
      birth.getTime()
    )
  ) {
    return '';
  }

  let age =
    today.getFullYear() -
    birth.getFullYear();

  const monthDifference =
    today.getMonth() -
    birth.getMonth();

  if (
    monthDifference < 0 ||
    (
      monthDifference === 0 &&
      today.getDate() <
        birth.getDate()
    )
  ) {
    age--;
  }

  return age >= 0
    ? String(age)
    : '';
}

function splitFullName(
  name: string
) {
  const parts =
    name
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);

  if (
    parts.length === 0
  ) {
    return {
      firstName: '',
      middleName: '',
      surname: '',
    };
  }

  if (
    parts.length === 1
  ) {
    return {
      firstName:
        parts[0],
      middleName: '',
      surname: '',
    };
  }

  if (
    parts.length === 2
  ) {
    return {
      firstName:
        parts[0],
      middleName: '',
      surname:
        parts[1],
    };
  }

  return {
    firstName:
      parts[0],
    middleName:
      parts
        .slice(1, -1)
        .join(' '),
    surname:
      parts[
        parts.length - 1
      ],
  };
}

function buildFullName(
  form: ChildFormState
): string {
  return [
    form.firstName,
    form.middleName,
    form.surname,
  ]
    .map((value) =>
      value.trim()
    )
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeContactNumber(
  value: string
): string {
  return value
    .replace(/\D/g, '')
    .slice(0, 11);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('Unable to prepare the Admission Slip PDF for Documents.'));
    };
    reader.onerror = () => reject(reader.error || new Error('Unable to read the Admission Slip PDF.'));
    reader.readAsDataURL(blob);
  });
}

/* ================================================================
   PDF POSITION HELPERS
   ================================================================ */

function pdfFieldStyle(
  x: number,
  y: number,
  width: number,
  height = 14
): CSSProperties {
  // These coordinates come directly from the text/graphic geometry of the
  // official admission-slip PDF.  The overlay is rendered inside an element
  // with the exact same page dimensions, so percentages remain 1:1 with the
  // PDF instead of depending on the react-pdf document wrapper's height.
  return {
    position: 'absolute',
    left: `${(x / PDF_WIDTH) * 100}%`,
    top: `${(y / PDF_HEIGHT) * 100}%`,
    width: `${(width / PDF_WIDTH) * 100}%`,
    height: `${(height / PDF_HEIGHT) * 100}%`,
    minWidth: 0,
    minHeight: 0,
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: '12px',
    boxSizing: 'border-box',
    padding: '0',
    lineHeight: '12px',
    verticalAlign: 'baseline',
  };
}

/*
 * Invisible by default.
 * Yellow when the field is hovered/focused.
 */
const invisibleFieldClass =
  [
    'absolute',
    'z-20',
    'm-0',
    'rounded-sm',
    'border-0',
    'bg-transparent',
    'py-0',
    'text-black',
    'outline-none',
    'shadow-none',
    'transition-colors',
    'duration-100',
    'hover:bg-yellow-200/50',
    'focus:bg-yellow-200/60',
    'focus:ring-2',
    'focus:ring-yellow-500/70',
    // A value longer than its printed blank line (e.g. a full name in a
    // one-line box) was overflowing past its own field height and visually
    // bleeding into the row below it. Single-line fields now clip instead
    // of wrapping/overflowing; textarea fields (which set their own
    // whitespace handling) are unaffected since 'overflow-hidden' alone
    // doesn't force single-line behavior on them.
    'overflow-hidden',
    'whitespace-nowrap',
    'text-ellipsis',
  ].join(' ');

/* ================================================================
   PHOTO OVERLAY
   ================================================================ */

function PdfPhotoOverlay({
  label,
  value,
  onChange,
  style,
}: {
  label: string;
  value: string;
  onChange: (
    value: string
  ) => void;
  style: CSSProperties;
}) {
  const inputId =
    `resident-photo-${label
      .toLowerCase()
      .replace(
        /[^a-z0-9]+/g,
        '-'
      )}`;

  return (
    <div
      className="absolute z-30 group"
      style={style}
    >
      <input
        id={inputId}
        type="file"
        accept="image/png,image/jpeg,image/jpg"
        className="hidden"
        onChange={(event) => {
          const file =
            event.target.files?.[0];

          if (!file) {
            return;
          }

          if (
            !file.type.startsWith(
              'image/'
            )
          ) {
            void systemDialog.validation('That file is not an image', {
              description: 'The resident photo must be a PNG or JPG/JPEG file.',
            });

            event.target.value =
              '';

            return;
          }

          if (
            file.size >
            5 * 1024 * 1024
          ) {
            void systemDialog.validation('That photo is too large', {
              description: 'The resident photo must be 5 MB or smaller. Resize or compress it, then choose it again.',
            });

            event.target.value =
              '';

            return;
          }

          const reader =
            new FileReader();

          reader.onload = () => {
            onChange(
              String(
                reader.result ||
                  ''
              )
            );
          };

          reader.onerror = () => {
            void systemDialog.failure(
              'Could not read the resident photo',
              'The file could not be opened in the browser. Try a different copy of the image.'
            );
          };

          reader.readAsDataURL(
            file
          );

          event.target.value =
            '';
        }}
      />

      <label
        htmlFor={inputId}
        className={[
          'absolute inset-0 cursor-pointer',
          'rounded-sm',
          'transition-colors duration-100',
          'hover:bg-yellow-200/35',
        ].join(' ')}
        title={label}
      >
        {value && (
          <img
            src={value}
            alt={label}
            className="absolute inset-0 h-full w-full object-cover pointer-events-none"
          />
        )}

        {!value && (
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-[#2F3E46] opacity-0 group-hover:opacity-100 transition-opacity">
            Add photo
          </span>
        )}
      </label>

      {value && (
        <button
          type="button"
          title="Remove photo"
          aria-label="Remove resident photo"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();

            onChange('');
          }}
          className="absolute right-1 top-1 z-40 flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-white shadow-md opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-red-700 transition-opacity"
        >
          <X
            size={13}
          />
        </button>
      )}
    </div>
  );
}

/* ================================================================
   SIGNATURE OVERLAY
   ================================================================ */

/*
 * A draw-in-place signature field laid directly over the signature line of the
 * official form. `box` is in slip coordinates, so the same numbers position the
 * on-screen pad and the stamp that goes onto the generated PDF.
 *
 * The band reserved for a signature on this form is only a few millimetres
 * tall. Drawing directly inside it was cramped with a mouse and impossible with
 * a finger, so the band is now a trigger: it shows the saved signature and
 * opens a full-size canvas in a modal.
 */
function PdfSignatureField({
  label,
  value,
  onChange,
  box,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (
    value: string
  ) => void;
  box: SignatureBox;
  disabled?: boolean;
}) {
  return (
    <div
      className="absolute z-30"
      style={pdfFieldStyle(
        box.x,
        box.y,
        box.width,
        box.height
      )}
    >
      <SignaturePadModal
        label={label}
        value={value}
        onChange={onChange}
        disabled={disabled}
        hint="Sign here"
      />
    </div>
  );
}

/* ================================================================
   DATE OVERLAY
   ================================================================ */

function PdfDateField({
  value,
  onChange,
  style,
  label,
}: {
  value: string;
  onChange: (
    value: string
  ) => void;
  style: CSSProperties;
  label: string;
}) {
  const [
    displayValue,
    setDisplayValue,
  ] = useState(
    formatDateInput(
      value
    )
  );

  useEffect(() => {
    setDisplayValue(
      formatDateInput(
        value
      )
    );
  }, [value]);

  return (
    <input
      aria-label={label}
      type="text"
      inputMode="numeric"
      maxLength={10}
      placeholder="MM/DD/YYYY"
      value={
        displayValue
      }
      onChange={(event) => {
        const formatted =
          formatDateWhileTyping(
            event.target.value
          );

        setDisplayValue(
          formatted
        );

        const isoDate =
          parseMDYDate(
            formatted
          );

        if (isoDate) {
          onChange(
            isoDate
          );
        } else if (
          formatted.length ===
          0
        ) {
          onChange('');
        }
      }}
      className={
        invisibleFieldClass
      }
      style={style}
    />
  );
}

/* ================================================================
   ADMISSION SLIP EDITOR
   ================================================================ */

function AdmissionSlipEditor({
  form,
  setForm,
  formErrors,
  houseparents,
}: {
  form: ChildFormState;
  setForm: React.Dispatch<
    React.SetStateAction<ChildFormState>
  >;
  formErrors:
    Record<string, string>;
  houseparents: {
    id: string;
    username: string;
    label: string;
    assignedCount: number;
    maxCaseload: number;
  }[];
}) {
  const residentName =
    buildFullName(form);

  // Measure the available width so the PDF canvas and its overlay fields
  // always scale together on desktop, minimized browser windows, and phones.
  const slipContainerRef =
    useRef<HTMLDivElement | null>(null);
  const [slipWidth, setSlipWidth] =
    useState(PDF_WIDTH);
  const slipHeight =
    slipWidth * PDF_HEIGHT / PDF_WIDTH;

  useEffect(() => {
    const element = slipContainerRef.current;
    if (!element) return;

    const updateWidth = () => {
      setSlipWidth(Math.max(1, Math.min(PDF_WIDTH, Math.floor(element.clientWidth))));
    };

    updateWidth();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateWidth);
      observer.observe(element);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  const setField = <
    K extends keyof ChildFormState
  >(
    field: K,
    value: ChildFormState[K]
  ) => {
    setForm(
      (previous) => ({
        ...previous,
        [field]: value,
      })
    );
  };

  return (
    <div className="space-y-5">

      {/* HEADER */}
      <div className="rounded-xl border border-[#2F3E46]/15 bg-[#f8f9fa] px-4 py-3">

        <div className="flex items-center gap-2">
          <FileText
            size={17}
            className="text-[#FFD100]"
          />

          <h4 className="font-bold text-[#2F3E46]">
            Admission Slip
          </h4>
        </div>

        <p className="text-xs text-gray-500 mt-1">
          Fill the official Admission Slip directly.
          Hover over an editable area to highlight it.
        </p>

      </div>

      {/* OFFICIAL PDF */}
      <div className="w-full min-w-0 overflow-hidden bg-neutral-200 rounded-xl p-2 sm:p-3">
        <div
          ref={slipContainerRef}
          className="relative mx-auto w-full max-w-full min-w-0 overflow-hidden"
          style={{
            aspectRatio: `${PDF_WIDTH} / ${PDF_HEIGHT}`,
            containerType: 'inline-size',
            contain: 'layout paint size',
          }}
        >

        <div
          className="relative mx-auto shrink-0 overflow-hidden bg-white"
          style={{
            width: `${slipWidth}px`,
            height: `${slipHeight}px`,
          }}
        >
        <PdfDocument
          file="/forms/admission-slip.pdf"
          loading={
            <div className="min-h-[500px] rounded-xl bg-white flex items-center justify-center text-sm text-gray-500">
              Loading official Admission Slip...
            </div>
          }
          error={
            <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-600">
              Unable to load the official Admission Slip.
              <br />
              Make sure this file exists:
              <br />
              <strong>
                frontend/public/forms/admission-slip.pdf
              </strong>
            </div>
          }
        >
          <div className="absolute inset-0 bg-white">

            {/* BASE PDF: render at the measured container width. */}
            <div className="absolute inset-0 z-0 overflow-hidden">
              <PdfPage
                pageNumber={1}
                width={slipWidth}
                className="block w-full h-auto max-w-full"
                style={{ width: '100%', height: 'auto', display: 'block' }}
                renderTextLayer={
                  false
                }
                renderAnnotationLayer={
                  false
                }
              />
            </div>

            {/* ==================================================
                DATE OF ADMISSION
                ================================================== */}

            <PdfDateField
              label="Date of Admission"
              value={
                form.admissionDate
              }
              onChange={(value) =>
                setField(
                  'admissionDate',
                  value
                )
              }
              style={pdfFieldStyle(183.105, 219.28, 215.184, 12)}
            />

            {/* ==================================================
                NAME
                ================================================== */}

            <input
              aria-label="Name of Resident"
              type="text"
              value={
                residentName
              }
              readOnly
              className={[
                invisibleFieldClass,
                'cursor-default',
              ].join(' ')}
              style={pdfFieldStyle(178.501, 243.87, 215.172, 12)}
            />

            {/* ==================================================
                AGE
                ================================================== */}

            <input
              aria-label="Age"
              type="text"
              value={
                form.age
              }
              readOnly
              className={[
                invisibleFieldClass,
                'cursor-default',
              ].join(' ')}
              style={pdfFieldStyle(107.601, 258.67, 29.736, 12)}
            />

            {/* ==================================================
                SEX
                ================================================== */}

            <select
              aria-label="Sex"
              value={
                form.sex ||
                'Male'
              }
              onChange={(event) =>
                setField(
                  'sex',
                  event.target
                    .value as Gender
                )
              }
              className={[
                invisibleFieldClass,
                'appearance-none',
                'cursor-pointer',
                'min-w-0',
                'overflow-hidden',
              ].join(' ')}
              style={{
                ...pdfFieldStyle(162.753, 258.67, 35.748, 12),
                textOverflow: 'clip',
              }}
            >
              <option value="Male">
                Male
              </option>

              <option value="Female">
                Female
              </option>
            </select>

            {/* ==================================================
                DATE OF BIRTH
                ================================================== */}

            <PdfDateField
              label="Date of Birth"
              value={
                form.birthDate
              }
              onChange={(value) => {
                setForm(
                  (
                    previous
                  ) => ({
                    ...previous,
                    birthDate:
                      value,
                    age:
                      value
                        ? calculateAge(
                            value
                          )
                        : '',
                  })
                );
              }}
              style={pdfFieldStyle(269.433, 258.67, 125.448, 12)}
            />

            {/* ==================================================
                RELIGION
                ================================================== */}

            <input
              aria-label="Religion"
              type="text"
              value={
                form.religion
              }
              onChange={(event) =>
                setField(
                  'religion',
                  event.target
                    .value
                )
              }
              className={
                invisibleFieldClass
              }
              style={pdfFieldStyle(442.796, 258.67, 95.588, 12)}
            />

            {/* ==================================================
                RESIDENT COMPLETE ADDRESS
                ==================================================
                
                Two lines.
                Ends before resident signature.
                ================================================== */}

            <textarea
              aria-label="Complete Address"
              value={
                form.address
              }
              onChange={(event) =>
                setField(
                  'address',
                  event.target
                    .value
                )
              }
              rows={2}
              className={[
                invisibleFieldClass,
                'resize-none',
                'overflow-hidden',
                'leading-[12px]',
              ].join(' ')}
              style={{
                ...pdfFieldStyle(177.909, 283.3, 261.504, 14),
                fontSize:
                  '10px',
              }}
            />

            {/* ==================================================
                RESIDENT SIGNATURE
                ==================================================

                Drawn by the resident directly on the slip, the
                same way the Guardian, Referring Party and
                Houseparent on Duty signatures work. Same size as
                the Guardian signature box, sitting on the blank
                rule right after "Signature of Resident:".
                ================================================== */}

            <PdfSignatureField
              label="Resident signature"
              value={form.residentSignature || ''}
              onChange={(value) =>
                setField('residentSignature', value)
              }
              box={ADMISSION_RESIDENT_SIGNATURE_BOX}
            />

            {/* ==================================================
                GUARDIAN NAME
                ================================================== */}

            <input
              aria-label="Name of Guardian"
              type="text"
              value={
                form.guardianName
              }
              onChange={(event) =>
                setField(
                  'guardianName',
                  event.target
                    .value
                )
              }
              className={
                invisibleFieldClass
              }
              style={pdfFieldStyle(178.281, 332.5, 214.968, 12)}
            />

            {/* ==================================================
                GUARDIAN CONTACT
                ================================================== */}

            <input
              aria-label="Guardian Contact"
              type="tel"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={11}
              value={
                form.guardianContact
              }
              onChange={(event) =>
                setField(
                  'guardianContact',
                  sanitizeContactNumber(
                    event.target
                      .value
                  )
                )
              }
              className={
                invisibleFieldClass
              }
              style={pdfFieldStyle(456.201, 332.5, 244.74, 12)}
            />

            {/* ==================================================
                GUARDIAN ADDRESS
                ================================================== */}

            <textarea
              aria-label="Guardian Complete Address"
              value={
                form.guardianAddress
              }
              onChange={(event) =>
                setField(
                  'guardianAddress',
                  event.target
                    .value
                )
              }
              rows={2}
              className={[
                invisibleFieldClass,
                'resize-none',
                'overflow-hidden',
                'leading-[12px]',
              ].join(' ')}
              style={{
                ...pdfFieldStyle(177.96, 357.33, 209.496, 14),
                fontSize:
                  '10px',
              }}
            />

            {/* ==================================================
                GUARDIAN SIGNATURE
                ==================================================

                Drawn by the guardian directly on the slip, the
                same way the Referring Party and Houseparent on
                Duty signatures work. Sits on the blank rule right
                after "Signature of Guardian:".
                ================================================== */}

            <PdfSignatureField
              label="Guardian signature"
              value={form.guardianSignature || ''}
              onChange={(value) =>
                setField('guardianSignature', value)
              }
              box={ADMISSION_GUARDIAN_SIGNATURE_BOX}
            />

            {/* ==================================================
                REFERRING PARTY
                ================================================== */}

            <input
              aria-label="Referring Party"
              type="text"
              value={
                form.referringParty
              }
              onChange={(event) =>
                setField(
                  'referringParty',
                  event.target
                    .value
                )
              }
              className={
                invisibleFieldClass
              }
              style={pdfFieldStyle(80.425, 406.52, 208.788, 12)}
            />

            {/* ==================================================
                REFERRING PARTY CONTACT
                ================================================== */}

            <input
              aria-label="Referring Party Contact"
              type="tel"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={11}
              value={
                form.referringPartyContact
              }
              onChange={(event) =>
                setField(
                  'referringPartyContact',
                  sanitizeContactNumber(
                    event.target
                      .value
                  )
                )
              }
              className={
                invisibleFieldClass
              }
              style={pdfFieldStyle(352.345, 406.52, 244.956, 12)}
            />

            {/* ==================================================
                REFERRING PARTY SIGNATURE
                ==================================================

                Drawn by the referring party directly on the slip,
                the same way the Houseparent on Duty signature
                works below. Sits on the "Referring Party:" line
                itself, to the right of that label, clear of the
                name/contact row below it.
                ================================================== */}

            <PdfSignatureField
              label="Referring Party signature"
              value={form.referringPartySignature || ''}
              onChange={(value) =>
                setField('referringPartySignature', value)
              }
              box={ADMISSION_REFERRING_PARTY_SIGNATURE_BOX}
            />

            {/* ==================================================
                HOUSEPARENT ASSIGNMENT
                ==================================================
                
                The dropdown is now directly on the
                Houseparent on Duty field.
                ================================================== */}

            <Select
              value={
                form.assignedHouseparentId
              }
              onValueChange={(
                value
              ) => {
                const selected =
                  houseparents.find(
                    (
                      houseparent
                    ) =>
                      houseparent.id ===
                      value
                  );

                setForm(
                  (
                    previous
                  ) => ({
                    ...previous,

                    assignedHouseparentId:
                      value,

                    houseparentOnDuty:
                      selected?.label ||
                      '',
                  })
                );
              }}
            >
              <SelectTrigger
                aria-label="Houseparent on Duty"
                className={[
                  invisibleFieldClass,
                  'appearance-none',
                  'cursor-pointer',
                  'border-0',
                  'shadow-none',
                  'ring-0',
                  'focus:ring-2',
                  'focus:ring-yellow-500/70',
                  ' [&>svg]:opacity-0',
                ].join(' ')}
                /*
                 * Sits on the printed rule at y=475, which is also where the
                 * generated PDF prints this name. It used to float 16pt above
                 * the rule, which both misaligned it and left it underneath the
                 * signature field above.
                 */
                style={pdfFieldStyle(80.025, 463, 215.37, 12)}
              >
                <SelectValue
                  placeholder=""
                />
              </SelectTrigger>

              <SelectContent>

                {houseparents.length ===
                0 ? (
                  <div className="px-3 py-2 text-xs text-gray-400">
                    No active Houseparent
                    accounts found.
                  </div>
                ) : (
                  houseparents.map(
                    (
                      houseparent
                    ) => {
                      const isFull =
                        houseparent.assignedCount >=
                        houseparent.maxCaseload;

                      return (
                        <SelectItem
                          key={
                            houseparent.id
                          }
                          value={
                            houseparent.id
                          }
                          disabled={
                            isFull
                          }
                        >
                          {
                            houseparent.label
                          }
                          {' — '}
                          {
                            houseparent.assignedCount
                          }
                          /
                          {
                            houseparent.maxCaseload
                          }

                          {isFull
                            ? ' (Full)'
                            : ''}
                        </SelectItem>
                      );
                    }
                  )
                )}

              </SelectContent>
            </Select>

            {/* ==================================================
                HOUSEPARENT ON DUTY SIGNATURE
                ==================================================

                Drawn by the assigned Houseparent directly on
                the slip's signature line. It is the only
                signature a staff member owns on this form; the
                resident, guardian and referring-party lines stay
                unsigned, exactly as before.
                ================================================== */}

            <PdfSignatureField
              label="Houseparent on Duty signature"
              value={form.houseparentSignature || ''}
              onChange={(value) =>
                setField('houseparentSignature', value)
              }
              box={ADMISSION_HOUSEPARENT_SIGNATURE_BOX}
            />

            {/* ==================================================
                RESIDENT PHOTO
                ================================================== */}

            <PdfPhotoOverlay
              label="Resident Photo"
              value={
                form.residentImage
              }
              onChange={(value) =>
                setField(
                  'residentImage',
                  value
                )
              }
              style={pdfFieldStyle(704.45, 103.65, 158.95, 125.3)}
            />

          </div>
        </PdfDocument>
        </div>
        </div>
      </div>

      {/* REQUIRED FIELD SUMMARY */}
      {Object.entries(
        formErrors
      ).some(
        ([, value]) =>
          Boolean(value)
      ) && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">

          <p className="text-sm font-bold text-red-700 mb-2">
            Please complete the required fields.
          </p>

          <div className="space-y-1">
            {Object.entries(
              formErrors
            ).map(
              (
                [
                  field,
                  message,
                ]
              ) =>
                message ? (
                  <p
                    key={field}
                    className="text-xs text-red-600"
                  >
                    {message}
                  </p>
                ) : null
            )}
          </div>

        </div>
      )}
    </div>
  );
}

/* ================================================================
   MAIN COMPONENT
   ================================================================ */

export function ChildRecords() {
  const navigate =
    useNavigate();

  // Used by the `?filter=` deep link from the Dashboard's court-hearing tiles.
  const location =
    useLocation();

  const {
    children,
    deleteChild,
    refreshData,
  } = useData();

  const { user } =
    useAuth();

  // Creating a resident is a `create` capability on Child Records. A role the
  // definition withholds it from — the Psychological Staff, for one — must not be
  // offered the button; the API refuses the call either way.
  const { can } = usePermissions();

  const [
    searchTerm,
    setSearchTerm,
  ] = useState('');

  const [
    nameSuggestions,
    setNameSuggestions,
  ] = useState<any[]>([]);

  const [
    showSuggestions,
    setShowSuggestions,
  ] = useState(false);

  const [
    duplicateChild,
    setDuplicateChild,
  ] = useState<any | null>(
    null
  );

  const [
    existingAdmission,
    setExistingAdmission,
  ] =
    useState<AdmissionRecord | null>(
      null
    );

  const [
    existingAdmissions,
    setExistingAdmissions,
  ] =
    useState<AdmissionRecord[]>(
      []
    );

  /**
   * Which kind of returning admission this is.
   *
   * "New" is the only classification the system can work out for itself — it is
   * the absence of an earlier admission. A resident who left without permission
   * (Abscon/Tumakas) and a resident who returned to substance use (Relapse) are
   * indistinguishable in the data, so the Social Worker picks one and the choice
   * is stored on the admission rather than guessed on every render.
   */
  const [
    returningAdmissionStatus,
    setReturningAdmissionStatus,
  ] = useState<
    'Returning Resident (Abscon/Tumakas)' | 'Relapse'
  >('Returning Resident (Abscon/Tumakas)');

  const [
    showExistingAdmission,
    setShowExistingAdmission,
  ] = useState(false);

  const [
    loadingExistingAdmission,
    setLoadingExistingAdmission,
  ] = useState(false);

  const [
    savingAdmission,
    setSavingAdmission,
  ] = useState(false);

  const [
    isFormOpen,
    setIsFormOpen,
  ] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(null);
  const [editingAssignedHouseparentId, setEditingAssignedHouseparentId] = useState<string>('');
  const [birthDateDisplay, setBirthDateDisplay] = useState('');

  const [
    formStep,
    setFormStep,
  ] = useState<FormStep>(
    1
  );

  const [
    childToDelete,
    setChildToDelete,
  ] = useState<string | null>(
    null
  );

  const [
    form,
    setForm,
  ] =
    useState<ChildFormState>({
      ...EMPTY_FORM,
      admissionDate:
        new Date()
          .toISOString()
          .split('T')[0],
    });

  const [
    formErrors,
    setFormErrors,
  ] = useState<
    Record<string, string>
  >({});

  const [
    statusFilter,
    setStatusFilter,
  ] =
    useState<
      'All' |
      'Active' |
      'Discharged' |
      'Absconded'
    >(() => {
      const params =
        new URLSearchParams(
          window.location.search
        );

      const filter =
        params.get(
          'filter'
        );

      if (
        filter ===
        'Discharged'
      ) {
        return 'Discharged';
      }

      if (
        filter === 'Absconded'
      ) {
        return 'Absconded';
      }

      if (
        filter === 'All'
      ) {
        return 'All';
      }

      return 'Active';
    });

  const [
    houseparents,
    setHouseparents,
  ] = useState<
    {
      id: string;
      username: string;
      label: string;
      assignedCount: number;
      maxCaseload: number;
    }[]
  >([]);

  /*
   * Who may pick a Houseparent in the admission form.
   *
   * The backend authorises these exact three roles for
   * GET /resident-assignments/caseload (authorization.isManager accepts
   * centerhead/admin/socialworker), so a Social Worker has to load the
   * list too. Gating this on Center Head alone left the dropdown empty
   * and it fell through to "No active Houseparent accounts found."
   *
   * user.role is already normalized by the login endpoint
   * (userController.login returns normalizeRole(user.role)), so the
   * bare 'socialworker' spelling is the only one that can arrive here.
   */
  const canAssignHouseparent =
    [
      'centerhead',
      'admin',
      'socialworker',
    ].includes(
      (
        user?.role || ''
      ).toLowerCase()
    );

  const todayYYYYMMDD =
    () =>
      new Date()
        .toISOString()
        .split('T')[0];

  useEffect(() => {
    const params =
      new URLSearchParams(
        location.search
      );

    const filter =
      params.get(
        'filter'
      );

    if (
      filter ===
      'Discharged'
    ) {
      setStatusFilter(
        'Discharged'
      );
    } else if (
      filter === 'Absconded'
    ) {
      setStatusFilter(
        'Absconded'
      );
    } else if (
      filter === 'All'
    ) {
      setStatusFilter(
        'All'
      );
    } else if (
      filter === 'Active'
    ) {
      setStatusFilter(
        'Active'
      );
    }
  }, [
    location.search,
  ]);

  /*
   * Load Houseparents.
   *
   * This data is now used directly by the
   * dropdown over the PDF.
   */
  useEffect(() => {
    if (
      !isFormOpen ||
      !canAssignHouseparent
    ) {
      return;
    }

    request<{
      success: boolean;
      data: any[];
    }>(
      '/resident-assignments/caseload',
      {
        method: 'GET',
      }
    )
      .then(
        (response) => {
          if (
            !response?.success
          ) {
            return;
          }

          setHouseparents(
            (
              response.data ||
              []
            ).map(
              (
                houseparent: any
              ) => ({
                ...houseparent,

                id:
                  houseparent.userId,
              })
            )
          );
        }
      )
      .catch(
        (error) => {
          console.error(
            'Failed to load houseparents:',
            error
          );
        }
      );
  }, [
    isFormOpen,
    canAssignHouseparent,
  ]);

  useEffect(() => {
    setBirthDateDisplay(
      form.birthDate ? formatDateInput(form.birthDate) : ''
    );
  }, [form.birthDate]);

  const resetForm =
    () => {
      setEditingId(null);
      setEditingAssignmentId(null);
      setEditingAssignedHouseparentId('');
      setBirthDateDisplay('');

      setForm({
        ...EMPTY_FORM,

        admissionDate:
          todayYYYYMMDD(),
        expectedDischargeDate: '',
      });

      setFormErrors(
        {}
      );

      setFormStep(1);

      setDuplicateChild(
        null
      );

      setExistingAdmission(
        null
      );

      setExistingAdmissions(
        []
      );

      setShowSuggestions(
        false
      );

      setShowExistingAdmission(
        false
      );
    };

  const openEdit = async (childId: string) => {
    const selectedChild = children.find((child: any) => child.id === childId);
    if (!selectedChild) return;

    const parts = String(selectedChild.name || '').trim().split(/\s+/).filter(Boolean);
    let latest: any = null;
    let assignment: any = null;

    try {
      const [admissionRes, assignmentRes] = await Promise.all([
        request<{ success: boolean; data: AdmissionRecord | null }>(`/admissions/resident/${childId}/latest`),
        request<{ success: boolean; data: any[] }>(`/resident-assignments/resident/${childId}`),
      ]);
      latest = admissionRes?.data || null;
      assignment = (assignmentRes?.data || []).find((a: any) => a.status === 'Active' && (a.assignmentType || '').toLowerCase() === 'houseparent') || null;
    } catch (error) {
      console.error('Failed to load current admission/houseparent assignment:', error);
    }

    const source = latest || selectedChild;
    const sourceName = source.name || selectedChild.name || '';
    const sourceParts = String(sourceName).trim().split(/\s+/).filter(Boolean);

    setEditingId(childId);
    setExistingAdmission(latest);
    setEditingAssignmentId(assignment?.id || null);
    setEditingAssignedHouseparentId(assignment?.userId || '');
    setBirthDateDisplay(formatDateInput(normalizeDate(source.birthDate || selectedChild.birthDate)));
    setForm({
      firstName: sourceParts[0] || parts[0] || '',
      middleName: sourceParts.length > 2 ? sourceParts.slice(1, -1).join(' ') : '',
      surname: sourceParts.length > 1 ? sourceParts[sourceParts.length - 1] : (sourceParts[0] || ''),
      birthDate: normalizeDate(source.birthDate || selectedChild.birthDate),
      age: String(source.age ?? selectedChild.age ?? ''),
      sex: source.sex || selectedChild.gender || 'Male',
      religion: source.religion || '',
      address: source.address || selectedChild.address || '',
      residentSignature: /^data:image\/(png|jpeg|jpg);base64,/i.test(String(source.residentSignature || ''))
        ? source.residentSignature
        : '',
      guardianName: source.guardianName || selectedChild.guardianName || '',
      guardianContact: source.guardianContact || selectedChild.guardianContact || '',
      guardianAddress: source.guardianAddress || '',
      // guardianSignature was always saved as null before this field existed,
      // so this guard is just for safety, matching the referring-party pattern.
      guardianSignature: /^data:image\/(png|jpeg|jpg);base64,/i.test(String(source.guardianSignature || ''))
        ? source.guardianSignature
        : '',
      admissionDate: normalizeDate(source.admissionDate || selectedChild.admissionDate),
      expectedDischargeDate: normalizeDate(source.expectedDischargeDate || ''),
      legalCategory: source.legalCategory || selectedChild.legalCategory || '',
      specificOffense: source.specificOffense || selectedChild.caseType || '',
      caseHistory: source.caseHistory || '',
      /*
       * A stored list, or nothing at all — an admission written before this
       * column existed reads back as null, which is "not recorded" rather than
       * "none found". Rows are rebuilt field by field so a row saved by an
       * older build cannot leave an undefined in a controlled input.
       */
      bodyMarkings: Array.isArray(source.bodyMarkings)
        ? source.bodyMarkings.map((entry: Partial<BodyMarkingEntry>) => ({
            type: entry?.type || '',
            location: entry?.location || '',
            description: entry?.description || '',
          }))
        : [],
      referringParty: source.referringParty || '',
      referringPartyContact: source.referringPartyContact || '',
      // Older records may have this column holding the referring party's
      // typed name rather than a drawn signature (from before this field
      // existed) — only restore it into the pad when it is actually a PNG.
      referringPartySignature: /^data:image\/(png|jpeg|jpg);base64,/i.test(String(source.referringPartySignature || ''))
        ? source.referringPartySignature
        : '',
      houseparentOnDuty: source.houseparentOnDuty || assignment?.userLabel || '',
      houseparentSignature: source.houseparentSignature || '',
      residentImage: source.residentImage || '',
      /*
       * The admission's own id first, because it is what was chosen when this
       * admission was created; the assignment row is the fallback for
       * admissions that predate the column. Preferring the assignment would
       * re-point a historical admission at whoever holds the resident now.
       */
      assignedHouseparentId: source.houseparentUserId || assignment?.userId || '',
    });
    setFormErrors({});
    setFormStep(1);
    setIsFormOpen(true);
  };

  /*
   * The piercing/tattoo rows on the slip.
   *
   * The location is a dropdown and not a text box on purpose: "left chest" and
   * "left side of the chest" are the same finding, and a free-text body part
   * cannot be compared between two admissions. The list is read from the same
   * JSON the API validates against, so the form cannot offer a body part the
   * server would refuse.
   */
  const addBodyMarking = () => {
    setForm((previous) => ({
      ...previous,
      bodyMarkings: [
        ...previous.bodyMarkings,
        { type: '', location: '', description: '' },
      ],
    }));

    setFormErrors((previous) => ({
      ...previous,
      bodyMarkings: '',
    }));
  };

  const updateBodyMarking = (
    index: number,
    patch: Partial<BodyMarkingEntry>
  ) => {
    setForm((previous) => ({
      ...previous,
      bodyMarkings: previous.bodyMarkings.map(
        (entry, entryIndex) =>
          entryIndex === index
            ? { ...entry, ...patch }
            : entry
      ),
    }));

    setFormErrors((previous) => ({
      ...previous,
      bodyMarkings: '',
    }));
  };

  const removeBodyMarking = (index: number) => {
    setForm((previous) => ({
      ...previous,
      bodyMarkings: previous.bodyMarkings.filter(
        (_entry, entryIndex) =>
          entryIndex !== index
      ),
    }));
  };

  const handleUpdateResident = async () => {
    if (!editingId) return;

    const fullName = buildFullName(form);
    if (!fullName) {
      setFormErrors({ name: 'Full name is required.' });
      return;
    }

    // The edit form does not run `validatePartTwo`, so the marking rule is
    // applied here too — otherwise a half-filled row added while editing would
    // be refused by the API instead of by the form that produced it.
    if (unfinishedBodyMarkings(form.bodyMarkings).length > 0) {
      setFormErrors({ bodyMarkings: UNFINISHED_MARKING_MESSAGE });
      return;
    }

    setSavingAdmission(true);
    try {
      await request(`/children/${editingId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: fullName,
          age: Number(form.age) || Number(calculateAge(form.birthDate)),
          gender: form.sex,
          birthDate: form.birthDate || null,
          admissionDate: form.admissionDate || null,
          address: form.address.trim(),
          guardianName: form.guardianName.trim(),
          guardianContact: form.guardianContact.trim(),
          legalCategory: form.legalCategory.trim(),
          caseType: form.specificOffense.trim(),
        }),
      });

      if (existingAdmission?.id) {
        await request(`/admissions/${existingAdmission.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: fullName,
            age: Number(form.age) || Number(calculateAge(form.birthDate)),
            sex: form.sex,
            birthDate: form.birthDate || null,
            religion: form.religion.trim(),
            address: form.address.trim(),
            residentSignature: form.residentSignature || null,
            guardianName: form.guardianName.trim(),
            guardianContact: form.guardianContact.trim(),
            guardianAddress: form.guardianAddress.trim(),
            guardianSignature: form.guardianSignature || null,
            admissionDate: form.admissionDate || null,
            expectedDischargeDate: form.expectedDischargeDate || null,
            legalCategory: form.legalCategory.trim(),
            specificOffense: form.specificOffense.trim(),
            referringParty: form.referringParty.trim(),
            referringPartyContact: form.referringPartyContact.trim(),
            referringPartySignature: form.referringPartySignature || null,
            houseparentOnDuty: form.houseparentOnDuty.trim(),
            houseparentUserId: form.assignedHouseparentId || null,
            houseparentSignature: form.houseparentSignature || null,
            residentImage: form.residentImage || null,
            bodyMarkings: bodyMarkingsForPayload(form.bodyMarkings),
            admissionStatus,
          }),
        });
      }

      // Keep the assignment table synchronized with the HP selected on the slip.
      if (form.assignedHouseparentId && form.assignedHouseparentId !== editingAssignedHouseparentId) {
        if (editingAssignmentId && form.assignedHouseparentId !== '') {
          await request(`/resident-assignments/${editingAssignmentId}/end`, { method: 'POST', body: JSON.stringify({}) });
        }
        if (!editingAssignmentId || form.assignedHouseparentId !== '') {
          await request(`/resident-assignments/resident/${editingId}`, {
            method: 'POST',
            body: JSON.stringify({ userId: form.assignedHouseparentId, assignmentType: 'houseparent', startAt: new Date().toISOString(), source: 'admission-update' }),
          });
        }
      } else if (!form.assignedHouseparentId && editingAssignmentId) {
        await request(`/resident-assignments/${editingAssignmentId}/end`, { method: 'POST', body: JSON.stringify({}) });
      }

      await refreshData();
      setIsFormOpen(false);
      resetForm();
    } catch (error: any) {
      console.error('Failed to update resident/admission:', error);
      void systemDialog.failure('Could not update the resident', describeError(error, 'The resident record was not updated. Please try again.'));
    } finally {
      setSavingAdmission(false);
    }
  };

  const openAdd =
    () => {
      resetForm();

      setIsFormOpen(
        true
      );
    };

  const findExactResident =
    (): any | null => {
      const fullName =
        normalizeName(
          buildFullName(form)
        );

      const birthDate =
        normalizeDate(
          form.birthDate
        );

      if (
        !fullName ||
        !birthDate
      ) {
        return null;
      }

      return (
        children.find(
          (child: any) =>
            normalizeName(
              child.name ||
                ''
            ) ===
              fullName &&
            normalizeDate(
              child.birthDate
            ) ===
              birthDate
        ) ||
        null
      );
    };

  const handleNamePartChange =
    (
      field:
        | 'firstName'
        | 'middleName'
        | 'surname',
      value: string
    ) => {
      const cleaned =
        value.replace(
          /\s+/g,
          ' '
        );

      setForm(
        (previous) => ({
          ...previous,
          [field]:
            cleaned,
        })
      );

      setFormErrors(
        (previous) => ({
          ...previous,
          [field]: '',
        })
      );

      setDuplicateChild(
        null
      );

      setExistingAdmission(
        null
      );

      setExistingAdmissions(
        []
      );

      const nextFullName =
        normalizeName(
          [
            field ===
            'firstName'
              ? cleaned
              : form.firstName,

            field ===
            'middleName'
              ? cleaned
              : form.middleName,

            field ===
            'surname'
              ? cleaned
              : form.surname,
          ]
            .filter(Boolean)
            .join(' ')
        );

      if (
        nextFullName.length <
        2
      ) {
        setNameSuggestions(
          []
        );

        setShowSuggestions(
          false
        );

        return;
      }

      const matches =
        children.filter(
          (child: any) =>
            normalizeName(
              child.name ||
                ''
            ).includes(
              nextFullName
            )
        );

      setNameSuggestions(
        matches
      );

      setShowSuggestions(
        matches.length > 0
      );
    };

  const handleSelectSuggestion =
    (
      child: any
    ) => {
      const parts =
        splitFullName(
          child.name ||
            ''
        );

      setForm(
        (previous) => ({
          ...previous,

          firstName:
            parts.firstName,

          middleName:
            parts.middleName,

          surname:
            parts.surname,

          birthDate:
            previous.birthDate ||
            normalizeDate(
              child.birthDate
            ),

          age:
            previous.birthDate
              ? calculateAge(
                  previous.birthDate
                )
              : child.birthDate
                ? calculateAge(
                    normalizeDate(
                      child.birthDate
                    )
                  )
                : '',
        })
      );

      setShowSuggestions(
        false
      );
    };

  const loadExistingResident =
    async (
      matchedChild: any
    ) => {
      setDuplicateChild(
        matchedChild
      );

      setLoadingExistingAdmission(
        true
      );

      try {
        const [
          latestResponse,
          historyResponse,
        ] =
          await Promise.all([
            request<{
              success: boolean;
              data:
                | AdmissionRecord
                | null;
            }>(
              `/admissions/resident/${matchedChild.id}/latest`
            ),

            request<{
              success: boolean;
              data:
                | AdmissionRecord[]
                | undefined;
            }>(
              `/admissions/resident/${matchedChild.id}`
            ),
          ]);

        const history =
          historyResponse?.data ||
          [];

        const latest =
          latestResponse?.data ||
          history[0] ||
          null;

        setExistingAdmission(
          latest
        );

        setExistingAdmissions(
          history
        );

        setShowExistingAdmission(
          true
        );
      } catch (error) {
        console.error(
          'Failed to load previous admissions:',
          error
        );

        setExistingAdmission(
          null
        );

        setExistingAdmissions(
          []
        );

        setShowExistingAdmission(
          true
        );
      } finally {
        setLoadingExistingAdmission(
          false
        );
      }
    };

  const continueFromPartOne =
    async () => {
      const errors: Record<
        string,
        string
      > = {};

      if (
        !form.firstName.trim()
      ) {
        errors.firstName =
          'First name is required.';
      }

      if (
        !form.surname.trim()
      ) {
        errors.surname =
          'Surname is required.';
      }

      if (!form.birthDate) {
        errors.birthDate =
          'Date of birth is required.';
      }

      if (
        !form.legalCategory.trim()
      ) {
        errors.legalCategory =
          'Legal category is required.';
      }

      if (
        !form.specificOffense.trim()
      ) {
        errors.specificOffense =
          'Specific offense is required.';
      }

      setFormErrors(
        errors
      );

      if (
        Object.keys(errors)
          .length > 0
      ) {
        return;
      }

      const matched =
        findExactResident();

      if (matched) {
        await loadExistingResident(
          matched
        );

        return;
      }

      setFormStep(2);

      setFormErrors(
        {}
      );
    };

  const confirmExistingResident =
    () => {
      if (
        !duplicateChild
      ) {
        return;
      }

      if (
        existingAdmission
      ) {
        const nameParts =
          splitFullName(
            existingAdmission.name
          );

        setForm(
          (previous) => ({
            ...previous,

            firstName:
              nameParts.firstName,

            middleName:
              nameParts.middleName,

            surname:
              nameParts.surname,

            birthDate:
              normalizeDate(
                existingAdmission.birthDate
              ),

            age:
              calculateAge(
                normalizeDate(
                  existingAdmission.birthDate
                )
              ),

            sex:
              existingAdmission.sex ||
              'Male',

            religion:
              existingAdmission.religion ||
              '',

            address:
              existingAdmission.address ||
              '',

            // A new admission needs a fresh signature, the same way
            // guardianSignature resets below.
            residentSignature: '',

            guardianName:
              existingAdmission.guardianName ||
              '',

            guardianContact:
              existingAdmission.guardianContact ||
              '',

            guardianAddress:
              existingAdmission.guardianAddress ||
              '',

            // A new admission needs a fresh signature, the same way
            // referringPartySignature and houseparentSignature reset below.
            guardianSignature: '',

            admissionDate:
              todayYYYYMMDD(),

            legalCategory:
              previous.legalCategory,

            specificOffense:
              previous.specificOffense,

            caseHistory: '',

            /*
             * Deliberately NOT carried over from the previous admission.
             * A marking is recorded as the body was found at *this*
             * admission, so re-sending the last admission's list would
             * assert that a tattoo seen a year ago is still there — and a
             * removed one would stay on record for ever.
             */
            bodyMarkings: [],

            referringParty:
              '',

            referringPartyContact:
              '',

            referringPartySignature:
              '',

            houseparentOnDuty:
              '',

            houseparentSignature:
              '',

            residentImage:
              '',

            assignedHouseparentId:
              '',
          })
        );
      } else {
        const nameParts =
          splitFullName(
            duplicateChild.name ||
              ''
          );

        setForm(
          (previous) => ({
            ...previous,

            firstName:
              nameParts.firstName,

            middleName:
              nameParts.middleName,

            surname:
              nameParts.surname,

            birthDate:
              normalizeDate(
                duplicateChild.birthDate
              ),

            age:
              duplicateChild.birthDate
                ? calculateAge(
                    normalizeDate(
                      duplicateChild.birthDate
                    )
                  )
                : '',

            sex:
              duplicateChild.gender ||
              'Male',

            religion:
              duplicateChild.religion ||
              '',

            address:
              duplicateChild.address ||
              '',

            // A new admission needs a fresh signature, the same way
            // guardianSignature resets below.
            residentSignature: '',

            guardianName:
              duplicateChild.guardianName ||
              '',

            guardianContact:
              duplicateChild.guardianContact ||
              '',

            guardianAddress:
              duplicateChild.guardianAddress ||
              '',

            // A new admission needs a fresh signature, the same way
            // referringPartySignature and houseparentSignature reset below.
            guardianSignature: '',

            admissionDate:
              todayYYYYMMDD(),

            legalCategory:
              previous.legalCategory,

            specificOffense:
              previous.specificOffense,

            caseHistory: '',

            /*
             * Deliberately NOT carried over from the previous admission.
             * A marking is recorded as the body was found at *this*
             * admission, so re-sending the last admission's list would
             * assert that a tattoo seen a year ago is still there — and a
             * removed one would stay on record for ever.
             */
            bodyMarkings: [],

            referringParty:
              '',

            referringPartyContact:
              '',

            referringPartySignature:
              '',

            houseparentOnDuty:
              '',

            houseparentSignature:
              '',

            residentImage:
              '',

            assignedHouseparentId:
              '',
          })
        );
      }

      setShowExistingAdmission(
        false
      );

      setFormErrors(
        {}
      );

      setFormStep(2);
    };

  const validatePartTwo =
    () => {
      const errors: Record<
        string,
        string
      > = {};

      if (!form.admissionDate) {
        errors.admissionDate =
          'Admission date is required.';
      }

      if (form.expectedDischargeDate && form.admissionDate && form.expectedDischargeDate < form.admissionDate) {
        errors.expectedDischargeDate =
          'Expected discharge date cannot be before the admission date.';
      }

      if (!form.sex) {
        errors.sex =
          'Sex is required.';
      }

      if (
        !form.religion.trim()
      ) {
        errors.religion =
          'Religion is required.';
      }

      if (
        !form.address.trim()
      ) {
        errors.address =
          'Complete address is required.';
      }

      // The guardian is optional — the Social Worker may be admitting a resident
      // whose guardian has not been traced yet, or who has none. Only the format
      // of a contact number that was actually supplied is checked, so a blank
      // field is accepted and a malformed one is still caught here rather than by
      // the API.
      if (
        form.guardianContact.trim() &&
        !/^\d{11}$/.test(
          form.guardianContact
        )
      ) {
        errors.guardianContact =
          'Guardian contact must contain exactly 11 digits.';
      }

      if (
        !form.referringParty.trim()
      ) {
        errors.referringParty =
          'Referring party is required.';
      }

      if (
        !form.referringPartyContact.trim()
      ) {
        errors.referringPartyContact =
          'Referring party contact is required.';
      } else if (
        !/^\d{11}$/.test(
          form.referringPartyContact
        )
      ) {
        errors.referringPartyContact =
          'Referring party contact must contain exactly 11 digits.';
      }

      if (
        !form.houseparentOnDuty.trim()
      ) {
        errors.houseparentOnDuty =
          'Houseparent on duty is required.';
      }

      // A marking is a type *plus* a body part. A row that was never touched is
      // simply dropped, but one carrying only half of the pair is an unfinished
      // entry — caught here rather than by the API, which would refuse the whole
      // slip after every other field had been filled in.
      if (
        unfinishedBodyMarkings(
          form.bodyMarkings
        ).length > 0
      ) {
        errors.bodyMarkings =
          UNFINISHED_MARKING_MESSAGE;
      }

      setFormErrors(
        errors
      );

      return (
        Object.keys(errors)
          .length === 0
      );
    };

  const buildSlipData =
    (): AdmissionRecord => {
      const fullName =
        buildFullName(form);

      return {
        id: '',

        residentId:
          duplicateChild?.id ||
          '',

        admissionNumber:
          0,

        admissionDate:
          form.admissionDate,

        expectedDischargeDate:
          form.expectedDischargeDate || null,

        name:
          fullName,

        age:
          Number(
            form.age
          ) ||
          Number(
            calculateAge(
              form.birthDate
            )
          ),

        sex:
          form.sex as Gender,

        birthDate:
          form.birthDate,

        religion:
          form.religion,

        address:
          form.address,

        residentSignature:
          form.residentSignature ||
          null,

        residentImage:
          form.residentImage ||
          null,

        guardianName:
          form.guardianName,

        guardianContact:
          form.guardianContact,

        guardianAddress:
          form.guardianAddress,

        guardianSignature:
          form.guardianSignature ||
          null,

        referringParty:
          form.referringParty,

        referringPartyContact:
          form.referringPartyContact,

        referringPartySignature:
          form.referringPartySignature ||
          null,

        houseparentOnDuty:
          form.houseparentOnDuty,

        /*
         * The stable users.id behind the printed name above. The
         * name is what the slip shows; this is what links the
         * resident to a Houseparent's caseload, so renaming a
         * member of staff does not silently move their residents.
         */
        houseparentUserId:
          form.assignedHouseparentId ||
          null,

        houseparentSignature:
          form.houseparentSignature ||
          null,

        legalCategory:
          form.legalCategory,

        specificOffense:
          form.specificOffense,

        caseHistory: '',

        bodyMarkings:
          bodyMarkingsForPayload(
            form.bodyMarkings
          ),

        admissionStatus,
      };
    };

  /* ==============================================================
     PDF WRAPPING
     ============================================================== */

  const wrapText =
    (
      text: string,
      font: any,
      size: number,
      maxWidth: number,
      maxLines = 2
    ): string[] => {
      const normalized =
        String(
          text || ''
        )
          .replace(
            /\r\n/g,
            '\n'
          )
          .trim();

      if (!normalized) {
        return [];
      }

      const explicitLines =
        normalized.split(
          '\n'
        );

      const lines: string[] =
        [];

      for (
        const explicitLine of explicitLines
      ) {
        const words =
          explicitLine
            .split(/\s+/)
            .filter(Boolean);

        if (
          words.length === 0
        ) {
          lines.push('');
          continue;
        }

        let current =
          '';

        for (
          const word of words
        ) {
          const candidate =
            current
              ? `${current} ${word}`
              : word;

          if (
            font.widthOfTextAtSize(
              candidate,
              size
            ) <=
            maxWidth
          ) {
            current =
              candidate;

            continue;
          }

          if (current) {
            lines.push(
              current
            );
          }

          current =
            word;
        }

        if (current) {
          lines.push(
            current
          );
        }
      }

      return lines.slice(
        0,
        maxLines
      );
    };

  /* ==============================================================
     FINAL PDF
     ============================================================== */

  const generateAdmissionSlipPdf =
    async (
      admission: AdmissionRecord
    ): Promise<Blob> => {
      const response =
        await fetch(
          '/forms/admission-slip.pdf'
        );

      if (!response.ok) {
        throw new Error(
          'Admission Slip PDF could not be loaded. Make sure admission-slip.pdf is in frontend/public/forms/.'
        );
      }

      const originalPdfBytes =
        await response.arrayBuffer();

      const pdfDoc =
        await PDFDocument.load(
          originalPdfBytes
        );

      const page =
        pdfDoc.getPage(0);

      const font =
        await pdfDoc.embedFont(
          StandardFonts.Helvetica
        );

      const drawText = (
        text:
          | string
          | number
          | null
          | undefined,
        x: number,
        y: number,
        size =
          PRINT_FONT_SIZE,
        maxWidth?: number
      ) => {
        let value =
          String(
            text ?? ''
          ).trim();

        if (!value) {
          return;
        }

        if (maxWidth) {
          while (
            value.length >
              1 &&
            font.widthOfTextAtSize(
              value,
              size
            ) >
              maxWidth
          ) {
            value =
              value.slice(
                0,
                -1
              );
          }
        }

        page.drawText(
          value,
          {
            x,
            y,
            size,
            font,
            color:
              rgb(
                0,
                0,
                0
              ),
          }
        );
      };

      const drawWrappedText =
        (
          text: string,
          x: number,
          y: number,
          size =
            PRINT_FONT_SIZE,
          maxWidth: number,
          lineHeight =
            PRINT_LINE_HEIGHT,
          maxLines = 2
        ) => {
          const lines =
            wrapText(
              text,
              font,
              size,
              maxWidth,
              maxLines
            );

          lines.forEach(
            (
              line,
              index
            ) => {
              if (!line) {
                return;
              }

              page.drawText(
                line,
                {
                  x,
                  y:
                    y -
                    index *
                      lineHeight,
                  size,
                  font,
                  color:
                    rgb(
                      0,
                      0,
                      0
                    ),
                }
              );
            }
          );
        };

      /* ==========================================================
         RESIDENT INFORMATION
         ========================================================== */

      drawText(
        formatSlipDate(
          admission.admissionDate
        ),
        183.105,
        383.72,
        PRINT_FONT_SIZE,
        215
      );

      drawText(
        admission.name,
        178.501,
        359.13,
        PRINT_FONT_SIZE,
        215
      );

      drawText(
        admission.age,
        107.601,
        344.33,
        PRINT_FONT_SIZE,
        29
      );

      drawText(
        admission.sex,
        162.753,
        344.33,
        PRINT_FONT_SIZE,
        34
      );

      drawText(
        formatSlipDate(
          admission.birthDate
        ),
        269.433,
        344.33,
        PRINT_FONT_SIZE,
        126
      );

      drawText(
        admission.religion,
        442.796,
        344.33,
        PRINT_FONT_SIZE,
        96
      );

      /*
       * Resident address:
       * bigger, higher and wrapped to two lines.
       */
      drawWrappedText(
        admission.address,
        177.909,
        319.70,
        PRINT_FONT_SIZE,
        238,
        PRINT_LINE_HEIGHT,
        2
      );

      /*
       * The resident's drawn signature, stamped into the blank rule right
       * after "Signature of Resident:", the same band the on-screen pad
       * shows it in.
       */
      await drawSignatureImage(
        pdfDoc,
        admission.residentSignature,
        toPdfBox(
          ADMISSION_RESIDENT_SIGNATURE_BOX,
          PDF_HEIGHT
        )
      );

      /* ==========================================================
         GUARDIAN
         ========================================================== */

      drawText(
        admission.guardianName,
        178.281,
        270.50,
        PRINT_FONT_SIZE,
        215
      );

      drawText(
        admission.guardianContact,
        456.201,
        270.50,
        PRINT_FONT_SIZE,
        244
      );

      drawWrappedText(
        admission.guardianAddress,
        177.96,
        245.67,
        PRINT_FONT_SIZE,
        238,
        PRINT_LINE_HEIGHT,
        2
      );

      /*
       * The guardian's drawn signature, stamped into the blank rule right
       * after "Signature of Guardian:", the same band the on-screen pad
       * shows it in.
       */
      await drawSignatureImage(
        pdfDoc,
        admission.guardianSignature,
        toPdfBox(
          ADMISSION_GUARDIAN_SIGNATURE_BOX,
          PDF_HEIGHT
        )
      );

      /* ==========================================================
         REFERRING PARTY
         ========================================================== */

      drawText(
        admission.referringParty,
        80.425,
        196.48,
        PRINT_FONT_SIZE,
        208
      );

      drawText(
        admission.referringPartyContact,
        352.345,
        196.48,
        PRINT_FONT_SIZE,
        245
      );

      /*
       * The referring party's drawn signature, stamped into the same blank
       * band the on-screen pad shows it in, on the "Referring Party:" line.
       */
      await drawSignatureImage(
        pdfDoc,
        admission.referringPartySignature,
        toPdfBox(
          ADMISSION_REFERRING_PARTY_SIGNATURE_BOX,
          PDF_HEIGHT
        )
      );

      /* ==========================================================
         HOUSEPARENT
         ========================================================== */

      /*
       * The printed name sits on the signature line; the Houseparent's drawn
       * signature is stamped into the blank band directly above it, which is
       * exactly where the on-screen pad sits ("signature over printed name").
       */
      drawText(
        admission.houseparentOnDuty,
        80.025,
        139.45,
        PRINT_FONT_SIZE,
        215
      );

      await drawSignatureImage(
        pdfDoc,
        admission.houseparentSignature,
        toPdfBox(
          ADMISSION_HOUSEPARENT_SIGNATURE_BOX,
          PDF_HEIGHT
        )
      );

      /* ==========================================================
         PIERCINGS / TATTOOS
         ========================================================== */

      /*
       * Printed into the free band between the Houseparent block and the
       * Attested-by row, because the template has no body-marking area of its
       * own. Nothing is drawn when nothing is on record, so a slip for a
       * resident with no markings is byte-for-byte what it was before.
       *
       * The drawing lives in `admissionSlipMarkings.ts` rather than here: the
       * slip a user opens from a resident's own page is drawn by a second writer
       * in ChildDetail.tsx, and a block added to one of them only prints on the
       * slips that writer produces.
       */
      drawBodyMarkingsOnSlip(
        page,
        font,
        admission.bodyMarkings
      );

      /* ==========================================================
         RESIDENT PHOTO
         ========================================================== */

      if (
        admission.residentImage
      ) {
        const dataUrl =
          admission.residentImage;

        const isPng =
          /^data:image\/png;base64,/i.test(
            dataUrl
          );

        const isJpeg =
          /^data:image\/(?:jpeg|jpg);base64,/i.test(
            dataUrl
          );

        if (
          isPng ||
          isJpeg
        ) {
          try {
            const image =
              isPng
                ? await pdfDoc.embedPng(
                    dataUrl
                  )
                : await pdfDoc.embedJpg(
                    dataUrl
                  );

            const boxX =
              704.45;

            const boxY =
              383.05;

            const boxWidth =
              158.95;

            const boxHeight =
              125.3;

            const scale =
              Math.min(
                boxWidth /
                  image.width,
                boxHeight /
                  image.height
              );

            const width =
              image.width *
              scale;

            const height =
              image.height *
              scale;

            const x =
              boxX +
              (
                boxWidth -
                width
              ) /
                2;

            const y =
              boxY +
              (
                boxHeight -
                height
              ) /
                2;

            page.drawImage(
              image,
              {
                x,
                y,
                width,
                height,
              }
            );
          } catch (
            error
          ) {
            console.error(
              'Failed to embed resident photo:',
              error
            );
          }
        }
      }

      /*
       * Legal Category and Specific Offense are
       * system/database fields and are not printed
       * because they are not physical fields on
       * the official Admission Slip.
       */

      const bytes =
        await pdfDoc.save();

      /*
       * Safe ArrayBuffer for Blob/TypeScript.
       */
      const safeBytes =
        new Uint8Array(
          bytes.byteLength
        );

      safeBytes.set(
        bytes
      );

      return new Blob(
        [safeBytes.buffer],
        {
          type:
            'application/pdf',
        }
      );
    };

  /* ==============================================================
     PRINT
     ============================================================== */

  const openAdmissionPdf =
    async (
      admission: AdmissionRecord,
      print = false
    ) => {
      const popup =
        window.open(
          '',
          '_blank',
          'width=1200,height=900'
        );

      if (!popup) {
        void systemDialog.failure(
          'Could not open the Admission Slip',
          'Your browser blocked the new window. Allow pop-ups for this site, then try again.'
        );

        return;
      }

      try {
        popup.document.write(
          `
            <html>
              <head>
                <title>Admission Slip</title>
              </head>

              <body
                style="
                  margin:0;
                  background:#f3f4f6;
                  display:flex;
                  justify-content:center;
                  align-items:flex-start;
                "
              >
                Preparing Admission Slip...
              </body>
            </html>
          `
        );

        popup.document.close();

        const blob =
          await generateAdmissionSlipPdf(
            admission
          );

        const url =
          URL.createObjectURL(
            blob
          );

        popup.location.href =
          url;

        if (print) {
          setTimeout(
            () => {
              try {
                popup.focus();
                popup.print();
              } catch (
                error
              ) {
                console.error(
                  'Print failed:',
                  error
                );
              }
            },
            1200
          );
        }

        setTimeout(
          () => {
            URL.revokeObjectURL(
              url
            );
          },
          60000
        );
      } catch (error) {
        console.error(
          'Failed to generate Admission Slip:',
          error
        );

        try {
          popup.close();
        } catch {
          // Ignore popup-close failures.
        }

        void systemDialog.failure(
          'Could not generate the Admission Slip',
          describeError(error, 'The PDF could not be built. Please try again.')
        );
      }
    };

  const handlePrintCurrentSlip =
    async () => {
      if (
        !validatePartTwo()
      ) {
        return;
      }

      try {
        await openAdmissionPdf(
          buildSlipData(),
          true
        );
      } catch (error) {
        console.error(
          'Unable to print current Admission Slip:',
          error
        );

        void systemDialog.failure(
          'Could not print the Admission Slip',
          describeError(error, 'The slip could not be printed. Please try again.')
        );
      }
    };

  /* ==============================================================
     SAVE
     ============================================================== */

  const handleSave =
    async () => {
      if (
        !validatePartTwo()
      ) {
        return;
      }

      const fullName =
        buildFullName(form);

      if (!fullName) {
        void systemDialog.validation('The resident name is required', {
          description: 'The admission cannot be saved without it.',
        });

        setFormStep(1);

        return;
      }

      setSavingAdmission(
        true
      );

      try {
        const payload = {
          residentId:
            duplicateChild?.id ||
            undefined,

          resident: {
            name:
              fullName,

            age:
              Number(
                form.age
              ) ||
              Number(
                calculateAge(
                  form.birthDate
                )
              ),

            sex:
              form.sex,

            religion:
              form.religion.trim(),

            birthDate:
              form.birthDate,

            address:
              form.address.trim(),

            guardianName:
              form.guardianName.trim(),

            guardianContact:
              form.guardianContact.trim(),

            guardianAddress:
              form.guardianAddress.trim(),
          },

          admission: {
            admissionDate:
              form.admissionDate,

            expectedDischargeDate:
              form.expectedDischargeDate || null,

            legalCategory:
              form.legalCategory.trim(),

            specificOffense:
              form.specificOffense.trim(),

            caseHistory: '',

            bodyMarkings:
              bodyMarkingsForPayload(
                form.bodyMarkings
              ),

            admissionStatus,

            residentSignature:
              form.residentSignature ||
              null,

            residentImage:
              form.residentImage ||
              null,

            guardianSignature:
              form.guardianSignature ||
              null,

            referringParty:
              form.referringParty.trim(),

            referringPartyContact:
              form.referringPartyContact.trim(),

            referringPartySignature:
              form.referringPartySignature ||
              null,

            houseparentOnDuty:
              form.houseparentOnDuty.trim(),

            houseparentUserId:
              form.assignedHouseparentId ||
              null,

            houseparentSignature:
              form.houseparentSignature ||
              null,
          },
        };

        const response =
          await request<{
            success: boolean;
            data?: {
              resident: any;
              admission:
                AdmissionRecord;
            };
          }>(
            '/admissions',
            {
              method:
                'POST',

              body:
                JSON.stringify(
                  payload
                ),
            }
          );

        if (
          !response?.success ||
          !response.data?.resident ||
          !response.data?.admission
        ) {
          throw new Error(
            'The admission could not be created.'
          );
        }

        /*
         * Save the exact official Admission Slip PDF into the resident's
         * Documents folder immediately after the admission is created.
         * This uses the same PDF generator as the Print/Preview action, so
         * the saved document matches the official slip.
         */
        try {
          const admissionPdf = await generateAdmissionSlipPdf(response.data.admission);
          const admissionPdfData = await blobToDataUrl(admissionPdf);
          const residentName = response.data.resident.name || fullName;

          await request('/documents', {
            method: 'POST',
            body: JSON.stringify({
              residentId: response.data.resident.id,
              residentName,
              title: 'Admission Slip',
              type: 'Admission Slip',
              category: 'Admission',
              description: `Official Admission Slip for ${residentName}.`,
              phase: 'Admission Phase',
              fileName: `Admission Slip - ${residentName}.pdf`,
              fileSize: admissionPdf.size,
              fileData: admissionPdfData,
              fileType: 'application/pdf',
              status: 'Submitted',
              uploaderRole: user?.role || 'System',
              uploadedBy: user?.username || 'System',
              uploadedAt: new Date().toISOString(),
              submittedBy: user?.username || 'System',
            }),
          });
        } catch (documentError) {
          console.error('Admission was saved, but the Admission Slip could not be added to Documents:', documentError);
          void systemDialog.notify({
            title: 'Admission saved, but the slip was not filed',
            description: 'The admission itself is stored. The Admission Slip could not be saved into the child\'s Documents folder, so file it there from the Documents module.',
            tone: 'warning',
          });
        }

        /*
         * Keep assignment in the existing
         * resident assignment system.
         */
        if (
          form.assignedHouseparentId
        ) {
          try {
            await request(
              `/resident-assignments/resident/${response.data.resident.id}`,
              {
                method:
                  'POST',

                body:
                  JSON.stringify({
                    userId:
                      form.assignedHouseparentId,

                    assignmentType:
                      'houseparent',

                    startAt:
                      new Date().toISOString(),

                    source:
                      'admission',
                  }),
              }
            );
          } catch (
            assignmentError
          ) {
            console.error(
              'Houseparent assignment failed:',
              assignmentError
            );
          }
        }

        await refreshData();

        setIsFormOpen(
          false
        );

        resetForm();

        navigate(
          `/children/${response.data.resident.id}`
        );
      } catch (
        error: any
      ) {
        console.error(
          'Failed to save admission:',
          error
        );

        void systemDialog.failure(
          'Could not save the admission',
          describeError(error, 'The admission was not saved. Please try again.')
        );
      } finally {
        setSavingAdmission(
          false
        );
      }
    };

  /* ==============================================================
     DELETE
     ============================================================== */

  const handleDelete =
    (
      childId: string
    ) => {
      setChildToDelete(
        childId
      );
    };

  /* ==============================================================
     LIST
     ============================================================== */

  const filteredChildren =
    children.filter(
      (child: any) => {
        const query =
          searchTerm.toLowerCase();

        const matchesSearch =
          (
            child.name ||
            ''
          )
            .toLowerCase()
            .includes(query) ||
          (
            child.id ||
            ''
          )
            .toLowerCase()
            .includes(query);

        const matchesStatus =
          statusFilter ===
            'All' ||
          (
            statusFilter ===
              'Active' &&
            child.status !==
              'Discharged' &&
            child.status !==
              'Absconded'
          ) ||
          (
            statusFilter ===
              'Discharged' &&
            child.status ===
              'Discharged'
          ) ||
          (
            statusFilter ===
              'Absconded' &&
            child.status ===
              'Absconded'
          );

        return (
          matchesSearch &&
          matchesStatus
        );
      }
    );

  const activeCount =
    children.filter(
      (child: any) =>
        child.status !==
        'Discharged' &&
        child.status !==
        'Absconded'
    ).length;

  // Residents marked Absconded (from the Abscond button in Personal Info).
  const abscondedCount =
    children.filter(
      (child: any) =>
        child.status ===
        'Absconded'
    ).length;

  const dischargedCount =
    children.filter(
      (child: any) =>
        child.status ===
        'Discharged'
    ).length;

  const exactResident =
    findExactResident();

  /**
   * A returning admission is one being opened against a resident the system
   * already knows. Editing an existing slip keeps whatever it was classified as,
   * so re-saving the form cannot silently reclassify a Relapse as an Abscon.
   */
  const isReturningAdmission = Boolean(
    !editingId && (duplicateChild || exactResident)
  );

  // A resident who is currently Absconded is definitively "Returning Resident
  // (Abscon/Tumakas)" — there is no ambiguity to ask the Social Worker to
  // resolve here, unlike an ordinary returning admission. The backend enforces
  // this regardless of what is submitted; this keeps the form's own display
  // from suggesting a choice ("Relapse") that would not actually be saved.
  const isReturningFromAbscond = Boolean(
    isReturningAdmission &&
      (duplicateChild || exactResident)?.status === 'Absconded'
  );

  const admissionStatus = editingId
    ? existingAdmission?.admissionStatus || 'New'
    : isReturningAdmission
      ? (isReturningFromAbscond
        ? 'Returning Resident (Abscon/Tumakas)'
        : returningAdmissionStatus)
      : 'New';

  return (
    <div className="space-y-6 p-4">

      {/* ==========================================================
          HEADER
          ========================================================== */}

      <div className="flex justify-between items-center">

        <div>
          <h2 className="text-2xl font-bold tracking-tight text-[#2F3E46]">
            Child Records
          </h2>

          <p className="text-sm text-gray-500">
            Manage CICL beneficiaries
          </p>
        </div>

        {!isFormOpen && can('Child Records', 'create') && (
        <Button
          style={{
            backgroundColor:
              '#FFD100',
            color:
              '#2F3E46',
          }}
          className="hover:opacity-90 font-bold shadow-sm rounded-lg"
          onClick={
            openAdd
          }
        >
          <Plus
            className="w-4 h-4 mr-2"
          />

          Add Child
        </Button>
        )}

      </div>

      {/* ==========================================================
          ADMISSION FORM
          ========================================================== */}

      {isFormOpen && (
        <Card
          className="border-2 shadow-lg"
          style={{
            borderColor:
              '#2F3E46',
          }}
        >
          <CardContent className="p-6">

            {/* WORKFLOW */}
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-6">

              <div>
                <h3 className="text-lg font-bold text-[#2F3E46]">
                  {editingId ? 'Edit Resident' : 'New Admission'}
                </h3>

                <p className="text-sm text-gray-500">
                  {formStep === 1
                    ? 'Part 1 — Resident Admission Details'
                    : 'Part 2 — Official Admission Slip'}
                </p>
              </div>

              <div className="flex items-center gap-2">

                <Badge
                  className={
                    formStep === 1
                      ? 'bg-[#2F3E46] text-white'
                      : 'bg-gray-100 text-gray-500'
                  }
                >
                  1. Admission Details
                </Badge>

                <Badge
                  role={editingId ? 'button' : undefined}
                  tabIndex={editingId ? 0 : undefined}
                  onClick={editingId ? () => setFormStep(2) : undefined}
                  onKeyDown={editingId ? (event) => { if (event.key === 'Enter' || event.key === ' ') setFormStep(2); } : undefined}
                  className={`${formStep === 2 ? 'bg-[#2F3E46] text-white' : 'bg-gray-100 text-gray-500'} ${editingId ? 'cursor-pointer hover:opacity-90' : ''}`}
                >
                  2. Admission Slip
                </Badge>

              </div>
            </div>

            {/* ====================================================
                PART 1
                ==================================================== */}

            {formStep ===
              1 && (
              <div className="space-y-6">

                <div className="rounded-2xl border bg-white p-6">

                  <div className="flex items-center gap-3 mb-6">

                    <div className="p-2 rounded-xl bg-[#FFD100]/20">
                      <User
                        className="w-5 h-5 text-[#2F3E46]"
                      />
                    </div>

                    <div>
                      <h4 className="font-bold text-[#2F3E46]">
                        Resident Identification
                      </h4>

                      <p className="text-xs text-gray-500">
                        Enter the resident's
                        name and date of birth.
                      </p>
                    </div>

                  </div>

                  <div className="grid gap-5 md:grid-cols-3">

                    <div className="space-y-2">

                      <Label className="font-bold text-[#2F3E46]">
                        First Name *
                      </Label>

                      <Input
                        value={
                          form.firstName
                        }
                        onChange={(event) =>
                          handleNamePartChange(
                            'firstName',
                            event.target
                              .value
                          )
                        }
                        placeholder="First name"
                        className="rounded-xl"
                        autoComplete="off"
                      />

                      {formErrors.firstName && (
                        <p className="text-xs text-red-600">
                          {
                            formErrors.firstName
                          }
                        </p>
                      )}

                    </div>

                    <div className="space-y-2">

                      <Label className="font-bold text-[#2F3E46]">
                        Middle Name
                      </Label>

                      <Input
                        value={
                          form.middleName
                        }
                        onChange={(event) =>
                          handleNamePartChange(
                            'middleName',
                            event.target
                              .value
                          )
                        }
                        placeholder="Middle name"
                        className="rounded-xl"
                        autoComplete="off"
                      />

                    </div>

                    <div className="space-y-2">

                      <Label className="font-bold text-[#2F3E46]">
                        Surname *
                      </Label>

                      <Input
                        value={
                          form.surname
                        }
                        onChange={(event) =>
                          handleNamePartChange(
                            'surname',
                            event.target
                              .value
                          )
                        }
                        placeholder="Surname"
                        className="rounded-xl"
                        autoComplete="off"
                      />

                      {formErrors.surname && (
                        <p className="text-xs text-red-600">
                          {
                            formErrors.surname
                          }
                        </p>
                      )}

                    </div>

                  </div>

                  {/* SUGGESTIONS */}
                  {showSuggestions &&
                    nameSuggestions.length >
                      0 && (
                      <div className="relative z-30 mt-2">

                        <div className="bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">

                          <p className="text-[10px] text-gray-400 px-3 pt-2 pb-1 uppercase font-bold tracking-wider">
                            Existing Records
                          </p>

                          {nameSuggestions
                            .slice(
                              0,
                              8
                            )
                            .map(
                              (
                                child: any
                              ) => (
                                <button
                                  key={
                                    child.id
                                  }
                                  type="button"
                                  onMouseDown={() =>
                                    handleSelectSuggestion(
                                      child
                                    )
                                  }
                                  className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3 border-t border-gray-100"
                                >

                                  <div className="p-2 bg-orange-100 rounded-lg">
                                    <History
                                      className="w-4 h-4 text-orange-500"
                                    />
                                  </div>

                                  <div className="flex-1 min-w-0">

                                    <p className="text-sm font-semibold text-gray-800 truncate">
                                      {
                                        child.name
                                      }
                                    </p>

                                    <p className="text-xs text-gray-400">
                                      {
                                        child.id
                                      }
                                      {' · '}
                                      DOB:{' '}
                                      {formatPHDate(
                                        child.birthDate
                                      )}
                                    </p>

                                  </div>

                                  <span className="text-[10px] text-orange-500 font-semibold">
                                    Select
                                  </span>

                                </button>
                              )
                            )}

                        </div>
                      </div>
                    )}

                  <div className="mt-5 max-w-md space-y-2">

                    <Label className="font-bold text-[#2F3E46]">
                      Date of Birth *
                    </Label>

                    <Input
                      type="text"
                      inputMode="numeric"
                      placeholder="MM/DD/YYYY"
                      value={birthDateDisplay}
                      maxLength={10}
                      onChange={(event) => {
                        const displayValue =
                          formatDateWhileTyping(
                            event.target.value
                          );

                        setBirthDateDisplay(
                          displayValue
                        );

                        const birthDate =
                          parseMDYDate(
                            displayValue
                          );

                        setForm(
                          (
                            previous
                          ) => ({
                            ...previous,
                            birthDate,
                            age: birthDate
                              ? calculateAge(
                                  birthDate
                                )
                              : '',
                          })
                        );

                        setFormErrors(
                          (
                            previous
                          ) => ({
                            ...previous,
                            birthDate:
                              '',
                          })
                        );

                        setDuplicateChild(
                          null
                        );
                      }}
                      className="rounded-xl"
                    />

                    <p className="text-xs text-gray-400">
                      Enter as MM/DD/YYYY.
                    </p>

                    {formErrors.birthDate && (
                      <p className="text-xs text-red-600">
                        {
                          formErrors.birthDate
                        }
                      </p>
                    )}

                  </div>
                </div>

                {/* CLASSIFICATION */}
                <div className="rounded-2xl border bg-white p-6">

                  <div className="flex items-center gap-3 mb-6">

                    <div className="p-2 rounded-xl bg-[#FFD100]/20">
                      <FileText
                        className="w-5 h-5 text-[#2F3E46]"
                      />
                    </div>

                    <div>
                      <h4 className="font-bold text-[#2F3E46]">
                        Admission Classification
                      </h4>

                      <p className="text-xs text-gray-500">
                        These values belong to
                        this admission.
                      </p>
                    </div>

                  </div>

                  <div className="grid gap-5 md:grid-cols-2">

                    <div className="space-y-2">

                      <Label className="font-bold text-[#2F3E46]">
                        Legal Category *
                      </Label>

                      <Select
                        value={
                          form.legalCategory ||
                          undefined
                        }
                        onValueChange={(
                          value
                        ) => {

                          setForm(
                            (
                              previous
                            ) => ({
                              ...previous,
                              legalCategory:
                                value,
                            })
                          );

                          setFormErrors(
                            (
                              previous
                            ) => ({
                              ...previous,
                              legalCategory:
                                '',
                            })
                          );
                        }}
                      >
                        <SelectTrigger className="rounded-xl">
                          <SelectValue placeholder="Select category" />
                        </SelectTrigger>

                        <SelectContent>

                          <SelectItem value="IPP">
                            IPP
                          </SelectItem>

                          <SelectItem value="Court Diversion">
                            Court Diversion
                          </SelectItem>

                          <SelectItem value="LCSWD Diversion">
                            LCSWD Diversion
                          </SelectItem>

                          <SelectItem value="OCP Diversion">
                            OCP Diversion
                          </SelectItem>

                          <SelectItem value="Ongoing Court Trial">
                            Ongoing Court Trial
                          </SelectItem>

                        </SelectContent>
                      </Select>

                      {formErrors.legalCategory && (
                        <p className="text-xs text-red-600">
                          {
                            formErrors.legalCategory
                          }
                        </p>
                      )}

                    </div>

                    <div className="space-y-2">

                      <Label className="font-bold text-[#2F3E46]">
                        Specific Offense *
                      </Label>

                      <Input
                        value={
                          form.specificOffense
                        }
                        onChange={(event) =>
                          setForm(
                            (
                              previous
                            ) => ({
                              ...previous,
                              specificOffense:
                                event.target
                                  .value,
                            })
                          )
                        }
                        placeholder="Specific offense"
                        className="rounded-xl"
                      />

                      {formErrors.specificOffense && (
                        <p className="text-xs text-red-600">
                          {
                            formErrors.specificOffense
                          }
                        </p>
                      )}

                    </div>

                  </div>
                </div>

                {/* ADMISSION STATUS */}
                <div className="rounded-2xl border-2 border-[#2F3E46]/10 bg-[#f8f9fa] p-5">

                  <div className="flex items-center justify-between gap-4">

                    <div className="min-w-0">

                      <p className="text-xs uppercase tracking-wider font-bold text-gray-400">
                        Admission Status
                      </p>

                      <p className="mt-1 font-bold text-[#2F3E46]">
                        {
                          admissionStatus
                        }
                      </p>

                      <p className="text-xs text-gray-500 mt-1">
                        {isReturningFromAbscond
                          ? 'This resident absconded from a previous admission. This new admission is automatically classified as Returning Resident (Abscon/Tumakas).'
                          : isReturningAdmission
                            ? 'This resident already has an admission on record. Choose how this one is classified.'
                            : editingId
                              ? 'Kept from the admission on record.'
                              : 'First admission for this resident.'}
                      </p>

                    </div>

                    <Badge
                      className={
                        admissionStatus === 'New'
                          ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100'
                          : 'bg-blue-100 text-blue-700 hover:bg-blue-100'
                      }
                    >
                      {admissionStatus === 'New' ? (
                        <CheckCircle2
                          size={13}
                          className="mr-1"
                        />
                      ) : (
                        <History
                          size={13}
                          className="mr-1"
                        />
                      )}

                      {
                        admissionStatus
                      }

                    </Badge>

                  </div>

                  {/* Only a returning admission has a choice to make: the two
                      returning classifications are indistinguishable from the
                      data, so one of them has to be picked by hand. A resident
                      returning from Abscond is not ambiguous — the record
                      already says why they left — so no picker is shown and
                      nothing here can override the forced classification. */}
                  {isReturningAdmission && !isReturningFromAbscond && (
                    <div className="mt-4 space-y-2">
                      <p className="text-xs font-semibold text-gray-500">
                        Classify this admission
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {([
                          'Returning Resident (Abscon/Tumakas)',
                          'Relapse',
                        ] as const).map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => setReturningAdmissionStatus(option)}
                            aria-pressed={returningAdmissionStatus === option}
                            className={[
                              'rounded-xl border px-3 py-2 text-left text-xs font-semibold transition-colors',
                              returningAdmissionStatus === option
                                ? 'border-[#2F3E46] bg-[#2F3E46] text-white'
                                : 'border-gray-300 bg-white text-[#2F3E46] hover:border-[#2F3E46]',
                            ].join(' ')}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* ACTIONS */}
                <div className="flex justify-end gap-2">

                  <Button
                    variant="ghost"
                    onClick={() => {
                      setIsFormOpen(
                        false
                      );

                      resetForm();
                    }}
                    className="rounded-xl"
                  >
                    Cancel
                  </Button>

                  <Button
                    variant="outline"
                    className="rounded-xl px-4 font-normal"
                    onClick={() => editingId ? setFormStep(2) : continueFromPartOne()}
                  >
                    {editingId ? 'Go to Part 2' : 'Continue to Admission Slip'}
                    <ArrowRight size={16} className="ml-2" />
                  </Button>

                </div>

              </div>
            )}

            {/* ====================================================
                PART 2
                ==================================================== */}

            {formStep ===
              2 && (
              <div className="space-y-6">

                <AdmissionSlipEditor
                  form={
                    form
                  }
                  setForm={
                    setForm
                  }
                  formErrors={
                    formErrors
                  }
                  houseparents={
                    houseparents
                  }
                />

                {/* PIERCING / TATTOO */}
                <div className="rounded-2xl border bg-white p-6">

                  <div className="flex items-center gap-3 mb-6">

                    <div className="p-2 rounded-xl bg-[#FFD100]/20">
                      <FileText
                        className="w-5 h-5 text-[#2F3E46]"
                      />
                    </div>

                    <div>
                      <h4 className="font-bold text-[#2F3E46]">
                        Piercing / Tattoo
                      </h4>

                      <p className="text-xs text-gray-500">
                        Recorded as the resident was received at
                        this admission. Pick the body part from the
                        list.
                      </p>
                    </div>

                  </div>

                  {form.bodyMarkings.length === 0 && (
                    <p className="text-sm text-gray-500">
                      No piercing or tattoo recorded for this
                      admission.
                    </p>
                  )}

                  <div className="space-y-4">

                    {form.bodyMarkings.map((marking, index) => (

                      <div
                        key={index}
                        className="rounded-xl border bg-[#f8f9fa] p-4"
                      >

                        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-[150px_1fr_1fr_auto]">

                          <div className="space-y-2">

                            <Label className="font-bold text-[#2F3E46]">
                              Type
                            </Label>

                            <Select
                              value={
                                marking.type ||
                                undefined
                              }
                              onValueChange={(value) =>
                                updateBodyMarking(index, { type: value })
                              }
                            >
                              <SelectTrigger className="rounded-xl">
                                <SelectValue placeholder="Select type" />
                              </SelectTrigger>

                              <SelectContent>
                                {BODY_MARKING_TYPES.map((type) => (
                                  <SelectItem
                                    key={type}
                                    value={type}
                                  >
                                    {type}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>

                          </div>

                          <div className="space-y-2">

                            <Label className="font-bold text-[#2F3E46]">
                              Body Part
                            </Label>

                            <Select
                              value={
                                marking.location ||
                                undefined
                              }
                              onValueChange={(value) =>
                                updateBodyMarking(index, { location: value })
                              }
                            >
                              <SelectTrigger className="rounded-xl">
                                <SelectValue placeholder="Select body part" />
                              </SelectTrigger>

                              <SelectContent>
                                {BODY_MARKING_LOCATIONS.map((location) => (
                                  <SelectItem
                                    key={location}
                                    value={location}
                                  >
                                    {location}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>

                          </div>

                          <div className="space-y-2">

                            <Label className="font-bold text-[#2F3E46]">
                              Notes
                            </Label>

                            <Input
                              value={
                                marking.description
                              }
                              onChange={(event) =>
                                updateBodyMarking(index, {
                                  description: event.target.value,
                                })
                              }
                              placeholder="Design, size, remarks"
                              maxLength={
                                BODY_MARKING_MAX_DESCRIPTION
                              }
                              className="rounded-xl"
                            />

                          </div>

                          <div className="flex items-end">

                            <Button
                              type="button"
                              variant="outline"
                              className="rounded-xl text-red-600"
                              aria-label="Remove this marking"
                              onClick={() =>
                                removeBodyMarking(index)
                              }
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>

                          </div>

                        </div>

                      </div>

                    ))}

                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl mt-4"
                    disabled={
                      form.bodyMarkings.length >=
                      BODY_MARKING_MAX_ENTRIES
                    }
                    onClick={addBodyMarking}
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add marking
                  </Button>

                  {formErrors.bodyMarkings && (
                    <p className="text-xs text-red-600 mt-2">
                      {
                        formErrors.bodyMarkings
                      }
                    </p>
                  )}

                </div>

                {/* END PIERCING / TATTOO
                    Explicit boundary for the guard test's slice. Slicing to the
                    next element instead would silently start matching whatever
                    happens to sit below the card after a later edit. */}

                <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 rounded-lg bg-amber-100 p-2 text-amber-700">📅</div>
                    <div className="flex-1">
                      <p className="text-sm font-bold text-[#2F3E46]">Discharge Plan</p>
                      <p className="text-xs text-gray-500 mt-0.5">Set the expected discharge date for this admission. Extensions are recorded separately.</p>
                      <div className="mt-3 max-w-sm">
                        <Label className="text-xs font-semibold">Expected Discharge Date</Label>
                        <Input type="date" value={form.expectedDischargeDate || ''} min={form.admissionDate || undefined} onChange={e => setForm(prev => ({ ...prev, expectedDischargeDate: e.target.value }))} className="mt-1 bg-white" />
                        {formErrors.expectedDischargeDate && <p className="text-xs text-red-600 mt-1">{formErrors.expectedDischargeDate}</p>}
                      </div>
                    </div>
                  </div>
                </div>

                {/* No separate Houseparent Assignment
                    section here anymore. It is now directly
                    on the official PDF. */}

                <div className="flex flex-col gap-3 md:flex-row md:justify-between md:items-center pt-2">

                  <Button
                    variant="outline"
                    onClick={() => {
                      setFormStep(
                        1
                      );

                      setFormErrors(
                        {}
                      );
                    }}
                    disabled={
                      savingAdmission
                    }
                    className="rounded-xl"
                  >
                    <ArrowLeft
                      size={16}
                      className="mr-2"
                    />

                    Back to Part 1
                  </Button>

                  <div className="flex flex-col sm:flex-row gap-2">



                    <Button
                      variant="ghost"
                      onClick={() => {
                        setIsFormOpen(
                          false
                        );

                        resetForm();
                      }}
                      disabled={
                        savingAdmission
                      }
                      className="rounded-xl"
                    >
                      Cancel
                    </Button>

                    <Button
                      style={{
                        backgroundColor:
                          '#2F3E46',
                        color:
                          'white',
                      }}
                      className="rounded-xl px-8 font-bold"
                      onClick={editingId ? handleUpdateResident : handleSave}
                      disabled={
                        savingAdmission
                      }
                    >
                      {savingAdmission ? (
                        <>
                          <Loader2
                            size={16}
                            className="mr-2 animate-spin"
                          />

                          Saving Admission...
                        </>
                      ) : (
                        <>
                          {editingId ? null : <Plus size={16} className="mr-2" />}
                          {editingId ? 'Update Resident' : 'Save Admission'}
                        </>
                      )}
                    </Button>

                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ==========================================================
          EXISTING RESIDENT DIALOG
          ========================================================== */}

      <Dialog
        open={
          showExistingAdmission
        }
        onOpenChange={
          setShowExistingAdmission
        }
      >
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">

          <DialogHeader>
            <DialogTitle className="text-[#2F3E46]">
              Existing Resident Found
            </DialogTitle>
          </DialogHeader>

          {loadingExistingAdmission ? (

            <div className="py-14 flex justify-center">
              <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
            </div>

          ) : duplicateChild ? (

            <div className="space-y-5">

              <div className="rounded-2xl border bg-gray-50 p-5">

                <div className="flex flex-col md:flex-row gap-5">

                  {existingAdmission?.residentImage && (
                    <img
                      src={
                        existingAdmission.residentImage
                      }
                      alt="Resident"
                      className="h-32 w-28 rounded-xl object-cover border"
                    />
                  )}

                  <div className="space-y-2">

                    <div className="flex flex-wrap items-center gap-2">

                      <h3 className="text-xl font-bold text-[#2F3E46]">
                        {
                          duplicateChild.name
                        }
                      </h3>

                      <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">
                        Returning Resident
                      </Badge>

                      {duplicateChild.status === 'Absconded' && (
                        <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
                          Absconded — re-admitting
                        </Badge>
                      )}

                    </div>

                    <p className="text-sm text-gray-500">
                      Resident ID:{' '}
                      {
                        duplicateChild.id
                      }
                    </p>

                    <p className="text-sm text-gray-500">
                      Date of Birth:{' '}
                      {formatPHDate(
                        duplicateChild.birthDate
                      )}
                    </p>

                  </div>

                </div>
              </div>

              <div>

                <div className="flex items-center justify-between gap-3 mb-3">

                  <div>

                    <h4 className="font-bold text-[#2F3E46]">
                      Previous Admission History
                    </h4>

                    <p className="text-xs text-gray-500">
                      Each admission remains a
                      separate immutable record.
                    </p>

                  </div>


                </div>

                {existingAdmissions.length >
                0 ? (

                  <div className="space-y-3">

                    {existingAdmissions.map(
                      (
                        admission
                      ) => (
                        <div
                          key={
                            admission.id
                          }
                          className="rounded-xl border p-4 bg-white"
                        >

                          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">

                            <div>

                              <div className="flex items-center gap-2 flex-wrap">

                                <Badge className="bg-[#2F3E46] text-white">
                                  Admission #
                                  {
                                    admission.admissionNumber
                                  }
                                </Badge>

                                <span className="text-sm font-semibold text-[#2F3E46]">
                                  {formatSlipDate(
                                    admission.admissionDate
                                  )}
                                </span>

                              </div>

                              <div className="grid md:grid-cols-3 gap-2 mt-3 text-xs text-gray-600">

                                <span>
                                  Legal Category:{' '}
                                  {
                                    admission.legalCategory
                                  }
                                </span>

                                <span>
                                  Specific Offense:{' '}
                                  {
                                    admission.specificOffense
                                  }
                                </span>

                                <span>
                                  Status:{' '}
                                  {
                                    admission.status ||
                                    'Active'
                                  }
                                </span>

                              </div>
                            </div>

                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                openAdmissionPdf(
                                  admission,
                                  false
                                )
                              }
                              className="rounded-xl"
                            >
                              <FileText
                                size={15}
                                className="mr-2"
                              />

                              View Slip
                            </Button>

                          </div>
                        </div>
                      )
                    )}

                  </div>

                ) : (

                  <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4">

                    <p className="font-semibold text-yellow-800">
                      The resident record exists,
                      but no previous Admission Slip
                      was found.
                    </p>

                    <p className="text-sm text-yellow-700 mt-1">
                      You can continue and create
                      a new admission.
                    </p>

                  </div>

                )}

              </div>

              {existingAdmission && (
                <div className="rounded-xl border bg-white p-4">

                  <h4 className="font-bold text-[#2F3E46] mb-3">
                    Latest Admission Information
                  </h4>

                  <div className="grid md:grid-cols-2 gap-3 text-sm">

                    <div>
                      <strong>
                        Name:
                      </strong>{' '}
                      {
                        existingAdmission.name
                      }
                    </div>

                    <div>
                      <strong>
                        Admission Date:
                      </strong>{' '}
                      {formatSlipDate(
                        existingAdmission.admissionDate
                      )}
                    </div>

                    <div>
                      <strong>
                        Date of Birth:
                      </strong>{' '}
                      {formatPHDate(
                        existingAdmission.birthDate
                      )}
                    </div>

                    <div>
                      <strong>
                        Age:
                      </strong>{' '}
                      {
                        existingAdmission.age
                      }
                    </div>

                    <div>
                      <strong>
                        Sex:
                      </strong>{' '}
                      {
                        existingAdmission.sex
                      }
                    </div>

                    <div>
                      <strong>
                        Religion:
                      </strong>{' '}
                      {
                        existingAdmission.religion
                      }
                    </div>

                    <div className="md:col-span-2">
                      <strong>
                        Address:
                      </strong>{' '}
                      {
                        existingAdmission.address
                      }
                    </div>

                    <div>
                      <strong>
                        Guardian:
                      </strong>{' '}
                      {
                        existingAdmission.guardianName
                      }
                    </div>

                    <div>
                      <strong>
                        Guardian Contact:
                      </strong>{' '}
                      {
                        existingAdmission.guardianContact
                      }
                    </div>

                  </div>
                </div>
              )}

              <DialogFooter>

                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowExistingAdmission(
                      false
                    );

                    setDuplicateChild(
                      null
                    );

                    setExistingAdmission(
                      null
                    );

                    setExistingAdmissions(
                      []
                    );
                  }}
                >
                  Cancel
                </Button>

                <Button
                  style={{
                    backgroundColor:
                      '#2F3E46',
                    color:
                      'white',
                  }}
                  onClick={
                    confirmExistingResident
                  }
                >
                  Confirm Resident & Continue

                  <ArrowRight
                    size={16}
                    className="ml-2"
                  />
                </Button>

              </DialogFooter>

            </div>

          ) : null}

        </DialogContent>
      </Dialog>

      {/* ==========================================================
          STATUS FILTERS
          ========================================================== */}

      <div className="flex items-center gap-2 flex-wrap">

        {(
          [
            'All',
            'Active',
            'Discharged',
            'Absconded',
          ] as const
        ).map(
          (status) => {

            const count =
              status ===
              'All'
                ? children.length
                : status ===
                    'Active'
                  ? activeCount
                  : status ===
                      'Absconded'
                    ? abscondedCount
                    : dischargedCount;

            const active =
              statusFilter ===
              status;

            return (
              <button
                key={status}
                type="button"
                onClick={() =>
                  setStatusFilter(
                    status
                  )
                }
                className={[
                  'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border-2 transition-all',

                  active
                    ? status ===
                      'Absconded'
                      ? 'bg-orange-600 border-orange-600 text-white'
                      : status ===
                      'Discharged'
                      ? 'bg-emerald-600 border-emerald-600 text-white'
                      : status ===
                          'Active'
                        ? 'bg-[#2F3E46] border-[#2F3E46] text-white'
                        : 'bg-gray-700 border-gray-700 text-white'
                    : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300',
                ].join(' ')}
              >
                {
                  status === 'Absconded' ? 'Abscond' : status
                }

                <span
                  className={[
                    'text-xs px-1.5 py-0.5 rounded-full font-bold',

                    active
                      ? 'bg-white/20 text-white'
                      : 'bg-gray-100 text-gray-500',
                  ].join(' ')}
                >
                  {
                    count
                  }
                </span>

              </button>
            );
          }
        )}

      </div>

      {/* ==========================================================
          SEARCH
          ========================================================== */}

      <div className="relative w-full md:w-96">

        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />

        <Input
          className="pl-10 bg-white border-gray-200 rounded-xl"
          placeholder="Search by name or ID..."
          value={
            searchTerm
          }
          onChange={(event) =>
            setSearchTerm(
              event.target.value
            )
          }
        />

      </div>

      {/* ==========================================================
          RESIDENT LIST
          ========================================================== */}

      <div className="grid gap-4">

        {filteredChildren.length >
        0 ? (

          filteredChildren.map(
            (child: any) => (
              <Card
                key={
                  child.id
                }
                style={{
                  backgroundColor:
                    '#2F3E46',
                }}
                className="border-none shadow-lg overflow-hidden hover:scale-[1.005] transition-all duration-200 rounded-2xl text-white"
              >

                <CardContent className="p-0 flex flex-col md:flex-row">

                  <div
                    style={{
                      backgroundColor:
                        '#FFD100',
                    }}
                    className="w-1.5"
                  />

                  <div className="p-6 flex-1 flex flex-col md:flex-row md:items-center justify-between gap-6">

                    <div className="space-y-3">

                      <div className="flex items-center gap-3 flex-wrap">

                        <h3 className="text-xl font-bold tracking-tight">
                          {
                            child.name
                          }
                        </h3>

                        <Badge className="bg-white/10 text-[#FFD100] border-none text-[10px] uppercase font-bold">
                          {child.legalCategory ||
                            child.caseType ||
                            'No category'}
                        </Badge>

                        {child.status ===
                          'Discharged' && (
                          <Badge className="bg-emerald-500/20 text-emerald-300 border-none text-[10px] uppercase font-bold">
                            Case Closed
                          </Badge>
                        )}

                        {child.status ===
                          'Absconded' && (
                          <Badge className="bg-orange-500/25 text-orange-200 border-none text-[10px] uppercase font-bold">
                            Absconded
                          </Badge>
                        )}

                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-2 text-sm opacity-90">

                        <div className="space-y-2">

                          <div className="flex items-center gap-2">

                            <User
                              size={14}
                              className="text-[#FFD100]"
                            />

                            <span>
                              {
                                child.age
                              }{' '}
                              yrs old
                              {' • '}
                              {
                                child.gender
                              }
                            </span>

                          </div>

                          <div className="flex items-center gap-2">

                            <Calendar
                              size={14}
                              className="text-[#FFD100]"
                            />

                            <span>
                              Admitted:{' '}
                              {formatPHDate(
                                child.admissionDate
                              )}
                            </span>

                          </div>

                        </div>

                        <div className="space-y-2">

                          <div className="flex items-center gap-2">

                            <Badge
                              variant="outline"
                              className="border-gray-500 text-gray-400 font-normal text-xs"
                            >
                              {
                                child.id
                              }
                            </Badge>

                            <span className="font-medium text-[#FFD100]">
                              {
                                child.caseType ||
                                'No offense'
                              }
                            </span>

                          </div>

                          <div className="flex items-center gap-2">

                            <span className="text-xs opacity-70">
                              {
                                child.casePhase ||
                                '—'
                              }
                            </span>

                          </div>

                        </div>

                      </div>
                    </div>

                    {/* ACTIONS */}
                    <div className="flex items-center gap-2 pt-4 md:pt-0 border-t md:border-t-0 md:border-l md:pl-6 border-white/10">

                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-white hover:bg-white/10 gap-2"
                        onClick={() =>
                          navigate(
                            `/children/${child.id}`
                          )
                        }
                      >
                        <Eye
                          size={16}
                          className="text-[#FFD100]"
                        />

                        View
                      </Button>

                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-white hover:bg-white/10 gap-2"
                        onClick={() => openEdit(child.id)}
                      >
                        <Edit
                          size={16}
                          className="text-[#FFD100]"
                        />
                        Edit
                      </Button>

                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-2"
                        onClick={() =>
                          handleDelete(
                            child.id
                          )
                        }
                      >
                        <Trash2
                          size={16}
                        />

                        Delete
                      </Button>

                    </div>

                  </div>

                </CardContent>
              </Card>
            )
          )

        ) : (

          <div className="text-center py-16 text-gray-400">

            <AlertCircle className="w-10 h-10 mx-auto mb-2 opacity-20" />

            <p>
              No records found matching
              your search.
            </p>

          </div>
        )}

      </div>

      {/* ==========================================================
          DELETE CONFIRMATION
          ========================================================== */}

      <AlertDialog
        open={
          !!childToDelete
        }
        onOpenChange={(open) => {
          if (!open) {
            setChildToDelete(
              null
            );
          }
        }}
      >
        <AlertDialogContent className="bg-white rounded-2xl">

          <AlertDialogHeader>

            <AlertDialogTitle className="text-[#2F3E46] font-bold">
              Confirm Delete
            </AlertDialogTitle>

            <AlertDialogDescription>
              Delete record for{' '}

              <strong>
                {
                  children.find(
                    (child: any) =>
                      child.id ===
                      childToDelete
                  )?.name
                }
              </strong>

              ? This action cannot be undone.
            </AlertDialogDescription>

          </AlertDialogHeader>

          <AlertDialogFooter>

            <AlertDialogCancel>
              Cancel
            </AlertDialogCancel>

            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                if (
                  childToDelete
                ) {
                  deleteChild(
                    childToDelete
                  );
                }

                setChildToDelete(
                  null
                );
              }}
            >
              Delete
            </AlertDialogAction>

          </AlertDialogFooter>

        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}