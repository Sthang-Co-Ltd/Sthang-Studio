import { useI18n } from '../i18n';
import { memo, useCallback, type ReactNode } from 'react';
import type { CaptionSegment } from '@kcs/shared';
import { AudioLines, CheckCircle2, CircleAlert, Clock3, LockKeyhole, MoreHorizontal, PencilLine } from 'lucide-react';
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
  : caption.timingQuality === 'high' ? <svg className="quality-precise-mark" viewBox="0 0 12 12" width={12} height={12} aria-hidden="true"><circle cx={6} cy={6} r={3}/></svg>
    : caption.timingQuality === 'medium' ? <AudioLines size={12}/> : <CircleAlert size={12}/>;
const qualityTitleKey = (caption: CaptionSegment) => caption.timingSource === 'manual'
  ? 'editor.row.timingManual'
  : caption.timingQuality === 'high' ? 'editor.row.timingPrecise'
    : caption.timingQuality === 'medium' ? 'editor.row.timingListen' : 'editor.row.timingReview';

/** Keep native fields mounted; unchanged rows need no work for playback or another cue's edit.
 * Default memo compares every prop, including the stable, commit-owned event dispatcher.
 */
export const CaptionRow = memo(function CaptionRow({
  caption, index, active, selected, reviewMode, lower, upper, wordNeedsReview,
  issueSeverity, firstReason, secondReason, thirdReason, menuOpen, menu,
  registerRow, registerText, dispatch,
}: Props) {
  const { t } = useI18n();
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
    role="group" tabIndex={-1} aria-label={t('editor.row.label', { number: index + 1 })}
    className={`caption-row ${active ? 'active' : ''} ${selected ? 'selected-range' : ''} ${caption.approved ? 'approved' : ''} ${destructiveLocked ? 'locked' : ''}`}
    onFocusCapture={(event) => send({ type: 'focus', target: event.nativeEvent.target })}
    onClick={(event) => send({ type: 'click', extend: event.shiftKey })}
  >
    <span className={`quality-dot quality-${caption.timingSource === 'manual' ? 'manual' : caption.timingQuality || 'medium'}`} role="img" aria-label={t(qualityTitleKey(caption))} title={t(qualityTitleKey(caption))}>{qualityIcon(caption)}</span>
    <span className="row-index">{index + 1}</span>
    <div className="time-stack">
      <TimestampInput valueMs={caption.startMs} label={t('editor.row.start', { number: index + 1 })}
        minMs={lower} maxMs={caption.endMs - MIN_CAPTION_MS} disabled={caption.timingLocked}
        onFocus={() => send({ type: 'timeFocus' })} onEditingChange={(editing) => send({ type: 'editing', editing })}
        onCommit={(value) => send({ type: 'timeCommit', edge: 'start', value })}/>
      <TimestampInput valueMs={caption.endMs} label={t('editor.row.end', { number: index + 1 })}
        minMs={caption.startMs + MIN_CAPTION_MS} maxMs={upper} disabled={caption.timingLocked}
        onFocus={() => send({ type: 'timeFocus' })} onEditingChange={(editing) => send({ type: 'editing', editing })}
        onCommit={(value) => send({ type: 'timeCommit', edge: 'end', value })}/>
    </div>
    <div className="caption-text-cell">
      <textarea ref={textRef} value={caption.text} aria-label={t('editor.row.text', { number: index + 1 })} rows={2}
        readOnly={caption.textLocked} spellCheck={false}
        onClick={(event) => event.stopPropagation()}
        onFocus={() => send({ type: 'textFocus' })}
        onChange={(event) => send({ type: 'textChange', text: event.target.value })}
        onCompositionEnd={(event) => send({ type: 'textChange', text: event.currentTarget.value })}
        onBlur={(event) => send({ type: 'textBlur', text: event.target.value })}/>
      <div className="caption-state-line">
        {caption.approved && <span className="state-approved"><CheckCircle2 size={11}/>{t('editor.row.approved')}</span>}
        {caption.textLocked && <span><LockKeyhole size={10}/>{t('editor.row.textLocked')}</span>}
        {caption.timingLocked && <span><Clock3 size={10}/>{t('editor.row.timingLocked')}</span>}
        {wordNeedsReview && selected && <button type="button" onClick={(event) => { event.stopPropagation(); send({ type: 'wordTiming' }); }}>{t('editor.row.reviewWords')}</button>}
      </div>
      {issueSeverity && <div className={`risk-reasons risk-${issueSeverity} ${selected ? 'expanded' : ''}`}>
        {selected ? <>
          <span>{firstReason}</span>
          {secondReason && <span>{secondReason}</span>}
          {thirdReason && <span>{thirdReason}</span>}
        </> : <span>{t('editor.row.suggested')}</span>}
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
        aria-label={caption.approved ? t('editor.row.unapprove') : reviewMode ? t('editor.row.approveNext') : t('editor.row.approve')}
        aria-pressed={Boolean(caption.approved)}
        onKeyDown={(event) => { if (event.key === 'Enter' && event.repeat) event.preventDefault(); }}
        onClick={(event) => { event.stopPropagation(); send({ type: 'approve' }); }}
        data-tooltip={caption.approved ? t('editor.row.unapproveTip') : reviewMode ? t('editor.row.approveNextTip') : t('editor.row.approveTip')}
      ><CheckCircle2 size={15}/></button>
      <button className={`row-more ${menuOpen ? 'state-on' : ''}`} aria-label={t('editor.row.menu', { number: index + 1 })}
        aria-haspopup="menu" aria-expanded={menuOpen}
        onKeyDown={(event) => {
          if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229 && !event.getModifierState('AltGraph')
            && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation(); send({ type: 'openMenu', position: event.key === 'ArrowUp' ? 'last' : 'first' });
          }
        }}
        onClick={(event) => { event.stopPropagation(); send({ type: 'toggleMenu', trigger: event.currentTarget }); }}
        data-tooltip={t('editor.row.menuTip')}
      ><MoreHorizontal size={16}/></button>
      {menu}
    </div>
  </div>;
});
