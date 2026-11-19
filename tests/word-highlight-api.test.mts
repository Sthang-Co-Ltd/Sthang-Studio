import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AlignWindowsRequest } from '../apps/server/src/services/local-timing.js';
import type { WordHighlightOutcome } from '../apps/server/src/services/word-highlight-engine.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sthang-word-highlight-api-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';

const { config } = await import('../apps/server/src/config.js');
const { createWordHighlightHandler } = await import('../apps/server/src/routes/projects.js');
const { createWordHighlightCandidateStore } = await import('../apps/server/src/services/word-highlight-candidate-store.js');
const { WordHighlightProjectError } = await import('../apps/server/src/services/word-highlight-engine.js');
const { LocalTimingUnavailableError, alignWindowsLocally, closeLocalTimingWorker } =
  await import('../apps/server/src/services/local-timing.js');

const expectedMedia = { filename: 'fixture.wav', size: 1 };
const track = {
  version: 1 as const, evidence: 2 as const, text: 'word', basis: 'basis',
  words: [{ id: 'cue:0-4', startOffset: 0, endOffset: 4, startMs: 100, endMs: 200, source: 'aligned' as const, method: 'kfa' as const }],
};
const entry = {
  projectId: 'fixture', mediaFingerprint: 'media-revision', captionId: 'cue', basis: 'basis',
  dependencies: { cue: 'before' }, inputRevisions: { cue: 'inputs' }, consulted: ['cue'],
  overlapping: [], planDurationMs: 1_000, evidenceDurationMs: 1_000, beforeTrack: null, track,
};
let busy = false;
let onAdmission = () => {};
let prepare = async (id: string, expected: typeof expectedMedia) => {
  if (id !== entry.projectId) throw new WordHighlightProjectError(404);
  if (expected.filename !== expectedMedia.filename || expected.size !== expectedMedia.size) throw new WordHighlightProjectError(409);
  return { ready: true as const, durationMs: 1_000, mediaFingerprint: entry.mediaFingerprint };
};
const candidateStore = createWordHighlightCandidateStore();
const deps = {
  hasActiveCaptionJobForProject: () => { onAdmission(); return busy; },
  candidateStore,
  engine: {
    prepare: (...args: Parameters<typeof prepare>) => prepare(...args),
    async candidates(id: string, expected: typeof expectedMedia, ids: string[]) {
      await prepare(id, expected);
      return {
        mediaFingerprint: entry.mediaFingerprint,
        results: ids.map((captionId): WordHighlightOutcome => ({
          id: captionId, diagnostics: { attempts: [] },
          ...(captionId === 'cue' ? { ...entry, status: 'candidate' } : { status: 'error' }),
        })),
      };
    },
  },
};
const app = express();
app.use(express.json());
app.post('/:id/caption-word-timing/prepare', createWordHighlightHandler('prepare', deps));
app.post('/:id/caption-word-timing/candidates', createWordHighlightHandler('candidates', deps));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(async () => {
  await closeLocalTimingWorker();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8 });
});
async function request(action: string, body: unknown, id = entry.projectId) {
  return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${id}/caption-word-timing/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('prepare and candidates return typed outcomes and reference only prepared candidates', async () => {
  const prepared = await request('prepare', { expectedMedia });
  assert.equal(prepared.status, 200);
  assert.deepEqual(await prepared.json(), { ready: true, durationMs: 1_000, mediaFingerprint: entry.mediaFingerprint });
  const response = await request('candidates', { expectedMedia, ids: ['cue', 'failed'] });
  assert.equal(response.status, 200);
  const { engine, results } = await response.json();
  assert.equal(engine, 'word-highlight-v1');
  assert.deepEqual(results.map(({ id, status }: WordHighlightOutcome) => [id, status]), [['cue', 'candidate'], ['failed', 'error']]);
  const stored = candidateStore.get(results[0].preparedKey);
  assert.ok(stored);
  const { createdAt, ...rest } = stored;
  assert.ok(Number.isFinite(createdAt));
  assert.deepEqual(rest, entry);
  assert.equal(results[1].preparedKey, undefined);
});

test('admission, body limits and typed unavailability guard both actions', async () => {
  for (const action of ['prepare', 'candidates']) {
    const body = { expectedMedia, ids: ['cue'] };
    assert.equal((await request(action, body, 'missing')).status, 404);
    assert.equal((await request(action, { ...body, expectedMedia: { ...expectedMedia, size: 2 } })).status, 409);
    assert.equal((await request(action, { ...body, extra: 'x'.repeat(16 * 1024) })).status, 413);
    assert.equal((await request(action, { ...body, expectedMedia: undefined })).status, 428);
    busy = true;
    try {
      const denied = await request(action, body);
      assert.equal(denied.status, 409);
      assert.equal((await denied.json()).code, 'WORD_TIMING_PROJECT_BUSY');
    } finally { busy = false; }

    const original = prepare;
    try {
      prepare = async () => { throw new LocalTimingUnavailableError(); };
      const missing = await request(action, body);
      assert.equal(missing.status, 503);
      assert.equal((await missing.json()).code, 'WORD_TIMING_UNAVAILABLE');
      prepare = async () => { throw new Error('Private fixture details'); };
      const failed = await request(action, body);
      assert.equal(failed.status, 500);
      assert.doesNotMatch(await failed.text(), /Private/);
    } finally { prepare = original; }
  }
  for (const ids of [[], ['cue', 'cue'], [' '], [4], Array.from({ length: 33 }, (_, index) => String(index))]) {
    assert.equal((await request('candidates', { expectedMedia, ids })).status, 400);
  }
});

test('a second request waits on the internal queue and checks the caption job again', { timeout: 10_000 }, async () => {
  const original = prepare;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();
  let calls = 0;
  prepare = async (...args) => {
    calls += 1;
    entered.resolve();
    await release.promise;
    return original(...args);
  };
  const first = request('prepare', { expectedMedia });
  let second: Promise<Response> | undefined;
  try {
    await entered.promise;
    onAdmission = queued.resolve;
    second = request('candidates', { expectedMedia, ids: ['cue'] });
    await queued.promise;
    assert.equal(calls, 1);
    busy = true;
    release.resolve();
    assert.equal((await first).status, 200);
    const response = await second;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'WORD_TIMING_PROJECT_BUSY');
    assert.equal(calls, 1);
  } finally {
    busy = false;
    onAdmission = () => {};
    release.resolve();
    await Promise.allSettled([first, second]);
    prepare = original;
  }
});

