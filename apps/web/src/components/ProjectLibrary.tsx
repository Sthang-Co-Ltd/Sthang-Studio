import { useI18n } from '../i18n';
import { formatInterfaceDate } from '../i18n/dates';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FolderOpen, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import type { CaptionProjectSummary } from '@kcs/shared';
import { selectProjectLibrary, type ProjectLibrarySort, type ProjectLibraryView } from '../project-library';
import { canRestore, type useProjectBin } from '../use-project-bin';
import { useProjectNavigationFocus } from '../use-project-navigation-focus';
import { type StudioConfirmOptions } from './ConfirmationDialog';
import { ProjectMoreMenu } from './ProjectMoreMenu';
import { ProjectRenameDialog } from './ProjectRename';
import type { BinnedProject } from '../api';
import '../project-library.css';

interface ProjectLibraryProps {
  focusHeadingOnMount: boolean;
  projects: CaptionProjectSummary[];
  view: ProjectLibraryView;
  onViewChange: (value: ProjectLibraryView) => void;
  loading: boolean;
  loadFailed: boolean;
  refreshing: boolean;
  refreshError: string;
  refresh(): void;
  disabled: boolean;
  openingProjectId: string | null;
  onOpen: (id: string) => void;
  onBack: () => void;
  onCreate: () => void;
  onRetry: () => void;
  bin: ReturnType<typeof useProjectBin>;
  showBin: boolean;
  onShowBin(value: boolean): void;
  onRename(id: string, title: string, expectedTitle: string): Promise<void>;
  confirm(options: StudioConfirmOptions): Promise<boolean>;
  storageUnavailable?: boolean;
  onReviewStorage?: () => void;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function pageJumps(page: number, pages: number) {
  return [...new Set([1, page - 1, page, page + 1, pages])]
    .filter((number) => number >= 1 && number <= pages).sort((a, b) => a - b);
}
function ProjectDate({ label, value }: { label: string; value: string }) {
  const { locale, t, tr } = useI18n();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>{t('library.dateUnavailable', { label })}</span>;
  return <span>{tr('library.projectDate', { label, date: locale === 'km' ? formatInterfaceDate(locale, date) : dateFormatter.format(date) }, { b: (text) => <time dateTime={date.toISOString()} title={formatInterfaceDate(locale, date, { time: true })}>{text}</time> })}</span>;
}

export function ProjectLibrary({ focusHeadingOnMount, projects, view, onViewChange, loading, loadFailed, refreshing, refreshError, refresh, disabled, openingProjectId, onOpen, onBack, onCreate, onRetry, bin, showBin, onShowBin, onRename, confirm, storageUnavailable = false, onReviewStorage }: ProjectLibraryProps) {
  const { t, tn } = useI18n();
  const ids = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const pageFocusPending = useRef(false);
  const retryFocusPending = useRef(false);
  const binEntry = useRef<HTMLButtonElement>(null);
  const screenFocus = useRef(false);
  const [rename, setRename] = useState<CaptionProjectSummary | null>(null);
  const navigationFocus = useProjectNavigationFocus();
  const [deadlineTick, setDeadlineTick] = useState(0);
  const result = useMemo(() => selectProjectLibrary(projects, view), [projects, view]);
  const jumps = pageJumps(result.page, result.pages);
  const ready = !loading && !loadFailed;

  useEffect(() => { if (focusHeadingOnMount) heading.current?.focus({ preventScroll: true }); }, [focusHeadingOnMount]);
  useLayoutEffect(() => {
    if (!screenFocus.current) return;
    screenFocus.current = false;
    (showBin ? heading.current : binEntry.current)?.focus({ preventScroll: true });
  }, [showBin]);
  useEffect(() => {
    if (!showBin) return;
    const nextDeadline = bin.items.reduce((next, item) => !item.purging && canRestore(item.restoreUntil)
      ? Math.min(next, Date.parse(item.restoreUntil)) : next, Infinity);
    if (nextDeadline === Infinity) return;
    const timer = window.setTimeout(() => {
      if (document.activeElement instanceof HTMLButtonElement && document.activeElement.dataset.binRestore
        && !canRestore(document.activeElement.dataset.restoreUntil || '')) heading.current?.focus();
      setDeadlineTick((value) => value + 1);
    }, Math.min(nextDeadline - Date.now() + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [bin.items, showBin, deadlineTick]);
  useEffect(() => {
    if (pageFocusPending.current) {
      pageFocusPending.current = false;
      resultHeading.current?.focus();
    }
  }, [result.page]);
  useEffect(() => {
    if (retryFocusPending.current && !loading) {
      retryFocusPending.current = false;
      // A later search, sort or Settings interaction owns its focus. Return only
      // while the persistent opening handoff is still the user's current target.
      if (document.activeElement !== heading.current) return;
      if (loadFailed) retry.current?.focus();
      else resultHeading.current?.focus();
    }
  }, [loading, loadFailed]);

  const clearSearch = () => {
    onViewChange({ ...view, query: '', page: 1 });
    search.current?.focus();
  };
  const changePage = (page: number) => {
    pageFocusPending.current = true;
    onViewChange({ ...view, page });
  };

  const move = async (project: CaptionProjectSummary, index: number) => {
    const focus = navigationFocus.capture();
    const adjacent = [result.items[index + 1], result.items[index - 1]];
    if (await bin.move(project)) navigationFocus.complete(focus, () => {
      for (const item of adjacent) {
        const target = item && document.querySelector<HTMLElement>(`[data-library-project="${CSS.escape(item.id)}"]`);
        if (target) return target;
      }
      const visible = document.querySelectorAll<HTMLElement>('.project-library-item:not(:disabled)');
      return visible[visible.length - 1] || resultHeading.current;
    });
    else navigationFocus.cancel(focus);
  };

  const changeBinView = (value: boolean) => {
    screenFocus.current = true;
    onShowBin(value);
    if (value) void bin.refresh();
  };

  const changeBinnedProject = async (item: BinnedProject, remove: boolean, control: HTMLButtonElement) => {
    const next = bin.items.slice(bin.items.indexOf(item) + 1);
    let focus = remove ? null : navigationFocus.capture(control);
    if (remove) {
      await bin.remove(item, () => confirm({
        title: t('library.confirmDelete', { title: item.title }),
        message: t('library.confirmDeleteHelp'),
        confirmLabel: t('library.deleteNow'),
      }), () => {
        // Give the confirmation's own return-focus cleanup a stable target.
        heading.current?.focus();
        focus = navigationFocus.capture(heading.current);
      });
    } else {
      const restored = await bin.restore(item);
      if (!restored && control.isConnected && document.activeElement === control) {
        navigationFocus.cancel(focus);
        return;
      }
    }
    navigationFocus.complete(focus, () => {
      for (const row of next) {
        const target = document.querySelector<HTMLElement>(`[data-bin-restore="${CSS.escape(row.instanceId)}"]`);
        if (target) return target;
      }
      return heading.current;
    });
  };

  if (showBin) return <section className="project-library" aria-labelledby={`${ids}-bin`}>
    <header className="project-library-header">
      <button type="button" className="project-library-back" onClick={() => changeBinView(false)}><ChevronLeft size={16} aria-hidden="true"/>{t('library.backToProjects')}</button>
      <div className="project-library-heading"><h1 id={`${ids}-bin`} ref={heading} tabIndex={-1}>{t('library.recentlyDeleted')}</h1></div>
    </header>
    <p className="project-bin-intro">{t('library.binHelp')}</p>
    {bin.status === 'error' && <div className="project-library-empty" role="alert"><h2>{t('library.binFailed')}</h2>
      <button type="button" onClick={() => { heading.current?.focus(); void bin.refresh(); }}>{t('library.retryBin')}</button></div>}
    {bin.status === 'loading' && <p className="project-bin-intro" role="status">{t('library.binLoading')}</p>}
    {bin.status === 'ready' && !bin.items.length && <div className="project-library-empty"><h2>{t('library.binEmpty')}</h2></div>}
    {bin.items.length > 0 && <ul className="project-library-results" aria-label={t('library.deletedProjects')}>
      {bin.items.map((item) => <li key={item.instanceId} className="project-bin-row">
        <div className="project-library-item-content">
          <strong className="project-library-item-title">{item.title}</strong>
          <div className="project-library-item-meta">
            <span>{tn('library.captions', item.captionCount)}</span>
            <ProjectDate label={t('library.deletedDate')} value={item.binnedAt}/><ProjectDate label={t('library.restoreDate')} value={item.restoreUntil}/>
          </div>
        </div>
        {item.purging ? <div className="project-bin-actions">
          <span>{t('library.purging')}</span>
          <button className="project-library-action" type="button" onClick={onReviewStorage}>{t('library.reviewStorage')}</button>
        </div> : <div className="project-bin-actions">
          {!bin.expiredInstances.has(item.instanceId) && canRestore(item.restoreUntil) && <button className="project-library-action project-bin-restore" type="button"
            data-bin-restore={item.instanceId} data-restore-until={item.restoreUntil} aria-disabled={bin.status !== 'ready' || Boolean(bin.pendingId) || undefined}
            onClick={(event) => { if (bin.status === 'ready' && !bin.pendingId) void changeBinnedProject(item, false, event.currentTarget); }}>{t('library.restore')}</button>}
          <button className="project-library-action project-bin-delete" type="button" aria-disabled={bin.status !== 'ready' || Boolean(bin.pendingId) || undefined}
            onClick={(event) => { if (bin.status === 'ready' && !bin.pendingId) void changeBinnedProject(item, true, event.currentTarget); }}>{t('library.deleteNow')}</button>
        </div>}
      </li>)}
    </ul>}
  </section>;

  return <section className="project-library" aria-labelledby={`${ids}-title`}>
    <header className="project-library-header">
      <button type="button" className="project-library-back" onClick={onBack}><ChevronLeft size={16} aria-hidden="true"/>{t('library.backHome')}</button>
      <div className="project-library-heading">
        <h1 id={`${ids}-title`} ref={heading} tabIndex={-1}>{t('library.title')}</h1>
        <div className="project-library-heading-actions">
          <span className="project-library-local"><FolderOpen size={16} aria-hidden="true"/>{t('library.local')}</span>
          <button ref={binEntry} type="button" className="project-library-action" onClick={() => changeBinView(true)}
            aria-description={bin.items.length ? tn('library.projectCount', bin.items.length) : undefined}>
            {t('library.recentlyDeleted')}{bin.items.length > 0 && <span className="project-bin-count" aria-hidden="true">{bin.items.length}</span>}
          </button>
        </div>
      </div>
    </header>

    {(!ready || result.total > 0) && <div className="project-library-toolbar">
      <div className="project-library-search" role="search" aria-label={t('library.searchLabel')}>
        <label htmlFor={`${ids}-search`}>{t('library.search')}</label>
        <div className="project-library-search-field">
          <Search size={18} aria-hidden="true"/>
          <input id={`${ids}-search`} ref={search} type="search" autoComplete="off" value={view.query}
            onChange={(event) => onViewChange({ ...view, query: event.target.value, page: 1 })}/>
          {view.query.length > 0 && <button type="button" className="project-library-clear" onClick={clearSearch}>{t('library.clear')}</button>}
        </div>
      </div>
      <label className="project-library-sort" htmlFor={`${ids}-sort`}><span>{t('library.sort')}</span>
        <select id={`${ids}-sort`} value={view.sort} onChange={(event) => onViewChange({ ...view, sort: event.target.value as ProjectLibrarySort, page: 1 })}>
          <option value="updated">{t('library.lastEdited')}</option><option value="created">{t('library.newestCreated')}</option><option value="title">{t('library.sortByName')}</option>
        </select>
      </label>
    </div>}

    {loading && <div className="project-library-empty" role="status"><LoaderCircle className="spin" size={22} aria-hidden="true"/><h2>{t('library.loading')}</h2><p>{t('library.loadingHelp')}</p></div>}
    {!loading && loadFailed && <div className="project-library-empty" role="alert"><FolderOpen size={25} aria-hidden="true"/><h2>{t('library.loadFailed')}</h2><p>{t('library.loadFailedHelp')}</p>
      <button ref={retry} type="button" onClick={() => {
        if (retryFocusPending.current) return;
        retryFocusPending.current = true;
        heading.current?.focus({ preventScroll: true });
        onRetry();
      }}>{t('library.retry')}</button>
    </div>}

    {ready && <>
      <div className="project-library-refresh">
        <span className={!refreshing && !refreshError && result.total ? 'sthang-sr-only' : undefined} role="status" aria-live="polite" aria-atomic="true">{refreshing ? t('library.refreshing') : refreshError
          ? t('library.refreshFailed', { error: refreshError }) : result.total ? t('library.loaded') : ''}</span>
        <button type="button" aria-disabled={refreshing || undefined} aria-busy={refreshing || undefined}
          onClick={() => { if (!refreshing) refresh(); }}>
          {refreshing ? <LoaderCircle size={16} className="spin" aria-hidden="true"/> : <RefreshCw size={16} aria-hidden="true"/>}{t('library.refresh')}
        </button>
      </div>
      {result.total > 0 && <div className="project-library-summary">
        <h2 ref={resultHeading} tabIndex={-1} aria-live="polite" aria-atomic="true">{result.matches === result.total
          ? tn('library.projectCount', result.total)
          : t('library.matchCount', { matches: result.matches, total: result.total })}</h2>
        {result.pages > 1 && <span>{t('library.showing', { start: result.start, end: result.end })}</span>}
      </div>}
      {result.total === 0 ? <div className="project-library-empty"><FolderOpen size={28} aria-hidden="true"/><h2 ref={resultHeading} tabIndex={-1}>{storageUnavailable ? t('library.storageCheck') : t('library.empty')}</h2><p>{storageUnavailable ? t('library.storageCheckHelp') : t('library.emptyHelp')}</p><button type="button" onClick={storageUnavailable && onReviewStorage ? onReviewStorage : onCreate}>{storageUnavailable && onReviewStorage ? t('library.reviewStorage') : t('library.create')}</button></div>
        : result.matches === 0 ? <div className="project-library-empty"><Search size={26} aria-hidden="true"/><h2>{t('library.noMatches')}</h2><p>{t('library.noMatchesHelp')}</p><button type="button" onClick={clearSearch}>{t('library.showAll')}</button></div>
        : <ul className="project-library-results" aria-label={t('library.results')}>{result.items.map((project, index) => {
          const opening = openingProjectId === project.id;
          const descriptionId = `${ids}-project-${index}`;
          return <li key={project.id} className="project-library-row">
            <button type="button" className="project-library-item" data-library-project={project.id} aria-label={t('library.openNamedProject', { title: project.title })} aria-describedby={descriptionId}
              aria-busy={opening} disabled={disabled || opening || bin.pendingId === project.id} onClick={() => onOpen(project.id)}>
              <span className="project-library-item-content"><strong className="project-library-item-title" title={project.title}>{project.title}</strong>
                <span className="project-library-item-meta" id={descriptionId}>
                  <span>{project.captionCount ? tn('library.captions', project.captionCount) : t('library.unprocessed')}</span>
                  <ProjectDate label={t('library.editedDate')} value={project.updatedAt}/><ProjectDate label={t('library.createdDate')} value={project.createdAt}/>
                </span>
              </span>
              <span className="project-library-open">{opening ? <><LoaderCircle className="spin" size={16} aria-hidden="true"/>{t('library.opening')}</> : <>{project.captionCount ? t('library.continue') : t('library.open')}<ChevronRight size={16} aria-hidden="true"/></>}</span>
            </button>
            <ProjectMoreMenu id={project.id} title={project.title} disabled={disabled || opening || Boolean(bin.pendingId)}
              onRename={() => setRename(project)} onMove={() => void move(project, index)}/>
          </li>;
        })}</ul>}
      {result.pages > 1 && <nav className="project-library-pagination" aria-label={t('library.pages')}>
        <button type="button" disabled={result.page === 1} onClick={() => changePage(result.page - 1)}><ChevronLeft size={16} aria-hidden="true"/>{t('library.previous')}</button>
        <span aria-live="polite">{t('library.page', { page: result.page, pages: result.pages })}</span>
        {result.pages > 2 && <div className="project-library-jumps">
          {jumps.map((number, index) => <span key={number}>
            {index > 0 && number > jumps[index - 1] + 1 && <i aria-hidden="true">…</i>}
            <button type="button" aria-label={t('library.goToPage', { number })}
              aria-current={number === result.page ? 'page' : undefined}
              onClick={() => { if (number !== result.page) changePage(number); }}>{number}</button>
          </span>)}
        </div>}
        <button type="button" disabled={result.page === result.pages} onClick={() => changePage(result.page + 1)}>{t('library.next')}<ChevronRight size={16} aria-hidden="true"/></button>
      </nav>}
    </>}
    {rename && <ProjectRenameDialog title={rename.title} onClose={() => setRename(null)}
      onRename={(title, expectedTitle) => onRename(rename.id, title, expectedTitle)}
      returnFocus={() => document.querySelector<HTMLElement>(`[data-library-more="${CSS.escape(rename.id)}"]`) || resultHeading.current}/>}
  </section>;
}
