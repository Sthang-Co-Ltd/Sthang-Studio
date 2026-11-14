import type { ProcessingJob } from '@kcs/shared';

/** A resumed job keeps its id, but its next terminal observation is new work. */
export function jobObservation(job: ProcessingJob): string {
  return `${job.status}:${job.updatedAt}`;
}

/** Delayed reads must not roll an already observed job backwards. */
export function mergeJobSnapshot(current: readonly ProcessingJob[], incoming: readonly ProcessingJob[]): ProcessingJob[] {
  const known = new Map(current.map((job) => [job.id, job]));
  return incoming.map((job) => {
    const previous = known.get(job.id);
    if (!previous) return job;
    const previousTime = Date.parse(previous.updatedAt);
    const incomingTime = Date.parse(job.updatedAt);
    // Completed jobs cannot resume. Millisecond clock ties are not evidence
    // that a later-arriving active row is newer than an observed completion.
    return previousTime > incomingTime
      || previousTime === incomingTime && previous.status === 'completed' && job.status !== 'completed'
      ? previous : job;
  });
}
