import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { ProcessingJob, ProcessingJobType, RegenerationRefinementInput, TranscriptionContext } from '@kcs/shared';
import { config } from '../config.js';
import { store } from './store.js';
import { analyticsBuckets, captureAnalytics } from './analytics.js';
import { createRangeRegenerationProposal, refineRegenerationProposal, transcribeProject } from './project-processing.js';
import { withProcessingRun } from './run-context.js';
import { removeRunCheckpoints } from './run-checkpoints.js';

interface JobPayload {
  transcriptionContext?: TranscriptionContext;
  force?: boolean;
  startMs?: number;
  endMs?: number;
  proposalId?: string;
  strategy?: RegenerationRefinementInput['strategy'];
  accuracyHint?: string;
  editedText?: string;
  useProposalAsBaseline?: boolean;
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

let jobs: StoredJob[] = [];
let pumping = false;
const performanceStates = new Map<string, RuntimePerformanceState>();
const subscribers = new Set<JobSubscriber>();

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

async function load() {
  try {
    const parsed = JSON.parse(await fs.readFile(config.jobsFile, 'utf8')) as StoredJob[];
    jobs = Array.isArray(parsed) ? parsed : [];
  } catch {
    jobs = [];
  }
  const now = new Date().toISOString();
  let changed = false;
  jobs = jobs.map((job) => {
    if (job.status !== 'running') return job;
    changed = true;
    return {
      ...job,
      status: 'interrupted' as const,
      stage: 'interrupted',
      message: 'The app stopped during this job. Resume uses saved processing checkpoints where possible.',
      updatedAt: now,
      canResume: true,
    };
  }).slice(0, 80);
  if (changed) await persist();
}

async function persist() {
  await fs.mkdir(path.dirname(config.jobsFile), { recursive: true });
  await fs.writeFile(config.jobsFile, JSON.stringify(jobs.slice(0, 80), null, 2), 'utf8');
}

function publicJob(job: StoredJob): ProcessingJob {
  const { payload: _payload, cancelRequested: _cancelRequested, ...value } = job;
  return value;
}

function publicSnapshot(projectId?: string) {
  return jobs
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

async function patch(id: string, value: Partial<StoredJob>) {
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0) return null;
  jobs[index] = { ...jobs[index], ...value, updatedAt: new Date().toISOString() };
  await persist();
  notifySubscribers();
  return jobs[index];
}

async function report(id: string, stage: string, progress: number, message: string) {
  const job = jobs.find((item) => item.id === id);
  if (!job) return;
  if (job.cancelRequested) throw new Error('Job cancelled by user.');
  const performance = advancePerformance(id, stage);
  await patch(id, {
    stage,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    message,
    ...(performance ? { performance } : {}),
  });
}

async function completeJob(job: StoredJob, value: Partial<StoredJob>, captionCount?: number) {
  const performance = finishPerformance(job.id, 'complete');
  await patch(job.id, {
    ...value,
    status: 'completed',
    stage: 'complete',
    progress: 100,
    completedAt: new Date().toISOString(),
    canResume: false,
    performance,
  });
  void captureAnalytics('generation_completed', {
    job_type: job.type,
    timing_ms_bucket: analyticsBuckets.milliseconds(performance?.totalMs || 0),
    ...(captionCount == null ? {} : { caption_count_bucket: analyticsBuckets.captions(captionCount) }),
  });
}

async function executeJobOperation(job: StoredJob) {
  if (job.type === 'transcribe') {
    const result = await transcribeProject(job.projectId, job.payload.transcriptionContext, job.payload.force, (stage, progress, message) => report(job.id, stage, progress, message));
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
      (stage, progress, message) => report(job.id, stage, progress, message),
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
    (stage, progress, message) => report(job.id, stage, progress, message),
  );
  await completeJob(job, {
    message: `Refinement pass ${proposal.passNumber} is ready for live A/B review.`,
    proposalId: proposal.id,
  }, proposal.proposedCaptions.length);
}

async function execute(job: StoredJob) {
  const performance = beginPerformance(job.id);
  await patch(job.id, {
    status: 'running',
    startedAt: new Date().toISOString(),
    stage: 'starting',
    progress: 1,
    message: 'Starting processing job…',
    error: undefined,
    canResume: false,
    cancelRequested: false,
    performance,
  });
  try {
    await withProcessingRun({ projectId: job.projectId, runKey: job.id }, () => executeJobOperation(job));
    await removeRunCheckpoints(job.projectId, job.id).catch(() => {});
  } catch (error) {
    const cancelled = jobs.find((item) => item.id === job.id)?.cancelRequested;
    const terminalStage = cancelled ? 'cancelled' : 'failed';
    const finalPerformance = finishPerformance(job.id, terminalStage);
    await patch(job.id, {
      status: cancelled ? 'cancelled' : 'failed',
      stage: terminalStage,
      message: cancelled ? 'Job cancelled.' : 'Processing failed. Saved checkpoints remain available for retry.',
      error: error instanceof Error ? error.message : 'Processing failed',
      completedAt: new Date().toISOString(),
      canResume: !cancelled,
      performance: finalPerformance,
    });
    if (!cancelled) {
      void captureAnalytics('generation_failed', {
        job_type: job.type,
        timing_ms_bucket: analyticsBuckets.milliseconds(finalPerformance?.totalMs || 0),
      });
    }
    if (cancelled) await removeRunCheckpoints(job.projectId, job.id).catch(() => {});
  }
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const next = jobs.find((job) => job.status === 'queued');
      if (!next) break;
      await execute(next);
    }
  } finally {
    pumping = false;
  }
}

