import { expect, type Page, type Request } from '@playwright/test';
import { DEFAULT_CAPTION_APPEARANCE, summarizeProject, type AppProfile, type CaptionProject, type ProcessingJob, type VideoExportCapabilities, type VideoExportFontCapability } from '@kcs/shared';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addTestNamespace, guardNamespacedRequest, prepareOwnedStateRoot, requireHarnessConfig, safeFrontendUrl, verifyOwnedStateRoot } from './harness-config.mjs';
import { installBrowserNetworkGuard, installNativeExportGuard, ownedNativeExportUrl } from './owned-browser-routes.mjs';

export const source = { width: 640, height: 360, displayWidth: 640, displayHeight: 360, rotation: 0, durationMs: 4000, frameRate: 25, variableFrameRate: false, videoCodec: 'h264', pixelFormat: 'yuv420p', bitDepth: 8, hdr: 'sdr' as const, audioCodecs: [], audioStreams: 0 };
export const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: process.platform === 'win32' ? 'Khmer UI' : 'Noto Sans Khmer' };
export const capabilities: VideoExportCapabilities = { supported: true, source, subtitlesFilter: true, availableDiskBytes: 10_000_000_000, warnings: [], fonts: [
  { name: appearance.fontFamily, available: true, boldAvailable: true, source: process.platform === 'win32' ? 'windows-system' : process.platform === 'darwin' ? 'macos-system' : 'linux-system' },
  { name: 'Regular-only fixture', available: true, boldAvailable: false, source: 'user-installed' },
], encoders: [{ id: 'software', label: 'Software', encoder: 'libx264', codec: 'h264', hardware: false, available: true }], resolutions: [
  { id: 'source', label: 'Original', width: 640, height: 360, upscaled: false },
  { id: '720p', label: 'HD 720p', width: 1280, height: 720, upscaled: true },
  { id: '2160p', label: '4K UHD 2160p', width: 3840, height: 2160, upscaled: true },
] };
const now = '2026-01-01T00:00:00.000Z';
const captions = [
  { id: 'c1', startMs: 200, endMs: 1000, text: 'កម្ពុជា CapCut', timingQuality: 'low' as const, timingSource: 'stt' as const },
  { id: 'c2', startMs: 1200, endMs: 2200, text: 'ខ្មែររបស់យើង', timingQuality: 'low' as const, timingSource: 'stt' as const },
  { id: 'c3', startMs: 2400, endMs: 3300, text: 'Third caption', timingQuality: 'high' as const, timingSource: 'stt' as const },
];
export function project(id = 'landscape', style = appearance): CaptionProject {
  return { id, title: `Audit ${id}`, createdAt: now, updatedAt: now, media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 5000, url: `/media/${id}.mp4` }, mode: 'phrase', captions: structuredClone(captions), captionAppearance: { ...style }, transcript: { language: 'km', fullText: captions.map((c) => c.text).join(' '), segments: structuredClone(captions), tokens: captions.map((c, index) => ({ id: `fixture-token-${c.id}`, text: c.text, startMs: c.startMs, endMs: c.endMs, spaceBefore: index > 0, timingSource: 'stt' as const, confidence: 1, quality: 'anchored' as const })), timing: { engine: 'kfa-local', provider: 'local', model: 'synthetic', sttTranscript: 'synthetic', audioDurationMs: 4000, totalTokens: 3, anchoredTokens: 3, interpolatedTokens: 0, lowConfidenceTokens: 0, alignmentCoverage: 1, meanAlignmentScore: 1 } } };
}

export interface FixtureState {
  projects: CaptionProject[];
  profile: AppProfile;
  fonts: VideoExportFontCapability[];
  jobs: ProcessingJob[];
  requests: Array<{ path: string; method: string; body: any }>;
  previewDelay: (body: any) => number;
  appearanceFailure: boolean;
  native: boolean;
  previewError: string;
  previewGatewayFailures: number;
}

let scratch: string;
let media: Buffer;
let nativeModules: { renderCaptionPreview: any; parseCaptionPreviewInput: any };
let mockServer: http.Server | null = null;
const harness = requireHarnessConfig();
const transparentPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';

