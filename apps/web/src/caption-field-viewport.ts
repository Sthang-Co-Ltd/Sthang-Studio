const preservedFocus = new WeakSet<HTMLElement>();

/** A notice return must keep the caller's explicit non-scrolling focus contract. */
export function focusPreservingCaptionViewport(target: HTMLElement) {
  preservedFocus.add(target);
  try { target.focus({ preventScroll: true }); }
  finally { preservedFocus.delete(target); }
}

export const isFocusPreservingCaptionViewport = (target: HTMLElement) => preservedFocus.has(target);

/** Effective caption viewport, including the narrow layout's sticky evidence. */
export function captionFieldViewport(field: HTMLElement, list: HTMLElement, workbench: HTMLElement) {
  const box = field.getBoundingClientRect();
  const listBox = list.getBoundingClientRect();
  const port = workbench.getBoundingClientRect();
  const visual = window.visualViewport;
  let top = Math.max(visual?.offsetTop ?? 0, listBox.top, port.top + workbench.clientTop);
  const bottom = Math.min(visual ? visual.offsetTop + visual.height : window.innerHeight,
    listBox.bottom, port.top + workbench.clientTop + workbench.clientHeight);
  for (const overlay of [workbench.querySelector<HTMLElement>('.editor-toolbar'), workbench.querySelector<HTMLElement>('.stage-column')]) {
    if (!overlay || getComputedStyle(overlay).position !== 'sticky') continue;
    const bounds = overlay.getBoundingClientRect();
    if (bounds.left < box.right && bounds.right > box.left) top = Math.max(top, bounds.bottom);
  }
  return { box, listBox, top, bottom };
}

/** Finish an owned focus reveal without moving the caption list or its Follow state. */
export function revealFocusedCaptionField(field: HTMLElement, list: HTMLElement, workbench: HTMLElement) {
  if (document.activeElement !== field || !field.isConnected || !workbench.isConnected
    || field.closest('.caption-list') !== list || !workbench.contains(field)
    || !/auto|scroll/.test(getComputedStyle(workbench).overflowY)) return;
  const { box, listBox, top, bottom } = captionFieldViewport(field, list, workbench);
  // Native scrolling rounds to pixels; a fractional border overlap must not
  // prevent revealing a field that is already inside the list.
  if (bottom <= top || box.top < listBox.top - 1 || box.bottom > listBox.bottom + 1) return;
  const shift = box.bottom > bottom ? box.bottom - bottom + 8 : box.top < top ? box.top - top - 8 : 0;
  if (shift) workbench.scrollBy({ top: shift, behavior: 'instant' });
}
