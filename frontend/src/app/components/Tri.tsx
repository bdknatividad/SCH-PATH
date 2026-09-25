import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Textarea } from '@/app/components/ui/textarea';
import { Alert, AlertDescription } from '@/app/components/ui/alert';
import { History, Save, Send, RotateCcw, CheckCheck, ClipboardList, Plus, Eye, Loader2, AlertCircle, X as CloseIcon, Check, Minus, Trophy, Printer, Download, Search, Users } from 'lucide-react';
import { useData, Child } from '@/app/state/DataContext';
import { useAuth } from '@/app/state/AuthContext';
import { usePermissions } from '@/app/hooks/usePermissions';
import { describeError, request } from '@/services/api';
import { TriStatistics } from '@/app/components/TriStatistics';
import { useSystemDialog } from '@/app/components/SystemDialog';
import { triTrend, ratingForPoints } from '@/utils/triRating';
import triLayout from '@/shared/triLayout.json';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { CaseLoad } from './CaseLoad';
import { AnecdotalReports } from './AnecdotalReports';
import { useSubModuleTab } from '@/app/hooks/useSubModuleTab';
import { useSubModuleTabs } from '@/app/hooks/useSubModuleTabs';
import { SignaturePadModal } from '@/app/components/SignaturePad';
import { Document as PdfDocument, Page as PdfPage, pdfjs } from 'react-pdf';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';

interface TriRecord {
  id: string; residentId: string;
  reportingYear: number; reportingMonth: number;
  status: string;
  responses: any;
  partOnePoints: number | null; deductions: number | null; finalPoints: number | null;
  rating: string | null;
  previousPoints: number | null; previousRating: string | null;
  submissionDeadline: string | null; effectiveDate: string | null;
  submittedBy?: string | null; submittedAt?: string | null;
  /**
   * The Houseparent's drawn signature (PNG data URL) and who attached it. Stamped
   * onto the "Houseparent" line of the exported form.
   */
  houseparentSignature?: string | null;
  houseparentSignedBy?: string | null;
  houseparentSignedAt?: string | null;
  /**
   * The rest of the page-8 block: the Houseparent's typed name, the typed name +
   * E-Signature of the Administrative Officer and SWO I / Case Manager, and the
   * E-Signatures of MARICOR C. NAVARRO and NICOLAS Q. REGALARIO.
   */
  signatories?: TriSignatories | string | null;
  reviewedBy?: string | null; reviewedAt?: string | null;
  finalizedBy?: string | null; finalizedAt?: string | null;
  reviewNotes?: string | null;
  dischargeRecommendation?: {
    thresholdReached: boolean;
    majorCount: number;
    minorCount: number;
    recommendation: { id: string; thresholdType: string; recommendationNote: string; status: string } | null;
  };
  createdAt: string; updatedAt: string;
}


interface ResidentViolation {
  id: string;
  residentId: string;
  type: string;
  severity: 'Minor' | 'Major' | string;
  date: string;
  status?: string;
  offenseNumber?: string;
  description?: string;
}

