import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { CaptionProject } from '@kcs/shared';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-media-preview-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { config } = await import('../apps/server/src/config.js');
const { store } = await import('../apps/server/src/services/store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { invalidateProjectCache } = await import('../apps/server/src/services/cache.js');
const { jobAdmission } = await import('../apps/server/src/services/job-admission.js');
const { previewProcess, mediaPreviewStatus, startMediaPreview, cancelMediaPreview, cancelMediaPreviewPreparation, mediaPreviewFile } = await import('../apps/server/src/services/media-preview.js');
const { default: router } = await import('../apps/server/src/routes/media-preview.js');
const { needsCompatiblePlayback } = await import('../apps/web/src/media-preview-client.js');
let heldServerRange: { projectId: string; onHeaders: (response: http.ServerResponse) => void } | null = null;
const app = express();
app.use(express.json());
// A test-owned outgoing response barrier makes range ownership observable on
// the server, independently of loopback/socket buffering on the client.
app.use('/api/media-preview', (req, res, next) => {
  const hook = heldServerRange;
  if (hook && req.method === 'GET' && req.url.includes(`/${hook.projectId}/file/`) && req.headers.range) {
    const writeHead = res.writeHead.bind(res);
    res.writeHead = ((...args: any[]) => {
      const result = (writeHead as (...args: any[]) => typeof res)(...args);
      res.flushHeaders();
      res.cork();
      hook.onHeaders(res);
      return result;
    }) as typeof res.writeHead;
  }
  next();
});
app.use('/api/media-preview', router);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/media-preview`;
await fs.mkdir(config.uploadDir, { recursive: true });
after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await fs.rm(root, { recursive: true, force: true }); });

async function seed(id: string, codec = 'libx265', audio = true) {
  const filename = `${id}.mp4`; const source = path.join(config.uploadDir, filename);
  execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=2', ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'] : []), '-c:v', codec, '-threads', '1', ...(codec === 'libx265' ? ['-x265-params', 'pools=1:frame-threads=1:log-level=error'] : []), '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : []), source], { timeout: 30_000, stdio: 'ignore' });
  const project: CaptionProject = { id, title: 'Synthetic preview test', createdAt: '2026-01-01', updatedAt: '2026-01-01', mode: 'phrase', media: { filename, originalName: filename, mimeType: 'video/mp4', size: (await fs.stat(source)).size, url: `/media/${filename}` }, transcript: null, captions: [{ id: 'c1', text: 'Synthetic caption', startMs: 123, endMs: 1400 }] };
  await store.upsert(project); cancelScheduledProjectPrewarm(id); return project;
}
async function terminal(project: CaptionProject) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await mediaPreviewStatus(project);
    if (state.state !== 'processing') return state;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Preview did not finish');
}
function post(project: CaptionProject, method = 'POST') {
  return fetch(`${url}/${project.id}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: project.media.filename }) });
}
function previewPath(project: CaptionProject, state: { url?: string }) {
  return path.join(config.cacheDir, 'media-previews', project.id, state.url!.split('/').at(-1)!);
}
async function makeLargeSyntheticCopy(project: CaptionProject, state: { url?: string }, size = 64 * 1024 * 1024) {
  const file = await fs.open(previewPath(project, state), 'r+');
  const tail = Buffer.from('ORIGINAL-COPY');
  try {
    await file.truncate(size);
    await file.write(tail, 0, tail.length, size - tail.length);
  } finally { await file.close(); }
  const manifest = path.join(config.cacheDir, 'media-previews', project.id, 'ready.json');
  const pointer = JSON.parse(await fs.readFile(manifest, 'utf8'));
  await fs.writeFile(manifest, JSON.stringify({ ...pointer, size }));
  return tail;
}
function openHeldRange(href: string, end: number) {
  let request!: http.ClientRequest;
  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    request = http.get(href, { headers: { Range: `bytes=0-${end}` } }, (stream) => {
      stream.pause(); resolve(stream);
    });
    request.once('error', reject);
  });
  return { request: () => request, response };
}
function holdServerRange(projectId: string) {
  let serverResponse: http.ServerResponse | undefined;
  let entered!: () => void;
  const headers = new Promise<void>((resolve) => { entered = resolve; });
  heldServerRange = { projectId, onHeaders: (response) => { serverResponse = response; entered(); } };
  return {
    headers, response: () => serverResponse,
    release: () => { serverResponse?.uncork(); },
    clear: () => { heldServerRange = null; serverResponse?.uncork(); },
  };
}
async function boundedBarrier<T>(promise: Promise<T>, label: string, timeoutMs = 25_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test('HEVC proxy is H264/AAC, seekable, source-preserving and reused on reopen', async () => {
  const project = await seed('hevc'); const before = await fs.readFile(path.join(config.uploadDir, project.media.filename));
  assert.equal((await mediaPreviewStatus(project)).videoCodec, 'hevc');
  const start = await post(project); assert.equal(start.status, 202);
  assert.throws(() => jobAdmission.beginUpdate(() => false));
  const state = await terminal(project); assert.equal(state.state, 'ready', state.message);
  assert.ok(state.url);
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${state.url}`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 100); assert.match(response.headers.get('content-range')!, /^bytes 0-99\//);
  const file = await mediaPreviewFile(project, state.url!.split('/').at(-1)!);
  const raw = JSON.parse(execFileSync(config.ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(file.dir, file.filename)], { encoding: 'utf8' }));
  assert.deepEqual(raw.streams.map((s: any) => s.codec_name), ['h264', 'aac']);
  assert.ok(Math.abs(Number(raw.format.duration) - 2) < 0.15);
  assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), before);
  assert.deepEqual((await store.get(project.id))?.captions, project.captions);
  const mtime = (await fs.stat(path.join(file.dir, file.filename))).mtimeMs;
  assert.equal((await startMediaPreview(project)).state, 'ready');
  assert.equal((await fs.stat(path.join(file.dir, file.filename))).mtimeMs, mtime);
  jobAdmission.beginUpdate(() => false)();
});

test('silent video stays silent; replacement invalidates URL and cancels old work', async () => {
  const project = await seed('silent', 'libx264', false);
  await startMediaPreview(project); const state = await terminal(project); assert.equal(state.state, 'ready', state.message);
  const oldUrl = state.url!;
  await invalidateProjectCache(project.id);
  const old = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${oldUrl}`); assert.equal(old.status, 404);
  await startMediaPreview(project);
  await invalidateProjectCache(project.id);
  assert.equal((await mediaPreviewStatus(project)).state, 'original');
  assert.equal(await fs.stat(path.join(config.cacheDir, 'media-previews', project.id)).then(() => true, () => false), false);
});

