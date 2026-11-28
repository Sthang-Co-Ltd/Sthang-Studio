import { expect, test, type Page } from '@playwright/test';
import { openLayoutTools, toolsButton } from './editor-layout-tools.mjs';
import { cleanFixtures, createSyntheticWav, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

const rail = (page: Page) => page.getByRole('navigation', { name: 'Project stages', exact: true });
const stage = (page: Page, name: string) => rail(page).locator(`button[data-stage="${name}"]`);
const strip = (page: Page) => page.getByRole('navigation', { name: 'Caption workspace tools', exact: true });
const inspector = (page: Page) => page.locator('.workspace-inspector');
const closeTool = (page: Page) => page.getByRole('button', { name: 'Close tool', exact: true });

async function expectStage(page: Page, current: string) {
  await expect(rail(page).getByRole('button', { pressed: true })).toHaveCount(1);
  await expect(stage(page, current)).toHaveAttribute('aria-pressed', 'true');
}

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autoLoopReview = false;
  state.profile.preferences.autoPlayNextReview = false;
});

test('the current stage owns the inspector and Captions owns its tools', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openProject(page);
  await expect(rail(page).locator('button > span')).toHaveText(['Captions', 'Review', 'Appearance', 'Export']);
  await expectStage(page, 'captions');
  const exportStage = stage(page, 'export');
  const studioLime = 'rgb(215, 255, 79)';
  await expect(exportStage).toHaveCSS('background-color', studioLime);
  await expect(strip(page).getByRole('button')).toHaveText(['Fine timing', 'Accuracy', 'Caption grouping']);
  await stage(page, 'review').click();
  await expectStage(page, 'review');
  await expect(exportStage).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.review-approve-next')).toHaveCSS('background-color', studioLime);
  await expect(page.getByRole('heading', { name: 'Review panel', exact: true })).toBeVisible();
  await expect(strip(page)).toHaveCount(0);
  await expect((await openLayoutTools(page)).getByRole('menuitem', { name: /^Arrange panels/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toolsButton(page)).toBeFocused();
  await stage(page, 'review').click();
  await expectStage(page, 'review');
  await expect(inspector(page)).toBeVisible();
  await stage(page, 'captions').click();
  await expectStage(page, 'captions');
  await expect(inspector(page)).toBeHidden();
  await expect(strip(page)).toBeVisible();
  await expect(page.locator('.caption-row')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Approve caption and move to the next review item', exact: true })).toHaveCount(0);

  await expect(exportStage).toHaveCSS('background-color', studioLime);
  for (const name of ['Appearance', 'Export']) {
    const trigger = stage(page, name.toLowerCase());
    await trigger.click();
    await expectStage(page, name.toLowerCase());
    await expect(page.getByRole('heading', { name: `${name} panel`, exact: true })).toBeVisible();
    await expect(strip(page)).toHaveCount(0);
    if (name === 'Export') {
      await expect(exportStage).toHaveCSS('background-color', studioLime);
      await expect(exportStage).toHaveCSS('box-shadow', 'rgb(16, 21, 26) 0px 0px 0px 2px inset');
    }
    await closeTool(page).click();
    await expectStage(page, 'captions');
    await expect(inspector(page)).toBeHidden();
    await expect(trigger).toBeFocused();
  }
});

test('Technical details toggles through Tools while Captions stays current', async ({ page }) => {
  await openProject(page);
  const tools = page.getByLabel('Open project tools', { exact: true });
  const details = page.getByRole('menuitem', { name: 'Technical details Timing and model information', exact: true });
  await tools.click();
  await details.click();
  await expect(page.getByRole('heading', { name: 'Technical details panel', exact: true })).toBeVisible();
  await expectStage(page, 'captions');
  await tools.click();
  await details.click();
  await expect(inspector(page)).toBeHidden();
  await expectStage(page, 'captions');
});

test('a new project directs the user to generation', async ({ page }) => {
  state.projects[0].captions = [];
  state.projects[0].transcript = undefined;
  await openProject(page);
  await expectStage(page, 'captions');
  for (const name of ['review', 'appearance', 'export']) await expect(stage(page, name)).toBeDisabled();
  await expect(page.getByText('No captions yet. Use Generate captions to create them from the audio, or Add to write one yourself.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate captions', exact: true })).toBeVisible();
});

test('audio-only projects have three stages', async ({ page }) => {
  state.projects[0].media = { ...state.projects[0].media, filename: 'stages.wav', originalName: 'stages.wav', mimeType: 'audio/wav', url: '/media/stages.wav' };
  await page.route('**/media/stages.wav', (route) => route.fulfill({ contentType: 'audio/wav', body: createSyntheticWav(4, 440) }));
  await page.goto('/');
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(page.locator('.media-stage audio')).toBeVisible();
  await expect(rail(page).locator('button > span')).toHaveText(['Captions', 'Review', 'Export']);
  await expectStage(page, 'captions');
});

for (const width of [1440, 1200, 900, 620, 390, 320]) {
  test(`stage labels, layout and touch targets fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width > 1200 ? 900 : width === 1200 ? 800 : 844 });
    if (width === 1200) {
      state.projects[0].title = 'Audit landscape ' + 'Long project name '.repeat(15);
      state.projects[0].media.originalName = 'Representative long original media filename '.repeat(10) + '.mp4';
    }
    await openProject(page);
    await page.evaluate(() => document.fonts.ready);
    const boxes = await rail(page).getByRole('button').evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      const label = button.querySelector('span')!;
      const labelRect = label.getBoundingClientRect();
      return {
        x: rect.x, y: rect.y, right: rect.right, height: rect.height, fontSize: getComputedStyle(label).fontSize,
        fits: button.scrollWidth <= button.clientWidth && label.scrollWidth <= label.clientWidth && labelRect.left >= rect.left && labelRect.right <= rect.right,
        iconVisible: getComputedStyle(button.querySelector('svg')!).display !== 'none',
      };
    }));
    expect(boxes).toHaveLength(4);
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
      expect(box.fits).toBe(true);
      expect(box.fontSize).toBe('13px');
      expect(box.iconVisible).toBe(width > 620);
      expect(box.height).toBeGreaterThanOrEqual(width <= 620 ? 44 : 36);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1200) {
      const header = page.locator('main.workspace > header');
      await expect(header).toHaveCSS('height', '68px');
      const bounds = (await header.boundingBox())!;
      for (const target of [header.locator('.back'), header.locator('.workspace-identity'), rail(page), header.locator('summary'), header.locator('.save-action')]) {
        const box = (await target.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(bounds.y);
        expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
    }
    if (width === 320) {
      expect(boxes[0].y).toBe(boxes[1].y);
      expect(boxes[2].y).toBe(boxes[3].y);
      expect(boxes[2].y).toBeGreaterThan(boxes[0].y);
      expect(boxes[0].x).toBe(boxes[2].x);
      expect(boxes[1].x).toBe(boxes[3].x);
    }
    if (width === 1440 || width === 390) {
      const captureStage = async (name: string) => {
        await page.mouse.move(0, 0);
        await page.waitForFunction(() => {
          const video = document.querySelector('video');
          return video && video.readyState >= 2 && !video.seeking;
        });
        await page.screenshot({ path: `.codex-tmp/wave2a/${width}-${name}.png`, animations: 'disabled' });
      };
      await captureStage('captions');
      await stage(page, 'review').click();
      await expectStage(page, 'review');
      await expect(page.getByRole('heading', { name: 'Review panel', exact: true })).toBeInViewport();
      if (width === 390) await expect(page.locator('.editor-toolbar')).toBeHidden();
      await captureStage('review');
      await stage(page, 'export').click();
      await expectStage(page, 'export');
      await expect(page.getByRole('heading', { name: 'Export panel', exact: true })).toBeInViewport();
      await expect(page.getByRole('button', { name: /^Captions file/ })).toBeVisible();
      await captureStage('export');
    }
  });
}

test('Review completion focuses its heading, then Show all captions returns focus to the rail', async ({ page }) => {
  state.projects[0].captions.forEach((caption, index) => {
    caption.text = ['សួស្តី', 'អរគុណ', 'កម្ពុជា'][index];
    caption.timingQuality = index === 0 ? 'low' : 'high';
  });
  await openProject(page);
  await stage(page, 'review').click();
  await page.getByRole('button', { name: 'Approve & next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'All flagged captions reviewed', exact: true })).toBeFocused();
  await page.getByRole('region', { name: 'All flagged captions reviewed', exact: true })
    .getByRole('button', { name: 'Show all captions', exact: true }).click();
  await expect(inspector(page)).toBeHidden();
  await expectStage(page, 'captions');
  await expect(stage(page, 'review')).toBeFocused();
});
