import test from 'node:test';
import assert from 'node:assert/strict';
import { ownReviewPlayback } from '../apps/web/src/review-playback.js';

class Media extends EventTarget {
  paused = false;
  currentTime = 0;
  pauses = 0;
  pause() { this.pauses++; this.paused = true; }
}
test('own seek and queued pause keep the pass, then a newer native seek releases it without moving playback', () => {
  const media = new Media(); let releases = 0;
  const owner = ownReviewPlayback(media as unknown as HTMLMediaElement, 'review', 1200, true, () => releases++);
  media.dispatchEvent(new Event('pause'));
  media.dispatchEvent(new Event('seeking'));
  media.dispatchEvent(new Event('seeked'));
  assert(owner.active);
  media.currentTime = 8; media.paused = false; media.dispatchEvent(new Event('seeking'));
  assert.equal(owner.active, false); assert.equal(releases, 1); assert.equal(media.currentTime, 8); assert.equal(media.paused, false);
  media.dispatchEvent(new Event('pause')); assert.equal(releases, 1);
});
test('pause followed by native play cannot revive a retired comparison pass', () => {
  const media = new Media(); let releases = 0;
  const owner = ownReviewPlayback(media as unknown as HTMLMediaElement, 'proposal', 2000, false, () => releases++);
  media.dispatchEvent(new Event('seeked')); media.pause(); media.dispatchEvent(new Event('pause'));
  media.paused = false; media.dispatchEvent(new Event('play'));
  assert.equal(owner.active, false); assert.equal(releases, 1); assert.equal(media.currentTime, 2);
});
test('old queued pause after replay starts cannot cancel the new pass; explicit release does not pause it', () => {
  const media = new Media(); let releases = 0;
  const owner = ownReviewPlayback(media as unknown as HTMLMediaElement, 'review', 3000, false, () => releases++);
  media.dispatchEvent(new Event('pause'));
  assert(owner.active);
  owner.release();
  assert.equal(media.pauses, 0); assert.equal(media.paused, false); assert.equal(releases, 0);
});
test('a foreign seek beats the queued internal seeking event and releases exactly once', () => {
  const media = new Media(); let releases = 0;
  const owner = ownReviewPlayback(media as unknown as HTMLMediaElement, 'proposal', 500, false, () => releases++);
  media.currentTime = 9;
  media.dispatchEvent(new Event('seeking')); media.dispatchEvent(new Event('seeking')); media.dispatchEvent(new Event('seeked'));
  assert.equal(owner.active, false); assert.equal(releases, 1); assert.equal(media.currentTime, 9);
});
