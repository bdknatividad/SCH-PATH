/**
 * "Quarterly Progress Reports Per Program" — where the filed program reports are
 * gathered up so a quarter can be taken as a package.
 *
 * The Education module files an **Education Quarterly Report** and the Health
 * module a **Medical Quarterly Report**, one per resident per calendar quarter,
 * through the same official PROGRESS REPORT form (`ProgressReportDialog`). They
 * land in the Documents module, because that is where a reviewer signs them —
 * the reviewer's signature is drawn onto the stored PDF at approval
 * (`utils/progressReportApproval`), so the file downloaded here already carries
 * the Center Head's or the Social Worker's signature.
 *
 * What was missing was the other half of the loop: a place to *see* the quarter
 * across programs and take all of it in one archive. That is this section.
 *
 * **It reads `documents` from the store rather than fetching its own list.** The
 * server already scopes that list per role (`DOCUMENT_READ_ROLES_BY_CATEGORY`),
 * so a row here and the file it opens cannot disagree, and a program in-charge
 * sees their own program's reports without a second, differently-scoped query.
 *
 * @module components/ProgramQuarterlyReports
 */

import { useMemo, useState } from 'react';
import { Badge } from '@/app/components/ui/badge';
import { Button } from '@/app/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Label } from '@/app/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/app/components/ui/select';
import { Download, FileText, Layers, Loader2 } from 'lucide-react';
import { useData } from '../state/DataContext';
import { downloadDocumentFile } from '@/utils/documentFile';
import { downloadReportZip } from '@/app/utils/downloadReportZip';
import {
  PROGRESS_REPORT_TYPES,
  calendarQuarter,
  progressReportProgramOf,
  progressReportQuarterKey,
  quarterSortKey,
} from '@/app/utils/progressReportTypes';

/** The module each program's report comes from — used to keep ZIP entries apart. */
const PROGRAM_MODULE: Record<string, string> = {
  'Education Quarterly Report': 'Education',
  'Medical Quarterly Report': 'Health',
};

/**
 * A report filed before the quarter was recorded on the row.
 *
 * It is shown as its own group rather than hidden: a report that exists and
 * cannot be seen is the failure mode this page exists to prevent, and a row
 * quietly missing from a consolidation is not something a reader can notice.
 */
const UNFILED_QUARTER = 'Quarter not recorded';

/** The status colours the Documents module uses, so the two read the same. */
const STATUS_STYLE: Record<string, string> = {
  Approved: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  Rejected: 'border-red-200 bg-red-50 text-red-700',
  Submitted: 'border-amber-200 bg-amber-50 text-amber-700',
  'Under Review': 'border-blue-200 bg-blue-50 text-blue-700',
};

/** `12 September 2026`, in the facility's own timezone. */
function formatDay(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila', day: 'numeric', month: 'long', year: 'numeric',
  });
}

