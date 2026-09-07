import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** A reader sees the previous complete snapshot or the next one, never partial JSON. */
export async function atomicJobWrite(file: string, contents: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, 'utf8');
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

interface PersistenceClock {
  schedule(callback: () => void, delayMs: number): () => void;
}
const clock: PersistenceClock = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Progress is sampled on a non-resetting deadline; lifecycle changes await a flush. */
export function createJobPersistence(
  snapshot: () => unknown,
  write: (contents: string) => Promise<void>,
  onProgressError: (error: unknown) => void,
  scheduler: PersistenceClock = clock,
  intervalMs = 2000,
) {
  let queue: Promise<void> = Promise.resolve();
  let cancelTimer: (() => void) | undefined;
  let progressInFlight = false;
  let progressDirty = false;
  async function flush() {
    progressDirty = false;
    cancelTimer?.();
    cancelTimer = undefined;
    // Snapshot now, before queueing: later changes cannot mutate this barrier.
    const contents = JSON.stringify(snapshot(), null, 2);
    const task = queue.then(() => write(contents));
    queue = task.then(() => undefined, () => undefined);
    return task;
  }
  function progress() {
    progressDirty = true;
    if (cancelTimer || progressInFlight) return;
    cancelTimer = scheduler.schedule(() => {
      cancelTimer = undefined;
      progressInFlight = true;
      void flush().catch(onProgressError).finally(() => {
        progressInFlight = false;
        // Slow storage retains only a dirty bit, not an unbounded queue of
        // progress snapshots. A lifecycle flush can overtake the next deadline.
        if (progressDirty) progress();
      });
    }, intervalMs);
  }
  return { flush, progress };
}
