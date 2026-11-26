import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  AppProfile,
  CaptionAppearance,
  CaptionGenerationModel,
  CaptionMode,
  CaptionProject,
  CaptionProjectSummary,
  CaptionSegment,
  WordHighlightFollow,
  CorrectionEvent,
  ProcessingJob,
  ProjectHistoryEntry,
  QaProfileId,
  RegenerationApplyMode,
  RegenerationPreviewMode,
  RegenerationProposal,
  RegenerationRefinementInput,
  SystemDoctorReport,
  TopicPack,
  TranscriptionContext,
  VideoExportSettings,
  VideoResolutionPreset,
} from '@kcs/shared';
import {
  AudioLines,
  BookOpenCheck,
  BookOpenText,
  Captions,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  FileOutput,
  FolderOpen,
  Group,
  HelpCircle,
  KeyRound,
  Keyboard,
  Languages,
  ListChecks,
  ListTodo,
  LoaderCircle,
  LockKeyhole,
  Palette,
  PencilLine,
  Play,
  RotateCcw,
  RefreshCw,
  Save,
  Settings2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { api, ApiRequestError, MediaAudioMismatchError, type HealthResponse, type LlmSettingsStatus, type SaveLlmSettingsInput, type MediaReplacementBasis, type MediaReplacementCheckpoint, type MediaReplacementMode, type PreserveAudioConfirmation, type ReplaceMediaResponse } from './api';
import { Upload, type UploadRecoveryResult, type UploadResult } from './components/Upload';
import { captureUploadRecoveryForProject, clearUploadRecoveryForProject } from './upload-recovery';
import { EditorLayout, type EditorLayoutHandle } from './components/EditorLayout';
import { editorPopoverAvailable, editorReorderSupported, type EditorLayoutMode } from './editor-layout-state';
import { GenerationOptions } from './components/GenerationOptions';
import { CaptionEditor, type CaptionEditorHandle, type DraftChangeReason } from './components/CaptionEditor';
import { CorrectionInbox } from './components/CorrectionInbox';
import { ProfileDoctor, type SettingsTab } from './components/ProfileDoctor';
import { storageNeedsAttention, useProjectStorage } from './project-storage';
import { reconcileProfileAcknowledgement, type ProfilePatch } from './profile-state';
import { LocaleProvider, messagesFor, translate, type Locale } from './i18n';
import type { MessageKey } from './i18n/types';
import { InterfaceLanguagePrompt, InterfaceLanguageSwitch } from './i18n/language-controls';
import { mirrorInterfaceLanguage, readInterfaceLanguage } from './i18n/language-storage';
import { StudioBrand } from './components/Brand';
import { FindReplacePanel } from './components/FindReplacePanel';
import { HomeSetupChecklist, NewUserGuide } from './components/NewUserGuide';
import { HistoryPanel } from './components/HistoryPanel';
import { JobManager } from './components/JobManager';
import { jobObservation, mergeJobSnapshot } from './processing-jobs';
import { ProjectLibrary } from './components/ProjectLibrary';
import { DEFAULT_PROJECT_LIBRARY_VIEW, normalizeProjectSearch, selectProjectLibrary, type ProjectLibraryView } from './project-library';
import { canRestore, useProjectBin } from './use-project-bin';
import { captureProjectCollectionBasis, reconcileProjectCollection } from './project-collection';
import { WorkspaceToolsMenu } from './components/WorkspaceToolsMenu';
import { UpdatePanel } from './components/UpdatePanel';
import { isVideoProject, normalizeCaptionAppearance, summarizeProject, hydrateCaptionWordTimings, reconcileCaptionWordTiming, createCaptionData, exportContentBasis } from '@kcs/shared';
import { NativeCaptionPreview, type NativeCaptionPreviewHandle } from './components/NativeCaptionPreview';
import { useStudioConfirm } from './components/ConfirmationDialog';
import { ReplaceMediaDialog, RestoreMediaDialog } from './components/ReplaceMediaDialog';
import { analyzeCaptions, QA_PROFILES, resolveQaProfile } from './review';
import { formatTimestamp } from './timestamp';
import { captionTextForEditing } from './caption-text';
import { useCaptionSelection } from './hooks/useCaptionSelection';
import { reconcileCaptionSelection } from './caption-selection-validity';
import { deferWorkspace } from './components/DeferredWorkspace';
import { retryWorkspace } from './retry-workspace';
import { ProjectIdentity } from './components/ProjectIdentity';
import { useProjectNavigationFocus, type ProjectNavigationFocusRequest } from './use-project-navigation-focus';
import { ReviewCompletion } from './components/ReviewCompletion';
import { ToastStack, type ToastLayoutState } from './components/ToastStack';
import { captionFieldViewport, revealFocusedCaptionField } from './caption-field-viewport';
import { useToastTimeout } from './use-toast-timeout';
import { createProjectScope, groupingChangesWording, projectMediaKey, proposalForProject, type ProjectTicket } from './project-scope';
import { SourceMedia } from './components/SourceMedia';
import './components/first-watch.css';
import { accuracyPayload, createAccuracyContextDraft, sameAccuracyContext, uniqueContextLines, type AccuracyFields, type AccuracyObservation } from './accuracy-context-draft';
import { createUnfinishedEditRecoveryStore, assessRecovery, restoredAppearance, restoredCaptions, type RecoveryEntry, type RecoveryStatus } from './unfinished-edit-recovery';
import { UnfinishedEditRecoveryNotice } from './components/UnfinishedEditRecoveryNotice';
import { checkedSaveRevision, editorAdoptedAccuracy, matchesCaptionSaveBasis, matchesVocabularyAddition } from './save-revision';
import { createCaptionSaveCoalescer } from './caption-save-coalescing';
import { sameTimingRevision, timingFields } from './timing-edit';
import { captionTimingBasisMatches, limitCaptionSelectionDelta, timingTransactionMatches, type CaptionTimingTransaction } from './caption-timing-transaction';
import { playTimingRange } from './timing-playback';
import { flushCaptionAppearanceSaves, getCaptionAppearanceSaveState, markCaptionAppearanceDraft, observeSavedCaptionAppearance, queueCaptionAppearanceSave, recoverUnsavedCaptionAppearance, subscribeCaptionAppearanceSaves, waitForCaptionAppearanceSaves, withCaptionAppearanceBarrier } from './caption-appearance-save';
import { useReconciledAppearance } from './caption-appearance-reconciliation';
import {
  mergePublishedWordHighlightBatch,
  wordHighlightBatchSaveBasis,
} from './word-highlight-batch';
import { affectedHighlightIds, classifyHighlightTargets, EMPTY_HIGHLIGHT_PROGRESS, runWordHighlightPass, wordHighlightCoverage, type WordHighlightIntent, type WordHighlightProgress } from './word-highlight-apply';
import type { WordHighlightPreparationView } from './components/WordHighlightPreparation';
import { createExportWorkspaceSession, type ExportWorkspaceSession } from './export-session';
import { createExportSessionStorage } from './export-session-storage';
import { ownReviewPlayback, type ReviewPlaybackOwner } from './review-playback';
import type { ExportRepairTarget } from './export-checks';

function compatibilityTranscriptionNotice(value: CaptionProject) {
  const transcript = value.transcript;
  const mode = transcript?.contextMode;
  if (!mode || mode === 'full') return '';
  if (mode === 'audio-only') {
    return 'Studio used compatibility transcription without Accuracy recognition hints. Review ambiguous names.';
  }
  const protectedCount = transcript?.vocabularyTerms?.length || 0;
  const descriptionHints = transcript?.descriptionHintsUsed || 0;
  if (descriptionHints > 0) {
    const sources = protectedCount
      ? `Protected terms and ${descriptionHints} selected name/model hint${descriptionHints === 1 ? '' : 's'} from your Accuracy context were used as recognition hints`
      : `${descriptionHints} selected name/model hint${descriptionHints === 1 ? '' : 's'} from your Accuracy context ${descriptionHints === 1 ? 'was' : 'were'} used for recognition`;
    return `Studio used compatibility transcription. ${sources}, but the full topic description was not available to Transcribe. Review ambiguous names.`;
  }
  return 'Studio used compatibility transcription. Protected terms were used as recognition hints, but the full topic description was not available to Transcribe. Review ambiguous names.';
}
import { captionHandoffApi, saveHandoffDownload, type CaptionFileFormat, type HandoffPrecondition, type HandoffRestorePreview } from './caption-handoff-client';
import './styles.css';
import './interface-motion.css';
import { ManualSaveButton, useManualSaveFeedback } from './components/ManualSaveButton';

const WaveformEditor = deferWorkspace(() => import('./components/WaveformEditor').then((module) => ({ default: module.WaveformEditor })), { name: 'Fine timing', shape: 'timing' },
  () => retryWorkspace<typeof import('./components/WaveformEditor')>('WaveformEditor').then((module) => ({ default: module.WaveformEditor })));

const ExportWorkspace = deferWorkspace(() => import('./components/ExportWorkspace').then((module) => ({ default: module.ExportWorkspace })), { name: 'Export', shape: 'export' },
  () => retryWorkspace<typeof import('./components/ExportWorkspace')>('ExportWorkspace').then((module) => ({ default: module.ExportWorkspace })));

const CaptionAppearanceWorkspace = deferWorkspace(() => import('./components/CaptionAppearanceWorkspace').then((module) => ({ default: module.CaptionAppearanceWorkspace })), { name: 'Appearance', shape: 'appearance' },
  () => retryWorkspace<typeof import('./components/CaptionAppearanceWorkspace')>('CaptionAppearanceWorkspace').then((module) => ({ default: module.CaptionAppearanceWorkspace })));

const RegenerationReviewDock = deferWorkspace(() => import('./components/RegenerationReviewDock').then((module) => ({ default: module.RegenerationReviewDock })), { name: 'Compare captions', shape: 'comparison' },
  () => retryWorkspace<typeof import('./components/RegenerationReviewDock')>('RegenerationReviewDock').then((module) => ({ default: module.RegenerationReviewDock })));

const modes: Array<{ id: CaptionMode; label: string; desc: string }> = [
  { id: 'dynamic', label: 'Dynamic', desc: 'Fast TikTok rhythm' },
  { id: 'word', label: 'Word', desc: 'One word at a time' },
  { id: 'phrase', label: 'Phrase', desc: 'Natural short phrases' },
  { id: 'single-line', label: 'Line', desc: 'Longer single-line groups' },
];

const LEGACY_GLOSSARY_KEY = 'kcs:default-protected-vocabulary:v1';
const LEGACY_STYLE_KEY = 'kcs:my-tiktok-style:v1';
const PROFILE_MIGRATION_KEY = 'kcs:profile-migrated:v1';
const FIRST_RUN_DISMISSED_KEY = 'sthang:first-run-dismissed:v1';

function withCaptionWordTimings(project: CaptionProject): CaptionProject {
  return hydrateCaptionWordTimings(project);
}

type WorkspaceTool = 'review' | 'timeline' | 'accuracy' | 'rhythm' | 'appearance' | 'details' | 'export' | null;
type Stage = 'captions' | 'review' | 'appearance' | 'export';

interface PendingCaptionImport {
  filename: string;
  data: string;
  preview: HandoffRestorePreview;
  basis: HandoffPrecondition;
  ticket: ProjectTicket;
  editRevision: number;
  captionSnapshot: string;
}
type ReviewPlaybackPass = 'context' | 'focus';

type ReviewUndoState = {
  items: Array<{ id: string; approved: boolean; applied: CaptionSegment }>;
  restoreSelectionId: string;
  message: string;
};

type ReplacementEditRecovery = {
  id: string;
  sourceProjectId: string;
  sourceMedia: Pick<CaptionProject['media'], 'filename' | 'originalName' | 'size'>;
  captions: CaptionSegment[];
  capturedAt: string;
  accuracyContext?: AccuracyFields;
};

type PendingMediaReplacement = {
  id: number;
  file: File;
  ticket: ProjectTicket;
  audioConfirmation?: PreserveAudioConfirmation & {
    basis: MediaReplacementBasis;
    editRevision: number;
    contextRevision: number;
  };
};

type MediaSourceCheck = {
  target: CaptionProject;
  ticket: ProjectTicket;
  editRevision: number;
  contextRevision: number;
};

type RetainedMediaView = {
  key: string;
  workspace: WorkspaceTool;
  reviewing: boolean;
  anchor: string | null;
  end: string | null;
  timeMs: number;
  reviewUndo: ReviewUndoState | null;
  description: string;
  vocabulary: string;
  maxChars: number;
  grouping: CaptionMode;
};

const MAX_REPLACEMENT_EDIT_RECOVERIES = 3;
const EMPTY_WORD_HIGHLIGHT_SUMMARY = wordHighlightCoverage([]);

const uniqueLines = uniqueContextLines;

function rangeLabel(startMs: number, endMs: number) {
  return `${formatTimestamp(startMs)} – ${formatTimestamp(endMs)}`;
}

function selectionIntentKey(value: { ids: string[]; startMs: number; endMs: number }) {
  return JSON.stringify([value.ids, value.startMs, value.endMs]);
}

function distributePreviewText(text: string, slots: CaptionSegment[]) {
  if (!slots.length) return [];
  const clean = text.trim();
  if (!clean) return slots.map((caption) => ({ ...caption, text: '' }));
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('km', { granularity: 'grapheme' })
    : null;
  const units = segmenter ? Array.from(segmenter.segment(clean), (item) => item.segment) : Array.from(clean);
  const totalDuration = slots.reduce((sum, caption) => sum + Math.max(1, caption.endMs - caption.startMs), 0);
  let cursor = 0;
  let elapsed = 0;
  return slots.map((caption, index) => {
    if (index === slots.length - 1) return { ...caption, text: units.slice(cursor).join('').trim() };
    elapsed += Math.max(1, caption.endMs - caption.startMs);
    const target = Math.max(cursor + 1, Math.round(units.length * elapsed / totalDuration));
    const value = units.slice(cursor, Math.min(units.length, target)).join('').trim();
    cursor = Math.min(units.length, target);
    return { ...caption, text: value };
  });
}

export default function App() {
  const projectNavigationFocus = useProjectNavigationFocus();
  const [projects, setProjectItems] = useState<CaptionProjectSummary[]>([]);
  const projectItems = useRef<CaptionProjectSummary[]>([]);
  const setProjects = useCallback((update: CaptionProjectSummary[] | ((current: CaptionProjectSummary[]) => CaptionProjectSummary[])) => {
    const next = typeof update === 'function' ? update(projectItems.current) : update;
    projectItems.current = next;
    setProjectItems(next);
  }, []);
  const [projectListState, setProjectListState] = useState({ refreshing: false, error: '' });
  const projectListRequest = useRef<AbortController | null>(null);
  const projectsBinnedDuringRead = useRef(new Set<string>());
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [showProjectBin, setShowProjectBin] = useState(false);
  // Keep the collection position while its editor is open, without persisting
  // project names or searches outside this tab's existing local project flow.
  const [projectLibraryView, setProjectLibraryView] = useState<ProjectLibraryView>(DEFAULT_PROJECT_LIBRARY_VIEW);
  const homeProjectsButton = useRef<HTMLButtonElement>(null);
  const libraryOrigin = useRef<string | null>(null);
  const libraryReturnId = useRef<string | null>(null);
  const releaseLibraryReturn = () => { libraryReturnId.current = null; };
  const libraryReturnTarget = (id: string | null) =>
    (id && document.querySelector<HTMLElement>(`[data-library-project="${CSS.escape(id)}"]`)) || document.querySelector<HTMLElement>('.project-library h1');
  const returnToHomeControl = useRef<'projects' | 'upload' | null>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const savedStorage = useProjectStorage(startupAttempt);
  const [storageNoticeDismissed, setStorageNoticeDismissed] = useState(false);
  const storageNoticeKey = savedStorage.status ? JSON.stringify([savedStorage.status.unreadableProjectCount, savedStorage.status.missingProjectCount,
    savedStorage.status.duplicateProjectCount, savedStorage.status.directoryUnreadable, savedStorage.status.orderUnreadable,
    savedStorage.status.legacyUnreadable, savedStorage.status.migrationPending, savedStorage.status.restartRequired]) : '';
  useEffect(() => setStorageNoticeDismissed(false), [storageNoticeKey]);
  const [startupErrors, setStartupErrors] = useState<string[]>([]);
  const startupLoaded = useRef(new Set<string>());
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const projectOpen = useRef<AbortController | null>(null);
  const [project, setProject] = useState<CaptionProject | null>(null);
  const projectTitleAck = useRef<{ id: string; title: string } | null>(null);
  const reopenAfterReload = useRef<string | null>(null);
  const [dismissedAlignmentNotice, setDismissedAlignmentNotice] = useState<string | null>(null);
  useEffect(() => { setDismissedAlignmentNotice(null); }, [project?.id]);
  const [draft, setDraft] = useState<CaptionSegment[]>([]);
  const [wordTimingPreview, setWordTimingPreview] = useState<{ mediaKey: string; ownerId: string; change: CaptionTimingTransaction } | null>(null);
  const [wordBatch, setWordBatch] = useState<WordHighlightProgress>(EMPTY_HIGHLIGHT_PROGRESS);
  const [wordTimingFocus, setWordTimingFocus] = useState<{ captionId: string; wordId: string } | null>(null);
  const [wordControlEntry, setWordControlEntry] = useState<{
    tool: 'timeline' | 'appearance'; captionId?: string; ticket: ProjectTicket; request: ProjectNavigationFocusRequest;
  } | null>(null);
  const [wordBatchUndo, setWordBatchUndo] = useState<{ ticket: ProjectTicket; applied: Array<{ before: CaptionSegment; after: CaptionSegment }> } | null>(null);
  const [busy, setBusy] = useState('');
  const [generationModelSaving, setGenerationModelSaving] = useState(false);
  const generationModelWrite = useRef(false);
  const generationModelRevision = useRef(0);
  const generationModelAck = useRef<{ key: string; value: CaptionGenerationModel } | null>(null);
  const [generationPreparing, setGenerationPreparing] = useState(false);
  const generationPreparation = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [toastLayout, setToastLayout] = useState<ToastLayoutState>({ hasContent: false, hasPersistentRecovery: false, hasSaveFailure: false });
  const toastLayoutRef = useRef(toastLayout);
  const toastFocusFrame = useRef<{ frame: number; field: HTMLElement; list: HTMLElement; workbench: HTMLElement } | null>(null);
  const handleToastLayoutChange = useCallback((next: ToastLayoutState) => {
    const pending = toastFocusFrame.current;
    if (pending) cancelAnimationFrame(pending.frame);
    toastFocusFrame.current = null;
    const previous = toastLayoutRef.current;
    toastLayoutRef.current = next;
    const active = document.activeElement;
    const field = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement && !['checkbox', 'range'].includes(active.type) ? active : null;
    const list = field?.closest<HTMLElement>('.caption-list');
    const workbench = list?.closest<HTMLElement>('.editor-workbench');
    const changesViewport = previous.hasSaveFailure !== next.hasSaveFailure
      || window.matchMedia('(max-width: 1199px)').matches && previous.hasPersistentRecovery !== next.hasPersistentRecovery
      || previous.hasContent !== next.hasContent && Boolean(workbench?.closest('.workspace')?.classList.contains('has-caption-proposal'));
    const ownsPending = pending?.field === field && pending?.list === list && pending?.workbench === workbench;
    let wasVisible = false;
    if ((changesViewport || ownsPending) && field && list && workbench && /auto|scroll/.test(getComputedStyle(workbench).overflowY)) {
      const { box, top, bottom } = captionFieldViewport(field, list, workbench);
      wasVisible = box.bottom > top && box.top < bottom;
    }
    setToastLayout(next);
    if (!wasVisible && !ownsPending || !field || !list || !workbench) return;
    // Carry an already-owned reveal through consecutive layout changes. Only the
    // outer narrow-screen workbench moves; caption-list scrolling owns Follow.
    const queued = { frame: 0, field, list, workbench };
    queued.frame = requestAnimationFrame(() => {
      if (toastFocusFrame.current !== queued) return;
      toastFocusFrame.current = null;
      revealFocusedCaptionField(field, list, workbench);
    });
    toastFocusFrame.current = queued;
  }, []);
  useEffect(() => () => { if (toastFocusFrame.current) cancelAnimationFrame(toastFocusFrame.current.frame); toastFocusFrame.current = null; }, []);
  const [replacementEditRecoveries, setReplacementEditRecoveries] = useState<ReplacementEditRecovery[]>([]);
  const [pendingMediaReplacement, setPendingMediaReplacement] = useState<PendingMediaReplacement | null>(null);
  const mediaReplacementSequence = useRef(0);
  const [showMediaBackups, setShowMediaBackups] = useState(false);
  const [mediaBackups, setMediaBackups] = useState<MediaReplacementCheckpoint[]>([]);
  const [mediaBackupsLoading, setMediaBackupsLoading] = useState(false);
  const [mediaMutationStatus, setMediaMutationStatus] = useState('');
  const [mediaMutationError, setMediaMutationError] = useState('');
  const [unconfirmedSource, setUnconfirmedSource] = useState<MediaSourceCheck | null>(null);
  const [checkingMediaSource, setCheckingMediaSource] = useState(false);
  const mediaSourceRequest = useRef<AbortController | null>(null);
  const [mediaUndoNotice, setMediaUndoNotice] = useState<{ key: string; checkpoint: MediaReplacementCheckpoint } | null>(null);
  const mediaMutationInFlight = useRef(false);
  const mediaBackupsRequest = useRef<AbortController | null>(null);
  const retainedMediaView = useRef<RetainedMediaView | null>(null);
  const retainedMediaSeek = useRef<{ key: string; timeMs: number } | null>(null);
  const flushAppearanceSave = useRef<(() => Promise<boolean>) | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const healthRequest = useRef(0);
  const [llmSettings, setLlmSettings] = useState<LlmSettingsStatus | null>(null);
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [bootLanguage] = useState(readInterfaceLanguage);
  const savedLanguage = profile?.preferences.interfaceLanguage;
  const interfaceLanguage = savedLanguage ?? bootLanguage ?? 'en';
  const { t, tn } = useMemo(() => messagesFor(interfaceLanguage), [interfaceLanguage]);
  const languageSave = useRef<Promise<void> | null>(null);
  const [languageSaving, setLanguageSaving] = useState(false);
  useEffect(() => {
    document.documentElement.lang = interfaceLanguage;
  }, [interfaceLanguage]);
  useEffect(() => {
    // Mirror only a committed profile value, including reconciled PATCH results.
    if (savedLanguage === 'en' || savedLanguage === 'km') mirrorInterfaceLanguage(savedLanguage);
  }, [savedLanguage]);
  const [profileImportRevision, setProfileImportRevision] = useState(0);
  const [doctor, setDoctor] = useState<SystemDoctorReport | null>(null);
  const [doctorLoadState, setDoctorLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [doctorError, setDoctorError] = useState('');
  const doctorRequest = useRef(0);
  const doctorInFlight = useRef(false);
  const [time, setTime] = useState(0);
  const [loadedMediaDurationMs, setLoadedMediaDurationMs] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [effectReplayPlaying, setEffectReplayPlaying] = useState(false);
  const [captionFontRevision, setCaptionFontRevision] = useState(0);
  const [maxChars, setMaxChars] = useState(18);
  const [groupingMode, setGroupingMode] = useState<CaptionMode>('dynamic');
  const [groupingApplying, setGroupingApplying] = useState(false);
  const groupingInFlight = useRef(false);
  const [groupingPresetSaving, setGroupingPresetSaving] = useState(false);
  const groupingPresetWrite = useRef(false);
  const groupingChoices = useRef({ mode: groupingMode, maxChars });
  groupingChoices.current = { mode: groupingMode, maxChars };
  const accuracyDraft = useRef(createAccuracyContextDraft());
  const [accuracyFields, setAccuracyFields] = useState(accuracyDraft.current.fields);
  const [globalGlossarySaving, setGlobalGlossarySaving] = useState(false);
  const globalGlossaryWrite = useRef(false);
  const [globalGlossaryFeedback, setGlobalGlossaryFeedback] = useState<{ ticket: ProjectTicket | null; error: boolean; message: string; savedVocabulary?: string[] }>({ ticket: null, error: false, message: '' });
  const { description: contextDescription, vocabulary: vocabularyText } = accuracyFields;
  const editAccuracyFields = (change: Partial<AccuracyFields>) => {
    if (change.vocabulary !== undefined) setGlobalGlossaryFeedback({ ticket: null, error: false, message: '' });
    setAccuracyFields(accuracyDraft.current.edit(change));
    if (!accuracyDraft.current.hasChanges(profile?.defaultVocabulary) && !hasPendingContextWrite()) setContextSaveState('saved');
    captureUnfinishedRecovery();
  };
  const [reviewMode, setReviewMode] = useState(false);
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<string | null>(null);
  const [showCorrections, setShowCorrections] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('ai');
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showJobs, setShowJobsState] = useState(false);
  const jobsViewRevision = useRef(0);
  const [activityEntryId, setActivityEntryId] = useState<string | null>(null);
  const [uncertainJobs, setUncertainJobs] = useState<{ key: string; title: string; captionJob: boolean; afterRead: number; dismissed: boolean }[]>([]);
  const lastSuccessfulJobRead = useRef(0);
  const setShowJobs = (open: boolean, id: string | null = null) => {
    jobsViewRevision.current += 1;
    setActivityEntryId(open ? id : null);
    setShowJobsState(open);
  };
  const [jobNotification, setJobNotification] = useState<{ id: string; observation: string; projectTitle: string; message: string; error: boolean } | null>(null);
  const jobNotificationRevision = useRef(0);
  const notifyJob = (job: ProcessingJob, message: string, error = true) => {
    jobNotificationRevision.current += 1;
    setJobNotification({ id: job.id, observation: jobObservation(job), projectTitle: job.projectTitle, message, error });
  };
  const dismissJobNotification = () => { jobNotificationRevision.current += 1; setJobNotification(null); };
  const [showUpdates, setShowUpdates] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<ProjectHistoryEntry[]>([]);
  const [historyLoadState, setHistoryLoadState] = useState({ loading: false, loaded: false, error: '' });
  const [jobs, setJobItems] = useState<ProcessingJob[]>([]);
  const jobItems = useRef<ProcessingJob[]>([]);
  const setJobs = useCallback((update: ProcessingJob[] | ((current: ProcessingJob[]) => ProcessingJob[])) => {
    const next = typeof update === 'function' ? update(jobItems.current) : update;
    jobItems.current = next;
    setJobItems(next);
  }, []);
  const [jobLoadState, setJobLoadState] = useState({ loading: true, loaded: false, error: '' });
  const manualJobRead = useRef<number | null>(null);
  const [pendingJobActions, setPendingJobActions] = useState<Record<string, 'resume' | 'cancel'>>({});
  const pendingJobActionIds = useRef(new Set<string>());
  const [openingJobId, setOpeningJobId] = useState<string | null>(null);
  const [blockedSwitch, setBlockedSwitch] = useState<{ surface: 'activity' | 'corrections'; id: string; reason?: string } | null>(null);
  const returnToEditsFocus = useRef<{ surface: 'activity' | 'corrections'; ticket: ProjectTicket } | null>(null);
  const activityResultFocus = useRef<{ ticket: ProjectTicket; comparison: boolean } | null>(null);
  const pendingJobResult = useRef<{ id: string; request: AbortController } | null>(null);
  const jobReadGeneration = useRef(0);
  const appliedJobRead = useRef(0);
  const [proposalEntry, setProposalEntry] = useState<{ ticket: ProjectTicket; value: RegenerationProposal } | null>(null);
  const projectScope = useRef(createProjectScope());
  const proposalRead = useRef(0);
  const historyRead = useRef(0);
  const pendingHistoryRead = useRef<number | null>(null);
  const operationRevision = useRef(0);
  const playbackTimers = useRef(new Set<number>());
  const reviewPlaybackOwner = useRef<ReviewPlaybackOwner | null>(null);
  const timingPreviewCancel = useRef<(() => void) | null>(null);
  const viewTicket = projectScope.current.capture();
  const proposal = proposalForProject(proposalEntry, viewTicket, project);
  const mediaKey = projectMediaKey(project);
  const uncertainJob = uncertainJobs.find((item) => item.key === mediaKey && !item.dismissed);
  const projectAwaitingJobCheck = uncertainJobs.some((item) => item.key === mediaKey);
  const [proposalPreviewMode, setProposalPreviewMode] = useState<RegenerationPreviewMode>('proposed');
  const [proposalLoop, setProposalLoop] = useState(true);
  const [proposalEditedText, setProposalEditedText] = useState('');
  const [proposalAccuracyHint, setProposalAccuracyHint] = useState('');
  const proposalViewRevision = useRef(0);
  const currentProposal = useRef(proposal); currentProposal.current = proposal;
  const proposalJobRevisions = useRef(new Map<string, number>());
  const [showGuide, setShowGuide] = useState(false);
  const [workspaceTool, setWorkspaceTool] = useState<WorkspaceTool>(null);
  const editorLayout = useRef<EditorLayoutHandle>(null);
  const [arrangeSupported] = useState(() => editorReorderSupported() && editorPopoverAvailable());
  const [mediaShape, setMediaShape] = useState<{ key: string; landscape: boolean } | null>(null);
  const accuracyDescriptionFocus = useRef<ProjectTicket | null>(null);
  const workspaceEntryFocus = useRef<{
    ticket: ProjectTicket; tool: Exclude<WorkspaceTool, null>; fromGuide?: boolean; previous: Element | null;
  } | null>(null);
  const generationAccuracyEntry = useRef<HTMLButtonElement>(null);
  const [exportVisit, setExportVisitState] = useState<{ ticket: ProjectTicket; session: ExportWorkspaceSession } | null>(null);
  const exportVisitRef = useRef(exportVisit);
  const setExportVisit = (next: typeof exportVisit) => { exportVisitRef.current = next; setExportVisitState(next); };
  const [exportChoiceStorage] = useState(() => createExportSessionStorage(() => {
    try { return window.localStorage; } catch { return null; }
  }));
  const [exportChoiceStorageError, setExportChoiceStorageError] = useState('');
  const [exportRepair, setExportRepair] = useState<{ ticket: ProjectTicket; target: ExportRepairTarget } | null>(null);
  const exportRepairFocus = useRef(false);
  const [fontFocusTrigger, setFontFocusTrigger] = useState<HTMLButtonElement | null>(null);
  const [exportFontFocus, setExportFontFocus] = useState<{ request: ProjectNavigationFocusRequest; ticket: ProjectTicket } | null>(null);
  useEffect(() => { if (workspaceTool !== 'appearance') setFontFocusTrigger(null); }, [workspaceTool]);
  useEffect(() => {
    if (!exportFontFocus || workspaceTool === 'appearance' && exportFontFocus.ticket === viewTicket) return;
    projectNavigationFocus.cancel(exportFontFocus.request);
    setExportFontFocus(null);
  }, [workspaceTool, viewTicket, exportFontFocus, projectNavigationFocus.cancel]);
  const exportSession = exportVisit?.ticket === viewTicket && viewTicket.key === mediaKey
    ? exportVisit.session : createExportWorkspaceSession(Boolean(project && isVideoProject(project)));
  useEffect(() => {
    if (project && viewTicket.key === mediaKey) {
      const previous = exportVisitRef.current;
      const sameMedia = previous?.ticket.key === mediaKey;
      setExportVisit({ ticket: viewTicket, session: sameMedia ? previous.session
        : exportChoiceStorage.read(project) ?? createExportWorkspaceSession(isVideoProject(project)) });
      if (!sameMedia) setExportChoiceStorageError('');
    } else if (!project) {
      setExportVisit(null);
      setExportChoiceStorageError('');
    }
    setExportRepair(null);
    exportRepairFocus.current = false;
  }, [mediaKey, viewTicket]);
  const [requestedTimingMode, setRequestedTimingMode] = useState<'caption' | 'words'>('caption');
  const [captionHandoffWorking, setCaptionHandoffWorking] = useState(false);
  const [pendingCaptionImport, setPendingCaptionImport] = useState<PendingCaptionImport | null>(null);
  const handoffRequest = useRef<AbortController | null>(null);
  const currentWorkspaceTool = useRef(workspaceTool);
  currentWorkspaceTool.current = workspaceTool;
  const getAccuracyCloseFocusTarget = (fallback: HTMLButtonElement | null = null) => {
    if (!projectScope.current.isCurrent(viewTicket) || currentWorkspaceTool.current !== null) return null;
    return generationAccuracyEntry.current ?? fallback;
  };
  const restoreInlineAccuracyFocus = () => requestAnimationFrame(() => getAccuracyCloseFocusTarget()?.focus());
  useEffect(() => {
    const request = workspaceEntryFocus.current;
    if (!request) return;
    workspaceEntryFocus.current = null;
    if (showGuide || proposal || workspaceTool !== request.tool || !projectScope.current.isCurrent(request.ticket)
      || document.querySelector('[aria-modal="true"]')
      || (document.activeElement !== request.previous && document.activeElement !== document.body)) return;
    const inspector = document.querySelector<HTMLElement>('.workspace-inspector:not([hidden])');
    const target = request.fromGuide && request.tool === 'accuracy'
      ? inspector?.querySelector<HTMLElement>('#accuracy-context-description') : inspector?.querySelector<HTMLElement>('.inspector-heading');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ behavior: 'instant', block: request.fromGuide ? 'nearest' : 'start', inline: 'nearest' });
  }, [showGuide, workspaceTool, viewTicket, proposal]);
  const [showFirstRun, setShowFirstRun] = useState(() => {
    try { return localStorage.getItem(FIRST_RUN_DISMISSED_KEY) !== '1'; } catch { return true; }
  });
  const [dirty, setDirty] = useState(false);
  const [textEditing, setTextEditing] = useState(false);
  const [textComposing, setTextComposing] = useState(false);
  const compositionInProgress = useRef(false);
  const [autosaveState, setAutosaveState] = useState<'saved' | 'pending' | 'saving' | 'failed'>('saved');
  const [contextSaveState, setContextSaveState] = useState<'saved' | 'saving' | 'failed'>('saved');
  const [captionSaveError, setCaptionSaveError] = useState('');
  const [contextSaveError, setContextSaveError] = useState('');
  const [saveConflict, setSaveConflict] = useState(false);
  const pendingContextWrites = useRef(new Map<string, number>());
  const pendingCaptionWrites = useRef(new Map<string, number>());
  const uncertainCaptionWrites = useRef(new Set<string>());
  const [, refreshContextWrites] = useState(0);
  const accuracyDirty = accuracyDraft.current.hasChanges(profile?.defaultVocabulary);
  const currentAppearanceSave = () => getCaptionAppearanceSaveState(project?.id ?? null, project?.media);
  const appearanceSave = useSyncExternalStore(subscribeCaptionAppearanceSaves, currentAppearanceSave, () => getCaptionAppearanceSaveState(null));
  const appearanceDirty = appearanceSave.status !== 'saved';
  const saveNeedsComparison = saveConflict || appearanceSave.conflict;
  const unfinishedChanges = dirty || accuracyDirty || appearanceDirty || saveConflict
    || (pendingContextWrites.current.get(mediaKey) || 0) > 0 || (pendingCaptionWrites.current.get(mediaKey) || 0) > 0;
  const manualSaveFeedback = useManualSaveFeedback(viewTicket, unfinishedChanges);
  const saveFailed = saveConflict || autosaveState === 'failed' || contextSaveState === 'failed' || appearanceSave.status === 'error';
  const saveFailure = [autosaveState === 'failed' ? captionSaveError : '', contextSaveState === 'failed' ? contextSaveError : '',
    appearanceSave.conflict ? 'The saved appearance changed. Download your edits, then reload the saved project to compare.'
      : appearanceSave.status === 'error' ? 'Your latest caption appearance could not be saved.' : ''].filter(Boolean).join(' ');
  const projectSaveStatus = !unfinishedChanges ? t('editor.header.saved') : saveFailed ? t('editor.header.saveFailed')
    : autosaveState === 'saving' || contextSaveState === 'saving' || appearanceSave.status === 'saving' ? t('editor.header.saving')
      : appearanceDirty ? t('editor.header.appearanceUnsaved') : dirty ? t('editor.header.autosavePending') : t('editor.header.accuracyUnsaved');
  const [recoveryOwner] = useState(() => crypto.randomUUID());
  const [recoveryStore] = useState(() => createUnfinishedEditRecoveryStore(() => {
    try { return window.localStorage; } catch { return null; }
  }, recoveryOwner));
  const [recoveryEntries, setRecoveryEntries] = useState<RecoveryEntry[]>([]);
  const [selectedRecoveryKey, setSelectedRecoveryKey] = useState<string | null>(null);
  const selectedRecovery = recoveryEntries.find((entry) => entry.key === selectedRecoveryKey) ?? recoveryEntries[0];
  const [recoveryConflict, setRecoveryConflict] = useState<{ key: string; raw: string; status: Exclude<RecoveryStatus, 'matching'> } | null>(null);
  const [recoveryWorking, setRecoveryWorking] = useState(false);
  const recoveryRead = useRef<AbortController | null>(null);
  const [recoveryStorageError, setRecoveryStorageError] = useState('');
  const captureRecoveryRef = useRef<() => boolean>(() => false);
  captureRecoveryRef.current = captureUnfinishedRecovery;
  // Draft publication is synchronous, including the debounce window. Do not
  // depend on an unload event or a later React effect to preserve an accepted edit.
  useEffect(() => subscribeCaptionAppearanceSaves(() => { captureRecoveryRef.current(); }), []);
  // `project.captions` sometimes contains newer unsaved edits. Recovery compares
  // against actual server acknowledgements, owned separately from that view.
  const savedProject = useRef<CaptionProject | null>(null);
  // Each field keeps the saved evidence actually adopted by this editor. A full
  // response for an unrelated action cannot authorize overwriting unseen edits.
  const ordinarySaveBasis = useRef<CaptionProject | null>(null);
  const conflictedSave = useRef<{ key: string; basis: CaptionProject } | null>(null);
  const restoredRecovery = useRef<{ key: string; expectedUpdatedAt: string; basis: CaptionProject; origin: RecoveryEntry } | null>(null);
  const correctionPlayback = useRef<{ key: string; recordedStartMs: number; startMs: number; endMs: number } | null>(null);
  const correctionDestination = useRef<{ ticket: ProjectTicket; captionId?: string } | null>(null);
  const correctionRequest = useRef<AbortController | null>(null);
  const [openingCorrection, setOpeningCorrection] = useState<string | null>(null);
  const [correctionReadError, setCorrectionReadError] = useState<{ id: string; message: string } | null>(null);
  const [reviewUndo, setReviewUndo] = useState<ReviewUndoState | null>(null);
  const { confirm: confirmInStudio, confirmationDialog } = useStudioConfirm();

  const media = useRef<HTMLMediaElement | null>(null);
  const mediaPreviewFocus = useRef<HTMLDivElement | null>(null);
  const [mediaElement, setMediaElement] = useState<HTMLMediaElement | null>(null);
  const [firstWatch, setFirstWatch] = useState<{ projectId: string; mediaKey: string } | null>(null);
  const firstWatchNotice = useRef<typeof firstWatch>(null);
  const nativeCaptionPreview = useRef<NativeCaptionPreviewHandle | null>(null);
  const effectReplayController = useRef<AbortController | null>(null);
  const effectPlaybackCancel = useRef<(() => void) | null>(null);
  const appearanceFingerprint = useRef('');
  const replaceInput = useRef<HTMLInputElement | null>(null);
  const editor = useRef<CaptionEditorHandle | null>(null);
  const draftRef = useRef<CaptionSegment[]>([]);
  const draftVersion = useRef(0);
  const draftEditRevision = useRef(0);
  const dirtyRef = useRef(false);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [captionSaveRequests] = useState(() => createCaptionSaveCoalescer<CaptionProject | null>());
  const queuedCaption = useRef<string | null>(null);
  const trackedJobIds = useRef(new Set<string>());
  const handledJobVersions = useRef(new Map<string, string>());
  const wordBatchController = useRef<AbortController | null>(null);
  const wordBatchRunning = useRef(false);
  const wordBatchMutation = useRef<symbol | null>(null);
  const wordBatchArming = useRef(false);
  const wordBatchRevoke = useRef<Promise<void | null> | null>(null);
  const highlightWaiters = useRef(new Set<() => void>());
  const highlightEditorReady = useRef(false);
  const highlightJobActive = useRef(false);
  const highlightFollow = useRef<{ ticket: ProjectTicket; epoch: string; captions: CaptionSegment[]; pending: Set<string>; attempted: Set<string> } | null>(null);
  const lastChangeReason = useRef<DraftChangeReason>('metadata');
  const reviewPlaybackPass = useRef<ReviewPlaybackPass>('focus');

  useEffect(() => {
    handoffRequest.current?.abort();
    handoffRequest.current = null;
    setCaptionHandoffWorking(false);
    setPendingCaptionImport(null);
  }, [mediaKey, workspaceTool]);
  useEffect(() => () => { handoffRequest.current?.abort(); }, []);

  useEffect(() => {
    if (!project && !showAllProjects && returnToHomeControl.current) {
      const target = returnToHomeControl.current === 'upload' ? document.querySelector<HTMLElement>('.empty-stage .dropzone') : homeProjectsButton.current;
      returnToHomeControl.current = null;
      target?.focus();
    }
  }, [project, showAllProjects]);

  async function refreshProjects(options: { startup?: boolean; replaceRead?: boolean; isCurrent?(): boolean } = {}) {
    if (projectListRequest.current && !options.startup && !options.replaceRead) return;
    projectListRequest.current?.abort();
    const request = new AbortController();
    projectListRequest.current = request;
    const binnedDuringRead = new Set<string>();
    projectsBinnedDuringRead.current = binnedDuringRead;
    const basis = captureProjectCollectionBasis(projectItems.current);
    const owns = () => !request.signal.aborted && projectListRequest.current === request && options.isCurrent?.() !== false;
    setProjectListState((current) => ({ ...current, refreshing: true }));
    try {
      const items = await api.listSummaries(request.signal);
      if (!owns()) return;
      const next = reconcileProjectCollection(projectItems.current, items, basis).filter((item) => !binnedDuringRead.has(item.id));
      const origin = libraryReturnId.current;
      const active = document.activeElement;
      if (origin && active === libraryReturnTarget(origin)) {
        // A fresh summary can move the focused row to a different page, or remove
        // it entirely. Follow that first refresh only while the return owns focus.
        releaseLibraryReturn();
        const focus = projectNavigationFocus.capture(active);
        setProjectLibraryView((view) => ({ ...view, page: selectProjectLibrary(next, view, origin).page }));
        projectNavigationFocus.complete(focus, () => libraryReturnTarget(origin));
      }
      setProjects(next);
      startupLoaded.current.add('Projects');
      setStartupErrors((current) => current.filter((label) => label !== 'Projects'));
      setProjectListState({ refreshing: false, error: '' });
    } catch {
      if (!owns()) return;
      setProjectListState({ refreshing: false, error: 'Could not update projects. Try again.' });
      if (!startupLoaded.current.has('Projects')) setStartupErrors((current) => current.includes('Projects') ? current : [...current, 'Projects']);
    } finally {
      if (projectListRequest.current === request) {
        projectListRequest.current = null;
        if (options.isCurrent?.() !== false) setProjectListState((current) => ({ ...current, refreshing: false }));
      }
    }
  }
  const projectBin = useProjectBin({
    active: showAllProjects && !project,
    onRead: (items) => {
      const binned = new Set(items.map((item) => item.id));
      if (projectListRequest.current) for (const id of binned) projectsBinnedDuringRead.current.add(id);
      if (projectItems.current.some((item) => binned.has(item.id))) {
        setProjects((activeItems) => activeItems.filter((item) => !binned.has(item.id)));
      }
    },
    onRemove: (id) => {
      setProjects((items) => items.filter((item) => item.id !== id));
      void refreshProjects({ replaceRead: true });
    },
    onRestore: (restored) => {
      setProjects((items) => [restored, ...items.filter((item) => item.id !== restored.id)]);
      void refreshProjects({ replaceRead: true });
    },
    onRefreshProjects: () => refreshProjects({ replaceRead: true }),
    onNotice: setNotice,
  });

  async function undoProjectMove(move: typeof projectBin.undo[number]) {
    const focus = projectNavigationFocus.capture();
    const restored = await projectBin.restore(move);
    if (restored && projectNavigationFocus.isCurrent(focus)) {
      if (showAllProjects) {
        setShowProjectBin(false);
        setProjectLibraryView((view) => {
          const query = normalizeProjectSearch(restored.title).includes(normalizeProjectSearch(view.query)) ? view.query : '';
          const next = { ...view, query };
          return { ...next, page: selectProjectLibrary(projectItems.current, next, restored.id).page };
        });
      }
      const selector = showAllProjects ? 'data-library-project' : 'data-recent-project';
      projectNavigationFocus.complete(focus, () => document.querySelector<HTMLElement>(`[${selector}="${CSS.escape(restored.id)}"]`));
    } else projectNavigationFocus.cancel(focus);
  }

  function retainProjectTitle<T extends { id: string; title: string }>(item: T): T {
    const ack = projectTitleAck.current;
    return ack?.id === item.id && item.title !== ack.title ? { ...item, title: ack.title } : item;
  }

  async function renameProject(id: string, title: string, expectedTitle: string, editing = false) {
    const ticket = projectScope.current.capture();
    const publishTitle = (savedTitle: string) => {
      if (editing && projectScope.current.isCurrent(ticket)) {
        projectTitleAck.current = { id, title: savedTitle };
        setProject((current) => current?.id === id ? { ...current, title: savedTitle } : current);
      }
      setProjects((items) => items.map((item) => item.id === id ? { ...item, title: savedTitle } : item));
    };
    try {
      const result = await api.renameProject(id, title, expectedTitle);
      publishTitle(result.title);
      if (!editing) setProjectLibraryView((view) => ({ ...view, page: selectProjectLibrary(projectItems.current, view, id).page }));
      setNotice(`Renamed to “${result.title}”.`);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'title_conflict' && error.title !== undefined) publishTitle(error.title);
      if (error instanceof ApiRequestError && error.status === 404) void refreshProjects({ replaceRead: true });
      throw error;
    }
  }
  const previousCollectionScreen = useRef({ projectId: project?.id, all: showAllProjects });
  useEffect(() => {
    const previous = previousCollectionScreen.current;
    previousCollectionScreen.current = { projectId: project?.id, all: showAllProjects };
    if (!project && startupLoaded.current.has('Projects')
      && (previous.projectId !== undefined || previous.all !== showAllProjects)) void refreshProjects();
  }, [project?.id, showAllProjects]);
  useEffect(() => {
    if (project) return;
    let lastWake = 0;
    const refreshOnReturn = () => {
      if (document.visibilityState !== 'visible' || !startupLoaded.current.has('Projects') || Date.now() - lastWake < 500) return;
      lastWake = Date.now();
      void refreshProjects();
    };
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);
    return () => { window.removeEventListener('focus', refreshOnReturn); document.removeEventListener('visibilitychange', refreshOnReturn); };
  }, [Boolean(project)]);
  useEffect(() => () => { projectListRequest.current?.abort(); }, []);

  async function refreshSystemHealth(isCurrent: () => boolean = () => true) {
    const request = ++healthRequest.current;
    const ownsRead = () => request === healthRequest.current && isCurrent();
    try {
      const next = await api.health();
      if (!ownsRead()) return false;
      setHealth(next);
      startupLoaded.current.add('System status');
      setStartupErrors((current) => current.filter((label) => label !== 'System status'));
      return true;
    } catch {
      if (ownsRead()) {
        setHealth(null);
        startupLoaded.current.delete('System status');
        setStartupErrors((current) => current.includes('System status') ? current : [...current, 'System status']);
      }
      return false;
    }
  }

  useEffect(() => {
    let disposed = false;
    setStartupErrors([]);
    const load = <T,>(label: string, operation: () => Promise<T>, publish: (value: T) => void) => {
      // Retry only missing state; never overwrite preferences/settings already edited.
      if (startupLoaded.current.has(label)) return;
      void operation().then((value) => {
        if (!disposed) { publish(value); startupLoaded.current.add(label); }
      }).catch(() => {
        if (!disposed) setStartupErrors((current) => [...current, label]);
      });
    };
    // Independent requests publish independently. Preferences remain required before
    // opening/uploading a project, so late profile hydration cannot reset an edit.
    if (!startupLoaded.current.has('Projects')) void refreshProjects({ startup: true, isCurrent: () => !disposed });
    if (!startupLoaded.current.has('System status')) void refreshSystemHealth(() => !disposed);
    load('Preferences', api.profile, setProfile);
    if (!startupLoaded.current.has('Activity')) {
      void refreshJobs({ feedback: true, startup: true, isCurrent: () => !disposed });
    }
    load('AI connection', api.llmSettings, setLlmSettings);
    return () => { disposed = true; };
  }, [startupAttempt]);

  useEffect(() => () => {
    pendingJobResult.current?.request.abort();
    correctionRequest.current?.abort();
    projectOpen.current?.abort();
    projectScope.current.invalidate();
    cancelPlayback();
  }, []);

  function cancelPlayback(preserveReview = false) {
    if (!preserveReview) {
      reviewPlaybackOwner.current?.release();
      reviewPlaybackOwner.current = null;
    }
    stopEffectReplay();
    stopTimingPreview();
    if (!preserveReview) {
      for (const timer of playbackTimers.current) window.clearTimeout(timer);
      playbackTimers.current.clear();
    }
  }
  function armReviewPlayback(kind: 'review' | 'proposal', startMs: number, pause = false) {
    cancelPlayback();
    const element = media.current;
    if (!element) return;
    reviewPlaybackOwner.current = ownReviewPlayback(element, kind, startMs, pause, () => {
      // Yield without pausing or seeking: the native control now owns playback.
      for (const timer of playbackTimers.current) window.clearTimeout(timer);
      playbackTimers.current.clear();
    });
  }
  function stopEffectReplay() {
    effectReplayController.current?.abort();
    effectReplayController.current = null;
    effectPlaybackCancel.current?.();
    effectPlaybackCancel.current = null;
    setEffectReplayPlaying(false);
  }
  function stopTimingPreview() {
    timingPreviewCancel.current?.();
    timingPreviewCancel.current = null;
  }
  function schedulePlayback(operation: () => void, delayMs = 0) {
    const ticket = projectScope.current.capture();
    const element = media.current;
    const timer = window.setTimeout(() => {
      playbackTimers.current.delete(timer);
      if (projectScope.current.isCurrent(ticket) && media.current === element) operation();
    }, delayMs);
    playbackTimers.current.add(timer);
    return () => { window.clearTimeout(timer); playbackTimers.current.delete(timer); };
  }
  function setProposal(value: RegenerationProposal | null) {
    proposalRead.current += 1;
    proposalViewRevision.current += 1;
    cancelPlayback();
    const ticket = projectScope.current.capture();
    setProposalEntry(value && value.projectId === project?.id
      && ticket.key === projectMediaKey(project) ? { ticket, value } : null);
  }
  function refreshUnfinishedRecoveries() {
    const saved = savedProject.current;
    if (!saved) { setRecoveryEntries([]); return; }
    setRecoveryEntries(recoveryStore.list(saved.id).filter((entry) =>
      (entry.draft.ownerId !== recoveryOwner || entry.draft.mediaKey !== projectMediaKey(saved))
      && entry.key !== restoredRecovery.current?.origin.key));
  }
  function cancelUnfinishedRecovery(restoreFocus = false) {
    const request = recoveryRead.current;
    if (!request) return;
    const focusRequest = restoreFocus ? projectNavigationFocus.capture() : null;
    recoveryRead.current = null;
    request.abort();
    setRecoveryWorking(false);
    if (restoreFocus) projectNavigationFocus.complete(focusRequest, () =>
      document.querySelector<HTMLElement>('.unfinished-recovery .primary') || document.querySelector<HTMLElement>('[data-project-entry-focus]'));
  }
  function hasPendingContextWrite() {
    return (pendingContextWrites.current.get(projectScope.current.capture().key) || 0) > 0;
  }
  function trackCaptionWrite(key: string, change: 1 | -1) {
    const count = (pendingCaptionWrites.current.get(key) || 0) + change;
    if (count > 0) pendingCaptionWrites.current.set(key, count); else pendingCaptionWrites.current.delete(key);
    refreshContextWrites((revision) => revision + 1);
  }
  function trackContextWrite(key: string, change: 1 | -1) {
    const count = (pendingContextWrites.current.get(key) || 0) + change;
    if (count > 0) pendingContextWrites.current.set(key, count); else pendingContextWrites.current.delete(key);
    refreshContextWrites((revision) => revision + 1);
  }
  function captureUnfinishedRecovery(): boolean {
    const saved = savedProject.current;
    if (!saved || projectMediaKey(saved) !== projectScope.current.capture().key) return false;
    // A pending save can replace the old baseline even when newer typing has
    // returned to that baseline. Keep those exact fields until its ACK settles.
    const contextChanged = accuracyDraft.current.hasChanges(profile?.defaultVocabulary) || hasPendingContextWrite();
    // Returning to the old text is still an unfinished intent while an older
    // write may replace that baseline. An unconfirmed POST retains the same
    // protection until an acknowledged save establishes the actual result.
    const captionsMayChange = (pendingCaptionWrites.current.get(projectMediaKey(saved)) || 0) > 0
      || uncertainCaptionWrites.current.has(projectMediaKey(saved));
    const recovery = restoredRecovery.current?.key === projectMediaKey(saved) ? restoredRecovery.current : null;
    const conflict = conflictedSave.current?.key === projectMediaKey(saved) ? conflictedSave.current : null;
    const appearanceState = getCaptionAppearanceSaveState(saved.id, saved.media);
    const appearance = appearanceState.status !== 'saved' ? appearanceState.appearance : null;
    const result = recoveryStore.write({
      // An unrelated mutation can return foreign saved captions/context while
      // the whole local draft is preserved. Never silently rebase that draft:
      // its persisted comparison basis advances only with a guarded save ACK.
      project: conflict?.basis ?? recovery?.basis ?? ordinarySaveBasis.current ?? { ...saved, transcriptionContext: accuracyDraft.current.saved },
      ...(dirtyRef.current || conflict || captionsMayChange ? { captions: draftRef.current } : {}),
      ...(contextChanged || conflict ? { accuracy: accuracyDraft.current.fields } : {}),
      ...(appearance && appearanceState.basis ? { appearance: { ...appearance }, appearanceBasis: { ...appearanceState.basis } } : {}),
      ...(conflict || captionsMayChange ? { keepUnchangedCaptions: true } : {}),
    });
    const unavailable = result.status === 'unavailable' || result.status === 'too-large' || Boolean(appearance && !appearanceState.basis);
    setRecoveryStorageError(unavailable
      ? 'A recovery copy could not be kept in this browser. Keep this tab open until your changes save.' : '');
    if (!conflict && !dirtyRef.current && !captionsMayChange && !contextChanged && !appearance && restoredRecovery.current?.key === projectMediaKey(saved)) {
      recoveryStore.remove(restoredRecovery.current.origin);
      restoredRecovery.current = null;
    }
    return !unavailable && (result.status === 'saved' || result.status === 'cleared');
  }
  async function reloadSavedProject() {
    if (!project) return;
    const ticket = projectScope.current.capture();
    const captionRevision = draftEditRevision.current;
    const contextRevision = accuracyDraft.current.editRevision;
    const appearanceRevision = currentAppearanceSave().revision;
    if (!captureUnfinishedRecovery()) {
      const confirmed = await confirmInStudio({
        title: 'Reload without a recovery copy?',
        message: 'A recovery copy could not be kept in this browser. Download your edits first. Reloading will lose any changes you have not downloaded.',
        confirmLabel: 'Reload anyway',
      });
      if (!confirmed || !projectScope.current.isCurrent(ticket)
        || captionRevision !== draftEditRevision.current || contextRevision !== accuracyDraft.current.editRevision
        || appearanceRevision !== currentAppearanceSave().revision) return;
    }
    // A fresh page resets the old save queues and recovery owner. Keep the
    // exact destination in the fragment, local to the browser.
    const destination = new URL(window.location.href);
    destination.searchParams.set('reloadSavedProject', '1');
    destination.hash = new URLSearchParams({ project: project.id, anchor: destination.hash }).toString();
    window.location.replace(destination.href);
  }
  function rememberSavedCaptions(next: CaptionProject, ownsCaptions = true) {
    if (projectMediaKey(next) !== projectScope.current.capture().key) return;
    const normalized = retainProjectTitle(retainGenerationModel(withCaptionWordTimings(next)));
    savedProject.current = { ...normalized, transcriptionContext: accuracyDraft.current.saved };
    if (ownsCaptions && conflictedSave.current?.key !== projectMediaKey(next)) {
      const previous = ordinarySaveBasis.current;
      ordinarySaveBasis.current = previous && projectMediaKey(previous) === projectMediaKey(next)
        ? { ...normalized, transcriptionContext: previous.transcriptionContext }
        : normalized;
    }
  }
  function protectSaveConflict(reason: unknown, ticket: ProjectTicket) {
    if (!(reason instanceof ApiRequestError) || reason.status !== 409 || !projectScope.current.isCurrent(ticket)) return;
    const basis = restoredRecovery.current?.key === ticket.key ? restoredRecovery.current.basis : ordinarySaveBasis.current;
    if (basis && projectMediaKey(basis) === ticket.key && !conflictedSave.current) {
      conflictedSave.current = { key: ticket.key, basis: structuredClone(basis) };
    }
    setSaveConflict(true);
  }
  function captureOperationIntent() {
    return { ticket: projectScope.current.capture(), key: projectMediaKey(project), revision: operationRevision.current, modelRevision: generationModelRevision.current };
  }
  function isCurrentOperation(intent: ReturnType<typeof captureOperationIntent>) {
    return projectScope.current.isCurrent(intent.ticket) && intent.ticket.key === intent.key
      && intent.revision === operationRevision.current;
  }
  function requestNavigation() {
    // Cancel actions waiting to submit now. Their prerequisite save responses
    // still own the current project until navigation has safely drained them.
    operationRevision.current += 1;
    return captureOperationIntent();
  }
  function openActivityFromNotice(id: string | null = null) {
    // This temporary notice disappears on entry or when the job advances. Give
    // the dialog a persistent return target before it captures keyboard focus.
    const returnTo = project
      ? document.querySelector<HTMLElement>('[data-project-tools-trigger]')
      : document.querySelector<HTMLElement>('.home-tools button:not(:disabled)');
    returnTo?.focus({ preventScroll: true });
    setShowJobs(true, id);
  }
  function closeHistory() {
    historyRead.current += 1;
    pendingHistoryRead.current = null;
    setShowHistory(false);
    setHistoryEntries([]);
    setHistoryLoadState({ loading: false, loaded: false, error: '' });
  }
  function beginNavigation() {
    operationRevision.current += 1;
    cancelUnfinishedRecovery();
    captureUnfinishedRecovery();
    closeHistory();
    setNotice('');
    setPendingMediaReplacement(null);
    setShowMediaBackups(false);
    cancelMediaSourceRead();
    setUnconfirmedSource(null);
    mediaBackupsRequest.current?.abort();
    projectOpen.current?.abort();
    projectOpen.current = null;
    projectScope.current.invalidate();
    setExportRepair(null);
    exportRepairFocus.current = false;
    // Navigation can be canceled by an unsuccessful save, leaving the same media
    // mounted. Invalidate transient timing proposals immediately so neither a
    // canceled request nor an old undo offer remains attached to that editor.
    wordBatchController.current?.abort();
    setWordBatch(EMPTY_HIGHLIGHT_PROGRESS);
    setWordBatchUndo(null);
    setOpeningProjectId(null);
    setProposal(null);
    correctionPlayback.current = null;
    queuedCaption.current = null;
    setReviewMode(false);
    setReviewUndo(null);
    setBusy('');
    return projectScope.current.capture();
  }
  async function goHome() {
    const initiatingControl = document.activeElement;
    if (mediaMutationInFlight.current) {
      setNotice('Wait for the media change to finish before leaving this project.');
      return;
    }
    if (wordBatchMutation.current) {
      setNotice('Finish saving prepared word timings before leaving this project.');
      return;
    }
    const intent = requestNavigation();
    if (!await saveUnfinishedChanges(true, () => isCurrentOperation(intent)) || !isCurrentOperation(intent)) return;
    const focusRequest = projectNavigationFocus.capture(initiatingControl);
    const origin = showAllProjects ? libraryOrigin.current : null;
    libraryReturnId.current = focusRequest ? origin : null;
    if (origin) {
      const page = selectProjectLibrary(projectItems.current, projectLibraryView, origin).page;
      setProjectLibraryView((view) => ({ ...view, page }));
    }
    beginNavigation();
    projectScope.current.select(null);
    setProject(null);
    savedProject.current = null;
    ordinarySaveBasis.current = null;
    conflictedSave.current = null;
    setSaveConflict(false);
    setRecoveryEntries([]);
    setAccuracyFields(accuracyDraft.current.reset(''));
    setDraft([]);
    draftRef.current = [];
    draftVersion.current += 1;
    setTime(0);
    setSelectionAnchor(null);
    setSelectionEnd(null);
    projectNavigationFocus.complete(focusRequest, () => {
      if (!showAllProjects) return document.querySelector<HTMLElement>('.empty-stage .dropzone');
      return libraryReturnTarget(origin);
    });
  }
  function changeProjectListView(allProjects: boolean, returnTo: 'projects' | 'upload' = 'projects') {
    if (project || busy) return;
    // Switching Home/library is a navigation intent too: a pending project read
    // must not open its editor after the creator has returned to the launcher.
    beginNavigation();
    setError('');
    libraryOrigin.current = null;
    releaseLibraryReturn();
    returnToHomeControl.current = allProjects ? null : returnTo;
    setShowProjectBin(false);
    setShowAllProjects(allProjects);
  }
  async function loadProposal(projectId: string, proposalId: string, ticket: ProjectTicket, automatic = false, submittedViewRevision?: number,
    owner?: { isCurrent(): boolean; signal: AbortSignal }) {
    const request = ++proposalRead.current;
    const readViewRevision = proposalViewRevision.current;
    const value = await api.regenerationProposal(projectId, proposalId, owner?.signal);
    if (!projectScope.current.isCurrent(ticket) || request !== proposalRead.current || owner?.signal.aborted || owner?.isCurrent() === false) return false;
    if (value.projectId !== projectId) throw new Error('This preview belongs to another project.');
    if (automatic && (proposalViewRevision.current !== readViewRevision
      || (submittedViewRevision === undefined ? Boolean(currentProposal.current) : proposalViewRevision.current !== submittedViewRevision))) {
      setNotice(currentProposal.current
        ? 'A new take is ready. Your current comparison is kept; open the result from Activity.'
        : 'Improved captions ready. Open them from Activity when you are ready.');
      return false;
    }
    if (automatic && (dirtyRef.current || (media.current && !media.current.paused))) {
      setNotice('Improved captions ready. Open them from Activity when you are ready.');
      return false;
    }
    cancelPlayback();
    proposalViewRevision.current += 1;
    setProposalEntry({ ticket, value });
    return true;
  }

  useEffect(() => {
    if (!profile) return;
    try {
      if (localStorage.getItem(PROFILE_MIGRATION_KEY)) return;
      const legacyGlossary = (localStorage.getItem(LEGACY_GLOSSARY_KEY) || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      const legacyStyle = JSON.parse(localStorage.getItem(LEGACY_STYLE_KEY) || 'null') as { mode?: CaptionMode; maxChars?: number } | null;
      if (!legacyGlossary.length && !legacyStyle) {
        localStorage.setItem(PROFILE_MIGRATION_KEY, '1');
        return;
      }
      const styles = [...profile.styles];
      if (legacyStyle?.mode && Number.isFinite(legacyStyle.maxChars)) {
        const next = { id: 'my-tiktok-style', name: 'My TikTok Style', mode: legacyStyle.mode, maxChars: Number(legacyStyle.maxChars) };
        const index = styles.findIndex((style) => style.id === next.id);
        if (index >= 0) styles[index] = next; else styles.unshift(next);
      }
      api.patchProfile({ defaultVocabulary: uniqueLines(profile.defaultVocabulary, legacyGlossary), styles })
        .then((updated) => { setProfile(updated); localStorage.setItem(PROFILE_MIGRATION_KEY, '1'); })
        .catch(() => {});
    } catch { /* optional legacy migration */ }
  }, [profile]);

  useToastTimeout('notice', notice, 4200, () => setNotice(''));
  useToastTimeout('review-undo', reviewUndo, 6500, () => setReviewUndo(null));
  const latestProjectUndo = projectBin.undo.at(-1) ?? null;
  useToastTimeout('project-undo', latestProjectUndo?.instanceId, 6500, () => { if (latestProjectUndo) projectBin.dismissUndo(latestProjectUndo.instanceId); });

  useEffect(() => {
    if (!project) return;
    const retained = retainedMediaView.current?.key === mediaKey ? retainedMediaView.current : null;
    retainedMediaView.current = null;
    const initialDraft = withCaptionWordTimings(project).captions || [];
    setDraft(initialDraft);
    draftRef.current = initialDraft;
    draftVersion.current += 1;
    setDirty(false);
    dirtyRef.current = false;
    setAutosaveState('saved');
    setWorkspaceTool(retained?.workspace ?? null);
    setReviewMode(retained?.reviewing ?? false);
    setReviewUndo(retained?.reviewUndo ?? null);
    const style = profile?.styles.find((item) => item.id === 'my-tiktok-style') || profile?.styles[0];
    setMaxChars(retained?.maxChars ?? style?.maxChars ?? 18);
    setGroupingMode(retained?.grouping ?? project.mode);
    const requested = queuedCaption.current;
    const first = requested && initialDraft.some((caption) => caption.id === requested) ? requested : initialDraft[0]?.id || null;
    queuedCaption.current = null;
    setSelectionAnchor(retained?.anchor && initialDraft.some((caption) => caption.id === retained.anchor) ? retained.anchor : first);
    setSelectionEnd(retained?.end && initialDraft.some((caption) => caption.id === retained.end) ? retained.end : first);
    if (retained) {
      retainedMediaSeek.current = { key: mediaKey, timeMs: retained.timeMs };
      setTime(retained.timeMs / 1000);
    }
    setLiveAppearance(null);
    setMediaBackups([]);
    setMediaMutationError('');
    setRecoveryConflict(null);
    setSelectedRecoveryKey(null);
    refreshUnfinishedRecoveries();
  }, [mediaKey]);

  useEffect(() => {
    if (!mediaMutationStatus && !unfinishedChanges) return;
    const protectPending = (event: BeforeUnloadEvent) => { captureUnfinishedRecovery(); event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protectPending);
    return () => window.removeEventListener('beforeunload', protectPending);
  }, [mediaMutationStatus, unfinishedChanges, profile?.defaultVocabulary]);
  useEffect(() => { cancelUnfinishedRecovery(); }, [mediaKey]);
  useEffect(() => () => { recoveryRead.current?.abort(); recoveryRead.current = null; }, []);
  useEffect(() => {
    const preserve = () => captureUnfinishedRecovery();
    const onStorage = () => refreshUnfinishedRecoveries();
    window.addEventListener('pagehide', preserve);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener('pagehide', preserve); window.removeEventListener('storage', onStorage); };
  }, [mediaKey, profile?.defaultVocabulary]);
  useEffect(() => () => { mediaBackupsRequest.current?.abort(); }, []);
  useEffect(() => () => { mediaSourceRequest.current?.abort(); }, []);

  useEffect(() => {
    const pending = pendingMediaReplacement;
    if (!pending?.audioConfirmation || mediaMutationInFlight.current) return;
    const confirmation = pending.audioConfirmation;
    if (!projectScope.current.isCurrent(pending.ticket)
      || project?.updatedAt !== confirmation.basis.expectedUpdatedAt
      || draftEditRevision.current !== confirmation.editRevision
      || accuracyDraft.current.editRevision !== confirmation.contextRevision || dirtyRef.current) {
      setPendingMediaReplacement((current) => current?.id === pending.id ? { ...current, audioConfirmation: undefined } : current);
      setMediaMutationError('The project changed since the audio was checked. Check the replacement again before accepting existing times.');
    }
  }, [pendingMediaReplacement, project?.updatedAt, draft, accuracyFields]);

  useEffect(() => {
    wordBatchController.current?.abort();
    wordBatchController.current = null;
    wordBatchRunning.current = false;
    wordBatchMutation.current = null;
    wordBatchRevoke.current = null;
    highlightFollow.current = null;
    setWordTimingFocus(null);
    setWordControlEntry(null);
    setWordBatch(EMPTY_HIGHLIGHT_PROGRESS);
    setWordBatchUndo(null);
  }, [mediaKey]);

  useEffect(() => () => { wordBatchController.current?.abort(); }, []);

  useEffect(() => {
    if (!proposal) return;
    setProposalPreviewMode('proposed');
    setProposalLoop(true);
    setProposalEditedText(captionTextForEditing(proposal.proposedCaptions));
    setProposalAccuracyHint(proposal.accuracyHint || '');
    const preRoll = profile?.preferences.reviewPreRollMs ?? 450;
    return schedulePlayback(() => {
      if (!media.current) return;
      armReviewPlayback('proposal', proposal.startMs - preRoll);
    });
  }, [proposal?.id, mediaKey]);

  const applyProject = (next: CaptionProject, replaceDraft = true, options: { preserveSelection?: boolean; reuseUnchangedDraft?: boolean; preservePlayback?: boolean } = {}) => {
    if (projectTitleAck.current?.id !== next.id) projectTitleAck.current = null;
    next = retainProjectTitle(withCaptionWordTimings(next));
    projectOpen.current?.abort();
    projectOpen.current = null;
    setOpeningProjectId(null);
    const changedMedia = projectScope.current.capture().key !== projectMediaKey(next);
    // An owned save may acknowledge the exact normalized draft. Preserve its
    // row identities without mutating the response or discarding canonical data.
    if (replaceDraft && options.reuseUnchangedDraft && !changedMedia
      && JSON.stringify(next.captions) === JSON.stringify(draftRef.current)) {
      next = { ...next, captions: draftRef.current };
    }
    if (changedMedia) {
      generationModelAck.current = null;
      closeHistory();
      ordinarySaveBasis.current = next;
      conflictedSave.current = null;
      setSaveConflict(false);
      const retained = retainedMediaView.current?.key === projectMediaKey(next) ? retainedMediaView.current : null;
      setAccuracyFields(accuracyDraft.current.reset(projectMediaKey(next), next.transcriptionContext, profile?.defaultVocabulary,
        retained ? { description: retained.description, vocabulary: retained.vocabulary } : undefined));
      setContextSaveState('saved');
      setCaptionSaveError('');
      setContextSaveError('');
      projectScope.current.select(next);
      setProposal(null);
      correctionPlayback.current = null;
      setReviewMode(false);
      setReviewUndo(null);
      setTime(0);
    }
    next = retainAccuracyContext(next);
    rememberSavedCaptions(next);
    setProject(next);
    setProjects((items) => [summarizeProject(next), ...items.filter((item) => item.id !== next.id)]);
    if (replaceDraft) {
      if (!options.preservePlayback || changedMedia) cancelPlayback(Boolean(options.preserveSelection && !changedMedia));
      setDraft(next.captions);
      draftRef.current = next.captions;
      draftVersion.current += 1;
      setDirty(false);
      dirtyRef.current = false;
      setAutosaveState('saved');
      // Caption-save acknowledgements and unfinished-draft recovery keep the
      // current selection. The validity effect below repairs removed IDs;
      // navigation and History continue to use the default selection behavior.
      if (!options.preserveSelection || changedMedia) {
        const validSelection = next.captions.find((caption) => caption.id === selectionAnchor) || next.captions[0];
        if (validSelection) { setSelectionAnchor(validSelection.id); setSelectionEnd(validSelection.id); }
      }
    }
    captureUnfinishedRecovery();
  };

  const publishSameMediaMutation = (
    next: CaptionProject,
    ticket: ProjectTicket,
    editRevision: number,
    draftWasDirty: boolean,
    preservedNotice: string,
    ownsCaptions = true,
    expectedRetainedCaptionBasis?: CaptionProject | null,
    wordTimingOnly = false,
  ): 'applied' | 'preserved' | 'stale' => {
    if (!projectScope.current.isCurrent(ticket) || projectMediaKey(next) !== ticket.key) return 'stale';
    // A draft already dirty when the user accepts a whole-caption mutation may
    // contain an older version of its changed rows. Keep it for comparison;
    // don't grant its next autosave authority to undo the accepted result.
    // Fresh typing following a clean History action retains its save ordering.
    const priorBasis = ordinarySaveBasis.current;
    const retainsDraft = draftWasDirty || draftEditRevision.current !== editRevision;
    // A partial mutation owns only its declared changes. Its full response may
    // also contain foreign rows which never reached this retained local draft.
    // undefined keeps the deliberate whole-caption mutation contract below;
    // null means a partial mutation could not establish a valid expected basis.
    const needsComparison = ownsCaptions && (expectedRetainedCaptionBasis !== undefined
      ? retainsDraft && !matchesCaptionSaveBasis(expectedRetainedCaptionBasis, next)
      : draftWasDirty && priorBasis && projectMediaKey(priorBasis) === ticket.key
        && !matchesCaptionSaveBasis(priorBasis, next)
        && JSON.stringify(next.captions) !== JSON.stringify(draftRef.current));
    if (needsComparison) {
      if (priorBasis && projectMediaKey(priorBasis) === ticket.key && conflictedSave.current?.key !== ticket.key) {
        conflictedSave.current = { key: ticket.key, basis: structuredClone(priorBasis) };
      }
      setSaveConflict(true);
    }
    rememberSavedCaptions(next, ownsCaptions && !needsComparison);
    next = retainAccuracyContext(next);
    if (!draftWasDirty && draftEditRevision.current === editRevision) {
      if (wordTimingOnly) applyProject(next, true, { preserveSelection: wordTimingOnly, preservePlayback: wordTimingOnly });
      else applyProject(next);
      return 'applied';
    }

    const merged: CaptionProject = {
      ...next,
      captions: draftRef.current,
      transcriptNeedsSync: next.transcriptNeedsSync || groupingChangesWording(next, draftRef.current),
    };
    setProject((current) => current?.id === next.id && projectMediaKey(current) === ticket.key ? merged : current);
    setProjects((items) => [summarizeProject(merged), ...items.filter((item) => item.id !== merged.id)]);
    if (JSON.stringify(next.captions) !== JSON.stringify(draftRef.current)) {
      setDirty(true);
      dirtyRef.current = true;
      if (needsComparison || conflictedSave.current?.key === ticket.key) {
        setAutosaveState('failed');
        setCaptionSaveError('The saved captions changed while your newer edits were unfinished. Download your edits, then reload the saved project to compare.');
      } else setAutosaveState('pending');
    }
    setNotice(preservedNotice);
    captureUnfinishedRecovery();
    return 'preserved';
  };

  const publishWordBatchMutation = (
    next: CaptionProject,
    ticket: ProjectTicket,
    editRevision: number,
    changes: Array<{ before: CaptionSegment; after: CaptionSegment }>,
    expectedCaptionBasis: CaptionProject | null,
    preservedNotice: string,
  ) => {
    if (!projectScope.current.isCurrent(ticket) || projectMediaKey(next) !== ticket.key) return 'stale' as const;
    const retainsDraft = editRevision !== draftEditRevision.current || dirtyRef.current;
    // A locally changed batch target cannot safely adopt only the server's
    // timing/approval fields. If its revision changed while the request was in
    // flight, preserve that draft but require comparison before another whole-
    // list save can undo the batch's already accepted on-disk result.
    const locallyChangedTarget = retainsDraft && changes.some(({ before }) =>
      !sameTimingRevision(draftRef.current.find((caption) => caption.id === before.id), before));
    if (retainsDraft) {
      // A person may correct an unrelated caption while a batch request is in
      // flight. Keep those edits and carry the committed word timings into every
      // target they did not modify, so its later autosave cannot undo the batch.
      const merged = mergePublishedWordHighlightBatch(draftRef.current, next.captions, changes);
      if (merged.some((caption, index) => caption !== draftRef.current[index])) {
        draftRef.current = merged;
        setDraft(merged);
        draftVersion.current += 1;
        draftEditRevision.current += 1;
        setDirty(true);
        dirtyRef.current = true;
        setAutosaveState('pending');
      }
    }
    return publishSameMediaMutation(next, ticket, editRevision, false, preservedNotice, true,
      locallyChangedTarget ? null : expectedCaptionBasis, true);
  };

  const copyReplacementEdits = async (recovery: ReplacementEditRecovery) => {
    const payload = JSON.stringify({
      version: 1,
      projectId: recovery.sourceProjectId,
      media: recovery.sourceMedia,
      capturedAt: recovery.capturedAt,
      captions: recovery.captions,
      ...(recovery.accuracyContext ? { accuracyContext: recovery.accuracyContext } : {}),
    }, null, 2);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = payload;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        if (!document.execCommand('copy')) throw new Error('Copy command was unavailable');
        textarea.remove();
      }
      setNotice('Previous-media edit recovery copied.');
    } catch {
      setError('Could not copy the previous-media edits. The recovery notice will stay available.');
    }
  };

  // Full caption responses do not own Accuracy. Explicit context reads/writes
  // reconcile that separate baseline before publishing any full project snapshot.
  function retainGenerationModel(next: CaptionProject): CaptionProject {
    const ack = generationModelAck.current;
    return ack && ack.key === projectMediaKey(next) && ack.key === projectScope.current.capture().key
      ? { ...next, generationModel: ack.value } : next;
  }
  const retainAccuracyContext = (next: CaptionProject): CaptionProject => retainProjectTitle(retainGenerationModel(accuracyDraft.current.retainProject(next)));
  const publishContextProject = (next: CaptionProject, observation: AccuracyObservation, acknowledgement = false, mutation = acknowledgement, ownsContext = mutation) => {
    const ticket = projectScope.current.capture();
    if (ticket.key !== projectMediaKey(next)
      || !accuracyDraft.current.publish(next.transcriptionContext, observation, ticket, profile?.defaultVocabulary, acknowledgement, mutation)) return false;
    setAccuracyFields(accuracyDraft.current.fields);
    const basis = ordinarySaveBasis.current;
    if (basis && projectMediaKey(basis) === ticket.key && conflictedSave.current?.key !== ticket.key
      && (ownsContext || editorAdoptedAccuracy(accuracyDraft.current.fields, next.transcriptionContext, profile?.defaultVocabulary))) {
      ordinarySaveBasis.current = { ...basis, transcriptionContext: next.transcriptionContext, updatedAt: next.updatedAt };
    }
    if (savedProject.current && projectMediaKey(savedProject.current) === ticket.key) {
      savedProject.current = { ...savedProject.current, transcriptionContext: next.transcriptionContext, updatedAt: next.updatedAt };
    }
    setProject((current) => {
      if (!current || current.id !== next.id || projectMediaKey(current) !== ticket.key) return current;
      return { ...current, transcriptionContext: next.transcriptionContext, updatedAt: next.updatedAt };
    });
    setProjects((items) => [
      summarizeProject(retainProjectTitle({ ...next, captions: draftRef.current })),
      ...items.filter((item) => item.id !== next.id),
    ]);
    captureUnfinishedRecovery();
    return true;
  };

  const updateDraft = (next: CaptionSegment[], preferredSelectionId?: string, reason: DraftChangeReason = 'metadata') => {
    stopEffectReplay();
    if (workspaceTool === 'timeline') cancelPlayback();
    const previous = new Map(draftRef.current.map((caption) => [caption.id, caption]));
    next = next.map((caption) => {
      const before = previous.get(caption.id);
      return before ? reconcileCaptionWordTiming(before, caption) : caption;
    });
    // Export and review consume array order. Keep moved captions chronological.
    if (reason === 'timing') next = [...next].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    setDraft(next);
    draftRef.current = next;
    draftVersion.current += 1;
    draftEditRevision.current += 1;
    setDirty(true);
    dirtyRef.current = true;
    setAutosaveState((state) => state === 'failed' ? state : 'pending');
    captureUnfinishedRecovery();
    lastChangeReason.current = reason;
    if (preferredSelectionId && next.some((caption) => caption.id === preferredSelectionId)) {
      setSelectionAnchor(preferredSelectionId);
      setSelectionEnd(preferredSelectionId);
    }
  };

  const vocabularyLines = useMemo(
    () => uniqueLines(profile?.defaultVocabulary, vocabularyText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)),
    [profile?.defaultVocabulary, vocabularyText],
  );
  const globalGlossaryMessage = globalGlossaryFeedback.ticket !== viewTicket ? ''
    : globalGlossaryFeedback.savedVocabulary && JSON.stringify(profile?.defaultVocabulary) !== JSON.stringify(globalGlossaryFeedback.savedVocabulary)
      ? 'Earlier glossary save completed. Newer global glossary choices and your current Accuracy text are kept.'
      : globalGlossaryFeedback.message;
  const contextPayload = (): TranscriptionContext => accuracyPayload(accuracyDraft.current.fields, profile?.defaultVocabulary);
  const qaSettings = useMemo(() => resolveQaProfile(profile?.preferences.qaProfileId, profile?.preferences.qaCustom), [profile?.preferences.qaProfileId, profile?.preferences.qaCustom]);
  const mediaDurationMs = loadedMediaDurationMs || project?.transcript?.timing?.audioDurationMs;
  useEffect(() => { setLoadedMediaDurationMs(0); }, [mediaKey]);
  const issues = useMemo(() => analyzeCaptions(draft, vocabularyLines, qaSettings, mediaDurationMs), [draft, vocabularyLines, qaSettings, mediaDurationMs]);
  const issueMap = useMemo(() => new Map(issues.map((issue) => [issue.captionId, issue])), [issues]);
  const riskyIds = useMemo(() => draft.filter((caption) => !caption.approved && issueMap.has(caption.id)).map((caption) => caption.id), [draft, issueMap]);
  // Approval suppresses some informational flags. Reconsider the same captions
  // only for completion copy; the review queue and export checks keep
  // their existing analysis and approval semantics.
  const reviewedFlags = useMemo(() => reviewMode && !riskyIds.length && draft.some((caption) => caption.approved)
    && analyzeCaptions(draft.map((caption) => caption.approved ? { ...caption, approved: false } : caption), vocabularyLines, qaSettings, mediaDurationMs).length > 0,
  [reviewMode, riskyIds.length, draft, vocabularyLines, qaSettings, mediaDurationMs]);
  const pendingCorrections = profile?.correctionEvents.filter((event) => event.status === 'pending').length || 0;
  const activeJobs = jobs.filter((job) => ['queued', 'running'].includes(job.status));
  const currentProjectAnyActiveJob = project ? activeJobs.find((job) => job.projectId === project.id) : undefined;
  const currentProjectActiveJob = project ? activeJobs.find((job) => job.projectId === project.id && job.type !== 'export-video') : undefined;
  const activeExportJob = project ? activeJobs.find((job) => job.projectId === project.id && job.type === 'export-video') : undefined;
  const currentProjectToastJob = currentProjectActiveJob || activeExportJob;
  const refinementJob = project ? activeJobs.find((job) => job.projectId === project.id && job.type === 'refine-proposal') : undefined;
  const latestCaptionJob = project ? jobs.find((job) => job.projectId === project.id && job.type !== 'export-video') : undefined;
  const generationOptions = project ? <GenerationOptions key={mediaKey} value={project.generationModel}
    disabled={!!busy || !!currentProjectActiveJob || !!mediaMutationStatus || generationPreparing} saving={generationModelSaving}
    expandAfterError={latestCaptionJob?.status === 'failed' && /google|gemini|model|safety/i.test(latestCaptionJob.error || '')}
    onApply={saveGenerationModel}/> : null;

  const selection = useCaptionSelection(draft, selectionAnchor, selectionEnd, time * 1000);
  const selectedReviewReasons = issueMap.get(selection.captions[0]?.id)?.reasons;
  const selectionIntent = useRef({ ids: [] as string[], startMs: 0, endMs: 0 });
  selectionIntent.current = { ids: [...selection.ids], startMs: selection.startMs, endMs: selection.endMs };

  const active = useMemo(() => draft.find((caption) => time * 1000 >= caption.startMs && time * 1000 < caption.endMs) ?? null, [draft, time]);
  const proposedPreviewRange = useMemo(() => {
    if (!proposal) return [] as CaptionSegment[];
    const original = captionTextForEditing(proposal.proposedCaptions);
    if (!proposalEditedText.trim() || proposalEditedText.trim() === original.trim()) return proposal.proposedCaptions;
    return distributePreviewText(proposalEditedText, proposal.proposedCaptions);
  }, [proposal, proposalEditedText]);
  const videoCaptions = useMemo(() => {
    if (!proposal || proposalPreviewMode === 'current') {
      if (workspaceTool === 'timeline' && wordTimingPreview?.mediaKey === mediaKey
        && timingTransactionMatches(draft, wordTimingPreview.change)) {
        return draft.map((caption) => wordTimingPreview.change.after.find((preview) => preview.id === caption.id) ?? caption);
      }
      return draft;
    }
    const outside = draft.filter((caption) => caption.endMs <= proposal.startMs || caption.startMs >= proposal.endMs);
    return [...outside, ...proposedPreviewRange].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  }, [draft, proposal, proposalPreviewMode, proposedPreviewRange, wordTimingPreview, mediaKey, workspaceTool]);
  const [liveAppearance, setLiveAppearance] = useState<{ mediaKey: string; appearance: CaptionAppearance } | null>(null);
  const reconciledAppearance = useReconciledAppearance(project, viewTicket, workspaceTool === 'export' || showJobs, liveAppearance, flushAppearanceSave);
  const [previewResolution, setPreviewResolution] = useState<VideoResolutionPreset>('source');
  const [appearanceInteracting, setAppearanceInteracting] = useState(false);
  useEffect(() => { setAppearanceInteracting(false); }, [project?.id, project?.media.filename, workspaceTool]);
  const changeAppearance = useCallback((appearance: CaptionAppearance) => {
    const fingerprint = JSON.stringify(normalizeCaptionAppearance(appearance));
    if (appearanceFingerprint.current !== fingerprint) stopEffectReplay();
    appearanceFingerprint.current = fingerprint;
    if (project) setLiveAppearance({ mediaKey, appearance });
  }, [mediaKey]);
  const changeCaptionFontLibrary = useCallback(() => {
    stopEffectReplay();
    setCaptionFontRevision((value) => value + 1);
  }, []);
  const previewAppearance = useMemo(() => normalizeCaptionAppearance(liveAppearance?.mediaKey === mediaKey ? liveAppearance.appearance : project?.captionAppearance), [mediaKey, project?.captionAppearance, liveAppearance]);
  useEffect(() => { stopEffectReplay(); }, [mediaKey, selectionAnchor, selectionEnd, workspaceTool]);
  const replayAppearanceEffect = async () => {
    const element = media.current;
    const preview = nativeCaptionPreview.current;
    const caption = selection.captions[0] || active || draftRef.current[0];
    if (!element || !preview || !caption || workspaceTool !== 'appearance') return;
    cancelPlayback();
    element.pause();
    const ticket = projectScope.current.capture();
    const editRevision = draftEditRevision.current;
    const controller = new AbortController();
    effectReplayController.current = controller;
    const cancel = () => controller.abort();
    element.addEventListener('seeking', cancel);
    element.addEventListener('play', cancel);
    const startMs = Math.max(0, caption.startMs - 120);
    const endMs = Math.min(mediaDurationMs || caption.endMs + 120, caption.endMs + 120);
    try {
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        throw new Error('This caption is outside the source playback range. Adjust its timing in Fine timing before replaying.');
      }
      const ready = await preview.prepareReplay(startMs, endMs, controller.signal);
      if (!ready || controller.signal.aborted || !projectScope.current.isCurrent(ticket)
        || media.current !== element || draftEditRevision.current !== editRevision) return;
      element.removeEventListener('seeking', cancel);
      element.removeEventListener('play', cancel);
      let initialSeek = true;
      const finish = () => {
        element.removeEventListener('seeking', onUserSeek);
        if (effectPlaybackCancel.current === stop) {
          effectPlaybackCancel.current = null;
          setEffectReplayPlaying(false);
        }
      };
      const onUserSeek = () => {
        if (initialSeek && Math.abs(element.currentTime * 1000 - startMs) < 50) { initialSeek = false; return; }
        release(false);
      };
      const stop = () => release();
      const release = playTimingRange(element, { startMs, endMs, loop: false },
        () => setError('Effect replay could not start. Check the source playback controls and try again.'), finish);
      effectPlaybackCancel.current = stop;
      element.addEventListener('seeking', onUserSeek);
      setEffectReplayPlaying(true);
    } catch (reason) {
      if (!controller.signal.aborted && projectScope.current.isCurrent(ticket)) {
        setError(reason instanceof Error ? reason.message : 'The effect preview could not be prepared.');
      }
    } finally {
      element.removeEventListener('seeking', cancel);
      element.removeEventListener('play', cancel);
      if (effectReplayController.current === controller) effectReplayController.current = null;
    }
  };
  useEffect(() => { setPreviewResolution('source'); setLiveAppearance(null); }, [project?.id, project?.media.filename]);
  const videoActive = useMemo(() => videoCaptions.find((caption) => time * 1000 >= caption.startMs && time * 1000 < caption.endMs) ?? null, [videoCaptions, time]);
  const reviewFocusMode = profile?.preferences.reviewFocusMode || 'brackets-label';
  const reviewFocusActive = useMemo(() => {
    if (!reviewMode || reviewFocusMode === 'off' || !videoActive) return false;
    const playheadMs = time * 1000;
    if (proposal) return playheadMs >= proposal.startMs && playheadMs < proposal.endMs;
    return selection.captions.some((caption) => playheadMs >= caption.startMs && playheadMs < caption.endMs);
  }, [reviewMode, reviewFocusMode, videoActive, time, proposal, selection.captions]);
  const reviewFocusIndices = useMemo(() => reviewMode && reviewFocusMode !== 'off'
    ? videoCaptions.flatMap((caption, index) => (proposal
      ? caption.endMs > proposal.startMs && caption.startMs < proposal.endMs
      : selection.ids.includes(caption.id)) ? [index] : [])
    : [], [reviewMode, reviewFocusMode, videoCaptions, proposal, selection.ids]);
  const reviewFocusKey = proposal
    ? `${proposal.id}:${proposalPreviewMode}:${videoActive?.id || 'none'}`
    : `${selection.ids.join(',')}:${videoActive?.id || 'none'}`;

  useEffect(() => {
    const current = { anchor: selectionAnchor, end: selectionEnd };
    const valid = reconcileCaptionSelection(draft, current, time * 1000);
    if (valid.anchor !== selectionAnchor) setSelectionAnchor(valid.anchor);
    if (valid.end !== selectionEnd) setSelectionEnd(valid.end);
  }, [draft, selectionAnchor, selectionEnd, time]);

  const refreshProfile = async () => {
    const basis = profile;
    try {
      const received = await api.profile();
      setProfile((current) => reconcileProfileAcknowledgement(current, basis, received));
    } catch { /* optional */ }
  };
  const saveProfilePreferences = async (patch: Partial<AppProfile['preferences']>) => {
    if (!profile) return;
    const expected = { ...profile, preferences: { ...profile.preferences, ...patch } };
    setProfile((current) => current ? { ...current, preferences: { ...current.preferences, ...patch } } : current);
    try {
      const received = await api.patchProfile({ preferences: patch });
      setProfile((current) => reconcileProfileAcknowledgement(current, expected, received, { preferences: patch }));
    } catch { /* Retain the existing optimistic local preference behavior. */ }
  };

  const setInterfaceLanguage = async (next: Locale) => {
    if (!profile || languageSave.current || profile.preferences.interfaceLanguage === next) return;
    const basis = profile;
    const patch = { preferences: { interfaceLanguage: next } };
    setLanguageSaving(true);
    const save = Promise.resolve().then(async () => {
      try {
        const received = await api.patchProfile(patch);
        setProfile((current) => reconcileProfileAcknowledgement(current, basis, received, patch));
      } catch {
        setError(t('common.languageSaveFailed'));
      } finally {
        languageSave.current = null;
        setLanguageSaving(false);
      }
    });
    languageSave.current = save;
    await save;
  };

  // Full-project same-media mutations and caption saves share one acknowledgement
  // order. A later save may become clean only after the mutation it follows has
  // been reconciled, and a queued mutation is dropped if its editor session left.
  const queueSameMediaMutation = <T,>(ticket: ProjectTicket, operation: () => Promise<T>, allowConflict = false): Promise<T | null> => {
    const execute = async () => projectScope.current.isCurrent(ticket) && (allowConflict || conflictedSave.current?.key !== ticket.key) ? operation() : null;
    const task = saveQueue.current.then(execute, execute);
    saveQueue.current = task.then(() => undefined, () => undefined);
    return task;
  };

  const saveDraft = (
    silent = false,
    source: 'manual-save' | 'autosave' | 'text-edit' = 'manual-save',
    recordCorrections = source !== 'autosave',
    forMediaReplacement = false,
  ): Promise<CaptionProject | null> => {
    // A whole-project word batch is being committed under its own revision guard.
    // Do not capture an older draft for a queued caption save that could later
    // overwrite that commit. Local edits remain in the editor for later autosave.
    if (!project || !dirtyRef.current || compositionInProgress.current || wordBatchMutation.current || (mediaMutationInFlight.current && !forMediaReplacement)) return Promise.resolve(null);
    const targetProject = project;
    const ticket = projectScope.current.capture();
    const snapshot = draftRef.current;
    const version = draftVersion.current;
    const recovery = restoredRecovery.current?.key === ticket.key ? restoredRecovery.current : null;
    // Blur, export and other prerequisites may request this same draft before
    // its ACK clears dirty. Join its owned write, without replaying admission or
    // weakening a later request to record correction evidence.
    return captionSaveRequests.run({ ticket, snapshot, version, recovery,
      recordCorrections: !recovery && recordCorrections }, () => {
      const capturedBasis = ordinarySaveBasis.current;
      let submitted = false;
      trackCaptionWrite(ticket.key, 1);
      captureUnfinishedRecovery();

      const execute = async () => {
        try {
          if (conflictedSave.current?.key === ticket.key) return null;
          if (projectScope.current.isCurrent(ticket)) {
            if (!silent) { setBusy('Saving captions…'); setError(''); }
            setAutosaveState('saving');
          }
          const result = await withCaptionAppearanceBarrier(targetProject.id, async () => {
            const basis = projectScope.current.isCurrent(ticket) ? ordinarySaveBasis.current : capturedBasis;
            // Restored drafts still carry recovery-only learning semantics, but a
            // safe Appearance/context write may have advanced the saved revision.
            const expectedUpdatedAt = checkedSaveRevision(recovery?.basis ?? basis, await api.get(targetProject.id), 'captions');
            submitted = true;
            return api.saveCaptions(
              targetProject.id, snapshot,
              { filename: targetProject.media.filename, size: targetProject.media.size },
              { expectedUpdatedAt, source, recordCorrections: recovery ? false : recordCorrections,
                ...(recovery ? { recoveryExpectedUpdatedAt: expectedUpdatedAt } : {}) },
            );
          });
          uncertainCaptionWrites.current.delete(ticket.key);
          // Saving the old project's snapshot is valid; navigating back to it is not.
          if (!projectScope.current.isCurrent(ticket) || projectMediaKey(result.project) !== ticket.key) return result.project;
          rememberSavedCaptions(result.project);
          if (recovery) {
            recovery.expectedUpdatedAt = result.project.updatedAt;
            // A caption ACK does not adopt foreign Accuracy returned beside it.
            recovery.basis = { ...withCaptionWordTimings(result.project), transcriptionContext: recovery.basis.transcriptionContext };
          }
          const unchanged = version === draftVersion.current;
          if (unchanged) applyProject(result.project, true, { preserveSelection: true, reuseUnchangedDraft: true });
          else {
            const acknowledged = retainAccuracyContext(result.project);
            setProject((current) => current?.id === result.project.id ? { ...acknowledged, captions: draftRef.current } : current);
            setProjects((items) => [summarizeProject(acknowledged), ...items.filter((item) => item.id !== result.project.id)]);
            setAutosaveState('pending');
          }
          captureUnfinishedRecovery();
          if (result.correctionsCreated > 0) {
            await refreshProfile();
            if (projectScope.current.isCurrent(ticket)) setNotice(`${result.correctionsCreated} correction${result.correctionsCreated === 1 ? '' : 's'} captured in the Inbox.`);
          } else if (!silent) setNotice('Captions saved.');
          return result.project;
        } catch (reason) {
          if (submitted) uncertainCaptionWrites.current.add(ticket.key);
          if (projectScope.current.isCurrent(ticket)) {
            protectSaveConflict(reason, ticket);
            setCaptionSaveError(reason instanceof Error ? reason.message : 'Caption save failed.');
            setAutosaveState('failed');
            captureUnfinishedRecovery();
          }
          return null;
        } finally {
          trackCaptionWrite(ticket.key, -1);
          if (projectScope.current.isCurrent(ticket)) {
            captureUnfinishedRecovery();
            if (!silent) setBusy('');
          }
        }
      };

      const task = saveQueue.current.then(execute, execute);
      saveQueue.current = task.then(() => undefined, () => undefined);
      return task;
    });
  };

  useEffect(() => {
    if (!project || !dirty || textEditing || textComposing || autosaveState === 'failed' || autosaveState === 'saving' || groupingApplying || wordBatchMutation.current || mediaMutationInFlight.current) return;
    const delay = profile?.preferences.autosaveDelayMs ?? 2200;
    const timer = window.setTimeout(() => { void saveDraft(true, 'autosave', false); }, delay);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, textEditing, textComposing, autosaveState, groupingApplying, busy, wordBatch.status, project?.id, profile?.preferences.autosaveDelayMs]);

  const syncCaptionWords = async (caption: CaptionSegment, signal?: AbortSignal) => {
    if (!project || busy || currentProjectActiveJob || caption.timingLocked) return null;
    const ticket = projectScope.current.capture();
    if (!sameTimingRevision(draftRef.current.find((item) => item.id === caption.id), caption)) return null;
    if (savedProject.current?.wordHighlightFollow?.enabled && previewAppearance.highlightMode === 'word') {
      const result = await startWordHighlightPreparation('follow', [caption.id], signal, true);
      const outcome = result?.dispositions.get(caption.id);
      return result ? { published: true as const, message: result.applied
        ? 'Word timing saved. Replay to check it.'
        : outcome === 'candidate' || outcome === 'reused' ? 'The saved word timing was kept.' : 'This caption still needs a listen.' } : null;
    }
    const editRevision = draftEditRevision.current;
    const hadEdits = dirtyRef.current;
    const saved = await saveDraft(true, 'manual-save', true);
    if (signal?.aborted || !projectScope.current.isCurrent(ticket)) return null;
    if (hadEdits && !saved) throw new Error('Save the caption successfully before syncing its words.');
    if (editRevision !== draftEditRevision.current || dirtyRef.current) throw new Error('The caption changed while saving. Sync its words again when the edit is ready.');
    const basis = draftRef.current.find((item) => item.id === caption.id);
    if (!basis || basis.timingLocked) return null;
    setBusy('Syncing word timing…');
    try {
      const candidate = await api.syncCaptionWords(project.id, basis, { filename: project.media.filename, size: project.media.size }, signal, true);
      if (signal?.aborted || !projectScope.current.isCurrent(ticket)) return null;
      if (!sameTimingRevision(draftRef.current.find((item) => item.id === basis.id), basis)) {
        setNotice('The caption changed during word sync. Your newer edits were kept.');
        return null;
      }
      return candidate;
    } finally { if (projectScope.current.isCurrent(ticket)) setBusy(''); }
  };


  function waitForHighlightEditor<T>(signal: AbortSignal, read: () => T | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (signal.aborted) { dispose(); reject(signal.reason); return; }
        const value = read();
        if (value !== undefined) { dispose(); resolve(value); }
      };
      const dispose = () => {
        highlightWaiters.current.delete(check);
        signal.removeEventListener('abort', check);
      };
      highlightWaiters.current.add(check);
      signal.addEventListener('abort', check, { once: true });
      check();
    });
  }

  function adoptHighlightIntent(ticket: ProjectTicket, result: { wordHighlightFollow: WordHighlightFollow | null; updatedAt: string }) {
    if (!projectScope.current.isCurrent(ticket)) return;
    const withIntent = (current: CaptionProject) => ({ ...current,
      updatedAt: result.updatedAt > current.updatedAt ? result.updatedAt : current.updatedAt,
      wordHighlightFollow: result.wordHighlightFollow ?? undefined,
    });
    if (savedProject.current && projectMediaKey(savedProject.current) === ticket.key) {
      savedProject.current = withIntent(savedProject.current);
    }
    if (ordinarySaveBasis.current && projectMediaKey(ordinarySaveBasis.current) === ticket.key) {
      ordinarySaveBasis.current = withIntent(ordinarySaveBasis.current);
    }
    setProject((current) => current && projectMediaKey(current) === ticket.key ? withIntent(current) : current);
  }

  function highlightSavedWhenClean(ticket: ProjectTicket) {
    const saved = savedProject.current;
    if (!saved || !projectScope.current.isCurrent(ticket) || projectMediaKey(saved) !== ticket.key
      || !highlightEditorReady.current || dirtyRef.current || compositionInProgress.current
      || wordBatchMutation.current || mediaMutationInFlight.current || conflictedSave.current?.key === ticket.key) return;
    return saved;
  }

  const startWordHighlightPreparation = async (intent: WordHighlightIntent, ids?: string[], signal?: AbortSignal, retry = false) => {
    if (!project || wordBatchRunning.current || wordBatchRevoke.current || signal?.aborted) return;
    const target = project;
    const ticket = projectScope.current.capture();
    const expectedMedia = { filename: target.media.filename, size: target.media.size };
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const owns = () => wordBatchController.current === controller && projectScope.current.isCurrent(ticket);
    const changeProgress = (state: WordHighlightProgress) => {
      if (owns() && !controller.signal.aborted) setWordBatch(state);
    };

    wordBatchController.current = controller;
    wordBatchRunning.current = true;
    let historyRecovery = false;
    let applied = false;
    try {
      const result = await runWordHighlightPass({
        intent, ids, signal: controller.signal,
        // A repeat Apply over the same saved inputs skips known terminal work.
        // Sync remaining is the explicit way to retry those exceptions.
        attempted: retry ? undefined : highlightFollow.current?.attempted,
        waitForClean: (afterRevision) => {
          const ready = highlightSavedWhenClean(ticket);
          if (ready && ready.updatedAt !== afterRevision) return Promise.resolve(ready);
          if (owns()) setWordBatch((state) => ({ ...state, status: 'waiting-for-save', pauseReason: afterRevision ? 'edits' : undefined }));
          return waitForHighlightEditor(controller.signal, () => {
            const saved = highlightSavedWhenClean(ticket);
            return saved?.updatedAt !== afterRevision ? saved : undefined;
          });
        },
        waitForJob: async () => {
          await refreshJobs({ isCurrent: owns });
          if (highlightJobActive.current) {
            await waitForHighlightEditor(controller.signal, () => highlightJobActive.current ? undefined : true);
          } else {
            // The job can finish before the existing jobs read sees it.
            await new Promise((resolve) => window.setTimeout(resolve, 400));
          }
          return owns() && !controller.signal.aborted;
        },
        arm: async () => await queueSameMediaMutation(ticket, async () => {
          if (controller.signal.aborted || !highlightSavedWhenClean(ticket)) return null;
          return withCaptionAppearanceBarrier(target.id, async () => {
            if (controller.signal.aborted || !highlightSavedWhenClean(ticket)) return null;
            wordBatchArming.current = true;
            try {
              const result = await api.updateWordHighlightFollow(target.id, expectedMedia, 'arm');
              adoptHighlightIntent(ticket, result);
              return result.wordHighlightFollow?.epoch ?? null;
            } finally { wordBatchArming.current = false; }
          });
        }),
        prepare: (fetchSignal) => api.prepareWordHighlights(target.id, expectedMedia, fetchSignal),
        candidates: (chunk, fetchSignal) => api.checkWordHighlightCandidates(target.id, expectedMedia, chunk, fetchSignal),
        inPublicationLane: async (operation) => Boolean(await queueSameMediaMutation(ticket, async () => {
          if (controller.signal.aborted || !highlightSavedWhenClean(ticket)) return false;
          const token = Symbol('word-highlight-publication');
          wordBatchMutation.current = token;
          const editRevision = draftEditRevision.current;
          const basis = ordinarySaveBasis.current;
          try {
            await operation((response) => {
              if (!owns() || projectMediaKey(response.project) !== ticket.key) return;
              const changes = response.applied;
              if (changes.length) {
                applied = true;
                if (intent === 'apply') setWordBatchUndo({ ticket, applied: changes });
              }
              publishWordBatchMutation(response.project, ticket, editRevision, changes,
                changes.length ? wordHighlightBatchSaveBasis(basis, changes) : basis,
                'Word highlights were saved. Your newer caption edits are still in the editor.');
            });
            return true;
          } finally {
            if (wordBatchMutation.current === token) wordBatchMutation.current = null;
          }
        })),
        publish: (epoch, keys, requestId) => api.publishPreparedWordHighlights(target.id, expectedMedia, intent, epoch, keys, requestId, AbortSignal.timeout(20_000)),
        readReceipt: (id) => api.readWordHighlightPublication(target.id, expectedMedia, id, AbortSignal.timeout(4_000)),
        readProject: () => api.get(target.id, AbortSignal.timeout(4_000)),
        onProgress: changeProgress,
        onHistoryRecovery: () => {
          historyRecovery = true;
          if (owns()) {
            setWordBatchUndo(null);
            setNotice('Word highlights were saved. To restore the earlier timing, open History and choose “Before applying word highlights”.');
          }
        },
        onUnconfirmedPublication: () => {
          if (owns()) setNotice('Studio could not confirm whether the word highlights were saved. Reload the saved project to check.');
        },
        newRequestId: () => crypto.randomUUID(),
        delay: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
      });
      if (result && owns() && highlightFollow.current?.ticket === ticket) {
        const follow = highlightFollow.current;
        const changed = new Set(affectedHighlightIds(result.captions, savedProject.current?.captions ?? []));
        for (const [id, disposition] of result.dispositions) {
          if (!changed.has(id) && !['stale', 'locked', 'non-speech'].includes(disposition)) {
            if (follow.attempted.size >= 5_000) follow.attempted.delete(follow.attempted.values().next().value!);
            follow.attempted.add(id);
          }
        }
      }
      return result && { applied: applied || historyRecovery, dispositions: result.dispositions };
    } finally {
      signal?.removeEventListener('abort', abort);
      if (wordBatchController.current === controller) {
        wordBatchController.current = null;
        wordBatchRunning.current = false;
        if (projectScope.current.isCurrent(ticket)) {
          setWordBatch((state) => !['paused', 'complete'].includes(state.status)
            ? { ...state, status: applied || historyRecovery ? 'complete' : 'idle' }
            : { ...state });
        }
      }
    }
  };

  const revokeWordHighlights = () => {
    wordBatchController.current?.abort();
    highlightFollow.current?.pending.clear();
    if (!project || wordBatchRevoke.current) return;
    const ticket = projectScope.current.capture();
    const expectedMedia = { filename: project.media.filename, size: project.media.size };
    const epoch = savedProject.current?.wordHighlightFollow?.epoch;
    const targetId = project.id;
    if (!savedProject.current?.wordHighlightFollow?.enabled && !wordBatchArming.current) return;
    const revoke = () => api.updateWordHighlightFollow(targetId, expectedMedia, 'revoke', epoch);
    // Send revocation immediately if a publication is awaiting its ACK. The
    // server serializes both writes. Adopt the revoke ACK after the publication
    // response (or receipt) so it cannot resurrect an older enabled epoch.
    const early = !wordBatchArming.current ? revoke().then((result) => ({ result }), () => null) : null;
    const pending = queueSameMediaMutation(ticket, async () => {
      try {
        const response = (early && await early)?.result ?? await revoke();
        adoptHighlightIntent(ticket, response);
      } catch (error) {
        if (projectScope.current.isCurrent(ticket)
          && !(error instanceof ApiRequestError && error.code === 'WORD_HIGHLIGHT_INTENT_CHANGED')) {
          setError('Could not stop automatic word highlighting. Try turning it off again.');
        }
      }
    }, true);
    wordBatchRevoke.current = pending;
    void pending.finally(() => {
      if (wordBatchRevoke.current !== pending) return;
      wordBatchRevoke.current = null;
      if (projectScope.current.isCurrent(ticket)) setWordBatch((state) => ({ ...state }));
    });
  };

  const undoPreparedWordHighlights = async () => {
    if (!project || !wordBatchUndo || !highlightSavedWhenClean(wordBatchUndo.ticket) || wordBatchRevoke.current) return;
    revokeWordHighlights();
    const { ticket, applied } = wordBatchUndo;
    const target = project;
    const token = Symbol('word-highlight-undo');
    setBusy('Undoing word highlights…');
    try {
      await queueSameMediaMutation(ticket, async () => {
        if (dirtyRef.current || compositionInProgress.current) return;
        wordBatchMutation.current = token;
        const editRevision = draftEditRevision.current;
        const reverse = applied.map(({ before, after }) => ({ before: after, after: before }));
        const captionBasis = wordHighlightBatchSaveBasis(ordinarySaveBasis.current, reverse);
        const response = await api.applyWordHighlightBatch(target.id,
          { filename: target.media.filename, size: target.media.size }, reverse, 'undo', 'apply');
        const published = publishWordBatchMutation(response.project, ticket, editRevision, reverse, captionBasis,
          'Word highlights were undone. Your newer caption edits are still in the editor.');
        if (published !== 'stale') {
          setWordBatchUndo(null);
          setWordBatch(EMPTY_HIGHLIGHT_PROGRESS);
          if (published === 'applied') setNotice('Word highlights were undone.');
        }
      });
    } catch (error) {
      if (projectScope.current.isCurrent(ticket)) {
        if (error instanceof ApiRequestError && error.status === 409) {
          setWordBatchUndo(null);
          setNotice('Those captions have newer edits. Use History to restore the earlier word highlights if needed.');
        } else setError('Could not undo word highlights.');
      }
    } finally {
      if (wordBatchMutation.current === token) wordBatchMutation.current = null;
      if (projectScope.current.isCurrent(ticket)) setBusy('');
    }
  };

  const reviewRemainingWordHighlights = (afterId?: string) => {
    const index = wordHighlightSummary.exceptions.findIndex(({ id }) => id === afterId);
    const next = wordHighlightSummary.exceptions[index + 1] ?? wordHighlightSummary.exceptions[0];
    if (next) {
      openWordTiming(next.id, next.wordId);
      if (next.locked) setNotice('Caption timing is locked.');
    }
  };

  const refreshJobs = async (options: { feedback?: boolean; startup?: boolean; isCurrent?(): boolean } = {}) => {
    if (options.feedback && !options.startup && manualJobRead.current !== null) return;
    const read = ++jobReadGeneration.current;
    if (options.feedback) {
      manualJobRead.current = read;
      setJobLoadState((current) => ({ ...current, loading: true }));
    }
    const ownsRead = () => options.isCurrent?.() !== false && read >= appliedJobRead.current;
    const settleFeedback = () => {
      if (manualJobRead.current !== null && read >= manualJobRead.current) manualJobRead.current = null;
    };
    try {
      const items = await api.jobs();
      if (!ownsRead()) return;
      appliedJobRead.current = read;
      lastSuccessfulJobRead.current = read;
      settleFeedback();
      items.filter((job) => ['queued', 'running', 'interrupted'].includes(job.status))
        .forEach((job) => trackedJobIds.current.add(job.id));
      setJobs((current) => mergeJobSnapshot(current, items));
      startupLoaded.current.add('Activity');
      setStartupErrors((current) => current.includes('Activity') ? current.filter((label) => label !== 'Activity') : current);
      setJobLoadState((current) => {
        const loading = manualJobRead.current !== null;
        return current.loaded && !current.error && current.loading === loading ? current : { loading, loaded: true, error: '' };
      });
    } catch {
      if (!ownsRead()) return;
      appliedJobRead.current = read;
      settleFeedback();
      setJobLoadState((current) => ({ ...current, loading: manualJobRead.current !== null, error: 'Could not update activity. Try again.' }));
      if (options.startup && !startupLoaded.current.has('Activity')) {
        setStartupErrors((current) => current.includes('Activity') ? current : [...current, 'Activity']);
      }
    } finally {
      if (manualJobRead.current === read) {
        manualJobRead.current = null;
        if (options.isCurrent?.() !== false) setJobLoadState((current) => ({ ...current, loading: false }));
      }
    }
  };

  const actOnJob = async (id: string, action: 'resume' | 'cancel') => {
    if (pendingJobActionIds.current.has(id)) return;
    const requestedJob = jobs.find((job) => job.id === id);
    if (!requestedJob) return;
    pendingJobActionIds.current.add(id);
    appliedJobRead.current = ++jobReadGeneration.current;
    if (action === 'resume') {
      trackedJobIds.current.add(id);
      // Resume retains the job's original input, not the current comparison draft.
      proposalJobRevisions.current.delete(id);
      // Ignore the old failure while listening for a new server observation.
      handledJobVersions.current.set(id, jobObservation(requestedJob));
    }
    setPendingJobActions((current) => ({ ...current, [id]: action }));
    try {
      const updated = await (action === 'resume' ? api.resumeJob(id) : api.cancelJob(id));
      appliedJobRead.current = ++jobReadGeneration.current;
      // The mutation response is server evidence even if the following refresh
      // fails. A late response must not replace a newer streamed job state.
      setJobs((current) => current.map((job) => {
        if (job.id !== id || job !== requestedJob && Date.parse(job.updatedAt) >= Date.parse(updated.updatedAt)) return job;
        return updated;
      }));
      return true;
    } catch {
      return false;
    } finally {
      pendingJobActionIds.current.delete(id);
      setPendingJobActions((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      void refreshJobs();
    }
  };

  const closeActivity = () => {
    setBlockedSwitch(null);
    const pending = pendingJobResult.current;
    if (pending) {
      pending.request.abort();
      if (projectOpen.current === pending.request) projectOpen.current = null;
      pendingJobResult.current = null;
      setOpeningJobId(null);
      // Closing this surface withdraws its explicit Open intent, including a
      // proposal read that follows a completed project read.
      operationRevision.current += 1;
      proposalRead.current += 1;
    }
    if (projectAwaitingJobCheck && jobLoadState.loaded && !jobLoadState.loading && !jobLoadState.error) {
      const reviewedRead = lastSuccessfulJobRead.current;
      setUncertainJobs((items) => items.filter((item) => item.key !== mediaKey || item.afterRead >= reviewedRead));
    }
    setShowJobs(false);
  };
  const openJobResult = async (job: ProcessingJob) => {
    if (pendingJobResult.current?.id === job.id) return;
    if (mediaMutationInFlight.current) {
      setNotice('Wait for the media change to finish before opening another result.');
      return;
    }
    if (wordBatchMutation.current) {
      setNotice('Finish saving prepared word timings before opening another result.');
      return;
    }
    const intent = requestNavigation();
    pendingJobResult.current?.request.abort();
    const trigger = document.activeElement;
    const pending = { id: job.id, request: new AbortController() };
    pendingJobResult.current = pending;
    setOpeningJobId(job.id);
    setBlockedSwitch(null);
    let ticket = intent.ticket;
    let navigationRevision = intent.revision;
    setError('');
    try {
      if (!await saveBeforeSwitch('activity', job.id, () => isCurrentOperation(intent) && pendingJobResult.current === pending)) return;
      ticket = beginNavigation();
      navigationRevision = operationRevision.current;
      projectOpen.current = pending.request;
      const readRevision = draftEditRevision.current;
      const contextRevision = accuracyDraft.current.editRevision;
      const appearanceRevision = currentAppearanceSave().revision;
      const contextObservation = accuracyDraft.current.capture(ticket);
      const target = await api.get(job.resultProjectId || job.projectId, pending.request.signal);
      if (pending.request.signal.aborted || projectOpen.current !== pending.request || pendingJobResult.current !== pending
        || operationRevision.current !== navigationRevision || !projectScope.current.isCurrent(ticket)) return;
      if (dirtyRef.current || readRevision !== draftEditRevision.current || contextRevision !== accuracyDraft.current.editRevision || accuracyDraft.current.hasChanges(profile?.defaultVocabulary)
        || appearanceRevision !== currentAppearanceSave().revision || currentAppearanceSave().status !== 'saved') {
        setBlockedSwitch({ surface: 'activity', id: job.id });
        return;
      }
      // The GET is settled. Applying it may perform further proposal reads;
      // do not mark this navigation aborted merely because its first read ended.
      projectOpen.current = null;
      publishContextProject(target, contextObservation);
      applyProject(target);
      ticket = projectScope.current.capture();
      if (job.proposalId) {
        if (!await loadProposal(target.id, job.proposalId, ticket, false, undefined, {
          signal: pending.request.signal,
          isCurrent: () => pendingJobResult.current === pending && operationRevision.current === navigationRevision,
        }) || !projectScope.current.isCurrent(ticket)
          || pendingJobResult.current !== pending || operationRevision.current !== navigationRevision) return;
      } else setNotice(compatibilityTranscriptionNotice(target) || (job.resultExport ? 'Export project opened. Compare the video with current content in Activity.' : 'Completed caption job opened.'));
      if ((job.proposalId || target.id !== project?.id) && (document.activeElement === trigger || document.activeElement === document.body)) {
        activityResultFocus.current = { ticket, comparison: Boolean(job.proposalId) };
      }
      setShowJobs(false);
      handledJobVersions.current.set(job.id, jobObservation(job));
    } catch (reason) {
      if (!pending.request.signal.aborted && pendingJobResult.current === pending
        && operationRevision.current === navigationRevision && projectScope.current.isCurrent(ticket)) {
        setError(reason instanceof Error ? reason.message : 'Could not open the job result. Try opening it again from Activity.');
      }
    } finally {
      if (projectOpen.current === pending.request) projectOpen.current = null;
      if (pendingJobResult.current === pending) { pendingJobResult.current = null; setOpeningJobId(null); }
    }
  };

  const shouldPollJobs = showJobs || jobs.some((job) => ['queued', 'running'].includes(job.status));
  useEffect(() => {
    if (!shouldPollJobs) return;
    let disposed = false;
    let timer: number;
    const poll = async () => {
      await refreshJobs({ isCurrent: () => !disposed });
      if (!disposed) timer = window.setTimeout(() => void poll(), 1000);
    };
    timer = window.setTimeout(() => void poll(), 1000);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [shouldPollJobs]);

  useEffect(() => {
    setJobNotification((current) => current && jobs.some((job) => job.id === current.id && jobObservation(job) === current.observation) ? current : null);
  }, [jobs]);

  useEffect(() => {
    if (mediaMutationInFlight.current || pendingMediaReplacement || showMediaBackups) return;
    for (const job of jobs) {
      const observation = jobObservation(job);
      if (!trackedJobIds.current.has(job.id) || handledJobVersions.current.get(job.id) === observation) continue;
      if (job.status === 'completed') {
        const submittedViewRevision = proposalJobRevisions.current.get(job.id);
        proposalJobRevisions.current.delete(job.id);
        if (project?.id === job.projectId) {
          handledJobVersions.current.set(job.id, observation);
          const ticket = projectScope.current.capture();
          const version = draftVersion.current;
          const notificationRevision = jobNotificationRevision.current;
          const activityRevision = jobsViewRevision.current;
          const reportResultReadFailure = () => {
            if (!projectScope.current.isCurrent(ticket) || handledJobVersions.current.get(job.id) !== observation
              || jobNotificationRevision.current !== notificationRevision) return;
            notifyJob(job, 'Processing completed, but the result could not be loaded. Open Activity and choose Open result to try again.');
          };
          if (job.proposalId) {
            void loadProposal(job.projectId, job.proposalId, ticket, true, submittedViewRevision)
              .then((opened) => { if (opened && projectScope.current.isCurrent(ticket)) {
                if (jobsViewRevision.current === activityRevision) setShowJobs(false);
                setNotice('Improved captions ready. Review them before applying.');
              } })
              .catch(reportResultReadFailure);
          } else if (job.resultProjectId) {
            const contextObservation = accuracyDraft.current.capture(ticket);
            void api.get(job.resultProjectId).then((value) => {
              if (!projectScope.current.isCurrent(ticket) || projectMediaKey(value) !== ticket.key) return;
              const compatibilityNotice = compatibilityTranscriptionNotice(value);
              if (dirtyRef.current || version !== draftVersion.current) {
                setNotice(compatibilityNotice
                  ? `${compatibilityNotice} Your newer edits are kept; open the result from Activity.`
                  : 'Caption generation completed. Your newer edits are kept; the result is available in Activity.');
                return;
              }
              const watch = !draftRef.current.length && value.captions.length && isVideoProject(value)
                ? { projectId: value.id, mediaKey: projectMediaKey(value) }
                : null;
              publishContextProject(value, contextObservation);
              applyProject(value);
              if (watch) {
                firstWatchNotice.current = compatibilityNotice ? null : watch;
                setFirstWatch(watch);
              }
              if (compatibilityNotice || !watch) setNotice(compatibilityNotice || 'Background caption generation completed.');
            }).catch(reportResultReadFailure);
          } else if (job.resultExport) {
            setNotice(`Captioned video ready: ${job.resultExport.filename}. Open Activity to download it.`);
          }
        }
      } else if (job.status === 'failed') {
        proposalJobRevisions.current.delete(job.id);
        handledJobVersions.current.set(job.id, observation);
        notifyJob(job, job.error || 'Processing could not finish. Open Activity to review the result and retry.');
      } else if (job.status === 'interrupted') {
        handledJobVersions.current.set(job.id, observation);
        notifyJob(job, job.canResume
          ? 'Processing was interrupted. Open Activity and choose Resume to continue from saved progress.'
          : job.message || 'Processing needs attention. Open Activity to check its saved outcome.', false);
      } else if (job.status === 'cancelled') {
        proposalJobRevisions.current.delete(job.id);
      }
    }
  }, [jobs, project?.id, pendingMediaReplacement, showMediaBackups, mediaMutationStatus]);

  const startJob = async (intent: ReturnType<typeof captureOperationIntent>, operation: () => Promise<ProcessingJob>, message: string, openQueue = true, captionJob = true) => {
    // Callers retain this intent across confirmation and prerequisite saves;
    // capturing a new project ticket here would revive a canceled action.
    if (!isCurrentOperation(intent) || mediaMutationInFlight.current) return null;
    if (captionJob && (generationModelWrite.current || intent.modelRevision !== generationModelRevision.current)) {
      setNotice('AI options changed while preparing this request. Start again with the saved choice.');
      return null;
    }
    if (uncertainJobs.some((item) => item.key === intent.key && item.captionJob === captionJob)) {
      openActivityFromNotice();
      void refreshJobs({ feedback: true });
      return null;
    }
    const submittingControl = document.activeElement;
    const ownsPreparation = captionJob && !generationPreparation.current;
    const submittedViewRevision = proposalViewRevision.current;
    const submittedActivityRevision = jobsViewRevision.current;
    if (ownsPreparation) { generationPreparation.current = true; setGenerationPreparing(true); }
    setError('');
    try {
      const job = await operation();
      if ((job.type === 'refine-proposal' || job.type === 'regenerate-range') && !handledJobVersions.current.has(job.id)) {
        proposalJobRevisions.current.set(job.id, submittedViewRevision);
      }
      appliedJobRead.current = ++jobReadGeneration.current;
      trackedJobIds.current.add(job.id);
      // A fast job can finish before its initial POST acknowledgement arrives.
      // Keep the newest observed result and its already handled completion.
      const observed = mergeJobSnapshot(jobItems.current, [job])[0];
      setJobs((current) => [observed, ...current.filter((item) => item.id !== job.id)]);
      if (isCurrentOperation(intent)) {
        if (openQueue && jobsViewRevision.current === submittedActivityRevision) setShowJobs(true, job.id);
        if (observed.status === 'queued' || observed.status === 'running') setNotice(message);
      }
      return observed;
    } catch (reason) {
      const current = isCurrentOperation(intent);
      if (reason instanceof ApiRequestError) {
        if (current) setError(reason.message);
      } else {
        // The server can accept the job before this tab navigates or loses the reply.
        const receipt = { key: intent.key, title: project?.title || 'this project', captionJob,
          afterRead: jobReadGeneration.current, dismissed: false };
        setUncertainJobs((items) => [...items.filter((item) => item.key !== intent.key || item.captionJob !== captionJob), receipt]);
        void refreshJobs({ feedback: current });
        if (current && openQueue && jobsViewRevision.current === submittedActivityRevision && !document.querySelector('[aria-modal="true"]')
          && (document.activeElement === submittingControl || document.activeElement === document.body)) openActivityFromNotice();
      }
      return null;
    } finally {
      if (ownsPreparation) { generationPreparation.current = false; setGenerationPreparing(false); }
    }
  };

  const seek = (ms: number) => { cancelPlayback(); if (media.current) media.current.currentTime = Math.max(0, ms) / 1000; };
  const reviewLeadMs = (pass: ReviewPlaybackPass) => {
    const configured = profile?.preferences.reviewPreRollMs ?? 450;
    return pass === 'context' ? configured : Math.min(configured, 140);
  };
  const reviewTailMs = (pass: ReviewPlaybackPass) => {
    const configured = profile?.preferences.reviewPostRollMs ?? 300;
    return pass === 'context' ? configured : Math.min(configured, 120);
  };
  const replayProposal = (focusMs?: number) => {
    if (!media.current || !proposal || !projectScope.current.isCurrent(viewTicket)) return;
    const preRoll = profile?.preferences.reviewPreRollMs ?? 450;
    const start = typeof focusMs === 'number' ? focusMs : proposal.startMs;
    armReviewPlayback('proposal', start - preRoll);
    media.current.play().catch(() => {});
  };
  const playReviewSelection = (pass: ReviewPlaybackPass = 'focus') => {
    // A queued post-edit replay must use the committed timing of its selection.
    const range = selectionIntent.current;
    if (!media.current || !range.ids.length || !projectScope.current.isCurrent(viewTicket)) return;
    reviewPlaybackPass.current = pass;
    armReviewPlayback('review', range.startMs - reviewLeadMs(pass));
    media.current.play().catch(() => {});
  };
  const replaySelection = () => playReviewSelection('focus');
  const replaySelectionWithContext = () => playReviewSelection('context');
  const selectCaption = (id: string, extend: boolean, seekMs?: number) => {
    const owner = reviewPlaybackOwner.current;
    const sameReviewCaption = reviewMode && !extend && selection.ids.length === 1 && selection.ids[0] === id;
    if (sameReviewCaption && seekMs === undefined) return;
    if (reviewMode) {
      reviewPlaybackPass.current = 'focus';
      if (owner?.active && owner.kind === 'review' && owner.media === media.current) {
        if (sameReviewCaption && seekMs !== undefined) {
          armReviewPlayback('review', seekMs);
          return;
        }
        // Selecting another row ends the previous audition at the new editing target.
        owner.media.pause();
        seekMs ??= draftRef.current.find((caption) => caption.id === id)?.startMs;
      }
    }
    if (seekMs === undefined) cancelPlayback();
    else seek(seekMs);
    if (extend && selectionAnchor) setSelectionEnd(id);
    else { setSelectionAnchor(id); setSelectionEnd(id); }
  };
  const moveToReviewCaption = (id: string, play = false) => {
    const caption = draftRef.current.find((item) => item.id === id);
    if (!caption) return;
    reviewPlaybackPass.current = 'context';
    setSelectionAnchor(id);
    setSelectionEnd(id);
    armReviewPlayback('review', caption.startMs - reviewLeadMs('context'), true);
    schedulePlayback(() => {
      editor.current?.revealCaption(id);
      if (play) media.current?.play().catch(() => {});
    }, 40);
  };
  const selectRisk = (delta: number, play = false) => {
    if (!riskyIds.length) return;
    const current = riskyIds.findIndex((id) => selection.ids.includes(id));
    const nextIndex = current + delta;
    // Keyboard navigation shares the disabled Previous/Skip boundaries.
    if (nextIndex < 0 || nextIndex >= riskyIds.length) return;
    moveToReviewCaption(riskyIds[nextIndex], play);
  };
  const shiftSelection = (delta: number) => {
    if (!selection.ids.length) return;
    const selected = new Set(selection.ids);
    const targets = draftRef.current.filter((caption) => selected.has(caption.id));
    if (!targets.length) return;
    if (targets.some((caption) => caption.timingLocked)) { setNotice('Unlock the selected timing before moving these captions together.'); return; }
    const safeDelta = limitCaptionSelectionDelta(draftRef.current, selected, delta, mediaDurationMs || Number.MAX_SAFE_INTEGER);
    if (safeDelta !== delta) setNotice('Reached a caption outside the selection. Other captions stayed in place.');
    if (!safeDelta) return;
    updateDraft(draftRef.current.map((caption) => selected.has(caption.id)
      ? { ...caption, startMs: caption.startMs + safeDelta, endMs: caption.endMs + safeDelta, timingSource: 'manual', timingQuality: 'medium', approved: false }
      : caption), undefined, 'timing');
    if (reviewMode) schedulePlayback(replaySelection);
  };

  const closeComparison = () => {
    if (document.activeElement === document.body || document.activeElement?.closest('.workspace-inspector')) {
      document.querySelector<HTMLElement>('.workspace-tools-menu > summary')?.focus();
    }
    setProposal(null);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph')) return;
      const target = event.target as HTMLElement | null;
      if (document.querySelector('[aria-modal="true"]') || target?.closest('[data-editor-layout-control]')) return;
      const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
      const command = event.ctrlKey !== event.metaKey && !event.altKey && !event.shiftKey;
      if (command && event.key.toLowerCase() === 's') {
        event.preventDefault(); void manualSaveFeedback.run(() => saveUnfinishedChanges(false)); return;
      }
      if (command && event.key.toLowerCase() === 'f' && project) {
        event.preventDefault(); setShowFindReplace(true); return;
      }
      // Native player controls retarget their keyboard events to the media host.
      // Keep their playback, volume and dismissal keys out of caption shortcuts.
      if (target?.closest('video, audio')) return;
      // Only the documented chords belong to the editor. Browser/system
      // shortcuts must never become a bare playback or approval action.
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey && !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      if (event.key === 'Escape') {
        if (proposal) { closeComparison(); return; }
        if (showGuide) { setShowGuide(false); return; }
        if (showCorrections || showProfile || showFindReplace || showHistory || showJobs || showUpdates) {
          closeCorrections(); setShowProfile(false); setShowFindReplace(false); closeHistory(); setShowJobs(false); setShowUpdates(false); return;
        }
        if (workspaceTool) {
          const closeTool = target?.closest('.workspace-inspector')?.querySelector<HTMLButtonElement>('[data-workspace-close]');
          if (closeTool) { closeTool.click(); return; }
          cancelPlayback();
          setWorkspaceTool(null);
          setReviewMode(false);
          if (workspaceTool === 'accuracy') {
            accuracyDescriptionFocus.current = null;
            restoreInlineAccuracyFocus();
          }
          return;
        }
        return;
      }
      if (typing || !project || target?.matches('[data-media-preview-focus]') || target?.closest('button, select, summary, .review-reasons, [role="button"], [role="slider"], [role="combobox"]')) return;
      if (event.altKey) {
        event.preventDefault(); shiftSelection(event.key === 'ArrowLeft' ? -50 : 50);
      } else if (event.key === ' ') {
        event.preventDefault(); if (media.current?.paused) media.current.play().catch(() => {}); else media.current?.pause();
      } else if (event.key.toLowerCase() === 'r') {
        event.preventDefault(); replaySelection();
      } else if (event.key.toLowerCase() === 'e' && selection.ids[0]) {
        event.preventDefault(); editor.current?.focusCaption(selection.ids[0]);
      } else if (event.key.toLowerCase() === 'j') {
        event.preventDefault(); editor.current?.jumpToPlayhead();
      } else if (reviewMode && !proposal && event.key === 'ArrowDown') {
        event.preventDefault(); selectRisk(1);
      } else if (reviewMode && !proposal && event.key === 'ArrowUp') {
        event.preventDefault(); selectRisk(-1);
      } else if (reviewMode && !proposal && (event.key === 'Enter' || event.key.toLowerCase() === 'a')) {
        event.preventDefault(); if (!event.repeat) approveAndNext();
      } else if (reviewMode && !proposal && event.key.toLowerCase() === 's') {
        event.preventDefault(); selectRisk(1, profile?.preferences.autoPlayNextReview ?? true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onMediaTimeUpdate = (element: HTMLMediaElement) => {
    if (media.current !== element || !projectScope.current.isCurrent(viewTicket)) return;
    setTime(element.currentTime);
    const proposalPostRoll = profile?.preferences.reviewPostRollMs ?? 300;
    const owner = reviewPlaybackOwner.current;
    // The new seek position is observable before its native seeking event.
    // Never pull the playhead back while that newer action is still pending.
    if (element.seeking) return;
    if (proposal && proposalLoop && owner?.active && owner.media === element && owner.kind === 'proposal'
      && !element.paused && element.currentTime * 1000 >= proposal.endMs + proposalPostRoll) {
      replayProposal();
      return;
    }
    const autoLoop = profile?.preferences.autoLoopReview ?? true;
    const reviewPostRoll = reviewTailMs(reviewPlaybackPass.current);
    if (reviewMode && owner?.active && owner.media === element && owner.kind === 'review'
      && selection.captions.length && !element.paused && element.currentTime * 1000 >= selection.endMs + reviewPostRoll) {
      if (autoLoop) playReviewSelection('focus');
      else {
        cancelPlayback();
        element.pause();
        element.currentTime = (selection.endMs + reviewPostRoll) / 1000;
      }
    }
  };
  const onLoadedMetadata = (element: HTMLMediaElement) => {
    if (media.current !== element || !projectScope.current.isCurrent(viewTicket)) return;
    if (element instanceof HTMLVideoElement && element.videoWidth > 0 && element.videoHeight > 0) {
      setMediaShape({ key: mediaKey, landscape: element.videoWidth >= element.videoHeight });
    }
    if (Number.isFinite(element.duration)) setLoadedMediaDurationMs(element.duration * 1000);
    if (retainedMediaSeek.current?.key === mediaKey) {
      const timeMs = retainedMediaSeek.current.timeMs;
      retainedMediaSeek.current = null;
      element.currentTime = Math.max(0, Math.min(timeMs / 1000, Number.isFinite(element.duration) ? element.duration : timeMs / 1000));
      setTime(element.currentTime);
    }
    playCorrectionAudio(element, mediaKey);
  };
  function playCorrectionAudio(element: HTMLMediaElement, key: string) {
    const clip = correctionPlayback.current;
    if (!clip || clip.key !== key || element.readyState < 1) return;
    correctionPlayback.current = null;
    if (Number.isFinite(element.duration) && clip.recordedStartMs >= element.duration * 1000) {
      element.pause();
      setNotice('The correction starts beyond the end of the current media. Its recorded audio is unavailable.');
      return;
    }
    timingPreviewCancel.current = playTimingRange(element, { startMs: clip.startMs, endMs: clip.endMs, loop: false },
      () => setError('Playback could not start. Use the media controls to listen to the correction.'));
  }
  const changePlaybackRate = (rate: number) => {
    setPlaybackRate(rate);
    if (media.current) media.current.playbackRate = rate;
  };

  const openRecentProject = async (id: string, reviewRecovery = false): Promise<boolean> => {
    const initiatingControl = document.activeElement;
    if (!profile || busy || mediaMutationInFlight.current) return false;
    const uploadReminder = captureUploadRecoveryForProject(id);
    const intent = requestNavigation();
    if (!await saveUnfinishedChanges(true, () => isCurrentOperation(intent)) || !isCurrentOperation(intent)) return false;
    const focusRequest = projectNavigationFocus.capture(initiatingControl);
    let focusCompleted = false;
    const ticket = beginNavigation();
    const request = new AbortController();
    projectOpen.current = request;
    setOpeningProjectId(id);
    setError('');
    try {
      const readRevision = draftEditRevision.current;
      const contextRevision = accuracyDraft.current.editRevision;
      const appearanceRevision = currentAppearanceSave().revision;
      const contextObservation = accuracyDraft.current.capture(ticket);
      const value = await api.get(id, request.signal);
      if (projectScope.current.isCurrent(ticket) && projectOpen.current === request && !request.signal.aborted) {
        if (dirtyRef.current || readRevision !== draftEditRevision.current || contextRevision !== accuracyDraft.current.editRevision || accuracyDraft.current.hasChanges(profile?.defaultVocabulary)
          || appearanceRevision !== currentAppearanceSave().revision || currentAppearanceSave().status !== 'saved') {
          setNotice('Newer edits arrived while the project was loading. Save them before opening another project.');
          return false;
        }
        publishContextProject(value, contextObservation);
        projectTitleAck.current = null;
        applyProject(value);
        if (reviewRecovery) refreshUnfinishedRecoveries();
        if (showAllProjects) libraryOrigin.current = id;
        clearUploadRecoveryForProject(id, uploadReminder);
        projectNavigationFocus.complete(focusRequest, () =>
          (reviewRecovery ? document.querySelector<HTMLElement>('.unfinished-recovery summary') : null)
          || document.querySelector<HTMLElement>('[data-project-entry-focus]'));
        focusCompleted = true;
        return true;
      }
    } catch (reason) {
      if (projectOpen.current === request && !request.signal.aborted) {
        setError(reason instanceof Error ? reason.message : 'Could not open project. Try again.');
        projectNavigationFocus.complete(focusRequest, () => focusRequest?.owner || null);
        focusCompleted = true;
      }
    } finally {
      if (projectOpen.current === request) { projectOpen.current = null; setOpeningProjectId(null); }
      if (!focusCompleted) projectNavigationFocus.cancel(focusRequest);
    }
    return false;
  };

  useEffect(() => {
    const destination = new URL(window.location.href);
    if (destination.searchParams.get('reloadSavedProject') !== '1') return;
    const fragment = new URLSearchParams(destination.hash.slice(1));
    reopenAfterReload.current = fragment.get('project');
    destination.searchParams.delete('reloadSavedProject');
    destination.hash = fragment.get('anchor') || '';
    window.history.replaceState(window.history.state, '', destination.href);
  }, []);
  useEffect(() => {
    const id = reopenAfterReload.current;
    if (!id || !profile) return;
    reopenAfterReload.current = null;
    if (operationRevision.current || project || showAllProjects || showProfile || showGuide || showJobs || showUpdates || showCorrections) return;
    if (document.activeElement === document.body) document.querySelector<HTMLElement>('.empty-stage .dropzone')?.focus({ preventScroll: true });
    void openRecentProject(id, true);
  }, [profile, project, showAllProjects, showProfile, showGuide, showJobs, showUpdates, showCorrections]);

  const checkUploadAttempt = async (attemptId: string): Promise<UploadRecoveryResult> => {
    const ticket = projectScope.current.capture();
    // The exact receipt owns this outcome. Updating unrelated collection cards
    // may finish later and already has its own reconciliation and request gate.
    void refreshProjects();
    try {
      const saved = await api.get(attemptId);
      if (saved.id === attemptId) {
        if (projectScope.current.isCurrent(ticket)) setProjects((current) => current.some((item) => item.id === attemptId)
          ? current : [summarizeProject(saved), ...current]);
        return { state: 'found', project: { id: saved.id, title: saved.title } };
      }
    } catch {
      // A failed read cannot distinguish an unpublished attempt from a lost ACK.
    }
    // A missing record does not prove failure: the original upload may still be
    // publishing. Only its exact attempt can be retried or deliberately opened.
    return { state: 'uncertain', message: 'Studio could not confirm whether this upload was saved. Check again or retry this same upload.' };
  };
  const upload = async (file: File, title: string, attemptId: string): Promise<UploadResult> => {
    if (mediaMutationInFlight.current) return { state: 'not-created', message: 'Wait for the media change to finish, then retry this upload.' };
    const focusRequest = projectNavigationFocus.capture(document.activeElement);
    let focusCompleted = false;
    let ticket = beginNavigation();
    setBusy('Uploading…');
    setError('');
    try {
      const result = await api.create(file, title, attemptId);
      if (!projectScope.current.isCurrent(ticket)) return { state: 'uncertain', project: { id: result.id, title: result.title }, message: 'This upload was saved. Open its saved project when you are ready.' };
      applyProject(result);
      ticket = projectScope.current.capture();
      if (result.creation?.orderSaved === false) setNotice('Project saved, but its order in Recent projects could not be saved.');
      projectNavigationFocus.complete(focusRequest, () => document.querySelector<HTMLElement>('[data-project-entry-focus]'));
      focusCompleted = true;
      return { state: 'opened' };
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.code === 'project_binned') {
        void refreshProjects({ replaceRead: true });
        return { state: 'not-created', message: 'This upload matches a project in Recently deleted. Restore it there, or upload the file again.' };
      }
      if (reason instanceof ApiRequestError && (reason.code === 'PROJECT_CREATE_NOT_APPLIED' || reason.code === 'PROJECT_CREATE_ATTEMPT_MISMATCH')) {
        // Upload owns the persistent, actionable alert for this exact attempt.
        // A second global toast repeats it and can cover the next Home action.
        return { state: 'not-created', message: reason.message, retryable: reason.retryable ?? reason.code !== 'PROJECT_CREATE_ATTEMPT_MISMATCH' };
      }
      const recovery = await checkUploadAttempt(attemptId);
      return recovery.state === 'found'
        ? { state: 'uncertain', project: recovery.project, message: 'This upload was saved. Open its saved project to continue.' }
        : recovery;
    } finally {
      if (projectScope.current.isCurrent(ticket)) setBusy('');
      if (!focusCompleted) projectNavigationFocus.cancel(focusRequest);
    }
  };
  const replaceMedia = (file?: File) => {
    if (!file || !project || mediaMutationInFlight.current || busy || currentProjectAnyActiveJob) return;
    if (wordBatchMutation.current) {
      setNotice('Finish saving prepared word timings before replacing the media.');
      return;
    }
    if (replacementEditRecoveries.length >= MAX_REPLACEMENT_EDIT_RECOVERIES) {
      setNotice('Copy or dismiss an earlier replacement recovery before replacing media again.');
      return;
    }
    cancelPlayback();
    setShowMediaBackups(false);
    mediaBackupsRequest.current?.abort();
    setMediaMutationError('');
    setPendingMediaReplacement({ id: ++mediaReplacementSequence.current, file, ticket: projectScope.current.capture() });
  };

  const loadMediaBackups = async () => {
    if (!project) return;
    mediaBackupsRequest.current?.abort();
    const controller = new AbortController();
    mediaBackupsRequest.current = controller;
    const ticket = projectScope.current.capture();
    setMediaBackupsLoading(true);
    setMediaMutationError('');
    try {
      const items = await api.mediaReplacements(project.id, controller.signal);
      if (!controller.signal.aborted && projectScope.current.isCurrent(ticket)) setMediaBackups(items);
    } catch (reason) {
      if (!controller.signal.aborted && projectScope.current.isCurrent(ticket)) {
        setMediaMutationError(reason instanceof Error ? reason.message : 'Could not load replacement backups. Try refreshing.');
      }
    } finally {
      if (mediaBackupsRequest.current === controller) {
        mediaBackupsRequest.current = null;
        setMediaBackupsLoading(false);
      }
    }
  };
  const openMediaBackups = () => {
    if (!project || mediaMutationInFlight.current || busy) return;
    setPendingMediaReplacement(null);
    setShowMediaBackups(true);
    void loadMediaBackups();
  };
  const currentMediaView = (): Omit<RetainedMediaView, 'key'> => ({
    workspace: workspaceTool, reviewing: reviewMode, anchor: selectionAnchor, end: selectionEnd,
    timeMs: Math.max(0, (media.current?.currentTime ?? time) * 1000), reviewUndo,
    description: accuracyDraft.current.fields.description, vocabulary: accuracyDraft.current.fields.vocabulary, maxChars, grouping: groupingMode,
  });
  const mediaMutationBasis = async (target: CaptionProject, ticket: ProjectTicket) => {
    const contextRevision = accuracyDraft.current.editRevision;
    const contextSnapshot = JSON.stringify(accuracyDraft.current.fields);
    const localContext = contextPayload();
    // Drain older writes, then save the current draft. The dialog blocks ordinary
    // interaction; revision/raw-field checks also catch late accepted input. The
    // in-flight ref prevents queued autosaves from crossing the media boundary.
    await saveQueue.current;
    if (!projectScope.current.isCurrent(ticket)) throw new Error('The project changed. Open Replace media again for the current project.');
    if (conflictedSave.current?.key === ticket.key) throw new Error('Download your edits and reload the saved project before changing media.');
    const hadEdits = dirtyRef.current;
    const saved = await saveDraft(true, 'manual-save', true, true);
    if (hadEdits && !saved) throw new Error('The current captions could not be saved. Resolve the save error before changing media.');
    if (flushAppearanceSave.current && !await flushAppearanceSave.current()) throw new Error('Your latest appearance could not be saved. Retry its save before changing media.');
    if (!await waitForCaptionAppearanceSaves(target.id, target.media)) throw new Error('Your latest appearance could not be saved. Retry its save before changing media.');
    await saveQueue.current;
    if (!projectScope.current.isCurrent(ticket) || dirtyRef.current
      || accuracyDraft.current.editRevision !== contextRevision || JSON.stringify(accuracyDraft.current.fields) !== contextSnapshot) {
      throw new Error('The project changed while saving. Review your edits before changing media.');
    }
    const editRevision = draftEditRevision.current;
    const captionSnapshot = JSON.stringify(draftRef.current);
    // Appearance has its own save lane. Re-read after both lanes complete so the
    // concurrency token belongs to the actual saved project, not a render closure.
    const contextObservation = accuracyDraft.current.capture(ticket);
    const acknowledgedContext = ordinarySaveBasis.current?.transcriptionContext;
    let fresh = await api.get(target.id);
    if (!projectScope.current.isCurrent(ticket) || editRevision !== draftEditRevision.current || accuracyDraft.current.editRevision !== contextRevision || JSON.stringify(accuracyDraft.current.fields) !== contextSnapshot || dirtyRef.current) {
      throw new Error('The project changed while saving. Review your edits before changing media.');
    }
    if (projectMediaKey(fresh) !== ticket.key || JSON.stringify(withCaptionWordTimings(fresh).captions) !== captionSnapshot) {
      throw new Error('The saved project changed elsewhere. Reopen it before changing media; your local edits have not been replaced.');
    }
    const freshContext = {
      description: fresh.transcriptionContext?.description?.trim() || '',
      vocabulary: uniqueLines(profile?.defaultVocabulary, fresh.transcriptionContext?.vocabulary),
    };
    let contextSaved = false;
    if (!sameAccuracyContext(localContext, freshContext)) {
      if (!sameAccuracyContext(fresh.transcriptionContext, acknowledgedContext)) {
        throw new Error('Accuracy context changed elsewhere. Review and save your current context before changing media.');
      }
      fresh = await api.saveContext(target.id, localContext, { filename: target.media.filename, size: target.media.size }, fresh.updatedAt);
      contextSaved = true;
    }
    // A successful save owns its baseline even if later typing now prevents the
    // media change. Otherwise retrying would misidentify our own save as foreign.
    const contextPublished = publishContextProject(fresh, contextObservation, true, contextSaved);
    if (!projectScope.current.isCurrent(ticket) || editRevision !== draftEditRevision.current
      || accuracyDraft.current.editRevision !== contextRevision || JSON.stringify(accuracyDraft.current.fields) !== contextSnapshot || dirtyRef.current
      || projectMediaKey(fresh) !== ticket.key || JSON.stringify(withCaptionWordTimings(fresh).captions) !== captionSnapshot) {
      throw new Error('The project changed while saving Accuracy context. Review it before changing media.');
    }
    if (!contextPublished) {
      throw new Error('Accuracy context changed while saving. Review it before changing media.');
    }
    return { fresh, editRevision, contextRevision, basis: { expectedMedia: { filename: fresh.media.filename, size: fresh.media.size }, expectedUpdatedAt: fresh.updatedAt } };
  };
  const captureReplacementEdits = (target: CaptionProject, editRevision: number, contextRevision: number) => {
    const accuracyContext = accuracyDraft.current.recoverySince(contextRevision);
    if (draftEditRevision.current === editRevision && !accuracyContext) return;
    const capturedAt = new Date().toISOString();
    const captions = structuredClone(draftRef.current);
    setReplacementEditRecoveries((current) => [...current, {
      id: `${target.id}:${target.media.filename}:${capturedAt}`,
      sourceProjectId: target.id,
      sourceMedia: { filename: target.media.filename, originalName: target.media.originalName, size: target.media.size },
      captions, capturedAt, ...(accuracyContext ? { accuracyContext } : {}),
    }]);
  };
  const publishMediaReplacement = (result: CaptionProject & Partial<ReplaceMediaResponse>, target: CaptionProject, editRevision: number, contextRevision: number, ticket: ProjectTicket, retained?: Omit<RetainedMediaView, 'key'>) => {
    if (!projectScope.current.isCurrent(ticket)) {
      setProjects((items) => [summarizeProject(result), ...items.filter((item) => item.id !== result.id)]);
      return false;
    }
    captureReplacementEdits(target, editRevision, contextRevision);
    const key = projectMediaKey(result);
    if (retained) {
      retainedMediaView.current = { ...retained, key };
      retainedMediaSeek.current = { key, timeMs: retained.timeMs };
    } else retainedMediaSeek.current = null;
    setBusy('');
    setPendingMediaReplacement(null);
    setShowMediaBackups(false);
    setLiveAppearance(null);
    applyProject(result);
    if (result.mediaReplacement) setMediaUndoNotice({ key, checkpoint: result.mediaReplacement });
    return true;
  };
  function cancelMediaSourceRead() {
    mediaSourceRequest.current?.abort();
    mediaSourceRequest.current = null;
    setCheckingMediaSource(false);
  }
  const checkSavedMediaSource = async (check: MediaSourceCheck) => {
    if (mediaSourceRequest.current || !projectScope.current.isCurrent(check.ticket)) return;
    const request = new AbortController();
    mediaSourceRequest.current = request;
    setCheckingMediaSource(true);
    try {
      const fresh = await api.get(check.target.id, request.signal);
      if (request.signal.aborted || fresh.id !== check.target.id || !projectScope.current.isCurrent(check.ticket)) return;
      setUnconfirmedSource(null);
      if (projectMediaKey(fresh) === check.ticket.key) {
        setMediaMutationError('The saved project still uses the previous source. You can try the media change again.');
      } else {
        publishMediaReplacement(fresh, check.target, check.editRevision, check.contextRevision, check.ticket);
        setNotice('The saved source changed. Studio reopened it with its saved captions. Replacement backups are available in Tools → Undo media replacement.');
      }
    } catch {
      // Keep the unresolved operation, including drafts typed since submission.
      // Only a successful project read can release the next media change.
    } finally {
      if (mediaSourceRequest.current === request) {
        mediaSourceRequest.current = null;
        setCheckingMediaSource(false);
      }
    }
  };
  const reportMediaMutationFailure = (reason: unknown, target: CaptionProject, editRevision: number, contextRevision: number, ticket: ProjectTicket) => {
    if (!projectScope.current.isCurrent(ticket)) return;
    const message = reason instanceof Error ? reason.message : 'The media change failed.';
    if (reason instanceof ApiRequestError && reason.status >= 400 && reason.status < 500) {
      setMediaMutationError(`${message} This media change was not applied.`);
      return;
    }
    const check = { target, ticket, editRevision, contextRevision };
    setUnconfirmedSource(check);
    void checkSavedMediaSource(check);
  };
  const submitMediaReplacement = async (mode: MediaReplacementMode, audioChangeConfirmation?: string) => {
    if (!project || !pendingMediaReplacement || mediaMutationInFlight.current || unconfirmedSource) return;
    if (currentProjectAnyActiveJob) { setMediaMutationError('Wait for the active processing job to finish before replacing media.'); return; }
    const pending = pendingMediaReplacement;
    if (!projectScope.current.isCurrent(pending.ticket)) { setPendingMediaReplacement(null); return; }
    const accepted = mode === 'preserve' && audioChangeConfirmation ? pending.audioConfirmation : undefined;
    if (audioChangeConfirmation && (!accepted || accepted.token !== audioChangeConfirmation
      || Date.parse(accepted.expiresAt) <= Date.now() || project.updatedAt !== accepted.basis.expectedUpdatedAt
      || draftEditRevision.current !== accepted.editRevision || accuracyDraft.current.editRevision !== accepted.contextRevision || dirtyRef.current)) {
      setPendingMediaReplacement({ ...pending, audioConfirmation: undefined });
      setMediaMutationError('The audio check or project changed. Check the replacement again and review the warning before accepting existing times.');
      return;
    }
    operationRevision.current += 1;
    mediaMutationInFlight.current = true;
    setPendingMediaReplacement({ ...pending, audioConfirmation: undefined });
    setMediaMutationStatus(mode === 'reset' ? 'Review the confirmation…' : 'Saving current work…');
    setMediaMutationError('');
    setError('');
    const target = project;
    const retained = currentMediaView();
    let ticket = pending.ticket;
    let editRevision = draftEditRevision.current;
    let contextRevision = accuracyDraft.current.editRevision;
    let submitted = false;
    let submittedBasis: MediaReplacementBasis | undefined;
    try {
      if (mode === 'reset' && !await confirmInStudio({
        title: 'Start over with this media?',
        message: `Replace the source with ${pending.file.name} and clear the current captions, approvals and transcript. A local backup keeps this saved project for recovery. New captions will not be generated automatically.`,
        confirmLabel: 'Replace and clear captions', cancelLabel: 'Keep current project',
      })) return;
      if (!projectScope.current.isCurrent(ticket)) return;
      setBusy('Saving current work…');
      setMediaMutationStatus('Saving current work…');
      const ready = await mediaMutationBasis(target, ticket);
      editRevision = ready.editRevision;
      contextRevision = ready.contextRevision;
      if (accepted && (ready.basis.expectedUpdatedAt !== accepted.basis.expectedUpdatedAt
        || ready.basis.expectedMedia.filename !== accepted.basis.expectedMedia.filename
        || ready.basis.expectedMedia.size !== accepted.basis.expectedMedia.size
        || editRevision !== accepted.editRevision || contextRevision !== accepted.contextRevision)) {
        throw new Error('The saved project changed since the audio was checked. Check the replacement again before accepting existing times.');
      }
      projectScope.current.invalidate();
      ticket = projectScope.current.capture();
      setPendingMediaReplacement({ ...pending, ticket, audioConfirmation: undefined });
      wordBatchController.current?.abort();
      setProposal(null);
      correctionPlayback.current = null;
      setBusy(mode === 'preserve' ? 'Checking replacement audio…' : 'Replacing media…');
      setMediaMutationStatus(mode === 'preserve' ? 'Uploading and checking the audio locally…' : 'Saving replacement and backup…');
      submitted = true;
      submittedBasis = ready.basis;
      const result = await api.replaceMedia(target.id, pending.file, mode, ready.basis, accepted?.token);
      if (!publishMediaReplacement(result, target, editRevision, contextRevision, ticket, mode === 'preserve' ? retained : undefined)) return;
      const warning = result.replacementCleanupWarnings?.some((item) => item !== 'durability') ? ' Some old derived files could not be cleaned up; the saved replacement is usable.' : '';
      setNotice(`${mode === 'preserve' ? result.mediaAlignment?.state === 'unverified-audio-change'
        ? 'Media replaced. Existing captions and word times were kept. Check alignment against the edited audio.'
        : 'Media replaced. Your reviewed captions and appearance were kept.' : 'Media replaced. Captions were cleared; generate them when ready.'}${warning}`);
      if (result.replacementCleanupWarnings?.includes('durability')) {
        setError('The replacement was saved, but its final storage flush could not be confirmed. The previous source and backup were retained for recovery. Check your storage before closing Studio.');
      }
    } catch (reason) {
      if (reason instanceof MediaAudioMismatchError && submittedBasis && mode === 'preserve' && projectScope.current.isCurrent(ticket)) {
        if (editRevision === draftEditRevision.current && contextRevision === accuracyDraft.current.editRevision && !dirtyRef.current) {
          setPendingMediaReplacement({ ...pending, ticket, audioConfirmation: { ...reason.preserveAudioConfirmation, basis: submittedBasis, editRevision, contextRevision } });
        } else setMediaMutationError('The project changed during the audio check. Check the replacement again before accepting existing times. This media change was not applied.');
      } else if (submitted) reportMediaMutationFailure(reason, target, editRevision, contextRevision, ticket);
      else if (projectScope.current.isCurrent(ticket)) setMediaMutationError(reason instanceof Error ? reason.message : 'Save current work before replacing media.');
    } finally {
      mediaMutationInFlight.current = false;
      setMediaMutationStatus('');
      setBusy('');
    }
  };
  const restoreMediaBackup = async (checkpoint: MediaReplacementCheckpoint) => {
    if (!project || mediaMutationInFlight.current || unconfirmedSource) return;
    if (currentProjectAnyActiveJob) { setMediaMutationError('Wait for the active processing job to finish before restoring media.'); return; }
    if (replacementEditRecoveries.length >= MAX_REPLACEMENT_EDIT_RECOVERIES) {
      setMediaMutationError('Copy or dismiss an earlier edit recovery before restoring media.');
      return;
    }
    const target = project;
    let ticket = projectScope.current.capture();
    let editRevision = draftEditRevision.current;
    let contextRevision = accuracyDraft.current.editRevision;
    let submitted = false;
    operationRevision.current += 1;
    mediaMutationInFlight.current = true;
    setMediaMutationStatus('Review the confirmation…');
    setMediaMutationError('');
    setError('');
    try {
      if (!await confirmInStudio({
        title: 'Restore previous media?',
        message: `Restore ${checkpoint.previousOriginalName} and its saved captions, approvals, timing and appearance. This replaces newer work in the current project. Your current edits will be saved first and kept in another replacement backup.`,
        confirmLabel: 'Restore previous media', cancelLabel: 'Keep current project',
      })) return;
      if (!projectScope.current.isCurrent(ticket)) return;
      setBusy('Saving current work…');
      setMediaMutationStatus('Saving current work…');
      const ready = await mediaMutationBasis(target, ticket);
      editRevision = ready.editRevision;
      contextRevision = ready.contextRevision;
      projectScope.current.invalidate();
      ticket = projectScope.current.capture();
      wordBatchController.current?.abort();
      setProposal(null);
      correctionPlayback.current = null;
      setBusy('Restoring previous media…');
      setMediaMutationStatus('Restoring previous media and saved project…');
      submitted = true;
      const result = await api.restoreMediaReplacement(target.id, checkpoint.id, ready.basis);
      if (publishMediaReplacement(result, target, editRevision, contextRevision, ticket)) {
        setNotice('Previous media and its saved captions and appearance restored. Your newer saved project is available in replacement backups.');
        if (result.replacementCleanupWarnings?.includes('durability')) {
          setError('The restored project was saved, but its final storage flush could not be confirmed. The previous source and backup were retained for recovery. Check your storage before closing Studio.');
        }
      }
    } catch (reason) {
      if (submitted) reportMediaMutationFailure(reason, target, editRevision, contextRevision, ticket);
      else if (projectScope.current.isCurrent(ticket)) setMediaMutationError(reason instanceof Error ? reason.message : 'Could not restore this backup.');
    } finally {
      mediaMutationInFlight.current = false;
      setMediaMutationStatus('');
      setBusy('');
    }
  };
  const deleteMediaBackup = async (checkpoint: MediaReplacementCheckpoint) => {
    if (!project || mediaMutationInFlight.current || unconfirmedSource) return;
    const target = project;
    const ticket = projectScope.current.capture();
    mediaMutationInFlight.current = true;
    setMediaMutationStatus('Review the confirmation…');
    setMediaMutationError('');
    setError('');
    try {
      if (!await confirmInStudio({
        title: 'Delete this saved replacement backup?',
        message: `Permanently delete the backup for ${checkpoint.previousOriginalName} from ${new Date(checkpoint.createdAt).toLocaleString()}. You will no longer be able to restore this saved version. Your current project stays intact.`,
        confirmLabel: 'Delete backup', cancelLabel: 'Keep backup',
      })) return;
      if (!projectScope.current.isCurrent(ticket)) return;
      setMediaMutationStatus('Deleting the selected backup…');
      const ready = await mediaMutationBasis(target, ticket);
      await api.deleteMediaReplacement(target.id, checkpoint.id, ready.basis);
      if (!projectScope.current.isCurrent(ticket)) return;
      setMediaBackups((items) => items.filter((item) => item.id !== checkpoint.id));
      setMediaUndoNotice((current) => current?.checkpoint.id === checkpoint.id ? null : current);
      setNotice('Selected replacement backup deleted. Your current project was kept.');
    } catch (reason) {
      if (projectScope.current.isCurrent(ticket)) setMediaMutationError(reason instanceof Error ? reason.message : 'Could not delete the backup. Refresh backups before trying again.');
    } finally {
      mediaMutationInFlight.current = false;
      setMediaMutationStatus('');
    }
  };
  async function saveGenerationModel(choice: CaptionGenerationModel): Promise<boolean> {
    if (!project || generationModelWrite.current || generationPreparation.current || mediaMutationInFlight.current) return false;
    const target = project;
    const ticket = projectScope.current.capture();
    generationModelWrite.current = true;
    generationModelRevision.current += 1;
    setGenerationModelSaving(true);
    try {
      const next = await queueSameMediaMutation(ticket, () => api.saveGenerationModel(target.id, choice, target.generationModel ?? 'automatic', { filename: target.media.filename, size: target.media.size }));
      if (!next || !projectScope.current.isCurrent(ticket)) return false;
      generationModelAck.current = { key: ticket.key, value: next.generationModel ?? 'automatic' };
      // This response owns only AI options. Never adopt foreign captions or Accuracy.
      setProject((current) => current && projectMediaKey(current) === ticket.key ? { ...current, generationModel: next.generationModel } : current);
      if (savedProject.current && projectMediaKey(savedProject.current) === ticket.key) savedProject.current = { ...savedProject.current, generationModel: next.generationModel };
      return true;
    } catch (reason) {
      if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Could not save AI options. Try again.');
      return false;
    } finally {
      generationModelWrite.current = false;
      setGenerationModelSaving(false);
    }
  }
  const generate = async () => {
    if (!project || busy || currentProjectActiveJob || generationModelWrite.current || generationPreparation.current || mediaMutationInFlight.current) return;
    if (generationNeedsCheck) { openActivityFromNotice(); void refreshJobs({ feedback: true }); return; }
    if (llmSettings?.configured === false) { openSettings('ai'); return; }
    if (health?.timing.configured === false) { openSettings('doctor'); void runDoctor(); return; }
    if (!llmSettings || !health) {
      if (generationSetupFailed) setStartupAttempt((attempt) => attempt + 1);
      return;
    }
    generationPreparation.current = true;
    setGenerationPreparing(true);
    try {
      const targetProject = project;
      const intent = captureOperationIntent();
      const editRevision = draftEditRevision.current;
      const contextRevision = accuracyDraft.current.editRevision;
      const requestContext = contextPayload();
      const hadUnsavedEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (hadUnsavedEdits && !saved) return;
      if (!isCurrentOperation(intent)
        || draftEditRevision.current !== editRevision
        || accuracyDraft.current.editRevision !== contextRevision) return;
      const fullDuration = targetProject.transcript?.timing?.audioDurationMs;
      if (targetProject.transcript?.tokens?.length && fullDuration) {
        await startJob(intent, () => api.startRegenerationJob(targetProject.id, 0, fullDuration, requestContext, { filename: targetProject.media.filename, size: targetProject.media.size }, targetProject.generationModel ?? 'automatic'), t('editor.generation.regenerationQueued'));
      } else {
        await startJob(intent, () => api.startTranscribeJob(targetProject.id, requestContext, { filename: targetProject.media.filename, size: targetProject.media.size }, Boolean(targetProject.transcript), targetProject.generationModel ?? 'automatic'), t('editor.generation.generationQueued'));
      }
    } finally {
      generationPreparation.current = false;
      setGenerationPreparing(false);
    }
  };
  const saveContext = async (silent = false): Promise<boolean> => {
    if (!project || mediaMutationInFlight.current || compositionInProgress.current || conflictedSave.current?.key === projectMediaKey(project)) return false;
    const targetProject = project;
    const ticket = projectScope.current.capture();
    const payload = contextPayload();
    const revision = accuracyDraft.current.editRevision;
    trackContextWrite(ticket.key, 1);
    captureUnfinishedRecovery();
    setBusy('Saving accuracy context…');
    setContextSaveState('saving');
    setError('');
    try {
      const saved = await queueSameMediaMutation(ticket, async () => {
        const observation = accuracyDraft.current.capture(ticket);
        const recovery = restoredRecovery.current?.key === ticket.key ? restoredRecovery.current : null;
        const result = await withCaptionAppearanceBarrier(targetProject.id, async () => {
          const expectedUpdatedAt = checkedSaveRevision(recovery?.basis ?? ordinarySaveBasis.current, await api.get(targetProject.id), 'context');
          return api.saveContext(targetProject.id, payload, { filename: targetProject.media.filename, size: targetProject.media.size }, expectedUpdatedAt);
        });
        const published = publishContextProject(result, observation, true);
        // Only a guarded write owns this token. An unrelated context response
        // may contain newer foreign captions that this editor has not adopted.
        if (published && recovery && restoredRecovery.current === recovery) {
          recovery.expectedUpdatedAt = result.updatedAt;
          // An Accuracy ACK does not adopt foreign captions returned beside it.
          recovery.basis = { ...recovery.basis, transcriptionContext: result.transcriptionContext, updatedAt: result.updatedAt };
        }
        return published;
      });
      if (!saved || !projectScope.current.isCurrent(ticket)) return false;
      if (accuracyDraft.current.hasChanges(profile?.defaultVocabulary) && accuracyDraft.current.editRevision === revision) {
        setContextSaveState('failed');
        setContextSaveError('Some Accuracy text could not be saved. Shorten the description or term list, then retry.');
        return false;
      }
      setContextSaveState('saved');
      if (!silent) setNotice(accuracyDraft.current.editRevision === revision ? 'Accuracy context saved.' : 'Accuracy context saved. Newer context edits remain in the editor.');
      return true;
    } catch (reason) {
      if (projectScope.current.isCurrent(ticket)) {
        protectSaveConflict(reason, ticket);
        setContextSaveError(reason instanceof Error ? reason.message : 'Accuracy context save failed.');
        setContextSaveState('failed');
      }
      return false;
    } finally {
      trackContextWrite(ticket.key, -1);
      if (projectScope.current.isCurrent(ticket)) {
        if (hasPendingContextWrite()) setContextSaveState('saving');
        captureUnfinishedRecovery();
        setBusy('');
      }
    }
  };

  async function saveBeforeSwitch(surface: 'activity' | 'corrections', id: string, owns: () => boolean) {
    let reason: string | undefined;
    const saved = await saveUnfinishedChanges(true, owns, (message) => { reason = message; });
    if (!owns()) return false;
    if (!saved) setBlockedSwitch({ surface, id, reason });
    return saved;
  }
  async function saveUnfinishedChanges(silent = true, isCurrentIntent: () => boolean = () => true, explain: (message: string) => void = setNotice): Promise<boolean> {
    if (!isCurrentIntent()) return false;
    if (!project) return true;
    if (currentAppearanceSave().conflict) {
      explain('The saved appearance changed. Download your edits and reload the saved project to compare.');
      return false;
    }
    if (compositionInProgress.current) {
      explain('Finish the current text input before saving or leaving.');
      return false;
    }
    const ticket = projectScope.current.capture();
    const captionRevision = draftEditRevision.current;
    const contextRevision = accuracyDraft.current.editRevision;
    const appearanceRevision = currentAppearanceSave().revision;
    const pending = saveQueue.current;
    await pending;
    if (!projectScope.current.isCurrent(ticket) || !isCurrentIntent()) return false;
    if (conflictedSave.current?.key === ticket.key) return false;
    if (pending !== saveQueue.current || compositionInProgress.current) {
      explain('Changes are still being saved or entered. Wait for them to finish before leaving.');
      return false;
    }
    if (captionRevision !== draftEditRevision.current || contextRevision !== accuracyDraft.current.editRevision
      || appearanceRevision !== currentAppearanceSave().revision) {
      explain('Newer changes arrived while saving. Your project is still open; save again when you are ready.');
      return false;
    }
    if (dirtyRef.current && !await saveDraft(silent, 'manual-save', true)) return false;
    if (!projectScope.current.isCurrent(ticket) || !isCurrentIntent()) return false;
    if (accuracyDraft.current.hasChanges(profile?.defaultVocabulary) && !await saveContext(silent)) return false;
    if (!projectScope.current.isCurrent(ticket) || !isCurrentIntent()) return false;
    if (flushAppearanceSave.current && !await flushAppearanceSave.current()) return false;
    if (!await flushCaptionAppearanceSaves(project.id, project.media)) return false;
    if (!projectScope.current.isCurrent(ticket) || !isCurrentIntent()) return false;
    if (appearanceRevision !== currentAppearanceSave().revision || currentAppearanceSave().status !== 'saved') {
      explain('Newer appearance changes arrived while saving. Your project is still open; continue when you are ready.');
      return false;
    }
    if (dirtyRef.current || accuracyDraft.current.hasChanges(profile?.defaultVocabulary)
      || captionRevision !== draftEditRevision.current || contextRevision !== accuracyDraft.current.editRevision) {
      explain('Newer changes are still unsaved. Save them before leaving.');
      return false;
    }
    return true;
  }

  const restoreUnfinishedDraft = async (entry: RecoveryEntry) => {
    if (!project || busy || recoveryRead.current || mediaMutationInFlight.current || wordBatchMutation.current || currentProjectAnyActiveJob) return;
    if (!recoveryStore.contains(entry)) {
      const focusRequest = projectNavigationFocus.capture();
      setNotice('That recovery copy was removed or changed. Your current project is kept.');
      refreshUnfinishedRecoveries();
      projectNavigationFocus.complete(focusRequest, () =>
        document.querySelector<HTMLElement>('.toast-slot[data-motion-state="open"] .unfinished-recovery .primary:not(:disabled)')
        || document.querySelector<HTMLElement>('[data-project-entry-focus]'));
      return;
    }
    if (dirtyRef.current || accuracyDraft.current.hasChanges(profile?.defaultVocabulary) || compositionInProgress.current || currentAppearanceSave().status !== 'saved') {
      setNotice('Save your current edits before restoring another draft.');
      return;
    }
    const ticket = projectScope.current.capture();
    const captionRevision = draftEditRevision.current;
    const contextRevision = accuracyDraft.current.editRevision;
    const appearanceRevision = currentAppearanceSave().revision;
    const observation = accuracyDraft.current.capture(ticket);
    const focusRequest = projectNavigationFocus.capture();
    const request = new AbortController();
    recoveryRead.current = request;
    const owns = () => recoveryRead.current === request && !request.signal.aborted && projectScope.current.isCurrent(ticket);
    let focusCompleted = false;
    setRecoveryWorking(true);
    try {
      const latest = withCaptionWordTimings(await api.get(project.id, request.signal));
      if (!owns()) return;
      if (!recoveryStore.contains(entry)) {
        setNotice('That recovery copy was removed or changed. Your current project is kept.');
        refreshUnfinishedRecoveries();
        return;
      }
      if (captionRevision !== draftEditRevision.current || contextRevision !== accuracyDraft.current.editRevision
        || dirtyRef.current || accuracyDraft.current.hasChanges(profile?.defaultVocabulary) || compositionInProgress.current
        || appearanceRevision !== currentAppearanceSave().revision || currentAppearanceSave().status !== 'saved') {
        setNotice('Newer edits are still here. Save them before restoring this draft.');
        return;
      }
      const compatibility = assessRecovery(entry, latest);
      if (compatibility !== 'matching') {
        setNotice(compatibility === 'already-saved'
          ? 'This appearance is already saved. You can download or discard its recovery copy.'
          : 'The saved project or media has changed. Download this draft to compare your edits.');
        // A refused restore does not make the old visible editor a draft based
        // on this newer server state. Only the offer's eligibility changes.
        setRecoveryConflict({ key: entry.key, raw: entry.raw, status: compatibility });
        refreshUnfinishedRecoveries();
        return;
      }
      const captions = restoredCaptions(entry, latest);
      const appearance = restoredAppearance(entry, latest);
      publishContextProject(latest, observation);
      applyProject(latest, true, { preserveSelection: true });
      observeSavedCaptionAppearance(latest.id, normalizeCaptionAppearance(latest.captionAppearance), latest.media);
      restoredRecovery.current = { key: ticket.key, expectedUpdatedAt: latest.updatedAt, basis: latest, origin: entry };
      if (captions) updateDraft(captions, undefined, 'text');
      if (entry.draft.accuracy) editAccuracyFields(entry.draft.accuracy);
      if (appearance) {
        markCaptionAppearanceDraft(latest.id, appearance, latest.media, normalizeCaptionAppearance(latest.captionAppearance));
        setLiveAppearance({ mediaKey: ticket.key, appearance });
        // Restore is explicit. Its normal save is still compared atomically with
        // the freshly checked look; merely opening a recovery offer never writes.
        void queueCaptionAppearanceSave(latest.id, appearance, latest.media);
      }
      captureUnfinishedRecovery();
      refreshUnfinishedRecoveries();
      if (!captions && entry.draft.accuracy) { setWorkspaceTool('accuracy'); setReviewMode(false); }
      else if (!captions && appearance) { setWorkspaceTool('appearance'); setReviewMode(false); }
      setNotice(captions ? 'Draft restored for review. Changed captions need approval again.' : 'Draft restored. Its changes use the normal save protection.');
      projectNavigationFocus.complete(focusRequest, () => document.querySelector<HTMLElement>('[data-project-entry-focus]'));
      focusCompleted = true;
    } catch {
      if (owns()) setError('Could not check the saved project. Your recovery draft is still available; try restoring again.');
    } finally {
      if (recoveryRead.current === request) {
        recoveryRead.current = null;
        setRecoveryWorking(false);
        if (!focusCompleted && projectScope.current.isCurrent(ticket)) projectNavigationFocus.complete(focusRequest, () =>
          document.querySelector<HTMLElement>('.unfinished-recovery .primary') || document.querySelector<HTMLElement>('[data-project-entry-focus]'));
        else if (!focusCompleted) projectNavigationFocus.cancel(focusRequest);
      } else projectNavigationFocus.cancel(focusRequest);
    }
  };

  const downloadDraftText = (raw: string) => {
    try {
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'sthang-unfinished-draft.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('Could not download the draft. It is still available here.'); }
  };
  const downloadUnfinishedDraft = (entry: RecoveryEntry) => downloadDraftText(entry.raw);
  const downloadCurrentDraft = () => {
    if (!project) return;
    downloadDraftText(JSON.stringify({
      version: 1, projectId: project.id,
      media: { filename: project.media.filename, size: project.media.size },
      capturedAt: new Date().toISOString(),
      captions: draftRef.current.map(({ id, text, startMs, endMs, textLocked, timingLocked }) =>
        ({ id, text, startMs, endMs, textLocked: Boolean(textLocked), timingLocked: Boolean(timingLocked) })),
      accuracy: { ...accuracyDraft.current.fields },
      ...(recoverUnsavedCaptionAppearance(project.id, project.media)
        ? { appearance: recoverUnsavedCaptionAppearance(project.id, project.media) } : {}),
    }, null, 2));
  };
  const discardUnfinishedDraft = async (entry: RecoveryEntry) => {
    if (!await confirmInStudio({ title: 'Discard this recovery draft?', message: 'This removes only this unfinished draft from this browser. Your saved project and current edits stay as they are.', confirmLabel: 'Discard draft', cancelLabel: 'Keep draft' })) return;
    if (!recoveryStore.remove(entry)) setNotice('The draft changed or could not be removed. Its newer copy was kept.');
    refreshUnfinishedRecoveries();
  };

  const saveDefaultGlossary = async () => {
    if (!profile || !project || busy || globalGlossaryWrite.current) return;
    const ticket = projectScope.current.capture();
    const revision = accuracyDraft.current.editRevision;
    const basis = profile;
    const submitted = uniqueContextLines(profile.defaultVocabulary, accuracyDraft.current.fields.vocabulary.split(/\r?\n/));
    const report = (error: boolean, message: string, savedVocabulary?: string[]) => {
      if (projectScope.current.isCurrent(ticket)) setGlobalGlossaryFeedback({ ticket, error, message, savedVocabulary });
    };
    globalGlossaryWrite.current = true;
    setGlobalGlossarySaving(true);
    report(false, '');
    setBusy('Saving global glossary…');
    try {
      const saved = await api.patchProfile({ defaultVocabulary: submitted });
      setProfile((current) => reconcileProfileAcknowledgement(current, basis, saved, { defaultVocabulary: submitted }));
      if (JSON.stringify(uniqueContextLines(saved.defaultVocabulary)) !== JSON.stringify(submitted)) {
        report(true, 'Some glossary terms were not saved. Your text is kept. Shorten the list or long terms, then try again.');
        return;
      }
      report(false, accuracyDraft.current.editRevision === revision
        ? 'Global glossary saved.'
        : 'Earlier glossary saved globally. Your newer Accuracy edits are kept; save again to include newer terms.', saved.defaultVocabulary);
    } catch {
      report(true, 'Could not save the global glossary. Your text is kept; try again.');
    } finally {
      globalGlossaryWrite.current = false;
      setGlobalGlossarySaving(false);
      setBusy((current) => current === 'Saving global glossary…' ? '' : current);
    }
  };
  const saveStyle = async () => {
    if (!profile || !project || groupingPresetWrite.current) return;
    groupingPresetWrite.current = true;
    setGroupingPresetSaving(true);
    setError('');
    const next = { id: 'my-tiktok-style', name: 'My TikTok Style', mode: groupingMode, maxChars };
    const styles = [...profile.styles];
    const index = styles.findIndex((style) => style.id === next.id);
    if (index >= 0) styles[index] = next; else styles.unshift(next);
    try {
      const saved = await api.patchProfile({ styles });
      const acknowledged = saved.styles.find((style) => style.id === next.id);
      if (!acknowledged || acknowledged.mode !== next.mode || acknowledged.maxChars !== next.maxChars) {
        throw new Error('The saved grouping preset could not be confirmed. Try saving again.');
      }
      setProfile((current) => reconcileProfileAcknowledgement(current, profile, saved, { styles }));
      const label = modes.find((mode) => mode.id === next.mode)?.label || next.mode;
      const snapshot = next.mode === 'word' ? label : `${label}, target ${next.maxChars} characters`;
      const newerChoices = groupingChoices.current.mode !== next.mode || groupingChoices.current.maxChars !== next.maxChars;
      setNotice(`Grouping preset saved: ${snapshot}.${newerChoices ? ' Newer choices are kept in the controls.' : ''}`);
    } catch (reason) {
      setError(`${reason instanceof Error ? reason.message : 'Grouping preset save failed.'} Your current grouping choices are kept.`);
    } finally {
      groupingPresetWrite.current = false;
      setGroupingPresetSaving(false);
    }
  };
  const applyGrouping = async (mode = groupingMode, limit = maxChars) => {
    if (!project || busy || groupingInFlight.current || currentProjectActiveJob) return;
    groupingInFlight.current = true;
    const targetProject = project;
    const intent = captureOperationIntent();
    const ticket = intent.ticket;
    setGroupingApplying(true);
    try {
      if (groupingChangesWording(project, draftRef.current)) {
        const confirmed = await confirmInStudio({
          title: 'Regroup from timed wording?',
          message: 'Unlocked wording may return to the timed transcript. Your current captions will be saved in History first. Lock corrections you want to keep unchanged.',
          confirmLabel: 'Save and regroup',
        });
        if (!confirmed || !isCurrentOperation(intent)) return;
      }
      setBusy('Applying caption grouping…');
      setError('');
      const hadEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      // Navigation cancels this intent before its saves drain and the project changes.
      // Do not extend that save queue for a cancelled regrouping action.
      if (!isCurrentOperation(intent) || (hadEdits && !saved)) return;
      if (dirtyRef.current) { setNotice('Newer edits are still unsaved. Save them before applying grouping.'); return; }
      const version = draftVersion.current;
      // Share the save queue: a later edit-save cannot be overtaken by regrouping.
      const task = saveQueue.current.then(async () => {
        if (!isCurrentOperation(intent) || conflictedSave.current?.key === ticket.key) return;
        const result = await api.resegment(
          targetProject.id,
          mode,
          limit,
          { filename: targetProject.media.filename, size: targetProject.media.size },
        );
        if (!projectScope.current.isCurrent(ticket) || projectMediaKey(result) !== ticket.key) return;
        rememberSavedCaptions(result);
        if (version !== draftVersion.current) {
          captureUnfinishedRecovery();
          setNotice('Grouping was saved, but newer edits remain in the editor. Save or review those edits before applying again.');
          return;
        }
        applyProject(result);
        setNotice('Grouping applied. Timing, pauses and locked captions can produce shorter groups.');
      });
      saveQueue.current = task.then(() => undefined, () => undefined);
      await task;
    } catch (reason) {
      if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Grouping could not be applied. Your edits are kept.');
    } finally {
      groupingInFlight.current = false;
      setGroupingApplying(false);
      if (projectScope.current.isCurrent(ticket)) setBusy('');
    }
  };
  const applyStyle = () => {
    if (!project || !profile || busy || currentProjectActiveJob || groupingInFlight.current) return;
    const style = profile.styles.find((item) => item.id === 'my-tiktok-style') || profile.styles[0];
    if (!style) return;
    setMaxChars(style.maxChars);
    setGroupingMode(style.mode);
    void applyGrouping(style.mode, style.maxChars);
  };

  const regenerateSelection = async () => {
    if (!project || !selection.captions.length) return;
    if (!llmSettings?.configured) {
      setError('Connect AI before asking for another take. Exact wording can still refresh timing without AI.');
      openSettings('ai');
      return;
    }
    const targetProject = project;
    const intent = captureOperationIntent();
    const editRevision = draftEditRevision.current;
    const contextRevision = accuracyDraft.current.editRevision;
    const selected = { ...selectionIntent.current, ids: [...selectionIntent.current.ids] };
    const selectedKey = selectionIntentKey(selected);
    const requestContext = contextPayload();
    if (selected.endMs - selected.startMs > 90_000) {
      const confirmed = await confirmInStudio({
        title: 'Improve a long caption range?',
        message: 'This selection is over 90 seconds, so comparing another take may take noticeably longer. Your current captions stay untouched until you approve the result.',
        confirmLabel: 'Improve captions',
      });
      if (!confirmed
        || !isCurrentOperation(intent)
        || draftEditRevision.current !== editRevision
        || accuracyDraft.current.editRevision !== contextRevision
        || selectionIntentKey(selectionIntent.current) !== selectedKey) return;
    }
    const hadUnsavedEdits = dirtyRef.current;
    const saved = await saveDraft(true, 'manual-save', true);
    if (hadUnsavedEdits && !saved) return;
    if (!isCurrentOperation(intent)
      || draftEditRevision.current !== editRevision
      || accuracyDraft.current.editRevision !== contextRevision
      || selectionIntentKey(selectionIntent.current) !== selectedKey) return;
    await startJob(
      intent,
      () => api.startRegenerationJob(targetProject.id, selected.startMs, selected.endMs, requestContext, { filename: targetProject.media.filename, size: targetProject.media.size }, targetProject.generationModel ?? 'automatic'),
      `Improving captions for ${rangeLabel(selected.startMs, selected.endMs)}.`,
    );
  };

  const refineProposal = async (input: RegenerationRefinementInput) => {
    if (!project || !proposal) return;
    if (input.strategy !== 'manual-realign' && !llmSettings?.configured) {
      setError('Connect AI before asking for another take. Exact wording can still refresh timing without AI.');
      openSettings('ai');
      return;
    }
    if (currentProjectActiveJob) {
      setNotice('A caption processing job is already running for this project.');
      return;
    }
    const label = input.strategy === 'deep-verify'
      ? 'Deep verification queued. Studio will compare extra attempts.'
      : input.strategy === 'manual-realign'
        ? 'Exact wording queued for a timing refresh.'
        : input.useProposalAsBaseline
          ? 'Refinement queued using this take as the accepted baseline.'
          : 'Alternative take queued. Keep reviewing while it runs.';
    await startJob(captureOperationIntent(), () => api.startRefinementJob(project.id, proposal.id, input, { filename: project.media.filename, size: project.media.size }, project.generationModel ?? 'automatic'), label, false);
  };

  const applyProposal = async (mode: RegenerationApplyMode, editedText?: string) => {
    if (!project || !proposal) return;
    if ((mode === 'all' || mode === 'text-only') && editedText !== undefined && !editedText.trim()) {
      setError('Enter proposed wording before accepting text.');
      return;
    }
    const ticket = projectScope.current.capture();
    const editRevision = draftEditRevision.current;
    const draftWasDirty = dirtyRef.current;
    setBusy(mode === 'reject' ? 'Discarding proposal…' : 'Applying approved regeneration…');
    setError('');
    try {
      const result = await queueSameMediaMutation(
        ticket,
        async () => {
          const observation = accuracyDraft.current.capture(ticket);
          const next = await api.applyRegenerationProposal(project.id, proposal.id, mode, editedText);
          publishContextProject(next, observation, false, mode !== 'reject');
          return next;
        },
      );
      if (!result) return;
      const published = publishSameMediaMutation(
        result,
        ticket,
        editRevision,
        draftWasDirty,
        mode === 'reject'
          ? 'The proposal was discarded. Your newer caption edits remain unsaved in the editor.'
          : 'The regeneration was applied on disk. Your newer caption edits remain unsaved in the editor.',
        mode !== 'reject',
      );
      if (published === 'stale') return;
      closeComparison();
      if (published === 'applied') setNotice(mode === 'reject' ? 'Proposal discarded. Current captions were kept.' : `Regeneration applied: ${mode.replace('-', ' ')}.`);
    } catch (reason) { if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Could not apply regeneration'); }
    finally { if (projectScope.current.isCurrent(ticket)) setBusy(''); }
  };

  const cleanKhmerSpacing = async () => {
    if (!project) return;
    const targetProject = project;
    const intent = captureOperationIntent();
    const ticket = intent.ticket;
    setBusy('Cleaning Khmer spacing…'); setError('');
    try {
      const hadUnsavedEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (!isCurrentOperation(intent) || (hadUnsavedEdits && !saved)) return;
      if (dirtyRef.current) { setNotice('Newer edits are still unsaved. Save them before cleaning Khmer spacing.'); return; }
      const editRevision = draftEditRevision.current;
      const result = await queueSameMediaMutation(ticket, () => withCaptionAppearanceBarrier(targetProject.id, async () => {
        if (!isCurrentOperation(intent)) return null;
        const basis = ordinarySaveBasis.current;
        const latest = await api.get(targetProject.id);
        if (!isCurrentOperation(intent)) return null;
        const expectedUpdatedAt = checkedSaveRevision(basis, latest, 'captions');
        return api.normalizeKhmerSpacing(targetProject.id, {
          filename: targetProject.media.filename, size: targetProject.media.size,
        }, expectedUpdatedAt);
      }));
      if (!result) return;
      const published = publishSameMediaMutation(
        result,
        ticket,
        editRevision,
        false,
        'Khmer spacing cleanup was saved. Your newer caption edits remain unsaved in the editor.',
      );
      if (published === 'applied') setNotice('Khmer word spacing cleaned. Text-locked captions were preserved.');
    } catch (reason) {
      if (projectScope.current.isCurrent(ticket)) {
        if (reason instanceof ApiRequestError && reason.code === 'CAPTION_REVISION_CHANGED') {
          protectSaveConflict(reason, ticket);
          setCaptionSaveError(reason.message);
          setAutosaveState('failed');
          captureUnfinishedRecovery();
        }
        setError(reason instanceof Error ? reason.message : 'Khmer spacing cleanup failed');
      }
    }
    finally { if (projectScope.current.isCurrent(ticket)) setBusy(''); }
  };

  const runTimingPostprocessor = async () => {
    if (!project) return;
    const targetProject = project;
    const intent = captureOperationIntent();
    const ticket = intent.ticket;
    const confirmed = await confirmInStudio({
      title: 'Apply safe timing cleanup?',
      message: `Studio will use “${qaSettings.name}”, skip timing-locked captions, and create a History checkpoint before changing timing.`,
      confirmLabel: 'Apply cleanup',
    });
    if (!confirmed || !isCurrentOperation(intent)) return;
    setBusy('Snapping and smoothing caption timing…');
    try {
      const hadUnsavedEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (!isCurrentOperation(intent) || (hadUnsavedEdits && !saved)) return;
      if (dirtyRef.current) { setNotice('Newer edits are still unsaved. Save them before applying timing cleanup.'); return; }
      const editRevision = draftEditRevision.current;
      const result = await queueSameMediaMutation(ticket, () => withCaptionAppearanceBarrier(targetProject.id, async () => {
        if (!isCurrentOperation(intent)) return null;
        const basis = ordinarySaveBasis.current;
        const latest = await api.get(targetProject.id);
        if (!isCurrentOperation(intent)) return null;
        const expectedUpdatedAt = checkedSaveRevision(basis, latest, 'captions');
        return api.postprocessTiming(targetProject.id, qaSettings, {
          filename: targetProject.media.filename, size: targetProject.media.size,
        }, expectedUpdatedAt);
      }));
      if (!result) return;
      const published = publishSameMediaMutation(
        result,
        ticket,
        editRevision,
        false,
        'Timing cleanup was saved. Your newer caption edits remain unsaved in the editor.',
      );
      if (published === 'applied') setNotice('Safe timing cleanup applied. Restore it from History if needed.');
    } catch (reason) {
      if (projectScope.current.isCurrent(ticket)) {
        // Alignment/admission conflicts do not invalidate caption save authority.
        if (reason instanceof ApiRequestError && reason.code === 'CAPTION_REVISION_CHANGED') {
          protectSaveConflict(reason, ticket);
          setCaptionSaveError(reason.message);
          setAutosaveState('failed');
          captureUnfinishedRecovery();
        }
        setError(reason instanceof Error ? reason.message : 'Timing cleanup failed');
      }
    }
    finally { if (projectScope.current.isCurrent(ticket)) setBusy(''); }
  };

  const setQaProfile = async (id: QaProfileId) => {
    await saveProfilePreferences({ qaProfileId: id });
  };

  const patchSelected = (patch: Partial<CaptionSegment>, message: string) => {
    const ids = new Set(selection.ids);
    if (!ids.size) return;
    updateDraft(draft.map((caption) => ids.has(caption.id) ? { ...caption, ...patch } : caption), undefined, 'metadata');
    setNotice(message);
  };

  const approveAndNext = () => {
    if (!selection.ids.length || !riskyIds.length) return;
    const selectedIds = new Set(selection.ids);
    const changed = selection.captions.filter((caption) => !caption.approved);
    if (!changed.length) return;
    const restoreSelectionId = selection.ids[0];
    const draftIndex = new Map(draft.map((caption, index) => [caption.id, index]));
    const lastSelectedIndex = Math.max(...selection.ids.map((id) => draftIndex.get(id) ?? -1));
    const remaining = riskyIds.filter((id) => !selectedIds.has(id));
    const later = remaining.find((id) => (draftIndex.get(id) ?? -1) > lastSelectedIndex);
    const nextId = later || remaining[0] || null;
    const wrapped = Boolean(nextId && !later);
    const nextDraft = draft.map((caption) => selectedIds.has(caption.id) ? { ...caption, approved: true } : caption);
    updateDraft(nextDraft, nextId || restoreSelectionId, 'metadata');
    const appliedById = new Map(draftRef.current.map((caption) => [caption.id, caption]));
    const undoItems = changed.map((caption) => ({ id: caption.id, approved: Boolean(caption.approved), applied: appliedById.get(caption.id)! }));

    const message = nextId
      ? wrapped
        ? tn('review.undo.wrapped', remaining.length)
        : t('review.undo.advanced')
      : t('review.undo.complete');
    setReviewUndo({ items: undoItems, restoreSelectionId, message });

    if (nextId) moveToReviewCaption(nextId, profile?.preferences.autoPlayNextReview ?? true);
    else { cancelPlayback(); media.current?.pause(); }
  };

  const undoReviewApproval = () => {
    if (!reviewUndo) return;
    const ownsUndoFocus = Boolean(document.activeElement?.closest('.review-undo-toast, .review-completion'));
    const restoreDecisionFocus = reviewMode && ownsUndoFocus;
    const currentById = new Map(draftRef.current.map((caption) => [caption.id, caption]));
    // Undo owns only the approval transitions it made, at their exact applied
    // caption revision. Never reinstate approval on wording edited afterward.
    const eligible = reviewUndo.items.filter((item) => sameTimingRevision(currentById.get(item.id), item.applied));
    const skipped = reviewUndo.items.length - eligible.length;
    if (!eligible.length) {
      if (ownsUndoFocus) {
        // No caption was restored. The persistent Review entry stays clear of
        // the preview and the replacement notice without moving the editor.
        document.querySelector<HTMLButtonElement>('.stage-rail [data-stage="review"]')?.focus({ preventScroll: true });
      }
      setReviewUndo(null);
      setNotice(t('review.undo.none'));
      return;
    }
    const previous = new Map(eligible.map((item) => [item.id, item.approved]));
    const restoreId = previous.has(reviewUndo.restoreSelectionId) ? reviewUndo.restoreSelectionId : eligible[0].id;
    updateDraft(draftRef.current.map((caption) => previous.has(caption.id) ? { ...caption, approved: previous.get(caption.id)! } : caption), restoreId, 'metadata');
    setReviewUndo(null);
    schedulePlayback(() => {
      moveToReviewCaption(restoreId, false);
      if (restoreDecisionFocus && document.activeElement === document.body) {
        document.querySelector<HTMLButtonElement>('.review-approve-next')?.focus({ preventScroll: true });
      }
    }, 20);
    setNotice(skipped
      ? t('review.undo.partial', {
          restored: tn('review.undo.restoredCount', eligible.length),
          skipped: tn('review.undo.skippedCount', skipped),
        })
      : t('review.undo.undone'));
  };

  const prepareCaptionHandoff = async (target: CaptionProject, ticket: ProjectTicket, editRevision: number, signal: AbortSignal, needsAppearance = false) => {
    const active = () => !signal.aborted && projectScope.current.isCurrent(ticket) && currentWorkspaceTool.current === 'export';
    const hadEdits = dirtyRef.current;
    const saved = await saveDraft(true, 'manual-save', true);
    await saveQueue.current;
    if (!active()) return null;
    if (hadEdits && !saved) throw new Error('Save your captions successfully before transferring them.');
    if (dirtyRef.current || draftEditRevision.current !== editRevision) throw new Error('The captions changed while saving. Review the latest version and try again.');
    const captionSnapshot = JSON.stringify(draftRef.current);
    if (needsAppearance && !await waitForCaptionAppearanceSaves(target.id, target.media)) throw new Error('Your latest appearance could not be saved. Retry its save before transferring styled captions or appearance data.');
    if (!active()) return null;
    const summary = await captionHandoffApi.summary(target.id, signal);
    if (!active()) return null;
    if (dirtyRef.current || draftEditRevision.current !== editRevision || JSON.stringify(draftRef.current) !== captionSnapshot) {
      throw new Error('The captions changed during export preparation. Your newer edits were kept.');
    }
    const expected = createCaptionData({ captions: draftRef.current }).captions;
    if (summary.media.filename !== target.media.filename || summary.media.size !== target.media.size
      || JSON.stringify(summary.snapshot.captions) !== JSON.stringify(expected)) {
      throw new Error('The saved captions changed in another operation. Reopen the project before transferring them.');
    }
    return { summary, captionSnapshot, basis: { expectedMedia: summary.media, expectedRevision: summary.revision } };
  };

  const exportCaptionFile = async (format: CaptionFileFormat): Promise<boolean> => {
    if (!project || busy || handoffRequest.current || !draftRef.current.length) return false;
    const target = project;
    const ticket = projectScope.current.capture();
    const editRevision = draftEditRevision.current;
    const controller = new AbortController();
    handoffRequest.current = controller;
    setCaptionHandoffWorking(true);
    setError('');
    try {
      const prepared = await prepareCaptionHandoff(target, ticket, editRevision, controller.signal, ['ass', 'data', 'bundle'].includes(format));
      if (!prepared) return false;
      const result = await captionHandoffApi.export(target.id, format, prepared.basis, controller.signal);
      if (controller.signal.aborted || !projectScope.current.isCurrent(ticket) || currentWorkspaceTool.current !== 'export') return false;
      if (dirtyRef.current || draftEditRevision.current !== editRevision || JSON.stringify(draftRef.current) !== prepared.captionSnapshot) {
        throw new Error('The captions changed while the file was being prepared. Export again to include the latest edits.');
      }
      saveHandoffDownload(result.blob, result.filename);
      window.dispatchEvent(new Event('sthang:export-history-updated'));
      setNotice(result.warnings || 'Caption file prepared for download. Your Studio project stays editable; follow the destination’s import instructions.');
      return true;
    } catch (reason) {
      if (!controller.signal.aborted && projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Caption export failed.');
      return false;
    } finally {
      if (handoffRequest.current === controller) { handoffRequest.current = null; setCaptionHandoffWorking(false); }
    }
  };

  const previewCaptionImport = async (file: File): Promise<void> => {
    if (!project || busy || handoffRequest.current) return;
    const target = project;
    const ticket = projectScope.current.capture();
    const editRevision = draftEditRevision.current;
    const controller = new AbortController();
    handoffRequest.current = controller;
    setCaptionHandoffWorking(true);
    setPendingCaptionImport(null);
    setError('');
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('Choose a Studio caption-data file smaller than 4 MB.');
      const data = await file.text();
      if (controller.signal.aborted || !projectScope.current.isCurrent(ticket)) return;
      const prepared = await prepareCaptionHandoff(target, ticket, editRevision, controller.signal);
      if (!prepared) return;
      const preview = await captionHandoffApi.previewRestore(target.id, data, prepared.basis, controller.signal);
      if (controller.signal.aborted || !projectScope.current.isCurrent(ticket) || currentWorkspaceTool.current !== 'export') return;
      if (dirtyRef.current || draftEditRevision.current !== editRevision || JSON.stringify(draftRef.current) !== prepared.captionSnapshot) {
        throw new Error('The captions changed while reading the file. Open it again to review the latest state.');
      }
      setPendingCaptionImport({ filename: file.name, data, preview, basis: prepared.basis, ticket, editRevision, captionSnapshot: prepared.captionSnapshot });
    } catch (reason) {
      if (!controller.signal.aborted && projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Could not read caption data.');
    } finally {
      if (handoffRequest.current === controller) { handoffRequest.current = null; setCaptionHandoffWorking(false); }
    }
  };

  const applyCaptionImport = async () => {
    const pending = pendingCaptionImport;
    if (!project || !pending || handoffRequest.current || busy || currentProjectActiveJob) return;
    const target = project;
    const valid = () => projectScope.current.isCurrent(pending.ticket) && currentWorkspaceTool.current === 'export'
      && !dirtyRef.current && draftEditRevision.current === pending.editRevision
      && JSON.stringify(draftRef.current) === pending.captionSnapshot;
    if (!valid()) { setNotice('The project changed. Open the caption-data file again before replacing captions.'); return; }
    const controller = new AbortController();
    handoffRequest.current = controller;
    setCaptionHandoffWorking(true);
    setError('');
    try {
      // Reuse the History/save acknowledgement lane. Once a replacement has been
      // submitted, finish reconciling it even if the preview is dismissed.
      await queueSameMediaMutation(pending.ticket, async () => {
        if (!valid() || controller.signal.aborted) return;
        const result = await captionHandoffApi.restore(target.id, pending.data, pending.basis, pending.preview.candidateDigest);
        const published = publishSameMediaMutation(result, pending.ticket, pending.editRevision, false,
          'Caption data was restored on disk. Your newer edits are still kept in the editor.');
        if (published !== 'stale') {
          setPendingCaptionImport(null);
          if (published === 'applied') setNotice('Caption data restored. Current appearance and source media were kept. The previous captions are in History.');
        }
      });
    } catch (reason) {
      if (projectScope.current.isCurrent(pending.ticket)) setError(reason instanceof Error ? reason.message : 'Caption restore failed.');
    } finally {
      if (handoffRequest.current === controller) { handoffRequest.current = null; setCaptionHandoffWorking(false); }
    }
  };


  const startVideoExport = async (settings: VideoExportSettings, appearance: CaptionAppearance, exportStillCurrent: () => boolean): Promise<ProcessingJob | null> => {
    const currentExport = () => currentWorkspaceTool.current === 'export' && exportStillCurrent();
    if (!project || !currentExport()) return null;
    const targetProject = project;
    const intent = captureOperationIntent();
    const editRevision = draftEditRevision.current;
    const severe = issues.filter((issue) => issue.severity !== 'info').length;
    if (severe > 0) {
      const confirmed = await confirmInStudio({
        title: 'Render with review warnings?',
        message: `${severe} timing/format warning${severe === 1 ? '' : 's'} remain under “${qaSettings.name}”. Studio can render anyway, but the finished video will use the current caption text and timing.`,
        confirmLabel: 'Render anyway',
      });
      if (!confirmed || !currentExport() || !isCurrentOperation(intent) || draftEditRevision.current !== editRevision) return null;
    }
    const hadUnsavedEdits = dirtyRef.current;
    const saved = await saveDraft(true, 'manual-save', true);
    if (hadUnsavedEdits && !saved) return null;
    await saveQueue.current;
    if (!currentExport() || !isCurrentOperation(intent) || draftEditRevision.current !== editRevision) return null;
    // The browser's reviewed picture is the export authority, including in a
    // clean stale tab. Hash the shared rendering basis; unrelated context/title
    // changes need not block this output.
    const reviewed = { ...(savedProject.current || targetProject), captions: draftRef.current, captionAppearance: appearance };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exportContentBasis(reviewed, 'video')));
    const expectedContentFingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (!currentExport() || !isCurrentOperation(intent) || dirtyRef.current || draftEditRevision.current !== editRevision) return null;
    return startJob(
      intent,
      () => api.startVideoExportJob(targetProject.id, settings, appearance, { filename: targetProject.media.filename, size: targetProject.media.size }, expectedContentFingerprint),
      'Captioned video export queued. Studio saved a caption/settings snapshot, so you can keep editing while it renders.',
      false,
      false,
    );
  };

  const handleCorrectionAction = async (event: CorrectionEvent, action: 'remember-global' | 'add-project' | 'ignore') => {
    if (mediaMutationInFlight.current) return;
    const ticket = projectScope.current.capture();
    if (action === 'add-project' && restoredRecovery.current?.key === ticket.key
      && (!await saveUnfinishedChanges() || !projectScope.current.isCurrent(ticket))) return;
    setBusy('Updating correction memory…'); setError('');
    try {
      const result = await queueSameMediaMutation(ticket, async () => {
        const observation = accuracyDraft.current.capture(ticket);
        const basis = ordinarySaveBasis.current;
        const result = await api.correctionAction(event.id, action);
        if (result.project) publishContextProject(result.project, observation, false, true,
          action === 'add-project' && matchesVocabularyAddition(basis, result.project, event.suggestedVocabularyLine));
        return result;
      });
      if (!result) return;
      setProfile(result.profile);
      if (!projectScope.current.isCurrent(ticket)) return;
      if (result.project) {
        setProjects((items) => [summarizeProject(result.project!), ...items.filter((item) => item.id !== result.project!.id)]);
      }
      if (action === 'remember-global' || (action === 'add-project' && result.project && projectMediaKey(result.project) === ticket.key)) {
        editAccuracyFields({ vocabulary: uniqueLines(accuracyDraft.current.fields.vocabulary.split(/\r?\n/), [event.suggestedVocabularyLine]).join('\n') });
      }
      if (action === 'remember-global') setNotice('Correction remembered globally.');
      else if (action === 'add-project') setNotice('Correction added to that project’s glossary.');
    } catch (reason) { if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Correction action failed'); }
    finally { if (projectScope.current.isCurrent(ticket)) setBusy(''); }
  };
  function cancelCorrectionRead() {
    setBlockedSwitch(null);
    correctionRequest.current?.abort();
    correctionRequest.current = null;
    setOpeningCorrection(null);
    setCorrectionReadError(null);
  }
  function closeCorrections() {
    cancelCorrectionRead();
    setShowCorrections(false);
  }
  const openCorrectionEvent = async (event: CorrectionEvent) => {
    if (correctionRequest.current) return;
    if (mediaMutationInFlight.current) {
      setNotice('Wait for the media change to finish before opening another project.');
      return;
    }
    if (wordBatchMutation.current) {
      setNotice('Finish saving prepared word timings before opening another project.');
      return;
    }
    const intent = requestNavigation();
    const request = new AbortController();
    correctionRequest.current = request;
    setOpeningCorrection(event.id);
    setBlockedSwitch(null);
    setCorrectionReadError(null);
    const ownsRead = () => correctionRequest.current === request && !request.signal.aborted && isCurrentOperation(intent);
    try {
      if (!await saveBeforeSwitch('corrections', event.id, ownsRead)) return;
      const readRevision = draftEditRevision.current;
      const contextRevision = accuracyDraft.current.editRevision;
      const appearanceRevision = currentAppearanceSave().revision;
      const target = await api.get(event.projectId, request.signal);
      if (!ownsRead()) return;
      if (dirtyRef.current || readRevision !== draftEditRevision.current || contextRevision !== accuracyDraft.current.editRevision
        || accuracyDraft.current.hasChanges(profile?.defaultVocabulary) || appearanceRevision !== currentAppearanceSave().revision
        || currentAppearanceSave().status !== 'saved') {
        setBlockedSwitch({ surface: 'corrections', id: event.id });
        return;
      }
      const ticket = beginNavigation();
      publishContextProject(target, accuracyDraft.current.capture(ticket));
      applyProject(target);
      const key = projectMediaKey(target);
      const captionId = target.captions.find((caption) => caption.id === event.captionId)?.id;
      if (captionId) {
        if (key !== intent.key) queuedCaption.current = captionId;
        setSelectionAnchor(captionId);
        setSelectionEnd(captionId);
      } else setNotice('The original caption is no longer in this project.');
      setWorkspaceTool(null);
      setReviewMode(false);
      correctionDestination.current = { ticket: projectScope.current.capture(), captionId };
      correctionPlayback.current = {
        key, recordedStartMs: event.startMs,
        startMs: Math.max(0, event.startMs - (profile?.preferences.reviewPreRollMs ?? 450)),
        endMs: event.endMs + (profile?.preferences.reviewPostRollMs ?? 300),
      };
      setShowCorrections(false);
      if (key === intent.key && media.current) playCorrectionAudio(media.current, key);
    } catch (reason) {
      if (ownsRead()) setCorrectionReadError({ id: event.id, message: reason instanceof Error ? reason.message : 'Could not open the saved project. Try Review audio again.' });
    } finally {
      if (correctionRequest.current === request) {
        correctionRequest.current = null;
        setOpeningCorrection(null);
      }
    }
  };

  const openSettings = (tab: SettingsTab = 'ai') => {
    setSettingsTab(tab);
    setShowProfile(true);
  };
  const refreshAiHealth = async (next: LlmSettingsStatus) => {
    setLlmSettings(next);
    // A report started with earlier connection settings cannot become current.
    doctorRequest.current++;
    setDoctor(null);
    setDoctorError('');
    setDoctorLoadState('idle');
    await refreshSystemHealth();
    return next;
  };
  const saveLlmSettings = async (input: SaveLlmSettingsInput) => refreshAiHealth(await api.saveLlmSettings(input));
  const forgetLlmKey = async () => refreshAiHealth(await api.forgetLlmKey());

  const saveProfilePatch = async (patch: ProfilePatch, feedback: 'toast' | 'inline' = 'toast'): Promise<AppProfile | null> => {
    const basis = profile;
    setBusy('Saving profile…');
    try {
      const saved = await api.patchProfile(patch);
      setProfile((current) => reconcileProfileAcknowledgement(current, basis, saved, patch));
      if (feedback === 'toast') setNotice('Profile updated.');
      return saved;
    }
    catch (reason) { if (feedback === 'toast') setError(reason instanceof Error ? reason.message : 'Profile update failed'); return null; }
    finally { setBusy((current) => current === 'Saving profile…' ? '' : current); }
  };
  const importProfile = async (value: AppProfile): Promise<boolean> => {
    const ticket = projectScope.current.capture();
    const basis = profile;
    const accuracyRevision = accuracyDraft.current.editRevision;
    setBusy('Importing profile…');
    try {
      const imported = await api.importProfile(value);
      setProfile((current) => reconcileProfileAcknowledgement(current, basis, imported));
      setProfileImportRevision((current) => current + 1);
      if (projectScope.current.isCurrent(ticket) && accuracyDraft.current.editRevision === accuracyRevision) editAccuracyFields({
        vocabulary: uniqueLines(imported.defaultVocabulary, accuracyDraft.current.fields.vocabulary.split(/\r?\n/)).join('\n'),
      });
      setNotice('Profile imported. Glossary, topic packs, grouping presets and correction memory are now available on this PC.');
      return true;
    } catch { return false; }
    finally { setBusy((current) => current === 'Importing profile…' ? '' : current); }
  };
  const runDoctor = async () => {
    if (busy || doctorInFlight.current) return;
    doctorInFlight.current = true;
    const request = ++doctorRequest.current;
    setDoctorLoadState('loading');
    setDoctorError('');
    setBusy('Running system checks…');
    try {
      const report = await api.doctor();
      if (doctorRequest.current !== request) return;
      const confirmed = await refreshSystemHealth(() => doctorRequest.current === request);
      if (doctorRequest.current !== request) return;
      setDoctor(report);
      if (!confirmed) setDoctorError('The checks finished, but Studio could not confirm caption setup.');
      setDoctorLoadState(confirmed ? 'ready' : 'error');
    } catch (reason) {
      if (doctorRequest.current === request) {
        setDoctorError(reason instanceof Error ? reason.message : 'System check failed.');
        setDoctorLoadState('error');
      }
    } finally {
      doctorInFlight.current = false;
      setBusy((current) => current === 'Running system checks…' ? '' : current);
    }
  };
  const applyTopicPack = (pack: TopicPack) => {
    if (!project || busy) return false;
    editAccuracyFields({ description: pack.description, vocabulary: uniqueLines(profile?.defaultVocabulary, pack.vocabulary).join('\n') });
    setShowProfile(false);
    if (proposal) {
      setNotice(`Applied “${pack.name}”. Review the project context in Accuracy after this comparison.`);
      return false;
    }
    cancelPlayback();
    setReviewMode(false);
    setWorkspaceTool('accuracy');
    setNotice(`Applied topic pack: ${pack.name}`);
    return true;
  };
  const setAutoLoop = async (enabled: boolean) => {
    await saveProfilePreferences({ autoLoopReview: enabled });
  };
  const setAutoPlayNext = async (enabled: boolean) => {
    await saveProfilePreferences({ autoPlayNextReview: enabled });
  };
  const setReviewFocusMode = async (mode: 'brackets-label' | 'brackets' | 'off') => {
    await saveProfilePreferences({ reviewFocusMode: mode });
  };
  const saveWaveformPreference = async (value: { waveformMode?: 'waveform' | 'spectrum'; waveformZoom?: number }) => {
    await saveProfilePreferences(value);
  };

  const rememberReplacement = async (line: string, scope: 'project' | 'global'): Promise<boolean> => {
    if (!project || !profile || mediaMutationInFlight.current) return false;
    const ticket = projectScope.current.capture();
    if (scope === 'global') {
      const defaultVocabulary = uniqueLines(profile.defaultVocabulary, [line]);
      const savedProfile = await api.patchProfile({ defaultVocabulary });
      setProfile((current) => reconcileProfileAcknowledgement(current, profile, savedProfile, { defaultVocabulary }));
      if (!projectScope.current.isCurrent(ticket)) return false;
      if (!savedProfile.defaultVocabulary.some((saved) => saved.trim().toLocaleLowerCase('en') === line.trim().toLocaleLowerCase('en'))) return false;
      editAccuracyFields({ vocabulary: uniqueLines(accuracyDraft.current.fields.vocabulary.split(/\r?\n/), [line]).join('\n') });
      setNotice('Replacement remembered globally.');
      return true;
    } else {
      // Add to the current draft, not the last render's persisted vocabulary.
      // This explicit addition stays visible and retryable even if its save fails.
      editAccuracyFields({ vocabulary: uniqueLines(accuracyDraft.current.fields.vocabulary.split(/\r?\n/), [line]).join('\n') });
      const saved = await saveContext(true);
      if (!saved || !projectScope.current.isCurrent(ticket)) return false;
      const acknowledged = accuracyDraft.current.saved?.vocabulary?.some((savedLine) => savedLine.trim().toLocaleLowerCase('en') === line.trim().toLocaleLowerCase('en')) ?? false;
      if (acknowledged) setNotice('Replacement added to this project glossary.');
      return acknowledged;
    }
  };

  const loadHistory = async () => {
    if (!project || pendingHistoryRead.current !== null) return;
    const ticket = projectScope.current.capture();
    if (ticket.key !== projectMediaKey(project)) return;
    const request = ++historyRead.current;
    pendingHistoryRead.current = request;
    setHistoryLoadState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const entries = await api.history(project.id);
      if (projectScope.current.isCurrent(ticket) && request === historyRead.current) {
        setHistoryEntries(entries);
        setHistoryLoadState({ loading: false, loaded: true, error: '' });
      }
    } catch {
      if (projectScope.current.isCurrent(ticket) && request === historyRead.current) {
        setHistoryLoadState((current) => ({ ...current, loading: false, error: 'Could not load history. Try again; your saved versions have not been changed.' }));
      }
    } finally {
      if (pendingHistoryRead.current === request) pendingHistoryRead.current = null;
    }
  };
  const openHistory = async () => {
    if (!project) return;
    setShowHistory(true);
    await loadHistory();
  };
  const restoreHistory = async (historyId: string) => {
    if (!project) return;
    const targetProject = project;
    const ticket = projectScope.current.capture();
    const confirmed = await confirmInStudio({
      title: 'Restore this checkpoint?',
      message: 'Studio saves your current state as another History entry first, so you can still return to it later.',
      confirmLabel: 'Restore checkpoint',
    });
    if (!confirmed || !projectScope.current.isCurrent(ticket)) return;
    setBusy('Restoring project history…');
    try {
      const hadUnsavedEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (!projectScope.current.isCurrent(ticket) || (hadUnsavedEdits && !saved)) return;
      if (dirtyRef.current) { setNotice('Newer edits are still unsaved. Save them before restoring History.'); return; }
      const editRevision = draftEditRevision.current;
      const result = await queueSameMediaMutation(ticket, async () => {
        const observation = accuracyDraft.current.capture(ticket);
        const restored = await api.restoreHistory(targetProject.id, historyId, { filename: targetProject.media.filename, size: targetProject.media.size });
        publishContextProject(restored, observation, false, true);
        return restored;
      });
      if (!result) return;
      const published = publishSameMediaMutation(
        result,
        ticket,
        editRevision,
        false,
        'History was restored on disk. Your newer caption edits remain unsaved in the editor.',
      );
      if (published === 'stale') return;
      closeHistory();
      if (published === 'applied') setNotice('Earlier project version restored.');
    }
    catch (reason) { if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Restore failed'); }
    finally { if (projectScope.current.isCurrent(ticket)) setBusy(''); }
  };

  const isVideo = Boolean(project && isVideoProject(project));
  const timing = project?.transcript?.timing;
  const hasHybrid = Boolean(project?.transcript?.tokens?.length && timing && (timing.engine === 'kfa-local' || timing.engine === 'faster-whisper-local'));
  const legacy = Boolean(project?.transcript && !hasHybrid);
  const showGeneration = !proposal && !hasHybrid && !workspaceTool && !exportRepair;
  const stage: Stage = workspaceTool === 'review' || workspaceTool === 'appearance' || workspaceTool === 'export'
    ? workspaceTool : 'captions';
  const previousFirstWatchTool = useRef(workspaceTool);
  useEffect(() => {
    const toolChanged = previousFirstWatchTool.current !== workspaceTool;
    previousFirstWatchTool.current = workspaceTool;
    if (!firstWatch) return;
    if (firstWatchNotice.current === firstWatch) {
      firstWatchNotice.current = null;
      const count = riskyIds.length;
      setNotice(count
        ? tn('editor.firstWatch.noticeFlagged', count)
        : t('editor.firstWatch.noticeClear'));
    }
    if (firstWatch.projectId !== project?.id || firstWatch.mediaKey !== mediaKey || stage !== 'captions' || toolChanged || proposal) {
      setFirstWatch(null);
      return;
    }
    if (!mediaElement) return;
    const dismiss = () => setFirstWatch((current) => current === firstWatch ? null : current);
    if (!mediaElement.paused || mediaElement.seeking) dismiss();
    mediaElement.addEventListener('play', dismiss);
    mediaElement.addEventListener('seeking', dismiss);
    return () => {
      mediaElement.removeEventListener('play', dismiss);
      mediaElement.removeEventListener('seeking', dismiss);
    };
  }, [firstWatch, mediaElement, project?.id, mediaKey, stage, workspaceTool, proposal, riskyIds.length, t, tn]);
  const layoutMode: EditorLayoutMode = proposal || stage === 'review' || stage === 'appearance' ? 'judge' : 'edit';
  const enlargeAvailable = layoutMode === 'judge' && isVideo && mediaShape?.key === mediaKey && mediaShape.landscape;
  const savedContext = project?.transcriptionContext;
  const hasSavedContext = Boolean(savedContext?.description?.trim() || savedContext?.vocabulary?.some((term) => term.trim()));
  const usedFallback = timing?.engine === 'faster-whisper-local';
  const audioAlignmentUnverified = project?.mediaAlignment?.state === 'unverified-audio-change';
  const alignmentNoticeKey = project && audioAlignmentUnverified
    ? JSON.stringify([project.id, project.media.filename, project.media.size, project.mediaAlignment?.acceptedAt, project.mediaAlignment?.sourceRevision])
    : null;
  const timingConfigured = health?.timing.configured ?? true;

  const generationSetupFailed = (!health && startupErrors.includes('System status')) || (!llmSettings && startupErrors.includes('AI connection'));
  const generationSetupMissing = llmSettings?.configured === false || health?.timing.configured === false;
  const checkingGenerationSetup = !generationSetupMissing && (!llmSettings || !health) && !generationSetupFailed;
  const generationPending = Boolean(busy || currentProjectActiveJob || generationPreparing || generationModelSaving || mediaMutationStatus);
  const generationNeedsCheck = uncertainJobs.some((item) => item.key === mediaKey && item.captionJob);
  const generationLabelKey = currentProjectActiveJob ? 'editor.generation.busy' : generationPreparing ? 'editor.generation.submitting' : generationNeedsCheck ? 'editor.generation.checkActivity'
    : llmSettings?.configured === false ? 'editor.generation.connectAi' : health?.timing.configured === false ? 'editor.generation.systemCheck'
    : generationSetupFailed ? 'editor.generation.retryChecks' : checkingGenerationSetup ? 'editor.generation.checking'
    : legacy ? 'editor.generation.rebuild' : 'editor.generation.generate';
  const generationLabel = translate('en', generationLabelKey);

  const openReviewWorkspace = () => {
    if (!draft.length) return;
    setWorkspaceTool('review');
    setReviewMode(true);
    const id = riskyIds[0] || selection.ids[0] || draft[0]?.id;
    if (id) moveToReviewCaption(id, false);
  };
  const openWorkspaceFromGuide = (tool: 'accuracy' | 'review' | 'export') => {
    if (!project) return;
    workspaceEntryFocus.current = { ticket: viewTicket, tool, fromGuide: true, previous: document.activeElement };
    accuracyDescriptionFocus.current = null;
    setShowGuide(false);
    cancelPlayback();
    if (tool === 'review') openReviewWorkspace();
    else { setReviewMode(false); setWorkspaceTool(tool); }
  };
  const chooseWorkspaceTool = (tool: Exclude<WorkspaceTool, null>) => {
    if (tool !== workspaceTool && !proposal && window.matchMedia('(max-width: 1199px)').matches) {
      workspaceEntryFocus.current = { ticket: viewTicket, tool, previous: document.activeElement };
    }
    accuracyDescriptionFocus.current = null;
    cancelPlayback();
    if (tool === 'timeline') setRequestedTimingMode('caption');
    if (tool === 'review') {
      if (workspaceTool === 'review') {
        setWorkspaceTool(null);
        setReviewMode(false);
      } else openReviewWorkspace();
      return;
    }
    setReviewMode(false);
    if (tool === 'timeline' && workspaceTool !== 'timeline') {
      const id = selection.ids[0] || draft[0]?.id;
      if (id) { setSelectionAnchor(id); setSelectionEnd(id); }
    }
    setWorkspaceTool((current) => current === tool ? null : tool);
  };
  const toggleAccuracyToolbar = () => {
    chooseWorkspaceTool('accuracy');
    if (workspaceTool === 'accuracy') restoreInlineAccuracyFocus();
  };
  const selectStage = (next: Stage) => {
    if (next === stage) return;
    if (next === 'captions') {
      if (workspaceTool) chooseWorkspaceTool(workspaceTool);
    } else chooseWorkspaceTool(next);
  };
  const requestWordControl = (tool: 'timeline' | 'appearance', captionId?: string, request = projectNavigationFocus.capture()) => {
    setWordControlEntry(request ? { tool, captionId, ticket: viewTicket, request } : null);
  };
  const focusWordControl = (target: HTMLElement | null) => {
    if (!target || !wordControlEntry) return;
    const entry = wordControlEntry;
    setWordControlEntry(null);
    const workbench = target.closest<HTMLElement>('.editor-workbench');
    const preview = workbench?.querySelector<HTMLElement>('.stage-column');
    const reveal = workbench && preview && getComputedStyle(preview).position === 'sticky' ? (control: HTMLElement) => {
      const section = control.closest('.word-timing-panel, .appearance-word-details') ?? control;
      const previewBottom = workbench.getBoundingClientRect().top + parseFloat(getComputedStyle(preview).top) + preview.getBoundingClientRect().height;
      workbench.scrollTop += section.getBoundingClientRect().top - previewBottom - 8;
    } : undefined;
    projectNavigationFocus.complete(entry.request, () => {
      if (!target.isConnected || !projectScope.current.isCurrent(entry.ticket)) return null;
      if (entry.tool === 'appearance') {
        const disclosure = target.closest('details');
        if (disclosure) disclosure.open = true;
      }
      return target;
    }, reveal);
  };
  const selectTimingCaption = (caption: CaptionSegment) => {
    setSelectionAnchor(caption.id);
    setSelectionEnd(caption.id);
    const atMs = Math.max(0, Math.min(caption.startMs, mediaDurationMs ? mediaDurationMs - 1 : caption.startMs));
    if (media.current && media.current.readyState > 0) seek(atMs);
    else retainedMediaSeek.current = { key: mediaKey, timeMs: atMs };
    setTime(atMs / 1000);
  };
  const openWordTiming = (id?: string, wordId?: string) => {
    cancelPlayback();
    media.current?.pause();
    setReviewMode(false);
    const target = draftRef.current.find((caption) => caption.id === id) || selection.captions[0] || draftRef.current[0];
    requestWordControl('timeline', target?.id);
    if (target) { selectTimingCaption(target); editor.current?.revealCaption(target.id); }
    setWordTimingFocus(target && wordId ? { captionId: target.id, wordId } : null);
    setRequestedTimingMode('words');
    setWorkspaceTool('timeline');
  };

  const changeExportSession = (update: ExportWorkspaceSession | ((current: ExportWorkspaceSession) => ExportWorkspaceSession), remember = true) => {
    const ticket = viewTicket;
    if (!project || !projectScope.current.isCurrent(ticket) || ticket.key !== mediaKey) return;
    const current = exportVisitRef.current;
    const previous = current?.ticket === ticket ? current.session : createExportWorkspaceSession(isVideoProject(project));
    const session = typeof update === 'function' ? update(previous) : update;
    if (JSON.stringify(session) === JSON.stringify(previous)) return;
    setExportVisit({ ticket, session });
    // Only a direct output decision remembers choices. Delayed profile reads,
    // preset acknowledgements and capability fallbacks cannot overwrite another
    // tab's more recent decisions in browser storage.
    if (remember) setExportChoiceStorageError(exportChoiceStorage.write(project, session) ? ''
      : 'These export choices could not be remembered in this browser. They remain selected while this project is open.');
  };
  const repairExportIssue = (target: ExportRepairTarget) => {
    if (!project || !projectScope.current.isCurrent(viewTicket)) return;
    const caption = target.captionId ? draftRef.current.find((item) => item.id === target.captionId) : undefined;
    if (target.captionId && !caption) { setNotice('That caption changed. Check the updated export issue list.'); return; }
    cancelPlayback();
    media.current?.pause();
    setReviewMode(false);
    setExportVisit({ ticket: viewTicket, session: exportSession });
    setExportRepair({ ticket: viewTicket, target });
    exportRepairFocus.current = target.focus !== 'font';
    if (target.focus === 'font') {
      const request = projectNavigationFocus.capture();
      if (request) setExportFontFocus({ request, ticket: viewTicket });
    }
    if (caption) selectTimingCaption(caption);
    if (target.kind === 'word-timing' || target.kind === 'timing') {
      setRequestedTimingMode(target.kind === 'word-timing' ? 'words' : 'caption');
      setWorkspaceTool('timeline');
    } else setWorkspaceTool(target.kind === 'appearance' ? 'appearance' : null);
  };
  const backToExport = () => {
    if (!exportRepair || !projectScope.current.isCurrent(exportRepair.ticket)) return;
    cancelPlayback();
    setReviewMode(false);
    setWorkspaceTool('export');
  };
  useEffect(() => {
    if (!exportRepairFocus.current || !exportRepair || !projectScope.current.isCurrent(exportRepair.ticket)) return;
    exportRepairFocus.current = false;
    const frame = requestAnimationFrame(() => {
      if (!projectScope.current.isCurrent(exportRepair.ticket)) return;
      const id = exportRepair.target.captionId;
      if (id) editor.current?.revealCaption(id);
      if (id && exportRepair.target.kind === 'caption') {
        const row = document.querySelector<HTMLElement>(`[data-caption-id="${CSS.escape(id)}"]`);
        row?.querySelector<HTMLElement>('textarea:not([disabled]), button:not([disabled])')?.focus({ preventScroll: true });
      } else document.getElementById('export-repair-title')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [exportRepair, workspaceTool, viewTicket]);


  const highlighting = previewAppearance.highlightMode === 'word';
  const wordHighlightSummary = useMemo(() => {
    if (!highlighting) return EMPTY_WORD_HIGHLIGHT_SUMMARY;
    if (import.meta.env.DEV) {
      (window as unknown as { __STHANG_TEST_HOOKS__?: { onWordHighlightCoverage?: (count: number, captions: readonly CaptionSegment[]) => void } })
        .__STHANG_TEST_HOOKS__?.onWordHighlightCoverage?.(draft.length, draft);
    }
    return wordHighlightCoverage(draft);
  }, [draft, highlighting]);
  const wordHighlightArmed = Boolean(project?.wordHighlightFollow?.enabled && highlighting);
  const highlightAvailability = Boolean(!busy && !saveConflict && !groupingApplying && !mediaMutationStatus
    && !currentProjectActiveJob && !generationPreparing);
  highlightJobActive.current = Boolean(currentProjectActiveJob);
  highlightEditorReady.current = highlightAvailability;
  useEffect(() => { for (const check of highlightWaiters.current) check(); });

  const lastHighlightAppearance = useRef<{ ticket: ProjectTicket; enabled: boolean } | null>(null);
  useEffect(() => {
    const previous = lastHighlightAppearance.current;
    lastHighlightAppearance.current = { ticket: viewTicket, enabled: highlighting };
    // Turning a saved look Off also suppresses follow when done via a preset.
    if (previous?.ticket === viewTicket && previous.enabled && !highlighting) revokeWordHighlights();
  }, [highlighting, viewTicket]);

  useEffect(() => {
    const saved = savedProject.current;
    const armed = saved?.wordHighlightFollow;
    if (!wordHighlightArmed || !saved || !armed?.enabled || projectMediaKey(saved) !== viewTicket.key) {
      if (highlightFollow.current && (!highlighting || !armed?.enabled || highlightFollow.current.ticket !== viewTicket)) {
        highlightFollow.current.pending.clear();
      }
      return;
    }
    if (wordBatchRevoke.current) return;
    let follow = highlightFollow.current;
    if (follow?.ticket !== viewTicket || follow.epoch !== armed.epoch) {
      const reopening = follow?.ticket !== viewTicket && !wordBatchRunning.current;
      follow = {
        ticket: viewTicket, epoch: armed.epoch, captions: saved.captions, attempted: new Set(),
        pending: new Set(reopening ? classifyHighlightTargets(saved.captions).targets : []),
      };
      highlightFollow.current = follow;
    } else if (follow.captions !== saved.captions) {
      for (const id of affectedHighlightIds(follow.captions, saved.captions)) {
        follow.attempted.delete(id);
        follow.pending.add(id);
      }
      follow.captions = saved.captions;
    }
    if (wordBatchRunning.current || !follow.pending.size || !highlightAvailability || dirty || textComposing) return;
    const timer = window.setTimeout(() => {
      if (highlightFollow.current !== follow || !highlightSavedWhenClean(viewTicket) || wordBatchRunning.current || wordBatchRevoke.current) return;
      const ids = [...follow.pending];
      follow.pending.clear();
      void startWordHighlightPreparation('follow', ids);
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [project, viewTicket, wordHighlightArmed, highlighting, highlightAvailability, dirty, textComposing, wordBatch.status]);

  const hasWordBatchUndo = Boolean(wordBatchUndo && projectScope.current.isCurrent(wordBatchUndo.ticket));
  const syncRemainingHighlights = async () => {
    const navigation = projectNavigationFocus.capture();
    const ids = wordHighlightSummary.exceptions.map(({ id }) => id);
    const result = await startWordHighlightPreparation('follow', ids, undefined, true);
    if (result && projectNavigationFocus.isCurrent(navigation) && projectScope.current.isCurrent(viewTicket)
      && currentWorkspaceTool.current === 'appearance' && !dirtyRef.current && !currentProposal.current) {
      const remaining = wordHighlightCoverage(draftRef.current).exceptions[0];
      const caption = remaining && draftRef.current.find(({ id }) => id === remaining.id);
      if (caption) {
        cancelPlayback();
        media.current?.pause();
        setReviewMode(false);
        selectTimingCaption(caption);
        editor.current?.revealCaption(caption.id);
        setWordTimingFocus(null);
        setRequestedTimingMode('caption');
        setWorkspaceTool('timeline');
        requestWordControl('timeline', caption.id, navigation);
        return;
      }
    }
    projectNavigationFocus.cancel(navigation);
  };
  const wordPreparation: WordHighlightPreparationView = {
    ...wordBatch,
    running: wordBatchRunning.current,
    armed: wordHighlightArmed,
    counts: wordHighlightSummary.counts,
    exceptions: wordHighlightSummary.exceptions.length,
    hasSyncTargets: wordHighlightSummary.exceptions.some(({ locked }) => !locked),
    canStart: !wordBatchRunning.current && !wordBatchRevoke.current && !saveConflict && !mediaMutationStatus,
    hasUndo: hasWordBatchUndo,
    canUndo: hasWordBatchUndo && highlightAvailability && !dirty && !textComposing && !wordBatchMutation.current && !wordBatchRevoke.current,
    onToggle: (enabled) => {
      if (enabled) void startWordHighlightPreparation('apply');
      else revokeWordHighlights();
    },
    onStart: () => {
      if (!wordHighlightArmed) void startWordHighlightPreparation('apply');
      else void syncRemainingHighlights();
    },
    onCancel: revokeWordHighlights,
    onReview: () => reviewRemainingWordHighlights(),
    onUndo: undoPreparedWordHighlights,
    onOpenSetup: () => { openSettings('doctor'); void runDoctor(); },
    onReloadProject: () => void reloadSavedProject(),
  };

  function returnToEdits(surface: 'activity' | 'corrections') {
    returnToEditsFocus.current = { surface, ticket: projectScope.current.capture() };
    if (surface === 'activity') closeActivity();
    else closeCorrections();
  }
  function takeEditsFocus(surface: 'activity' | 'corrections') {
    const intent = returnToEditsFocus.current;
    if (!intent || intent.surface !== surface) return null;
    returnToEditsFocus.current = null;
    if (!projectScope.current.isCurrent(intent.ticket)) return null;
    return document.querySelector<HTMLElement>('.save-failure .toast-action:not(:disabled)')
      || document.querySelector<HTMLElement>('.save-action:not(:disabled)')
      || document.querySelector<HTMLElement>('[data-project-entry-focus]');
  }
  const blockedSaveMessage = blockedSwitch?.reason || (saveNeedsComparison ? 'The saved project changed. Review your current edits before switching.'
    : saveFailed ? 'Your current edits could not be saved.' : 'Finish saving your current edits before switching projects.');

  // Keep the Activity dialog and its focused control mounted while a result opens its project.
  const activity = <JobManager key="activity" open={showJobs} entryJobId={activityEntryId}
    uncertainProject={projectAwaitingJobCheck ? project?.title : undefined} jobs={jobs} loadState={jobLoadState} pendingActions={pendingJobActions} openingJobId={openingJobId} project={project ? { ...project, captions: draft } : undefined} appearanceReconciliation={reconciledAppearance} onClose={closeActivity} getResultFocusTarget={() => {
      const edits = takeEditsFocus('activity');
      if (edits) return edits;
      const next = activityResultFocus.current;
      activityResultFocus.current = null;
      if (!next || !projectScope.current.isCurrent(next.ticket)) return null;
      return document.querySelector<HTMLElement>(next.comparison ? '.workspace-inspector:not([hidden]) .inspector-heading' : '[data-project-entry-focus]');
    }} blockedSave={blockedSwitch?.surface === 'activity' ? { id: blockedSwitch.id, message: blockedSaveMessage } : undefined}
    onReturnToEdits={() => returnToEdits('activity')} onRefresh={(feedback) => void refreshJobs({ feedback })} onResume={(id) => actOnJob(id, 'resume')} onCancel={(id) => actOnJob(id, 'cancel')} onOpen={(job) => void openJobResult(job)}/>;

  const corrections = profile && <CorrectionInbox key="corrections" profile={profile} open={showCorrections} busy={!!busy}
    openingId={openingCorrection} readError={correctionReadError} onClose={closeCorrections} onFilterChange={cancelCorrectionRead}
    blockedSave={blockedSwitch?.surface === 'corrections' ? { id: blockedSwitch.id, message: blockedSaveMessage } : undefined}
    onReturnToEdits={() => returnToEdits('corrections')} onOpenEvent={openCorrectionEvent} onAction={handleCorrectionAction} getAudioFocusTarget={() => {
      const edits = takeEditsFocus('corrections');
      if (edits) return edits;
      const next = correctionDestination.current;
      correctionDestination.current = null;
      if (!next || !projectScope.current.isCurrent(next.ticket)) return null;
      const row = next.captionId && document.querySelector<HTMLElement>(`[data-caption-id="${CSS.escape(next.captionId)}"]`);
      return row || mediaPreviewFocus.current;
    }}/>;
  const sourceCheck = unconfirmedSource ? {
    previousName: unconfirmedSource.target.media.originalName,
    checking: checkingMediaSource,
    run: () => void checkSavedMediaSource(unconfirmedSource),
  } : undefined;
  const overlays = <>
    {pendingMediaReplacement && <ReplaceMediaDialog key={pendingMediaReplacement.id} filename={pendingMediaReplacement.file.name} captionCount={draft.length} working={mediaMutationStatus} error={mediaMutationError}
      sourceCheck={sourceCheck} preserveAudioConfirmation={pendingMediaReplacement.audioConfirmation}
      onModeChange={() => { setPendingMediaReplacement((current) => current ? { ...current, audioConfirmation: undefined } : current); setMediaMutationError(''); }}
      onCancel={() => { if (!mediaMutationInFlight.current) { cancelMediaSourceRead(); setPendingMediaReplacement(null); } }} onReplace={(mode, confirmation) => void submitMediaReplacement(mode, confirmation)}/>}
    {showMediaBackups && <RestoreMediaDialog checkpoints={mediaBackups} loading={mediaBackupsLoading} working={mediaMutationStatus} error={mediaMutationError}
      sourceCheck={sourceCheck} onCancel={() => { if (!mediaMutationInFlight.current) { cancelMediaSourceRead(); mediaBackupsRequest.current?.abort(); setShowMediaBackups(false); } }} onReload={() => void loadMediaBackups()}
      onRestore={(checkpoint) => void restoreMediaBackup(checkpoint)} onDelete={(checkpoint) => void deleteMediaBackup(checkpoint)}/>}

    <ProfileDoctor languageSaving={languageSaving} onInterfaceLanguage={setInterfaceLanguage} open={showProfile} initialTab={settingsTab} llmSettings={llmSettings} profile={profile} doctor={doctor} doctorLoadState={doctorLoadState} doctorError={doctorError} busy={!!busy} currentContext={project ? contextPayload() : null}
      profileLoadFailed={startupErrors.includes('Preferences')} aiLoadFailed={startupErrors.includes('AI connection')} onRetryLoad={() => setStartupAttempt((value) => value + 1)}
      onClose={() => setShowProfile(false)} onSave={saveProfilePatch} onImport={importProfile} onRunDoctor={runDoctor} onApplyPack={applyTopicPack} onSaveLlm={saveLlmSettings} onTestLlm={api.testLlmConnection} onForgetLlm={forgetLlmKey} storageStatus={savedStorage.status} storageChecking={savedStorage.checking} storageError={savedStorage.error} onRecheckStorage={() => void savedStorage.recheck()}/>
    <FindReplacePanel key={mediaKey} open={showFindReplace} captions={draft} selectedIds={selection.ids} initialSearch={selection.captions.length === 1 ? selection.captions[0].text : ''} onClose={() => setShowFindReplace(false)} onApply={(next, message) => { updateDraft(next, undefined, 'text'); setNotice(message); }} onRemember={rememberReplacement}/>
    <HistoryPanel open={showHistory} entries={historyEntries} busy={!!busy} loadState={historyLoadState} onClose={closeHistory} onRefresh={() => void loadHistory()} onRestore={(id) => void restoreHistory(id)}/>
    <UpdatePanel open={showUpdates} safety={{ dirty: unfinishedChanges, textEditing, reviewMode, proposalOpen: Boolean(proposal), busy: Boolean(busy), activeJobs: activeJobs.length }} onClose={() => setShowUpdates(false)} onError={setError} onNotice={setNotice}/>
    <NewUserGuide
      open={showGuide}
      project={project}
      llmConfigured={llmSettings?.configured}
      timingConfigured={health?.timing.configured}
      generationPending={generationPending}
      hasCaptions={draft.length > 0}
      issueCount={riskyIds.length}
      onClose={() => setShowGuide(false)}
      onConnect={() => { setShowGuide(false); openSettings('ai'); }}
      onOpenDoctor={() => { setShowGuide(false); openSettings('doctor'); window.setTimeout(() => void runDoctor(), 0); }}
      onGenerate={() => { setShowGuide(false); void generate(); }}
      onReview={() => openWorkspaceFromGuide('review')}
      onContext={() => openWorkspaceFromGuide('accuracy')}
      onExport={() => openWorkspaceFromGuide('export')}
    />
    {confirmationDialog}
  </>;

  const recoveryRestoreBlockedReason = textComposing ? 'Finish entering your current text before restoring this draft.'
    : currentProjectAnyActiveJob ? 'Wait for the current project task to finish before restoring this draft.'
    : mediaMutationStatus ? 'Wait for the media change to finish before restoring this draft.'
    : busy ? 'Wait for the current action to finish before restoring this draft.'
    : unfinishedChanges ? 'Save your current edits before restoring this draft.' : '';

  const statusToasts = pendingMediaReplacement || showMediaBackups ? null : <ToastStack onLayoutChange={handleToastLayoutChange}>
    {projectBin.notice && <div className="toast error" role="alert"><span>{projectBin.notice.message}</span>
      {projectBin.notice.reviewStorage && <button className="toast-action" onClick={() => openSettings('doctor')}>Review storage</button>}
      <button aria-label="Dismiss project notice" onClick={projectBin.dismissNotice}><X size={14}/></button>
    </div>}
    {latestProjectUndo && [latestProjectUndo].map((move) => <div key={move.instanceId} className="toast notice" role="status" data-toast-timer="project-undo">
      <span>Moved “{move.title}” to Recently deleted.</span>
      {canRestore(move.restoreUntil) && <button className="toast-action" disabled={Boolean(projectBin.pendingId)}
        onClick={() => void undoProjectMove(move)}>Undo</button>}
      <button aria-label="Dismiss move notice" onClick={() => projectBin.dismissUndo(move.instanceId)}><X size={14}/></button>
    </div>)}
    {savedStorage.errorNotice && <div className="toast notice" role="status"><span>{savedStorage.errorNotice}</span><button className="toast-action" disabled={savedStorage.checking} onClick={() => void savedStorage.recheck()}>Retry storage check</button><button aria-label="Dismiss storage check notice" onClick={savedStorage.dismissError}><X size={14}/></button></div>}
    {storageNeedsAttention(savedStorage.status) && !storageNoticeDismissed && <div className="toast notice" role="status"><span>Some saved projects or their index need attention. Existing files were kept.</span><button className="toast-action" onClick={() => openSettings('doctor')}>Review storage</button><button aria-label="Dismiss project storage warning" onClick={() => setStorageNoticeDismissed(true)}><X size={14}/></button></div>}
    {busy && <div className="toast"><LoaderCircle className="spin" size={16}/><span>{busy}</span></div>}
    {currentProjectToastJob && !showJobs && <button className="job-toast" aria-label={`Open Activity: ${currentProjectToastJob.message}`} onClick={() => setShowJobs(true, currentProjectToastJob.id)}><LoaderCircle className="spin" size={15}/><div><strong>{currentProjectToastJob.message}</strong><span>{currentProjectToastJob.progress}%</span></div></button>}
    {uncertainJob && !showJobs && <div className="toast error" role="alert">
      <span>Studio lost the reply for {uncertainJob.title}. Check Activity before starting another job.</span>
      <button className="toast-action" onClick={() => openActivityFromNotice()}>Open Activity</button>
      <button aria-label="Dismiss job notice" onClick={() => setUncertainJobs((items) => items.map((item) => item === uncertainJob ? { ...item, dismissed: true } : item))}><X size={14}/></button>
    </div>}
    {error && <div className="toast error" role="alert"><span>{error}</span><button aria-label={t('common.toast.dismissError')} onClick={() => setError('')}><X size={14}/></button></div>}
    {jobNotification && !showJobs && <div className={`toast processing-notice ${jobNotification.error ? 'error' : 'notice'}`} role={jobNotification.error ? 'alert' : 'status'}>
      <span><strong>{jobNotification.projectTitle}.</strong> {jobNotification.message}</span>
      <button className="toast-action" onClick={() => { openActivityFromNotice(jobNotification.id); dismissJobNotification(); }}>Open Activity</button>
      <button aria-label="Dismiss processing notice" onClick={dismissJobNotification}><X size={14}/></button>
    </div>}
    {saveFailed && unfinishedChanges && !showJobs && !showCorrections && <div className="toast error save-failure" role="alert"><span><strong>{saveNeedsComparison ? 'Saved project changed.' : "Couldn't save changes."}</strong> {saveFailure} Your edits are still here.</span>{saveNeedsComparison
      ? <button className="toast-action" disabled={!!busy || textComposing} onClick={() => void reloadSavedProject()}>Reload saved project</button>
      : <button className="toast-action" disabled={!!busy || textComposing} onClick={() => void saveUnfinishedChanges(false)}>Retry save</button>}<button className="toast-action" onClick={downloadCurrentDraft}>Download edits</button></div>}
    {recoveryStorageError && unfinishedChanges && <div className="toast error recovery-storage-error" role="status"><span>{recoveryStorageError}</span>{!saveFailed && <button className="toast-action" onClick={downloadCurrentDraft}>Download edits</button>}</div>}
    {project && selectedRecovery && <UnfinishedEditRecoveryNotice
      count={recoveryEntries.length} savedAt={selectedRecovery.draft.savedAt}
      entries={recoveryEntries.map((entry) => ({ key: entry.key, savedAt: entry.draft.savedAt,
        label: [entry.draft.captions && 'Captions', entry.draft.accuracy && 'Accuracy', entry.draft.appearance && 'Appearance'].filter(Boolean).join(' + ') }))}
      selectedKey={selectedRecovery.key}
      onSelect={(key) => { cancelUnfinishedRecovery(); setRecoveryConflict(null); setSelectedRecoveryKey(key); }}
      captions={selectedRecovery.draft.captions} accuracy={selectedRecovery.draft.accuracy} appearance={selectedRecovery.draft.appearance}
      status={recoveryConflict?.key === selectedRecovery.key && recoveryConflict.raw === selectedRecovery.raw ? recoveryConflict.status : assessRecovery(selectedRecovery, savedProject.current || project)}
      working={recoveryWorking} disabled={unfinishedChanges || textComposing || !!busy || !!currentProjectAnyActiveJob || !!mediaMutationStatus}
      restoreBlockedReason={recoveryRestoreBlockedReason}
      onRestore={() => void restoreUnfinishedDraft(selectedRecovery)}
      onCancel={() => cancelUnfinishedRecovery(true)}
      onDownload={() => downloadUnfinishedDraft(selectedRecovery)}
      onDiscard={() => void discardUnfinishedDraft(selectedRecovery)}/>}
    {mediaUndoNotice?.key === mediaKey && <div className="toast notice replacement-edit-recovery" role="status"><span>Previous media and project saved for recovery.</span><button className="toast-action" disabled={Boolean(busy || mediaMutationStatus)} onClick={openMediaBackups}>Undo replacement</button><button aria-label="Dismiss replacement recovery" onClick={() => setMediaUndoNotice(null)}><X size={14}/></button></div>}
    {replacementEditRecoveries.map((recovery) => <div key={recovery.id} className="toast notice replacement-edit-recovery" role="status"><span>Edits to <b>{recovery.sourceMedia.originalName}</b> belong to the previous media and were not applied here.</span><button className="toast-action" onClick={() => void copyReplacementEdits(recovery)}>Copy recovery</button><button aria-label={`Dismiss recovery for ${recovery.sourceMedia.originalName}`} onClick={() => setReplacementEditRecoveries((current) => current.filter((item) => item.id !== recovery.id))}><X size={14}/></button></div>)}
    {reviewUndo && <div className="toast notice review-undo-toast" data-toast-timer="review-undo"><span>{reviewUndo.message}</span><button className="toast-action" onClick={undoReviewApproval}>{t('review.undo.action')}</button><button aria-label={t('review.undo.dismiss')} onClick={() => setReviewUndo(null)}><X size={14}/></button></div>}
    {notice && <div className="toast notice" role="status" data-toast-timer="notice"><span>{notice}</span><button aria-label={t('common.toast.dismissNotice')} onClick={() => setNotice('')}><X size={14}/></button></div>}
  </ToastStack>;

  const startupServiceMessages: Partial<Record<string, MessageKey>> = {
    Projects: 'home.launcher.projectsService',
    Preferences: 'home.launcher.preferencesService',
    'System status': 'home.launcher.systemService',
    'AI connection': 'home.launcher.aiService',
    Activity: 'home.launcher.activityService',
  };
  const visibleStartupErrors = showAllProjects ? startupErrors.filter((label) => label !== 'Projects') : startupErrors;
  if (!project) return <LocaleProvider locale={interfaceLanguage}><main className={showAllProjects ? 'project-library-page' : undefined}
    onPointerDownCapture={releaseLibraryReturn} onKeyDownCapture={releaseLibraryReturn} onWheelCapture={releaseLibraryReturn}>
    <div className="home-tools">
      {!showAllProjects && <button ref={homeProjectsButton} disabled={!!busy} onClick={() => changeProjectListView(true)}><FolderOpen size={16}/>{t('home.launcher.allProjects')}</button>}
      <button onClick={() => setShowGuide(true)} data-tooltip={t('home.launcher.guideTip')}><HelpCircle size={16}/>{t('home.launcher.guide')}</button>
      {jobs.length > 0 && <button onClick={() => setShowJobs(true)}><ListTodo size={16}/>{t('home.launcher.activityService')}{activeJobs.length > 0 && <b>{activeJobs.length}</b>}</button>}
      {Boolean(profile?.correctionEvents.length) && <button onClick={() => setShowCorrections(true)}><BookOpenCheck size={16}/>{t('home.launcher.correctionInbox')}{pendingCorrections > 0 && <b>{pendingCorrections}</b>}</button>}
      <button onClick={() => setShowUpdates(true)} data-tooltip={t('home.launcher.updatesTip')}><RefreshCw size={16}/>{t('home.launcher.updates')}</button>
      <button className={llmSettings?.configured === false ? 'setup-needed' : ''} data-tooltip={t('home.launcher.settingsTip')} onClick={() => openSettings('ai')}><Settings2 size={16}/>{t('home.launcher.settings')}{llmSettings && <span className={`connection-dot ${llmSettings.configured ? 'ready' : 'missing'}`}/>}</button>
      {!showAllProjects && <InterfaceLanguageSwitch saving={languageSaving} ready={Boolean(profile)} onChange={setInterfaceLanguage}/>}
    </div>
    <div hidden={showAllProjects} inert={showAllProjects || undefined}>
      <Upload onUpload={upload} onCheckAttempt={checkUploadAttempt} onOpenRecovered={openRecentProject} busy={busy === 'Uploading…'} disabled={!!busy || !profile}
        disabledReason={!profile ? startupErrors.includes('Preferences') ? t('home.launcher.preferencesFailed') : t('home.launcher.loadingPreferencesForUpload')
          : busy && busy !== 'Uploading…' ? t('home.launcher.uploadBusy') : ''}
        beforeDropzone={<>
          {profile && savedLanguage === undefined && !showAllProjects && <InterfaceLanguagePrompt saving={languageSaving} onChange={setInterfaceLanguage}/>}
          {showFirstRun ? <HomeSetupChecklist llmSettings={llmSettings} timingConfigured={health?.timing.configured} onSaveLlm={saveLlmSettings} onTestLlm={api.testLlmConnection} onCheckTiming={() => refreshSystemHealth()} onOpenDoctor={() => { openSettings('doctor'); window.setTimeout(() => void runDoctor(), 0); }} onDismiss={() => { setShowFirstRun(false); try { localStorage.setItem(FIRST_RUN_DISMISSED_KEY, '1'); } catch { /* optional */ } }}/> : llmSettings?.configured === false ? <button className="home-ai-setup" onClick={() => openSettings('ai')}><KeyRound size={16} aria-hidden="true"/>{t('home.launcher.setupAi')}</button> : undefined}
        </>}/>
    </div>
    {health && !timingConfigured && !showAllProjects && !showFirstRun && <div className="setup-warning"><TriangleAlert size={16}/><span>{t('home.launcher.timingWarning')}</span><button onClick={() => { openSettings('doctor'); void runDoctor(); }}>{t('home.launcher.systemCheck')}</button></div>}
    {visibleStartupErrors.length > 0 && <div className="setup-warning" role="status"><span>{t('home.launcher.startupFailed', { services: visibleStartupErrors.map((label) => translate(interfaceLanguage, startupServiceMessages[label] ?? 'home.launcher.startupService', { service: label })).join(', ') })}</span><button onClick={() => setStartupAttempt((value) => value + 1)}>{t('home.launcher.retryStartup')}</button></div>}
    {showAllProjects && !profile && !startupErrors.includes('Preferences') && <div className="setup-warning" role="status">{t('home.launcher.loadingPreferences')}</div>}
    {showAllProjects ? <ProjectLibrary
      focusHeadingOnMount={!libraryOrigin.current} projects={projects} view={projectLibraryView} onViewChange={setProjectLibraryView}
      loading={!startupLoaded.current.has('Projects') && !startupErrors.includes('Projects')}
      loadFailed={startupErrors.includes('Projects')} disabled={!!busy || !profile}
      refreshing={projectListState.refreshing} refreshError={projectListState.error} refresh={() => void refreshProjects()}
      openingProjectId={openingProjectId} onOpen={(id) => void openRecentProject(id)}
      onBack={() => changeProjectListView(false)} onCreate={() => changeProjectListView(false, 'upload')} onRetry={() => setStartupAttempt((value) => value + 1)}
      storageUnavailable={!savedStorage.status || savedStorage.checking || Boolean(savedStorage.error) || storageNeedsAttention(savedStorage.status)}
      onReviewStorage={() => openSettings('doctor')}
      bin={projectBin} showBin={showProjectBin} onShowBin={setShowProjectBin} onRename={renameProject} confirm={confirmInStudio}
    /> : projects.length > 0 && <section className="recent" aria-label={t('home.launcher.recentProjects')}><div><strong>{t('home.launcher.recentProjects')}</strong></div><div>{projects.slice(0, 6).map((item) => <button key={item.id} data-recent-project={item.id} disabled={!!busy || !profile || projectBin.pendingId === item.id} aria-busy={openingProjectId === item.id} onClick={() => void openRecentProject(item.id)}><span>{item.title}</span><small>{openingProjectId === item.id ? t('home.launcher.opening') : item.captionCount ? t('home.launcher.projectCaptions', { count: item.captionCount }) : t('home.launcher.notGenerated')}</small></button>)}</div></section>}
    {!showAllProjects && startupLoaded.current.has('Projects') && projectListState.error && <div className="setup-warning" role="status"><span>{t('home.launcher.showingLastProjects', { error: projectListState.error })}</span><button aria-disabled={projectListState.refreshing || undefined} aria-busy={projectListState.refreshing || undefined} onClick={() => void refreshProjects()}>{t('home.launcher.refreshProjects')}</button></div>}
    {statusToasts}
    {activity}
    {corrections}
    {overlays}
  </main></LocaleProvider>;

  return <LocaleProvider locale={interfaceLanguage}><main className={`workspace refined-workspace ${proposal ? 'has-caption-proposal' : ''} ${toastLayout.hasContent ? 'has-toasts' : ''} ${toastLayout.hasPersistentRecovery ? 'has-persistent-recovery' : ''} ${toastLayout.hasSaveFailure ? 'has-save-failure' : ''}`} onCompositionStartCapture={() => { compositionInProgress.current = true; setTextComposing(true); }} onCompositionEndCapture={() => { compositionInProgress.current = false; setTextComposing(false); }}>
    <header>
      <button className="back" aria-label={t('editor.header.back')} data-tooltip={t('editor.header.back')} disabled={Boolean(wordBatchMutation.current || mediaMutationStatus)} onClick={goHome}><ChevronLeft size={18}/></button>
      <div className="workspace-identity"><StudioBrand variant="compact" moduleLabel={t('editor.header.captions')} moduleDescriptor=""/><span className="workspace-divider"/><ProjectIdentity key={project.id} title={project.title} filename={project.media.originalName} status={project.transcriptNeedsSync ? t('editor.header.regroupingNeedsRefresh', { status: projectSaveStatus }) : projectSaveStatus}
        onRename={(title, expectedTitle) => renameProject(project.id, title, expectedTitle, true)}/></div>
      <input ref={replaceInput} hidden type="file" accept="video/*,audio/*" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; replaceMedia(file); }}/>
      <div className="header-actions">
        <nav className="stage-rail" aria-label={t('editor.header.stages')}>
          <button type="button" data-stage="captions" aria-pressed={stage === 'captions'} disabled={Boolean(proposal)} onClick={() => selectStage('captions')}><Captions size={16}/><span>{t('editor.header.captions')}</span></button>
          <button type="button" data-stage="review" data-tooltip={t('editor.header.reviewTip')} aria-pressed={stage === 'review'} disabled={!draft.length && !reviewMode} onClick={() => selectStage('review')}><ListChecks size={16}/><span>{t('editor.header.review')}</span>{riskyIds.length > 0 && <b className="tool-badge">{riskyIds.length}</b>}</button>
          {isVideo && <button type="button" data-stage="appearance" aria-pressed={stage === 'appearance'} disabled={!draft.length || Boolean(proposal)} onClick={() => selectStage('appearance')}><Palette size={16}/><span>{t('editor.header.appearance')}</span></button>}
          <button type="button" className="primary" data-stage="export" data-workspace-trigger="export" data-tooltip={t('editor.header.exportTip')} aria-pressed={stage === 'export'} disabled={!draft.length || !!busy} onClick={() => selectStage('export')}><FileOutput size={16}/><span>{t('editor.header.export')}</span></button>
        </nav>
        <WorkspaceToolsMenu
          activeJobs={activeJobs.length}
          pendingCorrections={pendingCorrections}
          llmConfigured={Boolean(llmSettings?.configured)}
          replaceDisabled={Boolean(currentProjectAnyActiveJob || busy)}
          technicalDetailsAvailable={hasHybrid}
          onTechnicalDetails={() => chooseWorkspaceTool('details')}
          onArrangePanels={(anchor) => editorLayout.current?.openArrangement(anchor)}
          onGuide={() => setShowGuide(true)}
          onCorrect={() => setShowFindReplace(true)}
          onHistory={() => void openHistory()}
          onJobs={() => setShowJobs(true)}
          onCorrections={() => setShowCorrections(true)}
          onReplace={() => replaceInput.current?.click()}
          onUndoMedia={openMediaBackups}
          onSettings={() => openSettings('ai')}
          onUpdates={() => setShowUpdates(true)}
        />
        <ManualSaveButton unfinished={unfinishedChanges} confirmed={manualSaveFeedback.confirmed} pending={manualSaveFeedback.pending} disabled={!unfinishedChanges || !!busy || textComposing || saveNeedsComparison} title={saveNeedsComparison ? t('editor.header.compareSaved') : unfinishedChanges ? t('editor.header.saveChanges') : t('editor.header.allSaved')} onSave={() => void manualSaveFeedback.run(() => saveUnfinishedChanges(false))}/>
      </div>
    </header>

    {alignmentNoticeKey && dismissedAlignmentNotice !== alignmentNoticeKey && <div className="media-alignment-notice" role="note"><TriangleAlert size={16}/><span>{messagesFor(interfaceLanguage).tr('export.repair.alignmentNotice', {}, { b: (text) => <strong>{text}</strong> })}</span><button type="button" aria-label={t('export.repair.dismissAlignmentLabel')} title={t('export.repair.dismissAlignment')} onClick={() => setDismissedAlignmentNotice(alignmentNoticeKey)}><X size={16}/></button></div>}

    <EditorLayout
      tool={proposal ? 'proposal' : workspaceTool}
      title={proposal ? 'Compare captions' : workspaceTool ? ({ review: t('editor.header.review'), timeline: 'Fine timing', accuracy: 'Accuracy', rhythm: 'Caption grouping', appearance: 'Appearance', details: 'Technical details', export: 'Export' })[workspaceTool] : exportRepair ? 'Export review' : t('editor.generation.generate')}
      open={Boolean(proposal || workspaceTool || !hasHybrid || exportRepair && projectScope.current.isCurrent(exportRepair.ticket))}
      onClose={proposal ? () => { closeComparison(); setNotice('Comparison closed. You can reopen it from Activity.'); } : workspaceTool ? () => chooseWorkspaceTool(workspaceTool) : exportRepair ? () => setExportRepair(null) : undefined}
      getCloseFocusTarget={proposal ? () => null : workspaceTool === 'accuracy' ? getAccuracyCloseFocusTarget : undefined}
      ref={editorLayout}
      mode={layoutMode}
      enlargeAvailable={enlargeAvailable}
      arrangeSupported={arrangeSupported}
      preview={
        <div ref={mediaPreviewFocus} className="media-stage" data-media-preview-focus tabIndex={-1} role="region" aria-label="Media preview">
          <SourceMedia key={`source:${mediaKey}`} src={project.media.url} projectId={project.id} source={project.media.filename} video={isVideo} playbackRate={playbackRate} media={media} recoveryFocusTarget={mediaPreviewFocus} onElementChange={setMediaElement}
            onLoadedMetadata={onLoadedMetadata} onTimeUpdate={onMediaTimeUpdate}
            onRetry={() => { setProposal(null); correctionPlayback.current = null; setProposalLoop(false); setReviewMode(false); }}/>
          {isVideo && <NativeCaptionPreview ref={nativeCaptionPreview} onChooseFont={proposal ? undefined : (trigger) => {
            cancelPlayback(); media.current?.pause(); setReviewMode(false);
            setFontFocusTrigger(trigger); setWorkspaceTool('appearance');
          }} fontRevision={captionFontRevision} key={`captions:${mediaKey}`} project={project} media={media} recoveryFocusTarget={mediaPreviewFocus} mediaElement={mediaElement} captions={videoCaptions} appearance={previewAppearance} interacting={appearanceInteracting} resolution={previewResolution} timeMs={time * 1000} reviewFocus={reviewFocusActive} focusLabel={reviewFocusMode === 'brackets-label'} focusKey={reviewFocusKey} focusIndices={reviewFocusIndices}/>}
          {firstWatch && firstWatch.projectId === project.id && firstWatch.mediaKey === mediaKey && stage === 'captions' && !proposal && isVideo && (
            <div className="first-watch" role="group" aria-label={t('editor.firstWatch.label')} onKeyDown={(event) => {
              // Plain Escape only, matching the app's other dismiss handlers.
              if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229
                || event.getModifierState('AltGraph') || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
              event.preventDefault();
              event.stopPropagation();
              setFirstWatch(null);
            }}>
              <button type="button" className="first-watch-play" onClick={() => {
                cancelPlayback();
                setFirstWatch(null);
                const element = media.current;
                if (!element) return;
                element.currentTime = 0;
                void element.play().catch(() => setError(t('editor.firstWatch.playFailed')));
              }}><Play size={18} aria-hidden="true"/><span>{t('editor.firstWatch.watch')}</span></button>
              <p>{riskyIds.length ? tn('editor.firstWatch.flagged', riskyIds.length) : t('editor.firstWatch.clear')}</p>
              <button type="button" className="first-watch-dismiss" onClick={() => setFirstWatch(null)}>{t('editor.firstWatch.dismiss')}</button>
            </div>
          )}
          {isVideo && proposal && <div className={`preview-version-badge ${proposalPreviewMode}`}><span>{proposalPreviewMode === 'proposed' ? 'Proposed' : 'Current captions'}</span></div>}
        </div>
      }
      toolbar={!proposal && stage === 'captions' ? (
        <div className="workspace-tool-strip">
            {(!showGeneration || draft.length > 0) && <nav aria-label="Caption workspace tools">
              {draft.length > 0 && <button className={workspaceTool === 'timeline' ? 'active' : ''} aria-pressed={workspaceTool === 'timeline'} onClick={() => chooseWorkspaceTool('timeline')}><AudioLines size={16}/><span>Fine timing</span></button>}
              {!showGeneration && <button className={workspaceTool === 'accuracy' ? 'active' : ''} aria-pressed={workspaceTool === 'accuracy'} onClick={toggleAccuracyToolbar}><BookOpenText size={16}/><span>Accuracy</span></button>}
              {hasHybrid && <button className={workspaceTool === 'rhythm' ? 'active' : ''} aria-pressed={workspaceTool === 'rhythm'} onClick={() => chooseWorkspaceTool('rhythm')}><Group size={16}/><span>Caption grouping</span></button>}
            </nav>}
          </div>
      ) : null}
      captions={
        <CaptionEditor ref={editor} captions={draft} durationMs={mediaDurationMs} highlightEnabled={previewAppearance.highlightMode === 'word'} onWordTiming={openWordTiming} onNotice={setNotice}
        active={active?.id || null} playheadMs={time * 1000} selectedIds={selection.ids} issues={issues} reviewMode={reviewMode} onChange={updateDraft} onSeek={seek} onSelect={selectCaption} onTextCommit={() => void saveDraft(true, 'text-edit', true)} onEditCommit={() => { if (reviewMode && selection.captions.length) schedulePlayback(replaySelection); }} onReviewComplete={() => { cancelPlayback(); media.current?.pause(); }} onEditingChange={setTextEditing}/>
      }
    >
        {proposal && <RegenerationReviewDock
          proposal={proposal}
          busy={!!busy}
          previewMode={proposalPreviewMode}
          loop={proposalLoop}
          editedText={proposalEditedText}
          accuracyHint={proposalAccuracyHint}
          refinementJob={refinementJob}
          onPreviewMode={setProposalPreviewMode}
          onLoop={setProposalLoop}
          onReplay={replayProposal}
          onSeek={seek}
          onEditedText={(value) => { proposalViewRevision.current += 1; setProposalEditedText(value); }}
          onAccuracyHint={(value) => { proposalViewRevision.current += 1; setProposalAccuracyHint(value); }}
          onApply={(mode, editedText) => void applyProposal(mode, editedText)}
          onRefine={(input) => void refineProposal(input)}
        />}

        {!proposal && <>
          {exportRepair && projectScope.current.isCurrent(exportRepair.ticket) && workspaceTool !== 'export' && <section className="export-repair-return" aria-label={t('export.repair.label')}>
            <div><strong id="export-repair-title" tabIndex={-1}>{exportRepair.target.captionId && draft.some((caption) => caption.id === exportRepair.target.captionId)
              ? t('export.repair.fixCaption', { position: draft.findIndex((caption) => caption.id === exportRepair.target.captionId) + 1 }) : t('export.repair.fixIssue')}</strong>
              <p>{t('export.repair.instructions')}</p></div>
            <div><button type="button" onClick={backToExport}>{t('export.repair.back')}</button>
              <button type="button" onClick={() => setExportRepair(null)}>{t('export.repair.finish')}</button></div>
          </section>}


          {workspaceTool === 'export' && <ExportWorkspace key={mediaKey}
            appearanceReconciliation={reconciledAppearance}
            profileImportRevision={profileImportRevision}
            onPreviewResolution={setPreviewResolution}
            onConfirm={confirmInStudio}
            project={{ ...project, captions: draft }}
            session={exportSession}
            sessionStorageError={exportChoiceStorageError}
            onSessionChange={changeExportSession}
            onRepair={repairExportIssue}
            reviewIssues={issues}
            unsaved={dirty}
            saveBlocked={saveConflict}
            fontRevision={captionFontRevision}
            busy={Boolean(busy) || captionHandoffWorking}
            activeExportJob={activeExportJob}
            onExportCaptions={exportCaptionFile}
            onImportCaptionData={previewCaptionImport}
            importBlockedReason={currentProjectActiveJob ? 'Wait for caption processing to finish before replacing captions.' : ''}
            captionImportPreview={pendingCaptionImport && projectScope.current.isCurrent(pendingCaptionImport.ticket) ? {
              filename: pendingCaptionImport.filename, preview: pendingCaptionImport.preview, currentCount: draft.length,
              stale: dirty || pendingCaptionImport.editRevision !== draftEditRevision.current
                || pendingCaptionImport.captionSnapshot !== JSON.stringify(draftRef.current),
            } : undefined}
            onApplyCaptionImport={() => void applyCaptionImport()}
            onCancelCaptionImport={() => setPendingCaptionImport(null)}
            onEditAppearance={() => repairExportIssue({ kind: 'appearance' })}
            onEditWordTiming={(id) => repairExportIssue({ kind: 'word-timing', captionId: id })}
            onStartVideoExport={startVideoExport}
          />}

          {workspaceTool === 'appearance' && isVideo && draft.length > 0 && <CaptionAppearanceWorkspace key={mediaKey} project={project} captions={draft}
            onHighlightControlReady={wordControlEntry?.tool === 'appearance' ? focusWordControl : undefined}
            fontFocusTrigger={fontFocusTrigger} onFontFocusHandled={() => setFontFocusTrigger(null)}
            onExportFontReady={exportFontFocus?.ticket === viewTicket ? (target) => {
              projectNavigationFocus.complete(exportFontFocus.request, () => target);
              setExportFontFocus(null);
            } : undefined}
            initialAppearance={previewAppearance}
            profileImportRevision={profileImportRevision}
            flushSave={flushAppearanceSave}
            onEditWordTiming={openWordTiming}
            wordPreparation={wordPreparation}
            onReplayEffect={replayAppearanceEffect}
            onCancelReplayEffect={stopEffectReplay}
            replayPlaying={effectReplayPlaying}
            onFontLibraryChange={changeCaptionFontLibrary}
            sampleCaptionText={(selection.captions[0] || active || draft[0])?.text}
            onAppearanceChange={changeAppearance} onInteractionChange={setAppearanceInteracting} onConfirm={confirmInStudio}/>}

          {workspaceTool === 'timeline' && draft.length > 0 && <WaveformEditor key={mediaKey}
            projectId={project.id}
            mediaIdentity={mediaKey}
            mediaDurationMs={mediaDurationMs}
            captions={draft}
            tokens={project.transcript?.tokens || []}
            selectedIds={selection.ids}
            playheadMs={time * 1000}
            playbackRate={playbackRate}
            initialMode={profile?.preferences.waveformMode || 'waveform'}
            initialZoom={profile?.preferences.waveformZoom || 2}
            editMode={requestedTimingMode}
            onEditModeChange={setRequestedTimingMode}
            wordTimingFocus={wordTimingFocus}
            onTimingControlReady={wordControlEntry?.tool === 'timeline' && wordControlEntry.captionId === selection.ids[0] ? focusWordControl : undefined}
            onSeek={seek}
            onSelect={(id) => { selectCaption(id, false); editor.current?.revealCaption(id); }}
            onTimingChange={(before, after, guards, gestureBasis) => {
              if (!projectScope.current.isCurrent(viewTicket) || !before.length || before.length !== after.length
                || new Set(before.map((caption) => caption.id)).size !== before.length
                || (guards && !timingTransactionMatches(draftRef.current, { before, after, guards }))) return false;
              // A saved result may update the authoritative draft before the
              // timeline's next commit can retire its older pointer preview.
              if (gestureBasis && !captionTimingBasisMatches(draftRef.current, gestureBasis.captions, before)) return false;
              const nativeDuration = media.current?.duration;
              const currentDurationMs = nativeDuration && Number.isFinite(nativeDuration)
                ? Math.round(nativeDuration * 1000) : mediaDurationMs;
              if (gestureBasis && currentDurationMs && gestureBasis.durationMs > currentDurationMs) return false;
              for (let index = 0; index < before.length; index++) {
                const prior = before[index];
                const next = after[index];
                const current = draftRef.current.find((caption) => caption.id === prior.id);
                if (prior.id !== next.id || !sameTimingRevision(current, prior) || current?.timingLocked
                  || !Number.isFinite(next.startMs) || !Number.isFinite(next.endMs) || next.startMs < 0
                  || next.endMs - next.startMs < 40 || (mediaDurationMs && next.endMs > mediaDurationMs)) return false;
              }
              const replacements = new Map(after.map((caption) => [caption.id, caption]));
              updateDraft(draftRef.current.map((caption) => replacements.has(caption.id) ? { ...caption, ...timingFields(replacements.get(caption.id)!) } : caption), selection.ids[0] || before[0].id, 'timing');
              return true;
            }}
            onSyncWords={syncCaptionWords}
            onNextWordTimingIssue={highlighting && wordHighlightSummary.exceptions.some(({ id }) => id !== selection.ids[0])
              ? () => reviewRemainingWordHighlights(selection.ids[0]) : undefined}
            syncDisabled={Boolean(busy || currentProjectActiveJob || wordPreparation.running || !timingConfigured)}
            onOpenAppearance={isVideo ? () => {
              requestWordControl('appearance');
              cancelPlayback();
              setReviewMode(false);
              setWorkspaceTool('appearance');
            } : undefined}
            onEditCaptionText={() => { if (selection.ids[0]) editor.current?.focusCaption(selection.ids[0]); }}
            onWordPreview={(ownerId, change) => {
              if (change && projectScope.current.isCurrent(viewTicket) && timingTransactionMatches(draftRef.current, change)) {
                setWordTimingPreview({ mediaKey, ownerId, change });
              } else setWordTimingPreview((current) => current?.ownerId === ownerId ? null : current);
            }}
            onPreview={(range) => {
              cancelPlayback();
              if (media.current && projectScope.current.isCurrent(viewTicket)) {
                timingPreviewCancel.current = playTimingRange(media.current, range, () => setError('Playback could not start. Use the video controls to check the audio, then replay the caption.'));
              }
            }}
            onStopPreview={stopTimingPreview}
            onNotice={setNotice}
            onPlaybackRate={changePlaybackRate}
            onPreferenceChange={(value) => void saveWaveformPreference(value)}
          />}

          {workspaceTool === 'review' && !draft.length && <p className="muted-copy">{t('review.card.noCaptions')}</p>}
          {workspaceTool === 'review' && draft.length > 0 && <div className="review-card review-active">
            {!riskyIds.length && draft.length > 0 && <ReviewCompletion reviewed={reviewedFlags} exportDisabled={Boolean(busy)}
              onShowAll={() => {
                const returnTo = document.querySelector<HTMLButtonElement>('.stage-rail button[aria-pressed="true"]');
                chooseWorkspaceTool('review');
                requestAnimationFrame(() => returnTo?.focus({ preventScroll: true }));
              }}
              onExport={() => chooseWorkspaceTool('export')}/>}
            {riskyIds.length > 0 && <>
            <div className="review-card-head">
              <div className="review-score"><ListChecks size={22}/><strong>{tn('review.card.remaining', riskyIds.length)}</strong></div>
              <div className="review-selection">
                <b>{selection.captions.length ? t('review.card.selection', { number: draft.findIndex(({ id }) => id === selection.ids[0]) + 1, range: rangeLabel(selection.startMs, selection.endMs) }) : t('review.card.noSelection')}</b>
                {selection.captions.length > 1 && <span>{t('review.card.moreSelected', { count: selection.captions.length - 1 })}</span>}
              </div>
            </div>
            <div className="review-caption" role="group" aria-label={t('review.card.captionText')}>
              <p className={`review-caption-text${selection.captions[0]?.text ? '' : ' review-caption-empty'}`}>
                {selection.captions[0]?.text || (selection.captions.length ? t('review.card.emptyCaption') : t('review.card.selectCaption'))}
              </p>
              <button type="button" className="review-caption-edit" aria-keyshortcuts="E" onClick={() => selection.ids[0] && editor.current?.focusCaption(selection.ids[0])} disabled={!selection.ids.length}>
                <PencilLine size={15} aria-hidden="true"/>
                {t('review.card.editText')}
              </button>
            </div>
            {!!selectedReviewReasons?.length && <ul className="review-reasons" role="list" aria-label={t('review.card.reasons')}>{selectedReviewReasons.map(({ code, params }, index) => <li key={`${code}:${index}`}><strong>{t(`review.reason.${code}.label`, params)}</strong> <span>{t(`review.reason.${code}.hint`, params)}</span></li>)}</ul>}
            <div className="review-actions review-nav-actions">
              <button onClick={() => selectRisk(-1)} disabled={!riskyIds.length || riskyIds.findIndex((id) => selection.ids.includes(id)) <= 0}><ChevronUp size={15}/>{t('review.card.previous')}</button>
              <button onClick={replaySelection} disabled={!selection.captions.length}><Play size={15}/>{t('review.card.replay')}</button>
              <button onClick={() => selectRisk(1, profile?.preferences.autoPlayNextReview ?? true)} disabled={!riskyIds.length || riskyIds.findIndex((id) => selection.ids.includes(id)) === riskyIds.length - 1}><ChevronDown size={15}/>{t('review.card.skip')}</button>
              <label className="review-autoplay-toggle"><input type="checkbox" checked={profile?.preferences.autoPlayNextReview ?? true} onChange={(event) => void setAutoPlayNext(event.target.checked)}/>{t('review.card.autoPlayNext')}</label>
            </div>
            <div className="review-actions review-decision-actions">
              {!!project.transcript?.tokens?.length && project.transcript.timing && <button className="regenerate-range review-improve" onClick={regenerateSelection} disabled={!selection.captions.length || !!currentProjectActiveJob}><RotateCcw size={15}/>{t('review.card.improve')}</button>}
              <button className="review-approve-next primary" onKeyDown={(event) => { if (event.key === 'Enter' && event.repeat) event.preventDefault(); }} onClick={approveAndNext} disabled={!selection.ids.length}><CheckCheck size={15}/>{t('review.card.approveNext')}</button>
            </div>
            <details className="advanced-review-tools">
              <summary>{t('review.card.moreOptions')}</summary>
              <div className="qa-profile-control"><label>{t('review.card.profile')}<select value={profile?.preferences.qaProfileId || 'khmer-tiktok-comfortable'} onChange={(event) => void setQaProfile(event.target.value as QaProfileId)}>{Object.keys(QA_PROFILES).map((id) => <option key={id} value={id}>{t(`review.profile.${id as Exclude<QaProfileId, 'custom'>}`)}</option>)}</select></label><span>{t('review.card.profileHelp')}</span></div>
              <div className="review-actions"><label><input type="checkbox" checked={profile?.preferences.autoLoopReview ?? true} onChange={(event) => void setAutoLoop(event.target.checked)}/>{t('review.card.tightLoop')}</label><button onClick={replaySelectionWithContext} disabled={!selection.captions.length} title={t('review.card.contextTip')}><Play size={15}/>{t('review.card.playWithContext')}</button><label htmlFor="review-focus-mode-select" className="review-focus-mode-control"><span>{t('review.card.focus')}</span><select id="review-focus-mode-select" aria-label={t('review.card.focus')} value={reviewFocusMode} onChange={(event) => void setReviewFocusMode(event.target.value as 'brackets-label' | 'brackets' | 'off')}><option value="brackets-label">{t('review.card.bracketsLabel')}</option><option value="brackets">{t('review.card.brackets')}</option><option value="off">{t('review.card.off')}</option></select></label><button onClick={() => patchSelected({ textLocked: true }, t('review.card.lockedText'))} disabled={!selection.ids.length}><LockKeyhole size={15}/>{t('review.card.lockText')}</button><button onClick={() => patchSelected({ timingLocked: true }, t('review.card.lockedTiming'))} disabled={!selection.ids.length}><Clock3 size={15}/>{t('review.card.lockTiming')}</button><button onClick={() => patchSelected({ textLocked: false, timingLocked: false }, t('review.card.unlocked'))} disabled={!selection.ids.length}>{t('review.card.unlock')}</button><button onClick={runTimingPostprocessor} disabled={!!busy}>{t('review.card.fixTiming')}</button><button onClick={() => { cancelPlayback(); setReviewMode(false); setWorkspaceTool(null); }}>{t('review.card.showAll')}</button></div>
              <div className="shortcut-strip"><Keyboard size={14}/><span>{t('review.card.shortcuts')}</span></div>
            </details>
            </>}
          </div>}

          {workspaceTool === 'accuracy' && <div className="accuracy-card">
            <div className="control-title"><strong>Accuracy context <em>optional</em></strong><span id="accuracy-context-help">Help Studio recognize names, brands, versions, and Khmer-English speech.</span></div>
            <div className="context-field">
              <span><label htmlFor="accuracy-context-description">What is this video about?</label></span>
              <textarea id="accuracy-context-description" aria-describedby="accuracy-context-help" rows={3} value={contextDescription} onChange={(event) => editAccuracyFields({ description: event.target.value })} placeholder="Example: A weekend street-food and café review in Phnom Penh, trying iced coffee and grilled pork rice."/>
            </div>
            <div className="context-field">
              <span><label htmlFor="accuracy-context-vocabulary">Key terms</label> <b aria-hidden="true">{vocabularyLines.length}</b><span id="accuracy-vocabulary-count" hidden>{vocabularyLines.length} terms</span></span>
              <textarea id="accuracy-context-vocabulary" aria-describedby={`accuracy-vocabulary-count accuracy-vocabulary-help${globalGlossaryMessage ? ' accuracy-global-glossary-feedback' : ''}`} rows={5} value={vocabularyText} onChange={(event) => editAccuracyFields({ vocabulary: event.target.value })} placeholder={'CapCut | ខេបខាត់\nTikTok | តិកតុក\nបាយសាច់ជ្រូក\nសៀមរាប'}/>
            </div>
            {hasHybrid && generationOptions}
            <div className="accuracy-help"><span id="accuracy-vocabulary-help">One term per line. Aliases use <code>Canonical | alias | phonetic alias</code>.</span><div className="accuracy-actions"><button aria-disabled={!!busy || globalGlossarySaving || undefined} aria-busy={globalGlossarySaving || undefined} onClick={() => void saveDefaultGlossary()}>{globalGlossarySaving ? 'Saving to all projects…' : 'Save to all projects'}</button><button disabled={!!busy || textComposing || saveConflict} onClick={() => void saveContext()}><Save size={15}/>Save for this project</button>{hasHybrid && <button className="context-regenerate" disabled={generationPending || checkingGenerationSetup} onClick={() => void generate()}><RefreshCw size={15}/>{generationSetupMissing || generationSetupFailed || generationNeedsCheck ? generationLabel : 'Improve all captions'}</button>}</div>{globalGlossaryMessage && <p id="accuracy-global-glossary-feedback" className="profile-form-feedback" role={globalGlossaryFeedback.error ? 'alert' : 'status'}>{globalGlossaryMessage}</p>}</div>
          </div>}

          {showGeneration && <div className={`transcribe-card ${legacy ? 'legacy' : ''}`}>
            <Captions size={28} aria-hidden="true"/><div><strong>{generationSetupMissing ? t('editor.generation.finishSetup') : legacy ? t('editor.generation.rebuildTiming') : t('editor.generation.fromAudio')}</strong><span>{llmSettings?.configured === false ? t('editor.generation.connectHelp') : health?.timing.configured === false ? t('editor.generation.timingHelp') : legacy ? t('editor.generation.rebuildHelp') : t('editor.generation.createHelp')}</span></div>
            <button className="primary" disabled={generationPending || checkingGenerationSetup} onClick={() => void generate()}>{currentProjectActiveJob || generationPreparing ? <LoaderCircle className="spin" size={18}/> : llmSettings?.configured === false ? <KeyRound size={18}/> : <Captions size={18}/>} {t(generationLabelKey)}</button>
            <div className="generation-accuracy">
              <div className="generation-accuracy-copy">
                <BookOpenText size={18} aria-hidden="true"/>
                <div>
                  <strong>{t('editor.generation.context')} <small id="generation-accuracy-optional">{t('editor.generation.optional')}</small></strong>
                  <span id="generation-accuracy-help">{t('editor.generation.contextHelp')}</span>
                </div>
              </div>
              <button type="button" ref={generationAccuracyEntry} aria-describedby="generation-accuracy-optional generation-accuracy-help" onClick={() => {
                chooseWorkspaceTool('accuracy');
                accuracyDescriptionFocus.current = viewTicket;
                requestAnimationFrame(() => {
                  if (accuracyDescriptionFocus.current === viewTicket && projectScope.current.isCurrent(viewTicket)) {
                    document.getElementById('accuracy-context-description')?.focus();
                  }
                });
              }}>
                {hasSavedContext ? t('editor.generation.editContext') : t('editor.generation.addContext')} <ChevronRight size={14} aria-hidden="true"/>
              </button>
            </div>
            {generationOptions}
          </div>}

          {workspaceTool === 'details' && hasHybrid && <div className={`timing-card ${audioAlignmentUnverified ? 'retained-audio-evidence' : ''}`}>
            <div className="timing-card-title">{audioAlignmentUnverified ? <TriangleAlert size={18}/> : <CheckCircle2 size={18}/>}<div><strong>{audioAlignmentUnverified ? 'Previous audio timing evidence' : usedFallback ? 'Local Whisper fallback active' : 'KFA Khmer alignment active'}</strong><span>Text: {project.transcript?.textModel || health?.geminiModel}{project.transcript?.textModelFallback ? ' (fallback)' : ''} · Timing: {timing?.model}{timing?.device ? ` · ${timing.device}` : ''}</span>{Boolean(project.transcript?.vocabularyTerms?.length) && <span className="vocab-status">{project.transcript?.vocabularyTerms?.length} protected terms · native bias {project.transcript?.nativeVocabularyBias ? 'on' : project.transcript?.contextMode === 'audio-only' ? 'not applied' : 'prompt-only'}</span>}</div></div>
            {audioAlignmentUnverified && <div className="inline-warning"><TriangleAlert size={16}/><span>These measurements belong to the previous audio. Existing caption and word times were kept; check alignment against the edited audio.</span></div>}
            {project.transcript?.contextMode && project.transcript.contextMode !== 'full' && <div className="inline-warning"><TriangleAlert size={16}/><span>{compatibilityTranscriptionNotice(project)}</span></div>}
            {usedFallback && timing?.fallbackReason && <div className="inline-warning"><TriangleAlert size={16}/><span>KFA could not align {audioAlignmentUnverified ? 'the previous audio' : 'this clip'}, so Studio stayed local and used Whisper. {timing.fallbackReason}</span></div>}
            {project.transcriptNeedsSync && <div className="inline-warning"><TriangleAlert size={16}/><span>Text and canonical timing no longer fully match. Lock reviewed captions before regrouping.</span></div>}
            <div className="timing-metrics" aria-label={audioAlignmentUnverified ? 'Timing measurements from the previous audio' : undefined}><div><b>{Math.round((timing?.alignmentCoverage || 0) * 100)}%</b><span>anchored</span></div><div><b>{timing?.interpolatedTokens || 0}</b><span>interpolated</span></div><div><b>{timing?.lowConfidenceTokens || 0}</b><span>uncertain words</span></div><div><b>{Math.round((timing?.meanAlignmentScore || 0) * 100)}%</b><span>match score</span></div></div>
            {project.pipelineCache?.normalizedAudioCached && <div className="cache-strip"><CheckCircle2 size={14}/><span>Local checkpoints let interrupted jobs resume without repeating completed work.</span></div>}
          </div>}

          {workspaceTool === 'rhythm' && hasHybrid && <div className="controls-card">
            <div className="control-title"><strong>Caption grouping</strong><span>Change how captions are grouped without recalculating speech timing.</span></div>
            <div className="mode-grid">{modes.map((mode) => <button key={mode.id} className={groupingMode === mode.id ? 'selected' : ''}
              aria-pressed={groupingMode === mode.id} disabled={!!busy || groupingApplying} onClick={() => setGroupingMode(mode.id)}>
              <strong>{mode.label}</strong><span>{mode.desc}</span></button>)}</div>
            <label className="slider"><span>Target maximum characters <b>{maxChars}</b></span>
              <input type="range" min="6" max="44" value={maxChars} disabled={!!busy || groupingApplying || groupingMode === 'word'}
                aria-describedby="grouping-limit-help" onChange={(event) => setMaxChars(Number(event.target.value))}/></label>
            <p id="grouping-limit-help">{groupingMode === 'word' ? 'Word mode shows one timed token per caption.' : 'Characters per caption. Speech rhythm can override it.'}</p>
            <div className="preset-actions">
              <span>Current grouping: {modes.find((mode) => mode.id === project.mode)?.label || project.mode}. Locked captions stay as they are. History keeps the previous version.</span>
              <button className="primary" disabled={!!busy || groupingApplying || Boolean(currentProjectActiveJob)} onClick={() => void applyGrouping()}>
                {groupingApplying ? 'Applying grouping…' : 'Apply grouping'}</button>
              <button onClick={cleanKhmerSpacing} disabled={!!busy || groupingApplying}><Languages size={14}/>Clean Khmer spacing</button>
              <button onClick={() => void saveStyle()} disabled={!!busy || groupingApplying || groupingPresetSaving} aria-busy={groupingPresetSaving || undefined}>{groupingPresetSaving ? 'Saving grouping preset…' : 'Save grouping preset'}</button>
              {profile?.styles.length ? <button onClick={applyStyle} disabled={!!busy || groupingApplying || !!currentProjectActiveJob}>Apply saved grouping</button> : null}
            </div>
          </div>}
        </>}
    </EditorLayout>

    {statusToasts}
    {activity}
    {corrections}
    {overlays}
  </main></LocaleProvider>;
}
