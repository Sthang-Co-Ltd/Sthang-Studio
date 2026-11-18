import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackFailureMessage, recoveryPosition, restoredPosition, watchPlaybackProgress } from '../apps/web/src/media-playback-recovery.js';

test('recovery preserves the healthy playhead and avoids a failed decoder reset', () => {
  assert.equal(recoveryPosition({ error: null, currentTime: 81.4 }, 80), 81.4);
  assert.equal(recoveryPosition({ error: { code: 3 }, currentTime: 0 }, 81.4), 81.4);
  assert.equal(recoveryPosition({ error: null, currentTime: NaN }, 81.4), 81.4);
});

test('restoration clamps only to a finite media timeline', () => {
  assert.equal(restoredPosition(81.4, 184), 81.4);
  assert.equal(restoredPosition(184, 184), 183.95);
  assert.equal(restoredPosition(1, 0), 0);
  assert.equal(restoredPosition(81.4, Infinity), 81.4);
});

test('failure text distinguishes safe browser categories without raw decoder diagnostics', () => {
  assert.match(playbackFailureMessage(2), /could not read/);
  assert.match(playbackFailureMessage(3), /could not decode/);
  assert.match(playbackFailureMessage(4), /could not open/);
  assert.match(playbackFailureMessage(1), /interrupted/);
  assert.match(playbackFailureMessage(), /could not continue/);
  for (const code of [undefined, 1, 2, 3, 4, 999]) assert.match(playbackFailureMessage(code), /source file and captions are unchanged/);
});

test('watchdog detects silent stalls, resumes on actual frames, and ignores pauses/hidden tabs/end', () => {
  let now = 0, visible = true, tick = () => {}, stalls = 0, progress = 0, frame: VideoFrameRequestCallback | undefined;
  const element = Object.assign(new EventTarget(), { currentTime: 10, readyState: 4, paused: false, ended: false, error: null, isConnected: true, seeking: false,
    getAttribute: () => '/synthetic.mp4', requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => { frame = callback; return 1; }, cancelVideoFrameCallback: () => { frame = undefined; } });
  const stop = watchPlaybackProgress(element as unknown as HTMLMediaElement, () => { stalls++; }, () => { progress++; }, { now: () => now, visible: () => visible, every: (callback) => { tick = callback; return () => { tick = () => {}; }; } });
  const advance = (ms: number) => { now += ms; tick(); };
  advance(19_000); assert.equal(stalls, 0);
  advance(1000); assert.equal(stalls, 1);
  frame!(now, {} as VideoFrameCallbackMetadata); assert.equal(progress, 1);
  element.paused = true; advance(30_000); assert.equal(stalls, 1);
  element.paused = false; visible = false; advance(30_000); assert.equal(stalls, 1);
  visible = true; advance(1000); assert.equal(stalls, 1);
  element.ended = true; advance(30_000); assert.equal(stalls, 1);
  element.ended = false; element.seeking = true; element.dispatchEvent(new Event('seeking'));
  advance(20_000); assert.equal(stalls, 2);
  stop(); advance(30_000); assert.equal(stalls, 2); assert.equal(frame, undefined);
});

test('advancing sparse VFR playback is healthy after its first presented frame', () => {
  let now = 0, tick = () => {}, stalls = 0, frame: VideoFrameRequestCallback | undefined;
  const element = Object.assign(new EventTarget(), { currentTime: 0, readyState: 4, paused: false, ended: false, error: null, isConnected: true, seeking: false,
    getAttribute: () => '/synthetic.mp4', requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => { frame = callback; return 1; }, cancelVideoFrameCallback: () => {} });
  const stop = watchPlaybackProgress(element as unknown as HTMLMediaElement, () => { stalls++; }, () => {}, { now: () => now, visible: () => true, every: (callback) => { tick = callback; return () => {}; } });
  frame!(now, {} as VideoFrameCallbackMetadata);
  for (let i = 0; i < 21; i++) { now += 1000; element.currentTime++; tick(); }
  assert.equal(stalls, 0); stop();
});

test('video needs its first presented frame even when paused or its audio clock advances', () => {
  for (const paused of [true, false]) {
    let now = 0, tick = () => {}, stalls = 0, ready = 0, progress = 0, frame: VideoFrameRequestCallback | undefined;
    const element = Object.assign(new EventTarget(), { currentTime: 0, readyState: 2, paused, ended: false, error: null, isConnected: true, seeking: false,
      getAttribute: () => '/synthetic.mp4', requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => { frame = callback; return 1; }, cancelVideoFrameCallback: () => {} });
    const stop = watchPlaybackProgress(element as unknown as HTMLMediaElement, () => { stalls++; }, () => { progress++; },
      { now: () => now, visible: () => true, every: (callback) => { tick = callback; return () => {}; } }, { onFirstFrame: () => { ready++; } });
    element.dispatchEvent(new Event('loadedmetadata'));
    element.dispatchEvent(new Event('loadeddata'));
    for (let i = 0; i < 20; i++) { now += 1000; if (!paused) element.currentTime++; tick(); }
    assert.equal(stalls, 1); assert.equal(ready, 0); assert.equal(progress, 0);
    now += 1000; element.currentTime++; tick();
    assert.equal(ready, 0); assert.equal(progress, 0);
    frame!(now, {} as VideoFrameCallbackMetadata);
    assert.equal(ready, 1); assert.equal(progress, 1);
    for (let i = 0; i < 21; i++) { now += 1000; if (!paused) element.currentTime++; tick(); }
    assert.equal(stalls, 1); assert.equal(ready, 1);
    stop();
  }
});

