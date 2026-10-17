import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNativePreviewRecorder, installNativePreviewRecorder } from './native-preview-recorder.mjs';

function fixture() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin.write = function (...args) { this.lastWrite = args; return false; };
  child.stdin.destroy = function (...args) { this.lastDestroy = args; return this; };
  child.kill = function (...args) { this.lastKill = args; return true; };
  return child;
}
test('inactive by default and invalid opt-in never installs hooks', () => {
  for (const env of [{}, { STUDIO_NATIVE_PREVIEW_DIAGNOSTICS: '/unused' }]) {
    const childProcessObject = { spawn() {} }; const original = childProcessObject.spawn;
    const processObject = { once() { assert.fail('unexpected exit hook'); } };
    assert.equal(installNativePreviewRecorder('persistent-caption-preview', { env, childProcessObject, processObject, sync() { assert.fail('unexpected sync'); } }), null);
    assert.equal(childProcessObject.spawn, original);
  }
});
test('spawn, writes, callback identity, returns and this are forwarded unchanged; no listeners added', () => {
  const recorder = createNativePreviewRecorder(); const child = fixture(); const receiver = {};
  const args = ['synthetic-ffmpeg', ['-reinit_filter', '1'], { stdio: ['pipe', 'pipe', 'pipe'] }];
  const spawn = recorder.wrapSpawn(function (...received) { assert.equal(this, receiver); assert.deepEqual(received, args); received.forEach((v, i) => assert.equal(v, args[i])); return child; });
  assert.equal(spawn.apply(receiver, args), child);
  for (const emitter of [child, child.stdin, child.stdout, child.stderr]) assert.deepEqual(emitter.eventNames(), []);
  const packet = Buffer.alloc(32768, 7); const copy = Buffer.from(packet); let calls = 0;
  const callback = () => { calls++; };
  assert.equal(child.stdin.write(packet, 'buffer', callback), false);
  assert.deepEqual(child.stdin.lastWrite, [packet, 'buffer', callback]);
  assert.equal(child.stdin.lastWrite[0], packet); assert.equal(child.stdin.lastWrite[2], callback);
  assert.equal(calls, 0); child.stdin.lastWrite[2](); assert.equal(calls, 1);
  assert.deepEqual(packet, copy);
  assert.equal(child.kill('SIGKILL'), true); assert.deepEqual(child.lastKill, ['SIGKILL']);
  assert.equal(child.stdin.destroy(), child.stdin);
  assert.equal(recorder.snapshot().children[0].completeSeedWrites, 1);
});
test('existing emit semantics, listeners, binary bytes and unhandled errors are unchanged', () => {
  const recorder = createNativePreviewRecorder(); const child = fixture();
  recorder.wrapSpawn(() => child)('synthetic', ['-reinit_filter']);
  const chunk = Buffer.from([137, 80, 78, 71, 0, 1]); const before = Buffer.from(chunk);
  let observed;
  child.stdout.on('data', function (value) { assert.equal(this, child.stdout); observed = value; });
  assert.equal(child.stdout.emit('data', chunk), true); assert.equal(observed, chunk); assert.deepEqual(chunk, before);
  assert.equal(child.stderr.emit('data', Buffer.from('unobserved\n')), false);
  const failure = Object.assign(new Error('private path must not be retained'), { code: 'EPIPE' });
  assert.throws(() => child.emit('error', failure), (error) => error === failure);
  child.stdin.write = recorder.wrapSpawn(() => { throw failure; });
  assert.throws(() => child.stdin.write('synthetic', ['-reinit_filter']), (error) => error === failure);
  assert.equal(JSON.stringify(recorder.snapshot()).includes(failure.message), false);
});
test('nonpersistent children are untouched and original spawn exceptions retain identity', () => {
  const recorder = createNativePreviewRecorder(); const child = fixture(); const emit = child.emit;
  assert.equal(recorder.wrapSpawn(() => child)('synthetic', ['-version']), child); assert.equal(child.emit, emit);
  const failure = new Error('synthetic failure');
  assert.throws(() => recorder.wrapSpawn(() => { throw failure; })('synthetic', ['-reinit_filter']), (e) => e === failure);
  assert.equal(recorder.snapshot().children.length, 0);
});
test('bounded allowlisted metadata reports progress and never retains raw native content', () => {
  let clock = 0; const recorder = createNativePreviewRecorder({ now: () => clock }); const child = fixture();
  recorder.wrapSpawn(() => child)('private-path', ['-reinit_filter']);
  clock = 10; child.emit('spawn');
  child.stderr.emit('data', Buffer.from('[bbox@caption 0x123] n:0 x1:0\nC:/private/captions.ass secret text\nConversion fai'));
  clock = 20; child.stderr.emit('data', Buffer.from('led\n'));
  child.stdout.emit('data', Buffer.from('private-png-bytes'));
  assert.ok(recorder.snapshot().events.some((e) => e.category === 'conversion-failed'));
  for (let i = 0; i < 1200; i++) child.stdin.write(Buffer.alloc(0));
  clock = 5000; child.kill(); child.emit('close', 1, null);
  const data = recorder.snapshot(); const text = JSON.stringify(data);
  assert.equal(data.events.length, 1024); assert.ok(data.omittedEvents > 0);
  assert.equal(data.children[0].captionBboxes, 1); assert.equal(data.children[0].stdoutBytes, 17);
  assert.equal(data.children[0].stderrLastMs, 20);
  for (const privateText of ['private-path', 'captions.ass', 'secret text', 'private-png-bytes']) assert.equal(text.includes(privateText), false);
  assert.equal(data.events.at(-1).event, 'child-close');
  assert.equal(data.events.at(-1).ms, 5000);
});
test('observation and exit-writer failures cannot replace application return or throw', () => {
  const recorder = createNativePreviewRecorder(); const child = fixture();
  recorder.wrapSpawn(() => child)('synthetic', ['-reinit_filter']);
  const poison = { get code() { throw new Error('observer read failure'); } };
  child.on('error', () => {});
  assert.equal(child.emit('error', poison), true);
  assert.doesNotThrow(() => recorder.flush(() => { throw new Error('unwritable diagnostics directory'); }));
  const originalError = new Error('original listener failure'); child.stdout.on('data', () => { throw originalError; });
  assert.throws(() => child.stdout.emit('data', Buffer.from('safe')), (error) => error === originalError);
});

