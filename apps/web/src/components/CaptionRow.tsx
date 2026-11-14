import { memo, useCallback, type ReactNode } from 'react';
import type { CaptionSegment } from '@kcs/shared';
import { AudioLines, Check, CheckCircle2, CircleAlert, Clock3, LockKeyhole, MoreHorizontal, PencilLine } from 'lucide-react';
import type { ReviewSeverity } from '../review';
import { MIN_CAPTION_MS } from '../timing-edit';
import { TimestampInput } from './TimestampInput';

export type CaptionRowEvent =
  | { type: 'focus'; target: EventTarget | null }
  | { type: 'click'; extend: boolean }
  | { type: 'timeFocus' }
  | { type: 'editing'; editing: boolean }
  | { type: 'timeCommit'; edge: 'start' | 'end'; value: number }
  | { type: 'textFocus' }
  | { type: 'textChange'; text: string }
  | { type: 'textBlur'; text: string }
  | { type: 'wordTiming' }
  | { type: 'pointerAction'; button: HTMLButtonElement | null }
  | { type: 'actionSelect' }
  | { type: 'approve' }
  | { type: 'openMenu'; position: 'first' | 'last' }
  | { type: 'toggleMenu'; trigger: HTMLButtonElement };

interface Props {
  caption: CaptionSegment;
  index: number;
  active: boolean;
  selected: boolean;
  reviewMode: boolean;
  lower: number;
  upper: number | undefined;
  wordNeedsReview: boolean;
  issueSeverity: ReviewSeverity | undefined;
  issueCount: number;
  firstReason: string | undefined;
  secondReason: string | undefined;
  thirdReason: string | undefined;
  menuOpen: boolean;
  menu: ReactNode;
  registerRow(id: string, element: HTMLDivElement | null): void;
  registerText(id: string, element: HTMLTextAreaElement | null): void;
  dispatch(id: string, event: CaptionRowEvent): boolean | void;
}

const qualityIcon = (caption: CaptionSegment) => caption.timingSource === 'manual'
  ? <PencilLine size={12}/>
  : caption.timingQuality === 'high' ? <Check size={12}/> : caption.timingQuality === 'medium' ? <AudioLines size={12}/> : <CircleAlert size={12}/>;
const qualityTitle = (caption: CaptionSegment) => caption.timingSource === 'manual'
  ? 'Timing manually edited'
  : caption.timingQuality === 'high' ? 'Timing looks precise'
    : caption.timingQuality === 'medium' ? 'Listen to check timing' : 'Timing needs review';

/** Keep native fields mounted; unchanged rows need no work for playback or another cue's edit.
 * Default memo compares every prop, including the stable, commit-owned event dispatcher.
 */
