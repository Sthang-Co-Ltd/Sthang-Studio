import test from 'node:test';
import assert from 'node:assert/strict';
import { playTimingRange } from '../apps/web/src/timing-playback.js';

type Listener = () => void;

class FakeMedia {
  duration = 10;
  currentTime = 0;
  paused = true;
  ended = false;
  playCalls = 0;
  pauseCalls = 0;
  playResult: () => Promise<void> = async () => {};
  listeners = new Map<string, Set<Listener>>();

  play() {
    this.playCalls += 1;
    this.paused = false;
    return this.playResult();
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = listener as Listener;
    const set = this.listeners.get(type) || new Set<Listener>();
    set.add(callback);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.get(type)?.delete(listener as Listener);
  }

  emit(type: 'pause' | 'ended') {
    for (const listener of [...(this.listeners.get(type) || [])]) listener();
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size || 0;
  }
}

function installAnimationFrame() {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];

  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    cancelled.push(id);
    callbacks.delete(id);
  }) as typeof cancelAnimationFrame;

  return {
    runOneFrame() {
      const first = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!first) return false;
      const [id, callback] = first;
      callbacks.delete(id);
      callback(0);
      return true;
    },
    pending: () => callbacks.size,
    cancelled,
    restore() {
      if (originalRequest) globalThis.requestAnimationFrame = originalRequest;
      else delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame;
      if (originalCancel) globalThis.cancelAnimationFrame = originalCancel;
      else delete (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame }).cancelAnimationFrame;
    },
  };
}

function asMedia(media: FakeMedia) {
  return media as unknown as HTMLMediaElement;
}

const settlePromises = () => new Promise<void>((resolve) => setImmediate(resolve));

test('bounded non-loop playback clamps to media duration and stops exactly at the requested end', async () => {
  const raf = installAnimationFrame();
  try {
    const media = new FakeMedia();
    media.duration = 5;
    let errors = 0;
    const dispose = playTimingRange(asMedia(media), { startMs: -400, endMs: 99_000, loop: false }, () => { errors += 1; });

    assert.equal(media.currentTime, 0);
    assert.equal(media.playCalls, 1);
    assert.equal(media.listenerCount('pause'), 1);
    assert.equal(media.listenerCount('ended'), 1);
    assert.equal(raf.pending(), 1);

    media.currentTime = 5.2;
    assert.equal(raf.runOneFrame(), true);
    assert.equal(media.pauseCalls, 1);
    assert.equal(media.currentTime, 5);
    assert.equal(media.listenerCount('pause'), 0);
    assert.equal(media.listenerCount('ended'), 0);
    assert.equal(raf.pending(), 0);
    assert.equal(errors, 0);

    dispose();
    assert.equal(media.pauseCalls, 1, 'disposer is inert after the range already stopped');
    await settlePromises();
  } finally {
    raf.restore();
  }
});

test('invalid or empty ranges are true no-ops', () => {
  const raf = installAnimationFrame();
  try {
    for (const range of [
      { startMs: 2_000, endMs: 2_000, loop: false },
      { startMs: 3_000, endMs: 2_000, loop: false },
      { startMs: Number.NaN, endMs: 2_000, loop: false },
      { startMs: 12_000, endMs: 13_000, loop: false },
    ]) {
      const media = new FakeMedia();
      const dispose = playTimingRange(asMedia(media), range, () => assert.fail('no-op range must not report playback errors'));
      dispose();
      assert.equal(media.playCalls, 0);
      assert.equal(media.pauseCalls, 0);
      assert.equal(media.listenerCount('pause'), 0);
      assert.equal(media.listenerCount('ended'), 0);
    }
    assert.equal(raf.pending(), 0);
  } finally {
    raf.restore();
  }
});