test('opt-in installation flushes only at exit and contains real filesystem failure', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'studio-recorder-test-'));
  try {
    let exit; let synced = 0;
    const processObject = { pid: 123, once(event, callback) { assert.equal(event, 'exit'); exit = callback; } };
    const childProcessObject = { spawn: () => fixture() };
    const recorder = installNativePreviewRecorder('persistent-caption-preview', {
      env: { STUDIO_NATIVE_PREVIEW_DIAGNOSTICS: directory, STUDIO_NATIVE_PREVIEW_DIAGNOSTIC_PHASE: 'isolated' },
      processObject, childProcessObject, sync() { synced++; },
    });
    assert.ok(recorder); assert.equal(synced, 1);
    recorder.checkpoint('after', 'synthetic test', { frames: 0, fallbacks: 1, secret: 'discarded' });
    const output = path.join(directory, 'isolated-persistent-caption-preview-123.json');
    assert.throws(() => readFileSync(output), { code: 'ENOENT' });
    exit();
    const parsed = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(parsed.events[0].diagnostics, { frames: 0, fallbacks: 1 });
    // Exclusive create refuses an overwrite, and that flush failure is contained.
    assert.doesNotThrow(() => exit());
    const blocked = path.join(directory, 'file-not-directory'); writeFileSync(blocked, 'synthetic');
    installNativePreviewRecorder('persistent-caption-preview', {
      env: { STUDIO_NATIVE_PREVIEW_DIAGNOSTICS: blocked, STUDIO_NATIVE_PREVIEW_DIAGNOSTIC_PHASE: 'concurrent' },
      processObject, childProcessObject: { spawn: () => fixture() }, sync() {},
    });
    assert.doesNotThrow(() => exit());
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
