import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionProject, type CaptionSegment } from '../packages/shared/src/index.js';

// Real native export with disposable generated video/audio only. No app/network/models.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-override-native-export-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { config } = await import('../apps/server/src/config.js');
const { store } = await import('../apps/server/src/services/store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { createMediaReplacementService } = await import('../apps/server/src/services/media-replacement.js');
const { fontCapabilities } = await import('../apps/server/src/services/caption-renderer.js');
const { renderCaptionPreview, parseCaptionPreviewInput } = await import('../apps/server/src/services/caption-preview.js');
const { renderCaptionedVideo, probeVideoExportCapabilities } = await import('../apps/server/src/services/video-export.js');
const id = 'accepted-audio-native-export';
after(async () => {
  cancelScheduledProjectPrewarm(id);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

function ffmpeg(args: string[], input?: Buffer) {
  return execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    input, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 30_000,
  });
}
function audioPackets(file: string) {
  return ffmpeg(['-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'adts', '-']);
}
function highlightPaint(frame: Buffer) {
  let count = 0; let xTotal = 0;
  for (let i = 0; i < frame.length; i += 4) {
    const red = frame[i]; const green = frame[i + 1]; const blue = frame[i + 2];
    if (green > 150 && green - blue > 70 && red - blue > 50 && green - red > 12) {
      count++; xTotal += (i / 4) % 640;
    }
  }
  return { count, centerX: count ? xTotal / count : 0 };
}

test('accepted music/SFX replacement burns the retained word-highlight intervals into a real MP4 and preserves new audio', async (t) => {
  await fs.mkdir(config.uploadDir, { recursive: true });
  const filename = `${id}-original.mp4`;
  const currentPath = path.join(config.uploadDir, filename);
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x204060:s=640x360:r=25:d=1.6', '-f', 'lavfi', '-i', 'aevalsrc=0.14*sin(2*PI*(173*t+17*t*t))+0.06*sin(2*PI*611*t):s=48000:d=1.6',
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-t', '1.6', currentPath]);
  const replacementPath = path.join(root, 'music-sfx.mp4');
  ffmpeg(['-i', currentPath, '-f', 'lavfi', '-i', 'aevalsrc=1.4*(0.14*sin(2*PI*(173*t+17*t*t))+0.06*sin(2*PI*611*t))+0.03*sin(2*PI*337*t)+if(between(t\\,1.05\\,1.10)\\,0.08*sin(2*PI*2200*t)\\,0):s=48000:d=1.6',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-t', '1.6', replacementPath]);
  const originalBytes = await fs.readFile(currentPath);
  const replacementBytes = await fs.readFile(replacementPath);
  const replacementAudio = audioPackets(replacementPath);
  assert.notDeepEqual(replacementAudio, audioPackets(currentPath), 'fixture must contain changed audio');
  const fonts = await fontCapabilities();
  const family = process.platform === 'win32' ? 'Leelawadee UI' : process.platform === 'linux' ? 'Noto Sans Khmer' : fonts.find((font) => font.available && font.boldAvailable)?.name;
  assert.ok(family && fonts.some((font) => font.name === family && font.available && font.boldAvailable), 'native export requires a known available regular+bold fixture font');
  const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: family, fontSize1080: 78, highlightMode: 'word' as const, highlightColor: '#D7FF4F',
    motionPreset: 'none' as const, backgroundEnabled: false, glowEnabled: false };
  const captions: CaptionSegment[] = [{ id: 'reviewed-native-cue', text: 'Keep timing', startMs: 80, endMs: 1520, approved: true, textLocked: true, timingLocked: true,
    timingSource: 'manual', timingQuality: 'high', wordTiming: { version: 1, text: 'Keep timing', words: [
      { id: 'keep-word', startOffset: 0, endOffset: 4, startMs: 260, endMs: 600, source: 'manual' },
      { id: 'timing-word', startOffset: 5, endOffset: 11, startMs: 960, endMs: 1320, source: 'manual' },
    ] } }];
  const project: CaptionProject = { id, title: 'Synthetic retained word highlight', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    media: { filename, originalName: filename, mimeType: 'video/mp4', size: originalBytes.length, url: `/media/${filename}` },
    captions, transcript: null, mode: 'phrase', captionAppearance: appearance };
  await store.upsert(project);
  cancelScheduledProjectPrewarm(id);
  const service = createMediaReplacementService();
  const uploadedPath = path.join(config.uploadDir, 'native-override-upload');
  const upload = { path: uploadedPath, originalname: 'music-sfx.mp4', mimetype: 'video/mp4', size: replacementBytes.length };
  const options = { mode: 'preserve' as const, expectedMedia: project.media, expectedUpdatedAt: project.updatedAt };
  await fs.writeFile(uploadedPath, replacementBytes);
  let token: string | undefined;
  await assert.rejects(service.replaceProjectMedia(id, upload, options), (error: any) => {
    assert.equal(error.code, 'MEDIA_AUDIO_MISMATCH');
    token = error.preserveAudioConfirmation?.token;
    assert.ok(token, 'the native sample must traverse the explicit acceptance protocol');
    return true;
  });
  await fs.writeFile(uploadedPath, replacementBytes);
  const retained = await service.replaceProjectMedia(id, upload, { ...options, audioChangeConfirmation: token });
  cancelScheduledProjectPrewarm(id);
  assert.equal(retained.mediaAlignment?.state, 'unverified-audio-change');
  assert.deepEqual(retained.captions, captions);
  assert.deepEqual(retained.captionAppearance, appearance);
  const replacementSource = path.join(config.uploadDir, retained.media.filename);
  const capabilities = await probeVideoExportCapabilities(retained);
  assert.ok(capabilities.supported, capabilities.blockingReason);
  const rendered = await renderCaptionedVideo(retained, retained.captions, retained.captionAppearance, { encoder: 'software', quality: 'high' });
  assert.ok(rendered.sizeBytes > 0);
  assert.equal(rendered.audioCodec, 'aac');
  const outputPath = path.join(config.exportDir, rendered.filename);
  assert.deepEqual(audioPackets(outputPath), replacementAudio, 'captioned MP4 must carry the replacement music/SFX audio unchanged');
  assert.deepEqual(await fs.readFile(replacementSource), replacementBytes, 'export must not mutate the accepted source');

  const timesMs = [160, 360, 760, 1120, 1440];
  const preview = await renderCaptionPreview(parseCaptionPreviewInput({ captions: retained.captions, timesMs, appearance: retained.captionAppearance, resolution: 'source' }), capabilities);
  const painted: Array<ReturnType<typeof highlightPaint>> = [];
  const meanErrors: number[] = [];
  for (let index = 0; index < timesMs.length; index++) {
    const raw = ffmpeg(['-ss', String(timesMs[index] / 1000), '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    const pixels = ffmpeg(['-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], Buffer.from(preview.frames[index].png, 'base64'));
    const box = preview.frames[index].bounds;
    assert.ok(box, 'each retained interval must paint the reviewed caption');
    let error = 0; let count = 0;
    for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
      const offset = (y * 640 + x) * 4;
      const alpha = pixels[offset + 3] / 255;
      for (let channel = 0; channel < 3; channel++) {
        error += Math.abs(raw[offset + channel] - (pixels[offset + channel] * alpha + [32, 64, 96][channel] * (1 - alpha)));
        count++;
      }
    }
    const meanError = error / count;
    assert.ok(meanError < 8, `${timesMs[index]}ms exported caption region differs from retained word timing preview: ${meanError}`);
    meanErrors.push(meanError);
    painted.push(highlightPaint(raw));
  }
  assert.ok(painted[1].count > 20 && painted[3].count > 20, 'both retained spoken-word intervals must visibly highlight in the decoded MP4');
  for (const index of [0, 2, 4]) assert.ok(painted[index].count < Math.min(painted[1].count, painted[3].count) / 5, 'before speech, inter-word pause and after speech must keep base paint');
  assert.ok(painted[1].centerX < painted[3].centerX, 'highlight must advance from the first retained word to the second');
  assert.deepEqual((await store.get(id))!.captions, captions, 'rendering must not rewrite reviewed timings or locks');
  t.diagnostic(JSON.stringify({ font: family, durationMs: rendered.durationMs, audioPacketsPreserved: replacementAudio.length, timesMs, meanErrors, painted }));
});
