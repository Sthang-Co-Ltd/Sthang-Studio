import { test, expect, type Page, type Route, type Request } from '@playwright/test';
import { buildCaptionWordTiming, planCaptionRenderStates, type CaptionProject, type CaptionSegment, type CaptionRenderState, type TimedToken } from '../../packages/shared/src/index.js';
import { capabilities, cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';
import { nativePreviewCatchupTimeoutMs } from '../../apps/web/src/native-preview-scheduler.js';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
test.setTimeout(120_000);

type Sample = { ms: number; wall: number; presentedMs: number | null; key: string | null; mode: string | null; src: string | null; preparing: boolean; paused: boolean; seeking: boolean; rate: number };
type Playback = Pick<Sample, 'ms' | 'paused' | 'seeking' | 'rate'>;
type Decode = Playback & { wall: number; src: string };
type MediaReset = Playback & { type: string; wall: number; createdWall: number; trusted: boolean };
type Dispatch = { times: number[]; color: string; ms: number; wall: number; paused: boolean; seeking: boolean; rate: number; claimed: boolean;
  responseWall?: number; responseMs?: number; status?: number; abortWall?: number; signalAbortedAtDispatch?: boolean; abortPlayback?: Playback;
  initialCurrent?: { atMs: number; ms: number; wall: number; responseWall?: number; responseMs?: number; status?: number; abortWall?: number; decodeWall?: number; decodeMs?: number; decodePlayback?: Playback; referenceDecoded: boolean };
  lifecycle?: { actionWall: number; liveAtAction: boolean; eventWall?: number; eventTrusted?: boolean; liveAtEvent?: boolean; abortedInEvent?: boolean;
    before: number; after: number; beforePlayback: Playback; afterPlayback: Playback; earliestDeadlineWall: number } };
type Probe = { samples: Sample[]; decoded: Decode[]; dispatches: Dispatch[]; collecting: boolean; mediaResets: MediaReset[] };
type RecordedRequest = { times: number[]; ms: number; wall: number; color: string };
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
async function installProbe(page: Page, decodeDelay: number, decodeGate?: { src: string; releaseAtMs: number }) {
  await page.addInitScript(({ decodeDelay, decodeGate }) => {
    const probe: Probe = { samples: [], decoded: [], dispatches: [], collecting: false, mediaResets: [] };
    (window as unknown as { __continuousPreview: Probe }).__continuousPreview = probe;
    const playback = (): Playback => {
      const video = document.querySelector('video');
      return { ms: (video?.currentTime ?? 0) * 1000, paused: video?.paused ?? true,
        seeking: video?.seeking ?? false, rate: video?.playbackRate ?? 1 };
    };
    // Keep actual media-reset evidence from the initial decode through the
    // action. Observers never change media state, event delivery or timers.
    for (const type of ['seeking', 'pause', 'ratechange', 'emptied']) document.addEventListener(type, (event) => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      probe.mediaResets.push({ ...playback(), type, wall: performance.now(), createdWall: event.timeStamp, trusted: event.isTrusted });
    }, true);
    const originalFetch = window.fetch;
    window.fetch = async function (input, init) {
      let dispatch: Dispatch | undefined;
      if (String(input).endsWith('/api/video-export/landscape/preview') && typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as { timesMs: number[]; appearance: { highlightColor: string } };
        const video = document.querySelector('video');
        dispatch = { times: body.timesMs, color: body.appearance.highlightColor,
          ms: (video?.currentTime ?? 0) * 1000, wall: performance.now(),
          paused: video?.paused ?? true, seeking: video?.seeking ?? false, rate: video?.playbackRate ?? 1, claimed: false,
          signalAbortedAtDispatch: init.signal?.aborted };
        probe.dispatches.push(dispatch);
        const observed = dispatch;
        init.signal?.addEventListener('abort', () => {
          observed.abortWall = performance.now(); observed.abortPlayback = playback();
        }, { once: true });
      }
      const response = await originalFetch.call(this, input, init);
      if (dispatch) {
        dispatch.responseWall = performance.now();
        dispatch.responseMs = (document.querySelector('video')?.currentTime ?? 0) * 1000;
        dispatch.status = response.status;
      }
      return response;
    };
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await decode.call(this);
      if (!this.src.startsWith('data:image/png;base64,')) return;
      await new Promise<void>((resolve) => setTimeout(resolve, decodeDelay));
      if (decodeGate && this.src === decodeGate.src) {
        // Only withhold completion of this authentic decode. The real player
        // keeps advancing; neither its clock nor the preview cache is changed.
        await new Promise<void>((resolve, reject) => {
          let frame = 0;
          const timeout = setTimeout(() => {
            cancelAnimationFrame(frame);
            reject(new Error('The playing media did not reach the controlled decode boundary.'));
          }, 5000);
          const release = () => {
            if ((document.querySelector('video')?.currentTime ?? 0) * 1000 >= decodeGate.releaseAtMs) {
              clearTimeout(timeout);
              resolve();
            } else frame = requestAnimationFrame(release);
          };
          release();
        });
      }
      probe.decoded.push({ ...playback(), wall: performance.now(), src: this.src });
    };
    let observedVideo: HTMLVideoElement | null = null;
    let presentedMs: number | null = null;
    function sample() {
      const video = document.querySelector('video');
      if (video && video !== observedVideo) {
        observedVideo = video;
        presentedMs = null;
        const captureFrame: VideoFrameRequestCallback = (_now, metadata) => {
          if (observedVideo !== video) return;
          presentedMs = metadata.mediaTime * 1000;
          video.requestVideoFrameCallback(captureFrame);
        };
        video.requestVideoFrameCallback(captureFrame);
      }
      if (probe.collecting && video) {
        const surface = document.querySelector('.native-caption-surface');
        probe.samples.push({ ms: video.currentTime * 1000, wall: performance.now(), presentedMs,
          key: surface?.getAttribute('data-paint-key') ?? null,
          mode: surface?.getAttribute('data-preview-mode') ?? null,
          src: surface?.querySelector('img')?.getAttribute('src') ?? null,
          preparing: Boolean(document.querySelector('.native-preview-status')),
          paused: video.paused, seeking: video.seeking, rate: video.playbackRate });
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }, { decodeDelay, decodeGate });
}

test.afterEach(async ({ page }, testInfo) => {
  // Keep clock-domain evidence on success and failure without retaining raw
  // response payloads or PNG data. PNG IDs are local to this diagnostic file.
  const diagnostics = await page.evaluate(() => {
    const probe = (window as unknown as { __continuousPreview?: Probe }).__continuousPreview;
    if (!probe) return null;
    const ids = new Map<string, number>();
    const pngId = (src: string | null) => {
      if (!src) return null;
      if (!ids.has(src)) ids.set(src, ids.size + 1);
      return ids.get(src)!;
    };
    return {
      mediaResets: probe.mediaResets,
      dispatches: probe.dispatches.map(({ claimed: _claimed, ...dispatch }) => dispatch),
      decoded: probe.decoded.map(({ src, ...decode }) => ({ ...decode, pngId: pngId(src) })),
      samples: probe.samples.map(({ src, ...sample }) => ({ ...sample, pngId: pngId(src) })),
    };
  }).catch(() => null);
  if (diagnostics) await testInfo.attach('native-preview-clock-diagnostics', {
    body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json',
  });
  // Keep the page and its dispatch journal alive until held route callbacks
  // finish. The context's owned-network guard remains installed throughout.
  await page.unrouteAll({ behavior: 'wait' });
});

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
    const admittedAt = performance.now();
    const responseDelay = sleep(delay);
    const body = route.request().postDataJSON();
    const times = body.timesMs as number[];
    const color = body.appearance.highlightColor as string;
    expect(body.resolution).toBe('source');
    expect(body.appearance.highlightMode).toBe('word');
    // The browser records this synchronously when fetch starts. Reading the
    // live clock through Playwright here can cross a 100 ms word boundary.
    // Only lifecycle tests need an immediate held-request decision. Ordinary
    // continuous playback does no browser round trip on its response path;
    // dispatch clocks are correlated after the playback pass instead.
    const clock = beforeReply ? await page.evaluate(({ times, color }) => {
      const probe = (window as unknown as { __continuousPreview: Probe }).__continuousPreview;
      const dispatch = probe.dispatches.find((item) => !item.claimed && item.color === color
        && JSON.stringify(item.times) === JSON.stringify(times));
      if (!dispatch) throw new Error('Preview request has no browser dispatch-clock observation.');
      dispatch.claimed = true;
      return { ms: dispatch.ms, wall: dispatch.wall };
    }, { times, color }) : { ms: Number.NaN, wall: Number.NaN };
    const recorded = { times, ...clock, color };
    requests.push(recorded);
    const frames = times.map((atMs) => references.get(`${color}:${atMs}`));
    expect(frames.every(Boolean), `Unplanned native reference: ${color} ${times}`).toBe(true);
    const overrideDelay = await beforeReply?.(recorded, route);
    // Every delay is a minimum from route admission, including overrides.
    // Awaiting the lifecycle callback above still preserves its explicit gate.
    if (overrideDelay === undefined || overrideDelay === delay) await responseDelay;
    else await sleep(Math.max(0, overrideDelay - (performance.now() - admittedAt)));
    // An intentionally superseded request may already have been aborted.
    await route.fulfill({ json: { width: 640, height: 360, frames } }).catch(() => {});
  });
  return requests;
}