export async function prepareFixtures() {
  scratch = await prepareOwnedStateRoot(harness, 'mock-state-');
  process.env.STHANG_STUDIO_STATE_ROOT = scratch;
  process.env.STHANG_STUDIO_ENV_FILE = path.join(scratch, 'absent.env');
  const file = path.join(scratch, 'synthetic.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=0x204060:s=640x360:r=25:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { timeout: 30_000, windowsHide: true });
  media = await fs.readFile(file);
  nativeModules = await import('../../apps/server/src/services/caption-preview.js');
  const { fontCapabilities } = await import('../../apps/server/src/services/caption-renderer.js');
  const availableFonts = await fontCapabilities();
  const candidate = availableFonts.find((item: any) => item.available && item.boldAvailable);
  if (candidate) {
    appearance.fontFamily = candidate.name;
    capabilities.fonts[0] = {
      name: candidate.name,
      available: true,
      boldAvailable: true,
      source: candidate.source,
    };
  }
  mockServer = http.createServer(guardNamespacedRequest((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Sthang-Studio-Activation': harness.marker });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url?.startsWith('/exports/')) {
      if (req.url !== '/exports/synthetic-captioned.mp4' || !['GET', 'HEAD'].includes(req.method || '')) {
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'attachment; filename="synthetic-captioned.mp4"',
        'Content-Length': String(media.length),
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : media);
      return;
    }
    if (req.url?.includes('/normalized-audio.wav')) {
      const isSecond = req.url.includes('/second');
      const wav = isSecond ? createSyntheticWav(4.0, 880) : createSyntheticWav(4.0, 440);
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(wav.length),
      });
      res.end(wav);
      return;
    }
    if (req.url?.startsWith('/media/')) {
      const range = req.headers['range'];
      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : media.length - 1;
          const chunk = media.subarray(start, end + 1);
          res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Content-Range': `bytes ${start}-${end}/${media.length}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunk.length),
          });
          res.end(chunk);
          return;
        }
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(media.length),
      });
      res.end(media);
      return;
    }
    res.writeHead(404);
    res.end();
  }, harness));
  await new Promise<void>((resolve, reject) => {
    mockServer!.on('error', reject);
    mockServer!.listen({ port: harness.apiPort, host: '127.0.0.1', exclusive: true }, () => resolve());
  });
  for (const url of [`${harness.apiOrigin}${addTestNamespace('/api/health', harness)}`, safeFrontendUrl(`${harness.webOrigin}/api/health`, harness), safeFrontendUrl(`${harness.webOrigin}/studio-web-identity.json`, harness)]) {
    const address = mockServer.address();
    if (!address || typeof address === 'string' || address.port !== harness.apiPort || address.address !== '127.0.0.1') throw new Error('Owned synthetic listener is not ready.');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1000) });
    if (!mockServer.listening || !response.ok || response.headers.get('X-Sthang-Studio-Activation') !== harness.marker) throw new Error('Synthetic API/frontend ownership probe failed.');
    const body = await response.json();
    if (url.endsWith('/studio-web-identity.json') ? body.service !== 'sthang-studio-web' || body.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(body.buildId) : body.ok !== true) throw new Error('Synthetic ownership health payload is invalid.');
  }
}
export function fixtureMedia() { return Buffer.from(media); }
export function fixtureExportUrl(): string {
  if (!mockServer) throw new Error('The owned native export fixture is not ready.');
  return ownedNativeExportUrl(mockServer, scratch, harness);
}
export async function cleanFixtures() {
  const { disposePersistentCaptionPreviews } = await import('../../apps/server/src/services/persistent-caption-preview.js');
  await disposePersistentCaptionPreviews();
  if (mockServer) {
    await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
    mockServer = null;
  }
  if (scratch) await fs.rm(verifyOwnedStateRoot(scratch, harness), { recursive: true, force: true });
}

export function createSyntheticWav(durationSeconds: number, frequency = 440, sampleRate = 44100): Buffer {
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequency * t);
    const int16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    buffer.writeInt16LE(int16, 44 + i * 2);
  }

  return buffer;
}

