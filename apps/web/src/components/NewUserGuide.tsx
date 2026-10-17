import type { CaptionProject } from '@kcs/shared';
import {
  BookOpenCheck,
  Check,
  ChevronRight,
  Download,
  HelpCircle,
  KeyRound,
  ListChecks,
  ListRestart,
  AudioLines,
  FileUp,
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
    <div><i><Check size={15}/></i><span><strong>Studio ready</strong></span></div>
    <button onClick={onDismiss} aria-label="Dismiss ready status"><X size={14}/></button>
  </section>;
  return <section className="first-run-card" aria-label="Getting started">
    <div className="first-run-heading"><div><ListChecks size={18}/><span><strong>Set up Studio in three steps</strong></span></div><button onClick={onDismiss} aria-label="Dismiss getting started"><X size={15}/></button></div>
    <div className="first-run-steps">
      <button className={llmConfigured ? 'done' : 'current'} onClick={onConnect}><i>{llmConfigured ? <Check size={15}/> : <KeyRound size={15}/>}</i><span><b>1. Connect AI</b><small>{llmConfigured ? 'Connected' : 'Add your key in Settings.'}</small></span><ChevronRight size={15}/></button>
      <button className={timingConfigured ? 'done' : 'current'} onClick={onOpenDoctor}><i>{timingConfigured ? <Check size={15}/> : <AudioLines size={15}/>}</i><span><b>2. Verify Khmer timing</b><small>{timingConfigured ? 'Timing ready' : 'See System check for setup.'}</small></span><ChevronRight size={15}/></button>
      <div className={projectCount > 0 ? 'done' : 'current'}><i>{projectCount > 0 ? <Check size={15}/> : <FileUp size={15}/>}</i><span><b>3. Add a video</b><small>{projectCount > 0 ? `${projectCount} project${projectCount === 1 ? '' : 's'} available` : 'Upload below to begin.'}</small></span></div>
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
    <header><div><HelpCircle size={18}/><span><strong>Quick guide</strong></span></div><button onClick={onClose} aria-label="Close guide"><X size={16}/></button></header>

    {!project ? <div className="guide-empty"><FileUp size={28}/><strong>Create a project first</strong><span>Upload a video or audio file from Home to begin.</span></div> : <>
      <section className="guide-workflow">
        <h3>Caption workflow</h3>
        <button className={llmConfigured ? 'done' : 'next'} onClick={onConnect}><i>{llmConfigured ? <Check size={14}/> : 1}</i><span><b>Connect AI</b><small>{llmConfigured ? 'Connected' : 'Required to generate caption text.'}</small></span></button>
        <button className={timingConfigured ? 'done' : 'next'} onClick={onOpenDoctor}><i>{timingConfigured ? <Check size={14}/> : 2}</i><span><b>Khmer timing</b><small>{timingConfigured ? 'Timing ready' : 'Open System check for setup.'}</small></span><ChevronRight size={14}/></button>
        <button onClick={onContext}><i>3</i><span><b>Add accuracy context <em>optional</em></b><small>Preserve names, brands, versions, and Khmer-English terms.</small></span><ChevronRight size={14}/></button>
        <button className={!hasCaptions ? 'next' : 'done'} onClick={onGenerate} disabled={!llmConfigured || !timingConfigured}><i>{hasCaptions ? <Check size={14}/> : 4}</i><span><b>{hasCaptions ? 'Captions generated' : 'Generate captions'}</b><small>Creates text and timing from the audio.</small></span><ChevronRight size={14}/></button>
        <button className={hasCaptions && issueCount ? 'next' : hasCaptions ? 'done' : ''} onClick={onReview} disabled={!hasCaptions}><i>{hasCaptions && !issueCount ? <Check size={14}/> : 5}</i><span><b>Review flagged captions</b><small>{hasCaptions ? `${issueCount} to check.` : 'Available after generation.'}</small></span><ChevronRight size={14}/></button>
        <button onClick={onExport} disabled={!hasCaptions}><i>6</i><span><b>Export</b><small>SRT for CapCut Desktop or a captioned video.</small></span><Download size={14}/></button>
      </section>

      <section className="guide-tools">
        <h3>Other tools</h3>
        <div><ListChecks size={15}/><span><b>Review</b><small>Flags captions to check; they may be correct.</small></span></div>
        <div><BookOpenCheck size={15}/><span><b>Corrections</b><small>Learns from edits after you approve each suggestion.</small></span></div>
        <div><ListRestart size={15}/><span><b>Regeneration preview</b><small>Creates a proposal. Nothing changes until you accept it.</small></span></div>
      </section>
    </>}

  </aside>;
}
