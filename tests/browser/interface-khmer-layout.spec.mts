import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import type { CaptionProject } from '@kcs/shared';
import { km } from '../../apps/web/src/i18n/messages/km/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const viewports = [{ width: 1440, height: 900 }, { width: 1200, height: 800 },
  { width: 1280, height: 720 }, { width: 390, height: 844 }];
const evidence = path.resolve('.codex-tmp/wave3a3');
const latinWords = /\p{Script=Latin}{3,}/gu;
type Catalog = { readonly [key: string]: string | Catalog };

function catalogValues(catalog: Catalog): string[] {
  return Object.values(catalog).flatMap((value) => typeof value === 'string' ? [value] : catalogValues(value));
}

function approvedWords(projects: CaptionProject[]) {
  const content = projects.flatMap(({ title, media, captions }) =>
    [title, media.filename, media.originalName, ...captions.map(({ text }) => text)]);
  const words = (values: string[]) => [...new Set(values.flatMap((value) => value.match(latinWords) ?? []))].sort();
  return {
    // Markup and placeholder names do not appear in the rendered copy.
    catalog: words(catalogValues(km).map((value) => value.replace(/<\/?(?:b|code)>|\{[a-zA-Z][a-zA-Z0-9_]*\}/g, ' '))),
    content: words(content), // Fixture-only project titles, filenames and captions.
    brand: ['Sthang', 'Studio', 'STHANG', 'STUDIO'], // Approved identity.
  };
}

