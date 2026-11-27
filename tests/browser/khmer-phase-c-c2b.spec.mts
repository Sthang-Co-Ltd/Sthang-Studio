import { expect, test as base } from '@playwright/test';
import { translate } from '../../apps/web/src/i18n/translate.js';
import { cleanFixtures, installFixture, prepareFixtures, seek } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    try { await use(context); } finally { await closeOwnedBrowserContext(context); }
  },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

test('Khmer media preparation uses catalog messages and marks server errors', async ({ page }) => {
  const fixture = await installFixture(page);
  fixture.profile.preferences.interfaceLanguage = 'km';
  const captionError = 'Synthetic saved-font detail.';
  const playbackStatusError = 'Synthetic playback status detail.';
  const playbackError = 'Synthetic playback availability detail.';
  const source = fixture.projects[0].media.filename;
  let failPlayback = false;
  let releasePreview!: () => void;
  const previewPending = new Promise<void>((resolve) => { releasePreview = resolve; });
  fixture.previewHold = () => previewPending;
  fixture.previewError = captionError;

  await page.route('**/api/media-preview/landscape*', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 409, json: { error: playbackError } });
    }
    return route.fulfill({ json: { source, state: failPlayback ? 'failed' : 'processing', videoCodec: 'h264',
      progress: 32.5, ...(failPlayback ? { message: playbackStatusError } : {}) } });
  });

  try {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'km');
    await page.locator('[data-recent-project="landscape"]').click();
    await expect(page.locator('.media-stage video')).toBeVisible();
    await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1);
    await seek(page, 500);

    const sourceStatus = page.locator('.source-media-status[role="status"]');
    const captionStatus = page.locator('.native-preview-status[role="status"]');
    await expect(sourceStatus.locator('span:not([data-server-text])'))
      .toHaveText(translate('km', 'media.playback.preparingProgress', { progress: 32.5 }));
    await expect(captionStatus.locator('span:not([data-server-text])'))
      .toHaveText(translate('km', 'media.caption.preparing'));

    failPlayback = true;
    releasePreview();
    await expect(captionStatus.locator('span[data-server-text]')).toHaveText(captionError);
    await expect(sourceStatus.locator('span[data-server-text]')).toHaveText(playbackStatusError);
    const request = page.waitForRequest((candidate) =>
      candidate.method() === 'POST' && new URL(candidate.url()).pathname === '/api/media-preview/landscape');
    await sourceStatus.getByRole('button').click();
    await request;
    await expect(sourceStatus.locator('span[data-server-text]')).toHaveText(playbackError);
  } finally {
    releasePreview();
  }
});
