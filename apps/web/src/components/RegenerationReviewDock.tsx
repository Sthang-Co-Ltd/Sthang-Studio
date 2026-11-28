import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { candidateLabelKey, selectedCandidateReasonKey } from '../server-labels';
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
import { findPreviewDiff, type FindPreviewSpan } from '../find-preview-diff';
import { useMenuKeyboard } from '../use-menu-keyboard';
import './compare-change-wording.css';

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

function WordingLine({ label, spans, proposed }: { label: string; spans: FindPreviewSpan[]; proposed?: boolean }) {
  if (!spans.length) return null;
  return <div className={proposed ? 'proposed-wording' : undefined}>
    <dt>{label}</dt>
    <dd data-server-text>{spans.map((span, index) => span.changed
      ? <mark key={index}>{span.text}</mark> : span.text)}</dd>
  </div>;
}

function takeLabel(proposal: RegenerationProposal, t: ReturnType<typeof useI18n>['t']): string | null {
  if (proposal.strategy === 'deep-verify') return t('compare.dock.deepVerify');
  if (proposal.strategy === 'manual-realign') return t('compare.dock.retimed');
  if (proposal.strategy === 'alternative') return proposal.acceptedBaselineText ? t('compare.dock.builtOnWording') : t('compare.dock.anotherTake');
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
  const { t, tn, tr } = useI18n();
  const reason = proposal.selectedCandidateReason;
  const reasonKey = reason ? selectedCandidateReasonKey(reason) : undefined;
  const [changeIndex, setChangeIndex] = useState(0);
  const proposedOriginal = useMemo(() => naturalText(proposal.proposedCaptions), [proposal]);
  const currentText = useMemo(() => naturalText(proposal.currentCaptions), [proposal]);
  const edited = editedText.trim() !== proposedOriginal.trim();
  const wordingEmpty = !editedText.trim();
  const wordingHelpId = useId();
  const change = proposal.changes[changeIndex] || null;
  const wordingDiff = useMemo(() => change?.textChanged
    ? findPreviewDiff(change.beforeText, change.afterText) : null, [change]);
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
  const take = takeLabel(proposal, t);
  const locks = proposal.lockedCaptionsPreserved;
  const summary = [
    textChanges > 0 && tn('compare.dock.textChanges', textChanges),
    timingChanges > 0 && tn('compare.dock.timingChanges', timingChanges),
    !textChanges && !timingChanges && t('compare.dock.same'),
    locks > 0 && tn('compare.dock.locksKept', locks),
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

  return <section className="regeneration-dock" aria-label={t('compare.dock.label')}>
    <div className="regen-dock-head">
      <div className="regen-title-icon"><RefreshCw size={17}/></div>
      <div className="regen-title-copy">
        <div><strong>{formatTimestamp(proposal.startMs)} – {formatTimestamp(proposal.endMs)}</strong>{take && <span>{take}</span>}</div>
        <p>{t('compare.dock.instructions')}</p>
      </div>
    </div>

    <div className="regen-playback-bar">
      <div className="regen-preview-switch" role="group" aria-label={t('compare.dock.previewLabel')}>
        <button className={previewMode === 'current' ? 'selected' : ''} aria-pressed={previewMode === 'current'} onClick={() => onPreviewMode('current')}>{t('compare.dock.current')}</button>
        <button className={previewMode === 'proposed' ? 'selected' : ''} aria-pressed={previewMode === 'proposed'} onClick={() => onPreviewMode('proposed')}>{t('compare.dock.proposed')}</button>
      </div>
      <button onClick={() => onReplay()}><Play size={14}/>{t('compare.dock.replay')}</button>
      <button className={loop ? 'selected' : ''} aria-pressed={loop} onClick={() => onLoop(!loop)}><Repeat2 size={14}/>{t('compare.dock.loop')}</button>
      {proposal.changes.length > 1 && <div className="regen-change-nav">
        <button onClick={() => selectChange(changeIndex - 1)} disabled={changeIndex === 0} aria-label={t('compare.dock.previous')}><ChevronLeft size={14}/></button>
        <span>{t('compare.dock.changePosition', { position: changeIndex + 1, total: proposal.changes.length })}</span>
        <button onClick={() => selectChange(changeIndex + 1)} disabled={changeIndex >= proposal.changes.length - 1} aria-label={t('compare.dock.next')}><ChevronRight size={14}/></button>
      </div>}
    </div>

    <p className="regen-summary">{summary}</p>

    {change && <button className="regen-change-focus" onClick={() => { onSeek(Math.max(0, change.startMs - 350)); onReplay(change.startMs); }} aria-label={t('compare.dock.playChange', { range: changeRange })}>
      <span>{changeRange}</span>
      {change.protectedByLock && <em><LockKeyhole size={11}/>{t('compare.dock.locked')}</em>}
      <Play size={13}/>
    </button>}

    {wordingDiff && <dl className="regen-change-wording">
      <WordingLine label={t(wordingDiff.after.length ? 'compare.dock.current' : 'compare.dock.removedCaption')}
        spans={wordingDiff.before}/>
      <WordingLine label={t(wordingDiff.before.length ? 'compare.dock.originalProposal' : 'compare.dock.addedCaption')}
        spans={wordingDiff.after} proposed/>
    </dl>}

    <div className="regen-comparison">
      <article className={previewMode === 'current' ? 'previewing' : ''}>
        <div className="regen-text-label">{t('compare.dock.currentText')}</div>
        <p>{currentText || t('compare.dock.noCurrentText')}</p>
      </article>
      <article className={previewMode === 'proposed' ? 'previewing proposed' : 'proposed'}>
        <div className="regen-text-label">{t('compare.dock.proposedText')}</div>
        <textarea
          data-server-text
          value={editedText}
          onChange={(event) => { onEditedText(event.target.value); onPreviewMode('proposed'); }}
          aria-label={t('compare.dock.editWording')}
          aria-invalid={wordingEmpty || undefined}
          aria-describedby={wordingHelpId}
          rows={Math.max(3, Math.min(7, Math.ceil(editedText.length / 58)))}
        />
        <small id={wordingHelpId} aria-live="polite"><PencilLine size={11}/>{wordingEmpty ? t('compare.dock.emptyWording') : t('compare.dock.editHelp')}</small>
      </article>
    </div>

    {edited && !wordingEmpty && <div className="regen-honesty-note warning">
      <Lightbulb size={15}/><span>{tr('compare.dock.editedTiming', {}, {})}</span>
    </div>}

    <div className="regen-apply-actions">
      <button disabled={working} onClick={() => onApply('reject')}>{t('compare.dock.keepCurrent')}</button>
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
          }}>{t('compare.dock.usePart')}<ChevronDown size={14} aria-hidden="true"/></button>
        {showPartialMenu && <div ref={partialMenu} id={partialMenuId} className="regen-part-menu" role="menu" aria-label={t('compare.dock.usePartLabel')}>
          <button type="button" role="menuitem" tabIndex={-1} disabled={textDisabled} onClick={() => selectPart(() => onApply('text-only', editedText))}><FileText size={14}/>{t('compare.dock.useTextOnly')}</button>
          <button type="button" role="menuitem" tabIndex={-1} disabled={timingDisabled} onClick={() => selectPart(() => onApply('timing-only'))}><Clock3 size={14}/>{t('compare.dock.useTimingOnly')}</button>
        </div>}
      </div>
      <button className="primary" disabled={working || wordingEmpty} onClick={() => onApply('all', edited ? editedText : undefined)}>{edited ? t('compare.dock.useEdited') : t('compare.dock.useProposed')}</button>
    </div>

    <details className="regen-refine-options">
      <summary>{t('compare.dock.refine')}</summary>
      <div className="regen-refine-card">
      <label className="regen-hint"><span>{tr('compare.dock.accuracyHint', {}, { b: (text) => <i>{text}</i> })}</span><input value={accuracyHint} onChange={(event) => onAccuracyHint(event.target.value)} placeholder={t('compare.dock.example')}/></label>
      <div className="regen-refine-actions">
        <button disabled={working} onClick={() => refine('alternative', false)} title={t('compare.dock.anotherTakeTip')}><RefreshCw size={14}/>{t('compare.dock.anotherTake')}</button>
        <button className="baseline-action" disabled={working || !editedText.trim()} onClick={() => refine('alternative', true)} title={t('compare.dock.buildOnTip')}><Check size={14}/>{t('compare.dock.buildOn')}</button>
        <button disabled={working} onClick={() => refine('deep-verify', edited)} title={t('compare.dock.checkCarefullyTip')}><ScanText size={14}/>{t('compare.dock.checkCarefully')}</button>
        <button disabled={working || !editedText.trim()} onClick={() => refine('manual-realign', true)} title={t('compare.dock.retimeTip')}><PencilLine size={14}/>{t('compare.dock.retime')}</button>
      </div>
      <div className="regen-baseline-help"><Check size={13}/><span>{t('compare.dock.compareNext')}</span></div>
      </div>
    </details>

    {refinementJob && ['queued', 'running'].includes(refinementJob.status) && <div className="regen-job-progress">
      <LoaderCircle className="spin" size={15}/><div><strong data-server-text>{refinementJob.message}</strong><span>{t('compare.dock.refinementProgress', { progress: refinementJob.progress })}</span><i><b style={{ width: `${refinementJob.progress}%` }}/></i></div>
    </div>}

    {proposal.candidates && proposal.candidates.length > 1 && <details className="regen-candidates">
      <summary><ListChecks size={14}/>{t('compare.dock.candidateDetails')}</summary>
      <div>{proposal.candidates.map((candidate) => {
        const labelKey = candidateLabelKey(candidate.label);
        return <article key={candidate.id} className={candidate.selected ? 'selected' : ''}>
          <div><strong data-server-text={labelKey ? undefined : true}>{labelKey ? t(labelKey) : candidate.label}</strong>{candidate.selected && <span>{t('compare.dock.selected')}</span>}</div>
          <p data-server-text>{candidate.text}</p>
          <small>{t('compare.dock.candidateTiming', { score: Math.round(candidate.meanAlignmentScore * 100), flagged: candidate.lowConfidenceTokens, total: candidate.totalTokens })}</small>
        </article>;
      })}</div>
      {reason && <p className="regen-candidate-note" data-server-text={reasonKey ? undefined : true}>{reasonKey ? t(reasonKey) : reason}</p>}
    </details>}

  </section>;
}
