import type { CaptionProject } from '@kcs/shared';
import {
  BookOpenCheck,
  Check,
  ChevronRight,
  Download,
  HelpCircle,
  KeyRound,
  ListChecks,
  Sparkles,
  TimerReset,
  UploadCloud,
  X,
} from 'lucide-react';

interface HomeChecklistProps {
  llmConfigured: boolean;
  timingConfigured: boolean;
  projectCount: number;
  onConnect(): void;
  onOpenDoctor(): void;
  onDismiss(): void;
}

export function HomeSetupChecklist({ llmConfigured, timingConfigured, projectCount, onConnect, onOpenDoctor, onDismiss }: HomeChecklistProps) {
  const complete = llmConfigured && timingConfigured && projectCount > 0;
  if (complete) return <section className="home-ready-strip" aria-label="Sthang Studio ready">
    <div><i><Check size={15}/></i><span><strong>Studio ready</strong><small>Caption setup is ready.</small></span></div>
    <button onClick={onDismiss} aria-label="Dismiss ready status"><X size={14}/></button>
  </section>;
  return <section className="first-run-card" aria-label="Getting started">
    <div className="first-run-heading"><div><Sparkles size={18}/><span><strong>Set up Sthang Studio in three steps</strong><small>Only the essentials for your first caption project.</small></span></div><button onClick={onDismiss} aria-label="Dismiss getting started"><X size={15}/></button></div>
    <div className="first-run-steps">
      <button className={llmConfigured ? 'done' : 'current'} onClick={onConnect}><i>{llmConfigured ? <Check size={15}/> : <KeyRound size={15}/>}</i><span><b>1. Connect AI</b><small>{llmConfigured ? 'Connected' : 'Paste your key inside the app.'}</small></span><ChevronRight size={15}/></button>
      <button className={timingConfigured ? 'done' : 'current'} onClick={onOpenDoctor}><i>{timingConfigured ? <Check size={15}/> : <TimerReset size={15}/>}</i><span><b>2. Verify Khmer timing</b><small>{timingConfigured ? 'Timing is ready' : 'Open System check for the exact setup step.'}</small></span><ChevronRight size={15}/></button>
      <div className={projectCount > 0 ? 'done' : 'current'}><i>{projectCount > 0 ? <Check size={15}/> : <UploadCloud size={15}/>}</i><span><b>3. Add a video</b><small>{projectCount > 0 ? `${projectCount} project${projectCount === 1 ? '' : 's'} available` : 'Upload below creates your first project.'}</small></span></div>
    </div>
  </section>;
}

interface GuideProps {
  open: boolean;
  project: CaptionProject | null;
  llmConfigured: boolean;
  timingConfigured: boolean;
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
  issueCount,
  onClose,
  onConnect,
  onOpenDoctor,
  onGenerate,
  onReview,
  onContext,
  onExport,
}: GuideProps) {
  if (!open) return null;
  const hasCaptions = Boolean(project?.captions.length);
  return <aside className="new-user-guide" aria-label="Sthang Studio guide">
    <header><div><HelpCircle size={18}/><span><strong>Quick guide</strong><small>What to do next—without learning every advanced control first.</small></span></div><button onClick={onClose} aria-label="Close guide"><X size={16}/></button></header>

    {!project ? <div className="guide-empty"><UploadCloud size={28}/><strong>Create a project first</strong><span>Drop a video or audio file on the home screen. Sthang Studio keeps the media local and prepares it for captions.</span></div> : <>
      <section className="guide-workflow">
        <h3>Your first caption workflow</h3>
        <button className={llmConfigured ? 'done' : 'next'} onClick={onConnect}><i>{llmConfigured ? <Check size={14}/> : 1}</i><span><b>Connect AI</b><small>{llmConfigured ? 'Connected and ready.' : 'Required to generate caption text.'}</small></span></button>
        <button className={timingConfigured ? 'done' : 'next'} onClick={onOpenDoctor}><i>{timingConfigured ? <Check size={14}/> : 2}</i><span><b>Khmer timing</b><small>{timingConfigured ? 'Timing is ready for accurate review.' : 'Open System check for setup help.'}</small></span><ChevronRight size={14}/></button>
        <button onClick={onContext}><i>3</i><span><b>Add accuracy context <em>optional</em></b><small>Protect names, brands, versions, and mixed Khmer-English terms.</small></span><ChevronRight size={14}/></button>
        <button className={!hasCaptions ? 'next' : 'done'} onClick={onGenerate} disabled={!llmConfigured || !timingConfigured}><i>{hasCaptions ? <Check size={14}/> : 4}</i><span><b>{hasCaptions ? 'Captions generated' : 'Generate accurate captions'}</b><small>Studio creates the text and syncs it to the audio.</small></span><ChevronRight size={14}/></button>
        <button className={hasCaptions && issueCount ? 'next' : hasCaptions ? 'done' : ''} onClick={onReview} disabled={!hasCaptions}><i>{hasCaptions && !issueCount ? <Check size={14}/> : 5}</i><span><b>Review risky captions</b><small>{hasCaptions ? `${issueCount} item${issueCount === 1 ? '' : 's'} currently flagged.` : 'Available after generation.'}</small></span><ChevronRight size={14}/></button>
        <button onClick={onExport} disabled={!hasCaptions}><i>6</i><span><b>Export SRT</b><small>Import the UTF-8 subtitle file into CapCut Desktop.</small></span><Download size={14}/></button>
      </section>

      <section className="guide-tools">
        <h3>What the main tools mean</h3>
        <div><ListChecks size={15}/><span><b>Review</b><small>Shows captions worth checking; it does not mean they are definitely wrong.</small></span></div>
        <div><BookOpenCheck size={15}/><span><b>Corrections</b><small>Learns from your edits after you approve the suggested memory.</small></span></div>
        <div><Sparkles size={15}/><span><b>Regeneration preview</b><small>Creates a proposal. Nothing changes until you accept it.</small></span></div>
      </section>
    </>}

    <footer><span>Advanced controls such as waveform timing, locks, QA profiles, and Deep Verify are optional. Start with the six-step flow above.</span></footer>
  </aside>;
}
