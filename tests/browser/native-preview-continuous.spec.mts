import { test, expect, type Page, type Route, type Request } from '@playwright/test';
import { buildCaptionWordTiming, planCaptionRenderStates, type CaptionProject, type CaptionSegment, type CaptionRenderState, type TimedToken } from '../../packages/shared/src/index.js';
import { capabilities, cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
test.setTimeout(120_000);

type Sample = { ms: number; key: string | null; mode: string | null; src: string | null; preparing: boolean };
type Decode = { ms: number; src: string };
type Probe = { samples: Sample[]; decoded: Decode[]; collecting: boolean };
type RecordedRequest = { times: number[]; ms: number; color: string };
const RED = '#FF0000';
const BLUE = '#0000FF';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function cue(id: string, words: string[], start: number, duration: number): CaptionSegment {
  const caption: CaptionSegment = { id, text: words.join(' '), startMs: start, endMs: start + duration * words.length };
  const tokens: TimedToken[] = words.map((text, index) => ({
    id: `${id}-${index}`, text, startMs: start + duration * index, endMs: start + duration * (index + 1),
    spaceBefore: index > 0, timingSource: 'stt', alignmentScore: 1,
  }));
  caption.wordTiming = buildCaptionWordTiming(caption, tokens);
  return caption;
}

function configure(state: FixtureState, captions: CaptionSegment[]) {
  const project = state.projects[0] as CaptionProject;
  project.captions = captions;
  project.captionAppearance = { ...project.captionAppearance!, highlightMode: 'word', highlightColor: RED };
  project.transcript!.segments = structuredClone(captions);
  project.transcript!.fullText = captions.map((caption) => caption.text).join(' ');
  return { project, paints: planCaptionRenderStates(captions, true).filter((paint) => paint.key) };
}

// Delay the REAL decode, rather than replace it with a resolved fake. Sampling
// runs independently of the test driver's expectations and media keeps playing.
async function installProbe(page: Page, decodeDelay: number) {
  await page.addInitScript(({ decodeDelay }) => {
    const probe: Probe = { samples: [], decoded: [], collecting: false };
    (window as unknown as { __continuousPreview: Probe }).__continuousPreview = probe;
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await decode.call(this);
      if (!this.src.startsWith('data:image/png;base64,')) return;
      await new Promise<void>((resolve) => setTimeout(resolve, decodeDelay));
      probe.decoded.push({ ms: (document.querySelector('video')?.currentTime ?? 0) * 1000, src: this.src });
    };
    function sample() {
      const video = document.querySelector('video');
      if (probe.collecting && video) {
        const surface = document.querySelector('.native-caption-surface');
        probe.samples.push({ ms: video.currentTime * 1000,
          key: surface?.getAttribute('data-paint-key') ?? null,
          mode: surface?.getAttribute('data-preview-mode') ?? null,
          src: surface?.querySelector('img')?.getAttribute('src') ?? null,
          preparing: Boolean(document.querySelector('.native-preview-status')) });
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }, { decodeDelay });
}

// Generate authentic PNGs BEFORE the latency experiment. This models a known
// transport/render budget without pretending cloud FFmpeg timing is a user-PC
// benchmark. All displayed bytes are independently rendered full-timeline native
// references; no transparent/same-PNG-for-every-word fixture is used here.
async function nativeReferences(project: CaptionProject, paints: CaptionRenderState[], colors = [RED]) {
  const renderer = await import('../../apps/server/src/services/caption-preview.js');
  const references = new Map<string, { png: string; bounds: unknown; atMs: number }>();
  for (const color of colors) {
    for (let offset = 0; offset < paints.length; offset += 8) {
      const result = await renderer.renderCaptionPreview(renderer.parseCaptionPreviewInput({
        captions: project.captions, timesMs: paints.slice(offset, offset + 8).map((paint) => paint.atMs),
        appearance: { ...project.captionAppearance, highlightColor: color }, resolution: 'source',
      }), capabilities);
      for (const frame of result.frames) {
        expect(frame.bounds, 'Reference must contain native caption pixels').toBeTruthy();
        references.set(`${color}:${frame.atMs}`, frame);
      }
    }
  }
  return references;
}

async function serveNativeReferences(page: Page, references: Awaited<ReturnType<typeof nativeReferences>>, delay: number,
  beforeReply?: (request: RecordedRequest, route: Route) => Promise<number | void>) {
  const requests: RecordedRequest[] = [];
  await page.route('**/api/video-export/landscape/preview', async (route) => {
    const body = route.request().postDataJSON();
    const times = body.timesMs as number[];
    const color = body.appearance.highlightColor as string;
    expect(body.resolution).toBe('source');
    expect(body.appearance.highlightMode).toBe('word');
    const ms = await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime * 1000);
    const recorded = { times, ms, color };
    requests.push(recorded);
    const frames = times.map((atMs) => references.get(`${color}:${atMs}`));
    expect(frames.every(Boolean), `Unplanned native reference: ${color} ${times}`).toBe(true);
    const overrideDelay = await beforeReply?.(recorded, route);
    await sleep(overrideDelay ?? delay);
    // An intentionally superseded request may already have been aborted.
    await route.fulfill({ json: { width: 640, height: 360, frames } }).catch(() => {});
  });
  return requests;
}

async function playThrough(page: Page, endMs: number): Promise<Sample[]> {
  await page.evaluate(async () => {
    const probe = (window as unknown as { __continuousPreview: Probe }).__continuousPreview;
    probe.samples = []; probe.collecting = true;
    const video = document.querySelector('video')!;
    video.muted = true;
    await video.play();
  });
  // No seek or wait-for-future-paint between start and end. The only wait is for
  // the media clock to reach the endpoint of this continuous playback pass.
  await page.waitForFunction((end) => document.querySelector('video')!.currentTime * 1000 >= end, endMs);
  return page.evaluate(() => {
    document.querySelector('video')!.pause();
    const probe = (window as unknown as { __continuousPreview: Probe }).__continuousPreview;
    probe.collecting = false;
    return probe.samples;
  });
}

function assertNativeCorrespondence(samples: Sample[], paints: CaptionRenderState[], references: Awaited<ReturnType<typeof nativeReferences>>, color = RED) {
  expect(samples.length).toBeGreaterThan(10);
  for (const sample of samples) {
    if (!sample.src) continue;
    const paint = paints.find((item) => (item.paintKey || item.key) === sample.key);
    expect(paint, `Displayed pixels must identify a known exact paint: ${JSON.stringify(sample)}`).toBeDefined();
    expect(sample.src).toBe(`data:image/png;base64,${references.get(`${color}:${paint!.atMs}`)!.png}`);
    expect(sample.mode).toBe('exact');
    // Never present a future word. At most one 25-fps observation turn may
    // elapse after the displayed word's end, including transitions into gaps.
    expect(sample.ms, `Future word at media time ${sample.ms}`).toBeGreaterThanOrEqual(paint!.atMs);
    expect(sample.ms, `Stale word at media time ${sample.ms}`).toBeLessThanOrEqual(paint!.endMs + 40);
  }
}

test('continuous native playback after opening preparation decodes the next caption before its first boundary, then reuses it warm', async ({ page }) => {
  await installProbe(page, 60);
  const state = await installFixture(page);
  const { project, paints } = configure(state, [
    cue('a', ['one', 'two', 'three', 'four'], 200, 400),
    cue('b', ['five', 'six', 'seven', 'eight'], 1800, 400),
  ]);
  const saved = structuredClone(project.captions);
  const references = await nativeReferences(project, paints);
  const requests = await serveNativeReferences(page, references, 120);
  await openProject(page);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  const samples = await playThrough(page, 3200);
  assertNativeCorrespondence(samples, paints, references);
  const opening = paints.find((paint) => paint.atMs === 1800)!;
  const openingSrc = `data:image/png;base64,${references.get(`${RED}:1800`)!.png}`;
  const decoded = await page.evaluate(() => (window as unknown as { __continuousPreview: Probe }).__continuousPreview.decoded);
  expect(requests.some((request) => request.times.includes(1800) && request.ms < 1800), 'Next cue must be requested before it becomes current').toBe(true);
  expect(decoded.some((item) => item.src === openingSrc && item.ms < 1800), 'Next cue must finish decoding before its boundary').toBe(true);
  const boundary = samples.filter((sample) => sample.ms >= 1860 && sample.ms < 2120);
  expect(boundary.length).toBeGreaterThan(2);
  for (const sample of boundary) {
    expect(sample.key).toBe(opening.paintKey);
    expect(sample.mode).toBe('exact');
    expect(sample.src).toBe(openingSrc);
    expect(sample.preparing).toBe(false);
  }
  const beforeWarm = requests.length;
  await seek(page, 500);
  const warm = await playThrough(page, 3100);
  assertNativeCorrespondence(warm, paints, references);
  expect(requests.length, 'A warm pass inside the eight-paint cache should not render again').toBe(beforeWarm);
  expect(state.projects[0].captions).toEqual(saved);
  expect(state.requests.filter((request) => request.path.endsWith('/captions'))).toEqual([]);
});

test('dense words with slower native responses recover after pause and backward seek without stale word pixels', async ({ page }) => {
  await installProbe(page, 35);
  const state = await installFixture(page);
  const { project, paints } = configure(state, [cue('dense', Array.from({ length: 24 }, (_, index) => String.fromCharCode(97 + index)), 200, 100)]);
  const saved = structuredClone(project.captions);
  const references = await nativeReferences(project, paints);
  const requests = await serveNativeReferences(page, references, 150);
  await openProject(page);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  const samples = await playThrough(page, 2350);
  assertNativeCorrespondence(samples, paints, references);
  // The initial nine-state warm window cannot account for this late paint.
  // This is recovery evidence, not a claim of full coverage at this load.
  expect(samples.some((sample) => sample.ms >= 1700 && sample.ms < 2300 && sample.mode === 'exact'
    && paints.some((paint) => paint.atMs + 40 <= sample.ms && sample.ms < paint.endMs && paint.paintKey === sample.key
      && sample.src === `data:image/png;base64,${references.get(`${RED}:${paint.atMs}`)!.png}`)),
    'A slower-than-word current render must not trap playback in current-only chasing').toBe(true);
  // This overloaded profile does not promise uninterrupted readiness. It must
  // settle on the actual paused word, not keep an obsolete request current.
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  const pausedMs = await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime * 1000);
  const pausedPaint = paints.find((paint) => paint.atMs <= pausedMs && paint.endMs > pausedMs)!;
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-paint-key', pausedPaint.paintKey!);
  await expect(page.locator('.native-caption-image')).toHaveAttribute('src', `data:image/png;base64,${references.get(`${RED}:${pausedPaint.atMs}`)!.png}`);
  await seek(page, 725);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  await expect(page.locator('.native-caption-image')).toHaveAttribute('src', `data:image/png;base64,${references.get(`${RED}:700`)!.png}`);
  const resumed = await playThrough(page, 1225);
  assertNativeCorrespondence(resumed, paints, references);
  expect(requests.every((request) => request.times.length <= 4)).toBe(true);
  expect(state.projects[0].captions).toEqual(saved);
  expect(state.requests.filter((request) => request.path.endsWith('/captions'))).toEqual([]);
});

