export type CaptionMode = 'dynamic' | 'word' | 'phrase' | 'single-line';
export type TimingSource = 'stt' | 'stt-split' | 'interpolated' | 'manual';
export type TimingQuality = 'high' | 'medium' | 'low';
export type TimingEngine = 'kfa-local' | 'faster-whisper-local' | 'google-cloud-stt-v2';

/**
 * Project-specific hints for code-switched Khmer transcription.
 * Vocabulary lines use: Canonical form | spoken alias | another alias
 * Example: Terra | ថេរ៉ា
 */
export interface TranscriptionContext {
  description: string;
  vocabulary: string[];
}

export interface TimedToken {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  spaceBefore: boolean;
  confidence?: number;
  alignmentScore?: number;
  timingSource: TimingSource;
}

export interface CaptionSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
  timingQuality?: TimingQuality;
  timingSource?: TimingSource;
  /** A reviewed caption can be filtered separately from unresolved work. */
  approved?: boolean;
  /** Text locks survive regeneration, regrouping and Khmer cleanup. */
  textLocked?: boolean;
  /** Timing locks survive regeneration, regrouping and timing post-processing. */
  timingLocked?: boolean;
}

export interface TimingDiagnostics {
  engine: TimingEngine;
  provider: 'local' | 'google-cloud';
  model: string;
  location?: string;
  device?: string;
  computeType?: string;
  /** Timing transcript. For KFA this is Gemini's exact transcript; for fallback it is Whisper's timing transcript. */
  sttTranscript: string;
  audioDurationMs: number;
  totalTokens: number;
  anchoredTokens: number;
  interpolatedTokens: number;
  lowConfidenceTokens: number;
  alignmentCoverage: number;
  meanAlignmentScore: number;
  directAlignment?: boolean;
  fallbackReason?: string;
}

export interface TranscriptResult {
  language: string;
  fullText: string;
  /** Gemini model that produced the canonical transcript text. */
  textModel?: string;
  /** True when the configured fallback Gemini model was used after transient primary-model failures. */
  textModelFallback?: boolean;
  /** True when Gemini native ASR vocabulary bias was accepted by the API. */
  nativeVocabularyBias?: boolean;
  /** Canonical protected vocabulary terms that were supplied for this transcription. */
  vocabularyTerms?: string[];
  /** Canonical timing representation: Gemini wording mapped onto local timing anchors. */
  tokens?: TimedToken[];
  /** Convenient natural groups derived from tokens. */
  segments: CaptionSegment[];
  timing?: TimingDiagnostics;
}

export interface MediaInfo {
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
}

export interface PipelineCacheInfo {
  mediaFingerprint: string;
  normalizedAudioCached: boolean;
  normalizedAudioDurationMs?: number;
  normalizedAudioCachedAt?: string;
  textStageCachedAt?: string;
  timingStageCachedAt?: string;
  lastRangeRegeneratedAt?: string;
}

export interface CaptionProject {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  media: MediaInfo;
  transcriptionContext?: TranscriptionContext;
  transcript: TranscriptResult | null;
  captions: CaptionSegment[];
  mode: CaptionMode;
  engineVersion?: string;
  pipelineCache?: PipelineCacheInfo;
  /** Set when accepted caption-only diffs no longer exactly mirror canonical transcript tokens. */
  transcriptNeedsSync?: boolean;
}

export interface SegmentOptions {
  mode: CaptionMode;
  maxChars?: number;
  maxDurationMs?: number;
  /** Exact entities that should not be split across caption blocks when possible. */
  protectedPhrases?: string[];
}

export type CorrectionStatus = 'pending' | 'remembered-global' | 'added-project' | 'ignored';
export type CorrectionSuggestionKind = 'phonetic-alias' | 'protected-term' | 'formatting' | 'review';

export interface CorrectionEvent {
  id: string;
  projectId: string;
  projectTitle: string;
  captionId: string;
  startMs: number;
  endMs: number;
  originalText: string;
  correctedText: string;
  contextBefore?: string;
  contextAfter?: string;
  suggestionKind: CorrectionSuggestionKind;
  suggestedVocabularyLine: string;
  status: CorrectionStatus;
  createdAt: string;
  decidedAt?: string;
}

export interface CorrectionRule {
  id: string;
  kind: 'alias' | 'protected-term';
  canonical: string;
  aliases: string[];
  sourceCorrectionId?: string;
  createdAt: string;
}

export interface CaptionStylePreset {
  id: string;
  name: string;
  mode: CaptionMode;
  maxChars: number;
}

export interface TopicPack {
  id: string;
  name: string;
  description: string;
  vocabulary: string[];
  createdAt: string;
  updatedAt: string;
}

