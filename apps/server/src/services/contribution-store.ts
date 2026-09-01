import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppProfile,
  CaptionProject,
  CaptionSegment,
  ConsentState,
  ContributionCandidate,
  ContributionStatus,
} from '@kcs/shared';
import { config } from '../config.js';
import { APP_VERSION } from '../version.js';
import { ensureNormalizedAudio, mediaFingerprint } from './cache.js';
import { approvedContributionCandidates } from './contribution-core.js';
import { makeAudioChunk } from './media.js';
import { profileStore } from './profile-store.js';
import { store } from './store.js';

interface ContributionState {
  version: 1;
  active: boolean;
  contributorId?: string;
  withdrawalToken?: string;
  joinedAt?: string;
  consentGrantedAt?: string;
  candidates: ContributionCandidate[];
  verifiedAudioMs: number;
  withdrawalPending: boolean;
  lastSyncAt?: string;
  lastError?: string;
}

interface RemoteStatusSample {
  candidateId: string;
  status: 'submitted' | 'verified' | 'rejected' | 'withdrawn';
  receiptId?: string;
  verifiedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  audioDurationMs?: number;
}

const EMPTY_STATE: ContributionState = {
  version: 1,
  active: false,
  candidates: [],
  verifiedAudioMs: 0,
  withdrawalPending: false,
};
const STALE_UPLOAD_MS = 30_000;

let stateQueue: Promise<void> = Promise.resolve();
let syncInFlight: Promise<void> | null = null;

function normalizeState(value: unknown): ContributionState {
  const raw = value && typeof value === 'object' ? value as Partial<ContributionState> : {};
  const allowedStatuses = new Set(['queued', 'uploading', 'submitted', 'verified', 'rejected', 'withdrawn']);
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.filter((item): item is ContributionCandidate => Boolean(item && typeof item === 'object' && item.id && item.projectId))
      .map((item) => ({
        ...item,
        status: allowedStatuses.has(String(item.status)) ? item.status : 'queued',
        originalText: String(item.originalText || '').slice(0, 1000),
        correctedText: String(item.correctedText || '').slice(0, 1000),
        correctionEventIds: Array.isArray(item.correctionEventIds) ? item.correctionEventIds.map(String).slice(0, 32) : [],
        attempts: Math.max(0, Math.min(100, Number(item.attempts || 0))),
      }))
      .slice(-5000)
    : [];
  return {
    version: 1,
    active: raw.active === true,
    contributorId: typeof raw.contributorId === 'string' ? raw.contributorId : undefined,
    withdrawalToken: typeof raw.withdrawalToken === 'string' ? raw.withdrawalToken : undefined,
    joinedAt: typeof raw.joinedAt === 'string' ? raw.joinedAt : undefined,
    consentGrantedAt: typeof raw.consentGrantedAt === 'string' ? raw.consentGrantedAt : undefined,
    candidates,
    verifiedAudioMs: Math.max(0, Number(raw.verifiedAudioMs || 0)),
    withdrawalPending: raw.withdrawalPending === true,
    lastSyncAt: typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : undefined,
    lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 300) : undefined,
  };
}

async function loadUnsafe() {
  try {
    return normalizeState(JSON.parse(await fs.readFile(config.contributionStateFile, 'utf8')));
  } catch {
    return { ...EMPTY_STATE, candidates: [] };
  }
}

