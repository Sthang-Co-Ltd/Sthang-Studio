import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppProfile,
  CaptionAppearance,
  CaptionMode,
  CaptionProject,
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
import { api, type HealthResponse, type LlmConnectionTest, type LlmSettingsStatus, type SaveLlmSettingsInput } from './api';
import { Upload } from './components/Upload';
import { CaptionEditor, type CaptionEditorHandle, type DraftChangeReason } from './components/CaptionEditor';
import { CorrectionInbox } from './components/CorrectionInbox';
import { ProfileDoctor, type SettingsTab } from './components/ProfileDoctor';
import { StudioBrand } from './components/Brand';
import { WaveformEditor } from './components/WaveformEditor';
import { FindReplacePanel } from './components/FindReplacePanel';
import { RegenerationReviewDock } from './components/RegenerationReviewDock';
import { HomeSetupChecklist, NewUserGuide } from './components/NewUserGuide';
import { HistoryPanel } from './components/HistoryPanel';
import { JobManager } from './components/JobManager';
import { WorkspaceToolsMenu } from './components/WorkspaceToolsMenu';
import { UpdatePanel } from './components/UpdatePanel';
import { ExportWorkspace } from './components/ExportWorkspace';
import { CaptionAppearanceWorkspace } from './components/CaptionAppearanceWorkspace';
import { useStudioConfirm } from './components/ConfirmationDialog';
import { analyzeCaptions, exportReadiness, QA_PROFILES, resolveQaProfile } from './review';
import { captionTextForEditing } from './caption-text';
import './styles.css';

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

