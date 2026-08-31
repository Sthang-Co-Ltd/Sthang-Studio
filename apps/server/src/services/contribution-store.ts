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

let writeQueue = Promise.resolve();
let syncInFlight: Promise<void> | null = null;

function normalizeState(value: unknown): ContributionState {
  const raw = value && typeof value === 'object' ? value as Partial<ContributionState> : {};
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.filter((item): item is ContributionCandidate => Boolean(item && typeof item === 'object' && item.id && item.projectId))
      .map((item) => ({
        ...item,
        originalText: String(item.originalText || '').slice(0, 1000),
        correctedText: String(item.correctedText || '').slice(0, 1000),
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

async function load() {
  try {
    return normalizeState(JSON.parse(await fs.readFile(config.contributionStateFile, 'utf8')));
  } catch {
    return { ...EMPTY_STATE, candidates: [] };
  }
}

async function save(state: ContributionState) {
  const normalized = normalizeState(state);
  const task = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(config.contributionStateFile), { recursive: true });
    const temp = `${config.contributionStateFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(normalized, null, 2), 'utf8');
    await fs.rename(temp, config.contributionStateFile);
  });
  writeQueue = task.catch(() => {});
  await task;
  return normalized;
}

function ensureIdentity(state: ContributionState) {
  if (!state.contributorId) state.contributorId = crypto.randomUUID();
  if (!state.withdrawalToken) state.withdrawalToken = crypto.randomBytes(32).toString('base64url');
}

function publicStatus(profile: AppProfile, state: ContributionState): ContributionStatus {
  const count = (status: ContributionCandidate['status']) => state.candidates.filter((item) => item.status === status).length;
  return {
    consent: profile.preferences.khmerContributionConsent || 'unset',
    endpointConfigured: Boolean(config.contributionEndpoint),
    contributorEnrolled: Boolean(state.contributorId),
    queued: count('queued'),
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
  const state = await load();
  if (consent === 'granted') {
    ensureIdentity(state);
    if (!state.active) {
      const now = new Date().toISOString();
      state.active = true;
      state.joinedAt ||= now;
      // This timestamp deliberately prevents pre-consent corrections from being harvested later.
      state.consentGrantedAt = now;
    }
  } else {
    state.active = false;
    state.consentGrantedAt = undefined;
    // Unsent derived correction data is discarded immediately when contribution stops.
    state.candidates = state.candidates.filter((item) => !['queued', 'rejected'].includes(item.status));
  }
  return save(state);
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
  const tempPath = path.join(config.contributionTempDir, `${candidate.id}.${process.pid}.wav`);
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

async function refreshRemoteStatuses(state: ContributionState) {
  if (!config.contributionEndpoint || !state.contributorId || !state.withdrawalToken) return;
  if (!state.candidates.some((item) => ['submitted', 'verified', 'rejected'].includes(item.status))) return;
  const response = await fetchWithTimeout(`${config.contributionEndpoint}/v1/contributors/${encodeURIComponent(state.contributorId)}/status`, {
    headers: { 'X-Sthang-Contributor-Token': state.withdrawalToken },
  });
  if (!response.ok) throw new Error('Contribution verification status is unavailable.');
  const value = await response.json() as { samples?: RemoteStatusSample[] };
  const remote = new Map((Array.isArray(value.samples) ? value.samples : []).slice(0, 5000).map((item) => [item.candidateId, item]));
  let verifiedAudioMs = 0;
  state.candidates = state.candidates.map((candidate) => {
    const item = remote.get(candidate.id);
    if (!item) return candidate;
    if (item.status === 'verified') verifiedAudioMs += Math.max(0, Number(item.audioDurationMs || candidate.endMs - candidate.startMs));
    return {
      ...candidate,
      status: item.status,
      receiptId: item.receiptId || candidate.receiptId,
      verifiedAt: item.verifiedAt,
      rejectedAt: item.rejectedAt,
      rejectionReason: item.rejectionReason ? String(item.rejectionReason).slice(0, 160) : undefined,
    };
  });
  state.verifiedAudioMs = verifiedAudioMs;
}

async function processWithdrawal(state: ContributionState) {
  if (!state.withdrawalPending || !config.contributionEndpoint || !state.contributorId || !state.withdrawalToken) return;
  const response = await fetchWithTimeout(`${config.contributionEndpoint}/v1/contributors/${encodeURIComponent(state.contributorId)}/withdraw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sthang-Contributor-Token': state.withdrawalToken,
    },
    body: '{}',
  });
  if (!response.ok) throw new Error('Contribution deletion could not be confirmed yet.');
  state.candidates = state.candidates.map((item) => ({ ...item, status: 'withdrawn' }));
  state.verifiedAudioMs = 0;
  state.withdrawalPending = false;
}

async function syncPendingInternal() {
  if (!config.contributionEndpoint) return;
  let state = await load();
  try {
    if (state.withdrawalPending) {
      await processWithdrawal(state);
      state.lastSyncAt = new Date().toISOString();
      state.lastError = undefined;
      await save(state);
      return;
    }

    const profile = await profileStore.get();
    if ((profile.preferences.khmerContributionConsent || 'unset') !== 'granted' || !state.active) return;
    ensureIdentity(state);
    const pending = state.candidates.filter((item) => item.status === 'queued').slice(0, 8);
    for (const candidate of pending) {
      candidate.attempts += 1;
      candidate.lastAttemptAt = new Date().toISOString();
      const uploaded = await uploadCandidate(state, candidate);
      if (!uploaded) continue;
      candidate.status = 'submitted';
      candidate.receiptId = uploaded.receiptId;
      candidate.submittedAt = new Date().toISOString();
      await save(state);
    }
    await refreshRemoteStatuses(state);
    state.lastSyncAt = new Date().toISOString();
    state.lastError = undefined;
    await save(state);
  } catch {
    state.lastError = 'Contribution service unavailable; eligible corrections remain queued safely on this computer.';
    await save(state).catch(() => {});
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
    const state = await load();
    if (!state.active || !state.consentGrantedAt) return [];
    const candidates = approvedContributionCandidates({
      project,
      before,
      after,
      correctionEvents: profile.correctionEvents,
      consentGrantedAt: state.consentGrantedAt,
      mediaFingerprint: mediaFingerprint(project),
    });
    if (!candidates.length) return [];
    const known = new Set(state.candidates.map((item) => item.id));
    const created = candidates.filter((item) => !known.has(item.id));
    if (!created.length) return [];
    state.candidates = [...state.candidates, ...created].slice(-5000);
    await save(state);
    void syncPending();
    return created;
  },

  async status(profile?: AppProfile) {
    const currentProfile = profile || await profileStore.get();
    const consent = currentProfile.preferences.khmerContributionConsent || 'unset';
    let state = await load();
    if ((consent === 'granted') !== state.active && !state.withdrawalPending) state = await syncConsentState(consent);
    return publicStatus(currentProfile, state);
  },

  syncPending,

  async removeProject(projectId: string) {
    const state = await load();
    const next = state.candidates.filter((item) => item.projectId !== projectId);
    if (next.length === state.candidates.length) return;
    state.candidates = next;
    await save(state);
  },

  async requestWithdrawal() {
    const state = await load();
    const hasRemoteEvidence = state.candidates.some((item) => ['submitted', 'verified'].includes(item.status));
    state.active = false;
    state.consentGrantedAt = undefined;
    state.candidates = state.candidates.filter((item) => ['submitted', 'verified'].includes(item.status));
    state.withdrawalPending = hasRemoteEvidence;
    await save(state);
    void syncPending();
    return state;
  },
};