test('cancel removes partial files, releases admission, and retry remains available', async () => {
  const project = await seed('cancel');
  await startMediaPreview(project);
  const cancelled = await cancelMediaPreview(project); assert.equal(cancelled.state, 'cancelled');
  assert.equal(await fs.stat(path.join(config.cacheDir, 'media-previews', project.id)).then(() => true, () => false), false);
  jobAdmission.beginUpdate(() => false)();
  await startMediaPreview(project); assert.equal((await terminal(project)).state, 'ready');
});

test('bad paths, missing sources and stale browser requests fail closed', async () => {
  const project = await seed('paths');
  await assert.rejects(mediaPreviewStatus({ ...project, id: '../outside' }));
  await assert.rejects(mediaPreviewStatus({ ...project, media: { ...project.media, filename: '../secret.mp4' } }));
  const stale = await fetch(`${url}/${project.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'old.mp4' }) });
  assert.equal(stale.status, 409);
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(config.uploadDir, project.media.filename), path.join(config.uploadDir, 'linked.mp4'));
    await assert.rejects(mediaPreviewStatus({ ...project, media: { ...project.media, filename: 'linked.mp4' } }));
  }
});

test('preview POST cannot admit work while media change owns the project', async () => {
  const project = await seed('preview-post-replacement-race');
  let release!: () => void; let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const admissionHeld = new Promise<void>((resolve) => { entered = resolve; });
  const change = jobAdmission.changeProjectMedia(project.id, () => false, async () => {
    entered(); await barrier;
  });
  try {
    await boundedBarrier(admissionHeld, 'media-change admission');
    const rejected = await post(project);
    assert.equal(rejected.status, 409);
    assert.match((await rejected.json() as { error: string }).error, /replacing or restoring its media/i);
    assert.equal(await fs.stat(path.join(config.cacheDir, 'media-previews', project.id))
      .then(() => true, () => false), false, 'rejected POST started no encoder or cache');
  } finally { release(); await change; }
  const admitted = await post(project);
  assert.equal(admitted.status, 202);
  assert.equal((await terminal(project)).state, 'ready');
});

test('pre-deletion preparation cancellation does not require a readable project or source', async () => {
  await cancelMediaPreviewPreparation('no-project-or-source-needed');
  const project = await seed('offline-delete-cancellation');
  await fs.rm(path.join(config.uploadDir, project.media.filename));
  await cancelMediaPreviewPreparation(project.id);
  assert.ok(await store.get(project.id), 'the helper does not modify project state');
});

test('source bytes replaced in place invalidate completed proxy identity', async () => {
  const project = await seed('samepath'); await startMediaPreview(project); const before = await terminal(project);
  const source = path.join(config.uploadDir, project.media.filename); const stat = await fs.stat(source); await fs.utimes(source, stat.atime, new Date(stat.mtimeMs + 3000));
  await assert.rejects(mediaPreviewFile(project, before.url!.split('/').at(-1)!));
  assert.equal((await mediaPreviewStatus(project)).state, 'original');
});

test('process absolute deadline and cancellation stop a continuously noisy child', async () => {
  const controller = new AbortController(); const started = Date.now();
  await assert.rejects(previewProcess(process.execPath, ['-e', 'setInterval(()=>process.stdout.write("tick\\n"),5)'], controller.signal, 100, () => {}));
  assert.ok(Date.now() - started < 2500);
  const abort = new AbortController(); const work = previewProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], abort.signal, 30_000);
  setTimeout(() => abort.abort(), 30); await assert.rejects(work, /cancelled/);
});

test('codec detection honors actual browser HEVC capability and leaves H264 unchanged', () => {
  assert.equal(needsCompatiblePlayback('hevc', () => ''), true);
  assert.equal(needsCompatiblePlayback('h265', () => 'probably'), false);
  assert.equal(needsCompatiblePlayback('h264', () => ''), false);
});

test('cancellation during atomic publication cannot advertise a deleted ready file', async () => {
  const project = await seed('publishcancel');
  const originalRename = fs.rename;
  let entered!: () => void; let release!: () => void;
  const atPublish = new Promise<void>((r) => { entered = r; });
  const barrier = new Promise<void>((r) => { release = r; });
  fs.rename = async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[0]).endsWith('.part.mp4')) { entered(); await barrier; }
    return originalRename(...args);
  };
  try {
    await startMediaPreview(project);
    await atPublish;
    const cancellation = cancelMediaPreview(project);
    release();
    assert.equal((await cancellation).state, 'cancelled');
    assert.equal((await mediaPreviewStatus(project)).state, 'cancelled');
    assert.equal(await fs.stat(path.join(config.cacheDir, 'media-previews', project.id)).then(() => true, () => false), false);
  } finally { release(); fs.rename = originalRename; }
});

test('nonzero source timestamps and VFR frame positions stay on the original caption clock', async () => {
  const original = await seed('timeline', 'libx264');
  const originalPath = path.join(config.uploadDir, original.media.filename);
  const shiftedPath = path.join(config.uploadDir, 'shifted.mp4');
  execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-itsoffset', '1', '-i', originalPath, '-c', 'copy', shiftedPath], { timeout: 30_000 });
  const project = { ...original, id: 'shifted', media: { ...original.media, filename: 'shifted.mp4', size: (await fs.stat(shiftedPath)).size } };
  const frames = (file: string) => JSON.parse(execFileSync(config.ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file], { encoding: 'utf8' })).frames.map((frame: any) => Number(frame.best_effort_timestamp_time));
  const inputFrames = frames(shiftedPath); assert.equal(inputFrames[0], 1);
  await startMediaPreview(project); const state = await terminal(project); assert.equal(state.state, 'ready', state.message);
  const file = await mediaPreviewFile(project, state.url!.split('/').at(-1)!);
  assert.deepEqual(frames(path.join(file.dir, file.filename)), inputFrames);
  const vfrPath = path.join(config.uploadDir, 'vfr.mp4');
  execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', originalPath, '-vf', "select='not(mod(n,3))+not(mod(n,5))'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', vfrPath], { timeout: 30_000 });
  const vfr = { ...original, id: 'vfr', media: { ...original.media, filename: 'vfr.mp4', size: (await fs.stat(vfrPath)).size } };
  await startMediaPreview(vfr); const vfrState = await terminal(vfr); assert.equal(vfrState.state, 'ready', vfrState.message);
  const vfrFile = await mediaPreviewFile(vfr, vfrState.url!.split('/').at(-1)!);
  assert.deepEqual(frames(path.join(vfrFile.dir, vfrFile.filename)), frames(vfrPath));
});

test('active copies survive cache pressure while cold copies are evicted within the bound', async () => {
  const active = await seed('active-cache'); await startMediaPreview(active); const status = await terminal(active);
  const filename = status.url!.split('/').at(-1)!;
  const cache = path.join(config.cacheDir, 'media-previews');
  const cold: string[] = [];
  for (let i = 0; i < 5; i++) {
    const dir = path.join(cache, `cold-${i}`); cold.push(dir); await fs.mkdir(dir, { recursive: true });
    const file = await fs.open(path.join(dir, 'sparse.mp4'), 'w'); await file.truncate(512 * 1024 * 1024); await file.close();
  }
  const next = await seed('cache-next'); await startMediaPreview(next); assert.equal((await terminal(next)).state, 'ready');
  assert.ok(await mediaPreviewFile(active, filename));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${status.url}`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 100);
  const kept = await Promise.all(cold.map((dir) => fs.stat(dir).then(() => true, () => false)));
  assert.ok(kept.filter(Boolean).length < cold.length);
  for (const dir of cold) await fs.rm(dir, { recursive: true, force: true });
});

