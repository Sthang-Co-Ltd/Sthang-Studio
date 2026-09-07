import { test, expect } from '@playwright/test';
import { cleanFixtures, installFixture, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

test('recent projects and editing do not wait for a stalled health endpoint', async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/health', async (route) => {
    await gate;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic unavailable health"}' }).catch(() => {});
  });
  try {
    await page.goto('/');
    const card = page.getByRole('button', { name: /Audit landscape/ });
    await expect(card).toBeEnabled();
    await card.click();
    await expect(page.locator('.caption-row textarea').first()).toHaveValue(state.projects[0].captions[0].text);
    expect(state.requests.some((request) => request.path === '/api/projects/landscape')).toBe(true);
  } finally { release(); }
});

test('a slower earlier project request cannot overwrite the last clicked project', async ({ page }) => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const requested = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fulfilled: () => void = () => {};
  const finished = new Promise<void>((resolve) => { fulfilled = resolve; });
  await page.route('**/api/projects/landscape', async (route) => {
    entered(); await gate;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.projects[0]) }).catch(() => {});
    fulfilled();
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Audit landscape/ }).click();
    await requested;
    await page.getByRole('button', { name: /Audit second/ }).click();
    await expect(page.locator('.project-title strong')).toHaveText('Audit second');
    release(); await finished;
    await expect(page.locator('.project-title strong')).toHaveText('Audit second');
  } finally { release(); }
});

test('failed project open leaves the library available and can be retried', async ({ page }) => {
  let fail = true;
  await page.route('**/api/projects/landscape', (route) => route.fulfill({
    status: fail ? 503 : 200, contentType: 'application/json',
    body: JSON.stringify(fail ? { error: 'Synthetic project read failure' } : state.projects[0]),
  }));
  await page.goto('/');
  const card = page.getByRole('button', { name: /Audit landscape/ });
  await card.click();
  await expect(page.getByRole('alert')).toContainText('Synthetic project read failure');
  await expect(card).toBeEnabled();
  fail = false; await card.click();
  await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
});

test('advanced workspace code is deferred and a failed chunk leaves the editor usable', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(new URL(request.url()).pathname));
  await page.goto('/');
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(page.locator('.caption-row')).toHaveCount(3);
  expect(requested.some((url) => url.includes('/components/WaveformEditor.tsx'))).toBe(false);
  await page.route('**/components/WaveformEditor.tsx*', (route) => route.abort());
  await page.getByRole('button', { name: /Fine timing/ }).click();
  await expect(page.getByRole('alert')).toContainText('This tool could not load');
  const editor = page.locator('.caption-row textarea').first();
  await editor.fill('ខ្មែរ remains editable');
  await expect(editor).toHaveValue('ខ្មែរ remains editable');
});


test('startup retry does not refetch already loaded preferences', async ({ page }) => {
  let healthRequests = 0;
  await page.route('**/api/health', (route) => {
    healthRequests += 1;
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic offline status"}' });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Audit landscape/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Retry startup' })).toBeVisible();
  const profiles = state.requests.filter((request) => request.path === '/api/profile').length;
  await page.getByRole('button', { name: 'Retry startup' }).click();
  await expect.poll(() => healthRequests).toBeGreaterThan(1);
  await expect(page.getByRole('button', { name: 'Retry startup' })).toBeVisible();
  expect(state.requests.filter((request) => request.path === '/api/profile').length).toBe(profiles);
});
