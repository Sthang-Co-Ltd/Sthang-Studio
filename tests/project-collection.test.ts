import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionProjectSummary } from '@kcs/shared';
import { captureProjectCollectionBasis, reconcileProjectCollection } from '../apps/web/src/project-collection.js';

function project(id: string, change: Partial<CaptionProjectSummary> = {}): CaptionProjectSummary {
  return { id, title: id, captionCount: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...change };
}
const ids = (items: readonly CaptionProjectSummary[]) => items.map((item) => item.id);

test('a collection read adopts remote additions, updates, removal and server recent order', () => {
  const current = [project('old'), project('removed')];
  const incoming = [project('added'), project('old', { captionCount: 8, updatedAt: '2026-01-02T00:00:00Z' })];
  const result = reconcileProjectCollection(current, incoming, captureProjectCollectionBasis(current));
  assert.deepEqual(ids(result), ['added', 'old']);
  assert.equal(result[1], incoming[1]);
});

test('newer local publication wins over a delayed read even with an identical saved timestamp', () => {
  const original = project('edited');
  const basis = captureProjectCollectionBasis([original]);
  const newer = { ...original, captionCount: 9 };
  const result = reconcileProjectCollection([newer], [original], basis);
  assert.deepEqual(result, [newer]);
  assert.equal(result[0], newer);
});

test('new local projects and locally reopened projects survive a read captured before publication', () => {
  const existing = project('existing');
  const removed = project('removed');
  const basis = captureProjectCollectionBasis([existing, removed]);
  const reopened = { ...removed };
  const created = project('new-local');
  const result = reconcileProjectCollection([created, reopened, existing], [project('remote'), existing], basis);
  assert.deepEqual(ids(result), ['new-local', 'removed', 'remote', 'existing']);
  assert.equal(result[1], reopened);
});

test('capturing the next read allows confirmed remote changes to supersede earlier local metadata', () => {
  const local = project('same', { captionCount: 3 });
  const incoming = project('same', { captionCount: 4 });
  assert.deepEqual(reconcileProjectCollection([local], [incoming], captureProjectCollectionBasis([local])), [incoming]);
});

test('a captured read basis stays independent of later array reordering and deduplicates identities', () => {
  const a = Object.freeze(project('a'));
  const b = Object.freeze(project('b'));
  const current = Object.freeze([a, b]);
  const basis = captureProjectCollectionBasis(current);
  const incoming = Object.freeze([b, b, a]);
  assert.deepEqual(ids(reconcileProjectCollection(current, incoming, basis)), ['b', 'a']);
  assert.deepEqual(ids(current), ['a', 'b']);
  assert.equal(basis.get('a'), a);
});

test('an empty authoritative result removes only metadata unchanged since capture', () => {
  const a = project('a');
  const b = project('b');
  const basis = captureProjectCollectionBasis([a, b]);
  const newer = { ...b };
  assert.deepEqual(reconcileProjectCollection([a, newer], [], basis), [newer]);
});
