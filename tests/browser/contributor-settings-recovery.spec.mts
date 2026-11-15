import { test as base, expect, type Page } from '@playwright/test';
import type { AppProfile, ContributionStatus } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

let state: FixtureState;
let progress: ContributionStatus;
let saveSerial: number;
let requests: Array<{ path: string; method: string; body: Partial<AppProfile> | null }>;
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const privacy = (page: Page) => page.locator('.privacy-settings');
const verified = (page: Page) => privacy(page).locator('.contributor-stats > div').first().locator('b');
const contributorOn = (page: Page) => privacy(page).getByRole('button', { name: /^(Help improve Khmer captions|Helping improve Khmer captions)$/, exact: true });
const analyticsOn = (page: Page) => privacy(page).getByRole('button', { name: /^(Share product analytics|Product analytics is on)$/, exact: true });
const mutations = () => requests.filter((request) => !['GET', 'HEAD'].includes(request.method));
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function acknowledge(patch: Partial<AppProfile>) {
  state.profile = {
    ...state.profile, ...patch,
    preferences: { ...state.profile.preferences, ...patch.preferences },
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++saveSerial)).toISOString(),
  };
  progress = { ...progress, consent: state.profile.preferences.khmerContributionConsent || 'unset' };
  return structuredClone(state.profile);
}
async function openSettings(page: Page) {
  await openProject(page);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await expect(settings(page)).toBeVisible();
}
async function choosePrivacy(page: Page) {
  await settings(page).getByRole('button', { name: 'Privacy', exact: true }).click();
  await expect(privacy(page)).toBeVisible();
}
async function openPrivacy(page: Page) {
  await openSettings(page);
  await choosePrivacy(page);
}
async function nextPaint(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.preferences.waveformZoom = 3;
  progress = { consent: 'declined', endpointConfigured: false, contributorEnrolled: false, queued: 0, submitted: 2, verified: 4, rejected: 0, withdrawn: 0, verifiedAudioMs: 6000, withdrawalPending: false };
  saveSerial = 0; requests = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path !== '/api/profile' && !path.startsWith('/api/contribution/')) return;
    requests.push({ path, method: request.method(), body: request.method() === 'PATCH' ? request.postDataJSON() : null });
  });
  await page.route('**/api/profile', (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    return route.fulfill({ json: acknowledge(route.request().postDataJSON()) });
  });
  await page.route('**/api/contribution/status', (route) => route.fulfill({ json: structuredClone(progress) }));
});

