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
  await expect(page.getByRole('button', { name: 'View all projects' })).toBeVisible();
  await page.getByRole('button', { name: 'View all projects' }).click();
  await expect(page.getByRole('heading', { name: 'All projects', exact: true })).toBeVisible();
}

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
  await page.getByLabel('Back to projects', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'All projects', exact: true })).toBeFocused();
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

test('Back to projects flushes caption and Accuracy edits and retains query, created sort, and second page', async ({ page }) => {
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

  await page.getByRole('button', { name: /^Accuracy/ }).click();
  await page.getByLabel('What is this clip about?', { exact: true }).fill(savedAccuracy);
  await page.getByLabel('Caption 1 text', { exact: true }).fill(savedCaption);
  await page.getByLabel('Back to projects', { exact: true }).click();

  await expect(page.getByRole('heading', { name: 'All projects', exact: true })).toBeFocused();
  await expect.poll(() => item.captions[0].text).toBe(savedCaption);
  await expect.poll(() => item.transcriptionContext?.description).toBe(savedAccuracy);
  await expect(search).toHaveValue('Project');
  await expect(sort).toHaveValue('created');
  await expect(openButtons(page)).toHaveCount(7);
  await expect(openButton(page, item)).toBeVisible();

  await openButton(page, item).click();
  await expect(page.locator('.project-title strong')).toHaveText(item.title);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(savedCaption);
  await page.getByRole('button', { name: /^Accuracy/ }).click();
  await expect(page.getByLabel('What is this clip about?', { exact: true })).toHaveValue(savedAccuracy);
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
