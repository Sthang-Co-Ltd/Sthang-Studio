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
import { reconcileCaptionWordTiming, resolveCaptionWordTiming } from '@kcs/shared';
import {
  CheckCircle2,
  Clock3,
  LocateFixed,
  LockKeyhole,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Scissors,
  Trash2,
} from 'lucide-react';
import type { ReviewIssue } from '../review';
import { MIN_CAPTION_MS } from '../timing-edit';
import { TimestampInput } from './TimestampInput';
import { captionNeighborLimitMap, planCaptionTimingEdit } from '../caption-timing-transaction';
import { splitCaptionForEditing, mergeCaptionsForEditing } from '../caption-word-structure';

const qualityLabel = (caption: CaptionSegment) => caption.timingSource === 'manual'
  ? '•'
  : caption.timingQuality === 'high' ? '✓' : caption.timingQuality === 'medium' ? '~' : '!';
const qualityTitle = (caption: CaptionSegment) => caption.timingSource === 'manual'
  ? 'Timing manually edited'
  : caption.timingQuality === 'high'
    ? 'Timing looks precise'
    : caption.timingQuality === 'medium'
      ? 'Timing may need a quick listen'
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
  onEditingChange,
}, ref) {
  const list = useRef<HTMLDivElement | null>(null);
  const rows = useRef<Record<string, HTMLDivElement | null>>({});
  const textareas = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const focusText = useRef<Record<string, string>>({});
  const focusTimingBasis = useRef<Record<string, CaptionSegment>>({});
  const pendingViewportRestore = useRef<PendingViewportRestore | null>(null);
  const autoScrollingUntil = useRef(0);
  const [followPlayback, setFollowPlayback] = useState(true);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const actionMenu = useRef<HTMLDivElement | null>(null);
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
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenMenuId(null); };
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
    }
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
        <strong>{reviewMode ? 'Review queue' : 'Timeline captions'}</strong>
        <span>{visible.length} shown · {captions.length} total · {followPlayback ? 'following playback' : 'follow paused — browse freely'}</span>
      </div>
      <div className="panel-tools">
        <button className="panel-tool" title="Jump to current caption" onClick={jumpToPlayhead} disabled={!visible.length}><LocateFixed size={15}/><span>Current</span></button>
        <button className={`panel-tool ${followPlayback ? 'following' : ''}`} title={followPlayback ? 'Pause follow' : 'Follow playback'} onClick={toggleFollow} disabled={!visible.length}>{followPlayback ? <Pause size={14}/> : <Play size={14}/>}<span>{followPlayback ? 'Following' : 'Follow'}</span></button>
        <button className="icon-btn" title="Add caption" onClick={add}><Plus size={17}/></button>
      </div>
    </div>
    <div
      ref={list}
      className="caption-list"
      onWheelCapture={pauseFollowForBrowsing}
      onTouchMove={pauseFollowForBrowsing}
      onScroll={() => { if (performance.now() > autoScrollingUntil.current) pauseFollowForBrowsing(); }}
    >
      {visible.length === 0 && <div className="review-empty">You're all caught up. No unapproved captions need attention.</div>}
      {visible.map((caption) => {
        const index = captionIndexMap.get(caption.id) ?? -1;
        const issue = issueMap.get(caption.id);
        const destructiveLocked = caption.textLocked || caption.timingLocked;
        return <div
          ref={(element: HTMLDivElement | null) => { rows.current[caption.id] = element; }}
          data-caption-id={caption.id}
          className={`caption-row ${active === caption.id ? 'active' : ''} ${selected.has(caption.id) ? 'selected-range' : ''} ${caption.approved ? 'approved' : ''} ${destructiveLocked ? 'locked' : ''}`}
          key={caption.id}
          onFocusCapture={() => onSelect(caption.id, false)}
          onClick={(event) => { onSelect(caption.id, event.shiftKey); onSeek(caption.startMs); }}
        >
          <span className={`quality-dot quality-${caption.timingSource === 'manual' ? 'manual' : caption.timingQuality || 'medium'}`} title={qualityTitle(caption)}>{qualityLabel(caption)}</span>
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
              {wordsNeedingReview.has(caption.id) && selected.has(caption.id) && <button type="button" onClick={(event) => { event.stopPropagation(); onWordTiming?.(caption.id); }}>Word timing needs review</button>}
            </div>
            {issue && <div className={`risk-reasons risk-${issue.severity} ${selected.has(caption.id) ? 'expanded' : ''}`}>
              <span>{selected.has(caption.id) ? issue.reasons[0] : `Review suggested · ${issue.reasons.length}`}</span>
              {selected.has(caption.id) && issue.reasons.slice(1, 3).map((reason) => <span key={reason}>{reason}</span>)}
            </div>}
          </div>
          <div className="row-actions" data-caption-menu={caption.id}>
            <button
              className={`row-approve ${caption.approved ? 'state-on' : ''}`}
              aria-label={caption.approved ? 'Mark caption as needing review' : reviewMode ? 'Approve caption and move to the next review item' : 'Approve caption'}
              aria-pressed={Boolean(caption.approved)}
              onClick={(event) => { event.stopPropagation(); toggleApproval(index, caption); }}
              title={caption.approved ? 'Needs review' : reviewMode ? 'Approve & next' : 'Approve caption'}
            ><CheckCircle2 size={15}/></button>
            <button
              className={`row-more ${openMenuId === caption.id ? 'state-on' : ''}`}
              aria-label={`More actions for caption ${index + 1}`}
              aria-expanded={openMenuId === caption.id}
              onClick={(event) => { event.stopPropagation(); setOpenMenuId((current) => current === caption.id ? null : caption.id); }}
              title="More actions"
            ><MoreHorizontal size={16}/></button>
            {openMenuId === caption.id && <div ref={actionMenu} className={`caption-action-menu ${menuPlacement.up ? 'menu-up' : ''}`} role="menu" style={{ maxHeight: menuPlacement.height, overflowY: 'auto' }}>
              {onWordTiming && <button role="menuitem" onClick={(event) => { event.stopPropagation(); setOpenMenuId(null); onWordTiming(caption.id); }}><Clock3 size={14}/><span>Edit word timing</span></button>}
              <button role="menuitem" className={caption.textLocked ? 'state-on' : ''} onClick={(event) => { event.stopPropagation(); patch(index, { textLocked: !caption.textLocked }, 'metadata'); setOpenMenuId(null); }}><LockKeyhole size={14}/><span>{caption.textLocked ? 'Unlock text' : 'Lock text'}</span></button>
              <button role="menuitem" className={caption.timingLocked ? 'state-on' : ''} onClick={(event) => { event.stopPropagation(); patch(index, { timingLocked: !caption.timingLocked }, 'metadata'); setOpenMenuId(null); }}><Clock3 size={14}/><span>{caption.timingLocked ? 'Unlock timing' : 'Lock timing'}</span></button>
              <div className="caption-menu-divider"/>
              <button role="menuitem" disabled={caption.timingLocked} onClick={(event) => { event.stopPropagation(); nudge(index, -100); setOpenMenuId(null); }}><span className="menu-micro">−100 ms</span><span>Move earlier</span></button>
              <button role="menuitem" disabled={caption.timingLocked} onClick={(event) => { event.stopPropagation(); nudge(index, 100); setOpenMenuId(null); }}><span className="menu-micro">+100 ms</span><span>Move later</span></button>
              <button role="menuitem" disabled={destructiveLocked} onClick={(event) => { event.stopPropagation(); split(index); setOpenMenuId(null); }}><Scissors size={14}/><span>{destructiveLocked ? 'Unlock before splitting' : 'Split caption'}</span></button>
              {index < captions.length - 1 && <button role="menuitem" disabled={destructiveLocked || captions[index + 1]?.textLocked || captions[index + 1]?.timingLocked} onClick={(event) => { event.stopPropagation(); merge(index); setOpenMenuId(null); }}><span className="menu-micro" aria-hidden="true">⇢</span><span>Merge with next</span></button>}
              <div className="caption-menu-divider"/>
              <button role="menuitem" className="danger-action" disabled={destructiveLocked} onClick={(event) => { event.stopPropagation(); remove(index); setOpenMenuId(null); }}><Trash2 size={14}/><span>{destructiveLocked ? 'Unlock before deleting' : 'Delete caption'}</span></button>
            </div>}
          </div>
        </div>;
      })}
    </div>
  </div>;
});