test('a delayed obsolete appearance cannot replace native pixels after a backward seek and edit', async ({ page }) => {
  await installProbe(page, 80);
  const state = await installFixture(page);
  const { project, paints } = configure(state, [cue('edit', ['one', 'two', 'three', 'four'], 200, 700)]);
  const saved = structuredClone(project.captions);
  const references = await nativeReferences(project, paints, [RED, BLUE]);
  await serveNativeReferences(page, references, 150);
  await openProject(page);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route('**/api/video-export/landscape/preview', async (route) => {
    if (route.request().postDataJSON().appearance.highlightColor === BLUE) {
      held = true;
      await gate;
    }
    await route.fallback().catch(() => {});
  });
  try {
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByLabel('Word highlight color').fill(BLUE);
    await expect.poll(() => held).toBe(true);
    await seek(page, 250);
    await page.getByLabel('Word highlight color').fill(RED);
    release();
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    await expect(page.locator('.native-caption-image')).toHaveAttribute('src', `data:image/png;base64,${references.get(`${RED}:200`)!.png}`);
    const samples = await playThrough(page, 1750);
    assertNativeCorrespondence(samples, paints, references);
    expect(state.projects[0].captions).toEqual(saved);
    expect(state.requests.filter((request) => request.path.endsWith('/captions'))).toEqual([]);
  } finally { release(); }
});