function captionsText(captions: CaptionSegment[]) {
  return captionTextForEditing(captions);
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
  const [projects, setProjects] = useState<CaptionProject[]>([]);
  const [project, setProject] = useState<CaptionProject | null>(null);
  const [draft, setDraft] = useState<CaptionSegment[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [llmSettings, setLlmSettings] = useState<LlmSettingsStatus | null>(null);
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [doctor, setDoctor] = useState<SystemDoctorReport | null>(null);
  const [time, setTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [maxChars, setMaxChars] = useState(18);
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
  const [proposal, setProposal] = useState<RegenerationProposal | null>(null);
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
  const dirtyRef = useRef(false);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const queuedCaption = useRef<string | null>(null);
  const trackedJobIds = useRef(new Set<string>());
  const handledJobIds = useRef(new Set<string>());
  const lastChangeReason = useRef<DraftChangeReason>('metadata');
  const aiOnboardingShown = useRef(false);
  const reviewPlaybackPass = useRef<ReviewPlaybackPass>('focus');

  useEffect(() => {
    Promise.all([api.list(), api.health(), api.profile(), api.jobs(), api.llmSettings()])
      .then(([projectList, healthResult, profileResult, jobList, llmResult]) => {
        setProjects(projectList);
        setHealth(healthResult);
        setProfile(profileResult);
        setJobs(jobList);
        setLlmSettings(llmResult);
        jobList.filter((job) => ['queued', 'running', 'interrupted'].includes(job.status)).forEach((job) => trackedJobIds.current.add(job.id));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'App startup failed'));
  }, []);

  useEffect(() => {
    if (!llmSettings || llmSettings.configured || aiOnboardingShown.current) return;
    aiOnboardingShown.current = true;
    setSettingsTab('ai');
    setShowProfile(true);
  }, [llmSettings]);

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
    setReviewMode(false);
    setReviewUndo(null);
    setContextDescription(project.transcriptionContext?.description || '');
    setVocabularyText(uniqueLines(profile?.defaultVocabulary, project.transcriptionContext?.vocabulary).join('\n'));
    const style = profile?.styles.find((item) => item.id === 'my-tiktok-style') || profile?.styles[0];
    if (style) setMaxChars(style.maxChars);
    const requested = queuedCaption.current;
    const first = requested && initialDraft.some((caption) => caption.id === requested) ? requested : initialDraft[0]?.id || null;
    queuedCaption.current = null;
    setSelectionAnchor(first);
    setSelectionEnd(first);
  }, [project?.id]);

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
    setProposalEditedText(captionsText(proposal.proposedCaptions));
    setProposalAccuracyHint(proposal.accuracyHint || '');
    const preRoll = profile?.preferences.reviewPreRollMs ?? 450;
    window.setTimeout(() => {
      if (!media.current) return;
      media.current.currentTime = Math.max(0, proposal.startMs - preRoll) / 1000;
    }, 0);
  }, [proposal?.id]);

  const applyProject = (next: CaptionProject, replaceDraft = true) => {
    setProject(next);
    setProjects((items) => [next, ...items.filter((item) => item.id !== next.id)]);
    if (replaceDraft) {
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

  const updateDraft = (next: CaptionSegment[], preferredSelectionId?: string, reason: DraftChangeReason = 'metadata') => {
    setDraft(next);
    draftRef.current = next;
    draftVersion.current += 1;
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

  const selection = useMemo(() => {
    if (!draft.length) return { ids: [] as string[], captions: [] as CaptionSegment[], startMs: 0, endMs: 0 };
    const playheadMs = time * 1000;
    const nearestIndexRaw = draft.findIndex((caption) => playheadMs < caption.endMs);
    const nearestIndex = nearestIndexRaw >= 0 ? nearestIndexRaw : draft.length - 1;
    const firstIndexRaw = draft.findIndex((caption) => caption.id === selectionAnchor);
    const firstIndex = firstIndexRaw >= 0 ? firstIndexRaw : nearestIndex;
    const lastIndexRaw = draft.findIndex((caption) => caption.id === selectionEnd);
    const lastIndex = lastIndexRaw >= 0 ? lastIndexRaw : firstIndex;
    const start = Math.min(firstIndex, lastIndex);
    const end = Math.max(firstIndex, lastIndex);
    const captions = draft.slice(start, end + 1);
    return { ids: captions.map((caption) => caption.id), captions, startMs: captions[0]?.startMs || 0, endMs: captions.at(-1)?.endMs || 0 };
  }, [draft, selectionAnchor, selectionEnd, time]);

  const active = useMemo(() => draft.find((caption) => time * 1000 >= caption.startMs && time * 1000 < caption.endMs) ?? null, [draft, time]);
  const proposedPreviewRange = useMemo(() => {
    if (!proposal) return [] as CaptionSegment[];
    const original = captionsText(proposal.proposedCaptions);
    if (!proposalEditedText.trim() || proposalEditedText.trim() === original.trim()) return proposal.proposedCaptions;
    return distributePreviewText(proposalEditedText, proposal.proposedCaptions);
  }, [proposal, proposalEditedText]);
  const videoCaptions = useMemo(() => {
    if (!proposal || proposalPreviewMode === 'current') return draft;
    const outside = draft.filter((caption) => caption.endMs <= proposal.startMs || caption.startMs >= proposal.endMs);
    return [...outside, ...proposedPreviewRange].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  }, [draft, proposal, proposalPreviewMode, proposedPreviewRange]);
  const videoActive = useMemo(() => videoCaptions.find((caption) => time * 1000 >= caption.startMs && time * 1000 < caption.endMs) ?? null, [videoCaptions, time]);
  const reviewFocusMode = profile?.preferences.reviewFocusMode || 'brackets-label';
  const reviewFocusActive = useMemo(() => {
    if (!reviewMode || reviewFocusMode === 'off' || !videoActive) return false;
    const playheadMs = time * 1000;
    if (proposal) return playheadMs >= proposal.startMs && playheadMs < proposal.endMs;
    return selection.captions.some((caption) => playheadMs >= caption.startMs && playheadMs < caption.endMs);
  }, [reviewMode, reviewFocusMode, videoActive, time, proposal, selection.captions]);
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
    setBusy(label);
    setError('');
    try {
      const result = await operation();
      applyProject(result);
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Something went wrong');
      return null;
    } finally { setBusy(''); }
  };

  const refreshProfile = async () => {
    try { setProfile(await api.profile()); } catch { /* optional */ }
  };

  const saveDraft = (
    silent = false,
    source: 'manual-save' | 'autosave' | 'text-edit' = 'manual-save',
    recordCorrections = source !== 'autosave',
  ): Promise<CaptionProject | null> => {
    if (!project || (!dirtyRef.current && silent)) return Promise.resolve(null);
    const targetProject = project;
    const snapshot = draftRef.current;
    const version = draftVersion.current;

    const execute = async () => {
      if (!silent) { setBusy('Saving captions…'); setError(''); }
      if (source === 'autosave') setAutosaveState('saving');
      try {
        const result = await api.saveCaptions(targetProject.id, snapshot, { source, recordCorrections });
        const unchanged = version === draftVersion.current;
        if (unchanged) applyProject(result.project, true);
        else {
          setProject((current) => current?.id === result.project.id ? { ...result.project, captions: draftRef.current } : current);
          setProjects((items) => [result.project, ...items.filter((item) => item.id !== result.project.id)]);
        }
        if (result.correctionsCreated > 0) {
          await refreshProfile();
          setNotice(`${result.correctionsCreated} correction${result.correctionsCreated === 1 ? '' : 's'} captured in the Inbox.`);
        } else if (!silent) setNotice('Captions saved.');
        if (unchanged) {
          setDirty(false);
          dirtyRef.current = false;
          setAutosaveState('saved');
        }
        return result.project;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Save failed');
        setAutosaveState('pending');
        return null;
      } finally { if (!silent) setBusy(''); }
    };

    const task = saveQueue.current.then(execute, execute);
    saveQueue.current = task.then(() => undefined, () => undefined);
    return task;
  };

  useEffect(() => {
    if (!project || !dirty || textEditing) return;
    const delay = profile?.preferences.autosaveDelayMs ?? 2200;
    const timer = window.setTimeout(() => { void saveDraft(true, 'autosave', false); }, delay);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, textEditing, project?.id, profile?.preferences.autosaveDelayMs]);

  const refreshJobs = async () => {
    try { setJobs(await api.jobs()); } catch { /* queue is optional during startup */ }
  };

  const openJobResult = async (job: ProcessingJob) => {
    setError('');
    try {
      if (job.proposalId) {
        const target = project?.id === job.projectId ? project : await api.get(job.projectId);
        if (project?.id !== target.id) applyProject(target);
        setProposal(await api.regenerationProposal(job.projectId, job.proposalId));
        setShowJobs(false);
        setNotice('Regeneration preview opened. Current captions remain untouched until you approve it.');
      } else if (job.resultProjectId) {
        const result = await api.get(job.resultProjectId);
        applyProject(result);
        setShowJobs(false);
        setNotice('Completed caption job opened.');
      }
      handledJobIds.current.add(job.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open the job result');
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
          if (job.proposalId) {
            void api.regenerationProposal(job.projectId, job.proposalId)
              .then((value) => { setProposal(value); setShowJobs(false); setNotice('Regeneration preview ready. Review it before applying.'); })
              .catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not open regeneration preview'));
          } else if (job.resultProjectId) {
            void api.get(job.resultProjectId).then((value) => {
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
    setError('');
    try {
      const job = await operation();
      trackedJobIds.current.add(job.id);
      handledJobIds.current.delete(job.id);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      if (openQueue) setShowJobs(true);
      setNotice(message);
      return job;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start processing job');
      return null;
    }
  };

  const seek = (ms: number) => { if (media.current) media.current.currentTime = Math.max(0, ms) / 1000; };
  const reviewLeadMs = (pass: ReviewPlaybackPass) => {
    const configured = profile?.preferences.reviewPreRollMs ?? 450;
    return pass === 'context' ? configured : Math.min(configured, 140);
  };
  const reviewTailMs = (pass: ReviewPlaybackPass) => {
    const configured = profile?.preferences.reviewPostRollMs ?? 300;
    return pass === 'context' ? configured : Math.min(configured, 120);
  };
  const replayProposal = (focusMs?: number) => {
    if (!media.current || !proposal) return;
    const preRoll = profile?.preferences.reviewPreRollMs ?? 450;
    const start = typeof focusMs === 'number' ? focusMs : proposal.startMs;
    media.current.currentTime = Math.max(0, start - preRoll) / 1000;
    media.current.play().catch(() => {});
  };
  const playReviewSelection = (pass: ReviewPlaybackPass = 'focus') => {
    if (!media.current || !selection.captions.length) return;
    reviewPlaybackPass.current = pass;
    media.current.currentTime = Math.max(0, selection.startMs - reviewLeadMs(pass)) / 1000;
    media.current.play().catch(() => {});
  };
  const replaySelection = () => playReviewSelection('focus');
  const replaySelectionWithContext = () => playReviewSelection('context');
  const selectCaption = (id: string, extend: boolean) => {
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
    window.setTimeout(() => {
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
      if (typing || !project) return;
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
  const onLoadedMetadata = () => {
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

  const upload = async (file: File, title: string) => runProject('Uploading…', () => api.create(file, title));
  const replaceMedia = (file?: File) => { if (file && project) void runProject('Replacing media…', () => api.replaceMedia(project.id, file)); };
  const generate = async () => {
    if (!project) return;
    if (!llmSettings?.configured) {
      setError('Connect AI in Settings → AI connection before generating captions.');
      openSettings('ai');
      return;
    }
    const hadUnsavedEdits = dirtyRef.current;
    const saved = await saveDraft(true, 'manual-save', true);
    if (hadUnsavedEdits && !saved) return;
    const fullDuration = project.transcript?.timing?.audioDurationMs;
    if (project.transcript?.tokens?.length && fullDuration) {
      await startJob(() => api.startRegenerationJob(project.id, 0, fullDuration, contextPayload()), 'Full regeneration queued. Current captions stay untouched until you approve the diff.');
    } else {
      await startJob(() => api.startTranscribeJob(project.id, contextPayload(), Boolean(project.transcript)), 'Caption generation queued. You can keep the browser open or return later.');
    }
  };
  const saveContext = () => { if (project) void runProject('Saving accuracy context…', () => api.saveContext(project.id, contextPayload())); };

  const saveDefaultGlossary = async () => {
    if (!profile) return;
    setBusy('Saving global glossary…');
    try { setProfile(await api.patchProfile({ defaultVocabulary: vocabularyLines })); setNotice('Global glossary saved.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Glossary save failed'); }
    finally { setBusy(''); }
  };
  const saveStyle = async () => {
    if (!profile || !project) return;
    const next = { id: 'my-tiktok-style', name: 'My TikTok Style', mode: project.mode, maxChars };
    const styles = [...profile.styles];
    const index = styles.findIndex((style) => style.id === next.id);
    if (index >= 0) styles[index] = next; else styles.unshift(next);
    try { setProfile(await api.patchProfile({ styles })); setNotice('Caption grouping saved to your transferable profile.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Grouping save failed'); }
  };
  const applyStyle = () => {
    if (!project || !profile) return;
    const style = profile.styles.find((item) => item.id === 'my-tiktok-style') || profile.styles[0];
    if (!style) return;
    setMaxChars(style.maxChars);
    void runProject('Applying saved caption grouping…', () => api.resegment(project.id, style.mode, style.maxChars));
  };

  const regenerateSelection = async () => {
    if (!project || !selection.captions.length) return;
    if (!llmSettings?.configured) {
      setError('Connect AI before asking for another take. Exact wording can still refresh timing without AI.');
      openSettings('ai');
      return;
    }
    if (selection.endMs - selection.startMs > 90_000) {
      const confirmed = await confirmInStudio({
        title: 'Build a long regeneration preview?',
        message: 'This selection is over 90 seconds, so comparing another take may take noticeably longer. Your current captions stay untouched until you approve the result.',
        confirmLabel: 'Build preview',
      });
      if (!confirmed) return;
    }
    const hadUnsavedEdits = dirtyRef.current;
    const saved = await saveDraft(true, 'manual-save', true);
    if (hadUnsavedEdits && !saved) return;
    await startJob(
      () => api.startRegenerationJob(project.id, selection.startMs, selection.endMs, contextPayload()),
      `Regeneration preview queued for ${rangeLabel(selection.startMs, selection.endMs)}.`,
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
    setBusy(mode === 'reject' ? 'Discarding proposal…' : 'Applying approved regeneration…');
    setError('');
    try {
      const result = await api.applyRegenerationProposal(project.id, proposal.id, mode, editedText);
      applyProject(result);
      setProposal(null);
      setNotice(mode === 'reject' ? 'Proposal discarded. Current captions were kept.' : `Regeneration applied: ${mode.replace('-', ' ')}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not apply regeneration'); }
    finally { setBusy(''); }
  };

  const cleanKhmerSpacing = async () => {
    if (!project) return;
    setBusy('Cleaning Khmer spacing…'); setError('');
    try {
      const hadUnsavedEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (hadUnsavedEdits && !saved) return;
      const result = await api.normalizeKhmerSpacing(project.id);
      applyProject(result);
      setNotice('Khmer word spacing cleaned. Text-locked captions were preserved.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Khmer spacing cleanup failed'); }
    finally { setBusy(''); }
  };

  const runTimingPostprocessor = async () => {
    if (!project) return;
    const confirmed = await confirmInStudio({
      title: 'Apply safe timing cleanup?',
      message: `Studio will use “${qaSettings.name}”, skip timing-locked captions, and create a History checkpoint before changing timing.`,
      confirmLabel: 'Apply cleanup',
    });
    if (!confirmed) return;
    setBusy('Snapping and smoothing caption timing…');
    try {
      const hadUnsavedEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (hadUnsavedEdits && !saved) return;
      applyProject(await api.postprocessTiming(project.id, qaSettings));
      setNotice('Safe timing cleanup applied. Restore it from History if needed.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Timing cleanup failed'); }
    finally { setBusy(''); }
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
    window.setTimeout(() => moveToReviewCaption(restoreId, false), 20);
    setNotice('Approval undone.');
  };

  const exportSrt = async () => {
    if (!project) return;
    const severe = issues.filter((issue) => issue.severity !== 'info').length;
    if (severe > 0) {
      const confirmed = await confirmInStudio({
        title: 'Export with review warnings?',
        message: `${severe} timing/format warning${severe === 1 ? '' : 's'} remain under “${qaSettings.name}”. SRT can still be exported with the current text and timing.`,
        confirmLabel: 'Export SRT',
      });
      if (!confirmed) return;
    }
    setBusy('Saving & exporting…'); setError('');
    try {
      const hadUnsavedEdits = dirtyRef.current;
      const saved = await saveDraft(true, 'manual-save', true);
      if (hadUnsavedEdits && !saved) return;
      const anchor = document.createElement('a');
      anchor.href = `/api/projects/${project.id}/export.srt`; anchor.download = '';
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setNotice('SRT export started. It includes caption text and timing; visual styling is set in your editing app.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Export failed'); }
    finally { setBusy(''); }
  };

  const saveCaptionAppearance = async (appearance: CaptionAppearance) => {
    if (!project) return;
    setError('');
    try {
      const next = await api.saveCaptionAppearance(project.id, appearance);
      applyProject(next, false);
      setNotice('Caption appearance saved for this project. SRT output remains unchanged.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save caption appearance');
      throw reason;
    }
  };

  const startVideoExport = async (settings: VideoExportSettings, appearance: CaptionAppearance): Promise<ProcessingJob | null> => {
    if (!project) return null;
    const severe = issues.filter((issue) => issue.severity !== 'info').length;
    if (severe > 0) {
      const confirmed = await confirmInStudio({
        title: 'Render with review warnings?',
        message: `${severe} timing/format warning${severe === 1 ? '' : 's'} remain under “${qaSettings.name}”. Studio can render anyway, but the finished video will use the current caption text and timing.`,
        confirmLabel: 'Render anyway',
      });
      if (!confirmed) return null;
    }
    const hadUnsavedEdits = dirtyRef.current;
    const saved = await saveDraft(true, 'manual-save', true);
    if (hadUnsavedEdits && !saved) return null;
    return startJob(
      () => api.startVideoExportJob(project.id, settings, appearance),
      'Captioned video export queued. Studio saved a caption/settings snapshot, so you can keep editing while it renders.',
      false,
    );
  };

  const handleCorrectionAction = async (event: CorrectionEvent, action: 'remember-global' | 'add-project' | 'ignore') => {
    setBusy('Updating correction memory…'); setError('');
    try {
      const result = await api.correctionAction(event.id, action);
      setProfile(result.profile);
      if (result.project) {
        setProjects((items) => [result.project!, ...items.filter((item) => item.id !== result.project!.id)]);
        if (project?.id === result.project.id) {
          setProject(result.project);
          setVocabularyText(uniqueLines(result.profile.defaultVocabulary, result.project.transcriptionContext?.vocabulary).join('\n'));
        }
      }
      if (action === 'remember-global') {
        setVocabularyText((current) => uniqueLines(current.split(/\r?\n/), [event.suggestedVocabularyLine]).join('\n'));
        setNotice('Correction remembered globally.');
      } else if (action === 'add-project') setNotice('Correction added to that project’s glossary.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Correction action failed'); }
    finally { setBusy(''); }
  };
  const openCorrectionEvent = async (event: CorrectionEvent) => {
    setShowCorrections(false); setBusy('Opening correction audio…');
    try {
      const target = await api.get(event.projectId);
      const switchingProject = project?.id !== target.id;
      if (switchingProject) queuedCaption.current = event.captionId;
      applyProject(target); setReviewMode(true);
      if (!switchingProject) { setSelectionAnchor(event.captionId); setSelectionEnd(event.captionId); }
      setQueuedSeekMs(event.startMs);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not open correction project'); }
    finally { setBusy(''); }
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
  const testLlmSettings = async (input: { apiKey?: string; model?: string }): Promise<LlmConnectionTest> => api.testLlmConnection(input);
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
      setVocabularyText((current) => uniqueLines(current.split(/\r?\n/), [line]).join('\n'));
      setNotice('Replacement remembered globally.');
    } else {
      const vocabulary = uniqueLines(project.transcriptionContext?.vocabulary, [line]);
      const nextContext = { description: contextDescription.trim(), vocabulary };
      const next = await api.saveContext(project.id, nextContext);
      setProject(next);
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
    const confirmed = await confirmInStudio({
      title: 'Restore this checkpoint?',
      message: 'Studio saves your current state as another History entry first, so you can still return to it later.',
      confirmLabel: 'Restore checkpoint',
    });
    if (!confirmed) return;
    setBusy('Restoring project history…');
    try { applyProject(await api.restoreHistory(project.id, historyId)); setShowHistory(false); setNotice('Earlier project version restored.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Restore failed'); }
    finally { setBusy(''); }
  };

  const isVideo = Boolean(project && (project.media.mimeType.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(project.media.originalName)));
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
    {profile && llmSettings && <ProfileDoctor open={showProfile} initialTab={settingsTab} llmSettings={llmSettings} profile={profile} doctor={doctor} busy={!!busy} currentContext={project ? contextPayload() : null} onClose={() => setShowProfile(false)} onSave={saveProfilePatch} onImport={importProfile} onRunDoctor={runDoctor} onApplyPack={applyTopicPack} onSaveLlm={saveLlmSettings} onTestLlm={testLlmSettings} onForgetLlm={forgetLlmKey}/>}
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
    <Upload onUpload={upload} busy={!!busy} beforeDropzone={showFirstRun ? <HomeSetupChecklist llmConfigured={Boolean(llmSettings?.configured)} timingConfigured={timingConfigured} projectCount={projects.length} onConnect={() => openSettings('ai')} onOpenDoctor={() => { openSettings('doctor'); window.setTimeout(() => void runDoctor(), 0); }} onDismiss={() => { setShowFirstRun(false); try { localStorage.setItem(FIRST_RUN_DISMISSED_KEY, '1'); } catch { /* optional */ } }}/> : undefined}/>
    {health && !timingConfigured && <div className="setup-warning"><TriangleAlert size={16}/><span>Local timing is not ready yet. Open Settings → System check for the exact next step.</span></div>}
    {projects.length > 0 && <section className="recent" aria-label="Recent projects"><div><strong>Recent projects</strong><span>Continue where you left off</span></div><div>{projects.slice(0, 6).map((item) => <button key={item.id} onClick={() => setProject(item)}><span>{item.title}</span><small>{item.captions.length ? `${item.captions.length} captions` : 'Not generated yet'}</small></button>)}</div></section>}
    {statusToasts}
    {overlays}
  </main>;

  return <main className="workspace">
    <header>
      <button className="back" aria-label="Back to projects" title="Back to projects" onClick={() => setProject(null)}><ChevronLeft size={18}/></button>
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
          {isVideo
            ? <video ref={(element: HTMLVideoElement | null) => { media.current = element; }} src={project.media.url} controls onLoadedMetadata={onLoadedMetadata} onTimeUpdate={(event) => onMediaTimeUpdate(event.currentTarget)}/>
            : <audio ref={(element: HTMLAudioElement | null) => { media.current = element; }} src={project.media.url} controls onLoadedMetadata={onLoadedMetadata} onTimeUpdate={(event) => onMediaTimeUpdate(event.currentTarget)}/>} 
          {isVideo && videoActive && <div className="caption-preview-shell">
            <div className={`caption-preview-target ${reviewFocusActive ? 'review-focus-active' : ''}`}>
              <div className={`caption-preview ${proposal && proposalPreviewMode === 'proposed' ? 'proposal-preview' : ''}`}>{videoActive.text}</div>
              {reviewFocusActive && <div key={reviewFocusKey} className="review-focus-frame" aria-hidden="true">
                {reviewFocusMode === 'brackets-label' && <span className="review-focus-label">Reviewing</span>}
                <i className="review-focus-corner review-focus-tl"/><i className="review-focus-corner review-focus-tr"/><i className="review-focus-corner review-focus-bl"/><i className="review-focus-corner review-focus-br"/>
              </div>}
            </div>
          </div>}
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

          {workspaceTool === 'export' && <ExportWorkspace
            project={project}
            sampleText={selection.captions[0]?.text || videoActive?.text || draft[0]?.text || ''}
            busy={Boolean(busy)}
            activeExportJob={activeExportJob}
            onExportSrt={() => void exportSrt()}
            onSaveAppearance={saveCaptionAppearance}
            onEditAppearance={() => chooseWorkspaceTool('appearance')}
            onStartVideoExport={startVideoExport}
          />}

          {workspaceTool === 'appearance' && isVideo && draft.length > 0 && <CaptionAppearanceWorkspace project={project}/>}

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
            <details className="advanced-review-tools"><summary>Playback, focus, locks, timing and shortcuts</summary><div className="review-actions"><label><input type="checkbox" checked={profile?.preferences.autoLoopReview ?? true} onChange={(event) => void setAutoLoop(event.target.checked)}/>Tight loop</label><button onClick={replaySelectionWithContext} disabled={!selection.captions.length} title="Include nearby speech"><Play size={15}/>Play with context</button><label className="review-focus-mode-control"><span>Review focus</span><select value={reviewFocusMode} onChange={(event) => void setReviewFocusMode(event.target.value as 'brackets-label' | 'brackets' | 'off')}><option value="brackets-label">Brackets + label</option><option value="brackets">Brackets only</option><option value="off">Off</option></select></label><button onClick={() => patchSelected({ textLocked: true }, 'Selected text locked.')} disabled={!selection.ids.length}><LockKeyhole size={15}/>Lock text</button><button onClick={() => patchSelected({ timingLocked: true }, 'Selected timing locked.')} disabled={!selection.ids.length}><Clock3 size={15}/>Lock timing</button><button onClick={() => patchSelected({ textLocked: false, timingLocked: false }, 'Selected captions unlocked.')} disabled={!selection.ids.length}>Unlock</button><button onClick={runTimingPostprocessor} disabled={!!busy}>Fix safe timing</button><button onClick={() => { setReviewMode(false); setWorkspaceTool(null); }}>Show all captions</button></div><div className="shortcut-strip"><Keyboard size={14}/><span>Enter / A approve &amp; next · R replay · S skip · ↑/↓ browse · E edit · J current · Alt+←/→ nudge · Ctrl+F correct · Ctrl+S save</span></div></details>
          </div>}

          {workspaceTool === 'accuracy' && <div className="accuracy-card">
            <div className="control-title"><strong>Accuracy context <em>optional</em></strong><span>Add this only when the clip contains unusual names, brands, versions, or mixed Khmer-English terms.</span></div>
            <label className="context-field"><span>What is this clip about?</span><textarea rows={3} value={contextDescription} onChange={(event) => setContextDescription(event.target.value)} placeholder="Example: This video compares GPT 5.6 Luna and Terra. Preserve the exact model names."/></label>
            <label className="context-field"><span>Exact terms to preserve <b>{vocabularyLines.length}</b></span><textarea rows={5} value={vocabularyText} onChange={(event) => setVocabularyText(event.target.value)} placeholder={'GPT 5.6 Luna\nGPT 5.6 Terra\nTerra | ថេរ៉ា\nOpenAI\nCapCut'}/></label>
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

          {workspaceTool === 'rhythm' && hasHybrid && <div className="controls-card"><div className="control-title"><strong>Caption grouping</strong><span>Change how much caption text appears at once without recalculating speech timing. Visual styling is set in your editing app.</span></div><div className="mode-grid">{modes.map((mode) => <button key={mode.id} className={project.mode === mode.id ? 'selected' : ''} disabled={!!busy} onClick={() => void runProject('Regrouping timed words…', () => api.resegment(project.id, mode.id, maxChars))}><strong>{mode.label}</strong><span>{mode.desc}</span></button>)}</div><label className="slider"><span>Target maximum characters <b>{maxChars}</b></span><input type="range" min="6" max="44" value={maxChars} onChange={(event) => setMaxChars(Number(event.target.value))}/></label><div className="preset-actions"><span>Reuse the same grouping across projects, or clean artificial Khmer spaces without changing timing.</span><button onClick={cleanKhmerSpacing} disabled={!!busy}><Languages size={14}/>Clean Khmer spacing</button><button onClick={saveStyle}>Save grouping</button>{profile?.styles.length ? <button onClick={applyStyle}>Apply saved grouping</button> : null}</div></div>}
        </>}
      </div>

      <CaptionEditor ref={editor} captions={draft} active={active?.id || null} playheadMs={time * 1000} selectedIds={selection.ids} issues={issues} reviewMode={reviewMode} onChange={updateDraft} onSeek={seek} onSelect={selectCaption} onTextCommit={() => void saveDraft(true, 'text-edit', true)} onEditCommit={() => { if (reviewMode && selection.captions.length) window.setTimeout(replaySelection, 0); }} onEditingChange={setTextEditing}/>
    </section>

    {statusToasts}
    {overlays}
  </main>;
}
