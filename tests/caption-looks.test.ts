import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CAPTION_APPEARANCE,
  normalizeCaptionAppearance,
} from '../packages/shared/src/caption-settings.js';
import {
  CAPTION_LOOKS,
  applyCaptionLook,
  matchingCaptionLook,
} from '../packages/shared/src/caption-looks.js';

test('caption effect defaults keep old projects visually unchanged and normalize bounded values', () => {
  const oldProject = normalizeCaptionAppearance({
    fontFamily: 'Khmer UI',
    textColor: '#ffffff',
    outlineWidth1080: 3,
  });
  assert.equal(oldProject.glowEnabled, false);
  assert.equal(oldProject.glowColor, '#D7FF4F');
  assert.equal(oldProject.glowWidth1080, 6);
  assert.equal(oldProject.glowOpacity, 0.55);
  assert.equal(oldProject.motionPreset, 'none');
  assert.equal(oldProject.motionDurationMs, 160);

  const bounded = normalizeCaptionAppearance({
    glowEnabled: true,
    glowWidth1080: 99,
    glowOpacity: -5,
    motionPreset: 'fade',
    motionDurationMs: 257,
  });
  assert.equal(bounded.glowEnabled, true);
  assert.equal(bounded.glowWidth1080, 16);
  assert.equal(bounded.glowOpacity, 0);
  assert.equal(bounded.motionPreset, 'fade');
  assert.equal(bounded.motionDurationMs, 260);
  assert.equal(normalizeCaptionAppearance({ motionDurationMs: 1 }).motionDurationMs, 80);
  assert.equal(normalizeCaptionAppearance({ motionDurationMs: 999 }).motionDurationMs, 400);
});

test('six original Looks have stable ids and each applied recipe matches exactly', () => {
  assert.deepEqual(CAPTION_LOOKS.map((look) => look.id), [
    'clean',
    'bold-outline',
    'soft-shadow',
    'solid-box',
    'high-contrast',
    'soft-glow',
  ]);
  assert.equal(new Set(CAPTION_LOOKS.map((look) => look.label)).size, 6);
  for (const look of CAPTION_LOOKS) {
    const applied = applyCaptionLook(DEFAULT_CAPTION_APPEARANCE, look.id);
    assert.equal(matchingCaptionLook(applied), look.id);
  }
});

test('applying and resetting Looks changes decoration only', () => {
  const ownerState = normalizeCaptionAppearance({
    fontFamily: 'Noto Sans Khmer',
    fontSize1080: 74,
    bold: false,
    alignment: 'right',
    positionBottomPct: 24,
    maxWidthPct: 70,
    motionPreset: 'fade',
    motionDurationMs: 240,
    highlightMode: 'word',
    highlightColor: '#AABBCC',
  });
  const applied = applyCaptionLook(ownerState, 'soft-glow');
  for (const key of [
    'fontFamily', 'fontSize1080', 'bold', 'alignment', 'positionBottomPct', 'maxWidthPct',
    'motionPreset', 'motionDurationMs', 'highlightMode', 'highlightColor',
  ] as const) {
    assert.equal(applied[key], ownerState[key], `${key} should survive Look application`);
  }
  assert.equal(applied.glowEnabled, true);
  assert.equal(matchingCaptionLook(applied), 'soft-glow');

  const reset = applyCaptionLook(applied, null);
  for (const key of [
    'fontFamily', 'fontSize1080', 'bold', 'alignment', 'positionBottomPct', 'maxWidthPct',
    'motionPreset', 'motionDurationMs', 'highlightMode', 'highlightColor',
  ] as const) {
    assert.equal(reset[key], ownerState[key], `${key} should survive Look reset`);
  }
  for (const key of [
    'textColor', 'outlineColor', 'outlineWidth1080', 'shadowWidth1080',
    'backgroundEnabled', 'backgroundColor', 'backgroundOpacity', 'backgroundPadding1080',
    'glowEnabled', 'glowColor', 'glowWidth1080', 'glowOpacity',
  ] as const) {
    assert.equal(reset[key], DEFAULT_CAPTION_APPEARANCE[key], `${key} should reset to base decoration`);
  }
});

test('matching ignores creator-owned fields but returns null after a decoration tweak', () => {
  const applied = applyCaptionLook({
    fontFamily: 'Custom Khmer',
    bold: false,
    motionPreset: 'fade',
    motionDurationMs: 300,
  }, 'bold-outline');
  assert.equal(matchingCaptionLook({
    ...applied,
    fontFamily: 'Another Khmer Font',
    bold: true,
    motionPreset: 'none',
    highlightMode: 'word',
  }), 'bold-outline');
  assert.equal(matchingCaptionLook({ ...applied, outlineWidth1080: 5 }), null);
});
