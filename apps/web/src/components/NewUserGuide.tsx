import { useI18n } from '../i18n';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { isVideoProject, type CaptionProject } from '@kcs/shared';
import {
  BookOpenCheck,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  HelpCircle,
  ListRestart,
  FileUp,
  X,
} from 'lucide-react';
import type { LlmConnectionTest, LlmSettingsStatus, SaveLlmSettingsInput } from '../api';
import { AiSettingsPanel } from './AiSettingsPanel';

interface HomeChecklistProps {
  llmSettings: LlmSettingsStatus | null;
  timingConfigured: boolean | undefined;
  onSaveLlm(input: SaveLlmSettingsInput): Promise<LlmSettingsStatus>;
  onTestLlm(input: { apiKey?: string; model?: string }): Promise<LlmConnectionTest>;
  onCheckTiming(): Promise<boolean>;
  onOpenDoctor(): void;
  onDismiss(): void;
}

export function HomeSetupChecklist({ llmSettings, timingConfigured, onSaveLlm, onTestLlm, onCheckTiming, onOpenDoctor, onDismiss }: HomeChecklistProps) {
  const { t, tr } = useI18n();
  const id = useId();
  const [lastKnownTiming, setLastKnownTiming] = useState(timingConfigured);
  if (typeof timingConfigured === 'boolean' && timingConfigured !== lastKnownTiming) setLastKnownTiming(timingConfigured);
  const timingReady = timingConfigured ?? lastKnownTiming;
  const aiReady = llmSettings?.configured;
  const firstIncomplete = aiReady === false ? 'ai' : timingReady === false ? 'timing' : null;
  const [expansion, setExpansion] = useState({ firstIncomplete, open: firstIncomplete });
  if (expansion.firstIncomplete !== firstIncomplete) setExpansion({ firstIncomplete, open: firstIncomplete });
  const [timingCheck, setTimingCheck] = useState<'idle' | 'checking' | 'incomplete' | 'unavailable'>('idle');
  const checking = useRef(false);
  const checkTiming = async () => {
    if (checking.current) return;
    checking.current = true;
    setTimingCheck('checking');
    const read = await onCheckTiming();
    checking.current = false;
    setTimingCheck(read ? 'incomplete' : 'unavailable');
    if (!read) setExpansion({ firstIncomplete, open: 'timing' });
  };

  if (aiReady && timingReady) return <section className="home-ready-strip" aria-label={t('setup.home.readyLabel')}>
    <strong><Check size={16} aria-hidden="true"/>{t('setup.home.ready')}</strong>
    <button onClick={onDismiss} aria-label={t('setup.home.dismissReady')}><X size={14}/></button>
  </section>;
  if (aiReady !== false && timingReady !== false) return null;
  const agent = navigator.userAgent;
  const timingInstruction = /Windows/i.test(agent)
    ? tr('setup.home.windows', {}, { b: (text) => <strong>{text}</strong> })
    : /Macintosh|Mac OS X/i.test(agent)
      ? tr('setup.home.macos', {}, { b: (text) => <strong>{text}</strong> })
      : tr('setup.home.other', {}, { b: (text) => <strong>{text}</strong> });
  const steps = [
    {
      id: 'ai', title: t('setup.home.connect'), ready: aiReady,
      status: aiReady ? t('setup.home.keySaved') : aiReady === false ? t('setup.home.keyNeeded') : t('setup.home.unknown'),
      body: llmSettings && <AiSettingsPanel variant="inline" settings={llmSettings} onSave={onSaveLlm} onTest={onTestLlm}/>,
    },
    {
      id: 'timing', title: t('setup.home.setUpTiming'), ready: timingReady,
      status: timingReady ? t('setup.home.timingReady') : timingReady === false ? t('setup.home.timingNotReady') : t('setup.home.unknown'),
      body: <>
        <p className="first-run-timing-status" role="status" aria-live="polite" aria-atomic="true">{
          timingCheck === 'unavailable' ? t('setup.home.checkUnavailable')
            : timingCheck === 'incomplete' ? t('setup.home.checkIncomplete')
              : t('setup.home.timingNotReady')
        }</p>
        <p>{timingInstruction}</p>
        <div className="first-run-actions">
          <button type="button" aria-busy={timingCheck === 'checking' || undefined} onClick={() => void checkTiming()}>{timingCheck === 'checking' ? t('setup.home.checking') : t('setup.home.checkAgain')}</button>
          <button type="button" className="first-run-link" onClick={onOpenDoctor}>{t('setup.home.systemCheck')}</button>
        </div>
      </>,
    },
  ] as const;

  return <section className="first-run-card" aria-label={t('setup.home.gettingStarted')}>
    <div className="first-run-heading"><h2>{t('setup.home.heading')}</h2><button type="button" onClick={onDismiss} aria-label={t('setup.home.dismissGettingStarted')}><X size={15} aria-hidden="true"/>{t('setup.home.dismiss')}</button></div>
    <ol className="first-run-steps" role="list">
      {steps.map((step, index) => {
        const expanded = expansion.open === step.id;
        const bodyId = id + '-' + step.id;
        const label = <>
          <span className="first-run-number" aria-hidden="true">{step.ready ? <Check size={14}/> : index + 1}</span>
          <b>{step.title}</b>
          <small>{step.status}</small>
        </>;
        return <li key={step.id}>
          {step.ready === false ? <>
            <button type="button" className="first-run-step-header" aria-expanded={expanded} aria-controls={bodyId}
              onClick={() => setExpansion({ firstIncomplete, open: expanded ? null : step.id })}>
              {label}<ChevronDown size={15} aria-hidden="true"/>
            </button>
            <div id={bodyId} className="first-run-step-body" hidden={!expanded}>{step.body}</div>
          </> : <div className="first-run-step-header">{label}</div>}
        </li>;
      })}
      <li>
        <div className="first-run-step-header"><span className="first-run-number" aria-hidden="true">3</span><b>{t('setup.home.chooseVideo')}</b><small>{t('setup.home.available')}</small></div>
        <p className="first-run-video">{t('setup.home.dropVideo')}</p>
      </li>
    </ol>
  </section>;
}

