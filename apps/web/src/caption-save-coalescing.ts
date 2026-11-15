export interface CaptionSaveIdentity {
  /** Object identity distinguishes leaving and reopening the same media. */
  ticket: object;
  version: number;
  snapshot: object;
  recovery: object | null;
  recordCorrections: boolean;
}

/** Share only an outstanding, equally owned caption write. There is no settled
 * result cache: failure, uncertainty and a later deliberate save remain fresh.
 * A correction-recording write may cover a weaker caller, never the reverse.
 */
export function createCaptionSaveCoalescer<Result>() {
  const pending = new Set<{ identity: CaptionSaveIdentity; promise: Promise<Result> }>();
  return {
    run(identity: CaptionSaveIdentity, start: () => Promise<Result>): Promise<Result> {
      for (const entry of pending) {
        const current = entry.identity;
        if (current.ticket === identity.ticket && current.version === identity.version
          && current.snapshot === identity.snapshot && current.recovery === identity.recovery
          && (current.recordCorrections || !identity.recordCorrections)) return entry.promise;
      }
      let resolve!: (value: Result | PromiseLike<Result>) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<Result>((done, fail) => { resolve = done; reject = fail; });
      const entry = { identity: { ...identity }, promise };
      // Reserve before start: callers share the write tracking, recovery capture
      // and queue admission as well as the eventual transport operation.
      pending.add(entry);
      try {
        // A caller may resume from its mutation-queue barrier before this shared
        // promise settles. Retire the operation before publishing its result so
        // that caller's deliberate retry cannot join an already finished write.
        void start().then(
          (value) => { pending.delete(entry); resolve(value); },
          (error) => { pending.delete(entry); reject(error); },
        );
      } catch (error) { pending.delete(entry); reject(error); }
      return promise;
    },
  };
}
