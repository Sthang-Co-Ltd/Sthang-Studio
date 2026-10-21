import type { CaptionProjectSummary } from '@kcs/shared';

export type ProjectLibrarySort = 'updated' | 'created' | 'title';
export interface ProjectLibraryView {
  query: string;
  sort: ProjectLibrarySort;
  page: number;
}

export const PROJECT_LIBRARY_PAGE_SIZE = 24;
export const DEFAULT_PROJECT_LIBRARY_VIEW: ProjectLibraryView = { query: '', sort: 'updated', page: 1 };

// Explicit locales keep title ordering independent of the computer's UI language.
const titleOrder = new Intl.Collator(['km', 'en'], { numeric: true, sensitivity: 'base' });

export function normalizeProjectSearch(value: string): string {
  return value.normalize('NFC').toLowerCase().trim();
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareNewest(a: string, b: string): number {
  const first = timestamp(a);
  const second = timestamp(b);
  return first === second ? 0 : first > second ? -1 : 1;
}

function compareIdentity(a: CaptionProjectSummary, b: CaptionProjectSummary): number {
  return titleOrder.compare(a.title, b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function selectProjectLibrary(projects: readonly CaptionProjectSummary[], view: ProjectLibraryView) {
  const query = normalizeProjectSearch(view.query);
  const matches = projects.filter((project) => !query || normalizeProjectSearch(project.title).includes(query));
  matches.sort((a, b) => {
    if (view.sort === 'title') return compareIdentity(a, b);
    const field = view.sort === 'created' ? 'createdAt' : 'updatedAt';
    return compareNewest(a[field], b[field]) || compareIdentity(a, b);
  });
  const pages = Math.max(1, Math.ceil(matches.length / PROJECT_LIBRARY_PAGE_SIZE));
  const requestedPage = Number.isFinite(view.page) ? Math.trunc(view.page) : 1;
  const page = Math.max(1, Math.min(pages, requestedPage));
  const offset = (page - 1) * PROJECT_LIBRARY_PAGE_SIZE;
  return {
    items: matches.slice(offset, offset + PROJECT_LIBRARY_PAGE_SIZE),
    total: projects.length,
    matches: matches.length,
    page,
    pages,
    start: matches.length ? offset + 1 : 0,
    end: Math.min(offset + PROJECT_LIBRARY_PAGE_SIZE, matches.length),
  };
}
