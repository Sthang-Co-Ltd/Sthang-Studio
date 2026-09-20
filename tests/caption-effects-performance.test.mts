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

test('plain Fade/Glow/Box wraps each cue once instead of once per paint state and layer', () => {
  const OriginalSegmenter = Intl.Segmenter;
  let segmentCalls = 0;
  class CountingAsciiSegmenter {
    segment(input: string) {
      segmentCalls += 1;
      return Array.from(input, (segment) => ({ segment }));
    }
  }
  Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: CountingAsciiSegmenter });
  try {
    const plain = captions.map((caption, index) => ({ ...caption, text: `Caption ${index}` }));
    const document = buildAssDocument(plain, appearance, 1920, 1080);
    assert.equal(segmentCalls, plain.length, 'plain text should wrap once per rendered cue, not once per fade state/layer');
    assert.equal((document.match(/^Dialogue:/gm) || []).length, 279);
  } finally {
    Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: OriginalSegmenter });
  }
});
