import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import {
  FileText, Download, Briefcase, Brain,
  ChevronDown, ChevronUp, AlertTriangle,
  ClipboardList, MessageSquare, Star, Activity, Printer,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription,
  DialogHeader, DialogTitle, DialogTrigger,
} from '@/app/components/ui/dialog';
import { Label } from '@/app/components/ui/label';
import { Checkbox } from '@/app/components/ui/checkbox';
import { useData } from '../state/DataContext';

// ── DATE HELPER ─────────────────────────────────────────────────────────────
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
                th { background: #1e3a5f; color: white; padding: 10px 8px; text-align: left; font-weight: 600; border: 1px solid #1e3a5f; }
                td { padding: 8px; border: 1px solid #e2e8f0; vertical-align: top; }
                tr:nth-child(even) { background: #f8fafc; }
                .footer { margin-top: 40px; padding-top: 20px; border-top: 2px solid #1e3a5f; text-align: center; font-size: 10px; color: #64748b; }
                .signature-area { margin-top: 40px; display: grid; grid-template-columns: 1fr 1fr; gap: 60px; }
                .signature-box { text-align: center; }
                .signature-line { border-top: 1px solid #333; margin-top: 60px; padding-top: 5px; font-size: 11px; }
                .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 600; }
                .badge-green { background: #dcfce7; color: #166534; }
                .badge-red { background: #fee2e2; color: #991b1b; }
                .badge-yellow { background: #fef9c3; color: #854d0e; }
                .no-print { background: #1e3a5f; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
                .no-print button { background: #ffd700; color: #1e3a5f; border: none; padding: 8px 20px; border-radius: 4px; font-weight: bold; cursor: pointer; margin-left: 10px; }
                .no-print button:hover { background: #f5c700; }
                @media print { 
                  .no-print { display: none !important; } 
                  body { padding: 0; }
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
                ` : ''}

                ${summary.violations ? `
                <div class="section">
                  <div class="section-title">VIOLATION SUMMARY</div>
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
                ` : ''}

                ${summary.assessments && typeof summary.assessments === 'object' ? `
                <div class="section">
                  <div class="section-title">ASSESSMENT SUMMARY</div>
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
                ` : ''}

                ${summary.phaseDistribution && summary.phaseDistribution.length > 0 ? `
                <div class="section">
                  <div class="section-title">PHASE DISTRIBUTION</div>
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
                    <div class="signature-line">
                      <strong>Prepared by:</strong><br>
                      Social Worker / Case Manager<br>
                      Date: _______________
                    </div>
                  </div>
                  <div class="signature-box">
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
        onClick={handleGenerate}
        disabled={loading}
      >
        {loading ? 'Generating...' : <><Download className="w-4 h-4" /> Generate Now</>}
      </Button>
      {message && (
        <p className={`text-xs mt-2 ${message.includes('Failed') ? 'text-red-500' : 'text-green-600'}`}>
          {message}
        </p>
      )}
    </div>
  );
}

// ── REPORT FORM DEFINITIONS ─────────────────────────────────────────────────

// Social Worker reporting forms
const SW_REPORT_FORMS: ReportForm[] = [
  {
    name: 'Anecdotal Report',
    description: 'Daily behavioral observations — physical, social, emotional & spiritual changes',
    file: '/forms/anecdotal-report.pdf',
    when: 'Filed daily per resident',
  },
  {
    name: 'Feedback Report',
    description: 'Post-visit or post-hearing case update — home visit, court, school visit',
    file: '/forms/feedback-report.pdf',
    when: 'After court hearings, home visits, or school visits',
  },
  {
    name: 'Incident Report',
    description: 'Form 08 — Documents incidents: quarrelling, stealing, runaway, accidents, substance use',
    file: '/forms/incident-report.pdf',
    when: 'Immediately after any critical incident',
  },
  {
    name: 'Treatment & Rehabilitation Indicator (TRI)',
    description: 'Periodic progress rating across physical, emotional, social & spiritual domains',
    file: '/forms/tri.pdf',
    when: 'Filed periodically (per rehabilitation period)',
  },
  {
    name: 'Social Worker\'s Notes',
    description: 'Narrative interview notes — household profile, case background & observations',
    file: '/forms/sw-notes.pdf',
    when: 'After every client interview or session',
  },
  {
    name: 'Activity / Seminar Evaluation',
    description: 'CSSD post-activity attendance sheet and evaluation report',
    file: '/forms/cssd-evaluation.pdf',
    when: 'After each activity or seminar',
  },
];

// Psychologist reporting forms
const PSYCH_REPORT_FORMS: ReportForm[] = [
  {
    name: 'Dialogue / Counseling Form',
    description: 'Session documentation — purpose, observations, interventions & recommendations',
    file: '/forms/psych/dialogue-form.pdf',
    when: 'After each counseling or dialogue session',
  },
  {
    name: 'Exit Form — RPSE',
    description: 'Rehabilitation Program Satisfaction Evaluation completed upon resident exit',
    file: '/forms/psych/exit-form-rpse.pdf',
    when: 'Upon discharge or program completion',
  },
];

// Mock residents & history (kept from original)
const activeResidents = [
  { id: 'CH001', name: 'Juan Dela Cruz' },
  { id: 'CH002', name: 'Maria Santos' },
  { id: 'CH004', name: 'Ana Reyes' },
];

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
function generateResidentReport(children: any[], selectedIds: string[], allAssessments: any[]) {
  const selected = children.filter(c => selectedIds.includes(c.id));
  if (selected.length === 0) return;

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });

  const renderChild = (child: any) => {
    const behaviorTotal = (child.behavioralLogs || []).reduce((s: number, l: any) => s + (l.points || 0), 0);
    const childAssessments = allAssessments.filter(a =>
      Array.isArray(a.forResidents) && a.forResidents.includes(child.id)
    );

    const section = (title: string, content: string) => `
      <div class="section">
        <div class="section-title">${title}</div>
        ${content}
      </div>`;

    const row = (label: string, value: string) =>
      `<div class="row"><span class="label">${label}</span><span class="value">${value || '—'}</span></div>`;

    const personalInfo = section('Personal Information', `
      ${row('Full Name', child.name)}
      ${row('ID', child.id)}
      ${row('Age', child.age ? `${child.age} years old` : '')}
      ${row('Gender', child.gender)}
      ${row('Date of Birth', child.birthDate ? formatDate(child.birthDate) : '')}
      ${row('Address', child.address || '')}
      ${row('Date of Admission', formatDate(child.admissionDate))}
    `);

    const caseProgress = section('Case Progress', `
      ${row('Case Type / Offense', child.caseType)}
      ${row('Legal Category', child.legalCategory)}
      ${row('Rehabilitation Phase', child.casePhase)}
      ${row('Repeat Offender', child.isRepeatOffender ? 'Yes' : 'No')}
      ${child.isRepeatOffender && child.previousCaseDetails
        ? row('Previous Case Details', child.previousCaseDetails) : ''}
      ${row('Documents Complete', child.documentsComplete ? 'Yes' : 'Pending')}
    `);

    const medicalInfo = section('Medical Records', (() => {
      const records = child.medicalRecords || [];
      if (records.length === 0) return '<p class="empty">No medical records on file.</p>';
      return `<table>
        <thead><tr><th>Document</th><th>Category</th><th>Date Uploaded</th></tr></thead>
        <tbody>${records.map((r: any) =>
          `<tr><td>${r.name || '—'}</td><td>${r.category || '—'}</td><td>${r.dateUploaded || '—'}</td></tr>`
        ).join('')}</tbody>
      </table>` +
      (child.lastCheckup ? `<p style="margin-top:8px;font-size:12px;">Last Checkup: <strong>${child.lastCheckup}</strong></p>` : '') +
      (child.notes ? `<p style="margin-top:6px;font-size:12px;">Notes: ${child.notes}</p>` : '');
    })());

    const behaviorSection = section('Behavioral Assessment', (() => {
      const logs = child.behavioralLogs || [];
      const status = behaviorTotal >= 10 ? 'CRITICAL FLAG' : behaviorTotal >= 5 ? 'Monitoring' : 'Good Standing';
      const statusColor = behaviorTotal >= 10 ? '#dc2626' : behaviorTotal >= 5 ? '#d97706' : '#16a34a';
      const summary = `<p style="margin-bottom:8px;">Total Violation Points: <strong style="color:${statusColor}">${behaviorTotal} — ${status}</strong></p>`;
      if (logs.length === 0) return summary + '<p class="empty">No violations recorded.</p>';
      return summary + `<table>
        <thead><tr><th>Date</th><th>Type</th><th>Severity</th><th>Points</th></tr></thead>
        <tbody>${logs.map((l: any) =>
          `<tr><td>${l.date ? formatDate(l.date) : '—'}</td><td>${l.type || '—'}</td><td>${l.severity || '—'}</td><td>${l.points ?? 0}</td></tr>`
        ).join('')}</tbody>
      </table>`;
    })());

    const activitySection = section('Activity Participation', (() => {
      try {
        const saved = localStorage.getItem('activitiesRecords');
        if (!saved) return '<p class="empty">No activity records.</p>';
        const acts = JSON.parse(saved);
        const participated = Array.isArray(acts)
          ? acts.filter((a: any) => Array.isArray(a.selectedResidentIds) && a.selectedResidentIds.includes(child.id))
          : [];
        if (participated.length === 0) return '<p class="empty">No activity participation recorded.</p>';
        return `<table>
          <thead><tr><th>Activity</th><th>Date</th><th>Type</th><th>Status</th></tr></thead>
          <tbody>${participated.map((a: any) =>
            `<tr><td>${a.title || '—'}</td><td>${a.date ? formatDate(a.date) : '—'}</td><td>${a.category || a.type || '—'}</td><td>${a.status || '—'}</td></tr>`
          ).join('')}</tbody>
        </table>`;
      } catch { return '<p class="empty">Unable to load activity records.</p>'; }
    })());

    const assessmentSection = section('Assessments', (() => {
      if (childAssessments.length === 0) return '<p class="empty">No assessments recorded.</p>';
      return `<table>
        <thead><tr><th>Title</th><th>Type</th><th>Date</th><th>Assessor</th><th>Status</th></tr></thead>
        <tbody>${childAssessments.map((a: any) =>
          `<tr><td>${a.title || '—'}</td><td>${a.type || '—'}</td><td>${a.date ? formatDate(a.date) : '—'}</td><td>${a.assessor || '—'}</td><td>${a.status || '—'}</td></tr>`
        ).join('')}</tbody>
      </table>`;
    })());

    const reintegration = section('Reintegration Plan', `
      ${row('Current Phase', child.casePhase)}
      <p style="margin-top:8px;font-size:12px;color:#6b7280;">
        ${child.casePhase?.includes('Reintegration')
          ? 'Resident is in the final stages of the program and is being prepared for community reintegration and discharge.'
          : child.casePhase?.includes('Pre-integration')
          ? 'Resident is undergoing pre-integration activities including family counseling and community linkage.'
          : 'Resident is still in the active rehabilitation phase. Reintegration planning will begin upon reaching the Pre-integration Phase.'}
      </p>
    `);

    return `
      <div class="resident-block">
        <div class="resident-header">
          <div>
            <div class="resident-name">${child.name}</div>
            <div class="resident-meta">${child.id} &nbsp;|&nbsp; ${child.caseType} &nbsp;|&nbsp; Admitted: ${formatDate(child.admissionDate)}</div>
          </div>
          <div class="resident-phase">${child.casePhase || '—'}</div>
        </div>
        ${personalInfo}
        ${caseProgress}
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

  ${selected.map(renderChild).join('')}

  <div class="footer">
    Second Chance Home — City Social Services Department, Calamba, Laguna<br>
    This report is confidential and for authorized personnel only. Generated on ${dateStr}.
  </div>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
  }
}

// ── REPORT FORM ROW ─────────────────────────────────────────────────────────
function ReportFormRow({ form }: { form: ReportForm }) {
  return (
    <div className="flex items-start justify-between gap-3 p-4 rounded-xl border border-gray-100 bg-white hover:border-[#FFD100] hover:shadow-sm transition-all group">
      <div className="flex items-start gap-3 min-w-0">
        <div className="p-2 rounded-lg bg-gray-50 group-hover:bg-[#FFD100]/10 transition-colors shrink-0 mt-0.5">
          <FileText className="w-4 h-4 text-[#2F3E46]" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-[#2F3E46] leading-tight">{form.name}</p>
          <p className="text-xs text-gray-500 mt-0.5 leading-snug">{form.description}</p>
          <p className="text-[10px] text-[#2F3E46]/50 mt-1 italic">{form.when}</p>
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => openForm(form.file, form.name)}
        className="shrink-0 h-8 px-3 text-xs font-bold text-[#2F3E46] hover:bg-[#FFD100] hover:text-[#2F3E46] gap-1.5 transition-all mt-0.5"
        title={`Open ${form.name}`}
      >
        <Download className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Open</span>
      </Button>
    </div>
  );
}

// ── COLLAPSIBLE SECTION ─────────────────────────────────────────────────────
interface FormsSectionProps {
  title: string;
  role: string;
  icon: React.ReactNode;
  accentColor: string;
  bgColor: string;
  forms: ReportForm[];
  defaultOpen?: boolean;
}

function ReportFormsSection({
  title, role, icon, accentColor, bgColor, forms, defaultOpen = true,
}: FormsSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Card className="shadow-sm border-none overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-5 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl" style={{ backgroundColor: bgColor }}>
            <span style={{ color: accentColor }}>{icon}</span>
          </div>
          <div>
            <p className="font-black text-[#2F3E46] text-base">{title}</p>
            <p className="text-xs text-gray-400">{forms.length} form{forms.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            className="text-[10px] font-bold uppercase px-2 py-0.5 border-none"
            style={{ backgroundColor: bgColor, color: accentColor }}
          >
            {role}
          </Badge>
          {open
            ? <ChevronUp className="w-4 h-4 text-gray-400" />
            : <ChevronDown className="w-4 h-4 text-gray-400" />
          }
        </div>
      </button>

      {open && (
        <div className="px-5 pb-5">
          <div className="h-px bg-gray-100 mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {forms.map((form) => (
              <ReportFormRow key={form.file} form={form} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

// ── MAIN COMPONENT ──────────────────────────────────────────────────────────
export function Reports() {
  const { children, assessments, reports, refreshData } = useData();
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

  const handleGenerateReport = () => {
    generateResidentReport(children, selectedResidents, assessments);
  };

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="bg-[#2F3E46] p-6 rounded-xl shadow-md border-b-4 border-[#FFD100]">
        <h2 className="text-2xl font-bold mb-1 text-white">Reports</h2>
        <p className="text-gray-300">Generate, download, and manage facility reports</p>
      </div>

      {/* ── DSWD SCHEDULED REPORTS ── */}
      <Card className="shadow-sm border-none border-l-4 border-l-[#2F3E46]">
        <CardHeader className="border-b border-gray-100 bg-gray-50/50">
          <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
            <Activity className="w-5 h-5 text-[#FFD100]" />
            DSWD Scheduled Reports
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <p className="text-sm text-gray-500 mb-4">
            Government-compliant reports automatically generated by the system. Daily reports at 23:59 and quarterly DSWD reports at quarter-end.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 rounded-xl bg-blue-50 border border-blue-100">
              <div className="flex items-center gap-2 mb-2">
                <Badge className="bg-blue-100 text-blue-700">Daily</Badge>
                <span className="text-xs text-gray-500">Auto-generated at 23:59</span>
              </div>
              <p className="font-semibold text-[#2F3E46]">Daily Facility Report</p>
              <p className="text-xs text-gray-500 mt-1">Resident count, violations, assessments, court hearings</p>
              <DSWDReportGenerator type="daily" />
            </div>
            <div className="p-4 rounded-xl bg-purple-50 border border-purple-100">
              <div className="flex items-center gap-2 mb-2">
                <Badge className="bg-purple-100 text-purple-700">Quarterly</Badge>
                <span className="text-xs text-gray-500">Auto-generated at quarter-end</span>
              </div>
              <p className="font-semibold text-[#2F3E46]">DSWD Quarterly Report</p>
              <p className="text-xs text-gray-500 mt-1">Demographics, statistics, phase distribution, compliance</p>
              <DSWDReportGenerator type="quarterly" />
            </div>
          </div>
          <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-100">
            <p className="text-xs text-amber-800">
              <strong>Note:</strong> These reports follow DSWD formatting standards. The system automatically generates daily reports at 23:59 and quarterly reports at 23:55 on the last day of each quarter (Manila time).
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ── GENERATED REPORTS HISTORY ── */}
      <Card className="shadow-sm border-none border-l-4 border-l-[#FFD100]">
        <CardHeader className="border-b border-gray-100 bg-gray-50/50">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <ClipboardList className="w-5 h-5 text-[#FFD100]" />
              Generated Reports History
            </CardTitle>
            <Button variant="outline" size="sm" onClick={() => refreshData()} className="text-xs gap-1">
              <Activity className="w-3 h-3" /> Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {reports.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              <ClipboardList className="w-10 h-10 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No reports generated yet.</p>
              <p className="text-xs mt-1">Use the buttons above to generate Daily or Quarterly reports.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                    <th className="text-left p-3">Report ID</th>
                    <th className="text-left p-3">Type</th>
                    <th className="text-left p-3">Title</th>
                    <th className="text-left p-3">Date</th>
                    <th className="text-left p-3">Generated By</th>
                    <th className="text-left p-3">Status</th>
                    <th className="text-left p-3">Stats</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {[...reports].sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()).map((report: any) => {
                    const stats = report.summary || report.statistics || {};
                    const isDaily = report.type === 'daily' || report.reportType === 'daily' || (report.id || '').toLowerCase().includes('daily');
                    const isQuarterly = report.type === 'quarterly' || report.reportType === 'quarterly' || (report.id || '').toLowerCase().includes('quarterly');
                    const isDischarge = report.type === 'discharge';
                    return (
                      <tr key={report.id} className="hover:bg-gray-50 transition-colors">
                        <td className="p-3 font-mono text-xs text-gray-500">{report.id}</td>
                        <td className="p-3">
                          <Badge className={isDaily ? 'bg-blue-100 text-blue-700' : isQuarterly ? 'bg-purple-100 text-purple-700' : isDischarge ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'}>
                            {isDaily ? 'Daily' : isQuarterly ? 'Quarterly' : isDischarge ? 'Discharge' : report.type || 'Report'}
                          </Badge>
                        </td>
                        <td className="p-3 text-gray-700 text-xs max-w-[200px] truncate" title={report.title || ''}>{report.title || '—'}</td>
                        <td className="p-3 text-gray-700">{formatDate(report.date || report.reportDate || report.createdAt)}</td>
                        <td className="p-3 text-gray-600">{report.generatedBy || report.createdBy || 'System'}</td>
                        <td className="p-3">
                          <Badge className="bg-green-100 text-green-700">{report.status || 'Generated'}</Badge>
                        </td>
                        <td className="p-3 text-xs text-gray-500">
                          {Object.keys(stats).length > 0 ? (
                            <span title={JSON.stringify(stats, null, 2)} className="cursor-help underline decoration-dotted">
                              {stats.activeResidents != null ? `${stats.activeResidents} residents` : ''}
                              {stats.violationsToday != null ? ` · ${stats.violationsToday} violations` : ''}
                              {stats.totalViolations != null ? ` · ${stats.totalViolations} violations` : ''}
                            </span>
                          ) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── SYSTEM-GENERATED REPORTS ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* Discharge Reports */}
        <Card className="shadow-sm border-none">
          <CardHeader className="border-b border-gray-100">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <FileText className="w-5 h-5 text-[#FFD100]" />
              Resident Discharge Reports
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <p className="text-sm text-gray-500 mb-4">
              Generate comprehensive discharge reports for residents.
            </p>
            <Dialog>
              <DialogTrigger asChild>
                <Button className="w-full bg-[#2F3E46] hover:bg-[#263440] text-white gap-2">
                  <FileText className="w-4 h-4" />
                  Generate Resident Report
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md bg-white rounded-2xl">
                <DialogHeader>
                  <DialogTitle className="text-[#2F3E46] font-bold">Select Residents</DialogTitle>
                  <DialogDescription>
                    Choose which residents to include in the comprehensive report.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 mt-2">
                  <div className="flex items-center space-x-2 p-3 border rounded-xl bg-gray-50">
                    <Checkbox id="select-all" checked={selectAll} onCheckedChange={handleSelectAll} />
                    <Label htmlFor="select-all" className="font-medium cursor-pointer">Select All Residents</Label>
                  </div>
                  {activeChildren.length === 0 ? (
                    <p className="text-sm text-gray-400 italic text-center py-4">No active residents found. Add residents in Child Records first.</p>
                  ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {activeChildren.map((child) => (
                        <div key={child.id} className="flex items-center space-x-2 p-3 border rounded-xl hover:bg-gray-50">
                          <Checkbox
                            id={child.id}
                            checked={selectedResidents.includes(child.id)}
                            onCheckedChange={() => handleSelectResident(child.id)}
                          />
                          <Label htmlFor={child.id} className="cursor-pointer flex-1">
                            <span className="font-medium">{child.name}</span>
                            <span className="text-xs text-gray-400 ml-2">({child.id})</span>
                          </Label>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="pt-3 border-t space-y-2">
                    <p className="text-sm text-gray-500">Selected: {selectedResidents.length} resident(s)</p>
                    <Button
                      className="w-full bg-[#2F3E46] hover:bg-[#263440] text-white gap-2"
                      disabled={selectedResidents.length === 0}
                      onClick={handleGenerateReport}
                    >
                      <Printer className="w-4 h-4" />
                      Generate & Print Report{selectedResidents.length > 1 ? 's' : ''}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            <div className="mt-4 p-4 rounded-xl bg-blue-50 border border-blue-100">
              <p className="text-xs text-[#2F3E46] leading-relaxed">
                <strong>Includes:</strong> Personal info, case progress, medical records, activity participation, behavioral assessments, and reintegration plan. Opens in a new tab — use <strong>Print / Save as PDF</strong> to keep a copy.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── PRINTABLE REPORTING FORMS ── */}
      <div className="space-y-3">
        <div className="flex items-center gap-3 pt-2">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-xs font-black uppercase tracking-widest text-gray-400 px-2">
            Printable Reporting Forms
          </span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>

        <p className="text-sm text-gray-500 text-center pb-1">
          Official forms used to document and report resident progress, incidents, and session records.
        </p>

        <ReportFormsSection
          title="Social Worker Reporting Forms"
          role="Social Worker"
          icon={<Briefcase className="w-5 h-5" />}
          accentColor="#2F3E46"
          bgColor="#FFD100"
          forms={SW_REPORT_FORMS}
          defaultOpen
        />

        <ReportFormsSection
          title="Psychologist Reporting Forms"
          role="Psychologist"
          icon={<Brain className="w-5 h-5" />}
          accentColor="#7C3AED"
          bgColor="#EDE9FE"
          forms={PSYCH_REPORT_FORMS}
          defaultOpen
        />
      </div>

      {/* ── GUIDELINES & LEGEND ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="shadow-sm border-none">
          <CardHeader className="border-b border-gray-100">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <ClipboardList className="w-5 h-5 text-[#FFD100]" />
              Report Guidelines
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-3 text-sm text-gray-600">
            {[
              { icon: <FileText className="w-4 h-4 text-[#FFD100] shrink-0 mt-0.5" />, label: 'Discharge Reports', text: 'Comprehensive documentation required for resident discharge or transfer.' },
              { icon: <AlertTriangle className="w-4 h-4 text-[#FFD100] shrink-0 mt-0.5" />, label: 'Incident Reports', text: 'Must be filed immediately after any critical incident for proper documentation.' },
              { icon: <Activity className="w-4 h-4 text-[#FFD100] shrink-0 mt-0.5" />, label: 'TRI', text: 'Submitted at the end of each rehabilitation period to track resident progress.' },
              { icon: <MessageSquare className="w-4 h-4 text-[#FFD100] shrink-0 mt-0.5" />, label: 'Counseling Forms', text: 'Filled after every dialogue or counseling session by the assigned psychologist.' },
              { icon: <Star className="w-4 h-4 text-[#FFD100] shrink-0 mt-0.5" />, label: 'Exit Form (RPSE)', text: 'Completed by the resident upon discharge to evaluate the rehabilitation program.' },
            ].map(({ icon, label, text }) => (
              <div key={label} className="flex gap-2.5">
                {icon}
                <p><strong>{label}:</strong> {text}</p>
              </div>
            ))}
            <div className="flex gap-2.5">
              <FileText className="w-4 h-4 text-[#FFD100] shrink-0 mt-0.5" />
              <p><strong>Confidentiality:</strong> All reports contain sensitive information and must follow data privacy regulations.</p>
            </div>
          </CardContent>
        </Card>

        {/* Recent Downloads */}
        <Card className="shadow-sm border-none">
          <CardHeader className="border-b border-gray-100">
            <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
              <Download className="w-5 h-5 text-[#FFD100]" />
              Recent Downloads
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-2">
            {[
              { title: 'Daily Report — February 4, 2026',     meta: 'Downloaded Feb 5, 2026 · 9:15 AM' },
              { title: 'Discharge Report — Juan Dela Cruz',   meta: 'Downloaded Feb 3, 2026 · 2:30 PM' },
              { title: 'Monthly Summary — January 2026',      meta: 'Downloaded Feb 1, 2026 · 10:00 AM' },
            ].map(({ title, meta }) => (
              <div key={title} className="flex justify-between items-center p-3 border border-gray-100 rounded-xl hover:border-[#FFD100] hover:bg-gray-50 transition-all text-sm">
                <div>
                  <p className="font-semibold text-[#2F3E46]">{title}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{meta}</p>
                </div>
                <Button size="sm" variant="ghost" className="hover:bg-[#FFD100]/10 text-[#2F3E46]">
                  <Download className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
