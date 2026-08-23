import { useEffect, useMemo, useState } from 'react';
import type {
  ProcessingJob,
  RegenerationApplyMode,
  RegenerationPreviewMode,
  RegenerationProposal,
  RegenerationRefinementInput,
} from '@kcs/shared';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  Lightbulb,
  LoaderCircle,
  LockKeyhole,
  PencilLine,
  Play,
  RefreshCw,
  Repeat2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { captionTextForEditing } from '../caption-text';

interface Props {
  proposal: RegenerationProposal;
  busy: boolean;
  previewMode: RegenerationPreviewMode;
  loop: boolean;
  editedText: string;
  accuracyHint: string;
  refinementJob?: ProcessingJob;
  onClose(): void;
  onPreviewMode(mode: RegenerationPreviewMode): void;
  onLoop(value: boolean): void;
  onReplay(startMs?: number): void;
  onSeek(ms: number): void;
  onEditedText(value: string): void;
  onAccuracyHint(value: string): void;
  onApply(mode: RegenerationApplyMode, editedText?: string): void;
  onRefine(input: RegenerationRefinementInput): void;
}

function fmt(ms: number) {
  const seconds = Math.max(0, ms) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
}

function naturalText(captions: RegenerationProposal['proposedCaptions']) {
  return captionTextForEditing(captions);
}

function strategyLabel(proposal: RegenerationProposal) {
  if (proposal.strategy === 'deep-verify') return 'Deep verification';
  if (proposal.strategy === 'manual-realign') return 'Exact wording realignment';
  if (proposal.strategy === 'alternative') return proposal.acceptedBaselineText ? 'Baseline refinement' : 'Alternative take';
  return 'Initial proposal';
}