async function saveUnsafe(state: ContributionState) {
  const normalized = normalizeState(state);
  await fs.mkdir(path.dirname(config.contributionStateFile), { recursive: true });
  const temp = `${config.contributionStateFile}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temp, JSON.stringify(normalized, null, 2), 'utf8');
  await fs.rename(temp, config.contributionStateFile);
  return normalized;
}

async function readState() {
  await stateQueue;
  return loadUnsafe();
}

async function mutateState<T>(operation: (state: ContributionState) => Promise<T> | T): Promise<T> {
  let resolveResult!: (value: T | PromiseLike<T>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const task = stateQueue.then(async () => {
    try {
      const state = await loadUnsafe();
      const value = await operation(state);
      await saveUnsafe(state);
      resolveResult(value);
    } catch (error) {
      rejectResult(error);
    }
  });
  stateQueue = task.catch(() => {});
  return result;
}

function ensureIdentity(state: ContributionState) {
  if (!state.contributorId) state.contributorId = crypto.randomUUID();
  if (!state.withdrawalToken) state.withdrawalToken = crypto.randomBytes(32).toString('base64url');
}

function minimizeRemoteCandidate(candidate: ContributionCandidate): ContributionCandidate {
  return {
    ...candidate,
    correctionEventIds: [],
    originalText: '',
    correctedText: '',
  };
}

function publicStatus(profile: AppProfile, state: ContributionState): ContributionStatus {
  const count = (status: ContributionCandidate['status']) => state.candidates.filter((item) => item.status === status).length;
  return {
    consent: profile.preferences.khmerContributionConsent || 'unset',
    endpointConfigured: Boolean(config.contributionEndpoint),
    contributorEnrolled: Boolean(state.contributorId),
    queued: count('queued') + count('uploading'),
    submitted: count('submitted'),
    verified: count('verified'),
    rejected: count('rejected'),
    withdrawn: count('withdrawn'),
    verifiedAudioMs: state.verifiedAudioMs,
    withdrawalPending: state.withdrawalPending,
    joinedAt: state.joinedAt,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
  };
}

async function syncConsentState(consent: ConsentState) {
  return mutateState((state) => {
    if (consent === 'granted') {
      ensureIdentity(state);
      if (!state.active) {
        const now = new Date().toISOString();
        state.active = true;
        state.joinedAt ||= now;
        // This timestamp deliberately prevents pre-consent corrections from being harvested later.
        state.consentGrantedAt = now;
      }
      return;
    }
    state.active = false;
    state.consentGrantedAt = undefined;
    // Drop never-started local work immediately. Preserve an in-flight upload only
    // until its network result is known, then minimize it to remote receipt/status metadata.
    state.candidates = state.candidates
      .filter((item) => item.status === 'uploading' || !['queued', 'rejected'].includes(item.status))
      .map((item) => item.status === 'uploading' || ['submitted', 'verified', 'withdrawn'].includes(item.status)
        ? minimizeRemoteCandidate(item)
        : item);
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 9000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadCandidate(state: ContributionState, candidate: ContributionCandidate) {
  if (!config.contributionEndpoint || !state.contributorId || !state.withdrawalToken) return null;
  const project = await store.get(candidate.projectId);
  if (!project) return null;
  const normalized = await ensureNormalizedAudio(project);
  const paddingMs = 180;
  const clipStartMs = Math.max(0, candidate.startMs - paddingMs);
  const clipEndMs = Math.min(normalized.durationMs, candidate.endMs + paddingMs);
  const clipDurationMs = Math.max(1, clipEndMs - clipStartMs);
  await fs.mkdir(config.contributionTempDir, { recursive: true });
  const tempPath = path.join(config.contributionTempDir, `${candidate.id}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.wav`);
  try {
    const chunk = await makeAudioChunk(normalized.outputPath, tempPath, clipStartMs, clipDurationMs);
    const audio = await fs.readFile(chunk.outputPath);
    if (audio.length < 44 || audio.length > 1_200_000) throw new Error('Contribution clip is outside the supported size range.');
    const audioSha256 = crypto.createHash('sha256').update(audio).digest('hex');
    const response = await fetchWithTimeout(`${config.contributionEndpoint}/v1/contributions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sthang-Contributor-Token': state.withdrawalToken,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        contributorId: state.contributorId,
        candidateId: candidate.id,
        captionStartMs: candidate.startMs,
        captionEndMs: candidate.endMs,
        clipStartMs,
        clipEndMs,
        originalText: candidate.originalText,
        correctedText: candidate.correctedText,
        sourceTimingSource: candidate.sourceTimingSource,
        sourceTextModel: candidate.sourceTextModel,
        sourceEngineVersion: candidate.sourceEngineVersion,
        appVersion: APP_VERSION,
        audioDurationMs: chunk.durationMs,
        audioSha256,
        audioBase64: audio.toString('base64'),
      }),
    });
    if (!response.ok) throw new Error('Contribution service did not accept the sample.');
    const result = await response.json() as { receiptId?: string; status?: string };
    if (!result.receiptId) throw new Error('Contribution service response was incomplete.');
    return { receiptId: String(result.receiptId).slice(0, 120) };
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function fetchRemoteStatuses(state: ContributionState) {
  if (!config.contributionEndpoint || !state.contributorId || !state.withdrawalToken) return [] as RemoteStatusSample[];
  if (!state.candidates.some((item) => ['submitted', 'verified', 'rejected'].includes(item.status))) return [] as RemoteStatusSample[];
  const response = await fetchWithTimeout(`${config.contributionEndpoint}/v1/contributors/${encodeURIComponent(state.contributorId)}/status`, {
    headers: { 'X-Sthang-Contributor-Token': state.withdrawalToken },
  });
  if (!response.ok) throw new Error('Contribution verification status is unavailable.');
  const value = await response.json() as { samples?: RemoteStatusSample[] };
  return Array.isArray(value.samples) ? value.samples.slice(0, 5000) : [];
}

