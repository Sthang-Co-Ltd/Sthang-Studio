import { useEffect, useRef, useState } from 'react';
import { createUntimedCaptionWordTiming, editCaptionWord, preserveManualCaptionWords, repairSmallWordTimingBoundaries, resolveCaptionWordTiming, type CaptionEdgeRepair, type CaptionSegment, type CaptionWordTiming } from '@kcs/shared';
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

interface Props {
  caption: CaptionSegment;
  captionContext: CaptionSegment[];
  selectedWordId: string | null;
  playheadMs: number;
  stepMs: number;
  disabled: boolean;
  syncDisabled: boolean;
  loop: boolean;
  highlightEnabled: boolean;
  onSelectWord(id: string): void;
  onChange(before: CaptionSegment, after: CaptionSegment): boolean;
  onApplyEdgeRepair(repair: CaptionEdgeRepair): boolean;
  onSync(caption: CaptionSegment, signal?: AbortSignal): Promise<WordTimingCandidate | null>;
  onNextWordTimingIssue?(): void;
  onCandidatePreview(basis: CaptionSegment, preview: CaptionSegment | null, repair?: CaptionEdgeRepair): void;
  onPreview(range: TimingPlaybackRange): void;
  onStopPreview(): void;
  onOpenAppearance(): void;
  onEditText(): void;
}

