import { useI18n } from '../i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  compileHighlightPlan, createUntimedCaptionWordTiming, editCaptionWord, hasWordTimingEvidence, highlightAttention,
  preserveManualCaptionWords, repairSmallWordTimingBoundaries, resolveCaptionWordTiming, validateMarkedWordTiming,
  type CaptionEdgeRepair, type CaptionSegment, type CaptionWordTiming,
} from '@kcs/shared';
import { LoaderCircle, Play, RefreshCw } from 'lucide-react';
import { TimestampInput } from './TimestampInput';
import { sameTimingRevision } from '../timing-edit';
import { timingTransactionMatches } from '../caption-timing-transaction';
import { formatTimestamp } from '../timestamp';
import { changeWordTiming, MIN_WORD_MS, wordTimingLimits } from '../word-timing-edit';
import type { TimingPlaybackRange } from '../timing-playback';

export interface WordTimingCandidate {
  basis: CaptionSegment;
  wordTiming: CaptionWordTiming;
  warnings?: string[];
  sourceRevision?: string;
  edgeRepair?: CaptionEdgeRepair;
}

export type WordTimingSyncResult = WordTimingCandidate | { published: true; message: string };

interface Props {
  caption: CaptionSegment;
  captionContext: CaptionSegment[];
  selectedWordId: string | null;
  playheadMs: number;
  stepMs: number;
  disabled: boolean;
  syncDisabled: boolean;
  loop: boolean;
  onSelectWord(id: string): void;
  onChange(before: CaptionSegment, after: CaptionSegment): boolean;
  onApplyEdgeRepair(repair: CaptionEdgeRepair): boolean;
  onSync(caption: CaptionSegment, signal?: AbortSignal): Promise<WordTimingSyncResult | null>;
  onNextWordTimingIssue?(): void;
  onCandidatePreview(basis: CaptionSegment, preview: CaptionSegment | null, repair?: CaptionEdgeRepair): void;
  onPreview(range: TimingPlaybackRange): void;
  onStopPreview(): void;
  onOpenAppearance?(): void;
  onWordControlReady?(target: HTMLElement): void;
  onEditText(): void;
}

