import fs from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type {
  CaptionAppearance,
  CaptionGenerationModel,
  CaptionSegment,
  ProcessingJob,
  ProcessingJobType,
  RegenerationRefinementInput,
  TranscriptionContext,
  VideoExportSettings,
} from '@kcs/shared';
import { config } from '../config.js';
import { jobAdmission } from './job-admission.js';
import { store } from './store.js';
import { analyticsBuckets, captureAnalytics } from './analytics.js';
import { createRangeRegenerationProposal, refineRegenerationProposal, transcribeProject } from './project-processing.js';
import { withProcessingRun } from './run-context.js';
import { removeRunCheckpoints } from './run-checkpoints.js';
import { renderCaptionedVideo } from './video-export.js';
import { cleanupStaleVideoExportWork } from './export-maintenance.js';
import { atomicJobWrite, createJobPersistence } from './job-persistence.js';
import { isCaptionGenerationModel, resolveGenerationSettings, type GenerationModelPair } from './generation-settings.js';
import { exportFingerprint, recordExportEvidence } from './export-evidence.js';
import { verifyExportPublication, type ExportPublication } from './export-publication.js';

interface JobPayload {
  generationModel?: CaptionGenerationModel;
  geminiModels?: GenerationModelPair;
  sourceMediaFilename?: string;
  sourceMediaSize?: number;
  transcriptionContext?: TranscriptionContext;
  force?: boolean;
  startMs?: number;
  endMs?: number;
  proposalId?: string;
  strategy?: RegenerationRefinementInput['strategy'];
  accuracyHint?: string;
  editedText?: string;
  useProposalAsBaseline?: boolean;
  exportSettings?: VideoExportSettings;
  exportAppearance?: CaptionAppearance;
  exportCaptions?: CaptionSegment[];
  exportMediaFilename?: string;
  exportMediaSize?: number;
  /** Durable pre-publication identity; never inferred from an export filename. */
  exportPublication?: ExportPublication;
}

interface JobPerformance {
  runStartedAt: string;
  totalMs: number;
  stageMs: Record<string, number>;
}

interface StoredJob extends ProcessingJob {
  payload: JobPayload;
  cancelRequested?: boolean;
  /** Internal diagnostics returned in job JSON but intentionally not required by the UI contract. */
  performance?: JobPerformance;
}

interface RuntimePerformanceState {
  runStartedAt: string;
  startedMs: number;
  lastMs: number;
  lastStage: string;
  stageMs: Record<string, number>;
}

type JobSubscriber = (snapshot: ProcessingJob[]) => void;
type JobLane = 'caption' | 'export';

let jobs: StoredJob[] = [];
let publishedJobs: StoredJob[] = [];
let historyUnavailable = true;
let historyRetry: Promise<void> | null = null;
let mutationQueue: Promise<void> = Promise.resolve();
const pumping: Record<JobLane, boolean> = { caption: false, export: false };
const performanceStates = new Map<string, RuntimePerformanceState>();
const subscribers = new Set<JobSubscriber>();
const persistence = createJobPersistence(
  () => jobs.slice(0, 80),
  (contents) => atomicJobWrite(config.jobsFile, contents),
  () => console.warn('[jobs] Progress snapshot could not be saved; the next update will retry.'),
);

export class JobHistoryUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Saved Activity could not be read safely. Existing history was kept. Retry Activity after checking local storage.', options);
    this.name = 'JobHistoryUnavailableError';
  }
}

export class JobPersistenceError extends Error {
  constructor(options?: ErrorOptions) {
    super('Studio could not save the processing request. Existing saved work was kept. Check local storage and try again.', options);
    this.name = 'JobPersistenceError';
  }
}

function assertHistoryAvailable() {
  if (historyUnavailable) throw new JobHistoryUnavailableError();
}

/** Serialize snapshot capture so progress cannot persist a failed admission.
 * Create/resume/start publish only after commit; ordinary processing patches
 * retain their existing immediate read visibility and sampled progress writes. */
