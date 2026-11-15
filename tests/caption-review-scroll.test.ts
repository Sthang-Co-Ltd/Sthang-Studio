import assert from 'node:assert/strict';
import test from 'node:test';
import { planReviewScroll, survivingReviewAnchorShift } from '../apps/web/src/components/review-scroll-policy.js';

const viewport = {
  viewportTop: 100,
  viewportBottom: 700,
  scrollTop: 480,
  requestedBehavior: 'smooth' as const,
  reducedMotion: false,
};

test('Review keeps an already comfortable decision row fixed instead of centering it', () => {
  assert.equal(planReviewScroll({ ...viewport, rowTop: 290, rowBottom: 370 }), null);
  assert.equal(planReviewScroll({ ...viewport, rowTop: 165, rowBottom: 250 }), null);
});

test('nearby Review moves use only the minimum displacement and avoid repeated smooth travel', () => {
  assert.deepEqual(planReviewScroll({ ...viewport, rowTop: 133, rowBottom: 213 }), { top: 465, behavior: 'instant' });
  assert.deepEqual(planReviewScroll({ ...viewport, rowTop: 658, rowBottom: 738 }), { top: 566, behavior: 'instant' });
  assert.deepEqual(planReviewScroll({ ...viewport, rowTop: 110, rowBottom: 750 }), { top: 442, behavior: 'instant' });
});

test('distant navigation may ease once, but reduced motion uses instant scroll explicitly', () => {
  const far = { ...viewport, rowTop: 1400, rowBottom: 1480 };
  assert.deepEqual(planReviewScroll(far), { top: 1308, behavior: 'smooth' });
  assert.deepEqual(planReviewScroll({ ...far, reducedMotion: true }), { top: 1308, behavior: 'instant' });
  assert.equal(planReviewScroll({ ...far, viewportBottom: 100 }), null);
});

test('rapid queue removals preserve the next decision if it survives, then a visible fallback', () => {
  const anchors = [
    { id: 'just-approved', offset: 108 },
    { id: 'next', offset: 204 },
    { id: 'later', offset: 300 },
  ];
  const afterFirst = new Map([['next', 108], ['later', 204]]);
  assert.equal(survivingReviewAnchorShift(anchors, (id) => afterFirst.get(id) ?? null, 'next'), -96);

  const afterSecond = new Map([['later', 108]]);
  assert.equal(survivingReviewAnchorShift(anchors, (id) => afterSecond.get(id) ?? null, 'next'), -192);
  assert.equal(survivingReviewAnchorShift(anchors, () => null, 'next'), null);
});