for (const change of ['same-index seek', 'rate change', 'deadline'] as const) {
  test(`held future native work yields to current paint after ${change}`, async ({ page }) => {
    await installProbe(page, 35);
    const state = await installFixture(page);
    const { project, paints } = configure(state, [cue('lifecycle', Array.from({ length: 32 }, (_, index) => String.fromCharCode(97 + index % 26)), 200, 100)]);
    const references = await nativeReferences(project, paints, [RED, BLUE]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let sawBlueCurrent = false;
    let held: { request: Request; atMs: number; started: number; before: number; after: number; actionDone: boolean } | undefined;
    let aborted = false;
    let abortedAt = 0;
    const afterHeld: RecordedRequest[] = [];
    page.on('requestfailed', (request) => { if (request === held?.request) { aborted = true; abortedAt = Date.now(); } });
    await serveNativeReferences(page, references, 180, async (request, route) => {
      if (held) { afterHeld.push(request); return 0; }
      if (request.color !== BLUE) return;
      const current = paints.find((paint) => paint.atMs <= request.ms && request.ms < paint.endMs);
      // New appearance means no warm blue cache. After a slow current response,
      // a singleton strictly ahead of the media clock is observable catch-up.
      if (sawBlueCurrent && request.times.length === 1 && request.times[0] > request.ms) {
        held = { request: route.request(), atMs: request.times[0], started: Date.now(), before: 0, after: 0, actionDone: false };
        const clock = await page.locator('video').evaluate((video: HTMLVideoElement, change) => {
          const before = video.currentTime * 1000;
          if (change === 'same-index seek') video.currentTime = (Math.floor(before / 100) * 100 + 50) / 1000;
          if (change === 'rate change') video.playbackRate = 0.25;
          return { before, after: video.currentTime * 1000 };
        }, change);
        held.before = clock.before; held.after = clock.after; held.actionDone = true;
        await gate;
        return 0;
      }
      if (request.times.length === 1 && request.times[0] === current?.atMs) sawBlueCurrent = true;
      return 180;
    });
    try {
      await openProject(page);
      await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
      await page.getByRole('button', { name: 'Appearance', exact: true }).click();
      await page.locator('video').evaluate(async (video: HTMLVideoElement) => { video.muted = true; await video.play(); });
      await page.getByLabel('Word highlight color').fill(BLUE);
      await expect.poll(() => held?.actionDone, { timeout: 8000 }).toBe(true);
      expect(held!.atMs).toBeGreaterThan(held!.before - 40);
      if (change !== 'deadline') expect(Math.floor(held!.after / 100)).toBe(Math.floor(held!.before / 100));
      // Event resets must abort promptly, rather than pass only because the
      // later speculative deadline eventually expires. The held target is
      // predicted >180 ms ahead; a 150 ms event budget precedes that deadline.
      await expect.poll(() => aborted, { timeout: change === 'deadline' ? 1800 : 150, intervals: [10, 20, 30] }).toBe(true);
      if (change !== 'deadline') expect(abortedAt - held!.started, 'Lifecycle reset must beat the future-paint deadline').toBeLessThan(150);
      expect(Date.now() - held!.started, 'Held speculative work must not survive indefinitely').toBeLessThan(1500);
      await expect.poll(() => afterHeld.some((request) => request.color === BLUE && request.times.length === 1
        && paints.some((paint) => paint.atMs <= request.ms && request.ms < paint.endMs && request.times[0] === paint.atMs))).toBe(true);
      // The held response is still unreleased: current-paint recovery cannot
      // accidentally depend on its completion or accept pending forever.
      await page.waitForFunction((paints) => {
        const ms = document.querySelector('video')!.currentTime * 1000;
        const paint = paints.find((item) => item.atMs <= ms && ms < item.endMs);
        const surface = document.querySelector('.native-caption-surface');
        return Boolean(paint && surface?.getAttribute('data-preview-mode') === 'exact'
          && surface.getAttribute('data-paint-key') === paint.paintKey);
      }, paints, { polling: 'raf', timeout: 3000 });
      await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause());
      release();
      await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
      const ms = await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime * 1000);
      const current = paints.find((paint) => paint.atMs <= ms && ms < paint.endMs)!;
      await expect(page.locator('.native-caption-image')).toHaveAttribute('src', `data:image/png;base64,${references.get(`${BLUE}:${current.atMs}`)!.png}`);
    } finally { release(); }
  });
}