function serializeMutation<T>(operation: () => Promise<T>, requireHistory = true, rollbackOnFailure = true): Promise<T> {
  const task = mutationQueue.then(async () => {
    if (requireHistory) assertHistoryAvailable();
    const previous = jobs;
    try {
      const result = await operation();
      if (publishedJobs !== jobs) {
        publishedJobs = jobs;
        notifySubscribers();
      }
      return result;
    } catch (error) {
      if (rollbackOnFailure) jobs = previous;
      throw error;
    }
  });
  mutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

function laneFor(type: ProcessingJobType): JobLane {
  return type === 'export-video' ? 'export' : 'caption';
}

function beginPerformance(id: string) {
  const now = Date.now();
  const state: RuntimePerformanceState = {
    runStartedAt: new Date(now).toISOString(),
    startedMs: now,
    lastMs: now,
    lastStage: 'starting',
    stageMs: {},
  };
  performanceStates.set(id, state);
  return performanceSnapshot(state, now);
}

function performanceSnapshot(state: RuntimePerformanceState, now = Date.now()): JobPerformance {
  return {
    runStartedAt: state.runStartedAt,
    totalMs: Math.max(0, now - state.startedMs),
    stageMs: { ...state.stageMs },
  };
}

function advancePerformance(id: string, nextStage: string) {
  const state = performanceStates.get(id);
  if (!state) return undefined;
  const now = Date.now();
  const elapsed = Math.max(0, now - state.lastMs);
  state.stageMs[state.lastStage] = (state.stageMs[state.lastStage] || 0) + elapsed;
  state.lastMs = now;
  state.lastStage = nextStage;
  return performanceSnapshot(state, now);
}

function finishPerformance(id: string, terminalStage: string) {
  const snapshot = advancePerformance(id, terminalStage);
  const state = performanceStates.get(id);
  if (!state) return snapshot;
  const final = performanceSnapshot(state);
  performanceStates.delete(id);
  return final;
}

function isStoredJob(value: unknown): value is StoredJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const job = value as StoredJob;
  return ['id', 'projectId', 'projectTitle', 'stage', 'message', 'createdAt', 'updatedAt']
    .every((key) => typeof (job as unknown as Record<string, unknown>)[key] === 'string')
    && ['transcribe', 'regenerate-range', 'refine-proposal', 'export-video'].includes(job.type)
    && ['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled'].includes(job.status)
    && Number.isFinite(job.progress) && typeof job.canResume === 'boolean'
    && Boolean(job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload));
}