async function collectDispatchClocks(page: Page, requests: RecordedRequest[]) {
  const dispatches = await page.evaluate(() => (window as unknown as { __continuousPreview: Probe }).__continuousPreview.dispatches);
  const consumed = new Set<number>();
  for (const request of requests) {
    const index = dispatches.findIndex((item, index) => !consumed.has(index) && item.color === request.color
      && JSON.stringify(item.times) === JSON.stringify(request.times));
    expect(index, 'Every routed request must match its synchronous browser dispatch in sequence').toBeGreaterThanOrEqual(0);
    consumed.add(index);
    request.ms = dispatches[index].ms;
    request.wall = dispatches[index].wall;
  }
}

async function playThrough(page: Page, endMs: number): Promise<Sample[]> {
  await page.evaluate(async () => {
    const probe = (window as unknown as { __continuousPreview: Probe }).__continuousPreview;
    probe.samples = []; probe.collecting = true;
    const video = document.querySelector('video')!;
    video.muted = true;
    await video.play();
  });
  // No seek or wait-for-future-paint between start and end. Pause in the same
  // browser callback that observes the endpoint; a later driver round trip
  // can otherwise leave playback beyond the caption whose paused paint is tested.
  await page.waitForFunction((end) => {
    const video = document.querySelector('video')!;
    if (!(video.currentTime * 1000 >= end)) return false;
    video.pause();
    (window as unknown as { __continuousPreview: Probe }).__continuousPreview.collecting = false;
    return true;
  }, endMs);
  return page.evaluate(() => {
    const probe = (window as unknown as { __continuousPreview: Probe }).__continuousPreview;
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
  await collectDispatchClocks(page, requests);
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
  // The cold pass may deliberately skip a paint while catching up. Establish
  // all eight authentic cached paints before measuring reuse; a first render
  // of a skipped paint is not a cache miss for an already prepared image.
  for (const paint of paints) {
    await seek(page, paint.atMs + 50);
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-paint-key', paint.paintKey!);
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    await expect(page.locator('.native-caption-image')).toHaveAttribute('src',
      'data:image/png;base64,' + references.get(RED + ':' + paint.atMs)!.png);
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

test('a late current decode still recovers ahead when playback has reached a cached exact word', async ({ page }) => {
  const state = await installFixture(page);
  const { project, paints } = configure(state, [cue('cached-recovery', Array.from({ length: 24 }, (_, index) => String.fromCharCode(97 + index)), 200, 100)]);
  const saved = structuredClone(project.captions);
  const references = await nativeReferences(project, paints);
  const src = (atMs: number) => `data:image/png;base64,${references.get(`${RED}:${atMs}`)!.png}`;
  await installProbe(page, 35, { src: src(1400), releaseAtMs: 1620 });
  let playing = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held: RecordedRequest[] = [];
  await serveNativeReferences(page, references, 0, async (request) => {
    if (playing) return 700;
    // Establish real cache entries only through visible paused paints. Hold
    // every speculative reply so no other future PNG can mask the regression.
    if (request.times.length === 1 && [500, 1300, 1600].includes(request.times[0])) return 0;
    held.push(request);
    await gate;
    return 0;
  });
  try {
    await openProject(page);
    await expect(page.locator('.native-caption-image')).toHaveAttribute('src', src(500));
    // Quarter speed widens the observation window while a 700 ms transport plus
    // real 35 ms decode still costs almost two 100 ms word intervals. This is a
    // controlled lifecycle case; the separate dense 1x playback test is intact.
    await page.locator('video').evaluate((video: HTMLVideoElement) => { video.playbackRate = 0.25; });
    await seek(page, 1625);
    await expect(page.locator('.native-caption-image')).toHaveAttribute('src', src(1600));
    await seek(page, 1390);
    await expect(page.locator('.native-caption-image')).toHaveAttribute('src', src(1300));
    await expect.poll(() => held.some((request) => request.times.length > 1 && request.times.includes(1400))).toBe(true);
    await page.waitForFunction(() => document.querySelector('video')?.seeking === false);
    const primed = await page.evaluate(() => {
      const probe = (window as unknown as { __continuousPreview: Probe }).__continuousPreview;
      return { decoded: probe.decoded, dispatches: probe.dispatches };
    });
    expect([...new Set(primed.decoded.map((item) => item.src))].sort(), 'Only the three explicitly displayed native paints may be warm')
      .toEqual([src(500), src(1300), src(1600)].sort());
    const heldPrefetch = primed.dispatches.filter((request) => request.times.length > 1 && request.times.includes(1400)).at(-1)!;
    expect(heldPrefetch).toBeDefined();
    expect(heldPrefetch.abortWall).toBeUndefined();
    playing = true;
    const samples = await playThrough(page, 2300);
    assertNativeCorrespondence(samples, paints, references);
    const measured = samples.filter((sample) => sample.ms >= 1400 && sample.ms < 2300);
    expect(measured.length).toBeGreaterThan(20);
    expect(measured.every((sample) => !sample.paused && !sample.seeking && sample.rate === 0.25),
      'The measured pass must remain real uninterrupted playback at its declared rate').toBe(true);
    const probe = await page.evaluate(() => {
      const probe = (window as unknown as { __continuousPreview: Probe }).__continuousPreview;
      return { decoded: probe.decoded, dispatches: probe.dispatches };
    });
    const current = probe.dispatches.find((request) => request.wall > heldPrefetch.wall
      && request.times.length === 1 && request.times[0] === 1400)!;
    expect(current, 'The held multi-paint prefetch must yield to a current-only render at the boundary').toBeDefined();
    expect(current.paused).toBe(false);
    expect(current.seeking).toBe(false);
    expect(current.rate).toBe(0.25);
    expect(current.ms).toBeGreaterThanOrEqual(1400);
    expect(current.ms).toBeLessThan(1500);
    expect(probe.dispatches.find((request) => request.wall === heldPrefetch.wall)?.abortWall).toBeLessThan(current.wall);
    const late = probe.decoded.find((item) => item.src === src(1400) && item.wall > current.wall)!;
    expect(late, 'The authentic 1400 PNG must actually finish decoding late').toBeDefined();
    expect(late.ms).toBeGreaterThanOrEqual(1600);
    expect(late.ms).toBeLessThan(1700);
    const beforeLate = samples.filter((sample) => sample.wall <= late.wall && sample.ms >= 1600).at(-1);
    expect(beforeLate?.src, 'The cached current PNG must already be visible before late completion').toBe(src(1600));
    expect(beforeLate?.mode).toBe('exact');
    const cached = samples.filter((sample) => sample.ms >= 1640 && sample.ms < 1700);
    expect(cached.length).toBeGreaterThan(2);
    expect(cached.every((sample) => sample.mode === 'exact' && sample.src === src(1600)),
      'The late-demand decision must occur while a real cached current paint stays visible').toBe(true);
    const recovery = probe.dispatches.find((request) => request.wall > late.wall)!;
    expect(recovery, 'Late demand must issue one useful recovery request even with cached current pixels').toBeDefined();
    expect(recovery.times).toHaveLength(1);
    const target = paints.find((paint) => paint.atMs === recovery.times[0])!;
    // Use observed clocks rather than insist on exactly 1900 under host jitter.
    // The old cached-current veto instead consumes demand and requests 1700.
    const predictedReadyMs = late.ms + (late.wall - current.wall + 25) * current.rate;
    expect(target.atMs).toBeGreaterThanOrEqual(predictedReadyMs);
    expect(target.atMs).toBeGreaterThan(1700);
    expect(target.atMs).toBeLessThanOrEqual(late.ms + 1000);
    expect(paints.indexOf(target) - paints.findIndex((paint) => paint.atMs === 1600)).toBeLessThan(9);
    const recovered = samples.filter((sample) => sample.ms >= target.atMs + 40 && sample.ms < target.endMs);
    expect(recovered.length).toBeGreaterThan(2);
    expect(recovered.every((sample) => sample.mode === 'exact' && sample.key === target.paintKey && sample.src === src(target.atMs)),
      'The selected recovery paint must display its own native pixels during its real interval').toBe(true);
    expect(state.projects[0].captions).toEqual(saved);
    expect(state.requests.filter((request) => request.path.endsWith('/captions'))).toEqual([]);
  } finally { release(); }
});

test('cached exact word paints follow the live media clock even when video-frame metadata lags', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      return original.call(this, (now, metadata) => callback(now, {
        ...metadata, mediaTime: Math.max(0, metadata.mediaTime - 0.24),
      }));
    };
  });
  await installProbe(page, 10);
  const state = await installFixture(page);
  const { project, paints } = configure(state, [cue('clock', ['one', 'two', 'three', 'four'], 200, 600)]);
  const references = await nativeReferences(project, paints);
  await serveNativeReferences(page, references, 80);
  await openProject(page);
  // Warm this bounded four-word example before playback to isolate clock
  // invalidation from response latency. Never wait between playback boundaries.
  await expect.poll(() => page.evaluate(() => new Set((window as unknown as { __continuousPreview: Probe })
    .__continuousPreview.decoded.map((item) => item.src)).size)).toBe(paints.length);
  const samples = await playThrough(page, 2500);
  assertNativeCorrespondence(samples, paints, references);
  expect(new Set(samples.filter((sample) => sample.mode === 'exact').map((sample) => sample.key)).size).toBe(4);
  for (const sample of samples) {
    const current = paints.find((paint) => paint.atMs + 40 <= sample.ms && sample.ms < paint.endMs);
    if (!current) continue;
    expect(sample.mode, `Cached current paint must stay available at ${sample.ms}`).toBe('exact');
    expect(sample.key).toBe(current.paintKey);
  }
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
    let initialBlue: RecordedRequest | undefined;
    let held: { request: Request; atMs: number; wall: number; started: number; before: number; after: number; actionDone: boolean } | undefined;
    let aborted = false;
    const afterHeld: RecordedRequest[] = [];
    page.on('requestfailed', (request) => { if (request === held?.request) aborted = true; });
    await serveNativeReferences(page, references, 180, async (request, route) => {
      if (held) { afterHeld.push(request); return 0; }
      if (request.color !== BLUE) return;
      const current = paints.find((paint) => paint.atMs <= request.ms && request.ms < paint.endMs);
      if (!initialBlue) {
        // A cold appearance starts with current work. Its fetch timer may run
        // after the short paint ends; that does not make it speculative work.
        const target = paints.find((paint) => paint.atMs === request.times[0]);
        expect(request.times, 'The cold blue appearance must begin with one current paint').toHaveLength(1);
        expect(current, 'The blue appearance begins inside the continuous caption').toBeDefined();
        expect(target, 'The initial blue request must identify an authentic reference paint').toBeDefined();
        expect(target!.key, 'The initial current work belongs to the playing caption').toBe(current!.key);
        expect(target!.atMs, 'Future work cannot establish the initial current request').toBeLessThanOrEqual(request.ms);
        initialBlue = request;
        return 180;
      }
      // Hold only a strictly future singleton after the cold current work.
      // Its successful native decode is checked below before the reset runs.
      if (request.times.length === 1 && request.times[0] > request.ms) {
        held = { request: route.request(), atMs: request.times[0], wall: request.wall, started: Date.now(), before: 0, after: 0, actionDone: false };
        const target = paints.find((paint) => paint.atMs === request.times[0])!;
        // The fixture starts at 1x; the browser checks this remains unchanged
        // from the exact current decode through the requested lifecycle action.
        const deadlineMs = nativePreviewCatchupTimeoutMs(target.endMs, request.ms, 1);
        const clock = await page.evaluate(({ change, wall, initial, initialSrc, deadlineMs }) => {
          const video = document.querySelector('video');
          if (!video) throw new Error('The lifecycle reset requires the playing video.');
          const probe = (window as unknown as { __continuousPreview: Probe }).__continuousPreview;
          const dispatch = probe.dispatches.find((item) => item.wall === wall);
          if (!dispatch || dispatch.abortWall !== undefined) throw new Error('The held native request must still be live before the lifecycle reset.');
          const first = probe.dispatches.find((item) => item.wall === initial.wall);
          const decoded = probe.decoded.find((item) => item.src === initialSrc
            && first?.responseWall !== undefined && item.wall >= first.responseWall && item.wall < dispatch.wall);
          dispatch.initialCurrent = { atMs: initial.times[0], ms: initial.ms, wall: initial.wall,
            responseWall: first?.responseWall, responseMs: first?.responseMs, status: first?.status, abortWall: first?.abortWall,
            decodeWall: decoded?.wall, decodeMs: decoded?.ms,
            decodePlayback: decoded && { ms: decoded.ms, paused: decoded.paused, seeking: decoded.seeking, rate: decoded.rate },
            referenceDecoded: Boolean(decoded) };
          if (!first || first.color !== initial.color || first.times.length !== 1 || first.times[0] !== initial.times[0]
            || first.status !== 200 || first.abortWall !== undefined || first.responseWall === undefined
            || first.responseWall < first.wall || !decoded) {
            throw new Error('The initial cold blue current paint must successfully decode before future work begins.');
          }
          const playback = (): Playback => ({ ms: video.currentTime * 1000, paused: video.paused, seeking: video.seeking, rate: video.playbackRate });
          // Future work can only schedule after the current PNG has decoded.
          // Forward playback makes timeout(dispatch.media) no larger than the
          // timeout computed at scheduling. This is an EARLIEST deadline, not
          // an estimate of the later timer's actual firing time.
          const lifecycle = { earliestDeadlineWall: decoded.wall + deadlineMs } as NonNullable<Dispatch['lifecycle']>;
          dispatch.lifecycle = lifecycle;
          if (change !== 'deadline') {
            const event = change === 'same-index seek' ? 'seeking' : 'ratechange';
            video.addEventListener(event, (value) => {
              lifecycle.eventWall = performance.now(); lifecycle.eventTrusted = value.isTrusted;
              lifecycle.liveAtEvent = dispatch.abortWall === undefined;
            }, { once: true, capture: true });
            video.addEventListener(event, () => {
              lifecycle.abortedInEvent = dispatch.abortWall !== undefined;
            }, { once: true });
          }
          lifecycle.beforePlayback = playback();
          lifecycle.before = lifecycle.beforePlayback.ms;
          lifecycle.liveAtAction = dispatch.signalAbortedAtDispatch === false
            && dispatch.abortWall === undefined && dispatch.responseWall === undefined;
          if (!lifecycle.liveAtAction) throw new Error('The exact held signal must be live and unanswered at the setter.');
          lifecycle.actionWall = performance.now();
          if (change === 'same-index seek') video.currentTime = (Math.floor(lifecycle.before / 100) * 100 + 50) / 1000;
          if (change === 'rate change') video.playbackRate = 0.25;
          lifecycle.afterPlayback = playback();
          lifecycle.after = lifecycle.afterPlayback.ms;
          return { before: lifecycle.before, after: lifecycle.after };
        }, { change, wall: request.wall, initial: initialBlue, deadlineMs,
          initialSrc: `data:image/png;base64,${references.get(`${BLUE}:${initialBlue.times[0]}`)!.png}` });
        held.before = clock.before; held.after = clock.after; held.actionDone = true;
        await gate;
        return 0;
      }
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
      // Measure the actual action, media event and abort in the browser's clock.
      // The Node route callback and locator lookup can consume this entire
      // budget before the reset happens. A queued effect may observe the new
      // rate/seeking state before its native event is delivered; that earlier
      // cancellation is valid only with independent evidence excluding the
      // deadline. The response stays held throughout the same 150 ms budget.
      await expect.poll(() => aborted, { timeout: change === 'deadline' ? 1800 : 150, intervals: [10, 20, 30] }).toBe(true);
      if (change !== 'deadline') {
        const reset = await page.evaluate((wall) => {
          const probe = (window as unknown as { __continuousPreview: Probe }).__continuousPreview;
          const dispatch = probe.dispatches.find((item) => item.wall === wall);
          return { ...dispatch?.lifecycle, abortWall: dispatch?.abortWall, abortPlayback: dispatch?.abortPlayback,
            responseWall: dispatch?.responseWall, initialCurrent: dispatch?.initialCurrent, mediaResets: probe.mediaResets,
            dispatchPlayback: dispatch && { ms: dispatch.ms, paused: dispatch.paused, seeking: dispatch.seeking, rate: dispatch.rate } };
        }, held!.wall);
        const expectedEvent = change === 'same-index seek' ? 'seeking' : 'ratechange';
        const decoded = reset.initialCurrent!;
        expect(reset.liveAtAction, 'The exact held request must still be live at the actual setter').toBe(true);
        expect(reset.responseWall, 'The held response must remain unanswered').toBeUndefined();
        for (const playback of [decoded.decodePlayback, reset.dispatchPlayback, reset.beforePlayback]) {
          expect(playback, 'The pre-action interval must be forward playback at the original rate').toMatchObject({ paused: false, seeking: false, rate: 1 });
        }
        expect(decoded.decodeMs).toBeLessThanOrEqual(reset.dispatchPlayback!.ms);
        expect(reset.dispatchPlayback!.ms).toBeLessThanOrEqual(reset.before!);
        expect(reset.mediaResets.filter((event) => (event.wall >= decoded.decodeWall! && event.wall < reset.actionWall!)
          || (event.createdWall >= decoded.decodeWall! && event.createdWall < reset.actionWall!)),
        'No media reset may invalidate the uninterrupted pre-action deadline bound').toEqual([]);
        expect(reset.eventTrusted, 'The requested lifecycle event must be generated by the real media element').toBe(true);
        expect(reset.eventWall, 'The requested media lifecycle event must occur').toBeGreaterThanOrEqual(reset.actionWall!);
        expect(reset.abortedInEvent, 'A request still live at event entry must abort before event dispatch completes').toBe(true);
        expect(reset.abortWall, 'The same held signal must abort after the requested action').toBeGreaterThanOrEqual(reset.actionWall!);
        expect(reset.abortWall! - reset.actionWall!, 'Lifecycle reset must beat the future-paint deadline').toBeLessThan(150);
        expect(reset.afterPlayback).toMatchObject({ paused: false, rate: change === 'rate change' ? 0.25 : 1 });
        expect(reset.abortPlayback).toMatchObject({ paused: false, rate: change === 'rate change' ? 0.25 : 1 });
        expect(reset.mediaResets.filter((event) => event.wall >= reset.actionWall! && event.wall <= reset.abortWall!
          && (event.type !== expectedEvent || event.createdWall < reset.actionWall!)),
        'An unrelated lifecycle reset must not stand in for the requested action').toEqual([]);
        if (reset.liveAtEvent) {
          // Timer tasks cannot interleave inside this native event dispatch.
          expect(reset.abortWall).toBeGreaterThanOrEqual(reset.eventWall!);
        } else {
          expect(reset.abortWall).toBeLessThan(reset.eventWall!);
          expect(reset.abortWall, 'Early state invalidation needs evidence that even the earliest deadline was still in the future')
            .toBeLessThan(reset.earliestDeadlineWall!);
          expect(reset.abortPlayback).toMatchObject(change === 'same-index seek'
            ? { seeking: true, rate: 1 } : { seeking: false, rate: 0.25 });
        }
      }
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
  // Review intentionally filters out captions without a review issue. Keep
  // exact word timing while making both overlapping cues eligible for review.
  configure(state, [cue('focus-a', ['first'], 200, 2400), cue('focus-b', ['second'], 200, 2400)]
    .map((caption) => ({ ...caption, timingQuality: 'low' as const })));
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
