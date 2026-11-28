import { expect, test, type Page } from '@playwright/test';
import { summarizeProject, type CaptionProject } from '@kcs/shared';
import { cleanFixtures, installFixture, prepareFixtures, project, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const ARCHIVED_TITLE = 'Project 31 — ខ្មែរ [Vintage].+? ២០២១';
const CAFE_TITLE = 'Project 30 — Café (Extended) [Draft]';

function createLibraryProjects(): CaptionProject[] {
  return Array.from({ length: 31 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    const item = project(`library-${number}`);
    item.title = index === 30 ? ARCHIVED_TITLE
      : index === 29 ? CAFE_TITLE
        : index === 28 ? 'Project 29 — MiXeD.(Case)+[Literal]'
          : `Project ${number} — saved captions`;
    // Updated order and created order deliberately disagree. All ISO dates are
    // distinct so pagination and sort expectations are independent of ties.
    item.createdAt = new Date(Date.UTC(2025, 0, index + 1)).toISOString();
    item.updatedAt = new Date(Date.UTC(2026, 2, 31 - index)).toISOString();
    item.captions[0] = { ...item.captions[0], text: `Persisted caption from ${item.id}: ខ្មែរ ${number}` };
    return item;
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixtureLibrary(page: Page): Promise<FixtureState> {
  const state = await installFixture(page);
  state.projects = createLibraryProjects();
  return state;
}

const results = (page: Page) => page.getByRole('list', { name: 'Project results' });
const resultCountHeading = (page: Page) => page.locator('.project-library-summary h2');
const openButtons = (page: Page) => results(page).getByRole('button', { name: /^Open / });
const openButton = (page: Page, item: CaptionProject) => page.getByRole('button', { name: `Open ${item.title}`, exact: true });

async function showLibrary(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'All projects' })).toBeVisible();
  await page.getByRole('button', { name: 'All projects' }).click();
  await expect(page.getByRole('heading', { name: 'All projects', exact: true })).toBeVisible();
}

test('Home thumbnail trial uses a visited frame without loading footage on Home', async ({ page }, info) => {
  await installFixture(page);
  const loads: string[] = [];
  page.on('request', request => { if (request.resourceType() === 'media') loads.push(request.url()); });
  await page.goto('/?recentThumbnails=1');
  const row = page.locator('[data-recent-project="landscape"]');
  await expect(row).toBeVisible();
  expect(loads).toHaveLength(0);
  await row.click();
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2);
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route('**/api/projects?summary=1', async route => { await held; await route.fallback(); });
  try {
    await page.locator('button.back').click();
    await expect(row).toBeVisible();
    await expect(row.locator('img')).toHaveCount(0);
  } finally { release(); }
  await expect(row.locator('img')).toBeVisible();
  expect(await row.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.locator('.recent').screenshot({ path: info.outputPath('recent-project-still.png') });
  await page.reload();
  await expect(row).toBeVisible();
  await expect(row.locator('img')).toHaveCount(0);
});

test('Home keeps six recent cards; a saved Khmer project beyond both limits reopens without eager detail fetches', async ({ page }) => {
  const state = await fixtureLibrary(page);
  const requested: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET') requested.push(request.url());
  });

  await page.goto('/');
  const recent = page.getByRole('region', { name: 'Recent projects' });
  await expect(recent.getByRole('button', { name: /^Project \d\d/ })).toHaveCount(6);
  await expect(recent.getByRole('button', { name: state.projects[30].title })).toHaveCount(0);
  await page.getByRole('button', { name: 'All projects', exact: true }).click();

  await expect(openButtons(page)).toHaveCount(24);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(openButtons(page)).toHaveCount(7);
  await expect(resultCountHeading(page)).toBeFocused();
  await expect(openButton(page, state.projects[30])).toBeVisible();
  const apiRequests = () => requested.map((url) => new URL(url));
  expect(apiRequests().some((url) => url.pathname === '/api/projects' && url.searchParams.get('summary') === '1')).toBe(true);
  expect(apiRequests().filter((url) => /^\/api\/projects\/[^/]+$/.test(url.pathname))).toEqual([]);
  expect(apiRequests().some((url) => url.pathname === '/api/projects' && !url.searchParams.has('summary'))).toBe(false);

  await openButton(page, state.projects[30]).click();
  await expect(page.locator('.project-title strong')).toHaveText(ARCHIVED_TITLE);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(state.projects[30].captions[0].text);
  const detailUrls = apiRequests().filter((url) => /^\/api\/projects\/[^/]+$/.test(url.pathname));
  expect(detailUrls.map((url) => url.pathname)).toEqual(['/api/projects/library-31']);
});