export function RegenerationReviewDock({
  proposal,
  busy,
  previewMode,
  loop,
  editedText,
  accuracyHint,
  refinementJob,
  onClose,
  onPreviewMode,
  onLoop,
  onReplay,
  onSeek,
  onEditedText,
  onAccuracyHint,
  onApply,
  onRefine,
}: Props) {
  const [changeIndex, setChangeIndex] = useState(0);
  const proposedOriginal = useMemo(() => naturalText(proposal.proposedCaptions), [proposal]);
  const currentText = useMemo(() => naturalText(proposal.currentCaptions), [proposal]);
  const edited = editedText.trim() !== proposedOriginal.trim();
  const change = proposal.changes[changeIndex] || null;
  const textChanges = proposal.changes.filter((item) => item.textChanged).length;
  const timingChanges = proposal.changes.filter((item) => item.timingChanged).length;
  const working = busy || Boolean(refinementJob && ['queued', 'running'].includes(refinementJob.status));

  useEffect(() => {
    setChangeIndex(0);
  }, [proposal.id]);

  const selectChange = (next: number) => {
    if (!proposal.changes.length) return;
    const index = Math.max(0, Math.min(proposal.changes.length - 1, next));
    setChangeIndex(index);
    const selected = proposal.changes[index];
    onSeek(Math.max(0, selected.startMs - 350));
  };

  const refine = (strategy: RegenerationRefinementInput['strategy'], useProposalAsBaseline: boolean) => {
    onRefine({
      strategy,
      accuracyHint: accuracyHint.trim() || undefined,
      editedText: editedText.trim() || undefined,
      useProposalAsBaseline,
    });
  };

  return <section className="regeneration-dock" aria-label="Live regeneration review">
    <div className="regen-dock-head">
      <div className="regen-title-icon"><RefreshCw size={17}/></div>
      <div className="regen-title-copy">
        <div><strong>Live regeneration review</strong><span>Pass {proposal.passNumber}</span><em>{strategyLabel(proposal)}</em></div>
        <p>{fmt(proposal.startMs)}–{fmt(proposal.endMs)} · Nothing has been applied. Keep the video visible while you compare.</p>
      </div>
      <button className="regen-close" onClick={onClose} aria-label="Close regeneration review" title="Close review"><X size={17}/></button>
    </div>

    <div className="regen-beginner-guide">
      <Play size={15}/><span><b>Start here:</b> replay the range, switch <b>Current / Proposed</b>, listen, then accept only what you trust.</span>
    </div>

    <div className="regen-playback-bar">
      <div className="regen-preview-switch" role="group" aria-label="Caption preview version">
        <button className={previewMode === 'current' ? 'selected' : ''} onClick={() => onPreviewMode('current')}>Current</button>
        <button className={previewMode === 'proposed' ? 'selected' : ''} onClick={() => onPreviewMode('proposed')}>Proposed</button>
      </div>
      <button onClick={() => onReplay()}><Play size={14}/>Replay range</button>
      <button className={loop ? 'selected' : ''} onClick={() => onLoop(!loop)}><Repeat2 size={14}/>{loop ? 'Looping' : 'Loop'}</button>
      {proposal.changes.length > 0 && <div className="regen-change-nav">
        <button onClick={() => selectChange(changeIndex - 1)} disabled={changeIndex === 0} aria-label="Previous proposed change"><ChevronLeft size={14}/></button>
        <span>Change {changeIndex + 1} of {proposal.changes.length}</span>
        <button onClick={() => selectChange(changeIndex + 1)} disabled={changeIndex >= proposal.changes.length - 1} aria-label="Next proposed change"><ChevronRight size={14}/></button>
      </div>}
    </div>

    <div className="regen-summary">
      <span><b>{proposal.unchangedCount}</b> unchanged</span>
      <span><b>{textChanges}</b> text</span>
      <span><b>{timingChanges}</b> timing</span>
      <span><b>{proposal.lockedCaptionsPreserved}</b> locks preserved</span>
      {proposal.acceptedBaselineText && <span className="baseline-chip"><Check size={11}/>Built on accepted wording</span>}
    </div>

    {change && <button className="regen-change-focus" onClick={() => { onSeek(Math.max(0, change.startMs - 350)); onReplay(change.startMs); }} title="Play this changed caption">
      <span>{fmt(change.startMs)}–{fmt(change.endMs)}</span>
      <b>{change.confidence} confidence</b>
      {change.protectedByLock && <em><LockKeyhole size={11}/>protected</em>}
      <Play size={13}/>
    </button>}

    <div className="regen-comparison">
      <article className={previewMode === 'current' ? 'previewing' : ''}>
        <header><span>Current caption</span><button onClick={() => onPreviewMode('current')}>Preview</button></header>
        <p>{currentText || 'No current text in this range.'}</p>
      </article>
      <article className={previewMode === 'proposed' ? 'previewing proposed' : 'proposed'}>
        <header><span>Proposed caption</span><button onClick={() => onPreviewMode('proposed')}>Preview</button></header>
        <textarea
          value={editedText}
          onChange={(event) => { onEditedText(event.target.value); onPreviewMode('proposed'); }}
          aria-label="Edit proposed caption wording"
          rows={Math.max(3, Math.min(7, Math.ceil(editedText.length / 58)))}
        />
        <small><PencilLine size={11}/>You can correct the proposed wording here before accepting or realigning it.</small>
      </article>
    </div>

    {edited && <div className="regen-honesty-note warning">
      <Lightbulb size={15}/><span><b>Manual edit detected.</b> Accepting it directly keeps the proposed caption-block timing. For exact word-level timing, use <b>Realign exact wording</b> first.</span>
    </div>}

    <div className="regen-refine-card">
      <div className="regen-refine-copy">
        <strong>Still not right?</strong>
        <span>Add a hint, try another take, build on wording you trust, or keep your exact wording and refresh the timing.</span>
      </div>
      <label className="regen-hint"><span>Accuracy hint <i>optional</i></span><input value={accuracyHint} onChange={(event) => onAccuracyHint(event.target.value)} placeholder={'Example: The exact model name is “GPT 5.6 Luna”. Preserve Terra in Latin script.'}/></label>
      <div className="regen-refine-actions">
        <button disabled={working} onClick={() => refine('alternative', false)} title="Try another suggestion"><RefreshCw size={14}/>Try another take</button>
        <button className="baseline-action" disabled={working || !editedText.trim()} onClick={() => refine('alternative', true)} title="Build the next suggestion from this wording"><Check size={14}/>Use as baseline & refine</button>
        <button disabled={working} onClick={() => refine('deep-verify', edited)} title="Compare extra attempts and keep the strongest suggestion"><ShieldCheck size={14}/>Deep verify</button>
        <button disabled={working || !editedText.trim()} onClick={() => refine('manual-realign', true)} title="Keep your exact wording and refresh its timing"><PencilLine size={14}/>Realign exact wording</button>
      </div>
      <div className="regen-baseline-help"><Check size={13}/><span><b>Safe to experiment:</b> baseline refinement is temporary. Only the Accept buttons at the bottom change your saved captions.</span></div>
      <div className="regen-accuracy-truth"><Lightbulb size={13}/><span>Extra AI attempts can help with ambiguous wording, but names may still need a manual check. Exact wording with refreshed timing is the most predictable fallback.</span></div>
    </div>

    {refinementJob && ['queued', 'running'].includes(refinementJob.status) && <div className="regen-job-progress">
      <LoaderCircle className="spin" size={15}/><div><strong>{refinementJob.message}</strong><span>{refinementJob.progress}% · You can keep reviewing the current proposal while the next pass runs.</span><i><b style={{ width: `${refinementJob.progress}%` }}/></i></div>
    </div>}

    {proposal.candidates && proposal.candidates.length > 1 && <details className="regen-candidates">
      <summary><Sparkles size={14}/>How Deep Verify chose this proposal</summary>
      <div>{proposal.candidates.map((candidate) => <article key={candidate.id} className={candidate.selected ? 'selected' : ''}>
        <div><strong>{candidate.label}</strong>{candidate.selected && <span>Selected</span>}</div>
        <p>{candidate.text}</p>
        <small>Timing match {Math.round(candidate.meanAlignmentScore * 100)}% · {candidate.lowConfidenceTokens}/{candidate.totalTokens} words need care</small>
      </article>)}</div>
      {proposal.selectedCandidateReason && <p className="regen-candidate-note">{proposal.selectedCandidateReason}</p>}
    </details>}

    <div className="regen-apply-actions">
      <button disabled={working} onClick={() => onApply('reject')}><X size={14}/>Keep current</button>
      <button disabled={working || (!textChanges && !edited)} onClick={() => onApply('text-only', editedText)}><FileText size={14}/>Accept text only</button>
      <button disabled={working || !timingChanges} onClick={() => onApply('timing-only')}><Clock3 size={14}/>Accept timing only</button>
      <button className="primary" disabled={working} onClick={() => onApply('all', edited ? editedText : undefined)}><Check size={14}/>{edited ? 'Accept edited proposal' : 'Accept proposed range'}</button>
    </div>
  </section>;
}
