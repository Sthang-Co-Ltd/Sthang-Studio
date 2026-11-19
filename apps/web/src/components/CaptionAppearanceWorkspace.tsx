import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import {
  applyCaptionLook,
  DEFAULT_CAPTION_APPEARANCE,
  normalizeCaptionAppearance,
  type CaptionAppearance,
  type CaptionAppearancePreset,
  type CaptionLookId,
  type CaptionProject,
  type CaptionSegment,
  type VideoExportFontCapability,
} from '@kcs/shared';
import { CheckCircle2, LoaderCircle, Play, Plus, Redo2, RotateCcw, Save, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import { api } from '../api';
import { projectMediaKey } from '../project-scope';
import { useAppearanceInteraction } from '../use-appearance-interaction';
import { flushCaptionAppearanceSaves, getCaptionAppearanceSaveState, markCaptionAppearanceDraft, observeSavedCaptionAppearance, queueCaptionAppearanceSave, recoverUnsavedCaptionAppearance, subscribeCaptionAppearanceSaves, waitForCaptionAppearanceSaves } from '../caption-appearance-save';
import { CaptionLooksGallery } from './CaptionLooksGallery';
import { AppearanceRange } from './AppearanceRange';
import { FontSearch } from './FontSearch';
import type { StudioConfirmOptions } from './ConfirmationDialog';
import { WordHighlightPreparation, type WordHighlightPreparationView } from './WordHighlightPreparation';
import './caption-appearance.css';
import './caption-effects.css';
import './word-highlight.css';
import './appearance-option-group.css';

type AppearanceSaveState = 'saved' | 'pending' | 'saving' | 'error';

interface Props {
  project: CaptionProject;
  captions: CaptionSegment[];
  initialAppearance?: CaptionAppearance;
  onEditWordTiming(id?: string): void;
  onAppearanceChange(appearance: CaptionAppearance): void;
  onInteractionChange(active: boolean): void;
  onConfirm(options: StudioConfirmOptions): Promise<boolean>;
  onReplayEffect?: () => Promise<void>;
  onCancelReplayEffect?: () => void;
  onFontLibraryChange?: () => void;
  replayPreparing?: boolean;
  replayPlaying?: boolean;
  replayDisabled?: boolean;
  sampleCaptionText?: string;
  wordPreparation?: WordHighlightPreparationView;
  flushSave?: RefObject<(() => Promise<boolean>) | null>;
  profileImportRevision?: number;
}

function saveStateCopy(state: AppearanceSaveState) {
  if (state === 'saving') return 'Saving appearance…';
  if (state === 'pending') return 'Saving automatically…';
  if (state === 'error') return 'Appearance could not be saved';
  return 'Saved automatically';
}

function revealAppearanceControl(target: HTMLElement | null | undefined) {
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
}

export function CaptionAppearanceWorkspace({
  project,
  captions,
  initialAppearance,
  onEditWordTiming,
  onAppearanceChange,
  onInteractionChange,
  onConfirm,
  onReplayEffect,
  onCancelReplayEffect,
  onFontLibraryChange,
  replayPreparing = false,
  replayPlaying = false,
  replayDisabled = false,
  sampleCaptionText,
  wordPreparation,
  flushSave,
  profileImportRevision = 0,
}: Props) {
  const initial = recoverUnsavedCaptionAppearance(project.id, project.media) ?? normalizeCaptionAppearance(initialAppearance ?? project.captionAppearance);
  const [appearance, setAppearance] = useState<CaptionAppearance>(initial);
  const [saveState, setSaveState] = useState<AppearanceSaveState>('saved');
  const sharedSaveState = useSyncExternalStore(subscribeCaptionAppearanceSaves,
    () => getCaptionAppearanceSaveState(project.id, project.media), () => getCaptionAppearanceSaveState(null));
  const seenSharedRevision = useRef(sharedSaveState.revision);
  const appearanceEditRevision = useRef(0);
  const [loadingAppearance, setLoadingAppearance] = useState(true);
  const [appearanceReadError, setAppearanceReadError] = useState('');
  const appearanceReadRequest = useRef<symbol | null>(null);
  const [fonts, setFonts] = useState<VideoExportFontCapability[]>([]);
  const [loadingFonts, setLoadingFonts] = useState(true);
  const [fontError, setFontError] = useState('');
  const [fontDiscoveryFailed, setFontDiscoveryFailed] = useState(false);
  const [fontReadError, setFontReadError] = useState('');
  const [fontsLoaded, setFontsLoaded] = useState(false);
  const [fontNotice, setFontNotice] = useState('');
  const [fontWarnings, setFontWarnings] = useState<string[]>([]);
  const [fontQuery, setFontQuery] = useState('');
  const [addingFonts, setAddingFonts] = useState(false);
  const [removingFontId, setRemovingFontId] = useState('');
  const [presets, setPresets] = useState<CaptionAppearancePreset[]>([]);
  const [loadingPresets, setLoadingPresets] = useState(true);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [presetReadError, setPresetReadError] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetError, setPresetError] = useState('');
  const [presetNotice, setPresetNotice] = useState('');
  const [presetSaveAction, setPresetSaveAction] = useState<'save' | 'update' | null>(null);
  const presetNameRevisionRef = useRef(0);
  const [undoAppearance, setUndoAppearance] = useState<CaptionAppearance | null>(null);
  const [redoAppearance, setRedoAppearance] = useState<CaptionAppearance | null>(null);
  const [replayPending, setReplayPending] = useState(false);
  const appearanceRef = useRef<CaptionAppearance>(initial);
  const fontImportChoiceRevisionRef = useRef(0);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const fontPickerRef = useRef<HTMLSelectElement>(null);
  const saveStatusRef = useRef<HTMLDivElement>(null);
  const retrySavePendingRef = useRef(false);
  const fontMutationRef = useRef(false);
  const presetMutationRef = useRef(false);
  const presetPickerRef = useRef<HTMLSelectElement>(null);
  const presetDisclosureRef = useRef<HTMLDetailsElement>(null);
  const wordHighlightSummaryRef = useRef<HTMLElement>(null);
  const dirtyRef = useRef(false);
  const appearanceSaveTimer = useRef<number | null>(null);
  const isRecoveringRef = useRef(false);
  const rangeHistoryActiveRef = useRef(false);
  const replayRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const fontGenerationRef = useRef(0);
  const presetGenerationRef = useRef(0);
  const importRevision = useRef(profileImportRevision);
  importRevision.current = profileImportRevision;
  const resourceOwner = JSON.stringify([project.id, project.media.filename]);
  const resourceOwnerRef = useRef(resourceOwner);
  resourceOwnerRef.current = resourceOwner;
  const fontReadRequest = useRef<symbol | null>(null);
  const presetReadRequest = useRef<symbol | null>(null);
  const readFocus = useRef<{ kind: 'fonts' | 'presets'; owner: string; button: HTMLButtonElement } | null>(null);
  const loadFonts = async (refresh = false) => {
    if (fontReadRequest.current) return;
    const token = Symbol('font read');
    const generation = fontGenerationRef.current;
    const owner = resourceOwnerRef.current;
    fontReadRequest.current = token;
    setLoadingFonts(true);
    const owns = () => mountedRef.current && resourceOwnerRef.current === owner && fontReadRequest.current === token && fontGenerationRef.current === generation;
    try {
      const result = await api.captionFonts(refresh);
      if (!owns()) return;
      setFonts(result.fonts.filter((font) => font.available));
      setFontsLoaded(true); setFontDiscoveryFailed(false); setFontReadError('');
    } catch (error) {
      if (owns()) {
        setFontDiscoveryFailed(true);
        setFontReadError(error instanceof Error ? error.message : 'Could not check local Khmer fonts');
      }
    } finally {
      if (fontReadRequest.current === token) {
        fontReadRequest.current = null;
        if (mountedRef.current && resourceOwnerRef.current === owner && fontGenerationRef.current === generation) setLoadingFonts(false);
      }
    }
  };
  const loadPresets = async () => {
    if (presetReadRequest.current) return;
    const token = Symbol('preset read');
    const generation = presetGenerationRef.current;
    const owner = resourceOwnerRef.current;
    const submittedImportRevision = importRevision.current;
    presetReadRequest.current = token;
    setLoadingPresets(true);
    const owns = () => mountedRef.current && resourceOwnerRef.current === owner && presetReadRequest.current === token
      && presetGenerationRef.current === generation && importRevision.current === submittedImportRevision;
    try {
      const profile = await api.profile();
      if (!owns()) return;
      const entries = profile.captionAppearances || [];
      setPresets(entries);
      setSelectedPresetId((current) => {
        const selected = entries.find((preset) => preset.id === current);
        return selected && JSON.stringify(normalizeCaptionAppearance(selected.appearance)) === JSON.stringify(appearanceRef.current) ? current : '';
      });
      setPresetsLoaded(true); setPresetReadError('');
    } catch (error) {
      if (owns()) setPresetReadError(error instanceof Error ? error.message : 'Could not load saved appearance presets');
    } finally {
      if (presetReadRequest.current === token) {
        presetReadRequest.current = null;
        if (mountedRef.current && resourceOwnerRef.current === owner && presetGenerationRef.current === generation) setLoadingPresets(false);
      }
    }
  };
  useEffect(() => {
    void loadFonts();
    return () => {
      fontReadRequest.current = null;
      readFocus.current = null;
    };
  }, [resourceOwner]);
  useEffect(() => {
    presetGenerationRef.current += 1;
    presetReadRequest.current = null;
    setPresetError(''); setPresetNotice('');
    void loadPresets();
    return () => {
      presetReadRequest.current = null;
      if (readFocus.current?.kind === 'presets') readFocus.current = null;
    };
  }, [resourceOwner, profileImportRevision]);
  useLayoutEffect(() => {
    const intent = readFocus.current;
    if (!intent || (intent.kind === 'fonts' ? loadingFonts : loadingPresets)) return;
    readFocus.current = null;
    if (intent.owner !== resourceOwner || (document.activeElement !== intent.button && document.activeElement !== document.body)) return;
    const error = intent.kind === 'fonts' ? fontReadError : presetReadError;
    const presetTarget = presetPickerRef.current?.getClientRects().length ? presetPickerRef.current : presetDisclosureRef.current?.querySelector('summary');
    const target = error ? intent.button : intent.kind === 'fonts' ? fontPickerRef.current : presetTarget;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [resourceOwner, loadingFonts, loadingPresets, fontReadError, presetReadError]);
  const hasOverlappingCaptions = useMemo(() => {
    const visible = captions
      .filter((caption) => caption.text.trim() && Number.isFinite(caption.startMs) && Number.isFinite(caption.endMs) && caption.endMs > caption.startMs)
      .slice()
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    let furthestEndMs = Number.NEGATIVE_INFINITY;
    for (const caption of visible) {
      if (caption.startMs < furthestEndMs) return true;
      furthestEndMs = Math.max(furthestEndMs, caption.endMs);
    }
    return false;
  }, [captions]);

  useLayoutEffect(() => {
    const externalDraft = sharedSaveState.revision > seenSharedRevision.current;
    seenSharedRevision.current = sharedSaveState.revision;
    if (!sharedSaveState.appearance) return;
    if (JSON.stringify(sharedSaveState.appearance) !== JSON.stringify(appearanceRef.current)) {
      // Explicit recovery can publish into an already open, clean workspace.
      // A later local edit owns its own revision and must never be replaced.
      if (!externalDraft || dirtyRef.current) return;
      appearanceEditRevision.current += 1;
      appearanceReadRequest.current = null;
      setLoadingAppearance(false);
      setAppearanceReadError('');
      isRecoveringRef.current = true;
      appearanceRef.current = { ...sharedSaveState.appearance };
      setAppearance(appearanceRef.current);
    }
    dirtyRef.current = sharedSaveState.status !== 'saved';
    setSaveState(sharedSaveState.status);
  }, [sharedSaveState]);

  const persistAppearance = (snapshot: CaptionAppearance): Promise<boolean> => {
    setSaveState('saving');
    return queueCaptionAppearanceSave(project.id, snapshot, project.media);
  };

  const loadSavedAppearance = async () => {
    if (appearanceReadRequest.current) return;
    const request = Symbol('saved appearance');
    appearanceReadRequest.current = request;
    const owner = resourceOwner;
    const revision = appearanceEditRevision.current;
    const owns = () => appearanceReadRequest.current === request && resourceOwnerRef.current === owner;
    setLoadingAppearance(true);
    setAppearanceReadError('');
    try {
      const priorSaved = await waitForCaptionAppearanceSaves(project.id, project.media);
      if (!owns() || appearanceEditRevision.current !== revision) return;
      if (!priorSaved) {
        const recovered = recoverUnsavedCaptionAppearance(project.id, project.media);
        if (recovered) {
          isRecoveringRef.current = true;
          appearanceRef.current = recovered;
          dirtyRef.current = true;
          setAppearance(recovered);
        }
        setSaveState(getCaptionAppearanceSaveState(project.id, project.media).status);
        return;
      }
      const fresh = await api.getAppearance(project.id);
      if (!owns() || appearanceEditRevision.current !== revision || dirtyRef.current) return;
      if (projectMediaKey(fresh) !== projectMediaKey(project)) {
        setAppearanceReadError('The source changed. Reopen this project before changing its saved appearance.');
        return;
      }
      const next = normalizeCaptionAppearance(fresh.captionAppearance);
      observeSavedCaptionAppearance(project.id, next, project.media);
      appearanceRef.current = next;
      setAppearance(next);
    } catch {
      if (owns() && appearanceEditRevision.current === revision) {
        setAppearanceReadError('Could not reload the saved appearance. Your current look is kept.');
      }
    } finally {
      if (owns()) { appearanceReadRequest.current = null; setLoadingAppearance(false); }
    }
  };

  // Media transactions must include even a change still in the debounce window.
  useEffect(() => {
    if (!flushSave) return;
    const flush = async () => {
      if (appearanceSaveTimer.current !== null) {
        window.clearTimeout(appearanceSaveTimer.current);
        appearanceSaveTimer.current = null;
      }
      return dirtyRef.current
        ? persistAppearance({ ...appearanceRef.current })
        : flushCaptionAppearanceSaves(project.id, project.media);
    };
    flushSave.current = flush;
    return () => { if (flushSave.current === flush) flushSave.current = null; };
  });

  useEffect(() => {
    appearanceEditRevision.current += 1;
    const localInitial = recoverUnsavedCaptionAppearance(project.id, project.media) ?? normalizeCaptionAppearance(initialAppearance ?? project.captionAppearance);
    observeSavedCaptionAppearance(project.id, localInitial, project.media);
    setAppearance(localInitial);
    appearanceRef.current = localInitial;
    dirtyRef.current = false;
    setSaveState('saved');
    setSelectedPresetId('');
    setPresetName('');
    setPresetError('');
    setPresetNotice('');
    presetNameRevisionRef.current += 1;
    setUndoAppearance(null);
    setRedoAppearance(null);
    setReplayPending(false);
    rangeHistoryActiveRef.current = false;
    replayRequestRef.current += 1;
    setLoadingFonts(true);
    setFontError('');
    setFontDiscoveryFailed(false);
    setFontNotice('');
    setFontWarnings([]);
    setFontQuery('');

    void loadSavedAppearance();
    return () => { appearanceReadRequest.current = null; };
  }, [project.id, project.media.filename]);

  useEffect(() => {
    return () => {
      if (getCaptionAppearanceSaveState(project.id, project.media).status === 'pending') {
        const finalSnapshot = { ...appearanceRef.current };
        void queueCaptionAppearanceSave(project.id, finalSnapshot, project.media);
      }
    };
  }, [project.id]);

  useEffect(() => {
    mountedRef.current = true;
    const finishRangeHistory = () => { rangeHistoryActiveRef.current = false; };
    window.addEventListener('pointerup', finishRangeHistory);
    window.addEventListener('pointercancel', finishRangeHistory);
    window.addEventListener('keyup', finishRangeHistory);
    window.addEventListener('blur', finishRangeHistory);
    return () => {
      mountedRef.current = false;
      replayRequestRef.current += 1;
      window.removeEventListener('pointerup', finishRangeHistory);
      window.removeEventListener('pointercancel', finishRangeHistory);
      window.removeEventListener('keyup', finishRangeHistory);
      window.removeEventListener('blur', finishRangeHistory);
    };
  }, []);

  const interactionHandlers = useAppearanceInteraction(appearance, onAppearanceChange, onInteractionChange);

  useEffect(() => {
    if (isRecoveringRef.current) {
      isRecoveringRef.current = false;
      return;
    }
    if (!dirtyRef.current) return;
    setSaveState((state) => state === 'saving' ? state : 'pending');
    const snapshot = { ...appearance };
    const timer = window.setTimeout(() => { appearanceSaveTimer.current = null; void persistAppearance(snapshot); }, 650);
    appearanceSaveTimer.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (appearanceSaveTimer.current === timer) appearanceSaveTimer.current = null;
    };
  }, [appearance]);

  const currentFontAvailable = fonts.some((font) => font.name === appearance.fontFamily);
  const fontOptions = useMemo(() => {
    if (currentFontAvailable || !appearance.fontFamily) return fonts;
    return [{ name: appearance.fontFamily, available: false, boldAvailable: appearance.bold, source: 'user-installed' as const }, ...fonts];
  }, [fonts, currentFontAvailable, appearance.fontFamily, appearance.bold]);
  const currentPreset = presets.find((preset) => preset.id === selectedPresetId);
  const matchingPresetName = presets.some((preset) => preset.name.toLocaleLowerCase('en') === presetName.trim().toLocaleLowerCase('en'));
  const chosenFont = fonts.find((font) => font.name === appearance.fontFamily);
  const addedFonts = fonts.filter((font) => font.source === 'studio-imported' && font.removable && font.id);
  const installedFonts = fontOptions.filter((font) => font.available && font.source !== 'studio-imported');
  const addedFontOptions = fontOptions.filter((font) => font.available && font.source === 'studio-imported');
  const normalizedFontQuery = fontQuery.trim().toLocaleLowerCase('en');
  const fontSearchResults = useMemo(() => {
    if (!normalizedFontQuery) return [] as VideoExportFontCapability[];
    return [...addedFontOptions, ...installedFonts]
      .filter((font) => font.name.toLocaleLowerCase('en').includes(normalizedFontQuery))
      .sort((a, b) => {
        const aName = a.name.toLocaleLowerCase('en');
        const bName = b.name.toLocaleLowerCase('en');
        const aPrefix = aName.startsWith(normalizedFontQuery) ? 0 : 1;
        const bPrefix = bName.startsWith(normalizedFontQuery) ? 0 : 1;
        return aPrefix - bPrefix || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
      })
      .slice(0, 10);
  }, [addedFontOptions, installedFonts, normalizedFontQuery]);
  const confirmedFontUnavailable = !loadingFonts && !fontDiscoveryFailed && !currentFontAvailable;
  const explicitReplayTargetMissing = sampleCaptionText !== undefined && !sampleCaptionText.trim();
  const replayFontUnavailable = loadingFonts || !currentFontAvailable;
  const replayUnavailable = replayDisabled || replayFontUnavailable || explicitReplayTargetMissing;
  const replayIsPreparing = !replayPlaying && (replayPreparing || replayPending);
  const replayUnavailableCopy = loadingFonts && replayFontUnavailable
    ? 'Checking this Khmer font before replay…'
    : fontDiscoveryFailed && replayFontUnavailable
      ? 'Could not verify this Khmer font for replay. Your saved choice is unchanged.'
      : confirmedFontUnavailable
        ? 'Choose an available Khmer font to replay.'
        : explicitReplayTargetMissing
          ? 'Choose a caption with text to replay.'
            : replayDisabled
              ? 'Replay is unavailable for the current selection.'
              : '';
  const motionPreset = appearance.motionPreset || 'none';
  const motionDescription = motionPreset === 'rise'
    ? 'The caption rises into its saved position, then fades out.'
    : motionPreset === 'soft-pop'
      ? 'The caption scales into place, then fades out.'
      : motionPreset === 'fade'
        ? 'The caption fades in and out.'
        : 'Captions stay still.';
  const motionDurationLabel = motionPreset === 'fade' ? 'Fade duration' : 'Motion duration';

  const commitAppearance = (
    next: CaptionAppearance,
    options: { history?: 'discrete' | 'range' | 'none'; clearPreset?: boolean } = {},
  ) => {
    const current = appearanceRef.current;
    if (current.fontFamily !== next.fontFamily || current.bold !== next.bold) fontImportChoiceRevisionRef.current += 1;
    if (JSON.stringify(current) === JSON.stringify(next)) return false;
    setPresetNotice('');
    if (replayPending || replayPreparing || replayPlaying) onCancelReplayEffect?.();
    replayRequestRef.current += 1;
    setReplayPending(false);
    const history = options.history || 'discrete';
    if (history === 'discrete') {
      rangeHistoryActiveRef.current = false;
      setUndoAppearance({ ...current });
      setRedoAppearance(null);
    } else if (history === 'range' && !rangeHistoryActiveRef.current) {
      rangeHistoryActiveRef.current = true;
      setUndoAppearance({ ...current });
      setRedoAppearance(null);
    }
    if (options.clearPreset !== false) setSelectedPresetId('');
    appearanceEditRevision.current += 1;
    setAppearanceReadError('');
    appearanceRef.current = next;
    dirtyRef.current = true;
    seenSharedRevision.current = markCaptionAppearanceDraft(project.id, next, project.media, current).revision;
    setSaveState('pending');
    setAppearance(next);
    return true;
  };

  const updateAppearance = (
    change: (current: CaptionAppearance) => CaptionAppearance,
    options?: { history?: 'discrete' | 'range' | 'none'; clearPreset?: boolean },
  ) => {
    return commitAppearance(change(appearanceRef.current), options);
  };

  const undoAppearanceChange = () => {
    if (!undoAppearance) return;
    fontImportChoiceRevisionRef.current += 1;
    const current = { ...appearanceRef.current };
    rangeHistoryActiveRef.current = false;
    setRedoAppearance(current);
    setUndoAppearance(null);
    setSelectedPresetId('');
    commitAppearance({ ...undoAppearance }, { history: 'none', clearPreset: false });
  };

  const redoAppearanceChange = () => {
    if (!redoAppearance) return;
    fontImportChoiceRevisionRef.current += 1;
    const current = { ...appearanceRef.current };
    rangeHistoryActiveRef.current = false;
    setUndoAppearance(current);
    setRedoAppearance(null);
    setSelectedPresetId('');
    commitAppearance({ ...redoAppearance }, { history: 'none', clearPreset: false });
  };

  const replayEffect = async () => {
    if (!onReplayEffect || replayPreparing || replayPlaying || replayUnavailable || replayPending) return;
    const request = ++replayRequestRef.current;
    setReplayPending(true);
    try {
      onAppearanceChange({ ...appearanceRef.current });
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      if (!mountedRef.current || replayRequestRef.current !== request) return;
      await onReplayEffect();
    } catch {
      // App owns replay failure messaging; the workspace only clears its busy state.
    } finally {
      if (mountedRef.current && replayRequestRef.current === request) setReplayPending(false);
    }
  };

  const cancelReplayEffect = () => {
    if (!onCancelReplayEffect) return;
    replayRequestRef.current += 1;
    setReplayPending(false);
    onCancelReplayEffect();
  };

  const applyLook = (look: CaptionLookId) => {
    updateAppearance((current) => applyCaptionLook(current, look));
  };

  const resetLook = () => {
    fontImportChoiceRevisionRef.current += 1;
    updateAppearance((current) => applyCaptionLook(current, null));
  };

  useEffect(() => {
    if (loadingFonts || !appearanceRef.current.bold) return;
    const font = fonts.find((item) => item.name === appearanceRef.current.fontFamily);
    if (!font || font.boldAvailable) return;
    updateAppearance((current) => ({ ...current, bold: false }), { history: 'none' });
    setFontNotice(`${font.name} has no Bold face. Switched to Regular; other appearance settings are unchanged.`);
  }, [loadingFonts, fonts, project.id]);

  const chooseFont = (name: string) => {
    fontImportChoiceRevisionRef.current += 1;
    const chosen = fonts.find((font) => font.name === name);
    setFontQuery('');
    setFontNotice('');
    setFontWarnings([]);
    if (chosen && appearanceRef.current.bold && !chosen.boldAvailable) {
      updateAppearance((current) => ({ ...current, fontFamily: name, bold: false }));
      setFontNotice(`${name} has no Bold face. Switched to Regular; other appearance settings are unchanged.`);
      return;
    }
    updateAppearance((current) => ({ ...current, fontFamily: name }));
  };

  const addFonts = async (files: FileList | File[] | null) => {
    const selected = Array.from(files || []);
    if (!selected.length || addingFonts || removingFontId || fontMutationRef.current) return;
    const owner = resourceOwnerRef.current;
    const choiceRevision = fontImportChoiceRevisionRef.current;
    fontMutationRef.current = true;
    setAddingFonts(true);
    setFontError('');
    setFontNotice('');
    setFontWarnings([]);
    try {
      const result = await api.addCaptionFonts(selected);
      if (result.imported.length > 0) onFontLibraryChange?.();
      if (!mountedRef.current || resourceOwnerRef.current !== owner) return;
      fontGenerationRef.current += 1;
      fontReadRequest.current = null;
      const available = result.fonts.filter((font) => font.available);
      setFonts(available);
      setLoadingFonts(false);
      setFontDiscoveryFailed(false);
      setFontsLoaded(true); setFontReadError('');
      setFontError('');
      setFontWarnings(result.warnings);
      const firstName = result.imported[0];
      const first = firstName ? available.find((font) => font.name === firstName) : undefined;
      if (!first) {
        if (!result.warnings.length) setFontError('No compatible Khmer font was added. Choose a Regular .ttf or .otf font file.');
        return;
      }
      const count = result.imported.length;
      const added = count === 1 ? `Added “${first.name}”` : `Added ${count} Khmer font families`;
      if (fontImportChoiceRevisionRef.current !== choiceRevision) {
        setFontNotice(`${added}. Your newer appearance choices are kept. Choose the added font from Khmer font when you are ready.`);
        return;
      }
      setFontQuery('');
      const boldMismatch = appearanceRef.current.bold && !first.boldAvailable;
      updateAppearance((current) => ({ ...current, fontFamily: first.name, ...(boldMismatch ? { bold: false } : {}) }));
      setFontNotice(`${added}. ${first.name} is selected.${boldMismatch ? ' No Bold face; using Regular. Other settings are unchanged.' : ''}`);
    } catch (error) {
      if (mountedRef.current && resourceOwnerRef.current === owner) setFontError(error instanceof Error ? error.message : 'Could not add the selected font files');
    } finally {
      fontMutationRef.current = false;
      if (mountedRef.current && resourceOwnerRef.current === owner) setAddingFonts(false);
    }
  };

  const removeAddedFont = async (font: VideoExportFontCapability) => {
    if (!font.id || !font.removable || addingFonts || removingFontId || fontMutationRef.current) return;
    const owner = resourceOwnerRef.current;
    const owns = () => mountedRef.current && resourceOwnerRef.current === owner;
    const selectedHere = appearanceRef.current.fontFamily === font.name;
    const confirmed = await onConfirm({
      title: `Remove “${font.name}” from Studio?`,
      message: selectedHere
        ? 'This project keeps the font name, but preview and captioned-video export need you to add it again or choose another available font.'
        : 'This removes your Studio copy. Projects using it keep the font name and need an available font before preview or render.',
      confirmLabel: 'Remove font',
      tone: 'warning',
    });
    if (!confirmed || !owns() || fontMutationRef.current) return;
    // The confirmed row will disable and may disappear. Continue at its stable picker.
    revealAppearanceControl(fontPickerRef.current);
    fontMutationRef.current = true;
    setRemovingFontId(font.id);
    setFontError('');
    setFontNotice('');
    setFontWarnings([]);
    try {
      const result = await api.removeCaptionFont(font.id);
      onFontLibraryChange?.();
      if (!owns()) return;
      fontGenerationRef.current += 1;
      fontReadRequest.current = null;
      setFonts(result.fonts.filter((item) => item.available));
      setLoadingFonts(false);
      setFontDiscoveryFailed(false);
      setFontsLoaded(true); setFontReadError('');
      setFontError('');
      setFontNotice(`Removed “${font.name}” from Studio. Fonts installed on your PC are unchanged.`);
    } catch (error) {
      if (owns()) setFontError(error instanceof Error ? error.message : 'Could not remove that font from Studio');
    } finally {
      fontMutationRef.current = false;
      if (owns()) setRemovingFontId('');
    }
  };

  const applyPreset = (id: string) => {
    fontImportChoiceRevisionRef.current += 1;
    setSelectedPresetId(id);
    if (!id) return;
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;
    const requested = normalizeCaptionAppearance(preset.appearance);
    const presetFont = fonts.find((font) => font.name === requested.fontFamily);
    const fallbackToRegular = Boolean(presetFont && requested.bold && !presetFont.boldAvailable);
    const next = fallbackToRegular ? { ...requested, bold: false } : requested;
    commitAppearance(next, { clearPreset: false });
    setFontQuery('');
    setFontWarnings([]);
    setFontNotice(fallbackToRegular
      ? `${requested.fontFamily} has no Bold face. This preset uses Regular; other settings are unchanged.`
      : '');
  };

  const savePreset = async () => {
    const name = presetName.trim();
    if (!name || savingPreset || presetMutationRef.current) return;
    presetMutationRef.current = true;
    const owner = resourceOwnerRef.current;
    const submittedImportRevision = importRevision.current;
    const owns = () => mountedRef.current && resourceOwnerRef.current === owner && importRevision.current === submittedImportRevision;
    const appearanceSnapshot = { ...appearanceRef.current };
    const appearanceSnapshotKey = JSON.stringify(appearanceSnapshot);
    const selectedPresetAtStart = selectedPresetId;
    const nameRevision = presetNameRevisionRef.current;
    setSavingPreset(true);
    setPresetSaveAction(matchingPresetName ? 'update' : 'save');
    setPresetError('');
    setPresetNotice('');
    try {
      const profile = await api.profile();
      if (!owns()) return;
      const now = new Date().toISOString();
      const existing = (profile.captionAppearances || []).find((preset) => preset.name.toLocaleLowerCase('en') === name.toLocaleLowerCase('en'));
      setPresetSaveAction(existing ? 'update' : 'save');
      const next: CaptionAppearancePreset = existing
        ? { ...existing, name, appearance: appearanceSnapshot, updatedAt: now }
        : { id: crypto.randomUUID(), name, appearance: appearanceSnapshot, createdAt: now, updatedAt: now };
      const captionAppearances = [next, ...(profile.captionAppearances || []).filter((preset) => preset.id !== next.id)].slice(0, 20);
      const updated = await api.patchProfile({ captionAppearances });
      if (!owns()) return;
      presetGenerationRef.current += 1;
      presetReadRequest.current = null;
      setLoadingPresets(false); setPresetsLoaded(true); setPresetReadError('');
      setPresets(updated.captionAppearances || []);
      setPresetError('');
      setSelectedPresetId((current) => JSON.stringify(appearanceRef.current) === appearanceSnapshotKey && current === selectedPresetAtStart ? next.id : current);
      if (presetNameRevisionRef.current === nameRevision && JSON.stringify(appearanceRef.current) === appearanceSnapshotKey) {
        setPresetName((current) => current.trim() === name ? '' : current);
        setPresetNotice(`${existing ? 'Updated' : 'Saved'} “${next.name}”.`);
      }
    } catch (error) {
      if (owns()) setPresetError(error instanceof Error ? error.message : 'Could not save appearance preset');
    } finally {
      presetMutationRef.current = false;
      if (mountedRef.current) { setSavingPreset(false); setPresetSaveAction(null); }
    }
  };

  const deletePreset = async () => {
    if (!selectedPresetId || savingPreset || presetMutationRef.current) return;
    const owner = resourceOwnerRef.current;
    const submittedImportRevision = importRevision.current;
    const owns = () => mountedRef.current && resourceOwnerRef.current === owner && importRevision.current === submittedImportRevision;
    const targetId = selectedPresetId;
    const target = presets.find((item) => item.id === targetId);
    const confirmed = await onConfirm({
      title: `Delete “${target?.name || 'Preset'}”?`,
      message: 'This removes the preset from your profile. Existing projects keep their appearance.',
      confirmLabel: 'Delete preset',
      tone: 'warning',
    });
    if (!confirmed || !owns() || presetMutationRef.current) return;
    revealAppearanceControl(presetDisclosureRef.current?.querySelector<HTMLElement>('summary'));
    presetMutationRef.current = true;
    setSavingPreset(true);
    setPresetError('');
    setPresetNotice('');
    try {
      const profile = await api.profile();
      if (!owns()) return;
      const updated = await api.patchProfile({ captionAppearances: (profile.captionAppearances || []).filter((preset) => preset.id !== targetId) });
      if (!owns()) return;
      presetGenerationRef.current += 1;
      presetReadRequest.current = null;
      setLoadingPresets(false); setPresetsLoaded(true); setPresetReadError('');
      setPresets(updated.captionAppearances || []);
      setPresetError('');
      setSelectedPresetId((current) => current === targetId ? '' : current);
      setPresetNotice(`Deleted appearance preset “${target?.name || 'Preset'}”. Current appearance is kept.`);
    } catch (error) {
      if (owns()) setPresetError(error instanceof Error ? error.message : 'Could not delete appearance preset');
    } finally {
      presetMutationRef.current = false;
      if (mountedRef.current) setSavingPreset(false);
    }
  };

  return <section className="caption-appearance-workspace" aria-labelledby="caption-appearance-workspace-title" {...interactionHandlers}>
    <div className="caption-appearance-head">
      <strong id="caption-appearance-workspace-title" className="appearance-accessible-title">Caption appearance</strong>
      <div ref={saveStatusRef} className={`appearance-save-state ${saveState}`} tabIndex={-1} role="status" aria-live="polite">
        {saveState === 'saving' || saveState === 'pending' || loadingAppearance ? <LoaderCircle className="spin" size={14}/> : saveState === 'error' || appearanceReadError ? <TriangleAlert size={14}/> : <CheckCircle2 size={14}/>}<span>{sharedSaveState.conflict ? 'Saved appearance changed' : saveState === 'saved' && loadingAppearance ? 'Checking saved appearance…' : saveState === 'saved' && appearanceReadError ? 'Current look kept' : saveStateCopy(saveState)}</span>{saveState === 'error' && !sharedSaveState.conflict && <button onClick={() => {
          if (retrySavePendingRef.current) return;
          retrySavePendingRef.current = true;
          revealAppearanceControl(saveStatusRef.current);
          void persistAppearance({ ...appearanceRef.current }).finally(() => { retrySavePendingRef.current = false; });
        }}>Retry</button>}
      </div>
      <div className="appearance-effect-toolbar" aria-label="Appearance history">
      <div className="appearance-history">
        <button type="button" disabled={!undoAppearance} onClick={undoAppearanceChange}><Undo2 size={14}/>Undo</button>
        <button type="button" disabled={!redoAppearance} onClick={redoAppearanceChange}><Redo2 size={14}/>Redo</button>
      </div>
    </div>
    </div>

    {appearanceReadError && <div className="appearance-inline-warning appearance-resource-recovery" role="alert"><TriangleAlert size={15}/><span>{appearanceReadError}</span><button type="button" disabled={loadingAppearance} aria-busy={loadingAppearance || undefined} onClick={() => {
      if (appearanceReadRequest.current) return;
      revealAppearanceControl(saveStatusRef.current);
      void loadSavedAppearance();
    }}>Retry saved appearance</button></div>}
    {presetError && <div className="appearance-inline-warning" role="alert"><TriangleAlert size={15}/><span>{presetError}</span></div>}
    {fontReadError && <div className="appearance-inline-warning appearance-resource-recovery" role="alert"><TriangleAlert size={15}/><span>{fontReadError}. {fontsLoaded ? 'Last checked fonts are still shown.' : 'Your saved font is not yet verified.'} Your current appearance is kept.</span><button type="button" disabled={loadingFonts} aria-busy={loadingFonts || undefined} onClick={(event) => {
      if (fontReadRequest.current) return;
      if (document.activeElement === event.currentTarget) readFocus.current = { kind: 'fonts', owner: resourceOwner, button: event.currentTarget };
      void loadFonts(true);
    }}>{loadingFonts ? 'Checking fonts…' : 'Retry fonts'}</button></div>}
    {presetReadError && <div className="appearance-inline-warning appearance-resource-recovery" role="alert"><TriangleAlert size={15}/><span>{presetReadError}. {presetsLoaded ? 'Last loaded presets are still shown.' : 'Saved presets could not be loaded.'} Your current appearance and preset name are kept.</span><button type="button" disabled={loadingPresets} aria-busy={loadingPresets || undefined} onClick={(event) => {
      if (presetReadRequest.current) return;
      if (document.activeElement === event.currentTarget) readFocus.current = { kind: 'presets', owner: resourceOwner, button: event.currentTarget };
      void loadPresets();
    }}>{loadingPresets ? 'Loading presets…' : 'Retry appearance presets'}</button></div>}
    {fontError && <div className="appearance-inline-warning" role="alert"><TriangleAlert size={15}/><span>{fontError}. Your current appearance remains unchanged.</span></div>}
    {fontWarnings.length > 0 && <div className="appearance-inline-warning" role="status"><TriangleAlert size={15}/><span>{fontWarnings.join(' ')}</span></div>}
    {fontNotice && <div className="appearance-font-notice" role="status"><CheckCircle2 size={15}/><span>{fontNotice}</span></div>}
    {confirmedFontUnavailable && <div className="appearance-inline-warning" role="alert"><TriangleAlert size={15}/><span><b>{appearance.fontFamily}</b> is unavailable on this PC. Choose an available Khmer font to preview or render. Your saved font choice is unchanged.</span></div>}

    <CaptionLooksGallery
      appearance={appearance}
      sampleCaptionText={sampleCaptionText}
      onSelect={applyLook}
      onReset={resetLook}
    />

    <div className="appearance-essential-grid">
      <div className="appearance-font-field"><span>Khmer font</span>{installedFonts.length > 24 && <FontSearch query={fontQuery} onQueryChange={setFontQuery} options={fontSearchResults} selected={appearance.fontFamily} count={installedFonts.length} onSelect={chooseFont}/>}<div className="appearance-font-picker"><select ref={fontPickerRef} aria-label="Khmer font" value={appearance.fontFamily} disabled={loadingFonts && !fonts.length} aria-busy={loadingFonts || undefined} onChange={(event) => chooseFont(event.target.value)}>{!currentFontAvailable && appearance.fontFamily && <option value={appearance.fontFamily}>{appearance.fontFamily} · {loadingFonts ? 'checking local fonts…' : fontDiscoveryFailed ? 'not yet verified' : 'unavailable'}</option>}{addedFontOptions.length > 0 && <optgroup label="Added to Studio">{addedFontOptions.map((font) => <option key={font.name} value={font.name}>{font.name}{font.boldAvailable ? '' : ' · regular only'}</option>)}</optgroup>}{installedFonts.length > 0 && <optgroup label={`Installed on this computer (${installedFonts.length})`}>{installedFonts.map((font) => <option key={font.name} value={font.name}>{font.name}{font.boldAvailable ? '' : ' · regular only'}</option>)}</optgroup>}{loadingFonts && !fontOptions.length && <option value={appearance.fontFamily}>Checking local fonts…</option>}</select><button type="button" disabled={addingFonts || Boolean(removingFontId)} onClick={() => fontInputRef.current?.click()}><Plus size={14}/>{addingFonts ? 'Adding…' : 'Add font…'}</button><input ref={fontInputRef} className="appearance-font-file-input" type="file" accept=".ttf,.otf,font/ttf,font/otf" multiple onChange={(event) => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; void addFonts(files); }}/></div><small>{installedFonts.length ? `${installedFonts.length} compatible Khmer fonts found on this PC. ` : 'Compatible Khmer fonts on this PC appear here automatically. '}Added .ttf and .otf files stay in Studio.</small></div>
      <label><span>Text color</span><input type="color" value={appearance.textColor} onChange={(event) => updateAppearance((current) => ({ ...current, textColor: event.target.value.toUpperCase() }))}/></label>
      <AppearanceRange key={`fontSize1080:${project.id}:${project.media.filename}`} label="Size" value={appearance.fontSize1080} defaultValue={DEFAULT_CAPTION_APPEARANCE.fontSize1080} min={22} max={120} step={1} unit="px" context="At 1080p" onChange={(value, history) => updateAppearance((current) => ({ ...current, fontSize1080: value }), { history })}/>
      <AppearanceRange key={`positionBottomPct:${project.id}:${project.media.filename}`} label="Position" value={appearance.positionBottomPct} defaultValue={DEFAULT_CAPTION_APPEARANCE.positionBottomPct} min={3} max={82} step={1} unit="%" context="From bottom" onChange={(value, history) => updateAppearance((current) => ({ ...current, positionBottomPct: value }), { history })}/>
    </div>

    {addedFonts.length > 0 && <details className="appearance-font-manager"><summary>Manage added fonts <b>{addedFonts.length}</b></summary><div className="appearance-font-manager-list">{addedFonts.map((font) => <div className="appearance-font-manager-row" key={font.id}><div><strong>{font.name}</strong><span>{font.boldAvailable ? 'Regular + Bold' : 'Regular only'} · Added to Studio</span></div><button type="button" className="danger-quiet" disabled={addingFonts || Boolean(removingFontId)} onClick={() => void removeAddedFont(font)}><Trash2 size={14}/>{removingFontId === font.id ? 'Removing…' : 'Remove'}</button></div>)}</div></details>}

    <details className="appearance-motion-disclosure appearance-option-group"><summary>Motion · {motionPreset === 'none' ? 'None' : motionPreset === 'soft-pop' ? 'Soft Pop' : motionPreset === 'rise' ? 'Rise' : 'Fade'}</summary>
    <section className="caption-effects-section appearance-motion-section appearance-option-body" aria-labelledby="appearance-motion-title">
      <div className="caption-effects-section-head">
        <div>
          <strong id="appearance-motion-title">Motion</strong>
          <span>Animate whole captions without changing timing or word emphasis.</span>
        </div>
      </div>
      <div className="appearance-motion-controls">
        <div className="appearance-motion-choice">
          <span>Entrance &amp; exit</span>
          <div className="appearance-segmented" role="group" aria-label="Caption motion">
            <button type="button" aria-pressed={motionPreset === 'none'} onClick={() => updateAppearance((current) => ({ ...current, motionPreset: 'none' }))}>None</button>
            <button type="button" aria-pressed={motionPreset === 'fade'} onClick={() => updateAppearance((current) => ({ ...current, motionPreset: 'fade' }))}>Fade</button>
            <button type="button" aria-pressed={motionPreset === 'rise'} onClick={() => updateAppearance((current) => ({ ...current, motionPreset: 'rise' }))}>Rise</button>
            <button type="button" aria-pressed={motionPreset === 'soft-pop'} onClick={() => updateAppearance((current) => ({ ...current, motionPreset: 'soft-pop' }))}>Soft Pop</button>
          </div>
          <span className="appearance-motion-selection-note">{motionDescription}</span>
          {motionPreset !== 'none' && <span className="appearance-motion-selection-note">Very short captions skip motion to stay visible.</span>}
          {(motionPreset === 'rise' || motionPreset === 'soft-pop') && hasOverlappingCaptions
            && <span className="appearance-motion-overlap-note">Overlapping captions stay still and fade for readability.</span>}
        </div>
        {motionPreset !== 'none' && <AppearanceRange className="appearance-motion-duration" label={motionDurationLabel}
          value={appearance.motionDurationMs ?? DEFAULT_CAPTION_APPEARANCE.motionDurationMs!} defaultValue={DEFAULT_CAPTION_APPEARANCE.motionDurationMs!}
          min={80} max={400} step={10} unit="ms"
          onChange={(value, history) => updateAppearance((current) => ({ ...current, motionDurationMs: value }), { history })}/>}
      </div>
    </section>
    </details>
    <section className="appearance-replay-section">
      <div className="appearance-motion-actions">
        {onReplayEffect && <button
          type="button"
          className="primary-effect-action"
          disabled={replayIsPreparing || replayPlaying || replayUnavailable}
          title={replayUnavailableCopy || undefined}
          onClick={() => void replayEffect()}
        >
          {replayIsPreparing ? <LoaderCircle className="spin" size={14}/> : <Play size={14}/>}
          {replayIsPreparing ? 'Preparing…' : 'Replay effect'}
        </button>}
        {onCancelReplayEffect && replayIsPreparing && <button type="button" onClick={cancelReplayEffect}>Cancel preparation</button>}
        {onCancelReplayEffect && replayPlaying && <button type="button" onClick={cancelReplayEffect}>Stop replay</button>}
        {motionPreset !== 'none' && <button type="button" onClick={() => updateAppearance((current) => ({ ...current, motionPreset: 'none' }))}><RotateCcw size={14}/>Turn motion off</button>}
      </div>
      {sampleCaptionText?.trim() && <div className="appearance-replay-target" aria-label="Replay target caption"><span>Replay target</span><b>{sampleCaptionText.trim()}</b></div>}
      <span className={`appearance-motion-help${replayUnavailableCopy ? ' unavailable' : ''}`}>{replayUnavailableCopy || 'Replay this caption to check its look.'}</span>
    </section>

    <details className="appearance-word-details appearance-option-group" open={appearance.highlightMode === 'word' || wordPreparation?.hasUndo || wordPreparation?.running}><summary ref={wordHighlightSummaryRef}>Word highlighting · {appearance.highlightMode === 'word' ? 'On' : 'Off'}</summary>
    <section className="appearance-word-highlight appearance-option-body" aria-label="Spoken word highlight">
      <div className="appearance-word-highlight-head">
        <p>Color words with usable timing while the full caption stays visible.</p>
        <button type="button" aria-label="Highlight spoken word" aria-pressed={appearance.highlightMode === 'word'} className={appearance.highlightMode === 'word' ? 'selected' : ''}
          onClick={() => {
            const enabled = appearanceRef.current.highlightMode !== 'word';
            if (updateAppearance((current) => ({ ...current, highlightMode: enabled ? 'word' : 'off' }))) wordPreparation?.onToggle(enabled);
          }}>
          {appearance.highlightMode === 'word' ? 'On' : 'Off'}
        </button>
      </div>
      {appearance.highlightMode === 'word' && <>
        <label className="appearance-highlight-color"><span>Highlight color</span><input type="color" aria-label="Word highlight color" value={appearance.highlightColor || '#D7FF4F'}
          onChange={(event) => updateAppearance((current) => ({ ...current, highlightColor: event.target.value.toUpperCase() }))}/></label>
        {wordPreparation?.exceptions === 0 && <button type="button" onClick={() => onEditWordTiming()}>Edit word timing</button>}
      </>}
      {wordPreparation && <WordHighlightPreparation view={wordPreparation} enabled={appearance.highlightMode === 'word'} actionFocusTarget={wordHighlightSummaryRef}/>}
      {appearance.highlightMode === 'word' && <p className="appearance-highlight-note">Highlights appear in video. SRT carries text and timing only.</p>}
    </section>

    </details>

    <details className="appearance-more appearance-option-group">
      <summary>More appearance</summary>
      <div className="appearance-grid appearance-option-body">
        <div className="toggle-field"><span>Weight</span><button aria-pressed={appearance.bold} className={appearance.bold ? 'selected' : ''} title={chosenFont && !chosenFont.boldAvailable ? `${chosenFont.name} includes Regular only.` : undefined} disabled={Boolean(chosenFont && !chosenFont.boldAvailable && !appearance.bold)} onClick={() => updateAppearance((current) => ({ ...current, bold: !current.bold }))}>{appearance.bold ? 'Bold' : 'Regular'}</button></div>
        <label><span>Outline color</span><input type="color" value={appearance.outlineColor} onChange={(event) => updateAppearance((current) => ({ ...current, outlineColor: event.target.value.toUpperCase() }))}/></label>
        <AppearanceRange key={`outlineWidth1080:${project.id}:${project.media.filename}`} label="Outline" value={appearance.outlineWidth1080} defaultValue={DEFAULT_CAPTION_APPEARANCE.outlineWidth1080} min={0} max={12} step={0.5} unit="px" onChange={(value, history) => updateAppearance((current) => ({ ...current, outlineWidth1080: value }), { history })}/>
        <AppearanceRange key={`shadowWidth1080:${project.id}:${project.media.filename}`} label="Shadow" value={appearance.shadowWidth1080} defaultValue={DEFAULT_CAPTION_APPEARANCE.shadowWidth1080} min={0} max={12} step={0.5} unit="px" onChange={(value, history) => updateAppearance((current) => ({ ...current, shadowWidth1080: value }), { history })}/>
        <AppearanceRange key={`maxWidthPct:${project.id}:${project.media.filename}`} label="Max width" value={appearance.maxWidthPct} defaultValue={DEFAULT_CAPTION_APPEARANCE.maxWidthPct} min={45} max={96} step={1} unit="%" onChange={(value, history) => updateAppearance((current) => ({ ...current, maxWidthPct: value }), { history })}/>
        <label><span>Alignment</span><select value={appearance.alignment} onChange={(event) => updateAppearance((current) => ({ ...current, alignment: event.target.value as CaptionAppearance['alignment'] }))}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
        <div className="toggle-field"><span>Background box</span><button aria-pressed={appearance.backgroundEnabled} className={appearance.backgroundEnabled ? 'selected' : ''} onClick={() => updateAppearance((current) => ({ ...current, backgroundEnabled: !current.backgroundEnabled }))}>{appearance.backgroundEnabled ? 'On' : 'Off'}</button></div>
        {appearance.backgroundEnabled && <><label><span>Background color</span><input type="color" value={appearance.backgroundColor} onChange={(event) => updateAppearance((current) => ({ ...current, backgroundColor: event.target.value.toUpperCase() }))}/></label><AppearanceRange key={`backgroundOpacity:${project.id}:${project.media.filename}`} label="Background opacity" value={Number((appearance.backgroundOpacity * 100).toFixed(10))} defaultValue={Math.round(DEFAULT_CAPTION_APPEARANCE.backgroundOpacity * 100)} min={5} max={100} step={1} unit="%" onChange={(value, history) => updateAppearance((current) => ({ ...current, backgroundOpacity: value / 100 }), { history })}/><AppearanceRange key={`backgroundPadding1080:${project.id}:${project.media.filename}`} label="Box padding" value={appearance.backgroundPadding1080} defaultValue={DEFAULT_CAPTION_APPEARANCE.backgroundPadding1080} min={0} max={28} step={1} unit="px" onChange={(value, history) => updateAppearance((current) => ({ ...current, backgroundPadding1080: value }), { history })}/></>}
        <div className="appearance-glow-group">
          <div className="toggle-field"><span>Glow</span><button aria-pressed={appearance.glowEnabled === true} className={appearance.glowEnabled ? 'selected' : ''} onClick={() => updateAppearance((current) => ({ ...current, glowEnabled: !current.glowEnabled }))}>{appearance.glowEnabled ? 'On' : 'Off'}</button></div>
          {appearance.glowEnabled && <><label><span>Glow color</span><input type="color" value={appearance.glowColor || DEFAULT_CAPTION_APPEARANCE.glowColor} onChange={(event) => updateAppearance((current) => ({ ...current, glowColor: event.target.value.toUpperCase() }))}/></label><AppearanceRange key={`glowWidth1080:${project.id}:${project.media.filename}`} label="Glow width" value={(appearance.glowWidth1080 ?? DEFAULT_CAPTION_APPEARANCE.glowWidth1080!)} defaultValue={DEFAULT_CAPTION_APPEARANCE.glowWidth1080!} min={0} max={16} step={0.5} unit="px" onChange={(value, history) => updateAppearance((current) => ({ ...current, glowWidth1080: value }), { history })}/><AppearanceRange key={`glowOpacity:${project.id}:${project.media.filename}`} label="Glow opacity" value={Number(((appearance.glowOpacity ?? DEFAULT_CAPTION_APPEARANCE.glowOpacity!) * 100).toFixed(10))} defaultValue={Math.round(DEFAULT_CAPTION_APPEARANCE.glowOpacity! * 100)} min={0} max={100} step={1} unit="%" onChange={(value, history) => updateAppearance((current) => ({ ...current, glowOpacity: value / 100 }), { history })}/></>}
        </div>
      </div>
    </details>

    <details ref={presetDisclosureRef} className="appearance-presets-disclosure appearance-option-group"><summary>Saved presets</summary>
    <div className="appearance-preset-bar appearance-option-body">
      <label htmlFor="appearance-preset-select">
        <span>Preset</span>
        <select ref={presetPickerRef} id="appearance-preset-select" aria-label="Preset" value={selectedPresetId} disabled={loadingPresets && !presetsLoaded} aria-busy={loadingPresets || undefined} onChange={(event) => applyPreset(event.target.value)}>
          <option value="">Custom / current project</option>
          {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
      </label>
      <details className="appearance-preset-tools">
        <summary>Manage presets</summary>
        <div className="appearance-preset-tools-body">
          <label><span>Save current appearance as</span><input value={presetName} maxLength={80} onChange={(event) => { presetNameRevisionRef.current += 1; setPresetName(event.target.value); setPresetNotice(''); }} placeholder="Example: Clean Khmer"/></label>
          <button disabled={!presetName.trim() || savingPreset} aria-busy={presetSaveAction ? true : undefined} onClick={() => void savePreset()}><Save size={14}/>{presetSaveAction ? presetSaveAction === 'update' ? 'Updating…' : 'Saving…' : matchingPresetName ? 'Update preset' : 'Save preset'}</button>
          {presetNotice && <div className="appearance-preset-notice" role="status"><CheckCircle2 size={14} aria-hidden="true"/><span>{presetNotice}</span></div>}
          {selectedPresetId && <div className="preset-delete-row"><span>Selected: <b>{currentPreset?.name || 'Preset'}</b></span><button className="danger-quiet" disabled={savingPreset} onClick={() => void deletePreset()}><Trash2 size={14}/>Delete preset</button></div>}
        </div>
      </details>
    </div>
    </details>
    <details className="appearance-preview-details"><summary>About the preview</summary><p>Style captions against your video. Size and position may update before the exact export preview is ready. Compression and display scaling can soften edges.</p></details>

    <div className="appearance-workspace-footer"><span>Appearance controls the look of captioned video. SRT carries caption text and cue timing.</span></div>
  </section>;
}
