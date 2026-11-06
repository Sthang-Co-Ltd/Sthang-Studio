/** Keep clipboard fallback inside the active dialog and restore the user's focus. */
export async function copyReportText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* Older/restricted browsers may still allow an explicit copy command. */ }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = previous instanceof HTMLInputElement || previous instanceof HTMLTextAreaElement ? previous : null;
  const selection = field ? { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection } : null;
  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.tabIndex = -1;
  fallback.setAttribute('aria-hidden', 'true');
  Object.assign(fallback.style, { position: 'fixed', opacity: '0', width: '1px', height: '1px', pointerEvents: 'none' });
  (previous?.closest('[role="dialog"], [role="alertdialog"]') || document.body).appendChild(fallback);
  try {
    fallback.select();
    if (!document.execCommand('copy')) throw new Error('Copy unavailable');
  } finally {
    fallback.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    if (field?.isConnected && selection?.start != null && selection.end != null) {
      field.setSelectionRange(selection.start, selection.end, selection.direction || undefined);
    }
  }
}
