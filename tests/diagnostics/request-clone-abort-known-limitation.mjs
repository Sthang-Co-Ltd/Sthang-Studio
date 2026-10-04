import assert from 'node:assert/strict';
// Known inherited Node limitation. No network is accessed.
assert.equal(typeof globalThis.gc, 'function', 'Run with node --expose-gc');
// Pure runtime reproduction: creates no socket and performs no fetch.
const controller = new AbortController();
const request = new Request('http://127.0.0.1:1/never-fetched', { signal: controller.signal });
const clone = request.clone();
globalThis.reviewFixture = { controller, request, clone };
const counts = { original: 0, clone: 0 };
request.signal.addEventListener('abort', () => counts.original++);
clone.signal.addEventListener('abort', () => counts.clone++);
for (let i = 0; i < 5; i++) {
  await new Promise(resolve => setTimeout(resolve, 10));
  globalThis.gc();
}
controller.abort(new Error('offline cancellation fixture'));
console.log(JSON.stringify({ node: process.version, bundledUndici: process.versions.undici, nodeOptionsPresent: Boolean(process.env.NODE_OPTIONS), requestConstructor: Request.name, counts, originalAborted: request.signal.aborted, cloneAborted: clone.signal.aborted, retained: Object.keys(globalThis.reviewFixture) }));

assert.equal(clone.signal.aborted, true, 'Known Node Request.clone GC abort-propagation failure; source deadline rejection is separate');