test('changing review focus inside overlapping captions hides old native focus bounds while replacement is held', async ({ page }) => {
  const state = await installFixture(page);
  state.native = true;
  configure(state, [cue('focus-a', ['first'], 200, 2400), cue('focus-b', ['second'], 200, 2400)]);
  await openProject(page);
  await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  await page.locator('[data-caption-id="focus-a"] .row-index').click();
  await seek(page, 500);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  await expect(page.locator('.native-caption-focus')).toBeVisible();
  const before = await page.locator('.native-caption-focus').getAttribute('style');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route('**/api/video-export/landscape/preview', async (route) => {
    if (JSON.stringify(route.request().postDataJSON().focusIndices) === '[1]') { held = true; await gate; }
    await route.fallback().catch(() => {});
  });
  try {
    await page.locator('[data-caption-id="focus-b"] .row-index').click();
    await seek(page, 500);
    await expect.poll(() => held).toBe(true);
    await expect(page.locator('.native-caption-focus'), 'Old selection bounds must not be retained under the new selection').toHaveCount(0);
    const response = page.waitForResponse((response) => response.url().endsWith('/api/video-export/landscape/preview')
      && JSON.stringify(response.request().postDataJSON().focusIndices) === '[1]' && response.ok());
    release();
    const result = await (await response).json();
    const frame = result.frames[0];
    expect(frame.focusBounds).toBeTruthy();
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    await expect(page.locator('.native-caption-image')).toHaveAttribute('src', `data:image/png;base64,${frame.png}`);
    const focus = page.locator('.native-caption-focus');
    await expect(focus).toBeVisible();
    await expect(focus).not.toHaveAttribute('style', before!);
    const bounds = await focus.evaluate((element: HTMLElement) => ({ left: parseFloat(element.style.left), top: parseFloat(element.style.top), width: parseFloat(element.style.width), height: parseFloat(element.style.height) }));
    expect(bounds.left).toBeCloseTo(frame.focusBounds.x / result.width * 100, 3);
    expect(bounds.top).toBeCloseTo(frame.focusBounds.y / result.height * 100, 3);
    expect(bounds.width).toBeCloseTo(frame.focusBounds.width / result.width * 100, 3);
    expect(bounds.height).toBeCloseTo(frame.focusBounds.height / result.height * 100, 3);
  } finally { release(); }
});
