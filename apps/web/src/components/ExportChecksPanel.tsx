import { useEffect, useMemo, useState, type ReactNode, type Ref } from 'react';
import { useI18n } from '../i18n';
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
  headingRef?: Ref<HTMLHeadingElement>;
  appearancePending?: boolean;
  appearancePrerequisite?: { message: string; actionLabel: string; onRecover(trigger: HTMLButtonElement): void };
  layoutState?: ExportLayoutState;
  layoutMessage?: string;
  layoutDisabled?: boolean;
  onCheckLayout?(): void;
  onCancelLayout?(): void;
  supportAction?: ReactNode;
}

const PAGE_SIZE = 8;

export function ExportChecksPanel({ captions, issues, onRepair, unsaved, saveBlocked,
  headingRef, appearancePending, appearancePrerequisite,
  layoutState, layoutMessage, layoutDisabled, onCheckLayout, onCancelLayout, supportAction }: Props) {
  const { t, tn } = useI18n();
  const [page, setPage] = useState(0);
  const [issuesExpanded, setIssuesExpanded] = useState(false);
  const identity = issues.map((issue) => issue.id).join('\0');
  useEffect(() => { setPage(0); }, [identity]);
  const captionsById = useMemo(() => new Map(captions.map((caption, index) => [caption.id, { caption, index }])), [captions]);
  const pages = Math.max(1, Math.ceil(issues.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = issues.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
    .map((issue) => ({ ...issue, visibleReasons: issue.reasons.map((text, index) => ({ text, message: issue.reasonMessages?.[index], index }))
      .filter(({ text, index }) => issue.titleIsFirstReason ? index > 0 : text !== issue.title) }));
  const blockers = issues.filter((issue) => issue.severity === 'blocker').length;
  const suggestions = issues.length - blockers;
  const blockerSummary = blockers > 0 ? tn('export.checks.blockerCount', blockers) : t('export.checks.noBlockers');
  useEffect(() => { if (blockers > 0) setIssuesExpanded(true); }, [blockers]);

  const changePage = (next: number) => {
    setPage(next);
    document.getElementById('export-checks-heading')?.focus();
  };

  return <section className="export-checks" aria-labelledby="export-checks-heading">
    <div className="export-checks-head">
      <div><h3 id="export-checks-heading" ref={headingRef} tabIndex={-1}><ListChecks size={17}/>{t('export.checks.title')}</h3>
        <p>{suggestions > 0
          ? t('export.checks.countsWithSuggestions', { blockers: blockerSummary, suggestions: tn('export.checks.suggestionCount', suggestions) })
          : t('export.checks.counts', { blockers: blockerSummary })}</p></div>
      {supportAction}
    </div>

    {saveBlocked ? <p className="export-check-save" role="status"><TriangleAlert size={16}/>{t('export.checks.savedConflict')}</p>
      : unsaved && <p className="export-check-save" role="status">{t('export.checks.unsaved')}</p>}

    {appearancePending && <p className="export-check-save" role="status"><LoaderCircle className="spin" size={16}/>{t('export.checks.appearanceLoading')}</p>}
    {appearancePrerequisite && <div className="export-layout-check error export-appearance-prerequisite" role="alert">
      <div><strong><TriangleAlert size={16}/>{t('export.checks.appearanceAttention')}</strong><span>{t('export.checks.withSrtAvailable', { message: appearancePrerequisite.message })}</span></div>
      <button type="button" onClick={(event) => appearancePrerequisite.onRecover(event.currentTarget)}>{appearancePrerequisite.actionLabel}</button>
    </div>}

    {onCheckLayout && <div className={`export-layout-check ${layoutState || 'unchecked'}`}>
      <div role="status">
        <strong>{layoutState === 'passed' ? <><Check size={15}/>{t('export.checks.layoutPassed')}</>
          : layoutState === 'checking' ? <><LoaderCircle className="spin" size={15}/>{t('export.checks.layoutChecking')}</>
            : layoutState === 'stale' ? t('export.checks.layoutStale')
              : layoutState === 'blocked' ? t('export.checks.layoutBlocked')
                : layoutState === 'error' ? t('export.checks.layoutError')
                  : t('export.checks.layoutOptional')}</strong>
        <span data-server-text={layoutState === 'error' && Boolean(layoutMessage) || undefined}>{layoutMessage || (layoutState === 'passed'
          ? t('export.checks.layoutPassedHelp')
          : layoutState === 'unchecked' || !layoutState ? t('export.checks.layoutUncheckedHelp')
            : t('export.checks.layoutHelp'))}</span>
      </div>
      {layoutState === 'checking'
        ? <button type="button" onClick={onCancelLayout}>{t('export.checks.cancelCheck')}</button>
        : <button type="button" disabled={layoutDisabled} onClick={onCheckLayout}>{layoutState === 'unchecked' ? t('export.checks.checkLayout') : t('export.checks.recheckLayout')}</button>}
    </div>}

    {issues.length > 0 && <details className="export-check-details" open={issuesExpanded} onToggle={(event) => setIssuesExpanded(event.currentTarget.open)}>
      <summary>{blockers > 0 ? t('export.checks.expandBlockers') : t('export.checks.expandSuggestions')}</summary>
      <ol className="export-check-list" aria-label={t('export.checks.issuesLabel')} start={currentPage * PAGE_SIZE + 1}>
        {visible.map((issue) => <li key={issue.id} className="export-check-item" data-severity={issue.severity}>
          <div className="export-check-title"><strong>{issue.titleMessage ? t(issue.titleMessage.key, issue.titleMessage.params) : issue.title}</strong><span>{issue.severity === 'blocker' ? t('export.checks.blocks') : t('export.checks.suggestion')}</span></div>
          {issue.captionIds.length > 1 && <p className="export-check-group">{t('export.checks.group')}</p>}
          {issue.captionIds.map((id) => {
            const match = captionsById.get(id);
            return match && <div className="export-check-caption" key={id}>
              <div><strong>{t('export.checks.caption', { position: match.index + 1 })}<small>{formatTimestamp(match.caption.startMs)} – {formatTimestamp(match.caption.endMs)}</small></strong>
                <p lang={/\p{Script=Khmer}/u.test(match.caption.text) ? 'km' : undefined}>{match.caption.text || t('export.checks.emptyCaption')}</p></div>
              <button type="button" onClick={() => onRepair({ kind: issue.repair, captionId: id })}>{t('export.checks.goToCaption', { position: match.index + 1 })}</button>
            </div>;
          })}
          {issue.visibleReasons.length > 0 && <ul className="export-check-reasons">{issue.visibleReasons.map(({ text, message, index }) => <li key={index} data-server-text={issue.id.startsWith('layout:') && index === 0 || undefined}>{message ? t(message.key, message.params) : text}</li>)}</ul>}
          <p className="export-check-remedy">{issue.remedyMessage ? t(issue.remedyMessage.key, issue.remedyMessage.params) : issue.remedy}</p>
          {issue.captionIds.length === 0 && <button className="export-check-global-action" type="button" onClick={() => onRepair({ kind: issue.repair, focus: issue.id === 'font' ? 'font' : undefined })}>{issue.id === 'font' ? t('export.checks.chooseFont') : issue.repair === 'appearance' ? t('export.checks.reviewAppearance') : t('export.checks.reviewCaptions')}</button>}
        </li>)}
      </ol>
      {pages > 1 && <nav className="export-check-pages" aria-label={t('export.checks.pagesLabel')}>
        <button type="button" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}><ChevronLeft size={15}/>{t('export.checks.previous')}</button>
        <span aria-live="polite">{t('export.checks.pageRange', { start: currentPage * PAGE_SIZE + 1, end: Math.min((currentPage + 1) * PAGE_SIZE, issues.length), total: issues.length })}</span>
        <button type="button" disabled={currentPage === pages - 1} onClick={() => changePage(currentPage + 1)}>{t('export.checks.next')}<ChevronRight size={15}/></button>
      </nav>}
    </details>}
  </section>;
}
