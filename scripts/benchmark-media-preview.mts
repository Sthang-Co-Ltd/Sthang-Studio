// Synthetic-only native benchmark. Reports API readiness, never browser first-frame time.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import express from 'express';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-preview-benchmark-'));
let server: import('node:http').Server | undefined;
let invalidate: ((projectId: string) => Promise<void>) | undefined;
let failed = false;
try {
Object.assign(process.env, { STHANG_STUDIO_STATE_ROOT: root, STHANG_STUDIO_ENV_FILE: path.join(root, 'absent.env'), GEMINI_API_KEY: '', STHANG_CONTRIBUTION_ENDPOINT: 'disabled-for-benchmark', STHANG_ANALYTICS_ENDPOINT: 'disabled-for-benchmark' });
const { config } = await import('../apps/server/src/config.js');
const { store } = await import('../apps/server/src/services/store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { default: router } = await import('../apps/server/src/routes/media-preview.js');
const { invalidateMediaPreview } = await import('../apps/server/src/services/media-preview.js');
invalidate = invalidateMediaPreview;
await fs.mkdir(config.uploadDir, { recursive: true });
const source = path.join(config.uploadDir, 'synthetic.mp4');
console.log('Generating three-minute 720p HEVC video with audio.');
execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=180', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=180', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=2:frame-threads=2:log-level=error', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source], { timeout: 180_000, stdio: 'ignore', windowsHide: true });
const project = { id: 'synthetic', title: 'Synthetic benchmark', createdAt: '2026-11-15', updatedAt: '2026-11-15', mode: 'phrase' as const, media: { filename: 'synthetic.mp4', originalName: 'synthetic.mp4', mimeType: 'video/mp4', size: (await fs.stat(source)).size, url: '/media/synthetic.mp4' }, transcript: null, captions: [] };
await store.upsert(project); cancelScheduledProjectPrewarm(project.id);
const app = express(); app.use(express.json()); app.use('/api/media-preview', router); app.use('/media', express.static(config.uploadDir));
server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
const endpoint = `${origin}/api/media-preview/synthetic`;
const digest = async (file: string) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function status(url: string, init: RequestInit = {}, timeoutMs = 25_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))) });
  const value = await response.json(); // The same signal bounds headers and body.
  if (!response.ok) throw new Error('Preview benchmark request failed: ' + response.status);
  return value;
}
  const sourceHash = await digest(source);
  const start = performance.now();
  const deadline = start + 200_000;
  let state = await status(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'synthetic.mp4' }) });
  while (state.state === 'processing' && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    state = await status(endpoint + '?source=synthetic.mp4', {}, Math.min(25_000, deadline - performance.now()));
  }
  if (state.state !== 'ready') throw new Error(JSON.stringify(state));
  const coldReadyMs = Math.round(performance.now() - start);
  const warmStatusMs = [];
  for (let i = 0; i < 5; i++) { const before = performance.now(); const warm = await status(endpoint + '?source=synthetic.mp4'); if (warm.state !== 'ready') throw new Error('Warm cache missed'); warmStatusMs.push(Number((performance.now() - before).toFixed(2))); }
  const compatible = path.join(config.cacheDir, 'media-previews', project.id, state.url.split('/').at(-1));
  const bytes = (await fs.stat(compatible)).size;
  const ranges = [];
  const handle = await fs.open(compatible, 'r');
  try {
    for (const start of [0, Math.floor(bytes * .5), bytes - 100]) {
      const response = await fetch(origin + state.url, { headers: { Range: `bytes=${start}-${start + 99}` }, signal: AbortSignal.timeout(25_000) });
      const payload = Buffer.from(await response.arrayBuffer());
      const expected = Buffer.alloc(100);
      const read = await handle.read(expected, 0, expected.length, start);
      const contentRange = response.headers.get('content-range');
      if (response.status !== 206 || payload.length !== 100 || read.bytesRead !== 100 || !payload.equals(expected)
        || contentRange !== `bytes ${start}-${start + 99}/${bytes}`) throw new Error('Range continuity failed');
      ranges.push({ start, status: response.status, length: payload.length, contentRange, bytesMatch: true });
    }
  } finally { await handle.close(); }
  const decodeStart = performance.now();
  execFileSync(config.ffmpegPath, ['-v', 'error', '-xerror', '-i', compatible, '-f', 'null', '-'], { timeout: 90_000, stdio: 'pipe', windowsHide: true });
  const fullDecodeMs = Math.round(performance.now() - decodeStart);
  const probe = (file: string) => JSON.parse(execFileSync(config.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration,start_time:stream=codec_name,codec_type,duration,start_time,width,height,avg_frame_rate,sample_rate,channels', '-of', 'json', file], { encoding: 'utf8', timeout: 20_000, windowsHide: true }));
  const compatibleMetadata = probe(compatible);
  if (sourceHash !== await digest(source)) throw new Error('Original source changed');
  await fs.rm(compatible);
  const missing = await fetch(origin + state.url, { headers: { Range: 'bytes=0-99' }, signal: AbortSignal.timeout(25_000) });
  await missing.arrayBuffer();
  const afterEviction = await status(endpoint + '?source=synthetic.mp4');
  if (missing.status !== 404 || afterEviction.state !== 'original') throw new Error('Missing copy was advertised ready');
  const result = { platform: process.platform, node: process.version, durationSeconds: 180, resolution: '1280x720', coldReadyMs, warmStatusMs, fullDecodeMs, source: probe(source), compatible: compatibleMetadata, compatibleBytes: bytes, ranges, sourceUnchanged: true, missingCopyStatus: missing.status, statusAfterEviction: afterEviction.state, firstVisibleFrameMs: null, limitation: 'API readiness and FFmpeg decode only; browser first visible frame must be measured separately.' };
  await fs.mkdir('test-results', { recursive: true }); await fs.writeFile('test-results/long-preview-native.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  failed = true;
  throw error;
} finally {
  const cleanupErrors: unknown[] = [];
  if (invalidate) await invalidate('synthetic').catch((error) => cleanupErrors.push(error));
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
      .catch((error) => cleanupErrors.push(error));
  }
  await fs.rm(root, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
  if (!failed && cleanupErrors.length) throw cleanupErrors[0];
}
