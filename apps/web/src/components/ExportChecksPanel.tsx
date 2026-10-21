import { useEffect, useMemo, useState } from 'react';
import type { CaptionSegment } from '@kcs/shared';
import { Check, ChevronLeft, ChevronRight, ListChecks, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { ExportCheckIssue, ExportRepairTarget } from '../export-checks';
import { formatTimestamp } from '../timestamp';
import './export-checks.css';

export type ExportLayoutState = 'unchecked' | 'checking' | 'passed' | 'blocked' | 'stale' | 'error';

interface Props {
  captions: CaptionSegment[];
  issues: ExportCheckIssue[];
  onRepair(target: ExportRepairTarget): void;
  unsaved: boolean;
  saveBlocked: boolean;
  appearancePending?: boolean;
  appearancePrerequisite?: { message: string; actionLabel: string; onRecover(): void };
  layoutState?: ExportLayoutState;
  layoutMessage?: string;
  layoutDisabled?: boolean;
  onCheckLayout?(): void;
  onCancelLayout?(): void;
}

const PAGE_SIZE = 8;

export function ExportChecksPanel({ captions, issues, onRepair, unsaved, saveBlocked,
  appearancePending, appearancePrerequisite,
  layoutState, layoutMessage, layoutDisabled, onCheckLayout, onCancelLayout }: Props) {
  const [page, setPage] = useState(0);
  const [issuesExpanded, setIssuesExpanded] = useState(false);
  const identity = issues.map((issue) => issue.id).join('\0');
  useEffect(() => { setPage(0); }, [identity]);
  const captionsById = useMemo(() => new Map(captions.map((caption, index) => [caption.id, { caption, index }])), [captions]);
  const pages = Math.max(1, Math.ceil(issues.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = issues.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const blockers = issues.filter((issue) => issue.severity === 'blocker').length;
  const suggestions = issues.length - blockers;
  useEffect(() => { if (blockers > 0) setIssuesExpanded(true); }, [blockers]);

  const changePage = (next: number) => {
    setPage(next);
    document.getElementById('export-checks-heading')?.focus();
  };

  return <section className="export-checks" aria-labelledby="export-checks-heading">
    <div className="export-checks-head">
      <div><h3 id="export-checks-heading" tabIndex={-1}><ListChecks size={17}/>Check before export</h3>
        <p>{blockers > 0 ? `${blockers} blocker${blockers === 1 ? '' : 's'}` : 'No caption blockers'}
          {suggestions > 0 ? ` · ${suggestions} review suggestion${suggestions === 1 ? '' : 's'}` : ''} for this output.</p></div>
    </div>

    {saveBlocked ? <p className="export-check-save" role="status"><TriangleAlert size={16}/>Resolve the saved-project conflict before exporting. Your current edits are kept in the editor.</p>
      : unsaved && <p className="export-check-save" role="status">These checks include your current caption edits. Export will save them first; a failed save keeps your edits and stops the export.</p>}

    {appearancePending && <p className="export-check-save" role="status"><LoaderCircle className="spin" size={16}/>Loading saved caption appearance… Styled export stays blocked until it is verified. Plain SRT does not use appearance.</p>}
    {appearancePrerequisite && <div className="export-layout-check error export-appearance-prerequisite" role="alert">
      <div><strong><TriangleAlert size={16}/>Caption appearance needs attention</strong><span>{appearancePrerequisite.message} Plain SRT does not use appearance.</span></div>
      <button type="button" onClick={appearancePrerequisite.onRecover}>{appearancePrerequisite.actionLabel}</button>
    </div>}

    {onCheckLayout && <div className={`export-layout-check ${layoutState || 'unchecked'}`}>
      <div role="status">
        <strong>{layoutState === 'passed' ? <><Check size={15}/>Layout fits the checked frame</>
          : layoutState === 'checking' ? <><LoaderCircle className="spin" size={15}/>Checking all caption layouts…</>
            : layoutState === 'stale' ? 'Layout changed — check again'
              : layoutState === 'blocked' ? 'Layout needs attention'
                : layoutState === 'error' ? 'Layout check did not finish'
                  : 'Full layout has not been checked'}</strong>
        <span>{layoutMessage || (layoutState === 'passed'
          ? 'Checked the current captions, appearance and resolution. The final export checks its own snapshot again.'
          : 'Check the whole project at this output resolution, including captions that overlap. This runs locally when you ask.')}</span>
      </div>
      {layoutState === 'checking'
        ? <button type="button" onClick={onCancelLayout}>Cancel check</button>
        : <button type="button" disabled={layoutDisabled} onClick={onCheckLayout}>{layoutState === 'unchecked' ? 'Check layout' : 'Recheck layout'}</button>}
    </div>}

    {issues.length > 0 && <details className="export-check-details" open={issuesExpanded} onToggle={(event) => setIssuesExpanded(event.currentTarget.open)}>
      <summary>{blockers > 0 ? 'View captions blocking this output' : 'View captions to review'}</summary>
      <ol className="export-check-list" aria-label="Export issues" start={currentPage * PAGE_SIZE + 1}>
        {visible.map((issue) => <li key={issue.id} className="export-check-item" data-severity={issue.severity}>
          <div className="export-check-title"><strong>{issue.title}</strong><span>{issue.severity === 'blocker' ? 'Blocks this output' : 'Review suggestion'}</span></div>
          {issue.captionIds.length > 1 && <p className="export-check-group">These captions appear together. Check the group in the video.</p>}
          {issue.captionIds.map((id) => {
            const match = captionsById.get(id);
            return match && <div className="export-check-caption" key={id}>
              <div><strong>Caption {match.index + 1}<small>{formatTimestamp(match.caption.startMs)} – {formatTimestamp(match.caption.endMs)}</small></strong>
                <p lang={/\p{Script=Khmer}/u.test(match.caption.text) ? 'km' : undefined}>{match.caption.text || '(Empty caption)'}</p></div>
              <button type="button" onClick={() => onRepair({ kind: issue.repair, captionId: id })}>Go to caption {match.index + 1}</button>
            </div>;
          })}
          <ul className="export-check-reasons">{issue.reasons.map((reason, index) => <li key={`${index}:${reason}`}>{reason}</li>)}</ul>
          <p className="export-check-remedy">{issue.remedy}</p>
          {issue.captionIds.length === 0 && <button className="export-check-global-action" type="button" onClick={() => onRepair({ kind: issue.repair })}>{issue.id === 'font' ? 'Choose an available font' : issue.repair === 'appearance' ? 'Review appearance' : 'Review captions'}</button>}
        </li>)}
      </ol>
      {pages > 1 && <nav className="export-check-pages" aria-label="Export issue pages">
        <button type="button" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}><ChevronLeft size={15}/>Previous issues</button>
        <span aria-live="polite">{currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, issues.length)} of {issues.length}</span>
        <button type="button" disabled={currentPage === pages - 1} onClick={() => changePage(currentPage + 1)}>Next issues<ChevronRight size={15}/></button>
      </nav>}
    </details>}
  </section>;
}
