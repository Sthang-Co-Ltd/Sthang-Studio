/** One synchronous admission boundary for every browser tab and job lane. */
export class JobAdmissionError extends Error {
  readonly httpStatus = 409;
  constructor(message = 'Studio is preparing an update. Wait for it to finish before starting or resuming work.') {
    super(message);
    this.name = 'JobAdmissionError';
  }
}

export function createJobAdmissionGate() {
  let admissions = 0;
  let updating = false;
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (updating) throw new JobAdmissionError();
      // Reserve before the first await, including project reads and persistence.
      admissions += 1;
      try { return await operation(); }
      finally { admissions -= 1; }
    },
    beginUpdate(hasActiveJobs: () => boolean) {
      if (updating) throw new JobAdmissionError('An update is already being prepared.');
      if (admissions || hasActiveJobs()) throw new JobAdmissionError('Finish or cancel active work before installing an update.');
      updating = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        updating = false;
      };
    },
  };
}

export const jobAdmission = createJobAdmissionGate();
