import { expect, test as base } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';
import { km } from '../../apps/web/src/i18n/messages/km/index.js';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

for (const width of [320, 1440]) test(`Compare looks freezes one picture and applies only the chosen decoration at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: width === 320 ? 'reduce' : 'no-preference' });
  const state = await installFixture(page);
  if (width === 320) state.profile.preferences.interfaceLanguage = 'km';
  const baseline = structuredClone(state.projects[0].captionAppearance!);
  const writes = () => state.requests.filter((request) => request.method === 'PUT' && request.path.endsWith('/appearance'));
  await openProject(page);
  await page.locator('[data-stage=appearance]').click();
  const trigger = page.getByRole('button', { name: width === 320 ? km.appearance.looks.compare : 'Compare looks', exact: true });
  const section = page.locator('.look-comparison');
  const current = section.locator('.look-comparison-switch button').first();
  const candidate = section.locator('.look-comparison-switch button').last();
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((el) => el.readyState >= 2 && !el.seeking)).toBe(true);
  const timestamp = await video.evaluate((el) => el.currentTime);
  await trigger.press('Enter');
  await trigger.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(section).toHaveCount(0);
  await trigger.press('Enter');
  if (width === 1440) {
    const picker = section.getByRole('combobox');
    await picker.press('Alt+ArrowDown');
    await expect.poll(() => picker.evaluate((el) => el.matches(':open'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => picker.evaluate((el) => el.matches(':open'))).toBe(false);
    await expect(section).toBeVisible();
  }
  await section.getByRole('combobox').press('Escape');
  await expect(trigger).toBeFocused();
  await expect(section).toHaveCount(0);
  await trigger.press('Enter');
  await section.getByRole('combobox').selectOption('solid-box');
  const surface = section.locator('canvas');
  const still = await surface.evaluate((el) => el.toDataURL());
  const caption = section.locator('.look-comparison-caption > span');
  const text = await caption.textContent();
  const registration = () => surface.evaluate((el) => {
    const frame = el.getBoundingClientRect();
    const panel = el.closest('.look-comparison')!.getBoundingClientRect();
    return { x: frame.x - panel.x, y: frame.y - panel.y, width: frame.width, height: frame.height };
  });
  const box = await registration();
  const paint = await caption.evaluate((el) => getComputedStyle(el).backgroundColor);
  await current.press('Enter');
  await expect(caption).not.toHaveCSS('background-color', paint);
  await expect(caption).toHaveText(text!);
  await candidate.press('Space');
  await expect(caption).toHaveCSS('background-color', paint);
  expect(await surface.evaluate((el) => el.toDataURL())).toBe(still);
  expect(await registration()).toEqual(box);
  expect(await section.evaluate((panel) => panel.scrollWidth - panel.clientWidth)).toBeLessThanOrEqual(1);
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual((await section.boundingBox())!.width + 1);
  expect(await video.evaluate((el) => el.currentTime)).toBe(timestamp);
  expect(writes()).toHaveLength(0);
  await section.evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'instant' }));
  await section.screenshot({ path: info.outputPath('look-comparison-' + width + '.png') });
  await candidate.press('Escape');
  await expect(trigger).toBeFocused();
  expect(writes()).toHaveLength(0);
  await trigger.press('Enter');
  await section.getByRole('combobox').selectOption('solid-box');
  await section.getByRole('button', { name: width === 320 ? km.appearance.looks.applyCandidate : 'Apply candidate', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect.poll(() => writes().length).toBe(1);
  expect(writes()[0].body.appearance).toMatchObject({ backgroundEnabled: true, fontFamily: baseline.fontFamily, positionBottomPct: baseline.positionBottomPct });
});

test('project swatches reuse a configured color as one undoable appearance edit', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await installFixture(page);
  const appearance = state.projects[0].captionAppearance!;
  appearance.outlineColor = '#426688';
  appearance.outlineWidth1080 = 3;
  appearance.glowEnabled = true;
  appearance.glowColor = '#426688';
  appearance.backgroundEnabled = true;
  appearance.backgroundColor = '#183828';
  appearance.highlightMode = 'word';
  appearance.highlightColor = '#EFBC39';
  const original = appearance.textColor;
  await openProject(page);
  await page.locator('[data-stage=appearance]').click();
  const open = page.getByRole('button', { name: /^#[A-F0-9]{6} · Project colors for Text color$/ });
  const input = page.getByLabel('Text color', { exact: true });
  await open.press('Enter');
  const palette = page.getByRole('group', { name: 'Project colors for Text color', exact: true });
  await expect(palette.getByRole('button', { name: original })).toHaveAttribute('aria-pressed', 'true');
  const reused = palette.getByRole('button', { name: '#426688' });
  await expect(reused).toHaveCount(1);
  await expect(palette.getByRole('button')).toHaveCount(4);
  await reused.press('Escape');
  await expect(open).toBeFocused();
  await open.press('Space');
  await open.locator('..').locator('..').screenshot({ path: info.outputPath('project-colors-390.png') });
  await reused.press('Enter');
  await expect(open).toBeFocused();
  await expect(input).toHaveValue('#426688');
  await expect.poll(() => state.projects[0].captionAppearance?.textColor).toBe('#426688');
  await page.locator('.appearance-history button').first().click();
  await expect(input).toHaveValue(original.toLowerCase());
  await page.locator('.appearance-more > summary').click();
  for (const label of ['Outline color', 'Background color', 'Glow color', 'Highlight color']) {
    const disclosure = page.getByRole('button', { name: new RegExp('^#[A-F0-9]{6} · Project colors for ' + label + '$') });
    await disclosure.press('Enter');
    const options = page.getByRole('group', { name: 'Project colors for ' + label, exact: true });
    await expect(options.getByRole('button', { pressed: true })).toHaveCount(1);
    await options.getByRole('button', { name: '#EFBC39' }).press('Escape');
    await expect(disclosure).toBeFocused();
  }
});

test('a long Khmer sample near the top of a narrow frame remains reachable on both sides', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const state = await installFixture(page);
  const text = 'អក្សរខ្មែរសម្រាប់វីដេអូ '.repeat(18).trim();
  state.projects[0].captions[0].text = text;
  state.projects[0].captionAppearance!.positionBottomPct = 82;
  await openProject(page);
  await page.getByLabel('Caption 1 text', { exact: true }).click();
  await page.locator('[data-stage=appearance]').click();
  await page.getByRole('button', { name: 'Compare looks' }).click();
  const panel = page.locator('.look-comparison');
  for (const side of ['Current', 'Candidate']) {
    await panel.getByRole('button', { name: side, exact: true }).click();
    const copy = panel.locator('.look-comparison-caption');
    await expect(copy).toHaveText(text);
    const reachable = await copy.evaluate((el) => {
      const frame = el.closest('.look-comparison-picture')!.getBoundingClientRect();
      const scroller = el.parentElement!;
      scroller.scrollTop = 0;
      const start = el.getBoundingClientRect().top;
      scroller.scrollTop = scroller.scrollHeight;
      const end = el.getBoundingClientRect().bottom;
      return { start: start >= frame.top - 1, end: end <= frame.bottom + 1 };
    });
    expect(reachable).toEqual({ start: true, end: true });
    const scroller = panel.getByRole('region');
    await scroller.focus();
    await scroller.press('Home');
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
    await scroller.press('Space');
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.locator('video').evaluate((el) => el.paused)).toBe(true);
  }
});

for (const [width, height] of [[180, 320], [640, 160]]) test(`Look comparison registers the whole ${width}×${height} frame in a phone inspector`, async ({ page }, info) => {
  const clip = execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=2:duration=1`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
  ]);
  await page.setViewportSize({ width: 320, height: 844 });
  await installFixture(page);
  await openProject(page);
  await page.locator('[data-stage=appearance]').click();
  const media = page.locator('video');
  await media.evaluate((video, base64) => {
    video.src = 'data:video/mp4;base64,' + base64;
    video.load();
  }, clip.toString('base64'));
  await expect.poll(() => media.evaluate((video) => video.readyState >= 2 && video.videoWidth)).toBe(width);
  await page.getByRole('button', { name: 'Compare looks' }).click();
  const panel = page.locator('.look-comparison');
  const picture = panel.locator('.look-comparison-picture');
  await expect(picture).toBeVisible();
  const frame = (await picture.locator('canvas').boundingBox())!;
  expect(frame.width / frame.height).toBeCloseTo(width / height, 2);
  expect(await picture.boundingBox()).toEqual(frame);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await picture.evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'instant' }));
  await expect.poll(() => picture.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    return [bounds.top + 2, bounds.bottom - 2].every((y) => el.contains(document.elementFromPoint(x, y)));
  })).toBe(true);
  await picture.screenshot({ path: info.outputPath('comparison-' + width + 'x' + height + '.png') });
});