await load();
queueMicrotask(() => { void pump(); });

export const jobStore = {
  hasAnyActive() {
    return jobs.some((job) => ['queued', 'running'].includes(job.status));
  },

  hasActiveForProject(projectId: string) {
    return jobs.some((job) => job.projectId === projectId && ['queued', 'running'].includes(job.status));
  },

  subscribe(subscriber: JobSubscriber) {
    subscribers.add(subscriber);
    subscriber(publicSnapshot());
    return () => subscribers.delete(subscriber);
  },

  async removeProject(projectId: string) {
    if (this.hasActiveForProject(projectId)) throw new Error('Wait for the active processing job to finish or cancel it before removing this project.');
    jobs = jobs.filter((job) => job.projectId !== projectId);
    await persist();
    notifySubscribers();
  },

  async list(projectId?: string) {
    return publicSnapshot(projectId);
  },

  async get(id: string) {
    const job = jobs.find((item) => item.id === id);
    return job ? publicJob(job) : null;
  },

  async create(type: ProcessingJobType, projectId: string, payload: JobPayload) {
    const project = await store.get(projectId);
    if (!project) throw new Error('Project not found');
    const duplicate = jobs.find((job) => job.projectId === projectId && job.type === type && ['queued', 'running'].includes(job.status));
    if (duplicate) return publicJob(duplicate);
    const now = new Date().toISOString();
    const job: StoredJob = {
      id: nanoid(14),
      type,
      projectId,
      projectTitle: project.title,
      status: 'queued',
      stage: 'queued',
      progress: 0,
      message: 'Waiting for the local processing worker…',
      createdAt: now,
      updatedAt: now,
      canResume: false,
      payload,
    };
    jobs.unshift(job);
    jobs = jobs.slice(0, 80);
    await persist();
    notifySubscribers();
    void captureAnalytics('generation_started', { job_type: type });
    void pump();
    return publicJob(job);
  },

  async resume(id: string) {
    const job = jobs.find((item) => item.id === id);
    if (!job) throw new Error('Job not found');
    if (!['failed', 'interrupted'].includes(job.status)) throw new Error('Only failed or interrupted jobs can be resumed.');
    await patch(id, {
      status: 'queued',
      stage: 'queued',
      progress: 0,
      message: 'Queued again. Saved stage checkpoints will be reused when valid.',
      error: undefined,
      completedAt: undefined,
      canResume: false,
      cancelRequested: false,
      performance: undefined,
    });
    void captureAnalytics('generation_started', { job_type: job.type });
    void pump();
    return (await this.get(id))!;
  },

  async cancel(id: string) {
    const job = jobs.find((item) => item.id === id);
    if (!job) throw new Error('Job not found');
    if (job.status === 'queued') {
      await patch(id, { status: 'cancelled', stage: 'cancelled', message: 'Job cancelled before it started.', completedAt: new Date().toISOString(), canResume: false });
      await removeRunCheckpoints(job.projectId, job.id).catch(() => {});
    } else if (job.status === 'running') {
      await patch(id, { cancelRequested: true, message: 'Cancellation requested. The current external stage may finish first.' });
    }
    return (await this.get(id))!;
  },
};
