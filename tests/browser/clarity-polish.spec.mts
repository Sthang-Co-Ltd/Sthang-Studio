import { test, expect, type Page } from '@playwright/test';
import { webSourceIdentity } from '../../scripts/web-runtime-identity.mjs';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });
const name = 'Audit landscape — ការកែសម្រួលចំណងជើង ' + 'Final version with a long project name '.repeat(4);
const file = 'ប្រភពវីដេអូ_' + 'long_source_filename_'.repeat(7) + '.mp4';
const details = (page: Page) => page.getByRole('button', { name: 'Project details', exact: true });
const namePanel = (page: Page) => page.getByRole('dialog', { name: 'Project details', exact: true });
const findPanel = (page: Page) => page.getByRole('dialog', { name: 'Find & Correct Everywhere', exact: true });
async function find(page: Page, query: string, replacement: string) {
  await page.keyboard.press('Control+f');
  await findPanel(page).getByLabel('Find', { exact: true }).fill(query);
  await findPanel(page).getByLabel('Replace with', { exact: true }).fill(replacement);
}

test('Find highlights preserve exact copyable Khmer, emoji and literal markup; applying uses the same plan', async ({ page }, info) => {
  const original = 'កម្ពុជា 👨‍👩‍👧‍👦 old / old <b>plain</b>';
  state.projects[0].captions[0].text = original;
  state.projects[0].captions[1].text = original;
  state.projects[0].captions[1].textLocked = true;
  await openProject(page);
  await find(page, 'old', 'new');
  const rows = page.locator('.find-preview-row');
  await expect(rows).toHaveCount(2);
  expect(await rows.first().locator('.find-before').textContent()).toBe(original);
  expect(await rows.first().locator('.find-after').textContent()).toBe(original.replaceAll('old', 'new'));
  await expect(rows.first().locator('del')).toHaveCount(2);
  await expect(rows.first().locator('ins')).toHaveCount(2);
  await expect(rows.first().locator('.find-before b,.find-after b')).toHaveCount(0);
  await expect(rows.last().locator('del,ins')).toHaveCount(0);
  expect(await rows.last().locator('.find-after').textContent()).toBe(original);
  await page.screenshot({ path: info.outputPath('find-changes.png') });
  await findPanel(page).getByRole('button', { name: 'Replace editable matches', exact: true }).click();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(original.replaceAll('old', 'new'));
  await expect(page.getByLabel('Caption 2 text', { exact: true })).toHaveValue(original);
  await expect.poll(() => state.projects[0].captions[0].text).toBe(original.replaceAll('old', 'new'));
});

test('regex replacement, deletion and unchanged previews keep planner semantics', async ({ page }) => {
  state.projects[0].captions[0].text = 'cat cat';
  await openProject(page);
  await find(page, '(cat)', '$1!');
  await findPanel(page).getByRole('combobox', { name: /^Match/ }).selectOption('regex');
  await expect(page.locator('.find-after')).toHaveText('cat! cat!');
  await expect(page.locator('.find-after ins')).toHaveCount(2);
  await findPanel(page).getByLabel('Replace with', { exact: true }).fill('$&');
  await expect(page.locator('.find-preview ins,.find-preview del')).toHaveCount(0);
  await expect(findPanel(page).getByRole('button', { name: 'Replace editable matches' })).toBeDisabled();
  await findPanel(page).getByLabel('Find', { exact: true }).fill('^.*$');
  await findPanel(page).getByLabel('Replace with', { exact: true }).fill('');
  expect(await page.locator('.find-after').first().textContent()).toBe('');
  await expect(page.locator('.find-preview-empty').first()).toHaveText('Empty caption text');
});

test('full names are readable on Home and inspectable without saving, remounting or closing the tool', async ({ page }, info) => {
  state.projects[0].title = name; state.projects[0].media.originalName = file;
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.route('**/api/projects/landscape/captions', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic unsaved draft' } }));
  await page.goto('/');
  const recentName = page.locator('.recent button>span').first();
  await expect(recentName).toHaveText(name);
  expect(await recentName.evaluate((node) => node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Unfinished កម្ពុជា');
  await page.evaluate(() => { (window as any).__clarityNodes = [document.querySelector('video'), document.querySelector('.caption-panel')]; });
  const mediaBox = await page.locator('.media-stage').boundingBox();
  await details(page).hover();
  await expect(page.getByRole('tooltip')).toContainText(file);
  await details(page).click();
  await expect(namePanel(page).locator('dd').first()).toHaveText(name);
  await expect(namePanel(page).locator('dd').last()).toHaveText(file);
  await expect(namePanel(page)).not.toHaveAttribute('aria-modal', 'true');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(namePanel(page).getByRole('button', { name: 'Close project details' })).toBeFocused();
  await page.screenshot({ path: info.outputPath('project-names.png') });
  await page.keyboard.press('Escape');
  await expect(namePanel(page)).toHaveCount(0);
  await expect(details(page)).toBeFocused();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Unfinished កម្ពុជា');
  expect(state.projects[0].captions[0].text).not.toBe('Unfinished កម្ពុជា');
  expect(await page.locator('.media-stage').boundingBox()).toEqual(mediaBox);
  expect(await page.evaluate(() => (window as any).__clarityNodes.every((node: Element, i: number) => node === document.querySelector(i ? '.caption-panel' : 'video')))).toBe(true);
});

test('name disclosure yields to another dialog and returns focus to a connected control', async ({ page }) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.getByLabel('Fine timing start', { exact: true })).toBeEnabled();
  await details(page).focus(); await details(page).press('Enter');
  await expect(namePanel(page)).toBeVisible();
  const time = await page.locator('video').evaluate((node: HTMLVideoElement) => node.currentTime);
  for (const key of ['Alt+ArrowRight', 'Control+z', 'r']) await page.keyboard.press(key);
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.200');
  expect(await page.locator('video').evaluate((node: HTMLVideoElement) => node.paused && node.currentTime)).toBe(time);
  expect(state.projects[0].captions[0].startMs).toBe(200);
  await page.keyboard.press('Control+f');
  await expect(findPanel(page)).toBeVisible();
  await expect(namePanel(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(findPanel(page)).toHaveCount(0);
  await expect(details(page)).toBeFocused();
});

test('locked caption actions explain their prerequisite and remain inert', async ({ page }, info) => {
  state.projects[0].captions[0].timingLocked = true;
  state.projects[0].captions[1].textLocked = true;
  const captions = structuredClone(state.projects[0].captions);
  await openProject(page);
  const trigger = page.getByLabel('More actions for caption 1', { exact: true });
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'Caption 1 actions' });
  await expect(menu.getByRole('menuitem', { name: /Move earlier/ })).toContainText('Unlock timing first');
  await expect(menu.getByRole('menuitem', { name: /Move earlier/ })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: /^Merge with next/ })).toContainText('Unlock both captions first');
  await menu.getByRole('menuitem', { name: /Move earlier/ }).evaluate((node: HTMLButtonElement) => node.click());
  expect(state.projects[0].captions).toEqual(captions);
  await page.screenshot({ path: info.outputPath('unavailable-actions.png') });
  await page.keyboard.press('Escape');
  await trigger.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Unlock timing', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  const start = page.getByLabel('Fine timing start', { exact: true });
  await expect(start).toBeDisabled();
  await expect(start).toHaveAccessibleDescription(/Timing locked/);
  await expect(page.locator('.fine-timing').getByRole('button', { name: 'Move earlier', exact: true })).toHaveAccessibleDescription(/Timing locked/);
  expect(state.projects[0].captions).toEqual(captions);
});

