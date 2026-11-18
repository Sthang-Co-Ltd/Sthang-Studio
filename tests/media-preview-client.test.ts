import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { checkMediaPreviewCopy, MAX_PREVIEW_STATUS_BYTES, requestMediaPreview } from '../apps/web/src/media-preview-client.js';

test('preview deadline bounds missing headers and stalled JSON bodies; abort remains distinct', async () => {
  let body = false;
  const server = http.createServer((_req, res) => { if (body) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => original(origin + input, init);
  try {
    for (body of [false, true]) {
      const started = Date.now();
      await assert.rejects(requestMediaPreview('test', 'test.mp4', 'POST', undefined, false, 60), /did not respond/);
      assert.ok(Date.now() - started < 1000);
    }
    body = false;
    await assert.rejects(checkMediaPreviewCopy('/api/media-preview/test/file/exact.mp4', undefined, 60), /did not respond/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(requestMediaPreview('test', 'test.mp4', 'GET', abort.signal), { name: 'AbortError' });
    body = true;
    const activeAbort = new AbortController();
    const active = requestMediaPreview('test', 'test.mp4', 'GET', activeAbort.signal);
    const cancel = setTimeout(() => activeAbort.abort(), 20);
    try { await assert.rejects(active, { name: 'AbortError' }); } finally { clearTimeout(cancel); }
  } finally { globalThis.fetch = original; server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

test('copy checks use the exact immutable or legacy URL and distinguish absence from unavailable status', async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; method?: string; cache?: RequestCache; redirect?: RequestRedirect }> = [];
  let status = 200;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method, cache: init?.cache, redirect: init?.redirect });
    return new Response(null, { status });
  };
  try {
    for (const suffix of ['', `.${'b'.repeat(32)}`]) {
      const url = `/api/media-preview/test/file/${'a'.repeat(64)}${suffix}.mp4`;
      for (const [code, expected] of [[200, 'available'], [404, 'missing'], [410, 'missing'], [503, 'unavailable']] as const) {
        status = code;
        assert.equal(await checkMediaPreviewCopy(url), expected);
        assert.deepEqual(requests.at(-1), { url, method: 'HEAD', cache: 'no-store', redirect: 'error' });
      }
    }
    const before = requests.length;
    await assert.rejects(checkMediaPreviewCopy('//outside.invalid/copy.mp4'), /unavailable/);
    assert.equal(requests.length, before);
  } finally { globalThis.fetch = original; }
});

test('status parsing bounds streamed bytes and rejects invalid shape while preserving safe messages', async () => {
  const original = globalThis.fetch;
  const ready = { source: 'test.mp4', state: 'ready', videoCodec: 'h264', progress: 100,
    url: `/api/media-preview/test/file/${'a'.repeat(64)}.${'b'.repeat(32)}.mp4` };
  let response = () => new Response(JSON.stringify(ready), { headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async () => response();
  try {
    assert.deepEqual(await requestMediaPreview('test', 'test.mp4', 'GET'), ready);
    for (const value of [null, [], { ...ready, state: 'unknown' }, { ...ready, progress: 101 },
      { ...ready, progress: '100' }, { ...ready, videoCodec: null }, { ...ready, url: '//outside.invalid/copy.mp4' },
      { ...ready, url: undefined }, { ...ready, message: 'x'.repeat(4097) }]) {
      response = () => new Response(JSON.stringify(value));
      await assert.rejects(requestMediaPreview('test', 'test.mp4', 'GET'), /unavailable/);
    }
    let cancelled = false;
    response = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('ខ'.repeat(Math.ceil(MAX_PREVIEW_STATUS_BYTES / 2)))); },
      cancel() { cancelled = true; },
    }));
    await assert.rejects(requestMediaPreview('test', 'test.mp4', 'GET'), /unavailable/);
    assert.equal(cancelled, true);
    response = () => new Response('{"error":"Playback storage is in use. Close another project and try again shortly."}', { status: 409 });
    await assert.rejects(requestMediaPreview('test', 'test.mp4', 'POST'), /Playback storage is in use/);
    response = () => new Response(JSON.stringify({ ...ready, source: 'replaced.mp4' }));
    await assert.rejects(requestMediaPreview('test', 'test.mp4', 'GET'), /The source media changed/);
  } finally { globalThis.fetch = original; }
});
