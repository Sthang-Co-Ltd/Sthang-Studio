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
  const projectAdmissions = new Map<string, number>();
  const changingMedia = new Set<string>();
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (updating) throw new JobAdmissionError();
      // Reserve before the first await, including project reads and persistence.
      admissions += 1;
      try { return await operation(); }
      finally { admissions -= 1; }
    },
    async runForProject<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
      if (changingMedia.has(projectId)) throw new JobAdmissionError('This project is replacing or restoring its media. Wait for it to finish before starting work.');
      projectAdmissions.set(projectId, (projectAdmissions.get(projectId) || 0) + 1);
      try { return await this.run(operation); }
      finally {
        const remaining = (projectAdmissions.get(projectId) || 1) - 1;
        if (remaining) projectAdmissions.set(projectId, remaining);
        else projectAdmissions.delete(projectId);
      }
    },
    async changeProjectMedia<T>(projectId: string, hasActiveJobs: () => boolean, operation: () => Promise<T>): Promise<T> {
      if (updating) throw new JobAdmissionError();
      if (changingMedia.has(projectId) || projectAdmissions.has(projectId) || hasActiveJobs()) {
        throw new JobAdmissionError('A processing job is still running for this project. Finish or cancel it before replacing or restoring the media.');
      }
      // Reserve synchronously before any project lookup, upload verification, or disk I/O.
      changingMedia.add(projectId);
      try { return await this.run(operation); }
      finally { changingMedia.delete(projectId); }
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
