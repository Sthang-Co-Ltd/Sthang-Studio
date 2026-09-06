import { expect, type Page } from '@playwright/test';
import { DEFAULT_CAPTION_APPEARANCE, type AppProfile, type CaptionProject, type ProcessingJob, type VideoExportCapabilities } from '@kcs/shared';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const source = { width: 640, height: 360, displayWidth: 640, displayHeight: 360, rotation: 0, durationMs: 4000, frameRate: 25, variableFrameRate: false, videoCodec: 'h264', pixelFormat: 'yuv420p', bitDepth: 8, hdr: 'sdr' as const, audioCodecs: [], audioStreams: 0 };
export const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: process.platform === 'win32' ? 'Khmer UI' : 'Noto Sans Khmer' };
export const capabilities: VideoExportCapabilities = { supported: true, source, subtitlesFilter: true, availableDiskBytes: 10_000_000_000, warnings: [], fonts: [
  { name: appearance.fontFamily, available: true, boldAvailable: true, source: process.platform === 'win32' ? 'windows-system' : 'linux-system' },
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
  return { id, title: `Audit ${id}`, createdAt: now, updatedAt: now, media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 5000, url: `/media/${id}.mp4` }, mode: 'phrase', captions: structuredClone(captions), captionAppearance: { ...style }, transcript: { language: 'km', fullText: captions.map((c) => c.text).join(' '), segments: structuredClone(captions), tokens: captions.map((c) => ({ text: c.text, startMs: c.startMs, endMs: c.endMs, confidence: 1, quality: 'anchored' as const })), timing: { engine: 'kfa-local', provider: 'local', model: 'synthetic', sttTranscript: 'synthetic', audioDurationMs: 4000, totalTokens: 3, anchoredTokens: 3, interpolatedTokens: 0, lowConfidenceTokens: 0, alignmentCoverage: 1, meanAlignmentScore: 1 } } };
}

export interface FixtureState {
  projects: CaptionProject[];
  profile: AppProfile;
  jobs: ProcessingJob[];
  requests: Array<{ path: string; method: string; body: any }>;
  previewDelay: (body: any) => number;
  appearanceFailure: boolean;
  native: boolean;
  previewError: string;
}

let scratch: string;
let media: Buffer;
let nativeModules: { renderCaptionPreview: any; parseCaptionPreviewInput: any };
let mockServer: http.Server | null = null;
const transparentPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';

export async function prepareFixtures() {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-browser-test-'));
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
  mockServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/exports/')) {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'attachment; filename="synthetic-captioned.mp4"',
      });
      res.end(media);
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
  });
  await new Promise<void>((resolve, reject) => {
    mockServer!.listen(8787, '127.0.0.1', () => resolve());
    mockServer!.on('error', reject);
  });
}
export function fixtureMedia() { return Buffer.from(media); }
export async function cleanFixtures() {
  if (mockServer) {
    await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
    mockServer = null;
  }
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
}

export async function installFixture(page: Page): Promise<FixtureState> {
  const state: FixtureState = { projects: [project(), project('second', { ...appearance, textColor: '#FF8000', fontSize1080: 88 })], profile: { version: 1, defaultVocabulary: [], styles: [], topicPacks: [], correctionRules: [], correctionEvents: [], captionAppearances: [], preferences: { reviewPreRollMs: 100, reviewPostRollMs: 100, autoLoopReview: false, autoPlayNextReview: false, reviewFocusMode: 'brackets-label', analyticsConsent: 'declined', khmerContributionConsent: 'declined', privacyUpgradeNoticeVersion: '0.8', autosaveDelayMs: 250 }, updatedAt: now }, jobs: [], requests: [], previewDelay: () => 0, appearanceFailure: false, native: false, previewError: '' };
  await page.addInitScript(() => {
    for (const key of ['sthang:first-run-dismissed:v1', 'sthang:project-guide-seen:v1', 'kcs:profile-migrated:v1']) localStorage.setItem(key, '1');
    // A deterministic polling fallback: no unbounded SSE reconnect loop in a test fixture.
    (window as any).EventSource = undefined;
  });
  await page.route('https://**/*', (route) => route.abort());
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
  await page.route('**/exports/*.mp4', (route) => route.fulfill({ contentType: 'video/mp4', body: media, headers: { 'Content-Disposition': 'attachment; filename="synthetic-captioned.mp4"' } }));
  await page.route('**/api/**', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method(); const body = request.postDataJSON();
    state.requests.push({ path: url.pathname, method, body });
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const id = url.pathname.split('/')[3];
    const current = state.projects.find((item) => item.id === id);
    if (url.pathname === '/api/projects') return json(state.projects);
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
    if (current && url.pathname.endsWith('/capabilities')) return json(capabilities);
    if (current && url.pathname.endsWith('/preview')) {
      const delay = state.previewDelay(body); if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (state.previewError) return json({ error: state.previewError }, 400);
      try {
        const result = state.native ? await nativeModules.renderCaptionPreview(nativeModules.parseCaptionPreviewInput(body), capabilities) : {
          width: 640, height: 360, frames: body.timesMs.map((atMs: number) => ({ atMs, png: transparentPng, bounds: { x: 160, y: 270, width: 320, height: 40 } })),
        };
        return await json(result);
      } catch (error) { return json({ error: error instanceof Error ? error.message : 'Fixture failure' }, 400).catch(() => {}); }
    }
    if (current && url.pathname.endsWith('/appearance')) {
      if (state.appearanceFailure) return json({ error: 'Synthetic save failure' }, 500);
      current.captionAppearance = body.appearance; return json(current);
    }
    if (current && url.pathname.endsWith('/captions')) { current.captions = body.captions; return json({ project: current, correctionsCreated: 0 }); }
    if (current && url.pathname.endsWith('/jobs') && method === 'POST') {
      const job: ProcessingJob = { id: 'export-job', type: 'export-video', projectId: current.id, projectTitle: current.title, status: 'queued', stage: 'queued', progress: 0, message: 'Queued', createdAt: now, updatedAt: now, canResume: false };
      state.jobs.push(job); return json(job, 202);
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
