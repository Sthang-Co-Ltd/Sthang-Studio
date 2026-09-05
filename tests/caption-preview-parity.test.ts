import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPTION_APPEARANCE } from '@kcs/shared';
import { planCaptionPreviewText } from '../apps/web/src/caption-appearance-preview.js';
import { buildAssDocument } from '../apps/server/src/services/video-export.js';

function assTextFor(text: string, width: number, height: number) {
  const appearance = {
    ...DEFAULT_CAPTION_APPEARANCE,
    fontFamily: 'Noto Sans Khmer',
    fontSize1080: 56,
    maxWidthPct: 82,
    positionBottomPct: 12,
  };
  const document = buildAssDocument([
    { id: 'preview-parity', startMs: 0, endMs: 2400, text },
  ], appearance, width, height);
  const dialogue = document.split('\n').find((line) => line.startsWith('Dialogue: '));
  assert.ok(dialogue, 'expected an ASS dialogue line');
  const marker = ',Default,,0,0,0,,';
  const markerIndex = dialogue.indexOf(marker);
  assert.ok(markerIndex >= 0, 'expected the standard ASS dialogue fields');
  return dialogue.slice(markerIndex + marker.length);
}

function previewAsAss(text: string, width: number, height: number) {
  const appearance = {
    ...DEFAULT_CAPTION_APPEARANCE,
    fontFamily: 'Noto Sans Khmer',
    fontSize1080: 56,
    maxWidthPct: 82,
    positionBottomPct: 12,
  };
  return planCaptionPreviewText(text, appearance, width, height).replace(/\r?\n/g, '\\N');
}

test('browser preview and ASS export plan identical Khmer line breaks', () => {
  const samples = [
    'កម្ពុជា CapCut',
    'ខ្មែរជាភាសារបស់យើងដែលត្រូវការការបង្ហាញច្បាស់លាស់ក្នុងវីដេអូខ្លីៗដោយមិនពឹងផ្អែកលើចន្លោះពាក្យ',
    'បន្ទាត់ទីមួយ\nSecond line ខ្មែរ',
  ];

  for (const sample of samples) {
    assert.equal(assTextFor(sample, 1920, 1080), previewAsAss(sample, 1920, 1080));
  }
});

test('same-aspect output resolution does not change the caption line plan', () => {
  const sample = 'ខ្មែរជាភាសារបស់យើងដែលត្រូវការការបង្ហាញច្បាស់លាស់ក្នុងវីដេអូខ្លីៗដោយមិនពឹងផ្អែកលើចន្លោះពាក្យ';
  assert.equal(previewAsAss(sample, 1920, 1080), previewAsAss(sample, 3840, 2160));
  assert.equal(assTextFor(sample, 1920, 1080), assTextFor(sample, 3840, 2160));
});
