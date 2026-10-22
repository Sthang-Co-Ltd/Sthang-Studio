import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPTION_APPEARANCE, exportContentBasis, type CaptionProject } from '@kcs/shared';
import { appearanceComparisonBasis, reconcileCaptionAppearance } from '../apps/web/src/caption-appearance-reconciliation.js';

function project(): CaptionProject {
  return { id: 'appearance-reconciliation', title: 'Synthetic', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    mode: 'phrase', media: { filename: 'source.mp4', originalName: 'source.mp4', size: 100, mimeType: 'video/mp4', url: '/media/source.mp4' },
    captions: [{ id: 'one', text: 'ខ្មែរ caption', startMs: 0, endMs: 1000 }], captionAppearance: { ...DEFAULT_CAPTION_APPEARANCE } };
}

test('reconciliation flushes debounce, waits the complete lane and reads only then', async () => {
  const source = project();
  const fresh = structuredClone(source);
  fresh.captionAppearance!.fontSize1080 = 90;
  fresh.captions[0].text = 'Foreign saved caption must not replace the draft';
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = reconcileCaptionAppearance(source, {
    flush: async () => { calls.push('flush'); await gate; return true; },
    wait: async () => { calls.push('wait'); return true; },
    load: async () => { calls.push('get'); return fresh; },
  });
  assert.deepEqual(calls, ['flush']); release();
  const result = await pending;
  assert.deepEqual(calls, ['flush', 'wait', 'get']);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.appearance.fontSize1080, 90);
  assert.equal(source.captions[0].text, 'ខ្មែរ caption');
  assert.equal(source.captionAppearance!.fontSize1080, DEFAULT_CAPTION_APPEARANCE.fontSize1080);
  assert.equal('captions' in result, false);
});

test('failed flush or lane cannot certify old saved appearance', async () => {
  for (const stage of ['flush', 'wait'] as const) {
    let reads = 0;
    const result = await reconcileCaptionAppearance(project(), {
      flush: async () => stage !== 'flush', wait: async () => stage !== 'wait',
      load: async () => { reads += 1; return project(); },
    });
    assert.deepEqual(result, { status: 'error', error: 'save' });
    assert.equal(reads, 0);
  }
});

test('failed reads and changed project/media responses remain explicitly unknown', async () => {
  const source = project();
  const options = { wait: async () => true };
  assert.deepEqual(await reconcileCaptionAppearance(source, { ...options, load: async () => { throw new Error('synthetic'); } }), { status: 'error', error: 'load' });
  for (const change of [
    (value: CaptionProject) => { value.id = 'another-project'; },
    (value: CaptionProject) => { value.media.filename = 'replacement.mp4'; },
    (value: CaptionProject) => { value.media.size += 1; },
    (value: CaptionProject) => { value.media.mimeType = 'audio/wav'; },
    (value: CaptionProject) => { value.media.url = '/media/replaced.mp4'; },
  ]) {
    const fresh = structuredClone(source); change(fresh);
    assert.deepEqual(await reconcileCaptionAppearance(source, { ...options, load: async () => fresh }), { status: 'error', error: 'source' });
  }
});

test('pending and failed appearance suppress styled/data/bundle comparisons, preserving plain output and unsaved captions', () => {
  const source = project();
  source.captions[0].text = 'Unsaved ខ្មែរ wording';
  for (const result of [{ status: 'pending' }, { status: 'error', error: 'save' }] as const) {
    for (const format of ['video', 'ass', 'data', 'bundle'] as const) assert.equal(appearanceComparisonBasis(source, format, result), null);
    for (const format of ['srt', 'vtt', 'ttml'] as const) assert.equal(appearanceComparisonBasis(source, format, result), exportContentBasis(source, format));
  }
  const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 90 };
  const result = { status: 'ready', appearance } as const;
  assert.equal(appearanceComparisonBasis(source, 'video', result), exportContentBasis({ ...source, captionAppearance: appearance }, 'video'));
  assert.notEqual(appearanceComparisonBasis(source, 'video', result), exportContentBasis(source, 'video'));
  assert.equal(source.captionAppearance!.fontSize1080, DEFAULT_CAPTION_APPEARANCE.fontSize1080);
  assert.equal(source.captions[0].text, 'Unsaved ខ្មែរ wording');
});
