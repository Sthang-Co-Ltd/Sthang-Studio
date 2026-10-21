import { test, expect, type Page, type Route } from '@playwright/test';
import { hydrateCaptionWordTimings, type CaptionProject } from '@kcs/shared';
import { cleanFixtures, fixtureMedia, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function multipartField(route: Route, name: string) {
  const body = route.request().postDataBuffer()?.toString('utf8') || '';
  return new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body)?.[1];
}
async function chooseFile(page: Page, filename = 'synthetic-regraded.mp4') {
  await page.getByLabel('Open project tools', { exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /^Replace media/ }).click();
  await (await chooser).setFiles({ name: filename, mimeType: 'video/mp4', buffer: fixtureMedia() });
  const dialog = page.getByRole('dialog', { name: 'Replace media', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
function noGeneration(state: FixtureState) {
  expect(state.requests.filter((r) => r.method === 'POST' && /(?:\/jobs|\/transcribe|\/regenerate-range|\/refine-proposal|\/postprocess-timing|\/resegment|\/caption-word-timing(?:\/batch-apply)?)$/.test(r.path))).toEqual([]);
}
async function fixture(page: Page) {
  const state = await installFixture(page);
  state.projects[0] = hydrateCaptionWordTimings(state.projects[0]);
  state.projects[0].captions[0] = { ...state.projects[0].captions[0], approved: true, textLocked: true, timingLocked: true };
  state.projects[0].transcriptNeedsSync = true;
  state.projects[0].transcriptionContext = { description: 'Saved synthetic context', vocabulary: ['SavedBrand | saved alias'] };
  const original = structuredClone(state.projects[0]);
  const replacements: Array<{id: string; mode: string; createdAt: string; previousOriginalName: string}> = [];
  // Route-mocked checkpoint contents, not evidence of a real durable disk backup.
  const backupSnapshots: CaptionProject[] = [];
  const requests: Array<{ mode: string | undefined; expectedMedia: unknown; expectedUpdatedAt: string | undefined; audioChangeConfirmation?: string }> = [];
  let hold: Promise<void> | undefined;
  let error: { status: number; message: string; code: string } | undefined;
  let changedAudio = false;
  let challenge: { token: string; expectedUpdatedAt: string; filename: string } | undefined;
  let challenges = 0;
  let restores = 0;
  await page.route('**/api/projects/*/media-replacements', (route) => route.fulfill({ json: replacements }));
  await page.route('**/api/projects/landscape/replace-media', async (route) => {
    const mode = multipartField(route, 'mode');
    const identity = multipartField(route, 'expectedMedia');
    const expectedUpdatedAt = multipartField(route, 'expectedUpdatedAt');
    const audioChangeConfirmation = multipartField(route, 'audioChangeConfirmation');
    const filename = /name="media"; filename="([^"]+)"/.exec(route.request().postDataBuffer()?.toString('utf8') || '')?.[1] || '';
    requests.push({ mode, expectedMedia: identity ? JSON.parse(identity) : undefined, expectedUpdatedAt, ...(audioChangeConfirmation ? { audioChangeConfirmation } : {}) });
    if (hold) await hold;
    if (error) return route.fulfill({ status: error.status, json: { error: error.message, code: error.code } });
    if (expectedUpdatedAt !== state.projects[0].updatedAt || identity !== JSON.stringify({ filename: state.projects[0].media.filename, size: state.projects[0].media.size })) {
      return route.fulfill({ status: 409, json: { error: 'The saved project changed. Check the replacement again.', code: 'MEDIA_REPLACEMENT_STALE' } });
    }
    if (changedAudio && mode === 'preserve') {
      if (!audioChangeConfirmation) {
        challenge = { token: `synthetic-confirmation-${++challenges}`, expectedUpdatedAt: state.projects[0].updatedAt, filename };
        return route.fulfill({ status: 422, json: {
          error: 'The replacement audio differs from the reviewed source.', code: 'MEDIA_AUDIO_MISMATCH',
          preserveAudioConfirmation: { token: challenge.token, expiresAt: '2099-01-01T00:00:00.000Z' },
        } });
      }
      if (!challenge || audioChangeConfirmation !== challenge.token || expectedUpdatedAt !== challenge.expectedUpdatedAt || expectedUpdatedAt !== state.projects[0].updatedAt || filename !== challenge.filename) {
        return route.fulfill({ status: 409, json: { error: 'This confirmation is stale. Check the replacement again.', code: 'MEDIA_AUDIO_CONFIRMATION_STALE' } });
      }
      challenge = undefined;
    }
    backupSnapshots.push(structuredClone(state.projects[0]));
    const nextFilename = replacements.length ? `regraded-${replacements.length + 1}.mp4` : 'regraded.mp4';
    const next: CaptionProject = { ...structuredClone(state.projects[0]), updatedAt: `2026-10-01T01:00:0${replacements.length}.000Z`, media: { ...state.projects[0].media, filename: nextFilename, originalName: filename, url: `/media/${nextFilename}`, size: fixtureMedia().length }, ...(mode === 'reset' ? { captions: [], transcript: null, transcriptNeedsSync: false, mediaAlignment: undefined } : audioChangeConfirmation ? { mediaAlignment: { state: 'unverified-audio-change' as const, acceptedAt: '2026-10-01T01:00:00.000Z', sourceRevision: state.projects[0].updatedAt } } : {}) };
    const summary = { id: 'durable-replacement', mode: mode || 'unknown', createdAt: next.updatedAt, previousOriginalName: original.media.originalName };
    replacements.unshift(summary);
    state.projects[0] = next;
    return route.fulfill({ json: { ...next, mediaReplacement: summary } });
  });
  await page.route('**/api/projects/landscape/media-replacements/*/restore', async (route) => {
    restores++;
    const basis = route.request().postDataJSON();
    expect(basis.expectedMedia.filename).toBe(state.projects[0].media.filename);
    expect(basis.expectedUpdatedAt).toBe(state.projects[0].updatedAt);
    const next = { ...structuredClone(original), updatedAt: '2026-10-01T02:00:00.000Z', media: { ...original.media, filename: 'rollback-fresh.mp4', url: '/media/rollback-fresh.mp4' } };
    state.projects[0] = next;
    return route.fulfill({ json: { ...next, mediaReplacement: { id: 'redo-replacement', mode: 'preserve', createdAt: next.updatedAt, previousOriginalName: 'synthetic-regraded.mp4' } } });
  });
  return { state, original, requests, replacements, backupSnapshots, hold: (promise: Promise<void>) => { hold = promise; }, fail: (status: number, message: string, code = 'MEDIA_AUDIO_MISMATCH') => { error = { status, message, code }; }, changeAudio: () => { changedAudio = true; }, restoreCount: () => restores };
}

async function openAccuracy(page: Page) {
  const button = page.getByRole('button', { name: /^Accuracy/ });
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  return {
    description: page.getByLabel('What is this clip about?', { exact: true }),
    vocabulary: page.getByLabel('Exact terms to preserve', { exact: true }),
  };
}
async function submitReplacement(page: Page, mode: 'preserve' | 'reset') {
  const dialog = await chooseFile(page);
  if (mode === 'preserve') {
    await dialog.getByRole('button', { name: 'Replace and keep captions', exact: true }).click();
  } else {
    await dialog.getByRole('radio', { name: /^Start over/ }).check();
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Start over with this media?', exact: true })
      .getByRole('button', { name: 'Replace and clear captions', exact: true }).click();
  }
  return dialog;
}
const acceptTimingLabel = 'I accept the existing times and will check their alignment.';
async function requestAudioWarning(page: Page, filename?: string) {
  const dialog = await chooseFile(page, filename);
  await dialog.getByRole('button', { name: 'Replace and keep captions', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: acceptTimingLabel, exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Replace and keep existing times', exact: true })).toBeDisabled();
  return dialog;
}
async function finishResponse(page: Page, pathname: string, release: () => void) {
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === pathname && value.request().method() === 'PUT');
  release();
  await (await response).finished();
  // Observe assertions after the fetch continuation and React commit, without a
  // timer racing the response that this regression intentionally controls.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function hasUnloadGuard(page: Page) {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

test('Accuracy fields keep native labels and exact accessible names across edits, term counts and reopening', async ({ page }) => {
  const f = await fixture(page);
  await openProject(page);
  const fields = await openAccuracy(page);
  const assertFieldContract = async (description: string, vocabulary: string, count: number) => {
    for (const [field, name, value] of [
      [fields.description, 'What is this clip about?', description],
      [fields.vocabulary, 'Exact terms to preserve', vocabulary],
    ] as const) {
      // Both label and role lookup must remain exact when React updates the
      // textarea's text content. A prefix locator would hide the original bug.
      await expect(field).toHaveCount(1);
      await expect(field).toHaveAccessibleName(name);
      await expect(page.getByRole('textbox', { name, exact: true })).toHaveValue(value);
      const association = await field.evaluate((element: HTMLTextAreaElement) => ({
        id: element.id,
        labels: Array.from(element.labels ?? []).map((label) => ({
          htmlFor: label.htmlFor,
          text: label.textContent?.trim(),
          controlMatches: label.control === element,
          containsField: label.contains(element),
        })),
      }));
      expect(association.id).not.toBe('');
      expect(association.labels).toEqual([{ htmlFor: association.id, text: name, controlMatches: true, containsField: false }]);
    }
    await expect(fields.description).toHaveAccessibleDescription(/^Help recognize names, brands, versions, and Khmer-English speech\. Full-context transcription uses the topic description; experimental transcription-only mode uses selected terms as hints\.$/);
    await expect(fields.vocabulary).toHaveAccessibleDescription(new RegExp(`^${count} terms One term per line\\.`));
    await expect(page.locator('.accuracy-card .context-field b')).toHaveText(String(count));
  };

  await assertFieldContract('Saved synthetic context', 'SavedBrand | saved alias', 1);
  const edited = { description: '  Edited description\nKeep this raw spacing.  ', vocabulary: 'ExactBrand | exact alias\nSecondTerm\n\nExactBrand | exact alias' };
  await fields.description.fill(edited.description);
  await fields.vocabulary.fill(edited.vocabulary);
  await assertFieldContract(edited.description, edited.vocabulary, 2);
  await page.getByRole('button', { name: /^Accuracy/ }).click();
  await expect(fields.description).toHaveCount(0);
  await openAccuracy(page);
  await assertFieldContract(edited.description, edited.vocabulary, 2);

  await fields.description.fill('');
  await fields.vocabulary.fill('');
  await assertFieldContract('', '', 0);
  // The visible native labels must focus their own fields, not merely provide
  // an aria-label override that happens to satisfy a test locator.
  await page.locator('.accuracy-card label').filter({ hasText: /^What is this clip about\?$/ }).click();
  await expect(fields.description).toBeFocused();
  await page.locator('.accuracy-card label').filter({ hasText: /^Exact terms to preserve$/ }).click();
  await expect(fields.vocabulary).toBeFocused();
  expect(f.state.projects[0].transcriptionContext).toEqual(f.original.transcriptionContext);
  noGeneration(f.state);
});

test('replacement defaults to preserving reviewed work and cancelling or Escape leaves it untouched', async ({ page }) => {
  const f = await fixture(page);
  await openProject(page);
  await seek(page, 1500);
  let dialog = await chooseFile(page);
  await expect(dialog.getByRole('radio', { name: /^Keep reviewed captions/ })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: /^Start over/ })).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Replace and keep captions', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(f.requests).toHaveLength(0);
  expect(f.state.projects[0]).toEqual(f.original);
  await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  dialog = await chooseFile(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(f.requests).toHaveLength(0);
  noGeneration(f.state);
});

test('preserve submits a revision-bound snapshot once, blocks interruption while pending and retains captions/playhead', async ({ page }) => {
  const f = await fixture(page);
  const gate = deferred(); f.hold(gate.promise);
  await openProject(page);
  await seek(page, 1500);
  const dialog = await chooseFile(page);
  try {
    const submit = dialog.getByRole('button', { name: 'Replace and keep captions', exact: true });
    await submit.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => f.requests.length).toBe(1);
    expect(f.requests[0]).toEqual({ mode: 'preserve', expectedMedia: { filename: f.original.media.filename, size: f.original.media.size }, expectedUpdatedAt: f.original.updatedAt });
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Back to projects', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    gate.resolve();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('video')).toHaveAttribute('src', '/media/regraded.mp4');
    await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(1.5, 2);
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(f.original.captions[0].text);
    expect(f.state.projects[0].captions).toEqual(f.original.captions);
    expect(f.state.projects[0].captionAppearance).toEqual(f.original.captionAppearance);
    expect(f.state.projects[0].transcript).toEqual(f.original.transcript);
    expect(f.state.projects[0].transcriptNeedsSync).toBe(true);
    expect(f.state.projects[0].mediaAlignment).toBeUndefined();
    noGeneration(f.state);
  } finally { gate.resolve(); }
});

test('audio mismatch leaves source, draft, approval and undo state intact without silently resetting', async ({ page }) => {
  const f = await fixture(page);
  f.fail(422, 'The audio is different or no longer aligned with the reviewed captions.');
  await openProject(page);
  const dialog = await chooseFile(page);
  await dialog.getByRole('button', { name: 'Replace and keep captions', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The audio is different');
  expect(f.requests).toHaveLength(1);
  expect(f.state.projects[0]).toEqual(f.original);
  await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(f.original.captions[0].text);
  expect(f.replacements).toHaveLength(0);
  noGeneration(f.state);
});

test('changed audio needs unchecked explicit acceptance and cancellation cannot reuse it for a different selection', async ({ page }) => {
  const f = await fixture(page); f.changeAudio();
  await openProject(page);
  const dialog = await requestAudioWarning(page);
  await expect(dialog).toContainText('Caption and word times will stay unchanged');
  await expect(dialog).toContainText('You must check their alignment against the new audio');
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].audioChangeConfirmation).toBeUndefined();
  expect(f.state.projects[0]).toEqual(f.original);
  expect(f.backupSnapshots).toHaveLength(0);
  await dialog.getByRole('checkbox', { name: acceptTimingLabel, exact: true }).check();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const next = await chooseFile(page, 'synthetic-with-music.mp4');
  await expect(next).toContainText('synthetic-with-music.mp4');
  await expect(next.getByRole('checkbox', { name: acceptTimingLabel, exact: true })).toHaveCount(0);
  await expect(next.getByRole('button', { name: 'Replace and keep captions', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  expect(f.requests).toHaveLength(1);
  expect(f.state.projects[0]).toEqual(f.original);
  noGeneration(f.state);
});

test('accepted audio difference submits once and keeps reviewed words, locks and highlight timing across reload and Undo', async ({ page }, testInfo) => {
  const f = await fixture(page); f.changeAudio();
  f.state.projects[0].captionAppearance = { ...f.state.projects[0].captionAppearance!, highlightMode: 'word' };
  const before = structuredClone(f.state.projects[0]);
  const gate = deferred();
  await openProject(page);
  const dialog = await requestAudioWarning(page);
  await page.screenshot({ path: testInfo.outputPath('audio-change-warning-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('audio-change-warning-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole('checkbox', { name: acceptTimingLabel, exact: true }).check();
  f.hold(gate.promise);
  try {
    await dialog.getByRole('button', { name: 'Replace and keep existing times', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => f.requests.length).toBe(2);
    expect(f.requests[1]).toEqual({ mode: 'preserve', expectedMedia: { filename: before.media.filename, size: before.media.size }, expectedUpdatedAt: before.updatedAt, audioChangeConfirmation: 'synthetic-confirmation-1' });
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    gate.resolve();
    await expect(dialog).toHaveCount(0);
    expect(f.backupSnapshots).toHaveLength(1);
    expect(f.backupSnapshots[0]).toEqual(before);
    expect(f.state.projects[0].captions).toEqual(before.captions);
    expect(f.state.projects[0].captions.every((caption) => caption.wordTiming?.words.length)).toBe(true);
    expect(f.state.projects[0].captions[0]).toMatchObject({ approved: true, textLocked: true, timingLocked: true });
    expect(f.state.projects[0].captionAppearance).toEqual(before.captionAppearance);
    expect(f.state.projects[0].transcript).toEqual(before.transcript);
    expect(f.state.projects[0].mediaAlignment?.state).toBe('unverified-audio-change');
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Highlight spoken word', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.appearance-highlight-readiness')).toContainText('3 of 3 captions');
    await page.reload();
    await page.getByRole('button', { name: /Audit landscape/ }).click();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/regraded.mp4');
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(before.captions[0].text);
    await expect(page.getByRole('note').filter({ hasText: 'Audio alignment not verified.' })).toContainText('Existing caption and word times were kept');
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    const details = page.locator('.timing-card');
    await expect(details).toContainText('Previous audio timing evidence');
    await expect(details).toContainText('These measurements belong to the previous audio');
    await expect(details).not.toContainText(/KFA Khmer alignment active|Local Whisper fallback active/);
    await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1);
    await seek(page, 500);
    await page.screenshot({ path: testInfo.outputPath('retained-timing-reminder-desktop.png'), fullPage: true });
    expect(f.state.projects[0].captions).toEqual(before.captions);
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /^Undo media replacement/ }).click();
    await page.getByRole('dialog', { name: 'Undo media replacement', exact: true }).getByRole('button', { name: 'Restore selected backup', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Restore previous media?', exact: true }).getByRole('button', { name: 'Restore previous media', exact: true }).click();
    await expect.poll(() => f.restoreCount()).toBe(1);
    expect(f.state.projects[0].captions).toEqual(before.captions);
    expect(f.state.projects[0].mediaAlignment).toBeUndefined();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/rollback-fresh.mp4');
    const detailsButton = page.getByRole('button', { name: 'Details', exact: true });
    await expect(detailsButton).toHaveAttribute('aria-pressed', 'false');
    await detailsButton.click();
    await expect(page.locator('.timing-card')).toContainText('KFA Khmer alignment active');
    await expect(page.locator('.timing-card')).not.toContainText('Previous audio timing evidence');
    noGeneration(f.state);
  } finally { gate.resolve(); }
});

test('choosing Start over discards audio consent and still requires its separate destructive confirmation', async ({ page }) => {
  const f = await fixture(page); f.changeAudio();
  await openProject(page);
  const dialog = await requestAudioWarning(page);
  await dialog.getByRole('checkbox', { name: acceptTimingLabel, exact: true }).check();
  await dialog.getByRole('radio', { name: /^Start over/ }).check();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Start over with this media?', exact: true }).getByRole('button', { name: 'Keep current project', exact: true }).click();
  expect(f.requests).toHaveLength(1);
  expect(f.state.projects[0]).toEqual(f.original);
  await dialog.getByRole('radio', { name: /^Keep reviewed captions/ }).check();
  await expect(dialog.getByRole('checkbox', { name: acceptTimingLabel, exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Replace and keep captions', exact: true })).toBeEnabled();
  noGeneration(f.state);
});

test('new caption edits invalidate accepted audio warning before any override request', async ({ page }) => {
  const f = await fixture(page); f.changeAudio();
  f.state.profile.preferences.autosaveDelayMs = 60_000;
  await openProject(page);
  const dialog = await requestAudioWarning(page);
  await dialog.getByRole('checkbox', { name: acceptTimingLabel, exact: true }).check();
  await page.getByLabel('Caption 2 text', { exact: true }).fill('New reviewed correction needs its own confirmation');
  await expect(dialog.getByRole('checkbox', { name: acceptTimingLabel, exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Replace and keep captions', exact: true })).toBeEnabled();
  expect(f.requests).toHaveLength(1);
  expect(f.replacements).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Caption 2 text', { exact: true })).toHaveValue('New reviewed correction needs its own confirmation');
  await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  noGeneration(f.state);
});

test('an externally changed project revision cannot consume old audio consent or silently reset', async ({ page }) => {
  const f = await fixture(page); f.changeAudio();
  await openProject(page);
  const dialog = await requestAudioWarning(page);
  await dialog.getByRole('checkbox', { name: acceptTimingLabel, exact: true }).check();
  f.state.projects[0].updatedAt = '2026-10-01T00:59:00.000Z';
  await dialog.getByRole('button', { name: 'Replace and keep existing times', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/changed|stale|check/i);
  expect(f.replacements).toHaveLength(0);
  expect(f.backupSnapshots).toHaveLength(0);
  expect(f.state.projects[0].captions).toEqual(f.original.captions);
  await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  noGeneration(f.state);
});

test('two successive audio replacements each require a fresh unchecked warning bound to that source', async ({ page }) => {
  const f = await fixture(page); f.changeAudio();
  await openProject(page);
  for (const filename of ['synthetic-louder.mp4', 'synthetic-with-sfx.mp4']) {
    const previous = structuredClone(f.state.projects[0]);
    const dialog = await requestAudioWarning(page, filename);
    const verification = f.requests.at(-1)!;
    expect(verification.audioChangeConfirmation).toBeUndefined();
    expect(verification.expectedUpdatedAt).toBe(previous.updatedAt);
    expect(verification.expectedMedia).toEqual({ filename: previous.media.filename, size: previous.media.size });
    await dialog.getByRole('checkbox', { name: acceptTimingLabel, exact: true }).check();
    await dialog.getByRole('button', { name: 'Replace and keep existing times', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(f.state.projects[0].media.originalName).toBe(filename);
    expect(f.state.projects[0].captions).toEqual(f.original.captions);
  }
  expect(f.requests).toHaveLength(4);
  expect(f.requests[1].audioChangeConfirmation).not.toBe(f.requests[3].audioChangeConfirmation);
  expect(f.backupSnapshots).toHaveLength(2);
  noGeneration(f.state);
});

for (const [code, message] of [
  ['MEDIA_DURATION_MISMATCH', 'The overall duration differs. Use the same duration to keep existing times.'],
  ['MEDIA_INVALID', 'The replacement could not be decoded.'],
  ['MEDIA_CAPTION_BOUNDS', 'A caption ends beyond the replacement media.'],
] as const) {
  test(`${code} never offers audio acceptance or silently resets`, async ({ page }) => {
    const f = await fixture(page); f.fail(422, message, code);
    await openProject(page);
    const dialog = await submitReplacement(page, 'preserve');
    await expect(dialog.getByRole('alert')).toContainText(message);
    await expect(dialog.getByRole('checkbox', { name: acceptTimingLabel, exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Replace and keep existing times', exact: true })).toHaveCount(0);
    expect(f.requests).toHaveLength(1);
    expect(f.state.projects[0]).toEqual(f.original);
    expect(f.backupSnapshots).toHaveLength(0);
    noGeneration(f.state);
  });
}

test('Start over requires a separate destructive confirmation; cancellation and Back do not submit', async ({ page }) => {
  const f = await fixture(page);
  await openProject(page);
  const dialog = await chooseFile(page);
  await dialog.getByRole('radio', { name: /^Start over/ }).check();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: 'Start over with this media?', exact: true });
  await expect(confirmation).toBeVisible();
  expect(f.requests).toHaveLength(0);
  await confirmation.getByRole('button', { name: 'Keep current project', exact: true }).click();
  expect(f.requests).toHaveLength(0);
  expect(f.state.projects[0]).toEqual(f.original);
});

test('explicit reset clears captions only after confirmation and exposes durable Undo on reload', async ({ page }) => {
  const f = await fixture(page);
  await openProject(page);
  const dialog = await chooseFile(page);
  await dialog.getByRole('radio', { name: /^Start over/ }).check();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: 'Start over with this media?', exact: true });
  await confirmation.getByRole('button', { name: 'Replace and clear captions', exact: true }).click();
  await expect(page.locator('video')).toHaveAttribute('src', '/media/regraded.mp4');
  expect(f.requests[0].mode).toBe('reset');
  expect(f.state.projects[0].captions).toEqual([]);
  await page.reload();
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(page.locator('video')).toHaveAttribute('src', '/media/regraded.mp4');
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Undo media replacement/ }).click();
  await page.getByRole('dialog', { name: 'Undo media replacement', exact: true }).getByRole('button', { name: 'Restore selected backup', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Restore previous media?', exact: true }).getByRole('button', { name: 'Restore previous media', exact: true }).click();
  await expect.poll(() => f.restoreCount()).toBe(1);
  await expect(page.locator('video')).toHaveAttribute('src', '/media/rollback-fresh.mp4');
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(f.original.captions[0].text);
  expect(f.state.projects[0].captions).toEqual(f.original.captions);
  noGeneration(f.state);
});

test('failed prerequisite save keeps the unsaved caption and never starts replacement', async ({ page }) => {
  const f = await fixture(page);
  await page.route('**/api/projects/landscape/captions', (route) => route.fulfill({ status: 500, json: { error: 'Synthetic draft save failure' } }));
  await openProject(page);
  const text = page.getByLabel('Caption 2 text', { exact: true });
  await text.fill('Unsaved correction must survive');
  const dialog = await chooseFile(page);
  await dialog.getByRole('button', { name: 'Replace and keep captions', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The current captions could not be saved. Resolve the save error before changing media.');
  expect(f.requests).toHaveLength(0);
  await expect(text).toHaveValue('Unsaved correction must survive');
  await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  expect(f.state.projects[0]).toEqual(f.original);
  expect(f.replacements).toHaveLength(0);
  noGeneration(f.state);
});

test('active processing prevents opening media replacement', async ({ page }) => {
  const f = await fixture(page);
  f.state.jobs = [{ id: 'active-job', type: 'transcribe', projectId: 'landscape', projectTitle: 'Audit landscape', status: 'running', stage: 'timing', progress: 30, message: 'Working', createdAt: '2026-01-01', updatedAt: '2026-01-01', canResume: false }];
  await openProject(page);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /^Replace media/ })).toBeDisabled();
  expect(f.requests).toHaveLength(0);
});


test('preserve replacement retains the open Review workspace and its decision target', async ({ page }) => {
  const f = await fixture(page);
  await openProject(page);
  const review = page.locator('.header-actions').getByRole('button', { name: /^Review/ });
  await review.click();
  await seek(page, 1500);
  await expect(review).toHaveAttribute('aria-pressed', 'true');
  const dialog = await chooseFile(page);
  await dialog.getByRole('button', { name: 'Replace and keep captions', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('video')).toHaveAttribute('src', '/media/regraded.mp4');
  await expect(review).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Approve & next', exact: true })).toBeVisible();
  expect(f.state.projects[0].captions).toEqual(f.original.captions);
  noGeneration(f.state);
});

for (const mode of ['preserve', 'reset'] as const) {
  test(`a delayed caption reply retains newer Accuracy drafts and flushes context before ${mode} and its backup`, async ({ page }) => {
    const f = await fixture(page);
    f.state.profile.preferences.autosaveDelayMs = 60_000;
    const captionGate = deferred();
    const contextGate = deferred();
    const contextWrites: any[] = [];
    const events: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && path.endsWith('/replace-media')) events.push('replacement-request');
    });
    await page.route('**/api/projects/landscape/captions', async (route) => {
      expect(route.request().method()).toBe('PUT');
      const body = route.request().postDataJSON();
      expect(body.expectedMedia).toEqual({ filename: f.original.media.filename, size: f.original.media.size });
      f.state.projects[0].captions = structuredClone(body.captions);
      f.state.projects[0].updatedAt = '2026-01-02T00:00:00.000Z';
      // Freeze the old full-project reply before newer Accuracy input is typed.
      const reply = structuredClone(f.state.projects[0]);
      events.push('caption-request');
      await captionGate.promise;
      events.push('caption-response');
      await route.fulfill({ json: { project: reply, correctionsCreated: 0 } });
    });
    await page.route('**/api/projects/landscape/context', async (route) => {
      expect(route.request().method()).toBe('PUT');
      const body = route.request().postDataJSON();
      contextWrites.push(body);
      events.push('context-request');
      await contextGate.promise;
      f.state.projects[0].transcriptionContext = structuredClone(body.transcriptionContext);
      f.state.projects[0].updatedAt = '2026-01-03T00:00:00.000Z';
      events.push('context-response');
      await route.fulfill({ json: f.state.projects[0] });
    });
    try {
      await openProject(page);
      await page.getByLabel('Caption 2 text', { exact: true }).fill('Correction saved while Accuracy is being edited');
      const fields = await openAccuracy(page); // Blur starts the held caption PUT.
      await expect.poll(() => events).toEqual(['caption-request']);
      await fields.description.fill('Newer Accuracy description must survive');
      await fields.vocabulary.fill('ExactBrand | exact alias\nAnotherTerm');
      await expect(fields.description).toHaveValue('Newer Accuracy description must survive');
      await expect(fields.vocabulary).toHaveValue('ExactBrand | exact alias\nAnotherTerm');
      expect(events).toEqual(['caption-request']);
      await finishResponse(page, '/api/projects/landscape/captions', captionGate.resolve);
      // Caption persistence is complete, but combined Save still owns the newer
      // Accuracy draft. The caption reply cannot mark that work as saved.
      await expect(page.locator('.save-action')).toBeEnabled();
      await expect(page.locator('.project-title')).toContainText('Accuracy changes unsaved');
      await expect(fields.description).toHaveValue('Newer Accuracy description must survive');
      await expect(fields.vocabulary).toHaveValue('ExactBrand | exact alias\nAnotherTerm');
      expect(f.state.projects[0].captions[1].text).toBe('Correction saved while Accuracy is being edited');
      expect(f.state.projects[0].transcriptionContext).toEqual(f.original.transcriptionContext);
      expect(contextWrites).toHaveLength(0);

      const dialog = await submitReplacement(page, mode);
      await expect.poll(() => contextWrites.length).toBe(1);
      expect(contextWrites[0]).toEqual({
        transcriptionContext: { description: 'Newer Accuracy description must survive', vocabulary: ['ExactBrand | exact alias', 'AnotherTerm'] },
        expectedMedia: { filename: f.original.media.filename, size: f.original.media.size },
        expectedUpdatedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(f.requests).toHaveLength(0);
      expect(f.replacements).toHaveLength(0);
      expect(f.backupSnapshots).toHaveLength(0);
      await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
      await expect(dialog).toHaveAttribute('aria-busy', 'true');
      await finishResponse(page, '/api/projects/landscape/context', contextGate.resolve);
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('video')).toHaveAttribute('src', '/media/regraded.mp4');
      expect(events).toEqual(['caption-request', 'caption-response', 'context-request', 'context-response', 'replacement-request']);
      expect(f.requests).toEqual([{
        mode,
        expectedMedia: { filename: f.original.media.filename, size: f.original.media.size },
        expectedUpdatedAt: '2026-01-03T00:00:00.000Z',
      }]);
      expect(f.backupSnapshots).toHaveLength(1);
      expect(f.backupSnapshots[0].transcriptionContext).toEqual(contextWrites[0].transcriptionContext);
      expect(f.backupSnapshots[0].captions[1].text).toBe('Correction saved while Accuracy is being edited');
      expect(f.backupSnapshots[0].captions[0]).toMatchObject({ approved: true, textLocked: true, timingLocked: true });
      expect(f.state.projects[0].transcriptionContext).toEqual(contextWrites[0].transcriptionContext);
      expect(f.state.projects[0].captions).toEqual(mode === 'preserve' ? f.backupSnapshots[0].captions : []);
      const replacedFields = await openAccuracy(page);
      await expect(replacedFields.description).toHaveValue('Newer Accuracy description must survive');
      await expect(replacedFields.vocabulary).toHaveValue('ExactBrand | exact alias\nAnotherTerm');
      noGeneration(f.state);
    } finally { captionGate.resolve(); contextGate.resolve(); }
  });

  test(`failed Accuracy save preserves drafts and blocks ${mode}, source changes and recovery creation`, async ({ page }) => {
    const f = await fixture(page);
    const writes: any[] = [];
    await page.route('**/api/projects/landscape/context', async (route) => {
      expect(route.request().method()).toBe('PUT');
      writes.push(route.request().postDataJSON());
      await route.fulfill({ status: 500, json: { error: 'Synthetic Accuracy save failure' } });
    });
    await openProject(page);
    const fields = await openAccuracy(page);
    await fields.description.fill('Unsaved Accuracy description');
    await fields.vocabulary.fill('UnsavedBrand | unsaved alias');
    const dialog = await submitReplacement(page, mode);
    await expect(dialog.getByRole('alert')).toContainText('Synthetic Accuracy save failure');
    expect(writes).toHaveLength(1);
    expect(writes[0].expectedMedia).toEqual({ filename: f.original.media.filename, size: f.original.media.size });
    expect(f.requests).toHaveLength(0);
    expect(f.replacements).toHaveLength(0);
    expect(f.backupSnapshots).toHaveLength(0);
    expect(f.state.projects[0]).toEqual(f.original);
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
    await expect(fields.description).toHaveValue('Unsaved Accuracy description');
    await expect(fields.vocabulary).toHaveValue('UnsavedBrand | unsaved alias');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(fields.description).toHaveValue('Unsaved Accuracy description');
    await expect(fields.vocabulary).toHaveValue('UnsavedBrand | unsaved alias');
    noGeneration(f.state);
  });

  test(`Accuracy input accepted after ${mode} submission stays in old-source copy recovery`, async ({ page }) => {
    const f = await fixture(page);
    const gate = deferred();
    f.hold(gate.promise);
    const late = {
      description: '  Late old-source description\nKeep this raw spacing.  ',
      vocabulary: 'LateBrand | late alias\n\n  OtherTerm  \nLateBrand | late alias',
    };
    try {
      await openProject(page);
      const fields = await openAccuracy(page);
      const dialog = await submitReplacement(page, mode);
      await expect.poll(() => f.requests.length).toBe(1);
      await expect(dialog).toHaveAttribute('aria-busy', 'true');
      expect(f.requests[0].expectedMedia).toEqual({ filename: f.original.media.filename, size: f.original.media.size });
      expect(f.backupSnapshots).toHaveLength(0);
      // The normal pointer path is blocked by the modal in the recovery test.
      // Exercise input that the editor nevertheless accepts after submission,
      // such as an already-started input operation. No forced click bypasses it.
      await fields.description.fill(late.description);
      await fields.vocabulary.fill(late.vocabulary);
      await expect(fields.description).toHaveValue(late.description);
      await expect(fields.vocabulary).toHaveValue(late.vocabulary);
      expect(f.state.projects[0].transcriptionContext).toEqual(f.original.transcriptionContext);
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async (value: string) => { (window as any).__copiedAccuracyRecovery = value; } },
        });
      });
      gate.resolve();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('video')).toHaveAttribute('src', '/media/regraded.mp4');
      expect(f.requests).toHaveLength(1);
      expect(f.backupSnapshots).toHaveLength(1);
      expect(f.backupSnapshots[0].transcriptionContext).toEqual(f.original.transcriptionContext);
      expect(f.state.projects[0].transcriptionContext).toEqual(f.original.transcriptionContext);
      expect(f.state.requests.filter((request) => request.method === 'PUT' && request.path.endsWith('/context'))).toEqual([]);
      const replacementFields = await openAccuracy(page);
      await expect(replacementFields.description).toHaveValue(f.original.transcriptionContext!.description!);
      await expect(replacementFields.vocabulary).toHaveValue(f.original.transcriptionContext!.vocabulary!.join('\n'));
      const recovery = page.locator('.replacement-edit-recovery').filter({ has: page.getByRole('button', { name: 'Copy recovery', exact: true }) });
      await expect(recovery).toHaveCount(1);
      await expect(recovery).toContainText('belong to the previous media and were not applied here');
      await recovery.getByRole('button', { name: 'Copy recovery', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).__copiedAccuracyRecovery ?? null)).not.toBeNull();
      const payload = await page.evaluate(() => JSON.parse((window as any).__copiedAccuracyRecovery));
      expect(payload.version).toBe(1);
      expect(payload.projectId).toBe(f.original.id);
      expect(payload.media).toEqual({ filename: f.original.media.filename, originalName: f.original.media.originalName, size: f.original.media.size });
      expect(payload.accuracyContext).toEqual(late);
      expect(payload.captions.map((caption: any) => caption.id)).toEqual(f.original.captions.map((caption) => caption.id));
      expect(payload.captions[0]).toMatchObject({ approved: true, textLocked: true, timingLocked: true });
      expect(payload.captions[1].text).toBe(f.original.captions[1].text);
      noGeneration(f.state);
    } finally { gate.resolve(); }
  });
}

test('newer Accuracy edits survive their older context acknowledgment and a later caption acknowledgment', async ({ page }) => {
  const f = await fixture(page);
  f.state.profile.preferences.autosaveDelayMs = 60_000;
  const gate = deferred();
  const writes: any[] = [];
  await page.route('**/api/projects/landscape/context', async (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    const reply = { ...structuredClone(f.state.projects[0]), transcriptionContext: structuredClone(body.transcriptionContext) };
    if (writes.length === 1) await gate.promise;
    f.state.projects[0].transcriptionContext = structuredClone(body.transcriptionContext);
    await route.fulfill({ json: reply });
  });
  try {
    await openProject(page);
    const fields = await openAccuracy(page);
    await fields.description.fill('First submitted description');
    await fields.vocabulary.fill('FirstBrand | first alias');
    await page.getByRole('button', { name: 'Save for project', exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    await fields.description.fill('Newer unsaved description');
    await fields.vocabulary.fill('NewerBrand | newer alias');
    await finishResponse(page, '/api/projects/landscape/context', gate.resolve);
    await expect(fields.description).toHaveValue('Newer unsaved description');
    await expect(fields.vocabulary).toHaveValue('NewerBrand | newer alias');
    expect(f.state.projects[0].transcriptionContext).toEqual(writes[0].transcriptionContext);
    await page.getByLabel('Caption 2 text', { exact: true }).fill('Caption saved after old context acknowledgment');
    const captionReply = page.waitForResponse((value) => value.url().endsWith('/captions') && value.request().method() === 'PUT');
    await fields.description.focus(); // Commit caption without a second context save.
    await (await captionReply).finished();
    await expect(page.locator('.save-action')).toBeEnabled();
    await expect(page.locator('.project-title')).toContainText('Accuracy changes unsaved');
    await expect(fields.description).toHaveValue('Newer unsaved description');
    await expect(fields.vocabulary).toHaveValue('NewerBrand | newer alias');
    expect(writes).toHaveLength(1);
    const newReply = page.waitForResponse((value) => value.url().endsWith('/context') && value.request().method() === 'PUT');
    await page.locator('.save-action').click();
    await (await newReply).finished();
    expect(writes).toHaveLength(2);
    expect(writes[1].transcriptionContext).toEqual({ description: 'Newer unsaved description', vocabulary: ['NewerBrand | newer alias'] });
    expect(f.state.projects[0].transcriptionContext).toEqual(writes[1].transcriptionContext);
    await expect(fields.description).toHaveValue('Newer unsaved description');
    await expect(fields.vocabulary).toHaveValue('NewerBrand | newer alias');
    await expect(page.locator('.save-action')).toHaveText('Saved');
    await expect(page.locator('.save-action')).toBeDisabled();
    noGeneration(f.state);
  } finally { gate.resolve(); }
});

for (const destination of ['another project', 'a new source in the same project'] as const) {
  test(`a pending Accuracy save is reconciled before leaving and cannot overwrite ${destination}`, async ({ page }) => {
    const f = await fixture(page);
    const gate = deferred();
    const writes: any[] = [];
    await page.route('**/api/projects/landscape/context', async (route) => {
      expect(route.request().method()).toBe('PUT');
      const body = route.request().postDataJSON();
      writes.push(body);
      f.state.projects[0].transcriptionContext = structuredClone(body.transcriptionContext);
      const reply = structuredClone(f.state.projects[0]);
      await gate.promise;
      await route.fulfill({ json: reply });
    });
    try {
      await openProject(page);
      const oldFields = await openAccuracy(page);
      await oldFields.description.fill('Old-source submitted description');
      await oldFields.vocabulary.fill('OldBrand | old alias');
      await page.getByRole('button', { name: 'Save for project', exact: true }).click();
      await expect.poll(() => writes.length).toBe(1);
      expect(writes[0]).toEqual({
        transcriptionContext: { description: 'Old-source submitted description', vocabulary: ['OldBrand | old alias'] },
        expectedMedia: { filename: f.original.media.filename, size: f.original.media.size },
        expectedUpdatedAt: f.original.updatedAt,
      });
      await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
      // Home drains the existing write before leaving. The old source, raw
      // Accuracy fields and unload protection stay owned by this editor meanwhile.
      await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
      await expect(page.locator('video')).toHaveAttribute('src', f.original.media.url);
      await expect(oldFields.description).toHaveValue('Old-source submitted description');
      await expect(oldFields.vocabulary).toHaveValue('OldBrand | old alias');
      await expect(page.getByRole('button', { name: /Audit landscape/ })).toHaveCount(0);
      await expect.poll(() => hasUnloadGuard(page)).toBe(true);
      expect(writes).toHaveLength(1);
      await finishResponse(page, '/api/projects/landscape/context', gate.resolve);
      await expect(page.getByRole('button', { name: /Audit landscape/ })).toBeVisible();
      expect(writes).toHaveLength(1);

      const target = destination === 'another project' ? f.state.projects[1] : f.state.projects[0];
      target.transcriptionContext = { description: 'Target saved description', vocabulary: ['TargetBrand'] };
      if (destination !== 'another project') {
        // A synthetic external source change while the editor is closed, after
        // its old-source write settled. Reopening must adopt this fresh source.
        target.media = { ...target.media, filename: 'new-source.mp4', url: '/media/new-source.mp4', size: 6000 };
      }
      const targetCaptions = structuredClone(target.captions);
      await page.getByRole('button', { name: new RegExp(`Audit ${target.id}`) }).click();
      await expect(page.locator('video')).toHaveAttribute('src', target.media.url);
      const fields = await openAccuracy(page);
      await expect(fields.description).toHaveValue('Target saved description');
      await expect(fields.vocabulary).toHaveValue('TargetBrand');
      await fields.description.fill('Target newer unsaved description');
      await fields.vocabulary.fill('TargetNewBrand | target alias');
      await expect(page.locator('.project-title strong')).toHaveText(`Audit ${target.id}`);
      await expect(page.locator('video')).toHaveAttribute('src', target.media.url);
      await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(targetCaptions[0].text);
      await expect(fields.description).toHaveValue('Target newer unsaved description');
      await expect(fields.vocabulary).toHaveValue('TargetNewBrand | target alias');
      expect(target.transcriptionContext).toEqual({ description: 'Target saved description', vocabulary: ['TargetBrand'] });
      expect(target.captions).toEqual(targetCaptions);
      expect(writes).toHaveLength(1);
      await expect(page.locator('.save-action')).toBeEnabled();
      await expect.poll(() => hasUnloadGuard(page)).toBe(true);
      noGeneration(f.state);
    } finally { gate.resolve(); }
  });
}

test('a context revision conflict during media preparation keeps local Accuracy drafts and never replaces', async ({ page }) => {
  const f = await fixture(page);
  let contextWrites = 0;
  await page.route('**/api/projects/landscape/context', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.expectedUpdatedAt).toBe(f.original.updatedAt);
    contextWrites++;
    f.state.projects[0].transcriptionContext = { description: 'Other tab context', vocabulary: ['OtherTab'] };
    f.state.projects[0].updatedAt = '2026-01-04T00:00:00.000Z';
    await route.fulfill({ status: 409, json: { code: 'CONTEXT_REVISION_CHANGED', error: 'The saved project changed while preparing Accuracy context. Review your edits before replacing media.' } });
  });
  await openProject(page);
  const fields = await openAccuracy(page);
  await fields.description.fill('My newer description');
  await fields.vocabulary.fill('MyBrand | alias');
  const dialog = await submitReplacement(page, 'preserve');
  await expect(dialog.getByRole('alert')).toContainText('saved project changed');
  expect(contextWrites).toBe(1);
  expect(f.requests).toHaveLength(0);
  expect(f.backupSnapshots).toHaveLength(0);
  await expect(fields.description).toHaveValue('My newer description');
  await expect(fields.vocabulary).toHaveValue('MyBrand | alias');
  await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  expect(f.state.projects[0].transcriptionContext?.description).toBe('Other tab context');
  noGeneration(f.state);
});
