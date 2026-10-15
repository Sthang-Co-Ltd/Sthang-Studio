import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionSegment } from '@kcs/shared';
import { buildAssDocument } from '../apps/server/src/services/caption-renderer.js';

const captions: CaptionSegment[] = [
  { id: 'a', startMs: 103, endMs: 1007, text: 'ខ្មែរកម្ពុជា caption A' },
  { id: 'b', startMs: 1111, endMs: 2019, text: 'Second ខ្មែរ caption' },
  { id: 'c', startMs: 2133, endMs: 3017, text: 'បន្ទាត់ទី៣ CapCut' },
];

const appearance = {
  ...DEFAULT_CAPTION_APPEARANCE,
  motionPreset: 'fade' as const,
  motionDurationMs: 160,
  glowEnabled: true,
  glowColor: '#D7FF4F',
  glowWidth1080: 6,
  glowOpacity: 0.55,
  backgroundEnabled: true,
  backgroundColor: '#101010',
  backgroundOpacity: 0.58,
  backgroundPadding1080: 8,
};

test('plain Fade/Glow/Box segments each Khmer cue once instead of once per paint state and layer', () => {
  const OriginalSegmenter = Intl.Segmenter;
  let segmentCalls = 0;
  class CountingSegmenter extends OriginalSegmenter {
    segment(input: string) {
      segmentCalls += 1;
      return super.segment(input);
    }
  }
  Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: CountingSegmenter });
  try {
    const plain = captions;
    const document = buildAssDocument(plain, appearance, 1920, 1080);
    assert.equal(segmentCalls, plain.length * 2, 'word and grapheme segmentation must each run once per cue, not per paint state/layer');
    assert.equal((document.match(/^Dialogue:/gm) || []).length, 279);
  } finally {
    Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: OriginalSegmenter });
  }
});