test('force rebuilding preserves the published copy until replacement and through cancellation', async () => {
  const project = await seed('rebuild'); await startMediaPreview(project); const status = await terminal(project);
  const filename = status.url!.split('/').at(-1)!;
  await startMediaPreview(project, { force: true });
  assert.ok(await mediaPreviewFile(project, filename));
  await cancelMediaPreview(project);
  assert.ok(await mediaPreviewFile(project, filename));
  assert.equal((await mediaPreviewStatus(project)).state, 'ready');
});

test('expired leases permit eviction but an in-flight range remains pinned; cache stays bounded', async () => {
  const { retainMediaPreview } = await import('../apps/server/src/services/media-preview.js');
  const project = await seed('pinned'); await startMediaPreview(project); const status = await terminal(project);
  const release = retainMediaPreview(project.id, status.url!.split('/').at(-1)!);
  const realNow = Date.now;
  const cache = path.join(config.cacheDir, 'media-previews');
  const fill = async () => { for (let i = 0; i < 65; i++) { const dir = path.join(cache, `count-${i}`); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'empty'), ''); } };
  const next = await seed('expiry-next');
  try {
    Date.now = () => realNow() + 180_000;
    await fill(); await startMediaPreview(next); assert.equal((await terminal(next)).state, 'ready');
    assert.ok(await fs.stat(path.join(cache, project.id, status.url!.split('/').at(-1)!)));
    assert.ok((await fs.readdir(cache)).length <= 64);
    release();
    await fill();
    const old = new Date(0); await fs.utimes(path.join(cache, project.id, 'ready.json'), old, old); await fs.utimes(path.join(cache, project.id, status.url!.split('/').at(-1)!), old, old);
    await startMediaPreview(next, { force: true }); assert.equal((await terminal(next)).state, 'ready');
    await assert.rejects(mediaPreviewFile(project, status.url!.split('/').at(-1)!));
  } finally { release(); Date.now = realNow; for (let i = 0; i < 65; i++) await fs.rm(path.join(cache, `count-${i}`), { recursive: true, force: true }); }
});

