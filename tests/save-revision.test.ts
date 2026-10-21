import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionProject } from '@kcs/shared';
import { ApiRequestError } from '../apps/web/src/api.js';
import { checkedSaveRevision, editorAdoptedAccuracy, matchesVocabularyAddition } from '../apps/web/src/save-revision.js';
import { createAccuracyContextDraft } from '../apps/web/src/accuracy-context-draft.js';
import { createProjectScope, projectMediaKey } from '../apps/web/src/project-scope.js';

function project(): CaptionProject {
  return {
    id: 'synthetic-save-basis', title: 'Save basis', mode: 'phrase',
    createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
    media: { filename: 'synthetic.mp4', originalName: 'synthetic.mp4', mimeType: 'video/mp4', size: 123, url: '/media/synthetic.mp4' },
    captions: [{ id: 'c1', text: 'សួស្តី Khmer', startMs: 100, endMs: 1000, approved: false }],
    transcriptionContext: { description: 'Saved context', vocabulary: ['TS11'] },
    transcript: null, engineVersion: 'test',
  };
}

function conflict(operation: () => unknown, code: string) {
  assert.throws(operation, (error: unknown) => error instanceof ApiRequestError && error.status === 409 && error.code === code);
}

test('a fresh revision can advance after an unrelated field change without overwriting that field', () => {
  const basis = project();
  const contextChanged = structuredClone(basis);
  contextChanged.updatedAt = '2026-10-20T00:00:01.000Z';
  contextChanged.transcriptionContext!.description = 'Saved by another client';
  assert.equal(checkedSaveRevision(basis, contextChanged, 'captions'), contextChanged.updatedAt);
  conflict(() => checkedSaveRevision(basis, contextChanged, 'context'), 'CONTEXT_REVISION_CHANGED');

  const captionsChanged = structuredClone(basis);
  captionsChanged.updatedAt = '2026-10-20T00:00:02.000Z';
  captionsChanged.captions[0].text = 'Newer saved caption';
  assert.equal(checkedSaveRevision(basis, captionsChanged, 'context'), captionsChanged.updatedAt);
  conflict(() => checkedSaveRevision(basis, captionsChanged, 'captions'), 'CAPTION_REVISION_CHANGED');
});

test('caption conflicts include timing, approval and locks, even if a response repeats its timestamp', () => {
  const basis = project();
  for (const patch of [{ text: 'changed' }, { startMs: 200 }, { endMs: 2000 }, { approved: true }, { textLocked: true }, { timingLocked: true }]) {
    const latest = structuredClone(basis);
    Object.assign(latest.captions[0], patch);
    conflict(() => checkedSaveRevision(basis, latest, 'captions'), 'CAPTION_REVISION_CHANGED');
  }
  const removed = structuredClone(basis);
  removed.captions = [];
  conflict(() => checkedSaveRevision(basis, removed, 'captions'), 'CAPTION_REVISION_CHANGED');
});

test('Accuracy compares both description and exact saved vocabulary', () => {
  const basis = project();
  const latest = structuredClone(basis);
  latest.transcriptionContext!.vocabulary = ['TS11 | terminal'];
  conflict(() => checkedSaveRevision(basis, latest, 'context'), 'CONTEXT_REVISION_CHANGED');
  assert.deepEqual(basis.transcriptionContext, { description: 'Saved context', vocabulary: ['TS11'] });
});

test('a different project or media cannot supply either save revision', () => {
  const basis = project();
  for (const latest of [
    { ...basis, id: 'other' },
    { ...basis, media: { ...basis.media, filename: 'replacement.mp4' } },
    { ...basis, media: { ...basis.media, size: 456 } },
  ]) for (const field of ['captions', 'context'] as const) {
    conflict(() => checkedSaveRevision(basis, latest, field), field === 'captions' ? 'CAPTION_REVISION_CHANGED' : 'CONTEXT_REVISION_CHANGED');
  }
  conflict(() => checkedSaveRevision(null, basis, 'captions'), 'CAPTION_REVISION_CHANGED');
});

test('caption hydration has the same meaning for a legacy basis and its server read', () => {
  const basis = project();
  basis.transcript = {
    language: 'en', fullText: 'hello', segments: basis.captions,
    tokens: [{ id: 't1', text: 'hello', startMs: 100, endMs: 1000, spaceBefore: false, timingSource: 'stt' }],
  };
  basis.captions[0].text = 'hello';
  const latest = structuredClone(basis);
  latest.updatedAt = '2026-10-20T00:00:03.000Z';
  assert.equal(checkedSaveRevision(basis, latest, 'captions'), latest.updatedAt);
  assert.equal(basis.captions[0].wordTiming, undefined, 'checking a revision must not modify its basis');
});

test('a foreign context read cannot own normalized-clean raw fields retained in the editor', () => {
  const basis = project();
  const scope = createProjectScope();
  scope.select(basis);
  const ticket = scope.capture();
  const draft = createAccuracyContextDraft();
  draft.reset(projectMediaKey(basis), basis.transcriptionContext);
  draft.edit({ description: 'Saved context ' });
  assert.equal(draft.hasChanges(), false);
  const foreign = { description: 'Foreign context', vocabulary: ['TS11'] };
  assert.equal(draft.publish(foreign, draft.capture(ticket), ticket), true);
  assert.equal(draft.fields.description, 'Saved context ');
  assert.equal(editorAdoptedAccuracy(draft.fields, foreign), false);
  assert.equal(editorAdoptedAccuracy(draft.fields, basis.transcriptionContext), true);
});

test('a correction term owns its exact addition without authorizing foreign context or terms', () => {
  const basis = project();
  const next = structuredClone(basis);
  next.transcriptionContext!.vocabulary.push('OpenAI | alias');
  assert.equal(matchesVocabularyAddition(basis, next, 'OpenAI | alias'), true);
  next.transcriptionContext!.description = 'Another editor changed this';
  assert.equal(matchesVocabularyAddition(basis, next, 'OpenAI | alias'), false);
  next.transcriptionContext!.description = basis.transcriptionContext!.description;
  next.transcriptionContext!.vocabulary.push('Another term');
  assert.equal(matchesVocabularyAddition(basis, next, 'OpenAI | alias'), false);
  assert.equal(matchesVocabularyAddition(basis, basis, 'ts11'), true, 'a duplicate term is an unchanged acknowledged context');
  assert.equal(matchesVocabularyAddition(basis, { ...next, id: 'other' }, 'OpenAI | alias'), false);
  assert.deepEqual(basis.transcriptionContext!.vocabulary, ['TS11']);
});
