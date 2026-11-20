import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { isVideoProject, type CaptionProject } from '@kcs/shared';
import {
  BookOpenCheck,
  Check,
  ChevronRight,
  Download,
  HelpCircle,
  ListRestart,
  FileUp,
  X,
} from 'lucide-react';

interface HomeChecklistProps {
  llmConfigured?: boolean;
  timingConfigured?: boolean;
  onConnect(): void;
  onOpenDoctor(): void;
  onDismiss(): void;
}

export function HomeSetupChecklist({ llmConfigured, timingConfigured, onConnect, onOpenDoctor, onDismiss }: HomeChecklistProps) {
  if (llmConfigured && timingConfigured) return <section className="home-ready-strip" aria-label="Sthang Studio ready">
    <strong><Check size={16} aria-hidden="true"/>Studio ready</strong>
    <button onClick={onDismiss} aria-label="Dismiss ready status"><X size={14}/></button>
  </section>;
  if (llmConfigured !== false && timingConfigured !== false) return null;
  return <section className="first-run-card" aria-label="Getting started">
    <div className="first-run-heading"><strong>Caption setup</strong><button onClick={onDismiss} aria-label="Dismiss getting started"><X size={15}/></button></div>
    <div className="first-run-steps">
      {llmConfigured === false && <button onClick={onConnect}><span><b>Connect AI</b><small>Add your key in Settings.</small></span><ChevronRight size={16} aria-hidden="true"/></button>}
      {timingConfigured === false && <button onClick={onOpenDoctor}><span><b>Set up Khmer timing</b><small>Open System check for setup instructions.</small></span><ChevronRight size={16} aria-hidden="true"/></button>}
    </div>
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
    <header><div><HelpCircle size={18}/><span><strong>Quick guide</strong></span></div><button ref={closeButton} onClick={close} aria-label="Close guide"><X size={16}/></button></header>

    {!project ? <div className="guide-empty"><FileUp size={28}/><strong>Create a project first</strong><span>Upload a video or audio file from Home to begin.</span></div> : <div className="guide-content">
      <section className="guide-workflow">
        <h3>Caption workflow</h3>
        <button className={llmConfigured ? 'done' : 'next'} onClick={() => handoff(onConnect)}><i>{llmConfigured ? <Check size={14}/> : 1}</i><span><b>Connect AI</b><small>{llmConfigured ? 'Connected' : 'Required to generate caption text.'}</small></span></button>
        <button className={timingConfigured ? 'done' : 'next'} onClick={() => handoff(onOpenDoctor)}><i>{timingConfigured ? <Check size={14}/> : 2}</i><span><b>Khmer timing</b><small>{timingConfigured ? 'Timing ready' : 'Open System check for setup.'}</small></span><ChevronRight size={14}/></button>
        <button onClick={() => handoff(onContext)}><i>3</i><span><b>Add accuracy context <em>optional</em></b><small>Preserve names, brands, versions, and Khmer-English terms.</small></span><ChevronRight size={14}/></button>
        {hasCaptions ? <div className="guide-completed-step"><Check size={16} aria-hidden="true"/><b>{project.transcript ? 'Captions generated' : 'Captions added'}</b></div>
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
        <div><BookOpenCheck size={15}/><span><b>Corrections</b><small>Learns from edits after you approve each suggestion.</small></span></div>
        <div><ListRestart size={15}/><span><b>Regeneration preview</b><small>Creates a proposal. Nothing changes until you accept it.</small></span></div>
      </section>
    </div>}

  </aside>;
}
