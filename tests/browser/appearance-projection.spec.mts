import { test as base, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
test.setTimeout(60_000);

for (const width of [1440, 390]) test(`ordinary saved-look visits transfer appearance authority without the 500-caption body at ${width}px`, async ({ page }, info) => {
  const state = await installFixture(page);
  state.projects[0].captions.push(...Array.from({ length: 497 }, (_, index) => ({
    id: `appearance-payload-${index}`, text: `Private synthetic caption ខ្មែរ ${index}`, startMs: 4000 + index * 1000,
    endMs: 4900 + index * 1000, approved: true, timingQuality: 'high' as const,
  })));
  const captions = structuredClone(state.projects[0].captions);
  const saved = structuredClone(state.projects[0].captionAppearance);
  const fullReads: string[] = []; const projected: Promise<{ text: string; value: Record<string, unknown> }>[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/projects/landscape') fullReads.push(url.pathname);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (response.request().method() === 'GET' && url.pathname === '/api/projects/landscape/appearance') projected.push(response.text().then((text) => ({ text, value: JSON.parse(text) })));
  });
  await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await openProject(page);
  const initialFullReads = fullReads.length;
  await page.evaluate(() => { (window as any).__appearanceProjectionNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
  for (let visit = 0; visit < 2; visit++) {
    await page.locator('.stage-rail').getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(page.getByLabel('Exact size', { exact: true })).toHaveValue(String(saved!.fontSize1080));
    await expect(page.locator('.appearance-save-state')).toContainText('Saved automatically');
    await page.locator('.stage-rail').getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByLabel('Resolution', { exact: true })).toBeEnabled();
    await expect(page.getByRole('region', { name: 'Check before export' })).not.toContainText('Loading saved caption appearance');
  }
  expect(projected.length).toBeGreaterThanOrEqual(4);
  const responses = await Promise.all(projected);
  for (const response of responses) {
    expect(Object.keys(response.value).sort()).toEqual(['captionAppearance', 'id', 'media']);
    expect(response.value).toEqual({ id: state.projects[0].id, media: state.projects[0].media, captionAppearance: saved });
    expect(response.text).not.toContain(captions.at(-1)!.text);
    expect(Buffer.byteLength(response.text)).toBeLessThan(4096);
  }
  expect(fullReads).toHaveLength(initialFullReads);
  expect(state.projects[0].captions).toEqual(captions); expect(state.projects[0].captionAppearance).toEqual(saved);
  expect(state.requests.filter((request) => request.method !== 'GET' && !request.path.endsWith('/preview'))).toEqual([]);
  expect(await page.evaluate(() => (window as any).__appearanceProjectionNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  const fullBytes = Buffer.byteLength(JSON.stringify(state.projects[0]));
  const appearanceBytes = Buffer.byteLength(responses[0].text);
  await info.attach('saved-look-payload-bytes.json', { contentType: 'application/json', body: JSON.stringify({ captions: captions.length, fullProjectBytes: fullBytes, appearanceBytes }) });
});
