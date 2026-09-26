import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import {
  FileText, Download, Briefcase,
  AlertTriangle, ChevronDown, ChevronUp,
  ClipboardList, Activity, Printer, CheckCircle2, RotateCcw, Loader2, AlertCircle, Eye,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/app/components/ui/dialog';
import { Label } from '@/app/components/ui/label';
import { Checkbox } from '@/app/components/ui/checkbox';
import { Textarea } from '@/app/components/ui/textarea';
import { SignaturePadModal } from '@/app/components/SignaturePad';
import { useSystemDialog } from '@/app/components/SystemDialog';
import { useData } from '../state/DataContext';
import { describeError, request } from '@/services/api';
import { useNavigate } from 'react-router-dom';
import { AnecdotalReports, downloadAnecdotalPdf } from './AnecdotalReports';
import { downloadReportZip, periodZipName } from '@/app/utils/downloadReportZip';
import {
  QuarterlyProgressReportsCard,
  QuarterlyProgressReportEditor,
} from './QuarterlyProgressReport';

// ── DATE HELPER ─────────────────────────────────────────────────────────────
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const formatDate = (dateStr: string) => {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'long', day: 'numeric' });
};

// ── TYPES ───────────────────────────────────────────────────────────────────
interface ReportForm {
  name: string;
  description: string;
  file: string;
  when: string; // when this form is typically used
}

