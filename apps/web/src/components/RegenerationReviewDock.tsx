import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatTimestamp } from '../timestamp';
import type {
  ProcessingJob,
  RegenerationApplyMode,
  RegenerationPreviewMode,
  RegenerationProposal,
  RegenerationRefinementInput,
} from '@kcs/shared';
import {
  Check,
  ChevronDown,
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
  ListChecks,
  ScanText,
} from 'lucide-react';
import { captionTextForEditing } from '../caption-text';
import { useMenuKeyboard } from '../use-menu-keyboard';

interface Props {
  proposal: RegenerationProposal;
  busy: boolean;
  previewMode: RegenerationPreviewMode;
  loop: boolean;
  editedText: string;
  accuracyHint: string;
  refinementJob?: ProcessingJob;
  onPreviewMode(mode: RegenerationPreviewMode): void;
  onLoop(value: boolean): void;
  onReplay(startMs?: number): void;
  onSeek(ms: number): void;
  onEditedText(value: string): void;
  onAccuracyHint(value: string): void;
  onApply(mode: RegenerationApplyMode, editedText?: string): void;
  onRefine(input: RegenerationRefinementInput): void;
}

function naturalText(captions: RegenerationProposal['proposedCaptions']) {
  return captionTextForEditing(captions);
}

function takeLabel(proposal: RegenerationProposal): string | null {
  if (proposal.strategy === 'deep-verify') return 'Checked more carefully';
  if (proposal.strategy === 'manual-realign') return 'Re-timed your wording';
  if (proposal.strategy === 'alternative') return proposal.acceptedBaselineText ? 'Built on your wording' : 'Another take';
  return null;
}

