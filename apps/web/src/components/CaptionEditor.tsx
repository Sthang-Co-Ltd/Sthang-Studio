import { useI18n } from '../i18n';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { CaptionSegment } from '@kcs/shared';
import { useSurfacePresence } from '../use-surface-presence';
import { useMenuKeyboard } from '../use-menu-keyboard';
import { highlightAttention, reconcileCaptionWordTiming } from '@kcs/shared';
import {
  Clock3,
  Combine,
  LocateFixed,
  LockKeyhole,
  ArrowDownToLine,
  Plus,
  Scissors,
  Trash2,
} from 'lucide-react';
import type { ReviewIssue, ReviewReason } from '../review';
import { MIN_CAPTION_MS } from '../timing-edit';
import { PanelHeaderGrip } from './PanelHeaderGrip';
import { CaptionRow, type CaptionRowEvent } from './CaptionRow';
import { prepareCaptionTiming, planCaptionTimingEdit } from '../caption-timing-transaction';
import { splitCaptionForEditing, mergeCaptionsForEditing } from '../caption-word-structure';
import { planReviewScroll, survivingReviewAnchorShift, type ReviewViewportAnchor } from './review-scroll-policy';

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
  onSelect(id: string, extend: boolean, seekMs?: number): void;
  onTextCommit(): void;
  onEditCommit?(): void;
  onReviewComplete?(): void;
  onEditingChange?(editing: boolean): void;
}

