import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CaptionSegment } from '@kcs/shared';
import { useSurfacePresence } from '../use-surface-presence';
import { useMenuKeyboard } from '../use-menu-keyboard';
import { reconcileCaptionWordTiming, resolveCaptionWordTiming } from '@kcs/shared';
import {
  AudioLines,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Combine,
  LocateFixed,
  LockKeyhole,
  MoreHorizontal,
  Pause,
  PencilLine,
  Play,
  Plus,
  Scissors,
  Trash2,
} from 'lucide-react';
import type { ReviewIssue } from '../review';
import { MIN_CAPTION_MS } from '../timing-edit';
import { TimestampInput } from './TimestampInput';
import { PanelHeaderGrip } from './PanelHeaderGrip';
import { captionNeighborLimitMap, planCaptionTimingEdit } from '../caption-timing-transaction';
import { splitCaptionForEditing, mergeCaptionsForEditing } from '../caption-word-structure';

const qualityIcon = (caption: CaptionSegment) => caption.timingSource === 'manual'
  ? <PencilLine size={12}/>
  : caption.timingQuality === 'high' ? <Check size={12}/> : caption.timingQuality === 'medium' ? <AudioLines size={12}/> : <CircleAlert size={12}/>;
const qualityTitle = (caption: CaptionSegment) => caption.timingSource === 'manual'
  ? 'Timing manually edited'
  : caption.timingQuality === 'high'
    ? 'Timing looks precise'
    : caption.timingQuality === 'medium'
      ? 'Listen to check timing'
      : 'Timing needs review';

export interface CaptionEditorHandle {
  focusCaption(id: string): void;
  revealCaption(id: string): void;
  jumpToPlayhead(): void;
}

export type DraftChangeReason = 'text' | 'timing' | 'structure' | 'metadata';

interface CaptionEditorProps {
  captions: CaptionSegment[];
  active: string | null;
  playheadMs: number;
  selectedIds: string[];
  issues: ReviewIssue[];
  reviewMode: boolean;
  durationMs?: number;
  highlightEnabled?: boolean;
  onWordTiming?(id: string): void;
  onNotice?(message: string): void;
  onChange(captions: CaptionSegment[], preferredSelectionId?: string, reason?: DraftChangeReason): void;
  onSeek(ms: number): void;
  onSelect(id: string, extend: boolean): void;
  onTextCommit(): void;
  onEditCommit?(): void;
  onReviewComplete?(): void;
  onEditingChange?(editing: boolean): void;
}

interface PendingViewportRestore {
  anchorId: string | null;
  anchorOffset: number;
  fallbackScrollTop: number;
}