test('a copy being evicted cannot be reacquired or advertised ready', async () => {
  const project = await seed('eviction-overlap'); await startMediaPreview(project); await terminal(project);
  const next = await seed('eviction-overlap-next');
  const dir = path.join(config.cacheDir, 'media-previews', project.id);
  const cache = path.dirname(dir);
  const originalRm = fs.rm; const originalNow = Date.now;
  let entered!: () => void, release!: () => void;
  const barrier = new Promise<void>((r) => { release = r; });
  const atDelete = new Promise<void>((r) => { entered = r; });
  fs.rm = async (...args: Parameters<typeof fs.rm>) => { if (args[0] === dir) { entered(); await barrier; } return originalRm(...args); };
  try {
    Date.now = () => originalNow() + 180_000;
    for (const file of await fs.readdir(dir)) await fs.utimes(path.join(dir, file), new Date(0), new Date(0));
    for (let i = 0; i < 65; i++) await fs.mkdir(path.join(cache, `overlap-${i}`), { recursive: true });
    await startMediaPreview(next); await atDelete;
    assert.equal((await mediaPreviewStatus(project)).state, 'original');
    await assert.rejects(startMediaPreview(project), /being refreshed/);
    release(); assert.equal((await terminal(next)).state, 'ready');
  } finally {
    release(); fs.rm = originalRm; Date.now = originalNow;
    for (let i = 0; i < 65; i++) await fs.rm(path.join(cache, `overlap-${i}`), { recursive: true, force: true });
  }
});

