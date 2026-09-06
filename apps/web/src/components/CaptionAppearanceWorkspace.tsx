import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_CAPTION_APPEARANCE,
  type CaptionAppearance,
  type CaptionAppearancePreset,
  type CaptionProject,
  type VideoExportFontCapability,
} from '@kcs/shared';
import { CheckCircle2, LoaderCircle, RotateCcw, Save, Trash2, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import { applyCaptionAppearancePreview, resolveCaptionAppearance } from '../caption-appearance-preview';
import { queueCaptionAppearanceSave, recoverUnsavedCaptionAppearance, waitForCaptionAppearanceSaves } from '../caption-appearance-save';
import './caption-appearance.css';

type AppearanceSaveState = 'saved' | 'pending' | 'saving' | 'error';

interface Props {
  project: CaptionProject;
}

function appearanceKey(value: CaptionAppearance) {
  return JSON.stringify(value);
}

function saveStateCopy(state: AppearanceSaveState) {
  if (state === 'saving') return 'Saving appearance…';
  if (state === 'pending') return 'Saving automatically…';
  if (state === 'error') return 'Appearance could not be saved';
  return 'Saved automatically';
}

export function CaptionAppearanceWorkspace({ project }: Props) {
  const initial = resolveCaptionAppearance(project.captionAppearance);
  const [appearance, setAppearance] = useState<CaptionAppearance>(initial);
  const [saveState, setSaveState] = useState<AppearanceSaveState>('saved');
  const [fonts, setFonts] = useState<VideoExportFontCapability[]>([]);
  const [loadingFonts, setLoadingFonts] = useState(true);
  const [fontError, setFontError] = useState('');
  const [presets, setPresets] = useState<CaptionAppearancePreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetError, setPresetError] = useState('');
  const [deletePresetArmed, setDeletePresetArmed] = useState(false);
  const appearanceRef = useRef<CaptionAppearance>(initial);
  const dirtyRef = useRef(false);

  const persistAppearance = async (snapshot: CaptionAppearance, reportState = true): Promise<boolean> => {
    const snapshotKey = appearanceKey(snapshot);
    if (reportState) setSaveState('saving');
    const saved = await queueCaptionAppearanceSave(project.id, snapshot);
    if (saved) {
      if (appearanceKey(appearanceRef.current) === snapshotKey) {
        dirtyRef.current = false;
        if (reportState) setSaveState('saved');
      } else if (reportState) setSaveState('pending');
      return true;
    }
    if (appearanceKey(appearanceRef.current) === snapshotKey && reportState) setSaveState('error');
    return false;
  };

  useEffect(() => {
    let active = true;
    const localInitial = resolveCaptionAppearance(project.captionAppearance);
    setAppearance(localInitial);
    appearanceRef.current = localInitial;
    dirtyRef.current = false;
    setSaveState('saved');
    setSelectedPresetId('');
    setPresetName('');
    setDeletePresetArmed(false);
    setLoadingFonts(true);
    setFontError('');

    void (async () => {
      const priorSaved = await waitForCaptionAppearanceSaves(project.id);
      if (!active) return;
      if (!priorSaved) {
        const recovered = recoverUnsavedCaptionAppearance(project.id);
        if (recovered) {
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
        const next = resolveCaptionAppearance(fresh.captionAppearance);
        setAppearance(next);
        appearanceRef.current = next;
      } catch {
        if (active) setSaveState('error');
      }
    })();

    void api.videoExportCapabilities(project.id)
      .then((capabilities) => {
        if (active) setFonts(capabilities.fonts.filter((font) => font.available));
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
    const root = document.documentElement;
    root.classList.add('caption-appearance-previewing');
    return () => {
      // Appearance is project styling, so leaving this workspace removes only
      // the editing badge. The current look stays on the real video in Review,
      // Fine timing, Accuracy, Caption grouping, and Details.
      root.classList.remove('caption-appearance-previewing');
      if (dirtyRef.current) {
        const finalSnapshot = { ...appearanceRef.current };
        void queueCaptionAppearanceSave(project.id, finalSnapshot);
      }
    };
  }, [project.id]);

  useEffect(() => {
    applyCaptionAppearancePreview(appearance);
  }, [appearance]);

  useEffect(() => {
    if (!dirtyRef.current) return;
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

  const updateAppearance = (change: (current: CaptionAppearance) => CaptionAppearance) => {
    setSelectedPresetId('');
    setDeletePresetArmed(false);
    const next = change(appearanceRef.current);
    appearanceRef.current = next;
    dirtyRef.current = true;
    setSaveState('pending');
    setAppearance(next);
  };

  const applyPreset = (id: string) => {
    setSelectedPresetId(id);
    setDeletePresetArmed(false);
    if (!id) return;
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;
    const targetFont = fonts.find((font) => font.name === preset.appearance.fontFamily);
    const next = {
      ...preset.appearance,
      bold: targetFont ? targetFont.boldAvailable && preset.appearance.bold : preset.appearance.bold,
    };
    appearanceRef.current = next;
    dirtyRef.current = true;
    setSaveState('pending');
    setAppearance(next);
  };

  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    setSavingPreset(true);
    setPresetError('');
    setDeletePresetArmed(false);
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
    setSavingPreset(true);
    setPresetError('');
    try {
      const profile = await api.profile();
      const updated = await api.patchProfile({ captionAppearances: (profile.captionAppearances || []).filter((preset) => preset.id !== selectedPresetId) });
      setPresets(updated.captionAppearances || []);
      setSelectedPresetId('');
      setDeletePresetArmed(false);
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : 'Could not delete appearance preset');
    } finally {
      setSavingPreset(false);
    }
  };

  return <section className="caption-appearance-workspace" aria-labelledby="caption-appearance-workspace-title">
    <div className="caption-appearance-head">
      <div><strong id="caption-appearance-workspace-title">Caption appearance</strong><span>Style captions while watching the real video above. This browser preview is approximate; the finished MP4 uses the local renderer.</span></div>
      <div className={`appearance-save-state ${saveState}`} role="status" aria-live="polite">
        {saveState === 'saving' || saveState === 'pending' ? <LoaderCircle className="spin" size={14}/> : saveState === 'error' ? <TriangleAlert size={14}/> : <CheckCircle2 size={14}/>}<span>{saveStateCopy(saveState)}</span>{saveState === 'error' && <button onClick={() => void persistAppearance({ ...appearanceRef.current })}>Retry</button>}
      </div>
    </div>

    <div className="appearance-preset-bar">
      <label><span>Preset</span><select value={selectedPresetId} onChange={(event) => applyPreset(event.target.value)}><option value="">Custom / current project</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
      <details className="appearance-preset-tools" onToggle={() => setDeletePresetArmed(false)}>
        <summary>Manage presets</summary>
        <div className="appearance-preset-tools-body">
          <label><span>Save current look as</span><input value={presetName} maxLength={80} onChange={(event) => setPresetName(event.target.value)} placeholder="Example: Clean Khmer"/></label>
          <button disabled={!presetName.trim() || savingPreset} onClick={() => void savePreset()}><Save size={14}/>{savingPreset ? 'Saving…' : 'Save preset'}</button>
          {selectedPresetId && <div className="preset-delete-row"><span>Selected: <b>{currentPreset?.name || 'Preset'}</b></span>{deletePresetArmed ? <><button className="danger-quiet" disabled={savingPreset} onClick={() => void deletePreset()}><Trash2 size={14}/>Confirm delete</button><button disabled={savingPreset} onClick={() => setDeletePresetArmed(false)}>Cancel</button></> : <button className="danger-quiet" disabled={savingPreset} onClick={() => setDeletePresetArmed(true)}><Trash2 size={14}/>Delete preset</button>}</div>}
        </div>
      </details>
    </div>

    {presetError && <div className="appearance-inline-warning" role="alert"><TriangleAlert size={15}/><span>{presetError}</span></div>}
    {fontError && <div className="appearance-inline-warning" role="alert"><TriangleAlert size={15}/><span>{fontError}. Your current appearance remains unchanged.</span></div>}
    {!loadingFonts && fonts.length > 0 && !currentFontAvailable && <div className="appearance-inline-warning"><TriangleAlert size={15}/><span><b>{appearance.fontFamily}</b> is not available on this PC. Choose an available Khmer font before rendering if you need an exact font match.</span></div>}

    <div className="appearance-essential-grid">
      <label><span>Khmer font</span><select value={appearance.fontFamily} disabled={loadingFonts && !fontOptions.length} onChange={(event) => { const font = fonts.find((item) => item.name === event.target.value); updateAppearance((current) => ({ ...current, fontFamily: event.target.value, bold: font ? font.boldAvailable && current.bold : current.bold })); }}>{fontOptions.map((font) => <option key={font.name} value={font.name}>{font.name}{font.available ? font.boldAvailable ? '' : ' · regular only' : ' · unavailable'}</option>)}{loadingFonts && !fontOptions.length && <option value={appearance.fontFamily}>Checking local fonts…</option>}</select></label>
      <label><span>Text color</span><input type="color" value={appearance.textColor} onChange={(event) => updateAppearance((current) => ({ ...current, textColor: event.target.value.toUpperCase() }))}/></label>
      <label className="range-field"><span>Size <b>{appearance.fontSize1080}px @1080p</b></span><input type="range" min="22" max="120" value={appearance.fontSize1080} onChange={(event) => updateAppearance((current) => ({ ...current, fontSize1080: Number(event.target.value) }))}/></label>
      <label className="range-field"><span>Position <b>{appearance.positionBottomPct}% from bottom</b></span><input type="range" min="3" max="82" value={appearance.positionBottomPct} onChange={(event) => updateAppearance((current) => ({ ...current, positionBottomPct: Number(event.target.value) }))}/></label>
    </div>

    <details className="appearance-more">
      <summary>More appearance</summary>
      <div className="appearance-grid">
        <div className="toggle-field"><span>Weight</span><button aria-pressed={appearance.bold} className={appearance.bold ? 'selected' : ''} disabled={Boolean(chosenFont && !chosenFont.boldAvailable)} onClick={() => updateAppearance((current) => ({ ...current, bold: !current.bold }))}>{appearance.bold ? 'Bold' : 'Regular'}</button></div>
        <label><span>Outline color</span><input type="color" value={appearance.outlineColor} onChange={(event) => updateAppearance((current) => ({ ...current, outlineColor: event.target.value.toUpperCase() }))}/></label>
        <label className="range-field"><span>Outline <b>{appearance.outlineWidth1080.toFixed(1)}</b></span><input type="range" min="0" max="12" step="0.5" value={appearance.outlineWidth1080} onChange={(event) => updateAppearance((current) => ({ ...current, outlineWidth1080: Number(event.target.value) }))}/></label>
        <label className="range-field"><span>Shadow <b>{appearance.shadowWidth1080.toFixed(1)}</b></span><input type="range" min="0" max="12" step="0.5" value={appearance.shadowWidth1080} onChange={(event) => updateAppearance((current) => ({ ...current, shadowWidth1080: Number(event.target.value) }))}/></label>
        <label className="range-field"><span>Max width <b>{appearance.maxWidthPct}%</b></span><input type="range" min="45" max="96" value={appearance.maxWidthPct} onChange={(event) => updateAppearance((current) => ({ ...current, maxWidthPct: Number(event.target.value) }))}/></label>
        <label><span>Alignment</span><select value={appearance.alignment} onChange={(event) => updateAppearance((current) => ({ ...current, alignment: event.target.value as CaptionAppearance['alignment'] }))}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
        <div className="toggle-field"><span>Background box</span><button aria-pressed={appearance.backgroundEnabled} className={appearance.backgroundEnabled ? 'selected' : ''} onClick={() => updateAppearance((current) => ({ ...current, backgroundEnabled: !current.backgroundEnabled }))}>{appearance.backgroundEnabled ? 'On' : 'Off'}</button></div>
        {appearance.backgroundEnabled && <><label><span>Background color</span><input type="color" value={appearance.backgroundColor} onChange={(event) => updateAppearance((current) => ({ ...current, backgroundColor: event.target.value.toUpperCase() }))}/></label><label className="range-field"><span>Background opacity <b>{Math.round(appearance.backgroundOpacity * 100)}%</b></span><input type="range" min="5" max="100" value={Math.round(appearance.backgroundOpacity * 100)} onChange={(event) => updateAppearance((current) => ({ ...current, backgroundOpacity: Number(event.target.value) / 100 }))}/></label><label className="range-field"><span>Box padding <b>{appearance.backgroundPadding1080}px</b></span><input type="range" min="0" max="28" value={appearance.backgroundPadding1080} onChange={(event) => updateAppearance((current) => ({ ...current, backgroundPadding1080: Number(event.target.value) }))}/></label></>}
      </div>
    </details>

    <div className="appearance-workspace-footer"><span>Appearance is project styling. It never changes caption text, timing, locks, correction memory, source media, or SRT output.</span><button className="quiet-action" onClick={() => updateAppearance(() => ({ ...DEFAULT_CAPTION_APPEARANCE, fontFamily: fonts[0]?.name || DEFAULT_CAPTION_APPEARANCE.fontFamily, bold: fonts[0] ? fonts[0].boldAvailable && DEFAULT_CAPTION_APPEARANCE.bold : DEFAULT_CAPTION_APPEARANCE.bold }))}><RotateCcw size={14}/>Reset appearance</button></div>
  </section>;
}
