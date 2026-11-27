import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { RegenerationProposal } from '@kcs/shared';
import { cleanFixtures, createSyntheticWav, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { openLayoutTools, openPanelArrangement, resetEditorLayout, toolsButton } from './editor-layout-tools.mjs';

const evidence = path.resolve('.codex-tmp/wave2b2');
const arrangementEvidence = path.resolve('.codex-tmp/wave2b-tools');
const stage = (page: Page, name: string) => page.locator(`.stage-rail button[data-stage="${name}"]`);
const mediaBox = (page: Page) => page.locator('.media-stage');
const toolbar = (page: Page) => page.locator('.editor-toolbar');
const enlarge = (page: Page) => page.getByRole('button', { name: 'Enlarge preview', exact: true });
const editOrder = ['preview', 'captions', 'inspector'];
const judgeOrder = ['preview', 'inspector', 'captions'];
const layoutKey = 'sthang:editor-layout:v2';
let state: FixtureState;
let portrait: Buffer;

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
test.beforeAll(async () => {
  await prepareFixtures();
  const file = path.join(process.env.STHANG_STUDIO_STATE_ROOT!, 'layout-mode-portrait.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=0x304035:s=360x640:r=25:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
  ], { windowsHide: true, timeout: 30_000 });
  portrait = await fs.readFile(file);
});
test.afterAll(cleanFixtures);
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

async function usePortrait(page: Page) {
  await page.route('**/media/landscape.mp4', (route) => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
    if (!range) return route.fulfill({ status: 200, contentType: 'video/mp4', body: portrait });
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : portrait.length - 1, portrait.length - 1);
    return route.fulfill({
      status: 206, contentType: 'video/mp4', body: portrait.subarray(start, end + 1),
      headers: { 'Content-Range': `bytes ${start}-${end}/${portrait.length}`, 'Accept-Ranges': 'bytes' },
    });
  });
}

const paneBounds = (page: Page) => page.locator('.refined-editor').evaluate((grid) => {
  const bounds = (selector: string) => {
    const { x, width } = grid.querySelector(selector)!.getBoundingClientRect();
    return { x, width };
  };
  return {
    preview: bounds('.stage-column'),
    captions: bounds('.caption-panel'),
    inspector: bounds('.workspace-inspector'),
  };
});
const visualOrder = async (page: Page) => Object.entries(await paneBounds(page))
  .sort(([, a], [, b]) => a.x - b.x).map(([pane]) => pane);
const saved = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), layoutKey);

async function rememberNodes(page: Page) {
  await page.evaluate(() => {
    const nodes = [document.querySelector('video')!, document.querySelector('.caption-list')!];
    Object.assign(window, { layoutModeNodes: nodes, layoutModeParents: nodes.map((node) => node.parentElement) });
  });
}

async function expectSameNodes(page: Page) {
  expect(await page.evaluate(() => {
    const { layoutModeNodes, layoutModeParents } = window as unknown as { layoutModeNodes: Element[]; layoutModeParents: Element[] };
    return ['video', '.caption-list'].every((selector, i) =>
      document.querySelector(selector) === layoutModeNodes[i] && layoutModeNodes[i].parentElement === layoutModeParents[i]);
  })).toBe(true);
}