export const CaptionRow = memo(function CaptionRow({
  caption, index, active, selected, reviewMode, lower, upper, wordNeedsReview,
  issueSeverity, issueCount, firstReason, secondReason, thirdReason, menuOpen, menu,
  registerRow, registerText, dispatch,
}: Props) {
  if (typeof window !== 'undefined' && import.meta.env?.DEV) {
    (window as unknown as { __STHANG_TEST_HOOKS__?: { onCaptionRowRender?: (id: string) => void } }).__STHANG_TEST_HOOKS__?.onCaptionRowRender?.(caption.id);
  }
  const rowRef = useCallback((element: HTMLDivElement | null) => registerRow(caption.id, element), [caption.id, registerRow]);
  const textRef = useCallback((element: HTMLTextAreaElement | null) => registerText(caption.id, element), [caption.id, registerText]);
  const destructiveLocked = caption.textLocked || caption.timingLocked;
  const send = (event: CaptionRowEvent) => dispatch(caption.id, event);
  return <div
    ref={rowRef}
    data-caption-id={caption.id}
    className={`caption-row ${active ? 'active' : ''} ${selected ? 'selected-range' : ''} ${caption.approved ? 'approved' : ''} ${destructiveLocked ? 'locked' : ''}`}
    onFocusCapture={(event) => send({ type: 'focus', target: event.nativeEvent.target })}
    onClick={(event) => send({ type: 'click', extend: event.shiftKey })}
  >
    <span className={`quality-dot quality-${caption.timingSource === 'manual' ? 'manual' : caption.timingQuality || 'medium'}`} role="img" aria-label={qualityTitle(caption)} title={qualityTitle(caption)}>{qualityIcon(caption)}</span>
    <span className="row-index">{String(index + 1).padStart(2, '0')}</span>
    <div className="time-stack">
      <TimestampInput valueMs={caption.startMs} label={`Caption ${index + 1} start time`}
        minMs={lower} maxMs={caption.endMs - MIN_CAPTION_MS} disabled={caption.timingLocked}
        onFocus={() => send({ type: 'timeFocus' })} onEditingChange={(editing) => send({ type: 'editing', editing })}
        onCommit={(value) => send({ type: 'timeCommit', edge: 'start', value })}/>
      <TimestampInput valueMs={caption.endMs} label={`Caption ${index + 1} end time`}
        minMs={caption.startMs + MIN_CAPTION_MS} maxMs={upper} disabled={caption.timingLocked}
        onFocus={() => send({ type: 'timeFocus' })} onEditingChange={(editing) => send({ type: 'editing', editing })}
        onCommit={(value) => send({ type: 'timeCommit', edge: 'end', value })}/>
    </div>
    <div className="caption-text-cell">
      <textarea ref={textRef} value={caption.text} aria-label={`Caption ${index + 1} text`} rows={2}
        readOnly={caption.textLocked} spellCheck={false}
        onClick={(event) => event.stopPropagation()}
        onFocus={() => send({ type: 'textFocus' })}
        onChange={(event) => send({ type: 'textChange', text: event.target.value })}
        onCompositionEnd={(event) => send({ type: 'textChange', text: event.currentTarget.value })}
        onBlur={(event) => send({ type: 'textBlur', text: event.target.value })}/>
      <div className="caption-state-line">
        {caption.approved && <span className="state-approved"><CheckCircle2 size={11}/>Approved</span>}
        {caption.textLocked && <span><LockKeyhole size={10}/>Text locked</span>}
        {caption.timingLocked && <span><Clock3 size={10}/>Timing locked</span>}
        {wordNeedsReview && selected && <button type="button" onClick={(event) => { event.stopPropagation(); send({ type: 'wordTiming' }); }}>Review word timing</button>}
      </div>
      {issueSeverity && <div className={`risk-reasons risk-${issueSeverity} ${selected ? 'expanded' : ''}`}>
        <span>{selected ? firstReason : `Review suggested · ${issueCount}`}</span>
        {selected && [secondReason, thirdReason].filter((reason): reason is string => reason !== undefined).map((reason) => <span key={reason}>{reason}</span>)}
      </div>}
    </div>
    <div className="row-actions" data-caption-menu={caption.id}
      onPointerDownCapture={(event) => {
        const button = (event.target as Element).closest('button');
        send({ type: 'pointerAction', button: event.isPrimary && event.button === 0 && button && !button.disabled ? button : null });
      }}
      onMouseDownCapture={(event) => {
        // Touch compatibility events may follow pointerup in a later task.
        const button = (event.target as Element).closest('button');
        send({ type: 'pointerAction', button: event.button === 0 && button && !button.disabled ? button : null });
      }}
      onClickCapture={(event) => {
        const button = (event.target as Element).closest('button');
        if (button && !button.disabled) send({ type: 'actionSelect' });
      }}
    >
      <button className={`row-approve ${caption.approved ? 'state-on' : ''}`}
        aria-label={caption.approved ? 'Mark caption as needing review' : reviewMode ? 'Approve caption and move to the next review item' : 'Approve caption'}
        aria-pressed={Boolean(caption.approved)}
        onKeyDown={(event) => { if (event.key === 'Enter' && event.repeat) event.preventDefault(); }}
        onClick={(event) => { event.stopPropagation(); send({ type: 'approve' }); }}
        data-tooltip={caption.approved ? 'Mark this caption for review again' : reviewMode ? 'Approve and move to the next flagged caption' : 'Approve this caption'}
      ><CheckCircle2 size={15}/></button>
      <button className={`row-more ${menuOpen ? 'state-on' : ''}`} aria-label={`More actions for caption ${index + 1}`}
        aria-haspopup="menu" aria-expanded={menuOpen}
        onKeyDown={(event) => {
          if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229 && !event.getModifierState('AltGraph')
            && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation(); send({ type: 'openMenu', position: event.key === 'ArrowUp' ? 'last' : 'first' });
          }
        }}
        onClick={(event) => { event.stopPropagation(); send({ type: 'toggleMenu', trigger: event.currentTarget }); }}
        data-tooltip="More caption actions"
      ><MoreHorizontal size={16}/></button>
      {menu}
    </div>
  </div>;
});