test('loop restart stays scoped across tick and end-of-media pause/ended ordering', async () => {
  const raf = installAnimationFrame();
  try {
    const media = new FakeMedia();
    media.duration = 2;
    const dispose = playTimingRange(asMedia(media), { startMs: 500, endMs: 2_000, loop: true }, () => assert.fail('loop should not error'));
    assert.equal(media.currentTime, 0.5);
    assert.equal(media.playCalls, 1);

    media.currentTime = 2;
    assert.equal(raf.runOneFrame(), true);
    assert.equal(media.currentTime, 0.5);
    assert.equal(media.playCalls, 2);
    assert.equal(raf.pending(), 1, 'loop remains active after a tick restart');

    media.ended = true;
    media.paused = true;
    media.emit('pause');
    assert.equal(media.listenerCount('ended'), 1, 'end-of-media pause must not tear down a requested loop');
    media.emit('ended');
    assert.equal(media.currentTime, 0.5);
    assert.equal(media.playCalls, 3);

    media.ended = false;
    dispose();
    assert.equal(media.pauseCalls, 1);
    assert.equal(media.listenerCount('pause'), 0);
    assert.equal(media.listenerCount('ended'), 0);
    assert.equal(raf.pending(), 0);
    dispose();
    assert.equal(media.pauseCalls, 1, 'disposer is idempotent');
    await settlePromises();
  } finally {
    raf.restore();
  }
});

test('ordinary pause cleans up the timing session so its old disposer cannot stop later playback', async () => {
  const raf = installAnimationFrame();
  try {
    const media = new FakeMedia();
    const dispose = playTimingRange(asMedia(media), { startMs: 1_000, endMs: 2_000, loop: false }, () => assert.fail('pause cleanup should not error'));
    assert.equal(media.listenerCount('pause'), 1);

    media.paused = true;
    media.emit('pause');
    assert.equal(media.listenerCount('pause'), 0);
    assert.equal(media.listenerCount('ended'), 0);
    assert.equal(raf.pending(), 0);

    await media.play();
    const pausesBeforeOldDispose = media.pauseCalls;
    dispose();
    assert.equal(media.pauseCalls, pausesBeforeOldDispose);
    assert.equal(media.paused, false, 'stale timing disposer must not interrupt newer ordinary playback');
  } finally {
    raf.restore();
  }
});

test('non-loop ended event releases listeners without issuing a second pause', async () => {
  const raf = installAnimationFrame();
  try {
    const media = new FakeMedia();
    const dispose = playTimingRange(asMedia(media), { startMs: 9_000, endMs: 10_000, loop: false }, () => assert.fail('natural end should not error'));
    media.ended = true;
    media.paused = true;
    media.emit('ended');

    assert.equal(media.pauseCalls, 0);
    assert.equal(media.listenerCount('pause'), 0);
    assert.equal(media.listenerCount('ended'), 0);
    assert.equal(raf.pending(), 0);
    dispose();
    assert.equal(media.pauseCalls, 0);
    await settlePromises();
  } finally {
    raf.restore();
  }
});

test('async play rejection stops an active timing session and reports exactly one error', async () => {
  const raf = installAnimationFrame();
  try {
    const media = new FakeMedia();
    let rejectPlay!: (reason?: unknown) => void;
    media.playResult = () => new Promise<void>((_resolve, reject) => { rejectPlay = reject; });
    let errors = 0;
    const dispose = playTimingRange(asMedia(media), { startMs: 1_000, endMs: 2_000, loop: false }, () => { errors += 1; });
    rejectPlay(new Error('autoplay denied'));
    await settlePromises();

    assert.equal(errors, 1);
    assert.equal(media.pauseCalls, 1);
    assert.equal(media.listenerCount('pause'), 0);
    assert.equal(media.listenerCount('ended'), 0);
    assert.equal(raf.pending(), 0);
    dispose();
    assert.equal(media.pauseCalls, 1);
  } finally {
    raf.restore();
  }
});

test('play rejection after explicit disposal is ignored by the retired timing session', async () => {
  const raf = installAnimationFrame();
  try {
    const media = new FakeMedia();
    let rejectPlay!: (reason?: unknown) => void;
    media.playResult = () => new Promise<void>((_resolve, reject) => { rejectPlay = reject; });
    let errors = 0;
    const dispose = playTimingRange(asMedia(media), { startMs: 1_000, endMs: 2_000, loop: false }, () => { errors += 1; });
    dispose();
    assert.equal(media.pauseCalls, 1);

    rejectPlay(new Error('late autoplay rejection'));
    await settlePromises();
    assert.equal(errors, 0);
    assert.equal(media.pauseCalls, 1);
  } finally {
    raf.restore();
  }
});
