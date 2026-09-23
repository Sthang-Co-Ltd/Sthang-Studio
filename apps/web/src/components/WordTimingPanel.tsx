import { useEffect, useRef, useState } from 'react';
import { createUntimedCaptionWordTiming, editCaptionWord, resolveCaptionWordTiming, type CaptionSegment, type CaptionWordTiming } from '@kcs/shared';
import { LoaderCircle, Play, RefreshCw } from 'lucide-react';
import { TimestampInput } from './TimestampInput';
import { sameTimingRevision, timingRevisionKey } from '../timing-edit';
import { formatTimestamp } from '../timestamp';
import { changeWordTiming, MIN_WORD_MS, wordTimingLimits } from '../word-timing-edit';
import type { TimingPlaybackRange } from '../timing-playback';

export interface WordTimingCandidate {
  basis: CaptionSegment;
  wordTiming: CaptionWordTiming;
  warnings?: string[];
  sourceRevision?: string;
}

interface Props {
  caption: CaptionSegment;
  selectedWordId: string | null;
  playheadMs: number;
  stepMs: number;
  disabled: boolean;
  syncDisabled: boolean;
  loop: boolean;
  highlightEnabled: boolean;
  onSelectWord(id: string): void;
  onChange(before: CaptionSegment, after: CaptionSegment): boolean;
  onSync(caption: CaptionSegment, signal?: AbortSignal): Promise<WordTimingCandidate | null>;
  onAutoSync(caption: CaptionSegment, signal?: AbortSignal): Promise<WordTimingCandidate | null | undefined>;
  onCandidatePreview(basis: CaptionSegment, preview: CaptionSegment | null): void;
  onPreview(range: TimingPlaybackRange): void;
  onStopPreview(): void;
  onOpenAppearance(): void;
  onEditText(): void;
}