export function RegenerationReviewDock({
  proposal,
  busy,
  previewMode,
  loop,
  editedText,
  accuracyHint,
  refinementJob,
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
  const wordingEmpty = !editedText.trim();
  const wordingHelpId = useId();
  const change = proposal.changes[changeIndex] || null;
  const textChanges = proposal.changes.filter((item) => item.textChanged).length;
  const timingChanges = proposal.changes.filter((item) => item.timingChanged).length;
  const working = busy || Boolean(refinementJob && ['queued', 'running'].includes(refinementJob.status));
  const textDisabled = working || wordingEmpty || (!textChanges && !edited);
  const timingDisabled = working || !timingChanges;
  const partialDisabled = textDisabled && timingDisabled;
  const [partialOpen, setPartialOpen] = useState(false);
  const partialMenuId = useId();
  const partialRoot = useRef<HTMLDivElement>(null);
  const partialTrigger = useRef<HTMLButtonElement>(null);
  const partialMenu = useRef<HTMLDivElement>(null);
  const showPartialMenu = partialOpen && !partialDisabled;
  const keyboard = useMenuKeyboard(showPartialMenu ? partialMenuId : null, partialMenu, () => partialTrigger.current, () => setPartialOpen(false));
  const take = takeLabel(proposal);
  const locks = proposal.lockedCaptionsPreserved;
  const summary = [
    textChanges > 0 && `${textChanges} text change${textChanges === 1 ? '' : 's'}`,
    timingChanges > 0 && `${timingChanges} timing change${timingChanges === 1 ? '' : 's'}`,
    !textChanges && !timingChanges && 'Same as the current captions',
    locks > 0 && `${locks} locked caption${locks === 1 ? '' : 's'} kept`,
  ].filter(Boolean).join(' · ');
  const changeRange = change ? `${formatTimestamp(change.startMs)} – ${formatTimestamp(change.endMs)}` : '';

  useEffect(() => {
    if (!showPartialMenu) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !partialRoot.current?.contains(event.target)) setPartialOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
    };
  }, [showPartialMenu]);

  useEffect(() => { if (partialDisabled) setPartialOpen(false); }, [partialDisabled]);

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

  const selectPart = (action: () => void) => {
    partialTrigger.current?.focus({ preventScroll: true });
    setPartialOpen(false);
    action();
  };

  return <section className="regeneration-dock" aria-label="Caption comparison">
    <div className="regen-dock-head">
      <div className="regen-title-icon"><RefreshCw size={17}/></div>
      <div className="regen-title-copy">
        <div><strong>{formatTimestamp(proposal.startMs)} – {formatTimestamp(proposal.endMs)}</strong>{take && <span>{take}</span>}</div>
        <p>Play both versions against the video, then choose.</p>
      </div>
    </div>

    <div className="regen-playback-bar">
      <div className="regen-preview-switch" role="group" aria-label="Caption preview version">
        <button className={previewMode === 'current' ? 'selected' : ''} aria-pressed={previewMode === 'current'} onClick={() => onPreviewMode('current')}>Current</button>
        <button className={previewMode === 'proposed' ? 'selected' : ''} aria-pressed={previewMode === 'proposed'} onClick={() => onPreviewMode('proposed')}>Proposed</button>
      </div>
      <button onClick={() => onReplay()}><Play size={14}/>Replay</button>
      <button className={loop ? 'selected' : ''} aria-pressed={loop} onClick={() => onLoop(!loop)}><Repeat2 size={14}/>Loop</button>
      {proposal.changes.length > 1 && <div className="regen-change-nav">
        <button onClick={() => selectChange(changeIndex - 1)} disabled={changeIndex === 0} aria-label="Previous proposed change"><ChevronLeft size={14}/></button>
        <span>Change {changeIndex + 1} of {proposal.changes.length}</span>
        <button onClick={() => selectChange(changeIndex + 1)} disabled={changeIndex >= proposal.changes.length - 1} aria-label="Next proposed change"><ChevronRight size={14}/></button>
      </div>}
    </div>

    <p className="regen-summary">{summary}</p>

    {change && <button className="regen-change-focus" onClick={() => { onSeek(Math.max(0, change.startMs - 350)); onReplay(change.startMs); }} aria-label={`Play this change, ${changeRange}`}>
      <span>{changeRange}</span>
      {change.protectedByLock && <em><LockKeyhole size={11}/>Locked</em>}
      <Play size={13}/>
    </button>}

    <div className="regen-comparison">
      <article className={previewMode === 'current' ? 'previewing' : ''}>
        <div className="regen-text-label">Current text</div>
        <p>{currentText || 'No current text in this range.'}</p>
      </article>
      <article className={previewMode === 'proposed' ? 'previewing proposed' : 'proposed'}>
        <div className="regen-text-label">Proposed text</div>
        <textarea
          value={editedText}
          onChange={(event) => { onEditedText(event.target.value); onPreviewMode('proposed'); }}
          aria-label="Edit proposed caption wording"
          aria-invalid={wordingEmpty || undefined}
          aria-describedby={wordingHelpId}
          rows={Math.max(3, Math.min(7, Math.ceil(editedText.length / 58)))}
        />
        <small id={wordingHelpId} aria-live="polite"><PencilLine size={11}/>{wordingEmpty ? 'Enter wording before using the text or the whole proposal.' : 'You can edit the wording before using it.'}</small>
      </article>
    </div>

    {edited && !wordingEmpty && <div className="regen-honesty-note warning">
      <Lightbulb size={15}/><span><b>Wording edited.</b> Using it now keeps the proposal's timing. To fit the timing to your words first, open <b>Try another way</b> and choose <b>Re-time my edited words</b>.</span>
    </div>}

    <div className="regen-apply-actions">
      <button disabled={working} onClick={() => onApply('reject')}>Keep current</button>
      <div ref={partialRoot} className="regen-part" onKeyDown={keyboard.onKeyDown}>
        <button ref={partialTrigger} type="button" disabled={partialDisabled} aria-haspopup="menu"
          aria-expanded={showPartialMenu} aria-controls={showPartialMenu ? partialMenuId : undefined}
          onClick={() => setPartialOpen(!partialOpen)} onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229
              || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.getModifierState('AltGraph')) return;
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            keyboard.openAt(event.key === 'ArrowDown' ? 'first' : 'last', partialMenuId);
            setPartialOpen(true);
          }}>Use part<ChevronDown size={14} aria-hidden="true"/></button>
        {showPartialMenu && <div ref={partialMenu} id={partialMenuId} className="regen-part-menu" role="menu" aria-label="Use part of the proposal">
          <button type="button" role="menuitem" tabIndex={-1} disabled={textDisabled} onClick={() => selectPart(() => onApply('text-only', editedText))}><FileText size={14}/>Use text only</button>
          <button type="button" role="menuitem" tabIndex={-1} disabled={timingDisabled} onClick={() => selectPart(() => onApply('timing-only'))}><Clock3 size={14}/>Use timing only</button>
        </div>}
      </div>
      <button className="primary" disabled={working || wordingEmpty} onClick={() => onApply('all', edited ? editedText : undefined)}>{edited ? 'Use edited version' : 'Use proposed'}</button>
    </div>

    <details className="regen-refine-options">
      <summary>Try another way</summary>
      <div className="regen-refine-card">
      <label className="regen-hint"><span>Accuracy hint <i>optional</i></span><input value={accuracyHint} onChange={(event) => onAccuracyHint(event.target.value)} placeholder={'Example: Write “CapCut” in Latin letters, and the dish as “បាយសាច់ជ្រូក”.'}/></label>
      <div className="regen-refine-actions">
        <button disabled={working} onClick={() => refine('alternative', false)} title="Ask for a fresh suggestion"><RefreshCw size={14}/>Another take</button>
        <button className="baseline-action" disabled={working || !editedText.trim()} onClick={() => refine('alternative', true)} title="Start the next suggestion from the wording above"><Check size={14}/>Build on this wording</button>
        <button disabled={working} onClick={() => refine('deep-verify', edited)} title="Try several times and keep the strongest version"><ScanText size={14}/>Check more carefully</button>
        <button disabled={working || !editedText.trim()} onClick={() => refine('manual-realign', true)} title="Keep your exact words and fit their timing to the audio"><PencilLine size={14}/>Re-time my edited words</button>
      </div>
      <div className="regen-baseline-help"><Check size={13}/><span>You can compare the next version before using it.</span></div>
      </div>
    </details>

    {refinementJob && ['queued', 'running'].includes(refinementJob.status) && <div className="regen-job-progress">
      <LoaderCircle className="spin" size={15}/><div><strong>{refinementJob.message}</strong><span>{refinementJob.progress}% · You can keep comparing while the next version is prepared.</span><i><b style={{ width: `${refinementJob.progress}%` }}/></i></div>
    </div>}

    {proposal.candidates && proposal.candidates.length > 1 && <details className="regen-candidates">
      <summary><ListChecks size={14}/>How Studio chose this version</summary>
      <div>{proposal.candidates.map((candidate) => <article key={candidate.id} className={candidate.selected ? 'selected' : ''}>
        <div><strong>{candidate.label}</strong>{candidate.selected && <span>Selected</span>}</div>
        <p>{candidate.text}</p>
        <small>Timing match {Math.round(candidate.meanAlignmentScore * 100)}% · {candidate.lowConfidenceTokens}/{candidate.totalTokens} words flagged</small>
      </article>)}</div>
      {proposal.selectedCandidateReason && <p className="regen-candidate-note">{proposal.selectedCandidateReason}</p>}
    </details>}

  </section>;
}
