import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachPreciseMediaTimeUpdates,
  type MediaClockScheduler,
  type MediaClockTarget,
} from '../apps/web/src/media-clock.ts';

class FakeScheduler implements MediaClockScheduler {
  currentNow = 0;
  private nextHandle = 1;
  private callbacks = new Map<number, (now: number) => void>();

  requestAnimationFrame(callback: (now: number) => void) {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancelAnimationFrame(handle: number) {
    this.callbacks.delete(handle);
  }

  now() {
    return this.currentNow;
  }

  get pending() {
    return this.callbacks.size;
  }

  runFrame(now: number) {
    this.currentNow = now;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(now);
  }
}

class FakeMedia extends EventTarget implements MediaClockTarget {
  currentTime = 0;
  paused = true;
  ended = false;
  isConnected = true;

  emit(name: string) {
    this.dispatchEvent(new Event(name));
  }
}

class FakeVideoMedia extends FakeMedia {
  private nextVideoHandle = 1;
  private videoCallbacks = new Map<number, (now: number, metadata: { mediaTime: number }) => void>();

  requestVideoFrameCallback(callback: (now: number, metadata: { mediaTime: number }) => void) {
    const handle = this.nextVideoHandle++;
    this.videoCallbacks.set(handle, callback);
    return handle;
  }

  cancelVideoFrameCallback(handle: number) {
    this.videoCallbacks.delete(handle);
  }

  get pendingVideoFrames() {
    return this.videoCallbacks.size;
  }

  runVideoFrame(now: number, mediaTime: number) {
    const callbacks = [...this.videoCallbacks.values()];
    this.videoCallbacks.clear();
    for (const callback of callbacks) callback(now, { mediaTime });
  }
}

function collectUpdates(media: FakeMedia) {
  const updates: number[] = [];
  media.addEventListener('timeupdate', () => updates.push(media.currentTime));
  return updates;
}

test('animation-frame fallback fills slow native timeupdate gaps without flooding fast updates', () => {
  const scheduler = new FakeScheduler();
  const media = new FakeMedia();
  const updates = collectUpdates(media);
  const cleanup = attachPreciseMediaTimeUpdates(media, scheduler);

  assert.deepEqual(updates, [0]);
  updates.length = 0;
  media.paused = false;
  media.emit('play');
  updates.length = 0;

  media.currentTime = 0.010;
  scheduler.runFrame(10);
  assert.deepEqual(updates, []);

  media.currentTime = 0.034;
  scheduler.runFrame(34);
  assert.deepEqual(updates, [0.034]);

  scheduler.currentNow = 45;
  media.currentTime = 0.045;
  media.emit('timeupdate');
  media.currentTime = 0.060;
  scheduler.runFrame(60);
  assert.deepEqual(updates, [0.034, 0.045]);

  media.currentTime = 0.079;
  scheduler.runFrame(79);
  assert.deepEqual(updates, [0.034, 0.045, 0.079]);

  media.paused = true;
  scheduler.currentNow = 80;
  media.emit('pause');
  assert.equal(scheduler.pending, 0);
  cleanup();
});

test('video-frame callbacks are preferred and canceled on cleanup', () => {
  const scheduler = new FakeScheduler();
  const media = new FakeVideoMedia();
  const updates = collectUpdates(media);
  media.currentTime = 3;
  media.paused = false;

  const cleanup = attachPreciseMediaTimeUpdates(media, scheduler);
  assert.deepEqual(updates, [3]);
  assert.equal(media.pendingVideoFrames, 1);
  assert.equal(scheduler.pending, 0);

  updates.length = 0;
  media.currentTime = 3.041;
  media.runVideoFrame(41, 3.033);
  assert.deepEqual(updates, [3.041]);
  assert.equal(media.pendingVideoFrames, 1);

  cleanup();
  assert.equal(media.pendingVideoFrames, 0);
});

test('seeking cancels stale work, resynchronizes immediately, and resumes while playing', () => {
  const scheduler = new FakeScheduler();
  const media = new FakeMedia();
  const updates = collectUpdates(media);
  media.paused = false;
  const cleanup = attachPreciseMediaTimeUpdates(media, scheduler);
  updates.length = 0;
  assert.equal(scheduler.pending, 1);

  scheduler.currentNow = 5;
  media.currentTime = 5;
  media.emit('seeking');
  assert.deepEqual(updates, [5]);
  assert.equal(scheduler.pending, 0);

  scheduler.runFrame(40);
  assert.deepEqual(updates, [5]);
  media.emit('seeked');
  assert.deepEqual(updates, [5, 5]);
  assert.equal(scheduler.pending, 1);

  media.currentTime = 5.04;
  scheduler.runFrame(74);
  assert.deepEqual(updates, [5, 5, 5.04]);

  cleanup();
  assert.equal(scheduler.pending, 0);
  media.currentTime = 6;
  media.emit('play');
  scheduler.runFrame(120);
  assert.deepEqual(updates, [5, 5, 5.04]);
});

test('a detached media element stops scheduling updates', () => {
  const scheduler = new FakeScheduler();
  const media = new FakeMedia();
  const updates = collectUpdates(media);
  media.paused = false;
  const cleanup = attachPreciseMediaTimeUpdates(media, scheduler);
  updates.length = 0;

  media.isConnected = false;
  media.currentTime = 0.1;
  scheduler.runFrame(40);
  assert.deepEqual(updates, []);
  assert.equal(scheduler.pending, 0);
  cleanup();
});