export function WordTimingPanel({ caption, captionContext, selectedWordId, playheadMs, stepMs, disabled, syncDisabled, loop, highlightEnabled,
  onSelectWord, onChange, onApplyEdgeRepair, onSync, onNextWordTimingIssue, onCandidatePreview, onPreview, onStopPreview, onOpenAppearance, onEditText }: Props) {
  const [candidate, setCandidate] = useState<WordTimingCandidate | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
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
  const resolution = resolveCaptionWordTiming(preview);
  const words = resolution.state === 'stale' ? [] : resolution.words;
  const wordsNeedingReview = words.map((word, index) => (
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
      setMessage('Caption timing changed. Sync again to check the current captions.');
    }
  }, [candidate, validCandidate]);
  useEffect(() => () => {
    request.current?.abort();
    previewCallback.current(currentCaption.current, null);
  }, []);

  const sync = async () => {
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
      if (!result) { setMessage('Word sync was not applied. Check the saved caption and try again.'); return; }
      if (!sameTimingRevision(currentCaption.current, result.basis)) {
        setMessage('The caption changed during word sync. Your newer edits were kept.'); return;
      }
      if (result.edgeRepair) {
        const target = result.edgeRepair.after.find((cue) => cue.id === basis.id);
        if (!target || !timingTransactionMatches(currentContext.current, result.edgeRepair)) {
          setMessage('Nearby caption timing changed. Sync again to check the current captions.'); return;
        }
        setCandidate(result);
        onCandidatePreview(result.basis, target, result.edgeRepair);
        return;
      }
      const wordTiming = preserveManualCaptionWords(result.basis, result.wordTiming);
      if (!wordTiming) { setMessage('Sync could not keep the manual word times. Adjust the words below.'); return; }
      const proposed = { ...result.basis, wordTiming };
      const repaired = repairSmallWordTimingBoundaries(proposed);
      const after = repaired ? { ...proposed, wordTiming: repaired } : proposed;
      const resolved = resolveCaptionWordTiming(after);
      if (resolved.state === 'stale' || resolved.state === 'missing') throw new Error('The returned word timing does not match this caption. Your current timing was kept.');
      if (resolved.state === 'ready') {
        if (sameTimingRevision(result.basis, after)) setMessage('Word timing is ready.');
        else if (onChange(result.basis, after)) setMessage('Word timing applied. Replay to check it.');
        else setMessage('The caption changed. Sync its words again when the edit is ready.');
        return;
      }
      setCandidate({ ...result, wordTiming });
      onCandidatePreview(result.basis, after);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Word sync failed. Current captions were kept.');
    } finally {
      if (request.current === controller) { request.current = null; setSyncing(false); }
    }
  };
  const cancelSync = () => { request.current?.abort(); request.current = null; setSyncing(false); setMessage('Word sync canceled. Current timing was kept.'); };
  const dismissCandidate = () => { if (candidate) onCandidatePreview(candidate.basis, null); setCandidate(null); onStopPreview(); };
  const applyRepair = () => {
    if (!repair) return;
    if (onApplyEdgeRepair(repair)) setMessage('Timing repair applied. Undo restores the earlier caption and word timings.');
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
      setMessage('Word timing applied. Replay the caption to check it.');
      dismissCandidate();
    } else { setMessage('The caption changed; its current timing was kept.'); dismissCandidate(); }
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
    else setMessage('This word has reached the next boundary. Other words stay in place.');
  };
  const confirmWord = () => {
    if (!selected || wordEditingDisabled) return;
    if (assignedOutsideAvailableRange) {
      if (assignedEndOutside && !assignedStartOutside) {
        setMessage(`Set End to ${formatTimestamp(limits.max)} or earlier. That manual timing edit will confirm this word.`);
      } else if (assignedStartOutside && !assignedEndOutside) {
        setMessage(`Set Start to ${formatTimestamp(limits.min)} or later. That manual timing edit will confirm this word.`);
      } else {
        setMessage(`Keep this word between ${formatTimestamp(limits.min)} and ${formatTimestamp(limits.max)}. A manual timing edit will confirm it.`);
      }
      return;
    }
    const after = editCaptionWord(caption, selected.id, { startMs: assigned ? selected.startMs! : draftStart, endMs: assigned ? selected.endMs! : draftEnd });
    if (after !== caption && onChange(caption, after)) setMessage('Word timing confirmed.');
    else setMessage('Choose a positive interval inside this caption and between the neighboring words.');
  };
  const hearWord = () => {
    if (selected?.startMs == null || selected.endMs == null) return;
    onPreview({ startMs: Math.max(0, selected.startMs - 120), endMs: selected.endMs + 120, loop });
  };

  return <div className="word-timing-panel" aria-label="Word timing controls">
    <div className="word-timing-head">
      <div><strong>{validCandidate && !repair ? 'Proposed word timing' : 'Words in this caption'}</strong>
        {resolution.state !== 'ready' && <p className="timing-hint">Word highlighting stays off until every word has usable timing.</p>}</div>
      <button title="Align the current caption text to audio without changing the wording" disabled={syncDisabled || syncing || caption.timingLocked || disabled} onClick={() => void sync()}>
        {syncing ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>} {syncing ? 'Syncing…' : 'Sync words'}
      </button>
      {syncing && <button onClick={cancelSync}>Cancel sync</button>}
    </div>
    <div className="word-timing-links"><button onClick={onEditText}>Edit caption text</button><button onClick={onOpenAppearance}>{highlightEnabled ? 'Highlight settings' : 'Enable word highlighting…'}</button>
      {onNextWordTimingIssue && <button onClick={onNextWordTimingIssue}>Next timing issue</button>}
    </div>
    {repair ? <section className="word-timing-candidate" aria-label="Suggested caption timing">
      <strong>Suggested caption timing</strong>
      <p>The words extend beyond this caption. The repair adjusts the caption edges and syncs the words together.</p>
      <p>This caption will run from {formatTimestamp(preview.startMs)} to {formatTimestamp(preview.endMs)}. Applying clears Review approval on {repair.after.length === 1 ? 'this caption' : `${repair.after.length} captions`}.</p>
      <div>
        <button onClick={playRepair}><Play size={14}/>Play suggestion</button>
        <button className="timing-primary" disabled={disabled || syncDisabled} onClick={applyRepair}>Apply timing repair</button>
        <button onClick={dismissCandidate}>Close preview</button>
      </div>
    </section> : validCandidate && <div className="word-timing-candidate" role="status">
      <strong>Previewing word timing. Saved captions are unchanged.</strong>
      <p>Some words still need checking. Use these times to edit them, or close the preview.</p>
      {validCandidate.warnings?.map((warning, warningIndex) => <p key={warningIndex}>{warning}</p>)}
      <div><button className="timing-primary" onClick={useCandidate}>Use tentative timing</button><button onClick={dismissCandidate}>Close preview</button></div>
    </div>}
    {caption.timingLocked && <p className="timing-lock-status">Timing locked. Unlock it in the caption menu to edit. You can still listen.</p>}
    {message && <p className="timing-lock-status" role="status">{message}</p>}
    {!words.length ? <div className="word-timing-empty">
      <p>No editable word timings yet.</p>
      <button disabled={locked} onClick={() => { const after = createUntimedCaptionWordTiming(caption); if (after !== caption) onChange(caption, after); }}>Set words manually</button>
    </div> : <>
      <div className="word-timing-chips" role="group" aria-label="Select a word to time">
        {words.map((word, wordIndex) => <button key={word.id} aria-label={`Word ${wordIndex + 1}: ${preview.text.slice(word.startOffset, word.endOffset)}`} aria-pressed={word.id === selected?.id}
          aria-description={wordsNeedingReview[wordIndex] ? 'Needs review' : undefined}
          className={`${word.id === selected?.id ? 'selected' : ''} ${wordsNeedingReview[wordIndex] ? 'word-needs-review' : ''}`}
          onClick={() => { onStopPreview(); onSelectWord(word.id); setMessage(''); }}>
          {preview.text.slice(word.startOffset, word.endOffset)}{wordsNeedingReview[wordIndex] && <span aria-hidden="true"> · ?</span>}
        </button>)}
      </div>
      {selected && <div className="word-timing-selected">
        <div className="word-timing-selected-head"><strong>Word {index + 1}: {wordLabel}</strong><button disabled={!assigned} onClick={hearWord}><Play size={14}/>Hear word</button></div>
        {!hasRoom && <p className="timing-lock-status" role="status">No space between word boundaries. Adjust a neighboring word or caption edge, or try Sync words.</p>}
        {!assigned && hasRoom && <p className="timing-hint">No timing assigned. Set Start and End, then Apply word timing. The available range is not measured timing.</p>}
        {assigned && (assignedOutsideAvailableRange || selected.needsReview || selected.source === 'estimated') && <p className="timing-hint">
          {assignedEndOutside && !assignedStartOutside
            ? `This word extends past the available caption timing. Set End to ${formatTimestamp(limits.max)} or earlier; that manual edit will confirm it.`
            : assignedStartOutside && !assignedEndOutside
              ? `This word starts before the available caption timing. Set Start to ${formatTimestamp(limits.min)} or later; that manual edit will confirm it.`
              : assignedOutsideAvailableRange
                ? `This word must stay between ${formatTimestamp(limits.min)} and ${formatTimestamp(limits.max)}. Adjusting it manually will confirm the word.`
                : 'This timing needs review. Listen, then adjust or confirm this word.'}
        </p>}
        {assignedOutsideAvailableRange && hasRoom && <p className="timing-hint">Move or trim this word to fit it inside the available range. Its duration may shorten; other words stay in place.</p>}
        <div className="timing-edge-grid">
          {(['start', 'end'] as const).map((edge) => <div className="timing-edge" key={edge}>
            <div className="timing-edge-value"><span>{edge === 'start' ? 'Start' : 'End'}</span>
              <TimestampInput key={`${selected.id}:${candidate ? 'proposed' : 'current'}`} label={`Word ${edge} time`} roundingMs={10} valueMs={assigned ? edge === 'start' ? selected.startMs! : selected.endMs! : edge === 'start' ? draftStart : draftEnd}
                minMs={edge === 'start' ? limits.min : minEnd}
                maxMs={edge === 'start' ? maxStart : limits.max}
                disabled={wordEditingDisabled} onFocus={onStopPreview} onCommit={(value) => change(edge, value)}/>
            </div>
            <div className="timing-edge-actions">
              <button disabled={wordEditingDisabled || !assigned} onClick={() => nudge(edge, -stepMs)} aria-label={`Move word ${edge} earlier`}>−{stepMs} ms</button>
              <button disabled={wordEditingDisabled || !assigned} onClick={() => nudge(edge, stepMs)} aria-label={`Move word ${edge} later`}>+{stepMs} ms</button>
              <button disabled={wordEditingDisabled || playheadMs < (edge === 'start' ? limits.min : minEnd) || playheadMs > (edge === 'end' ? limits.max : maxStart)} onClick={() => change(edge, playheadMs)} aria-label={`Set word ${edge} to playhead`}>Set to playhead</button>
            </div>
          </div>)}
        </div>
        <div className="timing-move-controls">
          <button disabled={wordEditingDisabled || !assigned} onClick={() => nudge('move', -stepMs)}>Move word earlier</button>
          <button disabled={wordEditingDisabled || !assigned} onClick={() => nudge('move', stepMs)}>Move word later</button>
          {(!assigned || selected.needsReview || selected.source === 'estimated') && <button className="timing-primary" disabled={wordEditingDisabled || assignedOutsideAvailableRange} onClick={confirmWord}>{assignedOutsideAvailableRange ? 'Adjust timing first' : assigned ? 'Confirm this word' : 'Apply word timing'}</button>}
        </div>
        <p className="timing-hint">Word edits use 10 ms precision. Other word times and the caption’s outer edges stay in place.</p>
      </div>}
    </>}
  </div>;
}
