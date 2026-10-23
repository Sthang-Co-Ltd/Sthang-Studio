import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

try {
  const root = await fs.realpath(process.env.STHANG_STUDIO_STATE_ROOT || '');
  const owner = JSON.parse(await fs.readFile(path.join(root, '.benchmark-owner.json'), 'utf8'));
  assert.equal(owner.id, process.env.STHANG_PROJECT_BENCHMARK_OWNER);
  assert.equal(owner.kind, 'synthetic-project-loading');
  assert.equal(process.env.STHANG_STUDIO_ENV_FILE, path.join(root, 'absent.env'));
  assert.equal(await fs.stat(process.env.STHANG_STUDIO_ENV_FILE!).then(() => true, () => false), false);
  // Any accidental provider listen fails; this process opens no server/listener.
  globalThis.fetch = async () => { throw new Error('Network is disabled in the store benchmark.'); };
  const importedAt = performance.now();
  const { store } = await import('../../apps/server/src/services/store.js');
  const importMs = performance.now() - importedAt;
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  assert.ok(gc, 'Run this child with --expose-gc.');
  gc(); const before = process.memoryUsage();
  const start = performance.now();
  let summaries: Awaited<ReturnType<typeof store.listSummaries>> | null = await store.listSummaries();
  const firstListMs = performance.now() - start;
  assert.equal(summaries.length, owner.projects);
  assert.ok(summaries.every((item) => item.captionCount === owner.captions && !('captions' in item) && !('transcript' in item)));
  const orderedIds = summaries.map((item) => item.id);
  assert.equal(orderedIds[0], 'synthetic-0');
  summaries = null; gc(); const retained = process.memoryUsage();
  const warmStart = performance.now();
  assert.deepEqual((await store.listSummaries()).map((item) => item.id), orderedIds);
  const warmListMs = performance.now() - warmStart;
  const detailStart = performance.now();
  const detail = await store.get(orderedIds.at(-1)!);
  const detailMs = performance.now() - detailStart;
  assert.equal(detail?.captions.length, owner.captions);
  assert.equal(detail?.captions[0].text, 'សួស្តី នេះជាសាកល្បង caption-0');
  detail!.captions[0].text = 'detached synthetic edit';
  assert.equal((await store.get(detail!.id))!.captions[0].text, 'សួស្តី នេះជាសាកល្បង caption-0');
  process.send?.({ importMs, firstListMs, warmListMs, detailMs,
    retainedHeapBytes: retained.heapUsed - before.heapUsed, retainedRssBytes: retained.rss - before.rss,
    heapAfterBytes: retained.heapUsed, rssAfterBytes: retained.rss });
} catch {
  process.send?.({ error: 'Synthetic store benchmark failed its load/detachment/ownership checks.' });
  process.exitCode = 1;
}