test('a rebuild clears abandoned stages and obsolete signatures but retains its publication', async () => {
  const project = await seed('orphan-cleanup'); await startMediaPreview(project); const status = await terminal(project);
  const dir = path.join(config.cacheDir, 'media-previews', project.id);
  for (const name of ['abandoned.part.mp4', 'obsolete.mp4', 'ready.abandoned.tmp']) {
    const file = await fs.open(path.join(dir, name), 'w'); await file.truncate(512 * 1024 * 1024); await file.close();
  }
  await startMediaPreview(project, { force: true }); const rebuilt = await terminal(project);
  assert.equal(rebuilt.state, 'ready');
  const previous = status.url!.split('/').at(-1)!;
  const next = rebuilt.url!.split('/').at(-1)!;
  assert.notEqual(next, previous, 'a rebuilt publication has a different immutable URL');
  assert.deepEqual((await fs.readdir(dir)).sort(),
    [previous, next, `${previous}.json`, `${next}.json`, 'ready.json'].sort(),
    'only validated current/retired generations and their pointer remain');
});

test('a failed forced rebuild keeps the old copy available but never claims the rebuild succeeded', async () => {
  const project = await seed('failed-rebuild'); await startMediaPreview(project); const before = await terminal(project);
  const ffmpeg = config.ffmpegPath;
  try {
    config.ffmpegPath = path.join(root, 'nonexistent-ffmpeg');
    await startMediaPreview(project, { force: true }); const after = await terminal(project);
    assert.equal(after.state, 'ready'); assert.equal(after.url, before.url);
    assert.match(after.message!, /new playback copy could not be prepared/);
    assert.ok(await mediaPreviewFile(project, before.url!.split('/').at(-1)!));
  } finally { config.ffmpegPath = ffmpeg; }
});