interface TriCaseloadEntry {
  userId: string;
  username: string;
  label: string;
  assignedCount: number;
  maxCaseload: number;
  availableSlots: number;
  residents: { id: string; name: string }[];
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const STATUS_COLOR: Record<string,string> = {
  Draft: 'bg-gray-100 text-gray-700',
  Submitted: 'bg-blue-100 text-blue-700',
  'Under Review': 'bg-yellow-100 text-yellow-700',
  Returned: 'bg-red-100 text-red-700',
  'For Reassessment': 'bg-yellow-100 text-yellow-800',
  Finalized: 'bg-green-100 text-green-700',
};
const RATING_COLOR: Record<string,string> = {
  'Needs Improvement': 'bg-red-100 text-red-700',
  'Fair': 'bg-yellow-100 text-yellow-700',
  'Good': 'bg-blue-100 text-blue-700',
  'Very Good': 'bg-green-100 text-green-700',
};
const SCORE_LEGEND = [
  { value: 0, label: 'Not Scored', icon: Minus, cls: 'text-gray-400' },
  { value: 1, label: 'Needs Improvement', icon: AlertCircle, cls: 'text-red-600' },
  { value: 2, label: 'Fair', icon: AlertCircle, cls: 'text-yellow-600' },
  { value: 3, label: 'Good', icon: Check, cls: 'text-blue-600' },
  { value: 4, label: 'Very Good', icon: Trophy, cls: 'text-green-600' },
];

// ── TRI Part II: Homelife Discipline offense table (TRI PDF pages 6-7).
// Order and point values follow the official form exactly.
// ── TRI item tables ────────────────────────────────────────────────────────────
// Part II homelife-discipline offenses (PDF pages 6-7) and Part I indicators
// (PDF pages 1-5), plus the measured coordinates below. All of it lives in
// shared/triLayout.json because the backend draws the same official PDF when a
// record is approved, and a second copy of measured coordinates drifts silently.
const PART_TWO_OFFENSES = triLayout.partTwoOffenses;
const TRI_PART_ONE = triLayout.partOne;

const TOTAL_ITEMS = TRI_PART_ONE.reduce((s, sec) => s + sec.items.length, 0);

/**
 * First Part I item with no score, walking TRI_PART_ONE in form order — which is
 * also page order, so "the first unanswered row" is also the earliest one on screen.
 * Returns the section and label so the refusal can name what is missing instead of
 * only counting it.
 */
function firstUnscoredItem(items: any): { id: string; label: string; section: string } | null {
  const map = items && typeof items === 'object' ? items : {};
  for (const section of TRI_PART_ONE) {
    for (const item of section.items) {
      if (!(Number(map[item.id]) > 0)) return { id: item.id, label: item.label, section: section.section };
    }
  }
  return null;
}

/**
 * Offenses ticked in Part II that still have no "Date Committed", by label.
 *
 * Split out of `validateOffenseDates` so the signature flow can ask the same
 * question without the side effects: the validator jumps the form to Part II and
 * raises an error, which is wrong to do while the preparer is drawing a signature.
 */
function missingOffenseDates(form: any): string[] {
  const offenses: number[] = Array.isArray(form?.responses?.offenses) ? form.responses.offenses : [];
  const dates: Record<string, string> = form?.responses?.offenseDates || {};
  return offenses
    .map(index => ({ index, label: PART_TWO_OFFENSES[index]?.label || `Offense ${index + 1}`, date: dates[String(index)] || '' }))
    .filter(item => !item.date)
    .map(item => item.label);
}

function getMonthLabel(m: number): string { return MONTHS[(m||1)-1] || ''; }
function getPeriodLabel(y: number, m: number): string { return getMonthLabel(m) + ' ' + y; }

function getLastMondayOfMonth(year: number, month: number): string {
  const d = new Date(year, month, 0);
  const day = d.getDay();
  const offset = (day + 6) % 7;
  d.setDate(d.getDate() - offset);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function formatDisplayDate(value: string): string {
  if (!value) return '—';
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return value;
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
}

function formatDateInput(value: string): string {
  if (!value) return '';
  const [y, m, d] = String(value).slice(0, 10).split('-');
  return y && m && d ? `${m}/${d}/${y}` : value;
}

function parseDateInput(value: string): string {
  const match = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return value;
  return `${match[3]}-${String(match[1]).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`;
}

function itemsToArray(items: any): { id: string; score: number }[] {
  if (Array.isArray(items)) return items.filter((it: any) => it?.id && Number(it?.score) > 0).map((it: any) => ({ id: it.id, score: Number(it.score) }));
  if (items && typeof items === 'object') {
    return Object.entries(items).filter(([, v]) => Number(v) > 0).map(([k, v]) => ({ id: k, score: Number(v) }));
  }
  return [];
}

function scoreMapOf(items: any): Record<string, number> {
  const map: Record<string, number> = {};
  itemsToArray(items).forEach(s => { map[s.id] = s.score; });
  return map;
}

// Total Part II deduction for the currently checked offense rows.
function offenseTotal(offenses: number[] | undefined): number {
  if (!Array.isArray(offenses)) return 0;
  return offenses.reduce((s, idx) => s + (PART_TWO_OFFENSES[idx]?.points || 0), 0);
}

// Match a recorded violation to the closest official Part II offense row so
// deductions can be pre-checked from actual violations. Matching prefers an
// offense with the same point value that shares keywords with the violation.
const OFFENSE_WORDS = PART_TWO_OFFENSES.map(o =>
  o.label.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3)
);
function matchOffenseIndex(type: string, points: number): number {
  const words = String(type || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3);
  let best = -1; let bestScore = 0;
  PART_TWO_OFFENSES.forEach((o, i) => {
    if (o.points !== points) return;
    let score = 0;
    for (const w of words) if (OFFENSE_WORDS[i].includes(w)) score += 1;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  if (best >= 0) return best;
  return PART_TWO_OFFENSES.findIndex(o => o.points === points);
}

function buildResponses(form: any) {
  const offenses: number[] = Array.isArray(form?.responses?.offenses) ? form.responses.offenses : [];
  const offenseDates = (form?.responses?.offenseDates && typeof form.responses.offenseDates === 'object')
    ? form.responses.offenseDates
    : {};
  return {
    ...(form?.responses || {}),
    items: itemsToArray(form?.responses?.items),
    offenses,
    offenseDates,
    deductions: offenseTotal(offenses),
    deductionDetails: offenses
      .map(idx => ({ offense: PART_TWO_OFFENSES[idx]?.label, points: PART_TWO_OFFENSES[idx]?.points || 0 }))
      .filter(d => d.points > 0),
  };
}

function getInitialForm() {
  const n = new Date();
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit' })
    .formatToParts(n).reduce((r: any, p: any) => ({ ...r, [p.type]: p.value }), {});
  return { residentId: '', reportingYear: Number(f.year), reportingMonth: Number(f.month),
    responses: { items: {}, deductions: 0, deductionDetails: [], offenses: [] as number[], offenseDates: {} as Record<string, string> } };
}

function ratingColor(rating: string): string {
  if (rating === 'Very Good') return 'bg-green-100 text-green-700';
  if (rating === 'Good') return 'bg-blue-100 text-blue-700';
  if (rating === 'Fair') return 'bg-yellow-100 text-yellow-700';
  return 'bg-red-100 text-red-700';
}

function escapeHtml(value: any): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function TriStatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLOR[status] || 'bg-gray-100 text-gray-700';
  return <Badge className={`${cls} text-xs`}>{status}</Badge>;
}

// ── Records list table
function TRIRecordsTable({
  records, allChildren, onView, onPrint,
}: { records: TriRecord[]; allChildren: Child[]; onView: (r: TriRecord) => void; onPrint: (r: TriRecord) => void; }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left">
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase pr-4">Resident</th>
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase pr-4">Period</th>
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase pr-4">Status</th>
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase pr-4">Submitted by</th>
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase pr-4">Score</th>
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase pr-4">Rating</th>
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase pr-4">Deadline</th>
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase"></th>
          </tr>
        </thead>
        <tbody>
          {records.map(record => {
            const child = allChildren.find(c => c.id === record.residentId);
            return (
              <tr key={record.id} className="border-b border-gray-50 hover:bg-gray-50 align-top">
                <td className="py-3 pr-4 font-medium text-[#2F3E46]">{child?.name || record.residentId}</td>
                <td className="py-3 pr-4 text-gray-500">{getPeriodLabel(record.reportingYear, record.reportingMonth)}</td>
                <td className="py-3 pr-4"><TriStatusBadge status={record.status} /></td>
                <td className="py-3 pr-4 text-xs">
                  {record.submittedBy
                    ? <span className="text-gray-700 font-medium">{record.submittedBy}</span>
                    : <span className="text-gray-300">Not yet submitted</span>}
                </td>
                <td className="py-3 pr-4 font-mono text-xs">{record.finalPoints != null
                  ? `${record.partOnePoints ?? 0} − ${record.deductions ?? 0} = ${record.finalPoints}` : '—'}</td>
                <td className="py-3 pr-4">{record.rating
                  ? <span className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${ratingColor(record.rating)}`}>{record.rating}</span>
                  : <span className="text-gray-300">—</span>}</td>
                <td className="py-3 pr-4 text-xs text-gray-400">{record.submissionDeadline || '—'}</td>
                <td className="py-3 text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => onView(record)}>
                    <Eye className="w-3.5 h-3.5" /> View
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => onPrint(record)} title="Export / Print">
                    <Printer className="w-3.5 h-3.5" /> Export
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── TRI History table (per-resident)
function TRIHistoryTable({ records }: { records: TriRecord[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left">
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase pr-4">Period</th>
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase pr-4">Status</th>
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase pr-4">Submitted by</th>
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase pr-4">Score</th>
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase pr-4">Rating</th>
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase pr-4">Finalized By</th>
            <th className="pb-2 text-xs font-semibold text-gray-400 uppercase">Date</th>
          </tr>
        </thead>
        <tbody>
          {records.length === 0 ? (
            <tr><td colSpan={7} className="py-8 text-center text-gray-400">No history found</td></tr>
          ) : records.map(record => (
            <tr key={record.id} className="border-b border-gray-50 align-top">
              <td className="py-3 pr-4 font-medium">{getPeriodLabel(record.reportingYear, record.reportingMonth)}</td>
              <td className="py-3 pr-4"><TriStatusBadge status={record.status} /></td>
              <td className="py-3 pr-4 text-xs">
                {record.submittedBy
                  ? <span className="text-gray-700 font-medium">{record.submittedBy}</span>
                  : <span className="text-gray-300">Not yet submitted</span>}
              </td>
              <td className="py-3 pr-4 font-mono text-xs">{record.finalPoints != null
                ? `${record.partOnePoints ?? 0} − ${record.deductions ?? 0} = ${record.finalPoints}` : '—'}</td>
              <td className="py-3 pr-4">{record.rating
                ? <Badge className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${ratingColor(record.rating)}`}>{record.rating}</Badge>
                : <span className="text-gray-300">—</span>}</td>
              <td className="py-3 pr-4 text-xs text-gray-400">{record.finalizedBy || '—'}</td>
              <td className="py-3 pr-4 text-xs text-gray-400">{record.finalizedAt ? new Date(record.finalizedAt).toLocaleDateString() : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TRI_PDF_SCORE_X = triLayout.scoreX;

// Which PDF page (0-indexed) each Part I item lives on. Order matches TRI_PART_ONE.
const TRI_PDF_PAGE_ITEMS = triLayout.pageItems;

// Exact PDF y-coordinate of every Part I checkbox row, measured off the real
// tri.pdf template (not a uniform-rowHeight guess). This is the fix for the
// "answers land in the wrong box" drift.
const TRI_ITEM_Y: Record<string, number> = triLayout.itemY;

const TRI_OFFENSE_POS = triLayout.offensePos;

/**
 * The page-8 "Houseparent" line. Both coordinates come from `triLayout.json`, which
 * the backend PDF writer reads too, so the exported copy and the published one place
 * the signature identically.
 */
const TRI_HOUSEPARENT_SIGNATURE_BOX = triLayout.houseparentSignatureBox;
const TRI_HOUSEPARENT_NAME_POS = triLayout.houseparentNamePos;

type TriSignatorySlot = 'houseparent' | 'administrativeOfficer' | 'caseManager' | 'centerHead' | 'sectionChief';
interface TriSignatoryEntry { name?: string | null; signature?: string | null; signedBy?: string | null; signedAt?: string | null }
type TriSignatories = Partial<Record<TriSignatorySlot, TriSignatoryEntry>>;

/**
 * The five signature lines of the page-8 "Assessed by" block, in form order.
 * `hasName` lines get a typed-name text holder under the E-Signature; the last two
 * carry a pre-printed name and get the E-Signature above it.
 */
const TRI_SIGNATORIES: { slot: TriSignatorySlot; title: string; hasName: boolean; printedName?: string }[] = [
  { slot: 'houseparent', title: 'Houseparent', hasName: true },
  { slot: 'administrativeOfficer', title: 'Administrative Officer', hasName: true },
  { slot: 'caseManager', title: 'SWO I / Case Manager', hasName: true },
  { slot: 'centerHead', title: 'SWO II / Center Head', hasName: false, printedName: 'MARICOR C. NAVARRO, RSW, MSSW' },
  { slot: 'sectionChief', title: 'SWO III / Section Chief', hasName: false, printedName: 'NICOLAS Q. REGALARIO, RSW, MSSW' },
];

/** Measured geometry of each line, shared with the backend PDF writer. */
const TRI_SIGNATORY_LAYOUT = triLayout.signatories as Record<TriSignatorySlot, {
  page: number; x: number; width: number; signatureY: number; signatureHeight: number; nameY?: number; nameSize?: number;
}>;

function signatoriesOf(record: TriRecord | null | undefined): TriSignatories {
  const raw = record?.signatories;
  if (!raw) return {};
  if (typeof raw === 'string') { try { return JSON.parse(raw) || {}; } catch { return {}; } }
  return raw;
}

/** The E-Signature saved on a line, or ''. */
function signatorySignature(record: TriRecord | null | undefined, slot: TriSignatorySlot): string {
  if (!record) return '';
  return String((slot === 'houseparent' ? record.houseparentSignature : signatoriesOf(record)[slot]?.signature) || '');
}

/** The name typed into a line's text holder, or ''. */
function signatoryTypedName(record: TriRecord | null | undefined, slot: TriSignatorySlot): string {
  return String(signatoriesOf(record)[slot]?.name || '').trim();
}

/** Only a well-formed image data URL is safe to inline in the print template. */
const SIGNATURE_DATA_URL = /^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/i;

/**
 * The name printed on the Houseparent line: the name typed into its text holder,
 * else (for a TRI signed before the text holder existed) whoever signed, else
 * whoever submitted.
 */
function houseparentLineName(record: TriRecord): string {
  return signatoryTypedName(record, 'houseparent')
    || String(record.houseparentSignedBy || record.submittedBy || '').trim();
}

/** The name printed on any line ('' for the two pre-printed lines). */
function signatoryLineName(record: TriRecord, slot: TriSignatorySlot): string {
  if (slot === 'houseparent') return houseparentLineName(record);
  return TRI_SIGNATORIES.find(s => s.slot === slot)?.hasName ? signatoryTypedName(record, slot) : '';
}

function drawPdfText(page: any, text: any, x: number, y: number, size = 9, font?: any) {
  const value = String(text ?? '').trim();
  if (value) page.drawText(value, { x, y, size, font, color: rgb(0.08, 0.08, 0.08) });
}

/**
 * Stamps every page-8 signature line onto an exported PDF: the E-Signature on top
 * and, for the Houseparent, Administrative Officer and SWO I / Case Manager, the
 * typed name below it on the rule; for MARICOR C. NAVARRO and NICOLAS Q.
 * REGALARIO, the E-Signature above their pre-printed name.
 *
 * The export re-draws the answers onto the same official template the server fills
 * in when it publishes the approved copy, so it has to carry the same signatures in
 * the same places (both read `triLayout.json`).
 *
 * An unsigned or undecodable signature is not an error: that line is simply left
 * blank.
 */
async function drawTriSignatures(pdf: any, pages: any[], record: TriRecord, font: any) {
  let signed = 0;
  for (const { slot, hasName } of TRI_SIGNATORIES) {
    const geometry = slot === 'houseparent'
      ? { page: TRI_HOUSEPARENT_SIGNATURE_BOX.page, x: TRI_HOUSEPARENT_SIGNATURE_BOX.x, width: TRI_HOUSEPARENT_SIGNATURE_BOX.width, signatureY: TRI_HOUSEPARENT_SIGNATURE_BOX.y, signatureHeight: TRI_HOUSEPARENT_SIGNATURE_BOX.height, nameY: TRI_HOUSEPARENT_NAME_POS.y, nameSize: TRI_HOUSEPARENT_NAME_POS.size }
      : TRI_SIGNATORY_LAYOUT[slot];
    const page = pages[geometry.page];
    if (!page) continue;

    const name = hasName ? signatoryLineName(record, slot) : '';
    if (name && geometry.nameY != null) {
      let size = geometry.nameSize || 8;
      while (size > 4 && font.widthOfTextAtSize(name, size) > geometry.width) size -= 0.25;
      page.drawText(name, { x: geometry.x, y: geometry.nameY, size, font, color: rgb(0.08, 0.08, 0.08) });
    }

    const dataUrl = signatorySignature(record, slot);
    const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,/i);
    if (!match) continue;
    try {
      const image = match[1].toLowerCase() === 'png'
        ? await pdf.embedPng(dataUrl)
        : await pdf.embedJpg(dataUrl);
      const scale = Math.min(geometry.width / image.width, geometry.signatureHeight / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      // Centred on the line and resting on the bottom of the band, so the
      // signature sits directly above the name / printed name.
      page.drawImage(image, { x: geometry.x + (geometry.width - width) / 2, y: geometry.signatureY, width, height });
      signed += 1;
    } catch {
      // An unreadable image leaves this one line blank; the export continues.
    }
  }
  return signed;
}

/**
 * Generates and downloads the official TRI PDF.
 *
 * `onError` is how the caller reports a failure. This is a module-level helper
 * with no dialog of its own, and it used to `alert()` — a browser box titled
 * with the page's origin, which is exactly the "localhost message" a staff
 * member should never see. Callers pass the system dialog's reporter instead.
 */
async function openFormalPdfReport(record: TriRecord, child: any, onError?: (message: string) => void) {
  try {
    const template = await fetch('/forms/tri.pdf').then(response => {
      if (!response.ok) throw new Error('The official TRI PDF template could not be loaded.');
      return response.arrayBuffer();
    });
    const pdf = await PDFDocument.load(template);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const scores = scoreMapOf(record.responses?.items);
    const offenses: number[] = Array.isArray(record.responses?.offenses) ? record.responses.offenses : [];
    const pages = pdf.getPages();

        drawPdfText(pages[0], child?.name || record.residentId, 74, 753, 10, bold);
    drawPdfText(pages[0], record.responses?.room || child?.room || '', 254, 753, 10, font);
    drawPdfText(pages[0], getPeriodLabel(record.reportingYear, record.reportingMonth), 398, 753, 10, font);

    for (const layout of TRI_PDF_PAGE_ITEMS) {
      const page = pages[layout.page];
      layout.ids.forEach(id => {
        const score = Number(scores[id] || 0);
        const y = TRI_ITEM_Y[id];
        if (score >= 1 && score <= 4 && y != null) {
          page.drawText('X', { x: TRI_PDF_SCORE_X[score - 1] - 3, y: y-11, size: 10, font: bold, color: rgb(0, 0, 0) });
        }
      });
    }

    TRI_OFFENSE_POS.forEach((pos, offenseIndex) => {
      if (offenses.includes(offenseIndex)) {
        pages[pos.page].drawText('X', { x: 484, y: pos.y -11, size: 10, font: bold });
      }
    });

    // Official summary fields are on page 7 (PDF index 6), in the right-hand value column.
    // The total earned for the period is on the preceding page (PDF index 5).
    const exportedPartOnePoints = record.partOnePoints ?? Object.values(scores).reduce((sum: number, value: any) => sum + (Number(value) || 0), 0);
    const exportedDeductions = record.deductions ?? offenses.reduce((sum, index) => sum + (PART_TWO_OFFENSES[index]?.points || 0), 0);
    const exportedFinalPoints = record.finalPoints ?? Math.max(0, exportedPartOnePoints - exportedDeductions);
    const exportedRating = record.rating || (exportedFinalPoints >= 451 ? 'Very Good' : exportedFinalPoints >= 301 ? 'Good' : exportedFinalPoints >= 151 ? 'Fair' : exportedFinalPoints >= 1 ? 'Needs Improvement' : '');
    drawPdfText(pages[5], String(exportedPartOnePoints), 307, 602, 10, bold);
    const summary = pages[6];
    drawPdfText(summary, String(record.previousPoints ?? ''), 482, 273, 10, font);
    drawPdfText(summary, String(exportedPartOnePoints), 482, 252, 10, font);
    drawPdfText(summary, String(exportedDeductions), 482, 231, 10, font);
    drawPdfText(summary, String(exportedFinalPoints), 482, 210, 10, bold);
    drawPdfText(summary, exportedRating, 482, 189, 9, bold);
    drawPdfText(summary, record.previousRating || '', 482, 168, 9, font);

    // All five page-8 signature lines, exactly as the published copy stamps them.
    await drawTriSignatures(pdf, pages, record, bold);

    const bytes = await pdf.save();
    const safeBytes = new Uint8Array(bytes.byteLength);
    safeBytes.set(bytes);
    const url = URL.createObjectURL(new Blob([safeBytes.buffer], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `TRI-${String(child?.name || record.residentId).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}-${record.reportingYear}-${String(record.reportingMonth).padStart(2, '0')}.pdf`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (err: any) {
    const message = describeError(err, 'Unable to export the official TRI PDF.');
    if (onError) onError(message); else console.error('TRI export failed:', message);
  }
}

const TRI_X_DOWN_PX = 12;
// Part II overlay only: move the offense X and committed-date fields upward
// without changing the already-correct Part I positioning.
const TRI_OFFENSE_UP_PX = 7;

function pdfPercentX(points: number) {
  return `${(points / 612) * 100}%`;
}

function pdfPercentTop(centerY: number, height: number, offsetPx = 0) {
  return `calc(${((936 - centerY - height / 2) / 936) * 100}% + ${offsetPx}px)`;
}

/**
 * The name text holder on a page-8 signature line. Saved when the field loses
 * focus (or on Enter), and only when the text actually changed.
 */
function TriNameField({ label, value, placeholder, disabled, onCommit }: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value.trim()) onCommit(next);
  };
  return (
    <input
      type="text"
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={150}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
      className="h-full w-full rounded-sm border border-dashed border-yellow-500/70 bg-yellow-50/70 px-0.5 font-bold leading-none text-black placeholder:font-normal placeholder:text-gray-400 focus:border-solid focus:outline-none"
      style={{ fontSize: 'clamp(6px, 1vw, 11px)' }}
    />
  );
}

function OfficialTriEditor({
  form,
  record,
  child,
  isEditable,
  onScore,
  onToggleOffense,
  onOffenseDateChange,
  onRoomChange,
  onPeriodChange,
  residentViolations,
  showResidentViolations,
  onToggleResidentViolations,
  violationFromDate,
  violationToDate,
  onViolationFromDateChange,
  onViolationToDateChange,
  houseparentName,
  houseparentSignature,
  canSignHouseparent,
  canSignReviewerLines,
  signatureSaving,
  onSaveSignature,
  onSaveSignatory,
}: {
  form: any;
  record: TriRecord | null;
  child: any;
  isEditable: boolean;
  onScore: (id: string, score: number) => void;
  onToggleOffense: (index: number) => void;
  onOffenseDateChange: (index: number, date: string) => void;
  onRoomChange: (room: string) => void;
  onPeriodChange: (year: number, month: number) => void;
  residentViolations: ResidentViolation[];
  showResidentViolations: boolean;
  onToggleResidentViolations: () => void;
  violationFromDate: string;
  violationToDate: string;
  onViolationFromDateChange: (value: string) => void;
  onViolationToDateChange: (value: string) => void;
  /**
   * The page-8 "Houseparent" line: the name filled in automatically, the saved
   * drawing, and whether this viewer may write on it. Only the Houseparent may —
   * a Center Head or Social Worker approves or returns the TRI instead.
   */
  houseparentName: string;
  houseparentSignature: string;
  canSignHouseparent: boolean;
  /** The Administrative Officer, SWO I / Case Manager, Maricor and Nicolas lines. */
  canSignReviewerLines: boolean;
  signatureSaving: boolean;
  onSaveSignature: (value: string) => void;
  onSaveSignatory: (slot: TriSignatorySlot, patch: { name?: string; signature?: string }) => void;
}) {
  const pdfHostRef = useRef<HTMLDivElement | null>(null);
  const [pdfRenderWidth, setPdfRenderWidth] = useState(900);

  useEffect(() => {
    const host = pdfHostRef.current;
    if (!host) return;
    const updateWidth = () => {
      const measured = Math.floor(host.clientWidth);
      if (measured > 0) setPdfRenderWidth(Math.min(900, measured));
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const scoreMap = form.responses?.items || {};
  const offenses: number[] = Array.isArray(form.responses?.offenses) ? form.responses.offenses : [];
  const offenseDates: Record<string, string> = form.responses?.offenseDates || {};
  const partOnePoints = Object.values(scoreMap).reduce((sum: number, score: any) => sum + (Number(score) || 0), 0);
  const deductions = offenses.reduce((sum, index) => sum + (PART_TWO_OFFENSES[index]?.points || 0), 0);
  const totalPoints = Math.max(0, partOnePoints - deductions);
  const currentRating = totalPoints >= 451 ? 'Very Good' : totalPoints >= 301 ? 'Good' : totalPoints >= 151 ? 'Fair' : totalPoints >= 1 ? 'Needs Improvement' : '';
  const displayFinalPoints = String(record?.finalPoints ?? totalPoints).trim().match(/^\d+(?:\.\d+)?/)?.[0] || '';

  const overlayButton = 'absolute z-10 m-0 border-0 bg-transparent p-0 text-center text-[10px] font-bold leading-none text-black hover:bg-yellow-200/60 focus:bg-yellow-200/70 focus:outline focus:outline-2 focus:outline-yellow-500 disabled:pointer-events-none';

  return (
    <>
    <div className="relative min-h-0 flex-1 overflow-y-auto bg-neutral-200 px-2 py-4 sm:px-6">
      <div ref={pdfHostRef} className="mx-auto w-full max-w-[900px]">
        <div className="mb-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          Fill the official TRI directly. Click a score cell (1–4) for each indicator. The official TRI document is rendered as-is; only the interactive fields are overlaid.
        </div>

        <PdfDocument file="/forms/tri.pdf" loading={<div className="bg-white p-8 text-center text-sm">Loading official TRI...</div>}>
          {TRI_PDF_PAGE_ITEMS.map(layout => (
            <div key={layout.page} className="relative w-full overflow-hidden bg-white shadow-lg" style={{ aspectRatio: '612 / 936' }}>
              <PdfPage pageNumber={layout.page + 1} width={pdfRenderWidth} renderTextLayer={false} renderAnnotationLayer={false} className="absolute inset-0 h-full w-full" />
              {layout.page === 0 && (
                <>
                  <input aria-label="Resident name" value={child?.name || form.residentId || ''} readOnly className="absolute z-10 bg-white/70 px-1 text-[clamp(7px,1.2vw,13px)] font-bold outline-none" style={{ left: pdfPercentX(72), top: '18.7%', width: pdfPercentX(120), height: '2.7%' }} />
                  <input aria-label="Room" value={form.responses?.room || child?.room || ''} onChange={event => onRoomChange(event.target.value)} disabled={!isEditable} className="absolute z-10 bg-white/70 px-1 text-[clamp(7px,1.2vw,13px)] outline-none disabled:bg-white/50" style={{ left: pdfPercentX(272), top: '18.7%', width: pdfPercentX(100), height: '2.7%' }} />
                  <select aria-label="Reporting month" value={form.reportingMonth} onChange={event => onPeriodChange(form.reportingYear, Number(event.target.value))} disabled={!isEditable} className="absolute z-10 appearance-none bg-white/70 px-1 text-[clamp(7px,1.2vw,13px)] outline-none disabled:bg-white/50" style={{ left: pdfPercentX(411), top: '18.7%', width: pdfPercentX(70), height: '2.7%' }}>
                    {MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}
                  </select>
                  <input aria-label="Reporting year" type="number" value={form.reportingYear} onChange={event => onPeriodChange(Number(event.target.value), form.reportingMonth)} disabled={!isEditable} className="absolute z-10 bg-white/70 px-1 text-[clamp(7px,1.2vw,13px)] outline-none disabled:bg-white/50" style={{ left: pdfPercentX(482), top: '18.7%', width: pdfPercentX(44), height: '2.7%' }} />
                </>
              )}
              {layout.ids.map(id => {
                const centerY = TRI_ITEM_Y[id];
                if (centerY == null) return null;
                const isScored = Number(scoreMap[id]) > 0;
                const rowTop = pdfPercentTop(centerY, 21, layout.page === 0 ? 0 : TRI_X_DOWN_PX);
                return (
                  <React.Fragment key={id}>
                    {/* Amber tick in the margin so an unanswered row is findable at a glance.
                        Decorative only — the accessible signal is the n/150 counter by the button. */}
                    {isEditable && !isScored && (
                      <span
                        data-tri-unscored={id}
                        aria-hidden="true"
                        className="pointer-events-none absolute z-10 rounded-sm bg-amber-400/80"
                        style={{ left: pdfPercentX(438), top: rowTop, width: `${7 / 612 * 100}%`, height: `${21 / 936 * 100}%` }}
                      />
                    )}
                    {[1, 2, 3, 4].map(score => (
                      <button
                        key={`${id}-${score}`}
                        type="button"
                        data-tri-item={score === 1 ? id : undefined}
                        aria-label={`${id} score ${score}`}
                        disabled={!isEditable}
                        onClick={() => onScore(id, score)}
                        className={overlayButton}
                        style={{ left: `${((447 + (score - 1) * 27) / 612) * 100}%`, top: rowTop, width: `${27 / 612 * 100}%`, height: `${21 / 936 * 100}%` }}
                      >
                        {Number(scoreMap[id]) === score ? 'X' : ''}
                      </button>
                    ))}
                  </React.Fragment>
                );
              })}
              {layout.page === 5 && (
                <span
                  aria-label="Total points earned for the period"
                  className="absolute z-10 bg-white/70 px-1 text-center text-[clamp(7px,1.2vw,13px)] font-bold"
                  style={{ left: pdfPercentX(276), top: pdfPercentTop(606.75, 18), width: pdfPercentX(75) }}
                >{String(record?.partOnePoints ?? partOnePoints)}</span>
              )}
              {layout.page === 5 && TRI_OFFENSE_POS.map((pos, offenseIndex) => pos.page === 5 && (
                <React.Fragment key={`offense-${offenseIndex}`}>
                  <button
                    type="button"
                    aria-label={`Offense ${offenseIndex + 1}`}
                    disabled={!isEditable}
                    onClick={() => onToggleOffense(offenseIndex)}
                    className={`${overlayButton} text-red-700`}
                    style={{ left: pdfPercentX(464), top: pdfPercentTop(pos.y, 21, TRI_X_DOWN_PX - TRI_OFFENSE_UP_PX), width: pdfPercentX(41), height: `${21 / 936 * 100}%` }}
                  >
                    {offenses.includes(offenseIndex) ? 'X' : ''}
                  </button>
                  {offenses.includes(offenseIndex) && (
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="MM/DD/YYYY"
                      aria-label={`Date committed for offense ${offenseIndex + 1}`}
                      value={formatDateInput(offenseDates[String(offenseIndex)] || '')}
                      onChange={e => onOffenseDateChange(offenseIndex, parseDateInput(e.target.value))}
                      disabled={!isEditable}
                      className="absolute z-20 bg-white/90 px-0.5 text-[clamp(5px,0.85vw,9px)] text-center outline-none"
                      style={{
                        left: pdfPercentX(507),
                        top: pdfPercentTop(pos.y, 18, TRI_X_DOWN_PX - TRI_OFFENSE_UP_PX),
                        width: pdfPercentX(50),
                        height: `${18 / 936 * 100}%`,
                      }}
                    />
                  )}
                </React.Fragment>
              ))}
            </div>
          ))}
          <div className="relative w-full overflow-hidden bg-white shadow-lg" style={{ aspectRatio: '612 / 936' }}>
            <PdfPage pageNumber={7} width={pdfRenderWidth} renderTextLayer={false} renderAnnotationLayer={false} className="absolute inset-0 h-full w-full" />
            {TRI_OFFENSE_POS.map((pos, offenseIndex) => pos.page === 6 && (
              <React.Fragment key={`offense-${offenseIndex}`}>
                <button
                  type="button"
                  aria-label={`Offense ${offenseIndex + 1}`}
                  disabled={!isEditable}
                  onClick={() => onToggleOffense(offenseIndex)}
                  className={`${overlayButton} text-red-700`}
                  style={{ left: pdfPercentX(464), top: pdfPercentTop(pos.y, 21, TRI_X_DOWN_PX - TRI_OFFENSE_UP_PX), width: pdfPercentX(41), height: `${21 / 936 * 100}%` }}
                >
                  {offenses.includes(offenseIndex) ? 'X' : ''}
                </button>
                {offenses.includes(offenseIndex) && (
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="MM/DD/YYYY"
                    aria-label={`Date committed for offense ${offenseIndex + 1}`}
                    value={formatDateInput(offenseDates[String(offenseIndex)] || '')}
                    onChange={e => onOffenseDateChange(offenseIndex, parseDateInput(e.target.value))}
                    disabled={!isEditable}
                    className="absolute z-20 bg-white/90 px-0.5 text-[clamp(5px,0.85vw,9px)] text-center outline-none"
                    style={{
                      left: pdfPercentX(507),
                      top: pdfPercentTop(pos.y, 18, TRI_X_DOWN_PX),
                      width: pdfPercentX(50),
                      height: `${18 / 936 * 100}%`,
                    }}
                  />
                )}
              </React.Fragment>
            ))}
            <span aria-label="Previous Points in TRI" className="absolute z-10 bg-white/70 px-1 text-[clamp(7px,1.2vw,13px)]" style={{ left: pdfPercentX(482), top: pdfPercentTop(277.27, 18) }}>{record?.previousPoints ?? ''}</span>
            <span aria-label="Current Points in TRI" className="absolute z-10 bg-white/70 px-1 text-[clamp(7px,1.2vw,13px)]" style={{ left: pdfPercentX(482), top: pdfPercentTop(256.27, 18) }}>{record?.partOnePoints ?? partOnePoints}</span>
            <span aria-label="Less points in Offenses" className="absolute z-10 bg-white/70 px-1 text-[clamp(7px,1.2vw,13px)]" style={{ left: pdfPercentX(482), top: pdfPercentTop(235.39, 18) }}>{record?.deductions ?? deductions}</span>
            <span aria-label="Total Performance Points" className="absolute z-10 bg-white/70 px-1 text-[clamp(7px,1.2vw,13px)] font-bold" style={{ left: pdfPercentX(482), top: pdfPercentTop(214.39, 18) }}>{displayFinalPoints || String(totalPoints)}</span>
            <span aria-label="Current Adjectival Rating" className="absolute z-10 bg-white/70 px-1 text-[clamp(6px,1vw,11px)] font-bold" style={{ left: pdfPercentX(482), top: pdfPercentTop(193.38, 18) }}>{record?.rating ?? currentRating}</span>
            <span aria-label="Previous Adjectival Rating" className="absolute z-10 bg-white/70 px-1 text-[clamp(6px,1vw,11px)]" style={{ left: pdfPercentX(482), top: pdfPercentTop(172.37, 18) }}>{record?.previousRating ?? ''}</span>
          </div>
          <div className="relative w-full overflow-hidden bg-white shadow-lg" style={{ aspectRatio: '612 / 936' }}>
            <PdfPage pageNumber={8} width={pdfRenderWidth} renderTextLayer={false} renderAnnotationLayer={false} className="absolute inset-0 h-full w-full" />
            {/*
              Page 8 is the official form's "Assessed by" block. Every line is laid
              out the same way, top to bottom: E-Signature (draw with the cursor or
              upload an image, through the shared popup pad), then the name text
              holder on the rule, then the printed position. MARICOR C. NAVARRO and
              NICOLAS Q. REGALARIO have their names pre-printed, so their lines get
              the E-Signature above the printed name only.

              Who writes where: the Houseparent fills in only the Houseparent line; a
              reviewer (Social Worker, Center Head, Admin) fills in the other four.
              Everything locks once the TRI is finalized. The boxes mirror
              triLayout.json, which the backend PDF writer reads too, so the on-screen
              form matches the exported and published PDF.
            */}
            {TRI_SIGNATORIES.map(({ slot, title, hasName }) => {
              const geometry = TRI_SIGNATORY_LAYOUT[slot];
              const finalized = record?.status === 'Finalized';
              const mayWrite = !finalized && (slot === 'houseparent' ? canSignHouseparent : canSignReviewerLines);
              // The Houseparent's name text holder is always offered on the
              // Houseparent line, to the Houseparent and to a reviewer alike, so
              // the name can be entered whoever is completing the page. The
              // Houseparent's E-Signature itself stays theirs alone.
              const mayWriteName = slot === 'houseparent'
                ? !finalized && (canSignHouseparent || canSignReviewerLines)
                : mayWrite;
              const signature = slot === 'houseparent' ? houseparentSignature : signatorySignature(record, slot);
              const typedName = signatoryTypedName(record, slot);
              const shownName = slot === 'houseparent' ? (typedName || houseparentName) : typedName;
              return (
                <React.Fragment key={slot}>
                  <div
                    className="absolute z-20"
                    data-tri-signature-slot={slot}
                    style={{
                      left: pdfPercentX(geometry.x),
                      top: pdfPercentTop(geometry.signatureY + geometry.signatureHeight / 2, geometry.signatureHeight),
                      width: pdfPercentX(geometry.width),
                      height: `${geometry.signatureHeight / 936 * 100}%`,
                    }}
                  >
                    {mayWrite ? (
                      <SignaturePadModal
                        label={`${title} signature`}
                        value={signature}
                        disabled={signatureSaving || finalized}
                        onChange={(value) => (slot === 'houseparent' ? onSaveSignature(value) : onSaveSignatory(slot, { signature: value }))}
                        hint={signature ? 'Change' : 'E-Signature / Upload'}
                      />
                    ) : signature ? (
                      <img src={signature} alt={`${title} signature`} className="h-full w-full object-contain object-bottom" />
                    ) : slot === 'houseparent' && !finalized ? (
                      // Keeps the Houseparent column laid out like the others
                      // (E-Signature above the name) for a reviewer, who cannot
                      // sign on the Houseparent's behalf.
                      <div
                        className="flex h-full w-full items-center justify-center rounded-md border border-dashed border-gray-300 bg-white/60 px-1 text-center leading-tight text-gray-400"
                        style={{ fontSize: 'clamp(5px, 0.8vw, 9px)' }}
                        title="The Houseparent signs this line from their own account"
                      >
                        Houseparent E-Signature
                      </div>
                    ) : null}
                  </div>
                  {hasName && geometry.nameY != null && (
                    <div
                      className="absolute z-20"
                      style={{
                        left: pdfPercentX(geometry.x),
                        top: pdfPercentTop(geometry.nameY + 3, 11),
                        width: pdfPercentX(geometry.width),
                        height: `${11 / 936 * 100}%`,
                      }}
                    >
                      {mayWriteName ? (
                        <TriNameField
                          label={`${title} name`}
                          value={typedName}
                          placeholder={slot === 'houseparent' && houseparentName ? houseparentName : 'Type name'}
                          disabled={signatureSaving}
                          onCommit={(value) => onSaveSignatory(slot, { name: value })}
                        />
                      ) : shownName ? (
                        <span
                          aria-label={`${title} name`}
                          data-tri-signatory-name={slot}
                          className="pointer-events-none block truncate font-bold leading-none text-black"
                          style={{ fontSize: 'clamp(6px, 1vw, 11px)' }}
                        >
                          {shownName}
                        </span>
                      ) : null}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </PdfDocument>
      </div>
    </div>

    {/*
      The violations reference.

      It used to be pinned to the viewport with `fixed`. This editor is a
      full-screen dialog, and the scroll area above is the dialog's `flex-1`
      row — so its bottom edge is exactly the footer's top edge, and `bottom-5`
      therefore landed on top of Save Draft while the panel covered Save &
      Submit. Those are the two controls a Houseparent needs to finish the form,
      and the overlap got worse on a phone, where the footer wraps to two rows.

      It now takes its own row between the form and the footer, so nothing is
      covered at any width, and the panel scrolls inside a bounded height rather
      than growing until it meets the footer.
    */}
    <div className="shrink-0 border-t border-gray-200 bg-gray-50">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-6">
        <button
          type="button"
          onClick={onToggleResidentViolations}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[#2F3E46] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#3d4f58]"
        >
          <Eye className="h-4 w-4" /> {showResidentViolations ? 'Hide Violations' : 'Show Violations'}
        </button>
        <p className="min-w-0 flex-1 text-[11px] text-gray-500">
          Reference the resident's actual incident history while answering this TRI.
        </p>
      </div>

      {showResidentViolations && (
        <div className="max-h-[32vh] overflow-y-auto border-t border-gray-200 bg-white">
          <div className="border-b bg-[#2F3E46] px-4 py-2 text-white">
            <p className="text-xs font-black uppercase tracking-wide">Violations for {child?.name || 'Resident'}</p>
          </div>
          <div className="grid grid-cols-1 gap-2 border-b bg-gray-50 p-3 sm:grid-cols-2">
            <div>
              <Label className="text-[10px] uppercase text-gray-500">From Date</Label>
              <Input type="date" value={violationFromDate} onChange={e => onViolationFromDateChange(e.target.value)} className="mt-1 h-8 text-xs" />
            </div>
            <div>
              <Label className="text-[10px] uppercase text-gray-500">To Date</Label>
              <Input type="date" value={violationToDate} onChange={e => onViolationToDateChange(e.target.value)} className="mt-1 h-8 text-xs" />
            </div>
          </div>
          <div className="p-3">
            {residentViolations.length === 0 ? (
              <p className="py-6 text-center text-xs text-gray-400">No violations found for this resident in the selected date range.</p>
            ) : (
              <div className="space-y-2">
                {residentViolations.map((violation) => (
                  <div key={violation.id} className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-bold text-[#2F3E46]">{violation.type}</p>
                      <Badge variant="outline" className={violation.severity === 'Major' ? 'border-orange-200 text-orange-700 text-[10px]' : 'border-yellow-200 text-yellow-700 text-[10px]'}>{violation.severity}</Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-gray-500">Date committed: {violation.date ? new Date(`${String(violation.date).slice(0,10)}T00:00:00`).toLocaleDateString() : '—'}</p>
                    <p className="text-[11px] text-gray-500">Status: {violation.status || '—'}{violation.offenseNumber ? ` · ${violation.offenseNumber}` : ''}</p>
                    {violation.description && <p className="mt-1 text-[11px] leading-relaxed text-gray-600">{violation.description}</p>}
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3">
              {offenses.length === 0 ? (
                <p className="text-[11px] text-gray-400">Select an offense on Part II of the official TRI first.</p>
              ) : (
                <div className="space-y-2">
                  {offenses.map((offenseIndex) => {
                    const offense = PART_TWO_OFFENSES[offenseIndex];
                    if (!offense) return null;
                    return (
                      <div key={offenseIndex} className="rounded-lg border border-gray-100 bg-gray-50 p-2">
                        <p className="text-[11px] font-semibold text-[#2F3E46]">{offense.label}</p>
                        <Input
                          type="text"
                          inputMode="numeric"
                          placeholder="MM/DD/YYYY"
                          value={formatDateInput(offenseDates[String(offenseIndex)] || '')}
                          onChange={e => onOffenseDateChange(offenseIndex, parseDateInput(e.target.value))}
                          disabled={!isEditable}
                          className={`mt-1 h-8 text-[11px] ${!offenseDates[String(offenseIndex)] ? 'border-red-300 bg-red-50' : ''}`}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}

function openPrintReport(record: TriRecord, child: any, onError?: (message: string) => void) {
  const scores = scoreMapOf(record.responses?.items);
  const offenses: number[] = Array.isArray(record.responses?.offenses) ? record.responses.offenses : [];
  const offenseDates: Record<string, string> = record.responses?.offenseDates || {};
  const partOne = Number(record.partOnePoints || 0);
  const deductions = Number(record.deductions || 0);
  const final = Number(record.finalPoints || 0);

  const sectionsHtml = TRI_PART_ONE.map(sec => {
    const rows = sec.items.map((it, i) => {
      const sc = scores[it.id] || 0;
      const lbl = SCORE_LEGEND.find(l => l.value === sc)?.label || 'Not Scored';
      return `<tr><td class="num">${i + 1}</td><td>${escapeHtml(it.label)}</td><td class="ctr">${sc || '—'}</td><td class="ctr sm">${escapeHtml(lbl)}</td></tr>`;
    }).join('');
    return `<h3>${escapeHtml(sec.section)}</h3><table><thead><tr><th class="num">#</th><th>Indicator</th><th class="ctr">Score</th><th class="ctr">Rating</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');

  const offenseRows = offenses.length
    ? offenses.map(idx => {
        const o = PART_TWO_OFFENSES[idx];
        if (!o) return '';
        return `<tr><td>${escapeHtml(o.label)}</td><td>${escapeHtml(offenseDates[String(idx)] || '—')}</td><td class="ctr">−${o.points}</td></tr>`;
      }).join('')
    : '<tr><td colspan="3" class="sm">No offenses recorded for this period.</td></tr>';

  // The signature block is part of the form, so it prints here too, in the form's
  // order: E-Signature, then the typed (or pre-printed) name, then the rule and
  // position. Each data URL is inlined only after the strict shape check — nothing
  // else can reach the attribute.
  const signatureBlocks = TRI_SIGNATORIES.map(({ slot, title, printedName }) => {
    const signatureDataUrl = signatorySignature(record, slot);
    const signatureImg = SIGNATURE_DATA_URL.test(signatureDataUrl)
      ? `<img src="${signatureDataUrl}" alt="${escapeHtml(title)} signature" />`
      : '<div class="blank"></div>';
    const name = printedName || signatoryLineName(record, slot);
    return `<div class="signed">
    ${signatureImg}
    <div class="name">${name ? escapeHtml(name) : '&nbsp;'}</div>
    <div class="rule">${escapeHtml(title)}</div>
  </div>`;
  }).join('\n  ');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>TRI ${escapeHtml(getPeriodLabel(record.reportingYear, record.reportingMonth))}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; margin: 24px; color: #2F3E46; font-size: 12px; }
  .head { text-align: center; border-bottom: 3px solid #2F3E46; padding-bottom: 8px; margin-bottom: 14px; }
  .head p { margin: 1px 0; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; }
  .head h1 { font-size: 15px; margin: 6px 0 2px; text-transform: uppercase; }
  .meta { display: flex; gap: 18px; border: 1px solid #2F3E46; padding: 8px; margin-bottom: 14px; }
  .meta div { font-size: 11px; }
  .meta b { display: block; font-size: 9px; text-transform: uppercase; color: #666; }
  h3 { font-size: 11px; text-transform: uppercase; margin: 14px 0 4px; background: #f1efe8; padding: 4px 6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #ccc; padding: 3px 6px; text-align: left; vertical-align: top; }
  th { background: #faf8f2; font-size: 10px; text-transform: uppercase; }
  .ctr { text-align: center; } .num { width: 28px; text-align: center; } .sm { font-size: 10px; color: #666; }
  .summary { margin-top: 16px; border: 2px solid #2F3E46; padding: 10px; }
  .summary table { margin-top: 6px; }
  .totals { margin-top: 10px; display: flex; gap: 10px; }
  .totals div { flex: 1; border: 1px solid #ccc; padding: 6px; text-align: center; }
  .totals b { display: block; font-size: 16px; }
  .rating { margin-top: 8px; text-align: center; border: 2px solid #2F3E46; padding: 8px; font-size: 14px; font-weight: 700; text-transform: uppercase; }
  .sign { display: grid; grid-template-columns: repeat(3, 1fr); gap: 26px 20px; margin-top: 26px; align-items: end; }
  .sign .rule { border-top: 1px solid #2F3E46; padding-top: 4px; font-size: 9px; text-align: center; text-transform: uppercase; }
  .sign .signed img { display: block; margin: 0 auto 2px; height: 30px; max-width: 100%; object-fit: contain; }
  .sign .signed .blank { height: 32px; }
  .sign .signed .name { text-align: center; font-size: 9px; font-weight: 600; min-height: 12px; }
  @media print { body { margin: 10px; } }
</style></head><body>
<div class="head">
  <p>Republic of the Philippines</p><p>Province of Laguna</p>
  <p>City Government of Calamba</p><p>City Social Services Department</p>
  <p><b>Second Chance Home</b></p>
  <h1>Treatment &amp; Rehabilitation Indicator (TRI)</h1>
  <p>Period: ${escapeHtml(getPeriodLabel(record.reportingYear, record.reportingMonth))} &nbsp;|&nbsp; Status: ${escapeHtml(record.status)}</p>
  ${record.submittedBy ? `<p class="sm">Submitted by: ${escapeHtml(record.submittedBy)}${record.submittedAt ? ` on ${escapeHtml(new Date(record.submittedAt).toLocaleDateString('en-PH'))}` : ''}</p>` : ''}
</div>
<div class="meta">
  <div style="flex:2"><b>Name of Resident</b>${escapeHtml(child?.name || record.residentId)}</div>
  <div><b>Age</b>${escapeHtml(child?.age ?? '—')}</div>
  <div><b>Birthday</b>${escapeHtml(child?.birthDate || '—')}</div>
  <div><b>Period</b>${escapeHtml(getPeriodLabel(record.reportingYear, record.reportingMonth))}</div>
</div>
${sectionsHtml}
<div class="summary">
  <h3 style="margin-top:0">Homelife Discipline — Offenses / Misdemeanors Committed</h3>
  <table><thead><tr><th>Offense</th><th> Date Committed</th><th class="ctr">Less Points</th></tr></thead><tbody>${offenseRows}</tbody></table>
  <div class="totals">
    <div><span>Previous Points in TRI</span><b>${record.previousPoints ?? '—'}</b></div>
    <div><span>Current Points — Part I</span><b>${partOne}</b></div>
    <div><span>Less Points in Offenses</span><b>−${deductions}</b></div>
    <div><span>Total Performance</span><b>${final}</b></div>
  </div>
  <div class="rating">Adjectival Rating: ${escapeHtml(record.rating || 'Not yet rated')}</div>
  <div class="sm" style="text-align:center;margin-top:6px">Previous Adjectival Rating: ${escapeHtml(record.previousRating || '—')}</div>
</div>
<div class="sign">
  ${signatureBlocks}
</div>
</body></html>`;

  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) {
    const message = 'Your browser blocked the new window. Allow pop-ups for this site, then export the TRI report again.';
    if (onError) onError(message); else console.error('TRI print window blocked.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch { /* user can print manually */ } }, 400);
}

export function Tri() {
  const { user } = useAuth();
  const { canOpenModule } = usePermissions();
  const { children, violations: allViolations } = useData();
  const role = (user?.role || '').toLowerCase();
  // Reviewers: Social Worker, Center Head and Admin (matches backend canReview()).
  const canReview = ['socialworker','centerhead','admin'].includes(role);
  const isHouseparent = role === 'houseparent';
  /**
   * The discharge-recommendation dialog offers "Review Resident", which opens
   * `/children/:id` — guarded by the Child Records module. The Houseparent
   * reaches this dialog from TRI but holds no Child Records, so the action is
   * withheld rather than left to 403.
   */
  const canOpenResidentProfile = canOpenModule('Child Records');
  // The tabs are the module's own submenus as the RBAC definition declares
  // them, so a role sees exactly the tabs it holds. `?tab=` is kept as a deep
  // link so a notification or cross-module button can open a specific one; a
  // link to a tab the account may not open falls back to the first reachable
  // tab.
  //
  // The strip used to be a hardcoded trio rendered under
  // `(canManageCaseload || isHouseparent)`, so a role holding the Houseparent
  // module but neither of those names saw no tabs at all, and changing a
  // role's tabs needed a UI edit as well as a matrix edit.
  const tabs = useSubModuleTabs('Houseparent');
  const tabKeys = useMemo(() => tabs.map((tab) => tab.key), [tabs]);
  const [activeTab, setActiveTab] = useSubModuleTab(tabKeys, tabs[0]?.key);

  // ── state
  const [records, setRecords] = useState<TriRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Confirmations and outcomes for every workflow transition. The inline
  // `error` box stays for the messages that belong next to the form (which
  // items are still unscored); the transitions get a dialog, because a
  // `window.confirm` here titled itself "localhost:5173 says…".
  const dialog = useSystemDialog();
  const [selectedRecord, setSelectedRecord] = useState<TriRecord | null>(null);
  const [viewHistory, setViewHistory] = useState(false);
  /** Houseparent signature: in-flight flag and the "saved" acknowledgement. */
  const [signatureSaving, setSignatureSaving] = useState(false);
  const [signatureSaved, setSignatureSaved] = useState<string | null>(null);

  /**
   * The fallback name for the page-8 "Houseparent" line, used as the text
   * holder's placeholder and printed only when no name has been typed in.
   * Prefers whoever actually signed, then whoever submitted, then the signed-in
   * Houseparent for a record not yet submitted.
   */
  const houseparentName = selectedRecord?.houseparentSignedBy
    || selectedRecord?.submittedBy
    || (isHouseparent ? user?.username || '' : '');

  // ── digital form state
  const [form, setForm] = useState(getInitialForm);
  const [showForm, setShowForm] = useState(false);
  const [showResidentPicker, setShowResidentPicker] = useState(false);
  const [currentPart, setCurrentPart] = useState<1 | 2>(1);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dischargeRecommendation, setDischargeRecommendation] = useState<TriRecord['dischargeRecommendation'] | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [showReturnDialog, setShowReturnDialog] = useState(false);
  const [showFinalizeDialog, setShowFinalizeDialog] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // ── filters
  // Supports deep links such as /tri?residentId=XXX (used by the notification "View" action).
  const [filterResident, setFilterResident] = useState(
    () => new URLSearchParams(window.location.search).get('residentId') || 'all'
  );
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterRating, setFilterRating] = useState('all');
  const [filterYear, setFilterYear] = useState('');
  const [filterMonth, setFilterMonth] = useState('');
  const [showFilter, setShowFilter] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const recordIdParam = new URLSearchParams(window.location.search).get('recordId');

  // ── violations
  const [violations, setViolations] = useState<any[]>([]);
  const [detected, setDetected] = useState<any[]>([]);
  const [loadingViolations, setLoadingViolations] = useState(false);
  const [showResidentViolations, setShowResidentViolations] = useState(false);
  const [violationFromDate, setViolationFromDate] = useState('');
  const [violationToDate, setViolationToDate] = useState('');

  const [caseload, setCaseload] = useState<TriCaseloadEntry[]>([]);
  const [loadingCaseload, setLoadingCaseload] = useState(false);

  useEffect(() => {
    if (!isHouseparent) {
      setCaseload([]);
      setLoadingCaseload(false);
      return;
    }

    let cancelled = false;
    setLoadingCaseload(true);
    request<{ success: boolean; data?: TriCaseloadEntry[] }>('/resident-assignments/caseload', { method: 'GET' })
      .then((response) => {
        if (!cancelled) setCaseload(response?.success ? response.data || [] : []);
      })
      .catch(() => {
        if (!cancelled) setCaseload([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCaseload(false);
      });

    return () => { cancelled = true; };
  }, [isHouseparent]);

  const myCaseload = useMemo(() => {
    if (!isHouseparent) return null;
    const currentUserId = String((user as any)?.id || '');
    const currentUsername = String((user as any)?.username || '').toLowerCase();
    return caseload.find((entry) =>
      (currentUserId && String(entry.userId) === currentUserId) ||
      (currentUsername && String(entry.username || '').toLowerCase() === currentUsername)
    ) || null;
  }, [caseload, isHouseparent, user]);

  const activeResidents = useMemo(() => {
    const all = children.filter(c => c.status === 'Active');
    if (!isHouseparent) return all;
    const assignedIds = new Set((myCaseload?.residents || []).map((resident) => resident.id));
    return all.filter((child) => assignedIds.has(child.id));
  }, [children, isHouseparent, myCaseload]);

  // Derived from the current year so the filter does not go stale over time.
  const yearOptions = useMemo(() => {
    const current = new Date().getFullYear();
    return Array.from({ length: 5 }, (_, i) => current - 3 + i);
  }, []);

  // ── computed form values (declared before handlers that use them)
  const scoredCount = itemsToArray(form.responses?.items).length;
  const allPartOneScored = scoredCount === TOTAL_ITEMS;
  const partOneTotal = Object.values(form.responses?.items || {}).reduce((s: number, n: any) => s + (Number(n) || 0), 0);
  const manualDeductions = offenseTotal(form.responses?.offenses);
  const finalPoints = Math.max(0, partOneTotal - manualDeductions);
  const computedRating = ratingForPoints(finalPoints);
  // previousPoints/previousRating are captured when the record is created, from the
  // resident's last Finalized TRI. They were rendered onto the PDF mirror but the
  // comparison was never spelled out, so nobody could see whether a resident moved
  // up or down a band. Live values are used so the trend updates as items are scored.
  const recordTrend = triTrend(
    { rating: computedRating, finalPoints },
    selectedRecord ? { rating: selectedRecord.previousRating, finalPoints: selectedRecord.previousPoints } : null
  );
  // Reviewers get view-only. A submitted TRI can only be approved or returned for
  // revision, never edited — so the editor's Save Draft / Save & Submit controls
  // disappear for them automatically, because the footer is gated on `isEditable`.
  const canEditFn = (rec: TriRecord | null) => !rec || ['Draft', 'Returned', 'For Reassessment'].includes(rec.status);
  const isEditable = canEditFn(selectedRecord);
  const residentViolations = useMemo(() => {
    if (!form.residentId) return [] as ResidentViolation[];
    return (allViolations || [])
      .filter((v: any) => String(v?.residentId || '') === String(form.residentId))
      .filter((v: any) => {
        const date = String(v?.date || '').slice(0, 10);
        if (violationFromDate && date < violationFromDate) return false;
        if (violationToDate && date > violationToDate) return false;
        return true;
      })
      .sort((a: any, b: any) => String(b?.date || '').localeCompare(String(a?.date || ''))) as ResidentViolation[];
  }, [allViolations, form.residentId, violationFromDate, violationToDate]);

  // ── load records
  const fetchRecords = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (filterResident && filterResident !== 'all') params.set('residentId', filterResident);
      if (filterStatus && filterStatus !== 'all') params.set('status', filterStatus);
      if (filterYear) params.set('year', filterYear);
      if (filterMonth) params.set('month', filterMonth);
      const qs = params.toString();
      const result = await request<{ success: boolean; data: TriRecord[] }>(qs ? '/tri?' + qs : '/tri');
      setRecords(result.data || []);
    } catch (err: any) { setError(err?.message || 'Failed to load TRI records'); setRecords([]); }
    finally { setLoading(false); }
  }, [filterResident, filterStatus, filterYear, filterMonth]);

  useEffect(() => { fetchRecords(); }, [fetchRecords]);

  useEffect(() => {
    if (!recordIdParam || records.length === 0) return;
    const target = records.find(r => r.id === recordIdParam);
    if (target) openRecord(target);
  }, [recordIdParam, records]);

  // ── load violations for the resident + period currently open in the form
  useEffect(() => {
    if (showForm && form.residentId && form.reportingYear && form.reportingMonth) {
      loadViolations(form.residentId, form.reportingYear, form.reportingMonth);
    } else { setViolations([]); setDetected([]); }
  }, [showForm, form.residentId, form.reportingYear, form.reportingMonth]);

  async function loadViolations(residentId: string, year: number, month: number) {
    setLoadingViolations(true);
    try {
      const [vRes, dRes] = await Promise.all([
        request('/tri/resident/' + residentId + '/violations?year=' + year + '&month=' + month),
        request('/tri/resident/' + residentId + '/deductions?year=' + year + '&month=' + month),
      ]);
      const vList = (vRes as any).data || [];
      const dList = (dRes as any).data?.details || [];
      setViolations(vList);
      setDetected(dList);

    } catch { setViolations([]); setDetected([]); }
    finally { setLoadingViolations(false); }
  }

  function setScore(id: string, score: number) {
    setForm(prev => ({
      ...prev,
      responses: {
        ...prev.responses,
        items: { ...(prev.responses?.items || {}), [id]: score },
      },
    }));
  }

  function setRoom(room: string) {
    setForm(prev => ({ ...prev, responses: { ...prev.responses, room } }));
  }

  function setPeriod(year: number, month: number) {
    setForm(prev => ({ ...prev, reportingYear: year, reportingMonth: month }));
  }

  function toggleOffense(idx: number) {
    setForm(prev => {
      const offenses: number[] = Array.isArray(prev.responses?.offenses) ? prev.responses.offenses : [];
      const next = offenses.includes(idx) ? offenses.filter(i => i !== idx) : [...offenses, idx];
      const offenseDates = { ...(prev.responses?.offenseDates || {}) };
      if (!next.includes(idx)) delete offenseDates[String(idx)];
      return { ...prev, responses: { ...prev.responses, offenses: next, offenseDates } };
    });
  }

  function setOffenseDate(idx: number, date: string) {
    setForm(prev => ({
      ...prev,
      responses: {
        ...prev.responses,
        offenseDates: { ...(prev.responses?.offenseDates || {}), [String(idx)]: date },
      },
    }));
  }

  // ── form actions
  function startNew() {
    setForm(getInitialForm());
    setSelectedRecord(null); setReviewNotes('');
    setCurrentPart(1);
    setShowResidentPicker(true);
  }

  async function beginNewForResident(residentId: string) {
    if (!residentId) return;
    setError(null);
    try {
      const res = await request<{ success: boolean; data: TriRecord[] }>(
        `/tri?residentId=${encodeURIComponent(residentId)}&year=${form.reportingYear}&month=${form.reportingMonth}`
      );
      const existing = Array.isArray(res.data) ? res.data : [];
      if (existing.length > 0) {
        const editable = existing.find(r => ['Returned', 'For Reassessment', 'Draft'].includes(r.status));
        if (editable) {
          openRecord(editable);
          setShowResidentPicker(false);
          setError(editable.reviewNotes
            ? `A TRI already exists for this resident and month and was returned for revision. Reviewer note: ${editable.reviewNotes}`
            : 'A TRI already exists for this resident and month. The existing editable record has been opened.');
          return;
        }
        setError('A TRI already exists for this resident and month and cannot be created again until that record is returned for revision.');
        return;
      }
    } catch (err: any) {
      setError(err?.message || 'Unable to check whether a TRI already exists for this resident and month.');
      return;
    }
    setForm(prev => ({ ...prev, residentId }));
    setShowResidentPicker(false);
    setShowForm(true);
  }

  function openRecord(record: TriRecord) {
    const parsed = JSON.parse(JSON.stringify(record.responses || {}));
    if (Array.isArray(parsed.items)) {
      parsed.items = parsed.items.reduce((acc: any, it: any) => { if (it?.id && Number(it?.score) > 0) acc[it.id] = Number(it.score); return acc; }, {});
    }
    if (!Array.isArray(parsed.offenses)) parsed.offenses = [];
    if (!parsed.offenseDates || typeof parsed.offenseDates !== 'object') parsed.offenseDates = {};
    setForm({
      residentId: record.residentId,
      reportingYear: record.reportingYear, reportingMonth: record.reportingMonth,
      responses: parsed,
    });
    setSelectedRecord(record);
    setReviewNotes(record.reviewNotes || '');
    setCurrentPart(1);
    setShowForm(true);
  }

  function closeForm() { setShowForm(false); setSelectedRecord(null); setCurrentPart(1); setForm(getInitialForm()); setShowResidentViolations(false); setViolationFromDate(''); setViolationToDate(''); }

  // The backend rejects a second editable TRI for the same resident + period (409).
  // Rather than surfacing the raw error, open the record that already exists.
  async function recoverExistingDraft(err: any): Promise<boolean> {
    if (!/already exists/i.test(err?.message || '')) return false;
    try {
      const res = await request<{ success: boolean; data: TriRecord[] }>(
        `/tri?residentId=${encodeURIComponent(form.residentId)}&year=${form.reportingYear}&month=${form.reportingMonth}`
      );
      const existing = (res.data || []).find(r => ['Draft', 'Returned', 'For Reassessment'].includes(r.status));
      if (!existing) return false;
      openRecord(existing);
      setError('An editable TRI already exists for this resident and period — opened the existing record.');
      return true;
    } catch { return false; }
  }

  async function handleSaveDraft() {
    if (!validateOffenseDates()) return;
    if (!form.residentId) { setError('Please select a resident'); return; }
    setSaving(true); setError(null);
    try {
      const responses = buildResponses(form);
      if (selectedRecord) {
        const result = await request<{ success: boolean; data: TriRecord }>('/tri/' + selectedRecord.id, { method: 'PUT', body: JSON.stringify({ responses }) });
        setRecords(prev => prev.map(r => r.id === result.data.id ? result.data : r));
        setSelectedRecord(result.data);
      } else {
        const result = await request<{ success: boolean; data: TriRecord }>('/tri', { method: 'POST', body: JSON.stringify({ residentId: form.residentId, reportingYear: form.reportingYear, reportingMonth: form.reportingMonth, responses }) });
        setRecords(prev => [result.data, ...prev]);
        setSelectedRecord(result.data);
      }
      await dialog.success(
        'Draft saved.',
        'Your answers are stored. You can come back to this TRI at any time before submitting it for review.',
      );
    } catch (err: any) {
      if (!await recoverExistingDraft(err)) {
        setError(describeError(err, 'Failed to save the draft.'));
        await dialog.failure('Could not save the draft', describeError(err, 'The draft was not saved. Please try again.'));
      }
    }
    finally { setSaving(false); }
  }


  function validateOffenseDates(): boolean {
    const missing = missingOffenseDates(form);
    if (missing.length > 0) {
      setCurrentPart(2);
      setError(`Please enter the Date Committed for every offense marked with an X. Missing: ${missing.join('; ')}`);
      return false;
    }

    return true;
  }

  /**
   * The record a signature is saved onto, creating it from the form on screen when
   * the preparer has not saved a draft yet.
   *
   * Signing used to demand a draft first: `handleSaveSignature` returned early when
   * there was no record, so the first signature a Houseparent drew was silently
   * discarded and they had to Save Draft and sign again. The form is the source of
   * truth, so the record is created from it here. A draft already holding the same
   * resident and period is adopted instead of duplicated, and the form on screen is
   * written onto it so nothing typed is lost to the adoption.
   */
  async function ensureRecordForSignature(): Promise<TriRecord | null> {
    if (selectedRecord) return selectedRecord;
    if (!form.residentId) { setError('Please select a resident'); return null; }

    const responses = buildResponses(form);
    let record: TriRecord | null = null;
    try {
      const created = await request<{ success: boolean; data: TriRecord }>('/tri', {
        method: 'POST',
        body: JSON.stringify({ residentId: form.residentId, reportingYear: form.reportingYear, reportingMonth: form.reportingMonth, responses }),
      });
      record = created.data;
    } catch (err: any) {
      if (!/already exists/i.test(err?.message || '')) {
        setError(err?.message || 'Failed to save the signature');
        return null;
      }
      const res = await request<{ success: boolean; data: TriRecord[] }>(
        `/tri?residentId=${encodeURIComponent(form.residentId)}&year=${form.reportingYear}&month=${form.reportingMonth}`
      );
      const existing = (res.data || []).find(r => ['Draft', 'Returned', 'For Reassessment'].includes(r.status));
      if (!existing) {
        setError('An editable TRI already exists for this resident and period.');
        return null;
      }
      const saved = await request<{ success: boolean; data: TriRecord }>(`/tri/${existing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ responses }),
      });
      record = saved.data;
    }

    setRecords(prev => prev.some(r => r.id === record!.id)
      ? prev.map(r => r.id === record!.id ? record! : r)
      : [record!, ...prev]);
    setSelectedRecord(record);
    return record;
  }

  /**
   * What still stands between the form on screen and a submission, as a sentence
   * fragment — or '' when nothing does.
   */
  function submissionBlocker(): string {
    if (!allPartOneScored) {
      return `${scoredCount}/${TOTAL_ITEMS} Part I items are still unscored, so it stays a draft.`;
    }
    const missing = missingOffenseDates(form);
    if (missing.length) {
      return `Date Committed is still missing for ${missing.join('; ')}, so it stays a draft.`;
    }
    return '';
  }

  /**
   * Saves the Houseparent's drawn signature onto the TRI record. The form's last
   * page carries a "Houseparent" signature line; this is what fills it in, and the
   * generated PDF stamps it there.
   *
   * Signing is the last thing a preparer does, so it is also allowed to be the
   * first thing they touch: the record is created on the spot, and a signed form
   * with nothing left to fill in goes straight to review rather than waiting for a
   * second button. The completeness gates are the ones Submit uses, so a signature
   * can never push an unfinished TRI past the reviewer's queue.
   */
  async function handleSaveSignature(signature: string) {
    // Nothing to clear and nothing to sign onto yet: creating a draft just to store
    // an empty signature would leave a stray record behind.
    if (!signature && !selectedRecord) return;
    setSignatureSaving(true);
    setError(null);
    try {
      const target = await ensureRecordForSignature();
      if (!target) return;

      const result = await request<{ success: boolean; data: TriRecord }>(
        '/tri/' + target.id + '/signature',
        { method: 'POST', body: JSON.stringify({ signature }) },
      );
      let updated = result.data;
      setRecords(prev => prev.map(r => r.id === updated.id ? updated : r));
      setSelectedRecord(updated);

      const editable = ['Draft', 'Returned', 'For Reassessment'].includes(updated.status);
      const blocker = signature && editable ? submissionBlocker() : '';

      if (signature && editable && !blocker) {
        const submitted = await request<{ success: boolean; data: TriRecord }>('/tri/' + updated.id + '/submit', { method: 'POST' });
        updated = submitted.data;
        setRecords(prev => prev.map(r => r.id === updated.id ? updated : r));
        setSelectedRecord(updated);
        if (updated.dischargeRecommendation?.thresholdReached) {
          setDischargeRecommendation(updated.dischargeRecommendation);
        }
        setSignatureSaved('Signature saved — submitted for review.');
        await fetchRecords();
      } else if (!signature) {
        setSignatureSaved('Signature removed.');
      } else {
        setSignatureSaved(`Signature saved.${blocker ? ` ${blocker}` : ''}`);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to save the signature');
    } finally {
      setSignatureSaving(false);
    }
  }

  /**
   * Saves a typed name or an E-Signature on one of the page-8 lines other than the
   * Houseparent's own signature (which keeps `handleSaveSignature` and its
   * submit-on-sign behaviour): the Houseparent's name, and the Administrative
   * Officer, SWO I / Case Manager, MARICOR C. NAVARRO and NICOLAS Q. REGALARIO
   * lines. The server decides who may write each line.
   */
  async function handleSaveSignatory(slot: TriSignatorySlot, patch: { name?: string; signature?: string }) {
    const clearing = (patch.name === undefined || patch.name === '') && (patch.signature === undefined || patch.signature === '');
    if (clearing && !selectedRecord) return;
    setSignatureSaving(true);
    setError(null);
    try {
      const target = await ensureRecordForSignature();
      if (!target) return;
      const result = await request<{ success: boolean; data: TriRecord; message?: string }>(
        '/tri/' + target.id + '/signatories',
        { method: 'PUT', body: JSON.stringify({ slot, ...patch }) },
      );
      const updated = result.data;
      setRecords(prev => prev.map(r => r.id === updated.id ? updated : r));
      setSelectedRecord(updated);
      setSignatureSaved(result.message || 'Saved.');
    } catch (err: any) {
      setError(err?.message || 'Failed to save the signature line');
    } finally {
      setSignatureSaving(false);
    }
  }

  // Creates the record if needed, then submits. Previously this returned early
  // when no record existed, which made "Save & Submit" dead for new records.
  async function handleSubmit() {
    if (!validateOffenseDates()) return;
    if (!form.residentId) { setError('Please select a resident'); return; }
    if (!allPartOneScored) {
      // The button is deliberately NOT disabled on this condition any more, so this
      // message is reachable. It names the first unanswered row and scrolls to it —
      // with 150 cells across 6 pages, "143/150" alone is not actionable.
      const next = firstUnscoredItem(form.responses?.items);
      setError(
        `Please score all ${TOTAL_ITEMS} Part I items before submitting — ${scoredCount}/${TOTAL_ITEMS} done.` +
        (next ? ` Next unanswered: "${next.label}" (${next.section}).` : '')
      );
      if (next) {
        const target = document.querySelector(`[data-tri-item="${next.id}"]`);
        if (target instanceof HTMLElement) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    // Close this form *before* the confirm, not after the request. The form is a
    // Radix layer; leaving it mounted while `dialog.confirm(...)` opens its own
    // layer means whichever of the two Radix measures "not last" is inlined with
    // `pointer-events: none` and its buttons stop responding. The confirm is the
    // case a user is most likely to hit, because they are still looking at the
    // form when it appears — see ui/modalLayer.ts.
    setShowForm(false);

    // Submitting hands the record to somebody else and locks the form, so it is
    // asked about rather than done on a single click. This replaced a bare
    // button that fired immediately.
    const confirmed = await dialog.confirm({
      title: 'Submit this TRI for review?',
      description: 'It goes to the Social Worker and the Center Head. You will not be able to edit it while it is with them, and they can send it back to you for revision.',
      confirmLabel: 'Submit for review',
      tone: 'warning',
    });
    if (!confirmed) return;

    setSubmitting(true); setError(null);
    try {
      const responses = buildResponses(form);
      let id = selectedRecord?.id;
      if (id) {
        await request('/tri/' + id, { method: 'PUT', body: JSON.stringify({ responses }) });
      } else {
        const created = await request<{ success: boolean; data: TriRecord }>('/tri', {
          method: 'POST',
          body: JSON.stringify({ residentId: form.residentId, reportingYear: form.reportingYear, reportingMonth: form.reportingMonth, responses }),
        });
        id = created?.data?.id;
      }
      if (!id) throw new Error('Could not create the TRI record');
      const result = await request<{ success: boolean; data: TriRecord }>('/tri/' + id + '/submit', { method: 'POST' });
      setRecords(prev => prev.some(r => r.id === result.data.id)
        ? prev.map(r => r.id === result.data.id ? result.data : r)
        : [result.data, ...prev]);
      setSelectedRecord(result.data);
      if (result.data.dischargeRecommendation?.thresholdReached) {
        setDischargeRecommendation(result.data.dischargeRecommendation);
      }
      // The form was closed above, before the confirm — no second close needed.
      await fetchRecords();
      await dialog.success(
        'TRI submitted for review.',
        'The Social Worker and Center Head can now review it. You will be notified if it is returned to you for revision.',
      );
    } catch (err: any) {
      if (!await recoverExistingDraft(err)) {
        setError(describeError(err, 'Failed to submit the TRI.'));
        // The form was already closed above, before the confirm — closing it
        // again here would be a no-op, and doing it *after* an await is the
        // ordering this fix removes.
        await dialog.failure('Could not submit the TRI', describeError(err, 'The TRI was not submitted. Please try again.'));
      }
    }
    finally { setSubmitting(false); }
  }

  async function handleReturn() {
    if (!selectedRecord || !reviewNotes.trim()) return;
    setActionLoading(true); setError(null);
    const notes = reviewNotes.trim();
    // Close the confirmation form before the request, so its Radix layer is
    // gone by the time the outcome dialog opens. Leaving it mounted makes Radix
    // judge the outcome dialog "not the top layer" and inline
    // `pointer-events: none` on it, so OK stops responding — see ui/modalLayer.ts.
    setShowReturnDialog(false);
    setReviewNotes('');
    try {
      const result = await request<{ success: boolean; data: TriRecord }>('/tri/' + selectedRecord.id + '/return', { method: 'POST', body: JSON.stringify({ reviewNotes: notes }) });
      setRecords(prev => prev.map(r => r.id === result.data.id ? result.data : r));
      setSelectedRecord(result.data);
      await dialog.success(
        'TRI returned for revision.',
        'The Houseparent can edit it again and resubmit. Your notes are shown with the record.',
      );
    } catch (err: any) {
      setError(describeError(err, 'Failed to return the TRI.'));
      await dialog.failure('Could not return the TRI', describeError(err, 'The TRI was not returned. Please try again.'));
    }
    finally { setActionLoading(false); }
  }

  async function handleFinalize() {
    if (!selectedRecord) return;
    setActionLoading(true); setError(null);
    // Close before the request and before the refresh: `fetchRecords()` is a
    // second await, so closing afterwards would leave this layer mounted for the
    // whole round trip and the outcome dialog would open underneath it.
    setShowFinalizeDialog(false);
    try {
      const result = await request<{ success: boolean; data: TriRecord }>('/tri/' + selectedRecord.id + '/finalize', { method: 'POST' });
      setRecords(prev => prev.map(r => r.id === result.data.id ? result.data : r));
      setSelectedRecord(result.data);
      await fetchRecords();
      await dialog.success(
        'TRI approved.',
        'The rating is now the resident\'s official monthly result and the record can no longer be edited.',
      );
    } catch (err: any) {
      setError(describeError(err, 'Failed to approve the TRI.'));
      await dialog.failure('Could not approve the TRI', describeError(err, 'The TRI was not approved. Please try again.'));
    }
    finally { setActionLoading(false); }
  }

  const periodRecords = records.slice().sort((a, b) => b.reportingYear - a.reportingYear || b.reportingMonth - a.reportingMonth);

  // Client-side search over the loaded records.
  const filteredRecords = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return periodRecords.filter(r => {
      const name = (children.find(c => c.id === r.residentId)?.name || r.residentId || '').toLowerCase();
      const matchesSearch = !q || name.includes(q);
      const matchesRating = filterRating === 'all' || (r.rating || '') === filterRating;
      return matchesSearch && matchesRating;
    });
  }, [periodRecords, searchTerm, children, filterRating]);

  // ── RENDER: List View
  return (
    <div className="space-y-5 p-2">
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-[#2F3E46] flex items-center gap-2">
            <ClipboardList className="w-6 h-6 text-[#FFD100]" />
            Houseparent
          </h2>

        </div>

      </div>

      {isHouseparent && (
        <Card className="border-amber-200 bg-amber-50/70 shadow-sm">
          <CardContent className="p-3 sm:p-4">
            {(() => {
              const deadline = getLastMondayOfMonth(form.reportingYear || new Date().getFullYear(), form.reportingMonth || (new Date().getMonth() + 1));
              const today = new Date();
              const due = new Date(`${deadline}T23:59:59`);
              const days = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
              return (
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs font-black uppercase tracking-wide text-amber-800">Monthly Submission Deadline</p>
                    <p className="text-sm font-semibold text-[#2F3E46]">
                      TRI and Anecdotal Report are due by {formatDisplayDate(deadline)}.
                    </p>
                  </div>
                  <Badge className={days < 0 ? 'bg-red-100 text-red-700' : days <= 3 ? 'bg-orange-100 text-orange-700' : 'bg-white text-amber-800 border border-amber-200'}>
                    {days < 0 ? 'Overdue' : days === 0 ? 'Due today' : `${days} day${days === 1 ? '' : 's'} left`}
                  </Badge>
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}

      {isHouseparent && (
        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#FFD100]/20">
                  <Users className="h-5 w-5 text-[#2F3E46]" />
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">My Caseload</p>
                  <p className="text-sm font-bold text-[#2F3E46]">
                    {loadingCaseload ? 'Loading…' : myCaseload ? `${myCaseload.assignedCount}/${myCaseload.maxCaseload} residents assigned` : 'No caseload assignment found'}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(myCaseload?.residents || []).map((resident) => (
                  <Badge key={resident.id} variant="outline" className="text-[10px]">{resident.name}</Badge>
                ))}
                {!loadingCaseload && (myCaseload?.residents || []).length === 0 && (
                  <span className="text-xs text-gray-400">No residents assigned.</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* CASE LOAD — restored from the original TRI workflow */}
      {tabs.length > 0 && (
        <div className="flex gap-1 border-b border-gray-200 overflow-x-auto overflow-y-hidden">
          {tabs.map(tab => (
            <button key={tab.key} type="button" onClick={() => setActiveTab(tab.key)} className={`shrink-0 whitespace-nowrap border-b-2 px-4 py-2 text-sm font-semibold transition-colors ${activeTab === tab.key ? 'border-[#FFD100] text-[#2F3E46]' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>{tab.label}</button>
          ))}
        </div>
      )}

      {activeTab === 'caseload' ? (
        <CaseLoad />
      ) : activeTab === 'anecdotal' ? (
        <AnecdotalReports />
      ) : (
      <>

      {/* TRI Statistics — residents per TRI status, from the finalized TRI
          records. `records` changes whenever a TRI is saved, submitted or
          finalized here, which re-reads the counts. */}
      {canReview && <TriStatistics refreshKey={records} />}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="relative w-full lg:max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <Input
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          placeholder="Search resident…"
          className="pl-9"
        />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {role !== 'socialworker' && <Button className="gap-2 bg-[#2F3E46] text-white" size="sm" onClick={startNew}><Plus className="w-4 h-4" /> New TRI</Button>}
        </div>
      </div>

      {/* FILTERS — always visible */}
      {true && (
        <Card><CardContent className="pt-6">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="space-y-2"><Label className="text-xs">Period Year</Label>
              <Select value={filterYear || 'all'} onValueChange={v => setFilterYear(v === 'all' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="All years" /></SelectTrigger>
                <SelectContent><SelectItem value="all">All years</SelectItem>{yearOptions.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-2"><Label className="text-xs">Period Month</Label>
              <Select value={filterMonth || 'all'} onValueChange={v => setFilterMonth(v === 'all' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="All months" /></SelectTrigger>
                <SelectContent><SelectItem value="all">All months</SelectItem>{MONTHS.map((m, i) => <SelectItem key={i+1} value={String(i+1)}>{m}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-2"><Label className="text-xs">Rating</Label>
              <Select value={filterRating} onValueChange={setFilterRating}>
                <SelectTrigger><SelectValue placeholder="All ratings" /></SelectTrigger>
                <SelectContent><SelectItem value="all">All ratings</SelectItem>{['Very Good','Good','Fair','Needs Improvement'].map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="flex items-end"><Button onClick={fetchRecords} className="w-full gap-2 text-xs bg-[#2F3E46] hover:bg-[#3d4f58]">Apply</Button></div>
          </div>
        </CardContent></Card>
      )}

      {error && (<Alert variant="destructive"><AlertCircle className="w-4 h-4"/><AlertDescription>{error}</AlertDescription></Alert>)}

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-gray-300"/></div>
      ) : records.length === 0 ? (
        <Card><CardContent className="py-16 text-center">
          <ClipboardList className="w-12 h-12 text-gray-200 mx-auto mb-3"/>
          <p className="text-gray-400">No TRI records found</p>
        </CardContent></Card>
      ) : filteredRecords.length === 0 ? (
        <Card><CardContent className="py-16 text-center">
          <p className="text-gray-400">No records match “{searchTerm}”</p>
        </CardContent></Card>
      ) : (
        <Card><CardContent className="pt-6">
          <TRIRecordsTable
            records={filteredRecords}
            allChildren={children}
            onView={(r) => { openRecord(r); setViewHistory(false); }}
            onPrint={(r) => openFormalPdfReport(
              r,
              children.find(c => c.id === r.residentId),
              (message) => { void dialog.failure('Could not export the TRI', message); },
            )}
          />
        </CardContent></Card>
      )}

      {/* ── History panel */}
      {viewHistory && selectedRecord && (
        <Card><CardContent className="pt-6">
          <TRIHistoryTable records={periodRecords.filter(r => r.residentId === selectedRecord.residentId)} />
        </CardContent></Card>
      )}

      </>
      )}

      {/* ── DIGITAL FORM DIALOG */}
      <Dialog open={showResidentPicker} onOpenChange={setShowResidentPicker}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Who is this TRI for?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-gray-500">Select a resident before completing the formal TRI.</p>
            <Select onValueChange={beginNewForResident}>
              <SelectTrigger><SelectValue placeholder="Select resident..." /></SelectTrigger>
              <SelectContent>
                {activeResidents.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-gray-400">
                    {isHouseparent ? 'No residents are assigned to your caseload.' : 'No active residents available.'}
                  </div>
                ) : activeResidents.map(c => <SelectItem key={c.id} value={c.id}>{c.name} ({c.id})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── DIGITAL FORM DIALOG */}
      <Dialog open={showForm} onOpenChange={open => { if (!open) closeForm(); }}>
        <DialogContent className="!top-0 !left-0 !h-screen !w-screen !max-h-none !max-w-none !translate-x-0 !translate-y-0 flex flex-col rounded-none bg-white p-0 overflow-hidden">
          {/* Official SCH Header */}
          <DialogHeader className="hidden">
            <div className="text-center space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide">Republic of the Philippines</p>
              <p className="text-xs font-semibold uppercase tracking-wide">Province of Laguna</p>
              <p className="text-sm font-black uppercase tracking-wide">City Government of Calamba</p>
              <p className="text-xs font-semibold uppercase tracking-wide">City Social Services Department</p>
              <p className="text-lg font-black uppercase tracking-widest">Second Chance Home</p>
              <DialogTitle className="pt-2 text-xl font-black uppercase text-[#2F3E46]">
                Treatment & Rehabilitation Indicator (TRI)
              </DialogTitle>
              <p className="text-xs font-bold uppercase tracking-widest text-gray-500">
                {getPeriodLabel(form.reportingYear || new Date().getFullYear(), form.reportingMonth || 1)}
                {selectedRecord ? ` — ${selectedRecord.status}` : ''}
              </p>
            </div>
          </DialogHeader>

          {error && (<div className="mx-6 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>)}

          {/* Acknowledgement for the page-8 pad. The pad closes on save and then shows
              the saved drawing, but that is easy to miss on a page-height form. */}
          {signatureSaved && !error && (
            <div className="mx-6 mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-2 text-sm font-semibold text-green-700">
              {signatureSaved}
            </div>
          )}

          {/* Who submitted this TRI. The record has carried `submittedBy` since it
              was written, but nothing surfaced it — so a Houseparent's submission
              looked identical to anyone else's. */}
          {selectedRecord && (
            <div className="mx-6 mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2 text-xs">
              <span className="font-bold uppercase tracking-wide text-gray-500">Submitted by</span>
              {selectedRecord.submittedBy ? (
                <>
                  <span className="font-semibold text-[#2F3E46]">{selectedRecord.submittedBy}</span>
                  {selectedRecord.submittedAt && (
                    <span className="text-gray-500">
                      on {new Date(selectedRecord.submittedAt).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'long', day: 'numeric' })}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-gray-400 italic">Not yet submitted</span>
              )}
              {selectedRecord.reviewedBy && (
                <>
                  <span className="text-gray-300">|</span>
                  <span className="text-gray-500">
                    {['Rejected', 'For Reassessment'].includes(selectedRecord.status) ? 'Rejected by' : 'Reviewed by'}{' '}
                    <span className="font-medium text-gray-700">{selectedRecord.reviewedBy}</span>
                  </span>
                </>
              )}
              {/* The page-8 signature, stated as a fact for every reader. The signing
                  itself happens on the form and only a Houseparent can do it; a
                  reviewer approves or returns the record instead. */}
              <span className="text-gray-300">|</span>
              {selectedRecord.houseparentSignature ? (
                <span className="text-gray-500">
                  Signed by <span className="font-medium text-gray-700">{selectedRecord.houseparentSignedBy || selectedRecord.submittedBy || '—'}</span>
                  {selectedRecord.houseparentSignedAt && (
                    <> on {new Date(selectedRecord.houseparentSignedAt).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'long', day: 'numeric' })}</>
                  )}
                </span>
              ) : (
                <span className="text-gray-400 italic">Not signed on page 8 yet</span>
              )}
            </div>
          )}

          {/* The page-8 signature is captured on the form itself, so there is no
              separate signing card here any more. What a reader needs from this spot
              is the fact of it, which the strip above states. */}

          {/* Previous vs current. The paper form carries a "Previous Points in TRI /
              Previous Adjectival Rating" block, and the record has stored both since
              it was created — but the comparison was never stated anywhere, so the
              one thing a reviewer actually wants (did this resident move up or down?)
              had to be worked out by hand. Only shown when there is a real earlier
              record; a first TRI gets no strip rather than a meaningless arrow. */}
          {selectedRecord && recordTrend.direction !== 'unknown' && (
            <div
              className="mx-6 mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2 text-xs"
              data-tri-trend={recordTrend.direction}
            >
              <span className="font-bold uppercase tracking-wide text-gray-500">Trend</span>
              <span className="text-gray-500">
                {recordTrend.fromPoints ?? '—'} → <span className="font-semibold text-[#2F3E46]">{recordTrend.toPoints ?? '—'}</span> pts
              </span>
              <span className="text-gray-400">|</span>
              <span className={`font-semibold ${
                recordTrend.direction === 'improved' ? 'text-green-700'
                : recordTrend.direction === 'declined' ? 'text-red-700'
                : 'text-gray-600'
              }`}>{recordTrend.label}</span>
            </div>
          )}

          {/* The reviewer's notes are the entire point of a returned TRI. They were
              being stored and loaded into state but never rendered anywhere, so a
              Houseparent saw a bare "Returned" status with no idea what to fix —
              and resubmitted blind. Shown on Returned records so the preparer knows
              what to change, and kept on Finalized records as review history. */}
          {selectedRecord?.reviewNotes
            && (selectedRecord.status === 'Returned' || selectedRecord.status === 'For Reassessment' || selectedRecord.status === 'Finalized') && (
            <div className={`mx-6 mt-4 rounded-xl border px-4 py-3 ${
              selectedRecord.status === 'For Reassessment' ? 'border-yellow-200 bg-yellow-50' : selectedRecord.status === 'Returned' ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50'
            }`}>
              <p className={`text-xs font-bold uppercase tracking-wide ${
                selectedRecord.status === 'For Reassessment' ? 'text-yellow-800' : selectedRecord.status === 'Returned' ? 'text-red-700' : 'text-gray-500'
              }`}>
                {selectedRecord.status === 'For Reassessment'
                  ? 'For reassessment — reviewer notes'
                  : selectedRecord.status === 'Returned'
                    ? 'Returned for revision — reviewer notes'
                    : 'Reviewer notes'}
              </p>
              <p className="mt-1 text-sm text-[#2F3E46] whitespace-pre-wrap">{selectedRecord.reviewNotes}</p>
              {selectedRecord.reviewedBy && (
                <p className="mt-1 text-[11px] text-gray-500">
                  — {selectedRecord.reviewedBy}
                  {selectedRecord.reviewedAt ? `, ${new Date(selectedRecord.reviewedAt).toLocaleString()}` : ''}
                </p>
              )}
            </div>
          )}

          <OfficialTriEditor
            form={form}
            record={selectedRecord}
            child={children.find(c => c.id === form.residentId)}
            isEditable={isEditable}
            onScore={setScore}
            onToggleOffense={toggleOffense}
            onOffenseDateChange={setOffenseDate}
            onRoomChange={setRoom}
            onPeriodChange={setPeriod}
            residentViolations={residentViolations}
            showResidentViolations={showResidentViolations}
            onToggleResidentViolations={() => setShowResidentViolations(v => !v)}
            violationFromDate={violationFromDate}
            violationToDate={violationToDate}
            onViolationFromDateChange={setViolationFromDate}
            onViolationToDateChange={setViolationToDate}
            houseparentName={houseparentName}
            houseparentSignature={selectedRecord?.houseparentSignature || ''}
            canSignHouseparent={isHouseparent}
            canSignReviewerLines={canReview}
            signatureSaving={signatureSaving}
            onSaveSignature={handleSaveSignature}
            onSaveSignatory={handleSaveSignatory}
          />


          {/* FORM FOOTER */}
          <DialogFooter className="bg-gray-50 px-6 py-4 border-t gap-2 flex-wrap">
            <Button variant="ghost" onClick={closeForm}><CloseIcon className="w-4 h-4" /> Cancel</Button>

            {selectedRecord && (
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => openFormalPdfReport(
                  selectedRecord,
                  children.find(c => c.id === selectedRecord.residentId),
                  (message) => { void dialog.failure('Could not export the TRI', message); },
                )}
              >
                <Download className="w-4 h-4" /> Export
              </Button>
            )}

            {/* Reviewers get exactly two outcomes on a submitted record: approve it,
                or return it for revision with notes. There is no "Review" step and no
                edit — the record is read-only to them from Submitted onwards. */}
            {canReview && selectedRecord && ['Submitted', 'Under Review'].includes(selectedRecord.status) && (
              <Button size="sm" variant="outline" className="gap-2 text-red-600 border-red-200" onClick={() => setShowReturnDialog(true)} disabled={actionLoading}>
                <RotateCcw className="w-4 h-4" /> Send for reassessment
              </Button>
            )}
            {canReview && selectedRecord && ['Submitted', 'Under Review'].includes(selectedRecord.status) && (
              <Button size="sm" variant="outline" className="gap-2" onClick={() => setShowFinalizeDialog(true)} disabled={actionLoading}>
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin"/> : <CheckCheck className="w-4 h-4"/>} Approve
              </Button>
            )}

            {/* Save Draft is offered for a brand-new TRI too. It used to require an
                existing record, which left "score all 150 in one sitting" as the only
                option — no way to stop and come back. */}
            {(!selectedRecord || isEditable) && (
              <Button
                disabled={saving || !form.residentId}
                onClick={handleSaveDraft}
                style={{ backgroundColor: '#FFD100', color: '#2F3E46' }}
                className="font-bold gap-2"
                title="Save your progress without submitting for review"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin"/> : <Save className="w-4 h-4"/>}
                {saving ? 'Saving…' : 'Save Draft'}
              </Button>
            )}
            {(!selectedRecord || isEditable) && (
              <div className="flex items-center gap-2">
                {/* Live progress. The submit button used to be disabled until this read
                    150/150, with no counter and an unreachable error message — so the
                    only signal was a dead button. */}
                <span
                  data-tri-scored-count={scoredCount}
                  className={`text-xs font-semibold tabular-nums ${allPartOneScored ? 'text-green-700' : 'text-amber-700'}`}
                  title={allPartOneScored ? 'All Part I items are scored' : 'Unanswered Part I items are ticked in amber'}
                >
                  {scoredCount}/{TOTAL_ITEMS} scored
                </span>
                <Button
                  disabled={submitting || !form.residentId}
                  onClick={handleSubmit}
                  className="font-bold gap-2 bg-[#2F3E46] hover:bg-[#3d4f58] text-white"
                  title={allPartOneScored ? 'Save and submit for review' : `Submitting now will list what is still unanswered (${scoredCount}/${TOTAL_ITEMS} scored)`}
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin"/> : <Send className="w-4 h-4"/>}
                  {submitting ? 'Submitting…' : selectedRecord?.status === 'For Reassessment' ? 'Resubmit for Review' : 'Save & Submit'}
                </Button>
              </div>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── DISCHARGE REVIEW RECOMMENDATION ── */}
      <Dialog open={Boolean(dischargeRecommendation?.thresholdReached)} onOpenChange={(open) => { if (!open) setDischargeRecommendation(null); }}>
        <DialogContent className="rounded-2xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46]">Behavioral Review Recommendation</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-amber-800">Monthly threshold reached</p>
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div><p className="text-[10px] uppercase text-gray-500">Major violations</p><p className="text-2xl font-black text-orange-700">{dischargeRecommendation?.majorCount ?? 0}</p><p className="text-[10px] text-gray-400">Trigger: 3+</p></div>
                <div><p className="text-[10px] uppercase text-gray-500">Minor violations</p><p className="text-2xl font-black text-yellow-700">{dischargeRecommendation?.minorCount ?? 0}</p><p className="text-[10px] text-gray-400">Trigger: 5+</p></div>
              </div>
            </div>
            <div className="rounded-lg border bg-gray-50 p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">System recommendation</p>
              <p className="text-sm leading-relaxed text-[#2F3E46]">{dischargeRecommendation?.recommendation?.recommendationNote}</p>
            </div>
            <p className="text-xs text-gray-500">No extension has been added automatically. The authorized case-management staff must review the resident's records and decide whether an extension is appropriate.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDischargeRecommendation(null)}>Close</Button>
            {canOpenResidentProfile && (
              <Button onClick={() => { const residentId = form.residentId; setDischargeRecommendation(null); if (residentId) window.location.href = `/children/${residentId}?tab=personal`; }}>Review Resident</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── RETURN DIALOG */}
      <Dialog open={showReturnDialog} onOpenChange={setShowReturnDialog}>
        <DialogContent className="rounded-2xl">
          <DialogHeader><DialogTitle className="text-[#2F3E46]">Send TRI for Reassessment</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <Label>Review Notes <span className="text-red-500">*</span></Label>
            <Textarea value={reviewNotes} onChange={e => setReviewNotes(e.target.value)} placeholder="Explain what needs to be corrected before resubmission..." />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setShowReturnDialog(false); setReviewNotes(''); }}>Cancel</Button>
            <Button className="bg-red-600 hover:bg-red-700" onClick={handleReturn} disabled={actionLoading || !reviewNotes.trim()}>
              {actionLoading ? <Loader2 className="w-4 h-4 animate-spin"/> : null} Send for reassessment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── APPROVE DIALOG */}
      <Dialog open={showFinalizeDialog} onOpenChange={setShowFinalizeDialog}>
        <DialogContent className="rounded-2xl">
          <DialogHeader><DialogTitle className="text-[#2F3E46]">Approve TRI Record</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-500 py-2">Approve this TRI? The rating becomes the resident's official monthly result and the record can no longer be edited. If something needs changing, return it for revision instead.</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowFinalizeDialog(false)}>Cancel</Button>
            <Button className="bg-green-600 hover:bg-green-700" onClick={handleFinalize} disabled={actionLoading}>
              {actionLoading ? <Loader2 className="w-4 h-4 animate-spin"/> : <CheckCheck className="w-4 h-4"/>} Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
