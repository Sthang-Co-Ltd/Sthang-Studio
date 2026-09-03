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

export type CaptionHorizontalAlignment = 'left' | 'center' | 'right';

export interface CaptionAppearance {
  /** Font family resolved against reviewed local/system Khmer fonts at export time. */
  fontFamily: string;
  /** Reference size at 1080px frame height. Export scales this with output resolution. */
  fontSize1080: number;
  bold: boolean;
  textColor: string;
  outlineColor: string;
  outlineWidth1080: number;
  shadowWidth1080: number;
  backgroundEnabled: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  backgroundPadding1080: number;
  alignment: CaptionHorizontalAlignment;
  /** Distance from the bottom of the frame, expressed as a percent of frame height. */
  positionBottomPct: number;
  /** Maximum caption region width as a percent of frame width. */
  maxWidthPct: number;
}

export const DEFAULT_CAPTION_APPEARANCE: CaptionAppearance = {
  fontFamily: 'Khmer UI',
  fontSize1080: 56,
  bold: true,
  textColor: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth1080: 3,
  shadowWidth1080: 2,
  backgroundEnabled: false,
  backgroundColor: '#000000',
  backgroundOpacity: 0.58,
  backgroundPadding1080: 8,
  alignment: 'center',
  positionBottomPct: 12,
  maxWidthPct: 82,
};

export interface CaptionAppearancePreset {
  id: string;
  name: string;
  appearance: CaptionAppearance;
  createdAt: string;
  updatedAt: string;
}

export type VideoResolutionPreset = 'source' | '720p' | '1080p' | '1440p' | '2160p';
export type VideoFrameRatePreset = 'source' | 24 | 25 | 30 | 50 | 60;
export type VideoQualityPreset = 'smaller' | 'recommended' | 'high';
export type VideoCodec = 'h264' | 'hevc';
export type VideoEncoderPreference = 'auto' | 'software' | 'nvidia' | 'intel' | 'amd';
export type VideoHdrKind = 'sdr' | 'hdr10' | 'hlg' | 'dolby-vision' | 'unknown-hdr';

export interface VideoExportSettings {
  resolution: VideoResolutionPreset;
  frameRate: VideoFrameRatePreset;
  quality: VideoQualityPreset;
  codec: VideoCodec;
  encoder: VideoEncoderPreference;
  /** Optional advanced override. Omit to use Studio's quality preset. */
  customBitrateMbps?: number;
}

export interface VideoExportSourceInfo {
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  durationMs: number;
  frameRate: number;
  variableFrameRate: boolean;
  videoCodec: string;
  pixelFormat: string;
  bitDepth: number;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  colorRange?: string;
  hdr: VideoHdrKind;
  audioCodecs: string[];
  audioStreams: number;
}

export interface VideoExportResolutionOption {
  id: VideoResolutionPreset;
  label: string;
  width: number;
  height: number;
  upscaled: boolean;
}

export interface VideoExportEncoderCapability {
  id: Exclude<VideoEncoderPreference, 'auto'>;
  label: string;
  encoder: string;
  codec: VideoCodec;
  hardware: boolean;
  available: boolean;
}

export interface VideoExportFontCapability {
  name: string;
  available: boolean;
  boldAvailable: boolean;
  source: 'windows-system' | 'user-installed' | 'linux-system';
}

export interface VideoExportCapabilities {
  supported: boolean;
  blockingReason?: string;
  source: VideoExportSourceInfo;
  resolutions: VideoExportResolutionOption[];
  encoders: VideoExportEncoderCapability[];
  fonts: VideoExportFontCapability[];
  subtitlesFilter: boolean;
  availableDiskBytes: number;
  warnings: string[];
}

export interface VideoExportResult {
  filename: string;
  url: string;
  sizeBytes: number;
  width: number;
  height: number;
  frameRate: number;
  videoCodec: VideoCodec;
  encoder: string;
  audioCodec: string | null;
  durationMs: number;
  createdAt: string;
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
  /** Project-level burned-in caption appearance. It never changes SRT serialization. */
  captionAppearance?: CaptionAppearance;
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
export type ConsentState = 'unset' | 'declined' | 'granted';
export const PRIVACY_UPGRADE_NOTICE_VERSION = '0.8';
export type ContributionQueueStatus = 'queued' | 'uploading' | 'submitted' | 'verified' | 'rejected' | 'withdrawn';

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
  /** Evidence captured before the human text edit, used only for local contribution eligibility. */
  sourceTimingSource?: TimingSource;
  sourceTimingQuality?: TimingQuality;
  sourceConfidence?: number;
  sourceTextModel?: string;
  sourceEngineVersion?: string;
}

export interface ContributionCandidate {
  id: string;
  projectId: string;
  captionId: string;
  correctionEventIds: string[];
  startMs: number;
  endMs: number;
  originalText: string;
  correctedText: string;
  sourceTimingSource?: TimingSource;
  sourceTextModel?: string;
  sourceEngineVersion?: string;
  createdAt: string;
  status: ContributionQueueStatus;
  attempts: number;
  lastAttemptAt?: string;
  submittedAt?: string;
  receiptId?: string;
  verifiedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
}

export interface ContributionStatus {
  consent: ConsentState;
  endpointConfigured: boolean;
  contributorEnrolled: boolean;
  queued: number;
  submitted: number;
  verified: number;
  rejected: number;
  withdrawn: number;
  verifiedAudioMs: number;
  withdrawalPending: boolean;
  joinedAt?: string;
  lastSyncAt?: string;
  lastError?: string;
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
  /** Both privacy choices are off unless the user explicitly grants them. */
  analyticsConsent?: ConsentState;
  khmerContributionConsent?: ConsentState;
  /** Installation-local marker for a one-time existing-user privacy introduction. */
  privacyUpgradeNoticeVersion?: string;
}

export interface AppProfile {
  version: 1;
  defaultVocabulary: string[];
  styles: CaptionStylePreset[];
  /** Reusable local burned-in appearance presets. Omitted legacy profiles remain valid. */
  captionAppearances?: CaptionAppearancePreset[];
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

export type ProcessingJobType = 'transcribe' | 'regenerate-range' | 'refine-proposal' | 'export-video';
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
  resultExport?: VideoExportResult;
  canResume: boolean;
}