async function capture(page: Page, surface: string, regions: string, projects: CaptionProject[]) {
  const size = page.viewportSize()!;
  const folder = path.join(evidence, `${size.width}x${size.height}`);
  await mkdir(folder, { recursive: true });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const approved = approvedWords(projects);
  const result = await page.evaluate(({ regions, approved, latinPattern }) => {
    // Native language names, server-supplied storage/key text, and deferred generation options.
    const exempt = '.interface-language-switch button[lang="en"], .interface-language-switch button[lang="km"], [data-server-text], .generation-options';
    const allow = new Set(Object.values(approved).flat());
    const words = new RegExp(latinPattern, 'gu');
    const controls = 'button, summary, a[href], [role="menuitem"], label, h1, h2, h3, h4, ' +
      '.risk-reasons > span, .caption-state-line > span, .first-run-step-header > small, ' +
      '.generation-accuracy-copy small, .workspace-tools-popover em, .stage-rail .tool-badge';
    const visible = (element: Element) => element.checkVisibility({ visibilityProperty: true }) && element.getClientRects().length > 0;
    const describe = (element: Element) => `${element.tagName.toLowerCase()}${Array.from(element.classList).map((name) => `.${name}`).join('')}`;
    const checked = new Set<Element>();
    const observedText = new Set<Node>();
    const elements = [];
    const captionFields = [];
    const untranslated = [];
    const checkedRegions = [];
    for (const region of document.querySelectorAll(regions)) {
      if (!visible(region)) continue;
      checkedRegions.push(describe(region));
      for (const field of region.querySelectorAll('.caption-text-cell textarea')) {
        if (!visible(field)) continue;
        const rect = field.getBoundingClientRect();
        const cell = field.parentElement!.getBoundingClientRect();
        captionFields.push({ label: field.getAttribute('aria-label'), width: rect.width, cellWidth: cell.width, right: rect.right, cellRight: cell.right });
      }
      for (const element of [region, ...region.querySelectorAll(controls)]) {
        if (!element.matches(controls) || checked.has(element) || !visible(element)) continue;
        checked.add(element);
        const rect = element.getBoundingClientRect();
        const css = getComputedStyle(element);
        elements.push({ element: describe(element), label: element.getAttribute('aria-label') || element.textContent?.trim(),
          target: element.matches('button, summary, a[href], [role="menuitem"]'),
          width: rect.width, height: rect.height, left: rect.left, right: rect.right,
          clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, overflowX: css.overflowX,
          clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, overflowY: css.overflowY });
      }
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        const value = node.textContent?.trim();
        if (!value || !parent || observedText.has(node) || parent.closest(exempt) || !visible(parent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (!range.getClientRects().length) continue;
        observedText.add(node);
        const unknown = [...new Set((value.match(words) ?? []).filter((word) => !allow.has(word)))];
        if (unknown.length) untranslated.push({ element: describe(parent), text: value, words: unknown });
      }
    }
    return { pageWidth: innerWidth, pageScrollWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
      checkedRegions, elements, captionFields, untranslated };
  }, { regions, approved, latinPattern: latinWords.source });
  await writeFile(path.join(folder, `${surface}.json`), JSON.stringify({ ...result, approved }, null, 2));
  await page.screenshot({ path: path.join(folder, `${surface}.png`), animations: 'disabled', fullPage: surface.startsWith('home-') });
  expect.soft(result.checkedRegions.length, `${surface}: Phase A regions present`).toBeGreaterThan(0);
  expect.soft(result.pageScrollWidth, `${surface}: horizontal page scroll`).toBeLessThanOrEqual(result.pageWidth);
  const clipped = result.elements.filter(({ target, clientWidth, scrollWidth, clientHeight, scrollHeight, overflowX, overflowY }) =>
    ((target || overflowX !== 'visible') && scrollWidth > clientWidth + 1)
    || ((target || overflowY !== 'visible') && scrollHeight > clientHeight + 1));
  expect.soft(clipped, `${surface}: clipped controls and labels`).toEqual([]);
  expect.soft(result.captionFields.filter(({ right, cellRight }) => right > cellRight + 1),
    `${surface}: caption fields extending into row actions`).toEqual([]);
  if (size.width === 390) {
    expect.soft(result.elements.filter(({ target, width, height }) => target && (width < 44 || height < 44)),
      `${surface}: targets under 44px`).toEqual([]);
  }
  expect.soft(result.untranslated, `${surface}: untranslated text`).toEqual([]);
}

const homeRegions = '.home-tools, .empty-stage h1, .empty-stage .lead, .dropzone, .first-run-card, .home-ready-strip, .recent';
const projectHeader = 'main.workspace > header';

for (const viewport of viewports) {
  const dimensions = `${viewport.width}x${viewport.height}`;
  test(`Khmer Home, setup and Settings AI fit at ${dimensions}`, async ({ page }) => {
    const state = await installFixture(page);
    state.profile.preferences.interfaceLanguage = 'km';
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    let configured = false;
    let timingReady = false;
    await page.addInitScript(() => {
      const getItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (this === localStorage && key === 'sthang:first-run-dismissed:v1') return null;
        return getItem.call(this, key);
      };
    });
    const settings = () => ({ provider: 'gemini', configured, keySource: configured ? 'secure-store' : 'none',
      maskedKey: configured ? 'Synthetic •••• masked' : null, model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.6-flash',
      secureStorageAvailable: true, secureStorageLabel: 'Synthetic secure storage', environmentFallbackAvailable: false,
      canForgetSecureKey: configured, updatedAt: null });
    await page.route('**/api/system/llm-settings', (route) => route.request().method() === 'GET'
      ? route.fulfill({ json: settings() }) : route.fallback());
    await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, engineVersion: 'test', llm: settings(),
      timing: { configured: timingReady, engine: 'kfa-local', model: 'synthetic', provider: 'local', device: 'cpu', language: 'km', paidApi: false } } }));
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'km');
    await expect(page.locator('.first-run-ai')).toBeVisible();
    await expect(page.locator('.first-run-steps li')).toHaveCount(3);
    await capture(page, 'home-setup-incomplete', homeRegions, state.projects);

    configured = true;
    await page.reload();
    await expect(page.locator('.first-run-timing-status')).toBeVisible();
    await capture(page, 'home-setup-ai-ready', homeRegions, state.projects);

    timingReady = true;
    await page.reload();
    await expect(page.locator('.home-ready-strip')).toBeVisible();
    await capture(page, 'home-ready', homeRegions, state.projects);

    await page.getByRole('button', { name: km.home.launcher.settings, exact: true }).click();
    const ai = page.locator('.ai-settings-body');
    await expect(ai).toBeVisible();
    await expect(ai.locator('[data-server-text]')).toHaveCount(2);
    await expect(ai.locator('.ai-model-grid')).toBeVisible();
    await capture(page, 'settings-ai', '.ai-settings-body', state.projects);
  });

  test(`Khmer editor, Review, Generate and first-watch fit at ${dimensions}`, async ({ page }) => {
    test.setTimeout(60_000);
    const state = await installFixture(page);
    state.profile.preferences.interfaceLanguage = 'km';
    state.profile.preferences.autosaveDelayMs = 60_000;
    state.projects[0].captions[0].endMs = 520; // Estimated timing plus a short display duration.
    state.projects[0].captions[0].text = 'កម្ពុជា';
    const result = structuredClone(state.projects[1]);
    state.projects[1].captions = [];
    state.projects[1].transcript = null;
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openProject(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'km');
    const firstRow = page.locator('.caption-row').first();
    await firstRow.locator('.row-index').click();
    await expect(firstRow.locator('.risk-reasons.expanded > span').nth(1)).toBeVisible();
    const rail = page.locator('.stage-rail');
    await expect(rail.locator('button')).toHaveCount(4);
    const verifyRail = async (width: number) => {
      const rows = await rail.locator('button').evaluateAll((buttons) => buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        const label = button.querySelector('span')!;
        const range = document.createRange();
        range.selectNodeContents(label);
        const labelRect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y, right: rect.right, height: rect.height,
          icon: getComputedStyle(button.querySelector('svg')!).display !== 'none',
          fits: label.scrollWidth <= label.clientWidth + 1 && labelRect.left >= rect.left && labelRect.right <= rect.right };
      }));
      for (const row of rows) {
        expect.soft(row.x, 'rail begins inside the viewport').toBeGreaterThanOrEqual(0);
        expect.soft(row.right, 'rail ends inside the viewport').toBeLessThanOrEqual(width);
        expect.soft(row.fits, 'rail label fits its button').toBe(true);
        expect.soft(row.icon, 'rail shows icons above 620px').toBe(width > 620);
        expect.soft(row.height, 'rail target height').toBeGreaterThanOrEqual(width <= 620 ? 44 : 36);
      }
      if (width <= 380) expect.soft(rows.map(({ y }) => y)).toEqual([rows[0].y, rows[0].y, rows[2].y, rows[2].y]);
      if (width <= 380) expect.soft(rows[2].y).toBeGreaterThan(rows[0].y);
    };
    await verifyRail(viewport.width);
    const save = page.locator('.save-action');
    const saveLabel = save.locator('.save-action-label');
    await capture(page, 'caption-list', '.caption-panel', state.projects);
    const edited = `${state.projects[0].captions[0].text}!`;
    await firstRow.locator('textarea').fill(edited);
    await expect(saveLabel).toHaveText(km.editor.save.save);
    const saveWidth = (await save.boundingBox())!.width;
    await capture(page, 'editor-save', projectHeader, state.projects);

    await save.press('Enter');
    await expect(saveLabel).toHaveText(km.editor.save.saved);
    expect.soft((await save.boundingBox())!.width, 'Save and Saved width').toBe(saveWidth);
    await capture(page, 'editor-saved', projectHeader, state.projects);

    const tools = page.locator('[data-project-tools-trigger]');
    await tools.click();
    const menu = page.getByRole('menu', { name: km.editor.tools.menu });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveCount(viewport.width >= 1200 ? 11 : 10);
    await capture(page, 'tools', '.workspace-tools-popover', state.projects);
    if (viewport.height === 720) {
      const geometry = await menu.evaluate((node) => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }));
      await writeFile(path.join(evidence, dimensions, 'tools-height.json'), JSON.stringify(geometry));
      expect.soft(geometry.scrollHeight, 'Tools internal scroll at 1280x720').toBeLessThanOrEqual(geometry.clientHeight + 1);
      for (const item of await menu.getByRole('menuitem').all()) await expect.soft(item).toBeInViewport({ ratio: 1 });
    }
    await page.keyboard.press('Escape');

    await page.locator('.project-name-button').click();
    const details = page.locator('.project-name-dialog');
    await expect(details).toBeVisible();
    await capture(page, 'project-details', '.project-name-dialog', state.projects);
    await details.getByRole('button', { name: km.editor.identity.rename, exact: true }).click();
    await expect(details.locator('.project-rename-form')).toBeVisible();
    await capture(page, 'project-rename', '.project-name-dialog', state.projects);
    await details.getByRole('button', { name: km.editor.rename.cancel, exact: true }).click();
    await details.getByRole('button', { name: km.editor.identity.close, exact: true }).click();

    await rail.locator('[data-stage="review"]').click();
    const review = page.locator('.review-card');
    const reasons = review.locator('.review-reasons > li');
    await expect(reasons).toHaveCount(2);
    const approve = review.getByRole('button', { name: km.review.card.approveNext, exact: true });
    await expect(review.locator('.review-decision-actions')).toHaveCSS('position', 'sticky');
    if (viewport.width === 390) await expect.soft(approve).toBeInViewport({ ratio: 1 });
    await capture(page, 'review-reasons', '.review-card, .caption-panel', state.projects);
    const caption = state.projects[0].captions[1];
    const phrase = `${caption.text} `;
    const longText = phrase.repeat(Math.ceil(600 / phrase.length)).slice(0, 600);
    await firstRow.locator('textarea').fill(longText);
    await expect(review.locator('.review-caption-text')).toHaveText(longText, { useInnerText: false });
    await capture(page, 'review-long-caption', '.review-card, .caption-panel', state.projects);

    const job = { id: 'layout-first-watch', type: 'transcribe', projectId: result.id, projectTitle: result.title,
      status: 'running', stage: 'alignment', progress: 52, message: 'Synthetic job running', canResume: false,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' } as const;
    await openProject(page, 'second');
    await expect(page.locator('.transcribe-card')).toBeVisible();
    await capture(page, 'generate', '.transcribe-card', state.projects);
    const publishJobs = async () => {
      const response = page.waitForResponse((item) => item.url().endsWith('/api/jobs') && item.request().method() === 'GET');
      await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
      await (await response).finished();
    };
    state.jobs.push(job);
    await publishJobs();
    await expect(page.locator('.transcribe-card')).toContainText(km.editor.generation.busy);
    state.projects[1] = result;
    state.jobs[0] = { ...job, status: 'completed', stage: 'complete', progress: 100, message: 'Synthetic job complete',
      resultProjectId: result.id, updatedAt: '2026-01-01T00:00:02.000Z', completedAt: '2026-01-01T00:00:02.000Z' };
    await publishJobs();
    await expect(page.locator('.first-watch')).toBeVisible();
    await capture(page, 'first-watch', '.first-watch', state.projects);

    if (viewport.width === 390) {
      await page.setViewportSize({ ...viewport, width: 380 });
      await verifyRail(380);
    }
  });
}
