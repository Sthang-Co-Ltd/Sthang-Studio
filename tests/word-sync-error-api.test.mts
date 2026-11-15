import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { buildCaptionWordTiming, type CaptionSegment } from '@kcs/shared';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-word-sync-errors-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { createCaptionWordTimingHandler } = await import('../apps/server/src/routes/projects.js');
const { CaptionWordTimingInputError, CaptionWordTimingConflictError, CaptionWordTimingNotFoundError, CaptionWordTimingBusyError } =
  await import('../apps/server/src/services/caption-word-timing.js');
const { jobAdmission } = await import('../apps/server/src/services/job-admission.js');
let failure: Error | null = null;
let active = false;
let syncCalls = 0;
const handler = createCaptionWordTimingHandler({
  hasActiveCaptionJobForProject: () => active,
  syncCaptionWords: async (_id, caption) => {
    syncCalls++;
    if (failure) throw failure;
    const wordTiming = buildCaptionWordTiming(caption, [{ id: 'one', text: caption.text,
      startMs: caption.startMs + 20, endMs: caption.endMs - 20, spaceBefore: false, timingSource: 'stt' }]);
    assert.ok(wordTiming);
    return { basis: caption, wordTiming };
  },
});
const app = express();
app.use(express.json());
app.post('/api/projects/:id/caption-word-timing', handler);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/fixture/caption-word-timing`;
const caption: CaptionSegment = { id: 'one', text: 'hello', startMs: 100, endMs: 900 };
const post = () => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ caption, expectedMedia: { filename: 'fixture.mp4', size: 123 } }) });
afterEach(() => { failure = null; active = false; });
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test('an unclassified local timing failure is a sanitized systemic503 that a batch can pause on', async (t) => {
  failure = new Error(`PRIVATE worker output and local path ${root}`);
  const diagnostic = t.mock.method(console, 'error', () => {});
  try {
    const response = await post();
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'WORD_TIMING_UNAVAILABLE');
    assert.match(body.error, /Settings.*System check/);
    assert.match(body.error, /current timing was kept/);
    assert.equal(JSON.stringify(body).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(body).includes(root), false);
  } finally { diagnostic.mock.restore(); }
});

test('explicit per-caption input failure keeps its400 contract instead of claiming a setup outage', async () => {
  failure = new CaptionWordTimingInputError('Split this caption into shorter captions before syncing.');
  const response = await post(); assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, failure.message);
  assert.equal(body.code, undefined);
});

test('active project work and the update admission gate report a systemic busy code without starting alignment', async () => {
  const before = syncCalls;
  active = true;
  const projectBusy = await post(); assert.equal(projectBusy.status, 409);
  assert.equal((await projectBusy.json()).code, 'WORD_TIMING_PROJECT_BUSY');
  assert.equal(syncCalls, before);
  active = false;
  const release = jobAdmission.beginUpdate(() => false);
  try {
    const updating = await post(); assert.equal(updating.status, 409);
    assert.equal((await updating.json()).code, 'WORD_TIMING_PROJECT_BUSY');
    assert.equal(syncCalls, before);
  } finally { release(); }
});

test('caption/source conflicts, missing projects and the existing heavy-work gate retain their distinct statuses', async () => {
  for (const [error, status] of [
    [new CaptionWordTimingConflictError('The source media changed. Reload this project.'), 409],
    [new CaptionWordTimingNotFoundError('Project not found.'), 404],
    [new CaptionWordTimingBusyError(), 429],
  ] as const) {
    failure = error;
    const response = await post();
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error, error.message);
    assert.equal(body.code, undefined);
  }
});