test('the candidate store caps bytes and project entries, evicts LRU, expires and invalidates', () => {
  let now = 1;
  const cache = createWordHighlightCandidateStore({ clock: () => now, ttlMs: 100, maxEntries: 2, maxProjectEntries: 1 });
  const first = cache.put(entry)!;
  const peer = cache.put({ ...entry, projectId: 'peer' })!;
  const second = cache.put(entry)!;
  assert.equal(cache.get(first), undefined);
  assert.notEqual(first, second);
  assert.ok(cache.get(peer)); // access orders peer after second
  const third = cache.put({ ...entry, projectId: 'third' })!;
  assert.equal(cache.get(second), undefined);
  const read = cache.get(third)!;
  read.track.words[0].startMs = 0;
  assert.equal(cache.get(third)!.track.words[0].startMs, 100);
  cache.invalidateProject('peer');
  assert.equal(cache.get(peer), undefined);
  assert.ok(cache.get(third));
  now += 100;
  assert.equal(cache.get(third), undefined);
  assert.equal(createWordHighlightCandidateStore({ maxBytes: 1 }).put(entry), undefined);
});

function pythonForFixture() {
  for (const [command, prefix] of [
    ...(process.env.STHANG_TEST_PYTHON ? [[process.env.STHANG_TEST_PYTHON, []] as const] : []),
    ...(process.platform === 'win32' ? [['py', ['-3.12']] as const] : []),
    ['python3', []] as const, ['python', []] as const,
  ]) {
    const probe = spawnSync(command, [...prefix, '-I', '-B', '-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
    });
    if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  }
  throw new Error('Python is required for the local timing transport fixture.');
}

test('Node retries a failed daemon transport through the one-shot CLI with identical request and results', async () => {
  const fixture = path.join(root, 'fixture-worker.py');
  const audio = path.join(root, 'fixture.wav');
  const requestFile = path.join(root, 'transport-request.json');
  const windowRequest: AlignWindowsRequest = {
    budgets: { maxIds: 512, maxCells: 1_000_000, maxCellsTargetOnly: 8_000_000 },
    targets: [{
      id: 'target',
      variants: [{ name: 'target', startMs: 0, endMs: 1000, lines: [{ owner: 'target', text: 'word', target: true }] }],
    }],
  };
  await fs.writeFile(fixture, `
import json
from pathlib import Path
import sys
scratch = Path(__file__).parent
record = scratch / "transport-request.json"
def simulate(request):
    return {"clock": {"sampleCount": 16000, "sampleRate": 16000, "frameCount": 50},
            "targets": [{"id": row["id"], "attempts": [{"variant": "target", "result": "ok"}],
                         "words": [{"line": 0, "text": row["variants"][0]["lines"][0]["text"],
                                    "startFrame": 5, "endFrame": 10, "score": 0.5, "peak": 0.1}]}
                        for row in request["targets"]]}
if sys.argv[1] == "--server":
    for raw in sys.stdin:
        request = json.loads(raw)
        identifier = request.pop("id")
        assert request.pop("action") == "align-windows"
        if record.exists():
            print("invalid protocol", flush=True)
            break
        record.write_text(json.dumps(request), encoding="utf-8")
        print(json.dumps({"id": identifier, "ok": True, "result": simulate(request)}), flush=True)
else:
    assert sys.argv[1] == "--align-windows-request" and sys.argv[3] == "--output"
    request = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    assert request == json.loads(record.read_text(encoding="utf-8"))
    Path(sys.argv[4]).write_text(json.dumps(simulate(request)), encoding="utf-8")
`, 'utf8');
  const previous = { worker: config.localTimingWorker, python: config.localTimingPython };
  try {
    config.localTimingWorker = fixture;
    config.localTimingPython = pythonForFixture();
    const daemon = await alignWindowsLocally(audio, 'fixture-namespace', windowRequest);
    assert.equal(daemon.targets[0].words?.[0].startFrame, 5);
    const actual = JSON.parse(await fs.readFile(requestFile, 'utf8'));
    assert.equal(actual.options.disableWhisperFallback, true);
    assert.equal(actual.options.emissionCacheDir, path.join(config.cacheDir, 'fixture-namespace', 'timing-emissions'));
    assert.deepEqual(await alignWindowsLocally(audio, 'fixture-namespace', windowRequest), daemon);
    const scratch = await fs.readdir(config.workingDir);
    assert.ok(!scratch.some((name) => name.startsWith('window-timing-')));
    config.localTimingPython = path.join(root, 'missing-python.exe');
    await assert.rejects(alignWindowsLocally(audio, 'fixture-namespace', windowRequest), LocalTimingUnavailableError);
  } finally {
    await closeLocalTimingWorker();
    config.localTimingWorker = previous.worker;
    config.localTimingPython = previous.python;
  }
});