export function ProgramQuarterlyReports() {
  const { documents, children } = useData();
  const [quarter, setQuarter] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [zipping, setZipping] = useState<{ label: string; done: number; total: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reports = useMemo(
    () => (documents as any[]).filter((doc) => progressReportProgramOf(doc)),
    [documents],
  );

  const currentQuarter = `${calendarQuarter()} ${new Date().getFullYear()}`;

  const quarterOptions = useMemo(() => {
    const keys = new Set<string>([currentQuarter]);
    for (const doc of reports) keys.add(progressReportQuarterKey(doc) || UNFILED_QUARTER);
    return [...keys].sort((a, b) => quarterSortKey(b) - quarterSortKey(a));
  }, [reports, currentQuarter]);

  // The picker opens on the quarter being worked in. A selection that is no
  // longer on offer (the last report of that quarter was deleted) falls back
  // rather than filtering the page down to nothing.
  const selectedQuarter = quarterOptions.includes(quarter) ? quarter : currentQuarter;

  const residentNameOf = (doc: any) =>
    doc.residentName
    || children.find((child) => String(child.id) === String(doc.residentId))?.name
    || doc.residentId
    || 'Unknown resident';

  const rowsFor = (program: string) =>
    reports.filter((doc) =>
      progressReportProgramOf(doc) === program
      && (progressReportQuarterKey(doc) || UNFILED_QUARTER) === selectedQuarter,
    );

  const programs = PROGRESS_REPORT_TYPES.map((program) => ({
    program,
    module: PROGRAM_MODULE[program] || program,
    rows: rowsFor(program),
  }));

  const consolidated = programs.flatMap((block) => block.rows);

  /** The name the file is saved under, built from the row rather than guessed. */
  const fileNameFor = (doc: any) => {
    if (doc.fileName) return String(doc.fileName);
    const who = residentNameOf(doc).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    const period = (progressReportQuarterKey(doc) || selectedQuarter).replace(/\s+/g, '-');
    return `${progressReportProgramOf(doc).replace(/\s+/g, '-')}-${who}-${period}.pdf`;
  };

  const handleDownloadOne = async (doc: any) => {
    setMessage(null);
    setDownloadingId(doc.id);
    try {
      // The stored PDF, not a re-render: this is the copy the reviewer signed,
      // and it is what the facility files.
      await downloadDocumentFile(doc, setMessage);
    } finally {
      setDownloadingId(null);
    }
  };

  /**
   * One ZIP for the chosen quarter.
   *
   * `label` names the archive, and `withProgram` prefixes each entry with the
   * module it came from — necessary for the consolidated archive, where the
   * Education and Medical reports for the same resident would otherwise share a
   * file name and one would replace the other. The ZIP builder flattens any
   * path separator in an entry name, so the module goes in the name itself.
   */
  const handleZip = async (label: string, docs: any[], withProgram: boolean) => {
    setMessage(null);
    if (!docs.length) {
      setMessage(`No progress reports were filed for ${selectedQuarter} in that selection, so there is nothing to put in a ZIP.`);
      return;
    }
    const items = docs.map((doc) => ({
      path: `/documents/${doc.id}/file`,
      name: withProgram
        ? `${PROGRAM_MODULE[progressReportProgramOf(doc)] || 'Reports'} - ${fileNameFor(doc)}`
        : fileNameFor(doc),
    }));
    try {
      setZipping({ label, done: 0, total: items.length });
      const result = await downloadReportZip(
        `${label.replace(/\s+/g, '-')}-${selectedQuarter.replace(/\s+/g, '-')}.zip`,
        items,
        (done, total) => setZipping({ label, done, total }),
      );
      if (result.skipped.length) {
        setMessage(`${result.included} of ${items.length} reports were added to the ZIP. These could not be downloaded: ${result.skipped.join(', ')}.`);
      }
    } catch (err: any) {
      setMessage(err?.message || 'Unable to build the ZIP.');
    } finally {
      setZipping(null);
    }
  };

  return (
    <Card className="border-none shadow-sm">
      <CardHeader className="border-b border-gray-100">
        <CardTitle className="flex items-center gap-2 text-[#2F3E46]">
          <Layers className="w-5 h-5 text-[#FFD100]" /> Quarterly Progress Reports Per Program
        </CardTitle>
        <CardDescription>
          The quarterly report each program files per resident, gathered by program for the chosen quarter.
          Every filed report is listed with what a reviewer has done with it, and the download is the stored
          copy — which carries the reviewer&rsquo;s signature once it is approved.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs font-semibold text-gray-500">Quarter</Label>
            <Select value={selectedQuarter} onValueChange={setQuarter}>
              <SelectTrigger className="h-10 w-52"><SelectValue /></SelectTrigger>
              <SelectContent>
                {quarterOptions.map((option) => (
                  <SelectItem key={option} value={option}>{option}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() => void handleZip('Quarterly-Progress-Reports-All-Programs', consolidated, true)}
            disabled={zipping !== null || !consolidated.length}
            className="gap-2 bg-[#2F3E46] text-white hover:bg-[#243038]"
          >
            {zipping && zipping.label.startsWith('Quarterly-Progress-Reports-All') ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {zipping && zipping.label.startsWith('Quarterly-Progress-Reports-All')
              ? `Zipping ${zipping.done}/${zipping.total}…`
              : 'Download all programs as ZIP'}
          </Button>
        </div>

        {message && <p className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{message}</p>}

        {/* One block per program, each with the same two actions in the same
            order: a PDF per resident, and one ZIP for the program's quarter. */}
        <div className="mt-5 space-y-4">
          {programs.map((block) => {
            const zippingThis = zipping && zipping.label === `${block.module}-Quarterly-Progress-Reports`;
            return (
              <div key={block.program} className="overflow-hidden rounded-xl border border-gray-200">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 bg-gray-50/60 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[#2F3E46]">
                      {block.program} — {block.rows.length} for {selectedQuarter}
                    </p>
                    <p className="text-xs text-gray-500">
                      Filed from the {block.module} module. Each resident&rsquo;s report is a separate PDF; the ZIP holds all of them.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => void handleZip(`${block.module}-Quarterly-Progress-Reports`, block.rows, false)}
                    disabled={zipping !== null || !block.rows.length}
                    className="gap-2"
                  >
                    {zippingThis ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    {zippingThis ? `Zipping ${zipping!.done}/${zipping!.total}…` : 'Download as ZIP'}
                  </Button>
                </div>
                {block.rows.length === 0 ? (
                  <p className="px-4 py-4 text-sm italic text-gray-400">
                    No {block.program} was filed for {selectedQuarter}.
                  </p>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {block.rows.map((doc) => {
                      const filed = doc.approvedAt || doc.submittedAt || doc.uploadedAt;
                      return (
                        <li key={doc.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                          <span className="min-w-0">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-sm font-semibold text-[#2F3E46]">{residentNameOf(doc)}</span>
                              <Badge variant="outline" className={STATUS_STYLE[doc.status] || 'border-gray-200 bg-gray-50 text-gray-600'}>
                                {doc.status || 'Submitted'}
                              </Badge>
                            </span>
                            <span className="block text-[11px] text-gray-400">
                              {doc.approvedAt
                                ? `Signed ${formatDay(doc.approvedAt)}${doc.approvedBy ? ` by ${doc.approvedBy}` : ''}`
                                : `${doc.status === 'Rejected' ? 'Rejected' : 'Waiting for a reviewer'} · filed ${formatDay(filed)}`}
                              {doc.fileName ? ` · ${doc.fileName}` : ''}
                            </span>
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            disabled={downloadingId !== null}
                            onClick={() => void handleDownloadOne(doc)}
                          >
                            {downloadingId === doc.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                            Download PDF
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>

        {!reports.length && (
          <p className="mt-4 flex items-center gap-2 text-xs text-gray-400">
            <FileText className="w-3.5 h-3.5" />
            No Education or Medical quarterly report has been filed yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