interface GuideProps {
  open: boolean;
  project: CaptionProject | null;
  llmConfigured?: boolean;
  timingConfigured?: boolean;
  hasCaptions: boolean;
  generationPending: boolean;
  issueCount: number;
  onClose(): void;
  onConnect(): void;
  onOpenDoctor(): void;
  onGenerate(): void;
  onReview(): void;
  onContext(): void;
  onExport(): void;
}

export function NewUserGuide({
  open,
  project,
  llmConfigured,
  timingConfigured,
  hasCaptions,
  generationPending,
  issueCount,
  onClose,
  onConnect,
  onOpenDoctor,
  onGenerate,
  onReview,
  onContext,
  onExport,
}: GuideProps) {
  const guide = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const foregroundSurface = () => Boolean(document.querySelector('[aria-modal="true"]')) || Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).some((node) => node.getClientRects().length && !node.closest('[inert],[hidden],[aria-hidden="true"]'));
  useLayoutEffect(() => {
    if (!open) { opener.current = null; return; }
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body && !guide.current?.contains(active) ? active : null;
    // The guide is nonmodal. A foreground surface or a newer edit keeps focus.
    if (!foregroundSurface() && !(active instanceof HTMLElement && active.closest('input,textarea,select,[contenteditable="true"]'))) closeButton.current?.focus({ preventScroll: true });
  }, [open]);
  const restoreOpener = () => {
    const target = opener.current;
    if (guide.current?.contains(document.activeElement) && target?.isConnected && target.getClientRects().length && !target.matches(':disabled') && !target.closest('[inert],[hidden],[aria-hidden="true"]')) target.focus({ preventScroll: true });
  };
  const close = () => { restoreOpener(); onClose(); };
  const handoff = (action: () => void) => {
    // Settings captures its return target when it opens. Restore the connected
    // guide opener first; no closing cleanup can later steal destination focus.
    restoreOpener();
    action();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.getModifierState('AltGraph') || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || foregroundSurface()) return;
    event.preventDefault(); event.stopPropagation(); close();
  };
  if (!open) return null;
  const mac = navigator.platform.toLowerCase().includes('mac');
  const modifier = mac ? 'Command' : 'Ctrl';
  const editingShortcuts = [
    [`${modifier}+S`, 'Save edits'], [`${modifier}+F`, 'Correct everywhere'], ['Space', 'Play / pause'],
    ['R', 'Replay selection'], ['E', 'Edit selected caption'], ['J', 'Jump to current caption'],
    [`${mac ? 'Option' : 'Alt'}+Left / Right`, 'Nudge selected captions by 50 ms'],
  ];
  const reviewShortcuts = [['Enter or A', 'Approve & next'], ['S', 'Skip without approving'], ['Up / Down', 'Previous / next flagged caption']];
  return <aside ref={guide} className="new-user-guide" aria-label="Sthang Studio guide" onKeyDown={onKeyDown}>
    <header><div><HelpCircle size={18}/><span><strong>Guide</strong></span></div><button ref={closeButton} onClick={close} aria-label="Close guide"><X size={16}/></button></header>

    {!project ? <div className="guide-empty"><FileUp size={28}/><strong>Create a project first</strong><span>Upload a video or audio file from Home to begin.</span></div> : <div className="guide-content">
      <section className="guide-workflow">
        <h3>Caption workflow</h3>
        <button className={llmConfigured ? 'done' : 'next'} onClick={() => handoff(onConnect)}><i>{llmConfigured ? <Check size={14}/> : 1}</i><span><b>Connect AI</b><small>{llmConfigured ? 'Connected' : 'Required to generate caption text.'}</small></span></button>
        <button className={timingConfigured ? 'done' : 'next'} onClick={() => handoff(onOpenDoctor)}><i>{timingConfigured ? <Check size={14}/> : 2}</i><span><b>Khmer timing</b><small>{timingConfigured ? 'Timing ready' : 'Open System check for setup.'}</small></span><ChevronRight size={14}/></button>
        <button onClick={() => handoff(onContext)}><i>3</i><span><b>Add accuracy context <em>optional</em></b><small>Preserve names, brands, versions, and Khmer-English terms.</small></span><ChevronRight size={14}/></button>
        {hasCaptions ? <div className="guide-step done"><i><Check size={14} aria-hidden="true"/></i><span><b>{project.transcript ? 'Captions generated' : 'Captions added'}</b></span></div>
          : <button className="next" onClick={() => handoff(onGenerate)} disabled={!llmConfigured || !timingConfigured || generationPending}><i>4</i><span><b>{generationPending ? 'Generation unavailable' : 'Generate captions'}</b><small>Create timed captions from the audio.</small></span><ChevronRight size={14}/></button>}
        <button className={hasCaptions && issueCount ? 'next' : hasCaptions ? 'done' : ''} onClick={() => handoff(onReview)} disabled={!hasCaptions}><i>{hasCaptions && !issueCount ? <Check size={14}/> : 5}</i><span><b>Review flagged captions</b><small>{hasCaptions ? `${issueCount} to check.` : 'Available after generation.'}</small></span><ChevronRight size={14}/></button>
        <button onClick={() => handoff(onExport)} disabled={!hasCaptions}><i>6</i><span><b>Export</b><small>{isVideoProject(project) ? 'Download subtitles or a video with captions.' : 'Download subtitles for your audio.'}</small></span><Download size={14}/></button>
      </section>

      <details className="guide-shortcuts">
        <summary>Keyboard shortcuts</summary>
        <p>Playback and Review shortcuts apply outside text fields and controls.</p>
        <h3>Editing and playback</h3>
        <dl>{editingShortcuts.map(([key, action]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{action}</dd></div>)}</dl>
        <h3>Review only</h3>
        <dl>{reviewShortcuts.map(([key, action]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{action}</dd></div>)}</dl>
      </details>

      <section className="guide-tools">
        <h3>Other tools</h3>
        <div><BookOpenCheck size={15}/><span><b>Correction inbox</b><small>Learns from edits after you approve each suggestion.</small></span></div>
        <div><ListRestart size={15}/><span><b>Improve captions</b><small>Creates a proposal. Nothing changes until you accept it.</small></span></div>
      </section>
    </div>}

  </aside>;
}
