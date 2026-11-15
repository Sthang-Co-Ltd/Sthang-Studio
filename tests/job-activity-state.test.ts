import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProcessingJob } from '@kcs/shared';
import { jobObservation, mergeJobSnapshot } from '../apps/web/src/processing-jobs';

function job(status: ProcessingJob['status'], updatedAt: string): ProcessingJob {
  return { id: 'resumable', type: 'transcribe', projectId: 'project', projectTitle: 'Project',
    status, stage: status, progress: status === 'completed' ? 100 : 50, message: status,
    canResume: status === 'failed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt };
}

test('late polling cannot undo an observed completion, including a millisecond tie', () => {
  const completed = job('completed', '2026-01-01T00:00:02.000Z');
  for (const updatedAt of ['2026-01-01T00:00:01.000Z', completed.updatedAt]) {
    const delayed = job('running', updatedAt);
    assert.equal(mergeJobSnapshot([completed], [delayed])[0], completed);
  }
});

test('fresh resume evidence replaces a failure without resurrecting removed jobs', () => {
  const failed = job('failed', '2026-01-01T00:00:01.000Z');
  const resumed = job('queued', '2026-01-01T00:00:02.000Z');
  const removed = { ...failed, id: 'removed' };
  assert.deepEqual(mergeJobSnapshot([failed, removed], [resumed]), [resumed]);
  const repeatedFailure = { ...failed, updatedAt: '2026-01-01T00:00:03.000Z' };
  assert.notEqual(jobObservation(repeatedFailure), jobObservation(failed));
  assert.equal(jobObservation({ ...repeatedFailure }), jobObservation(repeatedFailure));
});