async function load() {
  const publications: StoredJob[] = [];
  try {
    await serializeMutation(async () => {
      let parsed: unknown;
      try { parsed = JSON.parse(await fs.readFile(config.jobsFile, 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        parsed = [];
      }
      if (!Array.isArray(parsed) || !parsed.every(isStoredJob)) throw new Error('Invalid saved Activity structure');
      const now = new Date().toISOString();
      let interrupted = 0;
      jobs = parsed.map((job) => {
        if (job.type === 'export-video' && job.payload.exportPublication && !['completed', 'cancelled'].includes(job.status)) {
          interrupted += 1;
          const pending = { ...job, status: 'interrupted' as const, stage: 'checking-export-completion',
            message: 'Checking whether this video finished before Studio stopped. No render is being restarted.',
            updatedAt: now, canResume: false };
          publications.push(pending);
          return pending;
        }
        if (job.status !== 'running') return job;
        interrupted += 1;
        return {
          ...job,
          status: 'interrupted' as const,
          stage: 'interrupted',
          message: job.type === 'export-video'
            ? 'Studio stopped during this video export. Resume restarts the render with the saved caption and export snapshot.'
            : 'The app stopped during this job. Resume uses saved processing checkpoints where possible.',
          updatedAt: now,
          canResume: true,
        };
      }).slice(0, 80);
      if (interrupted) {
        await persist();
        console.warn(`[jobs] Recovered ${interrupted} interrupted job${interrupted === 1 ? '' : 's'} after restart. Resume from Activity to continue.`);
      }
      historyUnavailable = false;
    }, false);
  } catch (cause) {
    historyUnavailable = true;
    throw new JobHistoryUnavailableError({ cause });
  }
  // Large completed videos are hashed after startup, once per saved intent. The
  // pending rows are already visible and cannot be resumed during this read.
  if (publications.length) setImmediate(() => {
    void reconcileExportPublications(publications).catch(() => console.warn('[jobs] Saved export completion could not be checked.'));
  });
}

async function reconcileExportPublications(pending: StoredJob[]) {
  for (const captured of pending) {
    const publication = captured.payload.exportPublication;
    const checked = await verifyExportPublication(config.exportDir, publication, {
      id: captured.id, projectId: captured.projectId,
      sourceMediaFilename: captured.payload.sourceMediaFilename ?? captured.payload.exportMediaFilename,
      sourceMediaSize: captured.payload.sourceMediaSize ?? captured.payload.exportMediaSize,
    });
    try {
      await serializeMutation(async () => {
        const current = jobs.find((job) => job.id === captured.id);
        if (!current || current.stage !== 'checking-export-completion' || current.payload.exportPublication !== publication) return;
        if (checked.status === 'published') {
          await publishCompletedNow(current, {
            resultExport: checked.publication.result,
            exportContentFingerprint: checked.publication.contentFingerprint,
            message: 'Captioned video export is ready. The same verified file was recovered after Studio restarted.',
            completedAt: checked.publication.result.createdAt,
          });
        } else {
          await patchNow(current.id, { status: 'interrupted',
            stage: checked.status === 'missing' ? 'interrupted' : 'export-completion-uncertain',
            canResume: checked.status === 'missing',
            message: checked.status === 'missing'
              ? 'Studio stopped before this video was published. Resume explicitly restarts the render with its saved caption and export snapshot.'
              : 'Studio stopped while finishing this video. Its saved completion could not be verified. Check the export folder before starting another render. No render was restarted.',
          }, false, undefined, true);
        }
      }, true, false);
    } catch { notifySubscribers(); }
  }
}

async function ensureHistoryAvailable() {
  if (!historyUnavailable) return;
  if (!historyRetry) {
    const pending = load();
    historyRetry = pending;
    void pending.finally(() => { if (historyRetry === pending) historyRetry = null; }).catch(() => {});
  }
  await historyRetry;
  pump();
}

async function persist() {
  try { await persistence.flush(); }
  catch (cause) { throw new JobPersistenceError({ cause }); }
}

function publicJob(job: StoredJob): ProcessingJob {
  const { payload: _payload, cancelRequested: _cancelRequested, ...value } = job;
  return value;
}

function publicSnapshot(projectId?: string) {
  return publishedJobs
    .filter((job) => !projectId || job.projectId === projectId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(publicJob);
}

function notifySubscribers() {
  if (!subscribers.size) return;
  const snapshot = publicSnapshot();
  for (const subscriber of subscribers) {
    try {
      subscriber(snapshot);
    } catch {
      // A disconnected browser must never interfere with job processing.
    }
  }
}

async function patchNow(id: string, value: Partial<StoredJob>, progressOnly = false, expectedStatuses?: StoredJob['status'][], publishBeforePersist = false) {
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0 || expectedStatuses && !expectedStatuses.includes(jobs[index].status)) return null;
  jobs = jobs.map((job, position) => position === index ? { ...job, ...value, updatedAt: new Date().toISOString() } : job);
  if (publishBeforePersist) {
    publishedJobs = jobs;
    notifySubscribers();
  }
  if (progressOnly) persistence.progress();
  else await persist();
  return jobs[index];
}

function patch(id: string, value: Partial<StoredJob>, progressOnly = false, expectedStatuses?: StoredJob['status'][]) {
  const admission = Boolean(expectedStatuses);
  return serializeMutation(() => patchNow(id, value, progressOnly, expectedStatuses, !admission), true, admission);
}

/** Internal progress observer shared by caption and render workers. */
export async function reportJobProgress(id: string, stage: string, progress: number, message: string) {
  return serializeMutation(async () => {
  const job = jobs.find((item) => item.id === id);
  if (!job) return;
  if (job.cancelRequested || job.status === 'cancelled') throw new Error('Job cancelled by user.');
  if (job.status !== 'running') return;
  const performance = advancePerformance(id, stage);
  await patchNow(id, {
    stage,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    message,
    ...(performance ? { performance } : {}),
  }, stage === job.stage, undefined, true);
  }, true, false);
}

function completedPayload(job: StoredJob): JobPayload {
  return job.type === 'export-video'
    ? {
      exportSettings: job.payload.exportSettings,
      exportAppearance: job.payload.exportAppearance,
      sourceMediaFilename: job.payload.sourceMediaFilename,
      sourceMediaSize: job.payload.sourceMediaSize,
      exportMediaFilename: job.payload.exportMediaFilename,
      exportMediaSize: job.payload.exportMediaSize,
      exportPublication: job.payload.exportPublication,
    }
    : job.payload;
}

/** Successful processing must never become failed work because Activity could not save. */
async function publishCompletedNow(job: StoredJob, value: Partial<StoredJob>) {
  const completion: Partial<StoredJob> = {
    ...value,
    payload: completedPayload(job),
    status: 'completed',
    stage: 'complete',
    progress: 100,
    completedAt: value.completedAt || new Date().toISOString(),
    canResume: false,
    error: undefined,
  };
  try { await patchNow(job.id, completion, false, undefined, true); }
  catch (error) {
    if (!(error instanceof JobPersistenceError)) throw error;
    // patchNow has already published the completed result. Preserve that result
    // and explain the durability failure; do not enter execute's failure path.
    const index = jobs.findIndex((item) => item.id === job.id);
    if (index >= 0 && jobs[index].status === 'completed') {
      jobs = jobs.map((item, position) => position === index ? { ...item,
        message: `${value.message || 'Processing completed.'} Activity could not save this completion. Keep the finished result before closing Studio.`,
        canResume: false,
      } : item);
      publishedJobs = jobs;
      notifySubscribers();
    }
  }
}

async function completeJob(job: StoredJob, value: Partial<StoredJob>, captionCount?: number) {
  const performance = finishPerformance(job.id, 'complete');
  await serializeMutation(() => publishCompletedNow(job, { ...value, performance }), true, false);
  if (job.type !== 'export-video') {
    void captureAnalytics('generation_completed', {
      job_type: job.type,
      timing_ms_bucket: analyticsBuckets.milliseconds(performance?.totalMs || 0),
      ...(captionCount == null ? {} : { caption_count_bucket: analyticsBuckets.captions(captionCount) }),
    });
  }
}

export class StaleJobMediaError extends Error {
  constructor() { super('This saved job belongs to an older or unverified media version. Start a new operation from the current project.'); }
}

export async function assertJobMediaCurrent(projectId: string, payload: Pick<JobPayload, 'sourceMediaFilename' | 'sourceMediaSize' | 'exportMediaFilename' | 'exportMediaSize'>) {
  const project = await store.getMedia(projectId);
  const filename = payload.sourceMediaFilename ?? payload.exportMediaFilename;
  const size = payload.sourceMediaSize ?? payload.exportMediaSize;
  if (!project || !filename || !Number.isFinite(size) || project.media.filename !== filename || project.media.size !== size) throw new StaleJobMediaError();
}

async function executeJobOperation(job: StoredJob) {
  await assertJobMediaCurrent(job.projectId, job.payload);
  if (job.type === 'export-video') {
    const project = await store.get(job.projectId);
    if (!project) throw new Error('Project not found');
    if (!job.payload.exportSettings || !job.payload.exportAppearance || !job.payload.exportCaptions) {
      throw new Error('This video export does not contain a complete saved render snapshot. Start a new export.');
    }
    if (project.media.filename !== job.payload.exportMediaFilename || project.media.size !== job.payload.exportMediaSize) {
      throw new Error('The project media changed after this export was created. Start a new export from the current video.');
    }
    const exportedSnapshot = { ...project, captions: job.payload.exportCaptions,
      captionAppearance: job.payload.exportAppearance, transcript: null, transcriptNeedsSync: true };
    const exportContentFingerprint = exportFingerprint(exportedSnapshot, 'video');
    const result = await renderCaptionedVideo(
      project,
      job.payload.exportCaptions,
      job.payload.exportAppearance,
      job.payload.exportSettings,
      {
        onProgress: (progress, message) => reportJobProgress(job.id, 'video-export', progress, message),
        shouldCancel: () => Boolean(publishedJobs.find((item) => item.id === job.id)?.cancelRequested),
        beforePublish: async (result, sha256) => {
          const publication: ExportPublication = { version: 1, jobId: job.id, projectId: job.projectId,
            sourceMediaFilename: job.payload.sourceMediaFilename ?? job.payload.exportMediaFilename!,
            sourceMediaSize: job.payload.sourceMediaSize ?? job.payload.exportMediaSize!,
            result, sha256, contentFingerprint: exportContentFingerprint };
          const saved = await serializeMutation(async () => {
            const current = jobs.find((item) => item.id === job.id);
            if (!current || current.status !== 'running' || current.cancelRequested) throw new Error('Video export cancelled.');
            return patchNow(job.id, { payload: { ...current.payload, exportPublication: publication } }, false, ['running']);
          });
          if (!saved) throw new Error('The verified video could not be reserved for publication.');
          job = saved;
        },
      },
    );
    const evidenceSaved = await recordExportEvidence(exportedSnapshot, 'video');
    await completeJob(job, {
      message: evidenceSaved ? 'Captioned video export is ready.' : 'Captioned video export is ready. Export history could not be saved; freshness is unknown.',
      resultExport: result,
      exportContentFingerprint,
    });
    void captureAnalytics('export_completed', {
      result: 'captioned-video',
      duration_bucket: analyticsBuckets.durationSeconds(result.durationMs / 1000),
    });
    return;
  }
  if (job.type === 'transcribe') {
    const result = await transcribeProject(job.projectId, job.payload.transcriptionContext, job.payload.force, (stage, progress, message) => reportJobProgress(job.id, stage, progress, message));
    await completeJob(job, {
      message: 'Full transcription and local timing completed.',
      resultProjectId: result.id,
    }, result.captions.length);
    return;
  }
  if (job.type === 'regenerate-range') {
    const proposal = await createRangeRegenerationProposal(
      job.projectId,
      Number(job.payload.startMs),
      Number(job.payload.endMs),
      job.payload.transcriptionContext,
      (stage, progress, message) => reportJobProgress(job.id, stage, progress, message),
    );
    await completeJob(job, {
      message: 'Regeneration preview is ready for live A/B review.',
      proposalId: proposal.id,
    }, proposal.proposedCaptions.length);
    return;
  }
  if (!job.payload.proposalId || !job.payload.strategy) throw new Error('Refinement job is missing its proposal or strategy.');
  const proposal = await refineRegenerationProposal(
    job.projectId,
    job.payload.proposalId,
    {
      strategy: job.payload.strategy,
      accuracyHint: job.payload.accuracyHint,
      editedText: job.payload.editedText,
      useProposalAsBaseline: job.payload.useProposalAsBaseline,
    },
    (stage, progress, message) => reportJobProgress(job.id, stage, progress, message),
  );
  await completeJob(job, {
    message: `Refinement pass ${proposal.passNumber} is ready for live A/B review.`,
    proposalId: proposal.id,
  }, proposal.proposedCaptions.length);
}

async function execute(job: StoredJob) {
  const performance = beginPerformance(job.id);
  let started: StoredJob | null;
  try { started = await patch(job.id, {
    status: 'running',
    startedAt: new Date().toISOString(),
    stage: 'starting',
    progress: 1,
    message: job.type === 'export-video' ? 'Preparing captioned video export…' : 'Starting processing job…',
    error: undefined,
    canResume: false,
    cancelRequested: false,
    performance,
  }, false, ['queued']); }
  catch {
    finishPerformance(job.id, 'interrupted');
    // The queued request is durable, but work never started. Make its explicit
    // Resume path reachable even while storage still rejects this recovery note.
    // A cancellation or a newer transition queued during the failed write wins.
    try {
      await serializeMutation(() => patchNow(job.id, {
        status: 'interrupted', stage: 'interrupted', canResume: true,
        message: 'Studio could not save the start of this job. No processing was started. Check local storage, then choose Resume.',
      }, false, ['queued'], true), true, false);
    } catch { notifySubscribers(); }
    // The failed request is now interrupted (or a newer action owns its state).
    // Continue to another admitted job; a failed start must not lose its wakeup.
    return true;
  }
  // A cancellation may have committed while this worker waited for the lane.
  if (!started) { finishPerformance(job.id, 'cancelled'); return true; }
  job = started;
  try {
    // Older jobs predate per-project selection. Snapshot Automatic once on their
    // first execution/resume, then retain it just like newly admitted jobs.
    if (job.type !== 'export-video' && !job.payload.geminiModels) {
      const { model, fallbackModel } = await resolveGenerationSettings('automatic');
      job = { ...job, payload: { ...job.payload, geminiModels: { model, fallbackModel } } };
      await patch(job.id, { payload: job.payload });
    }
    if (job.type === 'export-video') await executeJobOperation(job);
    else await withProcessingRun({ projectId: job.projectId, runKey: job.id, geminiModels: job.payload.geminiModels }, () => executeJobOperation(job));
    if (job.type !== 'export-video') await removeRunCheckpoints(job.projectId, job.id).catch(() => {});
  } catch (error) {
    const cancelled = publishedJobs.find((item) => item.id === job.id)?.cancelRequested;
    const terminalStage = cancelled ? 'cancelled' : 'failed';
    const finalPerformance = finishPerformance(job.id, terminalStage);
    await patch(job.id, {
      status: cancelled ? 'cancelled' : 'failed',
      stage: terminalStage,
      message: cancelled
        ? job.type === 'export-video' ? 'Video export cancelled. The partial file was removed.' : 'Job cancelled.'
        : job.type === 'export-video' ? 'Video export failed. The source project and captions are unchanged.' : 'Processing failed. Saved checkpoints remain available for retry.',
      error: cancelled ? undefined : error instanceof Error ? error.message : 'Processing failed',
      completedAt: new Date().toISOString(),
      canResume: !cancelled && !(error instanceof StaleJobMediaError),
      performance: finalPerformance,
    });
    if (!cancelled && job.type !== 'export-video') {
      void captureAnalytics('generation_failed', {
        job_type: job.type,
        timing_ms_bucket: analyticsBuckets.milliseconds(finalPerformance?.totalMs || 0),
      });
    }
    if (cancelled && job.type !== 'export-video') await removeRunCheckpoints(job.projectId, job.id).catch(() => {});
  }
  return true;
}

async function pumpLane(lane: JobLane) {
  if (pumping[lane]) return;
  pumping[lane] = true;
  try {
    while (true) {
      const next = publishedJobs.find((job) => job.status === 'queued' && laneFor(job.type) === lane);
      if (!next) break;
      if (!await execute(next)) break;
    }
  } finally {
    pumping[lane] = false;
  }
}

function pump() {
  if (historyUnavailable) return;
  const failed = () => console.warn('[jobs] Processing stopped while saving Activity. Saved checkpoints remain available after restart.');
  void pumpLane('caption').catch(failed);
  void pumpLane('export').catch(failed);
}

/** Reports whether this call reserved a new job in the same in-memory duplicate decision. */
async function createWithDisposition(type: ProcessingJobType, projectId: string, payload: JobPayload): Promise<{ job: ProcessingJob; created: boolean }> {
  return jobAdmission.runForProject(projectId, async () => {
    assertHistoryAvailable();
    const project = await store.get(projectId);
    if (!project) throw new Error('Project not found');
    if (payload.generationModel !== undefined && !isCaptionGenerationModel(payload.generationModel)) throw new Error('Unsupported caption model choice.');
    const settings = type === 'export-video' ? undefined : await resolveGenerationSettings(payload.generationModel ?? project.generationModel);
    const result = await serializeMutation(async () => {
    const duplicate = jobs.find((job) => job.projectId === projectId && job.type === type && ['queued', 'running'].includes(job.status));
    if (duplicate) return { job: publicJob(duplicate), created: false };
    const now = new Date().toISOString();
    const job: StoredJob = {
      id: nanoid(14),
      type,
      projectId,
      projectTitle: project.title,
      status: 'queued',
      stage: 'queued',
      progress: 0,
      message: type === 'export-video' ? 'Captioned video export is queued.' : 'Waiting for the local processing worker…',
      createdAt: now,
      updatedAt: now,
      canResume: false,
      payload: {
        ...payload,
        // Never accept an arbitrary pair from callers or persist credentials.
        ...(settings ? { geminiModels: { model: settings.model, fallbackModel: settings.fallbackModel } } : {}),
        sourceMediaFilename: project.media.filename, sourceMediaSize: project.media.size,
      },
    };
    // No await between the duplicate check and this reservation: concurrent
    // callers cannot both report created:true for this project and job type.
    jobs = [job, ...jobs].slice(0, 80);
    await persist();
    return { job: publicJob(job), created: true };
    });
    if (result.created && type !== 'export-video') void captureAnalytics('generation_started', { job_type: type });
    // Retrying a durably queued request also restarts a lane whose start-state
    // write previously failed. A running duplicate never starts another worker.
    pump();
    return result;
  });
}

await cleanupStaleVideoExportWork();
await load().catch(() => console.warn('[jobs] Saved Activity is unavailable. Existing history was kept; Retry Activity to check it again.'));
queueMicrotask(pump);

export const jobStore = {
  historyIsAvailable() { return !historyUnavailable; },

  hasAnyActive() {
    // Terminal status is published in memory before durable persistence and
    // checkpoint cleanup finish. Keep the lane busy through that entire tail.
    return pumping.caption || pumping.export || publishedJobs.some((job) => ['queued', 'running'].includes(job.status));
  },

  hasActiveForProject(projectId: string) {
    return publishedJobs.some((job) => job.projectId === projectId && ['queued', 'running'].includes(job.status));
  },

  hasActiveCaptionJobForProject(projectId: string) {
    return publishedJobs.some((job) => job.projectId === projectId
      && laneFor(job.type) === 'caption'
      && ['queued', 'running'].includes(job.status));
  },

  subscribe(subscriber: JobSubscriber) {
    assertHistoryAvailable();
    subscribers.add(subscriber);
    subscriber(publicSnapshot());
    return () => subscribers.delete(subscriber);
  },

  async removeProject(projectId: string) {
    return serializeMutation(async () => {
    if (this.hasActiveForProject(projectId)) throw new Error('Wait for the active processing job to finish or cancel it before removing this project.');
    jobs = jobs.filter((job) => job.projectId !== projectId);
    publishedJobs = jobs;
    notifySubscribers();
    await persist();
    }, true, false);
  },

  async list(projectId?: string) {
    await ensureHistoryAvailable();
    return publicSnapshot(projectId);
  },

  async get(id: string) {
    assertHistoryAvailable();
    const job = publishedJobs.find((item) => item.id === id);
    return job ? publicJob(job) : null;
  },

  async create(type: ProcessingJobType, projectId: string, payload: JobPayload) {
    return (await createWithDisposition(type, projectId, payload)).job;
  },

  /** Use when the caller must know whether this request actually created the job. */
  createWithDisposition,

  async resume(id: string) {
    return jobAdmission.run(async () => {
    assertHistoryAvailable();
    const job = publishedJobs.find((item) => item.id === id);
    if (!job) throw new Error('Job not found');
    return jobAdmission.runForProject(job.projectId, async () => {
      await serializeMutation(async () => {
      const job = jobs.find((item) => item.id === id);
      if (!job) throw new Error('Job not found');
      if (!['failed', 'interrupted'].includes(job.status)) throw new Error('Only failed or interrupted jobs can be resumed.');
      if (job.type === 'export-video' && job.payload.exportPublication && !job.canResume) {
        throw new Error('This video may already have finished. Check its completion in Activity and the export folder before starting another render.');
      }
      if (jobs.some((other) => other.id !== id && other.projectId === job.projectId && other.type === job.type && ['queued', 'running'].includes(other.status))) {
        throw new Error('Another job of this kind is already active for this project. Finish or cancel it before resuming this saved job.');
      }
      await assertJobMediaCurrent(job.projectId, job.payload);
      if (job.type === 'export-video' && (!job.payload.exportCaptions || !job.payload.exportSettings || !job.payload.exportAppearance)) {
        throw new Error('This older export job no longer has a complete render snapshot. Start a new export.');
      }
      await patchNow(id, {
        status: 'queued',
        stage: 'queued',
        progress: 0,
        message: job.type === 'export-video'
          ? 'Export queued again with the saved caption and quality settings.'
          : 'Queued again. Saved stage checkpoints will be reused when valid.',
        error: undefined,
        completedAt: undefined,
        canResume: false,
        cancelRequested: false,
        performance: undefined,
        payload: { ...job.payload, exportPublication: undefined },
      });
      });
    if (job.type !== 'export-video') void captureAnalytics('generation_started', { job_type: job.type });
    pump();
    return (await this.get(id))!;
    });
    });
  },

  async cancel(id: string) {
    await serializeMutation(async () => {
    const job = jobs.find((item) => item.id === id);
    if (!job) throw new Error('Job not found');
    if (job.status === 'queued') {
      await patchNow(id, { status: 'cancelled', stage: 'cancelled', message: job.type === 'export-video' ? 'Video export cancelled before it started.' : 'Job cancelled before it started.', completedAt: new Date().toISOString(), canResume: false }, false, undefined, true);
      if (job.type !== 'export-video') await removeRunCheckpoints(job.projectId, job.id).catch(() => {});
    } else if (job.status === 'running') {
      await patchNow(id, { cancelRequested: true, message: job.type === 'export-video' ? 'Cancellation requested. Stopping the local video encoder…' : 'Cancellation requested. The current external stage may finish first.' }, false, undefined, true);
    }
    }, true, false);
    return (await this.get(id))!;
  },
};
