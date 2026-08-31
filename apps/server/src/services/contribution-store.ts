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
import { mediaFingerprint } from './cache.js';
import { approvedContributionCandidates } from './contribution-core.js';
import { profileStore } from './profile-store.js';

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

const EMPTY_STATE: ContributionState = {
  version: 1,
  active: false,
  candidates: [],
  verifiedAudioMs: 0,
  withdrawalPending: false,
};

let writeQueue = Promise.resolve();

function normalizeState(value: unknown): ContributionState {
  const raw = value && typeof value === 'object' ? value as Partial<ContributionState> : {};
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.filter((item): item is ContributionCandidate => Boolean(item && typeof item === 'object' && item.id && item.projectId))
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
    lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 500) : undefined,
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

export const contributionStore = {
  async syncConsent(consent: ConsentState) {
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
      // Unsent candidate text is derived project data; discard it immediately when contribution stops.
      state.candidates = state.candidates.filter((item) => !['queued', 'rejected'].includes(item.status));
    }
    return save(state);
  },

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
    return created;
  },

  async status(profile?: AppProfile) {
    const currentProfile = profile || await profileStore.get();
    const consent = currentProfile.preferences.khmerContributionConsent || 'unset';
    let state = await load();
    if ((consent === 'granted') !== state.active) state = await this.syncConsent(consent);
    return publicStatus(currentProfile, state);
  },

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
    return state;
  },
};