for (const locale of ['en', 'km'] as const) test(`Recent projects distinguish duplicate titles by local edit time in ${locale}`, async ({ page }, info) => {
  const state = await fixtureLibrary(page);
  state.profile.preferences.interfaceLanguage = locale;
  state.projects = state.projects.slice(0, 3);
  const [latest, earlier, legacy] = state.projects;
  latest.title = earlier.title = '0916(1) សំឡេងដើម';
  latest.updatedAt = '2026-11-28T08:24:03.000Z';
  earlier.updatedAt = '2026-11-28T08:24:01.000Z';
  legacy.updatedAt = '';
  const width = locale === 'en' ? 1440 : 320;
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  const row = (id: string) => page.locator(`button[data-recent-project="${id}"]`);
  for (const item of [latest, earlier]) {
    const time = row(item.id).locator('time');
    await expect(time).toHaveAttribute('datetime', item.updatedAt);
    await expect(time).toBeVisible();
    await expect(row(item.id)).toHaveAccessibleName(new RegExp((await time.innerText()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  expect(await row(latest.id).innerText()).not.toBe(await row(earlier.id).innerText());
  await expect(row(legacy.id)).toBeEnabled();
  await expect(row(legacy.id).locator('time')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  await page.locator('.recent').screenshot({ path: info.outputPath('recent-timestamps.png') });
  await row(earlier.id).press('Enter');
  await expect(page.locator('.project-title strong')).toHaveText(earlier.title);
  expect(state.requests.some(({ path }) => path === `/api/projects/${earlier.id}`)).toBe(true);
});

test('returning projects form full rows beside Upload on desktop and below it on phones', async ({ page }) => {
  const state = await fixtureLibrary(page);
  state.projects[0].title = ARCHIVED_TITLE.repeat(3);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const region = page.getByRole('region', { name: 'Recent projects' });
  const rows = region.getByRole('listitem');
  await expect(rows).toHaveCount(6);
  const first = rows.first().getByRole('button');
  const upload = page.locator('.dropzone');
  const desktopUpload = (await upload.boundingBox())!;
  const firstBox = (await first.boundingBox())!;
  expect(firstBox.x).toBeGreaterThanOrEqual(desktopUpload.x + desktopUpload.width);
  expect((await rows.nth(1).boundingBox())!.y).toBeGreaterThanOrEqual(firstBox.y + firstBox.height);

  await page.setViewportSize({ width: 390, height: 844 });
  const phoneUpload = (await upload.boundingBox())!;
  expect((await region.boundingBox())!.y).toBeGreaterThanOrEqual(phoneUpload.y + phoneUpload.height);
  await expect(first).toBeInViewport({ ratio: 1 });
  const title = first.locator('span');
  await expect(title).toHaveText(state.projects[0].title);
  await expect(title).toHaveCSS('white-space', 'normal');
  await expect.poll(() => title.evaluate((element) => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    return element.clientHeight >= lineHeight * 1.8
      && element.scrollHeight <= element.clientHeight + 1
      && element.scrollWidth <= element.clientWidth + 1;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await first.press('Enter');
  await expect(page.locator('.project-title strong')).toHaveText(state.projects[0].title);
});

test('one recent project stays at the top beside expanded setup on a wide screen', async ({ page }, info) => {
  const state = await installFixture(page, { showFirstRun: true });
  state.projects = state.projects.slice(0, 1);
  const llm = { configured: false, keySource: 'none', maskedKey: null };
  await page.route(/\/api\/(?:health|system\/llm-settings)$/, (route) => route.fulfill({
    json: route.request().url().endsWith('/health') ? { ok: true, llm, timing: { configured: false } } : llm,
  }));
  await page.setViewportSize({ width: 1915, height: 943 });
  await page.goto('/');
  const launcher = page.locator('.returning-launcher');
  const recent = page.getByRole('region', { name: 'Recent projects' });
  await expect(launcher.locator('.first-run-card input[type=password]')).toBeVisible();
  await expect(recent.getByRole('button')).toBeInViewport({ ratio: 1 });
  const left = (await launcher.locator('.empty-stage').boundingBox())!;
  const right = (await recent.boundingBox())!;
  expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(2);
  expect(left.y - (await launcher.boundingBox())!.y).toBeLessThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('returning-home-wide.png') });
});

test('returning Home keeps the language prompt inside the Upload column at 801px', async ({ page }) => {
  const state = await fixtureLibrary(page);
  delete state.profile.preferences.interfaceLanguage;
  await page.setViewportSize({ width: 801, height: 900 });
  await page.goto('/');
  const uploadColumn = page.locator('.returning-launcher .empty-stage');
  const prompt = uploadColumn.locator('.interface-language-prompt');
  await expect(prompt).toBeVisible();
  const [column, panel, recent] = await Promise.all([
    uploadColumn.boundingBox(), prompt.boundingBox(),
    page.getByRole('region', { name: 'Recent projects' }).boundingBox(),
  ]);
  expect(panel!.x).toBeGreaterThanOrEqual(column!.x);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(column!.x + column!.width + 1);
  expect(panel!.x + panel!.width).toBeLessThan(recent!.x);
});

test('numbered pages jump across long libraries and collapse on a phone', async ({ page }, info) => {
  const state = await installFixture(page);
  state.projects = Array.from({ length: 145 }, (_, i) => ({
    ...project('archive-' + i), title: 'Archive ' + String(i + 1).padStart(3, '0'),
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await showLibrary(page);
  const nav = page.getByRole('navigation', { name: 'Project pages' });
  const jump = (n: number) => nav.getByRole('button', { name: 'Go to page ' + n, exact: true });
  await jump(7).press('Enter');
  await expect(resultCountHeading(page)).toBeFocused();
  await expect(openButtons(page)).toHaveCount(1);
  await expect(jump(7)).toHaveAttribute('aria-current', 'page');
  await jump(6).click();
  await expect(openButtons(page)).toHaveCount(24);
  await nav.screenshot({ path: info.outputPath('library-page-jumps.png') });
  await jump(1).click();
  await expect(nav.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  await jump(7).click();
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(jump(1)).toBeHidden();
  await expect(nav).toContainText('Page 7 of 7');
  await nav.getByRole('button', { name: 'Previous page' }).press('Enter');
  await expect(resultCountHeading(page)).toBeFocused();
  await expect(nav).toContainText('Page 6 of 7');
  await page.getByRole('searchbox').fill('Archive 0');
  await expect(nav).toContainText('Page 1 of 5');
  expect(await nav.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('all three sorts paginate deterministically and preserve the chosen view on reopening', async ({ page }) => {
  const state = await fixtureLibrary(page);
  await showLibrary(page);
  const sort = page.getByRole('combobox', { name: 'Sort projects' });

  await expect(sort).toHaveValue('updated');
  await expect(openButtons(page)).toHaveCount(24);
  await expect(openButtons(page).first()).toHaveAttribute('aria-label', `Open ${state.projects[0].title}`);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(openButtons(page)).toHaveCount(7);
  await expect(resultCountHeading(page)).toBeFocused();
  await expect(openButton(page, state.projects[30])).toBeVisible();
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(openButtons(page)).toHaveCount(24);
  await expect(resultCountHeading(page)).toBeFocused();

  await sort.selectOption('created');
  await expect(openButtons(page).first()).toHaveAttribute('aria-label', `Open ${state.projects[30].title}`);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(openButtons(page)).toHaveCount(7);
  await expect(resultCountHeading(page)).toBeFocused();
  await expect(openButton(page, state.projects[0])).toBeVisible();

  await sort.selectOption('title');
  await expect(openButtons(page)).toHaveCount(24);
  await expect(openButtons(page).first()).toHaveAttribute('aria-label', `Open ${state.projects[0].title}`);
  await expect(openButtons(page).nth(1)).toHaveAttribute('aria-label', `Open ${state.projects[1].title}`);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(openButtons(page)).toHaveCount(7);
  await expect(resultCountHeading(page)).toBeFocused();
  await expect(openButton(page, state.projects[30])).toBeVisible();
  await openButton(page, state.projects[30]).click();
  await expect(page.locator('.project-title strong')).toHaveText(ARCHIVED_TITLE);
  await page.getByLabel('Back to Home', { exact: true }).click();
  await expect(openButton(page, state.projects[30])).toBeFocused();
  await expect(sort).toHaveValue('title');
  await expect(openButtons(page)).toHaveCount(7);
  await expect(openButton(page, state.projects[30])).toBeVisible();
});

test('search uses literal title text, trims and casefolds, normalizes Khmer and NFC, and clears no-match results', async ({ page }) => {
  const state = await fixtureLibrary(page);
  await showLibrary(page);
  const search = page.getByRole('searchbox', { name: 'Search projects' });

  await search.fill('  [VINTAGE].+?  ');
  await expect(openButtons(page)).toHaveCount(1);
  await expect(openButton(page, state.projects[30])).toBeVisible();
  await search.fill('  ខ្មែរ  ');
  await expect(openButtons(page)).toHaveCount(1);
  await expect(openButton(page, state.projects[30])).toBeVisible();
  await search.fill('  Cafe\u0301  ');
  await expect(openButtons(page)).toHaveCount(1);
  await expect(openButton(page, state.projects[29])).toBeVisible();
  await search.fill('mixed.(CASE)+[literal]');
  await expect(openButtons(page)).toHaveCount(1);
  await expect(openButton(page, state.projects[28])).toBeVisible();

  // Searching only names must not inspect captions, media paths or turn
  // regular-expression syntax into wildcards.
  await search.fill('Persisted caption from library-31');
  await expect(openButtons(page)).toHaveCount(0);
  await search.fill('library-31.mp4');
  await expect(openButtons(page)).toHaveCount(0);
  await search.fill('[Vintage].+?*');
  await expect(openButtons(page)).toHaveCount(0);
  await expect(page.getByText(/no projects match your search/i)).toBeVisible();

  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');
  await expect(openButtons(page)).toHaveCount(24);
});

test('Back to Home flushes caption and Accuracy edits and retains query, created sort, and second page', async ({ page }) => {
  const state = await fixtureLibrary(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  const item = state.projects[0];
  const savedCaption = 'ខ្មែរ Saved after returning to project library';
  const savedAccuracy = 'Khmer dialogue about the 2026 countryside shoot';
  await page.route(`**/api/projects/${item.id}/context`, async (route) => {
    item.transcriptionContext = structuredClone(route.request().postDataJSON().transcriptionContext);
    await route.fulfill({ json: item });
  });

  await showLibrary(page);
  const search = page.getByRole('searchbox', { name: 'Search projects' });
  const sort = page.getByRole('combobox', { name: 'Sort projects' });
  await search.fill('Project');
  await sort.selectOption('created');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(openButtons(page)).toHaveCount(7);
  await expect(resultCountHeading(page)).toBeFocused();
  await openButton(page, item).click();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(item.captions[0].text);

  await page.getByRole('button', { name: 'Accuracy', exact: true }).click();
  await page.getByLabel('What is this video about?', { exact: true }).fill(savedAccuracy);
  await page.getByLabel('Caption 1 text', { exact: true }).fill(savedCaption);
  await page.getByLabel('Back to Home', { exact: true }).click();

  await expect(openButton(page, item)).toBeFocused();
  await expect.poll(() => item.captions[0].text).toBe(savedCaption);
  await expect.poll(() => item.transcriptionContext?.description).toBe(savedAccuracy);
  await expect(search).toHaveValue('Project');
  await expect(sort).toHaveValue('created');
  await expect(openButtons(page)).toHaveCount(7);
  await expect(openButton(page, item)).toBeVisible();

  await openButton(page, item).click();
  await expect(page.locator('.project-title strong')).toHaveText(item.title);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(savedCaption);
  await page.getByRole('button', { name: 'Accuracy', exact: true }).click();
  await expect(page.getByLabel('What is this video about?', { exact: true })).toHaveValue(savedAccuracy);
});

test('returning on a phone reveals the same project after a refreshed edit moves it to another results page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixtureLibrary(page);
  const item = state.projects[29];
  await showLibrary(page);
  const search = page.getByRole('searchbox', { name: 'Search projects' });
  const sort = page.getByRole('combobox', { name: 'Sort projects' });
  await search.fill('Project');
  await page.getByRole('button', { name: 'Next page' }).click();
  await openButton(page, item).click();
  const field = page.getByLabel('Caption 1 text', { exact: true });
  await expect(field).toHaveValue(item.captions[0].text);

  // Another client edited this project while it was open. The new title and
  // position arrive through the ordinary library refresh on return.
  item.title = 'Project café — ខ្មែរ revised';
  item.updatedAt = new Date(Date.parse(state.projects[13].updatedAt) + 1000).toISOString();
  await page.getByLabel('Back to Home', { exact: true }).click();
  const returned = openButton(page, item);
  await expect(returned).toBeFocused();
  await expect(returned).toBeInViewport({ ratio: 1 });
  await expect.poll(() => returned.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  })).toBe(true);
  await expect(search).toHaveValue('Project');
  await expect(sort).toHaveValue('updated');
  await expect(openButtons(page)).toHaveCount(24);

  // A later return can also find that the original project has been removed.
  await returned.click();
  await expect(field).toHaveValue(item.captions[0].text);
  state.projects = state.projects.filter((project) => project.id !== item.id);
  await page.getByLabel('Back to Home', { exact: true }).click();
  await expect(resultCountHeading(page)).toHaveText('30 projects');
  await expect(returned).toHaveCount(0);
  const fallback = page.locator('.project-library :is(h1, h2):focus');
  await expect(fallback).toBeInViewport();
  await expect(search).toHaveValue('Project');
  await expect(sort).toHaveValue('updated');
});

test('a late library refresh preserves a new search and its keyboard focus after returning', async ({ page }) => {
  const state = await fixtureLibrary(page);
  const item = state.projects[29];
  await showLibrary(page);
  await page.getByRole('button', { name: 'Next page' }).click();
  await openButton(page, item).click();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(item.captions[0].text);
  const gate = deferred();
  await page.route(/\/api\/projects\?summary=1$/, async (route) => {
    await gate.promise;
    await route.fulfill({ json: state.projects.map(summarizeProject) });
  });
  try {
    await page.getByLabel('Back to Home', { exact: true }).click();
    await expect(openButton(page, item)).toBeFocused();
    const search = page.getByRole('searchbox', { name: 'Search projects' });
    await search.fill('Vintage');
    item.updatedAt = '2027-01-01T00:00:00.000Z';
    gate.resolve();
    await expect(page.getByText('Project list loaded.')).toBeVisible();
    await expect(search).toBeFocused();
    await expect(openButtons(page)).toHaveCount(1);
    await expect(openButton(page, state.projects[30])).toBeVisible();
  } finally { gate.resolve(); }
});

test('failed project detail read keeps results available, exposes the error, and allows retry', async ({ page }) => {
  const state = await fixtureLibrary(page);
  let fail = true;
  const item = state.projects[0];
  await page.route(`**/api/projects/${item.id}`, (route) => route.fulfill({
    status: fail ? 503 : 200,
    json: fail ? { error: 'Synthetic library detail read failure' } : item,
  }));
  await showLibrary(page);
  await openButton(page, item).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic library detail read failure' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All projects', exact: true })).toBeVisible();
  await expect(openButton(page, item)).toBeEnabled();
  fail = false;
  await openButton(page, item).click();
  await expect(page.locator('.project-title strong')).toHaveText(item.title);
});

test('a deferred library open cannot overwrite the later selected project', async ({ page }) => {
  const state = await fixtureLibrary(page);
  const entered = deferred();
  const release = deferred();
  const finished = deferred();
  let enteredRequest = false;
  const olderRequest = state.projects[0];
  const newerRequest = state.projects[1];
  await page.route(`**/api/projects/${olderRequest.id}`, async (route) => {
    enteredRequest = true;
    entered.resolve();
    try {
      await release.promise;
      await route.fulfill({ json: olderRequest }).catch(() => {});
    } finally { finished.resolve(); }
  });
  try {
    await showLibrary(page);
    await openButton(page, olderRequest).click();
    await entered.promise;
    await expect(openButton(page, olderRequest)).toContainText('Opening…');
    await openButton(page, newerRequest).click();
    await expect(page.locator('.project-title strong')).toHaveText(newerRequest.title);
    release.resolve();
    await finished.promise;
    await expect(page.locator('.project-title strong')).toHaveText(newerRequest.title);
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(newerRequest.captions[0].text);
  } finally {
    release.resolve();
    // A navigation abort can leave its route handler in flight until the gate
    // releases. Drain it before the fixture/harness tears down the page.
    if (enteredRequest) await finished.promise;
  }
});

test('Back to Home invalidates a deferred open and restores keyboard focus', async ({ page }) => {
  const state = await fixtureLibrary(page);
  const entered = deferred();
  const release = deferred();
  const finished = deferred();
  let enteredRequest = false;
  await page.route(`**/api/projects/${state.projects[0].id}`, async (route) => {
    enteredRequest = true;
    entered.resolve();
    try {
      await release.promise;
      await route.fulfill({ json: state.projects[0] }).catch(() => {});
    } finally { finished.resolve(); }
  });
  try {
    await showLibrary(page);
    await openButton(page, state.projects[0]).click();
    await entered.promise;
    await page.getByRole('button', { name: 'Back to Home' }).click();
    const homeProjects = page.getByRole('button', { name: 'All projects', exact: true });
    await expect(homeProjects).toBeFocused();
    release.resolve();
    await finished.promise;
    await expect(page.getByRole('heading', { name: 'All projects', exact: true })).toHaveCount(0);
    await expect(page.locator('.project-title strong')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Recent projects' })).toBeVisible();
  } finally {
    release.resolve();
    if (enteredRequest) await finished.promise;
  }
});

test('library distinguishes pending list, failed load with retry, and an empty collection', async ({ page }) => {
  const state = await fixtureLibrary(page);
  const entered = deferred();
  const release = deferred();
  let phase: 'initial' | 'retry' = 'initial';
  let listAttempts = 0;
  let retryAttempts = 0;
  const completedRoutes: Promise<void>[] = [];
  await page.route(/\/api\/projects\?summary=1$/, async (route) => {
    listAttempts += 1;
    // React StrictMode may start multiple independent summary fetches before
    // the first mount's disposed callback returns. Every request captures its
    // phase on entry; an initial request can never return retry's success data.
    const requestPhase = phase;
    const completed = deferred();
    completedRoutes.push(completed.promise);
    try {
      if (requestPhase === 'initial') {
        entered.resolve();
        await release.promise;
        await route.fulfill({ status: 503, json: { error: 'Synthetic library summary failure' } }).catch(() => {});
      } else {
        retryAttempts += 1;
        await route.fulfill({ json: state.projects.map(summarizeProject) });
      }
    } finally {
      completed.resolve();
    }
  });
  try {
    await page.goto('/');
    await entered.promise;
    await page.getByRole('button', { name: 'All projects', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'All projects', exact: true })).toBeVisible();
    await expect(page.getByText(/loading projects/i)).toBeVisible();
    await expect(openButtons(page)).toHaveCount(0);
    release.resolve();
    await expect(page.getByRole('button', { name: 'Retry projects' })).toBeVisible();
    await expect(openButtons(page)).toHaveCount(0);
    await Promise.all(completedRoutes);
    const initialAttempts = listAttempts;
    expect(initialAttempts).toBeGreaterThanOrEqual(1);
    expect(retryAttempts).toBe(0);
    phase = 'retry';
    await page.getByRole('button', { name: 'Retry projects' }).click();
    await expect(openButtons(page)).toHaveCount(24);
    await expect(resultCountHeading(page)).toBeFocused();
    expect(listAttempts).toBe(initialAttempts + 1);
    expect(retryAttempts).toBe(1);
  } finally {
    release.resolve();
    await Promise.allSettled(completedRoutes);
  }
});

test('an empty library has an explicit empty state separate from failed loading', async ({ page }) => {
  const state = await installFixture(page);
  state.projects = [];
  await page.goto('/');
  await expect(page.locator('.dropzone')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recent projects' })).toHaveCount(0);
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'All projects', exact: true })).toBeVisible();
  await expect(openButtons(page)).toHaveCount(0);
  await expect(page.getByText(/no projects yet/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry projects' })).toHaveCount(0);
});

test('project library stays readable, scroll-safe and accessible at desktop and narrow widths', async ({ page }, testInfo) => {
  const state = await fixtureLibrary(page);
  await showLibrary(page);
  for (const { width, height } of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
    await page.setViewportSize({ width, height });
    await expect(openButtons(page)).toHaveCount(24);
    const measured = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(measured.documentWidth, `document overflows at ${width}px`).toBeLessThanOrEqual(measured.viewport + 1);
    expect(measured.bodyWidth, `body overflows at ${width}px`).toBeLessThanOrEqual(measured.viewport + 1);
    const controls = [
      page.getByRole('button', { name: 'Back to Home' }),
      page.getByRole('searchbox', { name: 'Search projects' }),
      page.getByRole('combobox', { name: 'Sort projects' }),
      openButtons(page).first(),
      page.getByRole('button', { name: 'Next page' }),
    ];
    for (const control of controls) {
      const rect = await control.boundingBox();
      expect(rect?.height ?? 0, `control height at ${width}px`).toBeGreaterThanOrEqual(44);
      expect(rect?.width ?? 0, `control width at ${width}px`).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: testInfo.outputPath(`project-library-${width}.png`), fullPage: true });
    await page.screenshot({ path: testInfo.outputPath(`project-library-viewport-${width}.png`) });
    if (width === 320) {
      const search = page.getByRole('searchbox', { name: 'Search projects' });
      await search.fill(ARCHIVED_TITLE);
      await expect(openButtons(page)).toHaveCount(1);
      await expect(openButton(page, state.projects[30])).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('project-library-khmer-title-viewport-320.png') });
      await page.getByRole('button', { name: 'Clear search' }).click();
      await expect(openButtons(page)).toHaveCount(24);
    }
  }
});