export const CaptionEditor = forwardRef<CaptionEditorHandle, CaptionEditorProps>(function CaptionEditor({
  captions,
  active,
  playheadMs,
  selectedIds,
  issues,
  reviewMode,
  durationMs,
  highlightEnabled,
  onWordTiming,
  onNotice,
  onChange,
  onSeek,
  onSelect,
  onTextCommit,
  onEditCommit,
  onReviewComplete,
  onEditingChange,
}, ref) {
  const list = useRef<HTMLDivElement | null>(null);
  const rows = useRef<Record<string, HTMLDivElement | null>>({});
  const textareas = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const focusText = useRef<Record<string, string>>({});
  const focusTimingBasis = useRef<Record<string, CaptionSegment>>({});
  const pointerActionFocus = useRef<HTMLButtonElement | null>(null);
  const pendingViewportRestore = useRef<PendingViewportRestore | null>(null);
  const autoScrollingUntil = useRef(0);
  const [followPlayback, setFollowPlayback] = useState(true);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const actionMenu = useRef<HTMLDivElement | null>(null);
  const menuActionTrigger = useRef<HTMLButtonElement | null>(null);
  const menuPresence = useSurfacePresence(openMenuId, actionMenu, 'menu');
  const menuKeyboard = useMenuKeyboard(openMenuId, actionMenu, () => openMenuId ? rows.current[openMenuId]?.querySelector<HTMLButtonElement>('.row-more') : null, () => setOpenMenuId(null));
  const [menuPlacement, setMenuPlacement] = useState({ up: false, height: 400 });
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const mediaLimit = durationMs && Number.isFinite(durationMs) ? durationMs : Number.MAX_SAFE_INTEGER;
  const neighborLimits = useMemo(() => captionNeighborLimitMap(captions, mediaLimit), [captions, mediaLimit]);
  const wordsNeedingReview = useMemo(() => new Set(highlightEnabled ? captions.filter((caption) => resolveCaptionWordTiming(caption).state !== 'ready').map((caption) => caption.id) : []), [captions, highlightEnabled]);
  const issueMap = useMemo(() => new Map(issues.map((issue) => [issue.captionId, issue])), [issues]);
  const visible = useMemo(
    () => reviewMode ? captions.filter((caption) => issueMap.has(caption.id) && !caption.approved) : captions,
    [captions, issueMap, reviewMode],
  );
  useLayoutEffect(() => {
    if (openMenuId || !menuActionTrigger.current) return;
    const opener = menuActionTrigger.current;
    menuActionTrigger.current = null;
    if (opener.isConnected) return;
    // Split/delete may remove the trigger. Continue on the resulting selection.
    const next = selectedIds.find((id) => rows.current[id]) || visible[0]?.id;
    const fallback = next ? rows.current[next]?.querySelector<HTMLButtonElement>('.row-more') : list.current?.parentElement?.querySelector<HTMLButtonElement>('[aria-label="Add caption"]');
    fallback?.focus({ preventScroll: true });
  }, [openMenuId, selectedIds, visible]);
  const captionIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < captions.length; i++) {
      const id = captions[i]?.id;
      if (id !== undefined && !map.has(id)) {
        map.set(id, i);
      }
    }
    return map;
  }, [captions]);

  useEffect(() => {
    let resetTimer: number | undefined;
    const clearPointerFocus = () => {
      window.clearTimeout(resetTimer);
      resetTimer = undefined;
      pointerActionFocus.current = null;
    };
    const clearAfterPointer = () => {
      // Discard unused markers after release/capture loss. A later touch
      // compatibility mousedown re-arms the marker before its native focus.
      if (pointerActionFocus.current) {
        window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(clearPointerFocus, 0);
      }
    };
    const immediateEvents = ['pointerdown', 'mousedown', 'pointercancel', 'keydown', 'click'] as const;
    const completionEvents = ['pointerup', 'mouseup', 'lostpointercapture'] as const;
    for (const type of immediateEvents) document.addEventListener(type, clearPointerFocus, true);
    for (const type of completionEvents) document.addEventListener(type, clearAfterPointer, true);
    window.addEventListener('blur', clearPointerFocus);
    return () => {
      clearPointerFocus();
      for (const type of immediateEvents) document.removeEventListener(type, clearPointerFocus, true);
      for (const type of completionEvents) document.removeEventListener(type, clearAfterPointer, true);
      window.removeEventListener('blur', clearPointerFocus);
    };
  }, []);

  useEffect(() => setOpenMenuId(null), [reviewMode, captions.length]);
  useLayoutEffect(() => {
    if (!openMenuId) return;
    const position = () => {
      const menu = actionMenu.current;
      const button = rows.current[openMenuId]?.querySelector('.row-more');
      const container = list.current;
      if (!menu || !button || !container) return;
      const buttonBox = button.getBoundingClientRect();
      const listBox = container.getBoundingClientRect();
      const above = Math.max(0, buttonBox.top - Math.max(0, listBox.top) - 8);
      const below = Math.max(0, Math.min(window.innerHeight, listBox.bottom) - buttonBox.bottom - 8);
      const up = below < menu.scrollHeight && above > below;
      const height = Math.max(40, Math.floor(up ? above : below));
      setMenuPlacement((current) => current.up === up && current.height === height ? current : { up, height });
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [openMenuId, visible.length]);
  useEffect(() => {
    if (!openMenuId) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(`[data-caption-menu="${openMenuId}"]`)) setOpenMenuId(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && !document.querySelector('[aria-modal="true"]')) {
        event.preventDefault();
        rows.current[openMenuId]?.querySelector<HTMLButtonElement>('.row-more')?.focus({ preventScroll: true });
        setOpenMenuId(null);
      }
    };
    document.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenuId]);

  const closestVisibleToPlayhead = () => {
    if (!visible.length) return null;
    const exact = visible.find((caption) => playheadMs >= caption.startMs && playheadMs < caption.endMs);
    if (exact) return exact;
    let best = visible[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const caption of visible) {
      const distance = playheadMs < caption.startMs ? caption.startMs - playheadMs : playheadMs - caption.endMs;
      if (distance < bestDistance) { best = caption; bestDistance = distance; }
    }
    return best;
  };

  const reveal = (id: string, behavior: ScrollBehavior = 'smooth', forceCenter = false) => {
    const container = list.current;
    const row = rows.current[id];
    if (!container || !row) return;
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const trackingTop = containerRect.top + Math.max(54, containerRect.height * 0.22);
    const trackingBottom = containerRect.bottom - Math.max(64, containerRect.height * 0.22);
    const insideTrackingBand = rowRect.top >= trackingTop && rowRect.bottom <= trackingBottom;
    if (!forceCenter && insideTrackingBand) return;
    const top = container.scrollTop + rowRect.top - containerRect.top - container.clientHeight * 0.43 + rowRect.height / 2;
    autoScrollingUntil.current = performance.now() + (behavior === 'smooth' ? 1200 : 180);
    container.scrollTo({ top: Math.max(0, top), behavior });
  };

  const jumpToPlayhead = () => {
    const target = closestVisibleToPlayhead();
    if (!target) return;
    onSelect(target.id, false);
    reveal(target.id, 'smooth', true);
  };

  useImperativeHandle(ref, () => ({
    focusCaption(id: string) {
      setFollowPlayback(false);
      reveal(id, 'smooth', true);
      window.setTimeout(() => {
        if (!captions.find((caption) => caption.id === id)?.textLocked) {
          textareas.current[id]?.focus();
          textareas.current[id]?.select();
        }
      }, 180);
    },
    revealCaption(id: string) { reveal(id, 'smooth', true); },
    jumpToPlayhead,
  }));

  useEffect(() => {
    if (!followPlayback || !active) return;
    reveal(active, 'smooth', false);
  }, [active, followPlayback]);

  useLayoutEffect(() => {
    const pending = pendingViewportRestore.current;
    const container = list.current;
    if (!pending || !container) return;
    const row = pending.anchorId ? rows.current[pending.anchorId] : null;
    autoScrollingUntil.current = performance.now() + 180;
    if (row) {
      const currentOffset = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTop += currentOffset - pending.anchorOffset;
    } else container.scrollTop = pending.fallbackScrollTop;
    pendingViewportRestore.current = null;
  }, [captions, reviewMode]);

  const pauseFollowForBrowsing = () => setFollowPlayback((current) => current ? false : current);
  const preserveViewport = (beforeAnchorId: string | null, afterAnchorId: string | null, mutate: () => void) => {
    const container = list.current;
    const beforeRow = beforeAnchorId ? rows.current[beforeAnchorId] : null;
    pendingViewportRestore.current = {
      anchorId: afterAnchorId,
      anchorOffset: beforeRow && container ? beforeRow.getBoundingClientRect().top - container.getBoundingClientRect().top : 0,
      fallbackScrollTop: container?.scrollTop || 0,
    };
    autoScrollingUntil.current = performance.now() + 220;
    mutate();
  };

  const patch = (index: number, value: Partial<CaptionSegment>, reason: DraftChangeReason = 'metadata') => onChange(captions.map((caption, i) => i === index ? { ...caption, ...value } : caption), undefined, reason);
  const toggleApproval = (index: number, caption: CaptionSegment) => {
    const approving = !caption.approved;
    let nextVisible: CaptionSegment | undefined;
    if (reviewMode && approving) {
      const visibleIndex = visible.findIndex((item) => item.id === caption.id);
      nextVisible = visible[visibleIndex + 1] || visible[visibleIndex - 1];
    }
    onChange(
      captions.map((item, itemIndex) => itemIndex === index ? { ...item, approved: approving } : item),
      nextVisible?.id,
      'metadata',
    );
    if (nextVisible) {
      onSeek(nextVisible.startMs);
      window.setTimeout(() => reveal(nextVisible!.id, 'smooth', true), 40);
    } else if (reviewMode && approving) onReviewComplete?.();
  };
  const patchTime = (index: number, value: Partial<CaptionSegment>) => {
    const caption = captions[index];
    if (!caption || caption.timingLocked) return false;
    const edge = value.startMs !== undefined ? 'start' : 'end';
    const result = planCaptionTimingEdit(captions, caption.id, edge, value.startMs ?? value.endMs!, mediaLimit);
    if (result.limited) onNotice?.(result.limited);
    if (!result.after.length) return false;
    onChange(captions.map((item) => item.id === caption.id ? result.after[0] : item), caption.id, 'timing');
    return true;
  };
  const patchText = (caption: CaptionSegment, text: string) => {
    if (caption.textLocked) return;
    // Reconcile against the stable focus snapshot, not transient IME/composition
    // text, so an unfinished Khmer cluster cannot erase good surrounding timings.
    const basis = focusTimingBasis.current[caption.id] || caption;
    const after = reconcileCaptionWordTiming(basis, { ...caption, text, wordTiming: basis.wordTiming, approved: false });
    onChange(captions.map((item) => item.id === caption.id ? after : item), undefined, 'text');
  };

  const remove = (index: number) => {
    setFollowPlayback(false);
    const caption = captions[index];
    if (!caption || caption.textLocked || caption.timingLocked) return;
    const replacement = captions[index + 1] || captions[index - 1] || null;
    const preferredSelectionId = selected.has(caption.id) ? replacement?.id : undefined;
    preserveViewport(replacement?.id || caption.id, replacement?.id || null, () => {
      onChange(captions.filter((_, i) => i !== index), preferredSelectionId, 'structure');
    });
  };

  const split = (index: number) => {
    setFollowPlayback(false);
    const caption = captions[index];
    if (!caption || caption.textLocked || caption.timingLocked) return;
    const divided = splitCaptionForEditing(caption, crypto.randomUUID(), crypto.randomUUID());
    if (!divided) { onNotice?.('This caption is too short to split safely.'); return; }
    const [first, second] = divided;
    preserveViewport(caption.id, first.id, () => {
      onChange([...captions.slice(0, index), first, second, ...captions.slice(index + 1)], selected.has(caption.id) ? first.id : undefined, 'structure');
    });
  };

  const merge = (index: number) => {
    setFollowPlayback(false);
    const first = captions[index];
    const second = captions[index + 1];
    if (!first || !second || first.textLocked || first.timingLocked || second.textLocked || second.timingLocked) return;
    const merged = mergeCaptionsForEditing(first, second, crypto.randomUUID());
    if (!merged) return;
    preserveViewport(first.id, merged.id, () => {
      onChange([...captions.slice(0, index), merged, ...captions.slice(index + 2)], selected.has(first.id) || selected.has(second.id) ? merged.id : undefined, 'structure');
    });
  };

  const nudge = (index: number, delta: number) => {
    setFollowPlayback(false);
    const caption = captions[index];
    if (!caption || caption.timingLocked) return;
    const result = planCaptionTimingEdit(captions, caption.id, 'move', delta, mediaLimit);
    if (result.limited) onNotice?.(result.limited);
    if (result.after.length) onChange(captions.map((item) => item.id === caption.id ? result.after[0] : item), caption.id, 'timing');
  };

  const add = () => {
    const last = captions.at(-1);
    const id = crypto.randomUUID();
    const next = [...captions, {
      id,
      startMs: last?.endMs || 0,
      endMs: (last?.endMs || 0) + 1500,
      text: '',
      timingSource: 'manual' as const,
      timingQuality: 'medium' as const,
      approved: false,
    }];
    setFollowPlayback(false);
    onChange(next, id, 'structure');
    window.setTimeout(() => { reveal(id, 'smooth', true); textareas.current[id]?.focus(); }, 80);
  };

  const toggleFollow = () => setFollowPlayback((current) => {
    const next = !current;
    if (next) window.setTimeout(jumpToPlayhead, 0);
    return next;
  });

  return <div className="caption-panel">
    <div className="panel-head">
      <div className="panel-head-copy">
        <PanelHeaderGrip pane="captions">{reviewMode ? 'Review queue' : 'Captions'}</PanelHeaderGrip>
        <span>{visible.length} shown · {captions.length} total · {followPlayback ? 'Following playback' : 'Follow paused'}</span>
      </div>
      <div className="panel-tools">
        <button className="panel-tool" data-tooltip="Jump to the caption at the playhead" data-tooltip-shortcut="J" onClick={jumpToPlayhead} disabled={!visible.length}><LocateFixed size={15}/><span>Current</span></button>
        <button className={`panel-tool ${followPlayback ? 'following' : ''}`} data-tooltip={followPlayback ? 'Pause automatic scrolling during playback' : 'Keep the playing caption in view'} onClick={toggleFollow} disabled={!visible.length}>{followPlayback ? <Pause size={14}/> : <Play size={14}/>}<span>{followPlayback ? 'Following' : 'Follow'}</span></button>
        <button className="icon-btn" aria-label="Add caption" data-tooltip="Add a caption" onClick={add}><Plus size={17}/></button>
      </div>
    </div>
    <div
      ref={list}
      className="caption-list"
      onWheelCapture={pauseFollowForBrowsing}
      onTouchMove={pauseFollowForBrowsing}
      onScroll={() => { if (performance.now() > autoScrollingUntil.current) pauseFollowForBrowsing(); }}
    >
      {visible.length === 0 && <div className="review-empty">{captions.length ? 'No unapproved captions need review.' : 'No captions yet. Add one to start.'}</div>}
      {visible.map((caption) => {
        const index = captionIndexMap.get(caption.id) ?? -1;
        const issue = issueMap.get(caption.id);
        const destructiveLocked = caption.textLocked || caption.timingLocked;
        const nextLocked = captions[index + 1]?.textLocked || captions[index + 1]?.timingLocked;
        const mergeHint = destructiveLocked && nextLocked ? 'Unlock both captions first' : destructiveLocked ? 'Unlock this caption first' : nextLocked ? 'Unlock the next caption first' : '';
        return <div
          ref={(element: HTMLDivElement | null) => { rows.current[caption.id] = element; }}
          data-caption-id={caption.id}
          className={`caption-row ${active === caption.id ? 'active' : ''} ${selected.has(caption.id) ? 'selected-range' : ''} ${caption.approved ? 'approved' : ''} ${destructiveLocked ? 'locked' : ''}`}
          key={caption.id}
          onFocusCapture={(event) => {
            // Selecting can collapse an earlier row's risk details. Allow native
            // blur/save and focus, but do not move a pressed action before click.
            if (pointerActionFocus.current === event.nativeEvent.target) {
              pointerActionFocus.current = null;
              return;
            }
            onSelect(caption.id, false);
          }}
          onClick={(event) => { onSelect(caption.id, event.shiftKey); onSeek(caption.startMs); }}
        >
          <span className={`quality-dot quality-${caption.timingSource === 'manual' ? 'manual' : caption.timingQuality || 'medium'}`} role="img" aria-label={qualityTitle(caption)} title={qualityTitle(caption)}>{qualityIcon(caption)}</span>
          <span className="row-index">{String(index + 1).padStart(2, '0')}</span>
          <div className="time-stack">
            <TimestampInput
              valueMs={caption.startMs}
              label={`Caption ${index + 1} start time`}
              minMs={neighborLimits.get(caption.id)?.lower ?? 0}
              maxMs={caption.endMs - MIN_CAPTION_MS}
              disabled={caption.timingLocked}
              onFocus={() => setFollowPlayback(false)}
              onEditingChange={onEditingChange}
              onCommit={(startMs) => { const accepted = patchTime(index, { startMs }); if (accepted) onEditCommit?.(); return accepted; }}
            />
            <TimestampInput
              valueMs={caption.endMs}
              label={`Caption ${index + 1} end time`}
              minMs={caption.startMs + MIN_CAPTION_MS}
              maxMs={neighborLimits.get(caption.id)?.upper ?? durationMs}
              disabled={caption.timingLocked}
              onFocus={() => setFollowPlayback(false)}
              onEditingChange={onEditingChange}
              onCommit={(endMs) => { const accepted = patchTime(index, { endMs }); if (accepted) onEditCommit?.(); return accepted; }}
            />
          </div>
          <div className="caption-text-cell">
            <textarea
              ref={(element: HTMLTextAreaElement | null) => { textareas.current[caption.id] = element; }}
              value={caption.text}
              aria-label={`Caption ${index + 1} text`}
              rows={2}
              readOnly={caption.textLocked}
              spellCheck={false}
              onClick={(event) => event.stopPropagation()}
              onFocus={() => {
                focusText.current[caption.id] = caption.text;
                focusTimingBasis.current[caption.id] = caption;
                setFollowPlayback(false);
                onEditingChange?.(true);
              }}
              onChange={(event) => patchText(caption, event.target.value)}
              onCompositionEnd={(event) => patchText(caption, event.currentTarget.value)}
              onBlur={(event) => {
                onEditingChange?.(false);
                if ((focusText.current[caption.id] ?? caption.text) !== event.target.value) { onTextCommit(); onEditCommit?.(); }
                delete focusTimingBasis.current[caption.id];
              }}
            />
            <div className="caption-state-line">
              {caption.approved && <span className="state-approved"><CheckCircle2 size={11}/>Approved</span>}
              {caption.textLocked && <span><LockKeyhole size={10}/>Text locked</span>}
              {caption.timingLocked && <span><Clock3 size={10}/>Timing locked</span>}
              {wordsNeedingReview.has(caption.id) && selected.has(caption.id) && <button type="button" onClick={(event) => { event.stopPropagation(); onWordTiming?.(caption.id); }}>Review word timing</button>}
            </div>
            {issue && <div className={`risk-reasons risk-${issue.severity} ${selected.has(caption.id) ? 'expanded' : ''}`}>
              <span>{selected.has(caption.id) ? issue.reasons[0] : `Review suggested · ${issue.reasons.length}`}</span>
              {selected.has(caption.id) && issue.reasons.slice(1, 3).map((reason) => <span key={reason}>{reason}</span>)}
            </div>}
          </div>
          <div
            className="row-actions"
            data-caption-menu={caption.id}
            onPointerDownCapture={(event) => {
              const button = (event.target as Element).closest('button');
              pointerActionFocus.current = event.isPrimary && event.button === 0 && button && !button.disabled ? button : null;
            }}
            onMouseDownCapture={(event) => {
              // Touch compatibility events may follow pointerup in a later task.
              // Defer selection through their focus too; activate only on click.
              const button = (event.target as Element).closest('button');
              pointerActionFocus.current = event.button === 0 && button && !button.disabled ? button : null;
            }}
            onClickCapture={(event) => {
              const button = (event.target as Element).closest('button');
              if (button && !button.disabled) onSelect(caption.id, false);
            }}
          >
            <button
              className={`row-approve ${caption.approved ? 'state-on' : ''}`}
              aria-label={caption.approved ? 'Mark caption as needing review' : reviewMode ? 'Approve caption and move to the next review item' : 'Approve caption'}
              aria-pressed={Boolean(caption.approved)}
              onClick={(event) => { event.stopPropagation(); toggleApproval(index, caption); }}
              data-tooltip={caption.approved ? 'Mark this caption for review again' : reviewMode ? 'Approve and move to the next flagged caption' : 'Approve this caption'}
            ><CheckCircle2 size={15}/></button>
            <button
              className={`row-more ${openMenuId === caption.id ? 'state-on' : ''}`}
              aria-label={`More actions for caption ${index + 1}`}
              aria-haspopup="menu"
              aria-expanded={openMenuId === caption.id}
              onKeyDown={(event) => {
                if (!event.altKey && !event.ctrlKey && !event.metaKey && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
                  event.preventDefault(); event.stopPropagation(); menuKeyboard.openAt(event.key === 'ArrowUp' ? 'last' : 'first', caption.id); setOpenMenuId(caption.id);
                }
              }}
              onClick={(event) => {
                event.stopPropagation();
                if (openMenuId === caption.id) event.currentTarget.focus({ preventScroll: true }); else menuKeyboard.openAt('first', caption.id);
                setOpenMenuId((current) => current === caption.id ? null : caption.id);
              }}
              data-tooltip="More caption actions"
            ><MoreHorizontal size={16}/></button>
            {menuPresence.present && menuPresence.value === caption.id && <div ref={actionMenu} className={`caption-action-menu ${menuPlacement.up ? 'menu-up' : ''}`} role="menu" aria-label={`Caption ${index + 1} actions`} onKeyDown={menuKeyboard.onKeyDown}
              onClickCapture={(event) => {
                if (!(event.target as Element).closest('button:not(:disabled)')) return;
                menuActionTrigger.current = rows.current[caption.id]?.querySelector<HTMLButtonElement>('.row-more') || null;
                menuActionTrigger.current?.focus({ preventScroll: true });
              }}
              data-motion-state={menuPresence.open ? 'open' : 'closed'} inert={!menuPresence.open} aria-hidden={!menuPresence.open || undefined} style={{ maxHeight: menuPlacement.height, overflowY: 'auto' }}>
              {onWordTiming && <button role="menuitem" onClick={(event) => { event.stopPropagation(); setOpenMenuId(null); onWordTiming(caption.id); }}><Clock3 size={14}/><span>Edit word timing</span></button>}
              <button role="menuitem" className={caption.textLocked ? 'state-on' : ''} onClick={(event) => { event.stopPropagation(); patch(index, { textLocked: !caption.textLocked }, 'metadata'); setOpenMenuId(null); }}><LockKeyhole size={14}/><span>{caption.textLocked ? 'Unlock text' : 'Lock text'}</span></button>
              <button role="menuitem" className={caption.timingLocked ? 'state-on' : ''} onClick={(event) => { event.stopPropagation(); patch(index, { timingLocked: !caption.timingLocked }, 'metadata'); setOpenMenuId(null); }}><Clock3 size={14}/><span>{caption.timingLocked ? 'Unlock timing' : 'Lock timing'}</span></button>
              <div className="caption-menu-divider"/>
              <button role="menuitem" data-menu-label="Move earlier" disabled={caption.timingLocked} onClick={(event) => { event.stopPropagation(); nudge(index, -100); setOpenMenuId(null); }}><span className="menu-micro">−100 ms</span><span className="caption-action-copy">Move earlier{caption.timingLocked && <small>Unlock timing first</small>}</span></button>
              <button role="menuitem" data-menu-label="Move later" disabled={caption.timingLocked} onClick={(event) => { event.stopPropagation(); nudge(index, 100); setOpenMenuId(null); }}><span className="menu-micro">+100 ms</span><span className="caption-action-copy">Move later{caption.timingLocked && <small>Unlock timing first</small>}</span></button>
              <button role="menuitem" disabled={destructiveLocked} onClick={(event) => { event.stopPropagation(); split(index); setOpenMenuId(null); }}><Scissors size={14}/><span>{destructiveLocked ? 'Unlock before splitting' : 'Split caption'}</span></button>
              {index < captions.length - 1 && <button role="menuitem" data-menu-label="Merge with next" disabled={destructiveLocked || nextLocked} onClick={(event) => { event.stopPropagation(); merge(index); setOpenMenuId(null); }}><Combine size={14}/><span className="caption-action-copy">Merge with next{mergeHint && <small>{mergeHint}</small>}</span></button>}
              <div className="caption-menu-divider"/>
              <button role="menuitem" className="danger-action" disabled={destructiveLocked} onClick={(event) => { event.stopPropagation(); remove(index); setOpenMenuId(null); }}><Trash2 size={14}/><span>{destructiveLocked ? 'Unlock before deleting' : 'Delete caption'}</span></button>
            </div>}
          </div>
        </div>;
      })}
    </div>
  </div>;
});
