import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionProject, type CaptionSegment } from '@kcs/shared';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-profile-concurrency-test-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
const { config } = await import('../apps/server/src/config.js');
const { profileStore } = await import('../apps/server/src/services/profile-store.js');

after(() => fs.rm(root, { recursive: true, force: true }));

function dummyProject(id: string): CaptionProject {
  return {
    id,
    title: `Project ${id}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, size: 1000, mimeType: 'video/mp4', url: `/media/${id}.mp4` },
    mode: 'phrase',
    transcript: null,
    captionAppearance: { ...DEFAULT_CAPTION_APPEARANCE },
    captions: [],
  };
}

test('concurrent preference patch and recordCaptionChanges persist both updates', async () => {
  const project = dummyProject('p1');
  const before: CaptionSegment[] = [
    { id: 'c1', startMs: 0, endMs: 1000, text: 'កម្ពុជា' },
  ];
  const afterSegments: CaptionSegment[] = [
    { id: 'c1', startMs: 0, endMs: 1000, text: 'កម្ពុជា CapCut' },
  ];

  const patchPromise = profileStore.patch({
    preferences: { reviewPreRollMs: 999, autoLoopReview: false },
  });
  const recordPromise = profileStore.recordCaptionChanges(project, before, afterSegments);

  const [patchResult, recordResult] = await Promise.all([patchPromise, recordPromise]);
  const finalProfile = await profileStore.get();

  assert.equal(finalProfile.preferences.reviewPreRollMs, 999);
  assert.equal(finalProfile.preferences.autoLoopReview, false);
  assert.equal(finalProfile.correctionEvents.length, 1);
  assert.equal(finalProfile.correctionEvents[0].originalText, 'កម្ពុជា');
  assert.equal(finalProfile.correctionEvents[0].correctedText, 'កម្ពុជា CapCut');
});

test('concurrent preset patch and recordCaptionChanges persist both updates', async () => {
  const project = dummyProject('p2');
  const before: CaptionSegment[] = [
    { id: 'c2', startMs: 500, endMs: 1500, text: 'ខ្មែរ' },
  ];
  const afterSegments: CaptionSegment[] = [
    { id: 'c2', startMs: 500, endMs: 1500, text: 'ខ្មែរ Khmer' },
  ];

  const preset = {
    id: 'preset-1',
    name: 'Custom Look',
    appearance: { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 88, textColor: '#00FF00' },
  };

  const presetPromise = profileStore.patch({ captionAppearances: [preset] });
  const recordPromise = profileStore.recordCaptionChanges(project, before, afterSegments);

  await Promise.all([presetPromise, recordPromise]);
  const finalProfile = await profileStore.get();

  assert.equal(finalProfile.captionAppearances.length, 1);
  assert.equal(finalProfile.captionAppearances[0].name, 'Custom Look');
  assert.equal(finalProfile.captionAppearances[0].appearance.fontSize1080, 88);
  assert.equal(finalProfile.captionAppearances[0].appearance.textColor, '#00FF00');
  assert.ok(finalProfile.correctionEvents.some((e) => e.correctedText === 'ខ្មែរ Khmer'));
});

test('overlapping recordCaptionChanges from separate projects do not drop events', async () => {
  const projectA = dummyProject('pA');
  const projectB = dummyProject('pB');

  const beforeA: CaptionSegment[] = [{ id: 'a1', startMs: 0, endMs: 500, text: 'មួយ' }];
  const afterA: CaptionSegment[] = [{ id: 'a1', startMs: 0, endMs: 500, text: 'មួយ 1' }];

  const beforeB: CaptionSegment[] = [{ id: 'b1', startMs: 0, endMs: 500, text: 'ពីរ' }];
  const afterB: CaptionSegment[] = [{ id: 'b1', startMs: 0, endMs: 500, text: 'ពីរ 2' }];

  await Promise.all([
    profileStore.recordCaptionChanges(projectA, beforeA, afterA),
    profileStore.recordCaptionChanges(projectB, beforeB, afterB),
  ]);

  const finalProfile = await profileStore.get();
  assert.ok(finalProfile.correctionEvents.some((e) => e.projectId === 'pA' && e.correctedText === 'មួយ 1'));
  assert.ok(finalProfile.correctionEvents.some((e) => e.projectId === 'pB' && e.correctedText === 'ពីរ 2'));
});

test('sequential patches preserve the last write win for same field', async () => {
  await profileStore.patch({ preferences: { autosaveDelayMs: 3000 } });
  let current = await profileStore.get();
  assert.equal(current.preferences.autosaveDelayMs, 3000);

  await profileStore.patch({ preferences: { autosaveDelayMs: 4500 } });
  current = await profileStore.get();
  assert.equal(current.preferences.autosaveDelayMs, 4500);
});

test('caller mutation of arguments after dispatch does not corrupt internal profile', async () => {
  const patchPayload = {
    defaultVocabulary: ['Initial Word'],
    preferences: { reviewPreRollMs: 500 },
  };

  const promise = profileStore.patch(patchPayload);
  patchPayload.defaultVocabulary.push('Corrupted Word');
  patchPayload.preferences.reviewPreRollMs = 9999;

  await promise;
  const current = await profileStore.get();

  assert.deepEqual(current.defaultVocabulary, ['Initial Word']);
  assert.equal(current.preferences.reviewPreRollMs, 500);
});

test('mutation of returned profile does not affect subsequent store reads', async () => {
  const profile = await profileStore.get();
  profile.defaultVocabulary.push('Hacked Word');
  profile.preferences.reviewPreRollMs = 7777;

  const fresh = await profileStore.get();
  assert.ok(!fresh.defaultVocabulary.includes('Hacked Word'));
  assert.notEqual(fresh.preferences.reviewPreRollMs, 7777);
});

test('preset appearance is normalized according to shared constraints', async () => {
  const updated = await profileStore.patch({
    captionAppearances: [
      {
        id: 'clamped',
        name: 'Clamped Look',
        appearance: {
          fontFamily: '  Custom Font  ',
          fontSize1080: 9999,
          textColor: 'not-a-color',
          backgroundOpacity: 5,
        },
      },
    ],
  });

  const preset = updated.captionAppearances[0];
  assert.equal(preset.appearance.fontFamily, 'Custom Font');
  assert.equal(preset.appearance.fontSize1080, 120);
  assert.equal(preset.appearance.textColor, DEFAULT_CAPTION_APPEARANCE.textColor);
  assert.equal(preset.appearance.backgroundOpacity, 1);
});

test('failed write followed by successful write does not deadlock or poison queue', async () => {
  // Trigger a rejected mutation by acting on a non-existent correction event
  await assert.rejects(
    profileStore.actOnCorrection('non-existent-correction-id', 'remember-global'),
    /Correction event not found/,
  );

  // Subsequent mutation must succeed immediately without deadlocking or failing
  const recovered = await profileStore.patch({
    preferences: { reviewPreRollMs: 720 },
  });
  assert.equal(recovered.preferences.reviewPreRollMs, 720);

  const current = await profileStore.get();
  assert.equal(current.preferences.reviewPreRollMs, 720);
});

test('conflicting same-field updates in reverse ordering deterministically honor execution order', async () => {
  const op1 = profileStore.patch({ preferences: { waveformZoom: 3 } });
  const op2 = profileStore.patch({ preferences: { waveformZoom: 5 } });
  await Promise.all([op1, op2]);

  let current = await profileStore.get();
  assert.equal(current.preferences.waveformZoom, 5);

  const op3 = profileStore.patch({ preferences: { waveformZoom: 5 } });
  const op4 = profileStore.patch({ preferences: { waveformZoom: 3 } });
  await Promise.all([op3, op4]);

  current = await profileStore.get();
  assert.equal(current.preferences.waveformZoom, 3);
});

test('replace semantics reset installation-specific consent while preserving upgrade notice version', async () => {
  // First set up local machine consent and an upgrade notice marker
  await profileStore.patch({
    preferences: {
      analyticsConsent: 'granted',
      khmerContributionConsent: 'granted',
      privacyUpgradeNoticeVersion: 'v0.8.0',
    },
  });

  const importedProfile = {
    version: 1,
    defaultVocabulary: ['Imported Term'],
    styles: [],
    captionAppearances: [],
    topicPacks: [],
    correctionRules: [],
    correctionEvents: [],
    preferences: {
      analyticsConsent: 'granted', // foreign machine was granted
      khmerContributionConsent: 'granted',
      privacyUpgradeNoticeVersion: 'foreign-machine-marker',
      reviewPreRollMs: 250,
    },
  };

  const result = await profileStore.replace(importedProfile);
  // Machine-specific consent must be reset to unset on import
  assert.equal(result.preferences.analyticsConsent, 'unset');
  assert.equal(result.preferences.khmerContributionConsent, 'unset');
  // Local machine upgrade notice version must be preserved, not overwritten
  assert.equal(result.preferences.privacyUpgradeNoticeVersion, 'v0.8.0');
  assert.deepEqual(result.defaultVocabulary, ['Imported Term']);
});

test('privacy consent choices survive concurrent unrelated profile mutations without resetting to unset', async () => {
  // Set explicit consent
  await profileStore.patch({
    preferences: {
      analyticsConsent: 'declined',
      khmerContributionConsent: 'granted',
    },
  });

  // Launch concurrent unrelated mutations
  const p1 = profileStore.patch({ defaultVocabulary: ['Word1', 'Word2'] });
  const p2 = profileStore.patch({ preferences: { autosaveDelayMs: 4000 } });
  const p3 = profileStore.patch({ topicPacks: [{ id: 'tp1', name: 'Topic 1', description: '', vocabulary: ['V1'] }] });

  await Promise.all([p1, p2, p3]);

  const finalProfile = await profileStore.get();
  assert.equal(finalProfile.preferences.analyticsConsent, 'declined');
  assert.equal(finalProfile.preferences.khmerContributionConsent, 'granted');
  assert.equal(finalProfile.preferences.autosaveDelayMs, 4000);
  assert.ok(finalProfile.defaultVocabulary.includes('Word1'));
  assert.equal(finalProfile.topicPacks.length, 1);
});

test('preset deletion persists without resurrecting removed items in subsequent concurrent patches', async () => {
  // Add two presets
  await profileStore.patch({
    captionAppearances: [
      { id: 'keep-me', name: 'Keep', appearance: DEFAULT_CAPTION_APPEARANCE },
      { id: 'delete-me', name: 'Delete', appearance: DEFAULT_CAPTION_APPEARANCE },
    ],
  });

  // Concurrent operations: one deletes 'delete-me' and keeps 'keep-me', another updates preferences
  const deleteOp = profileStore.patch({
    captionAppearances: [{ id: 'keep-me', name: 'Keep', appearance: DEFAULT_CAPTION_APPEARANCE }],
  });
  const prefOp = profileStore.patch({
    preferences: { waveformMode: 'spectrum' },
  });

  await Promise.all([deleteOp, prefOp]);

  const finalProfile = await profileStore.get();
  assert.equal(finalProfile.captionAppearances.length, 1);
  assert.equal(finalProfile.captionAppearances[0].id, 'keep-me');
  assert.equal(finalProfile.preferences.waveformMode, 'spectrum');
});
