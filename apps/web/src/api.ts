import type {
  AppProfile,
  CaptionMode,
  CaptionProject,
  CaptionSegment,
  ProcessingJob,
  ProjectHistoryEntry,
  QaProfileSettings,
  RegenerationApplyMode,
  RegenerationProposal,
  RegenerationRefinementInput,
  SystemDoctorReport,
  TranscriptionContext,
} from '@kcs/shared';

export const JOBS_UPDATED_EVENT = 'sthang:jobs-updated';
let jobSnapshot: ProcessingJob[] | null = null;
let jobEventSource: EventSource | null = null;
let jobStreamOpen = false;

function ensureJobEventStream() {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined' || jobEventSource) return;
  const source = new EventSource('/api/jobs/events');
  jobEventSource = source;
  source.onopen = () => { jobStreamOpen = true; };
  source.onerror = () => { jobStreamOpen = false; };
  source.addEventListener('jobs', (event) => {
    try {
      const value = JSON.parse((event as MessageEvent<string>).data) as ProcessingJob[];
      if (!Array.isArray(value)) return;
      jobSnapshot = value;
      jobStreamOpen = true;
      window.dispatchEvent(new Event(JOBS_UPDATED_EVENT));
    } catch {
      // Keep the polling fallback if a malformed event ever arrives.
    }
  });
}

export type LlmKeySource = 'secure-store' | 'environment' | 'none';

export interface LlmSettingsStatus {
  provider: 'gemini';
  configured: boolean;
  keySource: LlmKeySource;
  maskedKey: string | null;
  model: string;
  fallbackModel: string;
  secureStorageAvailable: boolean;
  secureStorageLabel: string;
  environmentFallbackAvailable: boolean;
  canForgetSecureKey: boolean;
  updatedAt: string | null;
}

export interface LlmConnectionTest {
  ok: boolean;
  level: 'success' | 'warning';
  provider: 'gemini';
  model: string;
  latencyMs: number;
  message: string;
}

export interface SaveLlmSettingsInput {
  apiKey?: string;
  model: string;
  fallbackModel: string;
}

export interface HealthResponse {
  ok: boolean;
  engineVersion: string;
  geminiModel: string;
  geminiFallbackModel: string | null;
  geminiMaxRetries: number;
  geminiNativeVocabularyBias: boolean;
  llm?: LlmSettingsStatus;
  features?: Record<string, boolean>;
  timing: {
    provider: 'local';
    configured: boolean;
    engine: string;
    model: string;
    fallbackEngine: string | null;
    fallbackModel: string | null;
    device: string;
    language: string;
    paidApi: false;
  };
}

export interface SaveCaptionsResponse {
  project: CaptionProject;
  correctionsCreated: number;
}

export interface CorrectionActionResponse {
  profile: AppProfile;
  project: CaptionProject | null;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? undefined as T : res.json();
}