test('an old opening read cannot replace a saved choice or feed stale preferences into the next choice', async ({ page }) => {
  await openSettings(page);
  const gate = deferred();
  let phase: 'opening' | 'after-save' = 'opening';
  let profilesHeld = 0; let statusesHeld = 0; let finished = 0;
  const oldProfile = structuredClone(state.profile);
  const oldProgress = structuredClone(progress);
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() === 'PATCH') {
      phase = 'after-save';
      return route.fallback();
    }
    if (route.request().method() !== 'GET' || phase !== 'opening') return route.fallback();
    profilesHeld++;
    await gate.promise;
    try { await route.fulfill({ json: oldProfile }); } finally { finished++; }
  });
  await page.route('**/api/contribution/status', async (route) => {
    if (phase !== 'opening') return route.fallback();
    statusesHeld++;
    await gate.promise;
    try { await route.fulfill({ json: oldProgress }); } finally { finished++; }
  });
  try {
    await choosePrivacy(page);
    await expect.poll(() => profilesHeld > 0 && statusesHeld > 0).toBe(true);
    await expect(privacy(page).getByText('Loading contribution status…', { exact: true })).toBeVisible();
    progress = { ...progress, verified: 9 };
    await contributorOn(page).click();
    await expect(contributorOn(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(privacy(page).getByText('Khmer Caption Contributor choice saved: on.', { exact: true })).toBeVisible();
    await expect(verified(page)).toHaveText('9');
    const heldTotal = profilesHeld + statusesHeld;
    gate.release();
    await expect.poll(() => finished).toBe(heldTotal);
    await nextPaint(page);
    await expect(contributorOn(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(verified(page)).toHaveText('9');
    await analyticsOn(page).click();
    await expect(analyticsOn(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(privacy(page).getByText('Product analytics choice saved: on.', { exact: true })).toBeVisible();
    expect(mutations()).toHaveLength(2);
    expect(mutations()[1].body?.preferences).toMatchObject({ khmerContributionConsent: 'granted', analyticsConsent: 'granted', waveformZoom: 3, reviewPreRollMs: 100 });
    expect(mutations().every((request) => request.path === '/api/profile' && request.method === 'PATCH')).toBe(true);
  } finally { gate.release(); }
});

for (const scenario of [{ failed: 'status', width: 1440 }, { failed: 'profile', width: 390 }] as const) {
  test('an unavailable ' + scenario.failed + ' read has a read-only retry with retained focus at ' + scenario.width + 'px', async ({ page }, info) => {
    await page.setViewportSize({ width: scenario.width, height: 1000 });
    await openSettings(page);
    const gate = deferred();
    let fail = true; let retryStarted = false;
    const path = scenario.failed === 'profile' ? '**/api/profile' : '**/api/contribution/status';
    await page.route(path, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      if (fail) return route.fulfill({ status: 503, json: { error: 'Synthetic unavailable privacy read' } });
      retryStarted = true;
      await gate.promise;
      return route.fulfill({ json: scenario.failed === 'profile' ? structuredClone(state.profile) : structuredClone(progress) });
    });
    try {
      await choosePrivacy(page);
      await expect(privacy(page).getByRole('alert')).toContainText('The last loaded choices are shown.');
      await expect(privacy(page).locator('.contributor-stats')).toHaveCount(0);
      await expect(privacy(page).getByRole('button', { name: 'Keep my work private', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(privacy(page).getByRole('button', { name: 'Keep analytics off', exact: true })).toHaveAttribute('aria-pressed', 'true');
      const retry = privacy(page).getByRole('button', { name: 'Retry status', exact: true });
      await retry.focus();
      await page.screenshot({ path: info.outputPath('privacy-unavailable-' + scenario.failed + '-' + scenario.width + '.png'), animations: 'disabled' });
      const before = requests.length;
      fail = false;
      await retry.press('Enter');
      await expect.poll(() => retryStarted).toBe(true);
      const checking = privacy(page).getByRole('button', { name: 'Checking status…', exact: true });
      await expect(checking).toBeFocused();
      await expect(checking).toHaveAttribute('aria-disabled', 'true');
      await checking.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      await expect.poll(() => requests.slice(before).filter((request) => request.path === '/api/profile').length).toBe(1);
      expect(requests.slice(before).filter((request) => request.path === '/api/contribution/status')).toHaveLength(1);
      gate.release();
      const recovered = privacy(page).getByRole('button', { name: 'Refresh status', exact: true });
      await expect(recovered).toBeFocused();
      await expect(recovered).not.toHaveAttribute('aria-disabled', 'true');
      await expect(privacy(page).getByRole('alert')).toHaveCount(0);
      await expect(verified(page)).toHaveText('4');
      expect(mutations()).toHaveLength(0);
      expect(requests.slice(before).every((request) => request.method === 'GET')).toBe(true);
      expect(await settings(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath('privacy-recovered-' + scenario.failed + '-' + scenario.width + '.png'), animations: 'disabled' });
    } finally { gate.release(); }
  });
}

test('a failed privacy save retains the last choice and allows one explicit retry', async ({ page }, info) => {
  const gate = deferred();
  let saves = 0;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    saves++;
    if (saves === 1) {
      await gate.promise;
      return route.fulfill({ status: 503, json: { error: 'Synthetic privacy save failure' } });
    }
    return route.fulfill({ json: acknowledge(route.request().postDataJSON()) });
  });
  try {
    await openPrivacy(page);
    await expect(verified(page)).toHaveText('4');
    await analyticsOn(page).evaluate((button: HTMLButtonElement) => { button.focus(); button.click(); button.click(); });
    await expect.poll(() => saves).toBe(1);
    await expect(analyticsOn(page)).toBeDisabled();
    await expect(privacy(page).getByText('Saving your privacy choice…', { exact: true })).toBeVisible();
    await privacy(page).getByText('Saving your privacy choice…', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('privacy-save-pending.png'), animations: 'disabled' });
    gate.release();
    await expect(privacy(page).getByRole('alert')).toContainText('Could not confirm your privacy choice was saved.');
    await expect(analyticsOn(page)).toBeEnabled();
    await expect(analyticsOn(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(privacy(page).getByRole('button', { name: 'Keep analytics off', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(privacy(page).getByText('Product analytics choice saved: on.', { exact: true })).toHaveCount(0);
    await analyticsOn(page).click();
    await expect(privacy(page).getByText('Product analytics choice saved: on.', { exact: true })).toBeVisible();
    await expect(analyticsOn(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(privacy(page).getByRole('alert')).toHaveCount(0);
    expect(saves).toBe(2);
    expect(mutations()).toHaveLength(2);
    expect(mutations()[1].body).toEqual(mutations()[0].body);
    expect(state.profile.preferences.khmerContributionConsent).toBe('declined');
  } finally { gate.release(); }
});

test('an acknowledged choice remains saved when its status refresh fails and Retry never resubmits it', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await openPrivacy(page);
  await expect(verified(page)).toHaveText('4');
  let fail = true;
  let retryGate: ReturnType<typeof deferred> | null = null;
  await page.route('**/api/contribution/status', async (route) => {
    const gate = retryGate;
    if (gate) await gate.promise;
    return fail
      ? route.fulfill({ status: 503, json: { error: 'Synthetic post-save status failure' } })
      : route.fulfill({ json: structuredClone(progress) });
  });
  const beforeSave = requests.length;
  await contributorOn(page).click();
  await expect(privacy(page).getByText('Khmer Caption Contributor choice saved: on.', { exact: true })).toBeVisible();
  await expect(contributorOn(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(privacy(page).getByRole('alert')).toContainText('Contribution status could not be refreshed.');
  await expect(privacy(page).getByRole('alert')).toContainText('The last loaded progress is shown.');
  await expect(verified(page)).toHaveText('4');
  await expect(privacy(page).getByText('Could not confirm your privacy choice was saved. Try that choice again.', { exact: true })).toHaveCount(0);
  await nextPaint(page);
  expect(requests.slice(beforeSave).filter((request) => request.path === '/api/profile' && request.method === 'GET')).toEqual([]);
  const retry = privacy(page).getByRole('button', { name: 'Retry status', exact: true });
  await retry.focus();
  await page.screenshot({ path: info.outputPath('privacy-saved-status-unavailable-390.png'), animations: 'disabled' });
  const before = requests.length;
  const gate = deferred();
  retryGate = gate;
  try {
    await retry.press('Enter');
    const checking = privacy(page).getByRole('button', { name: 'Checking status…', exact: true });
    await expect(checking).toBeFocused();
    await expect(checking).toHaveAttribute('aria-disabled', 'true');
    await checking.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => requests.slice(before).filter((request) => request.path === '/api/contribution/status').length).toBe(1);
    expect(requests.slice(before).filter((request) => request.path === '/api/profile')).toEqual([]);
    expect(mutations()).toHaveLength(1);
    gate.release();
    await expect(retry).toBeFocused();
    await expect(privacy(page).getByRole('alert')).toContainText('Contribution status could not be refreshed.');
    await expect(contributorOn(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(privacy(page).getByText('Khmer Caption Contributor choice saved: on.', { exact: true })).toBeVisible();
  } finally { gate.release(); retryGate = null; }
  fail = false; progress = { ...progress, verified: 6 };
  await retry.press('Enter');
  await expect(verified(page)).toHaveText('6');
  await expect(privacy(page).getByRole('button', { name: 'Refresh status', exact: true })).toBeFocused();
  await expect(contributorOn(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(privacy(page).getByText('Khmer Caption Contributor choice saved: on.', { exact: true })).toBeVisible();
  expect(mutations()).toHaveLength(1);
  expect(requests.slice(before).every((request) => request.method === 'GET')).toBe(true);
  expect(requests.slice(before).filter((request) => request.path === '/api/profile')).toEqual([]);
  expect(requests.slice(before).filter((request) => request.path === '/api/contribution/status')).toHaveLength(2);
  expect(requests.some((request) => request.path === '/api/contribution/sync' || request.path === '/api/contribution/withdraw')).toBe(false);
});

test('an unrelated parent acknowledgement cannot revive contribution after withdrawal', async ({ page }) => {
  state.profile.preferences.khmerContributionConsent = 'granted';
  progress = { ...progress, consent: 'granted' };
  const gate = deferred();
  let preferenceStarted = false;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const patch = route.request().postDataJSON() as Partial<AppProfile>;
    if (patch.preferences?.waveformZoom !== 1 || Object.keys(patch.preferences).length !== 1) return route.fallback();
    acknowledge(patch);
    preferenceStarted = true;
    await gate.promise;
    // The receipt includes the current withdrawn consent, but this parent's
    // preference-only acknowledgement owns waveformZoom, not privacy fields.
    return route.fulfill({ json: structuredClone(state.profile) });
  });
  await page.route('**/api/contribution/withdraw', (route) => {
    acknowledge({ preferences: { ...state.profile.preferences, khmerContributionConsent: 'declined' } });
    progress = { ...progress, withdrawalPending: true };
    return route.fulfill({ json: structuredClone(progress) });
  });
  try {
    await openProject(page);
    await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
    await expect(page.locator('.fine-timing')).toBeVisible();
    await expect(page.locator('.waveform-loading')).toHaveCount(0);
    await page.getByRole('button', { name: 'Full clip', exact: true }).click();
    await expect.poll(() => preferenceStarted).toBe(true);
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /^Settings/ }).click();
    await choosePrivacy(page);
    await expect(contributorOn(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(verified(page)).toHaveText('4');

    const withdrawalRefresh = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().endsWith('/api/profile'));
    page.once('dialog', (dialog) => dialog.accept());
    await privacy(page).getByRole('button', { name: 'Request deletion', exact: true }).click();
    await (await withdrawalRefresh).finished();
    const privateChoice = privacy(page).getByRole('button', { name: 'Keep my work private', exact: true });
    await expect(privateChoice).toHaveAttribute('aria-pressed', 'true');
    await expect(privacy(page).getByText('Refreshing contribution status…', { exact: true })).toHaveCount(0);

    // This unrelated parent transition must still refresh the profile. Merely
    // reading status would keep the parent's older granted consent selected.
    const parentRefresh = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().endsWith('/api/profile'));
    gate.release();
    await (await parentRefresh).finished();
    await expect(privateChoice).toHaveAttribute('aria-pressed', 'true');
    await expect(contributorOn(page)).toHaveAttribute('aria-pressed', 'false');
    await analyticsOn(page).click();
    await expect(privacy(page).getByText('Product analytics choice saved: on.', { exact: true })).toBeVisible();
    const profileWrites = mutations().filter((request) => request.path === '/api/profile');
    expect(profileWrites).toHaveLength(2);
    expect(profileWrites[0].body?.preferences).toEqual({ waveformZoom: 1 });
    expect(profileWrites[1].body?.preferences).toMatchObject({ waveformZoom: 1, khmerContributionConsent: 'declined', analyticsConsent: 'granted' });
    expect(mutations().filter((request) => request.path === '/api/contribution/withdraw')).toHaveLength(1);
    expect(state.profile.preferences.khmerContributionConsent).toBe('declined');
  } finally { gate.release(); }
});

test('a read from a closed privacy panel cannot change its reopened state or newer keyboard focus', async ({ page }) => {
  await openSettings(page);
  const gate = deferred();
  let phase: 'first-open' | 'reopened' = 'first-open';
  let held = 0; let finished = 0;
  const old = structuredClone(progress);
  await page.route('**/api/contribution/status', async (route) => {
    if (phase !== 'first-open') return route.fallback();
    held++; await gate.promise;
    try { await route.fulfill({ json: old }); } finally { finished++; }
  });
  try {
    await choosePrivacy(page);
    await expect.poll(() => held).toBeGreaterThan(0);
    await expect(privacy(page).getByText('Loading contribution status…', { exact: true })).toBeVisible();
    await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(privacy(page)).toHaveCount(0);
    progress = { ...progress, verified: 8 };
    phase = 'reopened';
    await choosePrivacy(page);
    await expect(verified(page)).toHaveText('8');
    const newerFocus = privacy(page).getByRole('button', { name: 'Keep analytics off', exact: true });
    await newerFocus.focus();
    const heldTotal = held;
    gate.release(); await expect.poll(() => finished).toBe(heldTotal);
    await nextPaint(page);
    await expect(verified(page)).toHaveText('8');
    await expect(newerFocus).toBeFocused();
    expect(mutations()).toHaveLength(0);
  } finally { gate.release(); }
});

test('the existing privacy introduction returns an acknowledged choice through the same form', async ({ page }) => {
  state.profile.preferences.analyticsConsent = 'unset';
  state.profile.preferences.khmerContributionConsent = 'unset';
  state.profile.preferences.privacyUpgradeNoticeVersion = undefined;
  progress = { ...progress, consent: 'unset', endpointConfigured: true, submitted: 0, verified: 0 };
  await page.goto('/');
  const intro = page.getByRole('dialog', { name: 'Help make Khmer captions world-class', exact: true });
  await expect(intro).toBeVisible();
  await intro.getByRole('button', { name: 'Review privacy & analytics settings', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Privacy choices', exact: true });
  await expect(review).toBeVisible();
  await expect(privacy(page)).toBeVisible();
  await expect(verified(page)).toHaveText('0');
  expect(state.profile.preferences.analyticsConsent).toBe('unset');
  expect(state.profile.preferences.khmerContributionConsent).toBe('unset');
  const beforeChoice = requests.length;
  await analyticsOn(page).click();
  await expect(privacy(page).getByText('Product analytics choice saved: on.', { exact: true })).toBeVisible();
  await expect(analyticsOn(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(privacy(page).getByRole('alert')).toHaveCount(0);
  await nextPaint(page);
  expect(requests.slice(beforeChoice).filter((request) => request.path === '/api/profile' && request.method === 'GET')).toEqual([]);
  expect(state.profile.preferences.analyticsConsent).toBe('granted');
  expect(state.profile.preferences.khmerContributionConsent).toBe('unset');
  expect(mutations()).toHaveLength(2);
  expect(mutations()[0].body?.preferences).toMatchObject({ analyticsConsent: 'unset', khmerContributionConsent: 'unset' });
  expect(mutations()[1].body?.preferences).toMatchObject({ analyticsConsent: 'granted', khmerContributionConsent: 'unset' });
  expect(mutations().every((request) => request.path === '/api/profile' && request.method === 'PATCH')).toBe(true);
});
