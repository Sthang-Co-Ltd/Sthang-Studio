import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionProjectSummary } from '@kcs/shared';
import { DEFAULT_PROJECT_LIBRARY_VIEW, PROJECT_LIBRARY_PAGE_SIZE, selectProjectLibrary } from '../apps/web/src/project-library.js';

function project(id: string, title = id, dates: Partial<CaptionProjectSummary> = {}): CaptionProjectSummary {
  return { id, title, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', captionCount: 3, ...dates };
}
const view = (change = {}) => ({ ...DEFAULT_PROJECT_LIBRARY_VIEW, ...change });
const ids = (items: CaptionProjectSummary[]) => items.map((item) => item.id);

test('search reaches a project beyond both the six recent cards and the first result page', () => {
  const projects = Array.from({ length: 65 }, (_, i) => project(String(i), `Project ${i}`));
  projects[64] = project('old-khmer', 'ការងារខ្មែរ ចាស់');
  const result = selectProjectLibrary(projects, view({ query: 'ខ្មែរ' }));
  assert.deepEqual(ids(result.items), ['old-khmer']);
  assert.equal(result.total, 65);
  assert.equal(result.matches, 1);
  assert.equal(result.pages, 1);
});

test('search is case-insensitive, trimmed, Unicode-normalized and literal', () => {
  const projects = [project('literal', 'Café KHMER [draft].*'), project('other', 'Cafe Khmer draft')];
  assert.deepEqual(ids(selectProjectLibrary(projects, view({ query: '  CAFE\u0301 khmer  ' })).items), ['literal']);
  assert.deepEqual(ids(selectProjectLibrary(projects, view({ query: '[draft].*' })).items), ['literal']);
  assert.equal(selectProjectLibrary(projects, view({ query: 'missing' })).matches, 0);
  assert.equal(selectProjectLibrary(projects, view({ query: '  \n\t ' })).matches, 2);
});

test('last-edited and newest-created orders use their own dates', () => {
  const projects = [
    project('edited', 'Edited first', { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' }),
    project('created', 'Created first', { createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' }),
  ];
  assert.deepEqual(ids(selectProjectLibrary(projects, view()).items), ['edited', 'created']);
  assert.deepEqual(ids(selectProjectLibrary(projects, view({ sort: 'created' })).items), ['created', 'edited']);
});

test('date ordering compares instants and puts malformed legacy dates last', () => {
  const projects = [
    project('late', 'Late', { updatedAt: '2026-02-01T00:00:00Z' }),
    project('offset', 'Offset', { updatedAt: '2026-02-01T06:00:00+07:00' }),
    project('invalid', 'Invalid', { updatedAt: 'not-a-date' }),
    project('empty', 'Empty', { updatedAt: '' }),
  ];
  assert.deepEqual(ids(selectProjectLibrary(projects, view()).items), ['late', 'offset', 'empty', 'invalid']);
});

test('name ordering is natural and equal names have a stable identity tie-break', () => {
  const projects = [project('ten', 'Clip 10'), project('b', 'Clip 2'), project('a', 'clip 2'), project('one', 'Clip 1')];
  const expected = ['one', 'a', 'b', 'ten'];
  assert.deepEqual(ids(selectProjectLibrary(projects, view({ sort: 'title' })).items), expected);
  assert.deepEqual(ids(selectProjectLibrary([...projects].reverse(), view({ sort: 'title' })).items), expected);
  assert.deepEqual(ids(selectProjectLibrary(projects, view()).items), expected);
});

test('all projects remain reachable across bounded pages without duplicates', () => {
  const projects = Array.from({ length: 65 }, (_, i) => project(String(i), `Clip ${i}`));
  const pages = [1, 2, 3].map((page) => selectProjectLibrary(projects, view({ sort: 'title', page })));
  assert.deepEqual(pages.map((page) => page.items.length), [PROJECT_LIBRARY_PAGE_SIZE, PROJECT_LIBRARY_PAGE_SIZE, 17]);
  assert.deepEqual(pages.map((page) => [page.start, page.end]), [[1, 24], [25, 48], [49, 65]]);
  assert.equal(new Set(pages.flatMap((page) => ids(page.items))).size, 65);
});

test('out-of-range pages clamp after a collection shrinks or a search narrows it', () => {
  const projects = Array.from({ length: 30 }, (_, i) => project(String(i), `Clip ${i}`));
  assert.equal(selectProjectLibrary(projects, view({ page: 100 })).page, 2);
  assert.equal(selectProjectLibrary(projects, view({ page: -1 })).page, 1);
  assert.equal(selectProjectLibrary(projects, view({ page: 2.8 })).page, 2);
  assert.equal(selectProjectLibrary(projects, view({ page: Infinity })).page, 1);
  assert.equal(selectProjectLibrary(projects, view({ page: NaN })).page, 1);
  assert.equal(selectProjectLibrary(projects, view({ query: 'Clip 29', page: 2 })).page, 1);
});

test('empty and no-match collections have honest counts and a safe page', () => {
  for (const result of [selectProjectLibrary([], view()), selectProjectLibrary([project('one')], view({ query: 'absent' }))]) {
    assert.deepEqual(result.items, []);
    assert.equal(result.matches, 0);
    assert.equal(result.start, 0);
    assert.equal(result.end, 0);
    assert.equal(result.page, 1);
    assert.equal(result.pages, 1);
  }
});

test('searching and sorting do not mutate summaries, collection order or view state', () => {
  const projects = Object.freeze([Object.freeze(project('b')), Object.freeze(project('a'))]);
  const before = JSON.stringify(projects);
  const state = Object.freeze(view({ sort: 'title' }));
  selectProjectLibrary(projects, state);
  assert.equal(JSON.stringify(projects), before);
  assert.deepEqual(state, view({ sort: 'title' }));
});