for (const width of [320, 1440]) test(`Looks share one still and stage changes preserve the player at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 320 ? 844 : 900 });
  await page.emulateMedia({ reducedMotion: width === 320 ? 'reduce' : 'no-preference' });
  const state = await installFixture(page);
  if (width === 320) state.profile.preferences.interfaceLanguage = 'km';
  await openProject(page);
  const player = await page.locator('video').elementHandle();
  const stage = (name: string) => page.locator(`[data-stage="${name}"]`);
  await stage('appearance').click();
  const grid = page.locator('.appearance-look-grid');
  const cards = grid.getByRole('button');
  const previews = grid.locator('.appearance-look-preview');
  const backgrounds = () => previews.evaluateAll((tiles) => tiles.map(tile => getComputedStyle(tile).backgroundImage));
  await expect(cards).toHaveCount(6);
  await expect.poll(async () => (await backgrounds())[0]).toMatch(/^url\("blob:/);
  const [frame] = await backgrounds();
  expect(await backgrounds()).toEqual(Array(6).fill(frame));
  const selected = grid.locator('[aria-pressed=true]');
  await cards.first().click();
  const original = await selected.textContent();
  await cards.nth(0).focus();
  await page.keyboard.press('Tab');
  await expect(cards.nth(1)).toBeFocused();
  await expect(selected).toHaveText(original!);
  await page.keyboard.press('Enter');
  await expect(cards.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(selected.locator('svg')).toHaveCount(1);
  await seek(page, 1500);
  expect(await backgrounds()).toEqual(Array(6).fill(frame));
  expect(await grid.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await grid.screenshot({ path: info.outputPath('looks.png') });

  const rule = page.locator('.inspector-stage-rule');
  const first = await rule.elementHandle();
  await stage('review').click();
  await stage('export').click();
  await expect(page.locator('.export-workspace')).toBeVisible();
  await expect(rule).toHaveCount(1);
  expect(await first!.evaluate(el => el.isConnected)).toBe(false);
  expect(await rule.evaluate(el => getComputedStyle(el).animationName)).toBe(width === 320 ? 'none' : 'inspector-stage-in');
  if (width === 1440) await expect(rule).toHaveCSS('animation-duration', '0.18s');
  expect(await player!.evaluate(el => el === document.querySelector('video'))).toBe(true);
  expect(await page.locator('video').evaluate(el => el.paused)).toBe(true);
});

test('an unreadable video frame leaves every Look available', async ({ page }) => {
  await page.addInitScript(() => {
    const read = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args: Parameters<typeof read>) {
      if (this.canvas.closest('.look-comparison-picture')) throw new DOMException('Unreadable frame', 'SecurityError');
      return read.apply(this, args);
    };
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (type === 'image/jpeg') throw new DOMException('Unreadable frame', 'SecurityError');
      return encode.call(this, callback, type, quality);
    };
  });
  await installFixture(page);
  await openProject(page);
  await page.locator('[data-stage=appearance]').click();
  const compare = page.getByRole('button', { name: 'Compare looks', exact: true });
  await compare.click();
  await expect(page.locator('.look-comparison figcaption')).toContainText('Video frame unavailable');
  await expect(page.locator('.look-comparison canvas')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Apply candidate' })).toHaveCount(0);
  await compare.click();
  const card = page.locator('.appearance-look-card').nth(3);
  await expect(card.locator('.appearance-look-preview')).toHaveCSS('background-image', 'none');
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');
});