export function WordTimingPanel({ caption, selectedWordId, playheadMs, stepMs, disabled, syncDisabled, loop, highlightEnabled,
  onSelectWord, onChange, onSync, onAutoSync, onCandidatePreview, onPreview, onStopPreview, onOpenAppearance, onEditText }: Props) {
  const [candidate, setCandidate] = useState<WordTimingCandidate | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
  const currentCaption = useRef(caption);
  currentCaption.current = caption;
  const previewCallback = useRef(onCandidatePreview);
  previewCallback.current = onCandidatePreview;
  const preview = candidate && sameTimingRevision(caption, candidate.basis)
    ? { ...caption, wordTiming: candidate.wordTiming } : caption;
  const resolution = resolveCaptionWordTiming(preview);
  const words = resolution.state === 'stale' ? [] : resolution.words;
  const selected = words.find((word) => word.id === selectedWordId) || words[0];
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
  const rawAvailableMin = Math.max(caption.startMs, previousWord?.endMs ?? caption.startMs);
  const rawAvailableMax = Math.min(caption.endMs, nextWord?.startMs ?? caption.endMs);
  const assignedStartOutside = Boolean(assigned && selected && selected.startMs! < rawAvailableMin);
  const assignedEndOutside = Boolean(assigned && selected && selected.endMs! > rawAvailableMax);
  const assignedOutsideAvailableRange = assignedStartOutside || assignedEndOutside;
  const automaticAttempt = useRef<string | null>(null);
  const automaticRevision = timingRevisionKey(caption);

  useEffect(() => {
    if (selected && selectedWordId !== selected.id) onSelectWord(selected.id);
  }, [selected?.id, selectedWordId]);
  useEffect(() => {
    setDraftStart(selected?.startMs ?? limits.min);
    setDraftEnd(selected?.endMs ?? limits.max);
  }, [caption.id, selected?.id, selected?.startMs, selected?.endMs, limits.min, limits.max]);
  useEffect(() => {
    if (candidate && !sameTimingRevision(caption, candidate.basis)) {
      setCandidate(null);
      previewCallback.current(candidate.basis, null);
      setMessage('The caption changed. Its newer edits were kept; sync again for the new wording.');
    }
  }, [caption, candidate]);
  useEffect(() => () => {
    request.current?.abort();
    previewCallback.current(currentCaption.current, null);
  }, []);

  const runSync = async (
    requestSync: Props['onSync'] | Props['onAutoSync'],
    automatic = false,
    automaticKey?: string,
  ) => {
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
      const result = await requestSync(basis, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      if (result === undefined && automatic) return;
      if (!result) { setMessage('Word sync was not applied. Check the saved caption and try again.'); return; }
      if (!sameTimingRevision(currentCaption.current, result.basis)) {
        setMessage('The caption changed during word sync. Your newer edits were kept.'); return;
      }
      const after = { ...result.basis, wordTiming: result.wordTiming };
      const resolved = resolveCaptionWordTiming(after);
      if (resolved.state === 'stale' || resolved.state === 'missing') throw new Error('The returned word timing does not match this caption. Your current timing was kept.');
      if (automatic && resolved.state !== 'ready') {
        setMessage('Studio could not fully sync this caption automatically. Retry Sync words or use the detailed word controls if this caption needs manual timing.');
        return;
      }
      setCandidate(result);
      onCandidatePreview(result.basis, after);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Word sync failed. Current captions were kept.');
    } finally {
      if (automatic && controller.signal.aborted && automaticKey && automaticAttempt.current === automaticKey) {
        automaticAttempt.current = null;
      }
      if (request.current === controller) { request.current = null; setSyncing(false); }
    }
  };
  const sync = () => runSync(onSync, false);
  useEffect(() => {
    if (resolution.state === 'ready') return;
    if (candidate || syncing || syncDisabled || disabled || caption.timingLocked) return;
    if (automaticAttempt.current === automaticRevision) return;
    // React StrictMode intentionally runs mount effects through a throwaway
    // setup/cleanup pass in development. Defer the automatic request one tick so
    // that pass cancels cleanly instead of consuming/aborting the one-shot sync.
    const timer = window.setTimeout(() => {
      if (automaticAttempt.current === automaticRevision) return;
      automaticAttempt.current = automaticRevision;
      void runSync(onAutoSync, true, automaticRevision);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [automaticRevision, resolution.state, candidate, syncing, syncDisabled, disabled, caption.timingLocked, onAutoSync]);
  const cancelSync = () => { request.current?.abort(); request.current = null; setSyncing(false); setMessage('Word sync canceled. Current timing was kept.'); };
  const dismissCandidate = () => { if (candidate) onCandidatePreview(candidate.basis, null); setCandidate(null); onStopPreview(); };
  const useCandidate = () => {
    if (!candidate) return;
    if (onChange(candidate.basis, { ...candidate.basis, wordTiming: candidate.wordTiming, approved: false })) {
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
      <div><strong>{candidate ? 'Proposed word timing' : 'Words in this caption'}</strong>
        <p className="timing-hint">{resolution.state === 'ready' ? 'Each word has usable timing. Adjust only the word that is off.' : 'Highlighting stays off for this caption until every word has usable timing.'}</p></div>
      <button disabled={syncDisabled || syncing || caption.timingLocked || disabled} onClick={() => void sync()}>
        {syncing ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>} {syncing ? 'Syncing…' : 'Sync words'}
      </button>
      {syncing && <button onClick={cancelSync}>Cancel sync</button>}
    </div>
    <p className="timing-hint">Sync uses this caption’s current wording and local audio. Correct the text first; the wording will not be rewritten.</p>
    <div className="word-timing-links"><button onClick={onEditText}>Edit caption text</button><button onClick={onOpenAppearance}>{highlightEnabled ? 'Highlight settings' : 'Enable word highlighting…'}</button></div>
    {candidate && <div className="word-timing-candidate" role="status">
      <strong>Previewing the proposed timing. Saved captions are unchanged.</strong>
      <p>Select words to listen and inspect. Choose Use timing or Keep current before editing.</p>
      {candidate.warnings?.map((warning, warningIndex) => <p key={warningIndex}>{warning}</p>)}
      <div><button className="timing-primary" onClick={useCandidate}>Use timing</button><button onClick={dismissCandidate}>Keep current</button></div>
    </div>}
    {caption.timingLocked && <p className="timing-lock-status">Timing is locked. Unlock it in the caption menu to make changes; playback remains available.</p>}
    {message && <p className="timing-lock-status" role="status">{message}</p>}
    {!words.length ? <div className="word-timing-empty">
      <p>No editable word timings are available for this wording yet.</p>
      <button disabled={locked} onClick={() => { const after = createUntimedCaptionWordTiming(caption); if (after !== caption) onChange(caption, { ...after, approved: false }); }}>Set words manually</button>
    </div> : <>
      <div className="word-timing-chips" role="group" aria-label="Select a word to time">
        {words.map((word, wordIndex) => <button key={word.id} aria-label={`Word ${wordIndex + 1}: ${preview.text.slice(word.startOffset, word.endOffset)}`} aria-pressed={word.id === selected?.id}
          aria-description={word.needsReview || word.source === 'estimated' || word.startMs == null ? 'Needs review' : undefined}
          className={`${word.id === selected?.id ? 'selected' : ''} ${word.needsReview || word.source === 'estimated' || word.startMs == null ? 'word-needs-review' : ''}`}
          onClick={() => { onStopPreview(); onSelectWord(word.id); setMessage(''); }}>
          {preview.text.slice(word.startOffset, word.endOffset)}{(word.needsReview || word.source === 'estimated' || word.startMs == null) && <span aria-hidden="true"> · ?</span>}
        </button>)}
      </div>
      {selected && <div className="word-timing-selected">
        <div className="word-timing-selected-head"><strong>Word {index + 1}: {wordLabel}</strong><button disabled={!assigned} onClick={hearWord}><Play size={14}/>Hear word</button></div>
        {!hasRoom && <p className="timing-lock-status" role="status">No room for this word between the current boundaries. Adjust a neighboring word or the caption edges to make space, or use Sync words to review a new timing proposal.</p>}
        {!assigned && hasRoom && <p className="timing-hint">This word has no assigned times. Set its start and end, then choose Apply word timing. The suggested available interval is not an alignment.</p>}
        {assigned && (selected.needsReview || selected.source === 'estimated') && <p className="timing-hint">
          {assignedEndOutside && !assignedStartOutside
            ? `This word extends past the available caption timing. Set End to ${formatTimestamp(limits.max)} or earlier; that manual edit will confirm it.`
            : assignedStartOutside && !assignedEndOutside
              ? `This word starts before the available caption timing. Set Start to ${formatTimestamp(limits.min)} or later; that manual edit will confirm it.`
              : assignedOutsideAvailableRange
                ? `This word must stay between ${formatTimestamp(limits.min)} and ${formatTimestamp(limits.max)}. Adjusting it manually will confirm the word.`
                : 'These times need a listen after the wording or timing changed. Adjust them, or confirm this word after checking.'}
        </p>}
        <div className="timing-edge-grid">
          {(['start', 'end'] as const).map((edge) => <div className="timing-edge" key={edge}>
            <div className="timing-edge-value"><span>{edge === 'start' ? 'Start' : 'End'}</span>
              <TimestampInput key={`${selected.id}:${candidate ? 'proposed' : 'current'}`} label={`Word ${edge} time`} roundingMs={10} valueMs={assigned ? edge === 'start' ? selected.startMs! : selected.endMs! : edge === 'start' ? draftStart : draftEnd}
                minMs={edge === 'start' ? limits.min : (assigned ? selected.startMs! : draftStart) + MIN_WORD_MS}
                maxMs={edge === 'start' ? (assigned ? selected.endMs! : draftEnd) - MIN_WORD_MS : limits.max}
                disabled={wordEditingDisabled} onFocus={onStopPreview} onCommit={(value) => change(edge, value)}/>
            </div>
            <div className="timing-edge-actions">
              <button disabled={wordEditingDisabled || !assigned} onClick={() => nudge(edge, -stepMs)} aria-label={`Move word ${edge} earlier`}>−{stepMs} ms</button>
              <button disabled={wordEditingDisabled || !assigned} onClick={() => nudge(edge, stepMs)} aria-label={`Move word ${edge} later`}>+{stepMs} ms</button>
              <button disabled={wordEditingDisabled || playheadMs < (edge === 'start' ? limits.min : (assigned ? selected.startMs! : draftStart) + MIN_WORD_MS) || playheadMs > (edge === 'end' ? limits.max : (assigned ? selected.endMs! : draftEnd) - MIN_WORD_MS)} onClick={() => change(edge, playheadMs)} aria-label={`Set word ${edge} to playhead`}>Set to playhead</button>
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