test('retired source, disposed callback and decoder error cannot report a first frame', () => {
  let source = '/first.mp4', frame: VideoFrameRequestCallback | undefined, ready = 0, progress = 0;
  const element = Object.assign(new EventTarget(), { currentTime: 0, readyState: 2, paused: true, ended: false, error: null as unknown, isConnected: true, seeking: false,
    getAttribute: () => source, requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => { frame = callback; return 1; }, cancelVideoFrameCallback: () => {} });
  const scheduler = { now: () => 0, visible: () => true, every: () => () => {} };
  const start = () => watchPlaybackProgress(element as unknown as HTMLMediaElement, () => {}, () => { progress++; }, scheduler, { onFirstFrame: () => { ready++; } });
  const stopFirst = start(); const retired = frame!;
  source = '/second.mp4'; retired(0, {} as VideoFrameCallbackMetadata);
  assert.equal(ready, 0); assert.equal(progress, 0); stopFirst();
  const stopSecond = start(); const disposed = frame!; stopSecond(); disposed(0, {} as VideoFrameCallbackMetadata);
  assert.equal(ready, 0); assert.equal(progress, 0);
  const stopFailed = start(); element.error = { code: 3 }; frame!(0, {} as VideoFrameCallbackMetadata);
  assert.equal(ready, 0); assert.equal(progress, 0); stopFailed();
});

test('first-frame waiting reports elapsed time until an owned frame, including an advancing audio clock', () => {
  let now = 0, tick = () => {}, stalls = 0, frame: VideoFrameRequestCallback | undefined;
  const waits: number[] = [];
  const element = Object.assign(new EventTarget(), { currentTime: 0, readyState: 4, paused: false, ended: false, error: null, isConnected: true, seeking: false,
    getAttribute: () => '/synthetic.mp4', requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => { frame = callback; return 1; }, cancelVideoFrameCallback: () => {} });
  const stop = watchPlaybackProgress(element as unknown as HTMLMediaElement, () => { stalls++; }, () => {},
    { now: () => now, visible: () => true, every: (callback) => { tick = callback; return () => {}; } }, { onFirstFrameWait: (elapsed) => { waits.push(elapsed); } });
  element.dispatchEvent(new Event('loadeddata'));
  for (let second = 1; second <= 5; second++) { now = second * 1000; element.currentTime = second; tick(); }
  assert.deepEqual(waits, [1000, 2000, 3000, 4000, 5000]); assert.equal(stalls, 0);
  frame!(now, {} as VideoFrameCallbackMetadata);
  now += 5000; element.currentTime += 5; tick();
  assert.equal(waits.length, 5); assert.equal(stalls, 0);
  stop();
});

test('suspended hidden intervals do not consume visible first-frame waiting and visibility cleanup is bounded', () => {
  let now = 0, visible = true, tick = () => {}, visibilityChanged = () => {}, visibilityRemoved = false;
  const waits: number[] = [];
  const element = Object.assign(new EventTarget(), { currentTime: 0, readyState: 4, paused: true, ended: false, error: null, isConnected: true, seeking: false,
    getAttribute: () => '/synthetic.mp4', requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => {} });
  const stop = watchPlaybackProgress(element as unknown as HTMLMediaElement, () => { assert.fail('The 20-second stall deadline has not elapsed visibly'); }, () => {}, {
    now: () => now, visible: () => visible, every: (callback) => { tick = callback; return () => {}; },
    onVisibilityChange: (callback) => { visibilityChanged = callback; return () => { visibilityRemoved = true; }; },
  }, { onFirstFrameWait: (elapsed) => { waits.push(elapsed); } });
  now = 4000; tick(); assert.deepEqual(waits, [4000]);
  visible = false; visibilityChanged();
  now = 64_000; // No interval runs while the browser suspends this hidden tab.
  visible = true; visibilityChanged(); tick();
  now += 4000; tick();
  assert.deepEqual(waits, [4000, 0, 4000]);
  now += 1000; tick(); assert.equal(waits.at(-1), 5000);
  stop(); assert.equal(visibilityRemoved, true);
  now += 60_000; visibilityChanged(); tick(); assert.equal(waits.length, 4);
});

test('audio and video without frame callbacks complete readiness on loaded data, not metadata', () => {
  let ready = 0;
  const element = Object.assign(new EventTarget(), { currentTime: 0, readyState: 1, paused: true, ended: false, error: null, isConnected: true, seeking: false, getAttribute: () => '/synthetic.mp4' });
  const stop = watchPlaybackProgress(element as unknown as HTMLMediaElement, () => {}, () => {},
    { now: () => 0, visible: () => true, every: () => () => {} }, { onFirstFrame: () => { ready++; } });
  element.dispatchEvent(new Event('loadedmetadata')); assert.equal(ready, 0);
  element.readyState = 2; element.dispatchEvent(new Event('loadeddata')); assert.equal(ready, 1);
  element.dispatchEvent(new Event('loadeddata')); assert.equal(ready, 1);
  stop();
});