test('adjoining-edge prerequisites explain missing and locked neighbours without changing timing', async ({ page }) => {
  state.projects[0].captions[1].timingLocked = true;
  await openProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.getByLabel('Fine timing start', { exact: true })).toBeEnabled();
  await page.getByText('Snapping, playback speed and display', { exact: true }).click();
  await page.getByLabel('Move adjoining edge too', { exact: true }).check();
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveAccessibleDescription(/no previous caption/);
  await expect(page.getByLabel('Fine timing end', { exact: true })).toHaveAccessibleDescription(/adjoining caption has timing locked/);
  await page.getByLabel('Move adjoining edge too', { exact: true }).uncheck();
  await expect(page.getByLabel('Fine timing start', { exact: true })).toBeEnabled();
  await expect(page.locator('.timing-unavailable-reason')).toHaveCount(0);
  expect(state.projects[0].captions[0].startMs).toBe(200);
});

// Layout-equivalent checks for a 1920×1080 display at these scale factors.
// These do not change or claim to verify the machine's Windows display setting.
for (const scale of [1.25, 1.5, 2]) test.describe(`scale-equivalent ${scale}`, () => {
  test.use({ viewport: { width: Math.round(1920 / scale), height: Math.round(1080 / scale) }, deviceScaleFactor: scale });
  test('Khmer names, correction preview and sheet actions remain readable and reachable', async ({ page }, info) => {
    state.projects[0].title = name; state.projects[0].media.originalName = file;
    state.projects[0].captions[0].text = 'កម្ពុជា កម្ពុជា ខ្មែររបស់យើង '.repeat(6);
    await openProject(page);
    const identity = await page.evaluate(async () => (await fetch('/studio-web-identity.json')).json());
    expect(identity.buildId).toBe(webSourceIdentity(process.cwd()).buildId);
    await info.attach('runtime-scale', { body: JSON.stringify({ buildId: identity.buildId, ...await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })) }), contentType: 'application/json' });
    await details(page).click();
    const box = (await namePanel(page).boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await namePanel(page).getByRole('button', { name: 'Close project details' }).click();
    await find(page, 'កម្ពុជា', 'ខ្មែរ');
    const apply = findPanel(page).getByRole('button', { name: 'Replace editable matches' });
    await apply.scrollIntoViewIfNeeded();
    await expect(apply).toBeVisible();
    const applyBox = (await apply.boundingBox())!;
    expect(applyBox.y + applyBox.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`scale-${scale}.png`) });
    await findPanel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
    const timing = page.getByLabel('Fine timing start', { exact: true });
    await expect(timing).toBeEnabled();
    await timing.scrollIntoViewIfNeeded();
    const timingBox = (await timing.boundingBox())!;
    expect(timingBox.x).toBeGreaterThanOrEqual(0);
    expect(timingBox.x + timingBox.width).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`timing-scale-${scale}.png`) });
    await page.locator('.fine-timing').getByRole('button', { name: 'Move later', exact: true }).click();
    await expect(timing).toHaveValue('00:00.250');
  });
});

test.describe('touch names', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('full project and file names can be opened and dismissed with touch', async ({ page }, info) => {
    state.projects[0].title = name; state.projects[0].media.originalName = file;
    await openProject(page);
    const label = details(page).locator('.project-name-compact');
    await expect(label).toHaveText('Project details');
    expect(await label.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await details(page).tap();
    await expect(namePanel(page).locator('dd').last()).toHaveText(file);
    const box = (await namePanel(page).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('touch-name-details.png') });
    await namePanel(page).getByRole('button', { name: 'Close project details' }).tap();
    await expect(details(page)).toBeFocused();
    await expect(namePanel(page)).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await label.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
