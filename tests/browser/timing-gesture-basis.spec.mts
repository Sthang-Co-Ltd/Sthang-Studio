import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

for (const variant of ['neighbor', 'shared-third', 'same-value'] as const) test('a held timing drag handles a delayed ' + variant + ' History acknowledgement', async ({ page }) => {
  const state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  const intervals = [[1000, 1500], [2000, 2500], [2800, 3500]];
  state.projects[0].captions = state.projects[0].captions.map((caption, index) => ({
    ...caption, startMs: intervals[index][0], endMs: intervals[index][1],
    wordTiming: { version: 1, text: caption.text, words: [{ id: `owned-${index}`, startOffset: 0, endOffset: caption.text.length,
      startMs: intervals[index][0] + 50, endMs: intervals[index][1] - 50, source: 'manual' }] },
  }));
  const gate = deferred(); const started = deferred(); const returned = deferred();
  const checkpoint = { id: 'drag-basis', projectId: 'landscape', label: 'Timing basis checkpoint', source: 'manual-save',
    createdAt: '2026-01-01T00:00:00.000Z', captionCount: 3, approvedCount: 0, textLockedCount: 0, timingLockedCount: 0 };
  await page.route('**/api/projects/landscape/history', (route) => route.fulfill({ json: [checkpoint] }));
  await page.route('**/api/projects/landscape/history/drag-basis/restore', async (route) => {
    const restored = structuredClone(state.projects[0]);
    if (variant === 'neighbor') restored.captions[1].startMs = 1700;
    if (variant === 'shared-third') {
      restored.captions[2].startMs = 1600; restored.captions[2].endMs = 1800;
      // Keep this third cue's owned track inside its newly restored outer edges.
      restored.captions[2].wordTiming!.words[0].startMs = 1650;
      restored.captions[2].wordTiming!.words[0].endMs = 1750;
    }
    restored.updatedAt = new Date(Date.parse(restored.updatedAt) + 1000).toISOString();
    state.projects[0] = structuredClone(restored);
    started.release();
    await gate.promise;
    try { await route.fulfill({ json: restored }); } finally { returned.release(); }
  });
  let pointerHeld = false;
  try {
    await openProject(page);
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /^History/ }).click();
    const history = page.getByRole('dialog', { name: 'Project history', exact: true });
    await history.getByRole('button', { name: /^Restore Timing basis checkpoint saved / }).click();
    await page.getByRole('button', { name: 'Restore checkpoint', exact: true }).click();
    await started.promise;
    await history.getByRole('button', { name: 'Close history', exact: true }).click();
    await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
    await expect(page.locator('.waveform-loading')).toHaveCount(0);
    await expect(page.getByLabel('Fine timing end', { exact: true })).toHaveValue('00:01.500');
    await page.locator('.timing-options > summary').click();
    await page.getByLabel('Boundary snapping', { exact: true }).selectOption('off');
    if (variant === 'shared-third') await page.getByLabel('Move adjoining edge too', { exact: true }).check();
    const canvas = page.locator('.waveform-data-canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = (await canvas.boundingBox())!;
    const x = (timeMs: number) => box.x + timeMs / 2500 * box.width;
    await page.mouse.move(x(1500), box.y + 158); await page.mouse.down(); pointerHeld = true;
    await page.mouse.move(x(1900), box.y + 158, { steps: 8 });
    await expect(page.getByLabel('Fine timing end', { exact: true })).toHaveValue('00:01.900');
    const writes = state.requests.filter((request) => request.path.endsWith('/captions')).length;
    expect(writes).toBe(0);
    await page.evaluate(() => { (window as any).__dragBasisEvidence = [document.querySelector('video'), document.querySelector('.caption-list')]; });
    gate.release(); await returned.promise;
    if (variant === 'same-value') {
      await expect(page.locator('.toast.notice')).toContainText('Earlier project version restored.');
      await expect(page.getByLabel('Fine timing end', { exact: true })).toHaveValue('00:01.900');
    } else {
      await expect(page.locator('.toast.notice')).toContainText('Caption timing changed during this drag.');
      await expect(page.getByLabel('Fine timing end', { exact: true })).toHaveValue('00:01.500');
      await expect(page.locator('.waveform-canvas-wrap')).not.toHaveClass(/dragging/);
    }
    await page.mouse.up(); pointerHeld = false;
    if (variant === 'same-value') {
      await expect(page.getByLabel('Fine timing end', { exact: true })).toHaveValue('00:01.900');
      const save = page.locator('.save-action'); await save.click();
      await expect(save.locator('.save-action-label')).toHaveText('Saved');
      expect(state.projects[0].captions[0].endMs).toBe(1900);
    } else {
      await expect(page.getByLabel('Fine timing end', { exact: true })).toHaveValue('00:01.500');
      expect(state.requests.filter((request) => request.path.endsWith('/captions'))).toHaveLength(writes);
      expect(state.projects[0].captions[0].endMs).toBe(1500);
      expect(state.projects[0].captions[variant === 'neighbor' ? 1 : 2].startMs).toBe(variant === 'neighbor' ? 1700 : 1600);
    }
    expect(await page.evaluate(() => (window as any).__dragBasisEvidence.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  } finally {
    gate.release();
    if (pointerHeld) await page.mouse.up();
  }
});
