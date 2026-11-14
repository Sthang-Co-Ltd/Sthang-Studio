import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-project-upload-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { config } = await import('../apps/server/src/config.js');
// The actual router captures this isolated limit at import. No large media fixture
// or public/environment configuration change is needed to exercise Multer.
config.maxUploadMb = 1024 / (1024 * 1024);
const { default: projects } = await import('../apps/server/src/routes/projects.js');
const { store } = await import('../apps/server/src/services/store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
await store.list();
const sentinel = path.join(config.uploadDir, 'unrelated-saved-source.wav');
await fs.writeFile(sentinel, 'Existing source must remain unchanged');
let incomingRequest: express.Request | null = null;
const app = express();
app.use((req, _res, next) => { incomingRequest = req; next(); });
app.use('/api/projects', projects);
// An error escaping the creation middleware is a test failure, not a safe API
// response supplied by this harness.
let escapedErrors = 0;
app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  escapedErrors++;
  res.status(599).json({ error: 'Unexpected test middleware escape' });
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const endpoint = `${origin}/api/projects`;
let sequence = 0;
const ids = new Set<string>();
const token = () => {
  const id = `upload_${String(++sequence).padStart(32, '0')}`;
  ids.add(id);
  return id;
};
function form(id: string, bytes = 64) {
  const body = new FormData();
  body.append('media', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'synthetic.wav');
  body.append('title', 'Synthetic import');
  body.append('creationAttemptId', id);
  body.append('lastModified', '1767225600000');
  return body;
}
const files = async () => (await fs.readdir(config.uploadDir)).sort();
const projectIds = async () => (await store.list()).map((project) => project.id).sort();
async function waitFor(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}
async function assertUnchanged(beforeFiles: string[], beforeProjects: string[]) {
  assert.deepEqual(await files(), beforeFiles);
  assert.deepEqual(await projectIds(), beforeProjects);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'Existing source must remain unchanged');
  assert.equal(escapedErrors, 0);
}
afterEach(() => { for (const id of ids) cancelScheduledProjectPrewarm(id); });
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test('actual multipart size rejection is definitely unapplied, safe and removes only its staging file', async () => {
  const id = token();
  const beforeFiles = await files();
  const beforeProjects = await projectIds();
  const response = await fetch(endpoint, { method: 'POST', body: form(id, 1025) });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.code, 'PROJECT_CREATE_NOT_APPLIED');
  assert.equal(body.outcome, 'not-created');
  assert.equal(body.retryable, false);
  assert.match(body.error, /too large.*1,024 bytes/);
  assert.equal(JSON.stringify(body).includes(root), false);
  assert.equal(await store.get(id), null);
  await assertUnchanged(beforeFiles, beforeProjects);
});

test('a second unexpected file rejects before creation and cleans the already accepted incoming file', async () => {
  const id = token();
  const beforeFiles = await files();
  const beforeProjects = await projectIds();
  const body = form(id);
  body.append('PRIVATE_FIELD_NAME', new Blob(['private fixture'], { type: 'audio/wav' }), 'PRIVATE_FILENAME.wav');
  const response = await fetch(endpoint, { method: 'POST', body });
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.code, 'PROJECT_CREATE_NOT_APPLIED');
  assert.equal(result.outcome, 'not-created');
  assert.equal(result.retryable, false);
  assert.match(result.error, /one video or audio file/);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  await assertUnchanged(beforeFiles, beforeProjects);
});

test('a bounded metadata rejection removes an earlier accepted file without exposing its field content', async () => {
  const id = token();
  const beforeFiles = await files();
  const beforeProjects = await projectIds();
  const body = form(id);
  body.set('title', 'PRIVATE_FIELD_CONTENT'.repeat(60_000));
  const response = await fetch(endpoint, { method: 'POST', body });
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.code, 'PROJECT_CREATE_NOT_APPLIED');
  assert.equal(result.outcome, 'not-created');
  assert.equal(result.retryable, false);
  assert.match(result.error, /upload details could not be read/);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  await assertUnchanged(beforeFiles, beforeProjects);
});