async function jobsRequest(projectId?: string) {
  ensureJobEventStream();
  if (jobStreamOpen && jobSnapshot) {
    return projectId ? jobSnapshot.filter((job) => job.projectId === projectId) : jobSnapshot;
  }
  const result = await request<ProcessingJob[]>(`/api/jobs${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);
  if (!projectId) jobSnapshot = result;
  return result;
}

async function jobMutation<T>(operation: () => Promise<T>) {
  // Until the server's SSE mutation arrives, force any fallback refresh to ask the
  // server rather than returning a snapshot from immediately before the mutation.
  jobSnapshot = null;
  return operation();
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  doctor: () => request<SystemDoctorReport>('/api/system/doctor'),
  llmSettings: () => request<LlmSettingsStatus>('/api/system/llm-settings'),
  saveLlmSettings: (input: SaveLlmSettingsInput) => request<LlmSettingsStatus>('/api/system/llm-settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }),
  testLlmConnection: (input: { apiKey?: string; model?: string }) => request<LlmConnectionTest>('/api/system/llm-settings/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }),
  forgetLlmKey: () => request<LlmSettingsStatus>('/api/system/llm-settings/key', { method: 'DELETE' }),
  list: () => request<CaptionProject[]>('/api/projects'),
  get: (id: string) => request<CaptionProject>(`/api/projects/${id}`),
  create: (file: File, title: string) => {
    const fd = new FormData();
    fd.append('media', file);
    fd.append('title', title);
    return request<CaptionProject>('/api/projects', { method: 'POST', body: fd });
  },
  replaceMedia: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('media', file);
    return request<CaptionProject>(`/api/projects/${id}/replace-media`, { method: 'POST', body: fd });
  },
  transcribe: (id: string, transcriptionContext: TranscriptionContext, force = false) => request<CaptionProject>(`/api/projects/${id}/transcribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcriptionContext, force }),
  }),
  startTranscribeJob: (projectId: string, transcriptionContext: TranscriptionContext, force = false) => jobMutation(() => request<ProcessingJob>('/api/jobs/transcribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, transcriptionContext, force }),
  })),
  startRegenerationJob: (projectId: string, startMs: number, endMs: number, transcriptionContext: TranscriptionContext) => jobMutation(() => request<ProcessingJob>('/api/jobs/regenerate-range', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, startMs, endMs, transcriptionContext }),
  })),
  startRefinementJob: (projectId: string, proposalId: string, input: RegenerationRefinementInput) => jobMutation(() => request<ProcessingJob>('/api/jobs/refine-proposal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, proposalId, ...input }),
  })),
  jobs: jobsRequest,
  job: (id: string) => request<ProcessingJob>(`/api/jobs/${id}`),
  resumeJob: (id: string) => jobMutation(() => request<ProcessingJob>(`/api/jobs/${id}/resume`, { method: 'POST' })),
  cancelJob: (id: string) => jobMutation(() => request<ProcessingJob>(`/api/jobs/${id}/cancel`, { method: 'POST' })),
  regenerationProposal: (projectId: string, proposalId: string) => request<RegenerationProposal>(`/api/projects/${projectId}/regeneration-proposals/${proposalId}`),
  applyRegenerationProposal: (projectId: string, proposalId: string, mode: RegenerationApplyMode, editedText?: string) => request<CaptionProject>(`/api/projects/${projectId}/regeneration-proposals/${proposalId}/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, editedText }),
  }),
  saveContext: (id: string, transcriptionContext: TranscriptionContext) => request<CaptionProject>(`/api/projects/${id}/context`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcriptionContext }),
  }),
  saveCaptions: (id: string, captions: CaptionSegment[], options?: { source?: 'manual-save' | 'autosave' | 'text-edit'; recordCorrections?: boolean }) => request<SaveCaptionsResponse>(`/api/projects/${id}/captions`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captions, ...options }),
  }),
  resegment: (id: string, mode: CaptionMode, maxChars?: number) => request<CaptionProject>(`/api/projects/${id}/resegment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, maxChars }),
  }),
  normalizeKhmerSpacing: (id: string) => request<CaptionProject>(`/api/projects/${id}/normalize-khmer-spacing`, { method: 'POST' }),
  postprocessTiming: (id: string, settings: QaProfileSettings) => request<CaptionProject>(`/api/projects/${id}/postprocess-timing`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }),
  }),
  history: (id: string) => request<ProjectHistoryEntry[]>(`/api/projects/${id}/history`),
  restoreHistory: (id: string, historyId: string) => request<CaptionProject>(`/api/projects/${id}/history/${historyId}/restore`, { method: 'POST' }),
  remove: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  profile: () => request<AppProfile>('/api/profile'),
  patchProfile: (patch: Partial<AppProfile>) => request<AppProfile>('/api/profile', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }),
  importProfile: (profile: AppProfile) => request<AppProfile>('/api/profile/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile),
  }),
  correctionAction: (id: string, action: 'remember-global' | 'add-project' | 'ignore') => request<CorrectionActionResponse>(`/api/profile/corrections/${id}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
  }),
};
