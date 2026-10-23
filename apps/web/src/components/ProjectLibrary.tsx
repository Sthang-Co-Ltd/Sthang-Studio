import { useEffect, useId, useMemo, useRef } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, FolderOpen, LoaderCircle, Search } from 'lucide-react';
import type { CaptionProjectSummary } from '@kcs/shared';
import { selectProjectLibrary, type ProjectLibrarySort, type ProjectLibraryView } from '../project-library';
import '../project-library.css';

interface ProjectLibraryProps {
  projects: CaptionProjectSummary[];
  view: ProjectLibraryView;
  onViewChange: (value: ProjectLibraryView) => void;
  loading: boolean;
  loadFailed: boolean;
  disabled: boolean;
  openingProjectId: string | null;
  onOpen: (id: string) => void;
  onBack: () => void;
  onRetry: () => void;
  storageUnavailable?: boolean;
  onReviewStorage?: () => void;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
function ProjectDate({ label, value }: { label: string; value: string }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>{label}: date unavailable</span>;
  return <span>{label} <time dateTime={date.toISOString()} title={date.toLocaleString()}>{dateFormatter.format(date)}</time></span>;
}

export function ProjectLibrary({ projects, view, onViewChange, loading, loadFailed, disabled, openingProjectId, onOpen, onBack, onRetry, storageUnavailable = false, onReviewStorage }: ProjectLibraryProps) {
  const ids = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const pageFocusPending = useRef(false);
  const retryFocusPending = useRef(false);
  const result = useMemo(() => selectProjectLibrary(projects, view), [projects, view]);
  const ready = !loading && !loadFailed;

  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (pageFocusPending.current) {
      pageFocusPending.current = false;
      resultHeading.current?.focus();
    }
  }, [result.page]);
  useEffect(() => {
    if (retryFocusPending.current && !loading) {
      retryFocusPending.current = false;
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

  return <section className="project-library" aria-labelledby={`${ids}-title`}>
    <header className="project-library-header">
      <button type="button" className="project-library-back" onClick={onBack}><ChevronLeft size={16} aria-hidden="true"/>Back to Home</button>
      <div className="project-library-heading">
        <div><h1 id={`${ids}-title`} ref={heading} tabIndex={-1}>All projects</h1><p>Choose a saved project to continue.</p></div>
        <span className="project-library-local"><FolderOpen size={16} aria-hidden="true"/>Saved on this computer</span>
      </div>
    </header>

    <div className="project-library-toolbar">
      <div className="project-library-search" role="search" aria-label="Find projects">
        <label htmlFor={`${ids}-search`}>Search projects</label>
        <div className="project-library-search-field">
          <Search size={18} aria-hidden="true"/>
          <input id={`${ids}-search`} ref={search} type="search" autoComplete="off" placeholder="Search by project name" value={view.query}
            onChange={(event) => onViewChange({ ...view, query: event.target.value, page: 1 })}/>
          {view.query.length > 0 && <button type="button" className="project-library-clear" onClick={clearSearch}>Clear search</button>}
        </div>
      </div>
      <label className="project-library-sort" htmlFor={`${ids}-sort`}><span>Sort projects</span>
        <select id={`${ids}-sort`} value={view.sort} onChange={(event) => onViewChange({ ...view, sort: event.target.value as ProjectLibrarySort, page: 1 })}>
          <option value="updated">Last edited</option><option value="created">Newest created</option><option value="title">Name A–Z</option>
        </select>
      </label>
    </div>

    {loading && <div className="project-library-empty" role="status"><LoaderCircle className="spin" size={22} aria-hidden="true"/><h2>Loading projects…</h2><p>Your saved projects will appear here.</p></div>}
    {!loading && loadFailed && <div className="project-library-empty" role="alert"><FolderOpen size={25} aria-hidden="true"/><h2>Could not load projects</h2><p>Your saved projects have not been changed. Try loading the list again.</p>
      <button ref={retry} type="button" onClick={() => { retryFocusPending.current = true; onRetry(); }}>Retry projects</button>
    </div>}

    {ready && <>
      <div className="project-library-summary">
        <h2 ref={resultHeading} tabIndex={-1} aria-live="polite" aria-atomic="true">{result.matches === result.total
          ? `${result.total} ${result.total === 1 ? 'project' : 'projects'}`
          : `${result.matches} of ${result.total} projects`}</h2>
        {result.matches > 0 && <span>Showing {result.start}–{result.end}</span>}
      </div>
      {result.total === 0 ? <div className="project-library-empty"><FolderOpen size={28} aria-hidden="true"/><h2>{storageUnavailable ? 'Project storage needs a check' : 'No projects yet'}</h2><p>{storageUnavailable ? 'Studio cannot confirm this is an empty saved library. Review storage; existing files are kept.' : 'Choose a video or audio file on Home to start your first project.'}</p><button type="button" onClick={storageUnavailable && onReviewStorage ? onReviewStorage : onBack}>{storageUnavailable && onReviewStorage ? 'Review storage' : 'Create a project'}</button></div>
        : result.matches === 0 ? <div className="project-library-empty"><Search size={26} aria-hidden="true"/><h2>No projects match your search</h2><p>Try another project name, or clear your search to see all projects.</p><button type="button" onClick={clearSearch}>Show all projects</button></div>
        : <ul className="project-library-results" aria-label="Project results">{result.items.map((project, index) => {
          const opening = openingProjectId === project.id;
          const descriptionId = `${ids}-project-${index}`;
          return <li key={project.id}>
            <button type="button" className="project-library-item" aria-label={`Open ${project.title}`} aria-describedby={descriptionId}
              aria-busy={opening} disabled={disabled || opening} onClick={() => onOpen(project.id)}>
              <span className="project-library-item-icon"><FolderOpen size={21} aria-hidden="true"/></span>
              <span className="project-library-item-content"><strong className="project-library-item-title" title={project.title}>{project.title}</strong>
                <span className="project-library-item-meta" id={descriptionId}>
                  <span>{project.captionCount ? `${project.captionCount} ${project.captionCount === 1 ? 'caption' : 'captions'}` : 'Not generated yet'}</span>
                  <ProjectDate label="Edited" value={project.updatedAt}/><ProjectDate label="Created" value={project.createdAt}/>
                </span>
              </span>
              <span className="project-library-open">{opening ? <><LoaderCircle className="spin" size={16} aria-hidden="true"/>Opening…</> : <>{project.captionCount ? 'Continue editing' : 'Open project'}<ArrowUpRight size={16} aria-hidden="true"/></>}</span>
            </button>
          </li>;
        })}</ul>}
      {result.pages > 1 && <nav className="project-library-pagination" aria-label="Project pages">
        <button type="button" disabled={result.page === 1} onClick={() => changePage(result.page - 1)}><ChevronLeft size={16} aria-hidden="true"/>Previous page</button>
        <span aria-live="polite">Page {result.page} of {result.pages}</span>
        <button type="button" disabled={result.page === result.pages} onClick={() => changePage(result.page + 1)}>Next page<ChevronRight size={16} aria-hidden="true"/></button>
      </nav>}
    </>}
  </section>;
}
