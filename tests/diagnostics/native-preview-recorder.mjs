// Opt-in, test-only observations. Never imported by production code.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_EVENTS = 1024;
const MAX_CHILDREN = 64;
const errorCodes = new Set(['ENOENT', 'EACCES', 'EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ABORT_ERR']);
const categories = [
  ['resource-unavailable', /resource temporarily unavailable/i],
  ['configure-output-failed', /failed to configure output pad/i],
  ['filter-reinitialization-failed', /error reinitializing filters/i],
  ['invalid-input', /invalid data found when processing input/i],
  ['conversion-failed', /conversion failed/i],
  ['allocation-failed', /cannot allocate memory|out of memory/i],
  ['broken-pipe', /broken pipe/i],
];
const safeCode = (error) => errorCodes.has(error?.code) ? error.code : 'other';
const safeSignal = (signal) => ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT'].includes(signal) ? signal : signal == null ? null : 'other';
const attempt = (fn) => { try { return fn(); } catch { /* Diagnostics must not change test behavior. */ } };

export function createNativePreviewRecorder({ now = () => performance.now() } = {}) {
  const started = now();
  const children = [];
  const events = [];
  let omittedEvents = 0;
  let omittedChildren = 0;
  const elapsed = () => Math.round((now() - started) * 10) / 10;
  const record = (event) => attempt(() => {
    if (events.length < MAX_EVENTS) events.push({ ms: elapsed(), ...event });
    else { events[omittedEvents % MAX_EVENTS] = { ms: elapsed(), ...event }; omittedEvents++; }
  });
  function wrap(target, key, observe) {
    if (!target || typeof target[key] !== 'function') return;
    const original = target[key];
    target[key] = function (...args) {
      attempt(() => observe(args));
      // Preserve receiver, arguments (including callback identity), result and throw.
      return Reflect.apply(original, this, args);
    };
  }
  function observeChild(child) {
    if (children.length >= MAX_CHILDREN) { omittedChildren++; return; }
    const id = children.length + 1;
    const stats = { id, startMs: elapsed(), writes: 0, inputBytes: 0, completeSeedWrites: 0,
      stdoutChunks: 0, stdoutBytes: 0, stderrChunks: 0, stderrBytes: 0,
      captionBboxes: 0, focusBboxes: 0, truncatedStderrChunks: 0 };
    children.push(stats);
    record({ event: 'spawn-returned', id });
    wrap(child, 'emit', ([event, a, b]) => {
      if (event === 'error') record({ event: 'child-error', id, code: safeCode(a) });
      if (event === 'spawn') record({ event: 'child-started', id });
      if (event === 'exit' || event === 'close') {
        stats[event] = { ms: elapsed(), code: Number.isInteger(a) ? a : null, signal: safeSignal(b) };
        record({ event: `child-${event}`, id, ...stats[event] });
      }
    });
    wrap(child, 'kill', ([signal]) => {
      stats.lastKill = { ms: elapsed(), signal: safeSignal(signal ?? 'SIGTERM') };
      record({ event: 'kill-called', id, ...stats.lastKill });
    });
    wrap(child.stdin, 'write', ([chunk]) => {
      stats.writes++;
      const bytes = Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk) ? chunk.byteLength : typeof chunk === 'string' ? Buffer.byteLength(chunk) : 0;
      stats.inputBytes += bytes;
      // Existing production transport sends one 32768-byte PPM packet per write.
      if (bytes === 32768) stats.completeSeedWrites++;
      record({ event: 'stdin-write', id, bytes, seedWrites: stats.completeSeedWrites });
    });
    wrap(child.stdin, 'destroy', ([error]) => record({ event: 'stdin-destroy', id, code: error ? safeCode(error) : null }));
    wrap(child.stdin, 'emit', ([event, error]) => {
      if (event === 'error') record({ event: 'stdin-error', id, code: safeCode(error) });
      if (event === 'finish' || event === 'close') record({ event: `stdin-${event}`, id });
    });
    let pendingLine = '';
    for (const stream of ['stdout', 'stderr']) wrap(child[stream], 'emit', ([event, chunk]) => {
      if (event === 'error') { record({ event: `${stream}-error`, id, code: safeCode(chunk) }); return; }
      if (event === 'end' || event === 'close') { record({ event: `${stream}-${event}`, id }); return; }
      if (event !== 'data') return;
      const bytes = Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk) ? chunk.byteLength : typeof chunk === 'string' ? Buffer.byteLength(chunk) : 0;
      stats[`${stream}Chunks`]++;
      stats[`${stream}Bytes`] += bytes;
      stats[`${stream}LastMs`] = elapsed();
      if (stats[`${stream}FirstMs`] === undefined) stats[`${stream}FirstMs`] = stats[`${stream}LastMs`];
      if (stream !== 'stderr') return; // Never inspect, copy or retain PNG bytes.
      // Bound conversion and pending text. Raw text is never included in evidence.
      if (bytes > 8192) stats.truncatedStderrChunks++;
      const text = Buffer.isBuffer(chunk) ? chunk.subarray(0, 8192).toString('utf8') : typeof chunk === 'string' ? chunk.slice(0, 8192) : '';
      const lines = (pendingLine + text).split(/\r?\n/);
      pendingLine = lines.pop().slice(-2048);
      for (const line of lines) {
        const kind = /\[bbox@(caption|focus) [^\]]*\].*\bn:\d+/.exec(line)?.[1];
        if (kind) { stats[`${kind}Bboxes`]++; record({ event: 'bbox', id, kind, count: stats[`${kind}Bboxes`] }); }
        for (const [category, pattern] of categories) if (pattern.test(line)) record({ event: 'stderr-category', id, category });
      }
    });
  }
  return {
    wrapSpawn(original) {
      return function (...args) {
        // Only the persistent pipe transport, not one-shot/probe/other processes.
        const watched = Array.isArray(args[1]) && args[1].includes('-reinit_filter');
        let child;
        try { child = Reflect.apply(original, this, args); }
        catch (error) { if (watched) record({ event: 'spawn-throw', code: safeCode(error) }); throw error; }
        if (watched) attempt(() => observeChild(child));
        return child;
      };
    },
    checkpoint(phase, testName, diagnostics) {
      // Names come only from checked-in synthetic tests, never application input.
      record({ event: 'test-boundary', phase, test: String(testName).slice(0, 240),
        diagnostics: Object.fromEntries(['starts', 'frames', 'fallbacks', 'assWrites', 'sessionDirectories', 'workers']
          .filter((key) => Number.isFinite(diagnostics?.[key])).map((key) => [key, diagnostics[key]])) });
    },
    snapshot() {
      const offset = omittedEvents % MAX_EVENTS;
      return { schema: 1, children, events: omittedEvents ? [...events.slice(offset), ...events.slice(0, offset)] : [...events], omittedEvents, omittedChildren };
    },
    flush(write) { attempt(() => write(JSON.stringify(this.snapshot(), null, 2))); },
  };
}

export function installNativePreviewRecorder(file, { env = process.env, processObject = process, childProcessObject = childProcess, sync = syncBuiltinESMExports } = {}) {
  const directory = env.STUDIO_NATIVE_PREVIEW_DIAGNOSTICS;
  const phase = env.STUDIO_NATIVE_PREVIEW_DIAGNOSTIC_PHASE;
  if (!directory || !['concurrent', 'isolated'].includes(phase) || !['persistent-caption-preview', 'persistent-caption-preview-phase3'].includes(file)) return null;
  const recorder = createNativePreviewRecorder();
  childProcessObject.spawn = recorder.wrapSpawn(childProcessObject.spawn);
  sync();
  processObject.once('exit', () => recorder.flush((text) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `${phase}-${file}-${processObject.pid}.json`), text, { flag: 'wx' });
  }));
  return recorder;
}