async function installProposal(page: Page) {
  const current = structuredClone(state.projects[0].captions[0]);
  const proposed = { ...current, id: 'layout-proposed-caption', text: 'Proposed wording' };
  const proposal: RegenerationProposal = {
    id: 'layout-proposal', projectId: 'landscape', projectTitle: 'Audit landscape',
    createdAt: '2026-01-01', expiresAt: '2099-01-01', startMs: 200, endMs: 1000,
    lockedCaptionsPreserved: 0, unchangedCount: 0, passNumber: 1, strategy: 'standard',
    currentCaptions: [current], proposedCaptions: [proposed],
    changes: [{
      id: 'layout-change', startMs: 200, endMs: 1000, beforeText: current.text, afterText: proposed.text,
      beforeStartMs: 200, beforeEndMs: 1000, afterStartMs: 200, afterEndMs: 1000,
      textChanged: true, timingChanged: false, timingDeltaMs: 0, confidence: 'high', protectedByLock: false,
    }],
  };
  state.jobs = [{
    id: 'layout-job', type: 'regenerate-range', projectId: 'landscape', projectTitle: 'Audit landscape',
    status: 'completed', stage: 'complete', progress: 100, message: 'Comparison ready', canResume: false,
    createdAt: proposal.createdAt, updatedAt: proposal.createdAt, proposalId: proposal.id,
  }];
  await page.route('**/regeneration-proposals/layout-proposal', (route) => route.fulfill({ json: proposal }));
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`) });
}

test('records Review media allocation for desktop evidence', async ({ page }) => {
  const measurements = [];
  for (const shape of ['landscape', 'portrait']) {
    if (shape === 'portrait') await usePortrait(page);
    await openProject(page);
    await expect.poll(() => page.locator('video').evaluate((node: HTMLVideoElement) => node.videoHeight)).toBe(shape === 'portrait' ? 640 : 360);
    await stage(page, 'review').click();
    await expect(page.getByRole('complementary', { name: 'Review workspace', exact: true })).toBeVisible();
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
      await page.setViewportSize(viewport);
      const media = (await mediaBox(page).boundingBox())!;
      const preview = (await page.locator('.stage-column').boundingBox())!;
      expect(media.height).toBeGreaterThan(0);
      measurements.push({ ...viewport, shape, mediaHeight: media.height, previewWidth: preview.width });
      if (shape === 'portrait' && viewport.width === 1366 && !process.env.STHANG_WAVE2B2_BASELINE) {
        await page.screenshot({ path: path.join(evidence, 'review-portrait-1366x768.png') });
      }
    }
  }
  await fs.mkdir(evidence, { recursive: true });
  const label = process.env.STHANG_WAVE2B2_BASELINE ? 'before' : 'after';
  await fs.writeFile(path.join(evidence, `review-geometry-${label}.json`), JSON.stringify(measurements, null, 2) + '\n');
});

test('workspace switches use the task order and reclaim the toolbar while retaining evidence', async ({ page }) => {
  await installProposal(page);
  await openProject(page);
  await rememberNodes(page);
  await expect(toolbar(page).getByRole('navigation')).toBeVisible();
  await screenshot(page, 'captions-1440x900');
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect.poll(() => visualOrder(page)).toEqual(editOrder);
  const captionsMedia = (await mediaBox(page).boundingBox())!;
  const width = (await paneBounds(page)).preview.width;

  for (const name of ['review', 'appearance', 'export']) {
    await stage(page, name).click();
    await expect(toolbar(page)).toHaveCount(0);
    await expect.poll(() => visualOrder(page)).toEqual(name === 'export' ? editOrder : judgeOrder);
    expect(Math.abs((await paneBounds(page)).preview.width - width)).toBeLessThanOrEqual(1);
    await expectSameNodes(page);
    if (name === 'review') expect((await mediaBox(page).boundingBox())!.height - captionsMedia.height).toBeGreaterThanOrEqual(40);
    if (name !== 'export') await screenshot(page, `${name}-1440x900`);
  }

  const tools = await openLayoutTools(page);
  await tools.getByRole('menuitem', { name: /Processing jobs/ }).click();
  await page.getByRole('dialog', { name: 'Activity', exact: true }).getByRole('button', { name: 'Open result', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Compare captions workspace', exact: true })).toBeVisible();
  await expect(toolbar(page)).toHaveCount(0);
  await expect.poll(() => visualOrder(page)).toEqual(judgeOrder);
  expect(Math.abs((await paneBounds(page)).preview.width - width)).toBeLessThanOrEqual(1);
  await expectSameNodes(page);
  await page.getByRole('button', { name: 'Close tool', exact: true }).click();
  await stage(page, 'captions').click();
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect.poll(() => visualOrder(page)).toEqual(editOrder);
  await expectSameNodes(page);
});

test('judging order persists separately and Reset clears both optional preferences', async ({ page }) => {
  await openProject(page);
  await rememberNodes(page);
  await stage(page, 'review').click();
  const panel = await openPanelArrangement(page);
  await expect(panel).toContainText('This arrangement is used in Review, Appearance and Compare.');
  await panel.getByRole('button', { name: 'Preview right', exact: true }).click();
  const remembered = ['inspector', 'captions', 'preview'];
  await expect.poll(() => visualOrder(page)).toEqual(remembered);
  await expect.poll(() => saved(page)).toEqual({ preview: .36, inspector: .28, order: editOrder, judgeOrder: remembered });
  await expectSameNodes(page);
  await page.keyboard.press('Escape');
  await stage(page, 'captions').click();
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect.poll(() => visualOrder(page)).toEqual(editOrder);
  await openProject(page);
  await stage(page, 'review').click();
  await expect.poll(() => visualOrder(page)).toEqual(remembered);
  await enlarge(page).click();
  expect((await saved(page)).enlargePreview).toBe(true);
  const resetPanel = await resetEditorLayout(page);
  await expect.poll(() => visualOrder(page)).toEqual(judgeOrder);
  await expect.poll(() => saved(page)).toEqual({ preview: .36, inspector: .28, order: editOrder });
  await expect(page.getByRole('status').filter({ hasText: 'Panels reset to the default layout.' })).toHaveAttribute('aria-live', 'polite');
  await expect(resetPanel).toBeVisible();
  await expect(resetPanel.getByRole('button', { name: 'Reset layout', exact: true })).toBeFocused();
  await expect(resetPanel.getByRole('button', { name: 'Preview left', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(resetPanel.getByRole('status')).toHaveText('From left: Preview, Tool, Captions.');
});

test('derivation preserves the already adjacent custom editing order', async ({ page }) => {
  const order = ['captions', 'preview', 'inspector'];
  await page.addInitScript(({ key, order }) => localStorage.setItem(key, JSON.stringify({ preview: .36, inspector: .28, order })), { key: layoutKey, order });
  await openProject(page);
  await stage(page, 'review').click();
  await expect.poll(() => visualOrder(page)).toEqual(order);
  expect(await saved(page)).toEqual({ preview: .36, inspector: .28, order });
});

test('Review Tab order leads from Preview to the decision workspace before captions', async ({ page }) => {
  await openProject(page);
  await stage(page, 'review').click();
  await mediaBox(page).focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const node = document.activeElement;
      if (node?.closest('.workspace-inspector')) return 'inspector';
      if (node?.closest('.caption-panel')) return 'captions';
      return null;
    });
    expect(focused).not.toBe('captions');
    if (focused === 'inspector') return;
  }
  throw new Error('Tab did not reach the Review workspace from Preview.');
});

test('unsupported Review keeps canonical order and offers Reset layout', async ({ page }) => {
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((...args: string[]) => args[0] === 'reading-flow' ? false : (supports as any)(...args)) as typeof CSS.supports;
  });
  await openProject(page);
  await stage(page, 'review').click();
  await expect.poll(() => visualOrder(page)).toEqual(editOrder);
  const initial = await paneBounds(page);
  await page.getByRole('separator', { name: 'Resize Preview and Captions', exact: true }).press('ArrowRight');
  await expect.poll(async () => (await paneBounds(page)).preview.width).toBeGreaterThan(initial.preview.width);

  const menu = await openLayoutTools(page);
  await expect(menu.getByRole('menuitem', { name: 'Arrange panels…', exact: true })).toBeEnabled();
  const panel = await openPanelArrangement(page);
  const reset = panel.getByRole('button', { name: 'Reset layout', exact: true });
  await expect(panel).toContainText("This browser can't reorder panels. Update it to arrange panels; sizes can still be reset.");
  await expect(panel.getByRole('group', { name: 'Preview position', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^Drag .* panel to reorder$/ })).toHaveCount(0);
  await expect(panel.getByRole('status')).toHaveCount(0);
  await expect(reset).toBeFocused();
  await page.screenshot({ path: path.join(arrangementEvidence, 'arrangement-unsupported.png'), animations: 'disabled' });
  await reset.click();
  await expect.poll(() => paneBounds(page)).toEqual(initial);
  await expect(reset).toBeFocused();
  await expect(panel).toBeVisible();
});

test('Layout is desktop-only and its popover anchors and restores focus to Tools', async ({ page }) => {
  await openProject(page);
  for (const width of [1440, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    const menu = await openLayoutTools(page);
    await expect(menu.getByRole('menuitem', { name: 'Arrange panels…', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Reset layout', exact: true })).toHaveCount(0);
    if (width === 1440) {
      await expect.poll(() => menu.evaluate((node) => node.getAnimations().length)).toBe(0);
      await page.screenshot({ path: path.join(arrangementEvidence, 'tools-1440x900.png') });
    }
    const panel = await openPanelArrangement(page);
    await expect(panel).toContainText('This arrangement is used in Captions and Export.');
    await expect(panel.getByRole('button', { name: 'Preview left', exact: true })).toBeFocused();
    if (width === 1440) await page.screenshot({ path: path.join(arrangementEvidence, 'arrangement-supported.png'), animations: 'disabled' });
    const anchor = (await toolsButton(page).boundingBox())!;
    expect((await panel.boundingBox())!.y).toBeCloseTo(anchor.y + anchor.height + 8, 0);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(toolsButton(page)).toBeFocused();
  }
  const panel = await openPanelArrangement(page);
  await page.locator('.stage-column').click({ position: { x: 5, y: 5 } });
  await expect(panel).toBeHidden();
  for (const width of [1199, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const menu = await openLayoutTools(page, true);
    await expect(menu.getByRole('menuitem', { name: /^(Arrange panels|Reset layout)/ })).toHaveCount(0);
    const enabled = menu.getByRole('menuitem', { disabled: false });
    const count = await enabled.count();
    for (let index = 0; index < count; index++) {
      await expect(enabled.nth(index)).toBeFocused();
      await page.keyboard.press('ArrowDown');
    }
    await expect(enabled.first()).toBeFocused();
    await page.keyboard.press('r');
    await expect(menu.getByRole('menuitem', { name: /^Replace media/ })).toBeFocused();
    await page.keyboard.press('Escape');
  }
});

test('Tools menu items contain wrapped descriptions at wide desktop sizes', async ({ page }) => {
  await openProject(page);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1200, height: 800 }]) {
    await page.setViewportSize(viewport);
    const menu = await openLayoutTools(page);
    await expect(menu.getByRole('menuitem', { name: 'Arrange panels…', exact: true }).locator('small')).toHaveCount(0);
    const description = menu.getByRole('menuitem', { name: /^Replace media/ }).locator('small');
    await expect(description).toHaveText('Choose whether to keep reviewed captions');

    const items = menu.locator('.tools-menu-section > button');
    const readItems = () => items.evaluateAll((buttons) => buttons.map((button) => {
      const { top, bottom, height } = button.getBoundingClientRect();
      return { top, bottom, height, scrollHeight: button.scrollHeight, clientHeight: button.clientHeight };
    }));
    const original = await readItems();
    await description.evaluate((node) => { node.textContent = Array(4).fill(node.textContent).join(' '); });
    const wrapped = await readItems();
    expect(wrapped.some((item, index) => item.height > original[index].height)).toBe(true);
    for (const boxes of [original, wrapped]) {
      for (const [index, item] of boxes.entries()) {
        expect(item.scrollHeight).toBeLessThanOrEqual(item.clientHeight + 1);
        if (index > 0) expect(item.top).toBeGreaterThanOrEqual(boxes[index - 1].bottom);
      }
    }
    await description.evaluate((node) => { node.textContent = 'Choose whether to keep reviewed captions'; });
    await page.keyboard.press('Escape');
  }
});

test('landscape enlargement fits captions to the minimum and temporarily yields to editing or narrow widths', async ({ page }) => {
  await openProject(page);
  await rememberNodes(page);
  await stage(page, 'review').click();
  const initial = await paneBounds(page);
  await expect(enlarge(page)).toHaveAttribute('aria-pressed', 'false');
  await enlarge(page).click();
  await expect(enlarge(page)).toHaveAttribute('aria-pressed', 'true');
  const space = (await page.locator('.refined-editor').boundingBox())!.width - 16;
  const enlarged = await paneBounds(page);
  expect(enlarged.preview.width).toBeGreaterThan(initial.preview.width);
  expect(Math.abs(enlarged.preview.width - (space - enlarged.inspector.width - 360))).toBeLessThanOrEqual(2);
  expect(Math.abs(enlarged.captions.width - 360)).toBeLessThanOrEqual(2);
  const captions = page.locator('.caption-panel');
  const title = captions.locator('.panel-head-copy strong');
  const count = captions.locator('.panel-head-copy > span');
  await expect(title).toHaveText('Review queue');
  await expect(count).toHaveText('2 to review');
  for (const text of [title, count]) {
    await expect(text).toBeVisible();
    const { scrollWidth, clientWidth } = await text.evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  }
  const head = await captions.evaluate((pane) => {
    const bounds = pane.getBoundingClientRect();
    const copy = pane.querySelector('.panel-head-copy')!.getBoundingClientRect();
    return [...pane.querySelectorAll('.panel-tools > button')].map((tool) => {
      const rect = tool.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left >= bounds.left && rect.right <= bounds.right
        && rect.top >= copy.bottom && rect.bottom <= bounds.bottom;
    });
  });
  expect(head).toEqual([true, true, true]);
  expect(enlarged.inspector.width).toBe(initial.inspector.width);
  await expect(page.getByRole('separator', { name: /^Resize/ })).toHaveCount(0);
  expect((await saved(page)).enlargePreview).toBe(true);
  await screenshot(page, 'review-enlarged-1440x900');
  await expectSameNodes(page);

  await stage(page, 'captions').click();
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(enlarge(page)).toHaveCount(0);
  expect((await paneBounds(page)).preview.width).toBe(initial.preview.width);
  await stage(page, 'review').click();
  await expect(enlarge(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await paneBounds(page)).toEqual(enlarged);
  await page.setViewportSize({ width: 1199, height: 900 });
  await expect(enlarge(page)).toHaveCount(0);
  const narrow = await paneBounds(page);
  expect(narrow.preview.width).toBe(narrow.captions.width);
  expect(narrow.captions.width).toBeGreaterThan(360);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(enlarge(page)).toHaveAttribute('aria-pressed', 'true');
  await enlarge(page).click();
  await expect(enlarge(page)).toHaveAttribute('aria-pressed', 'false');
  expect(await paneBounds(page)).toEqual(initial);
  expect(await saved(page)).not.toHaveProperty('enlargePreview');
  await expectSameNodes(page);
});

test('portrait and audio projects never offer Enlarge preview', async ({ page }) => {
  await usePortrait(page);
  await openProject(page);
  await expect.poll(() => page.locator('video').evaluate((node: HTMLVideoElement) => node.videoHeight)).toBe(640);
  await stage(page, 'review').click();
  await expect(enlarge(page)).toHaveCount(0);
  const { media } = state.projects[0];
  state.projects[0].media = { ...media, filename: 'layout-audio.wav', originalName: 'layout-audio.wav', url: '/media/layout-audio.wav', mimeType: 'audio/wav' };
  await page.route('**/media/layout-audio.wav', (route) => route.fulfill({ contentType: 'audio/wav', body: createSyntheticWav(4) }));
  await page.goto('/');
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(page.locator('.media-stage audio')).toBeVisible();
  await stage(page, 'review').click();
  await expect(enlarge(page)).toHaveCount(0);
});

test('enlarging cancels a captured divider without persisting its draft widths', async ({ page }) => {
  await openProject(page);
  await stage(page, 'review').click();
  const initial = await paneBounds(page);
  const divider = page.getByRole('separator', { name: 'Resize Preview and Tool', exact: true });
  const handle = (await divider.boundingBox())!;
  const pointer = { x: handle.x + handle.width / 2, y: handle.y + 80 };
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.down();
  await page.mouse.move(pointer.x + 20, pointer.y);
  await expect.poll(async () => (await paneBounds(page)).preview.width).toBe(initial.preview.width + 20);
  await enlarge(page).press('Enter');
  await page.mouse.up();
  expect(await saved(page)).toEqual({ preview: .36, inspector: .28, order: editOrder, enlargePreview: true });
  await expect(enlarge(page)).toHaveAttribute('aria-pressed', 'true');
  expect((await paneBounds(page)).inspector.width).toBe(initial.inspector.width);
  await enlarge(page).click();
  expect(await paneBounds(page)).toEqual(initial);
  expect(await saved(page)).toEqual({ preview: .36, inspector: .28, order: editOrder });
});

for (const width of [390, 900]) test(`preview-first scrolling and sticky offsets at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await openProject(page);
  const preview = page.locator('.stage-column');
  const workbench = page.locator('.editor-workbench');
  for (const name of ['captions', 'review']) {
    await stage(page, name).click();
    const top = name === 'captions' ? 60 : 0;
    await expect(preview).toHaveCSS('position', 'sticky');
    await expect(preview).toHaveCSS('top', `${top}px`);
    const panes = await preview.evaluate((node) => [...node.parentElement!.children]
      .filter((pane) => getComputedStyle(pane).display !== 'none' && pane.getBoundingClientRect().height > 0)
      .map((pane) => pane.className));
    expect(panes[0]).toBe('stage-column');
    expect(await workbench.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await workbench.evaluate((node) => { node.scrollTop = 70; });
    await expect.poll(async () => (await preview.boundingBox())!.y - (await workbench.boundingBox())!.y).toBe(top);
    await workbench.evaluate((node) => { node.scrollTop = 0; });
    await screenshot(page, `${name}-${width}x844`);
  }
});
