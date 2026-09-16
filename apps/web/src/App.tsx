import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppProfile,
  CaptionAppearance,
  CaptionMode,
  CaptionProject,
  CaptionProjectSummary,
  CaptionSegment,
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
  BookOpenCheck,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Clock3,
  Download,
  HelpCircle,
  Info,
  KeyRound,
  Keyboard,
  Languages,
  ListTodo,
  LoaderCircle,
  LockKeyhole,
  Palette,
  Play,
  RotateCcw,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  TimerReset,
  TriangleAlert,
  WandSparkles,
  X,
} from 'lucide-react';
import { api, type HealthResponse, type LlmSettingsStatus, type SaveLlmSettingsInput } from './api';
import { Upload } from './components/Upload';
import { CaptionEditor, type CaptionEditorHandle, type DraftChangeReason } from './components/CaptionEditor';
import { CorrectionInbox } from './components/CorrectionInbox';
import { ProfileDoctor, type SettingsTab } from './components/ProfileDoctor';
import { StudioBrand } from './components/Brand';
import { FindReplacePanel } from './components/FindReplacePanel';
import { HomeSetupChecklist, NewUserGuide } from './components/NewUserGuide';
import { HistoryPanel } from './components/HistoryPanel';
import { JobManager } from './components/JobManager';
import { WorkspaceToolsMenu } from './components/WorkspaceToolsMenu';
import { UpdatePanel } from './components/UpdatePanel';
import { isVideoProject, normalizeCaptionAppearance, summarizeProject } from '@kcs/shared';
import { NativeCaptionPreview } from './components/NativeCaptionPreview';
import { useStudioConfirm } from './components/ConfirmationDialog';
import { analyzeCaptions, exportReadiness, QA_PROFILES, resolveQaProfile } from './review';
import { captionTextForEditing } from './caption-text';
import { useCaptionSelection } from './hooks/useCaptionSelection';
import { deferWorkspace } from './components/DeferredWorkspace';
import { createProjectScope, groupingChangesWording, projectMediaKey, proposalForProject, type ProjectTicket } from './project-scope';
import { SourceMedia } from './components/SourceMedia';
import './styles.css';

const WaveformEditor = deferWorkspace(() => import('./components/WaveformEditor').then((module) => ({ default: module.WaveformEditor })));

const ExportWorkspace = deferWorkspace(() => import('./components/ExportWorkspace').then((module) => ({ default: module.ExportWorkspace })));

const CaptionAppearanceWorkspace = deferWorkspace(() => import('./components/CaptionAppearanceWorkspace').then((module) => ({ default: module.CaptionAppearanceWorkspace })));

const RegenerationReviewDock = deferWorkspace(() => import('./components/RegenerationReviewDock').then((module) => ({ default: module.RegenerationReviewDock })));

const modes: Array<{ id: CaptionMode; label: string; desc: string }> = [
  { id: 'dynamic', label: 'Dynamic', desc: 'Fast TikTok rhythm' },
  { id: 'word', label: 'Word', desc: 'One timed token at a time' },
  { id: 'phrase', label: 'Phrase', desc: 'Natural short phrases' },
  { id: 'single-line', label: 'Line', desc: 'Longer single-line groups' },
];

const LEGACY_GLOSSARY_KEY = 'kcs:default-protected-vocabulary:v1';
const LEGACY_STYLE_KEY = 'kcs:my-tiktok-style:v1';
const PROFILE_MIGRATION_KEY = 'kcs:profile-migrated:v1';
const FIRST_RUN_DISMISSED_KEY = 'sthang:first-run-dismissed:v1';
const PROJECT_GUIDE_SEEN_KEY = 'sthang:project-guide-seen:v1';

type WorkspaceTool = 'review' | 'timeline' | 'accuracy' | 'rhythm' | 'appearance' | 'details' | 'export' | null;
type ReviewPlaybackPass = 'context' | 'focus';

type ReviewUndoState = {
  items: Array<{ id: string; approved: boolean }>;
  restoreSelectionId: string;
  message: string;
};

type ReplacementEditRecovery = {
  id: string;
  sourceProjectId: string;
  sourceMedia: Pick<CaptionProject['media'], 'filename' | 'originalName' | 'size'>;
  captions: CaptionSegment[];
  capturedAt: string;
};

const MAX_REPLACEMENT_EDIT_RECOVERIES = 3;

function uniqueLines(...groups: Array<string[] | undefined>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const raw of group || []) {
      const line = raw.trim();
      if (!line) continue;
      const key = line.toLocaleLowerCase('en');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  return out;
}