export async function installFixture(page: Page): Promise<FixtureState> {
  await installBrowserNetworkGuard(page.context(), harness);
  if (!mockServer) throw new Error('The owned native export fixture is not ready.');
  await installNativeExportGuard(page.context(), mockServer, scratch, harness);
  const nativeExportUrl = fixtureExportUrl();
  const state: FixtureState = { projects: [project(), project('second', { ...appearance, textColor: '#FF8000', fontSize1080: 88 })], profile: { version: 1, defaultVocabulary: [], styles: [], topicPacks: [], correctionRules: [], correctionEvents: [], captionAppearances: [], preferences: { reviewPreRollMs: 100, reviewPostRollMs: 100, autoLoopReview: false, autoPlayNextReview: false, reviewFocusMode: 'brackets-label', analyticsConsent: 'declined', khmerContributionConsent: 'declined', privacyUpgradeNoticeVersion: '0.8', autosaveDelayMs: 250 }, updatedAt: now }, fonts: structuredClone(capabilities.fonts), jobs: [], requests: [], previewDelay: () => 0, appearanceFailure: false, native: false, previewError: '', previewGatewayFailures: 0 };
  await page.addInitScript(() => {
    for (const key of ['sthang:first-run-dismissed:v1', 'sthang:project-guide-seen:v1', 'kcs:profile-migrated:v1']) localStorage.setItem(key, '1');
    // A deterministic polling fallback: no unbounded SSE reconnect loop in a test fixture.
    (window as any).EventSource = undefined;
    (window as any).__STHANG_TEST_HOOKS__ = {
      spectrumComputeCount: 0,
      spectrumCacheHitCount: 0,
      audioCacheHitCount: 0,
      findReplaceScanCount: 0,
      scheduledSpectrumCount: 0,
      publishedSpectrumCount: 0,
      spectrumDelayMs: 0,
      computedSpectrumKeys: [] as string[],
      publishedSpectra: [] as Array<{ key: string; bands: number; columns: number; values: number[] }>,
      onScheduleSpectrum(key: string) {
        this.scheduledSpectrumCount++;
      },
      onComputeSpectrum(key: string) {
        this.spectrumComputeCount++;
        this.computedSpectrumKeys.push(key);
      },
      onPublishSpectrum(key: string, spectrum: { bands: number; columns: number; values: ArrayLike<number> }) {
        this.publishedSpectrumCount++;
        this.publishedSpectra.push({
          key,
          bands: spectrum.bands,
          columns: spectrum.columns,
          values: Array.from(spectrum.values),
        });
      },
      onSpectrumCacheHit() {
        this.spectrumCacheHitCount++;
      },
      onAudioCacheHit() {
        this.audioCacheHitCount++;
      },
      onFindReplaceScan() {
        this.findReplaceScanCount++;
      },
    };
  });
  await page.route('https://**/*', (route) => route.abort());
  const wavA = createSyntheticWav(4.0, 440);
  const wavB = createSyntheticWav(4.0, 880);
  await page.route('**/media/*/audio**', (route) => {
    const url = route.request().url();
    const isSecond = url.includes('/second/');
    const body = isSecond ? wavB : wavA;
    return route.fulfill({
      status: 200,
      contentType: 'audio/wav',
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(body.length),
      },
      body,
    });
  });
  await page.route('**/media/*.mp4', (route) => {
    const range = route.request().headers()['range'];
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : media.length - 1;
        const chunk = media.subarray(start, end + 1);
        return route.fulfill({
          status: 206,
          contentType: 'video/mp4',
          headers: {
            'Content-Range': `bytes ${start}-${end}/${media.length}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunk.length),
          },
          body: chunk,
        });
      }
    }
    return route.fulfill({
      status: 200,
      contentType: 'video/mp4',
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(media.length),
      },
      body: media,
    });
  });
  await page.route('**/exports/*.mp4', (route) => {
    const request = route.request();
    if (request.url() === nativeExportUrl) {
      state.requests.push({ path: new URL(request.url()).pathname, method: request.method(), body: null });
      return route.fallback();
    }
    return route.fulfill({ contentType: 'video/mp4', body: media, headers: { 'Content-Disposition': 'attachment; filename="synthetic-captioned.mp4"' } });
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    let body: any = null;
    try { body = request.postDataJSON(); } catch { body = request.postData(); }
    state.requests.push({ path: url.pathname, method, body });
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const id = url.pathname.split('/')[3];
    const current = state.projects.find((item) => item.id === id);
    if (url.pathname.endsWith('/normalized-audio.wav')) {
      const isSecond = url.pathname.includes('/second');
      const body = isSecond ? wavB : wavA;
      return route.fulfill({
        status: 200,
        contentType: 'audio/wav',
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(body.length),
        },
        body,
      });
    }
    if (url.pathname === '/api/projects') return json(url.searchParams.get('summary') === '1' ? state.projects.map(summarizeProject) : state.projects);
    if (url.pathname === '/api/profile/video-export-settings' && method === 'PUT') {
      state.profile = { ...state.profile, lastVideoExportSettings: structuredClone(body.settings) };
      return json(state.profile);
    }
    if (url.pathname === '/api/profile/video-export-presets' && method === 'POST') {
      const name = String(body?.name || '').trim();
      if (!name) return json({ error: 'Name required' }, 400);
      const currentPresets = state.profile.videoExportPresets || [];
      const existing = currentPresets.find((preset) => preset.name.toLocaleLowerCase('en') === name.toLocaleLowerCase('en'));
      if (!existing && currentPresets.length >= 20) {
        return json({ error: 'You can save up to 20 video export presets. Delete one before saving a new preset.' }, 409);
      }
      const preset = {
        id: existing?.id || `export-preset-${state.requests.length}`,
        name,
        settings: structuredClone(body.settings),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      state.profile = { ...state.profile, videoExportPresets: [preset, ...currentPresets.filter((item) => item.id !== preset.id)] };
      return json(state.profile);
    }
    if (url.pathname.startsWith('/api/profile/video-export-presets/') && method === 'DELETE') {
      const presetId = decodeURIComponent(url.pathname.slice('/api/profile/video-export-presets/'.length));
      state.profile = { ...state.profile, videoExportPresets: (state.profile.videoExportPresets || []).filter((item) => item.id !== presetId) };
      return json(state.profile);
    }
    if (url.pathname === '/api/profile') {
      if (method === 'PATCH') state.profile = { ...state.profile, ...body, preferences: { ...state.profile.preferences, ...body.preferences } };
      return json(state.profile);
    }
    const llm = { provider: 'gemini', configured: true, keySource: 'none', maskedKey: null, model: 'synthetic', fallbackModel: '', secureStorageAvailable: false, secureStorageLabel: 'Test', environmentFallbackAvailable: false, canForgetSecureKey: false, updatedAt: null };
    if (url.pathname === '/api/health') return json({ ok: true, engineVersion: 'test', llm, timing: { configured: true, engine: 'kfa-local', model: 'synthetic', provider: 'local', device: 'cpu', language: 'km', paidApi: false } });
    if (url.pathname === '/api/system/llm-settings') return json(llm);
    if (url.pathname === '/api/jobs') return json(state.jobs);
    if (url.pathname.startsWith('/api/jobs/') && method === 'POST') {
      const job = state.jobs.find((item) => item.id === id);
      if (!job) return json({ error: 'Unknown synthetic job' }, 404);
      if (url.pathname.endsWith('/cancel')) { job.status = 'cancelled'; job.canResume = true; job.message = 'Cancelled safely'; }
      else if (url.pathname.endsWith('/resume')) { job.status = 'queued'; job.canResume = false; job.message = 'Queued to resume'; }
      else return json({ error: 'Unknown synthetic action' }, 404);
      return json(job);
    }
    if (url.pathname === '/api/contribution/status') return json({ consent: 'declined', endpointConfigured: false, contributorEnrolled: false, queued: 0, submitted: 0, verified: 0, rejected: 0, withdrawn: 0, verifiedAudioMs: 0, withdrawalPending: false });
    if (url.pathname === '/api/video-export/location') return json({ directory: 'C:\\Synthetic\\exports' });
    if (url.pathname === '/api/video-export/fonts' && method === 'GET') return json({ fonts: state.fonts });
    if (url.pathname === '/api/video-export/fonts' && method === 'POST') {
      const added: VideoExportFontCapability = { id: 'studio:fixturefont0001', name: 'Creator Khmer', available: true, boldAvailable: false, source: 'studio-imported', removable: true };
      state.fonts = [added, ...state.fonts.filter((font) => font.name !== added.name)];
      return json({ fonts: state.fonts, imported: [added.name], warnings: [] });
    }
    if (url.pathname.startsWith('/api/video-export/fonts/') && method === 'DELETE') {
      const fontId = decodeURIComponent(url.pathname.slice('/api/video-export/fonts/'.length));
      state.fonts = state.fonts.filter((font) => font.id !== fontId);
      return json({ fonts: state.fonts });
    }
    if (current && url.pathname.endsWith('/capabilities')) return json(capabilities);
    if (current && url.pathname.endsWith('/preview')) {
      const controller = new AbortController();
      const close = () => controller.abort();
      const requestFailed = (failed: Request) => {
        if (failed === request && failed.failure()?.errorText === 'net::ERR_ABORTED') controller.abort();
      };
      const cancelled = () => {
        if (page.isClosed() || request.failure()?.errorText === 'net::ERR_ABORTED') controller.abort();
        return controller.signal.aborted;
      };
      const finishCancelledRoute = async () => {
        // Complete Playwright's handler promise without sending an HTTP reply.
        try { await route.abort('aborted'); }
        catch (error) { if (!cancelled()) throw error; }
      };
      // Match the production response-close lifetime for this exact request.
      // Cancellation releases native work without aborting another preview.
      page.on('requestfailed', requestFailed);
      page.on('close', close);
      try {
        if (cancelled()) return await finishCancelledRoute();
        const delay = state.previewDelay(body); if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (cancelled()) return await finishCancelledRoute();
        if (state.previewGatewayFailures > 0) {
          state.previewGatewayFailures -= 1;
          return await route.fulfill({ status: 502, contentType: 'text/plain', body: '' });
        }
        if (state.previewError) return await json({ error: state.previewError }, 400);
        let result;
        try {
          result = state.native ? await nativeModules.renderCaptionPreview(nativeModules.parseCaptionPreviewInput(body), capabilities, controller.signal, { projectId: current.id, mediaIdentity: current.media.filename }) : {
            width: 640, height: 360, frames: body.timesMs.map((atMs: number) => ({ atMs, png: transparentPng, bounds: { x: 160, y: 270, width: 320, height: 40 } })),
          };
        } catch (error) {
          if (cancelled()) return await finishCancelledRoute();
          const message = error instanceof Error ? error.message : 'Fixture failure';
          return await json({ error: message }, message.includes('preview is busy') ? 429 : 400);
        }
        if (cancelled()) return await finishCancelledRoute();
        return await json(result);
      } catch (error) {
        if (cancelled()) return await finishCancelledRoute();
        throw error;
      } finally {
        page.off('requestfailed', requestFailed);
        page.off('close', close);
      }
    }
    if (current && url.pathname.endsWith('/appearance')) {
      if (state.appearanceFailure) return json({ error: 'Synthetic save failure' }, 500);
      current.captionAppearance = body.appearance; return json(current);
    }
    if (current && url.pathname.endsWith('/captions')) { current.captions = body.captions; return json({ project: current, correctionsCreated: 0 }); }
    if (current && url.pathname.endsWith('/jobs') && method === 'POST') {
      const job: ProcessingJob = { id: 'export-job', type: 'export-video', projectId: current.id, projectTitle: current.title, status: 'queued', stage: 'queued', progress: 0, message: 'Queued', createdAt: now, updatedAt: now, canResume: false };
      state.jobs.push(job);
      // Match the production admission contract: the accepted job commits
      // remembered settings before the response, even if the browser leaves.
      state.profile = { ...state.profile, lastVideoExportSettings: structuredClone(body.settings) };
      return json({ ...job, lastUsedSettingsSaved: true }, 202);
    }
    if (current && url.pathname === `/api/projects/${id}`) return json(current);
    if (url.pathname.endsWith('/history')) return json([]);
    if (url.pathname.startsWith('/api/updates/')) return json({ status: 'unconfigured', currentVersion: 'test', supported: false, message: 'Synthetic fixture' });
    return json({ error: `Unhandled fixture route ${method} ${url.pathname}` }, 404);
  });
  return state;
}

export async function openProject(page: Page, name = 'landscape') {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(`Audit ${name}`) }).click();
  await expect(page.locator('.media-stage video')).toBeVisible();
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1);
  await seek(page, 500);
}
export async function seek(page: Page, ms: number) {
  await page.locator('video').evaluate((video: HTMLVideoElement, time: number) => { video.pause(); video.currentTime = time / 1000; video.dispatchEvent(new Event('timeupdate')); }, ms);
}
