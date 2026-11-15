import { expect, type Locator, type Page } from '@playwright/test';

async function reachable(control: Locator, mobile: boolean, action: boolean) {
  await expect.poll(() => control.evaluate((node, { mobile, action }) => {
    const rect = node.getBoundingClientRect();
    const stack = node.closest('.toast-stack');
    const port = stack?.getBoundingClientRect();
    const top = Math.max(0, port?.top ?? 0); const bottom = Math.min(innerHeight, port?.bottom ?? innerHeight);
    const points = [[rect.left + 4, rect.top + 4], [rect.right - 4, rect.top + 4],
      [rect.left + rect.width / 2, rect.top + rect.height / 2], [rect.left + 4, rect.bottom - 4], [rect.right - 4, rect.bottom - 4]];
    return rect.width > 0 && rect.height >= (action && mobile ? 44 : 1)
      && rect.top >= top && rect.bottom <= bottom + 1 && rect.left >= 0 && rect.right <= innerWidth + 1
      && points.every(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit === node || Boolean(hit && node.contains(hit)); });
  }, { mobile, action }), { timeout: 8000 }).toBe(true);
}

/** The recovery card may scroll inside its reserved footer. Prove the actual
 * reading area and keyboard destinations are usable rather than requiring all
 * expanded content to fit at once or manually revealing every action. */
export async function expectRecoveryOfferReachable(page: Page, notice: Locator, width: number, expectedPreview: Locator) {
  const mobile = width === 390;
  const stack = page.locator('.workspace > .toast-stack');
  await expect.poll(() => stack.evaluate((node, mobile) => {
    const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight + 1
      && rect.left >= 0 && rect.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth
      && (!mobile || rect.height <= Math.min(innerHeight * .3, 260) + 1 && style.position === 'static' && style.overflowY === 'auto');
  }, mobile), { timeout: 8000 }).toBe(true);
  const summary = notice.locator('details > summary');
  await summary.focus(); await expect(summary).toBeFocused(); await reachable(summary, mobile, true);
  if (await notice.locator('details').getAttribute('open') === null) await summary.press('Enter');
  await expect(notice.locator('details')).toHaveAttribute('open', '');
  await expect(expectedPreview).toBeVisible();
  const preview = notice.locator('.unfinished-recovery-preview');
  await preview.scrollIntoViewIfNeeded(); await reachable(preview, mobile, false);
  // Native Tab must reveal each action in the scrollport and preserve its order.
  await summary.focus();
  for (const name of ['Restore draft', 'Download draft', 'Discard draft']) {
    const control = notice.getByRole('button', { name, exact: true });
    await page.keyboard.press('Tab'); await expect(control).toBeFocused(); await expect(control).toBeEnabled();
    await reachable(control, mobile, true);
  }
  const caption = page.getByLabel('Caption 1 text', { exact: true });
  await caption.focus(); await expect(caption).toBeFocused(); await reachable(caption, mobile, true);
  const restore = notice.getByRole('button', { name: 'Restore draft', exact: true });
  await restore.focus(); await expect(restore).toBeFocused(); await reachable(restore, mobile, true);
}
