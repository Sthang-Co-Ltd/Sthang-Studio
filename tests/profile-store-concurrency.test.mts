import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionProject, type CaptionSegment, type ProcessingJob, type VideoExportSettings } from '@kcs/shared';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-profile-concurrency-test-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
const { config } = await import('../apps/server/src/config.js');
const { profileStore, VideoExportPresetConflictError } = await import('../apps/server/src/services/profile-store.js');

after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

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

function videoSettings(change: Partial<VideoExportSettings> = {}): VideoExportSettings {
  return { resolution: 'source', frameRate: 'source', quality: 'recommended', codec: 'h264', encoder: 'auto', ...change };
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

test('profileStore.patch() returned updatedAt equals subsequent profileStore.get().updatedAt', async () => {
  const patched = await profileStore.patch({ preferences: { autosaveDelayMs: 2500 } });
  const read = await profileStore.get();
  assert.equal(patched.updatedAt, read.updatedAt);
  assert.equal(patched.preferences.autosaveDelayMs, 2500);
  assert.equal(read.preferences.autosaveDelayMs, 2500);
});

test('profileStore.replace() returned updatedAt equals persisted state', async () => {
  const current = await profileStore.get();
  const replaced = await profileStore.replace({
    ...current,
    defaultVocabulary: ['Vocabulary Replacement Test'],
  });
  const read = await profileStore.get();
  assert.equal(replaced.updatedAt, read.updatedAt);
  assert.deepEqual(replaced.defaultVocabulary, ['Vocabulary Replacement Test']);
  assert.deepEqual(read.defaultVocabulary, ['Vocabulary Replacement Test']);
});

test('recordCaptionChanges() returns the persisted saved profile when it creates corrections', async () => {
  const project = dummyProject('p-record-return');
  const before: CaptionSegment[] = [{ id: 'c-ret-1', startMs: 0, endMs: 500, text: 'អរគុណ' }];
  const after: CaptionSegment[] = [{ id: 'c-ret-1', startMs: 0, endMs: 500, text: 'អរគុណ Thanks' }];

  const result = await profileStore.recordCaptionChanges(project, before, after);
  const read = await profileStore.get();

  assert.equal(result.created.length, 1);
  assert.equal(result.profile.updatedAt, read.updatedAt);
  assert.ok(result.profile.correctionEvents.some((e) => e.captionId === 'c-ret-1'));
  assert.ok(read.correctionEvents.some((e) => e.captionId === 'c-ret-1'));
});

test('actOnCorrection() returns the persisted saved profile', async () => {
  const project = dummyProject('p-act-return');
  const before: CaptionSegment[] = [{ id: 'c-act-1', startMs: 0, endMs: 500, text: 'សួស្តី' }];
  const after: CaptionSegment[] = [{ id: 'c-act-1', startMs: 0, endMs: 500, text: 'សួស្តី Hello' }];

  const recordResult = await profileStore.recordCaptionChanges(project, before, after);
  const eventId = recordResult.created[0].id;

  const actResult = await profileStore.actOnCorrection(eventId, 'remember-global');
  const read = await profileStore.get();

  assert.equal(actResult.profile.updatedAt, read.updatedAt);
  assert.equal(actResult.event.id, eventId);
  assert.equal(actResult.event.status, 'remembered-global');
  assert.equal(read.correctionEvents.find((e) => e.id === eventId)?.status, 'remembered-global');
});

test('recordCaptionChanges() with no material correction does not alter the profile file bytes or updatedAt', async () => {
  const project = dummyProject('p-noop');
  const before: CaptionSegment[] = [{ id: 'c-noop-1', startMs: 0, endMs: 500, text: 'មិនផ្លាស់ប្តូរ' }];
  const after: CaptionSegment[] = [{ id: 'c-noop-1', startMs: 0, endMs: 500, text: 'មិនផ្លាស់ប្តូរ' }];

  const profileBefore = await profileStore.get();
  const fileBytesBefore = await fs.readFile(config.profileFile);

  const result = await profileStore.recordCaptionChanges(project, before, after);
  const profileAfter = await profileStore.get();
  const fileBytesAfter = await fs.readFile(config.profileFile);

  assert.equal(result.created.length, 0);
  assert.equal(result.profile.updatedAt, profileBefore.updatedAt);
  assert.equal(profileAfter.updatedAt, profileBefore.updatedAt);
  assert.deepEqual(fileBytesAfter, fileBytesBefore);
});

test('fresh profiles leave last-used export settings unset until an accepted render saves them', async () => {
  const fresh = await profileStore.get();
  assert.equal(fresh.lastVideoExportSettings, undefined);
  assert.deepEqual(fresh.videoExportPresets, []);
});

test('legacy version 1 profiles preserve an unset last-used field and existing user data', async () => {
  const previous = await profileStore.get();
  const { lastVideoExportSettings: _last, videoExportPresets: _presets, ...legacy } = previous;
  await fs.writeFile(config.profileFile, JSON.stringify(legacy, null, 2), 'utf8');

  const upgraded = await profileStore.get();
  assert.equal(upgraded.version, 1);
  assert.equal(upgraded.lastVideoExportSettings, undefined);
  assert.deepEqual(upgraded.videoExportPresets, []);
  assert.deepEqual(upgraded.defaultVocabulary, legacy.defaultVocabulary);
  assert.deepEqual(upgraded.correctionEvents, legacy.correctionEvents);

  const saved = await profileStore.patch({ preferences: { waveformZoom: 4 } });
  assert.equal(saved.lastVideoExportSettings, undefined);
  assert.deepEqual(saved.videoExportPresets, []);
  const onDisk = JSON.parse(await fs.readFile(config.profileFile, 'utf8'));
  assert.deepEqual(onDisk.videoExportPresets, []);
  assert.equal(Object.hasOwn(onDisk, 'lastVideoExportSettings'), false);
});

test('last-used export settings are normalized, stored at profile top level and survive unrelated patches', async () => {
  const saved = await profileStore.setLastVideoExportSettings({
    resolution: '2160p', frameRate: '60', quality: 'high', codec: 'hevc', encoder: 'nvidia',
    customBitrateMbps: '72.5', extra: 'never persist',
  });
  const expected = videoSettings({ resolution: '2160p', frameRate: 60, quality: 'high', codec: 'hevc', encoder: 'nvidia', customBitrateMbps: 72.5 });
  assert.deepEqual(saved.lastVideoExportSettings, expected);
  assert.deepEqual((await profileStore.get()).lastVideoExportSettings, expected);
  const disk = JSON.parse(await fs.readFile(config.profileFile, 'utf8'));
  assert.deepEqual(disk.lastVideoExportSettings, expected);
  assert.equal(disk.preferences.lastVideoExportSettings, undefined);

  await profileStore.patch({ preferences: { reviewPreRollMs: 480 } });
  assert.deepEqual((await profileStore.get()).lastVideoExportSettings, expected);
  await assert.rejects(profileStore.setLastVideoExportSettings(null), /valid video export settings/);
  assert.deepEqual((await profileStore.get()).lastVideoExportSettings, expected);
  const afterFailure = await profileStore.setLastVideoExportSettings({ resolution: 'bad', customBitrateMbps: 999 });
  assert.deepEqual(afterFailure.lastVideoExportSettings, videoSettings());
});

test('named export presets upsert by normalized name, preserve identity, rename by ID and delete atomically', async () => {
  await profileStore.replace({ ...await profileStore.get(), videoExportPresets: [] });
  const first = await profileStore.upsertVideoExportPreset({ name: '  My TikTok  ', settings: videoSettings({ quality: 'high' }) });
  assert.equal(first.videoExportPresets?.length, 1);
  const original = first.videoExportPresets![0];
  assert.equal(original.name, 'My TikTok');
  assert.match(original.id, /^[A-Za-z0-9_-]+$/);

  const replaced = await profileStore.upsertVideoExportPreset({ name: 'my tiktok', settings: videoSettings({ frameRate: 60 }) });
  assert.equal(replaced.videoExportPresets?.length, 1);
  assert.equal(replaced.videoExportPresets![0].id, original.id);
  assert.equal(replaced.videoExportPresets![0].createdAt, original.createdAt);
  assert.deepEqual(replaced.videoExportPresets![0].settings, videoSettings({ frameRate: 60 }));

  const renamed = await profileStore.upsertVideoExportPreset({ id: original.id, name: 'Portrait 60fps', settings: videoSettings({ frameRate: 60 }) });
  assert.equal(renamed.videoExportPresets![0].name, 'Portrait 60fps');
  const removed = await profileStore.deleteVideoExportPreset(original.id);
  assert.deepEqual(removed.videoExportPresets, []);
  assert.deepEqual((await profileStore.get()).videoExportPresets, []);
  assert.equal(removed.updatedAt, (await profileStore.get()).updatedAt);

  await assert.rejects(profileStore.deleteVideoExportPreset(original.id), /no longer exists/);
  await assert.rejects(profileStore.upsertVideoExportPreset({ id: original.id, name: 'Revived', settings: videoSettings() }), /no longer exists/);
  assert.deepEqual((await profileStore.get()).videoExportPresets, []);
});

test('import normalizes unknown export fields, malformed presets, duplicate names and IDs, and caps 20', async () => {
  const legacy = await profileStore.get();
  const entries = [
    { id: 'first', name: '  Portrait  ', settings: { resolution: '1080p', encoder: 'intel', customBitrateMbps: { toString: 'invalid' } }, createdAt: 'bad', updatedAt: 'bad' },
    { id: 'duplicate-name', name: 'PORTRAIT', settings: videoSettings({ quality: 'smaller' }) },
    { id: 'first', name: 'Duplicate ID', settings: videoSettings() },
    { id: 'blank', name: '  ', settings: videoSettings() },
    { id: 'missing-settings', name: 'Defaults' },
    ...Array.from({ length: 24 }, (_, i) => ({ id: `unique-${i}`, name: `Custom ${i}`, settings: videoSettings({ quality: 'high' }) })),
  ];
  const imported = await profileStore.replace({
    ...legacy,
    version: 1,
    lastVideoExportSettings: { resolution: 'broken', frameRate: { toString: 'invalid' }, customBitrateMbps: -2 },
    videoExportPresets: entries,
  });
  assert.deepEqual(imported.lastVideoExportSettings, videoSettings());
  assert.equal(imported.videoExportPresets?.length, 20);
  assert.equal(imported.videoExportPresets![0].name, 'Portrait');
  assert.deepEqual(imported.videoExportPresets![0].settings, videoSettings({ resolution: '1080p', encoder: 'intel' }));
  assert.deepEqual(imported.videoExportPresets![1].settings, videoSettings());
  assert.ok(Number.isFinite(Date.parse(imported.videoExportPresets![0].createdAt)));
  assert.equal(imported.videoExportPresets!.filter((preset) => preset.name.toLowerCase() === 'portrait').length, 1);
  assert.equal(new Set(imported.videoExportPresets!.map((preset) => preset.id)).size, 20);
  assert.deepEqual((await profileStore.get()).videoExportPresets, imported.videoExportPresets);
  assert.deepEqual((await profileStore.get()).lastVideoExportSettings, imported.lastVideoExportSettings);
});

test('a 21st distinct video export preset is rejected without deleting an existing preset or writing the profile', async () => {
  const seeded = await profileStore.replace({
    ...await profileStore.get(),
    videoExportPresets: Array.from({ length: 20 }, (_, index) => ({
      id: `capacity-${index}`,
      name: `Saved preset ${index}`,
      settings: videoSettings({ quality: 'high' }),
    })),
  });
  assert.equal(seeded.videoExportPresets?.length, 20);
  const bytesBefore = await fs.readFile(config.profileFile);

  await assert.rejects(
    profileStore.upsertVideoExportPreset({ name: 'Preset 21', settings: videoSettings() }),
    (error: unknown) => error instanceof VideoExportPresetConflictError
      && /20 video export presets/i.test(error.message)
      && /delete one/i.test(error.message),
  );
  assert.deepEqual(await fs.readFile(config.profileFile), bytesBefore);
  const afterRejected = await profileStore.get();
  assert.deepEqual(afterRejected.videoExportPresets, seeded.videoExportPresets);
  assert.equal(afterRejected.updatedAt, seeded.updatedAt);

  const byName = await profileStore.upsertVideoExportPreset({
    name: 'SAVED PRESET 19',
    settings: videoSettings({ frameRate: 60 }),
  });
  assert.equal(byName.videoExportPresets?.length, 20);
  assert.equal(byName.videoExportPresets?.[0].id, 'capacity-19');
  assert.deepEqual(byName.videoExportPresets?.[0].settings, videoSettings({ frameRate: 60 }));

  const byId = await profileStore.upsertVideoExportPreset({
    id: 'capacity-0', name: 'Renamed at capacity', settings: videoSettings({ resolution: '2160p' }),
  });
  assert.equal(byId.videoExportPresets?.length, 20);
  assert.equal(byId.videoExportPresets?.[0].id, 'capacity-0');
  assert.equal(byId.videoExportPresets?.[0].name, 'Renamed at capacity');
  assert.deepEqual(
    new Set(byId.videoExportPresets?.map((preset) => preset.id)),
    new Set(seeded.videoExportPresets?.map((preset) => preset.id)),
  );
});

test('concurrent export preset writes, deletion, settings update and ordinary profile patch preserve all independent changes', async () => {
  await profileStore.replace({ ...await profileStore.get(), videoExportPresets: [] });
  const created = await profileStore.upsertVideoExportPreset({ name: 'To remove', settings: videoSettings() });
  const oldId = created.videoExportPresets![0].id;
  await Promise.all([
    profileStore.upsertVideoExportPreset({ name: 'Landscape', settings: videoSettings({ resolution: '1080p' }) }),
    profileStore.upsertVideoExportPreset({ name: 'Vertical', settings: videoSettings({ resolution: '720p' }) }),
    profileStore.deleteVideoExportPreset(oldId),
    profileStore.setLastVideoExportSettings(videoSettings({ frameRate: 25 })),
    profileStore.patch({ preferences: { reviewPostRollMs: 700 } }),
  ]);
  const final = await profileStore.get();
  assert.deepEqual(final.videoExportPresets?.map((preset) => preset.name).sort(), ['Landscape', 'Vertical']);
  assert.deepEqual(final.lastVideoExportSettings, videoSettings({ frameRate: 25 }));
  assert.equal(final.preferences.reviewPostRollMs, 700);

  const duplicate = await profileStore.upsertVideoExportPreset({ name: 'LANDSCAPE', settings: videoSettings({ resolution: '2160p' }) });
  assert.equal(duplicate.videoExportPresets?.length, 2);
  assert.equal(duplicate.videoExportPresets?.find((preset) => preset.name === 'LANDSCAPE')?.settings.resolution, '2160p');
  const secondId = duplicate.videoExportPresets!.find((preset) => preset.name === 'Vertical')!.id;
  await assert.rejects(profileStore.upsertVideoExportPreset({ id: secondId, name: 'LANDSCAPE', settings: videoSettings() }), /already uses that name/);
  assert.equal((await profileStore.get()).videoExportPresets?.length, 2);
});

test('profile video export HTTP endpoints return durable complete AppProfile and actionable validation status', async () => {
  const { default: profileRouter } = await import('../apps/server/src/routes/profile.js');
  const app = express();
  app.use(express.json());
  app.use('/api/profile', profileRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/profile`;
  const request = (url: string, method: string, data?: unknown) => fetch(`${baseUrl}${url}`, {
    method,
    ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
  });
  try {
    const settings = videoSettings({ resolution: '1440p' });
    const put = await request('/video-export-settings', 'PUT', { settings });
    assert.equal(put.status, 200);
    const updated = await put.json();
    assert.deepEqual(updated.lastVideoExportSettings, settings);
    assert.equal(updated.version, 1);

    const post = await request('/video-export-presets', 'POST', { name: 'HTTP preset', settings });
    assert.equal(post.status, 200);
    const saved = await post.json();
    assert.equal(saved.videoExportPresets[0].name, 'HTTP preset');
    assert.deepEqual(saved.lastVideoExportSettings, settings);
    const id = saved.videoExportPresets[0].id;
    const deleted = await request(`/video-export-presets/${encodeURIComponent(id)}`, 'DELETE');
    assert.equal(deleted.status, 200);
    assert.deepEqual((await deleted.json()).videoExportPresets.some((preset: { id: string }) => preset.id === id), false);

    const malformed = await request('/video-export-settings', 'PUT', { settings: 'invalid' });
    assert.equal(malformed.status, 400);
    assert.equal((await request('/video-export-presets', 'POST', { name: '', settings })).status, 400);
    assert.equal((await request('/video-export-presets', 'POST', { name: 'Missing settings' })).status, 400);
    const missing = await request(`/video-export-presets/${encodeURIComponent(id)}`, 'DELETE');
    assert.equal(missing.status, 404);
    assert.deepEqual((await profileStore.get()).lastVideoExportSettings, settings);

    const full = await profileStore.replace({
      ...await profileStore.get(),
      videoExportPresets: Array.from({ length: 20 }, (_, index) => ({
        id: `http-capacity-${index}`, name: `HTTP preset ${index}`, settings,
      })),
    });
    const bytesAtCapacity = await fs.readFile(config.profileFile);
    const overCapacity = await request('/video-export-presets', 'POST', { name: 'Extra 21st preset', settings });
    assert.equal(overCapacity.status, 409);
    assert.match((await overCapacity.json()).error, /20 video export presets.*delete one/i);
    assert.deepEqual(await fs.readFile(config.profileFile), bytesAtCapacity);
    assert.deepEqual((await profileStore.get()).videoExportPresets, full.videoExportPresets);

    const editAtCapacity = await request('/video-export-presets', 'POST', {
      name: 'http PRESET 19', settings: videoSettings({ quality: 'smaller' }),
    });
    assert.equal(editAtCapacity.status, 200);
    const updatedAtCapacity = await editAtCapacity.json();
    assert.equal(updatedAtCapacity.videoExportPresets.length, 20);
    assert.equal(updatedAtCapacity.videoExportPresets[0].id, 'http-capacity-19');
    assert.equal(updatedAtCapacity.videoExportPresets[0].settings.quality, 'smaller');

    const deleteAtCapacity = await request('/video-export-presets/http-capacity-0', 'DELETE');
    assert.equal(deleteAtCapacity.status, 200);
    const createAfterDelete = await request('/video-export-presets', 'POST', { name: 'Now there is room', settings });
    assert.equal(createAfterDelete.status, 200);
    assert.equal((await createAfterDelete.json()).videoExportPresets.length, 20);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('accepted video export response persists last-used settings before acknowledgement and remains successful on profile write failure', async (t) => {
  const { acceptedVideoExportResponse } = await import('../apps/server/src/routes/video-export.js');
  const queuedJob: ProcessingJob = {
    id: 'accepted-export-stub', type: 'export-video', projectId: 'synthetic', projectTitle: 'Synthetic export',
    status: 'queued', stage: 'queued', progress: 0, message: 'Queued',
    createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', canResume: false,
  };
  const acceptedSettings = videoSettings({ resolution: '2160p', quality: 'high' });
  const accepted = await acceptedVideoExportResponse(queuedJob, acceptedSettings);
  assert.equal(accepted.lastUsedSettingsSaved, true);
  assert.equal(accepted.id, queuedJob.id);
  assert.equal(queuedJob.lastUsedSettingsSaved, undefined, 'transient receipt must not mutate the stored job');
  assert.deepEqual((await profileStore.get()).lastVideoExportSettings, acceptedSettings);

  const previous = await profileStore.get();
  const write = t.mock.method(profileStore, 'setLastVideoExportSettings', async () => {
    throw new Error('Synthetic profile.json EIO and private filesystem detail');
  });
  try {
    const failedSaveResponse = await acceptedVideoExportResponse(
      { ...queuedJob, id: 'accepted-with-profile-error' },
      videoSettings({ quality: 'smaller' }),
    );
    assert.equal(failedSaveResponse.lastUsedSettingsSaved, false);
    assert.equal(failedSaveResponse.id, 'accepted-with-profile-error');
    assert.equal(JSON.stringify(failedSaveResponse).includes('Synthetic profile.json EIO'), false);
    assert.deepEqual(await profileStore.get(), previous);
    assert.equal(write.mock.callCount(), 1);
  } finally {
    write.mock.restore();
  }
});