type CaptionMenuAction = 'words' | 'textLock' | 'timingLock' | 'earlier' | 'later' | 'split' | 'merge' | 'remove';
type CaptionEditorAction = CaptionRowEvent
  | { type: 'menuAction'; action: CaptionMenuAction }
  | { type: 'menuKey'; event: ReactKeyboardEvent<HTMLElement> };

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
  const { t, tn, tr } = useI18n();
  const list = useRef<HTMLDivElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const rows = useRef<Record<string, HTMLDivElement | null>>({});
  const textareas = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const focusText = useRef<Record<string, string>>({});
  const focusTimingBasis = useRef<Record<string, CaptionSegment>>({});
  const pointerActionFocus = useRef<HTMLButtonElement | null>(null);
  const pendingAddFocus = useRef<{ id: string; from: HTMLButtonElement } | null>(null);
  const pendingViewportRestore = useRef<PendingViewportRestore | null>(null);
  const reviewViewport = useRef<{ visibleCount: number; anchors: ReviewViewportAnchor[] } | null>(null);
  const pendingReviewReveal = useRef<string | null>(null);
  const pendingReviewActionFocus = useRef<string | null>(null);
  const autoScrollingUntil = useRef(0);
  const [followPlayback, setFollowPlayback] = useState(true);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const actionMenu = useRef<HTMLDivElement | null>(null);
  const menuActionTrigger = useRef<HTMLButtonElement | null>(null);
  const menuOpeningVisit = useRef<string | null>(null);
  const menuPresence = useSurfacePresence(openMenuId, actionMenu, 'menu');
  const menuKeyboard = useMenuKeyboard(openMenuId, actionMenu, () => openMenuId ? rows.current[openMenuId]?.querySelector<HTMLButtonElement>('.row-more') : null, () => setOpenMenuId(null));
  const [menuPlacement, setMenuPlacement] = useState({ up: false, height: 400 });
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const mediaLimit = durationMs && Number.isFinite(durationMs) ? durationMs : Number.MAX_SAFE_INTEGER;
  const preparedTiming = useMemo(() => prepareCaptionTiming(captions, mediaLimit), [captions, mediaLimit]);
  const neighborLimits = preparedTiming.limits;
  const liveRowAction = useRef<(id: string, event: CaptionEditorAction) => boolean | void>(() => {});
  const dispatchRowAction = useCallback((id: string, event: CaptionEditorAction) => liveRowAction.current(id, event), []);
  const registerRow = useCallback((id: string, element: HTMLDivElement | null) => { rows.current[id] = element; }, []);
  const registerText = useCallback((id: string, element: HTMLTextAreaElement | null) => { textareas.current[id] = element; }, []);
  // Run before the viewport/focus layout effects, which can synchronously focus a row.
  useLayoutEffect(() => { liveRowAction.current = committedRowAction; });
  const wordsNeedingReview = useMemo(() => new Set(highlightEnabled ? captions.filter((caption) => highlightAttention(caption) === 'needs-attention').map((caption) => caption.id) : []), [captions, highlightEnabled]);
  const issueMap = useMemo(() => new Map(issues.map((issue) => [issue.captionId, issue])), [issues]);
  const reviewIncludes = (caption: CaptionSegment) => issueMap.has(caption.id) && !caption.approved;
  const visible = useMemo(
    () => reviewMode ? captions.filter(reviewIncludes) : captions,
    [captions, issueMap, reviewMode],
  );
  useLayoutEffect(() => {
    if (openMenuId || !menuActionTrigger.current) return;
    const opener = menuActionTrigger.current;
    menuActionTrigger.current = null;
    if (opener.isConnected) return;
    // Split/delete may remove the trigger. Continue on the resulting selection.
    const next = selectedIds.find((id) => rows.current[id]) || visible[0]?.id;
    const fallback = next ? rows.current[next]?.querySelector<HTMLButtonElement>('.row-more') : addButton.current;
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
    if (!openMenuId) { menuOpeningVisit.current = null; return; }
    const menu = actionMenu.current;
    const button = rows.current[openMenuId]?.querySelector<HTMLButtonElement>('.row-more');
    const container = list.current;
    if (!menu || !button || !container) return;
    const workbench = container.closest<HTMLElement>('.editor-workbench');
    const toastStack = container.closest('.workspace')?.querySelector<HTMLElement>(':scope > .toast-stack');
    const overlays = [container.parentElement?.querySelector<HTMLElement>('.panel-head'), workbench?.querySelector<HTMLElement>('.editor-toolbar'), workbench?.querySelector<HTMLElement>('.stage-column')].filter((node): node is HTMLElement => Boolean(node));
    let opening = menuOpeningVisit.current !== openMenuId;
    menuOpeningVisit.current = openMenuId;
    const position = () => {
      const allowOpeningReveal = opening;
      opening = false;
      const buttonBox = button.getBoundingClientRect();
      const listBox = container.getBoundingClientRect();
      const workbenchBox = workbench?.getBoundingClientRect();
      const viewport = window.visualViewport;
      let evidenceBottom = Math.max(workbenchBox?.top ?? 0, viewport?.offsetTop ?? 0);
      let top = Math.max(listBox.top, evidenceBottom);
      let bottom = Math.min(listBox.bottom, workbenchBox?.bottom ?? window.innerHeight, viewport ? viewport.offsetTop + viewport.height : window.innerHeight);
      // On narrow screens the sticky evidence and headers cover part of the
      // caption pane. Their pixels are not available to this inline menu.
      for (const overlay of overlays) {
        if (getComputedStyle(overlay).position !== 'sticky') continue;
        const bounds = overlay.getBoundingClientRect();
        if (bounds.left < listBox.right && bounds.right > listBox.left && bounds.top <= buttonBox.top) {
          top = Math.max(top, bounds.bottom);
          // The caption header moves with its enclosing scrollport; the
          // persistent preview and toolbar bound a deliberate opening reveal.
          if (!container.parentElement?.contains(overlay)) evidenceBottom = Math.max(evidenceBottom, bounds.bottom);
        }
      }
      if (toastStack && getComputedStyle(toastStack).position === 'fixed') {
        const bounds = toastStack.getBoundingClientRect();
        const popup = menu.getBoundingClientRect();
        // Persistent save recovery remains reachable beside the menu. Its
        // occupied pixels are unavailable when it overlaps the popup's column.
        if (bounds.height > 0 && bounds.left < popup.right && bounds.right > popup.left) bottom = Math.min(bottom, bounds.top - 8);
      }
      const above = Math.max(0, buttonBox.top - top - 8);
      const below = bottom - buttonBox.bottom - 8;
      const up = below < menu.scrollHeight && above > below;
      const height = Math.floor(up ? above : below);
      const first = menu.querySelector<HTMLButtonElement>('button:not(:disabled)');
      const style = getComputedStyle(menu);
      const minimumHeight = (first?.offsetHeight ?? 44) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + menu.offsetHeight - menu.clientHeight;
      if (allowOpeningReveal && height < minimumHeight && workbench && bottom < listBox.bottom - 1 && buttonBox.top >= top - 1 && buttonBox.bottom <= bottom + 1) {
        // A visible first row may start near the phone's lower edge. Reveal
        // exactly one complete action once, without moving the sticky evidence.
        const shift = Math.ceil(minimumHeight - below) + 1;
        const available = Math.min(buttonBox.top - evidenceBottom - 8, workbench.scrollHeight - workbench.clientHeight - workbench.scrollTop);
        if (shift > 0 && shift <= available) {
          workbench.scrollTop += shift;
          position();
          return;
        }
      }
      if (buttonBox.top < top - 1 || buttonBox.bottom > bottom + 1 || height < minimumHeight) {
        // Do not strand keyboard focus inside a clipped or sub-action-height
        // popup after scrolling. The connected trigger remains the way back.
        if (menu.contains(document.activeElement) && button.isConnected) button.focus({ preventScroll: true });
        setOpenMenuId(null);
        return;
      }
      setMenuPlacement((current) => current.up === up && current.height === height ? current : { up, height });
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      // Scrolling the popup is deliberate navigation, not a placement change.
      if (target === document || target instanceof Element && target.contains(button)) position();
    };
    position();
    const observer = new ResizeObserver(position);
    for (const node of [container, button, menu, workbench, toastStack, ...overlays]) if (node) observer.observe(node);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [openMenuId, visible, selectedIds]);
  useLayoutEffect(() => {
    if (!openMenuId) return;
    const menu = actionMenu.current;
    const item = document.activeElement;
    if (!menu || !(item instanceof HTMLElement) || !menu.contains(item)) return;
    // Opening at the last action happens before placement. Keep that action
    // visible after the popup receives its final available height.
    const bounds = menu.getBoundingClientRect();
    const target = item.getBoundingClientRect();
    const top = bounds.top + menu.clientTop;
    const bottom = top + menu.clientHeight;
    if (target.top < top) menu.scrollTop -= top - target.top;
    else if (target.bottom > bottom) menu.scrollTop += target.bottom - bottom;
  }, [openMenuId, menuPlacement]);
  useEffect(() => {
    if (!openMenuId) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(`[data-caption-menu="${openMenuId}"]`)) setOpenMenuId(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !event.getModifierState('AltGraph')
        && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !document.querySelector('[aria-modal="true"]')) {
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
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reviewMode) {
      const planned = planReviewScroll({
        viewportTop: containerRect.top, viewportBottom: containerRect.bottom,
        rowTop: rowRect.top, rowBottom: rowRect.bottom, scrollTop: container.scrollTop,
        requestedBehavior: behavior, reducedMotion,
      });
      if (!planned) return;
      autoScrollingUntil.current = performance.now() + (planned.behavior === 'smooth' ? 1200 : 180);
      container.scrollTo(planned);
      return;
    }
    const trackingTop = containerRect.top + Math.max(54, containerRect.height * 0.22);
    const trackingBottom = containerRect.bottom - Math.max(64, containerRect.height * 0.22);
    const insideTrackingBand = rowRect.top >= trackingTop && rowRect.bottom <= trackingBottom;
    if (!forceCenter && insideTrackingBand) return;
    const top = container.scrollTop + rowRect.top - containerRect.top - container.clientHeight * 0.43 + rowRect.height / 2;
    const actualBehavior = reducedMotion && behavior === 'smooth' ? 'instant' : behavior;
    autoScrollingUntil.current = performance.now() + (actualBehavior === 'smooth' ? 1200 : 180);
    container.scrollTo({ top: Math.max(0, top), behavior: actualBehavior });
  };

  const jumpToPlayhead = () => {
    const target = closestVisibleToPlayhead();
    if (!target) return;
    onSelect(target.id, false);
    reveal(target.id, 'smooth', true);
  };

  useImperativeHandle(ref, () => ({
    focusCaption(id: string) {
      const caption = captions.find((item) => item.id === id);
      const field = textareas.current[id];
      if (!selectedIds.includes(id) || !caption || caption.textLocked || !field?.isConnected || field.readOnly
        || !field.getClientRects().length || document.querySelector('[aria-modal="true"]')) return;
      setFollowPlayback(false);
      reveal(id, 'smooth', true);
      // Editing is ready before the initiating action returns. Select once now;
      // later typing, caret movement or another destination must never be reset.
      field.focus();
      field.select();
    },
    revealCaption(id: string) { reveal(id, 'smooth', true); },
    jumpToPlayhead,
  }));

  useEffect(() => {
    // A newly mounted editor can still have a Follow effect queued for time zero
    // after the Correction inbox has handed focus to its recorded caption.
    if (!followPlayback || !active || document.activeElement?.hasAttribute('data-caption-id')) return;
    reveal(active, 'smooth', false);
  }, [active, followPlayback]);

  const snapshotReviewViewport = () => {
    const container = list.current;
    if (!container || !reviewMode) { reviewViewport.current = null; return; }
    const bounds = container.getBoundingClientRect();
    const children = container.children;
    let low = 0;
    let high = children.length;
    // Rows are in flow order. Search only the viewport, even on long caption projects.
    while (low < high) {
      const mid = (low + high) >> 1;
      const child = children.item(mid) as HTMLElement;
      if (child.getBoundingClientRect().bottom <= bounds.top) low = mid + 1;
      else high = mid;
    }
    const anchors: ReviewViewportAnchor[] = [];
    for (let index = low; index < children.length; index++) {
      const child = children.item(index) as HTMLElement;
      const rect = child.getBoundingClientRect();
      if (rect.top >= bounds.bottom) break;
      const id = child.getAttribute('data-caption-id');
      if (id) anchors.push({ id, offset: rect.top - bounds.top });
    }
    reviewViewport.current = { visibleCount: visible.length, anchors };
  };

  useLayoutEffect(() => {
    const pending = pendingViewportRestore.current;
    const container = list.current;
    if (!container) return;
    if (pending) {
      const row = pending.anchorId ? rows.current[pending.anchorId] : null;
      autoScrollingUntil.current = performance.now() + 180;
      if (row) {
        const currentOffset = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
        container.scrollTop += currentOffset - pending.anchorOffset;
      } else container.scrollTop = pending.fallbackScrollTop;
      pendingViewportRestore.current = null;
    } else if (reviewMode && reviewViewport.current && visible.length < reviewViewport.current.visibleCount) {
      // Approvals remove rows from the Review queue. Anchor a surviving row before
      // the next reveal so repeated decisions don't push the whole list around.
      const bounds = container.getBoundingClientRect();
      const shift = survivingReviewAnchorShift(reviewViewport.current.anchors, (id) => {
        const row = rows.current[id];
        return row ? row.getBoundingClientRect().top - bounds.top : null;
      }, selectedIds[0]);
      if (shift !== null && Math.abs(shift) >= 0.5) {
        autoScrollingUntil.current = performance.now() + 180;
        container.scrollTop = Math.max(0, container.scrollTop + shift);
      }
    }
    const revealId = pendingReviewReveal.current;
    pendingReviewReveal.current = null;
    if (revealId) reveal(revealId, 'smooth', false);
    const nextFocus = pendingReviewActionFocus.current;
    pendingReviewActionFocus.current = null;
    if (nextFocus && (document.activeElement === document.body || !document.activeElement?.isConnected)) {
      rows.current[nextFocus]?.querySelector<HTMLButtonElement>('.row-approve')?.focus({ preventScroll: true });
    }
    snapshotReviewViewport();
    const added = pendingAddFocus.current;
    pendingAddFocus.current = null;
    const activeFocus = document.activeElement;
    const addedText = added ? textareas.current[added.id] : null;
    if (added && selectedIds.length === 1 && selectedIds[0] === added.id
      && (activeFocus === added.from || activeFocus === document.body)
      && !document.querySelector('[aria-modal="true"]')
      && addedText?.isConnected && addedText.getClientRects().length) {
      // The initiating Add action owns this one commit, never a later timer.
      // Newer caption or player focus and selection keep their own destination.
      reveal(added.id, 'smooth', true);
      addedText.focus();
    }
  }, [captions, reviewMode, visible, selectedIds]);

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
      if (nextVisible) {
        pendingReviewReveal.current = nextVisible.id;
        if (rows.current[caption.id]?.contains(document.activeElement)) pendingReviewActionFocus.current = nextVisible.id;
      }
    }
    onChange(
      captions.map((item, itemIndex) => itemIndex === index ? { ...item, approved: approving } : item),
      nextVisible?.id,
      'metadata',
    );
    if (nextVisible) onSeek(nextVisible.startMs);
    else if (reviewMode && approving) onReviewComplete?.();
  };
  const patchTime = (index: number, value: Partial<CaptionSegment>) => {
    const caption = captions[index];
    if (!caption || caption.timingLocked) return false;
    const edge = value.startMs !== undefined ? 'start' : 'end';
    const result = planCaptionTimingEdit(captions, caption.id, edge, value.startMs ?? value.endMs!, mediaLimit, {}, preparedTiming);
    if (result.limited) onNotice?.(result.limitedMessage ? t(result.limitedMessage.key, result.limitedMessage.params) : result.limited);
    if (!result.after.length) return false;
    onChange(captions.map((item) => item.id === caption.id ? result.after[0] : item), caption.id, 'timing');
    return true;
  };
  const patchText = (caption: CaptionSegment, text: string) => {
    if (caption.textLocked || caption.text === text) return;
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
    if (!divided) { onNotice?.(t('editor.captions.tooShortToSplit')); return; }
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
    if (reviewMode && !reviewIncludes(second)) return;
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
    const result = planCaptionTimingEdit(captions, caption.id, 'move', delta, mediaLimit, {}, preparedTiming);
    if (result.limited) onNotice?.(result.limitedMessage ? t(result.limitedMessage.key, result.limitedMessage.params) : result.limited);
    if (result.after.length) {
      onChange(captions.map((item) => item.id === caption.id ? result.after[0] : item), caption.id, 'timing');
      onEditCommit?.();
    }
  };

  const add = (trigger: HTMLButtonElement) => {
    const last = captions.at(-1);
    const startMs = last?.endMs || 0;
    const knownDuration = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0 ? Math.floor(durationMs) : null;
    const endMs = knownDuration === null ? startMs + 1500 : Math.min(startMs + 1500, knownDuration);
    if (endMs - startMs < MIN_CAPTION_MS) {
      onNotice?.(t('editor.captions.noRoom'));
      return;
    }
    const id = crypto.randomUUID();
    const next = [...captions, {
      id,
      startMs,
      endMs,
      text: '',
      timingSource: 'manual' as const,
      timingQuality: 'medium' as const,
      approved: false,
    }];
    setFollowPlayback(false);
    pendingAddFocus.current = { id, from: trigger };
    onChange(next, id, 'structure');
  };

  const toggleFollow = () => {
    const next = !followPlayback;
    setFollowPlayback(next);
    if (next) {
      const target = closestVisibleToPlayhead();
      if (target) reveal(target.id, 'smooth', true);
    }
  };


  // Publish handlers only after a successful commit. Memoized rows dispatch through
  // this stable entry point and always use the latest accepted callbacks and draft.
  const committedRowAction = (id: string, event: CaptionEditorAction): boolean | void => {
      const index = captionIndexMap.get(id);
      const caption = index === undefined ? undefined : captions[index];
      if (!caption) return false;
      switch (event.type) {
        case 'focus':
          // A correction handoff selects the row before starting its excerpt.
          // Keep the recorded caption in place while surrounding speech plays.
          if (event.target === rows.current[id]) { setFollowPlayback(false); return; }
          if (pointerActionFocus.current === event.target) { pointerActionFocus.current = null; return; }
          onSelect(id, false); return;
        case 'click': onSelect(id, event.extend, caption.startMs); return;
        case 'timeFocus': setFollowPlayback(false); return;
        case 'editing': onEditingChange?.(event.editing); return;
        case 'timeCommit': {
          const accepted = patchTime(index!, { [event.edge === 'start' ? 'startMs' : 'endMs']: event.value });
          if (accepted) onEditCommit?.();
          return accepted;
        }
        case 'textFocus':
          focusText.current[id] = caption.text;
          focusTimingBasis.current[id] = caption;
          setFollowPlayback(false); onEditingChange?.(true); return;
        case 'textChange': patchText(caption, event.text); return;
        case 'textBlur':
          onEditingChange?.(false);
          if ((focusText.current[id] ?? caption.text) !== event.text) { onTextCommit(); onEditCommit?.(); }
          delete focusTimingBasis.current[id]; return;
        case 'wordTiming': onWordTiming?.(id); return;
        case 'pointerAction': pointerActionFocus.current = event.button; return;
        case 'actionSelect': onSelect(id, false); return;
        case 'approve': toggleApproval(index!, caption); return;
        case 'openMenu': menuKeyboard.openAt(event.position, id); setOpenMenuId(id); return;
        case 'menuKey': menuKeyboard.onKeyDown(event.event); return;
        case 'menuAction':
          if (event.action === 'words') { setOpenMenuId(null); onWordTiming?.(id); return; }
          if (event.action === 'textLock') patch(index!, { textLocked: !caption.textLocked }, 'metadata');
          else if (event.action === 'timingLock') patch(index!, { timingLocked: !caption.timingLocked }, 'metadata');
          else if (event.action === 'earlier') nudge(index!, -100);
          else if (event.action === 'later') nudge(index!, 100);
          else if (event.action === 'split') split(index!);
          else if (event.action === 'merge') merge(index!);
          else if (event.action === 'remove') remove(index!);
          setOpenMenuId(null); return;
        case 'toggleMenu':
          if (openMenuId === id) event.trigger.focus({ preventScroll: true });
          else menuKeyboard.openAt('first', id);
          setOpenMenuId((current) => current === id ? null : id); return;
      }
  };

  const hasWordTiming = Boolean(onWordTiming);
  // Row objects are unchanged between clock ticks inside one cue. Reuse the
  // complete element list too; live menu/field actions dispatch after commit.
  const renderedRows = useMemo(() => {
    if (typeof window !== 'undefined' && import.meta.env?.DEV) {
      (window as unknown as { __STHANG_TEST_HOOKS__?: { onCaptionListBuild?: (count: number) => void } }).__STHANG_TEST_HOOKS__?.onCaptionListBuild?.(visible.length);
    }
    const reasonLabel = (reason: ReviewReason | undefined) => reason && t(`review.reason.${reason.code}.label`, reason.params);
    return visible.map((caption) => {
        const index = captionIndexMap.get(caption.id) ?? -1;
        const issue = issueMap.get(caption.id);
        const destructiveLocked = caption.textLocked || caption.timingLocked;
        const nextCaption = captions[index + 1];
        const hiddenNeighbor = reviewMode && nextCaption && !reviewIncludes(nextCaption);
        const nextLocked = captions[index + 1]?.textLocked || captions[index + 1]?.timingLocked;
        const mergeHint = hiddenNeighbor ? t('editor.captions.showAllToMerge', { number: index + 2 }) : destructiveLocked && nextLocked ? t('editor.captions.unlockBoth') : destructiveLocked ? t('editor.captions.unlockThis') : nextLocked ? t('editor.captions.unlockNext') : '';
        return <CaptionRow key={caption.id} caption={caption} index={index}
          active={active === caption.id} selected={selected.has(caption.id)} reviewMode={reviewMode}
          lower={neighborLimits.get(caption.id)?.lower ?? 0} upper={neighborLimits.get(caption.id)?.upper ?? durationMs}
          wordNeedsReview={wordsNeedingReview.has(caption.id)}
          issueSeverity={issue?.severity}
          firstReason={reasonLabel(issue?.reasons[0])} secondReason={reasonLabel(issue?.reasons[1])} thirdReason={reasonLabel(issue?.reasons[2])}
          menuOpen={openMenuId === caption.id} registerRow={registerRow} registerText={registerText} dispatch={dispatchRowAction}
          menu={menuPresence.present && menuPresence.value === caption.id && <div ref={actionMenu} className={`caption-action-menu ${menuPlacement.up ? 'menu-up' : ''}`} role="menu" aria-label={t('editor.captions.actions', { number: index + 1 })} onKeyDown={(event) => dispatchRowAction(caption.id, { type: 'menuKey', event })}
              onClickCapture={(event) => {
                if (!(event.target as Element).closest('button:not(:disabled)')) return;
                menuActionTrigger.current = rows.current[caption.id]?.querySelector<HTMLButtonElement>('.row-more') || null;
                menuActionTrigger.current?.focus({ preventScroll: true });
              }}
              data-motion-state={menuPresence.open ? 'open' : 'closed'} inert={!menuPresence.open} aria-hidden={!menuPresence.open || undefined} style={{ maxHeight: menuPlacement.height, overflowY: 'auto' }}>
              {hasWordTiming && <button role="menuitem" onClick={(event) => { event.stopPropagation(); dispatchRowAction(caption.id, { type: 'menuAction', action: 'words' }); }}><Clock3 size={14}/><span>{t('editor.captions.editWordTiming')}</span></button>}
              <button role="menuitem" className={caption.textLocked ? 'state-on' : ''} onClick={(event) => { event.stopPropagation(); dispatchRowAction(caption.id, { type: 'menuAction', action: 'textLock' }); }}><LockKeyhole size={14}/><span>{caption.textLocked ? t('editor.captions.unlockText') : t('editor.captions.lockText')}</span></button>
              <button role="menuitem" className={caption.timingLocked ? 'state-on' : ''} onClick={(event) => { event.stopPropagation(); dispatchRowAction(caption.id, { type: 'menuAction', action: 'timingLock' }); }}><Clock3 size={14}/><span>{caption.timingLocked ? t('editor.captions.unlockTiming') : t('editor.captions.lockTiming')}</span></button>
              <div className="caption-menu-divider"/>
              <button role="menuitem" data-menu-label={t('editor.captions.moveEarlier')} disabled={caption.timingLocked} onClick={(event) => { event.stopPropagation(); dispatchRowAction(caption.id, { type: 'menuAction', action: 'earlier' }); }}><span className="menu-micro">{t('editor.captions.earlierDelta')}</span><span className="caption-action-copy">{t('editor.captions.moveEarlier')}{caption.timingLocked && <small>{t('editor.captions.unlockTimingFirst')}</small>}</span></button>
              <button role="menuitem" data-menu-label={t('editor.captions.moveLater')} disabled={caption.timingLocked} onClick={(event) => { event.stopPropagation(); dispatchRowAction(caption.id, { type: 'menuAction', action: 'later' }); }}><span className="menu-micro">{t('editor.captions.laterDelta')}</span><span className="caption-action-copy">{t('editor.captions.moveLater')}{caption.timingLocked && <small>{t('editor.captions.unlockTimingFirst')}</small>}</span></button>
              <button role="menuitem" disabled={destructiveLocked} onClick={(event) => { event.stopPropagation(); dispatchRowAction(caption.id, { type: 'menuAction', action: 'split' }); }}><Scissors size={14}/><span>{destructiveLocked ? t('editor.captions.unlockBeforeSplit') : t('editor.captions.split')}</span></button>
              {index < captions.length - 1 && <button role="menuitem" data-menu-label={t('editor.captions.merge')} disabled={Boolean(hiddenNeighbor || destructiveLocked || nextLocked)} onClick={(event) => { event.stopPropagation(); dispatchRowAction(caption.id, { type: 'menuAction', action: 'merge' }); }}><Combine size={14}/><span className="caption-action-copy">{t('editor.captions.merge')}{mergeHint && <small>{mergeHint}</small>}</span></button>}
              <div className="caption-menu-divider"/>
              <button role="menuitem" className="danger-action" disabled={destructiveLocked} onClick={(event) => { event.stopPropagation(); dispatchRowAction(caption.id, { type: 'menuAction', action: 'remove' }); }}><Trash2 size={14}/><span>{destructiveLocked ? t('editor.captions.unlockBeforeDelete') : t('editor.captions.delete')}</span></button>
            </div>}
        />;
      });
  }, [captions, visible, captionIndexMap, issueMap, active, selected, reviewMode, neighborLimits, durationMs, wordsNeedingReview,
    openMenuId, menuPresence.present, menuPresence.value, menuPresence.open, menuPlacement.up, menuPlacement.height,
    hasWordTiming, registerRow, registerText, dispatchRowAction, t]);

  return <div className="caption-panel" data-empty={captions.length === 0 || undefined}>
    <div className="panel-head">
      <div className="panel-head-copy">
        <PanelHeaderGrip pane="captions">{reviewMode ? t('editor.captions.reviewQueue') : t('editor.captions.title')}</PanelHeaderGrip>
        <span>{reviewMode ? t('editor.captions.toReview', { count: visible.length }) : tn('editor.captions.count', captions.length)}</span>
      </div>
      <div className="panel-tools">
        <button className="panel-tool" data-tooltip={t('editor.captions.currentTip')} data-tooltip-shortcut="J" onClick={jumpToPlayhead} disabled={!visible.length}><LocateFixed size={15}/><span>{t('editor.captions.current')}</span></button>
        <button className={`panel-tool ${followPlayback ? 'following' : ''}`} aria-pressed={followPlayback} data-tooltip={followPlayback ? t('editor.captions.pauseAutoScroll') : t('editor.captions.followTip')} onClick={toggleFollow} disabled={!visible.length}><ArrowDownToLine size={14}/><span>{t('editor.captions.follow')}</span></button>
        <button ref={addButton} className="panel-tool" aria-label={t('editor.captions.addLabel')} data-tooltip={t('editor.captions.addTip')} onClick={(event) => add(event.currentTarget)}><Plus size={15}/><span>{t('editor.captions.add')}</span></button>
      </div>
    </div>
    <div
      ref={list}
      className="caption-list"
      onWheelCapture={pauseFollowForBrowsing}
      onTouchMove={pauseFollowForBrowsing}
      onScroll={() => { snapshotReviewViewport(); if (performance.now() > autoScrollingUntil.current) pauseFollowForBrowsing(); }}
    >
      {visible.length === 0 && <div className="review-empty">{captions.length ? t('editor.captions.noneToReview') : tr('editor.captions.empty', {}, {})}</div>}
      {renderedRows}
    </div>
  </div>;
});