export function WordTimingPanel({ caption, captionContext, selectedWordId, playheadMs, stepMs, disabled, syncDisabled, loop,
  onSelectWord, onChange, onApplyEdgeRepair, onSync, onNextWordTimingIssue, onCandidatePreview, onPreview, onStopPreview, onOpenAppearance, onWordControlReady, onEditText }: Props) {
  const { t, tn } = useI18n();
  const [candidate, setCandidate] = useState<WordTimingCandidate | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const syncButton = useRef<HTMLButtonElement>(null);
  const selectedWordButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const target = syncButton.current && !syncButton.current.disabled ? syncButton.current : panel.current;
    if (target) onWordControlReady?.(target);
  }, [onWordControlReady]);
  const actionFocus = useRef<{ from: Element; target: 'sync' | 'word' } | null>(null);
  const currentCaption = useRef(caption);
  currentCaption.current = caption;
  const currentContext = useRef(captionContext);
  currentContext.current = captionContext;
  const previewCallback = useRef(onCandidatePreview);
  previewCallback.current = onCandidatePreview;
  const validCandidate = candidate && sameTimingRevision(caption, candidate.basis)
    && (!candidate.edgeRepair || timingTransactionMatches(captionContext, candidate.edgeRepair)) ? candidate : null;
  const repair = validCandidate?.edgeRepair;
  const preview = repair?.after.find((cue) => cue.id === caption.id)
    ?? (validCandidate ? { ...caption, wordTiming: validCandidate.wordTiming } : caption);
  const marked = hasWordTimingEvidence(preview.wordTiming);
  const markedTiming = marked ? validateMarkedWordTiming(preview.text, preview.wordTiming) : null;
  const words = markedTiming
    ? markedTiming.ok ? markedTiming.timing.words : []
    : resolveCaptionWordTiming(preview).words;
  const attention = highlightAttention(preview);
  const markedProblems = marked
    ? new Set(compileHighlightPlan(preview, 'measured-and-manual').issues.flatMap(({ offsets }) => offsets ? [offsets[0]] : []))
    : null;
  const wordsNeedingReview = words.map((word, index) => markedProblems ? markedProblems.has(word.startOffset) : (
    word.needsReview || word.source === 'estimated' || word.startMs == null || word.endMs == null
    || word.startMs < Math.max(preview.startMs, words[index - 1]?.endMs ?? preview.startMs)
    || word.endMs > preview.endMs
  ));
  const selected = words.find((word) => word.id === selectedWordId) || words[wordsNeedingReview.findIndex(Boolean)] || words[0];
  const index = selected ? words.indexOf(selected) : -1;
  const limits = wordTimingLimits(preview, selected?.id || '');
  const [draftStart, setDraftStart] = useState(caption.startMs);
  const [draftEnd, setDraftEnd] = useState(caption.endMs);
  const assigned = selected?.startMs != null && selected?.endMs != null;
  const hasRoom = limits.max - limits.min >= MIN_WORD_MS;
  const locked = disabled || Boolean(caption.timingLocked) || Boolean(candidate);
  const wordEditingDisabled = locked || !hasRoom;
  const wordLabel = selected ? preview.text.slice(selected.startOffset, selected.endOffset) : '';
  const previousWord = index > 0 ? words[index - 1] : undefined;
  const nextWord = index >= 0 && index + 1 < words.length ? words[index + 1] : undefined;
  const rawAvailableMin = Math.max(preview.startMs, previousWord?.endMs ?? preview.startMs);
  const rawAvailableMax = Math.min(preview.endMs, nextWord?.startMs ?? preview.endMs);
  const assignedStartOutside = Boolean(assigned && selected && selected.startMs! < rawAvailableMin);
  const assignedEndOutside = Boolean(assigned && selected && selected.endMs! > rawAvailableMax);
  const assignedOutsideAvailableRange = assignedStartOutside || assignedEndOutside;
  const maxStart = assigned ? limits.maxStart : draftEnd - MIN_WORD_MS;
  const minEnd = assigned ? limits.minEnd : draftStart + MIN_WORD_MS;

  const retainActionFocus = (target: 'sync' | 'word') => {
    const from = document.activeElement;
    if (from && panel.current?.contains(from)) actionFocus.current = { from, target };
  };
  useLayoutEffect(() => {
    const pending = actionFocus.current;
    actionFocus.current = null;
    if (!pending || document.querySelector('[aria-modal="true"]')) return;
    const active = document.activeElement;
    if (active && active !== pending.from && active !== document.body) return;
    const preferred = pending.target === 'word' ? selectedWordButton.current : syncButton.current;
    const target = preferred && !preferred.disabled ? preferred : panel.current;
    if (!target?.isConnected || !target.getClientRects().length || target.closest('[hidden],[inert],[aria-hidden="true"]')) return;
    // Only an explicit action requests this handoff. A later sync response never
    // moves focus, and a newer focused control always keeps ownership.
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: 'instant', block: target === panel.current ? 'start' : 'nearest', inline: 'nearest' });
  });

  useEffect(() => {
    if (selected && selectedWordId !== selected.id) onSelectWord(selected.id);
  }, [selected?.id, selectedWordId]);
  useEffect(() => {
    setDraftStart(selected?.startMs ?? limits.min);
    setDraftEnd(selected?.endMs ?? limits.max);
  }, [caption.id, selected?.id, selected?.startMs, selected?.endMs, limits.min, limits.max]);
  useEffect(() => {
    if (candidate && !validCandidate) {
      setCandidate(null);
      previewCallback.current(candidate.basis, null);
      setMessage(t('timing.words.candidateChanged'));
    }
  }, [candidate, validCandidate]);
  useEffect(() => () => {
    request.current?.abort();
    previewCallback.current(currentCaption.current, null);
  }, []);

  const sync = async () => {
    retainActionFocus('sync');
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const basis = caption;
    setCandidate(null);
    onCandidatePreview(basis, null);
    onStopPreview();
    setMessage('');
    setSyncing(true);
    try {
      const result = await onSync(basis, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      if (!result) { setMessage(t('timing.words.syncNotApplied')); return; }
      if ('published' in result) { setMessage(result.message); return; }
      if (!sameTimingRevision(currentCaption.current, result.basis)) {
        setMessage(t('timing.words.syncChanged')); return;
      }
      if (result.edgeRepair) {
        const target = result.edgeRepair.after.find((cue) => cue.id === basis.id);
        if (!target || !timingTransactionMatches(currentContext.current, result.edgeRepair)) {
          setMessage(t('timing.words.syncContextChanged')); return;
        }
        setCandidate(result);
        onCandidatePreview(result.basis, target, result.edgeRepair);
        return;
      }
      const wordTiming = preserveManualCaptionWords(result.basis, result.wordTiming);
      if (!wordTiming) { setMessage(t('timing.words.syncManualConflict')); return; }
      const proposed = { ...result.basis, wordTiming };
      const repaired = repairSmallWordTimingBoundaries(proposed);
      const after = repaired ? { ...proposed, wordTiming: repaired } : proposed;
      const resolved = resolveCaptionWordTiming(after);
      if (resolved.state === 'stale' || resolved.state === 'missing') throw new Error(t('timing.words.syncMismatch'));
      if (resolved.state === 'ready') {
        if (sameTimingRevision(result.basis, after)) setMessage(t('timing.words.syncReady'));
        else if (onChange(result.basis, after)) setMessage(t('timing.words.syncApplied'));
        else setMessage(t('timing.words.syncAgain'));
        return;
      }
      setCandidate({ ...result, wordTiming });
      onCandidatePreview(result.basis, after);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : t('timing.words.syncFailed'));
    } finally {
      if (request.current === controller) { request.current = null; setSyncing(false); }
    }
  };
  const cancelSync = () => { retainActionFocus('sync'); request.current?.abort(); request.current = null; setSyncing(false); setMessage(t('timing.words.syncCanceled')); };
  const dismissCandidate = () => { retainActionFocus('sync'); if (candidate) onCandidatePreview(candidate.basis, null); setCandidate(null); onStopPreview(); };
  const applyRepair = () => {
    if (!repair) return;
    if (onApplyEdgeRepair(repair)) setMessage(t('timing.words.repairApplied'));
    dismissCandidate();
  };
  const playRepair = () => {
    if (!repair) return;
    onPreview({
      startMs: Math.max(0, Math.min(...repair.after.map((cue) => cue.startMs)) - 120),
      endMs: Math.max(...repair.after.map((cue) => cue.endMs)) + 120,
      loop,
    });
  };
  const useCandidate = () => {
    if (!candidate) return;
    if (onChange(candidate.basis, { ...candidate.basis, wordTiming: candidate.wordTiming })) {
      setMessage(t('timing.words.candidateApplied'));
      dismissCandidate();
    } else { setMessage(t('timing.words.candidateNotApplied')); dismissCandidate(); }
  };
  const change = (edge: 'start' | 'end', value: number) => {
    if (!selected || wordEditingDisabled) return false;
    if (!assigned) {
      if (edge === 'start') setDraftStart(value); else setDraftEnd(value);
      return true;
    }
    const after = changeWordTiming(caption, selected.id, edge, value);
    return after !== caption && onChange(caption, after);
  };
  const nudge = (edge: 'start' | 'end' | 'move', delta: number) => {
    if (!selected || !assigned || wordEditingDisabled) return;
    const value = edge === 'move' ? delta : (edge === 'start' ? selected.startMs! : selected.endMs!) + delta;
    const after = changeWordTiming(caption, selected.id, edge, value);
    if (after !== caption) onChange(caption, after);
    else setMessage(t('timing.words.boundaryReached'));
  };
  const confirmWord = () => {
    if (!selected || wordEditingDisabled) return;
    if (assignedOutsideAvailableRange) {
      if (assignedEndOutside && !assignedStartOutside) {
        setMessage(t('timing.words.confirmEnd', { end: formatTimestamp(limits.max) }));
      } else if (assignedStartOutside && !assignedEndOutside) {
        setMessage(t('timing.words.confirmStart', { start: formatTimestamp(limits.min) }));
      } else {
        setMessage(t('timing.words.confirmRange', { start: formatTimestamp(limits.min), end: formatTimestamp(limits.max) }));
      }
      return;
    }
    const after = editCaptionWord(caption, selected.id, { startMs: assigned ? selected.startMs! : draftStart, endMs: assigned ? selected.endMs! : draftEnd });
    if (after !== caption && onChange(caption, after)) { retainActionFocus('word'); setMessage(t('timing.words.wordConfirmed')); }
    else setMessage(t('timing.words.invalidInterval'));
  };
  const hearWord = () => {
    if (selected?.startMs == null || selected.endMs == null) return;
    onPreview({ startMs: Math.max(0, selected.startMs - 120), endMs: selected.endMs + 120, loop });
  };

  return <div ref={panel} className="word-timing-panel" role="group" aria-label={t('timing.words.controls')} tabIndex={-1}>
    <div className="word-timing-head">
      <div><strong>{validCandidate && !repair ? t('timing.words.proposed') : t('timing.words.inCaption')}</strong>
        {onOpenAppearance && attention === 'needs-attention' && <p className="timing-hint">{marked ? t('timing.normalWordColor') : t('timing.words.highlightUnavailable')}</p>}</div>
      <button ref={syncButton} title={t('timing.words.syncTooltip')} disabled={syncDisabled || syncing || caption.timingLocked || disabled} onClick={() => void sync()}>
        {syncing ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>} {syncing ? t('timing.words.syncing') : t('timing.words.sync')}
      </button>
      {syncing && <button onClick={cancelSync}>{t('timing.words.cancelSync')}</button>}
    </div>
    <div className="word-timing-links"><button onClick={onEditText}>{t('timing.words.editText')}</button>{onOpenAppearance && <button onClick={onOpenAppearance}>{t('timing.words.highlightSettings')}</button>}
      {onNextWordTimingIssue && <button onClick={onNextWordTimingIssue}>{t('timing.words.nextIssue')}</button>}
    </div>
    {repair ? <section className="word-timing-candidate" aria-label={t('timing.words.suggestion')}>
      <strong>{t('timing.words.suggestion')}</strong>
      <p>{t('timing.words.suggestionHelp')}</p>
      <p>{tn('timing.words.suggestionRange', repair.after.length, { start: formatTimestamp(preview.startMs), end: formatTimestamp(preview.endMs) })}</p>
      <div>
        <button onClick={playRepair}><Play size={14}/>{t('timing.words.playSuggestion')}</button>
        <button className="timing-primary" disabled={disabled || syncDisabled} onClick={applyRepair}>{t('timing.words.applyRepair')}</button>
        <button onClick={dismissCandidate}>{t('timing.words.closePreview')}</button>
      </div>
    </section> : validCandidate && <div className="word-timing-candidate" role="status">
      <strong>{t('timing.words.previewing')}</strong>
      <p>{t('timing.words.tentativeHelp')}</p>
      {validCandidate.warnings?.map((warning, warningIndex) => <p key={warningIndex}>{warning}</p>)}
      <div><button className="timing-primary" onClick={useCandidate}>{t('timing.words.useTentative')}</button><button onClick={dismissCandidate}>{t('timing.words.closePreview')}</button></div>
    </div>}
    {caption.timingLocked && <p className="timing-lock-status">{t('timing.locked')}</p>}
    {message && <p className="timing-lock-status" role="status">{message}</p>}
    {!words.length ? <div className="word-timing-empty">
      <p>{t('timing.words.empty')}</p>
      <button disabled={locked} onClick={() => { const after = createUntimedCaptionWordTiming(caption); if (after !== caption && onChange(caption, after)) retainActionFocus('word'); }}>{t('timing.words.setManually')}</button>
    </div> : <>
      <div className="word-timing-chips" role="group" aria-label={t('timing.words.selectWord')}>
        {words.map((word, wordIndex) => <button key={word.id} ref={word.id === selected?.id ? selectedWordButton : undefined} aria-label={t(marked && word.members ? 'timing.words.numberGroup' : 'timing.words.numberWord', { number: wordIndex + 1, text: preview.text.slice(word.startOffset, word.endOffset) })} aria-pressed={word.id === selected?.id}
          aria-description={wordsNeedingReview[wordIndex] ? t('timing.words.needsReview') : undefined}
          className={`${word.id === selected?.id ? 'selected' : ''} ${wordsNeedingReview[wordIndex] ? 'word-needs-review' : ''}`}
          onClick={() => { onStopPreview(); onSelectWord(word.id); setMessage(''); }}>
          {preview.text.slice(word.startOffset, word.endOffset)}{wordsNeedingReview[wordIndex] && <span aria-hidden="true"> · ?</span>}
        </button>)}
      </div>
      {selected && <div className="word-timing-selected">
        <div className="word-timing-selected-head"><strong>{t(marked && selected.members ? 'timing.words.numberGroup' : 'timing.words.numberWord', { number: index + 1, text: wordLabel })}</strong><button disabled={!assigned} onClick={hearWord}><Play size={14}/>{marked && selected.members ? t('timing.words.hearGroup') : t('timing.words.hearWord')}</button></div>
        {!hasRoom && <p className="timing-lock-status" role="status">{t('timing.words.noSpace')}</p>}
        {!assigned && hasRoom && <p className="timing-hint">{t('timing.words.unassigned')}</p>}
        {assigned && (assignedOutsideAvailableRange || selected.needsReview || selected.source === 'estimated') && <p className="timing-hint">
          {assignedEndOutside && !assignedStartOutside
            ? t('timing.words.endOutOfRange', { end: formatTimestamp(limits.max) })
            : assignedStartOutside && !assignedEndOutside
              ? t('timing.words.startOutOfRange', { start: formatTimestamp(limits.min) })
              : assignedOutsideAvailableRange
                ? t('timing.words.outOfRange', { start: formatTimestamp(limits.min), end: formatTimestamp(limits.max) })
                : t('timing.words.reviewTiming')}
        </p>}
        {assignedOutsideAvailableRange && hasRoom && <p className="timing-hint">{t('timing.words.availableRange')}</p>}
        <div className="timing-edge-grid">
          {(['start', 'end'] as const).map((edge) => <div className="timing-edge" key={edge}>
            <div className="timing-edge-value"><span>{edge === 'start' ? t('timing.start') : t('timing.end')}</span>
              <TimestampInput key={`${selected.id}:${candidate ? 'proposed' : 'current'}`} label={t(`timing.words.edge.${edge}.field`)} roundingMs={10} valueMs={assigned ? edge === 'start' ? selected.startMs! : selected.endMs! : edge === 'start' ? draftStart : draftEnd}
                minMs={edge === 'start' ? limits.min : minEnd}
                maxMs={edge === 'start' ? maxStart : limits.max}
                disabled={wordEditingDisabled} onFocus={onStopPreview} onCommit={(value) => change(edge, value)}/>
            </div>
            <div className="timing-edge-actions">
              <button disabled={wordEditingDisabled || !assigned} onClick={() => nudge(edge, -stepMs)} aria-label={t(`timing.words.edge.${edge}.earlier`)}>−{stepMs} ms</button>
              <button disabled={wordEditingDisabled || !assigned} onClick={() => nudge(edge, stepMs)} aria-label={t(`timing.words.edge.${edge}.later`)}>+{stepMs} ms</button>
              <button disabled={wordEditingDisabled || playheadMs < (edge === 'start' ? limits.min : minEnd) || playheadMs > (edge === 'end' ? limits.max : maxStart)} onClick={() => change(edge, playheadMs)} aria-label={t(`timing.words.edge.${edge}.setPlayhead`)}>{t('timing.setPlayhead')}</button>
            </div>
          </div>)}
        </div>
        <div className="timing-move-controls">
          <button disabled={wordEditingDisabled || !assigned} onClick={() => nudge('move', -stepMs)}>{t('timing.words.moveEarlier')}</button>
          <button disabled={wordEditingDisabled || !assigned} onClick={() => nudge('move', stepMs)}>{t('timing.words.moveLater')}</button>
          {(!assigned || selected.needsReview || selected.source === 'estimated') && <button className="timing-primary" disabled={wordEditingDisabled || assignedOutsideAvailableRange} onClick={confirmWord}>{assignedOutsideAvailableRange ? t('timing.words.adjustFirst') : assigned ? t('timing.words.confirm') : t('timing.words.apply')}</button>}
        </div>
        <p className="timing-hint">{t('timing.words.precisionHelp')}</p>
      </div>}
    </>}
  </div>;
}
