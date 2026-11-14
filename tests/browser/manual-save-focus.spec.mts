import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';
import { openAccuracy } from './accuracy-workspace.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    try { await use(context); }
    finally { await closeOwnedBrowserContext(context); }
  },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const save = (page: Page) => page.locator('.save-action');
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function activateAgain(button: Locator) {
  // Use native keyboard activation: aria-disabled alone cannot block either key.
  await button.press('Enter');
  await button.press('Space');
  await button.press('Enter');
}

for (const width of [1440, 390]) for (const outcome of ['success', 'failure'] as const) {
  test(`Header Save preserves focus and its gates after ${outcome} at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const gate = deferred();
    const writes: Array<{ path: string; source?: string }> = [];
    // Caption blur has its own ordinary text-edit save. Accuracy has no blur save,
    // so the narrow cases also exercise a request submitted directly by Header Save.
    const path = width === 1440 ? 'captions' : 'context';
    // After a failed blur write, the explicit Save still makes its one manual attempt.
    const expectedSettledWrites = width === 1440 && outcome === 'failure' ? 2 : 1;
    let composing = false;
    let field: Locator | undefined;
    await page.route(`**/api/projects/landscape/${path}`, async (route) => {
      const body = route.request().postDataJSON();
      writes.push({ path, source: body.source });
      await gate.promise;
      if (outcome === 'failure') return route.fulfill({
        status: width === 390 ? 409 : 503,
        json: { error: width === 390 ? 'Synthetic saved-project conflict' : 'Synthetic save failure' },
      });
      state.projects[0] = {
        ...state.projects[0],
        ...(path === 'captions' ? { captions: body.captions } : { transcriptionContext: body.transcriptionContext }),
        updatedAt: '2026-11-14T08:00:00.000Z',
      };
      return route.fulfill({ json: path === 'captions' ? { project: state.projects[0], correctionsCreated: 0 } : state.projects[0] });
    });
    try {
      await openProject(page);
      const action = save(page);
      await expect(action).toHaveAttribute('aria-disabled', 'true');
      await expect(action).toHaveAttribute('tabindex', '-1');
      expect(await action.evaluate((node: HTMLButtonElement) => node.disabled)).toBe(false);
      await action.focus();
      await activateAgain(action);
      expect(writes).toHaveLength(0);
      await expect(action).not.toHaveAttribute('aria-busy');
      await expect(action).not.toHaveAttribute('data-save-confirmed');

      field = path === 'captions' ? page.getByLabel('Caption 1 text', { exact: true }) : (await openAccuracy(page)).description;
      await field.fill('Submitted manual-save sample');
      await expect(action).not.toHaveAttribute('aria-disabled');
      await expect(action).toHaveAttribute('tabindex', '0');
      await action.focus();
      await action.press('Enter');
      await expect.poll(() => writes.length).toBe(1);
      await expect(action).toHaveAttribute('aria-busy', 'true');
      await expect(action).toHaveAttribute('aria-disabled', 'true');
      await expect(action).toHaveAttribute('tabindex', '-1');
      await expect(action).toBeFocused();
      await expect(action).toBeInViewport();
      await expect(action).not.toHaveAttribute('data-save-confirmed');
      await activateAgain(action);
      expect(writes).toHaveLength(1);
      if (path === 'captions') expect(writes.map((write) => write.source)).toEqual(['text-edit']);
      await page.screenshot({ path: info.outputPath(`save-pending-focus-${width}-${outcome}.png`) });

      if (width === 390) {
        await field.focus();
        if (outcome === 'success') await field.fill('Newer Accuracy wording stays unsaved');
        await expect(field).toBeFocused();
      }
      gate.release();
      await expect(action).not.toHaveAttribute('aria-busy');
      if (width === 1440) await expect(action).toBeFocused();
      else await expect(field).toBeFocused();
      expect(writes).toHaveLength(expectedSettledWrites);
      if (width === 1440 && outcome === 'failure') expect(writes.map((write) => write.source)).toEqual(['text-edit', 'manual-save']);

      if (outcome === 'success' && width === 1440) {
        await expect(action.locator('.save-action-label')).toHaveText('Saved');
        await expect(action).toHaveAttribute('data-save-confirmed', 'true');
        await expect(action.getByRole('status')).toHaveText('Changes saved.');
        await expect(action).toHaveAttribute('aria-disabled', 'true');
        await expect(action).toHaveAttribute('tabindex', '-1');
        await activateAgain(action);
        expect(writes).toHaveLength(1);
      } else {
        await expect(action).not.toHaveAttribute('data-save-confirmed');
        await expect(action.getByRole('status')).toBeEmpty();
        await expect(action.locator('.save-action-label')).toHaveText('Save');
        if (outcome === 'success') {
          await expect(field).toHaveValue('Newer Accuracy wording stays unsaved');
          expect(state.projects[0].transcriptionContext?.description).toBe('Submitted manual-save sample');
        } else {
          await expect(page.getByRole('button', { name: width === 390 ? 'Reload saved project' : 'Retry save', exact: true })).toBeVisible();
          if (width === 390) {
            await expect(action).toHaveAttribute('aria-disabled', 'true');
            await expect(action).toHaveAttribute('tabindex', '-1');
            await action.focus();
            await activateAgain(action);
            await expect(action).not.toHaveAttribute('aria-busy');
            await expect(action).toBeFocused();
          } else {
            await expect(action).not.toHaveAttribute('aria-disabled');
            await expect(action).toHaveAttribute('tabindex', '0');
            await field.focus();
            await field.dispatchEvent('compositionstart'); composing = true;
            await expect(action).toHaveAttribute('aria-disabled', 'true');
            await expect(action).toHaveAttribute('tabindex', '-1');
            await action.focus();
            await activateAgain(action);
            await expect(action).not.toHaveAttribute('aria-busy');
            await expect(page.getByText('Finish the current text input before saving or leaving.', { exact: true })).toHaveCount(0);
            await field.dispatchEvent('compositionend'); composing = false;
            await expect(action).not.toHaveAttribute('aria-disabled');
          }
          expect(writes).toHaveLength(expectedSettledWrites);
        }
      }
    } finally {
      gate.release();
      if (composing && field) await field.dispatchEvent('compositionend');
    }
  });
}
