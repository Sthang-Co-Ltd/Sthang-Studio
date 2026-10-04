import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
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
const { previewProcess, mediaPreviewStatus, startMediaPreview, cancelMediaPreview, mediaPreviewFile } = await import('../apps/server/src/services/media-preview.js');
const { default: router } = await import('../apps/server/src/routes/media-preview.js');
const { needsCompatiblePlayback } = await import('../apps/web/src/media-preview-client.js');
const app = express(); app.use(express.json()); app.use('/api/media-preview', router);
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
