import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackFailureMessage, recoveryPosition, restoredPosition } from '../apps/web/src/media-playback-recovery.js';

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