test('unclassified parser failure remains unknown and never exposes raw parser details', async () => {
  const beforeFiles = await files();
  const beforeProjects = await projectIds();
  const response = await fetch(endpoint, { method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data' }, body: 'PRIVATE_MALFORMED_BODY' });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, 'PROJECT_CREATE_UNCONFIRMED');
  assert.equal(body.outcome, 'unknown');
  assert.equal(body.retryable, undefined);
  assert.match(body.error, /Check the saved result/);
  assert.equal(JSON.stringify(body).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(body).includes('Boundary'), false);
  await assertUnchanged(beforeFiles, beforeProjects);
});

test('incoming storage failure remains unknown, sanitizes local errors and removes only its partial file', async (t) => {
  const id = token();
  const beforeFiles = await files();
  const beforeProjects = await projectIds();
  const original = nodeFs.createWriteStream;
  const fault = t.mock.method(nodeFs, 'createWriteStream', (...args: Parameters<typeof nodeFs.createWriteStream>) => {
    const stream = original(...args);
    if (path.dirname(String(args[0])) === config.uploadDir) {
      stream.once('open', () => stream.destroy(Object.assign(new Error(`PRIVATE_STORAGE_FAILURE ${root}`), { code: 'ENOSPC' })));
    }
    return stream;
  });
  try {
    const response = await fetch(endpoint, { method: 'POST', body: form(id) });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.code, 'PROJECT_CREATE_UNCONFIRMED');
    assert.equal(body.outcome, 'unknown');
    assert.equal(body.retryable, undefined);
    assert.equal(JSON.stringify(body).includes('PRIVATE_'), false);
    assert.equal(JSON.stringify(body).includes(root), false);
    assert.equal(await store.get(id), null);
    await assertUnchanged(beforeFiles, beforeProjects);
  } finally { fault.mock.restore(); }
});

test('an aborted incomplete multipart transfer cannot publish a project or return a false receipt', { timeout: 5000 }, async () => {
  const id = token();
  const beforeFiles = await files();
  const beforeProjects = await projectIds();
  const boundary = 'studio-abort-boundary';
  const prefix = [
    `--${boundary}\r\nContent-Disposition: form-data; name="creationAttemptId"\r\n\r\n${id}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="synthetic.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
  ].join('');
  let responseReceived = false;
  const request = http.request(`${endpoint}`, { method: 'POST', headers: {
    'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': '4096',
  } }, () => { responseReceived = true; });
  request.on('error', () => { /* Deliberate local client abort. */ });
  try {
    request.write(prefix);
    request.write(Buffer.alloc(512));
    await waitFor(async () => (await files()).some((name) => !beforeFiles.includes(name)), 'The test did not begin an incoming staging write');
    request.destroy(new Error('Synthetic client abort'));
    await waitFor(async () => incomingRequest?.aborted === true, 'The server did not observe the aborted request');
    await waitFor(async () => JSON.stringify(await files()) === JSON.stringify(beforeFiles), 'Multer did not clean aborted incoming staging');
    assert.equal(responseReceived, false);
    assert.equal(await store.get(id), null);
    await assertUnchanged(beforeFiles, beforeProjects);
  } finally { request.destroy(); }
});

test('an accepted boundary-size upload and exact attempt retry retain one project and source', async () => {
  const id = token();
  const first = await fetch(endpoint, { method: 'POST', body: form(id, 1024) });
  assert.equal(first.status, 201);
  const saved = await first.json();
  cancelScheduledProjectPrewarm(id);
  assert.equal(saved.id, id);
  assert.equal(saved.creation.reused, false);
  assert.equal(saved.media.size, 1024);
  const beforeRetryFiles = await files();
  const retry = await fetch(endpoint, { method: 'POST', body: form(id, 1024) });
  assert.equal(retry.status, 200);
  const reused = await retry.json();
  assert.equal(reused.id, id);
  assert.equal(reused.creation.reused, true);
  assert.equal(reused.media.filename, saved.media.filename);
  assert.deepEqual(await files(), beforeRetryFiles);
  assert.equal((await store.list()).filter((project) => project.id === id).length, 1);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'Existing source must remain unchanged');
  assert.equal(escapedErrors, 0);
});