async function applyRemoteStatuses(remoteSamples: RemoteStatusSample[]) {
  const remote = new Map(remoteSamples.map((item) => [item.candidateId, item]));
  await mutateState((state) => {
    let verifiedAudioMs = 0;
    state.candidates = state.candidates.map((candidate) => {
      const item = remote.get(candidate.id);
      if (!item) {
        if (candidate.status === 'verified') verifiedAudioMs += Math.max(0, candidate.endMs - candidate.startMs);
        return candidate;
      }
      if (item.status === 'verified') verifiedAudioMs += Math.max(0, Number(item.audioDurationMs || candidate.endMs - candidate.startMs));
      return minimizeRemoteCandidate({
        ...candidate,
        status: item.status,
        receiptId: item.receiptId || candidate.receiptId,
        verifiedAt: item.verifiedAt,
        rejectedAt: item.rejectedAt,
        rejectionReason: item.rejectionReason ? String(item.rejectionReason).slice(0, 160) : undefined,
      });
    });
    state.verifiedAudioMs = verifiedAudioMs;
  });
}

async function sendWithdrawal(state: ContributionState) {
  if (!state.withdrawalPending || !config.contributionEndpoint || !state.contributorId || !state.withdrawalToken) return false;
  const response = await fetchWithTimeout(`${config.contributionEndpoint}/v1/contributors/${encodeURIComponent(state.contributorId)}/withdraw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sthang-Contributor-Token': state.withdrawalToken,
    },
    body: '{}',
  });
  if (!response.ok) throw new Error('Contribution deletion could not be confirmed yet.');
  return true;
}

async function recoverStaleUploads() {
  const cutoff = Date.now() - STALE_UPLOAD_MS;
  await mutateState((state) => {
    state.candidates = state.candidates.flatMap((candidate) => {
      if (candidate.status !== 'uploading') return [candidate];
      const attemptTime = Date.parse(candidate.lastAttemptAt || '');
      if (Number.isFinite(attemptTime) && attemptTime > cutoff) return [candidate];
      if (!state.active) return [];
      return [{ ...candidate, status: 'queued' as const }];
    });
  });
}

async function claimQueuedCandidate() {
  return mutateState((state) => {
    if (!state.active || state.withdrawalPending) return null;
    ensureIdentity(state);
    const candidate = state.candidates.find((item) => item.status === 'queued');
    if (!candidate) return null;
    candidate.status = 'uploading';
    candidate.attempts += 1;
    candidate.lastAttemptAt = new Date().toISOString();
    return {
      state: {
        ...state,
        candidates: state.candidates.map((item) => ({ ...item, correctionEventIds: [...item.correctionEventIds] })),
      },
      candidate: { ...candidate, correctionEventIds: [...candidate.correctionEventIds] },
    };
  });
}

async function settleUploadFailure(candidateId: string) {
  await mutateState((state) => {
    const candidate = state.candidates.find((item) => item.id === candidateId);
    if (!candidate || candidate.status !== 'uploading') return;
    if (state.active) candidate.status = 'queued';
    else state.candidates = state.candidates.filter((item) => item.id !== candidateId);
  });
}

async function syncPendingInternal() {
  if (!config.contributionEndpoint) return;
  try {
    await recoverStaleUploads();
    const initial = await readState();
    if (initial.withdrawalPending) {
      if (await sendWithdrawal(initial)) {
        await mutateState((state) => {
          if (!state.withdrawalPending) return;
          state.candidates = state.candidates.map((item) => minimizeRemoteCandidate({ ...item, status: 'withdrawn' }));
          state.verifiedAudioMs = 0;
          state.withdrawalPending = false;
          state.lastSyncAt = new Date().toISOString();
          state.lastError = undefined;
        });
      }
      return;
    }

    const profile = await profileStore.get();
    if ((profile.preferences.khmerContributionConsent || 'unset') !== 'granted' || !initial.active) return;

    for (let index = 0; index < 8; index += 1) {
      const claimed = await claimQueuedCandidate();
      if (!claimed) break;
      let uploaded: { receiptId: string } | null = null;
      try {
        uploaded = await uploadCandidate(claimed.state, claimed.candidate);
      } catch (error) {
        await settleUploadFailure(claimed.candidate.id);
        throw error;
      }
      if (!uploaded) {
        await mutateState((state) => {
          state.candidates = state.candidates.filter((item) => item.id !== claimed.candidate.id);
        });
        continue;
      }
      await mutateState((state) => {
        const candidate = state.candidates.find((item) => item.id === claimed.candidate.id);
        if (!candidate || candidate.status !== 'uploading') return;
        candidate.status = 'submitted';
        candidate.receiptId = uploaded.receiptId;
        candidate.submittedAt = new Date().toISOString();
        Object.assign(candidate, minimizeRemoteCandidate(candidate));
      });
    }

    const latest = await readState();
    const remote = await fetchRemoteStatuses(latest);
    if (remote.length) await applyRemoteStatuses(remote);
    await mutateState((state) => {
      state.lastSyncAt = new Date().toISOString();
      state.lastError = undefined;
    });
  } catch {
    await mutateState((state) => {
      state.lastError = 'Contribution service unavailable; eligible corrections remain queued safely on this computer.';
    }).catch(() => {});
  }
}

async function syncPending() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = syncPendingInternal().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

export const contributionStore = {
  syncConsent: syncConsentState,

  async captureApprovedCorrections(project: CaptionProject, before: CaptionSegment[], after: CaptionSegment[]) {
    const profile = await profileStore.get();
    if ((profile.preferences.khmerContributionConsent || 'unset') !== 'granted') return [];
    const created = await mutateState((state) => {
      if (!state.active || !state.consentGrantedAt || state.withdrawalPending) return [] as ContributionCandidate[];
      const candidates = approvedContributionCandidates({
        project,
        before,
        after,
        correctionEvents: profile.correctionEvents,
        consentGrantedAt: state.consentGrantedAt,
        mediaFingerprint: mediaFingerprint(project),
      });
      if (!candidates.length) return [] as ContributionCandidate[];
      const known = new Set(state.candidates.map((item) => item.id));
      const next = candidates.filter((item) => !known.has(item.id));
      if (next.length) state.candidates = [...state.candidates, ...next].slice(-5000);
      return next;
    });
    if (created.length) void syncPending();
    return created;
  },

  async status(profile?: AppProfile) {
    const currentProfile = profile || await profileStore.get();
    const consent = currentProfile.preferences.khmerContributionConsent || 'unset';
    let state = await readState();
    if ((consent === 'granted') !== state.active && !state.withdrawalPending) {
      await syncConsentState(consent);
      state = await readState();
    }
    return publicStatus(currentProfile, state);
  },

  syncPending,

  async removeProject(projectId: string) {
    await mutateState((state) => {
      state.candidates = state.candidates
        .filter((item) => item.projectId !== projectId || !['queued', 'rejected'].includes(item.status))
        .map((item) => item.projectId === projectId && item.status !== 'queued' ? minimizeRemoteCandidate(item) : item);
    });
  },

  async requestWithdrawal() {
    await mutateState((state) => {
      const hasRemoteEvidence = state.candidates.some((item) => ['uploading', 'submitted', 'verified'].includes(item.status));
      state.active = false;
      state.consentGrantedAt = undefined;
      state.candidates = state.candidates
        .filter((item) => ['uploading', 'submitted', 'verified'].includes(item.status))
        .map(minimizeRemoteCandidate);
      state.withdrawalPending = hasRemoteEvidence;
    });
    void syncPending();
    return readState();
  },
};