test('a forced rebuild publishes a new URL without changing old Content-Length or later byte ranges', async () => {
  const project = await seed('immutable-generation');
  const sourcePath = path.join(config.uploadDir, project.media.filename);
  const sourceBefore = await fs.readFile(sourcePath);
  await startMediaPreview(project); const original = await terminal(project);
  const previousFilename = original.url!.split('/').at(-1)!;
  const oldSize = 64 * 1024 * 1024;
  const tail = await makeLargeSyntheticCopy(project, original, oldSize);
  const oldHead = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${original.url}`, { method: 'HEAD' });
  assert.equal(oldHead.status, 200);
  assert.equal(oldHead.headers.get('content-length'), String(oldSize));
  assert.equal((await oldHead.arrayBuffer()).byteLength, 0);

  await startMediaPreview(project, { force: true }); const next = await terminal(project);
  assert.equal(next.state, 'ready', next.message);
  assert.notEqual(next.url, original.url);
  const nextFilename = next.url!.split('/').at(-1)!;
  assert.match(nextFilename, /^[a-f0-9]{64}\.[a-f0-9]{32}\.mp4$/);
  assert.equal((await fs.stat(previewPath(project, original))).size, oldSize);
  const newSize = (await fs.stat(previewPath(project, next))).size;
  assert.notEqual(newSize, oldSize);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [href, length] of [[original.url!, oldSize], [next.url!, newSize]] as const) {
    const head = await fetch(`${base}${href}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const range = await fetch(`${base}${href}`, { headers: { Range: 'bytes=100-199' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 100-199/${length}`);
    assert.equal((await range.arrayBuffer()).byteLength, 100);
  }
  const endRange = await fetch(`${base}${original.url}`, { headers: { Range: `bytes=${oldSize - tail.length}-${oldSize - 1}` } });
  assert.equal(endRange.status, 206);
  assert.deepEqual(Buffer.from(await endRange.arrayBuffer()), tail);
  assert.deepEqual(await fs.readFile(sourcePath), sourceBefore, 'compatible rebuild cannot change the original recording');
  assert.deepEqual((await store.get(project.id))?.captions, project.captions);
  assert.equal((await fs.readdir(path.dirname(previewPath(project, next)))).includes(`${previousFilename}.json`), true,
    'legacy or retired URLs have validated independent metadata');
});

test('an actual paused HTTP range pins its generation until abort, then expires for eviction', async () => {
  const project = await seed('held-http-range'); await startMediaPreview(project); const state = await terminal(project);
  const size = 64 * 1024 * 1024;
  await makeLargeSyntheticCopy(project, state, size);
  const gate = holdServerRange(project.id);
  const held = openHeldRange(`http://127.0.0.1:${(server.address() as AddressInfo).port}${state.url}`, size - 1);
  let response: http.IncomingMessage | undefined;
  const realNow = Date.now;
  const cache = path.join(config.cacheDir, 'media-previews');
  const pressure = async () => {
    for (let i = 0; i < 65; i++) {
      const dir = path.join(cache, `http-pressure-${i}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'tiny'), 'x');
    }
  };
  try {
    await boundedBarrier(gate.headers, 'server range response headers');
    response = await held.response;
    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-length'], String(size));
    assert.equal(response.complete, false, 'client response remains in flight');
    assert.equal(gate.response()?.writableEnded, false, 'server response is explicitly corked and still owns the reader');
    const next = await seed('held-http-range-next');
    Date.now = () => realNow() + 180_000;
    await pressure();
    await startMediaPreview(next); assert.equal((await terminal(next)).state, 'ready');
    assert.ok(await fs.stat(previewPath(project, state)), 'in-flight HTTP response survives an expired lease and cache pressure');
    assert.equal(response.complete, false);
    assert.equal(gate.response()?.writableEnded, false);
    const closed = new Promise<void>((resolve) => response!.once('close', resolve));
    held.request().destroy(); response.destroy();
    gate.release();
    await boundedBarrier(closed, 'client range close');
    const old = new Date(0);
    for (const file of await fs.readdir(path.dirname(previewPath(project, state)))) {
      await fs.utimes(path.join(path.dirname(previewPath(project, state)), file), old, old);
    }
    await pressure();
    await startMediaPreview(next, { force: true }); assert.equal((await terminal(next)).state, 'ready');
    await assert.rejects(fs.stat(previewPath(project, state)), { code: 'ENOENT' }, 'released and expired copy is now evictable');
  } finally {
    gate.clear(); held.request().destroy(); response?.destroy();
    Date.now = realNow;
    for (let i = 0; i < 65; i++) await fs.rm(path.join(cache, `http-pressure-${i}`), { recursive: true, force: true });
  }
});

test('source-cache invalidation closes an in-flight range before Windows-safe removal', async () => {
  const project = await seed('invalidation-http'); await startMediaPreview(project); const state = await terminal(project);
  const sourceBefore = await fs.readFile(path.join(config.uploadDir, project.media.filename));
  const projectBefore = await store.get(project.id);
  const size = 64 * 1024 * 1024;
  await makeLargeSyntheticCopy(project, state, size);
  const gate = holdServerRange(project.id);
  const held = openHeldRange(`http://127.0.0.1:${(server.address() as AddressInfo).port}${state.url}`, size - 1);
  let response: http.IncomingMessage | undefined;
  try {
    await boundedBarrier(gate.headers, 'invalidation range response headers');
    response = await held.response;
    assert.equal(response.complete, false, 'real HTTP range stays open during invalidation');
    assert.equal(gate.response()?.writableEnded, false, 'server response still owns the open reader');
    await invalidateProjectCache(project.id);
    assert.equal(await fs.stat(path.dirname(previewPath(project, state))).then(() => true, () => false), false);
    assert.equal(gate.response()?.destroyed, true);
    assert.deepEqual(await store.get(project.id), projectBefore, 'cache invalidation never changes saved project state');
    assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), sourceBefore);
    assert.equal((await mediaPreviewStatus(project)).state, 'original');
  } finally { gate.clear(); held.request().destroy(); response?.destroy(); }
});

test('failed pointer publication after writing new video retains the old complete copy', async () => {
  const project = await seed('pointer-failure'); await startMediaPreview(project); const before = await terminal(project);
  const dir = path.dirname(previewPath(project, before));
  const previousBytes = await fs.readFile(previewPath(project, before));
  const pointerBefore = await fs.readFile(path.join(dir, 'ready.json'));
  const originalRename = fs.rename;
  let blocked = 0;
  fs.rename = async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === path.join(dir, 'ready.json')) {
      blocked++;
      throw Object.assign(new Error('Synthetic pointer rename failure'), { code: 'EPERM' });
    }
    return originalRename(...args);
  };
  try {
    await startMediaPreview(project, { force: true }); const result = await terminal(project);
    assert.equal(blocked, 1);
    assert.equal(result.state, 'ready');
    assert.equal(result.url, before.url, 'the old pointer remains authoritative after failed commit');
    assert.match(result.message!, /previous copy was kept/);
    assert.deepEqual(await fs.readFile(path.join(dir, 'ready.json')), pointerBefore);
    assert.deepEqual(await fs.readFile(previewPath(project, before)), previousBytes);
    const videos = (await fs.readdir(dir)).filter((name) => name.endsWith('.mp4'));
    assert.deepEqual(videos, [before.url!.split('/').at(-1)!], 'uncommitted video generation is cleaned up');
  } finally { fs.rename = originalRename; }
});

test('cancel during final source identity read cannot commit a newer generation', async () => {
  const project = await seed('late-identity-cancel'); await startMediaPreview(project); const before = await terminal(project);
  const dir = path.dirname(previewPath(project, before));
  const pointerBefore = await fs.readFile(path.join(dir, 'ready.json'));
  const sourceFile = path.join(config.uploadDir, project.media.filename);
  const originalRename = fs.rename;
  const originalLstat = fs.lstat;
  let newBytesPublished = false;
  let blocked = false;
  let release!: () => void; let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const atFinalIdentity = new Promise<void>((resolve) => { entered = resolve; });
  fs.rename = async (...args: Parameters<typeof fs.rename>) => {
    const result = await originalRename(...args);
    if (String(args[0]).endsWith('.part.mp4') && String(args[1]).startsWith(dir)) newBytesPublished = true;
    return result;
  };
  // Keep the original Stats/BigIntStats overloads while forwarding all options.
  fs.lstat = new Proxy(originalLstat, { async apply(target, receiver, args) {
    if (newBytesPublished && !blocked && String(args[0]) === sourceFile) {
      blocked = true; entered(); await barrier;
    }
    return Reflect.apply(target, receiver, args);
  } });
  try {
    await startMediaPreview(project, { force: true });
    await boundedBarrier(atFinalIdentity, 'last source identity check');
    const cancelling = cancelMediaPreview(project);
    release();
    assert.equal((await cancelling).state, 'cancelled');
    assert.equal((await mediaPreviewStatus(project)).url, before.url);
    assert.deepEqual(await fs.readFile(path.join(dir, 'ready.json')), pointerBefore);
    assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.mp4')), [before.url!.split('/').at(-1)!]);
  } finally { release(); fs.lstat = originalLstat; fs.rename = originalRename; }
});

test('cancel after atomic pointer rename reports ready and preserves both generations', async () => {
  const project = await seed('late-publication-cancel'); await startMediaPreview(project); const before = await terminal(project);
  const dir = path.dirname(previewPath(project, before));
  const originalRename = fs.rename;
  let release!: () => void; let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const afterCommit = new Promise<void>((resolve) => { entered = resolve; });
  fs.rename = async (...args: Parameters<typeof fs.rename>) => {
    const result = await originalRename(...args);
    if (String(args[1]) === path.join(dir, 'ready.json')) { entered(); await barrier; }
    return result;
  };
  try {
    await startMediaPreview(project, { force: true });
    await boundedBarrier(afterCommit, 'atomic pointer commit');
    const cancelling = cancelMediaPreview(project);
    release();
    const result = await cancelling;
    assert.equal(result.state, 'ready', 'a completed pointer rename cannot be rolled back by late cancellation');
    assert.notEqual(result.url, before.url);
    assert.equal((await mediaPreviewStatus(project)).url, result.url);
    assert.ok(await mediaPreviewFile(project, before.url!.split('/').at(-1)!));
    const oldRange = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${before.url}`, { headers: { Range: 'bytes=0-49' } });
    assert.equal(oldRange.status, 206);
    assert.equal((await oldRange.arrayBuffer()).byteLength, 50);
  } finally { release(); fs.rename = originalRename; }
});

test('legacy signature-only URLs remain readable after the first immutable-generation migration', async () => {
  const project = await seed('legacy-migration'); await startMediaPreview(project); const initial = await terminal(project);
  const dir = path.dirname(previewPath(project, initial));
  const previous = initial.url!.split('/').at(-1)!;
  const signature = previous.slice(0, 64);
  const legacy = `${signature}.mp4`;
  const pointer = JSON.parse(await fs.readFile(path.join(dir, 'ready.json'), 'utf8'));
  await fs.rename(path.join(dir, previous), path.join(dir, legacy));
  await fs.rm(path.join(dir, `${previous}.json`), { force: true });
  await fs.writeFile(path.join(dir, 'ready.json'), JSON.stringify({
    signature, size: pointer.size, videoCodec: pointer.videoCodec,
  }));
  const oldUrl = `/api/media-preview/${project.id}/file/${legacy}`;
  assert.ok(await mediaPreviewFile(project, legacy));
  await startMediaPreview(project, { force: true }); const rebuilt = await terminal(project);
  assert.equal(rebuilt.state, 'ready');
  assert.notEqual(rebuilt.url, oldUrl);
  assert.ok(await fs.stat(path.join(dir, legacy)));
  assert.ok(await fs.stat(path.join(dir, `${legacy}.json`)), 'first rebuild migrates old metadata into a retired sidecar');
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${oldUrl}`, { headers: { Range: 'bytes=20-39' } });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 20);
});

test('expired retired generation is reclaimed before an active current copy under the disk bound', async () => {
  const project = await seed('retired-budget'); await startMediaPreview(project); const old = await terminal(project);
  await makeLargeSyntheticCopy(project, old, 400 * 1024 * 1024);
  await startMediaPreview(project, { force: true }); const current = await terminal(project);
  assert.notEqual(current.url, old.url);
  const cache = path.join(config.cacheDir, 'media-previews');
  const fake: string[] = [];
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 180_000;
    // Renew only the latest generation, leaving the previous one expired.
    assert.ok(await mediaPreviewFile(project, current.url!.split('/').at(-1)!));
    for (let i = 0; i < 3; i++) {
      const dir = path.join(cache, `retired-budget-pressure-${i}`);
      fake.push(dir); await fs.mkdir(dir, { recursive: true });
      const handle = await fs.open(path.join(dir, 'sparse'), 'w');
      await handle.truncate(512 * 1024 * 1024); await handle.close();
    }
    const next = await seed('retired-budget-next');
    await startMediaPreview(next); assert.equal((await terminal(next)).state, 'ready');
    await assert.rejects(fs.stat(previewPath(project, old)), { code: 'ENOENT' });
    assert.ok(await fs.stat(previewPath(project, current)), 'current-generation lease survives retired eviction');
    const copyRoot = await fs.readdir(cache, { withFileTypes: true });
    let bytes = 0;
    for (const directory of copyRoot) if (directory.isDirectory()) {
      for (const file of await fs.readdir(path.join(cache, directory.name), { withFileTypes: true })) {
        if (file.isFile()) bytes += (await fs.stat(path.join(cache, directory.name, file.name))).size;
      }
    }
    assert.ok(bytes <= 2 * 1024 * 1024 * 1024, 'retired files remain inside the global 2 GiB budget');
  } finally {
    Date.now = realNow;
    for (const dir of fake) await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a failed HEAD lookup cannot erase another paused player lease', async () => {
  const project = await seed('failed-heartbeat'); await startMediaPreview(project); const current = await terminal(project);
  const dir = path.dirname(previewPath(project, current));
  const filename = current.url!.split('/').at(-1)!;
  const manifestPath = path.join(dir, 'ready.json');
  const sidecarPath = path.join(dir, `${filename}.json`);
  const manifest = await fs.readFile(manifestPath);
  const sidecar = await fs.readFile(sidecarPath);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cache = path.join(config.cacheDir, 'media-previews');
  const fake: string[] = [];
  const realNow = Date.now;
  try {
    await fs.rm(sidecarPath);
    await fs.writeFile(manifestPath, '{"broken":');
    const failed = await fetch(`${base}${current.url}`, { method: 'HEAD' });
    assert.equal(failed.status, 404);
    await fs.writeFile(manifestPath, manifest); await fs.writeFile(sidecarPath, sidecar);
    const oldest = new Date(0);
    for (const file of await fs.readdir(dir)) await fs.utimes(path.join(dir, file), oldest, oldest);
    Date.now = () => realNow() + 30_000;
    for (let i = 0; i < 65; i++) {
      const dir = path.join(cache, `heartbeat-pressure-${i}`); fake.push(dir);
      await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'tiny'), 'x');
    }
    const next = await seed('heartbeat-pressure-next'); await startMediaPreview(next);
    assert.equal((await terminal(next)).state, 'ready');
    assert.ok(await fs.stat(previewPath(project, current)),
      'failed validation did not erase the previously granted paused-player lease');
  } finally {
    Date.now = realNow;
    await fs.writeFile(manifestPath, manifest); await fs.writeFile(sidecarPath, sidecar);
    for (const dir of fake) await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a retired-file HEAD succeeds without waiting for a blocked current-file metadata read', async () => {
  const project = await seed('independent-file-lease');
  await startMediaPreview(project); const retired = await terminal(project);
  await startMediaPreview(project, { force: true }); const current = await terminal(project);
  assert.notEqual(retired.url, current.url);
  const currentFile = previewPath(project, current);
  const originalLstat = fs.lstat;
  let currentReads = 0;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  fs.lstat = new Proxy(originalLstat, { async apply(target, receiver, args) {
    if (String(args[0]) === currentFile) { currentReads++; await blocked; }
    return Reflect.apply(target, receiver, args);
  } });
  const abort = new AbortController();
  try {
    const head = await boundedBarrier(
      fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${retired.url}`,
        { method: 'HEAD', signal: abort.signal }),
      'retired-file HEAD independent of current-file lstat', 4_000);
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(currentReads, 0, 'retired-file access must not probe or renew the current video generation');
  } finally {
    unblock(); abort.abort(); fs.lstat = originalLstat;
  }
});