function rangeLabel(startMs: number, endMs: number) {
  const fmt = (ms: number) => {
    const seconds = ms / 1000;
    return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
  };
  return `${fmt(startMs)}–${fmt(endMs)}`;
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
  const [projects, setProjects] = useState<CaptionProjectSummary[]>([]);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [startupErrors, setStartupErrors] = useState<string[]>([]);
  const startupLoaded = useRef(new Set<string>());
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const projectOpen = useRef<AbortController | null>(null);
  const [project, setProject] = useState<CaptionProject | null>(null);
  const [draft, setDraft] = useState<CaptionSegment[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [replacementEditRecoveries, setReplacementEditRecoveries] = useState<ReplacementEditRecovery[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [llmSettings, setLlmSettings] = useState<LlmSettingsStatus | null>(null);
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [doctor, setDoctor] = useState<SystemDoctorReport | null>(null);
  const [time, setTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [maxChars, setMaxChars] = useState(18);
  const [groupingMode, setGroupingMode] = useState<CaptionMode>('dynamic');
  const [groupingApplying, setGroupingApplying] = useState(false);
  const groupingInFlight = useRef(false);
  const [contextDescription, setContextDescription] = useState('');
  const [vocabularyText, setVocabularyText] = useState('');
  const [reviewMode, setReviewMode] = useState(false);
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<string | null>(null);
  const [showCorrections, setShowCorrections] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('ai');
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showJobs, setShowJobs] = useState(false);
  const [showUpdates, setShowUpdates] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<ProjectHistoryEntry[]>([]);
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const [proposalEntry, setProposalEntry] = useState<{ ticket: ProjectTicket; value: RegenerationProposal } | null>(null);
  const projectScope = useRef(createProjectScope());
  const proposalRead = useRef(0);
  const playbackTimers = useRef(new Set<number>());
  const viewTicket = projectScope.current.capture();
  const proposal = proposalForProject(proposalEntry, viewTicket, project);
  const mediaKey = projectMediaKey(project);
  const [proposalPreviewMode, setProposalPreviewMode] = useState<RegenerationPreviewMode>('proposed');
  const [proposalLoop, setProposalLoop] = useState(true);
  const [proposalEditedText, setProposalEditedText] = useState('');
  const [proposalAccuracyHint, setProposalAccuracyHint] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  const [workspaceTool, setWorkspaceTool] = useState<WorkspaceTool>(null);
  const [showFirstRun, setShowFirstRun] = useState(() => {
    try { return localStorage.getItem(FIRST_RUN_DISMISSED_KEY) !== '1'; } catch { return true; }
  });
  const [dirty, setDirty] = useState(false);
  const [textEditing, setTextEditing] = useState(false);
  const [autosaveState, setAutosaveState] = useState<'saved' | 'pending' | 'saving'>('saved');
  const [queuedSeekMs, setQueuedSeekMs] = useState<number | null>(null);
  const [reviewUndo, setReviewUndo] = useState<ReviewUndoState | null>(null);
  const { confirm: confirmInStudio, confirmationDialog } = useStudioConfirm();

  const media = useRef<HTMLMediaElement | null>(null);
  const replaceInput = useRef<HTMLInputElement | null>(null);
  const editor = useRef<CaptionEditorHandle | null>(null);
  const draftRef = useRef<CaptionSegment[]>([]);
  const draftVersion = useRef(0);
  const draftEditRevision = useRef(0);
  const contextEditRevision = useRef(0);
  const dirtyRef = useRef(false);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const queuedCaption = useRef<string | null>(null);
  const trackedJobIds = useRef(new Set<string>());
  const handledJobIds = useRef(new Set<string>());
  const lastChangeReason = useRef<DraftChangeReason>('metadata');
  const aiOnboardingShown = useRef(false);
  const reviewPlaybackPass = useRef<ReviewPlaybackPass>('focus');

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
    load('Recent projects', api.listSummaries, (items) => setProjects((current) => {
      const localIds = new Set(current.map((item) => item.id));
      return [...current, ...items.filter((item) => !localIds.has(item.id))];
    }));
    load('System status', api.health, setHealth);
    load('Preferences', api.profile, setProfile);
    load('Activity', api.jobs, (items) => {
      items.filter((job) => ['queued', 'running', 'interrupted'].includes(job.status))
        .forEach((job) => trackedJobIds.current.add(job.id));
      setJobs(items);
    });
    load('AI connection', api.llmSettings, setLlmSettings);
    return () => { disposed = true; };
  }, [startupAttempt]);

  useEffect(() => () => {
    projectOpen.current?.abort();
    projectScope.current.invalidate();
    cancelPlayback();
  }, []);

  function cancelPlayback() {
    for (const timer of playbackTimers.current) window.clearTimeout(timer);
    playbackTimers.current.clear();
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
    cancelPlayback();
    const ticket = projectScope.current.capture();
    setProposalEntry(value && value.projectId === project?.id
      && ticket.key === projectMediaKey(project) ? { ticket, value } : null);
  }
  function beginNavigation() {
    projectOpen.current?.abort();
    projectOpen.current = null;
    projectScope.current.invalidate();
    setOpeningProjectId(null);
    setProposal(null);
    setQueuedSeekMs(null);
    queuedCaption.current = null;
    setReviewMode(false);
    setReviewUndo(null);
    setBusy('');
    return projectScope.current.capture();
  }
  async function goHome() {
    const ticket = beginNavigation();
    const hadEdits = dirtyRef.current;
    const saved = await saveDraft(true, 'manual-save', true);
    if (!projectScope.current.isCurrent(ticket) || (hadEdits && !saved)) return;
    if (dirtyRef.current) { setNotice('Newer edits are still unsaved. Save them before leaving.'); return; }
    projectScope.current.select(null);
    setProject(null);
    setDraft([]);
    draftRef.current = [];
    draftVersion.current += 1;
    setTime(0);
    setSelectionAnchor(null);
    setSelectionEnd(null);
  }
  async function loadProposal(projectId: string, proposalId: string, ticket: ProjectTicket, automatic = false) {
    const request = ++proposalRead.current;
    const value = await api.regenerationProposal(projectId, proposalId);
    if (!projectScope.current.isCurrent(ticket) || request !== proposalRead.current) return false;
    if (value.projectId !== projectId) throw new Error('This preview belongs to another project.');
    if (automatic && (dirtyRef.current || (media.current && !media.current.paused))) {
      setNotice('Regeneration preview ready. Open it from Activity when you are ready.');
      return false;
    }
    cancelPlayback();
    setProposalEntry({ ticket, value });
    return true;
  }

  useEffect(() => {
    if (!llmSettings || llmSettings.configured || aiOnboardingShown.current || project || busy) return;
    aiOnboardingShown.current = true;
    setSettingsTab('ai');
    setShowProfile(true);
  }, [llmSettings, project, busy]);

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

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4200);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!reviewUndo) return;
    const timer = window.setTimeout(() => setReviewUndo(null), 6500);
    return () => window.clearTimeout(timer);
  }, [reviewUndo]);

  useEffect(() => {
    if (!project) return;
    const initialDraft = project.captions || [];
    setDraft(initialDraft);
    draftRef.current = initialDraft;
    draftVersion.current += 1;
    setDirty(false);
    dirtyRef.current = false;
    setAutosaveState('saved');
    setWorkspaceTool(null);
    setReviewUndo(null);
    setContextDescription(project.transcriptionContext?.description || '');
    setVocabularyText(uniqueLines(profile?.defaultVocabulary, project.transcriptionContext?.vocabulary).join('\n'));
    const style = profile?.styles.find((item) => item.id === 'my-tiktok-style') || profile?.styles[0];
    setMaxChars(style?.maxChars ?? 18);
    setGroupingMode(project.mode);
    const requested = queuedCaption.current;
    const first = requested && initialDraft.some((caption) => caption.id === requested) ? requested : initialDraft[0]?.id || null;
    queuedCaption.current = null;
    setSelectionAnchor(first);
    setSelectionEnd(first);
  }, [mediaKey]);

  useEffect(() => {
    if (!project) return;
    try {
      if (localStorage.getItem(PROJECT_GUIDE_SEEN_KEY) !== '1') {
        setShowGuide(true);
        localStorage.setItem(PROJECT_GUIDE_SEEN_KEY, '1');
      }
    } catch { /* local-only onboarding preference */ }
  }, [project?.id]);

  useEffect(() => {
    if (!proposal) return;
    setProposalPreviewMode('proposed');
    setProposalLoop(true);
    setProposalEditedText(captionTextForEditing(proposal.proposedCaptions));
    setProposalAccuracyHint(proposal.accuracyHint || '');
    const preRoll = profile?.preferences.reviewPreRollMs ?? 450;
    return schedulePlayback(() => {
      if (!media.current) return;
      media.current.currentTime = Math.max(0, proposal.startMs - preRoll) / 1000;
    });
  }, [proposal?.id, mediaKey]);

  const applyProject = (next: CaptionProject, replaceDraft = true) => {
    projectOpen.current?.abort();
    projectOpen.current = null;
    setOpeningProjectId(null);
    const changedMedia = projectScope.current.capture().key !== projectMediaKey(next);
    if (changedMedia) {
      projectScope.current.select(next);
      setProposal(null);
      setQueuedSeekMs(null);
      setReviewMode(false);
      setReviewUndo(null);
      setTime(0);
    }
    setProject(next);
    setProjects((items) => [summarizeProject(next), ...items.filter((item) => item.id !== next.id)]);
    if (replaceDraft) {
      cancelPlayback();
      setDraft(next.captions);
      draftRef.current = next.captions;
      draftVersion.current += 1;
      setDirty(false);
      dirtyRef.current = false;
      setAutosaveState('saved');
      setContextDescription(next.transcriptionContext?.description || '');
      setVocabularyText(uniqueLines(profile?.defaultVocabulary, next.transcriptionContext?.vocabulary).join('\n'));
      const validSelection = next.captions.find((caption) => caption.id === selectionAnchor) || next.captions[0];
      if (validSelection) { setSelectionAnchor(validSelection.id); setSelectionEnd(validSelection.id); }
    }
  };

  const publishSameMediaMutation = (
    next: CaptionProject,
    ticket: ProjectTicket,
    editRevision: number,
    draftWasDirty: boolean,
    preservedNotice: string,
  ): 'applied' | 'preserved' | 'stale' => {
    if (!projectScope.current.isCurrent(ticket) || projectMediaKey(next) !== ticket.key) return 'stale';
    if (!draftWasDirty && draftEditRevision.current === editRevision) {
      applyProject(next);
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
      setAutosaveState('pending');
    }
    setNotice(preservedNotice);
    return 'preserved';
  };

  const copyReplacementEdits = async (recovery: ReplacementEditRecovery) => {
    const payload = JSON.stringify({
      version: 1,
      projectId: recovery.sourceProjectId,
      media: recovery.sourceMedia,
      capturedAt: recovery.capturedAt,
      captions: recovery.captions,
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
      setNotice('Previous-media caption recovery copied.');
    } catch {
      setError('Could not copy the previous-media edits. The recovery notice will stay available.');
    }
  };

  const publishContextProject = (next: CaptionProject) => {
    const ticket = projectScope.current.capture();
    if (ticket.key !== projectMediaKey(next)) return false;
    setProject((current) => {
      if (!current || current.id !== next.id || projectMediaKey(current) !== ticket.key) return current;
      return { ...current, transcriptionContext: next.transcriptionContext, updatedAt: next.updatedAt };
    });
    setProjects((items) => [
      summarizeProject({ ...next, captions: draftRef.current }),
      ...items.filter((item) => item.id !== next.id),
    ]);
    return true;
  };

  const updateDraft = (next: CaptionSegment[], preferredSelectionId?: string, reason: DraftChangeReason = 'metadata') => {
    setDraft(next);
    draftRef.current = next;
    draftVersion.current += 1;
    draftEditRevision.current += 1;
    setDirty(true);
    dirtyRef.current = true;
    setAutosaveState('pending');
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
  const contextPayload = (): TranscriptionContext => ({ description: contextDescription.trim(), vocabulary: vocabularyLines });
  const qaSettings = useMemo(() => resolveQaProfile(profile?.preferences.qaProfileId, profile?.preferences.qaCustom), [profile?.preferences.qaProfileId, profile?.preferences.qaCustom]);
  const mediaDurationMs = project?.transcript?.timing?.audioDurationMs;
  const issues = useMemo(() => analyzeCaptions(draft, vocabularyLines, qaSettings, mediaDurationMs), [draft, vocabularyLines, qaSettings, mediaDurationMs]);
  const issueMap = useMemo(() => new Map(issues.map((issue) => [issue.captionId, issue])), [issues]);
  const riskyIds = useMemo(() => draft.filter((caption) => !caption.approved && issueMap.has(caption.id)).map((caption) => caption.id), [draft, issueMap]);
  const readiness = useMemo(() => exportReadiness(draft, issues), [draft, issues]);
  const pendingCorrections = profile?.correctionEvents.filter((event) => event.status === 'pending').length || 0;
  const activeJobs = jobs.filter((job) => ['queued', 'running'].includes(job.status));
  const currentProjectAnyActiveJob = project ? activeJobs.find((job) => job.projectId === project.id) : undefined;
  const currentProjectActiveJob = project ? activeJobs.find((job) => job.projectId === project.id && job.type !== 'export-video') : undefined;
  const activeExportJob = project ? activeJobs.find((job) => job.projectId === project.id && job.type === 'export-video') : undefined;
  const currentProjectToastJob = currentProjectActiveJob || activeExportJob;
  const refinementJob = project ? activeJobs.find((job) => job.projectId === project.id && job.type === 'refine-proposal') : undefined;

  const selection = useCaptionSelection(draft, selectionAnchor, selectionEnd, time * 1000);
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
    if (!proposal || proposalPreviewMode === 'current') return draft;
    const outside = draft.filter((caption) => caption.endMs <= proposal.startMs || caption.startMs >= proposal.endMs);
    return [...outside, ...proposedPreviewRange].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  }, [draft, proposal, proposalPreviewMode, proposedPreviewRange]);
  const [liveAppearance, setLiveAppearance] = useState<{ projectId: string; appearance: CaptionAppearance } | null>(null);
  const [previewResolution, setPreviewResolution] = useState<VideoResolutionPreset>('source');
  const [appearanceInteracting, setAppearanceInteracting] = useState(false);
  useEffect(() => { setAppearanceInteracting(false); }, [project?.id, project?.media.filename, workspaceTool]);
  const changeAppearance = useCallback((appearance: CaptionAppearance) => {
    if (project) setLiveAppearance({ projectId: project.id, appearance });
  }, [project?.id]);
  const previewAppearance = useMemo(() => normalizeCaptionAppearance(liveAppearance?.projectId === project?.id ? liveAppearance?.appearance : project?.captionAppearance), [project?.id, project?.captionAppearance, liveAppearance]);
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
    if (!draft.length) {
      if (selectionAnchor !== null) setSelectionAnchor(null);
      if (selectionEnd !== null) setSelectionEnd(null);
      return;
    }
    const anchorValid = Boolean(selectionAnchor && draft.some((caption) => caption.id === selectionAnchor));
    const endValid = Boolean(selectionEnd && draft.some((caption) => caption.id === selectionEnd));
    if (anchorValid && endValid) return;
    const playheadMs = time * 1000;
    const fallback = active || draft.find((caption) => playheadMs < caption.endMs) || draft.at(-1)!;
    setSelectionAnchor(fallback.id);
    setSelectionEnd(fallback.id);
  }, [draft, selectionAnchor, selectionEnd, active, time]);

  const runProject = async (label: string, operation: () => Promise<CaptionProject>) => {
    projectOpen.current?.abort();
    projectOpen.current = null;
    setOpeningProjectId(null);
    setBusy(label);
    setError('');
    let ticket = projectScope.current.capture();
    try {
      const result = await operation();
      if (!projectScope.current.isCurrent(ticket)) return null;
      applyProject(result);
      ticket = projectScope.current.capture();
      return result;
    } catch (reason) {
      if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Something went wrong');
      return null;
    } finally { if (projectScope.current.isCurrent(ticket)) setBusy(''); }
  };

  const refreshProfile = async () => {
    try { setProfile(await api.profile()); } catch { /* optional */ }
  };

  // Full-project same-media mutations and caption saves share one acknowledgement
  // order. A later save may become clean only after the mutation it follows has
  // been reconciled, and a queued mutation is dropped if its editor session left.
  const queueSameMediaMutation = <T,>(ticket: ProjectTicket, operation: () => Promise<T>): Promise<T | null> => {
    const execute = async () => projectScope.current.isCurrent(ticket) ? operation() : null;
    const task = saveQueue.current.then(execute, execute);
    saveQueue.current = task.then(() => undefined, () => undefined);
    return task;
  };

  const saveDraft = (
    silent = false,
    source: 'manual-save' | 'autosave' | 'text-edit' = 'manual-save',
    recordCorrections = source !== 'autosave',
  ): Promise<CaptionProject | null> => {
    if (!project || !dirtyRef.current) return Promise.resolve(null);
    const targetProject = project;
    const ticket = projectScope.current.capture();
    const snapshot = draftRef.current;
    const version = draftVersion.current;

    const execute = async () => {
      if (projectScope.current.isCurrent(ticket)) {
        if (!silent) { setBusy('Saving captions…'); setError(''); }
        if (source === 'autosave') setAutosaveState('saving');
      }
      try {
        const result = await api.saveCaptions(
          targetProject.id,
          snapshot,
          { filename: targetProject.media.filename, size: targetProject.media.size },
          { source, recordCorrections },
        );
        // Saving the old project's snapshot is valid; navigating back to it is not.
        if (!projectScope.current.isCurrent(ticket) || projectMediaKey(result.project) !== ticket.key) return result.project;
        const unchanged = version === draftVersion.current;
        if (unchanged) applyProject(result.project, true);
        else {
          setProject((current) => current?.id === result.project.id ? { ...result.project, captions: draftRef.current } : current);
          setProjects((items) => [summarizeProject(result.project), ...items.filter((item) => item.id !== result.project.id)]);
        }
        if (result.correctionsCreated > 0) {
          await refreshProfile();
          if (projectScope.current.isCurrent(ticket)) setNotice(`${result.correctionsCreated} correction${result.correctionsCreated === 1 ? '' : 's'} captured in the Inbox.`);
        } else if (!silent) setNotice('Captions saved.');
        return result.project;
      } catch (reason) {
        if (projectScope.current.isCurrent(ticket)) {
          setError(reason instanceof Error ? reason.message : 'Save failed');
          setAutosaveState('pending');
        }
        return null;
      } finally { if (!silent && projectScope.current.isCurrent(ticket)) setBusy(''); }
    };

    const task = saveQueue.current.then(execute, execute);
    saveQueue.current = task.then(() => undefined, () => undefined);
    return task;
  };

  useEffect(() => {
    if (!project || !dirty || textEditing || groupingApplying) return;
    const delay = profile?.preferences.autosaveDelayMs ?? 2200;
    const timer = window.setTimeout(() => { void saveDraft(true, 'autosave', false); }, delay);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, textEditing, groupingApplying, project?.id, profile?.preferences.autosaveDelayMs]);

  const refreshJobs = async () => {
    try { setJobs(await api.jobs()); } catch { /* queue is optional during startup */ }
  };

  const openJobResult = async (job: ProcessingJob) => {
    let ticket = beginNavigation();
    setError('');
    try {
      const hadEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (!projectScope.current.isCurrent(ticket) || (hadEdits && !saved)) return;
      if (dirtyRef.current) { setNotice('Newer edits are still unsaved. Save them before opening a result.'); return; }
      const readRevision = draftEditRevision.current;
      const target = await api.get(job.resultProjectId || job.projectId);
      if (!projectScope.current.isCurrent(ticket)) return;
      if (dirtyRef.current || readRevision !== draftEditRevision.current) {
        setNotice('Newer edits arrived while the result was loading. They are kept here; open the result again when you are ready.');
        return;
      }
      applyProject(target);
      ticket = projectScope.current.capture();
      if (job.proposalId) {
        if (!await loadProposal(target.id, job.proposalId, ticket) || !projectScope.current.isCurrent(ticket)) return;
        setNotice('Regeneration preview opened. Current captions remain untouched until you approve it.');
      } else setNotice('Completed caption job opened.');
      setShowJobs(false);
      handledJobIds.current.add(job.id);
    } catch (reason) {
      if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Could not open the job result');
    }
  };

  useEffect(() => {
    const activeNow = jobs.some((job) => ['queued', 'running'].includes(job.status));
    if (!activeNow && !showJobs) return;
    const timer = window.setInterval(() => { void refreshJobs(); }, 1000);
    return () => window.clearInterval(timer);
  }, [jobs, showJobs]);

  useEffect(() => {
    for (const job of jobs) {
      if (!trackedJobIds.current.has(job.id) || handledJobIds.current.has(job.id)) continue;
      if (job.status === 'completed') {
        if (project?.id === job.projectId) {
          handledJobIds.current.add(job.id);
          const ticket = projectScope.current.capture();
          const version = draftVersion.current;
          if (job.proposalId) {
            void loadProposal(job.projectId, job.proposalId, ticket, true)
              .then((opened) => { if (opened && projectScope.current.isCurrent(ticket)) { setShowJobs(false); setNotice('Regeneration preview ready. Review it before applying.'); } })
              .catch((reason) => { if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Could not open regeneration preview'); });
          } else if (job.resultProjectId) {
            void api.get(job.resultProjectId).then((value) => {
              if (!projectScope.current.isCurrent(ticket) || projectMediaKey(value) !== ticket.key) return;
              if (dirtyRef.current || version !== draftVersion.current) {
                setNotice('Caption generation completed. Your newer edits are kept; the result is available in Activity.');
                return;
              }
              applyProject(value);
              setNotice('Background caption generation completed.');
            }).catch(() => {});
          } else if (job.resultExport) {
            setNotice(`Captioned video ready: ${job.resultExport.filename}. Open Activity to download it.`);
          }
        }
      } else if (job.status === 'failed') {
        handledJobIds.current.add(job.id);
        setError(job.error || 'Background processing failed. Open Jobs to retry.');
        setShowJobs(true);
      }
    }
  }, [jobs, project?.id]);

  const startJob = async (operation: () => Promise<ProcessingJob>, message: string, openQueue = true) => {
    const ticket = projectScope.current.capture();
    setError('');
    try {
      const job = await operation();
      trackedJobIds.current.add(job.id);
      handledJobIds.current.delete(job.id);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      if (projectScope.current.isCurrent(ticket)) {
        if (openQueue) setShowJobs(true);
        setNotice(message);
      }
      return job;
    } catch (reason) {
      if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Could not start processing job');
      return null;
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
    cancelPlayback();
    const preRoll = profile?.preferences.reviewPreRollMs ?? 450;
    const start = typeof focusMs === 'number' ? focusMs : proposal.startMs;
    media.current.currentTime = Math.max(0, start - preRoll) / 1000;
    media.current.play().catch(() => {});
  };
  const playReviewSelection = (pass: ReviewPlaybackPass = 'focus') => {
    if (!media.current || !selection.captions.length || !projectScope.current.isCurrent(viewTicket)) return;
    cancelPlayback();
    reviewPlaybackPass.current = pass;
    media.current.currentTime = Math.max(0, selection.startMs - reviewLeadMs(pass)) / 1000;
    media.current.play().catch(() => {});
  };
  const replaySelection = () => playReviewSelection('focus');
  const replaySelectionWithContext = () => playReviewSelection('context');
  const selectCaption = (id: string, extend: boolean) => {
    cancelPlayback();
    if (reviewMode) reviewPlaybackPass.current = 'focus';
    if (extend && selectionAnchor) setSelectionEnd(id);
    else { setSelectionAnchor(id); setSelectionEnd(id); }
  };
  const moveToReviewCaption = (id: string, play = false) => {
    const caption = draftRef.current.find((item) => item.id === id);
    if (!caption) return;
    reviewPlaybackPass.current = 'context';
    media.current?.pause();
    setSelectionAnchor(id);
    setSelectionEnd(id);
    seek(caption.startMs - reviewLeadMs('context'));
    schedulePlayback(() => {
      editor.current?.revealCaption(id);
      if (play) media.current?.play().catch(() => {});
    }, 40);
  };
  const selectRisk = (delta: number, play = false) => {
    if (!riskyIds.length) return;
    const current = riskyIds.findIndex((id) => selection.ids.includes(id));
    const nextIndex = current < 0 ? 0 : Math.max(0, Math.min(riskyIds.length - 1, current + delta));
    moveToReviewCaption(riskyIds[nextIndex], play);
  };
  const shiftSelection = (delta: number) => {
    if (!selection.ids.length) return;
    const selected = new Set(selection.ids);
    const minimum = Math.min(...selection.captions.map((caption) => caption.startMs));
    const safeDelta = Math.max(delta, -minimum);
    updateDraft(draft.map((caption) => selected.has(caption.id) && !caption.timingLocked
      ? { ...caption, startMs: caption.startMs + safeDelta, endMs: caption.endMs + safeDelta, timingSource: 'manual', timingQuality: 'medium', approved: false }
      : caption), undefined, 'timing');
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[aria-modal="true"]')) return;
      const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); void saveDraft(false, 'manual-save', true); return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && project) {
        event.preventDefault(); setShowFindReplace(true); return;
      }
      if (event.key === 'Escape') {
        if (proposal) { setProposal(null); return; }
        if (showGuide) { setShowGuide(false); return; }
        if (showCorrections || showProfile || showFindReplace || showHistory || showJobs || showUpdates) {
          setShowCorrections(false); setShowProfile(false); setShowFindReplace(false); setShowHistory(false); setShowJobs(false); setShowUpdates(false); return;
        }
        if (workspaceTool) { setWorkspaceTool(null); setReviewMode(false); return; }
        return;
      }
      if (typing || !project || target?.closest('button, select, summary, [role="button"], [role="slider"], [role="combobox"]')) return;
      if (event.key === ' ') {
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
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault(); shiftSelection(-50);
      } else if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault(); shiftSelection(50);
      } else if (reviewMode && !proposal && (event.key === 'Enter' || event.key.toLowerCase() === 'a')) {
        event.preventDefault(); approveAndNext();
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
    if (proposal && proposalLoop && !element.paused && element.currentTime * 1000 >= proposal.endMs + proposalPostRoll) {
      replayProposal();
      return;
    }
    const autoLoop = profile?.preferences.autoLoopReview ?? true;
    const reviewPostRoll = reviewTailMs(reviewPlaybackPass.current);
    if (reviewMode && autoLoop && selection.captions.length && !element.paused && element.currentTime * 1000 >= selection.endMs + reviewPostRoll) {
      playReviewSelection('focus');
    }
  };
  const onLoadedMetadata = (element: HTMLMediaElement) => {
    if (media.current !== element || !projectScope.current.isCurrent(viewTicket)) return;
    if (media.current) media.current.playbackRate = playbackRate;
    if (queuedSeekMs == null || !media.current) return;
    const preRoll = profile?.preferences.reviewPreRollMs ?? 450;
    media.current.currentTime = Math.max(0, queuedSeekMs - preRoll) / 1000;
    media.current.play().catch(() => {});
    setQueuedSeekMs(null);
  };
  const changePlaybackRate = (rate: number) => {
    setPlaybackRate(rate);
    if (media.current) media.current.playbackRate = rate;
  };

  const openRecentProject = async (id: string) => {
    if (!profile || busy) return;
    const ticket = beginNavigation();
    const request = new AbortController();
    projectOpen.current = request;
    setOpeningProjectId(id);
    setError('');
    try {
      const value = await api.get(id, request.signal);
      if (projectScope.current.isCurrent(ticket) && projectOpen.current === request && !request.signal.aborted) applyProject(value);
    } catch (reason) {
      if (projectOpen.current === request && !request.signal.aborted) {
        setError(reason instanceof Error ? reason.message : 'Could not open project. Try again.');
      }
    } finally {
      if (projectOpen.current === request) { projectOpen.current = null; setOpeningProjectId(null); }
    }
  };

  const upload = async (file: File, title: string) => {
    beginNavigation();
    return runProject('Uploading…', () => api.create(file, title));
  };
  const replaceMedia = (file?: File) => {
    if (!file || !project) return;
    if (replacementEditRecoveries.length >= MAX_REPLACEMENT_EDIT_RECOVERIES) {
      setNotice('Copy or dismiss an earlier replacement recovery before replacing media again.');
      return;
    }
    const targetProject = project;
    const saveTicket = projectScope.current.capture();
    void (async () => {
      const hadEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (!projectScope.current.isCurrent(saveTicket) || (hadEdits && !saved)) return;
      if (dirtyRef.current) {
        setNotice('Newer edits are still unsaved. Save them before replacing the media.');
        return;
      }

      // Capture the revision only after the prerequisite save. Anything typed from
      // here onward belongs to the retiring media and must never be transplanted.
      const editRevision = draftEditRevision.current;
      const ticket = beginNavigation();
      setBusy('Replacing media…');
      setError('');
      try {
        const result = await api.replaceMedia(targetProject.id, file);
        if (!projectScope.current.isCurrent(ticket)) {
          setProjects((items) => [summarizeProject(result), ...items.filter((item) => item.id !== result.id)]);
          return;
        }

        const changedWhilePending = draftEditRevision.current !== editRevision;
        const recoverableCaptions = changedWhilePending ? structuredClone(draftRef.current) : null;
        setBusy('');
        applyProject(result);
        if (recoverableCaptions) {
          const capturedAt = new Date().toISOString();
          setReplacementEditRecoveries((current) => [...current, {
            id: `${targetProject.id}:${targetProject.media.filename}:${capturedAt}`,
            sourceProjectId: targetProject.id,
            sourceMedia: {
              filename: targetProject.media.filename,
              originalName: targetProject.media.originalName,
              size: targetProject.media.size,
            },
            captions: recoverableCaptions,
            capturedAt,
          }]);
        }

        const cleanupWarnings = result.replacementCleanupWarnings || [];
        if (cleanupWarnings.length > 0) {
          const details = cleanupWarnings.map((warning) => warning === 'history'
            ? 'old History data'
            : warning === 'proposals' ? 'old regeneration previews' : 'the previous source file');
          setNotice(`Replacement saved. Studio retired the old media version, but could not remove ${details.join(', ')}. You can keep working with the replacement.`);
        } else {
          setNotice('Replacement saved.');
        }
      } catch (reason) {
        if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Media replacement failed');
      } finally {
        if (projectScope.current.isCurrent(ticket)) setBusy('');
      }
    })();
  };
  const generate = async () => {
    if (!project) return;
    if (!llmSettings?.configured) {
      setError('Connect AI in Settings → AI connection before generating captions.');
      openSettings('ai');
      return;
    }
    const targetProject = project;
    const ticket = projectScope.current.capture();
    const editRevision = draftEditRevision.current;
    const contextRevision = contextEditRevision.current;
    const requestContext = contextPayload();
    const hadUnsavedEdits = dirtyRef.current;
    const saved = await saveDraft(true, 'manual-save', true);
    if (hadUnsavedEdits && !saved) return;
    if (!projectScope.current.isCurrent(ticket)
      || draftEditRevision.current !== editRevision
      || contextEditRevision.current !== contextRevision) return;
    const fullDuration = targetProject.transcript?.timing?.audioDurationMs;
    if (targetProject.transcript?.tokens?.length && fullDuration) {
      await startJob(() => api.startRegenerationJob(targetProject.id, 0, fullDuration, requestContext), 'Full regeneration queued. Current captions stay untouched until you approve the diff.');
    } else {
      await startJob(() => api.startTranscribeJob(targetProject.id, requestContext, Boolean(targetProject.transcript)), 'Caption generation queued. You can keep the browser open or return later.');
    }
  };
  const saveContext = async () => {
    if (!project) return;
    const targetProject = project;
    const ticket = projectScope.current.capture();
    const payload = contextPayload();
    const revision = contextEditRevision.current;
    setBusy('Saving accuracy context…');
    setError('');
    try {
      const result = await api.saveContext(targetProject.id, payload);
      if (!projectScope.current.isCurrent(ticket) || !publishContextProject(result)) return;
      if (contextEditRevision.current === revision) setNotice('Accuracy context saved.');
      else setNotice('Accuracy context saved. Newer context edits remain in the editor.');
    } catch (reason) {
      if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Context save failed');
    } finally {
      if (projectScope.current.isCurrent(ticket)) setBusy('');
    }
  };

  const saveDefaultGlossary = async () => {
    if (!profile) return;
    setBusy('Saving global glossary…');
    try { setProfile(await api.patchProfile({ defaultVocabulary: vocabularyLines })); setNotice('Global glossary saved.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Glossary save failed'); }
    finally { setBusy(''); }
  };
  const saveStyle = async () => {
    if (!profile || !project) return;
    const next = { id: 'my-tiktok-style', name: 'My TikTok Style', mode: groupingMode, maxChars };
    const styles = [...profile.styles];
    const index = styles.findIndex((style) => style.id === next.id);
    if (index >= 0) styles[index] = next; else styles.unshift(next);
    try { setProfile(await api.patchProfile({ styles })); setNotice('Caption grouping saved to your transferable profile.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Grouping save failed'); }
  };
  const applyGrouping = async (mode = groupingMode, limit = maxChars) => {
    if (!project || busy || groupingInFlight.current || currentProjectActiveJob) return;
    groupingInFlight.current = true;
    const targetProject = project;
    const ticket = projectScope.current.capture();
    setGroupingApplying(true);
    try {
      if (groupingChangesWording(project, draftRef.current)) {
        const confirmed = await confirmInStudio({
          title: 'Regroup from timed wording?',
          message: 'Unlocked wording may return to the timed transcript. Your current captions will be saved in History first. Lock corrections you want to keep unchanged.',
          confirmLabel: 'Save and regroup',
        });
        if (!confirmed || !projectScope.current.isCurrent(ticket)) return;
      }
      setBusy('Applying caption grouping…');
      setError('');
      const hadEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (!projectScope.current.isCurrent(ticket) || (hadEdits && !saved)) return;
      if (dirtyRef.current) { setNotice('Newer edits are still unsaved. Save them before applying grouping.'); return; }
      const version = draftVersion.current;
      // Share the save queue: a later edit-save cannot be overtaken by regrouping.
      const task = saveQueue.current.then(async () => {
        if (!projectScope.current.isCurrent(ticket)) return;
        const result = await api.resegment(
          targetProject.id,
          mode,
          limit,
          { filename: targetProject.media.filename, size: targetProject.media.size },
        );
        if (!projectScope.current.isCurrent(ticket) || projectMediaKey(result) !== ticket.key) return;
        if (version !== draftVersion.current) {
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
    if (!project || !profile) return;
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
    const ticket = projectScope.current.capture();
    const editRevision = draftEditRevision.current;
    const contextRevision = contextEditRevision.current;
    const selected = { ...selectionIntent.current, ids: [...selectionIntent.current.ids] };
    const selectedKey = selectionIntentKey(selected);
    const requestContext = contextPayload();
    if (selected.endMs - selected.startMs > 90_000) {
      const confirmed = await confirmInStudio({
        title: 'Build a long regeneration preview?',
        message: 'This selection is over 90 seconds, so comparing another take may take noticeably longer. Your current captions stay untouched until you approve the result.',
        confirmLabel: 'Build preview',
      });
      if (!confirmed
        || !projectScope.current.isCurrent(ticket)
        || draftEditRevision.current !== editRevision
        || contextEditRevision.current !== contextRevision
        || selectionIntentKey(selectionIntent.current) !== selectedKey) return;
    }
    const hadUnsavedEdits = dirtyRef.current;
    const saved = await saveDraft(true, 'manual-save', true);
    if (hadUnsavedEdits && !saved) return;
    if (!projectScope.current.isCurrent(ticket)
      || draftEditRevision.current !== editRevision
      || contextEditRevision.current !== contextRevision
      || selectionIntentKey(selectionIntent.current) !== selectedKey) return;
    await startJob(
      () => api.startRegenerationJob(targetProject.id, selected.startMs, selected.endMs, requestContext),
      `Regeneration preview queued for ${rangeLabel(selected.startMs, selected.endMs)}.`,
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
    await startJob(() => api.startRefinementJob(project.id, proposal.id, input), label, false);
  };

  const applyProposal = async (mode: RegenerationApplyMode, editedText?: string) => {
    if (!project || !proposal) return;
    const ticket = projectScope.current.capture();
    const editRevision = draftEditRevision.current;
    const draftWasDirty = dirtyRef.current;
    setBusy(mode === 'reject' ? 'Discarding proposal…' : 'Applying approved regeneration…');
    setError('');
    try {
      const result = await queueSameMediaMutation(
        ticket,
        () => api.applyRegenerationProposal(project.id, proposal.id, mode, editedText),
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
      );
      if (published === 'stale') return;
      setProposal(null);
      if (published === 'applied') setNotice(mode === 'reject' ? 'Proposal discarded. Current captions were kept.' : `Regeneration applied: ${mode.replace('-', ' ')}.`);
    } catch (reason) { if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Could not apply regeneration'); }
    finally { if (projectScope.current.isCurrent(ticket)) setBusy(''); }
  };

  const cleanKhmerSpacing = async () => {
    if (!project) return;
    const targetProject = project;
    const ticket = projectScope.current.capture();
    setBusy('Cleaning Khmer spacing…'); setError('');
    try {
      const hadUnsavedEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (!projectScope.current.isCurrent(ticket) || (hadUnsavedEdits && !saved)) return;
      if (dirtyRef.current) { setNotice('Newer edits are still unsaved. Save them before cleaning Khmer spacing.'); return; }
      const editRevision = draftEditRevision.current;
      const result = await queueSameMediaMutation(ticket, () => api.normalizeKhmerSpacing(targetProject.id, {
        filename: targetProject.media.filename,
        size: targetProject.media.size,
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
    } catch (reason) { if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Khmer spacing cleanup failed'); }
    finally { if (projectScope.current.isCurrent(ticket)) setBusy(''); }
  };

  const runTimingPostprocessor = async () => {
    if (!project) return;
    const targetProject = project;
    const ticket = projectScope.current.capture();
    const confirmed = await confirmInStudio({
      title: 'Apply safe timing cleanup?',
      message: `Studio will use “${qaSettings.name}”, skip timing-locked captions, and create a History checkpoint before changing timing.`,
      confirmLabel: 'Apply cleanup',
    });
    if (!confirmed || !projectScope.current.isCurrent(ticket)) return;
    setBusy('Snapping and smoothing caption timing…');
    try {
      const hadUnsavedEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (!projectScope.current.isCurrent(ticket) || (hadUnsavedEdits && !saved)) return;
      if (dirtyRef.current) { setNotice('Newer edits are still unsaved. Save them before applying timing cleanup.'); return; }
      const editRevision = draftEditRevision.current;
      const result = await queueSameMediaMutation(ticket, () => api.postprocessTiming(targetProject.id, qaSettings, {
        filename: targetProject.media.filename,
        size: targetProject.media.size,
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
    } catch (reason) { if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Timing cleanup failed'); }
    finally { if (projectScope.current.isCurrent(ticket)) setBusy(''); }
  };

  const setQaProfile = async (id: QaProfileId) => {
    if (!profile) return;
    const preferences = { ...profile.preferences, qaProfileId: id };
    setProfile({ ...profile, preferences });
    try { setProfile(await api.patchProfile({ preferences })); } catch { /* local optimistic setting */ }
  };

  const patchSelected = (patch: Partial<CaptionSegment>, message: string) => {
    const ids = new Set(selection.ids);
    if (!ids.size) return;
    updateDraft(draft.map((caption) => ids.has(caption.id) ? { ...caption, ...patch } : caption), undefined, 'metadata');
    setNotice(message);
  };

  const approveAndNext = () => {
    if (!selection.ids.length) return;
    const selectedIds = new Set(selection.ids);
    const undoItems = selection.captions.map((caption) => ({ id: caption.id, approved: Boolean(caption.approved) }));
    const restoreSelectionId = selection.ids[0];
    const draftIndex = new Map(draft.map((caption, index) => [caption.id, index]));
    const lastSelectedIndex = Math.max(...selection.ids.map((id) => draftIndex.get(id) ?? -1));
    const remaining = riskyIds.filter((id) => !selectedIds.has(id));
    const later = remaining.find((id) => (draftIndex.get(id) ?? -1) > lastSelectedIndex);
    const nextId = later || remaining[0] || null;
    const wrapped = Boolean(nextId && !later);
    const nextDraft = draft.map((caption) => selectedIds.has(caption.id) ? { ...caption, approved: true } : caption);
    updateDraft(nextDraft, nextId || restoreSelectionId, 'metadata');

    const message = nextId
      ? wrapped
        ? `Approved. Returning to ${remaining.length} earlier skipped review item${remaining.length === 1 ? '' : 's'}.`
        : 'Approved. Moved to the next review item.'
      : 'Review complete — all flagged captions are approved.';
    setReviewUndo({ items: undoItems, restoreSelectionId, message });

    if (nextId) moveToReviewCaption(nextId, profile?.preferences.autoPlayNextReview ?? true);
    else media.current?.pause();
  };

  const undoReviewApproval = () => {
    if (!reviewUndo) return;
    const previous = new Map(reviewUndo.items.map((item) => [item.id, item.approved]));
    const restoreId = reviewUndo.restoreSelectionId;
    updateDraft(draftRef.current.map((caption) => previous.has(caption.id) ? { ...caption, approved: previous.get(caption.id)! } : caption), restoreId, 'metadata');
    setReviewUndo(null);
    schedulePlayback(() => moveToReviewCaption(restoreId, false), 20);
    setNotice('Approval undone.');
  };

  const exportSrt = async () => {
    if (!project) return;
    const targetProject = project;
    const ticket = projectScope.current.capture();
    const editRevision = draftEditRevision.current;
    const severe = issues.filter((issue) => issue.severity !== 'info').length;
    if (severe > 0) {
      const confirmed = await confirmInStudio({
        title: 'Export with review warnings?',
        message: `${severe} timing/format warning${severe === 1 ? '' : 's'} remain under “${qaSettings.name}”. SRT can still be exported with the current text and timing.`,
        confirmLabel: 'Export SRT',
      });
      if (!confirmed || !projectScope.current.isCurrent(ticket) || draftEditRevision.current !== editRevision) return;
    }
    setBusy('Saving & exporting…'); setError('');
    try {
      const hadUnsavedEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (hadUnsavedEdits && !saved) return;
      if (!projectScope.current.isCurrent(ticket) || draftEditRevision.current !== editRevision) return;
      const anchor = document.createElement('a');
      anchor.href = `/api/projects/${targetProject.id}/export.srt`; anchor.download = '';
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setNotice('SRT export started. It includes caption text and timing; visual styling is set in your editing app.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Export failed'); }
    finally { setBusy(''); }
  };


  const startVideoExport = async (settings: VideoExportSettings, appearance: CaptionAppearance): Promise<ProcessingJob | null> => {
    if (!project) return null;
    const targetProject = project;
    const ticket = projectScope.current.capture();
    const editRevision = draftEditRevision.current;
    const severe = issues.filter((issue) => issue.severity !== 'info').length;
    if (severe > 0) {
      const confirmed = await confirmInStudio({
        title: 'Render with review warnings?',
        message: `${severe} timing/format warning${severe === 1 ? '' : 's'} remain under “${qaSettings.name}”. Studio can render anyway, but the finished video will use the current caption text and timing.`,
        confirmLabel: 'Render anyway',
      });
      if (!confirmed || !projectScope.current.isCurrent(ticket) || draftEditRevision.current !== editRevision) return null;
    }
    const hadUnsavedEdits = dirtyRef.current;
    const saved = await saveDraft(true, 'manual-save', true);
    if (hadUnsavedEdits && !saved) return null;
    if (!projectScope.current.isCurrent(ticket) || draftEditRevision.current !== editRevision) return null;
    return startJob(
      () => api.startVideoExportJob(targetProject.id, settings, appearance),
      'Captioned video export queued. Studio saved a caption/settings snapshot, so you can keep editing while it renders.',
      false,
    );
  };

  const handleCorrectionAction = async (event: CorrectionEvent, action: 'remember-global' | 'add-project' | 'ignore') => {
    const ticket = projectScope.current.capture();
    setBusy('Updating correction memory…'); setError('');
    try {
      const result = await api.correctionAction(event.id, action);
      setProfile(result.profile);
      if (result.project) {
        setProjects((items) => [summarizeProject(result.project!), ...items.filter((item) => item.id !== result.project!.id)]);
        if (projectScope.current.isCurrent(ticket) && project?.id === result.project.id) {
          publishContextProject(result.project);
          contextEditRevision.current += 1;
          setVocabularyText(uniqueLines(result.profile.defaultVocabulary, result.project.transcriptionContext?.vocabulary).join('\n'));
        }
      }
      if (action === 'remember-global') {
        contextEditRevision.current += 1;
        setVocabularyText((current) => uniqueLines(current.split(/\r?\n/), [event.suggestedVocabularyLine]).join('\n'));
        setNotice('Correction remembered globally.');
      } else if (action === 'add-project') setNotice('Correction added to that project’s glossary.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Correction action failed'); }
    finally { setBusy(''); }
  };
  const openCorrectionEvent = async (event: CorrectionEvent) => {
    let ticket = beginNavigation();
    setShowCorrections(false); setBusy('Opening correction audio…');
    try {
      const hadEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (!projectScope.current.isCurrent(ticket) || (hadEdits && !saved)) return;
      if (dirtyRef.current) { setNotice('Newer edits are still unsaved. Save them before opening a correction.'); return; }
      const readRevision = draftEditRevision.current;
      const target = await api.get(event.projectId);
      if (!projectScope.current.isCurrent(ticket)) return;
      if (dirtyRef.current || readRevision !== draftEditRevision.current) {
        setNotice('Newer edits arrived while the correction was loading. They are kept here; open the correction again when you are ready.');
        return;
      }
      const switchingProject = project?.id !== target.id;
      if (switchingProject) queuedCaption.current = event.captionId;
      applyProject(target);
      ticket = projectScope.current.capture();
      setReviewMode(true);
      if (!switchingProject) { setSelectionAnchor(event.captionId); setSelectionEnd(event.captionId); }
      setQueuedSeekMs(event.startMs);
    } catch (reason) { if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Could not open correction project'); }
    finally { if (projectScope.current.isCurrent(ticket)) setBusy(''); }
  };

  const openSettings = (tab: SettingsTab = 'ai') => {
    setSettingsTab(tab);
    setShowProfile(true);
  };
  const refreshAiHealth = async (next: LlmSettingsStatus) => {
    setLlmSettings(next);
    try { setHealth(await api.health()); } catch { /* settings remain usable even if health refresh fails */ }
    setDoctor(null);
    return next;
  };
  const saveLlmSettings = async (input: SaveLlmSettingsInput) => refreshAiHealth(await api.saveLlmSettings(input));
  const forgetLlmKey = async () => refreshAiHealth(await api.forgetLlmKey());

  const saveProfilePatch = async (patch: Partial<AppProfile>) => {
    setBusy('Saving profile…');
    try { setProfile(await api.patchProfile(patch)); setNotice('Profile updated.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Profile update failed'); }
    finally { setBusy(''); }
  };
  const importProfile = async (value: AppProfile) => {
    setBusy('Importing profile…');
    try {
      const imported = await api.importProfile(value);
      setProfile(imported);
      contextEditRevision.current += 1;
      setVocabularyText((current) => uniqueLines(imported.defaultVocabulary, current.split(/\r?\n/)).join('\n'));
      setNotice('Profile imported. Glossary, topic packs, grouping presets and correction memory are now available on this PC.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Profile import failed'); }
    finally { setBusy(''); }
  };
  const runDoctor = async () => {
    setBusy('Running system checks…');
    try { setDoctor(await api.doctor()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'System check failed'); }
    finally { setBusy(''); }
  };
  const applyTopicPack = (pack: TopicPack) => {
    contextEditRevision.current += 1;
    setContextDescription(pack.description);
    setVocabularyText(uniqueLines(profile?.defaultVocabulary, pack.vocabulary).join('\n'));
    setShowProfile(false); setNotice(`Applied topic pack: ${pack.name}`);
  };
  const setAutoLoop = async (enabled: boolean) => {
    if (!profile) return;
    const preferences = { ...profile.preferences, autoLoopReview: enabled };
    setProfile({ ...profile, preferences });
    try { setProfile(await api.patchProfile({ preferences })); } catch { /* keep local */ }
  };
  const setAutoPlayNext = async (enabled: boolean) => {
    if (!profile) return;
    const preferences = { ...profile.preferences, autoPlayNextReview: enabled };
    setProfile({ ...profile, preferences });
    try { setProfile(await api.patchProfile({ preferences })); } catch { /* keep local */ }
  };
  const setReviewFocusMode = async (mode: 'brackets-label' | 'brackets' | 'off') => {
    if (!profile) return;
    const preferences = { ...profile.preferences, reviewFocusMode: mode };
    setProfile({ ...profile, preferences });
    try { setProfile(await api.patchProfile({ preferences })); } catch { /* keep local */ }
  };
  const saveWaveformPreference = async (value: { waveformMode?: 'waveform' | 'spectrum'; waveformZoom?: number }) => {
    if (!profile) return;
    const preferences = { ...profile.preferences, ...value };
    setProfile({ ...profile, preferences });
    try { setProfile(await api.patchProfile({ preferences })); } catch { /* keep local */ }
  };

  const rememberReplacement = async (line: string, scope: 'project' | 'global') => {
    if (!project || !profile) return;
    if (scope === 'global') {
      const defaultVocabulary = uniqueLines(profile.defaultVocabulary, [line]);
      setProfile(await api.patchProfile({ defaultVocabulary }));
      contextEditRevision.current += 1;
      setVocabularyText((current) => uniqueLines(current.split(/\r?\n/), [line]).join('\n'));
      setNotice('Replacement remembered globally.');
    } else {
      const vocabulary = uniqueLines(project.transcriptionContext?.vocabulary, [line]);
      const nextContext = { description: contextDescription.trim(), vocabulary };
      const ticket = projectScope.current.capture();
      const next = await api.saveContext(project.id, nextContext);
      if (!projectScope.current.isCurrent(ticket)) return;
      publishContextProject(next);
      contextEditRevision.current += 1;
      setVocabularyText(uniqueLines(profile.defaultVocabulary, vocabulary).join('\n'));
      setNotice('Replacement added to this project glossary.');
    }
  };

  const openHistory = async () => {
    if (!project) return;
    setShowHistory(true);
    try { setHistoryEntries(await api.history(project.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load history'); }
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
      const result = await queueSameMediaMutation(ticket, () => api.restoreHistory(targetProject.id, historyId));
      if (!result) return;
      const published = publishSameMediaMutation(
        result,
        ticket,
        editRevision,
        false,
        'History was restored on disk. Your newer caption edits remain unsaved in the editor.',
      );
      if (published === 'stale') return;
      setShowHistory(false);
      if (published === 'applied') setNotice('Earlier project version restored.');
    }
    catch (reason) { if (projectScope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : 'Restore failed'); }
    finally { if (projectScope.current.isCurrent(ticket)) setBusy(''); }
  };

  const isVideo = Boolean(project && isVideoProject(project));
  const timing = project?.transcript?.timing;
  const hasHybrid = Boolean(project?.transcript?.tokens?.length && timing && (timing.engine === 'kfa-local' || timing.engine === 'faster-whisper-local'));
  const legacy = Boolean(project?.transcript && !hasHybrid);
  const usedFallback = timing?.engine === 'faster-whisper-local';
  const timingConfigured = health?.timing.configured ?? true;

  const openReviewWorkspace = () => {
    setWorkspaceTool('review');
    setReviewMode(true);
    const id = riskyIds[0] || selection.ids[0] || draft[0]?.id;
    if (id) moveToReviewCaption(id, false);
  };
  const chooseWorkspaceTool = (tool: Exclude<WorkspaceTool, null>) => {
    cancelPlayback();
    if (tool === 'review') {
      if (workspaceTool === 'review') {
        setWorkspaceTool(null);
        setReviewMode(false);
      } else openReviewWorkspace();
      return;
    }
    setReviewMode(false);
    setWorkspaceTool((current) => current === tool ? null : tool);
  };

  const overlays = <>
    {profile && <CorrectionInbox profile={profile} open={showCorrections} busy={!!busy} onClose={() => setShowCorrections(false)} onOpenEvent={openCorrectionEvent} onAction={handleCorrectionAction}/>}
    {profile && llmSettings && <ProfileDoctor open={showProfile} initialTab={settingsTab} llmSettings={llmSettings} profile={profile} doctor={doctor} busy={!!busy} currentContext={project ? contextPayload() : null} onClose={() => setShowProfile(false)} onSave={saveProfilePatch} onImport={importProfile} onRunDoctor={runDoctor} onApplyPack={applyTopicPack} onSaveLlm={saveLlmSettings} onTestLlm={api.testLlmConnection} onForgetLlm={forgetLlmKey}/>}
    <FindReplacePanel open={showFindReplace} captions={draft} selectedIds={selection.ids} initialSearch={selection.captions.length === 1 ? selection.captions[0].text : ''} onClose={() => setShowFindReplace(false)} onApply={(next, message) => { updateDraft(next, undefined, 'text'); setNotice(message); }} onRemember={rememberReplacement}/>
    <HistoryPanel open={showHistory} entries={historyEntries} busy={!!busy} onClose={() => setShowHistory(false)} onRefresh={() => { if (project) void api.history(project.id).then(setHistoryEntries); }} onRestore={(id) => void restoreHistory(id)}/>
    <JobManager open={showJobs} jobs={jobs} onClose={() => setShowJobs(false)} onRefresh={() => void refreshJobs()} onResume={(id) => { trackedJobIds.current.add(id); handledJobIds.current.delete(id); void api.resumeJob(id).then(() => refreshJobs()); }} onCancel={(id) => void api.cancelJob(id).then(() => refreshJobs())} onOpen={(job) => void openJobResult(job)}/>
    <UpdatePanel open={showUpdates} safety={{ dirty, textEditing, reviewMode, proposalOpen: Boolean(proposal), busy: Boolean(busy), activeJobs: activeJobs.length }} onClose={() => setShowUpdates(false)} onError={setError} onNotice={setNotice}/>
    <NewUserGuide
      open={showGuide}
      project={project}
      llmConfigured={Boolean(llmSettings?.configured)}
      timingConfigured={timingConfigured}
      issueCount={issues.length}
      onClose={() => setShowGuide(false)}
      onConnect={() => { setShowGuide(false); openSettings('ai'); }}
      onOpenDoctor={() => { setShowGuide(false); openSettings('doctor'); window.setTimeout(() => void runDoctor(), 0); }}
      onGenerate={() => { setShowGuide(false); void generate(); }}
      onReview={() => { setShowGuide(false); openReviewWorkspace(); }}
      onContext={() => {
        setShowGuide(false);
        setWorkspaceTool('accuracy');
        setReviewMode(false);
        window.setTimeout(() => document.querySelector('.accuracy-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
      }}
      onExport={() => { setShowGuide(false); setReviewMode(false); setWorkspaceTool('export'); }}
    />
    {confirmationDialog}
  </>;

  const statusToasts = <div className="toast-stack" aria-live="polite" aria-atomic="false">
    {busy && <div className="toast"><LoaderCircle className="spin" size={16}/><span>{busy}</span></div>}
    {currentProjectToastJob && !showJobs && <button className="job-toast" onClick={() => setShowJobs(true)}><LoaderCircle className="spin" size={15}/><div><strong>{currentProjectToastJob.message}</strong><span>{currentProjectToastJob.progress}% · open activity</span></div></button>}
    {error && <div className="toast error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={14}/></button></div>}
    {replacementEditRecoveries.map((recovery) => <div key={recovery.id} className="toast notice replacement-edit-recovery" role="status"><span>Edits made while replacing <b>{recovery.sourceMedia.originalName}</b> belong to that previous media and were not applied to the replacement.</span><button className="toast-action" onClick={() => void copyReplacementEdits(recovery)}>Copy recovery</button><button aria-label={`Dismiss recovery for ${recovery.sourceMedia.originalName}`} onClick={() => setReplacementEditRecoveries((current) => current.filter((item) => item.id !== recovery.id))}><X size={14}/></button></div>)}
    {reviewUndo && <div className="toast notice review-undo-toast"><span>{reviewUndo.message}</span><button className="toast-action" onClick={undoReviewApproval}>Undo</button><button aria-label="Dismiss approval message" onClick={() => setReviewUndo(null)}><X size={14}/></button></div>}
    {notice && <div className="toast notice"><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={14}/></button></div>}
  </div>;

  if (!project) return <main>
    <div className="home-tools">
      <button onClick={() => setShowGuide(true)} title="Open the beginner guide"><HelpCircle size={16}/>Guide</button>
      {activeJobs.length > 0 && <button onClick={() => setShowJobs(true)}><ListTodo size={16}/>Activity<b>{activeJobs.length}</b></button>}
      {pendingCorrections > 0 && <button onClick={() => setShowCorrections(true)}><BookOpenCheck size={16}/>Corrections<b>{pendingCorrections}</b></button>}
      <button onClick={() => setShowUpdates(true)} title="Review signed Studio updates"><RefreshCw size={16}/>Check for updates</button>
      <button className={llmSettings?.configured ? '' : 'setup-needed'} title="Connection, profile, and system check" onClick={() => openSettings('ai')}><Settings2 size={16}/>Settings<span className={`connection-dot ${llmSettings?.configured ? 'ready' : 'missing'}`}/></button>
    </div>
    {!showFirstRun && llmSettings && !llmSettings.configured && <div className="ai-setup-banner"><div className="ai-setup-banner-icon"><KeyRound size={20}/></div><div><strong>Connect AI once</strong><span>Paste your key in Settings. Studio saves it securely for this Windows account.</span></div><button className="primary" onClick={() => openSettings('ai')}>Set up AI</button></div>}
    <Upload onUpload={upload} busy={!!busy || !profile} beforeDropzone={showFirstRun ? <HomeSetupChecklist llmConfigured={Boolean(llmSettings?.configured)} timingConfigured={timingConfigured} projectCount={projects.length} onConnect={() => openSettings('ai')} onOpenDoctor={() => { openSettings('doctor'); window.setTimeout(() => void runDoctor(), 0); }} onDismiss={() => { setShowFirstRun(false); try { localStorage.setItem(FIRST_RUN_DISMISSED_KEY, '1'); } catch { /* optional */ } }}/> : undefined}/>
    {health && !timingConfigured && <div className="setup-warning"><TriangleAlert size={16}/><span>Local timing is not ready yet. Open Settings → System check for the exact next step.</span></div>}
    {startupErrors.length > 0 && <div className="setup-warning" role="status"><span>Could not load: {startupErrors.join(', ')}. Other available tools can still be used.</span><button onClick={() => setStartupAttempt((value) => value + 1)}>Retry startup</button></div>}
    {!profile && startupErrors.length === 0 && <div className="setup-warning" role="status">Loading preferences…</div>}
    {projects.length > 0 && <section className="recent" aria-label="Recent projects"><div><strong>Recent projects</strong><span>Continue where you left off</span></div><div>{projects.slice(0, 6).map((item) => <button key={item.id} disabled={!!busy || !profile} aria-busy={openingProjectId === item.id} onClick={() => void openRecentProject(item.id)}><span>{item.title}</span><small>{openingProjectId === item.id ? 'Opening…' : item.captionCount ? `${item.captionCount} captions` : 'Not generated yet'}</small></button>)}</div></section>}
    {statusToasts}
    {overlays}
  </main>;

  return <main className="workspace">
    <header>
      <button className="back" aria-label="Back to projects" title="Back to projects" onClick={goHome}><ChevronLeft size={18}/></button>
      <div className="workspace-identity"><StudioBrand variant="compact" moduleLabel="Captions" moduleDescriptor=""/><span className="workspace-divider"/><div className="project-title"><strong>{project.title}</strong><span>{project.media.originalName} · {dirty ? autosaveState === 'saving' ? 'autosaving…' : 'autosave pending' : 'saved'}{project.transcriptNeedsSync ? ' · transcript regrouping needs refresh' : ''}</span></div></div>
      <input ref={replaceInput} hidden type="file" accept="video/*,audio/*" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; replaceMedia(file); }}/>
      <div className="header-actions">
        <button className={reviewMode ? 'selected-tool' : ''} title="Review captions worth checking" aria-pressed={reviewMode} onClick={() => chooseWorkspaceTool('review')}><ShieldCheck size={16}/><span>Review</span>{issues.length > 0 && <b className="tool-badge">{issues.length}</b>}</button>
        <WorkspaceToolsMenu
          activeJobs={activeJobs.length}
          pendingCorrections={pendingCorrections}
          llmConfigured={Boolean(llmSettings?.configured)}
          replaceDisabled={Boolean(currentProjectAnyActiveJob || busy)}
          onGuide={() => setShowGuide(true)}
          onCorrect={() => setShowFindReplace(true)}
          onHistory={() => void openHistory()}
          onJobs={() => setShowJobs(true)}
          onCorrections={() => setShowCorrections(true)}
          onReplace={() => replaceInput.current?.click()}
          onSettings={() => openSettings('ai')}
          onUpdates={() => setShowUpdates(true)}
        />
        <button className="save-action" disabled={!dirty || !!busy} title={dirty ? 'Save changes' : 'All changes saved'} onClick={() => void saveDraft(false, 'manual-save', true)}><Save size={16}/><span>{dirty ? 'Save' : 'Saved'}</span></button>
        <button className={`primary ${draft.length ? '' : 'disabled'} ${workspaceTool === 'export' ? 'selected-tool' : ''}`} title="Export SRT or a finished captioned video" aria-pressed={workspaceTool === 'export'} disabled={!draft.length || !!busy} onClick={() => chooseWorkspaceTool('export')}><Download size={16}/><span>Export</span></button>
      </div>
    </header>

    <section className="editor-grid">
      <div className={`stage-column ${proposal ? 'proposal-review-active' : workspaceTool ? 'workspace-tool-open' : 'workspace-tool-collapsed'}`}>
        <div className="media-stage">
          <SourceMedia key={`source:${mediaKey}`} src={project.media.url} video={isVideo} media={media}
            onLoadedMetadata={onLoadedMetadata} onTimeUpdate={onMediaTimeUpdate}
            onRetry={() => { setProposal(null); setQueuedSeekMs(null); setProposalLoop(false); setReviewMode(false); }}/>
          {isVideo && <NativeCaptionPreview key={`captions:${mediaKey}`} project={project} media={media} captions={videoCaptions} appearance={previewAppearance} interacting={appearanceInteracting} resolution={previewResolution} timeMs={time * 1000} reviewFocus={reviewFocusActive} focusLabel={reviewFocusMode === 'brackets-label'} focusKey={reviewFocusKey} focusIndices={reviewFocusIndices}/>}
          {isVideo && proposal && <div className={`preview-version-badge ${proposalPreviewMode}`}><span>{proposalPreviewMode === 'proposed' ? `Proposed · pass ${proposal.passNumber}` : 'Current captions'}</span></div>}
        </div>

        {proposal && <RegenerationReviewDock
          proposal={proposal}
          busy={!!busy}
          previewMode={proposalPreviewMode}
          loop={proposalLoop}
          editedText={proposalEditedText}
          accuracyHint={proposalAccuracyHint}
          refinementJob={refinementJob}
          onClose={() => { setProposal(null); setNotice('Regeneration review closed. You can reopen the completed proposal from Activity.'); }}
          onPreviewMode={setProposalPreviewMode}
          onLoop={setProposalLoop}
          onReplay={replayProposal}
          onSeek={seek}
          onEditedText={setProposalEditedText}
          onAccuracyHint={setProposalAccuracyHint}
          onApply={(mode, editedText) => void applyProposal(mode, editedText)}
          onRefine={(input) => void refineProposal(input)}
        />}

        {!proposal && <>
          {workspaceTool !== 'export' && <div className="workspace-tool-strip">
            <div className="workspace-tool-intro"><strong>{hasHybrid ? 'Choose one workspace tool' : 'Generate first, or add optional context'}</strong><span>{hasHybrid ? 'Advanced controls stay out of the way until you need them.' : 'The normal workflow works with the default settings.'}</span></div>
            <nav aria-label="Caption workspace tools">
              {hasHybrid && <button className={workspaceTool === 'review' ? 'active' : ''} aria-pressed={workspaceTool === 'review'} onClick={() => chooseWorkspaceTool('review')}><ShieldCheck size={16}/><span>Review</span>{issues.length > 0 && <b>{issues.length}</b>}</button>}
              {hasHybrid && <button className={workspaceTool === 'timeline' ? 'active' : ''} aria-pressed={workspaceTool === 'timeline'} onClick={() => chooseWorkspaceTool('timeline')}><TimerReset size={16}/><span>Fine timing</span></button>}
              <button className={workspaceTool === 'accuracy' ? 'active' : ''} aria-pressed={workspaceTool === 'accuracy'} onClick={() => chooseWorkspaceTool('accuracy')}><WandSparkles size={16}/><span>Accuracy</span><small>optional</small></button>
              {hasHybrid && <button className={workspaceTool === 'rhythm' ? 'active' : ''} aria-pressed={workspaceTool === 'rhythm'} onClick={() => chooseWorkspaceTool('rhythm')}><Languages size={16}/><span>Caption grouping</span></button>}
              {isVideo && draft.length > 0 && <button className={workspaceTool === 'appearance' ? 'active' : ''} aria-pressed={workspaceTool === 'appearance'} onClick={() => chooseWorkspaceTool('appearance')}><Palette size={16}/><span>Appearance</span></button>}
              {hasHybrid && <button className={workspaceTool === 'details' ? 'active' : ''} aria-pressed={workspaceTool === 'details'} onClick={() => chooseWorkspaceTool('details')}><Info size={16}/><span>Details</span></button>}
            </nav>
          </div>}

          {workspaceTool === 'export' && <ExportWorkspace key={`${project.id}:${project.media.filename}`}
            onPreviewResolution={setPreviewResolution}
            project={project}
            busy={Boolean(busy)}
            activeExportJob={activeExportJob}
            onExportSrt={() => void exportSrt()}
            onEditAppearance={() => chooseWorkspaceTool('appearance')}
            onStartVideoExport={startVideoExport}
          />}

          {workspaceTool === 'appearance' && isVideo && draft.length > 0 && <CaptionAppearanceWorkspace key={`${project.id}:${project.media.filename}`} project={project} onAppearanceChange={changeAppearance} onInteractionChange={setAppearanceInteracting} onConfirm={confirmInStudio}/>}

          {workspaceTool === 'timeline' && hasHybrid && <WaveformEditor
            projectId={project.id}
            captions={draft}
            tokens={project.transcript?.tokens || []}
            selectedIds={selection.ids}
            playheadMs={time * 1000}
            playbackRate={playbackRate}
            initialMode={profile?.preferences.waveformMode || 'waveform'}
            initialZoom={profile?.preferences.waveformZoom || 2}
            onSeek={seek}
            onSelect={(id) => selectCaption(id, false)}
            onBoundaryChange={(id, edge, valueMs) => updateDraft(draftRef.current.map((caption) => caption.id === id && !caption.timingLocked ? { ...caption, [edge === 'start' ? 'startMs' : 'endMs']: valueMs, timingSource: 'manual', timingQuality: 'medium', approved: false } : caption), id, 'timing')}
            onPlaybackRate={changePlaybackRate}
            onPreferenceChange={(value) => void saveWaveformPreference(value)}
          />}

          {workspaceTool === 'review' && hasHybrid && <div className="review-card review-active">
            <div className="review-score"><ShieldCheck size={22}/><div><strong>{readiness}% export readiness</strong><span>{issues.length ? `${issues.length} caption${issues.length === 1 ? '' : 's'} worth a quick check` : 'No automatic risks detected'}</span></div></div>
            <div className="review-selection"><b>{selection.captions.length ? rangeLabel(selection.startMs, selection.endMs) : 'No selection'}</b><span>{selection.captions.length} selected · {selection.captions.filter((caption) => caption.approved).length} approved</span></div>
            <div className="qa-profile-control"><label>Review profile<select value={profile?.preferences.qaProfileId || 'khmer-tiktok-comfortable'} onChange={(event) => void setQaProfile(event.target.value as QaProfileId)}>{Object.values(QA_PROFILES).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span>Checks reading speed, line length, and timing gaps.</span></div>
            <div className="review-actions review-primary-actions">
              <div className="review-nav-actions">
                <button onClick={() => selectRisk(-1)} disabled={!riskyIds.length || riskyIds.findIndex((id) => selection.ids.includes(id)) <= 0}><ChevronUp size={15}/>Previous</button>
                <button onClick={replaySelection} disabled={!selection.captions.length}><Play size={15}/>Replay</button>
                <button onClick={() => selectRisk(1, profile?.preferences.autoPlayNextReview ?? true)} disabled={!riskyIds.length || riskyIds.findIndex((id) => selection.ids.includes(id)) === riskyIds.length - 1}><ChevronDown size={15}/>Skip</button>
                <label className="review-autoplay-toggle"><input type="checkbox" checked={profile?.preferences.autoPlayNextReview ?? true} onChange={(event) => void setAutoPlayNext(event.target.checked)}/>Auto-play next</label>
              </div>
              <div className="review-decision-actions">
                <button className="regenerate-range review-improve" onClick={regenerateSelection} disabled={!selection.captions.length || !!currentProjectActiveJob}><RotateCcw size={15}/>Improve…</button>
                <button className="review-approve-next primary" onClick={approveAndNext} disabled={!selection.ids.length}><CheckCheck size={15}/>Approve &amp; next</button>
              </div>
            </div>
            <details className="advanced-review-tools"><summary>Playback, focus, locks, timing and shortcuts</summary><div className="review-actions"><label><input type="checkbox" checked={profile?.preferences.autoLoopReview ?? true} onChange={(event) => void setAutoLoop(event.target.checked)}/>Tight loop</label><button onClick={replaySelectionWithContext} disabled={!selection.captions.length} title="Include nearby speech"><Play size={15}/>Play with context</button><label htmlFor="review-focus-mode-select" className="review-focus-mode-control"><span>Review focus</span><select id="review-focus-mode-select" aria-label="Review focus" value={reviewFocusMode} onChange={(event) => void setReviewFocusMode(event.target.value as 'brackets-label' | 'brackets' | 'off')}><option value="brackets-label">Brackets + label</option><option value="brackets">Brackets only</option><option value="off">Off</option></select></label><button onClick={() => patchSelected({ textLocked: true }, 'Selected text locked.')} disabled={!selection.ids.length}><LockKeyhole size={15}/>Lock text</button><button onClick={() => patchSelected({ timingLocked: true }, 'Selected timing locked.')} disabled={!selection.ids.length}><Clock3 size={15}/>Lock timing</button><button onClick={() => patchSelected({ textLocked: false, timingLocked: false }, 'Selected captions unlocked.')} disabled={!selection.ids.length}>Unlock</button><button onClick={runTimingPostprocessor} disabled={!!busy}>Fix safe timing</button><button onClick={() => { setReviewMode(false); setWorkspaceTool(null); }}>Show all captions</button></div><div className="shortcut-strip"><Keyboard size={14}/><span>Enter / A approve &amp; next · R replay · S skip · ↑/↓ browse · E edit · J current · Alt+←/→ nudge · Ctrl+F correct · Ctrl+S save</span></div></details>
          </div>}

          {workspaceTool === 'accuracy' && <div className="accuracy-card">
            <div className="control-title"><strong>Accuracy context <em>optional</em></strong><span>Add this only when the clip contains unusual names, brands, versions, or mixed Khmer-English terms.</span></div>
            <label className="context-field"><span>What is this clip about?</span><textarea rows={3} value={contextDescription} onChange={(event) => { contextEditRevision.current += 1; setContextDescription(event.target.value); }} placeholder="Example: This video compares GPT 5.6 Luna and Terra. Preserve the exact model names."/></label>
            <label className="context-field"><span>Exact terms to preserve <b>{vocabularyLines.length}</b></span><textarea rows={5} value={vocabularyText} onChange={(event) => { contextEditRevision.current += 1; setVocabularyText(event.target.value); }} placeholder={'GPT 5.6 Luna\nGPT 5.6 Terra\nTerra | ថេរ៉ា\nOpenAI\nCapCut'}/></label>
            <div className="accuracy-help"><span>One term per line. Aliases use <code>Canonical | alias | phonetic alias</code>.</span><div className="accuracy-actions"><button disabled={!!busy} onClick={saveDefaultGlossary}>Save globally</button><button disabled={!!busy} onClick={saveContext}><Save size={15}/>Save for project</button>{hasHybrid && <button className="context-regenerate" disabled={!!currentProjectActiveJob || !timingConfigured} onClick={() => void generate()}><WandSparkles size={15}/>Preview full regeneration</button>}</div></div>
          </div>}

          {!hasHybrid && <div className={`transcribe-card ${legacy ? 'legacy' : ''}`}>
            <TimerReset size={28}/><div><strong>{legacy ? 'Rebuild with accurate local timing' : 'Ready to generate captions'}</strong><span>{legacy ? 'Older timing detected. Rebuild it with the current caption timing.' : 'Studio creates the Khmer text and syncs it to the audio.'}</span>{!timingConfigured && <em>Local timing is not ready. Open Settings → System check.</em>}</div><button className="primary" disabled={!!currentProjectActiveJob || !timingConfigured} onClick={() => void generate()}>{currentProjectActiveJob ? <LoaderCircle className="spin" size={18}/> : llmSettings?.configured ? <WandSparkles size={18}/> : <KeyRound size={18}/>} {!llmSettings?.configured ? 'Connect AI' : legacy ? 'Queue rebuild' : 'Generate captions'}</button>
          </div>}

          {workspaceTool === 'details' && hasHybrid && <div className="timing-card">
            <div className="timing-card-title"><CheckCircle2 size={18}/><div><strong>{usedFallback ? 'Local Whisper fallback active' : 'KFA Khmer alignment active'}</strong><span>Text: {project.transcript?.textModel || health?.geminiModel}{project.transcript?.textModelFallback ? ' (fallback)' : ''} · Timing: {timing?.model}{timing?.device ? ` · ${timing.device}` : ''}</span>{Boolean(project.transcript?.vocabularyTerms?.length) && <span className="vocab-status">{project.transcript?.vocabularyTerms?.length} protected terms · native bias {project.transcript?.nativeVocabularyBias ? 'on' : 'prompt-only'}</span>}</div></div>
            {usedFallback && timing?.fallbackReason && <div className="inline-warning"><TriangleAlert size={16}/><span>KFA could not align this clip, so Studio stayed local and used Whisper. {timing.fallbackReason}</span></div>}
            {project.transcriptNeedsSync && <div className="inline-warning"><TriangleAlert size={16}/><span>Text and canonical timing no longer fully match. Lock reviewed captions before regrouping.</span></div>}
            <div className="timing-metrics"><div><b>{Math.round((timing?.alignmentCoverage || 0) * 100)}%</b><span>anchored</span></div><div><b>{timing?.interpolatedTokens || 0}</b><span>interpolated</span></div><div><b>{timing?.lowConfidenceTokens || 0}</b><span>review</span></div><div><b>{Math.round((timing?.meanAlignmentScore || 0) * 100)}%</b><span>match score</span></div></div>
            {project.pipelineCache?.normalizedAudioCached && <div className="cache-strip"><CheckCircle2 size={14}/><span>Local processing checkpoints are ready, so interrupted jobs can resume without repeating completed stages.</span></div>}
          </div>}

          {workspaceTool === 'rhythm' && hasHybrid && <div className="controls-card">
            <div className="control-title"><strong>Caption grouping</strong><span>Choose a grouping and character limit, then apply them. Speech timing is not recalculated.</span></div>
            <div className="mode-grid">{modes.map((mode) => <button key={mode.id} className={groupingMode === mode.id ? 'selected' : ''}
              aria-pressed={groupingMode === mode.id} disabled={!!busy || groupingApplying} onClick={() => setGroupingMode(mode.id)}>
              <strong>{mode.label}</strong><span>{mode.desc}</span></button>)}</div>
            <label className="slider"><span>Target maximum characters <b>{maxChars}</b></span>
              <input type="range" min="6" max="44" value={maxChars} disabled={!!busy || groupingApplying || groupingMode === 'word'}
                aria-describedby="grouping-limit-help" onChange={(event) => setMaxChars(Number(event.target.value))}/></label>
            <p id="grouping-limit-help">This is a character limit, not a word count. Dynamic rhythm, pauses, duration and protected phrases can take priority. Word mode always shows one timed token.</p>
            <div className="preset-actions">
              <span>Current captions use {modes.find((mode) => mode.id === project.mode)?.label || project.mode}. Choose Apply grouping to update them. Locked captions are preserved and History keeps the previous captions.</span>
              <button className="primary" disabled={!!busy || groupingApplying || Boolean(currentProjectActiveJob)} onClick={() => void applyGrouping()}>
                {groupingApplying ? 'Applying grouping…' : 'Apply grouping'}</button>
              <button onClick={cleanKhmerSpacing} disabled={!!busy || groupingApplying}><Languages size={14}/>Clean Khmer spacing</button>
              <button onClick={saveStyle} disabled={!!busy || groupingApplying}>Save grouping preset</button>
              {profile?.styles.length ? <button onClick={applyStyle} disabled={!!busy || groupingApplying}>Apply saved grouping</button> : null}
            </div>
          </div>}
        </>}
      </div>

      <CaptionEditor ref={editor} captions={draft} active={active?.id || null} playheadMs={time * 1000} selectedIds={selection.ids} issues={issues} reviewMode={reviewMode} onChange={updateDraft} onSeek={seek} onSelect={selectCaption} onTextCommit={() => void saveDraft(true, 'text-edit', true)} onEditCommit={() => { if (reviewMode && selection.captions.length) schedulePlayback(replaySelection); }} onEditingChange={setTextEditing}/>
    </section>

    {statusToasts}
    {overlays}
  </main>;
}