// ── DSWD REPORT GENERATOR COMPONENT ───────────────────────────────────────────
function DSWDReportGenerator({ type }: { type: 'daily' | 'quarterly' }) {
  const { generateDailyReport, generateQuarterlyDSWDReport } = useData();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  /**
   * The two staff signatures the generated report prints. They are captured
   * before the report is produced and embedded into the document it writes —
   * nothing is persisted, so re-generating starts from a blank pad again.
   */
  const [isSignOpen, setIsSignOpen] = useState(false);
  const [preparedBySignature, setPreparedBySignature] = useState('');
  const [approvedBySignature, setApprovedBySignature] = useState('');

  const handleGenerate = async () => {
    setLoading(true);
    setMessage('');
    try {
      const result = type === 'daily' 
        ? await generateDailyReport()
        : await generateQuarterlyDSWDReport();
      if (result) {
        setMessage(type === 'daily' ? 'Daily report generated!' : 'Quarterly DSWD report generated!');
        // Open in new window with professional DSWD formatting
        const reportWindow = window.open('', '_blank');
        if (reportWindow) {
          const isDaily = type === 'daily';
          const reportData = result.report || result;
          const summary = reportData.summary || reportData.statistics || {};
          
          reportWindow.document.write(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <title>${isDaily ? 'DSWD Daily Facility Report' : 'DSWD Quarterly Report'} - ${formatDate(reportData.date)}</title>
              <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; line-height: 1.5; color: #333; background: white; padding: 0; }
                .header { text-align: center; border-bottom: 3px double #1e3a5f; padding: 20px; margin-bottom: 20px; }
                .header .logo-area { margin-bottom: 10px; }
                .header .republic { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #666; }
                .header .department { font-size: 14px; font-weight: bold; color: #1e3a5f; margin: 5px 0; }
                .header .office { font-size: 12px; color: #444; }
                .header .report-title { font-size: 16px; font-weight: bold; color: #1e3a5f; margin-top: 15px; padding-top: 15px; border-top: 1px solid #ccc; }
                .header .report-meta { font-size: 11px; color: #666; margin-top: 5px; }
                .content { padding: 20px; }
                .section { margin-bottom: 20px; }
                .section-title { font-size: 13px; font-weight: bold; color: #1e3a5f; background: #f0f4f8; padding: 8px 12px; border-left: 4px solid #1e3a5f; margin-bottom: 12px; }
                .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px; }
                .summary-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 15px; text-align: center; }
                .summary-card .number { font-size: 24px; font-weight: bold; color: #1e3a5f; }
                .summary-card .label { font-size: 11px; color: #64748b; margin-top: 4px; }
                .summary-card.highlight { background: #1e3a5f; color: white; }
                .summary-card.highlight .number { color: #ffd700; }
                .summary-card.highlight .label { color: #cbd5e1; }
                table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 10px; }
                /* A tablet in portrait is narrower than the widest of these
                   tables, and a phone is narrower than all of them. Wrapping
                   lets the table scroll sideways instead of either squashing
                   every column to one word per line or pushing the page into
                   horizontal overflow. The max-width keeps the wrapper from
                   itself being widened by the table's intrinsic width. */
                .table-scroll { width: 100%; max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
                .table-scroll table { min-width: 520px; }
                th { background: #1e3a5f; color: white; padding: 10px 8px; text-align: left; font-weight: 600; border: 1px solid #1e3a5f; }
                td { padding: 8px; border: 1px solid #e2e8f0; vertical-align: top; }
                tr:nth-child(even) { background: #f8fafc; }
                .footer { margin-top: 40px; padding-top: 20px; border-top: 2px solid #1e3a5f; text-align: center; font-size: 10px; color: #64748b; }
                .signature-area { margin-top: 40px; display: grid; grid-template-columns: 1fr 1fr; gap: 60px; }
                .signature-box { text-align: center; }
                /* The 60px the signature line used to reserve as margin is now
                   an explicit slot, so a drawn signature has somewhere to sit
                   while the printed layout stays exactly as it was. */
                .signature-slot { height: 60px; display: flex; align-items: flex-end; justify-content: center; }
                .signature-slot img { max-height: 58px; max-width: 100%; }
                .signature-line { border-top: 1px solid #333; padding-top: 5px; font-size: 11px; }
                .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 600; }
                .badge-green { background: #dcfce7; color: #166534; }
                .badge-red { background: #fee2e2; color: #991b1b; }
                .badge-yellow { background: #fef9c3; color: #854d0e; }
                .no-print { background: #1e3a5f; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
                .no-print button { background: #ffd700; color: #1e3a5f; border: none; padding: 8px 20px; border-radius: 4px; font-weight: bold; cursor: pointer; margin-left: 10px; }
                .no-print button:hover { background: #f5c700; }
                /*
                  These reports open in a popup, so the viewport is the popup's,
                  not the app's — on a phone that is the full screen width. The
                  breakpoints below keep the summary readable as a 2-up or 1-up
                  grid and pull in the padding, rather than letting four
                  summary cards share ~360px and wrap their labels to shreds.
                  Print output is unaffected: the print media query restores the
                  4-up grid, so the saved PDF is identical to before.
                */
                @media (max-width: 700px) {
                  .content { padding: 12px; }
                  .header { padding: 14px 12px; }
                  .summary-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
                  .summary-card { padding: 12px 8px; }
                  .signature-area { gap: 24px; }
                  .no-print { flex-wrap: wrap; gap: 8px; padding: 12px; }
                  .no-print button { margin-left: 0; }
                }
                @media (max-width: 420px) {
                  .summary-grid { grid-template-columns: 1fr; }
                  .table-scroll table { min-width: 440px; }
                }
                @media print { 
                  .no-print { display: none !important; } 
                  body { padding: 0; }
                  /* The scaled-down grids are a screen affordance; the paper
                     report keeps the four-card summary and the two-column
                     signature block it has always had. */
                  .summary-grid { grid-template-columns: repeat(4, 1fr) !important; gap: 15px !important; }
                  .signature-area { gap: 60px !important; }
                  .content { padding: 20px !important; }
                  .header { padding: 20px !important; }
                  /* Paper cannot scroll. Let wide tables shrink normally. */
                  .table-scroll { overflow: visible !important; }
                  .table-scroll table { min-width: 0 !important; }
                }
              </style>
            </head>
            <body>
              <!-- Print Toolbar -->
              <div class="no-print">
                <span style="font-weight: bold; font-size: 14px;">${isDaily ? 'DSWD Daily Facility Report' : 'DSWD Quarterly Report'}</span>
                <div>
                  <button onclick="window.print()">Print / Save as PDF</button>
                  <button onclick="window.close()" style="background: rgba(255,255,255,0.2); color: white;">Close</button>
                </div>
              </div>

              <!-- Report Header -->
              <div class="header">
                <div class="logo-area">
                  <div class="republic">Republic of the Philippines</div>
                  <div class="department">Department of Social Welfare and Development</div>
                  <div class="office">DSWD Field Office IV-A (CALABARZON)</div>
                </div>
                <div class="report-title">${isDaily ? 'DAILY FACILITY OPERATIONS REPORT' : 'QUARTERLY CICL FACILITY REPORT'}</div>
                <div class="report-meta">
                  <strong>Report ID:</strong> ${reportData.id || 'N/A'} | 
                  <strong>Generated:</strong> ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'full', timeStyle: 'short' })} | 
                  <strong>Report Date:</strong> ${formatDate(reportData.date || reportData.reportDate)}
                </div>
              </div>

              <div class="content">
                <!-- Executive Summary -->
                <div class="section">
                  <div class="section-title">EXECUTIVE SUMMARY</div>
                  <div class="summary-grid">
                    <div class="summary-card ${summary.activeResidents > 0 ? 'highlight' : ''}">
                      <div class="number">${summary.activeResidents || summary.totalResidents || 0}</div>
                      <div class="label">Active Residents</div>
                    </div>
                    <div class="summary-card ${summary.violationsToday > 0 ? 'highlight' : ''}">
                      <div class="number">${summary.violationsToday || summary.totalViolations || 0}</div>
                      <div class="label">${isDaily ? 'Violations Today' : 'Total Violations'}</div>
                    </div>
                    <div class="summary-card">
                      <div class="number">${summary.assessmentsToday || summary.totalAssessments || 0}</div>
                      <div class="label">${isDaily ? 'Assessments Today' : 'Total Assessments'}</div>
                    </div>
                    <div class="summary-card">
                      <div class="number">${summary.courtHearingsToday || summary.courtRecords || 0}</div>
                      <div class="label">${isDaily ? 'Court Hearings Today' : 'Court Records'}</div>
                    </div>
                  </div>
                </div>

                ${summary.newAdmissions !== undefined ? `
                <div class="section">
                  <div class="section-title">RESIDENT DEMOGRAPHICS</div>
                  <div class="table-scroll">
                  <table>
                    <tr>
                      <th>Category</th>
                      <th>Count</th>
                      <th>Status/Notes</th>
                    </tr>
                    <tr>
                      <td>New Admissions</td>
                      <td>${summary.newAdmissions || 0}</td>
                      <td>During reporting period</td>
                    </tr>
                    <tr>
                      <td>Active Residents</td>
                      <td>${summary.activeResidents || 0}</td>
                      <td>Currently in facility</td>
                    </tr>
                    <tr>
                      <td>Completed Program</td>
                      <td>${summary.completedCases || 0}</td>
                      <td>Ready for reintegration</td>
                    </tr>
                  </table>
                  </div>
                </div>
                ` : ''}

                ${summary.violations ? `
                <div class="section">
                  <div class="section-title">VIOLATION SUMMARY</div>
                  <div class="table-scroll">
                  <table>
                    <tr>
                      <th>Metric</th>
                      <th>Count</th>
                      <th>Resolution Rate</th>
                    </tr>
                    <tr>
                      <td>Total Violations</td>
                      <td>${summary.violations.total || 0}</td>
                      <td rowspan="2">${summary.violations.total > 0 ? Math.round((summary.violations.resolved / summary.violations.total) * 100) : 0}% resolved</td>
                    </tr>
                    <tr>
                      <td>Resolved Violations</td>
                      <td>${summary.violations.resolved || 0}</td>
                    </tr>
                  </table>
                  </div>
                </div>
                ` : ''}

                ${summary.assessments && typeof summary.assessments === 'object' ? `
                <div class="section">
                  <div class="section-title">ASSESSMENT SUMMARY</div>
                  <div class="table-scroll">
                  <table>
                    <tr>
                      <th>Metric</th>
                      <th>Count</th>
                      <th>Completion Rate</th>
                    </tr>
                    <tr>
                      <td>Total Assessments</td>
                      <td>${summary.assessments.total || 0}</td>
                      <td rowspan="2">${summary.assessments.total > 0 ? Math.round((summary.assessments.completed / summary.assessments.total) * 100) : 0}% completed</td>
                    </tr>
                    <tr>
                      <td>Completed Assessments</td>
                      <td>${summary.assessments.completed || 0}</td>
                    </tr>
                  </table>
                  </div>
                </div>
                ` : ''}

                ${summary.phaseDistribution && summary.phaseDistribution.length > 0 ? `
                <div class="section">
                  <div class="section-title">PHASE DISTRIBUTION</div>
                  <div class="table-scroll">
                  <table>
                    <tr>
                      <th>Phase</th>
                      <th>Resident Count</th>
                      <th>Percentage</th>
                    </tr>
                    ${summary.phaseDistribution.map((p: any) => `
                    <tr>
                      <td>${p.phase}</td>
                      <td>${p.count}</td>
                      <td>${p.percentage || Math.round((p.count / (summary.activeResidents || 1)) * 100)}%</td>
                    </tr>
                    `).join('')}
                  </table>
                  </div>
                </div>
                ` : ''}

                <!-- Certification -->
                <div class="section" style="margin-top: 40px;">
                  <div class="section-title">CERTIFICATION</div>
                  <p style="font-size: 11px; line-height: 1.6; text-align: justify;">
                    I hereby certify that the above information is true and correct based on the records and documents 
                    available at the Second Chance Home facility. This report is prepared in compliance with DSWD 
                    standards and guidelines for reporting on Children in Conflict with the Law (CICL) rehabilitation 
                    programs.
                  </p>
                </div>

                <!-- Signatures -->
                <div class="signature-area">
                  <div class="signature-box">
                    <div class="signature-slot">${preparedBySignature ? `<img src="${preparedBySignature}" alt="Prepared by signature">` : ''}</div>
                    <div class="signature-line">
                      <strong>Prepared by:</strong><br>
                      Social Worker / Case Manager<br>
                      Date: _______________
                    </div>
                  </div>
                  <div class="signature-box">
                    <div class="signature-slot">${approvedBySignature ? `<img src="${approvedBySignature}" alt="Reviewed/Approved by signature">` : ''}</div>
                    <div class="signature-line">
                      <strong>Reviewed/Approved by:</strong><br>
                      Center Head / Administrator<br>
                      Date: _______________
                    </div>
                  </div>
                </div>
              </div>

              <div class="footer">
                <strong>Second Chance Home - Calamba City, Laguna</strong><br>
                This is an official DSWD report generated by the Second Chance Home Management Information System.<br>
                Document ID: ${reportData.id || 'N/A'} | Generated: ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'full', timeStyle: 'short' })}<br>
                <em>This document is confidential and intended for authorized DSWD personnel only.</em>
              </div>
            </body>
            </html>
          `);
          reportWindow.document.close();
        }
      }
    } catch (err) {
      setMessage('Failed to generate report. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Button 
        variant="outline" 
        size="sm" 
        className="mt-3 w-full gap-2"
        onClick={() => setIsSignOpen(true)}
        disabled={loading}
      >
        {loading ? 'Generating...' : <><Download className="w-4 h-4" /> Generate Now</>}
      </Button>
      {message && (
        <p className={`text-xs mt-2 ${message.includes('Failed') ? 'text-red-500' : 'text-green-600'}`}>
          {message}
        </p>
      )}

      {/* Signatures are collected here rather than after the report opens: the
          report is written once, as a single document, so both signatures have
          to be known before it is produced. */}
      <Dialog open={isSignOpen} onOpenChange={setIsSignOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46]">
              Sign the {type === 'daily' ? 'Daily' : 'Quarterly'} DSWD Report
            </DialogTitle>
            <DialogDescription>
              Both signatures are printed on the report. Leave a pad blank to print
              the form with an empty line instead.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label className="text-sm font-bold">Prepared by — Social Worker / Case Manager</Label>
              <div className="h-28 w-full max-w-[520px]">
                <SignaturePadModal
                  label="Prepared by signature"
                  value={preparedBySignature}
                  onChange={setPreparedBySignature}
                  hint="Tap to sign"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-bold">Reviewed/Approved by — Center Head / Administrator</Label>
              <div className="h-28 w-full max-w-[520px]">
                <SignaturePadModal
                  label="Reviewed and approved by signature"
                  value={approvedBySignature}
                  onChange={setApprovedBySignature}
                  hint="Tap to sign"
                />
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsSignOpen(false)} disabled={loading}>
              Cancel
            </Button>
            <Button
              onClick={() => { setIsSignOpen(false); handleGenerate(); }}
              disabled={loading}
              className="bg-[#2F3E46] text-white gap-2"
            >
              <Download className="w-4 h-4" /> Generate Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── REPORT FORM DEFINITIONS ─────────────────────────────────────────────────

// Social Worker reporting forms
const SW_REPORT_FORMS: ReportForm[] = [
  {
    name: 'Social Worker\'s Notes',
    description: 'Narrative interview notes and case observations.',
    file: '/forms/sw-notes.pdf',
    when: 'After every client interview or session',
  },
  {
    name: 'CSSD Evaluation',
    description: 'CSSD activity/seminar evaluation form.',
    file: '/forms/cssd-evaluation.pdf',
    when: 'After each activity or seminar',
  },
  {
    name: 'Feedback Report',
    description: 'Post-visit or post-hearing case update.',
    file: '/forms/feedback-report.pdf',
    when: 'After court hearings, home visits, or school visits',
  },
  {
    name: 'Visitor Log — Adult',
    description: 'Visitor registration for adult visitors.',
    file: '/forms/visitor-log-adult.pdf',
    when: 'For every adult visit',
  },
  {
    name: 'Visitor Log — Students',
    description: 'Visitor registration for student visitors.',
    file: '/forms/visitor-log-students.pdf',
    when: 'For every student visit',
  },
];


// Mock residents & history (kept from original)
// ── OPEN / DOWNLOAD HELPER ───────────────────────────────────────────────────
function openForm(file: string, name: string) {
  const link = document.createElement('a');
  link.href = file;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.download = name + '.pdf';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ── REPORT GENERATOR ─────────────────────────────────────────────────────────

/** Escapes a value before it is interpolated into the report's HTML. */
function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c] as string
  ));
}

/** Age in whole years on `atDate`, from an ISO birth date. */
function ageOn(birthDate?: string | null, atDate: Date = new Date()): number | null {
  const birth = String(birthDate ?? '').slice(0, 10);
  if (!birth) return null;
  const [by, bm, bd] = birth.split('-').map(Number);
  if (!by || !bm || !bd) return null;
  let age = atDate.getFullYear() - by;
  const monthDiff = atDate.getMonth() + 1 - bm;
  if (monthDiff < 0 || (monthDiff === 0 && atDate.getDate() < bd)) age -= 1;
  return age >= 0 ? age : null;
}

/**
 * Builds the Resident Comprehensive Report and opens it in a new window.
 *
 * ── WHY THIS TAKES DATA AS ARGUMENTS ─────────────────────────────────────────
 * Everything it prints is passed in from `useData()`. It previously reached for
 * two sources that are no longer authoritative:
 *
 *   - Activity Participation read `localStorage.activitiesRecords`, which is only
 *     DataContext's cache. On a browser that had never cached the module the
 *     section reported "No activity records" even though the database held them,
 *     and otherwise it printed whatever the last write had persisted.
 *   - Behavioral Assessment read `child.behavioralLogs`, which ChildDetail labels
 *     "Legacy Incident Logs (Pre-Migration)". Live violations are in `violations`,
 *     so the section claimed "No violations recorded" for every current resident.
 *
 * The report is also named a *discharge* report and carried no discharge
 * information at all, despite `/discharge-plans/resident/:id` and the
 * `dischargeExtensions` / `dischargeRecommendations` tables holding exactly that.
 */
async function generateResidentReport(
  children: any[],
  selectedIds: string[],
  allAssessments: any[],
  live: { activities?: any[]; violations?: any[]; documents?: any[] } = {},
  target?: Window | null
) {
  const selected = children.filter(c => selectedIds.includes(c.id));
  if (selected.length === 0) return;

  const activities = Array.isArray(live.activities) ? live.activities : [];
  const violations = Array.isArray(live.violations) ? live.violations : [];
  const documents = Array.isArray(live.documents) ? live.documents : [];

  // The discharge plan is per resident and lives behind its own endpoint. A
  // caller who is not assigned to the resident gets a 403, which is not an error
  // worth failing the whole report over — the section is simply omitted.
  const plans: Record<string, any> = {};
  await Promise.all(selected.map(async (child) => {
    try {
      const response = await request<{ data: any }>(`/discharge-plans/resident/${encodeURIComponent(child.id)}`);
      plans[child.id] = response?.data || null;
    } catch {
      plans[child.id] = null;
    }
  }));

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });

  const renderChild = (child: any, plan: any) => {
    const childAssessments = allAssessments.filter(a =>
      Array.isArray(a.forResidents) && a.forResidents.includes(child.id)
    );
    const childViolations = violations
      .filter(v => v.residentId === child.id)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const childActivities = activities
      .filter(a => Array.isArray(a.selectedResidentIds) && a.selectedResidentIds.includes(child.id))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const childDocuments = documents.filter(d => d.residentId === child.id);

    const section = (title: string, content: string) => `
      <div class="section">
        <div class="section-title">${esc(title)}</div>
        ${content}
      </div>`;

    const row = (label: string, value: string) =>
      `<div class="row"><span class="label">${esc(label)}</span><span class="value">${value || '—'}</span></div>`;

    const age = ageOn(child.birthDate, now);

    const personalInfo = section('Personal Information', `
      ${row('Full Name', esc(child.name))}
      ${row('ID', esc(child.id))}
      ${row('Age', age === null ? '' : `${age} years old`)}
      ${row('Gender', esc(child.gender))}
      ${row('Date of Birth', child.birthDate ? esc(formatDate(child.birthDate)) : '')}
      ${row('Address', esc(child.address || ''))}
      ${row('Date of Admission', esc(formatDate(child.admissionDate)))}
    `);

    const caseProgress = section('Case Progress', `
      ${row('Case Type / Offense', esc(child.caseType))}
      ${row('Legal Category', esc(child.legalCategory))}
      ${row('Rehabilitation Phase', esc(child.casePhase))}
      ${row('Repeat Offender', child.isRepeatOffender ? 'Yes' : 'No')}
      ${child.isRepeatOffender && child.previousCaseDetails
        ? row('Previous Case Details', esc(child.previousCaseDetails)) : ''}
      ${row('Documents Complete', child.documentsComplete ? 'Yes' : 'Pending')}
    `);

    // Medical records come from two places: the Documents module's Medical
    // category, which is where uploads land now, and the legacy
    // `children.medicalRecords` JSON that predates it. Both are shown, de-duped
    // by name, so nothing disappears for residents whose history is split.
    const medicalInfo = section('Medical Records', (() => {
      const fromDocuments = childDocuments
        .filter(d => d.category === 'Medical')
        .map(d => ({
          name: d.title,
          category: 'Medical',
          dateUploaded: d.uploadedAt ? String(d.uploadedAt).split('T')[0] : (d.approvedAt ? String(d.approvedAt).split('T')[0] : '—'),
        }));
      const legacy = (child.medicalRecords || [])
        .filter((r: any) => !fromDocuments.some(d => d.name === r.name));
      const records = [...fromDocuments, ...legacy];
      if (records.length === 0) return '<p class="empty">No medical records on file.</p>';
      return `<table>
        <thead><tr><th>Document</th><th>Category</th><th>Date Uploaded</th></tr></thead>
        <tbody>${records.map((r: any) =>
          `<tr><td>${esc(r.name || '—')}</td><td>${esc(r.category || '—')}</td><td>${esc(r.dateUploaded || '—')}</td></tr>`
        ).join('')}</tbody>
      </table>` +
      (child.lastCheckup ? `<p style="margin-top:8px;font-size:12px;">Last Checkup: <strong>${esc(child.lastCheckup)}</strong></p>` : '') +
      (child.notes ? `<p style="margin-top:6px;font-size:12px;">Notes: ${esc(child.notes)}</p>` : '');
    })());

    const behaviorSection = section('Behavioral Record', (() => {
      const legacy = (child.behavioralLogs || []).filter((log: any) => !childViolations.some(v => v.id === log.id));
      if (childViolations.length === 0 && legacy.length === 0) return '<p class="empty">No violations recorded.</p>';
      return `<table>
        <thead><tr><th>Date</th><th>Type</th><th>Severity</th><th>Status</th></tr></thead>
        <tbody>${childViolations.map((v: any) =>
          `<tr><td>${v.date ? esc(formatDate(v.date)) : '—'}</td><td>${esc(v.type || '—')}</td><td>${esc(v.severity || '—')}</td><td>${esc(v.status || '—')}</td></tr>`
        ).join('')}${legacy.map((l: any) =>
          `<tr><td>${l.date ? esc(formatDate(l.date)) : '—'}</td><td>${esc(l.type || '—')}</td><td>${esc(l.severity || '—')}</td><td>Legacy log</td></tr>`
        ).join('')}</tbody>
      </table>`;
    })());

    const activitySection = section('Activity Participation', (() => {
      if (childActivities.length === 0) return '<p class="empty">No activity participation recorded.</p>';
      return `<table>
        <thead><tr><th>Activity</th><th>Date</th><th>Type</th><th>Status</th></tr></thead>
        <tbody>${childActivities.map((a: any) =>
          `<tr><td>${esc(a.title || '—')}</td><td>${a.date ? esc(formatDate(a.date)) : '—'}</td><td>${esc(a.category || a.type || '—')}</td><td>${esc(a.status || '—')}</td></tr>`
        ).join('')}</tbody>
      </table>`;
    })());

    const assessmentSection = section('Assessments', (() => {
      if (childAssessments.length === 0) return '<p class="empty">No assessments recorded.</p>';
      return `<table>
        <thead><tr><th>Title</th><th>Type</th><th>Date</th><th>Assessor</th><th>Status</th></tr></thead>
        <tbody>${childAssessments.map((a: any) =>
          `<tr><td>${esc(a.title || '—')}</td><td>${esc(a.type || '—')}</td><td>${a.date ? esc(formatDate(a.date)) : '—'}</td><td>${esc(a.assessor || '—')}</td><td>${esc(a.status || '—')}</td></tr>`
        ).join('')}</tbody>
      </table>`;
    })());

    // The discharge plan is what makes this a discharge report rather than a
    // general summary. Expected date, every extension decision, and any open
    // recommendation all come from `/discharge-plans/resident/:id`.
    const dischargeSection = section('Discharge Plan', (() => {
      const expected = plan?.admission?.expectedDischargeDate;
      const history = Array.isArray(plan?.history) ? plan.history : [];
      const recommendations = Array.isArray(plan?.recommendations) ? plan.recommendations : [];
      const open = recommendations.filter((r: any) => r.status === 'Pending');

      const rows = [
        row('Expected Discharge Date', expected ? esc(formatDate(expected)) : 'Not set'),
        row('Extension Decisions', String(history.length)),
        row('Open Recommendations', String(open.length)),
      ].join('');

      const historyTable = history.length
        ? `<table style="margin-top:8px;">
            <thead><tr><th>Decided</th><th>Previous</th><th>New Date</th><th>Days</th><th>Reason</th></tr></thead>
            <tbody>${history.map((h: any) =>
              `<tr><td>${h.decidedAt ? esc(formatDate(String(h.decidedAt).slice(0, 10))) : '—'}</td><td>${esc(formatDate(h.previousDischargeDate))}</td><td>${esc(formatDate(h.newDischargeDate))}</td><td>+${esc(h.extensionDays)}</td><td>${esc(h.reason || '—')}</td></tr>`
            ).join('')}</tbody>
          </table>`
        : '<p class="empty" style="margin-top:6px;">No extension decisions recorded.</p>';

      const recommendationList = open.length
        ? `<p style="margin-top:8px;font-size:12px;"><strong>Open recommendation(s):</strong></p>
           <ul style="margin:4px 0 0 18px;font-size:12px;">${open.map((r: any) =>
             `<li>${esc(r.recommendationNote || r.thresholdType || 'Discharge review')} (${esc(r.majorCount)} major, ${esc(r.minorCount)} minor)</li>`
           ).join('')}</ul>`
        : '';

      return rows + historyTable + recommendationList;
    })());

    const reintegration = section('Reintegration Plan', `
      ${row('Current Phase', esc(child.casePhase))}
      <p style="margin-top:8px;font-size:12px;color:#6b7280;">
        ${esc(child.casePhase?.includes('Reintegration')
          ? 'Resident is in the final stages of the program and is being prepared for community reintegration and discharge.'
          : child.casePhase?.includes('Pre-integration')
          ? 'Resident is undergoing pre-integration activities including family counseling and community linkage.'
          : 'Resident is still in the active rehabilitation phase. Reintegration planning will begin upon reaching the Pre-integration Phase.')}
      </p>
    `);

    return `
      <div class="resident-block">
        <div class="resident-header">
          <div>
            <div class="resident-name">${esc(child.name)}</div>
            <div class="resident-meta">${esc(child.id)} &nbsp;|&nbsp; ${esc(child.caseType)} &nbsp;|&nbsp; Admitted: ${esc(formatDate(child.admissionDate))}</div>
          </div>
          <div class="resident-phase">${esc(child.casePhase || '—')}</div>
        </div>
        ${personalInfo}
        ${caseProgress}
        ${dischargeSection}
        ${medicalInfo}
        ${activitySection}
        ${behaviorSection}
        ${assessmentSection}
        ${reintegration}
      </div>`;
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Resident Report — ${dateStr}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 13px; color: #1a1a1a; background: white; padding: 32px; }
    .header { text-align: center; border-bottom: 3px solid #2F3E46; padding-bottom: 16px; margin-bottom: 24px; }
    .header .agency { font-size: 11px; color: #6b7280; letter-spacing: 0.5px; text-transform: uppercase; }
    .header h1 { font-size: 20px; font-weight: bold; color: #2F3E46; margin: 6px 0 4px; }
    .header .date { font-size: 11px; color: #9ca3af; }
    .resident-block { margin-bottom: 40px; page-break-after: always; }
    .resident-block:last-child { page-break-after: avoid; }
    .resident-header { background: #2F3E46; color: white; padding: 14px 16px; border-radius: 8px 8px 0 0; display: flex; justify-content: space-between; align-items: center; margin-bottom: 0; }
    .resident-name { font-size: 16px; font-weight: bold; }
    .resident-meta { font-size: 11px; color: #d1d5db; margin-top: 2px; }
    .resident-phase { font-size: 10px; background: #FFD100; color: #2F3E46; font-weight: bold; padding: 4px 10px; border-radius: 20px; white-space: nowrap; }
    .section { border: 1px solid #e5e7eb; border-top: none; padding: 14px 16px; }
    .section:last-child { border-radius: 0 0 8px 8px; }
    .section-title { font-size: 10px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; color: #6b7280; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #f3f4f6; }
    .row { display: flex; gap: 12px; margin-bottom: 5px; font-size: 12px; }
    .label { color: #6b7280; min-width: 160px; flex-shrink: 0; }
    .value { font-weight: 600; color: #1a1a1a; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }
    th { background: #f9fafb; text-align: left; padding: 7px 10px; font-weight: 600; color: #374151; border: 1px solid #e5e7eb; font-size: 11px; }
    td { padding: 6px 10px; border: 1px solid #e5e7eb; color: #374151; }
    tr:nth-child(even) td { background: #fafafa; }
    .empty { font-size: 12px; color: #9ca3af; font-style: italic; }
    .footer { text-align: center; margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; }
    @media print {
      body { padding: 16px; }
      .no-print { display: none; }
    }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
</head>
<body>
  <div class="no-print" style="background:#2F3E46;color:white;padding:12px 20px;border-radius:8px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;">
    <span style="font-weight:bold;">Resident Report — ${selected.length} resident(s)</span>
    <div style="display:flex;gap:10px;">
      <button onclick="window.print()" style="background:#FFD100;color:#2F3E46;border:none;padding:8px 20px;border-radius:6px;font-weight:bold;cursor:pointer;font-size:13px;">Print</button>
      <button id="savePdfBtn" onclick="savePDF()" style="background:white;color:#2F3E46;border:none;padding:8px 20px;border-radius:6px;font-weight:bold;cursor:pointer;font-size:13px;">Save as PDF</button>
      <button onclick="window.close()" style="background:rgba(255,255,255,0.15);color:white;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;">Close</button>
    </div>
  </div>
  <script>
    function savePDF() {
      const btn = document.getElementById('savePdfBtn');
      btn.textContent = 'Generating...';
      btn.disabled = true;
      const toolbar = document.querySelector('.no-print');
      toolbar.style.display = 'none';
      const filename = 'Resident-Report-${dateStr.replace(/,/g,'').replace(/ /g,'-')}.pdf';
      const opt = {
        margin: [10, 10, 10, 10],
        filename: filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
      };
      html2pdf().set(opt).from(document.body).save().then(() => {
        toolbar.style.display = 'flex';
        btn.textContent = 'Save as PDF';
        btn.disabled = false;
      });
    }
  </script>

  <div class="header">
    <div class="agency">Republic of the Philippines · Province of Laguna · City Government of Calamba<br>City Social Services Department — Second Chance Home</div>
    <h1>Resident Comprehensive Report</h1>
    <div class="date">Generated: ${dateStr} &nbsp;|&nbsp; ${selected.length} Resident(s)</div>
  </div>

  ${selected.map((child) => renderChild(child, plans[child.id])).join('')}

  <div class="footer">
    Second Chance Home — City Social Services Department, Calamba, Laguna<br>
    This report is confidential and for authorized personnel only. Generated on ${dateStr}.
  </div>
</body>
</html>`;

  // The window is opened by the caller, synchronously inside the click handler.
  // Opening it here would be after the discharge-plan `await`, and a browser
  // treats `window.open` outside a user gesture as a popup and blocks it.
  if (target && !target.closed) {
    target.document.open();
    target.document.write(html);
    target.document.close();
  }
}

// ── REPORT FORM ROW ─────────────────────────────────────────────────────────
function ReportFormRow({ form, onView }: { form: ReportForm; onView: (form: ReportForm) => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-gray-100 bg-white p-4 hover:border-[#FFD100] hover:shadow-sm transition-all sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 shrink-0 rounded-lg bg-gray-50 p-2"><FileText className="h-4 w-4 text-[#2F3E46]" /></div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-[#2F3E46]">{form.name}</p>
          <p className="mt-0.5 text-xs leading-snug text-gray-500">{form.description}</p>
          <p className="mt-1 text-[10px] italic text-gray-400">{form.when}</p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="outline" onClick={() => onView(form)} className="h-8 gap-1.5 text-xs"><Eye className="h-3.5 w-3.5" /> View</Button>
        <Button size="sm" variant="outline" onClick={() => { const w = window.open(form.file, '_blank'); if (w) setTimeout(() => { try { w.print(); } catch {} }, 700); }} className="h-8 gap-1.5 text-xs"><Printer className="h-3.5 w-3.5" /> Print</Button>
        <a href={form.file} download className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-200 px-3 text-xs font-semibold text-[#2F3E46] hover:bg-gray-50"><Download className="h-3.5 w-3.5" /> Download</a>
      </div>
    </div>
  );
}

// ── FORM LIST ───────────────────────────────────────────────────────────────
interface FormsSectionProps {
  title: string;
  role: string;
  icon: React.ReactNode;
  accentColor: string;
  bgColor: string;
  forms: ReportForm[];
  onView: (form: ReportForm) => void;
}

function ReportFormsSection({
  title, role, icon, accentColor, bgColor, forms, onView,
}: FormsSectionProps) {
  return (
    <Card className="overflow-hidden border border-green-200 shadow-sm">
      <div className="flex items-center gap-3 px-5 py-4 text-white" style={{ backgroundColor: '#00A83B' }}>
        <div className="flex items-center gap-2 font-bold">
          <span>{icon}</span>
          <span>{title}</span>
        </div>
        <span className="text-xs opacity-90">— Click to download</span>
      </div>
      <div className="divide-y divide-gray-100 bg-white">
        {forms.map((form) => (
          <ReportFormRow key={form.file} form={form} onView={onView} />
        ))}
      </div>
    </Card>
  );
}


function HouseparentTRIReviewQueue({ onOpenTRI }: { onOpenTRI: (recordId: string) => void }) {
  const { children } = useData();
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  // Approve and return both ask before they act, and both report their outcome.
  // The return notes are a required field, so they get a form rather than the
  // one-line browser prompt this used to open.
  const dialog = useSystemDialog();
  const [returnTarget, setReturnTarget] = useState<string | null>(null);
  const [returnNotes, setReturnNotes] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [submitted, underReview] = await Promise.all([
        request<{ success: boolean; data?: any[] }>('/tri?status=Submitted'),
        request<{ success: boolean; data?: any[] }>('/tri?status=Under%20Review'),
      ]);
      setRecords([
        ...(submitted?.data || []),
        ...(underReview?.data || []),
      ]);
    } catch {
      setRecords([]);
      setMessage('Unable to load Houseparent TRI submissions.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Approving is finalize(): it is the transition that makes the rating official.
  // Reviewers get exactly two outcomes — approve, or return for revision. There is
  // no "start review" step: it added a third state to a two-person office without
  // changing anything the reviewer could do.
  const handleApprove = async (id: string) => {
    const confirmed = await dialog.confirm({
      title: 'Approve this TRI?',
      description: "The rating becomes the resident's official monthly TRI result and the record can no longer be edited. If something needs changing, return it for revision instead.",
      confirmLabel: 'Approve TRI',
      tone: 'warning',
    });
    if (!confirmed) return;
    setBusyId(id);
    setMessage('');
    try {
      await request(`/tri/${id}/finalize`, { method: 'POST' });
      await load();
      await dialog.success(
        'TRI approved.',
        "The rating is now the resident's official monthly result and the record can no longer be edited.",
      );
    } catch (error) {
      const detail = describeError(error, 'Unable to approve the TRI.');
      setMessage(detail);
      await dialog.failure('Could not approve the TRI', detail);
    } finally {
      setBusyId(null);
    }
  };

  /** Opens the notes form. A return without notes is not a return. */
  const requestReturn = (id: string) => {
    setReturnTarget(id);
    setReturnNotes('');
  };

  const confirmReturn = async () => {
    const id = returnTarget;
    const notes = returnNotes.trim();
    if (!id || !notes) return;
    setReturnTarget(null);
    setBusyId(id);
    setMessage('');
    try {
      await request(`/tri/${id}/return`, {
        method: 'POST',
        body: JSON.stringify({ reviewNotes: notes }),
      });
      await load();
      setReturnNotes('');
      await dialog.success(
        'TRI returned for revision.',
        'The Houseparent can edit it again and resubmit. Your notes are shown with the record.',
      );
    } catch (error) {
      const detail = describeError(error, 'Unable to return the TRI.');
      setMessage(detail);
      await dialog.failure('Could not return the TRI', detail);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
    <Card className="shadow-sm border-none">
      <CardHeader className="border-b border-gray-100">
        <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
          <ClipboardList className="w-5 h-5 text-[#FFD100]" />
          Houseparent TRI Submissions
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        <p className="text-xs text-gray-500 mb-4">
          TRI records submitted by Houseparents are reviewed here. A submitted record is read-only — reviewers
          view it, then approve it or return it for revision with notes.
        </p>
        {message && <p className="mb-3 rounded-lg bg-red-50 border border-red-100 px-3 py-2 text-xs text-red-700">{message}</p>}
        {loading ? (
          <p className="text-sm text-gray-400">Loading submissions…</p>
        ) : records.length === 0 ? (
          <p className="text-sm text-gray-400">No TRI submissions are waiting for review.</p>
        ) : (
          <div className="space-y-2">
            {records.map(record => {
              const child = children.find(c => c.id === record.residentId);
              const underReview = record.status === 'Under Review';
              return (
                <div key={record.id} className="rounded-xl border border-gray-200 p-3">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-[#2F3E46] truncate">{child?.name || record.residentId}</p>
                      <p className="text-xs text-gray-500">
                        {String(record.reportingMonth).padStart(2, '0')}/{record.reportingYear}
                        {' · '}
                        <span className={underReview ? 'text-blue-600 font-semibold' : 'text-amber-600 font-semibold'}>{record.status}</span>
                      </p>
                      {record.submittedAt && <p className="text-[10px] text-gray-400 mt-0.5">Submitted {new Date(record.submittedAt).toLocaleString()}</p>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => onOpenTRI(record.id)} className="gap-1.5 text-xs">
                        <Eye className="w-3.5 h-3.5" /> View TRI
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => requestReturn(record.id)} disabled={busyId === record.id} className="gap-1.5 text-xs text-red-600 border-red-200">
                        <RotateCcw className="w-3.5 h-3.5" /> Return for revision
                      </Button>
                      <Button size="sm" onClick={() => handleApprove(record.id)} disabled={busyId === record.id} className="gap-1.5 text-xs bg-[#2F3E46]">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>

    {/* Return for revision: the notes are required, so they are collected in a
        form rather than the browser's single-line prompt. */}
    <Dialog open={Boolean(returnTarget)} onOpenChange={(open) => { if (!open) { setReturnTarget(null); setReturnNotes(''); } }}>
      <DialogContent className="rounded-2xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[#2F3E46]">Return this TRI for revision</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label className="text-xs font-semibold text-gray-500">
            Review notes <span className="text-red-500">*</span>
          </Label>
          <Textarea
            value={returnNotes}
            onChange={(e) => setReturnNotes(e.target.value)}
            rows={5}
            placeholder="Explain what the Houseparent needs to revise before resubmitting this TRI..."
          />
          <p className="text-[11px] leading-relaxed text-gray-500">
            The notes are stored with the record and shown to the Houseparent.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => { setReturnTarget(null); setReturnNotes(''); }}>Cancel</Button>
          <Button
            className="bg-red-600 hover:bg-red-700 text-white"
            onClick={confirmReturn}
            disabled={busyId === returnTarget || !returnNotes.trim()}
          >
            {busyId === returnTarget ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-1" />}
            Return for revision
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}


// ── SCHEDULED REPORT PACKAGE CHECKER ────────────────────────────────────────
function ScheduledReportsPackage() {
  const { children } = useData();
  const dialog = useSystemDialog();
  const activeResidentSnapshot = children.filter(c => c.status === 'Active' || !c.status);
  const [month, setMonth] = useState(String(new Date().getMonth() + 1));
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [checking, setChecking] = useState(false);
  const [zipProgress, setZipProgress] = useState<{ kind: 'tri' | 'anecdotal'; done: number; total: number } | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);

  const getMonthName = (m: string) => MONTHS[Number(m) - 1] || '';

  /** The month's TRI and Anecdotal records — the same two calls the checklist makes. */
  const loadMonth = async () => {
    const [triRes, anecdRes] = await Promise.all([
      request<{ success: boolean; data?: any[] }>(`/tri?year=${year}&month=${month}`),
      request<{ success: boolean; data?: any[] }>(`/anecdotal-reports?year=${year}&month=${month}`),
    ]);
    return { tri: triRes?.data || [], anecd: anecdRes?.data || [] };
  };

  /**
   * The reports of one kind that belong to the selected month.
   *
   * The endpoint already filters by year and month, and this filters again on the
   * record's own period fields. That is deliberate belt-and-braces: the ZIP is
   * the thing the facility files, so a record from another month reaching it
   * would be a silent filing error rather than a visible one.
   */
  const recordsForMonth = (records: any[], kind: 'tri' | 'anecdotal') =>
    records.filter((r) => {
      if (!r?.id || !r?.residentId) return false;
      return kind === 'tri'
        ? Number(r.reportingYear) === Number(year) && Number(r.reportingMonth) === Number(month)
        : Number(r.reportYear) === Number(year) && Number(r.reportMonth) === Number(month);
    });

  const handleViewMonthlyPackage = async () => {
    setChecking(true);
    try {
      const { tri, anecd } = await loadMonth();
      const active = activeResidentSnapshot;
      const missing: string[] = [];
      for (const child of active) {
        const triRecord = tri.find(r => r.residentId === child.id);
        const anecdRecord = anecd.find(r => r.residentId === child.id);
        if (!triRecord) missing.push(`${child.name} — TRI`);
        if (!anecdRecord) missing.push(`${child.name} — Anecdotal Report`);
      }
      if (missing.length) {
        const proceed = await dialog.confirm({
          title: 'Some required monthly documents are missing',
          description: 'The package can still be opened, but the checklist will show these as missing.',
          items: missing,
          confirmLabel: 'View the package anyway',
          cancelLabel: 'Go back',
          tone: 'warning',
        });
        if (!proceed) return;
      }
      const win = window.open('', '_blank', 'width=900,height=900');
      if (!win) {
        await dialog.failure(
          'Could not open the monthly package',
          'Your browser blocked the new window. Allow pop-ups for this site, then try again.',
        );
        return;
      }
      const esc = (s: string) => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c] as string));
      win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Monthly Report Package — ${esc(getMonthName(month))} ${year}</title><style>body{font-family:Arial,sans-serif;padding:28px;color:#2F3E46}h1{font-size:22px}h2{margin-top:28px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:12px}.ok{color:#16803a}.missing{color:#b91c1c}.toolbar{position:sticky;top:0;padding:10px;background:#2F3E46;color:#fff;margin:-28px -28px 22px;display:flex;justify-content:space-between}.toolbar button{padding:7px 14px}</style></head><body><div class="toolbar"><b>Monthly Report Package</b><button onclick="window.print()">Print / Save PDF</button></div><h1>Monthly Report Package</h1><p>${esc(getMonthName(month))} ${year}</p><h2>Document Checklist</h2><table><thead><tr><th>Resident</th><th>TRI</th><th>Anecdotal Report</th></tr></thead><tbody>${active.map(child=>{const t=tri.some(r=>r.residentId===child.id);const a=anecd.some(r=>r.residentId===child.id);return `<tr><td>${esc(child.name)}</td><td class="${t?'ok':'missing'}">${t?'Available':'Missing'}</td><td class="${a?'ok':'missing'}">${a?'Available':'Missing'}</td></tr>`;}).join('')}</tbody></table><p style="margin-top:24px;font-size:11px;color:#666">This checklist currently verifies the documents explicitly identified for monthly compilation: TRI and Anecdotal Report.</p></body></html>`);
      win.document.close();
    } finally { setChecking(false); }
  };

  /**
   * One ZIP holding every report of one kind for the selected month.
   *
   * Both kinds are built the same way: the month's records from the list
   * endpoint, then each report's own PDF endpoint. A report that cannot be
   * fetched is skipped and named, rather than losing the whole archive.
   */
  const handleDownloadZip = async (kind: 'tri' | 'anecdotal') => {
    setZipError(null);
    const isTri = kind === 'tri';
    const label = isTri ? 'TRI reports' : 'Anecdotal Reports';
    try {
      const { tri, anecd } = await loadMonth();
      const monthRecords = recordsForMonth(isTri ? tri : anecd, kind);
      if (!monthRecords.length) {
        await dialog.failure(
          `No ${label} for ${getMonthName(month)} ${year}`,
          `No ${label} belong to that month, so there is nothing to put in a ZIP.`,
        );
        return;
      }

      const items = monthRecords.map((record) => {
        const child = activeResidentSnapshot.find((c) => c.id === record.residentId);
        const who = String(child?.name || record.residentId).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
        const period = isTri
          ? `${record.reportingYear}-${String(record.reportingMonth).padStart(2, '0')}`
          : `${record.reportYear}-${String(record.reportMonth).padStart(2, '0')}`;
        return {
          path: isTri ? `/tri/${record.id}/pdf` : `/anecdotal-reports/${record.id}/pdf`,
          name: `${isTri ? 'TRI' : 'Anecdotal-Report'}-${who}-${period}.pdf`,
        };
      });

      setZipProgress({ kind, done: 0, total: items.length });
      const result = await downloadReportZip(
        periodZipName(isTri ? 'TRI-Reports' : 'Anecdotal-Reports', year, month),
        items,
        (done, total) => setZipProgress({ kind, done, total }),
      );
      if (result.skipped.length) {
        await dialog.failure(
          'Some reports could not be included',
          `${result.included} of ${items.length} ${label} were added to the ZIP. These could not be downloaded: ${result.skipped.join(', ')}.`,
        );
      }
    } catch (err: any) {
      setZipError(err?.message || 'Unable to build the ZIP.');
    } finally {
      setZipProgress(null);
    }
  };

  return <Card className="shadow-sm border-none border-l-4 border-l-[#2F3E46]"><CardHeader className="border-b border-gray-100 bg-gray-50/50"><CardTitle className="flex items-center gap-2 text-[#2F3E46]"><Activity className="w-5 h-5 text-[#FFD100]" /> Scheduled Reports</CardTitle></CardHeader><CardContent className="pt-4"><p className="text-sm text-gray-500 mb-4">Reports are viewed or downloaded manually by the Social Worker. The monthly package currently checks TRI and Anecdotal Reports while the remaining required-document list is being finalized.</p><div className="flex flex-col gap-3 sm:flex-row sm:items-end"><div><Label className="text-xs">Month</Label><select value={month} onChange={e=>setMonth(e.target.value)} className="mt-1 h-10 rounded-md border px-3 text-sm">{MONTHS.map((m,i)=><option key={m} value={i+1}>{m}</option>)}</select></div><div><Label className="text-xs">Year</Label><select value={year} onChange={e=>setYear(e.target.value)} className="mt-1 h-10 rounded-md border px-3 text-sm">{[Number(year)-1,Number(year),Number(year)+1].map(y=><option key={y}>{y}</option>)}</select></div><Button onClick={handleViewMonthlyPackage} disabled={checking} className="gap-2 bg-[#2F3E46] text-white">{checking ? <Loader2 className="w-4 h-4 animate-spin"/> : <FileText className="w-4 h-4"/>}{checking ? 'Checking…' : 'View Monthly Package'}</Button></div>
        {/* Bulk download. Two buttons rather than one because the facility files
            TRI and Anecdotal Reports separately, and the checklist above is a
            different question ("is anything missing?") from "give me the
            reports". Each button produces one ZIP holding one PDF per resident. */}
        <div className="mt-4 border-t border-gray-100 pt-4">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Bulk download</p>
          <p className="mt-1 text-xs text-gray-500">One ZIP per report type, holding every resident&rsquo;s report for {getMonthName(month)} {year} — each report a separate PDF inside the archive.</p>
          {zipError && <p className="mt-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{zipError}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {(['tri', 'anecdotal'] as const).map((kind) => {
              const running = zipProgress && zipProgress.kind === kind ? zipProgress : null;
              const label = kind === 'tri' ? 'TRI Reports' : 'Anecdotal Reports';
              return <Button key={kind} variant="outline" onClick={() => void handleDownloadZip(kind)} disabled={zipProgress !== null} className="gap-2">{running ? <Loader2 className="w-4 h-4 animate-spin"/> : <Download className="w-4 h-4"/>}{running ? `Zipping ${running.done}/${running.total}…` : `Download ${label} (ZIP)`}</Button>;
            })}
          </div>
        </div>
        </CardContent></Card>;
}

/**
 * The Social Worker's "Needs Review" queue.
 *
 * The list is deliberately read-only: View and Download only. Approve and Reject
 * live inside the report itself (see the embedded `AnecdotalReports` panel), so
 * the reviewer always acts on the document they have actually read rather than
 * on a row.
 *
 * `reloadToken` lets the parent re-run the query after a report is approved or
 * rejected — without it the decided report stayed in the queue until a manual
 * page reload, which made a successful Approve look like it had done nothing.
 */
function AnecdotalReviewQueue({ onOpen, reloadToken = 0 }: { onOpen: (id: string) => void; reloadToken?: number }) {
  const { children } = useData();
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const load = async () => { setLoading(true); try { const [submitted, underReview] = await Promise.all([request<any>('/anecdotal-reports?status=Submitted'), request<any>('/anecdotal-reports?status=Under%20Review')]); setRecords([...(submitted?.data||[]),...(underReview?.data||[])]); } catch { setRecords([]); setMessage('Unable to load Houseparent Anecdotal Reports.'); } finally { setLoading(false); } };
  useEffect(()=>{load();},[reloadToken]);
  const download = async (id: string) => {
    setDownloadingId(id);
    try { await downloadAnecdotalPdf({ id }); }
    catch (err: any) { setMessage(err?.message || 'Unable to download the Anecdotal Report PDF.'); }
    finally { setDownloadingId(null); }
  };
  return <Card className="shadow-sm border-none"><CardHeader className="border-b border-gray-100"><CardTitle className="flex items-center gap-2 text-[#2F3E46]"><FileText className="w-5 h-5 text-[#FFD100]"/> Houseparent Anecdotal Report Submissions</CardTitle></CardHeader><CardContent className="pt-4">{message&&<p className="mb-3 rounded-lg bg-red-50 border border-red-100 px-3 py-2 text-xs text-red-700">{message}</p>}{loading?<p className="text-sm text-gray-400">Loading submissions…</p>:records.length===0?<p className="text-sm text-gray-400">No Anecdotal Reports are waiting for Social Worker review.</p>:<div className="space-y-2">{records.map(r=>{const child=children.find(c=>c.id===r.residentId);return <div key={r.id} className="rounded-xl border p-3"><div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div><p className="font-semibold text-sm text-[#2F3E46]">{child?.name||r.residentId}</p><p className="text-xs text-gray-500">{MONTHS[(r.reportMonth||1)-1]} {r.reportYear} · {r.status}</p><p className="text-[10px] text-gray-400">Submitted by {r.submittedBy||r.houseparentName||'Houseparent'}{r.submittedAt?` on ${new Date(r.submittedAt).toLocaleString()}`:''}</p></div><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={()=>download(r.id)} disabled={downloadingId===r.id} className="gap-2">{downloadingId===r.id?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:<Download className="w-3.5 h-3.5"/>} Download</Button><Button size="sm" variant="outline" onClick={()=>onOpen(r.id)} className="gap-2"><Eye className="w-3.5 h-3.5"/> View</Button></div></div></div>})}</div>}</CardContent></Card>;
}

function ReportFormViewer({ form, onClose }: { form: ReportForm; onClose: () => void }) {
  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-6xl flex-col gap-0 overflow-hidden rounded-2xl p-0">
        <DialogHeader className="flex shrink-0 flex-row items-center justify-between border-b px-5 py-3">
          <div><DialogTitle className="text-[#2F3E46]">{form.name}</DialogTitle><DialogDescription>View the official form. Print or download from here.</DialogDescription></div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => { const w = window.open(form.file, '_blank'); if (w) setTimeout(() => { try { w.print(); } catch {} }, 700); }} className="gap-2"><Printer className="h-4 w-4" /> Print</Button>
            <a href={form.file} download className="inline-flex items-center gap-2 rounded-md bg-[#2F3E46] px-3 py-2 text-xs font-bold text-white"><Download className="h-4 w-4" /> Download</a>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 bg-neutral-200 p-2 sm:p-4">
          <iframe title={form.name} src={form.file} className="h-full w-full rounded-lg border bg-white" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── MAIN COMPONENT ──────────────────────────────────────────────────────────
export function Reports() {
  const { children, assessments, reports, refreshData, activities, violations, documents } = useData();
  const dialog = useSystemDialog();
  // Deep-linked from the "Anecdotal Report needs review" notification:
  // /reports?tab=review&anecdotalId=ANR00x opens the Needs Review tab with that
  // report already loaded in the reviewer panel.
  const [openAnecdotalId, setOpenAnecdotalId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('anecdotalId')
  );
  // Deep-linked from a Quarterly Progress Report notification: the report is a
  // card inside this module rather than a page of its own, so the link carries
  // the report id and the editor opens below the cards.
  const [openQuarterlyId, setOpenQuarterlyId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('quarterlyReportId')
  );
  const [activeReportsTab, setActiveReportsTab] = useState<'reports' | 'review'>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('tab') === 'review' || params.get('anecdotalId') ? 'review' : 'reports';
  });
  // Bumped after an Approve/Reject so the queue re-reads the server instead of
  // showing a report that has already been decided.
  const [reviewReloadToken, setReviewReloadToken] = useState(0);
  const [viewerForm, setViewerForm] = useState<ReportForm | null>(null);
  const [showSWForms, setShowSWForms] = useState(false);
  const navigate = useNavigate();
  const activeChildren = children.filter(c => c.status === 'Active' || !c.status);

  const [selectedResidents, setSelectedResidents] = useState<string[]>([]);
  const [selectAll, setSelectAll] = useState(false);

  const handleSelectResident = (id: string) => {
    setSelectedResidents(prev =>
      prev.includes(id) ? prev.filter(r => r !== id) : [...prev, id]
    );
  };

  const handleSelectAll = () => {
    if (selectAll) {
      setSelectedResidents([]);
    } else {
      setSelectedResidents(activeChildren.map(c => c.id));
    }
    setSelectAll(!selectAll);
  };

  const [generating, setGenerating] = useState(false);

  const handleGenerateReport = async () => {
    // Opened synchronously, before any await, so the browser counts it as part
    // of the click rather than as a popup.
    const win = window.open('', '_blank');
    if (!win) {
      await dialog.failure(
        'Could not open the report',
        'Your browser blocked the new window. Allow pop-ups for this site, then generate the report again.',
      );
      return;
    }
    win.document.write('<p style="font-family:Arial,sans-serif;padding:24px;color:#2F3E46">Preparing the report…</p>');

    setGenerating(true);
    try {
      await generateResidentReport(children, selectedResidents, assessments, { activities, violations, documents }, win);
    } catch (error: any) {
      // The popup shows the same sentence the app would; it used to print the
      // exception's own message, which is a raw failure, not a description.
      const detail = describeError(error, 'The report could not be generated. Please try again.');
      if (!win.closed) {
        win.document.open();
        win.document.write(`<p style="font-family:Arial,sans-serif;padding:24px;color:#b91c1c">${esc(detail)}</p>`);
        win.document.close();
      }
      await dialog.failure('Could not generate the report', detail);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="bg-[#2F3E46] p-6 rounded-xl shadow-md border-b-4 border-[#FFD100]">
        <h2 className="text-2xl font-bold mb-1 text-white">Reports</h2>
        <p className="text-gray-300">View, review, and download facility reports</p>
      </div>

      <div className="flex border-b border-gray-200 overflow-x-auto">
        <button type="button" onClick={() => setActiveReportsTab('reports')} className={`shrink-0 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-bold ${activeReportsTab === 'reports' ? 'border-[#FFD100] text-[#2F3E46]' : 'border-transparent text-gray-400'}`}>Reports</button>
        <button type="button" onClick={() => setActiveReportsTab('review')} className={`shrink-0 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-bold ${activeReportsTab === 'review' ? 'border-[#FFD100] text-[#2F3E46]' : 'border-transparent text-gray-400'}`}>Needs Review</button>
      </div>

      {activeReportsTab === 'review' ? (
        <div className="space-y-5">
          <HouseparentTRIReviewQueue onOpenTRI={(recordId) => navigate(`/tri?recordId=${encodeURIComponent(recordId)}`)} />
          <AnecdotalReviewQueue onOpen={(recordId) => setOpenAnecdotalId(recordId)} reloadToken={reviewReloadToken} />
          {openAnecdotalId && (
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-3"><div><p className="font-bold text-[#2F3E46]">Social Worker Review — Anecdotal Report</p><p className="text-xs text-gray-500">View and download the Houseparent&rsquo;s submission, then Approve it (publishes the PDF to the resident&rsquo;s Documents) or Reject it (publishes nothing) below.</p></div><Button variant="ghost" size="sm" onClick={() => setOpenAnecdotalId(null)}>Close</Button></div>
              <AnecdotalReports recordId={openAnecdotalId} embedded canReview onStatusChange={() => setReviewReloadToken(t => t + 1)} />
            </div>
          )}
        </div>
      ) : (
        <>
          <div>
            <button
              type="button"
              onClick={() => setShowSWForms(v => !v)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-green-200 text-green-700 bg-green-50 hover:bg-green-100 font-semibold text-sm transition-all"
            >
              <span>📋</span>
              {showSWForms ? 'Hide Forms' : 'Available Forms'}
              {showSWForms ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            {showSWForms && (
              <div className="mt-3">
                <ReportFormsSection
                  title="Social Worker Reporting Forms"
                  role="Social Worker"
                  icon={<Briefcase className="w-5 h-5" />}
                  accentColor="#2F3E46"
                  bgColor="#FFD100"
                  forms={SW_REPORT_FORMS}
                  onView={setViewerForm}
                />
              </div>
            )}
          </div>

          <ScheduledReportsPackage />

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {/* Discharge Reports */}
            <Card className="shadow-sm border-none">
              <CardHeader className="border-b border-gray-100"><CardTitle className="flex items-center gap-2 text-[#2F3E46]"><FileText className="w-5 h-5 text-[#FFD100]" /> Resident Discharge Reports</CardTitle></CardHeader>
              <CardContent className="pt-4">
                <p className="mb-4 text-sm text-gray-500">Generate comprehensive discharge reports for residents.</p>
                <Dialog>
                  <DialogTrigger asChild><Button className="w-full bg-[#2F3E46] text-white gap-2 hover:bg-[#263440]"><FileText className="w-4 h-4" /> Generate Resident Report</Button></DialogTrigger>
                  <DialogContent className="max-w-md rounded-2xl bg-white">
                    <DialogHeader><DialogTitle className="font-bold text-[#2F3E46]">Select Residents</DialogTitle><DialogDescription>Choose which residents to include in the comprehensive report.</DialogDescription></DialogHeader>
                    <div className="mt-2 space-y-4">
                      <div className="flex items-center space-x-2 rounded-xl border bg-gray-50 p-3"><Checkbox id="select-all" checked={selectAll} onCheckedChange={handleSelectAll} /><Label htmlFor="select-all" className="cursor-pointer font-medium">Select All Residents</Label></div>
                      {activeChildren.length === 0 ? <p className="py-4 text-center text-sm italic text-gray-400">No active residents found.</p> : <div className="max-h-64 space-y-2 overflow-y-auto">{activeChildren.map(child => <div key={child.id} className="flex items-center space-x-2 rounded-xl border p-3 hover:bg-gray-50"><Checkbox id={child.id} checked={selectedResidents.includes(child.id)} onCheckedChange={() => handleSelectResident(child.id)} /><Label htmlFor={child.id} className="flex-1 cursor-pointer"><span className="font-medium">{child.name}</span><span className="ml-2 text-xs text-gray-400">({child.id})</span></Label></div>)}</div>}
                      <div className="space-y-2 border-t pt-3"><p className="text-sm text-gray-500">Selected: {selectedResidents.length} resident(s)</p><Button className="w-full bg-[#2F3E46] text-white" disabled={!selectedResidents.length || generating} onClick={() => { void handleGenerateReport(); }}>{generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Printer className="mr-2 h-4 w-4" />} {generating ? 'Preparing…' : `Generate & Print Report${selectedResidents.length > 1 ? 's' : ''}`}</Button></div>
                    </div>
                  </DialogContent>
                </Dialog>
              </CardContent>
            </Card>

            {/* Quarterly Progress Reports — lives here rather than in a module of
                its own, so the six aspects sit alongside the other facility
                reports the same staff already come here to produce. */}
            <QuarterlyProgressReportsCard onOpenReport={setOpenQuarterlyId} />
          </div>

          {/*
            The editor opens as a full-screen form of its own — it renders the
            report's PDF and overlays the writable cells — so it is mounted here
            without a wrapper, the way the TRI's form dialog is.
          */}
          {openQuarterlyId && (
            <QuarterlyProgressReportEditor
              reportId={openQuarterlyId}
              onClose={() => setOpenQuarterlyId(null)}
            />
          )}

        </>
      )}

      {viewerForm && <ReportFormViewer form={viewerForm} onClose={() => setViewerForm(null)} />}
    </div>
  );
}