export type QaProfileId = 'khmer-tiktok-fast' | 'khmer-tiktok-comfortable' | 'capcut-srt' | 'accessibility' | 'custom';

export interface QaProfileSettings {
  id: QaProfileId;
  name: string;
  description: string;
  maxCps: number;
  maxCharsPerLine: number;
  maxLines: number;
  minDurationMs: number;
  maxDurationMs: number;
  minGapMs: number;
  leadInMs: number;
  leadOutMs: number;
  snapToleranceMs: number;
}

export interface AppPreferences {
  reviewPreRollMs: number;
  reviewPostRollMs: number;
  autoLoopReview: boolean;
  autoPlayNextReview?: boolean;
  reviewFocusMode?: 'brackets-label' | 'brackets' | 'off';
  qaProfileId?: QaProfileId;
  qaCustom?: Partial<QaProfileSettings>;
  autosaveDelayMs?: number;
  waveformMode?: 'waveform' | 'spectrum';
  waveformZoom?: number;
}

export interface AppProfile {
  version: 1;
  defaultVocabulary: string[];
  styles: CaptionStylePreset[];
  topicPacks: TopicPack[];
  correctionRules: CorrectionRule[];
  correctionEvents: CorrectionEvent[];
  preferences: AppPreferences;
  updatedAt: string;
}

export type DoctorCheckStatus = 'ok' | 'warning' | 'error';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail: string;
  fix?: string;
}

export interface SystemDoctorReport {
  generatedAt: string;
  engineVersion: string;
  overall: DoctorCheckStatus;
  checks: DoctorCheck[];
  environment: {
    platform: string;
    node: string;
    appRoot: string;
    apiPort: number;
    webOrigin: string;
  };
}

export type HistorySource = 'manual-save' | 'autosave' | 'text-edit' | 'regeneration' | 'regroup' | 'cleanup' | 'timing-fix' | 'restore' | 'system';

export interface ProjectHistoryEntry {
  id: string;
  projectId: string;
  createdAt: string;
  label: string;
  source: HistorySource;
  captionCount: number;
  approvedCount: number;
  textLockedCount: number;
  timingLockedCount: number;
}

export type RegenerationApplyMode = 'all' | 'text-only' | 'timing-only' | 'reject';
export type RegenerationStrategy = 'standard' | 'alternative' | 'deep-verify' | 'manual-realign';
export type RegenerationPreviewMode = 'current' | 'proposed';

export interface RegenerationDiffItem {
  id: string;
  startMs: number;
  endMs: number;
  beforeText: string;
  afterText: string;
  beforeStartMs: number;
  beforeEndMs: number;
  afterStartMs: number;
  afterEndMs: number;
  textChanged: boolean;
  timingChanged: boolean;
  timingDeltaMs: number;
  confidence: 'high' | 'medium' | 'low';
  protectedByLock: boolean;
}

export interface RegenerationCandidateSummary {
  id: string;
  label: string;
  text: string;
  selected: boolean;
  model: string;
  alignmentCoverage: number;
  meanAlignmentScore: number;
  lowConfidenceTokens: number;
  totalTokens: number;
  advisoryScore: number;
}

export interface RegenerationProposal {
  id: string;
  projectId: string;
  projectTitle: string;
  createdAt: string;
  expiresAt: string;
  startMs: number;
  endMs: number;
  lockedCaptionsPreserved: number;
  unchangedCount: number;
  changes: RegenerationDiffItem[];
  /** Caption snapshots used by the live A/B preview. Nothing is applied until the user accepts. */
  currentCaptions: CaptionSegment[];
  proposedCaptions: CaptionSegment[];
  passNumber: number;
  strategy: RegenerationStrategy;
  parentProposalId?: string;
  /** The reviewed wording carried forward when the user chooses “Use as baseline & refine”. */
  acceptedBaselineText?: string;
  accuracyHint?: string;
  candidates?: RegenerationCandidateSummary[];
  selectedCandidateReason?: string;
}

export interface RegenerationRefinementInput {
  strategy: Exclude<RegenerationStrategy, 'standard'>;
  accuracyHint?: string;
  editedText?: string;
  useProposalAsBaseline?: boolean;
}

export type ProcessingJobType = 'transcribe' | 'regenerate-range' | 'refine-proposal';
export type ProcessingJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface ProcessingJob {
  id: string;
  type: ProcessingJobType;
  projectId: string;
  projectTitle: string;
  status: ProcessingJobStatus;
  stage: string;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  resultProjectId?: string;
  proposalId?: string;
  canResume: boolean;
}
