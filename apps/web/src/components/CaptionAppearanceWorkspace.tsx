import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyCaptionLook,
  DEFAULT_CAPTION_APPEARANCE,
  normalizeCaptionAppearance,
  resolveCaptionWordTiming,
  type CaptionAppearance,
  type CaptionAppearancePreset,
  type CaptionLookId,
  type CaptionProject,
  type CaptionSegment,
  type VideoExportFontCapability,
} from '@kcs/shared';
import { CheckCircle2, LoaderCircle, Play, Plus, Redo2, RotateCcw, Save, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import { api } from '../api';
import { useAppearanceInteraction } from '../use-appearance-interaction';
import { queueCaptionAppearanceSave, recoverUnsavedCaptionAppearance, waitForCaptionAppearanceSaves } from '../caption-appearance-save';
import { CaptionLooksGallery } from './CaptionLooksGallery';
import type { StudioConfirmOptions } from './ConfirmationDialog';
import './caption-appearance.css';
import './caption-effects.css';
import './word-highlight.css';

type AppearanceSaveState = 'saved' | 'pending' | 'saving' | 'error';

interface Props {
  project: CaptionProject;
  captions: CaptionSegment[];
  onEditWordTiming(id?: string): void;
  onAppearanceChange(appearance: CaptionAppearance): void;
  onInteractionChange(active: boolean): void;
  onConfirm(options: StudioConfirmOptions): Promise<boolean>;
  onReplayEffect?: () => Promise<void>;
  replayPreparing?: boolean;
  replayDisabled?: boolean;
  sampleCaptionText?: string;
}

function saveStateCopy(state: AppearanceSaveState) {
  if (state === 'saving') return 'Saving appearance…';
  if (state === 'pending') return 'Saving automatically…';
  if (state === 'error') return 'Appearance could not be saved';
  return 'Saved automatically';
}

export function CaptionAppearanceWorkspace({
  project,
  captions,
  onEditWordTiming,
  onAppearanceChange,
  onInteractionChange,
  onConfirm,
  onReplayEffect,
  replayPreparing = false,
  replayDisabled = false,
  sampleCaptionText,
}: Props) {
  const initial = normalizeCaptionAppearance(project.captionAppearance);
  const [appearance, setAppearance] = useState<CaptionAppearance>(initial);
  const [saveState, setSaveState] = useState<AppearanceSaveState>('saved');
  const [fonts, setFonts] = useState<VideoExportFontCapability[]>([]);
  const [loadingFonts, setLoadingFonts] = useState(true);
  const [fontError, setFontError] = useState('');
  const [fontNotice, setFontNotice] = useState('');
  const [fontWarnings, setFontWarnings] = useState<string[]>([]);
  const [fontQuery, setFontQuery] = useState('');
  const [addingFonts, setAddingFonts] = useState(false);
  const [removingFontId, setRemovingFontId] = useState('');
  const [presets, setPresets] = useState<CaptionAppearancePreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetError, setPresetError] = useState('');
  const [undoAppearance, setUndoAppearance] = useState<CaptionAppearance | null>(null);
  const [redoAppearance, setRedoAppearance] = useState<CaptionAppearance | null>(null);
  const [replayPending, setReplayPending] = useState(false);
  const appearanceRef = useRef<CaptionAppearance>(initial);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const dirtyRef = useRef(false);
  const isRecoveringRef = useRef(false);
  const rangeHistoryActiveRef = useRef(false);
  const replayRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const wordReadiness = useMemo(() => {
    const spoken = captions.filter((caption) => caption.text.trim());
    return { unresolved: spoken.filter((caption) => resolveCaptionWordTiming(caption).state !== 'ready'), total: spoken.length };
  }, [captions]);

  const persistAppearance = async (snapshot: CaptionAppearance): Promise<boolean> => {
    const snapshotKey = JSON.stringify(snapshot);
    setSaveState('saving');
    const saved = await queueCaptionAppearanceSave(project.id, snapshot);
    if (saved) {
      if (JSON.stringify(appearanceRef.current) === snapshotKey) {
        dirtyRef.current = false;
        setSaveState('saved');
      } else setSaveState('pending');
      return true;
    }
    if (JSON.stringify(appearanceRef.current) === snapshotKey) setSaveState('error');
    return false;
  };

  useEffect(() => {
    let active = true;
    const localInitial = normalizeCaptionAppearance(project.captionAppearance);
    setAppearance(localInitial);
    appearanceRef.current = localInitial;
    dirtyRef.current = false;
    setSaveState('saved');
    setSelectedPresetId('');
    setPresetName('');
    setUndoAppearance(null);
    setRedoAppearance(null);
    setReplayPending(false);
    rangeHistoryActiveRef.current = false;
    replayRequestRef.current += 1;
    setLoadingFonts(true);
    setFontError('');
    setFontNotice('');
    setFontWarnings([]);
    setFontQuery('');

    void (async () => {
      const priorSaved = await waitForCaptionAppearanceSaves(project.id);
      if (!active) return;
      if (!priorSaved) {
        const recovered = recoverUnsavedCaptionAppearance(project.id);
        if (recovered) {
          isRecoveringRef.current = true;
          appearanceRef.current = recovered;
          dirtyRef.current = true;
          setAppearance(recovered);
        }
        setSaveState('error');
        return;
      }
      try {
        const fresh = await api.get(project.id);
        if (!active || dirtyRef.current) return;
        const next = normalizeCaptionAppearance(fresh.captionAppearance);
        setAppearance(next);
        appearanceRef.current = next;
      } catch {
        if (active) setSaveState('error');
      }
    })();

    void api.captionFonts(true)
      .then((result) => {
        if (active) setFonts(result.fonts.filter((font) => font.available));
      })
      .catch((error) => {
        if (active) setFontError(error instanceof Error ? error.message : 'Could not check local Khmer fonts');
      })
      .finally(() => { if (active) setLoadingFonts(false); });

    void api.profile().then((profile) => {
      if (active) setPresets(profile.captionAppearances || []);
    }).catch(() => {});

    return () => { active = false; };
  }, [project.id, project.media.filename]);

  useEffect(() => {
    return () => {
      if (dirtyRef.current) {
        const finalSnapshot = { ...appearanceRef.current };
        void queueCaptionAppearanceSave(project.id, finalSnapshot);
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
    if (!dirtyRef.current) return;
    if (isRecoveringRef.current) {
      isRecoveringRef.current = false;
      return;
    }
    setSaveState((state) => state === 'saving' ? state : 'pending');
    const snapshot = { ...appearance };
    const timer = window.setTimeout(() => { void persistAppearance(snapshot); }, 650);
    return () => window.clearTimeout(timer);
  }, [appearance]);

  const currentFontAvailable = fonts.some((font) => font.name === appearance.fontFamily);
  const fontOptions = useMemo(() => {
    if (currentFontAvailable || !appearance.fontFamily) return fonts;
    return [{ name: appearance.fontFamily, available: false, boldAvailable: appearance.bold, source: 'user-installed' as const }, ...fonts];
  }, [fonts, currentFontAvailable, appearance.fontFamily, appearance.bold]);
  const currentPreset = presets.find((preset) => preset.id === selectedPresetId);
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

  const commitAppearance = (
    next: CaptionAppearance,
    options: { history?: 'discrete' | 'range' | 'none'; clearPreset?: boolean } = {},
  ) => {
    const current = appearanceRef.current;
    if (JSON.stringify(current) === JSON.stringify(next)) return false;
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
    appearanceRef.current = next;
    dirtyRef.current = true;
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
    const current = { ...appearanceRef.current };
    rangeHistoryActiveRef.current = false;
    setRedoAppearance(current);
    setUndoAppearance(null);
    setSelectedPresetId('');
    commitAppearance({ ...undoAppearance }, { history: 'none', clearPreset: false });
  };

  const redoAppearanceChange = () => {
    if (!redoAppearance) return;
    const current = { ...appearanceRef.current };
    rangeHistoryActiveRef.current = false;
    setUndoAppearance(current);
    setRedoAppearance(null);
    setSelectedPresetId('');
    commitAppearance({ ...redoAppearance }, { history: 'none', clearPreset: false });
  };

  const replayEffect = async () => {
    if (!onReplayEffect || replayPreparing || replayDisabled || replayPending) return;
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

  const applyLook = (look: CaptionLookId) => {
    updateAppearance((current) => applyCaptionLook(current, look));
  };

  const resetLook = () => {
    updateAppearance((current) => applyCaptionLook(current, null));
  };

  useEffect(() => {
    if (loadingFonts || !appearanceRef.current.bold) return;
    const font = fonts.find((item) => item.name === appearanceRef.current.fontFamily);
    if (!font || font.boldAvailable) return;
    updateAppearance((current) => ({ ...current, bold: false }), { history: 'none' });
    setFontNotice(`${font.name} does not include a Bold face, so Studio switched Weight to Regular. Your other appearance settings were kept.`);
  }, [loadingFonts, fonts, project.id]);

  const chooseFont = (name: string) => {
    const chosen = fonts.find((font) => font.name === name);
    setFontQuery('');
    setFontNotice('');
    setFontWarnings([]);
    if (chosen && appearanceRef.current.bold && !chosen.boldAvailable) {
      updateAppearance((current) => ({ ...current, fontFamily: name, bold: false }));
      setFontNotice(`${name} does not include a Bold face, so Studio switched Weight to Regular. Your other appearance settings were kept.`);
      return;
    }
    updateAppearance((current) => ({ ...current, fontFamily: name }));
  };

  const addFonts = async (files: FileList | File[] | null) => {
    const selected = Array.from(files || []);
    if (!selected.length) return;
    setAddingFonts(true);
    setFontError('');
    setFontNotice('');
    setFontWarnings([]);
    try {
      const result = await api.addCaptionFonts(selected);
      const available = result.fonts.filter((font) => font.available);
      setFonts(available);
      setFontWarnings(result.warnings);
      const firstName = result.imported[0];
      const first = firstName ? available.find((font) => font.name === firstName) : undefined;
      if (!first) {
        if (!result.warnings.length) setFontError('No compatible Khmer font was added. Choose a Regular .ttf or .otf font file.');
        return;
      }
      setFontQuery('');
      const boldMismatch = appearanceRef.current.bold && !first.boldAvailable;
      updateAppearance((current) => ({ ...current, fontFamily: first.name, ...(boldMismatch ? { bold: false } : {}) }));
      const count = result.imported.length;
      setFontNotice(`${count === 1 ? `Added “${first.name}”` : `Added ${count} Khmer font families`}. ${first.name} is selected.${boldMismatch ? ' It has no Bold face, so Studio is using Regular; your other appearance settings were kept.' : ''}`);
    } catch (error) {
      setFontError(error instanceof Error ? error.message : 'Could not add the selected font files');
    } finally {
      setAddingFonts(false);
    }
  };

  const removeAddedFont = async (font: VideoExportFontCapability) => {
    if (!font.id || !font.removable) return;
    const selectedHere = appearanceRef.current.fontFamily === font.name;
    const confirmed = await onConfirm({
      title: `Remove “${font.name}” from Studio?`,
      message: selectedHere
        ? 'This project will keep the font name, but preview and captioned-video export will pause until you add it again or choose another available font.'
        : 'This removes the copy you added to Studio. Projects that use this font keep the saved font name and will ask for an available font before preview or render.',
      confirmLabel: 'Remove font',
      tone: 'warning',
    });
    if (!confirmed) return;
    setRemovingFontId(font.id);
    setFontError('');
    setFontNotice('');
    setFontWarnings([]);
    try {
      const result = await api.removeCaptionFont(font.id);
      setFonts(result.fonts.filter((item) => item.available));
      setFontNotice(`Removed “${font.name}” from Studio. Fonts installed on your computer were not changed.`);
    } catch (error) {
      setFontError(error instanceof Error ? error.message : 'Could not remove that font from Studio');
    } finally {
      setRemovingFontId('');
    }
  };

  const applyPreset = (id: string) => {
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
      ? `${requested.fontFamily} does not include a Bold face, so this preset is using Regular. Other preset settings were kept.`
      : '');
  };

  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    setSavingPreset(true);
    setPresetError('');
    try {
      const profile = await api.profile();
      const now = new Date().toISOString();
      const existing = (profile.captionAppearances || []).find((preset) => preset.name.toLocaleLowerCase('en') === name.toLocaleLowerCase('en'));
      const next: CaptionAppearancePreset = existing
        ? { ...existing, name, appearance: { ...appearanceRef.current }, updatedAt: now }
        : { id: crypto.randomUUID(), name, appearance: { ...appearanceRef.current }, createdAt: now, updatedAt: now };
      const captionAppearances = [next, ...(profile.captionAppearances || []).filter((preset) => preset.id !== next.id)].slice(0, 20);
      const updated = await api.patchProfile({ captionAppearances });
      setPresets(updated.captionAppearances || []);
      setSelectedPresetId(next.id);
      setPresetName('');
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : 'Could not save appearance preset');
    } finally {
      setSavingPreset(false);
    }
  };

  const deletePreset = async () => {
    if (!selectedPresetId) return;
    const target = presets.find((item) => item.id === selectedPresetId);
    const confirmed = await onConfirm({
      title: `Delete “${target?.name || 'Preset'}”?`,
      message: 'This removes the preset from your profile. Existing projects that use this appearance are not changed.',
      confirmLabel: 'Delete preset',
      tone: 'warning',
    });
    if (!confirmed) return;
    setSavingPreset(true);
    setPresetError('');
    try {
      const profile = await api.profile();
      const updated = await api.patchProfile({ captionAppearances: (profile.captionAppearances || []).filter((preset) => preset.id !== selectedPresetId) });
      setPresets(updated.captionAppearances || []);
      setSelectedPresetId('');
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : 'Could not delete appearance preset');
    } finally {
      setSavingPreset(false);
    }
  };

  return <section className="caption-appearance-workspace" aria-labelledby="caption-appearance-workspace-title" {...interactionHandlers}>
    <div className="caption-appearance-head">
      <div><strong id="caption-appearance-workspace-title">Caption appearance</strong><span>Style captions while watching the video above. Size and position respond immediately when possible, then refine to the exact export layout. Video compression and display scaling can soften edges.</span></div>
      <div className={`appearance-save-state ${saveState}`} role="status" aria-live="polite">
        {saveState === 'saving' || saveState === 'pending' ? <LoaderCircle className="spin" size={14}/> : saveState === 'error' ? <TriangleAlert size={14}/> : <CheckCircle2 size={14}/>}<span>{saveStateCopy(saveState)}</span>{saveState === 'error' && <button onClick={() => void persistAppearance({ ...appearanceRef.current })}>Retry</button>}
      </div>
    </div>

    <div className="appearance-effect-toolbar" aria-label="Appearance history">
      <div className="appearance-history">
        <button type="button" disabled={!undoAppearance} onClick={undoAppearanceChange}><Undo2 size={14}/>Undo</button>
        <button type="button" disabled={!redoAppearance} onClick={redoAppearanceChange}><Redo2 size={14}/>Redo</button>
      </div>
    </div>

    <div className="appearance-preset-bar">
      <label htmlFor="appearance-preset-select">
        <span>Preset</span>
        <select id="appearance-preset-select" aria-label="Preset" value={selectedPresetId} onChange={(event) => applyPreset(event.target.value)}>
          <option value="">Custom / current project</option>
          {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
      </label>
      <details className="appearance-preset-tools">
        <summary>Manage presets</summary>
        <div className="appearance-preset-tools-body">
          <label><span>Save current look as</span><input value={presetName} maxLength={80} onChange={(event) => setPresetName(event.target.value)} placeholder="Example: Clean Khmer"/></label>
          <button disabled={!presetName.trim() || savingPreset} onClick={() => void savePreset()}><Save size={14}/>{savingPreset ? 'Saving…' : 'Save preset'}</button>
          {selectedPresetId && <div className="preset-delete-row"><span>Selected: <b>{currentPreset?.name || 'Preset'}</b></span><button className="danger-quiet" disabled={savingPreset} onClick={() => void deletePreset()}><Trash2 size={14}/>Delete preset</button></div>}
        </div>
      </details>
    </div>

    {presetError && <div className="appearance-inline-warning" role="alert"><TriangleAlert size={15}/><span>{presetError}</span></div>}
    {fontError && <div className="appearance-inline-warning" role="alert"><TriangleAlert size={15}/><span>{fontError}. Your current appearance remains unchanged.</span></div>}
    {fontWarnings.length > 0 && <div className="appearance-inline-warning" role="status"><TriangleAlert size={15}/><span>{fontWarnings.join(' ')}</span></div>}
    {fontNotice && <div className="appearance-font-notice" role="status"><CheckCircle2 size={15}/><span>{fontNotice}</span></div>}
    {!loadingFonts && !currentFontAvailable && <div className="appearance-inline-warning"><TriangleAlert size={15}/><span><b>{appearance.fontFamily}</b> is not available on this PC. Choose an available Khmer font before previewing or rendering. The saved font has not been substituted.</span></div>}

    <CaptionLooksGallery
      appearance={appearance}
      sampleCaptionText={sampleCaptionText}
      onSelect={applyLook}
      onReset={resetLook}
    />

    <div className="appearance-essential-grid">
      <div className="appearance-font-field"><span>Khmer font</span>{installedFonts.length > 24 && <div className="appearance-font-search-wrap"><input className="appearance-font-search" type="search" aria-label="Find Khmer font" aria-expanded={Boolean(normalizedFontQuery)} aria-controls="appearance-font-search-results" value={fontQuery} onChange={(event) => setFontQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setFontQuery(''); else if (event.key === 'Enter' && fontSearchResults[0]) { event.preventDefault(); chooseFont(fontSearchResults[0].name); } }} placeholder={`Find among ${installedFonts.length} installed Khmer fonts…`}/>{normalizedFontQuery && <div id="appearance-font-search-results" className="appearance-font-search-results" aria-label="Matching Khmer fonts">{fontSearchResults.length > 0 ? fontSearchResults.map((font) => <button type="button" key={`${font.source}:${font.name}`} className={font.name === appearance.fontFamily ? 'selected' : ''} onClick={() => chooseFont(font.name)}><span>{font.name}</span><small>{font.source === 'studio-imported' ? 'Added to Studio' : 'Installed'} · {font.boldAvailable ? 'Regular + Bold' : 'Regular only'}</small></button>) : <div className="appearance-font-search-empty">No matching Khmer fonts</div>}</div>}</div>}<div className="appearance-font-picker"><select aria-label="Khmer font" value={appearance.fontFamily} disabled={loadingFonts && !fontOptions.length} onChange={(event) => chooseFont(event.target.value)}>{!currentFontAvailable && appearance.fontFamily && <option value={appearance.fontFamily}>{appearance.fontFamily} · unavailable</option>}{addedFontOptions.length > 0 && <optgroup label="Added to Studio">{addedFontOptions.map((font) => <option key={font.name} value={font.name}>{font.name}{font.boldAvailable ? '' : ' · regular only'}</option>)}</optgroup>}{installedFonts.length > 0 && <optgroup label={`Installed on this computer (${installedFonts.length})`}>{installedFonts.map((font) => <option key={font.name} value={font.name}>{font.name}{font.boldAvailable ? '' : ' · regular only'}</option>)}</optgroup>}{loadingFonts && !fontOptions.length && <option value={appearance.fontFamily}>Checking local fonts…</option>}</select><button type="button" disabled={addingFonts} onClick={() => fontInputRef.current?.click()}><Plus size={14}/>{addingFonts ? 'Adding…' : 'Add font…'}</button><input ref={fontInputRef} className="appearance-font-file-input" type="file" accept=".ttf,.otf,font/ttf,font/otf" multiple onChange={(event) => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; void addFonts(files); }}/></div><small>{installedFonts.length ? `${installedFonts.length} compatible Khmer fonts installed on this computer are ready to use. ` : 'Compatible Khmer fonts installed on this computer appear automatically. '}Add your own .ttf or .otf files only to Studio.</small></div>
      <label><span>Text color</span><input type="color" value={appearance.textColor} onChange={(event) => updateAppearance((current) => ({ ...current, textColor: event.target.value.toUpperCase() }))}/></label>
      <label className="range-field"><span>Size <b>{appearance.fontSize1080}px @1080p</b></span><input type="range" min="22" max="120" value={appearance.fontSize1080} onChange={(event) => updateAppearance((current) => ({ ...current, fontSize1080: Number(event.target.value) }), { history: 'range' })}/></label>
      <label className="range-field"><span>Position <b>{appearance.positionBottomPct}% from bottom</b></span><input type="range" min="3" max="82" value={appearance.positionBottomPct} onChange={(event) => updateAppearance((current) => ({ ...current, positionBottomPct: Number(event.target.value) }), { history: 'range' })}/></label>
    </div>

    {addedFonts.length > 0 && <details className="appearance-font-manager"><summary>Manage added fonts <b>{addedFonts.length}</b></summary><div className="appearance-font-manager-list">{addedFonts.map((font) => <div className="appearance-font-manager-row" key={font.id}><div><strong>{font.name}</strong><span>{font.boldAvailable ? 'Regular + Bold' : 'Regular only'} · Added to Studio</span></div><button type="button" className="danger-quiet" disabled={removingFontId === font.id} onClick={() => void removeAddedFont(font)}><Trash2 size={14}/>{removingFontId === font.id ? 'Removing…' : 'Remove'}</button></div>)}</div></details>}

    <section className="caption-effects-section appearance-motion-section" aria-labelledby="appearance-motion-title">
      <div className="caption-effects-section-head">
        <div>
          <strong id="appearance-motion-title">Motion</strong>
          <span>Choose how the whole caption fades in and out. Motion does not change caption timing or word emphasis.</span>
        </div>
      </div>
      <div className="appearance-motion-controls">
        <div className="appearance-motion-choice">
          <span>Entrance &amp; exit</span>
          <div className="appearance-segmented" role="group" aria-label="Caption motion">
            <button type="button" aria-pressed={(appearance.motionPreset || 'none') === 'none'} onClick={() => updateAppearance((current) => ({ ...current, motionPreset: 'none' }))}>None</button>
            <button type="button" aria-pressed={appearance.motionPreset === 'fade'} onClick={() => updateAppearance((current) => ({ ...current, motionPreset: 'fade' }))}>Fade</button>
          </div>
        </div>
        {appearance.motionPreset === 'fade' && <label className="appearance-motion-duration range-field">
          <span>Fade duration <b>{appearance.motionDurationMs || DEFAULT_CAPTION_APPEARANCE.motionDurationMs} ms</b></span>
          <input type="range" min="80" max="400" step="10" value={appearance.motionDurationMs || DEFAULT_CAPTION_APPEARANCE.motionDurationMs}
            onChange={(event) => updateAppearance((current) => ({ ...current, motionDurationMs: Number(event.target.value) }), { history: 'range' })}/>
        </label>}
      </div>
      <div className="appearance-motion-actions">
        {onReplayEffect && <button
          type="button"
          className="primary-effect-action"
          disabled={appearance.motionPreset !== 'fade' || replayPreparing || replayDisabled || replayPending}
          onClick={() => void replayEffect()}
        >
          {replayPreparing || replayPending ? <LoaderCircle className="spin" size={14}/> : <Play size={14}/>}
          {replayPreparing || replayPending ? 'Preparing…' : 'Replay effect'}
        </button>}
        {appearance.motionPreset !== 'none' && <button type="button" onClick={() => updateAppearance((current) => ({ ...current, motionPreset: 'none' }))}><RotateCcw size={14}/>Turn motion off</button>}
      </div>
      <span className="appearance-motion-help">Replay the selected caption once. Studio prepares its opening first; later frames are prepared as needed.</span>
    </section>

    <section className="appearance-word-highlight" aria-label="Spoken word highlight">
      <div className="appearance-word-emphasis-title"><strong>Word emphasis</strong><span>Optional timing-aware emphasis for the word currently being spoken.</span></div>
      <div className="appearance-word-highlight-head">
        <div><strong>Spoken word highlight</strong><p>Keep the whole caption visible and color the word being spoken.</p></div>
        <button type="button" aria-label="Highlight spoken word" aria-pressed={appearance.highlightMode === 'word'} className={appearance.highlightMode === 'word' ? 'selected' : ''}
          onClick={() => updateAppearance((current) => ({ ...current, highlightMode: current.highlightMode === 'word' ? 'off' : 'word' }))}>
          {appearance.highlightMode === 'word' ? 'On' : 'Off'}
        </button>
      </div>
      {appearance.highlightMode === 'word' && <>
        <label className="appearance-highlight-color"><span>Highlight color</span><input type="color" aria-label="Word highlight color" value={appearance.highlightColor || '#D7FF4F'}
          onChange={(event) => updateAppearance((current) => ({ ...current, highlightColor: event.target.value.toUpperCase() }))}/></label>
        <div className="appearance-highlight-readiness" role="status">
          <span>{wordReadiness.total - wordReadiness.unresolved.length} of {wordReadiness.total} captions have usable word timing.
            {wordReadiness.unresolved.length > 0 ? ` ${wordReadiness.unresolved.length} will stay plain until their words are synced or confirmed.` : ' Pauses keep the normal text color.'}</span>
          <button type="button" onClick={() => onEditWordTiming(wordReadiness.unresolved[0]?.id)}>{wordReadiness.unresolved.length ? 'Review word timing' : 'Edit word timing'}</button>
        </div>
        <p className="appearance-highlight-note">Word highlights are included in captioned video. SRT keeps plain caption text and timing.</p>
      </>}
    </section>

    <details className="appearance-more">
      <summary>More appearance</summary>
      <div className="appearance-grid">
        <div className="toggle-field"><span>Weight</span><button aria-pressed={appearance.bold} className={appearance.bold ? 'selected' : ''} title={chosenFont && !chosenFont.boldAvailable ? `${chosenFont.name} includes Regular only.` : undefined} disabled={Boolean(chosenFont && !chosenFont.boldAvailable && !appearance.bold)} onClick={() => updateAppearance((current) => ({ ...current, bold: !current.bold }))}>{appearance.bold ? 'Bold' : 'Regular'}</button></div>
        <label><span>Outline color</span><input type="color" value={appearance.outlineColor} onChange={(event) => updateAppearance((current) => ({ ...current, outlineColor: event.target.value.toUpperCase() }))}/></label>
        <label className="range-field"><span>Outline <b>{appearance.outlineWidth1080.toFixed(1)}</b></span><input type="range" min="0" max="12" step="0.5" value={appearance.outlineWidth1080} onChange={(event) => updateAppearance((current) => ({ ...current, outlineWidth1080: Number(event.target.value) }), { history: 'range' })}/></label>
        <label className="range-field"><span>Shadow <b>{appearance.shadowWidth1080.toFixed(1)}</b></span><input type="range" min="0" max="12" step="0.5" value={appearance.shadowWidth1080} onChange={(event) => updateAppearance((current) => ({ ...current, shadowWidth1080: Number(event.target.value) }), { history: 'range' })}/></label>
        <label className="range-field"><span>Max width <b>{appearance.maxWidthPct}%</b></span><input type="range" min="45" max="96" value={appearance.maxWidthPct} onChange={(event) => updateAppearance((current) => ({ ...current, maxWidthPct: Number(event.target.value) }), { history: 'range' })}/></label>
        <label><span>Alignment</span><select value={appearance.alignment} onChange={(event) => updateAppearance((current) => ({ ...current, alignment: event.target.value as CaptionAppearance['alignment'] }))}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
        <div className="toggle-field"><span>Background box</span><button aria-pressed={appearance.backgroundEnabled} className={appearance.backgroundEnabled ? 'selected' : ''} onClick={() => updateAppearance((current) => ({ ...current, backgroundEnabled: !current.backgroundEnabled }))}>{appearance.backgroundEnabled ? 'On' : 'Off'}</button></div>
        {appearance.backgroundEnabled && <><label><span>Background color</span><input type="color" value={appearance.backgroundColor} onChange={(event) => updateAppearance((current) => ({ ...current, backgroundColor: event.target.value.toUpperCase() }))}/></label><label className="range-field"><span>Background opacity <b>{Math.round(appearance.backgroundOpacity * 100)}%</b></span><input type="range" min="5" max="100" value={Math.round(appearance.backgroundOpacity * 100)} onChange={(event) => updateAppearance((current) => ({ ...current, backgroundOpacity: Number(event.target.value) / 100 }), { history: 'range' })}/></label><label className="range-field"><span>Box padding <b>{appearance.backgroundPadding1080}px</b></span><input type="range" min="0" max="28" value={appearance.backgroundPadding1080} onChange={(event) => updateAppearance((current) => ({ ...current, backgroundPadding1080: Number(event.target.value) }), { history: 'range' })}/></label></>}
        <div className="appearance-glow-group">
          <div className="toggle-field"><span>Glow</span><button aria-pressed={appearance.glowEnabled === true} className={appearance.glowEnabled ? 'selected' : ''} onClick={() => updateAppearance((current) => ({ ...current, glowEnabled: !current.glowEnabled }))}>{appearance.glowEnabled ? 'On' : 'Off'}</button></div>
          {appearance.glowEnabled && <><label><span>Glow color</span><input type="color" value={appearance.glowColor || DEFAULT_CAPTION_APPEARANCE.glowColor} onChange={(event) => updateAppearance((current) => ({ ...current, glowColor: event.target.value.toUpperCase() }))}/></label><label className="range-field"><span>Glow width <b>{(appearance.glowWidth1080 || 0).toFixed(1)}</b></span><input type="range" min="0" max="16" step="0.5" value={appearance.glowWidth1080 || 0} onChange={(event) => updateAppearance((current) => ({ ...current, glowWidth1080: Number(event.target.value) }), { history: 'range' })}/></label><label className="range-field"><span>Glow opacity <b>{Math.round((appearance.glowOpacity || 0) * 100)}%</b></span><input type="range" min="0" max="100" value={Math.round((appearance.glowOpacity || 0) * 100)} onChange={(event) => updateAppearance((current) => ({ ...current, glowOpacity: Number(event.target.value) / 100 }), { history: 'range' })}/></label></>}
        </div>
      </div>
    </details>

    <div className="appearance-workspace-footer"><span>Appearance is project styling. It never changes caption text, timing, locks, correction memory, source media, or SRT output.</span></div>
  </section>;
}
