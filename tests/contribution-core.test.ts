import assert from 'node:assert/strict';
import test from 'node:test';
import type { CaptionProject, CaptionSegment, CorrectionEvent } from '../packages/shared/src/index.ts';
import { approvedContributionCandidates, resolveCorrectionLineage } from '../apps/server/src/services/contribution-core.ts';

const project: CaptionProject = {
  id: 'p1',
  title: 'private title',
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
  media: { filename: 'private.mp4', originalName: 'private.mp4', mimeType: 'video/mp4', size: 123, url: '/media/private.mp4' },
  transcript: { language: 'km', fullText: '', textModel: 'model-a', segments: [] },
  captions: [],
  mode: 'dynamic',
  engineVersion: '0.8.0',
};

function correction(overrides: Partial<CorrectionEvent>): CorrectionEvent {
  return {
    id: 'e1',
    projectId: 'p1',
    projectTitle: 'private title',
    captionId: 'c1',
    startMs: 1000,
    endMs: 2400,
    originalText: 'ខុស',
    correctedText: 'ត្រូវ',
    suggestionKind: 'review',
    suggestedVocabularyLine: 'ត្រូវ',
    status: 'pending',
    createdAt: '2026-08-31T10:00:00.000Z',
    sourceTimingSource: 'stt',
    sourceTextModel: 'model-a',
    sourceEngineVersion: '0.8.0',
    ...overrides,
  };
}

const before: CaptionSegment[] = [{ id: 'c1', startMs: 1000, endMs: 2400, text: 'ត្រូវណាស់', timingSource: 'stt', approved: false }];
const after: CaptionSegment[] = [{ ...before[0], approved: true }];

test('correction lineage reaches the earliest machine wording across incremental edits', () => {
  const events = [
    correction({ id: 'e1', originalText: 'ខុស', correctedText: 'ត្រូវ', createdAt: '2026-08-31T10:00:00.000Z' }),
    correction({ id: 'e2', originalText: 'ត្រូវ', correctedText: 'ត្រូវណាស់', createdAt: '2026-08-31T10:01:00.000Z' }),
  ];
  const lineage = resolveCorrectionLineage(events, 'p1', 'c1', 'ត្រូវណាស់');
  assert.ok(lineage);
  assert.equal(lineage.originalText, 'ខុស');
  assert.equal(lineage.correctedText, 'ត្រូវណាស់');
  assert.deepEqual(lineage.events.map((event) => event.id), ['e1', 'e2']);
});

test('approval creates one stable candidate only for post-consent generated-caption corrections', () => {
  const events = [
    correction({ id: 'e1', originalText: 'ខុស', correctedText: 'ត្រូវ', createdAt: '2026-08-31T10:00:00.000Z' }),
    correction({ id: 'e2', originalText: 'ត្រូវ', correctedText: 'ត្រូវណាស់', createdAt: '2026-08-31T10:01:00.000Z' }),
  ];
  const input = {
    project,
    before,
    after,
    correctionEvents: events,
    consentGrantedAt: '2026-08-31T09:59:00.000Z',
    mediaFingerprint: 'media-fingerprint',
  };
  const first = approvedContributionCandidates(input);
  const second = approvedContributionCandidates(input);
  assert.equal(first.length, 1);
  assert.equal(first[0].originalText, 'ខុស');
  assert.equal(first[0].correctedText, 'ត្រូវណាស់');
  assert.deepEqual(first[0].correctionEventIds, ['e1', 'e2']);
  assert.equal(first[0].id, second[0].id);
});

test('pre-consent, formatting-only, and manually-authored corrections are excluded', () => {
  const base = {
    project,
    before,
    after,
    consentGrantedAt: '2026-08-31T10:30:00.000Z',
    mediaFingerprint: 'media-fingerprint',
  };
  assert.equal(approvedContributionCandidates({ ...base, correctionEvents: [correction({ createdAt: '2026-08-31T10:00:00.000Z' })] }).length, 0);
  assert.equal(approvedContributionCandidates({ ...base, consentGrantedAt: '2026-08-31T09:00:00.000Z', correctionEvents: [correction({ suggestionKind: 'formatting' })] }).length, 0);
  assert.equal(approvedContributionCandidates({ ...base, consentGrantedAt: '2026-08-31T09:00:00.000Z', correctionEvents: [correction({ sourceTimingSource: 'manual' })] }).length, 0);
});
